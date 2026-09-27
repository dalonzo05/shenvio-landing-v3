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

// ─── Resumen de presencia (dashboard del gestor) ──────────────────────────────

export type CategoriaPresencia = 'en_linea' | 'fuera_de_linea' | 'inactivo' | 'sin_estado'

/**
 * Categoría operativa de un motorizado para el dashboard. `activo` es la cuenta
 * (activo === false = desactivada); `estado` es la presencia. Una cuenta que no
 * está activa es `inactivo` sea cual sea su presencia; sin `estado` no se asume
 * ninguna presencia.
 */
export function categoriaPresencia(m: { activo?: boolean | null; estado?: unknown }): CategoriaPresencia {
  if (m.activo !== true) return 'inactivo'
  if (esMotorizadoEnLinea(m.estado)) return 'en_linea'
  if (m.estado === 'inactivo') return 'fuera_de_linea'
  return 'sin_estado'
}

export function resumenPresencia(motorizados: ReadonlyArray<{ activo?: boolean | null; estado?: unknown }>) {
  const cuenta = (c: CategoriaPresencia) => motorizados.filter((m) => categoriaPresencia(m) === c).length
  return {
    total: motorizados.length,
    enLinea: cuenta('en_linea'),
    fueraDeLinea: cuenta('fuera_de_linea'),
    inactivos: cuenta('inactivo'),
  }
}

// ─── Control de presencia del motorizado (menú de perfil) ─────────────────────
//
// MOTO-PRESENCIA-UX-1. Solo cambia DÓNDE y CÓMO controla su presencia el motorizado;
// la transición sigue siendo la misma escritura de `estado` (disponible / inactivo).
// Tener órdenes activas no bloquea nada: fuera de línea afecta las órdenes NUEVAS.

export const ETIQUETA_EN_LINEA = 'En línea'
export const ETIQUETA_FUERA_DE_LINEA = 'Fuera de línea'

export const COPY_CONFIRMAR_FUERA_DE_LINEA = {
  titulo: '¿Querés ponerte fuera de línea?',
  texto:
    'Mientras estés fuera de línea no recibirás nuevas asignaciones. Las órdenes que ya tenés asignadas seguirán disponibles y podrás completarlas normalmente.',
  cancelar: 'Cancelar',
  confirmar: 'Ponerme fuera de línea',
} as const

/** Lo que ve el motorizado: sin `estado` (o desconocido) se muestra fuera de línea, sin inventar "en línea". */
export function etiquetaPresencia(estado: unknown): string {
  return esMotorizadoEnLinea(estado) ? ETIQUETA_EN_LINEA : ETIQUETA_FUERA_DE_LINEA
}

export interface AccionPresencia {
  etiqueta: string
  destino: PresenciaEscribible
  requiereConfirmacion: boolean
}

/** La acción que ofrece el menú de perfil según la presencia actual. */
export function accionPresencia(estado: unknown): AccionPresencia {
  return esMotorizadoEnLinea(estado)
    ? { etiqueta: 'Ponerse fuera de línea', destino: 'inactivo', requiereConfirmacion: true }
    : { etiqueta: 'Ponerse en línea', destino: 'disponible', requiereConfirmacion: false }
}

export type PasoPresencia =
  | { tipo: 'confirmar'; destino: PresenciaEscribible }
  | { tipo: 'aplicar'; destino: PresenciaEscribible }

/** Al pulsar la acción: salir de línea pide confirmación (no escribe); ponerse en línea aplica directo. */
export function pulsarPresencia(estado: unknown): PasoPresencia {
  const a = accionPresencia(estado)
  return { tipo: a.requiereConfirmacion ? 'confirmar' : 'aplicar', destino: a.destino }
}

/** Escribe la presencia por el puerto dado. Un fallo no se disfraza de éxito. */
export async function aplicarPresencia(
  escribir: (destino: PresenciaEscribible) => Promise<void>,
  destino: PresenciaEscribible,
): Promise<{ ok: boolean }> {
  try {
    await escribir(destino)
    return { ok: true }
  } catch {
    return { ok: false }
  }
}
