// PAGO-TRANSFERENCIA-UX-1 — semántica del pago del delivery por transferencia.
//
// Fixtures reales de staging:
//   SH-0003 (OZmiYGHAlUBaAzY4yn9I): delivery C$80, plan transferencia, boucher
//     del comercio 04:14:37Z, confirmado 04:20:53Z; DEP-0002 tipo C con
//     creadoAt = confirmadoAt (nace al confirmar).
//   SH-0001: efectivo cobrado por el motorizado, sin pagadoAt (Function).

import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  OPCION_PLAN_TRANSFERENCIA,
  esPlanTransferencia,
  estadoPagoTransferencia,
  avisoNoCobrarMotorizado,
  descripcionCobroMotorizado,
  montoAsociadoDeposito,
  momentosDeposito,
  enviadoDeposito,
  enviadoDepositoHistorial,
  momentoCobro,
  resumenAtencionCobros,
  accionesAdminDeposito,
  etiquetaDeliveryMotorizado,
} from './pago-transferencia'
import type { DepositoRegistrado } from './deposito-orden'
import { calcularDeposito } from './calculo-deposito'

const BOUCHER_AT = '2026-09-18T04:14:37.627Z'
const CONFIRMADO_AT = '2026-09-18T04:20:53.728Z'

function sh0003(estado = 'pagado') {
  return {
    pagoDelivery: { quienPaga: 'transferencia' },
    confirmacion: { precioFinalCordobas: 80 },
    cobroDelivery: {
      estado, monto: 80, formaPago: 'transferencia', quienPaga: 'transferencia',
      pagadoAt: estado === 'pagado' ? CONFIRMADO_AT : undefined,
      boucherVigente: 'comercio', boucherComercio: { at: BOUCHER_AT },
    },
  }
}

const DEP_0002: DepositoRegistrado = {
  id: 'a2HgEC7RcMkgREr4HGD1', codigo: 'DEP-0002', tipo: 'pago_delivery_deposito', estado: 'confirmado',
  destinatario: 'storkhub', solicitudIds: ['OZmiYGHAlUBaAzY4yn9I'], montoTotal: 80,
  boucherUrl: 'https://example.test/c.jpg', creadoAt: CONFIRMADO_AT, confirmadoAt: CONFIRMADO_AT,
}
const DEP_0001: DepositoRegistrado = {
  id: 'P4IMui3ILjs0P9U6eDgT', codigo: 'DEP-0001', tipo: 'recaudacion_motorizado_storkhub', estado: 'confirmado',
  destinatario: 'storkhub', solicitudIds: ['jTIJLEhGeACcymBAj0jY'], montoTotal: 110,
  creadoAt: '2026-09-17T23:24:40.777Z', confirmadoAt: '2026-09-18T01:03:05.221Z',
}

// ── Plan ≠ pago ──────────────────────────────────────────────────────────────

test('X1 · la opción del plan nunca afirma un pago hecho', () => {
  for (const o of [OPCION_PLAN_TRANSFERENCIA.gestor, OPCION_PLAN_TRANSFERENCIA.comercio]) {
    const t = `${o.label} ${o.desc}`.toLowerCase()
    assert.equal(/ya se pag|pagado previamente|pago realizado/.test(t), false, t)
    assert.match(t, /no cobrar/)
    assert.match(t, /comprobante/)
  }
})

test('X2 · plan transferencia con cobro pendiente NO es un pago', () => {
  const o = sh0003('pendiente')
  assert.equal(esPlanTransferencia(o), true)
  assert.equal(estadoPagoTransferencia(o.cobroDelivery).clave, 'pendiente')
})

// ── Estados del comercio ─────────────────────────────────────────────────────

test('X3 · pendiente → "Pendiente de pago"; en revisión nunca dice "pendiente"', () => {
  assert.equal(estadoPagoTransferencia({ estado: 'pendiente' }).clave, 'pendiente')
  assert.equal(estadoPagoTransferencia(undefined).clave, 'pendiente')
  const rev = estadoPagoTransferencia({ estado: 'en_revision_deposito' })
  assert.equal(rev.clave, 'en_revision')
  assert.equal(/pendiente/i.test(`${rev.titulo} ${rev.detalle}`), false)
  assert.equal(estadoPagoTransferencia({ estado: 'pagado' }).clave, 'pagado')
})

test('X4 · un estado que el modelo no tiene no se convierte en "rechazado"', () => {
  assert.equal(estadoPagoTransferencia({ estado: 'no_cobrar' }).clave, 'otro')
})

// ── Motorizado ───────────────────────────────────────────────────────────────

