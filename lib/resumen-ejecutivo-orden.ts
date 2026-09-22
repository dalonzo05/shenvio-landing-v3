// SOLICITUD-RESUMEN-UX-1 — Resumen ejecutivo de una orden.
//
// Nivel 1 de la ficha: qué orden es, en qué estado está, quién la llevó,
// cuánto costó el delivery, cómo se pagó, dónde terminó el dinero, qué
// evidencia hay y si algo requiere atención. El detalle sigue en los bloques
// de abajo, que no cambian.
//
// COMPONE, no decide. Todo sale de helpers que ya existen:
//
//   trazabilidadPago            monto, medio real, quién recibió, estado
//   montoDeliveryCobrado        el monto del delivery (no el pendiente)
//   deliveryCubiertoPorCobroProducto  la parte descontada del cobro contra entrega
//   presentacion-deposito       identidad, estado y destino de cada depósito
//   resumenOrden                los pendientes de "Qué falta en esta orden"
//
// Acá no hay ninguna regla financiera nueva y NUNCA se suman obligaciones
// distintas: C$90 a StorkHub y C$910 al comercio son dos líneas, jamás
// C$1,000. Los depósitos son los mismos que alimentan "Depósitos asociados".
//
// PURO: sin Firestore, sin React. Las fechas salen crudas; la UI las formatea
// con fechaHoraOperativa.

import { trazabilidadPago, type EntradaTrazabilidad } from './trazabilidad-pago'
import { montoDeliveryCobrado, deliveryCubiertoPorCobroProducto } from './monto-delivery'
import { resumenOrden, type EntradaResumen } from './resumen-orden'
import type { ResolucionIncidencia } from './incidencia-cobro'
import type { DepositoRegistrado, DestinoDeposito } from './deposito-orden'
import {
  identidadDeposito,
  estadoDeposito,
  claseDeposito,
  destinoDeposito,
  comprobanteDeposito,
} from './presentacion-deposito'

// ─── Copy oficial del resumen ─────────────────────────────────────────────────

export const SIN_DATO = 'No registrado'
export const NO_APLICA = 'No aplica'
/** Reemplaza a "Cubierto con el cobro del producto": describe el flujo físico. */
export const TEXTO_DESCONTADO_CE = 'Descontado del cobro contra entrega'
export const TEXTO_SIN_PENDIENTES = 'Sin pendientes'
export const TEXTO_REQUIERE_ATENCION = 'Requiere atención'
export const DESTINO_STORKHUB = 'A StorkHub'
export const DESTINO_COMERCIO = 'Al comercio'
/** Cuántos pendientes se nombran en el resumen; el resto queda en el detalle. */
export const MAX_MENSAJES_ATENCION = 3

const money = (n: number) => `C$ ${n.toLocaleString('es-NI')}`
const num = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null)
const texto = (v: unknown): string | null => (typeof v === 'string' && v.trim() !== '' ? v.trim() : null)

// ─── Salida ───────────────────────────────────────────────────────────────────

export interface EnvioResumen {
  estado: string
  /** "Metrocentro → Zona UCA-UNI", o las direcciones si no hay zonas. */
  ruta: string
  motorizado: string
  creada: unknown
  /** null cuando la orden todavía no se entregó. */
  entregada: unknown
}

export interface ClienteResumen {
  nombre: string
  tipoCliente: string
}

export interface CobroResumen {
  delivery: string
  /** Cómo se pagó de verdad; "No registrado" si nadie lo confirmó. */
  formaPago: string
  /** Quién recibió el dinero: el motorizado, o StorkHub en el tipo C. */
  recibio: string
  cobroContraEntrega: string
  /** "Descontado del cobro contra entrega: C$90", o null si no hubo deducción. */
  descontadoDelCE: string | null
  estadoCliente: string
}

export interface LiquidacionResumen {
  id: string
  codigo: string
  destino: string
  monto: string
  estado: string
  /** true cuando el depósito incluye otras órdenes: su total no es de esta. */
  esAgrupado: boolean
}

export interface EvidenciasResumen {
  retiro: boolean
  entrega: boolean
  comprobantes: number
}

