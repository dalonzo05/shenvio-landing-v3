// ═════════════════════════════════════════════════
// convertirDepositoEnDeuda — FIN-4A: conversión de depósito a deuda AUTORITATIVA e IDEMPOTENTE
// ═════════════════════════════════════════════════
//
// Antes de FIN-4A convertir un depósito en deuda era una secuencia de commits de
// cliente (lib/financial-writes.ts):
//
//   1. batch: depósito → 'convertido_en_deuda' + flags de las órdenes
//   2. addDoc: el saldo (id aleatorio)
//   3. updateDoc: depósito.saldoId
//   4. registrarMovimiento(): el ledger, con su PROPIO addDoc, que "nunca lanza"
//
// Si 2, 3 o 4 fallaban quedaba un depósito convertido sin saldo, un saldo sin
// backlink o una deuda sin ledger. No había guarda de estado ni identidad: dos
// pestañas, un doble clic o un reintento tras perder la respuesta creaban un
// SEGUNDO saldo y un SEGUNDO movimiento y pisaban depósito.saldoId. Y un depósito
// ya CONFIRMADO (con su movimiento conf_* activo) podía convertirse igual: doble
// efecto económico.
//
// Esta Function reemplaza esa secuencia por UNA transacción:
//
//   - La identidad sale de request.auth, y el rol de usuarios/{uid}.
//   - El cliente solo manda `depositoId` y la `nota` (el motivo, que es metadata:
//     no decide nada financiero). Monto, órdenes, gastos, motorizado, estado y
//     saldo se RELEEN y se DEMUESTRAN dentro de la transacción (deposito-monto.ts,
//     la misma demostración que FIN-3).
//   - Saldo, depósito, órdenes y movimiento del ledger se escriben juntos, o no
//     se escribe nada.
//
// ─── Identidad del ciclo (por qué NO `saldo_<depositoId>`) ───────────────────
//
// FIN-4B podrá devolver un depósito a un estado convertible y permitir una NUEVA
// conversión. Si el saldo se llamara `saldo_<depositoId>` para siempre, el segundo
// ciclo chocaría con el primero. Por eso la identidad es del CICLO:
//
//   saldoId       id NUEVO por ciclo, fijado UNA vez antes de la transacción (los
//                 reintentos internos de Firestore reutilizan el mismo)
//   movimientoId  `conv_<saldoId>`, determinista y creado con create(): un mismo
//                 ciclo no puede escribir dos movimientos
//
// La guarda de idempotencia NO es esa identidad sino el ESTADO releído dentro de
// la transacción (como en FIN-3):
//
//   convertible (pendiente_boucher | en_revision | devuelto) ⇒ abre un ciclo nuevo
//   convertido_en_deuda  ⇒ el ciclo ya cerró: si saldo, backlink y movimiento son
//                          COHERENTES responde 'ya_convertido' sin escribir nada
//                          (doble clic, otra pestaña, reintento tras timeout); si
//                          falta una pieza, es un error de integridad: no se finge
//                          éxito ni se repara en silencio
//   confirmado           ⇒ se RECHAZA. FIN-3 ya creó el movimiento conf_* activo:
//                          convertirlo sería contarlo dos veces
//   cualquier otro       ⇒ failed-precondition
//
// Antes de abrir un ciclo se exige que el depósito NO tenga movimientos activos ni
// un saldo previo vivo: un ciclo anterior debe estar CERRADO (saldo anulado,
// movimiento anulado) para que otro pueda abrirse.
//
// ─── Lo que NO cierra ────────────────────────────────────────────────────────
//
// FIN-4B (revertir), FIN-4C (abonos), condonación, liquidaciones, FIN-1 (las Rules
// siguen permitiendo al gestor escribir saldos, ledger y depósitos desde un
// cliente modificado) y el backfill de gastos de FIN-2.
//
// Tampoco escribe un evento en el depósito: la conversión nunca lo tuvo, las Rules
// no lo exigen y la idempotencia no lo necesita.

import { HttpsError } from 'firebase-functions/v2/https';
import type { DocumentData } from 'firebase-admin/firestore';
import { cuentas } from './financial-types';
import {
  TIPO_DEPOSITO_STORKHUB,
  demostrarDeposito,
  esNumeroFinito,
  rechazo,
  type LecturasDeposito,
} from './deposito-monto';

