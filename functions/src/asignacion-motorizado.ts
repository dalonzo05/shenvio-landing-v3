import { HttpsError } from 'firebase-functions/v2/https';
import type { DocumentData } from 'firebase-admin/firestore';

type Documento = DocumentData;
export const MSG_NO_ELEGIBLE = 'El motorizado ya no está disponible para nuevas asignaciones.';

/** La carga nunca es una condición de elegibilidad. */
export function esElegibleParaNuevaAsignacion(m: Documento | null): boolean {
  return m !== null && m.activo === true && (m.estado === 'disponible' || m.estado === 'ocupado');
}

export interface PeticionAsignacion {
  solicitudId: string;
  motorizadoId: string | null;
  operacion: 'sugerido' | 'confirmar' | 'reasignar';
  superficie: 'solicitudes' | 'drawer' | 'detalle' | 'baseDatos';
  estadoEsperado: string;
  updatedAtEsperado: number | null;
  precioEditado: boolean;
  precioFinal?: number;
}

const estadosAbiertos = ['pendiente_confirmacion', 'confirmada', 'asignada', 'en_camino_retiro', 'retirado', 'en_camino_entrega'];

// MOTO-REASIGNACION-POST-RETIRO-GUARD-1 — 'confirmar' cubre la asignación
// INICIAL (la solicitud todavía no tiene un motorizado confirmado); una vez
// que ya lo tiene, cambiarlo es 'reasignar', nunca 'confirmar' otra vez. Antes
// 'confirmar' solo exigía estadosAbiertos, así que una solicitud 'retirado' o
// 'en_camino_entrega' podía volver a 'asignada' con un motorizado nuevo desde
// el mismo botón que arma el precio — moviendo la custodia (asignacion.
// motorizadoAuthUid, que storage.rules usa para autorizar evidencia) después
// de que el motorizado original YA tiene el paquete en la mano. Esta lista es
// la MISMA matriz que fija lib/estados-solicitud.test.ts del lado web
// (duplicada a propósito: Functions no puede importar lib/, ver ese archivo
// para el porqué) — cualquier cambio acá debe reflejarse allá.
const estadosAsignacionInicial = ['pendiente_confirmacion', 'confirmada'];

// 'reasignar' es la única vía para cambiar el motorizado de una solicitud que
// YA tiene uno. Solo antes del retiro físico: en_camino_retiro es "va camino
// a buscar el paquete", todavía sin custodia — reasignar ahí es indistinguible
// de una asignación inicial tardía. retirado en adelante, el motorizado
// original ya tiene el paquete: cambiar el destino de la asignación rompería
// esa custodia sin que el paquete se haya movido con ella.
const estadosReasignables = ['asignada', 'en_camino_retiro'];

const precioValido = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v) && v > 0;
const idValido = (v: unknown): v is string => typeof v === 'string' && v.trim() === v && v.length > 0 && v.length <= 200 && !v.includes('/');

export function leerPeticionAsignacion(data: unknown): PeticionAsignacion {
  if (!data || typeof data !== 'object' || Array.isArray(data)) throw new HttpsError('invalid-argument', 'Petición inválida.');
  const p = data as Record<string, unknown>;
  const claves = ['solicitudId', 'motorizadoId', 'operacion', 'superficie', 'estadoEsperado', 'updatedAtEsperado', 'precioEditado', 'precioFinal'];
  if (Object.keys(p).some((k) => !claves.includes(k)) ||
      !idValido(p.solicitudId) || !(p.motorizadoId === null || idValido(p.motorizadoId)) ||
      !['sugerido', 'confirmar', 'reasignar'].includes(p.operacion as string) ||
      !['solicitudes', 'drawer', 'detalle', 'baseDatos'].includes(p.superficie as string) ||
      !estadosAbiertos.includes(p.estadoEsperado as string) ||
      !(p.updatedAtEsperado === null || (typeof p.updatedAtEsperado === 'number' && Number.isFinite(p.updatedAtEsperado))) ||
      typeof p.precioEditado !== 'boolean' ||
      ('precioFinal' in p && !precioValido(p.precioFinal)) ||
      (p.operacion !== 'confirmar' && (p.motorizadoId === null || p.precioEditado || 'precioFinal' in p)) ||
      (p.precioEditado && !('precioFinal' in p))) {
    throw new HttpsError('invalid-argument', 'Petición de asignación inválida.');
  }
  return p as unknown as PeticionAsignacion;
}

export interface TransaccionAsignacion {
  getUsuario(uid: string): Promise<Documento | null>;
  getSolicitud(id: string): Promise<Documento | null>;
  getMotorizado(id: string): Promise<Documento | null>;
  updateSolicitud(id: string, patch: Documento): void;
}
export interface DepsAsignacion {
  transaction<T>(fn: (tx: TransaccionAsignacion) => Promise<T>): Promise<T>;
  serverTimestamp(): unknown;
  ahoraMs(): number;
}

