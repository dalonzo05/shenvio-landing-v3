// B2-PAGO-MEDIO — Lado UI del medio de pago.
//
// El contrato (enum cerrado, validación y orden de resolución) vive en
// `functions/src/medio-pago.ts` y se importa desde acá. La dirección del
// import es deliberada: la app puede mirar hacia `functions/`, pero
// `functions/` no puede mirar hacia afuera sin arrastrar su rootDir y cambiar
// las rutas de su artefacto de deploy. Un solo contrato, sin enums duplicados.
//
// Este archivo solo añade lo que el formulario necesita y el servidor no.
//
// PURO: sin Firestore, sin React.

import { esMedioPago, type MedioPago } from '../functions/src/medio-pago'

export { MEDIOS_PAGO, esMedioPago } from '../functions/src/medio-pago'
export type { MedioPago } from '../functions/src/medio-pago'

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
