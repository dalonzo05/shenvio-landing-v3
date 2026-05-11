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

/** Quita acentos, normaliza a minúsculas y colapsa espacios extra. */
export function normalizarTexto(text: string): string {
  return text
    .toLowerCase()
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
}

/** Distancia Haversine en km entre dos coords. */
export function haversineKm(
  a: { lat: number; lng: number },
  b: { lat: number; lng: number },
): number {
  const R = 6371
  const dLat = ((b.lat - a.lat) * Math.PI) / 180
  const dLng = ((b.lng - a.lng) * Math.PI) / 180
  const s =
    Math.sin(dLat / 2) ** 2 +
    Math.cos((a.lat * Math.PI) / 180) *
      Math.cos((b.lat * Math.PI) / 180) *
      Math.sin(dLng / 2) ** 2
  return R * 2 * Math.atan2(Math.sqrt(s), Math.sqrt(1 - s))
}

/**
 * Devuelve todos los puntos terminal_bus activos que coincidan con el destino
 * buscado. Usa normalización de texto para ignorar acentos y mayúsculas.
 * Puede retornar múltiples resultados (ej: León → Israel Lewites Y UCA).
 */
export function sugerirPuntosParaDestino(
  destino: string,
  puntos: PuntoLogistico[],
): PuntoLogistico[] {
  const dest = normalizarTexto(destino)
  if (!dest) return []
  return puntos
    .filter((p) => p.activo && p.tipo === 'terminal_bus')
    .filter((p) => {
      const terms = [...(p.destinos ?? []), ...(p.aliases ?? [])].map(normalizarTexto)
      return terms.some((t) => t.includes(dest) || dest.includes(t))
    })
    .sort((a, b) => b.prioridad - a.prioridad)
}

/**
 * Devuelve el punto Cargotrans activo más cercano a `coordRetiro`.
 * Retorna null si no hay sucursales activas.
 */
export function encontrarCargotransMasCercano(
  coordRetiro: { lat: number; lng: number },
  puntos: PuntoLogistico[],
): PuntoLogistico | null {
  const activos = puntos.filter((p) => p.activo && p.tipo === 'cargotrans')
  if (!activos.length) return null
  return activos.reduce((nearest, p) =>
    haversineKm(coordRetiro, p.coord) < haversineKm(coordRetiro, nearest.coord) ? p : nearest,
  )
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
