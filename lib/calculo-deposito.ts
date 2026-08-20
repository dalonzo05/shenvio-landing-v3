// B1.3 — Cálculo autoritativo de cuánto debe depositar un motorizado.
//
// Antes de este módulo la fórmula estaba copiada en cuatro lugares y dos de
// ellos habían divergido (ver REPORTE B1-FIN-0, sección 7):
//
//   app/panel/motorizado/page.tsx            honraba delivery.recibio === false
//   functions/src/motorizado-transiciones.ts honraba delivery.recibio === false
//   app/panel/gestor/depositos/page.tsx      NO lo honraba
//   app/panel/gestor/auditoria-financiera    NO lo honraba
//
// El resultado era que el motorizado y el gestor veían cifras distintas de la
// MISMA orden. Este módulo fija una sola semántica y la comparten los tres
// consumidores del cliente.
//
// LÍMITE DE ALCANCE (B1.3): la copia de functions/ NO se migra en este bloque
// — tocar Cloud Functions está fuera de alcance y functions/ compila como
// paquete aparte, con su propio tsconfig. Sigue duplicada, pero ya era
// equivalente a la del motorizado, así que la unificación del cliente la
// alcanza en comportamiento, no en código. Ver B1-FIN-0 §23.
//
// PURO: sin Firestore, sin React, sin Firebase, sin Date.now(), sin estado
// global. Sin imports, a propósito — así puede testearse compilando este solo
// archivo.

/** Justificación que NO significa "no cobró", sino "se cobrará al entregar". */
export const JUSTIFICACION_DEFER_DELIVERY = 'Se acordó cobrar en la entrega'

/**
 * Entrada mínima. Todo opcional y todo admite null: las órdenes reales llegan
 * de Firestore con campos ausentes o explícitamente nulos según su antigüedad
 * y su tipo de servicio. Los `|| 0` de abajo son los que absorben esa
 * variedad — el tipo solo la reconoce.
 */
export interface EntradaCalculoDeposito {
  cobroContraEntrega?: { aplica?: boolean | null; monto?: number | null } | null
  confirmacion?: { precioFinalCordobas?: number | null } | null
  pagoDelivery?: {
    quienPaga?: string | null
    montoSugerido?: number | null
    deducirDelCobroContraEntrega?: boolean | null
    /** Presente en el modelo del motorizado; este cálculo no lo usa. */
    tipo?: string | null
  } | null
  tipoServicio?: string | null
  tipoCliente?: string | null
  cobrosMotorizado?: {
    delivery?: { recibio?: boolean | null; justificacion?: string | null } | null
    // `justificacion` y `estado` los persiste confirmarTransicionConCobro;
    // este cálculo no los usa, pero el tipo los reconoce porque vienen en el
    // dato real y los consumidores pasan la orden entera.
    producto?: {
      recibio?: boolean | null
      justificacion?: string | null
      estado?: string | null
    } | null
  } | null
}

export interface ResultadoCalculoDeposito {
  /** Hay cobro contra entrega vigente y el motorizado no declaró no haberlo recibido. */
  tieneProducto: boolean
  /** Monto del cobro contra entrega, antes de deducir el delivery. */
  montoProducto: number
  /** El motorizado recaudó el delivery en efectivo. */
  tieneDelivery: boolean
  /** Delivery efectivamente recaudado en efectivo (0 si no lo recaudó). */
  montoDelivery: number
  /** El delivery se pagó por transferencia, no en efectivo. */
  deliveryPorTransferencia: boolean
  /** A depositar al comercio: producto, neto de la deducción del delivery. */
  totalAlComercio: number
  /** A depositar a StorkHub: el delivery en efectivo. */
  totalAStorkhub: number
  /** Suma de ambos destinos. */
  montoTotal: number
  /** Texto legible para la UI del motorizado. */
  descripcion: string

  // ── B1.2 ──────────────────────────────────────────────────────────────
  /**
   * Efectivo que el motorizado realmente tiene por esta orden. Es el techo
   * de lo que se le puede exigir: `totalAlComercio + totalAStorkhub` nunca
   * puede superarlo.
   */
  montoRecibidoReal: number
  /**
   * Parte del delivery que el cobro contra entrega NO alcanzó a cubrir.
   * No se le exige al motorizado — queda como obligación a cobrar aparte
   * (`cobroDelivery.monto`). Siempre 0 si no hay deducción.
   */
  faltanteDelivery: number
  /** Hay dinero que deberá cobrarse después: faltante o producto no recibido. */
  requiereCobroPosterior: boolean
}

