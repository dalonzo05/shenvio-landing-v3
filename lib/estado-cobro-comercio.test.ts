// B1.2D — Suite focal de lib/estado-cobro-comercio.ts
//
// Casos C1–C7 del bloque. El caso de referencia es el E2E real ejecutado en
// staging (orden fq6w3pXc0mXDUfQygPDF): producto 100, delivery 150, deducido.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  estadoDeliveryComercio,
  estadoDepositoProductoComercio,
  type EntradaEstadoComercio,
} from './estado-cobro-comercio'

/**
 * Réplica exacta del documento que B1.2 persistió en staging para el E2E 1.
 * Los valores están copiados del documento real, no inventados.
 */
function ordenE2E(over: Partial<EntradaEstadoComercio> = {}): EntradaEstadoComercio {
  return {
    cobroContraEntrega: { aplica: true, monto: 100 },
    confirmacion: { precioFinalCordobas: 150 },
    pagoDelivery: { quienPaga: 'entrega', deducirDelCobroContraEntrega: true },
    tipoServicio: 'managua',
    tipoCliente: 'contado',
    cobrosMotorizado: {
      delivery: { recibio: true },
      producto: { recibio: true, estado: 'pagado' },
    },
    cobroDelivery: {
      estado: 'pendiente',
      monto: 50,
      montoDelivery: 150,
      cubiertoPorDeposito: 100,
    },
    registro: null,
    ...over,
  }
}

// ── C1 ──────────────────────────────────────────────────────────────────────
// El bug original: recibio=true hacía que la UI dijera "Pagado" mientras
// quedaban 50 sin cobrar.
test('C1 · delivery 150 / cubierto 100 / pendiente 50 → pendiente de C$50', () => {
  const e = estadoDeliveryComercio(ordenE2E())
  assert.equal(e.clave, 'pendiente')
  assert.equal(e.montoPendiente, 50)
  assert.equal(e.montoDelivery, 150)
  assert.equal(e.cubiertoPorDeposito, 100)
  assert.equal(e.esParcial, true)
  // Invariante del contrato B1.2.
  assert.equal(e.montoPendiente + e.cubiertoPorDeposito, e.montoDelivery)
})

test('C1b · cobrosMotorizado.delivery.recibio=true NO alcanza para decir Pagado', () => {
  const e = estadoDeliveryComercio(ordenE2E())
  assert.notEqual(e.clave, 'pagado')
})

// ── C2 ──────────────────────────────────────────────────────────────────────
test('C2 · con pendiente > 0 y estado pendiente, corresponde subir boucher', () => {
  const e = estadoDeliveryComercio(ordenE2E())
  assert.equal(e.clave === 'pendiente' && e.montoPendiente > 0, true)
})

// ── C3 ──────────────────────────────────────────────────────────────────────
test('C3 · en_revision_deposito conserva el monto pendiente', () => {
  const e = estadoDeliveryComercio(ordenE2E({
    cobroDelivery: { estado: 'en_revision_deposito', monto: 50, montoDelivery: 150, cubiertoPorDeposito: 100 },
  }))
  assert.equal(e.clave, 'en_revision')
  assert.equal(e.montoPendiente, 50)
})

// ── C4 ──────────────────────────────────────────────────────────────────────
test('C4 · estado pagado → sin pendiente', () => {
  const e = estadoDeliveryComercio(ordenE2E({
    cobroDelivery: { estado: 'pagado', monto: 50, montoDelivery: 150, cubiertoPorDeposito: 100 },
  }))
  assert.equal(e.clave, 'pagado')
  assert.equal(e.montoPendiente, 0)
})

test('C4b · no_cobrar → sin pendiente', () => {
  const e = estadoDeliveryComercio(ordenE2E({
    cobroDelivery: { estado: 'no_cobrar', monto: 50, montoDelivery: 150, cubiertoPorDeposito: 100 },
  }))
  assert.equal(e.clave, 'no_cobrar')
  assert.equal(e.montoPendiente, 0)
})

// ── C5 ──────────────────────────────────────────────────────────────────────
// El segundo bug: el CE se consumió entero en cubrir el delivery, así que al
// comercio no le corresponde recibir nada y no hay depósito pendiente.
test('C5 · totalAlComercio = 0 → el depósito de producto NO queda pendiente', () => {
  const d = estadoDepositoProductoComercio(ordenE2E())
  assert.equal(d.clave, 'na')
  assert.equal(d.monto, 0)
})

