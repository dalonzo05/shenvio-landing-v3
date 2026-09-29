// ─── lib/motorizado-ranking.ts ───────────────────────────────────────────────
// Módulo de funciones puras para calcular el ranking de sugerencia de
// motorizado. Sin dependencias de Firebase ni efectos secundarios.
// ─────────────────────────────────────────────────────────────────────────────

import { esMotorizadoEnLinea, tieneCargaOperativa } from './motorizado-presencia'
import { diaOperativoDe, hoyOperativo } from './dia-operativo'
import { normalizarFecha } from './timeline-orden'
import { textoReferenciaGeografica } from './motorizado-referencia-ux'

// ─── Tipos ───────────────────────────────────────────────────────────────────

export interface MotorizadoConRanking {
  id: string
  nombre: string
  telefono?: string
  estado?: string
  activo?: boolean
  authUid?: string
  // Nuevos campos opcionales — Firestore los devolverá cuando existan en el doc:
  ubicacionBase?: { lat: number; lng: number } | null
  // MOTO-RANKING-UBICACION-FRESCA-1 — `timestamp` es lo que la trae del writer
  // real (lib/motorizado-stats.ts): un Timestamp de Firestore. Tipado `unknown`
  // a propósito (este módulo no depende de Firebase); se lee con normalizarFecha.
  ultimaUbicacionOperativa?: { lat: number; lng: number; timestamp?: unknown } | null
  // Sello server-side de la última transición EXPLÍCITA de presencia (disponible
  // / inactivo), puesto por la callable actualizarPresenciaMotorizado. Un
  // documento que todavía no la tiene no demuestra ninguna sesión vigente —ver
  // ubicacionOperativaFresca— y eso es intencional: no se infiere de `updatedAt`,
  // que tocan otros escritores (ubicación operativa, edición del gestor, el
  // espejo legacy de responderAsignacion).
  presenciaUpdatedAt?: unknown
  tasaAceptacion?: number         // 0-1, asumir 1.0 si ausente
  totalRechazos?: number          // acumulado histórico de rechazos
  totalAsignaciones?: number      // acumulado histórico de asignaciones procesadas
  totalAceptadas?: number         // acumulado histórico de aceptaciones
  tiempoPromedioAceptacion?: number // segundos promedio desde asignación a aceptación
  tieneBolso?: boolean            // asumir false si ausente
  zonaBase?: string | null        // zona pequeña de base del motorizado
  macroZonaBase?: string | null   // macrozona de base del motorizado
  zonaOperativaActual?: string | null       // zona pequeña operativa actual (para uso futuro)
  macroZonaOperativaActual?: string | null  // macrozona operativa actual (para uso futuro)
  scoreDesempeño?: number         // reservado para uso futuro
  fotoUrl?: string | null
}

export interface OrdenActivaRanking {
  id: string
  estado: string
  asignacion?: { motorizadoId?: string } | null
  recoleccion?: { coord?: { lat: number; lng: number } | null }
  entrega?: { coord?: { lat: number; lng: number } | null }
  cotizacion?: {
    origenCoord?: { lat: number; lng: number } | null
    destinoCoord?: { lat: number; lng: number } | null
  }
  // Campos de zona y macrozona — presentes si la orden fue clasificada con clasificarOrdenCompleto
  zonaRetiroId?: string | null
  zonaEntregaId?: string | null
  macroZonaRetiroId?: string | null
  macroZonaEntregaId?: string | null
  // MOTO-RANKING-REFERENCIA-UX-1 — código humano (IDENTIDAD-HUMANA-1, ej.
  // "SH-1058"). useOrdenesActivasCandidatas ya trae el documento completo
  // (spread de Firestore), así que este campo llega solo al declararlo acá;
  // no se agrega ningún fetch ni listener nuevo. Puede faltar en órdenes
  // históricas sin código — la presentación (mostrarCodigo) ya sabe caer al
  // ID corto sin inventar nada.
  codigo?: string
}

export interface NuevaOrdenRanking {
  recoleccion?: { coord?: { lat: number; lng: number } | null }
  entrega?: { coord?: { lat: number; lng: number } | null }
  cotizacion?: {
    origenCoord?: { lat: number; lng: number } | null
    destinoCoord?: { lat: number; lng: number } | null
  }
  requiereBolso?: boolean   // asumir false si ausente
  // Campos de zona territorial (sin APIs externas):
  zonaRetiroId?: string | null
  zonaEntregaId?: string | null
  macroZonaRetiroId?: string | null
  macroZonaEntregaId?: string | null
}

