import { httpsCallable } from 'firebase/functions'
import { functions } from '@/fb/config'
import type { ResultadoPagoSemanalServidor } from './cobro-acciones-ux'

// FIN-1C-A — el ÚNICO camino del producto para registrar un pago de un cobro de crédito semanal.
//
// Manda solo `pagoId`, `cobroSemanalId`, `monto` y la nota: el saldo, el nuevo total pagado, el estado, el historial de pagos y el
// movimiento del ledger los calcula el servidor (functions/src/registrar-pago-cobro-semanal.ts). El `pagoId` identifica el intento: el
// reintento con el MISMO pagoId es seguro ('ya_registrado').
export async function registrarPagoCobroSemanalServidor(
  cobroSemanalId: string,
  monto: number,
  pagoId: string,
  nota?: string,
): Promise<ResultadoPagoSemanalServidor> {
  const payload: { pagoId: string; cobroSemanalId: string; monto: number; nota?: string } = { pagoId, cobroSemanalId, monto }
  if (nota && nota.trim()) payload.nota = nota.trim()
  const r = await httpsCallable<typeof payload, ResultadoPagoSemanalServidor>(functions, 'registrarPagoCobroSemanal')(payload)
  return r.data
}
