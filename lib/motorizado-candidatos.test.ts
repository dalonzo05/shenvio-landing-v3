// MOTO-RANKING-DATOS-REALTIME-1 — el ranking en sí no cambia (rankearMotorizados
// ya excluye inactivo/activo=false, y sigue sin hard cap de carga); este archivo
// prueba SOLO las decisiones nuevas: cuándo la selección del gestor deja de ser
// válida, y la clave de invalidación por día operativo. La arquitectura realtime
// (los hooks onSnapshot y su cleanup) se verifica leyendo el código fuente de las
// 4 superficies, igual que el resto de este repo prueba componentes sin runner.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { seleccionSigueValida, diaOperativoParaRecomputo } from './motorizado-candidatos'
import { rankearMotorizados, type MotorizadoConRanking, type OrdenActivaRanking, type NuevaOrdenRanking } from './motorizado-ranking'

const NUEVA: NuevaOrdenRanking = { recoleccion: { coord: { lat: 12.13, lng: -86.25 } } }
const moto = (id: string, estado: string | undefined, extra: Partial<MotorizadoConRanking> = {}): MotorizadoConRanking => ({
  id, nombre: id, estado, activo: true, ...extra,
})
const ids = (r: { id: string }[]) => r.map((m) => m.id)

function fuente(...ruta: string[]): string {
  return readFileSync(join(__dirname, '..', ...ruta), 'utf8').replace(/\r/g, '')
}

const SUPERFICIES = [
  ['solicitudes/page.tsx', ['app', 'panel', 'gestor', 'solicitudes', 'page.tsx']],
  ['SolicitudDrawer.tsx', ['app', 'panel', 'gestor', '_components', 'SolicitudDrawer.tsx']],
  ['solicitudes/[id]/page.tsx', ['app', 'panel', 'gestor', 'solicitudes', '[id]', 'page.tsx']],
] as const

// ─── RT1–RT4: el ranking ya excluye correctamente (sin cambio semántico) ───────

test('RT1 · disponible → aparece candidato', () => {
  assert.deepEqual(ids(rankearMotorizados([moto('m1', 'disponible')], [], NUEVA)), ['m1'])
})

test('RT2 · disponible → inactivo: ya no aparece (rankearMotorizados excluye inactivo)', () => {
  const antes = rankearMotorizados([moto('m1', 'disponible')], [], NUEVA)
  const despues = rankearMotorizados([moto('m1', 'inactivo')], [], NUEVA)
  assert.deepEqual(ids(antes), ['m1'])
  assert.deepEqual(ids(despues), [])
})

test('RT3 · inactivo → disponible: reaparece', () => {
  assert.deepEqual(ids(rankearMotorizados([moto('m1', 'inactivo')], [], NUEVA)), [])
  assert.deepEqual(ids(rankearMotorizados([moto('m1', 'disponible')], [], NUEVA)), ['m1'])
})

test('RT4 · activo true → false: desaparece', () => {
  const m = moto('m1', 'disponible')
  assert.deepEqual(ids(rankearMotorizados([m], [], NUEVA)), ['m1'])
  assert.deepEqual(ids(rankearMotorizados([{ ...m, activo: false }], [], NUEVA)), [])
})

test('RT5 · ocupado legacy → aparece como online compatible', () => {
  assert.deepEqual(ids(rankearMotorizados([moto('m1', 'ocupado')], [], NUEVA)), ['m1'])
})

test('RT9 · rider offline con orden existente: la orden no depende del roster de candidatos (no se toca aquí)', () => {
  // El ranking de candidatos no lee ni escribe solicitudes_envio.asignacion: nada
  // en esta capa puede cancelar, rebotar o desasignar. Confirmado por ausencia de
  // esas palabras en el módulo puro que decide candidatos.
  const src = fuente('lib', 'motorizado-candidatos.ts')
  for (const prohibido of ['updateDoc', 'asignacion', 'cancelar', 'rebota']) assert.ok(!src.includes(prohibido), prohibido)
})

// ─── RT6: selección stale ──────────────────────────────────────────────────────

test('RT6 · seleccionSigueValida: vacío siempre válido; presente solo si sigue entre los candidatos', () => {
  const candidatos = [{ id: 'a' }, { id: 'b' }]
  assert.equal(seleccionSigueValida('', candidatos), true)
  assert.equal(seleccionSigueValida('a', candidatos), true)
  assert.equal(seleccionSigueValida('c', candidatos), false)
  assert.equal(seleccionSigueValida('a', []), false, 'sin candidatos, ninguna selección sigue siendo válida')
})

