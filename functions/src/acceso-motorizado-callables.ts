// MOTO-ALTA-AUTH-ROL-1 — Callables del acceso de motorizados.
//
// Solo cablean los puertos reales (Admin SDK) al núcleo de acceso-motorizado.ts,
// donde viven todas las reglas. Mismo criterio que crearAccesoComercio: el
// operador se resuelve server-side desde `usuarios/{uid}` con el uid que salió
// del token, nunca de lo que mande el cliente.

import { onCall, HttpsError } from 'firebase-functions/v2/https';
import * as admin from 'firebase-admin';
import { FieldValue } from 'firebase-admin/firestore';
import {
  crearAcceso,
  repararAcceso,
  diagnosticarAcceso,
  type AccesoDeps,
  type AuthLite,
} from './acceso-motorizado';

function aLite(u: admin.auth.UserRecord): AuthLite {
  return { uid: u.uid, email: u.email ?? null, disabled: u.disabled, emailVerified: u.emailVerified };
}

function esNoEncontrado(e: unknown): boolean {
  return (e as { code?: string })?.code === 'auth/user-not-found';
}

function depsReales(): AccesoDeps {
  const db = admin.firestore();
  const auth = admin.auth();
  return {
    async getUsuario(uid) {
      const snap = await db.collection('usuarios').doc(uid).get();
      return snap.exists ? (snap.data() as Record<string, unknown>) : null;
    },
    async getMotorizado(id) {
      const snap = await db.collection('motorizado').doc(id).get();
      return snap.exists ? (snap.data() as Record<string, unknown>) : null;
    },
    async motorizadosConAuthUid(uid) {
      const snap = await db.collection('motorizado').where('authUid', '==', uid).get();
      return snap.docs.map((d) => d.id);
    },
    async getAuthPorUid(uid) {
      try {
        return aLite(await auth.getUser(uid));
      } catch (e) {
        if (esNoEncontrado(e)) return null;
        throw e;
      }
    },
    async getAuthPorEmail(email) {
      try {
        return aLite(await auth.getUserByEmail(email));
      } catch (e) {
        if (esNoEncontrado(e)) return null;
        throw e;
      }
    },
    // Sin contraseña: el motorizado la define con el enlace de activación.
    async crearAuth(email, displayName) {
      return aLite(await auth.createUser({ email, displayName, disabled: false, emailVerified: false }));
    },
    async actualizarMotorizado(id, patch) {
      await db.collection('motorizado').doc(id).update(patch);
    },
    async escribirUsuario(uid, data) {
      await db.collection('usuarios').doc(uid).set(data, { merge: true });
    },
    ahora: () => FieldValue.serverTimestamp(),
    borrarCampo: () => FieldValue.delete(),
  };
}

function operadorUid(request: { auth?: { uid: string } }): string {
  if (!request.auth) throw new HttpsError('unauthenticated', 'Debés iniciar sesión.');
  return request.auth.uid;
}

/** Alta de acceso: admin o gestor activo. Recibe solo { motorizadoId, email }. */
export const crearAccesoMotorizado = onCall(async (request) => {
  const resultado = await crearAcceso(depsReales(), operadorUid(request), request.data);
  console.log(JSON.stringify({ fn: 'crearAccesoMotorizado', motorizadoId: resultado.motorizadoId, operador: request.auth?.uid, estado: resultado.estado, esNuevoAuthUser: resultado.esNuevoAuthUser }));
  return resultado;
});

/** Reparación de un acceso a medias: SOLO admin activo. Recibe solo { motorizadoId }. */
export const repararAccesoMotorizado = onCall(async (request) => {
  const resultado = await repararAcceso(depsReales(), operadorUid(request), request.data);
  console.log(JSON.stringify({ fn: 'repararAccesoMotorizado', motorizadoId: resultado.motorizadoId, operador: request.auth?.uid, yaReparado: resultado.yaReparado, estado: resultado.estado }));
  return resultado;
});

/** Estado real del acceso, una vez al abrir el detalle: admin o gestor activo. */
export const diagnosticarAccesoMotorizado = onCall(async (request) => {
  return diagnosticarAcceso(depsReales(), operadorUid(request), request.data);
});
