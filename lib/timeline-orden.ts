// B2.4 — Timeline autoritativa de una orden.
//
// DERIVA, no crea. Cada evento nace de un timestamp ya persistido; ninguno se
// infiere del estado actual ni de `updatedAt`. La ficha tenía antes una barra
// de progreso que marcaba pasos como cumplidos por pertenencia de estado
// (`['retirado','entregado'].includes(estado)`), lo cual afirma que algo pasó
// sin saber cuándo — acá eso no existe: sin timestamp real no hay evento.
//
// Auditoría de campos (B2.4 §3, sobre shenvios-staging):
//   · asignacion.rechazadoAt   nunca se escribe: ambos caminos de rechazo
//     ponen `asignacion: null`. No hay evento posible.
//   · historial.canceladaAt    no existe ni en la orden cancelada real.
//   · reactivarOrden()         solo toca updatedAt.
//   → deuda B2-TIMELINE-TERMINALES.
//
// PURO: sin Firestore, sin React, sin efectos, sin Date.now().

import { detalleIncidencia, etiquetaResolucion, resolucionPrincipal, type ResolucionIncidencia } from './incidencia-cobro'
import { lineasDeposito, type EntradaDepositoOrden, type DepositoRegistrado, type DestinoDeposito } from './deposito-orden'

export type TipoEvento = 'operativo' | 'cobro' | 'deposito' | 'administrativo'

/**
 * B2.4B — separación de presentación, no de verdad.
 *
 *   recorrido — el ciclo logístico del envío, de creada a entregada
 *   cambio    — lo que le pasó a la orden después: cobros, incidencias,
 *               depósitos y actos administrativos
 *
 * `tipo` no sirve para esto: 'administrativo' contiene tanto la creación
 * (recorrido) como el rechazo (cambio). Por eso el grupo es un campo propio,
 * asignado por id, y no algo que se deduzca del título visible.
 */
export type GrupoEvento = 'recorrido' | 'cambio'

export interface TimelineEvento {
  id: string
  tipo: TipoEvento
  grupo: GrupoEvento
  titulo: string
  at: Date
  /** UID a resolver con el mecanismo de B2.2. Ausente = no hay actor persistido. */
  actorUid?: string
  /** Nombre ya conocido sin resolver nada (ej. el motorizado de la asignación). */
  detalle?: string
}

/**
 * Superset estructural de `EntradaIncidencia` y `EntradaDepositoOrden`.
 *
 * No los extiende porque describen el mismo `cobrosMotorizado` con formas
 * distintas —cada módulo declara solo lo que usa— y TypeScript no puede
 * combinarlos por herencia. Declarado así, una `EntradaTimeline` sigue siendo
 * asignable a ambos, que es lo único que importa para reutilizar sus helpers.
 */
export interface EntradaTimeline {
  createdAt?: unknown
  creadoInternamente?: boolean | null
  creadoPorGestorUid?: string | null
  cobroContraEntrega?: { aplica?: boolean | null; monto?: number | null } | null
  tipoServicio?: string | null
  tipoCliente?: string | null
  pagoDelivery?: {
    quienPaga?: string | null
    montoSugerido?: number | null
    deducirDelCobroContraEntrega?: boolean | null
    tipo?: string | null
  } | null
  cobrosMotorizado?: {
    delivery?: { monto?: number | null; recibio?: boolean | null; justificacion?: string | null; at?: unknown } | null
    producto?: {
      monto?: number | null
      recibio?: boolean | null
      justificacion?: string | null
      estado?: string | null
      at?: unknown
      resolucion?: ResolucionIncidencia | null
    } | null
    resolucion?: ResolucionIncidencia | null
  } | null
  registro?: EntradaDepositoOrden['registro']
  confirmacion?: { precioFinalCordobas?: number | null; confirmadoAt?: unknown; confirmadoPorUid?: string | null } | null
  asignacion?: {
    asignadoAt?: unknown
    asignadoPorUid?: string | null
    aceptadoAt?: unknown
    motorizadoNombre?: string | null
  } | null
  historial?: {
    en_camino_retiroAt?: unknown
    retiradoAt?: unknown
    en_camino_entregaAt?: unknown
    entregadoAt?: unknown
  } | null
  rechazo?: {
    motivoTexto?: string | null
    detalle?: string | null
    rechazadoPorUid?: string | null
    rechazadoAt?: unknown
  } | null
  cobroDelivery?: {
    estado?: string | null
    monto?: number | null
    montoDelivery?: number | null
    quienPaga?: string | null
    registradoAt?: unknown
    pagadoAt?: unknown
    confirmadoPor?: string | null
    formaPago?: string | null
  } | null
}

