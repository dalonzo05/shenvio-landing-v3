import { onSchedule } from 'firebase-functions/v2/scheduler';
import * as admin from 'firebase-admin';
import { Timestamp } from 'firebase-admin/firestore';

admin.initializeApp();

export { crearAccesoComercio } from './comercio-acceso';
export { acumularCobroSemanalPorOrden } from './cobro-semanal';
export { responderAsignacion, confirmarTransicionConCobro } from './motorizado-transiciones';
export { confirmarPropuestaAbono, rechazarPropuestaAbono } from './propuestas-abono';

/**
 * Daily report (DRY-RUN / LOG-ONLY): lists orders delivered more than 45
 * days ago that still have `evidencias` — no delete, no Firestore write.
 * Runs at 03:00 UTC every day.
 *
 * Storage Cleanup V1: esta Function ya NO borra nada. El delete real
 * (Storage primero, metadata puntual después, con revalidación y auditoría)
 * vive exclusivamente en el mecanismo admin manual —
 * /api/admin/storage-cleanup/scan + /execute, ver lib/storage-cleanup.ts.
 * El comportamiento previo tenía dos defectos: (1) si bucket.file(path)
 * .delete() fallaba, el error se silenciaba con console.warn y el batch
 * borraba `evidencias` completo igual, dejando el archivo huérfano en
 * Storage sin ninguna referencia en Firestore; (2) incluía 'deposito' —el
 * boucher financiero del depósito— en el mismo ciclo que retiro/entrega,
 * violando la exclusión de objetos financieros. Ambos quedan eliminados acá
 * (no corregidos in-place) porque el mecanismo manual ya cubre este
 * namespace de forma segura y con auditoría.
 */
export const limpiarEvidencias = onSchedule(
  { schedule: 'every 24 hours', timeZone: 'UTC' },
  async () => {
    const db = admin.firestore();

    const cutoffDate = new Date(Date.now() - 45 * 24 * 60 * 60 * 1000);
    const cutoff = Timestamp.fromDate(cutoffDate);

    const snap = await db
      .collection('solicitudes_envio')
      .where('entregadoAt', '<', cutoff)
      .where('evidencias', '!=', null)
      .limit(100)
      .get();

    if (snap.empty) {
      console.log('limpiarEvidencias(dry-run): nothing found.');
      return;
    }

    console.log(
      `limpiarEvidencias(dry-run): ${snap.size} orders have evidencias older than 45 days. ` +
        'No delete performed — use /api/admin/storage-cleanup (scan + execute) for real cleanup.',
    );

    for (const docSnap of snap.docs) {
      const ev = (docSnap.data().evidencias ?? {}) as Record<string, { pathStorage?: string }>;
      // 'deposito' excluido a propósito: es el boucher financiero del
      // depósito, no evidencia operativa — nunca debe reportarse acá como
      // candidato de limpieza.
      const tipos = (['retiro', 'entrega'] as const).filter((tipo) => !!ev[tipo]?.pathStorage);
      if (tipos.length > 0) {
        console.log(`limpiarEvidencias(dry-run): ${docSnap.id} -> ${tipos.join(',')}`);
      }
    }
  },
);
