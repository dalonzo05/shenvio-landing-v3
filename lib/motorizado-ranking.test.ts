// MOTO-RANKING-REFERENCIA-UX-1 — getReferenciaGeografica expone CON QUÉ
// CRITERIO se llegó al punto que ya usaba el ranking (próxima orden activa /
// última ubicación operativa fresca / ubicación base / sin referencia), sin
// cambiar ni un número. getProximoPuntoOperativo pasa a ser un envoltorio
// de esta función — lib/motorizado-presencia.test.ts y
// lib/motorizado-candidatos.test.ts ya cubren que su `.coord` no cambió
// (63/63 y 31/31 PASS antes y después del refactor); este archivo prueba
// específicamente la metadata nueva y que el score/orden sigan intactos.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import {
  getReferenciaGeografica,
  getProximoPuntoOperativo,
  calcularScore,
  rankearMotorizados,
  type MotorizadoConRanking,
  type OrdenActivaRanking,
  type NuevaOrdenRanking,
} from './motorizado-ranking'

const AHORA = new Date('2026-09-28T18:00:00.000Z').getTime() // 12:00 Managua

const moto = (id: string, extra: Partial<MotorizadoConRanking> = {}): MotorizadoConRanking => ({
  id, nombre: id, estado: 'disponible', activo: true, ...extra,
})

const NUEVA: NuevaOrdenRanking = { recoleccion: { coord: { lat: 12.13, lng: -86.25 } } }

function fuente(...ruta: string[]): string {
  return readFileSync(join(__dirname, '..', ...ruta), 'utf8').replace(/\r/g, '')
}

const SUPERFICIES = [
  ['solicitudes/page.tsx', ['app', 'panel', 'gestor', 'solicitudes', 'page.tsx']],
  ['SolicitudDrawer.tsx', ['app', 'panel', 'gestor', '_components', 'SolicitudDrawer.tsx']],
  ['solicitudes/[id]/page.tsx', ['app', 'panel', 'gestor', 'solicitudes', '[id]', 'page.tsx']],
] as const

// ─── RX1-RX3 · orden activa → PROXIMO_PUNTO_OPERATIVO, con tipo y código ───────

test('RX1 · con orden activa asignada → referencia PROXIMO_PUNTO_OPERATIVO', () => {
  const orden: OrdenActivaRanking = {
    id: 'ordA', estado: 'asignada', asignacion: { motorizadoId: 'm1' },
    recoleccion: { coord: { lat: 12.2, lng: -86.1 } }, codigo: 'SH-0011',
  }
  const ref = getReferenciaGeografica(moto('m1'), [orden], AHORA)
  assert.equal(ref.tipo, 'proximo_punto_operativo')
  assert.deepEqual(ref.coord, { lat: 12.2, lng: -86.1 })
})

test('RX2 · la referencia próxima incluye el tipo de punto (retiro/entrega) cuando está disponible', () => {
  const retiro: OrdenActivaRanking = {
    id: 'ordA', estado: 'asignada', asignacion: { motorizadoId: 'm1' },
    recoleccion: { coord: { lat: 12.2, lng: -86.1 } },
  }
  const entrega: OrdenActivaRanking = {
    id: 'ordB', estado: 'en_camino_entrega', asignacion: { motorizadoId: 'm2' },
    entrega: { coord: { lat: 12.3, lng: -86.2 } },
  }
  assert.equal(getReferenciaGeografica(moto('m1'), [retiro], AHORA).tipoPunto, 'retiro')
  assert.equal(getReferenciaGeografica(moto('m2'), [entrega], AHORA).tipoPunto, 'entrega')
})

test('RX3 · la referencia próxima incluye ordenId y codigoOrden cuando la orden trae código', () => {
  const orden: OrdenActivaRanking = {
    id: 'ordA', estado: 'asignada', asignacion: { motorizadoId: 'm1' },
    recoleccion: { coord: { lat: 12.2, lng: -86.1 } }, codigo: 'SH-0011',
  }
  const ref = getReferenciaGeografica(moto('m1'), [orden], AHORA)
  assert.equal(ref.ordenId, 'ordA')
  assert.equal(ref.codigoOrden, 'SH-0011')
})

