import { httpsCallable } from 'firebase/functions'
import { functions } from '@/fb/config'
import type { ResultadoResolverServidor } from './finanzas-operativas-ux'

// FIN-1C-B — el ÚNICO camino del producto para resolver una incidencia de Cobros. Manda solo { ordenId, item, decision, nota? }: el actor, la
// fecha, el estado final del cobro y cobroPendiente los deriva el servidor (functions/src/resolver-incidencia-cobro.ts).
export async function resolverIncidenciaCobroServidor(ordenId: string, item: 'delivery' | 'producto', decision: 'cliente_pagara' | 'se_pierde', nota?: string): Promise<ResultadoResolverServidor> {
  const payload: { ordenId: string; item: 'delivery' | 'producto'; decision: 'cliente_pagara' | 'se_pierde'; nota?: string } = { ordenId, item, decision }
  if (nota && nota.trim()) payload.nota = nota.trim()
  const r = await httpsCallable<typeof payload, ResultadoResolverServidor>(functions, 'resolverIncidenciaCobro')(payload)
  return r.data
}
