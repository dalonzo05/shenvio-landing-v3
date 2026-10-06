import { onCall, HttpsError } from 'firebase-functions/v2/https';
import * as admin from 'firebase-admin';
import { FieldValue, Timestamp } from 'firebase-admin/firestore';
import { registrarAbonoDirectoCore, type DepsAbono } from './abono-directo';

// FIN-4C. Rollout: Function primero, web después. firestore.rules NO cambia: mientras
// FIN-1 siga abierto, un cliente modificado todavía puede escribir saldos y ledger.
// Esta autoridad cubre el camino NORMAL del producto (la pantalla de Saldos migra a esta
// callable), no cierra esos clientes.

export function depsRealesAbono(db: FirebaseFirestore.Firestore = admin.firestore()): DepsAbono {
  return {
    transaction: (fn) => db.runTransaction(async (tx) => {
      const leer = async (coleccion: string, id: string) => {
        const snap = await tx.get(db.collection(coleccion).doc(id));
        return snap.exists ? snap.data()! : null;
      };
      return fn({
        getUsuario: (id) => leer('usuarios', id),
        getSaldo: (id) => leer('saldos_cargo_motorizado', id),
        getMovimiento: (id) => leer('movimientos_financieros', id),
        getIntencion: (id) => leer('intenciones_abono_directo', id),
        updateSaldo: (id, campos) => { tx.update(db.collection('saldos_cargo_motorizado').doc(id), campos); },
        // create(): el movimiento de una operación no puede existir ya.
        crearMovimiento: (id, campos) => { tx.create(db.collection('movimientos_financieros').doc(id), campos); },
        // La intención se cierra en la MISMA transacción que el saldo y el ledger.
        updateIntencion: (id, campos) => { tx.update(db.collection('intenciones_abono_directo').doc(id), campos); },
      });
    }),
    serverTimestamp: () => FieldValue.serverTimestamp(),
    // serverTimestamp() no puede ir dentro del objeto de un array: Timestamp.now() (mismo límite que arrayUnion).
    ahora: () => Timestamp.now(),
  };
}

/**
 * Observabilidad: saldoId, operacionId, actor, monto, saldo anterior y nuevo, estados y
 * movimiento. Nunca el comprobante (URL), tokens ni la nota (texto libre).
 */
export const registrarAbonoDirecto = onCall(async (request) => {
  const uid = request.auth?.uid;
  const d = request.data as { saldoId?: unknown; operacionId?: unknown } | null;
  try {
    const r = await registrarAbonoDirectoCore(depsRealesAbono(), uid, request.data);
    console.log(JSON.stringify({
      fn: 'registrarAbonoDirecto', saldoId: r.saldoId, operacionId: r.operacionId, uid, resultado: r.resultado,
      monto: r.monto, saldoAnterior: r.saldoPendienteAnterior, saldoNuevo: r.saldoPendiente,
      estadoAnterior: r.estadoAnterior, estadoNuevo: r.estadoNuevo, movimientoId: r.movimientoId,
    }));
    return r;
  } catch (e) {
    const err = e as { code?: string; details?: { motivo?: string } };
    console.warn(JSON.stringify({
      fn: 'registrarAbonoDirecto', saldoId: typeof d?.saldoId === 'string' ? d.saldoId.slice(0, 60) : null,
      operacionId: typeof d?.operacionId === 'string' ? d.operacionId.slice(0, 64) : null, uid: uid ?? null,
      resultado: 'rechazado', code: err.code ?? 'internal', motivo: err.details?.motivo ?? null,
    }));
    if (e instanceof HttpsError) throw e;
    throw new HttpsError('internal', 'No se pudo registrar el abono. Verificá el saldo antes de reintentar: reintentar es seguro.');
  }
});
