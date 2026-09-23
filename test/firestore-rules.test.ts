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
import {
  camposEventoBoucherReemplazado,
  camposEventoDepositoAnulado,
  camposEventoDepositoConfirmado,
  camposEventoDepositoDevuelto,
  camposEventoDepositoRehecho,
} from '../lib/deposito-eventos'
import {
  camposReemplazoBoucher,
  planReemplazoBoucher,
  pathVersionBoucher,
} from '../lib/deposito-boucher-version'
import {
  camposAnularDeposito,
  camposConfirmarDeposito,
  camposPedirCorreccion,
  camposRehacerDeposito,
} from '../lib/deposito-correccion'

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

test('N · gestor confirma un depósito sin tocar la identidad ⇒ ALLOW', async () => {
  // HARDENING — confirmar exige su evento. El depósito nace sin boucher
  // (pendiente_boucher), así que adjuntarlo acá es la PRIMERA subida del
  // flujo inicial, no un reemplazo: sigue permitida sin versionar.
  const id = await depositoConCodigo('depN', { estado: 'pendiente_boucher' })
  const { b } = batchConfirmar(UID_GESTOR, id, {
    boucher: { url: 'https://example.test/b.jpg', pathStorage: 'x' },
  })
  await assertSucceeds(b.commit())
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
  // HARDENING — mismo payload de siempre más el evento obligatorio.
  const { b } = batchConfirmar(UID_GESTOR, id, {
    boucher: { url: 'https://example.test/b.jpg', pathStorage: 'x' },
  })
  await assertSucceeds(b.commit())
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
  // HARDENING — Rehacer exige DEPOSITO_REHECHO con motivo, en el mismo batch.
  const { db, b } = batchRehacer(UID_ADMIN, 'depD')
  b.update(doc(db, 'solicitudes_envio', ORDEN_D), {
    'registro.deposito.storkhubDepositoId': 'depD',
    'registro.deposito.confirmadoStorkhub': false,
    'registro.deposito.confirmadoStorkhubAt': null,
  })
  await assertSucceeds(b.commit())
})