/** Estados desde los que un depósito se convierte: el motorizado no depositó y el gestor lo carga a su cuenta. */
export const ESTADOS_CONVERTIBLES: readonly string[] = ['pendiente_boucher', 'en_revision', 'devuelto'];
export const ESTADO_CONVERTIDO = 'convertido_en_deuda';
export const TIPO_MOVIMIENTO_CONVERSION = 'deposito_convertido_en_deuda';
export const TIPO_SALDO_CONVERSION = 'deposito_no_realizado';
const MAX_ID = 200;
export const MAX_NOTA_CONVERSION = 500;

export type ResultadoConversion = {
  ok: true;
  /** 'convertido': se abrió y cerró un ciclo. 'ya_convertido': ya estaba convertido y coherente; no se escribió nada. */
  resultado: 'convertido' | 'ya_convertido';
  depositoId: string;
  saldoId: string;
  movimientoId: string;
  montoTotal: number;
  estadoAnterior: string;
  estadoNuevo: string;
};

export interface TxConversion extends LecturasDeposito {
  getUsuario(uid: string): Promise<DocumentData | null>;
  getDeposito(id: string): Promise<DocumentData | null>;
  getSaldo(id: string): Promise<DocumentData | null>;
  /** TODOS los saldos con depositoId == id (vivos y anulados). */
  getSaldosDeDeposito(depositoId: string): Promise<Array<{ id: string; data: DocumentData }>>;
  /** TODOS los movimientos del ledger con depositoId == id (activos y anulados). */
  getMovimientosDeDeposito(depositoId: string): Promise<Array<{ id: string; data: DocumentData }>>;
  updateDeposito(id: string, campos: DocumentData): void;
  updateSolicitud(id: string, campos: DocumentData): void;
  crearSaldo(id: string, campos: DocumentData): void;
  crearMovimiento(id: string, campos: DocumentData): void;
}

export interface DepsConversion {
  transaction<T>(fn: (tx: TxConversion) => Promise<T>): Promise<T>;
  serverTimestamp(): unknown;
  /** Id NUEVO para el saldo del ciclo. Se pide una sola vez por llamada. */
  nuevoSaldoId(): string;
}

function idValido(v: unknown): v is string {
  return typeof v === 'string' && v.trim().length > 0 && v.length <= MAX_ID;
}

/** Solo `depositoId` y `nota`: ni monto, ni saldo, ni estado, ni actor, ni órdenes. */
export function validarPeticionConversion(data: unknown): { depositoId: string; nota: string } {
  if (typeof data !== 'object' || data === null || Array.isArray(data)) {
    throw new HttpsError('invalid-argument', 'Petición inválida.');
  }
  const d = data as Record<string, unknown>;
  const claves = Object.keys(d);
  if (claves.some((k) => k !== 'depositoId' && k !== 'nota')) {
    throw new HttpsError('invalid-argument', 'Solo se aceptan los campos depositoId y nota.');
  }
  if (!idValido(d.depositoId)) throw new HttpsError('invalid-argument', 'depositoId inválido.');
  if (typeof d.nota !== 'string' || d.nota.trim().length === 0 || d.nota.trim().length > MAX_NOTA_CONVERSION) {
    throw new HttpsError('invalid-argument', `La nota (motivo) es obligatoria y no puede superar ${MAX_NOTA_CONVERSION} caracteres.`);
  }
  return { depositoId: d.depositoId.trim(), nota: d.nota.trim() };
}

/** Mismo criterio que isAdminOrGestor() en firestore.rules: usuario ACTIVO con rol admin o gestor. */
function exigirGestorOAdmin(usuario: DocumentData | null): 'admin' | 'gestor' {
  const rol = usuario?.rol;
  if (!usuario || usuario.activo !== true || (rol !== 'admin' && rol !== 'gestor')) {
    throw new HttpsError('permission-denied', 'Solo un gestor o admin activo puede convertir un depósito en deuda.');
  }
  return rol;
}

