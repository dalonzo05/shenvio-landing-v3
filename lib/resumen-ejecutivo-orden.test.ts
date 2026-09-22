// SOLICITUD-RESUMEN-UX-1 — resumen ejecutivo, con los fixtures reales de
// staging: SH-0005 (efectivo con CE, dos depósitos) y SH-0003 (tipo C).

import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  resumenEjecutivoOrden,
  SIN_DATO,
  NO_APLICA,
  TEXTO_DESCONTADO_CE,
  TEXTO_SIN_PENDIENTES,
  TEXTO_REQUIERE_ATENCION,
  type EntradaResumenEjecutivo,
} from './resumen-ejecutivo-orden'
import type { DepositoRegistrado } from './deposito-orden'

const ADMIN = 'RKTw1pLfK5O8Y3A6IIwDU8J3yr43'
const MOTO = 'juAOhfxi96dlLv8LV3mZwA3cK362'
const SH_0005_ID = 'UgQP6v3w4qnyyU0fO64l'

function sh0005(over: Partial<EntradaResumenEjecutivo> = {}): EntradaResumenEjecutivo {
  return {
    estado: 'entregado',
    tipoCliente: 'contado',
    createdAt: '2026-09-19T21:05:00.000Z',
    entregadoAt: '2026-09-19T21:37:59.131Z',
    ownerSnapshot: { companyName: 'Mariposita' },
    zonaRetiroNombre: 'Metrocentro',
    zonaEntregaNombre: 'Bo Acahualinca',
    recoleccion: { direccionEscrita: 'Del árbol 2c al sur' },
    entrega: { direccionEscrita: 'Portón verde' },
    asignacion: { motorizadoNombre: 'John Pork 2', motorizadoAuthUid: MOTO, estadoAceptacion: 'aceptada' },
    confirmacion: { precioFinalCordobas: 90 },
    pagoDelivery: { quienPaga: 'entrega', montoSugerido: 90, deducirDelCobroContraEntrega: true, tipo: 'contado' },
    cobroContraEntrega: { aplica: true, monto: 1000 },
    cobrosMotorizado: {
      delivery: { monto: 90, recibio: true },
      producto: { monto: 1000, recibio: true, estado: 'pagado' },
    },
    cobroDelivery: {
      estado: 'pagado', formaPago: 'efectivo', quienPaga: 'entrega',
      monto: 0, montoDelivery: 90, cubiertoPorDeposito: 90,
    },
    evidencias: {
      retiro: { url: 'https://example.test/retiro.jpg' },
      entrega: { url: 'https://example.test/entrega.jpg' },
    },
    registro: {
      deposito: {
        storkhubDepositoId: 'PZ04OfRT2R9y27cFfaDN', confirmadoStorkhub: true,
        comercioDepositoId: 'oxbOqPxj3RmPKdXahedk', confirmadoComercio: true,
      },
    },
    ...over,
  } as EntradaResumenEjecutivo
}

const DEP_0004: DepositoRegistrado = {
  id: 'PZ04OfRT2R9y27cFfaDN', codigo: 'DEP-0004', tipo: 'recaudacion_motorizado_storkhub', estado: 'confirmado',
  destinatario: 'storkhub', destinatarioNombre: 'Storkhub', motorizadoUid: MOTO, solicitudIds: [SH_0005_ID],
  montoTotal: 90, boucherVersion: 2, creadoAt: '2026-09-19T21:43:59.645Z',
  confirmadoAt: '2026-09-21T03:50:49.041Z', confirmadoPorUid: ADMIN,
  boucher: { url: 'https://example.test/v2.jpg', pathStorage: 'x' },
}
const DEP_0005: DepositoRegistrado = {
  id: 'oxbOqPxj3RmPKdXahedk', codigo: 'DEP-0005', tipo: 'recaudacion_motorizado_comercio', estado: 'confirmado',
  destinatario: 'comercio', destinatarioNombre: 'Mariposita', motorizadoUid: MOTO, solicitudIds: [SH_0005_ID],
  montoTotal: 910, creadoAt: '2026-09-19T21:44:07.739Z',
  confirmadoAt: '2026-09-21T03:50:49.085Z', confirmadoPorUid: ADMIN,
  boucher: { url: 'https://example.test/b.jpg', pathStorage: 'y' },
}
const OPC_0005 = {
  depositos: [DEP_0004, DEP_0005],
  depositosPorDestino: { storkhub: DEP_0004, comercio: DEP_0005 },
  nombreMotorizado: 'John Pork 2',
  estadoEtiqueta: 'Entregado',
}
const r5 = (over: Partial<EntradaResumenEjecutivo> = {}, opc = {}) =>
  resumenEjecutivoOrden(sh0005(over), { ...OPC_0005, ...opc })

