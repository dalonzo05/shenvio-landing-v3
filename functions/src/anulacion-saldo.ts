// ═════════════════════════════════════════════════
// anularSaldoCargo — FIN-1A: anulación AUTORITATIVA, solo cuando el ledger es DEMOSTRABLE
// ═════════════════════════════════════════════════
//
// Antes de FIN-1A "anular" era un updateDoc ciego de cliente: { estado: 'anulado', nota: '' }. No leía
// nada, pisaba la nota del saldo, y anulaba un saldo con abonos o de un depósito convertido dejando su
// ledger vivo. Esta Function NO es esa escritura del lado servidor: valida la semántica del saldo.
//
//   · ya anulado            → 'ya_anulado', 0 escrituras (se resuelve PRIMERO).
//   · origen 'deposito' o con depositoId → usar_reversion_conversion (FIN-4B). No se toca nada.
//   · origen 'liquidacion' o con liquidacionId → usar_correccion_liquidacion. Ese saldo es parte indivisible
//     de marcarPagada y se cierra en FIN-1D; anular solo el saldo dejaría la liquidación incoherente.
//   · tipo 'adelanto' → ledger_no_demostrable: su movimiento no se enlaza al saldo y no se inventa un vínculo.
//   · ÚNICO caso económico soportado: origen 'manual', tipo ajuste_manual u otro, pendiente y virgen
//     (sin abonos, saldoPendiente == montoOriginal > 0), con EXACTAMENTE un movimiento activo
//     'saldo_creado' coherente (se busca por saldoId y tipo, no por id). Saldo y movimiento se anulan juntos.
//   · NO escribe nota: conserva la del saldo.

import { HttpsError } from 'firebase-functions/v2/https';
import type { DocumentData } from 'firebase-admin/firestore';
import { exigirGestorOAdmin } from './abono-directo';
import { analizarSaldo, estaVivo, idValido, rechazoSaldo, tieneEvidenciaDeCondonacion, validarSaldoYMotivo } from './saldo-acciones-comun';

export const TIPO_MOVIMIENTO_SALDO_CREADO = 'saldo_creado';
export const TIPOS_MANUALES_ANULABLES: readonly string[] = ['ajuste_manual', 'otro'];

export type ResultadoAnulacion = {
  ok: true;
  /** 'anulada': se anuló ahora. 'ya_anulado': ya estaba anulado; no se escribió nada. */
  resultado: 'anulada' | 'ya_anulado';
  saldoId: string;
  movimientoId: string | null;
};

export interface TxAnulacion {
  getUsuario(uid: string): Promise<DocumentData | null>;
  getSaldo(id: string): Promise<DocumentData | null>;
  /** TODOS los movimientos del ledger con saldoId == id (activos y anulados). */
  getMovimientosDeSaldo(saldoId: string): Promise<Array<{ id: string; data: DocumentData }>>;
  updateSaldo(id: string, campos: DocumentData): void;
  updateMovimiento(id: string, campos: DocumentData): void;
}

export interface DepsAnulacion {
  transaction<T>(fn: (tx: TxAnulacion) => Promise<T>): Promise<T>;
  serverTimestamp(): unknown;
}

