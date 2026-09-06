// B2-PAGO-MEDIO-BOUCHER-REVIEW — suite focal de lib/cobros-contado.ts
//
// El caso de referencia es el E2E real ejecutado en staging: la orden
// WXfAQe3UkF2XVERZLpNX, C$80, `quienPaga: 'entrega'`, entregada con
// `recibio: false` y justificación "Cliente indicó que pagará por
// transferencia", incidencia resuelta como `cliente_pagara`, y boucher del
// comercio en revisión. Los valores del caso 17 están copiados del documento
// real leído de Firestore, no inventados.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  visibleEnCobrosContado,
  etiquetaFormaPagoCobros,
  FORMA_PAGO_COBROS_AUSENTE,
} from './cobros-contado'
import { estadoDeliveryComercio, type EntradaEstadoComercio } from './estado-cobro-comercio'

/** Orden de contado entregada, sin incidencia abierta. Base de los casos. */
function orden(over: Record<string, unknown> = {}) {
  return {
    tipoCliente: 'contado',
    cobroPendiente: false,
    confirmacion: { precioFinalCordobas: 80 },
    cobroContraEntrega: { aplica: false, monto: 0 },
    pagoDelivery: { quienPaga: 'entrega', deducirDelCobroContraEntrega: false },
    cobroDelivery: { estado: 'pendiente', monto: 80, quienPaga: 'entrega' },
    ...over,
  }
}

// ── Visibilidad ──────────────────────────────────────────────────────────────

test('V1 · pendiente + entrega ⇒ visible', () => {
  assert.equal(visibleEnCobrosContado(orden()), true)
})

test('V2 · en_revision_deposito + entrega ⇒ visible', () => {
  // El caso que se perdía: el comercio subió boucher sobre un cobro que nunca
  // fue de transferencia, y la fila desaparecía del gestor.
  const o = orden({ cobroDelivery: { estado: 'en_revision_deposito', monto: 80, quienPaga: 'entrega' } })
  assert.equal(visibleEnCobrosContado(o), true)
})

test('V3 · en_revision_deposito + transferencia ⇒ visible', () => {
  const o = orden({
    pagoDelivery: { quienPaga: 'transferencia' },
    cobroDelivery: { estado: 'en_revision_deposito', monto: 80, quienPaga: 'transferencia' },
  })
  assert.equal(visibleEnCobrosContado(o), true)
})

test('V4 · pagado ⇒ no visible', () => {
  for (const qp of ['entrega', 'recoleccion', 'transferencia']) {
    const o = orden({
      pagoDelivery: { quienPaga: qp },
      cobroDelivery: { estado: 'pagado', monto: 80, formaPago: 'efectivo' },
    })
    assert.equal(visibleEnCobrosContado(o), false, `pagado visible con quienPaga=${qp}`)
  }
})

test('V5 · no_cobrar ⇒ no visible', () => {
  for (const qp of ['entrega', 'transferencia']) {
    const o = orden({ pagoDelivery: { quienPaga: qp }, cobroDelivery: { estado: 'no_cobrar', monto: 0 } })
    assert.equal(visibleEnCobrosContado(o), false, `no_cobrar visible con quienPaga=${qp}`)
  }
})

test('V6 · cobroPendiente true ⇒ no visible, aunque el estado sea cobrable', () => {
  // La incidencia sin clasificar vive en su propio tab. Aparecer en los dos
  // sitios a la vez sería doble contabilidad en el KPI de contado pendiente.
  for (const estado of ['pendiente', 'en_revision_deposito']) {
    const o = orden({ cobroPendiente: true, cobroDelivery: { estado, monto: 80 } })
    assert.equal(visibleEnCobrosContado(o), false, `visible con incidencia abierta y estado=${estado}`)
  }
})

test('V7 · crédito ⇒ no visible en cualquier estado', () => {
  for (const estado of ['pendiente', 'en_revision_deposito', 'pagado', 'no_cobrar', 'revertido']) {
    const o = orden({ tipoCliente: 'credito', cobroDelivery: { estado, monto: 80 } })
    assert.equal(visibleEnCobrosContado(o), false, `crédito visible con estado=${estado}`)
  }
})

test('V8 · credito_semanal ⇒ no visible aunque tipoCliente diga contado', () => {
  for (const estado of ['pendiente', 'en_revision_deposito']) {
    const o = orden({
      tipoCliente: 'contado',
      pagoDelivery: { quienPaga: 'credito_semanal' },
      cobroDelivery: { estado, monto: 80 },
    })
    assert.equal(visibleEnCobrosContado(o), false, `credito_semanal visible con estado=${estado}`)
  }
})

test('V9 · legacy sin cobroDelivery + transferencia ⇒ visible', () => {
  // Órdenes anteriores a que cobroDelivery existiera: el cliente deposita
  // directo a ShEnvíos y sin esta red no habría forma de cobrarlas.
  const o = orden({ cobroDelivery: undefined, pagoDelivery: { quienPaga: 'transferencia' } })
  assert.equal(visibleEnCobrosContado(o), true)
})

