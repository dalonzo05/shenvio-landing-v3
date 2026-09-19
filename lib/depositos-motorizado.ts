// DEPOSITOS-UX-TRAZABILIDAD-1 — Lo que el motorizado ve de su propio dinero.
//
// P0 que motiva el módulo: el panel sumaba en "Total a depositar hoy" toda
// orden entregada sin `confirmadoStorkhub`. Al enviar el depósito la tarjeta
// desaparecía —esa sí miraba el puntero— pero el total seguía diciendo C$110,
// o sea: le pedía al motorizado dinero que ya había depositado. Y "hoy" era
// falso: la lista no filtra por fecha.
//
// Tres estados por destino, decididos con datos de la propia orden:
//
//   PENDIENTE   obligación > 0, sin depósito registrado, sin confirmar
//   EN REVISIÓN hay depósito registrado (puntero), todavía sin confirmar
//   CERRADO     `confirmadoX` — confirmado, o convertido en deuda (que escribe
//               el mismo flag): ya no es dinero que el motorizado deba enviar
//
// La obligación sigue saliendo de calcularDeposito(); acá no hay fórmula
// financiera nueva.
//
// PURO: sin Firestore, sin React, sin efectos.

import { calcularDeposito } from './calculo-deposito'
import type { EntradaDepositoOrden, DepositoRegistrado } from './deposito-orden'
import { normalizarFecha } from './timeline-orden'
import {
  claseDeposito,
  identidadDeposito,
  destinoDeposito,
  estadoDeposito,
  comprobanteDeposito,
  fechasDeposito,
  type IdentidadDeposito,
} from './presentacion-deposito'

// ─── Resumen ──────────────────────────────────────────────────────────────────

export interface ResumenDepositosMotorizado {
  pendiente: {
    /** A StorkHub, neto de gastos aprobados: lo que el motorizado tiene que enviar. */
    storkhub: number
    /** A StorkHub antes de descontar gastos. */
    storkhubBruto: number
    comercio: number
    total: number
    /** Órdenes con algún destino pendiente. */
    ordenes: number
  }
  enRevision: {
    storkhub: number
    comercio: number
    total: number
    ordenes: number
  }
}

/**
 * @param ordenes          órdenes entregadas del motorizado
 * @param gastosDeducibles gastos aprobados que se descuentan de lo que va a
 *                         StorkHub, igual que ya hacía la tarjeta de depósito
 */
export function resumenDepositosMotorizado(
  ordenes: EntradaDepositoOrden[],
  gastosDeducibles = 0,
): ResumenDepositosMotorizado {
  let pendStorkhub = 0, pendComercio = 0, revStorkhub = 0, revComercio = 0
  let ordenesPend = 0, ordenesRev = 0

  for (const o of ordenes) {
    const calc = calcularDeposito(o)
    const reg = o.registro?.deposito
    let pend = false, rev = false

    if (calc.totalAStorkhub > 0 && !reg?.confirmadoStorkhub) {
      if (reg?.storkhubDepositoId) { revStorkhub += calc.totalAStorkhub; rev = true }
      else { pendStorkhub += calc.totalAStorkhub; pend = true }
    }
    if (calc.totalAlComercio > 0 && !reg?.confirmadoComercio) {
      if (reg?.comercioDepositoId) { revComercio += calc.totalAlComercio; rev = true }
      else { pendComercio += calc.totalAlComercio; pend = true }
    }
    if (pend) ordenesPend++
    if (rev) ordenesRev++
  }

  const gastos = typeof gastosDeducibles === 'number' && gastosDeducibles > 0 ? gastosDeducibles : 0
  const storkhubNeto = Math.max(0, pendStorkhub - gastos)
  return {
    pendiente: {
      storkhub: storkhubNeto,
      storkhubBruto: pendStorkhub,
      comercio: pendComercio,
      total: storkhubNeto + pendComercio,
      ordenes: ordenesPend,
    },
    enRevision: {
      storkhub: revStorkhub,
      comercio: revComercio,
      total: revStorkhub + revComercio,
      ordenes: ordenesRev,
    },
  }
}

// ─── Historial ────────────────────────────────────────────────────────────────

/** Cuántos depósitos se muestran. */
export const LIMITE_HISTORIAL_MOTORIZADO = 30

/**
 * Tope de la query. Sin orderBy —que con el where() por motorizado exigiría un
 * índice compuesto nuevo— Firestore devuelve por ID de documento, no por
 * fecha: se trae un tope holgado y el orden cronológico se hace acá. Con más
 * de este número de depósitos, los más recientes podrían quedar fuera
 * (deuda MOTO-DEPOSITOS-HISTORIAL-SIN-ORDEN-SERVIDOR).
 */
export const TOPE_QUERY_HISTORIAL_MOTORIZADO = 100