test('X5 · SH-0003: NO COBRAR con el monto real; en efectivo no hay aviso', () => {
  const a = avisoNoCobrarMotorizado(sh0003('pendiente'))!
  assert.equal(a.titulo, 'NO COBRAR ESTE DELIVERY')
  assert.match(a.detalle, /C\$ 80/)
  assert.match(a.detalle, /StorkHub/)
  assert.equal(avisoNoCobrarMotorizado({ pagoDelivery: { quienPaga: 'entrega' }, confirmacion: { precioFinalCordobas: 110 } }), null)
})

test('X6 · descripción: sin pasado falso antes de entregar; en historial sin afirmar el pago', () => {
  const d = 'Delivery ya pagado por transferencia · No recaudó efectivo'
  assert.equal(descripcionCobroMotorizado(d, true, 'operacion'), '')
  const h = descripcionCobroMotorizado(d, true, 'historial')
  assert.match(h, /No cobrado por el motorizado/)
  assert.equal(/ya pagado/.test(h), false)
  // Otras partes se conservan; sin transferencia no se toca nada.
  assert.equal(descripcionCobroMotorizado('Cobró producto C$500 · Delivery ya pagado por transferencia', true, 'operacion'), 'Cobró producto C$500')
  assert.equal(descripcionCobroMotorizado('Cobró delivery C$110', false, 'operacion'), 'Cobró delivery C$110')
})

// ── Tipo C: monto y momentos ─────────────────────────────────────────────────

test('X7 · tipo C: "Pago de esta orden: C$80", nunca "aporta C$0"', () => {
  const m = montoAsociadoDeposito(DEP_0002, sh0003(), 0)
  assert.deepEqual(m, { etiqueta: 'Pago de esta orden', monto: 80 })
  // Sin cobroDelivery.monto: el precio confirmado, que es de donde nace.
  assert.equal(montoAsociadoDeposito(DEP_0002, { confirmacion: { precioFinalCordobas: 80 } }, 0).monto, 80)
})

test('X8 · tipo A/B: sin regresión, sigue siendo la obligación de efectivo', () => {
  assert.deepEqual(montoAsociadoDeposito(DEP_0001, null, 110), { etiqueta: 'Esta orden aporta', monto: 110 })
})

test('X9 · tipo C: "Comprobante enviado" del boucher y "Pago confirmado"; nunca "Enviado" = creadoAt', () => {
  const m = momentosDeposito(DEP_0002, sh0003())
  assert.deepEqual(m, [
    { etiqueta: 'Comprobante enviado', valor: BOUCHER_AT },
    { etiqueta: 'Pago confirmado', valor: CONFIRMADO_AT },
  ])
  // Sin la orden no hay envío demostrable.
  assert.deepEqual(momentosDeposito(DEP_0002), [{ etiqueta: 'Pago confirmado', valor: CONFIRMADO_AT }])
  assert.equal(enviadoDeposito(DEP_0002), null)
  assert.equal(enviadoDeposito(DEP_0002, sh0003()), BOUCHER_AT)
})

test('X10 · tipo A: "Enviado" y "Confirmado" como antes', () => {
  assert.deepEqual(momentosDeposito(DEP_0001).map((x) => x.etiqueta), ['Enviado', 'Confirmado'])
  assert.equal(enviadoDeposito(DEP_0001), '2026-09-17T23:24:40.777Z')
})

// ── Cobros ───────────────────────────────────────────────────────────────────

test('X11 · efectivo del motorizado (SH-0001): la fecha sale de registradoAt', () => {
  const sh0001 = { cobroDelivery: { estado: 'pagado', formaPago: 'efectivo', registradoAt: '2026-09-13T17:46:11.338Z' } }
  assert.equal(momentoCobro(sh0001), '2026-09-13T17:46:11.338Z')
  // Fallback: el cobro del motorizado.
  assert.equal(momentoCobro({ cobroDelivery: { estado: 'pagado', formaPago: 'efectivo' }, cobrosMotorizado: { delivery: { at: 'T' } } }), 'T')
})

test('X12 · transferencia: la fecha es la de la confirmación (pagadoAt); sin pagar, nada', () => {
  assert.equal(momentoCobro(sh0003()), CONFIRMADO_AT)
  assert.equal(momentoCobro(sh0003('en_revision_deposito')), null)
  // Pagado sin ninguna fuente: no se inventa.
  assert.equal(momentoCobro({ cobroDelivery: { estado: 'pagado', formaPago: 'transferencia' } }), null)
})

test('X13 · alerta de Cobros: en revisión y esperando comprobante, con monto', () => {
  const r = resumenAtencionCobros([
    sh0003('en_revision_deposito'),
    sh0003('pendiente'),
    sh0003('pagado'),
    { pagoDelivery: { quienPaga: 'entrega' }, cobroDelivery: { estado: 'pendiente', monto: 110 } },
  ])
  assert.deepEqual(r, { total: 2, monto: 160, enRevision: 1, esperandoComprobante: 1 })
})

