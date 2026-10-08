// ═════════════════════════════════════════════════
// registrarAdelantoMotorizado / anularAdelantoMotorizado — FIN-1C-B: adelantos AUTORITATIVOS
// ═════════════════════════════════════════════════
//
// Un adelanto NO es una colección: es un movimiento del ledger tipo 'adelanto_motorizado' (caja_storkhub → deuda_motorizado:<id>) que la
// pantalla de Liquidaciones registraba y anulaba con escrituras de CLIENTE (el actor, el rol, el monto, las cuentas, el estado). Las Rules
// dejaban crear, editar, anular y hasta reactivar uno, también en una semana ya liquidada.
//
// Ahora, solo para admin o gestor activo y en una transacción:
//   · registrar: { operacionId, motorizadoId, monto, semanaKey, nota? }. El motorizado debe existir y NO puede haber una liquidación de ese
//     motorizado para esa semana —ni para la semana en que cae el movimiento, que es la que la liquidación suma—, sea cual sea su estado,
//     buscándola por su id determinista Y por consulta (liquidaciones legacy con id aleatorio). Crea EXACTAMENTE un movimiento con id
//     determinista y un marcador operaciones_adelanto/registrar_<operacionId>.
//   · anular: { adelantoId }. El movimiento debe ser un adelanto_motorizado, coherente (monto, motorizado, cuentas); si ya está anulado
//     responde 'ya_anulado' sin escribir; la semana no puede estar liquidada. Nunca se reactiva ni se borra.
// La liquidación hoy guarda solo el TOTAL de adelantos, no sus ids: FIN-1D debe guardar adelantosIds. Los adelantos modernos ya tienen
// identidad estable (movimiento con operacionId en metadata).

import { HttpsError } from 'firebase-functions/v2/https';
import type { DocumentData } from 'firebase-admin/firestore';
import { semanaKeyDeFecha } from './cobro-semanal';
import {
  TIPO_MOV_ADELANTO, cuentasAdelanto, exigirStaffFinanzas, huellaPayload, nombreMotorizado, rechazoOp, validarPeticionAnularAdelanto,
  validarPeticionRegistrarAdelanto,
} from './finanzas-operativas-comun';
import { esNumeroFinito } from './deposito-monto';

export interface LecturasLiquidacion {
  getLiquidacion(id: string): Promise<DocumentData | null>;
  /** Liquidaciones del motorizado por motorizadoId y por motorizadoUid (se unen sin duplicar). */
  getLiquidacionesDelMotorizado(motorizadoId: string, motorizadoUid: string | null): Promise<Array<{ id: string; data: DocumentData }>>;
}

/** ¿Hay una liquidación (pendiente o pagada: ambas son vigentes) del motorizado para alguna de esas semanas? Fallar cerrado. */
export async function liquidacionDeSemanas(
  tx: LecturasLiquidacion,
  motorizadoId: string,
  motorizadoUid: string | null,
  semanas: string[],
): Promise<{ id: string; semanaKey: string } | null> {
  const claves = [...new Set(semanas)];
  for (const s of claves) {
    const directa = await tx.getLiquidacion(`${motorizadoId}_${s}`);
    if (directa) return { id: `${motorizadoId}_${s}`, semanaKey: s };
  }
  const todas = await tx.getLiquidacionesDelMotorizado(motorizadoId, motorizadoUid);
  const hit = todas.find((l) => claves.includes(String(l.data.semanaKey ?? '')));
  return hit ? { id: hit.id, semanaKey: String(hit.data.semanaKey) } : null;
}

// ── Registrar ────────────────────────────────────────────────────────────────

export type ResultadoRegistrarAdelanto = { ok: true; resultado: 'registrado' | 'ya_registrado'; operacionId: string; adelantoId: string };

