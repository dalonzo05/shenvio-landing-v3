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
import { ESTADO_DEVUELTO } from './deposito-correccion'
import { normalizarMotivoEvento } from './deposito-eventos'
import {
  depositoAdmiteVersionBoucher,
  esBoucherLegacy,
  versionEfectivaBoucher,
} from './deposito-boucher-version'

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
    // ── MOTO-DEPOSITOS-AVISOS-1 · E2E ───────────────────────────────────────
    /**
     * OBLIGACIONES pendientes, no órdenes: una sola orden puede deber un
     * depósito a StorkHub y otro al comercio, y son dos envíos distintos.
     * Se cuenta con la misma decisión que reparte los montos de arriba —no hay
     * segunda lógica— y no se deduce del monto: un pendiente a StorkHub que
     * los gastos dejan en C$0 neto sigue siendo una obligación.
     */
    obligaciones: number
    obligacionesStorkhub: number
    obligacionesComercio: number
  }
  enRevision: {
    storkhub: number
    comercio: number
    total: number
    ordenes: number
    /** Obligaciones ya enviadas y sin confirmar. */
    obligaciones: number
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
  // Obligaciones, no órdenes: se cuentan en las MISMAS ramas que reparten los
  // montos, así que no puede haber una discrepancia entre lo que se muestra y
  // lo que se cuenta.
  let obligPendStorkhub = 0, obligPendComercio = 0, obligRev = 0

  for (const o of ordenes) {
    const calc = calcularDeposito(o)
    const reg = o.registro?.deposito
    let pend = false, rev = false

    if (calc.totalAStorkhub > 0 && !reg?.confirmadoStorkhub) {
      if (reg?.storkhubDepositoId) { revStorkhub += calc.totalAStorkhub; rev = true; obligRev++ }
      else { pendStorkhub += calc.totalAStorkhub; pend = true; obligPendStorkhub++ }
    }
    if (calc.totalAlComercio > 0 && !reg?.confirmadoComercio) {
      if (reg?.comercioDepositoId) { revComercio += calc.totalAlComercio; rev = true; obligRev++ }
      else { pendComercio += calc.totalAlComercio; pend = true; obligPendComercio++ }
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
      obligaciones: obligPendStorkhub + obligPendComercio,
      obligacionesStorkhub: obligPendStorkhub,
      obligacionesComercio: obligPendComercio,
    },
    enRevision: {
      storkhub: revStorkhub,
      comercio: revComercio,
      total: revStorkhub + revComercio,
      ordenes: ordenesRev,
      obligaciones: obligRev,
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
  // ── DEPOSITO-AUDITORIA-1 ────────────────────────────────────────────────
  /**
   * Motivo de la corrección VIGENTE, o null. Se muestra sin actor: el
   * motorizado no puede leer `usuarios` (misma razón que confirmadoPor), así
   * que quien la pidió es "StorkHub" y punto.
   */
  motivoCorreccion: string | null
  /** `devueltoAt` crudo; la página lo formatea. */
  correccionAt: unknown
  /** ¿Puede subir hoy una versión nueva del comprobante? */
  puedeCorregir: boolean
  /** Versión vigente del comprobante, o null si nunca se reemplazó. */
  versionBoucher: number | null
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
        motivoCorreccion: d.estado === ESTADO_DEVUELTO
          ? (normalizarMotivoEvento(d.motivoDevolucion) || null)
          : null,
        correccionAt: d.estado === ESTADO_DEVUELTO ? (d.devueltoAt ?? null) : null,
        // El UID no se pasa acá: la fila se construye desde el historial del
        // propio motorizado, así que la pertenencia ya está garantizada por la
        // query (where motorizadoUid == su uid). Quien llama pasa el suyo si
        // quiere ser explícito; sin él, se decide solo por tipo y estado.
        puedeCorregir: depositoAdmiteVersionBoucher(d),
        versionBoucher: esBoucherLegacy(d) ? null : versionEfectivaBoucher(d),
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

// DEPOSITO-AUDITORIA-1 — 'devuelto' entra en "Por revisar", no en una pestaña
// nueva ni en "Todos" a secas. Es el estado en el que la pelota está del lado
// del motorizado: StorkHub ya miró el comprobante y le pidió otro. Dejarlo
// fuera lo escondería detrás de "Todos" justo cuando hay que actuar, y
// mandarlo a "Por depositar" sería mentir: el dinero ya se depositó y el
// depósito existe, con su DEP-N y sus órdenes enlazadas.
const ESTADOS_POR_REVISAR = ['pendiente_boucher', 'en_revision', 'devuelto']

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

// ─── MOTO-DEPOSITOS-AVISOS-1 · ¿esto requiere acción del motorizado? ──────────
//
// "Requiere atención" es una sola cosa: StorkHub le devolvió el depósito para
// que corrija el comprobante. NO es "pendiente de StorkHub" ni "cualquier
// depósito abierto".
//
//   devuelto             SÍ — tiene que subir otra versión del comprobante
//   en_revision          NO — ya hizo su parte; espera a StorkHub
//   confirmado           NO — terminó
//   anulado              NO — terminó
//   convertido_en_deuda  NO — no hay flujo suyo demostrado
//   pendiente_boucher    NO — es el estado inicial de F1 (create-first, sin
//                        comprobante todavía), otra cosa que una corrección
//                        pedida; ampliarlo sería otro bloque
//
// El aviso se DERIVA de los documentos que el panel ya tiene. No existe ni se
// escribe ningún `requiereAtencion`, contador ni notificación en Firestore.

/** El único estado que hoy pide una acción del motorizado. */
export const ESTADOS_ATENCION_MOTORIZADO: readonly string[] = [ESTADO_DEVUELTO]

/**
 * ¿Este depósito espera algo del motorizado?
 *
 * Decide por el ESTADO, no por el texto del motivo, la versión del boucher ni
 * las fechas. Un tipo C (pago del delivery por transferencia) nunca cuenta: no
 * es un depósito suyo aunque el documento lleve su nombre. Con `uidMotorizado`
 * se exige además la pertenencia, para que un arreglo mezclado no produzca
 * avisos cruzados entre motorizados.
 */
export function requiereAtencionMotorizado(
  dep: DepositoRegistrado | null | undefined,
  uidMotorizado?: string | null,
): boolean {
  if (!dep) return false
  if (claseDeposito(dep) === 'transferencia_delivery') return false
  const uid = typeof uidMotorizado === 'string' ? uidMotorizado.trim() : ''
  if (uid && (typeof dep.motorizadoUid !== 'string' || dep.motorizadoUid !== uid)) return false
  return ESTADOS_ATENCION_MOTORIZADO.includes(dep.estado ?? '')
}

/** Los depósitos que esperan una acción suya, sin repetir un mismo documento. */
export function depositosQueRequierenAtencion(
  depositos: Array<DepositoRegistrado | null | undefined>,
  uidMotorizado?: string | null,
): DepositoRegistrado[] {
  const vistos = new Set<string>()
  const out: DepositoRegistrado[] = []
  for (const dep of depositos) {
    if (!requiereAtencionMotorizado(dep, uidMotorizado)) continue
    const id = typeof dep!.id === 'string' ? dep!.id : ''
    if (!id || vistos.has(id)) continue
    vistos.add(id)
    out.push(dep!)
  }
  return out
}

/**
 * Cuántos depósitos esperan una acción del motorizado. La unidad es el DEP:
 * dos depósitos de la misma orden cuentan dos. No suma montos.
 */
export function cantidadDepositosQueRequierenAtencion(
  depositos: Array<DepositoRegistrado | null | undefined>,
  uidMotorizado?: string | null,
): number {
  return depositosQueRequierenAtencion(depositos, uidMotorizado).length
}

// ─── Copy del aviso ───────────────────────────────────────────────────────────

/** Etiqueta del contador, separada de "Por depositar": son cosas distintas. */
export const ETIQUETA_ATENCION_MOTORIZADO = 'Requiere atención'
/**
 * Los depósitos del motorizado no tienen ruta propia: son una pestaña de su
 * panel. El CTA cambia de pestaña, no navega, así que no se inventa una ruta.
 */
export const RUTA_DEPOSITOS_MOTORIZADO = '/panel/motorizado'
export const TAB_DEPOSITOS_MOTORIZADO = 'depositos'

export interface AvisoAtencionMotorizado {
  titulo: string
  detalle: string
  cta: string
  /** A dónde lleva el CTA: la pestaña de Depósitos de su propio panel. */
  ruta: string
  tab: string
}

/**
 * El aviso del home, o null si no hay nada que avisar. Quien pide la
 * corrección siempre es StorkHub —solo gestor/admin devuelven un depósito—,
 * también cuando el depósito iba al comercio.
 */
export function avisoAtencionMotorizado(cantidad: number): AvisoAtencionMotorizado | null {
  const n = Number.isFinite(cantidad) ? Math.floor(cantidad) : 0
  if (n <= 0) return null
  const plural = n > 1
  return {
    titulo: `Tienes ${n} depósito${plural ? 's' : ''} que requiere${plural ? 'n' : ''} atención`,
    detalle: plural
      ? 'StorkHub solicitó corregir los comprobantes.'
      : 'StorkHub solicitó corregir un comprobante.',
    cta: plural ? 'Revisar depósitos' : 'Revisar depósito',
    ruta: RUTA_DEPOSITOS_MOTORIZADO,
    tab: TAB_DEPOSITOS_MOTORIZADO,
  }
}

// ─── Tareas de depósito del motorizado ────────────────────────────────────────
//
// MOTO-DEPOSITOS-AVISOS-1 · E2E — el número general de "Depósitos" contaba
// ÓRDENES con algo pendiente. SH-0006 mostró el problema: una sola orden que
// debe C$90 a StorkHub y C$1,000 al comercio son DOS envíos, y el panel decía
// 1. Y cuando el gestor devolvió el depósito de los C$90, seguía diciendo 1
// aunque el motorizado tenía dos cosas por hacer: corregir ese comprobante y
// depositar los C$1,000.
//
// Una TAREA es algo que el motorizado tiene que hacer ahora:
//
//   · una obligación todavía sin depositar (por destino), y
//   · un depósito 'devuelto' que hay que corregir.
//
// Lo que espera a StorkHub (en_revision), lo cerrado (confirmado, anulado,
// convertido en deuda) y el tipo C no son tareas suyas.
//
// No hay doble conteo: en cuanto existe el puntero del depósito, la obligación
// deja de estar "pendiente" y pasa a "en revisión" —también si ese depósito
// fue devuelto—, así que el devuelto se cuenta una sola vez, por el lado de la
// corrección.

/**
 * Cuántas tareas de depósito tiene el motorizado ahora mismo.
 *
 * @param resumen   el de resumenDepositosMotorizado(): de ahí salen las
 *                  obligaciones pendientes, con la misma lógica que pinta
 *                  "Por depositar".
 * @param devueltos cuántos depósitos suyos están devueltos, tal como los
 *                  cuenta cantidadDepositosQueRequierenAtencion().
 */
export function cantidadTareasDepositoMotorizado(
  resumen: Pick<ResumenDepositosMotorizado, 'pendiente'>,
  devueltos: number,
): number {
  const pendientes = Number.isFinite(resumen?.pendiente?.obligaciones)
    ? Math.max(0, Math.floor(resumen.pendiente.obligaciones))
    : 0
  const correcciones = Number.isFinite(devueltos) ? Math.max(0, Math.floor(devueltos)) : 0
  return pendientes + correcciones
}

/**
 * Etiqueta accesible del badge de Depósitos. Dice "pendientes", no "requieren
 * atención": el número mezcla envíos por hacer con correcciones pedidas, y
 * solo el banner habla específicamente de correcciones.
 */
export function etiquetaBadgeDepositos(tareas: number): string {
  const n = Number.isFinite(tareas) ? Math.max(0, Math.floor(tareas)) : 0
  if (n <= 0) return 'Depósitos'
  return `Depósitos, ${n} ${n === 1 ? 'pendiente' : 'pendientes'}`
}
