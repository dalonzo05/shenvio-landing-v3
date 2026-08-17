// A-FIX1 — INTEGRIDAD DE ESTADOS CERRADOS
//
// Fuente ÚNICA de qué estados de solicitudes_envio están cerrados y cuáles
// admiten reactivación. Ya existía un mapa de transiciones válidas
// (TRANSICIONES_VALIDAS en app/panel/gestor/solicitudes/page.tsx) que declara
// correctamente `entregado: []`, `rechazada: []` y `cancelada: []`, pero solo
// lo consulta cambiarEstado() de ESA pantalla: los handlers de confirmación y
// asignación de los otros tres paneles lo evaden escribiendo estado/asignacion
// con updateDoc directo, que es por donde una orden entregada podía volver al
// principio.
//
// Este módulo NO reemplaza a TRANSICIONES_VALIDAS (que sigue gobernando qué
// transición concreta es válida entre estados no cerrados): centraliza el
// predicado "esta orden ya está cerrada" y, sobre todo, la distinción entre
// los dos tipos de cierre — que NO son intercambiables:
//
//   · entregado  → TERMINAL DEFINITIVO. Es el único cierre que deja rastro
//     financiero (cobrosMotorizado, evidencias, ordenes_deposito,
//     registro.deposito, movimientos_financieros). No vuelve por ningún flujo
//     ordinario; revertir una entrega será una operación especial, auditada y
//     financieramente consciente (REVERTIR ENTREGA), hoy fuera de alcance.
//
//   · rechazada / cancelada → REACTIVABLES. Nunca llegaron a generar una
//     obligación financiera, así que reactivarlas es inocuo. Conservan la
//     funcionalidad intencional ya existente (reactivarOrden en
//     SolicitudDrawer.tsx y solicitudes/[id]/page.tsx), que las devuelve
//     EXCLUSIVAMENTE a 'pendiente_confirmacion' — nunca directo a
//     confirmada/asignada ni más adelante.
//
// El espejo autoritativo vive en firestore.rules (rama isAdminOrGestor de
// solicitudes_envio). Estos guards de UI evitan que el operador dispare una
// escritura que las Rules van a rechazar igual; NUNCA son la barrera de
// seguridad — mismo criterio que ya usa el RBAC del panel.

/** Único cierre del que no se vuelve por un flujo ordinario. */
export const ESTADO_TERMINAL_DEFINITIVO = 'entregado' as const

/** Cierres que la operación puede reabrir vía "Reactivar orden". */
export const ESTADOS_REACTIVABLES = ['rechazada', 'cancelada'] as const

/** Todos los cierres: ninguno admite confirmar/asignar/reasignar ordinario. */
export const ESTADOS_CERRADOS = [ESTADO_TERMINAL_DEFINITIVO, ...ESTADOS_REACTIVABLES] as const

/** Único destino permitido de una reactivación. */
export const ESTADO_TRAS_REACTIVAR = 'pendiente_confirmacion' as const

/**
 * true si la orden está cerrada: ninguna acción ordinaria de confirmación,
 * asignación o reasignación debe ofrecerse ni ejecutarse.
 *
 * Se recibe `string | undefined | null` a propósito: cada panel del Gestor
 * declara su propio tipo local EstadoSolicitud, y acoplarse a uno obligaría a
 * importarlo en los otros tres. Un estado ausente/desconocido NO se trata como
 * cerrado — bloquear una orden por un dato faltante sería peor que el bug que
 * esto corrige, y la barrera real (Rules) evalúa el estado persistido.
 */
export function esEstadoCerrado(estado: string | undefined | null): boolean {
  return !!estado && (ESTADOS_CERRADOS as readonly string[]).includes(estado)
}

/** true solo para 'entregado' — el cierre que nunca se reabre. */
export function esTerminalDefinitivo(estado: string | undefined | null): boolean {
  return estado === ESTADO_TERMINAL_DEFINITIVO
}

/** true para 'rechazada'/'cancelada' — los únicos que admiten "Reactivar orden". */
export function esEstadoReactivable(estado: string | undefined | null): boolean {
  return !!estado && (ESTADOS_REACTIVABLES as readonly string[]).includes(estado)
}

/** Mensaje único para los guards defensivos de los handlers ordinarios. */
export const MSG_ORDEN_CERRADA =
  'La orden está cerrada y no puede reasignarse desde este flujo.'
