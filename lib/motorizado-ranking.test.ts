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
  // MOTO-RANKING-ACEPTACION-SIN-HISTORIAL-1 — totalAsignaciones agregado:
  // sin él, `tasaAceptacion` sola ya no es legacy válida (leerLegacy exige
  // totalAsignaciones > 0, igual que exige el propio writer real —
  // espejoLegacy() siempre escribe ambos juntos), y este fixture caería a
  // 'sin_historial' (0.5) en vez de reflejar el 0.9 que pretende fijar.
  const r = calcularScore(moto('dickson', { tasaAceptacion: 0.9, totalAsignaciones: 20, totalAceptadas: 18 }), [orden], NUEVA, [orden], AHORA)
  // Valor exacto de esta fixture determinista con el código actual (fijado
  // una vez calculado, no recalculado en el test): cargaActual=1 →
  // scoreCarga=0.75; haversine(12.2,-86.1 → 12.13,-86.25) ≈ 18.067 km →
  // scoreCercania≈0.0966; con carga, misma distancia/15 → negativo → clamp
  // scoreCompatibilidad=0; scoreAceptacion=0.9 (legacy válida, sin v2 →
  // resolverAceptacionRanking() devuelve la tasa legacy tal cual). Si agregar
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

// ═══ MOTO-RANKING-ACEPTACION-SIN-HISTORIAL-1 ═══════════════════════════════
// RA9-RA16, RP1 y la protección de source-contract del punto 35. Los casos
// puros del helper (RA1-RA8, RT1-RT6) viven en
// lib/motorizado-ranking-aceptacion.test.ts — acá solo lo que depende de la
// INTEGRACIÓN con calcularScore()/rankearMotorizados().

// ─── RA9/RA16 · sin query/listener nuevo, funciones puras ──────────────────

