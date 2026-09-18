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
  collection, query, where, limit, getDocs, writeBatch, deleteDoc,
} from 'firebase/firestore'

// Identidades del arnés. El rol de comercio es 'Comercio' con mayúscula: así
// está en las reglas y así se escribe en `usuarios`.
const UID_COMERCIO = 'uid_comercio'
const UID_GESTOR = 'uid_gestor'
const UID_MOTO = 'uid_moto'
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
    await setDoc(doc(db, 'usuarios', UID_DIGITADOR), { activo: true, rol: 'digitador' })
    await setDoc(doc(db, 'comercios', COMERCIO_ID), { name: 'Mariposita', authUid: UID_COMERCIO })
  })
})

const como = (uid: string) => env.authenticatedContext(uid).firestore()

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

test('J2 · el motorizado asignado sigue pudiendo entregar, y no puede tocar el codigo', async () => {
  const id = await ordenConCodigo('ordMoto', {
    estado: 'en_camino_entrega',
    asignacion: { motorizadoAuthUid: UID_MOTO, motorizadoNombre: 'John Pork' },
  })
  // Su allowlist de raíz ya deja fuera codigo/secuencia: el ALLOW normal
  // demuestra que no se rompió, y el DENY que la allowlist sigue cerrando.
  await assertSucceeds(updateDoc(doc(como(UID_MOTO), 'solicitudes_envio', id), {
    estado: 'entregado',
    entregadoAt: serverTimestamp(),
    updatedAt: serverTimestamp(),
  }))
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

test('N · gestor confirma un depósito sin tocar la identidad ⇒ ALLOW', async () => {
  const id = await depositoConCodigo()
  await assertSucceeds(updateDoc(doc(como(UID_GESTOR), 'ordenes_deposito', id), {
    estado: 'confirmado',
    boucher: { url: 'https://example.test/b.jpg', pathStorage: 'x' },
  }))
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

test('W1 · gestor confirma un depósito registrado en nombre del motorizado, con quién y cuándo ⇒ ALLOW', async () => {
  const id = await depositoConCodigo('depW1', { estado: 'pendiente_boucher' })
  await assertSucceeds(updateDoc(doc(como(UID_GESTOR), 'ordenes_deposito', id), {
    boucher: { url: 'https://example.test/b.jpg', pathStorage: 'x' },
    estado: 'confirmado',
    confirmadoPorUid: UID_GESTOR,
    confirmadoAt: serverTimestamp(),
  }))
})

test('W2 · gestor registra el pago del delivery por transferencia junto con la confirmación del cobro ⇒ ALLOW', async () => {
  // COBROS-PAGO-INTEGRIDAD-1: un DEP tipo C ya no nace suelto. Es la forma
  // real de BoucherModal/PagoContadoModal: DEP + orden pagada, en una escritura.
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
  await assertSucceeds(b.commit())
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

test('Z1 · admin rehace: depósito a en_revision y la orden pierde la confirmación ⇒ ALLOW', async () => {
  await sembrarDigitacion({
    depEstado: 'confirmado',
    registro: { deposito: { storkhubDepositoId: 'depD', confirmadoStorkhub: true, confirmadoStorkhubAt: new Date() } },
  })
  const db = como(UID_ADMIN)
  const b = writeBatch(db)
  b.set(doc(db, 'ordenes_deposito', 'depD'), { estado: 'en_revision' }, { merge: true })
  b.update(doc(db, 'solicitudes_envio', ORDEN_D), {
    'registro.deposito.storkhubDepositoId': 'depD',
    'registro.deposito.confirmadoStorkhub': false,
    'registro.deposito.confirmadoStorkhubAt': null,
  })
  await assertSucceeds(b.commit())
})

test('Z2 · admin elimina el depósito y libera la orden en el mismo batch ⇒ ALLOW', async () => {
  await sembrarDigitacion({
    depEstado: 'confirmado',
    registro: { deposito: { storkhubDepositoId: 'depD', confirmadoStorkhub: true, confirmadoStorkhubAt: new Date() } },
  })
  const db = como(UID_ADMIN)
  const b = writeBatch(db)
  b.delete(doc(db, 'ordenes_deposito', 'depD'))
  b.update(doc(db, 'solicitudes_envio', ORDEN_D), {
    'registro.deposito.storkhubDepositoId': null,
    'registro.deposito.confirmadoStorkhub': false,
    'registro.deposito.confirmadoStorkhubAt': null,
  })
  await assertSucceeds(b.commit())
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
  await assertFails(updateDoc(doc(db, 'ordenes_deposito', 'depI'), { boucher: deleteField() }))
  await depositoEn('confirmado', { tipo: 'pago_delivery_deposito', boucherUrl: 'https://example.test/c.jpg' })
  await assertFails(updateDoc(doc(db, 'ordenes_deposito', 'depI'), { boucherUrl: 'https://example.test/otro.jpg' }))
  await depositoEn('confirmado')
  await assertFails(updateDoc(doc(db, 'ordenes_deposito', 'depI'), { estado: 'en_revision', ...NUEVO_BOUCHER }))
})

test('BI4 · gestor reemplaza el boucher de un depósito en revisión ⇒ ALLOW (sin regresión)', async () => {
  await depositoEn('en_revision')
  await assertSucceeds(updateDoc(doc(como(UID_GESTOR), 'ordenes_deposito', 'depI'), NUEVO_BOUCHER))
})

test('BI5 · gestor anula un DEP tipo C confirmado sin tocar su comprobante ⇒ ALLOW', async () => {
  await depositoEn('confirmado', { tipo: 'pago_delivery_deposito', boucherUrl: 'https://example.test/c.jpg' })
  await assertSucceeds(updateDoc(doc(como(UID_GESTOR), 'ordenes_deposito', 'depI'), {
    estado: 'anulado',
    anuladoAt: serverTimestamp(),
    anuladoPorUid: UID_GESTOR,
    motivoAnulacion: 'Reversión de cobro contado por gestor',
  }))
})

test('BI6 · admin rehace un confirmado (solo estado) ⇒ ALLOW; después sí puede reemplazar ⇒ ALLOW', async () => {
  await depositoEn('confirmado')
  const db = como(UID_ADMIN)
  await assertSucceeds(setDoc(doc(db, 'ordenes_deposito', 'depI'), { estado: 'en_revision' }, { merge: true }))
  await assertSucceeds(updateDoc(doc(db, 'ordenes_deposito', 'depI'), NUEVO_BOUCHER))
})

test('BI7 · digitador sigue corrigiendo su depósito en revisión ⇒ ALLOW', async () => {
  await depositoEn('en_revision', { digitadoPorUid: UID_DIGITADOR, digitadoAt: new Date() })
  await assertSucceeds(updateDoc(doc(como(UID_DIGITADOR), 'ordenes_deposito', 'depI'), { ...NUEVO_BOUCHER, updatedAt: serverTimestamp() }))
})

test('BI8 · motorizado: reenvía desde rechazado ⇒ ALLOW; sobre confirmado ⇒ DENY (sin regresión)', async () => {
  await depositoEn('rechazado')
  const db = como(UID_MOTO)
  await assertSucceeds(updateDoc(doc(db, 'ordenes_deposito', 'depI'), { ...NUEVO_BOUCHER, estado: 'en_revision', updatedAt: serverTimestamp() }))
  await depositoEn('confirmado')
  await assertFails(updateDoc(doc(db, 'ordenes_deposito', 'depI'), { ...NUEVO_BOUCHER, estado: 'en_revision', updatedAt: serverTimestamp() }))
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

test('H1 · confirmación inicial legítima (DEP-C + orden pagada en un batch) ⇒ ALLOW', async () => {
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
  await assertSucceeds(b.commit())
})

test('H1b · también sobre una orden sin cobroDelivery previo (PagoContadoModal) ⇒ ALLOW', async () => {
  await env.withSecurityRulesDisabled(async (ctx) => {
    await setDoc(doc(ctx.firestore(), 'solicitudes_envio', 'ordP'), { ...ordenBase({ estado: 'entregado' }), codigo: 'SH-0003', secuencia: 3 })
  })
  const db = como(UID_GESTOR)
  const b = writeBatch(db)
  b.set(doc(db, 'ordenes_deposito', 'depNuevo'), depositoTipoC())
  b.update(doc(db, 'solicitudes_envio', 'ordP'), { ...confirmacionTipoC('depNuevo'), 'cobroDelivery.monto': 80 })
  await assertSucceeds(b.commit())
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

test('H9 · reversión legítima completa (cobro + movimiento + DEP-C + orden) ⇒ ALLOW', async () => {
  await sembrarPagadaTipoC()
  await assertSucceeds(reversion(como(UID_GESTOR)))
})

test('H10 · orden pagada: anotar movimientoPagoId y editar campos ajenos al cobro ⇒ ALLOW', async () => {
  await sembrarPagadaTipoC()
  const db = como(UID_GESTOR)
  await assertSucceeds(updateDoc(doc(db, 'solicitudes_envio', 'ordP'), { 'cobroDelivery.movimientoPagoId': 'movP' }))
  await assertSucceeds(updateDoc(doc(db, 'solicitudes_envio', 'ordP'), { prioridad: true, updatedAt: serverTimestamp() }))
})

test('H11 · efectivo (tipo A): confirmar el depósito del motorizado sobre una orden cobrada ⇒ ALLOW', async () => {
  await env.withSecurityRulesDisabled(async (ctx) => {
    const db = ctx.firestore()
    await setDoc(doc(db, 'solicitudes_envio', 'ordE'), {
      ...ordenBase({ estado: 'entregado' }), codigo: 'SH-0001', secuencia: 1,
      cobroDelivery: { estado: 'pagado', monto: 110, formaPago: 'efectivo' },
      registro: { deposito: { storkhubDepositoId: 'depA' } },
    })
    await setDoc(doc(db, 'ordenes_deposito', 'depA'), { ...depositoBase({ estado: 'en_revision', solicitudIds: ['ordE'] }), codigo: 'DEP-0001', secuencia: 1 })
  })
  const db = como(UID_GESTOR)
  const b = writeBatch(db)
  b.update(doc(db, 'ordenes_deposito', 'depA'), { estado: 'confirmado', confirmadoPorUid: UID_GESTOR, confirmadoAt: serverTimestamp() })
  b.update(doc(db, 'solicitudes_envio', 'ordE'), {
    'registro.deposito.confirmadoStorkhub': true,
    'registro.deposito.confirmadoStorkhubAt': serverTimestamp(),
    'registro.deposito.storkhubDepositoId': 'depA',
  })
  await assertSucceeds(b.commit())
})

test('H12 · revertir un cobro en efectivo con depósito del motorizado: legítimo sin tocar la liquidación; cambiándola ⇒ DENY', async () => {
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
  // Legítimo: el depósito del motorizado es otro dinero y no se toca.
  await assertSucceeds(reversion(como(UID_GESTOR), { anularDep: false, liberarOrden: false }))
  await sembrar()
  await assertFails(reversion(como(UID_GESTOR), { anularDep: false, liberarOrden: true }))
})

// ─── PAGO-TRANSFERENCIA-UX-1 · DEP-ACCIONES-ADMIN-ONLY ───────────────────────
//
// Rehacer (sacar de 'confirmado') y Eliminar un depósito cerrado son solo del
// admin. El gestor conserva confirmar, devolver un depósito abierto y anular
// el DEP tipo C al revertir su cobro.

test('AD1 · admin rehace un depósito confirmado ⇒ ALLOW', async () => {
  await depositoEn('confirmado')
  await assertSucceeds(setDoc(doc(como(UID_ADMIN), 'ordenes_deposito', 'depI'), { estado: 'en_revision' }, { merge: true }))
})

test('AD2 · gestor intenta rehacer un depósito confirmado ⇒ DENY', async () => {
  await depositoEn('confirmado')
  await assertFails(setDoc(doc(como(UID_GESTOR), 'ordenes_deposito', 'depI'), { estado: 'en_revision' }, { merge: true }))
  // Ni a ningún otro estado.
  await assertFails(updateDoc(doc(como(UID_GESTOR), 'ordenes_deposito', 'depI'), { estado: 'rechazado' }))
})

test('AD3 · admin elimina un depósito confirmado ⇒ ALLOW', async () => {
  await depositoEn('confirmado')
  await assertSucceeds(deleteDoc(doc(como(UID_ADMIN), 'ordenes_deposito', 'depI')))
})

test('AD4 · gestor intenta eliminar un depósito confirmado ⇒ DENY', async () => {
  await depositoEn('confirmado')
  await assertFails(deleteDoc(doc(como(UID_GESTOR), 'ordenes_deposito', 'depI')))
  await depositoEn('convertido_en_deuda')
  await assertFails(deleteDoc(doc(como(UID_GESTOR), 'ordenes_deposito', 'depI')))
})

test('AD5 · gestor devuelve al motorizado un depósito en revisión (lo borra) ⇒ ALLOW', async () => {
  await depositoEn('en_revision')
  await assertSucceeds(deleteDoc(doc(como(UID_GESTOR), 'ordenes_deposito', 'depI')))
})

test('AD6 · gestor confirma un depósito en revisión ⇒ ALLOW (sin regresión)', async () => {
  await depositoEn('en_revision')
  await assertSucceeds(updateDoc(doc(como(UID_GESTOR), 'ordenes_deposito', 'depI'), {
    estado: 'confirmado', confirmadoPorUid: UID_GESTOR, confirmadoAt: serverTimestamp(),
  }))
})

test('AD7 · gestor sigue anulando un DEP tipo C confirmado (Revertir), pero no un tipo A ⇒ ALLOW / DENY', async () => {
  await depositoEn('confirmado', { tipo: 'pago_delivery_deposito', boucherUrl: 'https://example.test/c.jpg' })
  await assertSucceeds(updateDoc(doc(como(UID_GESTOR), 'ordenes_deposito', 'depI'), { estado: 'anulado', anuladoAt: serverTimestamp() }))
  await depositoEn('confirmado')
  await assertFails(updateDoc(doc(como(UID_GESTOR), 'ordenes_deposito', 'depI'), { estado: 'anulado', anuladoAt: serverTimestamp() }))
})
