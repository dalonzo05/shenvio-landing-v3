// FIN-4B — cómo se le cuenta al gestor lo que respondió revertirConversionEnDeuda, y cuándo la pantalla
// de Saldos ofrece "Revertir".
//
// La reversión ya no la escribe la pantalla: la hace la callable revertirConversionEnDeuda en UNA
// transacción, y solo sobre una deuda VIRGEN (pendiente, sin abonos, sin condonación, con su único
// movimiento de conversión). Este módulo es la parte de presentación, pura y sin Firebase, para poder
// probarla. El servidor sigue siendo la autoridad: `evaluarReversibilidad` solo decide si el BOTÓN es
// accionable o muestra la razón; nunca autoriza nada.
//
// Resultados que NO se confunden:
//
//   exito           se revirtió el ciclo ahora
//   ya_revertida    el ciclo ya estaba revertido: no se escribió nada (doble clic, reintento)
//   con_abonos      la deuda tiene abonos: NO se revierte automáticamente (los abonos no se tocan)
//   pagada          la deuda ya se cobró: no se revierte
//   condonada       la deuda se condonó: no se revierte
//   inconsistente   el servidor no pudo demostrar una reversión segura: no escribió nada, no repara
//   estado_invalido el saldo no existe o cambió de forma que ya no admite la reversión
//   permiso         el usuario no puede revertir
//   invalido        petición inválida (por ejemplo, motivo vacío)
//   temporal        red / servidor: NO se sabe si se revirtió; no se reintenta solo
//
// Una operación financiera de resultado desconocido NUNCA se repite en automático.

export type CategoriaReversion =
  | 'exito'
  | 'ya_revertida'
  | 'con_abonos'
  | 'pagada'
  | 'condonada'
  | 'inconsistente'
  | 'estado_invalido'
  | 'permiso'
  | 'invalido'
  | 'temporal'

export interface ResultadoReversionServidor {
  ok: true
  resultado: 'revertida' | 'ya_revertida'
  saldoId: string
  depositoId: string
  estadoDeposito: string
  movimientoId: string
  eventoId: string | null
}

export interface ReversionPresentada {
  categoria: CategoriaReversion
  mensaje: string
  /** true solo cuando el ciclo quedó revertido (en esta llamada o en una anterior). */
  revertida: boolean
}

/** Lo que lanza la pantalla cuando la callable falla, con su categoría. */
export class ErrorReversionConversion extends Error {
  readonly categoria: CategoriaReversion
  constructor(categoria: CategoriaReversion, mensaje: string) {
    super(mensaje)
    this.name = 'ErrorReversionConversion'
    this.categoria = categoria
  }
}

export const MSG_REVERTIDA_CON_BOUCHER = 'Conversión revertida. El depósito volvió a "En revisión" y el saldo a cargo quedó anulado.'
export const MSG_REVERTIDA_SIN_BOUCHER = 'Conversión revertida. El depósito volvió a "Pendiente de boucher" y el saldo a cargo quedó anulado.'
export const MSG_YA_REVERTIDA = 'Esta conversión ya estaba revertida. No se registró nada nuevo.'
export const MSG_CON_ABONOS = 'La deuda tiene abonos registrados y no puede revertirse automáticamente.'
export const MSG_PAGADA = 'Esta deuda ya fue pagada.'
export const MSG_CONDONADA = 'Esta deuda fue condonada.'
export const MSG_INCONSISTENTE = 'No se puede verificar una reversión segura.'
export const MSG_ESTADO_INVALIDO = 'El saldo cambió de estado y ya no se puede revertir. Actualizá la pantalla y revisá antes de continuar.'
export const MSG_PERMISO = 'Tu usuario no tiene permiso para revertir conversiones en deuda.'
export const MSG_MOTIVO = 'Indicá el motivo de la reversión (entre 3 y 300 caracteres).'
export const MSG_TEMPORAL =
  'No pudimos revertir la conversión ahora. No sabemos si llegó a revertirse: revisá el saldo y el depósito antes de reintentar.'

