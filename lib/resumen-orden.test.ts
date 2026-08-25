// B2.6 — Suite focal de lib/resumen-orden.ts
//
// Fixtures calcados de shenvios-staging:
//   k5Ve09HM  entregada · delivery 80 cobrado · producto 1.000 no cobrado y
//             clasificado · sin depósito registrado
//   8MWJtz4G  entregada · CE 500 deducido · delivery 150 · nada cobrado
//   OxGVVg3H  entregada · todo cobrado · dos depósitos confirmados

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { resumenOrden, type EntradaResumen } from './resumen-orden'
import type { DepositoRegistrado } from './deposito-orden'

const ADMIN = 'RKTw1pLfK5O8Y3A6IIwDU8J3yr43'
const MOTO = 'John Pork 2'
const ids = (o: EntradaResumen, d = {}) => resumenOrden(o, d).pendientes.map((p) => p.id)
const textos = (o: EntradaResumen, d = {}) => resumenOrden(o, d).pendientes.map((p) => p.texto).join(' | ')

/** k5Ve09HM */
function ordenEntregada(over: Partial<EntradaResumen> = {}): EntradaResumen {
  return {
    estado: 'entregado',
    tipoServicio: 'normal',
    tipoCliente: 'contado',
    asignacion: { motorizadoNombre: MOTO, estadoAceptacion: 'aceptada' },
    cobroContraEntrega: { aplica: true, monto: 1000 },
    confirmacion: { precioFinalCordobas: 80 },
    pagoDelivery: { quienPaga: 'entrega', deducirDelCobroContraEntrega: false },
    cobrosMotorizado: {
      delivery: { monto: 80, recibio: true },
      producto: {
        monto: 1000, recibio: false, estado: 'pendiente', justificacion: 'Otro: transferencia',
        resolucion: { tipo: 'cliente_pagara', resueltoPor: ADMIN, at: '2026-08-22T03:25:38.008Z', nota: null },
      },
    },
    cobroDelivery: { estado: 'pagado', monto: 80 },
    ...over,
  }
}

const depConfirmado = (id: string, monto: number): DepositoRegistrado =>
  ({ id, estado: 'confirmado', solicitudIds: ['x'], montoTotal: monto })

// ── R1 ──────────────────────────────────────────────────────────────────────
test('R1 · entregada con C$80 por depositar: ese es el único pendiente', () => {
  const r = resumenOrden(ordenEntregada())
  assert.deepEqual(r.pendientes.map((p) => p.id), ['deposito:storkhub'])
  assert.equal(r.pendientes[0].texto, 'Motorizado debe depositar C$ 80 a StorkHub')
  assert.equal(r.pendientes[0].monto, 80)
  assert.equal(r.pendientes[0].anchor, 'depositos')
  assert.equal(r.sinPendientes, false)
  assert.equal(r.mensajeLimpio, null)
})

// ── R2 ──────────────────────────────────────────────────────────────────────
test('R2 · producto C$1.000 clasificado no es deuda de ShEnvíos', () => {
  const r = resumenOrden(ordenEntregada())
  assert.equal(r.pendientes.some((p) => p.monto === 1000), false)
  assert.equal(textos(ordenEntregada()).includes('1,000'), false)
  // Aparece como hecho cerrado, no como pendiente.
  assert.equal(r.hechos.some((h) => h.id === 'ok:incidencia'), true)
  assert.equal(r.pendientes.some((p) => p.categoria === 'incidencia'), false)
})

// ── R3 ──────────────────────────────────────────────────────────────────────
test('R3 · incidencia sin clasificar es decisión pendiente, nunca deuda', () => {
  const o = ordenEntregada()
  o.cobrosMotorizado!.producto = { monto: 1000, recibio: false, estado: 'pendiente', justificacion: 'D' }
  const r = resumenOrden(o)
  const inc = r.pendientes.find((p) => p.categoria === 'incidencia')!
  assert.equal(inc.texto, 'Incidencia de cobro por clasificar')
  // Sin monto: no se le pone cifra a algo que no es cartera.
  assert.equal(inc.monto, undefined)
  assert.equal(inc.anchor, 'incidencia')
})

