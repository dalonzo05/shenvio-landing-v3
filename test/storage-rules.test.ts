// STORAGE-EVIDENCIA-INTEGRIDAD-1 — cobertura automática de storage.rules.
//
// Carga el `storage.rules` y el `firestore.rules` REALES del repo en los
// emuladores de Storage y Firestore, y comprueba ALLOW/DENY de verdad. Las
// reglas de Storage consultan Firestore (perfil, depósito, orden), así que
// los dos emuladores corren juntos:
//
//     npm run test:storage-rules
//
// Modo compatibilidad: con REGLAS_BASE_DIR apuntando a una carpeta con otro
// `firestore.rules` y `storage.rules` (las desplegadas hoy en staging), solo
// corren los casos WC: demuestran que el writer create-first NUEVO funciona
// también con las reglas ACTUALES, que es lo que exige el orden de deploy
// (web primero, reglas después).

import { test, before, after, beforeEach } from 'node:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import {
  initializeTestEnvironment,
  assertSucceeds,
  assertFails,
  type RulesTestEnvironment,
} from '@firebase/rules-unit-testing'
import { doc, setDoc, writeBatch, serverTimestamp } from 'firebase/firestore'
import { ref, uploadBytes } from 'firebase/storage'
import {
  camposCreacionDepositoMotorizado,
  camposEnvioBoucherMotorizado,
  campoPunteroDepositoMotorizado,
  pathBoucherDepositoMotorizado,
  type DatosDepositoMotorizado,
} from '../lib/deposito-motorizado-envio'

const PROJECT_ID = 'demo-storage-evidencia'
const BASE_DIR = process.env.REGLAS_BASE_DIR || ''
const MODO_BASE = BASE_DIR !== ''
const archivoReglas = (nombre: string) => readFileSync(MODO_BASE ? join(BASE_DIR, nombre) : nombre, 'utf8')
/** Casos que solo tienen sentido contra las reglas nuevas. */
const soloNuevas = { skip: MODO_BASE ? 'modo compatibilidad: solo WC' : false }

const UID_MOTO = 'uid_moto'
const UID_MOTO_2 = 'uid_moto_2'
const UID_GESTOR = 'uid_gestor'
const UID_ADMIN = 'uid_admin'
const UID_DIGITADOR = 'uid_digitador'
const UID_COMERCIO = 'uid_comercio'
const UID_COMERCIO_2 = 'uid_comercio_2'
const COMERCIO_ID = 'com1'
const COMERCIO_ID_2 = 'com2'

const MB = 1024 * 1024
const jpeg = (bytes = 1024) => new Uint8Array(bytes)
const META_JPEG = { contentType: 'image/jpeg' }

let env: RulesTestEnvironment

async function sembrarActores() {
  await env.withSecurityRulesDisabled(async (ctx) => {
    const db = ctx.firestore()
    await setDoc(doc(db, 'usuarios', UID_MOTO), { activo: true, rol: 'motorizado' })
    await setDoc(doc(db, 'usuarios', UID_MOTO_2), { activo: true, rol: 'motorizado' })
    await setDoc(doc(db, 'usuarios', UID_GESTOR), { activo: true, rol: 'gestor' })
    await setDoc(doc(db, 'usuarios', UID_ADMIN), { activo: true, rol: 'admin' })
    await setDoc(doc(db, 'usuarios', UID_DIGITADOR), { activo: true, rol: 'digitador' })
    await setDoc(doc(db, 'usuarios', UID_COMERCIO), { activo: true, rol: 'Comercio', comercioId: COMERCIO_ID })
    await setDoc(doc(db, 'usuarios', UID_COMERCIO_2), { activo: true, rol: 'Comercio', comercioId: COMERCIO_ID_2 })
  })
}

before(async () => {
  env = await initializeTestEnvironment({
    projectId: PROJECT_ID,
    firestore: { rules: archivoReglas('firestore.rules'), host: '127.0.0.1', port: 8080 },
    storage: { rules: archivoReglas('storage.rules'), host: '127.0.0.1', port: 9199 },
  })
})

after(async () => { await env?.cleanup() })

beforeEach(async () => {
  await env.clearFirestore()
  await env.clearStorage()
  await sembrarActores()
})

const storageDe = (uid: string) => env.authenticatedContext(uid).storage()
const firestoreDe = (uid: string) => env.authenticatedContext(uid).firestore()
const subir = (uid: string, path: string, bytes = jpeg(), meta = META_JPEG) =>
  uploadBytes(ref(storageDe(uid), path), bytes, meta)

// ─── Depósitos A/B ────────────────────────────────────────────────────────────

const DEP = 'depS'
const PATH_DEP = pathBoucherDepositoMotorizado(UID_MOTO, DEP)

