// FIN-1A — piezas comunes de condonarDeudaMotorizado y anularSaldoCargo (autoritativas, server-side).
//
// Las dos callables reciben SOLO { saldoId, motivo }. El actor y el rol salen de request.auth y de
// usuarios/{uid}; el saldo, el depósito, el ledger, los montos y los estados se RELEEN y se DEMUESTRAN
// dentro de la transacción. Nada de lo que decide el dinero viene del cliente.

import { HttpsError } from 'firebase-functions/v2/https';
import type { DocumentData } from 'firebase-admin/firestore';
import { centavos, esNumeroFinito } from './abono-directo';

export const MOTIVO_SALDO_MIN = 3;
export const MOTIVO_SALDO_MAX = 300;
const MAX_ID = 200;

export type MotivoRechazoSaldo =
  // condonar
  | 'saldo_no_condonable'
  | 'sin_saldo_pendiente'
  | 'conciliacion_requerida'
  // anular
  | 'usar_reversion_conversion'
  | 'usar_correccion_liquidacion'
  | 'ledger_no_demostrable'
  | 'ledger_inconsistente'
  | 'saldo_con_abonos'
  | 'saldo_pagado'
  | 'saldo_condonado'
  | 'saldo_no_anulable'
  // comunes
  | 'saldo_inconsistente'
  | 'conversion_inconsistente';

export function rechazoSaldo(motivo: MotivoRechazoSaldo, mensaje: string, extra: Record<string, unknown> = {}): HttpsError {
  return new HttpsError('failed-precondition', mensaje, { motivo, ...extra });
}

export function idValido(v: unknown): v is string {
  return typeof v === 'string' && v.trim().length > 0 && v.length <= MAX_ID;
}

/** Solo `saldoId` y `motivo`: ni monto, ni motorizado, ni depósito, ni estado, ni actor, ni rol. */
export function validarSaldoYMotivo(data: unknown): { saldoId: string; motivo: string } {
  if (typeof data !== 'object' || data === null || Array.isArray(data)) {
    throw new HttpsError('invalid-argument', 'Petición inválida.');
  }
  const d = data as Record<string, unknown>;
  if (Object.keys(d).some((k) => k !== 'saldoId' && k !== 'motivo')) {
    throw new HttpsError('invalid-argument', 'Solo se aceptan los campos saldoId y motivo.');
  }
  if (!idValido(d.saldoId)) throw new HttpsError('invalid-argument', 'saldoId inválido.');
  const motivo = typeof d.motivo === 'string' ? d.motivo.trim() : '';
  if (motivo.length < MOTIVO_SALDO_MIN || motivo.length > MOTIVO_SALDO_MAX) {
    throw new HttpsError('invalid-argument', `El motivo es obligatorio: entre ${MOTIVO_SALDO_MIN} y ${MOTIVO_SALDO_MAX} caracteres.`);
  }
  return { saldoId: d.saldoId.trim(), motivo };
}

/** Misma definición de "activo" que el ledger (y que FIN-4B): estado distinto de 'anulado'. */
export const estaVivo = (data: DocumentData): boolean => data.estado !== 'anulado';

/**
 * Suma de los abonos en centavos y si el saldo es coherente con el modelo vigente:
 * saldoPendiente == montoOriginal − Σ abonos (sin tolerancias nuevas).
 */
export function analizarSaldo(saldo: DocumentData): { ok: boolean; abonos: number; totalAbonado: number } {
  const lista: unknown[] = Array.isArray(saldo.abonos) ? saldo.abonos : [];
  const montos = lista.map((a) => (a as { monto?: unknown } | null)?.monto);
  if (!esNumeroFinito(saldo.montoOriginal) || !esNumeroFinito(saldo.saldoPendiente) || montos.some((m) => !esNumeroFinito(m))) {
    return { ok: false, abonos: lista.length, totalAbonado: 0 };
  }
  const totalAbonado = (montos as number[]).reduce((s, m) => s + centavos(m), 0);
  const ok = centavos(saldo.saldoPendiente as number) === centavos(saldo.montoOriginal as number) - totalAbonado && saldo.saldoPendiente >= 0;
  return { ok, abonos: lista.length, totalAbonado: totalAbonado / 100 };
}

export function tieneEvidenciaDeCondonacion(saldo: DocumentData): boolean {
  return saldo.condonadoAt != null || saldo.montoCondonado != null || saldo.movimientoCondonacionId != null;
}
