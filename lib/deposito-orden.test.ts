// B2.3 — Suite focal de lib/deposito-orden.ts
//
// Fixtures calcados de staging:
//   k5Ve09HMvKYJxwgw8ba3  delivery 80 cobrado · producto 1.000 NO cobrado
//   OxGVVg3HYP0If3NSOqAI  delivery 110 y producto 1.000 cobrados y depositados

import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  lineasDeposito,
  tieneObligacionDeposito,
  idsDepositoDeOrden,
  etiquetaEstadoDeposito,
  resumenDepositoOrden,
  ETIQUETAS_RESUMEN_DEPOSITO,
  ETIQUETA_RESUMEN_MIXTO,
  depositoVisible,
  depositosDesdeCache,
  TEXTO_DEPOSITO_SIN_DETALLE,
  type EntradaDepositoOrden,
  type DepositoRegistrado,
} from './deposito-orden'

/** k5Ve09HM: el motorizado cobró el delivery, no el producto. */
function ordenProductoNoCobrado(over: Partial<EntradaDepositoOrden> = {}): EntradaDepositoOrden {
  return {
    cobroContraEntrega: { aplica: true, monto: 1000 },
    confirmacion: { precioFinalCordobas: 80 },
    pagoDelivery: { quienPaga: 'entrega', deducirDelCobroContraEntrega: false },
    tipoServicio: 'normal',
    tipoCliente: 'contado',
    cobrosMotorizado: {
      delivery: { recibio: true },
      producto: { recibio: false, justificacion: 'Otro: pagará por transferencia' },
    },
    registro: null,
    ...over,
  }
}

/** OxGVVg3H: todo cobrado y ya depositado a los dos destinos. */
function ordenTodoCobrado(over: Partial<EntradaDepositoOrden> = {}): EntradaDepositoOrden {
  return {
    cobroContraEntrega: { aplica: true, monto: 1000 },
    confirmacion: { precioFinalCordobas: 110 },
    pagoDelivery: { quienPaga: 'entrega', deducirDelCobroContraEntrega: false },
    tipoServicio: 'normal',
    tipoCliente: 'contado',
    cobrosMotorizado: { delivery: { recibio: true }, producto: { recibio: true } },
    registro: {
      deposito: {
        storkhubDepositoId: 'jF4c3L6AGmzpq9L99dXQ',
        comercioDepositoId: 'gJf1rVEdZaMpTpYKRaDM',
        confirmadoStorkhub: true,
        confirmadoComercio: true,
      },
    },
    ...over,
  }
}

const depStorkhub: DepositoRegistrado = {
  id: 'jF4c3L6AGmzpq9L99dXQ',
  estado: 'confirmado',
  destinatario: 'storkhub',
  solicitudIds: ['OxGVVg3HYP0If3NSOqAI'],
  montoTotal: 110,
  montoBruto: 110,
  gastosDescontados: 0,
  boucher: { url: 'https://x/b.jpg', pathStorage: 'depositos/u/d/boucher.jpg' },
}

const depComercio: DepositoRegistrado = {
  id: 'gJf1rVEdZaMpTpYKRaDM',
  estado: 'confirmado',
  destinatario: 'comercio',
  solicitudIds: ['OxGVVg3HYP0If3NSOqAI'],
  montoTotal: 1000,
  boucher: { url: 'https://x/c.jpg', pathStorage: 'depositos/u/c/boucher.jpg' },
}

const linea = (o: EntradaDepositoOrden, d = {}, destino: 'storkhub' | 'comercio' = 'storkhub') =>
  lineasDeposito(o, d).find((l) => l.destino === destino)!

// ── D1 ──────────────────────────────────────────────────────────────────────
test('D1 · producto no cobrado NO genera depósito al comercio', () => {
  const l = linea(ordenProductoNoCobrado(), {}, 'comercio')
  assert.equal(l.obligacion, 0)
  assert.equal(l.clave, 'no_corresponde')
  assert.equal(l.texto, 'No corresponde')
  // Los C$1.000 nunca entraron en caja: no son deuda del motorizado.
  assert.notEqual(l.obligacion, 1000)
})

