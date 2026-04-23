export interface ZonaGeografica {
  id: string
  nombre: string
  color: string
  poligono: Array<{ lat: number; lng: number }>
  activa: boolean
  prioridad: number
  tipo: 'zona' | 'macrozona'
  descripcion?: string
  createdAt?: any
  updatedAt?: any
  creadoPorUid?: string
}

export type Coord = { lat: number; lng: number }

/**
 * Ray-casting algorithm para determinar si un punto está dentro de un polígono.
 * O(n) donde n = cantidad de vértices del polígono.
 * lng = eje X, lat = eje Y (convención estándar en cartografía).
 */
export function pointInPolygon(point: Coord, polygon: Coord[]): boolean {
  if (polygon.length < 3) return false

  let inside = false
  const n = polygon.length
  let j = n - 1

  for (let i = 0; i < n; i++) {
    const xi = polygon[i].lng
    const yi = polygon[i].lat
    const xj = polygon[j].lng
    const yj = polygon[j].lat

    // El arista cruza el rayo horizontal si un vértice está arriba y el otro abajo del punto
    const cruza = yi > point.lat !== yj > point.lat
    if (cruza) {
      const xIntersect = ((xj - xi) * (point.lat - yi)) / (yj - yi) + xi
      if (point.lng < xIntersect) {
        inside = !inside
      }
    }

    j = i
  }

  return inside
}

/**
 * Clasifica un punto devolviendo la primera zona activa que lo contiene.
 * Regla de solapes: se ordenan por prioridad DESC (mayor número = mayor prioridad, escala 1-5).
 * Si dos zonas empatan en prioridad, gana la que aparece primero en el array (orden estable).
 * Retorna null si el punto no cae en ninguna zona activa.
 *
 * @param tipoFiltro  Si se especifica, solo evalúa zonas de ese tipo. Sin filtro = todos los tipos.
 */
export function clasificarPuntoEnZona(
  coord: Coord,
  zonas: ZonaGeografica[],
  tipoFiltro?: 'zona' | 'macrozona'
): ZonaGeografica | null {
  const activas = zonas
    .filter((z) => z.activa && (tipoFiltro === undefined || z.tipo === tipoFiltro))
    .slice()
    .sort((a, b) => b.prioridad - a.prioridad)

  for (const zona of activas) {
    if (pointInPolygon(coord, zona.poligono)) {
      return zona
    }
  }

  return null
}

/**
 * Clasifica el punto de retiro y el punto de entrega de una orden en AMBOS niveles:
 * zona pequeña (tipo='zona') y macrozona (tipo='macrozona').
 *
 * Los dos niveles son no excluyentes: un punto puede caer en una zona pequeña Y en una
 * macrozona simultáneamente. Si no hay zonas de un nivel para un punto, esos campos
 * quedan en null.
 *
 * Nunca lanza error.
 */
export function clasificarOrdenCompleto(
  recoleccionCoord: Coord | null,
  entregaCoord: Coord | null,
  zonas: ZonaGeografica[]
): {
  zonaRetiroId: string | null
  zonaRetiroNombre: string | null
  zonaEntregaId: string | null
  zonaEntregaNombre: string | null
  macroZonaRetiroId: string | null
  macroZonaRetiroNombre: string | null
  macroZonaEntregaId: string | null
  macroZonaEntregaNombre: string | null
} {
  const zonaRetiro = recoleccionCoord
    ? clasificarPuntoEnZona(recoleccionCoord, zonas, 'zona')
    : null

  const zonaEntrega = entregaCoord
    ? clasificarPuntoEnZona(entregaCoord, zonas, 'zona')
    : null

  const macroZonaRetiro = recoleccionCoord
    ? clasificarPuntoEnZona(recoleccionCoord, zonas, 'macrozona')
    : null

  const macroZonaEntrega = entregaCoord
    ? clasificarPuntoEnZona(entregaCoord, zonas, 'macrozona')
    : null

  return {
    zonaRetiroId: zonaRetiro?.id ?? null,
    zonaRetiroNombre: zonaRetiro?.nombre ?? null,
    zonaEntregaId: zonaEntrega?.id ?? null,
    zonaEntregaNombre: zonaEntrega?.nombre ?? null,
    macroZonaRetiroId: macroZonaRetiro?.id ?? null,
    macroZonaRetiroNombre: macroZonaRetiro?.nombre ?? null,
    macroZonaEntregaId: macroZonaEntrega?.id ?? null,
    macroZonaEntregaNombre: macroZonaEntrega?.nombre ?? null,
  }
}

/**
 * Clasifica el punto de retiro y el punto de entrega de una orden.
 * Si alguna coordenada es null o no cae en ninguna zona, retorna null para ese campo.
 * Nunca lanza error.
 *
 * @deprecated Usar clasificarOrdenCompleto para obtener también los campos de macrozona.
 *             Este wrapper se mantiene por compatibilidad con callers existentes.
 */
export function clasificarOrden(
  recoleccionCoord: Coord | null,
  entregaCoord: Coord | null,
  zonas: ZonaGeografica[]
): {
  zonaRetiroId: string | null
  zonaRetiroNombre: string | null
  zonaEntregaId: string | null
  zonaEntregaNombre: string | null
} {
  const full = clasificarOrdenCompleto(recoleccionCoord, entregaCoord, zonas)
  return {
    zonaRetiroId: full.zonaRetiroId,
    zonaRetiroNombre: full.zonaRetiroNombre,
    zonaEntregaId: full.zonaEntregaId,
    zonaEntregaNombre: full.zonaEntregaNombre,
  }
}
