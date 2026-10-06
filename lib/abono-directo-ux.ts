// FIN-4C — cómo se le cuenta al gestor lo que respondió registrarAbonoDirecto.
//
// El abono directo ya no lo escribe la pantalla: lo hace la callable en una transacción.
// La pantalla solo (1) la invoca y (2) presenta el resultado. Este módulo es la parte (2),
// pura y sin Firebase, para poder probarla.
//
// Diez resultados que NO se confunden entre sí:
//
//   exito             el abono quedó aplicado en esta llamada
//   ya_aplicado       esa MISMA operación ya estaba aplicada: no se registró nada nuevo
//   monto_invalido    el monto o algún dato de la petición no es válido
//   monto_excede      el monto supera el saldo pendiente ACTUAL (puede haber cambiado)
//   no_abonable       el saldo ya no admite abonos (pagado, anulado, condonado…)
//   saldo_inexistente el saldo ya no existe
//   conflicto         el mismo identificador de operación ya se usó con otros datos
//   integridad        el saldo y su ledger de esta operación no cuadran: se revisa, no se repara
//   permiso           el usuario no puede abonar
//   temporal          red / servidor. NO se sabe si el abono llegó a registrarse; reintentar es
//                     SEGURO porque la operación se conserva (mismo identificador)

export type CategoriaAbono =
  | 'exito'
  | 'ya_aplicado'
  | 'monto_invalido'
  | 'monto_excede'
  | 'no_abonable'
  | 'saldo_inexistente'
  | 'conflicto'
  | 'integridad'
  | 'permiso'
  | 'temporal'

export interface ResultadoAbonoServidor {
  ok: true
  resultado: 'aplicado' | 'ya_aplicado'
  saldoId: string
  operacionId: string
  movimientoId: string
  monto: number
  estadoAnterior: string
  estadoNuevo: string
  saldoPendienteAnterior: number | null
  saldoPendiente: number
}

export interface AbonoPresentado {
  categoria: CategoriaAbono
  mensaje: string
  /** true solo cuando el abono quedó aplicado (en esta llamada o en una anterior de la MISMA operación). */
  aplicado: boolean
}

/** Lo que lanza handleAbono cuando la callable falla, con su categoría. */
export class ErrorAbonoDirecto extends Error {
  readonly categoria: CategoriaAbono
  constructor(categoria: CategoriaAbono, mensaje: string) {
    super(mensaje)
    this.name = 'ErrorAbonoDirecto'
    this.categoria = categoria
  }
}

export const MSG_APLICADO = 'Abono registrado.'
export const MSG_YA_APLICADO = 'Este abono ya estaba registrado. No se registró nada nuevo.'
export const MSG_MONTO_EXCEDE = 'El monto supera el saldo pendiente actual: el saldo cambió. Revisá el pendiente y volvé a intentar con otro monto.'
export const MSG_NO_ABONABLE = 'Este saldo ya no admite abonos (está pagado, anulado o condonado). Actualizá la pantalla.'
export const MSG_SALDO_INEXISTENTE = 'El saldo ya no existe. Actualizá la pantalla.'
export const MSG_CONFLICTO = 'Esta operación ya se registró con otro monto o método. No se registró nada: revisá el saldo antes de continuar.'
export const MSG_PERMISO = 'Tu usuario no tiene permiso para registrar abonos.'
export const MSG_TEMPORAL =
  'No sabemos si el abono llegó a registrarse. Revisá el saldo: reintentar es seguro, no se duplicará.'
const MSG_INVALIDO_BASE = 'No se registró el abono: la petición no es válida.'
const MSG_INTEGRIDAD_BASE = 'No se registró el abono: el saldo y su movimiento de esta operación no cuadran y hay que revisarlos.'

export function presentarResultadoAbono(r: Pick<ResultadoAbonoServidor, 'resultado'>): AbonoPresentado {
  return r.resultado === 'ya_aplicado'
    ? { categoria: 'ya_aplicado', mensaje: MSG_YA_APLICADO, aplicado: true }
    : { categoria: 'exito', mensaje: MSG_APLICADO, aplicado: true }
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

export function presentarErrorAbono(e: unknown): AbonoPresentado {
  const err = (typeof e === 'object' && e !== null ? e : {}) as ErrorCallable
  const code = codigoNormalizado(err)
  const motivo = typeof err.details?.motivo === 'string' ? err.details.motivo : ''
  const mensajeServidor = typeof err.message === 'string' ? err.message.trim() : ''

  if (code === 'permission-denied' || code === 'unauthenticated') {
    return { categoria: 'permiso', mensaje: MSG_PERMISO, aplicado: false }
  }
  if (code === 'not-found') return { categoria: 'saldo_inexistente', mensaje: MSG_SALDO_INEXISTENTE, aplicado: false }
  if (code === 'invalid-argument') {
    return { categoria: 'monto_invalido', mensaje: mensajeServidor ? `${MSG_INVALIDO_BASE} ${mensajeServidor}` : MSG_INVALIDO_BASE, aplicado: false }
  }
  if (code === 'failed-precondition') {
    if (motivo === 'monto_excede_saldo') return { categoria: 'monto_excede', mensaje: MSG_MONTO_EXCEDE, aplicado: false }
    if (motivo === 'saldo_no_abonable') return { categoria: 'no_abonable', mensaje: MSG_NO_ABONABLE, aplicado: false }
    if (motivo === 'conflicto_idempotencia') return { categoria: 'conflicto', mensaje: MSG_CONFLICTO, aplicado: false }
    return {
      categoria: 'integridad',
      mensaje: mensajeServidor ? `${MSG_INTEGRIDAD_BASE} ${mensajeServidor}` : MSG_INTEGRIDAD_BASE,
      aplicado: false,
    }
  }
  // unavailable, deadline-exceeded, internal, unknown, sin red, sin código…
  return { categoria: 'temporal', mensaje: MSG_TEMPORAL, aplicado: false }
}

/** Lanza el error de pantalla si la presentación no es de éxito. */
export function exigirAbonado(p: AbonoPresentado): AbonoPresentado {
  if (!p.aplicado) throw new ErrorAbonoDirecto(p.categoria, p.mensaje)
  return p
}
