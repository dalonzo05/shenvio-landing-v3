import { onCall, HttpsError } from 'firebase-functions/v2/https';
import * as admin from 'firebase-admin';
import { FieldValue } from 'firebase-admin/firestore';
import {
  COLECCION_INTENCIONES, COLECCION_PUNTEROS,
  descartarIntencionAbonoCore, obtenerIntencionAbonoCore, prepararAbonoDirectoCore, type DepsIntencion,
} from './abono-intencion';

// FIN-4C (corrección). Las intenciones de abono las administran SOLO estas Functions (Admin SDK):
// firestore.rules no tiene reglas para estas colecciones, así que el cliente no las lee ni las escribe.
// Rollout: Function primero, web después. Rules sin cambios.

export function depsRealesIntencion(db: FirebaseFirestore.Firestore = admin.firestore()): DepsIntencion {
  return {
    transaction: (fn) => db.runTransaction(async (tx) => {
      const leer = async (coleccion: string, id: string) => {
        const snap = await tx.get(db.collection(coleccion).doc(id));
        return snap.exists ? snap.data()! : null;
      };
      return fn({
        getUsuario: (id) => leer('usuarios', id),
        getSaldo: (id) => leer('saldos_cargo_motorizado', id),
        getIntencion: (id) => leer(COLECCION_INTENCIONES, id),
        getPuntero: (id) => leer(COLECCION_PUNTEROS, id),
        // create(): una intención nueva no puede existir ya.
        crearIntencion: (id, campos) => { tx.create(db.collection(COLECCION_INTENCIONES).doc(id), campos); },
        updateIntencion: (id, campos) => { tx.update(db.collection(COLECCION_INTENCIONES).doc(id), campos); },
        setPuntero: (id, campos) => { tx.set(db.collection(COLECCION_PUNTEROS).doc(id), campos); },
      });
    }),
    serverTimestamp: () => FieldValue.serverTimestamp(),
    nuevoId: () => db.collection(COLECCION_INTENCIONES).doc().id,
  };
}

/** Observabilidad: saldoId, operacionId, actor y resultado. Nunca el comprobante, tokens ni la nota. */
async function conLog<T extends { resultado?: string; intencion?: { operacionId?: string } | null }>(
  fn: string, uid: string | undefined, data: unknown, correr: () => Promise<T>,
): Promise<T> {
  const d = data as { saldoId?: unknown; operacionId?: unknown } | null;
  try {
    const r = await correr();
    console.log(JSON.stringify({ fn, uid, saldoId: typeof d?.saldoId === 'string' ? d.saldoId.slice(0, 60) : null, operacionId: r.intencion?.operacionId ?? null, resultado: r.resultado ?? 'ok' }));
    return r;
  } catch (e) {
    const err = e as { code?: string; details?: { motivo?: string } };
    console.warn(JSON.stringify({
      fn, uid: uid ?? null, saldoId: typeof d?.saldoId === 'string' ? d.saldoId.slice(0, 60) : null,
      operacionId: typeof d?.operacionId === 'string' ? d.operacionId.slice(0, 64) : null,
      resultado: 'rechazado', code: err.code ?? 'internal', motivo: err.details?.motivo ?? null,
    }));
    if (e instanceof HttpsError) throw e;
    throw new HttpsError('internal', 'No se pudo completar la operación. Reintentá: es seguro.');
  }
}

export const prepararAbonoDirecto = onCall((request) =>
  conLog('prepararAbonoDirecto', request.auth?.uid, request.data, () => prepararAbonoDirectoCore(depsRealesIntencion(), request.auth?.uid, request.data)));

export const obtenerIntencionAbono = onCall((request) =>
  conLog('obtenerIntencionAbono', request.auth?.uid, request.data, () => obtenerIntencionAbonoCore(depsRealesIntencion(), request.auth?.uid, request.data)));

export const descartarIntencionAbono = onCall((request) =>
  conLog('descartarIntencionAbono', request.auth?.uid, request.data, () => descartarIntencionAbonoCore(depsRealesIntencion(), request.auth?.uid, request.data)));
