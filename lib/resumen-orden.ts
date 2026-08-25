// B2.6 — "¿Qué falta para cerrar esta orden?"
//
// La ficha ya tiene toda la información y es correcta, pero para responder esa
// pregunta el gestor debía leer cuatro bloques y cruzarlos mentalmente. Este
// helper la responde arriba, en una línea por pendiente.
//
// NO ES UNA VERDAD NUEVA. Cada pendiente sale de un helper ya existente:
//
//   operativo   solicitudes_envio.estado + lib/estados-solicitud.ts
//   cobro       estadoDeliveryComercio()   (B1.2D)
//   incidencia  hayIncidenciaSinClasificar() / tieneResolucion()  (B1.2F/H)
//   depósito    lineasDeposito()           (B2.3, sobre calcularDeposito)
//
// Acá no se suma, no se resta y no se decide cuánto debe nadie: solo se
// pregunta a quien ya lo sabe y se ordena para leer.
//
// Dos reglas que el resumen no puede violar:
//
//   1. Un mismo billete no aparece dos veces. Si el motorizado cobró el
//      delivery, lo pendiente es que lo DEPOSITE — no que "falte cobrarlo".
//   2. El producto no cobrado NO es cartera de ShEnvíos (B1.2). Clasificado,
//      es información cerrada; sin clasificar, es trabajo del gestor, nunca
//      una deuda financiera.
//
// PURO: sin Firestore, sin React, sin fecha actual.

import { estadoDeliveryComercio } from './estado-cobro-comercio'
import {
  hayIncidenciaSinClasificar,
  tieneResolucion,
  productoSinClasificar,
  type ResolucionIncidencia,
} from './incidencia-cobro'
import { lineasDeposito, type EntradaDepositoOrden, type DepositoRegistrado, type DestinoDeposito } from './deposito-orden'
import { esTerminalDefinitivo, esEstadoReactivable } from './estados-solicitud'
import type { AnchorOrden } from './ruta-orden'

export type CategoriaPendiente = 'operativo' | 'cobro' | 'incidencia' | 'deposito'

export interface Pendiente {
  id: string
  categoria: CategoriaPendiente
  texto: string
  /** Solo cuando hay una cifra concreta detrás. */
  monto?: number
  /** Bloque de la ficha donde se resuelve. Ausente = no hay a dónde llevar. */
  anchor?: AnchorOrden
  /** Presentación, no prioridad financiera. */
  severidad: 'alta' | 'media'
}

export interface Hecho {
  id: string
  texto: string
}

export interface ResumenOrden {
  pendientes: Pendiente[]
  /** Hechos ya cerrados. Secundarios: el bloque muestra sobre todo lo que falta. */
  hechos: Hecho[]
  sinPendientes: boolean
  /** Mensaje único cuando no queda nada por hacer. */
  mensajeLimpio: string | null
}

/**
 * Superset estructural de las entradas que consumen los helpers de arriba.
 *
 * No extiende ninguna: cada módulo declara solo el trozo de `cobrosMotorizado`
 * que usa —`estado-cobro-comercio` ignora `resolucion`, `incidencia-cobro` la
 * necesita— y TypeScript no puede combinarlas por herencia. Declarada así,
 * una `EntradaResumen` sigue siendo asignable a todas.
 */
