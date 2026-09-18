// DEPOSITOS-UX-TRAZABILIDAD-1 — Cómo se nombra y se cuenta un documento de
// ordenes_deposito.
//
// Tres problemas, una sola autoridad:
//
//   1. IDENTIDAD. El trigger asigna DEP-0001 desde IDENTIDAD-HUMANA-1, pero
//      ninguna pantalla lo mostraba: Por revisar enseñaba el ID de Firestore y
//      la ficha sus diez primeros caracteres.
//
//   2. QUÉ MOVIMIENTO ES. La colección guarda tres cosas distintas y el campo
//      que las distingue es `tipo`, no `destinatario`:
//
//        recaudacion_motorizado_storkhub  el motorizado deposita a StorkHub
//        recaudacion_motorizado_comercio  el motorizado deposita al comercio
//        pago_delivery_deposito           el gestor registra que el delivery
//                                         se pagó por transferencia
//
//      El tercero también va a StorkHub, y el Historial lo pintaba como un
//      depósito del motorizado porque el documento trae su nombre (el de la
//      asignación). Ese motorizado no depositó nada: aquí nunca se le atribuye.
//
//   3. QUIÉN. `motorizadoNombre` guardaba el correo cuando Auth no tenía
//      displayName, y el confirmador solo existía como UID.
//
// PURO: sin Firestore, sin React, sin efectos.

import { esCodigoCanonico } from './codigo-humano'
import { etiquetaEstadoDeposito, type DepositoRegistrado } from './deposito-orden'
import { presentarActor, type ActorPresentado } from './actor-resolucion'

// ─── Tipo ─────────────────────────────────────────────────────────────────────

export const TIPO_MOTORIZADO_STORKHUB = 'recaudacion_motorizado_storkhub'
export const TIPO_MOTORIZADO_COMERCIO = 'recaudacion_motorizado_comercio'
export const TIPO_PAGO_DELIVERY_TRANSFERENCIA = 'pago_delivery_deposito'

export type ClaseDeposito =
  | 'motorizado_storkhub'
  | 'motorizado_comercio'
  | 'transferencia_delivery'
  /** Sin `tipo` reconocible: no se afirma quién originó el dinero. */
  | 'desconocido'

export function claseDeposito(dep: Pick<DepositoRegistrado, 'tipo'> | null | undefined): ClaseDeposito {
  switch (dep?.tipo) {
    case TIPO_MOTORIZADO_STORKHUB: return 'motorizado_storkhub'
    case TIPO_MOTORIZADO_COMERCIO: return 'motorizado_comercio'
    case TIPO_PAGO_DELIVERY_TRANSFERENCIA: return 'transferencia_delivery'
    default: return 'desconocido'
  }
}

/** true solo cuando el documento demuestra que el dinero lo entregó un motorizado. */
export function esDepositoDelMotorizado(dep: Pick<DepositoRegistrado, 'tipo'> | null | undefined): boolean {
  const c = claseDeposito(dep)
  return c === 'motorizado_storkhub' || c === 'motorizado_comercio'
}

// ─── Identidad ────────────────────────────────────────────────────────────────

export interface IdentidadDeposito {
  /** DEP-0001, o el ID técnico corto si el documento no tiene código. */
  texto: string
  /** false cuando `texto` es el ID técnico. */
  esCodigo: boolean
  /** ID completo de Firestore, para tooltip o copiar. Sigue siendo la FK. */
  idTecnico: string
}

export function identidadDeposito(dep: Pick<DepositoRegistrado, 'id' | 'codigo'>, largo = 8): IdentidadDeposito {
  const id = typeof dep.id === 'string' ? dep.id : ''
  if (esCodigoCanonico(dep.codigo)) return { texto: String(dep.codigo), esCodigo: true, idTecnico: id }
  return { texto: id ? id.slice(0, largo) : 'Sin código', esCodigo: false, idTecnico: id }
}

/**
 * Nombre del depósito dentro de una frase: "DEP-0001" o, sin código,
 * "Depósito P4IMui3I". Un ID suelto al inicio de una oración no se lee como
 * un depósito.
 */
export function nombreDeposito(dep: Pick<DepositoRegistrado, 'id' | 'codigo'>): string {
  const i = identidadDeposito(dep)
  return i.esCodigo ? i.texto : `Depósito ${i.texto}`
}