/**
 * Timestamp de Firestore, Date o ISO string → Date.
 *
 * Devuelve null ante cualquier valor que no represente un instante real. Nunca
 * inventa "ahora": un evento sin fecha confiable no se muestra.
 */
export function normalizarFecha(v: unknown): Date | null {
  if (v == null) return null
  if (v instanceof Date) return Number.isNaN(v.getTime()) ? null : v
  if (typeof v === 'object' && typeof (v as { toDate?: unknown }).toDate === 'function') {
    try {
      const d = (v as { toDate: () => Date }).toDate()
      return d instanceof Date && !Number.isNaN(d.getTime()) ? d : null
    } catch {
      return null
    }
  }
  // Firestore REST devuelve { seconds, nanoseconds } en algunos caminos.
  if (typeof v === 'object' && typeof (v as { seconds?: unknown }).seconds === 'number') {
    const d = new Date((v as { seconds: number }).seconds * 1000)
    return Number.isNaN(d.getTime()) ? null : d
  }
  if (typeof v === 'string' || typeof v === 'number') {
    const d = new Date(v)
    return Number.isNaN(d.getTime()) ? null : d
  }
  return null
}

const money = (n: number) => `C$ ${n.toLocaleString('es-NI')}`

/**
 * Rango lógico para desempatar eventos con el MISMO timestamp.
 *
 * No es cosmético: en los datos reales `confirmadoAt === asignadoAt` al
 * milisegundo, y al entregar coinciden `historial.entregadoAt`, los dos
 * `cobrosMotorizado.*.at` y `cobroDelivery.registradoAt`. Sin este rango el
 * orden dependería del orden de inserción, que es un detalle de código.
 */
const RANGO: Record<string, number> = {
  creada: 10,
  confirmada: 20,
  asignada: 30,
  aceptada: 40,
  en_camino_retiro: 50,
  retirado: 60,
  en_camino_entrega: 70,
  entregado: 80,
  incidencia: 90,
  delivery_pagado: 100,
  incidencia_resuelta: 110,
  deposito_registrado: 120,
  deposito_confirmado: 130,
  rechazada: 200,
}

/** Rango de un evento a partir de su id (`incidencia:producto` → `incidencia`). */
const rangoDe = (id: string) => RANGO[id.split(':')[0]] ?? 500

/**
 * Grupo de presentación por id. Un evento nuevo que no esté acá cae en
 * 'cambio': es el lado seguro — aparece en el historial en vez de
 * desaparecer o de colarse en el recorrido logístico.
 */
const GRUPO: Record<string, GrupoEvento> = {
  creada: 'recorrido',
  confirmada: 'recorrido',
  asignada: 'recorrido',
  aceptada: 'recorrido',
  en_camino_retiro: 'recorrido',
  retirado: 'recorrido',
  en_camino_entrega: 'recorrido',
  entregado: 'recorrido',
  // Rechazar la orden es un acto administrativo, no una etapa del envío.
  rechazada: 'cambio',
  incidencia: 'cambio',
  incidencia_resuelta: 'cambio',
  delivery_pagado: 'cambio',
  deposito_registrado: 'cambio',
  deposito_confirmado: 'cambio',
}

const grupoDe = (id: string): GrupoEvento => GRUPO[id.split(':')[0]] ?? 'cambio'

/**
 * Eventos de la orden, en orden cronológico ascendente.
 *
 * @param orden      documento de solicitudes_envio
 * @param depositos  documentos de ordenes_deposito que la ficha YA cargó en
 *                   B2.3, indexados por destino. No se consulta nada nuevo.
 */
