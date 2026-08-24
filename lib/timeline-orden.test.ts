// B2.4 — Suite focal de lib/timeline-orden.ts
//
// Fixtures calcados de shenvios-staging (lectura del 2026-08-22):
//   k5Ve09HMvKYJxwgw8ba3  entregada · delivery C$80 cobrado · producto C$1.000
//                         no cobrado y luego resuelto
//   8MWJtz4GWqfesGg9qkuF  entregada · CE C$500 deducido · delivery C$150 · nada
//                         cobrado
//   OxGVVg3HYP0If3NSOqAI  entregada sin incidencia · dos depósitos confirmados
//   XbMyvCxLJrGL74Kr00mX  cancelada · sin historial, sin timestamp de cancelación

import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  construirTimeline,
  normalizarFecha,
  uidsDeTimeline,
  separarTimeline,
  hitosRecorrido,
  type EntradaTimeline,
  type TimelineEvento,
} from './timeline-orden'
import type { DepositoRegistrado } from './deposito-orden'

const ADMIN = 'RKTw1pLfK5O8Y3A6IIwDU8J3yr43'
const ids = (o: EntradaTimeline, d = {}) => construirTimeline(o, d).map((e) => e.id)
const uno = (o: EntradaTimeline, id: string, d = {}) => construirTimeline(o, d).find((e) => e.id === id)

/** k5Ve09HM, con todos los timestamps reales del documento. */
function ordenCompleta(over: Partial<EntradaTimeline> = {}): EntradaTimeline {
  return {
    createdAt: '2026-08-22T03:22:08.349Z',
    creadoInternamente: true,
    creadoPorGestorUid: ADMIN,
    confirmacion: { confirmadoAt: '2026-08-22T03:22:12.363Z', confirmadoPorUid: ADMIN, precioFinalCordobas: 80 },
    asignacion: {
      asignadoAt: '2026-08-22T03:22:12.363Z',
      asignadoPorUid: ADMIN,
      aceptadoAt: '2026-08-22T03:22:32.876Z',
      motorizadoNombre: 'John Pork 2',
    },
    historial: {
      en_camino_retiroAt: '2026-08-22T03:22:36.582Z',
      retiradoAt: '2026-08-22T03:23:07.374Z',
      en_camino_entregaAt: '2026-08-22T03:23:08.278Z',
      entregadoAt: '2026-08-22T03:23:57.827Z',
    },
    cobroContraEntrega: { aplica: true, monto: 1000 },
    pagoDelivery: { quienPaga: 'entrega', deducirDelCobroContraEntrega: false },
    cobrosMotorizado: {
      delivery: { monto: 80, recibio: true, at: '2026-08-22T03:23:57.827Z' },
      producto: {
        monto: 1000,
        recibio: false,
        estado: 'pendiente',
        justificacion: 'Otro: Cliente indico que realizara transferencia',
        at: '2026-08-22T03:23:57.827Z',
        resolucion: { tipo: 'cliente_pagara', resueltoPor: ADMIN, at: '2026-08-22T03:25:38.008Z', nota: null },
      },
    },
    cobroDelivery: { estado: 'pagado', monto: 80, quienPaga: 'entrega', registradoAt: '2026-08-22T03:23:57.827Z' },
    ...over,
  }
}

