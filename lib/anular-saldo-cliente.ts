import { httpsCallable } from 'firebase/functions'
import { functions } from '@/fb/config'
import type { ResultadoAnulacionServidor } from './saldo-acciones-ux'

// FIN-1A — el ÚNICO camino del producto para anular un saldo.
//
// Manda solo `saldoId` y `motivo`. El servidor decide si el saldo es anulable (solo una deuda manual virgen con su
// movimiento de creación demostrable) y anula saldo y movimiento juntos (functions/src/anulacion-saldo.ts). Sin
// reintentos automáticos: el reintento manual es seguro porque la callable es idempotente (responde 'ya_anulado').
export async function anularSaldoServidor(saldoId: string, motivo: string): Promise<ResultadoAnulacionServidor> {
  const r = await httpsCallable<{ saldoId: string; motivo: string }, ResultadoAnulacionServidor>(functions, 'anularSaldoCargo')({ saldoId, motivo })
  return r.data
}
