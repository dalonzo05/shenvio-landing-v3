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
  accionPresencia,
  presenciaVisible,
  aplicarPresencia,
  etiquetaPresencia,
  pulsarPresencia,
  COPY_CONFIRMAR_FUERA_DE_LINEA,
} from './motorizado-presencia'
import {
  rankearMotorizados,
  calcularScore,
  getProximoPuntoOperativo,
  ubicacionOperativaFresca,
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

test('MD5/MD6 · aceptar y rechazar solo registran la métrica; el estado lo escribe únicamente el control de presencia', () => {
  const src = fuente('app', 'panel', 'motorizado', 'page.tsx')
  assert.ok(!/updateDoc\(doc\(db, 'motorizado', motorizadoDocId\), \{ estado:/.test(src), 'la página ya no escribe presencia')
  // Las métricas de aceptación ya no las acredita el cliente: las registra responderAsignacion (servidor).
  assert.ok(!src.includes('registrarAceptacion(') && !src.includes('registrarRechazo('))
  const ctl = fuente('app', 'panel', 'motorizado', '_components', 'ControlPresencia.tsx')
  // MOTO-RANKING-UBICACION-FRESCA-1: ya no es un updateDoc directo, sino la callable
  // server-side (que además sella presenciaUpdatedAt).
  assert.ok(!ctl.includes('updateDoc('), 'sin escritura directa de Firestore')
  const llamadas = ctl.match(/actualizarPresenciaCallable\(\{ estado: destino \}\)/g) ?? []
  assert.equal(llamadas.length, 1, 'una sola escritura de estado: el control explícito de presencia')
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

// ─── MOTO-PRESENCIA-UX-1: control de presencia en el menú de perfil ───────────

const HEADER_PAGE = () => fuente('app', 'panel', 'motorizado', 'page.tsx')
const LAYOUT = () => fuente('app', 'panel', 'motorizado', 'layout.tsx')
const CONTROL = () => fuente('app', 'panel', 'motorizado', '_components', 'ControlPresencia.tsx')

test('MPUX1 · en línea: el header muestra "En línea" y ya no tiene botón Desactivarme', () => {
  const src = HEADER_PAGE()
  assert.equal(etiquetaPresencia('disponible'), 'En línea')
  assert.ok(src.includes('En línea') && !src.includes('Desactivarme') && !src.includes('toggleActivarse'))
})

test('MPUX2 · fuera de línea: el header muestra "Fuera de línea" y ya no tiene botón Activarme', () => {
  const src = HEADER_PAGE()
  assert.equal(etiquetaPresencia('inactivo'), 'Fuera de línea')
  assert.ok(src.includes('Fuera de línea') && !src.includes('Activarme'))
})

test('MPUX3 · menú con estado En línea → ofrece "Ponerse fuera de línea"', () => {
  assert.equal(accionPresencia('disponible').etiqueta, 'Ponerse fuera de línea')
  assert.equal(accionPresencia('disponible').destino, 'inactivo')
})

test('MPUX4 · menú con estado Fuera de línea → ofrece "Ponerse en línea"', () => {
  assert.equal(accionPresencia('inactivo').etiqueta, 'Ponerse en línea')
  assert.equal(accionPresencia('inactivo').destino, 'disponible')
})

test('MPUX5 · pulsar "Ponerse fuera de línea" abre la confirmación y NO escribe antes de confirmar', async () => {
  const escrituras: string[] = []
  const paso = pulsarPresencia('disponible')
  assert.deepEqual(paso, { tipo: 'confirmar', destino: 'inactivo' })
  // Solo un paso de tipo 'aplicar' llega a escribir; 'confirmar' no toca nada.
  if (paso.tipo === 'aplicar') await aplicarPresencia(async (d) => { escrituras.push(d) }, paso.destino)
  assert.deepEqual(escrituras, [])
  const ctl = CONTROL()
  assert.ok(ctl.includes("paso.tipo === 'confirmar'") && ctl.includes('setConfirmando(paso.destino)'))
})

test('MPUX6 · Cancelar (o Escape, o el fondo) cierra sin escribir', () => {
  const ctl = CONTROL()
  assert.ok(ctl.includes('onClick={() => setConfirmando(null)}'), 'Cancelar solo cierra')
  assert.ok(ctl.includes("e.key === 'Escape'") && ctl.includes('setConfirmando(null)'))
  assert.ok(ctl.includes('role="dialog"') && ctl.includes('aria-modal="true"') && ctl.includes('aria-labelledby'))
  assert.equal(COPY_CONFIRMAR_FUERA_DE_LINEA.cancelar, 'Cancelar')
})

test('MPUX7 · confirmar escribe estado = inactivo por el flujo existente', async () => {
  const escrituras: string[] = []
  const paso = pulsarPresencia('disponible')
  const r = await aplicarPresencia(async (d) => { escrituras.push(d) }, paso.destino)
  assert.deepEqual(escrituras, ['inactivo'])
  assert.equal(r.ok, true)
  assert.equal(COPY_CONFIRMAR_FUERA_DE_LINEA.confirmar, 'Ponerme fuera de línea')
  // Un fallo de Firestore no se reporta como éxito.
  assert.deepEqual(await aplicarPresencia(async () => { throw new Error('permission-denied') }, 'inactivo'), { ok: false })
})

test('MPUX8 · "Ponerse en línea" escribe disponible directo, sin modal', async () => {
  const escrituras: string[] = []
  const paso = pulsarPresencia('inactivo')
  assert.deepEqual(paso, { tipo: 'aplicar', destino: 'disponible' })
  await aplicarPresencia(async (d) => { escrituras.push(d) }, paso.destino)
  assert.deepEqual(escrituras, ['disponible'])
})

test('MPUX9 · con órdenes activas, salir de línea sigue disponible: la acción no depende de las órdenes', () => {
  assert.equal(accionPresencia.length, 1, 'solo recibe el estado, no las órdenes')
  assert.equal(accionPresencia('disponible').requiereConfirmacion, true)
  assert.match(COPY_CONFIRMAR_FUERA_DE_LINEA.texto, /órdenes que ya tenés asignadas seguirán disponibles/)
  assert.ok(!/ordenes|órdenes/i.test(CONTROL().replace(/COPY_CONFIRMAR_FUERA_DE_LINEA/g, '')), 'el control no condiciona nada por órdenes')
})

test('MPUX10 · legacy ocupado se presenta En línea y ofrece "Ponerse fuera de línea"', () => {
  assert.equal(etiquetaPresencia('ocupado'), 'En línea')
  assert.equal(accionPresencia('ocupado').etiqueta, 'Ponerse fuera de línea')
  assert.ok(!/Ocupado/.test(HEADER_PAGE() + CONTROL() + LAYOUT()), 'no se muestra "Ocupado"')
  assert.equal(etiquetaPresencia(undefined), 'Sin estado', 'sin estado no se inventa En línea ni Fuera de línea')
})

test('MPUX11 · no queda copy operativo Activarme/Desactivarme en el panel motorizado vigente', () => {
  for (const src of [HEADER_PAGE(), LAYOUT(), CONTROL()]) {
    assert.ok(!/Activarme|Desactivarme/.test(src))
  }
})

test('MPUX12 · cerrar sesión sigue funcionando y no comparte acción con la presencia; el menú vive en el layout compartido', () => {
  const layout = LAYOUT()
  assert.ok(layout.includes('signOut(); }') && layout.includes('onClick={signOut}'))
  assert.ok(layout.includes('<ControlPresencia variante="sheet" />') && layout.includes('<ControlPresencia variante="sidebar" />'))
  assert.ok(!CONTROL().includes('signOut'))
})

// ─── MOTO-PRESENCIA-UX-1 (microfix): ausente o desconocido ≠ fuera de línea ────

test('MPUX13 · estado ausente → se muestra "Sin estado"', () => {
  assert.equal(etiquetaPresencia(undefined), 'Sin estado')
  assert.equal(etiquetaPresencia(null), 'Sin estado')
  assert.equal(presenciaVisible(undefined), 'sin_estado')
})

test('MPUX14 · estado desconocido → se muestra "Sin estado"', () => {
  for (const v of ['', 'otro', 'Disponible', 'INACTIVO', 42, {}]) {
    assert.equal(etiquetaPresencia(v), 'Sin estado')
    assert.equal(presenciaVisible(v), 'sin_estado')
  }
})

test('MPUX15 · estado ausente NO se muestra "Fuera de línea" (ni en el helper ni en el header)', () => {
  for (const v of [undefined, null, '', 'otro']) assert.notEqual(etiquetaPresencia(v), 'Fuera de línea')
  const page = fuente('app', 'panel', 'motorizado', 'page.tsx')
  assert.ok(!page.includes("?? 'inactivo'"), 'la página ya no convierte la ausencia en inactivo')
  assert.ok(page.includes("presenciaVisible(motorizadoEstado) === 'sin_estado'") && page.includes('Sin estado'))
  assert.ok(!page.includes('!esMotorizadoEnLinea('), 'Fuera de línea ya no es "lo que no está en línea"')
})

test('MPUX16 · desde Sin estado, "Ponerse en línea" escribe disponible directo (sin modal)', async () => {
  for (const v of [undefined, null, 'otro']) {
    assert.equal(accionPresencia(v).etiqueta, 'Ponerse en línea')
    const paso = pulsarPresencia(v)
    assert.deepEqual(paso, { tipo: 'aplicar', destino: 'disponible' })
    const escrituras: string[] = []
    await aplicarPresencia(async (d) => { escrituras.push(d) }, paso.destino)
    assert.deepEqual(escrituras, ['disponible'])
  }
  // La salida de línea conserva su confirmación.
  assert.deepEqual(pulsarPresencia('disponible'), { tipo: 'confirmar', destino: 'inactivo' })
  assert.deepEqual(pulsarPresencia('ocupado'), { tipo: 'confirmar', destino: 'inactivo' })
})

test('MPUX17 · solo inactivo se presenta como "Fuera de línea"', () => {
  assert.equal(etiquetaPresencia('inactivo'), 'Fuera de línea')
  assert.equal(presenciaVisible('inactivo'), 'fuera_de_linea')
  for (const v of ['disponible', 'ocupado', undefined, null, '', 'otro']) assert.notEqual(etiquetaPresencia(v), 'Fuera de línea')
  // Mismo contrato que el dashboard del gestor.
  assert.equal(categoriaPresencia({ activo: true, estado: undefined }), 'sin_estado')
  assert.equal(categoriaPresencia({ activo: true, estado: 'inactivo' }), 'fuera_de_linea')
})

// ─── MOTO-RANKING-UBICACION-FRESCA-1 · frescura de ultimaUbicacionOperativa ────
//
// Sin órdenes activas, `ultimaUbicacionOperativa` solo cuenta si es de HOY
// (Managua) y es posterior a `presenciaUpdatedAt` (la última transición
// EXPLÍCITA de presencia). Sin `presenciaUpdatedAt` no se asume ninguna sesión
// vigente: se usa `ubicacionBase`. Con órdenes activas nada de esto aplica.

const AHORA = new Date('2026-09-20T20:00:00.000Z').getTime() // 14:00 Managua (UTC-6)
const HOY_09H = new Date('2026-09-20T15:00:00.000Z') // 09:00 Managua, mismo día operativo
const HOY_16H = new Date('2026-09-20T22:00:00.000Z') // 16:00 Managua, mismo día operativo
const AYER = new Date('2026-09-19T15:00:00.000Z')
const OTRA_BASE = { lat: 12.05, lng: -86.3 }

function motoConUbicacion(extra: Partial<MotorizadoConRanking> = {}): MotorizadoConRanking {
  return { id: 'm1', nombre: 'm1', estado: 'disponible', activo: true, ubicacionBase: OTRA_BASE, ...extra }
}

test('UF1 · sin órdenes, ubicación de hoy con presenciaUpdatedAt anterior → usa ultimaUbicacionOperativa', () => {
  const m = motoConUbicacion({
    ultimaUbicacionOperativa: { lat: 12.2, lng: -86.1, timestamp: HOY_16H },
    presenciaUpdatedAt: HOY_09H,
  })
  assert.equal(ubicacionOperativaFresca(m, AHORA), true)
  assert.deepEqual(getProximoPuntoOperativo(m, [], AHORA), { lat: 12.2, lng: -86.1, timestamp: HOY_16H })
})

test('UF2 · sin órdenes, ubicación de ayer → usa ubicacionBase', () => {
  const m = motoConUbicacion({
    ultimaUbicacionOperativa: { lat: 12.2, lng: -86.1, timestamp: AYER },
    presenciaUpdatedAt: HOY_09H,
  })
  assert.equal(ubicacionOperativaFresca(m, AHORA), false)
  assert.deepEqual(getProximoPuntoOperativo(m, [], AHORA), OTRA_BASE)
})

test('UF2b · ubicación de ayer con presenciaUpdatedAt también de ayer (la comparación de sesión SÍ se cumple) → igual usa ubicacionBase: aísla el chequeo de día Managua', () => {
  const m = motoConUbicacion({
    ultimaUbicacionOperativa: { lat: 12.2, lng: -86.1, timestamp: AYER },
    presenciaUpdatedAt: AYER,
  })
  assert.equal(ubicacionOperativaFresca(m, AHORA), false)
  assert.deepEqual(getProximoPuntoOperativo(m, [], AHORA), OTRA_BASE)
})

test('UF3 · sin órdenes, ubicación de hoy pero presenciaUpdatedAt POSTERIOR → usa ubicacionBase', () => {
  const m = motoConUbicacion({
    ultimaUbicacionOperativa: { lat: 12.2, lng: -86.1, timestamp: HOY_09H },
    presenciaUpdatedAt: HOY_16H,
  })
  assert.equal(ubicacionOperativaFresca(m, AHORA), false)
  assert.deepEqual(getProximoPuntoOperativo(m, [], AHORA), OTRA_BASE)
})

test('UF4 · sin órdenes, ubicación POSTERIOR a presenciaUpdatedAt (mismo día) → usa ultimaUbicacionOperativa', () => {
  const m = motoConUbicacion({
    ultimaUbicacionOperativa: { lat: 12.2, lng: -86.1, timestamp: HOY_16H },
    presenciaUpdatedAt: HOY_09H,
  })
  assert.equal(ubicacionOperativaFresca(m, AHORA), true)
})

test('UF5 · sin órdenes, ubicación de hoy, SIN presenciaUpdatedAt → usa ubicacionBase (contrato conservador)', () => {
  const m = motoConUbicacion({ ultimaUbicacionOperativa: { lat: 12.2, lng: -86.1, timestamp: HOY_09H } })
  assert.equal(ubicacionOperativaFresca(m, AHORA), false)
  assert.deepEqual(getProximoPuntoOperativo(m, [], AHORA), OTRA_BASE)
})

test('UF6 · sin órdenes, ubicación inválida o sin timestamp → usa ubicacionBase', () => {
  const sinTimestamp = motoConUbicacion({ ultimaUbicacionOperativa: { lat: 12.2, lng: -86.1 }, presenciaUpdatedAt: HOY_09H })
  assert.equal(ubicacionOperativaFresca(sinTimestamp, AHORA), false)
  assert.deepEqual(getProximoPuntoOperativo(sinTimestamp, [], AHORA), OTRA_BASE)

  const sinLat = motoConUbicacion({ ultimaUbicacionOperativa: { lat: NaN as unknown as number, lng: -86.1, timestamp: HOY_16H }, presenciaUpdatedAt: HOY_09H })
  assert.equal(ubicacionOperativaFresca(sinLat, AHORA), true, 'NaN sigue siendo typeof number: la validación es de tipo, no de rango')
  const invalido = motoConUbicacion({ ultimaUbicacionOperativa: { lat: '12' as unknown as number, lng: -86.1, timestamp: HOY_16H }, presenciaUpdatedAt: HOY_09H })
  assert.equal(ubicacionOperativaFresca(invalido, AHORA), false)

  const timestampBasura = motoConUbicacion({ ultimaUbicacionOperativa: { lat: 12.2, lng: -86.1, timestamp: 'no-es-fecha' }, presenciaUpdatedAt: HOY_09H })
  assert.equal(ubicacionOperativaFresca(timestampBasura, AHORA), false)
})

test('UF7 · sin órdenes, ubicación vieja y SIN ubicacionBase → preserva el fallback actual (null)', () => {
  const m: MotorizadoConRanking = {
    id: 'm1', nombre: 'm1', estado: 'disponible', activo: true,
    ultimaUbicacionOperativa: { lat: 12.2, lng: -86.1, timestamp: AYER },
    presenciaUpdatedAt: HOY_09H,
  }
  assert.equal(getProximoPuntoOperativo(m, [], AHORA), null)
})

test('UF8 · con orden activa, ubicación operativa vieja → sigue usando el punto de la orden (sin cambios)', () => {
  const m = motoConUbicacion({
    ultimaUbicacionOperativa: { lat: 12.2, lng: -86.1, timestamp: AYER },
    presenciaUpdatedAt: HOY_09H,
  })
  const A = orden('a', 'm1', 'en_camino_entrega', ENTREGA_A)
  assert.deepEqual(getProximoPuntoOperativo(m, [A], AHORA), ENTREGA_A)
})

test('UF9 · con orden activa, presenciaUpdatedAt posterior a la ubicación → sigue usando el punto de la orden (frescura no aplica)', () => {
  const m = motoConUbicacion({
    ultimaUbicacionOperativa: { lat: 12.2, lng: -86.1, timestamp: HOY_09H },
    presenciaUpdatedAt: HOY_16H, // haría la ubicación NO fresca si se consultara; no debe consultarse
  })
  const A = orden('a', 'm1', 'asignada')
  assert.deepEqual(getProximoPuntoOperativo(m, [A], AHORA), RETIRO_A)
})

test('UF10 · fuera de línea → no entra como candidato (sin cambios respecto al contrato de presencia)', () => {
  const m = motoConUbicacion({
    estado: 'inactivo',
    ultimaUbicacionOperativa: { lat: 12.2, lng: -86.1, timestamp: HOY_16H },
    presenciaUpdatedAt: HOY_09H,
  })
  assert.deepEqual(ids(rankearMotorizados([m], [], NUEVA, AHORA)), [])
})

test('UF11 · legacy ocupado, con orden activa → comportamiento existente (frescura no aplica)', () => {
  const m = motoConUbicacion({ estado: 'ocupado' })
  const A = orden('a', 'm1', 'retirado', ENTREGA_B)
  assert.deepEqual(getProximoPuntoOperativo(m, [A], AHORA), ENTREGA_B)
  assert.deepEqual(ids(rankearMotorizados([m], [A], NUEVA, AHORA)), ['m1'])
})

test('UF12 · legacy ocupado, sin orden activa y sin presenciaUpdatedAt → usa ubicacionBase', () => {
  const m = motoConUbicacion({
    estado: 'ocupado',
    ultimaUbicacionOperativa: { lat: 12.2, lng: -86.1, timestamp: HOY_09H },
  })
  assert.deepEqual(getProximoPuntoOperativo(m, [], AHORA), OTRA_BASE)
})

test('caso A · base Ciudad Jardín, última ubicación Carretera a Masaya de hoy 15:00, presenciaUpdatedAt hoy 09:00, sin órdenes → usa Carretera a Masaya', () => {
  const CIUDAD_JARDIN = { lat: 12.11, lng: -86.28 }
  const CARRETERA_MASAYA = { lat: 11.95, lng: -86.15 }
  const hoy15h = new Date('2026-09-20T21:00:00.000Z') // 15:00 Managua
  const m = motoConUbicacion({
    ubicacionBase: CIUDAD_JARDIN,
    ultimaUbicacionOperativa: { ...CARRETERA_MASAYA, timestamp: hoy15h },
    presenciaUpdatedAt: HOY_09H,
  })
  assert.deepEqual(getProximoPuntoOperativo(m, [], AHORA), { ...CARRETERA_MASAYA, timestamp: hoy15h })
})

test('caso B · misma ubicación pero de AYER → usa Ciudad Jardín (base)', () => {
  const CIUDAD_JARDIN = { lat: 12.11, lng: -86.28 }
  const CARRETERA_MASAYA = { lat: 11.95, lng: -86.15 }
  const m = motoConUbicacion({
    ubicacionBase: CIUDAD_JARDIN,
    ultimaUbicacionOperativa: { ...CARRETERA_MASAYA, timestamp: AYER },
    presenciaUpdatedAt: HOY_09H,
  })
  assert.deepEqual(getProximoPuntoOperativo(m, [], AHORA), CIUDAD_JARDIN)
})

test('caso C · ubicación hoy 15:00, se desconecta/reconecta (presenciaUpdatedAt hoy 16:00) → usa Ciudad Jardín (base)', () => {
  const CIUDAD_JARDIN = { lat: 12.11, lng: -86.28 }
  const CARRETERA_MASAYA = { lat: 11.95, lng: -86.15 }
  const hoy15h = new Date('2026-09-20T21:00:00.000Z')
  const m = motoConUbicacion({
    ubicacionBase: CIUDAD_JARDIN,
    ultimaUbicacionOperativa: { ...CARRETERA_MASAYA, timestamp: hoy15h },
    presenciaUpdatedAt: HOY_16H, // reconexión posterior a esa ubicación
  })
  assert.deepEqual(getProximoPuntoOperativo(m, [], AHORA), CIUDAD_JARDIN)
})

test('caso D · tras reconectar, completa un evento operativo y la nueva ubicación queda después → usa la nueva ubicación operativa', () => {
  const CIUDAD_JARDIN = { lat: 12.11, lng: -86.28 }
  const nuevaUbicacion = { lat: 12.0, lng: -86.2 }
  const hoy1630 = new Date('2026-09-20T22:30:00.000Z') // 16:30 Managua
  const m = motoConUbicacion({
    ubicacionBase: CIUDAD_JARDIN,
    ultimaUbicacionOperativa: { ...nuevaUbicacion, timestamp: hoy1630 },
    presenciaUpdatedAt: HOY_16H, // reconectó a las 16:00; la ubicación es de las 16:30, posterior
  })
  assert.deepEqual(getProximoPuntoOperativo(m, [], AHORA), { ...nuevaUbicacion, timestamp: hoy1630 })
})

// ─── UI: la escritura de presencia pasa por la callable server-side ───────────

test('UI1-UI2 · ControlPresencia ya no escribe Firestore directo: usa la callable actualizarPresenciaMotorizado', () => {
  const ctl = fuente('app', 'panel', 'motorizado', '_components', 'ControlPresencia.tsx')
  assert.ok(!ctl.includes('updateDoc('))
  assert.ok(ctl.includes("httpsCallable") && ctl.includes("'actualizarPresenciaMotorizado'"))
  assert.ok(ctl.includes('actualizarPresenciaCallable({ estado: destino })'))
})

test('UI3-UI4 · el modal de confirmación y la ausencia de confirmación para "ponerse en línea" se conservan', () => {
  const ctl = fuente('app', 'panel', 'motorizado', '_components', 'ControlPresencia.tsx')
  assert.ok(ctl.includes("paso.tipo === 'confirmar'") && ctl.includes('setConfirmando(paso.destino)'))
  assert.ok(ctl.includes('role="dialog"') && ctl.includes('aria-modal="true"'))
})

test('UI5 · "Sin estado" conserva la recuperación vía "Ponerse en línea" (sin cambios de contrato)', () => {
  assert.equal(accionPresencia(undefined).etiqueta, 'Ponerse en línea')
  assert.deepEqual(pulsarPresencia(undefined), { tipo: 'aplicar', destino: 'disponible' })
})

test('UI6 · el header del panel motorizado no reincorpora ningún botón de presencia', () => {
  const pagina = fuente('app', 'panel', 'motorizado', 'page.tsx')
  assert.ok(!pagina.includes('toggleActivarse') && !pagina.includes('Activarme') && !pagina.includes('Desactivarme'))
})
