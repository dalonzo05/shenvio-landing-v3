// DEPOSITO-AUDITORIA-1 — Versionado inmutable del comprobante de un depósito.
//
// F1 cerró la integridad del objeto (STORAGE-EVIDENCIA-INTEGRIDAD-1) pero
// dejó el comprobante en un PATH FIJO:
//
//     depositos/{uid}/{depId}/boucher.jpg
//
// Con un solo path, "corregir el comprobante" solo podía significar dos
// cosas, y las dos perdían historia: pisar el objeto (el anterior deja de
// existir, sin rastro de que existió) o borrar el depósito entero y empezar
// de cero (que era lo que hacía "Devolver al motorizado": adiós DEP-N, adiós
// relaciones, adiós boucher). Por eso F1 cerró el reemplazo del motorizado en
// 'en_revision': sin versionado no había forma honesta de permitirlo.
//
// F2 abre el reemplazo con un path por VERSIÓN:
//
//     depositos/{uid}/{depId}/bouchers/{versionId}.jpg
//
// CREATE ONLY en storage.rules: update DENY, delete DENY. Una versión escrita
// no se toca nunca más, ni por el motorizado ni por staff ni por admin. El
// depósito conserva un puntero al vigente (`boucher`) y dos campos que dicen
// CUÁL es: `boucherVersion` y `boucherVersionId`.
//
// ─── Legacy ───────────────────────────────────────────────────────────────
//
// Los depósitos que ya existen (DEP-0001, DEP-0003, DEP-0004, DEP-0005) no
// tienen ninguno de los dos campos, y NO se migran: no se copia el objeto, no
// se reescribe el documento, no se toca staging. Se leen como VERSIÓN 1
// IMPLÍCITA — `versionEfectivaBoucher()` devuelve 1 cuando el campo falta. El
// primer reemplazo de uno de ellos escribe la v2 en el path nuevo y deja el
// `boucher.jpg` original intacto, que es exactamente lo que "conservar
// versiones anteriores" quiere decir.
//
// Migrar habría sido peor: copiar bytes de una evidencia financiera para que
// "encaje" en un esquema nuevo altera la evidencia sin necesidad, y un
// backfill a medias dejaría depósitos afirmando una v1 que no está donde dice.
//
// ─── Concurrencia ─────────────────────────────────────────────────────────
//
// Dos reemplazos simultáneos NO pueden ganar los dos. La garantía no vive en
// este módulo (que es puro) sino en firestore.rules, que exige
// `nueva.boucherVersion == efectiva(actual) + 1`: el segundo batch evalúa
// contra el estado ya commiteado por el primero, le sale 2 != 3 y muere.
// Acá solo se calcula el número; el que decide es el servidor.
//
// PURO: sin Firestore, sin React, sin efectos. El `versionId` lo genera quien
// llama (doc(collection(db,…)).id en la app) — este módulo no inventa ids.

import type { DepositoRegistrado } from './deposito-orden'
import {
  EVENTO_BOUCHER_REEMPLAZADO,
  camposEventoBoucherReemplazado,
  asegurarMotivoEvento,
  type ActorEventoDeposito,
} from './deposito-eventos'

// ─── Versión efectiva ─────────────────────────────────────────────────────────

/** Lo que vale un depósito histórico que nunca se reemplazó. */
export const VERSION_BOUCHER_LEGACY = 1

// Partial del documento entero, y no un Pick de los dos campos de versión:
// los llamadores pasan el DEP tal como lo tienen (con tipo, estado, monto…) y
// un Pick estrecho los obligaría a recortarlo en cada call site. Lo que este
// módulo LEE sigue siendo solo `boucherVersion` y `boucherVersionId`.
type DepVersionado = Partial<DepositoRegistrado>

/**
 * Qué versión del comprobante está vigente.
 *
 * Sin `boucherVersion` → 1. No es un default cosmético: es la regla legacy, y
 * la misma que aplica firestore.rules con `.get('boucherVersion', 1)`. Un
 * valor que no sea un entero >= 1 también cae a 1 — un documento corrupto no
 * debe poder "saltarse" versiones por traer basura en el campo.
 */
export function versionEfectivaBoucher(dep: DepVersionado | null | undefined): number {
  const v = dep?.boucherVersion
  if (typeof v !== 'number' || !Number.isInteger(v) || v < VERSION_BOUCHER_LEGACY) {
    return VERSION_BOUCHER_LEGACY
  }
  return v
}

