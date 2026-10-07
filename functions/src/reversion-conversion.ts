// ═════════════════════════════════════════════════
// revertirConversionEnDeuda — FIN-4B: reversión AUTORITATIVA, SEGURA e IDEMPOTENTE de una conversión a deuda
// ═════════════════════════════════════════════════
//
// Antes de FIN-4B revertir era un writer de cliente (lib/financial-writes.ts) con DOS commits:
//   1. batch: saldo → 'anulado', depósito → en_revision / anulado, órdenes
//   2. batch: anular el movimiento deposito_convertido_en_deuda
// Si el segundo fallaba quedaba un saldo anulado, un depósito en revisión y el movimiento de la deuda
// ACTIVO: ledger vivo sin saldo. No miraba el estado del saldo: revertía una deuda con abonos y dejaba
// sus movimientos de abono activos contra un saldo anulado. Y sin boucher intentaba anular el depósito,
// cosa que las Rules prohíben desde FIN-4A.
//
// Esta Function lo hace en UNA transacción y solo sobre una deuda VIRGEN:
//
//   · La identidad de la reversión es el CICLO (`saldoId`), no el depósito. Un reintento tardío del
//     ciclo viejo no puede tocar una conversión posterior: se reconoce por la marca del saldo.
//   · Deuda virgen = saldo pendiente, sin abonos, sin cambio de monto, con UN movimiento de conversión
//     activo coherente y NINGÚN otro movimiento activo del saldo. Cualquier efecto económico (abono
//     parcial, pagado, condonado) BLOQUEA: anular el registro contable no demuestra que el dinero se
//     devolvió, y volver a confirmar el depósito lo contaría dos veces.
//   · FIN-4B NO revierte abonos ni condonaciones. Eso sería una reversión económica distinta.
//   · Con boucher el depósito vuelve a 'en_revision' (como Rehacer); sin boucher, a 'pendiente_boucher'
//     (el estado desde el que se materializó). Nunca 'anulado'. Los gastos (FIN-2) siguen reservados por
//     el depósito, que sigue vivo: este bloque no los toca.
//   · La evidencia queda en el saldo anulado (con su marca), el movimiento anulado y el evento
//     DEPOSITO_CONVERSION_REVERTIDA, que guarda la conversión previa. Del depósito se retiran los campos
//     que decían "convertido ahora": saldoId, notaConversion, convertidoPorUid, convertidoAt.
//
// El cliente solo manda `saldoId` y `motivo`. Actor y rol salen de request.auth y de usuarios/{uid};
// depósito, órdenes, movimientos, montos y estados se RELEEN y se DEMUESTRAN dentro de la transacción.

import { HttpsError } from 'firebase-functions/v2/https';
import type { DocumentData } from 'firebase-admin/firestore';
import { cuentas } from './financial-types';
import { TIPO_DEPOSITO_STORKHUB, esNumeroFinito } from './deposito-monto';
import { ESTADO_CONVERTIDO, TIPO_MOVIMIENTO_CONVERSION, TIPO_SALDO_CONVERSION } from './conversion-deposito-deuda';

export const EVENTO_CONVERSION_REVERTIDA = 'DEPOSITO_CONVERSION_REVERTIDA';
export const ESTADO_DESTINO_CON_BOUCHER = 'en_revision';
export const ESTADO_DESTINO_SIN_BOUCHER = 'pendiente_boucher';
export const MOTIVO_REVERSION_MIN = 3;
export const MOTIVO_REVERSION_MAX = 300;
const MAX_ID = 200;
const TIPO_MOVIMIENTO_ABONO = 'abono_deuda_motorizado';
const TIPO_MOVIMIENTO_CONDONACION = 'deuda_condonada';

export type MotivoReversion =
  | 'deuda_con_abonos'
  | 'deuda_pagada'
  | 'deuda_condonada'
  | 'saldo_no_revertible'
  | 'movimientos_activos'
  | 'conversion_inconsistente';

