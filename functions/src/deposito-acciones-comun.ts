// FIN-1B — piezas comunes de rehacerDeposito y anularDeposito (autoritativas, server-side).
//
// Las dos callables las ejecuta un ADMIN activo y reciben SOLO { depositoId, motivo } (+ operacionId en Rehacer). El
// actor y el rol salen de request.auth y de usuarios/{uid}; el estado, el boucher, las órdenes, los gastos, el ledger
// y las liquidaciones se RELEEN y se DEMUESTRAN dentro de la transacción. Nada de lo que decide el dinero viene del
// cliente: ni el estado destino, ni los movimientos, ni las órdenes, ni los gastos.

import { HttpsError } from 'firebase-functions/v2/https';
import type { DocumentData } from 'firebase-admin/firestore';
import { cuentas } from './financial-types';
import {
  TIPO_DEPOSITO_COMERCIO, TIPO_DEPOSITO_STORKHUB, MAX_ORDENES_POR_DEPOSITO, esNumeroFinito, idsUnicos, mismoMonto,
} from './deposito-monto';

export const TIPO_DEPOSITO_PAGO_COBRO = 'pago_delivery_deposito';
export const MOTIVO_DEPOSITO_MIN = 3;
export const MOTIVO_DEPOSITO_MAX = 300;
const MAX_ID = 200;
const RE_OPERACION_ID = /^[A-Za-z0-9_-]{8,64}$/;

export const EVENTO_DEPOSITO_REHECHO = 'DEPOSITO_REHECHO';
export const EVENTO_DEPOSITO_ANULADO = 'DEPOSITO_ANULADO';
export const TIPO_MOVIMIENTO_DEPOSITO_STORKHUB = 'deposito_efectivo_storkhub';
export const TIPO_MOVIMIENTO_DEPOSITO_COMERCIO = 'deposito_efectivo_comercio';
const TIPO_MOVIMIENTO_CONVERSION = 'deposito_convertido_en_deuda';
const TIPO_MOVIMIENTO_LEGACY = 'deposito_confirmado';
export const CAMPO_GASTO_CONSUMIDO = 'consumidoEnDepositoId';

export type MotivoRechazoDeposito =
  | 'usar_reversion_conversion'
  | 'usar_revertir_cobro'
  | 'deposito_no_rehacible'
  | 'deposito_no_anulable'
  | 'ledger_inconsistente'
  | 'conciliacion_requerida'
  | 'deposito_ya_liquidado'
  | 'deposito_comercio_ya_liquidado'
  | 'operacion_inconsistente';

export function rechazoDeposito(motivo: MotivoRechazoDeposito, mensaje: string, extra: Record<string, unknown> = {}): HttpsError {
  return new HttpsError('failed-precondition', mensaje, { motivo, ...extra });
}

export function idValido(v: unknown): v is string {
  return typeof v === 'string' && v.trim().length > 0 && v.length <= MAX_ID;
}

function motivoValido(v: unknown): string {
  const m = typeof v === 'string' ? v.trim() : '';
  if (m.length < MOTIVO_DEPOSITO_MIN || m.length > MOTIVO_DEPOSITO_MAX) {
    throw new HttpsError('invalid-argument', `El motivo es obligatorio: entre ${MOTIVO_DEPOSITO_MIN} y ${MOTIVO_DEPOSITO_MAX} caracteres.`);
  }
  return m;
}

function objetoPlano(data: unknown): Record<string, unknown> {
  if (typeof data !== 'object' || data === null || Array.isArray(data)) throw new HttpsError('invalid-argument', 'Petición inválida.');
  return data as Record<string, unknown>;
}

/** Rehacer: SOLO { depositoId, motivo, operacionId }. */
export function validarPeticionRehacer(data: unknown): { depositoId: string; motivo: string; operacionId: string } {
  const d = objetoPlano(data);
  if (Object.keys(d).some((k) => k !== 'depositoId' && k !== 'motivo' && k !== 'operacionId')) {
    throw new HttpsError('invalid-argument', 'Solo se aceptan los campos depositoId, motivo y operacionId.');
  }
  if (!idValido(d.depositoId)) throw new HttpsError('invalid-argument', 'depositoId inválido.');
  if (typeof d.operacionId !== 'string' || !RE_OPERACION_ID.test(d.operacionId)) throw new HttpsError('invalid-argument', 'operacionId inválido.');
  return { depositoId: d.depositoId.trim(), motivo: motivoValido(d.motivo), operacionId: d.operacionId };
}

