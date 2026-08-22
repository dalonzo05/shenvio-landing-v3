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
  estado?: string | null
  destinatario?: DestinoDeposito | string | null
  destinatarioNombre?: string | null
  motorizadoNombre?: string | null
  solicitudIds?: string[] | null
  montoTotal?: number | null
  montoBruto?: number | null
  gastosDescontados?: number | null
  boucher?: { url?: string | null; pathStorage?: string | null } | null
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
