// STORAGE-EVIDENCIA-INTEGRIDAD-1 — payloads del writer create-first del
// motorizado. La suite de reglas (test/storage-rules.test.ts) ejecuta estos
// mismos payloads contra los emuladores; acá se fija su forma.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  camposCreacionDepositoMotorizado,
  camposEnvioBoucherMotorizado,
  campoPunteroDepositoMotorizado,
  pathBoucherDepositoMotorizado,
  firmaEnvioDeposito,
  envioReutilizable,
  pasosPendientesEnvio,
  type DatosDepositoMotorizado,
} from './deposito-motorizado-envio'

const AHORA = { __ts: 'serverTimestamp' }

function datosA(extra: Partial<DatosDepositoMotorizado> = {}): DatosDepositoMotorizado {
  return {
    tipo: 'recaudacion_motorizado_storkhub',
    destinatario: 'storkhub',
    destinatarioId: 'storkhub',
    destinatarioNombre: 'Storkhub',
    cuentasDestino: [{ banco: 'LAFISE', numero: '000', titular: 'StorkHub', moneda: 'C$' }],
    motorizadoUid: 'juAO',
    motorizadoNombre: 'John Pork 2',
    solicitudIds: ['HDpf'],
    montoTotal: 80,
    montoBruto: 80,
    gastosDescontados: 0,
    gastosIds: [],
    ...extra,
  }
}

test('E1 · la creación nace en pendiente_boucher, SIN boucher ni campos de cierre', () => {
  const c = camposCreacionDepositoMotorizado(datosA(), AHORA)
  assert.equal(c.estado, 'pendiente_boucher')
  assert.equal(c.creadoAt, AHORA)
  for (const k of ['boucher', 'boucherUrl', 'confirmadoAt', 'confirmadoPorUid', 'saldoId', 'anuladoAt', 'digitadoPorUid', 'codigo', 'secuencia']) {
    assert.ok(!(k in c), k)
  }
  assert.deepEqual(Object.keys(c).sort(), [
    'creadoAt', 'cuentasDestino', 'destinatario', 'destinatarioId', 'destinatarioNombre', 'estado',
    'gastosDescontados', 'gastosIds', 'montoBruto', 'montoTotal', 'motorizadoNombre', 'motorizadoUid',
    'solicitudIds', 'tipo',
  ])
})

test('E2 · tipo B: sin montoBruto/gastos si no vienen (no se escriben undefined)', () => {
  const c = camposCreacionDepositoMotorizado(datosA({
    tipo: 'recaudacion_motorizado_comercio', destinatario: 'comercio', destinatarioId: 'com1',
    montoBruto: undefined, gastosDescontados: undefined, gastosIds: undefined,
  }), AHORA)
  assert.equal(c.tipo, 'recaudacion_motorizado_comercio')
  assert.ok(!('montoBruto' in c) && !('gastosDescontados' in c) && !('gastosIds' in c))
})

test('E3 · el envío pone boucher y en_revision juntos, con el UID del motorizado', () => {
  const e = camposEnvioBoucherMotorizado({ url: 'https://x/b.jpg', pathStorage: 'depositos/juAO/d1/boucher.jpg' }, 'juAO', AHORA)
  assert.deepEqual(e, {
    boucher: { url: 'https://x/b.jpg', pathStorage: 'depositos/juAO/d1/boucher.jpg', uploadedAt: AHORA, motorizadoUid: 'juAO' },
    estado: 'en_revision',
  })
})

test('E4 · puntero por destino y path con el UID del motorizado', () => {
  assert.equal(campoPunteroDepositoMotorizado('recaudacion_motorizado_storkhub'), 'registro.deposito.storkhubDepositoId')
  assert.equal(campoPunteroDepositoMotorizado('recaudacion_motorizado_comercio'), 'registro.deposito.comercioDepositoId')
  assert.equal(pathBoucherDepositoMotorizado('juAO', 'd1'), 'depositos/juAO/d1/boucher.jpg')
})

test('E5 · reintento: mismo grupo reusa el envío; si cambian órdenes o monto, no', () => {
  const previo = { depositoId: 'd1', creado: true, firma: firmaEnvioDeposito(datosA()) }
  assert.equal(envioReutilizable(previo, datosA()), true)
  // El orden de las órdenes no cambia la identidad.
  assert.equal(firmaEnvioDeposito(datosA({ solicitudIds: ['b', 'a'] })), firmaEnvioDeposito(datosA({ solicitudIds: ['a', 'b'] })))
  assert.equal(envioReutilizable(previo, datosA({ solicitudIds: ['HDpf', 'otra'] })), false)
  assert.equal(envioReutilizable(previo, datosA({ montoTotal: 90 })), false)
  assert.equal(envioReutilizable(null, datosA()), false)
})

test('E6 · pasos: sin crear → crear, subir, enviar; ya creado → solo subir y enviar', () => {
  assert.deepEqual(pasosPendientesEnvio(null), ['crear', 'subir', 'enviar'])
  assert.deepEqual(pasosPendientesEnvio({ depositoId: 'd1', creado: false, firma: 'f' }), ['crear', 'subir', 'enviar'])
  assert.deepEqual(pasosPendientesEnvio({ depositoId: 'd1', creado: true, firma: 'f' }), ['subir', 'enviar'])
})