// ─── Origen y destino ─────────────────────────────────────────────────────────

export function destinoDeposito(dep: Pick<DepositoRegistrado, 'destinatario' | 'destinatarioNombre'>): string {
  if (dep.destinatario === 'storkhub') return 'StorkHub'
  const n = typeof dep.destinatarioNombre === 'string' ? dep.destinatarioNombre.trim() : ''
  return n || 'Comercio'
}

export interface OrigenDestino {
  clase: ClaseDeposito
  /** null cuando el documento no permite afirmar el origen. */
  origen: string | null
  destino: string
  /** Frase lista para una celda: "John Pork 2 → StorkHub". */
  texto: string
}

/**
 * @param nombreMotorizado nombre ya resuelto del motorizado. Sin él se dice
 *                         "Motorizado", que es lo que el tipo demuestra.
 */
export function origenDestinoDeposito(
  dep: Pick<DepositoRegistrado, 'tipo' | 'destinatario' | 'destinatarioNombre'>,
  nombreMotorizado?: string | null,
): OrigenDestino {
  const clase = claseDeposito(dep)
  const destino = destinoDeposito(dep)
  if (clase === 'motorizado_storkhub' || clase === 'motorizado_comercio') {
    const n = typeof nombreMotorizado === 'string' ? nombreMotorizado.trim() : ''
    const origen = n || 'Motorizado'
    return { clase, origen, destino, texto: `${origen} → ${destino}` }
  }
  if (clase === 'transferencia_delivery') {
    return { clase, origen: null, destino, texto: 'Pago del delivery por transferencia' }
  }
  return { clase, origen: null, destino, texto: `Depósito a ${destino}` }
}

// ─── Estado ───────────────────────────────────────────────────────────────────

export function estadoDeposito(dep: Pick<DepositoRegistrado, 'estado'>): string {
  return etiquetaEstadoDeposito(dep.estado)
}

/**
 * Qué pasó con el dinero de una orden cobrada, en una línea: la columna
 * Liquidación de Cobros. "Efectivo" dice cómo pagó el cliente; esto dice cómo
 * llegó ese dinero a su destino, y nunca se mezclan.
 */
export function liquidacionDeposito(dep: DepositoRegistrado): string {
  const nombre = identidadDeposito(dep).texto
  const estado = dep.estado === 'confirmado' ? 'Confirmado ✓' : estadoDeposito(dep)
  if (claseDeposito(dep) === 'transferencia_delivery') return `${nombre} · Transferencia registrada · ${estado}`
  return `${nombre} · ${origenDestinoDeposito(dep).texto} · ${estado}`
}

// ─── Fechas ───────────────────────────────────────────────────────────────────

export interface FechasDeposito {
  /**
   * Cuándo se envió. El motorizado crea el documento y sube el boucher en la
   * misma escritura, así que `creadoAt` ES el envío. Un documento sin
   * `creadoAt` cae al instante del boucher.
   */
  enviado: unknown
  /** Cuándo lo confirmó un gestor. Ausente = no se confirmó (o no se registró). */
  confirmado: unknown
}

export function fechasDeposito(dep: Pick<DepositoRegistrado, 'creadoAt' | 'confirmadoAt' | 'boucher'>): FechasDeposito {
  return {
    enviado: dep.creadoAt ?? dep.boucher?.uploadedAt ?? null,
    confirmado: dep.confirmadoAt ?? null,
  }
}

// ─── Actores ──────────────────────────────────────────────────────────────────

/**
 * Quién confirmó. Sin nombre resuelto → "Usuario interno", nunca un UID al
 * frente. No se infiere el rol: ni `creadoPorRol` de un movimiento (colapsa
 * admin en gestor) ni nada parecido.
 */
export function confirmadorDeposito(
  dep: Pick<DepositoRegistrado, 'confirmadoPorUid'>,
  nombres: Record<string, string> = {},
): ActorPresentado | null {
  return presentarActor(dep.confirmadoPorUid, nombres[dep.confirmadoPorUid ?? ''])
}

const pareceCorreo = (s: string) => /\S+@\S+\.\S+/.test(s)

