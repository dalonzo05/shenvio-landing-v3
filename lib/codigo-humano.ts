// IDENTIDAD-HUMANA-1 — códigos legibles de órdenes y depósitos: LADO LECTURA.
//
// SH-1058 y DEP-247 son identificadores OPERATIVOS: sirven para nombrar una
// orden por teléfono, buscarla en un panel y cruzarla con un depósito. No son
// identidad ni autorización:
//
//   · el ID técnico de Firestore sigue siendo la única clave y la única FK;
//   · las rutas, los tokens y los enlaces públicos no cambian;
//   · un código NUNCA decide si alguien puede ver algo.
//
// ── Por qué este archivo no es el que ESCRIBE los códigos ────────────────────
//
// El único escritor autoritativo es `functions/src/codigos.ts`, que asigna la
// secuencia dentro de una transacción sobre el contador. Ese archivo no puede
// importar de `lib/`: el tsconfig de Functions declara `include: ["src"]` con
// `outDir: "lib"`, y un import hacia afuera arrastraría el rootDir y cambiaría
// las rutas del artefacto de deploy (ver B2-PAGO-MEDIO, boundary fix).
//
// Así que el FORMATO es un contrato de frontera enunciado en los dos lados:
// allá se escribe `${prefijo}-${n}`, acá se lee. Lo que NO se duplica es la
// decisión: el servidor no valida ni parsea, y este módulo no genera números.
// El solapamiento real son dos constantes y una plantilla, y las dos suites
// lo fijan contra los MISMOS ejemplos literales del bloque —SH-1001, DEP-1001,
// SH-1000000— y no contra una réplica de la lógica del otro.
//
// PURO: sin Firestore, sin React, sin fecha actual.

export const PREFIJO_ORDEN = 'SH'
export const PREFIJO_DEPOSITO = 'DEP'

export type PrefijoCodigo = typeof PREFIJO_ORDEN | typeof PREFIJO_DEPOSITO

export const PREFIJOS: readonly PrefijoCodigo[] = [PREFIJO_ORDEN, PREFIJO_DEPOSITO]

/** Ancho mínimo del número. Por debajo se rellena con ceros. */
export const ANCHO_MINIMO = 4

/**
 * Forma canónica: PREFIJO en mayúsculas, guion y el número con AL MENOS
 * cuatro dígitos. Es lo ÚNICO que puede quedar persistido.
 *
 * El padding existe por una razón de lectura, no de estética: `SH-1` se lee
 * como un identificador provisional o truncado, y `SH-1001` como la orden
 * número mil uno de un negocio que solo lleva una. Cuatro dígitos dan un
 * identificador que se ve completo desde el primero.
 *
 * A partir de 10.000 el número crece solo, sin ancho artificial: rellenar
 * más allá obligaría a elegir un techo, y no hay ninguno. La contrapartida
 * es que el orden lexicográfico deja de coincidir con el numérico en ese
 * salto — no importa, porque quien ordena es `secuencia`, que es número.
 *
 * Dos formas quedan fuera y merecen decirse: `SH-0000` (no hay secuencia 0)
 * y `SH-00001` o `SH-010000` (ceros por encima del ancho mínimo). Un mismo
 * número tiene exactamente una representación válida.
 */
const CANONICO = /^(SH|DEP)-((?!0000)[0-9]{4}|[1-9][0-9]{4,})$/

/**
 * Búsqueda tolerante. Acepta separador guion, espacio o nada, y minúsculas:
 * `SH-1058`, `sh-1058`, `SH 1058`, `sh1058`. También un número suelto.
 *
 * La tolerancia vale solo para BUSCAR. Lo que se guarda es siempre canónico.
 */
// El separador solo se admite DETRÁS de un prefijo: si no, "-5" se leería
// como la secuencia 5 y un texto con guion entraría como código.
const BUSQUEDA = /^(?:(SH|DEP)[\s-]*)?([0-9]+)$/

/** Texto para el ausente. Nunca se muestra sobre un documento con ID. */
export const CODIGO_AUSENTE = 'Sin código'

const texto = (v: unknown): string => (typeof v === 'string' ? v.trim() : '')

/**
 * Compone el código canónico. Espejo exacto de `functions/src/codigos.ts`.
 *
 * Lanza en vez de devolver algo raro: un prefijo o una secuencia inválidos
 * significan que quien llama tiene un bug, y un código mal formado que llegue
 * a persistirse sería peor que el fallo.
 */
