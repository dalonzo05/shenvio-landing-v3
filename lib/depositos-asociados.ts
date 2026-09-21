// FIN-TRAZABILIDAD-UX-2 — "Depósitos asociados (N)" de la ficha de una orden.
//
// Una orden puede tener 0, 1 o varios depósitos: uno a StorkHub y otro al
// comercio (SH-0005: DEP-0004 C$90 + DEP-0005 C$910), el pago del delivery
// por transferencia (tipo C), o un depósito anulado y uno nuevo que lo
// reemplazó. Cada uno es una obligación distinta: acá se listan por
// separado y NUNCA se suman —C$90 es de StorkHub y C$910 del comercio—.
//
// La lista es un registro documental (qué depósitos existen, en qué estado,
// quién los confirmó). La obligación derivada de la orden la sigue mostrando
// BloqueDepositos y los comprobantes, "Evidencias financieras".
//
// PURO: sin Firestore, sin React.

import type { DepositoRegistrado } from './deposito-orden'
import {
  identidadDeposito,
  origenDestinoDeposito,
  estadoDeposito,
  type IdentidadDeposito,
} from './presentacion-deposito'
import { momentosDeposito, type MomentoDeposito } from './pago-transferencia'
import { normalizarFecha } from './timeline-orden'

export interface FilaDepositoAsociado {
  id: string
  identidad: IdentidadDeposito
  /** "Motorizado → StorkHub", "John Pork 2 → Mariposita", "Pago del delivery por transferencia". */
  origenDestino: string
  /** Total del documento. Con un depósito agrupado incluye órdenes ajenas. */
  monto: number | null
  estado: string
  estadoClave: string | null
  /** Por tipo: A/B "Enviado"/"Confirmado"; C "Comprobante enviado"/"Pago confirmado". */
  momentos: MomentoDeposito[]
  /** Solo mientras el depósito está confirmado: tras un Rehacer ya no lo está. */
  confirmadoPorUid: string | null
  ordenesIncluidas: number
  esAgrupado: boolean
  /** Versión vigente del comprobante cuando se corrigió (≥ 2); null si nunca. */
  versionComprobante: number | null
}

const ms = (v: unknown) => normalizarFecha(v)?.getTime() ?? Number.MAX_SAFE_INTEGER

/**
 * @param depositos        depósitos cuyo `solicitudIds` incluye la orden
 * @param orden            la orden (para los momentos del tipo C)
 * @param nombreMotorizado nombre resuelto del motorizado de un depósito, o null
 */
export function filasDepositosAsociados(
  depositos: Array<DepositoRegistrado | null | undefined>,
  orden?: Parameters<typeof momentosDeposito>[1],
  nombreMotorizado: (dep: DepositoRegistrado) => string | null = () => null,
): FilaDepositoAsociado[] {
  const unicos = new Map<string, DepositoRegistrado>()
  for (const d of depositos) if (d && typeof d.id === 'string' && !unicos.has(d.id)) unicos.set(d.id, d)
  return [...unicos.values()]
    .sort((a, b) => ms(a.creadoAt) - ms(b.creadoAt) || a.id.localeCompare(b.id))
    .map((d) => {
      const ids = Array.isArray(d.solicitudIds) ? d.solicitudIds : []
      const v = d.boucherVersion
      return {
        id: d.id,
        identidad: identidadDeposito(d),
        origenDestino: origenDestinoDeposito(d, nombreMotorizado(d)).texto,
        monto: typeof d.montoTotal === 'number' && Number.isFinite(d.montoTotal) ? d.montoTotal : null,
        estado: estadoDeposito(d),
        estadoClave: d.estado ?? null,
        momentos: momentosDeposito(d, orden ?? null),
        confirmadoPorUid: d.estado === 'confirmado' && typeof d.confirmadoPorUid === 'string' && d.confirmadoPorUid
          ? d.confirmadoPorUid
          : null,
        ordenesIncluidas: ids.length,
        esAgrupado: ids.length > 1,
        versionComprobante: typeof v === 'number' && Number.isInteger(v) && v >= 2 ? v : null,
      }
    })
}

/** Siempre en plural y con el número: una orden no tiene "el" depósito. */
export function tituloDepositosAsociados(n: number): string {
  return `Depósitos asociados (${Math.max(0, n)})`
}

/** UIDs de quienes confirmaron, para resolverlos a nombre en una sola pasada. */
export function uidsDepositosAsociados(filas: FilaDepositoAsociado[]): string[] {
  return [...new Set(filas.map((f) => f.confirmadoPorUid).filter((u): u is string => !!u))]
}