/** OxGVVg3H: entregada, todo cobrado, dos depósitos confirmados. */
function ordenSinIncidencia(over: Partial<EntradaTimeline> = {}): EntradaTimeline {
  return {
    createdAt: '2026-08-20T02:44:22.918Z',
    confirmacion: { confirmadoAt: '2026-08-20T02:44:37.459Z', confirmadoPorUid: ADMIN, precioFinalCordobas: 110 },
    asignacion: { asignadoAt: '2026-08-20T02:44:37.459Z', asignadoPorUid: ADMIN, aceptadoAt: '2026-08-20T02:44:56.993Z', motorizadoNombre: 'John Pork 2' },
    historial: {
      en_camino_retiroAt: '2026-08-20T02:45:00.782Z',
      retiradoAt: '2026-08-20T02:45:25.113Z',
      en_camino_entregaAt: '2026-08-20T02:45:26.195Z',
      entregadoAt: '2026-08-20T02:46:26.861Z',
    },
    cobroContraEntrega: { aplica: true, monto: 1000 },
    pagoDelivery: { quienPaga: 'entrega', deducirDelCobroContraEntrega: false },
    cobrosMotorizado: { delivery: { monto: 110, recibio: true }, producto: { monto: 1000, recibio: true } },
    cobroDelivery: { estado: 'pagado', monto: 110, registradoAt: '2026-08-20T02:46:26.861Z' },
    registro: {
      deposito: {
        storkhubDepositoId: 'jF4c3L6AGmzpq9L99dXQ',
        comercioDepositoId: 'gJf1rVEdZaMpTpYKRaDM',
        confirmadoStorkhub: true,
        confirmadoComercio: true,
        confirmadoStorkhubAt: '2026-08-21T22:31:43.987Z',
        confirmadoComercioAt: '2026-08-21T22:31:43.965Z',
      },
    },
    ...over,
  }
}

const depStorkhub: DepositoRegistrado = {
  id: 'jF4c3L6AGmzpq9L99dXQ',
  estado: 'confirmado',
  solicitudIds: ['OxGVVg3HYP0If3NSOqAI'],
  montoTotal: 110,
  creadoAt: '2026-08-21T22:27:44.618Z',
  confirmadoAt: '2026-08-21T22:31:43.987Z',
  confirmadoPorUid: ADMIN,
}

// ── T1 ──────────────────────────────────────────────────────────────────────
test('T1 · createdAt válido genera "Orden creada" con el actor interno', () => {
  const e = uno(ordenCompleta(), 'creada')!
  assert.equal(e.titulo, 'Orden creada')
  assert.equal(e.at.toISOString(), '2026-08-22T03:22:08.349Z')
  assert.equal(e.actorUid, ADMIN)
})

test('T1b · orden creada por comercio: evento sin actor inventado', () => {
  const e = uno(ordenCompleta({ creadoInternamente: undefined, creadoPorGestorUid: undefined }), 'creada')!
  assert.equal(e.actorUid, undefined)
  assert.equal(e.titulo, 'Orden creada')
})

test('T1c · sin createdAt no hay evento de creación', () => {
  assert.equal(ids(ordenCompleta({ createdAt: undefined })).includes('creada'), false)
})

// ── T2 ──────────────────────────────────────────────────────────────────────
test('T2 · confirmadoAt + actor → "Orden confirmada"', () => {
  const e = uno(ordenCompleta(), 'confirmada')!
  assert.equal(e.titulo, 'Orden confirmada')
  assert.equal(e.actorUid, ADMIN)
  assert.equal(e.detalle, 'C$ 80'.replace('C$ ', 'Delivery C$ ')) // "Delivery C$ 80"
})

test('T2b · updatedAt NO sustituye a confirmadoAt', () => {
  const o = ordenCompleta()
  o.confirmacion = { precioFinalCordobas: 80, confirmadoPorUid: ADMIN }
  assert.equal(ids(o).includes('confirmada'), false)
})

// ── T3 ──────────────────────────────────────────────────────────────────────
test('T3 · asignadoAt y aceptadoAt son dos eventos separados', () => {
  const t = construirTimeline(ordenCompleta())
  const a = t.find((e) => e.id === 'asignada')!
  const b = t.find((e) => e.id === 'aceptada')!
  assert.equal(a.titulo, 'Motorizado asignado')
  assert.equal(a.actorUid, ADMIN)
  assert.equal(a.detalle, 'John Pork 2')
  assert.equal(b.titulo, 'Motorizado aceptó')
  // Aceptar no persiste UID: el motorizado va como detalle, no como actor.
  assert.equal(b.actorUid, undefined)
  assert.equal(b.detalle, 'John Pork 2')
  assert.ok(a.at.getTime() < b.at.getTime())
})

