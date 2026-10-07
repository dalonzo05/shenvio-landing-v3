import { onCall, HttpsError } from 'firebase-functions/v2/https';
import * as admin from 'firebase-admin';
import { FieldValue } from 'firebase-admin/firestore';
import { anularDepositoCore, type DepsAnularDeposito } from './anular-deposito';
import { lecturasReales } from './deposito-acciones-adapter';

// FIN-1B. Rollout: Function primero, web después y las Rules de ordenes_deposito al final (ver rehacer-deposito-callable.ts).

export function depsRealesAnularDeposito(db: FirebaseFirestore.Firestore = admin.firestore()): DepsAnularDeposito {
  return {
    transaction: (fn) => db.runTransaction(async (tx) => {
      const { lecturas, consulta } = lecturasReales(db, tx);
      return fn({
        ...lecturas,
        getSaldosDeDeposito: (depositoId) => consulta('saldos_cargo_motorizado', 'depositoId', depositoId),
        updateDeposito: (id, campos) => { tx.update(db.collection('ordenes_deposito').doc(id), campos); },
        // create(): el evento de una anulación no puede existir ya.
        crearEvento: (depositoId, eventoId, campos) => { tx.create(db.collection('ordenes_deposito').doc(depositoId).collection('eventos').doc(eventoId), campos); },
        updateSolicitud: (id, campos) => { tx.update(db.collection('solicitudes_envio').doc(id), campos); },
        updateMovimiento: (id, campos) => { tx.update(db.collection('movimientos_financieros').doc(id), campos); },
        updateGasto: (id, campos) => { tx.update(db.collection('gastos_motorizado').doc(id), campos); },
      });
    }),
    serverTimestamp: () => FieldValue.serverTimestamp(),
    eliminar: () => FieldValue.delete(),
    nuevoEventoId: () => db.collection('ordenes_deposito').doc().id,
  };
}

/** Observabilidad: depósito, actor, resultado y movimiento. Nunca el motivo (texto libre). */
export const anularDeposito = onCall(async (request) => {
  const uid = request.auth?.uid;
  const depositoId = (request.data as { depositoId?: unknown } | null)?.depositoId;
  try {
    const r = await anularDepositoCore(depsRealesAnularDeposito(), uid, request.data);
    console.log(JSON.stringify({ fn: 'anularDeposito', depositoId: r.depositoId, uid, resultado: r.resultado, estadoAnterior: r.estadoAnterior, movimientoId: r.movimientoId, gastosLiberados: r.gastosLiberados }));
    return r;
  } catch (e) {
    const err = e as { code?: string; details?: { motivo?: string } };
    console.warn(JSON.stringify({ fn: 'anularDeposito', depositoId: typeof depositoId === 'string' ? depositoId.slice(0, 60) : null, uid: uid ?? null, resultado: 'rechazado', code: err.code ?? 'internal', motivo: err.details?.motivo ?? null }));
    if (e instanceof HttpsError) throw e;
    throw new HttpsError('internal', 'No se pudo anular el depósito. Verificá su estado antes de reintentar.');
  }
});
