// ═════════════════════════════════════════════════
// marcarLiquidacionPagada — FIN-1D: pagar una liquidación AUTORITATIVO e IDEMPOTENTE
// ═════════════════════════════════════════════════
//
// Antes: marcarPagada era un multi-paso de cliente (crear el saldo, marcar `pagado`, registrar el movimiento —que tragaba sus errores— y subir el
// PDF). Un doble clic duplicaba el saldo y el movimiento, y un neto negativo registraba un liquidacion_pago_efectivo con MONTO NEGATIVO.
//
// Ahora una sola transacción, con { liquidacionId, operacionId } como única entrada y solo para admin o gestor activo:
//   · la liquidación debe existir; solo la transición `pendiente → pagado` (ya pagada → ya_pagada sin escribir);
//   · neto > 0: UN movimiento liquidacion_pago_efectivo con el neto RELEÍDO de la liquidación (positivo), id determinista;
//   · neto ≤ 0: marca pagada y NO crea movimiento. El saldo del neto negativo ya nació al CREAR la liquidación (con su saldo_creado);
//   · un neto negativo sin saldoGeneradoId es una liquidación anterior a FIN-1D: se rechaza (conciliacion_requerida) en vez de cerrar una deuda
//     que nunca se registró;
//   · un marcador server-only operaciones_liquidacion/pagar_<liquidacionId>.
// El PDF NO forma parte de la transacción: el cliente lo genera y sube después y solo actualiza pdfUrl/pdfPath/pdfGeneradoAt.

import { HttpsError } from 'firebase-functions/v2/https';
import type { DocumentData } from 'firebase-admin/firestore';
import { cuentas } from './financial-types';
import { exigirStaffFinanzas, huellaPayload, idValido, objetoPlano, operacionIdValido, rechazoOp, soloClaves } from './finanzas-operativas-comun';
import { aCentavos, aMonto } from './liquidacion-calculo';
import { esNumeroFinito } from './deposito-monto';

export const TIPO_MOV_PAGO_LIQUIDACION = 'liquidacion_pago_efectivo';

export const idOperacionPagarLiquidacion = (liquidacionId: string): string => `pagar_${liquidacionId}`;
export const idMovimientoPago = (liquidacionId: string): string => `pago_${liquidacionId}`;

/** Cuentas del pago: el mapping documentado de este tipo en lib/financial-types.ts (comision_pendiente → externo). */
export const cuentasPagoLiquidacion = (motorizadoId: string) => ({ origen: cuentas.comisionPendiente(motorizadoId), destino: cuentas.externo });

export interface PeticionPagarLiquidacion { liquidacionId: string; operacionId: string }

/** SOLO { liquidacionId, operacionId }. Ni monto, ni actor, ni cuentas, ni estado final. */
export function validarPeticionPagarLiquidacion(data: unknown): PeticionPagarLiquidacion {
  const d = objetoPlano(data);
  soloClaves(d, ['liquidacionId', 'operacionId']);
  if (!idValido(d.liquidacionId)) throw new HttpsError('invalid-argument', 'liquidacionId inválido.');
  return { liquidacionId: d.liquidacionId.trim(), operacionId: operacionIdValido(d.operacionId) };
}

export type ResultadoPagarLiquidacion = {
  ok: true;
  resultado: 'pagada' | 'ya_pagada';
  liquidacionId: string;
  movimientoId: string | null;
  netoAPagar: number;
};

export interface TxPagarLiquidacion {
  getUsuario(uid: string): Promise<DocumentData | null>;
  getLiquidacion(id: string): Promise<DocumentData | null>;
  getOperacion(id: string): Promise<DocumentData | null>;
  getMovimiento(id: string): Promise<DocumentData | null>;
  updateLiquidacion(id: string, campos: DocumentData): void;
  crearMovimiento(id: string, campos: DocumentData): void;
  crearOperacion(id: string, campos: DocumentData): void;
}

export interface DepsPagarLiquidacion {
  transaction<T>(fn: (tx: TxPagarLiquidacion) => Promise<T>): Promise<T>;
  serverTimestamp(): unknown;
}

