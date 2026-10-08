import { httpsCallable } from 'firebase/functions'
import { functions } from '@/fb/config'
import type { ResultadoPagarLiquidacionServidor } from './finanzas-operativas-ux'

// FIN-1D — el ÚNICO camino del producto para marcar una liquidación como pagada.
//
// Manda solo { liquidacionId, operacionId }: el monto del pago (el neto releído de la liquidación), las cuentas, el estado, el actor y su rol los
// deriva el SERVIDOR (functions/src/pagar-liquidacion.ts) en una transacción. El reintento (doble clic, otra pestaña) responde 'ya_pagada' sin duplicar
// el movimiento. El PDF NO forma parte de esto: lo genera y sube la pantalla después, y solo actualiza pdfUrl/pdfPath/pdfGeneradoAt.
export async function marcarLiquidacionPagadaServidor(liquidacionId: string, operacionId: string): Promise<ResultadoPagarLiquidacionServidor> {
  const payload = { liquidacionId, operacionId }
  const r = await httpsCallable<typeof payload, ResultadoPagarLiquidacionServidor>(functions, 'marcarLiquidacionPagada')(payload)
  return r.data
}