test('RA9/RA16 · motorizado-ranking.ts y motorizado-ranking-aceptacion.ts no importan Firestore (0 query/listener nuevo)', () => {
  for (const archivo of ['motorizado-ranking.ts', 'motorizado-ranking-aceptacion.ts']) {
    const src = fuente('lib', archivo)
    assert.ok(!/from ['"]firebase\/firestore['"]/.test(src), `${archivo} no debe importar firebase/firestore`)
    assert.ok(!/onSnapshot|getDoc|getDocs|collection\(/.test(src), `${archivo} no debe leer Firestore directamente`)
  }
})

// ─── RA10 · el hook realtime que alimenta el ranking no cambió ─────────────

test('RA10 · useMotorizadosCandidatos.ts sigue con un único onSnapshot (0 diff funcional esperado)', () => {
  const src = fuente('app', 'panel', 'gestor', '_hooks', 'useMotorizadosCandidatos.ts')
  assert.equal((src.match(/onSnapshot\(/g) ?? []).length, 1)
  // metricasAceptacion ya llega en el spread completo del documento — sin cambios acá.
  assert.ok(src.includes('...(d.data() as Record<string, unknown>)'))
})

// ─── RA11 · redondeo/clamp preservados, sin techo superior nuevo ───────────

test('RA11 · scoreTotal sigue usando Math.round + Math.max(0, ...), sin Math.min(100, ...) nuevo', () => {
  const src = fuente('lib', 'motorizado-ranking.ts')
  const bloque = src.slice(src.indexOf('// ── 7. Score total'), src.indexOf('// ── 8. Explicación'))
  assert.ok(bloque.includes('Math.round('))
  assert.ok(bloque.includes('Math.max(0,'))
  assert.ok(!bloque.includes('Math.min('), 'sigue sin techo superior — deuda MOTO-RANKING-SCORE-TECHO-1 aparte')
})

// ─── RA12 · el orden solo cambia cuando la nueva aceptación lo justifica ───

test('RA12 · dos candidatos idénticos salvo aceptación: el orden refleja exactamente esa diferencia', () => {
  const m = (id: string, extra: Partial<MotorizadoConRanking>) => moto(id, extra)
  const sinHistorial = m('nuevo', {})
  const con100 = m('veterano', { totalAsignaciones: 10, totalAceptadas: 10, tasaAceptacion: 1 })
  const r = rankearMotorizados([sinHistorial, con100], [], NUEVA, AHORA)
  // veterano (100%) debe superar a nuevo (50% neutral) — única diferencia entre ambos.
  assert.deepEqual(r.map((x) => x.id), ['veterano', 'nuevo'])
  assert.ok(r[0].scoreResult.score > r[1].scoreResult.score)
})

// ─── RA13 · nuevo vs rider 50%: mismo componente de aceptación ─────────────

test('RA13 · un rider sin historial y uno con 50% real comparten exactamente el mismo scoreAceptacion', () => {
  const nuevo = calcularScore(moto('nuevo'), [], NUEVA, [], AHORA)
  const con50 = calcularScore(moto('con50', { totalAsignaciones: 4, totalAceptadas: 2, tasaAceptacion: 0.5 }), [], NUEVA, [], AHORA)
  assert.equal(nuevo.detalles.scoreAceptacion, 0.5)
  assert.equal(con50.detalles.scoreAceptacion, 0.5)
  assert.equal(nuevo.score, con50.score, 'con todo lo demás igual, el score total también debe coincidir')
})

// ─── RA14 · nuevo vs rider 100%: exactamente 5 puntos abajo ────────────────

test('RA14 · un rider sin historial queda exactamente 5 puntos por debajo de uno con 100% real (resto idéntico)', () => {
  const nuevo = calcularScore(moto('nuevo'), [], NUEVA, [], AHORA)
  const con100 = calcularScore(moto('con100', { totalAsignaciones: 10, totalAceptadas: 10, tasaAceptacion: 1 }), [], NUEVA, [], AHORA)
  assert.equal(nuevo.detalles.scoreAceptacion, 0.5)
  assert.equal(con100.detalles.scoreAceptacion, 1)
  assert.equal(con100.score - nuevo.score, 5, `diferencia esperada 5 pts (0.5 de rango * 10% de peso * 100), fue ${con100.score - nuevo.score}`)
})

// ─── RA15 · v2 parcial no reemplaza abruptamente legacy (integración) ──────

test('RA15 · un rider con legacy lifetime alto y v2 parcial reciente no cae abruptamente a la tasa v2', () => {
  const legacyAlto = calcularScore(
    moto('mixto', {
      totalAsignaciones: 100, totalAceptadas: 90, tasaAceptacion: 0.9,
      metricasAceptacion: { version: 2, totalDecisiones: 2, totalAceptadas: 1, totalRechazadas: 1, tasaAceptacion: 0.5 },
    }),
    [], NUEVA, [], AHORA,
  )
  // Ni el 90% legacy puro ni el 50% v2 puro: algo entre medio (0.82 según RA6).
  assert.ok(legacyAlto.detalles.scoreAceptacion > 0.5 && legacyAlto.detalles.scoreAceptacion < 0.9)
  assert.ok(Math.abs(legacyAlto.detalles.scoreAceptacion - 0.82) < 1e-9)
})

// ─── RP1 · no doble penalización por rechazos ──────────────────────────────

test('RP1 · misma tasa efectiva (80%), distinto totalRechazos absoluto (0 vs 25) → MISMO score total', () => {
  const base = { totalAsignaciones: 10, totalAceptadas: 8, tasaAceptacion: 0.8 }
  const conCeroRechazos = calcularScore(moto('a', { ...base }), [], NUEVA, [], AHORA)
  const con25Rechazos = calcularScore(moto('b', { ...base, totalRechazos: 25 }), [], NUEVA, [], AHORA)
  assert.equal(conCeroRechazos.score, con25Rechazos.score, 'totalRechazos ya no debe restar del scoreTotal')
  // penalizacionRechazos se sigue calculando (transparencia/debug) pero no participa del score.
  assert.equal(conCeroRechazos.detalles.penalizacionRechazos, 0)
  assert.equal(con25Rechazos.detalles.penalizacionRechazos, 10)
})

// ─── Source-contract (punto 35) · el fallback viejo y la resta vieja no vuelven ─

test('source-contract · motorizado-ranking.ts ya no contiene el fallback ?? 1.0 ni resta penalizacionRechazos del scoreTotal', () => {
  const src = fuente('lib', 'motorizado-ranking.ts')
  assert.ok(!src.includes('motorizado.tasaAceptacion ?? 1.0'), 'el fallback favorable viejo no debe volver')
  assert.ok(src.includes("import { resolverAceptacionRanking } from './motorizado-ranking-aceptacion'"))
  const bloqueScoreTotal = src.slice(src.indexOf('// ── 7. Score total'), src.indexOf('// ── 8. Explicación'))
  const lineaFormula = bloqueScoreTotal.slice(bloqueScoreTotal.indexOf('Math.round('))
  assert.ok(!lineaFormula.includes('penalizacionRechazos'), 'la expresión real del scoreTotal no debe restar penalizacionRechazos (el comentario arriba SÍ puede mencionarlo)')
})

// ═══ MOTO-RANKING-REFERENCIA-ZONA-UX-1 ══════════════════════════════════════
// getReferenciaGeografica propaga zona/macrozona del MISMO punto que ya
// decidía coord/tipoPunto/codigoOrden — puramente presentacional, 0 cambio
// numérico. El helper de formato (getReferenciaZonaTexto) y sus fallbacks
// viven en lib/motorizado-referencia-ux.test.ts (RZ5-RZ9); acá solo lo que
// depende de la INTEGRACIÓN con getReferenciaGeografica/calcularScore.

// ─── RZ1-RZ4 · próximo punto usa el zona/macrozona del punto REAL ──────────

test('RZ1 · próximo punto apuntando a Retiro usa zonaRetiroNombre', () => {
  const orden: OrdenActivaRanking = {
    id: 'ordA', estado: 'asignada', asignacion: { motorizadoId: 'm1' },
    recoleccion: { coord: { lat: 12.2, lng: -86.1 } },
    zonaRetiroNombre: 'Mall Las Américas', zonaEntregaNombre: 'Linda Vista',
  }
  const ref = getReferenciaGeografica(moto('m1'), [orden], AHORA)
  assert.equal(ref.tipoPunto, 'retiro')
  assert.equal(ref.zonaNombre, 'Mall Las Américas')
})

test('RZ2 · próximo punto apuntando a Entrega usa zonaEntregaNombre', () => {
  const orden: OrdenActivaRanking = {
    id: 'ordB', estado: 'en_camino_entrega', asignacion: { motorizadoId: 'm2' },
    entrega: { coord: { lat: 12.3, lng: -86.2 } },
    zonaRetiroNombre: 'Mall Las Américas', zonaEntregaNombre: 'Linda Vista',
  }
  const ref = getReferenciaGeografica(moto('m2'), [orden], AHORA)
  assert.equal(ref.tipoPunto, 'entrega')
  assert.equal(ref.zonaNombre, 'Linda Vista')
})

test('RZ3 · Retiro usa macroZonaRetiroNombre', () => {
  const orden: OrdenActivaRanking = {
    id: 'ordA', estado: 'asignada', asignacion: { motorizadoId: 'm1' },
    recoleccion: { coord: { lat: 12.2, lng: -86.1 } },
    macroZonaRetiroNombre: 'Managua Este', macroZonaEntregaNombre: 'Managua Oeste',
  }
  const ref = getReferenciaGeografica(moto('m1'), [orden], AHORA)
  assert.equal(ref.macroZonaNombre, 'Managua Este')
})

test('RZ4 · Entrega usa macroZonaEntregaNombre', () => {
  const orden: OrdenActivaRanking = {
    id: 'ordB', estado: 'retirado', asignacion: { motorizadoId: 'm2' },
    entrega: { coord: { lat: 12.3, lng: -86.2 } },
    macroZonaRetiroNombre: 'Managua Este', macroZonaEntregaNombre: 'Managua Oeste',
  }
  const ref = getReferenciaGeografica(moto('m2'), [orden], AHORA)
  assert.equal(ref.macroZonaNombre, 'Managua Oeste')
})

// ─── Test cruzado Retiro/Entrega (punto 31 del bloque) ─────────────────────

test('RZ-cruzado · Retiro NO usa zona/macrozona de Entrega, y viceversa', () => {
  const fixture = {
    zonaRetiroNombre: 'Zona Retiro X', zonaEntregaNombre: 'Zona Entrega Y',
    macroZonaRetiroNombre: 'Macro Retiro X', macroZonaEntregaNombre: 'Macro Entrega Y',
  }
  const retiro: OrdenActivaRanking = {
    id: 'ordR', estado: 'asignada', asignacion: { motorizadoId: 'm1' },
    recoleccion: { coord: { lat: 12.2, lng: -86.1 } }, ...fixture,
  }
  const entrega: OrdenActivaRanking = {
    id: 'ordE', estado: 'en_camino_entrega', asignacion: { motorizadoId: 'm2' },
    entrega: { coord: { lat: 12.3, lng: -86.2 } }, ...fixture,
  }
  const refRetiro = getReferenciaGeografica(moto('m1'), [retiro], AHORA)
  const refEntrega = getReferenciaGeografica(moto('m2'), [entrega], AHORA)
  assert.equal(refRetiro.zonaNombre, 'Zona Retiro X')
  assert.notEqual(refRetiro.zonaNombre, 'Zona Entrega Y')
  assert.equal(refRetiro.macroZonaNombre, 'Macro Retiro X')
  assert.equal(refEntrega.zonaNombre, 'Zona Entrega Y')
  assert.notEqual(refEntrega.zonaNombre, 'Zona Retiro X')
  assert.equal(refEntrega.macroZonaNombre, 'Macro Entrega Y')
})

// ─── RZ10-RZ11 · ubicación base usa los campos reales (no zonaBase/macroZonaBase) ─

test('RZ10 · ubicación base usa zonaBaseNombre (campo real), no zonaBase', () => {
  const m = moto('m1', {
    ubicacionBase: { lat: 12.1, lng: -86.25 },
    zonaBaseNombre: 'Ciudad Jardín',
    zonaBase: 'OTRO VALOR QUE NO DEBE USARSE',
  })
  const ref = getReferenciaGeografica(m, [], AHORA)
  assert.equal(ref.tipo, 'ubicacion_base')
  assert.equal(ref.zonaNombre, 'Ciudad Jardín')
})

test('RZ11 · ubicación base usa macroZonaBaseNombre (campo real), no macroZonaBase', () => {
  const m = moto('m1', {
    ubicacionBase: { lat: 12.1, lng: -86.25 },
    macroZonaBaseNombre: 'Managua Centro',
    macroZonaBase: 'OTRO VALOR QUE NO DEBE USARSE',
  })
  const ref = getReferenciaGeografica(m, [], AHORA)
  assert.equal(ref.macroZonaNombre, 'Managua Centro')
})

// ─── RZ5 · última ubicación operativa nunca inventa zona/macrozona ─────────

test('RZ5 · última ubicación operativa fresca → zonaNombre/macroZonaNombre quedan ausentes', () => {
  const HOY_12H = { toDate: () => new Date('2026-09-28T18:00:00.000Z') }
  const m = moto('m1', {
    ultimaUbicacionOperativa: { lat: 12.15, lng: -86.2, timestamp: HOY_12H },
    presenciaUpdatedAt: { toDate: () => new Date('2026-09-28T06:00:00.000Z') },
  })
  const ref = getReferenciaGeografica(m, [], AHORA)
  assert.equal(ref.tipo, 'ultima_ubicacion_operativa')
  assert.equal(ref.zonaNombre, undefined)
  assert.equal(ref.macroZonaNombre, undefined)
})

// ─── RZ12-RZ13 · invariantes de score y orden ───────────────────────────────

test('RZ12 · scoreTotal es idéntico con y sin metadata geográfica nueva', () => {
  const orden: OrdenActivaRanking = {
    id: 'ordA', estado: 'asignada', asignacion: { motorizadoId: 'm1' },
    recoleccion: { coord: { lat: 12.13, lng: -86.25 } },
  }
  const ordenConZona: OrdenActivaRanking = {
    ...orden, zonaRetiroNombre: 'Zona X', macroZonaRetiroNombre: 'Macro Y',
  }
  const sinMeta = calcularScore(moto('m1'), [orden], NUEVA, [orden], AHORA)
  const conMeta = calcularScore(moto('m1'), [ordenConZona], NUEVA, [ordenConZona], AHORA)
  assert.equal(sinMeta.score, conMeta.score)
})

// MOTO-RANKING-REFERENCIA-ZONA-UX-1 — corrección post-preintegración: la
// versión anterior de RZ13 usaba moto('a')/moto('b') SIN ubicacionBase, así
// que getReferenciaGeografica() resolvía 'sin_referencia' para ambos y
// zonaNombre quedaba undefined en los dos — un tie-break espurio por zona
// nunca tenía valores distintos sobre los que actuar, así que el test
// pasaba aunque el invariante NO estuviera protegido (mutation M7 de la
// preintegración independiente no lo hizo caer). Este fixture fuerza
// 'ubicacion_base' real en ambos candidatos, con zonaBaseNombre DISTINTOS
// elegidos a propósito en orden alfabético INVERSO al de entrada (a: "Zona
// Z", b: "Zona A") — si un tie-break ascendente por zona se agregara, b
// pasaría antes que a, lo que el assert final detecta.
test('RZ13 · el orden de candidatos no cambia al agregar metadata de zona (tie real con ubicacion_base)', () => {
  const UBICACION = { lat: 12.1, lng: -86.25 }
  const candidatoA = moto('a', { ubicacionBase: UBICACION, zonaBaseNombre: 'Zona Z' })
  const candidatoB = moto('b', { ubicacionBase: UBICACION, zonaBaseNombre: 'Zona A' })

  // Confirma que el escenario realmente activa las condiciones necesarias
  // (sin esto, el test podría volver a ser un falso positivo silencioso).
  const refA = getReferenciaGeografica(candidatoA, [], AHORA)
  const refB = getReferenciaGeografica(candidatoB, [], AHORA)
  assert.equal(refA.tipo, 'ubicacion_base')
  assert.equal(refB.tipo, 'ubicacion_base')
  assert.equal(refA.zonaNombre, 'Zona Z')
  assert.equal(refB.zonaNombre, 'Zona A')
  assert.notEqual(refA.zonaNombre, refB.zonaNombre)

  const resultado = rankearMotorizados([candidatoA, candidatoB], [], NUEVA, AHORA)
  assert.equal(
    resultado[0].scoreResult.score, resultado[1].scoreResult.score,
    'mismo ubicacionBase + sin carga/orden activa + sin historial de aceptación → scoreTotal debe empatar (si no, el test no prueba el invariante de orden)',
  )
  assert.deepEqual(
    resultado.map((m) => m.id), ['a', 'b'],
    'con score empatado, el orden de entrada debe preservarse — la metadata de zona NO debe convertirse en tie-break',
  )
})

// ─── RZ14-RZ15 · source-contract: 0 queries, 0 listeners nuevos ────────────

test('RZ14/RZ15 · getReferenciaGeografica sigue sin fetch/onSnapshot/getDoc/getZonasActivas/point-in-polygon', () => {
  const src = fuente('lib', 'motorizado-ranking.ts')
  const cuerpo = src.slice(src.indexOf('export function getReferenciaGeografica'), src.indexOf('export function getProximoPuntoOperativo'))
  assert.ok(!/onSnapshot|getDoc|getDocs|fetch\(|getZonasActivas|clasificarPuntoEnZona|clasificarOrdenCompleto|pointInPolygon/.test(cuerpo))
})

// ═══ MOTO-RANKING-SUPERFICIES-CONSISTENCIA-1 ════════════════════════════════
// Bug confirmado en diagnóstico: app/panel/gestor/solicitudes/page.tsx
// construía su `nuevaOrden` SIN zonaRetiroId/zonaEntregaId/macroZonaRetiroId/
// macroZonaEntregaId, así que bonificacionZonaTotal (lib/motorizado-ranking.ts)
// siempre caía en "datos insuficientes → sin efecto" para ese modal, mientras
// SolicitudDrawer.tsx y solicitudes/[id]/page.tsx sí los propagaban y sí
// aplicaban el bonus/penalización territorial real — mismo motor
// (rankearMotorizados), inputs distintos. Estos tests prueban, contra el
// motor REAL, que cuando ambas superficies alimentan los mismos 4 campos
// (que es lo que el fix de page.tsx ahora hace), obtienen el MISMO
// bonificacionZonaTotal — no son grep, son comportamiento real.

test('SC6 · John-like: carga activa + misma macrozona y zona de entrega → bonificacionZonaTotal = +12 (8+4)', () => {
  const ordenActiva: OrdenActivaRanking = {
    id: 'ordJohn', estado: 'asignada', asignacion: { motorizadoId: 'john' },
    recoleccion: { coord: { lat: 12.2, lng: -86.1 } },
    macroZonaEntregaId: 'MZ-ESTE', zonaEntregaId: 'Z-MALL',
  }
  const nuevaOrdenJohn: NuevaOrdenRanking = {
    ...NUEVA,
    macroZonaEntregaId: 'MZ-ESTE', zonaEntregaId: 'Z-MALL',
  }
  const r = calcularScore(moto('john'), [ordenActiva], nuevaOrdenJohn, [ordenActiva], AHORA)
  assert.equal(r.detalles.mismaMacroZona, true)
  assert.equal(r.detalles.mismaZona, true)
  assert.equal(r.detalles.bonificacionZonaTotal, 12)
})

test('SC7 · Dickson-like: carga activa + macrozona de entrega distinta → bonificacionZonaTotal = -5', () => {
  const ordenActiva: OrdenActivaRanking = {
    id: 'ordDickson', estado: 'en_camino_entrega', asignacion: { motorizadoId: 'dickson' },
    entrega: { coord: { lat: 12.3, lng: -86.2 } },
    macroZonaEntregaId: 'MZ-ESTE',
  }
  const nuevaOrdenDickson: NuevaOrdenRanking = {
    ...NUEVA,
    macroZonaEntregaId: 'MZ-OESTE',
  }
  const r = calcularScore(moto('dickson'), [ordenActiva], nuevaOrdenDickson, [ordenActiva], AHORA)
  assert.equal(r.detalles.mismaMacroZona, false)
  assert.equal(r.detalles.bonificacionZonaTotal, -5)
})

test('SC8 · rider sin órdenes activas → bonificacionZonaTotal = 0 aunque existan campos territoriales (Luigi/José no cambian)', () => {
  const nuevaOrdenConZona: NuevaOrdenRanking = {
    ...NUEVA,
    macroZonaEntregaId: 'MZ-ESTE', zonaEntregaId: 'Z-MALL',
  }
  const r = calcularScore(moto('luigi'), [], nuevaOrdenConZona, [], AHORA)
  assert.equal(r.detalles.mismaMacroZona, null)
  assert.equal(r.detalles.bonificacionZonaTotal, 0)
})

// ─── Consistencia entre adaptadores (SC1-SC5): el modal compacto debe
// propagar los mismos 4 campos territoriales que SolicitudDrawer.tsx y
// solicitudes/[id]/page.tsx ya propagaban — fuente real, no una convención
// nueva. Source-contract: es el único punto testeable para un useMemo
// dentro de un componente .tsx sin runner de React/DOM en este repo (mismo
// patrón que RX15/RX16/LU2/LU5).

function bloqueRankingModal(src: string): string {
  const inicio = src.indexOf('const rankingModal = useMemo<MotorizadoRankeado[]>(() => {')
  assert.ok(inicio !== -1, 'no se encontró el useMemo de rankingModal en page.tsx')
  const fin = src.indexOf('}, [openId, motorizados, ordenesActivas, allItems, diaOperativoRanking])')
  assert.ok(fin !== -1, 'no se encontró el cierre del useMemo de rankingModal')
  return src.slice(inicio, fin)
}

test('SC1-SC5 · page.tsx propaga los 4 campos territoriales al nuevaOrden de rankingModal (mismos nombres que SolicitudDrawer.tsx/[id]/page.tsx)', () => {
  const srcModal = fuente('app', 'panel', 'gestor', 'solicitudes', 'page.tsx')
  const bloque = bloqueRankingModal(srcModal)
  assert.ok(bloque.includes('zonaRetiroId: solicitud.zonaRetiroId ?? null'), 'SC2: zonaRetiroId')
  assert.ok(bloque.includes('zonaEntregaId: solicitud.zonaEntregaId ?? null'), 'SC3: zonaEntregaId')
  assert.ok(bloque.includes('macroZonaRetiroId: solicitud.macroZonaRetiroId ?? null'), 'SC4: macroZonaRetiroId')
  assert.ok(bloque.includes('macroZonaEntregaId: solicitud.macroZonaEntregaId ?? null'), 'SC5: macroZonaEntregaId')

  const srcDrawer = fuente('app', 'panel', 'gestor', '_components', 'SolicitudDrawer.tsx')
  for (const campo of ['zonaRetiroId', 'zonaEntregaId', 'macroZonaRetiroId', 'macroZonaEntregaId']) {
    assert.ok(srcDrawer.includes(`${campo}: solicitud.${campo} ?? null`), `SolicitudDrawer.tsx debe seguir propagando ${campo} (SC1: misma convención)`)
  }
})

test('SC9 · referencia geográfica/distancia de rankingModal sigue sin cambios (misma fuente textoReferenciaGeografica, mismo distanciaProximoKm)', () => {
  const bloqueLista = fuente('app', 'panel', 'gestor', 'solicitudes', 'page.tsx')
  assert.ok(bloqueLista.includes('textoReferenciaGeografica('))
  assert.ok(bloqueLista.includes('m.scoreResult.detalles.referenciaGeografica'))
  assert.ok(bloqueLista.includes('m.scoreResult.detalles.distanciaProximoKm'))
})

test('SC13 · motor único: rankingModal sigue llamando rankearMotorizados() de lib/motorizado-ranking, 0 fórmula local/duplicada', () => {
  const srcModal = fuente('app', 'panel', 'gestor', 'solicitudes', 'page.tsx')
  const bloque = bloqueRankingModal(srcModal)
  assert.ok(bloque.includes('return rankearMotorizados(motorizados, ordenesActivas, nuevaOrden, ahoraOperativo)'))
  assert.ok(!bloque.includes('scoreCarga'), 'no debe reimplementar componentes del score localmente')
  assert.ok(!bloque.includes('scoreCercania'))
  assert.ok(!bloque.includes('scoreCompatibilidad'))
  assert.ok(!bloque.includes('BONUS_MISMA_MACROZONA') && !bloque.includes('PENALIZACION_DESVIO_MACROZONA'), 'el cálculo de bonus sigue viviendo exclusivamente en lib/motorizado-ranking.ts')
})

test('SC14 · fórmula/pesos/sort productivos de lib/motorizado-ranking.ts no cambiaron por este fix', () => {
  const src = fuente('lib', 'motorizado-ranking.ts')
  for (const c of ['PESO_CARGA      = 0.40', 'PESO_CERCANIA   = 0.30', 'PESO_COMPAT     = 0.20', 'PESO_ACEPTACION = 0.10', 'BONUS_MISMA_MACROZONA         = 8', 'BONUS_MISMA_ZONA              = 4', 'PENALIZACION_DESVIO_MACROZONA = 5']) {
    assert.ok(src.includes(c), c)
  }
  assert.ok(src.includes('.sort((a, b) => b.scoreResult.score - a.scoreResult.score)'), 'sort productivo sin tie-break nuevo')
  assert.ok(!src.includes('Math.min(100'), 'score >100 sigue fuera de scope (MOTO-RANKING-SCORE-TECHO-1)')
})
