import { httpsCallable } from 'firebase/functions'
import { functions } from '@/fb/config'
import type { ResultadoCobroServidor } from './cobro-acciones-ux'

// FIN-1C-A — el ÚNICO camino del producto para cobrar el delivery de una o varias órdenes (efectivo o transferencia).
//
// Manda solo `operacionId`, `ordenIds`, `formaPago` y la nota: el monto (recalculado desde la orden), el estado, el depósito tipo C,
// el movimiento del ledger, el actor y el rol los deriva y demuestra el servidor (functions/src/registrar-cobro-delivery.ts). Sin
// reintentos automáticos: si la respuesta se pierde, el reintento es manual con el MISMO operacionId y es seguro ('ya_registrado').
export async function registrarCobroDeliveryServidor(
  ordenIds: string[],
  formaPago: 'efectivo' | 'transferencia',
  operacionId: string,
  nota?: string,
): Promise<ResultadoCobroServidor> {
  const payload: { operacionId: string; ordenIds: string[]; formaPago: 'efectivo' | 'transferencia'; nota?: string } = { operacionId, ordenIds, formaPago }
  if (nota && nota.trim()) payload.nota = nota.trim()
  const r = await httpsCallable<typeof payload, ResultadoCobroServidor>(functions, 'registrarCobroDelivery')(payload)
  return r.data
}
