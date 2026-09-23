// DEPOSITOS-ALERTA-REVISION-1 — Qué tiene que revisar el gestor, y cómo se lo
// avisa sin que tenga que entrar a mirar.
//
// El motorizado sube su comprobante y el depósito queda en 'en_revision'
// esperando que gestor/admin lo confirme o pida una corrección. Hasta ahora eso
// solo se veía dentro de Depósitos → Por revisar: si el gestor no entraba, el
// dinero se quedaba esperando sin que nadie lo supiera.
//
// UNA SOLA COSA cuenta como "por revisar" del gestor:
//
//   en_revision          SÍ — el motorizado ya hizo su parte; falta la suya
//   devuelto             NO — la pelota está en el motorizado
//   confirmado           NO — terminó
//   anulado              NO — terminó
//   convertido_en_deuda  NO — no hay revisión suya demostrada
//   pendiente_boucher    NO — el envío no se completó: no hay comprobante que
//                        revisar todavía. Sigue visible en el módulo, en su
//                        propia sección ("Esperando comprobante"), pero no
//                        cuenta como revisión pendiente en ninguna superficie
//
// El tipo C (pago_delivery_deposito) NO entra: nace 'confirmado' desde Cobros
// —lo registra el propio gestor al confirmar el pago— y su corrección es
// Cobros → Revertir, no la cola A/B. Se decide con `esDepositoDelMotorizado`,
// el mismo clasificador que ya usan la ficha y el panel del motorizado.
//
// Todo DERIVADO: no existe ni se escribe ningún contador, alerta o
// notificación en Firestore.
//
// PURO: sin Firestore, sin React.

import type { DepositoRegistrado } from './deposito-orden'
import { esDepositoDelMotorizado } from './presentacion-deposito'

/** El estado en el que un depósito del motorizado espera al gestor. */
export const ESTADO_POR_REVISAR_GESTOR = 'en_revision'

/**
 * ¿Este depósito espera una revisión del gestor?
 *
 * Decide por tipo y estado. No mira motivo, comprobante, fecha ni monto.
 */
export function requiereRevisionGestor(dep: DepositoRegistrado | null | undefined): boolean {
  if (!dep) return false
  if (!esDepositoDelMotorizado(dep)) return false
  return (dep.estado ?? '') === ESTADO_POR_REVISAR_GESTOR
}

/** Los depósitos que esperan revisión, sin repetir un mismo documento. */
export function depositosPorRevisarGestor(
  depositos: Array<DepositoRegistrado | null | undefined>,
): DepositoRegistrado[] {
  const vistos = new Set<string>()
  const out: DepositoRegistrado[] = []
  for (const dep of depositos) {
    if (!requiereRevisionGestor(dep)) continue
    const id = typeof dep!.id === 'string' ? dep!.id : ''
    if (!id || vistos.has(id)) continue
    vistos.add(id)
    out.push(dep!)
  }
  return out
}

/**
 * Cuántos depósitos esperan revisión. La unidad es el DEP: dos depósitos de la
 * misma orden cuentan dos. No suma montos.
 */
export function cantidadDepositosPorRevisarGestor(
  depositos: Array<DepositoRegistrado | null | undefined>,
): number {
  return depositosPorRevisarGestor(depositos).length
}

// ─── Copy y destino del aviso ─────────────────────────────────────────────────

/** El módulo de Depósitos del gestor, que ya existe. No se inventa ninguna ruta. */
export const RUTA_DEPOSITOS_GESTOR = '/panel/gestor/depositos'
/** La pestaña que ya existe en ese módulo. */
export const TAB_POR_REVISAR_GESTOR = 'por_revisar'
/** Nombre del parámetro con el que la página abre una pestaña concreta. */
export const PARAM_TAB_DEPOSITOS = 'tab'

/** `/panel/gestor/depositos?tab=por_revisar`, sin construir URLs a mano. */
export function rutaDepositosPorRevisar(): string {
  return `${RUTA_DEPOSITOS_GESTOR}?${PARAM_TAB_DEPOSITOS}=${TAB_POR_REVISAR_GESTOR}`
}

