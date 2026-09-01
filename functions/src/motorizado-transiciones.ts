// ═══════════════════════════════════════════════════════════════════════════
// responderAsignacion + confirmarTransicionConCobro — Callables (P1-FN-MOTO)
// ═══════════════════════════════════════════════════════════════════════════
//
// Migra a servidor las tres escrituras del motorizado que Firestore Rules no
// pudo terminar de cerrar por presupuesto de expresiones del motor (ver
// P1-RF): `asignacion` (aceptar/rechazar), `cobrosMotorizado` y
// `fueraManagua.efectivoRecibidoMotorizado`. Con estas dos callables en
// producción, firestore.rules le retira esas tres claves al motorizado por
// completo — Admin SDK no evalúa Rules, así que esta es ahora la ÚNICA
// puerta de entrada para esas escrituras, y tiene que replicar ella misma
// todo lo que antes hacían las Rules y el código cliente.
//
// ── Principio de mínima confianza en el cliente ─────────────────────────────
// El cliente nunca envía identidad (motorizadoAuthUid se toma de
// request.auth.uid), ni timestamps (siempre FieldValue.serverTimestamp()),
// ni el monto de cobrosMotorizado.delivery/producto — ese monto NUNCA lo
// edita el usuario en la UI real (app/panel/motorizado/page.tsx: se muestra
// como texto fijo, calculado por calcDeposito(), nunca como campo editable),
// así que se recalcula acá con la misma fórmula en vez de confiar en lo que
// mande el payload. Lo único genuinamente aportado por el usuario en estas
// dos funciones es: accion (aceptar/rechazar), recibio/justificacion por
// cobro, y cargotransCobro.monto (ese sí es un monto real que el motorizado
// cuenta en efectivo y reporta — no hay forma de derivarlo del documento).
//
// ── Atomicidad ───────────────────────────────────────────────────────────
// Todo lo que hoy se escribe en UN SOLO updateDoc() del cliente (estado,
// historial, cobrosMotorizado, cobroPendiente, pagoDelivery.quienPaga
// diferido, cobroDelivery y el marcador acumulacionCobroSemanal cuando la
// orden es de crédito) se escribe acá en UNA sola transacción — nunca "el
// cliente escribe una parte y la Function otra". La acumulación real en
// cobros_semanales sigue siendo una llamada aparte del cliente a la
// callable YA EXISTENTE acumularCobroSemanalPorOrden (P1 anterior, sin
// tocar) — eso nunca fue atómico con la entrega ni antes de este bloque
// (ver comentario original en cobro-semanal.ts), así que no es una
// regresión mantenerlo así.
//
// ── Lo que se preserva sin tocar ────────────────────────────────────────
// motorizado/{motorizadoDocId} (estado disponible/ocupado, stats de
// aceptación/rechazo, ubicación operativa) NUNCA fue atómico con
// solicitudes_envio ni siquiera en el código actual — aceptar()/rechazar()
// hacen esas escrituras en llamadas separadas, best-effort, después del
// updateDoc principal. Se dejan exactamente así, en el cliente, después de
// que estas callables confirman éxito.

import { onCall, HttpsError } from 'firebase-functions/v2/https';
import * as admin from 'firebase-admin';
import { FieldValue } from 'firebase-admin/firestore';
import { semanaKeyDeFecha } from './cobro-semanal';
import { resolverFormaPago, permiteCierreSinConfirmaciones } from './medio-pago';

const MAX_ID_LEN = 200;
const MAX_JUSTIFICACION_LEN = 500;

// ═══════════════════════════════════════════════════════════════════════════
// responderAsignacion
// ═══════════════════════════════════════════════════════════════════════════

type AccionAsignacion = 'aceptar' | 'rechazar';

interface ResponderAsignacionData {
  solicitudId?: unknown;
  accion?: unknown;
}

interface ResponderAsignacionResultado {
  ok: true;
  accion: AccionAsignacion;
}

async function usuarioMotorizadoActivo(
  db: admin.firestore.Firestore,
  uid: string,
): Promise<void> {
  const snap = await db.collection('usuarios').doc(uid).get();
  const usuario = snap.data();
  if (!snap.exists || usuario?.activo !== true || usuario?.rol !== 'motorizado') {
    throw new HttpsError('permission-denied', 'Solo un motorizado activo puede realizar esta operación.');
  }
}

