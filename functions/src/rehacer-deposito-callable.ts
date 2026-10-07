import { onCall, HttpsError } from 'firebase-functions/v2/https';
import * as admin from 'firebase-admin';
import { FieldValue } from 'firebase-admin/firestore';
import { rehacerDepositoCore, type DepsRehacer } from './rehacer-deposito';
import { lecturasReales } from './deposito-acciones-adapter';

// FIN-1B. Rollout: Function primero, web después y las Rules de ordenes_deposito al final (la web vieja rehacía con un
// writeBatch de cliente; las Rules que lo cierran solo se despliegan cuando la web nueva ya llama a esta callable).

export function depsRealesRehacer(db: FirebaseFirestore.Firestore = admin.firestore()): DepsRehacer {
  return {
    transaction: (fn) => db.runTransaction(async (tx) => {
      const { lecturas, leer } = lecturasReales(db, tx);
      return fn({
        ...lecturas,
        getOperacion: (id) => leer('operaciones_deposito', id),
        updateDeposito: (id, campos) => { tx.update(db.collection('ordenes_deposito').doc(id), campos); },
        // create(): el evento y el marcador de una operación no pueden existir ya.
        crearEvento: (depositoId, eventoId, campos) => { tx.create(db.collection('ordenes_deposito').doc(depositoId).collection('eventos').doc(eventoId), campos); },
        updateSolicitud: (id, campos) => { tx.update(db.collection('solicitudes_envio').doc(id), campos); },
        updateMovimiento: (id, campos) => { tx.update(db.collection('movimientos_financieros').doc(id), campos); },
        crearOperacion: (id, campos) => { tx.create(db.collection('operaciones_deposito').doc(id), campos); },
      });
    }),
    serverTimestamp: () => FieldValue.serverTimestamp(),
  };
}

/** Observabilidad: depósito, actor, resultado y estados. Nunca el motivo (texto libre). */
export const rehacerDeposito = onCall(async (request) => {
  const uid = request.auth?.uid;
  const depositoId = (request.data as { depositoId?: unknown } | null)?.depositoId;
  try {
    const r = await rehacerDepositoCore(depsRealesRehacer(), uid, request.data);
    console.log(JSON.stringify({ fn: 'rehacerDeposito', depositoId: r.depositoId, uid, resultado: r.resultado, estadoDestino: r.estadoDestino, movimientoId: r.movimientoId }));
    return r;
  } catch (e) {
    const err = e as { code?: string; details?: { motivo?: string } };
    console.warn(JSON.stringify({ fn: 'rehacerDeposito', depositoId: typeof depositoId === 'string' ? depositoId.slice(0, 60) : null, uid: uid ?? null, resultado: 'rechazado', code: err.code ?? 'internal', motivo: err.details?.motivo ?? null }));
    if (e instanceof HttpsError) throw e;
    throw new HttpsError('internal', 'No se pudo rehacer el depósito. Verificá su estado antes de reintentar.');
  }
});
