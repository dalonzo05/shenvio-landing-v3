// VIAJE-RESPONDER-ASIGNACION-GUARD-1 — el cuerpo transaccional de
// `responderAsignacion`, separado de la callable para poder probarlo con una
// transacción inyectada, sin emulador.
//
// Es la MISMA lógica que vivía dentro de `runTransaction`, en el mismo orden, con
// un guard más: solo se responde una asignación de una solicitud que sigue en
// `asignada`. Antes se validaba la pertenencia al llamador y que la asignación
// estuviera `pendiente`, pero no el estado de la solicitud: una orden cancelada o
// cambiada por el gestor que conservara una asignación pendiente podía recibir
// después una aceptación o un rechazo (que la habría devuelto a `confirmada`).
//
// Orden de los guards, y por qué:
//   1. la solicitud existe
//   2. la asignación es de ESTE motorizado — antes que cualquier otra cosa, para
//      que un ajeno no aprenda nada del estado interno de una orden que no es suya
//   3. la solicitud sigue en `asignada`
//   4. la asignación sigue `pendiente` (impide doble respuesta)
//   5. recién ahí se escribe
//
// Ningún guard escribe: si cualquiera falla, la transacción termina sin mutar.
//
// VIAJE-RECHAZO-MOTORIZADO-TRAZA-1 — rechazar devuelve la solicitud a
// `confirmada` y borra la asignación, y con ella desaparecía todo rastro de QUIÉN
// rechazó y CUÁNDO. Ahora, en la MISMA transacción que la transición, se escribe:
//
//   · un evento append-only en solicitudes_envio/{id}/eventos/{eventoId}
//     (`tipo: 'rechazo_motorizado'`), la historia real: si A rechaza y después B
//     rechaza, quedan los dos;
//   · `ultimoRechazoMotorizado` en la solicitud, una proyección del más reciente
//     para que el listado lo muestre sin leer la subcolección por cada fila. No
//     reemplaza al evento: lo apunta por `eventoId`.
//
// La identidad sale de la asignación que se está borrando, en el instante del
// rechazo; no se vuelve a resolver después. No se guarda motivo: el motorizado
// no lo introduce y no se inventa uno. El evento lo escribe el servidor con
// `at` de servidor y `porUid` = el llamador autenticado; Rules niega toda
// escritura de cliente en esa subcolección.
//
// MOTO-STATS-ACEPTACION-TRAZA-1 — cada RESPUESTA a una oferta (aceptar o rechazar)
// queda registrada por el servidor, en esa misma transacción:
//
//   · un evento append-only por decisión (`aceptacion_motorizado` /
//     `rechazo_motorizado`, mismo formato);
//   · la proyección canónica `metricasAceptacion` en el documento del motorizado
//     (versión 2; `desde` = la primera decisión canónica; SIN backfill: no se
//     parte de los contadores legacy);
//   · el espejo LEGACY (totalAsignaciones, totalAceptadas, totalRechazos,
//     tasaAceptacion, tiempoPromedioAceptacion) con la MISMA fórmula que antes
//     calculaba el cliente, para no mover el ranking mientras no migre. No es la
//     fuente de la métrica canónica.
//
// Solo cuentan las decisiones explícitas: una oferta que expira, se cancela o se
// rebota sin respuesta no pasa por aquí y no cuenta. Una reoferta respondida es un
// episodio nuevo. El guard `pendiente` + la transacción impiden que un retry
// duplique evento o contadores. Cliente y motorizado ya no escriben ninguna
// métrica (Rules).
//
// ROLLOUT — quién escribe el ESPEJO LEGACY. El cliente anterior seguía acreditando el
// legacy por su cuenta después de la callable (registrarAceptacion / registrarRechazo).
// Si el servidor también lo escribiera, ese cliente lo duplicaría. Por eso el servidor
// escribe el espejo solo cuando el cliente declara el protocolo 2 (`protocolo: 2` en el
// payload: "yo no acredito nada, hazlo tú"); sin `protocolo` (cliente anterior, o una
// pestaña vieja abierta) asume que el cliente lo hará y NO lo escribe. En ambos casos
// el legacy avanza EXACTAMENTE una vez por decisión.
//
// El protocolo NUNCA controla lo canónico: el evento y `metricasAceptacion` se escriben
// siempre, con o sin `protocolo`. Un cliente que omita el campo solo se quita a sí
// mismo el espejo (que no es una fuente de verdad); no puede evitar el registro canónico.