export function construirTimeline(
  orden: EntradaTimeline,
  depositos: Partial<Record<DestinoDeposito, DepositoRegistrado | null>> = {},
): TimelineEvento[] {
  const ev: TimelineEvento[] = []
  const push = (id: string, tipo: TipoEvento, titulo: string, raw: unknown, extra: { actorUid?: string | null; detalle?: string | null } = {}) => {
    const at = normalizarFecha(raw)
    if (!at) return // sin fecha confiable no hay evento
    ev.push({
      id,
      tipo,
      grupo: grupoDe(id),
      titulo,
      at,
      ...(extra.actorUid ? { actorUid: extra.actorUid } : {}),
      ...(extra.detalle ? { detalle: extra.detalle } : {}),
    })
  }

  // ── Creación ──────────────────────────────────────────────────────────────
  // El actor solo existe cuando la orden se ingresó internamente. Si la creó
  // un comercio no hay UID interno: se muestra el evento sin actor.
  push('creada', 'administrativo', 'Orden creada', orden.createdAt, {
    actorUid: orden.creadoInternamente === true ? orden.creadoPorGestorUid : null,
  })

  // ── Confirmación ──────────────────────────────────────────────────────────
  push('confirmada', 'administrativo', 'Orden confirmada', orden.confirmacion?.confirmadoAt, {
    actorUid: orden.confirmacion?.confirmadoPorUid,
    detalle: typeof orden.confirmacion?.precioFinalCordobas === 'number'
      ? `Delivery ${money(orden.confirmacion.precioFinalCordobas)}`
      : null,
  })

  // ── Asignación y aceptación ───────────────────────────────────────────────
  const moto = orden.asignacion?.motorizadoNombre || null
  push('asignada', 'operativo', 'Motorizado asignado', orden.asignacion?.asignadoAt, {
    actorUid: orden.asignacion?.asignadoPorUid,
    detalle: moto,
  })
  // Aceptar es del motorizado por definición —la Function valida su identidad—
  // pero no persiste un UID de actor, así que va como detalle, no como actor.
  push('aceptada', 'operativo', 'Motorizado aceptó', orden.asignacion?.aceptadoAt, { detalle: moto })

  // ── Transiciones operativas ───────────────────────────────────────────────
  // Tienen timestamp pero NO actor persistido (B2.0, reconfirmado en B2.4):
  // `cambiarEstado` y la Function escriben historial.{estado}At sin uid. No se
  // les atribuye el motorizado asignado. → deuda B2-TIMELINE-ACTOR-OPERATIVO.
  const h = orden.historial
  push('en_camino_retiro', 'operativo', 'En camino al retiro', h?.en_camino_retiroAt)
  push('retirado', 'operativo', 'Paquete retirado', h?.retiradoAt)
  push('en_camino_entrega', 'operativo', 'En camino a la entrega', h?.en_camino_entregaAt)
  push('entregado', 'operativo', 'Entregado', h?.entregadoAt)

  // ── Orden rechazada ───────────────────────────────────────────────────────
  push('rechazada', 'administrativo', 'Orden rechazada', orden.rechazo?.rechazadoAt, {
    actorUid: orden.rechazo?.rechazadoPorUid,
    detalle: orden.rechazo?.motivoTexto || null,
  })

  // ── Incidencias de cobro ──────────────────────────────────────────────────
  // detalleIncidencia() ya resuelve el caso del delivery deducido devolviendo
  // UN solo ítem por el CE completo, así que acá nunca se suman dos montos que
  // fueron un mismo evento de cobro (B1.2E).
  for (const item of detalleIncidencia(orden)) {
    const at = item.item === 'producto'
      ? orden.cobrosMotorizado?.producto?.at
      : orden.cobrosMotorizado?.delivery?.at
    push(`incidencia:${item.item}`, 'cobro', 'Incidencia de cobro', at, {
      detalle: `${item.etiqueta} ${money(item.monto)} no cobrado`,
    })
  }

  // ── Resolución de la incidencia ───────────────────────────────────────────
  const res = resolucionPrincipal(orden)
  if (res) {
    push('incidencia_resuelta', 'cobro', 'Incidencia resuelta', res.at, {
      actorUid: res.resueltoPor,
      detalle: etiquetaResolucion(res),
    })
  }

  // ── Delivery cobrado ──────────────────────────────────────────────────────
  const cd = orden.cobroDelivery
  const montoCd = typeof cd?.monto === 'number' ? money(cd.monto) : null
  if (cd?.pagadoAt != null) {
    // Pago confirmado por un gestor. `pagadoAt` se BORRA al revertir el cobro,
    // así que su presencia es la señal fiable; `confirmadoAt` sobrevive a la
    // reversión y por eso no se usa como fuente.
    push('delivery_pagado', 'cobro', 'Delivery pagado', cd.pagadoAt, {
      actorUid: cd.confirmadoPor,
      detalle: [montoCd, cd.formaPago].filter(Boolean).join(' · ') || null,
    })
  } else if (cd?.estado === 'pagado') {
    // cobroDelivery nació 'pagado' al entregar: el motorizado ya lo había
    // cobrado. `registradoAt` es el instante en que ese hecho se persistió.
    push('delivery_pagado', 'cobro', 'Delivery cobrado por el motorizado', cd.registradoAt, {
      detalle: montoCd,
    })
  }

  // ── Depósitos ─────────────────────────────────────────────────────────────
  const lineas = lineasDeposito(orden, depositos)
  const reg = orden.registro?.deposito
  for (const l of lineas) {
    const dep = l.deposito
    if (dep) {
      // El total de un depósito agrupado incluye órdenes ajenas: el detalle
      // habla solo del aporte de ESTA orden.
      push(`deposito_registrado:${l.destino}`, 'deposito', `Depósito registrado (${l.etiqueta.toLowerCase()})`, dep.creadoAt, {
        detalle: `Esta orden aporta ${money(l.obligacion)}`,
      })
    }
    const confirmadoAt = l.destino === 'storkhub' ? reg?.confirmadoStorkhubAt : reg?.confirmadoComercioAt
    if (confirmadoAt == null) continue
    // Convertir un depósito en deuda escribe el MISMO campo confirmadoXAt que
    // una confirmación normal. El título sale del estado real del documento,
    // no del nombre del campo.
    const convertido = dep?.estado === 'convertido_en_deuda'
    push(
      `deposito_confirmado:${l.destino}`,
      'deposito',
      convertido ? `Depósito convertido en deuda (${l.etiqueta.toLowerCase()})` : `Depósito confirmado (${l.etiqueta.toLowerCase()})`,
      confirmadoAt,
      {
        // La conversión en deuda no persiste actor. → B2-TIMELINE-DEPOSITO-ACTOR.
        actorUid: convertido ? null : dep?.confirmadoPorUid,
        detalle: convertido ? dep?.notaConversion || null : `Esta orden aporta ${money(l.obligacion)}`,
      },
    )
  }

  // Orden cronológico ascendente. Ante timestamps idénticos —que en los datos
  // reales ocurren— el rango lógico y luego el id garantizan un resultado
  // determinista, independiente del orden de inserción.
  return ev.sort((a, b) =>
    a.at.getTime() - b.at.getTime()
    || rangoDe(a.id) - rangoDe(b.id)
    || a.id.localeCompare(b.id)
  )
}