export interface AtencionResumen {
  hayPendientes: boolean
  titulo: string
  /** Hasta MAX_MENSAJES_ATENCION; el resto vive en "Qué falta en esta orden". */
  mensajes: string[]
  total: number
}

export interface ResumenEjecutivo {
  envio: EnvioResumen
  cliente: ClienteResumen
  cobro: CobroResumen
  liquidaciones: LiquidacionResumen[]
  evidencias: EvidenciasResumen
  atencion: AtencionResumen
}

/**
 * Superset estructural de `EntradaTrazabilidad` y `EntradaResumen`.
 *
 * No hereda de ninguna: describen el mismo `cobrosMotorizado` y el mismo
 * `cobroDelivery` con formas distintas —`resumen-orden` agrega `resolucion`,
 * `trazabilidad-pago` agrega `formaPago` y `pagadoAt`— y TypeScript no puede
 * combinarlas por herencia (TS2320), ni ampliar una propiedad heredada.
 * Declarada así, una entrada sigue siendo asignable a las dos, que es lo
 * único que hace falta para componerlas.
 */
export interface EntradaResumenEjecutivo {
  estado?: string | null
  tipoServicio?: string | null
  tipoCliente?: string | null
  asignacion?: {
    motorizadoNombre?: string | null
    motorizadoAuthUid?: string | null
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
    formaPago?: string | null
    pagadoAt?: unknown
  } | null
  registro?: EntradaResumen['registro']
  createdAt?: unknown
  entregadoAt?: unknown
  historial?: { entregadoAt?: unknown } | null
  zonaRetiroNombre?: string | null
  macroZonaRetiroNombre?: string | null
  zonaEntregaNombre?: string | null
  macroZonaEntregaNombre?: string | null
  recoleccion?: { direccionEscrita?: string | null } | null
  entrega?: { direccionEscrita?: string | null } | null
  ownerSnapshot?: { companyName?: string | null; nombre?: string | null } | null
  evidencias?: Record<string, { url?: string | null } | null | undefined> | null
}

const TIPO_CLIENTE: Record<string, string> = { contado: 'Contado', credito: 'Crédito' }

/** Zona concreta → macrozona → dirección escrita → "No registrado". */
function extremoRuta(zona: unknown, macro: unknown, direccion: unknown): string {
  return texto(zona) ?? texto(macro) ?? texto(direccion) ?? SIN_DATO
}

export interface OpcionesResumenEjecutivo {
  /** Los mismos depósitos de "Depósitos asociados" (solicitudIds contiene la orden). */
  depositos?: Array<DepositoRegistrado | null | undefined>
  /** Los que la ficha indexa por destino, para reusar resumenOrden() sin cambiarlo. */
  depositosPorDestino?: Partial<Record<DestinoDeposito, DepositoRegistrado | null>>
  /** Nombre ya resuelto del motorizado; sin él se usa el guardado en la orden. */
  nombreMotorizado?: string | null
  /** Etiqueta del estado, la misma que usa el encabezado de la ficha. */
  estadoEtiqueta?: string | null
}

