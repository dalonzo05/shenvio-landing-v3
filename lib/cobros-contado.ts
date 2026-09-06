// B2-PAGO-MEDIO-BOUCHER-REVIEW — qué llega a Cobros → Contado, y cómo se
// nombra el medio de pago mientras el cobro sigue abierto.
//
// ── Por qué existe este archivo ─────────────────────────────────────────────
//
// El lado del COMERCIO se refactorizó a `estado-cobro-comercio.ts`: un helper
// puro que reconoce los seis estados de `EstadoCobroDelivery` y está cubierto
// por tests. El lado del GESTOR se quedó con un predicado escrito a mano
// dentro de `contadoOrdenes` en `app/panel/gestor/cobros/page.tsx`, sin una
// sola prueba. Cuando `en_revision_deposito` entró al modelo, el helper se
// actualizó y el predicado no.
//
// El resultado medido en staging (orden WXfAQe3UkF2XVERZLpNX, C$80): el
// comercio sube su boucher, `cobroDelivery.estado` pasa a
// `en_revision_deposito`, y la orden desaparece de TODAS las bandejas del
// gestor. El comprobante quedaba bien guardado, las Rules lo habían validado y
// el modal de revisión existía — pero la fila nunca llegaba a la tabla que
// contiene el botón que abre ese modal.
//
// Extraerlo acá no es cosmética: es lo que permite que la próxima vez que
// alguien agregue un estado, un test lo obligue a decidir en los DOS lados.
//
// ── Lo que este helper NO hace ──────────────────────────────────────────────
//
// No calcula dinero, no ordena, no agrupa y no decide acciones. Solo responde
// dos preguntas de lectura sobre lo que ya está persistido.
//
// PURO: sin Firestore, sin React, sin fecha actual, sin imports de la app.

/**
 * Superset estructural de lo que este helper lee.
 *
 * Standalone a propósito: NO extiende `EntradaEstadoComercio` ni el `Solicitud`
 * de la página. Los tipos de las páginas declaran `estado` como una unión
 * cerrada que ni siquiera incluye `'revertido'`, y heredarlos volvería
 * imposible probar los documentos corruptos que este helper tiene que
 * sobrevivir. Todo entra permisivo y se valida en tiempo de ejecución.
 */
export interface EntradaCobrosContado {
  tipoCliente?: string | null
  cobroPendiente?: boolean | null
  pagoDelivery?: { quienPaga?: string | null } | null
  /** `unknown` porque en Firestore esto puede ser un mapa, una cadena o un array. */
  cobroDelivery?: unknown
}

/** Lo que se muestra cuando el medio de pago no consta. */
export const FORMA_PAGO_COBROS_AUSENTE = 'No registrado'

/**
 * El mapa `cobroDelivery`, o null si lo guardado no es un documento limpio.
 *
 * Un array es un objeto para `typeof`, y un `cobroDelivery` que llegue como
 * cadena, número o null no es un mapa a medio escribir: es un dato roto. En
 * ningún caso se lee un campo de ahí.
 */
function mapaCobroDelivery(cd: unknown): Record<string, unknown> | null {
  if (typeof cd !== 'object' || cd === null || Array.isArray(cd)) return null
  return cd as Record<string, unknown>
}

