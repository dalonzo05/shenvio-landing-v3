// ═════════════════════════════════════════════════
// deposito-monto — la autoridad del MONTO de un depósito A/B (FIN-3 + FIN-4A)
// ═════════════════════════════════════════════════
//
// Confirmar un depósito (FIN-3) y convertirlo en deuda (FIN-4A) tienen que
// demostrar LO MISMO antes de escribir nada: que las órdenes existen, están
// entregadas, son del motorizado y no pertenecen a otro depósito; que los gastos
// (FIN-2) siguen reservados por ESTE depósito; y que el monto guardado coincide
// con el que salen esas órdenes y esos gastos.
//
// Vivía dentro de confirmacion-deposito.ts. Se extrae aquí SIN cambiar una sola
// condición ni el orden de los chequeos, para que las dos operaciones dependan de
// la misma demostración y no de dos copias que se desalinean. La fórmula del
// bruto sigue siendo calculo-deposito.ts (copia fiel de lib/calculo-deposito.ts).
//
// PURO respecto a Firestore: solo lee a través de las funciones que recibe.

import { HttpsError } from 'firebase-functions/v2/https';
import type { DocumentData } from 'firebase-admin/firestore';
import { calcularDeposito } from './calculo-deposito';

export const TIPO_DEPOSITO_STORKHUB = 'recaudacion_motorizado_storkhub';
export const TIPO_DEPOSITO_COMERCIO = 'recaudacion_motorizado_comercio';

/**
 * Tope de órdenes por depósito. La transacción escribe 1 depósito + N órdenes +
 * (evento) + (saldo) + 1 movimiento, y Firestore admite 500 escrituras por
 * transacción. Un depósito real agrupa unas pocas órdenes; el tope existe para
 * fallar con un mensaje claro y no con un error opaco de Firestore.
 */
export const MAX_ORDENES_POR_DEPOSITO = 450;

export type MotivoRechazo =
  | 'estado_cambio'
  | 'tipo_no_confirmable'
  | 'sin_ordenes'
  | 'demasiadas_ordenes'
  | 'orden_invalida'
  | 'gasto_invalido'
  | 'gasto_sin_marca'
  | 'monto_inconsistente'
  | 'ledger_inconsistente'
  // FIN-4A — conversión en deuda
  | 'tipo_no_convertible'
  | 'confirmado_no_convertible'
  | 'saldo_previo_vivo'
  | 'monto_cero'
  | 'conversion_inconsistente';

export function rechazo(motivo: MotivoRechazo, mensaje: string, extra: Record<string, unknown> = {}): HttpsError {
  return new HttpsError('failed-precondition', mensaje, { motivo, ...extra });
}

export function esNumeroFinito(v: unknown): v is number {
  return typeof v === 'number' && Number.isFinite(v);
}

export function idsUnicos(v: unknown): string[] {
  if (!Array.isArray(v)) return [];
  return [...new Set(v.filter((x): x is string => typeof x === 'string' && x.length > 0))];
}

export function mismoMonto(a: unknown, b: number): boolean {
  return esNumeroFinito(a) && Math.abs(a - b) < 0.005;
}

/** Lo único que la demostración necesita leer. Las dos transacciones lo cumplen. */
export interface LecturasDeposito {
  /** Doc id canónico del motorizado a partir de su authUid, o null si no hay (docs antiguos usan el authUid). */
  getMotorizadoDocId(authUid: string): Promise<string | null>;
  getSolicitud(id: string): Promise<DocumentData | null>;
  getGasto(id: string): Promise<DocumentData | null>;
}

export interface DepositoDemostrado {
  solicitudIds: string[];
  motorizadoUid: string;
  /** Doc id canónico del motorizado (cuentas del ledger, gastos). */
  motDocId: string;
  esStorkhub: boolean;
  montoBruto: number;
  gastosDescontados: number;
  montoTotal: number;
}

/**
 * Demuestra órdenes, gastos y monto de un depósito A/B ya leído. Lanza `rechazo`
 * ante la primera inconsistencia; nunca corrige nada.
 */