export function rechazoReversion(motivo: MotivoReversion, mensaje: string, extra: Record<string, unknown> = {}): HttpsError {
  return new HttpsError('failed-precondition', mensaje, { motivo, ...extra });
}

export type ResultadoReversion = {
  ok: true;
  /** 'revertida': se cerró el ciclo. 'ya_revertida': el ciclo ya estaba revertido por FIN-4B; no se escribió nada. */
  resultado: 'revertida' | 'ya_revertida';
  saldoId: string;
  depositoId: string;
  /** Estado del depósito: el destino si se revirtió ahora; el actual si ya estaba revertida. */
  estadoDeposito: string;
  movimientoId: string;
  eventoId: string | null;
};

export interface TxReversion {
  getUsuario(uid: string): Promise<DocumentData | null>;
  getSaldo(id: string): Promise<DocumentData | null>;
  getDeposito(id: string): Promise<DocumentData | null>;
  getSolicitud(id: string): Promise<DocumentData | null>;
  /** TODOS los movimientos del ledger con saldoId == id (activos y anulados). */
  getMovimientosDeSaldo(saldoId: string): Promise<Array<{ id: string; data: DocumentData }>>;
  updateSaldo(id: string, campos: DocumentData): void;
  updateMovimiento(id: string, campos: DocumentData): void;
  updateDeposito(id: string, campos: DocumentData): void;
  updateSolicitud(id: string, campos: DocumentData): void;
  crearEvento(depositoId: string, eventoId: string, campos: DocumentData): void;
}

export interface DepsReversion {
  transaction<T>(fn: (tx: TxReversion) => Promise<T>): Promise<T>;
  serverTimestamp(): unknown;
  /** FieldValue.delete(): quita un campo. */
  eliminar(): unknown;
  /** Id NUEVO para el evento. Se pide una sola vez por llamada (los reintentos de la transacción lo reutilizan). */
  nuevoEventoId(): string;
}

function idValido(v: unknown): v is string {
  return typeof v === 'string' && v.trim().length > 0 && v.length <= MAX_ID;
}

/** Solo `saldoId` y `motivo`: ni depósito, ni estado, ni monto, ni actor, ni órdenes, ni gastos. */
export function validarPeticionReversion(data: unknown): { saldoId: string; motivo: string } {
  if (typeof data !== 'object' || data === null || Array.isArray(data)) {
    throw new HttpsError('invalid-argument', 'Petición inválida.');
  }
  const d = data as Record<string, unknown>;
  if (Object.keys(d).some((k) => k !== 'saldoId' && k !== 'motivo')) {
    throw new HttpsError('invalid-argument', 'Solo se aceptan los campos saldoId y motivo.');
  }
  if (!idValido(d.saldoId)) throw new HttpsError('invalid-argument', 'saldoId inválido.');
  const motivo = typeof d.motivo === 'string' ? d.motivo.trim() : '';
  if (motivo.length < MOTIVO_REVERSION_MIN || motivo.length > MOTIVO_REVERSION_MAX) {
    throw new HttpsError('invalid-argument', `El motivo es obligatorio: entre ${MOTIVO_REVERSION_MIN} y ${MOTIVO_REVERSION_MAX} caracteres.`);
  }
  return { saldoId: d.saldoId.trim(), motivo };
}

/** Mismo criterio que isAdminOrGestor() en firestore.rules: usuario ACTIVO con rol admin o gestor. */
function exigirGestorOAdmin(usuario: DocumentData | null): 'admin' | 'gestor' {
  const rol = usuario?.rol;
  if (!usuario || usuario.activo !== true || (rol !== 'admin' && rol !== 'gestor')) {
    throw new HttpsError('permission-denied', 'Solo un gestor o admin activo puede revertir una conversión en deuda.');
  }
  return rol;
}

const estaVivo = (data: DocumentData): boolean => data.estado !== 'anulado';