function estaVivo(data: DocumentData): boolean {
  return data.estado !== 'anulado';
}

/**
 * Un depósito YA convertido solo responde 'ya_convertido' si su conversión está
 * entera: backlink, un único saldo vivo del depósito, y un único movimiento de
 * conversión activo que apunta a ESE saldo. Si falta o sobra una pieza, error.
 */
function demostrarConversionCoherente(
  dep: DocumentData,
  depositoId: string,
  saldos: Array<{ id: string; data: DocumentData }>,
  movimientos: Array<{ id: string; data: DocumentData }>,
): { saldoId: string; movimientoId: string; monto: number } {
  const falla = (detalle: string) => rechazo(
    'conversion_inconsistente',
    'El depósito figura convertido en deuda pero su saldo o su movimiento no son coherentes. No se corrige solo: hay que revisarlo.',
    { detalle },
  );
  const saldoId = typeof dep.saldoId === 'string' ? dep.saldoId : '';
  if (!saldoId) throw falla('sin_saldoId');
  const saldo = saldos.find((s) => s.id === saldoId);
  if (!saldo) throw falla('saldo_inexistente');
  if (!estaVivo(saldo.data)) throw falla('saldo_anulado');
  if (saldo.data.origen !== 'deposito' || saldo.data.tipo !== TIPO_SALDO_CONVERSION || saldo.data.depositoId !== depositoId) {
    throw falla('saldo_ajeno');
  }
  if (saldos.filter((s) => estaVivo(s.data)).length !== 1) throw falla('saldos_vivos_multiples');

  const conversiones = movimientos.filter((m) => m.data.tipo === TIPO_MOVIMIENTO_CONVERSION && estaVivo(m.data));
  if (conversiones.length !== 1) throw falla(conversiones.length === 0 ? 'sin_movimiento' : 'movimientos_multiples');
  if (conversiones[0].data.saldoId !== saldoId) throw falla('movimiento_de_otro_saldo');

  return {
    saldoId,
    movimientoId: conversiones[0].id,
    monto: esNumeroFinito(saldo.data.montoOriginal) ? saldo.data.montoOriginal : 0,
  };
}

