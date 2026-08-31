// B2-PAGO-MEDIO — suite focal del contrato del medio de pago.
//
// Prueba `lib/medio-pago.ts`, la copia de la app. `functions/src/medio-pago.ts`
// es su espejo deliberado y NO se importa desde acá: hacerlo arrastraría
// `functions/src` al compilado raíz y cambiaría el layout de `.test-build`.
// Las dos copias se mantienen alineadas a mano (PAGO-MEDIO-ENUM-ESPEJADO); la
// de Functions es la frontera autoritativa de seguridad y se verifica con su
// propio `tsc` y con el E2E.
//
// Lo que estos tests defienden no es el layout: es que el medio NUNCA se
// deduzca de algo que no lo demuestra.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  MEDIOS_PAGO,
  esMedioPago,
  resolverFormaPago,
  debeBorrarTemporalPorRuta,
  evaluarMedioDePayload,
  permiteCierreSinConfirmaciones,
  MEDIO_NO_SABE,
  OPCIONES_MEDIO,
  medioParaPayload,
  medioRespondido,
} from './medio-pago'

// ─── Enum cerrado ─────────────────────────────────────────────────────────────

test('MP0 · el enum tiene exactamente dos valores', () => {
  assert.deepEqual([...MEDIOS_PAGO], ['efectivo', 'transferencia'])
})

test('MP17 · un medio inválido no se acepta', () => {
  for (const v of ['tarjeta', 'cheque', 'deposito', 'x', ' ', 0, true, {}, [], null, undefined]) {
    assert.equal(esMedioPago(v), false, `aceptó ${JSON.stringify(v)}`)
  }
})

test('MP18 · el casing distinto se rechaza', () => {
  for (const v of ['Efectivo', 'EFECTIVO', 'Transferencia', 'TRANSFERENCIA', ' efectivo', 'efectivo ']) {
    assert.equal(esMedioPago(v), false, `aceptó ${v}`)
  }
})

test('MP19 · transferencia_deposito se rechaza', () => {
  // Es el vocabulario de metodoPagoReal, el campo legacy. No es un medio.
  assert.equal(esMedioPago('transferencia_deposito'), false)
  assert.equal(evaluarMedioDePayload({ medio: 'transferencia_deposito', esProducto: false }), 'invalido')
})

// ─── Payload ──────────────────────────────────────────────────────────────────

test('MP-P1 · medio válido en delivery se acepta', () => {
  assert.equal(evaluarMedioDePayload({ medio: 'efectivo', esProducto: false }), 'valido')
  assert.equal(evaluarMedioDePayload({ medio: 'transferencia', esProducto: false }), 'valido')
})

test('MP-P2 · medio ausente es válido: el campo es opcional', () => {
  assert.equal(evaluarMedioDePayload({ medio: undefined, esProducto: false }), 'ausente')
  // El SDK serializa undefined como null: ambos son ausencia legítima.
  assert.equal(evaluarMedioDePayload({ medio: null, esProducto: false }), 'ausente')
})

test('MP20 · medio dentro de producto se rechaza explícitamente', () => {
  for (const v of ['efectivo', 'transferencia', 'lo_que_sea']) {
    assert.equal(
      evaluarMedioDePayload({ medio: v, esProducto: true }),
      'no_permitido_en_producto',
      'no debe ignorarse en silencio',
    )
  }
  // Sin medio, producto sigue siendo un payload legítimo.
  assert.equal(evaluarMedioDePayload({ medio: undefined, esProducto: true }), 'ausente')
})

// ─── Resolución del formaPago ─────────────────────────────────────────────────

test('MP1 · entrega directa con efectivo', () => {
  const r = resolverFormaPago({ medioDeEstaLlamada: 'efectivo' })
  assert.equal(r.formaPago, 'efectivo')
  assert.equal(r.consumeTemporal, false)
})

test('MP2 · entrega directa con transferencia', () => {
  const r = resolverFormaPago({ medioDeEstaLlamada: 'transferencia' })
  assert.equal(r.formaPago, 'transferencia')
})

