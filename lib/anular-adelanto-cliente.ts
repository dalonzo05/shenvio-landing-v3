import { httpsCallable } from 'firebase/functions'
import { functions } from '@/fb/config'
import type { ResultadoAnularAdelantoServidor } from './finanzas-operativas-ux'

// FIN-1C-B — el ÚNICO camino del producto para anular un adelanto. Manda solo { adelantoId } (el id del movimiento): que sea un adelanto
// coherente y que su semana no esté liquidada lo demuestra el servidor (functions/src/adelantos.ts). Idempotente por estado; nunca reactiva.
export async function anularAdelantoMotorizadoServidor(adelantoId: string): Promise<ResultadoAnularAdelantoServidor> {
  const r = await httpsCallable<{ adelantoId: string }, ResultadoAnularAdelantoServidor>(functions, 'anularAdelantoMotorizado')({ adelantoId })
  return r.data
}
