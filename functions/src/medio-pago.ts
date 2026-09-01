// B2-PAGO-MEDIO — Con qué se pagó el delivery. Frontera autoritativa.
//
// `cobroDelivery.formaPago` es la ÚNICA fuente persistente del medio. Su
// ausencia significa "nadie lo registró" y se presenta como "No registrado" —
// nunca como impago.
//
// ── De dónde sale el efectivo ───────────────────────────────────────────────
//
// `quienPaga` no es un medio de pago, pero SÍ determina el flujo de cobro, y
// ahí está la diferencia. `recoleccion` y `entrega` son flujos de cobro
// FÍSICO: el motorizado va y recauda. `transferencia` y el crédito semanal son
// flujos distintos, y en ellos el motorizado ni siquiera ve la pregunta del
// cobro — `calcularDeposito()` pone `tieneDelivery = false` y el modal no se
// abre.
//
// Por eso, cuando el motorizado confirma que recibió el delivery, el sistema ya
// sabe dos cosas por construcción: que el flujo era físico, y que hay dinero
// contante que tendrá que depositar. Eso es evidencia de EFECTIVO, no una
// inferencia: es el mismo hecho que ya justifica exigirle el depósito.
//
// Lo que sigue estando PROHIBIDO es derivar el medio de `quienPaga` por sí
// solo, del receptor o del momento. La condición es la confirmación de
// recepción DENTRO de un flujo físico; sin ella no se escribe nada.
//
// ── De dónde sale la transferencia ──────────────────────────────────────────
//
// De ningún lado que este helper controle. Una transferencia solo existe
// cuando el gestor la confirma en Cobros contra un comprobante, y ese flujo ya
// escribe `formaPago: 'transferencia'` por su cuenta. Un motorizado que
// reporta "el cliente indicó que pagará por transferencia" está explicando por
// qué no hubo efectivo, no confirmando un pago: el cobro queda pendiente.
//
// PURO y SIN IMPORTS: el tsconfig de Functions declara `include: ["src"]` con
// `outDir: "lib"`, así que un import hacia afuera arrastraría el rootDir y
// cambiaría las rutas del artefacto de deploy.
//
// Sin cobertura de tests unitarios: el subproyecto no tiene runner y no se creó
// uno. Se verifica con su `tsc`, inspección focal y el E2E en staging.
// Deuda: PAGO-MEDIO-FUNCTIONS-SIN-TESTS.

/** Conjunto cerrado. Cualquier valor fuera de aquí no se persiste jamás. */
export const MEDIOS_PAGO = ['efectivo', 'transferencia'] as const;

export type MedioPago = (typeof MEDIOS_PAGO)[number];

/**
 * Estricto a propósito: sin `trim()`, sin normalizar mayúsculas y sin
 * sinónimos. `Efectivo` y `transferencia_deposito` son inválidos. Un enum que
 * acepta variantes deja de ser cerrado, y el filtro de Base de datos
 * —Efectivo / Transferencia / No registrado— se volvería ciego.
 */
export function esMedioPago(v: unknown): v is MedioPago {
  return typeof v === 'string' && (MEDIOS_PAGO as readonly string[]).includes(v);
}

/**
 * Qué `formaPago` debe quedar al cerrar `cobroDelivery`.
 *
 * Tres reglas, en este orden y sin ninguna otra fuente:
 *
 *   1. Si ya hay un `formaPago` válido persistido, se CONSERVA. Un cierre
 *      posterior nunca pisa lo que el gestor —o un cierre previo— fijó.
 *   2. Si el motorizado confirmó que recibió el delivery Y el flujo es físico
 *      (ni crédito ni `quienPaga === 'transferencia'`), es `efectivo`.
 *   3. En cualquier otro caso no se escribe el campo. Sin cobro confirmado no
 *      hay medio que afirmar, y la orden queda en "No registrado" hasta que
 *      alguien con evidencia —el gestor, con un comprobante— diga otra cosa.
 *
 * Las tres entradas del punto 2 son las que `construirCobroDelivery` ya
 * calcula para decidir el estado del cobro: no se añade ningún dato nuevo, se
 * lee el que había.
 */
export function resolverFormaPago(entrada: {
  formaPagoExistente?: unknown;
  motorizadoYaCobro: boolean;
  esCredito: boolean;
  esPorTransferencia: boolean;
}): MedioPago | null {
  if (esMedioPago(entrada.formaPagoExistente)) return entrada.formaPagoExistente;
  const flujoFisico = !entrada.esCredito && !entrada.esPorTransferencia;
  if (entrada.motorizadoYaCobro && flujoFisico) return 'efectivo';
  return null;
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
  nuevo: string;
  traePayloadDeCobro: boolean;
}): boolean {
  return entrada.nuevo === 'entregado' && !entrada.traePayloadDeCobro;
}