export interface TxRegistrarAdelanto extends LecturasLiquidacion {
  getUsuario(uid: string): Promise<DocumentData | null>;
  getMotorizado(id: string): Promise<DocumentData | null>;
  getOperacion(id: string): Promise<DocumentData | null>;
  crearMovimiento(id: string, campos: DocumentData): void;
  crearOperacion(id: string, campos: DocumentData): void;
}

export interface DepsRegistrarAdelanto {
  transaction<T>(fn: (tx: TxRegistrarAdelanto) => Promise<T>): Promise<T>;
  serverTimestamp(): unknown;
  ahora(): Date;
}

export const idOperacionAdelanto = (operacionId: string): string => `registrar_${operacionId}`;
export const idAdelanto = (operacionId: string): string => `adelanto_${operacionId}`;

export async function registrarAdelantoMotorizadoCore(deps: DepsRegistrarAdelanto, uid: string | undefined, data: unknown): Promise<ResultadoRegistrarAdelanto> {
  if (!uid) throw new HttpsError('unauthenticated', 'Debés iniciar sesión.');
  const p = validarPeticionRegistrarAdelanto(data);
  const huella = huellaPayload({ motorizadoId: p.motorizadoId, monto: p.monto, semanaKey: p.semanaKey, nota: p.nota });
  const semanaDeAhora = semanaKeyDeFecha(deps.ahora());

  return deps.transaction(async (tx) => {
    // ── LECTURAS ──────────────────────────────────────────────────────────────
    const rol = exigirStaffFinanzas(await tx.getUsuario(uid));

    const op = await tx.getOperacion(idOperacionAdelanto(p.operacionId));
    if (op) {
      if (op.huella !== huella) throw rechazoOp('operacion_inconsistente', 'Esa operación ya se usó con otros datos.');
      return { ok: true as const, resultado: 'ya_registrado' as const, operacionId: p.operacionId, adelantoId: String(op.adelantoId) };
    }

    const moto = await tx.getMotorizado(p.motorizadoId);
    if (!moto) throw rechazoOp('motorizado_inexistente', 'El motorizado no existe.');
    const uidMoto = typeof moto.authUid === 'string' && moto.authUid ? moto.authUid : null;

    const liq = await liquidacionDeSemanas(tx, p.motorizadoId, uidMoto, [p.semanaKey, semanaDeAhora]);
    if (liq) throw rechazoOp('semana_liquidada', 'Esa semana ya tiene una liquidación para este motorizado: no se registran adelantos.', { liquidacionId: liq.id, semanaKey: liq.semanaKey });

    // ── ESCRITURAS ────────────────────────────────────────────────────────────
    const ahora = deps.serverTimestamp();
    const nombre = nombreMotorizado(moto, p.motorizadoId);
    const c = cuentasAdelanto(p.motorizadoId);
    const id = idAdelanto(p.operacionId);
    tx.crearMovimiento(id, {
      tipo: TIPO_MOV_ADELANTO,
      monto: p.monto,
      at: ahora,
      creadoPorUid: uid,
      creadoPorRol: rol,
      descripcion: `Adelanto C$${p.monto} · ${nombre} · Sem ${p.semanaKey}`,
      estado: 'activo',
      motorizadoId: p.motorizadoId,
      semanaKey: p.semanaKey,
      cuentaOrigen: c.origen,
      cuentaDestino: c.destino,
      propietario: `motorizado:${p.motorizadoId}`,
      metadata: { operacionId: p.operacionId, nota: p.nota },
    });
    tx.crearOperacion(idOperacionAdelanto(p.operacionId), { tipo: 'registrar_adelanto', huella, adelantoId: id, actorUid: uid, actorRol: rol, at: ahora });
    return { ok: true as const, resultado: 'registrado' as const, operacionId: p.operacionId, adelantoId: id };
  });
}

// ── Anular ───────────────────────────────────────────────────────────────────

export type ResultadoAnularAdelanto = { ok: true; resultado: 'anulado' | 'ya_anulado'; adelantoId: string };