function leerSolicitudId(data: Record<string, unknown>): string {
  const solicitudId = typeof data.solicitudId === 'string' ? data.solicitudId.trim() : '';
  if (!solicitudId || solicitudId.length > MAX_ID_LEN) {
    throw new HttpsError('invalid-argument', 'solicitudId inválido.');
  }
  return solicitudId;
}

export const responderAsignacion = onCall<ResponderAsignacionData>(async (request) => {
  const db = admin.firestore();

  // ── 1. Autenticado ────────────────────────────────────────────────────
  if (!request.auth) throw new HttpsError('unauthenticated', 'Debés iniciar sesión.');
  const motorizadoUid = request.auth.uid;

  // ── 2-4. Payload: exactamente { solicitudId, accion } ────────────────
  const data = request.data;
  if (typeof data !== 'object' || data === null || Array.isArray(data)) {
    throw new HttpsError('invalid-argument', 'Payload inválido.');
  }
  const claves = Object.keys(data);
  if (claves.length !== 2 || !claves.includes('solicitudId') || !claves.includes('accion')) {
    throw new HttpsError('invalid-argument', 'Solo se aceptan los campos solicitudId y accion.');
  }
  const solicitudId = leerSolicitudId(data as Record<string, unknown>);
  const accion = (data as Record<string, unknown>).accion;
  if (accion !== 'aceptar' && accion !== 'rechazar') {
    throw new HttpsError('invalid-argument', "accion debe ser 'aceptar' o 'rechazar'.");
  }

  // ── 5-7. Perfil activo con rol motorizado ────────────────────────────
  await usuarioMotorizadoActivo(db, motorizadoUid);

  const solicitudRef = db.collection('solicitudes_envio').doc(solicitudId);

  // ── 6-7 (auth) + 7 (transición): todo dentro de la transacción, para
  // que una reasignación concurrente o una doble respuesta no ganen la
  // carrera contra esta lectura. ──────────────────────────────────────
  await db.runTransaction(async (tx) => {
    const snap = await tx.get(solicitudRef);
    if (!snap.exists) throw new HttpsError('not-found', 'La solicitud no existe.');
    const solicitud = snap.data()!;
    const asignacion = solicitud.asignacion;

    if (
      typeof asignacion !== 'object' ||
      asignacion === null ||
      typeof asignacion.motorizadoAuthUid !== 'string' ||
      asignacion.motorizadoAuthUid !== motorizadoUid
    ) {
      throw new HttpsError('permission-denied', 'Esta orden no está asignada a vos.');
    }
    // Transición permitida desde el estado actual: solo se puede aceptar o
    // rechazar una asignación que sigue 'pendiente'. Esto es lo que impide
    // una doble aceptación, un rechazo tardío después de ya haber aceptado,
    // o una respuesta duplicada por reintento/doble clic.
    if (asignacion.estadoAceptacion !== 'pendiente') {
      throw new HttpsError('failed-precondition', 'Esta asignación ya no está pendiente de respuesta.');
    }

    if (accion === 'aceptar') {
      tx.update(solicitudRef, {
        'asignacion.estadoAceptacion': 'aceptada',
        'asignacion.aceptadoAt': FieldValue.serverTimestamp(),
        updatedAt: FieldValue.serverTimestamp(),
      });
    } else {
      // Rechazar: mismo comportamiento que el cliente tenía — el mapa
      // completo se reemplaza por null (libera la orden) y el estado raíz
      // vuelve a 'confirmada'. isAssignedMotorizado()-equivalente ya se
      // comprobó arriba: esta orden estaba asignada a este motorizado antes
      // de esta escritura, así que null no borra la asignación de otro.
      tx.update(solicitudRef, {
        estado: 'confirmada',
        asignacion: null,
        updatedAt: FieldValue.serverTimestamp(),
      });
    }
  });

  console.log(JSON.stringify({ fn: 'responderAsignacion', solicitudId, motorizadoUid, accion }));

  return { ok: true, accion } satisfies ResponderAsignacionResultado;
});