// ── T4 ──────────────────────────────────────────────────────────────────────
test('T4 · los cuatro estados operativos producen cuatro eventos', () => {
  const t = construirTimeline(ordenCompleta()).filter((e) => e.tipo === 'operativo')
  assert.deepEqual(
    t.map((e) => e.id),
    ['asignada', 'aceptada', 'en_camino_retiro', 'retirado', 'en_camino_entrega', 'entregado']
  )
  // Ninguna transición operativa inventa actor: no se persiste ninguno.
  const transiciones = t.filter((e) => e.id.startsWith('en_camino') || e.id === 'retirado' || e.id === 'entregado')
  assert.equal(transiciones.length, 4)
  assert.equal(transiciones.every((e) => e.actorUid === undefined), true)
})

// ── T5 ──────────────────────────────────────────────────────────────────────
test('T5 · producto no cobrado con `at` genera incidencia', () => {
  const e = uno(ordenCompleta(), 'incidencia:producto')!
  assert.equal(e.titulo, 'Incidencia de cobro')
  assert.equal(e.tipo, 'cobro')
  assert.equal(e.at.toISOString(), '2026-08-22T03:23:57.827Z')
  assert.match(e.detalle!, /1,000/)
  assert.match(e.detalle!, /no cobrado/)
})

// ── T6 ──────────────────────────────────────────────────────────────────────
test('T6 · resolucion.at genera "Incidencia resuelta" con actor y etiqueta', () => {
  const e = uno(ordenCompleta(), 'incidencia_resuelta')!
  assert.equal(e.titulo, 'Incidencia resuelta')
  assert.equal(e.actorUid, ADMIN)
  assert.equal(e.detalle, 'Cliente/comercio lo resolverá')
  assert.equal(e.at.toISOString(), '2026-08-22T03:25:38.008Z')
})

// ── T7 ──────────────────────────────────────────────────────────────────────
test('T7 · producto no cobrado SIN `at` no inventa timestamp', () => {
  const o = ordenCompleta()
  o.cobrosMotorizado!.producto = { monto: 1000, recibio: false, estado: 'pendiente', justificacion: 'x' }
  const t = ids(o)
  assert.equal(t.includes('incidencia:producto'), false)
  // Y no se cuela por updatedAt ni por entregadoAt.
  assert.equal(t.filter((i) => i.startsWith('incidencia')).length, 0)
})

// ── T8 ──────────────────────────────────────────────────────────────────────
test('T8 · delivery sin pagadoAt y sin estado pagado no genera evento', () => {
  const o = ordenCompleta({ cobroDelivery: { estado: 'pendiente', monto: 150, registradoAt: '2026-08-22T03:23:57.827Z' } })
  assert.equal(ids(o).includes('delivery_pagado'), false)
})

test('T8b · estado "pagado" al entregar usa registradoAt, sin actor', () => {
  const e = uno(ordenCompleta(), 'delivery_pagado')!
  assert.equal(e.titulo, 'Delivery cobrado por el motorizado')
  assert.equal(e.actorUid, undefined)
  assert.equal(e.at.toISOString(), '2026-08-22T03:23:57.827Z')
})

test('T8c · pagadoAt manda sobre registradoAt y trae actor', () => {
  const o = ordenCompleta({
    cobroDelivery: {
      estado: 'pagado', monto: 80, formaPago: 'efectivo',
      registradoAt: '2026-08-22T03:23:57.827Z',
      pagadoAt: '2026-08-22T05:00:00.000Z',
      confirmadoPor: ADMIN,
    },
  })
  const e = uno(o, 'delivery_pagado')!
  assert.equal(e.titulo, 'Delivery pagado')
  assert.equal(e.actorUid, ADMIN)
  assert.equal(e.at.toISOString(), '2026-08-22T05:00:00.000Z')
})

test('T8d · cobro revertido: pagadoAt borrado no deja el evento vivo', () => {
  // La reversión elimina pagadoAt y formaPago pero conserva confirmadoAt.
  const o = ordenCompleta({
    cobroDelivery: { estado: 'pendiente', monto: 80, registradoAt: '2026-08-22T03:23:57.827Z', confirmadoPor: ADMIN },
  })
  assert.equal(ids(o).includes('delivery_pagado'), false)
})

