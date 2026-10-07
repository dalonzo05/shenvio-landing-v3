import { httpsCallable } from 'firebase/functions'
import { functions } from '@/fb/config'
import type { ResultadoRehacerServidor } from './deposito-acciones-ux'

// FIN-1B — el ÚNICO camino del producto para rehacer un depósito confirmado.
//
// Manda solo `depositoId`, `motivo` y `operacionId`: el estado destino (según el boucher real), las órdenes, los movimientos del
// ledger, los gastos, el actor y el rol los deriva y demuestra el servidor (functions/src/rehacer-deposito.ts). Sin reintentos
// automáticos: si la respuesta se pierde, el reintento es manual con el MISMO operacionId y es seguro (responde 'ya_rehecho').
export async function rehacerDepositoServidor(depositoId: string, motivo: string, operacionId: string): Promise<ResultadoRehacerServidor> {
  const r = await httpsCallable<{ depositoId: string; motivo: string; operacionId: string }, ResultadoRehacerServidor>(functions, 'rehacerDeposito')({ depositoId, motivo, operacionId })
  return r.data
}
