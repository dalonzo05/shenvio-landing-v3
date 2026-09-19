// B2.3 — Trazabilidad de depósitos de UNA orden, para la ficha autoritativa.
//
// Une dos cosas que NO son lo mismo y que la UI debe mostrar separadas:
//
//   A. OBLIGACIÓN DERIVADA de la orden — cuánto debía depositar el motorizado
//      por el dinero que realmente recibió. Sale de calcularDeposito(), que
//      sigue siendo la única fórmula financiera.
//
//   B. DEPÓSITO REAL REGISTRADO — el documento de ordenes_deposito, si existe.
//
// Confundirlas produce dos errores opuestos: mostrar como depositado algo que
// nunca se cobró, o cobrarle al motorizado el total de un depósito agrupado
// que incluye órdenes ajenas.
//
// PURO: sin Firestore, sin React, sin efectos. Solo presentación — la
// aritmética financiera no vive acá.

import { calcularDeposito, type EntradaCalculoDeposito } from './calculo-deposito'

export type DestinoDeposito = 'storkhub' | 'comercio'

/** Forma real de ordenes_deposito (ver DepositoOrderDoc en gestor/depositos). */
export interface DepositoRegistrado {
  id: string
  /** DEP-N. Lo asigna el trigger; los históricos no lo tienen. */
  codigo?: string | null
  secuencia?: number | null
  /** Qué movimiento de dinero representa. Ver presentacion-deposito.ts. */
  tipo?: string | null
  estado?: string | null
  destinatario?: DestinoDeposito | string | null
  destinatarioId?: string | null
  destinatarioNombre?: string | null
  /** UID de Auth del motorizado en los tipos de recaudación. */
  motorizadoUid?: string | null
  motorizadoNombre?: string | null
  solicitudIds?: string[] | null
  montoTotal?: number | null
  montoBruto?: number | null
  gastosDescontados?: number | null
  boucher?: { url?: string | null; pathStorage?: string | null; uploadedAt?: unknown } | null
  /** Forma plana del pago del delivery por transferencia (tipo C). */
  boucherUrl?: string | null
  // ── DEPOSITO-AUDITORIA-1 · versionado del comprobante ───────────────────
  // Ausentes en todo depósito nunca reemplazado, históricos incluidos: se
  // leen como VERSIÓN 1 IMPLÍCITA (ver lib/deposito-boucher-version.ts). No
  // se exigen jamás, ni se rellenan con un backfill.
  boucherVersion?: number | null
  boucherVersionId?: string | null
  /** Evento de la subcolección que acompaña a la última transición auditada. */
  ultimoEventoId?: string | null
  // ── DEPOSITO-AUDITORIA-1 · corrección solicitada ────────────────────────
  devueltoAt?: unknown
  devueltoPorUid?: string | null
  motivoDevolucion?: string | null
  // ── DEPOSITO-AUDITORIA-1 · Rehacer auditado ─────────────────────────────
  rehechoAt?: unknown
  rehechoPorUid?: string | null
  motivoRehacer?: string | null
  anuladoAt?: unknown
  anuladoPorUid?: string | null
  motivoAnulacion?: string | null
  updatedAt?: unknown
  creadoAt?: unknown
  confirmadoAt?: unknown
  confirmadoPorUid?: string | null
  digitadoPorUid?: string | null
  digitadoAt?: unknown
  rechazadoAt?: unknown
  rechazadoPor?: string | null
  motivoRechazo?: string | null
  notaConversion?: string | null
  saldoId?: string | null
}

export interface EntradaDepositoOrden extends EntradaCalculoDeposito {
  registro?: {
    deposito?: {
      storkhubDepositoId?: string | null
      comercioDepositoId?: string | null
      confirmadoStorkhub?: boolean | null
      confirmadoComercio?: boolean | null
      confirmadoStorkhubAt?: unknown
      confirmadoComercioAt?: unknown
    } | null
  } | null
}

export type ClaveLinea =
  | 'no_corresponde'  // la orden no generó obligación: nada que depositar
  | 'sin_deposito'    // hay obligación pero todavía no se registró depósito
  | 'registrado'      // existe documento de ordenes_deposito

export interface LineaDeposito {
  destino: DestinoDeposito
  etiqueta: string
  /** Lo que esta orden obliga a depositar. Nunca el total de un agrupado. */
  obligacion: number
  clave: ClaveLinea
  /** Texto del estado, listo para pintar. */
  texto: string
  deposito: DepositoRegistrado | null
  /** El depósito incluye más órdenes además de esta. */
  esAgrupado: boolean
  /** Cuántas órdenes agrupa el depósito registrado. 0 si no hay depósito. */
  ordenesEnDeposito: number
  /** Confirmado según los flags de la propia orden. */
  confirmado: boolean
}

