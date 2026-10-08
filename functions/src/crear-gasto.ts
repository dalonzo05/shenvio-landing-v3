// ═════════════════════════════════════════════════
// crearGastoMotorizado — FIN-1C-B: crear un gasto AUTORITATIVO e IDEMPOTENTE
// ═════════════════════════════════════════════════
//
// Antes: crearGastoMotorizado era un addDoc de CLIENTE + un registrarMovimiento que tragaba sus errores (un gasto podía quedar sin ledger).
// Las Rules dejaban a cualquier gestor/admin crear un gasto con monto, estado, actor y motorizado arbitrarios.
//
// Ahora una sola transacción, con { operacionId, motorizadoId, tipo, monto, fecha?, nota?, ordenId? } como única entrada y solo para admin o
// gestor activo: el motorizado debe existir; la orden (si viene) debe existir, estar entregada y ser de ESE motorizado y su snapshot lo arma
// el servidor; el gasto nace 'aprobado' (el ciclo de vida real) junto con su movimiento gasto_aprobado (efectivo_en_poder → gastos_operativos)
// y un marcador server-only operaciones_gasto/crear_<operacionId>. Idempotente: el retry idéntico responde 'ya_registrado' sin escribir.

import { HttpsError } from 'firebase-functions/v2/https';
import type { DocumentData } from 'firebase-admin/firestore';
import {
  TIPO_MOV_GASTO, cuentasGasto, exigirStaffFinanzas, huellaPayload, instanteDeFechaGasto, nombreMotorizado, rechazoOp, validarPeticionCrearGasto,
} from './finanzas-operativas-comun';

export type ResultadoCrearGasto = { ok: true; resultado: 'registrado' | 'ya_registrado'; operacionId: string; gastoId: string; movimientoId: string };

export interface TxCrearGasto {
  getUsuario(uid: string): Promise<DocumentData | null>;
  getMotorizado(id: string): Promise<DocumentData | null>;
  getOrden(id: string): Promise<DocumentData | null>;
  getOperacion(id: string): Promise<DocumentData | null>;
  crearGasto(id: string, campos: DocumentData): void;
  crearMovimiento(id: string, campos: DocumentData): void;
  crearOperacion(id: string, campos: DocumentData): void;
}

export interface DepsCrearGasto {
  transaction<T>(fn: (tx: TxCrearGasto) => Promise<T>): Promise<T>;
  serverTimestamp(): unknown;
  /** Un instante concreto como Timestamp del SDK. */
  aTimestamp(d: Date): unknown;
  ahora(): Date;
}

export const idOperacionGasto = (operacionId: string): string => `crear_${operacionId}`;
export const idGasto = (operacionId: string): string => `gasto_${operacionId}`;
export const idMovimientoGasto = (operacionId: string): string => `gasto_${operacionId}`;

/** Snapshot de la orden, derivado del servidor con las mismas claves que armaba la pantalla. */
export function snapshotDeOrden(ordenId: string, o: DocumentData): DocumentData {
  const owner = o.ownerSnapshot as { companyName?: unknown; nombre?: unknown } | undefined;
  const comercio = (typeof owner?.companyName === 'string' && owner.companyName) || (typeof owner?.nombre === 'string' && owner.nombre) || null;
  return {
    ordenId,
    comercioNombre: comercio,
    clienteNombre: o.entrega?.nombreApellido ?? null,
    entregadoAt: o.entregadoAt ?? null,
    tipoEnvio: o.tipoEnvio ?? null,
    metodoEnvio: o.metodoEnvio ?? null,
    puntoLogistico: o.puntoRetiroNombre ?? null,
    precioDelivery: o.confirmacion?.precioFinalCordobas ?? null,
  };
}

export async function crearGastoMotorizadoCore(deps: DepsCrearGasto, uid: string | undefined, data: unknown): Promise<ResultadoCrearGasto> {
  if (!uid) throw new HttpsError('unauthenticated', 'Debés iniciar sesión.');
  const p = validarPeticionCrearGasto(data);
  const ahora = deps.ahora();
  const instante = p.fecha ? instanteDeFechaGasto(p.fecha, ahora) : null;
  const huella = huellaPayload({ motorizadoId: p.motorizadoId, tipo: p.tipo, monto: p.monto, fecha: p.fecha, nota: p.nota, ordenId: p.ordenId });

  return deps.transaction(async (tx) => {
    // ── LECTURAS ──────────────────────────────────────────────────────────────
    const rol = exigirStaffFinanzas(await tx.getUsuario(uid));

    const op = await tx.getOperacion(idOperacionGasto(p.operacionId));
    if (op) {
      if (op.huella !== huella) throw rechazoOp('operacion_inconsistente', 'Esa operación ya se usó con otros datos.');
      return { ok: true as const, resultado: 'ya_registrado' as const, operacionId: p.operacionId, gastoId: String(op.gastoId), movimientoId: String(op.movimientoId) };
    }

    const moto = await tx.getMotorizado(p.motorizadoId);
    if (!moto) throw rechazoOp('motorizado_inexistente', 'El motorizado no existe.');

    let orden: DocumentData | null = null;
    if (p.ordenId) {
      orden = await tx.getOrden(p.ordenId);
      if (!orden || orden.estado !== 'entregado' || orden.asignacion?.motorizadoId !== p.motorizadoId) {
        throw rechazoOp('orden_invalida', 'La orden no existe, no está entregada o no es de este motorizado.', { solicitudId: p.ordenId });
      }
    }

    // ── ESCRITURAS ────────────────────────────────────────────────────────────
    const ts = deps.serverTimestamp();
    const gastoId = idGasto(p.operacionId);
    const movId = idMovimientoGasto(p.operacionId);
    const nombre = nombreMotorizado(moto, p.motorizadoId);
    const c = cuentasGasto(p.motorizadoId);

    tx.crearGasto(gastoId, {
      motorizadoId: p.motorizadoId,
      motorizadoNombre: nombre,
      tipo: p.tipo,
      monto: p.monto,
      estado: 'aprobado',
      nota: p.nota ?? '',
      ...(p.ordenId && orden ? { ordenId: p.ordenId, ordenSnapshot: snapshotDeOrden(p.ordenId, orden) } : {}),
      fecha: instante ? deps.aTimestamp(instante) : ts,
      creadoPorUid: uid,
      creadoPorRol: rol,
      createdAt: ts,
      operacionId: p.operacionId,
    });
    tx.crearMovimiento(movId, {
      tipo: TIPO_MOV_GASTO,
      monto: p.monto,
      at: ts,
      creadoPorUid: uid,
      creadoPorRol: rol,
      descripcion: `Gasto ${p.tipo} · ${nombre}`,
      estado: 'activo',
      motorizadoId: p.motorizadoId,
      gastoId,
      ...(p.ordenId ? { solicitudId: p.ordenId } : {}),
      cuentaOrigen: c.origen,
      cuentaDestino: c.destino,
      metadata: { operacionId: p.operacionId },
    });
    tx.crearOperacion(idOperacionGasto(p.operacionId), { tipo: 'crear_gasto', huella, gastoId, movimientoId: movId, actorUid: uid, actorRol: rol, at: ts });

    return { ok: true as const, resultado: 'registrado' as const, operacionId: p.operacionId, gastoId, movimientoId: movId };
  });
}
