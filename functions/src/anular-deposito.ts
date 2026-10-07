// ═════════════════════════════════════════════════
// anularDeposito — FIN-1B: Anular AUTORITATIVO e IDEMPOTENTE
// ═════════════════════════════════════════════════
//
// Antes de FIN-1B "Anular" era un writeBatch de CLIENTE: el navegador leía los movimientos, decidía cuáles anular, qué órdenes
// liberar y qué gastos soltar. Un cliente modificado podía anular un confirmado dejando su ledger vivo (E3).
//
// Esta Function lo hace en UNA transacción, con { depositoId, motivo } como única entrada, y solo para un admin activo:
//
//   · Idempotente: un depósito ya anulado responde 'ya_anulado' sin escribir, ANTES de cualquier otro guard.
//   · convertido_en_deuda, saldoId o un saldo vivo asociado ⇒ usar_reversion_conversion (FIN-4B es el único camino). Tipo C ⇒ usar_revertir_cobro.
//   · Estados soportados: pendiente_boucher, en_revision, devuelto, rechazado y confirmado. Cualquier otro ⇒ deposito_no_anulable.
//   · Preconfirmación: 0 movimientos activos. Confirmado: exactamente UN movimiento activo (el originario) y es lo que se anula.
//   · Confirmado: si una liquidación del motorizado ya lo capturó (depositosIds, o semana si es legacy) ⇒ deposito_ya_liquidado /
//     deposito_comercio_ya_liquidado, abierta o cerrada. Los movimientos posteriores de la cuenta saldo_comercio (fungible, sin
//     depositoId) NO bloquean.
//   · Órdenes: se leen; si apuntan a otro depósito ⇒ conciliacion_requerida (0 writes). Se libera solo el puntero de ESTE depósito.
//   · Gastos FIN-2 (Storkhub): se libera solo el que consumió ESTE depósito; si lo consumió otro ⇒ conciliacion_requerida.

import { HttpsError } from 'firebase-functions/v2/https';
import type { DocumentData } from 'firebase-admin/firestore';
import {
  CAMPO_GASTO_CONSUMIDO, EVENTO_DEPOSITO_ANULADO, claseDeposito, clavesOrden, bloqueoLiquidacion, estaVivo, exigirAdmin,
  liquidacionQueLoCapturo, movimientoOriginario, ordenesDelDeposito, rechazoDeposito, validarPeticionAnular, verificarGastos,
  verificarOrdenes, type LecturasDepositoAccion,
} from './deposito-acciones-comun';

export const ESTADO_ANULADO = 'anulado';
export const ESTADOS_ANULABLES: readonly string[] = ['pendiente_boucher', 'en_revision', 'devuelto', 'rechazado', 'confirmado'];

export type ResultadoAnularDeposito = {
  ok: true;
  /** 'anulado': se anuló ahora. 'ya_anulado': ya estaba anulado; no se escribió nada. */
  resultado: 'anulado' | 'ya_anulado';
  depositoId: string;
  estadoAnterior: string;
  eventoId: string | null;
  movimientoId: string | null;
  gastosLiberados: number;
};

export interface TxAnularDeposito extends LecturasDepositoAccion {
  /** TODOS los saldos con depositoId == id (vivos y anulados). */
  getSaldosDeDeposito(depositoId: string): Promise<Array<{ id: string; data: DocumentData }>>;
  updateDeposito(id: string, campos: DocumentData): void;
  crearEvento(depositoId: string, eventoId: string, campos: DocumentData): void;
  updateSolicitud(id: string, campos: DocumentData): void;
  updateMovimiento(id: string, campos: DocumentData): void;
  updateGasto(id: string, campos: DocumentData): void;
}

export interface DepsAnularDeposito {
  transaction<T>(fn: (tx: TxAnularDeposito) => Promise<T>): Promise<T>;
  serverTimestamp(): unknown;
  /** FieldValue.delete(): quita un campo. */
  eliminar(): unknown;
  /** Id del evento de ESTA llamada: fijo aunque Firestore reintente la transacción. */
  nuevoEventoId(): string;
}

