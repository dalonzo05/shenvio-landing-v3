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
import { doc, setDoc, updateDoc, deleteDoc, writeBatch, serverTimestamp } from 'firebase/firestore'
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
/**
 * ROLLOUT — la suite corre contra TRES rulesets, y el mismo caso puede
 * esperar cosas distintas en cada uno. Esa asimetría es el resultado.
 *
 *   npm run test:storage-rules   FINAL   las Rules de este branch
 *   npm run test:puente-rules    PUENTE  .reglas-puente (derivadas de las
 *                                        finales, scripts/reglas-puente.mjs)
 *   npm run test:compat-rules    F1      .reglas-base (origin/staging)
 */
const MODO_PUENTE = BASE_DIR.includes('puente')
const MODO_F1 = MODO_BASE && !MODO_PUENTE
const archivoReglas = (nombre: string) => readFileSync(MODO_BASE ? join(BASE_DIR, nombre) : nombre, 'utf8')
/** Casos que solo tienen sentido contra las reglas nuevas. */
const soloNuevas = { skip: MODO_BASE ? 'modo compatibilidad: solo WC/DC/PB' : false }
/** Flujos del web F2: válidos con las Rules finales y con el puente. */
const finalesYPuente = { skip: MODO_F1 ? 'flujo F2: no aplica contra Rules F1' : false }
/** Flujos del web F1: válidos con las Rules de F1 y con el puente. */
const f1YPuente = { skip: (!MODO_BASE) ? 'flujo F1: cerrado en las Rules finales' : false }
/** Solo contra las Rules finales, para probar que el cierre sí ocurre. */
const soloFinales = { skip: MODO_BASE ? 'solo contra las Rules finales' : false }
/**
 * Los casos DC comparan FINAL contra F1 para demostrar que ningún orden
 * simple de deploy funciona. El puente es precisamente la respuesta a eso, así
 * que ahí no aplican: sus flujos los cubren los casos P1/P2/P3.
 */
const finalesYF1 = { skip: MODO_PUENTE ? 'dirección A/B: el puente es la respuesta, ver P1-P3' : false }

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

// HARDENING FINAL — ST8b afirmaba la deuda DIGITADOR-BOUCHER-NO-VERSIONADO.
// Queda CERRADA: el digitador tampoco pisa el legacy en revisión.
test('ST8b · el digitador tampoco sobrescribe el legacy en revisión ⇒ DENY', soloNuevas, async () => {
  await deposito('pendiente_boucher', { digitadoPorUid: UID_DIGITADOR })
  await assertSucceeds(subir(UID_DIGITADOR, PATH_DEP))
  await deposito('en_revision', { digitadoPorUid: UID_DIGITADOR })
  await assertFails(subir(UID_DIGITADOR, PATH_DEP, jpeg(2048)))
})