export interface FilaDepositoMotorizado {
  id: string
  identidad: IdentidadDeposito
  enviado: unknown
  confirmado: unknown
  destino: string
  monto: number
  ordenes: number
  /** SH-N de las órdenes incluidas; ID corto si el motorizado no la tiene cargada. */
  codigosOrdenes: string[]
  estado: string
  estadoClave: string | null
  comprobante: string | null
  /**
   * El motorizado no puede leer `usuarios`: no se le muestra un UID ni se
   * intenta la lectura. Lo que sí sabe es que lo confirmó StorkHub.
   */
  confirmadoPor: string | null
}

const ms = (v: unknown) => normalizarFecha(v)?.getTime() ?? 0

/**
 * Filas del historial de depósitos del motorizado, más reciente primero.
 *
 * Excluye el pago del delivery por transferencia: no es un depósito suyo
 * aunque el documento lleve su nombre. (Tampoco debería llegar —guarda el ID
 * del documento `motorizado` en `motorizadoUid`, no el UID de Auth— pero eso
 * es una coincidencia de datos, no una garantía.)
 */
export function historialDepositosMotorizado(
  depositos: DepositoRegistrado[],
  codigoDeOrden: Record<string, string> = {},
  limite = LIMITE_HISTORIAL_MOTORIZADO,
): FilaDepositoMotorizado[] {
  return depositos
    .filter((d) => claseDeposito(d) !== 'transferencia_delivery')
    .map((d) => ({ d, f: fechasDeposito(d) }))
    .sort((a, b) => ms(b.f.enviado) - ms(a.f.enviado) || a.d.id.localeCompare(b.d.id))
    .slice(0, Math.max(0, limite))
    .map(({ d, f }) => {
      const ids = Array.isArray(d.solicitudIds) ? d.solicitudIds : []
      return {
        id: d.id,
        identidad: identidadDeposito(d),
        enviado: f.enviado,
        confirmado: f.confirmado,
        destino: destinoDeposito(d),
        monto: typeof d.montoTotal === 'number' ? d.montoTotal : 0,
        ordenes: ids.length,
        codigosOrdenes: ids.map((id) => codigoDeOrden[id] || id.slice(0, 8)),
        estado: estadoDeposito(d),
        estadoClave: d.estado ?? null,
        comprobante: comprobanteDeposito(d),
        confirmadoPor: d.estado === 'confirmado' ? 'StorkHub' : null,
      }
    })
}

// ─── Pestañas y "Ver más" (MOTORIZADO-UX-OPERATIVA-1) ────────────────────────
//
// Todo en el cliente, sobre las filas ya cargadas (≤ TOPE_QUERY): 0 reads.
// "Por depositar" NO es una pestaña: sale de las órdenes (gruposDeposito), no
// de ordenes_deposito, y mezclarlos haría parecer el mismo estado documental.

export type PestanaDepositosMotorizado = 'por_revisar' | 'confirmados' | 'todos'

export const PESTANAS_DEPOSITOS_MOTORIZADO: { clave: PestanaDepositosMotorizado; texto: string }[] = [
  { clave: 'por_revisar', texto: 'Por revisar' },
  { clave: 'confirmados', texto: 'Confirmados' },
  { clave: 'todos', texto: 'Todos' },
]

const ESTADOS_POR_REVISAR = ['pendiente_boucher', 'en_revision']

/**
 * Filas de una pestaña. 'convertido_en_deuda' no es "Confirmado": solo aparece
 * en Todos, con su propio estado. El tipo C ya viene excluido de las filas.
 */
export function filasPestanaDepositos(
  filas: FilaDepositoMotorizado[],
  pestana: PestanaDepositosMotorizado,
): FilaDepositoMotorizado[] {
  if (pestana === 'por_revisar') return filas.filter((f) => ESTADOS_POR_REVISAR.includes(f.estadoClave ?? ''))
  if (pestana === 'confirmados') return filas.filter((f) => f.estadoClave === 'confirmado')
  return filas
}

/** Cuántas se muestran al abrir y cuántas más suma cada "Ver más". */
export const PASO_VER_MAS_DEPOSITOS = LIMITE_HISTORIAL_MOTORIZADO

/** 30 → 60 → 90 → … sin pasar de lo que hay. */
export function siguienteLimiteDepositos(actual: number, disponibles: number): number {
  return Math.min(Math.max(0, actual) + PASO_VER_MAS_DEPOSITOS, Math.max(0, disponibles))
}

/**
 * Aviso cuando la query llegó al tope. Sin orderBy la query no trae los más
 * recientes sino los primeros por ID: el texto no afirma recencia.
 */
export function avisoTopeDepositos(cargados: number): string | null {
  return cargados >= TOPE_QUERY_HISTORIAL_MOTORIZADO
    ? 'Mostrando los registros cargados. El historial completo se habilitará próximamente.'
    : null
}

/** Mensaje cuando el navegador no puede decodificar la imagen elegida. */
export const MENSAJE_IMAGEN_ILEGIBLE = 'No se pudo leer la imagen. Probá con una captura o una imagen JPG.'
