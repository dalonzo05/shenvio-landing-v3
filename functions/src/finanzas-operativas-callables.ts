import { onCall, HttpsError } from 'firebase-functions/v2/https';
import * as admin from 'firebase-admin';
import { FieldValue, Timestamp } from 'firebase-admin/firestore';
import { crearGastoMotorizadoCore, type DepsCrearGasto } from './crear-gasto';
import { anularGastoMotorizadoCore, type DepsAnularGasto } from './anular-gasto';
import { registrarAdelantoMotorizadoCore, anularAdelantoMotorizadoCore, type DepsRegistrarAdelanto, type DepsAnularAdelanto } from './adelantos';
import { resolverIncidenciaCobroCore, type DepsResolver } from './resolver-incidencia-cobro';
import { lecturasOperativas } from './finanzas-operativas-adapter';

// FIN-1C-B. Rollout: Functions primero, web después y las Rules que cierran los writers de cliente al final (la web vieja crea gastos, registra
// adelantos y resuelve incidencias con escrituras de cliente; las Rules nuevas solo se despliegan cuando la web nueva ya llama a estas callables).

const col = (db: FirebaseFirestore.Firestore, c: string, id: string) => db.collection(c).doc(id);

export function depsRealesCrearGasto(db: FirebaseFirestore.Firestore = admin.firestore()): DepsCrearGasto {
  return {
    transaction: (fn) => db.runTransaction(async (tx) => {
      const { leer } = lecturasOperativas(db, tx);
      return fn({
        getUsuario: (id) => leer('usuarios', id),
        getMotorizado: (id) => leer('motorizado', id),
        getOrden: (id) => leer('solicitudes_envio', id),
        getOperacion: (id) => leer('operaciones_gasto', id),
        // create(): el gasto, su movimiento y el marcador de una operación no pueden existir ya.
        crearGasto: (id, campos) => { tx.create(col(db, 'gastos_motorizado', id), campos); },
        crearMovimiento: (id, campos) => { tx.create(col(db, 'movimientos_financieros', id), campos); },
        crearOperacion: (id, campos) => { tx.create(col(db, 'operaciones_gasto', id), campos); },
      });
    }),
    serverTimestamp: () => FieldValue.serverTimestamp(),
    aTimestamp: (d) => Timestamp.fromDate(d),
    ahora: () => new Date(),
  };
}

export function depsRealesAnularGasto(db: FirebaseFirestore.Firestore = admin.firestore()): DepsAnularGasto {
  return {
    transaction: (fn) => db.runTransaction(async (tx) => {
      const { leer, igual, contiene } = lecturasOperativas(db, tx);
      return fn({
        getUsuario: (id) => leer('usuarios', id),
        getGasto: (id) => leer('gastos_motorizado', id),
        getDeposito: (id) => leer('ordenes_deposito', id),
        getDepositosConGasto: (id) => contiene('ordenes_deposito', 'gastosIds', id),
        getLiquidacionesConGasto: (id) => contiene('liquidaciones_motorizado', 'gastosIds', id),
        getMovimientosDeGasto: (id) => igual('movimientos_financieros', 'gastoId', id),
        updateGasto: (id, campos) => { tx.update(col(db, 'gastos_motorizado', id), campos); },
        updateMovimiento: (id, campos) => { tx.update(col(db, 'movimientos_financieros', id), campos); },
      });
    }),
    serverTimestamp: () => FieldValue.serverTimestamp(),
  };
}

export function depsRealesRegistrarAdelanto(db: FirebaseFirestore.Firestore = admin.firestore()): DepsRegistrarAdelanto {
  return {
    transaction: (fn) => db.runTransaction(async (tx) => {
      const { leer, liquidaciones } = lecturasOperativas(db, tx);
      return fn({
        ...liquidaciones,
        getUsuario: (id) => leer('usuarios', id),
        getMotorizado: (id) => leer('motorizado', id),
        getOperacion: (id) => leer('operaciones_adelanto', id),
        crearMovimiento: (id, campos) => { tx.create(col(db, 'movimientos_financieros', id), campos); },
        crearOperacion: (id, campos) => { tx.create(col(db, 'operaciones_adelanto', id), campos); },
      });
    }),
    serverTimestamp: () => FieldValue.serverTimestamp(),
    ahora: () => new Date(),
  };
}

