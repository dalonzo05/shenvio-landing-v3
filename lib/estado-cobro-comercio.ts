// B1.2D — Cómo el panel del COMERCIO debe leer el estado de sus cobros.
//
// No calcula dinero: solo interpreta lo que B1.2 ya persistió. El cálculo
// financiero vive en lib/calculo-deposito.ts y en la Function, y no se toca.
//
// El problema que resuelve: la UI del comercio derivaba el estado del delivery
// de `cobrosMotorizado.delivery.recibio` — que responde "¿el motorizado recibió
// efectivo?" — y lo mostraba como si respondiera "¿el delivery está saldado?".
// Mientras el delivery se cobraba entero o no se cobraba, las dos preguntas
// tenían la misma respuesta. Con un faltante parcial dejan de tenerla:
//
//   producto 100 · delivery 150 · deducido del CE
//   → el motorizado recibió los 100 y cubrió 100 del delivery: recibio = true
//   → pero quedan 50 sin cobrar: cobroDelivery.estado = 'pendiente', monto = 50
//
// Fuente autoritativa: `cobroDelivery`. `cobrosMotorizado.delivery` queda solo
// como fallback para órdenes anteriores a B1.2.
//
// PURO: sin Firestore, sin React, sin efectos, sin fecha actual.

import { calcularDeposito, type EntradaCalculoDeposito } from './calculo-deposito'

export type ClaveEstadoDelivery =
  | 'na'              // no aplica: aún no entregado, o sin dato
  | 'pendiente'       // se debe dinero
  | 'en_revision'     // el comercio subió comprobante, falta que el gestor confirme
  | 'pagado'
  | 'no_cobrar'       // se dio por perdido
  | 'revertido'

export interface EstadoDeliveryComercio {
  clave: ClaveEstadoDelivery
  /** Lo que falta cobrar. 0 cuando no se debe nada. */
  montoPendiente: number
  /** Precio total del delivery, aunque parte ya esté cubierta. */
  montoDelivery: number
  /** Parte cubierta con el cobro contra entrega (0 si no hubo deducción). */
  cubiertoPorDeposito: number
  /** Hay un faltante parcial: parte cubierta y parte pendiente. */
  esParcial: boolean
}

export interface EntradaEstadoComercio extends EntradaCalculoDeposito {
  cobroDelivery?: {
    estado?: string | null
    monto?: number | null
    montoDelivery?: number | null
    cubiertoPorDeposito?: number | null
  } | null
  registro?: { deposito?: { confirmadoComercio?: boolean | null; comercioDepositoId?: string | null } | null } | null
}

const num = (v: unknown): number => (typeof v === 'number' && Number.isFinite(v) ? v : 0)

/**
 * Estado del cobro del delivery desde la óptica del comercio.
 *
 * Fallbacks legacy: sin `montoDelivery` se usa `monto`, y sin
 * `cubiertoPorDeposito` se asume 0 — que es exactamente el comportamiento
 * anterior a B1.2, donde `monto` era el delivery completo.
 */
export function estadoDeliveryComercio(orden: EntradaEstadoComercio): EstadoDeliveryComercio {
  const cd = orden.cobroDelivery
  const precioLista = num(orden.confirmacion?.precioFinalCordobas)

  // Sin cobroDelivery no hay nada persistido todavía (orden no entregada, o
  // anterior a que existiera el campo): se cae al dato del motorizado.
  if (!cd || typeof cd !== 'object') {
    const d = orden.cobrosMotorizado?.delivery
    if (!d) return { clave: 'na', montoPendiente: 0, montoDelivery: precioLista, cubiertoPorDeposito: 0, esParcial: false }
    const debe = d.recibio === false
    return {
      clave: debe ? 'pendiente' : 'pagado',
      montoPendiente: debe ? precioLista : 0,
      montoDelivery: precioLista,
      cubiertoPorDeposito: 0,
      esParcial: false,
    }
  }

  const monto = cd.monto === null || cd.monto === undefined ? precioLista : num(cd.monto)
  const montoDelivery = num(cd.montoDelivery) || monto
  const cubierto = num(cd.cubiertoPorDeposito)

  const estado = typeof cd.estado === 'string' ? cd.estado : ''
  let clave: ClaveEstadoDelivery
  switch (estado) {
    case 'pagado': clave = 'pagado'; break
    case 'en_revision_deposito': clave = 'en_revision'; break
    case 'no_cobrar': clave = 'no_cobrar'; break
    case 'revertido': clave = 'revertido'; break
    case 'pendiente': clave = 'pendiente'; break
    default: clave = monto > 0 ? 'pendiente' : 'na'
  }

  const debeDinero = clave === 'pendiente' || clave === 'en_revision'
  return {
    clave,
    montoPendiente: debeDinero ? monto : 0,
    montoDelivery,
    cubiertoPorDeposito: cubierto,
    esParcial: cubierto > 0 && monto > 0,
  }
}

export type ClaveDepositoProducto = 'na' | 'pendiente' | 'en_revision' | 'depositado'

/**
 * Estado del depósito del producto al comercio.
 *
 * Antes bastaba con que `cobroContraEntrega.aplica` fuera true para mostrar
 * "Pendiente". Eso ignora que el cobro contra entrega puede haberse consumido
 * entero en cubrir el delivery: con producto 100 y delivery 150 deducido, al
 * comercio no le corresponde recibir nada y no hay depósito pendiente alguno.
 */
export function estadoDepositoProductoComercio(orden: EntradaEstadoComercio): {
  clave: ClaveDepositoProducto
  monto: number
} {
  if (!orden.cobroContraEntrega?.aplica) return { clave: 'na', monto: 0 }

  const dep = orden.registro?.deposito
  if (dep?.confirmadoComercio) return { clave: 'depositado', monto: 0 }
  if (dep?.comercioDepositoId) return { clave: 'en_revision', monto: 0 }

  // Monto real que le corresponde al comercio — mismo cálculo canónico que usan
  // el motorizado y el gestor, sin reimplementarlo acá.
  const monto = calcularDeposito(orden).totalAlComercio
  if (monto <= 0) return { clave: 'na', monto: 0 }
  return { clave: 'pendiente', monto }
}