const num = (v: unknown): number => (typeof v === 'number' && Number.isFinite(v) ? v : 0)

/** Etiqueta legible de un estado de ordenes_deposito. */
export function etiquetaEstadoDeposito(estado: string | null | undefined): string {
  switch (estado) {
    case 'pendiente_boucher': return 'Esperando comprobante'
    case 'en_revision': return 'En revisión'
    // DEPOSITO-AUDITORIA-1 — 'devuelto' NO es un rechazo: el depósito sigue
    // vivo, con su DEP-N y su comprobante anterior, esperando una foto mejor.
    // Decirle "Devuelto" o "Rechazado" al motorizado sugeriría que perdió el
    // depósito, que es justo lo que este bloque vino a dejar de hacer.
    case 'devuelto': return 'Corrección solicitada'
    case 'confirmado': return 'Confirmado'
    case 'rechazado': return 'Rechazado'
    case 'convertido_en_deuda': return 'Convertido en deuda'
    case 'anulado': return 'Anulado'
    default: return estado ? estado : 'Sin estado'
  }
}

/**
 * Las dos líneas de depósito de una orden: StorkHub y comercio.
 *
 * @param orden      documento de solicitudes_envio
 * @param depositos  documentos de ordenes_deposito ya leídos por ID, indexados
 *                   por destino. Este módulo no consulta nada.
 */
export function lineasDeposito(
  orden: EntradaDepositoOrden,
  depositos: Partial<Record<DestinoDeposito, DepositoRegistrado | null>> = {},
): LineaDeposito[] {
  const calc = calcularDeposito(orden)
  const reg = orden.registro?.deposito

  const construir = (
    destino: DestinoDeposito,
    etiqueta: string,
    obligacion: number,
    confirmado: boolean,
  ): LineaDeposito => {
    const dep = depositos[destino] ?? null
    const ids = dep?.solicitudIds ?? []
    const ordenesEnDeposito = Array.isArray(ids) ? ids.length : 0

    let clave: ClaveLinea
    let texto: string
    if (dep) {
      clave = 'registrado'
      texto = etiquetaEstadoDeposito(dep.estado)
    } else if (obligacion > 0) {
      // Hay obligación real —el motorizado sí recibió ese dinero— y todavía
      // nadie registró el depósito.
      clave = 'sin_deposito'
      texto = 'Pendiente de depósito'
    } else {
      // Sin obligación no se dice "pendiente": no hay nada que esperar.
      clave = 'no_corresponde'
      texto = 'No corresponde'
    }

    return {
      destino,
      etiqueta,
      obligacion,
      clave,
      texto,
      deposito: dep,
      esAgrupado: ordenesEnDeposito > 1,
      ordenesEnDeposito,
      confirmado,
    }
  }

  return [
    construir('storkhub', 'A StorkHub', num(calc.totalAStorkhub), reg?.confirmadoStorkhub === true),
    construir('comercio', 'Al comercio', num(calc.totalAlComercio), reg?.confirmadoComercio === true),
  ]
}

/**
 * ¿Esta orden genera alguna obligación de depósito?
 *
 * Si no, la ficha lo dice explícitamente en vez de mostrar dos ceros
 * "pendientes" — que sugerirían una deuda inexistente.
 */
export function tieneObligacionDeposito(orden: EntradaDepositoOrden): boolean {
  const calc = calcularDeposito(orden)
  return num(calc.totalAStorkhub) > 0 || num(calc.totalAlComercio) > 0
}

/** IDs de depósito referenciados por la orden, para leerlos por getDoc. */
export function idsDepositoDeOrden(orden: EntradaDepositoOrden): Array<{ destino: DestinoDeposito; id: string }> {
  const reg = orden.registro?.deposito
  const out: Array<{ destino: DestinoDeposito; id: string }> = []
  if (typeof reg?.storkhubDepositoId === 'string' && reg.storkhubDepositoId) {
    out.push({ destino: 'storkhub', id: reg.storkhubDepositoId })
  }
  if (typeof reg?.comercioDepositoId === 'string' && reg.comercioDepositoId) {
    out.push({ destino: 'comercio', id: reg.comercioDepositoId })
  }
  return out
}

