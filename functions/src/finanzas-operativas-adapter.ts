// FIN-1C-B — lecturas de Firestore compartidas por las callables de gastos, adelantos y resolución (Admin SDK, dentro de UNA transacción).
import type { Transaction } from 'firebase-admin/firestore';

export function lecturasOperativas(db: FirebaseFirestore.Firestore, tx: Transaction) {
  const leer = async (coleccion: string, id: string) => {
    const snap = await tx.get(db.collection(coleccion).doc(id));
    return snap.exists ? snap.data()! : null;
  };
  const igual = async (coleccion: string, campo: string, valor: string) => {
    const snap = await tx.get(db.collection(coleccion).where(campo, '==', valor));
    return snap.docs.map((d) => ({ id: d.id, data: d.data() }));
  };
  const contiene = async (coleccion: string, campo: string, valor: string) => {
    const snap = await tx.get(db.collection(coleccion).where(campo, 'array-contains', valor));
    return snap.docs.map((d) => ({ id: d.id, data: d.data() }));
  };
  const liquidaciones = {
    getLiquidacion: (id: string) => leer('liquidaciones_motorizado', id),
    // Por motorizadoId Y por motorizadoUid: una liquidación legacy puede traer solo uno de los dos.
    getLiquidacionesDelMotorizado: async (motorizadoId: string, motorizadoUid: string | null) => {
      const porId = await igual('liquidaciones_motorizado', 'motorizadoId', motorizadoId);
      const porUid = motorizadoUid ? await igual('liquidaciones_motorizado', 'motorizadoUid', motorizadoUid) : [];
      const vistos = new Set<string>();
      const unicas: Array<{ id: string; data: FirebaseFirestore.DocumentData }> = [];
      for (const l of [...porId, ...porUid]) {
        if (vistos.has(l.id)) continue;
        vistos.add(l.id);
        unicas.push(l);
      }
      return unicas;
    },
  };
  return { leer, igual, contiene, liquidaciones };
}
