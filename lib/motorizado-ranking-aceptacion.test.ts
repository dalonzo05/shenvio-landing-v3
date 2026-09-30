// MOTO-RANKING-ACEPTACION-SIN-HISTORIAL-1 — suite del helper puro de
// scoring de aceptación. RA1-RA8 fijan los casos base (v2 madura, legacy,
// sin historial, 0%≠sin_historial, legacy solo-rechazos); RT1-RT6 fijan la
// continuidad de la transición v2/legacy con los valores EXACTOS pedidos
// por el bloque de implementación.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  resolverAceptacionRanking,
  MIN_DECISIONES_V2_RANKING,
  type ResultadoAceptacionRanking,
} from './motorizado-ranking-aceptacion'
import type { EntradaMetricasAceptacion } from './metricas-aceptacion-lectura'

const v2 = (totalAceptadas: number, totalRechazadas: number, tasaAceptacion?: number) => ({
  version: 2,
  desde: '2026-01-01T00:00:00.000Z',
  totalDecisiones: totalAceptadas + totalRechazadas,
  totalAceptadas,
  totalRechazadas,
  tasaAceptacion: tasaAceptacion ?? (totalAceptadas / (totalAceptadas + totalRechazadas)),
})

const cerca = (a: number, b: number, eps = 1e-9) => Math.abs(a - b) < eps

// ── RA1-RA3 · v2 madura (peso 1, >= MIN_DECISIONES_V2_RANKING) ─────────────

test('RA1 · v2 madura 100% (n=10) → scoreAceptacion 1.0, fuente v2', () => {
  const r = resolverAceptacionRanking({ metricasAceptacion: v2(10, 0) })
  assert.equal(r.scoreAceptacion, 1)
  assert.equal(r.fuente, 'v2')
  assert.equal(r.pesoV2, 1)
})

test('RA2 · v2 madura 50% (n=10) → scoreAceptacion 0.5, fuente v2', () => {
  const r = resolverAceptacionRanking({ metricasAceptacion: v2(5, 5) })
  assert.equal(r.scoreAceptacion, 0.5)
  assert.equal(r.fuente, 'v2')
})

test('RA3 · v2 madura 0% (n=10) → scoreAceptacion 0, fuente v2', () => {
  const r = resolverAceptacionRanking({ metricasAceptacion: v2(0, 10) })
  assert.equal(r.scoreAceptacion, 0)
  assert.equal(r.fuente, 'v2')
})

// ── RA4 · fallback legacy ───────────────────────────────────────────────────

test('RA4 · legacy fallback 75% (sin v2) → scoreAceptacion 0.75, fuente legacy', () => {
  const r = resolverAceptacionRanking({ totalAsignaciones: 4, totalAceptadas: 3, tasaAceptacion: 0.75 })
  assert.equal(r.scoreAceptacion, 0.75)
  assert.equal(r.fuente, 'legacy')
  assert.equal(r.tasaV2, null)
})

// ── RA5 · sin historial = 0.5 (NO 1.0) ──────────────────────────────────────

test('RA5 · sin v2 ni legacy → scoreAceptacion 0.5, fuente sin_historial', () => {
  const r = resolverAceptacionRanking({})
  assert.equal(r.scoreAceptacion, 0.5)
  assert.equal(r.fuente, 'sin_historial')
  assert.notEqual(r.scoreAceptacion, 1.0, 'ya no debe favorecer con el máximo posible')
})

// ── RA6 · ejemplo obligatorio de transición ─────────────────────────────────

test('RA6 · legacy 90% + v2 50% (n=2) → 0.82 exacto', () => {
  const entrada: EntradaMetricasAceptacion = {
    totalAsignaciones: 20, totalAceptadas: 18, tasaAceptacion: 0.9,
    metricasAceptacion: v2(1, 1, 0.5),
  }
  const r = resolverAceptacionRanking(entrada)
  assert.ok(cerca(r.scoreAceptacion, 0.82), `esperado 0.82, fue ${r.scoreAceptacion}`)
  assert.equal(r.fuente, 'transicion')
  assert.equal(r.pesoV2, 0.2)
})

// ── RA7 · 0% real ≠ sin historial ───────────────────────────────────────────

test('RA7 · v2 madura 0% y sin_historial son estados DISTINTOS, nunca el mismo valor', () => {
  const cero = resolverAceptacionRanking({ metricasAceptacion: v2(0, 10) })
  const sinHistorial = resolverAceptacionRanking({})
  assert.equal(cero.scoreAceptacion, 0)
  assert.equal(sinHistorial.scoreAceptacion, 0.5)
  assert.notEqual(cero.scoreAceptacion, sinHistorial.scoreAceptacion)
  assert.notEqual(cero.fuente, sinHistorial.fuente)

  const legacyCero = resolverAceptacionRanking({ totalAsignaciones: 5, totalRechazos: 5, tasaAceptacion: 0 })
  assert.equal(legacyCero.scoreAceptacion, 0)
  assert.equal(legacyCero.fuente, 'legacy')
})

// ── RA8 · legacy solo-rechazos (reutiliza el fix de MOTO-STATS-ACEPTACION-CONSUMO-1) ─

test('RA8 · legacy con SOLO rechazos (totalAceptadas ausente) es válido → 0, no sin_historial', () => {
  const r = resolverAceptacionRanking({ totalAsignaciones: 1, totalRechazos: 1, tasaAceptacion: 0 })
  assert.equal(r.fuente, 'legacy')
  assert.equal(r.scoreAceptacion, 0)
  assert.equal(r.tasaLegacy, 0)
})

// ── Casos B-J restantes del bloque de implementación (A, F, G, H, I, J ya cubiertos arriba salvo estos) ─