test('RX3b · si la orden NO trae código, codigoOrden queda undefined — no se inventa uno', () => {
  const orden: OrdenActivaRanking = {
    id: 'ordA', estado: 'asignada', asignacion: { motorizadoId: 'm1' },
    recoleccion: { coord: { lat: 12.2, lng: -86.1 } },
  }
  const ref = getReferenciaGeografica(moto('m1'), [orden], AHORA)
  assert.equal(ref.ordenId, 'ordA')
  assert.equal(ref.codigoOrden, undefined)
})

// ─── RX4-RX7 · sin órdenes activas ──────────────────────────────────────────────

test('RX4 · sin órdenes + última ubicación fresca → ULTIMA_UBICACION_OPERATIVA', () => {
  const HOY_12H = { toDate: () => new Date('2026-09-28T18:00:00.000Z') }
  const m = moto('m1', {
    ultimaUbicacionOperativa: { lat: 12.15, lng: -86.2, timestamp: HOY_12H },
    presenciaUpdatedAt: { toDate: () => new Date('2026-09-28T17:00:00.000Z') },
  })
  const ref = getReferenciaGeografica(m, [], AHORA)
  assert.equal(ref.tipo, 'ultima_ubicacion_operativa')
  // coord es el objeto ultimaUbicacionOperativa completo (mismo comportamiento
  // que siempre tuvo getProximoPuntoOperativo: solo lat/lng se consumen después,
  // vía haversine, así que conservar el campo timestamp ahí no cambia nada).
  assert.equal(ref.coord?.lat, 12.15)
  assert.equal(ref.coord?.lng, -86.2)
  assert.equal(ref.timestamp, HOY_12H)
})

test('RX5 · última ubicación stale (de otro día operativo) → UBICACION_BASE', () => {
  const AYER = { toDate: () => new Date('2026-09-27T18:00:00.000Z') }
  const m = moto('m1', {
    ultimaUbicacionOperativa: { lat: 12.15, lng: -86.2, timestamp: AYER },
    presenciaUpdatedAt: { toDate: () => new Date('2026-09-27T17:00:00.000Z') },
    ubicacionBase: { lat: 12.1, lng: -86.25 },
  })
  const ref = getReferenciaGeografica(m, [], AHORA)
  assert.equal(ref.tipo, 'ubicacion_base')
  assert.deepEqual(ref.coord, { lat: 12.1, lng: -86.25 })
})

test('RX6 · sin última ubicación, con ubicación base → UBICACION_BASE', () => {
  const m = moto('m1', { ubicacionBase: { lat: 12.1, lng: -86.25 } })
  const ref = getReferenciaGeografica(m, [], AHORA)
  assert.equal(ref.tipo, 'ubicacion_base')
  assert.deepEqual(ref.coord, { lat: 12.1, lng: -86.25 })
})

test('RX7 · sin ninguna referencia disponible → SIN_REFERENCIA', () => {
  const ref = getReferenciaGeografica(moto('m1'), [], AHORA)
  assert.equal(ref.tipo, 'sin_referencia')
  assert.equal(ref.coord, null)
})

// ─── RX8 · la distancia UX es la misma que usa el ranking (una sola fuente) ────

test('RX8 · detalles.distanciaProximoKm es la MISMA distancia expuesta en referenciaGeografica.coord', () => {
  const orden: OrdenActivaRanking = {
    id: 'ordA', estado: 'asignada', asignacion: { motorizadoId: 'm1' },
    recoleccion: { coord: { lat: 12.2, lng: -86.1 } }, codigo: 'SH-0011',
  }
  const r = calcularScore(moto('m1'), [orden], NUEVA, [orden], AHORA)
  const { proximoPuntoOperativo, referenciaGeografica, distanciaProximoKm } = r.detalles
  assert.deepEqual(referenciaGeografica.coord, proximoPuntoOperativo)
  assert.ok(distanciaProximoKm !== null)
  // getProximoPuntoOperativo (envoltorio) debe devolver EXACTAMENTE el mismo punto
  assert.deepEqual(getProximoPuntoOperativo(moto('m1'), [orden], AHORA), proximoPuntoOperativo)
})

// RX10 (nunca "Ubicación actual"/"GPS actual" en el copy VISIBLE, es decir en
// la salida real de textoReferenciaGeografica) se prueba con el texto
// generado en lib/motorizado-referencia-ux.test.ts — ahí sí importa lo que
// el Gestor lee, no los comentarios del código fuente (que sí pueden citar
// esa frase para documentar la regla, como hace este mismo archivo).

// ─── RX11-RX13 · no regresión numérica al agregar metadata ────────────────────

