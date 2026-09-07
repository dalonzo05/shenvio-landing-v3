// IDENTIDAD-HUMANA-1 — suite focal de lib/codigo-humano.ts
//
// Los ejemplos son los literales fijados en el bloque de producto: SH-1001,
// DEP-1001, SH-1000000. La suite de Functions comprueba su lado contra ESTOS
// MISMOS literales, que es lo que ata el contrato de frontera sin que ninguno
// de los dos importe al otro.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  formatearCodigo,
  esCodigoCanonico,
  prefijoDeCodigo,
  secuenciaDeCodigo,
  parseBusquedaCodigo,
  coincideCodigo,
  mostrarCodigo,
  esFallbackTecnico,
  PREFIJO_ORDEN,
  PREFIJO_DEPOSITO,
  CODIGO_AUSENTE,
} from './codigo-humano'

// ── Formato canónico ─────────────────────────────────────────────────────────

test('C1 · 1058 ⇒ SH-1058 · 247 ⇒ DEP-247', () => {
  assert.equal(formatearCodigo(PREFIJO_ORDEN, 1058), 'SH-1058')
  assert.equal(formatearCodigo(PREFIJO_DEPOSITO, 247), 'DEP-247')
  assert.equal(formatearCodigo(PREFIJO_ORDEN, 1001), 'SH-1001')
  assert.equal(formatearCodigo(PREFIJO_DEPOSITO, 1001), 'DEP-1001')
})

test('C2 · un millón no cambia el formato', () => {
  assert.equal(formatearCodigo(PREFIJO_ORDEN, 1000000), 'SH-1000000')
  assert.equal(esCodigoCanonico('SH-1000000'), true)
  assert.equal(secuenciaDeCodigo('SH-1000000'), 1000000)
})

test('C3 · prefijo no permitido ⇒ error', () => {
  for (const p of ['ORD', 'sh', 'Sh', '', 'SHH', 'DEPO']) {
    assert.throws(() => formatearCodigo(p, 1), /prefijo no permitido/)
  }
})

test('C4 · secuencia inválida ⇒ error', () => {
  for (const n of [0, -1, 1.5, NaN, Infinity]) {
    assert.throws(() => formatearCodigo(PREFIJO_ORDEN, n), /secuencia invalida/)
  }
})

test('C5 · canónico estricto: sin padding, sin minúsculas, con guion', () => {
  for (const v of ['SH-1001', 'DEP-1001', 'SH-1', 'DEP-999999999']) {
    assert.equal(esCodigoCanonico(v), true, `rechazó ${v}`)
  }
  const invalidos: unknown[] = [
    'SH-001001',   // padding: el sistema no lo usa
    'sh-1001',     // minúsculas: válido para buscar, nunca para persistir
    'SH1001',      // sin guion
    'ORD-1001',    // prefijo ajeno
    'SH-0', 'SH-', '-1001', 'SH-1001 ', ' SH-1001', 'SH -1001',
    'SH-1e3', 'SH-1.0', 'SH-+1', 1001, null, undefined, {}, [], true,
  ]
  for (const v of invalidos) {
    assert.equal(esCodigoCanonico(v), false, `aceptó ${JSON.stringify(v)}`)
  }
})

test('C6 · prefijo y secuencia solo salen del código', () => {
  assert.equal(prefijoDeCodigo('SH-1058'), 'SH')
  assert.equal(prefijoDeCodigo('DEP-247'), 'DEP')
  assert.equal(prefijoDeCodigo('sh-1058'), null)
  assert.equal(secuenciaDeCodigo('DEP-247'), 247)
  assert.equal(secuenciaDeCodigo('SH-001'), null)
  assert.equal(secuenciaDeCodigo(1058), null)
})

// ── Búsqueda tolerante ───────────────────────────────────────────────────────

test('C7 · las cuatro formas que el bloque pide aceptar', () => {
  for (const q of ['SH-1058', 'sh-1058', 'SH 1058', 'sh1058', '  SH-1058  ']) {
    assert.deepEqual(parseBusquedaCodigo(q), { prefijo: 'SH', secuencia: 1058 }, `falló con "${q}"`)
  }
  assert.deepEqual(parseBusquedaCodigo('1058'), { prefijo: null, secuencia: 1058 })
  assert.deepEqual(parseBusquedaCodigo('dep 247'), { prefijo: 'DEP', secuencia: 247 })
})

test('C8 · lo que NO es una consulta de código', () => {
  for (const q of ['', '   ', 'mariposita', 'SH-', 'SH', '0', '007', '1058a', 'a1058', '12.5', '-5', 'SH-1058-2']) {
    assert.equal(parseBusquedaCodigo(q), null, `interpretó "${q}" como código`)
  }
})

