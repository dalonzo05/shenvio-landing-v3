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
