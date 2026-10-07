import { onCall, HttpsError } from 'firebase-functions/v2/https';
import * as admin from 'firebase-admin';
import { FieldValue } from 'firebase-admin/firestore';
import { revertirConversionEnDeudaCore, type DepsReversion } from './reversion-conversion';

// FIN-4B. Rollout: Function primero, web después, y las Rules al final (la web vieja revertía desde el
// cliente; el guard de Rules que cierra esa salida solo se despliega cuando la web nueva ya llama a esta
// callable). FIN-1 (las Rules siguen permitiendo al gestor escribir saldos, ledger y depósitos desde un
// cliente modificado) sigue abierto: esta autoridad cubre el camino NORMAL del producto.

export function depsRealesReversion(db: FirebaseFirestore.Firestore = admin.firestore()): DepsReversion {
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
        getSolicitud: (id) => leer('solicitudes_envio', id),
        getMovimientosDeSaldo: async (saldoId) => {
          const snap = await tx.get(db.collection('movimientos_financieros').where('saldoId', '==', saldoId));
          return snap.docs.map((d) => ({ id: d.id, data: d.data() }));
        },
        updateSaldo: (id, campos) => { tx.update(db.collection('saldos_cargo_motorizado').doc(id), campos); },
        updateMovimiento: (id, campos) => { tx.update(db.collection('movimientos_financieros').doc(id), campos); },
        updateDeposito: (id, campos) => { tx.update(db.collection('ordenes_deposito').doc(id), campos); },
        updateSolicitud: (id, campos) => { tx.update(db.collection('solicitudes_envio').doc(id), campos); },
        // create(): el evento de una reversión no puede existir ya.
        crearEvento: (depositoId, eventoId, campos) => { tx.create(db.collection('ordenes_deposito').doc(depositoId).collection('eventos').doc(eventoId), campos); },
      });
    }),
    serverTimestamp: () => FieldValue.serverTimestamp(),
    eliminar: () => FieldValue.delete(),
    nuevoEventoId: () => db.collection('ordenes_deposito').doc().id,
  };
}

/**
 * Observabilidad: saldoId, depósito, actor, resultado, estado destino y evento.
 * Nunca el motivo (texto libre del gestor) ni el comprobante.
 */
export const revertirConversionEnDeuda = onCall(async (request) => {
  const uid = request.auth?.uid;
  const saldoId = (request.data as { saldoId?: unknown } | null)?.saldoId;
  try {
    const r = await revertirConversionEnDeudaCore(depsRealesReversion(), uid, request.data);
    console.log(JSON.stringify({
      fn: 'revertirConversionEnDeuda', saldoId: r.saldoId, depositoId: r.depositoId, uid, resultado: r.resultado,
      estadoDeposito: r.estadoDeposito, movimientoId: r.movimientoId, eventoId: r.eventoId,
    }));
    return r;
  } catch (e) {
    const err = e as { code?: string; details?: { motivo?: string } };
    console.warn(JSON.stringify({
      fn: 'revertirConversionEnDeuda', saldoId: typeof saldoId === 'string' ? saldoId.slice(0, 60) : null, uid: uid ?? null,
      resultado: 'rechazado', code: err.code ?? 'internal', motivo: err.details?.motivo ?? null,
    }));
    if (e instanceof HttpsError) throw e;
    throw new HttpsError('internal', 'No se pudo revertir la conversión. Verificá el estado del saldo antes de reintentar.');
  }
});
