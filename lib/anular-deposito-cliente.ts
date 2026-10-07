import { httpsCallable } from 'firebase/functions'
import { functions } from '@/fb/config'
import type { ResultadoAnularDepositoServidor } from './deposito-acciones-ux'

// FIN-1B — el ÚNICO camino del producto para anular un depósito.
//
// Manda solo `depositoId` y `motivo`: los movimientos del ledger, las órdenes, los gastos, el actor y el rol los deriva y
// demuestra el servidor (functions/src/anular-deposito.ts). Sin reintentos automáticos: anular es idempotente ('ya_anulado').
export async function anularDepositoServidor(depositoId: string, motivo: string): Promise<ResultadoAnularDepositoServidor> {
  const r = await httpsCallable<{ depositoId: string; motivo: string }, ResultadoAnularDepositoServidor>(functions, 'anularDeposito')({ depositoId, motivo })
  return r.data
}
