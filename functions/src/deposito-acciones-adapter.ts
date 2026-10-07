// FIN-1B — lecturas de Firestore compartidas por rehacerDeposito y anularDeposito (Admin SDK, dentro de UNA transacción).
import type { Transaction } from 'firebase-admin/firestore';
import type { LecturasDepositoAccion } from './deposito-acciones-comun';

export function lecturasReales(db: FirebaseFirestore.Firestore, tx: Transaction) {
  const leer = async (coleccion: string, id: string) => {
    const snap = await tx.get(db.collection(coleccion).doc(id));
    return snap.exists ? snap.data()! : null;
  };
  const consulta = async (coleccion: string, campo: string, valor: string) => {
    const snap = await tx.get(db.collection(coleccion).where(campo, '==', valor));
    return snap.docs.map((d) => ({ id: d.id, data: d.data() }));
  };
  const lecturas: LecturasDepositoAccion = {
    getUsuario: (id) => leer('usuarios', id),
    getDeposito: (id) => leer('ordenes_deposito', id),
    getSolicitud: (id) => leer('solicitudes_envio', id),
    getGasto: (id) => leer('gastos_motorizado', id),
    getMotorizadoDocId: async (authUid) => {
      const snap = await tx.get(db.collection('motorizado').where('authUid', '==', authUid).limit(1));
      return snap.docs[0]?.id ?? null;
    },
    getMovimientosDeDeposito: (depositoId) => consulta('movimientos_financieros', 'depositoId', depositoId),
    // Por authUid Y por doc id: una liquidación legacy puede traer solo uno de los dos.
    getLiquidacionesDelMotorizado: async (motorizadoUid, motorizadoDocId) => {
      const porUid = await consulta('liquidaciones_motorizado', 'motorizadoUid', motorizadoUid);
      const porId = motorizadoDocId === motorizadoUid ? [] : await consulta('liquidaciones_motorizado', 'motorizadoId', motorizadoDocId);
      const vistos = new Set<string>();
      const unicas: Array<{ id: string; data: FirebaseFirestore.DocumentData }> = [];
      for (const l of [...porUid, ...porId]) {
        if (vistos.has(l.id)) continue;
        vistos.add(l.id);
        unicas.push(l);
      }
      return unicas;
    },
  };
  return { lecturas, leer, consulta };
}
