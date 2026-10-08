import { httpsCallable } from 'firebase/functions'
import { functions } from '@/fb/config'
import type { ResultadoCrearGastoServidor } from './finanzas-operativas-ux'

// FIN-1C-B — el ÚNICO camino del producto para crear un gasto de motorizado.
//
// Manda solo lo que el gestor escribe (motorizado, tipo, monto, fecha, nota, orden) más el operacionId: el estado, el actor y su rol, el snapshot
// de la orden y el movimiento del ledger los deriva el servidor (functions/src/crear-gasto.ts). Sin reintentos automáticos: el reintento manual
// con el MISMO operacionId es seguro ('ya_registrado').
export interface DatosGasto { motorizadoId: string; tipo: string; monto: number; fecha?: string; nota?: string; ordenId?: string }

export async function crearGastoMotorizadoServidor(datos: DatosGasto, operacionId: string): Promise<ResultadoCrearGastoServidor> {
  const payload: { operacionId: string } & DatosGasto = { operacionId, motorizadoId: datos.motorizadoId, tipo: datos.tipo, monto: datos.monto }
  if (datos.fecha) payload.fecha = datos.fecha
  if (datos.nota && datos.nota.trim()) payload.nota = datos.nota.trim()
  if (datos.ordenId) payload.ordenId = datos.ordenId
  const r = await httpsCallable<typeof payload, ResultadoCrearGastoServidor>(functions, 'crearGastoMotorizado')(payload)
  return r.data
}