// ═══════════════════════════════════════════════════════════════════════════
// confirmarTransicionConCobro
// ═══════════════════════════════════════════════════════════════════════════

type NuevoEstadoTransicion = 'retirado' | 'entregado';

interface RespuestaCobroInput {
  recibio?: unknown;
  justificacion?: unknown;
}

interface CobrosInput {
  delivery?: unknown;
  producto?: unknown;
}

interface CargotransCobroInput {
  monto?: unknown;
}

interface ConfirmarTransicionData {
  solicitudId?: unknown;
  nuevo?: unknown;
  cobros?: unknown;
  cargotransCobro?: unknown;
}

interface ConfirmarTransicionResultado {
  ok: true;
  necesitaAcumularCobroSemanal: boolean;
}

interface RespuestaCobro {
  recibio: boolean;
  justificacion?: string;
}

/**
 * Valida y normaliza { recibio, justificacion? } — la MISMA forma que el
 * usuario realmente produce en la UI (botones Sí/No + <select> de razón,
 * "Otro" abre <textarea> libre). justificacion es texto libre real: no hay
 * un enum cerrado que se pueda exigir sin romper la opción "Otro" — se tipa
 * como string, sin restringir su contenido, y solo se exige CUÁNDO aparece
 * (obligatoria si recibio es false, prohibida si es true) — mismo gate que
 * ya aplicaba el botón "Confirmar" en el cliente (bloqueadoDelivery/
 * bloqueadoProducto).
 */
function validarRespuestaCobro(raw: unknown, etiqueta: string): RespuestaCobro {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    throw new HttpsError('invalid-argument', `${etiqueta} inválido.`);
  }
  const obj = raw as RespuestaCobroInput;
  const claves = Object.keys(obj);
  // B2-PAGO-MEDIO — el payload volvió a ser { recibio, justificacion }: el
  // motorizado no declara la forma de pago, así que `medio` deja de ser una
  // clave aceptada y este allowlist la rechaza como cualquier otra intrusa.
  if (!claves.every((k) => k === 'recibio' || k === 'justificacion')) {
    throw new HttpsError('invalid-argument', `${etiqueta} tiene campos no permitidos.`);
  }
  if (typeof obj.recibio !== 'boolean') {
    throw new HttpsError('invalid-argument', `${etiqueta}.recibio debe ser boolean.`);
  }
  if (!obj.recibio) {
    if (typeof obj.justificacion !== 'string' || !obj.justificacion.trim()) {
      throw new HttpsError('invalid-argument', `${etiqueta} requiere justificacion cuando recibio es false.`);
    }
    if (obj.justificacion.length > MAX_JUSTIFICACION_LEN) {
      throw new HttpsError('invalid-argument', `${etiqueta}.justificacion demasiado larga.`);
    }
    return { recibio: false, justificacion: obj.justificacion.trim() };
  }
  // != null (no !== undefined): el SDK cliente de Functions serializa una
  // propiedad de objeto con valor `undefined` como `null` en el payload —
  // no la omite (a diferencia de JSON.stringify en el nivel superior). El
  // cliente real siempre incluye la clave `justificacion` en el objeto,
  // con valor undefined cuando recibio es true — así que acá llega como
  // null, no como ausente. Medido contra la UI real, no solo el harness.
  if (obj.justificacion != null) {
    throw new HttpsError('invalid-argument', `${etiqueta} no debe incluir justificacion cuando recibio es true.`);
  }
  return { recibio: true };
}

function validarCargotransCobro(raw: unknown): { monto: number } {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    throw new HttpsError('invalid-argument', 'cargotransCobro inválido.');
  }
  const obj = raw as CargotransCobroInput;
  const claves = Object.keys(obj);
  if (claves.length !== 1 || claves[0] !== 'monto') {
    throw new HttpsError('invalid-argument', 'cargotransCobro solo acepta monto.');
  }
  if (typeof obj.monto !== 'number' || !Number.isFinite(obj.monto) || obj.monto < 0) {
    throw new HttpsError('invalid-argument', 'cargotransCobro.monto debe ser un número finito >= 0.');
  }
  return { monto: obj.monto };
}