test('C9 · el número suelto compara por igualdad, nunca por subcadena', () => {
  // Es lo que impide que buscar "80" arrastre SH-1080, SH-8000 y compañía.
  assert.equal(coincideCodigo('SH-80', '80'), true)
  assert.equal(coincideCodigo('SH-1080', '80'), false)
  assert.equal(coincideCodigo('SH-8000', '80'), false)
  assert.equal(coincideCodigo('DEP-80', '80'), true)
})

test('C10 · con prefijo escrito, el prefijo también tiene que coincidir', () => {
  assert.equal(coincideCodigo('SH-1058', 'SH-1058'), true)
  assert.equal(coincideCodigo('SH-1058', 'DEP-1058'), false, 'un depósito devolvió una orden')
  assert.equal(coincideCodigo('DEP-1058', 'sh 1058'), false)
  assert.equal(coincideCodigo('DEP-1058', '1058'), true, 'sin prefijo debe valer cualquiera')
})

test('C11 · un teléfono o un monto no encuentran una orden por casualidad', () => {
  // Ocho dígitos: ninguna secuencia real va a coincidir. Y un monto suelto
  // solo coincidiría con la secuencia exacta, que es lo pedido.
  assert.equal(coincideCodigo('SH-1058', '88776655'), false)
  assert.equal(coincideCodigo('SH-1058', '110'), false)
  assert.equal(coincideCodigo('SH-110', '110'), true)
})

test('C12 · numeroOrden del comercio NUNCA es el código', () => {
  // `numeroOrden` es texto libre que teclea el comercio ("#ORD-001", el número
  // de pedido de WhatsApp). No entra por ninguna vía: el código solo se lee de
  // `codigo`, y ninguna de estas formas es canónica.
  for (const v of ['#ORD-001', 'ORD-001', 'PEDIDO 55', '1058', 'SH1058', 'sh-1058']) {
    assert.equal(esCodigoCanonico(v), false, `"${v}" pasó como código canónico`)
  }
  // Y aunque el comercio escriba literalmente "SH-1058" en su numeroOrden, eso
  // vive en otro campo: coincideCodigo solo mira el que se le pasa.
  assert.equal(coincideCodigo(undefined, 'SH-1058'), false)
  assert.equal(coincideCodigo(null, '1058'), false)
})

// ── Display y fallback ───────────────────────────────────────────────────────

test('C13 · sin código se cae al ID corto, nunca a "—"', () => {
  assert.equal(mostrarCodigo('SH-1058', 'WXfAQe3UkF2XVERZLpNX'), 'SH-1058')
  assert.equal(mostrarCodigo(undefined, 'WXfAQe3UkF2XVERZLpNX'), 'WXfAQe3U')
  assert.equal(mostrarCodigo(null, 'WXfAQe3UkF2XVERZLpNX', 6), 'WXfAQe')
  // Un código corrupto tampoco se muestra: se cae al ID, que sí es verdad.
  assert.equal(mostrarCodigo('sh-1058', 'WXfAQe3UkF2XVERZLpNX'), 'WXfAQe3U')
  assert.equal(mostrarCodigo({}, 'WXfAQe3UkF2XVERZLpNX'), 'WXfAQe3U')
})

test('C14 · sin código y sin ID, y solo entonces, un texto explícito', () => {
  assert.equal(mostrarCodigo(undefined, undefined), CODIGO_AUSENTE)
  assert.equal(mostrarCodigo(undefined, ''), CODIGO_AUSENTE)
  assert.notEqual(CODIGO_AUSENTE, '—')
})

test('C15 · esFallbackTecnico distingue las dos situaciones', () => {
  assert.equal(esFallbackTecnico('SH-1058'), false)
  assert.equal(esFallbackTecnico(undefined), true)
  assert.equal(esFallbackTecnico('SH-001058'), true)
})

// ── Invariante ───────────────────────────────────────────────────────────────

test('INV · todo lo que formatearCodigo produce es canónico y se relee igual', () => {
  for (const p of [PREFIJO_ORDEN, PREFIJO_DEPOSITO]) {
    for (const n of [1, 9, 10, 247, 1000, 1001, 1058, 999999, 1000000, 12345678]) {
      const c = formatearCodigo(p, n)
      assert.equal(esCodigoCanonico(c), true, `${c} no es canónico`)
      assert.equal(prefijoDeCodigo(c), p)
      assert.equal(secuenciaDeCodigo(c), n)
      assert.equal(coincideCodigo(c, c), true)
      assert.equal(coincideCodigo(c, String(n)), true)
      assert.equal(mostrarCodigo(c, 'idtecnico'), c)
    }
  }
})
