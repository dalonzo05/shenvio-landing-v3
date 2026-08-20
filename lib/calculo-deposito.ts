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
    producto?: { recibio?: boolean | null } | null
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

  // Deducción del delivery sobre el cobro contra entrega. Usa precioDelivery,
  // no montoDelivery: así estaba en las cuatro copias y se preserva.
  //
  // PENDIENTE B1.2: cuando el delivery supera al producto, este Math.max
  // recorta a 0 el lado del comercio pero deja intacto lo que se le exige a
  // StorkHub. La diferencia no la absorbe ninguna cuenta y termina cayendo
  // sobre el motorizado. Se conserva el comportamiento actual a propósito —
  // corregirlo es B1.2, no este bloque.
  const productoNeto = deducir ? Math.max(0, montoProducto - precioDelivery) : montoProducto

  // PENDIENTE (B1-FIN-0): productoNoRecibido solo afecta a tieneProducto,
  // nunca a totalAlComercio — o sea que al motorizado se le sigue exigiendo
  // depositar un producto que declaró no haber cobrado. Las cuatro copias se
  // comportaban así; no se cambia acá para no mezclar dos correcciones.
  const totalAlComercio = productoNeto
  const totalAStorkhub = esPorTransferencia || esCredito ? 0 : montoDelivery

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
    descripcion: partes.join(' · '),
  }
}
