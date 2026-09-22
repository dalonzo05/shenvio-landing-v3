// DRAWER-CONTEXTUAL-1 — view-model del drawer y de su segundo nivel (DEP),
// con los fixtures reales: SH-0005 (DEP-0004 C$90 + DEP-0005 C$910) y el
// tipo C de SH-0003 (DEP-0002 C$80).

import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  vistaDrawerOrden,
  contextoDeposito,
  puedeRevisarDeposito,
  motivoNoRevisable,
  TEXTO_REVISAR_DEPOSITO,
  TEXTO_VER_FICHA,
  RUTA_DEPOSITOS,
} from './drawer-contextual'
import type { DepositoRegistrado } from './deposito-orden'
import type { EntradaResumenEjecutivo } from './resumen-ejecutivo-orden'

const ADMIN = 'RKTw1pLfK5O8Y3A6IIwDU8J3yr43'
const MOTO = 'juAOhfxi96dlLv8LV3mZwA3cK362'
const SH_0005_ID = 'UgQP6v3w4qnyyU0fO64l'
const NOMBRES = { [ADMIN]: 'Admin Staging', [MOTO]: 'John Pork 2' }

const sh0005 = (): EntradaResumenEjecutivo => ({
  estado: 'entregado',
  tipoCliente: 'contado',
  createdAt: '2026-09-19T21:05:00.000Z',
  entregadoAt: '2026-09-19T21:37:59.131Z',
  ownerSnapshot: { companyName: 'Mariposita' },
  zonaRetiroNombre: 'Metrocentro',
  zonaEntregaNombre: 'Bo Acahualinca',
  asignacion: { motorizadoNombre: 'John Pork 2', motorizadoAuthUid: MOTO, estadoAceptacion: 'aceptada' },
  confirmacion: { precioFinalCordobas: 90 },
  pagoDelivery: { quienPaga: 'entrega', montoSugerido: 90, deducirDelCobroContraEntrega: true, tipo: 'contado' },
  cobroContraEntrega: { aplica: true, monto: 1000 },
  cobrosMotorizado: { delivery: { monto: 90, recibio: true }, producto: { monto: 1000, recibio: true, estado: 'pagado' } },
  cobroDelivery: { estado: 'pagado', formaPago: 'efectivo', monto: 0, montoDelivery: 90, cubiertoPorDeposito: 90 },
  registro: {
    deposito: {
      storkhubDepositoId: 'PZ04OfRT2R9y27cFfaDN', confirmadoStorkhub: true,
      comercioDepositoId: 'oxbOqPxj3RmPKdXahedk', confirmadoComercio: true,
    },
  },
} as EntradaResumenEjecutivo)

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
const DEP_0002: DepositoRegistrado = {
  id: 'a2HgEC7RcMkgREr4HGD1', codigo: 'DEP-0002', tipo: 'pago_delivery_deposito', estado: 'confirmado',
  destinatario: 'storkhub', solicitudIds: ['OZmiYGHAlUBaAzY4yn9I'], montoTotal: 80,
  boucherUrl: 'https://example.test/c.jpg', creadoAt: '2026-09-18T04:20:53.728Z', confirmadoAt: '2026-09-18T04:20:53.728Z',
}
const vista = (opc = {}) => vistaDrawerOrden(sh0005(), {
  depositos: [DEP_0004, DEP_0005],
  depositosPorDestino: { storkhub: DEP_0004, comercio: DEP_0005 },
  nombresActores: NOMBRES,
  nombreMotorizado: 'John Pork 2',
  estadoEtiqueta: 'Entregado',
  rol: 'gestor',
  ...opc,
})

// ─── RD · el resumen del drawer es el mismo de la ficha ──────────────────────

test('RD1 · SH-0005 muestra el delivery en C$90', () => {
  assert.equal(vista().resumen.cobro.delivery, 'C$ 90')
})

test('RD2 · nunca C$0 como monto del delivery (ese es el pendiente)', () => {
  assert.notEqual(vista().resumen.cobro.delivery, 'C$ 0')
})

test('RD3 · el cobro contra entrega va aparte, en C$1,000', () => {
  const c = vista().resumen.cobro
  assert.equal(c.cobroContraEntrega, 'C$ 1,000')
  assert.equal(c.descontadoDelCE, 'Descontado del cobro contra entrega: C$ 90')
  assert.ok(!JSON.stringify(c).includes('Cubierto con el cobro del producto'))
})

test('RD4 y RD5 · las dos liquidaciones, con su monto y su destino', () => {
  const l = vista().liquidaciones
  assert.deepEqual(l.map((x) => [x.identidad.texto, x.monto]), [['DEP-0004', 90], ['DEP-0005', 910]])
  assert.deepEqual(vista().resumen.liquidaciones.map((x) => [x.codigo, x.destino, x.monto]), [
    ['DEP-0004', 'A StorkHub', 'C$ 90'],
    ['DEP-0005', 'Al comercio (Mariposita)', 'C$ 910'],
  ])
})

test('RD6 · ningún total combinado de C$1,000 en las liquidaciones', () => {
  assert.ok(!JSON.stringify(vista().liquidaciones).includes('1000'))
  assert.ok(!JSON.stringify(vista().resumen.liquidaciones).includes('1,000'))
})

test('RD7 · SH-0005 no tiene pendientes', () => {
  const a = vista().resumen.atencion
  assert.equal(a.hayPendientes, false)
  assert.equal(a.titulo, 'Sin pendientes')
})

