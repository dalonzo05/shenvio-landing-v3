// MOTO-STATS-ACEPTACION-UNDEFINED-1 — representación de "Tasa acept." en la ficha
// del motorizado.
//
// SOLO decide cómo se MUESTRA un valor que ya viene calculado. No calcula la tasa,
// no elige de dónde sale ni certifica que su fórmula sea la canónica (ver deuda
// MOTO-STATS-ACEPTACION-CANONICA-1): la ficha, el reporte y el ranking usan hoy
// definiciones distintas.
//
// El valor esperado es un porcentaje 0–100. Cero es un valor válido (una tasa real
// de 0%); la ausencia no es cero.

export const TASA_SIN_DATO = '—'

/** Umbral por debajo del cual la ficha marca la tasa como baja (el que ya usaba la pantalla). */
export const UMBRAL_TASA_BAJA = 70

/** Porcentaje finito dentro de 0–100. Fuera de rango no se recorta: se considera dato inválido. */
export function esTasaAceptacionValida(valor: unknown): valor is number {
  return typeof valor === 'number' && Number.isFinite(valor) && valor >= 0 && valor <= 100
}

/** `<n>%` para un valor válido; `—` para ausente, null, NaN, ±Infinity o fuera de rango. */
export function formatearTasaAceptacion(valor: unknown): string {
  return esTasaAceptacionValida(valor) ? `${valor}%` : TASA_SIN_DATO
}

export type EstiloTasaAceptacion = 'baja' | 'normal' | 'sin_dato'

/** Sin dato es neutral: nunca se pinta como tasa baja. */
export function estiloTasaAceptacion(valor: unknown): EstiloTasaAceptacion {
  if (!esTasaAceptacionValida(valor)) return 'sin_dato'
  return valor < UMBRAL_TASA_BAJA ? 'baja' : 'normal'
}