// ── T9 ──────────────────────────────────────────────────────────────────────
test('T9 · depósito confirmado genera evento con timestamp y actor reales', () => {
  const t = construirTimeline(ordenSinIncidencia(), { storkhub: depStorkhub })
  const reg = t.find((e) => e.id === 'deposito_registrado:storkhub')!
  const conf = t.find((e) => e.id === 'deposito_confirmado:storkhub')!
  assert.equal(reg.at.toISOString(), '2026-08-21T22:27:44.618Z')
  assert.equal(conf.titulo, 'Depósito confirmado (a storkhub)')
  assert.equal(conf.actorUid, ADMIN)
  assert.equal(conf.at.toISOString(), '2026-08-21T22:31:43.987Z')
  assert.ok(reg.at.getTime() < conf.at.getTime())
})

test('T9b · sin documento de depósito no hay evento de registro', () => {
  const t = ids(ordenSinIncidencia())
  assert.equal(t.includes('deposito_registrado:storkhub'), false)
  // El confirmado sí, porque su timestamp vive en la propia orden.
  assert.equal(t.includes('deposito_confirmado:storkhub'), true)
})

test('T9c · convertido en deuda no se presenta como confirmado', () => {
  const convertido: DepositoRegistrado = { ...depStorkhub, estado: 'convertido_en_deuda', notaConversion: 'No depositó', confirmadoPorUid: ADMIN }
  const e = construirTimeline(ordenSinIncidencia(), { storkhub: convertido })
    .find((x) => x.id === 'deposito_confirmado:storkhub')!
  assert.equal(e.titulo, 'Depósito convertido en deuda (a storkhub)')
  assert.equal(e.detalle, 'No depositó')
  // La conversión no persiste actor: no se hereda el de una confirmación.
  assert.equal(e.actorUid, undefined)
})

// ── T10 ─────────────────────────────────────────────────────────────────────
test('T10 · depósito agrupado: el detalle no atribuye el total a la orden', () => {
  const agrupado: DepositoRegistrado = { ...depStorkhub, montoTotal: 450, solicitudIds: ['A', 'B', 'C', 'OxGVVg3HYP0If3NSOqAI'] }
  const t = construirTimeline(ordenSinIncidencia(), { storkhub: agrupado })
  for (const e of t.filter((x) => x.id.startsWith('deposito'))) {
    assert.equal(e.detalle?.includes('450'), false, `no debe mencionar el total agrupado: ${e.detalle}`)
  }
  assert.equal(t.find((e) => e.id === 'deposito_registrado:storkhub')!.detalle, 'Esta orden aporta C$ 110')
})

// ── T11 ─────────────────────────────────────────────────────────────────────
test('T11 · documento vacío o con campos ausentes no rompe', () => {
  assert.deepEqual(construirTimeline({}), [])
  assert.deepEqual(construirTimeline({ historial: null, asignacion: null, confirmacion: null }), [])
  assert.deepEqual(uidsDeTimeline([]), [])
})

test('T11b · orden cancelada real: solo los eventos con timestamp', () => {
  // XbMyvCxL no tiene historial, ni canceladaAt, ni actor de cancelación.
  const cancelada: EntradaTimeline = {
    createdAt: '2026-08-20T03:12:28.179Z',
    confirmacion: { confirmadoAt: '2026-08-20T03:15:23.772Z', confirmadoPorUid: ADMIN, precioFinalCordobas: 150 },
    asignacion: null,
    historial: null,
  }
  assert.deepEqual(ids(cancelada), ['creada', 'confirmada'])
  // updatedAt existe en el documento y NO se usa para inventar la cancelación.
})

