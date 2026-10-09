// PRECIO-CONFIRMADO-ANTES-DE-OPERAR-1 — la lógica de la base de comisión es UNA: la del navegador (para saber si pide la base manual) y la del servidor
// (que decide) son el mismo archivo. La cobertura completa del contrato está en functions/test/precio-orden.test.ts.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { clasificarBaseComision, resolverBaseConfirmacion, baseComisionAprobada } from './precio-orden'

const norm = (p: string) => readFileSync(join(process.cwd(), p), 'utf8').replace(/\r\n/g, '\n')

test('PO-C1 · PARIDAD: lib/precio-orden.ts y functions/src/precio-orden.ts son el mismo archivo', () => {
  assert.equal(norm('functions/src/precio-orden.ts'), norm('lib/precio-orden.ts'))
})

test('PO-C2 · el cliente clasifica igual que el servidor: automática / manual / rechazo', () => {
  assert.deepEqual(clasificarBaseComision({ cotizacion: { distanciaKm: 21.759 }, precioDesglose: { deliveryBase: 210 } }), { tipo: 'automatica', base: 210 })
  assert.deepEqual(clasificarBaseComision({ cotizacion: { distanciaKm: null, fuentePrecio: 'viaje_anterior' } }), { tipo: 'manual' })
  assert.deepEqual(clasificarBaseComision({ cotizacion: { distanciaKm: 80 } }), { tipo: 'manual' })
  assert.deepEqual(clasificarBaseComision({ cotizacion: { distanciaKm: 13.859 }, precioDesglose: { deliveryBase: 5000 } }), { tipo: 'rechazo', motivo: 'cotizacion_inconsistente' })
})

test('PO-C3 · la invariante 0 < base <= precio final y el caso de recargo 210/260', () => {
  assert.deepEqual(resolverBaseConfirmacion({ cotizacion: { distanciaKm: 49.5 } }, 150, undefined), { ok: false, motivo: 'precio_incoherente' })
  assert.deepEqual(resolverBaseConfirmacion({ cotizacion: { distanciaKm: 21.759 } }, 260, undefined), { ok: true, base: 210, origen: 'tarifa_distancia' })
  assert.deepEqual(resolverBaseConfirmacion({}, 260, 210), { ok: true, base: 210, origen: 'manual_gestor' })
  assert.deepEqual(baseComisionAprobada({ confirmacion: { precioFinalCordobas: 150, comisionBaseCordobas: 420, comisionBaseOrigen: 'tarifa_distancia' } }), { ok: false, motivo: 'precio_incoherente' })
})
