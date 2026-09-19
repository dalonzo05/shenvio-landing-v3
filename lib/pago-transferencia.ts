// PAGO-TRANSFERENCIA-UX-1 — Cómo se cuenta el pago del delivery por
// transferencia en cada pantalla.
//
// Modelo (no cambia):
//   pagoDelivery.quienPaga = 'transferencia'  → el PLAN: el comercio pagará
//   cobroDelivery.estado                      → el HECHO:
//       pendiente → en_revision_deposito → pagado
//
// Lo que estaba mal era el texto: la opción del plan decía "Ya se pagó por
// transferencia"; el motorizado leía "Delivery ya pagado" antes de entregar;
// el comercio veía "pendiente" y "en revisión" a la vez; el DEP tipo C decía
// "Esta orden aporta C$0" y "Enviado" a la hora en que se confirmó.
//
// PURO: sin Firestore, sin React, sin efectos.

import { claseDeposito, fechasDeposito } from './presentacion-deposito'
import type { DepositoRegistrado } from './deposito-orden'

const money = (n: number) => `C$ ${n.toLocaleString('es-NI')}`
const num = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null)

// ─── Plan (crear orden) ───────────────────────────────────────────────────────

/** Texto de la opción 'transferencia' al crear la orden. Nunca "ya se pagó". */
export const OPCION_PLAN_TRANSFERENCIA = {
  gestor: {
    label: '🏦 El comercio pagará el delivery por transferencia',
    desc: 'El motorizado no cobrará este delivery. El comercio deberá enviar el comprobante.',
  },
  comercio: {
    label: '🏦 Pagaré el delivery por transferencia',
    desc: 'El motorizado no cobrará este delivery. Después podrás subir el comprobante desde tu panel.',
  },
} as const

export function esPlanTransferencia(orden: { pagoDelivery?: { quienPaga?: string | null } | null } | null | undefined): boolean {
  return orden?.pagoDelivery?.quienPaga === 'transferencia'
}

// ─── Estado del pago, visto por el comercio ───────────────────────────────────

export type ClavePagoTransferencia = 'pendiente' | 'en_revision' | 'pagado' | 'otro'

export interface EstadoPagoTransferencia {
  clave: ClavePagoTransferencia
  titulo: string
  detalle: string | null
}

/**
 * Un solo texto por estado real. "Pendiente" solo cuando todavía no hay
 * comprobante: con el comprobante enviado ya no está pendiente, está en
 * revisión. No existe un estado "rechazado" en el modelo y no se inventa.
 */
export function estadoPagoTransferencia(cobro: { estado?: string | null } | null | undefined): EstadoPagoTransferencia {
  switch (cobro?.estado) {
    case 'pagado':
      return { clave: 'pagado', titulo: 'Pago confirmado', detalle: null }
    case 'en_revision_deposito':
      return { clave: 'en_revision', titulo: 'Comprobante enviado · En revisión', detalle: 'StorkHub está revisando el pago.' }
    case undefined:
    case null:
    case 'pendiente':
      return { clave: 'pendiente', titulo: 'Pendiente de pago', detalle: 'Sube el comprobante para que StorkHub lo revise.' }
    default:
      return { clave: 'otro', titulo: String(cobro?.estado ?? ''), detalle: null }
  }
}

// ─── Motorizado ───────────────────────────────────────────────────────────────

export interface AvisoNoCobrar {
  titulo: string
  detalle: string
}

/**
 * Aviso fuerte para Nuevas y En curso: el motorizado NO cobra este delivery.
 * El monto es el precio confirmado de la orden; sin precio, no se inventa.
 */
export function avisoNoCobrarMotorizado(orden: {
  pagoDelivery?: { quienPaga?: string | null } | null
  confirmacion?: { precioFinalCordobas?: number | null } | null
}): AvisoNoCobrar | null {
  if (!esPlanTransferencia(orden)) return null
  const precio = num(orden.confirmacion?.precioFinalCordobas)
  return {
    titulo: 'NO COBRAR ESTE DELIVERY',
    detalle: precio !== null && precio > 0
      ? `El comercio pagará ${money(precio)} por transferencia directamente a StorkHub.`
      : 'El comercio pagará el delivery por transferencia directamente a StorkHub.',
  }
}

/** Partes que escribe calcularDeposito() y que el aviso ya cubre. */
const PARTE_TRANSFERENCIA = 'Delivery ya pagado por transferencia'
const PARTE_SIN_EFECTIVO = 'No recaudó efectivo'

/**
 * La descripción de calcularDeposito() habla en pasado ("ya pagado", "no
 * recaudó"), que antes de entregar es falso y, con transferencia, afirma un
 * pago que quizá no ocurrió todavía.
 *
 *   operacion — Nuevas / En curso: esas dos partes se quitan (las dice el aviso)
 *   historial — ya entregada: se dice qué pasó sin afirmar que el comercio pagó
 */
