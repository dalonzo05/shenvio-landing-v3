// MOTO-STATS-ACEPTACION-CONSUMO-1 — suite del helper de lectura único.
// ACM1-ACM10 fijan el contrato de precedencia/degradación; los casos A-F son
// los fixtures reales pedidos por el bloque de implementación.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { leerMetricasAceptacion, type EntradaMetricasAceptacion } from './metricas-aceptacion-lectura'

const v2 = (totalAceptadas: number, totalRechazadas: number, tasaAceptacion?: number) => ({
  metricasAceptacion: {
    version: 2,
    desde: '2026-01-01T00:00:00.000Z',
    totalDecisiones: totalAceptadas + totalRechazadas,
    totalAceptadas,
    totalRechazadas,
    tasaAceptacion: tasaAceptacion ?? (totalAceptadas / (totalAceptadas + totalRechazadas)),
  },
})

// ── ACM1-ACM4 · casos porcentuales básicos ──────────────────────────────────

test('ACM1 · v2 1/2 → 50%', () => {
  const r = leerMetricasAceptacion(v2(1, 1))
  assert.equal(r.fuente, 'v2')
  assert.equal(r.tasaPorcentaje, 50)
  assert.equal(r.totalDecisiones, 2)
})

test('ACM2 · v2 3/3 → 100%', () => {
  const r = leerMetricasAceptacion(v2(3, 0))
  assert.equal(r.tasaPorcentaje, 100)
})

test('ACM3 · v2 0/2 → 0% (no "—")', () => {
  const r = leerMetricasAceptacion(v2(0, 2))
  assert.equal(r.tasaPorcentaje, 0)
  assert.notEqual(r.tasaPorcentaje, null)
})

test('ACM4 · sin historial → null (UI la muestra como "—")', () => {
  const r = leerMetricasAceptacion({})
  assert.equal(r.fuente, 'sin_historial')
  assert.equal(r.tasaAceptacion, null)
  assert.equal(r.tasaPorcentaje, null)
})

// ── ACM5-ACM7 · precedencia ──────────────────────────────────────────────────

test('ACM5 · v2 tiene precedencia sobre legacy, aunque legacy diga otra cosa', () => {
  const entrada: EntradaMetricasAceptacion = {
    ...v2(1, 1), // 50%
    tasaAceptacion: 1.0, // legacy dice 100%
    totalAsignaciones: 5,
    totalAceptadas: 5,
  }
  const r = leerMetricasAceptacion(entrada)
  assert.equal(r.fuente, 'v2')
  assert.equal(r.tasaPorcentaje, 50)
})

test('ACM6 · legacy válido funciona cuando no existe v2', () => {
  const r = leerMetricasAceptacion({ totalAsignaciones: 4, totalAceptadas: 3, totalRechazos: 1, tasaAceptacion: 0.75 })
  assert.equal(r.fuente, 'legacy')
  assert.equal(r.tasaPorcentaje, 75)
  assert.equal(r.totalAceptadas, 3)
  assert.equal(r.totalRechazadas, 1)
})

test('ACM7 · version distinta de 2 no se trata como v2 autoritativa (cae a legacy o sin historial)', () => {
  const conLegacy = leerMetricasAceptacion({
    metricasAceptacion: { version: 1, totalDecisiones: 2, totalAceptadas: 1, totalRechazadas: 1, tasaAceptacion: 0.5 },
    totalAsignaciones: 4, totalAceptadas: 3, totalRechazos: 1, tasaAceptacion: 0.75,
  })
  assert.equal(conLegacy.fuente, 'legacy')
  assert.equal(conLegacy.tasaPorcentaje, 75)

  const sinLegacy = leerMetricasAceptacion({
    metricasAceptacion: { version: 3, totalDecisiones: 2, totalAceptadas: 1, totalRechazadas: 1, tasaAceptacion: 0.5 },
  })
  assert.equal(sinLegacy.fuente, 'sin_historial')
})

// ── LG1-LG7 · fallback legacy — totalAceptadas/totalRechazos ausentes ──────
// espejoLegacy() (functions/src/asignacion-respuesta.ts) escribe cada
// contador SOLO en su propia rama: aceptar() nunca incluye totalRechazos en
// el patch, rechazar() nunca incluye totalAceptadas. Un rider cuya ÚNICA
// historia sea un rechazo es legítimo y real, y antes de este fix caía
// incorrectamente a 'sin_historial' en vez de 'legacy' con 0%.