export function formatearCodigo(prefijo: string, secuencia: number): string {
  if (!(PREFIJOS as readonly string[]).includes(prefijo)) {
    throw new Error(`prefijo no permitido: ${JSON.stringify(prefijo)}`)
  }
  if (!Number.isInteger(secuencia) || secuencia < 1) {
    throw new Error(`secuencia invalida: ${JSON.stringify(secuencia)}`)
  }
  return `${prefijo}-${String(secuencia).padStart(ANCHO_MINIMO, '0')}`
}

/** ¿Este valor es un código canónico? Estricto: es el contrato de persistencia. */
export function esCodigoCanonico(v: unknown): boolean {
  return typeof v === 'string' && CANONICO.test(v)
}

/** Prefijo de un código canónico, o null. */
export function prefijoDeCodigo(v: unknown): PrefijoCodigo | null {
  const m = typeof v === 'string' ? v.match(CANONICO) : null
  return m ? (m[1] as PrefijoCodigo) : null
}

/**
 * Secuencia de un código canónico, o null. Los ceros del padding no cuentan:
 * `SH-0015` es 15.
 *
 * Solo lee el código: no cae a `secuencia` ni a ningún otro campo. Si los dos
 * están y discrepan, eso es una incoherencia que corresponde detectar, no
 * disimular.
 */
export function secuenciaDeCodigo(v: unknown): number | null {
  const m = typeof v === 'string' ? v.match(CANONICO) : null
  return m ? Number(m[2]) : null
}

export interface ConsultaCodigo {
  /** Ausente cuando el usuario escribió solo el número. */
  prefijo: PrefijoCodigo | null
  secuencia: number
}

/**
 * Interpreta lo que el usuario tecleó en un buscador.
 *
 * Devuelve null cuando no parece un código, y ahí el buscador debe seguir
 * filtrando por los campos de siempre sin cambiar nada.
 *
 * El número suelto se admite —el bloque lo pide— pero se compara por IGUALDAD
 * exacta, nunca como subcadena (ver `coincideCodigo`). Escribir "80" encuentra
 * SH-80 y no SH-1080; y un teléfono de ocho dígitos no va a coincidir con
 * ninguna secuencia real. Así el número suelto no arrastra montos, teléfonos
 * ni el `numeroOrden` del comercio, que es texto libre y vive aparte.
 */
export function parseBusquedaCodigo(consulta: string): ConsultaCodigo | null {
  const q = texto(consulta).toUpperCase()
  if (!q) return null
  const m = q.match(BUSQUEDA)
  if (!m) return null
  // Los ceros a la izquierda se descartan: con el padding son la forma
  // NORMAL de escribir el código, así que "0001" y "1" son la misma orden.
  // `0` y `0000` no lo son: no existe la secuencia cero.
  const secuencia = Number(m[2])
  if (!Number.isSafeInteger(secuencia) || secuencia < 1) return null
  return { prefijo: (m[1] as PrefijoCodigo) ?? null, secuencia }
}

/**
 * ¿El código de este documento responde a lo que se buscó?
 *
 * Con prefijo escrito, tiene que coincidir también el prefijo: buscar
 * "DEP-1058" no debe devolver la orden SH-1058.
 */
export function coincideCodigo(codigo: unknown, consulta: string): boolean {
  if (!esCodigoCanonico(codigo)) return false
  const q = parseBusquedaCodigo(consulta)
  if (!q) return false
  if (q.prefijo && q.prefijo !== prefijoDeCodigo(codigo)) return false
  return secuenciaDeCodigo(codigo) === q.secuencia
}

/**
 * Qué se enseña como identificador de un documento.
 *
 * Los históricos no tienen código y no se les va a inventar uno: se cae al ID
 * corto, que es lo que esas pantallas mostraban antes de este bloque. Nunca se
 * devuelve "—" habiendo un ID: el documento SÍ tiene identidad, solo que
 * técnica.
 */
export function mostrarCodigo(codigo: unknown, id?: string | null, largo = 8): string {
  if (esCodigoCanonico(codigo)) return texto(codigo)
  const tecnico = texto(id)
  if (tecnico) return tecnico.slice(0, largo)
  return CODIGO_AUSENTE
}

/** true cuando `mostrarCodigo` devolvió el ID técnico y no un código. */
export function esFallbackTecnico(codigo: unknown): boolean {
  return !esCodigoCanonico(codigo)
}
