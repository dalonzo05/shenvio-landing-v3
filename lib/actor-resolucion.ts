// B2.2 — Presentación del actor que resolvió una incidencia.
//
// La ficha mostraba el UID crudo. Acá se decide qué texto va al frente y qué
// queda como rastro de auditoría, con una regla explícita: si no hay nombre,
// NO se inventa — se dice "Usuario interno" y el UID pasa a ser lo único
// identificable, que es la verdad disponible.
//
// PURO: sin React, sin Firestore, sin efectos.

export const NOMBRE_ACTOR_DESCONOCIDO = 'Usuario interno'

export interface ActorPresentado {
  /** Dato principal en pantalla. */
  nombre: string
  /** Referencia técnica, secundaria. */
  uid: string
  /** false cuando se cayó al genérico. */
  tieneNombre: boolean
}

/**
 * @param uid    `resolucion.resueltoPor`
 * @param nombre nombre ya resuelto para ese uid, si lo hay
 */
export function presentarActor(
  uid: string | null | undefined,
  nombre: string | null | undefined,
): ActorPresentado | null {
  if (typeof uid !== 'string' || uid.trim() === '') return null
  const limpio = typeof nombre === 'string' ? nombre.trim() : ''
  return {
    nombre: limpio || NOMBRE_ACTOR_DESCONOCIDO,
    uid,
    tieneNombre: limpio !== '',
  }
}

/**
 * Nombre legible de un documento de `usuarios`.
 *
 * Misma cadena de fallback que ya usa Gestor → Cobros para los comercios.
 * Devuelve '' cuando no hay nada legible, para que el llamador decida —y no
 * termine mostrando un UID donde debería ir un nombre.
 */
export function nombreDeUsuario(data: { name?: unknown; nombre?: unknown } | null | undefined): string {
  if (!data) return ''
  const n = typeof data.name === 'string' ? data.name.trim() : ''
  if (n) return n
  const n2 = typeof data.nombre === 'string' ? data.nombre.trim() : ''
  return n2
}

// ─── Resolución de nombres por UID ────────────────────────────────────────────
//
// DRAWER-CONTEXTUAL-1 · ACTOR — la unidad de lectura es el UID DISTINTO no
// cacheado, no el documento que lo menciona: dos depósitos confirmados por la
// misma persona se resuelven con una sola lectura. Acá no hay Firestore: quien
// llama inyecta el lector, así que esto se puede probar contando lecturas.

/** Mínimo que necesita el resolver de una caché: saber y guardar por UID. */
export interface CacheNombres {
  has(uid: string): boolean
  get(uid: string): string | undefined
  set(uid: string, nombre: string): unknown
}

/** Lo que devuelve leer `usuarios/{uid}`; null si no existe. */
export type DatosUsuario = { name?: unknown; nombre?: unknown } | null

/**
 * Qué UIDs hay que ir a buscar: no vacíos, sin repetir y todavía no cacheados
 * —ni con nombre ni con el '' que marca "ya se intentó"—.
 */
export function uidsPorResolver(
  uids: Array<string | null | undefined>,
  cache: CacheNombres,
): string[] {
  const vistos = new Set<string>()
  const out: string[] = []
  for (const u of uids) {
    if (typeof u !== 'string') continue
    const uid = u.trim()
    if (!uid || vistos.has(uid) || cache.has(uid)) continue
    vistos.add(uid)
    out.push(uid)
  }
  return out
}

/**
 * Resuelve los UIDs pendientes con el lector inyectado y los deja en la caché.
 *
 * Una lectura por UID pendiente, nunca dos. Un usuario inexistente, sin nombre
 * legible o una lectura que falla guardan '' : la UI cae a "Usuario interno" y
 * no se reintenta en lo que resta de la sesión. Nunca lanza.
 */
export async function resolverNombresActores(
  uids: Array<string | null | undefined>,
  cache: CacheNombres,
  leerUsuario: (uid: string) => Promise<DatosUsuario>,
): Promise<Record<string, string>> {
  const pendientes = uidsPorResolver(uids, cache)
  const resueltos: Record<string, string> = {}
  await Promise.all(pendientes.map(async (uid) => {
    let nombre = ''
    try {
      nombre = nombreDeUsuario(await leerUsuario(uid))
    } catch {
      nombre = ''
    }
    cache.set(uid, nombre)
    resueltos[uid] = nombre
  }))
  return resueltos
}