export async function marcarLiquidacionPagadaCore(deps: DepsPagarLiquidacion, uid: string | undefined, data: unknown): Promise<ResultadoPagarLiquidacion> {
  if (!uid) throw new HttpsError('unauthenticated', 'Debés iniciar sesión.');
  const p = validarPeticionPagarLiquidacion(data);
  const huella = huellaPayload({ liquidacionId: p.liquidacionId, operacionId: p.operacionId });

  return deps.transaction(async (tx) => {
    // ── LECTURAS ──────────────────────────────────────────────────────────────
    const rol = exigirStaffFinanzas(await tx.getUsuario(uid));

    const liq = await tx.getLiquidacion(p.liquidacionId);
    if (!liq) throw new HttpsError('not-found', 'La liquidación no existe.');

    const neto = esNumeroFinito(liq.netoAPagar) ? aMonto(aCentavos(liq.netoAPagar)) : null;

    // Idempotencia: una liquidación ya pagada se responde sin escribir (retry idéntico, doble clic u otra pestaña).
    if (liq.estado === 'pagado') {
      const movId = idMovimientoPago(p.liquidacionId);
      const mov = await tx.getMovimiento(movId);
      return { ok: true as const, resultado: 'ya_pagada' as const, liquidacionId: p.liquidacionId, movimientoId: mov ? movId : null, netoAPagar: neto ?? 0 };
    }
    if (liq.estado !== 'pendiente') {
      throw rechazoOp('estado_invalido', 'La liquidación no está pendiente: no se puede pagar.', { liquidacionId: p.liquidacionId, estado: String(liq.estado ?? '') });
    }

    const op = await tx.getOperacion(idOperacionPagarLiquidacion(p.liquidacionId));
    if (op) throw rechazoOp('conciliacion_requerida', 'La liquidación tiene un pago registrado pero sigue pendiente. Hay que conciliarlo: no se paga de nuevo.', { liquidacionId: p.liquidacionId });

    const motorizadoId = typeof liq.motorizadoId === 'string' ? liq.motorizadoId : '';
    if (neto === null || motorizadoId === '') {
      throw rechazoOp('conciliacion_requerida', 'La liquidación no es coherente (neto o motorizado). Hay que conciliarla: no se paga.', { liquidacionId: p.liquidacionId });
    }
    // Un neto negativo sin saldo es una liquidación anterior a FIN-1D (el saldo nacía al pagar): no se cierra una deuda que no existe.
    if (neto < 0 && !(typeof liq.saldoGeneradoId === 'string' && liq.saldoGeneradoId)) {
      throw rechazoOp('conciliacion_requerida', 'La liquidación tiene un neto negativo y ningún saldo asociado (liquidación anterior): hay que conciliarla, no se paga sola.', { liquidacionId: p.liquidacionId });
    }

    const movId = idMovimientoPago(p.liquidacionId);
    if (neto > 0 && (await tx.getMovimiento(movId))) {
      throw rechazoOp('conciliacion_requerida', 'Ya existe el movimiento de pago de una liquidación que sigue pendiente. Hay que conciliarlo.', { liquidacionId: p.liquidacionId });
    }

    // ── ESCRITURAS ────────────────────────────────────────────────────────────
    const ts = deps.serverTimestamp();
    let movimientoId: string | null = null;
    if (neto > 0) {
      const c = cuentasPagoLiquidacion(motorizadoId);
      tx.crearMovimiento(movId, {
        tipo: TIPO_MOV_PAGO_LIQUIDACION, monto: neto, at: ts, creadoPorUid: uid, creadoPorRol: rol,
        descripcion: `Liquidación pagada sem ${String(liq.semanaKey ?? '')} · ${String(liq.motorizadoNombre ?? motorizadoId)}`, estado: 'activo',
        cuentaOrigen: c.origen, cuentaDestino: c.destino, propietario: `motorizado:${motorizadoId}`,
        motorizadoId, liquidacionId: p.liquidacionId, ...(typeof liq.semanaKey === 'string' ? { semanaKey: liq.semanaKey } : {}),
        metadata: { operacionId: p.operacionId },
      });
      movimientoId = movId;
    }
    tx.updateLiquidacion(p.liquidacionId, {
      estado: 'pagado', pagadoAt: ts, pagadoPor: uid, pagadoPorUid: uid, pagadoPorRol: rol, ...(movimientoId ? { movimientoPagoId: movimientoId } : {}),
    });
    tx.crearOperacion(idOperacionPagarLiquidacion(p.liquidacionId), {
      tipo: 'pagar_liquidacion', huella, operacionId: p.operacionId, liquidacionId: p.liquidacionId, movimientoId, actorUid: uid, actorRol: rol, at: ts,
    });

    return { ok: true as const, resultado: 'pagada' as const, liquidacionId: p.liquidacionId, movimientoId, netoAPagar: neto };
  });
}
