// DEPOSITO-AUDITORIA-1 — eventos append-only de un depósito.
//
// Lo que estos casos protegen no es el formato: es que el payload que arma el
// writer sea EXACTAMENTE el que firestore.rules acepta. La suite de reglas
// importa estos mismos helpers (test/firestore-rules.test.ts), así que un
// cambio acá que desalinee las dos cosas se ve en los dos lados.

import test from 'node:test'
import assert from 'node:assert/strict'
import {
  EVENTO_BOUCHER_REEMPLAZADO,
  EVENTO_BOUCHER_SUBIDO,
  EVENTO_DEPOSITO_ANULADO,
  EVENTO_DEPOSITO_CONFIRMADO,
  EVENTO_DEPOSITO_DEVUELTO,
  EVENTO_DEPOSITO_REHECHO,
  MOTIVO_EVENTO_MAX,
  MOTIVO_EVENTO_MIN,
  TIPOS_EVENTO_DEPOSITO,
  TITULO_EVENTO_GENERICO,
  asegurarMotivoEvento,
  camposEventoBoucherReemplazado,
  camposEventoBoucherSubido,
  camposEventoDepositoAnulado,
  camposEventoDepositoConfirmado,
  camposEventoDepositoDevuelto,
  camposEventoDepositoRehecho,
  etiquetaEventoDeposito,
  eventoExigeMotivo,
  filasEventosDeposito,
  motivoEventoValido,
  normalizarMotivoEvento,
  rutaEventosDeposito,
} from './deposito-eventos'

const ACTOR = { uid: 'uid_gestor', rol: 'gestor' }
const AHORA = '<<serverTimestamp>>'

// ── Ruta ─────────────────────────────────────────────────────────────────────

test('EV1 · la subcolección cuelga del depósito, no de una colección global', () => {
  assert.equal(rutaEventosDeposito('dep1'), 'ordenes_deposito/dep1/eventos')
})

// ── Motivo ───────────────────────────────────────────────────────────────────

test('EV2 · el motivo se recorta antes de medirlo', () => {
  assert.equal(normalizarMotivoEvento('  hola  '), 'hola')
  assert.equal(normalizarMotivoEvento(null), '')
  assert.equal(normalizarMotivoEvento(42), '')
  // '   ' tiene 3 caracteres y pasaría un length >= 3 ingenuo; acá no.
  assert.equal(motivoEventoValido('   '), false)
})

test('EV3 · los límites son los mismos que aplica Rules: 3 y 300', () => {
  assert.equal(MOTIVO_EVENTO_MIN, 3)
  assert.equal(MOTIVO_EVENTO_MAX, 300)
  assert.equal(motivoEventoValido('no'), false)
  assert.equal(motivoEventoValido('sí!'), true)
  assert.equal(motivoEventoValido('x'.repeat(300)), true)
  assert.equal(motivoEventoValido('x'.repeat(301)), false)
})

test('EV4 · asegurarMotivoEvento corta antes de que el writer suba nada', () => {
  assert.equal(asegurarMotivoEvento('  foto borrosa  '), 'foto borrosa')
  assert.throws(() => asegurarMotivoEvento('no'), /motivo es obligatorio/)
  assert.throws(() => asegurarMotivoEvento(undefined), /motivo es obligatorio/)
})

// ── Qué tipos exigen motivo ──────────────────────────────────────────────────

test('EV5 · exigen motivo las cuatro decisiones humanas, y solo esas', () => {
  assert.equal(eventoExigeMotivo(EVENTO_BOUCHER_REEMPLAZADO), true)
  assert.equal(eventoExigeMotivo(EVENTO_DEPOSITO_DEVUELTO), true)
  assert.equal(eventoExigeMotivo(EVENTO_DEPOSITO_REHECHO), true)
  assert.equal(eventoExigeMotivo(EVENTO_DEPOSITO_ANULADO), true)
  assert.equal(eventoExigeMotivo(EVENTO_BOUCHER_SUBIDO), false)
  assert.equal(eventoExigeMotivo(EVENTO_DEPOSITO_CONFIRMADO), false)
  assert.equal(eventoExigeMotivo('LO_QUE_SEA'), false)
})

test('EV6 · la lista de tipos es la misma que la lista cerrada de Rules', () => {
  assert.deepEqual([...TIPOS_EVENTO_DEPOSITO], [
    'BOUCHER_SUBIDO', 'BOUCHER_REEMPLAZADO', 'DEPOSITO_DEVUELTO',
    'DEPOSITO_CONFIRMADO', 'DEPOSITO_REHECHO', 'DEPOSITO_ANULADO',
  ])
})

// ── Campos ───────────────────────────────────────────────────────────────────

test('EV7 · todo evento lleva tipo, hora, actor y rol', () => {
  const e = camposEventoDepositoConfirmado(ACTOR, AHORA)
  assert.deepEqual(e, {
    tipo: 'DEPOSITO_CONFIRMADO', at: AHORA, porUid: 'uid_gestor', porRol: 'gestor',
  })
})