// ── Acciones de admin ────────────────────────────────────────────────────────

test('X14 · Rehacer / Eliminar: solo admin, nunca sobre un DEP tipo C', () => {
  assert.deepEqual(accionesAdminDeposito(DEP_0001, 'admin'), { rehacer: true, eliminar: true })
  assert.deepEqual(accionesAdminDeposito(DEP_0001, 'gestor'), { rehacer: false, eliminar: false })
  assert.deepEqual(accionesAdminDeposito(DEP_0001, 'digitador'), { rehacer: false, eliminar: false })
  assert.deepEqual(accionesAdminDeposito(DEP_0002, 'admin'), { rehacer: false, eliminar: false })
  assert.deepEqual(accionesAdminDeposito({ ...DEP_0001, estado: 'convertido_en_deuda' }, 'admin'), { rehacer: false, eliminar: true })
})

// ── Historial de Depósitos: columna "Enviado" ────────────────────────────────

const soloSH0003 = (id: string) => (id === 'OZmiYGHAlUBaAzY4yn9I' ? sh0003() : undefined)

test('X15 · Historial tipo A: "Enviado" sigue siendo el envío del motorizado', () => {
  assert.equal(enviadoDepositoHistorial(DEP_0001, () => undefined), '2026-09-17T23:24:40.777Z')
  assert.equal(enviadoDepositoHistorial(DEP_0001, soloSH0003), enviadoDeposito(DEP_0001))
})

test('X16 · Historial tipo C con una orden: la subida del comprobante del comercio (DEP-0002 22:14)', () => {
  assert.equal(enviadoDepositoHistorial(DEP_0002, soloSH0003), BOUCHER_AT)
})

test('X17 · Historial tipo C sin timestamp del comprobante, o sin la orden cargada: "—"', () => {
  const sinAt = () => ({ ...sh0003(), cobroDelivery: { ...sh0003().cobroDelivery, boucherComercio: { at: undefined } } })
  assert.equal(enviadoDepositoHistorial(DEP_0002, sinAt), null)
  const sinBoucher = () => ({ ...sh0003(), cobroDelivery: { ...sh0003().cobroDelivery, boucherComercio: null } })
  assert.equal(enviadoDepositoHistorial(DEP_0002, sinBoucher), null)
  assert.equal(enviadoDepositoHistorial(DEP_0002, () => undefined), null)
})

test('X18 · Historial tipo C multiorden: sin instante único, "—" (no elige ninguno)', () => {
  const multi = { ...DEP_0002, solicitudIds: ['OZmiYGHAlUBaAzY4yn9I', 'otra'] }
  assert.equal(enviadoDepositoHistorial(multi, () => sh0003()), null)
  assert.equal(enviadoDepositoHistorial({ ...DEP_0002, solicitudIds: [] }, () => sh0003()), null)
})

test('X19 · Historial tipo C: nunca usa creadoAt ni confirmadoAt del DEP como envío', () => {
  const sinAt = () => ({ ...sh0003(), cobroDelivery: { ...sh0003().cobroDelivery, boucherComercio: null } })
  for (const b of [soloSH0003, sinAt, () => undefined]) {
    const v = enviadoDepositoHistorial(DEP_0002, b)
    assert.notEqual(v, DEP_0002.creadoAt)
    assert.notEqual(v, DEP_0002.confirmadoAt)
  }
})

// ── MOTORIZADO-UX-OPERATIVA-1 · CobroBox con transferencia ───────────────────

test('X20 · transferencia: "Delivery · Lo paga el comercio", subordinado al aviso', () => {
  assert.deepEqual(etiquetaDeliveryMotorizado(sh0003()), { etiqueta: 'Delivery', aclaracion: 'Lo paga el comercio', subordinado: true })
  assert.deepEqual(etiquetaDeliveryMotorizado({ pagoDelivery: { quienPaga: 'entrega' } }), { etiqueta: 'Delivery', aclaracion: null, subordinado: false })
})

test('X21 · transferencia: el total a cobrar al cliente sigue sin el delivery', () => {
  const c = calcularDeposito({ ...sh0003(), cobroContraEntrega: { aplica: true, monto: 500 } })
  assert.equal(c.tieneDelivery, false)
  // CobroBox: totalCliente = (tieneDelivery ? delivery : 0) + producto
  assert.equal((c.tieneDelivery ? 80 : 0) + (c.tieneProducto ? c.montoProducto : 0), 500)
  // Precio y aviso intactos
  assert.equal(sh0003().confirmacion.precioFinalCordobas, 80)
  assert.equal(avisoNoCobrarMotorizado(sh0003())?.titulo, 'NO COBRAR ESTE DELIVERY')
})
