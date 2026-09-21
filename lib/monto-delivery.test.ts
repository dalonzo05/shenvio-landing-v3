// FIN-TRAZABILIDAD-UX-2 — monto del delivery cobrado (el "C$0" de SH-0005).

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { montoDeliveryCobrado, deliveryCubiertoPorCobroProducto } from './monto-delivery'

/** SH-0005 tal como está en staging (cobroDelivery escrito por la Function). */
const SH_0005 = {
  confirmacion: { precioFinalCordobas: 90 },
  pagoDelivery: { quienPaga: 'entrega', deducirDelCobroContraEntrega: true },
  cobroContraEntrega: { aplica: true, monto: 1000 },
  cobroDelivery: { estado: 'pagado', formaPago: 'efectivo', monto: 0, montoDelivery: 90, cubiertoPorDeposito: 90 },
}

test('CM1 · delivery C$90 deducido de un CE de C$1,000 ⇒ el monto cobrado es C$90', () => {
  assert.deepEqual(montoDeliveryCobrado(SH_0005), { monto: 90, fuente: 'montoDelivery' })
})

test('CM2 · nunca C$1,000 (el efectivo físico total del cliente)', () => {
  assert.notEqual(montoDeliveryCobrado(SH_0005).monto, 1000)
})

test('CM3 · nunca C$910 (el producto del comercio) ni C$0 (el pendiente)', () => {
  const m = montoDeliveryCobrado(SH_0005).monto
  assert.notEqual(m, 910)
  assert.notEqual(m, 0)
})

test('CM4 · transferencia tipo C histórica (SH-0003) ⇒ mantiene C$80', () => {
  const sh0003 = {
    confirmacion: { precioFinalCordobas: 80 },
    cobroDelivery: { estado: 'pagado', formaPago: 'transferencia', monto: 80 },
  }
  assert.deepEqual(montoDeliveryCobrado(sh0003), { monto: 80, fuente: 'monto' })
  // Y efectivo sin deducción (SH-0001): el monto es el precio.
  assert.equal(montoDeliveryCobrado({ cobroDelivery: { monto: 110 }, confirmacion: { precioFinalCordobas: 110 } }).monto, 110)
})

test('CM5 · delivery legítimo de C$0 (no_cobrar) ⇒ sigue en C$0, no cae al precio', () => {
  const noCobrar = { cobroDelivery: { estado: 'no_cobrar', monto: 0 }, confirmacion: { precioFinalCordobas: 0 } }
  assert.deepEqual(montoDeliveryCobrado(noCobrar), { monto: 0, fuente: 'monto' })
})

test('CM6 · sin ninguna fuente ⇒ null explícito; con solo el precio confirmado, se dice de dónde sale', () => {
  assert.deepEqual(montoDeliveryCobrado({}), { monto: null, fuente: null })
  assert.deepEqual(montoDeliveryCobrado(null), { monto: null, fuente: null })
  assert.deepEqual(montoDeliveryCobrado({ cobroDelivery: { monto: null } }), { monto: null, fuente: null })
  assert.deepEqual(montoDeliveryCobrado({ confirmacion: { precioFinalCordobas: 90 } }), { monto: 90, fuente: 'precioConfirmado' })
})

test('CM7 · faltante parcial: el monto del delivery es el total; el pendiente sigue en cobroDelivery.monto', () => {
  const parcial = { cobroDelivery: { estado: 'pendiente', monto: 20, montoDelivery: 90, cubiertoPorDeposito: 70 } }
  assert.equal(montoDeliveryCobrado(parcial).monto, 90)
  assert.equal(deliveryCubiertoPorCobroProducto(parcial), 70)
})

test('CM8 · cobertura por el CE solo cuando la hubo', () => {
  assert.equal(deliveryCubiertoPorCobroProducto(SH_0005), 90)
  const sinDeduccion = { cobroDelivery: { monto: 110 } }
  assert.equal(deliveryCubiertoPorCobroProducto(sinDeduccion), null)
  assert.equal(deliveryCubiertoPorCobroProducto({ cobroDelivery: { cubiertoPorDeposito: 0 } }), null)
})
