import { onCall, HttpsError } from 'firebase-functions/v2/https';
import * as admin from 'firebase-admin';
import { FieldValue, Timestamp } from 'firebase-admin/firestore';
import { registrarPagoCobroSemanalCore, type DepsPagoSemanal } from './registrar-pago-cobro-semanal';
import { lecturasCobroReales } from './cobro-acciones-adapter';

// FIN-1C-A. Mismo rollout que registrarCobroDelivery.

export function depsRealesPagoSemanal(db: FirebaseFirestore.Firestore = admin.firestore()): DepsPagoSemanal {
  return {
    transaction: (fn) => db.runTransaction(async (tx) => {
      const { lecturas, leer } = lecturasCobroReales(db, tx);
      return fn({
        getUsuario: lecturas.getUsuario,
        getMovimiento: lecturas.getMovimiento,
        getOperacion: lecturas.getOperacion,
        getCobroSemanal: (id) => leer('cobros_semanales', id),
        updateCobroSemanal: (id, campos) => { tx.update(db.collection('cobros_semanales').doc(id), campos); },
        crearMovimiento: (id, campos) => { tx.create(db.collection('movimientos_financieros').doc(id), campos); },
        crearOperacion: (id, campos) => { tx.create(db.collection('operaciones_cobro').doc(id), campos); },
      });
    }),
    serverTimestamp: () => FieldValue.serverTimestamp(),
    ahora: () => Timestamp.now(),
  };
}

/** Observabilidad: cobro, actor, resultado y monto. Nunca la nota (puede traer referencias bancarias). */
export const registrarPagoCobroSemanal = onCall(async (request) => {
  const uid = request.auth?.uid;
  const cobroSemanalId = (request.data as { cobroSemanalId?: unknown } | null)?.cobroSemanalId;
  try {
    const r = await registrarPagoCobroSemanalCore(depsRealesPagoSemanal(), uid, request.data);
    console.log(JSON.stringify({ fn: 'registrarPagoCobroSemanal', cobroSemanalId: r.cobroSemanalId, uid, resultado: r.resultado, estado: r.estado, totalPagado: r.totalPagado }));
    return r;
  } catch (e) {
    const err = e as { code?: string; details?: { motivo?: string } };
    console.warn(JSON.stringify({ fn: 'registrarPagoCobroSemanal', cobroSemanalId: typeof cobroSemanalId === 'string' ? cobroSemanalId.slice(0, 80) : null, uid: uid ?? null, resultado: 'rechazado', code: err.code ?? 'internal', motivo: err.details?.motivo ?? null }));
    if (e instanceof HttpsError) throw e;
    throw new HttpsError('internal', 'No se pudo registrar el pago. Verificá el cobro antes de reintentar.');
  }
});
