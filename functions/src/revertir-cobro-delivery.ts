// ═════════════════════════════════════════════════
// revertirCobroDelivery — FIN-1C-A: reversión AUTORITATIVA e IDEMPOTENTE de un cobro de delivery pagado
// ═════════════════════════════════════════════════
//
// Antes: revertirPagada era una runTransaction de CLIENTE que decidía qué movimiento anular (por movimientoPagoId o por una consulta
// legacy), anulaba el DEP tipo C y devolvía el cobro a 'pendiente'. Las Rules aceptaban cualquier reversión que "pareciera" legítima.
//
// Ahora una sola transacción, con { operacionId, ordenId } como única entrada y solo para admin o gestor activo:
//
//   · La orden debe estar 'pagado'. El movimiento pago_recibido se demuestra: por movimientoPagoId (existe, es de esta orden, está
//     activo) o —legacy sin puntero— solo si hay EXACTAMENTE UN pago_recibido activo y coherente con el cobro; 0 o >1 ⇒ conciliacion_requerida.
//   · No puede quedar ningún OTRO pago_recibido activo para la orden.
//   · Si la orden apunta a un DEP tipo C: debe ser de esta orden sola; se anula (no se borra) y la orden se libera. Un depósito de
//     motorizado (A/B) es otro dinero y no se toca.
//   · Se anula el movimiento (nunca se borra) y el cobro vuelve a 'pendiente' dejando movimientoPagoId como rastro.
//   · Idempotente por operacionId: marcador operaciones_cobro/revertir_<operacionId>.

import { HttpsError } from 'firebase-functions/v2/https';
import type { DocumentData } from 'firebase-admin/firestore';
import { calcularMontoCobroDelivery } from './cobro-delivery-monto';
import {
  TIPO_DEPOSITO_PAGO_COBRO, TIPO_MOVIMIENTO_PAGO, exigirStaffCobros, idValido, mismoMontoCobro, rechazoCobro, validarPeticionReversion,
  type LecturasCobro,
} from './cobro-acciones-comun';
import { esNumeroFinito } from './deposito-monto';

export const MOTIVO_REVERSION_COBRO = 'Reversión de cobro contado por gestor';

export type ResultadoReversion = {
  ok: true;
  resultado: 'revertido' | 'ya_revertido';
  operacionId: string;
  ordenId: string;
  movimientoId: string;
  depositoAnuladoId: string | null;
};

export interface TxReversion extends LecturasCobro {
  updateSolicitud(id: string, campos: DocumentData): void;
  updateMovimiento(id: string, campos: DocumentData): void;
  updateDeposito(id: string, campos: DocumentData): void;
  crearOperacion(id: string, campos: DocumentData): void;
}

export interface DepsReversion {
  transaction<T>(fn: (tx: TxReversion) => Promise<T>): Promise<T>;
  serverTimestamp(): unknown;
  /** El centinela de "borrar este campo" (FieldValue.delete()). */
  borrar(): unknown;
}

export const idOperacionReversion = (operacionId: string): string => `revertir_${operacionId}`;

