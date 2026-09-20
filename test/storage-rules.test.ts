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
import { doc, setDoc, deleteDoc, writeBatch, serverTimestamp } from 'firebase/firestore'
import { ref, uploadBytes, deleteObject, getBytes } from 'firebase/storage'
import {
  camposCreacionDepositoMotorizado,
  camposEnvioBoucherMotorizado,
  campoPunteroDepositoMotorizado,
  pathBoucherDepositoMotorizado,
  type DatosDepositoMotorizado,
} from '../lib/deposito-motorizado-envio'
import assert from 'node:assert/strict'
import {
  camposReemplazoBoucher,
  eventoReemplazoBoucher,
  pathVersionBoucher,
  planReemplazoBoucher,
} from '../lib/deposito-boucher-version'
import {
  camposEventoDepositoAnulado,
  camposEventoDepositoConfirmado,
  camposEventoDepositoDevuelto,
  camposEventoDepositoRehecho,
} from '../lib/deposito-eventos'
import {
  camposAnularDeposito,
  camposConfirmarDeposito,
  camposPedirCorreccion,
  camposRehacerDeposito,
} from '../lib/deposito-correccion'

const PROJECT_ID = 'demo-storage-evidencia'
const BASE_DIR = process.env.REGLAS_BASE_DIR || ''
const MODO_BASE = BASE_DIR !== ''
const archivoReglas = (nombre: string) => readFileSync(MODO_BASE ? join(BASE_DIR, nombre) : nombre, 'utf8')
/** Casos que solo tienen sentido contra las reglas nuevas. */
const soloNuevas = { skip: MODO_BASE ? 'modo compatibilidad: solo WC/DC' : false }

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

// HARDENING — la segunda mitad de S13 afirmaba que staff podía sobrescribir
// `boucher.jpg` en 'en_revision'. Esa era la última vía no versionada de
// reemplazar evidencia en Storage y se cierra (ver ST8). Lo que queda es el
// flujo INICIAL, que sí necesita escribir ese objeto.
test('S13 · staff sube el comprobante inicial en pendiente_boucher ⇒ ALLOW', soloNuevas, async () => {
  await deposito('pendiente_boucher')
  await assertSucceeds(subir(UID_GESTOR, PATH_DEP))
  // Y el reintento del mismo flujo, que reescribe el MISMO path.
  await assertSucceeds(subir(UID_GESTOR, PATH_DEP, jpeg(2048)))
})

test('ST8 · staff sobrescribe el legacy boucher.jpg de un DEP ya abierto ⇒ DENY', soloNuevas, async () => {
  // Primero existe el objeto (subida inicial legítima), después el depósito
  // entra en revisión: a partir de ahí la corrección es versionada.
  await deposito('pendiente_boucher')
  await assertSucceeds(subir(UID_GESTOR, PATH_DEP))
  await deposito('en_revision')
  await assertFails(subir(UID_GESTOR, PATH_DEP, jpeg(2048)))
  await assertFails(subir(UID_ADMIN, PATH_DEP, jpeg(2048)))
  await deposito('devuelto')
  await assertFails(subir(UID_GESTOR, PATH_DEP, jpeg(2048)))
  // El motorizado tampoco, que ya lo cerraba F1 (S3).
  await assertFails(subir(UID_MOTO, PATH_DEP, jpeg(2048)))
})