export async function anularSaldoCargoCore(
  deps: DepsAnulacion,
  uid: string | undefined,
  data: unknown,
): Promise<ResultadoAnulacion> {
  if (!uid) throw new HttpsError('unauthenticated', 'Debés iniciar sesión.');
  const { saldoId, motivo } = validarSaldoYMotivo(data);

  return deps.transaction(async (tx) => {
    // ── LECTURAS ──────────────────────────────────────────────────────────────
    const rol = exigirGestorOAdmin(await tx.getUsuario(uid));
    const saldo = await tx.getSaldo(saldoId);
    if (!saldo) throw new HttpsError('not-found', 'El saldo no existe.');

    // ── Idempotencia: PRIMERO ─────────────────────────────────────────────────
    if (saldo.estado === 'anulado') {
      return { ok: true as const, resultado: 'ya_anulado' as const, saldoId, movimientoId: null };
    }

    // ── Los flujos que tienen dueño propio ────────────────────────────────────
    if (saldo.origen === 'deposito' || idValido(saldo.depositoId)) {
      throw rechazoSaldo('usar_reversion_conversion', 'Un saldo de depósito no se anula: se revierte la conversión (o se condona).', {});
    }
    if (saldo.origen === 'liquidacion' || idValido(saldo.liquidacionId)) {
      throw rechazoSaldo('usar_correccion_liquidacion', 'Un saldo generado por una liquidación se corrige desde la liquidación, no se anula aparte.', {});
    }
    if (saldo.tipo === 'adelanto') {
      throw rechazoSaldo('ledger_no_demostrable', 'Un adelanto legacy no tiene un movimiento enlazado al saldo: no se anula hasta conciliarlo.', {});
    }
    if (saldo.origen !== 'manual' || !TIPOS_MANUALES_ANULABLES.includes(String(saldo.tipo ?? ''))) {
      throw rechazoSaldo('saldo_no_anulable', 'Este saldo no se puede anular por esta vía.', { origen: String(saldo.origen ?? ''), tipo: String(saldo.tipo ?? '') });
    }

    // ── Estado y virginidad económica ─────────────────────────────────────────
    if (saldo.estado === 'condonado' || tieneEvidenciaDeCondonacion(saldo)) {
      throw rechazoSaldo('saldo_condonado', 'Un saldo condonado no se anula.', {});
    }
    if (saldo.estado === 'pagado') throw rechazoSaldo('saldo_pagado', 'Un saldo pagado no se anula.', {});
    if (saldo.estado === 'abonado_parcial') throw rechazoSaldo('saldo_con_abonos', 'El saldo tiene abonos: anularlo no los devuelve.', {});
    if (saldo.estado !== 'pendiente') {
      throw rechazoSaldo('saldo_inconsistente', `El saldo está en un estado desconocido ("${String(saldo.estado ?? '')}").`, {});
    }
    const a = analizarSaldo(saldo);
    if (!a.ok) throw rechazoSaldo('saldo_inconsistente', 'El saldo no es coherente (monto original, abonos y pendiente no cuadran).', {});
    if (a.abonos > 0 || saldo.saldoPendiente !== saldo.montoOriginal) {
      throw rechazoSaldo('saldo_con_abonos', 'El saldo tiene abonos o su pendiente cambió: anularlo no lo devuelve.', {});
    }
    if (!(saldo.saldoPendiente > 0)) throw rechazoSaldo('saldo_inconsistente', 'El saldo no tiene monto pendiente.', {});

    // ── Ledger: EXACTAMENTE un saldo_creado activo y nada más ─────────────────
    const movimientos = await tx.getMovimientosDeSaldo(saldoId);
    const activos = movimientos.filter((m) => estaVivo(m.data));
    const creados = activos.filter((m) => m.data.tipo === TIPO_MOVIMIENTO_SALDO_CREADO);
    if (creados.length === 0) {
      throw rechazoSaldo('ledger_no_demostrable', 'No hay un movimiento de creación activo que demuestre el ledger de este saldo: no se anula.', { activos: activos.length });
    }
    if (creados.length > 1 || activos.length !== 1) {
      throw rechazoSaldo('ledger_inconsistente', 'El saldo tiene más de un movimiento activo: hay que revisarlo, no se anula solo.', { activos: activos.length });
    }
    const mov = creados[0];
    if (mov.data.saldoId !== saldoId || mov.data.monto !== saldo.montoOriginal) {
      throw rechazoSaldo('ledger_inconsistente', 'El movimiento de creación no coincide con el saldo.', {});
    }

    // ── ESCRITURAS (todas dentro de esta transacción) ─────────────────────────
    const ahora = deps.serverTimestamp();
    tx.updateSaldo(saldoId, {
      estado: 'anulado',
      anuladoAt: ahora,
      anuladoPorUid: uid,
      anuladoPorRol: rol,
      motivoAnulacion: motivo,
      updatedAt: ahora,
    });
    tx.updateMovimiento(mov.id, {
      estado: 'anulado',
      anuladoAt: ahora,
      anuladoPorUid: uid,
      anuladoPorRol: rol,
      motivoAnulacion: motivo,
    });

    return { ok: true as const, resultado: 'anulada' as const, saldoId, movimientoId: mov.id };
  });
}
