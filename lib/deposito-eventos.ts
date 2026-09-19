// DEPOSITO-AUDITORIA-1 — Historia append-only de un depósito.
//
// F1 dejó el depósito íntegro pero mudo: "Devolver al motorizado" BORRABA el
// documento y "Eliminar" también, así que corregir un comprobante costaba el
// DEP-N, el boucher anterior, las relaciones con las órdenes y todo rastro de
// quién pidió la corrección y por qué. Lo único que quedaba era el ledger, que
// no es el lugar: `movimientos_financieros` modela DINERO, no evidencia.
// Mezclar ahí un "el gestor pidió otra foto" inventa un movimiento que nunca
// existió.
//
// Este módulo define la subcolección propia:
//
//     ordenes_deposito/{depId}/eventos/{eventoId}
//
// APPEND-ONLY, y eso se sostiene en Rules, no acá: create controlado, update
// DENY, delete DENY. Lo de acá es la FORMA de cada evento — qué campos lleva,
// cuáles son obligatorios y qué motivo se acepta — para que el writer y los
// tests hablen del mismo objeto que valida firestore.rules.
//
// Tres decisiones que no se pueden relajar sin romper la auditoría:
//
//   1. `at`, `porUid` y `porRol` NO se infieren. Rules exige
//      at == request.time, porUid == request.auth.uid y porRol ==
//      usuarios/{uid}.rol. Un evento no puede afirmar un actor, una hora ni
//      un rol que el servidor no pueda demostrar — justo el error que
//      `creadoPorRol` del ledger arrastra desde siempre (ver la regla 2 de
//      evento-auditoria.ts, deuda AUD-ROL-NO-DISCRIMINA-ADMIN).
//
//   2. El MOTIVO es obligatorio donde hay una decisión humana detrás
//      (reemplazar, devolver, rehacer, anular). 3–300 caracteres: menos no
//      dice nada, más deja de ser un motivo y pasa a ser un informe.
//
//   3. `ultimoEventoId` vive en el DEPÓSITO, no acá. Es la única forma de que
//      firestore.rules pueda EXIGIR que el evento se escriba en el mismo
//      batch que la transición: las reglas no enumeran subcolecciones, así
//      que para hacer existsAfter() sobre el evento hay que poder nombrarlo.
//      Ver la nota extensa en firestore.rules (§ DEPOSITO-AUDITORIA-1).
//
// PURO: sin Firestore, sin React, sin Date.now(). El sello de tiempo lo pasa
// quien llama (serverTimestamp() en la app, lo mismo en los tests de reglas).

import { presentarActor, type ActorPresentado } from './actor-resolucion'

// ─── Tipos de evento ──────────────────────────────────────────────────────────

/** Primera subida del comprobante (flujo create-first de F1). */
export const EVENTO_BOUCHER_SUBIDO = 'BOUCHER_SUBIDO'
/** Una versión nueva reemplaza a la vigente. La anterior NO se borra. */
export const EVENTO_BOUCHER_REEMPLAZADO = 'BOUCHER_REEMPLAZADO'
/** StorkHub pidió una corrección: el DEP pasa a 'devuelto'. */
export const EVENTO_DEPOSITO_DEVUELTO = 'DEPOSITO_DEVUELTO'
export const EVENTO_DEPOSITO_CONFIRMADO = 'DEPOSITO_CONFIRMADO'
/** Admin devuelve a revisión un depósito ya confirmado. */
export const EVENTO_DEPOSITO_REHECHO = 'DEPOSITO_REHECHO'
/** Admin cierra el DEP sin borrarlo: reemplaza al viejo "Eliminar". */
export const EVENTO_DEPOSITO_ANULADO = 'DEPOSITO_ANULADO'

export type TipoEventoDeposito =
  | typeof EVENTO_BOUCHER_SUBIDO
  | typeof EVENTO_BOUCHER_REEMPLAZADO
  | typeof EVENTO_DEPOSITO_DEVUELTO
  | typeof EVENTO_DEPOSITO_CONFIRMADO
  | typeof EVENTO_DEPOSITO_REHECHO
  | typeof EVENTO_DEPOSITO_ANULADO