test('MP3 · entrega directa con "No estoy seguro" no escribe el campo', () => {
  const r = resolverFormaPago({ medioDeEstaLlamada: undefined })
  assert.equal(r.formaPago, null)
  assert.equal(r.consumeTemporal, false)
})

test('MP7 · la entrega posterior consume el temporal efectivo', () => {
  const r = resolverFormaPago({ medioTemporal: 'efectivo' })
  assert.equal(r.formaPago, 'efectivo')
  assert.equal(r.consumeTemporal, true)
})

test('MP8 · la entrega posterior consume el temporal transferencia', () => {
  const r = resolverFormaPago({ medioTemporal: 'transferencia' })
  assert.equal(r.formaPago, 'transferencia')
  assert.equal(r.consumeTemporal, true)
})

test('MP11 · un formaPago válido existente se conserva', () => {
  const r = resolverFormaPago({ formaPagoExistente: 'transferencia' })
  assert.equal(r.formaPago, 'transferencia')
})

test('MP12 · un medio contradictorio no pisa el valor existente', () => {
  const r = resolverFormaPago({
    formaPagoExistente: 'transferencia',
    medioDeEstaLlamada: 'efectivo',
    medioTemporal: 'efectivo',
  })
  assert.equal(r.formaPago, 'transferencia', 'lo ya persistido manda')
  // Y no se declara consumo: el temporal no fue la fuente.
  assert.equal(r.consumeTemporal, false)
})

test('MP12b · un formaPago existente inválido no bloquea la resolución', () => {
  const r = resolverFormaPago({ formaPagoExistente: 'Efectivo', medioDeEstaLlamada: 'efectivo' })
  assert.equal(r.formaPago, 'efectivo')
})

test('MP-R1 · esta llamada tiene prioridad sobre el temporal', () => {
  const r = resolverFormaPago({ medioDeEstaLlamada: 'transferencia', medioTemporal: 'efectivo' })
  assert.equal(r.formaPago, 'transferencia')
  assert.equal(r.consumeTemporal, false)
})

test('MP-R2 · un temporal inválido no produce formaPago', () => {
  const r = resolverFormaPago({ medioTemporal: 'EFECTIVO' })
  assert.equal(r.formaPago, null)
  assert.equal(r.consumeTemporal, false)
})

// ─── Prohibición de inferencia ────────────────────────────────────────────────

test('MP13 · recibio:true sin medio NO implica efectivo', () => {
  // El helper ni siquiera acepta `recibio` como entrada: no hay forma de
  // colarlo. Se comprueba que sin medio no sale nada.
  const r = resolverFormaPago({})
  assert.equal(r.formaPago, null)
})

test('MP14 · quienPaga "entrega" no implica efectivo', () => {
  const r = resolverFormaPago({ medioDeEstaLlamada: 'entrega' })
  assert.equal(r.formaPago, null, '"entrega" es un quienPaga, no un medio')
})

test('MP15 · quienPaga "recoleccion" no implica efectivo', () => {
  assert.equal(resolverFormaPago({ medioDeEstaLlamada: 'recoleccion' }).formaPago, null)
  assert.equal(resolverFormaPago({ medioTemporal: 'recoleccion' }).formaPago, null)
})

test('MP16 · quienPaga "transferencia" no basta como medio', () => {
  // Ojo: la cadena 'transferencia' SÍ es un medio válido. Lo que este test
  // fija es que el valor tiene que llegar por el canal del medio —la respuesta
  // del motorizado— y no copiándolo desde quienPaga. El helper no recibe
  // quienPaga por ninguna vía, así que la vía no existe.
  assert.deepEqual(Object.keys(resolverFormaPago({})).sort(), ['consumeTemporal', 'formaPago'])
  assert.equal(resolverFormaPago({}).formaPago, null)
})

