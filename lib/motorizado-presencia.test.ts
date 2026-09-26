// MOTO-DISPONIBILIDAD-CONTRATO-1 — `motorizado.estado` es presencia; la carga sale
// de las órdenes activas.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import {
  esMotorizadoEnLinea,
  presenciaAlAlternar,
  tieneCargaOperativa,
  PRESENCIAS_ESCRIBIBLES,
  categoriaPresencia,
  resumenPresencia,
} from './motorizado-presencia'
import {
  rankearMotorizados,
  calcularScore,
  getProximoPuntoOperativo,
  type MotorizadoConRanking,
  type OrdenActivaRanking,
  type NuevaOrdenRanking,
} from './motorizado-ranking'

const BASE = { lat: 12.13, lng: -86.25 }
const RETIRO_A = { lat: 12.14, lng: -86.26 }
const ENTREGA_A = { lat: 12.16, lng: -86.2 }
const ENTREGA_B = { lat: 12.11, lng: -86.3 }
const NUEVA: NuevaOrdenRanking = { recoleccion: { coord: { lat: 12.135, lng: -86.255 } }, entrega: { coord: ENTREGA_A } }

function moto(id: string, estado: string | undefined, extra: Partial<MotorizadoConRanking> = {}): MotorizadoConRanking {
  return { id, nombre: id, estado, activo: true, ubicacionBase: BASE, ...extra }
}
function orden(id: string, motorizadoId: string, estado = 'en_camino_entrega', entrega = ENTREGA_A): OrdenActivaRanking {
  return { id, estado, asignacion: { motorizadoId }, recoleccion: { coord: RETIRO_A }, entrega: { coord: entrega } }
}
const ids = (r: { id: string }[]) => r.map((m) => m.id)

// ─── MD1–MD4: presencia y elegibilidad ────────────────────────────────────────

test('MD1 · disponible + 0 órdenes → en línea y elegible', () => {
  assert.equal(esMotorizadoEnLinea('disponible'), true)
  assert.deepEqual(ids(rankearMotorizados([moto('m1', 'disponible')], [], NUEVA)), ['m1'])
})

test('MD2 · disponible + 1 orden activa → sigue en línea y elegible; el ranking usa su ruta y su carga', () => {
  const r = rankearMotorizados([moto('m1', 'disponible')], [orden('a', 'm1')], NUEVA)
  assert.deepEqual(ids(r), ['m1'])
  assert.equal(r[0].scoreResult.detalles.cargaActual, 1)
  assert.deepEqual(r[0].scoreResult.detalles.proximoPuntoOperativo, ENTREGA_A)
})

test('MD3 · disponible + 2 órdenes activas → sigue elegible; scoreCarga penaliza sin tope duro', () => {
  const c = (n: number) => calcularScore(moto('m1', 'disponible'), Array.from({ length: n }, (_, i) => orden('o' + i, 'm1')), NUEVA, []).detalles.scoreCarga
  assert.equal(c(0), 1)
  assert.equal(c(1), 0.75)
  assert.equal(c(2), 0.5)
  assert.equal(c(4), 0)
  const r = rankearMotorizados([moto('m1', 'disponible')], [orden('a', 'm1'), orden('b', 'm1')], NUEVA)
  assert.deepEqual(ids(r), ['m1'], 'con dos órdenes sigue siendo candidato')
})

test('MD4 · inactivo → no es elegible para una asignación nueva', () => {
  assert.equal(esMotorizadoEnLinea('inactivo'), false)
  assert.deepEqual(ids(rankearMotorizados([moto('m1', 'inactivo'), moto('m2', 'disponible')], [], NUEVA)), ['m2'])
})

test('MD4b · inactivo con órdenes: no recibe sugerencias nuevas y sus órdenes existentes no se tocan', () => {
  const ordenes = [orden('a', 'm1')]
  const antes = JSON.stringify(ordenes)
  const r = rankearMotorizados([moto('m1', 'inactivo'), moto('m2', 'disponible')], ordenes, NUEVA)
  assert.deepEqual(ids(r), ['m2'])
  assert.equal(JSON.stringify(ordenes), antes, 'el ranking no modifica las órdenes asignadas')
  assert.equal(ordenes[0].asignacion?.motorizadoId, 'm1')
})

// ─── MD5–MD9: una orden no decide la presencia (los flujos ya no escriben estado) ──

function fuente(...ruta: string[]) {
  return readFileSync(join(__dirname, '..', ...ruta), 'utf8')
}
const FLUJOS_DE_ORDEN: Array<[string, string[]]> = [
  ['panel motorizado (aceptar, rechazar, avanzar, entregar)', ['app', 'panel', 'motorizado', 'page.tsx']],
  ['gestor: detalle de solicitud (rebotar, reactivar, rechazar)', ['app', 'panel', 'gestor', 'solicitudes', '[id]', 'page.tsx']],
  ['gestor: listado de solicitudes (rebotar)', ['app', 'panel', 'gestor', 'solicitudes', 'page.tsx']],
  ['gestor: drawer de solicitud (rebotar, reactivar, rechazar)', ['app', 'panel', 'gestor', '_components', 'SolicitudDrawer.tsx']],
  ['gestor: Base de datos (rebotar)', ['app', 'panel', 'gestor', 'base-datos', 'page.tsx']],
]

