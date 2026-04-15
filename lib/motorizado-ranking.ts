// ─── lib/motorizado-ranking.ts ───────────────────────────────────────────────
// Módulo de funciones puras para calcular el ranking de sugerencia de
// motorizado. Sin dependencias de Firebase ni efectos secundarios.
// ─────────────────────────────────────────────────────────────────────────────

// ─── Tipos ───────────────────────────────────────────────────────────────────

export interface MotorizadoConRanking {
  id: string
  nombre: string
  telefono?: string
  estado?: 'disponible' | 'ocupado'
  activo?: boolean
  authUid?: string
  // Nuevos campos opcionales — Firestore los devolverá cuando existan en el doc:
  ubicacionBase?: { lat: number; lng: number } | null
  ultimaUbicacionOperativa?: { lat: number; lng: number } | null
  tasaAceptacion?: number   // 0-1, asumir 1.0 si ausente
  tieneBolso?: boolean      // asumir false si ausente
  zonaBase?: string         // reservado para futura lógica de zonas
}

export interface OrdenActivaRanking {
  id: string
  estado: string
  asignacion?: { motorizadoId?: string } | null
  recoleccion?: { coord?: { lat: number; lng: number } | null }
  entrega?: { coord?: { lat: number; lng: number } | null }
}

export interface NuevaOrdenRanking {
  recoleccion?: { coord?: { lat: number; lng: number } | null }
  entrega?: { coord?: { lat: number; lng: number } | null }
  requiereBolso?: boolean   // asumir false si ausente
  // Reservado para futura lógica de zonas (sin APIs externas):
  zonaRetiro?: string
  zonaEntrega?: string
}

export interface ScoreResult {
  motorizadoId: string
  score: number             // 0-100, redondeado
  explicacion: string       // texto legible para el gestor
  detalles: {
    cargaActual: number
    scoreCarga: number
    distanciaProximoKm: number | null
    scoreCercania: number
    scoreCompatibilidad: number
    scoreAceptacion: number
    penalizacionBolso: number
    proximoPuntoOperativo: { lat: number; lng: number } | null
  }
}

export interface MotorizadoRankeado extends MotorizadoConRanking {
  scoreResult: ScoreResult
}

// ─── Constantes ───────────────────────────────────────────────────────────────

/** Estados que definen una orden como "activa" para el cálculo de carga */
const ESTADOS_ACTIVOS = ['asignada', 'en_camino_retiro', 'retirado', 'en_camino_entrega'] as const

/** Pesos de la fórmula de scoring (deben sumar 1.0) */
const PESO_CARGA      = 0.40
const PESO_CERCANIA   = 0.30
const PESO_COMPAT     = 0.20
const PESO_ACEPTACION = 0.10

/** Distancia en km donde scoreCercania llega a 0 */
const DIST_MAX_CERCANIA = 20

/** Distancia en km donde scoreCompatibilidad llega a 0 */
const DIST_MAX_COMPAT = 15

/** Puntos a restar si la orden requiere bolso y el motorizado no lo tiene */
const PENALIZACION_BOLSO = 30

/** Prioridad de estado para determinar el orden activo más relevante */
const PRIORIDAD_ESTADO: Record<string, number> = {
  en_camino_entrega: 4,
  retirado: 3,
  en_camino_retiro: 2,
  asignada: 1,
}

// ─── haversine ────────────────────────────────────────────────────────────────

/**
 * Calcula la distancia en kilómetros entre dos coordenadas en línea recta
 * usando la fórmula de Haversine. Sin APIs externas.
 */
export function haversine(
  a: { lat: number; lng: number },
  b: { lat: number; lng: number }
): number {
  const R = 6371 // Radio de la Tierra en km
  const dLat = ((b.lat - a.lat) * Math.PI) / 180
  const dLng = ((b.lng - a.lng) * Math.PI) / 180
  const sinDLat = Math.sin(dLat / 2)
  const sinDLng = Math.sin(dLng / 2)
  const aVal =
    sinDLat * sinDLat +
    Math.cos((a.lat * Math.PI) / 180) *
      Math.cos((b.lat * Math.PI) / 180) *
      sinDLng * sinDLng
  return R * 2 * Math.atan2(Math.sqrt(aVal), Math.sqrt(1 - aVal))
}

