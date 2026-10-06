import { httpsCallable } from 'firebase/functions'
import { functions } from '@/fb/config'
import type { ResultadoConversionServidor } from './conversion-deposito-ux'

// FIN-4A — el ÚNICO camino del producto para convertir un depósito en deuda.
//
// Manda solo el id y la nota (el motivo, que es metadata): el monto, las órdenes,
// los gastos, el estado, el saldo y el actor los resuelve y demuestra el servidor
// (functions/src/conversion-deposito-deuda.ts). Sin reintentos automáticos: si la
// respuesta se pierde, el reintento es manual y es seguro porque la callable es
// idempotente (responde 'ya_convertido').
export async function convertirDepositoEnDeudaServidor(depositoId: string, nota: string): Promise<ResultadoConversionServidor> {
  const r = await httpsCallable<{ depositoId: string; nota: string }, ResultadoConversionServidor>(functions, 'convertirDepositoEnDeuda')({ depositoId, nota })
  return r.data
}