export async function revertirCobroDeliveryCore(
  deps: DepsReversion,
  uid: string | undefined,
  data: unknown,
): Promise<ResultadoReversion> {
  if (!uid) throw new HttpsError('unauthenticated', 'Debés iniciar sesión.');
  const { operacionId, ordenId } = validarPeticionReversion(data);

  return deps.transaction(async (tx) => {
    // ── LECTURAS ──────────────────────────────────────────────────────────────
    const rol = exigirStaffCobros(await tx.getUsuario(uid));

    const op = await tx.getOperacion(idOperacionReversion(operacionId));
    if (op) {
      if (op.ordenId !== ordenId) throw rechazoCobro('operacion_inconsistente', 'Esa operación ya se usó en otra orden.');
      return {
        ok: true as const, resultado: 'ya_revertido' as const, operacionId, ordenId,
        movimientoId: String(op.movimientoId ?? ''),
        depositoAnuladoId: typeof op.depositoAnuladoId === 'string' ? op.depositoAnuladoId : null,
      };
    }

    const orden = await tx.getSolicitud(ordenId);
    if (!orden) throw new HttpsError('not-found', 'La orden no existe.');
    const cd = (orden.cobroDelivery && typeof orden.cobroDelivery === 'object' ? orden.cobroDelivery : null) as DocumentData | null;
    if (!cd || cd.estado !== 'pagado') throw rechazoCobro('cobro_no_pagado', 'Esta orden ya no está pagada (probablemente ya se revirtió).', { solicitudId: ordenId });
    if (calcularMontoCobroDelivery(orden).esCredito) throw rechazoCobro('orden_credito', 'Una orden de crédito semanal no se revierte por orden.', { solicitudId: ordenId });

    // Movimiento del pago, demostrado.
    const delOrden = await tx.getMovimientosDeSolicitud(ordenId);
    const activos = delOrden.filter((m) => m.data.estado !== 'anulado' && m.data.tipo === TIPO_MOVIMIENTO_PAGO);
    let movimientoId: string;
    const puntero = typeof cd.movimientoPagoId === 'string' ? cd.movimientoPagoId.trim() : '';
    if (puntero) {
      const mov = await tx.getMovimiento(puntero);
      if (!mov) throw rechazoCobro('conciliacion_requerida', 'El movimiento financiero del pago no existe. No se revirtió nada: hay que conciliarlo.', { solicitudId: ordenId });
      if (mov.solicitudId !== ordenId || mov.tipo !== TIPO_MOVIMIENTO_PAGO) {
        throw rechazoCobro('conciliacion_requerida', 'El movimiento del pago no corresponde a esta orden. No se revirtió nada: hay que conciliarlo.', { solicitudId: ordenId });
      }
      if (mov.estado === 'anulado') {
        throw rechazoCobro('conciliacion_requerida', 'El movimiento ya está anulado pero la orden seguía pagada. No se revirtió nada: hay que conciliarlo.', { solicitudId: ordenId });
      }
      if (activos.some((m) => m.id !== puntero)) {
        throw rechazoCobro('conciliacion_requerida', 'La orden tiene más de un pago activo en el ledger. No se revirtió nada: hay que conciliarlo.', { solicitudId: ordenId, activos: activos.length });
      }
      movimientoId = puntero;
    } else {
      if (activos.length !== 1) {
        throw rechazoCobro('conciliacion_requerida', activos.length === 0
          ? 'No se encontró ningún pago activo de esta orden. No se revirtió nada: hay que conciliarlo.'
          : 'Se encontraron varios pagos activos de esta orden. No se revirtió nada: hay que conciliarlo.', { solicitudId: ordenId, activos: activos.length });
      }
      if (esNumeroFinito(cd.monto) && !mismoMontoCobro(activos[0].data.monto, cd.monto)) {
        throw rechazoCobro('conciliacion_requerida', 'El pago activo no coincide con el monto del cobro. No se revirtió nada: hay que conciliarlo.', { solicitudId: ordenId });
      }
      movimientoId = activos[0].id;
    }

    // DEP tipo C de la orden (solo ese; el A/B del motorizado no se toca).
    const depId = (orden.registro as { deposito?: { storkhubDepositoId?: unknown } } | undefined)?.deposito?.storkhubDepositoId;
    let depAnular: string | null = null;
    let liberar = false;
    if (idValido(depId)) {
      const dep = await tx.getDeposito(depId);
      if (!dep) throw rechazoCobro('conciliacion_requerida', 'La orden apunta a un depósito que no existe. No se revirtió nada: hay que conciliarlo.', { solicitudId: ordenId });
      if (dep.tipo === TIPO_DEPOSITO_PAGO_COBRO) {
        const ids: unknown[] = Array.isArray(dep.solicitudIds) ? dep.solicitudIds : [];
        if (ids.length !== 1 || ids[0] !== ordenId) {
          throw rechazoCobro('conciliacion_requerida', 'El depósito del pago no es de esta orden sola. No se revirtió nada: hay que conciliarlo.', { solicitudId: ordenId });
        }
        liberar = true;
        if (dep.estado !== 'anulado') depAnular = depId;
      }
    }

    // ── ESCRITURAS ────────────────────────────────────────────────────────────
    const ahora = deps.serverTimestamp();
    const borrar = deps.borrar();
    const patch: DocumentData = {
      'cobroDelivery.estado': 'pendiente',
      'cobroDelivery.pagadoAt': borrar,
      'cobroDelivery.formaPago': borrar,
      'cobroDelivery.notaPago': borrar,
      'cobroDelivery.confirmadoPor': borrar,
      'cobroDelivery.confirmadoAt': borrar,
      'cobroDelivery.metodoPagoReal': borrar,
      // Rastro de auditoría: apunta al movimiento (ahora anulado).
      'cobroDelivery.movimientoPagoId': movimientoId,
      'cobroDelivery.revertidoAt': ahora,
      'cobroDelivery.revertidoPorUid': uid,
      updatedAt: ahora,
    };
    if (liberar) {
      patch['registro.deposito.storkhubDepositoId'] = null;
      patch['registro.deposito.confirmadoStorkhub'] = false;
      patch['registro.deposito.confirmadoStorkhubAt'] = null;
    }
    tx.updateSolicitud(ordenId, patch);
    tx.updateMovimiento(movimientoId, {
      estado: 'anulado', anuladoAt: ahora, anuladoPorUid: uid, anuladoPorRol: rol, motivoAnulacion: MOTIVO_REVERSION_COBRO,
    });
    if (depAnular) {
      tx.updateDeposito(depAnular, { estado: 'anulado', anuladoAt: ahora, anuladoPorUid: uid, motivoAnulacion: MOTIVO_REVERSION_COBRO });
    }
    tx.crearOperacion(idOperacionReversion(operacionId), {
      tipo: 'revertir_cobro', ordenId, movimientoId, depositoAnuladoId: depAnular, actorUid: uid, actorRol: rol, at: ahora,
    });

    return { ok: true as const, resultado: 'revertido' as const, operacionId, ordenId, movimientoId, depositoAnuladoId: depAnular };
  });
}