// ── R4 ──────────────────────────────────────────────────────────────────────
test('R4 · delivery no cobrado es cuenta por cobrar al comercio', () => {
  const o = ordenEntregada({
    confirmacion: { precioFinalCordobas: 150 },
    cobroContraEntrega: { aplica: false },
    cobrosMotorizado: { delivery: { monto: 150, recibio: false, justificacion: 'El cliente no tenía efectivo' } },
    cobroDelivery: { estado: 'pendiente', monto: 150 },
  })
  const r = resumenOrden(o)
  const c = r.pendientes.find((p) => p.categoria === 'cobro')!
  assert.equal(c.texto, 'Comercio debe C$ 150 de delivery')
  assert.equal(c.monto, 150)
  assert.equal(c.anchor, 'cobros')
})

// ── R5 ──────────────────────────────────────────────────────────────────────
test('R5 · delivery no recibido no genera depósito del motorizado', () => {
  const o = ordenEntregada({
    confirmacion: { precioFinalCordobas: 150 },
    cobroContraEntrega: { aplica: false },
    cobrosMotorizado: { delivery: { monto: 150, recibio: false, justificacion: 'x' } },
    cobroDelivery: { estado: 'pendiente', monto: 150 },
  })
  assert.equal(ids(o).some((i) => i.startsWith('deposito:')), false)
  // Y el dinero se reclama una sola vez, al comercio.
  assert.equal(ids(o).filter((i) => i.startsWith('cobro:')).length, 1)
})

// ── R6 ──────────────────────────────────────────────────────────────────────
test('R6 · depósito confirmado deja de ser pendiente', () => {
  const r = resumenOrden(
    ordenEntregada({
      registro: { deposito: { storkhubDepositoId: 'dep1', confirmadoStorkhub: true } },
    }),
    { storkhub: depConfirmado('dep1', 80) },
  )
  assert.equal(r.pendientes.some((p) => p.categoria === 'deposito'), false)
  assert.equal(r.hechos.some((h) => h.id === 'ok:deposito:storkhub'), true)
  assert.equal(r.sinPendientes, true)
  assert.equal(r.mensajeLimpio, 'Orden completada — sin pendientes')
})

// ── R7 ──────────────────────────────────────────────────────────────────────
test('R7 · depósito en revisión se dice en revisión, y una sola vez', () => {
  const dep: DepositoRegistrado = { id: 'dep1', estado: 'en_revision', solicitudIds: ['x'], montoTotal: 80 }
  const r = resumenOrden(
    ordenEntregada({ registro: { deposito: { storkhubDepositoId: 'dep1' } } }),
    { storkhub: dep },
  )
  const d = r.pendientes.filter((p) => p.categoria === 'deposito')
  assert.equal(d.length, 1)
  assert.equal(d[0].texto, 'Depósito a StorkHub en revisión · C$ 80')
  assert.equal(d[0].severidad, 'media')
  // No se suma además un "sin depositar".
  assert.equal(r.pendientes.filter((p) => p.id === 'deposito:storkhub').length, 1)
})

test('R7b · depósito convertido en deuda vuelve a ser pendiente alto', () => {
  const dep: DepositoRegistrado = { id: 'dep1', estado: 'convertido_en_deuda', solicitudIds: ['x'], montoTotal: 80 }
  const d = resumenOrden(
    ordenEntregada({ registro: { deposito: { storkhubDepositoId: 'dep1' } } }),
    { storkhub: dep },
  ).pendientes.find((p) => p.categoria === 'deposito')!
  assert.match(d.texto, /convertido en deuda/)
  assert.equal(d.severidad, 'alta')
})

// ── R8 ──────────────────────────────────────────────────────────────────────
test('R8 · dos destinos producen dos pendientes separados, nunca sumados', () => {
  const o = ordenEntregada({
    confirmacion: { precioFinalCordobas: 110 },
    cobrosMotorizado: { delivery: { monto: 110, recibio: true }, producto: { monto: 1000, recibio: true } },
    cobroDelivery: { estado: 'pagado', monto: 110 },
  })
  const d = resumenOrden(o).pendientes.filter((p) => p.categoria === 'deposito')
  assert.deepEqual(d.map((p) => p.monto), [110, 1000])
  assert.deepEqual(d.map((p) => p.id), ['deposito:storkhub', 'deposito:comercio'])
  // 1110 no existe en ninguna parte.
  assert.equal(d.some((p) => p.monto === 1110), false)
  assert.equal(textos(o).includes('1,110'), false)
})