test('SR1 · orden entregada: estado, ruta y fechas de la propia orden', () => {
  const r = r5()
  assert.equal(r.envio.estado, 'Entregado')
  assert.equal(r.envio.ruta, 'Metrocentro → Bo Acahualinca')
  assert.equal(r.envio.creada, '2026-09-19T21:05:00.000Z')
  assert.equal(r.envio.entregada, '2026-09-19T21:37:59.131Z')
  // Sin zonas cae a la dirección escrita; nunca inventa una zona.
  const sinZonas = r5({ zonaRetiroNombre: null, zonaEntregaNombre: null })
  assert.equal(sinZonas.envio.ruta, 'Del árbol 2c al sur → Portón verde')
})

test('SR2 · motorizado: el nombre resuelto, y si no el guardado en la orden', () => {
  assert.equal(r5().envio.motorizado, 'John Pork 2')
  assert.equal(r5({}, { nombreMotorizado: null }).envio.motorizado, 'John Pork 2')
  assert.equal(
    resumenEjecutivoOrden(sh0005({ asignacion: null }), { ...OPC_0005, nombreMotorizado: null }).envio.motorizado,
    SIN_DATO,
  )
})

test('SR3 · el delivery vale C$90 (no el pendiente, que es 0)', () => {
  assert.equal(r5().cobro.delivery, 'C$ 90')
})

test('SR4 · el cobro contra entrega es C$1,000 y va en su propia fila', () => {
  const r = r5()
  assert.equal(r.cobro.cobroContraEntrega, 'C$ 1,000')
  assert.notEqual(r.cobro.delivery, 'C$ 1,000')
  // Sin CE no se inventa un monto.
  assert.equal(r5({ cobroContraEntrega: { aplica: false, monto: 0 } }).cobro.cobroContraEntrega, NO_APLICA)
})

test('SR5 · el delivery deducido se dice "Descontado del cobro contra entrega: C$90"', () => {
  assert.equal(r5().cobro.descontadoDelCE, `${TEXTO_DESCONTADO_CE}: C$ 90`)
  assert.ok(!JSON.stringify(r5()).includes('Cubierto con el cobro del producto'))
  // Sin deducción no aparece la fila.
  const sinDeduccion = r5({ cobroDelivery: { estado: 'pagado', formaPago: 'efectivo', monto: 90 } })
  assert.equal(sinDeduccion.cobro.descontadoDelCE, null)
})

test('SR6 · dos liquidaciones separadas: C$90 a StorkHub y C$910 al comercio', () => {
  const l = r5().liquidaciones
  assert.equal(l.length, 2)
  assert.deepEqual(l.map((x) => [x.codigo, x.destino, x.monto, x.estado]), [
    ['DEP-0004', 'A StorkHub', 'C$ 90', 'Confirmado'],
    ['DEP-0005', 'Al comercio (Mariposita)', 'C$ 910', 'Confirmado'],
  ])
})

test('SR7 · nunca un total agregado de C$1,000 en las liquidaciones', () => {
  const l = r5().liquidaciones
  assert.ok(!JSON.stringify(l).includes('1,000'))
  assert.ok(l.every((x) => !('total' in x)))
})