import { HttpsError } from 'firebase-functions/v2/https';
import { FieldValue, type DocumentData } from 'firebase-admin/firestore';

export type AccionAsignacion = 'aceptar' | 'rechazar';

/** Único estado de la solicitud desde el que se puede responder la asignación. */
export const ESTADO_RESPONDIBLE = 'asignada';

/** Tipo del evento que deja un rechazo. Otros episodios usarán otros tipos. */
export const EVENTO_RECHAZO_MOTORIZADO = 'rechazo_motorizado';

/** Tipo del evento que deja una aceptación (mismo formato que el de rechazo). */
export const EVENTO_ACEPTACION_MOTORIZADO = 'aceptacion_motorizado';

/** Versión de la proyección canónica de aceptación. */
export const VERSION_METRICAS_ACEPTACION = 2;

/** Valor de `protocolo`: el cliente no acredita métricas; el servidor escribe también el espejo legacy. */
export const PROTOCOLO_METRICAS_SERVIDOR = 2;

/**
 * Lee el campo opcional `protocolo` del payload. Ausente → false (cliente anterior: él
 * acredita el legacy). Solo se acepta exactamente 2; cualquier otro valor es inválido.
 */
export function leerProtocoloRespuesta(data: Record<string, unknown>): boolean {
  if (!('protocolo' in data)) return false;
  if (data.protocolo !== PROTOCOLO_METRICAS_SERVIDOR) {
    throw new HttpsError('invalid-argument', 'protocolo inválido.');
  }
  return true;
}

/** Por qué no se acreditó la proyección a un motorizado (para diagnosticarlo en el log). */
export type MotivoMetricasOmitidas = 'sin_motorizado_id' | 'sin_documento' | 'authuid_distinto';

export interface ResultadoRespuesta {
  /** true si la proyección canónica se acreditó al documento del motorizado. */
  metricasAcreditadas: boolean;
  motivoOmision?: MotivoMetricasOmitidas;
}

export interface OpcionesRespuesta {
  /** Escribir también el espejo legacy (solo con `protocolo: 2`). Por defecto no. */
  espejoLegacy?: boolean;
}

/** Lo mínimo que se usa de la referencia a la solicitud. */
export interface RefSolicitud {
  id: string;
  collection(nombre: string): { doc(): { id: string } };
}

/** Lo mínimo que se usa de una transacción de Firestore. */
export interface TransaccionRespuesta {
  get(ref: unknown): Promise<{ exists: boolean; data(): DocumentData | undefined }>;
  update(ref: unknown, data: Record<string, unknown>): unknown;
  set(ref: unknown, data: Record<string, unknown>): unknown;
}

const texto = (v: unknown): string | null =>
  typeof v === 'string' && v.trim() !== '' ? v.trim() : null;

const contador = (v: unknown): number =>
  typeof v === 'number' && Number.isFinite(v) && v >= 0 ? v : 0;

/**
 * El evento de una decisión, a partir de la asignación vigente. Puro: el sello de
 * tiempo lo pone quien llama (`serverTimestamp()`). La identidad del actor sale de
 * la asignación y del llamador autenticado, nunca de un dato del cliente.
 */
function construirEvento(
  tipo: string,
  solicitudId: string,
  motorizadoUid: string,
  asignacion: DocumentData,
  ahora: unknown,
): Record<string, unknown> {
  return {
    tipo,
    at: ahora,
    solicitudId,
    porUid: motorizadoUid,
    motorizadoId: texto(asignacion.motorizadoId),
    motorizadoNombre: texto(asignacion.motorizadoNombre),
  };
}

/**
 * El evento y su resumen, a partir de la asignación que se va a borrar.
 * Puro: el sello de tiempo lo pone quien llama (`serverTimestamp()`).
 */
export function construirRechazo(
  solicitudId: string,
  motorizadoUid: string,
  asignacion: DocumentData,
  eventoId: string,
  ahora: unknown,
): { evento: Record<string, unknown>; resumen: Record<string, unknown> } {
  const evento = construirEvento(EVENTO_RECHAZO_MOTORIZADO, solicitudId, motorizadoUid, asignacion, ahora);
  return {
    evento,
    resumen: { eventoId, motorizadoId: evento.motorizadoId, motorizadoNombre: evento.motorizadoNombre, rechazadoAt: ahora },
  };
}

