// MOTORIZADO-UX-OPERATIVA-1 — La tarjeta de un viaje en el Historial del
// motorizado: SH-N, zonas, fecha, delivery y forma de cobro.
//
// Solo presentación sobre la orden que el panel ya escucha: sin reads, sin
// fórmula financiera nueva. La forma de cobro sale de calcularDeposito() —la
// misma clasificación que decide lo que el motorizado deposita— y la ganancia
// NO se calcula acá: el panel la sigue mostrando como antes (deuda
// MOTO-GANANCIA-FUENTE-INCONSISTENTE, que requiere decisión financiera).
//
// PURO: sin Firestore, sin React, sin efectos.

import { calcularDeposito, type EntradaCalculoDeposito } from './calculo-deposito'
import { mostrarCodigo } from './codigo-humano'

export const SIN_ZONA = '—'

export interface OrdenHistorialViaje extends EntradaCalculoDeposito {
  id: string
  codigo?: unknown
  estado?: string | null
  entregadoAt?: unknown
  zonaRetiroNombre?: string | null
  macroZonaRetiroNombre?: string | null
  zonaEntregaNombre?: string | null
  macroZonaEntregaNombre?: string | null
}

export type ClaveFormaCobro = 'efectivo' | 'transferencia' | 'credito' | 'no_cobrado' | 'sin_delivery'

export interface FormaCobroViaje {
  clave: ClaveFormaCobro
  texto: string
}

export interface ResumenViajeHistorial {
  codigo: string
  zonaRetiro: string
  zonaEntrega: string
  estado: string
  /** Instante de la entrega, sin formatear: la página lo pasa por fechaHoraOperativa. */
  entregadoAt: unknown
  /** El mismo precio que la tarjeta mostraba antes (confirmacion.precioFinalCordobas). */
  delivery: number | null
  formaCobro: FormaCobroViaje
}

const nombre = (v: unknown): string | null => (typeof v === 'string' && v.trim() ? v.trim() : null)

/** Zona concreta → macrozona → "—". Nunca un ID. */
export function zonaViaje(zona: unknown, macroZona: unknown): string {
  return nombre(zona) ?? nombre(macroZona) ?? SIN_ZONA
}

/**
 * Cómo se cobró el delivery de este viaje, con las mismas reglas que
 * calcularDeposito(): transferencia y crédito no pasan por el motorizado;
 * efectivo es lo que entró a su caja.
 */
export function formaCobroViaje(orden: EntradaCalculoDeposito): FormaCobroViaje {
  const c = calcularDeposito(orden)
  const quienPaga = orden.pagoDelivery?.quienPaga || ''
  if (c.deliveryPorTransferencia) return { clave: 'transferencia', texto: 'Transferencia del comercio' }
  if (orden.tipoCliente === 'credito' || quienPaga === 'credito_semanal') return { clave: 'credito', texto: 'Crédito semanal del comercio' }
  if (c.tieneDelivery) return { clave: 'efectivo', texto: 'Efectivo' }
  if (orden.cobrosMotorizado?.delivery?.recibio === false) return { clave: 'no_cobrado', texto: 'No se cobró en la entrega' }
  return { clave: 'sin_delivery', texto: 'Sin cobro de delivery' }
}

const ETIQUETA_ESTADO: Record<string, string> = { entregado: 'Entregada' }

export function resumenViajeHistorial(orden: OrdenHistorialViaje): ResumenViajeHistorial {
  const precio = orden.confirmacion?.precioFinalCordobas
  return {
    codigo: mostrarCodigo(orden.codigo, orden.id, 8),
    zonaRetiro: zonaViaje(orden.zonaRetiroNombre, orden.macroZonaRetiroNombre),
    zonaEntrega: zonaViaje(orden.zonaEntregaNombre, orden.macroZonaEntregaNombre),
    estado: ETIQUETA_ESTADO[orden.estado ?? ''] ?? (orden.estado || '—'),
    entregadoAt: orden.entregadoAt ?? null,
    delivery: typeof precio === 'number' && Number.isFinite(precio) ? precio : null,
    formaCobro: formaCobroViaje(orden),
  }
}
