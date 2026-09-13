// B2.3B — Suite focal de lib/trazabilidad-pago.ts
//
// Fixtures calcados de shenvios-staging (lectura del 2026-08-23):
//   k5Ve09HM  delivery 80 cobrado · producto 1.000 no cobrado · sin depósito
//   fq6w3pXc  CE 100 · delivery 150 deducido · ambos cobrados → faltante 50
//   8MWJtz4G  CE 500 · delivery 150 deducido · nada cobrado
//   KSYw6wcH  sin CE · delivery 130 no cobrado
//   OxGVVg3H  todo cobrado y depositado
//   XbMyvCxL  quienPaga = transferencia → el motorizado no recauda

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { trazabilidadPago, etiquetaEstadoCliente, type EntradaTrazabilidad } from './trazabilidad-pago'
import type { DepositoRegistrado } from './deposito-orden'

const MOTO = 'John Pork 2'

/** k5Ve09HM */
function ordenDeliveryCobrado(over: Partial<EntradaTrazabilidad> = {}): EntradaTrazabilidad {
  return {
    tipoServicio: 'normal',
    tipoCliente: 'contado',
    asignacion: { motorizadoNombre: MOTO },
    cobroContraEntrega: { aplica: true, monto: 1000 },
    confirmacion: { precioFinalCordobas: 80 },
    pagoDelivery: { quienPaga: 'entrega', deducirDelCobroContraEntrega: false },
    cobrosMotorizado: {
      delivery: { monto: 80, recibio: true },
      producto: { monto: 1000, recibio: false, estado: 'pendiente', justificacion: 'Otro: transferencia' },
    },
    cobroDelivery: { estado: 'pagado', monto: 80 },
    ...over,
  }
}

// ── P1 ──────────────────────────────────────────────────────────────────────
test('P1 · estado frente al cliente y destino del dinero son cosas distintas', () => {
  const t = trazabilidadPago(ordenDeliveryCobrado())
  assert.equal(t.estadoCliente.clave, 'pagado')
  assert.equal(t.estadoCliente.etiqueta, 'Cobrado')
  assert.equal(t.estadoCliente.montoPendiente, 0)
  // ...y sin embargo StorkHub todavía no recibió nada.
  assert.deepEqual(t.destinos.map((d) => [d.etiqueta, d.monto, d.situacion]), [
    ['StorkHub', 80, 'Pendiente de depósito'],
  ])
  assert.equal(t.cobradoPeroNoDepositado, true)
})

// ── P2 ──────────────────────────────────────────────────────────────────────
test('P2 · el producto no cobrado no aparece como dinero recibido ni como destino', () => {
  const t = trazabilidadPago(ordenDeliveryCobrado())
  assert.equal(t.destinos.some((d) => d.destino === 'comercio'), false)
  assert.equal(t.destinos.some((d) => d.monto === 1000), false)
  // El delivery mostrado es el delivery, nunca el CE.
  assert.equal(t.montoDelivery, 80)
})

// ── P3 ──────────────────────────────────────────────────────────────────────
test('P3 · delivery no cobrado no inventa receptor', () => {
  // KSYw6wcH: sin CE, delivery 130 declarado no recibido.
  const t = trazabilidadPago({
    tipoServicio: 'normal',
    tipoCliente: 'contado',
    asignacion: { motorizadoNombre: MOTO },
    cobroContraEntrega: { aplica: false },
    confirmacion: { precioFinalCordobas: 130 },
    pagoDelivery: { quienPaga: 'entrega', deducirDelCobroContraEntrega: false },
    cobrosMotorizado: { delivery: { monto: 130, recibio: false, justificacion: 'El cliente no tenía efectivo' } },
    cobroDelivery: { estado: 'pendiente', monto: 130 },
  })
  assert.equal(t.receptor, null)
  assert.equal(t.estadoCliente.etiqueta, 'Por cobrar')
  assert.equal(t.estadoCliente.montoPendiente, 130)
  assert.deepEqual(t.destinos, [])
  assert.equal(t.cobradoPeroNoDepositado, false)
})

