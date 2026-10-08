import { onCall, HttpsError } from 'firebase-functions/v2/https';
import * as admin from 'firebase-admin';
import { FieldValue } from 'firebase-admin/firestore';
import { revertirCobroDeliveryCore, type DepsReversion } from './revertir-cobro-delivery';
import { lecturasCobroReales } from './cobro-acciones-adapter';

// FIN-1C-A. Mismo rollout que registrarCobroDelivery.

export function depsRealesReversion(db: FirebaseFirestore.Firestore = admin.firestore()): DepsReversion {
  return {
    transaction: (fn) => db.runTransaction(async (tx) => {
      const { lecturas } = lecturasCobroReales(db, tx);
      return fn({
        ...lecturas,
        updateSolicitud: (id, campos) => { tx.update(db.collection('solicitudes_envio').doc(id), campos); },
        updateMovimiento: (id, campos) => { tx.update(db.collection('movimientos_financieros').doc(id), campos); },
        updateDeposito: (id, campos) => { tx.update(db.collection('ordenes_deposito').doc(id), campos); },
        crearOperacion: (id, campos) => { tx.create(db.collection('operaciones_cobro').doc(id), campos); },
      });
    }),
    serverTimestamp: () => FieldValue.serverTimestamp(),
    borrar: () => FieldValue.delete(),
  };
}

/** Observabilidad: orden, actor, resultado y qué se anuló. */
export const revertirCobroDelivery = onCall(async (request) => {
  const uid = request.auth?.uid;
  const ordenId = (request.data as { ordenId?: unknown } | null)?.ordenId;
  try {
    const r = await revertirCobroDeliveryCore(depsRealesReversion(), uid, request.data);
    console.log(JSON.stringify({ fn: 'revertirCobroDelivery', ordenId: r.ordenId, uid, resultado: r.resultado, movimientoId: r.movimientoId, depositoAnuladoId: r.depositoAnuladoId }));
    return r;
  } catch (e) {
    const err = e as { code?: string; details?: { motivo?: string } };
    console.warn(JSON.stringify({ fn: 'revertirCobroDelivery', ordenId: typeof ordenId === 'string' ? ordenId.slice(0, 60) : null, uid: uid ?? null, resultado: 'rechazado', code: err.code ?? 'internal', motivo: err.details?.motivo ?? null }));
    if (e instanceof HttpsError) throw e;
    throw new HttpsError('internal', 'No se pudo revertir el cobro. Verificá el estado de la orden antes de reintentar.');
  }
});