// ── calcDeposito() server-side — MISMA fórmula que
// app/panel/motorizado/page.tsx (leída fresca antes de escribir este
// archivo). Solo se replican los 4 campos que este flujo necesita —
// deliveryPorTransferencia/totalAlComercio/totalAStorkhub/descripcion son
// exclusivos de la UI de depósitos y no participan de esta escritura. ──
interface DepositoInfo {
  tieneProducto: boolean;
  montoProducto: number;
  tieneDelivery: boolean;
  montoDelivery: number;
}

function calcDeposito(orden: FirebaseFirestore.DocumentData): DepositoInfo {
  const ceAplica = orden.cobroContraEntrega?.aplica === true;
  const montoProducto = ceAplica ? (orden.cobroContraEntrega?.monto || 0) : 0;
  const precioDelivery =
    orden.confirmacion?.precioFinalCordobas ||
    (orden.tipoServicio === 'fuera_managua' ? (orden.pagoDelivery?.montoSugerido || 0) : 0);
  const quienPaga = orden.pagoDelivery?.quienPaga || '';
  const esPorTransferencia = quienPaga === 'transferencia';
  const esCredito = orden.tipoCliente === 'credito' || quienPaga === 'credito_semanal';

  const deliveryNoRecibido =
    orden.cobrosMotorizado?.delivery?.recibio === false &&
    orden.cobrosMotorizado?.delivery?.justificacion !== 'Se acordó cobrar en la entrega';
  const productoNoRecibido = orden.cobrosMotorizado?.producto?.recibio === false;

  const motorizadoRecaudeDelivery = !esPorTransferencia && !esCredito && precioDelivery > 0 && !deliveryNoRecibido;
  const montoDelivery = motorizadoRecaudeDelivery ? precioDelivery : 0;

  return {
    tieneProducto: ceAplica && !productoNoRecibido,
    montoProducto,
    tieneDelivery: motorizadoRecaudeDelivery,
    montoDelivery,
  };
}

interface ShowFlags {
  showDelivery: boolean;
  showProducto: boolean;
  showCargotransCobro: boolean;
  deducirDelCE: boolean;
}

// ── Misma lógica que cambiar() en el cliente para decidir qué confirmación
// corresponde. Se recalcula acá para no confiar en lo que el cliente diga
// que "aplica" — si el cliente manda una confirmación que el estado real de
// la orden no pide, se rechaza (ver validación más abajo). ──────────────
function calcularShowFlags(
  orden: FirebaseFirestore.DocumentData,
  dep: DepositoInfo,
  nuevo: NuevoEstadoTransicion,
): ShowFlags {
  const quienPaga = orden.pagoDelivery?.quienPaga || '';
  const esFueraManagua = orden.tipoServicio === 'fuera_managua';
  const esRetiro = quienPaga === 'recoleccion' || esFueraManagua;
  const deducirDelCE = orden.pagoDelivery?.deducirDelCobroContraEntrega === true;

  const showDelivery =
    dep.tieneDelivery &&
    !deducirDelCE &&
    ((nuevo === 'retirado' && esRetiro) || (nuevo === 'entregado' && !esRetiro));
  const showProducto = nuevo === 'entregado' && dep.tieneProducto;
  const showCargotransCobro =
    nuevo === 'retirado' &&
    orden.tipoServicio === 'fuera_managua' &&
    orden.fueraManagua?.metodoEnvio === 'cargotrans' &&
    orden.fueraManagua?.pagoCargotrans === 'efectivo_motorizado';

  return { showDelivery, showProducto, showCargotransCobro, deducirDelCE };
}