export function depsRealesAnularAdelanto(db: FirebaseFirestore.Firestore = admin.firestore()): DepsAnularAdelanto {
  return {
    transaction: (fn) => db.runTransaction(async (tx) => {
      const { leer, liquidaciones } = lecturasOperativas(db, tx);
      return fn({
        ...liquidaciones,
        getUsuario: (id) => leer('usuarios', id),
        getMovimiento: (id) => leer('movimientos_financieros', id),
        getMotorizado: (id) => leer('motorizado', id),
        updateMovimiento: (id, campos) => { tx.update(col(db, 'movimientos_financieros', id), campos); },
      });
    }),
    serverTimestamp: () => FieldValue.serverTimestamp(),
  };
}

export function depsRealesResolver(db: FirebaseFirestore.Firestore = admin.firestore()): DepsResolver {
  return {
    transaction: (fn) => db.runTransaction(async (tx) => {
      const { leer } = lecturasOperativas(db, tx);
      return fn({
        getUsuario: (id) => leer('usuarios', id),
        getOrden: (id) => leer('solicitudes_envio', id),
        updateOrden: (id, campos) => { tx.update(col(db, 'solicitudes_envio', id), campos); },
      });
    }),
    serverTimestamp: () => FieldValue.serverTimestamp(),
  };
}

/** Envoltorio común: log sin datos libres (nunca la nota) y errores tipados. */
async function correr<T extends object>(fn: string, uid: string | undefined, data: unknown, run: () => Promise<T>, resumen: (r: T) => Record<string, unknown>, mensajeInterno: string): Promise<T> {
  try {
    const r = await run();
    console.log(JSON.stringify({ fn, uid, ...resumen(r) }));
    return r;
  } catch (e) {
    const err = e as { code?: string; details?: { motivo?: string } };
    console.warn(JSON.stringify({ fn, uid: uid ?? null, resultado: 'rechazado', code: err.code ?? 'internal', motivo: err.details?.motivo ?? null }));
    if (e instanceof HttpsError) throw e;
    throw new HttpsError('internal', mensajeInterno);
  }
}

export const crearGastoMotorizado = onCall(async (request) => {
  const uid = request.auth?.uid;
  return correr('crearGastoMotorizado', uid, request.data, () => crearGastoMotorizadoCore(depsRealesCrearGasto(), uid, request.data),
    (r) => ({ resultado: r.resultado, gastoId: r.gastoId }), 'No se pudo crear el gasto. Verificá si quedó registrado antes de reintentar.');
});

export const anularGastoMotorizado = onCall(async (request) => {
  const uid = request.auth?.uid;
  return correr('anularGastoMotorizado', uid, request.data, () => anularGastoMotorizadoCore(depsRealesAnularGasto(), uid, request.data),
    (r) => ({ resultado: r.resultado, gastoId: r.gastoId, movimientoId: r.movimientoId }), 'No se pudo anular el gasto. Verificá su estado antes de reintentar.');
});

export const registrarAdelantoMotorizado = onCall(async (request) => {
  const uid = request.auth?.uid;
  return correr('registrarAdelantoMotorizado', uid, request.data, () => registrarAdelantoMotorizadoCore(depsRealesRegistrarAdelanto(), uid, request.data),
    (r) => ({ resultado: r.resultado, adelantoId: r.adelantoId }), 'No se pudo registrar el adelanto. Verificá si quedó registrado antes de reintentar.');
});

export const anularAdelantoMotorizado = onCall(async (request) => {
  const uid = request.auth?.uid;
  return correr('anularAdelantoMotorizado', uid, request.data, () => anularAdelantoMotorizadoCore(depsRealesAnularAdelanto(), uid, request.data),
    (r) => ({ resultado: r.resultado, adelantoId: r.adelantoId }), 'No se pudo anular el adelanto. Verificá su estado antes de reintentar.');
});

export const resolverIncidenciaCobro = onCall(async (request) => {
  const uid = request.auth?.uid;
  return correr('resolverIncidenciaCobro', uid, request.data, () => resolverIncidenciaCobroCore(depsRealesResolver(), uid, request.data),
    (r) => ({ resultado: r.resultado, ordenId: r.ordenId, item: r.item, decision: r.decision }), 'No se pudo resolver la incidencia. Verificá el estado de la orden antes de reintentar.');
});
