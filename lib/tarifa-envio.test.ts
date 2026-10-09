// PRECIO-CONFIRMADO-ANTES-DE-OPERAR-1 — la tarifa es UNA fórmula: la del cliente (preview) y la del servidor (autoridad) son el mismo archivo.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { tarifa, TRAMOS_TARIFA } from './tarifa-envio'

const norm = (p: string) => readFileSync(join(process.cwd(), p), 'utf8').replace(/\r\n/g, '\n')

test('TAR1 · los tramos del tarifario (valores de producción, intactos)', () => {
  const esperado: Array<[number, number]> = [
    [0, 70], [1.999, 70], [2, 80], [3.99, 80], [4, 90], [5.999, 90], [6, 110], [7.999, 110], [8, 120], [9.999, 120], [10, 130], [11.999, 130],
    [12, 150], [13.859, 150], [13.999, 150], [14, 160], [15.999, 160], [16, 180], [18, 190], [20, 210], [21.759, 210], [22, 220], [24, 240],
    [26, 250], [28, 270], [30, 280], [32, 300], [34, 310], [36, 330], [38, 340], [40, 360], [42, 370], [44, 390], [46, 400], [48, 420], [50, 430], [52, 440], [53.999, 440],
  ]
  for (const [km, precio] of esperado) assert.equal(tarifa(km), precio, `${km} km`)
  assert.equal(TRAMOS_TARIFA.length, 27)
})

test('TAR2 · fuera del tarifario (54 km o más) y entradas que no son distancia → -1', () => {
  for (const km of [54, 54.001, 80, 1e9, Infinity, NaN]) assert.equal(tarifa(km), -1, String(km))
})

test('TAR3 · PARIDAD: lib/tarifa-envio.ts y functions/src/tarifa-envio.ts son el mismo archivo (cambiar la tarifa es cambiar los dos)', () => {
  assert.equal(norm('functions/src/tarifa-envio.ts'), norm('lib/tarifa-envio.ts'))
})

test('TAR4 · PARIDAD de calcularDeposito: la copia del cliente y la del servidor son el mismo archivo', () => {
  assert.equal(norm('functions/src/calculo-deposito.ts'), norm('lib/calculo-deposito.ts'))
})

test('TAR5 · ninguna pantalla vuelve a copiar la fórmula: Solicitar, Ingresar orden y la calculadora importan lib/tarifa-envio', () => {
  for (const p of ['app/panel/comercio/solicitar/_page.tsx', 'app/panel/gestor/ingresar-orden/page.tsx', 'app/Components/CalculadoraPrecio.tsx']) {
    const src = norm(p)
    assert.ok(/from '@\/lib\/tarifa-envio'/.test(src), `${p} importa la tarifa compartida`)
    assert.ok(!/function tarifa\(/.test(src), `${p} ya no define su propia tarifa`)
  }
})
