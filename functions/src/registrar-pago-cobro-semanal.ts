// ═════════════════════════════════════════════════
// registrarPagoCobroSemanal — FIN-1C-A: pago de un cobro de CRÉDITO SEMANAL, AUTORITATIVO e IDEMPOTENTE
// ═════════════════════════════════════════════════
//
// Antes: PagoModal.handlePago era una runTransaction de CLIENTE sobre cobros_semanales y movimientos_financieros. Las Rules daban
// `write` completo sobre cobros_semanales a cualquier gestor/admin: se podía fabricar una semana "pagada", cambiar su total o su
// historial de pagos, sin ledger.
//
// Ahora una sola transacción, con { pagoId, cobroSemanalId, monto, nota? } como única entrada y solo para admin o gestor activo:
//
//   · El cobro semanal se RELEE: existe, totalMonto válido (> 0) y el monto no excede el saldo real (totalMonto − totalPagado).
//   · Se agrega el pago a pagos[], se recalcula totalPagado y estado ('parcial' / 'pagado') y se crea UN pago_recibido con id determinista.
//   · Idempotente por pagoId: marcador operaciones_cobro/semanal_<cobroSemanalId>_<pagoId>; además se respeta un pagoId ya presente en
//     pagos[] o un movimiento determinista ya existente (pagos hechos por la versión anterior de la pantalla).
//   · Un historial inconsistente (suma de pagos ≠ totalPagado) se documenta en el log, nunca se repara aquí: totalPagado manda.

import { HttpsError } from 'firebase-functions/v2/https';
import type { DocumentData } from 'firebase-admin/firestore';
import { esNumeroFinito } from './deposito-monto';
import {
  TIPO_MOVIMIENTO_PAGO, exigirStaffCobros, mismoMontoCobro, rechazoCobro, validarPeticionPagoSemanal, type LecturasCobro,
} from './cobro-acciones-comun';

export type ResultadoPagoSemanal = {
  ok: true;
  resultado: 'registrado' | 'ya_registrado';
  cobroSemanalId: string;
  pagoId: string;
  movimientoId: string;
  estado: string;
  totalPagado: number;
  saldoPendiente: number;
};

export interface TxPagoSemanal extends Pick<LecturasCobro, 'getUsuario' | 'getMovimiento' | 'getOperacion'> {
  getCobroSemanal(id: string): Promise<DocumentData | null>;
  updateCobroSemanal(id: string, campos: DocumentData): void;
  crearMovimiento(id: string, campos: DocumentData): void;
  crearOperacion(id: string, campos: DocumentData): void;
}

export interface DepsPagoSemanal {
  transaction<T>(fn: (tx: TxPagoSemanal) => Promise<T>): Promise<T>;
  serverTimestamp(): unknown;
  /** Instante concreto: serverTimestamp no puede ir dentro de un arreglo. */
  ahora(): unknown;
}

export const idOperacionPagoSemanal = (cobroSemanalId: string, pagoId: string): string => `semanal_${cobroSemanalId}_${pagoId}`;
export const idMovimientoPagoSemanal = (cobroSemanalId: string, pagoId: string): string => `pago_semanal_${cobroSemanalId}_${pagoId}`;
const redondear = (n: number): number => Math.round(n * 100) / 100;

