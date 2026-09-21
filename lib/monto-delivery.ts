// FIN-TRAZABILIDAD-UX-2 — Cuánto vale el delivery que se cobró.
//
// Causa del "C$0" en Cobros → Historial cobrados y en "Resultado del cobro":
// esas dos superficies leían `cobroDelivery.monto`, que NO es el monto del
// delivery sino el PENDIENTE de cobro. Lo escribe la Function al entregar
// (functions/src/motorizado-transiciones.ts, construirCobroDelivery):
//
//   sin deducción del CE   monto = precio del delivery
//   con deducción del CE   monto = faltante (lo que el efectivo del producto
//                          no alcanzó a cubrir), y además:
//                            montoDelivery       = precio del delivery
//                            cubiertoPorDeposito = parte cubierta por el CE
//                          invariante: monto + cubiertoPorDeposito === montoDelivery
//
// SH-0005: delivery C$90 deducido de un cobro contra entrega de C$1,000 que
// alcanzó de sobra → monto 0, montoDelivery 90, cubiertoPorDeposito 90. El
// delivery SÍ se cobró (C$90, que DEP-0004 llevó a StorkHub), pero la pantalla
// mostraba el pendiente, que es 0.
//
// La regla es la misma que ya usa estadoDeliveryComercio() para el comercio
// (`montoDelivery || monto`), con su misma cadena de fallback. Nunca se suma
// nada: ni el producto (C$910, del comercio) ni los depósitos.
//
// PURO: sin Firestore, sin React.

export type FuenteMontoDelivery = 'montoDelivery' | 'monto' | 'precioConfirmado'

export interface MontoDeliveryCobrado {
  /** null = no hay ningún dato persistido del que salga; no se inventa. */
  monto: number | null
  fuente: FuenteMontoDelivery | null
}

export interface EntradaMontoDelivery {
  cobroDelivery?: {
    monto?: number | null
    montoDelivery?: number | null
  } | null
  confirmacion?: { precioFinalCordobas?: number | null } | null
}

const esNumero = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v)

/**
 * Monto del delivery cobrado, para las superficies que muestran lo COBRADO
 * (Historial cobrados, Resultado del cobro, el evento del historial).
 *
 * Las superficies de lo PENDIENTE siguen leyendo `cobroDelivery.monto`: ahí
 * el faltante es justamente el dato correcto.
 */
export function montoDeliveryCobrado(orden: EntradaMontoDelivery | null | undefined): MontoDeliveryCobrado {
  const cd = orden?.cobroDelivery
  // Con deducción del CE: el precio del delivery que persistió la Function.
  if (esNumero(cd?.montoDelivery)) return { monto: cd!.montoDelivery as number, fuente: 'montoDelivery' }
  // Sin deducción, `monto` ES el precio del delivery (incluido un 0 legítimo).
  if (esNumero(cd?.monto)) return { monto: cd!.monto as number, fuente: 'monto' }
  // Mismo fallback que ya usaban Cobros y el drawer: el precio confirmado.
  const precio = orden?.confirmacion?.precioFinalCordobas
  if (esNumero(precio)) return { monto: precio, fuente: 'precioConfirmado' }
  return { monto: null, fuente: null }
}

/**
 * Parte del delivery que se cubrió con el efectivo del cobro contra entrega.
 * null cuando no hubo deducción: no se afirma una cobertura que no existió.
 */
export function deliveryCubiertoPorCobroProducto(orden: {
  cobroDelivery?: {
    cubiertoPorDeposito?: number | null
    monto?: number | null
    montoDelivery?: number | null
  } | null
} | null | undefined): number | null {
  const v = orden?.cobroDelivery?.cubiertoPorDeposito
  return esNumero(v) && v > 0 ? v : null
}