/** Depósito sembrado sin reglas, en el estado del caso. */
async function deposito(estado: string, extra: Record<string, unknown> = {}) {
  await env.withSecurityRulesDisabled(async (ctx) => {
    await setDoc(doc(ctx.firestore(), 'ordenes_deposito', DEP), {
      tipo: 'recaudacion_motorizado_storkhub',
      estado,
      destinatario: 'storkhub',
      destinatarioId: 'storkhub',
      motorizadoUid: UID_MOTO,
      solicitudIds: ['ord1'],
      montoTotal: 80,
      codigo: 'DEP-0001',
      secuencia: 1,
      ...extra,
    })
  })
}

test('S1 · motorizado dueño + DEP pendiente_boucher ⇒ sube boucher.jpg ALLOW', soloNuevas, async () => {
  await deposito('pendiente_boucher')
  await assertSucceeds(subir(UID_MOTO, PATH_DEP))
})

test('S1b · lo mismo con un DEP B (al comercio) ⇒ ALLOW', soloNuevas, async () => {
  await deposito('pendiente_boucher', { tipo: 'recaudacion_motorizado_comercio', destinatario: 'comercio', destinatarioId: COMERCIO_ID })
  await assertSucceeds(subir(UID_MOTO, PATH_DEP))
})

test('S2 · otro motorizado sobre el path o el DEP ajeno ⇒ DENY', soloNuevas, async () => {
  await deposito('pendiente_boucher')
  await assertFails(subir(UID_MOTO_2, PATH_DEP))
  // Ni con su propio UID en el path sobre el depósito de otro.
  await assertFails(subir(UID_MOTO_2, pathBoucherDepositoMotorizado(UID_MOTO_2, DEP)))
})

test('S3 · DEP en_revision ⇒ el motorizado ya no sobrescribe (F2) ⇒ DENY', soloNuevas, async () => {
  await deposito('en_revision')
  await assertFails(subir(UID_MOTO, PATH_DEP))
})

test('S4 · DEP confirmado ⇒ motorizado DENY', soloNuevas, async () => {
  await deposito('confirmado')
  await assertFails(subir(UID_MOTO, PATH_DEP))
})

test('S5 · DEP convertido_en_deuda ⇒ motorizado DENY', soloNuevas, async () => {
  await deposito('convertido_en_deuda')
  await assertFails(subir(UID_MOTO, PATH_DEP))
})

test('S6 · DEP anulado ⇒ motorizado DENY', soloNuevas, async () => {
  await deposito('anulado')
  await assertFails(subir(UID_MOTO, PATH_DEP))
})

test('S7 · gestor sobre confirmado, convertido_en_deuda o anulado ⇒ DENY', soloNuevas, async () => {
  for (const estado of ['confirmado', 'convertido_en_deuda', 'anulado']) {
    await deposito(estado)
    await assertFails(subir(UID_GESTOR, PATH_DEP))
  }
})

test('S8 · admin sobre confirmado, convertido_en_deuda o anulado ⇒ DENY (sin bypass en F1)', soloNuevas, async () => {
  for (const estado of ['confirmado', 'convertido_en_deuda', 'anulado']) {
    await deposito(estado)
    await assertFails(subir(UID_ADMIN, PATH_DEP))
  }
})

test('S9 · archivo no JPEG ⇒ DENY', soloNuevas, async () => {
  await deposito('pendiente_boucher')
  await assertFails(subir(UID_MOTO, PATH_DEP, jpeg(), { contentType: 'image/png' }))
  await assertFails(subir(UID_MOTO, PATH_DEP, jpeg(), { contentType: 'application/pdf' }))
})

test('S10 · más de 5 MB ⇒ DENY; exactamente 5 MB ⇒ ALLOW', soloNuevas, async () => {
  await deposito('pendiente_boucher')
  await assertFails(subir(UID_MOTO, PATH_DEP, jpeg(5 * MB + 1)))
  await assertSucceeds(subir(UID_MOTO, PATH_DEP, jpeg(5 * MB)))
})

test('S11 · DEP inexistente ⇒ DENY (motorizado y staff)', soloNuevas, async () => {
  await assertFails(subir(UID_MOTO, PATH_DEP))
  await assertFails(subir(UID_GESTOR, PATH_DEP))
})

test('S12 · uid del path distinto del motorizadoUid del DEP ⇒ DENY (motorizado y staff)', soloNuevas, async () => {
  await deposito('pendiente_boucher', { motorizadoUid: UID_MOTO_2 })
  await assertFails(subir(UID_MOTO, PATH_DEP))
  await assertFails(subir(UID_GESTOR, PATH_DEP))
})