/** La siguiente. Siempre +1: Rules no acepta 1→3 (se perdería una versión). */
export function siguienteVersionBoucher(dep: DepVersionado | null | undefined): number {
  return versionEfectivaBoucher(dep) + 1
}

export function versionIdVigente(dep: DepVersionado | null | undefined): string | null {
  const id = dep?.boucherVersionId
  return typeof id === 'string' && id.trim() !== '' ? id.trim() : null
}

/**
 * ¿El comprobante vigente es el legacy (`boucher.jpg`)?
 *
 * Se decide por el versionId, no por el número: un documento con
 * `boucherVersion: 1` y sin `boucherVersionId` sigue siendo legacy — el
 * objeto está en el path viejo.
 */
export function esBoucherLegacy(dep: DepVersionado | null | undefined): boolean {
  return versionIdVigente(dep) === null
}

// ─── Paths ────────────────────────────────────────────────────────────────────

export const CARPETA_VERSIONES_BOUCHER = 'bouchers'

/** Path legacy, el de F1. Se conserva para poder NOMBRAR lo que se reemplaza. */
export function pathBoucherLegacy(motorizadoUid: string, depositoId: string): string {
  return `depositos/${motorizadoUid}/${depositoId}/boucher.jpg`
}

export function pathVersionBoucher(motorizadoUid: string, depositoId: string, versionId: string): string {
  return `depositos/${motorizadoUid}/${depositoId}/${CARPETA_VERSIONES_BOUCHER}/${versionId}.jpg`
}

/**
 * Forma aceptable de un versionId.
 *
 * El id lo genera el cliente (doc(collection()).id de Firestore: 20 chars
 * alfanuméricos). storage.rules valida esta MISMA forma sobre el nombre del
 * archivo, así que relajarla acá no abre nada — pero desalinearla haría que
 * el upload muriera con un permission-denied opaco en vez de un error legible.
 */
const FORMA_VERSION_ID = /^[A-Za-z0-9_-]{8,64}$/

export function versionIdValido(v: unknown): boolean {
  return typeof v === 'string' && FORMA_VERSION_ID.test(v)
}

export const MSG_VERSION_ID_INVALIDO = 'El identificador de versión del comprobante no es válido.'

export function asegurarVersionId(v: unknown): string {
  if (!versionIdValido(v)) throw new Error(MSG_VERSION_ID_INVALIDO)
  return v as string
}

// ─── Quién puede reemplazar, y desde dónde ────────────────────────────────────

export const TIPOS_DEPOSITO_VERSIONABLE: readonly string[] = [
  'recaudacion_motorizado_storkhub',
  'recaudacion_motorizado_comercio',
]

/**
 * Estados en los que el comprobante todavía se puede corregir.
 *
 *   en_revision  el gestor no lo miró todavía, o lo está mirando
 *   devuelto     el gestor pidió expresamente otra foto
 *
 * 'pendiente_boucher' NO está: ese es el flujo inicial de F1 (create-first,
 * lib/deposito-motorizado-envio), que no se duplica acá. 'rechazado' tampoco:
 * cierra W4 — reenviar sobre un rechazado dejó de ser una vía de corrección,
 * la vía es 'devuelto'. Y 'confirmado' / 'convertido_en_deuda' / 'anulado' son
 * evidencia sellada, para nadie, ni admin (ESTADOS_BOUCHER_DEPOSITO_SELLADO).
 */
export const ESTADOS_REEMPLAZO_BOUCHER: readonly string[] = ['en_revision', 'devuelto']

type DepReemplazable = Partial<DepositoRegistrado>

/** ¿Este depósito admite hoy una versión nueva del comprobante? */
export function depositoAdmiteVersionBoucher(dep: DepReemplazable | null | undefined): boolean {
  return TIPOS_DEPOSITO_VERSIONABLE.includes(dep?.tipo ?? '')
    && ESTADOS_REEMPLAZO_BOUCHER.includes(dep?.estado ?? '')
}

/** El motorizado solo corrige lo SUYO. El UID manda, no el nombre guardado. */
export function motorizadoPuedeReemplazarBoucher(
  dep: DepReemplazable | null | undefined,
  uid: string | null | undefined,
): boolean {
  const propio = typeof uid === 'string' && uid.trim() !== '' && dep?.motorizadoUid === uid.trim()
  return propio && depositoAdmiteVersionBoucher(dep)
}