test('MP24 · "No estoy seguro" jamás se completa automáticamente', () => {
  // Ni con receptor, ni con dinero depositable, ni con el paso del tiempo:
  // sin medio en ninguna de las tres fuentes, el resultado es siempre null.
  for (const entrada of [{}, { medioDeEstaLlamada: undefined }, { medioTemporal: undefined },
    { formaPagoExistente: undefined, medioDeEstaLlamada: null, medioTemporal: null }]) {
    assert.equal(resolverFormaPago(entrada).formaPago, null)
  }
})

test('MP25 · tras la reversión no queda temporal que rehidrate', () => {
  // La reversión borra formaPago; el cierre ya había consumido el temporal.
  // Ese estado —las tres fuentes vacías— no puede regenerar nada.
  const trasReversion = resolverFormaPago({
    formaPagoExistente: undefined,
    medioDeEstaLlamada: undefined,
    medioTemporal: undefined,
  })
  assert.equal(trasReversion.formaPago, null)
  assert.equal(trasReversion.consumeTemporal, false)
})

// ─── Consumo one-shot ─────────────────────────────────────────────────────────

test('MP9 · con el mapa reescrito NO se añade el delete por dot-path', () => {
  // Firestore rechaza un update con un campo y su ancestro a la vez.
  assert.equal(
    debeBorrarTemporalPorRuta({ reescribeMapaDelivery: true, temporalPresente: true }),
    false,
  )
})

test('MP9b · sin reescribir el mapa, el temporal se borra por dot-path', () => {
  assert.equal(
    debeBorrarTemporalPorRuta({ reescribeMapaDelivery: false, temporalPresente: true }),
    true,
  )
})

test('MP9c · sin temporal no hay nada que borrar', () => {
  assert.equal(debeBorrarTemporalPorRuta({ reescribeMapaDelivery: false, temporalPresente: false }), false)
  assert.equal(debeBorrarTemporalPorRuta({ reescribeMapaDelivery: true, temporalPresente: false }), false)
})

// ─── Guard del cierre ─────────────────────────────────────────────────────────

test('MP21 · el cierre de "entregado" sin confirmaciones se permite', () => {
  assert.equal(permiteCierreSinConfirmaciones({ nuevo: 'entregado', traePayloadDeCobro: false }), true)
})

test('MP22 · la misma rama con payload de cobro se rechaza', () => {
  assert.equal(permiteCierreSinConfirmaciones({ nuevo: 'entregado', traePayloadDeCobro: true }), false)
})

test('MP23 · otras transiciones sin confirmación siguen rechazadas', () => {
  for (const nuevo of ['retirado', 'en_camino_retiro', 'en_camino_entrega', 'cancelada', '']) {
    assert.equal(permiteCierreSinConfirmaciones({ nuevo, traePayloadDeCobro: false }), false, nuevo)
  }
})

// ─── Lado UI ──────────────────────────────────────────────────────────────────

test('MP-UI1 · el selector ofrece tres opciones y ninguna es un default', () => {
  assert.deepEqual(OPCIONES_MEDIO.map((o) => o.value), ['efectivo', 'transferencia', MEDIO_NO_SABE])
  assert.deepEqual(OPCIONES_MEDIO.map((o) => o.label), ['Efectivo', 'Transferencia', 'No estoy seguro'])
})

test('MP6 · "No estoy seguro" no viaja en el payload', () => {
  assert.equal(medioParaPayload(MEDIO_NO_SABE), undefined)
  assert.equal(medioParaPayload(''), undefined)
  assert.equal(medioParaPayload('Efectivo'), undefined)
  assert.equal(medioParaPayload(undefined), undefined)
})

test('MP4/MP5 · efectivo y transferencia sí viajan', () => {
  assert.equal(medioParaPayload('efectivo'), 'efectivo')
  assert.equal(medioParaPayload('transferencia'), 'transferencia')
})

test('MP-UI2 · "No estoy seguro" cuenta como respuesta, el vacío no', () => {
  assert.equal(medioRespondido(MEDIO_NO_SABE), true)
  assert.equal(medioRespondido('efectivo'), true)
  assert.equal(medioRespondido(''), false)
  assert.equal(medioRespondido(undefined), false)
})
