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

// ── MOTO-REASIGNACION-POST-RETIRO-GUARD-1 ───────────────────────────────────
//
// `esEstadoCerrado()` (arriba) responde "¿esta orden está cerrada?" — y
// 'retirado'/'en_camino_entrega' NO lo están: siguen abiertas para cobros,
// depósitos y avance operativo. Pero ESO no las hacía reasignables por
// accidente: el bug P1 confirmado en diagnóstico previo era justo que
// 'confirmar' (el botón de "Decisión rápida" en Drawer/detalle/Base de
// datos) solo miraba `esEstadoCerrado()`, así que una solicitud 'retirado' —
// con el motorizado YA en posesión física del paquete — podía volver a
// 'asignada' con un motorizado nuevo, sin que Firestore Rules ni el callable
// (que antes solo miraba estadosAbiertos) lo impidieran.
//
// Este es un predicado DISTINTO, con su propio significado: "¿puede
// cambiarse el motorizado de esta orden ahora mismo?" — separado en dos
// mitades porque son dos operaciones distintas (ver más abajo) con
// contratos distintos:
//
//   · asignación INICIAL (operación 'confirmar' en el backend): la orden
//     TODAVÍA no tiene un motorizado confirmado. Corresponde exactamente a
//     los dos estados donde HOY existe ese flujo: pendiente_confirmacion y
//     confirmada.
//
//   · REASIGNACIÓN (operación 'reasignar' en el backend): la orden YA tiene
//     un motorizado y se lo va a cambiar por otro. Solo tiene sentido —y
//     solo es seguro— ANTES del retiro físico: 'asignada' (el motorizado
//     todavía no salió) y 'en_camino_retiro' (va camino a buscar el
//     paquete, pero AÚN no lo tiene en la mano). Desde 'retirado' en
//     adelante, cambiar el motorizado de la asignación desconecta a quien
//     Firestore dice que es responsable de quien físicamente tiene el
//     paquete — y storage.rules autoriza subir evidencia de retiro/entrega
//     comparando contra asignacion.motorizadoAuthUid en vivo (ver
//     esMotorizadoAsignado en storage.rules), así que el motorizado
//     original perdería ese permiso a mitad de su propia entrega.
//
// El espejo autoritativo de esta MISMA matriz vive en
// functions/src/asignacion-motorizado.ts (estadosAsignacionInicial /
// estadosReasignables) — Functions no puede importar de `lib/` (su
// tsconfig usa `include: ["src"]` con `outDir: "lib"`; un import hacia
// afuera arrastraría el rootDir y rompería las rutas del artefacto de
// deploy), así que es una duplicación DELIBERADA de la misma matriz, no una
// segunda decisión independiente. Cualquier cambio acá debe reflejarse
// también allá, y viceversa — functions/test/asignacion-motorizado.test.ts
// fija exactamente los mismos 5 estados con los mismos valores esperados
// que lib/estados-solicitud.test.ts.

/** Estados donde la solicitud todavía NO tiene motorizado confirmado — acá
 *  corresponde la asignación inicial ('confirmar' en el backend). */
export const ESTADOS_ASIGNACION_INICIAL = ['pendiente_confirmacion', 'confirmada'] as const

/** Estados desde los que puede cambiarse el motorizado de una solicitud que
 *  YA tiene uno ('reasignar' en el backend) — solo antes del retiro físico. */
export const ESTADOS_REASIGNABLES = ['asignada', 'en_camino_retiro'] as const

/** true si la orden todavía admite una asignación inicial (sin motorizado confirmado). */
export function puedeAsignarInicial(estado: string | undefined | null): boolean {
  return !!estado && (ESTADOS_ASIGNACION_INICIAL as readonly string[]).includes(estado)
}

/** true si puede cambiarse el motorizado de una orden que ya tiene uno — solo
 *  antes del retiro físico (asignada / en_camino_retiro). false para
 *  retirado, en_camino_entrega, entregado, y para cualquier cierre. */
export function puedeReasignarMotorizado(estado: string | undefined | null): boolean {
  return !!estado && (ESTADOS_REASIGNABLES as readonly string[]).includes(estado)
}

/** true si corresponde ofrecer ALGÚN control de asignación (inicial o
 *  reasignación) — es lo que decide si la sección "Decisión rápida" (o
 *  equivalente) se muestra en absoluto. */
export function puedeGestionarAsignacion(estado: string | undefined | null): boolean {
  return puedeAsignarInicial(estado) || puedeReasignarMotorizado(estado)
}

/** Mensaje para el intento server-side de reasignar una orden que ya avanzó
 *  más allá de en_camino_retiro (retirado/en_camino_entrega/entregado) —
 *  mismo texto que devuelve asignarMotorizadoCore con motivo
 *  'solicitud_no_reasignable'. */
export const MSG_ORDEN_NO_REASIGNABLE =
  'Esta orden ya avanzó y no permite reasignar el motorizado.'