export interface AvisoRevisionGestor {
  titulo: string
  detalle: string
  cta: string
  /** A dónde lleva el CTA: Depósitos, con la pestaña Por revisar abierta. */
  href: string
}

/**
 * El aviso del dashboard, o null si no hay nada que revisar.
 *
 * Dice "por revisar", no "requiere atención": esa frase es la del motorizado
 * cuando StorkHub le pidió corregir un comprobante, y mezclarlas haría que los
 * dos roles leyeran lo mismo para cosas distintas.
 */
export function avisoRevisionGestor(cantidad: number): AvisoRevisionGestor | null {
  const n = Number.isFinite(cantidad) ? Math.floor(cantidad) : 0
  if (n <= 0) return null
  const plural = n > 1
  return {
    titulo: `Tienes ${n} depósito${plural ? 's' : ''} por revisar`,
    detalle: 'Hay comprobantes enviados por motorizados esperando tu revisión.',
    cta: 'Revisar depósitos',
    href: rutaDepositosPorRevisar(),
  }
}

/** Etiqueta accesible para el badge del sidebar, cuando se necesite. */
export function etiquetaBadgeDepositosGestor(cantidad: number): string {
  const n = Number.isFinite(cantidad) ? Math.max(0, Math.floor(cantidad)) : 0
  if (n <= 0) return 'Depósitos'
  return `Depósitos, ${n} por revisar`
}

// ─── La cola del módulo de Depósitos ──────────────────────────────────────────
//
// La query de esa página trae dos cosas juntas: los que esperan revisión y los
// que todavía no tienen comprobante. Son estados distintos con dueños
// distintos, así que la pestaña las separa y solo la primera cuenta como
// "Por revisar" — antes el KPI sumaba las dos y decía 2 donde el gestor tenía
// 1 decisión por tomar.

/** El motorizado (o el digitador) creó el depósito y el comprobante no llegó. */
export const ESTADO_ESPERANDO_COMPROBANTE = 'pendiente_boucher'

/**
 * ¿Este depósito espera el comprobante de quien lo envió?
 *
 * No es trabajo del gestor: no hay nada que revisar todavía. Sigue visible en
 * el módulo —un documento así puede quedar de un envío que falló— pero aparte.
 */
export function esperaComprobanteDelMotorizado(dep: DepositoRegistrado | null | undefined): boolean {
  if (!dep) return false
  if (!esDepositoDelMotorizado(dep)) return false
  return (dep.estado ?? '') === ESTADO_ESPERANDO_COMPROBANTE
}

export interface ColaRevisionDepositos {
  /** Esperan una decisión del gestor: confirmar o pedir corrección. */
  porRevisar: DepositoRegistrado[]
  /** Esperan el comprobante de quien los creó. No son trabajo del gestor. */
  esperandoComprobante: DepositoRegistrado[]
}

/**
 * Parte la cola en las dos cosas que hoy venían mezcladas. Preserva el orden de
 * entrada (la página ya la trae ordenada por fecha) y deduplica por id.
 */
export function clasificarColaRevision(
  depositos: Array<DepositoRegistrado | null | undefined>,
): ColaRevisionDepositos {
  const vistos = new Set<string>()
  const porRevisar: DepositoRegistrado[] = []
  const esperandoComprobante: DepositoRegistrado[] = []
  for (const dep of depositos) {
    if (!dep) continue
    const id = typeof dep.id === 'string' ? dep.id : ''
    if (!id || vistos.has(id)) continue
    if (requiereRevisionGestor(dep)) { vistos.add(id); porRevisar.push(dep); continue }
    if (esperaComprobanteDelMotorizado(dep)) { vistos.add(id); esperandoComprobante.push(dep) }
  }
  return { porRevisar, esperandoComprobante }
}

/** Encabezado de la sección aparte, para que nadie la lea como una revisión. */
export const TITULO_ESPERANDO_COMPROBANTE = 'Esperando comprobante'
export const DETALLE_ESPERANDO_COMPROBANTE =
  'El envío no se completó: todavía no hay comprobante que revisar.'
