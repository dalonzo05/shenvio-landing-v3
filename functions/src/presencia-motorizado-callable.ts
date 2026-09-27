// MOTO-RANKING-UBICACION-FRESCA-1 — callable de presencia. Cablea Admin SDK al
// núcleo puro de presencia-motorizado.ts, mismo criterio que las callables de
// acceso-motorizado-callables.ts: el operador (acá, el propio motorizado) sale
// del uid del token, nunca de lo que mande el cliente.

import { onCall, HttpsError } from 'firebase-functions/v2/https';
import * as admin from 'firebase-admin';
import { FieldValue } from 'firebase-admin/firestore';
import { actualizarPresenciaMotorizadoCore, type DepsPresencia } from './presencia-motorizado';

function depsReales(): DepsPresencia {
  const db = admin.firestore();
  return {
    async getUsuario(uid) {
      const snap = await db.collection('usuarios').doc(uid).get();
      return snap.exists ? (snap.data() ?? null) : null;
    },
    async motorizadosConAuthUid(uid) {
      const snap = await db.collection('motorizado').where('authUid', '==', uid).get();
      return snap.docs.map((d) => d.id);
    },
    async actualizarPresencia(motorizadoId, estado, ahora) {
      await db.collection('motorizado').doc(motorizadoId).update({
        estado,
        presenciaUpdatedAt: ahora,
        updatedAt: ahora,
      });
    },
  };
}

export const actualizarPresenciaMotorizado = onCall(async (request) => {
  if (!request.auth) throw new HttpsError('unauthenticated', 'Debés iniciar sesión.');
  return actualizarPresenciaMotorizadoCore(depsReales(), request.auth.uid, request.data, FieldValue.serverTimestamp());
});
