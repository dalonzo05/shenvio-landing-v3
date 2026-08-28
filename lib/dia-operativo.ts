// DASH-DATE — El día operativo de ShEnvíos, como concepto explícito.
//
// El Dashboard cortaba el día con `new Date(); setHours(0,0,0,0)`: la
// medianoche del NAVEGADOR, no la de Nicaragua. Sobre los datos reales de
// staging eso ya cambiaba de día 3 de 5 entregas — todas ocurren de tarde y
// noche, la franja que en UTC ya pertenece al día siguiente. Dos personas
// mirando el mismo panel desde husos distintos veían cifras distintas.
//
// Regla autoritativa: el día operativo es el día calendario de Nicaragua,
// 00:00:00.000 a 23:59:59.999, en UTC−6. Nicaragua no aplica horario de
// verano, así que el offset es una constante exacta y no hace falta ninguna
// librería de zonas horarias.
//
// PURO y, sobre todo, INDEPENDIENTE DEL PROCESO: no hay `Date.now()` acá
// dentro —`ahora` se inyecta siempre— y toda la aritmética se hace sobre
// epoch y componentes UTC. Ningún método local de `Date` (`getHours`,
// `setHours`, `getFullYear`…) aparece en este archivo: son justamente los que
// arrastran el huso del dispositivo. Correr los tests con TZ=UTC, TZ=Asia/Tokyo
// o TZ=America/Managua debe dar exactamente el mismo resultado.

import { normalizarFecha } from './timeline-orden'

// ─── Constantes ───────────────────────────────────────────────────────────────

/** Nicaragua = UTC−6 todo el año. Sin DST: la constante es exacta. */
export const OFFSET_NICARAGUA_HORAS = -6

const OFFSET_MS = OFFSET_NICARAGUA_HORAS * 60 * 60 * 1000
const MS_DIA = 24 * 60 * 60 * 1000

/** Día calendario de Nicaragua en formato `YYYY-MM-DD`. */
export type DiaOperativo = string

export interface RangoDiaOperativo {
  /** Instante de 00:00:00.000 Nicaragua, en epoch ms. */
  inicioMs: number
  /** Instante de 23:59:59.999 Nicaragua, en epoch ms. Inclusivo. */
  finMs: number
}

const RE_DIA = /^\d{4}-\d{2}-\d{2}$/

/**
 * ¿Es una fecha real en formato `YYYY-MM-DD`?
 *
 * No basta el formato: `2026-02-30` lo cumple y no existe. Se verifica con
 * ida y vuelta contra UTC, que no depende del huso del proceso.
 */
export function esDiaOperativo(v: unknown): v is DiaOperativo {
  if (typeof v !== 'string' || !RE_DIA.test(v)) return false
  const ms = Date.parse(`${v}T00:00:00.000Z`)
  if (Number.isNaN(ms)) return false
  return new Date(ms).toISOString().slice(0, 10) === v
}

// ─── Instante → día ───────────────────────────────────────────────────────────

/**
 * Día operativo al que pertenece un instante.
 *
 * Se desplaza el epoch por el offset y se leen los componentes en UTC: así el
 * "día de Nicaragua" sale de aritmética pura, sin preguntarle la hora local a
 * nadie.
 */
export function diaOperativoDe(instanteMs: number): DiaOperativo | null {
  if (typeof instanteMs !== 'number' || !Number.isFinite(instanteMs)) return null
  const desplazado = new Date(instanteMs + OFFSET_MS)
  if (Number.isNaN(desplazado.getTime())) return null
  return desplazado.toISOString().slice(0, 10)
}

/** Día operativo actual. `ahora` se inyecta: el helper no consulta el reloj. */
export function hoyOperativo(ahoraMs: number): DiaOperativo | null {
  return diaOperativoDe(ahoraMs)
}

export function esHoyOperativo(dia: unknown, ahoraMs: number): boolean {
  if (!esDiaOperativo(dia)) return false
  return dia === hoyOperativo(ahoraMs)
}

// ─── Día → rango ──────────────────────────────────────────────────────────────

/**
 * Los dos extremos del día, en epoch ms, listos para una query cerrada.
 *
 * `finMs` es inclusivo y cae en `.999`: el día siguiente arranca exactamente
 * un milisegundo después, sin hueco por el que se pierda una orden ni
 * solapamiento que la cuente dos veces.
 */