export function calcularDeposito(orden: EntradaCalculoDeposito): ResultadoCalculoDeposito {
  const ceAplica = !!orden.cobroContraEntrega?.aplica
  const montoProducto = ceAplica ? (orden.cobroContraEntrega?.monto || 0) : 0

  // Para fuera_managua el precio confirmado puede no existir todavía; se cae
  // al monto sugerido. Sin este fallback el gestor veía 0 en órdenes que el
  // motorizado sí contaba (divergencia #2 de B1-FIN-0).
  const precioDelivery =
    orden.confirmacion?.precioFinalCordobas ||
    (orden.tipoServicio === 'fuera_managua' ? (orden.pagoDelivery?.montoSugerido || 0) : 0)

  const quienPaga = orden.pagoDelivery?.quienPaga || ''
  const deducir = !!orden.pagoDelivery?.deducirDelCobroContraEntrega
  const esPorTransferencia = quienPaga === 'transferencia'
  const esCredito = orden.tipoCliente === 'credito' || quienPaga === 'credito_semanal'

  // El motorizado declaró no haber recibido el delivery. La excepción es el
  // "defer": acordar cobrarlo en la entrega no es no haberlo cobrado, solo
  // todavía no. El dinero no se pierde — la orden queda con
  // cobroDelivery.estado = 'pendiente' y se persigue desde Cobros.
  const deliveryNoRecibido =
    orden.cobrosMotorizado?.delivery?.recibio === false &&
    orden.cobrosMotorizado?.delivery?.justificacion !== JUSTIFICACION_DEFER_DELIVERY
  const productoNoRecibido = orden.cobrosMotorizado?.producto?.recibio === false

  const tieneDelivery = !esPorTransferencia && !esCredito && precioDelivery > 0 && !deliveryNoRecibido
  const montoDelivery = tieneDelivery ? precioDelivery : 0

  // ── B1.2: todo el reparto parte del dinero REALMENTE recibido ────────────
  //
  // Antes se repartía sobre `montoProducto` (lo que la orden dice que vale el
  // cobro contra entrega) y sobre `precioDelivery` (el precio de lista). Esas
  // dos cifras son expectativas, no caja. Cuando no coincidían con la
  // realidad, la diferencia caía sobre el motorizado.
  //
  // A partir de acá se usa `productoDisponible`: el efectivo del cobro contra
  // entrega que el motorizado sí tiene en la mano. Si declaró no haberlo
  // recibido, es 0 — y no hay nada que repartir.
  const productoDisponible = productoNoRecibido ? 0 : montoProducto

  // Cuánto del delivery se cubre con ese efectivo. `montoDelivery` (no
  // `precioDelivery`): si el delivery no entró en caja, no hay nada que
  // deducirle al comercio. Ese era el caso legacy `deducir=true` +
  // `delivery.recibio=false`, que descontaba al comercio un delivery que
  // nadie cobró.
  const cubiertoDelivery = deducir ? Math.min(productoDisponible, montoDelivery) : 0

  // Lo que falta del delivery, y que por tanto NO se le puede exigir al
  // motorizado: no lo tiene. Queda como obligación externa a cobrar (ver
  // cobroDelivery.monto, que la Function persiste al entregar).
  const faltanteDelivery = deducir ? Math.max(0, montoDelivery - productoDisponible) : 0

  // Al comercio va el remanente del producto después de cubrir el delivery.
  const totalAlComercio = deducir
    ? Math.max(0, productoDisponible - montoDelivery)
    : productoDisponible

  // A StorkHub, solo lo que efectivamente entró en caja: si hubo deducción,
  // la parte del delivery que el producto alcanzó a cubrir; si no, el
  // delivery cobrado aparte.
  const totalAStorkhub = esPorTransferencia || esCredito
    ? 0
    : (deducir ? cubiertoDelivery : montoDelivery)

  // Efectivo total en manos del motorizado por esta orden. Es el techo
  // de lo que se le puede exigir; los tests verifican la invariante
  // totalAlComercio + totalAStorkhub <= montoRecibidoReal.
  const montoRecibidoReal = deducir
    ? productoDisponible
    : productoDisponible + montoDelivery

  const partes: string[] = []
  if (ceAplica) partes.push(`Cobró producto C$${montoProducto}`)
  if (tieneDelivery) partes.push(`Cobró delivery C$${precioDelivery}`)
  if (deducir) partes.push('Dedujo delivery del CE')
  if (esPorTransferencia) partes.push('Delivery ya pagado por transferencia')
  if (esCredito) partes.push('Delivery en crédito semanal')
  if (!ceAplica && !tieneDelivery) partes.push('No recaudó efectivo')

  return {
    tieneProducto: ceAplica && !productoNoRecibido,
    montoProducto,
    tieneDelivery,
    montoDelivery,
    deliveryPorTransferencia: esPorTransferencia,
    totalAlComercio,
    totalAStorkhub,
    montoTotal: totalAlComercio + totalAStorkhub,
    montoRecibidoReal,
    faltanteDelivery,
    requiereCobroPosterior: faltanteDelivery > 0 || productoNoRecibido,
    descripcion: partes.join(' · '),
  }
}