test('V10 · legacy sin cobroDelivery + entrega ⇒ no visible (comportamiento preservado)', () => {
  // El efectivo que el motorizado ya recaudó lo maneja el flujo de depósito,
  // no Cobros. Era así antes de este bloque y sigue siéndolo.
  for (const qp of ['entrega', 'recoleccion', '']) {
    const o = orden({ cobroDelivery: undefined, pagoDelivery: { quienPaga: qp } })
    assert.equal(visibleEnCobrosContado(o), false, `visible con quienPaga=${qp}`)
  }
  assert.equal(visibleEnCobrosContado(orden({ cobroDelivery: undefined, pagoDelivery: null })), false)
})

test('V11 · cobroDelivery corrupto ⇒ fail closed, sin lanzar', () => {
  // Un documento roto nunca OTORGA visibilidad: no se lee ningún campo suyo.
  // La decisión queda en pagoDelivery.quienPaga, que es un campo aparte.
  const corruptos: unknown[] = ['pendiente', '', 0, 1, true, false, null, [], ['pendiente'], [{ estado: 'pendiente' }]]
  for (const cd of corruptos) {
    const ctx = JSON.stringify(cd) ?? String(cd)
    assert.equal(
      visibleEnCobrosContado(orden({ cobroDelivery: cd })),
      false,
      `un cobroDelivery ${ctx} otorgó visibilidad por sí solo`,
    )
    // Con la red legacy activa sí se muestra: un documento roto que además es
    // cobrable es justo lo que el gestor tiene que ver, no lo que hay que
    // esconder.
    assert.equal(
      visibleEnCobrosContado(orden({ cobroDelivery: cd, pagoDelivery: { quienPaga: 'transferencia' } })),
      true,
      `la red legacy no cubrió un cobroDelivery ${ctx}`,
    )
  }
})

test('V11b · estado desconocido o vacío no decide por sí mismo', () => {
  for (const estado of ['', 'revertido', 'PENDIENTE', 'en_revision', 'otro']) {
    assert.equal(
      visibleEnCobrosContado(orden({ cobroDelivery: { estado, monto: 80 } })),
      false,
      `estado=${estado} otorgó visibilidad`,
    )
  }
})

// ── Etiqueta de forma de pago ────────────────────────────────────────────────

test('V12 · sin formaPago ⇒ No registrado', () => {
  for (const v of [undefined, null, '']) {
    assert.equal(etiquetaFormaPagoCobros(v), FORMA_PAGO_COBROS_AUSENTE)
  }
  assert.equal(FORMA_PAGO_COBROS_AUSENTE, 'No registrado')
})

test('V13 · efectivo ⇒ Efectivo', () => {
  assert.equal(etiquetaFormaPagoCobros('efectivo'), 'Efectivo')
})

test('V14 · transferencia ⇒ Transferencia', () => {
  assert.equal(etiquetaFormaPagoCobros('transferencia'), 'Transferencia')
})

test('V15 · valores inválidos y casing ⇒ No registrado, sin normalizar', () => {
  const invalidos: unknown[] = [
    'Efectivo', 'EFECTIVO', ' efectivo', 'efectivo ', 'Transferencia', 'TRANSFERENCIA',
    'transferencia_deposito', 'tarjeta', 'cheque', 0, 1, true, false, {}, [], ['efectivo'],
  ]
  for (const v of invalidos) {
    assert.equal(
      etiquetaFormaPagoCobros(v),
      FORMA_PAGO_COBROS_AUSENTE,
      `${JSON.stringify(v) ?? String(v)} se presentó como un medio confirmado`,
    )
  }
})

test('V16 · quienPaga nunca determina la forma de pago', () => {
  // La garantía es ESTRUCTURAL, no de valor: la firma recibe `formaPago`, no
  // la orden, así que `quienPaga` no tiene por dónde entrar. Comprobarlo sobre
  // la cadena suelta no probaría nada — 'transferencia' es literalmente el
  // mismo string como flujo y como medio, y esa colisión es justo lo que hizo
  // que derivar uno del otro pareciera razonable durante meses.
  //
  // Así que se comprueba al nivel donde vivía el bug: la orden. Ninguno de los
  // cuatro flujos produce un medio mientras `formaPago` esté ausente.
  for (const qp of ['entrega', 'recoleccion', 'transferencia', 'credito_semanal']) {
    const cd = { estado: 'en_revision_deposito', monto: 80, quienPaga: qp } as { formaPago?: unknown }
    assert.equal(
      etiquetaFormaPagoCobros(cd.formaPago),
      FORMA_PAGO_COBROS_AUSENTE,
      `una orden con quienPaga=${qp} y sin formaPago produjo un medio`,
    )
  }
  // Y los dos valores que la tabla traducía a "Efectivo" no son medios.
  assert.equal(etiquetaFormaPagoCobros('entrega'), FORMA_PAGO_COBROS_AUSENTE)
  assert.equal(etiquetaFormaPagoCobros('recoleccion'), FORMA_PAGO_COBROS_AUSENTE)
})