test('SR8 · sin depósitos: liquidaciones vacías y sin comprobantes, no rompe', () => {
  const r = resumenEjecutivoOrden(sh0005(), { estadoEtiqueta: 'Entregado' })
  assert.deepEqual(r.liquidaciones, [])
  assert.equal(r.evidencias.comprobantes, 0)
})

test('SR9 · un solo depósito: una línea', () => {
  const r = resumenEjecutivoOrden(sh0005(), {
    ...OPC_0005, depositos: [DEP_0004], depositosPorDestino: { storkhub: DEP_0004 },
  })
  assert.equal(r.liquidaciones.length, 1)
  assert.equal(r.liquidaciones[0].codigo, 'DEP-0004')
})

test('SR10 · tipo C: transferencia, recibida por StorkHub directo del comercio', () => {
  const sh0003: EntradaResumenEjecutivo = {
    estado: 'entregado', tipoCliente: 'contado', createdAt: '2026-09-17T22:00:00.000Z',
    entregadoAt: '2026-09-18T04:14:00.000Z', ownerSnapshot: { companyName: 'Mariposita' },
    zonaRetiroNombre: 'Metrocentro', zonaEntregaNombre: 'Zona Universitaria UCA - UNI',
    asignacion: { motorizadoNombre: 'John Pork 2', estadoAceptacion: 'aceptada' },
    confirmacion: { precioFinalCordobas: 80 },
    pagoDelivery: { quienPaga: 'transferencia', montoSugerido: 80, deducirDelCobroContraEntrega: false, tipo: 'contado' },
    cobroContraEntrega: { aplica: false, monto: 0 },
    cobroDelivery: { estado: 'pagado', formaPago: 'transferencia', quienPaga: 'transferencia', monto: 80, pagadoAt: '2026-09-18T04:20:53.728Z' },
    registro: { deposito: { storkhubDepositoId: 'a2HgEC7RcMkgREr4HGD1', confirmadoStorkhub: true } },
  } as EntradaResumenEjecutivo
  const depC: DepositoRegistrado = {
    id: 'a2HgEC7RcMkgREr4HGD1', codigo: 'DEP-0002', tipo: 'pago_delivery_deposito', estado: 'confirmado',
    destinatario: 'storkhub', solicitudIds: ['OZmiYGHAlUBaAzY4yn9I'], montoTotal: 80,
    boucherUrl: 'https://example.test/c.jpg', creadoAt: '2026-09-18T04:20:53.728Z', confirmadoAt: '2026-09-18T04:20:53.728Z',
  }
  const r = resumenEjecutivoOrden(sh0003, {
    depositos: [depC], depositosPorDestino: { storkhub: depC }, nombreMotorizado: 'John Pork 2', estadoEtiqueta: 'Entregado',
  })
  assert.equal(r.cobro.delivery, 'C$ 80')
  assert.equal(r.cobro.formaPago, 'transferencia')
  assert.equal(r.cobro.recibio, 'StorkHub, directo del comercio')
  assert.equal(r.cobro.cobroContraEntrega, NO_APLICA)
  assert.equal(r.liquidaciones[0].destino, 'A StorkHub, por transferencia del comercio')
})

test('SR11 · tipo C: no se dice que el motorizado recibió el dinero', () => {
  const sh0003 = {
    estado: 'entregado', confirmacion: { precioFinalCordobas: 80 },
    pagoDelivery: { quienPaga: 'transferencia' },
    cobroDelivery: { estado: 'pagado', formaPago: 'transferencia', monto: 80, pagadoAt: '2026-09-18T04:20:53.728Z' },
    asignacion: { motorizadoNombre: 'John Pork 2' },
    cobroContraEntrega: { aplica: false, monto: 0 },
  } as EntradaResumenEjecutivo
  const r = resumenEjecutivoOrden(sh0003, { nombreMotorizado: 'John Pork 2' })
  assert.ok(!r.cobro.recibio.includes('John Pork 2'))
  assert.ok(!r.cobro.recibio.includes('motorizado'))
})

