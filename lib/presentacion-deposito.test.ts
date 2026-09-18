// DEPOSITOS-UX-TRAZABILIDAD-1 — identidad, origen/destino, actores y
// comprobantes de un documento de ordenes_deposito.
//
// Fixture real: DEP-0001 (P4IMui3ILjs0P9U6eDgT) en shenvios-staging, el
// depósito de SH-0001. motorizadoNombre guardaba el correo del motorizado.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  claseDeposito,
  esDepositoDelMotorizado,
  identidadDeposito,
  nombreDeposito,
  origenDestinoDeposito,
  liquidacionDeposito,
  fechasDeposito,
  confirmadorDeposito,
  nombreMotorizadoDeposito,
  nombreMotorizadoParaRegistro,
  camposConfirmacionDeposito,
  comprobanteDeposito,
  comprobanteClienteAplica,
  TIPO_PAGO_DELIVERY_TRANSFERENCIA,
} from './presentacion-deposito'
import type { DepositoRegistrado } from './deposito-orden'
import { NOMBRE_ACTOR_DESCONOCIDO } from './actor-resolucion'

const MOTO_AUTH = 'juAOhfxi96dlLv8LV3mZwA3cK362'
const ADMIN = 'RKTw1pLfK5O8Y3A6IIwDU8J3yr43'
const NOMBRES: Record<string, string> = { [MOTO_AUTH]: 'John Pork 2', [ADMIN]: 'Admin Staging' }

const DEP_0001: DepositoRegistrado = {
  id: 'P4IMui3ILjs0P9U6eDgT',
  codigo: 'DEP-0001',
  secuencia: 1,
  tipo: 'recaudacion_motorizado_storkhub',
  estado: 'confirmado',
  destinatario: 'storkhub',
  destinatarioId: 'storkhub',
  destinatarioNombre: 'Storkhub',
  motorizadoUid: MOTO_AUTH,
  motorizadoNombre: 'john.pork@example.test',
  solicitudIds: ['jTIJLEhGeACcymBAj0jY'],
  montoTotal: 110,
  montoBruto: 110,
  gastosDescontados: 0,
  boucher: { url: 'https://example.test/depositos/boucher.jpg', pathStorage: 'depositos/x/P4IM/boucher.jpg', uploadedAt: '2026-09-17T23:24:40.777Z' },
  creadoAt: '2026-09-17T23:24:40.777Z',
  confirmadoAt: '2026-09-18T01:03:05.221Z',
  confirmadoPorUid: ADMIN,
}

const DEP_COMERCIO: DepositoRegistrado = {
  ...DEP_0001, id: 'depComercio0000000001', codigo: 'DEP-0002', tipo: 'recaudacion_motorizado_comercio',
  destinatario: 'comercio', destinatarioId: 'ju6hd88CoGcgmbuTak9a', destinatarioNombre: 'Mariposita',
}

// Tipo C tal como lo escribe Cobros: el motorizado de la ASIGNACIÓN (ID del
// documento motorizado, no Auth) y el boucher plano.
const PAGO_TRANSFERENCIA: DepositoRegistrado = {
  id: 'pagoTransfer00000001', codigo: 'DEP-0003', tipo: TIPO_PAGO_DELIVERY_TRANSFERENCIA, estado: 'confirmado',
  destinatario: 'storkhub', destinatarioNombre: 'Storkhub',
  motorizadoUid: 'FdJUdV2PQj6YYK7tmIsg', motorizadoNombre: 'John Pork 2',
  solicitudIds: ['ordenTransfer'], montoTotal: 110, boucherUrl: 'https://example.test/cliente.jpg',
  creadoAt: '2026-09-17T20:00:00.000Z',
}

// ── Tipo ─────────────────────────────────────────────────────────────────────

test('P1 · tipo A, B y C se distinguen por `tipo`, no por destinatario', () => {
  assert.equal(claseDeposito(DEP_0001), 'motorizado_storkhub')
  assert.equal(claseDeposito(DEP_COMERCIO), 'motorizado_comercio')
  // C también va a StorkHub: el destinatario no lo distingue de A.
  assert.equal(PAGO_TRANSFERENCIA.destinatario, DEP_0001.destinatario)
  assert.equal(claseDeposito(PAGO_TRANSFERENCIA), 'transferencia_delivery')
  assert.equal(claseDeposito({ tipo: null }), 'desconocido')
})

test('P2 · el tipo C nunca es un depósito del motorizado', () => {
  assert.equal(esDepositoDelMotorizado(DEP_0001), true)
  assert.equal(esDepositoDelMotorizado(DEP_COMERCIO), true)
  assert.equal(esDepositoDelMotorizado(PAGO_TRANSFERENCIA), false)
  assert.equal(esDepositoDelMotorizado({ tipo: undefined }), false)
})

