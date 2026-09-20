// DEPOSITO-AUDITORIA-1 — versionado inmutable del comprobante.
//
// El caso que más importa acá es el LEGACY: los cuatro depósitos que ya
// existen en staging no tienen `boucherVersion` y no se migran. Si la versión
// efectiva de uno de ellos no fuera 1, su primer reemplazo pediría una v1 (o
// una vN cualquiera) y firestore.rules lo denegaría — o peor, lo aceptaría
// pisando el número de otra versión.

import test from 'node:test'
import assert from 'node:assert/strict'
import {
  AVISO_REEMPLAZO_BOUCHER,
  ESTADOS_REEMPLAZO_BOUCHER,
  VERSION_BOUCHER_LEGACY,
  asegurarVersionId,
  camposReemplazoBoucher,
  ESTADOS_REEMPLAZO_BOUCHER_DIGITADOR,
  depositoAdmiteVersionBoucher,
  digitadorPuedeReemplazarBoucher,
  esBoucherLegacy,
  esPrimeraCargaBoucher,
  etiquetaVersionBoucher,
  eventoReemplazoBoucher,
  motorizadoPuedeReemplazarBoucher,
  pathBoucherLegacy,
  pathVersionBoucher,
  planReemplazoBoucher,
  puedeReemplazarBoucher,
  siguienteVersionBoucher,
  staffPuedeReemplazarBoucher,
  versionEfectivaBoucher,
  versionIdValido,
  versionIdVigente,
} from './deposito-boucher-version'

const UID = 'uid_moto'
const DEP = 'dep1'
const AHORA = '<<serverTimestamp>>'
const VID = 'verSegundaAAA1'

const legacy = { id: DEP, motorizadoUid: UID, tipo: 'recaudacion_motorizado_storkhub', estado: 'en_revision' }
const v2 = { ...legacy, boucherVersion: 2, boucherVersionId: 'verPrimeraAAA1' }

// ── Versión efectiva ─────────────────────────────────────────────────────────

test('BV1 · sin boucherVersion, la efectiva es 1: es la regla legacy, no un default cosmético', () => {
  assert.equal(VERSION_BOUCHER_LEGACY, 1)
  assert.equal(versionEfectivaBoucher(legacy), 1)
  assert.equal(versionEfectivaBoucher(null), 1)
  assert.equal(versionEfectivaBoucher({}), 1)
  assert.equal(esBoucherLegacy(legacy), true)
  assert.equal(versionIdVigente(legacy), null)
})

test('BV2 · un campo corrupto no permite saltarse versiones', () => {
  for (const v of [0, -3, 1.5, NaN, Infinity, '2' as unknown as number]) {
    assert.equal(versionEfectivaBoucher({ boucherVersion: v as number }), 1, `valor ${String(v)}`)
  }
})

test('BV3 · el primer reemplazo de un legacy pide la 2, no la 1', () => {
  assert.equal(siguienteVersionBoucher(legacy), 2)
  assert.equal(siguienteVersionBoucher(v2), 3)
})

test('BV4 · un documento con versión pero sin versionId sigue siendo legacy', () => {
  // El número solo no dice dónde está el objeto: el path lo da el versionId.
  assert.equal(esBoucherLegacy({ boucherVersion: 1 }), true)
  assert.equal(esBoucherLegacy({ boucherVersion: 2, boucherVersionId: '  ' }), true)
  assert.equal(esBoucherLegacy(v2), false)
})

// ── Paths ────────────────────────────────────────────────────────────────────

test('BV5 · el path versionado y el legacy conviven, y no se pisan', () => {
  assert.equal(pathBoucherLegacy(UID, DEP), 'depositos/uid_moto/dep1/boucher.jpg')
  assert.equal(pathVersionBoucher(UID, DEP, VID), 'depositos/uid_moto/dep1/bouchers/verSegundaAAA1.jpg')
})

test('BV6 · el versionId se valida con la MISMA forma que storage.rules', () => {
  assert.equal(versionIdValido(VID), true)
  assert.equal(versionIdValido('abc'), false)             // menos de 8
  assert.equal(versionIdValido('con espacio__'), false)
  assert.equal(versionIdValido('../../otro_dep'), false)  // no escapa del path
  assert.equal(versionIdValido('x'.repeat(65)), false)
  assert.equal(versionIdValido(null), false)
  assert.throws(() => asegurarVersionId('abc'), /identificador de versión/)
})

// ── Quién y desde dónde ──────────────────────────────────────────────────────

