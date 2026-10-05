import { httpsCallable } from 'firebase/functions'
import { functions } from '@/fb/config'
import type { ResultadoConfirmacionServidor } from './confirmacion-deposito-ux'

// FIN-3 — el ÚNICO camino del producto para confirmar un depósito A/B.
//
// Manda solo el id: el monto, las órdenes, los gastos, el estado y el actor los
// resuelve y demuestra el servidor (functions/src/confirmacion-deposito.ts). Sin
// reintentos automáticos: si la respuesta se pierde, el reintento es manual y es
// seguro porque la callable es idempotente (responde 'ya_confirmado').
export async function confirmarDepositoServidor(depositoId: string): Promise<ResultadoConfirmacionServidor> {
  const r = await httpsCallable<{ depositoId: string }, ResultadoConfirmacionServidor>(functions, 'confirmarDeposito')({ depositoId })
  return r.data
}
