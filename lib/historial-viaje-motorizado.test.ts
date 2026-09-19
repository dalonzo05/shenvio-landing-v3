// MOTORIZADO-UX-OPERATIVA-1 — tarjeta del Historial del motorizado.
//
// Casos reales de staging: SH-0001 (efectivo, Metrocentro → Bo Acahualinca) y
// SH-0003 (transferencia del comercio, Metrocentro → Zona UCA-UNI).

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { resumenViajeHistorial, zonaViaje, formaCobroViaje, SIN_ZONA } from './historial-viaje-motorizado'

const ENTREGADO_AT = '2026-09-13T17:46:00.000Z'

function sh0001(extra: Record<string, unknown> = {}) {
  return {
    id: 'jTIJLEhGeACcymBAj0jY', codigo: 'SH-0001', estado: 'entregado', entregadoAt: ENTREGADO_AT,
    tipoCliente: 'contado',
    zonaRetiroNombre: 'Metrocentro', macroZonaRetiroNombre: 'Zona Centro',
    zonaEntregaNombre: 'Bo Acahualinca', macroZonaEntregaNombre: 'Zona Nor - Oeste',
    confirmacion: { precioFinalCordobas: 110 },
    precioDesglose: { deliveryBase: 110 },
    pagoDelivery: { quienPaga: 'entrega', montoSugerido: 110, deducirDelCobroContraEntrega: false, tipo: 'contado' },
    cobrosMotorizado: { delivery: { recibio: true } },
    cobroContraEntrega: { aplica: false, monto: 0 },
    ...extra,
  }
}
const sh0003 = () => sh0001({
  id: 'OZmiYGHAlUBaAzY4yn9I', codigo: 'SH-0003',
  zonaEntregaNombre: 'Zona Universitaria UCA - UNI', macroZonaEntregaNombre: 'Zona Centro',
  confirmacion: { precioFinalCordobas: 80 }, precioDesglose: { deliveryBase: 80 },
  pagoDelivery: { quienPaga: 'transferencia', montoSugerido: 80, deducirDelCobroContraEntrega: false, tipo: 'contado' },
  cobrosMotorizado: undefined,
})

test('H1 · código SH; sin código canónico cae al ID técnico corto', () => {
  assert.equal(resumenViajeHistorial(sh0001()).codigo, 'SH-0001')
  assert.equal(resumenViajeHistorial(sh0001({ codigo: undefined })).codigo, 'jTIJLEhG')
})

test('H2 · zona concreta; sin ella, macrozona; sin ninguna, "—" (nunca un ID)', () => {
  const v = resumenViajeHistorial(sh0001())
  assert.equal(v.zonaRetiro, 'Metrocentro')
  assert.equal(v.zonaEntrega, 'Bo Acahualinca')
  // SH-0002 real: zonaEntregaNombre null → macrozona
  assert.equal(resumenViajeHistorial(sh0001({ zonaEntregaNombre: null, macroZonaEntregaNombre: 'Zona Sur' })).zonaEntrega, 'Zona Sur')
  assert.equal(zonaViaje(null, null), SIN_ZONA)
  assert.equal(zonaViaje('  ', undefined), '—')
})

test('H3 · forma de cobro: efectivo (SH-0001)', () => {
  assert.deepEqual(formaCobroViaje(sh0001()), { clave: 'efectivo', texto: 'Efectivo' })
})

test('H4 · forma de cobro: transferencia del comercio (SH-0003)', () => {
  assert.deepEqual(formaCobroViaje(sh0003()), { clave: 'transferencia', texto: 'Transferencia del comercio' })
})

test('H5 · forma de cobro: crédito (tipoCliente o credito_semanal)', () => {
  assert.equal(formaCobroViaje(sh0001({ tipoCliente: 'credito' })).clave, 'credito')
  assert.equal(formaCobroViaje(sh0001({ pagoDelivery: { quienPaga: 'credito_semanal' } })).clave, 'credito')
  assert.equal(formaCobroViaje(sh0001({ tipoCliente: 'credito' })).texto, 'Crédito semanal del comercio')
})

test('H6 · forma de cobro: no recibido y sin delivery', () => {
  assert.equal(formaCobroViaje(sh0001({ cobrosMotorizado: { delivery: { recibio: false } } })).clave, 'no_cobrado')
  assert.equal(formaCobroViaje(sh0001({ confirmacion: { precioFinalCordobas: 0 } })).clave, 'sin_delivery')
})

test('H7 · estado, fecha y delivery: los mismos datos de la orden, sin transformar', () => {
  const v = resumenViajeHistorial(sh0003())
  assert.equal(v.estado, 'Entregada')
  assert.equal(v.entregadoAt, ENTREGADO_AT)
  assert.equal(v.delivery, 80)
  assert.equal(resumenViajeHistorial(sh0001({ confirmacion: null })).delivery, null)
})

test('H8 · no introduce cálculo financiero: sin ganancia ni montos derivados', () => {
  const v = resumenViajeHistorial(sh0001()) as unknown as Record<string, unknown>
  assert.deepEqual(Object.keys(v).sort(), ['codigo', 'delivery', 'entregadoAt', 'estado', 'formaCobro', 'zonaEntrega', 'zonaRetiro'])
  assert.ok(!('ganancia' in v))
  // delivery es exactamente el precio confirmado, no deliveryBase ni un porcentaje
  assert.equal(resumenViajeHistorial(sh0001({ precioDesglose: { deliveryBase: 999 } })).delivery, 110)
})