export async function convertirDepositoEnDeudaCore(
  deps: DepsConversion,
  uid: string | undefined,
  data: unknown,
): Promise<ResultadoConversion> {
  if (!uid) throw new HttpsError('unauthenticated', 'Debés iniciar sesión.');
  const { depositoId, nota } = validarPeticionConversion(data);
  // Identidad del ciclo: fija para esta llamada, aunque Firestore reintente la transacción.
  const saldoIdNuevo = deps.nuevoSaldoId();

  return deps.transaction(async (tx) => {
    // ── LECTURAS (todas antes de cualquier escritura) ─────────────────────────
    exigirGestorOAdmin(await tx.getUsuario(uid));

    const dep = await tx.getDeposito(depositoId);
    if (!dep) throw new HttpsError('not-found', 'El depósito no existe.');

    // La pantalla solo ofrece "→ Deuda" en depósitos Storkhub. El comercio no se
    // convierte: su cuenta contable no está demostrada, así que se rechaza.
    if (dep.tipo !== TIPO_DEPOSITO_STORKHUB) {
      throw rechazo('tipo_no_convertible', 'Solo un depósito a Storkhub se convierte en deuda.');
    }
    const estadoAnterior = String(dep.estado ?? '');

    const movimientos = await tx.getMovimientosDeDeposito(depositoId);
    const saldos = await tx.getSaldosDeDeposito(depositoId);

    // Guarda de idempotencia: el estado releído DENTRO de la transacción.
    if (estadoAnterior === ESTADO_CONVERTIDO) {
      const c = demostrarConversionCoherente(dep, depositoId, saldos, movimientos);
      return {
        ok: true as const,
        resultado: 'ya_convertido' as const,
        depositoId,
        saldoId: c.saldoId,
        movimientoId: c.movimientoId,
        montoTotal: c.monto,
        estadoAnterior,
        estadoNuevo: ESTADO_CONVERTIDO,
      };
    }
    if (estadoAnterior === 'confirmado') {
      throw rechazo('confirmado_no_convertible', 'El depósito ya está confirmado: tiene su movimiento contable y no se convierte en deuda.', { estado: estadoAnterior });
    }
    if (!ESTADOS_CONVERTIBLES.includes(estadoAnterior)) {
      throw rechazo('estado_cambio', `El depósito está en estado "${estadoAnterior || 'desconocido'}" y no se puede convertir en deuda. Actualizá la pantalla.`, { estado: estadoAnterior });
    }
    // Un depósito convertible NO debería tener ledger activo ni un saldo previo vivo:
    // un ciclo anterior tiene que estar cerrado para que se abra otro.
    const activos = movimientos.filter((m) => estaVivo(m.data));
    if (activos.length > 0) {
      throw rechazo('ledger_inconsistente', 'El depósito tiene movimientos activos sin estar convertido. Hay que revisarlo antes de convertir.', { activos: activos.length });
    }
    const saldosVivos = saldos.filter((s) => estaVivo(s.data));
    const saldoPunteado = typeof dep.saldoId === 'string' && dep.saldoId ? await tx.getSaldo(dep.saldoId) : null;
    if (saldosVivos.length > 0 || (saldoPunteado && estaVivo(saldoPunteado))) {
      throw rechazo('saldo_previo_vivo', 'El depósito ya tiene un saldo a cargo vivo. Hay que revisarlo antes de convertir.', { saldos: saldosVivos.length });
    }

    // ── Órdenes, gastos (FIN-2) y monto: se DEMUESTRAN ────────────────────────
    const { solicitudIds, motorizadoUid, motDocId, montoTotal } = await demostrarDeposito(tx, dep, depositoId, 'conversion');
    if (!(montoTotal > 0)) {
      throw rechazo('monto_cero', 'El depósito no tiene monto a cargo (los gastos cubren todo): no hay deuda que crear.');
    }

    // ── ESCRITURAS (todas dentro de esta transacción) ─────────────────────────
    const ahora = deps.serverTimestamp();
    const saldoId = saldoIdNuevo;
    const movimientoId = `conv_${saldoId}`;
    const motorizadoNombre = dep.motorizadoNombre ?? '';

    tx.crearSaldo(saldoId, {
      motorizadoId: motDocId,
      motorizadoUid,
      motorizadoNombre,
      tipo: TIPO_SALDO_CONVERSION,
      montoOriginal: montoTotal,
      saldoPendiente: montoTotal,
      estado: 'pendiente',
      origen: 'deposito',
      depositoId,
      fecha: ahora,
      nota,
      creadoPorUid: uid,
      createdAt: ahora,
      abonos: [],
    });
    tx.updateDeposito(depositoId, {
      estado: ESTADO_CONVERTIDO,
      notaConversion: nota,
      saldoId,
      convertidoPorUid: uid,
      convertidoAt: ahora,
      updatedAt: ahora,
    });
    // Las órdenes salen de "pendientes": mismos campos que confirmar un depósito Storkhub.
    const flags = {
      'registro.deposito.confirmadoStorkhub': true,
      'registro.deposito.confirmadoStorkhubAt': ahora,
      'registro.deposito.storkhubDepositoId': depositoId,
    };
    for (const sid of solicitudIds) tx.updateSolicitud(sid, flags);

    tx.crearMovimiento(movimientoId, {
      tipo: TIPO_MOVIMIENTO_CONVERSION,
      monto: montoTotal,
      at: ahora,
      creadoPorUid: uid,
      creadoPorRol: 'gestor', // el tipo del ledger solo admite gestor|motorizado|sistema
      descripcion: `Depósito convertido en deuda · ${motorizadoNombre} · ${nota}`,
      estado: 'activo',
      motorizadoId: motDocId,
      depositoId,
      saldoId,
      cuentaOrigen: cuentas.efectivoEnPoder(motDocId),
      cuentaDestino: cuentas.deudaMotorizado(motDocId),
      propietario: 'storkhub',
    });

    return {
      ok: true as const,
      resultado: 'convertido' as const,
      depositoId,
      saldoId,
      movimientoId,
      montoTotal,
      estadoAnterior,
      estadoNuevo: ESTADO_CONVERTIDO,
    };
  });
}
