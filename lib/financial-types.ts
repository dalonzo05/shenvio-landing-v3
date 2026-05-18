// ─── Estados del cobro de delivery ────────────────────────────────────────────
export type EstadoCobroDelivery =
  | 'pendiente'
  | 'pagado'
  | 'no_cobrar'
  | 'en_revision_deposito' // cliente pagó por depósito, esperando confirmación gestor
  | 'revertido' // pago revertido después de confirmado

// ─── Tipos de depósito ─────────────────────────────────────────────────────────
export type TipoDeposito =
  | 'recaudacion_motorizado_storkhub' // motorizado deposita efectivo a Storkhub
  | 'recaudacion_motorizado_comercio' // motorizado deposita efectivo a comercio
  | 'pago_delivery_deposito' // cliente/comercio paga delivery por transferencia

// ─── Estados del depósito ──────────────────────────────────────────────────────
export type EstadoDeposito =
  | 'pendiente_boucher' // creado, esperando que motorizado suba boucher
  | 'en_revision' // boucher subido, esperando al gestor
  | 'confirmado' // gestor confirmó
  | 'rechazado' // gestor rechazó
  | 'convertido_en_deuda' // gestor convirtió el pendiente en saldo a cargo del motorizado

// ─── Tipos de movimiento financiero ───────────────────────────────────────────
export type TipoMovimiento =
  | 'cobro_generado'
  | 'pago_recibido'
  | 'pago_revertido'
  | 'monto_perdido'
  | 'deposito_subido'
  | 'deposito_confirmado'
  | 'deposito_rechazado'
  | 'deposito_convertido_en_deuda'
  | 'adelanto_motorizado'
  | 'faltante'
  | 'ajuste'
  | 'liquidacion_pagada'
  | 'gasto_aprobado'
  | 'saldo_creado'
  | 'abono_saldo'
  | 'aporte_empresa_motorizado' // empresa entrega dinero al motorizado para cubrir gasto > delivery disponible
  | 'ajuste_manual_saldo' // corrección contable sobre un saldo

// ─── Movimiento financiero (colección movimientos_financieros) ─────────────────
export interface MovimientoFinanciero {
  id?: string
  tipo: TipoMovimiento
  monto: number
  at: unknown // Firestore Timestamp / serverTimestamp()
  operadorId: string // UID de quien disparó la escritura
  descripcion: string
  // Referencias opcionales
  solicitudId?: string
  depositoId?: string
  motorizadoId?: string
  comercioId?: string
  saldoId?: string
  gastoId?: string
  metadata?: Record<string, unknown>
}

// ─── Estado de la liquidación semanal ─────────────────────────────────────────
export type EstadoLiquidacion = 'pendiente' | 'pagado'

// ─── Liquidación semanal del motorizado (colección liquidaciones_motorizado) ──
export interface LiquidacionMotorizado {
  id?: string
  motorizadoId: string // ID del doc en colección motorizado
  motorizadoUid: string // auth UID
  motorizadoNombre: string
  semanaKey: string // e.g. "2025-W14"
  semanaInicio: unknown // Firestore Timestamp
  semanaFin: unknown // Firestore Timestamp
  // Totales
  totalViajes: number
  totalGenerado: number // suma de tarifas de delivery de la semana
  comisionPct: number // 0.8 = 80%
  comision: number // totalGenerado * comisionPct
  // Descuentos
  adelantos: number // anticipos en efectivo entregados
  faltantesDeposito: number // diferencia entre recaudado y depositado
  otrosDescuentos: number
  // Deudas aplicadas en esta liquidación
  deudasAplicadas: number // monto total de deudas descontadas en esta liquidación
  deudasAplicadasIds: string[] // IDs de saldos_cargo_motorizado aplicados
  // Gastos operativos de la semana
  gastosAprobados?: number          // suma de gastos_motorizado aprobados de la semana
  gastosAsumidosStorkhub?: number   // porción que Storkhub asume (cuando gastos > efectivo recaudado)
  gastosIds?: string[]              // IDs de gastos_motorizado aplicados
  // Neto
  netoAPagar: number // comision - adelantos - faltantesDeposito + gastosAsumidosStorkhub - deudasAplicadas - otrosDescuentos
  // Estado
  estado: EstadoLiquidacion
  creadoAt: unknown
  creadoPor: string
  pagadoAt?: unknown
  pagadoPor?: string
  saldoGeneradoId?: string // ID en saldos_cargo_motorizado si netoAPagar < 0
  // Referencias
  ordenesIds: string[]
  depositosIds?: string[]
  movimientosIds?: string[]
}