test('RX11 · scoreTotal no cambia por agregar metadata UX (fixture determinista)', () => {
  const orden: OrdenActivaRanking = {
    id: 'ordA', estado: 'asignada', asignacion: { motorizadoId: 'dickson' },
    recoleccion: { coord: { lat: 12.2, lng: -86.1 } }, codigo: 'SH-0011',
  }
  const r = calcularScore(moto('dickson', { tasaAceptacion: 0.9 }), [orden], NUEVA, [orden], AHORA)
  // Valor exacto de esta fixture determinista con el código actual (fijado
  // una vez calculado, no recalculado en el test): cargaActual=1 →
  // scoreCarga=0.75; haversine(12.2,-86.1 → 12.13,-86.25) ≈ 18.067 km →
  // scoreCercania≈0.0966; con carga, misma distancia/15 → negativo → clamp
  // scoreCompatibilidad=0; scoreAceptacion=0.9. Si agregar
  // `referenciaGeografica` a `detalles` alguna vez mueve este número, esta
  // aserción debe fallar (cubre M6: "cambiar score/orden al agregar
  // metadata").
  assert.equal(r.score, 42, `score no debe moverse por la metadata UX, fue ${r.score}`)
  assert.equal(r.detalles.scoreCarga, 0.75)
  assert.ok(Math.abs(r.detalles.distanciaProximoKm! - 18.067330622996955) < 1e-9)
})

test('RX12 · el orden de candidatos no cambia al agregar metadata (mismo criterio, más info)', () => {
  const ordenes: OrdenActivaRanking[] = [
    { id: 'a', estado: 'asignada', asignacion: { motorizadoId: 'lejos' }, recoleccion: { coord: { lat: 20, lng: -90 } } },
  ]
  const r = rankearMotorizados(
    [moto('cerca'), moto('lejos', { tasaAceptacion: 1 })],
    ordenes,
    NUEVA,
    AHORA
  )
  assert.deepEqual(r.map((x) => x.id), ['cerca', 'lejos'], 'el motorizado sin carga y sin desvío debe rankear más alto')
  // Cada resultado ahora trae también su referenciaGeografica, sin que eso mueva el score
  for (const cand of r) assert.ok(cand.scoreResult.detalles.referenciaGeografica)
})

test('RX13 · los pesos del ranking permanecen iguales (PESO_CARGA=0.40, CERCANIA=0.30, COMPAT=0.20, ACEPTACION=0.10)', () => {
  const src = fuente('lib', 'motorizado-ranking.ts')
  assert.ok(src.includes('PESO_CARGA      = 0.40'))
  assert.ok(src.includes('PESO_CERCANIA   = 0.30'))
  assert.ok(src.includes('PESO_COMPAT     = 0.20'))
  assert.ok(src.includes('PESO_ACEPTACION = 0.10'))
})

// ─── RX14 · sin N+1 / sin listeners nuevos por candidato ───────────────────────

test('RX14 · getReferenciaGeografica es una función pura: no hace fetch/onSnapshot/get por candidato', () => {
  const src = fuente('lib', 'motorizado-ranking.ts')
  const cuerpo = src.slice(src.indexOf('export function getReferenciaGeografica'), src.indexOf('export function getProximoPuntoOperativo'))
  assert.ok(!/onSnapshot|getDoc|getDocs|fetch\(/.test(cuerpo))
})

// ─── RX15 · las 3 superficies principales siguen consumiendo la misma fuente ───

test('RX15 · las 3 superficies de ranking siguen leyendo scoreResult.explicacion (única fuente, sin deducir por separado)', () => {
  for (const [, ruta] of SUPERFICIES) {
    const src = fuente(...ruta)
    assert.ok(src.includes('rankearMotorizados'), `${ruta.join('/')} debe seguir usando rankearMotorizados`)
    assert.ok(src.includes('.explicacion'), `${ruta.join('/')} debe seguir leyendo scoreResult.explicacion`)
  }
})

// ─── RX16 · Base de Datos no recibe nueva UI de asignación/reasignación ────────

test('RX16 · Base de Datos no importa el ranking ni gana controles de asignación nuevos', () => {
  const src = fuente('app', 'panel', 'gestor', 'base-datos', 'page.tsx')
  assert.ok(!src.includes('motorizado-referencia-ux'))
  assert.ok(!src.includes('rankearMotorizados'))
  assert.ok(!src.includes('Asignar sugerido'))
})