/** El evento de una aceptación. No hay resumen en la solicitud: la asignación aceptada ya vive ahí. */
export function construirAceptacion(
  solicitudId: string,
  motorizadoUid: string,
  asignacion: DocumentData,
  ahora: unknown,
): Record<string, unknown> {
  return construirEvento(EVENTO_ACEPTACION_MOTORIZADO, solicitudId, motorizadoUid, asignacion, ahora);
}

export interface MetricasAceptacion {
  version: number;
  /** Inicio de la telemetría canónica: la primera decisión registrada por el servidor. */
  desde: unknown;
  totalDecisiones: number;
  totalAceptadas: number;
  totalRechazadas: number;
  /** aceptadas / decisiones, escala 0–1. Con 0 decisiones no existe (no se escribe la proyección). */
  tasaAceptacion: number;
}

/**
 * La proyección canónica tras UNA decisión más. Parte de la proyección canónica
 * previa (versión 2) o de cero: nunca de los contadores legacy.
 */
export function proyectarMetricasAceptacion(
  previa: unknown,
  accion: AccionAsignacion,
  ahora: unknown,
): MetricasAceptacion {
  const p = typeof previa === 'object' && previa !== null ? (previa as Record<string, unknown>) : null;
  const vigente = p !== null && p.version === VERSION_METRICAS_ACEPTACION;
  const aceptadas = (vigente ? contador(p!.totalAceptadas) : 0) + (accion === 'aceptar' ? 1 : 0);
  const rechazadas = (vigente ? contador(p!.totalRechazadas) : 0) + (accion === 'rechazar' ? 1 : 0);
  const decisiones = aceptadas + rechazadas;
  return {
    version: VERSION_METRICAS_ACEPTACION,
    desde: vigente && p!.desde !== undefined && p!.desde !== null ? p!.desde : ahora,
    totalDecisiones: decisiones,
    totalAceptadas: aceptadas,
    totalRechazadas: rechazadas,
    tasaAceptacion: aceptadas / decisiones,
  };
}

/**
 * ESPEJO LEGACY. Los mismos campos y la MISMA fórmula que calculaba el cliente
 * (lib/motorizado-stats.ts), ahora desde el servidor: el ranking los sigue leyendo.
 * No son canónicos ni se usan para la proyección nueva.
 */
export function espejoLegacy(
  datos: DocumentData,
  accion: AccionAsignacion,
  asignadoAtMs: number | null,
  ahoraMs: number,
): Record<string, unknown> {
  const totalAsignaciones = contador(datos.totalAsignaciones) + 1;
  if (accion === 'aceptar') {
    const totalAceptadas = contador(datos.totalAceptadas) + 1;
    const cambios: Record<string, unknown> = {
      totalAceptadas,
      totalAsignaciones,
      tasaAceptacion: totalAceptadas / totalAsignaciones,
    };
    if (asignadoAtMs !== null) {
      const deltaSegs = (ahoraMs - asignadoAtMs) / 1000;
      const prevAvg = typeof datos.tiempoPromedioAceptacion === 'number' ? datos.tiempoPromedioAceptacion : deltaSegs;
      cambios.tiempoPromedioAceptacion = (prevAvg * (totalAceptadas - 1) + deltaSegs) / totalAceptadas;
    }
    return cambios;
  }
  const totalAceptadas = contador(datos.totalAceptadas);
  return {
    totalRechazos: contador(datos.totalRechazos) + 1,
    totalAsignaciones,
    tasaAceptacion: totalAceptadas / totalAsignaciones,
  };
}

const aMillis = (v: unknown): number | null => {
  if (typeof v === 'object' && v !== null && typeof (v as { toMillis?: unknown }).toMillis === 'function') {
    const ms = (v as { toMillis(): number }).toMillis();
    return Number.isFinite(ms) ? ms : null;
  }
  return null;
};