/** Toda lectura de autoridad y la escritura pertenecen a la misma transacción. */
export async function asignarMotorizadoCore(deps: DepsAsignacion, uid: string | undefined, data: unknown): Promise<{ ok: true }> {
  if (!uid) throw new HttpsError('unauthenticated', 'Debés iniciar sesión.');
  const p = leerPeticionAsignacion(data);
  return deps.transaction(async (tx) => {
    const actor = await tx.getUsuario(uid);
    if (!actor || actor.activo !== true || !['admin', 'gestor'].includes(actor.rol)) {
      throw new HttpsError('permission-denied', 'Solo admin o gestor activo puede asignar.');
    }
    // Conserva el guard adicional de Base de datos, sin ampliar esa superficie.
    if (p.superficie === 'baseDatos' && actor.rol !== 'admin') throw new HttpsError('permission-denied', 'Solo admin puede operar Base de datos.');
    const s = await tx.getSolicitud(p.solicitudId);
    if (!s) throw new HttpsError('not-found', 'La solicitud no existe.');
    const version = typeof s.updatedAt?.toMillis === 'function' ? s.updatedAt.toMillis() : null;
    if (!estadosAbiertos.includes(s.estado) || s.estado !== p.estadoEsperado || version !== p.updatedAtEsperado ||
        (p.operacion === 'sugerido' && (s.estado !== 'confirmada' || s.asignacion != null))) {
      throw new HttpsError('failed-precondition', 'La solicitud cambió. Revisá sus datos antes de guardar.', { motivo: 'solicitud_cambio' });
    }
    // MOTO-REASIGNACION-POST-RETIRO-GUARD-1 — esto NO es staleness (arriba ya
    // se confirmó que s.estado === p.estadoEsperado, con la versión exacta que
    // el cliente tenía): es la solicitud en su estado REAL, evaluado dentro de
    // la misma transacción, y ese estado real ya no admite la operación
    // pedida. Motivo propio para no confundirlo con 'solicitud_cambio' (que
    // sí es "tu pantalla está desactualizada, refrescá y reintentá").
    if ((p.operacion === 'confirmar' && !estadosAsignacionInicial.includes(s.estado)) ||
        (p.operacion === 'reasignar' && !estadosReasignables.includes(s.estado))) {
      throw new HttpsError('failed-precondition', 'Esta orden ya avanzó y no permite reasignar el motorizado.', { motivo: 'solicitud_no_reasignable' });
    }
    const m = p.motorizadoId === null ? null : await tx.getMotorizado(p.motorizadoId);
    if (p.motorizadoId !== null && !esElegibleParaNuevaAsignacion(m)) {
      throw new HttpsError('failed-precondition', MSG_NO_ELEGIBLE, { motivo: 'motorizado_no_elegible' });
    }
    const ahora = deps.serverTimestamp();
    const patch: Documento = { estado: m ? 'asignada' : 'confirmada', updatedAt: ahora };
    if (p.operacion === 'confirmar') {
      const debeConfirmar = s.estado === 'pendiente_confirmacion' || !precioValido(s.confirmacion?.precioFinalCordobas) || p.precioEditado;
      if (debeConfirmar) {
        if (!precioValido(p.precioFinal)) throw new HttpsError('invalid-argument', 'Ingresá un precio final válido.');
        patch.confirmacion = { precioFinalCordobas: p.precioFinal, confirmadoPorUid: uid, confirmadoAt: ahora };
      } else if (p.precioFinal !== undefined) {
        throw new HttpsError('invalid-argument', 'Modificar el precio requiere edición explícita.');
      }
    }
    patch.asignacion = m ? {
      motorizadoId: p.motorizadoId,
      motorizadoAuthUid: ['solicitudes', 'detalle'].includes(p.superficie) ? (m.authUid || '').trim() : (m.authUid || ''),
      motorizadoNombre: m.nombre,
      motorizadoTelefono: m.telefono || '',
      ...(p.superficie !== 'solicitudes' ? { motorizadoFotoUrl: m.fotoUrl || null } : {}),
      asignadoPorUid: uid,
      asignadoAt: ahora,
      estadoAceptacion: 'pendiente',
      aceptadoAt: null,
      rechazadoAt: null,
      motivoRechazo: '',
      aceptarAntesDe: new Date(deps.ahoraMs() + 10 * 60 * 1000),
    } : null;
    tx.updateSolicitud(p.solicitudId, patch);
    return { ok: true };
  });
}