test('P3b · cobro diferido a la entrega tampoco pone al motorizado como receptor', () => {
  // Con esta justificación calcularDeposito mantiene tieneDelivery = true,
  // pero el motorizado todavía no tiene el dinero: recibio sigue en false.
  const t = trazabilidadPago(ordenDeliveryCobrado({
    cobrosMotorizado: { delivery: { monto: 80, recibio: false, justificacion: 'Se acordó cobrar en la entrega' } },
    cobroDelivery: { estado: 'pendiente', monto: 80 },
  }))
  assert.equal(t.receptor, null)
  assert.equal(t.cobradoPeroNoDepositado, false)
})

// ── P4 ──────────────────────────────────────────────────────────────────────
test('P4 · CE deducido y nada cobrado: sin destinos y sin C$650', () => {
  // 8MWJtz4G
  const t = trazabilidadPago({
    tipoServicio: 'normal',
    tipoCliente: 'contado',
    asignacion: { motorizadoNombre: MOTO },
    cobroContraEntrega: { aplica: true, monto: 500 },
    confirmacion: { precioFinalCordobas: 150 },
    pagoDelivery: { quienPaga: 'entrega', deducirDelCobroContraEntrega: true },
    cobrosMotorizado: {
      delivery: { monto: 150, recibio: false, justificacion: 'D' },
      producto: { monto: 500, recibio: false, estado: 'pendiente', justificacion: 'D' },
    },
    cobroDelivery: { estado: 'pendiente', monto: 150, montoDelivery: 150, cubiertoPorDeposito: 0 },
  })
  assert.deepEqual(t.destinos, [])
  assert.equal(t.receptor, null)
  assert.equal(t.estadoCliente.montoPendiente, 150)
  assert.equal(t.montoDelivery, 150)
  assert.notEqual(t.montoDelivery, 650)
})

// ── P5 ──────────────────────────────────────────────────────────────────────
test('P5 · obligación a StorkHub produce destino StorkHub', () => {
  const t = trazabilidadPago(ordenDeliveryCobrado())
  assert.equal(t.destinos.length, 1)
  assert.equal(t.destinos[0].destino, 'storkhub')
  assert.equal(t.destinos[0].monto, 80)
})

// ── P6 ──────────────────────────────────────────────────────────────────────
test('P6 · obligación al comercio produce destino comercio', () => {
  const t = trazabilidadPago(ordenDeliveryCobrado({
    confirmacion: { precioFinalCordobas: 0 },
    cobrosMotorizado: { delivery: { monto: 0, recibio: true }, producto: { monto: 1000, recibio: true } },
    cobroDelivery: { estado: 'no_cobrar', monto: 0 },
  }))
  assert.deepEqual(t.destinos.map((d) => [d.etiqueta, d.monto]), [['Comercio', 1000]])
})

// ── P7 ──────────────────────────────────────────────────────────────────────
test('P7 · con dos destinos se muestran separados, nunca sumados', () => {
  // OxGVVg3H: delivery 110 a StorkHub y producto 1.000 al comercio.
  const t = trazabilidadPago(ordenDeliveryCobrado({
    confirmacion: { precioFinalCordobas: 110 },
    cobrosMotorizado: { delivery: { monto: 110, recibio: true }, producto: { monto: 1000, recibio: true } },
    cobroDelivery: { estado: 'pagado', monto: 110 },
  }))
  assert.deepEqual(t.destinos.map((d) => [d.etiqueta, d.monto]), [['StorkHub', 110], ['Comercio', 1000]])
  assert.equal(t.destinos.some((d) => d.monto === 1110), false)
})

// ── P8 ──────────────────────────────────────────────────────────────────────
test('P8 · sin medio de pago persistido no se inventa "Efectivo"', () => {
  assert.equal(trazabilidadPago(ordenDeliveryCobrado()).medioPago, null)
  // Ni siquiera cuando hay obligación de depositar, que es de donde se
  // tentaría deducir que fue efectivo.
  assert.equal(trazabilidadPago(ordenDeliveryCobrado()).destinos.length, 1)
})

