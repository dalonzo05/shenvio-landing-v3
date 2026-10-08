import { httpsCallable } from 'firebase/functions'
import { functions } from '@/fb/config'
import type { ResultadoReversionServidor } from './cobro-acciones-ux'

// FIN-1C-A — el ÚNICO camino del producto para revertir un cobro de delivery pagado.
//
// Manda solo `operacionId` y `ordenId`: el movimiento a anular, el DEP tipo C y la liberación de la orden los deriva y demuestra el
// servidor (functions/src/revertir-cobro-delivery.ts). Sin reintentos automáticos: el reintento manual con el MISMO operacionId es
// seguro ('ya_revertido').
export async function revertirCobroDeliveryServidor(ordenId: string, operacionId: string): Promise<ResultadoReversionServidor> {
  const r = await httpsCallable<{ operacionId: string; ordenId: string }, ResultadoReversionServidor>(functions, 'revertirCobroDelivery')({ operacionId, ordenId })
  return r.data
}
