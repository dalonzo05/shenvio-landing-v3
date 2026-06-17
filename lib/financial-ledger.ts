/**
 * financial-ledger.ts — Fase 2: helpers de auditoría financiera
 *
 * Funciones PURAS que calculan saldos derivados de movimientos_financieros.
 * No son fuente de verdad (eso es Fase 4+), sino herramienta de comparación.
 *
 * Fórmula base para cualquier cuenta (doble entrada simplificada):
 *   saldo = Σ(monto | cuentaDestino == cuenta, estado = activo)
 *          − Σ(monto | cuentaOrigen  == cuenta, estado = activo)
 *
 * NOTA Fase 1: no todos los movimientos tienen cuentaOrigen/cuentaDestino.
 * Los saldos calculados con estas funciones pueden ser incompletos hasta que
 * todos los flujos estén conectados al ledger (Fase 4+).
 */

import type { MovimientoFinanciero } from './financial-types'
import { cuentas } from './financial-types'

// ─── Balance por cuenta ───────────────────────────────────────────────────────

/**
 * Calcula el saldo de una cuenta a partir de un array de movimientos.
 * Excluye movimientos anulados automáticamente.
 */
export function calcularSaldoCuenta(
  movimientos: MovimientoFinanciero[],
  cuenta: string,
): number {
  return movimientos
    .filter((m) => m.estado !== 'anulado')
    .reduce((sum, m) => {
      if (m.cuentaDestino === cuenta) return sum + m.monto
      if (m.cuentaOrigen === cuenta) return sum - m.monto
      return sum
    }, 0)
}

// ─── Helpers por entidad ──────────────────────────────────────────────────────

/** Efectivo bajo custodia del motorizado según el ledger */
export function calcularEfectivoEnPoderMotorizado(
  movimientos: MovimientoFinanciero[],
  motorizadoId: string,
): number {
  return calcularSaldoCuenta(movimientos, cuentas.efectivoEnPoder(motorizadoId))
}

/** Deuda total del motorizado según el ledger (incluye adelantos) */
export function calcularDeudaMotorizado(
  movimientos: MovimientoFinanciero[],
  motorizadoId: string,
): number {
  return calcularSaldoCuenta(movimientos, cuentas.deudaMotorizado(motorizadoId))
}

/**
 * Deuda del motorizado para comparación con saldos_cargo_motorizado.
 * Excluye adelanto_motorizado porque los adelantos son flujo de liquidación
 * semanal, no deuda formal operativa — no generan saldo_cargo.
 * Usar esta función en auditoría comparativa (tab Motorizados).
 */
export function calcularDeudaOperativaMotorizado(
  movimientos: MovimientoFinanciero[],
  motorizadoId: string,
): number {
  const cuenta = cuentas.deudaMotorizado(motorizadoId)
  return movimientos
    .filter((m) => m.estado !== 'anulado' && m.tipo !== 'adelanto_motorizado')
    .reduce((sum, m) => {
      if (m.cuentaDestino === cuenta) return sum + m.monto
      if (m.cuentaOrigen === cuenta) return sum - m.monto
      return sum
    }, 0)
}

/** Comisión pendiente de pago al motorizado según el ledger */
export function calcularComisionPendienteMotorizado(
  movimientos: MovimientoFinanciero[],
  motorizadoId: string,
): number {
  return calcularSaldoCuenta(movimientos, cuentas.comisionPendiente(motorizadoId))
}

/** Saldo a favor del comercio (pendiente de cobrar por StorkHub) según el ledger */
export function calcularSaldoComercio(
  movimientos: MovimientoFinanciero[],
  comercioId: string,
): number {
  return calcularSaldoCuenta(movimientos, cuentas.saldoComercio(comercioId))
}

/** Producto cobrado en custodia del motorizado pendiente de depositar al comercio */
export function calcularProductoEnCustodiaMotorizado(
  movimientos: MovimientoFinanciero[],
  comercioId: string,
): number {
  return calcularSaldoCuenta(movimientos, cuentas.transitorioProducto(comercioId))
}

// ─── Balance completo (todas las cuentas) ─────────────────────────────────────

/**
 * Calcula el saldo de TODAS las cuentas que aparecen en los movimientos.
 * Útil para mostrar un balance sheet general.
 * @returns Map de cuenta → saldo
 */
export function calcularTodosLosBalances(
  movimientos: MovimientoFinanciero[],
): Map<string, number> {
  const balances = new Map<string, number>()
  movimientos
    .filter((m) => m.estado !== 'anulado')
    .forEach((m) => {
      if (m.cuentaDestino) {
        balances.set(m.cuentaDestino, (balances.get(m.cuentaDestino) ?? 0) + m.monto)
      }
      if (m.cuentaOrigen) {
        balances.set(m.cuentaOrigen, (balances.get(m.cuentaOrigen) ?? 0) - m.monto)
      }
    })
  return balances
}