export function presentarResultadoReversion(r: Pick<ResultadoReversionServidor, 'resultado' | 'estadoDeposito'>): ReversionPresentada {
  if (r.resultado === 'ya_revertida') return { categoria: 'ya_revertida', mensaje: MSG_YA_REVERTIDA, revertida: true }
  return {
    categoria: 'exito',
    mensaje: r.estadoDeposito === 'pendiente_boucher' ? MSG_REVERTIDA_SIN_BOUCHER : MSG_REVERTIDA_CON_BOUCHER,
    revertida: true,
  }
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

export function presentarErrorReversion(e: unknown): ReversionPresentada {
  const err = (typeof e === 'object' && e !== null ? e : {}) as ErrorCallable
  const code = codigoNormalizado(err)
  const motivo = typeof err.details?.motivo === 'string' ? err.details.motivo : ''
  const no = (categoria: CategoriaReversion, mensaje: string): ReversionPresentada => ({ categoria, mensaje, revertida: false })

  if (code === 'permission-denied' || code === 'unauthenticated') return no('permiso', MSG_PERMISO)
  if (code === 'not-found') return no('estado_invalido', MSG_ESTADO_INVALIDO)
  if (code === 'invalid-argument') return no('invalido', MSG_MOTIVO)
  if (code === 'failed-precondition') {
    if (motivo === 'deuda_con_abonos') return no('con_abonos', MSG_CON_ABONOS)
    if (motivo === 'deuda_pagada') return no('pagada', MSG_PAGADA)
    if (motivo === 'deuda_condonada') return no('condonada', MSG_CONDONADA)
    if (motivo === 'saldo_no_revertible') return no('estado_invalido', MSG_ESTADO_INVALIDO)
    // conversion_inconsistente, movimientos_activos y cualquier motivo que esta versión no conozca
    return no('inconsistente', MSG_INCONSISTENTE)
  }
  // unavailable, deadline-exceeded, internal, unknown, sin red, sin código…
  return no('temporal', MSG_TEMPORAL)
}

/** Lanza el error de pantalla si la presentación no es de éxito. */
export function exigirRevertida(p: ReversionPresentada): ReversionPresentada {
  if (!p.revertida) throw new ErrorReversionConversion(p.categoria, p.mensaje)
  return p
}

// ─── ¿Se ofrece "Revertir"? (solo la pantalla; el servidor decide) ────────────

/** Lo que la pantalla sabe del saldo. */
export interface SaldoParaReversion {
  estado: string
  saldoPendiente: number
  montoOriginal: number
  abonos?: unknown[] | null
  montoCondonado?: number | null
  movimientoCondonacionId?: string | null
  condonadoAt?: unknown
}

export type Reversibilidad =
  | { reversible: true }
  | { reversible: false; categoria: Exclude<CategoriaReversion, 'exito' | 'ya_revertida'>; razon: string }

/**
 * Una deuda "aparentemente virgen": pendiente, sin abonos y con el pendiente igual al original. Si no lo es,
 * la razón se muestra en lugar de un botón que luego fallaría sin explicación.
 */
export function evaluarReversibilidad(s: SaldoParaReversion): Reversibilidad {
  const abonos = Array.isArray(s.abonos) ? s.abonos.length : 0
  if (s.estado === 'condonado' || s.condonadoAt != null || s.montoCondonado != null || s.movimientoCondonacionId != null) {
    return { reversible: false, categoria: 'condonada', razon: MSG_CONDONADA }
  }
  if (s.estado === 'pagado') return { reversible: false, categoria: 'pagada', razon: MSG_PAGADA }
  if (s.estado === 'abonado_parcial' || abonos > 0 || s.saldoPendiente !== s.montoOriginal) {
    return { reversible: false, categoria: 'con_abonos', razon: 'Tiene abonos registrados. No puede revertirse automáticamente.' }
  }
  if (s.estado !== 'pendiente') return { reversible: false, categoria: 'inconsistente', razon: MSG_INCONSISTENTE }
  return { reversible: true }
}

/** ¿El depósito tiene comprobante real? Misma definición que el servidor (url o pathStorage). */
export function depositoTieneBoucher(dep: { boucher?: { url?: unknown; pathStorage?: unknown } | null } | null | undefined): boolean {
  const b = dep?.boucher
  return !!(b && (b.url || b.pathStorage))
}

/** El texto de confirmación NO promete siempre "En revisión": depende de si el depósito tiene boucher. */
export function textoConfirmacionReversion(a: { motorizado: string; monto: string; tieneBoucher: boolean }): string {
  const destino = a.tieneBoucher ? 'En revisión' : 'Pendiente de boucher'
  return (
    `¿Revertir conversión en deuda?\n\nMotorizado: ${a.motorizado}\nMonto: ${a.monto}\n\n` +
    `Esto hará lo siguiente:\n` +
    `• El saldo a cargo quedará anulado.\n` +
    `• El depósito volverá a "${destino}".\n` +
    `• Las solicitudes asociadas dejarán de figurar como confirmadas por esta conversión.\n\n` +
    `Solo se revierte una deuda sin abonos. Usar solo si la conversión fue un error.`
  )
}
