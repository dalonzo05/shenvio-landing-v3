// ═════════════════════════════════════════════════
// resolverIncidenciaCobro — FIN-1C-B: la resolución de una incidencia de Cobros, AUTORITATIVA
// ═════════════════════════════════════════════════
//
// Antes: ResolveModal era un updateDoc de CLIENTE sobre la orden. Escribía la resolución (con resueltoPor y fecha que mandaba el navegador),
// cobroDelivery.estado ('pendiente' / 'no_cobrar') y cobroPendiente. 'se_pierde' en el delivery ES una condonación (la orden sale de Cobros y el
// comercio ve "No se cobra"), y las Rules dejaban hacerla y deshacerla libremente y firmar la resolución como otra persona.
//
// Ahora, con { ordenId, item, decision, nota? } como única entrada y solo para admin o gestor activo, en una transacción sobre la orden:
//   · La orden debe estar entregada y el ítem debe estar ABIERTO (sin clasificar) según la misma lógica de la pantalla. No hay reapertura: la
//     UI nunca ofreció deshacer. Un reintento de la MISMA decisión sobre un ítem ya resuelto responde 'ya_resuelto' sin escribir.
//   · DELIVERY — cliente_pagara: la resolución de la orden y el cobro queda 'pendiente' (se crea sin monto si no existía, como antes; el monto
//     lo fija registrarCobroDelivery al cobrar; un 'no_cobrar' vuelve a 'pendiente'). se_pierde: cobroDelivery.estado = 'no_cobrar' (la
//     condonación del producto), sin saldo, deuda ni movimiento. Nunca sobre un cobro 'pagado' ni en revisión de depósito.
//   · PRODUCTO: solo la clasificación en cobrosMotorizado.producto (resolucion + estado); no toca el cobro del delivery ni el ledger.
//   · cobroPendiente se RECALCULA (queda otro ítem sin clasificar); el cliente no lo manda. Quién resolvió y la fecha son del servidor.
//   · Nunca toca monto, precio, movimientos, depósitos ni saldos.

import { HttpsError } from 'firebase-functions/v2/https';
import type { DocumentData } from 'firebase-admin/firestore';
import {
  deliverySinClasificarOp, exigirStaffFinanzas, productoSinClasificarOp, rechazoOp, validarPeticionResolver, type DecisionResolucion, type ItemResolucion,
} from './finanzas-operativas-comun';

export type ResultadoResolverIncidencia = {
  ok: true;
  resultado: 'resuelto' | 'ya_resuelto';
  ordenId: string;
  item: ItemResolucion;
  decision: DecisionResolucion;
  cobroPendiente: boolean;
};

export interface TxResolver {
  getUsuario(uid: string): Promise<DocumentData | null>;
  getOrden(id: string): Promise<DocumentData | null>;
  updateOrden(id: string, campos: DocumentData): void;
}

export interface DepsResolver {
  transaction<T>(fn: (tx: TxResolver) => Promise<T>): Promise<T>;
  serverTimestamp(): unknown;
}

const ESTADOS_COBRO_CONOCIDOS = ['pendiente', 'pagado', 'no_cobrar', 'en_revision_deposito'];

export async function resolverIncidenciaCobroCore(deps: DepsResolver, uid: string | undefined, data: unknown): Promise<ResultadoResolverIncidencia> {
  if (!uid) throw new HttpsError('unauthenticated', 'Debés iniciar sesión.');
  const { ordenId, item, decision, nota } = validarPeticionResolver(data);

  return deps.transaction(async (tx) => {
    // ── LECTURAS ──────────────────────────────────────────────────────────────
    exigirStaffFinanzas(await tx.getUsuario(uid));
    const orden = await tx.getOrden(ordenId);
    if (!orden) throw new HttpsError('not-found', 'La orden no existe.');
    if (orden.estado !== 'entregado') throw rechazoOp('orden_no_entregada', 'Solo se resuelve la incidencia de una orden entregada.', { solicitudId: ordenId });

    const cd = (orden.cobroDelivery && typeof orden.cobroDelivery === 'object' ? orden.cobroDelivery : null) as DocumentData | null;
    if (cd && !ESTADOS_COBRO_CONOCIDOS.includes(String(cd.estado ?? ''))) {
      throw rechazoOp('conciliacion_requerida', 'El cobro de la orden no está en un estado conocido. No se resuelve: hay que conciliarlo.', { solicitudId: ordenId });
    }

    const abierto = item === 'delivery' ? deliverySinClasificarOp(orden) : productoSinClasificarOp(orden);
    const resolucionActual = item === 'delivery' ? orden.cobrosMotorizado?.resolucion : orden.cobrosMotorizado?.producto?.resolucion;
    if (!abierto) {
      // Retry de la MISMA decisión sobre un ítem ya clasificado: idempotente. Cualquier otra cosa no es una incidencia abierta.
      if (resolucionActual && resolucionActual.tipo === decision) {
        return { ok: true as const, resultado: 'ya_resuelto' as const, ordenId, item, decision, cobroPendiente: orden.cobroPendiente === true };
      }
      throw rechazoOp('incidencia_no_abierta', 'Esa incidencia ya no está abierta (se resolvió o nunca existió).', { solicitudId: ordenId });
    }

    // El delivery toca el cobro: nunca uno pagado ni uno con un comprobante en revisión.
    if (item === 'delivery' && cd) {
      if (cd.estado === 'pagado') throw rechazoOp('cobro_ya_pagado', 'El cobro de la orden ya está pagado: no se resuelve la incidencia.', { solicitudId: ordenId });
      if (decision === 'se_pierde' && cd.estado === 'en_revision_deposito') {
        throw rechazoOp('estado_incompatible', 'El cobro tiene un comprobante en revisión: no se puede marcar como "se pierde".', { solicitudId: ordenId });
      }
    }

    // ── ESCRITURAS ────────────────────────────────────────────────────────────
    const ahora = deps.serverTimestamp();
    const resolucion = { resueltoPor: uid, at: ahora, nota, tipo: decision };
    const patch: DocumentData = { updatedAt: ahora };
    if (item === 'delivery') {
      patch['cobrosMotorizado.resolucion'] = resolucion;
      if (decision === 'cliente_pagara') {
        if (!cd) {
          patch['cobroDelivery.estado'] = 'pendiente';
          patch['cobroDelivery.registradoAt'] = ahora;
        } else if (cd.estado === 'no_cobrar') {
          patch['cobroDelivery.estado'] = 'pendiente';
        }
      } else {
        patch['cobroDelivery.estado'] = 'no_cobrar';
      }
    } else {
      patch['cobrosMotorizado.producto.resolucion'] = resolucion;
      patch['cobrosMotorizado.producto.estado'] = decision === 'cliente_pagara' ? 'pendiente' : 'no_cobrar';
    }
    // cobroPendiente = queda alguna incidencia SIN clasificar (la otra); la que se resuelve ahora ya no cuenta.
    const quedaOtra = item === 'delivery' ? productoSinClasificarOp(orden) : deliverySinClasificarOp(orden);
    patch.cobroPendiente = quedaOtra;
    tx.updateOrden(ordenId, patch);
    return { ok: true as const, resultado: 'resuelto' as const, ordenId, item, decision, cobroPendiente: quedaOtra };
  });
}