export interface TxAnularAdelanto extends LecturasLiquidacion {
  getUsuario(uid: string): Promise<DocumentData | null>;
  getMovimiento(id: string): Promise<DocumentData | null>;
  getMotorizado(id: string): Promise<DocumentData | null>;
  updateMovimiento(id: string, campos: DocumentData): void;
}

export interface DepsAnularAdelanto {
  transaction<T>(fn: (tx: TxAnularAdelanto) => Promise<T>): Promise<T>;
  serverTimestamp(): unknown;
}

export const MOTIVO_ANULACION_ADELANTO = 'Adelanto anulado por gestor';

const aFecha = (v: unknown): Date | null => {
  const f = v as { toDate?: () => Date } | null | undefined;
  return f && typeof f.toDate === 'function' ? f.toDate() : null;
};

export async function anularAdelantoMotorizadoCore(deps: DepsAnularAdelanto, uid: string | undefined, data: unknown): Promise<ResultadoAnularAdelanto> {
  if (!uid) throw new HttpsError('unauthenticated', 'Debés iniciar sesión.');
  const { adelantoId } = validarPeticionAnularAdelanto(data);

  return deps.transaction(async (tx) => {
    // ── LECTURAS ──────────────────────────────────────────────────────────────
    const rol = exigirStaffFinanzas(await tx.getUsuario(uid));
    const mov = await tx.getMovimiento(adelantoId);
    if (!mov) throw new HttpsError('not-found', 'El adelanto no existe.');
    if (mov.tipo !== TIPO_MOV_ADELANTO) throw rechazoOp('movimiento_invalido', 'El movimiento indicado no es un adelanto.', { adelantoId });
    if (mov.estado === 'anulado') return { ok: true as const, resultado: 'ya_anulado' as const, adelantoId };
    if (mov.estado !== 'activo') throw rechazoOp('conciliacion_requerida', 'El adelanto no está en un estado conocido. No se anula: hay que conciliarlo.', { adelantoId });

    // Contenido coherente: no basta con que el id exista.
    const motorizadoId = typeof mov.motorizadoId === 'string' ? mov.motorizadoId : '';
    const c = cuentasAdelanto(motorizadoId);
    const coherente = motorizadoId !== '' && esNumeroFinito(mov.monto) && mov.monto > 0
      && mov.cuentaOrigen === c.origen && mov.cuentaDestino === c.destino;
    if (!coherente) throw rechazoOp('conciliacion_requerida', 'El adelanto no es coherente (motorizado, monto o cuentas). No se anula: hay que conciliarlo.', { adelantoId });

    const moto = await tx.getMotorizado(motorizadoId);
    const uidMoto = moto && typeof moto.authUid === 'string' && moto.authUid ? moto.authUid : null;
    const semanas: string[] = [];
    if (typeof mov.semanaKey === 'string' && mov.semanaKey) semanas.push(mov.semanaKey);
    const at = aFecha(mov.at);
    if (at) semanas.push(semanaKeyDeFecha(at));
    if (semanas.length === 0) throw rechazoOp('conciliacion_requerida', 'No se puede determinar la semana del adelanto. No se anula: hay que conciliarlo.', { adelantoId });
    const liq = await liquidacionDeSemanas(tx, motorizadoId, uidMoto, semanas);
    if (liq) throw rechazoOp('semana_liquidada', 'La semana del adelanto ya tiene una liquidación: no se anula.', { adelantoId, liquidacionId: liq.id, semanaKey: liq.semanaKey });

    // ── ESCRITURAS ────────────────────────────────────────────────────────────
    const ahora = deps.serverTimestamp();
    tx.updateMovimiento(adelantoId, { estado: 'anulado', anuladoAt: ahora, anuladoPorUid: uid, anuladoPorRol: rol, motivoAnulacion: MOTIVO_ANULACION_ADELANTO });
    return { ok: true as const, resultado: 'anulado' as const, adelantoId };
  });
}
