// COBROS-PAGO-INTEGRIDAD-1 — guards de cobro y depósito, y reversión tipo C.
//
// Fixture: SH-0003 (OZmiYGHAlUBaAzY4yn9I), delivery C$80 pagado por
// transferencia, con DEP-0002 (a2HgEC7RcMkgREr4HGD1) tipo C confirmado.
// SH-0001 / DEP-0001 como caso tipo A que la reversión NO debe tocar.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  puedeConfirmarCobro,
  puedeMutarBoucherCobro,
  asegurarCobroConfirmable,
  asegurarBoucherCobroMutable,
  puedeMutarBoucherDeposito,
  asegurarBoucherDepositoMutable,
  camposReversionCobro,
  planReversionDeposito,
  camposAnulacionDeposito,
  MSG_COBRO_YA_PAGADO,
  MSG_DEPOSITO_CONFIRMADO,
  MOTIVO_ANULACION_REVERSION,
} from './cobro-integridad'
import { resumenDepositosMotorizado } from './depositos-motorizado'
import { depositoVisible, type EntradaDepositoOrden } from './deposito-orden'

const DEP_C = 'a2HgEC7RcMkgREr4HGD1'
const DEP_A = 'P4IMui3ILjs0P9U6eDgT'
const ADMIN = 'RKTw1pLfK5O8Y3A6IIwDU8J3yr43'
const BORRAR = { __deleteField: true }

/** updateDoc con rutas punteadas; `BORRAR` elimina la clave. */
function aplicar<T>(obj: T, campos: Record<string, unknown>): T {
  const copia = JSON.parse(JSON.stringify(obj))
  for (const [ruta, valor] of Object.entries(campos)) {
    const partes = ruta.split('.')
    let nodo = copia
    for (const p of partes.slice(0, -1)) {
      if (nodo[p] == null || typeof nodo[p] !== 'object') nodo[p] = {}
      nodo = nodo[p]
    }
    const hoja = partes[partes.length - 1]
    if (valor === BORRAR) delete nodo[hoja]
    else nodo[hoja] = valor
  }
  return copia
}

function sh0003() {
  return {
    estado: 'entregado',
    tipoCliente: 'contado',
    confirmacion: { precioFinalCordobas: 80 },
    pagoDelivery: { quienPaga: 'transferencia', montoSugerido: 80, deducirDelCobroContraEntrega: false, tipo: 'contado' },
    cobroContraEntrega: { aplica: false, monto: 0 },
    cobroDelivery: {
      estado: 'pagado', monto: 80, formaPago: 'transferencia', quienPaga: 'transferencia',
      pagadoAt: 'T', confirmadoAt: 'T', confirmadoPor: ADMIN,
      boucherComercio: { url: 'u', path: 'p', at: 'T0' }, boucherVigente: 'comercio',
    },
    registro: { deposito: { storkhubDepositoId: DEP_C, confirmadoStorkhub: true, confirmadoStorkhubAt: 'T' } },
  }
}

// ── Confirmación ─────────────────────────────────────────────────────────────

test('I1 · un cobro pendiente se puede confirmar', () => {
  assert.equal(puedeConfirmarCobro({ estado: 'pendiente' }), true)
  assert.doesNotThrow(() => asegurarCobroConfirmable({ estado: 'pendiente' }))
  // Sin cobroDelivery todavía (el flujo lo crea al confirmar).
  assert.equal(puedeConfirmarCobro(undefined), true)
})

test('I2 · un cobro en revisión se puede confirmar', () => {
  assert.equal(puedeConfirmarCobro({ estado: 'en_revision_deposito' }), true)
})

test('I3 · P0 · un cobro pagado NO se confirma otra vez: el writer se detiene', () => {
  assert.equal(puedeConfirmarCobro(sh0003().cobroDelivery), false)
  assert.throws(() => asegurarCobroConfirmable(sh0003().cobroDelivery), { message: MSG_COBRO_YA_PAGADO })
})

test('I4 · P0 · un cobro pagado NO permite quitar ni reemplazar el boucher', () => {
  assert.equal(puedeMutarBoucherCobro({ estado: 'pagado' }), false)
  assert.throws(() => asegurarBoucherCobroMutable({ estado: 'pagado' }), { message: MSG_COBRO_YA_PAGADO })
  // Abierto: sí.
  assert.equal(puedeMutarBoucherCobro({ estado: 'en_revision_deposito' }), true)
  assert.equal(puedeMutarBoucherCobro({ estado: 'pendiente' }), true)
})

test('I5 · no hay segundo DEP ni segundo movimiento: el guard corta antes de escribir', () => {
  // El writer arma DEP + orden + movimiento solo si el guard pasa. Se simula
  // el orden real: guard → escrituras.
  const escrituras: string[] = []
  const confirmar = (cobro: { estado?: string }) => {
    asegurarCobroConfirmable(cobro)
    escrituras.push('dep', 'orden', 'movimiento')
  }
  confirmar({ estado: 'en_revision_deposito' })
  assert.throws(() => confirmar({ estado: 'pagado' }))
  assert.deepEqual(escrituras, ['dep', 'orden', 'movimiento'])
})

