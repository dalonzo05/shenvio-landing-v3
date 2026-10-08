// ═════════════════════════════════════════════════
// crearLiquidacionMotorizado — FIN-1D: la liquidación semanal AUTORITATIVA e IDEMPOTENTE
// ═════════════════════════════════════════════════
//
// Antes: la pantalla de Liquidaciones calculaba TODO en el navegador (comisión, efectivo, faltante, gastos, adelantos, deudas, neto) y lo escribía
// con una transacción de cliente: monto, ids de órdenes/depósitos/gastos, estado y actor salían de la pantalla, y las Rules dejaban a cualquier
// gestor/admin crear o reescribir una liquidación con cualquier cifra. Además el saldo por faltante nacía en otro paso (marcarPagada), sin ledger.
//
// Ahora una sola transacción, con { motorizadoId, semanaKey, operacionId, saldos: [{ saldoId, tope? }] } como ÚNICA entrada y solo para admin o
// gestor activo. El servidor:
//   · solo liquida una semana YA TERMINADA en Managua (semana_no_cerrada);
//   · es único por motorizado+semana: id determinista `${motorizadoId}_${semanaKey}` Y consulta (legacy con id aleatorio):
//     1 existente → liquidacion_existente, más de 1 → conciliacion_requerida;
//   · LEE dentro de la transacción las órdenes entregadas de la semana, los depósitos (un depósito NO terminal de la semana bloquea todo:
//     deposito_pendiente_conciliacion), los gastos elegibles (sin consumo de depósito ni liquidación), los adelantos activos de la semana (por
//     semanaKey) y los saldos que el gestor eligió para descontar;
//   · calcula la fórmula (liquidacion-calculo.ts: el efectivo es el MISMO de los depósitos) y escribe, atómicamente: la liquidación (con los ids
//     exactos que capturó), el abono de cada saldo y su movimiento abono_deuda_motorizado, cada gasto marcado con `liquidacionId` (así un gasto lo
//     descuenta un depósito O una liquidación, nunca ambos), el saldo del neto negativo con su movimiento saldo_creado y el marcador de idempotencia.
//   · el neto POSITIVO no mueve dinero todavía: se paga en marcarLiquidacionPagada. El neto CERO no crea nada más.

import { HttpsError } from 'firebase-functions/v2/https';
import type { DocumentData } from 'firebase-admin/firestore';
import { rangoDeSemana, semanaKeyDeFecha } from './cobro-semanal';
import { cuentas } from './financial-types';
import {
  exigirStaffFinanzas, huellaPayload, montoValido, nombreMotorizado, objetoPlano, operacionIdValido, idValido, rechazoOp, semanaValida, soloClaves,
} from './finanzas-operativas-comun';
import { analizarSaldo } from './saldo-acciones-comun';
import {
  aCentavos, aMonto, adelantosDeSemana, baseComisionOrden, clasificarDepositos, COMISION_PCT, efectivoAStorkhubOrden, formulaLiquidacion,
  gastosCandidatos, ordenesElegibles, type DocConId,
} from './liquidacion-calculo';
import type { LecturasLiquidacion } from './adelantos';

export const MAX_SALDOS_POR_LIQUIDACION = 50;
export const MAX_GASTOS_POR_LIQUIDACION = 300;
const MAX_ESCRITURAS = 450;

export const TIPO_MOV_ABONO_DEUDA = 'abono_deuda_motorizado';
export const TIPO_MOV_SALDO_CREADO = 'saldo_creado';
/** Origen del saldo por neto negativo: no hay una cuenta canónica previa para "deuda nacida de una liquidación" (ver el reporte de FIN-1D). */
export const CUENTA_AJUSTE_LIQUIDACION = 'ajuste_liquidacion';

/** Un depósito vivo (no anulado ni rechazado) cuenta como dueño del gasto que lista. */
const depositoVivo = (d: DocumentData): boolean => d.estado !== 'anulado' && d.estado !== 'rechazado';