// ── D2 ──────────────────────────────────────────────────────────────────────
test('D2 · delivery cobrado genera obligación a StorkHub', () => {
  const l = linea(ordenProductoNoCobrado())
  assert.equal(l.obligacion, 80)
  assert.equal(l.clave, 'sin_deposito')
  assert.equal(l.texto, 'Pendiente de depósito')
})

// ── D3 ──────────────────────────────────────────────────────────────────────
test('D3 · CE deducido y nada cobrado: el motorizado no debe depositar nada', () => {
  const o: EntradaDepositoOrden = {
    cobroContraEntrega: { aplica: true, monto: 500 },
    confirmacion: { precioFinalCordobas: 150 },
    pagoDelivery: { quienPaga: 'entrega', deducirDelCobroContraEntrega: true },
    cobrosMotorizado: {
      delivery: { recibio: false, justificacion: 'x' },
      producto: { recibio: false, justificacion: 'x' },
    },
  }
  const ls = lineasDeposito(o)
  assert.equal(ls.every((l) => l.obligacion === 0), true)
  assert.equal(ls.every((l) => l.clave === 'no_corresponde'), true)
  assert.equal(tieneObligacionDeposito(o), false)
  // Ni 150, ni 500, ni 650.
  assert.equal(ls.reduce((s, l) => s + l.obligacion, 0), 0)
})

// ── D4 ──────────────────────────────────────────────────────────────────────
test('D4 · sin obligación en ninguno de los dos destinos', () => {
  const o: EntradaDepositoOrden = {
    cobroContraEntrega: { aplica: false, monto: 0 },
    confirmacion: { precioFinalCordobas: 0 },
    pagoDelivery: { quienPaga: 'entrega' },
  }
  assert.equal(tieneObligacionDeposito(o), false)
  assert.deepEqual(lineasDeposito(o).map((l) => l.texto), ['No corresponde', 'No corresponde'])
})

// ── D5 ──────────────────────────────────────────────────────────────────────
test('D5 · obligación > 0 sin depósito asociado → pendiente real', () => {
  const l = linea(ordenProductoNoCobrado())
  assert.equal(l.deposito, null)
  assert.equal(l.clave, 'sin_deposito')
  assert.equal(tieneObligacionDeposito(ordenProductoNoCobrado()), true)
})

// ── D6 ──────────────────────────────────────────────────────────────────────
test('D6 · depósito agrupado: el aporte de esta orden no es el total', () => {
  const agrupado: DepositoRegistrado = {
    ...depStorkhub,
    montoTotal: 450,
    solicitudIds: ['A', 'B', 'C', 'D', 'OxGVVg3HYP0If3NSOqAI'],
  }
  const l = linea(ordenTodoCobrado(), { storkhub: agrupado })
  assert.equal(l.esAgrupado, true)
  assert.equal(l.ordenesEnDeposito, 5)
  // Lo que aporta esta orden sale de calcularDeposito, no del total.
  assert.equal(l.obligacion, 110)
  assert.equal(l.deposito?.montoTotal, 450)
  assert.notEqual(l.obligacion, l.deposito?.montoTotal)
})

test('D6b · depósito de una sola orden no se marca como agrupado', () => {
  const l = linea(ordenTodoCobrado(), { storkhub: depStorkhub })
  assert.equal(l.esAgrupado, false)
  assert.equal(l.ordenesEnDeposito, 1)
  assert.equal(l.obligacion, 110)
  assert.equal(l.deposito?.montoTotal, 110)
})

// ── D7 ──────────────────────────────────────────────────────────────────────
test('D7 · sin boucher no se inventa uno', () => {
  const sinBoucher: DepositoRegistrado = { ...depStorkhub, boucher: null }
  assert.equal(linea(ordenTodoCobrado(), { storkhub: sinBoucher }).deposito?.boucher, null)
  // Documento sin el campo boucher del todo, no solo en null.
  const faltante: DepositoRegistrado = { id: depStorkhub.id, estado: 'confirmado', montoTotal: 110 }
  assert.equal(linea(ordenTodoCobrado(), { storkhub: faltante }).deposito?.boucher, undefined)
})