/** Mismo orden y mismos literales que la lista cerrada de firestore.rules. */
export const TIPOS_EVENTO_DEPOSITO: readonly TipoEventoDeposito[] = [
  EVENTO_BOUCHER_SUBIDO,
  EVENTO_BOUCHER_REEMPLAZADO,
  EVENTO_DEPOSITO_DEVUELTO,
  EVENTO_DEPOSITO_CONFIRMADO,
  EVENTO_DEPOSITO_REHECHO,
  EVENTO_DEPOSITO_ANULADO,
]

/**
 * Los que exigen motivo. Subir el primer comprobante y confirmar no son
 * decisiones que haya que justificar: son el flujo normal. Reemplazar,
 * devolver, rehacer y anular sí — cada uno deshace algo que ya estaba dicho.
 */
export const TIPOS_EVENTO_CON_MOTIVO: readonly TipoEventoDeposito[] = [
  EVENTO_BOUCHER_REEMPLAZADO,
  EVENTO_DEPOSITO_DEVUELTO,
  EVENTO_DEPOSITO_REHECHO,
  EVENTO_DEPOSITO_ANULADO,
]

export function eventoExigeMotivo(tipo: string | null | undefined): boolean {
  return TIPOS_EVENTO_CON_MOTIVO.includes(tipo as TipoEventoDeposito)
}

// ─── Ruta ─────────────────────────────────────────────────────────────────────

export const COLECCION_DEPOSITOS = 'ordenes_deposito'
export const SUBCOLECCION_EVENTOS_DEPOSITO = 'eventos'

/** `ordenes_deposito/{depId}/eventos`. Una sola fuente para writer y tests. */
export function rutaEventosDeposito(depositoId: string): string {
  return `${COLECCION_DEPOSITOS}/${depositoId}/${SUBCOLECCION_EVENTOS_DEPOSITO}`
}

// ─── Motivo ───────────────────────────────────────────────────────────────────

export const MOTIVO_EVENTO_MIN = 3
export const MOTIVO_EVENTO_MAX = 300

export const MSG_MOTIVO_EVENTO_INVALIDO =
  `El motivo es obligatorio: entre ${MOTIVO_EVENTO_MIN} y ${MOTIVO_EVENTO_MAX} caracteres.`

/**
 * Motivo tal como se persiste: sin espacios de borde.
 *
 * El recorte importa porque la longitud se valida DOS veces sobre valores
 * distintos si no se normaliza: acá sobre el texto del formulario, y en Rules
 * sobre el string ya guardado. `'   '` pasaría el `length >= 3` del cliente y
 * moriría en el servidor.
 */
export function normalizarMotivoEvento(v: unknown): string {
  return typeof v === 'string' ? v.trim() : ''
}

export function motivoEventoValido(v: unknown): boolean {
  const s = normalizarMotivoEvento(v)
  return s.length >= MOTIVO_EVENTO_MIN && s.length <= MOTIVO_EVENTO_MAX
}

/** Motivo normalizado, o error legible. El writer corta ANTES de subir nada. */
export function asegurarMotivoEvento(v: unknown): string {
  const s = normalizarMotivoEvento(v)
  if (!motivoEventoValido(s)) throw new Error(MSG_MOTIVO_EVENTO_INVALIDO)
  return s
}

// ─── Campos ───────────────────────────────────────────────────────────────────

/**
 * Quién escribe el evento.
 *
 * `rol` es el rol REAL leído de usuarios/{uid} por la app, no una etiqueta
 * elegida por el writer: Rules compara contra ese mismo documento, así que un
 * valor inventado no llega a persistirse — deniega el batch entero.
 */
export interface ActorEventoDeposito {
  uid: string
  rol: string
}

