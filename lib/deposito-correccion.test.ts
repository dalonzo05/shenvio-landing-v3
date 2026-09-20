// DEPOSITO-AUDITORIA-1 — "Pedir corrección" y "Anular".
//
// La prueba central de este módulo es negativa: qué campos NO viajan. El
// viejo "Devolver al motorizado" borraba el documento entero; el nuevo no
// puede terminar tocando el monto, las órdenes o el comprobante por descuido,
// porque entonces habría cambiado el depósito en vez de pedir una foto.

import test from 'node:test'
import assert from 'node:assert/strict'
import {
  BOTON_PEDIR_CORRECCION,
  ESTADO_DEVUELTO,
  ESTADOS_PEDIR_CORRECCION,
  ETIQUETA_DEVUELTO,
  TEXTO_ESPERANDO_CORRECCION,
  accionesDeposito,
  camposAnularDeposito,
  camposConfirmarDeposito,
  camposPedirCorreccion,
  camposRehacerDeposito,
  correccionSolicitada,
  puedeConfirmarDeposito,
  puedePedirCorreccion,
} from './deposito-correccion'

const AHORA = '<<serverTimestamp>>'
const UID_GESTOR = 'uid_gestor'
const A = { tipo: 'recaudacion_motorizado_storkhub', estado: 'en_revision' }
const B = { tipo: 'recaudacion_motorizado_comercio', estado: 'en_revision' }
const C = { tipo: 'pago_delivery_deposito', estado: 'confirmado' }

// ── Aplicabilidad ────────────────────────────────────────────────────────────

test('CO1 · solo se pide corrección sobre un A/B en revisión', () => {
  assert.deepEqual([...ESTADOS_PEDIR_CORRECCION], ['en_revision'])
  assert.equal(puedePedirCorreccion(A), true)
  assert.equal(puedePedirCorreccion(B), true)
  for (const estado of ['pendiente_boucher', 'devuelto', 'confirmado', 'convertido_en_deuda', 'anulado', 'rechazado']) {
    assert.equal(puedePedirCorreccion({ ...A, estado }), false, estado)
  }
})

test('CO2 · el tipo C queda fuera: su corrección es Revertir, en Cobros', () => {
  assert.equal(puedePedirCorreccion(C), false)
  assert.equal(puedePedirCorreccion({ ...C, estado: 'en_revision' }), false)
})

test('CO3 · un depósito devuelto no se confirma: primero tiene que llegar la foto', () => {
  assert.equal(puedeConfirmarDeposito({ ...A, estado: ESTADO_DEVUELTO }), false)
  assert.equal(puedeConfirmarDeposito(A), true)
})

// ── Campos de "Pedir corrección" ─────────────────────────────────────────────

test('CO4 · la devolución escribe exactamente seis campos, y ninguno más', () => {
  const campos = camposPedirCorreccion(UID_GESTOR, AHORA, '  No se lee el monto  ', 'ev1')
  assert.deepEqual(Object.keys(campos).sort(), [
    'devueltoAt', 'devueltoPorUid', 'estado', 'motivoDevolucion', 'ultimoEventoId', 'updatedAt',
  ])
  assert.equal(campos.estado, 'devuelto')
  assert.equal(campos.devueltoPorUid, UID_GESTOR)
  assert.equal(campos.motivoDevolucion, 'No se lee el monto')
})

test('CO5 · la devolución NO toca la identidad ni el dinero del depósito', () => {
  const campos = camposPedirCorreccion(UID_GESTOR, AHORA, 'motivo suficiente', 'ev1')
  for (const prohibido of [
    'boucher', 'boucherUrl', 'boucherVersion', 'montoTotal', 'solicitudIds',
    'motorizadoUid', 'tipo', 'destinatario', 'destinatarioId', 'codigo', 'secuencia',
  ]) {
    assert.equal(prohibido in campos, false, `no debería escribir ${prohibido}`)
  }
})

test('CO6 · sin motivo utilizable o sin actor, no se escribe nada', () => {
  assert.throws(() => camposPedirCorreccion(UID_GESTOR, AHORA, 'no', 'ev1'), /motivo es obligatorio/)
  assert.throws(() => camposPedirCorreccion(UID_GESTOR, AHORA, 'x'.repeat(301), 'ev1'), /motivo es obligatorio/)
  assert.throws(() => camposPedirCorreccion('', AHORA, 'motivo suficiente', 'ev1'), /UID/)
  assert.throws(() => camposPedirCorreccion(null, AHORA, 'motivo suficiente', 'ev1'), /UID/)
})

// ── Campos de "Anular" y "Rehacer" ───────────────────────────────────────────

test('CO7 · anular deja estado, actor, hora y motivo — y no borra nada', () => {
  const campos = camposAnularDeposito('uid_admin', AHORA, 'Órdenes equivocadas', 'ev2')
  assert.equal(campos.estado, 'anulado')
  assert.equal(campos.anuladoPorUid, 'uid_admin')
  assert.equal(campos.motivoAnulacion, 'Órdenes equivocadas')
  assert.equal('boucher' in campos, false)
  assert.equal('solicitudIds' in campos, false)
})