export function descripcionCobroMotorizado(
  descripcion: string | null | undefined,
  porTransferencia: boolean,
  fase: 'operacion' | 'historial',
): string {
  const partes = (descripcion ?? '').split(' · ').map((p) => p.trim()).filter(Boolean)
  if (!porTransferencia) return partes.join(' · ')
  const resto = partes.filter((p) => p !== PARTE_TRANSFERENCIA && p !== PARTE_SIN_EFECTIVO)
  if (fase === 'historial') resto.push('Delivery por transferencia del comercio · No cobrado por el motorizado')
  return resto.join(' · ')
}

// ─── Depósito tipo C: monto y momentos ────────────────────────────────────────

interface OrdenConCobro {
  cobroDelivery?: {
    monto?: number | null
    boucherVigente?: string | null
    boucherComercio?: { at?: unknown } | null
    boucherGestor?: { at?: unknown } | null
    boucherAt?: unknown
  } | null
  confirmacion?: { precioFinalCordobas?: number | null } | null
}

export interface MontoAsociado {
  etiqueta: string
  monto: number | null
}

/**
 * Cuánto de un depósito corresponde a ESTA orden.
 *
 * En A/B es la obligación de efectivo (calcularDeposito). En el tipo C no: ese
 * cálculo mide efectivo del motorizado y da 0 —"Esta orden aporta C$0"—. Ahí
 * el monto es el del cobro de la propia orden, el mismo que usó quien lo
 * confirmó (cobroDelivery.monto, que nace del precio confirmado). No hay
 * prorrateo: cada orden aporta su propio cobro.
 */
export function montoAsociadoDeposito(
  dep: Pick<DepositoRegistrado, 'tipo'>,
  orden: OrdenConCobro | null | undefined,
  obligacionEfectivo: number,
): MontoAsociado {
  if (claseDeposito(dep) === 'transferencia_delivery') {
    return {
      etiqueta: 'Pago de esta orden',
      monto: num(orden?.cobroDelivery?.monto) ?? num(orden?.confirmacion?.precioFinalCordobas),
    }
  }
  return { etiqueta: 'Esta orden aporta', monto: obligacionEfectivo }
}

/** Cuándo se subió el comprobante VIGENTE del pago del cliente. */
export function momentoComprobanteCliente(cobro: OrdenConCobro['cobroDelivery']): unknown {
  if (!cobro) return null
  if (cobro.boucherVigente === 'gestor') return cobro.boucherGestor?.at ?? null
  if (cobro.boucherVigente === 'comercio') return cobro.boucherComercio?.at ?? null
  return cobro.boucherAt ?? cobro.boucherComercio?.at ?? null
}

export interface MomentoDeposito {
  etiqueta: string
  valor: unknown
}

/**
 * Los instantes de un depósito, con el nombre que les corresponde por tipo.
 *
 *   A/B: "Enviado" (el motorizado crea el documento y sube el boucher en la
 *        misma escritura) y "Confirmado".
 *   C:   el documento nace AL confirmar, así que su creadoAt no es un envío.
 *        "Comprobante enviado" sale del boucher del comercio en la orden (si
 *        se tiene la orden) y "Pago confirmado" del confirmadoAt.
 */
export function momentosDeposito(
  dep: Pick<DepositoRegistrado, 'tipo' | 'estado' | 'creadoAt' | 'confirmadoAt' | 'boucher'>,
  orden?: OrdenConCobro | null,
): MomentoDeposito[] {
  const f = fechasDeposito(dep)
  if (claseDeposito(dep) === 'transferencia_delivery') {
    const out: MomentoDeposito[] = []
    const enviado = momentoComprobanteCliente(orden?.cobroDelivery)
    if (enviado != null) out.push({ etiqueta: 'Comprobante enviado', valor: enviado })
    if (f.confirmado != null) out.push({ etiqueta: 'Pago confirmado', valor: f.confirmado })
    return out
  }
  const out: MomentoDeposito[] = []
  if (f.enviado != null) out.push({ etiqueta: 'Enviado', valor: f.enviado })
  if (f.confirmado != null) out.push({ etiqueta: 'Confirmado', valor: f.confirmado })
  return out
}

/**
 * Instante de envío para una columna "Enviado". En el tipo C, sin la orden no
 * hay envío demostrable: null (nunca el creadoAt, que es la confirmación).
 */
export function enviadoDeposito(
  dep: Pick<DepositoRegistrado, 'tipo' | 'estado' | 'creadoAt' | 'confirmadoAt' | 'boucher'>,
  orden?: OrdenConCobro | null,
): unknown {
  const m = momentosDeposito(dep, orden).find((x) => x.etiqueta === 'Enviado' || x.etiqueta === 'Comprobante enviado')
  return m ? m.valor : null
}