// ── Caso real de staging ─────────────────────────────────────────────────────

test('V17 · WXfAQe3UkF2XVERZLpNX: entrega + en_revision_deposito + boucher ⇒ visible y sin medio', () => {
  const real = {
    tipoCliente: 'contado',
    cobroPendiente: false,
    confirmacion: { precioFinalCordobas: 80 },
    cobroContraEntrega: { aplica: false, monto: 0 },
    pagoDelivery: { quienPaga: 'entrega', tipo: 'contado', montoSugerido: 80, deducirDelCobroContraEntrega: false },
    cobrosMotorizado: {
      delivery: { monto: 80, recibio: false, justificacion: 'Cliente indicó que pagará por transferencia' },
      resolucion: { tipo: 'cliente_pagara', resueltoPor: 'RKTw1pLfK5O8Y3A6IIwDU8J3yr43' },
    },
    cobroDelivery: {
      monto: 80,
      tipoCliente: 'contado',
      quienPaga: 'entrega',
      estado: 'en_revision_deposito',
      boucherVigente: 'comercio',
      boucherComercio: { url: 'https://…/delivery_boucher_comercio.jpg', path: 'evidencias/WXfAQe3UkF2XVERZLpNX/delivery_boucher_comercio.jpg' },
    },
  }
  assert.equal(visibleEnCobrosContado(real), true, 'la orden C$80 sigue sin llegar a Cobros')
  // formaPago está AUSENTE en el documento real: el motorizado declaró que no
  // recibió, y B2-PAGO-MEDIO-FIX hace bien en no afirmar ningún medio.
  assert.equal(
    etiquetaFormaPagoCobros((real.cobroDelivery as { formaPago?: unknown }).formaPago),
    FORMA_PAGO_COBROS_AUSENTE,
  )
  // Y el comercio ve exactamente lo mismo desde su lado.
  assert.equal(estadoDeliveryComercio(real as EntradaEstadoComercio).clave, 'en_revision')
})

// ── Invariante cruzada con estado-cobro-comercio ─────────────────────────────

test('INV · gestor y comercio coinciden en si hay cartera abierta', () => {
  // La divergencia entre estas dos lecturas es exactamente lo que produjo el
  // bug: el comercio veía "C$80 en revisión" y el gestor no veía nada. Este
  // test obliga a que un estado nuevo se decida en los dos lados a la vez.
  //
  // Alcance: los SEIS estados declarados en `EstadoCobroDelivery`, sobre
  // cobros FÍSICOS con un cobroDelivery bien formado.
  //
  // Quedan fuera dos zonas a propósito, ambas documentadas y ninguna
  // alcanzable hoy: la red legacy (`quienPaga === 'transferencia'`), que cubre
  // documentos SIN cobroDelivery —justo lo que el helper del comercio no sabe
  // leer—, y el estado ausente, cuya divergencia se fija en INVb.
  const ESTADOS = ['pendiente', 'en_revision_deposito', 'pagado', 'no_cobrar', 'revertido']
  for (const estado of ESTADOS) {
    for (const qp of ['entrega', 'recoleccion']) {
      for (const monto of [30, 80, 150]) {
        const o = orden({
          pagoDelivery: { quienPaga: qp, deducirDelCobroContraEntrega: false },
          cobroDelivery: { estado, monto, quienPaga: qp },
        })
        const clave = estadoDeliveryComercio(o as EntradaEstadoComercio).clave
        const comercioVeCartera = clave === 'pendiente' || clave === 'en_revision'
        assert.equal(
          visibleEnCobrosContado(o),
          comercioVeCartera,
          `divergencia — estado=${estado} quienPaga=${qp} monto=${monto}: gestor=${visibleEnCobrosContado(o)} comercio=${clave}`,
        )
      }
    }
  }
})

test('INVb · divergencia CONOCIDA: cobroDelivery con monto y sin estado', () => {
  // El comercio lo lee como "Debe C$80" (default: monto > 0 ⇒ pendiente) y el
  // gestor no lo muestra. No se corrige acá: ningún escritor produce un
  // cobroDelivery sin estado —la Function y los tres modales siempre lo
  // escriben— y elegir un lado es una decisión de negocio, no de refactor.
  // Se fija el comportamiento actual para que un cambio futuro sea deliberado.
  // Deuda: COBROS-ESTADOS-NO-ALCANZABLES.
  const o = orden({ cobroDelivery: { monto: 80, quienPaga: 'entrega' } })
  assert.equal(visibleEnCobrosContado(o), false)
  assert.equal(estadoDeliveryComercio(o as EntradaEstadoComercio).clave, 'pendiente')
})
