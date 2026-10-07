// FIN-1A — cómo se le cuenta al gestor lo que respondieron condonarDeudaMotorizado y anularSaldoCargo, y cuándo la
// pantalla de Saldos ofrece "Anular".
//
// Ninguna de las dos acciones la escribe ya la pantalla: las hacen las callables en una transacción, con
// { saldoId, motivo } como única entrada. Este módulo es la parte de presentación, pura y sin Firebase, para poder
// probarla. El servidor sigue siendo la autoridad: `evaluarAnulacion` solo decide si el BOTÓN es accionable o
// muestra la razón; nunca autoriza nada.

export type CategoriaSaldoAccion =
  | 'exito'
  | 'ya_hecho'
  | 'bloqueado'
  | 'inconsistente'
  | 'estado_invalido'
  | 'permiso'
  | 'invalido'
  | 'temporal'

export interface ResultadoCondonacionServidor {
  ok: true
  resultado: 'condonada' | 'ya_condonada'
  saldoId: string
  depositoId: string
  movimientoId: string
  montoCondonado: number
}

export interface ResultadoAnulacionServidor {
  ok: true
  resultado: 'anulada' | 'ya_anulado'
  saldoId: string
  movimientoId: string | null
}

export interface AccionSaldoPresentada {
  categoria: CategoriaSaldoAccion
  mensaje: string
  /** true solo cuando la acción quedó hecha (ahora o antes). */
  hecho: boolean
}

export class ErrorAccionSaldo extends Error {
  readonly categoria: CategoriaSaldoAccion
  constructor(categoria: CategoriaSaldoAccion, mensaje: string) {
    super(mensaje)
    this.name = 'ErrorAccionSaldo'
    this.categoria = categoria
  }
}

export const MSG_MOTIVO = 'Indicá el motivo (entre 3 y 300 caracteres).'
export const MSG_PERMISO = 'Tu usuario no tiene permiso para esta acción.'
export const MSG_ESTADO_INVALIDO = 'El saldo cambió y ya no admite esta acción. Actualizá la pantalla y revisá antes de continuar.'
export const MSG_INCONSISTENTE = 'No se puede verificar que la operación sea segura: el saldo o su ledger no son coherentes. No se hizo nada; hay que revisarlo.'
export const MSG_TEMPORAL = 'No pudimos completar la operación ahora. No sabemos si llegó a hacerse: revisá el saldo antes de reintentar.'
export const MSG_CONDONADA = 'Deuda condonada. La pérdida quedó registrada en el ledger.'
export const MSG_YA_CONDONADA = 'Esta deuda ya estaba condonada. No se registró nada nuevo.'
export const MSG_ANULADA = 'Saldo anulado.'
export const MSG_YA_ANULADO = 'Este saldo ya estaba anulado. No se registró nada nuevo.'

const BLOQUEOS: Record<string, string> = {
  saldo_no_condonable: 'Esta deuda no se puede condonar (solo una deuda de depósito pendiente o con abonos parciales).',
  sin_saldo_pendiente: 'La deuda no tiene saldo pendiente: no hay nada que condonar.',
  usar_reversion_conversion: 'Un saldo de depósito no se anula: usá "Revertir" (o "Condonar").',
  usar_correccion_liquidacion: 'Este saldo viene de una liquidación: debe corregirse desde la liquidación.',
  ledger_no_demostrable: 'Saldo legacy no conciliado: no se anula hasta revisar su movimiento contable.',
  saldo_con_abonos: 'Tiene abonos registrados. No puede anularse.',
  saldo_pagado: 'Esta deuda ya fue pagada. No puede anularse.',
  saldo_condonado: 'Esta deuda fue condonada. No puede anularse.',
  saldo_no_anulable: 'Este saldo no se puede anular por esta vía.',
}

export function presentarResultadoCondonacion(r: Pick<ResultadoCondonacionServidor, 'resultado'>): AccionSaldoPresentada {
  return r.resultado === 'ya_condonada'
    ? { categoria: 'ya_hecho', mensaje: MSG_YA_CONDONADA, hecho: true }
    : { categoria: 'exito', mensaje: MSG_CONDONADA, hecho: true }
}

