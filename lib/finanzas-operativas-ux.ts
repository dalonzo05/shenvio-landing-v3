// FIN-1C-B — cómo se le cuenta al gestor lo que respondieron crearGastoMotorizado, anularGastoMotorizado, registrarAdelantoMotorizado,
// anularAdelantoMotorizado y resolverIncidenciaCobro.
//
// Ninguna de las cinco acciones la escribe ya el navegador: las hacen las callables en una transacción (functions/src/crear-gasto.ts,
// anular-gasto.ts, adelantos.ts y resolver-incidencia-cobro.ts). Este módulo es la parte de presentación, pura y sin Firebase.

export type CategoriaOp = 'exito' | 'ya_hecho' | 'bloqueado' | 'inconsistente' | 'estado_invalido' | 'permiso' | 'invalido' | 'temporal'

export interface ResultadoCrearGastoServidor { ok: true; resultado: 'registrado' | 'ya_registrado'; operacionId: string; gastoId: string; movimientoId: string }
export interface ResultadoAnularGastoServidor { ok: true; resultado: 'anulado' | 'ya_anulado'; gastoId: string; movimientoId: string | null }
export interface ResultadoRegistrarAdelantoServidor { ok: true; resultado: 'registrado' | 'ya_registrado'; operacionId: string; adelantoId: string }
export interface ResultadoAnularAdelantoServidor { ok: true; resultado: 'anulado' | 'ya_anulado'; adelantoId: string }
export interface ResultadoCrearLiquidacionServidor { ok: true; resultado: 'creada' | 'ya_creada'; operacionId: string; liquidacionId: string; netoAPagar: number; deudasAplicadas: number; saldoGeneradoId: string | null }
export interface ResultadoPagarLiquidacionServidor { ok: true; resultado: 'pagada' | 'ya_pagada'; liquidacionId: string; movimientoId: string | null; netoAPagar: number }
export interface ResultadoResolverServidor { ok: true; resultado: 'resuelto' | 'ya_resuelto'; ordenId: string; item: 'delivery' | 'producto'; decision: 'cliente_pagara' | 'se_pierde'; cobroPendiente: boolean }

export interface OpPresentada {
  categoria: CategoriaOp
  mensaje: string
  /** true solo cuando la acción quedó hecha (ahora o antes). */
  hecho: boolean
}

export class ErrorOp extends Error {
  readonly categoria: CategoriaOp
  constructor(categoria: CategoriaOp, mensaje: string) {
    super(mensaje)
    this.name = 'ErrorOp'
    this.categoria = categoria
  }
}

export const MSG_PERMISO_OP = 'Solo un administrador o gestor activo puede hacer esto.'
export const MSG_ESTADO_OP = 'El registro cambió o ya no existe. Actualizá la pantalla y revisá antes de continuar.'
export const MSG_INVALIDO_OP = 'Los datos no son válidos. Revisá el monto, la fecha y los campos e intentá de nuevo.'
export const MSG_INCONSISTENTE_OP = 'No se puede verificar que la operación sea segura: los datos y el ledger no son coherentes. No se hizo nada; hay que revisarlo.'
export const MSG_TEMPORAL_OP = 'No pudimos completar la operación ahora. No sabemos si llegó a hacerse: revisá el registro antes de reintentar.'

export const MSG_GASTO_CREADO = 'Gasto registrado.'
export const MSG_GASTO_YA_CREADO = 'Este gasto ya estaba registrado. No se registró nada nuevo.'
export const MSG_GASTO_ANULADO = 'Gasto anulado.'
export const MSG_GASTO_YA_ANULADO = 'Este gasto ya estaba anulado. No se registró nada nuevo.'
export const MSG_ADELANTO_REGISTRADO = 'Adelanto registrado.'
export const MSG_ADELANTO_YA_REGISTRADO = 'Este adelanto ya estaba registrado. No se registró nada nuevo.'
export const MSG_ADELANTO_ANULADO = 'Adelanto anulado.'
export const MSG_ADELANTO_YA_ANULADO = 'Este adelanto ya estaba anulado. No se registró nada nuevo.'
export const MSG_LIQUIDACION_CREADA = 'Liquidación creada.'
export const MSG_LIQUIDACION_YA_CREADA = 'Esta liquidación ya estaba creada. No se registró nada nuevo.'
export const MSG_LIQUIDACION_PAGADA = 'Liquidación pagada.'
export const MSG_LIQUIDACION_YA_PAGADA = 'Esta liquidación ya estaba pagada. No se registró nada nuevo.'
export const MSG_INCIDENCIA_RESUELTA = 'Incidencia resuelta.'
export const MSG_INCIDENCIA_YA_RESUELTA = 'Esta incidencia ya estaba resuelta con esa decisión. No se registró nada nuevo.'