// ── Depósito ─────────────────────────────────────────────────────────────────

test('I6 · P0 · el boucher de un depósito confirmado no se reemplaza', () => {
  assert.equal(puedeMutarBoucherDeposito('confirmado'), false)
  assert.throws(() => asegurarBoucherDepositoMutable('confirmado'), { message: MSG_DEPOSITO_CONFIRMADO })
  for (const e of ['pendiente_boucher', 'en_revision', 'rechazado']) {
    assert.equal(puedeMutarBoucherDeposito(e), true, e)
  }
})

// ── Reversión tipo C ─────────────────────────────────────────────────────────

test('I7 · revertir limpia el cobro: pendiente, sin fecha ni medio, con rastro del movimiento', () => {
  const r = aplicar(sh0003(), camposReversionCobro(BORRAR, 'm0ghwTki83olybjCQuGX'))
  assert.equal(r.cobroDelivery.estado, 'pendiente')
  assert.equal('pagadoAt' in r.cobroDelivery, false)
  assert.equal('formaPago' in r.cobroDelivery, false)
  assert.equal((r.cobroDelivery as Record<string, unknown>).movimientoPagoId, 'm0ghwTki83olybjCQuGX')
  // La evidencia del comercio no se toca.
  assert.equal(r.cobroDelivery.boucherComercio.url, 'u')
})

test('I8 · P0 · revertir tipo C: el DEP-C se anula y la orden queda sin puntero ni confirmación', () => {
  const plan = planReversionDeposito(DEP_C, { id: DEP_C, tipo: 'pago_delivery_deposito', estado: 'confirmado' })
  assert.equal(plan.anularDepositoId, DEP_C)
  const r = aplicar(sh0003(), plan.camposOrden)
  assert.equal(r.registro.deposito.storkhubDepositoId, null)
  assert.equal(r.registro.deposito.confirmadoStorkhub, false)
  assert.equal(r.registro.deposito.confirmadoStorkhubAt, null)
  // Ya no queda una liquidación visible sobre un cobro pendiente.
  assert.equal(depositoVisible(r as EntradaDepositoOrden).lineas.length, 0)
})

test('I9 · el DEP-C no se borra: pasa a "anulado" con quién, cuándo y por qué', () => {
  const c = camposAnulacionDeposito(ADMIN, 'TS', MOTIVO_ANULACION_REVERSION)
  assert.deepEqual(c, { estado: 'anulado', anuladoAt: 'TS', anuladoPorUid: ADMIN, motivoAnulacion: MOTIVO_ANULACION_REVERSION })
  // Sin sesión no se inventa actor.
  assert.equal('anuladoPorUid' in camposAnulacionDeposito(undefined, 'TS', 'x'), false)
  // No toca el boucher: la evidencia queda.
  assert.equal('boucher' in c || 'boucherUrl' in c, false)
})

test('I10 · revertir no toca un depósito del motorizado (tipo A): es otro dinero', () => {
  const plan = planReversionDeposito(DEP_A, { id: DEP_A, tipo: 'recaudacion_motorizado_storkhub', estado: 'confirmado' })
  assert.deepEqual(plan, { anularDepositoId: null, camposOrden: {} })
})

test('I11 · sin puntero, puntero colgando o documento distinto: no se toca nada', () => {
  const nada = { anularDepositoId: null, camposOrden: {} }
  assert.deepEqual(planReversionDeposito(null, null), nada)
  assert.deepEqual(planReversionDeposito(DEP_C, null), nada)
  assert.deepEqual(planReversionDeposito(DEP_C, { id: 'otro', tipo: 'pago_delivery_deposito', estado: 'confirmado' }), nada)
})

test('I12 · DEP-C ya anulado: no se anula dos veces, pero la orden se libera', () => {
  const plan = planReversionDeposito(DEP_C, { id: DEP_C, tipo: 'pago_delivery_deposito', estado: 'anulado' })
  assert.equal(plan.anularDepositoId, null)
  assert.equal(plan.camposOrden['registro.deposito.storkhubDepositoId'], null)
})

test('I13 · la reversión no crea deuda para el motorizado (no cobró este delivery)', () => {
  const plan = planReversionDeposito(DEP_C, { id: DEP_C, tipo: 'pago_delivery_deposito', estado: 'confirmado' })
  const r = aplicar(sh0003(), { ...camposReversionCobro(BORRAR, 'm'), ...plan.camposOrden })
  const res = resumenDepositosMotorizado([r as EntradaDepositoOrden])
  assert.equal(res.pendiente.total + res.enRevision.total, 0)
})
