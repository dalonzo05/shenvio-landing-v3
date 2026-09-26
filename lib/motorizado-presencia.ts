// MOTO-DISPONIBILIDAD-CONTRATO-1 — Qué significa `motorizado.estado` y qué no.
//
// Un motorizado puede tener varias órdenes activas a la vez (multiasignación), así
// que `estado` NO es un contador de trabajo. Es PRESENCIA:
//
//   disponible → en línea: activo y candidato a recibir órdenes nuevas. NO quiere
//                decir "sin órdenes": puede tener 0, 1 o varias.
//   inactivo   → fuera de línea: no es candidato a órdenes nuevas. Las que ya tiene
//                siguen siendo suyas y las sigue viendo y operando.
//   ocupado    → valor LEGACY. Ningún flujo lo escribe ya; los documentos que aún lo
//                traen se leen como "en línea". No se migran.
//
// La carga se deriva de las órdenes activas (tieneCargaOperativa), nunca de `estado`.
// Cerrar, rechazar, cancelar, rebotar o reactivar UNA orden no cambia la presencia:
// solo la cambia el propio motorizado (o el gestor) de forma explícita.

export type PresenciaEscribible = 'disponible' | 'inactivo'

/** Únicos valores que un flujo nuevo puede escribir en `motorizado.estado`. */
export const PRESENCIAS_ESCRIBIBLES: readonly PresenciaEscribible[] = ['disponible', 'inactivo']

/** En línea = candidato a órdenes nuevas. Incluye el legacy `ocupado`; excluye `inactivo` y lo desconocido. */
export function esMotorizadoEnLinea(estado: unknown): boolean {
  return estado === 'disponible' || estado === 'ocupado'
}

/** Presencia que resulta de pulsar "Activarme / Desactivarme": alterna en línea ↔ fuera de línea. */
export function presenciaAlAlternar(estado: unknown): PresenciaEscribible {
  return esMotorizadoEnLinea(estado) ? 'inactivo' : 'disponible'
}

/** La carga operativa es tener al menos una orden activa; se deriva de las órdenes, no del estado. */
export function tieneCargaOperativa(ordenesActivas: readonly unknown[]): boolean {
  return ordenesActivas.length > 0
}