// ── Identidad ────────────────────────────────────────────────────────────────

test('P3 · DEP-0001 es la identidad; el ID técnico queda secundario', () => {
  const i = identidadDeposito(DEP_0001)
  assert.deepEqual(i, { texto: 'DEP-0001', esCodigo: true, idTecnico: 'P4IMui3ILjs0P9U6eDgT' })
  assert.equal(nombreDeposito(DEP_0001), 'DEP-0001')
})

test('P4 · sin código se cae al ID corto, y en una frase se dice "Depósito …"', () => {
  const sin = { id: 'P4IMui3ILjs0P9U6eDgT' }
  assert.deepEqual(identidadDeposito(sin), { texto: 'P4IMui3I', esCodigo: false, idTecnico: 'P4IMui3ILjs0P9U6eDgT' })
  assert.equal(nombreDeposito(sin), 'Depósito P4IMui3I')
  // Un código con formato viejo no se muestra como si fuera canónico.
  assert.equal(identidadDeposito({ id: 'abcdefghij', codigo: 'DEP-1' }).esCodigo, false)
})

// ── Origen / destino ─────────────────────────────────────────────────────────

test('P5 · A: John Pork 2 → StorkHub; sin nombre, Motorizado → StorkHub', () => {
  assert.equal(origenDestinoDeposito(DEP_0001, 'John Pork 2').texto, 'John Pork 2 → StorkHub')
  assert.equal(origenDestinoDeposito(DEP_0001).texto, 'Motorizado → StorkHub')
})

test('P6 · B: Motorizado → nombre del comercio', () => {
  assert.equal(origenDestinoDeposito(DEP_COMERCIO, 'John Pork 2').texto, 'John Pork 2 → Mariposita')
})

test('P7 · C: pago por transferencia, aunque le pasen el nombre del motorizado', () => {
  const od = origenDestinoDeposito(PAGO_TRANSFERENCIA, 'John Pork 2')
  assert.equal(od.texto, 'Pago del delivery por transferencia')
  assert.equal(od.origen, null)
  assert.equal(od.texto.includes('John Pork'), false)
  assert.equal(od.texto.includes('→'), false)
})

test('P8 · tipo desconocido: se dice el destino y no se afirma el origen', () => {
  const od = origenDestinoDeposito({ tipo: null, destinatario: 'storkhub' }, 'John Pork 2')
  assert.equal(od.texto, 'Depósito a StorkHub')
  assert.equal(od.origen, null)
})

// ── Liquidación (Cobros) ─────────────────────────────────────────────────────

test('P9 · liquidación de SH-0001: DEP-0001 · Motorizado → StorkHub · Confirmado ✓', () => {
  assert.equal(liquidacionDeposito(DEP_0001), 'DEP-0001 · Motorizado → StorkHub · Confirmado ✓')
})

test('P10 · liquidación tipo C: transferencia registrada, nunca "Motorizado →"', () => {
  const t = liquidacionDeposito(PAGO_TRANSFERENCIA)
  assert.equal(t, 'DEP-0003 · Transferencia registrada · Confirmado ✓')
  assert.equal(t.includes('Motorizado'), false)
})

test('P11 · liquidación con estado abierto dice el estado real', () => {
  assert.equal(liquidacionDeposito({ ...DEP_0001, estado: 'en_revision' }), 'DEP-0001 · Motorizado → StorkHub · En revisión')
  assert.equal(liquidacionDeposito({ ...DEP_0001, estado: 'convertido_en_deuda' }), 'DEP-0001 · Motorizado → StorkHub · Convertido en deuda')
})

// ── Fechas ───────────────────────────────────────────────────────────────────

test('P12 · enviado = creadoAt, confirmado = confirmadoAt: dos instantes distintos', () => {
  const f = fechasDeposito(DEP_0001)
  assert.equal(f.enviado, '2026-09-17T23:24:40.777Z')
  assert.equal(f.confirmado, '2026-09-18T01:03:05.221Z')
  assert.notEqual(f.enviado, f.confirmado)
})

test('P13 · sin creadoAt se usa el instante del boucher; sin confirmación, null', () => {
  const f = fechasDeposito({ boucher: { uploadedAt: 'X' }, creadoAt: undefined, confirmadoAt: undefined })
  assert.equal(f.enviado, 'X')
  assert.equal(f.confirmado, null)
})

// ── Actores ──────────────────────────────────────────────────────────────────

test('P14 · confirmador resuelto: Admin Staging, con el UID como rastro', () => {
  const a = confirmadorDeposito(DEP_0001, NOMBRES)!
  assert.equal(a.nombre, 'Admin Staging')
  assert.equal(a.uid, ADMIN)
})