export async function demostrarDeposito(
  tx: LecturasDeposito,
  dep: DocumentData,
  depositoId: string,
  accion: 'confirmacion' | 'conversion' = 'confirmacion',
): Promise<DepositoDemostrado> {
  // Los textos de FIN-3 no cambian; la conversión dice lo suyo.
  const porAccion = accion === 'confirmacion' ? 'por confirmación' : 'por conversión';
  const noSeOpera = accion === 'confirmacion' ? 'No se confirma ni se corrige solo.' : 'No se convierte ni se corrige solo.';
  const esStorkhub = dep.tipo === TIPO_DEPOSITO_STORKHUB;

  // ── Órdenes ─────────────────────────────────────────────────────────────────
  const solicitudIds = idsUnicos(dep.solicitudIds);
  if (solicitudIds.length === 0) throw rechazo('sin_ordenes', 'El depósito no tiene órdenes asociadas.');
  if (solicitudIds.length > MAX_ORDENES_POR_DEPOSITO) {
    throw rechazo('demasiadas_ordenes', `El depósito supera el máximo de ${MAX_ORDENES_POR_DEPOSITO} órdenes ${porAccion}.`);
  }

  const motorizadoUid = typeof dep.motorizadoUid === 'string' ? dep.motorizadoUid : '';
  if (!motorizadoUid) throw rechazo('orden_invalida', 'El depósito no identifica a su motorizado.');
  const motDocId = (await tx.getMotorizadoDocId(motorizadoUid)) ?? motorizadoUid;

  const claveDeposito = esStorkhub ? 'storkhubDepositoId' : 'comercioDepositoId';
  let montoBruto = 0;
  for (const sid of solicitudIds) {
    const o = await tx.getSolicitud(sid);
    if (!o) throw rechazo('orden_invalida', 'Una de las órdenes del depósito ya no existe.', { solicitudId: sid });
    if (o.estado !== 'entregado') throw rechazo('orden_invalida', 'Una de las órdenes del depósito no está entregada.', { solicitudId: sid });
    if (o.asignacion?.motorizadoAuthUid !== motorizadoUid) {
      throw rechazo('orden_invalida', 'Una de las órdenes no pertenece al motorizado del depósito.', { solicitudId: sid });
    }
    const apunta = o.registro?.deposito?.[claveDeposito];
    if (apunta && apunta !== depositoId) {
      throw rechazo('orden_invalida', 'Una de las órdenes ya pertenece a otro depósito.', { solicitudId: sid });
    }
    if (!esStorkhub) {
      const dueno = dep.destinatarioId;
      if (!dueno || (o.userId !== dueno && o.ownerSnapshot?.uid !== dueno)) {
        throw rechazo('orden_invalida', 'Una de las órdenes no pertenece al comercio del depósito.', { solicitudId: sid });
      }
    }
    const calculo = calcularDeposito(o);
    montoBruto += esStorkhub ? calculo.totalAStorkhub : calculo.totalAlComercio;
  }

  // ── Gastos (FIN-2): se CONFIRMA lo que FIN-2 ya consumió ────────────────────
  const gastosIds = idsUnicos(dep.gastosIds);
  if (!esStorkhub && gastosIds.length > 0) {
    throw rechazo('gasto_invalido', 'Un depósito al comercio no descuenta gastos.');
  }
  let gastosDescontados = 0;
  for (const gid of gastosIds) {
    const g = await tx.getGasto(gid);
    if (!g) throw rechazo('gasto_invalido', 'Uno de los gastos del depósito ya no existe.', { gastoId: gid });
    if (g.estado !== 'aprobado') throw rechazo('gasto_invalido', 'Uno de los gastos del depósito no está aprobado.', { gastoId: gid });
    if (g.motorizadoId !== motDocId) throw rechazo('gasto_invalido', 'Uno de los gastos no pertenece al motorizado del depósito.', { gastoId: gid });
    if (g.liquidacionId) throw rechazo('gasto_invalido', 'Uno de los gastos ya se descontó en una liquidación.', { gastoId: gid });
    // Sin la marca de FIN-2 el gasto podría estar descontado en otro depósito.
    // No se debilita para dejarlo pasar: depende de FIN-GASTOS-CONSUMO-BACKFILL-1.
    if (g.consumidoEnDepositoId === undefined || g.consumidoEnDepositoId === null || g.consumidoEnDepositoId === '') {
      throw rechazo('gasto_sin_marca', 'Uno de los gastos del depósito no tiene marca de consumo (depósito anterior a FIN-2). Requiere el backfill de gastos.', { gastoId: gid });
    }
    if (g.consumidoEnDepositoId !== depositoId) {
      throw rechazo('gasto_invalido', 'Uno de los gastos ya fue consumido por otro depósito.', { gastoId: gid });
    }
    if (!esNumeroFinito(g.monto) || g.monto <= 0) throw rechazo('gasto_invalido', 'Uno de los gastos tiene un monto inválido.', { gastoId: gid });
    gastosDescontados += g.monto;
  }

  // ── Monto: se DEMUESTRA, no se acepta ───────────────────────────────────────
  const montoTotal = esStorkhub ? Math.max(0, montoBruto - gastosDescontados) : montoBruto;
  // Un depósito anterior a los gastos no guarda montoBruto ni gastosDescontados:
  // el bruto no se compara (no hay con qué), los gastos ausentes valen 0, y el
  // total SIEMPRE se compara.
  const montoCoincide = esStorkhub
    ? mismoMonto(dep.montoTotal, montoTotal)
      && mismoMonto(dep.gastosDescontados ?? 0, gastosDescontados)
      && (dep.montoBruto === undefined || mismoMonto(dep.montoBruto, montoBruto))
    : mismoMonto(dep.montoTotal, montoTotal);
  if (!montoCoincide) {
    throw rechazo('monto_inconsistente', `El monto guardado del depósito no coincide con sus órdenes y gastos. ${noSeOpera}`, {
      esperado: { montoBruto, gastosDescontados, montoTotal },
    });
  }

  return { solicitudIds, motorizadoUid, motDocId, esStorkhub, montoBruto, gastosDescontados, montoTotal };
}
