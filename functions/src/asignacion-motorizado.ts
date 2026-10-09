import { HttpsError } from 'firebase-functions/v2/https';
import type { DocumentData } from 'firebase-admin/firestore';
import { baseComisionAprobada, resolverBaseConfirmacion, type MotivoBaseNoDemostrable } from './precio-orden';

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
  /** Solo en 'confirmar', y solo cuando el servidor no puede derivar la base: la base de la comisión SIN recargos que declara el gestor. */
  comisionBaseManualCordobas?: number;
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

// PRECIO-CONFIRMADO-ANTES-DE-OPERAR-1 — por qué no se puede cerrar la base de la comisión de esta orden.
const MSG_BASE_NO_DEMOSTRABLE: Record<MotivoBaseNoDemostrable, string> = {
  sin_precio_confirmado: 'Ingresá un precio final válido.',
  cotizacion_inconsistente: 'La cotización de la orden no coincide con la tarifa de su distancia. Revisala antes de confirmar el precio.',
  cotizacion_incompleta: 'La orden trae una cotización sin distancia que se pueda verificar. Revisala antes de confirmar el precio.',
  precio_incoherente: 'La base de la comisión no puede superar el precio final. Revisá el precio o la cotización.',
  base_comision_requerida: 'Ingresá la base de comisión (sin recargos) antes de confirmar.',
  base_manual_no_aplica: 'La base de comisión de esta orden la calcula el sistema: no se ingresa a mano.',
};
const falla = (motivo: MotivoBaseNoDemostrable) => new HttpsError('failed-precondition', MSG_BASE_NO_DEMOSTRABLE[motivo], { motivo });
const idValido = (v: unknown): v is string => typeof v === 'string' && v.trim() === v && v.length > 0 && v.length <= 200 && !v.includes('/');

export function leerPeticionAsignacion(data: unknown): PeticionAsignacion {
  if (!data || typeof data !== 'object' || Array.isArray(data)) throw new HttpsError('invalid-argument', 'Petición inválida.');
  const p = data as Record<string, unknown>;
  const claves = ['solicitudId', 'motorizadoId', 'operacion', 'superficie', 'estadoEsperado', 'updatedAtEsperado', 'precioEditado', 'precioFinal', 'comisionBaseManualCordobas'];
  if (Object.keys(p).some((k) => !claves.includes(k)) ||
      !idValido(p.solicitudId) || !(p.motorizadoId === null || idValido(p.motorizadoId)) ||
      !['sugerido', 'confirmar', 'reasignar'].includes(p.operacion as string) ||
      !['solicitudes', 'drawer', 'detalle', 'baseDatos'].includes(p.superficie as string) ||
      !estadosAbiertos.includes(p.estadoEsperado as string) ||
      !(p.updatedAtEsperado === null || (typeof p.updatedAtEsperado === 'number' && Number.isFinite(p.updatedAtEsperado))) ||
      typeof p.precioEditado !== 'boolean' ||
      ('precioFinal' in p && !precioValido(p.precioFinal)) ||
      // la base manual solo la declara quien CONFIRMA, y es un número finito > 0 (el resto de validaciones —<= precio final, si aplica— las hace el servidor con la orden)
      ('comisionBaseManualCordobas' in p && (p.operacion !== 'confirmar' || !precioValido(p.comisionBaseManualCordobas))) ||
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
    // Una orden solo queda ASIGNADA con el precio financieramente cerrado. 'sugerido' y 'reasignar' no fijan ni cambian el precio (el payload ni lo admite), así
    // que exigen que ya esté confirmado: antes un gestor podía pasar la orden a 'confirmada' sin precio y asignarla 'sugerido' (E2).
    if (p.operacion !== 'confirmar') {
      if (!precioValido(s.confirmacion?.precioFinalCordobas)) {
        throw new HttpsError('failed-precondition', 'Primero confirmá el precio final de la orden.', { motivo: 'precio_sin_confirmar' });
      }
      // ...y con su base de comisión cerrada (snapshot, o derivable): ni 'sugerido' ni 'reasignar' inventan una base; se confirma desde 'confirmar'.
      const cerrada = baseComisionAprobada(s);
      if (!cerrada.ok) throw falla(cerrada.motivo);
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
        // El servidor deja, junto al precio final, la BASE de la comisión (snapshot): derivada con la tarifa canónica, o la que declara el gestor (sin recargos)
        // cuando el servidor no puede derivarla. El precio final puede incluir recargos; la base no. Una cotización que no cuadra con la tarifa no se confirma, y la
        // base nunca supera el precio final: el desglose que escribió el cliente no es autoridad.
        const base = resolverBaseConfirmacion(s, p.precioFinal, p.comisionBaseManualCordobas);
        if (!base.ok) throw falla(base.motivo);
        patch.confirmacion = { precioFinalCordobas: p.precioFinal, comisionBaseCordobas: base.base, comisionBaseOrigen: base.origen, confirmadoPorUid: uid, confirmadoAt: ahora };
      } else if (p.precioFinal !== undefined) {
        throw new HttpsError('invalid-argument', 'Modificar el precio requiere edición explícita.');
      } else {
        // Precio ya confirmado y sin editar. Si la orden es anterior al snapshot y su base no es derivable, aquí se completa (conserva el resto de la confirmación);
        // si ya tiene snapshot o la base es derivable, no se toca y una base manual no aplica.
        const previa = baseComisionAprobada(s);
        const tieneSnapshot = s.confirmacion?.comisionBaseCordobas !== undefined && s.confirmacion?.comisionBaseCordobas !== null;
        if (p.comisionBaseManualCordobas !== undefined) {
          if (tieneSnapshot) throw falla('base_manual_no_aplica');
          const base = resolverBaseConfirmacion(s, s.confirmacion?.precioFinalCordobas, p.comisionBaseManualCordobas);
          if (!base.ok) throw falla(base.motivo);
          patch.confirmacion = { ...s.confirmacion, comisionBaseCordobas: base.base, comisionBaseOrigen: base.origen, comisionBaseActorUid: uid, comisionBaseAt: ahora };
        } else if (!previa.ok) {
          throw falla(previa.motivo);
        }
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
