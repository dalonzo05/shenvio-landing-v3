// FIN-4A — cómo se le cuenta al gestor lo que respondió convertirDepositoEnDeuda.
//
// La conversión financiera ya no la escribe la pantalla: la hace la callable
// convertirDepositoEnDeuda en una transacción. La pantalla solo (1) la invoca y
// (2) presenta el resultado. Este módulo es la parte (2), pura y sin Firebase, para
// poder probarla.
//
// Siete resultados que NO se confunden entre sí:
//
//   exito           se abrió y cerró la conversión: el saldo existe
//   ya_convertido   el depósito YA estaba convertido y coherente: no se escribió
//                   nada nuevo (doble clic, otra pestaña, otro gestor, reintento)
//   estado_invalido el depósito ya no está en un estado convertible (cambió, ya
//                   está confirmado, no existe, o no es de Storkhub)
//   inconsistencia  el servidor NO pudo demostrar el monto, las órdenes o los
//                   gastos: no convirtió nada y no corrigió nada
//   integridad      el depósito ya tiene un saldo o un movimiento que no cuadra
//                   con su estado: hay que revisarlo, no se repara en silencio
//   permiso         el usuario no puede convertir
//   temporal        error de red / servidor. NO se sabe si llegó a convertirse:
//                   no se reintenta solo, se revisa el estado antes
//
// Una operación financiera de resultado desconocido NUNCA se repite en automático.

export type CategoriaConversion =
  | 'exito'
  | 'ya_convertido'
  | 'estado_invalido'
  | 'inconsistencia'
  | 'integridad'
  | 'permiso'
  | 'temporal'

export interface ResultadoConversionServidor {
  ok: true
  resultado: 'convertido' | 'ya_convertido'
  depositoId: string
  saldoId: string
  movimientoId: string
  montoTotal: number
  estadoAnterior: string
  estadoNuevo: string
}

export interface ConversionPresentada {
  categoria: CategoriaConversion
  mensaje: string
  /** true solo cuando el depósito quedó convertido en deuda (en esta llamada o en una anterior). */
  convertido: boolean
}

/** Lo que lanzan los flujos de la pantalla cuando la callable falla, con su categoría. */
export class ErrorConversionDeposito extends Error {
  readonly categoria: CategoriaConversion
  constructor(categoria: CategoriaConversion, mensaje: string) {
    super(mensaje)
    this.name = 'ErrorConversionDeposito'
    this.categoria = categoria
  }
}

export const MSG_CONVERTIDO = 'Depósito convertido en deuda. El saldo a cargo del motorizado ya está registrado.'
export const MSG_YA_CONVERTIDO = 'Este depósito ya estaba convertido en deuda. No se registró nada nuevo.'
export const MSG_ESTADO_INVALIDO = 'El depósito cambió de estado y ya no se puede convertir en deuda. Actualizá la pantalla y revisá antes de continuar.'
export const MSG_PERMISO = 'Tu usuario no tiene permiso para convertir depósitos en deuda.'
export const MSG_TEMPORAL =
  'No pudimos convertir el depósito ahora. No sabemos si llegó a convertirse: revisá su estado en Depósitos y en Saldos a cargo antes de reintentar.'
const MSG_INCONSISTENCIA_BASE = 'No se convirtió: el servidor no pudo comprobar los datos del depósito.'
const MSG_INTEGRIDAD_BASE = 'No se convirtió: el saldo o el movimiento de este depósito no cuadran y hay que revisarlos antes de continuar.'

export function presentarResultadoConversion(r: Pick<ResultadoConversionServidor, 'resultado'>): ConversionPresentada {
  return r.resultado === 'ya_convertido'
    ? { categoria: 'ya_convertido', mensaje: MSG_YA_CONVERTIDO, convertido: true }
    : { categoria: 'exito', mensaje: MSG_CONVERTIDO, convertido: true }
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

const MOTIVOS_ESTADO = ['estado_cambio', 'confirmado_no_convertible', 'tipo_no_convertible']
const MOTIVOS_INTEGRIDAD = ['conversion_inconsistente', 'saldo_previo_vivo', 'ledger_inconsistente']

export function presentarErrorConversion(e: unknown): ConversionPresentada {
  const err = (typeof e === 'object' && e !== null ? e : {}) as ErrorCallable
  const code = codigoNormalizado(err)
  const motivo = typeof err.details?.motivo === 'string' ? err.details.motivo : ''
  const mensajeServidor = typeof err.message === 'string' ? err.message.trim() : ''

  if (code === 'permission-denied' || code === 'unauthenticated') {
    return { categoria: 'permiso', mensaje: MSG_PERMISO, convertido: false }
  }
  if (code === 'not-found' || (code === 'failed-precondition' && MOTIVOS_ESTADO.includes(motivo))) {
    return { categoria: 'estado_invalido', mensaje: MSG_ESTADO_INVALIDO, convertido: false }
  }
  if (code === 'failed-precondition' && MOTIVOS_INTEGRIDAD.includes(motivo)) {
    return {
      categoria: 'integridad',
      mensaje: mensajeServidor ? `${MSG_INTEGRIDAD_BASE} ${mensajeServidor}` : MSG_INTEGRIDAD_BASE,
      convertido: false,
    }
  }
  if (code === 'failed-precondition' || code === 'invalid-argument') {
    return {
      categoria: 'inconsistencia',
      mensaje: mensajeServidor ? `${MSG_INCONSISTENCIA_BASE} ${mensajeServidor}` : MSG_INCONSISTENCIA_BASE,
      convertido: false,
    }
  }
  // unavailable, deadline-exceeded, internal, unknown, sin red, sin código…
  return { categoria: 'temporal', mensaje: MSG_TEMPORAL, convertido: false }
}

/** Lanza el error de pantalla si la presentación no es de éxito. */
export function exigirConvertido(p: ConversionPresentada): ConversionPresentada {
  if (!p.convertido) throw new ErrorConversionDeposito(p.categoria, p.mensaje)
  return p
}