test('P15 · confirmador sin nombre: "Usuario interno", nunca el UID al frente', () => {
  assert.equal(confirmadorDeposito(DEP_0001, {})!.nombre, NOMBRE_ACTOR_DESCONOCIDO)
  assert.equal(confirmadorDeposito({ confirmadoPorUid: null }, NOMBRES), null)
})

test('P16 · motorizado del depósito: el nombre resuelto manda; el correo guardado no se muestra', () => {
  assert.equal(nombreMotorizadoDeposito(DEP_0001, NOMBRES), 'John Pork 2')
  assert.equal(nombreMotorizadoDeposito(DEP_0001, {}), null)
  assert.equal(nombreMotorizadoDeposito({ ...DEP_0001, motorizadoNombre: 'John Pork 2' }, {}), 'John Pork 2')
  // Tipo C: no es del motorizado, no se nombra motorizado.
  assert.equal(nombreMotorizadoDeposito(PAGO_TRANSFERENCIA, NOMBRES), null)
})

// ── Writers autorizados ──────────────────────────────────────────────────────

test('P17 · motorizadoNombre al crear: perfil primero, nunca el correo', () => {
  assert.equal(nombreMotorizadoParaRegistro({ perfil: 'John Pork 2', displayName: 'Otro' }), 'John Pork 2')
  assert.equal(nombreMotorizadoParaRegistro({ perfil: null, displayName: 'John' }), 'John')
  assert.equal(nombreMotorizadoParaRegistro({ perfil: '  ', displayName: null }), '')
  // El caso real: sin displayName, el writer viejo guardaba el correo.
  assert.equal(nombreMotorizadoParaRegistro({ perfil: null, displayName: 'john.pork@example.test' }), '')
})

test('P18 · confirmar escribe quién y cuándo; sin sesión, cuándo sin UID inventado', () => {
  const MARCA = { __serverTimestamp: true }
  assert.deepEqual(camposConfirmacionDeposito(ADMIN, MARCA), { confirmadoPorUid: ADMIN, confirmadoAt: MARCA })
  assert.deepEqual(camposConfirmacionDeposito('', MARCA), { confirmadoAt: MARCA })
  assert.deepEqual(camposConfirmacionDeposito(undefined, MARCA), { confirmadoAt: MARCA })
})

// ── Comprobantes ─────────────────────────────────────────────────────────────

test('P19 · comprobante del depósito: boucher.url en A/B, boucherUrl plano en C', () => {
  assert.equal(comprobanteDeposito(DEP_0001), 'https://example.test/depositos/boucher.jpg')
  assert.equal(comprobanteDeposito(PAGO_TRANSFERENCIA), 'https://example.test/cliente.jpg')
  assert.equal(comprobanteDeposito({ boucher: null, boucherUrl: null }), null)
})

test('P20 · SH-0001: sin comprobante del cliente, cobrado en efectivo ⇒ no aplica', () => {
  // El comprobante del PAGO DEL CLIENTE no es el del depósito: su ausencia en
  // un cobro en efectivo no es un faltante.
  assert.equal(comprobanteClienteAplica({ estado: 'pagado', formaPago: 'efectivo' }, 'entrega', false), 'no_aplica')
})

test('P21 · comprobante del cliente: se muestra si existe, se espera si va por transferencia', () => {
  assert.equal(comprobanteClienteAplica({ estado: 'pagado', formaPago: 'transferencia' }, 'transferencia', true), 'mostrar')
  assert.equal(comprobanteClienteAplica({ estado: 'pendiente' }, 'transferencia', false), 'esperando')
  assert.equal(comprobanteClienteAplica({ estado: 'en_revision_deposito' }, 'entrega', false), 'esperando')
  assert.equal(comprobanteClienteAplica(null, 'transferencia', false), 'esperando')
  // Cerrado sin comprobante: no se sigue "esperando".
  assert.equal(comprobanteClienteAplica({ estado: 'pagado', formaPago: 'transferencia' }, 'transferencia', false), 'no_aplica')
  assert.equal(comprobanteClienteAplica({ estado: 'pendiente' }, 'entrega', false), 'no_aplica')
})

test('P22 · depósito reabierto (Rehacer / revertir conversión): sin fecha ni confirmador vigentes', () => {
  // El documento conserva confirmadoAt/confirmadoPorUid de la confirmación
  // anterior como historial; eso no es una confirmación vigente.
  const reabierto: DepositoRegistrado = { ...DEP_0001, estado: 'en_revision' }
  assert.equal(fechasDeposito(reabierto).confirmado, null)
  assert.equal(fechasDeposito(reabierto).enviado, '2026-09-17T23:24:40.777Z')
  assert.equal(confirmadorDeposito(reabierto, NOMBRES), null)
  assert.equal(liquidacionDeposito(reabierto), 'DEP-0001 · Motorizado → StorkHub · En revisión')
})
