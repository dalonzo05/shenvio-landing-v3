// PRECIO-CONFIRMADO-ANTES-DE-OPERAR-1 — la base de comisión MANUAL en las pantallas del gestor.
//
// El servidor deriva la base de la comisión con la tarifa de la distancia cotizada (lib/precio-orden.ts, el mismo archivo que usan las Functions). Cuando no puede
// —el precio salió de un viaje anterior sin distancia, o la distancia queda fuera del tarifario— el gestor la declara a mano, SIN recargos. Estas funciones
// deciden cuándo se pide, validan lo escrito y lo convierten al número que viaja a asignarMotorizado. La pantalla NUNCA la precarga con el precio final: el
// precio final puede traer recargos que no pagan comisión.

import { clasificarBaseComision, precioValido, type Orden } from './precio-orden'

export const MSG_BASE_REQUERIDA = 'Ingresá la base de comisión (sin recargos) antes de confirmar.'
export const MSG_BASE_SUPERA_PRECIO = 'La base de comisión no puede superar el precio final.'
export const MSG_BASE_INVALIDA = 'La base de comisión debe ser un número mayor que 0.'

/**
 * ¿Hay que pedirle al gestor la base manual al confirmar esta orden?
 *
 *  · Si se edita el precio, o la orden aún no tiene un precio confirmado, la base se vuelve a resolver: se pide si el servidor no puede derivarla.
 *  · Con un precio ya confirmado y sin editar: nada si ya tiene snapshot; si es anterior al snapshot, solo si no se puede derivar.
 */
export function necesitaBaseManual(solicitud: object | null | undefined, precioEditado: boolean): boolean {
  if (!solicitud) return false
  const o = solicitud as Orden
  const confirmado = precioValido(o.confirmacion?.precioFinalCordobas) && o.estado !== 'pendiente_confirmacion'
  if (confirmado && !precioEditado && o.confirmacion?.comisionBaseCordobas != null) return false
  return clasificarBaseComision(o).tipo === 'manual'
}

/** El texto del input → número, o undefined si no es un número finito mayor que 0. */
export function parseBaseManual(texto: string | number | null | undefined): number | undefined {
  if (texto === '' || texto === null || texto === undefined) return undefined
  const n = typeof texto === 'number' ? texto : Number(String(texto).trim().replace(',', '.'))
  return precioValido(n) ? n : undefined
}

/** Mensaje de error de lo que escribió el gestor (vacío, inválido, o mayor que el precio final); null si está bien. */
export function errorBaseManual(texto: string | number | null | undefined, precioFinal: number | ''): string | null {
  if (texto === '' || texto === null || texto === undefined) return MSG_BASE_REQUERIDA
  const n = parseBaseManual(texto)
  if (n === undefined) return MSG_BASE_INVALIDA
  if (precioFinal !== '' && n > precioFinal) return MSG_BASE_SUPERA_PRECIO
  return null
}
