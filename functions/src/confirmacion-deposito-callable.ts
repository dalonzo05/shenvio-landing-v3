import { onCall, HttpsError } from 'firebase-functions/v2/https';
import * as admin from 'firebase-admin';
import { FieldValue } from 'firebase-admin/firestore';
import { confirmarDepositoCore, type DepsConfirmacion } from './confirmacion-deposito';

// FIN-3. Rollout: Function primero, web después. firestore.rules NO cambia en este
// bloque: mientras FIN-1 siga abierto, un cliente modificado todavía puede intentar
// los writers directos que las Rules permiten a gestor/admin. Esta autoridad cubre el
// camino NORMAL del producto (ambas pantallas de confirmación migran a esta callable),
// no cierra esos clientes.

export function depsRealesConfirmacion(db: FirebaseFirestore.Firestore = admin.firestore()): DepsConfirmacion {
  return {
    transaction: (fn) => db.runTransaction(async (tx) => {
      const leer = async (coleccion: string, id: string) => {
        const snap = await tx.get(db.collection(coleccion).doc(id));
        return snap.exists ? snap.data()! : null;
      };
      return fn({
        getUsuario: (id) => leer('usuarios', id),
        getDeposito: (id) => leer('ordenes_deposito', id),
        getSolicitud: (id) => leer('solicitudes_envio', id),
        getGasto: (id) => leer('gastos_motorizado', id),
        getMotorizadoDocId: async (authUid) => {
          const snap = await tx.get(db.collection('motorizado').where('authUid', '==', authUid).limit(1));
          return snap.docs[0]?.id ?? null;
        },
        getMovimientosDeDeposito: async (depositoId) => {
          const snap = await tx.get(db.collection('movimientos_financieros').where('depositoId', '==', depositoId));
          return snap.docs.map((d) => ({ id: d.id, data: d.data() }));
        },
        updateDeposito: (id, campos) => { tx.update(db.collection('ordenes_deposito').doc(id), campos); },
        // create(): el evento y el movimiento de un ciclo no pueden existir ya.
        crearEvento: (depositoId, eventoId, campos) => {
          tx.create(db.collection('ordenes_deposito').doc(depositoId).collection('eventos').doc(eventoId), campos);
        },
        updateSolicitud: (id, campos) => { tx.update(db.collection('solicitudes_envio').doc(id), campos); },
        crearMovimiento: (id, campos) => { tx.create(db.collection('movimientos_financieros').doc(id), campos); },
      });
    }),
    serverTimestamp: () => FieldValue.serverTimestamp(),
    nuevoEventoId: () => db.collection('ordenes_deposito').doc().id,
  };
}

/**
 * Observabilidad: depositoId, actor, resultado, estados y movimiento. Nunca el
 * contenido del comprobante, URLs firmadas ni tokens.
 */
export const confirmarDeposito = onCall(async (request) => {
  const uid = request.auth?.uid;
  const depositoId = (request.data as { depositoId?: unknown } | null)?.depositoId;
  try {
    const r = await confirmarDepositoCore(depsRealesConfirmacion(), uid, request.data);
    console.log(JSON.stringify({
      fn: 'confirmarDeposito', depositoId: r.depositoId, uid, resultado: r.resultado,
      estadoAnterior: r.estadoAnterior, estadoNuevo: r.estadoNuevo, movimientoId: r.movimientoId,
    }));
    return r;
  } catch (e) {
    const err = e as { code?: string; details?: { motivo?: string } };
    console.warn(JSON.stringify({
      fn: 'confirmarDeposito', depositoId: typeof depositoId === 'string' ? depositoId.slice(0, 60) : null, uid: uid ?? null,
      resultado: 'rechazado', code: err.code ?? 'internal', motivo: err.details?.motivo ?? null,
    }));
    if (e instanceof HttpsError) throw e;
    throw new HttpsError('internal', 'No se pudo confirmar el depósito. Verificá su estado antes de reintentar.');
  }
});