/**
 * Columna "Enviado" del Historial de Depósitos, que no tiene la orden a mano
 * sino las órdenes ya cargadas por la página (`buscarOrden`, sin reads nuevas).
 *
 *   A/B: el envío del motorizado, igual que enviadoDeposito.
 *   C:   el instante en que el COMERCIO subió su comprobante
 *        (cobroDelivery.boucherComercio.at). Solo con exactamente una orden:
 *        con varias no hay un instante único que mostrar, y sin la orden o sin
 *        ese timestamp tampoco. En esos casos null ("—"); nunca creadoAt ni
 *        confirmadoAt del DEP, que son la confirmación.
 */
export function enviadoDepositoHistorial(
  dep: Pick<DepositoRegistrado, 'tipo' | 'estado' | 'creadoAt' | 'confirmadoAt' | 'boucher' | 'solicitudIds'>,
  buscarOrden: (id: string) => OrdenConCobro | null | undefined,
): unknown {
  if (claseDeposito(dep) !== 'transferencia_delivery') return enviadoDeposito(dep)
  const ids = dep.solicitudIds ?? []
  if (ids.length !== 1) return null
  return buscarOrden(ids[0])?.cobroDelivery?.boucherComercio?.at ?? null
}

// ─── Cobros ───────────────────────────────────────────────────────────────────

/**
 * Cuándo se cobró, para la columna "Cobrado". Solo con un cobro 'pagado'.
 *
 *   confirmado por un gestor (transferencia o registro manual) → pagadoAt
 *   efectivo del motorizado, registrado por la Function al entregar — no
 *   escribe pagadoAt — → cobroDelivery.registradoAt, o el `at` del cobro del
 *   motorizado. Sin ninguno, null: no se inventa.
 */
export function momentoCobro(orden: {
  cobroDelivery?: { estado?: string | null; pagadoAt?: unknown; formaPago?: string | null; registradoAt?: unknown } | null
  cobrosMotorizado?: { delivery?: { at?: unknown } | null } | null
}): unknown {
  const cd = orden.cobroDelivery
  if (cd?.estado !== 'pagado') return null
  if (cd.pagadoAt != null) return cd.pagadoAt
  if (cd.formaPago === 'efectivo') return cd.registradoAt ?? orden.cobrosMotorizado?.delivery?.at ?? null
  return null
}

export interface AtencionCobros {
  total: number
  monto: number
  /** Con comprobante, esperando que StorkHub lo revise. */
  enRevision: number
  /** Plan de transferencia sin comprobante todavía. */
  esperandoComprobante: number
}

/**
 * Qué cobros requieren acción, sobre la lista que Cobros ya cargó. Solo los
 * dos casos del pago por transferencia; crédito y conciliación semanal no
 * entran hasta tener un helper propio.
 */
export function resumenAtencionCobros(ordenes: Array<{
  pagoDelivery?: { quienPaga?: string | null } | null
  cobroDelivery?: { estado?: string | null; quienPaga?: string | null; monto?: number | null } | null
  confirmacion?: { precioFinalCordobas?: number | null } | null
}>): AtencionCobros {
  let enRevision = 0, esperandoComprobante = 0, monto = 0
  for (const o of ordenes) {
    const estado = o.cobroDelivery?.estado ?? 'pendiente'
    const transferencia = o.pagoDelivery?.quienPaga === 'transferencia' || o.cobroDelivery?.quienPaga === 'transferencia'
    let cuenta = false
    if (estado === 'en_revision_deposito') { enRevision++; cuenta = true }
    else if (transferencia && estado === 'pendiente') { esperandoComprobante++; cuenta = true }
    if (cuenta) monto += num(o.cobroDelivery?.monto) ?? num(o.confirmacion?.precioFinalCordobas) ?? 0
  }
  return { total: enRevision + esperandoComprobante, monto, enRevision, esperandoComprobante }
}

// ─── Depósitos: acciones de administrador ─────────────────────────────────────

/**
 * Rehacer y Eliminar son solo del administrador, y nunca sobre un DEP tipo C:
 * ese documento es el registro del pago de una orden pagada, y su corrección
 * es Revertir en Cobros (que anula el DEP y el movimiento juntos).
 * firestore.rules aplica lo mismo del lado del servidor.
 */
export function accionesAdminDeposito(
  dep: Pick<DepositoRegistrado, 'tipo' | 'estado'>,
  rol: string | null | undefined,
): { rehacer: boolean; eliminar: boolean } {
  if (rol !== 'admin' || claseDeposito(dep) === 'transferencia_delivery') return { rehacer: false, eliminar: false }
  return { rehacer: dep.estado !== 'convertido_en_deuda', eliminar: true }
}