/**
 * Staff (gestor/admin) corrige solo en DEP abierto y por el flujo auditado.
 * Mismo par de estados: un sellado no se reabre subiendo una foto.
 */
export function staffPuedeReemplazarBoucher(dep: DepReemplazable | null | undefined): boolean {
  return depositoAdmiteVersionBoucher(dep)
}

// ─── Plan de reemplazo ────────────────────────────────────────────────────────

export interface PlanReemplazoBoucher {
  version: number
  versionId: string
  /** Path del objeto NUEVO. Es lo que hay que subir, CREATE-ONLY. */
  path: string
  /** Path del que deja de ser vigente: legacy o la versión anterior. */
  reemplazaA: string
  motivo: string
}

/**
 * Todo lo que hace falta para reemplazar, calculado ANTES de tocar nada.
 *
 * Se resuelve completo por adelantado a propósito: si el motivo o el id no
 * sirven, el writer corta sin haber subido un objeto que después nadie puede
 * borrar (delete está DENY para todos, ver la deuda de huérfanas más abajo).
 */
export function planReemplazoBoucher(
  dep: DepVersionado & Pick<DepositoRegistrado, 'id'>,
  versionId: string,
  motivo: string,
): PlanReemplazoBoucher {
  const uid = typeof dep.motorizadoUid === 'string' ? dep.motorizadoUid : ''
  if (!uid) throw new Error('planReemplazoBoucher: el depósito no tiene motorizadoUid')
  const id = asegurarVersionId(versionId)
  const anterior = versionIdVigente(dep)
  return {
    version: siguienteVersionBoucher(dep),
    versionId: id,
    path: pathVersionBoucher(uid, dep.id, id),
    reemplazaA: anterior ? pathVersionBoucher(uid, dep.id, anterior) : pathBoucherLegacy(uid, dep.id),
    motivo: asegurarMotivoEvento(motivo),
  }
}

/**
 * Campos del DEPÓSITO en un reemplazo. Lista cerrada: es exactamente la que
 * firestore.rules acepta con hasOnly() para el motorizado.
 *
 * `estado` va SIEMPRE a 'en_revision' — desde 'en_revision' es un no-op que
 * mantiene la escritura uniforme, y desde 'devuelto' es el retorno a la cola
 * del gestor. El DEP-N, el monto, las órdenes, el destinatario y el tipo no
 * se tocan: corregir la evidencia no re-negocia el depósito.
 *
 * `ultimoEventoId` no es decorativo: es lo único que permite a Rules exigir
 * que el evento BOUCHER_REEMPLAZADO viaje en el MISMO batch (ver cabecera de
 * deposito-eventos.ts).
 */
export function camposReemplazoBoucher<T>(
  plan: PlanReemplazoBoucher,
  subida: { url: string; pathStorage: string },
  motorizadoUid: string,
  ahora: T,
  eventoId: string,
): Record<string, unknown> {
  return {
    boucher: { url: subida.url, pathStorage: subida.pathStorage, uploadedAt: ahora, motorizadoUid },
    boucherVersion: plan.version,
    boucherVersionId: plan.versionId,
    estado: 'en_revision',
    updatedAt: ahora,
    ultimoEventoId: eventoId,
  }
}

/** El evento que acompaña al reemplazo. Mismo batch, siempre. */
export function eventoReemplazoBoucher<T>(
  plan: PlanReemplazoBoucher,
  actor: ActorEventoDeposito,
  ahora: T,
): Record<string, unknown> {
  return camposEventoBoucherReemplazado(actor, ahora, {
    version: plan.version,
    versionId: plan.versionId,
    path: plan.path,
    reemplazaA: plan.reemplazaA,
    motivo: plan.motivo,
  })
}

export { EVENTO_BOUCHER_REEMPLAZADO }

// ─── Presentación ─────────────────────────────────────────────────────────────

/**
 * Cómo se nombra la versión vigente en la UI. Un depósito nunca reemplazado
 * NO dice "Versión 1": decirlo sugeriría que hubo un historial que no existe.
 */
export function etiquetaVersionBoucher(dep: DepVersionado | null | undefined): string | null {
  if (esBoucherLegacy(dep)) return null
  return `Versión ${versionEfectivaBoucher(dep)}`
}

/** Aviso obligatorio antes de reemplazar: nada se pierde, y eso es el punto. */
export const AVISO_REEMPLAZO_BOUCHER =
  'El comprobante anterior quedará guardado en el historial.'