// MOTO-RANKING-REFERENCIA-UX-1 — qué referencia geográfica concreta produjo
// `proximoPuntoOperativo`/`distanciaProximoKm`. Es la MISMA decisión que ya
// tomaba getProximoPuntoOperativo (ver getReferenciaGeografica más abajo,
// de la que getProximoPuntoOperativo ahora es un envoltorio): esto no
// re-decide nada, solo expone con qué criterio se llegó al punto ya usado
// por el cálculo de cercanía/compatibilidad. Puramente aditivo — no cambia
// ningún número del ranking.
export type TipoReferenciaGeografica =
  | 'proximo_punto_operativo'
  | 'ultima_ubicacion_operativa'
  | 'ubicacion_base'
  | 'sin_referencia'

export interface ReferenciaGeografica {
  tipo: TipoReferenciaGeografica
  coord: { lat: number; lng: number } | null
  /** Solo con tipo 'proximo_punto_operativo': la orden activa que originó el punto. */
  ordenId?: string
  /** Código humano de esa orden (SH-####) si el documento lo tiene. */
  codigoOrden?: string
  /** Solo con tipo 'proximo_punto_operativo': si el punto es de retiro o de entrega. */
  tipoPunto?: 'retiro' | 'entrega'
  /** Solo con tipo 'ultima_ubicacion_operativa': el timestamp real del dato (nunca inventado). */
  timestamp?: unknown
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
    penalizacionRechazos: number
    bonificacionZonaTotal: number
    mismaMacroZona: boolean | null
    mismaZona: boolean | null
    proximoPuntoOperativo: { lat: number; lng: number } | null
    /** MOTO-RANKING-REFERENCIA-UX-1 — metadata explicativa, ver arriba. */
    referenciaGeografica: ReferenciaGeografica
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

/** Penalización por rechazos: -2 pts por cada 5 rechazos, máximo -10 pts */
const PENALIZACION_RECHAZOS_POR_5 = 2
const PENALIZACION_RECHAZOS_MAX   = 10

/** Bonificaciones/penalizaciones territoriales — solo se aplican cuando el motorizado está ocupado */
const BONUS_MISMA_MACROZONA         = 8   // entrega activa y nueva coinciden en macrozona
const BONUS_MISMA_ZONA              = 4   // además coinciden en zona pequeña
const PENALIZACION_DESVIO_MACROZONA = 5   // las macrozonas son distintas (desvío de ruta)

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

// ─── Frescura de ultimaUbicacionOperativa ──────────────────────────────────────

/**
 * ¿La última ubicación operativa de un motorizado SIN órdenes activas puede
 * usarse como referencia geográfica vigente? TODAS las condiciones:
 *
 *   1. lat/lng válidos y timestamp legible;
 *   2. el timestamp cae en el día operativo actual de Managua (dia-operativo.ts);
 *   3. existe `presenciaUpdatedAt` — sin él NO se considera demostrada una sesión
 *      vigente (contrato conservador: preferimos ubicacionBase a una posición que
 *      podría ser de una sesión ya cerrada); no se infiere de `updatedAt`;
 *   4. la ubicación es de esa sesión: su timestamp >= presenciaUpdatedAt.
 *
 * Con órdenes activas esto no se consulta: la referencia sale de las órdenes
 * (ver getProximoPuntoOperativo), sin cambios.
 */
export function ubicacionOperativaFresca(
  motorizado: MotorizadoConRanking,
  ahoraMs: number
): boolean {
  const ub = motorizado.ultimaUbicacionOperativa
  if (!ub || typeof ub.lat !== 'number' || typeof ub.lng !== 'number') return false
  const ubicacionAt = normalizarFecha(ub.timestamp)
  if (!ubicacionAt) return false
  if (diaOperativoDe(ubicacionAt.getTime()) !== hoyOperativo(ahoraMs)) return false
  const presenciaAt = normalizarFecha(motorizado.presenciaUpdatedAt)
  if (!presenciaAt) return false
  return ubicacionAt.getTime() >= presenciaAt.getTime()
}

// ─── getProximoPuntoOperativo ─────────────────────────────────────────────────

/**
 * Deriva el próximo punto operativo relevante de un motorizado según sus
 * órdenes activas (la carga se deriva de ellas, no de `motorizado.estado`).
 *
 * - sin órdenes activas → ultimaUbicacionOperativa SOLO si ubicacionOperativaFresca
 *   (hoy Managua + de la sesión de presencia vigente); si no, ubicacionBase
 * - con órdenes activas → punto de la orden activa más avanzada en su ciclo de vida
 *   (SIN CAMBIOS: la frescura no aplica aquí):
 *     · asignada | en_camino_retiro  → recoleccion.coord (aún va a buscar)
 *     · retirado | en_camino_entrega → entrega.coord (ya lo tiene, va a entregar)
 * - fallback (orden activa sin coord utilizable) → ultimaUbicacionOperativa ?? ubicacionBase ?? null,
 *   igual que siempre: hay carga real, la frescura no decide acá.
 *
 * @param ahoraMs  Instante de referencia para la frescura. Inyectado para
 *                  mantener el módulo determinista en tests; en producción se
 *                  omite y usa el reloj real.
 */
/**
 * MOTO-RANKING-REFERENCIA-UX-1 — misma decisión que siempre tomó este
 * módulo (ver comentarios originales, conservados abajo tal cual), pero
 * devolviendo también CON QUÉ CRITERIO se llegó al punto: para que la UI
 * pueda explicarlo sin volver a deducirlo por su cuenta. `getProximoPuntoOperativo`
 * es ahora un envoltorio de esta función — mismo árbol de decisión, cero
 * cambio de comportamiento numérico.
 *
 * - sin órdenes activas → ultimaUbicacionOperativa SOLO si ubicacionOperativaFresca
 *   (hoy Managua + de la sesión de presencia vigente); si no, ubicacionBase
 * - con órdenes activas → punto de la orden activa más avanzada en su ciclo de vida
 *   (SIN CAMBIOS: la frescura no aplica aquí):
 *     · asignada | en_camino_retiro  → recoleccion.coord (aún va a buscar)
 *     · retirado | en_camino_entrega → entrega.coord (ya lo tiene, va a entregar)
 * - fallback (orden activa sin coord utilizable) → ultimaUbicacionOperativa ?? ubicacionBase ?? null,
 *   igual que siempre: hay carga real, la frescura no decide acá. Se etiqueta
 *   según cuál de los dos campos fue el que realmente se usó (sin inventar
 *   ninguna frescura que el dato no tiene).
 *
 * @param ahoraMs  Instante de referencia para la frescura. Inyectado para
 *                  mantener el módulo determinista en tests; en producción se
 *                  omite y usa el reloj real.
 */
export function getReferenciaGeografica(
  motorizado: MotorizadoConRanking,
  todasLasOrdenes: OrdenActivaRanking[],
  ahoraMs: number = Date.now()
): ReferenciaGeografica {
  // Con o sin trabajo: sus órdenes activas mandan, sea cual sea el `estado` crudo
  // (disponible, o el legacy ocupado).
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
      ? (ordenRel.recoleccion?.coord ?? ordenRel.cotizacion?.origenCoord ?? null)
      : (ordenRel.entrega?.coord ?? ordenRel.cotizacion?.destinoCoord ?? null)

    if (coord) {
      return {
        tipo: 'proximo_punto_operativo',
        coord,
        ordenId: ordenRel.id,
        codigoOrden: ordenRel.codigo,
        tipoPunto: apuntaRetiro ? 'retiro' : 'entrega',
      }
    }
    // Hay carga real pero la orden no trae coord utilizable: mismo fallback de
    // siempre, sin pasar por frescura (no es el caso "sin órdenes activas").
    if (motorizado.ultimaUbicacionOperativa) {
      return {
        tipo: 'ultima_ubicacion_operativa',
        coord: motorizado.ultimaUbicacionOperativa,
        timestamp: motorizado.ultimaUbicacionOperativa.timestamp,
      }
    }
    if (motorizado.ubicacionBase) {
      return { tipo: 'ubicacion_base', coord: motorizado.ubicacionBase }
    }
    return { tipo: 'sin_referencia', coord: null }
  }