/** Anular: SOLO { depositoId, motivo }. */
export function validarPeticionAnular(data: unknown): { depositoId: string; motivo: string } {
  const d = objetoPlano(data);
  if (Object.keys(d).some((k) => k !== 'depositoId' && k !== 'motivo')) {
    throw new HttpsError('invalid-argument', 'Solo se aceptan los campos depositoId y motivo.');
  }
  if (!idValido(d.depositoId)) throw new HttpsError('invalid-argument', 'depositoId inválido.');
  return { depositoId: d.depositoId.trim(), motivo: motivoValido(d.motivo) };
}

/** Solo un admin ACTIVO: el gestor no rehace ni anula (misma regla que la UI y que firestore.rules). */
export function exigirAdmin(usuario: DocumentData | null): 'admin' {
  if (!usuario || usuario.activo !== true || usuario.rol !== 'admin') {
    throw new HttpsError('permission-denied', 'Solo un administrador activo puede rehacer o anular un depósito.');
  }
  return 'admin';
}

export const estaVivo = (data: DocumentData): boolean => data.estado !== 'anulado';

export function tieneBoucher(dep: DocumentData): boolean {
  const b = dep.boucher as { url?: unknown; pathStorage?: unknown } | null | undefined;
  return !!(b && (b.url || b.pathStorage));
}

export type ClaseDeposito = 'storkhub' | 'comercio' | 'pago_cobro' | 'otro';
export function claseDeposito(dep: DocumentData): ClaseDeposito {
  if (dep.tipo === TIPO_DEPOSITO_STORKHUB) return 'storkhub';
  if (dep.tipo === TIPO_DEPOSITO_COMERCIO) return 'comercio';
  if (dep.tipo === TIPO_DEPOSITO_PAGO_COBRO) return 'pago_cobro';
  return 'otro';
}

/** Mismas claves de la orden que lib/deposito-transiciones.ts. */
export function clavesOrden(clase: 'storkhub' | 'comercio') {
  return clase === 'storkhub'
    ? { id: 'registro.deposito.storkhubDepositoId', confirmado: 'registro.deposito.confirmadoStorkhub', confirmadoAt: 'registro.deposito.confirmadoStorkhubAt' }
    : { id: 'registro.deposito.comercioDepositoId', confirmado: 'registro.deposito.confirmadoComercio', confirmadoAt: 'registro.deposito.confirmadoComercioAt' };
}

/** Lo que una transacción de Rehacer/Anular necesita LEER (todo antes de escribir). */
export interface LecturasDepositoAccion {
  getUsuario(uid: string): Promise<DocumentData | null>;
  getDeposito(id: string): Promise<DocumentData | null>;
  getMotorizadoDocId(authUid: string): Promise<string | null>;
  getSolicitud(id: string): Promise<DocumentData | null>;
  getGasto(id: string): Promise<DocumentData | null>;
  /** TODOS los movimientos del ledger con depositoId == id (activos y anulados). */
  getMovimientosDeDeposito(depositoId: string): Promise<Array<{ id: string; data: DocumentData }>>;
  /** Liquidaciones del motorizado, por su authUid Y por su doc id (se unen sin duplicar). */
  getLiquidacionesDelMotorizado(motorizadoUid: string, motorizadoDocId: string): Promise<Array<{ id: string; data: DocumentData }>>;
}

/** Órdenes del depósito, leídas (no se confía en nada que mande el cliente). */
export function ordenesDelDeposito(dep: DocumentData): string[] {
  const ids = idsUnicos(dep.solicitudIds);
  if (ids.length > MAX_ORDENES_POR_DEPOSITO) throw rechazoDeposito('conciliacion_requerida', 'El depósito tiene demasiadas órdenes para operarlo.');
  return ids;
}

/**
 * Cada orden existe y su puntero (si lo tiene) es ESTE depósito. `exigirPuntero`: Rehacer y Anular de un confirmado exigen
 * que apunte; Anular de un preconfirmado acepta una orden aún sin puntero (aún no se envió a revisión).
 * `exigirConfirmadoComercio`: G5 de Comercio confirmado.
 */
