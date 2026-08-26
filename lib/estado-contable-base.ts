// B2-BASE-DECISIONAL — ¿esta orden requiere atención financiera?
//
// Columna derivada de Base de datos. NO se persiste, NO es una contabilidad
// nueva: pregunta a los helpers que ya son autoritativos y ordena la respuesta.
//
// QUÉ SEÑALES SE USAN
//
//   estadoDeliveryComercio()      cartera real de ShEnvíos por el delivery
//   hayIncidenciaSinClasificar()  trabajo pendiente del gestor, sin monto
//   calcularDeposito() + punteros  obligación de depósito no registrada
//
// QUÉ NO SE USA, Y POR QUÉ
//
// La columna DEPOSITADO de esta misma tabla sale de los flags
// `registro.deposito.confirmadoStorkhub/Comercio`, que no bastan:
//
//   · dicen "Pendiente" también cuando NO corresponde depósito alguno —una
//     orden sin cobro genera obligación cero, no una deuda;
//   · no distinguen "confirmado" de "convertido en deuda": convertir un
//     depósito en deuda escribe el MISMO confirmadoXAt (ver B2.3/B2.4).
//
// Por eso el depósito solo se afirma en el caso que SÍ es demostrable sin
// leer ordenes_deposito: hay obligación > 0 y no existe ningún puntero de
// depósito, o sea nadie lo registró todavía. Cuando el puntero existe, esta
// pantalla no puede saber en qué acabó y no dice nada — ni alerta ni cierre.
//
// De ahí que el estado limpio se llame "Sin alertas" y no "Cerrado
// contablemente": es lo que se puede demostrar con lo que hay a mano.
//
// PURO: sin Firestore, sin React, sin fecha actual.

import { estadoDeliveryComercio } from './estado-cobro-comercio'
import { hayIncidenciaSinClasificar, type ResolucionIncidencia } from './incidencia-cobro'
import { calcularDeposito } from './calculo-deposito'
import type { EntradaDepositoOrden } from './deposito-orden'

export type ClaveEstadoContable = 'requiere_atencion' | 'en_revision' | 'sin_alertas'

export interface MotivoContable {
  id: string
  texto: string
  /** Solo cuando hay una cifra que el helper de origen afirma. */
  monto?: number
}

export interface EstadoContable {
  estado: ClaveEstadoContable
  etiqueta: string
  motivos: MotivoContable[]
}

/** Superset estructural de las entradas de los helpers consultados. */
export interface EntradaEstadoContable {
  estado?: string | null
  tipoCliente?: string | null
  tipoServicio?: string | null
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
      resolucion?: ResolucionIncidencia | null
    } | null
    resolucion?: ResolucionIncidencia | null
  } | null
  cobroDelivery?: {
    estado?: string | null
    monto?: number | null
    montoDelivery?: number | null
    cubiertoPorDeposito?: number | null
  } | null
  registro?: EntradaDepositoOrden['registro']
}

const ETIQUETA: Record<ClaveEstadoContable, string> = {
  requiere_atencion: 'Requiere atención',
  en_revision: 'En revisión',
  sin_alertas: 'Sin alertas',
}

const money = (n: number) => `C$ ${n.toLocaleString('es-NI')}`

export function estadoContable(orden: EntradaEstadoContable): EstadoContable {
  const motivos: MotivoContable[] = []
  let revision = false

  // ── Cartera del delivery ──────────────────────────────────────────────────
  const cliente = estadoDeliveryComercio(orden)
  if (cliente.clave === 'pendiente' && cliente.montoPendiente > 0) {
    motivos.push({
      id: 'delivery',
      texto: `Delivery ${money(cliente.montoPendiente)} por cobrar`,
      monto: cliente.montoPendiente,
    })
  } else if (cliente.clave === 'en_revision' && cliente.montoPendiente > 0) {
    revision = true
    motivos.push({ id: 'delivery_revision', texto: 'Cobro del delivery en revisión', monto: cliente.montoPendiente })
  }

  // ── Incidencia sin clasificar ─────────────────────────────────────────────
  // Sin monto: es trabajo del gestor, no cartera. El producto no cobrado NUNCA
  // se convierte en deuda de ShEnvíos (B1.2).
  if (hayIncidenciaSinClasificar(orden)) {
    motivos.push({ id: 'incidencia', texto: 'Incidencia de cobro por clasificar' })
  }

  // ── Depósito nunca registrado ─────────────────────────────────────────────
  // Único caso demostrable sin leer ordenes_deposito: el motorizado recibió
  // efectivo y no hay ningún documento de depósito apuntado.
  const dep = orden.registro?.deposito
  const sinPuntero = !dep?.storkhubDepositoId && !dep?.comercioDepositoId
  if (sinPuntero) {
    const calc = calcularDeposito(orden)
    const total = (calc.totalAStorkhub || 0) + (calc.totalAlComercio || 0)
    if (total > 0) {
      motivos.push({ id: 'deposito', texto: `Depósito pendiente ${money(total)}`, monto: total })
    }
  }

  const estado: ClaveEstadoContable = motivos.length === 0
    ? 'sin_alertas'
    // "En revisión" solo si TODO lo abierto está en revisión: un cobro en
    // revisión junto a una incidencia sin clasificar sigue exigiendo acción.
    : revision && motivos.length === 1
      ? 'en_revision'
      : 'requiere_atencion'

  return { estado, etiqueta: ETIQUETA[estado], motivos }
}