export async function registrarPagoCobroSemanalCore(
  deps: DepsPagoSemanal,
  uid: string | undefined,
  data: unknown,
): Promise<ResultadoPagoSemanal> {
  if (!uid) throw new HttpsError('unauthenticated', 'Debés iniciar sesión.');
  const { pagoId, cobroSemanalId, monto, nota } = validarPeticionPagoSemanal(data);

  return deps.transaction(async (tx) => {
    // ── LECTURAS ──────────────────────────────────────────────────────────────
    const rol = exigirStaffCobros(await tx.getUsuario(uid));
    const idMov = idMovimientoPagoSemanal(cobroSemanalId, pagoId);

    const cobro = await tx.getCobroSemanal(cobroSemanalId);
    if (!cobro) throw new HttpsError('not-found', 'Este cobro semanal ya no existe.');
    const totalMonto = cobro.totalMonto;
    if (!esNumeroFinito(totalMonto) || !(totalMonto > 0)) {
      throw rechazoCobro('cobro_semanal_invalido', 'El cobro semanal tiene un total inválido: no se puede registrar el pago.');
    }
    if (cobro.totalPagado !== undefined && !esNumeroFinito(cobro.totalPagado)) {
      throw rechazoCobro('cobro_semanal_invalido', 'El cobro semanal tiene un total pagado inválido: no se puede registrar el pago.');
    }
    const totalPagado = esNumeroFinito(cobro.totalPagado) ? cobro.totalPagado : 0;
    const pagos: DocumentData[] = Array.isArray(cobro.pagos) ? cobro.pagos : [];

    // Idempotencia ANTES de los guards del saldo: un retry no puede fallar por "saldo insuficiente".
    const op = await tx.getOperacion(idOperacionPagoSemanal(cobroSemanalId, pagoId));
    const yaEnPagos = pagos.some((p) => p?.pagoId === pagoId);
    const movPrevio = op || yaEnPagos ? null : await tx.getMovimiento(idMov);
    if (op || yaEnPagos || movPrevio) {
      if (op && !mismoMontoCobro(op.monto, monto)) throw rechazoCobro('operacion_inconsistente', 'Ese pago ya se registró con otro monto.');
      return {
        ok: true as const, resultado: 'ya_registrado' as const, cobroSemanalId, pagoId, movimientoId: idMov,
        estado: String(cobro.estado ?? ''), totalPagado, saldoPendiente: redondear(totalMonto - totalPagado),
      };
    }

    const saldoReal = redondear(totalMonto - totalPagado);
    if (monto > saldoReal + 0.005) {
      throw rechazoCobro('saldo_insuficiente', 'El monto excede el saldo pendiente real.', { saldoReal });
    }

    // ── ESCRITURAS ────────────────────────────────────────────────────────────
    const ahora = deps.serverTimestamp();
    const nuevoTotalPagado = redondear(totalPagado + monto);
    const estado = mismoMontoCobro(nuevoTotalPagado, totalMonto) ? 'pagado' : nuevoTotalPagado > 0 ? 'parcial' : 'pendiente';
    const entrada = {
      pagoId, monto, at: deps.ahora(), nota, registradoPor: uid, formaPago: null, referencia: nota, movimientoPagoId: idMov,
    };
    tx.updateCobroSemanal(cobroSemanalId, {
      totalPagado: nuevoTotalPagado,
      estado,
      pagos: [...pagos, entrada],
      updatedAt: ahora,
      ...(estado === 'pagado' ? { pagadoAt: ahora } : {}),
    });
    tx.crearMovimiento(idMov, {
      tipo: TIPO_MOVIMIENTO_PAGO,
      monto,
      at: ahora,
      creadoPorUid: uid,
      creadoPorRol: rol,
      descripcion: `Pago crédito semanal · ${String(cobro.clienteCompany || cobro.clienteNombre || 'Cliente')} · sem ${String(cobro.semanaKey ?? '')}`,
      estado: 'activo',
      comercioId: cobro.clienteUid ?? null,
      semanaKey: cobro.semanaKey ?? null,
      metadata: { cobroSemanalId, pagoId },
    });
    tx.crearOperacion(idOperacionPagoSemanal(cobroSemanalId, pagoId), { tipo: 'pago_cobro_semanal', cobroSemanalId, pagoId, monto, movimientoId: idMov, actorUid: uid, actorRol: rol, at: ahora });

    return {
      ok: true as const, resultado: 'registrado' as const, cobroSemanalId, pagoId, movimientoId: idMov, estado,
      totalPagado: nuevoTotalPagado, saldoPendiente: redondear(totalMonto - nuevoTotalPagado),
    };
  });
}
