// B2.3B — Recorrido del dinero del delivery, para la ficha autoritativa.
//
// EL PROBLEMA
//
// La ficha mostraba "Delivery C$80 · Pagado" y más abajo "A StorkHub C$80 ·
// Pendiente de depósito". Las dos son ciertas y parecen contradecirse, porque
// "Pagado" contesta una pregunta —¿el cliente pagó?— y "Pendiente" contesta
// otra —¿StorkHub ya recibió ese dinero?—. Son dos tramos del mismo billete:
//
//     quién paga → quién recibe → a quién pertenece → ya llegó
//
// LO QUE SE PUEDE AFIRMAR (auditoría B2.3B sobre writers y datos reales)
//
//   quienPaga        pagoDelivery.quienPaga, escrito al crear/confirmar.
//   cobrado          cobroDelivery.estado vía estadoDeliveryComercio().
//   receptor         cobrosMotorizado.delivery.recibio === true responde a
//                    "¿Recibiste C$X de delivery?" en el panel del motorizado:
//                    es dinero físicamente en su mano. Excepción: en
//                    fuera_managua la pregunta cambia de sujeto, así que ahí
//                    no se afirma nada (deuda B2-PAGO-RECEPTOR-FUERA-MANAGUA).
//   destino          calcularDeposito(), única fórmula financiera.
//
// LO QUE NO SE PUEDE AFIRMAR
//
//   medio de pago    formaPago solo se escribe cuando un gestor confirma el
//                    cobro desde el módulo Cobros, y la reversión lo borra
//                    dejando metodoPagoReal obsoleto. En el flujo normal —el
//                    motorizado cobra al entregar— no se persiste nada. No se
//                    deduce "efectivo" de que haya que depositar.
//                    → deuda B2-PAGO-MEDIO-NO-PERSISTIDO.
//
// PURO: sin Firestore, sin React. No calcula dinero: lo consulta.

import { calcularDeposito } from './calculo-deposito'
import { estadoDeliveryComercio } from './estado-cobro-comercio'
import { lineasDeposito, type EntradaDepositoOrden, type DepositoRegistrado, type DestinoDeposito } from './deposito-orden'

/**
 * Superset estructural de `EntradaEstadoComercio` y `EntradaDepositoOrden`.
 *
 * No los extiende porque cada módulo declara solo el trozo de
 * `cobrosMotorizado` que usa y TypeScript no puede combinarlos por herencia.
 * Declarado así, una `EntradaTrazabilidad` sigue siendo asignable a ambos.
 */
export interface EntradaTrazabilidad {
  tipoServicio?: string | null
  tipoCliente?: string | null
  asignacion?: { motorizadoNombre?: string | null } | null
  cobroContraEntrega?: { aplica?: boolean | null; monto?: number | null } | null
  confirmacion?: { precioFinalCordobas?: number | null } | null
  pagoDelivery?: {
    quienPaga?: string | null
    montoSugerido?: number | null
    deducirDelCobroContraEntrega?: boolean | null
    tipo?: string | null
  } | null
  cobrosMotorizado?: {
    delivery?: { monto?: number | null; recibio?: boolean | null; justificacion?: string | null } | null
    producto?: {
      monto?: number | null
      recibio?: boolean | null
      justificacion?: string | null
      estado?: string | null
    } | null
  } | null
  cobroDelivery?: {
    estado?: string | null
    monto?: number | null
    montoDelivery?: number | null
    cubiertoPorDeposito?: number | null
    formaPago?: string | null
    pagadoAt?: unknown
  } | null
  registro?: EntradaDepositoOrden['registro']
}

export type ClaveReceptor = 'motorizado' | 'storkhub'

export interface DestinoPago {
  destino: DestinoDeposito
  etiqueta: string
  monto: number
  /** Estado del depósito real, tomado tal cual de B2.3. */
  situacion: string
  /** Ya existe un documento de depósito para este destino. */
  tieneDeposito: boolean
}

export interface TrazabilidadPago {
  montoDelivery: number
  /** Frente al cliente: ¿ya se cobró? Nunca dice si StorkHub lo recibió. */
  estadoCliente: { clave: string; etiqueta: string; montoPendiente: number }
  quienPaga: string | null
  /** null = no se persiste. La UI omite el renglón en vez de inventarlo. */
  medioPago: string | null
  receptor: { clave: ClaveReceptor; etiqueta: string } | null
  /** Destinos con obligación > 0. Vacío = no corresponde depósito. */
  destinos: DestinoPago[]
  /**
   * El dinero fue cobrado pero todavía no llegó a su destino. Es la única
   * situación en la que "Cobrado" y "Pendiente de depósito" conviven, y la
   * razón de que no se contradigan.
   */
  cobradoPeroNoDepositado: boolean
}

