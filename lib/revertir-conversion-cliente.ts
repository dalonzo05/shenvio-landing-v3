import { httpsCallable } from 'firebase/functions'
import { functions } from '@/fb/config'
import type { ResultadoReversionServidor } from './reversion-conversion-ux'

// FIN-4B — el ÚNICO camino del producto para revertir una conversión en deuda.
//
// Manda solo `saldoId` (la identidad del ciclo) y `motivo`: el depósito, el estado, el monto, las órdenes, los
// movimientos y el actor los deriva y demuestra el servidor (functions/src/reversion-conversion.ts). El payload
// se arma campo por campo, sin opcionales. Sin reintentos automáticos: si la respuesta se pierde, el reintento
// es manual y es seguro porque la callable es idempotente (responde 'ya_revertida').
export async function revertirConversionEnDeudaServidor(saldoId: string, motivo: string): Promise<ResultadoReversionServidor> {
  const r = await httpsCallable<{ saldoId: string; motivo: string }, ResultadoReversionServidor>(functions, 'revertirConversionEnDeuda')({ saldoId, motivo })
  return r.data
}
