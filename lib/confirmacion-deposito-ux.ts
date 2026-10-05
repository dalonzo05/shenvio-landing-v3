// FIN-3 — cómo se le cuenta al gestor lo que respondió confirmarDeposito.
//
// La confirmación financiera ya no la escribe la pantalla: la hace la callable
// confirmarDeposito en una transacción. La pantalla solo (1) la invoca y (2)
// presenta el resultado. Este módulo es la parte (2), pura y sin Firebase, para
// poder probarla.
//
// Seis resultados que NO se confunden entre sí:
//
//   exito           se abrió y cerró la confirmación
//   ya_procesada    el depósito YA estaba confirmado: no se escribió nada nuevo
//                   (doble clic, otra pestaña, otro gestor, reintento)
//   estado_cambio   el depósito ya no está en un estado confirmable
//   inconsistencia  el servidor NO pudo demostrar el monto, las órdenes o los
//                   gastos del depósito: no confirmó nada y no corrigió nada
//   permiso         el usuario no puede confirmar
//   temporal        error de red / servidor. NO se sabe si llegó a confirmarse:
//                   no se reintenta solo, se revisa el estado antes
//
// Una operación financiera de resultado desconocido NUNCA se repite en automático.

export type CategoriaConfirmacion =
  | 'exito'
  | 'ya_procesada'
  | 'estado_cambio'
  | 'inconsistencia'
  | 'permiso'
  | 'temporal'

export interface ResultadoConfirmacionServidor {
  ok: true
  resultado: 'confirmado' | 'ya_confirmado'
  depositoId: string
  movimientoId: string | null
  montoTotal: number
  estadoAnterior: string
  estadoNuevo: string
}

export interface ConfirmacionPresentada {
  categoria: CategoriaConfirmacion
  mensaje: string
  /** true solo cuando el depósito quedó confirmado (en esta llamada o en una anterior). */
  confirmado: boolean
}

/** Lo que lanzan confirmarStorkhub/confirmarComercio cuando la callable falla, con su categoría. */
export class ErrorConfirmacionDeposito extends Error {
  readonly categoria: CategoriaConfirmacion
  constructor(categoria: CategoriaConfirmacion, mensaje: string) {
    super(mensaje)
    this.name = 'ErrorConfirmacionDeposito'
    this.categoria = categoria
  }
}

export const MSG_CONFIRMADO = 'Depósito confirmado.'
export const MSG_YA_PROCESADO = 'Este depósito ya estaba confirmado. No se registró nada nuevo.'
export const MSG_ESTADO_CAMBIO = 'El depósito cambió de estado y ya no se puede confirmar. Actualizá la pantalla y revisá antes de continuar.'
export const MSG_PERMISO = 'Tu usuario no tiene permiso para confirmar depósitos.'
export const MSG_TEMPORAL =
  'No pudimos confirmar el depósito ahora. No sabemos si llegó a confirmarse: revisá su estado en Depósitos antes de reintentar.'
const MSG_INCONSISTENCIA_BASE = 'No se confirmó: el servidor no pudo comprobar los datos del depósito.'

export function presentarResultadoConfirmacion(r: Pick<ResultadoConfirmacionServidor, 'resultado'>): ConfirmacionPresentada {
  return r.resultado === 'ya_confirmado'
    ? { categoria: 'ya_procesada', mensaje: MSG_YA_PROCESADO, confirmado: true }
    : { categoria: 'exito', mensaje: MSG_CONFIRMADO, confirmado: true }
}

interface ErrorCallable {
  code?: unknown
  message?: unknown
  details?: { motivo?: unknown } | null
}

/** `functions/failed-precondition` (cliente) y `failed-precondition` (servidor) son lo mismo. */
function codigoNormalizado(e: ErrorCallable): string {
  return typeof e.code === 'string' ? e.code.replace(/^functions\//, '') : ''
}

export function presentarErrorConfirmacion(e: unknown): ConfirmacionPresentada {
  const err = (typeof e === 'object' && e !== null ? e : {}) as ErrorCallable
  const code = codigoNormalizado(err)
  const motivo = typeof err.details?.motivo === 'string' ? err.details.motivo : ''
  const mensajeServidor = typeof err.message === 'string' ? err.message.trim() : ''

  if (code === 'permission-denied' || code === 'unauthenticated') {
    return { categoria: 'permiso', mensaje: MSG_PERMISO, confirmado: false }
  }
  if (code === 'not-found' || (code === 'failed-precondition' && motivo === 'estado_cambio')) {
    return { categoria: 'estado_cambio', mensaje: MSG_ESTADO_CAMBIO, confirmado: false }
  }
  if (code === 'failed-precondition' || code === 'invalid-argument') {
    return {
      categoria: 'inconsistencia',
      mensaje: mensajeServidor ? `${MSG_INCONSISTENCIA_BASE} ${mensajeServidor}` : MSG_INCONSISTENCIA_BASE,
      confirmado: false,
    }
  }
  // unavailable, deadline-exceeded, internal, unknown, sin red, sin código…
  return { categoria: 'temporal', mensaje: MSG_TEMPORAL, confirmado: false }
}

/** Lanza el error de pantalla si la presentación no es de éxito. */
export function exigirConfirmado(p: ConfirmacionPresentada): ConfirmacionPresentada {
  if (!p.confirmado) throw new ErrorConfirmacionDeposito(p.categoria, p.mensaje)
  return p
}
