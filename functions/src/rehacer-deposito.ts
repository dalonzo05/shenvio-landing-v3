// ═════════════════════════════════════════════════
// rehacerDeposito — FIN-1B: Rehacer AUTORITATIVO e IDEMPOTENTE
// ═════════════════════════════════════════════════
//
// Antes de FIN-1B "Rehacer" era un writeBatch de CLIENTE (depositos/page.tsx): el navegador decidía el estado destino, qué
// órdenes reabrir, qué movimientos del ledger anular y escribía el evento de auditoría. Las Rules solo pedían "admin + un
// evento": un cliente modificado podía reabrir un confirmado dejando su ledger vivo (D9), o llegar a 'en_revision' sin comprobante.
//
// Esta Function lo hace en UNA transacción, con { depositoId, motivo, operacionId } como única entrada, y solo para un admin activo:
//
//   · SOLO desde 'confirmado'. convertido_en_deuda / saldoId ⇒ usar_reversion_conversion; tipo C ⇒ usar_revertir_cobro.
//   · Destino derivado del documento: con boucher ⇒ 'en_revision'; sin boucher ⇒ 'pendiente_boucher'. No se fabrica ni se borra nada.
//   · Ledger: exactamente UN movimiento activo (el originario del depósito) y es lo único que se anula. Cualquier otro activo bloquea.
//   · Liquidación: si alguna liquidación del motorizado ya lo capturó (depositosIds, o semana si es legacy) bloquea, abierta o no.
//   · Órdenes: se leen; todas apuntan a ESTE depósito. Se conserva el puntero y se retira la confirmación (como FIN-4B con boucher).
//   · Gastos FIN-2 (Storkhub): deben seguir consumidos por este depósito y NO se tocan.
//   · Idempotente por operacionId: un marcador operaciones_deposito/rehacer_<operacionId> y el evento rehecho_<operacionId>.
//     Un retry (doble clic, respuesta perdida) resuelve 'ya_rehecho' ANTES de los guards del estado actual, sin escribir.

import { HttpsError } from 'firebase-functions/v2/https';
import type { DocumentData } from 'firebase-admin/firestore';
import {
  EVENTO_DEPOSITO_REHECHO, claseDeposito, clavesOrden, bloqueoLiquidacion, exigirAdmin, liquidacionQueLoCapturo,
  movimientoOriginario, ordenesDelDeposito, rechazoDeposito, tieneBoucher, validarPeticionRehacer, verificarGastos, verificarOrdenes,
  type LecturasDepositoAccion,
} from './deposito-acciones-comun';

export const ESTADO_CONFIRMADO = 'confirmado';
export const ESTADO_CONVERTIDO = 'convertido_en_deuda';
export const ESTADO_DESTINO_CON_BOUCHER = 'en_revision';
export const ESTADO_DESTINO_SIN_BOUCHER = 'pendiente_boucher';

export type ResultadoRehacer = {
  ok: true;
  /** 'rehecho': se reabrió ahora. 'ya_rehecho': esa operación ya se aplicó; no se escribió nada. */
  resultado: 'rehecho' | 'ya_rehecho';
  depositoId: string;
  estadoDestino: string;
  eventoId: string;
  movimientoId: string | null;
};

export interface TxRehacer extends LecturasDepositoAccion {
  getOperacion(id: string): Promise<DocumentData | null>;
  updateDeposito(id: string, campos: DocumentData): void;
  crearEvento(depositoId: string, eventoId: string, campos: DocumentData): void;
  updateSolicitud(id: string, campos: DocumentData): void;
  updateMovimiento(id: string, campos: DocumentData): void;
  crearOperacion(id: string, campos: DocumentData): void;
}

export interface DepsRehacer {
  transaction<T>(fn: (tx: TxRehacer) => Promise<T>): Promise<T>;
  serverTimestamp(): unknown;
}

export const idOperacionRehacer = (operacionId: string): string => `rehacer_${operacionId}`;
export const idEventoRehecho = (operacionId: string): string => `rehecho_${operacionId}`;

