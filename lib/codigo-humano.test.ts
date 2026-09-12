// IDENTIDAD-HUMANA-1B — suite focal de lib/codigo-humano.ts
//
// Los ejemplos son los literales fijados en el bloque de producto: SH-0001,
// DEP-0001, SH-9999, SH-10000. La suite de Functions comprueba su lado contra
// ESTOS MISMOS literales, que es lo que ata el contrato de frontera sin que
// ninguno de los dos importe al otro.
//
// El padding es el cambio de 1B: SH-1 se leía como un identificador truncado y
// SH-1001 sugería mil órdenes previas. Cuatro dígitos desde el primero.

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

test('C1 · padding a cuatro dígitos', () => {
  assert.equal(formatearCodigo(PREFIJO_ORDEN, 1), 'SH-0001')
  assert.equal(formatearCodigo(PREFIJO_ORDEN, 15), 'SH-0015')
  assert.equal(formatearCodigo(PREFIJO_DEPOSITO, 1), 'DEP-0001')
  assert.equal(formatearCodigo(PREFIJO_DEPOSITO, 247), 'DEP-0247')
  assert.equal(formatearCodigo(PREFIJO_ORDEN, 999), 'SH-0999')
  assert.equal(formatearCodigo(PREFIJO_ORDEN, 1000), 'SH-1000')
  assert.equal(formatearCodigo(PREFIJO_ORDEN, 9999), 'SH-9999')
})

