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
import { doc, setDoc, updateDoc, getDoc, deleteField, serverTimestamp } from 'firebase/firestore'

// Identidades del arnés. El rol de comercio es 'Comercio' con mayúscula: así
// está en las reglas y así se escribe en `usuarios`.
const UID_COMERCIO = 'uid_comercio'
const UID_GESTOR = 'uid_gestor'
const UID_MOTO = 'uid_moto'
const UID_DIGITADOR = 'uid_digitador'
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
