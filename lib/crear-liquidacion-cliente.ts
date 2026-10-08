import { httpsCallable } from 'firebase/functions'
import { functions } from '@/fb/config'
import type { ResultadoCrearLiquidacionServidor } from './finanzas-operativas-ux'

// FIN-1D — el ÚNICO camino del producto para crear la liquidación semanal de un motorizado.
//
// Manda solo { motorizadoId, semanaKey, operacionId, saldos: [{ saldoId, tope? }] }: la comisión, el efectivo, los depósitos, los gastos, los
// adelantos, las deudas aplicadas, el neto, el saldo que nace de un neto negativo, el ledger, el estado y el actor los deriva el SERVIDOR
// (functions/src/crear-liquidacion.ts) leyendo todo dentro de una transacción. El reintento manual con el MISMO operacionId es seguro ('ya_creada').
export interface SaldoElegido { saldoId: string; tope?: number }

export async function crearLiquidacionMotorizadoServidor(motorizadoId: string, semanaKey: string, operacionId: string, saldos: SaldoElegido[]): Promise<ResultadoCrearLiquidacionServidor> {
  const payload = { motorizadoId, semanaKey, operacionId, saldos }
  const r = await httpsCallable<typeof payload, ResultadoCrearLiquidacionServidor>(functions, 'crearLiquidacionMotorizado')(payload)
  return r.data
}