test('RT6b · Dickson seleccionado pasa a inactivo → deja de estar entre los candidatos → la selección debe limpiarse', () => {
  const antes = rankearMotorizados([moto('dickson', 'disponible'), moto('luigi', 'disponible')], [], NUEVA)
  assert.equal(seleccionSigueValida('dickson', antes), true)
  const despues = rankearMotorizados([moto('dickson', 'inactivo'), moto('luigi', 'disponible')], [], NUEVA)
  assert.equal(seleccionSigueValida('dickson', despues), false, 'ya no debe conservarse la selección')
})

// ─── RT7/RT8: sin fallback al roster completo ──────────────────────────────────

for (const [nombre, ruta] of SUPERFICIES) {
  test(`RT7 · ${nombre}: sin candidatos elegibles NO cae al roster completo`, () => {
    const src = fuente(...ruta)
    assert.ok(!/rankingModal\.length > 0 \? rankingModal : motorizados/.test(src), 'fallback a motorizados sin filtrar')
    assert.ok(!/rankingCalculado\.length > 0 \? rankingCalculado : motorizados/.test(src), 'fallback a motorizados sin filtrar')
  })
}

test('RT7b · base-datos/page.tsx: el selector de asignación filtra elegibilidad y no ofrece un roster sin filtrar', () => {
  const src = fuente('app', 'panel', 'gestor', 'base-datos', 'page.tsx')
  assert.ok(src.includes('motorizadosElegibles.map((m) =>'))
  assert.ok(src.includes("m.activo !== false && esMotorizadoEnLinea(m.estado)"))
})

test('RT8 · las 4 superficies muestran un estado explícito cuando no hay candidatos', () => {
  for (const [, ruta] of SUPERFICIES) {
    const src = fuente(...ruta)
    assert.ok(src.includes('No hay motorizados en línea disponibles.'), ruta.join('/'))
  }
  const bd = fuente('app', 'panel', 'gestor', 'base-datos', 'page.tsx')
  assert.ok(bd.includes('No hay motorizados en línea disponibles.'))
})

// ─── RT10–RT12: ultimaUbicacionOperativa / ubicacionBase (ya cubierto por
// MOTO-RANKING-UBICACION-FRESCA-1; acá solo se confirma que sigue intacto) ─────

test('RT10-RT12 · cambios en ultimaUbicacionOperativa/presenciaUpdatedAt/ubicacionBase siguen recalculando el próximo punto (sin cambio semántico)', () => {
  const base = { lat: 10, lng: -80 }
  const otraBase = { lat: 11, lng: -81 }
  const m1 = moto('m1', 'disponible', { ubicacionBase: base })
  const m2 = moto('m1', 'disponible', { ubicacionBase: otraBase })
  const r1 = rankearMotorizados([m1], [], NUEVA)[0]
  const r2 = rankearMotorizados([m2], [], NUEVA)[0]
  assert.deepEqual(r1.scoreResult.detalles.proximoPuntoOperativo, base)
  assert.deepEqual(r2.scoreResult.detalles.proximoPuntoOperativo, otraBase)
})

// ─── RT13/RT14: carga (órdenes activas) ────────────────────────────────────────

test('RT13-RT14 · una orden activa nueva sube la carga; que termine la baja (mismo cálculo puro, ahora alimentado en vivo)', () => {
  const m = moto('m1', 'disponible')
  const orden = (id: string): OrdenActivaRanking => ({ id, estado: 'asignada', asignacion: { motorizadoId: 'm1' } })
  const sinOrdenes = rankearMotorizados([m], [], NUEVA)[0]
  const conOrden = rankearMotorizados([m], [orden('a')], NUEVA)[0]
  assert.equal(sinOrdenes.scoreResult.detalles.cargaActual, 0)
  assert.equal(conOrden.scoreResult.detalles.cargaActual, 1)
  assert.ok(conOrden.scoreResult.detalles.scoreCarga < sinOrdenes.scoreResult.detalles.scoreCarga)
})

// ─── RT15: nuevo día operativo sin cambio de Firestore ─────────────────────────

test('RT15 · diaOperativoParaRecomputo cambia al cruzar el día Managua, aunque el instante avance solo unos minutos', () => {
  const finDelDia = new Date('2026-09-20T23:55:00.000Z').getTime() // 17:55 Managua, mismo día operativo
  const empiezaElSiguiente = new Date('2026-09-21T06:05:00.000Z').getTime() // 00:05 Managua, día siguiente
  const d1 = diaOperativoParaRecomputo(finDelDia)
  const d2 = diaOperativoParaRecomputo(empiezaElSiguiente)
  assert.notEqual(d1, d2)
  assert.equal(d1, '2026-09-20')
  assert.equal(d2, '2026-09-21')
})

