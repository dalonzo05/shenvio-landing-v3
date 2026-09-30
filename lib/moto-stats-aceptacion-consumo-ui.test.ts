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
import { leerMetricasAceptacion } from './metricas-aceptacion-lectura'
import { formatearTasaAceptacion } from './tasa-aceptacion'

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

// ── ACM18 · el ranking no cambió EN ESTE BLOQUE (2H) ────────────────────────
// MOTO-RANKING-ACEPTACION-SIN-HISTORIAL-1 (2I) migró deliberadamente el
// componente de aceptación del ranking — exactamente la frontera que este
// test fijaba como "todavía no". Ya no se puede afirmar `?? 1.0` (2I lo
// retiró a propósito: favorecía a riders sin historial). La cobertura real
// de la fórmula nueva vive en lib/motorizado-ranking.test.ts (RA1-RA16,
// source-contract) y lib/motorizado-ranking-aceptacion.test.ts (RT1-RT6) —
// acá solo se reafirma que el ranking usa el helper dedicado, no que haya
// vuelto a leer campos legacy inline sin pasar por él.

test('ACM18 · lib/motorizado-ranking.ts migró a través de resolverAceptacionRanking(), no releyendo legacy inline', () => {
  const src = fuente(...RANKING)
  assert.ok(!src.includes('motorizado.tasaAceptacion ?? 1.0'), 'el fallback favorable de 2H-anterior no debe haber vuelto')
  assert.ok(src.includes("from './motorizado-ranking-aceptacion'"), 'debe migrar a través del helper dedicado, no releer campos legacy sueltos')
})

// ── CT1-CT10 · corrección post-preintegración (fallback legacy + universos) ─
// Bug encontrado en la preintegración: un rider cuya única historia legacy
// era un rechazo (totalAceptadas ausente) caía a 'sin_historial' en vez de
// 'legacy' 0% — corregido en lib/metricas-aceptacion-lectura.ts (LG1-LG7).
// Acá se fija el extremo a extremo: el mismo documento, pasado por el mismo
// pipeline (leerMetricasAceptacion → formatearTasaAceptacion) que usan ambas
// superficies, produce "0%" y no "—".

const RIDER_SOLO_RECHAZOS = { totalAsignaciones: 1, totalRechazos: 1, tasaAceptacion: 0 }

test('CT1 · Motorizados: rider legacy solo-rechazos muestra "0%", no "—"', () => {
  const metricas = leerMetricasAceptacion(RIDER_SOLO_RECHAZOS)
  assert.equal(formatearTasaAceptacion(metricas.tasaPorcentaje), '0%')
})

test('CT2 · Reportes: mismo pipeline, mismo resultado "0%"', () => {
  // Reportes y Motorizados comparten el mismo helper y el mismo formateador
  // (ACM14/ACM16b) — el pipeline es literalmente el mismo código, se prueba
  // una vez acá para el caso específico que bugueaba.
  const metricas = leerMetricasAceptacion(RIDER_SOLO_RECHAZOS)
  assert.equal(metricas.fuente, 'legacy')
  assert.equal(formatearTasaAceptacion(metricas.tasaPorcentaje), '0%')
})

function bloqueTheadPorMotorizado(src: string): string {
  const inicio = src.indexOf('<th className={thCls}>Motorizado</th>')
  assert.ok(inicio !== -1, 'no se encontró el <thead> de la tabla "Por motorizado"')
  const fin = src.indexOf('</tr>', inicio)
  return src.slice(inicio, fin)
}

test('CT3 · el <th> de la tabla (no solo el CSV) dice "Rechazos históricos"', () => {
  const bloque = bloqueTheadPorMotorizado(fuente(...REPORTES))
  assert.ok(bloque.includes('Rechazos históricos'))
})

test('CT4 · el <th> de la tabla (no solo el CSV) dice "Tasa aceptación histórica"', () => {
  const bloque = bloqueTheadPorMotorizado(fuente(...REPORTES))
  assert.ok(bloque.includes('Tasa aceptación histórica'))
})

test('CT5 · existe una nota visible (no oculta) que explica los dos universos temporales', () => {
  const src = fuente(...REPORTES)
  const inicio = src.indexOf('Por motorizado')
  const bloque = src.slice(inicio, inicio + 1200)
  assert.ok(bloque.includes('período seleccionado'))
  assert.ok(bloque.includes('históricos'))
  // Visible en el DOM, no un atributo title="" que solo aparece en hover.
  assert.ok(!/title="[^"]*históric/i.test(bloque), 'la nota debe ser texto visible, no un tooltip oculto')
})

test('CT6 · el CSV explicita "histórico"/"histórica" en sus encabezados', () => {
  const src = fuente(...REPORTES)
  assert.ok(src.includes("'Rechazos históricos'"))
  assert.ok(src.includes("'Tasa aceptación histórica %'"))
})

test('CT7 · Asignadas sigue siendo del período (agrupado desde `solicitudes`, sin tocar)', () => {
  const src = fuente(...REPORTES)
  assert.ok(src.includes('map[id].asignadas++'))
  assert.ok(src.includes('for (const s of solicitudes)'))
})

test('CT8 · Entregadas sigue siendo del período', () => {
  const src = fuente(...REPORTES)
  assert.ok(src.includes("if (s.estado === 'entregado') {\n        map[id].entregadas++"))
})

test('CT9 · Ingresos sigue siendo del período', () => {
  const src = fuente(...REPORTES)
  assert.ok(src.includes('map[id].ingresos += s.confirmacion?.precioFinalCordobas || 0'))
})

test('CT10 · tabla y CSV siguen indexando motorizadosMetricas por el mismo r.id (ACM15, reafirmado tras el fix de headers)', () => {
  const src = fuente(...REPORTES)
  assert.equal(src.split('motorizadosMetricas[r.id]').length - 1, 2)
})