export const idLiquidacion = (motorizadoId: string, semanaKey: string): string => `${motorizadoId}_${semanaKey}`;
export const idOperacionCrearLiquidacion = (operacionId: string): string => `crear_${operacionId}`;
export const idAplicacionSaldo = (liquidacionId: string, saldoId: string): string => `${liquidacionId}_${saldoId}`;
export const idMovimientoAbono = (liquidacionId: string, saldoId: string): string => `abono_${liquidacionId}_${saldoId}`;
export const idSaldoDeLiquidacion = (liquidacionId: string): string => `saldo_${liquidacionId}`;
export const idMovimientoSaldoCreado = (liquidacionId: string): string => `saldo_creado_${liquidacionId}`;

export interface SeleccionSaldo { saldoId: string; tope: number | null }
export interface PeticionCrearLiquidacion { operacionId: string; motorizadoId: string; semanaKey: string; saldos: SeleccionSaldo[] }

/** SOLO { motorizadoId, semanaKey, operacionId, saldos?: [{ saldoId, tope? }] }. Ni montos, ni ids de órdenes/gastos/adelantos/depósitos, ni estado, ni actor. */
export function validarPeticionCrearLiquidacion(data: unknown): PeticionCrearLiquidacion {
  const d = objetoPlano(data);
  soloClaves(d, ['motorizadoId', 'semanaKey', 'operacionId', 'saldos']);
  const operacionId = operacionIdValido(d.operacionId);
  if (!idValido(d.motorizadoId)) throw new HttpsError('invalid-argument', 'motorizadoId inválido.');
  const semanaKey = semanaValida(d.semanaKey);
  let saldos: SeleccionSaldo[] = [];
  if (d.saldos !== undefined && d.saldos !== null) {
    if (!Array.isArray(d.saldos)) throw new HttpsError('invalid-argument', 'saldos debe ser una lista.');
    if (d.saldos.length > MAX_SALDOS_POR_LIQUIDACION) throw new HttpsError('invalid-argument', `Se admiten hasta ${MAX_SALDOS_POR_LIQUIDACION} saldos.`);
    const vistos = new Set<string>();
    saldos = d.saldos.map((s: unknown) => {
      const o = objetoPlano(s);
      soloClaves(o, ['saldoId', 'tope']);
      if (!idValido(o.saldoId)) throw new HttpsError('invalid-argument', 'saldoId inválido.');
      const saldoId = o.saldoId.trim();
      if (vistos.has(saldoId)) throw new HttpsError('invalid-argument', 'Un saldo no puede repetirse.');
      vistos.add(saldoId);
      const tope = o.tope === undefined || o.tope === null ? null : montoValido(o.tope);
      return { saldoId, tope };
    });
  }
  return { operacionId, motorizadoId: d.motorizadoId.trim(), semanaKey, saldos };
}

export type ResultadoCrearLiquidacion = {
  ok: true;
  resultado: 'creada' | 'ya_creada';
  operacionId: string;
  liquidacionId: string;
  netoAPagar: number;
  deudasAplicadas: number;
  saldoGeneradoId: string | null;
};

export interface TxCrearLiquidacion extends LecturasLiquidacion {
  getUsuario(uid: string): Promise<DocumentData | null>;
  getMotorizado(id: string): Promise<DocumentData | null>;
  getOperacion(id: string): Promise<DocumentData | null>;
  getOrdenesEntregadasDelMotorizado(motorizadoId: string): Promise<DocConId[]>;
  getDepositosDelMotorizado(motorizadoUid: string): Promise<DocConId[]>;
  getGastosAprobadosDelMotorizado(motorizadoId: string): Promise<DocConId[]>;
  getAdelantosDelMotorizado(motorizadoId: string): Promise<DocConId[]>;
  getDepositosConGasto(gastoId: string): Promise<DocConId[]>;
  getGasto(id: string): Promise<DocumentData | null>;
  getSaldo(id: string): Promise<DocumentData | null>;
  crearLiquidacion(id: string, campos: DocumentData): void;
  crearOperacion(id: string, campos: DocumentData): void;
  crearSaldo(id: string, campos: DocumentData): void;
  crearMovimiento(id: string, campos: DocumentData): void;
  updateSaldo(id: string, campos: DocumentData): void;
  marcarGastoLiquidado(id: string, liquidacionId: string): void;
}