/**
 * UIDs distintos que la timeline necesita resolver a nombre.
 *
 * La ficha los une con los que ya recolectaba en B2.2 y hace UNA lectura por
 * UID no cacheado — nunca una por evento.
 */
export function uidsDeTimeline(eventos: TimelineEvento[]): string[] {
  return [...new Set(eventos.map((e) => e.actorUid).filter((u): u is string => typeof u === 'string' && u.length > 0))]
}

// ═══════════════════════════════════════════════════════════════════════════
// B2.4B — presentación
//
// Nada de acá cambia qué eventos existen ni cuándo ocurrieron: solo los
// reparte en dos secciones y resume el recorrido. La verdad histórica sigue
// saliendo entera de construirTimeline().
// ═══════════════════════════════════════════════════════════════════════════

export interface TimelineSeparada {
  /** Ciclo logístico, de creada a entregada. */
  recorrido: TimelineEvento[]
  /** Todo lo demás: cobros, incidencias, depósitos, actos administrativos. */
  cambios: TimelineEvento[]
}

/**
 * Reparte los eventos en las dos secciones de la ficha.
 *
 * Es una partición: cada evento cae en exactamente una: `recorrido.length +
 * cambios.length === eventos.length`, sin duplicados y conservando el orden
 * cronológico de entrada.
 */
export function separarTimeline(eventos: TimelineEvento[]): TimelineSeparada {
  return {
    recorrido: eventos.filter((e) => e.grupo === 'recorrido'),
    cambios: eventos.filter((e) => e.grupo === 'cambio'),
  }
}

export interface HitoRecorrido {
  clave: string
  etiqueta: string
  /** Ocurrió de verdad: existe un evento con timestamp persistido. */
  alcanzado: boolean
  at: Date | null
}

/**
 * Los seis hitos del resumen compacto.
 *
 * "Motorizado aceptó" y "En camino al retiro" existen y se conservan, pero no
 * son hitos principales: alargan la barra sin agregar información que el
 * gestor necesite de un vistazo. Quedan dentro del recorrido completo.
 *
 * `alcanzado` sale de que exista el evento —es decir, de un timestamp real—,
 * nunca de que el estado actual "implique" que ya pasó. Esa inferencia era
 * justo lo que B2.4 eliminó.
 */
export function hitosRecorrido(eventos: TimelineEvento[]): HitoRecorrido[] {
  const porId = new Map(eventos.map((e) => [e.id, e]))
  return ([
    ['creada', 'Creada'],
    ['confirmada', 'Confirmada'],
    ['asignada', 'Asignada'],
    ['retirado', 'Retirada'],
    ['en_camino_entrega', 'En entrega'],
    ['entregado', 'Entregada'],
  ] as const).map(([clave, etiqueta]) => {
    const e = porId.get(clave)
    return { clave, etiqueta, alcanzado: !!e, at: e ? e.at : null }
  })
}