// ── D8 ──────────────────────────────────────────────────────────────────────
test('D8 · documento legacy sin registro.deposito', () => {
  const ls = lineasDeposito({ cobroContraEntrega: { aplica: false }, confirmacion: { precioFinalCordobas: 0 } })
  assert.equal(ls.length, 2)
  assert.equal(ls.every((l) => l.deposito === null && l.confirmado === false), true)
})

test('D8b · documento vacío no revienta', () => {
  assert.equal(lineasDeposito({}).length, 2)
  assert.equal(tieneObligacionDeposito({}), false)
  assert.deepEqual(idsDepositoDeOrden({}), [])
})

test('D8c · solicitudIds ausente o no-array no rompe el conteo', () => {
  const raro = { ...depStorkhub, solicitudIds: null }
  const l = linea(ordenTodoCobrado(), { storkhub: raro })
  assert.equal(l.ordenesEnDeposito, 0)
  assert.equal(l.esAgrupado, false)
})

// ── IDs y estados ───────────────────────────────────────────────────────────
test('IDs · se extraen los dos punteros de registro.deposito', () => {
  assert.deepEqual(idsDepositoDeOrden(ordenTodoCobrado()), [
    { destino: 'storkhub', id: 'jF4c3L6AGmzpq9L99dXQ' },
    { destino: 'comercio', id: 'gJf1rVEdZaMpTpYKRaDM' },
  ])
  // Máximo dos lecturas por ficha.
  assert.ok(idsDepositoDeOrden(ordenTodoCobrado()).length <= 2)
})

test('IDs · sin punteros no hay lecturas que hacer', () => {
  assert.deepEqual(idsDepositoDeOrden(ordenProductoNoCobrado()), [])
})

test('ESTADOS · los seis reales del módulo Depósitos', () => {
  assert.equal(etiquetaEstadoDeposito('pendiente_boucher'), 'Esperando comprobante')
  assert.equal(etiquetaEstadoDeposito('en_revision'), 'En revisión')
  assert.equal(etiquetaEstadoDeposito('confirmado'), 'Confirmado')
  assert.equal(etiquetaEstadoDeposito('rechazado'), 'Rechazado')
  assert.equal(etiquetaEstadoDeposito('convertido_en_deuda'), 'Convertido en deuda')
  assert.equal(etiquetaEstadoDeposito('anulado'), 'Anulado')
  // Un estado desconocido se muestra tal cual, no se oculta.
  assert.equal(etiquetaEstadoDeposito('futuro_estado'), 'futuro_estado')
  assert.equal(etiquetaEstadoDeposito(undefined), 'Sin estado')
})

test('CONFIRMADO · refleja los flags de la propia orden', () => {
  const ls = lineasDeposito(ordenTodoCobrado(), { storkhub: depStorkhub, comercio: depComercio })
  assert.equal(ls.every((l) => l.confirmado), true)
  assert.equal(ls.every((l) => l.clave === 'registrado'), true)
  assert.equal(ls.find((l) => l.destino === 'comercio')!.obligacion, 1000)
})

// ─── FIN-SEMANTICA-UX-1 · resumenDepositoOrden ────────────────────────────────
//
// Lo que estos casos defienden: la columna DEPOSITADO no puede afirmar una
// deuda donde la obligación es 0, ni llamar "confirmado" a un depósito que el
// motorizado nunca pagó.

/** Orden sin cobro contra entrega: el motorizado solo recauda el delivery. */
function ordenSoloDelivery(over: Partial<EntradaDepositoOrden> = {}): EntradaDepositoOrden {
  return {
    cobroContraEntrega: { aplica: false, monto: 0 },
    confirmacion: { precioFinalCordobas: 110 },
    pagoDelivery: { quienPaga: 'entrega', deducirDelCobroContraEntrega: false },
    tipoServicio: 'normal',
    tipoCliente: 'contado',
    cobrosMotorizado: { delivery: { recibio: true } },
    registro: null,
    ...over,
  }
}

const depositoCon = (estado: string, over: Partial<DepositoRegistrado> = {}): DepositoRegistrado => ({
  id: 'DEP_' + estado,
  estado,
  solicitudIds: ['una'],
  ...over,
})

