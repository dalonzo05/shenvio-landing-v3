// ═════════════════════════════════════════════════
// registrarCobroDelivery — FIN-1C-A: cobro del delivery AUTORITATIVO e IDEMPOTENTE (individual y en lote)
// ═════════════════════════════════════════════════
//
// Antes: PagoContadoModal, BoucherModal y marcarGrupoPagado escribían desde el navegador la orden (cobroDelivery.estado = 'pagado'),
// el movimiento pago_recibido del ledger y —en transferencia— el DEP tipo C, con un monto que salía de la pantalla. Las Rules dejaban a
// cualquier gestor/admin crear un DEP tipo C `confirmado` o un pago_recibido de cualquier monto.
//
// Ahora una sola transacción, con { operacionId, ordenIds, formaPago, nota? } como única entrada y solo para admin o gestor activo:
//
//   · Cada orden: entregada, de contado, sin incidencia abierta, sin cobro previo (pagado / no_cobrar ⇒ rechazo; TODO el lote o nada).
//   · Monto: se RECALCULA con la fórmula única (cobro-delivery-monto.ts) y debe coincidir con cobroDelivery.monto guardado
//     (`monto_inconsistente`). El cliente no manda ni monto ni estado ni actor ni rol.
//   · Ledger: un pago_recibido por orden con id determinista; si ya existe uno activo para la orden ⇒ conciliacion_requerida.
//   · Transferencia: exige boucher vigente y el puntero de la orden libre; crea UN DEP tipo C `confirmado` por orden. Efectivo: sin DEP-C.
//   · Idempotente por operacionId: marcador operaciones_cobro/cobro_<operacionId> (server-only). Un retry resuelve 'ya_registrado' ANTES
//     de los guards del estado actual, sin escribir.

import { HttpsError } from 'firebase-functions/v2/https';
import type { DocumentData } from 'firebase-admin/firestore';
import { calcularMontoCobroDelivery } from './cobro-delivery-monto';
import { esNumeroFinito } from './deposito-monto';
import {
  TIPO_DEPOSITO_PAGO_COBRO, TIPO_MOVIMIENTO_PAGO, boucherVigenteDeCobro, exigirStaffCobros, mismoMontoCobro, nombreClienteDeOrden,
  rechazoCobro, validarPeticionCobro, type FormaPago, type LecturasCobro,
} from './cobro-acciones-comun';

export type ResultadoCobro = {
  ok: true;
  /** 'registrado': se cobró ahora. 'ya_registrado': esa operación ya se aplicó; no se escribió nada. */
  resultado: 'registrado' | 'ya_registrado';
  operacionId: string;
  ordenIds: string[];
  formaPago: FormaPago;
  total: number;
  movimientoIds: string[];
  depositoIds: string[];
};

export interface TxCobro extends LecturasCobro {
  updateSolicitud(id: string, campos: DocumentData): void;
  crearMovimiento(id: string, campos: DocumentData): void;
  crearDeposito(id: string, campos: DocumentData): void;
  crearOperacion(id: string, campos: DocumentData): void;
}

export interface DepsCobro {
  transaction<T>(fn: (tx: TxCobro) => Promise<T>): Promise<T>;
  serverTimestamp(): unknown;
}

export const idOperacionCobro = (operacionId: string): string => `cobro_${operacionId}`;
export const idMovimientoCobro = (operacionId: string, ordenId: string): string => `pago_${operacionId}_${ordenId}`;
export const idDepositoCobro = (operacionId: string, ordenId: string): string => `depc_${operacionId}_${ordenId}`;

interface OrdenEvaluada { ordenId: string; orden: DocumentData; monto: number; cdExiste: boolean; nombre: string; boucherUrl: string | null }