export function presentarResultadoAnulacion(r: Pick<ResultadoAnulacionServidor, 'resultado'>): AccionSaldoPresentada {
  return r.resultado === 'ya_anulado'
    ? { categoria: 'ya_hecho', mensaje: MSG_YA_ANULADO, hecho: true }
    : { categoria: 'exito', mensaje: MSG_ANULADA, hecho: true }
}

interface ErrorCallable {
  code?: unknown
  details?: { motivo?: unknown } | null
}

export function presentarErrorAccionSaldo(e: unknown): AccionSaldoPresentada {
  const err = (typeof e === 'object' && e !== null ? e : {}) as ErrorCallable
  const code = typeof err.code === 'string' ? err.code.replace(/^functions\//, '') : ''
  const motivo = typeof err.details?.motivo === 'string' ? err.details.motivo : ''
  const no = (categoria: CategoriaSaldoAccion, mensaje: string): AccionSaldoPresentada => ({ categoria, mensaje, hecho: false })

  if (code === 'permission-denied' || code === 'unauthenticated') return no('permiso', MSG_PERMISO)
  if (code === 'not-found') return no('estado_invalido', MSG_ESTADO_INVALIDO)
  if (code === 'invalid-argument') return no('invalido', MSG_MOTIVO)
  if (code === 'failed-precondition') {
    if (BLOQUEOS[motivo]) return no('bloqueado', BLOQUEOS[motivo])
    // saldo_inconsistente, conversion_inconsistente, conciliacion_requerida, ledger_inconsistente y cualquier motivo nuevo
    return no('inconsistente', MSG_INCONSISTENTE)
  }
  return no('temporal', MSG_TEMPORAL)
}

export function exigirHecho(p: AccionSaldoPresentada): AccionSaldoPresentada {
  if (!p.hecho) throw new ErrorAccionSaldo(p.categoria, p.mensaje)
  return p
}

// ─── ¿Se ofrece "Anular"? (solo la pantalla; el servidor decide) ──────────────

export interface SaldoParaAnulacion {
  estado: string
  tipo: string
  origen: string
  depositoId?: string | null
  liquidacionId?: string | null
  saldoPendiente: number
  montoOriginal: number
  abonos?: unknown[] | null
  montoCondonado?: number | null
  movimientoCondonacionId?: string | null
  condonadoAt?: unknown
}

export type Anulabilidad = { anulable: true } | { anulable: false; razon: string }

/**
 * Una deuda manual (ajuste_manual / otro) pendiente y sin abonos: lo único que la callable anula. El resto muestra la
 * razón en lugar de un botón que luego fallaría sin explicación (el ledger lo demuestra el servidor).
 */
export function evaluarAnulacion(s: SaldoParaAnulacion): Anulabilidad {
  if (s.origen === 'deposito' || s.depositoId) return { anulable: false, razon: BLOQUEOS.usar_reversion_conversion }
  if (s.origen === 'liquidacion' || s.liquidacionId) return { anulable: false, razon: BLOQUEOS.usar_correccion_liquidacion }
  if (s.tipo === 'adelanto') return { anulable: false, razon: BLOQUEOS.ledger_no_demostrable }
  if (s.origen !== 'manual' || (s.tipo !== 'ajuste_manual' && s.tipo !== 'otro')) return { anulable: false, razon: BLOQUEOS.saldo_no_anulable }
  if (s.estado === 'condonado' || s.condonadoAt != null || s.montoCondonado != null || s.movimientoCondonacionId != null) return { anulable: false, razon: BLOQUEOS.saldo_condonado }
  if (s.estado === 'pagado') return { anulable: false, razon: BLOQUEOS.saldo_pagado }
  const abonos = Array.isArray(s.abonos) ? s.abonos.length : 0
  if (s.estado === 'abonado_parcial' || abonos > 0 || s.saldoPendiente !== s.montoOriginal) return { anulable: false, razon: BLOQUEOS.saldo_con_abonos }
  if (s.estado !== 'pendiente') return { anulable: false, razon: MSG_INCONSISTENTE }
  return { anulable: true }
}
