// MOTO-RANKING-REFERENCIA-UX-1 — copy humano para la referencia geográfica
// del ranking. Puro: solo redacta lo que lib/motorizado-ranking.ts ya
// decidió (ver ese archivo para la decisión en sí). No recalcula distancia,
// no inventa código de orden, tipo de punto ni timestamp.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { formatearAntiguedad, textoReferenciaGeografica } from './motorizado-referencia-ux'
import type { ReferenciaGeografica } from './motorizado-ranking'

const AHORA = new Date('2026-09-28T18:00:00.000Z').getTime()

// ─── proximo_punto_operativo ────────────────────────────────────────────────

test('próximo punto · con código, tipo y distancia → "Próximo punto · SH-0011 · Retiro · 0.0 km"', () => {
  const ref: ReferenciaGeografica = {
    tipo: 'proximo_punto_operativo',
    coord: { lat: 12.2, lng: -86.1 },
    ordenId: 'ordA',
    codigoOrden: 'SH-0011',
    tipoPunto: 'retiro',
  }
  assert.equal(textoReferenciaGeografica(ref, 0.02, AHORA), 'Próximo punto · SH-0011 · Retiro · 0.0 km')
})

test('próximo punto · entrega, sin código canónico → cae al ID corto (mostrarCodigo), nunca inventa un SH-####', () => {
  const ref: ReferenciaGeografica = {
    tipo: 'proximo_punto_operativo',
    coord: { lat: 12.2, lng: -86.1 },
    ordenId: 'abcdef1234567890',
    tipoPunto: 'entrega',
  }
  const texto = textoReferenciaGeografica(ref, 3.68, AHORA)
  assert.ok(texto.startsWith('Próximo punto · abcdef12'), texto)
  assert.ok(texto.includes('Entrega'))
  assert.ok(texto.includes('3.7 km'))
  assert.ok(!/SH-\d/.test(texto), 'no debe inventar un código SH-#### que el dato no tiene')
})

test('próximo punto · sin distancia disponible → sin sufijo de km (nunca "0 km" fabricado)', () => {
  const ref: ReferenciaGeografica = {
    tipo: 'proximo_punto_operativo', coord: { lat: 12.2, lng: -86.1 },
    ordenId: 'ordA', codigoOrden: 'SH-0011', tipoPunto: 'retiro',
  }
  const texto = textoReferenciaGeografica(ref, null, AHORA)
  assert.equal(texto, 'Próximo punto · SH-0011 · Retiro')
  assert.ok(!texto.includes('km'))
})

// ─── ultima_ubicacion_operativa ─────────────────────────────────────────────

test('última ubicación operativa · con timestamp real → "Última ubicación operativa · hace 18 min · 3.7 km"', () => {
  const hace18min = new Date(AHORA - 18 * 60000)
  const ref: ReferenciaGeografica = {
    tipo: 'ultima_ubicacion_operativa', coord: { lat: 12.15, lng: -86.2 }, timestamp: hace18min,
  }
  assert.equal(textoReferenciaGeografica(ref, 3.7, AHORA), 'Última ubicación operativa · hace 18 min · 3.7 km')
})

test('última ubicación operativa · sin timestamp legible → sin antigüedad, pero nunca se inventa una', () => {
  const ref: ReferenciaGeografica = { tipo: 'ultima_ubicacion_operativa', coord: { lat: 12.15, lng: -86.2 } }
  assert.equal(textoReferenciaGeografica(ref, 3.7, AHORA), 'Última ubicación operativa · 3.7 km')
})

test('RX10 · nunca se llama "Ubicación actual" a una última ubicación operativa', () => {
  const ref: ReferenciaGeografica = { tipo: 'ultima_ubicacion_operativa', coord: { lat: 12.15, lng: -86.2 } }
  const texto = textoReferenciaGeografica(ref, 3.7, AHORA)
  assert.ok(!/ubicaci[oó]n actual/i.test(texto))
  assert.ok(!/en este momento/i.test(texto))
  assert.ok(!/gps actual/i.test(texto))
  assert.ok(texto.startsWith('Última ubicación operativa'))
})

// ─── ubicacion_base ──────────────────────────────────────────────────────────

test('ubicación base · "Ubicación base · 9.3 km"', () => {
  const ref: ReferenciaGeografica = { tipo: 'ubicacion_base', coord: { lat: 12.1, lng: -86.25 } }
  assert.equal(textoReferenciaGeografica(ref, 9.3, AHORA), 'Ubicación base · 9.3 km')
})

test('ubicación base · nunca se presenta como ubicación actual/en vivo', () => {
  const ref: ReferenciaGeografica = { tipo: 'ubicacion_base', coord: { lat: 12.1, lng: -86.25 } }
  const texto = textoReferenciaGeografica(ref, 9.3, AHORA)
  assert.ok(!/ubicaci[oó]n actual/i.test(texto))
})

// ─── sin_referencia ──────────────────────────────────────────────────────────

test('sin referencia · "Sin ubicación disponible · referencia neutral"', () => {
  const ref: ReferenciaGeografica = { tipo: 'sin_referencia', coord: null }
  assert.equal(textoReferenciaGeografica(ref, null, AHORA), 'Sin ubicación disponible · referencia neutral')
})

// ─── formatearAntiguedad ─────────────────────────────────────────────────────

test('formatearAntiguedad · menos de 1 minuto → "hace instantes"', () => {
  assert.equal(formatearAntiguedad(new Date(AHORA - 10_000), AHORA), 'hace instantes')
})

test('formatearAntiguedad · minutos → "hace N min"', () => {
  assert.equal(formatearAntiguedad(new Date(AHORA - 18 * 60000), AHORA), 'hace 18 min')
})

test('formatearAntiguedad · horas → "hace Nh Mm"', () => {
  assert.equal(formatearAntiguedad(new Date(AHORA - 125 * 60000), AHORA), 'hace 2h 5m')
})

test('formatearAntiguedad · timestamp ilegible → null, sin inventar nada', () => {
  assert.equal(formatearAntiguedad(undefined, AHORA), null)
  assert.equal(formatearAntiguedad('esto no es una fecha', AHORA), null)
})

test('formatearAntiguedad · timestamp en el futuro (reloj desincronizado) → null, no se inventa una antigüedad negativa', () => {
  assert.equal(formatearAntiguedad(new Date(AHORA + 60000), AHORA), null)
})
