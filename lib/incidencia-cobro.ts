// B1.2F — Cómo leer una incidencia de cobro en Gestor → Cobros.
//
// El problema que resuelve: con `deducirDelCobroContraEntrega = true` el
// destinatario paga UN SOLO monto —el cobro contra entrega— del que el
// delivery sale por dentro. La Function refleja eso espejando la respuesta:
//
//   functions/src/motorizado-transiciones.ts:524
//   deliveryAnswer = productoAnswer   // el delivery va implícito en producto
//
// Ese espejo es intencional y no se toca. Pero Cobros lo leía como si fuera
// un segundo evento de cobro y sumaba producto.monto + delivery.monto, así
// que un CE de 500 con delivery de 150 aparecía como 650 adeudados. Los 150
// ya estaban dentro de los 500.
//
// Dos relaciones distintas, que no se suman:
//
//   1. El DESTINATARIO no entregó el CE            → incidencia de C$500
//   2. El COMERCIO debe el delivery ya prestado    → cobroDelivery de C$150
//
// El motorizado no debe nada en ninguno de los dos casos.
//
// PURO: sin Firestore, sin React, sin efectos, sin fecha actual.

export interface ResolucionIncidencia {
  tipo?: 'cliente_pagara' | 'se_pierde' | string | null
  resueltoPor?: string | null
  at?: unknown
  nota?: string | null
}

export interface EntradaIncidencia {
  pagoDelivery?: { deducirDelCobroContraEntrega?: boolean | null } | null
  confirmacion?: { precioFinalCordobas?: number | null } | null
  cobrosMotorizado?: {
    delivery?: { monto?: number | null; recibio?: boolean | null; justificacion?: string | null } | null
    producto?: {
      monto?: number | null
      recibio?: boolean | null
      justificacion?: string | null
      estado?: string | null
      resolucion?: ResolucionIncidencia | null
    } | null
    /** Resolución a nivel de orden: la del DELIVERY, y la de documentos legacy. */
    resolucion?: ResolucionIncidencia | null
  } | null
}

export type ItemIncidencia = 'delivery' | 'producto'

export interface ResumenIncidencia {
  /** Monto realmente adeudado por el destinatario. Nunca suma el espejo. */
  monto: number
  /** Etiqueta principal para la tabla de Incidencias. */
  tipo: string
  /** Desglose interno, solo cuando el delivery va dentro del CE. */
  detalle: string | null
  /** El delivery es componente derivado del CE, no una incidencia propia. */
  deliveryDerivado: boolean
  /** Parte del CE que corresponde al delivery de ShEnvíos. */
  componenteDelivery: number
  /** Parte del CE que corresponde al comercio. */
  componenteComercio: number
  /** Ítems que el gestor todavía tiene que clasificar. */
  itemsAbiertos: ItemIncidencia[]
}

const num = (v: unknown): number => (typeof v === 'number' && Number.isFinite(v) ? v : 0)

/**
 * ¿El delivery se cobra dentro del cobro contra entrega?
 *
 * Es el mismo criterio que usan `calcularShowFlags` en la Function y
 * `showDelivery` en el panel del motorizado: cuando es true, al motorizado
 * NO se le pregunta por el delivery por separado.
 */
export function esDeliveryDeducido(orden: EntradaIncidencia): boolean {
  return orden.pagoDelivery?.deducirDelCobroContraEntrega === true
}

/** El motorizado declaró no haber recibido el cobro contra entrega. */
function productoNoRecibido(orden: EntradaIncidencia): boolean {
  const p = orden.cobrosMotorizado?.producto
  return !!p && p.recibio === false
}

/** El motorizado declaró no haber recibido el delivery cobrado aparte. */
function deliveryNoRecibido(orden: EntradaIncidencia): boolean {
  const d = orden.cobrosMotorizado?.delivery
  return !!d && d.recibio === false
}

/**
 * ¿Queda el delivery por clasificar como incidencia propia?
 *
 * Con deducción NUNCA: su `recibio` es un espejo del producto, no una
 * respuesta que el motorizado haya dado sobre el delivery.
 */
export function deliverySinClasificar(orden: EntradaIncidencia): boolean {
  if (esDeliveryDeducido(orden)) return false
  return deliveryNoRecibido(orden) && !orden.cobrosMotorizado?.resolucion
}