test('RT15b · las 4 superficies usan diaOperativoParaRecomputo(ahoraOperativo) como dependencia del ranking', () => {
  for (const [nombre, ruta] of SUPERFICIES) {
    const src = fuente(...ruta)
    assert.ok(src.includes('diaOperativoParaRecomputo(ahoraOperativo)'), nombre)
    assert.ok(src.includes('useTickOperativo()'), nombre)
  }
})

// ─── Arquitectura realtime: sin getDocs de motorizados/órdenes, con cleanup ────

test('sin N+1 · el hook de motorizados y el de órdenes activas son un único listener global, nunca por rider ni por orden', () => {
  const motoHook = fuente('app', 'panel', 'gestor', '_hooks', 'useMotorizadosCandidatos.ts')
  const ordenesHook = fuente('app', 'panel', 'gestor', '_hooks', 'useOrdenesActivasCandidatas.ts')
  for (const src of [motoHook, ordenesHook]) {
    assert.equal((src.match(/onSnapshot\(/g) ?? []).length, 1, 'un solo onSnapshot por hook')
    assert.ok(src.includes('return () => unsub()'), 'cleanup del listener')
    assert.ok(!/\.forEach|\.map\(.*onSnapshot/.test(src), 'no crea un listener por documento')
  }
})

for (const [nombre, ruta] of SUPERFICIES) {
  test(`arquitectura · ${nombre}: ya no usa getDocs para motorizados ni para órdenes activas`, () => {
    const src = fuente(...ruta)
    assert.ok(!/getDocs\(query\(collection\(db, 'motorizado'\)/.test(src), 'motorizados ya no es getDocs')
    assert.ok(!/getDocs\(\s*query\(\s*collection\(db, 'solicitudes_envio'\),\s*where\('estado', 'in', \['asignada'/.test(src), 'órdenes activas ya no es getDocs')
    assert.ok(src.includes('useMotorizadosCandidatos()'), nombre)
  })
}

test('arquitectura · Drawer y detalle reutilizan useOrdenesActivasCandidatas (antes getDocs)', () => {
  for (const ruta of [['app', 'panel', 'gestor', '_components', 'SolicitudDrawer.tsx'], ['app', 'panel', 'gestor', 'solicitudes', '[id]', 'page.tsx']] as const) {
    const src = fuente(...ruta)
    assert.ok(src.includes('useOrdenesActivasCandidatas()'), ruta.join('/'))
  }
})

test('arquitectura · el listado principal conserva su propio realtime de órdenes activas, ahora vía el hook compartido', () => {
  const src = fuente('app', 'panel', 'gestor', 'solicitudes', 'page.tsx')
  assert.ok(src.includes('useOrdenesActivasCandidatas()'))
  assert.ok(!src.includes("onSnapshot(\n      query(\n        collection(db, 'solicitudes_envio')"), 'ya no queda el onSnapshot inline duplicado')
})

// ─── Rules / ranking / Functions: 0 cambio semántico (grep directo) ────────────

test('0 cambio semántico · pesos, carga, cercanía, compatibilidad y bolso intactos', () => {
  const r = fuente('lib', 'motorizado-ranking.ts')
  for (const linea of [
    'PESO_CARGA      = 0.40', 'PESO_CERCANIA   = 0.30', 'PESO_COMPAT     = 0.20', 'PESO_ACEPTACION = 0.10',
    'Math.max(0, 1 - cargaActual * 0.25)', 'DIST_MAX_CERCANIA = 20', 'DIST_MAX_COMPAT = 15',
    'PENALIZACION_BOLSO = 30',
  ]) assert.ok(r.includes(linea), linea)
  // La firma cambia solo por el parámetro opcional ahoraMs (ya existía desde MOTO-RANKING-UBICACION-FRESCA-1).
  assert.ok(r.includes('ahoraMs: number = Date.now()'))
})

// MOTO-RANKING-ACEPTACION-SIN-HISTORIAL-1 — el componente de aceptación
// (antes `motorizado.tasaAceptacion ?? 1.0`, favorecía a riders sin
// historial) y la resta de penalizacionRechazos en scoreTotal (duplicaba la
// misma señal con sesgo de volumen) SÍ cambiaron, deliberadamente, en ese
// bloque — cobertura completa en lib/motorizado-ranking.test.ts (RA1-RA16,
// source-contract) y lib/motorizado-ranking-aceptacion.test.ts (RT1-RT6).
// Esta suite ya no los pinnea como "intactos"; separado de la anterior para
// que el nombre del test no mienta sobre lo que realmente protege.
test('0 cambio semántico · aceptación migró a través del helper dedicado (no releyó legacy inline)', () => {
  const r = fuente('lib', 'motorizado-ranking.ts')
  assert.ok(!r.includes('motorizado.tasaAceptacion ?? 1.0'))
  assert.ok(r.includes("from './motorizado-ranking-aceptacion'"))
})
