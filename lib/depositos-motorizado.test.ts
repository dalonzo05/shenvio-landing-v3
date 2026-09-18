// DEPOSITOS-UX-TRAZABILIDAD-1 — P0 del panel Motorizado y su historial.
//
// Caso real SH-0001: delivery C$110 cobrado en efectivo por John Pork 2.
//   antes de enviar         → pendiente C$110
//   enviado, sin confirmar  → pendiente C$0 · en revisión C$110
//   confirmado              → nada pendiente, nada en revisión
// El panel viejo seguía diciendo "Total a depositar hoy C$110" en el segundo
// caso: le pedía dinero que ya había enviado.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { resumenDepositosMotorizado, historialDepositosMotorizado } from './depositos-motorizado'
import type { EntradaDepositoOrden, DepositoRegistrado } from './deposito-orden'

const SH_0001 = 'jTIJLEhGeACcymBAj0jY'

function sh0001(registro: EntradaDepositoOrden['registro'] = { deposito: null }): EntradaDepositoOrden {
  return {
    estado: 'entregado',
    tipoCliente: 'contado',
    confirmacion: { precioFinalCordobas: 110 },
    pagoDelivery: { quienPaga: 'entrega', montoSugerido: 110, deducirDelCobroContraEntrega: false, tipo: 'contado' },
    cobrosMotorizado: { delivery: { monto: 110, recibio: true } },
    cobroContraEntrega: { aplica: false, monto: 0 },
    registro,
  } as EntradaDepositoOrden
}

// Precondición: la fórmula real dice que SH-0001 obliga C$110 a StorkHub.
test('M0 · precondición: SH-0001 genera C$110 de obligación a StorkHub', () => {
  const r = resumenDepositosMotorizado([sh0001()])
  assert.equal(r.pendiente.storkhubBruto, 110)
})

test('M1 · sin puntero ⇒ pendiente de depositar C$110', () => {
  const r = resumenDepositosMotorizado([sh0001()])
  assert.equal(r.pendiente.total, 110)
  assert.equal(r.pendiente.ordenes, 1)
  assert.equal(r.enRevision.total, 0)
})

test('M2 · P0 · con puntero y sin confirmar ⇒ pendiente C$0 · en revisión C$110', () => {
  const r = resumenDepositosMotorizado([sh0001({ deposito: { storkhubDepositoId: 'P4IMui3ILjs0P9U6eDgT' } })])
  assert.equal(r.pendiente.total, 0, 'el dinero ya enviado no puede seguir como pendiente')
  assert.equal(r.pendiente.ordenes, 0)
  assert.equal(r.enRevision.storkhub, 110)
  assert.equal(r.enRevision.total, 110)
  assert.equal(r.enRevision.ordenes, 1)
})

test('M3 · confirmado ⇒ cerrado: ni pendiente ni en revisión', () => {
  const r = resumenDepositosMotorizado([sh0001({
    deposito: { storkhubDepositoId: 'P4IMui3ILjs0P9U6eDgT', confirmadoStorkhub: true, confirmadoStorkhubAt: '2026-09-18T01:03:05.221Z' },
  })])
  assert.equal(r.pendiente.total, 0)
  assert.equal(r.enRevision.total, 0)
})

test('M4 · convertido en deuda (escribe confirmadoStorkhub) ⇒ tampoco se le pide depositar', () => {
  // convertirDepositoEnDeuda() pone confirmadoStorkhub = true: el faltante
  // pasa a ser una deuda de liquidación, no un depósito por enviar.
  const r = resumenDepositosMotorizado([sh0001({ deposito: { storkhubDepositoId: 'x', confirmadoStorkhub: true } })])
  assert.equal(r.pendiente.total, 0)
  assert.equal(r.enRevision.total, 0)
})

