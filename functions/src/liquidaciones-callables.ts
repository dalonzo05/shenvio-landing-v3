import { onCall } from 'firebase-functions/v2/https';
import * as admin from 'firebase-admin';
import { FieldValue, Timestamp } from 'firebase-admin/firestore';
import { crearLiquidacionMotorizadoCore, type DepsCrearLiquidacion } from './crear-liquidacion';
import { marcarLiquidacionPagadaCore, type DepsPagarLiquidacion } from './pagar-liquidacion';
import { lecturasOperativas } from './finanzas-operativas-adapter';
import { correr } from './finanzas-operativas-callables';

// FIN-1D. Rollout: Functions primero, web después y las Rules que cierran los writers de cliente (liquidaciones, saldos y los tipos de ledger de
// liquidación) al final: la web vieja crea y paga liquidaciones con escrituras de cliente.

const col = (db: FirebaseFirestore.Firestore, c: string, id: string) => db.collection(c).doc(id);

export function depsRealesCrearLiquidacion(db: FirebaseFirestore.Firestore = admin.firestore()): DepsCrearLiquidacion {
  return {
    transaction: (fn) => db.runTransaction(async (tx) => {
      const { leer, igual, contiene, liquidaciones } = lecturasOperativas(db, tx);
      // Consulta de igualdades (mismos filtros que ya usaba la pantalla: no requieren un índice compuesto nuevo).
      const consultar = async (coleccion: string, filtros: Array<[string, string]>) => {
        let q: FirebaseFirestore.Query = db.collection(coleccion);
        for (const [campo, valor] of filtros) q = q.where(campo, '==', valor);
        const snap = await tx.get(q);
        return snap.docs.map((d) => ({ id: d.id, data: d.data() }));
      };
      return fn({
        ...liquidaciones,
        getUsuario: (id) => leer('usuarios', id),
        getMotorizado: (id) => leer('motorizado', id),
        getOperacion: (id) => leer('operaciones_liquidacion', id),
        getOrdenesEntregadasDelMotorizado: (mid) => consultar('solicitudes_envio', [['asignacion.motorizadoId', mid], ['estado', 'entregado']]),
        getDepositosDelMotorizado: (uid) => igual('ordenes_deposito', 'motorizadoUid', uid),
        getGastosAprobadosDelMotorizado: (mid) => consultar('gastos_motorizado', [['motorizadoId', mid], ['estado', 'aprobado']]),
        getAdelantosDelMotorizado: (mid) => consultar('movimientos_financieros', [['tipo', 'adelanto_motorizado'], ['motorizadoId', mid]]),
        getDepositosConGasto: (id) => contiene('ordenes_deposito', 'gastosIds', id),
        getGasto: (id) => leer('gastos_motorizado', id),
        getOrden: (id) => leer('solicitudes_envio', id),
        // Vínculo de un depósito sin solicitudIds: el puntero que dejó en sus órdenes (igualdad sobre un solo campo: no requiere índice compuesto).
        getOrdenesPorPunteroDeposito: (depositoId) => consultar('solicitudes_envio', [['registro.deposito.storkhubDepositoId', depositoId]]),
        getSaldo: (id) => leer('saldos_cargo_motorizado', id),
        // create(): la liquidación, el saldo, los movimientos y el marcador de una operación no pueden existir ya.
        crearLiquidacion: (id, campos) => { tx.create(col(db, 'liquidaciones_motorizado', id), campos); },
        crearOperacion: (id, campos) => { tx.create(col(db, 'operaciones_liquidacion', id), campos); },
        crearSaldo: (id, campos) => { tx.create(col(db, 'saldos_cargo_motorizado', id), campos); },
        crearMovimiento: (id, campos) => { tx.create(col(db, 'movimientos_financieros', id), campos); },
        updateSaldo: (id, campos) => { tx.update(col(db, 'saldos_cargo_motorizado', id), campos); },
        marcarGastoLiquidado: (id, liquidacionId) => { tx.update(col(db, 'gastos_motorizado', id), { liquidacionId }); },
      });
    }),
    serverTimestamp: () => FieldValue.serverTimestamp(),
    aTimestamp: (d) => Timestamp.fromDate(d),
    arrayUnion: (item) => FieldValue.arrayUnion(item),
    ahora: () => new Date(),
  };
}

export function depsRealesPagarLiquidacion(db: FirebaseFirestore.Firestore = admin.firestore()): DepsPagarLiquidacion {
  return {
    transaction: (fn) => db.runTransaction(async (tx) => {
      const { leer } = lecturasOperativas(db, tx);
      return fn({
        getUsuario: (id) => leer('usuarios', id),
        getLiquidacion: (id) => leer('liquidaciones_motorizado', id),
        getOperacion: (id) => leer('operaciones_liquidacion', id),
        getMovimiento: (id) => leer('movimientos_financieros', id),
        updateLiquidacion: (id, campos) => { tx.update(col(db, 'liquidaciones_motorizado', id), campos); },
        crearMovimiento: (id, campos) => { tx.create(col(db, 'movimientos_financieros', id), campos); },
        crearOperacion: (id, campos) => { tx.create(col(db, 'operaciones_liquidacion', id), campos); },
      });
    }),
    serverTimestamp: () => FieldValue.serverTimestamp(),
  };
}

export const crearLiquidacionMotorizado = onCall(async (request) => {
  const uid = request.auth?.uid;
  return correr('crearLiquidacionMotorizado', uid, request.data, () => crearLiquidacionMotorizadoCore(depsRealesCrearLiquidacion(), uid, request.data),
    (r) => ({ resultado: r.resultado, liquidacionId: r.liquidacionId, netoAPagar: r.netoAPagar }), 'No se pudo crear la liquidación. Verificá si quedó registrada antes de reintentar.');
});

export const marcarLiquidacionPagada = onCall(async (request) => {
  const uid = request.auth?.uid;
  return correr('marcarLiquidacionPagada', uid, request.data, () => marcarLiquidacionPagadaCore(depsRealesPagarLiquidacion(), uid, request.data),
    (r) => ({ resultado: r.resultado, liquidacionId: r.liquidacionId, movimientoId: r.movimientoId }), 'No se pudo pagar la liquidación. Verificá su estado antes de reintentar.');
});
