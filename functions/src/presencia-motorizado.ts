// MOTO-RANKING-UBICACION-FRESCA-1 — presencia server-authoritative del motorizado.
//
// ControlPresencia.tsx escribía `estado` + `updatedAt` directo al documento. Para
// que el ranking pueda distinguir "esta ubicación es de la sesión de presencia
// actual" de "es de antes de desconectarse" hace falta un sello dedicado de la
// transición — `updatedAt` no sirve: lo tocan otros escritores (ubicación
// operativa, edición del gestor, el espejo legacy de responderAsignacion). Esta
// callable es ahora quien pone ese sello (`presenciaUpdatedAt`), en la MISMA
// escritura que el estado.
//
// Mismo contrato que MOTO-DISPONIBILIDAD-CONTRATO-1 / MOTO-PRESENCIA-UX-1: solo
// dos destinos, `disponible` e `inactivo`. Nunca `ocupado` — eso sigue siendo un
// valor legacy que ningún flujo genera. No toca asignaciones, métricas de
// aceptación, ubicación operativa ni nada financiero.
//
// Mismo criterio de autorización que ya exigían las Rules para este campo
// (isMotorizadoRole(): usuarios/{uid}.rol === 'motorizado' && activo === true) y
// el mismo patrón de vínculo único que acceso-motorizado.ts (0 → permission-denied,
// >1 → failed-precondition): no se relaja ni se endurece nada.
//
// Núcleo puro + deps inyectadas (mismo patrón que acceso-motorizado.ts y
// asignacion-respuesta.ts): testable sin emulador.

import { HttpsError } from 'firebase-functions/v2/https';

export type PresenciaEscribible = 'disponible' | 'inactivo';

/** Único payload válido: `{ estado }`, con estado en los dos valores escribibles. */
export function leerPresenciaSolicitada(data: unknown): PresenciaEscribible {
  if (typeof data !== 'object' || data === null || Array.isArray(data)) {
    throw new HttpsError('invalid-argument', 'Payload inválido.');
  }
  const claves = Object.keys(data as Record<string, unknown>);
  if (claves.length !== 1 || !claves.includes('estado')) {
    throw new HttpsError('invalid-argument', 'Solo se acepta el campo estado.');
  }
  const estado = (data as Record<string, unknown>).estado;
  if (estado !== 'disponible' && estado !== 'inactivo') {
    throw new HttpsError('invalid-argument', "estado debe ser 'disponible' o 'inactivo'.");
  }
  return estado;
}

export interface PerfilUsuario {
  rol?: unknown;
  activo?: unknown;
}

export interface DepsPresencia {
  getUsuario(uid: string): Promise<PerfilUsuario | null>;
  /** ids de motorizado/{id} cuyo authUid es este uid. */
  motorizadosConAuthUid(uid: string): Promise<string[]>;
  actualizarPresencia(motorizadoId: string, estado: PresenciaEscribible, ahora: unknown): Promise<void>;
}

export interface ResultadoPresencia {
  ok: true;
  estado: PresenciaEscribible;
}

export async function actualizarPresenciaMotorizadoCore(
  deps: DepsPresencia,
  uid: string,
  data: unknown,
  ahora: unknown,
): Promise<ResultadoPresencia> {
  const estado = leerPresenciaSolicitada(data);

  // Mismo guard que responderAsignacion / mismo criterio que isMotorizadoRole() en Rules.
  const usuario = await deps.getUsuario(uid);
  if (!usuario || usuario.rol !== 'motorizado' || usuario.activo !== true) {
    throw new HttpsError('permission-denied', 'Solo un motorizado activo puede cambiar su presencia.');
  }

  // Exactamente un motorizado vinculado a este uid — mismo criterio que acceso-motorizado.ts.
  const ids = await deps.motorizadosConAuthUid(uid);
  if (ids.length === 0) {
    throw new HttpsError('permission-denied', 'Esta cuenta no está vinculada a ningún motorizado.');
  }
  if (ids.length > 1) {
    throw new HttpsError('failed-precondition', 'Esta cuenta está vinculada a más de un motorizado.');
  }

  await deps.actualizarPresencia(ids[0], estado, ahora);
  return { ok: true, estado };
}
