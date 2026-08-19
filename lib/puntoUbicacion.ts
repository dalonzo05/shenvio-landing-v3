// CALC-UX-1 — Entrada y etiquetado de puntos de la Calculadora.
//
// Dos responsabilidades, ambas PURAS (sin React, sin Firebase, sin red):
//
//  1. Interpretar lo que el usuario ESCRIBE a mano: coordenadas `lat,lng` y
//     Plus Codes de Google. Google Places Autocomplete no resuelve ninguno de
//     los dos con la configuración del proyecto (strictBounds + country 'ni'),
//     y la Geocoding API no está activada — así que el Plus Code se decodifica
//     localmente con el algoritmo Open Location Code, sin llamadas externas.
//
//  2. Decidir la ETIQUETA VISIBLE de un punto según cómo se eligió. La
//     identidad del punto siempre son sus coordenadas: la etiqueta es
//     presentación y nunca sustituye a lat/lng (ver nota de deduplicación en
//     CalculadoraPrecio).
//
// La clasificación territorial NO se reimplementa acá: se recibe ya resuelta
// por clasificarPuntoEnZona() de lib/zonas.ts, que es la única fuente.

export type Coord = { lat: number; lng: number }

// ─── Open Location Code (Plus Codes) ─────────────────────────────────────────

const ALFABETO = '23456789CFGHJMPQRVWX'
const SEPARADOR = '+'
const POS_SEPARADOR = 8

/** Centro de Managua — referencia para recuperar Plus Codes cortos ("4QQV+QHM"). */
export const REFERENCIA_MANAGUA: Coord = { lat: 12.1364, lng: -86.2514 }

function esCaracterValido(c: string): boolean {
  return ALFABETO.includes(c.toUpperCase())
}

/** true para un Plus Code completo o corto, con o sin localidad detrás. */
export function pareceOpenLocationCode(texto: string): boolean {
  const t = texto.trim().toUpperCase()
  const m = t.match(/^([23456789CFGHJMPQRVWX]{2,8}\+[23456789CFGHJMPQRVWX]{0,7})\b/)
  if (!m) return false
  return m[1].includes(SEPARADOR)
}

function codificarOLC(lat: number, lng: number, largo = 10): string {
  let latLo = -90
  let lngLo = -180
  let latRes = 20
  let lngRes = 20
  let code = ''
  for (let i = 0; i < largo / 2; i++) {
    const latIdx = Math.min(19, Math.max(0, Math.floor((lat - latLo) / latRes)))
    const lngIdx = Math.min(19, Math.max(0, Math.floor((lng - lngLo) / lngRes)))
    code += ALFABETO[latIdx] + ALFABETO[lngIdx]
    latLo += latIdx * latRes
    lngLo += lngIdx * lngRes
    latRes /= 20
    lngRes /= 20
  }
  return code
}

/** Decodifica un Plus Code COMPLETO (ya sin localidad) a su centro. */
function decodificarOLCCompleto(code: string): Coord | null {
  const limpio = code.replace(/\+/g, '').replace(/0+$/, '').toUpperCase()
  // El tramo de PARES (primeros 10 dígitos) debe ser par; del 11º en adelante
  // son dígitos de rejilla y el largo total puede ser impar legítimamente
  // ("76XQ4QQV+QHM" son 11 dígitos).
  if (limpio.length < 2 || limpio.length > 15) return null
  if (limpio.length <= 10 && limpio.length % 2 !== 0) return null
  for (const c of limpio) if (!esCaracterValido(c)) return null

  let latLo = -90
  let lngLo = -180
  let latRes = 20
  let lngRes = 20
  const largoPares = Math.min(limpio.length, 10)
  let i = 0
  while (i < largoPares) {
    latLo += ALFABETO.indexOf(limpio[i]) * latRes
    lngLo += ALFABETO.indexOf(limpio[i + 1]) * lngRes
    i += 2
    if (i < largoPares) { latRes /= 20; lngRes /= 20 }
  }
  let latTam = latRes
  let lngTam = lngRes
  // Refinamiento en rejilla 5x4 para los dígitos 11+
  for (let j = 10; j < Math.min(limpio.length, 15); j++) {
    latTam /= 5
    lngTam /= 4
    const n = ALFABETO.indexOf(limpio[j])
    latLo += Math.floor(n / 4) * latTam
    lngLo += (n % 4) * lngTam
  }
  const lat = latLo + latTam / 2
  const lng = lngLo + lngTam / 2
  if (!Number.isFinite(lat) || !Number.isFinite(lng)) return null
  return { lat, lng }
}