test('S13 · staff sigue subiendo en abiertos: confirmar (pendiente_boucher) y reemplazar en revisión ⇒ ALLOW', soloNuevas, async () => {
  for (const estado of ['pendiente_boucher', 'en_revision', 'rechazado']) {
    await deposito(estado)
    await assertSucceeds(subir(UID_GESTOR, PATH_DEP))
    await assertSucceeds(subir(UID_ADMIN, PATH_DEP))
  }
})

test('S14 · digitador sin cambios: su digitación en pendiente/en_revision ALLOW; confirmada o ajena DENY', soloNuevas, async () => {
  await deposito('pendiente_boucher', { digitadoPorUid: UID_DIGITADOR })
  await assertSucceeds(subir(UID_DIGITADOR, PATH_DEP))
  await deposito('en_revision', { digitadoPorUid: UID_DIGITADOR })
  await assertSucceeds(subir(UID_DIGITADOR, PATH_DEP))
  await deposito('confirmado', { digitadoPorUid: UID_DIGITADOR })
  await assertFails(subir(UID_DIGITADOR, PATH_DEP))
  await deposito('pendiente_boucher')
  await assertFails(subir(UID_DIGITADOR, PATH_DEP))
})

test('S15 · el motorizado no sube a un tipo C ni a un nombre distinto de boucher.jpg ⇒ DENY', soloNuevas, async () => {
  await deposito('pendiente_boucher', { tipo: 'pago_delivery_deposito' })
  await assertFails(subir(UID_MOTO, PATH_DEP))
  await deposito('pendiente_boucher')
  await assertFails(subir(UID_MOTO, `depositos/${UID_MOTO}/${DEP}/otro.jpg`))
})

// ─── Tipo C: boucher del pago del delivery ────────────────────────────────────

const ORDEN = 'ordC'
const PATH_COMERCIO = `evidencias/${ORDEN}/delivery_boucher_comercio.jpg`
const PATH_GESTOR = `evidencias/${ORDEN}/delivery_boucher_gestor.jpg`

async function ordenConCobro(estadoCobro: string | null) {
  await env.withSecurityRulesDisabled(async (ctx) => {
    const orden: Record<string, unknown> = {
      comercioUid: COMERCIO_ID,
      userId: COMERCIO_ID,
      estado: 'entregado',
      pagoDelivery: { quienPaga: 'transferencia' },
      codigo: 'SH-0001',
      secuencia: 1,
    }
    if (estadoCobro !== null) orden.cobroDelivery = { estado: estadoCobro, monto: 80 }
    await setDoc(doc(ctx.firestore(), 'solicitudes_envio', ORDEN), orden)
  })
}

test('C1 · comercio propietario con el cobro abierto ⇒ ALLOW', soloNuevas, async () => {
  for (const estado of [null, 'pendiente', 'en_revision_deposito']) {
    await ordenConCobro(estado)
    await assertSucceeds(subir(UID_COMERCIO, PATH_COMERCIO))
  }
})

test('C2 · comercio propietario con el cobro pagado ⇒ DENY', soloNuevas, async () => {
  await ordenConCobro('pagado')
  await assertFails(subir(UID_COMERCIO, PATH_COMERCIO))
})

test('C3 · otro comercio ⇒ DENY', soloNuevas, async () => {
  await ordenConCobro('pendiente')
  await assertFails(subir(UID_COMERCIO_2, PATH_COMERCIO))
})

test('C4 · gestor y admin con el cobro abierto ⇒ su objeto ALLOW; el del comercio nunca', soloNuevas, async () => {
  for (const estado of ['pendiente', 'en_revision_deposito']) {
    await ordenConCobro(estado)
    await assertSucceeds(subir(UID_GESTOR, PATH_GESTOR))
    await assertSucceeds(subir(UID_ADMIN, PATH_GESTOR))
    await assertFails(subir(UID_GESTOR, PATH_COMERCIO))
  }
})

test('C5 · gestor y admin con el cobro pagado ⇒ DENY', soloNuevas, async () => {
  await ordenConCobro('pagado')
  await assertFails(subir(UID_GESTOR, PATH_GESTOR))
  await assertFails(subir(UID_ADMIN, PATH_GESTOR))
})

test('C6 · evidencia operativa de staff intacta: cargotrans/terminal no dependen del cobro ⇒ ALLOW', soloNuevas, async () => {
  await ordenConCobro('pagado')
  await assertSucceeds(subir(UID_GESTOR, `evidencias/${ORDEN}/cargotrans_factura.jpg`))
  await assertSucceeds(subir(UID_GESTOR, `evidencias/${ORDEN}/terminal_bus.jpg`))
})

test('C7 · evidencia operativa del motorizado intacta (fuera de F1): asignado, orden entregada ⇒ ALLOW', soloNuevas, async () => {
  await env.withSecurityRulesDisabled(async (ctx) => {
    await setDoc(doc(ctx.firestore(), 'solicitudes_envio', ORDEN), {
      comercioUid: COMERCIO_ID, estado: 'entregado', asignacion: { motorizadoAuthUid: UID_MOTO },
      cobroDelivery: { estado: 'pagado' },
    })
  })
  await assertSucceeds(subir(UID_MOTO, `evidencias/${ORDEN}/entrega.jpg`))
})