/** ¿Queda el cobro contra entrega por clasificar? */
export function productoSinClasificar(orden: EntradaIncidencia): boolean {
  return productoNoRecibido(orden) && !orden.cobrosMotorizado?.producto?.resolucion
}

/**
 * `cobroPendiente` = queda alguna incidencia SIN CLASIFICAR.
 *
 * No significa "hay dinero pendiente": tras clasificar el CE puede quedar
 * viva la cuenta por cobrar del delivery al comercio, y aun así esto es
 * false. Son cosas distintas y se persiguen desde pantallas distintas.
 */
export function hayIncidenciaSinClasificar(orden: EntradaIncidencia): boolean {
  return productoSinClasificar(orden) || deliverySinClasificar(orden)
}

/**
 * ¿El gestor ya clasificó algo en esta orden?
 *
 * B1.2F pasó a escribir la resolución del CE/producto dentro de su propio
 * submapa (`cobrosMotorizado.producto.resolucion`), pero el tab "Resueltos"
 * seguía buscándola solo en `cobrosMotorizado.resolucion` — donde escribe el
 * delivery. Una incidencia de producto resuelta desaparecía de Pendientes y
 * no aparecía en Resueltos: quedaba invisible.
 *
 * Se miran los dos lugares. El de la orden cubre el delivery y los documentos
 * anteriores a B1.2.
 */
export function tieneResolucion(orden: EntradaIncidencia): boolean {
  return !!orden.cobrosMotorizado?.resolucion || !!orden.cobrosMotorizado?.producto?.resolucion
}

/**
 * Resolución a mostrar en Resueltos.
 *
 * Con el delivery deducido solo puede existir la del producto. Sin deducción
 * puede haber una de cada una; se prefiere la del producto por ser la del
 * monto principal, y el llamador puede leer ambas si necesita detallarlas.
 */
export function resolucionPrincipal(orden: EntradaIncidencia): ResolucionIncidencia | null {
  return orden.cobrosMotorizado?.producto?.resolucion
    ?? orden.cobrosMotorizado?.resolucion
    ?? null
}

/** Etiqueta legible de una clasificación. */
export function etiquetaResolucion(r: ResolucionIncidencia | null | undefined): string {
  if (!r) return '—'
  if (r.tipo === 'cliente_pagara') return 'Cliente/comercio lo resolverá'
  if (r.tipo === 'se_pierde') return 'Se dio por perdido'
  return '—'
}

export function resumirIncidencia(orden: EntradaIncidencia): ResumenIncidencia {
  const deducido = esDeliveryDeducido(orden)
  const montoProducto = num(orden.cobrosMotorizado?.producto?.monto)
  const montoDelivery = num(orden.cobrosMotorizado?.delivery?.monto)
    || num(orden.confirmacion?.precioFinalCordobas)

  if (deducido) {
    // Un solo evento de cobro. El monto adeudado por el destinatario es el CE
    // completo; el delivery es una parte interna, no un extra.
    const sinCobrar = productoNoRecibido(orden)
    const monto = sinCobrar ? montoProducto : 0
    const componenteDelivery = Math.min(montoDelivery, montoProducto)
    const componenteComercio = Math.max(0, montoProducto - montoDelivery)
    return {
      monto,
      tipo: sinCobrar ? 'Cobro contra entrega' : '—',
      detalle: sinCobrar && montoDelivery > 0
        ? `Incluye delivery C$${componenteDelivery} · neto comercio C$${componenteComercio}`
        : null,
      deliveryDerivado: true,
      componenteDelivery,
      componenteComercio,
      itemsAbiertos: productoSinClasificar(orden) ? ['producto'] : [],
    }
  }

  // Sin deducción son dos cobros realmente separados: el destinatario paga el
  // producto por un lado y el delivery por el otro. Ahí sumar es correcto.
  const partes: string[] = []
  let monto = 0
  if (deliveryNoRecibido(orden)) { partes.push('Delivery'); monto += montoDelivery }
  if (productoNoRecibido(orden)) { partes.push('Producto'); monto += montoProducto }

  const abiertos: ItemIncidencia[] = []
  if (deliverySinClasificar(orden)) abiertos.push('delivery')
  if (productoSinClasificar(orden)) abiertos.push('producto')

  return {
    monto,
    tipo: partes.join(' + ') || '—',
    detalle: null,
    deliveryDerivado: false,
    componenteDelivery: 0,
    componenteComercio: 0,
    itemsAbiertos: abiertos,
  }
}
