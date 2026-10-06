import { httpsCallable } from 'firebase/functions'
import { functions } from '@/fb/config'
import type { ResultadoAbonoServidor } from './abono-directo-ux'
import type { MetodoAbono } from './financial-types'

// FIN-4C — el ÚNICO camino del producto para registrar un abono directo.
//
// Manda la INTENCIÓN (saldo, monto, operación, método, nota y comprobante): el servidor
// valida el monto contra el saldo real, deriva el actor, el rol y la cuenta, y escribe saldo
// y ledger en una transacción. Sin reintentos automáticos: si la respuesta se pierde, el
// reintento es manual, con el MISMO operacionId, y es seguro porque la callable es
// idempotente (responde 'ya_aplicado').
export interface PeticionAbonoCliente {
  saldoId: string
  monto: number
  operacionId: string
  metodoAbono: MetodoAbono
  nota?: string
  comprobanteUrl?: string
  comprobantePath?: string
}

export async function registrarAbonoDirectoServidor(p: PeticionAbonoCliente): Promise<ResultadoAbonoServidor> {
  const r = await httpsCallable<PeticionAbonoCliente, ResultadoAbonoServidor>(functions, 'registrarAbonoDirecto')(p)
  return r.data
}
