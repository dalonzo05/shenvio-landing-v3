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
