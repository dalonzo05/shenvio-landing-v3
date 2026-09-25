// VIAJE-MOTORIZADO-COLUMNA-SEMANTICA-1 — Qué muestra la columna "Motorizado".
//
// La columna dice UNA cosa: quién tiene asignada la solicitud AHORA. No dice
// quién sería el mejor candidato, ni quién la rechazó, ni quién la tuvo antes.
//
// Antes, una solicitud `confirmada` sin asignación pintaba en esa columna al
// mejor candidato del ranking ("John Pork 2 · Disponible · Sin órdenes…"), con
// el mismo aspecto que un motorizado asignado. Tras un rechazo eso hacía parecer
// que quien acababa de rechazar seguía con la orden, aunque la solicitud no
// tuviera ninguna asignación.
//
// La sugerencia NO se pierde: sigue viva en sus propias acciones ("Asignar
// sugerido", "Ver opciones") y en el panel de la ficha. Lo que este helper
// garantiza es que un candidato sugerido jamás se usa como respaldo de un
// motorizado asignado: no recibe el ranking ni el sugerido como entrada.
//
// El último rechazo tampoco se muestra acá: vive en la columna Aceptación
// (`ultimoRechazoMotorizado`, lib/rechazo-motorizado.ts).
//
// PURO: sin Firestore, sin React.

export interface EntradaCeldaMotorizado {
  asignacion?: {
    motorizadoNombre?: unknown
    motorizadoTelefono?: unknown
  } | null
}

export type CeldaMotorizado =
  /** Hay un motorizado realmente asignado. */
  | { tipo: 'asignado'; nombre: string; telefono: string | null }
  /** No hay asignación vigente, sea cual sea la sugerencia o la historia. */
  | { tipo: 'sin_asignar' }

const texto = (v: unknown): string | null =>
  typeof v === 'string' && v.trim() !== '' ? v.trim() : null

/** El motorizado de la asignación vigente, o "sin asignar". Nada más. */
export function celdaMotorizado(orden: EntradaCeldaMotorizado): CeldaMotorizado {
  const nombre = texto(orden.asignacion?.motorizadoNombre)
  if (!nombre) return { tipo: 'sin_asignar' }
  return { tipo: 'asignado', nombre, telefono: texto(orden.asignacion?.motorizadoTelefono) }
}