test('SR12 · sin pendientes ⇒ "Sin pendientes"', () => {
  const a = r5().atencion
  assert.equal(a.hayPendientes, false)
  assert.equal(a.titulo, TEXTO_SIN_PENDIENTES)
  assert.deepEqual(a.mensajes, [])
  assert.equal(a.total, 0)
})

test('SR13 · con pendiente ⇒ "Requiere atención", con hasta 3 mensajes', () => {
  // Delivery por cobrar: el mismo pendiente que muestra "Qué falta en esta orden".
  const a = resumenEjecutivoOrden(
    sh0005({
      cobroDelivery: { estado: 'pendiente', formaPago: null, monto: 90, montoDelivery: 90, cubiertoPorDeposito: 0 },
      registro: { deposito: null },
    }),
    { nombreMotorizado: 'John Pork 2', estadoEtiqueta: 'Entregado' },
  ).atencion
  assert.equal(a.hayPendientes, true)
  assert.equal(a.titulo, TEXTO_REQUIERE_ATENCION)
  assert.ok(a.total >= 1)
  assert.ok(a.mensajes.length >= 1 && a.mensajes.length <= 3)
  assert.ok(a.mensajes.some((m) => m.includes('C$ 90')))
})

test('SR14 · evidencias: presencia, no imágenes; sin evidencia no rompe', () => {
  const r = r5()
  assert.deepEqual(r.evidencias, { retiro: true, entrega: true, comprobantes: 2 })
  const sinNada = resumenEjecutivoOrden(sh0005({ evidencias: null }), { ...OPC_0005, depositos: [] })
  assert.deepEqual(sinNada.evidencias, { retiro: false, entrega: false, comprobantes: 0 })
})

test('SR15 · datos ausentes: "No registrado" / "No aplica", nunca undefined ni NaN', () => {
  const vacia = resumenEjecutivoOrden({} as EntradaResumenEjecutivo, {})
  const plano = JSON.stringify(vacia)
  assert.ok(!plano.includes('undefined'), 'ningún texto dice "undefined"')
  assert.equal(vacia.envio.estado, SIN_DATO)
  assert.equal(vacia.envio.ruta, `${SIN_DATO} → ${SIN_DATO}`)
  assert.equal(vacia.envio.motorizado, SIN_DATO)
  assert.equal(vacia.cliente.nombre, SIN_DATO)
  assert.equal(vacia.cliente.tipoCliente, SIN_DATO)
  assert.equal(vacia.cobro.formaPago, SIN_DATO)
  assert.equal(vacia.cobro.recibio, SIN_DATO)
  assert.equal(vacia.cobro.cobroContraEntrega, NO_APLICA)
  assert.equal(vacia.cobro.descontadoDelCE, null)
  assert.ok(!plano.includes('NaN'))
})

test('SR16 · cliente y estado frente al cliente, con el vocabulario ya cerrado', () => {
  const r = r5()
  assert.equal(r.cliente.nombre, 'Mariposita')
  assert.equal(r.cliente.tipoCliente, 'Contado')
  assert.equal(r.cobro.formaPago, 'efectivo')
  assert.equal(r.cobro.recibio, 'John Pork 2 (motorizado)')
  assert.equal(r.cobro.estadoCliente, 'Cobrado')
})

test('SR17 · un depósito agrupado se marca: su total no es todo de esta orden', () => {
  const r = resumenEjecutivoOrden(sh0005(), {
    ...OPC_0005, depositos: [{ ...DEP_0004, solicitudIds: [SH_0005_ID, 'otra'] }],
  })
  assert.equal(r.liquidaciones[0].esAgrupado, true)
  assert.equal(r.liquidaciones.filter((x) => x.esAgrupado === false).length, 0)
})