test('BV7 · solo en_revision y devuelto admiten versión nueva', () => {
  assert.deepEqual([...ESTADOS_REEMPLAZO_BOUCHER], ['en_revision', 'devuelto'])
  for (const estado of ['en_revision', 'devuelto']) {
    assert.equal(depositoAdmiteVersionBoucher({ ...legacy, estado }), true, estado)
  }
  // 'pendiente_boucher' es el flujo inicial de F1, no una corrección.
  // 'rechazado' cierra W4. Los tres sellados no se reabren con una foto.
  for (const estado of ['pendiente_boucher', 'rechazado', 'confirmado', 'convertido_en_deuda', 'anulado']) {
    assert.equal(depositoAdmiteVersionBoucher({ ...legacy, estado }), false, estado)
  }
})

test('BV8 · el tipo C nunca se versiona desde Depósitos', () => {
  assert.equal(depositoAdmiteVersionBoucher({ ...legacy, tipo: 'pago_delivery_deposito' }), false)
  assert.equal(staffPuedeReemplazarBoucher({ ...legacy, tipo: 'pago_delivery_deposito' }), false)
})

test('BV9 · el motorizado solo corrige lo suyo, por UID', () => {
  assert.equal(motorizadoPuedeReemplazarBoucher(legacy, UID), true)
  assert.equal(motorizadoPuedeReemplazarBoucher(legacy, 'otro'), false)
  assert.equal(motorizadoPuedeReemplazarBoucher(legacy, ''), false)
  assert.equal(motorizadoPuedeReemplazarBoucher(legacy, null), false)
  assert.equal(motorizadoPuedeReemplazarBoucher({ ...legacy, estado: 'confirmado' }, UID), false)
})

// ── Digitador ────────────────────────────────────────────────────────────────

test('BV9b · el digitador corrige SU digitación, y solo en revisión', () => {
  const digitado = { ...legacy, digitadoPorUid: 'uid_dig' }
  assert.deepEqual([...ESTADOS_REEMPLAZO_BOUCHER_DIGITADOR], ['en_revision'])
  assert.equal(digitadorPuedeReemplazarBoucher(digitado, 'uid_dig'), true)
  assert.equal(digitadorPuedeReemplazarBoucher(digitado, 'uid_otro'), false)
  assert.equal(digitadorPuedeReemplazarBoucher(digitado, ''), false)
  // Un depósito sin digitar (del motorizado) no es suyo.
  assert.equal(digitadorPuedeReemplazarBoucher(legacy, 'uid_dig'), false)
  // 'devuelto' queda FUERA: es una corrección que StorkHub le pide al
  // motorizado titular, y el modelo actual no le da esa operación al digitador.
  assert.equal(digitadorPuedeReemplazarBoucher({ ...digitado, estado: 'devuelto' }, 'uid_dig'), false)
  // 'pendiente_boucher' tampoco: eso es primera carga, no reemplazo.
  assert.equal(digitadorPuedeReemplazarBoucher({ ...digitado, estado: 'pendiente_boucher' }, 'uid_dig'), false)
  for (const estado of ['confirmado', 'convertido_en_deuda', 'anulado', 'rechazado']) {
    assert.equal(digitadorPuedeReemplazarBoucher({ ...digitado, estado }, 'uid_dig'), false, estado)
  }
})

test('BV9c · una sola puerta por rol, para que UI y writer no diverjan de Rules', () => {
  const digitado = { ...legacy, digitadoPorUid: 'uid_dig' }
  assert.equal(puedeReemplazarBoucher(digitado, 'uid_dig', 'digitador'), true)
  assert.equal(puedeReemplazarBoucher(digitado, 'uid_dig', 'gestor'), true)
  assert.equal(puedeReemplazarBoucher(legacy, UID, 'motorizado'), true)
  assert.equal(puedeReemplazarBoucher(legacy, UID, 'digitador'), false)
  assert.equal(puedeReemplazarBoucher(legacy, UID, 'Comercio'), false)
  assert.equal(puedeReemplazarBoucher(legacy, UID, null), false)
  // El motorizado sobre un depósito ajeno, no.
  assert.equal(puedeReemplazarBoucher(legacy, 'uid_otro', 'motorizado'), false)
})

test('BV9d · primera carga y reemplazo son dos cosas distintas', () => {
  // El writer del panel mandaba las dos por la ruta versionada, y "Subir
  // boucher" sobre un pendiente_boucher moría contra Rules.
  assert.equal(esPrimeraCargaBoucher({ ...legacy, estado: 'pendiente_boucher', boucher: null }), true)
  assert.equal(esPrimeraCargaBoucher({ ...legacy, estado: 'pendiente_boucher' }), true)
  assert.equal(esPrimeraCargaBoucher({ ...legacy, estado: 'pendiente_boucher', boucher: { url: '  ' } }), true)
  // Ya hay comprobante vigente: es reemplazo, aunque el estado engañe.
  assert.equal(esPrimeraCargaBoucher({ ...legacy, estado: 'pendiente_boucher', boucher: { url: 'https://x/y.jpg' } }), false)
  // Y en revisión nunca es primera carga.
  assert.equal(esPrimeraCargaBoucher({ ...legacy, estado: 'en_revision', boucher: null }), false)
})

