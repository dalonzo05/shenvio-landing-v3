// IDENTIDAD-HUMANA-1 — "Viaje #23" en el panel del comercio.
//
// Contador histórico por comercio, SOLO para UX. No es identidad, no se
// persiste y no viaja a ningún lado: el identificador de la orden sigue siendo
// su ID técnico, y el código operativo interno es SH-N.
//
// ── Qué cuenta como viaje ────────────────────────────────────────────────────
//
// Solo `entregado`. No es una elección estética: `lib/estados-solicitud.ts`
// declara `ESTADO_TERMINAL_DEFINITIVO = 'entregado'` como el único cierre que
// deja rastro financiero, y `rechazada` / `cancelada` como REACTIVABLES —
// nunca llegaron a generar obligación y pueden volver a
// 'pendiente_confirmacion'. Contar una cancelada como viaje haría que el
// ordinal cambiara al reactivarla.
//
// Las órdenes en curso tampoco cuentan: todavía no son un viaje realizado.
// Devuelven null y la UI no enseña ordinal.
//
// ── Por qué no se persiste ───────────────────────────────────────────────────
//
// Calculado se autocorrige ante cancelaciones, borrados e importaciones, y en
// `comercio/mis-ordenes` cuesta cero lecturas extra: esa pantalla ya carga
// TODAS las órdenes del comercio (`where('userId','==',comercioId)`, sin
// límite). El precio es que no es estable: si mañana se borra una orden vieja,
// todos los ordinales posteriores se corren.
//
// Mientras viva solo en pantalla eso es inocuo. En cuanto "Viaje #23" salga a
// un recibo, un WhatsApp o un reclamo, deja de poder moverse y habrá que
// persistirlo. Deuda: ORDINAL-COMERCIO-NO-ESTABLE.
//
// PURO: sin Firestore, sin React, sin fecha actual.

import { ESTADO_TERMINAL_DEFINITIVO } from './estados-solicitud'

export interface EntradaOrdinalComercio {
  id: string
  estado?: string | null
  /** Momento del viaje. Ausente en históricos: se cae a createdAt. */
  entregadoAt?: { toMillis?: () => number } | null
  createdAt?: { toMillis?: () => number } | null
}

const ms = (t: EntradaOrdinalComercio['entregadoAt']): number | null => {
  const n = typeof t?.toMillis === 'function' ? t.toMillis() : null
  return typeof n === 'number' && Number.isFinite(n) ? n : null
}

/** ¿Esta orden cuenta como viaje realizado? */
export function esViajeRealizado(orden: EntradaOrdinalComercio): boolean {
  return orden?.estado === ESTADO_TERMINAL_DEFINITIVO
}

/**
 * Momento por el que se ordenan los viajes.
 *
 * `entregadoAt` es cuándo ocurrió el viaje y es lo correcto. Algunas órdenes
 * entregadas no lo tienen —quedaron así antes de que el campo existiera, y en
 * staging hay una— y para esas se usa `createdAt`, que es el único momento
 * disponible. Sin ninguno de los dos la orden va al final, en un orden
 * estable por ID para que dos renders no la muevan.
 */
function momento(orden: EntradaOrdinalComercio): number | null {
  return ms(orden.entregadoAt) ?? ms(orden.createdAt)
}

/**
 * Ordinal de cada viaje realizado, por ID de orden.
 *
 * El primero entregado es 1. Las órdenes que no son viajes no aparecen en el
 * mapa, y la UI no debe inventarles un número.
 *
 * @param ordenes todas las órdenes del comercio ya cargadas. No se filtra por
 *                comercio acá: quien llama ya tiene solo las suyas.
 */
export function ordinalesDeComercio(ordenes: EntradaOrdinalComercio[]): Record<string, number> {
  const viajes = (Array.isArray(ordenes) ? ordenes : []).filter(
    (o) => o && typeof o.id === 'string' && o.id !== '' && esViajeRealizado(o),
  )

  viajes.sort((a, b) => {
    const ma = momento(a)
    const mb = momento(b)
    // Sin fecha van al final, nunca intercalados: no se les adivina un momento.
    if (ma === null && mb === null) return a.id < b.id ? -1 : a.id > b.id ? 1 : 0
    if (ma === null) return 1
    if (mb === null) return -1
    if (ma !== mb) return ma - mb
    // Empate exacto de milisegundos: desempate estable por ID.
    return a.id < b.id ? -1 : a.id > b.id ? 1 : 0
  })

  const out: Record<string, number> = {}
  viajes.forEach((o, i) => { out[o.id] = i + 1 })
  return out
}

/** Etiqueta lista para pintar, o null si esta orden todavía no es un viaje. */
export function etiquetaOrdinal(ordinal: number | undefined | null): string | null {
  return typeof ordinal === 'number' && Number.isInteger(ordinal) && ordinal > 0
    ? `Viaje #${ordinal}`
    : null
}
