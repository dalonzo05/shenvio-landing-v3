// MOTO-STATS-ACEPTACION-CONSUMO-1 — lectura única de "cuántas decisiones de
// aceptación tiene un motorizado y cuál es su tasa", para las superficies de
// Gestor que hoy la reconstruían mal.
//
// SOLO LEE. No escribe Firestore, no decide qué mostrar en pantalla (eso
// sigue siendo lib/tasa-aceptacion.ts) y no decide el score de ranking (eso
// es MOTO-RANKING-ACEPTACION-SIN-HISTORIAL-1, deliberadamente aparte: el
// ranking sigue leyendo motorizado.tasaAceptacion ?? 1.0 sin cambios).
//
// Dos fuentes conviven en el documento motorizado/{id}:
//
//   v2 (canónica, MOTO-STATS-ACEPTACION-TRAZA-1)
//     metricasAceptacion: { version: 2, totalDecisiones, totalAceptadas,
//     totalRechazadas, tasaAceptacion (0–1) } — la escribe SOLO el servidor,
//     en la misma transacción que aceptar/rechazar. Acumulativa: sobrevive a
//     que la orden se reasigne después (la asignación actual es otro dato).
//
//   legacy (espejo, sigue vivo porque el ranking todavía lo lee)
//     tasaAceptacion / totalAsignaciones / totalAceptadas / totalRechazos —
//     top-level, mismos nombres de campo que antes calculaba el cliente
//     (ver lib/motorizado-stats.ts). totalRechazos puede estar AUSENTE si el
//     rider nunca rechazó (espejoLegacy solo lo escribe en la rama de
//     rechazo) — ausente se lee como 0, no como dato inválido.
//
// v2 gana siempre que sea válida. Legacy es fallback de compatibilidad para
// documentos que todavía no tienen v2. Sin ninguna de las dos, "sin
// historial" — nunca se inventa 0% ni 100%.
//
// PURO: sin Firestore, sin React, sin Date.now().

export type FuenteMetricasAceptacion = 'v2' | 'legacy' | 'sin_historial'

export interface LecturaMetricasAceptacion {
  fuente: FuenteMetricasAceptacion
  totalDecisiones: number
  totalAceptadas: number
  totalRechazadas: number
  /** 0–1. null solo cuando fuente === 'sin_historial'. */
  tasaAceptacion: number | null
  /** 0–100, redondeado. null solo cuando fuente === 'sin_historial'. */
  tasaPorcentaje: number | null
}

/** Forma mínima que este módulo necesita leer de motorizado/{id}. Todo opcional: los documentos reales llegan con campos ausentes según su antigüedad. */
export interface EntradaMetricasAceptacion {
  metricasAceptacion?: unknown
  tasaAceptacion?: unknown
  totalAsignaciones?: unknown
  totalAceptadas?: unknown
  totalRechazos?: unknown
}

const finitoNoNegativo = (v: unknown): v is number =>
  typeof v === 'number' && Number.isFinite(v) && v >= 0

const tasaValida = (v: unknown): v is number =>
  typeof v === 'number' && Number.isFinite(v) && v >= 0 && v <= 1

interface V2Valida {
  totalDecisiones: number
  totalAceptadas: number
  totalRechazadas: number
  tasaAceptacion: number
}

/**
 * v2 es autoritativa solo si su forma es coherente: version === 2, los tres
 * contadores son números finitos no negativos que suman entre sí, la tasa
 * está en 0–1, y hay al menos una decisión — el contrato del writer dice que
 * con 0 decisiones la proyección ni se escribe, así que un totalDecisiones
 * de 0 acá es una forma que no debería existir: se trata como no utilizable,
 * nunca como "0% real" fabricado desde una forma vacía.
 */
function leerV2(v: unknown): V2Valida | null {
  if (typeof v !== 'object' || v === null) return null
  const o = v as Record<string, unknown>
  if (o.version !== 2) return null
  if (!finitoNoNegativo(o.totalDecisiones) || !finitoNoNegativo(o.totalAceptadas) || !finitoNoNegativo(o.totalRechazadas)) return null
  if (o.totalAceptadas + o.totalRechazadas !== o.totalDecisiones) return null
  if (o.totalDecisiones <= 0) return null
  if (!tasaValida(o.tasaAceptacion)) return null
  return {
    totalDecisiones: o.totalDecisiones,
    totalAceptadas: o.totalAceptadas,
    totalRechazadas: o.totalRechazadas,
    tasaAceptacion: o.tasaAceptacion,
  }
}

interface LegacyValida {
  totalAsignaciones: number
  totalAceptadas: number
  totalRechazos: number
  tasaAceptacion: number
}

/**
 * Legacy es utilizable solo si totalAsignaciones > 0 (hay historial real) y
 * los campos presentes son coherentes. totalRechazos ausente es válido —
 * espejoLegacy() solo lo escribe en la rama de rechazo — y se lee como 0,
 * nunca como dato faltante que invalide todo el fallback.
 */
function leerLegacy(entrada: EntradaMetricasAceptacion): LegacyValida | null {
  const { totalAsignaciones, totalAceptadas, totalRechazos, tasaAceptacion } = entrada
  if (!finitoNoNegativo(totalAsignaciones) || totalAsignaciones <= 0) return null
  if (!finitoNoNegativo(totalAceptadas)) return null
  const rechazos = totalRechazos === undefined ? 0 : finitoNoNegativo(totalRechazos) ? totalRechazos : null
  if (rechazos === null) return null
  if (!tasaValida(tasaAceptacion)) return null
  return { totalAsignaciones, totalAceptadas, totalRechazos: rechazos, tasaAceptacion }
}

/**
 * Lectura única: v2 → legacy → sin historial. Nunca mezcla numeradores de
 * una fuente con denominadores de la otra.
 */
export function leerMetricasAceptacion(entrada: EntradaMetricasAceptacion): LecturaMetricasAceptacion {
  const v2 = leerV2(entrada.metricasAceptacion)
  if (v2) {
    return {
      fuente: 'v2',
      totalDecisiones: v2.totalDecisiones,
      totalAceptadas: v2.totalAceptadas,
      totalRechazadas: v2.totalRechazadas,
      tasaAceptacion: v2.tasaAceptacion,
      tasaPorcentaje: Math.round(v2.tasaAceptacion * 100),
    }
  }
  const legacy = leerLegacy(entrada)
  if (legacy) {
    return {
      fuente: 'legacy',
      totalDecisiones: legacy.totalAsignaciones,
      totalAceptadas: legacy.totalAceptadas,
      totalRechazadas: legacy.totalRechazos,
      tasaAceptacion: legacy.tasaAceptacion,
      tasaPorcentaje: Math.round(legacy.tasaAceptacion * 100),
    }
  }
  return {
    fuente: 'sin_historial',
    totalDecisiones: 0,
    totalAceptadas: 0,
    totalRechazadas: 0,
    tasaAceptacion: null,
    tasaPorcentaje: null,
  }
}