// ─── Writer create-first: compatibilidad con reglas actuales y nuevas ─────────

const ORDEN_WC = 'ordWC'
const DEP_WC = 'depWC'

function datosWC(uid = UID_MOTO): DatosDepositoMotorizado {
  return {
    tipo: 'recaudacion_motorizado_storkhub',
    destinatario: 'storkhub',
    destinatarioId: 'storkhub',
    destinatarioNombre: 'Storkhub',
    cuentasDestino: [{ banco: 'LAFISE', numero: '000', titular: 'StorkHub', moneda: 'C$' }],
    motorizadoUid: uid,
    motorizadoNombre: 'John Pork 2',
    solicitudIds: [ORDEN_WC],
    montoTotal: 80,
    montoBruto: 80,
    gastosDescontados: 0,
    gastosIds: [],
  }
}

async function ordenEntregadaDelMotorizado() {
  await env.withSecurityRulesDisabled(async (ctx) => {
    await setDoc(doc(ctx.firestore(), 'solicitudes_envio', ORDEN_WC), {
      comercioUid: COMERCIO_ID, userId: COMERCIO_ID, estado: 'entregado',
      asignacion: { motorizadoAuthUid: UID_MOTO }, codigo: 'SH-0004', secuencia: 4,
    })
  })
}

/** Los tres pasos del writer de app/panel/motorizado/page.tsx, con los mismos helpers. */
async function writerCreateFirst(uid = UID_MOTO) {
  const db = firestoreDe(uid)
  const datos = datosWC(uid)
  const depRef = doc(db, 'ordenes_deposito', DEP_WC)
  await setDoc(depRef, camposCreacionDepositoMotorizado(datos, serverTimestamp()))
  const path = pathBoucherDepositoMotorizado(uid, DEP_WC)
  await uploadBytes(ref(storageDe(uid), path), jpeg(), META_JPEG)
  const b = writeBatch(db)
  b.update(depRef, camposEnvioBoucherMotorizado({ url: 'https://example.test/' + path, pathStorage: path }, uid, serverTimestamp()))
  b.update(doc(db, 'solicitudes_envio', ORDEN_WC), { [campoPunteroDepositoMotorizado(datos.tipo)]: DEP_WC })
  await b.commit()
}

test('WC1 · writer create-first nuevo: create → upload → batch ⇒ ALLOW (reglas nuevas y actuales)', async () => {
  await ordenEntregadaDelMotorizado()
  await assertSucceeds(writerCreateFirst())
})

test('WC2 · reintento tras fallar el batch: mismo id, re-upload en pendiente_boucher, batch ⇒ ALLOW', async () => {
  await ordenEntregadaDelMotorizado()
  const db = firestoreDe(UID_MOTO)
  const datos = datosWC()
  const depRef = doc(db, 'ordenes_deposito', DEP_WC)
  const path = pathBoucherDepositoMotorizado(UID_MOTO, DEP_WC)
  await assertSucceeds(setDoc(depRef, camposCreacionDepositoMotorizado(datos, serverTimestamp())))
  await assertSucceeds(uploadBytes(ref(storageDe(UID_MOTO), path), jpeg(), META_JPEG))
  // (el batch "falla" acá) → reintento sin volver a crear:
  await assertSucceeds(uploadBytes(ref(storageDe(UID_MOTO), path), jpeg(2048), META_JPEG))
  const b = writeBatch(db)
  b.update(depRef, camposEnvioBoucherMotorizado({ url: 'https://example.test/x', pathStorage: path }, UID_MOTO, serverTimestamp()))
  b.update(doc(db, 'solicitudes_envio', ORDEN_WC), { [campoPunteroDepositoMotorizado(datos.tipo)]: DEP_WC })
  await assertSucceeds(b.commit())
})

test('WC3 · writer viejo upload-first (sube sin depósito y crea en_revision) ⇒ DENY con reglas nuevas', soloNuevas, async () => {
  await ordenEntregadaDelMotorizado()
  const path = pathBoucherDepositoMotorizado(UID_MOTO, DEP_WC)
  await assertFails(uploadBytes(ref(storageDe(UID_MOTO), path), jpeg(), META_JPEG))
  await assertFails(setDoc(doc(firestoreDe(UID_MOTO), 'ordenes_deposito', DEP_WC), {
    ...camposCreacionDepositoMotorizado(datosWC(), serverTimestamp()),
    estado: 'en_revision',
    boucher: { url: 'https://example.test/x', pathStorage: path, motorizadoUid: UID_MOTO },
  }))
})