test('R1 · obligación 0 no se presenta como pendiente', () => {
  // El comercio no espera nada: no hubo cobro contra entrega.
  const r = resumenDepositoOrden(ordenSoloDelivery())
  const comercio = r.lineas.find((l) => l.destino === 'comercio')!
  assert.equal(comercio.obligacion, 0)
  assert.equal(comercio.clave, 'no_corresponde')
  assert.equal(comercio.texto, 'No corresponde')
  assert.equal(r.relevantes.some((l) => l.destino === 'comercio'), false, 'el comercio entró como línea relevante')
})

test('R2 · obligación > 0 sin depósito ⇒ pendiente', () => {
  const r = resumenDepositoOrden(ordenSoloDelivery())
  const storkhub = r.lineas.find((l) => l.destino === 'storkhub')!
  assert.equal(storkhub.obligacion, 110)
  assert.equal(storkhub.clave, 'sin_deposito')
  assert.equal(r.etiqueta, 'Pendiente de depósito')
})

test('R3 · depósito confirmado ⇒ Confirmado', () => {
  const r = resumenDepositoOrden(ordenSoloDelivery(), { storkhub: depositoCon('confirmado') })
  assert.equal(r.etiqueta, 'Confirmado')
  assert.equal(r.lineas.find((l) => l.destino === 'storkhub')!.clave, 'registrado')
})

test('R4 · depósito en revisión ⇒ En revisión', () => {
  assert.equal(resumenDepositoOrden(ordenSoloDelivery(), { storkhub: depositoCon('en_revision') }).etiqueta, 'En revisión')
})

test('R5 · pendiente_boucher ⇒ Esperando comprobante', () => {
  assert.equal(resumenDepositoOrden(ordenSoloDelivery(), { storkhub: depositoCon('pendiente_boucher') }).etiqueta, 'Esperando comprobante')
})

test('R6 · convertido_en_deuda ⇒ Convertido en deuda, NUNCA confirmado', () => {
  // El caso que motivó el bloque: convertirDepositoEnDeuda() escribe el mismo
  // confirmadoStorkhubAt que una confirmación real. Si el resumen mirase ese
  // flag, diría "Confirmado" sobre dinero que nunca llegó.
  const orden = ordenSoloDelivery({
    registro: { deposito: { confirmadoStorkhub: true, storkhubDepositoId: 'DEP_deuda' } },
  })
  const r = resumenDepositoOrden(orden, { storkhub: depositoCon('convertido_en_deuda') })
  assert.equal(r.etiqueta, 'Convertido en deuda')
  assert.notEqual(r.etiqueta, 'Confirmado')
  // El flag sigue en true en el documento: se conserva el dato, no se cree.
  assert.equal(r.lineas.find((l) => l.destino === 'storkhub')!.confirmado, true)
})

test('R7 · anulado y rechazado ⇒ su etiqueta real', () => {
  // `revertido` NO es un estado de ordenes_deposito: pertenece a
  // cobroDelivery. revertirConversionEnDeuda() deja el depósito en 'anulado'
  // cuando no hay boucher, y en 'en_revision' cuando sí lo hay.
  assert.equal(resumenDepositoOrden(ordenSoloDelivery(), { storkhub: depositoCon('anulado') }).etiqueta, 'Anulado')
  assert.equal(resumenDepositoOrden(ordenSoloDelivery(), { storkhub: depositoCon('rechazado') }).etiqueta, 'Rechazado')
  // Un estado desconocido se muestra crudo, no se le inventa etiqueta.
  assert.equal(resumenDepositoOrden(ordenSoloDelivery(), { storkhub: depositoCon('futuro_x') }).etiqueta, 'futuro_x')
})

