import { httpsCallable } from 'firebase/functions'
import { functions } from '@/fb/config'
import type { ResultadoAnularGastoServidor } from './finanzas-operativas-ux'

// FIN-1C-B — el ÚNICO camino del producto para anular un gasto. Manda solo { gastoId }: qué movimiento anular y si el gasto se puede anular
// (no consumido por un depósito ni liquidado) lo demuestra el servidor (functions/src/anular-gasto.ts). Es idempotente por estado.
export async function anularGastoMotorizadoServidor(gastoId: string): Promise<ResultadoAnularGastoServidor> {
  const r = await httpsCallable<{ gastoId: string }, ResultadoAnularGastoServidor>(functions, 'anularGastoMotorizado')({ gastoId })
  return r.data
}