/**
 * Nombre del motorizado de un depósito, para mostrar.
 *
 * El nombre resuelto por UID manda. El `motorizadoNombre` guardado solo sirve
 * si no es un correo: durante un tiempo se escribía `displayName ?? email`, y
 * mostrar el correo como si fuera el nombre es exponerlo sin necesidad.
 * Sin nada legible devuelve null: quien llama decide.
 */
export function nombreMotorizadoDeposito(
  dep: Pick<DepositoRegistrado, 'tipo' | 'motorizadoUid' | 'motorizadoNombre'>,
  nombres: Record<string, string> = {},
): string | null {
  if (!esDepositoDelMotorizado(dep)) return null
  const resuelto = dep.motorizadoUid ? (nombres[dep.motorizadoUid] ?? '').trim() : ''
  if (resuelto) return resuelto
  const guardado = typeof dep.motorizadoNombre === 'string' ? dep.motorizadoNombre.trim() : ''
  return guardado && !pareceCorreo(guardado) ? guardado : null
}

/**
 * Qué `motorizadoNombre` escribir al CREAR un depósito.
 *
 * El perfil de `motorizado` es la fuente: es el nombre que el gestor ve en
 * todas partes. Auth solo sirve si el perfil no cargó, y el correo nunca se
 * guarda como nombre. Sin nada, '' — el UID sigue siendo la FK autoritativa.
 */
export function nombreMotorizadoParaRegistro(fuentes: {
  perfil?: string | null
  displayName?: string | null
}): string {
  for (const v of [fuentes.perfil, fuentes.displayName]) {
    const s = typeof v === 'string' ? v.trim() : ''
    if (s && !pareceCorreo(s)) return s
  }
  return ''
}

/**
 * Campos de confirmación que escribe un gestor al dejar un depósito en
 * 'confirmado'. Los flujos que lo registraban en nombre del motorizado y los
 * de pago por transferencia pasaban a 'confirmado' sin decir quién ni cuándo.
 *
 * @param marca el `serverTimestamp()` del llamador; se inyecta para que esto
 *              siga siendo puro.
 */
export function camposConfirmacionDeposito<T>(uid: string | null | undefined, marca: T): { confirmadoAt: T; confirmadoPorUid?: string } {
  const limpio = typeof uid === 'string' ? uid.trim() : ''
  // Sin sesión no hay actor: se registra el instante y no un UID inventado.
  return limpio ? { confirmadoPorUid: limpio, confirmadoAt: marca } : { confirmadoAt: marca }
}

// ─── Comprobantes ─────────────────────────────────────────────────────────────

/**
 * URL del comprobante del DEPÓSITO. Los tipos de recaudación lo guardan en
 * `boucher.url`; el pago por transferencia, plano en `boucherUrl`.
 */
export function comprobanteDeposito(dep: Pick<DepositoRegistrado, 'boucher' | 'boucherUrl'>): string | null {
  const u = dep.boucher?.url ?? dep.boucherUrl ?? null
  return typeof u === 'string' && u.trim() ? u : null
}

/**
 * Qué hacer con el bloque del comprobante del PAGO DEL CLIENTE, que no es el
 * del depósito. El drawer decía "Sin boucher adjunto aún" en SH-0001, cobrada
 * en efectivo y con su depósito confirmado: ese comprobante no aplica.
 *
 *   mostrar    — hay comprobantes del cliente
 *   esperando  — el cobro va por transferencia y todavía no llegó
 *   no_aplica  — cualquier otro caso: no se dice nada
 */
export type ComprobanteCliente = 'mostrar' | 'esperando' | 'no_aplica'

export function comprobanteClienteAplica(
  cobro: { formaPago?: string | null; estado?: string | null } | null | undefined,
  quienPagaPlan: string | null | undefined,
  hayComprobantes: boolean,
): ComprobanteCliente {
  if (hayComprobantes) return 'mostrar'
  // Cobro cerrado sin comprobante del cliente: no hay nada que esperar.
  if (cobro?.estado === 'pagado') return 'no_aplica'
  if (cobro?.formaPago === 'efectivo') return 'no_aplica'
  // Cobro abierto que va por transferencia, o ya en revisión.
  if (cobro?.estado === 'en_revision_deposito' || cobro?.formaPago === 'transferencia' || quienPagaPlan === 'transferencia') {
    return 'esperando'
  }
  return 'no_aplica'
}