export function rangoDiaOperativo(dia: unknown): RangoDiaOperativo | null {
  if (!esDiaOperativo(dia)) return null
  const medianocheUtc = Date.parse(`${dia}T00:00:00.000Z`)
  // 00:00 en Nicaragua ocurre 6 h DESPUÉS de la misma marca en UTC.
  const inicioMs = medianocheUtc - OFFSET_MS
  return { inicioMs, finMs: inicioMs + MS_DIA - 1 }
}

// ─── Aritmética de días ───────────────────────────────────────────────────────

/**
 * Corre el día N posiciones. Se opera sobre el mediodía UTC del día y no
 * sobre su medianoche: aunque acá no haya DST, mediodía deja margen de sobra
 * ante cualquier redondeo y hace la función imposible de romper por un
 * milisegundo. Cambios de mes, de año y años bisiestos salen solos porque el
 * calendario lo resuelve `Date` en UTC.
 */
export function sumarDiasOperativos(dia: unknown, n: number): DiaOperativo | null {
  if (!esDiaOperativo(dia) || !Number.isFinite(n)) return null
  const base = Date.parse(`${dia}T12:00:00.000Z`)
  const movido = new Date(base + Math.trunc(n) * MS_DIA)
  if (Number.isNaN(movido.getTime())) return null
  return movido.toISOString().slice(0, 10)
}

export function diaAnterior(dia: unknown): DiaOperativo | null {
  return sumarDiasOperativos(dia, -1)
}

export function diaSiguiente(dia: unknown): DiaOperativo | null {
  return sumarDiasOperativos(dia, 1)
}

// ─── Navegación: nunca al futuro ──────────────────────────────────────────────

/**
 * Un día posterior al de hoy no tiene datos que mostrar y sugeriría que el
 * panel sabe algo del futuro. La navegación lo bloquea antes de consultar.
 */
export function esDiaFuturo(dia: unknown, ahoraMs: number): boolean {
  if (!esDiaOperativo(dia)) return false
  const hoy = hoyOperativo(ahoraMs)
  return hoy !== null && dia > hoy
}

/** ¿Se puede avanzar un día desde acá sin caer en el futuro? */
export function puedeAvanzar(dia: unknown, ahoraMs: number): boolean {
  const siguiente = diaSiguiente(dia)
  return siguiente !== null && !esDiaFuturo(siguiente, ahoraMs)
}

/**
 * Día que la pantalla debe mostrar realmente.
 *
 * Un valor inválido o futuro —el input de fecha lo permite escribir a mano—
 * se corrige a hoy en vez de consultar un rango imposible.
 */
export function normalizarDiaSeleccionado(dia: unknown, ahoraMs: number): DiaOperativo | null {
  const hoy = hoyOperativo(ahoraMs)
  if (!esDiaOperativo(dia)) return hoy
  return dia > (hoy ?? dia) ? hoy : dia
}

// ─── Atribución de una orden a un día ─────────────────────────────────────────

/** Superset estructural: solo los campos que se miran acá. */
export interface EntradaDiaOrden {
  estado?: string | null
  createdAt?: unknown
  historial?: { entregadoAt?: unknown } | null
}

/** Día operativo en que se creó la orden. */
export function diaDeCreacion(orden: EntradaDiaOrden): DiaOperativo | null {
  const d = normalizarFecha(orden?.createdAt)
  return d ? diaOperativoDe(d.getTime()) : null
}

/**
 * Día operativo en que se ENTREGÓ la orden.
 *
 * Única fuente: `historial.entregadoAt`, el mismo timestamp que la timeline
 * autoritativa trata como prueba de la entrega. Sin él devuelve null y la
 * orden no se atribuye a ningún día — nunca cae a `createdAt`, a `updatedAt`
 * ni al estado actual. Contar una orden "entregada hoy" porque hoy se creó, o
 * porque hoy figura como entregada, sería inventar una fecha que nadie
 * registró: el estado dice QUÉ pasó, jamás CUÁNDO.
 */
export function diaDeEntrega(orden: EntradaDiaOrden): DiaOperativo | null {
  const d = normalizarFecha(orden?.historial?.entregadoAt)
  return d ? diaOperativoDe(d.getTime()) : null
}

/**
 * ¿Es una entrega que no se puede fechar? Sirve para contar cuántas quedan
 * fuera del total del día en vez de repartirlas a ojo.
 */
export function entregaSinFecha(orden: EntradaDiaOrden): boolean {
  return orden?.estado === 'entregado' && diaDeEntrega(orden) === null
}