for (const [nombre, ruta] of FLUJOS_DE_ORDEN) {
  test(`MD5-MD9 · ${nombre}: ninguna transición de una orden escribe motorizado.estado`, () => {
    const src = fuente(...ruta)
    assert.ok(!/doc\(db, 'motorizado'[^)]*\)[^\n]*estado:\s*'(disponible|ocupado)'/.test(src), 'update directo de estado al doc motorizado')
    assert.ok(!/estado:\s*nuevo === 'entregado' \? 'disponible' : 'ocupado'/.test(src), 'entregar/avanzar decide la presencia')
  })
}

test('MD5/MD6 · aceptar y rechazar solo registran la métrica; el estado lo escribe únicamente el toggle manual', () => {
  const src = fuente('app', 'panel', 'motorizado', 'page.tsx')
  const escrituras = src.match(/updateDoc\(doc\(db, 'motorizado', motorizadoDocId\), \{ estado:/g) ?? []
  assert.equal(escrituras.length, 1, 'una sola escritura de estado: el toggle explícito')
  assert.ok(src.includes('presenciaAlAlternar(motorizadoEstado)'))
  assert.ok(src.includes('registrarAceptacion(motorizadoDocId') && src.includes('registrarRechazo(motorizadoDocId)'))
})

// ─── MD10–MD11: presencia manual ──────────────────────────────────────────────

test('MD10 · el toggle manual alterna disponible → inactivo → disponible, y solo escribe valores válidos', () => {
  assert.equal(presenciaAlAlternar('disponible'), 'inactivo')
  assert.equal(presenciaAlAlternar('inactivo'), 'disponible')
  assert.equal(presenciaAlAlternar(undefined), 'disponible')
  assert.equal(presenciaAlAlternar(null), 'disponible')
  for (const e of ['disponible', 'ocupado', 'inactivo', undefined]) {
    assert.ok(PRESENCIAS_ESCRIBIBLES.includes(presenciaAlAlternar(e)))
  }
  assert.ok(!(PRESENCIAS_ESCRIBIBLES as readonly string[]).includes('ocupado'), 'ocupado no se escribe')
})

test('MD11 · fuera de línea con una orden activa: el panel no condiciona la lista de órdenes a la presencia', () => {
  const src = fuente('app', 'panel', 'motorizado', 'page.tsx')
  assert.ok(!src.includes("motorizadoEstado === 'ocupado'"), 'ya no se bloquea nada por el valor legacy')
  // motorizadoEstado solo se usa para el badge y el botón, nunca para filtrar órdenes.
  const usos = src.split('\n').filter((l) => l.includes('motorizadoEstado') && /filter|where\(|pendientes|enCurso/.test(l))
  assert.deepEqual(usos, [])
  // La orden de un motorizado inactivo sigue ligada a él en el ranking (no se reasigna ni se oculta).
  const ordenes = [orden('a', 'm1')]
  assert.equal(getProximoPuntoOperativo(moto('m1', 'inactivo'), ordenes)?.lat, ENTREGA_A.lat)
})

// ─── MD12–MD14: legacy `ocupado` ──────────────────────────────────────────────

test('MD12 · legacy ocupado + órdenes activas → en línea y el ranking usa su carga y su ruta', () => {
  assert.equal(esMotorizadoEnLinea('ocupado'), true)
  const r = rankearMotorizados([moto('m1', 'ocupado')], [orden('a', 'm1')], NUEVA)
  assert.deepEqual(ids(r), ['m1'])
  assert.equal(r[0].scoreResult.detalles.cargaActual, 1)
  assert.deepEqual(r[0].scoreResult.detalles.proximoPuntoOperativo, ENTREGA_A)
})

test('MD13 · legacy ocupado + 0 órdenes → en línea y el ranking lo trata como sin carga', () => {
  const s = calcularScore(moto('m1', 'ocupado'), [], NUEVA, []).detalles
  assert.equal(s.cargaActual, 0)
  assert.equal(s.scoreCarga, 1)
  assert.equal(s.scoreCompatibilidad, 1, 'sin órdenes: ruta libre, aunque el valor crudo diga ocupado')
  assert.equal(s.bonificacionZonaTotal, 0)
  assert.deepEqual(s.proximoPuntoOperativo, BASE)
})

test('MD14 · disponible y ocupado legacy con las mismas órdenes → mismo resultado de carga, ruta y zona', () => {
  for (const ordenes of [[], [orden('a', 'm1')], [orden('a', 'm1'), orden('b', 'm1', 'retirado', ENTREGA_B)]]) {
    const a = calcularScore(moto('m1', 'disponible'), ordenes, NUEVA, ordenes)
    const b = calcularScore(moto('m1', 'ocupado'), ordenes, NUEVA, ordenes)
    assert.equal(a.score, b.score)
    assert.deepEqual(a.detalles, b.detalles)
    assert.equal(a.explicacion, b.explicacion)
  }
})

// ─── Multiasignación: cerrar una orden no toca el resto ────────────────────────

test('CRÍTICO · M con órdenes A y B: al cerrar, rechazar o cancelar A, B sigue activa y la presencia no cambia', () => {
  for (const estadoCrudo of ['disponible', 'ocupado']) {
    const m = moto('M', estadoCrudo)
    const A = orden('A', 'M', 'en_camino_entrega', ENTREGA_A)
    const B = orden('B', 'M', 'retirado', ENTREGA_B)
    const antes = calcularScore(m, [A, B], NUEVA, [A, B])
    assert.equal(antes.detalles.cargaActual, 2)

    for (const cierre of ['entregado', 'rechazada', 'cancelada', 'confirmada']) {
      // A sale del conjunto de órdenes activas (o se libera): el resto del mundo no cambia.
      const restantes = [{ ...A, estado: cierre, asignacion: null }, B].filter((o) => ['asignada', 'en_camino_retiro', 'retirado', 'en_camino_entrega'].includes(o.estado))
      const despues = calcularScore(m, restantes, NUEVA, restantes)
      assert.equal(despues.detalles.cargaActual, 1, `B sigue activa tras ${cierre} de A`)
      assert.deepEqual(despues.detalles.proximoPuntoOperativo, ENTREGA_B, 'el próximo punto se deriva de B')
      assert.ok(tieneCargaOperativa(restantes))
      assert.equal(m.estado, estadoCrudo, 'el estado crudo del motorizado no se recalcula por A')
      assert.equal(esMotorizadoEnLinea(m.estado), true)
      assert.deepEqual(ids(rankearMotorizados([m], restantes, NUEVA)), ['M'], 'sigue siendo candidato')
    }
  }
})

test('presencia · valores desconocidos o ausentes no cuentan como en línea', () => {
  for (const v of [undefined, null, '', 'otro', 'Disponible']) assert.equal(esMotorizadoEnLinea(v), false)
  assert.equal(tieneCargaOperativa([]), false)
  assert.equal(tieneCargaOperativa([{}]), true)
})

// ─── Dashboard del gestor: presencia, no carga ─────────────────────────────────

test('MDD1 · disponible → cuenta como En línea', () => {
  assert.equal(categoriaPresencia({ activo: true, estado: 'disponible' }), 'en_linea')
  assert.equal(resumenPresencia([{ activo: true, estado: 'disponible' }]).enLinea, 1)
})

test('MDD2 · ocupado legacy → cuenta como En línea (no se migra ni se oculta)', () => {
  assert.equal(categoriaPresencia({ activo: true, estado: 'ocupado' }), 'en_linea')
  const r = resumenPresencia([{ activo: true, estado: 'ocupado' }, { activo: true, estado: 'disponible' }])
  assert.deepEqual(r, { total: 2, enLinea: 2, fueraDeLinea: 0, inactivos: 0 })
})

test('MDD3 · inactivo con cuenta activa → Fuera de línea, distinto de la cuenta desactivada', () => {
  assert.equal(categoriaPresencia({ activo: true, estado: 'inactivo' }), 'fuera_de_linea')
  const r = resumenPresencia([{ activo: true, estado: 'inactivo' }])
  assert.deepEqual(r, { total: 1, enLinea: 0, fueraDeLinea: 1, inactivos: 0 })
})

test('MDD4 · activo=false → Inactivo de cuenta, sea cual sea su presencia', () => {
  for (const estado of ['disponible', 'ocupado', 'inactivo', undefined]) {
    assert.equal(categoriaPresencia({ activo: false, estado }), 'inactivo')
  }
  assert.deepEqual(resumenPresencia([{ activo: false, estado: 'disponible' }, { activo: false, estado: 'inactivo' }]), { total: 2, enLinea: 0, fueraDeLinea: 0, inactivos: 2 })
})

test('MDD5 · estado ausente o desconocido → NO cuenta como En línea ni como Fuera de línea', () => {
  for (const estado of [undefined, null, '', 'otro']) {
    assert.equal(categoriaPresencia({ activo: true, estado }), 'sin_estado')
  }
  assert.deepEqual(resumenPresencia([{ activo: true }, { activo: true, estado: 'otro' }]), { total: 2, enLinea: 0, fueraDeLinea: 0, inactivos: 0 })
})

test('MDD6 · el dashboard ya no trata ocupado como categoría operativa vigente y usa el helper de presencia', () => {
  const src = readFileSync(join(__dirname, '..', 'app', 'panel', 'gestor', 'page.tsx'), 'utf8')
  assert.ok(!src.includes("'ocupado'"), "sin literal 'ocupado'")
  assert.ok(!/resumenMotorizados.ocupados|>s*Ocupados/.test(src), 'sin contador ni filtro Ocupados')
  assert.ok(src.includes('resumenPresencia(motorizados)') && src.includes('categoriaPresencia('))
})