export async function verificarOrdenes(
  tx: Pick<LecturasDepositoAccion, 'getSolicitud'>,
  ids: string[],
  depositoId: string,
  clase: 'storkhub' | 'comercio',
  opts: { exigirPuntero: boolean; exigirConfirmadoComercio?: boolean },
): Promise<void> {
  const k = clase === 'storkhub' ? 'storkhubDepositoId' : 'comercioDepositoId';
  for (const sid of ids) {
    const o = await tx.getSolicitud(sid);
    if (!o) throw rechazoDeposito('conciliacion_requerida', 'Una de las órdenes del depósito ya no existe.', { solicitudId: sid });
    const puntero = (o.registro as { deposito?: Record<string, unknown> } | undefined)?.deposito?.[k];
    const tiene = puntero !== undefined && puntero !== null && puntero !== '';
    if (tiene && puntero !== depositoId) {
      throw rechazoDeposito('conciliacion_requerida', 'Una de las órdenes apunta a otro depósito. No se opera ni se corrige solo.', { solicitudId: sid });
    }
    if (!tiene && opts.exigirPuntero) {
      throw rechazoDeposito('conciliacion_requerida', 'Una de las órdenes no apunta a este depósito. No se opera ni se corrige solo.', { solicitudId: sid });
    }
    if (opts.exigirConfirmadoComercio) {
      const conf = (o.registro as { deposito?: Record<string, unknown> } | undefined)?.deposito?.confirmadoComercio;
      if (conf !== true) throw rechazoDeposito('conciliacion_requerida', 'Una orden del depósito de comercio no figura confirmada.', { solicitudId: sid });
    }
  }
}

/**
 * Gastos FIN-2 de un depósito STORKHUB: cada uno existe y NO lo consumió otro depósito. Devuelve los que consumió ESTE (los
 * únicos que Anular libera; Rehacer los deja intactos). Comercio no descuenta gastos: gastosIds debe estar vacío.
 */
export async function verificarGastos(
  tx: Pick<LecturasDepositoAccion, 'getGasto'>,
  dep: DocumentData,
  depositoId: string,
  clase: 'storkhub' | 'comercio',
  exigirConsumidoPorEste: boolean,
): Promise<string[]> {
  const ids = idsUnicos(dep.gastosIds);
  if (clase === 'comercio') {
    if (ids.length > 0) throw rechazoDeposito('conciliacion_requerida', 'Un depósito de comercio no descuenta gastos y trae gastos asociados.');
    return [];
  }
  const propios: string[] = [];
  for (const gid of ids) {
    const g = await tx.getGasto(gid);
    if (!g) throw rechazoDeposito('conciliacion_requerida', 'Uno de los gastos del depósito ya no existe.', { gastoId: gid });
    const marca = g[CAMPO_GASTO_CONSUMIDO];
    if (marca === depositoId) { propios.push(gid); continue; }
    if (marca !== undefined && marca !== null && marca !== '') {
      throw rechazoDeposito('conciliacion_requerida', 'Uno de los gastos del depósito lo consumió otro depósito.', { gastoId: gid });
    }
    if (exigirConsumidoPorEste) {
      throw rechazoDeposito('conciliacion_requerida', 'Uno de los gastos del depósito ya no figura consumido por él.', { gastoId: gid });
    }
  }
  return propios;
}

/**
 * Ledger de un depósito CONFIRMADO: exactamente UN movimiento activo y es el originario, coherente con el depósito. Se localiza
 * por contenido (tipo, depositoId, monto, cuentas, propietario), nunca por prefijo de id.
 */
