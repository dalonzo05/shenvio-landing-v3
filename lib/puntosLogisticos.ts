export type TipoPuntoLogistico = 'terminal_bus' | 'cargotrans' | 'otro'

export interface PuntoLogistico {
  id: string
  nombre: string
  tipo: TipoPuntoLogistico
  coord: { lat: number; lng: number }
  direccion: string
  horarioApertura: string
  horarioCierre: string
  notas: string
  activo: boolean
  prioridad: number
  destinos: string[]   // departamentos/municipios (solo terminal_bus)
  aliases: string[]    // nombres alternativos (solo terminal_bus)
  createdAt?: any
  updatedAt?: any
  creadoPorUid?: string
}

/**
 * Devuelve todos los puntos terminal_bus activos que coincidan con el destino buscado.
 * Puede retornar múltiples resultados (ej: León → Israel Lewites Y UCA).
 */
export function sugerirPuntosParaDestino(
  destino: string,
  puntos: PuntoLogistico[],
): PuntoLogistico[] {
  if (!destino.trim()) return []
  const dest = destino.toLowerCase().trim()
  return puntos
    .filter((p) => p.activo && p.tipo === 'terminal_bus')
    .filter((p) => {
      const terms = [...(p.destinos ?? []), ...(p.aliases ?? [])]
      return terms.some(
        (t) => t.toLowerCase().includes(dest) || dest.includes(t.toLowerCase()),
      )
    })
    .sort((a, b) => b.prioridad - a.prioridad)
}

/** Devuelve todos los puntos Cargotrans activos. */
export function getPuntosCargotrans(puntos: PuntoLogistico[]): PuntoLogistico[] {
  return puntos.filter((p) => p.activo && p.tipo === 'cargotrans')
}

export const TIPO_LABELS: Record<TipoPuntoLogistico, string> = {
  terminal_bus: 'Terminal / Bus',
  cargotrans:   'Cargotrans',
  otro:         'Otro',
}

export const TIPO_COLORS: Record<TipoPuntoLogistico, string> = {
  terminal_bus: '#004aad',
  cargotrans:   '#16a34a',
  otro:         '#6b7280',
}