test('LG1 · 1 asignación, 1 rechazo, totalAceptadas ausente, tasa 0 → legacy 0%', () => {
  const r = leerMetricasAceptacion({ totalAsignaciones: 1, totalRechazos: 1, tasaAceptacion: 0 })
  assert.deepEqual(r, {
    fuente: 'legacy',
    totalDecisiones: 1,
    totalAceptadas: 0,
    totalRechazadas: 1,
    tasaAceptacion: 0,
    tasaPorcentaje: 0,
  })
})

test('LG2 · 2 asignaciones, 2 rechazos, totalAceptadas ausente → 0%', () => {
  const r = leerMetricasAceptacion({ totalAsignaciones: 2, totalRechazos: 2, tasaAceptacion: 0 })
  assert.equal(r.fuente, 'legacy')
  assert.equal(r.totalAceptadas, 0)
  assert.equal(r.totalRechazadas, 2)
  assert.equal(r.tasaPorcentaje, 0)
})

test('LG3 · 2 asignaciones, 2 aceptaciones, totalRechazos ausente → 100%', () => {
  const r = leerMetricasAceptacion({ totalAsignaciones: 2, totalAceptadas: 2, tasaAceptacion: 1 })
  assert.equal(r.fuente, 'legacy')
  assert.equal(r.totalAceptadas, 2)
  assert.equal(r.totalRechazadas, 0)
  assert.equal(r.tasaPorcentaje, 100)
})

test('LG4 · aceptadas y rechazadas presentes → cálculo esperado (regresión de ACM6)', () => {
  const r = leerMetricasAceptacion({ totalAsignaciones: 4, totalAceptadas: 3, totalRechazos: 1, tasaAceptacion: 0.75 })
  assert.equal(r.fuente, 'legacy')
  assert.equal(r.totalAceptadas, 3)
  assert.equal(r.totalRechazadas, 1)
  assert.equal(r.tasaPorcentaje, 75)
})

test('LG5 · v2 válida sigue ganando aunque exista legacy solo-rechazos', () => {
  const entrada: EntradaMetricasAceptacion = {
    metricasAceptacion: { version: 2, totalDecisiones: 3, totalAceptadas: 2, totalRechazadas: 1, tasaAceptacion: 2 / 3 },
    totalAsignaciones: 1, totalRechazos: 1, tasaAceptacion: 0,
  }
  const r = leerMetricasAceptacion(entrada)
  assert.equal(r.fuente, 'v2')
  assert.equal(r.tasaPorcentaje, 67)
})

test('LG6 · sin campos de historial reales (ni v2 ni legacy) → sin_historial', () => {
  assert.equal(leerMetricasAceptacion({}).fuente, 'sin_historial')
  assert.equal(leerMetricasAceptacion({ totalAsignaciones: 0 }).fuente, 'sin_historial')
  // tasa inválida no fabrica historial aunque totalAsignaciones sea válido.
  assert.equal(leerMetricasAceptacion({ totalAsignaciones: 2, totalRechazos: 2, tasaAceptacion: NaN }).fuente, 'sin_historial')
})

test('LG7 · 0% legacy no se confunde con "—" (tasaPorcentaje/tasaAceptacion nunca null cuando fuente es legacy)', () => {
  const r = leerMetricasAceptacion({ totalAsignaciones: 1, totalRechazos: 1, tasaAceptacion: 0 })
  assert.notEqual(r.tasaPorcentaje, null)
  assert.notEqual(r.tasaAceptacion, null)
  assert.equal(r.tasaPorcentaje, 0)
})

// ── ACM8 · datos inválidos degradan seguro ──────────────────────────────────