export interface DepsCrearLiquidacion {
  transaction<T>(fn: (tx: TxCrearLiquidacion) => Promise<T>): Promise<T>;
  serverTimestamp(): unknown;
  aTimestamp(d: Date): unknown;
  arrayUnion(item: unknown): unknown;
  ahora(): Date;
}

export async function crearLiquidacionMotorizadoCore(deps: DepsCrearLiquidacion, uid: string | undefined, data: unknown): Promise<ResultadoCrearLiquidacion> {
  if (!uid) throw new HttpsError('unauthenticated', 'Debés iniciar sesión.');
  const p = validarPeticionCrearLiquidacion(data);
  const ahora = deps.ahora();

  // La semana: estricta (un W53 que no existe en ese año no vale) y YA TERMINADA en Managua. Va antes de leer nada.
  const { inicio, fin } = rangoDeSemana(p.semanaKey);
  if (semanaKeyDeFecha(inicio) !== p.semanaKey) throw new HttpsError('invalid-argument', 'La semana no es válida.');
  if (ahora.getTime() <= fin.getTime()) {
    throw rechazoOp('semana_no_cerrada', 'Esa semana todavía no terminó: solo se liquidan semanas cerradas.', { semanaKey: p.semanaKey });
  }
  const ini = inicio.getTime();
  const fn = fin.getTime();

  const seleccionOrdenada = [...p.saldos].sort((a, b) => a.saldoId.localeCompare(b.saldoId));
  const huella = huellaPayload({ motorizadoId: p.motorizadoId, semanaKey: p.semanaKey, saldos: seleccionOrdenada.map((s) => [s.saldoId, s.tope]) });
  const liquidacionId = idLiquidacion(p.motorizadoId, p.semanaKey);

  return deps.transaction(async (tx) => {
    // ── LECTURAS (todas antes de escribir) ────────────────────────────────────
    const rol = exigirStaffFinanzas(await tx.getUsuario(uid));

    const op = await tx.getOperacion(idOperacionCrearLiquidacion(p.operacionId));
    if (op) {
      if (op.huella !== huella) throw rechazoOp('operacion_inconsistente', 'Esa operación ya se usó con otros datos.');
      return {
        ok: true as const, resultado: 'ya_creada' as const, operacionId: p.operacionId, liquidacionId: String(op.liquidacionId),
        netoAPagar: Number(op.netoAPagar), deudasAplicadas: Number(op.deudasAplicadas ?? 0), saldoGeneradoId: typeof op.saldoGeneradoId === 'string' ? op.saldoGeneradoId : null,
      };
    }

    const moto = await tx.getMotorizado(p.motorizadoId);
    if (!moto) throw rechazoOp('motorizado_inexistente', 'El motorizado no existe.');
    const uidMoto = typeof moto.authUid === 'string' && moto.authUid ? moto.authUid : null;
    const usuarioMoto = uidMoto ? await tx.getUsuario(uidMoto) : null;
    if (!uidMoto || !usuarioMoto || usuarioMoto.rol !== 'motorizado') {
      throw rechazoOp('motorizado_invalido', 'El motorizado no tiene un acceso válido (usuario con rol motorizado).', { motorizadoId: p.motorizadoId });
    }

    // Unicidad por motorizado+semana: el id determinista y cualquier legacy con id aleatorio.
    const directa = await tx.getLiquidacion(liquidacionId);
    const delMotorizado = await tx.getLiquidacionesDelMotorizado(p.motorizadoId, uidMoto);
    const existentes = new Set(delMotorizado.filter((l) => l.data.semanaKey === p.semanaKey).map((l) => l.id));
    if (directa) existentes.add(liquidacionId);
    if (existentes.size > 1) {
      throw rechazoOp('conciliacion_requerida', 'Hay más de una liquidación de esa semana para este motorizado. Hay que conciliarlo: no se crea ni se modifica nada.', { cantidad: existentes.size });
    }
    if (existentes.size === 1) {
      throw rechazoOp('liquidacion_existente', 'Esa semana ya tiene una liquidación para este motorizado.', { liquidacionId: [...existentes][0] });
    }

    const ordenes = ordenesElegibles(await tx.getOrdenesEntregadasDelMotorizado(p.motorizadoId), p.motorizadoId, ini, fn);
    if (ordenes.length === 0) throw rechazoOp('sin_viajes', 'No hay viajes entregados en esa semana: no hay nada que liquidar.', { semanaKey: p.semanaKey });

    // Depósitos: uno NO terminal de la semana bloquea toda la liquidación (no se calcula un faltante que todavía puede cambiar).
    const { suman, pendientes } = clasificarDepositos(await tx.getDepositosDelMotorizado(uidMoto), ini, fn);
    if (pendientes.length > 0) {
      throw rechazoOp('deposito_pendiente_conciliacion', 'Hay un depósito de esa semana todavía sin resolver (pendiente de boucher, en revisión o devuelto): resolvelo antes de liquidar.', {
        depositosIds: pendientes.map((d) => d.id).slice(0, 10),
      });
    }

    // Gastos elegibles: sin marca de depósito ni de liquidación Y que ningún depósito vivo liste (depósitos anteriores a FIN-2 no tienen marca).
    const candidatos = gastosCandidatos(await tx.getGastosAprobadosDelMotorizado(p.motorizadoId), p.motorizadoId, ini, fn);
    const gastos: DocConId[] = [];
    for (const g of candidatos) {
      const enDepositos = await tx.getDepositosConGasto(g.id);
      if (enDepositos.some((d) => depositoVivo(d.data))) continue; // ya lo descontó un depósito: no se descuenta dos veces
      gastos.push(g);
    }
    if (gastos.length > MAX_GASTOS_POR_LIQUIDACION) {
      throw rechazoOp('demasiados_registros', `La semana tiene más de ${MAX_GASTOS_POR_LIQUIDACION} gastos para capturar.`, { cantidad: gastos.length });
    }

    // Gastos que los depósitos de la semana ya descontaron (su monto va neto de ellos): el guardado, o la suma de sus gastos si es anterior a FIN-2.
    let centavosGastosEnDepositos = 0;
    for (const d of suman) {
      if (typeof d.data.gastosDescontados === 'number') { centavosGastosEnDepositos += aCentavos(d.data.gastosDescontados); continue; }
      const ids: string[] = Array.isArray(d.data.gastosIds) ? (d.data.gastosIds as unknown[]).filter((x): x is string => typeof x === 'string') : [];
      for (const gid of ids) {
        const g = await tx.getGasto(gid);
        if (g && g.estado === 'aprobado') centavosGastosEnDepositos += aCentavos(g.monto);
      }
    }

    const adelantos = adelantosDeSemana(
      await tx.getAdelantosDelMotorizado(p.motorizadoId), p.motorizadoId, p.semanaKey, (ms) => semanaKeyDeFecha(new Date(ms)),
    );

    // Saldos elegidos: se RELEEN. Cualquier irregularidad aborta toda la liquidación (nada parcial).
    const aplicaciones: Array<{ saldoId: string; saldo: DocumentData; aplicado: number; nuevoPendiente: number; nuevoEstado: 'pagado' | 'abonado_parcial' }> = [];
    for (const sel of seleccionOrdenada) {
      const s = await tx.getSaldo(sel.saldoId);
      if (!s) throw rechazoOp('saldo_invalido', 'Uno de los saldos elegidos ya no existe.', { saldoId: sel.saldoId });
      if (s.motorizadoId !== p.motorizadoId || (typeof s.motorizadoUid === 'string' && s.motorizadoUid && s.motorizadoUid !== uidMoto)) {
        throw rechazoOp('saldo_invalido', 'Uno de los saldos elegidos no es de este motorizado.', { saldoId: sel.saldoId });
      }
      if (s.estado !== 'pendiente' && s.estado !== 'abonado_parcial') {
        throw rechazoOp('saldo_invalido', 'Uno de los saldos elegidos ya no está pendiente.', { saldoId: sel.saldoId, estado: String(s.estado ?? '') });
      }
      if (!analizarSaldo(s).ok) throw rechazoOp('saldo_invalido', 'Uno de los saldos elegidos no es coherente (monto original, abonos y pendiente no cuadran).', { saldoId: sel.saldoId });
      const pendiente = aCentavos(s.saldoPendiente);
      if (!(pendiente > 0)) throw rechazoOp('saldo_invalido', 'Uno de los saldos elegidos ya no tiene monto pendiente.', { saldoId: sel.saldoId });
      const aplicado = sel.tope === null ? pendiente : Math.min(pendiente, aCentavos(sel.tope));
      const nuevoPendiente = pendiente - aplicado;
      aplicaciones.push({ saldoId: sel.saldoId, saldo: s, aplicado, nuevoPendiente, nuevoEstado: nuevoPendiente <= 0 ? 'pagado' : 'abonado_parcial' });
    }

    // ── La fórmula (todo en centavos) ─────────────────────────────────────────
    const centavosBase = ordenes.reduce((s, o) => s + baseComisionOrden(o.data), 0);
    const centavosEfectivo = ordenes.reduce((s, o) => s + efectivoAStorkhubOrden(o.data), 0);
    const centavosGastosLiq = gastos.reduce((s, g) => s + aCentavos(g.data.monto), 0);
    const centavosDepositado = suman.reduce((s, d) => s + aCentavos(d.data.montoTotal), 0);
    const centavosAdelantos = adelantos.reduce((s, a) => s + aCentavos(a.data.monto), 0);
    const centavosDeudas = aplicaciones.reduce((s, a) => s + a.aplicado, 0);
    const r = formulaLiquidacion({
      baseComision: centavosBase, efectivoEsperado: centavosEfectivo, gastosLiquidacion: centavosGastosLiq, gastosEnDepositos: centavosGastosEnDepositos,
      depositado: centavosDepositado, adelantos: centavosAdelantos, deudasAplicadas: centavosDeudas,
    });
    const centavosTotalGenerado = ordenes.reduce((s, o) => s + aCentavos(o.data.confirmacion?.precioFinalCordobas), 0);
    const netoAPagar = aMonto(r.netoAPagar);
    const hayDeuda = r.netoAPagar < 0;

    const escrituras = 1 + 1 + 2 * aplicaciones.length + (hayDeuda ? 2 : 0) + gastos.length;
    if (escrituras > MAX_ESCRITURAS) throw rechazoOp('demasiados_registros', 'La liquidación excede el máximo de escrituras de una transacción.', { escrituras });

    // ── ESCRITURAS (una transacción: o todo o nada) ───────────────────────────
    const ts = deps.serverTimestamp();
    const nombre = nombreMotorizado(moto, p.motorizadoId);
    const saldoGeneradoId = hayDeuda ? idSaldoDeLiquidacion(liquidacionId) : null;

    for (const a of aplicaciones) {
      const aplicacionId = idAplicacionSaldo(liquidacionId, a.saldoId);
      const movId = idMovimientoAbono(liquidacionId, a.saldoId);
      tx.updateSaldo(a.saldoId, {
        saldoPendiente: aMonto(a.nuevoPendiente),
        estado: a.nuevoEstado,
        abonos: deps.arrayUnion({
          monto: aMonto(a.aplicado), fecha: deps.aTimestamp(ahora), metodoAbono: 'descuento_liquidacion', nota: `Descontado en liquidación ${p.semanaKey}`,
          creadoPorUid: uid, creadoPorRol: rol, liquidacionId, aplicacionId, operacionId: p.operacionId, movimientoId: movId,
        }),
        updatedAt: ts,
      });
      tx.crearMovimiento(movId, {
        tipo: TIPO_MOV_ABONO_DEUDA, monto: aMonto(a.aplicado), at: ts, creadoPorUid: uid, creadoPorRol: rol,
        descripcion: `Abono deuda (descuento_liquidacion) · ${nombre}`, estado: 'activo',
        cuentaOrigen: cuentas.deudaMotorizado(p.motorizadoId), cuentaDestino: cuentas.recuperacionDeuda,
        motorizadoId: p.motorizadoId, saldoId: a.saldoId, liquidacionId, metadata: { operacionId: p.operacionId, aplicacionId },
      });
    }

    for (const g of gastos) tx.marcarGastoLiquidado(g.id, liquidacionId);

    if (hayDeuda && saldoGeneradoId) {
      const monto = aMonto(-r.netoAPagar);
      tx.crearSaldo(saldoGeneradoId, {
        motorizadoId: p.motorizadoId, motorizadoUid: uidMoto, motorizadoNombre: nombre, tipo: 'deposito_no_realizado',
        montoOriginal: monto, saldoPendiente: monto, estado: 'pendiente', origen: 'liquidacion', liquidacionId,
        fecha: ts, nota: `Saldo pendiente liquidación ${p.semanaKey}`, creadoPorUid: uid, creadoPorRol: rol, createdAt: ts, abonos: [], operacionId: p.operacionId,
      });
      tx.crearMovimiento(idMovimientoSaldoCreado(liquidacionId), {
        tipo: TIPO_MOV_SALDO_CREADO, monto, at: ts, creadoPorUid: uid, creadoPorRol: rol,
        descripcion: `Saldo a cargo (liquidación ${p.semanaKey}) · ${nombre}`, estado: 'activo',
        cuentaOrigen: CUENTA_AJUSTE_LIQUIDACION, cuentaDestino: cuentas.deudaMotorizado(p.motorizadoId), propietario: `motorizado:${p.motorizadoId}`,
        motorizadoId: p.motorizadoId, saldoId: saldoGeneradoId, liquidacionId, semanaKey: p.semanaKey, metadata: { operacionId: p.operacionId },
      });
    }

    tx.crearLiquidacion(liquidacionId, {
      motorizadoId: p.motorizadoId, motorizadoUid: uidMoto, motorizadoNombre: nombre,
      semanaKey: p.semanaKey, semanaInicio: deps.aTimestamp(inicio), semanaFin: deps.aTimestamp(fin),
      totalViajes: ordenes.length, totalGenerado: aMonto(centavosTotalGenerado), comisionPct: COMISION_PCT, comision: aMonto(r.comision),
      efectivoEsperado: aMonto(r.efectivoEsperado), totalDepositado: aMonto(r.depositado), adelantos: aMonto(r.adelantos), adelantosIds: adelantos.map((a) => a.id),
      faltantesDeposito: aMonto(r.faltantesDeposito), otrosDescuentos: 0,
      deudasAplicadas: aMonto(r.deudasAplicadas), deudasAplicadasIds: aplicaciones.map((a) => a.saldoId),
      gastosAprobados: aMonto(centavosGastosLiq), gastosEnDepositos: aMonto(centavosGastosEnDepositos), gastosAsumidosStorkhub: aMonto(r.gastosAsumidosStorkhub),
      gastosIds: gastos.map((g) => g.id), netoAPagar, ordenesIds: ordenes.map((o) => o.id), depositosIds: suman.map((d) => d.id),
      ...(saldoGeneradoId ? { saldoGeneradoId } : {}),
      estado: 'pendiente', creadoAt: ts, creadoPor: uid, creadoPorUid: uid, creadoPorRol: rol, operacionId: p.operacionId,
    });
    tx.crearOperacion(idOperacionCrearLiquidacion(p.operacionId), {
      tipo: 'crear_liquidacion', huella, liquidacionId, netoAPagar, deudasAplicadas: aMonto(r.deudasAplicadas), ...(saldoGeneradoId ? { saldoGeneradoId } : {}),
      actorUid: uid, actorRol: rol, at: ts,
    });

    return {
      ok: true as const, resultado: 'creada' as const, operacionId: p.operacionId, liquidacionId, netoAPagar,
      deudasAplicadas: aMonto(r.deudasAplicadas), saldoGeneradoId,
    };
  });
}