/** cobroDelivery — misma fórmula que executeCambiar() en la transición a 'entregado'. */
function construirCobroDelivery(
  orden: FirebaseFirestore.DocumentData,
  deliveryAnswer: RespuestaCobro | null,
  productoAnswer: RespuestaCobro | null,
): Record<string, unknown> {
  const precioDelivery = orden.confirmacion?.precioFinalCordobas ?? 0;
  const quienPaga = orden.pagoDelivery?.quienPaga ?? '';
  const esCredito = orden.tipoCliente === 'credito' || quienPaga === 'credito_semanal';
  const esRecoleccion = quienPaga === 'recoleccion';
  const motorizadoYaCobro =
    deliveryAnswer?.recibio === true ||
    (esRecoleccion && orden.cobrosMotorizado?.delivery?.recibio === true);

  // ── B1.2: faltante parcial del delivery ──────────────────────────────────
  //
  // Cuando el delivery se deduce del cobro contra entrega, el motorizado no
  // recauda el delivery aparte: sale del mismo efectivo del producto. Si ese
  // efectivo no alcanza —o si declaró no haberlo recibido— el delivery queda
  // cubierto solo en parte, y la diferencia NO puede exigírsele: no la tiene.
  //
  // Este es el único momento en que el faltante es factualmente cierto y hay
  // una transacción abierta que ya escribe cobroDelivery. Se calcula acá para
  // que nazca atómico con la confirmación del dinero recibido, sin agregar un
  // segundo write ni un documento aparte (ver B1.2B, secciones 7-10).
  const deducir = orden.pagoDelivery?.deducirDelCobroContraEntrega === true;
  const ceAplica = orden.cobroContraEntrega?.aplica === true;
  const montoProducto = ceAplica ? (orden.cobroContraEntrega?.monto || 0) : 0;
  // Efectivo del CE realmente en manos del motorizado.
  const productoNoRecibido = productoAnswer
    ? productoAnswer.recibio === false
    : orden.cobrosMotorizado?.producto?.recibio === false;
  const productoDisponible = productoNoRecibido ? 0 : montoProducto;

  const aplicaFaltante = deducir && !esCredito && precioDelivery > 0;
  const cubiertoPorDeposito = aplicaFaltante
    ? Math.min(productoDisponible, precioDelivery)
    : 0;
  const faltanteDelivery = aplicaFaltante
    ? Math.max(0, precioDelivery - productoDisponible)
    : 0;

  const patch: Record<string, unknown> = {
    // `monto` es el PENDIENTE real de cobro, no el precio de lista: es lo que
    // leen Cobros y la vista del comercio. Sin deducción no cambia nada.
    monto: aplicaFaltante ? faltanteDelivery : precioDelivery,
    tipoCliente: esCredito ? 'credito' : 'contado',
    quienPaga,
    estado: precioDelivery === 0 ? 'no_cobrar' : esCredito ? 'pendiente' : motorizadoYaCobro ? 'pagado' : 'pendiente',
    registradoAt: FieldValue.serverTimestamp(),
  };

  if (aplicaFaltante) {
    // Trazabilidad: sin estos dos campos no habría forma de distinguir un
    // delivery de 30 de uno de 130 con 100 ya cubiertos.
    // Invariante: monto + cubiertoPorDeposito === montoDelivery.
    patch.montoDelivery = precioDelivery;
    patch.cubiertoPorDeposito = cubiertoPorDeposito;
    // Con deducción el motorizado nunca recauda el delivery aparte, así que
    // 'pagado' no aplica: o quedó cubierto por el CE (nada que cobrar) o
    // falta una parte. No se inventa una deuda de 0.
    patch.estado = faltanteDelivery > 0 ? 'pendiente' : 'pagado';
  }
  // semanaKey: se usa la fecha/hora del servidor en el momento de esta
  // llamada, igual que el cliente usaba `new Date()` — pero anclado a
  // America/Managua (semanaKeyDeFecha, ya usado por
  // acumularCobroSemanalPorOrden) en vez de la zona horaria del navegador.
  // Es un campo informativo del documento, no la clave de agrupación real
  // de cobros_semanales (esa la calcula acumularCobroSemanalPorOrden por su
  // cuenta a partir de entregadoAt) — anclarlo a Managua acá es una mejora
  // estricta, no un cambio de contrato.
  if (esCredito) {
    patch.semanaKey = semanaKeyDeFecha(new Date());
  }

  // ── B2-PAGO-MEDIO: con qué se pagó ───────────────────────────────────────
  //
  // El motorizado no declara la forma de pago; se deriva del flujo, que ya
  // está calculado arriba. `motorizadoYaCobro` solo puede ser true en un
  // cobro FÍSICO: con crédito o con quienPaga 'transferencia',
  // calcularDeposito() pone tieneDelivery = false y el modal del cobro ni
  // siquiera se abre. Confirmar que recibió en ese contexto es la misma
  // evidencia que ya obliga a depositar, así que afirma efectivo sin inferir.
  //
  // La transferencia NO se escribe acá: nace del comprobante que confirma el
  // gestor en Cobros. Un motivo del tipo "indicó que pagará por transferencia"
  // explica por qué no hubo efectivo — no confirma un pago.
  const formaPago = resolverFormaPago({
    formaPagoExistente: orden.cobroDelivery?.formaPago,
    motorizadoYaCobro,
    esCredito,
    esPorTransferencia: quienPaga === 'transferencia',
  });
  if (formaPago) patch.formaPago = formaPago;

  return patch;
}

