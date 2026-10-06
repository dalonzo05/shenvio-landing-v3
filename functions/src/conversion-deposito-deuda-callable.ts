import { onCall, HttpsError } from 'firebase-functions/v2/https';
import * as admin from 'firebase-admin';
import { FieldValue } from 'firebase-admin/firestore';
import { convertirDepositoEnDeudaCore, type DepsConversion } from './conversion-deposito-deuda';

// FIN-4A. Rollout: Function primero, web después. firestore.rules solo cambia para
// que un depósito convertido no pase a 'anulado' por el writer genérico; FIN-1 (las
// Rules siguen permitiendo al gestor escribir saldos, ledger y depósitos desde un
// cliente modificado) sigue abierto. Esta autoridad cubre el camino NORMAL del
// producto, no cierra esos clientes.

export function depsRealesConversion(db: FirebaseFirestore.Firestore = admin.firestore()): DepsConversion {
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
        getSaldo: (id) => leer('saldos_cargo_motorizado', id),
        getMotorizadoDocId: async (authUid) => {
          const snap = await tx.get(db.collection('motorizado').where('authUid', '==', authUid).limit(1));
          return snap.docs[0]?.id ?? null;
        },
        getSaldosDeDeposito: async (depositoId) => {
          const snap = await tx.get(db.collection('saldos_cargo_motorizado').where('depositoId', '==', depositoId));
          return snap.docs.map((d) => ({ id: d.id, data: d.data() }));
        },
        getMovimientosDeDeposito: async (depositoId) => {
          const snap = await tx.get(db.collection('movimientos_financieros').where('depositoId', '==', depositoId));
          return snap.docs.map((d) => ({ id: d.id, data: d.data() }));
        },
        updateDeposito: (id, campos) => { tx.update(db.collection('ordenes_deposito').doc(id), campos); },
        updateSolicitud: (id, campos) => { tx.update(db.collection('solicitudes_envio').doc(id), campos); },
        // create(): el saldo y el movimiento de un ciclo no pueden existir ya.
        crearSaldo: (id, campos) => { tx.create(db.collection('saldos_cargo_motorizado').doc(id), campos); },
        crearMovimiento: (id, campos) => { tx.create(db.collection('movimientos_financieros').doc(id), campos); },
      });
    }),
    serverTimestamp: () => FieldValue.serverTimestamp(),
    nuevoSaldoId: () => db.collection('saldos_cargo_motorizado').doc().id,
  };
}

/**
 * Observabilidad: depositoId, actor, resultado, estados, saldo y movimiento.
 * Nunca el comprobante, URLs firmadas, tokens ni la nota (texto libre del gestor).
 */
export const convertirDepositoEnDeuda = onCall(async (request) => {
  const uid = request.auth?.uid;
  const depositoId = (request.data as { depositoId?: unknown } | null)?.depositoId;
  try {
    const r = await convertirDepositoEnDeudaCore(depsRealesConversion(), uid, request.data);
    console.log(JSON.stringify({
      fn: 'convertirDepositoEnDeuda', depositoId: r.depositoId, uid, resultado: r.resultado,
      estadoAnterior: r.estadoAnterior, estadoNuevo: r.estadoNuevo,
      saldoId: r.saldoId, movimientoId: r.movimientoId, monto: r.montoTotal,
    }));
    return r;
  } catch (e) {
    const err = e as { code?: string; details?: { motivo?: string } };
    console.warn(JSON.stringify({
      fn: 'convertirDepositoEnDeuda', depositoId: typeof depositoId === 'string' ? depositoId.slice(0, 60) : null, uid: uid ?? null,
      resultado: 'rechazado', code: err.code ?? 'internal', motivo: err.details?.motivo ?? null,
    }));
    if (e instanceof HttpsError) throw e;
    throw new HttpsError('internal', 'No se pudo convertir el depósito en deuda. Verificá su estado antes de reintentar.');
  }
});