// ── Plan ─────────────────────────────────────────────────────────────────────

test('BV10 · el plan de un legacy: v2, path nuevo, y reemplazaA apuntando al boucher.jpg', () => {
  const plan = planReemplazoBoucher(legacy, VID, '  La foto salió movida  ')
  assert.deepEqual(plan, {
    version: 2,
    versionId: VID,
    path: 'depositos/uid_moto/dep1/bouchers/verSegundaAAA1.jpg',
    reemplazaA: 'depositos/uid_moto/dep1/boucher.jpg',
    motivo: 'La foto salió movida',
  })
})

test('BV11 · el plan de un ya versionado apunta a la versión anterior', () => {
  const plan = planReemplazoBoucher(v2, VID, 'motivo suficiente')
  assert.equal(plan.version, 3)
  assert.equal(plan.reemplazaA, 'depositos/uid_moto/dep1/bouchers/verPrimeraAAA1.jpg')
})

test('BV12 · el plan corta ANTES de subir si el motivo o el id no sirven', () => {
  // Importa el orden: un objeto subido ya no se puede borrar (delete DENY).
  assert.throws(() => planReemplazoBoucher(legacy, VID, 'no'), /motivo es obligatorio/)
  assert.throws(() => planReemplazoBoucher(legacy, 'abc', 'motivo suficiente'), /identificador de versión/)
  assert.throws(() => planReemplazoBoucher({ ...legacy, motorizadoUid: '' }, VID, 'motivo suficiente'), /motorizadoUid/)
})

// ── Payload ──────────────────────────────────────────────────────────────────

test('BV13 · los campos del reemplazo son exactamente los que Rules acepta', () => {
  const plan = planReemplazoBoucher(legacy, VID, 'motivo suficiente')
  const campos = camposReemplazoBoucher(plan, { url: 'https://x/y.jpg', pathStorage: plan.path }, UID, AHORA, 'ev1')
  assert.deepEqual(Object.keys(campos).sort(), [
    'boucher', 'boucherVersion', 'boucherVersionId', 'estado', 'ultimoEventoId', 'updatedAt',
  ])
  assert.equal(campos.estado, 'en_revision')
  assert.equal(campos.boucherVersion, 2)
  assert.equal(campos.boucherVersionId, VID)
  assert.deepEqual(campos.boucher, { url: 'https://x/y.jpg', pathStorage: plan.path, uploadedAt: AHORA, motorizadoUid: UID })
})

test('BV14 · el reemplazo NO toca monto, órdenes, tipo, destinatario ni código', () => {
  const plan = planReemplazoBoucher(legacy, VID, 'motivo suficiente')
  const campos = camposReemplazoBoucher(plan, { url: 'u', pathStorage: plan.path }, UID, AHORA, 'ev1')
  for (const prohibido of [
    'montoTotal', 'montoBruto', 'gastosDescontados', 'solicitudIds', 'motorizadoUid',
    'destinatarioTipo', 'destinatarioId', 'destinatario', 'tipo', 'codigo', 'secuencia',
    'confirmadoAt', 'confirmadoPorUid',
  ]) {
    assert.equal(prohibido in campos, false, `no debería escribir ${prohibido}`)
  }
})

test('BV15 · desde devuelto el destino también es en_revision: vuelve a la cola del gestor', () => {
  const plan = planReemplazoBoucher({ ...legacy, estado: 'devuelto' }, VID, 'motivo suficiente')
  const campos = camposReemplazoBoucher(plan, { url: 'u', pathStorage: plan.path }, UID, AHORA, 'ev1')
  assert.equal(campos.estado, 'en_revision')
})

test('BV16 · el evento del reemplazo describe la MISMA versión que el depósito', () => {
  const plan = planReemplazoBoucher(legacy, VID, 'motivo suficiente')
  const campos = camposReemplazoBoucher(plan, { url: 'u', pathStorage: plan.path }, UID, AHORA, 'ev1')
  const evento = eventoReemplazoBoucher(plan, { uid: UID, rol: 'motorizado' }, AHORA)
  assert.equal(evento.version, campos.boucherVersion)
  assert.equal(evento.versionId, campos.boucherVersionId)
  assert.equal(evento.path, (campos.boucher as { pathStorage: string }).pathStorage)
  assert.equal(evento.tipo, 'BOUCHER_REEMPLAZADO')
})

// ── Presentación ─────────────────────────────────────────────────────────────

test('BV17 · un depósito nunca reemplazado no dice "Versión 1"', () => {
  assert.equal(etiquetaVersionBoucher(legacy), null)
  assert.equal(etiquetaVersionBoucher(v2), 'Versión 2')
})

test('BV18 · el aviso al motorizado promete que no se pierde nada', () => {
  assert.match(AVISO_REEMPLAZO_BOUCHER, /historial/)
})