// ─── FIN-SEMANTICA-UX-1 ───────────────────────────────────────────────────────
//
// Resumen de UNA orden en UN valor, para las superficies que tienen una sola
// celda —la columna DEPOSITADO de Base, su filtro y su CSV— y no espacio para
// las dos líneas.
//
// Existe porque esa columna leía `confirmadoComercio` / `confirmadoStorkhub` y
// nada más, y esos dos booleanos no distinguen tres cosas que son distintas:
//
//   · "no hay nada que depositar"  de  "falta depositar"
//     → una orden sin cobro contra entrega mostraba "⏳ Comercio", sugiriendo
//       una deuda con el comercio donde la obligación es 0.
//
//   · "confirmado"  de  "convertido en deuda"
//     → convertirDepositoEnDeuda() escribe el MISMO confirmadoStorkhubAt que
//       una confirmación real, así que un depósito que el motorizado nunca
//       pagó se mostraba como "✓ Storkhub".
//
// Ambos casos conviven hoy en la misma orden histórica (yomoyxzBvljBwiEkwhaI).
//
// No añade lógica: lee las dos líneas de lineasDeposito() y elige el texto.

/** Cuando las dos líneas relevantes no dicen lo mismo. */
export const ETIQUETA_RESUMEN_MIXTO = 'Parcial'

/**
 * Textos que puede devolver `resumenDepositoOrden().etiqueta`, para poblar el
 * desplegable del filtro.
 *
 * No es exhaustivo por construcción: `etiquetaEstadoDeposito()` devuelve el
 * estado crudo cuando no lo reconoce, así que un estado inesperado produciría
 * un texto fuera de esta lista. Es el mismo comportamiento que ya tenía la
 * columna y se prefiere a inventarle una etiqueta a un dato que no entendemos.
 */
export const ETIQUETAS_RESUMEN_DEPOSITO: readonly string[] = [
  'No corresponde',
  'Pendiente de depósito',
  'Esperando comprobante',
  'En revisión',
  'Corrección solicitada',
  'Confirmado',
  'Convertido en deuda',
  'Rechazado',
  'Anulado',
  ETIQUETA_RESUMEN_MIXTO,
]

export interface ResumenDepositoOrden {
  /** Las dos líneas, tal como las devuelve lineasDeposito(). */
  lineas: LineaDeposito[]
  /**
   * Solo las que exigen algo: obligación > 0, o depósito ya registrado.
   *
   * Un depósito registrado entra aunque la obligación calculada sea 0: existe
   * el documento, tiene un estado y esconderlo sería perder el rastro.
   */
  relevantes: LineaDeposito[]
  /** Un único texto para celda estrecha, filtro y CSV. */
  etiqueta: string
}

/**
 * Estado de depósito de una orden, resumido.
 *
 * Sin obligación y sin depósito no se dice "Pendiente": no hay nada que
 * esperar. Con depósito registrado se dice SU estado real —nunca un ✓ binario
 * derivado de `confirmadoXAt`, que también se escribe al convertir en deuda.
 */
export function resumenDepositoOrden(
  orden: EntradaDepositoOrden,
  depositos: Partial<Record<DestinoDeposito, DepositoRegistrado | null>> = {},
): ResumenDepositoOrden {
  const lineas = lineasDeposito(orden, depositos)
  const relevantes = lineas.filter((l) => l.clave !== 'no_corresponde' || l.deposito !== null)

  let etiqueta: string
  if (relevantes.length === 0) {
    etiqueta = 'No corresponde'
  } else {
    const textos = [...new Set(relevantes.map((l) => l.texto))]
    etiqueta = textos.length === 1 ? textos[0] : ETIQUETA_RESUMEN_MIXTO
  }

  return { lineas, relevantes, etiqueta }
}

// ─── TRAZABILIDAD-DINERO-UX-1 ─────────────────────────────────────────────────
//
// Qué se puede AFIRMAR del depósito de una orden desde una vista que no
// siempre tiene los documentos de ordenes_deposito a mano.
//
// El problema: lineasDeposito() decide "Pendiente de depósito" solo porque no
// le pasaron el documento, sin mirar si la orden apunta a uno. Llamada con `{}`
// desde una vista barata, convierte un depósito confirmado en una deuda. Para
// no inventar esa deuda, el drawer compartido, el de Base y Cobros dejaron de
// hablar de depósitos — y así escondieron la deuda REAL de SH-0001: el
// motorizado cobró C$110 en efectivo y todavía no los depositó.
//
// La salida es el mismo criterio que ya usa estado-contable-base.ts: el
// puntero de la propia orden (`registro.deposito.<destino>DepositoId`) es lo
// que distingue los dos casos, y está en la orden, sin leer nada más.
//
//   con documento leído         → su estado real (Confirmado, En revisión…)
//   con puntero, sin documento  → "Depósito registrado": existe, estado no visto
//   sin puntero, obligación > 0 → "Pendiente de depósito": nadie lo registró
//   sin puntero, obligación 0   → no corresponde, no se muestra
//
// No añade lógica financiera: la obligación sigue saliendo de
// calcularDeposito() vía lineasDeposito(), y el texto de cada estado de
// etiquetaEstadoDeposito().