// ── T12 ─────────────────────────────────────────────────────────────────────
test('T12 · timestamps inválidos se omiten', () => {
  assert.equal(normalizarFecha(undefined), null)
  assert.equal(normalizarFecha(null), null)
  assert.equal(normalizarFecha(''), null)
  assert.equal(normalizarFecha('no-es-fecha'), null)
  assert.equal(normalizarFecha(new Date('x')), null)
  assert.equal(normalizarFecha({}), null)
  assert.equal(normalizarFecha({ toDate: () => { throw new Error('boom') } }), null)
  assert.equal(ids(ordenCompleta({ createdAt: 'basura' })).includes('creada'), false)
})

test('T12b · acepta Timestamp de Firestore, Date e ISO', () => {
  const iso = '2026-08-22T03:22:08.349Z'
  const d = new Date(iso)
  assert.equal(normalizarFecha({ toDate: () => d })!.toISOString(), iso)
  assert.equal(normalizarFecha(d)!.toISOString(), iso)
  assert.equal(normalizarFecha(iso)!.toISOString(), iso)
  assert.equal(normalizarFecha({ seconds: 1787000000, nanoseconds: 0 })!.getTime(), 1787000000000)
})

// ── T13 ─────────────────────────────────────────────────────────────────────
test('T13 · el resultado es cronológico aunque los datos lleguen desordenados', () => {
  for (const t of [
    construirTimeline(ordenCompleta()),
    construirTimeline(ordenSinIncidencia(), { storkhub: depStorkhub }),
  ]) {
    for (let i = 1; i < t.length; i++) {
      assert.ok(t[i].at.getTime() >= t[i - 1].at.getTime(), `desordenado en ${t[i].id}`)
    }
    assert.equal(t[0].id, 'creada')
    assert.equal(t[t.length - 1].at.getTime() >= t[0].at.getTime(), true)
  }
})

// ── T14 ─────────────────────────────────────────────────────────────────────
test('T14 · mismo timestamp → orden estable y determinista', () => {
  // Caso real: confirmadoAt === asignadoAt al milisegundo.
  const t = construirTimeline(ordenCompleta())
  const i = t.findIndex((e) => e.id === 'confirmada')
  assert.equal(t[i + 1].id, 'asignada')

  // Caso real: cuatro eventos comparten historial.entregadoAt.
  const enEntrega = t.filter((e) => e.at.toISOString() === '2026-08-22T03:23:57.827Z').map((e) => e.id)
  assert.deepEqual(enEntrega, ['entregado', 'incidencia:producto', 'delivery_pagado'])

  // No depende del orden de las propiedades del objeto de entrada.
  const invertida: EntradaTimeline = {
    cobroDelivery: ordenCompleta().cobroDelivery,
    historial: ordenCompleta().historial,
    cobrosMotorizado: ordenCompleta().cobrosMotorizado,
    cobroContraEntrega: { aplica: true, monto: 1000 },
    pagoDelivery: { quienPaga: 'entrega', deducirDelCobroContraEntrega: false },
    asignacion: ordenCompleta().asignacion,
    confirmacion: ordenCompleta().confirmacion,
    createdAt: ordenCompleta().createdAt,
    creadoInternamente: true,
    creadoPorGestorUid: ADMIN,
  }
  assert.deepEqual(ids(invertida), ids(ordenCompleta()))
})

// ── T15 ─────────────────────────────────────────────────────────────────────
test('T15 · orden sin incidencia no genera eventos de incidencia', () => {
  const t = ids(ordenSinIncidencia())
  assert.equal(t.some((i) => i.startsWith('incidencia')), false)
  assert.deepEqual(t, [
    'creada', 'confirmada', 'asignada', 'aceptada',
    'en_camino_retiro', 'retirado', 'en_camino_entrega', 'entregado', 'delivery_pagado',
    'deposito_confirmado:comercio', 'deposito_confirmado:storkhub',
  ])
})

