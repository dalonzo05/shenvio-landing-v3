// VIAJE-RECHAZO-MOTORIZADO-TRAZA-1 — Cómo se muestra un rechazo de asignación.
//
// Cuando un motorizado rechaza, la solicitud vuelve a `confirmada` y su
// `asignacion` se borra. La Function deja un evento append-only
// (solicitudes_envio/{id}/eventos) y un resumen del ÚLTIMO rechazo en la propia
// solicitud (`ultimoRechazoMotorizado`), para que el listado lo muestre sin leer
// la subcolección por cada fila.
//
// Reglas de presentación, todas sobre lo persistido:
//
//   · la asignación VIGENTE siempre manda: si la solicitud está `asignada`, la
//     celda muestra su estado de aceptación y el rechazo anterior no aparece;
//   · un rechazo se muestra como HISTORIA ("rechazó · 18:47"), nunca como estado
//     operativo actual: no dice "Pendiente" ni hace parecer que el motorizado
//     sigue asignado;
//   · solo con la solicitud en `confirmada` y sin asignación: es el momento en
//     que el dato ayuda a decidir a quién asignarla ahora;
//   · el nombre sale del evento. Sin nombre demostrable no se inventa uno ni se
//     muestra un UID: "Un motorizado";
//   · sin hora demostrable, no se muestra hora.
//
// PURO: sin Firestore, sin React.

import { horaOperativa, fechaHoraOperativa, SIN_FECHA } from './fecha-operativa'

/** Resumen persistido en la solicitud. Todo opcional: viene crudo de Firestore. */
export interface UltimoRechazoMotorizado {
  eventoId?: string | null
  motorizadoId?: string | null
  motorizadoNombre?: string | null
  rechazadoAt?: unknown
}

export const NOMBRE_MOTORIZADO_DESCONOCIDO = 'Un motorizado'

/** Nombre demostrable, o el genérico. Nunca un UID ni un dato inventado. */
export function nombreMotorizadoRechazo(nombre: unknown): string {
  return typeof nombre === 'string' && nombre.trim() !== '' ? nombre.trim() : NOMBRE_MOTORIZADO_DESCONOCIDO
}

export interface TextoRechazo {
  /** "John Pork 2 rechazó · 18:47" (sin la hora si no se puede demostrar). */
  texto: string
  /** "John Pork 2 rechazó la asignación · 25/09/2026 · 18:47", para el tooltip. */
  detalle: string
}

export function textoRechazoMotorizado(r: UltimoRechazoMotorizado | null | undefined): TextoRechazo | null {
  if (!r || typeof r !== 'object') return null
  const nombre = nombreMotorizadoRechazo(r.motorizadoNombre)
  const hora = horaOperativa(r.rechazadoAt)
  const fechaHora = fechaHoraOperativa(r.rechazadoAt)
  const conHora = hora !== SIN_FECHA
  return {
    texto: conHora ? `${nombre} rechazó · ${hora}` : `${nombre} rechazó`,
    detalle: conHora ? `${nombre} rechazó la asignación · ${fechaHora}` : `${nombre} rechazó la asignación`,
  }
}

export interface EntradaCeldaAceptacion {
  estado?: string | null
  asignacion?: unknown
  ultimoRechazoMotorizado?: UltimoRechazoMotorizado | null
}

export type CeldaAceptacion =
  /** Hay asignación vigente: se muestra su estado de aceptación de siempre. */
  | { tipo: 'vigente' }
  /** Sin asignación, con un rechazo previo persistido: solo informativo. */
  | { tipo: 'rechazo_previo'; texto: string; detalle: string }
  | { tipo: 'ninguna' }

export function celdaAceptacion(orden: EntradaCeldaAceptacion): CeldaAceptacion {
  if (orden.estado === 'asignada') return { tipo: 'vigente' }
  const sinAsignacion = orden.asignacion == null
  if (orden.estado === 'confirmada' && sinAsignacion) {
    const t = textoRechazoMotorizado(orden.ultimoRechazoMotorizado)
    if (t) return { tipo: 'rechazo_previo', ...t }
  }
  return { tipo: 'ninguna' }
}
