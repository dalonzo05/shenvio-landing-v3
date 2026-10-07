import { onCall, HttpsError } from 'firebase-functions/v2/https';
import * as admin from 'firebase-admin';
import { FieldValue } from 'firebase-admin/firestore';
import { condonarDeudaMotorizadoCore, type DepsCondonacion } from './condonacion-deuda';

// FIN-1A. Rollout: Function primero, web después. firestore.rules NO cambia: saldos_cargo_motorizado sigue
// abierta a gestor/admin hasta FIN-1E, porque crearLiquidacion y marcarPagada (FIN-1D) aún escriben saldos
// desde el cliente. Esta autoridad cubre el camino NORMAL del producto, no cierra esos clientes.

export function depsRealesCondonacion(db: FirebaseFirestore.Firestore = admin.firestore()): DepsCondonacion {
  return {
    transaction: (fn) => db.runTransaction(async (tx) => {
      const leer = async (coleccion: string, id: string) => {
        const snap = await tx.get(db.collection(coleccion).doc(id));
        return snap.exists ? snap.data()! : null;
      };
      return fn({
        getUsuario: (id) => leer('usuarios', id),
        getSaldo: (id) => leer('saldos_cargo_motorizado', id),
        getDeposito: (id) => leer('ordenes_deposito', id),
        getMovimientosDeSaldo: async (saldoId) => {
          const snap = await tx.get(db.collection('movimientos_financieros').where('saldoId', '==', saldoId));
          return snap.docs.map((d) => ({ id: d.id, data: d.data() }));
        },
        updateSaldo: (id, campos) => { tx.update(db.collection('saldos_cargo_motorizado').doc(id), campos); },
        updateDeposito: (id, campos) => { tx.update(db.collection('ordenes_deposito').doc(id), campos); },
        // create(): la condonación de un saldo no puede existir ya.
        crearMovimiento: (id, campos) => { tx.create(db.collection('movimientos_financieros').doc(id), campos); },
      });
    }),
    serverTimestamp: () => FieldValue.serverTimestamp(),
  };
}

/** Observabilidad: saldo, depósito, actor, resultado y monto. Nunca el motivo (texto libre). */
export const condonarDeudaMotorizado = onCall(async (request) => {
  const uid = request.auth?.uid;
  const saldoId = (request.data as { saldoId?: unknown } | null)?.saldoId;
  try {
    const r = await condonarDeudaMotorizadoCore(depsRealesCondonacion(), uid, request.data);
    console.log(JSON.stringify({ fn: 'condonarDeudaMotorizado', saldoId: r.saldoId, depositoId: r.depositoId, uid, resultado: r.resultado, movimientoId: r.movimientoId, monto: r.montoCondonado }));
    return r;
  } catch (e) {
    const err = e as { code?: string; details?: { motivo?: string } };
    console.warn(JSON.stringify({ fn: 'condonarDeudaMotorizado', saldoId: typeof saldoId === 'string' ? saldoId.slice(0, 60) : null, uid: uid ?? null, resultado: 'rechazado', code: err.code ?? 'internal', motivo: err.details?.motivo ?? null }));
    if (e instanceof HttpsError) throw e;
    throw new HttpsError('internal', 'No se pudo condonar la deuda. Verificá el estado del saldo antes de reintentar.');
  }
});