  // Sin órdenes activas: la última ubicación operativa solo cuenta si es de HOY
  // y de la sesión de presencia vigente; si no, ubicación base.
  if (ubicacionOperativaFresca(motorizado, ahoraMs)) {
    return {
      tipo: 'ultima_ubicacion_operativa',
      coord: motorizado.ultimaUbicacionOperativa!,
      timestamp: motorizado.ultimaUbicacionOperativa!.timestamp,
    }
  }
  if (motorizado.ubicacionBase) {
    return { tipo: 'ubicacion_base', coord: motorizado.ubicacionBase }
  }
  return { tipo: 'sin_referencia', coord: null }
}

export function getProximoPuntoOperativo(
  motorizado: MotorizadoConRanking,
  todasLasOrdenes: OrdenActivaRanking[],
  ahoraMs: number = Date.now()
): { lat: number; lng: number } | null {
  return getReferenciaGeografica(motorizado, todasLasOrdenes, ahoraMs).coord
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
  todasLasOrdenes: OrdenActivaRanking[],
  ahoraMs: number = Date.now()
): ScoreResult {
  // ── 1. Carga (40%) ──────────────────────────────────────────────────────────
  const cargaActual = ordenesDelMoto.length
  // 0 órdenes → 1.0 | 1 → 0.75 | 2 → 0.5 | 3 → 0.25 | 4+ → 0
  const scoreCarga = Math.max(0, 1 - cargaActual * 0.25)

  // ── 2. Cercanía al próximo punto operativo (30%) ────────────────────────────
  // MOTO-RANKING-REFERENCIA-UX-1 — una sola llamada; `proximoPunto` es
  // exactamente `referenciaGeografica.coord` (mismo valor que antes devolvía
  // getProximoPuntoOperativo directo), así que ningún número de acá abajo
  // cambia. La metadata (tipo/orden/timestamp) solo viaja en `detalles` para
  // que la UI explique de dónde salió este mismo punto.
  const referenciaGeografica = getReferenciaGeografica(motorizado, todasLasOrdenes, ahoraMs)
  const proximoPunto = referenciaGeografica.coord
  const coordRetiroNueva =
    nuevaOrden.recoleccion?.coord ?? nuevaOrden.cotizacion?.origenCoord ?? null

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

  if (!tieneCargaOperativa(ordenesDelMoto)) {
    // Sin órdenes activas: perfectamente compatible, sin conflicto de ruta
    scoreCompatibilidad = 1.0
  } else {
    // Con órdenes activas: evaluar qué tan lejos está su próximo destino del nuevo retiro
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

  // ── 6. Penalizaciones ───────────────────────────────────────────────────────
  const requiereBolso = nuevaOrden.requiereBolso ?? false
  const penalizacionBolso = requiereBolso && !motorizado.tieneBolso ? PENALIZACION_BOLSO : 0

  // -2 pts por cada 5 rechazos acumulados, máximo -10 pts
  const penalizacionRechazos = motorizado.totalRechazos
    ? Math.min(PENALIZACION_RECHAZOS_MAX, Math.floor(motorizado.totalRechazos / 5) * PENALIZACION_RECHAZOS_POR_5)
    : 0

  // ── 6b. Bonificación/penalización territorial ────────────────────────────────
  // Solo aplica cuando el motorizado tiene órdenes activas.
  // Compara la macrozona de entrega de su orden más avanzada con la macrozona
  // de entrega del nuevo pedido: misma dirección territorial → bonus,
  // dirección opuesta → penalización.
  // Si faltan datos de macrozona en cualquiera de los dos lados → sin efecto.
  let bonificacionZonaTotal = 0
  let mismaMacroZona: boolean | null = null
  let mismaZona: boolean | null = null

  if (tieneCargaOperativa(ordenesDelMoto)) {
    const ordenMasAvanzada = [...ordenesDelMoto].sort(
      (a, b) => (PRIORIDAD_ESTADO[b.estado] ?? 0) - (PRIORIDAD_ESTADO[a.estado] ?? 0)
    )[0]

    const macroActual = ordenMasAvanzada.macroZonaEntregaId ?? null
    const macraNueva  = nuevaOrden.macroZonaEntregaId ?? null

    if (macroActual !== null && macraNueva !== null) {
      if (macroActual === macraNueva) {
        mismaMacroZona = true
        bonificacionZonaTotal += BONUS_MISMA_MACROZONA

        // Bonus adicional si además coincide la zona pequeña
        const zonaActual = ordenMasAvanzada.zonaEntregaId ?? null
        const zonaNueva  = nuevaOrden.zonaEntregaId ?? null
        if (zonaActual !== null && zonaNueva !== null && zonaActual === zonaNueva) {
          mismaZona = true
          bonificacionZonaTotal += BONUS_MISMA_ZONA
        } else {
          mismaZona = false
        }
      } else {
        // Macrozonas distintas: el nuevo pedido llevaría al motorizado en dirección opuesta
        mismaMacroZona = false
        bonificacionZonaTotal -= PENALIZACION_DESVIO_MACROZONA
      }
    }
    // Si alguna macrozona es null → datos insuficientes → sin efecto (fallback gracioso)
  }
  // Motorizados sin órdenes activas: no aplica bonificación zonal (son igualmente flexibles)

  // ── 7. Score total ──────────────────────────────────────────────────────────
  const scoreTotal = Math.round(
    Math.max(0, scoreFinal - penalizacionBolso - penalizacionRechazos + bonificacionZonaTotal)
  )

  // ── 8. Explicación textual ──────────────────────────────────────────────────
  const partes: string[] = []

  partes.push('En línea')

  partes.push(
    cargaActual === 0
      ? 'Sin órdenes activas'
      : `${cargaActual} orden${cargaActual > 1 ? 'es' : ''} activa${cargaActual > 1 ? 's' : ''}`
  )

  // MOTO-RANKING-REFERENCIA-UX-1 — antes acá solo se decía "Punto estimado/
  // cercano (X km)", sin explicar SI ese punto es la próxima orden activa,
  // una última ubicación operativa (histórica) o la ubicación base. Mismo
  // dato (referenciaGeografica ya calculada arriba, mismo distanciaProximoKm
  // que usa el score), solo más explicable — no cambia ningún número.
  partes.push(textoReferenciaGeografica(referenciaGeografica, distanciaProximoKm, ahoraMs))

  if (tieneCargaOperativa(ordenesDelMoto)) {
    partes.push(scoreCompatibilidad >= 0.5 ? 'Ruta compatible' : 'Ruta alejada')
  } else {
    partes.push('Ruta compatible')
  }

  // Contexto territorial (solo cuando hay datos de macrozona)
  if (mismaMacroZona === true) {
    partes.push(mismaZona ? 'Ruta territorial compatible' : 'Misma macrozona')
  } else if (mismaMacroZona === false) {
    partes.push('Desvío alto')
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
      penalizacionRechazos,
      bonificacionZonaTotal,
      mismaMacroZona,
      mismaZona,
      proximoPuntoOperativo: proximoPunto,
      referenciaGeografica,
    },
  }
}

