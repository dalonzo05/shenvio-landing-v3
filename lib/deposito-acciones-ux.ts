// FIN-1B — cómo se le cuenta al admin lo que respondieron rehacerDeposito y anularDeposito.
//
// Ninguna de las dos acciones la escribe ya la pantalla de Depósitos: las hacen las callables en una transacción (functions/src/
// rehacer-deposito.ts y anular-deposito.ts). Este módulo es la parte de presentación, pura y sin Firebase, para poder probarla.

export type CategoriaDepositoAccion = 'exito' | 'ya_hecho' | 'bloqueado' | 'inconsistente' | 'estado_invalido' | 'permiso' | 'invalido' | 'temporal'

export interface ResultadoRehacerServidor {
  ok: true
  resultado: 'rehecho' | 'ya_rehecho'
  depositoId: string
  estadoDestino: string
  eventoId: string
  movimientoId: string | null
}

export interface ResultadoAnularDepositoServidor {
  ok: true
  resultado: 'anulado' | 'ya_anulado'
  depositoId: string
  estadoAnterior: string
  eventoId: string | null
  movimientoId: string | null
  gastosLiberados: number
}

export interface AccionDepositoPresentada {
  categoria: CategoriaDepositoAccion
  mensaje: string
  /** true solo cuando la acción quedó hecha (ahora o antes). */
  hecho: boolean
}

export class ErrorAccionDeposito extends Error {
  readonly categoria: CategoriaDepositoAccion
  constructor(categoria: CategoriaDepositoAccion, mensaje: string) {
    super(mensaje)
    this.name = 'ErrorAccionDeposito'
    this.categoria = categoria
  }
}

export const MSG_MOTIVO_DEPOSITO = 'Indicá el motivo (entre 3 y 300 caracteres).'
export const MSG_PERMISO_DEPOSITO = 'Solo un administrador puede rehacer o anular un depósito.'
export const MSG_ESTADO_DEPOSITO = 'El depósito cambió y ya no admite esta acción. Actualizá la pantalla y revisá antes de continuar.'
export const MSG_INCONSISTENTE_DEPOSITO = 'No se puede verificar que la operación sea segura: el depósito, sus órdenes o su ledger no son coherentes. No se hizo nada; hay que revisarlo.'
export const MSG_TEMPORAL_DEPOSITO = 'No pudimos completar la operación ahora. No sabemos si llegó a hacerse: revisá el depósito antes de reintentar.'
export const MSG_REHECHO_REVISION = 'Depósito rehecho: vuelve a "Por revisar" y su movimiento contable quedó anulado.'
export const MSG_REHECHO_PENDIENTE = 'Depósito rehecho: queda esperando comprobante y su movimiento contable quedó anulado.'
export const MSG_YA_REHECHO = 'Este depósito ya se había rehecho con esta operación. No se registró nada nuevo.'
export const MSG_ANULADO = 'Depósito anulado. Sus órdenes quedaron libres y su movimiento contable, anulado.'
export const MSG_YA_ANULADO_DEPOSITO = 'Este depósito ya estaba anulado. No se registró nada nuevo.'

const BLOQUEOS: Record<string, string> = {
  usar_reversion_conversion: 'Un depósito convertido en deuda no se rehace ni se anula: usá "Revertir conversión".',
  usar_revertir_cobro: 'Este depósito es el pago de un cobro: se corrige desde Cobros (Revertir).',
  deposito_no_rehacible: 'Solo se puede rehacer un depósito confirmado.',
  deposito_no_anulable: 'Un depósito en este estado no se puede anular.',
  deposito_ya_liquidado: 'Este depósito ya figura en una liquidación del motorizado: no se rehace ni se anula. La corrección económica se hace aparte.',
  deposito_comercio_ya_liquidado: 'Este depósito de comercio ya figura en una liquidación del motorizado: no se rehace ni se anula. La corrección económica se hace aparte.',
  operacion_inconsistente: 'Esa operación ya se usó en otro depósito. Volvé a intentarlo.',
}

export function presentarResultadoRehacer(r: Pick<ResultadoRehacerServidor, 'resultado' | 'estadoDestino'>): AccionDepositoPresentada {
  if (r.resultado === 'ya_rehecho') return { categoria: 'ya_hecho', mensaje: MSG_YA_REHECHO, hecho: true }
  return { categoria: 'exito', mensaje: r.estadoDestino === 'pendiente_boucher' ? MSG_REHECHO_PENDIENTE : MSG_REHECHO_REVISION, hecho: true }
}

export function presentarResultadoAnularDeposito(r: Pick<ResultadoAnularDepositoServidor, 'resultado'>): AccionDepositoPresentada {
  return r.resultado === 'ya_anulado'
    ? { categoria: 'ya_hecho', mensaje: MSG_YA_ANULADO_DEPOSITO, hecho: true }
    : { categoria: 'exito', mensaje: MSG_ANULADO, hecho: true }
}

interface ErrorCallable {
  code?: unknown
  details?: { motivo?: unknown } | null
}

export function presentarErrorAccionDeposito(e: unknown): AccionDepositoPresentada {
  const err = (typeof e === 'object' && e !== null ? e : {}) as ErrorCallable
  const code = typeof err.code === 'string' ? err.code.replace(/^functions\//, '') : ''
  const motivo = typeof err.details?.motivo === 'string' ? err.details.motivo : ''
  const no = (categoria: CategoriaDepositoAccion, mensaje: string): AccionDepositoPresentada => ({ categoria, mensaje, hecho: false })

  if (code === 'permission-denied' || code === 'unauthenticated') return no('permiso', MSG_PERMISO_DEPOSITO)
  if (code === 'not-found') return no('estado_invalido', MSG_ESTADO_DEPOSITO)
  if (code === 'invalid-argument') return no('invalido', MSG_MOTIVO_DEPOSITO)
  if (code === 'failed-precondition') {
    if (BLOQUEOS[motivo]) return no('bloqueado', BLOQUEOS[motivo])
    // ledger_inconsistente, conciliacion_requerida y cualquier motivo nuevo
    return no('inconsistente', MSG_INCONSISTENTE_DEPOSITO)
  }
  return no('temporal', MSG_TEMPORAL_DEPOSITO)
}

export function exigirHechoDeposito(p: AccionDepositoPresentada): AccionDepositoPresentada {
  if (!p.hecho) throw new ErrorAccionDeposito(p.categoria, p.mensaje)
  return p
}

/**
 * La identidad de UN intento de Rehacer. Se conserva mientras el intento no termine bien (un reintento del mismo depósito con el
 * mismo motivo, tras una respuesta perdida, reusa la operación y el servidor responde `ya_rehecho` en vez de repetir el ciclo) y se
 * descarta al éxito o al cambiar de depósito/motivo.
 */
export interface IntentoRehacer { clave: string; operacionId: string }

export function operacionDeRehacer(
  actual: IntentoRehacer | null,
  depositoId: string,
  motivo: string,
  nuevoId: () => string,
): IntentoRehacer {
  const clave = `${depositoId}|${motivo.trim()}`
  return actual && actual.clave === clave ? actual : { clave, operacionId: nuevoId() }
}
