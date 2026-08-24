// B2.5 — Ruta única hacia la ficha autoritativa de una orden.
//
// `/panel/gestor/solicitudes/[id]` es la única superficie completa de una
// orden. Antes cada módulo la escribía a mano —o no la escribía y mostraba el
// ID como texto plano—, así que el gestor tenía que buscar la orden a mano
// desde Depósitos, Auditoría o Gastos.
//
// Los anchors están definidos por la propia ficha:
//   #cobros      BloqueCobros        (B2.1)
//   #incidencia  BloqueIncidencia    (B2.1)
//   #depositos   BloqueDepositos     (B2.3)
//   #historial   BloqueTimeline      (B2.4)
//
// PURO: no toca el router, no consulta nada, no navega. Solo construye la URL
// que un <Link> va a usar.

export type AnchorOrden = 'cobros' | 'incidencia' | 'depositos' | 'historial'

export const BASE_ORDEN = '/panel/gestor/solicitudes'

/** Anchors que la ficha realmente define. Cualquier otro se ignora. */
const ANCHORS: readonly AnchorOrden[] = ['cobros', 'incidencia', 'depositos', 'historial']

/**
 * Ruta a la ficha de una orden, opcionalmente a uno de sus bloques.
 *
 * Devuelve null si el ID no sirve: sin ID no hay orden a la que ir, y un link
 * a `/panel/gestor/solicitudes/` llevaría al listado haciendo creer que se
 * abrió la orden. Quien llama decide si pinta un link o texto plano.
 */
export function rutaOrden(id: string | null | undefined, anchor?: AnchorOrden): string | null {
  if (typeof id !== 'string') return null
  const limpio = id.trim()
  if (!limpio) return null
  // Un ID de Firestore no lleva caracteres que haya que escapar, pero estos
  // IDs llegan desde documentos y no siempre desde snap.id.
  const base = `${BASE_ORDEN}/${encodeURIComponent(limpio)}`
  // Solo un `#`, y solo de la lista real: un anchor inventado dejaría al
  // usuario arriba de la ficha creyendo que el bloque no existe.
  return anchor && ANCHORS.includes(anchor) ? `${base}#${anchor}` : base
}