export async function anularDepositoCore(
  deps: DepsAnularDeposito,
  uid: string | undefined,
  data: unknown,
): Promise<ResultadoAnularDeposito> {
  if (!uid) throw new HttpsError('unauthenticated', 'Debés iniciar sesión.');
  const { depositoId, motivo } = validarPeticionAnular(data);
  const eventoIdNuevo = deps.nuevoEventoId();

  return deps.transaction(async (tx) => {
    // ── LECTURAS (todas antes de cualquier escritura) ─────────────────────────
    const rol = exigirAdmin(await tx.getUsuario(uid));
    const dep = await tx.getDeposito(depositoId);
    if (!dep) throw new HttpsError('not-found', 'El depósito no existe.');
    const estadoAnterior = String(dep.estado ?? '');

    // Idempotencia: PRIMERO.
    if (estadoAnterior === ESTADO_ANULADO) {
      return { ok: true as const, resultado: 'ya_anulado' as const, depositoId, estadoAnterior, eventoId: null, movimientoId: null, gastosLiberados: 0 };
    }

    const clase = claseDeposito(dep);
    if (clase === 'pago_cobro') throw rechazoDeposito('usar_revertir_cobro', 'Un depósito de pago de cobro no se anula aquí: se corrige desde Cobros (revertir).');
    const saldoId = typeof dep.saldoId === 'string' ? dep.saldoId.trim() : '';
    if (estadoAnterior === 'convertido_en_deuda' || saldoId) {
      throw rechazoDeposito('usar_reversion_conversion', 'Un depósito convertido en deuda no se anula: se revierte la conversión.');
    }
    if (clase === 'otro') throw rechazoDeposito('deposito_no_anulable', 'Este tipo de depósito no se anula aquí.');
    if (!ESTADOS_ANULABLES.includes(estadoAnterior)) {
      throw rechazoDeposito('deposito_no_anulable', `Un depósito en "${estadoAnterior || 'desconocido'}" no se anula.`, { estado: estadoAnterior });
    }
    if (clase === 'comercio' && !(typeof dep.destinatarioId === 'string' && dep.destinatarioId.trim() && dep.destinatario === 'comercio')) {
      throw rechazoDeposito('conciliacion_requerida', 'El depósito de comercio no identifica a su comercio.');
    }

    // Una deuda viva asociada (FIN-1A / FIN-4C) no se borra: la historia financiera se corrige por su camino.
    const saldos = await tx.getSaldosDeDeposito(depositoId);
    if (saldos.some((s) => s.data.estado !== 'anulado')) {
      throw rechazoDeposito('usar_reversion_conversion', 'El depósito tiene una deuda viva asociada: se corrige revirtiendo la conversión.');
    }

    const motorizadoUid = typeof dep.motorizadoUid === 'string' ? dep.motorizadoUid : '';
    if (!motorizadoUid) throw rechazoDeposito('conciliacion_requerida', 'El depósito no identifica a su motorizado.');
    const motDocId = (await tx.getMotorizadoDocId(motorizadoUid)) ?? motorizadoUid;

    const movimientos = await tx.getMovimientosDeDeposito(depositoId);
    const confirmado = estadoAnterior === 'confirmado';
    let originarioId: string | null = null;
    if (confirmado) {
      originarioId = movimientoOriginario(dep, depositoId, clase, motDocId, movimientos).id;
      const liquidaciones = await tx.getLiquidacionesDelMotorizado(motorizadoUid, motDocId);
      const capturo = liquidacionQueLoCapturo(dep, depositoId, liquidaciones);
      if (capturo) throw bloqueoLiquidacion(clase, capturo.id);
    } else {
      const activos = movimientos.filter((m) => estaVivo(m.data));
      if (activos.length > 0) {
        throw rechazoDeposito('ledger_inconsistente', 'El depósito no está confirmado pero tiene movimientos activos en el ledger. Hay que revisarlo.', { activos: activos.length });
      }
    }

    const ordenIds = ordenesDelDeposito(dep);
    await verificarOrdenes(tx, ordenIds, depositoId, clase, { exigirPuntero: confirmado, exigirConfirmadoComercio: confirmado && clase === 'comercio' });
    const gastosPropios = await verificarGastos(tx, dep, depositoId, clase, false);

    // Solo se liberan las órdenes que apuntan a ESTE depósito (las demás no se tocan).
    const k = clavesOrden(clase === 'storkhub' ? 'storkhub' : 'comercio');
    const ordenesALiberar: string[] = [];
    for (const sid of ordenIds) {
      const o = await tx.getSolicitud(sid);
      const puntero = (o?.registro as { deposito?: Record<string, unknown> } | undefined)?.deposito?.[clase === 'storkhub' ? 'storkhubDepositoId' : 'comercioDepositoId'];
      if (puntero === depositoId) ordenesALiberar.push(sid);
    }

    // ── ESCRITURAS (todas dentro de esta transacción) ─────────────────────────
    const ahora = deps.serverTimestamp();
    const eventoId = eventoIdNuevo;
    tx.updateDeposito(depositoId, {
      estado: ESTADO_ANULADO,
      anuladoAt: ahora,
      anuladoPorUid: uid,
      anuladoPorRol: rol,
      motivoAnulacion: motivo,
      ultimoEventoId: eventoId,
      updatedAt: ahora,
    });
    tx.crearEvento(depositoId, eventoId, {
      tipo: EVENTO_DEPOSITO_ANULADO,
      at: ahora,
      porUid: uid,
      porRol: rol,
      motivo,
      depositoId,
      estadoAnterior,
      movimientoId: originarioId,
    });
    if (originarioId) {
      tx.updateMovimiento(originarioId, {
        estado: 'anulado',
        anuladoAt: ahora,
        anuladoPorUid: uid,
        anuladoPorRol: rol,
        motivoAnulacion: `Depósito anulado · ${motivo}`,
      });
    }
    for (const sid of ordenesALiberar) tx.updateSolicitud(sid, { [k.id]: null, [k.confirmado]: false, [k.confirmadoAt]: null });
    for (const gid of gastosPropios) tx.updateGasto(gid, { [CAMPO_GASTO_CONSUMIDO]: deps.eliminar() });

    return {
      ok: true as const,
      resultado: 'anulado' as const,
      depositoId,
      estadoAnterior,
      eventoId,
      movimientoId: originarioId,
      gastosLiberados: gastosPropios.length,
    };
  });
}