/** Datos propios de una versión del comprobante. */
export interface DatosVersionBoucher {
  version: number
  versionId: string
  /** Path del objeto NUEVO en Storage. */
  path: string
  /**
   * Qué versión deja de ser la vigente, por su PATH y no por su id: el
   * comprobante legacy (`boucher.jpg`) no tiene versionId, y decir
   * `reemplazaA: null` perdería exactamente el caso que hay que poder
   * auditar — el primer reemplazo de un depósito histórico.
   */
  reemplazaA: string
}

const soloDefinidos = (o: Record<string, unknown>): Record<string, unknown> =>
  Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined))

/**
 * Campos comunes de cualquier evento. `at`, `porUid` y `porRol` son los tres
 * que Rules verifica contra el servidor; el resto es carga útil del tipo.
 */
export function camposEventoDeposito<T>(
  tipo: TipoEventoDeposito,
  actor: ActorEventoDeposito,
  ahora: T,
  extra: Record<string, unknown> = {},
): Record<string, unknown> {
  const base: Record<string, unknown> = {
    tipo,
    at: ahora,
    porUid: actor.uid,
    porRol: actor.rol,
  }
  if (eventoExigeMotivo(tipo)) base.motivo = asegurarMotivoEvento(extra.motivo)
  return { ...base, ...soloDefinidos({ ...extra, motivo: base.motivo }) }
}

export function camposEventoBoucherSubido<T>(
  actor: ActorEventoDeposito,
  ahora: T,
  datos: Pick<DatosVersionBoucher, 'version' | 'versionId' | 'path'>,
): Record<string, unknown> {
  return camposEventoDeposito(EVENTO_BOUCHER_SUBIDO, actor, ahora, {
    version: datos.version,
    versionId: datos.versionId,
    path: datos.path,
  })
}

export function camposEventoBoucherReemplazado<T>(
  actor: ActorEventoDeposito,
  ahora: T,
  datos: DatosVersionBoucher & { motivo: string },
): Record<string, unknown> {
  return camposEventoDeposito(EVENTO_BOUCHER_REEMPLAZADO, actor, ahora, {
    version: datos.version,
    versionId: datos.versionId,
    path: datos.path,
    reemplazaA: datos.reemplazaA,
    motivo: datos.motivo,
  })
}

export function camposEventoDepositoDevuelto<T>(
  actor: ActorEventoDeposito,
  ahora: T,
  motivo: string,
): Record<string, unknown> {
  return camposEventoDeposito(EVENTO_DEPOSITO_DEVUELTO, actor, ahora, { motivo })
}

export function camposEventoDepositoConfirmado<T>(
  actor: ActorEventoDeposito,
  ahora: T,
): Record<string, unknown> {
  return camposEventoDeposito(EVENTO_DEPOSITO_CONFIRMADO, actor, ahora)
}

export function camposEventoDepositoRehecho<T>(
  actor: ActorEventoDeposito,
  ahora: T,
  motivo: string,
): Record<string, unknown> {
  return camposEventoDeposito(EVENTO_DEPOSITO_REHECHO, actor, ahora, { motivo })
}

export function camposEventoDepositoAnulado<T>(
  actor: ActorEventoDeposito,
  ahora: T,
  motivo: string,
): Record<string, unknown> {
  return camposEventoDeposito(EVENTO_DEPOSITO_ANULADO, actor, ahora, { motivo })
}

// ─── Presentación ─────────────────────────────────────────────────────────────

/**
 * Qué OCURRIÓ, nunca quién. Mismo criterio que evento-auditoria.ts: el actor
 * se resuelve aparte, desde `porUid`, y se muestra como tal. Acá `porRol` SÍ
 * es confiable —Rules lo ató a usuarios/{uid}.rol— pero sigue sin ir en la
 * etiqueta del hecho: "Comprobante reemplazado" es el hecho; "el motorizado lo
 * reemplazó" es la fila completa.
 */
