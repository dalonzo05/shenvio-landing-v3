// MOTO-RANKING-ACEPTACION-SIN-HISTORIAL-1 — política de scoring de
// aceptación para el ranking de candidatos. Separado a propósito de
// lib/metricas-aceptacion-lectura.ts: ese archivo decide UNA fuente ganadora
// para presentación (v2 gana, legacy es fallback, "—" si no hay nada); este
// archivo necesita v2 Y legacy SIMULTÁNEAMENTE para interpolar entre ambas
// durante la transición — un contrato distinto, no una variación del mismo.
//
// PROBLEMA QUE RESUELVE (diagnóstico previo, mismo bloque):
//   1. El ranking leía motorizado.tasaAceptacion ?? 1.0 — un rider sin
//      historial recibía el score de aceptación MÁS ALTO posible (idéntico
//      a un veterano con 100% real), no un valor neutral.
//   2. penalizacionRechazos (basada en totalRechazos lifetime) penalizaba
//      la MISMA información que ya refleja la tasa, con sesgo de volumen:
//      un rider con 20 rechazos de 1000 decisiones (98%) recibía la misma
//      resta absoluta que uno con 20 de 100 (80%).
//   3. v2 no tiene backfill — un rider con historia legacy larga y solo 1-2
//      decisiones v2 recientes vería su score saltar abruptamente si v2
//      reemplazara a legacy de golpe (como sí es correcto hacerlo en UI).
//
// CONTRATO (decisiones de producto ya cerradas para este bloque):
//   - Sin ningún historial → 0.5 (neutral matemático del rango [0,1], no 1.0).
//   - Solo legacy válido → usar su tasa tal cual.
//   - v2 válida (con o sin legacy) → interpolar linealmente entre la base
//     (legacy si existe, si no 0.5) y la tasa v2, según cuántas decisiones
//     v2 tiene el rider — de 0 a MIN_DECISIONES_V2_RANKING decisiones el peso
//     de v2 crece de 0 a 1; a partir de ahí, v2 puro.
//   - penalizacionRechazos queda ELIMINADA del ranking (no de Firestore, no
//     del tipo, no de otros contextos): ya está reflejada en la tasa.
//
// PURO: sin Firestore, sin React, sin Date.now().

import { leerV2, leerLegacy, type EntradaMetricasAceptacion } from './metricas-aceptacion-lectura'

/** Decisiones v2 necesarias para que el score de ranking sea 100% v2 puro. */
export const MIN_DECISIONES_V2_RANKING = 10

export type FuenteAceptacionRanking = 'sin_historial' | 'legacy' | 'transicion' | 'v2'

export interface ResultadoAceptacionRanking {
  /** 0–1. Único valor que el ranking multiplica por su peso (10%). */
  scoreAceptacion: number
  fuente: FuenteAceptacionRanking
  tasaV2: number | null
  tasaLegacy: number | null
  totalDecisionesV2: number
  /** 0–1. Cuánto pesa v2 en la interpolación; 0 sin v2, 1 desde MIN_DECISIONES_V2_RANKING. */
  pesoV2: number
}

/**
 * Resuelve el score de aceptación (0–1) de un motorizado para el ranking.
 *
 * v2 con pocas decisiones no reemplaza de golpe una tasa legacy con volumen
 * real: se interpola. La base de la interpolación es la tasa legacy si
 * existe (compatibilidad con historia pre-v2, que v2 nunca tuvo backfill) o
 * 0.5 si no hay legacy tampoco (nunca 1.0: ver contrato arriba).
 */
export function resolverAceptacionRanking(motorizado: EntradaMetricasAceptacion): ResultadoAceptacionRanking {
  const v2 = leerV2(motorizado.metricasAceptacion)
  const legacy = leerLegacy(motorizado)
  const tasaLegacy = legacy ? legacy.tasaAceptacion : null

  if (!v2) {
    if (legacy) {
      return {
        scoreAceptacion: legacy.tasaAceptacion,
        fuente: 'legacy',
        tasaV2: null,
        tasaLegacy,
        totalDecisionesV2: 0,
        pesoV2: 0,
      }
    }
    return {
      scoreAceptacion: 0.5,
      fuente: 'sin_historial',
      tasaV2: null,
      tasaLegacy: null,
      totalDecisionesV2: 0,
      pesoV2: 0,
    }
  }

  const pesoV2 = Math.min(v2.totalDecisiones / MIN_DECISIONES_V2_RANKING, 1)
  const baseTransicion = legacy ? legacy.tasaAceptacion : 0.5
  const scoreAceptacion = baseTransicion * (1 - pesoV2) + v2.tasaAceptacion * pesoV2

  return {
    scoreAceptacion,
    fuente: pesoV2 >= 1 ? 'v2' : 'transicion',
    tasaV2: v2.tasaAceptacion,
    tasaLegacy,
    totalDecisionesV2: v2.totalDecisiones,
    pesoV2,
  }
}