export const confirmarTransicionConCobro = onCall<ConfirmarTransicionData>(async (request) => {
  const db = admin.firestore();

  // ── 1. Autenticado ────────────────────────────────────────────────────
  if (!request.auth) throw new HttpsError('unauthenticated', 'Debés iniciar sesión.');
  const motorizadoUid = request.auth.uid;

  // ── 2-4. Payload: allowlist estricto de claves en cada nivel ──────────
  const data = request.data;
  if (typeof data !== 'object' || data === null || Array.isArray(data)) {
    throw new HttpsError('invalid-argument', 'Payload inválido.');
  }
  const dataObj = data as ConfirmarTransicionData;
  const clavesRaiz = Object.keys(dataObj);
  if (!clavesRaiz.every((k) => k === 'solicitudId' || k === 'nuevo' || k === 'cobros' || k === 'cargotransCobro')) {
    throw new HttpsError('invalid-argument', 'Payload con campos no permitidos.');
  }
  const solicitudId = leerSolicitudId(dataObj as Record<string, unknown>);
  if (dataObj.nuevo !== 'retirado' && dataObj.nuevo !== 'entregado') {
    throw new HttpsError('invalid-argument', "nuevo debe ser 'retirado' o 'entregado'.");
  }
  const nuevo: NuevoEstadoTransicion = dataObj.nuevo;

  let cobrosInput: CobrosInput | null = null;
  if (dataObj.cobros !== undefined) {
    if (typeof dataObj.cobros !== 'object' || dataObj.cobros === null || Array.isArray(dataObj.cobros)) {
      throw new HttpsError('invalid-argument', 'cobros inválido.');
    }
    const clavesCobros = Object.keys(dataObj.cobros as Record<string, unknown>);
    if (!clavesCobros.every((k) => k === 'delivery' || k === 'producto')) {
      throw new HttpsError('invalid-argument', 'cobros tiene campos no permitidos.');
    }
    cobrosInput = dataObj.cobros as CobrosInput;
  }
  const cargotransCobroInput = dataObj.cargotransCobro !== undefined ? validarCargotransCobro(dataObj.cargotransCobro) : null;

  // ── 5-7. Perfil activo con rol motorizado ────────────────────────────
  await usuarioMotorizadoActivo(db, motorizadoUid);

  const solicitudRef = db.collection('solicitudes_envio').doc(solicitudId);

  let necesitaAcumularCobroSemanal = false;

  await db.runTransaction(async (tx) => {
    const snap = await tx.get(solicitudRef);
    if (!snap.exists) throw new HttpsError('not-found', 'La solicitud no existe.');
    const orden = snap.data()!;
    const asignacion = orden.asignacion;

    // ── 6. Asignado a quien llama ────────────────────────────────────
    if (
      typeof asignacion !== 'object' ||
      asignacion === null ||
      typeof asignacion.motorizadoAuthUid !== 'string' ||
      asignacion.motorizadoAuthUid !== motorizadoUid
    ) {
      throw new HttpsError('permission-denied', 'Esta orden no está asignada a vos.');
    }
    // ── 7. Transición permitida desde el estado actual — mismas
    // precondiciones que nextActions() en el cliente: 'retirado' solo desde
    // 'en_camino_retiro', 'entregado' solo desde 'en_camino_entrega'. ────
    const estadoRequerido = nuevo === 'retirado' ? 'en_camino_retiro' : 'en_camino_entrega';
    if (orden.estado !== estadoRequerido) {
      throw new HttpsError(
        'failed-precondition',
        `La orden tiene que estar en '${estadoRequerido}' para pasar a '${nuevo}' (está en '${orden.estado}').`,
      );
    }

    const dep = calcDeposito(orden);
    const { showDelivery, showProducto, showCargotransCobro, deducirDelCE } = calcularShowFlags(orden, dep, nuevo);

    if (!showDelivery && !showProducto && !showCargotransCobro) {
      // Fail-closed con UNA excepción estrecha (B2-PAGO-MEDIO).
      //
      // Antes: sin delivery, producto ni cargotrans no había nada legítimo que
      // escribir, porque el cierre de `cobroDelivery` lo hacía el cliente por
      // updateDoc directo. Ahora ese cierre vive acá, y por eso existe una
      // llamada legítima sin confirmaciones: entregar una orden cuyo cobro ya
      // se resolvió antes (típicamente cobrada en la recolección).
      //
      // Se centraliza porque las Rules solo permiten al motorizado escribir
      // `cobroDelivery` en su PRIMERA aparición y con un hasOnly que excluye
      // `formaPago` por construcción: desde el cliente el medio no podría
      // persistirse nunca. La Function usa Admin SDK, así que cierra sin tocar
      // Rules — y de paso desaparece la fórmula duplicada cliente/servidor.
      //
      // La excepción es estrecha a propósito: solo 'entregado' y solo sin
      // ningún payload de cobro. Con `cobros` o `cargotransCobro` presentes
      // sigue siendo un error, igual que cualquier otra transición.
      const traePayloadDeCobro = cobrosInput != null || cargotransCobroInput != null;
      if (!permiteCierreSinConfirmaciones({ nuevo, traePayloadDeCobro })) {
        throw new HttpsError('failed-precondition', 'Esta transición no requiere confirmación de cobro.');
      }
    }

    // ── Producto primero: la rama "delivery deducido del CE" necesita su
    // respuesta para espejar delivery. ──────────────────────────────────
    let productoAnswer: RespuestaCobro | null = null;
    if (showProducto) {
      if (!cobrosInput?.producto) {
        throw new HttpsError('invalid-argument', 'Falta la confirmación del producto.');
      }
      productoAnswer = validarRespuestaCobro(cobrosInput.producto, 'cobros.producto');
      // != null: el cliente real siempre incluye la clave `producto` en
      // `cobros` (con valor undefined cuando no aplica), y el SDK la
      // serializa como null, no la omite — ver nota en validarRespuestaCobro().
    } else if (cobrosInput?.producto != null) {
      throw new HttpsError('invalid-argument', 'No corresponde confirmar producto para esta orden.');
    }

    let deliveryAnswer: RespuestaCobro | null = null;
    // Mismo gate que `deducirPcConfirm && pc.showProducto && pc.montoDelivery > 0`
    // en el botón "Confirmar" del cliente: cuando el delivery se deduce del
    // cobro contra entrega, no se pregunta por separado — su respuesta
    // espeja la de producto.
    const deliveryDeducidoDelCE = !showDelivery && deducirDelCE && showProducto && dep.montoDelivery > 0;
    if (showDelivery) {
      if (!cobrosInput?.delivery) {
        throw new HttpsError('invalid-argument', 'Falta la confirmación del delivery.');
      }
      deliveryAnswer = validarRespuestaCobro(cobrosInput.delivery, 'cobros.delivery');
    } else if (deliveryDeducidoDelCE) {
      // El delivery va implícito en la respuesta del producto — el cliente
      // NO manda cobros.delivery en este caso (mismo comportamiento que
      // deliveryCobro en cambiar(): se deriva de recibioProducto/justProducto).
      if (cobrosInput?.delivery != null) {
        throw new HttpsError('invalid-argument', 'delivery va implícito en producto para esta orden — no lo envíes por separado.');
      }
      deliveryAnswer = productoAnswer;
    } else if (cobrosInput?.delivery != null) {
      throw new HttpsError('invalid-argument', 'No corresponde confirmar delivery para esta orden.');
    }

    let cargotransAnswer: { monto: number } | null = null;
    if (showCargotransCobro) {
      if (!cargotransCobroInput) {
        throw new HttpsError('invalid-argument', 'Falta cargotransCobro.');
      }
      cargotransAnswer = cargotransCobroInput;
    } else if (cargotransCobroInput) {
      throw new HttpsError('invalid-argument', 'No corresponde confirmar cargotransCobro para esta orden.');
    }

    // ── Construcción del patch — mismas claves por dot-path que
    // executeCambiar(), para no reemplazar submapas hermanos. ───────────
    const patch: FirebaseFirestore.UpdateData<FirebaseFirestore.DocumentData> = {
      estado: nuevo,
      updatedAt: FieldValue.serverTimestamp(),
      [`historial.${nuevo}At`]: FieldValue.serverTimestamp(),
    };
    if (nuevo === 'entregado') patch.entregadoAt = FieldValue.serverTimestamp();

    if (cargotransAnswer) {
      patch['fueraManagua.efectivoRecibidoMotorizado'] = cargotransAnswer.monto;
    }

    let hayPendiente = false;
    if (deliveryAnswer) {
      patch['cobrosMotorizado.delivery'] = {
        monto: dep.montoDelivery,
        recibio: deliveryAnswer.recibio,
        at: FieldValue.serverTimestamp(),
        ...(deliveryAnswer.justificacion ? { justificacion: deliveryAnswer.justificacion } : {}),
      };
      if (!deliveryAnswer.recibio) hayPendiente = true;
    }
    if (productoAnswer) {
      patch['cobrosMotorizado.producto'] = {
        monto: dep.montoProducto,
        recibio: productoAnswer.recibio,
        at: FieldValue.serverTimestamp(),
        ...(productoAnswer.justificacion ? { justificacion: productoAnswer.justificacion } : {}),
        // B1.2: mismo vocabulario que cobroDelivery.estado. Si lo cobró, el
        // producto queda saldado ('pagado'); si no, se debe ('pendiente') y
        // el gestor lo clasificará después con `resolucion`. No se crea una
        // incidencia ficticia cuando sí lo recibió.
        estado: productoAnswer.recibio ? 'pagado' : 'pendiente',
      };
      if (!productoAnswer.recibio) hayPendiente = true;
    }
    // cobroPendiente se escribe siempre que se procesó AL MENOS una
    // confirmación de cobro (delivery y/o producto) — mismo criterio que
    // `if (cobros !== undefined) p.cobroPendiente = hayPendiente` en el
    // cliente. Si esta transición fue puramente cargotrans (sin delivery ni
    // producto), no se toca — el cliente tampoco lo tocaba en ese caso
    // exacto porque cobros.delivery/producto quedaban undefined pero
    // igual cobros!==undefined... salvo que acá cobrosInput puede ser null
    // (cargotrans puro no manda cobros) y en ese caso preferimos NO pisar
    // cobroPendiente con un false que no corresponde a nada evaluado.
    if (deliveryAnswer || productoAnswer) {
      patch.cobroPendiente = hayPendiente;
    }

    // ── Delivery diferido a la entrega ───────────────────────────────
    if (deliveryAnswer?.justificacion === 'Se acordó cobrar en la entrega') {
      patch['pagoDelivery.quienPaga'] = 'entrega';
    }

    // ── Al entregar: cobroDelivery + marcador de crédito semanal ──────
    if (nuevo === 'entregado') {
      patch.cobroDelivery = construirCobroDelivery(orden, deliveryAnswer, productoAnswer);
      const precioDelivery = orden.confirmacion?.precioFinalCordobas ?? 0;
      const quienPagaOrig = orden.pagoDelivery?.quienPaga ?? '';
      const esCredito = orden.tipoCliente === 'credito' || quienPagaOrig === 'credito_semanal';
      if (esCredito && precioDelivery > 0) {
        patch['acumulacionCobroSemanal.estado'] = 'pendiente';
        patch['acumulacionCobroSemanal.updatedAt'] = FieldValue.serverTimestamp();
        necesitaAcumularCobroSemanal = true;
      }
    }

    tx.update(solicitudRef, patch);
  });

  console.log(
    JSON.stringify({
      fn: 'confirmarTransicionConCobro',
      solicitudId,
      motorizadoUid,
      nuevo,
      tieneCobros: !!cobrosInput,
      tieneCargotrans: !!cargotransCobroInput,
      necesitaAcumularCobroSemanal,
    }),
  );

  return { ok: true, necesitaAcumularCobroSemanal } satisfies ConfirmarTransicionResultado;
});
