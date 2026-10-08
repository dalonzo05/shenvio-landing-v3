// FIN-1C-A — cómo se le cuenta al gestor lo que respondieron registrarCobroDelivery, revertirCobroDelivery y registrarPagoCobroSemanal.
//
// Ninguna de las tres acciones la escribe ya la pantalla de Cobros: las hacen las callables en una transacción (functions/src/
// registrar-cobro-delivery.ts, revertir-cobro-delivery.ts y registrar-pago-cobro-semanal.ts). Este módulo es la parte de
// presentación, pura y sin Firebase, para poder probarla.

export type CategoriaCobroAccion = 'exito' | 'ya_hecho' | 'bloqueado' | 'inconsistente' | 'estado_invalido' | 'permiso' | 'invalido' | 'saldo' | 'temporal'

export interface ResultadoCobroServidor {
  ok: true
  resultado: 'registrado' | 'ya_registrado'
  operacionId: string
  ordenIds: string[]
  formaPago: 'efectivo' | 'transferencia'
  total: number
  movimientoIds: string[]
  depositoIds: string[]
}

export interface ResultadoReversionServidor {
  ok: true
  resultado: 'revertido' | 'ya_revertido'
  operacionId: string
  ordenId: string
  movimientoId: string
  depositoAnuladoId: string | null
}

export interface ResultadoPagoSemanalServidor {
  ok: true
  resultado: 'registrado' | 'ya_registrado'
  cobroSemanalId: string
  pagoId: string
  movimientoId: string
  estado: string
  totalPagado: number
  saldoPendiente: number
}

export interface AccionCobroPresentada {
  categoria: CategoriaCobroAccion
  mensaje: string
  /** true solo cuando la acción quedó hecha (ahora o antes). */
  hecho: boolean
  /** Saldo real del cobro semanal cuando el servidor rechazó por saldo_insuficiente. */
  saldoReal?: number
}

export class ErrorAccionCobro extends Error {
  readonly categoria: CategoriaCobroAccion
  readonly saldoReal?: number
  constructor(categoria: CategoriaCobroAccion, mensaje: string, saldoReal?: number) {
    super(mensaje)
    this.name = 'ErrorAccionCobro'
    this.categoria = categoria
    this.saldoReal = saldoReal
  }
}

export const MSG_PERMISO_COBRO = 'Solo un administrador o gestor activo puede operar cobros.'
export const MSG_ESTADO_COBRO = 'La orden cambió y ya no admite esta acción. Actualizá la pantalla y revisá antes de continuar.'
export const MSG_INVALIDO_COBRO = 'Los datos de la operación no son válidos. Revisalos e intentá de nuevo.'
export const MSG_INCONSISTENTE_COBRO = 'No se puede verificar que la operación sea segura: la orden, su monto o su ledger no son coherentes. No se hizo nada; hay que revisarlo.'
export const MSG_TEMPORAL_COBRO = 'No pudimos completar la operación ahora. No sabemos si llegó a hacerse: revisá la orden antes de reintentar.'
export const MSG_COBRADO = 'Cobro registrado.'
export const MSG_COBRADO_LOTE = 'Cobros registrados.'
export const MSG_YA_COBRADO = 'Este cobro ya se había registrado con esta operación. No se registró nada nuevo.'
export const MSG_REVERTIDO = 'Cobro revertido: la orden vuelve a quedar por cobrar y su movimiento contable quedó anulado.'
export const MSG_YA_REVERTIDO = 'Este cobro ya se había revertido con esta operación. No se registró nada nuevo.'
export const MSG_PAGO_SEMANAL = 'Pago registrado.'
export const MSG_YA_PAGO_SEMANAL = 'Este pago ya estaba registrado. No se registró nada nuevo.'

const BLOQUEOS: Record<string, string> = {
  orden_no_entregada: 'Solo se cobra una orden entregada.',
  orden_credito: 'Una orden de crédito semanal se cobra desde el crédito semanal, no por orden.',
  orden_ya_pagada: 'Una de las órdenes ya está pagada. No se cobró ninguna del lote; actualizá la pantalla.',
  orden_no_cobrable: 'Una de las órdenes está marcada como no cobrable.',
  incidencia_abierta: 'La orden tiene una incidencia de cobro sin clasificar. Resolvela antes de cobrar.',
  monto_cero: 'Una de las órdenes no tiene monto por cobrar.',
  boucher_requerido: 'Una transferencia exige el comprobante (boucher) de la orden.',
  puntero_ocupado: 'La orden ya apunta a un depósito de Storkhub: no se crea otro. Hay que revisarla.',
  cobro_no_pagado: 'Esta orden ya no está pagada (probablemente ya se revirtió). Actualizá la pantalla.',
  operacion_inconsistente: 'Esa operación ya se usó con otros datos. Volvé a intentarlo.',
  demasiadas_ordenes: 'El lote tiene demasiadas órdenes. Cobralas en grupos más chicos.',
}

