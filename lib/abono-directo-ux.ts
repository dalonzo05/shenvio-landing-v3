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
  | 'intencion'
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
  'No sabemos si el abono llegó a registrarse. Verificaremos la operación existente: reintentar es seguro, no se duplicará.'
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
    if (motivo.startsWith('intencion_')) return { categoria: 'intencion', mensaje: MSG_INTENCION_NO_DISPONIBLE, aplicado: false }
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

// ─── Intención de abono (FIN-4C, corrección) ────────────────────────────────
//
// La intención vive en el SERVIDOR. La pantalla no inventa identidad: la pide (preparar), la
// recupera al abrir/recargar (obtener) y decide qué mostrar a partir de lo que el servidor dice.
// Lo único que guarda en memoria es un CACHÉ de UX —qué operaciones aplicadas ya reconoció el
// usuario en esta sesión—, que NO es autoridad: si se pierde, el servidor sigue diciendo la verdad
// y la pantalla vuelve a ofrecer, de forma explícita, "Registrar otro abono".

export type EstadoIntencionAbono = 'preparada' | 'aplicada' | 'rechazada'

export interface IntencionAbono {
  operacionId: string
  saldoId: string
  monto: number
  metodoAbono: string
  estado: EstadoIntencionAbono
  movimientoId?: string
  motivoRechazo?: string
}

export interface RespuestaPreparar {
  ok: true
  resultado: 'preparada' | 'recuperada' | 'ya_aplicada' | 'operacion_pendiente_existente'
  intencion: IntencionAbono
}

export const MSG_APLICADA_RECUPERADA =
  'Este saldo ya tiene un abono registrado con estos datos (lo recuperamos del servidor). No se creó otro. Si querés registrar OTRO abono, usá «Registrar otro abono».'
export const MSG_PENDIENTE_EXISTENTE =
  'Hay un abono pendiente de confirmar con otros datos. Continuá con ese o descartalo antes de iniciar otro.'
export const MSG_INTENCION_NO_DISPONIBLE =
  'Esta operación ya no está disponible (se cerró o es de otro usuario). Volvé a iniciar el abono.'

export type DecisionPreparar =
  /** Hay operación (nueva o recuperada): se puede registrar con ESTE operacionId. */
  | { accion: 'continuar'; operacionId: string; recuperada: boolean }
  /** La operación vigente ya está aplicada: se muestra y NO se crea otra. */
  | { accion: 'mostrar_aplicada'; intencion: IntencionAbono; mensaje: string }
  /** Hay una pendiente con otros datos: se resuelve (continuar o descartar) antes de iniciar otra. */
  | { accion: 'resolver_pendiente'; intencion: IntencionAbono; mensaje: string }

export function decidirTrasPreparar(r: Pick<RespuestaPreparar, 'resultado' | 'intencion'>): DecisionPreparar {
  switch (r.resultado) {
    case 'preparada':
      return { accion: 'continuar', operacionId: r.intencion.operacionId, recuperada: false }
    case 'recuperada':
      return { accion: 'continuar', operacionId: r.intencion.operacionId, recuperada: true }
    case 'ya_aplicada':
      return { accion: 'mostrar_aplicada', intencion: r.intencion, mensaje: MSG_APLICADA_RECUPERADA }
    default:
      return { accion: 'resolver_pendiente', intencion: r.intencion, mensaje: MSG_PENDIENTE_EXISTENTE }
  }
}

export type VistaIntencion =
  | { tipo: 'ninguna' }
  | { tipo: 'pendiente'; intencion: IntencionAbono }
  | { tipo: 'aplicada_sin_reconocer'; intencion: IntencionAbono }

/**
 * Qué muestra la pantalla al abrir/recargar el formulario de un saldo, a partir de la intención vigente
 * del servidor. Una aplicada que el usuario YA reconoció en esta sesión no estorba; una aplicada que
 * no reconoció (recarga, otra pestaña, otro dispositivo) se muestra: recargar NO es iniciar otro abono.
 */
export function vistaIntencionAlAbrir(
  intencion: IntencionAbono | null,
  reconocidas: Readonly<Record<string, string>>,
  saldoId: string,
): VistaIntencion {
  if (!intencion) return { tipo: 'ninguna' }
  if (intencion.estado === 'preparada') return { tipo: 'pendiente', intencion }
  if (intencion.estado === 'aplicada' && reconocidas[saldoId] !== intencion.operacionId) return { tipo: 'aplicada_sin_reconocer', intencion }
  return { tipo: 'ninguna' }
}