// ─── getProximoPuntoOperativo ─────────────────────────────────────────────────

/**
 * Deriva el próximo punto operativo relevante de un motorizado según su estado
 * actual y sus órdenes activas.
 *
 * - disponible → ultimaUbicacionOperativa ?? ubicacionBase ?? null
 * - ocupado    → punto de la orden activa más avanzada en su ciclo de vida:
 *     · asignada | en_camino_retiro  → recoleccion.coord (aún va a buscar)
 *     · retirado | en_camino_entrega → entrega.coord (ya lo tiene, va a entregar)
 * - fallback   → ultimaUbicacionOperativa ?? ubicacionBase ?? null
 */
export function getProximoPuntoOperativo(
  motorizado: MotorizadoConRanking,
  todasLasOrdenes: OrdenActivaRanking[]
): { lat: number; lng: number } | null {
  if (motorizado.estado === 'disponible') {
    return motorizado.ultimaUbicacionOperativa ?? motorizado.ubicacionBase ?? null
  }

  // Ocupado: encontrar su orden activa más avanzada
  const misOrdenes = todasLasOrdenes.filter(
    (o) =>
      o.asignacion?.motorizadoId === motorizado.id &&
      ESTADOS_ACTIVOS.includes(o.estado as typeof ESTADOS_ACTIVOS[number])
  )

  if (misOrdenes.length > 0) {
    const ordenRel = [...misOrdenes].sort(
      (a, b) => (PRIORIDAD_ESTADO[b.estado] ?? 0) - (PRIORIDAD_ESTADO[a.estado] ?? 0)
    )[0]

    const apuntaRetiro = ['asignada', 'en_camino_retiro'].includes(ordenRel.estado)
    const coord = apuntaRetiro
      ? ordenRel.recoleccion?.coord ?? null
      : ordenRel.entrega?.coord ?? null

    if (coord) return coord
  }

  // Fallback a ubicación base si no hay coords en las órdenes
  return motorizado.ultimaUbicacionOperativa ?? motorizado.ubicacionBase ?? null
}

// ─── calcularScore ────────────────────────────────────────────────────────────

/**
 * Calcula el score de idoneidad (0-100) de un motorizado para recibir
 * una nueva orden. Retorna también la explicación textual y el desglose.
 */