// ── CE deducido (fixture 8MWJtz4G) ──────────────────────────────────────────
test('CE · delivery deducido no cobrado: una sola incidencia, nunca C$650', () => {
  const o: EntradaTimeline = {
    createdAt: '2026-08-21T23:28:38.106Z',
    confirmacion: { confirmadoAt: '2026-08-21T23:29:05.259Z', confirmadoPorUid: ADMIN, precioFinalCordobas: 150 },
    asignacion: { asignadoAt: '2026-08-21T23:29:05.259Z', asignadoPorUid: ADMIN, aceptadoAt: '2026-08-21T23:29:17.664Z', motorizadoNombre: 'John Pork 2' },
    historial: { entregadoAt: '2026-08-21T23:32:52.772Z' },
    cobroContraEntrega: { aplica: true, monto: 500 },
    pagoDelivery: { quienPaga: 'entrega', deducirDelCobroContraEntrega: true },
    cobrosMotorizado: {
      delivery: { monto: 150, recibio: false, justificacion: 'D', at: '2026-08-21T23:32:52.772Z' },
      producto: {
        monto: 500, recibio: false, estado: 'pendiente', justificacion: 'D', at: '2026-08-21T23:32:52.772Z',
        resolucion: { tipo: 'cliente_pagara', resueltoPor: ADMIN, at: '2026-08-22T01:13:57.920Z', nota: null },
      },
    },
    cobroDelivery: { estado: 'pendiente', monto: 150, montoDelivery: 150, registradoAt: '2026-08-21T23:32:52.772Z' },
  }
  const t = construirTimeline(o)
  const inc = t.filter((e) => e.id.startsWith('incidencia:'))
  // Un solo evento de cobro: el CE fue una única transacción.
  assert.equal(inc.length, 1)
  assert.equal(inc[0].id, 'incidencia:producto')
  assert.match(inc[0].detalle!, /500/)
  // Nunca 650, y el delivery no se lista como incidencia aparte.
  assert.equal(t.some((e) => e.detalle?.includes('650')), false)
  assert.equal(t.some((e) => e.id === 'incidencia:delivery'), false)
  // El delivery pendiente tampoco se presenta como cobrado.
  assert.equal(t.some((e) => e.id === 'delivery_pagado'), false)
  assert.equal(t.find((e) => e.id === 'incidencia_resuelta')!.detalle, 'Cliente/comercio lo resolverá')
})

// ── Actores ─────────────────────────────────────────────────────────────────
test('UIDS · se deduplican y solo salen los realmente presentes', () => {
  const t = construirTimeline(ordenSinIncidencia(), { storkhub: depStorkhub })
  assert.deepEqual(uidsDeTimeline(t), [ADMIN])
  // Sin actores no se pide ninguna lectura.
  assert.deepEqual(uidsDeTimeline(construirTimeline({ createdAt: '2026-08-20T00:00:00.000Z' })), [])
})

test('RECHAZO · orden rechazada usa rechazo.rechazadoAt y su actor', () => {
  const o = ordenCompleta({
    historial: null,
    rechazo: { rechazadoAt: '2026-08-22T04:00:00.000Z', rechazadoPorUid: ADMIN, motivoTexto: 'Fuera de cobertura' },
  })
  const e = uno(o, 'rechazada')!
  assert.equal(e.titulo, 'Orden rechazada')
  assert.equal(e.actorUid, ADMIN)
  assert.equal(e.detalle, 'Fuera de cobertura')
})

test('RECHAZO · motivo sin timestamp no crea evento cronológico falso', () => {
  const o = ordenCompleta({ rechazo: { motivoTexto: 'Fuera de cobertura', rechazadoPorUid: ADMIN } })
  assert.equal(ids(o).includes('rechazada'), false)
})

// ═══════════════════════════════════════════════════════════════════════════
// B2.4B — clasificación de presentación
// ═══════════════════════════════════════════════════════════════════════════

const sep = (o: EntradaTimeline, d = {}) => separarTimeline(construirTimeline(o, d))

// ── UX1 ─────────────────────────────────────────────────────────────────────
test('UX1 · los ocho eventos logísticos van al recorrido', () => {
  const { recorrido } = sep(ordenCompleta())
  assert.deepEqual(recorrido.map((e) => e.id), [
    'creada', 'confirmada', 'asignada', 'aceptada',
    'en_camino_retiro', 'retirado', 'en_camino_entrega', 'entregado',
  ])
  assert.equal(recorrido.every((e) => e.grupo === 'recorrido'), true)
})