test('ACM8 · datos inválidos degradan a legacy o sin_historial, nunca rompen ni inventan', () => {
  const casos: Array<[string, EntradaMetricasAceptacion]> = [
    ['tasaAceptacion NaN en v2', { metricasAceptacion: { version: 2, totalDecisiones: 2, totalAceptadas: 1, totalRechazadas: 1, tasaAceptacion: NaN } }],
    ['tasaAceptacion fuera de rango en v2', { metricasAceptacion: { version: 2, totalDecisiones: 2, totalAceptadas: 1, totalRechazadas: 1, tasaAceptacion: 4 } }],
    ['totales negativos en v2', { metricasAceptacion: { version: 2, totalDecisiones: 2, totalAceptadas: -1, totalRechazadas: 3, tasaAceptacion: 0.5 } }],
    ['suma inconsistente en v2', { metricasAceptacion: { version: 2, totalDecisiones: 5, totalAceptadas: 1, totalRechazadas: 1, tasaAceptacion: 0.5 } }],
    ['totalDecisiones 0 en v2 (forma que el writer nunca produce)', { metricasAceptacion: { version: 2, totalDecisiones: 0, totalAceptadas: 0, totalRechazadas: 0, tasaAceptacion: 0.5 } }],
    ['legacy con tasaAceptacion fuera de rango', { totalAsignaciones: 4, totalAceptadas: 3, tasaAceptacion: 1.5 }],
    ['legacy con totalAsignaciones 0', { totalAsignaciones: 0, totalAceptadas: 0, tasaAceptacion: 0 }],
    ['legacy con totalRechazos no numérico', { totalAsignaciones: 4, totalAceptadas: 3, totalRechazos: 'x' as unknown as number, tasaAceptacion: 0.75 }],
  ]
  for (const [nombre, entrada] of casos) {
    const r = leerMetricasAceptacion(entrada)
    assert.ok(r.fuente === 'legacy' || r.fuente === 'sin_historial', `${nombre}: no debe usar v2 inválida (fuente=${r.fuente})`)
    if (r.fuente === 'sin_historial') {
      assert.equal(r.tasaPorcentaje, null)
    }
  }
})

// ── ACM9 · el estado de una orden individual no interviene ─────────────────

test('ACM9 · un campo asignacion.estadoAceptacion en la entrada no afecta el resultado', () => {
  const base = v2(1, 1)
  const conRuido = { ...base, asignacion: { estadoAceptacion: 'aceptada' } } as EntradaMetricasAceptacion
  const r1 = leerMetricasAceptacion(base)
  const r2 = leerMetricasAceptacion(conRuido)
  assert.deepEqual(r1, r2)
})

// ── ACM10 · la aceptación histórica sobrevive a una reasignación conceptual ─

test('ACM10 · totalDecisiones es acumulativo y no depende de la asignación actual de la orden', () => {
  // A aceptó una orden que luego se reasignó a B: la orden actual ya no
  // referencia a A en absoluto (asignacion.motorizadoId apunta a B), pero
  // metricasAceptacion de A es un acumulador propio de SU documento —
  // el helper no lee nada de la orden, solo del motorizado.
  const documentoDeA: EntradaMetricasAceptacion = v2(1, 0) // A aceptó 1 vez, en su propio documento
  const r = leerMetricasAceptacion(documentoDeA)
  assert.equal(r.fuente, 'v2')
  assert.equal(r.totalAceptadas, 1)
  assert.equal(r.tasaPorcentaje, 100)
})

// ── Casos reales A-F (fixtures del bloque) ──────────────────────────────────

test('Caso A · 1 aceptación + 1 rechazo → 50%', () => {
  assert.equal(leerMetricasAceptacion(v2(1, 1)).tasaPorcentaje, 50)
})

test('Caso B · 0 decisiones → sin historial ("—" en UI)', () => {
  const r = leerMetricasAceptacion({})
  assert.equal(r.tasaPorcentaje, null)
})

test('Caso C · 3 aceptaciones → 100%', () => {
  assert.equal(leerMetricasAceptacion(v2(3, 0)).tasaPorcentaje, 100)
})

test('Caso D · 2 rechazos → 0%', () => {
  assert.equal(leerMetricasAceptacion(v2(0, 2)).tasaPorcentaje, 0)
})

test('Caso E · v2 50% + legacy 100% → 50% (v2 gana)', () => {
  const entrada: EntradaMetricasAceptacion = { ...v2(1, 1), totalAsignaciones: 3, totalAceptadas: 3, tasaAceptacion: 1.0 }
  assert.equal(leerMetricasAceptacion(entrada).tasaPorcentaje, 50)
})

test('Caso F · solo legacy 75% → 75%', () => {
  const r = leerMetricasAceptacion({ totalAsignaciones: 4, totalAceptadas: 3, totalRechazos: 1, tasaAceptacion: 0.75 })
  assert.equal(r.tasaPorcentaje, 75)
  assert.equal(r.totalDecisiones, 4)
})