export interface EntradaResumen {
  estado?: string | null
  tipoServicio?: string | null
  tipoCliente?: string | null
  asignacion?: {
    motorizadoNombre?: string | null
    estadoAceptacion?: string | null
  } | null
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

const money = (n: number) => `C$ ${n.toLocaleString('es-NI')}`

/**
 * Paso operativo que la orden todavía tiene por delante.
 *
 * Sale del estado persistido, nunca de suponer qué "debería" venir después.
 * `entregado`, `rechazada` y `cancelada` no tienen paso siguiente.
 */
function pendienteOperativo(orden: EntradaResumen): Pendiente | null {
  const estado = orden.estado ?? ''
  const moto = orden.asignacion?.motorizadoNombre?.trim()
  const p = (id: string, texto: string, severidad: Pendiente['severidad'] = 'alta'): Pendiente =>
    ({ id, categoria: 'operativo', texto, severidad })

  switch (estado) {
    case 'pendiente_confirmacion': return p('op:confirmar', 'Falta confirmar la orden')
    case 'confirmada': return p('op:asignar', 'Falta asignar motorizado')
    case 'asignada': {
      const ace = orden.asignacion?.estadoAceptacion
      // Rechazada o expirada: el motorizado ya no va a aceptar; hay que
      // reasignar. Decirlo como "debe aceptar" dejaría la orden colgada.
      if (ace === 'rechazada' || ace === 'expirada') return p('op:reasignar', 'Falta reasignar motorizado')
      return p('op:aceptar', moto ? `${moto} debe aceptar la asignación` : 'El motorizado debe aceptar la asignación')
    }
    case 'en_camino_retiro': return p('op:retirar', 'Falta retirar el paquete')
    case 'retirado':
    case 'en_camino_entrega': return p('op:entregar', 'Falta entregar el paquete')
    default: return null
  }
}

/**
 * Resumen decisional de la orden.
 *
 * @param orden      documento de solicitudes_envio
 * @param depositos  documentos de ordenes_deposito que la ficha ya cargó en
 *                   B2.3. No se consulta nada nuevo.
 */
export function resumenOrden(
  orden: EntradaResumen,
  depositos: Partial<Record<DestinoDeposito, DepositoRegistrado | null>> = {},
): ResumenOrden {
  const pendientes: Pendiente[] = []
  const hechos: Hecho[] = []
  const estado = orden.estado ?? ''

  // ── Operativo ─────────────────────────────────────────────────────────────
  const op = pendienteOperativo(orden)
  if (op) pendientes.push(op)
  else if (esTerminalDefinitivo(estado)) hechos.push({ id: 'ok:entrega', texto: 'Entrega completada' })

  // Una orden rechazada o cancelada no tiene pendiente operativo, pero tampoco
  // está "completada": se dice lo que es.
  if (esEstadoReactivable(estado)) {
    hechos.push({ id: 'ok:cerrada', texto: estado === 'cancelada' ? 'Orden cancelada' : 'Orden rechazada' })
  }

  // ── Cobro del delivery ────────────────────────────────────────────────────
  // Cartera real de ShEnvíos: el servicio se prestó. Se persigue desde el
  // módulo Cobros, que agrupa por comercio.
  const cliente = estadoDeliveryComercio(orden)
  if (cliente.clave === 'pendiente' && cliente.montoPendiente > 0) {
    pendientes.push({
      id: 'cobro:delivery',
      categoria: 'cobro',
      texto: `Comercio debe ${money(cliente.montoPendiente)} de delivery`,
      monto: cliente.montoPendiente,
      anchor: 'cobros',
      severidad: 'alta',
    })
  } else if (cliente.clave === 'en_revision' && cliente.montoPendiente > 0) {
    pendientes.push({
      id: 'cobro:delivery_revision',
      categoria: 'cobro',
      texto: `Comprobante del delivery en revisión · ${money(cliente.montoPendiente)}`,
      monto: cliente.montoPendiente,
      anchor: 'cobros',
      severidad: 'media',
    })
  } else if (cliente.clave === 'pagado') {
    hechos.push({ id: 'ok:delivery', texto: 'Delivery cobrado' })
  }

  // ── Incidencias ───────────────────────────────────────────────────────────
  // Sin clasificar es trabajo del gestor, no dinero que ShEnvíos reclame: se
  // enuncia como decisión pendiente y NUNCA lleva monto.
  if (hayIncidenciaSinClasificar(orden)) {
    pendientes.push({
      id: 'incidencia:clasificar',
      categoria: 'incidencia',
      texto: 'Incidencia de cobro por clasificar',
      anchor: 'incidencia',
      severidad: 'alta',
    })
  } else if (tieneResolucion(orden)) {
    // Clasificada: información cerrada. El producto no cobrado no vuelve a
    // aparecer como deuda — ese dinero es del comercio y su cliente (B1.2).
    hechos.push({
      id: 'ok:incidencia',
      texto: productoSinClasificar(orden) ? 'Incidencia clasificada' : 'Incidencia de cobro clasificada',
    })
  }

  // ── Depósito del motorizado ───────────────────────────────────────────────
  // Solo cuando calcularDeposito() dice que el motorizado tiene ese efectivo.
  // Si nunca lo recibió no hay obligación, y por eso esto no duplica jamás al
  // cobro pendiente de arriba: son dos billetes distintos.
  for (const l of lineasDeposito(orden, depositos)) {
    if (l.obligacion <= 0) continue
    const destino = l.destino === 'storkhub' ? 'a StorkHub' : 'al comercio'

    if (l.clave === 'sin_deposito') {
      pendientes.push({
        id: `deposito:${l.destino}`,
        categoria: 'deposito',
        texto: `Motorizado debe depositar ${money(l.obligacion)} ${destino}`,
        monto: l.obligacion,
        anchor: 'depositos',
        severidad: 'alta',
      })
      continue
    }

    const est = l.deposito?.estado
    if (est === 'confirmado') {
      hechos.push({ id: `ok:deposito:${l.destino}`, texto: `Depósito ${destino} confirmado` })
    } else if (est === 'rechazado' || est === 'convertido_en_deuda') {
      pendientes.push({
        id: `deposito:${l.destino}`,
        categoria: 'deposito',
        texto: `Depósito ${destino} ${est === 'rechazado' ? 'rechazado' : 'convertido en deuda'} · ${money(l.obligacion)}`,
        monto: l.obligacion,
        anchor: 'depositos',
        severidad: 'alta',
      })
    } else if (est) {
      // pendiente_boucher / en_revision / anulado: hay documento, todavía no
      // está cerrado. No es lo mismo que "nadie depositó".
      pendientes.push({
        id: `deposito:${l.destino}`,
        categoria: 'deposito',
        texto: `Depósito ${destino} ${est === 'en_revision' ? 'en revisión' : 'sin cerrar'} · ${money(l.obligacion)}`,
        monto: l.obligacion,
        anchor: 'depositos',
        severidad: 'media',
      })
    }
  }

  const sinPendientes = pendientes.length === 0
  return {
    pendientes,
    hechos,
    sinPendientes,
    mensajeLimpio: !sinPendientes
      ? null
      : esTerminalDefinitivo(estado)
        ? 'Orden completada — sin pendientes'
        : esEstadoReactivable(estado)
          ? 'Orden cerrada — sin pendientes'
          : 'Sin pendientes detectados',
  }
}