// ── UX2 / UX3 / UX4 ─────────────────────────────────────────────────────────
test('UX2 · la incidencia de cobro es un cambio, no un estado del envío', () => {
  const { recorrido, cambios } = sep(ordenCompleta())
  assert.equal(cambios.some((e) => e.id === 'incidencia:producto'), true)
  assert.equal(recorrido.some((e) => e.id.startsWith('incidencia')), false)
})

test('UX3 · la resolución de incidencia es un cambio', () => {
  const { recorrido, cambios } = sep(ordenCompleta())
  assert.equal(cambios.some((e) => e.id === 'incidencia_resuelta'), true)
  assert.equal(recorrido.some((e) => e.id === 'incidencia_resuelta'), false)
})

test('UX4 · el delivery cobrado es un cambio financiero, no logístico', () => {
  const { recorrido, cambios } = sep(ordenCompleta())
  assert.equal(cambios.some((e) => e.id === 'delivery_pagado'), true)
  assert.equal(recorrido.some((e) => e.id === 'delivery_pagado'), false)
})

// ── UX5 ─────────────────────────────────────────────────────────────────────
test('UX5 · los eventos de depósito son cambios', () => {
  const { recorrido, cambios } = sep(ordenSinIncidencia(), { storkhub: depStorkhub })
  const dep = cambios.filter((e) => e.id.startsWith('deposito'))
  assert.equal(dep.length, 3) // registrado storkhub + confirmado x2
  assert.equal(recorrido.some((e) => e.id.startsWith('deposito')), false)
})

test('UX5b · el rechazo de la orden es un cambio, no una etapa del envío', () => {
  const o = ordenCompleta({
    historial: null,
    rechazo: { rechazadoAt: '2026-08-22T04:00:00.000Z', rechazadoPorUid: ADMIN, motivoTexto: 'Fuera de cobertura' },
  })
  const { recorrido, cambios } = sep(o)
  assert.equal(cambios.some((e) => e.id === 'rechazada'), true)
  assert.equal(recorrido.some((e) => e.id === 'rechazada'), false)
})

// ── UX6 ─────────────────────────────────────────────────────────────────────
test('UX6 · la separación es una partición: sin duplicados ni pérdidas', () => {
  for (const [o, d] of [
    [ordenCompleta(), {}],
    [ordenSinIncidencia(), { storkhub: depStorkhub }],
    [{}, {}],
  ] as const) {
    const t = construirTimeline(o, d)
    const { recorrido, cambios } = separarTimeline(t)
    assert.equal(recorrido.length + cambios.length, t.length)
    const juntos = [...recorrido, ...cambios].map((e) => e.id)
    assert.equal(new Set(juntos).size, juntos.length, 'hay un evento duplicado')
    assert.deepEqual([...juntos].sort(), [...t.map((e) => e.id)].sort())
    // Cada sección conserva el orden cronológico de entrada.
    for (const lista of [recorrido, cambios]) {
      for (let i = 1; i < lista.length; i++) {
        assert.ok(lista[i].at.getTime() >= lista[i - 1].at.getTime())
      }
    }
  }
})

// ── UX7 ─────────────────────────────────────────────────────────────────────
test('UX7 · orden solo con recorrido no produce cambios', () => {
  const o = ordenCompleta({ cobrosMotorizado: undefined, cobroDelivery: undefined })
  const { recorrido, cambios } = sep(o)
  assert.equal(cambios.length, 0)
  assert.equal(recorrido.length, 8)
})

// ── UX8 ─────────────────────────────────────────────────────────────────────
test('UX8 · k5Ve09HM: 8 eventos de recorrido y 3 cambios', () => {
  const { recorrido, cambios } = sep(ordenCompleta())
  assert.equal(recorrido.length, 8)
  assert.equal(cambios.length, 3)
  assert.deepEqual(cambios.map((e) => e.id), ['incidencia:producto', 'delivery_pagado', 'incidencia_resuelta'])
})