export function presentarResultadoCobro(r: Pick<ResultadoCobroServidor, 'resultado' | 'ordenIds'>): AccionCobroPresentada {
  if (r.resultado === 'ya_registrado') return { categoria: 'ya_hecho', mensaje: MSG_YA_COBRADO, hecho: true }
  return { categoria: 'exito', mensaje: r.ordenIds.length > 1 ? MSG_COBRADO_LOTE : MSG_COBRADO, hecho: true }
}

export function presentarResultadoReversion(r: Pick<ResultadoReversionServidor, 'resultado'>): AccionCobroPresentada {
  return r.resultado === 'ya_revertido'
    ? { categoria: 'ya_hecho', mensaje: MSG_YA_REVERTIDO, hecho: true }
    : { categoria: 'exito', mensaje: MSG_REVERTIDO, hecho: true }
}

export function presentarResultadoPagoSemanal(r: Pick<ResultadoPagoSemanalServidor, 'resultado'>): AccionCobroPresentada {
  return r.resultado === 'ya_registrado'
    ? { categoria: 'ya_hecho', mensaje: MSG_YA_PAGO_SEMANAL, hecho: true }
    : { categoria: 'exito', mensaje: MSG_PAGO_SEMANAL, hecho: true }
}

interface ErrorCallable {
  code?: unknown
  details?: { motivo?: unknown; saldoReal?: unknown } | null
}

export function presentarErrorAccionCobro(e: unknown, fmtMonto: (n: number) => string = (n) => `C$ ${n}`): AccionCobroPresentada {
  const err = (typeof e === 'object' && e !== null ? e : {}) as ErrorCallable
  const code = typeof err.code === 'string' ? err.code.replace(/^functions\//, '') : ''
  const motivo = typeof err.details?.motivo === 'string' ? err.details.motivo : ''
  const no = (categoria: CategoriaCobroAccion, mensaje: string, saldoReal?: number): AccionCobroPresentada => ({ categoria, mensaje, hecho: false, ...(saldoReal !== undefined ? { saldoReal } : {}) })

  if (code === 'permission-denied' || code === 'unauthenticated') return no('permiso', MSG_PERMISO_COBRO)
  if (code === 'not-found') return no('estado_invalido', MSG_ESTADO_COBRO)
  if (code === 'invalid-argument') return no('invalido', MSG_INVALIDO_COBRO)
  if (code === 'failed-precondition') {
    if (motivo === 'saldo_insuficiente') {
      const saldo = typeof err.details?.saldoReal === 'number' ? err.details.saldoReal : undefined
      return no('saldo', saldo !== undefined ? `El monto excede el saldo pendiente real (${fmtMonto(saldo)}).` : 'El monto excede el saldo pendiente real.', saldo)
    }
    if (BLOQUEOS[motivo]) return no('bloqueado', BLOQUEOS[motivo])
    // monto_inconsistente, conciliacion_requerida, cobro_semanal_invalido y cualquier motivo nuevo
    return no('inconsistente', MSG_INCONSISTENTE_COBRO)
  }
  return no('temporal', MSG_TEMPORAL_COBRO)
}

export function exigirHechoCobro(p: AccionCobroPresentada): AccionCobroPresentada {
  if (!p.hecho) throw new ErrorAccionCobro(p.categoria, p.mensaje, p.saldoReal)
  return p
}

/**
 * La identidad de UN intento. Se conserva mientras el intento no termine bien (un reintento de las mismas órdenes con la misma
 * forma de pago, tras una respuesta perdida, reusa la operación y el servidor responde `ya_registrado` en vez de cobrar dos veces) y
 * se descarta al éxito o al cambiar de órdenes/forma de pago.
 */
export interface IntentoOperacion { clave: string; operacionId: string }

export function operacionDeCobro(
  actual: IntentoOperacion | null,
  ordenIds: readonly string[],
  formaPago: string,
  nuevoId: () => string,
): IntentoOperacion {
  const clave = `${[...ordenIds].sort().join(',')}|${formaPago}`
  return actual && actual.clave === clave ? actual : { clave, operacionId: nuevoId() }
}

export function operacionDeReversion(actual: IntentoOperacion | null, ordenId: string, nuevoId: () => string): IntentoOperacion {
  return actual && actual.clave === ordenId ? actual : { clave: ordenId, operacionId: nuevoId() }
}
