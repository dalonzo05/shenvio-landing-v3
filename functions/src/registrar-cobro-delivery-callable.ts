import { onCall, HttpsError } from 'firebase-functions/v2/https';
import * as admin from 'firebase-admin';
import { FieldValue } from 'firebase-admin/firestore';
import { registrarCobroDeliveryCore, type DepsCobro } from './registrar-cobro-delivery';
import { lecturasCobroReales } from './cobro-acciones-adapter';

// FIN-1C-A. Rollout: Function primero, web después y las Rules que cierran los writers de cobro al final (la web vieja cobraba con
// una runTransaction de cliente; las Rules nuevas solo se despliegan cuando la web nueva ya llama a esta callable).

export function depsRealesCobro(db: FirebaseFirestore.Firestore = admin.firestore()): DepsCobro {
  return {
    transaction: (fn) => db.runTransaction(async (tx) => {
      const { lecturas } = lecturasCobroReales(db, tx);
      return fn({
        ...lecturas,
        updateSolicitud: (id, campos) => { tx.update(db.collection('solicitudes_envio').doc(id), campos); },
        // create(): el movimiento, el depósito y el marcador de una operación no pueden existir ya.
        crearMovimiento: (id, campos) => { tx.create(db.collection('movimientos_financieros').doc(id), campos); },
        crearDeposito: (id, campos) => { tx.create(db.collection('ordenes_deposito').doc(id), campos); },
        crearOperacion: (id, campos) => { tx.create(db.collection('operaciones_cobro').doc(id), campos); },
      });
    }),
    serverTimestamp: () => FieldValue.serverTimestamp(),
  };
}

/** Observabilidad: actor, forma de pago, cantidad y total. Nunca la nota (texto libre) ni datos del cliente. */
export const registrarCobroDelivery = onCall(async (request) => {
  const uid = request.auth?.uid;
  try {
    const r = await registrarCobroDeliveryCore(depsRealesCobro(), uid, request.data);
    console.log(JSON.stringify({ fn: 'registrarCobroDelivery', uid, resultado: r.resultado, formaPago: r.formaPago, ordenes: r.ordenIds.length, total: r.total }));
    return r;
  } catch (e) {
    const err = e as { code?: string; details?: { motivo?: string } };
    console.warn(JSON.stringify({ fn: 'registrarCobroDelivery', uid: uid ?? null, resultado: 'rechazado', code: err.code ?? 'internal', motivo: err.details?.motivo ?? null }));
    if (e instanceof HttpsError) throw e;
    throw new HttpsError('internal', 'No se pudo registrar el cobro. Verificá el estado de la orden antes de reintentar.');
  }
});
