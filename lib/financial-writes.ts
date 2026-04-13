import { addDoc, collection, serverTimestamp } from 'firebase/firestore'
import { db } from '@/fb/config'
import type { MovimientoFinanciero, TipoMovimiento } from './financial-types'

/**
 * Registra un evento financiero en la colección movimientos_financieros.
 * Solo gestor/admin puede leer esta colección (ver firestore.rules).
 *
 * Esta función nunca lanza — los errores se logean en consola sin interrumpir
 * la operación principal del llamador.
 *
 * @returns ID del documento creado, o null si hubo error
 */
export async function registrarMovimiento(
  tipo: TipoMovimiento,
  monto: number,
  operadorId: string,
  descripcion: string,
  refs?: Pick<MovimientoFinanciero, 'solicitudId' | 'depositoId' | 'motorizadoId' | 'comercioId'>,
  metadata?: Record<string, unknown>
): Promise<string | null> {
  try {
    const docRef = await addDoc(collection(db, 'movimientos_financieros'), {
      tipo,
      monto,
      at: serverTimestamp(),
      operadorId,
      descripcion,
      ...(refs ?? {}),
      ...(metadata ? { metadata } : {}),
    } satisfies Omit<MovimientoFinanciero, 'id'>)
    return docRef.id
  } catch (err) {
    console.error('[financial-writes] Error registrando movimiento:', err)
    return null
  }
}