// HARDENING FINAL — la segunda linea de S14 afirmaba que el digitador subia
// al legacy estando en 'en_revision'. Esa era la ultima via no versionada de
// reemplazar evidencia. Lo que conserva es la PRIMERA carga y su reintento,
// que ocurren en 'pendiente_boucher'; la correccion va por bouchers/ (DG3s).
test('S14 · digitador: primera carga en pendiente_boucher ALLOW; confirmada o ajena DENY', soloNuevas, async () => {
  await deposito('pendiente_boucher', { digitadoPorUid: UID_DIGITADOR })
  await assertSucceeds(subir(UID_DIGITADOR, PATH_DEP))
  // Reintento del mismo flujo inicial, sobre el mismo objeto.
  await assertSucceeds(subir(UID_DIGITADOR, PATH_DEP, jpeg(2048)))
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

test('C6 · el cobro pagado no condiciona la evidencia operativa; el SELLO sí (A4-02): cargotrans = primera escritura de gestor ALLOW, terminal sellado DENY', finalesYPuente, async () => {
  await ordenConCobro('pagado') // estado 'entregado'
  // Antes de A4-02 ambos eran ALLOW y reemplazables para siempre. Ahora la
  // única creación posterior a la entrega es la de cargotrans_* (panel de
  // gestor: "Disponible cuando la orden esté entregada"); terminal_* ya no.
  await assertSucceeds(subir(UID_GESTOR, `evidencias/${ORDEN}/cargotrans_factura.jpg`))
  await assertFails(subir(UID_GESTOR, `evidencias/${ORDEN}/terminal_bus.jpg`))
})

test('C7 · evidencia operativa del motorizado: el cobro pagado no la condiciona; la orden entregada la sella (A4-02)', finalesYPuente, async () => {
  await env.withSecurityRulesDisabled(async (ctx) => {
    await setDoc(doc(ctx.firestore(), 'solicitudes_envio', ORDEN), {
      comercioUid: COMERCIO_ID, estado: 'en_camino_entrega', asignacion: { motorizadoAuthUid: UID_MOTO },
      cobroDelivery: { estado: 'pagado' },
    })
  })
  await assertSucceeds(subir(UID_MOTO, `evidencias/${ORDEN}/entrega.jpg`))
  await env.withSecurityRulesDisabled(async (ctx) => {
    await updateDoc(doc(ctx.firestore(), 'solicitudes_envio', ORDEN), { estado: 'entregado' })
  })
  await assertFails(subir(UID_MOTO, `evidencias/${ORDEN}/entrega.jpg`, jpeg(2048)))
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

test('WF3 · ciclo completo del cliente: en_revision → devuelto → nueva versión → en_revision; confirmar ya NO es del cliente (FIN-1B: confirmarDeposito)', soloNuevas, async () => {
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

  // 3. El gestor ya no confirma desde el cliente: la confirmación es de la callable confirmarDeposito.
  const bConf = writeBatch(dbG)
  bConf.set(doc(dbG, 'ordenes_deposito', DEP_F),
    camposConfirmarDeposito(UID_GESTOR, serverTimestamp(), 'evConfF'), { merge: true })
  bConf.set(doc(dbG, 'ordenes_deposito', DEP_F, 'eventos', 'evConfF'),
    camposEventoDepositoConfirmado({ uid: UID_GESTOR, rol: 'gestor' }, serverTimestamp()))
  await assertFails(bConf.commit())
  assert.equal((await depActual()).estado, 'en_revision')

  // 4. Un depósito confirmado (por la callable) tiene el comprobante sellado también en Storage.
  await depositoDeFlujo('confirmado')
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

test('WF6 · anular y liberar órdenes en un batch desde el cliente ⇒ DENY (FIN-1B: anularDeposito)', soloNuevas, async () => {
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
  await assertFails(b.commit())
  const dep = await depActual()
  assert.equal(dep.estado, 'confirmado')
  assert.equal(dep.codigo, 'DEP-0009')
  assert.ok(dep.boucher)
  assert.deepEqual(dep.solicitudIds, [ORDEN_F])
})

test('WF7 · rehacer con evento desde el cliente ⇒ DENY (FIN-1B: rehacerDeposito); sigue confirmado y el motorizado no puede corregir', soloNuevas, async () => {
  await depositoDeFlujo('confirmado', { confirmadoPorUid: UID_GESTOR })
  const db = firestoreDe(UID_ADMIN)
  const b = writeBatch(db)
  b.set(doc(db, 'ordenes_deposito', DEP_F),
    camposRehacerDeposito(UID_ADMIN, serverTimestamp(), 'El comprobante era de otro depósito', 'evRehF'), { merge: true })
  b.set(doc(db, 'ordenes_deposito', DEP_F, 'eventos', 'evRehF'),
    camposEventoDepositoRehecho({ uid: UID_ADMIN, rol: 'admin' }, serverTimestamp(), 'El comprobante era de otro depósito'))
  await assertFails(b.commit())
  const dep = await depActual()
  assert.equal(dep.estado, 'confirmado')
  assert.equal(dep.motivoRehacer, undefined)
  // Y como no se reabrió, el motorizado no puede corregir.
  await assertFails(corregirComoMotorizado('Ahora sí el correcto'))
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

test('DC1 · dirección A: el upload versionado del web nuevo contra Rules F1 ⇒ DENY', finalesYF1, async () => {
  await depositoCompat()
  // storage.rules de F1 no tiene match de 5 segmentos: cae en el catch-all.
  await segunModo(subir(UID_MOTO, pathVersionBoucher(UID_MOTO, DEP_DC, 'verCompatAA1')), 'deny')
})

test('DC2 · dirección A: "Pedir corrección" del web nuevo contra Rules F1 ⇒ DENY', finalesYF1, async () => {
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

test('DC3 · dirección B: el delete del web viejo ("Devolver"/"Eliminar") contra Rules nuevas ⇒ DENY', finalesYF1, async () => {
  await depositoCompat()
  // Con las reglas de F1 el gestor borra un depósito abierto; con las nuevas,
  // delete es DENY para todos. Un web viejo contra reglas nuevas se queda sin
  // su única forma de devolver un depósito.
  await segunModo(deleteDoc(doc(firestoreDe(UID_GESTOR), 'ordenes_deposito', DEP_DC)), 'allow')
})

test('DC3b · y el "Eliminar" del admin sobre un confirmado, igual', finalesYF1, async () => {
  await depositoCompat('confirmado')
  await segunModo(deleteDoc(doc(firestoreDe(UID_ADMIN), 'ordenes_deposito', DEP_DC)), 'allow')
})

test('DC4 · dirección A: confirmar SIN evento, como lo hace el web F1 ⇒ DENY contra las Rules finales', finalesYF1, async () => {
  // Antes del HARDENING este caso era "compatible en los dos sentidos". Ya no:
  // confirmar exige su evento, así que también cae del lado del puente.
  await depositoCompat()
  await segunModo(setDoc(doc(firestoreDe(UID_GESTOR), 'ordenes_deposito', DEP_DC), {
    estado: 'confirmado', confirmadoPorUid: UID_GESTOR, confirmadoAt: serverTimestamp(),
  }, { merge: true }), 'allow')
})

test('DC5 · y el boucher legacy del flujo inicial: F1 intacto en los dos sentidos', finalesYF1, async () => {
  await depositoCompat('pendiente_boucher')
  await assertSucceeds(subir(UID_MOTO, `depositos/${UID_MOTO}/${DEP_DC}/boucher.jpg`))
})

// ═════════════════════════════════════════════════════════════════════════════
// ROLLOUT · PB — matriz de compatibilidad del PUENTE
//
// Tres rulesets, tres corridas, el mismo archivo de tests:
//
//   P1  web F1 + Rules puente    todos los flujos de F1 siguen funcionando
//   P2  web F2 + Rules puente    todos los flujos nuevos ya funcionan
//   P3  web F2 + Rules finales   ídem, con el cierre puesto
//
// P2 y P3 son el MISMO conjunto de casos corriendo en dos modos (finalesYPuente);
// P1 corre en puente y en F1 (f1YPuente). Los casos `soloFinales` demuestran
// que el cierre sí ocurre al final del rollout, y no antes.
//
// Ninguno de estos casos deploya nada: leen ruleset de disco.
// ═════════════════════════════════════════════════════════════════════════════

const DEP_PB = 'depPuente'
const ORDEN_PB = 'ordPuente'

async function depositoPuente(estado = 'en_revision', extra: Record<string, unknown> = {}) {
  await env.withSecurityRulesDisabled(async (ctx) => {
    const db = ctx.firestore()
    await setDoc(doc(db, 'ordenes_deposito', DEP_PB), {
      tipo: 'recaudacion_motorizado_storkhub',
      estado,
      destinatario: 'storkhub',
      destinatarioId: 'storkhub',
      motorizadoUid: UID_MOTO,
      solicitudIds: [ORDEN_PB],
      montoTotal: 110,
      codigo: 'DEP-0011',
      secuencia: 11,
      boucher: { url: 'https://example.test/v1.jpg', pathStorage: `depositos/${UID_MOTO}/${DEP_PB}/boucher.jpg` },
      ...extra,
    })
    await setDoc(doc(db, 'solicitudes_envio', ORDEN_PB), {
      comercioUid: COMERCIO_ID, userId: COMERCIO_ID, estado: 'entregado',
      asignacion: { motorizadoAuthUid: UID_MOTO }, codigo: 'SH-0011', secuencia: 11,
      registro: { deposito: { storkhubDepositoId: DEP_PB } },
    })
  })
}

// ─── P1 · el web F1 sigue funcionando bajo el puente ─────────────────────────

test('P1a · "Devolver al motorizado" del web F1 (delete + liberar órdenes) ⇒ ALLOW', f1YPuente, async () => {
  await depositoPuente('en_revision')
  const db = firestoreDe(UID_GESTOR)
  const b = writeBatch(db)
  b.delete(doc(db, 'ordenes_deposito', DEP_PB))
  b.update(doc(db, 'solicitudes_envio', ORDEN_PB), {
    'registro.deposito.storkhubDepositoId': null,
    'registro.deposito.confirmadoStorkhub': false,
    'registro.deposito.confirmadoStorkhubAt': null,
  })
  await assertSucceeds(b.commit())
})

test('P1b · "Eliminar" del admin sobre un confirmado ⇒ ALLOW', f1YPuente, async () => {
  await depositoPuente('confirmado')
  await assertSucceeds(deleteDoc(doc(firestoreDe(UID_ADMIN), 'ordenes_deposito', DEP_PB)))
})

test('P1c · confirmar SIN evento, como lo escribía el web F1 ⇒ DENY (FIN-1B: ni el puente lo abre)', f1YPuente, async () => {
  await depositoPuente('en_revision')
  await assertFails(setDoc(doc(firestoreDe(UID_GESTOR), 'ordenes_deposito', DEP_PB), {
    estado: 'confirmado', confirmadoPorUid: UID_GESTOR, confirmadoAt: serverTimestamp(),
  }, { merge: true }))
})

test('P1d · rehacer SIN evento (admin) ⇒ DENY (FIN-1B: ni el puente lo abre)', f1YPuente, async () => {
  await depositoPuente('confirmado')
  await assertFails(setDoc(doc(firestoreDe(UID_ADMIN), 'ordenes_deposito', DEP_PB), {
    estado: 'en_revision',
  }, { merge: true }))
})

test('P1e · reemplazar el boucher directo en revisión: Storage legacy ⇒ ALLOW, el puntero en Firestore ⇒ DENY (FIN-1B)', f1YPuente, async () => {
  await depositoPuente('en_revision')
  await assertSucceeds(subir(UID_GESTOR, `depositos/${UID_MOTO}/${DEP_PB}/boucher.jpg`))
  await assertFails(setDoc(doc(firestoreDe(UID_GESTOR), 'ordenes_deposito', DEP_PB), {
    boucher: { url: 'https://example.test/nuevo.jpg', pathStorage: `depositos/${UID_MOTO}/${DEP_PB}/boucher.jpg` },
  }, { merge: true }))
})

test('P1f · el create-first del motorizado sigue intacto ⇒ ALLOW (los tres rulesets)', async () => {
  await ordenEntregadaDelMotorizado()
  await assertSucceeds(writerCreateFirst())
})

// ─── P2/P3 · el web F2 funciona bajo el puente Y bajo las finales ────────────

test('P2a · pedir corrección (documento + evento, mismo batch) ⇒ ALLOW', finalesYPuente, async () => {
  await depositoPuente('en_revision')
  const db = firestoreDe(UID_GESTOR)
  const b = writeBatch(db)
  b.set(doc(db, 'ordenes_deposito', DEP_PB),
    camposPedirCorreccion(UID_GESTOR, serverTimestamp(), 'No se lee el monto', 'evPB1'), { merge: true })
  b.set(doc(db, 'ordenes_deposito', DEP_PB, 'eventos', 'evPB1'),
    camposEventoDepositoDevuelto({ uid: UID_GESTOR, rol: 'gestor' }, serverTimestamp(), 'No se lee el monto'))
  await assertSucceeds(b.commit())
})

test('P2b · reemplazo versionado del motorizado (upload + batch) ⇒ ALLOW', finalesYPuente, async () => {
  await depositoPuente('devuelto', { devueltoPorUid: UID_GESTOR, motivoDevolucion: 'otra foto' })
  const plan = planReemplazoBoucher({ id: DEP_PB, motorizadoUid: UID_MOTO }, 'verPuenteAAA1', 'Ahora se ve el monto')
  await assertSucceeds(uploadBytes(ref(storageDe(UID_MOTO), plan.path), jpeg(), META_JPEG))
  const db = firestoreDe(UID_MOTO)
  const b = writeBatch(db)
  b.set(doc(db, 'ordenes_deposito', DEP_PB),
    camposReemplazoBoucher(plan, { url: 'https://example.test/v2.jpg', pathStorage: plan.path }, UID_MOTO, serverTimestamp(), 'verPuenteAAA1'),
    { merge: true })
  b.set(doc(db, 'ordenes_deposito', DEP_PB, 'eventos', 'verPuenteAAA1'),
    eventoReemplazoBoucher(plan, { uid: UID_MOTO, rol: 'motorizado' }, serverTimestamp()))
  await assertSucceeds(b.commit())
})

test('P2c · reemplazo versionado de staff ⇒ ALLOW', finalesYPuente, async () => {
  await depositoPuente('en_revision')
  const plan = planReemplazoBoucher({ id: DEP_PB, motorizadoUid: UID_MOTO }, 'verPuenteBBB1', 'El monto estaba tapado')
  await assertSucceeds(uploadBytes(ref(storageDe(UID_GESTOR), plan.path), jpeg(), META_JPEG))
  const db = firestoreDe(UID_GESTOR)
  const b = writeBatch(db)
  b.set(doc(db, 'ordenes_deposito', DEP_PB),
    camposReemplazoBoucher(plan, { url: 'https://example.test/v2.jpg', pathStorage: plan.path }, UID_MOTO, serverTimestamp(), 'verPuenteBBB1'),
    { merge: true })
  b.set(doc(db, 'ordenes_deposito', DEP_PB, 'eventos', 'verPuenteBBB1'),
    eventoReemplazoBoucher(plan, { uid: UID_GESTOR, rol: 'gestor' }, serverTimestamp()))
  await assertSucceeds(b.commit())
})

test('P2d · confirmar CON evento desde el cliente ⇒ DENY (FIN-1B: es de la callable)', finalesYPuente, async () => {
  await depositoPuente('en_revision')
  const db = firestoreDe(UID_GESTOR)
  const b = writeBatch(db)
  b.set(doc(db, 'ordenes_deposito', DEP_PB),
    camposConfirmarDeposito(UID_GESTOR, serverTimestamp(), 'evPB2'), { merge: true })
  b.set(doc(db, 'ordenes_deposito', DEP_PB, 'eventos', 'evPB2'),
    camposEventoDepositoConfirmado({ uid: UID_GESTOR, rol: 'gestor' }, serverTimestamp()))
  await assertFails(b.commit())
})

test('P2e · rehacer auditado desde el cliente ⇒ DENY (FIN-1B: es de la callable)', finalesYPuente, async () => {
  await depositoPuente('confirmado')
  const db = firestoreDe(UID_ADMIN)
  const b = writeBatch(db)
  b.set(doc(db, 'ordenes_deposito', DEP_PB),
    camposRehacerDeposito(UID_ADMIN, serverTimestamp(), 'El comprobante era de otro depósito', 'evPB3'), { merge: true })
  b.set(doc(db, 'ordenes_deposito', DEP_PB, 'eventos', 'evPB3'),
    camposEventoDepositoRehecho({ uid: UID_ADMIN, rol: 'admin' }, serverTimestamp(), 'El comprobante era de otro depósito'))
  await assertFails(b.commit())
})

test('P2f · anular auditado, con liberación de órdenes, desde el cliente ⇒ DENY (FIN-1B: es de la callable)', finalesYPuente, async () => {
  await depositoPuente('confirmado')
  const db = firestoreDe(UID_ADMIN)
  const b = writeBatch(db)
  b.set(doc(db, 'ordenes_deposito', DEP_PB),
    camposAnularDeposito(UID_ADMIN, serverTimestamp(), 'Órdenes equivocadas', 'evPB4'), { merge: true })
  b.set(doc(db, 'ordenes_deposito', DEP_PB, 'eventos', 'evPB4'),
    camposEventoDepositoAnulado({ uid: UID_ADMIN, rol: 'admin' }, serverTimestamp(), 'Órdenes equivocadas'))
  b.update(doc(db, 'solicitudes_envio', ORDEN_PB), { 'registro.deposito.storkhubDepositoId': null })
  await assertFails(b.commit())
})

// ─── El puente no abre de más ───────────────────────────────────────────────

test('P2g · el puente NO relaja el sellado de F1 ni el path versionado', finalesYPuente, async () => {
  // Un depósito confirmado sigue sin admitir comprobante nuevo, y una versión
  // escrita sigue sin poder sobrescribirse ni borrarse.
  await depositoPuente('confirmado')
  await assertFails(updateDoc(doc(firestoreDe(UID_ADMIN), 'ordenes_deposito', DEP_PB), {
    boucher: { url: 'https://example.test/x.jpg', pathStorage: 'x' },
  }))
  await assertFails(subir(UID_ADMIN, pathVersionBoucher(UID_MOTO, DEP_PB, 'verSelladaAA1')))
  await depositoPuente('en_revision')
  const path = pathVersionBoucher(UID_MOTO, DEP_PB, 'verInmutableA1')
  await env.withSecurityRulesDisabled(async (ctx) => { await uploadBytes(ref(ctx.storage(), path), jpeg(), META_JPEG) })
  await assertFails(subir(UID_GESTOR, path, jpeg(2048)))
  await assertFails(deleteObject(ref(storageDe(UID_ADMIN), path)))
})

test('P2h · el puente NO relaja "Pedir corrección": sin motivo ni evento ⇒ DENY', finalesYPuente, async () => {
  await depositoPuente('en_revision')
  await assertFails(updateDoc(doc(firestoreDe(UID_GESTOR), 'ordenes_deposito', DEP_PB), { estado: 'devuelto' }))
})

test('P2i · el puente NO relaja la anulación auditada de un A/B ⇒ DENY sin evento', finalesYPuente, async () => {
  await depositoPuente('en_revision')
  await assertFails(updateDoc(doc(firestoreDe(UID_ADMIN), 'ordenes_deposito', DEP_PB), {
    estado: 'anulado', anuladoAt: serverTimestamp(), anuladoPorUid: UID_ADMIN, motivoAnulacion: 'motivo suficiente',
  }))
})

// ─── El cierre final sí ocurre ──────────────────────────────────────────────

test('P3a · Rules finales + delete legacy ⇒ DENY (el cierre ocurre)', soloFinales, async () => {
  for (const estado of ['pendiente_boucher', 'en_revision', 'confirmado']) {
    await depositoPuente(estado)
    await assertFails(deleteDoc(doc(firestoreDe(UID_GESTOR), 'ordenes_deposito', DEP_PB)))
    await assertFails(deleteDoc(doc(firestoreDe(UID_ADMIN), 'ordenes_deposito', DEP_PB)))
  }
})

test('P3b · Rules finales + confirmar/rehacer sin evento ⇒ DENY', soloFinales, async () => {
  await depositoPuente('en_revision')
  await assertFails(setDoc(doc(firestoreDe(UID_GESTOR), 'ordenes_deposito', DEP_PB), {
    estado: 'confirmado', confirmadoPorUid: UID_GESTOR, confirmadoAt: serverTimestamp(),
  }, { merge: true }))
  await depositoPuente('confirmado')
  await assertFails(setDoc(doc(firestoreDe(UID_ADMIN), 'ordenes_deposito', DEP_PB), {
    estado: 'en_revision',
  }, { merge: true }))
})

test('P3c · Rules finales + reemplazo directo de staff ⇒ DENY (Firestore y Storage)', soloFinales, async () => {
  await depositoPuente('en_revision')
  await assertFails(setDoc(doc(firestoreDe(UID_GESTOR), 'ordenes_deposito', DEP_PB), {
    boucher: { url: 'https://example.test/nuevo.jpg', pathStorage: 'x' },
  }, { merge: true }))
  await env.withSecurityRulesDisabled(async (ctx) => {
    await uploadBytes(ref(ctx.storage(), `depositos/${UID_MOTO}/${DEP_PB}/boucher.jpg`), jpeg(), META_JPEG)
  })
  await assertFails(subir(UID_GESTOR, `depositos/${UID_MOTO}/${DEP_PB}/boucher.jpg`, jpeg(2048)))
})

// ─── HARDENING FINAL · DG en Storage ─────────────────────────────────────────
//
// El digitador versiona igual que todos, con su propia pertenencia
// (`digitadoPorUid`) y solo desde 'en_revision'.

const depDigitado = (estado: string, extra: Record<string, unknown> = {}) =>
  deposito(estado, { digitadoPorUid: UID_DIGITADOR, ...extra })

test('DG3s · digitador sube una versión de SU digitación en revisión ⇒ ALLOW', soloNuevas, async () => {
  await depDigitado('en_revision')
  await assertSucceeds(subir(UID_DIGITADOR, pathNuevaVersion()))
})

test('DG7s · digitación ajena, o depósito sin digitar ⇒ DENY', soloNuevas, async () => {
  await depDigitado('en_revision', { digitadoPorUid: 'uid_otro_digitador' })
  await assertFails(subir(UID_DIGITADOR, pathNuevaVersion()))
  await deposito('en_revision')
  await assertFails(subir(UID_DIGITADOR, pathNuevaVersion()))
})

test('DG8s-DG10s · confirmado, convertido, anulado y rechazado ⇒ DENY', soloNuevas, async () => {
  for (const estado of ['confirmado', 'convertido_en_deuda', 'anulado', 'rechazado']) {
    await depDigitado(estado)
    await assertFails(subir(UID_DIGITADOR, pathNuevaVersion()))
  }
})

test('DG11s · update y delete de una versión del digitador ⇒ DENY', soloNuevas, async () => {
  await depDigitado('en_revision')
  const path = await sembrarVersion()
  await assertFails(subir(UID_DIGITADOR, path, jpeg(2048)))
  await assertFails(deleteObject(ref(storageDe(UID_DIGITADOR), path)))
})

test('DG12s · devuelto y pendiente_boucher quedan fuera del versionado del digitador ⇒ DENY', soloNuevas, async () => {
  // 'devuelto' es del motorizado titular; 'pendiente_boucher' es primera carga.
  for (const estado of ['devuelto', 'pendiente_boucher']) {
    await depDigitado(estado)
    await assertFails(subir(UID_DIGITADOR, pathNuevaVersion()))
  }
})

test('DG14s · el digitador tampoco versiona un tipo C ⇒ DENY', soloNuevas, async () => {
  await depDigitado('en_revision', { tipo: 'pago_delivery_deposito' })
  await assertFails(subir(UID_DIGITADOR, pathNuevaVersion()))
})

// ─── ROLLOUT · el digitador en las tres matrices ─────────────────────────────

test('P1g · web F1 digitador: corrección legacy en revisión ⇒ ALLOW bajo el puente', f1YPuente, async () => {
  await depositoPuente('en_revision', { digitadoPorUid: UID_DIGITADOR, digitadoAt: new Date() })
  // Storage: pisa boucher.jpg, como lo hace el web viejo.
  await assertSucceeds(subir(UID_DIGITADOR, `depositos/${UID_MOTO}/${DEP_PB}/boucher.jpg`))
  // Firestore: escribe `boucher` a secas, sin versión ni evento.
  await assertSucceeds(setDoc(doc(firestoreDe(UID_DIGITADOR), 'ordenes_deposito', DEP_PB), {
    boucher: { url: 'https://example.test/dig.jpg', pathStorage: `depositos/${UID_MOTO}/${DEP_PB}/boucher.jpg` },
    updatedAt: serverTimestamp(),
  }, { merge: true }))
})

test('P2j · web F2 digitador: reemplazo versionado ⇒ ALLOW bajo el puente y las finales', finalesYPuente, async () => {
  await depositoPuente('en_revision', { digitadoPorUid: UID_DIGITADOR, digitadoAt: new Date() })
  const plan = planReemplazoBoucher({ id: DEP_PB, motorizadoUid: UID_MOTO }, 'verDigPuente1', 'El monto estaba tapado')
  await assertSucceeds(uploadBytes(ref(storageDe(UID_DIGITADOR), plan.path), jpeg(), META_JPEG))
  const db = firestoreDe(UID_DIGITADOR)
  const b = writeBatch(db)
  b.set(doc(db, 'ordenes_deposito', DEP_PB),
    camposReemplazoBoucher(plan, { url: 'https://example.test/v2.jpg', pathStorage: plan.path }, UID_MOTO, serverTimestamp(), 'verDigPuente1'),
    { merge: true })
  b.set(doc(db, 'ordenes_deposito', DEP_PB, 'eventos', 'verDigPuente1'),
    eventoReemplazoBoucher(plan, { uid: UID_DIGITADOR, rol: 'digitador' }, serverTimestamp()))
  await assertSucceeds(b.commit())
})

test('P3d · Rules finales: el overwrite legacy del digitador ⇒ DENY', soloFinales, async () => {
  await depositoPuente('en_revision', { digitadoPorUid: UID_DIGITADOR, digitadoAt: new Date() })
  await env.withSecurityRulesDisabled(async (ctx) => {
    await uploadBytes(ref(ctx.storage(), `depositos/${UID_MOTO}/${DEP_PB}/boucher.jpg`), jpeg(), META_JPEG)
  })
  await assertFails(subir(UID_DIGITADOR, `depositos/${UID_MOTO}/${DEP_PB}/boucher.jpg`, jpeg(2048)))
  await assertFails(setDoc(doc(firestoreDe(UID_DIGITADOR), 'ordenes_deposito', DEP_PB), {
    boucher: { url: 'https://example.test/dig.jpg', pathStorage: 'x' }, updatedAt: serverTimestamp(),
  }, { merge: true }))
})

test('P1h · la primera carga del digitador cruza el rollout en cualquier orden ⇒ ALLOW', async () => {
  await depositoPuente('pendiente_boucher', { digitadoPorUid: UID_DIGITADOR, digitadoAt: new Date(), boucher: null })
  await assertSucceeds(subir(UID_DIGITADOR, `depositos/${UID_MOTO}/${DEP_PB}/boucher.jpg`))
  await assertSucceeds(setDoc(doc(firestoreDe(UID_DIGITADOR), 'ordenes_deposito', DEP_PB), {
    boucher: { url: 'https://example.test/dig.jpg', pathStorage: `depositos/${UID_MOTO}/${DEP_PB}/boucher.jpg` },
    estado: 'en_revision',
    updatedAt: serverTimestamp(),
  }, { merge: true }))
})

// ─── A4-02 · SELLADO de la evidencia operativa y financiera ───────────────────
//
// Un id por caso: clearStorage() no vacía el bucket entre tests (ver SV).

let contadorA4 = 0
const idA4 = (prefijo: string) => `${prefijo}A4${String(++contadorA4).padStart(4, '0')}`
const META_PDF = { contentType: 'application/pdf' }

/** Orden sembrada sin reglas, con el motorizado dado como asignado. */
async function ordenA4(
  estado: string,
  extra: Record<string, unknown> = {},
  motorizadoAuthUid = UID_MOTO,
): Promise<string> {
  const id = idA4('ord')
  await env.withSecurityRulesDisabled(async (ctx) => {
    await setDoc(doc(ctx.firestore(), 'solicitudes_envio', id), {
      comercioUid: COMERCIO_ID,
      estado,
      asignacion: { motorizadoAuthUid, estadoAceptacion: 'aceptada' },
      ...extra,
    })
  })
  return id
}

/** Objeto ya existente, sin pasar por reglas (para probar overwrite/delete). */
async function plantar(path: string, meta: { contentType: string } = META_JPEG) {
  await env.withSecurityRulesDisabled(async (ctx) => {
    await uploadBytes(ref(ctx.storage(), path), jpeg(), meta)
  })
}

const pathEv = (orden: string, nombre: string) => `evidencias/${orden}/${nombre}`
const NOMBRES_OPERATIVOS = [
  'retiro.jpg', 'entrega.jpg',
  'terminal_paquete.jpg', 'terminal_ticket.jpg', 'terminal_bus.jpg',
  'cargotrans_factura.jpg', 'cargotrans_paquete_1.jpg', 'cargotrans_paquete_12.jpg',
]
const ESCRITORES_EVIDENCIA = [UID_MOTO, UID_GESTOR, UID_ADMIN]

test('ST-SEAL-1 · el flujo normal crea la evidencia ANTES de cambiar de estado ⇒ ALLOW', finalesYPuente, async () => {
  // retiro: se sube con la orden aún sin retirar (asignada / en_camino_retiro).
  for (const estado of ['asignada', 'en_camino_retiro']) {
    const o = await ordenA4(estado)
    await assertSucceeds(subir(UID_MOTO, pathEv(o, 'retiro.jpg')))
  }
  // entrega, terminal y cargotrans: se suben con la orden aún en camino.
  for (const estado of ['retirado', 'en_camino_entrega']) {
    const o = await ordenA4(estado)
    for (const nombre of NOMBRES_OPERATIVOS.filter((n) => n !== 'retiro.jpg')) {
      await assertSucceeds(subir(UID_MOTO, pathEv(o, nombre)))
    }
  }
  // Y el staff, antes del sello.
  const o2 = await ordenA4('en_camino_entrega')
  await assertSucceeds(subir(UID_GESTOR, pathEv(o2, 'entrega.jpg')))
  await assertSucceeds(subir(UID_ADMIN, pathEv(o2, 'terminal_bus.jpg')))
})

test('ST-SEAL-2 · corregir antes del sello (reintento tras un upload cuyo batch falló) ⇒ ALLOW', finalesYPuente, async () => {
  const o = await ordenA4('en_camino_retiro')
  await plantar(pathEv(o, 'retiro.jpg'))
  await assertSucceeds(subir(UID_MOTO, pathEv(o, 'retiro.jpg'), jpeg(2048)))
  const o2 = await ordenA4('en_camino_entrega')
  for (const nombre of ['entrega.jpg', 'terminal_paquete.jpg', 'cargotrans_paquete_1.jpg']) {
    await plantar(pathEv(o2, nombre))
    await assertSucceeds(subir(UID_MOTO, pathEv(o2, nombre), jpeg(2048)))
  }
  // retiro sigue editable hasta 'retirado', no hasta 'entregado'.
  await plantar(pathEv(o2, 'retiro.jpg'))
  await assertFails(subir(UID_MOTO, pathEv(o2, 'retiro.jpg'), jpeg(2048)))
})

test('ST-SEAL-3 · el motorizado asignado NO reemplaza la evidencia de una orden entregada ⇒ DENY', finalesYPuente, async () => {
  const o = await ordenA4('entregado')
  for (const nombre of NOMBRES_OPERATIVOS) {
    await plantar(pathEv(o, nombre))
    await assertFails(subir(UID_MOTO, pathEv(o, nombre), jpeg(2048)))
  }
})

test('ST-SEAL-4 · el staff tampoco: gestor y admin sin bypass de sellado ⇒ DENY', finalesYPuente, async () => {
  const o = await ordenA4('entregado')
  for (const nombre of NOMBRES_OPERATIVOS) {
    await plantar(pathEv(o, nombre))
    for (const uid of [UID_GESTOR, UID_ADMIN]) {
      await assertFails(subir(uid, pathEv(o, nombre), jpeg(2048)))
    }
  }
})

test('ST-SEAL-5 · borrar evidencia ⇒ DENY para todos, sellada o no', soloNuevas, async () => {
  for (const estado of ['en_camino_entrega', 'entregado']) {
    const o = await ordenA4(estado)
    for (const nombre of ['entrega.jpg', 'retiro.jpg', 'terminal_bus.jpg', 'cargotrans_factura.jpg']) {
      await plantar(pathEv(o, nombre))
      for (const uid of ESCRITORES_EVIDENCIA) {
        await assertFails(deleteObject(ref(storageDe(uid), pathEv(o, nombre))))
      }
    }
  }
})

test('ST-SEAL-6 · retiro: sellado desde retirado (también en_camino_entrega y entregado) ⇒ DENY para todos', finalesYPuente, async () => {
  for (const estado of ['retirado', 'en_camino_entrega', 'entregado']) {
    const o = await ordenA4(estado)
    await plantar(pathEv(o, 'retiro.jpg'))
    for (const uid of ESCRITORES_EVIDENCIA) {
      await assertFails(subir(uid, pathEv(o, 'retiro.jpg'), jpeg(2048)))
    }
  }
  // Y la PRIMERA escritura de un retiro que no existe tampoco, ya retirada la orden.
  const o2 = await ordenA4('retirado')
  await assertFails(subir(UID_MOTO, pathEv(o2, 'retiro.jpg')))
  await assertFails(subir(UID_GESTOR, pathEv(o2, 'retiro.jpg')))
})

test('ST-SEAL-7 · terminal_*: update post-entregado ⇒ DENY; primera escritura de staff post-entregado también ⇒ DENY', finalesYPuente, async () => {
  const o = await ordenA4('entregado')
  for (const nombre of ['terminal_paquete.jpg', 'terminal_ticket.jpg', 'terminal_bus.jpg']) {
    await plantar(pathEv(o, nombre))
    for (const uid of ESCRITORES_EVIDENCIA) {
      await assertFails(subir(uid, pathEv(o, nombre), jpeg(2048)))
    }
  }
  const o2 = await ordenA4('entregado')
  await assertFails(subir(UID_GESTOR, pathEv(o2, 'terminal_bus.jpg')))
  await assertFails(subir(UID_MOTO, pathEv(o2, 'terminal_bus.jpg')))
})

test('ST-SEAL-8 · cargotrans_*: update post-entregado ⇒ DENY; el gestor sí PUEDE crear la primera vez (flujo del panel) ⇒ ALLOW una sola vez', finalesYPuente, async () => {
  const o = await ordenA4('entregado')
  for (const nombre of ['cargotrans_factura.jpg', 'cargotrans_paquete_1.jpg', 'cargotrans_paquete_7.jpg']) {
    await plantar(pathEv(o, nombre))
    for (const uid of ESCRITORES_EVIDENCIA) {
      await assertFails(subir(uid, pathEv(o, nombre), jpeg(2048)))
    }
  }
  // SolicitudDrawer.handleCargotransUpload: orden entregada, aún sin fotos.
  const o2 = await ordenA4('entregado')
  await assertSucceeds(subir(UID_GESTOR, pathEv(o2, 'cargotrans_paquete_1.jpg')))
  await assertSucceeds(subir(UID_ADMIN, pathEv(o2, 'cargotrans_factura.jpg')))
  // ...y esa primera escritura ya quedó sellada: el reintento NO la pisa.
  await assertFails(subir(UID_GESTOR, pathEv(o2, 'cargotrans_paquete_1.jpg'), jpeg(2048)))
  // El motorizado, en cambio, no crea nada tras la entrega.
  await assertFails(subir(UID_MOTO, pathEv(o2, 'cargotrans_paquete_2.jpg')))
})

test('ST-SEAL-9 · reasignación: un motorizado nuevo NO pisa evidencia sellada; mientras la orden está abierta sí reemplaza (A) y el anterior ya no escribe', finalesYPuente, async () => {
  // Orden abierta (reasignable): el nuevo asignado reemplaza lo que dejó el anterior.
  const abierta = await ordenA4('en_camino_retiro', {}, UID_MOTO_2)
  await plantar(pathEv(abierta, 'retiro.jpg')) // lo subió UID_MOTO antes de la reasignación
  await assertSucceeds(subir(UID_MOTO_2, pathEv(abierta, 'retiro.jpg'), jpeg(2048)))
  await assertFails(subir(UID_MOTO, pathEv(abierta, 'retiro.jpg'), jpeg(2048))) // ya no es el asignado

  // Orden entregada con otro motorizado asignado: sellado, para el nuevo también.
  const cerrada = await ordenA4('entregado', {}, UID_MOTO_2)
  for (const nombre of ['retiro.jpg', 'entrega.jpg', 'terminal_bus.jpg']) {
    await plantar(pathEv(cerrada, nombre))
    await assertFails(subir(UID_MOTO_2, pathEv(cerrada, nombre), jpeg(2048)))
  }

  // Estado retrocedido a mano (rebotar escribe 'confirmada'/'asignada'): el hito
  // del servidor (historial.retiradoAt) mantiene el sello del retiro.
  const rebotada = await ordenA4('asignada', { historial: { retiradoAt: new Date() } }, UID_MOTO_2)
  await plantar(pathEv(rebotada, 'retiro.jpg'))
  await assertFails(subir(UID_MOTO_2, pathEv(rebotada, 'retiro.jpg'), jpeg(2048)))
  await assertFails(subir(UID_GESTOR, pathEv(rebotada, 'retiro.jpg'), jpeg(2048)))
  // ...y el de la entrega, con historial.entregadoAt.
  const rebotada2 = await ordenA4('asignada', { historial: { entregadoAt: new Date() } }, UID_MOTO_2)
  await plantar(pathEv(rebotada2, 'entrega.jpg'))
  await assertFails(subir(UID_MOTO_2, pathEv(rebotada2, 'entrega.jpg'), jpeg(2048)))
})

test('ST-SEAL-10 · fail-closed: orden inexistente y asignación ausente ⇒ DENY; el resto del contrato intacto', finalesYPuente, async () => {
  const fantasma = idA4('fantasma')
  await assertFails(subir(UID_GESTOR, pathEv(fantasma, 'entrega.jpg')))
  await assertFails(subir(UID_MOTO, pathEv(fantasma, 'entrega.jpg')))
  const sinAsignar = await ordenA4('en_camino_entrega', { asignacion: null })
  await assertFails(subir(UID_MOTO, pathEv(sinAsignar, 'entrega.jpg')))
  // Otro motorizado activo no asignado.
  const ajena = await ordenA4('en_camino_entrega')
  await assertFails(subir(UID_MOTO_2, pathEv(ajena, 'entrega.jpg')))
  // Metadata/tamaño intactos.
  await assertFails(subir(UID_MOTO, pathEv(ajena, 'entrega.jpg'), jpeg(1024), { contentType: 'application/pdf' }))
  await assertFails(subir(UID_MOTO, pathEv(ajena, 'entrega.jpg'), jpeg(5 * MB + 1)))
  await assertFails(subir(UID_MOTO, pathEv(ajena, 'peaje.jpg')))
})

test('ST-FIN-6 · delivery boucher: antes de pagado, contrato actual; después de pagado, overwrite ⇒ DENY', finalesYPuente, async () => {
  // Abierto: el comercio reemplaza el suyo y el gestor el suyo.
  const abierta = await ordenA4('entregado', { cobroDelivery: { estado: 'en_revision_deposito' } })
  await plantar(pathEv(abierta, 'delivery_boucher_comercio.jpg'))
  await plantar(pathEv(abierta, 'delivery_boucher_gestor.jpg'))
  await assertSucceeds(subir(UID_COMERCIO, pathEv(abierta, 'delivery_boucher_comercio.jpg'), jpeg(2048)))
  await assertSucceeds(subir(UID_GESTOR, pathEv(abierta, 'delivery_boucher_gestor.jpg'), jpeg(2048)))
  await assertFails(subir(UID_COMERCIO, pathEv(abierta, 'delivery_boucher_gestor.jpg'), jpeg(2048)))
  // Pagado: nadie.
  const pagada = await ordenA4('entregado', { cobroDelivery: { estado: 'pagado' } })
  await plantar(pathEv(pagada, 'delivery_boucher_comercio.jpg'))
  await plantar(pathEv(pagada, 'delivery_boucher_gestor.jpg'))
  await assertFails(subir(UID_COMERCIO, pathEv(pagada, 'delivery_boucher_comercio.jpg'), jpeg(2048)))
  await assertFails(subir(UID_GESTOR, pathEv(pagada, 'delivery_boucher_gestor.jpg'), jpeg(2048)))
  await assertFails(subir(UID_ADMIN, pathEv(pagada, 'delivery_boucher_gestor.jpg'), jpeg(2048)))
})

// ─── Financiero: saldos/abono_N y liquidaciones/comprobante.pdf ───────────────

async function saldoA4(abonos: unknown[]): Promise<string> {
  const id = idA4('saldo')
  await env.withSecurityRulesDisabled(async (ctx) => {
    await setDoc(doc(ctx.firestore(), 'saldos_cargo_motorizado', id), { estado: 'pendiente', abonos })
  })
  return id
}
const pathAbono = (saldo: string, n: number) => `saldos/${saldo}/abono_${n}.jpg`

test('ST-FIN-1 · abono: la primera escritura de staff ⇒ ALLOW; el resto de roles ⇒ DENY', finalesYPuente, async () => {
  const s = await saldoA4([])
  await assertSucceeds(subir(UID_GESTOR, pathAbono(s, 0)))
  await assertSucceeds(subir(UID_ADMIN, pathAbono(s, 1)))
  // Sin documento de saldo también: el objeto se sube ANTES de la callable.
  await assertSucceeds(subir(UID_GESTOR, pathAbono(idA4('saldoSinDoc'), 0)))
  for (const uid of [UID_MOTO, UID_COMERCIO, UID_DIGITADOR]) {
    await assertFails(subir(uid, pathAbono(s, 5)))
  }
  await assertFails(subir(UID_GESTOR, `saldos/${s}/otro.jpg`))
  await assertFails(subir(UID_GESTOR, pathAbono(s, 9), jpeg(1024), { contentType: 'application/pdf' }))
})

test('ST-FIN-1b · reintento legítimo: mientras el abono N no se registró, el staff reemplaza el MISMO abono_N ⇒ ALLOW', finalesYPuente, async () => {
  const s = await saldoA4([{ operacionId: 'a0' }]) // abono 0 registrado; el próximo es el N=1
  await plantar(pathAbono(s, 1))                    // subido, pero la callable falló
  await assertSucceeds(subir(UID_GESTOR, pathAbono(s, 1), jpeg(2048)))
  await assertSucceeds(subir(UID_ADMIN, pathAbono(s, 1), jpeg(4096)))
})

test('ST-FIN-2 · abono ya registrado (abonos[] llegó a N+1) ⇒ overwrite DENY para staff, admin incluido; delete DENY siempre', finalesYPuente, async () => {
  const s = await saldoA4([{ operacionId: 'a0' }, { operacionId: 'a1' }])
  await plantar(pathAbono(s, 0))
  await plantar(pathAbono(s, 1))
  for (const uid of [UID_GESTOR, UID_ADMIN]) {
    await assertFails(subir(uid, pathAbono(s, 0), jpeg(2048)))
    await assertFails(subir(uid, pathAbono(s, 1), jpeg(2048)))
  }
  // El siguiente (N=2) sigue libre.
  await assertSucceeds(subir(UID_GESTOR, pathAbono(s, 2)))
  // Delete: nunca.
  for (const uid of [UID_GESTOR, UID_ADMIN]) {
    await assertFails(deleteObject(ref(storageDe(uid), pathAbono(s, 0))))
    await assertFails(deleteObject(ref(storageDe(uid), pathAbono(s, 2))))
  }
  // Saldo inexistente + objeto existente: fail-closed.
  const huerfano = idA4('saldoHuerfano')
  await plantar(pathAbono(huerfano, 0))
  await assertFails(subir(UID_GESTOR, pathAbono(huerfano, 0), jpeg(2048)))
})

const pathLiq = (id: string) => `liquidaciones/${id}/comprobante.pdf`

test('ST-FIN-3 · liquidación: crear el PDF ⇒ ALLOW para staff (la liquidación ya está pagada); otros roles ⇒ DENY', finalesYPuente, async () => {
  const l = idA4('liq')
  await env.withSecurityRulesDisabled(async (ctx) => {
    await setDoc(doc(ctx.firestore(), 'liquidaciones_motorizado', l), { estado: 'pagado' })
  })
  await assertSucceeds(subir(UID_GESTOR, pathLiq(l), jpeg(2048), META_PDF))
  await assertSucceeds(subir(UID_ADMIN, pathLiq(idA4('liq')), jpeg(2048), META_PDF))
  await assertFails(subir(UID_MOTO, pathLiq(idA4('liq')), jpeg(2048), META_PDF))
  await assertFails(subir(UID_GESTOR, pathLiq(idA4('liq')), jpeg(2048), META_JPEG)) // MIME
  await assertFails(subir(UID_GESTOR, `liquidaciones/${l}/otro.pdf`, jpeg(2048), META_PDF))
})

test('ST-FIN-4 · liquidación ya con PDF: overwrite ⇒ DENY para staff y admin; delete ⇒ DENY', finalesYPuente, async () => {
  const l = idA4('liq')
  await plantar(pathLiq(l), META_PDF)
  for (const uid of [UID_GESTOR, UID_ADMIN]) {
    await assertFails(subir(uid, pathLiq(l), jpeg(4096), META_PDF))
    await assertFails(deleteObject(ref(storageDe(uid), pathLiq(l))))
  }
})

test('ST-FIN-5 · regresión del voucher de depósito: legacy mutable solo en pendiente_boucher; versionados create-only; sellados ⇒ DENY', soloNuevas, async () => {
  // pendiente_boucher: primera carga y reintento (contrato actual).
  await deposito('pendiente_boucher')
  await assertSucceeds(subir(UID_MOTO, PATH_DEP))
  await assertSucceeds(subir(UID_MOTO, PATH_DEP, jpeg(2048)))
  // en_revision: el legacy ya no se reemplaza; la corrección es versionada y create-only.
  await deposito('en_revision')
  await assertFails(subir(UID_MOTO, PATH_DEP, jpeg(4096)))
  const version = pathNuevaVersion()
  await assertSucceeds(subir(UID_MOTO, version))
  await assertFails(subir(UID_MOTO, version, jpeg(2048)))
  await assertFails(subir(UID_GESTOR, version, jpeg(2048)))
  // sellados: nadie.
  for (const estado of ['confirmado', 'convertido_en_deuda', 'anulado']) {
    await deposito(estado)
    await assertFails(subir(UID_MOTO, PATH_DEP, jpeg(4096)))
    await assertFails(subir(UID_GESTOR, PATH_DEP, jpeg(4096)))
    await assertFails(subir(UID_ADMIN, pathNuevaVersion()))
  }
})