test('P8b · formaPago solo cuenta si el cobro sigue vigente', () => {
  const vigente = trazabilidadPago(ordenDeliveryCobrado({
    cobroDelivery: { estado: 'pagado', monto: 80, formaPago: 'transferencia', pagadoAt: '2026-08-22T05:00:00.000Z' },
  }))
  assert.equal(vigente.medioPago, 'transferencia')

  // Tras una reversión pagadoAt se borra: el medio deja de ser afirmable.
  const revertido = trazabilidadPago(ordenDeliveryCobrado({
    cobroDelivery: { estado: 'pendiente', monto: 80, formaPago: 'transferencia' },
  }))
  assert.equal(revertido.medioPago, null)
})

// ── P9 ──────────────────────────────────────────────────────────────────────
test('P9 · en fuera_managua la pregunta al motorizado cambia de sujeto: sin receptor', () => {
  const t = trazabilidadPago(ordenDeliveryCobrado({ tipoServicio: 'fuera_managua' }))
  assert.equal(t.receptor, null)
  // La obligación sí se sigue mostrando: esa sí es inequívoca.
  assert.equal(t.destinos[0].monto, 80)
  assert.equal(t.cobradoPeroNoDepositado, false)
})

test('P9b · sin nombre de motorizado no se inventa uno', () => {
  const t = trazabilidadPago(ordenDeliveryCobrado({ asignacion: null }))
  assert.equal(t.receptor?.clave, 'motorizado')
  assert.equal(t.receptor?.etiqueta, 'El motorizado')
})

// ── P10 ─────────────────────────────────────────────────────────────────────
test('P10 · con depósito confirmado el destino refleja ese estado', () => {
  const dep: DepositoRegistrado = {
    id: 'jF4c3L6AGmzpq9L99dXQ',
    estado: 'confirmado',
    solicitudIds: ['OxGVVg3HYP0If3NSOqAI'],
    montoTotal: 80,
  }
  const t = trazabilidadPago(ordenDeliveryCobrado(), { storkhub: dep })
  assert.equal(t.destinos[0].situacion, 'Confirmado')
  assert.equal(t.destinos[0].tieneDeposito, true)
  // Ya llegó a destino: deja de ser el caso que hay que explicar.
  assert.equal(t.cobradoPeroNoDepositado, false)
})

test('P10b · depósito en revisión conserva la taxonomía de B2.3', () => {
  const dep: DepositoRegistrado = { id: 'x', estado: 'en_revision', solicitudIds: ['a'], montoTotal: 80 }
  assert.equal(trazabilidadPago(ordenDeliveryCobrado(), { storkhub: dep }).destinos[0].situacion, 'En revisión')
})

// ── P11 ─────────────────────────────────────────────────────────────────────
test('P11 · pago directo por transferencia ya cobrado: recibe StorkHub, sin depósito', () => {
  const t = trazabilidadPago({
    tipoServicio: 'normal',
    tipoCliente: 'contado',
    cobroContraEntrega: { aplica: false },
    confirmacion: { precioFinalCordobas: 150 },
    pagoDelivery: { quienPaga: 'transferencia', deducirDelCobroContraEntrega: false },
    cobroDelivery: { estado: 'pagado', monto: 150 },
  })
  assert.equal(t.receptor?.clave, 'storkhub')
  assert.equal(t.receptor?.etiqueta, 'StorkHub, directo del comercio')
  assert.equal(t.quienPaga, 'Comercio, por transferencia')
  // El motorizado nunca tocó ese dinero: no le corresponde depositar nada.
  assert.deepEqual(t.destinos, [])
  assert.equal(t.cobradoPeroNoDepositado, false)
})

