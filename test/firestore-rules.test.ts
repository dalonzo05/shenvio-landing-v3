// IDENTIDAD-HUMANA-1 — cobertura automática de firestore.rules.
//
// Carga el `firestore.rules` REAL del repo en el emulador y comprueba
// ALLOW/DENY de verdad. No duplica ninguna condición en TypeScript: si estos
// tests se cumplieran contra una réplica de las reglas, no probarían nada —
// el bug que importa es justamente que la regla desplegada diga otra cosa.
//
// Se ejecuta aparte de `npm test` (que es puro y no necesita emulador):
//
//     npm run test:rules
//
// El arnés es focal y reutilizable: `usuarios`, `comercios` y los actores de
// cada rol se siembran una vez con las reglas desactivadas, y cada caso
// escribe solo el documento que necesita.

import { test, before, after, beforeEach } from 'node:test'
import { readFileSync } from 'node:fs'
import {
  initializeTestEnvironment,
  assertSucceeds,
  assertFails,
  type RulesTestEnvironment,
} from '@firebase/rules-unit-testing'
import assert from 'node:assert/strict'
import {
  doc, setDoc, updateDoc, getDoc, deleteField, serverTimestamp,
  collection, query, where, limit, getDocs, writeBatch, deleteDoc, addDoc, Timestamp, arrayUnion,
} from 'firebase/firestore'
import {
  camposEventoBoucherReemplazado,
  camposEventoDepositoAnulado,
  camposEventoDepositoConfirmado,
  camposEventoDepositoDevuelto,
  camposEventoDepositoRehecho,
} from '../lib/deposito-eventos'
import { liberarGastosDeDeposito, marcarGastosConsumidos } from '../lib/deposito-motorizado-envio'
import {
  camposReemplazoBoucher,
  planReemplazoBoucher,
  pathVersionBoucher,
} from '../lib/deposito-boucher-version'
import {
  agregarAnulacionDeMovimientosAlBatch,
  camposAnularDeposito,
  camposConfirmarDeposito,
  camposPedirCorreccion,
  camposRehacerDeposito,
} from '../lib/deposito-correccion'
import { camposEnlaceDigitacion, camposLiberacionDeposito, camposReaperturaRevision } from '../lib/deposito-transiciones'

// Identidades del arnés. El rol de comercio es 'Comercio' con mayúscula: así
// está en las reglas y así se escribe en `usuarios`.
const UID_COMERCIO = 'uid_comercio'
const UID_GESTOR = 'uid_gestor'
const UID_MOTO = 'uid_moto'
// MOTO-ASIGNACION-RULES-CIERRE-1 — un segundo motorizado REAL (activo, rol
// motorizado) para probar ownership cruzado y reasignación sin mocks ambiguos.
const UID_MOTO_B = 'uid_moto_b'
// MOTO-ASIGNACION-RULES-CREATE-1 — un cliente individual real (rol 'cliente'),
// para probar la rama personal del create sin inventar un actor ambiguo.
const UID_CLIENTE = 'uid_cliente'
const UID_DIGITADOR = 'uid_digitador'
const UID_ADMIN = 'uid_admin'
const COMERCIO_ID = 'com1'

let env: RulesTestEnvironment

before(async () => {
  env = await initializeTestEnvironment({
    projectId: 'rules-identidad-humana',
    firestore: {
      rules: readFileSync('firestore.rules', 'utf8'),
      host: '127.0.0.1',
      port: 8080,
    },
  })
  await env.withSecurityRulesDisabled(async (ctx) => {
    const db = ctx.firestore()
    await setDoc(doc(db, 'usuarios', UID_COMERCIO), { activo: true, rol: 'Comercio', comercioId: COMERCIO_ID })
    await setDoc(doc(db, 'usuarios', UID_GESTOR), { activo: true, rol: 'gestor' })
    await setDoc(doc(db, 'usuarios', UID_ADMIN), { activo: true, rol: 'admin' })
    await setDoc(doc(db, 'usuarios', UID_MOTO), { activo: true, rol: 'motorizado' })
    await setDoc(doc(db, 'usuarios', UID_MOTO_B), { activo: true, rol: 'motorizado' })
    await setDoc(doc(db, 'usuarios', UID_CLIENTE), { activo: true, rol: 'cliente' })
    await setDoc(doc(db, 'usuarios', UID_DIGITADOR), { activo: true, rol: 'digitador' })
    await setDoc(doc(db, 'comercios', COMERCIO_ID), { name: 'Mariposita', authUid: UID_COMERCIO })
  })
})

after(async () => { await env?.cleanup() })

/** Cada caso arranca sin documentos de negocio; los actores se conservan. */
beforeEach(async () => {
  await env.clearFirestore()
  await env.withSecurityRulesDisabled(async (ctx) => {
    const db = ctx.firestore()
    await setDoc(doc(db, 'usuarios', UID_COMERCIO), { activo: true, rol: 'Comercio', comercioId: COMERCIO_ID })
    await setDoc(doc(db, 'usuarios', UID_GESTOR), { activo: true, rol: 'gestor' })
    await setDoc(doc(db, 'usuarios', UID_ADMIN), { activo: true, rol: 'admin' })
    await setDoc(doc(db, 'usuarios', UID_MOTO), { activo: true, rol: 'motorizado' })
    await setDoc(doc(db, 'usuarios', UID_MOTO_B), { activo: true, rol: 'motorizado' })
    await setDoc(doc(db, 'usuarios', UID_CLIENTE), { activo: true, rol: 'cliente' })
    await setDoc(doc(db, 'usuarios', UID_DIGITADOR), { activo: true, rol: 'digitador' })
    await setDoc(doc(db, 'comercios', COMERCIO_ID), { name: 'Mariposita', authUid: UID_COMERCIO })
  })
})

const como =(uid: string) => env.authenticatedContext(uid).firestore()

/** Orden mínima que las reglas aceptan como creación legítima de comercio. */
function ordenBase(extra: Record<string, unknown> = {}) {
  return {
    comercioId: COMERCIO_ID,
    userId: COMERCIO_ID,
    comercioUid: COMERCIO_ID,
    ownerSnapshot: { uid: COMERCIO_ID, companyName: 'Mariposita' },
    estado: 'pendiente_confirmacion',
    tipoCliente: 'contado',
    createdAt: serverTimestamp(),
    ...extra,
  }
}

/** Depósito mínimo que las reglas aceptan del motorizado. */
function depositoBase(extra: Record<string, unknown> = {}) {
  return {
    creadoAt: serverTimestamp(),
    tipo: 'recaudacion_motorizado_storkhub',
    estado: 'pendiente_boucher',
    destinatario: 'storkhub',
    destinatarioId: 'storkhub',
    destinatarioNombre: 'Storkhub',
    motorizadoUid: UID_MOTO,
    motorizadoNombre: 'John Pork',
    solicitudIds: ['ord1'],
    montoTotal: 110,
    ...extra,
  }
}

// ── HARDENING · confirmar, rehacer y anular exigen su evento ────────────────
//
// Estos tres helpers existen para que los casos de F1 que YA probaban esas
// transiciones sigan probando lo mismo, ahora con la forma que Rules exige.
// Construyen el batch completo (documento + evento) con los mismos helpers
// puros que usa el writer de la app.

/** Confirmación auditada de un A/B: documento + DEPOSITO_CONFIRMADO. */
function batchConfirmar(uid: string, depId: string, extra: Record<string, unknown> = {}, eventoId = nuevoEventoId()) {
  const db = como(uid)
  const rol = uid === UID_ADMIN ? 'admin' : 'gestor'
  const b = writeBatch(db)
  b.set(doc(db, 'ordenes_deposito', depId), {
    ...camposConfirmarDeposito(uid, serverTimestamp(), eventoId),
    ...extra,
  }, { merge: true })
  b.set(doc(db, 'ordenes_deposito', depId, 'eventos', eventoId),
    camposEventoDepositoConfirmado({ uid, rol }, serverTimestamp()))
  return { db, b }
}

/** Rehacer auditado: documento + DEPOSITO_REHECHO con motivo. */
function batchRehacer(uid: string, depId: string, motivo = 'El comprobante era de otro depósito', eventoId = nuevoEventoId()) {
  const db = como(uid)
  const rol = uid === UID_ADMIN ? 'admin' : 'gestor'
  const b = writeBatch(db)
  b.set(doc(db, 'ordenes_deposito', depId),
    camposRehacerDeposito(uid, serverTimestamp(), motivo, eventoId), { merge: true })
  b.set(doc(db, 'ordenes_deposito', depId, 'eventos', eventoId),
    camposEventoDepositoRehecho({ uid, rol }, serverTimestamp(), motivo))
  return { db, b }
}

// ─── solicitudes_envio · CREATE ──────────────────────────────────────────────

test('A · comercio crea una orden normal, sin codigo ni secuencia ⇒ ALLOW', async () => {
  await assertSucceeds(setDoc(doc(como(UID_COMERCIO), 'solicitudes_envio', 'ordA'), ordenBase()))
})

test('B · gestor crea una orden normal ⇒ ALLOW', async () => {
  await assertSucceeds(setDoc(doc(como(UID_GESTOR), 'solicitudes_envio', 'ordB'), ordenBase()))
})

test('C · comercio intenta crear con codigo ⇒ DENY', async () => {
  await assertFails(setDoc(doc(como(UID_COMERCIO), 'solicitudes_envio', 'ordC'), ordenBase({ codigo: 'SH-9999' })))
})

test('D · comercio intenta crear con secuencia ⇒ DENY', async () => {
  await assertFails(setDoc(doc(como(UID_COMERCIO), 'solicitudes_envio', 'ordD'), ordenBase({ secuencia: 9999 })))
})

test('E · comercio intenta crear con los dos ⇒ DENY', async () => {
  await assertFails(setDoc(doc(como(UID_COMERCIO), 'solicitudes_envio', 'ordE'), ordenBase({ codigo: 'SH-9999', secuencia: 9999 })))
})

test('E2 · tampoco el gestor puede sembrar el codigo al crear ⇒ DENY', async () => {
  // "Cliente" a efectos de Rules es cualquiera que pase por ellas, gestor
  // incluido: el trigger usa Admin SDK y no evalúa este archivo.
  await assertFails(setDoc(doc(como(UID_GESTOR), 'solicitudes_envio', 'ordE2'), ordenBase({ codigo: 'SH-9999' })))
  await assertFails(setDoc(doc(como(UID_GESTOR), 'solicitudes_envio', 'ordE3'), ordenBase({ secuencia: 1 })))
})

// ─── solicitudes_envio · UPDATE ──────────────────────────────────────────────

/** Orden ya creada y con código asignado por el trigger. */
async function ordenConCodigo(id = 'ordU', extra: Record<string, unknown> = {}) {
  await env.withSecurityRulesDisabled(async (ctx) => {
    await setDoc(doc(ctx.firestore(), 'solicitudes_envio', id), {
      ...ordenBase(extra),
      codigo: 'SH-1001',
      secuencia: 1001,
    })
  })
  return id
}

test('F · gestor actualiza sin tocar la identidad ⇒ ALLOW', async () => {
  const id = await ordenConCodigo()
  await assertSucceeds(updateDoc(doc(como(UID_GESTOR), 'solicitudes_envio', id), {
    estado: 'confirmada',
    updatedAt: serverTimestamp(),
  }))
})

test('G · gestor intenta cambiar el codigo ⇒ DENY', async () => {
  const id = await ordenConCodigo()
  await assertFails(updateDoc(doc(como(UID_GESTOR), 'solicitudes_envio', id), { codigo: 'SH-9999' }))
})

test('H · gestor intenta cambiar la secuencia ⇒ DENY', async () => {
  const id = await ordenConCodigo()
  await assertFails(updateDoc(doc(como(UID_GESTOR), 'solicitudes_envio', id), { secuencia: 9999 }))
})

test('I · gestor intenta borrar el codigo ⇒ DENY', async () => {
  const id = await ordenConCodigo()
  await assertFails(updateDoc(doc(como(UID_GESTOR), 'solicitudes_envio', id), { codigo: deleteField() }))
})

test('J · gestor intenta borrar la secuencia ⇒ DENY', async () => {
  const id = await ordenConCodigo()
  await assertFails(updateDoc(doc(como(UID_GESTOR), 'solicitudes_envio', id), { secuencia: deleteField() }))
})

// VIAJE-ENTREGADO-SIN-COBRO-1 — CAMBIO DE CONTRATO DELIBERADO.
//
// Este test afirmaba que el motorizado podía escribir 'entregado' por updateDoc
// directo. Ese contrato era el agujero: la entrega la cierra
// confirmarTransicionConCobro, que además escribe cobrosMotorizado,
// cobroDelivery y el marcador del crédito semanal. Ahora la señal que SÍ le
// corresponde (asignada → en_camino_retiro) es lo que demuestra que su rama
// sigue viva, y la entrega por cliente queda denegada.
test('J2 · el motorizado avisa que va en camino, no cierra la entrega, y no toca el codigo', async () => {
  const id = await ordenConCodigo('ordMoto', {
    estado: 'asignada',
    asignacion: { motorizadoAuthUid: UID_MOTO, motorizadoNombre: 'John Pork' },
  })
  // Su señal legítima: sigue pasando.
  await assertSucceeds(updateDoc(doc(como(UID_MOTO), 'solicitudes_envio', id), {
    estado: 'en_camino_retiro',
    updatedAt: serverTimestamp(),
    'historial.en_camino_retiroAt': serverTimestamp(),
  }))
  // El cierre de la entrega, no: es del servidor.
  const idEntrega = await ordenConCodigo('ordMotoEntrega', {
    estado: 'en_camino_entrega',
    asignacion: { motorizadoAuthUid: UID_MOTO, motorizadoNombre: 'John Pork' },
  })
  await assertFails(updateDoc(doc(como(UID_MOTO), 'solicitudes_envio', idEntrega), {
    estado: 'entregado',
    entregadoAt: serverTimestamp(),
    updatedAt: serverTimestamp(),
  }))
  // Su allowlist de raíz sigue dejando fuera codigo/secuencia.
  await assertFails(updateDoc(doc(como(UID_MOTO), 'solicitudes_envio', id), { codigo: 'SH-9999' }))
  await assertFails(updateDoc(doc(como(UID_MOTO), 'solicitudes_envio', id), { secuencia: 2 }))
})

test('J3 · el comercio sube su boucher, y no puede tocar el codigo', async () => {
  const id = 'ordComercio'
  await env.withSecurityRulesDisabled(async (ctx) => {
    await setDoc(doc(ctx.firestore(), 'solicitudes_envio', id), {
      ...ordenBase({ estado: 'entregado' }),
      codigo: 'SH-1002',
      secuencia: 1002,
      cobroDelivery: { estado: 'pendiente', monto: 80 },
    })
  })
  const db = como(UID_COMERCIO)
  // Primera carga legítima: el payload exacto que escribe mis-ordenes.
  await assertSucceeds(updateDoc(doc(db, 'solicitudes_envio', id), {
    'cobroDelivery.estado': 'en_revision_deposito',
    'cobroDelivery.boucherComercio': {
      url: 'https://example.test/b.jpg',
      path: `evidencias/${id}/delivery_boucher_comercio.jpg`,
      at: serverTimestamp(),
    },
    'cobroDelivery.boucherVigente': 'comercio',
    updatedAt: serverTimestamp(),
  }))
  await assertFails(updateDoc(doc(db, 'solicitudes_envio', id), { codigo: 'SH-9999', updatedAt: serverTimestamp() }))
  await assertFails(updateDoc(doc(db, 'solicitudes_envio', id), { secuencia: 3, updatedAt: serverTimestamp() }))
})

// ─── ordenes_deposito · CREATE ───────────────────────────────────────────────

test('K · motorizado crea su depósito sin codigo ⇒ ALLOW', async () => {
  await assertSucceeds(setDoc(doc(como(UID_MOTO), 'ordenes_deposito', 'depK'), depositoBase()))
})

test('K2 · gestor crea un depósito sin codigo ⇒ ALLOW', async () => {
  await assertSucceeds(setDoc(doc(como(UID_GESTOR), 'ordenes_deposito', 'depK2'), depositoBase()))
})

test('K3 · digitador crea su depósito sin codigo ⇒ ALLOW', async () => {
  await assertSucceeds(setDoc(doc(como(UID_DIGITADOR), 'ordenes_deposito', 'depK3'), {
    creadoAt: serverTimestamp(),
    tipo: 'recaudacion_motorizado_storkhub',
    estado: 'pendiente_boucher',
    destinatario: 'storkhub',
    destinatarioId: 'storkhub',
    destinatarioNombre: 'Storkhub',
    motorizadoUid: UID_MOTO,
    motorizadoNombre: 'John Pork',
    solicitudIds: ['ord1'],
    montoTotal: 110,
    digitadoPorUid: UID_DIGITADOR,
    digitadoAt: serverTimestamp(),
  }))
})

test('L · inyectar codigo al crear un depósito ⇒ DENY (las tres ramas)', async () => {
  await assertFails(setDoc(doc(como(UID_MOTO), 'ordenes_deposito', 'depL1'), depositoBase({ codigo: 'DEP-9999' })))
  await assertFails(setDoc(doc(como(UID_GESTOR), 'ordenes_deposito', 'depL2'), depositoBase({ codigo: 'DEP-9999' })))
  await assertFails(setDoc(doc(como(UID_DIGITADOR), 'ordenes_deposito', 'depL3'), depositoBase({
    codigo: 'DEP-9999', digitadoPorUid: UID_DIGITADOR, digitadoAt: serverTimestamp(),
  })))
})

test('M · inyectar secuencia al crear un depósito ⇒ DENY', async () => {
  await assertFails(setDoc(doc(como(UID_MOTO), 'ordenes_deposito', 'depM1'), depositoBase({ secuencia: 9999 })))
  await assertFails(setDoc(doc(como(UID_GESTOR), 'ordenes_deposito', 'depM2'), depositoBase({ secuencia: 9999 })))
})

// ─── ordenes_deposito · UPDATE ───────────────────────────────────────────────

async function depositoConCodigo(id = 'depU', extra: Record<string, unknown> = {}) {
  await env.withSecurityRulesDisabled(async (ctx) => {
    await setDoc(doc(ctx.firestore(), 'ordenes_deposito', id), {
      ...depositoBase(extra),
      codigo: 'DEP-1001',
      secuencia: 1001,
    })
  })
  return id
}

test('N · gestor confirma un depósito escribiendo estado+evento a mano, sin callable ⇒ DENY (FIN-1B: confirmar es de la callable)', async () => {
  // La identidad (codigo/secuencia) la protegen O, P, Q; lo que cambia en FIN-1B es que NINGUNA confirmación nace del cliente.
  const id = await depositoConCodigo('depN', { estado: 'pendiente_boucher' })
  const { b } = batchConfirmar(UID_GESTOR, id, { boucher: { url: 'https://example.test/b.jpg', pathStorage: 'x' } })
  await assertFails(b.commit())
})

test('O · gestor intenta cambiar el codigo del depósito ⇒ DENY', async () => {
  const id = await depositoConCodigo()
  await assertFails(updateDoc(doc(como(UID_GESTOR), 'ordenes_deposito', id), { codigo: 'DEP-9999' }))
})

test('P · gestor intenta cambiar la secuencia del depósito ⇒ DENY', async () => {
  const id = await depositoConCodigo()
  await assertFails(updateDoc(doc(como(UID_GESTOR), 'ordenes_deposito', id), { secuencia: 9999 }))
})

test('Q · borrar codigo o secuencia del depósito ⇒ DENY', async () => {
  const id = await depositoConCodigo()
  const db = como(UID_GESTOR)
  await assertFails(updateDoc(doc(db, 'ordenes_deposito', id), { codigo: deleteField() }))
  await assertFails(updateDoc(doc(db, 'ordenes_deposito', id), { secuencia: deleteField() }))
})

test('Q2 · el motorizado sube su boucher, y no puede tocar el codigo', async () => {
  const id = await depositoConCodigo('depMoto')
  const db = como(UID_MOTO)
  await assertSucceeds(updateDoc(doc(db, 'ordenes_deposito', id), {
    boucher: { url: 'https://example.test/b.jpg', pathStorage: 'x' },
    estado: 'en_revision',
    updatedAt: serverTimestamp(),
  }))
  await assertFails(updateDoc(doc(db, 'ordenes_deposito', id), { codigo: 'DEP-9999' }))
  await assertFails(updateDoc(doc(db, 'ordenes_deposito', id), { secuencia: 5 }))
})

// ─── contadores ──────────────────────────────────────────────────────────────

test('R-U · contadores: read y write denegados a todos los roles cliente', async () => {
  await env.withSecurityRulesDisabled(async (ctx) => {
    await setDoc(doc(ctx.firestore(), 'contadores', 'ordenes'), { valor: 1000 })
    await setDoc(doc(ctx.firestore(), 'contadores', 'depositos'), { valor: 1000 })
  })
  for (const uid of [UID_COMERCIO, UID_GESTOR, UID_MOTO, UID_DIGITADOR]) {
    const db = como(uid)
    for (const c of ['ordenes', 'depositos']) {
      await assertFails(getDoc(doc(db, 'contadores', c)))
      await assertFails(setDoc(doc(db, 'contadores', c), { valor: 999999 }))
      await assertFails(updateDoc(doc(db, 'contadores', c), { valor: 999999 }))
    }
  }
})

test('R-U2 · un contador nuevo tampoco se puede crear desde el cliente', async () => {
  for (const uid of [UID_GESTOR, UID_COMERCIO]) {
    await assertFails(setDoc(doc(como(uid), 'contadores', 'inventado'), { valor: 1 }))
  }
})

// ─── DEPOSITOS-UX-TRAZABILIDAD-1 ─────────────────────────────────────────────
//
// Los writers del gestor que dejan un depósito 'confirmado' ahora escriben
// confirmadoPorUid y confirmadoAt; y el motorizado lee su propio historial con
// una query acotada por motorizadoUid. Ninguna regla cambió: estos casos
// prueban que las reglas vigentes aceptan exactamente eso, y nada más.

test('W1 · gestor registra una confirmación a nombre del motorizado, sin callable ⇒ DENY (FIN-1B)', async () => {
  const id = await depositoConCodigo('depW1', { estado: 'pendiente_boucher' })
  const { b } = batchConfirmar(UID_GESTOR, id, { boucher: { url: 'https://example.test/b.jpg', pathStorage: 'x' } })
  await assertFails(b.commit())
})

test('W2 · gestor registra el pago del delivery por transferencia (DEP tipo C + orden pagada) desde el cliente ⇒ DENY (FIN-1C-A: registrarCobroDelivery)', async () => {
  await env.withSecurityRulesDisabled(async (ctx) => {
    await setDoc(doc(ctx.firestore(), 'solicitudes_envio', 'ord1'), {
      ...ordenBase({ estado: 'entregado' }), codigo: 'SH-0001', secuencia: 1,
      cobroDelivery: { estado: 'en_revision_deposito', monto: 110 },
    })
  })
  const db = como(UID_GESTOR)
  const b = writeBatch(db)
  b.set(doc(db, 'ordenes_deposito', 'depW2'), depositoTipoC({ solicitudIds: ['ord1'], montoTotal: 110 }))
  b.update(doc(db, 'solicitudes_envio', 'ord1'), confirmacionTipoC('depW2'))
  await assertFails(b.commit())
})

test('W3 · el motorizado lista SUS depósitos con where(motorizadoUid == uid) ⇒ ALLOW', async () => {
  await env.withSecurityRulesDisabled(async (ctx) => {
    await setDoc(doc(ctx.firestore(), 'ordenes_deposito', 'propio'), { ...depositoBase(), codigo: 'DEP-0001', secuencia: 1 })
    await setDoc(doc(ctx.firestore(), 'ordenes_deposito', 'ajeno'), { ...depositoBase({ motorizadoUid: 'otro_moto' }), codigo: 'DEP-0002', secuencia: 2 })
  })
  const db = como(UID_MOTO)
  const snap = await assertSucceeds(getDocs(query(collection(db, 'ordenes_deposito'), where('motorizadoUid', '==', UID_MOTO), limit(100))))
  assert.deepEqual(snap.docs.map((d) => d.id), ['propio'])
})

test('W4 · el motorizado no puede listar depósitos sin acotar, ni los de otro ⇒ DENY', async () => {
  const db = como(UID_MOTO)
  await assertFails(getDocs(query(collection(db, 'ordenes_deposito'), limit(100))))
  await assertFails(getDocs(query(collection(db, 'ordenes_deposito'), where('motorizadoUid', '==', 'otro_moto'))))
})

// ─── DEPOSITOS-UX-TRAZABILIDAD-1 (v2) · enlace del digitador ─────────────────
//
// El digitador registra el depósito y, en el MISMO batch que lo pasa a
// 'en_revision', escribe el puntero en cada orden. Nada más: ni confirmación,
// ni otras órdenes, ni otros campos.

const ORDEN_D = 'ordD'

async function sembrarDigitacion(opts: {
  registro?: unknown
  depEstado?: string
  depDigitadoPor?: string
  solicitudIds?: string[]
  destinatario?: 'storkhub' | 'comercio'
} = {}) {
  await env.withSecurityRulesDisabled(async (ctx) => {
    const db = ctx.firestore()
    const orden: Record<string, unknown> = { ...ordenBase({ estado: 'entregado' }), codigo: 'SH-0001', secuencia: 1 }
    if (opts.registro !== undefined) orden.registro = opts.registro
    await setDoc(doc(db, 'solicitudes_envio', ORDEN_D), orden)
    await setDoc(doc(db, 'ordenes_deposito', 'depD'), {
      ...depositoBase({
        estado: opts.depEstado ?? 'pendiente_boucher',
        solicitudIds: opts.solicitudIds ?? [ORDEN_D],
        destinatario: opts.destinatario ?? 'storkhub',
        destinatarioId: opts.destinatario === 'comercio' ? COMERCIO_ID : 'storkhub',
      }),
      codigo: 'DEP-0001',
      secuencia: 1,
      digitadoPorUid: opts.depDigitadoPor ?? UID_DIGITADOR,
      digitadoAt: new Date(),
    })
  })
}

function batchDigitacion(campo: 'storkhubDepositoId' | 'comercioDepositoId', extraOrden: Record<string, string | boolean | null> = {}) {
  const db = como(UID_DIGITADOR)
  const b = writeBatch(db)
  b.update(doc(db, 'ordenes_deposito', 'depD'), {
    boucher: { url: 'https://example.test/b.jpg', pathStorage: 'x' },
    estado: 'en_revision',
  })
  b.update(doc(db, 'solicitudes_envio', ORDEN_D), { [`registro.deposito.${campo}`]: 'depD', ...extraOrden })
  return b.commit()
}

test('Y1 · digitador: depósito a en_revision + puntero StorkHub, en el mismo batch ⇒ ALLOW', async () => {
  await sembrarDigitacion()
  await assertSucceeds(batchDigitacion('storkhubDepositoId'))
})

test('Y1b · igual con registro.deposito = null en la orden ⇒ ALLOW', async () => {
  await sembrarDigitacion({ registro: { deposito: null } })
  await assertSucceeds(batchDigitacion('storkhubDepositoId'))
})

test('Y2 · digitador: depósito al comercio + puntero comercio ⇒ ALLOW', async () => {
  await sembrarDigitacion({ destinatario: 'comercio' })
  await assertSucceeds(batchDigitacion('comercioDepositoId'))
})

test('Y3 · la orden no está en solicitudIds del depósito ⇒ DENY', async () => {
  await sembrarDigitacion({ solicitudIds: ['otraOrden'] })
  await assertFails(batchDigitacion('storkhubDepositoId'))
})

test('Y4 · depósito digitado por OTRO usuario ⇒ DENY', async () => {
  await sembrarDigitacion({ depEstado: 'en_revision', depDigitadoPor: 'otro_digitador' })
  await assertFails(updateDoc(doc(como(UID_DIGITADOR), 'solicitudes_envio', ORDEN_D), { 'registro.deposito.storkhubDepositoId': 'depD' }))
})

test('Y5 · el depósito no queda en revisión (sigue pendiente_boucher) ⇒ DENY', async () => {
  await sembrarDigitacion()
  await assertFails(updateDoc(doc(como(UID_DIGITADOR), 'solicitudes_envio', ORDEN_D), { 'registro.deposito.storkhubDepositoId': 'depD' }))
})

test('Y6 · la orden ya apuntaba a otro depósito ⇒ DENY', async () => {
  await sembrarDigitacion({ registro: { deposito: { storkhubDepositoId: 'depPrevio' } } })
  await assertFails(batchDigitacion('storkhubDepositoId'))
})

test('Y7 · el digitador no puede confirmar ni tocar otros campos ⇒ DENY', async () => {
  await sembrarDigitacion()
  await assertFails(batchDigitacion('storkhubDepositoId', { 'registro.deposito.confirmadoStorkhub': true }))
  await sembrarDigitacion()
  await assertFails(batchDigitacion('storkhubDepositoId', { estado: 'confirmada' }))
})

test('Y8 · puntero al destino equivocado (comercio → depósito StorkHub) ⇒ DENY', async () => {
  await sembrarDigitacion()
  await assertFails(batchDigitacion('comercioDepositoId'))
})

// ─── DEPOSITOS-UX-TRAZABILIDAD-1 (v2) · payloads del gestor ──────────────────

test('Z1 · admin rehace por el cliente: depósito + evento + orden ⇒ DENY (FIN-1B: Rehacer es la callable rehacerDeposito)', async () => {
  await sembrarDigitacion({
    depEstado: 'confirmado',
    registro: { deposito: { storkhubDepositoId: 'depD', confirmadoStorkhub: true, confirmadoStorkhubAt: new Date() } },
  })
  const { db, b } = batchRehacer(UID_ADMIN, 'depD')
  b.update(doc(db, 'solicitudes_envio', ORDEN_D), {
    'registro.deposito.storkhubDepositoId': 'depD',
    'registro.deposito.confirmadoStorkhub': false,
    'registro.deposito.confirmadoStorkhubAt': null,
  })
  await assertFails(b.commit())
})

// DEPOSITO-AUDITORIA-1 — el payload de Z2 era un delete del depósito. Esa
// vía dejó de existir: el admin ANULA y libera la orden en el mismo batch,
// con el mismo efecto operativo y sin perder el documento.
test('Z2 · admin anula por el cliente: depósito + evento + orden liberada ⇒ DENY (FIN-1B: Anular es la callable anularDeposito)', async () => {
  await sembrarDigitacion({
    depEstado: 'confirmado',
    registro: { deposito: { storkhubDepositoId: 'depD', confirmadoStorkhub: true, confirmadoStorkhubAt: new Date() } },
  })
  const db = como(UID_ADMIN)
  const b = writeBatch(db)
  b.set(doc(db, 'ordenes_deposito', 'depD'), camposAnularDeposito(UID_ADMIN, serverTimestamp(), 'Depósito mal armado', 'evAnulD'), { merge: true })
  b.set(doc(db, 'ordenes_deposito', 'depD', 'eventos', 'evAnulD'),
    camposEventoDepositoAnulado({ uid: UID_ADMIN, rol: 'admin' }, serverTimestamp(), 'Depósito mal armado'))
  b.update(doc(db, 'solicitudes_envio', ORDEN_D), {
    'registro.deposito.storkhubDepositoId': null,
    'registro.deposito.confirmadoStorkhub': false,
    'registro.deposito.confirmadoStorkhubAt': null,
  })
  await assertFails(b.commit())
})

test('Z3 · el mismo payload con delete en vez de anular ⇒ DENY', async () => {
  await sembrarDigitacion({
    depEstado: 'confirmado',
    registro: { deposito: { storkhubDepositoId: 'depD', confirmadoStorkhub: true, confirmadoStorkhubAt: new Date() } },
  })
  const db = como(UID_ADMIN)
  const b = writeBatch(db)
  b.delete(doc(db, 'ordenes_deposito', 'depD'))
  b.update(doc(db, 'solicitudes_envio', ORDEN_D), { 'registro.deposito.storkhubDepositoId': null })
  await assertFails(b.commit())
})

// ─── COBROS-PAGO-INTEGRIDAD-1 · comprobante de un depósito confirmado ────────
//
// El boucher de un depósito confirmado es evidencia de dinero ya recibido.
// Ni gestor ni admin lo reemplazan o quitan por el update normal; el resto
// de los flujos (confirmar desde abierto, anular, rehacer) sigue igual.

async function depositoEn(estado: string, extra: Record<string, unknown> = {}) {
  await env.withSecurityRulesDisabled(async (ctx) => {
    await setDoc(doc(ctx.firestore(), 'ordenes_deposito', 'depI'), {
      ...depositoBase({ estado, boucher: { url: 'https://example.test/original.jpg', pathStorage: 'x' }, ...extra }),
      codigo: 'DEP-0001',
      secuencia: 1,
    })
  })
}
const NUEVO_BOUCHER = { boucher: { url: 'https://example.test/nuevo.jpg', pathStorage: 'x' } }

test('BI1 · gestor NO reemplaza el boucher de un depósito confirmado ⇒ DENY', async () => {
  await depositoEn('confirmado')
  await assertFails(updateDoc(doc(como(UID_GESTOR), 'ordenes_deposito', 'depI'), NUEVO_BOUCHER))
})

test('BI2 · admin tampoco ⇒ DENY', async () => {
  await depositoEn('confirmado')
  await assertFails(updateDoc(doc(como(UID_ADMIN), 'ordenes_deposito', 'depI'), NUEVO_BOUCHER))
})

test('BI3 · ni quitarlo, ni tocar boucherUrl (tipo C), ni cambiar estado y boucher a la vez ⇒ DENY', async () => {
  await depositoEn('confirmado')
  const db = como(UID_GESTOR)
  await assertFails(updateDoc(doc(db, 'ordenes_deposito', 'depI'), { boucher: null }))
  await depositoEn('confirmado', { tipo: 'pago_delivery_deposito', boucherUrl: 'https://example.test/c.jpg' })
  await assertFails(updateDoc(doc(db, 'ordenes_deposito', 'depI'), { boucherUrl: 'https://example.test/otro.jpg' }))
  await depositoEn('confirmado')
  await assertFails(updateDoc(doc(db, 'ordenes_deposito', 'depI'), { estado: 'en_revision', ...NUEVO_BOUCHER }))
})

// HARDENING — BI4 afirmaba lo contrario: el gestor podía mutar el puntero
// `boucher` de un depósito en revisión con un update suelto. Esa era la
// última vía NO versionada de cambiar evidencia, y se cierra: la corrección
// de staff va por bouchers/{versionId} con evento y motivo (ver ST1-ST4).
test('BI4 · gestor reemplaza el boucher de un depósito en revisión por la vía directa ⇒ DENY', async () => {
  await depositoEn('en_revision')
  await assertFails(updateDoc(doc(como(UID_GESTOR), 'ordenes_deposito', 'depI'), NUEVO_BOUCHER))
})

test('BI5 · ni gestor ni admin anulan un DEP tipo C confirmado desde el cliente ⇒ DENY (FIN-1C-A: revertirCobroDelivery)', async () => {
  await depositoEn('confirmado', { tipo: 'pago_delivery_deposito', boucherUrl: 'https://example.test/c.jpg' })
  for (const uid of [UID_GESTOR, UID_ADMIN]) {
    await assertFails(updateDoc(doc(como(uid), 'ordenes_deposito', 'depI'), {
      estado: 'anulado',
      anuladoAt: serverTimestamp(),
      anuladoPorUid: uid,
      motivoAnulacion: 'Reversión de cobro contado por gestor',
    }))
  }
})

// HARDENING — las dos mitades cambian: Rehacer exige evento, y una vez
// abierto el depósito el reemplazo ya no es un update suelto sino una versión.
test('BI6 · admin NO rehace un confirmado por el cliente (FIN-1B); y el reemplazo directo del boucher sigue ⇒ DENY', async () => {
  await depositoEn('confirmado')
  await assertFails(batchRehacer(UID_ADMIN, 'depI').b.commit())
  await assertFails(updateDoc(doc(como(UID_ADMIN), 'ordenes_deposito', 'depI'), NUEVO_BOUCHER))
})

// HARDENING FINAL — BI7 afirmaba que el digitador corregía escribiendo
// `boucher` a secas. Esa era la ÚLTIMA vía no versionada de cambiar evidencia
// (deuda DIGITADOR-BOUCHER-NO-VERSIONADO). NO se le quita la corrección: se
// le pide el mismo protocolo que a todos (ver DG3). Acá queda el DENY de la
// vía vieja, que es lo que este caso tiene que seguir cubriendo.
test('BI7 · digitador corrige su depósito en revisión por la vía directa ⇒ DENY', async () => {
  await depositoEn('en_revision', { digitadoPorUid: UID_DIGITADOR, digitadoAt: new Date() })
  await assertFails(updateDoc(doc(como(UID_DIGITADOR), 'ordenes_deposito', 'depI'), { ...NUEVO_BOUCHER, updatedAt: serverTimestamp() }))
})

// DEPOSITO-AUDITORIA-1 — la primera mitad de BI8 afirmaba la deuda W4:
// 'rechazado' → 'en_revision' pisando el objeto, sin versión ni motivo, era
// la única corrección que tenía el motorizado. Esa vía se cierra: la
// corrección es 'devuelto' + versión nueva (ver V2-V11). 'rechazado' vuelve a
// ser terminal. La segunda mitad —confirmado sigue sellado— no cambia.
test('BI8 · motorizado: rechazado ya NO es vía de corrección; sobre confirmado ⇒ DENY', async () => {
  await depositoEn('rechazado')
  const db = como(UID_MOTO)
  await assertFails(updateDoc(doc(db, 'ordenes_deposito', 'depI'), { ...NUEVO_BOUCHER, estado: 'en_revision', updatedAt: serverTimestamp() }))
  await depositoEn('confirmado')
  await assertFails(updateDoc(doc(db, 'ordenes_deposito', 'depI'), { ...NUEVO_BOUCHER, estado: 'en_revision', updatedAt: serverTimestamp() }))
})

test('BI8b · el motorizado sigue completando su create-first desde pendiente_boucher ⇒ ALLOW', async () => {
  await depositoEn('pendiente_boucher')
  await assertSucceeds(updateDoc(doc(como(UID_MOTO), 'ordenes_deposito', 'depI'), {
    ...NUEVO_BOUCHER, estado: 'en_revision', updatedAt: serverTimestamp(),
  }))
})

// ─── COBROS-PAGO-INTEGRIDAD-1 (hardening) · cobro pagado sellado en Rules ────
//
// Modela un cliente de gestor MODIFICADO que se salta los guards de Cobros.
// Fixture: SH-0003 pagada por transferencia con su DEP-0002 tipo C, y su
// movimiento pago_recibido activo.

function depositoTipoC(extra: Record<string, unknown> = {}) {
  return {
    creadoAt: serverTimestamp(),
    tipo: 'pago_delivery_deposito',
    estado: 'confirmado',
    destinatario: 'storkhub',
    destinatarioId: 'storkhub',
    destinatarioNombre: 'Storkhub',
    cuentasDestino: [],
    motorizadoUid: 'motDoc1',
    motorizadoNombre: 'John Pork',
    solicitudIds: ['ordP'],
    montoTotal: 80,
    confirmadoPorUid: UID_GESTOR,
    confirmadoAt: serverTimestamp(),
    ...extra,
  }
}

function confirmacionTipoC(depId: string) {
  return {
    'cobroDelivery.estado': 'pagado',
    'cobroDelivery.pagadoAt': serverTimestamp(),
    'cobroDelivery.formaPago': 'transferencia',
    'cobroDelivery.confirmadoPor': UID_GESTOR,
    'cobroDelivery.confirmadoAt': serverTimestamp(),
    'registro.deposito.confirmadoStorkhub': true,
    'registro.deposito.confirmadoStorkhubAt': serverTimestamp(),
    'registro.deposito.storkhubDepositoId': depId,
  }
}

/** SH-0003 real: pagada por transferencia, DEP-C confirmado, movimiento activo. */
async function sembrarPagadaTipoC() {
  await env.withSecurityRulesDisabled(async (ctx) => {
    const db = ctx.firestore()
    await setDoc(doc(db, 'solicitudes_envio', 'ordP'), {
      ...ordenBase({ estado: 'entregado' }), codigo: 'SH-0003', secuencia: 3,
      cobroDelivery: {
        estado: 'pagado', monto: 80, formaPago: 'transferencia', quienPaga: 'transferencia',
        pagadoAt: new Date(), confirmadoAt: new Date(), confirmadoPor: UID_GESTOR,
        boucherComercio: { url: 'https://example.test/c.jpg', path: 'p', at: new Date() }, boucherVigente: 'comercio',
      },
      registro: { deposito: { storkhubDepositoId: 'depC', confirmadoStorkhub: true, confirmadoStorkhubAt: new Date() } },
    })
    await setDoc(doc(db, 'ordenes_deposito', 'depC'), { ...depositoTipoC({ confirmadoAt: new Date(), creadoAt: new Date() }), codigo: 'DEP-0002', secuencia: 2 })
    await setDoc(doc(db, 'ordenes_deposito', 'depOtro'), { ...depositoTipoC({ confirmadoAt: new Date(), creadoAt: new Date(), solicitudIds: ['otra'] }), codigo: 'DEP-0009', secuencia: 9 })
    await setDoc(doc(db, 'movimientos_financieros', 'movP'), { tipo: 'pago_recibido', estado: 'activo', solicitudId: 'ordP', monto: 80, depositoId: 'depC' })
  })
}

/** La reversión exacta de revertirPagada, con piezas que se pueden omitir. */
function reversion(db: ReturnType<typeof como>, opts: { anularMov?: boolean; anularDep?: boolean; liberarOrden?: boolean } = {}) {
  const { anularMov = true, anularDep = true, liberarOrden = true } = opts
  const b = writeBatch(db)
  b.update(doc(db, 'solicitudes_envio', 'ordP'), {
    'cobroDelivery.estado': 'pendiente',
    'cobroDelivery.pagadoAt': deleteField(),
    'cobroDelivery.formaPago': deleteField(),
    'cobroDelivery.notaPago': deleteField(),
    'cobroDelivery.movimientoPagoId': 'movP',
    ...(liberarOrden ? {
      'registro.deposito.storkhubDepositoId': null,
      'registro.deposito.confirmadoStorkhub': false,
      'registro.deposito.confirmadoStorkhubAt': null,
    } : {}),
  })
  if (anularMov) b.update(doc(db, 'movimientos_financieros', 'movP'), { estado: 'anulado', anuladoAt: serverTimestamp(), anuladoPorUid: UID_GESTOR, motivoAnulacion: 'x' })
  if (anularDep) b.update(doc(db, 'ordenes_deposito', 'depC'), { estado: 'anulado', anuladoAt: serverTimestamp(), anuladoPorUid: UID_GESTOR, motivoAnulacion: 'x' })
  return b.commit()
}

test('H1 · confirmación inicial (DEP-C + orden pagada en un batch) desde el cliente ⇒ DENY (FIN-1C-A)', async () => {
  await env.withSecurityRulesDisabled(async (ctx) => {
    await setDoc(doc(ctx.firestore(), 'solicitudes_envio', 'ordP'), {
      ...ordenBase({ estado: 'entregado' }), codigo: 'SH-0003', secuencia: 3,
      cobroDelivery: { estado: 'en_revision_deposito', monto: 80 },
    })
  })
  const db = como(UID_GESTOR)
  const b = writeBatch(db)
  b.set(doc(db, 'ordenes_deposito', 'depNuevo'), depositoTipoC())
  b.update(doc(db, 'solicitudes_envio', 'ordP'), confirmacionTipoC('depNuevo'))
  await assertFails(b.commit())
  // Ni la orden sola, sin DEP: el resultado de un pago no lo escribe el cliente.
  await assertFails(updateDoc(doc(db, 'solicitudes_envio', 'ordP'), confirmacionTipoC('depNuevo')))
})

test('H1b · tampoco sobre una orden sin cobroDelivery previo (PagoContadoModal) ⇒ DENY (FIN-1C-A)', async () => {
  await env.withSecurityRulesDisabled(async (ctx) => {
    await setDoc(doc(ctx.firestore(), 'solicitudes_envio', 'ordP'), { ...ordenBase({ estado: 'entregado' }), codigo: 'SH-0003', secuencia: 3 })
  })
  const db = como(UID_GESTOR)
  const b = writeBatch(db)
  b.set(doc(db, 'ordenes_deposito', 'depNuevo'), depositoTipoC())
  b.update(doc(db, 'solicitudes_envio', 'ordP'), { ...confirmacionTipoC('depNuevo'), 'cobroDelivery.monto': 80 })
  await assertFails(b.commit())
})

test('H2 · ataque: reconfirmar una orden ya pagada con un segundo DEP-C ⇒ DENY', async () => {
  await sembrarPagadaTipoC()
  const db = como(UID_GESTOR)
  const b = writeBatch(db)
  b.set(doc(db, 'ordenes_deposito', 'depDuplicado'), depositoTipoC())
  b.update(doc(db, 'solicitudes_envio', 'ordP'), confirmacionTipoC('depDuplicado'))
  await assertFails(b.commit())
})

test('H3 · ataque: DEP-C suelto, sin tocar la orden ⇒ DENY', async () => {
  await sembrarPagadaTipoC()
  await assertFails(setDoc(doc(como(UID_GESTOR), 'ordenes_deposito', 'depSuelto'), depositoTipoC()))
  // Ni sobre una orden no pagada, si no se confirma en la misma escritura.
  await env.withSecurityRulesDisabled(async (ctx) => {
    await setDoc(doc(ctx.firestore(), 'solicitudes_envio', 'ordQ'), { ...ordenBase({ estado: 'entregado' }), codigo: 'SH-0004', secuencia: 4 })
  })
  await assertFails(setDoc(doc(como(UID_GESTOR), 'ordenes_deposito', 'depSuelto2'), depositoTipoC({ solicitudIds: ['ordQ'] })))
})

test('H4 · ataque: reescribir la confirmación de un cobro pagado ⇒ DENY', async () => {
  await sembrarPagadaTipoC()
  await assertFails(updateDoc(doc(como(UID_GESTOR), 'solicitudes_envio', 'ordP'), {
    'cobroDelivery.pagadoAt': serverTimestamp(),
    'cobroDelivery.confirmadoAt': serverTimestamp(),
    'cobroDelivery.confirmadoPor': UID_GESTOR,
  }))
})

test('H5 · ataque: cambiar el puntero de una orden pagada a otro DEP ⇒ DENY', async () => {
  await sembrarPagadaTipoC()
  await assertFails(updateDoc(doc(como(UID_GESTOR), 'solicitudes_envio', 'ordP'), { 'registro.deposito.storkhubDepositoId': 'depOtro' }))
  await assertFails(updateDoc(doc(como(UID_GESTOR), 'solicitudes_envio', 'ordP'), { 'registro.deposito.confirmadoStorkhub': false }))
})

test('H6 · ataque: "quitar" el boucher de un pagado (pasarlo a pendiente sin revertir) ⇒ DENY', async () => {
  await sembrarPagadaTipoC()
  await assertFails(updateDoc(doc(como(UID_GESTOR), 'solicitudes_envio', 'ordP'), {
    'cobroDelivery.estado': 'pendiente',
    'cobroDelivery.boucherVigente': deleteField(),
  }))
})

test('H7 · ataque: revertir dejando confirmadoStorkhub = true (cobro pendiente + liquidación confirmada) ⇒ DENY', async () => {
  await sembrarPagadaTipoC()
  await assertFails(reversion(como(UID_GESTOR), { liberarOrden: false }))
})

test('H8 · ataque: revertir sin anular el movimiento, o sin anular el DEP-C ⇒ DENY', async () => {
  await sembrarPagadaTipoC()
  await assertFails(reversion(como(UID_GESTOR), { anularMov: false }))
  await assertFails(reversion(como(UID_GESTOR), { anularDep: false }))
})

test('H9 · reversión completa (cobro + movimiento + DEP-C + orden) desde el cliente ⇒ DENY (FIN-1C-A: revertirCobroDelivery)', async () => {
  await sembrarPagadaTipoC()
  await assertFails(reversion(como(UID_GESTOR)))
  await assertFails(reversion(como(UID_ADMIN)))
})

test('H10 · orden pagada: anotar movimientoPagoId ⇒ DENY (el cobro pagado no se toca); editar campos ajenos al cobro ⇒ ALLOW', async () => {
  await sembrarPagadaTipoC()
  const db = como(UID_GESTOR)
  await assertFails(updateDoc(doc(db, 'solicitudes_envio', 'ordP'), { 'cobroDelivery.movimientoPagoId': 'movP' }))
  await assertSucceeds(updateDoc(doc(db, 'solicitudes_envio', 'ordP'), { prioridad: true, updatedAt: serverTimestamp() }))
})

test('H11 · efectivo (tipo A): el cliente ya no confirma el depósito del motorizado sobre una orden cobrada ⇒ DENY (FIN-1B: confirmarDeposito)', async () => {
  await env.withSecurityRulesDisabled(async (ctx) => {
    const db = ctx.firestore()
    await setDoc(doc(db, 'solicitudes_envio', 'ordE'), {
      ...ordenBase({ estado: 'entregado' }), codigo: 'SH-0001', secuencia: 1,
      cobroDelivery: { estado: 'pagado', monto: 110, formaPago: 'efectivo' },
      registro: { deposito: { storkhubDepositoId: 'depA' } },
    })
    await setDoc(doc(db, 'ordenes_deposito', 'depA'), { ...depositoBase({ estado: 'en_revision', solicitudIds: ['ordE'] }), codigo: 'DEP-0001', secuencia: 1 })
  })
  const { db, b } = batchConfirmar(UID_GESTOR, 'depA')
  b.update(doc(db, 'solicitudes_envio', 'ordE'), {
    'registro.deposito.confirmadoStorkhub': true,
    'registro.deposito.confirmadoStorkhubAt': serverTimestamp(),
    'registro.deposito.storkhubDepositoId': 'depA',
  })
  await assertFails(b.commit())
})

test('H12 · revertir un cobro en efectivo con depósito del motorizado desde el cliente ⇒ DENY, toque o no la liquidación (FIN-1C-A)', async () => {
  const sembrar = async () => env.withSecurityRulesDisabled(async (ctx) => {
    const db = ctx.firestore()
    await setDoc(doc(db, 'solicitudes_envio', 'ordP'), {
      ...ordenBase({ estado: 'entregado' }), codigo: 'SH-0005', secuencia: 5,
      cobroDelivery: { estado: 'pagado', monto: 110, formaPago: 'efectivo', pagadoAt: new Date() },
      registro: { deposito: { storkhubDepositoId: 'depA', confirmadoStorkhub: true, confirmadoStorkhubAt: new Date() } },
    })
    await setDoc(doc(db, 'ordenes_deposito', 'depA'), { ...depositoBase({ estado: 'confirmado', solicitudIds: ['ordP'] }), codigo: 'DEP-0001', secuencia: 1 })
    await setDoc(doc(db, 'movimientos_financieros', 'movP'), { tipo: 'pago_recibido', estado: 'activo', solicitudId: 'ordP', monto: 110 })
  })
  await sembrar()
  await assertFails(reversion(como(UID_GESTOR), { anularDep: false, liberarOrden: false }))
  await sembrar()
  await assertFails(reversion(como(UID_GESTOR), { anularDep: false, liberarOrden: true }))
})

// ─── PAGO-TRANSFERENCIA-UX-1 · DEP-ACCIONES-ADMIN-ONLY ───────────────────────
//
// Rehacer (sacar de 'confirmado') y Eliminar un depósito cerrado son solo del
// admin. El gestor conserva confirmar, devolver un depósito abierto y anular
// el DEP tipo C al revertir su cobro.

test('AD1 · admin rehace un depósito confirmado desde el cliente, con evento y motivo ⇒ DENY (FIN-1B: rehacerDeposito)', async () => {
  await depositoEn('confirmado')
  await assertFails(batchRehacer(UID_ADMIN, 'depI').b.commit())
})

test('AD2 · gestor intenta rehacer un depósito confirmado ⇒ DENY', async () => {
  await depositoEn('confirmado')
  await assertFails(setDoc(doc(como(UID_GESTOR), 'ordenes_deposito', 'depI'), { estado: 'en_revision' }, { merge: true }))
  // Ni a ningún otro estado.
  await assertFails(updateDoc(doc(como(UID_GESTOR), 'ordenes_deposito', 'depI'), { estado: 'rechazado' }))
})

// DEPOSITO-AUDITORIA-1 — AD3 afirmaba lo contrario: el admin borraba el
// documento. Ya no. Lo que le queda es Anular (ver A1-A5).
test('AD3 · admin intenta eliminar un depósito confirmado ⇒ DENY', async () => {
  await depositoEn('confirmado')
  await assertFails(deleteDoc(doc(como(UID_ADMIN), 'ordenes_deposito', 'depI')))
})

test('AD4 · gestor intenta eliminar un depósito confirmado ⇒ DENY', async () => {
  await depositoEn('confirmado')
  await assertFails(deleteDoc(doc(como(UID_GESTOR), 'ordenes_deposito', 'depI')))
  await depositoEn('convertido_en_deuda')
  await assertFails(deleteDoc(doc(como(UID_GESTOR), 'ordenes_deposito', 'depI')))
})

// DEPOSITO-AUDITORIA-1 — "Devolver al motorizado" borraba el depósito
// abierto. Lo reemplaza "Pedir corrección" (ver D1-D6), que no borra nada.
test('AD5 · gestor intenta borrar un depósito en revisión (viejo "Devolver") ⇒ DENY', async () => {
  await depositoEn('en_revision')
  await assertFails(deleteDoc(doc(como(UID_GESTOR), 'ordenes_deposito', 'depI')))
  await depositoEn('pendiente_boucher')
  await assertFails(deleteDoc(doc(como(UID_GESTOR), 'ordenes_deposito', 'depI')))
})

test('AD6 · gestor confirma un depósito en revisión desde el cliente, con evento ⇒ DENY (FIN-1B: confirmarDeposito)', async () => {
  await depositoEn('en_revision')
  await assertFails(batchConfirmar(UID_GESTOR, 'depI').b.commit())
})

test('AD7 · gestor ya no anula un DEP tipo C confirmado desde el cliente (FIN-1C-A), ni un tipo A ⇒ DENY', async () => {
  await depositoEn('confirmado', { tipo: 'pago_delivery_deposito', boucherUrl: 'https://example.test/c.jpg' })
  await assertFails(updateDoc(doc(como(UID_GESTOR), 'ordenes_deposito', 'depI'), { estado: 'anulado', anuladoAt: serverTimestamp() }))
  await depositoEn('confirmado')
  await assertFails(updateDoc(doc(como(UID_GESTOR), 'ordenes_deposito', 'depI'), { estado: 'anulado', anuladoAt: serverTimestamp() }))
})

// ─── STORAGE-EVIDENCIA-INTEGRIDAD-1 · create-first del motorizado ────────────
//
// MOTO-CREATE-DEPOSITO-CONFIRMADO: el motorizado creaba su depósito en
// cualquier estado. Ahora solo nace como lo crea la app: A o B,
// 'pendiente_boucher', sin boucher, con su propio UID.

/** Lo que crea lib/deposito-motorizado-envio (paso 1), sin el boucher. */
function creacionMotorizado(extra: Record<string, unknown> = {}) {
  return {
    ...depositoBase(),
    cuentasDestino: [{ banco: 'LAFISE', numero: '000', titular: 'StorkHub', moneda: 'C$' }],
    montoBruto: 110,
    gastosDescontados: 0,
    gastosIds: [],
    ...extra,
  }
}
const creacionMotorizadoB = (extra: Record<string, unknown> = {}) => creacionMotorizado({
  tipo: 'recaudacion_motorizado_comercio',
  destinatario: 'comercio',
  destinatarioId: COMERCIO_ID,
  destinatarioNombre: 'Mariposita',
  montoBruto: undefined, gastosDescontados: undefined, gastosIds: undefined,
  ...extra,
})
/** Sin las claves undefined (setDoc las rechaza). */
const limpio = (o: Record<string, unknown>) => Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined))

test('F1 · motorizado crea un depósito A en pendiente_boucher, sin boucher ⇒ ALLOW', async () => {
  await assertSucceeds(setDoc(doc(como(UID_MOTO), 'ordenes_deposito', 'depF1'), creacionMotorizado()))
})

test('F2 · motorizado crea un depósito B en pendiente_boucher, sin boucher ⇒ ALLOW', async () => {
  await assertSucceeds(setDoc(doc(como(UID_MOTO), 'ordenes_deposito', 'depF2'), limpio(creacionMotorizadoB())))
})

test('F3 · motorizado crea directamente en_revision (con o sin boucher) ⇒ DENY', async () => {
  const db = como(UID_MOTO)
  await assertFails(setDoc(doc(db, 'ordenes_deposito', 'depF3a'), creacionMotorizado({ estado: 'en_revision' })))
  await assertFails(setDoc(doc(db, 'ordenes_deposito', 'depF3b'), creacionMotorizado({
    estado: 'en_revision',
    boucher: { url: 'https://example.test/b.jpg', pathStorage: `depositos/${UID_MOTO}/depF3b/boucher.jpg`, motorizadoUid: UID_MOTO },
  })))
})

test('F4 · motorizado crea confirmado ⇒ DENY', async () => {
  await assertFails(setDoc(doc(como(UID_MOTO), 'ordenes_deposito', 'depF4'), creacionMotorizado({ estado: 'confirmado' })))
  await assertFails(setDoc(doc(como(UID_MOTO), 'ordenes_deposito', 'depF4b'), creacionMotorizado({
    estado: 'confirmado', confirmadoAt: serverTimestamp(), confirmadoPorUid: UID_MOTO,
  })))
})

test('F5 · motorizado crea convertido_en_deuda ⇒ DENY', async () => {
  await assertFails(setDoc(doc(como(UID_MOTO), 'ordenes_deposito', 'depF5'), creacionMotorizado({ estado: 'convertido_en_deuda', saldoId: 's1' })))
})

test('F6 · motorizado crea anulado ⇒ DENY', async () => {
  await assertFails(setDoc(doc(como(UID_MOTO), 'ordenes_deposito', 'depF6'), creacionMotorizado({ estado: 'anulado', anuladoAt: serverTimestamp() })))
})

test('F7 · motorizado crea un depósito a nombre de otro motorizado ⇒ DENY', async () => {
  await assertFails(setDoc(doc(como(UID_MOTO), 'ordenes_deposito', 'depF7'), creacionMotorizado({ motorizadoUid: 'otro_moto' })))
})

test('F8 · motorizado crea un DEP tipo C ⇒ DENY', async () => {
  await assertFails(setDoc(doc(como(UID_MOTO), 'ordenes_deposito', 'depF8'), creacionMotorizado({ tipo: 'pago_delivery_deposito' })))
})

test('F9 · pendiente_boucher pero con boucher, confirmación, saldo, anulación, digitación o tipo/destino cruzados ⇒ DENY', async () => {
  const db = como(UID_MOTO)
  const casos: Record<string, unknown>[] = [
    { boucher: { url: 'https://example.test/b.jpg', pathStorage: 'x' } },
    { boucherUrl: 'https://example.test/b.jpg' },
    { confirmadoAt: serverTimestamp() },
    { confirmadoPorUid: UID_MOTO },
    { saldoId: 's1' },
    { anuladoAt: serverTimestamp() },
    { digitadoPorUid: UID_MOTO },
    { destinatario: 'comercio' },
    { solicitudIds: [] },
    { montoTotal: -1 },
    { montoTotal: '110' },
  ]
  for (const [i, extra] of casos.entries()) {
    await assertFails(setDoc(doc(db, 'ordenes_deposito', 'depF9_' + i), creacionMotorizado(extra)))
  }
})

test('F10 · flujo create-first completo: create → (upload) → batch boucher + en_revision + puntero ⇒ ALLOW', async () => {
  await env.withSecurityRulesDisabled(async (ctx) => {
    await setDoc(doc(ctx.firestore(), 'solicitudes_envio', 'ordF10'), {
      ...ordenBase({ estado: 'entregado' }), codigo: 'SH-0010', secuencia: 10,
      asignacion: { motorizadoAuthUid: UID_MOTO },
    })
  })
  const db = como(UID_MOTO)
  const ref = doc(db, 'ordenes_deposito', 'depF10')
  await assertSucceeds(setDoc(ref, creacionMotorizado({ solicitudIds: ['ordF10'] })))
  const b = writeBatch(db)
  b.update(ref, {
    boucher: { url: 'https://example.test/b.jpg', pathStorage: `depositos/${UID_MOTO}/depF10/boucher.jpg`, uploadedAt: serverTimestamp(), motorizadoUid: UID_MOTO },
    estado: 'en_revision',
  })
  b.update(doc(db, 'solicitudes_envio', 'ordF10'), { 'registro.deposito.storkhubDepositoId': 'depF10' })
  await assertSucceeds(b.commit())
  // Ya en revisión: el motorizado no vuelve a tocar el boucher (llega en F2).
  await assertFails(updateDoc(ref, { boucher: { url: 'https://example.test/otro.jpg', pathStorage: 'x' } }))
})

// ─── STORAGE-EVIDENCIA-INTEGRIDAD-1 · sellado ampliado ───────────────────────

test('SL1 · convertido_en_deuda: gestor ni admin cambian ni quitan el boucher ⇒ DENY', async () => {
  for (const uid of [UID_GESTOR, UID_ADMIN]) {
    await depositoEn('convertido_en_deuda')
    await assertFails(updateDoc(doc(como(uid), 'ordenes_deposito', 'depI'), NUEVO_BOUCHER))
    await assertFails(updateDoc(doc(como(uid), 'ordenes_deposito', 'depI'), { boucher: null }))
  }
})

test('SL2 · anulado: gestor ni admin cambian el boucher ni el boucherUrl del tipo C ⇒ DENY', async () => {
  for (const uid of [UID_GESTOR, UID_ADMIN]) {
    await depositoEn('anulado')
    await assertFails(updateDoc(doc(como(uid), 'ordenes_deposito', 'depI'), NUEVO_BOUCHER))
    await depositoEn('anulado', { tipo: 'pago_delivery_deposito', boucherUrl: 'https://example.test/c.jpg' })
    await assertFails(updateDoc(doc(como(uid), 'ordenes_deposito', 'depI'), { boucherUrl: 'https://example.test/otro.jpg' }))
  }
})

test('SL3 · sellados: los campos de conversión (saldoId, notaConversion) ya no se editan desde el cliente ⇒ DENY (FIN-1B, D8)', async () => {
  await depositoEn('convertido_en_deuda')
  await assertFails(updateDoc(doc(como(UID_GESTOR), 'ordenes_deposito', 'depI'), { saldoId: 'saldo1' }))
  await depositoEn('anulado')
  await assertFails(updateDoc(doc(como(UID_GESTOR), 'ordenes_deposito', 'depI'), { notaConversion: 'ok' }))
})

test('SL4 · el boucher no se escribe suelto: pendiente_boucher y rechazado ⇒ DENY; la primera carga legítima (boucher + en_revision + updatedAt) ⇒ ALLOW', async () => {
  await depositoEn('pendiente_boucher')
  await assertFails(updateDoc(doc(como(UID_GESTOR), 'ordenes_deposito', 'depI'), NUEVO_BOUCHER))
  await depositoEn('rechazado')
  await assertFails(updateDoc(doc(como(UID_GESTOR), 'ordenes_deposito', 'depI'), NUEVO_BOUCHER))
  await depositoEn('pendiente_boucher')
  await assertSucceeds(updateDoc(doc(como(UID_GESTOR), 'ordenes_deposito', 'depI'), { ...NUEVO_BOUCHER, estado: 'en_revision', updatedAt: serverTimestamp() }))
})

// ═════════════════════════════════════════════════════════════════════════════
// DEPOSITO-AUDITORIA-1 — versionado, corrección solicitada, anulación, eventos
//
// El arnés usa los MISMOS helpers puros que el writer de la app
// (lib/deposito-boucher-version, lib/deposito-correccion,
// lib/deposito-eventos). No se replica ni un payload a mano: si el helper y
// la regla se desalinean, estos casos lo dicen — que es justo lo que un test
// de reglas tiene que poder probar.
// ═════════════════════════════════════════════════════════════════════════════

const DEP_V = 'depV'
const ORDEN_V = 'ordV'

/** Un versionId por escritura: ver la nota de nuevoEventoId(). */
let contadorVersion = 0

/**
 * Depósito A del motorizado, sembrado sin reglas en el estado del caso.
 *
 * OJO: re-sembrar el documento NO borra su subcolección `eventos`. Un caso con
 * varios sub-escenarios que reutilizara el mismo id de evento haría que el
 * segundo `create` cayera sobre un documento ya existente —o sea, un update,
 * que está DENY— y el fallo se leería como un problema de la transición y no
 * del arnés. Por eso cada escritura pide su id con `nuevoEventoId()`.
 */
let contadorEvento = 0
const nuevoEventoId = () => `ev${String(++contadorEvento).padStart(4, '0')}`

async function depositoAB(estado: string, extra: Record<string, unknown> = {}) {
  await env.withSecurityRulesDisabled(async (ctx) => {
    const db = ctx.firestore()
    await setDoc(doc(db, 'ordenes_deposito', DEP_V), {
      ...depositoBase({
        estado,
        solicitudIds: [ORDEN_V],
        boucher: { url: 'https://example.test/v1.jpg', pathStorage: `depositos/${UID_MOTO}/${DEP_V}/boucher.jpg` },
        ...extra,
      }),
      codigo: 'DEP-0007',
      secuencia: 7,
    })
    await setDoc(doc(db, 'solicitudes_envio', ORDEN_V), ordenBase({
      estado: 'entregado',
      asignacion: { motorizadoAuthUid: UID_MOTO },
      codigo: 'SH-0007', secuencia: 7,
      registro: { deposito: { storkhubDepositoId: DEP_V } },
    }))
  })
}

/** Documento del depósito tal como lo leería la app antes de reemplazar. */
async function leerDep(): Promise<Record<string, unknown>> {
  let data: Record<string, unknown> = {}
  await env.withSecurityRulesDisabled(async (ctx) => {
    const snap = await getDoc(doc(ctx.firestore(), 'ordenes_deposito', DEP_V))
    data = (snap.data() ?? {}) as Record<string, unknown>
  })
  return data
}

interface OpcionesReemplazo {
  uid?: string
  rol?: string
  versionId?: string
  motivo?: string
  eventoId?: string
  /** Fuerza un número de versión distinto del que calcula el helper. */
  version?: number
  /** Omite el evento del batch. */
  sinEvento?: boolean
  /** Campos extra que el reemplazo NO debería poder tocar. */
  extraDeposito?: Record<string, unknown>
  /** Sustituye campos del evento (actor, hora, rol falsos). */
  extraEvento?: Record<string, unknown>
  /** Puntero del boucher apuntando a otra cosa. */
  pathStorage?: string
}

/**
 * El batch de reemplazo completo: depósito + evento, como lo arma la app.
 * Devuelve la promesa del commit para envolverla en assertSucceeds/Fails.
 */
async function reemplazar(o: OpcionesReemplazo = {}) {
  const uid = o.uid ?? UID_MOTO
  const rol = o.rol ?? 'motorizado'
  const versionId = o.versionId ?? `verCaso${String(++contadorVersion).padStart(4, '0')}AA`
  const eventoId = o.eventoId ?? versionId
  const motivo = o.motivo ?? 'La foto salió movida'
  const actual = await leerDep()
  const plan = planReemplazoBoucher(
    { id: DEP_V, motorizadoUid: UID_MOTO, boucherVersion: actual.boucherVersion as number, boucherVersionId: actual.boucherVersionId as string },
    versionId,
    motivo,
  )
  const efectivo = o.version !== undefined ? { ...plan, version: o.version } : plan
  const db = como(uid)
  const b = writeBatch(db)
  b.set(doc(db, 'ordenes_deposito', DEP_V), {
    ...camposReemplazoBoucher(
      efectivo,
      { url: 'https://example.test/v2.jpg', pathStorage: o.pathStorage ?? efectivo.path },
      UID_MOTO,
      serverTimestamp(),
      eventoId,
    ),
    ...(o.extraDeposito ?? {}),
  }, { merge: true })
  if (!o.sinEvento) {
    b.set(doc(db, 'ordenes_deposito', DEP_V, 'eventos', eventoId), {
      ...camposEventoBoucherReemplazado({ uid, rol }, serverTimestamp(), efectivo),
      ...(o.extraEvento ?? {}),
    })
  }
  return b.commit()
}

// ─── Versionado (Q.33) ───────────────────────────────────────────────────────

test('V1 · legacy sin boucherVersion: la efectiva es 1, así que el primer reemplazo escribe la 2 ⇒ ALLOW', async () => {
  await depositoAB('en_revision')
  await assertSucceeds(reemplazar({ versionId: 'verSegundaAAA1' }))
  const dep = await leerDep()
  assert.equal(dep.boucherVersion, 2)
  assert.equal(dep.boucherVersionId, 'verSegundaAAA1')
  assert.equal(dep.estado, 'en_revision')
  // El DEP-N, el monto y las órdenes sobreviven al reemplazo.
  assert.equal(dep.codigo, 'DEP-0007')
  assert.equal(dep.montoTotal, 110)
  assert.deepEqual(dep.solicitudIds, [ORDEN_V])
})

test('V2 · en_revision → en_revision, versión +1 y evento en el mismo batch ⇒ ALLOW', async () => {
  await depositoAB('en_revision', { boucherVersion: 2, boucherVersionId: 'verPrimeraAAA1' })
  await assertSucceeds(reemplazar({ versionId: 'verTerceraAAA1' }))
  assert.equal((await leerDep()).boucherVersion, 3)
})

test('V3 · devuelto → en_revision con versión nueva ⇒ ALLOW, y el DEP-N no cambia', async () => {
  await depositoAB('devuelto', {
    devueltoAt: new Date(), devueltoPorUid: UID_GESTOR, motivoDevolucion: 'No se lee el monto',
  })
  await assertSucceeds(reemplazar())
  const dep = await leerDep()
  assert.equal(dep.estado, 'en_revision')
  assert.equal(dep.codigo, 'DEP-0007')
  assert.equal(dep.boucherVersion, 2)
})

test('V4 · saltar de la 1 a la 3 ⇒ DENY (se perdería una versión)', async () => {
  await depositoAB('en_revision')
  await assertFails(reemplazar({ version: 3 }))
})

test('V5 · reemplazo sin evento en el batch ⇒ DENY', async () => {
  await depositoAB('en_revision')
  await assertFails(reemplazar({ sinEvento: true }))
})

test('V6 · evento firmado por otro UID ⇒ DENY', async () => {
  await depositoAB('en_revision')
  await assertFails(reemplazar({ extraEvento: { porUid: UID_GESTOR } }))
})

test('V7 · evento con hora inventada (no request.time) ⇒ DENY', async () => {
  await depositoAB('en_revision')
  await assertFails(reemplazar({ extraEvento: { at: new Date('2020-01-01T00:00:00Z') } }))
})

test('V8 · evento con un rol que el perfil no respalda ⇒ DENY', async () => {
  await depositoAB('en_revision')
  await assertFails(reemplazar({ rol: 'admin' }))
})

test('V9 · el reemplazo intenta cambiar el monto ⇒ DENY', async () => {
  await depositoAB('en_revision')
  await assertFails(reemplazar({ extraDeposito: { montoTotal: 9999 } }))
})

test('V10 · el reemplazo intenta cambiar solicitudIds ⇒ DENY', async () => {
  await depositoAB('en_revision')
  await assertFails(reemplazar({ extraDeposito: { solicitudIds: ['otra'] } }))
})

test('V11 · el reemplazo intenta cambiar el tipo o el destinatario ⇒ DENY', async () => {
  await depositoAB('en_revision')
  await assertFails(reemplazar({ extraDeposito: { tipo: 'recaudacion_motorizado_comercio' } }))
  await depositoAB('en_revision')
  await assertFails(reemplazar({ extraDeposito: { destinatario: 'comercio' } }))
})

test('V12 · el puntero apunta a un objeto que no es el de la versión declarada ⇒ DENY', async () => {
  await depositoAB('en_revision')
  await assertFails(reemplazar({ pathStorage: `depositos/${UID_MOTO}/${DEP_V}/boucher.jpg` }))
  await depositoAB('en_revision')
  await assertFails(reemplazar({ pathStorage: pathVersionBoucher(UID_MOTO, DEP_V, 'otraVersionXX') }))
})

test('V13 · el evento declara una versión distinta de la del depósito ⇒ DENY', async () => {
  await depositoAB('en_revision')
  await assertFails(reemplazar({ extraEvento: { version: 5 } }))
  await depositoAB('en_revision')
  await assertFails(reemplazar({ extraEvento: { versionId: 'otraVersionXX' } }))
})

test('V14 · evento sin motivo, o con un motivo fuera de 3-300 ⇒ DENY', async () => {
  await depositoAB('en_revision')
  await assertFails(reemplazar({ extraEvento: { motivo: 'ok' } }))
  await depositoAB('en_revision')
  await assertFails(reemplazar({ extraEvento: { motivo: 'x'.repeat(301) } }))
  // Y un evento SIN el campo: se arma a mano porque el helper puro no deja
  // construirlo — asegurarMotivoEvento() corta antes. Que el cliente no pueda
  // hacerlo con los helpers no prueba que Rules lo rechace; esto sí.
  await depositoAB('en_revision')
  const db = como(UID_MOTO)
  const b = writeBatch(db)
  const plan = planReemplazoBoucher({ id: DEP_V, motorizadoUid: UID_MOTO }, 'verSinMotivoA1', 'motivo suficiente')
  b.set(doc(db, 'ordenes_deposito', DEP_V), camposReemplazoBoucher(
    plan, { url: 'https://example.test/v2.jpg', pathStorage: plan.path }, UID_MOTO, serverTimestamp(), 'verSinMotivoA1',
  ), { merge: true })
  b.set(doc(db, 'ordenes_deposito', DEP_V, 'eventos', 'verSinMotivoA1'), {
    tipo: 'BOUCHER_REEMPLAZADO', at: serverTimestamp(), porUid: UID_MOTO, porRol: 'motorizado',
    version: plan.version, versionId: plan.versionId, path: plan.path, reemplazaA: plan.reemplazaA,
  })
  await assertFails(b.commit())
})

test('V15 · estados sellados y pendiente_boucher no admiten versión nueva ⇒ DENY', async () => {
  for (const estado of ['confirmado', 'convertido_en_deuda', 'anulado', 'rechazado', 'pendiente_boucher']) {
    await depositoAB(estado)
    await assertFails(reemplazar())
  }
})

test('V16 · otro motorizado sobre un depósito ajeno ⇒ DENY', async () => {
  await depositoAB('en_revision', { motorizadoUid: 'uid_otro' })
  await assertFails(reemplazar())
})

test('V17 · concurrencia: dos reemplazos simultáneos, el segundo pierde ⇒ DENY', async () => {
  await depositoAB('en_revision')
  // Los dos parten de la misma versión efectiva (1) y piden la 2.
  await assertSucceeds(reemplazar({ versionId: 'verGanadoraAA1' }))
  await assertFails(reemplazar({ versionId: 'verPerdedoraA1', version: 2 }))
  assert.equal((await leerDep()).boucherVersionId, 'verGanadoraAA1')
})

// ─── Devolución / "Pedir corrección" (Q.34) ──────────────────────────────────

interface OpcionesDevolucion {
  uid?: string
  rol?: string
  motivo?: string
  sinEvento?: boolean
  extraDeposito?: Record<string, unknown>
  extraEvento?: Record<string, unknown>
}

function pedirCorreccion(o: OpcionesDevolucion = {}) {
  const uid = o.uid ?? UID_GESTOR
  const rol = o.rol ?? (uid === UID_ADMIN ? 'admin' : uid === UID_MOTO ? 'motorizado' : 'gestor')
  const motivo = o.motivo ?? 'El comprobante no muestra el monto'
  const eventoId = nuevoEventoId()
  const db = como(uid)
  const b = writeBatch(db)
  b.set(doc(db, 'ordenes_deposito', DEP_V), {
    ...camposPedirCorreccion(uid, serverTimestamp(), motivo, eventoId),
    ...(o.extraDeposito ?? {}),
  }, { merge: true })
  if (!o.sinEvento) {
    b.set(doc(db, 'ordenes_deposito', DEP_V, 'eventos', eventoId), {
      ...camposEventoDepositoDevuelto({ uid, rol }, serverTimestamp(), motivo),
      ...(o.extraEvento ?? {}),
    })
  }
  return b.commit()
}

test('D1 · gestor pide corrección sobre un depósito en revisión, con motivo y evento ⇒ ALLOW', async () => {
  await depositoAB('en_revision')
  await assertSucceeds(pedirCorreccion())
  const dep = await leerDep()
  assert.equal(dep.estado, 'devuelto')
  assert.equal(dep.devueltoPorUid, UID_GESTOR)
  assert.equal(dep.motivoDevolucion, 'El comprobante no muestra el monto')
})

test('D1b · el admin también ⇒ ALLOW', async () => {
  await depositoAB('en_revision')
  await assertSucceeds(pedirCorreccion({ uid: UID_ADMIN }))
})

test('D2 · sin motivo, o con un motivo fuera de 3-300 ⇒ DENY', async () => {
  await depositoAB('en_revision')
  await assertFails(pedirCorreccion({ extraDeposito: { motivoDevolucion: deleteField() } }))
  await depositoAB('en_revision')
  await assertFails(pedirCorreccion({ extraDeposito: { motivoDevolucion: 'no' } }))
  await depositoAB('en_revision')
  await assertFails(pedirCorreccion({ extraDeposito: { motivoDevolucion: 'x'.repeat(301) } }))
})

test('D2b · el motivo del evento también se valida ⇒ DENY', async () => {
  await depositoAB('en_revision')
  await assertFails(pedirCorreccion({ extraEvento: { motivo: 'no' } }))
})

test('D3 · devolución sin evento en el batch ⇒ DENY', async () => {
  await depositoAB('en_revision')
  await assertFails(pedirCorreccion({ sinEvento: true }))
})

test('D3b · estado devuelto escrito a mano, sin ninguna de las dos cosas ⇒ DENY', async () => {
  await depositoAB('en_revision')
  await assertFails(updateDoc(doc(como(UID_GESTOR), 'ordenes_deposito', DEP_V), { estado: 'devuelto' }))
})

test('D4 · el motorizado no puede devolverse un depósito a sí mismo ⇒ DENY', async () => {
  await depositoAB('en_revision')
  await assertFails(pedirCorreccion({ uid: UID_MOTO }))
})

test('D5 · la devolución conserva boucher, monto, órdenes y punteros', async () => {
  await depositoAB('en_revision')
  await assertSucceeds(pedirCorreccion())
  const dep = await leerDep()
  assert.equal(dep.codigo, 'DEP-0007')
  assert.equal(dep.montoTotal, 110)
  assert.deepEqual(dep.solicitudIds, [ORDEN_V])
  assert.ok(dep.boucher, 'el comprobante anterior sigue ahí')
  let orden: Record<string, unknown> = {}
  await env.withSecurityRulesDisabled(async (ctx) => {
    orden = ((await getDoc(doc(ctx.firestore(), 'solicitudes_envio', ORDEN_V))).data() ?? {}) as Record<string, unknown>
  })
  assert.equal((orden.registro as { deposito: { storkhubDepositoId: string } }).deposito.storkhubDepositoId, DEP_V)
})

test('D5b · tocar el boucher, el monto o las órdenes junto con la devolución ⇒ DENY', async () => {
  await depositoAB('en_revision')
  await assertFails(pedirCorreccion({ extraDeposito: { montoTotal: 1 } }))
  await depositoAB('en_revision')
  await assertFails(pedirCorreccion({ extraDeposito: { boucher: { url: 'https://example.test/otro.jpg' } } }))
  await depositoAB('en_revision')
  await assertFails(pedirCorreccion({ extraDeposito: { solicitudIds: ['x'] } }))
})

test('D6 · de devuelto solo se sale con una versión nueva: confirmar o reabrir a mano ⇒ DENY', async () => {
  for (const destino of ['confirmado', 'en_revision', 'rechazado', 'pendiente_boucher']) {
    await depositoAB('devuelto', { devueltoPorUid: UID_GESTOR, motivoDevolucion: 'otra foto' })
    await assertFails(updateDoc(doc(como(UID_GESTOR), 'ordenes_deposito', DEP_V), { estado: destino }))
    await assertFails(updateDoc(doc(como(UID_ADMIN), 'ordenes_deposito', DEP_V), { estado: destino }))
  }
})

test('D6b · un devuelto ya no se convierte en deuda desde el cliente ⇒ DENY (FIN-1B: convertirDepositoEnDeuda)', async () => {
  await depositoAB('devuelto', { devueltoPorUid: UID_GESTOR, motivoDevolucion: 'otra foto' })
  await assertFails(updateDoc(doc(como(UID_GESTOR), 'ordenes_deposito', DEP_V), {
    estado: 'convertido_en_deuda', saldoId: 'saldo1',
  }))
})

test('D7 · pedir corrección sobre un depósito que no está en revisión ⇒ DENY', async () => {
  for (const estado of ['pendiente_boucher', 'confirmado', 'convertido_en_deuda', 'anulado', 'rechazado']) {
    await depositoAB(estado)
    await assertFails(pedirCorreccion())
  }
})

test('D8 · un DEP tipo C no admite "Pedir corrección" ⇒ DENY', async () => {
  await depositoAB('en_revision', { tipo: 'pago_delivery_deposito', boucherUrl: 'https://example.test/c.jpg' })
  await assertFails(pedirCorreccion())
})

// ─── Anulación (Q.35) ────────────────────────────────────────────────────────

function anular(o: { uid?: string; rol?: string; motivo?: string; sinEvento?: boolean; liberarOrden?: boolean; eventoId?: string } = {}) {
  const uid = o.uid ?? UID_ADMIN
  const rol = o.rol ?? (uid === UID_ADMIN ? 'admin' : 'gestor')
  const motivo = o.motivo ?? 'Depósito armado sobre las órdenes equivocadas'
  const eventoId = o.eventoId ?? nuevoEventoId()
  const db = como(uid)
  const b = writeBatch(db)
  b.set(doc(db, 'ordenes_deposito', DEP_V), camposAnularDeposito(uid, serverTimestamp(), motivo, eventoId), { merge: true })
  if (!o.sinEvento) {
    b.set(doc(db, 'ordenes_deposito', DEP_V, 'eventos', eventoId),
      camposEventoDepositoAnulado({ uid, rol }, serverTimestamp(), motivo))
  }
  if (o.liberarOrden) {
    b.update(doc(db, 'solicitudes_envio', ORDEN_V), {
      'registro.deposito.storkhubDepositoId': null,
      'registro.deposito.confirmadoStorkhub': false,
      'registro.deposito.confirmadoStorkhubAt': null,
    })
  }
  return b.commit()
}

test('A1 · admin NO anula un A/B por el cliente, ni con motivo, evento y orden liberada ⇒ DENY (FIN-1B: anularDeposito)', async () => {
  await depositoAB('en_revision')
  await assertFails(anular({ liberarOrden: true }))
  assert.equal((await leerDep()).estado, 'en_revision')
})

test('A2 · el gestor no anula un A/B confirmado ⇒ DENY', async () => {
  await depositoAB('confirmado')
  await assertFails(anular({ uid: UID_GESTOR }))
})

test('A2b · el gestor tampoco uno abierto: Anular es del admin ⇒ DENY', async () => {
  await depositoAB('en_revision')
  await assertFails(anular({ uid: UID_GESTOR }))
})

test('A2c · anular sin motivo, o sin actor/hora demostrables ⇒ DENY', async () => {
  await depositoAB('en_revision')
  await assertFails(updateDoc(doc(como(UID_ADMIN), 'ordenes_deposito', DEP_V), { estado: 'anulado' }))
  await depositoAB('en_revision')
  await assertFails(updateDoc(doc(como(UID_ADMIN), 'ordenes_deposito', DEP_V), {
    estado: 'anulado', anuladoAt: serverTimestamp(), anuladoPorUid: UID_GESTOR, motivoAnulacion: 'motivo suficiente',
  }))
  await depositoAB('en_revision')
  await assertFails(updateDoc(doc(como(UID_ADMIN), 'ordenes_deposito', DEP_V), {
    estado: 'anulado', anuladoAt: new Date(), anuladoPorUid: UID_ADMIN, motivoAnulacion: 'motivo suficiente',
  }))
})

test('A3 · delete físico del gestor, en cualquier estado ⇒ DENY', async () => {
  for (const estado of ['pendiente_boucher', 'en_revision', 'devuelto', 'confirmado', 'anulado']) {
    await depositoAB(estado)
    await assertFails(deleteDoc(doc(como(UID_GESTOR), 'ordenes_deposito', DEP_V)))
  }
})

test('A4 · delete físico del admin, en cualquier estado ⇒ DENY', async () => {
  for (const estado of ['pendiente_boucher', 'en_revision', 'devuelto', 'confirmado', 'anulado']) {
    await depositoAB(estado)
    await assertFails(deleteDoc(doc(como(UID_ADMIN), 'ordenes_deposito', DEP_V)))
  }
})

test('A5 · el intento de anular por el cliente no deja rastro: el documento, sus eventos y su orden quedan como estaban', async () => {
  await depositoAB('en_revision')
  const antes = await leerDep()
  await assertFails(anular({ eventoId: 'evAnul1' }))
  assert.deepEqual(await leerDep(), antes)
  let existeEvento = true
  await env.withSecurityRulesDisabled(async (ctx) => {
    existeEvento = (await getDoc(doc(ctx.firestore(), 'ordenes_deposito', DEP_V, 'eventos', 'evAnul1'))).exists()
  })
  assert.equal(existeEvento, false, 'el evento tampoco se creó (batch todo-o-nada)')
})

test('A6 · el tipo C se anula SOLO en el servidor (FIN-1C-A): ni la forma exacta de Revertir pasa desde el cliente ⇒ DENY', async () => {
  await depositoAB('confirmado', { tipo: 'pago_delivery_deposito', boucherUrl: 'https://example.test/c.jpg' })
  await assertFails(updateDoc(doc(como(UID_GESTOR), 'ordenes_deposito', DEP_V), {
    estado: 'anulado', anuladoAt: serverTimestamp(), anuladoPorUid: UID_GESTOR,
    motivoAnulacion: 'Reversión de cobro contado por gestor',
  }))
})

// ─── FIN-4A · un convertido en deuda no se anula por el writer genérico ──────
//
// Anular un depósito convertido dejaba el depósito 'anulado' y anulaba su movimiento
// de conversión, pero el saldo seguía vivo en saldos_cargo_motorizado: una deuda sin
// el ledger que la respalda. Su única salida es revertir la conversión (FIN-4B).

test('F4A-R1 · el ADMIN no anula un convertido_en_deuda, ni con el batch auditado completo ⇒ DENY, y sigue convertido', async () => {
  await depositoAB('convertido_en_deuda', { saldoId: 'saldo1' })
  await assertFails(anular({ uid: UID_ADMIN, liberarOrden: true }))
  await assertFails(anular({ uid: UID_ADMIN }))
  assert.equal((await leerDep()).estado, 'convertido_en_deuda')
})

test('F4A-R2 · el GESTOR tampoco lo anula (ni con el write plano de la anulación) ⇒ DENY', async () => {
  await depositoAB('convertido_en_deuda', { saldoId: 'saldo1' })
  await assertFails(anular({ uid: UID_GESTOR }))
  await assertFails(updateDoc(doc(como(UID_GESTOR), 'ordenes_deposito', DEP_V), {
    estado: 'anulado', anuladoAt: serverTimestamp(), anuladoPorUid: UID_GESTOR, motivoAnulacion: 'motivo suficiente',
  }))
  assert.equal((await leerDep()).estado, 'convertido_en_deuda')
})

test('F4A-R3 · ninguna anulación del admin nace ya del cliente (pendiente_boucher, en_revision, devuelto, confirmado) ⇒ DENY (FIN-1B: anularDeposito)', async () => {
  for (const estado of ['pendiente_boucher', 'en_revision', 'devuelto', 'confirmado']) {
    await depositoAB(estado, estado === 'devuelto' ? { devueltoPorUid: UID_GESTOR, motivoDevolucion: 'otra foto' } : {})
    await assertFails(anular({ uid: UID_ADMIN, liberarOrden: true }))
    assert.equal((await leerDep()).estado, estado, estado)
  }
})

test('F4A-R4 · un convertido no se edita desde el cliente (nota, saldoId) y convertir ya no nace del cliente ⇒ DENY (FIN-1B); la salida hacia revisión sigue siendo FIN-4B-R1', async () => {
  await depositoAB('convertido_en_deuda', { saldoId: 'saldo1' })
  await assertFails(updateDoc(doc(como(UID_GESTOR), 'ordenes_deposito', DEP_V), { notaConversion: 'ajustada', updatedAt: serverTimestamp() }))
  await assertFails(updateDoc(doc(como(UID_GESTOR), 'ordenes_deposito', DEP_V), { estado: 'en_revision', updatedAt: serverTimestamp() }))
  await depositoAB('en_revision')
  await assertFails(updateDoc(doc(como(UID_GESTOR), 'ordenes_deposito', DEP_V), { estado: 'convertido_en_deuda', saldoId: 'saldo1' }))
  await depositoAB('devuelto', { devueltoPorUid: UID_GESTOR, motivoDevolucion: 'otra foto' })
  await assertFails(updateDoc(doc(como(UID_GESTOR), 'ordenes_deposito', DEP_V), { estado: 'convertido_en_deuda', saldoId: 'saldo1' }))
})

// ─── FIN-4B — nadie SALE de convertido_en_deuda desde el cliente ──────────────
// Revertir una conversión es la callable revertirConversionEnDeuda (Admin SDK, no pasa por estas Rules):
// depósito, saldo, movimiento, evento y órdenes en UNA transacción. La salida directa dejaba el saldo y
// el ledger sin tocar (o a medias) y sin evento. Solo se cierra la SALIDA; el resto sigue como en FIN-4A.

test('FIN4B-R1 · el GESTOR no saca un convertido_en_deuda a en_revision, ni con los campos de conversión limpios ⇒ DENY, y sigue convertido', async () => {
  await depositoAB('convertido_en_deuda', { saldoId: 'saldo1', notaConversion: 'x' })
  await assertFails(updateDoc(doc(como(UID_GESTOR), 'ordenes_deposito', DEP_V), { estado: 'en_revision', updatedAt: serverTimestamp() }))
  await assertFails(updateDoc(doc(como(UID_GESTOR), 'ordenes_deposito', DEP_V), {
    estado: 'en_revision', saldoId: deleteField(), notaConversion: deleteField(), updatedAt: serverTimestamp(),
  }))
  assert.equal((await leerDep()).estado, 'convertido_en_deuda')
})

test('FIN4B-R2 · el ADMIN tampoco ⇒ DENY', async () => {
  await depositoAB('convertido_en_deuda', { saldoId: 'saldo1' })
  await assertFails(updateDoc(doc(como(UID_ADMIN), 'ordenes_deposito', DEP_V), { estado: 'en_revision', updatedAt: serverTimestamp() }))
  assert.equal((await leerDep()).estado, 'convertido_en_deuda')
})

test('FIN4B-R3 · ni gestor ni admin lo llevan a pendiente_boucher, devuelto, confirmado ni rechazado ⇒ DENY', async () => {
  for (const uid of [UID_GESTOR, UID_ADMIN]) {
    for (const estado of ['pendiente_boucher', 'devuelto', 'confirmado', 'rechazado']) {
      await depositoAB('convertido_en_deuda', { saldoId: 'saldo1' })
      await assertFails(updateDoc(doc(como(uid), 'ordenes_deposito', DEP_V), { estado, updatedAt: serverTimestamp() }))
      assert.equal((await leerDep()).estado, 'convertido_en_deuda')
    }
  }
})

test('FIN4B-R4 · convertido_en_deuda → anulado sigue bloqueado (FIN-4A) para gestor y admin', async () => {
  await depositoAB('convertido_en_deuda', { saldoId: 'saldo1' })
  await assertFails(anular({ uid: UID_ADMIN, liberarOrden: true }))
  await assertFails(anular({ uid: UID_GESTOR }))
  assert.equal((await leerDep()).estado, 'convertido_en_deuda')
})

test('FIN4B-R5 · lo que quedó del cliente: devolver (pedir corrección) ⇒ ALLOW; anular, convertir y editar un convertido ⇒ DENY (FIN-1B)', async () => {
  for (const estado of ['pendiente_boucher', 'en_revision', 'devuelto', 'confirmado']) {
    await depositoAB(estado, estado === 'devuelto' ? { devueltoPorUid: UID_GESTOR, motivoDevolucion: 'otra foto' } : {})
    await assertFails(anular({ uid: UID_ADMIN, liberarOrden: true }))
    assert.equal((await leerDep()).estado, estado, estado)
  }
  await depositoAB('en_revision')
  await assertSucceeds(pedirCorreccion())
  await depositoAB('en_revision')
  await assertFails(updateDoc(doc(como(UID_GESTOR), 'ordenes_deposito', DEP_V), { estado: 'convertido_en_deuda', saldoId: 'saldo1' }))
  await depositoAB('convertido_en_deuda', { saldoId: 'saldo1' })
  await assertFails(updateDoc(doc(como(UID_GESTOR), 'ordenes_deposito', DEP_V), { notaConversion: 'ajustada', updatedAt: serverTimestamp() }))
  assert.equal((await leerDep()).estado, 'convertido_en_deuda')
})

test('FIN4B-R6 · el cliente no puede forjar el evento DEPOSITO_CONVERSION_REVERTIDA (solo la callable lo escribe) ⇒ DENY', async () => {
  await depositoAB('en_revision')
  for (const uid of [UID_GESTOR, UID_ADMIN]) {
    await assertFails(setDoc(doc(como(uid), 'ordenes_deposito', DEP_V, 'eventos', 'ev_forjado'), {
      tipo: 'DEPOSITO_CONVERSION_REVERTIDA', at: serverTimestamp(), porUid: uid, porRol: uid === UID_ADMIN ? 'admin' : 'gestor', motivo: 'motivo valido',
    }))
  }
})

// ─── Eventos: append-only (Q.36) ─────────────────────────────────────────────

const evento = (extra: Record<string, unknown> = {}) => ({
  tipo: 'DEPOSITO_DEVUELTO',
  at: serverTimestamp(),
  porUid: UID_GESTOR,
  porRol: 'gestor',
  motivo: 'El comprobante no muestra el monto',
  ...extra,
})

const refEvento = (uid: string, id = 'ev1') => doc(como(uid), 'ordenes_deposito', DEP_V, 'eventos', id)

test('E1 · create válido de un evento ⇒ ALLOW', async () => {
  await depositoAB('en_revision')
  await assertSucceeds(setDoc(refEvento(UID_GESTOR), evento()))
})

test('E2 · update de un evento ya escrito ⇒ DENY (append-only)', async () => {
  await depositoAB('en_revision')
  await assertSucceeds(setDoc(refEvento(UID_GESTOR), evento()))
  for (const uid of [UID_GESTOR, UID_ADMIN, UID_MOTO]) {
    await assertFails(updateDoc(refEvento(uid), { motivo: 'otra cosa' }))
  }
})

test('E3 · delete de un evento ⇒ DENY, admin incluido', async () => {
  await depositoAB('en_revision')
  await assertSucceeds(setDoc(refEvento(UID_GESTOR), evento()))
  for (const uid of [UID_GESTOR, UID_ADMIN, UID_MOTO]) {
    await assertFails(deleteDoc(refEvento(uid)))
  }
})

test('E4 · evento firmado con un UID que no es el del actor ⇒ DENY', async () => {
  await depositoAB('en_revision')
  await assertFails(setDoc(refEvento(UID_GESTOR), evento({ porUid: UID_ADMIN })))
})

test('E5 · evento con un rol que el perfil no respalda ⇒ DENY', async () => {
  await depositoAB('en_revision')
  await assertFails(setDoc(refEvento(UID_GESTOR), evento({ porRol: 'admin' })))
  await assertFails(setDoc(refEvento(UID_GESTOR, 'ev2'), evento({ porRol: 'motorizado' })))
})

test('E6 · evento con hora inventada ⇒ DENY', async () => {
  await depositoAB('en_revision')
  await assertFails(setDoc(refEvento(UID_GESTOR), evento({ at: new Date('2020-01-01T00:00:00Z') })))
})

test('E7 · motivo de menos de 3 caracteres ⇒ DENY', async () => {
  await depositoAB('en_revision')
  await assertFails(setDoc(refEvento(UID_GESTOR), evento({ motivo: 'no' })))
  await assertFails(setDoc(refEvento(UID_GESTOR, 'ev2'), evento({ motivo: '' })))
})

test('E8 · motivo de más de 300 caracteres ⇒ DENY', async () => {
  await depositoAB('en_revision')
  await assertFails(setDoc(refEvento(UID_GESTOR), evento({ motivo: 'x'.repeat(301) })))
  await assertSucceeds(setDoc(refEvento(UID_GESTOR, 'ev2'), evento({ motivo: 'x'.repeat(300) })))
})

test('E9 · tipo fuera de la lista cerrada ⇒ DENY', async () => {
  await depositoAB('en_revision')
  await assertFails(setDoc(refEvento(UID_GESTOR), evento({ tipo: 'DEPOSITO_BORRADO' })))
})

test('E10 · cada rol narra lo suyo: el motorizado no devuelve ni anula, el gestor no rehace', async () => {
  await depositoAB('en_revision')
  await assertFails(setDoc(refEvento(UID_MOTO), evento({ porUid: UID_MOTO, porRol: 'motorizado' })))
  await assertFails(setDoc(refEvento(UID_MOTO, 'ev2'), {
    ...evento({ tipo: 'DEPOSITO_ANULADO', porUid: UID_MOTO, porRol: 'motorizado' }),
  }))
  await assertFails(setDoc(refEvento(UID_GESTOR, 'ev3'),
    camposEventoDepositoRehecho({ uid: UID_GESTOR, rol: 'gestor' }, serverTimestamp(), 'motivo suficiente')))
  await assertSucceeds(setDoc(refEvento(UID_ADMIN, 'ev4'),
    camposEventoDepositoRehecho({ uid: UID_ADMIN, rol: 'admin' }, serverTimestamp(), 'motivo suficiente')))
})

test('E11 · el motorizado sí narra su propio comprobante, y no el de otro ⇒ ALLOW / DENY', async () => {
  await depositoAB('en_revision')
  await assertSucceeds(setDoc(refEvento(UID_MOTO), {
    tipo: 'BOUCHER_SUBIDO', at: serverTimestamp(), porUid: UID_MOTO, porRol: 'motorizado',
    version: 1, versionId: 'verPrimeraAAA1', path: pathVersionBoucher(UID_MOTO, DEP_V, 'verPrimeraAAA1'),
  }))
  await depositoAB('en_revision', { motorizadoUid: 'uid_otro' })
  await assertFails(setDoc(refEvento(UID_MOTO, 'ev2'), {
    tipo: 'BOUCHER_SUBIDO', at: serverTimestamp(), porUid: UID_MOTO, porRol: 'motorizado',
  }))
})

test('E12 · el motorizado lee la historia de SU depósito, no la de otro', async () => {
  await depositoAB('en_revision')
  await env.withSecurityRulesDisabled(async (ctx) => {
    await setDoc(doc(ctx.firestore(), 'ordenes_deposito', DEP_V, 'eventos', 'ev1'), evento())
  })
  await assertSucceeds(getDoc(refEvento(UID_MOTO)))
  await assertSucceeds(getDoc(refEvento(UID_GESTOR)))
  await depositoAB('en_revision', { motorizadoUid: 'uid_otro' })
  await assertFails(getDoc(refEvento(UID_MOTO)))
})

// ═════════════════════════════════════════════════════════════════════════════
// HARDENING · AU — la auditoría es AUTORITATIVA, no cortesía del writer
//
// Antes, confirmar / rehacer / anular escribían su evento desde el cliente y
// Rules no lo exigía: un cliente modificado podía hacer la transición y
// saltarse la subcolección entera. La historia de un depósito no puede
// depender de que quien escribe quiera contarla.
// ═════════════════════════════════════════════════════════════════════════════

/** Confirmación con el evento sustituido/omitido, para los casos negativos. */
function confirmarCon(opts: {
  uid?: string
  rol?: string
  sinEvento?: boolean
  eventoIdDeclarado?: string
  extraEvento?: Record<string, unknown>
  depId?: string
} = {}) {
  const uid = opts.uid ?? UID_GESTOR
  const rol = opts.rol ?? (uid === UID_ADMIN ? 'admin' : 'gestor')
  const depId = opts.depId ?? DEP_V
  const eventoId = nuevoEventoId()
  const db = como(uid)
  const b = writeBatch(db)
  b.set(doc(db, 'ordenes_deposito', depId),
    camposConfirmarDeposito(uid, serverTimestamp(), opts.eventoIdDeclarado ?? eventoId), { merge: true })
  if (!opts.sinEvento) {
    b.set(doc(db, 'ordenes_deposito', depId, 'eventos', eventoId), {
      ...camposEventoDepositoConfirmado({ uid, rol }, serverTimestamp()),
      ...(opts.extraEvento ?? {}),
    })
  }
  return b.commit()
}

function rehacerCon(opts: {
  uid?: string
  rol?: string
  motivo?: string
  sinEvento?: boolean
  extraEvento?: Record<string, unknown>
} = {}) {
  const uid = opts.uid ?? UID_ADMIN
  const rol = opts.rol ?? (uid === UID_ADMIN ? 'admin' : 'gestor')
  const motivo = opts.motivo ?? 'El comprobante era de otro depósito'
  const eventoId = nuevoEventoId()
  const db = como(uid)
  const b = writeBatch(db)
  b.set(doc(db, 'ordenes_deposito', DEP_V),
    camposRehacerDeposito(uid, serverTimestamp(), motivo, eventoId), { merge: true })
  if (!opts.sinEvento) {
    b.set(doc(db, 'ordenes_deposito', DEP_V, 'eventos', eventoId), {
      ...camposEventoDepositoRehecho({ uid, rol }, serverTimestamp(), motivo),
      ...(opts.extraEvento ?? {}),
    })
  }
  return b.commit()
}

test('AU1 · confirmar un A sin DEPOSITO_CONFIRMADO ⇒ DENY', async () => {
  await depositoAB('en_revision')
  await assertFails(confirmarCon({ sinEvento: true }))
  // Y tampoco por la vía cruda, sin ultimoEventoId siquiera.
  await depositoAB('en_revision')
  await assertFails(updateDoc(doc(como(UID_GESTOR), 'ordenes_deposito', DEP_V), {
    estado: 'confirmado', confirmadoPorUid: UID_GESTOR, confirmadoAt: serverTimestamp(),
  }))
})

test('AU1b · lo mismo sobre un depósito B ⇒ DENY', async () => {
  await depositoAB('en_revision', { tipo: 'recaudacion_motorizado_comercio', destinatario: 'comercio' })
  await assertFails(confirmarCon({ sinEvento: true }))
})

test('AU2 · confirmar con evento válido desde el cliente ⇒ DENY (A y B, gestor y admin, desde en_revision y pendiente_boucher) (FIN-1B: confirmarDeposito)', async () => {
  await depositoAB('en_revision')
  await assertFails(confirmarCon())
  await depositoAB('en_revision')
  await assertFails(confirmarCon({ uid: UID_ADMIN }))
  await depositoAB('en_revision', { tipo: 'recaudacion_motorizado_comercio', destinatario: 'comercio' })
  await assertFails(confirmarCon())
  await depositoAB('pendiente_boucher')
  await assertFails(confirmarCon())
})

test('AU3 · rehacer sin DEPOSITO_REHECHO ⇒ DENY', async () => {
  await depositoAB('confirmado')
  await assertFails(rehacerCon({ sinEvento: true }))
  await depositoAB('confirmado')
  await assertFails(setDoc(doc(como(UID_ADMIN), 'ordenes_deposito', DEP_V), { estado: 'en_revision' }, { merge: true }))
})

test('AU4 · rehacer con evento válido desde el cliente ⇒ DENY (A y B) (FIN-1B: rehacerDeposito)', async () => {
  await depositoAB('confirmado')
  await assertFails(rehacerCon())
  await depositoAB('confirmado', { tipo: 'recaudacion_motorizado_comercio', destinatario: 'comercio' })
  await assertFails(rehacerCon())
})

test('AU4b · rehacer sigue siendo admin-only, con evento y todo ⇒ DENY para gestor', async () => {
  await depositoAB('confirmado')
  await assertFails(rehacerCon({ uid: UID_GESTOR }))
})

test('AU4c · rehacer con motivo fuera de 3-300 en el evento ⇒ DENY', async () => {
  await depositoAB('confirmado')
  await assertFails(rehacerCon({ extraEvento: { motivo: 'no' } }))
  await depositoAB('confirmado')
  await assertFails(rehacerCon({ extraEvento: { motivo: 'x'.repeat(301) } }))
})

test('AU5 · anular sin DEPOSITO_ANULADO ⇒ DENY', async () => {
  await depositoAB('en_revision')
  await assertFails(anular({ sinEvento: true }))
  await depositoAB('confirmado')
  await assertFails(anular({ sinEvento: true }))
})

test('AU6 · anular con evento válido desde el cliente ⇒ DENY (A y B) (FIN-1B: anularDeposito)', async () => {
  await depositoAB('en_revision')
  await assertFails(anular())
  await depositoAB('confirmado', { tipo: 'recaudacion_motorizado_comercio', destinatario: 'comercio' })
  await assertFails(anular())
})

test('AU7 · evento del tipo equivocado para la transición ⇒ DENY', async () => {
  // Confirmar acompañado de un DEPOSITO_DEVUELTO.
  await depositoAB('en_revision')
  const db = como(UID_GESTOR)
  const b = writeBatch(db)
  b.set(doc(db, 'ordenes_deposito', DEP_V),
    camposConfirmarDeposito(UID_GESTOR, serverTimestamp(), 'evAU'), { merge: true })
  b.set(doc(db, 'ordenes_deposito', DEP_V, 'eventos', 'evAU'),
    camposEventoDepositoDevuelto({ uid: UID_GESTOR, rol: 'gestor' }, serverTimestamp(), 'motivo suficiente'))
  await assertFails(b.commit())
  // Rehacer acompañado de un DEPOSITO_ANULADO.
  await depositoAB('confirmado')
  const dbA = como(UID_ADMIN)
  const b2 = writeBatch(dbA)
  b2.set(doc(dbA, 'ordenes_deposito', DEP_V),
    camposRehacerDeposito(UID_ADMIN, serverTimestamp(), 'motivo suficiente', 'evAU'), { merge: true })
  b2.set(doc(dbA, 'ordenes_deposito', DEP_V, 'eventos', 'evAU'),
    camposEventoDepositoAnulado({ uid: UID_ADMIN, rol: 'admin' }, serverTimestamp(), 'motivo suficiente'))
  await assertFails(b2.commit())
})

test('AU8 · ultimoEventoId apunta a un evento que no existe ⇒ DENY', async () => {
  await depositoAB('en_revision')
  await assertFails(confirmarCon({ eventoIdDeclarado: 'evQueNoExiste' }))
  // Tampoco sirve apuntar a uno viejo ya escrito: tiene que ser de ESTE batch.
  await depositoAB('en_revision')
  await env.withSecurityRulesDisabled(async (ctx) => {
    await setDoc(doc(ctx.firestore(), 'ordenes_deposito', DEP_V, 'eventos', 'evViejo'), {
      tipo: 'DEPOSITO_CONFIRMADO', at: new Date('2020-01-01T00:00:00Z'), porUid: UID_GESTOR, porRol: 'gestor',
    })
  })
  await assertFails(confirmarCon({ eventoIdDeclarado: 'evViejo', sinEvento: true }))
  // Y el vacío tampoco: el helper puro ni siquiera deja construirlo, así que
  // el payload se arma a mano para que sea Rules quien lo rechace.
  await depositoAB('en_revision')
  await assertFails(updateDoc(doc(como(UID_GESTOR), 'ordenes_deposito', DEP_V), {
    estado: 'confirmado', confirmadoPorUid: UID_GESTOR, confirmadoAt: serverTimestamp(), ultimoEventoId: '',
  }))
})

test('AU9 · evento firmado por otro actor ⇒ DENY', async () => {
  await depositoAB('en_revision')
  await assertFails(confirmarCon({ extraEvento: { porUid: UID_ADMIN } }))
  await depositoAB('confirmado')
  await assertFails(rehacerCon({ extraEvento: { porUid: UID_GESTOR } }))
  await depositoAB('en_revision')
  await assertFails(anular({ uid: UID_ADMIN, rol: 'gestor' }))
})

test('AU10 · evento con timestamp distinto de request.time ⇒ DENY', async () => {
  const antes = new Date('2020-01-01T00:00:00Z')
  await depositoAB('en_revision')
  await assertFails(confirmarCon({ extraEvento: { at: antes } }))
  await depositoAB('confirmado')
  await assertFails(rehacerCon({ extraEvento: { at: antes } }))
})

test('AU11 · el tipo C: no nace de un update (en_revision → confirmado ⇒ DENY) y tampoco se anula desde el cliente ⇒ DENY (FIN-1C-A)', async () => {
  await depositoAB('en_revision', { tipo: 'pago_delivery_deposito', boucherUrl: 'https://example.test/c.jpg' })
  await assertFails(updateDoc(doc(como(UID_GESTOR), 'ordenes_deposito', DEP_V), {
    estado: 'confirmado', confirmadoPorUid: UID_GESTOR, confirmadoAt: serverTimestamp(),
  }))
  await depositoAB('confirmado', { tipo: 'pago_delivery_deposito', boucherUrl: 'https://example.test/c.jpg' })
  await assertFails(updateDoc(doc(como(UID_GESTOR), 'ordenes_deposito', DEP_V), {
    estado: 'anulado', anuladoAt: serverTimestamp(), anuladoPorUid: UID_GESTOR,
    motivoAnulacion: 'Reversión de cobro contado por gestor',
  }))
})

// ═════════════════════════════════════════════════════════════════════════════
// HARDENING · ST — staff no se salta el versionado
//
// El puntero `boucher` de un A/B abierto era lo último que gestor y admin
// podían cambiar con un update suelto, heredado del modelo privilegiado de
// P1-S2. Después de F2 eso es una vía no versionada de reemplazar evidencia:
// el objeto anterior deja de estar referenciado, sin versión, sin motivo y
// sin evento. Se cierra para los tres roles, sin bypass de admin.
// ═════════════════════════════════════════════════════════════════════════════

test('ST1 · gestor cambia el boucher directo en en_revision, sin versión ni evento ⇒ DENY', async () => {
  await depositoAB('en_revision')
  const ref = doc(como(UID_GESTOR), 'ordenes_deposito', DEP_V)
  await assertFails(updateDoc(ref, { boucher: { url: 'https://example.test/x.jpg', pathStorage: 'x' } }))
  await assertFails(updateDoc(ref, { boucherUrl: 'https://example.test/x.jpg' }))
  await assertFails(updateDoc(ref, { boucherVersion: 7 }))
  await assertFails(updateDoc(ref, { boucherVersionId: 'inventado' }))
  await assertFails(updateDoc(ref, { boucher: null }))
})

test('ST1b · y en devuelto, igual ⇒ DENY', async () => {
  await depositoAB('devuelto', { devueltoPorUid: UID_GESTOR, motivoDevolucion: 'otra foto' })
  await assertFails(updateDoc(doc(como(UID_GESTOR), 'ordenes_deposito', DEP_V), {
    boucher: { url: 'https://example.test/x.jpg', pathStorage: 'x' },
  }))
})

test('ST2 · admin cambia el boucher directo ⇒ DENY (sin bypass)', async () => {
  for (const estado of ['en_revision', 'devuelto']) {
    await depositoAB(estado)
    await assertFails(updateDoc(doc(como(UID_ADMIN), 'ordenes_deposito', DEP_V), {
      boucher: { url: 'https://example.test/x.jpg', pathStorage: 'x' },
    }))
  }
})

test('ST3 · gestor reemplaza versionado, con evento y motivo ⇒ ALLOW', async () => {
  await depositoAB('en_revision')
  await assertSucceeds(reemplazar({ uid: UID_GESTOR, rol: 'gestor' }))
  const dep = await leerDep()
  assert.equal(dep.boucherVersion, 2)
  assert.equal(dep.codigo, 'DEP-0007')
})

test('ST3b · y desde devuelto, devolviéndolo a revisión ⇒ ALLOW', async () => {
  await depositoAB('devuelto', { devueltoPorUid: UID_GESTOR, motivoDevolucion: 'otra foto' })
  await assertSucceeds(reemplazar({ uid: UID_GESTOR, rol: 'gestor' }))
  assert.equal((await leerDep()).estado, 'en_revision')
})

test('ST4 · admin reemplaza versionado, con evento y motivo ⇒ ALLOW', async () => {
  await depositoAB('en_revision')
  await assertSucceeds(reemplazar({ uid: UID_ADMIN, rol: 'admin' }))
})

test('ST5 · staff intenta saltar v1 → v3 ⇒ DENY', async () => {
  await depositoAB('en_revision')
  await assertFails(reemplazar({ uid: UID_GESTOR, rol: 'gestor', version: 3 }))
})

test('ST6 · staff sin evento en el batch ⇒ DENY', async () => {
  await depositoAB('en_revision')
  await assertFails(reemplazar({ uid: UID_GESTOR, rol: 'gestor', sinEvento: true }))
  await depositoAB('en_revision')
  await assertFails(reemplazar({ uid: UID_ADMIN, rol: 'admin', sinEvento: true }))
})

test('ST7 · staff con motivo ausente o fuera de rango ⇒ DENY', async () => {
  await depositoAB('en_revision')
  await assertFails(reemplazar({ uid: UID_GESTOR, rol: 'gestor', extraEvento: { motivo: 'no' } }))
  await depositoAB('en_revision')
  await assertFails(reemplazar({ uid: UID_ADMIN, rol: 'admin', extraEvento: { motivo: 'x'.repeat(301) } }))
})

test('ST7b · staff con el puntero apuntando a otro objeto, o con rol falso ⇒ DENY', async () => {
  await depositoAB('en_revision')
  await assertFails(reemplazar({ uid: UID_GESTOR, rol: 'gestor', pathStorage: `depositos/${UID_MOTO}/${DEP_V}/boucher.jpg` }))
  await depositoAB('en_revision')
  await assertFails(reemplazar({ uid: UID_GESTOR, rol: 'admin' }))
})

test('ST9 · sobre un confirmado, cualquier reemplazo de staff ⇒ DENY', async () => {
  for (const uid of [UID_GESTOR, UID_ADMIN]) {
    await depositoAB('confirmado')
    await assertFails(updateDoc(doc(como(uid), 'ordenes_deposito', DEP_V), {
      boucher: { url: 'https://example.test/x.jpg', pathStorage: 'x' },
    }))
    await depositoAB('confirmado')
    await assertFails(reemplazar({ uid, rol: uid === UID_ADMIN ? 'admin' : 'gestor' }))
  }
})

test('ST10 · convertido_en_deuda y anulado ⇒ DENY', async () => {
  for (const estado of ['convertido_en_deuda', 'anulado']) {
    for (const uid of [UID_GESTOR, UID_ADMIN]) {
      await depositoAB(estado)
      await assertFails(updateDoc(doc(como(uid), 'ordenes_deposito', DEP_V), {
        boucher: { url: 'https://example.test/x.jpg', pathStorage: 'x' },
      }))
    }
  }
})

test('ST11 · lo que sigue del cliente: pedir corrección ⇒ ALLOW; confirmar, convertir y anotar notas ⇒ DENY (FIN-1B)', async () => {
  await depositoAB('en_revision')
  await assertSucceeds(pedirCorreccion())
  await depositoAB('en_revision')
  await assertFails(confirmarCon())
  await depositoAB('en_revision')
  await assertFails(updateDoc(doc(como(UID_GESTOR), 'ordenes_deposito', DEP_V), {
    estado: 'convertido_en_deuda', saldoId: 'saldo1',
  }))
  await depositoAB('en_revision')
  await assertFails(updateDoc(doc(como(UID_GESTOR), 'ordenes_deposito', DEP_V), {
    notaConversion: 'revisado con el motorizado', updatedAt: serverTimestamp(),
  }))
})

test('ST12 · el flujo inicial no se rompe: la PRIMERA carga (boucher + en_revision + updatedAt) de staff y digitador ⇒ ALLOW; el boucher suelto ⇒ DENY', async () => {
  await depositoAB('pendiente_boucher')
  await assertFails(updateDoc(doc(como(UID_GESTOR), 'ordenes_deposito', DEP_V), {
    boucher: { url: 'https://example.test/primero.jpg', pathStorage: 'x' },
  }))
  await depositoAB('pendiente_boucher')
  await assertSucceeds(updateDoc(doc(como(UID_GESTOR), 'ordenes_deposito', DEP_V), {
    boucher: { url: 'https://example.test/primero.jpg', pathStorage: 'x' }, estado: 'en_revision',
  }))
  await depositoAB('pendiente_boucher', { digitadoPorUid: UID_DIGITADOR, digitadoAt: new Date() })
  await assertSucceeds(updateDoc(doc(como(UID_DIGITADOR), 'ordenes_deposito', DEP_V), {
    boucher: { url: 'https://example.test/dig.jpg', pathStorage: 'x' },
    estado: 'en_revision',
    updatedAt: serverTimestamp(),
  }))
})

test('ST13 · el tipo C ya no admite editar su comprobante desde un update suelto ⇒ DENY (FIN-1B: el tipo C solo nace confirmado y solo se anula)', async () => {
  await depositoAB('en_revision', { tipo: 'pago_delivery_deposito', boucherUrl: 'https://example.test/c.jpg' })
  await assertFails(updateDoc(doc(como(UID_GESTOR), 'ordenes_deposito', DEP_V), {
    boucherUrl: 'https://example.test/c2.jpg',
  }))
})

// ═════════════════════════════════════════════════════════════════════════════
// HARDENING FINAL · DG — el digitador tampoco se salta el versionado
//
// Era el último actor con una vía de corrección sin versión, sin evento, sin
// motivo y sin historial: escribía `boucher` a secas y pisaba el objeto legacy
// (deuda DIGITADOR-BOUCHER-NO-VERSIONADO). No se le quita la corrección — se
// le pide el MISMO protocolo que a motorizado, gestor y admin.
//
// Dos diferencias, ninguna arbitraria: la pertenencia es `digitadoPorUid` (la
// fuente autoritativa que ya existía, D2) y SOLO desde 'en_revision'.
// 'devuelto' queda fuera porque el modelo actual no le da al digitador ninguna
// operación sobre ese estado — ver DG12.
// ═════════════════════════════════════════════════════════════════════════════

/** Depósito digitado por UID_DIGITADOR, en el estado del caso. */
const depositoDigitado = (estado: string, extra: Record<string, unknown> = {}) =>
  depositoAB(estado, { digitadoPorUid: UID_DIGITADOR, digitadoAt: new Date(), ...extra })

test('DG1 · primera carga legítima: pendiente_boucher → en_revision con el boucher ⇒ ALLOW', async () => {
  await depositoDigitado('pendiente_boucher')
  await assertSucceeds(updateDoc(doc(como(UID_DIGITADOR), 'ordenes_deposito', DEP_V), {
    boucher: { url: 'https://example.test/primera.jpg', pathStorage: 'x' },
    estado: 'en_revision',
    updatedAt: serverTimestamp(),
  }))
})

test('DG2 · sobrescribir el boucher vigente por la vía directa ⇒ DENY', async () => {
  await depositoDigitado('en_revision')
  const ref = doc(como(UID_DIGITADOR), 'ordenes_deposito', DEP_V)
  await assertFails(updateDoc(ref, { boucher: { url: 'https://example.test/x.jpg', pathStorage: 'x' } }))
  await assertFails(updateDoc(ref, { boucherUrl: 'https://example.test/x.jpg' }))
  await assertFails(updateDoc(ref, { boucherVersion: 7 }))
  await assertFails(updateDoc(ref, { boucher: null }))
})

test('DG3 · reemplazo versionado en en_revision, con evento y motivo ⇒ ALLOW', async () => {
  await depositoDigitado('en_revision')
  await assertSucceeds(reemplazar({ uid: UID_DIGITADOR, rol: 'digitador' }))
  const dep = await leerDep()
  assert.equal(dep.boucherVersion, 2)
  // Y no tocó nada más: DEP-N, monto y órdenes siguen iguales.
  assert.equal(dep.codigo, 'DEP-0007')
  assert.equal(dep.montoTotal, 110)
  assert.deepEqual(dep.solicitudIds, [ORDEN_V])
})

test('DG4 · reemplazo sin evento en el batch ⇒ DENY', async () => {
  await depositoDigitado('en_revision')
  await assertFails(reemplazar({ uid: UID_DIGITADOR, rol: 'digitador', sinEvento: true }))
})

test('DG5 · reemplazo sin motivo, o con motivo fuera de 3-300 ⇒ DENY', async () => {
  await depositoDigitado('en_revision')
  await assertFails(reemplazar({ uid: UID_DIGITADOR, rol: 'digitador', extraEvento: { motivo: 'no' } }))
  await depositoDigitado('en_revision')
  await assertFails(reemplazar({ uid: UID_DIGITADOR, rol: 'digitador', extraEvento: { motivo: 'x'.repeat(301) } }))
})

test('DG6 · salto de versión (1 → 3) ⇒ DENY', async () => {
  await depositoDigitado('en_revision')
  await assertFails(reemplazar({ uid: UID_DIGITADOR, rol: 'digitador', version: 3 }))
})

test('DG7 · otro digitador sobre una digitación ajena ⇒ DENY', async () => {
  await depositoAB('en_revision', { digitadoPorUid: 'uid_otro_digitador', digitadoAt: new Date() })
  await assertFails(reemplazar({ uid: UID_DIGITADOR, rol: 'digitador' }))
  await assertFails(updateDoc(doc(como(UID_DIGITADOR), 'ordenes_deposito', DEP_V), {
    boucher: { url: 'https://example.test/x.jpg', pathStorage: 'x' },
  }))
  // Y sobre un depósito sin digitar (del motorizado), tampoco.
  await depositoAB('en_revision')
  await assertFails(reemplazar({ uid: UID_DIGITADOR, rol: 'digitador' }))
})

test('DG8 · confirmado ⇒ DENY (vía directa y versionada)', async () => {
  await depositoDigitado('confirmado')
  await assertFails(updateDoc(doc(como(UID_DIGITADOR), 'ordenes_deposito', DEP_V), {
    boucher: { url: 'https://example.test/x.jpg', pathStorage: 'x' },
  }))
  await depositoDigitado('confirmado')
  await assertFails(reemplazar({ uid: UID_DIGITADOR, rol: 'digitador' }))
})

test('DG9 · convertido_en_deuda ⇒ DENY', async () => {
  await depositoDigitado('convertido_en_deuda')
  await assertFails(reemplazar({ uid: UID_DIGITADOR, rol: 'digitador' }))
  await depositoDigitado('convertido_en_deuda')
  await assertFails(updateDoc(doc(como(UID_DIGITADOR), 'ordenes_deposito', DEP_V), {
    boucher: { url: 'https://example.test/x.jpg', pathStorage: 'x' },
  }))
})

test('DG10 · anulado y rechazado ⇒ DENY', async () => {
  for (const estado of ['anulado', 'rechazado']) {
    await depositoDigitado(estado)
    await assertFails(reemplazar({ uid: UID_DIGITADOR, rol: 'digitador' }))
    await assertFails(updateDoc(doc(como(UID_DIGITADOR), 'ordenes_deposito', DEP_V), {
      boucher: { url: 'https://example.test/x.jpg', pathStorage: 'x' },
    }))
  }
})

test('DG11 · el evento del digitador es append-only y acotado a su reemplazo', async () => {
  await depositoDigitado('en_revision')
  await assertSucceeds(reemplazar({ uid: UID_DIGITADOR, rol: 'digitador', versionId: 'verDigitAAA1' }))
  const ref = doc(como(UID_DIGITADOR), 'ordenes_deposito', DEP_V, 'eventos', 'verDigitAAA1')
  await assertFails(updateDoc(ref, { motivo: 'otra cosa' }))
  await assertFails(deleteDoc(ref))
  // Y no puede narrar acciones que no son suyas.
  await depositoDigitado('en_revision')
  for (const tipo of ['DEPOSITO_DEVUELTO', 'DEPOSITO_CONFIRMADO', 'DEPOSITO_REHECHO', 'DEPOSITO_ANULADO']) {
    await assertFails(setDoc(doc(como(UID_DIGITADOR), 'ordenes_deposito', DEP_V, 'eventos', `evDG${tipo}`), {
      tipo, at: serverTimestamp(), porUid: UID_DIGITADOR, porRol: 'digitador', motivo: 'motivo suficiente',
    }))
  }
})

test('DG12 · devuelto queda FUERA: el modelo actual no le da esa operación al digitador ⇒ DENY', async () => {
  // No se inventa el permiso. 'devuelto' es una corrección que StorkHub le
  // pide al MOTORIZADO titular, y ni firestore.rules ni storage.rules le daban
  // al digitador ninguna operación sobre ese estado antes de este bloque.
  await depositoDigitado('devuelto', { devueltoPorUid: UID_GESTOR, motivoDevolucion: 'otra foto' })
  await assertFails(reemplazar({ uid: UID_DIGITADOR, rol: 'digitador' }))
  // El motorizado titular sí puede, como siempre.
  await depositoDigitado('devuelto', { devueltoPorUid: UID_GESTOR, motivoDevolucion: 'otra foto' })
  await assertSucceeds(reemplazar())
})

test('DG13 · el reemplazo del digitador no puede tocar monto, órdenes, tipo ni identidad', async () => {
  for (const extra of [
    { montoTotal: 9999 },
    { solicitudIds: ['otra'] },
    { tipo: 'recaudacion_motorizado_comercio' },
    { motorizadoUid: 'uid_otro' },
    { confirmadoPorUid: UID_DIGITADOR },
  ]) {
    await depositoDigitado('en_revision')
    await assertFails(reemplazar({ uid: UID_DIGITADOR, rol: 'digitador', extraDeposito: extra }))
  }
})

// ─── VR · VIAJE-ENTREGADO-SIN-COBRO-1: el viaje es del motorizado ────────────
//
// El agujero P0: un gestor o un admin podía marcar 'entregado' con un updateDoc
// de dos campos, y la orden quedaba sin cobros, sin cobroDelivery y sin
// entregadoAt — pero calcularDeposito() igual le exigía al motorizado depositar
// ese dinero. Acá se fija la barrera: los cuatro estados del viaje no se
// escriben desde cliente, y el motorizado solo manda las dos señales.
//
// La autoridad server (confirmarTransicionConCobro, Admin SDK) no pasa por
// Rules: VR14 lo deja demostrado.

/** Orden en un estado operativo concreto, asignada al motorizado de prueba. */
async function ordenEnViaje(id: string, estado: string) {
  await env.withSecurityRulesDisabled(async (ctx) => {
    await setDoc(doc(ctx.firestore(), 'solicitudes_envio', id), {
      ...ordenBase({
        estado,
        asignacion: { motorizadoAuthUid: UID_MOTO, motorizadoNombre: 'John Pork', estadoAceptacion: 'aceptada' },
      }),
      codigo: 'SH-1001',
      secuencia: 1001,
    })
  })
  return id
}

test('VR1 · gestor: en_camino_entrega → entregado ⇒ DENY', async () => {
  const id = await ordenEnViaje('vr1', 'en_camino_entrega')
  await assertFails(updateDoc(doc(como(UID_GESTOR), 'solicitudes_envio', id), {
    estado: 'entregado',
    updatedAt: serverTimestamp(),
  }))
})

test('VR2 · admin: en_camino_entrega → entregado ⇒ DENY (sin excepción por rol)', async () => {
  const id = await ordenEnViaje('vr2', 'en_camino_entrega')
  await assertFails(updateDoc(doc(como(UID_ADMIN), 'solicitudes_envio', id), {
    estado: 'entregado',
    updatedAt: serverTimestamp(),
  }))
  // Tampoco con la metadata completa: el problema es quién lo escribe.
  await assertFails(updateDoc(doc(como(UID_ADMIN), 'solicitudes_envio', id), {
    estado: 'entregado',
    entregadoAt: serverTimestamp(),
    cobroPendiente: false,
    updatedAt: serverTimestamp(),
  }))
})

test('VR3 · gestor: en_camino_retiro → retirado ⇒ DENY', async () => {
  const id = await ordenEnViaje('vr3', 'en_camino_retiro')
  await assertFails(updateDoc(doc(como(UID_GESTOR), 'solicitudes_envio', id), {
    estado: 'retirado',
    updatedAt: serverTimestamp(),
  }))
})

test('VR4 · admin: retirado → en_camino_entrega ⇒ DENY (también es del viaje)', async () => {
  const id = await ordenEnViaje('vr4', 'retirado')
  await assertFails(updateDoc(doc(como(UID_ADMIN), 'solicitudes_envio', id), {
    estado: 'en_camino_entrega',
    updatedAt: serverTimestamp(),
  }))
  // Y el gestor tampoco puede iniciar el viaje por él.
  const id2 = await ordenEnViaje('vr4b', 'asignada')
  await assertFails(updateDoc(doc(como(UID_GESTOR), 'solicitudes_envio', id2), {
    estado: 'en_camino_retiro',
    updatedAt: serverTimestamp(),
  }))
})

test('VR5 · motorizado: asignada → en_camino_retiro ⇒ ALLOW', async () => {
  const id = await ordenEnViaje('vr5', 'asignada')
  await assertSucceeds(updateDoc(doc(como(UID_MOTO), 'solicitudes_envio', id), {
    estado: 'en_camino_retiro',
    updatedAt: serverTimestamp(),
    'historial.en_camino_retiroAt': serverTimestamp(),
  }))
})

test('VR6 · motorizado: retirado → en_camino_entrega ⇒ ALLOW', async () => {
  const id = await ordenEnViaje('vr6', 'retirado')
  await assertSucceeds(updateDoc(doc(como(UID_MOTO), 'solicitudes_envio', id), {
    estado: 'en_camino_entrega',
    updatedAt: serverTimestamp(),
    'historial.en_camino_entregaAt': serverTimestamp(),
  }))
})

test('VR7 · motorizado: en_camino_retiro → retirado por updateDoc ⇒ DENY', async () => {
  const id = await ordenEnViaje('vr7', 'en_camino_retiro')
  await assertFails(updateDoc(doc(como(UID_MOTO), 'solicitudes_envio', id), {
    estado: 'retirado',
    updatedAt: serverTimestamp(),
    'historial.retiradoAt': serverTimestamp(),
  }))
})

test('VR8 · motorizado: en_camino_entrega → entregado por updateDoc ⇒ DENY', async () => {
  const id = await ordenEnViaje('vr8', 'en_camino_entrega')
  await assertFails(updateDoc(doc(como(UID_MOTO), 'solicitudes_envio', id), {
    estado: 'entregado',
    entregadoAt: serverTimestamp(),
    updatedAt: serverTimestamp(),
  }))
})

test('VR9 · motorizado: asignada → entregado ⇒ DENY', async () => {
  const id = await ordenEnViaje('vr9', 'asignada')
  await assertFails(updateDoc(doc(como(UID_MOTO), 'solicitudes_envio', id), {
    estado: 'entregado',
    entregadoAt: serverTimestamp(),
    updatedAt: serverTimestamp(),
  }))
})

test('VR10 · motorizado: asignada → en_camino_entrega ⇒ DENY (salto)', async () => {
  const id = await ordenEnViaje('vr10', 'asignada')
  await assertFails(updateDoc(doc(como(UID_MOTO), 'solicitudes_envio', id), {
    estado: 'en_camino_entrega',
    updatedAt: serverTimestamp(),
  }))
  // Y en_camino_retiro → en_camino_entrega tampoco.
  const id2 = await ordenEnViaje('vr10b', 'en_camino_retiro')
  await assertFails(updateDoc(doc(como(UID_MOTO), 'solicitudes_envio', id2), {
    estado: 'en_camino_entrega',
    updatedAt: serverTimestamp(),
  }))
})

test('VR11 · gestor: rechazada → pendiente_confirmacion ⇒ ALLOW (reactivación intacta)', async () => {
  const id = await ordenConCodigo('vr11', { estado: 'rechazada', rechazo: { motivoCodigo: 'otro' } })
  await assertSucceeds(updateDoc(doc(como(UID_GESTOR), 'solicitudes_envio', id), {
    estado: 'pendiente_confirmacion',
    rechazo: null,
    asignacion: null,
    updatedAt: serverTimestamp(),
  }))
})

test('VR12 · gestor: cancelada → pendiente_confirmacion ⇒ ALLOW', async () => {
  const id = await ordenConCodigo('vr12', { estado: 'cancelada' })
  await assertSucceeds(updateDoc(doc(como(UID_GESTOR), 'solicitudes_envio', id), {
    estado: 'pendiente_confirmacion',
    rechazo: null,
    asignacion: null,
    updatedAt: serverTimestamp(),
  }))
})

test('VR13 · gestor: rechazada → confirmada ⇒ DENY (el único destino es pendiente)', async () => {
  const id = await ordenConCodigo('vr13', { estado: 'rechazada' })
  await assertFails(updateDoc(doc(como(UID_GESTOR), 'solicitudes_envio', id), {
    estado: 'confirmada',
    updatedAt: serverTimestamp(),
  }))
})

test('VR14 · la autoridad server no pasa por Rules: Admin SDK persiste entregado', async () => {
  const id = await ordenEnViaje('vr14', 'en_camino_entrega')
  await env.withSecurityRulesDisabled(async (ctx) => {
    await assertSucceeds(updateDoc(doc(ctx.firestore(), 'solicitudes_envio', id), {
      estado: 'entregado',
      entregadoAt: serverTimestamp(),
      'historial.entregadoAt': serverTimestamp(),
      cobroPendiente: false,
      updatedAt: serverTimestamp(),
    }))
  })
})

test('VR15 · gestor y admin conservan lo administrativo y lo financiero (la asignación ya no se fabrica desde cliente)', async () => {
  // Confirmar: intacto.
  const id = await ordenConCodigo('vr15', { estado: 'pendiente_confirmacion' })
  await assertSucceeds(updateDoc(doc(como(UID_GESTOR), 'solicitudes_envio', id), {
    estado: 'confirmada',
    updatedAt: serverTimestamp(),
  }))
  // FIN-1C-A: el precio confirmado (confirmacion.precioFinalCordobas) lo escribe asignarMotorizado, no el cliente.
  const idP = await ordenConCodigo('vr15p', { estado: 'pendiente_confirmacion' })
  await assertFails(updateDoc(doc(como(UID_GESTOR), 'solicitudes_envio', idP), {
    estado: 'confirmada',
    confirmacion: { precioFinalCordobas: 90, confirmadoPorUid: UID_GESTOR, confirmadoAt: serverTimestamp() },
    updatedAt: serverTimestamp(),
  }))
  // MOTO-ASIGNACION-RULES-CIERRE-1 (R2): este caso pineaba como ALLOW que el
  // gestor escribiera la asignación a mano. Ese contrato cambió a propósito:
  // asignar es de la callable asignarMotorizado, no del cliente. La cobertura
  // completa de R2 (gestor y admin; crear, cambiar, fabricar 'aceptada', y lo
  // que sí se conserva) vive en las pruebas AR-R2 más abajo.
  await assertFails(updateDoc(doc(como(UID_GESTOR), 'solicitudes_envio', id), {
    estado: 'asignada',
    asignacion: { motorizadoAuthUid: UID_MOTO, motorizadoNombre: 'John Pork', estadoAceptacion: 'pendiente' },
    updatedAt: serverTimestamp(),
  }))
  // Rechazar y cancelar: intactos.
  const id2 = await ordenConCodigo('vr15b', { estado: 'pendiente_confirmacion' })
  await assertSucceeds(updateDoc(doc(como(UID_GESTOR), 'solicitudes_envio', id2), {
    estado: 'rechazada',
    rechazo: { motivoCodigo: 'otro', rechazadoPorUid: UID_GESTOR, rechazadoAt: serverTimestamp() },
    asignacion: null,
    updatedAt: serverTimestamp(),
  }))
  const id3 = await ordenConCodigo('vr15c', { estado: 'confirmada' })
  await assertSucceeds(updateDoc(doc(como(UID_GESTOR), 'solicitudes_envio', id3), {
    estado: 'cancelada',
    updatedAt: serverTimestamp(),
  }))
  // FIN-1E: este caso pineaba como ALLOW que el gestor escribiera un puntero de depósito SUELTO (depX) en una orden entregada. Ese contrato cambió a
  // propósito: el puntero solo nace hacia un depósito real que lista la orden (batch del flujo, getAfter). Lo suelto es DENY; el caso legítimo vive en
  // FIN1E-P1..P4. Una escritura que no mueve estado ni toca un input financiero (nota interna) sigue permitida.
  const id4 = await ordenConCodigo('vr15d', { estado: 'entregado' })
  await assertFails(updateDoc(doc(como(UID_GESTOR), 'solicitudes_envio', id4), {
    'registro.deposito.storkhubDepositoId': 'depX',
    updatedAt: serverTimestamp(),
  }))
  await assertSucceeds(updateDoc(doc(como(UID_GESTOR), 'solicitudes_envio', id4), {
    notaInterna: 'revisar con el comercio',
    updatedAt: serverTimestamp(),
  }))
})

test('VR16 · el motorizado conserva sus escrituras que no mueven estado', async () => {
  const id = await ordenEnViaje('vr16', 'en_camino_entrega')
  // Evidencias y marcador semanal: sin tocar estado, siguen pasando.
  await assertSucceeds(updateDoc(doc(como(UID_MOTO), 'solicitudes_envio', id), {
    evidencias: { entrega: 'https://example.test/e.jpg' },
    updatedAt: serverTimestamp(),
  }))
  await assertSucceeds(updateDoc(doc(como(UID_MOTO), 'solicitudes_envio', id), {
    acumulacionCobroSemanal: { estado: 'pendiente', updatedAt: serverTimestamp() },
  }))
})

// ─── VR · VIAJE-CANCELACION-CONSISTENCIA-1 ───────────────────────────────────
//
// Cancelar (o devolver a confirmada) una orden asignada limpia la asignación de
// la SOLICITUD. Las Rules ya lo autorizan: esto lo deja demostrado y evita que un
// cambio futuro lo rompa sin que nadie se entere. El perfil del motorizado no
// participa: su disponibilidad no la decide este flujo.

const ASIGNACION_ACEPTADA = {
  motorizadoId: 'moto1',
  motorizadoAuthUid: UID_MOTO,
  motorizadoNombre: 'John Pork',
  estadoAceptacion: 'aceptada',
}

test('VR17 · gestor: asignada → cancelada con asignacion null, canceladaAt y updatedAt ⇒ ALLOW', async () => {
  const id = await ordenConCodigo('vr17', { estado: 'asignada', asignacion: ASIGNACION_ACEPTADA })
  await assertSucceeds(updateDoc(doc(como(UID_GESTOR), 'solicitudes_envio', id), {
    estado: 'cancelada',
    asignacion: null,
    'historial.canceladaAt': serverTimestamp(),
    updatedAt: serverTimestamp(),
  }))
})

test('VR18 · gestor: asignada → confirmada con asignacion null y updatedAt ⇒ ALLOW', async () => {
  const id = await ordenConCodigo('vr18', { estado: 'asignada', asignacion: ASIGNACION_ACEPTADA })
  await assertSucceeds(updateDoc(doc(como(UID_GESTOR), 'solicitudes_envio', id), {
    estado: 'confirmada',
    asignacion: null,
    updatedAt: serverTimestamp(),
  }))
})

test('VR19 · gestor: confirmada → cancelada sin asignación, solo la orden ⇒ ALLOW', async () => {
  const id = await ordenConCodigo('vr19', { estado: 'confirmada' })
  await assertSucceeds(updateDoc(doc(como(UID_GESTOR), 'solicitudes_envio', id), {
    estado: 'cancelada',
    'historial.canceladaAt': serverTimestamp(),
    updatedAt: serverTimestamp(),
  }))
})

// ─── VR · VIAJE-RECHAZO-MOTORIZADO-TRAZA-1: historia de la solicitud ─────────
//
// solicitudes_envio/{id}/eventos la escribe solo el servidor (Admin SDK, que no
// evalúa Rules). Ningún cliente crea, edita ni borra un evento; la lectura es
// solo de gestor y admin, y el resto de los roles no gana acceso nuevo.

const EVENTO_RECHAZO = {
  tipo: 'rechazo_motorizado',
  porUid: UID_MOTO,
  motorizadoId: 'moto1',
  motorizadoNombre: 'John Pork',
  solicitudId: 'vr20',
}

async function ordenConEvento(id: string) {
  await ordenEnViaje(id, 'asignada')
  await env.withSecurityRulesDisabled(async (ctx) => {
    await setDoc(doc(ctx.firestore(), 'solicitudes_envio', id, 'eventos', 'ev1'), {
      ...EVENTO_RECHAZO,
      solicitudId: id,
      at: new Date(),
    })
  })
  return id
}

test('VR20 · gestor y admin leen los eventos de una solicitud ⇒ ALLOW', async () => {
  const id = await ordenConEvento('vr20')
  for (const uid of [UID_GESTOR, UID_ADMIN]) {
    const db = como(uid)
    await assertSucceeds(getDoc(doc(db, 'solicitudes_envio', id, 'eventos', 'ev1')))
    await assertSucceeds(getDocs(collection(db, 'solicitudes_envio', id, 'eventos')))
  }
})

test('VR21 · nadie más lee la historia: motorizado, comercio y digitador ⇒ DENY', async () => {
  const id = await ordenConEvento('vr21')
  for (const uid of [UID_MOTO, UID_COMERCIO, UID_DIGITADOR]) {
    const db = como(uid)
    await assertFails(getDoc(doc(db, 'solicitudes_envio', id, 'eventos', 'ev1')))
    await assertFails(getDocs(collection(db, 'solicitudes_envio', id, 'eventos')))
  }
})

test('VR22 · ningún cliente crea un evento, ni siquiera gestor o admin ⇒ DENY', async () => {
  const id = await ordenEnViaje('vr22', 'asignada')
  for (const uid of [UID_MOTO, UID_COMERCIO, UID_GESTOR, UID_ADMIN, UID_DIGITADOR]) {
    await assertFails(setDoc(doc(como(uid), 'solicitudes_envio', id, 'eventos', 'nuevo_' + uid), {
      ...EVENTO_RECHAZO,
      solicitudId: id,
      at: serverTimestamp(),
    }))
  }
})

test('VR23 · ningún cliente edita ni borra un evento existente ⇒ DENY', async () => {
  const id = await ordenConEvento('vr23')
  for (const uid of [UID_MOTO, UID_COMERCIO, UID_GESTOR, UID_ADMIN]) {
    const ref = doc(como(uid), 'solicitudes_envio', id, 'eventos', 'ev1')
    await assertFails(updateDoc(ref, { motorizadoNombre: 'Otro' }))
    await assertFails(deleteDoc(ref))
  }
})

test('VR24 · la subcolección no afloja la solicitud raíz: el comercio sigue sin escribir su estado ⇒ DENY', async () => {
  const id = await ordenConEvento('vr24')
  await assertFails(updateDoc(doc(como(UID_COMERCIO), 'solicitudes_envio', id), {
    estado: 'confirmada',
    updatedAt: serverTimestamp(),
  }))
})

// ─── UR · MOTO-ALTA-AUTH-ROL-1: la identidad con rol es server-authoritative ──
//
// El alta del acceso de un motorizado pasó a la Cloud Function
// crearAccesoMotorizado (Admin SDK, que no evalúa este archivo). Estas pruebas
// fijan lo que los CLIENTES ya no pueden hacer y lo que conservan.

const PERFIL_MOTORIZADO_VIEJO = {
  name: 'Luigi Alonzo',
  email: 'luigi@example.com',
  rol: 'motorizado',
  activo: true,
  creadoPorGestor: true,
}

test('UR1 · el gestor ya no fabrica un perfil de motorizado desde el cliente ⇒ DENY', async () => {
  // Es exactamente el payload que escribía el alta anterior desde el navegador.
  await assertFails(setDoc(doc(como(UID_GESTOR), 'usuarios', 'uid_nuevo_moto'), {
    ...PERFIL_MOTORIZADO_VIEJO,
    createdAt: serverTimestamp(),
    updatedAt: serverTimestamp(),
  }))
  // Ni con otro rol, ni con el rol de un privilegiado.
  for (const rol of ['motorizado', 'Comercio', 'cliente', 'gestor', 'admin', 'digitador']) {
    await assertFails(setDoc(doc(como(UID_GESTOR), 'usuarios', 'uid_otro_' + rol), {
      ...PERFIL_MOTORIZADO_VIEJO,
      rol,
      createdAt: serverTimestamp(),
      updatedAt: serverTimestamp(),
    }))
  }
})

test('UR2 · nadie se autoasigna un rol: ni al crear su perfil ni al editarlo', async () => {
  // El auto-registro sin rol sigue permitido (es el perfil mínimo del login).
  await assertSucceeds(setDoc(doc(como('uid_recien_llegado'), 'usuarios', 'uid_recien_llegado'), {
    email: 'nuevo@example.com',
    createdAt: serverTimestamp(),
    updatedAt: serverTimestamp(),
  }))
  // Pero con rol o con activo, no.
  await assertFails(setDoc(doc(como('uid_intruso'), 'usuarios', 'uid_intruso'), {
    email: 'x@example.com',
    rol: 'admin',
    createdAt: serverTimestamp(),
    updatedAt: serverTimestamp(),
  }))
  await assertFails(setDoc(doc(como('uid_intruso2'), 'usuarios', 'uid_intruso2'), {
    email: 'x@example.com',
    activo: true,
    createdAt: serverTimestamp(),
    updatedAt: serverTimestamp(),
  }))
  // Un perfil sin rol (el caso del motorizado sin acceso completo) no puede
  // dárselo él mismo.
  await env.withSecurityRulesDisabled(async (ctx) => {
    await setDoc(doc(ctx.firestore(), 'usuarios', 'uid_sin_rol'), { email: 'sr@example.com', createdAt: new Date(), updatedAt: new Date() })
  })
  await assertFails(updateDoc(doc(como('uid_sin_rol'), 'usuarios', 'uid_sin_rol'), { rol: 'motorizado', activo: true, updatedAt: serverTimestamp() }))
})

test('UR3 · un motorizado no puede cambiar su propio rol ni su estado de activación ⇒ DENY', async () => {
  const ref = doc(como(UID_MOTO), 'usuarios', UID_MOTO)
  await assertFails(updateDoc(ref, { rol: 'admin', updatedAt: serverTimestamp() }))
  await assertFails(updateDoc(ref, { rol: 'gestor', updatedAt: serverTimestamp() }))
  await assertFails(updateDoc(ref, { activo: false, updatedAt: serverTimestamp() }))
})

test('UR4 · el admin conserva su capacidad administrativa sobre usuarios ⇒ ALLOW', async () => {
  await assertSucceeds(setDoc(doc(como(UID_ADMIN), 'usuarios', 'uid_creado_por_admin'), {
    ...PERFIL_MOTORIZADO_VIEJO,
    createdAt: serverTimestamp(),
    updatedAt: serverTimestamp(),
  }))
  await assertSucceeds(updateDoc(doc(como(UID_ADMIN), 'usuarios', 'uid_creado_por_admin'), { rol: 'motorizado', activo: true, updatedAt: serverTimestamp() }))
})

test('UR5 · el gestor conserva editar el nombre de un perfil operativo y nada más; los demás roles no ganan acceso', async () => {
  // Retenido: saveProfile() sincroniza solo `name` en perfiles que ya tienen rol.
  await assertSucceeds(updateDoc(doc(como(UID_GESTOR), 'usuarios', UID_MOTO), { name: 'Otro nombre', updatedAt: serverTimestamp() }))
  // No puede tocar rol ni activo de un perfil existente.
  await assertFails(updateDoc(doc(como(UID_GESTOR), 'usuarios', UID_MOTO), { rol: 'admin', updatedAt: serverTimestamp() }))
  await assertFails(updateDoc(doc(como(UID_GESTOR), 'usuarios', UID_MOTO), { activo: false, updatedAt: serverTimestamp() }))
  // Y un perfil sin rol no lo puede reparar un gestor: es cosa del admin (Function).
  await env.withSecurityRulesDisabled(async (ctx) => {
    await setDoc(doc(ctx.firestore(), 'usuarios', 'uid_sin_rol2'), { email: 'sr@example.com', createdAt: new Date(), updatedAt: new Date() })
  })
  await assertFails(updateDoc(doc(como(UID_GESTOR), 'usuarios', 'uid_sin_rol2'), { rol: 'motorizado', activo: true, updatedAt: serverTimestamp() }))
  // Comercio, motorizado y digitador no crean perfiles ajenos.
  for (const uid of [UID_COMERCIO, UID_MOTO, UID_DIGITADOR]) {
    await assertFails(setDoc(doc(como(uid), 'usuarios', 'uid_ajeno_' + uid), {
      ...PERFIL_MOTORIZADO_VIEJO,
      createdAt: serverTimestamp(),
      updatedAt: serverTimestamp(),
    }))
  }
})

async function motorizadoConCuenta(id: string) {
  await env.withSecurityRulesDisabled(async (ctx) => {
    await setDoc(doc(ctx.firestore(), 'motorizado', id), {
      nombre: 'Luigi Alonzo',
      telefono: '77889911',
      estado: 'disponible',
      activo: true,
      authUid: UID_MOTO,
    })
  })
  return id
}

test('UR6 · ningún cliente escribe el vínculo de la cuenta: authUid lo pone solo el servidor ⇒ DENY', async () => {
  const id = await motorizadoConCuenta('mot_ur6')
  for (const uid of [UID_GESTOR, UID_ADMIN]) {
    const ref = doc(como(uid), 'motorizado', id)
    await assertFails(updateDoc(ref, { authUid: 'uid_pegado_a_mano' }))
    await assertFails(updateDoc(ref, { authUid: null }))
    await assertFails(updateDoc(ref, { accesoProvisionAuthUid: 'x' }))
    await assertFails(updateDoc(ref, { accesoEmail: 'a@b.com' }))
    await assertFails(updateDoc(ref, { welcomeAttempts: [1] }))
  }
  // Crear un motorizado con un authUid ya puesto tampoco.
  await assertFails(setDoc(doc(como(UID_GESTOR), 'motorizado', 'mot_nuevo_con_uid'), { nombre: 'X', telefono: '1', estado: 'disponible', activo: true, authUid: 'uid_pegado_a_mano' }))
  await assertFails(setDoc(doc(como(UID_ADMIN), 'motorizado', 'mot_nuevo_con_uid2'), { nombre: 'X', telefono: '1', estado: 'disponible', activo: true, authUid: 'uid_pegado_a_mano' }))
})

test('UR7 · el gestor conserva crear y editar motorizados sin tocar el vínculo ⇒ ALLOW', async () => {
  const id = await motorizadoConCuenta('mot_ur7')
  const ref = doc(como(UID_GESTOR), 'motorizado', id)
  await assertSucceeds(updateDoc(ref, { nombre: 'Luigi A.', telefono: '70000000', tieneBolso: true, estado: 'inactivo' }))
  // Un motorizado nuevo se crea SIN cuenta (authUid ausente o null).
  await assertSucceeds(setDoc(doc(como(UID_GESTOR), 'motorizado', 'mot_nuevo'), { nombre: 'Nuevo', telefono: '1', estado: 'disponible', activo: true, tieneBolso: false }))
  await assertSucceeds(setDoc(doc(como(UID_GESTOR), 'motorizado', 'mot_nuevo_null'), { nombre: 'Nuevo', telefono: '1', estado: 'disponible', activo: true, authUid: null }))
})

test('UR8 · el motorizado conserva sus escrituras propias y no puede tocar su vínculo ⇒ ALLOW / DENY', async () => {
  const id = await motorizadoConCuenta('mot_ur8')
  const ref = doc(como(UID_MOTO), 'motorizado', id)
  await assertSucceeds(updateDoc(ref, { estado: 'inactivo', updatedAt: serverTimestamp() }))
  await assertFails(updateDoc(ref, { authUid: 'otro_uid', updatedAt: serverTimestamp() }))
  await assertFails(updateDoc(ref, { nombre: 'Otro nombre', updatedAt: serverTimestamp() }))
})

// MOTO-DISPONIBILIDAD-CONTRATO-1 — `estado` es presencia: disponible / inactivo.
// `ocupado` es legacy: se conserva donde ya está, pero nadie lo escribe de nuevo.
async function motorizadoConEstado(id: string, estado: string) {
  await env.withSecurityRulesDisabled(async (ctx) => {
    await setDoc(doc(ctx.firestore(), 'motorizado', id), { nombre: 'Luigi Alonzo', telefono: '77889911', estado, activo: true, authUid: UID_MOTO })
  })
  return id
}

test('MDR1 · la presencia se alterna en ambos sentidos: motorizado, gestor y admin ⇒ ALLOW', async () => {
  const id = await motorizadoConEstado('mot_mdr1', 'disponible')
  const propio = doc(como(UID_MOTO), 'motorizado', id)
  await assertSucceeds(updateDoc(propio, { estado: 'inactivo', updatedAt: serverTimestamp() }))
  await assertSucceeds(updateDoc(propio, { estado: 'disponible', updatedAt: serverTimestamp() }))
  await assertSucceeds(updateDoc(doc(como(UID_GESTOR), 'motorizado', id), { estado: 'inactivo' }))
  await assertSucceeds(updateDoc(doc(como(UID_ADMIN), 'motorizado', id), { estado: 'disponible' }))
})

test('MDR2 · nadie fabrica un `ocupado` nuevo: ni al editar ni al crear ⇒ DENY', async () => {
  const id = await motorizadoConEstado('mot_mdr2', 'disponible')
  for (const uid of [UID_MOTO, UID_GESTOR, UID_ADMIN]) {
    await assertFails(updateDoc(doc(como(uid), 'motorizado', id), { estado: 'ocupado', updatedAt: serverTimestamp() }))
  }
  await assertFails(setDoc(doc(como(UID_GESTOR), 'motorizado', 'mot_mdr2_nuevo'), { nombre: 'X', telefono: '1', estado: 'ocupado', activo: true }))
  await assertFails(updateDoc(doc(como(UID_MOTO), 'motorizado', id), { estado: 'cualquiera', updatedAt: serverTimestamp() }))
})

test('MDR3 · un documento legacy `ocupado` recibe cambios ajenos sin migrarlo, y puede salir de ese valor ⇒ ALLOW', async () => {
  const id = await motorizadoConEstado('mot_mdr3', 'ocupado')
  await assertSucceeds(updateDoc(doc(como(UID_GESTOR), 'motorizado', id), { telefono: '70000000' }))
  await assertSucceeds(updateDoc(doc(como(UID_MOTO), 'motorizado', id), { ultimaUbicacionOperativa: { lat: 12.1, lng: -86.2 }, updatedAt: serverTimestamp() }))
  await assertSucceeds(updateDoc(doc(como(UID_MOTO), 'motorizado', id), { estado: 'inactivo', updatedAt: serverTimestamp() }))
})

// MOTO-STATS-ACEPTACION-TRAZA-1 — las métricas de aceptación las escribe el servidor.
async function motorizadoConMetricas(id: string) {
  await env.withSecurityRulesDisabled(async (ctx) => {
    await setDoc(doc(ctx.firestore(), 'motorizado', id), {
      nombre: 'Luigi Alonzo', telefono: '77889911', estado: 'disponible', activo: true, authUid: UID_MOTO,
      totalAsignaciones: 4, totalAceptadas: 3, totalRechazos: 1, tasaAceptacion: 0.75, tiempoPromedioAceptacion: 20,
      metricasAceptacion: { version: 2, totalDecisiones: 2, totalAceptadas: 1, totalRechazadas: 1, tasaAceptacion: 0.5 },
    })
  })
  return id
}

test('MAT10 · el motorizado no puede fabricar sus contadores legacy (los que alimentan el ranking) ⇒ DENY', async () => {
  const id = await motorizadoConMetricas('mot_mat10')
  const ref = doc(como(UID_MOTO), 'motorizado', id)
  for (const campo of ['totalAsignaciones', 'totalAceptadas', 'totalRechazos', 'tasaAceptacion', 'tiempoPromedioAceptacion']) {
    await assertFails(updateDoc(ref, { [campo]: 999, updatedAt: serverTimestamp() }))
  }
  await assertFails(updateDoc(ref, { totalAceptadas: 10, totalAsignaciones: 10, tasaAceptacion: 1, updatedAt: serverTimestamp() }))
})

test('MAT11 · nadie desde el cliente escribe la proyección canónica: motorizado, gestor ni admin ⇒ DENY', async () => {
  const id = await motorizadoConMetricas('mot_mat11')
  const nueva = { version: 2, totalDecisiones: 100, totalAceptadas: 100, totalRechazadas: 0, tasaAceptacion: 1 }
  await assertFails(updateDoc(doc(como(UID_MOTO), 'motorizado', id), { metricasAceptacion: nueva, updatedAt: serverTimestamp() }))
  await assertFails(updateDoc(doc(como(UID_MOTO), 'motorizado', id), { 'metricasAceptacion.totalAceptadas': 100, updatedAt: serverTimestamp() }))
  for (const uid of [UID_GESTOR, UID_ADMIN]) {
    await assertFails(updateDoc(doc(como(uid), 'motorizado', id), { metricasAceptacion: nueva }))
    await assertFails(updateDoc(doc(como(uid), 'motorizado', id), { 'metricasAceptacion.totalAceptadas': 100 }))
  }
  // Ni siquiera al crear un motorizado.
  await assertFails(setDoc(doc(como(UID_GESTOR), 'motorizado', 'mot_mat11_nuevo'), { nombre: 'X', telefono: '1', estado: 'disponible', activo: true, metricasAceptacion: nueva }))
})

test('MAT12 · lo que el motorizado sí conserva sigue permitido: presencia y ubicación; y el gestor edita sus campos sin tocar las métricas ⇒ ALLOW', async () => {
  const id = await motorizadoConMetricas('mot_mat12')
  const propio = doc(como(UID_MOTO), 'motorizado', id)
  await assertSucceeds(updateDoc(propio, { estado: 'inactivo', updatedAt: serverTimestamp() }))
  await assertSucceeds(updateDoc(propio, { estado: 'disponible', ubicacion: { lat: 12, lng: -86 }, updatedAt: serverTimestamp() }))
  await assertSucceeds(updateDoc(propio, { ultimaUbicacionOperativa: { lat: 12.1, lng: -86.2 }, updatedAt: serverTimestamp() }))
  await assertSucceeds(updateDoc(doc(como(UID_GESTOR), 'motorizado', id), { telefono: '70000000' }))
  await assertSucceeds(updateDoc(doc(como(UID_ADMIN), 'motorizado', id), { nombre: 'Luigi A.' }))
})

// ─── AR · MOTO-ASIGNACION-RULES-CIERRE-1 ─────────────────────────────────────
//
// Frontera de autorización de la asignación y la respuesta del motorizado.
// Aceptar y rechazar NO se escriben por Rules: son de la callable
// responderAsignacion (Admin SDK). Lo que las Rules deben garantizar es que
// ninguna ruta directa equivalente exista: ni para un motorizado ajeno, ni para
// uno que todavía no aceptó, ni para fabricar la asignación desde un cliente de
// gestor o admin (R2). Antes de este bloque ese contrato solo estaba probado
// del lado de las Functions.

/** Orden con los campos sensibles reales del schema, asignada a quien se indique. */
async function ordenAsignadaA(
  id: string,
  estado: string,
  asignacion: Record<string, unknown> | null,
  extra: Record<string, unknown> = {},
) {
  await env.withSecurityRulesDisabled(async (ctx) => {
    await setDoc(doc(ctx.firestore(), 'solicitudes_envio', id), {
      ...ordenBase({
        estado,
        asignacion,
        confirmacion: { precioFinalCordobas: 90, confirmadoPorUid: UID_GESTOR },
        cotizacion: { origenCoord: { lat: 12.1, lng: -86.2 }, destinoCoord: { lat: 12.2, lng: -86.3 } },
        recoleccion: { coord: { lat: 12.1, lng: -86.2 }, direccion: 'Retiro X' },
        entrega: { coord: { lat: 12.2, lng: -86.3 }, direccion: 'Entrega Y' },
        pagoDelivery: { tipo: 'contado', quienPaga: 'recoleccion', montoSugerido: 90 },
        recargoZona: { aplica: false, monto: 0 },
        ...extra,
      }),
      codigo: 'SH-1001',
      secuencia: 1001,
    })
  })
  return id
}

const asignacionDe = (uid: string, estadoAceptacion?: unknown) => ({
  motorizadoId: `m_${uid}`,
  motorizadoAuthUid: uid,
  motorizadoNombre: 'Rider',
  ...(estadoAceptacion === undefined ? {} : { estadoAceptacion }),
})

/** La señal legítima del motorizado: salir a retirar. */
const senalEnCaminoRetiro = () => ({
  estado: 'en_camino_retiro',
  updatedAt: serverTimestamp(),
  'historial.en_camino_retiroAt': serverTimestamp(),
})
const senalEnCaminoEntrega = () => ({
  estado: 'en_camino_entrega',
  updatedAt: serverTimestamp(),
  'historial.en_camino_entregaAt': serverTimestamp(),
})
const refOrden = (uid: string, id: string) => doc(como(uid), 'solicitudes_envio', id)

// ── Ownership cruzado ────────────────────────────────────────────────────────

test('AR1 · el motorizado A no puede modificar ni leer una solicitud asignada al motorizado B ⇒ DENY', async () => {
  const id = await ordenAsignadaA('ar1', 'asignada', asignacionDe(UID_MOTO_B, 'aceptada'))
  await assertFails(updateDoc(refOrden(UID_MOTO, id), senalEnCaminoRetiro()))
  await assertFails(updateDoc(refOrden(UID_MOTO, id), { evidencias: { retiro: 'https://example.test/a.jpg' }, updatedAt: serverTimestamp() }))
  await assertFails(getDoc(refOrden(UID_MOTO, id)))
  // Control: el dueño real sí puede, así que lo de arriba se negó por la propiedad y no por otra cosa.
  await assertSucceeds(updateDoc(refOrden(UID_MOTO_B, id), senalEnCaminoRetiro()))
})

test('AR2 · el motorizado A no ejecuta transiciones operativas ni la ruta directa equivalente a rechazar sobre la orden de B ⇒ DENY', async () => {
  const enViaje = await ordenAsignadaA('ar2a', 'retirado', asignacionDe(UID_MOTO_B, 'aceptada'))
  await assertFails(updateDoc(refOrden(UID_MOTO, enViaje), senalEnCaminoEntrega()))
  const asignada = await ordenAsignadaA('ar2b', 'asignada', asignacionDe(UID_MOTO_B, 'pendiente'))
  // Rechazar es de la callable; escribirlo directo (estado + asignacion null) no es una vía.
  await assertFails(updateDoc(refOrden(UID_MOTO, asignada), { estado: 'confirmada', asignacion: null, updatedAt: serverTimestamp() }))
  // Control: B sí avanza en lo suyo.
  await assertSucceeds(updateDoc(refOrden(UID_MOTO_B, enViaje), senalEnCaminoEntrega()))
})

// ── R1 · no se sale a retirar sin haber aceptado ─────────────────────────────

test('AR3a · asignada + aceptada → en_camino_retiro ⇒ ALLOW', async () => {
  const id = await ordenAsignadaA('ar3a', 'asignada', asignacionDe(UID_MOTO, 'aceptada'))
  await assertSucceeds(updateDoc(refOrden(UID_MOTO, id), senalEnCaminoRetiro()))
})

test('AR3b · asignada + pendiente → en_camino_retiro ⇒ DENY (no se salta la aceptación)', async () => {
  const id = await ordenAsignadaA('ar3b', 'asignada', asignacionDe(UID_MOTO, 'pendiente'))
  await assertFails(updateDoc(refOrden(UID_MOTO, id), senalEnCaminoRetiro()))
})

test('AR3c · asignada + rechazada → en_camino_retiro ⇒ DENY', async () => {
  const id = await ordenAsignadaA('ar3c', 'asignada', asignacionDe(UID_MOTO, 'rechazada'))
  await assertFails(updateDoc(refOrden(UID_MOTO, id), senalEnCaminoRetiro()))
})

test('AR3d · asignada + expirada → en_camino_retiro ⇒ DENY', async () => {
  const id = await ordenAsignadaA('ar3d', 'asignada', asignacionDe(UID_MOTO, 'expirada'))
  await assertFails(updateDoc(refOrden(UID_MOTO, id), senalEnCaminoRetiro()))
})

test('AR3e · asignación LEGACY sin estadoAceptacion → en_camino_retiro ⇒ ALLOW (no se rompen las órdenes históricas)', async () => {
  const id = await ordenAsignadaA('ar3e', 'asignada', asignacionDe(UID_MOTO))
  await assertSucceeds(updateDoc(refOrden(UID_MOTO, id), senalEnCaminoRetiro()))
})

test('AR3f · estadoAceptacion presente pero null o de un valor desconocido ⇒ DENY (el default solo cubre la AUSENCIA del campo)', async () => {
  const nula = await ordenAsignadaA('ar3f1', 'asignada', asignacionDe(UID_MOTO, null))
  await assertFails(updateDoc(refOrden(UID_MOTO, nula), senalEnCaminoRetiro()))
  const rara = await ordenAsignadaA('ar3f2', 'asignada', asignacionDe(UID_MOTO, 'quizas'))
  await assertFails(updateDoc(refOrden(UID_MOTO, rara), senalEnCaminoRetiro()))
})

test('AR-estados · la señal en_camino_retiro no sale de cancelada, confirmada, retirado ni entregado ⇒ DENY', async () => {
  for (const estado of ['cancelada', 'confirmada', 'retirado', 'entregado']) {
    const id = await ordenAsignadaA(`ares_${estado}`, estado, asignacionDe(UID_MOTO, 'aceptada'))
    await assertFails(updateDoc(refOrden(UID_MOTO, id), senalEnCaminoRetiro()))
  }
})

// ── Campos sensibles: el motorizado no los toca ──────────────────────────────

test('AR9 · el motorizado no puede cambiar el precio, ni solo ni junto a su señal ⇒ DENY', async () => {
  const id = await ordenAsignadaA('ar9', 'asignada', asignacionDe(UID_MOTO, 'aceptada'))
  await assertFails(updateDoc(refOrden(UID_MOTO, id), { 'confirmacion.precioFinalCordobas': 1, updatedAt: serverTimestamp() }))
  await assertFails(updateDoc(refOrden(UID_MOTO, id), { confirmacion: { precioFinalCordobas: 1, confirmadoPorUid: UID_MOTO }, updatedAt: serverTimestamp() }))
  await assertFails(updateDoc(refOrden(UID_MOTO, id), { 'pagoDelivery.montoSugerido': 1, updatedAt: serverTimestamp() }))
  await assertFails(updateDoc(refOrden(UID_MOTO, id), { recargoZona: { aplica: true, monto: 500 }, updatedAt: serverTimestamp() }))
  // Control: la señal limpia sobre el mismo documento sí pasa.
  await assertSucceeds(updateDoc(refOrden(UID_MOTO, id), senalEnCaminoRetiro()))
})

test('AR10 · tampoco por la ruta directa equivalente a rechazar/operar: precio junto a estado y asignacion null ⇒ DENY', async () => {
  const id = await ordenAsignadaA('ar10', 'asignada', asignacionDe(UID_MOTO, 'pendiente'))
  await assertFails(updateDoc(refOrden(UID_MOTO, id), {
    estado: 'confirmada',
    asignacion: null,
    'confirmacion.precioFinalCordobas': 1,
    updatedAt: serverTimestamp(),
  }))
})

test('AR11 · el motorizado no puede cambiar direcciones, coords ni la cotización ⇒ DENY', async () => {
  const id = await ordenAsignadaA('ar11', 'asignada', asignacionDe(UID_MOTO, 'aceptada'))
  await assertFails(updateDoc(refOrden(UID_MOTO, id), { 'recoleccion.coord': { lat: 0, lng: 0 }, updatedAt: serverTimestamp() }))
  await assertFails(updateDoc(refOrden(UID_MOTO, id), { entrega: { coord: { lat: 0, lng: 0 }, direccion: 'Otra' }, updatedAt: serverTimestamp() }))
  await assertFails(updateDoc(refOrden(UID_MOTO, id), { cotizacion: { origenCoord: null, destinoCoord: null }, updatedAt: serverTimestamp() }))
  await assertSucceeds(updateDoc(refOrden(UID_MOTO, id), senalEnCaminoRetiro()))
})

test('AR12 · el motorizado no puede cambiar el cliente ni el comercio de la orden ⇒ DENY', async () => {
  const id = await ordenAsignadaA('ar12', 'asignada', asignacionDe(UID_MOTO, 'aceptada'))
  for (const campo of [
    { userId: 'otro' },
    { comercioId: 'otro' },
    { comercioUid: 'otro' },
    { ownerSnapshot: { uid: 'otro', companyName: 'Otro' } },
  ]) {
    await assertFails(updateDoc(refOrden(UID_MOTO, id), { ...campo, updatedAt: serverTimestamp() }))
  }
  await assertSucceeds(updateDoc(refOrden(UID_MOTO, id), senalEnCaminoRetiro()))
})

test('AR13 · el motorizado no puede autoasignarse ni fabricar su propia aceptación ⇒ DENY', async () => {
  // Orden sin asignar: no es "su" orden, así que no hay rama que lo deje escribirla.
  const libre = await ordenAsignadaA('ar13a', 'confirmada', null)
  await assertFails(updateDoc(refOrden(UID_MOTO, libre), { estado: 'asignada', asignacion: asignacionDe(UID_MOTO, 'aceptada'), updatedAt: serverTimestamp() }))
  // Orden asignada a otro: tampoco puede tomarla.
  const ajena = await ordenAsignadaA('ar13b', 'asignada', asignacionDe(UID_MOTO_B, 'pendiente'))
  await assertFails(updateDoc(refOrden(UID_MOTO, ajena), { asignacion: asignacionDe(UID_MOTO, 'aceptada'), updatedAt: serverTimestamp() }))
  // Su propia orden, todavía pendiente: no puede marcarla aceptada a mano (eso es de la callable).
  const propia = await ordenAsignadaA('ar13c', 'asignada', asignacionDe(UID_MOTO, 'pendiente'))
  await assertFails(updateDoc(refOrden(UID_MOTO, propia), { 'asignacion.estadoAceptacion': 'aceptada', updatedAt: serverTimestamp() }))
})

test('AR14 · el motorizado asignado no puede reasignar la orden a otro rider ni cambiar su propio vínculo ⇒ DENY', async () => {
  const id = await ordenAsignadaA('ar14', 'asignada', asignacionDe(UID_MOTO, 'aceptada'))
  await assertFails(updateDoc(refOrden(UID_MOTO, id), { asignacion: asignacionDe(UID_MOTO_B, 'pendiente'), updatedAt: serverTimestamp() }))
  await assertFails(updateDoc(refOrden(UID_MOTO, id), { 'asignacion.motorizadoAuthUid': UID_MOTO_B, updatedAt: serverTimestamp() }))
  await assertFails(updateDoc(refOrden(UID_MOTO, id), { asignacion: null, estado: 'confirmada', updatedAt: serverTimestamp() }))
})

// ── Reasignación: el rider anterior pierde la orden, el nuevo la gana ────────

test('AR19 · tras reasignar de A a B, A pierde lectura y no puede actualizar ni salir a retirar ⇒ DENY', async () => {
  const id = await ordenAsignadaA('ar19', 'asignada', asignacionDe(UID_MOTO, 'aceptada'))
  await assertSucceeds(getDoc(refOrden(UID_MOTO, id)))
  // La reasignación la hace la callable (Admin SDK): se simula con las reglas apagadas.
  await env.withSecurityRulesDisabled(async (ctx) => {
    await updateDoc(doc(ctx.firestore(), 'solicitudes_envio', id), { asignacion: asignacionDe(UID_MOTO_B, 'pendiente') })
  })
  await assertFails(getDoc(refOrden(UID_MOTO, id)))
  await assertFails(updateDoc(refOrden(UID_MOTO, id), senalEnCaminoRetiro()))
  await assertFails(updateDoc(refOrden(UID_MOTO, id), { evidencias: { retiro: 'https://example.test/a.jpg' }, updatedAt: serverTimestamp() }))
  // Un rechazo (asignacion null) también la saca de su alcance.
  const rechazada = await ordenAsignadaA('ar19b', 'asignada', asignacionDe(UID_MOTO, 'pendiente'))
  await env.withSecurityRulesDisabled(async (ctx) => {
    await updateDoc(doc(ctx.firestore(), 'solicitudes_envio', rechazada), { estado: 'confirmada', asignacion: null })
  })
  await assertFails(getDoc(refOrden(UID_MOTO, rechazada)))
})

test('AR20 · el rider nuevo, con la asignación vigente y aceptada, sí ejecuta la transición; pendiente todavía no ⇒ ALLOW / DENY', async () => {
  const id = await ordenAsignadaA('ar20', 'asignada', asignacionDe(UID_MOTO, 'aceptada'))
  await env.withSecurityRulesDisabled(async (ctx) => {
    await updateDoc(doc(ctx.firestore(), 'solicitudes_envio', id), { asignacion: asignacionDe(UID_MOTO_B, 'pendiente') })
  })
  await assertSucceeds(getDoc(refOrden(UID_MOTO_B, id)))
  await assertFails(updateDoc(refOrden(UID_MOTO_B, id), senalEnCaminoRetiro()))
  // Acepta (la callable lo escribe con Admin SDK): ahora sí.
  await env.withSecurityRulesDisabled(async (ctx) => {
    await updateDoc(doc(ctx.firestore(), 'solicitudes_envio', id), { 'asignacion.estadoAceptacion': 'aceptada' })
  })
  await assertSucceeds(updateDoc(refOrden(UID_MOTO_B, id), senalEnCaminoRetiro()))
})

// ── Campos extra junto a una transición válida ───────────────────────────────

test('AR22 · una transición válida con un campo prohibido colado en el mismo update ⇒ DENY (no solo codigo/secuencia)', async () => {
  const id = await ordenAsignadaA('ar22', 'asignada', asignacionDe(UID_MOTO, 'aceptada'))
  const prohibidos: Array<Record<string, unknown>> = [
    { confirmacion: { precioFinalCordobas: 1, confirmadoPorUid: UID_MOTO } },
    { cotizacion: { origenCoord: null, destinoCoord: null } },
    { asignacion: asignacionDe(UID_MOTO_B, 'pendiente') },
    // Un cambio REAL dentro de la asignación (escribir 'aceptada' sobre un documento que ya
    // la tiene no cambia nada y no cuenta): fabricar la aceptación se prueba abajo, sobre pendiente.
    { 'asignacion.motorizadoNombre': 'Otro nombre' },
    { userId: 'otro' },
  ]
  for (const extra of prohibidos) {
    await assertFails(updateDoc(refOrden(UID_MOTO, id), { ...senalEnCaminoRetiro(), ...extra }))
  }
  // Y el caso que más importa: con la asignación PENDIENTE, salir a retirar y fabricar la aceptación en el mismo update.
  const pendiente = await ordenAsignadaA('ar22b', 'asignada', asignacionDe(UID_MOTO, 'pendiente'))
  await assertFails(updateDoc(refOrden(UID_MOTO, pendiente), { ...senalEnCaminoRetiro(), 'asignacion.estadoAceptacion': 'aceptada' }))
  await assertFails(updateDoc(refOrden(UID_MOTO, pendiente), { ...senalEnCaminoRetiro(), asignacion: asignacionDe(UID_MOTO, 'aceptada') }))
  // Control: la señal sola sí pasa sobre el documento ya aceptado.
  await assertSucceeds(updateDoc(refOrden(UID_MOTO, id), senalEnCaminoRetiro()))
})

// ── R2 · la asignación no se fabrica desde un cliente de gestor ni de admin ──

const STAFF = [['gestor', UID_GESTOR], ['admin', UID_ADMIN]] as const

test('AR-R2a · gestor y admin no pueden crear una asignación no nula directamente (null → mapa) ⇒ DENY', async () => {
  for (const [rol, uid] of STAFF) {
    const id = await ordenAsignadaA(`arr2a_${rol}`, 'confirmada', null)
    await assertFails(updateDoc(refOrden(uid, id), { estado: 'asignada', asignacion: asignacionDe(UID_MOTO, 'pendiente'), updatedAt: serverTimestamp() }))
    // Ni siquiera dejando el estado quieto.
    await assertFails(updateDoc(refOrden(uid, id), { asignacion: asignacionDe(UID_MOTO, 'pendiente'), updatedAt: serverTimestamp() }))
  }
})

test('AR-R2b · gestor y admin no pueden cambiar una asignación existente (A → B) ⇒ DENY', async () => {
  for (const [rol, uid] of STAFF) {
    const id = await ordenAsignadaA(`arr2b_${rol}`, 'asignada', asignacionDe(UID_MOTO, 'pendiente'))
    await assertFails(updateDoc(refOrden(uid, id), { asignacion: asignacionDe(UID_MOTO_B, 'pendiente'), updatedAt: serverTimestamp() }))
    await assertFails(updateDoc(refOrden(uid, id), { 'asignacion.motorizadoAuthUid': UID_MOTO_B, updatedAt: serverTimestamp() }))
  }
})

test('AR-R2c · gestor y admin no pueden fabricar la aceptación tocando asignacion.estadoAceptacion ⇒ DENY', async () => {
  for (const [rol, uid] of STAFF) {
    const id = await ordenAsignadaA(`arr2c_${rol}`, 'asignada', asignacionDe(UID_MOTO, 'pendiente'))
    await assertFails(updateDoc(refOrden(uid, id), { 'asignacion.estadoAceptacion': 'aceptada', updatedAt: serverTimestamp() }))
    await assertFails(updateDoc(refOrden(uid, id), { 'asignacion.aceptadoAt': serverTimestamp(), updatedAt: serverTimestamp() }))
  }
})

test('AR-R2d · lo que el producto sí hace desde cliente se conserva: dejar la asignación igual, omitirla o limpiarla ⇒ ALLOW', async () => {
  for (const [rol, uid] of STAFF) {
    const asignada = await ordenAsignadaA(`arr2d_${rol}`, 'asignada', asignacionDe(UID_MOTO, 'aceptada'))
    // Update administrativo que no menciona la asignación.
    await assertSucceeds(updateDoc(refOrden(uid, asignada), { detalle: 'nota del gestor', updatedAt: serverTimestamp() }))
    // Reescribir la MISMA asignación no es fabricar nada.
    await assertSucceeds(updateDoc(refOrden(uid, asignada), { asignacion: asignacionDe(UID_MOTO, 'aceptada'), updatedAt: serverTimestamp() }))
    // Limpiarla: rebotar a confirmada ("No asignar todavía") o cancelar.
    await assertSucceeds(updateDoc(refOrden(uid, asignada), { estado: 'confirmada', asignacion: null, updatedAt: serverTimestamp() }))
    const aCancelar = await ordenAsignadaA(`arr2d_c_${rol}`, 'asignada', asignacionDe(UID_MOTO, 'pendiente'))
    await assertSucceeds(updateDoc(refOrden(uid, aCancelar), { estado: 'cancelada', asignacion: null, canceladaAt: serverTimestamp(), updatedAt: serverTimestamp() }))
  }
})

// ── No regresión: multiasignación sin tope ───────────────────────────────────

test('AR-multi · un motorizado con varias órdenes asignadas y aceptadas avanza cada una: las Rules no ponen tope de carga ⇒ ALLOW', async () => {
  const ids: string[] = []
  for (const n of [1, 2, 3, 4, 5]) ids.push(await ordenAsignadaA(`armulti${n}`, 'asignada', asignacionDe(UID_MOTO, 'aceptada')))
  for (const id of ids) await assertSucceeds(updateDoc(refOrden(UID_MOTO, id), senalEnCaminoRetiro()))
})

// ─── CR · MOTO-ASIGNACION-RULES-CREATE-1 ─────────────────────────────────────
//
// Cierra por la ruta de CREATE lo que R2 ya cierra por la de UPDATE: una
// solicitud creada desde el cliente no puede nacer asignada. Antes de este
// bloque gestor, admin y comercio podían crear una orden con estado 'asignada'
// y un mapa `asignacion` (incluso con estadoAceptacion 'aceptada'), saltándose
// la callable asignarMotorizado (elegibilidad, concurrencia) y la aceptación
// explícita. Los dos writers vivos (comercio/solicitar y gestor/ingresar-orden)
// nacen siempre en 'pendiente_confirmacion' o 'programada' y sin `asignacion`.
//
// Server authority (CR10, documentado y no probado acá a propósito): el Admin
// SDK no evalúa estas Rules, así que la callable y cualquier Function pueden
// seguir creando o asignando; probarlo dentro de un test de Rules solo
// demostraría que las Rules están apagadas.

const ESTADOS_DE_NACIMIENTO = ['pendiente_confirmacion', 'programada'] as const

const ASIGNACION_FABRICADA = {
  motorizadoId: 'm1',
  motorizadoAuthUid: UID_MOTO,
  motorizadoNombre: 'John Pork',
  estadoAceptacion: 'aceptada',
}

const nacer = (uid: string, id: string, payload: Record<string, unknown>) =>
  setDoc(doc(como(uid), 'solicitudes_envio', id), payload)

const CREADORES = [['comercio', UID_COMERCIO], ['gestor', UID_GESTOR], ['admin', UID_ADMIN]] as const

test('CR1 · gestor crea una solicitud normal, en cualquiera de sus dos estados de nacimiento ⇒ ALLOW', async () => {
  for (const estado of ESTADOS_DE_NACIMIENTO) {
    await assertSucceeds(nacer(UID_GESTOR, `cr1_${estado}`, ordenBase({ estado })))
  }
})

test('CR2 · gestor intenta crear con un mapa asignacion ⇒ DENY (y la misma orden sin asignacion sí pasa)', async () => {
  await assertFails(nacer(UID_GESTOR, 'cr2a', ordenBase({ asignacion: ASIGNACION_FABRICADA })))
  await assertFails(nacer(UID_GESTOR, 'cr2b', ordenBase({ asignacion: { motorizadoAuthUid: UID_MOTO } })))
  await assertSucceeds(nacer(UID_GESTOR, 'cr2c', ordenBase()))
})

test('CR3 · admin intenta crear con un mapa asignacion ⇒ DENY (y la misma orden sin asignacion sí pasa)', async () => {
  await assertFails(nacer(UID_ADMIN, 'cr3a', ordenBase({ asignacion: ASIGNACION_FABRICADA })))
  await assertFails(nacer(UID_ADMIN, 'cr3b', ordenBase({ asignacion: { motorizadoAuthUid: UID_MOTO } })))
  await assertSucceeds(nacer(UID_ADMIN, 'cr3c', ordenBase()))
})

test('CR4 · comercio crea una solicitud normal, en cualquiera de sus dos estados de nacimiento ⇒ ALLOW', async () => {
  for (const estado of ESTADOS_DE_NACIMIENTO) {
    await assertSucceeds(nacer(UID_COMERCIO, `cr4_${estado}`, ordenBase({ estado })))
  }
})

test('CR5 · comercio intenta crear su propia solicitud con un mapa asignacion ⇒ DENY', async () => {
  await assertFails(nacer(UID_COMERCIO, 'cr5a', ordenBase({ asignacion: ASIGNACION_FABRICADA })))
  // El caso completo del hallazgo: ya asignada Y con la aceptación fabricada.
  await assertFails(nacer(UID_COMERCIO, 'cr5b', ordenBase({ estado: 'asignada', asignacion: ASIGNACION_FABRICADA })))
  await assertSucceeds(nacer(UID_COMERCIO, 'cr5c', ordenBase()))
})

test('CR6 · nadie crea una solicitud ya avanzada: estado asignada o cualquier estado operativo ⇒ DENY', async () => {
  for (const [, uid] of CREADORES) {
    await assertFails(nacer(uid, `cr6_asignada_${uid}`, ordenBase({ estado: 'asignada' })))
  }
  // Mismo hueco, otros estados del viaje: una orden no puede nacer ya en curso ni ya cerrada.
  for (const estado of ['confirmada', 'en_camino_retiro', 'retirado', 'en_camino_entrega', 'entregado', 'cancelada', 'rechazada']) {
    await assertFails(nacer(UID_GESTOR, `cr6_${estado}`, ordenBase({ estado })))
  }
})

test('CR6b · una solicitud creada sin estado ⇒ DENY (el estado de nacimiento tiene que venir y ser uno de los dos reales)', async () => {
  const { estado: _quitado, ...sinEstado } = ordenBase()
  void _quitado
  for (const [, uid] of CREADORES) {
    await assertFails(nacer(uid, `cr6b_${uid}`, sinEstado))
  }
})

test('CR7 · crear con asignacion explícitamente null ⇒ ALLOW', async () => {
  for (const [rol, uid] of CREADORES) {
    await assertSucceeds(nacer(uid, `cr7_${rol}`, ordenBase({ asignacion: null })))
  }
})

test('CR8 · crear con la clave asignacion ausente ⇒ ALLOW', async () => {
  for (const [rol, uid] of CREADORES) {
    const payload = ordenBase()
    assert.equal('asignacion' in payload, false)
    await assertSucceeds(nacer(uid, `cr8_${rol}`, payload))
  }
})

test('CR9 · crear con estadoAceptacion embebido en una asignacion, o con asignacion de cualquier forma no nula ⇒ DENY', async () => {
  for (const estadoAceptacion of ['aceptada', 'pendiente', 'rechazada', 'expirada']) {
    await assertFails(nacer(UID_GESTOR, `cr9_${estadoAceptacion}`, ordenBase({ asignacion: { estadoAceptacion } })))
  }
  // No importa el interior: ni un mapa vacío ni un valor que no sea mapa.
  await assertFails(nacer(UID_GESTOR, 'cr9_vacio', ordenBase({ asignacion: {} })))
  await assertFails(nacer(UID_GESTOR, 'cr9_string', ordenBase({ asignacion: 'm1' })))
  await assertFails(nacer(UID_COMERCIO, 'cr9_com', ordenBase({ asignacion: { estadoAceptacion: 'aceptada' } })))
})

test('CR-cliente · el cliente individual conserva su creación normal y no puede nacer asignado ⇒ ALLOW / DENY', async () => {
  const personal = (extra: Record<string, unknown> = {}) => ({
    userId: UID_CLIENTE,
    comercioUid: UID_CLIENTE,
    ownerSnapshot: { uid: UID_CLIENTE, nombre: 'Cliente' },
    estado: 'pendiente_confirmacion',
    tipoCliente: 'contado',
    createdAt: serverTimestamp(),
    ...extra,
  })
  await assertFails(nacer(UID_CLIENTE, 'cr_cli_asig', personal({ asignacion: ASIGNACION_FABRICADA })))
  await assertFails(nacer(UID_CLIENTE, 'cr_cli_estado', personal({ estado: 'asignada' })))
  await assertSucceeds(nacer(UID_CLIENTE, 'cr_cli_ok', personal()))
})

test('CR-digitador · el digitador no crea solicitudes, con o sin asignacion ⇒ DENY (contrato actual preservado)', async () => {
  await assertFails(nacer(UID_DIGITADOR, 'cr_dig_ok', ordenBase()))
  await assertFails(nacer(UID_DIGITADOR, 'cr_dig_asig', ordenBase({ asignacion: ASIGNACION_FABRICADA })))
})

// ─── FG-R · FIN-2 · un gasto se descuenta una sola vez ───────────────────────
//
// GASTO-APROBADO-DESCUENTO-REPETIDO-1. La relación gasto → depósito que lo
// consumió (`consumidoEnDepositoId`) se escribe en el MISMO batch que crea el
// depósito, y firestore.rules es la guardia autoritativa: el gasto tiene que
// seguir sin consumir AL COMMIT. Estos casos usan los mismos helpers que los
// writers reales (marcarGastosConsumidos / liberarGastosDeDeposito).
//
// Lo que NO cierra FIN-2 (queda para FIN-1): el resto de la escritura de
// gastos por gestor/admin sigue siendo de cliente.

async function sembrarGastosFin2(extraGastos: Record<string, Record<string, unknown>> = {}) {
  await env.withSecurityRulesDisabled(async (ctx) => {
    const db = ctx.firestore()
    await setDoc(doc(db, 'motorizado', 'mot1'), { authUid: UID_MOTO, nombre: 'M1' })
    await setDoc(doc(db, 'motorizado', 'mot2'), { authUid: UID_MOTO_B, nombre: 'M2' })
    for (const id of ['g1', 'g2', 'g3']) {
      await setDoc(doc(db, 'gastos_motorizado', id), { motorizadoId: 'mot1', estado: 'aprobado', monto: 10, tipo: 'peaje_terminal' })
    }
    await setDoc(doc(db, 'gastos_motorizado', 'gOtro'), { motorizadoId: 'mot2', estado: 'aprobado', monto: 10, tipo: 'peaje_terminal' })
    await setDoc(doc(db, 'gastos_motorizado', 'gAnulado'), { motorizadoId: 'mot1', estado: 'anulado', monto: 10, tipo: 'peaje_terminal' })
    for (const [id, d] of Object.entries(extraGastos)) await setDoc(doc(db, 'gastos_motorizado', id), d)
  })
}

async function sembrarDepositoFin2(id: string, estado: string, gastosIds: string[], extra: Record<string, unknown> = {}) {
  await env.withSecurityRulesDisabled(async (ctx) => {
    await setDoc(doc(ctx.firestore(), 'ordenes_deposito', id), depositoBase({ estado, gastosIds, ...extra }))
  })
}

async function leerGastoFin2(id: string): Promise<Record<string, unknown> | undefined> {
  let data: Record<string, unknown> | undefined
  await env.withSecurityRulesDisabled(async (ctx) => { data = (await getDoc(doc(ctx.firestore(), 'gastos_motorizado', id))).data() })
  return data
}

async function leerDepositoFin2(id: string): Promise<Record<string, unknown> | undefined> {
  let data: Record<string, unknown> | undefined
  await env.withSecurityRulesDisabled(async (ctx) => { data = (await getDoc(doc(ctx.firestore(), 'ordenes_deposito', id))).data() })
  return data
}

/** El commit que crea un depósito con sus gastos: lo que hacen los 4 writers reales. */
function batchCrearDepositoConGastos(uid: string, depId: string, gastosIds: string[], extraDeposito: Record<string, unknown> = {}) {
  const db = como(uid)
  const b = writeBatch(db)
  b.set(doc(db, 'ordenes_deposito', depId), depositoBase({
    gastosIds, gastosDescontados: gastosIds.length * 10, montoBruto: 100 + gastosIds.length * 10, montoTotal: 100, ...extraDeposito,
  }))
  marcarGastosConsumidos(b, (id) => doc(db, 'gastos_motorizado', id), gastosIds, depId)
  return b
}

/** La anulación auditada de un depósito (admin + evento) y, opcionalmente, la liberación de gastos. */
function batchAnularDepositoFin2(uid: string, depId: string, liberar: string[]) {
  const db = como(uid)
  const b = writeBatch(db)
  b.set(doc(db, 'ordenes_deposito', depId), camposAnularDeposito(uid, serverTimestamp(), 'Depósito mal armado', 'evAnulFin2'), { merge: true })
  b.set(doc(db, 'ordenes_deposito', depId, 'eventos', 'evAnulFin2'),
    camposEventoDepositoAnulado({ uid, rol: 'admin' }, serverTimestamp(), 'Depósito mal armado'))
  liberarGastosDeDeposito(b, (id) => doc(db, 'gastos_motorizado', id),
    liberar.map((id) => ({ id, consumidoEnDepositoId: depId })), depId, deleteField())
  return { db, b }
}

test('FG-R1 · FLUJO MOTORIZADO: crea su depósito y marca sus gastos en un batch ⇒ ALLOW, con la relación gasto → depósito escrita', async () => {
  await sembrarGastosFin2()
  await assertSucceeds(batchCrearDepositoConGastos(UID_MOTO, 'D1', ['g1', 'g2']).commit())
  assert.equal((await leerGastoFin2('g1'))?.consumidoEnDepositoId, 'D1')
  assert.equal((await leerGastoFin2('g2'))?.consumidoEnDepositoId, 'D1')
  assert.equal((await leerGastoFin2('g3'))?.consumidoEnDepositoId, undefined, 'el gasto que no entró queda libre')
  assert.deepEqual((await leerDepositoFin2('D1'))?.gastosIds, ['g1', 'g2'])
})

test('FG-R2 · FG3/FG9 DOS PESTAÑAS: ambas ven g1 libre, D1 gana y D2 NO consume el mismo gasto ⇒ DENY, sin escrituras parciales', async () => {
  await sembrarGastosFin2()
  // Tab A y tab B arman su commit con g1 todavía libre en memoria.
  const tabA = batchCrearDepositoConGastos(UID_MOTO, 'D1', ['g1'])
  const tabB = batchCrearDepositoConGastos(UID_MOTO, 'D2', ['g1', 'g2'])
  await assertSucceeds(tabA.commit())
  await assertFails(tabB.commit())
  assert.equal(await leerDepositoFin2('D2'), undefined, 'D2 no se creó: el batch es todo o nada')
  assert.equal((await leerGastoFin2('g1'))?.consumidoEnDepositoId, 'D1', 'g1 sigue siendo de D1')
  assert.equal((await leerGastoFin2('g2'))?.consumidoEnDepositoId, undefined, 'g2 tampoco quedó marcado a medias')
})

test('FG-R3 · FLUJO GESTOR: el gestor crea un depósito con gastos ⇒ ALLOW; otro depósito (gestor o motorizado) con el mismo gasto ⇒ DENY', async () => {
  await sembrarGastosFin2()
  await assertSucceeds(batchCrearDepositoConGastos(UID_GESTOR, 'D3', ['g3']).commit())
  assert.equal((await leerGastoFin2('g3'))?.consumidoEnDepositoId, 'D3')
  await assertFails(batchCrearDepositoConGastos(UID_GESTOR, 'D4', ['g3']).commit())
  await assertFails(batchCrearDepositoConGastos(UID_MOTO, 'D5', ['g3']).commit())
  assert.equal(await leerDepositoFin2('D4'), undefined)
  assert.equal(await leerDepositoFin2('D5'), undefined)
})

test('FG-R4 · FLUJO DIGITADOR: el digitador crea el depósito que digita con sus gastos ⇒ ALLOW; el mismo gasto en otro ⇒ DENY', async () => {
  await sembrarGastosFin2()
  const dig = { digitadoPorUid: UID_DIGITADOR, digitadoAt: serverTimestamp() }
  await assertSucceeds(batchCrearDepositoConGastos(UID_DIGITADOR, 'D6', ['g1'], dig).commit())
  assert.equal((await leerGastoFin2('g1'))?.consumidoEnDepositoId, 'D6')
  await assertFails(batchCrearDepositoConGastos(UID_DIGITADOR, 'D7', ['g1'], { ...dig, digitadoAt: serverTimestamp() }).commit())
})

test('FG-R5 · nadie marca un gasto "consumido" a mano: sin depósito, ajeno, no listado, de otro motorizado o anulado ⇒ DENY', async () => {
  await sembrarGastosFin2()
  const m = como(UID_MOTO)
  // sin depósito
  await assertFails(updateDoc(doc(m, 'gastos_motorizado', 'g1'), { consumidoEnDepositoId: 'DX' }))
  // depósito propio que NO lista el gasto
  await sembrarDepositoFin2('DVacio', 'pendiente_boucher', [])
  await assertFails(updateDoc(doc(m, 'gastos_motorizado', 'g1'), { consumidoEnDepositoId: 'DVacio' }))
  // gasto de OTRO motorizado dentro de mi depósito
  await assertFails(batchCrearDepositoConGastos(UID_MOTO, 'DAjeno', ['gOtro']).commit())
  // depósito de otro motorizado
  await assertFails(batchCrearDepositoConGastos(UID_MOTO_B, 'DDeB', ['g1'], { motorizadoUid: UID_MOTO }).commit())
  // gasto anulado
  await assertFails(batchCrearDepositoConGastos(UID_MOTO, 'DAnulado', ['gAnulado']).commit())
  // además de la marca, tocar otro campo del gasto
  const db = como(UID_MOTO)
  const b = writeBatch(db)
  b.set(doc(db, 'ordenes_deposito', 'DExtra'), depositoBase({ gastosIds: ['g1'] }))
  b.update(doc(db, 'gastos_motorizado', 'g1'), { consumidoEnDepositoId: 'DExtra', monto: 1 })
  await assertFails(b.commit())
  assert.equal((await leerGastoFin2('g1'))?.consumidoEnDepositoId, undefined)
  // y liberar una marca ajena
  await sembrarGastosFin2({ gMarcado: { motorizadoId: 'mot1', estado: 'aprobado', monto: 10, consumidoEnDepositoId: 'DVacio' } })
  await assertFails(updateDoc(doc(m, 'gastos_motorizado', 'gMarcado'), { consumidoEnDepositoId: deleteField() }))
})

test('FG-R6 · FG4/FG5/FG17: devuelto, en_revision (rehacer) y confirmado CONSERVAN el gasto: ni se libera ni lo toma otro depósito ⇒ DENY', async () => {
  for (const estado of ['en_revision', 'devuelto', 'confirmado']) {
    await env.clearFirestore()
    await env.withSecurityRulesDisabled(async (ctx) => {
      const db = ctx.firestore()
      await setDoc(doc(db, 'usuarios', UID_GESTOR), { activo: true, rol: 'gestor' })
      await setDoc(doc(db, 'usuarios', UID_ADMIN), { activo: true, rol: 'admin' })
      await setDoc(doc(db, 'usuarios', UID_MOTO), { activo: true, rol: 'motorizado' })
    })
    await sembrarGastosFin2({ gUsado: { motorizadoId: 'mot1', estado: 'aprobado', monto: 10, consumidoEnDepositoId: 'DV' } })
    await sembrarDepositoFin2('DV', estado, ['gUsado'])
    // liberar sin que el depósito esté anulado
    await assertFails(updateDoc(doc(como(UID_ADMIN), 'gastos_motorizado', 'gUsado'), { consumidoEnDepositoId: deleteField() }), )
    // otro depósito que quiere el mismo gasto
    await assertFails(batchCrearDepositoConGastos(UID_MOTO, 'DNuevo', ['gUsado']).commit())
    assert.equal((await leerGastoFin2('gUsado'))?.consumidoEnDepositoId, 'DV', estado)
  }
})

test('FG-R7 · FG6 + FIN-4A: un depósito CONVERTIDO EN DEUDA no se anula, ni liberando su gasto ni sin liberarlo ⇒ DENY, y el gasto sigue consumido', async () => {
  await sembrarGastosFin2({ gUsado: { motorizadoId: 'mot1', estado: 'aprobado', monto: 10, consumidoEnDepositoId: 'DC' } })
  await sembrarDepositoFin2('DC', 'convertido_en_deuda', ['gUsado'])
  await assertFails(batchAnularDepositoFin2(UID_ADMIN, 'DC', ['gUsado']).b.commit())
  assert.equal((await leerDepositoFin2('DC'))?.estado, 'convertido_en_deuda', 'el batch es todo o nada')
  // Antes de FIN-4A esta anulación SIN liberar el gasto pasaba (⇒ ALLOW) y dejaba la
  // deuda viva sin ledger. Ahora el writer genérico ya no anula un convertido.
  await assertFails(batchAnularDepositoFin2(UID_ADMIN, 'DC', []).b.commit())
  assert.equal((await leerDepositoFin2('DC'))?.estado, 'convertido_en_deuda')
  assert.equal((await leerGastoFin2('gUsado'))?.consumidoEnDepositoId, 'DC', 'el efecto económico ya ocurrió: el gasto sigue consumido')
})

test('FG-R8 · FG7: anular un depósito que libera sus órdenes ya NO libera sus gastos desde el cliente ⇒ DENY (FIN-1B: lo hace anularDeposito)', async () => {
  await sembrarGastosFin2({ gUsado: { motorizadoId: 'mot1', estado: 'aprobado', monto: 10, consumidoEnDepositoId: 'DA' } })
  await sembrarDepositoFin2('DA', 'en_revision', ['gUsado'])
  await assertFails(batchAnularDepositoFin2(UID_ADMIN, 'DA', ['gUsado']).b.commit())
  assert.equal((await leerDepositoFin2('DA'))?.estado, 'en_revision')
  assert.equal((await leerGastoFin2('gUsado'))?.consumidoEnDepositoId, 'DA', 'el gasto sigue consumido por DA')
})

test('FG-R9 · FG11/FG12: ni anular D1 ni limpiar la marca de otro depósito desde el cliente ⇒ DENY; todo queda como estaba', async () => {
  await sembrarGastosFin2({
    gDeD1: { motorizadoId: 'mot1', estado: 'aprobado', monto: 10, consumidoEnDepositoId: 'D1' },
    gDeD2: { motorizadoId: 'mot1', estado: 'aprobado', monto: 10, consumidoEnDepositoId: 'D2' },
  })
  await sembrarDepositoFin2('D1', 'en_revision', ['gDeD1'])
  await sembrarDepositoFin2('D2', 'en_revision', ['gDeD2'])
  const { db, b } = batchAnularDepositoFin2(UID_ADMIN, 'D1', ['gDeD1'])
  b.update(doc(db, 'gastos_motorizado', 'gDeD2'), { consumidoEnDepositoId: deleteField() })
  await assertFails(b.commit())
  await assertFails(batchAnularDepositoFin2(UID_ADMIN, 'D1', ['gDeD1']).b.commit())
  assert.equal((await leerDepositoFin2('D1'))?.estado, 'en_revision')
  assert.equal((await leerGastoFin2('gDeD1'))?.consumidoEnDepositoId, 'D1')
  assert.equal((await leerGastoFin2('gDeD2'))?.consumidoEnDepositoId, 'D2')
})

test('FG-R10 · FG8 LEGACY: un gasto sin marcador, aunque figure en gastosIds de un depósito viejo, sigue consumible hasta el backfill (FIN-GASTOS-CONSUMO-BACKFILL-1)', async () => {
  await sembrarGastosFin2()
  await sembrarDepositoFin2('DViejo', 'confirmado', ['g3'])
  await assertSucceeds(batchCrearDepositoConGastos(UID_MOTO, 'DNuevo', ['g3']).commit())
  assert.equal((await leerGastoFin2('g3'))?.consumidoEnDepositoId, 'DNuevo')
})

test('FG-R11 · FG10: crear D2 no cambia el snapshot histórico de D1 (gastosIds, gastosDescontados, montoBruto, montoTotal)', async () => {
  await sembrarGastosFin2()
  await assertSucceeds(batchCrearDepositoConGastos(UID_MOTO, 'D1', ['g1']).commit())
  const antes = JSON.stringify(await leerDepositoFin2('D1'))
  await assertSucceeds(batchCrearDepositoConGastos(UID_MOTO, 'D2', ['g2', 'g3']).commit())
  assert.equal(JSON.stringify(await leerDepositoFin2('D1')), antes)
  assert.deepEqual((await leerDepositoFin2('D2'))?.gastosIds, ['g2', 'g3'])
})

test('FG-R12 · gastos_motorizado: crear, anular y editar un gasto ya NO son del cliente (FIN-1C-B) ⇒ DENY; consumir/liberar la marca (FIN-2) sigue ⇒ ALLOW (FG-R13); no se marca a mano', async () => {
  await sembrarGastosFin2()
  const g = como(UID_GESTOR)
  await assertFails(setDoc(doc(g, 'gastos_motorizado', 'gNuevo'), { motorizadoId: 'mot1', estado: 'aprobado', monto: 5, tipo: 'peaje_terminal' }))
  await assertFails(updateDoc(doc(g, 'gastos_motorizado', 'g1'), { estado: 'anulado', updatedAt: serverTimestamp() }))
  await assertFails(setDoc(doc(g, 'gastos_motorizado', 'gPreconsumido'), { motorizadoId: 'mot1', estado: 'aprobado', monto: 5, consumidoEnDepositoId: 'DX' }))
  await assertFails(updateDoc(doc(g, 'gastos_motorizado', 'g2'), { consumidoEnDepositoId: 'DX' }))
  await assertFails(deleteDoc(doc(g, 'gastos_motorizado', 'g2')))
})

test('FG-R13 · un depósito con muchos gastos cabe en un solo batch (12 gastos) ⇒ ALLOW: la guardia no revienta el límite de accesos de las reglas', async () => {
  const muchos: Record<string, Record<string, unknown>> = {}
  const ids: string[] = []
  for (let i = 0; i < 12; i++) { ids.push(`gm${i}`); muchos[`gm${i}`] = { motorizadoId: 'mot1', estado: 'aprobado', monto: 10 } }
  await sembrarGastosFin2(muchos)
  await assertSucceeds(batchCrearDepositoConGastos(UID_MOTO, 'DMuchos', ids).commit())
  for (const id of ids) assert.equal((await leerGastoFin2(id))?.consumidoEnDepositoId, 'DMuchos')
})

// ─── F5 · FIN-5 · rehacer y anular: el ledger cambia en el MISMO commit ──────
//
// REHACER-ANULA-ANTES-DEL-BATCH. Antes, el ledger se anulaba con un commit
// propio y recién después se armaba el batch del depósito. Estos casos arman el
// batch igual que los writers reales (movimientos leídos + anulación dentro del
// batch principal) y fuerzan que el batch principal sea DENEGADO por una
// condición legítima de las Rules: rehacer y anular son solo de admin.
//
// Lo que NO cierra FIN-5 (queda para FIN-1/FIN-3): el ledger sigue siendo
// escribible por gestor/admin, y el estado del depósito se lee en el cliente.

const MOV_BASE = { depositoId: 'depD', tipo: 'deposito_efectivo_storkhub', monto: 40 }

async function sembrarFin5(movs: Record<string, Record<string, unknown>>, opts: { gastos?: string[]; estado?: string } = {}) {
  await sembrarDigitacion({
    depEstado: opts.estado ?? 'confirmado',
    registro: { deposito: { storkhubDepositoId: 'depD', confirmadoStorkhub: true, confirmadoStorkhubAt: new Date() } },
  })
  await env.withSecurityRulesDisabled(async (ctx) => {
    const db = ctx.firestore()
    for (const [id, m] of Object.entries(movs)) await setDoc(doc(db, 'movimientos_financieros', id), { ...MOV_BASE, ...m })
    if (opts.gastos?.length) {
      await setDoc(doc(db, 'motorizado', 'mot1'), { authUid: UID_MOTO, nombre: 'M1' })
      await setDoc(doc(db, 'ordenes_deposito', 'depD'), { gastosIds: opts.gastos }, { merge: true })
      for (const g of opts.gastos) {
        await setDoc(doc(db, 'gastos_motorizado', g), { motorizadoId: 'mot1', estado: 'aprobado', monto: 10, tipo: 'peaje_terminal', consumidoEnDepositoId: 'depD' })
      }
    }
  })
}

async function leerDoc(coleccion: string, id: string): Promise<Record<string, unknown> | undefined> {
  let data: Record<string, unknown> | undefined
  await env.withSecurityRulesDisabled(async (ctx) => { data = (await getDoc(doc(ctx.firestore(), coleccion, id))).data() })
  return data
}

/** El puntero de la orden al depósito, tipado: lo que Rehacer reabre y Anular libera. */
async function punteroDeOrdenD(): Promise<{ confirmadoStorkhub?: boolean; storkhubDepositoId?: string | null }> {
  const o = await leerDoc('solicitudes_envio', ORDEN_D)
  const registro = o?.registro as { deposito?: { confirmadoStorkhub?: boolean; storkhubDepositoId?: string | null } } | undefined
  return registro?.deposito ?? {}
}

async function eventosDeD(): Promise<number> {
  let n = 0
  await env.withSecurityRulesDisabled(async (ctx) => { n = (await getDocs(collection(ctx.firestore(), 'ordenes_deposito', 'depD', 'eventos'))).size })
  return n
}

/** Lo que hace el writer real: lee los movimientos del depósito y los entrega para el batch. */
async function leerMovsDeD(db: ReturnType<typeof como>) {
  const snap = await getDocs(query(collection(db, 'movimientos_financieros'), where('depositoId', '==', 'depD')))
  return snap.docs.map((d) => ({ ref: d.ref, estado: (d.data() as { estado?: unknown }).estado }))
}

async function batchRehacerFin5(uid: string, opts: { sinEvento?: boolean } = {}) {
  const db = como(uid)
  const rol = uid === UID_ADMIN ? 'admin' : 'gestor'
  const movs = await leerMovsDeD(db)
  const b = writeBatch(db)
  b.set(doc(db, 'ordenes_deposito', 'depD'), camposRehacerDeposito(uid, serverTimestamp(), 'motivo suficiente', 'evF5'), { merge: true })
  if (!opts.sinEvento) b.set(doc(db, 'ordenes_deposito', 'depD', 'eventos', 'evF5'), camposEventoDepositoRehecho({ uid, rol }, serverTimestamp(), 'motivo suficiente'))
  b.update(doc(db, 'solicitudes_envio', ORDEN_D), camposReaperturaRevision('storkhub', 'depD'))
  agregarAnulacionDeMovimientosAlBatch(b, movs, uid, 'Depósito revertido a revisión por gestor', serverTimestamp())
  return b
}

async function batchAnularFin5(uid: string, opts: { gastos?: string[]; sinEvento?: boolean } = {}) {
  const db = como(uid)
  const rol = uid === UID_ADMIN ? 'admin' : 'gestor'
  const movs = await leerMovsDeD(db)
  const b = writeBatch(db)
  b.set(doc(db, 'ordenes_deposito', 'depD'), camposAnularDeposito(uid, serverTimestamp(), 'motivo suficiente', 'evF5'), { merge: true })
  if (!opts.sinEvento) b.set(doc(db, 'ordenes_deposito', 'depD', 'eventos', 'evF5'), camposEventoDepositoAnulado({ uid, rol }, serverTimestamp(), 'motivo suficiente'))
  b.update(doc(db, 'solicitudes_envio', ORDEN_D), camposLiberacionDeposito('storkhub'))
  liberarGastosDeDeposito(b, (id) => doc(db, 'gastos_motorizado', id), (opts.gastos ?? []).map((id) => ({ id, consumidoEnDepositoId: 'depD' })), 'depD', deleteField())
  agregarAnulacionDeMovimientosAlBatch(b, movs, uid, 'Depósito anulado por administrador', serverTimestamp())
  return b
}

test('F5-FR1 · REHACER desde el cliente ⇒ DENY (FIN-1B: rehacerDeposito); depósito, orden y ledger quedan intactos', async () => {
  await sembrarFin5({ M1: { estado: 'activo' } })
  const antes = await leerDoc('ordenes_deposito', 'depD')
  await assertFails((await batchRehacerFin5(UID_ADMIN)).commit())
  assert.deepEqual(await leerDoc('ordenes_deposito', 'depD'), antes)
  assert.equal(await eventosDeD(), 0)
  assert.equal((await leerDoc('movimientos_financieros', 'M1'))?.estado, 'activo')
})

test('F5-FR2 · REHACER denegado (gestor no puede): NINGÚN movimiento queda anulado, ni evento, ni orden ⇒ DENY', async () => {
  await sembrarFin5({ M1: { estado: 'activo' }, M2: { estado: 'activo' } })
  await assertFails((await batchRehacerFin5(UID_GESTOR)).commit())
  assert.equal((await leerDoc('ordenes_deposito', 'depD'))?.estado, 'confirmado')
  assert.equal((await leerDoc('movimientos_financieros', 'M1'))?.estado, 'activo')
  assert.equal((await leerDoc('movimientos_financieros', 'M2'))?.estado, 'activo')
  assert.equal(await eventosDeD(), 0)
  assert.equal((await punteroDeOrdenD()).confirmadoStorkhub, true)
})

test('F5-FA1 · ANULAR desde el cliente ⇒ DENY (FIN-1B: anularDeposito); depósito, orden y ledger quedan intactos', async () => {
  await sembrarFin5({ M1: { estado: 'activo' } })
  const antes = await leerDoc('ordenes_deposito', 'depD')
  await assertFails((await batchAnularFin5(UID_ADMIN)).commit())
  assert.deepEqual(await leerDoc('ordenes_deposito', 'depD'), antes)
  assert.equal(await eventosDeD(), 0)
  assert.equal((await leerDoc('movimientos_financieros', 'M1'))?.estado, 'activo')
})

test('F5-FA2 · ANULAR denegado (gestor no puede): el ledger sigue activo, el depósito en su estado, la orden sin liberar ⇒ DENY', async () => {
  await sembrarFin5({ M1: { estado: 'activo' } })
  await assertFails((await batchAnularFin5(UID_GESTOR)).commit())
  assert.equal((await leerDoc('ordenes_deposito', 'depD'))?.estado, 'confirmado')
  assert.equal((await leerDoc('movimientos_financieros', 'M1'))?.estado, 'activo')
  assert.equal(await eventosDeD(), 0)
  assert.equal((await punteroDeOrdenD()).storkhubDepositoId, 'depD')
})

test('F5-FA2b · sin su evento de auditoría el batch entero cae: el ledger NO queda anulado (evento y ledger van juntos) ⇒ DENY', async () => {
  await sembrarFin5({ M1: { estado: 'activo' } })
  await assertFails((await batchAnularFin5(UID_ADMIN, { sinEvento: true })).commit())
  await assertFails((await batchRehacerFin5(UID_ADMIN, { sinEvento: true })).commit())
  assert.equal((await leerDoc('movimientos_financieros', 'M1'))?.estado, 'activo')
  assert.equal((await leerDoc('ordenes_deposito', 'depD'))?.estado, 'confirmado')
})

test('F5-FA3 · VARIOS movimientos: rehacer y anular desde el cliente ⇒ DENY y ningún movimiento cambia', async () => {
  const previo = { estado: 'anulado', anuladoPorUid: 'uidOriginal', motivoAnulacion: 'motivo original' }
  for (const accion of ['rehacer', 'anular'] as const) {
    await env.clearFirestore()
    await env.withSecurityRulesDisabled(async (ctx) => {
      const db = ctx.firestore()
      await setDoc(doc(db, 'usuarios', UID_GESTOR), { activo: true, rol: 'gestor' })
      await setDoc(doc(db, 'usuarios', UID_ADMIN), { activo: true, rol: 'admin' })
    })
    await sembrarFin5({ M1: { estado: 'activo' }, M2: { estado: 'activo' }, M3: previo })
    await assertFails((await (accion === 'rehacer' ? batchRehacerFin5(UID_ADMIN) : batchAnularFin5(UID_ADMIN))).commit())
    assert.equal((await leerDoc('movimientos_financieros', 'M1'))?.estado, 'activo', accion)
    assert.equal((await leerDoc('movimientos_financieros', 'M2'))?.estado, 'activo', accion)
    assert.equal((await leerDoc('movimientos_financieros', 'M3'))?.anuladoPorUid, 'uidOriginal', accion)
  }
})

test('F5-FA4 · SIN movimientos: rehacer y anular desde el cliente también ⇒ DENY', async () => {
  await sembrarFin5({})
  await assertFails((await batchRehacerFin5(UID_ADMIN)).commit())
  await env.clearFirestore()
  await env.withSecurityRulesDisabled(async (ctx) => {
    const db = ctx.firestore()
    await setDoc(doc(db, 'usuarios', UID_ADMIN), { activo: true, rol: 'admin' })
  })
  await sembrarFin5({})
  await assertFails((await batchAnularFin5(UID_ADMIN)).commit())
})

test('F5-FIN2 · REGRESIÓN FIN-2: anular desde el cliente (gestor o admin) ⇒ DENY: ni órdenes, ni gastos, ni ledger cambian (FIN-1B: lo hace anularDeposito)', async () => {
  await sembrarFin5({ M1: { estado: 'activo' } }, { gastos: ['g1', 'g2'] })
  await assertFails((await batchAnularFin5(UID_GESTOR, { gastos: ['g1', 'g2'] })).commit())
  await assertFails((await batchAnularFin5(UID_ADMIN, { gastos: ['g1', 'g2'] })).commit())
  assert.equal((await leerDoc('gastos_motorizado', 'g1'))?.consumidoEnDepositoId, 'depD')
  assert.equal((await leerDoc('gastos_motorizado', 'g2'))?.consumidoEnDepositoId, 'depD')
  assert.equal((await leerDoc('movimientos_financieros', 'M1'))?.estado, 'activo')
  assert.notEqual((await punteroDeOrdenD()).storkhubDepositoId, null)
})

test('F5-IDEM · anular dos veces desde el cliente ⇒ DENY las dos; no se crea ningún evento ni se reescribe el ledger', async () => {
  await sembrarFin5({ M1: { estado: 'activo' } })
  await assertFails((await batchAnularFin5(UID_ADMIN)).commit())
  const antes = await leerDoc('movimientos_financieros', 'M1')
  await assertFails((await batchAnularFin5(UID_ADMIN)).commit())
  assert.deepEqual(await leerDoc('movimientos_financieros', 'M1'), antes)
  assert.equal(await eventosDeD(), 0, 'no se creó ningún evento')
})

test('F5-REPRO · el bug anterior YA NO se puede reproducir (FIN-1E): el commit de ledger SEPARADO se deniega, así que nunca queda confirmado + ledger anulado', async () => {
  await sembrarFin5({ M1: { estado: 'activo' } })
  // El patrón viejo: el ledger se anulaba y se commiteaba solo... FIN-1E: ese commit es DENY.
  const db = como(UID_GESTOR)
  const viejo = writeBatch(db)
  agregarAnulacionDeMovimientosAlBatch(viejo, await leerMovsDeD(db), UID_GESTOR, 'Depósito revertido a revisión por gestor', serverTimestamp())
  await assertFails(viejo.commit())
  // ...y después el batch principal es denegado.
  const principal = writeBatch(db)
  principal.set(doc(db, 'ordenes_deposito', 'depD'), camposRehacerDeposito(UID_GESTOR, serverTimestamp(), 'motivo suficiente', 'evF5'), { merge: true })
  principal.set(doc(db, 'ordenes_deposito', 'depD', 'eventos', 'evF5'), camposEventoDepositoRehecho({ uid: UID_GESTOR, rol: 'gestor' }, serverTimestamp(), 'motivo suficiente'))
  await assertFails(principal.commit())
  assert.equal((await leerDoc('ordenes_deposito', 'depD'))?.estado, 'confirmado')
  assert.equal((await leerDoc('movimientos_financieros', 'M1'))?.estado, 'activo', 'el ledger no cambió: el estado inconsistente ya no es alcanzable desde el cliente')
})

// ─── F3 · FIN-3 · el gestor MATERIALIZA el depósito; la confirmación es de la callable ──
//
// confirmarStorkhub/confirmarComercio ya no confirman: dejan el depósito en
// 'en_revision' con su boucher y el puntero en sus órdenes (mismo batch) y llaman a
// confirmarDeposito. Si FIN-1 cierra las Rules del depósito, ESTE camino tiene que
// seguir permitido: estos casos lo fijan. No son un cierre de autoridad.

async function sembrarMaterializacion(destino: 'storkhub' | 'comercio') {
  await sembrarDigitacion({ destinatario: destino, solicitudIds: [ORDEN_D, 'ordD2'] })
  await env.withSecurityRulesDisabled(async (ctx) => {
    await setDoc(doc(ctx.firestore(), 'solicitudes_envio', 'ordD2'), { ...ordenBase({ estado: 'entregado' }), codigo: 'SH-0002', secuencia: 2 })
  })
}

function batchMaterializar(uid: string, destino: 'storkhub' | 'comercio') {
  const db = como(uid)
  const b = writeBatch(db)
  b.update(doc(db, 'ordenes_deposito', 'depD'), { boucher: { url: 'https://example.test/b.jpg', pathStorage: 'x', uploadedAt: serverTimestamp(), motorizadoUid: UID_MOTO }, estado: 'en_revision' })
  for (const id of [ORDEN_D, 'ordD2']) b.update(doc(db, 'solicitudes_envio', id), camposEnlaceDigitacion(destino, 'depD'))
  return b
}

test('F3-R1 · gestor: depósito StorkHub pendiente_boucher → en_revision con boucher y puntero en sus órdenes, en UN batch ⇒ ALLOW', async () => {
  await sembrarMaterializacion('storkhub')
  await assertSucceeds(batchMaterializar(UID_GESTOR, 'storkhub').commit())
  assert.equal((await leerDoc('ordenes_deposito', 'depD'))?.estado, 'en_revision', 'queda en revisión, NO confirmado')
  assert.equal((await punteroDeOrdenD()).storkhubDepositoId, 'depD')
  assert.equal((await punteroDeOrdenD()).confirmadoStorkhub, undefined, 'las órdenes NO quedan confirmadas: eso lo hace la callable')
})

test('F3-R2 · gestor: depósito de comercio pendiente_boucher → en_revision con boucher y puntero ⇒ ALLOW', async () => {
  await sembrarMaterializacion('comercio')
  await assertSucceeds(batchMaterializar(UID_GESTOR, 'comercio').commit())
  assert.equal((await leerDoc('ordenes_deposito', 'depD'))?.estado, 'en_revision')
})

// ─── FIN-1-0 — el ledger no se borra desde ningún cliente ─────────────────────
// `allow read, write` incluye DELETE y Firestore OR-combina los allows: el `allow delete: if false` que
// había debajo no lo anulaba, así que gestor y admin (cliente modificado) borraban movimientos
// (bypass L9 del diagnóstico FIN-1). Ahora read, create, update y delete se declaran por separado.
// Estos tests fijan SOLO el delete cerrado y que create/update/read siguen como antes: cerrar su
// contenido es FIN-1E, cuando los writers que aún los usan estén migrados a servidor.

const MOV_ID = 'mov_f10'
const movBase = (extra: Record<string, unknown> = {}) => ({
  tipo: 'ajuste_manual', monto: 10, estado: 'activo', saldoId: 'S1', ...extra,
})
async function sembrarMovimiento(id = MOV_ID) {
  await env.withSecurityRulesDisabled(async (ctx) => {
    await setDoc(doc(ctx.firestore(), 'movimientos_financieros', id), movBase())
  })
}
async function existeMovimiento(id = MOV_ID): Promise<boolean> {
  let existe = false
  await env.withSecurityRulesDisabled(async (ctx) => {
    existe = (await getDoc(doc(ctx.firestore(), 'movimientos_financieros', id))).exists()
  })
  return existe
}

test('F1-0-R1 · el GESTOR no borra un movimiento del ledger ⇒ DENY, y el movimiento sigue ahí', async () => {
  await sembrarMovimiento()
  await assertFails(deleteDoc(doc(como(UID_GESTOR), 'movimientos_financieros', MOV_ID)))
  assert.equal(await existeMovimiento(), true)
})

test('F1-0-R2 · el ADMIN tampoco ⇒ DENY', async () => {
  await sembrarMovimiento()
  await assertFails(deleteDoc(doc(como(UID_ADMIN), 'movimientos_financieros', MOV_ID)))
  assert.equal(await existeMovimiento(), true)
})

test('F1-0-R3 · el DIGITADOR no borra ⇒ DENY', async () => {
  await sembrarMovimiento()
  await assertFails(deleteDoc(doc(como(UID_DIGITADOR), 'movimientos_financieros', MOV_ID)))
  assert.equal(await existeMovimiento(), true)
})

test('F1-0-R4 · el MOTORIZADO, el comercio y el cliente no borran ⇒ DENY', async () => {
  await sembrarMovimiento()
  for (const uid of [UID_MOTO, UID_COMERCIO, UID_CLIENTE]) {
    await assertFails(deleteDoc(doc(como(uid), 'movimientos_financieros', MOV_ID)))
  }
  assert.equal(await existeMovimiento(), true)
})

test('F1-0-R5 / R7 · CREATE ya NO lo permite el cliente (FIN-1E: el ledger es solo del servidor) ⇒ DENY a gestor y admin', async () => {
  await assertFails(addDoc(collection(como(UID_GESTOR), 'movimientos_financieros'), movBase({ creadoPorRol: 'gestor' })))
  await assertFails(addDoc(collection(como(UID_ADMIN), 'movimientos_financieros'), movBase({ creadoPorRol: 'admin' })))
})

test('F1-0-R6 / R8 · UPDATE ya NO lo permite el cliente (FIN-1E) ⇒ DENY a gestor y admin; el movimiento queda intacto', async () => {
  await sembrarMovimiento()
  await assertFails(updateDoc(doc(como(UID_GESTOR), 'movimientos_financieros', MOV_ID), { estado: 'anulado', anuladoPorUid: UID_GESTOR }))
  await sembrarMovimiento('mov_f10_b')
  await assertFails(updateDoc(doc(como(UID_ADMIN), 'movimientos_financieros', 'mov_f10_b'), { estado: 'anulado', anuladoPorUid: UID_ADMIN }))
  assert.equal((await leerDoc('movimientos_financieros', MOV_ID))?.estado, 'activo')
})

test('F1-0-R9 / R10 · DELETE dentro de un writeBatch tampoco pasa (gestor y admin) ⇒ DENY, nada se borra', async () => {
  await sembrarMovimiento('b1'); await sembrarMovimiento('b2')
  for (const [uid, id] of [[UID_GESTOR, 'b1'], [UID_ADMIN, 'b2']] as const) {
    const db = como(uid)
    const b = writeBatch(db)
    b.delete(doc(db, 'movimientos_financieros', id))
    await assertFails(b.commit())
  }
  assert.equal(await existeMovimiento('b1'), true)
  assert.equal(await existeMovimiento('b2'), true)
})

test('F1-0-R11 · un batch MIXTO (update permitido + delete) falla entero: el delete no pasa escondido y el update tampoco se aplica', async () => {
  await sembrarMovimiento('m_upd'); await sembrarMovimiento('m_del')
  const db = como(UID_GESTOR)
  const b = writeBatch(db)
  b.update(doc(db, 'movimientos_financieros', 'm_upd'), { descripcion: 'cambio' })
  b.delete(doc(db, 'movimientos_financieros', 'm_del'))
  await assertFails(b.commit())
  assert.equal(await existeMovimiento('m_del'), true)
  let descripcion: unknown
  await env.withSecurityRulesDisabled(async (ctx) => { descripcion = (await getDoc(doc(ctx.firestore(), 'movimientos_financieros', 'm_upd'))).data()?.descripcion })
  assert.equal(descripcion, undefined, 'atomicidad de Rules: el update del mismo batch no se aplicó')
})

test('F1-0-R12 · READ sigue igual: gestor y admin leen (get y list); digitador, motorizado y comercio no ⇒ ALLOW / DENY', async () => {
  await sembrarMovimiento()
  for (const uid of [UID_GESTOR, UID_ADMIN]) {
    await assertSucceeds(getDoc(doc(como(uid), 'movimientos_financieros', MOV_ID)))
    await assertSucceeds(getDocs(query(collection(como(uid), 'movimientos_financieros'), limit(3))))
  }
  for (const uid of [UID_DIGITADOR, UID_MOTO, UID_COMERCIO]) await assertFails(getDoc(doc(como(uid), 'movimientos_financieros', MOV_ID)))
})

test('F1-0-R13 · ningún otro match reabre el delete: un solo match para movimientos_financieros, sin wildcard recursivo, y su delete es literalmente false', () => {
  const reglas = readFileSync('firestore.rules', 'utf8').replace(/\r\n/g, '\n')
  assert.equal((reglas.match(/match \/movimientos_financieros\/\{[a-zA-Z]+\}/g) ?? []).length, 1, 'un solo match sobre el path')
  assert.ok(!/\{[a-zA-Z_]*=\*\*\}/.test(reglas), 'sin wildcard recursivo que pueda conceder delete por otro camino')
  const i = reglas.indexOf('match /movimientos_financieros/{id}')
  const bloque = reglas.slice(i, reglas.indexOf('\n    }\n', i))
  assert.ok(/allow create, update, delete: if false;/.test(bloque), 'create, update y delete: if false (FIN-1E)')
  assert.ok(!/allow [^:\n]*\bwrite\b[^:\n]*:/.test(bloque), 'ningún "allow ... write" (write incluye delete)')
  assert.ok(!/allow [^:\n]*\b(delete|create|update)\b[^:\n]*: if (?!false)/.test(bloque), 'ningún otro allow de escritura')
})

// ═════════════════════════════════════════════════════════════════════════════
// FIN-1B — los bypasses de ordenes_deposito que quedaron cerrados (antes ALLOW, ahora DENY)
//
// Antes de FIN-1B el update de gestor/admin era "cualquier campo, y el estado auditado con un evento": un cliente modificado podía
// confirmar sin callable (D1/D2), cambiar montoTotal (D3), crear un depósito ya confirmado o convertido con un saldoId inventado
// (D4/D5), editar los campos de conversión (D8), rehacer/anular un confirmado dejando su ledger vivo (D9) y pasar a 'en_revision'
// sin comprobante (E1). El evento obligatorio no equivalía a integridad: Rules no puede demostrar el ledger, las órdenes ni los gastos.
// Estas pruebas son permanentes: si alguien reabre la rama amplia, caen.
// ═════════════════════════════════════════════════════════════════════════════

const flagsOrdenV = { 'registro.deposito.confirmadoStorkhub': true, 'registro.deposito.confirmadoStorkhubAt': serverTimestamp(), 'registro.deposito.storkhubDepositoId': DEP_V }

test('FIN1B-D1 · gestor confirma un A en revisión SIN callable (batch depósito + evento DEPOSITO_CONFIRMADO) ⇒ DENY', async () => {
  await depositoAB('en_revision')
  await assertFails(confirmarCon())
  assert.equal((await leerDep()).estado, 'en_revision')
})

test('FIN1B-D2 · gestor fabrica el RESULTADO completo de la confirmación (depósito + evento + movimiento deposito_efectivo_storkhub + flags de la orden) ⇒ DENY', async () => {
  await depositoAB('en_revision')
  const db = como(UID_GESTOR)
  const b = writeBatch(db)
  b.set(doc(db, 'ordenes_deposito', DEP_V), camposConfirmarDeposito(UID_GESTOR, serverTimestamp(), 'evFab1'), { merge: true })
  b.set(doc(db, 'ordenes_deposito', DEP_V, 'eventos', 'evFab1'), camposEventoDepositoConfirmado({ uid: UID_GESTOR, rol: 'gestor' }, serverTimestamp()))
  b.set(doc(db, 'movimientos_financieros', 'movFab1'), { tipo: 'deposito_efectivo_storkhub', monto: 110, estado: 'activo', depositoId: DEP_V, motorizadoId: 'mot1', cuentaOrigen: 'efectivo_en_poder:mot1', cuentaDestino: 'banco_storkhub', propietario: 'storkhub', creadoPorUid: UID_GESTOR, creadoPorRol: 'gestor', at: serverTimestamp(), descripcion: 'x' })
  b.update(doc(db, 'solicitudes_envio', ORDEN_V), flagsOrdenV)
  await assertFails(b.commit())
  assert.equal((await leerDep()).estado, 'en_revision')
})

test('FIN1B-D3 · gestor/admin cambian montoTotal o montoBruto de un depósito (en revisión o pendiente_boucher) ⇒ DENY', async () => {
  for (const estado of ['pendiente_boucher', 'en_revision']) {
    await depositoAB(estado)
    await assertFails(updateDoc(doc(como(UID_GESTOR), 'ordenes_deposito', DEP_V), { montoTotal: 1 }))
    await assertFails(updateDoc(doc(como(UID_ADMIN), 'ordenes_deposito', DEP_V), { montoBruto: 9999, gastosDescontados: 0, gastosIds: [] }))
    await assertFails(updateDoc(doc(como(UID_GESTOR), 'ordenes_deposito', DEP_V), { solicitudIds: [ORDEN_V, 'otra'] }))
  }
})

test('FIN1B-D4/D5 · gestor/admin CREAN un depósito A/B ya confirmado, convertido, anulado, en revisión o con boucher ⇒ DENY; solo pendiente_boucher de captura ⇒ ALLOW', async () => {
  const intentos: Array<Record<string, unknown>> = [
    { estado: 'convertido_en_deuda', saldoId: 'inventado', montoTotal: 9999 },
    { estado: 'confirmado' },
    { estado: 'confirmado', confirmadoPorUid: UID_GESTOR, confirmadoAt: serverTimestamp() },
    { estado: 'anulado' },
    { estado: 'en_revision', boucher: { url: 'https://example.test/b.jpg', pathStorage: 'x' } },
    { estado: 'pendiente_boucher', saldoId: 'inventado' },
    { estado: 'pendiente_boucher', confirmadoPorUid: UID_GESTOR },
    { estado: 'pendiente_boucher', condonado: true },
  ]
  let i = 0
  for (const quien of [UID_GESTOR, UID_ADMIN]) {
    for (const extra of intentos) {
      await assertFails(setDoc(doc(como(quien), 'ordenes_deposito', `dxFin1b${++i}`), depositoBase(extra)))
    }
    await assertFails(setDoc(doc(como(quien), 'ordenes_deposito', `dxFin1b${++i}`), depositoBase({ tipo: 'recaudacion_motorizado_comercio', destinatario: 'comercio', estado: 'confirmado' })))
    await assertSucceeds(setDoc(doc(como(quien), 'ordenes_deposito', `dxOk${++i}`), depositoBase({ montoBruto: 110, gastosDescontados: 0, gastosIds: [], cuentasDestino: [] })))
  }
})

test('FIN1B-D8 · gestor/admin editan saldoId / notaConversion / convertidoPorUid / convertidoAt de un convertido SIN cambiar el estado ⇒ DENY', async () => {
  await depositoAB('convertido_en_deuda', { saldoId: 'saldo1', notaConversion: 'orig', convertidoPorUid: UID_GESTOR })
  for (const quien of [UID_GESTOR, UID_ADMIN]) {
    await assertFails(updateDoc(doc(como(quien), 'ordenes_deposito', DEP_V), { saldoId: 'OTRO', notaConversion: 'x' }))
    await assertFails(updateDoc(doc(como(quien), 'ordenes_deposito', DEP_V), { convertidoPorUid: 'otro', convertidoAt: serverTimestamp() }))
    await assertFails(updateDoc(doc(como(quien), 'ordenes_deposito', DEP_V), { condonado: true, notaCondonacion: 'x' }))
  }
  const dep = await leerDep()
  assert.equal(dep.saldoId, 'saldo1'); assert.equal(dep.notaConversion, 'orig')
})

test('FIN1B-D9 · admin Rehacer/Anular de un confirmado, con el evento y SIN anular su ledger (el batch no lo exige) ⇒ DENY', async () => {
  await depositoAB('confirmado')
  await assertFails(rehacerCon({ uid: UID_ADMIN }))
  await assertFails(anular({ uid: UID_ADMIN }))
  assert.equal((await leerDep()).estado, 'confirmado')
})

test('FIN1B-E1/E1b · pendiente_boucher → en_revision SIN comprobante real ⇒ DENY (gestor, admin, motorizado, digitador y el Rehacer del admin); con comprobante ⇒ ALLOW', async () => {
  const invalidos: Array<Record<string, string | object>> = [
    { estado: 'en_revision', updatedAt: serverTimestamp() },
    { estado: 'en_revision', boucher: {}, updatedAt: serverTimestamp() },
    { estado: 'en_revision', boucher: { url: '', pathStorage: 'x' }, updatedAt: serverTimestamp() },
    { estado: 'en_revision', boucher: { url: 'https://example.test/b.jpg' }, updatedAt: serverTimestamp() },
    { estado: 'en_revision', boucher: 'texto', updatedAt: serverTimestamp() },
  ]
  for (const quien of [UID_GESTOR, UID_ADMIN]) {
    for (const cambios of invalidos) {
      await depositoAB('pendiente_boucher', { boucher: null })
      await assertFails(updateDoc(doc(como(quien), 'ordenes_deposito', DEP_V), cambios))
    }
  }
  await depositoAB('pendiente_boucher', { boucher: null })
  for (const cambios of invalidos) await assertFails(updateDoc(doc(como(UID_MOTO), 'ordenes_deposito', DEP_V), cambios))
  await depositoAB('pendiente_boucher', { boucher: null, digitadoPorUid: UID_DIGITADOR, digitadoAt: new Date() })
  for (const cambios of invalidos) await assertFails(updateDoc(doc(como(UID_DIGITADOR), 'ordenes_deposito', DEP_V), cambios))
  // E1b: el Rehacer del admin sobre un pendiente_boucher (la UI lo ofrecía) tampoco es una vía.
  await depositoAB('pendiente_boucher', { boucher: null })
  await assertFails(rehacerCon({ uid: UID_ADMIN }))
  // Con comprobante real: ALLOW para los cuatro.
  const ok = { estado: 'en_revision', boucher: { url: 'https://example.test/b.jpg', pathStorage: 'x' }, updatedAt: serverTimestamp() }
  await depositoAB('pendiente_boucher', { boucher: null })
  await assertSucceeds(updateDoc(doc(como(UID_GESTOR), 'ordenes_deposito', DEP_V), ok))
  await depositoAB('pendiente_boucher', { boucher: null })
  await assertSucceeds(updateDoc(doc(como(UID_MOTO), 'ordenes_deposito', DEP_V), ok))
})

test('FIN1B-E3 · admin ANULA un confirmado (batch depósito + evento) sin anular su movimiento deposito_efectivo_storkhub ⇒ DENY', async () => {
  await depositoAB('confirmado')
  await env.withSecurityRulesDisabled(async (ctx) => {
    await setDoc(doc(ctx.firestore(), 'movimientos_financieros', 'movE3'), { tipo: 'deposito_efectivo_storkhub', monto: 110, estado: 'activo', depositoId: DEP_V })
  })
  await assertFails(anular({ uid: UID_ADMIN }))
  let mov: Record<string, unknown> = {}
  await env.withSecurityRulesDisabled(async (ctx) => { mov = ((await getDoc(doc(ctx.firestore(), 'movimientos_financieros', 'movE3'))).data() ?? {}) as Record<string, unknown> })
  assert.equal(mov.estado, 'activo')
  assert.equal((await leerDep()).estado, 'confirmado')
})

test('FIN1B-E4 · gestor/admin editan confirmadoPorUid / confirmadoAt de un confirmado sin cambiar el estado (falsifican al confirmante) ⇒ DENY', async () => {
  await depositoAB('confirmado', { confirmadoPorUid: UID_GESTOR })
  for (const quien of [UID_GESTOR, UID_ADMIN]) {
    await assertFails(updateDoc(doc(como(quien), 'ordenes_deposito', DEP_V), { confirmadoPorUid: 'otro_uid', confirmadoAt: serverTimestamp() }))
  }
  assert.equal((await leerDep()).confirmadoPorUid, UID_GESTOR)
})

test('FIN1B-E6 · gestor/admin pasan en_revision → convertido_en_deuda con saldoId inventado por UPDATE ⇒ DENY', async () => {
  for (const quien of [UID_GESTOR, UID_ADMIN]) {
    await depositoAB('en_revision')
    await assertFails(updateDoc(doc(como(quien), 'ordenes_deposito', DEP_V), {
      estado: 'convertido_en_deuda', saldoId: 'inventado', notaConversion: 'x', convertidoPorUid: quien, convertidoAt: serverTimestamp(),
    }))
    assert.equal((await leerDep()).estado, 'en_revision')
  }
})

test('FIN1B-E8 · reabrir un depósito ANULADO a confirmado, en_revision o pendiente_boucher desde el cliente ⇒ DENY (gestor y admin)', async () => {
  for (const quien of [UID_GESTOR, UID_ADMIN]) {
    for (const destino of ['confirmado', 'en_revision', 'pendiente_boucher']) {
      await depositoAB('anulado', { anuladoPorUid: UID_ADMIN })
      await assertFails(updateDoc(doc(como(quien), 'ordenes_deposito', DEP_V), { estado: destino, updatedAt: serverTimestamp() }))
    }
    await depositoAB('anulado', { anuladoPorUid: UID_ADMIN })
    await assertFails(confirmarCon({ uid: quien }))
    assert.equal((await leerDep()).estado, 'anulado')
  }
})

test('FIN1B-E9 · admin Rehacer de un confirmado SIN tocar órdenes, gastos ni ledger (solo depósito + evento) ⇒ DENY', async () => {
  await depositoAB('confirmado')
  await assertFails(rehacerCon({ uid: UID_ADMIN }))
  assert.equal((await leerDep()).estado, 'confirmado')
})

// ─── Los flujos legítimos del cliente siguen abiertos, cada uno con su lista cerrada ─────────────────────────────────────────

test('FIN1B-L1 · rechazar una digitación: solo con digitadoPorUid, desde pendiente_boucher o en_revision, con {estado, rechazadoPor, rechazadoAt, motivoRechazo} ⇒ ALLOW; con otros campos, otro estado o sin digitación ⇒ DENY', async () => {
  const rechazo = (extra: Record<string, unknown> = {}): Record<string, unknown> => ({ estado: 'rechazado', rechazadoPor: UID_GESTOR, rechazadoAt: serverTimestamp(), motivoRechazo: 'Monto ilegible', ...extra })
  await depositoDigitado('en_revision')
  await assertSucceeds(setDoc(doc(como(UID_GESTOR), 'ordenes_deposito', DEP_V), rechazo(), { merge: true }))
  await depositoDigitado('pendiente_boucher')
  await assertSucceeds(setDoc(doc(como(UID_GESTOR), 'ordenes_deposito', DEP_V), rechazo(), { merge: true }))
  // Sin digitación (lo subió el motorizado): no es un rechazo de digitación.
  await depositoAB('en_revision')
  await assertFails(setDoc(doc(como(UID_GESTOR), 'ordenes_deposito', DEP_V), rechazo(), { merge: true }))
  // El rechazo no es un bypass: ni monto, ni confirmación, ni conversión, ni actor ajeno, ni hora inventada.
  for (const extra of [{ montoTotal: 1 }, { saldoId: 'x' }, { confirmadoPorUid: UID_GESTOR }, { condonado: true }, { rechazadoPor: 'otro' }, { rechazadoAt: new Date() }, { motivoRechazo: '' }, { updatedAt: serverTimestamp() }]) {
    await depositoDigitado('en_revision')
    await assertFails(setDoc(doc(como(UID_GESTOR), 'ordenes_deposito', DEP_V), rechazo(extra), { merge: true }))
  }
  // Desde otros estados no.
  for (const estado of ['confirmado', 'devuelto', 'anulado', 'convertido_en_deuda']) {
    await depositoDigitado(estado)
    await assertFails(setDoc(doc(como(UID_GESTOR), 'ordenes_deposito', DEP_V), rechazo(), { merge: true }))
  }
})

test('FIN1B-L2 · el staff crea el depósito de captura (con y sin montoBruto/gastos), pasa a en_revision con comprobante, pide corrección y reemplaza versionado ⇒ ALLOW; todo con su lista cerrada', async () => {
  await assertSucceeds(setDoc(doc(como(UID_GESTOR), 'ordenes_deposito', 'dxL2a'), depositoBase({ cuentasDestino: [], montoBruto: 120, gastosDescontados: 10, gastosIds: ['g1'] })))
  await assertSucceeds(setDoc(doc(como(UID_ADMIN), 'ordenes_deposito', 'dxL2b'), depositoBase({ tipo: 'recaudacion_motorizado_comercio', destinatario: 'comercio', destinatarioId: COMERCIO_ID })))
  await depositoAB('en_revision')
  await assertSucceeds(pedirCorreccion())
})

// ═════════════════════════════════════════════════════════════════════════════
// FIN-1C-A · cobros, tipo C y cobros_semanales AUTORITATIVOS
//
// Los escribe el servidor (registrarCobroDelivery, revertirCobroDelivery, registrarPagoCobroSemanal; Admin SDK, que no pasa por estas
// Rules). Desde el cliente ya no se puede fabricar un cobro pagado, un DEP tipo C, una semana pagada ni el monto/precio que los determina.
// Lo legítimo del cliente (boucher, ResolveModal) sigue pasando.
// ═════════════════════════════════════════════════════════════════════════════

async function sembrarOrdenCobro(id: string, extra: Record<string, unknown> = {}) {
  await env.withSecurityRulesDisabled(async (ctx) => {
    await setDoc(doc(ctx.firestore(), 'solicitudes_envio', id), {
      ...ordenBase({ estado: 'entregado' }), codigo: 'SH-0100', secuencia: 100,
      confirmacion: { precioFinalCordobas: 100, confirmadoPorUid: 'srv' },
      pagoDelivery: { quienPaga: 'entrega' },
      cobroDelivery: { estado: 'pendiente', monto: 100, tipoCliente: 'contado', quienPaga: 'entrega' },
      ...extra,
    })
  })
}
const ordenRef = (uid: string, id: string) => doc(como(uid), 'solicitudes_envio', id)
const STAFF_UIDS = [UID_GESTOR, UID_ADMIN]

test('FIN1C-R1 · el DEP tipo C no se crea desde el cliente: ni gestor ni admin, ni suelto ni junto a su orden, ni motorizado ni digitador ⇒ DENY', async () => {
  await sembrarOrdenCobro('ordC1')
  for (const uid of STAFF_UIDS) {
    await assertFails(setDoc(doc(como(uid), 'ordenes_deposito', 'depTC-' + uid), depositoTipoC({ solicitudIds: ['ordC1'], confirmadoPorUid: uid })))
    const db = como(uid)
    const b = writeBatch(db)
    b.set(doc(db, 'ordenes_deposito', 'depTCb-' + uid), depositoTipoC({ solicitudIds: ['ordC1'], confirmadoPorUid: uid }))
    b.update(doc(db, 'solicitudes_envio', 'ordC1'), confirmacionTipoC('depTCb-' + uid))
    await assertFails(b.commit())
  }
  await assertFails(setDoc(doc(como(UID_MOTO), 'ordenes_deposito', 'depTCm'), depositoTipoC({ motorizadoUid: UID_MOTO })))
  await assertFails(setDoc(doc(como(UID_DIGITADOR), 'ordenes_deposito', 'depTCd'), { ...depositoTipoC({ estado: 'pendiente_boucher' }), digitadoPorUid: UID_DIGITADOR, digitadoAt: serverTimestamp() }))
  // Control: el depósito de captura A/B sigue naciendo (FIN-1B sin regresión).
  await assertSucceeds(setDoc(doc(como(UID_GESTOR), 'ordenes_deposito', 'dxC1ok'), depositoBase({ cuentasDestino: [], montoBruto: 120, gastosDescontados: 10, gastosIds: [] })))
})

test('FIN1C-R2 · un cobro NO pasa a pagado desde el cliente: ni por campo, ni por mapa completo, ni con sus campos de pago ⇒ DENY', async () => {
  await sembrarOrdenCobro('ordC2')
  for (const uid of STAFF_UIDS) {
    await assertFails(updateDoc(ordenRef(uid, 'ordC2'), { 'cobroDelivery.estado': 'pagado' }))
    await assertFails(updateDoc(ordenRef(uid, 'ordC2'), { 'cobroDelivery.estado': 'pagado', 'cobroDelivery.pagadoAt': serverTimestamp(), 'cobroDelivery.formaPago': 'efectivo', 'cobroDelivery.confirmadoPor': uid }))
    await assertFails(updateDoc(ordenRef(uid, 'ordC2'), { cobroDelivery: { estado: 'pagado', monto: 100, tipoCliente: 'contado', quienPaga: 'entrega', pagadoAt: serverTimestamp() } }))
    // Ni los campos de pago sueltos con el estado intacto.
    for (const campo of ['pagadoAt', 'formaPago', 'confirmadoPor', 'confirmadoAt', 'metodoPagoReal', 'movimientoPagoId', 'notaPago']) {
      await assertFails(updateDoc(ordenRef(uid, 'ordC2'), { ['cobroDelivery.' + campo]: campo.endsWith('At') ? serverTimestamp() : 'x' }))
    }
    // Ni borrar el mapa.
    await assertFails(updateDoc(ordenRef(uid, 'ordC2'), { cobroDelivery: deleteField() }))
  }
})

test('FIN1C-R3 · un cobro YA pagado es inmutable para el cliente: ni revertir, ni anotar, ni tocar el boucher ⇒ DENY', async () => {
  await sembrarPagadaTipoC()
  for (const uid of STAFF_UIDS) {
    for (const cambio of [
      { 'cobroDelivery.estado': 'pendiente' },
      { 'cobroDelivery.monto': 1 },
      { 'cobroDelivery.notaPago': 'x' },
      { 'cobroDelivery.boucherVigente': deleteField() },
      { 'cobroDelivery.formaPago': 'efectivo' },
    ]) await assertFails(updateDoc(ordenRef(uid, 'ordP'), cambio))
  }
})

test('FIN1C-R4 · cobroDelivery.monto es inmutable; solo nace en una orden legacy sin monto y con el precio confirmado de la propia orden', async () => {
  await sembrarOrdenCobro('ordC4')
  for (const uid of STAFF_UIDS) {
    await assertFails(updateDoc(ordenRef(uid, 'ordC4'), { 'cobroDelivery.monto': 1 }))
    await assertFails(updateDoc(ordenRef(uid, 'ordC4'), { 'cobroDelivery.monto': 0 }))
    await assertFails(updateDoc(ordenRef(uid, 'ordC4'), { cobroDelivery: { estado: 'pendiente', monto: 5, tipoCliente: 'contado', quienPaga: 'entrega' } }))
    // Mismo valor: no es un cambio.
    await assertSucceeds(updateDoc(ordenRef(uid, 'ordC4'), { 'cobroDelivery.monto': 100, updatedAt: serverTimestamp() }))
  }
  // Legacy: sin cobroDelivery, el gestor sube el boucher (GestorBoucherUpload) y preserva el precio confirmado ⇒ ALLOW; otro valor ⇒ DENY.
  const subida = (monto: number) => ({
    'cobroDelivery.estado': 'en_revision_deposito',
    'cobroDelivery.boucherGestor': { url: 'https://example.test/g.jpg', path: 'evidencias/ordC4b/delivery_boucher_gestor.jpg', at: serverTimestamp() },
    'cobroDelivery.boucherVigente': 'gestor',
    'cobroDelivery.monto': monto,
    'cobroDelivery.tipoCliente': 'contado',
    'cobroDelivery.quienPaga': 'transferencia',
    'cobroDelivery.registradoAt': serverTimestamp(),
    updatedAt: serverTimestamp(),
  })
  await env.withSecurityRulesDisabled(async (ctx) => {
    await setDoc(doc(ctx.firestore(), 'solicitudes_envio', 'ordC4b'), { ...ordenBase({ estado: 'entregado' }), codigo: 'SH-0101', secuencia: 101, confirmacion: { precioFinalCordobas: 100 } })
  })
  await assertFails(updateDoc(ordenRef(UID_GESTOR, 'ordC4b'), subida(7)))
  await assertSucceeds(updateDoc(ordenRef(UID_GESTOR, 'ordC4b'), subida(100)))
})

test('FIN1C-R5 · confirmacion (precioFinalCordobas) no se escribe desde el cliente: ni gestor ni admin, ni editando ni borrando ⇒ DENY', async () => {
  await sembrarOrdenCobro('ordC5')
  for (const uid of STAFF_UIDS) {
    await assertFails(updateDoc(ordenRef(uid, 'ordC5'), { 'confirmacion.precioFinalCordobas': 1 }))
    await assertFails(updateDoc(ordenRef(uid, 'ordC5'), { confirmacion: { precioFinalCordobas: 1 } }))
    await assertFails(updateDoc(ordenRef(uid, 'ordC5'), { confirmacion: deleteField() }))
  }
  // El motorizado tampoco (AR9 sigue vigente) ni el comercio.
  await env.withSecurityRulesDisabled(async (ctx) => {
    await setDoc(doc(ctx.firestore(), 'solicitudes_envio', 'ordC5m'), { ...ordenBase({ estado: 'en_camino_entrega' }), codigo: 'SH-0102', secuencia: 102, asignacion: ASIGNACION_ACEPTADA, confirmacion: { precioFinalCordobas: 100 } })
  })
  await assertFails(updateDoc(ordenRef(UID_MOTO, 'ordC5m'), { 'confirmacion.precioFinalCordobas': 1 }))
  await assertFails(updateDoc(ordenRef(UID_COMERCIO, 'ordC5'), { 'confirmacion.precioFinalCordobas': 1 }))
})

test('FIN1C-R6 · cobros_semanales: gestor y admin LEEN, pero ni crean, ni actualizan, ni borran; el resto de los roles ni leen ⇒ ALLOW / DENY', async () => {
  await env.withSecurityRulesDisabled(async (ctx) => {
    await setDoc(doc(ctx.firestore(), 'cobros_semanales', 'cs1'), { clienteUid: COMERCIO_ID, semanaKey: '2026-W20', totalMonto: 300, totalPagado: 0, estado: 'pendiente', pagos: [], ordenesIds: ['a'] })
  })
  for (const uid of STAFF_UIDS) {
    await assertSucceeds(getDoc(doc(como(uid), 'cobros_semanales', 'cs1')))
    await assertFails(setDoc(doc(como(uid), 'cobros_semanales', 'csNuevo-' + uid), { clienteUid: COMERCIO_ID, semanaKey: '2026-W21', totalMonto: 1, totalPagado: 1, estado: 'pagado', pagos: [], ordenesIds: [] }))
    await assertFails(updateDoc(doc(como(uid), 'cobros_semanales', 'cs1'), { totalPagado: 300, estado: 'pagado' }))
    await assertFails(updateDoc(doc(como(uid), 'cobros_semanales', 'cs1'), { totalMonto: 1 }))
    await assertFails(updateDoc(doc(como(uid), 'cobros_semanales', 'cs1'), { pagos: [] }))
    await assertFails(deleteDoc(doc(como(uid), 'cobros_semanales', 'cs1')))
  }
  for (const uid of [UID_COMERCIO, UID_MOTO, UID_DIGITADOR]) await assertFails(getDoc(doc(como(uid), 'cobros_semanales', 'cs1')))
})

test('FIN1C-R7 · operaciones_cobro es server-only: nadie la lee ni la escribe desde el cliente (default-deny) ⇒ DENY', async () => {
  await env.withSecurityRulesDisabled(async (ctx) => {
    await setDoc(doc(ctx.firestore(), 'operaciones_cobro', 'cobro_op-12345678'), { tipo: 'cobro_delivery', ordenIds: ['a'], actorUid: 'x' })
  })
  for (const uid of [UID_GESTOR, UID_ADMIN, UID_MOTO, UID_COMERCIO, UID_DIGITADOR]) {
    await assertFails(getDoc(doc(como(uid), 'operaciones_cobro', 'cobro_op-12345678')))
    await assertFails(setDoc(doc(como(uid), 'operaciones_cobro', 'cobro_nuevo-' + uid), { tipo: 'cobro_delivery' }))
    await assertFails(updateDoc(doc(como(uid), 'operaciones_cobro', 'cobro_op-12345678'), { ordenIds: [] }))
    await assertFails(deleteDoc(doc(como(uid), 'operaciones_cobro', 'cobro_op-12345678')))
  }
})

test('FIN1C-R8 · el motorizado ya no crea cobroDelivery (ni siquiera la primera vez, ni con un monto cualquiera) pero sigue avisando "en camino" ⇒ DENY / ALLOW', async () => {
  await env.withSecurityRulesDisabled(async (ctx) => {
    await setDoc(doc(ctx.firestore(), 'solicitudes_envio', 'ordC8'), { ...ordenBase({ estado: 'retirado' }), codigo: 'SH-0103', secuencia: 103, asignacion: ASIGNACION_ACEPTADA, confirmacion: { precioFinalCordobas: 100 } })
  })
  await assertFails(updateDoc(ordenRef(UID_MOTO, 'ordC8'), {
    cobroDelivery: { monto: 1, tipoCliente: 'contado', quienPaga: 'entrega', estado: 'pagado', registradoAt: serverTimestamp() },
  }))
  await assertFails(updateDoc(ordenRef(UID_MOTO, 'ordC8'), {
    'cobroDelivery.estado': 'pagado',
  }))
  await assertSucceeds(updateDoc(ordenRef(UID_MOTO, 'ordC8'), { estado: 'en_camino_entrega', updatedAt: serverTimestamp() }))
})

test('FIN1C-R9 · lo legítimo del cliente sigue: subir, reemplazar y quitar el boucher (gestor) y el comprobante del comercio ⇒ ALLOW; clasificar la incidencia (ResolveModal) ya es del servidor ⇒ DENY (FIN-1C-B)', async () => {
  // Subir (cobro pendiente con monto ya fijado).
  await sembrarOrdenCobro('ordC9')
  await assertSucceeds(updateDoc(ordenRef(UID_GESTOR, 'ordC9'), {
    'cobroDelivery.estado': 'en_revision_deposito',
    'cobroDelivery.boucherGestor': { url: 'https://example.test/g.jpg', path: 'evidencias/ordC9/delivery_boucher_gestor.jpg', at: serverTimestamp() },
    'cobroDelivery.boucherVigente': 'gestor',
    'cobroDelivery.monto': 100,
    'cobroDelivery.tipoCliente': 'contado',
    'cobroDelivery.quienPaga': 'transferencia',
    'cobroDelivery.registradoAt': serverTimestamp(),
    updatedAt: serverTimestamp(),
  }))
  // Reemplazar.
  await assertSucceeds(updateDoc(ordenRef(UID_ADMIN, 'ordC9'), {
    'cobroDelivery.boucherGestor': { url: 'https://example.test/g2.jpg', path: 'evidencias/ordC9/delivery_boucher_gestor.jpg', at: serverTimestamp() },
    'cobroDelivery.boucherVigente': 'gestor',
    updatedAt: serverTimestamp(),
  }))
  // Quitar (vuelve a pendiente y limpia el puntero plano).
  await assertSucceeds(updateDoc(ordenRef(UID_GESTOR, 'ordC9'), {
    'cobroDelivery.estado': 'pendiente',
    'cobroDelivery.boucherVigente': deleteField(),
    'cobroDelivery.boucherUrl': deleteField(),
    'cobroDelivery.boucherPath': deleteField(),
    'cobroDelivery.boucherAt': deleteField(),
    'cobroDelivery.subidoPor': deleteField(),
    updatedAt: serverTimestamp(),
  }))
  // ResolveModal: 'cliente_pagara' sobre una orden SIN cobroDelivery (nace pendiente, sin monto) y 'se_pierde' (no_cobrar).
  await env.withSecurityRulesDisabled(async (ctx) => {
    await setDoc(doc(ctx.firestore(), 'solicitudes_envio', 'ordC9r'), {
      ...ordenBase({ estado: 'entregado' }), codigo: 'SH-0104', secuencia: 104, cobroPendiente: true, confirmacion: { precioFinalCordobas: 100 },
      cobrosMotorizado: { delivery: { recibio: false } },
    })
  })
  await assertFails(updateDoc(ordenRef(UID_GESTOR, 'ordC9r'), {
    'cobrosMotorizado.resolucion': { resueltoPor: UID_GESTOR, at: serverTimestamp(), nota: null, tipo: 'cliente_pagara' },
    'cobroDelivery.estado': 'pendiente',
    'cobroDelivery.registradoAt': serverTimestamp(),
    cobroPendiente: false,
  }))
  await sembrarOrdenCobro('ordC9s')
  await assertFails(updateDoc(ordenRef(UID_GESTOR, 'ordC9s'), {
    'cobrosMotorizado.resolucion': { resueltoPor: UID_GESTOR, at: serverTimestamp(), nota: null, tipo: 'se_pierde' },
    'cobroDelivery.estado': 'no_cobrar',
    cobroPendiente: false,
  }))
  // El comprobante del COMERCIO también sigue (su regla propia).
  await env.withSecurityRulesDisabled(async (ctx) => {
    await setDoc(doc(ctx.firestore(), 'solicitudes_envio', 'ordC9c'), { ...ordenBase({ estado: 'entregado' }), codigo: 'SH-0105', secuencia: 105 })
  })
  await assertSucceeds(updateDoc(ordenRef(UID_COMERCIO, 'ordC9c'), {
    'cobroDelivery.estado': 'en_revision_deposito',
    'cobroDelivery.boucherComercio': { url: 'https://example.test/c.jpg', path: 'evidencias/ordC9c/delivery_boucher_comercio.jpg', at: serverTimestamp() },
    'cobroDelivery.boucherVigente': 'comercio',
    updatedAt: serverTimestamp(),
  }))
})

test('FIN1C-R10 · FIN-1B sin regresión: el staff sigue creando y capturando depósitos A/B; confirmar, rehacer y anular siguen siendo del servidor ⇒ ALLOW / DENY', async () => {
  await depositoAB('pendiente_boucher')
  await assertSucceeds(updateDoc(doc(como(UID_GESTOR), 'ordenes_deposito', DEP_V), { boucher: { url: 'https://example.test/b.jpg', pathStorage: 'depositos/x/b.jpg' }, estado: 'en_revision', updatedAt: serverTimestamp() }))
  await depositoAB('en_revision')
  await assertFails(updateDoc(doc(como(UID_GESTOR), 'ordenes_deposito', DEP_V), { estado: 'confirmado', confirmadoPorUid: UID_GESTOR, confirmadoAt: serverTimestamp() }))
  await depositoAB('confirmado')
  await assertFails(updateDoc(doc(como(UID_ADMIN), 'ordenes_deposito', DEP_V), { estado: 'anulado', anuladoAt: serverTimestamp(), anuladoPorUid: UID_ADMIN, motivoAnulacion: 'xxx' }))
})

test('FIN1C-DEUDA-FIN1E · DEUDA SALDADA en FIN-1E: el ledger global (movimientos_financieros) ya NO está abierto a gestor/admin (C6/C8) ⇒ DENY', async () => {
  // C6/C8 del diagnóstico: un pago_recibido o un movimiento cualquiera podía crearse desde el cliente. Este test pineaba esa deuda como ALLOW; FIN-1E la cerró.
  for (const uid of STAFF_UIDS) {
    await assertFails(setDoc(doc(como(uid), 'movimientos_financieros', 'movDeuda1-' + uid), { tipo: 'pago_recibido', estado: 'activo', monto: 1, solicitudId: 'x', at: serverTimestamp(), creadoPorUid: uid, creadoPorRol: 'gestor', descripcion: 'deuda FIN-1E' }))
  }
})

test('FIN1C-R11 · el motorizado ya NO escribe pagoDelivery.quienPaga (credito_semanal → entrega, transferencia → entrega, ni mapa completo), antes ni después de entregar ⇒ DENY; sus señales legítimas siguen ⇒ ALLOW', async () => {
  const sembrarMoto = async (id: string, estado: string, pagoDelivery: Record<string, unknown>, extra: Record<string, unknown> = {}) => {
    await env.withSecurityRulesDisabled(async (ctx) => {
      await setDoc(doc(ctx.firestore(), 'solicitudes_envio', id), {
        ...ordenBase({ estado, asignacion: { motorizadoAuthUid: UID_MOTO, motorizadoNombre: 'John Pork', estadoAceptacion: 'aceptada' } }),
        codigo: 'SH-1100', secuencia: 1100, pagoDelivery, ...extra,
      })
    })
  }
  const moto = (id: string) => doc(como(UID_MOTO), 'solicitudes_envio', id)
  // credito_semanal → entrega (con la orden en camino, retirada o ya entregada).
  for (const estado of ['retirado', 'en_camino_entrega', 'entregado']) {
    await sembrarMoto('qp1' + estado, estado, { tipo: 'credito_semanal', quienPaga: 'credito_semanal' }, { tipoCliente: 'credito' })
    await assertFails(updateDoc(moto('qp1' + estado), { 'pagoDelivery.quienPaga': 'entrega' }))
    await assertFails(updateDoc(moto('qp1' + estado), { pagoDelivery: { tipo: 'credito_semanal', quienPaga: 'entrega' } }))
    // Tampoco junto a una señal legítima (estado) en el mismo write.
    if (estado === 'retirado') await assertFails(updateDoc(moto('qp1' + estado), { estado: 'en_camino_entrega', 'pagoDelivery.quienPaga': 'entrega', updatedAt: serverTimestamp() }))
  }
  // transferencia → entrega, y cualquier otro campo de pagoDelivery.
  await sembrarMoto('qp2', 'en_camino_entrega', { tipo: 'contado', quienPaga: 'transferencia', montoSugerido: 90 })
  await assertFails(updateDoc(moto('qp2'), { 'pagoDelivery.quienPaga': 'entrega' }))
  await assertFails(updateDoc(moto('qp2'), { 'pagoDelivery.montoSugerido': 1 }))
  await assertFails(updateDoc(moto('qp2'), { 'pagoDelivery.deducirDelCobroContraEntrega': true }))
  // Control: sus operaciones legítimas siguen (mismo recorrido de la misma regla).
  await sembrarMoto('qp3', 'retirado', { tipo: 'contado', quienPaga: 'entrega' })
  await assertSucceeds(updateDoc(moto('qp3'), { estado: 'en_camino_entrega', updatedAt: serverTimestamp() }))
  await assertSucceeds(updateDoc(moto('qp3'), { evidencias: { entrega: 'https://example.test/e.jpg' }, updatedAt: serverTimestamp() }))
  await assertSucceeds(updateDoc(moto('qp3'), { acumulacionCobroSemanal: { estado: 'pendiente', updatedAt: serverTimestamp() } }))
  // Escribir el MISMO pagoDelivery (sin cambiarlo) tampoco es un writer: no hay diff, el update pasa.
  await assertSucceeds(updateDoc(moto('qp3'), { 'pagoDelivery.quienPaga': 'entrega', updatedAt: serverTimestamp() }))
})

// ═════════════════════════════════════════════════════════════════════════════
// FIN-1C-B · gastos, adelantos y resolución de incidencias AUTORITATIVOS
//
// Los escriben las callables (crearGastoMotorizado, anularGastoMotorizado, registrarAdelantoMotorizado, anularAdelantoMotorizado,
// resolverIncidenciaCobro; Admin SDK, que no pasa por estas Rules). Cada bypass diagnosticado pasa de ALLOW a DENY; lo legítimo sigue.
// ═════════════════════════════════════════════════════════════════════════════

async function sembrarGastos1cb() {
  await env.withSecurityRulesDisabled(async (ctx) => {
    const db = ctx.firestore()
    await setDoc(doc(db, 'motorizado', 'mot1'), { authUid: UID_MOTO, nombre: 'Luigi' })
    await setDoc(doc(db, 'ordenes_deposito', 'DC'), { tipo: 'recaudacion_motorizado_storkhub', estado: 'confirmado', motorizadoUid: UID_MOTO, gastosIds: ['gC'], solicitudIds: [] })
    await setDoc(doc(db, 'gastos_motorizado', 'gC'), { motorizadoId: 'mot1', tipo: 'peaje_terminal', monto: 10, estado: 'aprobado', consumidoEnDepositoId: 'DC' })
    await setDoc(doc(db, 'gastos_motorizado', 'gL'), { motorizadoId: 'mot1', tipo: 'peaje_terminal', monto: 10, estado: 'aprobado' })
  })
}

test('FIN1CB-R1 · gastos: el cliente no crea (legítimo, arbitrario, de otro motorizado, de monto negativo, con estado o marca inventados), no edita el monto, no anula, no borra ⇒ DENY (gestor y admin); digitador y motorizado siguen DENY', async () => {
  await sembrarGastos1cb()
  const nuevo = { motorizadoId: 'mot1', motorizadoNombre: 'Luigi', tipo: 'peaje_terminal', monto: 10, estado: 'aprobado', nota: '', fecha: serverTimestamp(), creadoPorUid: UID_GESTOR, createdAt: serverTimestamp() }
  for (const uid of STAFF_UIDS) {
    const d = como(uid)
    await assertFails(setDoc(doc(d, 'gastos_motorizado', 'n1-' + uid), nuevo))
    await assertFails(setDoc(doc(d, 'gastos_motorizado', 'n2-' + uid), { ...nuevo, monto: 999999, motorizadoId: 'otro', creadoPorUid: 'cualquiera' }))
    await assertFails(setDoc(doc(d, 'gastos_motorizado', 'n3-' + uid), { ...nuevo, monto: -50 }))
    await assertFails(setDoc(doc(d, 'gastos_motorizado', 'n4-' + uid), { ...nuevo, estado: 'pendiente' }))
    await assertFails(setDoc(doc(d, 'gastos_motorizado', 'n5-' + uid), { ...nuevo, consumidoEnDepositoId: 'DC' }))
    await assertFails(updateDoc(doc(d, 'gastos_motorizado', 'gC'), { monto: 1 }))
    await assertFails(updateDoc(doc(d, 'gastos_motorizado', 'gC'), { estado: 'anulado', updatedAt: serverTimestamp() }))
    await assertFails(updateDoc(doc(d, 'gastos_motorizado', 'gL'), { monto: 1 }))
    await assertFails(updateDoc(doc(d, 'gastos_motorizado', 'gL'), { estado: 'anulado', updatedAt: serverTimestamp() }))
    await assertFails(updateDoc(doc(d, 'gastos_motorizado', 'gL'), { nota: 'x' }))
    await assertFails(deleteDoc(doc(d, 'gastos_motorizado', 'gL')))
  }
  for (const uid of [UID_DIGITADOR, UID_MOTO]) await assertFails(setDoc(doc(como(uid), 'gastos_motorizado', 'nd-' + uid), nuevo))
})

test('FIN1CB-R2 · gastos: la marca de consumo sigue cerrada (fabricar, quitar, reasignar ⇒ DENY) y la rama FIN-2 legítima sigue (un depósito con gastos se crea en un batch ⇒ ALLOW)', async () => {
  await sembrarGastos1cb()
  const g = como(UID_GESTOR)
  await assertFails(updateDoc(doc(g, 'gastos_motorizado', 'gL'), { consumidoEnDepositoId: 'DEPX' }))
  await assertFails(updateDoc(doc(g, 'gastos_motorizado', 'gL'), { consumidoEnDepositoId: 'DC' }))
  await assertFails(updateDoc(doc(como(UID_ADMIN), 'gastos_motorizado', 'gC'), { consumidoEnDepositoId: deleteField() }))
  await assertFails(updateDoc(doc(g, 'gastos_motorizado', 'gC'), { consumidoEnDepositoId: 'DEP9' }))
  await sembrarGastosFin2({ gq: { motorizadoId: 'mot1', estado: 'aprobado', monto: 10 } })
  await assertSucceeds(batchCrearDepositoConGastos(UID_MOTO, 'DUno', ['gq']).commit())
  assert.equal((await leerGastoFin2('gq'))?.consumidoEnDepositoId, 'DUno')
})

test('FIN1CB-R3 · ledger POR TIPO: gestor y admin no crean, editan, anulan ni reactivan un gasto_aprobado ni un adelanto_motorizado, ni disfrazan otro movimiento como uno de ellos ⇒ DENY', async () => {
  const mov = (tipo: string, extra: Record<string, unknown> = {}) => ({ tipo, monto: 100, at: serverTimestamp(), creadoPorUid: UID_GESTOR, creadoPorRol: 'gestor', descripcion: 'x', estado: 'activo', motorizadoId: 'mot1', ...extra })
  await env.withSecurityRulesDisabled(async (ctx) => {
    const db = ctx.firestore()
    await setDoc(doc(db, 'movimientos_financieros', 'adel'), { ...mov('adelanto_motorizado'), semanaKey: '2026-W20', cuentaOrigen: 'caja_storkhub', cuentaDestino: 'deuda_motorizado:mot1', at: new Date() })
    await setDoc(doc(db, 'movimientos_financieros', 'gast'), { ...mov('gasto_aprobado'), gastoId: 'gL', cuentaOrigen: 'efectivo_en_poder:mot1', cuentaDestino: 'gastos_operativos', at: new Date() })
    await setDoc(doc(db, 'movimientos_financieros', 'otro'), { ...mov('pago_recibido'), solicitudId: 'x', at: new Date() })
  })
  for (const uid of STAFF_UIDS) {
    const d = como(uid)
    await assertFails(setDoc(doc(d, 'movimientos_financieros', 'a1-' + uid), mov('adelanto_motorizado', { semanaKey: '2026-W20', cuentaOrigen: 'caja_storkhub', cuentaDestino: 'deuda_motorizado:mot1' })))
    await assertFails(setDoc(doc(d, 'movimientos_financieros', 'a3-' + uid), mov('adelanto_motorizado', { creadoPorUid: 'otroUid', creadoPorRol: 'admin' })))
    await assertFails(setDoc(doc(d, 'movimientos_financieros', 'a7-' + uid), mov('adelanto_motorizado', { motorizadoId: 'ajeno', monto: 1e7 })))
    await assertFails(setDoc(doc(d, 'movimientos_financieros', 'g5-' + uid), mov('gasto_aprobado', { monto: 5000, cuentaOrigen: 'efectivo_en_poder:mot1', cuentaDestino: 'gastos_operativos' })))
    await assertFails(updateDoc(doc(d, 'movimientos_financieros', 'adel'), { monto: 1 }))
    await assertFails(updateDoc(doc(d, 'movimientos_financieros', 'adel'), { estado: 'anulado', anuladoAt: serverTimestamp(), anuladoPorUid: uid, motivoAnulacion: 'x' }))
    await assertFails(updateDoc(doc(d, 'movimientos_financieros', 'gast'), { monto: 1 }))
    await assertFails(updateDoc(doc(d, 'movimientos_financieros', 'gast'), { estado: 'anulado', anuladoAt: serverTimestamp() }))
    // Disfraces: otro movimiento que pasa a ser de un tipo reservado, o uno reservado que deja de serlo.
    await assertFails(updateDoc(doc(d, 'movimientos_financieros', 'otro'), { tipo: 'adelanto_motorizado' }))
    await assertFails(updateDoc(doc(d, 'movimientos_financieros', 'otro'), { tipo: 'gasto_aprobado' }))
    await assertFails(updateDoc(doc(d, 'movimientos_financieros', 'adel'), { tipo: 'pago_recibido' }))
    await assertFails(deleteDoc(doc(d, 'movimientos_financieros', 'adel')))
  }
  await assertFails(setDoc(doc(como(UID_DIGITADOR), 'movimientos_financieros', 'ad-dig'), mov('adelanto_motorizado')))
  // Control (FIN-1E): ya NO hay "resto del ledger" abierto — la misma forma de escritura, con cualquier otro tipo, también es DENY.
  await assertFails(setDoc(doc(como(UID_GESTOR), 'movimientos_financieros', 'ctl'), mov('pago_recibido', { solicitudId: 'x' })))
  await assertFails(updateDoc(doc(como(UID_ADMIN), 'movimientos_financieros', 'otro'), { descripcion: 'editada' }))
})

test('FIN1CB-R4 · solicitudes: la resolución de incidencias es del servidor: no_cobrar ni se crea ni se deshace, no se firma una resolución, no se toca cobroPendiente ni cobrosMotorizado ⇒ DENY (gestor y admin)', async () => {
  await env.withSecurityRulesDisabled(async (ctx) => {
    await setDoc(doc(ctx.firestore(), 'solicitudes_envio', 'rz1'), {
      ...ordenBase({ estado: 'entregado' }), codigo: 'SH-0300', secuencia: 300, confirmacion: { precioFinalCordobas: 100 }, cobroPendiente: true,
      cobrosMotorizado: { delivery: { recibio: false }, producto: { recibio: true, monto: 60 } },
      cobroDelivery: { estado: 'pendiente', monto: 100, tipoCliente: 'contado', quienPaga: 'entrega' },
    })
    await setDoc(doc(ctx.firestore(), 'solicitudes_envio', 'rz2'), {
      ...ordenBase({ estado: 'entregado' }), codigo: 'SH-0301', secuencia: 301, confirmacion: { precioFinalCordobas: 100 },
      cobroDelivery: { estado: 'no_cobrar', monto: 100, tipoCliente: 'contado', quienPaga: 'entrega' },
    })
    await setDoc(doc(ctx.firestore(), 'solicitudes_envio', 'rz3'), { ...ordenBase({ estado: 'entregado' }), codigo: 'SH-0302', secuencia: 302, confirmacion: { precioFinalCordobas: 100 }, cobroPendiente: true })
  })
  const firma = { resueltoPor: 'otra-persona', at: serverTimestamp(), nota: null, tipo: 'se_pierde' }
  for (const uid of STAFF_UIDS) {
    await assertFails(updateDoc(ordenRef(uid, 'rz1'), { 'cobroDelivery.estado': 'no_cobrar' }))                      // se_pierde (condonar)
    await assertFails(updateDoc(ordenRef(uid, 'rz2'), { 'cobroDelivery.estado': 'pendiente' }))                      // deshacer la condonación
    await assertFails(updateDoc(ordenRef(uid, 'rz1'), { 'cobrosMotorizado.resolucion': firma }))                     // actor falso
    await assertFails(updateDoc(ordenRef(uid, 'rz1'), { 'cobrosMotorizado.producto.resolucion': firma, 'cobrosMotorizado.producto.estado': 'no_cobrar' }))
    await assertFails(updateDoc(ordenRef(uid, 'rz1'), { cobroPendiente: false }))
    await assertFails(updateDoc(ordenRef(uid, 'rz1'), { cobrosMotorizado: deleteField() }))
    await assertFails(updateDoc(ordenRef(uid, 'rz3'), { 'cobroDelivery.estado': 'pendiente', 'cobroDelivery.registradoAt': serverTimestamp(), 'cobrosMotorizado.resolucion': firma, cobroPendiente: false })) // ResolveModal sobre orden sin cobroDelivery
    // Una orden condonada no se toca desde el cliente (ni su boucher).
    await assertFails(updateDoc(ordenRef(uid, 'rz2'), { 'cobroDelivery.estado': 'en_revision_deposito', 'cobroDelivery.boucherVigente': 'gestor', 'cobroDelivery.boucherGestor': { url: 'https://example.test/g.jpg', path: 'p', at: serverTimestamp() } }))
  }
  // El motorizado tampoco escribe cobroPendiente (lo escribe el servidor al entregar) y sigue avisando "en camino".
  await env.withSecurityRulesDisabled(async (ctx) => {
    await setDoc(doc(ctx.firestore(), 'solicitudes_envio', 'rz4'), { ...ordenBase({ estado: 'retirado', asignacion: { motorizadoAuthUid: UID_MOTO, motorizadoNombre: 'John Pork', estadoAceptacion: 'aceptada' } }), codigo: 'SH-0303', secuencia: 303 })
  })
  await assertFails(updateDoc(ordenRef(UID_MOTO, 'rz4'), { cobroPendiente: true }))
  await assertSucceeds(updateDoc(ordenRef(UID_MOTO, 'rz4'), { estado: 'en_camino_entrega', updatedAt: serverTimestamp() }))
})

test('FIN1CB-R5 · Q4 residual: gestor y admin no editan, después de creada la orden, los inputs de la fórmula del monto (cobrosMotorizado.*, pagoDelivery.*, cobroContraEntrega.*, tipoCliente) ⇒ DENY; el resto de la orden sigue editable ⇒ ALLOW', async () => {
  await env.withSecurityRulesDisabled(async (ctx) => {
    await setDoc(doc(ctx.firestore(), 'solicitudes_envio', 'q4'), {
      ...ordenBase({ estado: 'entregado' }), codigo: 'SH-0310', secuencia: 310, confirmacion: { precioFinalCordobas: 100 },
      pagoDelivery: { quienPaga: 'entrega', deducirDelCobroContraEntrega: true }, cobroContraEntrega: { aplica: true, monto: 60 },
      cobrosMotorizado: { delivery: { recibio: false }, producto: { recibio: true, monto: 60 } },
    })
  })
  for (const uid of STAFF_UIDS) {
    for (const cambio of [
      { 'cobrosMotorizado.producto.recibio': false }, { 'cobrosMotorizado.producto.monto': 1 }, { 'cobrosMotorizado.delivery.recibio': true },
      { 'pagoDelivery.deducirDelCobroContraEntrega': false }, { 'pagoDelivery.quienPaga': 'credito_semanal' }, { 'cobroContraEntrega.monto': 1 }, { 'cobroContraEntrega.aplica': false },
      { tipoCliente: 'credito' }, { pagoDelivery: { quienPaga: 'entrega' } },
    ]) await assertFails(updateDoc(ordenRef(uid, 'q4'), cambio))
    await assertSucceeds(updateDoc(ordenRef(uid, 'q4'), { prioridad: true, updatedAt: serverTimestamp() }))
  }
})

test('FIN1CB-R6 · marcadores server-only: operaciones_gasto y operaciones_adelanto no se leen ni se escriben desde ningún rol del cliente ⇒ DENY', async () => {
  await env.withSecurityRulesDisabled(async (ctx) => {
    await setDoc(doc(ctx.firestore(), 'operaciones_gasto', 'crear_op-12345678'), { tipo: 'crear_gasto', actorUid: 'x' })
    await setDoc(doc(ctx.firestore(), 'operaciones_adelanto', 'registrar_op-12345678'), { tipo: 'registrar_adelanto', actorUid: 'x' })
  })
  for (const [col, id] of [['operaciones_gasto', 'crear_op-12345678'], ['operaciones_adelanto', 'registrar_op-12345678']]) {
    for (const uid of [UID_GESTOR, UID_ADMIN, UID_MOTO, UID_COMERCIO, UID_DIGITADOR]) {
      await assertFails(getDoc(doc(como(uid), col, id)))
      await assertFails(setDoc(doc(como(uid), col, 'precreado-' + uid), { tipo: 'x' }))
      await assertFails(updateDoc(doc(como(uid), col, id), { actorUid: 'y' }))
      await assertFails(deleteDoc(doc(como(uid), col, id)))
    }
  }
})

test('FIN1CB-R7 · sin regresión: FIN-1C-A (DEP-C, cobros_semanales, monto, confirmacion, pagado) y FIN-1B (depósitos A/B) siguen como estaban', async () => {
  await sembrarOrdenCobro('ordR7')
  for (const uid of STAFF_UIDS) {
    await assertFails(updateDoc(ordenRef(uid, 'ordR7'), { 'cobroDelivery.estado': 'pagado' }))
    await assertFails(updateDoc(ordenRef(uid, 'ordR7'), { 'cobroDelivery.monto': 1 }))
    await assertFails(updateDoc(ordenRef(uid, 'ordR7'), { 'confirmacion.precioFinalCordobas': 1 }))
    await assertFails(setDoc(doc(como(uid), 'cobros_semanales', 'csR7-' + uid), { clienteUid: COMERCIO_ID, totalMonto: 1 }))
    await assertFails(setDoc(doc(como(uid), 'ordenes_deposito', 'depTC-' + uid), depositoTipoC({ solicitudIds: ['ordR7'], confirmadoPorUid: uid })))
  }
  // El boucher legítimo sigue (mismo recorrido de la misma regla).
  await assertSucceeds(updateDoc(ordenRef(UID_GESTOR, 'ordR7'), {
    'cobroDelivery.estado': 'en_revision_deposito',
    'cobroDelivery.boucherGestor': { url: 'https://example.test/g.jpg', path: 'p', at: serverTimestamp() },
    'cobroDelivery.boucherVigente': 'gestor',
    updatedAt: serverTimestamp(),
  }))
  await assertSucceeds(setDoc(doc(como(UID_GESTOR), 'ordenes_deposito', 'dxR7'), depositoBase({ cuentasDestino: [], montoBruto: 120, gastosDescontados: 10, gastosIds: [] })))
})

// ═════════════════════════════════════════════════════════════════════
// FIN-1D · liquidaciones, saldos y abonos de deuda AUTORITATIVOS
//
// Los escriben las callables crearLiquidacionMotorizado y marcarLiquidacionPagada (y las de FIN-1A/FIN-4C para saldos; todas Admin SDK, que no pasa
// por estas Rules). Cada bypass diagnosticado (LQ1–LQ10, P1–P8, liquidacion_pago_efectivo) pasa de ALLOW a DENY; lo legítimo (leer, el PDF) sigue.
// ═════════════════════════════════════════════════════════════════════

const LIQ_ID = 'mot1_2026-W20'
const liqBase = (extra: Record<string, unknown> = {}) => ({
  motorizadoId: 'mot1', motorizadoUid: UID_MOTO, motorizadoNombre: 'Luigi', semanaKey: '2026-W20', totalViajes: 2, totalGenerado: 200, comisionPct: 0.8, comision: 160,
  adelantos: 0, faltantesDeposito: 0, otrosDescuentos: 0, deudasAplicadas: 0, deudasAplicadasIds: [], gastosIds: [], netoAPagar: 160, estado: 'pagado',
  creadoPor: UID_GESTOR, ordenesIds: ['o1', 'o2'], depositosIds: [], ...extra,
})
async function sembrarLiquidaciones1d() {
  await env.withSecurityRulesDisabled(async (ctx) => {
    const db = ctx.firestore()
    await setDoc(doc(db, 'motorizado', 'mot1'), { authUid: UID_MOTO, nombre: 'Luigi' })
    await setDoc(doc(db, 'liquidaciones_motorizado', LIQ_ID), liqBase())
    await setDoc(doc(db, 'liquidaciones_motorizado', 'mot1_2026-W19'), liqBase({ semanaKey: '2026-W19', estado: 'pendiente' }))
  })
}

test('FIN1D-R1 · liquidaciones: LQ1–LQ10 ⇒ DENY (crear, reescribir, "pagar", cambiar cifras, borrar) para gestor y admin; motorizado, digitador, comercio y anónimo tampoco', async () => {
  await sembrarLiquidaciones1d()
  for (const uid of STAFF_UIDS) {
    const d = como(uid)
    // LQ1–LQ8 / LQ9: crear con cifras, motorizado, semana, actor, estado, ids o adelantos arbitrarios, y duplicar la semana
    await assertFails(setDoc(doc(d, 'liquidaciones_motorizado', 'n1-' + uid), liqBase({ comision: 999999, netoAPagar: 999999 })))
    await assertFails(setDoc(doc(d, 'liquidaciones_motorizado', 'n2-' + uid), liqBase({ motorizadoId: 'otro', motorizadoUid: 'otroUid' })))
    await assertFails(setDoc(doc(d, 'liquidaciones_motorizado', 'n3-' + uid), liqBase({ semanaKey: '2099-W99' })))
    await assertFails(setDoc(doc(d, 'liquidaciones_motorizado', 'n4-' + uid), liqBase({ creadoPor: 'uid_falso' })))
    await assertFails(setDoc(doc(d, 'liquidaciones_motorizado', 'n5-' + uid), liqBase({ estado: 'pagado', pagadoPor: 'otro', pagadoAt: serverTimestamp() })))
    await assertFails(setDoc(doc(d, 'liquidaciones_motorizado', 'n6-' + uid), liqBase({ gastosIds: ['falso1', 'falso2'] })))
    await assertFails(setDoc(doc(d, 'liquidaciones_motorizado', 'n7-' + uid), liqBase({ ordenesIds: ['fantasma'] })))
    await assertFails(setDoc(doc(d, 'liquidaciones_motorizado', 'n8-' + uid), liqBase({ adelantos: 5000 })))
    await assertFails(addDoc(collection(d, 'liquidaciones_motorizado'), liqBase({ semanaKey: '2026-W20' }))) // LQ9a: id aleatorio, misma semana
    await assertFails(setDoc(doc(d, 'liquidaciones_motorizado', LIQ_ID), liqBase({ netoAPagar: 1 }))) // LQ9b: sobrescribir la determinista
    // LQ10: editar cifras o estado de una liquidación existente, "pagarla", reabrirla, borrarla
    await assertFails(updateDoc(doc(d, 'liquidaciones_motorizado', LIQ_ID), { netoAPagar: 123456 }))
    await assertFails(updateDoc(doc(d, 'liquidaciones_motorizado', LIQ_ID), { estado: 'pendiente', pagadoPor: deleteField() }))
    await assertFails(updateDoc(doc(d, 'liquidaciones_motorizado', 'mot1_2026-W19'), { estado: 'pagado', pagadoAt: serverTimestamp(), pagadoPor: uid }))
    await assertFails(updateDoc(doc(d, 'liquidaciones_motorizado', 'mot1_2026-W19'), { netoAPagar: 1, gastosIds: ['x'] }))
    await assertFails(deleteDoc(doc(d, 'liquidaciones_motorizado', LIQ_ID)))
  }
  for (const [uid, id] of [[UID_MOTO, 'm1'], [UID_DIGITADOR, 'm2'], [UID_COMERCIO, 'm3']] as const) {
    await assertFails(setDoc(doc(como(uid), 'liquidaciones_motorizado', 'ns-' + id), liqBase()))
    await assertFails(updateDoc(doc(como(uid), 'liquidaciones_motorizado', LIQ_ID), { netoAPagar: 1 }))
    await assertFails(updateDoc(doc(como(uid), 'liquidaciones_motorizado', LIQ_ID), { pdfUrl: 'https://example.test/x.pdf', pdfPath: 'p', pdfGeneradoAt: serverTimestamp() }))
  }
  await assertFails(setDoc(doc(env.unauthenticatedContext().firestore(), 'liquidaciones_motorizado', 'anon'), liqBase()))
  // Control: leer sigue (staff y el motorizado dueño; otro motorizado no).
  await assertSucceeds(getDoc(doc(como(UID_GESTOR), 'liquidaciones_motorizado', LIQ_ID)))
  await assertSucceeds(getDoc(doc(como(UID_MOTO), 'liquidaciones_motorizado', LIQ_ID)))
  await assertFails(getDoc(doc(como(UID_MOTO_B), 'liquidaciones_motorizado', LIQ_ID)))
})

test('FIN1D-R2 · liquidaciones: el PDF sigue siendo del cliente — SOLO pdfUrl/pdfPath/pdfGeneradoAt de una liquidación YA pagada ⇒ ALLOW; con cualquier campo financiero, en una pendiente o cambiando el estado ⇒ DENY', async () => {
  await sembrarLiquidaciones1d()
  const pdf = { pdfUrl: 'https://example.test/liq.pdf', pdfPath: 'liquidaciones/mot1_2026-W20.pdf', pdfGeneradoAt: serverTimestamp() }
  for (const uid of STAFF_UIDS) {
    const d = como(uid)
    await assertFails(updateDoc(doc(d, 'liquidaciones_motorizado', LIQ_ID), { ...pdf, netoAPagar: 999 }))
    await assertFails(updateDoc(doc(d, 'liquidaciones_motorizado', LIQ_ID), { ...pdf, estado: 'pendiente' }))
    await assertFails(updateDoc(doc(d, 'liquidaciones_motorizado', LIQ_ID), { ...pdf, gastosIds: ['x'] }))
    await assertFails(updateDoc(doc(d, 'liquidaciones_motorizado', LIQ_ID), { ...pdf, pagadoPor: 'otro' }))
    await assertFails(updateDoc(doc(d, 'liquidaciones_motorizado', LIQ_ID), { ...pdf, pdfOtro: 'x' }))
    await assertFails(updateDoc(doc(d, 'liquidaciones_motorizado', 'mot1_2026-W19'), pdf)) // pendiente: el PDF solo existe al pagar
  }
  await assertSucceeds(updateDoc(doc(como(UID_GESTOR), 'liquidaciones_motorizado', LIQ_ID), pdf))
  await assertSucceeds(updateDoc(doc(como(UID_ADMIN), 'liquidaciones_motorizado', LIQ_ID), { pdfUrl: 'https://example.test/otra.pdf', pdfPath: 'otra.pdf', pdfGeneradoAt: serverTimestamp() }))
})

async function sembrarSaldos1d() {
  await env.withSecurityRulesDisabled(async (ctx) => {
    const db = ctx.firestore()
    const s = (extra: Record<string, unknown>) => ({ motorizadoId: 'mot1', motorizadoUid: UID_MOTO, motorizadoNombre: 'Luigi', tipo: 'deposito_no_realizado', montoOriginal: 100, saldoPendiente: 100, estado: 'pendiente', origen: 'deposito', abonos: [], ...extra })
    await setDoc(doc(db, 'saldos_cargo_motorizado', 'S1'), s({}))
    await setDoc(doc(db, 'saldos_cargo_motorizado', 'S2'), s({ motorizadoId: 'mot2', motorizadoUid: UID_MOTO_B }))
    await setDoc(doc(db, 'saldos_cargo_motorizado', 'S3'), s({ estado: 'anulado' }))
    await setDoc(doc(db, 'saldos_cargo_motorizado', 'S4'), s({ estado: 'condonado', saldoPendiente: 0, montoOriginal: 50 }))
  })
}

test('FIN1D-R3 · saldos: el cliente no crea ni mueve un saldo (P1–P8: monto arbitrario, sobrepago, ajeno, anulado, condonado, reabrir, fabricar) ⇒ DENY, gestor y admin; leer sigue', async () => {
  await sembrarSaldos1d()
  const abono = (monto: number) => ({ monto, metodoAbono: 'transferencia', creadoPorUid: UID_GESTOR, fecha: Timestamp.now() })
  for (const uid of STAFF_UIDS) {
    const d = como(uid)
    await assertFails(updateDoc(doc(d, 'saldos_cargo_motorizado', 'S1'), { saldoPendiente: 0, estado: 'pagado', abonos: arrayUnion(abono(999)) })) // P1
    await assertFails(updateDoc(doc(d, 'saldos_cargo_motorizado', 'S1'), { saldoPendiente: -500, abonos: arrayUnion(abono(600)) })) // P2
    await assertFails(updateDoc(doc(d, 'saldos_cargo_motorizado', 'S2'), { saldoPendiente: 0, estado: 'pagado' })) // P3
    await assertFails(updateDoc(doc(d, 'saldos_cargo_motorizado', 'S3'), { saldoPendiente: 0, estado: 'pagado', abonos: arrayUnion(abono(50)) })) // P7a
    await assertFails(updateDoc(doc(d, 'saldos_cargo_motorizado', 'S4'), { saldoPendiente: 10, estado: 'abonado_parcial' })) // P7b
    await assertFails(updateDoc(doc(d, 'saldos_cargo_motorizado', 'S4'), { saldoPendiente: 5000, estado: 'pendiente', montoOriginal: 5000 })) // P8
    await assertFails(setDoc(doc(d, 'saldos_cargo_motorizado', 'n1-' + uid), { motorizadoId: 'mot1', montoOriginal: 1e6, saldoPendiente: 1e6, estado: 'pendiente', origen: 'liquidacion', liquidacionId: LIQ_ID, abonos: [] })) // CS1
    await assertFails(addDoc(collection(d, 'saldos_cargo_motorizado'), { motorizadoId: 'mot1', montoOriginal: 7, saldoPendiente: 7, estado: 'pendiente', origen: 'liquidacion', liquidacionId: LIQ_ID, abonos: [] })) // CS2
    await assertFails(deleteDoc(doc(d, 'saldos_cargo_motorizado', 'S1')))
  }
  for (const uid of [UID_MOTO, UID_DIGITADOR]) {
    await assertFails(updateDoc(doc(como(uid), 'saldos_cargo_motorizado', 'S1'), { saldoPendiente: 0 }))
    await assertFails(addDoc(collection(como(uid), 'saldos_cargo_motorizado'), { motorizadoId: 'mot1', montoOriginal: 1, saldoPendiente: 1, estado: 'pendiente', abonos: [] }))
  }
  // Control: leer sigue (staff, digitador y el motorizado dueño).
  await assertSucceeds(getDoc(doc(como(UID_GESTOR), 'saldos_cargo_motorizado', 'S1')))
  await assertSucceeds(getDoc(doc(como(UID_DIGITADOR), 'saldos_cargo_motorizado', 'S1')))
  await assertSucceeds(getDoc(doc(como(UID_MOTO), 'saldos_cargo_motorizado', 'S1')))
})

test('FIN1D-R4 · ledger POR TIPO: abono_deuda_motorizado, liquidacion_pago_efectivo y saldo_creado no se crean, editan, anulan ni reactivan desde el cliente, ni se disfrazan ⇒ DENY; el resto del ledger también (FIN-1E)', async () => {
  const mov = (tipo: string, extra: Record<string, unknown> = {}) => ({ tipo, monto: 100, at: serverTimestamp(), creadoPorUid: UID_GESTOR, creadoPorRol: 'gestor', descripcion: 'x', estado: 'activo', motorizadoId: 'mot1', ...extra })
  const tipos = ['abono_deuda_motorizado', 'liquidacion_pago_efectivo', 'saldo_creado'] as const
  await env.withSecurityRulesDisabled(async (ctx) => {
    const db = ctx.firestore()
    for (const t of tipos) await setDoc(doc(db, 'movimientos_financieros', 'r-' + t), { ...mov(t), at: new Date(), liquidacionId: LIQ_ID, saldoId: 'S1' })
    await setDoc(doc(db, 'movimientos_financieros', 'libre'), { ...mov('ajuste_manual'), at: new Date() })
  })
  for (const uid of STAFF_UIDS) {
    const d = como(uid)
    for (const t of tipos) {
      await assertFails(setDoc(doc(d, 'movimientos_financieros', `c-${t}-${uid}`), mov(t, { liquidacionId: LIQ_ID, saldoId: 'S1', cuentaOrigen: 'deuda_motorizado:mot1', cuentaDestino: 'recuperacion_deuda_liquidacion' }))) // P4/P5/PE1-PE3, PE6
      await assertFails(setDoc(doc(d, 'movimientos_financieros', `c2-${t}-${uid}`), mov(t, { monto: 1e6, creadoPorUid: 'uid_falso', creadoPorRol: 'admin' })))
      await assertFails(updateDoc(doc(d, 'movimientos_financieros', 'r-' + t), { monto: 7 })) // PE5
      await assertFails(updateDoc(doc(d, 'movimientos_financieros', 'r-' + t), { estado: 'anulado', anuladoPorUid: uid })) // PE4
      await assertFails(updateDoc(doc(d, 'movimientos_financieros', 'r-' + t), { tipo: 'ajuste_manual' })) // un reservado deja de serlo
      await assertFails(updateDoc(doc(d, 'movimientos_financieros', 'libre'), { tipo: t })) // otro se disfraza de reservado
      await assertFails(deleteDoc(doc(d, 'movimientos_financieros', 'r-' + t)))
    }
  }
  for (const uid of [UID_MOTO, UID_DIGITADOR]) await assertFails(setDoc(doc(como(uid), 'movimientos_financieros', 'x-' + uid), mov('liquidacion_pago_efectivo')))
  // Control (FIN-1E): el cierre es total — la misma forma de escritura, con un tipo libre, también es DENY.
  await assertFails(setDoc(doc(como(UID_GESTOR), 'movimientos_financieros', 'ctl'), mov('ajuste_manual')))
  await assertFails(updateDoc(doc(como(UID_ADMIN), 'movimientos_financieros', 'libre'), { descripcion: 'editada' }))
})

test('FIN1D-R5 · gastos: un gasto que una liquidación capturó (liquidacionId) NO se consume en un depósito; el cliente no escribe ni quita liquidacionId; un gasto libre sigue consumiéndose (FIN-2 intacto)', async () => {
  await sembrarGastosFin2({
    gLiq: { motorizadoId: 'mot1', estado: 'aprobado', monto: 10, tipo: 'peaje_terminal', liquidacionId: LIQ_ID },
  })
  for (const uid of [UID_MOTO, UID_GESTOR, UID_ADMIN]) {
    await assertFails(batchCrearDepositoConGastos(uid, 'DLiq-' + uid, ['gLiq']).commit())
  }
  assert.equal((await leerGastoFin2('gLiq'))?.consumidoEnDepositoId, undefined)
  // el cliente no marca ni desmarca la liquidación de un gasto
  for (const uid of STAFF_UIDS) {
    await assertFails(updateDoc(doc(como(uid), 'gastos_motorizado', 'g1'), { liquidacionId: LIQ_ID }))
    await assertFails(updateDoc(doc(como(uid), 'gastos_motorizado', 'gLiq'), { liquidacionId: deleteField() }))
    await assertFails(updateDoc(doc(como(uid), 'gastos_motorizado', 'gLiq'), { liquidacionId: 'otra' }))
  }
  // Control: un gasto libre se consume en el mismo commit que crea el depósito (FIN-2 sin regresión).
  await assertSucceeds(batchCrearDepositoConGastos(UID_MOTO, 'DLibre', ['g1']).commit())
  assert.equal((await leerGastoFin2('g1'))?.consumidoEnDepositoId, 'DLibre')
})

// ═════════════════════════════════════════════════════════════════════════════
// FIN-1E — cierre final del perímetro financiero
//
//  · movimientos_financieros es SOLO del servidor: create, update y delete son DENY para todo cliente, sin excepciones por tipo (L1–L14).
//  · Los inputs financieros de la orden (precioDesglose, tipoServicio, entregadoAt, historial.entregadoAt) y los punteros de depósito
//    (confirmado*, depositoId) no los escribe el cliente (O1–O8, P1–P6). La Function que marca la entrega usa el Admin SDK y no pasa por aquí.
// ═════════════════════════════════════════════════════════════════════════════

const TIPOS_LEDGER = [
  'gasto_aprobado', 'adelanto_motorizado', 'abono_deuda_motorizado', 'saldo_creado', 'liquidacion_pago_efectivo', 'pago_recibido',
  'deuda_condonada', 'deposito_convertido_en_deuda', 'deposito_efectivo_storkhub', 'deposito_efectivo_comercio', 'deposito_confirmado',
  'ajuste_manual', 'tipo_futuro_que_aun_no_existe',
] as const
const movLedger1e = (tipo: string, extra: Record<string, unknown> = {}) => ({
  tipo, monto: 100, estado: 'activo', saldoId: 'S1', motorizadoId: 'mot1', creadoPorUid: UID_GESTOR, creadoPorRol: 'gestor', descripcion: 'x', ...extra,
})
async function sembrarLedger1e() {
  await env.withSecurityRulesDisabled(async (ctx) => {
    for (const t of TIPOS_LEDGER) await setDoc(doc(ctx.firestore(), 'movimientos_financieros', 'm-' + t), movLedger1e(t, { at: new Date() }))
  })
}
async function ledgerIntacto1e() {
  for (const t of TIPOS_LEDGER) {
    const m = await leerDoc('movimientos_financieros', 'm-' + t)
    assert.equal(m?.monto, 100, 'el monto de ' + t + ' no cambió')
    assert.equal(m?.estado, 'activo', t + ' sigue activo')
    assert.equal(m?.tipo, t, 'el tipo de ' + t + ' no cambió')
  }
}

test('FIN1E-L1 · CREATE de cualquier tipo del ledger (los 11 reales, ajuste_manual y un tipo futuro) por gestor y admin con setDoc ⇒ DENY', async () => {
  for (const uid of STAFF_UIDS) {
    for (const t of TIPOS_LEDGER) await assertFails(setDoc(doc(como(uid), 'movimientos_financieros', `c-${t}-${uid}`), movLedger1e(t, { at: serverTimestamp() })))
  }
})

test('FIN1E-L2 · CREATE con addDoc (id automático) ⇒ DENY; en particular un pago_recibido fabricado (C6) ⇒ DENY', async () => {
  for (const uid of STAFF_UIDS) {
    await assertFails(addDoc(collection(como(uid), 'movimientos_financieros'), movLedger1e('pago_recibido', { solicitudId: 'x', monto: 1e6, at: serverTimestamp() })))
    await assertFails(addDoc(collection(como(uid), 'movimientos_financieros'), movLedger1e('ajuste_manual', { at: serverTimestamp() })))
  }
})

test('FIN1E-L3 · CREATE dentro de un writeBatch ⇒ DENY, y el batch entero falla (la nota interna del mismo batch tampoco se aplica)', async () => {
  const id = await ordenConCodigo('l3', { estado: 'entregado' })
  for (const uid of STAFF_UIDS) {
    const db = como(uid)
    const b = writeBatch(db)
    b.set(doc(db, 'movimientos_financieros', 'b-' + uid), movLedger1e('pago_recibido', { at: serverTimestamp() }))
    b.update(doc(db, 'solicitudes_envio', id), { notaInterna: 'no debería aplicarse' })
    await assertFails(b.commit())
  }
  assert.equal((await leerDoc('solicitudes_envio', id))?.notaInterna, undefined)
})

test('FIN1E-L4 · UPDATE de monto, de estado/anulación, de tipo y de descripción sobre cualquier tipo ⇒ DENY; el ledger no cambia', async () => {
  await sembrarLedger1e()
  for (const uid of STAFF_UIDS) {
    for (const t of TIPOS_LEDGER) {
      await assertFails(updateDoc(doc(como(uid), 'movimientos_financieros', 'm-' + t), { monto: 1 }))
      await assertFails(updateDoc(doc(como(uid), 'movimientos_financieros', 'm-' + t), { estado: 'anulado', anuladoPorUid: uid, anuladoAt: serverTimestamp(), motivoAnulacion: 'x' }))
      await assertFails(updateDoc(doc(como(uid), 'movimientos_financieros', 'm-' + t), { tipo: 'pago_recibido' }))
      await assertFails(updateDoc(doc(como(uid), 'movimientos_financieros', 'm-' + t), { descripcion: 'editada' }))
    }
  }
  await ledgerIntacto1e()
})

test('FIN1E-L5 · DELETE de cualquier tipo, suelto o en batch ⇒ DENY; todos siguen ahí', async () => {
  await sembrarLedger1e()
  for (const uid of STAFF_UIDS) {
    for (const t of TIPOS_LEDGER) await assertFails(deleteDoc(doc(como(uid), 'movimientos_financieros', 'm-' + t)))
    const db = como(uid)
    const b = writeBatch(db)
    b.delete(doc(db, 'movimientos_financieros', 'm-pago_recibido'))
    await assertFails(b.commit())
  }
  await ledgerIntacto1e()
})

test('FIN1E-L6 · setDoc con merge sobre un movimiento existente ⇒ DENY (no es un camino de update disfrazado)', async () => {
  await sembrarLedger1e()
  for (const uid of STAFF_UIDS) await assertFails(setDoc(doc(como(uid), 'movimientos_financieros', 'm-ajuste_manual'), { monto: 7, estado: 'anulado' }, { merge: true }))
  await ledgerIntacto1e()
})

test('FIN1E-L7 · digitador, motorizado, comercio, cliente y anónimo tampoco escriben el ledger (create, update, delete) ⇒ DENY', async () => {
  await sembrarLedger1e()
  const clientes = [como(UID_DIGITADOR), como(UID_MOTO), como(UID_COMERCIO), como(UID_CLIENTE), env.unauthenticatedContext().firestore()]
  for (const db of clientes) {
    await assertFails(setDoc(doc(db, 'movimientos_financieros', 'x-' + Math.random()), movLedger1e('pago_recibido', { at: serverTimestamp() })))
    await assertFails(updateDoc(doc(db, 'movimientos_financieros', 'm-ajuste_manual'), { monto: 1 }))
    await assertFails(deleteDoc(doc(db, 'movimientos_financieros', 'm-ajuste_manual')))
  }
  await ledgerIntacto1e()
})

test('FIN1E-L8 · una subcolección bajo un movimiento tampoco se abre: no hay wildcard que la cubra ⇒ DENY', async () => {
  await sembrarLedger1e()
  for (const uid of STAFF_UIDS) await assertFails(setDoc(doc(como(uid), 'movimientos_financieros', 'm-ajuste_manual', 'sub', 's1'), { x: 1 }))
})

test('FIN1E-L9 · el cliente no reabre el ledger por otra colección: un collectionGroup de escritura no existe en las Rules, y adelantos_motorizado (legacy) queda cerrado ⇒ DENY', async () => {
  const reglas = readFileSync('firestore.rules', 'utf8').replace(/\r\n/g, '\n')
  assert.ok(!/match \/\{[a-zA-Z_]+=\*\*\}/.test(reglas), 'sin wildcard recursivo (ni collectionGroup) en ninguna parte')
  assert.equal((reglas.match(/movimientos_financieros/g) ?? []).filter(() => true).length >= 1, true)
  await env.withSecurityRulesDisabled(async (ctx) => {
    await setDoc(doc(ctx.firestore(), 'adelantos_motorizado', 'adL'), { motorizadoUid: UID_MOTO, motorizadoId: 'mot1', monto: 50 })
  })
  for (const uid of STAFF_UIDS) {
    await assertFails(setDoc(doc(como(uid), 'adelantos_motorizado', 'nuevo-' + uid), { motorizadoUid: UID_MOTO, motorizadoId: 'mot1', monto: 1e6 }))
    await assertFails(updateDoc(doc(como(uid), 'adelantos_motorizado', 'adL'), { monto: 1 }))
    await assertFails(deleteDoc(doc(como(uid), 'adelantos_motorizado', 'adL')))
    await assertSucceeds(getDoc(doc(como(uid), 'adelantos_motorizado', 'adL')))
  }
  await assertSucceeds(getDoc(doc(como(UID_MOTO), 'adelantos_motorizado', 'adL')))
  assert.equal((await leerDoc('adelantos_motorizado', 'adL'))?.monto, 50)
})

test('FIN1E-L10 · estructura: un solo match del ledger, create/update/delete literalmente false, y tipoReservadoAServidor ya no existe', () => {
  const reglas = readFileSync('firestore.rules', 'utf8').replace(/\r\n/g, '\n')
  assert.equal((reglas.match(/match \/movimientos_financieros\/\{[a-zA-Z]+\}/g) ?? []).length, 1)
  const i = reglas.indexOf('match /movimientos_financieros/{id}')
  const bloque = reglas.slice(i, reglas.indexOf('\n    }\n', i))
  const allows = bloque.split('\n').filter((l) => /^\s*allow /.test(l)).map((l) => l.trim())
  assert.deepEqual(allows, ['allow read: if isAdminOrGestor();', 'allow create, update, delete: if false;'])
  assert.ok(!/tipoReservadoAServidor/.test(reglas), 'la lista de tipos reservados ya no es el control: el ledger nace cerrado')
})

test('FIN1E-L11 · CONTROL: gestor y admin siguen LEYENDO el ledger (get y list) ⇒ ALLOW; digitador, motorizado y comercio no ⇒ DENY', async () => {
  await sembrarLedger1e()
  for (const uid of STAFF_UIDS) {
    await assertSucceeds(getDoc(doc(como(uid), 'movimientos_financieros', 'm-pago_recibido')))
    await assertSucceeds(getDocs(query(collection(como(uid), 'movimientos_financieros'), limit(5))))
  }
  for (const uid of [UID_DIGITADOR, UID_MOTO, UID_COMERCIO]) await assertFails(getDoc(doc(como(uid), 'movimientos_financieros', 'm-pago_recibido')))
})

// ─── Órdenes · inputs financieros inmutables desde el cliente ────────────────

const TS_ENTREGA = Timestamp.fromDate(new Date('2026-09-30T15:00:00Z'))
async function sembrarOrdenFin1e(id: string, extra: Record<string, unknown> = {}) {
  await env.withSecurityRulesDisabled(async (ctx) => {
    // `undefined` en extra = el campo NO existe en la orden sembrada (ausente, no null).
    const doc1e: Record<string, unknown> = {
      ...ordenBase({
        estado: 'en_camino_entrega',
        asignacion: { motorizadoAuthUid: UID_MOTO, motorizadoId: 'mot1', motorizadoNombre: 'John Pork', estadoAceptacion: 'aceptada' },
      }),
      codigo: 'SH-2001', secuencia: 2001,
      precioDesglose: { deliveryBase: 80, extraKm: 10 }, tipoServicio: 'estandar',
      entregadoAt: TS_ENTREGA, historial: { entregadoAt: TS_ENTREGA, creadaAt: TS_ENTREGA },
      registro: { deposito: { storkhubDepositoId: 'DEPX', confirmadoStorkhub: false, comercioDepositoId: 'DEPC', confirmadoComercio: false } },
      ...extra,
    }
    for (const k of Object.keys(doc1e)) if (doc1e[k] === undefined) delete doc1e[k]
    await setDoc(doc(ctx.firestore(), 'solicitudes_envio', id), doc1e)
  })
  return id
}

test('FIN1E-O1 · staff: precioDesglose no cambia, no se borra, no se completa y no se anida (el comisión del motorizado sale de aquí) ⇒ DENY', async () => {
  const id = await sembrarOrdenFin1e('o1')
  const sinP = await sembrarOrdenFin1e('o1b', { precioDesglose: undefined })
  for (const uid of STAFF_UIDS) {
    await assertFails(updateDoc(ordenRef(uid, id), { 'precioDesglose.deliveryBase': 1 }))
    await assertFails(updateDoc(ordenRef(uid, id), { precioDesglose: { deliveryBase: 9999 } }))
    await assertFails(updateDoc(ordenRef(uid, id), { precioDesglose: deleteField() }))
    await assertFails(updateDoc(ordenRef(uid, sinP), { precioDesglose: { deliveryBase: 1 } }))                                  // ausente → valor
  }
  assert.deepEqual((await leerDoc('solicitudes_envio', id))?.precioDesglose, { deliveryBase: 80, extraKm: 10 })
})

test('FIN1E-O2 · staff: tipoServicio no cambia ni se borra ⇒ DENY', async () => {
  const id = await sembrarOrdenFin1e('o2')
  for (const uid of STAFF_UIDS) {
    await assertFails(updateDoc(ordenRef(uid, id), { tipoServicio: 'express' }))
    await assertFails(updateDoc(ordenRef(uid, id), { tipoServicio: deleteField() }))
  }
  assert.equal((await leerDoc('solicitudes_envio', id))?.tipoServicio, 'estandar')
})

test('FIN1E-O3 · staff: entregadoAt (la semana de liquidación) no cambia, no se borra y no nace desde el cliente ⇒ DENY', async () => {
  const id = await sembrarOrdenFin1e('o3')
  const sin = await sembrarOrdenFin1e('o3b', { entregadoAt: undefined, historial: {} })
  for (const uid of STAFF_UIDS) {
    await assertFails(updateDoc(ordenRef(uid, id), { entregadoAt: Timestamp.fromDate(new Date('2026-10-05T10:00:00Z')) }))
    await assertFails(updateDoc(ordenRef(uid, id), { entregadoAt: deleteField() }))
    await assertFails(updateDoc(ordenRef(uid, sin), { entregadoAt: serverTimestamp() }))
  }
  assert.deepEqual((await leerDoc('solicitudes_envio', id))?.entregadoAt, TS_ENTREGA)
})

test('FIN1E-O4 · staff: historial.entregadoAt — ausente→valor, valor→otro y valor→ausente ⇒ DENY; el resto del historial sí se escribe ⇒ ALLOW', async () => {
  const id = await sembrarOrdenFin1e('o4')
  const sin = await sembrarOrdenFin1e('o4b', { historial: { creadaAt: TS_ENTREGA } })
  for (const uid of STAFF_UIDS) {
    await assertFails(updateDoc(ordenRef(uid, sin), { 'historial.entregadoAt': serverTimestamp() }))                                  // ausente → valor
    await assertFails(updateDoc(ordenRef(uid, id), { 'historial.entregadoAt': Timestamp.fromDate(new Date('2026-10-05T10:00:00Z')) })) // valor → otro
    await assertFails(updateDoc(ordenRef(uid, id), { 'historial.entregadoAt': deleteField() }))                                       // valor → ausente
    await assertFails(updateDoc(ordenRef(uid, id), { historial: { creadaAt: TS_ENTREGA } }))                                          // reemplazar el mapa entero
    await assertSucceeds(updateDoc(ordenRef(uid, id), { 'historial.nota': 'otro campo del historial', updatedAt: serverTimestamp() })) // control
  }
  assert.deepEqual((await leerDoc('solicitudes_envio', id) as { historial: { entregadoAt: unknown } }).historial.entregadoAt, TS_ENTREGA)
})

test('FIN1E-O5 · staff: confirmadoStorkhub/At y confirmadoComercio/At (la confirmación del depósito es de la callable) ⇒ DENY, en cualquier sentido', async () => {
  const id = await sembrarOrdenFin1e('o5')
  for (const uid of STAFF_UIDS) {
    for (const campo of ['confirmadoStorkhub', 'confirmadoComercio']) {
      await assertFails(updateDoc(ordenRef(uid, id), { [`registro.deposito.${campo}`]: true }))
      await assertFails(updateDoc(ordenRef(uid, id), { [`registro.deposito.${campo}At`]: serverTimestamp() }))
      await assertFails(updateDoc(ordenRef(uid, id), { [`registro.deposito.${campo}`]: deleteField() }))
    }
  }
  assert.equal(((await leerDoc('solicitudes_envio', id)) as { registro: { deposito: { confirmadoStorkhub: boolean } } }).registro.deposito.confirmadoStorkhub, false)
})

test('FIN1E-O6 · staff: un depositoId ya fijado no se reemplaza ni se borra (aunque el nuevo depósito exista y liste la orden) ⇒ DENY', async () => {
  const id = await sembrarOrdenFin1e('o6')
  await env.withSecurityRulesDisabled(async (ctx) => {
    await setDoc(doc(ctx.firestore(), 'ordenes_deposito', 'DEPY'), { ...depositoBase({ estado: 'en_revision', solicitudIds: [id] }), codigo: 'DEP-0009', secuencia: 9 })
  })
  for (const uid of STAFF_UIDS) {
    await assertFails(updateDoc(ordenRef(uid, id), { 'registro.deposito.storkhubDepositoId': 'DEPY' }))
    await assertFails(updateDoc(ordenRef(uid, id), { 'registro.deposito.storkhubDepositoId': deleteField() }))
    await assertFails(updateDoc(ordenRef(uid, id), { 'registro.deposito.comercioDepositoId': null }))
  }
  assert.equal(((await leerDoc('solicitudes_envio', id)) as { registro: { deposito: { storkhubDepositoId: string } } }).registro.deposito.storkhubDepositoId, 'DEPX')
})

test('FIN1E-O7 · motorizado: entregadoAt y historial.entregadoAt ya no los escribe él (cierra OC1: mover su orden de semana) ⇒ DENY; sus campos legítimos siguen ⇒ ALLOW', async () => {
  const id = await sembrarOrdenFin1e('o7')
  const sin = await sembrarOrdenFin1e('o7b', { entregadoAt: undefined, historial: {} })
  await assertFails(updateDoc(ordenRef(UID_MOTO, id), { entregadoAt: Timestamp.fromDate(new Date('2026-10-05T10:00:00Z')), updatedAt: serverTimestamp() }))
  await assertFails(updateDoc(ordenRef(UID_MOTO, id), { entregadoAt: deleteField() }))
  await assertFails(updateDoc(ordenRef(UID_MOTO, sin), { entregadoAt: serverTimestamp(), updatedAt: serverTimestamp() }))
  await assertFails(updateDoc(ordenRef(UID_MOTO, id), { 'historial.entregadoAt': Timestamp.fromDate(new Date('2026-10-05T10:00:00Z')) }))
  await assertFails(updateDoc(ordenRef(UID_MOTO, id), { 'historial.entregadoAt': deleteField() }))
  await assertFails(updateDoc(ordenRef(UID_MOTO, sin), { 'historial.entregadoAt': serverTimestamp() }))
  await assertFails(updateDoc(ordenRef(UID_MOTO, id), { 'registro.deposito.confirmadoStorkhub': true }))
  await assertSucceeds(updateDoc(ordenRef(UID_MOTO, id), { evidencias: { entrega: 'https://example.test/e.jpg' }, updatedAt: serverTimestamp() }))
  assert.deepEqual((await leerDoc('solicitudes_envio', id))?.entregadoAt, TS_ENTREGA)
})

test('FIN1E-O8 · CONTROL logístico: la orden NO quedó inmutable — notas, metadatos y avisos del flujo siguen ⇒ ALLOW (staff y motorizado)', async () => {
  const id = await sembrarOrdenFin1e('o8')
  for (const uid of STAFF_UIDS) {
    await assertSucceeds(updateDoc(ordenRef(uid, id), { notaInterna: 'llamar antes de llegar ' + uid, updatedAt: serverTimestamp() }))
    await assertSucceeds(updateDoc(ordenRef(uid, id), { 'metadata.prioridad': 'alta', updatedAt: serverTimestamp() }))
  }
  await assertSucceeds(updateDoc(ordenRef(UID_MOTO, id), { evidencias: { retiro: 'https://example.test/r.jpg' }, updatedAt: serverTimestamp() }))
})

// ─── Punteros de depósito: solo hacia un depósito real que lista la orden ────

test('FIN1E-P1 · RUTA LEGÍTIMA: gestor y admin pasan el depósito a en_revision y fijan el puntero en SUS órdenes en un batch (getAfter lo respalda) ⇒ ALLOW, el puntero queda', async () => {
  for (const [uid, destino] of [[UID_GESTOR, 'storkhub'], [UID_ADMIN, 'comercio']] as const) {
    await sembrarMaterializacion(destino)
    await assertSucceeds(batchMaterializar(uid, destino).commit())
    const campo = destino === 'storkhub' ? 'storkhubDepositoId' : 'comercioDepositoId'
    for (const o of [ORDEN_D, 'ordD2']) {
      assert.equal(((await leerDoc('solicitudes_envio', o)) as { registro: { deposito: Record<string, unknown> } }).registro.deposito[campo], 'depD')
    }
  }
})

test('FIN1E-P2 · puntero hacia un depósito que NO lista la orden, hacia uno inexistente o con otro destinatario ⇒ DENY', async () => {
  await sembrarDigitacion({ destinatario: 'storkhub', solicitudIds: ['otraOrden'] })
  await assertFails(updateDoc(doc(como(UID_GESTOR), 'solicitudes_envio', ORDEN_D), camposEnlaceDigitacion('storkhub', 'depD')))        // no lista la orden
  await assertFails(updateDoc(doc(como(UID_GESTOR), 'solicitudes_envio', ORDEN_D), camposEnlaceDigitacion('storkhub', 'depNoExiste'))) // inexistente
  await sembrarDigitacion({ destinatario: 'comercio', solicitudIds: [ORDEN_D] })
  await assertFails(updateDoc(doc(como(UID_ADMIN), 'solicitudes_envio', ORDEN_D), camposEnlaceDigitacion('storkhub', 'depD')))         // destinatario comercio, puntero storkhub
  assert.equal(((await leerDoc('solicitudes_envio', ORDEN_D)) as { registro?: unknown }).registro, undefined)
})

test('FIN1E-P3 · puntero hacia un depósito ya confirmado/anulado (no espera comprobante ni está en revisión) ⇒ DENY', async () => {
  for (const depEstado of ['confirmado', 'anulado', 'convertido_en_deuda']) {
    await sembrarDigitacion({ destinatario: 'storkhub', depEstado })
    await assertFails(updateDoc(doc(como(UID_GESTOR), 'solicitudes_envio', ORDEN_D), camposEnlaceDigitacion('storkhub', 'depD')))
  }
})

test('FIN1E-P4 · una vez fijado, el puntero es inmutable desde el cliente: otro id, null o borrarlo ⇒ DENY (liberarlo es del servidor)', async () => {
  await sembrarDigitacion({ destinatario: 'storkhub', depEstado: 'en_revision', registro: { deposito: { storkhubDepositoId: 'depD' } } })
  await env.withSecurityRulesDisabled(async (ctx) => {
    await setDoc(doc(ctx.firestore(), 'ordenes_deposito', 'depE'), { ...depositoBase({ estado: 'en_revision', solicitudIds: [ORDEN_D] }), codigo: 'DEP-0010', secuencia: 10 })
  })
  for (const uid of STAFF_UIDS) {
    await assertFails(updateDoc(doc(como(uid), 'solicitudes_envio', ORDEN_D), { 'registro.deposito.storkhubDepositoId': 'depE' }))
    await assertFails(updateDoc(doc(como(uid), 'solicitudes_envio', ORDEN_D), { 'registro.deposito.storkhubDepositoId': null }))
    await assertFails(updateDoc(doc(como(uid), 'solicitudes_envio', ORDEN_D), { 'registro.deposito.storkhubDepositoId': deleteField() }))
  }
})

test('FIN1E-P5 · motorizado: fija el puntero SOLO hacia su propio depósito que lista la orden ⇒ ALLOW; hacia el de otro motorizado ⇒ DENY', async () => {
  await env.withSecurityRulesDisabled(async (ctx) => {
    const db = ctx.firestore()
    await setDoc(doc(db, 'solicitudes_envio', 'pm1'), { ...ordenBase({ estado: 'entregado', asignacion: { motorizadoAuthUid: UID_MOTO, motorizadoNombre: 'John Pork', estadoAceptacion: 'aceptada' } }), codigo: 'SH-3001', secuencia: 3001 })
    await setDoc(doc(db, 'solicitudes_envio', 'pm2'), { ...ordenBase({ estado: 'entregado', asignacion: { motorizadoAuthUid: UID_MOTO, motorizadoNombre: 'John Pork', estadoAceptacion: 'aceptada' } }), codigo: 'SH-3002', secuencia: 3002 })
    await setDoc(doc(db, 'ordenes_deposito', 'depMio'), { ...depositoBase({ estado: 'en_revision', solicitudIds: ['pm1'], motorizadoUid: UID_MOTO }), codigo: 'DEP-0020', secuencia: 20 })
    await setDoc(doc(db, 'ordenes_deposito', 'depAjeno'), { ...depositoBase({ estado: 'en_revision', solicitudIds: ['pm2'], motorizadoUid: UID_MOTO_B }), codigo: 'DEP-0021', secuencia: 21 })
  })
  await assertFails(updateDoc(ordenRef(UID_MOTO, 'pm2'), { 'registro.deposito.storkhubDepositoId': 'depAjeno', updatedAt: serverTimestamp() }))
  await assertFails(updateDoc(ordenRef(UID_MOTO, 'pm2'), { 'registro.deposito.storkhubDepositoId': 'depMio', updatedAt: serverTimestamp() })) // el suyo, pero no lista pm2
  await assertSucceeds(updateDoc(ordenRef(UID_MOTO, 'pm1'), { 'registro.deposito.storkhubDepositoId': 'depMio', updatedAt: serverTimestamp() }))
})

test('FIN1E-P6 · el digitador conserva su ruta de enlace (sin regresión) y no puede tocar confirmado* ⇒ ALLOW / DENY', async () => {
  await sembrarDigitacion({ destinatario: 'storkhub' })
  await assertSucceeds(batchDigitacion('storkhubDepositoId'))
  await sembrarDigitacion({ destinatario: 'storkhub' })
  await assertFails(updateDoc(doc(como(UID_DIGITADOR), 'solicitudes_envio', ORDEN_D), { 'registro.deposito.confirmadoStorkhub': true }))
})

// ═════════════════════════════════════════════════════════════════════════════
// PRECIO-CONFIRMADO-ANTES-DE-OPERAR-1 — el precio que decide el servidor no nace de un cliente
//
//  · `confirmacion` (precio final + base de la comisión) la escribe SOLO asignarMotorizado; `entregadoAt` e `historial.entregadoAt` SOLO la Function de entrega.
//    FIN-1E cerró editarlos después de crear; esto cierra plantarlos AL crear, para todo rol que crea órdenes.
//  · El preview (precioDesglose, cotizacion, pagoDelivery.montoSugerido) sigue siendo del cliente: nada financiero lo toma como autoridad.
// ═════════════════════════════════════════════════════════════════════════════

const CREADORES_PRECIO = [['comercio', UID_COMERCIO], ['gestor', UID_GESTOR], ['admin', UID_ADMIN]] as const
const previewValido = () => ({
  tipoServicio: 'normal',
  precioDesglose: { deliveryBase: 150, recargoZona: 0, recargoServicio: 0, totalCobrado: 150 },
  cotizacion: { distanciaKm: 13.859, precioSugerido: 150 },
  pagoDelivery: { tipo: 'contado', quienPaga: 'entrega', montoSugerido: 150 },
})
const ordenPersonalPrecio = (extra: Record<string, unknown> = {}) => ({
  userId: UID_CLIENTE, comercioUid: UID_CLIENTE, ownerSnapshot: { uid: UID_CLIENTE, nombre: 'Cliente' },
  estado: 'pendiente_confirmacion', tipoCliente: 'contado', createdAt: serverTimestamp(), ...previewValido(), ...extra,
})

test('FIN1F-R1 · crear una orden normal con su preview (precioDesglose, cotizacion, montoSugerido) y un historial sin fecha de entrega ⇒ ALLOW (comercio, cliente, gestor, admin)', async () => {
  for (const [rol, uid] of CREADORES_PRECIO) {
    await assertSucceeds(nacer(uid, `p1_${rol}`, ordenBase({ ...previewValido() })))
    await assertSucceeds(nacer(uid, `p1h_${rol}`, ordenBase({ ...previewValido(), historial: { creadaAt: serverTimestamp() } })))
  }
  await assertSucceeds(nacer(UID_CLIENTE, 'p1_cliente', ordenPersonalPrecio()))
})

test('FIN1F-R2 · crear con `confirmacion` plantada (solo el precio, completa, vacía o null) ⇒ DENY para todo rol', async () => {
  const plantas = [
    { confirmacion: { precioFinalCordobas: 1 } },
    { confirmacion: { precioFinalCordobas: 1, comisionBaseCordobas: 99999, comisionBaseOrigen: 'tarifa_distancia', confirmadoPorUid: UID_COMERCIO, confirmadoAt: serverTimestamp() } },
    { confirmacion: {} },
    { confirmacion: null },
  ]
  for (const [rol, uid] of CREADORES_PRECIO) {
    for (const [i, planta] of plantas.entries()) await assertFails(nacer(uid, `p2_${rol}_${i}`, ordenBase({ ...previewValido(), ...planta })))
  }
  for (const [i, planta] of plantas.entries()) await assertFails(nacer(UID_CLIENTE, `p2_cliente_${i}`, ordenPersonalPrecio(planta)))
})

test('FIN1F-R3 · crear con `entregadoAt` plantado ⇒ DENY para todo rol', async () => {
  for (const [rol, uid] of CREADORES_PRECIO) {
    await assertFails(nacer(uid, `p3_${rol}`, ordenBase({ entregadoAt: serverTimestamp() })))
    await assertFails(nacer(uid, `p3n_${rol}`, ordenBase({ entregadoAt: null })))
  }
  await assertFails(nacer(UID_CLIENTE, 'p3_cliente', ordenPersonalPrecio({ entregadoAt: Timestamp.fromDate(new Date('2026-09-01T10:00:00Z')) })))
})

test('FIN1F-R4 · crear con `historial.entregadoAt` plantado ⇒ DENY para todo rol; el resto del historial sí se escribe', async () => {
  for (const [rol, uid] of CREADORES_PRECIO) {
    await assertFails(nacer(uid, `p4_${rol}`, ordenBase({ historial: { entregadoAt: serverTimestamp() } })))
    await assertFails(nacer(uid, `p4b_${rol}`, ordenBase({ historial: { creadaAt: serverTimestamp(), entregadoAt: null } })))
  }
  await assertFails(nacer(UID_CLIENTE, 'p4_cliente', ordenPersonalPrecio({ historial: { entregadoAt: serverTimestamp() } })))
  await assertSucceeds(nacer(UID_COMERCIO, 'p4_ok', ordenBase({ historial: { creadaAt: serverTimestamp(), nota: 'x' } })))
})

test('FIN1F-R5 · después de crear, el precio sigue protegido: staff no escribe confirmacion, precioDesglose ni el estado de asignación ⇒ DENY; el preview no cambia', async () => {
  const id = await ordenConCodigo('p5', { ...previewValido(), estado: 'pendiente_confirmacion' })
  for (const uid of STAFF_UIDS) {
    await assertFails(updateDoc(doc(como(uid), 'solicitudes_envio', id), { confirmacion: { precioFinalCordobas: 1, comisionBaseCordobas: 99999 }, updatedAt: serverTimestamp() }))
    await assertFails(updateDoc(doc(como(uid), 'solicitudes_envio', id), { 'confirmacion.comisionBaseCordobas': 99999 }))
    await assertFails(updateDoc(doc(como(uid), 'solicitudes_envio', id), { 'precioDesglose.deliveryBase': 99999 }))
    await assertFails(updateDoc(doc(como(uid), 'solicitudes_envio', id), { 'pagoDelivery.montoSugerido': 99999 }))
  }
  assert.equal(((await leerDoc('solicitudes_envio', id)) as { precioDesglose: { deliveryBase: number } }).precioDesglose.deliveryBase, 150)
  assert.equal((await leerDoc('solicitudes_envio', id))?.confirmacion, undefined)
})

test('FIN1F-R6 · asignar NO es del cliente: pasar a asignada con una asignación fabricada, con o sin precio, ⇒ DENY (asignarMotorizado exige el precio cerrado; ver FIN1F-F5/F7)', async () => {
  const sin = await ordenConCodigo('p6a', { ...previewValido(), estado: 'confirmada' })
  for (const uid of STAFF_UIDS) {
    await assertFails(updateDoc(doc(como(uid), 'solicitudes_envio', sin), { estado: 'asignada', asignacion: { motorizadoAuthUid: UID_MOTO, motorizadoNombre: 'X', estadoAceptacion: 'aceptada' }, updatedAt: serverTimestamp() }))
    await assertFails(updateDoc(doc(como(uid), 'solicitudes_envio', sin), { estado: 'asignada', updatedAt: serverTimestamp() }))
  }
  assert.equal((await leerDoc('solicitudes_envio', sin))?.estado, 'confirmada')
  // control: lo que NO toca el precio sigue siendo del staff (FIN-1E no quedó inmutable)
  await assertSucceeds(updateDoc(doc(como(UID_GESTOR), 'solicitudes_envio', sin), { notaInterna: 'llamar antes', updatedAt: serverTimestamp() }))
})