/**
 * ¿Esta orden entregada debe aparecer en Cobros → Contado → Por orden?
 *
 * El orden de las reglas es el del predicado original, y el ÚNICO cambio de
 * comportamiento es que `en_revision_deposito` ahora devuelve true:
 *
 *   1. Crédito y crédito semanal salen: se cobran agrupados en su propio tab.
 *   2. `cobroPendiente === true` sale: es una incidencia sin clasificar y vive
 *      en el tab Incidencias. No es que no se deba el dinero — es que todavía
 *      no se decidió si se va a cobrar.
 *   3. `pagado` y `no_cobrar` salen: no hay cartera abierta.
 *   4. `pendiente` entra.
 *   5. `en_revision_deposito` entra. Hay un comprobante esperando que el
 *      gestor lo apruebe o lo rechace, y el dinero sigue sin entrar. Es el
 *      caso que faltaba.
 *   6. Cualquier otro estado —incluido `revertido`, un estado vacío o un
 *      documento corrupto— NO decide nada por sí mismo: la respuesta la da la
 *      red de seguridad legacy.
 *
 * ── La red de seguridad legacy ──────────────────────────────────────────────
 *
 * `pagoDelivery.quienPaga === 'transferencia'` cubre las órdenes anteriores a
 * que `cobroDelivery` existiera: el cliente deposita directo a ShEnvíos, el
 * cobro nunca pasa por el motorizado y sin esta regla no habría forma de
 * cobrarlo. Se conserva tal cual, y se conserva también su alcance: se evalúa
 * después del switch, no solo cuando `cobroDelivery` falta.
 *
 * ── `revertido` ─────────────────────────────────────────────────────────────
 *
 * Está declarado en `EstadoCobroDelivery` (financial-types.ts) y NINGÚN
 * escritor lo produce. El único que revierte un pago —`revertirPagada` en
 * cobros/page.tsx— devuelve la orden a `'pendiente'`, no a `'revertido'`.
 * Verificado por búsqueda en todo el repositorio: las cinco referencias son
 * lecturas (etiquetas de UI) y una declaración de tipo.
 *
 * Así que hoy es un estado inalcanzable y cualquier regla que se le escriba
 * sería especulación. Se deja cayendo a la red legacy, que es exactamente lo
 * que hacía el predicado anterior: comportamiento idéntico, cero suposiciones.
 * Si algún día un escritor lo produce, hay que decidir si un cobro revertido
 * vuelve a ser cartera cobrable — y eso es una decisión de negocio, no de
 * refactor. Deuda: COBROS-ESTADO-REVERTIDO-INALCANZABLE.
 *
 * ── Documentos corruptos ────────────────────────────────────────────────────
 *
 * Fail closed: un `cobroDelivery` roto nunca OTORGA visibilidad. No se lee
 * ningún campo suyo, no se lanza, y la decisión queda en manos de
 * `pagoDelivery.quienPaga`, que es un campo aparte y bien formado. Ocultar la
 * orden cuando ese campo tampoco la reclama es el comportamiento actual y se
 * preserva; surfacearla cuando sí lo hace también, porque un documento roto
 * que además es cobrable es justo lo que el gestor tiene que ver.
 */
export function visibleEnCobrosContado(orden: EntradaCobrosContado): boolean {
  if (typeof orden !== 'object' || orden === null) return false

  if (orden.tipoCliente === 'credito') return false
  if (orden.pagoDelivery?.quienPaga === 'credito_semanal') return false

  if (orden.cobroPendiente === true) return false

  const cd = mapaCobroDelivery(orden.cobroDelivery)
  const estado = typeof cd?.estado === 'string' ? cd.estado : ''

  if (estado === 'pagado' || estado === 'no_cobrar') return false
  if (estado === 'pendiente' || estado === 'en_revision_deposito') return true

  return orden.pagoDelivery?.quienPaga === 'transferencia'
}

/**
 * Cómo se nombra el medio de pago en Cobros.
 *
 * Estricta a propósito y más estricta que `etiquetaFormaPago()` de
 * `campos-base-datos.ts`, que devuelve el valor crudo cuando no reconoce el
 * medio. Las dos superficies preguntan cosas distintas: Base de datos es
 * forense y muestra lo que hay guardado, aunque sea raro; Cobros es
 * decisional, y ahí un valor que el sistema no reconoce no puede presentarse
 * como si fuera un medio confirmado. Por eso `'tarjeta'` y `'Efectivo'` con
 * mayúscula salen como "No registrado" y no se normalizan.
 *
 * Lo que NO se admite como fuente, por construcción —no recibe el dato
 * siquiera—: `pagoDelivery.quienPaga` y `cobroDelivery.quienPaga`. Ese era el
 * origen del "Efectivo" que la tabla afirmaba sobre cobros cuyo medio nadie
 * había registrado: `entrega` dice CUÁNDO se cobra, no CON QUÉ. La misma
 * derivación ya se erradicó de Base de datos (B2-BASE-PAGO-DETALLE) y de la
 * Function (functions/src/medio-pago.ts); esta es la última superficie.
 *
 * Es una función de ETIQUETA, no de derivación: nunca decide un medio, solo
 * nombra uno que alguien ya confirmó desde Cobros.
 */
export function etiquetaFormaPagoCobros(formaPago: unknown): string {
  if (formaPago === 'efectivo') return 'Efectivo'
  if (formaPago === 'transferencia') return 'Transferencia'
  return FORMA_PAGO_COBROS_AUSENTE
}