export function movimientoOriginario(
  dep: DocumentData,
  depositoId: string,
  clase: 'storkhub' | 'comercio',
  motDocId: string,
  movimientos: Array<{ id: string; data: DocumentData }>,
): { id: string; data: DocumentData } {
  const activos = movimientos.filter((m) => estaVivo(m.data));
  if (activos.length === 0) throw rechazoDeposito('ledger_inconsistente', 'El depósito figura confirmado pero no tiene un movimiento activo en el ledger.', { activos: 0 });
  if (activos.length > 1) throw rechazoDeposito('ledger_inconsistente', 'El depósito tiene más de un movimiento activo en el ledger.', { activos: activos.length });
  const m = activos[0];
  const esperado = clase === 'storkhub' ? TIPO_MOVIMIENTO_DEPOSITO_STORKHUB : TIPO_MOVIMIENTO_DEPOSITO_COMERCIO;
  if (m.data.tipo !== esperado) {
    if (m.data.tipo === TIPO_MOVIMIENTO_CONVERSION) throw rechazoDeposito('usar_reversion_conversion', 'El depósito tiene una conversión en deuda: se revierte con la reversión de conversión.');
    if (m.data.tipo === TIPO_MOVIMIENTO_LEGACY) throw rechazoDeposito('conciliacion_requerida', 'El movimiento del depósito es de un formato anterior. Hay que conciliarlo: no se corrige solo.', { tipo: String(m.data.tipo) });
    throw rechazoDeposito('ledger_inconsistente', 'El movimiento activo del depósito no es el de su confirmación.', { tipo: String(m.data.tipo ?? '') });
  }
  const destinatarioId = typeof dep.destinatarioId === 'string' ? dep.destinatarioId : '';
  const coherente =
    m.data.depositoId === depositoId
    && mismoMonto(m.data.monto, esNumeroFinito(dep.montoTotal) ? dep.montoTotal : NaN)
    && m.data.cuentaOrigen === cuentas.efectivoEnPoder(motDocId)
    && (clase === 'storkhub'
      ? m.data.cuentaDestino === cuentas.banco && m.data.propietario === 'storkhub'
      : idValido(destinatarioId)
        && m.data.cuentaDestino === cuentas.saldoComercio(destinatarioId)
        && m.data.propietario === `comercio:${destinatarioId}`
        && (m.data.comercioId === undefined || m.data.comercioId === destinatarioId));
  if (!coherente) {
    throw rechazoDeposito('conciliacion_requerida', 'El movimiento del depósito no coincide con el depósito (monto, cuentas o propietario). Hay que conciliarlo: no se corrige solo.');
  }
  return m;
}

const aMillis = (v: unknown): number | null => {
  if (v && typeof (v as { toMillis?: unknown }).toMillis === 'function') {
    const n = (v as { toMillis: () => number }).toMillis();
    return Number.isFinite(n) ? n : null;
  }
  return null;
};

/**
 * ¿Alguna liquidación del motorizado ya CAPTURÓ este depósito? Bloquea sin mirar el estado de la liquidación (abierta también):
 *   A. su `depositosIds` lo contiene; o, para una liquidación legacy SIN `depositosIds`,
 *   B. semanaInicio ≤ creadoAt ≤ semanaFin.
 * Si no se puede decidir (legacy y el depósito no tiene creadoAt/ la semana no es legible) falla CERRADO.
 */
export function liquidacionQueLoCapturo(
  dep: DocumentData,
  depositoId: string,
  liquidaciones: Array<{ id: string; data: DocumentData }>,
): { id: string } | null {
  const creado = aMillis(dep.creadoAt);
  for (const l of liquidaciones) {
    if (Array.isArray(l.data.depositosIds)) {
      if ((l.data.depositosIds as unknown[]).includes(depositoId)) return { id: l.id };
      continue;
    }
    const ini = aMillis(l.data.semanaInicio), fin = aMillis(l.data.semanaFin);
    if (creado === null || ini === null || fin === null) {
      throw rechazoDeposito('conciliacion_requerida', 'Hay una liquidación anterior sin el detalle de sus depósitos y no se puede descartar que lo haya capturado. Hay que conciliarlo.', { liquidacionId: l.id });
    }
    if (ini <= creado && creado <= fin) return { id: l.id };
  }
  return null;
}

export function bloqueoLiquidacion(clase: 'storkhub' | 'comercio', liquidacionId: string): HttpsError {
  return clase === 'comercio'
    ? rechazoDeposito('deposito_comercio_ya_liquidado', 'El depósito ya figura en una liquidación del motorizado: no se rehace ni se anula. La corrección económica es una operación explícita aparte.', { liquidacionId })
    : rechazoDeposito('deposito_ya_liquidado', 'El depósito ya figura en una liquidación del motorizado: no se rehace ni se anula. La corrección económica es una operación explícita aparte.', { liquidacionId });
}
