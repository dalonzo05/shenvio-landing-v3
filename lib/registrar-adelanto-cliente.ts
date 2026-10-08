import { httpsCallable } from 'firebase/functions'
import { functions } from '@/fb/config'
import type { ResultadoRegistrarAdelantoServidor } from './finanzas-operativas-ux'

// FIN-1C-B — el ÚNICO camino del producto para registrar un adelanto a un motorizado.
//
// Manda solo { operacionId, motorizadoId, monto, semanaKey, nota? }: el tipo de movimiento, las cuentas, el propietario, el estado, el actor y
// su rol los deriva el servidor (functions/src/adelantos.ts), que además rechaza una semana ya liquidada. El reintento manual con el MISMO
// operacionId es seguro ('ya_registrado').
export async function registrarAdelantoMotorizadoServidor(motorizadoId: string, monto: number, semanaKey: string, operacionId: string, nota?: string): Promise<ResultadoRegistrarAdelantoServidor> {
  const payload: { operacionId: string; motorizadoId: string; monto: number; semanaKey: string; nota?: string } = { operacionId, motorizadoId, monto, semanaKey }
  if (nota && nota.trim()) payload.nota = nota.trim()
  const r = await httpsCallable<typeof payload, ResultadoRegistrarAdelantoServidor>(functions, 'registrarAdelantoMotorizado')(payload)
  return r.data
}
