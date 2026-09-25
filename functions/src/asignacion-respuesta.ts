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

import { HttpsError } from 'firebase-functions/v2/https';
import { FieldValue, type DocumentData } from 'firebase-admin/firestore';

export type AccionAsignacion = 'aceptar' | 'rechazar';

/** Único estado de la solicitud desde el que se puede responder la asignación. */
export const ESTADO_RESPONDIBLE = 'asignada';

/** Tipo del evento que deja un rechazo. Otros episodios usarán otros tipos. */
export const EVENTO_RECHAZO_MOTORIZADO = 'rechazo_motorizado';

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
  const motorizadoId = texto(asignacion.motorizadoId);
  const motorizadoNombre = texto(asignacion.motorizadoNombre);
  return {
    evento: {
      tipo: EVENTO_RECHAZO_MOTORIZADO,
      at: ahora,
      solicitudId,
      porUid: motorizadoUid,
      motorizadoId,
      motorizadoNombre,
    },
    resumen: { eventoId, motorizadoId, motorizadoNombre, rechazadoAt: ahora },
  };
}

export async function responderAsignacionEnTransaccion(
  tx: TransaccionRespuesta,
  solicitudRef: RefSolicitud,
  motorizadoUid: string,
  accion: AccionAsignacion,
): Promise<void> {
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

  if (accion === 'aceptar') {
    tx.update(solicitudRef, {
      'asignacion.estadoAceptacion': 'aceptada',
      'asignacion.aceptadoAt': FieldValue.serverTimestamp(),
      updatedAt: FieldValue.serverTimestamp(),
    });
  } else {
    // Rechazar: mismo comportamiento que el cliente tenía — el mapa
    // completo se reemplaza por null (libera la orden) y el estado raíz
    // vuelve a 'confirmada'. La pertenencia ya se comprobó arriba: esta orden
    // estaba asignada a este motorizado antes de esta escritura, así que null
    // no borra la asignación de otro. Y antes de perderla, su identidad queda
    // en el evento: la transición y la traza son una sola escritura atómica.
    const eventoRef = solicitudRef.collection('eventos').doc();
    const ahora = FieldValue.serverTimestamp();
    const { evento, resumen } = construirRechazo(solicitudRef.id, motorizadoUid, asignacion, eventoRef.id, ahora);
    tx.set(eventoRef, evento);
    tx.update(solicitudRef, {
      estado: 'confirmada',
      asignacion: null,
      ultimoRechazoMotorizado: resumen,
      updatedAt: ahora,
    });
  }
}
