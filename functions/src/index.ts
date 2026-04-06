import { onSchedule } from 'firebase-functions/v2/scheduler';
import * as admin from 'firebase-admin';

admin.initializeApp();

/**
 * Daily cleanup: deletes photo evidence from Storage and Firestore
 * for orders delivered more than 45 days ago.
 * Runs at 03:00 UTC every day.
 */
export const limpiarEvidencias = onSchedule(
  { schedule: 'every 24 hours', timeZone: 'UTC' },
  async () => {
    const db = admin.firestore();
    const bucket = admin.storage().bucket();

    const cutoffDate = new Date(Date.now() - 45 * 24 * 60 * 60 * 1000);
    const cutoff = admin.firestore.Timestamp.fromDate(cutoffDate);

    // Query orders older than 45 days that still have evidencias
    const snap = await db
      .collection('solicitudes_envio')
      .where('entregadoAt', '<', cutoff)
      .where('evidencias', '!=', null)
      .limit(100)
      .get();

    if (snap.empty) {
      console.log('limpiarEvidencias: nothing to clean up.');
      return;
    }

    console.log(`limpiarEvidencias: processing ${snap.size} orders.`);

    const batch = db.batch();
    const storageDeletes: Promise<void>[] = [];

    for (const docSnap of snap.docs) {
      const ev = (docSnap.data().evidencias ?? {}) as Record<string, { pathStorage?: string }>;

      for (const tipo of ['retiro', 'entrega', 'deposito'] as const) {
        const path = ev[tipo]?.pathStorage;
        if (path) {
          storageDeletes.push(
            bucket
              .file(path)
              .delete()
              .then(() => console.log(`Deleted storage: ${path}`))
              .catch((err) => console.warn(`Could not delete ${path}:`, err.message)),
          );
        }
      }

      batch.update(docSnap.ref, {
        evidencias: admin.firestore.FieldValue.delete(),
      });
    }

    // Delete files in parallel, then commit Firestore batch
    await Promise.all(storageDeletes);
    await batch.commit();

    console.log(`limpiarEvidencias: cleaned ${snap.size} orders.`);
  },
);
