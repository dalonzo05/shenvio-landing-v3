// IDENTIDAD-HUMANA-1 — suite focal de lib/ordinal-comercio.ts
//
// Lo que fija: qué cuenta como viaje y en qué orden. La regla no es una
// preferencia — sale de lib/estados-solicitud.ts, donde 'entregado' es el
// único cierre definitivo y 'rechazada'/'cancelada' son reactivables.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  ordinalesDeComercio,
  esViajeRealizado,
  etiquetaOrdinal,
  type EntradaOrdinalComercio,
} from './ordinal-comercio'

const ts = (ms: number) => ({ toMillis: () => ms })

const orden = (id: string, estado: string, entregadoMs?: number, createdMs?: number): EntradaOrdinalComercio => ({
  id,
  estado,
  entregadoAt: entregadoMs === undefined ? null : ts(entregadoMs),
  createdAt: createdMs === undefined ? null : ts(createdMs),
})

test('O1 · solo cuentan las entregadas', () => {
  assert.equal(esViajeRealizado(orden('a', 'entregado', 1)), true)
  for (const e of ['pendiente_confirmacion', 'confirmada', 'asignada', 'en_camino_retiro', 'retirado', 'en_camino_entrega', 'programada']) {
    assert.equal(esViajeRealizado(orden('a', e, 1)), false, `contó ${e} como viaje`)
  }
})

test('O2 · rechazada y cancelada NO son viajes', () => {
  // Son reactivables: si contaran, reactivar una orden movería el ordinal de
  // todas las posteriores.
  assert.equal(esViajeRealizado(orden('a', 'rechazada', 1)), false)
  assert.equal(esViajeRealizado(orden('a', 'cancelada', 1)), false)
})

test('O3 · el primero entregado es #1 y se ordena por entregadoAt', () => {
  const m = ordinalesDeComercio([
    orden('c', 'entregado', 300),
    orden('a', 'entregado', 100),
    orden('b', 'entregado', 200),
  ])
  assert.deepEqual(m, { a: 1, b: 2, c: 3 })
})

test('O4 · el orden es por entrega, no por creación', () => {
  // Una orden creada antes pero entregada después va después.
  const m = ordinalesDeComercio([
    orden('vieja', 'entregado', 900, 100),
    orden('nueva', 'entregado', 500, 800),
  ])
  assert.deepEqual(m, { nueva: 1, vieja: 2 })
})

test('O5 · las no entregadas no reciben ordinal ni desplazan a las demás', () => {
  const m = ordinalesDeComercio([
    orden('a', 'entregado', 100),
    orden('x', 'cancelada', 150),
    orden('y', 'en_camino_entrega', 160),
    orden('b', 'entregado', 200),
    orden('z', 'rechazada', 250),
  ])
  // deepEqual ya demuestra que 'x' e 'y' no están: un ordinal de más
  // rompería la igualdad.
  assert.deepEqual(m, { a: 1, b: 2 })
})

test('O6 · entregada sin entregadoAt cae a createdAt', () => {
  // Caso real: yomoyxzBvljBwiEkwhaI está entregada y no tiene entregadoAt.
  const m = ordinalesDeComercio([
    orden('conFecha', 'entregado', 500),
    { id: 'sinEntregadoAt', estado: 'entregado', entregadoAt: null, createdAt: ts(100) },
  ])
  assert.deepEqual(m, { sinEntregadoAt: 1, conFecha: 2 })
})

test('O7 · sin ninguna fecha va al final, en orden estable', () => {
  const entrada = [
    { id: 'zz', estado: 'entregado' },
    { id: 'aa', estado: 'entregado' },
    orden('conFecha', 'entregado', 100),
  ]
  const m1 = ordinalesDeComercio(entrada)
  const m2 = ordinalesDeComercio([...entrada].reverse())
  assert.deepEqual(m1, { conFecha: 1, aa: 2, zz: 3 })
  assert.deepEqual(m1, m2, 'el resultado dependió del orden de entrada')
})

test('O8 · empate exacto de milisegundos se desempata de forma estable', () => {
  const m1 = ordinalesDeComercio([orden('b', 'entregado', 100), orden('a', 'entregado', 100)])
  const m2 = ordinalesDeComercio([orden('a', 'entregado', 100), orden('b', 'entregado', 100)])
  assert.deepEqual(m1, { a: 1, b: 2 })
  assert.deepEqual(m1, m2)
})

test('O9 · entradas corruptas no rompen ni cuentan', () => {
  const m = ordinalesDeComercio([
    orden('a', 'entregado', 100),
    { id: '', estado: 'entregado', entregadoAt: ts(50) },
    { id: 'sinEstado' } as EntradaOrdinalComercio,
    { id: 'fechaRota', estado: 'entregado', entregadoAt: { toMillis: () => NaN } as never, createdAt: null },
  ])
  assert.equal(m['a'], 1)
  assert.equal(m[''], undefined)
  assert.equal(m['sinEstado'], undefined)
  // La de fecha rota sí es un viaje: se cuenta, al final, sin fecha inventada.
  assert.equal(m['fechaRota'], 2)
  assert.equal(ordinalesDeComercio([]).a, undefined)
  assert.deepEqual(ordinalesDeComercio(null as never), {})
})

test('O10 · la etiqueta solo existe cuando hay ordinal', () => {
  assert.equal(etiquetaOrdinal(23), 'Viaje #23')
  assert.equal(etiquetaOrdinal(1), 'Viaje #1')
  for (const v of [undefined, null, 0, -1, 1.5, NaN]) {
    assert.equal(etiquetaOrdinal(v as never), null, `inventó etiqueta para ${v}`)
  }
})

test('INV · los ordinales son 1..N sin huecos ni repetidos', () => {
  const estados = ['entregado', 'cancelada', 'rechazada', 'asignada', 'entregado', 'entregado']
  const entrada = estados.map((e, i) => orden('id' + i, e, (i * 7) % 11))
  const m = ordinalesDeComercio(entrada)
  const valores = Object.values(m).sort((a, b) => a - b)
  assert.equal(valores.length, 3)
  assert.deepEqual(valores, [1, 2, 3])
  assert.equal(new Set(valores).size, valores.length)
})