const num = (v: unknown): number => (typeof v === 'number' && Number.isFinite(v) ? v : 0)

const QUIEN_PAGA: Record<string, string> = {
  recoleccion: 'Comercio, al retirar',
  entrega: 'Destinatario, al entregar',
  transferencia: 'Comercio, por transferencia',
  credito_semanal: 'Comercio, en crédito semanal',
}

/** Cómo se llama el estado frente al CLIENTE, no frente a StorkHub. */
const ETIQUETA_CLIENTE: Record<string, string> = {
  // B2.3B: era "Pagado". El campo dice que el cobro se hizo en origen, no que
  // el dinero haya llegado a ShEnvíos — decirlo "Pagado" junto a un depósito
  // pendiente es lo que hacía parecer incoherente la ficha.
  pagado: 'Cobrado',
  pendiente: 'Por cobrar',
  en_revision: 'Comprobante en revisión',
  no_cobrar: 'No se cobra',
  revertido: 'Cobro revertido',
  na: 'Sin registrar',
}

export function etiquetaEstadoCliente(clave: string): string {
  return ETIQUETA_CLIENTE[clave] ?? clave
}

/**
 * Recorrido del pago del delivery de una orden.
 *
 * @param orden      documento de solicitudes_envio
 * @param depositos  documentos de ordenes_deposito que la ficha ya cargó en
 *                   B2.3. No se consulta nada nuevo.
 */
export function trazabilidadPago(
  orden: EntradaTrazabilidad,
  depositos: Partial<Record<DestinoDeposito, DepositoRegistrado | null>> = {},
): TrazabilidadPago {
  const calc = calcularDeposito(orden)
  const cliente = estadoDeliveryComercio(orden)
  const quienPagaRaw = orden.pagoDelivery?.quienPaga || ''

  // ── Receptor ──────────────────────────────────────────────────────────────
  let receptor: TrazabilidadPago['receptor'] = null
  if (calc.deliveryPorTransferencia && cliente.clave === 'pagado') {
    // El comercio transfiere a ShEnvíos: el motorizado nunca toca ese dinero,
    // y por eso calcularDeposito le da totalAStorkhub = 0. Se exige además que
    // el cobro conste como hecho: `quienPaga = 'transferencia'` describe el
    // acuerdo, no que el dinero haya entrado — una orden cancelada bajo esa
    // modalidad no recibió nada.
    receptor = { clave: 'storkhub', etiqueta: 'StorkHub, directo del comercio' }
  } else if (
    orden.cobrosMotorizado?.delivery?.recibio === true &&
    orden.tipoServicio !== 'fuera_managua'
  ) {
    // `recibio === true` sin más: `tieneDelivery` también es true cuando el
    // motorizado difirió el cobro a la entrega, y ahí todavía no tiene nada.
    const nombre = orden.asignacion?.motorizadoNombre?.trim()
    receptor = { clave: 'motorizado', etiqueta: nombre ? `${nombre} (motorizado)` : 'El motorizado' }
  }

  // ── Medio de pago ─────────────────────────────────────────────────────────
  // Solo si un gestor lo registró Y el cobro sigue vigente: la reversión borra
  // pagadoAt pero deja metodoPagoReal, que quedaría mintiendo.
  const forma = orden.cobroDelivery?.formaPago
  const medioPago =
    typeof forma === 'string' && forma.trim() && orden.cobroDelivery?.pagadoAt != null
      ? forma.trim()
      : null

  // ── Destinos ──────────────────────────────────────────────────────────────
  const lineas = lineasDeposito(orden, depositos)
  const destinos: DestinoPago[] = lineas
    .filter((l) => l.obligacion > 0)
    .map((l) => ({
      destino: l.destino,
      etiqueta: l.destino === 'storkhub' ? 'StorkHub' : 'Comercio',
      monto: l.obligacion,
      situacion: l.texto,
      tieneDeposito: !!l.deposito,
    }))

  const obligacionStorkhub = num(calc.totalAStorkhub)
  const lineaStorkhub = lineas.find((l) => l.destino === 'storkhub')

  return {
    montoDelivery: num(cliente.montoDelivery),
    estadoCliente: {
      clave: cliente.clave,
      etiqueta: etiquetaEstadoCliente(cliente.clave),
      montoPendiente: num(cliente.montoPendiente),
    },
    quienPaga: QUIEN_PAGA[quienPagaRaw] ?? (quienPagaRaw || null),
    medioPago,
    receptor,
    destinos,
    cobradoPeroNoDepositado:
      obligacionStorkhub > 0 && !lineaStorkhub?.deposito && receptor?.clave === 'motorizado',
  }
}