test('RD8 · tipo C: C$80, transferencia y StorkHub directo del comercio', () => {
  const sh0003 = {
    estado: 'entregado', tipoCliente: 'contado', ownerSnapshot: { companyName: 'Mariposita' },
    confirmacion: { precioFinalCordobas: 80 }, pagoDelivery: { quienPaga: 'transferencia' },
    cobroContraEntrega: { aplica: false, monto: 0 },
    cobroDelivery: { estado: 'pagado', formaPago: 'transferencia', monto: 80, pagadoAt: '2026-09-18T04:20:53.728Z' },
    asignacion: { motorizadoNombre: 'John Pork 2' },
    registro: { deposito: { storkhubDepositoId: DEP_0002.id, confirmadoStorkhub: true } },
  } as EntradaResumenEjecutivo
  const v = vistaDrawerOrden(sh0003, {
    depositos: [DEP_0002], depositosPorDestino: { storkhub: DEP_0002 },
    nombreMotorizado: 'John Pork 2', estadoEtiqueta: 'Entregado', rol: 'gestor',
  })
  assert.equal(v.resumen.cobro.delivery, 'C$ 80')
  assert.equal(v.resumen.cobro.formaPago, 'transferencia')
  assert.equal(v.resumen.cobro.recibio, 'StorkHub, directo del comercio')
  assert.equal(v.resumen.cobro.cobroContraEntrega, 'No aplica')
  assert.equal(v.resumen.liquidaciones[0].destino, 'A StorkHub, por transferencia del comercio')
})

// ─── DC · el segundo nivel: el depósito ──────────────────────────────────────

test('DC1 · un DEP A/B en revisión ofrece "Revisar depósito" al gestor y al admin', () => {
  const enRevision = { ...DEP_0004, estado: 'en_revision', confirmadoAt: undefined, confirmadoPorUid: undefined }
  assert.equal(puedeRevisarDeposito(enRevision, 'gestor'), true)
  assert.equal(puedeRevisarDeposito(enRevision, 'admin'), true)
  const v = vistaDrawerOrden(sh0005(), { depositos: [enRevision, DEP_0005], rol: 'gestor' })
  assert.deepEqual(v.revisables, [enRevision.id])
  assert.equal(TEXTO_REVISAR_DEPOSITO, 'Revisar depósito')
})

test('DC2 · un DEP confirmado no ofrece revisión; tampoco a un rol que no revisa', () => {
  assert.equal(puedeRevisarDeposito(DEP_0004, 'gestor'), false)
  assert.equal(motivoNoRevisable(DEP_0004, 'gestor'), 'estado')
  const enRevision = { ...DEP_0004, estado: 'en_revision' }
  assert.equal(puedeRevisarDeposito(enRevision, 'digitador'), false)
  assert.equal(motivoNoRevisable(enRevision, 'digitador'), 'rol')
  assert.equal(motivoNoRevisable(null, 'gestor'), 'sin_deposito')
  assert.deepEqual(vista().revisables, [])
})

test('DC3 · un DEP devuelto muestra su estado y su motivo, sin botón de revisión', () => {
  const devuelto = {
    ...DEP_0004, estado: 'devuelto', motivoDevolucion: 'Comprobante incorrecto, por favor subir nuevamente.',
    confirmadoAt: undefined, confirmadoPorUid: undefined,
  }
  const c = contextoDeposito(devuelto, null, { rol: 'gestor', nombresActores: NOMBRES })
  assert.equal(c.estado, 'Corrección solicitada')
  assert.equal(c.motivo, 'Comprobante incorrecto, por favor subir nuevamente.')
  assert.equal(c.puedeRevisar, false)
  assert.equal(c.confirmadoPorUid, null)
})

test('DC4 · el tipo C no entra en la revisión A/B: su corrección es Cobros → Revertir', () => {
  assert.equal(motivoNoRevisable(DEP_0002, 'gestor'), 'tipo_c')
  const enRevision = { ...DEP_0002, estado: 'en_revision' }
  assert.equal(puedeRevisarDeposito(enRevision, 'admin'), false)
  const c = contextoDeposito(DEP_0002, null, { rol: 'gestor' })
  assert.equal(c.destino, 'Pago del delivery por transferencia')
  assert.equal(c.puedeRevisar, false)
})

test('DC5 · el contexto describe el depósito con los campos de su propio documento', () => {
  const c = contextoDeposito(DEP_0004, sh0005() as never, { rol: 'gestor', nombresActores: NOMBRES })
  assert.equal(c.codigo, 'DEP-0004')
  assert.equal(c.estado, 'Confirmado')
  assert.equal(c.monto, 'C$ 90')
  assert.equal(c.destino, 'John Pork 2 → StorkHub')
  assert.equal(c.motorizado, 'John Pork 2')
  assert.equal(c.ordenesIncluidas, 1)
  assert.equal(c.esAgrupado, false)
  assert.equal(c.version, 2)
  assert.equal(c.comprobante, 'https://example.test/v2.jpg')
  assert.equal(c.confirmadoPorUid, ADMIN)
  assert.deepEqual(c.momentos.map((m) => m.etiqueta), ['Enviado', 'Confirmado'])
  assert.equal(c.motivo, null)
})

test('DC6 · con dos depósitos, cada contexto es el suyo', () => {
  const a = contextoDeposito(DEP_0004, null, { nombresActores: NOMBRES })
  const b = contextoDeposito(DEP_0005, null, { nombresActores: NOMBRES })
  assert.notEqual(a.id, b.id)
  assert.deepEqual([a.codigo, a.monto], ['DEP-0004', 'C$ 90'])
  assert.deepEqual([b.codigo, b.monto], ['DEP-0005', 'C$ 910'])
  assert.equal(b.destino, 'John Pork 2 → Mariposita')
})

test('DC7 · navegación: solo la ruta de Depósitos que ya existe, y el copy oficial', () => {
  assert.equal(RUTA_DEPOSITOS, '/panel/gestor/depositos')
  assert.equal(TEXTO_VER_FICHA, 'Ver ficha completa')
})