/** Lo único que se afirma de un depósito que existe pero no se leyó. */
export const TEXTO_DEPOSITO_SIN_DETALLE = 'Depósito registrado'

export type ClaveDepositoVisible = 'pendiente' | 'registrado' | 'registrado_sin_detalle'

export interface LineaDepositoVisible {
  destino: DestinoDeposito
  /** 'StorkHub' | 'Comercio'. */
  destinoEtiqueta: string
  /** Lo que ESTA orden obliga a depositar. Nunca el total de un agrupado. */
  obligacion: number
  clave: ClaveDepositoVisible
  /** Estado del documento de ordenes_deposito, solo si se leyó. */
  estado: string | null
  texto: string
  /**
   * Quién tiene el dinero ahora. Solo se afirma cuando no hay depósito
   * registrado: la obligación sale de calcularDeposito(), que modela el
   * efectivo que recibió el motorizado, así que sin depósito lo tiene él.
   */
  responsable: string | null
}

export interface DepositoVisible {
  /** Solo destinos que exigen algo o que ya tienen depósito. */
  lineas: LineaDepositoVisible[]
  /** Hay al menos un depósito demostrablemente abierto. */
  pendiente: boolean
  /** Hay un depósito registrado cuyo estado esta vista no leyó. */
  desconocido: boolean
  /** Un único texto corto, para una celda. */
  resumen: string
}

/**
 * Documentos de un cache por ID, indexados por destino según los punteros de
 * la orden. Un depósito referenciado que todavía no está en el cache queda en
 * null: nunca se inventa.
 */
export function depositosDesdeCache(
  orden: EntradaDepositoOrden,
  cache: Record<string, DepositoRegistrado>,
): Partial<Record<DestinoDeposito, DepositoRegistrado | null>> {
  const out: Partial<Record<DestinoDeposito, DepositoRegistrado | null>> = {}
  for (const { destino, id } of idsDepositoDeOrden(orden)) out[destino] = cache[id] ?? null
  return out
}

function resumenLinea(l: LineaDepositoVisible): string {
  if (l.clave === 'pendiente') return l.responsable ? `Pendiente · ${l.responsable}` : 'Pendiente'
  if (l.clave === 'registrado_sin_detalle') return 'Registrado'
  return l.estado === 'confirmado' ? `Confirmado · ${l.destinoEtiqueta}` : l.texto
}

/**
 * Estado visible del depósito de una orden.
 *
 * @param orden      documento de solicitudes_envio
 * @param depositos  documentos ya leídos, por destino. Puede venir vacío: el
 *                   resultado nunca afirma una deuda por no tenerlos.
 */
export function depositoVisible(
  orden: EntradaDepositoOrden,
  depositos: Partial<Record<DestinoDeposito, DepositoRegistrado | null>> = {},
): DepositoVisible {
  const punteros = new Set(idsDepositoDeOrden(orden).map((r) => r.destino))
  const lineas: LineaDepositoVisible[] = []

  for (const l of lineasDeposito(orden, depositos)) {
    const base = {
      destino: l.destino,
      destinoEtiqueta: l.destino === 'storkhub' ? 'StorkHub' : 'Comercio',
      obligacion: l.obligacion,
    }
    if (l.deposito) {
      lineas.push({ ...base, clave: 'registrado', estado: l.deposito.estado ?? null, texto: l.texto, responsable: null })
    } else if (punteros.has(l.destino)) {
      // Existe el documento y no lo tenemos. Ni "pendiente" ni "confirmado":
      // tampoco sirve confirmadoStorkhub, que convertir en deuda también escribe.
      lineas.push({ ...base, clave: 'registrado_sin_detalle', estado: null, texto: TEXTO_DEPOSITO_SIN_DETALLE, responsable: null })
    } else if (l.obligacion > 0) {
      lineas.push({ ...base, clave: 'pendiente', estado: null, texto: l.texto, responsable: 'Motorizado' })
    }
  }

  // Abierto = nadie lo depositó, o hay documento y no está confirmado
  // (en revisión, esperando comprobante, rechazado, convertido en deuda,
  // anulado). Mismo criterio que resumenOrden() usa en la ficha.
  const pendiente = lineas.some(
    (l) => l.clave === 'pendiente' || (l.clave === 'registrado' && l.estado !== 'confirmado'),
  )
  const desconocido = lineas.some((l) => l.clave === 'registrado_sin_detalle')

  let resumen: string
  if (lineas.length === 0) {
    resumen = 'No corresponde'
  } else {
    const textos = [...new Set(lineas.map(resumenLinea))]
    resumen = textos.length === 1 ? textos[0] : ETIQUETA_RESUMEN_MIXTO
  }

  return { lineas, pendiente, desconocido, resumen }
}