export async function responderAsignacionEnTransaccion(
  tx: TransaccionRespuesta,
  solicitudRef: RefSolicitud,
  motorizadoUid: string,
  accion: AccionAsignacion,
  /** Referencia al documento `motorizado/{id}` de la asignación, para su proyección de métricas. */
  refMotorizado: (motorizadoId: string) => unknown,
  opciones: OpcionesRespuesta = {},
  ahoraMs: number = Date.now(),
): Promise<ResultadoRespuesta> {
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
  // Solo una solicitud que sigue en `asignada` espera respuesta. Cualquier otro
  // estado —cancelada, confirmada, en curso, entregada…— significa que esta
  // asignación ya no es la vigente, aunque el mapa haya quedado en el documento.
  if (solicitud.estado !== ESTADO_RESPONDIBLE) {
    throw new HttpsError('failed-precondition', 'Esta solicitud ya no espera respuesta de asignación.');
  }
  // Transición permitida desde el estado actual: solo se puede aceptar o
  // rechazar una asignación que sigue 'pendiente'. Esto es lo que impide
  // una doble aceptación, un rechazo tardío después de ya haber aceptado,
  // o una respuesta duplicada por reintento/doble clic.
  if (asignacion.estadoAceptacion !== 'pendiente') {
    throw new HttpsError('failed-precondition', 'Esta asignación ya no está pendiente de respuesta.');
  }

  // Lectura del motorizado ANTES de cualquier escritura (una transacción lee primero).
  // Las métricas solo se acreditan al documento cuyo `authUid` es el del llamador: si
  // el vínculo no existe o no coincide, la decisión y su evento se registran igual
  // (el evento es la traza) y la proyección se omite en vez de acreditar a otro.
  const motorizadoId = texto(asignacion.motorizadoId);
  let refMoto: unknown = null;
  let datosMoto: DocumentData | null = null;
  let motivoOmision: MotivoMetricasOmitidas | undefined = motorizadoId === null ? 'sin_motorizado_id' : undefined;
  if (motorizadoId !== null) {
    refMoto = refMotorizado(motorizadoId);
    const motoSnap = await tx.get(refMoto);
    const d = motoSnap.exists ? motoSnap.data() ?? null : null;
    if (d === null) motivoOmision = 'sin_documento';
    else if (d.authUid !== motorizadoUid) motivoOmision = 'authuid_distinto';
    else datosMoto = d;
  }

  const ahora = FieldValue.serverTimestamp();
  const eventoRef = solicitudRef.collection('eventos').doc();

  if (accion === 'aceptar') {
    tx.update(solicitudRef, {
      'asignacion.estadoAceptacion': 'aceptada',
      'asignacion.aceptadoAt': FieldValue.serverTimestamp(),
      updatedAt: FieldValue.serverTimestamp(),
    });
    tx.set(eventoRef, construirAceptacion(solicitudRef.id, motorizadoUid, asignacion, ahora));
  } else {
    // Rechazar: mismo comportamiento que el cliente tenía — el mapa
    // completo se reemplaza por null (libera la orden) y el estado raíz
    // vuelve a 'confirmada'. La pertenencia ya se comprobó arriba: esta orden
    // estaba asignada a este motorizado antes de esta escritura, así que null
    // no borra la asignación de otro. Y antes de perderla, su identidad queda
    // en el evento: la transición y la traza son una sola escritura atómica.
    const { evento, resumen } = construirRechazo(solicitudRef.id, motorizadoUid, asignacion, eventoRef.id, ahora);
    tx.set(eventoRef, evento);
    tx.update(solicitudRef, {
      estado: 'confirmada',
      asignacion: null,
      ultimoRechazoMotorizado: resumen,
      updatedAt: ahora,
    });
  }

  if (refMoto !== null && datosMoto !== null) {
    tx.update(refMoto, {
      // Canónico: SIEMPRE, sin depender de lo que mande o haga el cliente.
      metricasAceptacion: proyectarMetricasAceptacion(datosMoto.metricasAceptacion, accion, ahora),
      // Legacy: solo si el cliente declaró el protocolo 2; si no, lo acredita el cliente anterior.
      ...(opciones.espejoLegacy === true ? espejoLegacy(datosMoto, accion, aMillis(asignacion.asignadoAt), ahoraMs) : {}),
      updatedAt: ahora,
    });
    return { metricasAcreditadas: true };
  }
  return { metricasAcreditadas: false, motivoOmision };
}
