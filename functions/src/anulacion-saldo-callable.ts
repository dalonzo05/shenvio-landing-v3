import { onCall, HttpsError } from 'firebase-functions/v2/https';
import * as admin from 'firebase-admin';
import { FieldValue } from 'firebase-admin/firestore';
import { anularSaldoCargoCore, type DepsAnulacion } from './anulacion-saldo';

// FIN-1A. Rollout: Function primero, web después. firestore.rules NO cambia (ver condonacion-deuda-callable.ts).

export function depsRealesAnulacion(db: FirebaseFirestore.Firestore = admin.firestore()): DepsAnulacion {
  return {
    transaction: (fn) => db.runTransaction(async (tx) => {
      const leer = async (coleccion: string, id: string) => {
        const snap = await tx.get(db.collection(coleccion).doc(id));
        return snap.exists ? snap.data()! : null;
      };
      return fn({
        getUsuario: (id) => leer('usuarios', id),
        getSaldo: (id) => leer('saldos_cargo_motorizado', id),
        getMovimientosDeSaldo: async (saldoId) => {
          const snap = await tx.get(db.collection('movimientos_financieros').where('saldoId', '==', saldoId));
          return snap.docs.map((d) => ({ id: d.id, data: d.data() }));
        },
        updateSaldo: (id, campos) => { tx.update(db.collection('saldos_cargo_motorizado').doc(id), campos); },
        updateMovimiento: (id, campos) => { tx.update(db.collection('movimientos_financieros').doc(id), campos); },
      });
    }),
    serverTimestamp: () => FieldValue.serverTimestamp(),
  };
}

/** Observabilidad: saldo, actor, resultado y movimiento. Nunca el motivo (texto libre). */
export const anularSaldoCargo = onCall(async (request) => {
  const uid = request.auth?.uid;
  const saldoId = (request.data as { saldoId?: unknown } | null)?.saldoId;
  try {
    const r = await anularSaldoCargoCore(depsRealesAnulacion(), uid, request.data);
    console.log(JSON.stringify({ fn: 'anularSaldoCargo', saldoId: r.saldoId, uid, resultado: r.resultado, movimientoId: r.movimientoId }));
    return r;
  } catch (e) {
    const err = e as { code?: string; details?: { motivo?: string } };
    console.warn(JSON.stringify({ fn: 'anularSaldoCargo', saldoId: typeof saldoId === 'string' ? saldoId.slice(0, 60) : null, uid: uid ?? null, resultado: 'rechazado', code: err.code ?? 'internal', motivo: err.details?.motivo ?? null }));
    if (e instanceof HttpsError) throw e;
    throw new HttpsError('internal', 'No se pudo anular el saldo. Verificá su estado antes de reintentar.');
  }
});