// ─── Análisis de cobertura ────────────────────────────────────────────────────

/** Movimientos activos sin cuentaOrigen ni cuentaDestino (cobertura Fase 1 incompleta) */
export function movimientosSinCuentas(
  movimientos: MovimientoFinanciero[],
): MovimientoFinanciero[] {
  return movimientos.filter(
    (m) => m.estado !== 'anulado' && !m.cuentaOrigen && !m.cuentaDestino,
  )
}

/** Movimientos sin ninguna referencia operacional (solicitudId, depositoId, etc.) */
export function movimientosHuerfanos(
  movimientos: MovimientoFinanciero[],
): MovimientoFinanciero[] {
  return movimientos.filter(
    (m) =>
      m.estado !== 'anulado' &&
      !m.solicitudId &&
      !m.depositoId &&
      !m.motorizadoId &&
      !m.comercioId &&
      !m.saldoId &&
      !m.gastoId &&
      !m.liquidacionId,
  )
}

/**
 * Tipos de movimiento que DEBERÍAN tener cuentaOrigen/cuentaDestino
 * pero en Fase 1 pueden no tenerlas.
 */
const TIPOS_QUE_REQUIEREN_CUENTAS = new Set<string>([
  'gasto_aprobado',
  'saldo_creado',
  'adelanto_motorizado',
  'deposito_confirmado',
  'deposito_convertido_en_deuda',
  'liquidacion_pagada',
  // Tipos nuevos (Fase 1+)
  'delivery_efectivo_cobrado',
  'delivery_credito_generado',
  'producto_cobrado_efectivo',
  'deposito_efectivo_storkhub',
  'deposito_efectivo_comercio',
  'gasto_operativo_aprobado',
  'liquidacion_comision_calculada',
  'liquidacion_pago_efectivo',
  'liquidacion_pago_transferencia',
  'abono_deuda_motorizado',
  'deuda_condonada',
])

/** Movimientos que deberían tener cuentas pero no las tienen */
export function movimientosConCoberturaPendiente(
  movimientos: MovimientoFinanciero[],
): MovimientoFinanciero[] {
  return movimientos.filter(
    (m) =>
      m.estado !== 'anulado' &&
      TIPOS_QUE_REQUIEREN_CUENTAS.has(m.tipo) &&
      (!m.cuentaOrigen || !m.cuentaDestino),
  )
}

// ─── Extracción de IDs del ledger ─────────────────────────────────────────────

const PREFIJOS_MOTORIZADO = ['efectivo_en_poder:', 'deuda_motorizado:', 'comision_pendiente:']
const PREFIJOS_COMERCIO = ['saldo_comercio:', 'transitorio_producto:']

/** Extrae todos los motorizadoIds mencionados en cuentas de movimientos */
export function extraerMotorizadoIdsDelLedger(
  movimientos: MovimientoFinanciero[],
): Set<string> {
  const ids = new Set<string>()
  movimientos.forEach((m) => {
    for (const c of [m.cuentaOrigen, m.cuentaDestino]) {
      if (!c) continue
      for (const p of PREFIJOS_MOTORIZADO) {
        if (c.startsWith(p)) ids.add(c.slice(p.length))
      }
    }
    if (m.motorizadoId) ids.add(m.motorizadoId)
  })
  return ids
}

/** Extrae todos los comercioIds mencionados en cuentas de movimientos */
export function extraerComercioIdsDelLedger(
  movimientos: MovimientoFinanciero[],
): Set<string> {
  const ids = new Set<string>()
  movimientos.forEach((m) => {
    for (const c of [m.cuentaOrigen, m.cuentaDestino]) {
      if (!c) continue
      for (const p of PREFIJOS_COMERCIO) {
        if (c.startsWith(p)) ids.add(c.slice(p.length))
      }
    }
    if (m.comercioId) ids.add(m.comercioId)
  })
  return ids
}

// ─── Resumen de cobertura ─────────────────────────────────────────────────────

export interface ResumenCobertura {
  total: number
  conCuentas: number
  sinCuentas: number
  huerfanos: number
  conCoberturaPendiente: number
  porcentajeCoberturaDobleEntrada: number
}

export function calcularResumenCobertura(
  movimientos: MovimientoFinanciero[],
): ResumenCobertura {
  const activos = movimientos.filter((m) => m.estado !== 'anulado')
  const conCuentas = activos.filter((m) => m.cuentaOrigen || m.cuentaDestino).length
  const sinCuentas = activos.filter((m) => !m.cuentaOrigen && !m.cuentaDestino).length
  const huerfanos = movimientosHuerfanos(activos).length
  const conCoberturaPendiente = movimientosConCoberturaPendiente(activos).length

  return {
    total: activos.length,
    conCuentas,
    sinCuentas,
    huerfanos,
    conCoberturaPendiente,
    porcentajeCoberturaDobleEntrada:
      activos.length > 0 ? Math.round((conCuentas / activos.length) * 100) : 100,
  }
}
