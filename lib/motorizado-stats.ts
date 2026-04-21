// ─── lib/motorizado-stats.ts ──────────────────────────────────────────────────
// Helpers para persistir métricas de desempeño de motorizados en Firestore.
// Cada función actualiza atómicamente los contadores del documento motorizado.
// Nunca lanzan errores — solo loguean en consola si algo falla.
// ─────────────────────────────────────────────────────────────────────────────

import {
  doc,
  runTransaction,
  updateDoc,
  serverTimestamp,
  Timestamp,
} from 'firebase/firestore'
import { db } from '@/fb/config'

// ─── registrarAceptacion ──────────────────────────────────────────────────────

/**
 * Incrementa los contadores de aceptación del motorizado y actualiza
 * la tasa y el tiempo promedio de aceptación.
 *
 * @param motorizadoId  ID del documento en la colección `motorizado`
 * @param asignadoAt    Timestamp en que se asignó la orden (para calcular delta)
 */
export async function registrarAceptacion(
  motorizadoId: string,
  asignadoAt: Timestamp | null
): Promise<void> {
  try {
    const motoRef = doc(db, 'motorizado', motorizadoId)
    await runTransaction(db, async (tx) => {
      const snap = await tx.get(motoRef)
      const data = snap.data() ?? {}

      const totalAceptadas = (data.totalAceptadas ?? 0) + 1
      const totalAsignaciones = (data.totalAsignaciones ?? 0) + 1
      const tasaAceptacion = totalAceptadas / totalAsignaciones

      // Promedio incremental: avg_n = (avg_(n-1) * (n-1) + nuevo) / n
      let tiempoPromedioAceptacion: number | undefined = data.tiempoPromedioAceptacion
      if (asignadoAt) {
        const deltaSegs = (Date.now() - asignadoAt.toMillis()) / 1000
        const prevAvg = data.tiempoPromedioAceptacion ?? deltaSegs
        tiempoPromedioAceptacion = (prevAvg * (totalAceptadas - 1) + deltaSegs) / totalAceptadas
      }

      tx.update(motoRef, {
        totalAceptadas,
        totalAsignaciones,
        tasaAceptacion,
        ...(tiempoPromedioAceptacion !== undefined
          ? { tiempoPromedioAceptacion }
          : {}),
        updatedAt: serverTimestamp(),
      })
    })
  } catch (e) {
    console.error('[motorizado-stats] registrarAceptacion:', e)
  }
}

// ─── registrarRechazo ─────────────────────────────────────────────────────────

/**
 * Incrementa el contador de rechazos del motorizado y recalcula la tasa
 * de aceptación.
 *
 * @param motorizadoId  ID del documento en la colección `motorizado`
 */
export async function registrarRechazo(motorizadoId: string): Promise<void> {
  try {
    const motoRef = doc(db, 'motorizado', motorizadoId)
    await runTransaction(db, async (tx) => {
      const snap = await tx.get(motoRef)
      const data = snap.data() ?? {}

      const totalRechazos = (data.totalRechazos ?? 0) + 1
      const totalAceptadas = data.totalAceptadas ?? 0
      const totalAsignaciones = (data.totalAsignaciones ?? 0) + 1
      const tasaAceptacion = totalAceptadas / totalAsignaciones

      tx.update(motoRef, {
        totalRechazos,
        totalAsignaciones,
        tasaAceptacion,
        updatedAt: serverTimestamp(),
      })
    })
  } catch (e) {
    console.error('[motorizado-stats] registrarRechazo:', e)
  }
}

// ─── actualizarUbicacionOperativa ─────────────────────────────────────────────

/**
 * Persiste la última ubicación operativa del motorizado en Firestore.
 * Se llama al completar un retiro o una entrega para reflejar dónde
 * está operando realmente, en vez de depender solo de la ubicación base.
 *
 * @param motorizadoId  ID del documento en la colección `motorizado`
 * @param coord         Coordenadas { lat, lng }
 */
export async function actualizarUbicacionOperativa(
  motorizadoId: string,
  coord: { lat: number; lng: number }
): Promise<void> {
  try {
    await updateDoc(doc(db, 'motorizado', motorizadoId), {
      ultimaUbicacionOperativa: {
        lat: coord.lat,
        lng: coord.lng,
        timestamp: serverTimestamp(),
      },
      updatedAt: serverTimestamp(),
    })
  } catch (e) {
    console.error('[motorizado-stats] actualizarUbicacionOperativa:', e)
  }
}
