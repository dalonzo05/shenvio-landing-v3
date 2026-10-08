// ═════════════════════════════════════════════════
// anularGastoMotorizado — FIN-1C-B: anular un gasto AUTORITATIVO (solo uno que de verdad se pueda anular)
// ═════════════════════════════════════════════════
//
// Antes: anularGastoMotorizado era un updateDoc de CLIENTE + un batch que anulaba "todos los movimientos con ese gastoId". Las Rules dejaban
// anular (o cambiar el monto de) un gasto ya DESCONTADO en un depósito: el depósito seguía diciendo que lo descontó y el gasto, anulado.
//
// Ahora, con { gastoId } como única entrada y solo para admin o gestor activo, en una transacción:
//   · ya anulado ⇒ 'ya_anulado' sin escribir (antes de los guards del resto).
//   · Un gasto descontado NO se anula: ni por la marca consumidoEnDepositoId ni —legacy, anterior a FIN-2, sin marca— porque un depósito vivo lo
//     liste en gastosIds (array-contains). Marca y depósito que se contradicen ⇒ conciliacion_requerida.
//   · Un gasto que una liquidación ya capturó (gastosIds, o liquidacionId en el gasto) NO se anula.
//   · Ledger: NO se anula "todo lo que tenga el gastoId". Exactamente UN gasto_aprobado activo y coherente ⇒ se anula. CERO movimientos de
//     cualquier tipo ⇒ gasto legacy (el writer viejo tragaba el error del ledger): se anula el gasto sin inventar un movimiento. Cualquier otra
//     cosa (varios activos, uno incoherente, solo anulados) ⇒ conciliacion_requerida.
//   · La marca consumidoEnDepositoId nunca se escribe aquí: su liberación es del flujo de depósitos (FIN-1B).

import { HttpsError } from 'firebase-functions/v2/https';
import type { DocumentData } from 'firebase-admin/firestore';
import { TIPO_MOV_GASTO, cuentasGasto, exigirStaffFinanzas, mismoMontoOp, rechazoOp, validarPeticionAnularGasto } from './finanzas-operativas-comun';

export type ResultadoAnularGasto = { ok: true; resultado: 'anulado' | 'ya_anulado'; gastoId: string; movimientoId: string | null };

export interface TxAnularGasto {
  getUsuario(uid: string): Promise<DocumentData | null>;
  getGasto(id: string): Promise<DocumentData | null>;
  getDeposito(id: string): Promise<DocumentData | null>;
  /** Depósitos cuyo gastosIds contiene el gasto (array-contains). */
  getDepositosConGasto(gastoId: string): Promise<Array<{ id: string; data: DocumentData }>>;
  /** Liquidaciones cuyo gastosIds contiene el gasto (array-contains). */
  getLiquidacionesConGasto(gastoId: string): Promise<Array<{ id: string; data: DocumentData }>>;
  /** TODOS los movimientos del ledger con gastoId == id (activos y anulados). */
  getMovimientosDeGasto(gastoId: string): Promise<Array<{ id: string; data: DocumentData }>>;
  updateGasto(id: string, campos: DocumentData): void;
  updateMovimiento(id: string, campos: DocumentData): void;
}

export interface DepsAnularGasto {
  transaction<T>(fn: (tx: TxAnularGasto) => Promise<T>): Promise<T>;
  serverTimestamp(): unknown;
}

export const MOTIVO_ANULACION_GASTO = 'Gasto operativo anulado';
const depositoVivo = (d: DocumentData): boolean => !['anulado', 'rechazado'].includes(String(d.estado ?? ''));