// ── C6 ──────────────────────────────────────────────────────────────────────
test('C6 · producto 200 / delivery 150 → al comercio le corresponden 50', () => {
  const orden = ordenE2E({
    cobroContraEntrega: { aplica: true, monto: 200 },
    cobroDelivery: { estado: 'pagado', monto: 0, montoDelivery: 150, cubiertoPorDeposito: 150 },
  })
  const d = estadoDepositoProductoComercio(orden)
  assert.equal(d.clave, 'pendiente')
  assert.equal(d.monto, 50)
  // Y el delivery quedó saldado con el propio CE.
  assert.equal(estadoDeliveryComercio(orden).clave, 'pagado')
})

test('C6b · depósito ya confirmado gana sobre el cálculo', () => {
  const d = estadoDepositoProductoComercio(ordenE2E({
    cobroContraEntrega: { aplica: true, monto: 200 },
    registro: { deposito: { confirmadoComercio: true } },
  }))
  assert.equal(d.clave, 'depositado')
})

test('C6c · depósito en revisión', () => {
  const d = estadoDepositoProductoComercio(ordenE2E({
    cobroContraEntrega: { aplica: true, monto: 200 },
    registro: { deposito: { comercioDepositoId: 'dep-1' } },
  }))
  assert.equal(d.clave, 'en_revision')
})

test('C6d · sin cobro contra entrega → no aplica', () => {
  const d = estadoDepositoProductoComercio(ordenE2E({
    cobroContraEntrega: { aplica: false, monto: 0 },
  }))
  assert.equal(d.clave, 'na')
})

// ── C7 · compatibilidad legacy ──────────────────────────────────────────────
test('C7 · legacy sin montoDelivery ni cubiertoPorDeposito', () => {
  const e = estadoDeliveryComercio(ordenE2E({
    cobroDelivery: { estado: 'pendiente', monto: 130 },
  }))
  assert.equal(e.clave, 'pendiente')
  assert.equal(e.montoPendiente, 130)
  // Sin montoDelivery se asume que el pendiente ES el total.
  assert.equal(e.montoDelivery, 130)
  assert.equal(e.cubiertoPorDeposito, 0)
  assert.equal(e.esParcial, false)
})

test('C7b · legacy sin cobroDelivery: cae a cobrosMotorizado', () => {
  const e = estadoDeliveryComercio(ordenE2E({
    cobroDelivery: null,
    cobrosMotorizado: { delivery: { recibio: false, justificacion: 'El cliente no tenía efectivo' } },
  }))
  assert.equal(e.clave, 'pendiente')
  assert.equal(e.montoPendiente, 150)
})

test('C7c · legacy sin cobroDelivery y delivery cobrado', () => {
  const e = estadoDeliveryComercio(ordenE2E({
    cobroDelivery: null,
    cobrosMotorizado: { delivery: { recibio: true } },
  }))
  assert.equal(e.clave, 'pagado')
  assert.equal(e.montoPendiente, 0)
})

test('C7d · orden sin entregar: no aplica', () => {
  const e = estadoDeliveryComercio(ordenE2E({ cobroDelivery: null, cobrosMotorizado: null }))
  assert.equal(e.clave, 'na')
  assert.equal(e.montoPendiente, 0)
})

// ── Invariante general ──────────────────────────────────────────────────────
test('INV · nunca se muestra un pendiente mayor que el delivery total', () => {
  const montos = [0, 50, 100, 150, 200]
  const estados = ['pendiente', 'en_revision_deposito', 'pagado', 'no_cobrar']
  for (const prod of montos) {
    for (const del of montos) {
      for (const estado of estados) {
        const cubierto = Math.min(prod, del)
        const pendiente = Math.max(0, del - prod)
        const e = estadoDeliveryComercio(ordenE2E({
          cobroContraEntrega: { aplica: prod > 0, monto: prod },
          confirmacion: { precioFinalCordobas: del },
          cobroDelivery: { estado, monto: pendiente, montoDelivery: del, cubiertoPorDeposito: cubierto },
        }))
        const ctx = `prod=${prod} del=${del} estado=${estado}`
        assert.ok(e.montoPendiente <= e.montoDelivery, `pendiente > total — ${ctx}`)
        assert.ok(e.montoPendiente >= 0, `pendiente negativo — ${ctx}`)
      }
    }
  }
})