const ETIQUETA_EVENTO: Record<string, string> = {
  [EVENTO_BOUCHER_SUBIDO]: 'Comprobante subido',
  [EVENTO_BOUCHER_REEMPLAZADO]: 'Comprobante reemplazado',
  [EVENTO_DEPOSITO_DEVUELTO]: 'Corrección solicitada',
  [EVENTO_DEPOSITO_CONFIRMADO]: 'Depósito confirmado',
  [EVENTO_DEPOSITO_REHECHO]: 'Depósito devuelto a revisión',
  [EVENTO_DEPOSITO_ANULADO]: 'Depósito anulado',
}

/** Último recurso: un tipo que este build no conoce. No se traduce a prosa. */
export const TITULO_EVENTO_GENERICO = 'Evento registrado'

export function etiquetaEventoDeposito(tipo: string | null | undefined): string {
  const clave = typeof tipo === 'string' ? tipo.trim() : ''
  return ETIQUETA_EVENTO[clave] ?? TITULO_EVENTO_GENERICO
}

/** Documento crudo de la subcolección, tal como llega de Firestore. */
export interface EventoDepositoDoc {
  id?: string | null
  tipo?: string | null
  at?: unknown
  porUid?: string | null
  porRol?: string | null
  motivo?: string | null
  version?: number | null
  versionId?: string | null
  path?: string | null
  reemplazaA?: string | null
}

export interface FilaEventoDeposito {
  id: string
  titulo: string
  /** `tipo` crudo, para el chip técnico de un tipo desconocido. */
  tipoCrudo: string
  at: unknown
  /** Nombre resuelto, o "Usuario interno". Nunca un UID al frente. */
  actor: ActorPresentado | null
  /** Rol REGISTRADO, que acá sí es el rol real (Rules lo ató al perfil). */
  rol: string | null
  motivo: string | null
  /** Solo en eventos de comprobante. */
  version: number | null
}

const texto = (v: unknown): string => (typeof v === 'string' ? v.trim() : '')

/**
 * Filas del historial de un depósito, MÁS RECIENTE PRIMERO.
 *
 * Un evento recién escrito llega desde la caché local con el serverTimestamp
 * todavía NULO —el servidor no respondió—, y ordenarlo por su `at` crudo lo
 * mandaría al fondo de la lista justo cuando es lo último que pasó. Se lo
 * trata como el más reciente hasta que la fecha real llega. Empata por id
 * (descendente) y por posición original, para que el orden sea estable.
 *
 * @param nombres nombres ya resueltos por UID; la página los tiene en memoria.
 *                Sin entrada se dice "Usuario interno", no el UID.
 * @param msDe    cómo convertir el `at` crudo a milisegundos. Se inyecta para
 *                que este módulo no dependa de normalizarFecha() ni de Date.
 */
const PENDIENTE = Number.POSITIVE_INFINITY

export function filasEventosDeposito(
  eventos: readonly EventoDepositoDoc[],
  nombres: Record<string, string> = {},
  msDe: (v: unknown) => number = () => 0,
): FilaEventoDeposito[] {
  const cuando = (e: EventoDepositoDoc): number =>
    e.at === null || e.at === undefined ? PENDIENTE : msDe(e.at)
  return [...eventos]
    .map((e, i) => ({ e, i }))
    .sort((a, b) => cuando(b.e) - cuando(a.e) || texto(b.e.id).localeCompare(texto(a.e.id)) || a.i - b.i)
    .map(({ e }) => {
      const uid = texto(e.porUid)
      return {
        id: texto(e.id),
        titulo: etiquetaEventoDeposito(e.tipo),
        tipoCrudo: texto(e.tipo),
        at: e.at ?? null,
        actor: uid ? presentarActor(uid, nombres[uid]) : null,
        rol: texto(e.porRol) || null,
        motivo: texto(e.motivo) || null,
        version: typeof e.version === 'number' && Number.isFinite(e.version) ? e.version : null,
      }
    })
}
