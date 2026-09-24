// VIAJE-ENTREGADO-SIN-COBRO-1 — Quién puede mover el viaje, y desde dónde.
//
// El P0 que motiva el módulo: un gestor o un admin podía marcar una orden como
// `entregado` desde tres pantallas con un updateDoc de dos campos. El documento
// quedaba sin `entregadoAt`, sin `cobrosMotorizado`, sin `cobroDelivery` y sin
// `acumulacionCobroSemanal` — y `calcularDeposito()`, que lee la AUSENCIA de
// `cobrosMotorizado.delivery.recibio === false` como "sí lo cobró", le exigía
// al motorizado depositar un dinero que nadie confirmó que recibió (C$1,090 en
// el caso real medido: C$90 de delivery + C$1,000 del cobro contra entrega).
//
// Este módulo NO redefine qué dinero se deposita —`calcularDeposito` no se
// toca— ni la máquina administrativa completa. Declara una sola cosa:
//
//   los CUATRO estados operativos del viaje pertenecen al flujo del
//   motorizado, y los dos que cierran dinero solo los escribe el servidor.
//
//   en_camino_retiro   señal del motorizado          → cliente (él)
//   retirado           cobro en la recolección       → SOLO Function
//   en_camino_entrega  señal del motorizado          → cliente (él)
//   entregado          cierre financiero completo    → SOLO Function
//
// Gestor y admin conservan lo administrativo: confirmar, asignar, reasignar,
// rebotar, rechazar, cancelar y reactivar. Lo operativo, para ellos, es
// display. La regularización retrospectiva (plataforma caída, operación en
// papel) volverá por su propia puerta —SUPERVISION-OPERATIVA-1, admin-only,
// con hechos declarados, fecha efectiva, motivo y derivación server-side—, no
// reabriendo esta.
//
// `programada` queda deliberadamente FUERA: existe como estado escrito en la
// creación pero no tiene máquina declarada ni promotor conocido
// (VIAJE-ESTADO-PROGRAMADA-SIN-MAQUINA). Meterlo acá sería afirmar un contrato
// que todavía no existe.
//
// La barrera real vive en firestore.rules; esto evita que la UI ofrezca una
// escritura que las Rules van a denegar igual — mismo criterio que el resto de
// los guards del panel, que nunca son la seguridad.
//
// PURO: sin Firestore, sin React.

/** Los cuatro estados que solo ocurren mientras el motorizado hace el viaje. */
export const ESTADOS_OPERATIVOS_VIAJE = [
  'en_camino_retiro',
  'retirado',
  'en_camino_entrega',
  'entregado',
] as const

/**
 * Los dos que cierran dinero: `confirmarTransicionConCobro` los escribe dentro
 * de una transacción junto con los cobros, el `cobroDelivery` (único lugar
 * donde se persiste `formaPago`) y el marcador del crédito semanal.
 */
export const ESTADOS_SERVER_AUTHORITATIVE = ['retirado', 'entregado'] as const

/**
 * Lo único que el motorizado puede mover por su cuenta: avisar que va en
 * camino. Son señales, no hechos financieros.
 */
export const TRANSICIONES_CLIENTE_MOTORIZADO: Readonly<Record<string, string>> = {
  asignada: 'en_camino_retiro',
  retirado: 'en_camino_entrega',
}

const texto = (v: unknown): string => (typeof v === 'string' ? v.trim() : '')

/** ¿Este estado pertenece al viaje del motorizado? */
export function esEstadoOperativoDelMotorizado(estado: string | null | undefined): boolean {
  return (ESTADOS_OPERATIVOS_VIAJE as readonly string[]).includes(texto(estado))
}

/** ¿Este estado solo puede escribirlo el servidor? */
export function esEstadoServerAuthoritative(estado: string | null | undefined): boolean {
  return (ESTADOS_SERVER_AUTHORITATIVE as readonly string[]).includes(texto(estado))
}

/**
 * ¿El motorizado puede escribir esta transición desde su cliente?
 *
 * Solo las dos señales, y solo desde su origen exacto: sin saltos. Todo lo
 * demás —incluidos `retirado` y `entregado`— es de la Function.
 */
export function puedeMotorizadoCambiarEstadoCliente(
  origen: string | null | undefined,
  destino: string | null | undefined,
): boolean {
  const desde = texto(origen)
  const hacia = texto(destino)
  if (!desde || !hacia) return false
  if (esEstadoServerAuthoritative(hacia)) return false
  return TRANSICIONES_CLIENTE_MOTORIZADO[desde] === hacia
}

/**
 * ¿Gestor o admin pueden escribir este destino desde su cliente?
 *
 * Lo administrativo sí; lo operativo no, y sin excepción para admin: un
 * `if (admin) permitir` recrearía exactamente el agujero que este bloque
 * cierra.
 */
export function puedeGestorCambiarEstadoCliente(destino: string | null | undefined): boolean {
  const hacia = texto(destino)
  if (!hacia) return false
  return !esEstadoOperativoDelMotorizado(hacia)
}

/** Copy único para cuando la UI tiene que explicar por qué no ofrece la acción. */
export const MSG_ESTADO_OPERATIVO_DEL_MOTORIZADO =
  'Este estado lo registra el motorizado desde su panel.'

// ─── Por dónde va cada transición del motorizado ──────────────────────────────
//
// VIAJE-ENTREGADO-SIN-COBRO-1 · HOTFIX — el E2E de SH-0007 mostró el agujero de
// este contrato: "Paquete recogido" llamaba a la Function solo cuando había un
// cobro que confirmar en la recolección. Con `quienPaga: 'entrega'` —el caso
// corriente— no hay nada que cobrar en el retiro, así que el cliente escribía
// `retirado` con un updateDoc directo… que las Rules nuevas deniegan. El SDK
// aplicaba el write local, el servidor lo rechazaba y la UI "cambiaba y volvía".
//
// La respuesta no es reabrirle `retirado` al cliente: es que el retiro pase por
// la Function SIEMPRE, con cobro o sin él. Acá se decide la ruta, en un helper
// puro, para que la decisión sea testeable y no viva enterrada en un handler.

export type RutaTransicionMotorizado =
  /** Va directo a la callable, sin preguntar nada: no hay cobro que confirmar. */
  | 'function'
  /** Abre el modal de confirmación y después llama a la callable. */
  | 'modal'
  /** updateDoc del cliente: es una señal, no un hecho financiero. */
  | 'cliente'

export interface FlagsCobroTransicion {
  showDelivery: boolean
  showProducto: boolean
  showCargotransCobro: boolean
}

/**
 * Qué camino toma una transición del motorizado.
 *
 * Los dos estados server-authoritative (`retirado`, `entregado`) van SIEMPRE por
 * la Function: con confirmaciones pendientes, pasando por el modal; sin ellas,
 * directo. Las dos señales (`en_camino_retiro`, `en_camino_entrega`) siguen
 * siendo un updateDoc del cliente, que es lo que las Rules le permiten.
 */
export function rutaTransicionMotorizado(
  destino: string | null | undefined,
  flags: FlagsCobroTransicion = { showDelivery: false, showProducto: false, showCargotransCobro: false },
): RutaTransicionMotorizado {
  if (esEstadoServerAuthoritative(destino)) {
    const pide = !!flags.showDelivery || !!flags.showProducto || !!flags.showCargotransCobro
    return pide ? 'modal' : 'function'
  }
  return 'cliente'
}
