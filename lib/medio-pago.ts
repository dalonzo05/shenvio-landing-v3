// B2-PAGO-MEDIO — Con qué se pagó el delivery. Contrato del lado app.
//
// ⚠️ ESPEJO DELIBERADO de `functions/src/medio-pago.ts`. Los dos archivos
// declaran el mismo contrato y deben mantenerse alineados a mano: mismo enum,
// mismas reglas, mismos veredictos. No se comparte un módulo entre app y
// Functions a propósito — un import cruzado arrastraría `functions/src` al
// compilado raíz de tests, cambiando el rootDir común y el layout de
// `.test-build`, y ataría el gate de la app al artefacto de otro subproyecto.
// La frontera autoritativa de seguridad sigue siendo la validación
// server-side; esta copia es la que usa la UI y la que cubren los tests.
// Ver deuda PAGO-MEDIO-ENUM-ESPEJADO.
//
// ── Regla de negocio ────────────────────────────────────────────────────────
//
// `cobroDelivery.formaPago` es la ÚNICA fuente persistente y autoritativa del
// medio. Su ausencia significa "nadie lo registró" y se presenta como
// "No registrado" — nunca como impago, y nunca como excusa para deducirlo.
//
// Está PROHIBIDO derivar el medio de cualquier otra cosa: `quienPaga` (dice
// quién y cuándo, no con qué), `recibio: true` (dice que hay dinero que
// depositar, no en qué forma), el receptor, el motorizado, el momento
// —recolección o entrega— o la existencia de una obligación de depósito.
// Traducir `quienPaga` fue exactamente el origen del bug "Ef. entrega", que
// afirmaba efectivo sobre un cobro cuyo medio nadie había registrado.
//
// PURO y sin imports: sin Firestore, sin React, sin fechas.

/** Conjunto cerrado. Cualquier valor fuera de aquí no se persiste jamás. */
export const MEDIOS_PAGO = ['efectivo', 'transferencia'] as const

export type MedioPago = (typeof MEDIOS_PAGO)[number]

/**
 * ¿Es uno de los dos valores persistibles?
 *
 * Estricto a propósito: sin `trim()`, sin normalizar mayúsculas y sin
 * sinónimos. `Efectivo`, `EFECTIVO` y `transferencia_deposito` son inválidos.
 * Un enum que acepta variantes deja de ser cerrado, y el filtro de Base de
 * datos —Efectivo / Transferencia / No registrado— se volvería ciego a lo que
 * no contempla.
 */
export function esMedioPago(v: unknown): v is MedioPago {
  return typeof v === 'string' && (MEDIOS_PAGO as readonly string[]).includes(v)
}

// ─── Resolución del formaPago al cerrar ───────────────────────────────────────

export interface ResolucionFormaPago {
  /** Valor a persistir, o null si no debe escribirse el campo. */
  formaPago: MedioPago | null
  /** true cuando el valor salió del temporal de la recolección. */
  consumeTemporal: boolean
}

/**
 * Qué `formaPago` debe quedar al cerrar `cobroDelivery`.
 *
 * Orden de autoridad, sin ninguna otra fuente:
 *
 *   1. `formaPagoExistente` válido → se CONSERVA. Un cierre posterior nunca
 *      pisa lo que ya estaba: si el gestor o un cierre previo lo fijaron, esa
 *      es la verdad y un medio contradictorio se descarta.
 *   2. `medioDeEstaLlamada` — el motorizado acaba de declararlo (entrega
 *      directa).
 *   3. `medioTemporal` — lo declaró al cobrar en la recolección y viajó en
 *      `cobrosMotorizado.delivery.medio` hasta acá.
 *   4. Nada → no se escribe `formaPago`. "No estoy seguro" termina siempre
 *      aquí, y no existe camino posterior que pueda completarlo.
 *
 * `consumeTemporal` avisa de que el temporal cumplió su función: quien llama
 * debe borrarlo en el MISMO update, para que después del cierre el medio viva
 * en un solo sitio y una reversión no deje nada capaz de regenerarlo.
 */
export function resolverFormaPago(entrada: {
  formaPagoExistente?: unknown
  medioDeEstaLlamada?: unknown
  medioTemporal?: unknown
}): ResolucionFormaPago {
  if (esMedioPago(entrada.formaPagoExistente)) {
    return { formaPago: entrada.formaPagoExistente, consumeTemporal: false }
  }
  if (esMedioPago(entrada.medioDeEstaLlamada)) {
    return { formaPago: entrada.medioDeEstaLlamada, consumeTemporal: false }
  }
  if (esMedioPago(entrada.medioTemporal)) {
    return { formaPago: entrada.medioTemporal, consumeTemporal: true }
  }
  return { formaPago: null, consumeTemporal: false }
}

