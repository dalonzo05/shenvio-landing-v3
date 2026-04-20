export interface ZonaGeografica {
  id: string
  nombre: string
  color: string
  poligono: Array<{ lat: number; lng: number }>
  activa: boolean
  prioridad: number
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
 */
export function clasificarPuntoEnZona(
  coord: Coord,
  zonas: ZonaGeografica[]
): ZonaGeografica | null {
  const activas = zonas
    .filter((z) => z.activa)
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
 * Clasifica el punto de retiro y el punto de entrega de una orden.
 * Si alguna coordenada es null o no cae en ninguna zona, retorna null para ese campo.
 * Nunca lanza error.
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
  const zonaRetiro = recoleccionCoord
    ? clasificarPuntoEnZona(recoleccionCoord, zonas)
    : null

  const zonaEntrega = entregaCoord
    ? clasificarPuntoEnZona(entregaCoord, zonas)
    : null

  return {
    zonaRetiroId: zonaRetiro?.id ?? null,
    zonaRetiroNombre: zonaRetiro?.nombre ?? null,
    zonaEntregaId: zonaEntrega?.id ?? null,
    zonaEntregaNombre: zonaEntrega?.nombre ?? null,
  }
}