const BLOQUEOS: Record<string, string> = {
  motorizado_inexistente: 'El motorizado ya no existe.',
  orden_invalida: 'La orden no existe, no está entregada o no es de ese motorizado.',
  fecha_futura: 'La fecha del gasto no puede ser futura.',
  gasto_consumido: 'Este gasto ya se descontó en un depósito: no se puede anular. Si el depósito está mal, se corrige el depósito.',
  gasto_liquidado: 'Este gasto ya figura en una liquidación: no se puede anular. La corrección se hace aparte.',
  semana_liquidada: 'Esa semana ya tiene una liquidación para este motorizado: no se pueden registrar gastos ni registrar o anular adelantos.',
  // FIN-1D — liquidaciones
  semana_no_cerrada: 'Esa semana todavía no terminó: solo se liquidan semanas cerradas.',
  liquidacion_existente: 'Esa semana ya tiene una liquidación para este motorizado.',
  deposito_pendiente_conciliacion: 'Hay un depósito de esa semana todavía sin resolver (pendiente de boucher, en revisión o devuelto). Resolvelo antes de liquidar.',
  motorizado_invalido: 'El motorizado no tiene un acceso válido: no se puede liquidar.',
  saldo_invalido: 'Uno de los saldos elegidos ya no se puede descontar (cambió, ya no está pendiente o no es de este motorizado). Actualizá la selección e intentá de nuevo.',
  sin_viajes: 'No hay viajes entregados en esa semana: no hay nada que liquidar.',
  demasiados_registros: 'La liquidación tiene demasiados registros para una sola operación. Hay que dividirla: avisá a soporte.',
  estado_invalido: 'La liquidación no está pendiente: no se puede pagar.',
  movimiento_invalido: 'El movimiento indicado no es un adelanto.',
  operacion_inconsistente: 'Esa operación ya se usó con otros datos. Volvé a intentarlo.',
  incidencia_no_abierta: 'Esa incidencia ya no está abierta (ya se resolvió). Actualizá la pantalla.',
  cobro_ya_pagado: 'El cobro de la orden ya está pagado: no se resuelve la incidencia.',
  orden_no_entregada: 'Solo se resuelve la incidencia de una orden entregada.',
  estado_incompatible: 'El cobro tiene un comprobante en revisión: no se puede marcar como "se pierde".',
}

const ya = (hecho: boolean, nuevo: string, repetido: string, esNuevo: boolean): OpPresentada => (esNuevo
  ? { categoria: 'exito', mensaje: nuevo, hecho }
  : { categoria: 'ya_hecho', mensaje: repetido, hecho })

export const presentarResultadoCrearGasto = (r: Pick<ResultadoCrearGastoServidor, 'resultado'>): OpPresentada => ya(true, MSG_GASTO_CREADO, MSG_GASTO_YA_CREADO, r.resultado === 'registrado')
export const presentarResultadoAnularGasto = (r: Pick<ResultadoAnularGastoServidor, 'resultado'>): OpPresentada => ya(true, MSG_GASTO_ANULADO, MSG_GASTO_YA_ANULADO, r.resultado === 'anulado')
export const presentarResultadoRegistrarAdelanto = (r: Pick<ResultadoRegistrarAdelantoServidor, 'resultado'>): OpPresentada => ya(true, MSG_ADELANTO_REGISTRADO, MSG_ADELANTO_YA_REGISTRADO, r.resultado === 'registrado')
export const presentarResultadoAnularAdelanto = (r: Pick<ResultadoAnularAdelantoServidor, 'resultado'>): OpPresentada => ya(true, MSG_ADELANTO_ANULADO, MSG_ADELANTO_YA_ANULADO, r.resultado === 'anulado')
export const presentarResultadoCrearLiquidacion = (r: Pick<ResultadoCrearLiquidacionServidor, 'resultado'>): OpPresentada => ya(true, MSG_LIQUIDACION_CREADA, MSG_LIQUIDACION_YA_CREADA, r.resultado === 'creada')
export const presentarResultadoPagarLiquidacion = (r: Pick<ResultadoPagarLiquidacionServidor, 'resultado'>): OpPresentada => ya(true, MSG_LIQUIDACION_PAGADA, MSG_LIQUIDACION_YA_PAGADA, r.resultado === 'pagada')
export const presentarResultadoResolver = (r: Pick<ResultadoResolverServidor, 'resultado'>): OpPresentada => ya(true, MSG_INCIDENCIA_RESUELTA, MSG_INCIDENCIA_YA_RESUELTA, r.resultado === 'resuelto')

interface ErrorCallable {
  code?: unknown
  details?: { motivo?: unknown } | null
}

export function presentarErrorOp(e: unknown): OpPresentada {
  const err = (typeof e === 'object' && e !== null ? e : {}) as ErrorCallable
  const code = typeof err.code === 'string' ? err.code.replace(/^functions\//, '') : ''
  const motivo = typeof err.details?.motivo === 'string' ? err.details.motivo : ''
  const no = (categoria: CategoriaOp, mensaje: string): OpPresentada => ({ categoria, mensaje, hecho: false })

  if (code === 'permission-denied' || code === 'unauthenticated') return no('permiso', MSG_PERMISO_OP)
  if (code === 'not-found') return no('estado_invalido', MSG_ESTADO_OP)
  if (code === 'invalid-argument') return no('invalido', MSG_INVALIDO_OP)
  if (code === 'failed-precondition') {
    if (BLOQUEOS[motivo]) return no('bloqueado', BLOQUEOS[motivo])
    // conciliacion_requerida y cualquier motivo que este build no conozca
    return no('inconsistente', MSG_INCONSISTENTE_OP)
  }
  return no('temporal', MSG_TEMPORAL_OP)
}

export function exigirHechoOp(p: OpPresentada): OpPresentada {
  if (!p.hecho) throw new ErrorOp(p.categoria, p.mensaje)
  return p
}

/**
 * La identidad de UN intento. Se conserva mientras el intento no termine bien (un reintento con los mismos datos, tras una respuesta perdida,
 * reusa la operación y el servidor responde `ya_registrado` en vez de duplicar) y se descarta al éxito, a un rechazo definitivo o al cambiar
 * los datos.
 */
export interface IntentoOp { clave: string; operacionId: string }

export function operacionDeIntento(actual: IntentoOp | null, partes: ReadonlyArray<string | number | null | undefined>, nuevoId: () => string): IntentoOp {
  const clave = partes.map((p) => (p === null || p === undefined ? '' : String(p).trim())).join('|')
  return actual && actual.clave === clave ? actual : { clave, operacionId: nuevoId() }
}
