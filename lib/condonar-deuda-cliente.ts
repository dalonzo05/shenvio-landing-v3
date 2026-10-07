import { httpsCallable } from 'firebase/functions'
import { functions } from '@/fb/config'
import type { ResultadoCondonacionServidor } from './saldo-acciones-ux'

// FIN-1A — el ÚNICO camino del producto para condonar una deuda.
//
// Manda solo `saldoId` y `motivo`: el monto condonado (siempre el remanente releído), el motorizado, el depósito,
// el actor y el rol los deriva y demuestra el servidor (functions/src/condonacion-deuda.ts). Sin reintentos
// automáticos: si la respuesta se pierde, el reintento es manual y es seguro porque la callable es idempotente
// (responde 'ya_condonada').
export async function condonarDeudaServidor(saldoId: string, motivo: string): Promise<ResultadoCondonacionServidor> {
  const r = await httpsCallable<{ saldoId: string; motivo: string }, ResultadoCondonacionServidor>(functions, 'condonarDeudaMotorizado')({ saldoId, motivo })
  return r.data
}
