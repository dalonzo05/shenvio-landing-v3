// B2-PAGO-MEDIO — suite del lado UI.
//
// Prueba SOLO lo que la interfaz del motorizado ejecuta de verdad: qué
// opciones se ofrecen, qué viaja en el payload y qué cuenta como respuesta.
//
// Deliberadamente NO prueba la resolución de `formaPago`, el consumo one-shot,
// el borrado del temporal, el guard ni la validación del payload: eso vive en
// `functions/src/medio-pago.ts` y lo ejecuta el servidor. Duplicarlo acá daría
// tests verdes sobre una réplica que producción no corre. Esa lógica queda
// cubierta por el `tsc` de Functions, la inspección focal y el E2E en staging
// tras el deploy — deuda PAGO-MEDIO-FUNCTIONS-SIN-TESTS.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  MEDIOS_PAGO,
  MEDIO_NO_SABE,
  OPCIONES_MEDIO,
  medioParaPayload,
  medioRespondido,
} from './medio-pago'

test('MP-UI1 · el enum de la UI tiene exactamente dos valores', () => {
  assert.deepEqual([...MEDIOS_PAGO], ['efectivo', 'transferencia'])
})

test('MP-UI2 · el selector ofrece tres opciones, en orden y sin default', () => {
  assert.deepEqual(OPCIONES_MEDIO.map((o) => o.value), ['efectivo', 'transferencia', MEDIO_NO_SABE])
  assert.deepEqual(OPCIONES_MEDIO.map((o) => o.label), ['Efectivo', 'Transferencia', 'No estoy seguro'])
  // Ninguna opción se declara preseleccionada: el estado inicial es '' y lo
  // fija quien abre el modal.
  assert.equal(OPCIONES_MEDIO.some((o) => 'default' in o), false)
})

test('MP-UI3 · efectivo y transferencia viajan en el payload', () => {
  assert.equal(medioParaPayload('efectivo'), 'efectivo')
  assert.equal(medioParaPayload('transferencia'), 'transferencia')
})

test('MP-UI4 · "No estoy seguro" no manda medio', () => {
  assert.equal(medioParaPayload(MEDIO_NO_SABE), undefined)
})

test('MP-UI5 · sin responder tampoco manda medio', () => {
  assert.equal(medioParaPayload(''), undefined)
  assert.equal(medioParaPayload(undefined), undefined)
  assert.equal(medioParaPayload(null), undefined)
})

test('MP-UI6 · la UI no normaliza: casing y variantes no viajan', () => {
  // Si algún día el selector mandara otra cosa, el servidor la rechazaría.
  // Acá se corta antes: la clave ni se incluye.
  for (const v of ['Efectivo', 'EFECTIVO', ' efectivo', 'transferencia_deposito', 'tarjeta', 0, true, {}]) {
    assert.equal(medioParaPayload(v), undefined, `dejó pasar ${JSON.stringify(v)}`)
  }
})

test('MP-UI7 · "No estoy seguro" cuenta como respuesta; el vacío no', () => {
  assert.equal(medioRespondido(MEDIO_NO_SABE), true)
  assert.equal(medioRespondido('efectivo'), true)
  assert.equal(medioRespondido('transferencia'), true)
  assert.equal(medioRespondido(''), false)
  assert.equal(medioRespondido(undefined), false)
})

test('MP-UI8 · responder "no sé" y no responder producen el mismo payload', () => {
  // Se distinguen en pantalla, no en el documento: las dos dejan el medio
  // ausente, y nadie lo completa después.
  assert.equal(medioParaPayload(MEDIO_NO_SABE), medioParaPayload(''))
})
