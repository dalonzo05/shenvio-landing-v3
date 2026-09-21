// FIN-TRAZABILIDAD-UX-2 — "Depósitos asociados (N)" con los datos reales de
// SH-0005 (DEP-0004 a StorkHub C$90 + DEP-0005 a Mariposita C$910).

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { filasDepositosAsociados, tituloDepositosAsociados, uidsDepositosAsociados } from './depositos-asociados'
import type { DepositoRegistrado } from './deposito-orden'

const SH_0005 = 'UgQP6v3w4qnyyU0fO64l'
const ADMIN = 'RKTw1pLfK5O8Y3A6IIwDU8J3yr43'
const MOTO = 'juAOhfxi96dlLv8LV3mZwA3cK362'

const DEP_0004: DepositoRegistrado = {
  id: 'PZ04OfRT2R9y27cFfaDN', codigo: 'DEP-0004', tipo: 'recaudacion_motorizado_storkhub', estado: 'confirmado',
  destinatario: 'storkhub', destinatarioNombre: 'Storkhub', motorizadoUid: MOTO, motorizadoNombre: 'John Pork 2',
  solicitudIds: [SH_0005], montoTotal: 90, boucherVersion: 2,
  creadoAt: '2026-09-19T21:43:59.645Z', confirmadoAt: '2026-09-21T03:50:49.041Z', confirmadoPorUid: ADMIN,
  boucher: { url: 'https://example.test/v2.jpg', pathStorage: 'x', uploadedAt: '2026-09-21T03:48:08.171Z' },
}
const DEP_0005: DepositoRegistrado = {
  id: 'oxbOqPxj3RmPKdXahedk', codigo: 'DEP-0005', tipo: 'recaudacion_motorizado_comercio', estado: 'confirmado',
  destinatario: 'comercio', destinatarioNombre: 'Mariposita', motorizadoUid: MOTO, motorizadoNombre: 'John Pork 2',
  solicitudIds: [SH_0005], montoTotal: 910,
  creadoAt: '2026-09-19T21:44:07.739Z', confirmadoAt: '2026-09-21T03:50:49.085Z', confirmadoPorUid: ADMIN,
  boucher: { url: 'https://example.test/b.jpg', pathStorage: 'y', uploadedAt: '2026-09-19T21:44:10.938Z' },
}

test('DA1 · orden sin depósitos ⇒ "Depósitos asociados (0)" y lista vacía', () => {
  assert.deepEqual(filasDepositosAsociados([]), [])
  assert.equal(tituloDepositosAsociados(0), 'Depósitos asociados (0)')
})

test('DA2 · un depósito ⇒ una fila', () => {
  const f = filasDepositosAsociados([DEP_0004])
  assert.equal(f.length, 1)
  assert.equal(tituloDepositosAsociados(f.length), 'Depósitos asociados (1)')
})

test('DA3 · SH-0005 ⇒ dos filas, en orden de creación, sin duplicar un mismo documento', () => {
  const f = filasDepositosAsociados([DEP_0005, DEP_0004, DEP_0004, null])
  assert.deepEqual(f.map((x) => x.identidad.texto), ['DEP-0004', 'DEP-0005'])
  assert.equal(tituloDepositosAsociados(f.length), 'Depósitos asociados (2)')
})

test('DA4 · montos separados: C$90 y C$910', () => {
  const f = filasDepositosAsociados([DEP_0004, DEP_0005])
  assert.deepEqual(f.map((x) => x.monto), [90, 910])
})

test('DA5 · nunca una obligación sumada: ningún campo lleva C$1,000', () => {
  const f = filasDepositosAsociados([DEP_0004, DEP_0005])
  assert.ok(!JSON.stringify(f).includes('1000'))
  assert.ok(f.every((x) => !('total' in x)))
})

test('DA6 · tipo y destino correctos, con el motorizado resuelto; el tipo C no es "Motorizado → StorkHub"', () => {
  const f = filasDepositosAsociados([DEP_0004, DEP_0005], null, () => 'John Pork 2')
  assert.deepEqual(f.map((x) => x.origenDestino), ['John Pork 2 → StorkHub', 'John Pork 2 → Mariposita'])
  assert.equal(filasDepositosAsociados([DEP_0004])[0].origenDestino, 'Motorizado → StorkHub')
  const tipoC: DepositoRegistrado = {
    id: 'a2HgEC7RcMkgREr4HGD1', codigo: 'DEP-0002', tipo: 'pago_delivery_deposito', estado: 'confirmado',
    destinatario: 'storkhub', solicitudIds: ['OZmiYGHAlUBaAzY4yn9I'], montoTotal: 80, boucherUrl: 'https://example.test/c.jpg',
    creadoAt: '2026-09-18T04:20:53.728Z', confirmadoAt: '2026-09-18T04:20:53.728Z',
  }
  const [c] = filasDepositosAsociados([tipoC], null, () => 'John Pork 2')
  assert.equal(c.origenDestino, 'Pago del delivery por transferencia')
  assert.equal(c.monto, 80)
})

test('DA7 · estado del documento y momentos por tipo', () => {
  const [a] = filasDepositosAsociados([DEP_0004])
  assert.equal(a.estado, 'Confirmado')
  assert.deepEqual(a.momentos.map((m) => m.etiqueta), ['Enviado', 'Confirmado'])
  const [d] = filasDepositosAsociados([{ ...DEP_0004, estado: 'devuelto' }])
  assert.equal(d.estado, 'Corrección solicitada')
})

test('DA8 · "Confirmado por" solo con el depósito confirmado; tras un Rehacer ya no se afirma', () => {
  const f = filasDepositosAsociados([DEP_0004, DEP_0005])
  assert.deepEqual(f.map((x) => x.confirmadoPorUid), [ADMIN, ADMIN])
  assert.deepEqual(uidsDepositosAsociados(f), [ADMIN])
  const [r] = filasDepositosAsociados([{ ...DEP_0004, estado: 'en_revision' }])
  assert.equal(r.confirmadoPorUid, null)
})

test('DA9 · versión del comprobante solo cuando se corrigió; agrupado cuando incluye otras órdenes', () => {
  const [a, b] = filasDepositosAsociados([DEP_0004, DEP_0005])
  assert.equal(a.versionComprobante, 2)
  assert.equal(b.versionComprobante, null)
  const [g] = filasDepositosAsociados([{ ...DEP_0005, solicitudIds: [SH_0005, 'otra'] }])
  assert.equal(g.esAgrupado, true)
  assert.equal(g.ordenesIncluidas, 2)
})