test('EV8 · el evento de reemplazo describe la versión entera', () => {
  const e = camposEventoBoucherReemplazado({ uid: 'uid_moto', rol: 'motorizado' }, AHORA, {
    version: 2,
    versionId: 'verSegunda',
    path: 'depositos/uid_moto/dep1/bouchers/verSegunda.jpg',
    reemplazaA: 'depositos/uid_moto/dep1/boucher.jpg',
    motivo: '  La foto salió movida  ',
  })
  assert.deepEqual(e, {
    tipo: 'BOUCHER_REEMPLAZADO',
    at: AHORA,
    porUid: 'uid_moto',
    porRol: 'motorizado',
    motivo: 'La foto salió movida',
    version: 2,
    versionId: 'verSegunda',
    path: 'depositos/uid_moto/dep1/bouchers/verSegunda.jpg',
    reemplazaA: 'depositos/uid_moto/dep1/boucher.jpg',
  })
})

test('EV9 · reemplazaA nombra el PATH anterior: el legacy no tiene versionId', () => {
  const e = camposEventoBoucherReemplazado(ACTOR, AHORA, {
    version: 2, versionId: 'v2', path: 'p2', reemplazaA: 'depositos/u/d/boucher.jpg', motivo: 'motivo ok',
  })
  assert.equal(e.reemplazaA, 'depositos/u/d/boucher.jpg')
})

test('EV10 · la primera subida no exige motivo, y no lo inventa', () => {
  const e = camposEventoBoucherSubido({ uid: 'uid_moto', rol: 'motorizado' }, AHORA, {
    version: 1, versionId: 'v1', path: 'p1',
  })
  assert.equal('motivo' in e, false)
  assert.equal(e.tipo, 'BOUCHER_SUBIDO')
})

test('EV11 · un motivo colado en un tipo que no lo lleva se descarta', () => {
  // No se persiste un campo que Rules no espera ni valida.
  const e = camposEventoDepositoConfirmado(ACTOR, AHORA) as Record<string, unknown>
  assert.equal('motivo' in e, false)
})

test('EV12 · devolver, rehacer y anular fallan sin motivo utilizable', () => {
  assert.throws(() => camposEventoDepositoDevuelto(ACTOR, AHORA, ''), /motivo es obligatorio/)
  assert.throws(() => camposEventoDepositoRehecho(ACTOR, AHORA, 'no'), /motivo es obligatorio/)
  assert.throws(() => camposEventoDepositoAnulado(ACTOR, AHORA, 'x'.repeat(301)), /motivo es obligatorio/)
  assert.equal(camposEventoDepositoDevuelto(ACTOR, AHORA, 'falta el monto').motivo, 'falta el monto')
})

// ── Presentación ─────────────────────────────────────────────────────────────

test('EV13 · cada tipo tiene copy del HECHO, nunca del actor', () => {
  assert.equal(etiquetaEventoDeposito('DEPOSITO_DEVUELTO'), 'Corrección solicitada')
  assert.equal(etiquetaEventoDeposito('BOUCHER_REEMPLAZADO'), 'Comprobante reemplazado')
  assert.equal(etiquetaEventoDeposito('DEPOSITO_REHECHO'), 'Depósito devuelto a revisión')
  assert.equal(etiquetaEventoDeposito('DEPOSITO_ANULADO'), 'Depósito anulado')
})

test('EV14 · un tipo desconocido no se traduce a prosa inventada', () => {
  assert.equal(etiquetaEventoDeposito('DEPOSITO_TELETRANSPORTADO'), TITULO_EVENTO_GENERICO)
  assert.equal(etiquetaEventoDeposito(null), TITULO_EVENTO_GENERICO)
})

test('EV15 · las filas salen más recientes primero, con el actor resuelto', () => {
  const ms = (v: unknown) => (typeof v === 'number' ? v : 0)
  const filas = filasEventosDeposito(
    [
      { id: 'a', tipo: 'BOUCHER_SUBIDO', at: 100, porUid: 'uid_moto', porRol: 'motorizado' },
      { id: 'b', tipo: 'DEPOSITO_DEVUELTO', at: 300, porUid: 'uid_gestor', porRol: 'gestor', motivo: 'otra foto' },
      { id: 'c', tipo: 'BOUCHER_REEMPLAZADO', at: 200, porUid: 'uid_moto', porRol: 'motorizado', version: 2 },
    ],
    { uid_gestor: 'Ana' },
    ms,
  )
  assert.deepEqual(filas.map((f) => f.id), ['b', 'c', 'a'])
  assert.equal(filas[0].titulo, 'Corrección solicitada')
  assert.equal(filas[0].actor?.nombre, 'Ana')
  assert.equal(filas[0].actor?.tieneNombre, true)
  assert.equal(filas[0].motivo, 'otra foto')
  // Sin nombre resuelto no se muestra el UID.
  assert.equal(filas[1].actor?.tieneNombre, false)
  assert.equal(filas[1].version, 2)
})

test('EV16 · un evento recién escrito (at todavía nulo) no se va al fondo', () => {
  // serverTimestamp() llega null desde la caché local hasta que el servidor
  // responde: ordenar solo por `at` lo mandaría al final de la lista.
  const filas = filasEventosDeposito([
    { id: 'viejo', tipo: 'BOUCHER_SUBIDO', at: 100, porUid: 'u' },
    { id: 'zNuevo', tipo: 'DEPOSITO_DEVUELTO', at: null, porUid: 'u', motivo: 'x' },
  ], {}, (v) => (typeof v === 'number' ? v : 0))
  assert.equal(filas[0].id, 'zNuevo')
})