test('R8 · yomoyxzBvljBwiEkwhaI: ni deuda con el comercio ni cobro confirmado', () => {
  // Documento real de staging. Base pintaba "⏳ Comercio + ✓ Storkhub":
  // una deuda inexistente y un cobro que en realidad es deuda del motorizado.
  const real: EntradaDepositoOrden = {
    cobroContraEntrega: { aplica: false, monto: 0 },
    confirmacion: { precioFinalCordobas: 110 },
    pagoDelivery: { quienPaga: 'entrega', deducirDelCobroContraEntrega: false },
    tipoServicio: 'normal',
    tipoCliente: 'contado',
    cobrosMotorizado: { delivery: { recibio: true } },
    registro: {
      deposito: { confirmadoStorkhub: true, storkhubDepositoId: 'D7oaBo4rr6yFYmoufOZV' },
    },
  }
  const dep = depositoCon('convertido_en_deuda', {
    id: 'D7oaBo4rr6yFYmoufOZV',
    montoTotal: 110,
    notaConversion: 'no los pago el motorizado',
    solicitudIds: ['yomoyxzBvljBwiEkwhaI'],
  })
  const r = resumenDepositoOrden(real, { storkhub: dep })

  const comercio = r.lineas.find((l) => l.destino === 'comercio')!
  assert.equal(comercio.clave, 'no_corresponde', 'sigue insinuando una deuda con el comercio')
  assert.equal(comercio.obligacion, 0)

  const storkhub = r.lineas.find((l) => l.destino === 'storkhub')!
  assert.equal(storkhub.clave, 'registrado')
  assert.equal(storkhub.texto, 'Convertido en deuda')
  assert.equal(r.relevantes.length, 1, 'solo StorkHub tiene algo que decir')
  assert.equal(r.etiqueta, 'Convertido en deuda')
})

test('R9 · las dos líneas discrepan ⇒ Parcial', () => {
  const r = resumenDepositoOrden(ordenTodoCobrado(), {
    storkhub: depositoCon('confirmado'),
    comercio: null,
  })
  assert.equal(r.relevantes.length, 2)
  assert.equal(r.etiqueta, ETIQUETA_RESUMEN_MIXTO)
})

test('R10 · toda etiqueta esperable está en la lista del filtro', () => {
  // Si alguien añade un estado y olvida la lista, el desplegable dejaría de
  // poder seleccionarlo. Los estados declarados en EstadoDeposito son seis.
  const estados = ['pendiente_boucher', 'en_revision', 'confirmado', 'rechazado', 'convertido_en_deuda', 'anulado']
  for (const e of estados) {
    const et = resumenDepositoOrden(ordenSoloDelivery(), { storkhub: depositoCon(e) }).etiqueta
    assert.ok(ETIQUETAS_RESUMEN_DEPOSITO.includes(et), `"${et}" falta en ETIQUETAS_RESUMEN_DEPOSITO`)
  }
  assert.ok(ETIQUETAS_RESUMEN_DEPOSITO.includes(resumenDepositoOrden(ordenSoloDelivery()).etiqueta))
  assert.ok(ETIQUETAS_RESUMEN_DEPOSITO.includes(resumenDepositoOrden(ordenSoloDelivery({ cobrosMotorizado: { delivery: { recibio: false } } })).etiqueta))
})

// ─── TRAZABILIDAD-DINERO-UX-1 · depositoVisible ──────────────────────────────
//
// El caso de referencia es SH-0001 en staging: entregada, delivery C$110
// cobrado en efectivo por el motorizado, y ningún depósito registrado todavía.

test('T1 · SH-0001: cobrado y sin depósito ⇒ pendiente, lo tiene el motorizado', () => {
  const dv = depositoVisible(ordenSoloDelivery())
  assert.equal(dv.lineas.length, 1)
  const l = dv.lineas[0]
  assert.equal(l.destino, 'storkhub')
  assert.equal(l.obligacion, 110)
  assert.equal(l.clave, 'pendiente')
  assert.equal(l.texto, 'Pendiente de depósito')
  assert.equal(l.responsable, 'Motorizado')
  assert.equal(dv.pendiente, true, 'SH-0001 se leyó como cerrada')
  assert.equal(dv.desconocido, false)
  assert.equal(dv.resumen, 'Pendiente · Motorizado')
})