export async function anularGastoMotorizadoCore(deps: DepsAnularGasto, uid: string | undefined, data: unknown): Promise<ResultadoAnularGasto> {
  if (!uid) throw new HttpsError('unauthenticated', 'Debés iniciar sesión.');
  const { gastoId } = validarPeticionAnularGasto(data);

  return deps.transaction(async (tx) => {
    // ── LECTURAS ──────────────────────────────────────────────────────────────
    const rol = exigirStaffFinanzas(await tx.getUsuario(uid));
    const gasto = await tx.getGasto(gastoId);
    if (!gasto) throw new HttpsError('not-found', 'El gasto no existe.');
    const movs = await tx.getMovimientosDeGasto(gastoId);
    if (gasto.estado === 'anulado') {
      const m = movs.find((x) => x.data.tipo === TIPO_MOV_GASTO && x.data.estado === 'anulado');
      return { ok: true as const, resultado: 'ya_anulado' as const, gastoId, movimientoId: m ? m.id : null };
    }
    if (gasto.estado !== 'aprobado') throw rechazoOp('conciliacion_requerida', 'El gasto no está en un estado conocido. No se anula: hay que conciliarlo.', { gastoId });

    // Liquidación: un gasto que una liquidación capturó no se anula (la corrección económica es otra operación).
    const liqs = await tx.getLiquidacionesConGasto(gastoId);
    if (liqs.length > 0 || (gasto.liquidacionId !== undefined && gasto.liquidacionId !== null && gasto.liquidacionId !== '')) {
      throw rechazoOp('gasto_liquidado', 'El gasto ya figura en una liquidación: no se anula. La corrección económica se hace aparte.', { gastoId });
    }

    // Depósito: dos evidencias (la marca FIN-2 y, para lo anterior a FIN-2, gastosIds).
    const marca = typeof gasto.consumidoEnDepositoId === 'string' && gasto.consumidoEnDepositoId ? gasto.consumidoEnDepositoId : null;
    const deps_ = await tx.getDepositosConGasto(gastoId);
    const vivos = deps_.filter((d) => depositoVivo(d.data));
    if (marca) {
      const dm = await tx.getDeposito(marca);
      const listaEseGasto = !!dm && Array.isArray(dm.gastosIds) && (dm.gastosIds as unknown[]).includes(gastoId);
      if (!dm || !listaEseGasto) throw rechazoOp('conciliacion_requerida', 'La marca de consumo del gasto apunta a un depósito que no lo lista. No se anula: hay que conciliarlo.', { gastoId });
      if (!depositoVivo(dm)) throw rechazoOp('conciliacion_requerida', 'La marca de consumo apunta a un depósito anulado o rechazado que no liberó el gasto. No se anula: hay que conciliarlo.', { gastoId });
      if (vivos.some((d) => d.id !== marca)) throw rechazoOp('conciliacion_requerida', 'El gasto figura en más de un depósito vivo. No se anula: hay que conciliarlo.', { gastoId });
      throw rechazoOp('gasto_consumido', 'El gasto ya se descontó en un depósito: no se anula. Si el depósito está mal, se corrige el depósito.', { gastoId, depositoId: marca });
    }
    if (vivos.length > 0) {
      throw rechazoOp('gasto_consumido', 'El gasto figura en un depósito (sin marca de consumo: depósito anterior a FIN-2): no se anula.', { gastoId, depositoId: vivos[0].id });
    }

    // Ledger: exactamente un gasto_aprobado activo y coherente, o ningún movimiento (gasto legacy).
    let movimientoId: string | null = null;
    if (movs.length > 0) {
      const activos = movs.filter((m) => m.data.estado !== 'anulado');
      if (activos.length !== 1) throw rechazoOp('conciliacion_requerida', 'El ledger del gasto no es coherente (cero o varios movimientos activos). No se anula: hay que conciliarlo.', { gastoId, activos: activos.length });
      const m = activos[0];
      const c = cuentasGasto(String(gasto.motorizadoId ?? ''));
      const coherente = m.data.tipo === TIPO_MOV_GASTO
        && mismoMontoOp(m.data.monto, gasto.monto)
        && m.data.motorizadoId === gasto.motorizadoId
        && m.data.cuentaOrigen === c.origen
        && m.data.cuentaDestino === c.destino;
      if (!coherente) throw rechazoOp('conciliacion_requerida', 'El movimiento del gasto no coincide con el gasto (tipo, monto, motorizado o cuentas). No se anula: hay que conciliarlo.', { gastoId });
      movimientoId = m.id;
    }

    // ── ESCRITURAS ────────────────────────────────────────────────────────────
    const ahora = deps.serverTimestamp();
    tx.updateGasto(gastoId, { estado: 'anulado', updatedAt: ahora, anuladoAt: ahora, anuladoPorUid: uid, anuladoPorRol: rol });
    if (movimientoId) {
      tx.updateMovimiento(movimientoId, { estado: 'anulado', anuladoAt: ahora, anuladoPorUid: uid, anuladoPorRol: rol, motivoAnulacion: MOTIVO_ANULACION_GASTO });
    }
    return { ok: true as const, resultado: 'anulado' as const, gastoId, movimientoId };
  });
}