test('C1b · a partir de 10.000 el número crece sin relleno artificial', () => {
  assert.equal(formatearCodigo(PREFIJO_ORDEN, 10000), 'SH-10000')
  assert.equal(formatearCodigo(PREFIJO_ORDEN, 12345), 'SH-12345')
  assert.equal(formatearCodigo(PREFIJO_DEPOSITO, 10000), 'DEP-10000')
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

test('C5 · canónico estricto: padding exacto, mayúsculas y guion', () => {
  for (const v of ['SH-0001', 'SH-0015', 'SH-0999', 'SH-1000', 'SH-9999', 'SH-10000', 'DEP-0001', 'DEP-999999999']) {
    assert.equal(esCodigoCanonico(v), true, `rechazó ${v}`)
  }
  const invalidos: unknown[] = [
    'SH-1', 'SH-01', 'SH-001',   // por debajo del ancho mínimo
    'SH-00001', 'SH-010000',     // ceros por encima del ancho mínimo
    'SH-0000',                   // no existe la secuencia cero
    'sh-0001',                   // minúsculas: valen para buscar, nunca para persistir
    'SH0001',                    // sin guion
    'ORD-0001',                  // prefijo ajeno
    'SH-', '-0001', 'SH-0001 ', ' SH-0001', 'SH -0001',
    'SH-1e3', 'SH-1.0', 'SH-+1', 1001, null, undefined, {}, [], true,
  ]
  for (const v of invalidos) {
    assert.equal(esCodigoCanonico(v), false, `aceptó ${JSON.stringify(v)}`)
  }
})

test('C6 · prefijo y secuencia solo salen del código', () => {
  assert.equal(prefijoDeCodigo('SH-1058'), 'SH')
  assert.equal(prefijoDeCodigo('DEP-0247'), 'DEP')
  assert.equal(prefijoDeCodigo('sh-0001'), null)
  // Los ceros del padding no forman parte del número.
  assert.equal(secuenciaDeCodigo('DEP-0247'), 247)
  assert.equal(secuenciaDeCodigo('SH-0001'), 1)
  assert.equal(secuenciaDeCodigo('SH-0015'), 15)
  assert.equal(secuenciaDeCodigo('SH-10000'), 10000)
  assert.equal(secuenciaDeCodigo('SH-001'), null)
  assert.equal(secuenciaDeCodigo(1058), null)
})

// ── Búsqueda tolerante ───────────────────────────────────────────────────────

test('C7 · todas las formas de teclear SH-0001', () => {
  for (const q of ['SH-0001', 'sh-0001', 'SH 0001', 'sh0001', '  SH-0001  ']) {
    assert.deepEqual(parseBusquedaCodigo(q), { prefijo: 'SH', secuencia: 1 }, `falló con "${q}"`)
  }
  // Con y sin los ceros del padding: son la misma orden.
  assert.deepEqual(parseBusquedaCodigo('0001'), { prefijo: null, secuencia: 1 })
  assert.deepEqual(parseBusquedaCodigo('1'), { prefijo: null, secuencia: 1 })
  assert.deepEqual(parseBusquedaCodigo('0015'), { prefijo: null, secuencia: 15 })
  assert.deepEqual(parseBusquedaCodigo('15'), { prefijo: null, secuencia: 15 })
  assert.deepEqual(parseBusquedaCodigo('dep 0247'), { prefijo: 'DEP', secuencia: 247 })
  assert.deepEqual(parseBusquedaCodigo('SH-10000'), { prefijo: 'SH', secuencia: 10000 })
})

test('C8 · lo que NO es una consulta de código', () => {
  // Con padding, los ceros a la izquierda son la forma NORMAL de escribir
  // el código, así que '007' pasa a ser una consulta válida. '0' y '0000'
  // no: no existe la secuencia cero.
  for (const q of ['', '   ', 'mariposita', 'SH-', 'SH', '0', '0000', '1058a', 'a1058', '12.5', '-5', 'SH-1058-2']) {
    assert.equal(parseBusquedaCodigo(q), null, `interpretó "${q}" como código`)
  }
})

test('C9 · el número suelto compara por igualdad, nunca por subcadena', () => {
  // Es lo que impide que buscar "1" arrastre SH-0010, SH-0100 y SH-1001.
  assert.equal(coincideCodigo('SH-0001', '1'), true)
  assert.equal(coincideCodigo('SH-0001', '0001'), true)
  assert.equal(coincideCodigo('SH-0010', '1'), false)
  assert.equal(coincideCodigo('SH-0100', '1'), false)
  assert.equal(coincideCodigo('SH-1001', '1'), false)
  assert.equal(coincideCodigo('SH-0080', '80'), true)
  assert.equal(coincideCodigo('SH-1080', '80'), false)
  assert.equal(coincideCodigo('DEP-0080', '80'), true)
})

test('C10 · con prefijo escrito, el prefijo también tiene que coincidir', () => {
  assert.equal(coincideCodigo('SH-0001', 'SH-0001'), true)
  assert.equal(coincideCodigo('SH-0001', 'DEP-0001'), false, 'un depósito devolvió una orden')
  assert.equal(coincideCodigo('DEP-0001', 'sh 0001'), false)
  assert.equal(coincideCodigo('DEP-0001', '0001'), true, 'sin prefijo debe valer cualquiera')
  // Escrito sin el padding también encuentra: la tolerancia es del buscador,
  // no del dato persistido.
  assert.equal(coincideCodigo('SH-0001', 'SH-1'), true)
})

test('C11 · un teléfono o un monto no encuentran una orden por casualidad', () => {
  // Ocho dígitos: ninguna secuencia real va a coincidir. Y un monto suelto
  // solo coincidiría con la secuencia exacta, que es lo pedido.
  assert.equal(coincideCodigo('SH-1058', '88776655'), false)
  assert.equal(coincideCodigo('SH-1058', '110'), false)
  assert.equal(coincideCodigo('SH-0110', '110'), true)
})

test('C12 · numeroOrden del comercio NUNCA es el código', () => {
  // `numeroOrden` es texto libre que teclea el comercio ("#ORD-001", el número
  // de pedido de WhatsApp). No entra por ninguna vía: el código solo se lee de
  // `codigo`, y ninguna de estas formas es canónica.
  for (const v of ['#ORD-001', 'ORD-0001', 'PEDIDO 55', '0001', 'SH0001', 'sh-0001']) {
    assert.equal(esCodigoCanonico(v), false, `"${v}" pasó como código canónico`)
  }
  // Y aunque el comercio escriba literalmente "SH-0001" en su numeroOrden, eso
  // vive en otro campo: coincideCodigo solo mira el que se le pasa.
  assert.equal(coincideCodigo(undefined, 'SH-0001'), false)
  assert.equal(coincideCodigo(null, '0001'), false)
})

// ── Display y fallback ───────────────────────────────────────────────────────

test('C13 · sin código se cae al ID corto, nunca a "—"', () => {
  assert.equal(mostrarCodigo('SH-0001', 'WXfAQe3UkF2XVERZLpNX'), 'SH-0001')
  assert.equal(mostrarCodigo(undefined, 'WXfAQe3UkF2XVERZLpNX'), 'WXfAQe3U')
  assert.equal(mostrarCodigo(null, 'WXfAQe3UkF2XVERZLpNX', 6), 'WXfAQe')
  // Un código sin el padding correcto tampoco se muestra: se cae al ID, que
  // sí es verdad. Vale igual para 'sh-0001' que para 'SH-1'.
  assert.equal(mostrarCodigo('sh-0001', 'WXfAQe3UkF2XVERZLpNX'), 'WXfAQe3U')
  assert.equal(mostrarCodigo('SH-1', 'WXfAQe3UkF2XVERZLpNX'), 'WXfAQe3U')
  assert.equal(mostrarCodigo({}, 'WXfAQe3UkF2XVERZLpNX'), 'WXfAQe3U')
})

test('C14 · sin código y sin ID, y solo entonces, un texto explícito', () => {
  assert.equal(mostrarCodigo(undefined, undefined), CODIGO_AUSENTE)
  assert.equal(mostrarCodigo(undefined, ''), CODIGO_AUSENTE)
  assert.notEqual(CODIGO_AUSENTE, '—')
})

test('C15 · esFallbackTecnico distingue las dos situaciones', () => {
  assert.equal(esFallbackTecnico('SH-0001'), false)
  assert.equal(esFallbackTecnico(undefined), true)
  assert.equal(esFallbackTecnico('SH-1'), true)
  assert.equal(esFallbackTecnico('SH-001058'), true)
})

// ── Invariante ───────────────────────────────────────────────────────────────

test('INV · todo lo que formatearCodigo produce es canónico y se relee igual', () => {
  for (const p of [PREFIJO_ORDEN, PREFIJO_DEPOSITO]) {
    for (const n of [1, 9, 10, 15, 247, 999, 1000, 1001, 9999, 10000, 999999, 1000000, 12345678]) {
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