// ─── rankearMotorizados ───────────────────────────────────────────────────────

/**
 * Filtra, puntúa y ordena los motorizados elegibles para recibir una nueva
 * orden. Solo participan los que tienen `activo !== false` y están en línea
 * (`disponible`, o el legacy `ocupado`): un motorizado `inactivo` (fuera de línea)
 * no recibe órdenes nuevas, aunque conserve las que ya tiene.
 *
 * @param motorizados       Lista completa de motorizados
 * @param todasLasOrdenes   Órdenes activas del sistema (estados activos)
 * @param nuevaOrden        Datos de la orden a asignar
 * @returns                 Array ordenado de mayor a menor score
 */
export function rankearMotorizados(
  motorizados: MotorizadoConRanking[],
  todasLasOrdenes: OrdenActivaRanking[],
  nuevaOrden: NuevaOrdenRanking,
  ahoraMs: number = Date.now()
): MotorizadoRankeado[] {
  // Solo motorizados activos y en línea
  const activos = motorizados.filter((m) => m.activo !== false && esMotorizadoEnLinea(m.estado))

  return activos
    .map((moto) => {
      const ordenesDelMoto = todasLasOrdenes.filter(
        (o) =>
          o.asignacion?.motorizadoId === moto.id &&
          ESTADOS_ACTIVOS.includes(o.estado as typeof ESTADOS_ACTIVOS[number])
      )
      const scoreResult = calcularScore(moto, ordenesDelMoto, nuevaOrden, todasLasOrdenes, ahoraMs)
      return { ...moto, scoreResult }
    })
    .sort((a, b) => b.scoreResult.score - a.scoreResult.score)
}