export async function rehacerDepositoCore(
  deps: DepsRehacer,
  uid: string | undefined,
  data: unknown,
): Promise<ResultadoRehacer> {
  if (!uid) throw new HttpsError('unauthenticated', 'Debés iniciar sesión.');
  const { depositoId, motivo, operacionId } = validarPeticionRehacer(data);

  return deps.transaction(async (tx) => {
    // ── LECTURAS (todas antes de cualquier escritura) ─────────────────────────
    const rol = exigirAdmin(await tx.getUsuario(uid));

    // Idempotencia: PRIMERO, antes de cualquier guard del estado actual.
    const op = await tx.getOperacion(idOperacionRehacer(operacionId));
    if (op) {
      if (op.depositoId !== depositoId) throw rechazoDeposito('operacion_inconsistente', 'Esa operación ya se usó en otro depósito.');
      return {
        ok: true as const,
        resultado: 'ya_rehecho' as const,
        depositoId,
        estadoDestino: String(op.estadoDestino ?? ''),
        eventoId: String(op.eventoId ?? idEventoRehecho(operacionId)),
        movimientoId: typeof op.movimientoId === 'string' ? op.movimientoId : null,
      };
    }

    const dep = await tx.getDeposito(depositoId);
    if (!dep) throw new HttpsError('not-found', 'El depósito no existe.');
    const clase = claseDeposito(dep);
    if (clase === 'pago_cobro') throw rechazoDeposito('usar_revertir_cobro', 'Un depósito de pago de cobro no se rehace aquí: se corrige desde Cobros (revertir).');
    const saldoId = typeof dep.saldoId === 'string' ? dep.saldoId.trim() : '';
    if (dep.estado === ESTADO_CONVERTIDO || saldoId) {
      throw rechazoDeposito('usar_reversion_conversion', 'Un depósito convertido en deuda se corrige revirtiendo la conversión, no rehaciéndolo.');
    }
    if (clase === 'otro') throw rechazoDeposito('deposito_no_rehacible', 'Este tipo de depósito no se rehace.');
    if (dep.estado !== ESTADO_CONFIRMADO) {
      throw rechazoDeposito('deposito_no_rehacible', `Solo se rehace un depósito confirmado (está en "${String(dep.estado ?? 'desconocido')}").`, { estado: String(dep.estado ?? '') });
    }
    if (clase === 'comercio' && !(typeof dep.destinatarioId === 'string' && dep.destinatarioId.trim() && dep.destinatario === 'comercio')) {
      throw rechazoDeposito('conciliacion_requerida', 'El depósito de comercio no identifica a su comercio.');
    }

    const motorizadoUid = typeof dep.motorizadoUid === 'string' ? dep.motorizadoUid : '';
    if (!motorizadoUid) throw rechazoDeposito('conciliacion_requerida', 'El depósito no identifica a su motorizado.');
    const motDocId = (await tx.getMotorizadoDocId(motorizadoUid)) ?? motorizadoUid;

    const movimientos = await tx.getMovimientosDeDeposito(depositoId);
    const originario = movimientoOriginario(dep, depositoId, clase, motDocId, movimientos);

    const liquidaciones = await tx.getLiquidacionesDelMotorizado(motorizadoUid, motDocId);
    const capturo = liquidacionQueLoCapturo(dep, depositoId, liquidaciones);
    if (capturo) throw bloqueoLiquidacion(clase, capturo.id);

    const ordenIds = ordenesDelDeposito(dep);
    if (ordenIds.length === 0) throw rechazoDeposito('conciliacion_requerida', 'El depósito no tiene órdenes asociadas.');
    await verificarOrdenes(tx, ordenIds, depositoId, clase, { exigirPuntero: true });
    // Los gastos NO se tocan: solo se exige que sigan consumidos por este depósito.
    await verificarGastos(tx, dep, depositoId, clase, true);

    // ── ESCRITURAS (todas dentro de esta transacción) ─────────────────────────
    const ahora = deps.serverTimestamp();
    const estadoDestino = tieneBoucher(dep) ? ESTADO_DESTINO_CON_BOUCHER : ESTADO_DESTINO_SIN_BOUCHER;
    const eventoId = idEventoRehecho(operacionId);

    tx.updateDeposito(depositoId, {
      estado: estadoDestino,
      rehechoAt: ahora,
      rehechoPorUid: uid,
      rehechoPorRol: rol,
      motivoRehacer: motivo,
      ultimoEventoId: eventoId,
      updatedAt: ahora,
    });
    tx.crearEvento(depositoId, eventoId, {
      tipo: EVENTO_DEPOSITO_REHECHO,
      at: ahora,
      porUid: uid,
      porRol: rol,
      motivo,
      depositoId,
      operacionId,
      estadoAnterior: ESTADO_CONFIRMADO,
      estadoDestino,
      movimientoId: originario.id,
    });
    tx.updateMovimiento(originario.id, {
      estado: 'anulado',
      anuladoAt: ahora,
      anuladoPorUid: uid,
      anuladoPorRol: rol,
      motivoAnulacion: `Depósito rehecho · ${motivo}`,
    });
    const k = clavesOrden(clase === 'storkhub' ? 'storkhub' : 'comercio');
    // El puntero se conserva (el depósito sigue existiendo y siendo de estas órdenes); la confirmación se retira.
    for (const sid of ordenIds) tx.updateSolicitud(sid, { [k.id]: depositoId, [k.confirmado]: false, [k.confirmadoAt]: null });
    tx.crearOperacion(idOperacionRehacer(operacionId), { depositoId, eventoId, estadoDestino, movimientoId: originario.id, actorUid: uid, at: ahora });

    return {
      ok: true as const,
      resultado: 'rehecho' as const,
      depositoId,
      estadoDestino,
      eventoId,
      movimientoId: originario.id,
    };
  });
}