/**
 * Resuelve un Plus Code a coordenadas. Acepta forma completa
 * ("76XQ4QQV+QHM") y corta con localidad ("4QQV+QHM Managua, Nicaragua"),
 * recuperando esta última contra `referencia`.
 */
export function resolverOpenLocationCode(texto: string, referencia: Coord = REFERENCIA_MANAGUA): Coord | null {
  const t = texto.trim().toUpperCase()
  const m = t.match(/^([23456789CFGHJMPQRVWX]{2,8}\+[23456789CFGHJMPQRVWX]{0,7})/)
  if (!m) return null
  const code = m[1]
  const posMas = code.indexOf(SEPARADOR)
  if (posMas < 0) return null

  // Código completo: el '+' está en la posición 8.
  if (posMas === POS_SEPARADOR) return decodificarOLCCompleto(code)

  // Código corto: se le antepone el prefijo del código completo de la
  // referencia y se elige la celda más cercana a ella.
  const faltantes = POS_SEPARADOR - posMas
  if (faltantes <= 0 || faltantes % 2 !== 0) return null
  const refCompleto = codificarOLC(referencia.lat, referencia.lng, 10)
  const candidato = refCompleto.substring(0, faltantes) + code
  const decodificado = decodificarOLCCompleto(candidato)
  if (!decodificado) return null

  const resolucion = Math.pow(20, 2 - faltantes / 2)
  const media = resolucion / 2
  let { lat, lng } = decodificado
  if (referencia.lat + media < lat && lat - resolucion >= -90) lat -= resolucion
  else if (referencia.lat - media > lat && lat + resolucion <= 90) lat += resolucion
  if (referencia.lng + media < lng && lng - resolucion >= -180) lng -= resolucion
  else if (referencia.lng - media > lng && lng + resolucion <= 180) lng += resolucion
  return { lat, lng }
}

// ─── Coordenadas escritas a mano ─────────────────────────────────────────────

/** Interpreta "12.14009, -86.28753" (coma o espacio). null si no aplica o está fuera de rango. */
export function parsearCoordenadas(texto: string): Coord | null {
  const m = texto.trim().match(/^(-?\d{1,3}(?:\.\d+)?)\s*[,;\s]\s*(-?\d{1,3}(?:\.\d+)?)$/)
  if (!m) return null
  const lat = parseFloat(m[1])
  const lng = parseFloat(m[2])
  if (!Number.isFinite(lat) || !Number.isFinite(lng)) return null
  if (lat < -90 || lat > 90 || lng < -180 || lng > 180) return null
  return { lat, lng }
}

export type EntradaUbicacion =
  | { tipo: 'coordenadas'; coord: Coord }
  | { tipo: 'pluscode'; coord: Coord }
  | { tipo: 'texto' }

/**
 * Clasifica lo que el usuario escribió. 'texto' significa "no es una entrada
 * directa" — lo resuelve Google Places Autocomplete como hasta ahora.
 */
export function interpretarEntrada(texto: string, referencia: Coord = REFERENCIA_MANAGUA): EntradaUbicacion {
  const coord = parsearCoordenadas(texto)
  if (coord) return { tipo: 'coordenadas', coord }
  if (pareceOpenLocationCode(texto)) {
    const c = resolverOpenLocationCode(texto, referencia)
    if (c) return { tipo: 'pluscode', coord: c }
  }
  return { tipo: 'texto' }
}

// ─── Etiquetado visible ──────────────────────────────────────────────────────

/** Coordenadas legibles, con la precisión que ya usaba el fallback de CALC-ERR-1A. */
export function formatearCoord(coord: Coord): string {
  return `${coord.lat.toFixed(5)}, ${coord.lng.toFixed(5)}`
}

/**
 * Etiqueta de un punto elegido en el mapa o escrito como Plus Code/coordenadas.
 * Prioriza el nombre de zona SHView por encima de cualquier texto de Google
 * (que sin Geocoding API devolvería coordenadas o un Plus Code poco legible).
 *
 * `zonaNombre` llega ya resuelto por clasificarPuntoEnZona() — este módulo no
 * reimplementa la clasificación territorial.
 */
export function etiquetaPuntoManual(coord: Coord, zonaNombre: string | null): string {
  if (zonaNombre && zonaNombre.trim()) return zonaNombre.trim()
  return `Punto seleccionado · ${formatearCoord(coord)}`
}

/** Etiqueta para el botón "Mi ubicación". */
export function etiquetaMiUbicacion(coord: Coord, zonaNombre: string | null): string {
  if (zonaNombre && zonaNombre.trim()) return `Tu ubicación · ${zonaNombre.trim()}`
  return `Tu ubicación · ${formatearCoord(coord)}`
}