export function resumenEjecutivoOrden(
  orden: EntradaResumenEjecutivo,
  opciones: OpcionesResumenEjecutivo = {},
): ResumenEjecutivo {
  const { depositos = [], depositosPorDestino = {}, nombreMotorizado = null, estadoEtiqueta = null } = opciones

  // ── Envío ───────────────────────────────────────────────────────────────
  const motorizado = texto(nombreMotorizado) ?? texto(orden.asignacion?.motorizadoNombre) ?? SIN_DATO
  const envio: EnvioResumen = {
    estado: texto(estadoEtiqueta) ?? texto(orden.estado) ?? SIN_DATO,
    ruta: `${extremoRuta(orden.zonaRetiroNombre, orden.macroZonaRetiroNombre, orden.recoleccion?.direccionEscrita)} → `
      + `${extremoRuta(orden.zonaEntregaNombre, orden.macroZonaEntregaNombre, orden.entrega?.direccionEscrita)}`,
    motorizado,
    creada: orden.createdAt ?? null,
    entregada: orden.entregadoAt ?? orden.historial?.entregadoAt ?? null,
  }

  // ── Cliente / comercio ──────────────────────────────────────────────────
  const cliente: ClienteResumen = {
    nombre: texto(orden.ownerSnapshot?.companyName) ?? texto(orden.ownerSnapshot?.nombre) ?? SIN_DATO,
    tipoCliente: TIPO_CLIENTE[texto(orden.tipoCliente) ?? ''] ?? texto(orden.tipoCliente) ?? SIN_DATO,
  }

  // ── Cobro ───────────────────────────────────────────────────────────────
  // El nombre resuelto por UID manda sobre el guardado en la asignación, que
  // es lo único que mira trazabilidadPago() para nombrar al receptor.
  const ordenParaTraza: EntradaTrazabilidad = motorizado === SIN_DATO
    ? (orden as EntradaTrazabilidad)
    : { ...(orden as EntradaTrazabilidad), asignacion: { ...orden.asignacion, motorizadoNombre: motorizado } }
  const traza = trazabilidadPago(ordenParaTraza, depositosPorDestino)
  const montoDelivery = montoDeliveryCobrado(orden).monto
  const ce = orden.cobroContraEntrega?.aplica === true ? num(orden.cobroContraEntrega?.monto) : null
  const descontado = deliveryCubiertoPorCobroProducto(orden)
  const cobro: CobroResumen = {
    delivery: montoDelivery != null ? money(montoDelivery) : SIN_DATO,
    formaPago: texto(traza.medioPago) ?? SIN_DATO,
    recibio: texto(traza.receptor?.etiqueta) ?? SIN_DATO,
    cobroContraEntrega: ce != null ? money(ce) : NO_APLICA,
    descontadoDelCE: descontado != null ? `${TEXTO_DESCONTADO_CE}: ${money(descontado)}` : null,
    estadoCliente: traza.estadoCliente.etiqueta,
  }

  // ── Liquidación / dinero ────────────────────────────────────────────────
  // Una línea por depósito, nunca un total: son obligaciones distintas.
  const vistos = new Set<string>()
  const liquidaciones: LiquidacionResumen[] = []
  for (const dep of depositos) {
    if (!dep || typeof dep.id !== 'string' || vistos.has(dep.id)) continue
    vistos.add(dep.id)
    const clase = claseDeposito(dep)
    const destino = clase === 'transferencia_delivery'
      ? `${DESTINO_STORKHUB}, por transferencia del comercio`
      : dep.destinatario === 'storkhub'
        ? DESTINO_STORKHUB
        : dep.destinatario === 'comercio'
          ? `${DESTINO_COMERCIO} (${destinoDeposito(dep)})`
          : `A ${destinoDeposito(dep)}`
    const monto = num(dep.montoTotal)
    const ids = Array.isArray(dep.solicitudIds) ? dep.solicitudIds : []
    liquidaciones.push({
      id: dep.id,
      codigo: identidadDeposito(dep).texto,
      destino,
      monto: monto != null ? money(monto) : SIN_DATO,
      estado: estadoDeposito(dep),
      esAgrupado: ids.length > 1,
    })
  }

  // ── Evidencias ──────────────────────────────────────────────────────────
  const evidencias: EvidenciasResumen = {
    retiro: !!texto(orden.evidencias?.retiro?.url),
    entrega: !!texto(orden.evidencias?.entrega?.url),
    comprobantes: [...vistos].length === 0
      ? 0
      : depositos.filter((d) => !!d && !!comprobanteDeposito(d)).length,
  }

  // ── Atención ────────────────────────────────────────────────────────────
  // Los mismos pendientes de "Qué falta en esta orden": acá solo se cuentan y
  // se nombran los primeros. El bloque de abajo sigue siendo el detalle.
  const pendientes = resumenOrden(orden, depositosPorDestino).pendientes
  const atencion: AtencionResumen = {
    hayPendientes: pendientes.length > 0,
    titulo: pendientes.length === 0 ? TEXTO_SIN_PENDIENTES : TEXTO_REQUIERE_ATENCION,
    mensajes: pendientes.slice(0, MAX_MENSAJES_ATENCION).map((p) => p.texto),
    total: pendientes.length,
  }

  return { envio, cliente, cobro, liquidaciones, evidencias, atencion }
}