/** Demuestra, con la orden y el ledger LEÍDOS, que se puede cobrar. No escribe. */
export function evaluarOrdenParaCobro(
  ordenId: string,
  orden: DocumentData | null,
  movimientos: Array<{ id: string; data: DocumentData }>,
  formaPago: FormaPago,
): OrdenEvaluada {
  if (!orden) throw new HttpsError('not-found', 'Una de las órdenes ya no existe.', { solicitudId: ordenId });
  if (orden.estado !== 'entregado') throw rechazoCobro('orden_no_entregada', 'Solo se cobra una orden entregada.', { solicitudId: ordenId });
  const calc = calcularMontoCobroDelivery(orden);
  if (calc.esCredito) throw rechazoCobro('orden_credito', 'Una orden de crédito semanal se cobra desde el crédito semanal, no por orden.', { solicitudId: ordenId });
  if (orden.cobroPendiente === true) throw rechazoCobro('incidencia_abierta', 'La orden tiene una incidencia de cobro sin clasificar. Resolvela antes de cobrar.', { solicitudId: ordenId });

  const cd = (orden.cobroDelivery && typeof orden.cobroDelivery === 'object' ? orden.cobroDelivery : null) as DocumentData | null;
  if (cd?.estado === 'pagado') throw rechazoCobro('orden_ya_pagada', 'Una de las órdenes ya está pagada.', { solicitudId: ordenId });
  if (cd?.estado === 'no_cobrar') throw rechazoCobro('orden_no_cobrable', 'Una de las órdenes está marcada como no cobrable.', { solicitudId: ordenId });

  // El monto GUARDADO (lo fijó el servidor al entregar) debe ser el que sale de la fórmula. Una orden sin monto guardado (legacy, o
  // clasificada por Cobros) cobra el recalculado. Nunca un monto que diga el cliente.
  if (cd && esNumeroFinito(cd.monto) && !mismoMontoCobro(cd.monto, calc.monto)) {
    throw rechazoCobro('monto_inconsistente', 'El monto guardado de una orden no coincide con el que sale de sus datos. No se cobra: hay que revisarla.', { solicitudId: ordenId });
  }
  if (!(calc.monto > 0)) throw rechazoCobro('monto_cero', 'Una de las órdenes no tiene monto por cobrar.', { solicitudId: ordenId });

  const activos = movimientos.filter((m) => m.data.estado !== 'anulado' && m.data.tipo === TIPO_MOVIMIENTO_PAGO);
  if (activos.length > 0) {
    throw rechazoCobro('conciliacion_requerida', 'La orden ya tiene un pago activo en el ledger aunque figura por cobrar. Hay que conciliarla: no se cobra dos veces.', { solicitudId: ordenId });
  }

  const boucherUrl = boucherVigenteDeCobro(cd);
  if (formaPago === 'transferencia') {
    if (!boucherUrl) throw rechazoCobro('boucher_requerido', 'Una transferencia exige el comprobante (boucher) de la orden.', { solicitudId: ordenId });
    const dep = (orden.registro as { deposito?: Record<string, unknown> } | undefined)?.deposito;
    const puntero = dep?.storkhubDepositoId;
    if ((puntero !== undefined && puntero !== null && puntero !== '') || dep?.confirmadoStorkhub === true) {
      throw rechazoCobro('puntero_ocupado', 'La orden ya apunta a un depósito de Storkhub. No se crea otro: hay que revisarla.', { solicitudId: ordenId });
    }
  }
  return { ordenId, orden, monto: calc.monto, cdExiste: !!cd, nombre: nombreClienteDeOrden(orden), boucherUrl };
}