test('Caso B · legacy 75%', () => {
  assert.equal(resolverAceptacionRanking({ totalAsignaciones: 4, totalAceptadas: 3, tasaAceptacion: 0.75 }).scoreAceptacion, 0.75)
})

test('Caso G · sin legacy + v2 100% n=1 → 0.55', () => {
  const r = resolverAceptacionRanking({ metricasAceptacion: v2(1, 0, 1) })
  assert.ok(cerca(r.scoreAceptacion, 0.55), `esperado 0.55, fue ${r.scoreAceptacion}`)
  assert.equal(r.fuente, 'transicion')
})

test('Caso H · sin legacy + v2 100% n=5 → 0.75', () => {
  const r = resolverAceptacionRanking({ metricasAceptacion: v2(5, 0, 1) })
  assert.ok(cerca(r.scoreAceptacion, 0.75), `esperado 0.75, fue ${r.scoreAceptacion}`)
})

test('Caso I · sin legacy + v2 100% n=10 → 1.0, fuente v2', () => {
  const r = resolverAceptacionRanking({ metricasAceptacion: v2(10, 0, 1) })
  assert.equal(r.scoreAceptacion, 1)
  assert.equal(r.fuente, 'v2')
})

test('Caso J · legacy 100% + v2 0% n=5 → 0.50', () => {
  const entrada: EntradaMetricasAceptacion = {
    totalAsignaciones: 10, totalAceptadas: 10, tasaAceptacion: 1,
    metricasAceptacion: v2(0, 5, 0),
  }
  const r = resolverAceptacionRanking(entrada)
  assert.ok(cerca(r.scoreAceptacion, 0.5), `esperado 0.5, fue ${r.scoreAceptacion}`)
})

// ── RT1-RT6 · continuidad de la transición (legacy 90% + v2 50% fijo, n creciente) ─
// legacy 90% + v2 tasaAceptacion=0.5 fijo (independiente de n): el helper usa
// v2.tasaAceptacion directo, no lo recalcula desde aceptadas/rechazadas — el
// split exacto de aceptadas/rechazadas dentro de n es irrelevante acá.

function legacyMasV2(n: number): EntradaMetricasAceptacion {
  const aceptadas = Math.ceil(n / 2)
  return {
    totalAsignaciones: 20, totalAceptadas: 18, tasaAceptacion: 0.9,
    metricasAceptacion: n > 0 ? v2(aceptadas, n - aceptadas, 0.5) : undefined,
  }
}

test('RT1 · legacy 90% sin v2 válida (n=0 no existe como forma válida) → 90% (legacy puro)', () => {
  // v2 con totalDecisiones=0 nunca la produce el writer real (proyectarMetricasAceptacion
  // solo corre tras una decisión) y leerV2() la rechaza — se adapta el fixture
  // a la forma válida real: ausencia total de metricasAceptacion.
  const r = resolverAceptacionRanking(legacyMasV2(0))
  assert.equal(r.fuente, 'legacy')
  assert.ok(cerca(r.scoreAceptacion, 0.9))
})

test('RT2 · legacy 90% + v2 50% (n=1) → 86%', () => {
  const r = resolverAceptacionRanking(legacyMasV2(1))
  assert.ok(cerca(r.scoreAceptacion, 0.86), `esperado 0.86, fue ${r.scoreAceptacion}`)
  assert.equal(r.fuente, 'transicion')
})

test('RT3 · legacy 90% + v2 50% (n=5) → 70%', () => {
  const r = resolverAceptacionRanking(legacyMasV2(5))
  assert.ok(cerca(r.scoreAceptacion, 0.70), `esperado 0.70, fue ${r.scoreAceptacion}`)
})

test('RT4 · legacy 90% + v2 50% (n=9) → 54%', () => {
  const r = resolverAceptacionRanking(legacyMasV2(9))
  assert.ok(cerca(r.scoreAceptacion, 0.54), `esperado 0.54, fue ${r.scoreAceptacion}`)
})

test('RT5 · legacy 90% + v2 50% (n=10) → 50% (v2 puro, transición completa)', () => {
  const r = resolverAceptacionRanking(legacyMasV2(10))
  assert.ok(cerca(r.scoreAceptacion, 0.50))
  assert.equal(r.fuente, 'v2')
  assert.equal(r.pesoV2, 1)
})

test('RT6 · legacy 90% + v2 50% (n=20) → 50% (mismo resultado que n=10, peso saturado)', () => {
  const r = resolverAceptacionRanking(legacyMasV2(20))
  assert.ok(cerca(r.scoreAceptacion, 0.50))
  assert.equal(r.pesoV2, 1, 'el peso no debe superar 1 aunque n > MIN_DECISIONES_V2_RANKING')
})

// ── Constante y continuidad genérica ────────────────────────────────────────

test('MIN_DECISIONES_V2_RANKING === 10', () => {
  assert.equal(MIN_DECISIONES_V2_RANKING, 10)
})

test('continuidad · pesoV2 crece monótonamente con totalDecisionesV2 hasta 1', () => {
  const pesos: number[] = []
  for (let n = 0; n <= 12; n++) {
    const r: ResultadoAceptacionRanking = resolverAceptacionRanking(
      n > 0 ? { metricasAceptacion: v2(Math.ceil(n / 2), n - Math.ceil(n / 2), 0.5) } : {}
    )
    pesos.push(r.pesoV2)
  }
  for (let i = 1; i < pesos.length; i++) assert.ok(pesos[i] >= pesos[i - 1], `pesoV2 no debe decrecer (${pesos})`)
  assert.equal(pesos[pesos.length - 1], 1)
})