// ─── Gastos operativos del motorizado (colección gastos_motorizado) ────────────
// Solo incluye gastos operativos reales vinculables a órdenes.
// ajuste_manual → usar TipoSaldo en saldos_cargo_motorizado
// aporte_empresa → usar TipoMovimiento 'aporte_empresa_motorizado' en movimientos_financieros
export type TipoGasto =
  | 'peaje_terminal'
  | 'pago_cargotrans'
  | 'otro_gasto_operativo'

export type EstadoGasto = 'aprobado' | 'anulado'

// Snapshot de la orden al momento de crear el gasto (para trazabilidad sin re-consultar)
export interface OrdenSnapshot {
  ordenId: string
  comercioNombre?: string
  comercioId?: string
  clienteNombre?: string
  entregadoAt?: unknown // Timestamp
  tipoEnvio?: string
  metodoEnvio?: string
  puntoLogistico?: string
  precioDelivery?: number
}

export interface GastoMotorizado {
  id?: string
  motorizadoId: string
  motorizadoNombre: string
  ordenId?: string // orden relacionada si aplica
  ordenSnapshot?: OrdenSnapshot // snapshot de datos clave de la orden
  tipo: TipoGasto
  monto: number
  estado: EstadoGasto // solo gestor/admin crea gastos → nacen aprobados
  nota?: string
  fecha: unknown // Timestamp del gasto
  creadoPorUid: string
  createdAt: unknown
  updatedAt?: unknown
}

// ─── Saldos a cargo del motorizado (colección saldos_cargo_motorizado) ─────────
export type TipoSaldo =
  | 'deposito_no_realizado' // depósito pendiente que el motorizado no hizo
  | 'adelanto' // anticipo entregado al motorizado
  | 'ajuste_manual'
  | 'otro'

export type EstadoSaldo = 'pendiente' | 'abonado_parcial' | 'pagado' | 'anulado'

export type OrigenSaldo = 'deposito' | 'liquidacion' | 'manual'

export interface AbonoSaldo {
  monto: number
  fecha: unknown // Timestamp
  metodo?: string // efectivo, transferencia, etc.
  nota?: string
  creadoPorUid: string
}

export interface SaldoCargoMotorizado {
  id?: string
  motorizadoId: string
  motorizadoUid: string
  motorizadoNombre: string
  tipo: TipoSaldo
  montoOriginal: number
  saldoPendiente: number
  estado: EstadoSaldo
  origen: OrigenSaldo
  depositoId?: string // si vino de un depósito convertido
  liquidacionId?: string // si se aplicó en una liquidación
  fecha: unknown // Timestamp
  nota?: string
  creadoPorUid: string
  createdAt: unknown
  updatedAt?: unknown
  abonos?: AbonoSaldo[]
}

// ─── Adelantos al motorizado (colección adelantos_motorizado) ─────────────────
export interface AdelantoMotorizado {
  id?: string
  motorizadoId: string
  motorizadoUid: string
  motorizadoNombre: string
  monto: number
  semanaKey: string // semana a la que se imputa
  nota?: string
  fecha: unknown
  creadoPorUid: string
  createdAt: unknown
  // Se crea un SaldoCargoMotorizado de tipo 'adelanto' en paralelo
  saldoId?: string
}

// ─── Helper de retrocompatibilidad para depósitos legacy ──────────────────────
// Docs antiguos no tienen campo `estado`, solo `confirmadoMotorizado` y `confirmadoGestor`
export function getDepositoEstado(dep: {
  estado?: string
  confirmadoGestor?: boolean
  boucher?: { url?: string } | null
}): EstadoDeposito {
  if (!dep.estado) {
    if (dep.confirmadoGestor === true) return 'confirmado'
    if (dep.boucher?.url) return 'en_revision'
    return 'pendiente_boucher'
  }
  return dep.estado as EstadoDeposito
}

// ─── Helpers de display ────────────────────────────────────────────────────────
export const LABELS_TIPO_GASTO: Record<TipoGasto, string> = {
  peaje_terminal: 'Peaje terminal',
  pago_cargotrans: 'Pago Cargotrans',
  otro_gasto_operativo: 'Otro gasto operativo',
}

export const LABELS_TIPO_SALDO: Record<TipoSaldo, string> = {
  deposito_no_realizado: 'Depósito no realizado',
  adelanto: 'Adelanto',
  ajuste_manual: 'Ajuste manual',
  otro: 'Otro',
}