/**
 * ¿Hay que borrar `cobrosMotorizado.delivery.medio` por dot-path en el cierre?
 *
 * Solo cuando el patch NO reescribe el mapa `delivery` completo. Firestore
 * rechaza un update que contenga a la vez un campo y un ancestro suyo, así que
 * las dos formas de consumir el temporal son excluyentes:
 *
 *   · se reescribe `cobrosMotorizado.delivery` → basta con omitir `medio`;
 *   · no se reescribe                          → hace falta el delete del leaf.
 *
 * Se borra siempre que el temporal exista, lo haya usado o no: después del
 * cierre la única fuente del medio debe ser `cobroDelivery.formaPago`.
 */
export function debeBorrarTemporalPorRuta(entrada: {
  reescribeMapaDelivery: boolean
  temporalPresente: boolean
}): boolean {
  return entrada.temporalPresente && !entrada.reescribeMapaDelivery
}

// ─── Reglas del payload y del cierre ──────────────────────────────────────────

export type VeredictoMedio =
  | 'ausente'
  | 'valido'
  | 'invalido'
  | 'no_permitido_en_producto'

/**
 * ¿Qué hacer con el `medio` que llegó en una respuesta de cobro?
 *
 * `medio` solo tiene sentido para el delivery: el producto es dinero del
 * comercio y su medio no es una pregunta que este flujo responda. Enviarlo ahí
 * se RECHAZA explícitamente en vez de ignorarse — un payload que trae un campo
 * que nadie va a usar es un malentendido, y callarlo lo perpetúa.
 *
 * `undefined` y `null` son ausencia legítima: el SDK de Functions serializa una
 * propiedad con valor `undefined` como `null`, así que ambos significan "el
 * motorizado no respondió con un medio".
 */
export function evaluarMedioDePayload(entrada: {
  medio: unknown
  esProducto: boolean
}): VeredictoMedio {
  const ausente = entrada.medio === undefined || entrada.medio === null
  if (entrada.esProducto) return ausente ? 'ausente' : 'no_permitido_en_producto'
  if (ausente) return 'ausente'
  return esMedioPago(entrada.medio) ? 'valido' : 'invalido'
}

/**
 * ¿Se admite una llamada a la callable que no trae ninguna confirmación de
 * cobro?
 *
 * El guard general es fail-closed: sin delivery, producto ni cargotrans no hay
 * nada legítimo que escribir. Se abre UNA excepción estrecha: el cierre de
 * `cobroDelivery` al entregar.
 *
 * Existe porque el cierre dejó de hacerlo el cliente. Las Rules solo le
 * permiten al motorizado escribir `cobroDelivery` en su primera aparición y
 * con un `hasOnly` que excluye `formaPago` por construcción, así que el medio
 * jamás podría persistirse desde ahí. Centralizarlo en la Function —que usa
 * Admin SDK— es lo que hace posible el feature sin tocar Rules.
 */
export function permiteCierreSinConfirmaciones(entrada: {
  nuevo: string
  traePayloadDeCobro: boolean
}): boolean {
  return entrada.nuevo === 'entregado' && !entrada.traePayloadDeCobro
}

// ─── Lado UI (no existe en la copia de Functions) ─────────────────────────────

/**
 * Lo que el motorizado elige cuando no sabe con qué le pagaron.
 *
 * No se envía al servidor ni se persiste: existe para que el formulario
 * distinga "todavía no respondió" de "respondió que no sabe". Las dos acaban
 * igual —sin medio— pero la segunda es una respuesta deliberada, y la interfaz
 * necesita poder decir que la pregunta ya fue contestada.
 */
export const MEDIO_NO_SABE = 'no_sabe'

export type SeleccionMedio = MedioPago | typeof MEDIO_NO_SABE | ''

/** Opciones del selector, en orden. Ninguna viene preseleccionada. */
export const OPCIONES_MEDIO: readonly { value: MedioPago | typeof MEDIO_NO_SABE; label: string }[] = [
  { value: 'efectivo', label: 'Efectivo' },
  { value: 'transferencia', label: 'Transferencia' },
  { value: MEDIO_NO_SABE, label: 'No estoy seguro' },
]

/**
 * El medio que debe viajar en el payload, o `undefined` si no debe viajar.
 *
 * "No estoy seguro", vacío y cualquier valor desconocido devuelven
 * `undefined`: la clave se omite y el campo nunca llega a existir. Nunca se
 * sustituye por un valor por defecto — un medio inventado es peor que ninguno.
 */
export function medioParaPayload(seleccion: unknown): MedioPago | undefined {
  return esMedioPago(seleccion) ? seleccion : undefined
}

/** ¿La pregunta del medio ya fue contestada, sea con un valor o con "no sé"? */
export function medioRespondido(seleccion: unknown): boolean {
  return esMedioPago(seleccion) || seleccion === MEDIO_NO_SABE
}