export async function registrarCobroDeliveryCore(
  deps: DepsCobro,
  uid: string | undefined,
  data: unknown,
): Promise<ResultadoCobro> {
  if (!uid) throw new HttpsError('unauthenticated', 'Debés iniciar sesión.');
  const { operacionId, ordenIds, formaPago, nota } = validarPeticionCobro(data);

  return deps.transaction(async (tx) => {
    // ── LECTURAS (todas antes de cualquier escritura) ─────────────────────────
    const rol = exigirStaffCobros(await tx.getUsuario(uid));

    // Idempotencia: PRIMERO, antes de cualquier guard del estado actual.
    const op = await tx.getOperacion(idOperacionCobro(operacionId));
    if (op) {
      const previas: string[] = Array.isArray(op.ordenIds) ? op.ordenIds : [];
      if (previas.length !== ordenIds.length || !ordenIds.every((id) => previas.includes(id)) || op.formaPago !== formaPago) {
        throw rechazoCobro('operacion_inconsistente', 'Esa operación ya se usó con otras órdenes u otra forma de pago.');
      }
      const mov = (op.movimientoIds && typeof op.movimientoIds === 'object' ? op.movimientoIds : {}) as Record<string, string>;
      const dep = (op.depositoIds && typeof op.depositoIds === 'object' ? op.depositoIds : {}) as Record<string, string>;
      return {
        ok: true as const, resultado: 'ya_registrado' as const, operacionId, ordenIds, formaPago,
        total: esNumeroFinito(op.total) ? op.total : 0,
        movimientoIds: ordenIds.map((id) => mov[id]).filter(Boolean),
        depositoIds: ordenIds.map((id) => dep[id]).filter(Boolean),
      };
    }

    const evaluadas: OrdenEvaluada[] = [];
    for (const ordenId of ordenIds) {
      const orden = await tx.getSolicitud(ordenId);
      const movimientos = await tx.getMovimientosDeSolicitud(ordenId);
      evaluadas.push(evaluarOrdenParaCobro(ordenId, orden, movimientos, formaPago));
    }

    // ── ESCRITURAS (todas dentro de esta transacción) ─────────────────────────
    const ahora = deps.serverTimestamp();
    const movimientoIds: Record<string, string> = {};
    const depositoIds: Record<string, string> = {};
    let total = 0;

    for (const e of evaluadas) {
      const { ordenId, orden, monto } = e;
      const movId = idMovimientoCobro(operacionId, ordenId);
      movimientoIds[ordenId] = movId;
      total = Math.round((total + monto) * 100) / 100;

      const calc = calcularMontoCobroDelivery(orden);
      const patch: DocumentData = {
        'cobroDelivery.estado': 'pagado',
        'cobroDelivery.pagadoAt': ahora,
        'cobroDelivery.formaPago': formaPago,
        'cobroDelivery.confirmadoPor': uid,
        'cobroDelivery.confirmadoAt': ahora,
        'cobroDelivery.metodoPagoReal': formaPago === 'efectivo' ? 'efectivo' : 'transferencia_deposito',
        'cobroDelivery.movimientoPagoId': movId,
        updatedAt: ahora,
      };
      if (nota) patch['cobroDelivery.notaPago'] = nota;
      // Orden sin monto guardado (legacy, o clasificada por Cobros): el servidor lo fija con el recalculado.
      if (!e.cdExiste || !esNumeroFinito(orden.cobroDelivery?.monto)) {
        patch['cobroDelivery.monto'] = monto;
        patch['cobroDelivery.tipoCliente'] = 'contado';
        patch['cobroDelivery.quienPaga'] = calc.quienPaga;
        if (!e.cdExiste) patch['cobroDelivery.registradoAt'] = ahora;
      }

      if (formaPago === 'transferencia') {
        const depId = idDepositoCobro(operacionId, ordenId);
        depositoIds[ordenId] = depId;
        patch['registro.deposito.confirmadoStorkhub'] = true;
        patch['registro.deposito.confirmadoStorkhubAt'] = ahora;
        patch['registro.deposito.storkhubDepositoId'] = depId;
        tx.crearDeposito(depId, {
          creadoAt: ahora,
          tipo: TIPO_DEPOSITO_PAGO_COBRO,
          estado: 'confirmado',
          destinatario: 'storkhub',
          destinatarioId: 'storkhub',
          destinatarioNombre: 'Storkhub',
          cuentasDestino: [],
          motorizadoUid: orden.asignacion?.motorizadoId ?? '',
          motorizadoNombre: orden.asignacion?.motorizadoNombre ?? '',
          solicitudIds: [ordenId],
          montoTotal: monto,
          boucherUrl: e.boucherUrl,
          metadata: { clienteNombre: e.nombre, referencia: nota, operacionId },
          confirmadoPorUid: uid,
          confirmadoAt: ahora,
        });
      }

      tx.updateSolicitud(ordenId, patch);
      tx.crearMovimiento(movId, {
        tipo: TIPO_MOVIMIENTO_PAGO,
        monto,
        at: ahora,
        creadoPorUid: uid,
        creadoPorRol: rol,
        descripcion: formaPago === 'transferencia'
          ? `Pago delivery por transferencia confirmado · ${e.nombre}`
          : `Pago contado confirmado · ${e.nombre} · efectivo`,
        estado: 'activo',
        solicitudId: ordenId,
        ...(formaPago === 'transferencia' ? { depositoId: depositoIds[ordenId] } : {}),
        metadata: { operacionId, formaPago },
      });
    }

    tx.crearOperacion(idOperacionCobro(operacionId), {
      tipo: 'cobro_delivery', ordenIds, formaPago, total, movimientoIds, depositoIds, actorUid: uid, actorRol: rol, at: ahora,
    });

    return {
      ok: true as const, resultado: 'registrado' as const, operacionId, ordenIds, formaPago, total,
      movimientoIds: ordenIds.map((id) => movimientoIds[id]),
      depositoIds: ordenIds.map((id) => depositoIds[id]).filter(Boolean),
    };
  });
}
