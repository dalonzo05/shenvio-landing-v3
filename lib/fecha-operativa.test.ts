// DEPOSITOS-UX-TRAZABILIDAD-1 — fecha y hora operativas en America/Managua.
//
// Fixture real: DEP-0001 (ordenes_deposito/P4IMui3ILjs0P9U6eDgT, staging).
//   creadoAt     2026-09-17T23:24:40.777Z → Managua 17/09/2026 · 17:24
//   confirmadoAt 2026-09-18T01:03:05.221Z → Managua 17/09/2026 · 19:03
// En un navegador UTC−3 se veían 20:24 y 22:03: eso es lo que se corrige.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { fechaOperativa, horaOperativa, fechaHoraOperativa, SIN_FECHA } from './fecha-operativa'

const ENVIADO = '2026-09-17T23:24:40.777Z'
const CONFIRMADO = '2026-09-18T01:03:05.221Z'

test('F1 · DEP-0001 enviado: 17/09/2026 · 17:24 en Managua', () => {
  assert.equal(fechaHoraOperativa(ENVIADO), '17/09/2026 · 17:24')
  assert.equal(fechaOperativa(ENVIADO), '17/09/2026')
  assert.equal(horaOperativa(ENVIADO), '17:24')
})

test('F2 · confirmado en UTC del 18 sigue siendo el 17 en Managua', () => {
  assert.equal(fechaHoraOperativa(CONFIRMADO), '17/09/2026 · 19:03')
})

test('F3 · Timestamp de Firestore, Date y {seconds} dan el mismo texto', () => {
  const d = new Date(ENVIADO)
  assert.equal(fechaHoraOperativa({ toDate: () => d }), '17/09/2026 · 17:24')
  assert.equal(fechaHoraOperativa(d), '17/09/2026 · 17:24')
  assert.equal(fechaHoraOperativa({ seconds: Math.floor(d.getTime() / 1000) }), '17/09/2026 · 17:24')
})

test('F4 · medianoche: 05:59Z es el día anterior, 06:00Z ya es el día', () => {
  assert.equal(fechaHoraOperativa('2026-09-18T05:59:00.000Z'), '17/09/2026 · 23:59')
  assert.equal(fechaHoraOperativa('2026-09-18T06:00:00.000Z'), '18/09/2026 · 00:00')
})

test('F5 · sin dato no se inventa "ahora"', () => {
  for (const v of [null, undefined, '', 'no-es-fecha', {}, NaN]) {
    assert.equal(fechaHoraOperativa(v), SIN_FECHA)
    assert.equal(fechaOperativa(v), SIN_FECHA)
    assert.equal(horaOperativa(v), SIN_FECHA)
  }
})

test('F6 · reloj de 24 horas, con ceros a la izquierda', () => {
  assert.equal(fechaHoraOperativa('2026-01-05T13:07:00.000Z'), '05/01/2026 · 07:07')
})
