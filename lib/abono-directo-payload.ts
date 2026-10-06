// FIN-4C — payloads que se entregan a httpsCallable.
//
// @firebase/functions serializa `undefined` como `null` (encode(undefined) === null), de modo que
// `{ reconoceOperacionId: undefined }` llega al servidor como `reconoceOperacionId: null`. Para que un
// campo opcional AUSENTE llegue ausente, la propiedad no debe existir en el objeto: estos constructores
// la omiten. Es una frontera deliberadamente chica (solo las dos callables que reciben opcionales);
// el servidor además tolera null como ausente en esos mismos campos.

export interface CamposPrepararAbono {
  saldoId: string
  monto: number
  metodoAbono: string
  nota?: string | null
  comprobanteUrl?: string | null
  comprobantePath?: string | null
  /** "Ya vi que esta operación quedó aplicada y quiero OTRO abono": la acción explícita de abono nuevo. */
  reconoceOperacionId?: string | null
}

export interface CamposRegistrarAbono {
  saldoId: string
  monto: number
  operacionId: string
  metodoAbono: string
  nota?: string | null
  comprobanteUrl?: string | null
  comprobantePath?: string | null
}

function presente(v: string | null | undefined): v is string {
  return typeof v === 'string' && v.length > 0
}

export function payloadPreparar(p: CamposPrepararAbono): Record<string, unknown> {
  return {
    saldoId: p.saldoId,
    monto: p.monto,
    metodoAbono: p.metodoAbono,
    ...(p.nota != null ? { nota: p.nota } : {}),
    ...(presente(p.comprobanteUrl) ? { comprobanteUrl: p.comprobanteUrl } : {}),
    ...(presente(p.comprobantePath) ? { comprobantePath: p.comprobantePath } : {}),
    ...(presente(p.reconoceOperacionId) ? { reconoceOperacionId: p.reconoceOperacionId } : {}),
  }
}

export function payloadRegistrar(p: CamposRegistrarAbono): Record<string, unknown> {
  return {
    saldoId: p.saldoId,
    monto: p.monto,
    operacionId: p.operacionId,
    metodoAbono: p.metodoAbono,
    ...(p.nota != null ? { nota: p.nota } : {}),
    ...(presente(p.comprobanteUrl) ? { comprobanteUrl: p.comprobanteUrl } : {}),
    ...(presente(p.comprobantePath) ? { comprobantePath: p.comprobantePath } : {}),
  }
}