test('P11c · XbMyvCxL: transferencia acordada pero orden cancelada, sin receptor', () => {
  // `quienPaga = transferencia` describe el acuerdo, no que el dinero entró.
  const t = trazabilidadPago({
    tipoServicio: 'fuera_managua',
    tipoCliente: 'contado',
    cobroContraEntrega: { aplica: false },
    confirmacion: { precioFinalCordobas: 150 },
    pagoDelivery: { quienPaga: 'transferencia', deducirDelCobroContraEntrega: false },
  })
  assert.equal(t.receptor, null)
  assert.equal(t.estadoCliente.clave, 'na')
  // El acuerdo sí se muestra: eso está persistido.
  assert.equal(t.quienPaga, 'Comercio, por transferencia')
  assert.deepEqual(t.destinos, [])
})

test('P11b · crédito semanal: el motorizado no recauda y no hay destino', () => {
  const t = trazabilidadPago({
    tipoServicio: 'normal',
    tipoCliente: 'credito',
    cobroContraEntrega: { aplica: false },
    confirmacion: { precioFinalCordobas: 150 },
    pagoDelivery: { quienPaga: 'credito_semanal', deducirDelCobroContraEntrega: false },
  })
  assert.equal(t.receptor, null)
  assert.equal(t.quienPaga, 'Comercio, en crédito semanal')
  assert.deepEqual(t.destinos, [])
})

// ── P12 ─────────────────────────────────────────────────────────────────────
test('P12 · documento vacío o legacy no rompe', () => {
  const t = trazabilidadPago({})
  assert.equal(t.montoDelivery, 0)
  assert.equal(t.receptor, null)
  assert.equal(t.medioPago, null)
  assert.deepEqual(t.destinos, [])
  assert.equal(t.quienPaga, null)
  assert.equal(t.cobradoPeroNoDepositado, false)
  assert.equal(t.estadoCliente.clave, 'na')
})

test('P12b · quienPaga desconocido se muestra tal cual, no se oculta', () => {
  const t = trazabilidadPago(ordenDeliveryCobrado({
    pagoDelivery: { quienPaga: 'modalidad_futura', deducirDelCobroContraEntrega: false },
  }))
  assert.equal(t.quienPaga, 'modalidad_futura')
})

// ── Faltante parcial (fixture fq6w3pXc) ─────────────────────────────────────
test('PARCIAL · fq6w3pXc: cobrado en parte, C$100 a depositar y C$50 por cobrar', () => {
  const t = trazabilidadPago({
    tipoServicio: 'normal',
    tipoCliente: 'contado',
    asignacion: { motorizadoNombre: MOTO },
    cobroContraEntrega: { aplica: true, monto: 100 },
    confirmacion: { precioFinalCordobas: 150 },
    pagoDelivery: { quienPaga: 'entrega', deducirDelCobroContraEntrega: true },
    cobrosMotorizado: { delivery: { monto: 150, recibio: true }, producto: { monto: 100, recibio: true } },
    cobroDelivery: { estado: 'pendiente', monto: 50, montoDelivery: 150, cubiertoPorDeposito: 100 },
  })
  // El motorizado recibió 100 y debe depositarlos; quedan 50 por cobrar.
  assert.equal(t.receptor?.clave, 'motorizado')
  assert.deepEqual(t.destinos.map((d) => [d.etiqueta, d.monto]), [['StorkHub', 100]])
  assert.equal(t.estadoCliente.montoPendiente, 50)
  assert.equal(t.montoDelivery, 150)
  // Ni el comercio recibe nada: el CE entero se fue en cubrir el delivery.
  assert.equal(t.destinos.some((d) => d.destino === 'comercio'), false)
})

// ── Copy ────────────────────────────────────────────────────────────────────
test('COPY · "pagado" se presenta como "Cobrado", no como dinero recibido', () => {
  assert.equal(etiquetaEstadoCliente('pagado'), 'Cobrado')
  assert.equal(etiquetaEstadoCliente('pendiente'), 'Por cobrar')
  assert.equal(etiquetaEstadoCliente('en_revision'), 'Comprobante en revisión')
  assert.equal(etiquetaEstadoCliente('no_cobrar'), 'No se cobra')
  assert.equal(etiquetaEstadoCliente('revertido'), 'Cobro revertido')
  assert.equal(etiquetaEstadoCliente('na'), 'Sin registrar')
  // Una clave futura no se oculta.
  assert.equal(etiquetaEstadoCliente('otra'), 'otra')
})

