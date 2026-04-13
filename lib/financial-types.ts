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

// ─── Tipos de movimiento financiero ───────────────────────────────────────────
export type TipoMovimiento =
  | 'cobro_generado'
  | 'pago_recibido'
  | 'pago_revertido'
  | 'monto_perdido'
  | 'deposito_subido'
  | 'deposito_confirmado'
  | 'deposito_rechazado'
  | 'adelanto_motorizado'
  | 'faltante'
  | 'ajuste'
  | 'liquidacion_pagada'

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
  // Neto
  netoAPagar: number // comision - adelantos - faltantesDeposito - otrosDescuentos
  // Estado
  estado: EstadoLiquidacion
  creadoAt: unknown
  creadoPor: string
  pagadoAt?: unknown
  pagadoPor?: string
  // Referencias
  ordenesIds: string[]
  depositosIds?: string[]
  movimientosIds?: string[]
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
