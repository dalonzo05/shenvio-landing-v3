// MOTO-STATS-ACEPTACION-UNDEFINED-1 — la ficha nunca muestra undefined%, null%,
// NaN% ni Infinity%.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import {
  TASA_SIN_DATO,
  esTasaAceptacionValida,
  estiloTasaAceptacion,
  formatearTasaAceptacion,
} from './tasa-aceptacion'

const PAGINA = () => readFileSync(join(__dirname, '..', 'app', 'panel', 'gestor', 'motorizados', 'page.tsx'), 'utf8').replace(/\r/g, '')

test('MSA1 · undefined → —', () => {
  assert.equal(formatearTasaAceptacion(undefined), '—')
  assert.equal(TASA_SIN_DATO, '—')
})

test('MSA2 · null → —', () => {
  assert.equal(formatearTasaAceptacion(null), '—')
})

test('MSA3 · NaN → —', () => {
  assert.equal(formatearTasaAceptacion(NaN), '—')
})

test('MSA4 · Infinity y -Infinity → —', () => {
  assert.equal(formatearTasaAceptacion(Infinity), '—')
  assert.equal(formatearTasaAceptacion(-Infinity), '—')
})

test('MSA5 · 0 válido → 0% (cero no es ausencia)', () => {
  assert.equal(formatearTasaAceptacion(0), '0%')
  assert.equal(esTasaAceptacionValida(0), true)
})

test('MSA6 · 100 válido → 100%', () => {
  assert.equal(formatearTasaAceptacion(100), '100%')
})

test('MSA7 · valor intermedio → <n>%', () => {
  assert.equal(formatearTasaAceptacion(57), '57%')
  assert.equal(formatearTasaAceptacion(70), '70%')
})

test('MSA8 · valor menor que 0 → — (sin recortar)', () => {
  assert.equal(formatearTasaAceptacion(-1), '—')
  assert.equal(formatearTasaAceptacion(-0.5), '—')
})

test('MSA9 · valor mayor que 100 → — (sin recortar)', () => {
  assert.equal(formatearTasaAceptacion(101), '—')
  assert.equal(formatearTasaAceptacion(1000), '—')
})

test('MSA10 · sin dato → la tarjeta NO queda en estado de tasa baja', () => {
  for (const v of [undefined, null, NaN, Infinity, -1, 101, '57', {}]) {
    assert.equal(estiloTasaAceptacion(v), 'sin_dato', String(v))
    assert.notEqual(estiloTasaAceptacion(v), 'baja')
  }
})

test('MSA11 · 0 real conserva el tratamiento de tasa baja; el umbral 70 no cambia', () => {
  assert.equal(estiloTasaAceptacion(0), 'baja')
  assert.equal(estiloTasaAceptacion(69), 'baja')
  assert.equal(estiloTasaAceptacion(70), 'normal')
  assert.equal(estiloTasaAceptacion(100), 'normal')
})

test('MSA12 · el JSX ya no concatena el porcentaje a mano (contrato de presentación intacto)', () => {
  const src = PAGINA()
  // MOTO-STATS-ACEPTACION-CONSUMO-1 — la fórmula que calculaba esta ficha
  // consultando solicitudes_envio quedó retirada (era la misma reconstrucción
  // rota que MOTO-STATS-ACEPTACION-CONSUMO-1 diagnosticó): ahora sale de
  // leerMetricasAceptacion() sobre el documento del motorizado. Lo que este
  // test seguía protegiendo — el JSX de presentación, no la fórmula vieja —
  // sigue intacto y se reafirma acá.
  assert.ok(!src.includes('const tasaAceptacion = (aceptadas + rechazadas) > 0'), 'la fórmula vieja (reconstrucción rota) ya no debe existir')
  assert.ok(!src.includes("where('asignacion.estadoAceptacion', '==', 'aceptada')"))
  assert.ok(!src.includes("where('asignacion.estadoAceptacion', '==', 'rechazada')"))
  assert.ok(src.includes("import { leerMetricasAceptacion } from '@/lib/metricas-aceptacion-lectura'"))
  assert.ok(src.includes('const metricas = leerMetricasAceptacion(motorizado)'))
  assert.ok(src.includes('const tasaAceptacion = metricas.tasaPorcentaje'))
  // Bug original: undefined !== null → `${undefined}%`.
  assert.ok(!/stats\?\.tasaAceptacion\}%/.test(src), 'no se interpola stats?.tasaAceptacion directo')
  assert.ok(!/stats\?\.tasaAceptacion !== null/.test(src), 'no se decide por !== null')
  assert.ok(src.includes('formatearTasaAceptacion(stats?.tasaAceptacion)'))
  assert.ok(src.includes('estiloTasaAceptacion(stats?.tasaAceptacion)'))
})

test('caso real · carga terminada con stats = null → "—" y tarjeta neutral (antes: "undefined%" en rojo)', () => {
  const stats = null as { tasaAceptacion: number | null } | null
  assert.equal(formatearTasaAceptacion(stats?.tasaAceptacion), '—')
  assert.equal(estiloTasaAceptacion(stats?.tasaAceptacion), 'sin_dato')
})

test('otras tarjetas · Hoy, Semana, Total, Rechazos y Dep. pend. ya degradan con ?? "—", sin el mismo defecto', () => {
  const src = PAGINA()
  assert.ok(src.includes("(k.value ?? '—')"))
  assert.ok(src.includes("(stats?.rechazos ?? '—')"))
  assert.ok(src.includes("(stats?.depositosPendientes ?? '—')"))
})