// DEPOSITO-AUDITORIA-1 — el payload de Z2 era un delete del depósito. Esa
// vía dejó de existir: el admin ANULA y libera la orden en el mismo batch,
// con el mismo efecto operativo y sin perder el documento.
test('Z2 · admin anula el depósito y libera la orden en el mismo batch ⇒ ALLOW', async () => {
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
  await assertSucceeds(b.commit())
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
  await assertFails(updateDoc(doc(db, 'ordenes_deposito', 'depI'), { boucher: deleteField() }))
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

test('BI5 · gestor anula un DEP tipo C confirmado sin tocar su comprobante ⇒ ALLOW', async () => {
  await depositoEn('confirmado', { tipo: 'pago_delivery_deposito', boucherUrl: 'https://example.test/c.jpg' })
  await assertSucceeds(updateDoc(doc(como(UID_GESTOR), 'ordenes_deposito', 'depI'), {
    estado: 'anulado',
    anuladoAt: serverTimestamp(),
    anuladoPorUid: UID_GESTOR,
    motivoAnulacion: 'Reversión de cobro contado por gestor',
  }))
})

// HARDENING — las dos mitades cambian: Rehacer exige evento, y una vez
// abierto el depósito el reemplazo ya no es un update suelto sino una versión.
test('BI6 · admin rehace un confirmado con evento ⇒ ALLOW; el reemplazo directo posterior ⇒ DENY', async () => {
  await depositoEn('confirmado')
  await assertSucceeds(batchRehacer(UID_ADMIN, 'depI').b.commit())
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
  // HARDENING — la confirmación viaja con su evento; el resto del batch
  // (los flags de la orden) queda igual que en F1.
  const { db, b } = batchConfirmar(UID_GESTOR, 'depA')
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

test('AD1 · admin rehace un depósito confirmado, con evento y motivo ⇒ ALLOW', async () => {
  await depositoEn('confirmado')
  await assertSucceeds(batchRehacer(UID_ADMIN, 'depI').b.commit())
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

test('AD6 · gestor confirma un depósito en revisión, con evento ⇒ ALLOW (sin regresión)', async () => {
  await depositoEn('en_revision')
  await assertSucceeds(batchConfirmar(UID_GESTOR, 'depI').b.commit())
})

test('AD7 · gestor sigue anulando un DEP tipo C confirmado (Revertir), pero no un tipo A ⇒ ALLOW / DENY', async () => {
  await depositoEn('confirmado', { tipo: 'pago_delivery_deposito', boucherUrl: 'https://example.test/c.jpg' })
  await assertSucceeds(updateDoc(doc(como(UID_GESTOR), 'ordenes_deposito', 'depI'), { estado: 'anulado', anuladoAt: serverTimestamp() }))
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
    await assertFails(updateDoc(doc(como(uid), 'ordenes_deposito', 'depI'), { boucher: deleteField() }))
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

test('SL3 · sellados, lo que no es el boucher sigue como antes: saldoId tras convertir, notas ⇒ ALLOW', async () => {
  await depositoEn('convertido_en_deuda')
  await assertSucceeds(updateDoc(doc(como(UID_GESTOR), 'ordenes_deposito', 'depI'), { saldoId: 'saldo1' }))
  await depositoEn('anulado')
  await assertSucceeds(updateDoc(doc(como(UID_GESTOR), 'ordenes_deposito', 'depI'), { notaConversion: 'ok' }))
})

test('SL4 · abiertos siguen abiertos: gestor reemplaza en pendiente_boucher y rechazado ⇒ ALLOW', async () => {
  await depositoEn('pendiente_boucher')
  await assertSucceeds(updateDoc(doc(como(UID_GESTOR), 'ordenes_deposito', 'depI'), NUEVO_BOUCHER))
  await depositoEn('rechazado')
  await assertSucceeds(updateDoc(doc(como(UID_GESTOR), 'ordenes_deposito', 'depI'), NUEVO_BOUCHER))
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

test('D6b · un devuelto todavía se puede convertir en deuda ⇒ ALLOW (la salida financiera no se cierra)', async () => {
  await depositoAB('devuelto', { devueltoPorUid: UID_GESTOR, motivoDevolucion: 'otra foto' })
  await assertSucceeds(updateDoc(doc(como(UID_GESTOR), 'ordenes_deposito', DEP_V), {
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

test('A1 · admin anula un A/B con motivo y evento, y libera la orden ⇒ ALLOW', async () => {
  await depositoAB('en_revision')
  await assertSucceeds(anular({ liberarOrden: true }))
  const dep = await leerDep()
  assert.equal(dep.estado, 'anulado')
  assert.equal(dep.anuladoPorUid, UID_ADMIN)
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

test('A5 · el anulado conserva DEP-N, comprobante, órdenes y eventos', async () => {
  await depositoAB('en_revision')
  await assertSucceeds(anular({ eventoId: 'evAnul1' }))
  const dep = await leerDep()
  assert.equal(dep.codigo, 'DEP-0007')
  assert.equal(dep.secuencia, 7)
  assert.ok(dep.boucher)
  assert.deepEqual(dep.solicitudIds, [ORDEN_V])
  assert.equal(dep.motivoAnulacion, 'Depósito armado sobre las órdenes equivocadas')
  let evento: Record<string, unknown> = {}
  await env.withSecurityRulesDisabled(async (ctx) => {
    evento = ((await getDoc(doc(ctx.firestore(), 'ordenes_deposito', DEP_V, 'eventos', 'evAnul1'))).data() ?? {}) as Record<string, unknown>
  })
  assert.equal(evento.tipo, 'DEPOSITO_ANULADO')
  assert.equal(evento.porRol, 'admin')
})

test('A6 · el tipo C sigue anulándose como siempre desde Revertir ⇒ ALLOW (sin regresión)', async () => {
  await depositoAB('confirmado', { tipo: 'pago_delivery_deposito', boucherUrl: 'https://example.test/c.jpg' })
  await assertSucceeds(updateDoc(doc(como(UID_GESTOR), 'ordenes_deposito', DEP_V), {
    estado: 'anulado', anuladoAt: serverTimestamp(), anuladoPorUid: UID_GESTOR,
    motivoAnulacion: 'Reversión de cobro contado por gestor',
  }))
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

test('AU2 · confirmar con evento válido ⇒ ALLOW (A y B, gestor y admin)', async () => {
  await depositoAB('en_revision')
  await assertSucceeds(confirmarCon())
  await depositoAB('en_revision')
  await assertSucceeds(confirmarCon({ uid: UID_ADMIN }))
  await depositoAB('en_revision', { tipo: 'recaudacion_motorizado_comercio', destinatario: 'comercio' })
  await assertSucceeds(confirmarCon())
  // Y desde pendiente_boucher, que es el flujo del gestor que registra.
  await depositoAB('pendiente_boucher')
  await assertSucceeds(confirmarCon())
})

test('AU3 · rehacer sin DEPOSITO_REHECHO ⇒ DENY', async () => {
  await depositoAB('confirmado')
  await assertFails(rehacerCon({ sinEvento: true }))
  await depositoAB('confirmado')
  await assertFails(setDoc(doc(como(UID_ADMIN), 'ordenes_deposito', DEP_V), { estado: 'en_revision' }, { merge: true }))
})

test('AU4 · rehacer con evento válido ⇒ ALLOW (A y B)', async () => {
  await depositoAB('confirmado')
  await assertSucceeds(rehacerCon())
  await depositoAB('confirmado', { tipo: 'recaudacion_motorizado_comercio', destinatario: 'comercio' })
  await assertSucceeds(rehacerCon())
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

test('AU6 · anular con evento válido ⇒ ALLOW (A y B)', async () => {
  await depositoAB('en_revision')
  await assertSucceeds(anular())
  await depositoAB('confirmado', { tipo: 'recaudacion_motorizado_comercio', destinatario: 'comercio' })
  await assertSucceeds(anular())
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

test('AU11 · el tipo C no entra en ninguna de las tres exigencias (regresión intacta)', async () => {
  // Su DEP nace ya confirmado junto al cobro y se revierte desde Cobros.
  await depositoAB('en_revision', { tipo: 'pago_delivery_deposito', boucherUrl: 'https://example.test/c.jpg' })
  await assertSucceeds(updateDoc(doc(como(UID_GESTOR), 'ordenes_deposito', DEP_V), {
    estado: 'confirmado', confirmadoPorUid: UID_GESTOR, confirmadoAt: serverTimestamp(),
  }))
  await depositoAB('confirmado', { tipo: 'pago_delivery_deposito', boucherUrl: 'https://example.test/c.jpg' })
  await assertSucceeds(updateDoc(doc(como(UID_GESTOR), 'ordenes_deposito', DEP_V), {
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
  await assertFails(updateDoc(ref, { boucher: deleteField() }))
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

test('ST11 · lo que NO es el comprobante sigue funcionando para staff', async () => {
  // El guard mira solo los cuatro campos del puntero: confirmar, pedir
  // corrección, convertir en deuda y anotar notas no lo tocan.
  await depositoAB('en_revision')
  await assertSucceeds(pedirCorreccion())
  await depositoAB('en_revision')
  await assertSucceeds(confirmarCon())
  await depositoAB('en_revision')
  await assertSucceeds(updateDoc(doc(como(UID_GESTOR), 'ordenes_deposito', DEP_V), {
    estado: 'convertido_en_deuda', saldoId: 'saldo1',
  }))
  await depositoAB('en_revision')
  await assertSucceeds(updateDoc(doc(como(UID_GESTOR), 'ordenes_deposito', DEP_V), {
    notaConversion: 'revisado con el motorizado', updatedAt: serverTimestamp(),
  }))
})

test('ST12 · el flujo inicial no se rompe: adjuntar el PRIMER boucher sigue permitido', async () => {
  // pendiente_boucher es la primera subida (create-first del motorizado,
  // confirmarStorkhub/Comercio del gestor, digitación), no un reemplazo.
  await depositoAB('pendiente_boucher')
  await assertSucceeds(updateDoc(doc(como(UID_GESTOR), 'ordenes_deposito', DEP_V), {
    boucher: { url: 'https://example.test/primero.jpg', pathStorage: 'x' },
  }))
  // Y el digitador completa su digitación desde 'pendiente_boucher' —primera
  // carga, no reemplazo— igual que antes.
  await depositoAB('pendiente_boucher', { digitadoPorUid: UID_DIGITADOR, digitadoAt: new Date() })
  await assertSucceeds(updateDoc(doc(como(UID_DIGITADOR), 'ordenes_deposito', DEP_V), {
    boucher: { url: 'https://example.test/dig.jpg', pathStorage: 'x' },
    estado: 'en_revision',
    updatedAt: serverTimestamp(),
  }))
})

test('ST13 · el tipo C no queda atrapado por el guard de versionado', async () => {
  await depositoAB('en_revision', { tipo: 'pago_delivery_deposito', boucherUrl: 'https://example.test/c.jpg' })
  await assertSucceeds(updateDoc(doc(como(UID_GESTOR), 'ordenes_deposito', DEP_V), {
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
  await assertFails(updateDoc(ref, { boucher: deleteField() }))
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

test('VR15 · gestor y admin conservan lo administrativo y lo financiero', async () => {
  // Confirmar y asignar: intactos.
  const id = await ordenConCodigo('vr15', { estado: 'pendiente_confirmacion' })
  await assertSucceeds(updateDoc(doc(como(UID_GESTOR), 'solicitudes_envio', id), {
    estado: 'confirmada',
    confirmacion: { precioFinalCordobas: 90, confirmadoPorUid: UID_GESTOR, confirmadoAt: serverTimestamp() },
    updatedAt: serverTimestamp(),
  }))
  await assertSucceeds(updateDoc(doc(como(UID_GESTOR), 'solicitudes_envio', id), {
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
  // Y una escritura financiera sobre una orden YA entregada, que no mueve
  // estado, sigue permitida: es la que usa lib/financial-writes.ts.
  const id4 = await ordenConCodigo('vr15d', { estado: 'entregado' })
  await assertSucceeds(updateDoc(doc(como(UID_GESTOR), 'solicitudes_envio', id4), {
    'registro.deposito.storkhubDepositoId': 'depX',
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