function tieneBoucher(dep: DocumentData): boolean {
  const b = dep.boucher as { url?: unknown; pathStorage?: unknown } | null | undefined;
  return !!(b && (b.url || b.pathStorage));
}

export async function revertirConversionEnDeudaCore(
  deps: DepsReversion,
  uid: string | undefined,
  data: unknown,
): Promise<ResultadoReversion> {
  if (!uid) throw new HttpsError('unauthenticated', 'Debés iniciar sesión.');
  const { saldoId, motivo } = validarPeticionReversion(data);
  // Identidad del evento: fija para esta llamada, aunque Firestore reintente la transacción.
  const eventoIdNuevo = deps.nuevoEventoId();

  return deps.transaction(async (tx) => {
    // ── LECTURAS (todas antes de cualquier escritura) ─────────────────────────
    const rol = exigirGestorOAdmin(await tx.getUsuario(uid));

    const saldo = await tx.getSaldo(saldoId);
    if (!saldo) throw new HttpsError('not-found', 'El saldo no existe.');

    const inconsistente = (detalle: string) => rechazoReversion(
      'conversion_inconsistente',
      'No se puede verificar una reversión segura: el depósito, el saldo o su movimiento no son coherentes. No se corrige solo: hay que revisarlo.',
      { detalle },
    );

    const depositoId = saldo.depositoId;
    if (!idValido(depositoId)) throw inconsistente('saldo_sin_depositoId');
    const dep = await tx.getDeposito(depositoId);
    if (!dep) throw inconsistente('deposito_inexistente');
    const movimientos = await tx.getMovimientosDeSaldo(saldoId);

    const conversiones = movimientos.filter((m) => m.data.tipo === TIPO_MOVIMIENTO_CONVERSION);

    // ── Idempotencia: el ciclo ya fue revertido por FIN-4B ────────────────────
    if (saldo.estado === 'anulado') {
      const marcaValida = saldo.revertidoAt != null
        && idValido(saldo.revertidoPorUid)
        && typeof saldo.motivoReversion === 'string' && saldo.motivoReversion.length > 0;
      const cicloCerrado = conversiones.length === 1
        && conversiones[0].data.estado === 'anulado'
        && conversiones[0].data.depositoId === depositoId
        && movimientos.every((m) => !estaVivo(m.data))
        && dep.saldoId !== saldoId;
      if (!marcaValida || !cicloCerrado) {
        // Anulado SIN la marca de FIN-4B (p. ej. anularSaldoCargo) o con el ciclo incoherente: no se asume nada.
        throw inconsistente(!marcaValida ? 'saldo_anulado_sin_marca' : 'ciclo_revertido_incoherente');
      }
      return {
        ok: true as const,
        resultado: 'ya_revertida' as const,
        saldoId,
        depositoId,
        estadoDeposito: String(dep.estado ?? ''),
        movimientoId: conversiones[0].id,
        eventoId: null,
      };
    }

    // ── El ciclo tiene que estar convertido y apuntado por el depósito ────────
    if (dep.estado !== ESTADO_CONVERTIDO) throw inconsistente('deposito_no_convertido');
    if (dep.saldoId !== saldoId) throw inconsistente('saldoId_no_coincide');
    if (dep.tipo !== TIPO_DEPOSITO_STORKHUB) throw inconsistente('deposito_no_storkhub');

    // ── Efectos económicos: BLOQUEAN, sin escribir nada ───────────────────────
    if (saldo.estado === 'condonado' || saldo.condonadoAt != null || saldo.montoCondonado != null || saldo.movimientoCondonacionId != null) {
      throw rechazoReversion('deuda_condonada', 'Esta deuda fue condonada: no se revierte automáticamente.', { estadoSaldo: String(saldo.estado ?? '') });
    }
    if (saldo.estado === 'pagado') {
      throw rechazoReversion('deuda_pagada', 'Esta deuda ya fue pagada: no se revierte automáticamente.', { estadoSaldo: 'pagado' });
    }
    if (saldo.estado === 'abonado_parcial') {
      throw rechazoReversion('deuda_con_abonos', 'La deuda tiene abonos registrados y no puede revertirse automáticamente.', { estadoSaldo: 'abonado_parcial' });
    }
    if (saldo.estado !== 'pendiente') {
      throw rechazoReversion('saldo_no_revertible', `El saldo está en estado "${String(saldo.estado ?? 'desconocido')}" y no se puede revertir.`, { estadoSaldo: String(saldo.estado ?? '') });
    }
    // El historial económico manda: un abono bloquea aunque el pendiente haya vuelto al original.
    if (!Array.isArray(saldo.abonos)) throw inconsistente('abonos_invalido');
    if (saldo.abonos.length > 0) {
      throw rechazoReversion('deuda_con_abonos', 'La deuda tiene abonos registrados y no puede revertirse automáticamente.', { abonos: saldo.abonos.length });
    }

    // ── El saldo es el de una conversión ──────────────────────────────────────
    if (saldo.origen !== 'deposito' || saldo.tipo !== TIPO_SALDO_CONVERSION) throw inconsistente('saldo_ajeno');
    const motorizadoId = saldo.motorizadoId;
    if (!idValido(motorizadoId)) throw inconsistente('saldo_sin_motorizado');
    const montoOriginal = saldo.montoOriginal;
    if (!esNumeroFinito(montoOriginal) || !(montoOriginal > 0)) throw inconsistente('monto_original_invalido');
    if (!esNumeroFinito(saldo.saldoPendiente) || saldo.saldoPendiente !== montoOriginal) {
      throw rechazoReversion('deuda_con_abonos', 'El saldo pendiente no coincide con el monto original: la deuda tiene movimiento económico y no puede revertirse automáticamente.', { saldoPendiente: String(saldo.saldoPendiente ?? ''), montoOriginal });
    }

    // ── Ledger: UN movimiento de conversión activo y NINGÚN otro activo ───────
    const activos = movimientos.filter((m) => estaVivo(m.data));
    if (activos.some((m) => m.data.tipo === TIPO_MOVIMIENTO_ABONO)) {
      throw rechazoReversion('deuda_con_abonos', 'El saldo tiene movimientos de abono activos: no puede revertirse automáticamente.', {});
    }
    if (activos.some((m) => m.data.tipo === TIPO_MOVIMIENTO_CONDONACION)) {
      throw rechazoReversion('deuda_condonada', 'El saldo tiene una condonación activa: no se revierte automáticamente.', {});
    }
    const conversionesActivas = activos.filter((m) => m.data.tipo === TIPO_MOVIMIENTO_CONVERSION);
    if (conversionesActivas.length !== 1) throw inconsistente(conversionesActivas.length === 0 ? 'sin_movimiento_conversion' : 'movimientos_conversion_multiples');
    if (activos.length !== 1) {
      throw rechazoReversion('movimientos_activos', 'El saldo tiene otros movimientos activos además de la conversión: hay que revisarlo.', { activos: activos.length });
    }
    const conv = conversionesActivas[0];
    if (conv.data.saldoId !== saldoId || conv.data.depositoId !== depositoId) throw inconsistente('movimiento_de_otro_ciclo');
    if (conv.data.monto !== montoOriginal) throw inconsistente('monto_movimiento_distinto');
    if (conv.data.motorizadoId !== motorizadoId
      || conv.data.cuentaOrigen !== cuentas.efectivoEnPoder(motorizadoId)
      || conv.data.cuentaDestino !== cuentas.deudaMotorizado(motorizadoId)) {
      throw inconsistente('cuentas_movimiento_distintas');
    }
    // El total persistido del depósito es el que dio el monto de la conversión: no se inventa otra fórmula.
    if (!esNumeroFinito(dep.montoTotal) || dep.montoTotal !== montoOriginal) throw inconsistente('monto_deposito_distinto');

    // ── Órdenes: SOLO las de este depósito, y siguen vinculadas a él ──────────
    const solicitudIds = Array.isArray(dep.solicitudIds) ? [...new Set((dep.solicitudIds as unknown[]).filter(idValido))] : [];
    if (solicitudIds.length === 0) throw inconsistente('deposito_sin_ordenes');
    for (const sid of solicitudIds) {
      const o = await tx.getSolicitud(sid);
      const d = (o?.registro as { deposito?: Record<string, unknown> } | undefined)?.deposito;
      if (!o || !d || d.storkhubDepositoId !== depositoId || d.confirmadoStorkhub !== true) throw inconsistente('orden_no_vinculada');
    }

    // ── ESCRITURAS (todas dentro de esta transacción) ─────────────────────────
    const conBoucher = tieneBoucher(dep);
    const estadoDestino = conBoucher ? ESTADO_DESTINO_CON_BOUCHER : ESTADO_DESTINO_SIN_BOUCHER;
    const ahora = deps.serverTimestamp();
    const eliminar = deps.eliminar();
    const eventoId = eventoIdNuevo;

    tx.updateSaldo(saldoId, {
      estado: 'anulado',
      motivoAnulacion: 'conversion_revertida',
      revertidoAt: ahora,
      revertidoPorUid: uid,
      revertidoPorRol: rol,
      motivoReversion: motivo,
      updatedAt: ahora,
    });
    tx.updateMovimiento(conv.id, {
      estado: 'anulado',
      anuladoAt: ahora,
      anuladoPorUid: uid,
      anuladoPorRol: rol,
      motivoAnulacion: `Conversión en deuda revertida · ${motivo}`,
    });
    tx.updateDeposito(depositoId, {
      estado: estadoDestino,
      saldoId: eliminar,
      notaConversion: eliminar,
      convertidoPorUid: eliminar,
      convertidoAt: eliminar,
      ultimoEventoId: eventoId,
      updatedAt: ahora,
    });
    // Mismas claves y semántica que lib/deposito-transiciones.ts. Con boucher: como Rehacer (el puntero se
    // conserva, la confirmación se retira). Sin boucher: como antes de convertir (sin puntero ni confirmación).
    const K = {
      id: 'registro.deposito.storkhubDepositoId',
      confirmado: 'registro.deposito.confirmadoStorkhub',
      confirmadoAt: 'registro.deposito.confirmadoStorkhubAt',
    };
    const camposOrden = conBoucher
      ? { [K.id]: depositoId, [K.confirmado]: false, [K.confirmadoAt]: null }
      : { [K.id]: eliminar, [K.confirmado]: eliminar, [K.confirmadoAt]: eliminar };
    for (const sid of solicitudIds) tx.updateSolicitud(sid, camposOrden);

    const previa: Record<string, unknown> = {};
    if (dep.convertidoPorUid !== undefined) previa.convertidoPorUid = dep.convertidoPorUid;
    if (dep.convertidoAt !== undefined) previa.convertidoAt = dep.convertidoAt;
    if (dep.notaConversion !== undefined) previa.notaConversion = dep.notaConversion;
    tx.crearEvento(depositoId, eventoId, {
      tipo: EVENTO_CONVERSION_REVERTIDA,
      at: ahora,
      porUid: uid,
      porRol: rol,
      motivo,
      depositoId,
      saldoId,
      movimientoId: conv.id,
      monto: montoOriginal,
      estadoAnterior: ESTADO_CONVERTIDO,
      estadoDestino,
      conversionPrevia: previa,
    });

    return {
      ok: true as const,
      resultado: 'revertida' as const,
      saldoId,
      depositoId,
      estadoDeposito: estadoDestino,
      movimientoId: conv.id,
      eventoId,
    };
  });
}
