// MOTO-STATS-ACEPTACION-CONSUMO-1 — fija en el código fuente real que
// app/panel/gestor/motorizados/page.tsx y app/panel/gestor/reportes/page.tsx
// dejaron de reconstruir aceptación/rechazo consultando
// asignacion.estadoAceptacion en solicitudes_envio (un valor que la
// arquitectura viva nunca persiste como 'rechazada' — un rechazo pone
// asignacion: null en la misma transacción) y ahora consumen
// leerMetricasAceptacion() sobre el documento del motorizado. Mismo patrón
// de este repo para componentes sin runner de UI/DOM
// (lib/reasignacion-post-retiro-ui.test.ts, lib/moto-ranking-modal-ux.test.ts).

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

function fuente(...ruta: string[]): string {
  return readFileSync(join(__dirname, '..', ...ruta), 'utf8').replace(/\r/g, '')
}

const MOTORIZADOS = ['app', 'panel', 'gestor', 'motorizados', 'page.tsx']
const REPORTES = ['app', 'panel', 'gestor', 'reportes', 'page.tsx']
const RANKING = ['lib', 'motorizado-ranking.ts']

// ── ACM11-ACM12 · Motorizados ───────────────────────────────────────────────

test('ACM11 · Motorizados ya no consulta asignacion.estadoAceptacion para estadística histórica', () => {
  const src = fuente(...MOTORIZADOS)
  assert.ok(!src.includes("'asignacion.estadoAceptacion'"), 'no debe quedar ningún where(\'asignacion.estadoAceptacion\', ...)')
  assert.ok(!src.includes("orderBy('updatedAt'"), 'la query de "últimos rechazos" (dependiente del mismo bug) también se retiró')
})

test('ACM12 · Motorizados consume leerMetricasAceptacion() sobre el documento del rider', () => {
  const src = fuente(...MOTORIZADOS)
  assert.ok(src.includes("import { leerMetricasAceptacion } from '@/lib/metricas-aceptacion-lectura'"))
  assert.ok(src.includes('leerMetricasAceptacion(motorizado)'))
  // fetchStats recibe el documento ya en memoria (realtime), no un id para re-consultar aceptación.
  assert.ok(src.includes('async function fetchStats(motorizadoId: string, motorizado: Motorizado)'))
  assert.ok(src.includes('fetchStats(m.id, m)'))
})

// ── ACM13-ACM14 · Reportes ───────────────────────────────────────────────────

test('ACM13 · Reportes ya no compara asignacion.estadoAceptacion === \'rechazada\' para histórico', () => {
  const src = fuente(...REPORTES)
  assert.ok(!src.includes("estadoAceptacion === 'rechazada'"))
})

test('ACM14 · Reportes consume el mismo helper canónico', () => {
  const src = fuente(...REPORTES)
  assert.ok(src.includes("import { leerMetricasAceptacion, type LecturaMetricasAceptacion } from '@/lib/metricas-aceptacion-lectura'"))
  assert.ok(src.includes('leerMetricasAceptacion(d.data()'))
})

// ── ACM15 · tabla y CSV comparten métrica ───────────────────────────────────

test('ACM15 · la tabla y el CSV de Reportes leen motorizadosMetricas[r.id] — mismo objeto, no dos cálculos', () => {
  const src = fuente(...REPORTES)
  const ocurrencias = src.split('motorizadosMetricas[r.id]').length - 1
  assert.equal(ocurrencias, 2, 'debe aparecer exactamente 2 veces: una en exportCSV(), otra en el render de la tabla')
  assert.ok(!src.includes('const tot = r.asignadas + r.rechazadas'), 'no debe quedar el cálculo viejo de tasa a partir de "rechazadas" local')
})

// ── ACM16 · sin historial ────────────────────────────────────────────────────

test('ACM16 · Motorizados usa formatearTasaAceptacion (contrato "—") para la tasa', () => {
  const src = fuente(...MOTORIZADOS)
  assert.ok(src.includes("import { estiloTasaAceptacion, formatearTasaAceptacion } from '@/lib/tasa-aceptacion'"))
  assert.ok(src.includes('formatearTasaAceptacion(stats?.tasaAceptacion)'))
})

test('ACM16b · Reportes usa formatearTasaAceptacion en la tabla y deja la celda de tasa vacía (no 0 ni 100) en el CSV sin historial', () => {
  const src = fuente(...REPORTES)
  assert.ok(src.includes('formatearTasaAceptacion(tasaAcept)'))
  assert.ok(src.includes("const tasa = m?.tasaPorcentaje ?? ''"))
})

// ── ACM17 · sin query de aceptación por rider, sin N+1 nuevo ───────────────

test('ACM17 · Reportes carga las métricas de motorizados en UNA lectura bulk, no por rider', () => {
  const src = fuente(...REPORTES)
  assert.ok(src.includes("getDocs(collection(db, 'motorizado'))"), 'debe existir la lectura bulk de la colección completa')
  const ocurrenciasBulk = src.split("getDocs(collection(db, 'motorizado'))").length - 1
  assert.equal(ocurrenciasBulk, 1, 'debe ser UNA sola lectura, no una por rider')
  // Ningún getDoc(doc(db, 'motorizado', id)) individual en todo el archivo.
  assert.ok(!src.includes("doc(db, 'motorizado',"), 'no debe haber getDoc individual por rider')
})

test('ACM17b · Motorizados no agrega queries nuevas por rider para aceptación (fetchStats bajó de 6 a 4 llamadas Firestore)', () => {
  const src = fuente(...MOTORIZADOS)
  const inicio = src.indexOf('async function fetchStats(')
  const finPromiseAll = src.indexOf('])', src.indexOf('Promise.all([', inicio))
  const bloque = src.slice(inicio, finPromiseAll)
  const llamadas = (bloque.match(/getCountFromServer\(|getDocs\(/g) ?? []).length
  assert.equal(llamadas, 4, 'fetchStats debe hacer 4 lecturas Firestore (total/hoy/semana/depósitos), ya no 6')
})

// ── ACM18 · el ranking no cambia en este bloque ─────────────────────────────

test('ACM18 · lib/motorizado-ranking.ts sigue sin tocar: mismo fallback legacy, mismo campo', () => {
  const src = fuente(...RANKING)
  assert.ok(src.includes('const scoreAceptacion = motorizado.tasaAceptacion ?? 1.0'))
  assert.ok(src.includes('motorizado.totalRechazos'))
  assert.ok(!src.includes('metricasAceptacion'), 'el ranking no debe empezar a leer metricasAceptacion en este bloque — eso es MOTO-RANKING-ACEPTACION-SIN-HISTORIAL-1')
})
