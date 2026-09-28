import { onCall } from 'firebase-functions/v2/https';
import * as admin from 'firebase-admin';
import { FieldValue } from 'firebase-admin/firestore';
import { asignarMotorizadoCore, type DepsAsignacion } from './asignacion-motorizado';

// Rollout: Function primero, web después. Rules permanecen en HOLD.
// MOTO-ASIGNACION-RULES-CIERRE-1: clientes antiguos aún pueden escribir directo;
// esta autoridad cubre los caminos web migrados, no cierra esos clientes.

function depsReales(): DepsAsignacion {
  const db = admin.firestore();
  return {
    transaction: (fn) => db.runTransaction(async (tx) => {
      const leer = async (coleccion: string, id: string) => {
        const snap = await tx.get(db.collection(coleccion).doc(id));
        return snap.exists ? snap.data()! : null;
      };
      return fn({
        getUsuario: (id) => leer('usuarios', id),
        getSolicitud: (id) => leer('solicitudes_envio', id),
        getMotorizado: (id) => leer('motorizado', id),
        updateSolicitud: (id, patch) => { tx.update(db.collection('solicitudes_envio').doc(id), patch); },
      });
    }),
    serverTimestamp: () => FieldValue.serverTimestamp(),
    ahoraMs: () => Date.now(),
  };
}

export const asignarMotorizado = onCall((request) =>
  asignarMotorizadoCore(depsReales(), request.auth?.uid, request.data));
