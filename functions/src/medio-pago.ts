// B2-PAGO-MEDIO — Con qué se pagó el delivery. Contrato del lado Functions.
//
// ⚠️ ESTA ES LA FRONTERA AUTORITATIVA. Todo lo que decide qué se persiste
// vive acá y solo acá: la validación del payload, la resolución de
// `formaPago`, el consumo del temporal y el guard del cierre. `lib/medio-pago.ts`
// NO replica nada de esto — solo transmite lo que el motorizado eligió. Lo
// único duplicado entre app y Functions son los dos literales del enum, a
// propósito, para no cruzar un import entre subproyectos: uno arrastraría
// `functions/src` al compilado raíz de tests y ataría el gate de la app al
// artefacto de otro proyecto. Ver deuda PAGO-MEDIO-ENUM-ESPEJADO.
//
// Sin cobertura de tests unitarios: el subproyecto no tiene runner y no se creó
// uno en este bloque. Se verifica con su `tsc`, inspección focal y el E2E en
// staging tras el deploy — deuda PAGO-MEDIO-FUNCTIONS-SIN-TESTS.
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
// PURO y SIN IMPORTS a propósito: ni hacia `../../lib` ni hacia ningún otro
// sitio. El tsconfig de Functions declara `include: ["src"]` con
// `outDir: "lib"`, así que cualquier import hacia afuera arrastraría el
// rootDir inferido hasta la raíz del repo y cambiaría las rutas del artefacto
// de deploy.

/** Conjunto cerrado. Cualquier valor fuera de aquí no se persiste jamás. */
export const MEDIOS_PAGO = ['efectivo', 'transferencia'] as const;

export type MedioPago = (typeof MEDIOS_PAGO)[number];

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
  return typeof v === 'string' && (MEDIOS_PAGO as readonly string[]).includes(v);
}

/**
 * Qué `formaPago` debe quedar al cerrar `cobroDelivery`, y si el medio
 * temporal ya se consumió.
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
export interface ResolucionFormaPago {
  /** Valor a persistir, o null si no debe escribirse el campo. */
  formaPago: MedioPago | null;
  /** true cuando el valor salió del temporal de la recolección. */
  consumeTemporal: boolean;
}

export function resolverFormaPago(entrada: {
  formaPagoExistente?: unknown;
  medioDeEstaLlamada?: unknown;
  medioTemporal?: unknown;
}): ResolucionFormaPago {
  if (esMedioPago(entrada.formaPagoExistente)) {
    return { formaPago: entrada.formaPagoExistente, consumeTemporal: false };
  }
  if (esMedioPago(entrada.medioDeEstaLlamada)) {
    return { formaPago: entrada.medioDeEstaLlamada, consumeTemporal: false };
  }
  if (esMedioPago(entrada.medioTemporal)) {
    return { formaPago: entrada.medioTemporal, consumeTemporal: true };
  }
  return { formaPago: null, consumeTemporal: false };
}

/**
 * ¿Hay que borrar `cobrosMotorizado.delivery.medio` por dot-path en este
 * cierre?
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
  reescribeMapaDelivery: boolean;
  temporalPresente: boolean;
}): boolean {
  return entrada.temporalPresente && !entrada.reescribeMapaDelivery;
}

// ─── Reglas puras del payload y del cierre ───────────────────────────────────
//
// Viven acá, separadas del `onCall`, para que puedan probarse sin levantar
// firebase-functions. La callable se limita a traducir su veredicto a
// HttpsError.

export type VeredictoMedio =
  | 'ausente'
  | 'valido'
  | 'invalido'
  | 'no_permitido_en_producto';

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
  medio: unknown;
  esProducto: boolean;
}): VeredictoMedio {
  const ausente = entrada.medio === undefined || entrada.medio === null;
  if (entrada.esProducto) return ausente ? 'ausente' : 'no_permitido_en_producto';
  if (ausente) return 'ausente';
  return esMedioPago(entrada.medio) ? 'valido' : 'invalido';
}

/**
 * ¿Se admite una llamada que no trae ninguna confirmación de cobro?
 *
 * El guard general de la callable es fail-closed: sin delivery, producto ni
 * cargotrans no hay nada legítimo que escribir. Se abre UNA excepción estrecha:
 * el cierre de `cobroDelivery` al entregar.
 *
 * Existe porque el cierre dejó de hacerlo el cliente. Las Rules solo le
 * permiten al motorizado escribir `cobroDelivery` en su primera aparición y
 * con un `hasOnly` que excluye `formaPago` por construcción, así que el medio
 * jamás podría persistirse desde ahí. Centralizarlo en la Function —que usa
 * Admin SDK— es lo que hace posible el feature sin tocar Rules, y de paso
 * elimina la fórmula duplicada entre cliente y servidor.
 *
 * La excepción es estrecha a propósito: solo 'entregado', y solo si no viene
 * ningún payload de cobro. Una llamada con `cobros` sigue siendo rechazada por
 * el guard normal, igual que cualquier otra transición sin confirmaciones.
 */
export function permiteCierreSinConfirmaciones(entrada: {
  nuevo: string;
  traePayloadDeCobro: boolean;
}): boolean {
  return entrada.nuevo === 'entregado' && !entrada.traePayloadDeCobro;
}
