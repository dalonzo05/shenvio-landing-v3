// B2-PAGO-MEDIO — Lo que la UI del motorizado necesita para preguntar con qué
// le pagaron el delivery.
//
// ⚠️ LA AUTORIDAD ESTÁ EN EL SERVIDOR. `functions/src/medio-pago.ts` es la
// frontera: allí se valida el payload, se resuelve qué `formaPago` se
// persiste y se decide el consumo del temporal. Acá NO se replica nada de eso
// — un espejo de la lógica server-side daría tests verdes sobre código que
// producción no ejecuta.
//
// Lo único compartido son los dos literales del enum, duplicados a propósito
// para no cruzar un import entre app y Functions. Si un día cambian, hay que
// cambiarlos en los dos sitios. Ver deuda PAGO-MEDIO-ENUM-ESPEJADO.
//
// ── Regla de negocio ────────────────────────────────────────────────────────
//
// `cobroDelivery.formaPago` es la única fuente persistente del medio. Su
// ausencia significa "nadie lo registró" y se presenta como "No registrado" —
// nunca como impago. Está PROHIBIDO derivarlo de `quienPaga`, de `recibio`,
// del receptor o del momento: ninguno dice CON QUÉ se pagó. Por eso esta capa
// solo transmite lo que el motorizado eligió, y omite la clave cuando no
// eligió nada.
//
// PURO y sin imports: sin Firestore, sin React.

/** Los dos únicos valores persistibles. Espejo del enum del servidor. */
export const MEDIOS_PAGO = ['efectivo', 'transferencia'] as const

export type MedioPago = (typeof MEDIOS_PAGO)[number]

/**
 * Estricto a propósito: sin `trim()`, sin normalizar mayúsculas y sin
 * sinónimos. No se exporta porque la UI no decide validez — solo transmite;
 * quien valida de verdad es el servidor.
 */
function esMedioPago(v: unknown): v is MedioPago {
  return typeof v === 'string' && (MEDIOS_PAGO as readonly string[]).includes(v)
}

/**
 * Lo que el motorizado elige cuando no sabe con qué le pagaron.
 *
 * No se envía al servidor ni se persiste: existe para que el formulario
 * distinga "todavía no respondió" de "respondió que no sabe". Las dos acaban
 * igual —sin medio— pero la segunda es una respuesta deliberada, y la interfaz
 * necesita poder decir que la pregunta ya fue contestada.
 */
export const MEDIO_NO_SABE = 'no_sabe'

export type SeleccionMedio = MedioPago | typeof MEDIO_NO_SABE | ''

/** Opciones del selector, en orden. Ninguna viene preseleccionada. */
export const OPCIONES_MEDIO: readonly { value: MedioPago | typeof MEDIO_NO_SABE; label: string }[] = [
  { value: 'efectivo', label: 'Efectivo' },
  { value: 'transferencia', label: 'Transferencia' },
  { value: MEDIO_NO_SABE, label: 'No estoy seguro' },
]

/**
 * El medio que debe viajar en el payload, o `undefined` si no debe viajar.
 *
 * "No estoy seguro", vacío y cualquier valor desconocido devuelven
 * `undefined`: la clave se omite y el campo nunca llega a existir. Nunca se
 * sustituye por un valor por defecto — un medio inventado es peor que ninguno.
 */
export function medioParaPayload(seleccion: unknown): MedioPago | undefined {
  return esMedioPago(seleccion) ? seleccion : undefined
}

/** ¿La pregunta del medio ya fue contestada, sea con un valor o con "no sé"? */
export function medioRespondido(seleccion: unknown): boolean {
  return esMedioPago(seleccion) || seleccion === MEDIO_NO_SABE
}