// ── R9 ──────────────────────────────────────────────────────────────────────
test('R9 · orden no entregada muestra el paso operativo real', () => {
  const casos: Array<[string, string, string]> = [
    ['pendiente_confirmacion', 'op:confirmar', 'Falta confirmar la orden'],
    ['confirmada', 'op:asignar', 'Falta asignar motorizado'],
    ['asignada', 'op:aceptar', `${MOTO} debe aceptar la asignación`],
    ['en_camino_retiro', 'op:retirar', 'Falta retirar el paquete'],
    ['retirado', 'op:entregar', 'Falta entregar el paquete'],
    ['en_camino_entrega', 'op:entregar', 'Falta entregar el paquete'],
  ]
  for (const [estado, id, texto] of casos) {
    const p = resumenOrden({ estado, asignacion: { motorizadoNombre: MOTO, estadoAceptacion: 'pendiente' } })
      .pendientes.find((x) => x.categoria === 'operativo')!
    assert.equal(p.id, id, `estado ${estado}`)
    assert.equal(p.texto, texto)
  }
})

test('R9b · asignación rechazada o expirada pide reasignar, no esperar', () => {
  for (const ace of ['rechazada', 'expirada']) {
    const p = resumenOrden({ estado: 'asignada', asignacion: { motorizadoNombre: MOTO, estadoAceptacion: ace } })
      .pendientes[0]
    assert.equal(p.id, 'op:reasignar')
    assert.equal(p.texto, 'Falta reasignar motorizado')
  }
})

test('R9c · entregada no genera pendiente operativo', () => {
  const r = resumenOrden(ordenEntregada())
  assert.equal(r.pendientes.some((p) => p.categoria === 'operativo'), false)
  assert.equal(r.hechos.some((h) => h.id === 'ok:entrega'), true)
})

// ── R10 ─────────────────────────────────────────────────────────────────────
test('R10 · entregada sin nada pendiente queda limpia', () => {
  const o: EntradaResumen = {
    estado: 'entregado',
    tipoCliente: 'contado',
    cobroContraEntrega: { aplica: false },
    confirmacion: { precioFinalCordobas: 0 },
    pagoDelivery: { quienPaga: 'entrega', deducirDelCobroContraEntrega: false },
    cobroDelivery: { estado: 'no_cobrar', monto: 0 },
  }
  const r = resumenOrden(o)
  assert.deepEqual(r.pendientes, [])
  assert.equal(r.sinPendientes, true)
  assert.equal(r.mensajeLimpio, 'Orden completada — sin pendientes')
})

test('R10b · cancelada se dice cancelada, no "completada"', () => {
  const r = resumenOrden({
    estado: 'cancelada',
    cobroContraEntrega: { aplica: false },
    confirmacion: { precioFinalCordobas: 150 },
    pagoDelivery: { quienPaga: 'transferencia' },
  })
  assert.deepEqual(r.pendientes, [])
  assert.equal(r.mensajeLimpio, 'Orden cerrada — sin pendientes')
  assert.equal(r.hechos.some((h) => h.texto === 'Orden cancelada'), true)
})

// ── R11 ─────────────────────────────────────────────────────────────────────
test('R11 · CE500/delivery150 deducido: nunca C$650 ni C$500 de ShEnvíos', () => {
  // 8MWJtz4G: nada cobrado, delivery deducido del CE.
  const o: EntradaResumen = {
    estado: 'entregado',
    tipoCliente: 'contado',
    asignacion: { motorizadoNombre: MOTO },
    cobroContraEntrega: { aplica: true, monto: 500 },
    confirmacion: { precioFinalCordobas: 150 },
    pagoDelivery: { quienPaga: 'entrega', deducirDelCobroContraEntrega: true },
    cobrosMotorizado: {
      delivery: { monto: 150, recibio: false, justificacion: 'D' },
      producto: {
        monto: 500, recibio: false, estado: 'pendiente', justificacion: 'D',
        resolucion: { tipo: 'cliente_pagara', resueltoPor: ADMIN, at: '2026-08-22T01:13:57.920Z', nota: null },
      },
    },
    cobroDelivery: { estado: 'pendiente', monto: 150, montoDelivery: 150, cubiertoPorDeposito: 0 },
  }
  const t = textos(o)
  assert.equal(t.includes('650'), false)
  assert.equal(t.includes('500'), false)
  // El motorizado no recibió nada: no le corresponde depositar.
  assert.equal(ids(o).some((i) => i.startsWith('deposito:')), false)
  // Lo único vivo es el delivery por cobrar.
  assert.deepEqual(ids(o), ['cobro:delivery'])
  assert.equal(resumenOrden(o).pendientes[0].monto, 150)
})