test('T2 · puntero sin documento ⇒ "registrado", NUNCA una deuda inventada', () => {
  // Es el caso que obligaba a los drawers a callar: con `{}`, lineasDeposito()
  // dice "Pendiente de depósito" sobre un depósito que ya existe.
  const orden = ordenSoloDelivery({ registro: { deposito: { storkhubDepositoId: 'DEP_x' } } })
  const dv = depositoVisible(orden)
  assert.equal(dv.lineas[0].clave, 'registrado_sin_detalle')
  assert.equal(dv.lineas[0].texto, TEXTO_DEPOSITO_SIN_DETALLE)
  assert.equal(dv.lineas[0].responsable, null)
  assert.equal(dv.pendiente, false, 'afirmó una deuda sin haber leído el depósito')
  assert.equal(dv.desconocido, true)
  assert.equal(dv.resumen, 'Registrado')
})

test('T3 · confirmadoStorkhub no sustituye al documento', () => {
  // Convertir en deuda escribe el mismo flag que confirmar: no prueba nada.
  const orden = ordenSoloDelivery({
    registro: { deposito: { storkhubDepositoId: 'DEP_x', confirmadoStorkhub: true } },
  })
  const dv = depositoVisible(orden)
  assert.equal(dv.lineas[0].clave, 'registrado_sin_detalle')
  assert.notEqual(dv.resumen, 'Confirmado · StorkHub')
})

test('T4 · depósito confirmado ⇒ Confirmado · StorkHub, sin pendiente', () => {
  const orden = ordenSoloDelivery({ registro: { deposito: { storkhubDepositoId: 'DEP_ok' } } })
  const dv = depositoVisible(orden, { storkhub: depositoCon('confirmado', { id: 'DEP_ok' }) })
  assert.equal(dv.lineas[0].clave, 'registrado')
  assert.equal(dv.lineas[0].estado, 'confirmado')
  assert.equal(dv.pendiente, false)
  assert.equal(dv.desconocido, false)
  assert.equal(dv.resumen, 'Confirmado · StorkHub')
})

test('T5 · convertido_en_deuda ⇒ abierto, nunca confirmado', () => {
  const orden = ordenSoloDelivery({
    registro: { deposito: { storkhubDepositoId: 'DEP_d', confirmadoStorkhub: true } },
  })
  const dv = depositoVisible(orden, { storkhub: depositoCon('convertido_en_deuda', { id: 'DEP_d' }) })
  assert.equal(dv.resumen, 'Convertido en deuda')
  assert.equal(dv.pendiente, true)
})

test('T6 · en revisión y esperando comprobante siguen abiertos', () => {
  for (const [estado, texto] of [['en_revision', 'En revisión'], ['pendiente_boucher', 'Esperando comprobante']] as const) {
    const orden = ordenSoloDelivery({ registro: { deposito: { storkhubDepositoId: 'D' } } })
    const dv = depositoVisible(orden, { storkhub: depositoCon(estado, { id: 'D' }) })
    assert.equal(dv.resumen, texto)
    assert.equal(dv.pendiente, true, `${estado} se leyó como cerrado`)
  }
})

test('T7 · sin obligación ⇒ No corresponde, sin líneas y sin pendiente', () => {
  // quienPaga transferencia: el motorizado no toca ese dinero.
  const orden = ordenSoloDelivery({ pagoDelivery: { quienPaga: 'transferencia', deducirDelCobroContraEntrega: false } })
  assert.equal(lineasDeposito(orden).every((l) => l.obligacion === 0), true, 'precondición: la orden no debe generar obligación')
  const dv = depositoVisible(orden)
  assert.deepEqual(dv.lineas, [])
  assert.equal(dv.pendiente, false)
  assert.equal(dv.desconocido, false)
  assert.equal(dv.resumen, 'No corresponde')
})

test('T8 · depositosDesdeCache indexa por el puntero de la orden', () => {
  const orden = ordenSoloDelivery({ registro: { deposito: { storkhubDepositoId: 'A', comercioDepositoId: 'B' } } })
  const dep = depositoCon('confirmado', { id: 'A' })
  const m = depositosDesdeCache(orden, { A: dep })
  assert.equal(m.storkhub, dep)
  assert.equal(m.comercio, null, 'un depósito no leído debe quedar en null, no inventarse')
})