test('M5 · gastos aprobados se descuentan solo de lo pendiente a StorkHub', () => {
  const r = resumenDepositosMotorizado([sh0001()], 30)
  assert.equal(r.pendiente.storkhubBruto, 110)
  assert.equal(r.pendiente.storkhub, 80)
  assert.equal(r.pendiente.total, 80)
  // Nunca negativo.
  assert.equal(resumenDepositosMotorizado([sh0001()], 500).pendiente.storkhub, 0)
})

test('M6 · orden sin obligación no aparece en ningún lado', () => {
  const transfer = { ...sh0001(), pagoDelivery: { quienPaga: 'transferencia' }, cobrosMotorizado: { delivery: { monto: 0, recibio: false } } } as EntradaDepositoOrden
  const r = resumenDepositosMotorizado([transfer])
  assert.equal(r.pendiente.total + r.enRevision.total, 0)
})

// ── Historial ────────────────────────────────────────────────────────────────

const DEP_0001: DepositoRegistrado = {
  id: 'P4IMui3ILjs0P9U6eDgT', codigo: 'DEP-0001', tipo: 'recaudacion_motorizado_storkhub', estado: 'confirmado',
  destinatario: 'storkhub', destinatarioNombre: 'Storkhub', motorizadoUid: 'juAOhfxi96dlLv8LV3mZwA3cK362',
  solicitudIds: [SH_0001], montoTotal: 110,
  boucher: { url: 'https://example.test/b.jpg' },
  creadoAt: '2026-09-17T23:24:40.777Z', confirmadoAt: '2026-09-18T01:03:05.221Z', confirmadoPorUid: 'RKTw1pLfK5O8Y3A6IIwDU8J3yr43',
}

test('M7 · historial: DEP-0001 con SH-0001, envío, confirmación y "StorkHub" como confirmador', () => {
  const [f] = historialDepositosMotorizado([DEP_0001], { [SH_0001]: 'SH-0001' })
  assert.equal(f.identidad.texto, 'DEP-0001')
  assert.equal(f.enviado, '2026-09-17T23:24:40.777Z')
  assert.equal(f.confirmado, '2026-09-18T01:03:05.221Z')
  assert.equal(f.destino, 'StorkHub')
  assert.equal(f.monto, 110)
  assert.equal(f.ordenes, 1)
  assert.deepEqual(f.codigosOrdenes, ['SH-0001'])
  assert.equal(f.estado, 'Confirmado')
  assert.equal(f.comprobante, 'https://example.test/b.jpg')
  // El motorizado no lee `usuarios`: nunca un UID, nunca un nombre adivinado.
  assert.equal(f.confirmadoPor, 'StorkHub')
})

test('M8 · historial: en revisión no tiene confirmador ni fecha de confirmación', () => {
  const [f] = historialDepositosMotorizado([{ ...DEP_0001, estado: 'en_revision', confirmadoAt: undefined, confirmadoPorUid: undefined }])
  assert.equal(f.estado, 'En revisión')
  assert.equal(f.confirmado, null)
  assert.equal(f.confirmadoPor, null)
  // Orden que el motorizado no tiene cargada: ID corto, no se inventa código.
  assert.deepEqual(f.codigosOrdenes, ['jTIJLEhG'])
})

test('M9 · historial excluye el pago del delivery por transferencia (tipo C)', () => {
  const c: DepositoRegistrado = { ...DEP_0001, id: 'c', codigo: 'DEP-0003', tipo: 'pago_delivery_deposito' }
  const filas = historialDepositosMotorizado([DEP_0001, c])
  assert.deepEqual(filas.map((f) => f.identidad.texto), ['DEP-0001'])
})

test('M10 · historial: más reciente primero y recortado al límite', () => {
  const deps = [1, 3, 2].map((n) => ({ ...DEP_0001, id: `d${n}`, codigo: `DEP-000${n}`, creadoAt: `2026-09-1${n}T12:00:00.000Z` }))
  const filas = historialDepositosMotorizado(deps, {}, 2)
  assert.deepEqual(filas.map((f) => f.identidad.texto), ['DEP-0003', 'DEP-0002'])
})