export function calcularScore(
  motorizado: MotorizadoConRanking,
  ordenesDelMoto: OrdenActivaRanking[],
  nuevaOrden: NuevaOrdenRanking,
  todasLasOrdenes: OrdenActivaRanking[]
): ScoreResult {
  // ── 1. Carga (40%) ──────────────────────────────────────────────────────────
  const cargaActual = ordenesDelMoto.length
  // 0 órdenes → 1.0 | 1 → 0.75 | 2 → 0.5 | 3 → 0.25 | 4+ → 0
  const scoreCarga = Math.max(0, 1 - cargaActual * 0.25)

  // ── 2. Cercanía al próximo punto operativo (30%) ────────────────────────────
  const proximoPunto = getProximoPuntoOperativo(motorizado, todasLasOrdenes)
  const coordRetiroNueva = nuevaOrden.recoleccion?.coord ?? null

  let distanciaProximoKm: number | null = null
  let scoreCercania: number

  if (proximoPunto && coordRetiroNueva) {
    distanciaProximoKm = haversine(proximoPunto, coordRetiroNueva)
    scoreCercania = Math.max(0, 1 - distanciaProximoKm / DIST_MAX_CERCANIA)
  } else {
    // Sin referencia suficiente → neutral
    scoreCercania = 0.5
  }

  // ── 3. Compatibilidad de ruta (20%) ─────────────────────────────────────────
  let scoreCompatibilidad: number

  if (motorizado.estado !== 'ocupado') {
    // Disponible: perfectamente compatible, sin conflicto de ruta
    scoreCompatibilidad = 1.0
  } else {
    // Ocupado: evaluar qué tan lejos está su próximo destino del nuevo retiro
    if (proximoPunto && coordRetiroNueva) {
      const distCompatKm = haversine(proximoPunto, coordRetiroNueva)
      scoreCompatibilidad = Math.max(0, 1 - distCompatKm / DIST_MAX_COMPAT)
    } else {
      scoreCompatibilidad = 0.5 // neutral si faltan coords
    }
  }

  // ── 4. Tasa de aceptación histórica (10%) ───────────────────────────────────
  const scoreAceptacion = motorizado.tasaAceptacion ?? 1.0

  // ── 5. Score base 0-100 ─────────────────────────────────────────────────────
  const scoreFinal =
    (scoreCarga * PESO_CARGA +
      scoreCercania * PESO_CERCANIA +
      scoreCompatibilidad * PESO_COMPAT +
      scoreAceptacion * PESO_ACEPTACION) *
    100

  // ── 6. Penalización bolso ───────────────────────────────────────────────────
  const requiereBolso = nuevaOrden.requiereBolso ?? false
  const penalizacionBolso = requiereBolso && !motorizado.tieneBolso ? PENALIZACION_BOLSO : 0

  const scoreTotal = Math.round(Math.max(0, scoreFinal - penalizacionBolso))

  // ── 7. Explicación textual ──────────────────────────────────────────────────
  const partes: string[] = []

  partes.push(motorizado.estado === 'disponible' ? 'Disponible' : 'Ocupado')

  partes.push(
    cargaActual === 0
      ? 'Sin órdenes activas'
      : `${cargaActual} orden${cargaActual > 1 ? 'es' : ''} activa${cargaActual > 1 ? 's' : ''}`
  )

  if (distanciaProximoKm !== null) {
    const tipo = motorizado.estado === 'disponible' ? 'cercano' : 'estimado'
    partes.push(`Punto ${tipo} (${distanciaProximoKm.toFixed(1)} km)`)
  } else {
    partes.push('Sin ubicación de referencia')
  }

  if (motorizado.estado === 'ocupado') {
    partes.push(scoreCompatibilidad >= 0.5 ? 'Ruta compatible' : 'Ruta alejada')
  } else {
    partes.push('Ruta compatible')
  }

  if (penalizacionBolso > 0) {
    partes.push(`Sin bolso (-${PENALIZACION_BOLSO} pts)`)
  }

  const explicacion = partes.join(' · ')

  return {
    motorizadoId: motorizado.id,
    score: scoreTotal,
    explicacion,
    detalles: {
      cargaActual,
      scoreCarga,
      distanciaProximoKm,
      scoreCercania,
      scoreCompatibilidad,
      scoreAceptacion,
      penalizacionBolso,
      proximoPuntoOperativo: proximoPunto,
    },
  }
}

// ─── rankearMotorizados ───────────────────────────────────────────────────────

/**
 * Filtra, puntúa y ordena los motorizados elegibles para recibir una nueva
 * orden. Solo participan los que tienen `activo !== false`.
 *
 * @param motorizados       Lista completa de motorizados
 * @param todasLasOrdenes   Órdenes activas del sistema (estados activos)
 * @param nuevaOrden        Datos de la orden a asignar
 * @returns                 Array ordenado de mayor a menor score
 */
export function rankearMotorizados(
  motorizados: MotorizadoConRanking[],
  todasLasOrdenes: OrdenActivaRanking[],
  nuevaOrden: NuevaOrdenRanking
): MotorizadoRankeado[] {
  // Solo motorizados activos
  const activos = motorizados.filter((m) => m.activo !== false)

  return activos
    .map((moto) => {
      const ordenesDelMoto = todasLasOrdenes.filter(
        (o) =>
          o.asignacion?.motorizadoId === moto.id &&
          ESTADOS_ACTIVOS.includes(o.estado as typeof ESTADOS_ACTIVOS[number])
      )
      const scoreResult = calcularScore(moto, ordenesDelMoto, nuevaOrden, todasLasOrdenes)
      return { ...moto, scoreResult }
    })
    .sort((a, b) => b.scoreResult.score - a.scoreResult.score)
}
