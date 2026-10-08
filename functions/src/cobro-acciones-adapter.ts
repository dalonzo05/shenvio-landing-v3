// FIN-1C-A — lecturas de Firestore compartidas por las callables de cobro (Admin SDK, dentro de UNA transacción).
import type { Transaction } from 'firebase-admin/firestore';
import type { LecturasCobro } from './cobro-acciones-comun';

export function lecturasCobroReales(db: FirebaseFirestore.Firestore, tx: Transaction) {
  const leer = async (coleccion: string, id: string) => {
    const snap = await tx.get(db.collection(coleccion).doc(id));
    return snap.exists ? snap.data()! : null;
  };
  const lecturas: LecturasCobro = {
    getUsuario: (id) => leer('usuarios', id),
    getSolicitud: (id) => leer('solicitudes_envio', id),
    getMovimiento: (id) => leer('movimientos_financieros', id),
    getDeposito: (id) => leer('ordenes_deposito', id),
    getOperacion: (id) => leer('operaciones_cobro', id),
    getMovimientosDeSolicitud: async (solicitudId) => {
      const snap = await tx.get(db.collection('movimientos_financieros').where('solicitudId', '==', solicitudId));
      return snap.docs.map((d) => ({ id: d.id, data: d.data() }));
    },
  };
  return { lecturas, leer };
}