test('CO7b · confirmar escribe el puntero al evento: sin él Rules no puede exigirlo', () => {
  // HARDENING — `ultimoEventoId` es lo único que permite a firestore.rules
  // nombrar el evento DEPOSITO_CONFIRMADO y hacerle existsAfter(). Sin el
  // campo, la auditoría de la confirmación volvería a depender del writer.
  const campos = camposConfirmarDeposito(UID_GESTOR, AHORA, 'ev1')
  assert.deepEqual(Object.keys(campos).sort(), ['confirmadoAt', 'confirmadoPorUid', 'estado', 'ultimoEventoId'])
  assert.equal(campos.estado, 'confirmado')
  assert.equal(campos.ultimoEventoId, 'ev1')
  // Confirmar no deshace nada: no lleva motivo.
  assert.equal('motivo' in campos, false)
  assert.throws(() => camposConfirmarDeposito('', AHORA, 'ev1'), /UID/)
  assert.throws(() => camposConfirmarDeposito(UID_GESTOR, AHORA, ''), /evento de auditoría/)
})

test('CO8 · rehacer ahora exige motivo: antes era un cambio de estado mudo', () => {
  assert.throws(() => camposRehacerDeposito('uid_admin', AHORA, '', 'ev3'), /motivo es obligatorio/)
  const campos = camposRehacerDeposito('uid_admin', AHORA, 'El comprobante era de otro depósito', 'ev3')
  assert.equal(campos.estado, 'en_revision')
  assert.equal(campos.motivoRehacer, 'El comprobante era de otro depósito')
  assert.equal(campos.rehechoPorUid, 'uid_admin')
})

// ── Presentación ─────────────────────────────────────────────────────────────

test('CO9 · el estado se llama "Corrección solicitada", nunca "Rechazado"', () => {
  assert.equal(ETIQUETA_DEVUELTO, 'Corrección solicitada')
  assert.doesNotMatch(ETIQUETA_DEVUELTO, /rechaz/i)
  assert.equal(BOTON_PEDIR_CORRECCION, 'Pedir corrección')
  assert.match(TEXTO_ESPERANDO_CORRECCION, /nuevo comprobante/)
})

test('CO10 · la corrección vigente se muestra solo mientras el DEP siga devuelto', () => {
  const dep = {
    estado: ESTADO_DEVUELTO,
    motivoDevolucion: '  No se lee el monto  ',
    devueltoAt: 1234,
    devueltoPorUid: UID_GESTOR,
  }
  const c = correccionSolicitada(dep, { [UID_GESTOR]: 'Ana' })
  assert.equal(c?.motivo, 'No se lee el monto')
  assert.equal(c?.at, 1234)
  assert.equal(c?.actor?.nombre, 'Ana')
  // Ya reenviado: el documento conserva el motivo como historial, pero la
  // pantalla no está esperando nada.
  assert.equal(correccionSolicitada({ ...dep, estado: 'en_revision' }), null)
  assert.equal(correccionSolicitada(null), null)
})

test('CO11 · sin nombre resuelto se dice "Usuario interno", nunca el UID', () => {
  const c = correccionSolicitada({ estado: ESTADO_DEVUELTO, devueltoPorUid: UID_GESTOR, motivoDevolucion: 'x' }, {})
  assert.equal(c?.actor?.tieneNombre, false)
  assert.notEqual(c?.actor?.nombre, UID_GESTOR)
})

// ── Acciones por rol ─────────────────────────────────────────────────────────

test('CO12 · Pedir corrección es de staff; Rehacer y Anular, solo del admin', () => {
  assert.deepEqual(accionesDeposito(A, 'gestor'), { pedirCorreccion: true, rehacer: false, anular: false })
  assert.deepEqual(accionesDeposito(A, 'admin'), { pedirCorreccion: true, rehacer: true, anular: true })
  assert.deepEqual(accionesDeposito(A, 'motorizado'), { pedirCorreccion: false, rehacer: false, anular: false })
  assert.deepEqual(accionesDeposito(A, 'digitador'), { pedirCorreccion: false, rehacer: false, anular: false })
})

test('CO13 · sobre un confirmado el gestor no tiene ninguna de las tres', () => {
  const conf = { ...A, estado: 'confirmado' }
  assert.deepEqual(accionesDeposito(conf, 'gestor'), { pedirCorreccion: false, rehacer: false, anular: false })
  assert.deepEqual(accionesDeposito(conf, 'admin'), { pedirCorreccion: false, rehacer: true, anular: true })
})

test('CO14 · un convertido en deuda no se rehace, pero sí se puede anular', () => {
  // El saldo vive en saldos_cargo_motorizado y Rehacer no lo anula: misma
  // razón que eliminarLiberaOrdenes() lleva documentando desde F1.
  assert.deepEqual(accionesDeposito({ ...A, estado: 'convertido_en_deuda' }, 'admin'),
    { pedirCorreccion: false, rehacer: false, anular: true })
})

test('CO15 · un anulado es terminal: ya no ofrece nada', () => {
  assert.deepEqual(accionesDeposito({ ...A, estado: 'anulado' }, 'admin'),
    { pedirCorreccion: false, rehacer: false, anular: false })
})

test('CO16 · el tipo C no ofrece ninguna acción de Depósitos, ni al admin', () => {
  assert.deepEqual(accionesDeposito(C, 'admin'), { pedirCorreccion: false, rehacer: false, anular: false })
})