// ─── FIN-SEMANTICA-UX-1 · el plan no es el resultado ──────────────────────────
//
// `pagoDelivery.quienPaga` es el ACUERDO que se pactó al crear la orden.
// `cobroDelivery.formaPago` es lo que REALMENTE pasó, y solo existe cuando un
// gestor lo confirmó. El drawer los mezclaba: mostraba el plan como si fuera
// el desenlace, y escondía el resultado cuando no coincidían.
//
// Caso que lo destapó — WXfAQe3UkF2XVERZLpNX: plan `entrega`, el motorizado no
// recibió, el cliente pagó por transferencia y el gestor confirmó el boucher.

/** Base: contado, sin cobro contra entrega, delivery 80. */
function ordenPlan(quienPaga: string, over: Partial<EntradaTrazabilidad> = {}): EntradaTrazabilidad {
  return {
    tipoServicio: 'normal',
    tipoCliente: 'contado',
    asignacion: { motorizadoNombre: MOTO },
    cobroContraEntrega: { aplica: false, monto: 0 },
    confirmacion: { precioFinalCordobas: 80 },
    pagoDelivery: { quienPaga, deducirDelCobroContraEntrega: false },
    cobrosMotorizado: { delivery: { monto: 80, recibio: false } },
    cobroDelivery: { estado: 'pendiente', monto: 80 },
    ...over,
  }
}

const PAGADO_EFECTIVO = { estado: 'pagado', monto: 80, formaPago: 'efectivo', pagadoAt: 'ts' }
const PAGADO_TRANSFER = { estado: 'pagado', monto: 80, formaPago: 'transferencia', pagadoAt: 'ts' }

test('S9 · plan entrega + resultado efectivo: los dos visibles y distintos', () => {
  const t = trazabilidadPago(ordenPlan('entrega', {
    cobrosMotorizado: { delivery: { monto: 80, recibio: true } },
    cobroDelivery: PAGADO_EFECTIVO,
  }))
  assert.equal(t.quienPaga, 'Destinatario, al entregar', 'el plan')
  assert.equal(t.medioPago, 'efectivo', 'el resultado')
  assert.equal(t.estadoCliente.etiqueta, 'Cobrado')
  assert.equal(t.receptor?.clave, 'motorizado')
})

test('S10 · plan entrega + resultado transferencia: el resultado NO queda oculto', () => {
  // El caso real. Antes el drawer condicionaba toda la sección de
  // transferencia a quienPaga === 'transferencia', así que con plan 'entrega'
  // el boucher y la confirmación desaparecían de pantalla.
  const t = trazabilidadPago(ordenPlan('entrega', { cobroDelivery: PAGADO_TRANSFER }))
  assert.equal(t.quienPaga, 'Destinatario, al entregar')
  assert.equal(t.medioPago, 'transferencia')
  assert.notEqual(t.medioPago, null, 'el resultado real se perdió')
  assert.equal(t.estadoCliente.etiqueta, 'Cobrado')
  // El motorizado no recibió nada: no puede figurar como receptor.
  assert.equal(t.receptor, null)
})

test('S11 · plan recolección + resultado efectivo', () => {
  const t = trazabilidadPago(ordenPlan('recoleccion', {
    cobrosMotorizado: { delivery: { monto: 80, recibio: true } },
    cobroDelivery: PAGADO_EFECTIVO,
  }))
  assert.equal(t.quienPaga, 'Comercio, al retirar')
  assert.equal(t.medioPago, 'efectivo')
  assert.equal(t.receptor?.clave, 'motorizado')
})

test('S12 · formaPago sin pagadoAt ⇒ no se afirma un resultado', () => {
  // La reversión borra pagadoAt y formaPago, pero deja metodoPagoReal. Un
  // formaPago suelto sin pagadoAt es un residuo, no una confirmación.
  const t = trazabilidadPago(ordenPlan('entrega', {
    cobroDelivery: { estado: 'pendiente', monto: 80, formaPago: 'transferencia' },
  }))
  assert.equal(t.medioPago, null)
  assert.equal(t.estadoCliente.etiqueta, 'Por cobrar')
})