test('R11b · faltante parcial: depósito y cobro conviven sin duplicarse', () => {
  // fq6w3pXc: recibió 100 (a depositar) y quedan 50 por cobrar.
  const o: EntradaResumen = {
    estado: 'entregado',
    tipoCliente: 'contado',
    asignacion: { motorizadoNombre: MOTO },
    cobroContraEntrega: { aplica: true, monto: 100 },
    confirmacion: { precioFinalCordobas: 150 },
    pagoDelivery: { quienPaga: 'entrega', deducirDelCobroContraEntrega: true },
    cobrosMotorizado: { delivery: { monto: 150, recibio: true }, producto: { monto: 100, recibio: true } },
    cobroDelivery: { estado: 'pendiente', monto: 50, montoDelivery: 150, cubiertoPorDeposito: 100 },
  }
  const r = resumenOrden(o)
  assert.deepEqual(r.pendientes.map((p) => [p.id, p.monto]), [
    ['cobro:delivery', 50],
    ['deposito:storkhub', 100],
  ])
  // Son dos billetes distintos, no el mismo contado dos veces.
  assert.equal(textos(o).includes('150'), false)
})

// ── R12 ─────────────────────────────────────────────────────────────────────
test('R12 · documento vacío o legacy no rompe', () => {
  const r = resumenOrden({})
  assert.deepEqual(r.pendientes, [])
  assert.deepEqual(r.hechos, [])
  assert.equal(r.sinPendientes, true)
  assert.equal(r.mensajeLimpio, 'Sin pendientes detectados')
  assert.deepEqual(resumenOrden({ estado: null, asignacion: null }).pendientes, [])
})

// ── R13 ─────────────────────────────────────────────────────────────────────
test('R13 · ningún pendiente duplicado en ningún fixture', () => {
  const casos: Array<[EntradaResumen, object]> = [
    [ordenEntregada(), {}],
    [ordenEntregada({ estado: 'asignada' }), {}],
    [ordenEntregada({ registro: { deposito: { storkhubDepositoId: 'dep1' } } }), { storkhub: depConfirmado('dep1', 80) }],
    [{}, {}],
  ]
  for (const [o, d] of casos) {
    const lista = ids(o, d)
    assert.equal(new Set(lista).size, lista.length, `duplicado en ${JSON.stringify(lista)}`)
    // Y nunca el mismo destino de depósito dos veces.
    const dep = lista.filter((i) => i.startsWith('deposito:'))
    assert.equal(new Set(dep).size, dep.length)
  }
})

test('R13b · delivery cobrado NO reaparece como pendiente de cobro', () => {
  // El billete ya está en manos del motorizado: lo que falta es depositarlo.
  const r = resumenOrden(ordenEntregada())
  assert.equal(r.pendientes.some((p) => p.categoria === 'cobro'), false)
  assert.equal(r.hechos.some((h) => h.id === 'ok:delivery'), true)
  assert.equal(r.pendientes.filter((p) => p.monto === 80).length, 1)
})

// ── R14 ─────────────────────────────────────────────────────────────────────
test('R14 · los anchors apuntan solo a bloques que existen en la ficha', () => {
  const validos = ['cobros', 'incidencia', 'depositos', 'historial']
  const casos: Array<[EntradaResumen, object]> = [
    [ordenEntregada(), {}],
    [ordenEntregada({ estado: 'confirmada' }), {}],
  ]
  for (const [o, d] of casos) {
    for (const p of resumenOrden(o, d).pendientes) {
      if (p.anchor === undefined) continue
      assert.ok(validos.includes(p.anchor), `anchor inválido: ${p.anchor}`)
    }
  }
  // Un pendiente operativo no promete un bloque al que llevar.
  const op = resumenOrden({ estado: 'confirmada' }).pendientes[0]
  assert.equal(op.anchor, undefined)
})

// ── Volumen ─────────────────────────────────────────────────────────────────
test('VOLUMEN · el resumen no se convierte en un dashboard', () => {
  // Peor caso razonable: no entregada, con incidencia y dos depósitos vivos.
  const o = ordenEntregada({
    estado: 'retirado',
    cobrosMotorizado: {
      delivery: { monto: 80, recibio: true },
      producto: { monto: 1000, recibio: false, estado: 'pendiente', justificacion: 'D' },
    },
    cobroDelivery: { estado: 'pendiente', monto: 80 },
  })
  assert.ok(resumenOrden(o).pendientes.length <= 5, 'demasiados pendientes para un resumen')
})
