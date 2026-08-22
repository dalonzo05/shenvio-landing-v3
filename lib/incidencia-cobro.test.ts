// B1.2F — Suite focal de lib/incidencia-cobro.ts
//
// El caso de referencia es el E2E real de staging: CE 500, delivery 150,
// deducirDelCobroContraEntrega = true, el motorizado no recibió nada.
// Cobros mostraba C$650 sumando el espejo del delivery al producto.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  resumirIncidencia,
  esDeliveryDeducido,
  deliverySinClasificar,
  productoSinClasificar,
  hayIncidenciaSinClasificar,
  type EntradaIncidencia,
} from './incidencia-cobro'

/**
 * Réplica del documento real. Con deducción la Function espeja la respuesta
 * del producto sobre el delivery, así que ambos submapas comparten `recibio`,
 * `justificacion` y `at`.
 */
function ordenDeducida(over: Partial<EntradaIncidencia> = {}): EntradaIncidencia {
  return {
    pagoDelivery: { deducirDelCobroContraEntrega: true },
    confirmacion: { precioFinalCordobas: 150 },
    cobrosMotorizado: {
      producto: { monto: 500, recibio: false, justificacion: 'D' },
      delivery: { monto: 150, recibio: false, justificacion: 'D' },
    },
    ...over,
  }
}

function ordenSinDeducir(over: Partial<EntradaIncidencia> = {}): EntradaIncidencia {
  return {
    pagoDelivery: { deducirDelCobroContraEntrega: false },
    confirmacion: { precioFinalCordobas: 150 },
    cobrosMotorizado: {
      producto: { monto: 500, recibio: false, justificacion: 'x' },
      delivery: { monto: 150, recibio: false, justificacion: 'y' },
    },
    ...over,
  }
}

// ── T1 ──────────────────────────────────────────────────────────────────────
test('T1 · 500/150 deducido: la incidencia es 500, no 650', () => {
  const r = resumirIncidencia(ordenDeducida())
  assert.equal(r.monto, 500)
  assert.notEqual(r.monto, 650)
  assert.equal(r.deliveryDerivado, true)
})

test('T1b · el desglose interno suma exactamente el CE', () => {
  const r = resumirIncidencia(ordenDeducida())
  assert.equal(r.componenteDelivery, 150)
  assert.equal(r.componenteComercio, 350)
  assert.equal(r.componenteDelivery + r.componenteComercio, 500)
})

// ── T2 ──────────────────────────────────────────────────────────────────────
test('T2 · el label no dice "Delivery + Producto"', () => {
  const r = resumirIncidencia(ordenDeducida())
  assert.equal(r.tipo, 'Cobro contra entrega')
  assert.equal(r.tipo.includes('+'), false)
  assert.match(r.detalle ?? '', /Incluye delivery/)
})

// ── T3 / T4 · resolución del CE ─────────────────────────────────────────────
// El delivery NO es un ítem clasificable cuando va deducido: hubo un solo
// evento. La única clasificación posible es la del CE.
test('T3 · deducido: solo el producto queda por clasificar', () => {
  const o = ordenDeducida()
  assert.equal(deliverySinClasificar(o), false)
  assert.equal(productoSinClasificar(o), true)
  assert.deepEqual(resumirIncidencia(o).itemsAbiertos, ['producto'])
})

test('T3b · clasificado el CE, no queda incidencia sin clasificar', () => {
  // Espeja lo que escribe ResolveModal: resolución sobre el submapa producto.
  const o = ordenDeducida({
    cobrosMotorizado: {
      producto: { monto: 500, recibio: false, justificacion: 'D', resolucion: { tipo: 'cliente_pagara' } },
      delivery: { monto: 150, recibio: false, justificacion: 'D' },
    },
  })
  assert.equal(hayIncidenciaSinClasificar(o), false)
  assert.deepEqual(resumirIncidencia(o).itemsAbiertos, [])
})

test('T4 · "se pierde" tampoco reabre el delivery como incidencia', () => {
  const o = ordenDeducida({
    cobrosMotorizado: {
      producto: { monto: 500, recibio: false, justificacion: 'D', resolucion: { tipo: 'se_pierde' } },
      delivery: { monto: 150, recibio: false, justificacion: 'D' },
    },
  })
  assert.equal(hayIncidenciaSinClasificar(o), false)
  assert.equal(deliverySinClasificar(o), false)
})

