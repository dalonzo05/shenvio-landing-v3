// COBROS-PAGO-INTEGRIDAD-1 — Qué se puede hacer con un cobro y con un
// depósito según su estado, y qué escribe la reversión de un pago tipo C.
//
// Tres P0 que este módulo cierra:
//
//   1. "Ver boucher" en Historial cobrados abría el mismo modal de revisión
//      sobre una orden YA PAGADA, con "Confirmar pago", "Quitar" y
//      "Reemplazar". Confirmar de nuevo creaba otro DEP tipo C y otro
//      movimiento pago_recibido, y reescribía el puntero de la orden.
//   2. Revertir un pago por transferencia devolvía el cobro a pendiente y
//      anulaba el movimiento, pero dejaba el DEP tipo C confirmado y la orden
//      con confirmadoStorkhub = true: cobro pendiente + liquidación confirmada.
//   3. El boucher de un depósito confirmado se podía reemplazar: evidencia de
//      dinero ya recibido, sobrescrita sin rastro.
//
// Regla: un cobro 'pagado' y un depósito 'confirmado' son evidencia cerrada.
// Solo se reabren por una vía explícita (Revertir / Rehacer), nunca por las
// acciones normales de revisión.
//
// PURO: sin Firestore, sin React, sin efectos.

import { TIPO_PAGO_DELIVERY_TRANSFERENCIA } from './presentacion-deposito'
import { camposLiberacionDeposito } from './deposito-transiciones'

export const MSG_COBRO_YA_PAGADO =
  'Este cobro ya está pagado. No se puede confirmar ni modificar desde aquí; si hay un error, usá Revertir.'

export const MSG_DEPOSITO_CONFIRMADO =
  'Este depósito ya está confirmado. Su comprobante es evidencia cerrada y no se puede reemplazar.'

// ─── Cobro ────────────────────────────────────────────────────────────────────

type CobroMinimo = { estado?: string | null } | null | undefined

/** ¿Se puede confirmar este cobro? Nunca dos veces. */
export function puedeConfirmarCobro(cobro: CobroMinimo): boolean {
  return cobro?.estado !== 'pagado'
}

/** ¿Se puede subir, reemplazar o quitar el boucher de este cobro? */
export function puedeMutarBoucherCobro(cobro: CobroMinimo): boolean {
  return cobro?.estado !== 'pagado'
}

/**
 * Guard de los writers de confirmación. Se llama con el cobro LEÍDO DENTRO de
 * la transacción, no con el de la pantalla, que puede estar desactualizado.
 */
export function asegurarCobroConfirmable(cobro: CobroMinimo): void {
  if (!puedeConfirmarCobro(cobro)) throw new Error(MSG_COBRO_YA_PAGADO)
}

export function asegurarBoucherCobroMutable(cobro: CobroMinimo): void {
  if (!puedeMutarBoucherCobro(cobro)) throw new Error(MSG_COBRO_YA_PAGADO)
}

// ─── Depósito ─────────────────────────────────────────────────────────────────

/**
 * ¿Se puede reemplazar el comprobante de este depósito? No si está
 * confirmado. firestore.rules aplica la misma regla a gestor y admin.
 */
export function puedeMutarBoucherDeposito(estado: string | null | undefined): boolean {
  return estado !== 'confirmado'
}

export function asegurarBoucherDepositoMutable(estado: string | null | undefined): void {
  if (!puedeMutarBoucherDeposito(estado)) throw new Error(MSG_DEPOSITO_CONFIRMADO)
}

// ─── Reversión de un cobro pagado ─────────────────────────────────────────────

/**
 * Campos del cobro al revertir. Son los que ya escribía revertirPagada; acá
 * quedan en un solo lugar para poder testearlos.
 *
 * @param borrar el `deleteField()` del llamador
 */
export function camposReversionCobro<B>(borrar: B, movimientoId: string): Record<string, string | B> {
  return {
    'cobroDelivery.estado': 'pendiente',
    'cobroDelivery.pagadoAt': borrar,
    'cobroDelivery.formaPago': borrar,
    'cobroDelivery.notaPago': borrar,
    // Se conserva como rastro de auditoría: apunta al movimiento, ahora anulado.
    'cobroDelivery.movimientoPagoId': movimientoId,
  }
}

export interface PlanReversionDeposito {
  /** El DEP tipo C que debe pasar a 'anulado'. null = no se toca ningún depósito. */
  anularDepositoId: string | null
  /** Campos de la orden (registro.deposito.*). Vacío = no se tocan. */
  camposOrden: Record<string, boolean | null>
}

/**
 * Qué hacer con el depósito de la orden al revertir su cobro.
 *
 * Solo aplica al pago del delivery por transferencia (tipo C): ese documento
 * ES el registro del pago que se está revirtiendo. Un depósito del motorizado
 * (tipo A/B) es otro dinero —el efectivo que él entregó— y la reversión del
 * cobro no lo toca.
 *
 * Con el tipo C:
 *   · confirmado → se anula (estado 'anulado', que ya usa el modelo; no se
 *     borra: queda como rastro), y la orden se libera: sin puntero y sin
 *     confirmadoStorkhub, igual que devolverAlMotorizado. No queda ningún
 *     puntero activo a una liquidación anulada.
 *   · ya anulado → la orden se libera si todavía apuntaba a él.
 *
 * @param punteroId  registro.deposito.storkhubDepositoId de la orden
 * @param deposito   ese documento, leído en la misma transacción (null si no existe)
 */
export function planReversionDeposito(
  punteroId: string | null | undefined,
  deposito: { id: string; tipo?: string | null; estado?: string | null } | null,
): PlanReversionDeposito {
  const nada: PlanReversionDeposito = { anularDepositoId: null, camposOrden: {} }
  if (typeof punteroId !== 'string' || !punteroId) return nada
  if (!deposito || deposito.id !== punteroId) return nada
  if (deposito.tipo !== TIPO_PAGO_DELIVERY_TRANSFERENCIA) return nada
  return {
    anularDepositoId: deposito.estado === 'anulado' ? null : deposito.id,
    camposOrden: camposLiberacionDeposito('storkhub'),
  }
}

/** Campos del DEP tipo C al anularlo por la reversión del cobro. */
export function camposAnulacionDeposito<T>(uid: string | null | undefined, marca: T, motivo: string): Record<string, string | T> {
  const limpio = typeof uid === 'string' ? uid.trim() : ''
  return {
    estado: 'anulado',
    anuladoAt: marca,
    ...(limpio ? { anuladoPorUid: limpio } : {}),
    motivoAnulacion: motivo,
  }
}

export const MOTIVO_ANULACION_REVERSION = 'Reversión de cobro contado por gestor'