test('ST8b · el digitador conserva su corrección en revisión (D2, sin cambios)', soloNuevas, async () => {
  // Deuda explícita DIGITADOR-BOUCHER-NO-VERSIONADO: fuera del alcance de
  // este bloque, que cubre motorizado, gestor y admin.
  await deposito('pendiente_boucher', { digitadoPorUid: UID_DIGITADOR })
  await assertSucceeds(subir(UID_DIGITADOR, PATH_DEP))
  await deposito('en_revision', { digitadoPorUid: UID_DIGITADOR })
  await assertSucceeds(subir(UID_DIGITADOR, PATH_DEP, jpeg(2048)))
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

// ─── DEPOSITO-AUDITORIA-1 · versiones del comprobante ────────────────────────
//
// depositos/{uid}/{depId}/bouchers/{versionId}.jpg — CREATE ONLY.
//
// Lo que estos casos tienen que demostrar no es solo quién puede subir: es que
// una versión ya escrita NO se puede tocar. Si SV7/SV8 se pusieran verdes por
// accidente, el versionado dejaría de ser versionado — sería el mismo
// sobrescribir de F1 con más pasos.

// Un versionId por caso, y no uno compartido: `clearStorage()` NO deja el
// bucket vacío entre tests en esta combinación de emuladores (se comprobó
// empíricamente — con un path común, el segundo ALLOW pasaba a ser una
// sobrescritura y moría contra `resource == null`). Además es lo que pasa de
// verdad: cada versión tiene su propio id, nunca se reutiliza.
let contadorVersion = 0
const nuevoVersionId = () => `verCaso${String(++contadorVersion).padStart(4, '0')}AA`
const pathNuevaVersion = (uid = UID_MOTO, dep = DEP) => pathVersionBoucher(uid, dep, nuevoVersionId())

/** Siembra un objeto de versión sin pasar por reglas, para update/delete. */
async function sembrarVersion(): Promise<string> {
  const path = pathNuevaVersion()
  await env.withSecurityRulesDisabled(async (ctx) => {
    await uploadBytes(ref(ctx.storage(), path), jpeg(), META_JPEG)
  })
  return path
}

test('SV1 · motorizado dueño + DEP en_revision ⇒ sube una versión ALLOW', soloNuevas, async () => {
  await deposito('en_revision')
  await assertSucceeds(subir(UID_MOTO, pathNuevaVersion()))
})

test('SV1b · lo mismo con un DEP B (al comercio) ⇒ ALLOW', soloNuevas, async () => {
  await deposito('en_revision', { tipo: 'recaudacion_motorizado_comercio', destinatario: 'comercio', destinatarioId: COMERCIO_ID })
  await assertSucceeds(subir(UID_MOTO, pathNuevaVersion()))
})

test('SV2 · motorizado dueño + DEP devuelto ⇒ sube la corrección ALLOW', soloNuevas, async () => {
  await deposito('devuelto', { devueltoPorUid: UID_GESTOR, motivoDevolucion: 'No se lee el monto' })
  await assertSucceeds(subir(UID_MOTO, pathNuevaVersion()))
})

test('SV3 · DEP confirmado ⇒ DENY (motorizado y staff)', soloNuevas, async () => {
  await deposito('confirmado')
  await assertFails(subir(UID_MOTO, pathNuevaVersion()))
  await assertFails(subir(UID_GESTOR, pathNuevaVersion()))
  await assertFails(subir(UID_ADMIN, pathNuevaVersion()))
})

test('SV4 · DEP convertido_en_deuda ⇒ DENY (motorizado y staff)', soloNuevas, async () => {
  await deposito('convertido_en_deuda')
  await assertFails(subir(UID_MOTO, pathNuevaVersion()))
  await assertFails(subir(UID_GESTOR, pathNuevaVersion()))
})

test('SV5 · DEP anulado ⇒ DENY (motorizado y staff)', soloNuevas, async () => {
  await deposito('anulado')
  await assertFails(subir(UID_MOTO, pathNuevaVersion()))
  await assertFails(subir(UID_ADMIN, pathNuevaVersion()))
})

test('SV6 · otro motorizado sobre el path o el DEP ajeno ⇒ DENY', soloNuevas, async () => {
  await deposito('en_revision')
  await assertFails(subir(UID_MOTO_2, pathNuevaVersion()))
  await assertFails(subir(UID_MOTO_2, pathNuevaVersion(UID_MOTO_2)))
})

test('SV7 · sobrescribir una versión ya escrita ⇒ DENY, para todos', soloNuevas, async () => {
  await deposito('en_revision')
  const path = await sembrarVersion()
  for (const uid of [UID_MOTO, UID_GESTOR, UID_ADMIN, UID_DIGITADOR]) {
    await assertFails(subir(uid, path, jpeg(2048)))
  }
})

test('SV8 · borrar una versión ⇒ DENY, para todos', soloNuevas, async () => {
  await deposito('en_revision')
  const path = await sembrarVersion()
  for (const uid of [UID_MOTO, UID_GESTOR, UID_ADMIN]) {
    await assertFails(deleteObject(ref(storageDe(uid), path)))
  }
})

test('SV9 · staff sube una versión en un DEP abierto ⇒ ALLOW', soloNuevas, async () => {
  await deposito('en_revision')
  await assertSucceeds(subir(UID_GESTOR, pathNuevaVersion()))
  await deposito('devuelto')
  await assertSucceeds(subir(UID_ADMIN, pathNuevaVersion()))
})

test('SV10 · staff sobre un DEP sellado ⇒ DENY, sin bypass de admin', soloNuevas, async () => {
  for (const estado of ['confirmado', 'convertido_en_deuda', 'anulado']) {
    await deposito(estado)
    await assertFails(subir(UID_GESTOR, pathNuevaVersion()))
    await assertFails(subir(UID_ADMIN, pathNuevaVersion()))
  }
})

test('SV11 · pendiente_boucher NO admite versión: el flujo inicial de F1 no se duplica ⇒ DENY', soloNuevas, async () => {
  await deposito('pendiente_boucher')
  await assertFails(subir(UID_MOTO, pathNuevaVersion()))
  await assertFails(subir(UID_GESTOR, pathNuevaVersion()))
})

test('SV12 · DEP inexistente, tipo C, o con otro titular ⇒ DENY', soloNuevas, async () => {
  await assertFails(subir(UID_MOTO, pathNuevaVersion()))
  await deposito('en_revision', { tipo: 'pago_delivery_deposito' })
  await assertFails(subir(UID_MOTO, pathNuevaVersion()))
  await deposito('en_revision', { motorizadoUid: UID_MOTO_2 })
  await assertFails(subir(UID_MOTO, pathNuevaVersion()))
})

test('SV13 · nombre de archivo fuera de forma ⇒ DENY', soloNuevas, async () => {
  await deposito('en_revision')
  await assertFails(subir(UID_MOTO, `depositos/${UID_MOTO}/${DEP}/bouchers/boucher.png`))
  await assertFails(subir(UID_MOTO, `depositos/${UID_MOTO}/${DEP}/bouchers/ab.jpg`))
  await assertFails(subir(UID_MOTO, `depositos/${UID_MOTO}/${DEP}/bouchers/con espacio.jpg`))
})

test('SV14 · no-JPEG y más de 5 MB ⇒ DENY; exactamente 5 MB ⇒ ALLOW', soloNuevas, async () => {
  await deposito('en_revision')
  await assertFails(subir(UID_MOTO, pathNuevaVersion(), jpeg(), { contentType: 'image/png' }))
  await assertFails(subir(UID_MOTO, pathNuevaVersion(), jpeg(5 * MB + 1)))
  await assertSucceeds(subir(UID_MOTO, pathNuevaVersion(), jpeg(5 * MB)))
})

test('SV15 · el comprobante legacy sigue sellado: F1 intacto ⇒ DENY en revisión para el motorizado', soloNuevas, async () => {
  await deposito('en_revision')
  await assertFails(subir(UID_MOTO, PATH_DEP))
  await deposito('devuelto')
  await assertFails(subir(UID_MOTO, PATH_DEP))
})

test('SV16 · lectura de una versión: dueño, staff y comercio destinatario ⇒ ALLOW; ajeno ⇒ DENY', soloNuevas, async () => {
  await deposito('en_revision', { destinatario: 'comercio', destinatarioId: COMERCIO_ID })
  const path = await sembrarVersion()
  const leer = (uid: string) => getBytes(ref(storageDe(uid), path))
  await assertSucceeds(leer(UID_MOTO))
  await assertSucceeds(leer(UID_GESTOR))
  await assertSucceeds(leer(UID_COMERCIO))
  await assertFails(leer(UID_MOTO_2))
  await assertFails(leer(UID_COMERCIO_2))
})

// ─── DEPOSITO-AUDITORIA-1 · flujos completos del writer (R.37) ───────────────
//
// Los casos SV/V/D/A prueban reglas sueltas. Estos prueban el RECORRIDO, con
// los mismos helpers puros que usa la app: es la única forma de demostrar que
// una corrección real —Storage y Firestore, en orden, con sus dos emuladores—
// termina donde tiene que terminar y sin perder nada por el camino.

const DEP_F = 'depFlujo'
const ORDEN_F = 'ordFlujo'

async function depositoDeFlujo(estado: string, extra: Record<string, unknown> = {}) {
  await env.withSecurityRulesDisabled(async (ctx) => {
    const db = ctx.firestore()
    await setDoc(doc(db, 'ordenes_deposito', DEP_F), {
      tipo: 'recaudacion_motorizado_storkhub',
      estado,
      destinatario: 'storkhub',
      destinatarioId: 'storkhub',
      motorizadoUid: UID_MOTO,
      solicitudIds: [ORDEN_F],
      montoTotal: 110,
      codigo: 'DEP-0009',
      secuencia: 9,
      boucher: { url: 'https://example.test/v1.jpg', pathStorage: `depositos/${UID_MOTO}/${DEP_F}/boucher.jpg` },
      ...extra,
    })
    await setDoc(doc(db, 'solicitudes_envio', ORDEN_F), {
      comercioUid: COMERCIO_ID, userId: COMERCIO_ID, estado: 'entregado',
      asignacion: { motorizadoAuthUid: UID_MOTO }, codigo: 'SH-0009', secuencia: 9,
      registro: { deposito: { storkhubDepositoId: DEP_F } },
    })
  })
}

async function depActual(): Promise<Record<string, unknown>> {
  let data: Record<string, unknown> = {}
  await env.withSecurityRulesDisabled(async (ctx) => {
    const { getDoc } = await import('firebase/firestore')
    data = ((await getDoc(doc(ctx.firestore(), 'ordenes_deposito', DEP_F))).data() ?? {}) as Record<string, unknown>
  })
  return data
}

/** El writer de corrección del motorizado, paso por paso, como en la app. */
async function corregirComoMotorizado(motivo = 'La foto salió movida', uid = UID_MOTO) {
  const db = firestoreDe(uid)
  const dep = await depActual()
  const versionId = nuevoVersionId()
  const plan = planReemplazoBoucher(
    { id: DEP_F, motorizadoUid: UID_MOTO, boucherVersion: dep.boucherVersion as number, boucherVersionId: dep.boucherVersionId as string },
    versionId,
    motivo,
  )
  await uploadBytes(ref(storageDe(uid), plan.path), jpeg(), META_JPEG)
  const eventoId = versionId
  const b = writeBatch(db)
  b.set(doc(db, 'ordenes_deposito', DEP_F),
    camposReemplazoBoucher(plan, { url: 'https://example.test/nuevo.jpg', pathStorage: plan.path }, UID_MOTO, serverTimestamp(), eventoId),
    { merge: true })
  b.set(doc(db, 'ordenes_deposito', DEP_F, 'eventos', eventoId),
    eventoReemplazoBoucher(plan, { uid, rol: 'motorizado' }, serverTimestamp()))
  await b.commit()
  return plan
}

test('WF1 · legacy v1 → v2: sube la versión y el objeto viejo sigue ahí', soloNuevas, async () => {
  await depositoDeFlujo('en_revision')
  await env.withSecurityRulesDisabled(async (ctx) => {
    await uploadBytes(ref(ctx.storage(), `depositos/${UID_MOTO}/${DEP_F}/boucher.jpg`), jpeg(), META_JPEG)
  })
  const plan = await assertSucceeds(corregirComoMotorizado())
  const dep = await depActual()
  assert.equal(dep.boucherVersion, 2)
  assert.equal((dep.boucher as { pathStorage: string }).pathStorage, plan.path)
  // El legacy no se tocó: sigue siendo legible, que es todo el punto de no migrar.
  await assertSucceeds(getBytes(ref(storageDe(UID_MOTO), `depositos/${UID_MOTO}/${DEP_F}/boucher.jpg`)))
})

test('WF2 · en_revision → reemplazar: el DEP-N, el monto y las órdenes sobreviven', soloNuevas, async () => {
  await depositoDeFlujo('en_revision')
  await assertSucceeds(corregirComoMotorizado())
  const dep = await depActual()
  assert.equal(dep.codigo, 'DEP-0009')
  assert.equal(dep.montoTotal, 110)
  assert.deepEqual(dep.solicitudIds, [ORDEN_F])
  assert.equal(dep.estado, 'en_revision')
})

test('WF3 · ciclo completo: en_revision → devuelto → nueva versión → en_revision → confirmado', soloNuevas, async () => {
  await depositoDeFlujo('en_revision')

  // 1. El gestor pide corrección (depósito + evento, mismo batch).
  const dbG = firestoreDe(UID_GESTOR)
  const bDev = writeBatch(dbG)
  bDev.set(doc(dbG, 'ordenes_deposito', DEP_F),
    camposPedirCorreccion(UID_GESTOR, serverTimestamp(), 'No se lee el monto', 'evDevF'), { merge: true })
  bDev.set(doc(dbG, 'ordenes_deposito', DEP_F, 'eventos', 'evDevF'),
    camposEventoDepositoDevuelto({ uid: UID_GESTOR, rol: 'gestor' }, serverTimestamp(), 'No se lee el monto'))
  await assertSucceeds(bDev.commit())
  let dep = await depActual()
  assert.equal(dep.estado, 'devuelto')
  assert.equal(dep.codigo, 'DEP-0009')

  // 2. El motorizado manda la foto nueva: MISMO depósito, sin liberar órdenes.
  await assertSucceeds(corregirComoMotorizado('Ahora se ve el monto'))
  dep = await depActual()
  assert.equal(dep.estado, 'en_revision')
  assert.equal(dep.boucherVersion, 2)
  assert.equal(dep.codigo, 'DEP-0009')

  // 3. El gestor confirma, con su evento.
  const bConf = writeBatch(dbG)
  bConf.set(doc(dbG, 'ordenes_deposito', DEP_F),
    camposConfirmarDeposito(UID_GESTOR, serverTimestamp(), 'evConfF'), { merge: true })
  bConf.set(doc(dbG, 'ordenes_deposito', DEP_F, 'eventos', 'evConfF'),
    camposEventoDepositoConfirmado({ uid: UID_GESTOR, rol: 'gestor' }, serverTimestamp()))
  await assertSucceeds(bConf.commit())
  assert.equal((await depActual()).estado, 'confirmado')

  // 4. Y una vez confirmado, el comprobante queda sellado también en Storage.
  await assertFails(subir(UID_MOTO, pathVersionBoucher(UID_MOTO, DEP_F, nuevoVersionId())))
})

test('WF4 · dos reemplazos concurrentes: gana uno, el otro muere en Rules', soloNuevas, async () => {
  await depositoDeFlujo('en_revision')
  // El segundo parte de la MISMA lectura (versión efectiva 1) y pide la 2.
  const dbA = firestoreDe(UID_MOTO)
  const planA = planReemplazoBoucher({ id: DEP_F, motorizadoUid: UID_MOTO }, 'verConcurrA1', 'Primera corrección')
  const planB = planReemplazoBoucher({ id: DEP_F, motorizadoUid: UID_MOTO }, 'verConcurrB1', 'Segunda corrección')
  await uploadBytes(ref(storageDe(UID_MOTO), planA.path), jpeg(), META_JPEG)
  await uploadBytes(ref(storageDe(UID_MOTO), planB.path), jpeg(), META_JPEG)

  const batchDe = (plan: typeof planA, eventoId: string) => {
    const b = writeBatch(dbA)
    b.set(doc(dbA, 'ordenes_deposito', DEP_F),
      camposReemplazoBoucher(plan, { url: 'u', pathStorage: plan.path }, UID_MOTO, serverTimestamp(), eventoId), { merge: true })
    b.set(doc(dbA, 'ordenes_deposito', DEP_F, 'eventos', eventoId),
      eventoReemplazoBoucher(plan, { uid: UID_MOTO, rol: 'motorizado' }, serverTimestamp()))
    return b.commit()
  }
  await assertSucceeds(batchDe(planA, 'verConcurrA1'))
  await assertFails(batchDe(planB, 'verConcurrB1'))
  const dep = await depActual()
  assert.equal(dep.boucherVersion, 2)
  assert.equal(dep.boucherVersionId, 'verConcurrA1')
})

test('WF5 · upload OK + batch fallido: el objeto queda huérfano y NO se borra', soloNuevas, async () => {
  await depositoDeFlujo('en_revision')
  const plan = planReemplazoBoucher({ id: DEP_F, motorizadoUid: UID_MOTO }, 'verHuerfanaA1', 'Corrección que no llega')
  await assertSucceeds(uploadBytes(ref(storageDe(UID_MOTO), plan.path), jpeg(), META_JPEG))
  // El batch falla (acá: sin evento). El depósito no se movió…
  const db = firestoreDe(UID_MOTO)
  const b = writeBatch(db)
  b.set(doc(db, 'ordenes_deposito', DEP_F),
    camposReemplazoBoucher(plan, { url: 'u', pathStorage: plan.path }, UID_MOTO, serverTimestamp(), 'verHuerfanaA1'), { merge: true })
  await assertFails(b.commit())
  const dep = await depActual()
  assert.equal(dep.boucherVersion, undefined)
  // …y la huérfana no se puede limpiar desde el cliente: delete es DENY para
  // todos. Es la deuda MOTO-DEP-BOUCHER-VERSION-HUERFANA, no un descuido.
  await assertFails(deleteObject(ref(storageDe(UID_MOTO), plan.path)))
  await assertFails(deleteObject(ref(storageDe(UID_ADMIN), plan.path)))
  // El reintento usa una versión nueva y sí llega.
  await assertSucceeds(corregirComoMotorizado('Reintento'))
  assert.equal((await depActual()).boucherVersion, 2)
})

test('WF6 · anular y liberar órdenes en un batch: el DEP queda como rastro', soloNuevas, async () => {
  await depositoDeFlujo('confirmado')
  const db = firestoreDe(UID_ADMIN)
  const b = writeBatch(db)
  b.set(doc(db, 'ordenes_deposito', DEP_F),
    camposAnularDeposito(UID_ADMIN, serverTimestamp(), 'Depósito armado sobre órdenes equivocadas', 'evAnulF'), { merge: true })
  b.set(doc(db, 'ordenes_deposito', DEP_F, 'eventos', 'evAnulF'),
    camposEventoDepositoAnulado({ uid: UID_ADMIN, rol: 'admin' }, serverTimestamp(), 'Depósito armado sobre órdenes equivocadas'))
  b.update(doc(db, 'solicitudes_envio', ORDEN_F), {
    'registro.deposito.storkhubDepositoId': null,
    'registro.deposito.confirmadoStorkhub': false,
    'registro.deposito.confirmadoStorkhubAt': null,
  })
  await assertSucceeds(b.commit())
  const dep = await depActual()
  assert.equal(dep.estado, 'anulado')
  assert.equal(dep.codigo, 'DEP-0009')
  assert.ok(dep.boucher)
  assert.deepEqual(dep.solicitudIds, [ORDEN_F])
})

test('WF7 · rehacer con evento: vuelve a revisión y deja el motivo', soloNuevas, async () => {
  await depositoDeFlujo('confirmado', { confirmadoPorUid: UID_GESTOR })
  const db = firestoreDe(UID_ADMIN)
  const b = writeBatch(db)
  b.set(doc(db, 'ordenes_deposito', DEP_F),
    camposRehacerDeposito(UID_ADMIN, serverTimestamp(), 'El comprobante era de otro depósito', 'evRehF'), { merge: true })
  b.set(doc(db, 'ordenes_deposito', DEP_F, 'eventos', 'evRehF'),
    camposEventoDepositoRehecho({ uid: UID_ADMIN, rol: 'admin' }, serverTimestamp(), 'El comprobante era de otro depósito'))
  await assertSucceeds(b.commit())
  const dep = await depActual()
  assert.equal(dep.estado, 'en_revision')
  assert.equal(dep.motivoRehacer, 'El comprobante era de otro depósito')
  // Y ahora que está abierto, el motorizado puede corregir.
  await assertSucceeds(corregirComoMotorizado('Ahora sí el correcto'))
})

test('WF8 · el tipo C no entra en ninguno de estos flujos', soloNuevas, async () => {
  await depositoDeFlujo('en_revision', { tipo: 'pago_delivery_deposito', boucherUrl: 'https://example.test/c.jpg' })
  await assertFails(corregirComoMotorizado())
  const dbG = firestoreDe(UID_GESTOR)
  const b = writeBatch(dbG)
  b.set(doc(dbG, 'ordenes_deposito', DEP_F),
    camposPedirCorreccion(UID_GESTOR, serverTimestamp(), 'No se lee el monto', 'evDevC'), { merge: true })
  b.set(doc(dbG, 'ordenes_deposito', DEP_F, 'eventos', 'evDevC'),
    camposEventoDepositoDevuelto({ uid: UID_GESTOR, rol: 'gestor' }, serverTimestamp(), 'No se lee el monto'))
  await assertFails(b.commit())
})

// ═════════════════════════════════════════════════════════════════════════════
// DEPOSITO-AUDITORIA-1 · S.38 — COMPATIBILIDAD DE DEPLOY
//
// Esta feature toca web, firestore.rules y storage.rules a la vez, así que hay
// que saber qué pasa en los dos órdenes posibles. Estos casos corren dos veces
// —una con las reglas de este branch, otra con REGLAS_BASE_DIR apuntando a las
// de staging— y afirman un resultado distinto en cada modo. Esa asimetría ES
// el hallazgo: si los dos modos dieran lo mismo, no habría nada que coordinar.
//
//     npm run test:storage-rules     reglas nuevas
//     npm run test:compat-rules      reglas de origin/staging (F1)
//
// Resultado (ver el reporte del bloque):
//
//   A. web nueva + Rules F1   ROTO — el reemplazo versionado y "Pedir
//                             corrección" mueren contra reglas que no conocen
//                             ni bouchers/* ni la subcolección eventos.
//   B. Rules nuevas + web F1  ROTO — "Devolver al motorizado" y "Eliminar" del
//                             web viejo hacen delete, y delete pasó a DENY.
//
// Como ningún orden simple funciona, el rollout necesita un paso puente. NO se
// deploya nada acá: esto solo demuestra cuál es.
// ═════════════════════════════════════════════════════════════════════════════

const DEP_DC = 'depCompat'

async function depositoCompat(estado = 'en_revision') {
  await env.withSecurityRulesDisabled(async (ctx) => {
    await setDoc(doc(ctx.firestore(), 'ordenes_deposito', DEP_DC), {
      tipo: 'recaudacion_motorizado_storkhub',
      estado,
      destinatario: 'storkhub',
      destinatarioId: 'storkhub',
      motorizadoUid: UID_MOTO,
      solicitudIds: ['ordCompat'],
      montoTotal: 110,
      codigo: 'DEP-0010',
      secuencia: 10,
      boucher: { url: 'https://example.test/v1.jpg', pathStorage: `depositos/${UID_MOTO}/${DEP_DC}/boucher.jpg` },
    })
  })
}

/** ALLOW con reglas nuevas, DENY con las de staging — o al revés. */
const segunModo = (promesa: Promise<unknown>, enBase: 'allow' | 'deny') =>
  (MODO_BASE ? enBase === 'allow' : enBase === 'deny')
    ? assertSucceeds(promesa)
    : assertFails(promesa)

test('DC1 · dirección A: el upload versionado del web nuevo contra Rules F1 ⇒ DENY', async () => {
  await depositoCompat()
  // storage.rules de F1 no tiene match de 5 segmentos: cae en el catch-all.
  await segunModo(subir(UID_MOTO, pathVersionBoucher(UID_MOTO, DEP_DC, 'verCompatAA1')), 'deny')
})

test('DC2 · dirección A: "Pedir corrección" del web nuevo contra Rules F1 ⇒ DENY', async () => {
  await depositoCompat()
  const db = firestoreDe(UID_GESTOR)
  const b = writeBatch(db)
  b.set(doc(db, 'ordenes_deposito', DEP_DC),
    camposPedirCorreccion(UID_GESTOR, serverTimestamp(), 'No se lee el monto', 'evCompat1'), { merge: true })
  // La subcolección `eventos` no existe en las reglas de F1: sin match, deny.
  b.set(doc(db, 'ordenes_deposito', DEP_DC, 'eventos', 'evCompat1'),
    camposEventoDepositoDevuelto({ uid: UID_GESTOR, rol: 'gestor' }, serverTimestamp(), 'No se lee el monto'))
  await segunModo(b.commit(), 'deny')
})

test('DC3 · dirección B: el delete del web viejo ("Devolver"/"Eliminar") contra Rules nuevas ⇒ DENY', async () => {
  await depositoCompat()
  // Con las reglas de F1 el gestor borra un depósito abierto; con las nuevas,
  // delete es DENY para todos. Un web viejo contra reglas nuevas se queda sin
  // su única forma de devolver un depósito.
  await segunModo(deleteDoc(doc(firestoreDe(UID_GESTOR), 'ordenes_deposito', DEP_DC)), 'allow')
})

test('DC3b · y el "Eliminar" del admin sobre un confirmado, igual', async () => {
  await depositoCompat('confirmado')
  await segunModo(deleteDoc(doc(firestoreDe(UID_ADMIN), 'ordenes_deposito', DEP_DC)), 'allow')
})

test('DC4 · dirección A: confirmar SIN evento, como lo hace el web F1 ⇒ DENY contra las Rules finales', async () => {
  // Antes del HARDENING este caso era "compatible en los dos sentidos". Ya no:
  // confirmar exige su evento, así que también cae del lado del puente.
  await depositoCompat()
  await segunModo(setDoc(doc(firestoreDe(UID_GESTOR), 'ordenes_deposito', DEP_DC), {
    estado: 'confirmado', confirmadoPorUid: UID_GESTOR, confirmadoAt: serverTimestamp(),
  }, { merge: true }), 'allow')
})

test('DC5 · y el boucher legacy del flujo inicial: F1 intacto en los dos sentidos', async () => {
  await depositoCompat('pendiente_boucher')
  await assertSucceeds(subir(UID_MOTO, `depositos/${UID_MOTO}/${DEP_DC}/boucher.jpg`))
})