// ── T5 · sin deducción son dos cobros reales ────────────────────────────────
test('T5 · 500/150 sin deducir: 650 y dos incidencias', () => {
  const r = resumirIncidencia(ordenSinDeducir())
  assert.equal(r.monto, 650)
  assert.equal(r.tipo, 'Delivery + Producto')
  assert.equal(r.deliveryDerivado, false)
  assert.deepEqual(r.itemsAbiertos, ['delivery', 'producto'])
})

// ── T6 · sin deducción, resolver una no cierra la otra ──────────────────────
test('T6 · sin deducir: resuelto el producto, el delivery sigue abierto', () => {
  const o = ordenSinDeducir({
    cobrosMotorizado: {
      producto: { monto: 500, recibio: false, justificacion: 'x', resolucion: { tipo: 'se_pierde' } },
      delivery: { monto: 150, recibio: false, justificacion: 'y' },
    },
  })
  assert.equal(productoSinClasificar(o), false)
  assert.equal(deliverySinClasificar(o), true)
  assert.equal(hayIncidenciaSinClasificar(o), true)
})

test('T6b · sin deducir: resuelto el delivery, el producto sigue abierto', () => {
  const o = ordenSinDeducir({
    cobrosMotorizado: {
      producto: { monto: 500, recibio: false, justificacion: 'x' },
      delivery: { monto: 150, recibio: false, justificacion: 'y' },
      resolucion: { tipo: 'cliente_pagara' },
    },
  })
  assert.equal(deliverySinClasificar(o), false)
  assert.equal(productoSinClasificar(o), true)
  assert.equal(hayIncidenciaSinClasificar(o), true)
})

// ── T7 · producto menor que el delivery ─────────────────────────────────────
test('T7 · 100/150 deducido: incidencia 100, no 250', () => {
  const r = resumirIncidencia(ordenDeducida({
    cobrosMotorizado: {
      producto: { monto: 100, recibio: false, justificacion: 'D' },
      delivery: { monto: 150, recibio: false, justificacion: 'D' },
    },
  }))
  assert.equal(r.monto, 100)
  // El CE no alcanza a cubrir el delivery: todo el CE es componente delivery.
  assert.equal(r.componenteDelivery, 100)
  assert.equal(r.componenteComercio, 0)
  assert.equal(r.componenteDelivery + r.componenteComercio, r.monto)
})

// ── T8 · legacy ─────────────────────────────────────────────────────────────
test('T8 · sin pagoDelivery: se trata como no deducido', () => {
  const o: EntradaIncidencia = {
    cobrosMotorizado: { producto: { monto: 500, recibio: false } },
  }
  assert.equal(esDeliveryDeducido(o), false)
  assert.equal(resumirIncidencia(o).monto, 500)
})

test('T8b · orden sin incidencias', () => {
  const r = resumirIncidencia({
    pagoDelivery: { deducirDelCobroContraEntrega: true },
    cobrosMotorizado: { producto: { monto: 500, recibio: true }, delivery: { monto: 150, recibio: true } },
  })
  assert.equal(r.monto, 0)
  assert.equal(r.tipo, '—')
  assert.deepEqual(r.itemsAbiertos, [])
})

test('T8c · documento vacío no revienta', () => {
  const r = resumirIncidencia({})
  assert.equal(r.monto, 0)
  assert.equal(r.tipo, '—')
})

// ── Invariante ──────────────────────────────────────────────────────────────
test('INV · con deducción la incidencia nunca supera el CE', () => {
  const productos = [0, 100, 150, 500, 1000]
  const deliveries = [0, 50, 150, 600]
  for (const prod of productos) {
    for (const del of deliveries) {
      const r = resumirIncidencia(ordenDeducida({
        confirmacion: { precioFinalCordobas: del },
        cobrosMotorizado: {
          producto: { monto: prod, recibio: false },
          delivery: { monto: del, recibio: false },
        },
      }))
      const ctx = `prod=${prod} del=${del}`
      assert.equal(r.monto, prod, `la incidencia debe ser el CE — ${ctx}`)
      assert.equal(r.componenteDelivery + r.componenteComercio, prod, `desglose != CE — ${ctx}`)
      assert.ok(r.componenteDelivery >= 0 && r.componenteComercio >= 0, `negativo — ${ctx}`)
    }
  }
})