test('S13 · boucher en revisión ⇒ resultado intermedio, sin medio afirmado', () => {
  // Estado exacto de WXfAQe3UkF2XVERZLpNX ahora mismo en staging.
  const t = trazabilidadPago(ordenPlan('entrega', {
    cobroDelivery: { estado: 'en_revision_deposito', monto: 80 },
  }))
  assert.equal(t.quienPaga, 'Destinatario, al entregar')
  assert.equal(t.estadoCliente.clave, 'en_revision')
  assert.equal(t.estadoCliente.etiqueta, 'Comprobante en revisión')
  assert.equal(t.medioPago, null, 'afirmó un medio antes de que el gestor confirmara')
  assert.equal(t.estadoCliente.montoPendiente, 80)
})

test('S14 · crédito: el plan se enuncia y el resultado sigue abierto', () => {
  const t = trazabilidadPago({
    ...ordenPlan('credito_semanal'),
    tipoCliente: 'credito',
    cobroDelivery: { estado: 'pendiente', monto: 80 },
  })
  assert.equal(t.quienPaga, 'Comercio, en crédito semanal')
  assert.equal(t.medioPago, null)
  assert.equal(t.estadoCliente.etiqueta, 'Por cobrar')
})

test('S15 · el plan nunca determina el medio real', () => {
  // Para los cuatro planes, sin formaPago persistido el medio es null. Que
  // 'transferencia' sea la misma cadena como plan y como medio es justo lo que
  // hacía verosímil derivar uno del otro.
  for (const qp of ['entrega', 'recoleccion', 'transferencia', 'credito_semanal']) {
    assert.equal(trazabilidadPago(ordenPlan(qp)).medioPago, null, `el plan ${qp} produjo un medio`)
  }
  // Y con el medio persistido, es el medio quien manda, no el plan.
  assert.equal(trazabilidadPago(ordenPlan('transferencia', { cobroDelivery: PAGADO_EFECTIVO })).medioPago, 'efectivo')
  assert.equal(trazabilidadPago(ordenPlan('entrega', { cobroDelivery: PAGADO_TRANSFER })).medioPago, 'transferencia')
})

// ─── TRAZABILIDAD-DINERO-UX-1 · el efectivo de la Function ───────────────────
//
// SH-0001: el motorizado cobró C$110 en efectivo al entregar. La Function
// escribe cobroDelivery con estado 'pagado' y formaPago 'efectivo', pero SIN
// pagadoAt — ese campo solo lo pone el gestor al confirmar desde Cobros. El
// medio real existía y el drawer lo mostraba como "No registrado".

test('M1 · SH-0001 ⇒ Cobrado · Efectivo, y el dinero todavía no llegó a StorkHub', () => {
  const t = trazabilidadPago(ordenPlan('entrega', {
    confirmacion: { precioFinalCordobas: 110 },
    cobrosMotorizado: { delivery: { monto: 110, recibio: true } },
    cobroDelivery: { estado: 'pagado', monto: 110, formaPago: 'efectivo' },
  }))
  assert.equal(t.estadoCliente.etiqueta, 'Cobrado')
  assert.equal(t.medioPago, 'efectivo', 'el efectivo de la Function quedó sin medio')
  assert.equal(t.receptor?.clave, 'motorizado')
  // Cobrado NO es depositado: son dos tramos del mismo billete.
  assert.equal(t.cobradoPeroNoDepositado, true)
})

test('M2 · un formaPago sobre un cobro que no está pagado sigue sin afirmarse', () => {
  for (const estado of ['pendiente', 'en_revision_deposito', 'no_cobrar']) {
    const t = trazabilidadPago(ordenPlan('entrega', {
      cobroDelivery: { estado, monto: 80, formaPago: 'transferencia' },
    }))
    assert.equal(t.medioPago, null, `afirmó un medio con estado=${estado}`)
  }
})