// ── UX9 ─────────────────────────────────────────────────────────────────────
test('UX9 · CE500/delivery150: la incidencia sigue siendo una y de C$500', () => {
  const o: EntradaTimeline = {
    createdAt: '2026-08-21T23:28:38.106Z',
    confirmacion: { confirmadoAt: '2026-08-21T23:29:05.259Z', confirmadoPorUid: ADMIN, precioFinalCordobas: 150 },
    historial: { entregadoAt: '2026-08-21T23:32:52.772Z' },
    cobroContraEntrega: { aplica: true, monto: 500 },
    pagoDelivery: { quienPaga: 'entrega', deducirDelCobroContraEntrega: true },
    cobrosMotorizado: {
      delivery: { monto: 150, recibio: false, justificacion: 'D', at: '2026-08-21T23:32:52.772Z' },
      producto: { monto: 500, recibio: false, estado: 'pendiente', justificacion: 'D', at: '2026-08-21T23:32:52.772Z' },
    },
    cobroDelivery: { estado: 'pendiente', monto: 150, registradoAt: '2026-08-21T23:32:52.772Z' },
  }
  const { cambios } = sep(o)
  const inc = cambios.filter((e) => e.id.startsWith('incidencia:'))
  assert.equal(inc.length, 1)
  assert.match(inc[0].detalle!, /500/)
  assert.equal(cambios.some((e) => e.detalle?.includes('650')), false)
})

// ── UX10 ────────────────────────────────────────────────────────────────────
test('UX10 · un evento sin grupo declarado cae en cambios, no desaparece', () => {
  const desconocido: TimelineEvento = {
    id: 'evento_futuro',
    tipo: 'administrativo',
    grupo: 'cambio',
    titulo: 'Algo nuevo',
    at: new Date('2026-08-22T06:00:00.000Z'),
  }
  const { recorrido, cambios } = separarTimeline([desconocido])
  assert.equal(cambios.length, 1)
  assert.equal(recorrido.length, 0)
})

// ── Hitos ───────────────────────────────────────────────────────────────────
test('HITOS · los seis del resumen, alcanzados por timestamp real', () => {
  const h = hitosRecorrido(construirTimeline(ordenCompleta()))
  assert.deepEqual(h.map((x) => x.etiqueta), ['Creada', 'Confirmada', 'Asignada', 'Retirada', 'En entrega', 'Entregada'])
  assert.equal(h.every((x) => x.alcanzado && x.at instanceof Date), true)
})

test('HITOS · sin evento no se marca alcanzado aunque el estado lo sugiera', () => {
  // Orden cancelada real: solo creada y confirmada tienen timestamp.
  const cancelada: EntradaTimeline = {
    createdAt: '2026-08-20T03:12:28.179Z',
    confirmacion: { confirmadoAt: '2026-08-20T03:15:23.772Z', confirmadoPorUid: ADMIN, precioFinalCordobas: 150 },
    historial: null,
    asignacion: null,
  }
  const t = construirTimeline(cancelada)
  const h = hitosRecorrido(t)
  assert.deepEqual(h.filter((x) => x.alcanzado).map((x) => x.clave), ['creada', 'confirmada'])
  assert.equal(h.filter((x) => !x.alcanzado).every((x) => x.at === null), true)
  // Y la timeline no inventa un evento de cancelación para llenar la sección.
  assert.equal(separarTimeline(t).cambios.length, 0)
})

test('HITOS · "aceptó" y "en camino al retiro" no son hitos principales', () => {
  const claves = hitosRecorrido(construirTimeline(ordenCompleta())).map((h) => h.clave)
  assert.equal(claves.includes('aceptada' as never), false)
  assert.equal(claves.includes('en_camino_retiro' as never), false)
  // Pero siguen existiendo dentro del recorrido completo.
  const { recorrido } = sep(ordenCompleta())
  assert.equal(recorrido.some((e) => e.id === 'aceptada'), true)
  assert.equal(recorrido.some((e) => e.id === 'en_camino_retiro'), true)
})
