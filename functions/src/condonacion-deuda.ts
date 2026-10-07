// ═════════════════════════════════════════════════
// condonarDeudaMotorizado — FIN-1A: condonación AUTORITATIVA e IDEMPOTENTE
// ═════════════════════════════════════════════════
//
// Antes de FIN-1A condonar era una transacción de CLIENTE (lib/financial-writes.ts) que recibía de la
// pantalla el monto, el motorizado y el actor, y escribía el movimiento con creadoPorRol fijo 'gestor'.
// Un cliente modificado podía condonar lo que quisiera, o crear la pérdida contable sin saldo.
//
// Esta Function lo hace en UNA transacción, con { saldoId, motivo } como única entrada:
//
//   · Condona SIEMPRE el remanente releído (saldoPendiente), no un valor del cliente. Si la deuda tiene
//     abonos (abonado_parcial) condona SOLO lo que queda y conserva abonos[] y su ledger.
//   · Solo una deuda nacida de una conversión de depósito: origen 'deposito', tipo
//     'deposito_no_realizado', con su depósito todavía convertido_en_deuda y apuntando al saldo, y con
//     UN movimiento de conversión activo (se busca por saldoId y tipo, no por prefijo de id: un ciclo
//     legacy tiene id aleatorio). No anula ese movimiento: la deuda sigue naciendo de la conversión.
//   · Crea UN movimiento deuda_condonada (deuda_motorizado → perdida_condonaciones) con id determinista
//     cond_<saldoId> y create(), y el rol REAL del actor.
//   · Mantiene la política del depósito: condonado: true y notaCondonacion (sin cambiar su estado).
//   · Idempotente: un saldo ya condonado responde 'ya_condonada' sin escribir, y se resuelve ANTES de
//     los guards que convertirían un retry legítimo en inconsistencia.

import { HttpsError } from 'firebase-functions/v2/https';
import type { DocumentData } from 'firebase-admin/firestore';
import { cuentas } from './financial-types';
import { exigirGestorOAdmin } from './abono-directo';
import { ESTADO_CONVERTIDO, TIPO_MOVIMIENTO_CONVERSION, TIPO_SALDO_CONVERSION } from './conversion-deposito-deuda';
import {
  analizarSaldo, estaVivo, idValido, rechazoSaldo, tieneEvidenciaDeCondonacion, validarSaldoYMotivo,
} from './saldo-acciones-comun';

export const TIPO_MOVIMIENTO_CONDONACION = 'deuda_condonada';

export type ResultadoCondonacion = {
  ok: true;
  /** 'condonada': se condonó ahora. 'ya_condonada': ya estaba condonada y coherente; no se escribió nada. */
  resultado: 'condonada' | 'ya_condonada';
  saldoId: string;
  depositoId: string;
  movimientoId: string;
  montoCondonado: number;
};

export interface TxCondonacion {
  getUsuario(uid: string): Promise<DocumentData | null>;
  getSaldo(id: string): Promise<DocumentData | null>;
  getDeposito(id: string): Promise<DocumentData | null>;
  /** TODOS los movimientos del ledger con saldoId == id (activos y anulados). */
  getMovimientosDeSaldo(saldoId: string): Promise<Array<{ id: string; data: DocumentData }>>;
  updateSaldo(id: string, campos: DocumentData): void;
  updateDeposito(id: string, campos: DocumentData): void;
  crearMovimiento(id: string, campos: DocumentData): void;
}

export interface DepsCondonacion {
  transaction<T>(fn: (tx: TxCondonacion) => Promise<T>): Promise<T>;
  serverTimestamp(): unknown;
}

export async function condonarDeudaMotorizadoCore(
  deps: DepsCondonacion,
  uid: string | undefined,
  data: unknown,
): Promise<ResultadoCondonacion> {
  if (!uid) throw new HttpsError('unauthenticated', 'Debés iniciar sesión.');
  const { saldoId, motivo } = validarSaldoYMotivo(data);

  return deps.transaction(async (tx) => {
    // ── LECTURAS (todas antes de cualquier escritura) ─────────────────────────
    const rol = exigirGestorOAdmin(await tx.getUsuario(uid));
    const saldo = await tx.getSaldo(saldoId);
    if (!saldo) throw new HttpsError('not-found', 'El saldo no existe.');

    const movimientos = await tx.getMovimientosDeSaldo(saldoId);
    const condonacionesActivas = movimientos.filter((m) => m.data.tipo === TIPO_MOVIMIENTO_CONDONACION && estaVivo(m.data));

    // ── Idempotencia: PRIMERO, antes de cualquier guard que pueda fallar un retry ─
    if (saldo.estado === 'condonado') {
      if (condonacionesActivas.length !== 1) {
        throw rechazoSaldo('conciliacion_requerida', 'El saldo figura condonado pero su movimiento de condonación no es único y activo. Hay que conciliarlo: no se corrige solo.', { condonaciones: condonacionesActivas.length });
      }
      return {
        ok: true as const,
        resultado: 'ya_condonada' as const,
        saldoId,
        depositoId: typeof saldo.depositoId === 'string' ? saldo.depositoId : '',
        movimientoId: condonacionesActivas[0].id,
        montoCondonado: typeof saldo.montoCondonado === 'number' ? saldo.montoCondonado : condonacionesActivas[0].data.monto,
      };
    }

    // ── Qué saldo es condonable ───────────────────────────────────────────────
    if (saldo.origen !== 'deposito' || saldo.tipo !== TIPO_SALDO_CONVERSION || !idValido(saldo.depositoId)) {
      throw rechazoSaldo('saldo_no_condonable', 'Solo se condona una deuda originada en un depósito convertido en deuda.', { origen: String(saldo.origen ?? ''), tipo: String(saldo.tipo ?? '') });
    }
    const depositoId: string = saldo.depositoId;

    if (saldo.estado === 'pagado' || saldo.estado === 'anulado') {
      throw rechazoSaldo('saldo_no_condonable', `Un saldo ${saldo.estado} no se condona.`, { estadoSaldo: saldo.estado });
    }
    if (saldo.estado !== 'pendiente' && saldo.estado !== 'abonado_parcial') {
      throw rechazoSaldo('saldo_inconsistente', `El saldo está en un estado desconocido ("${String(saldo.estado ?? '')}").`, { estadoSaldo: String(saldo.estado ?? '') });
    }
    if (tieneEvidenciaDeCondonacion(saldo)) {
      throw rechazoSaldo('saldo_inconsistente', 'El saldo tiene datos de condonación pero no figura condonado. Hay que revisarlo.', {});
    }

    // ── Coherencia del saldo: saldoPendiente == montoOriginal − Σ abonos ──────
    const a = analizarSaldo(saldo);
    if (!a.ok) throw rechazoSaldo('saldo_inconsistente', 'El saldo no es coherente (monto original, abonos y pendiente no cuadran). No se condona.', {});
    const remanente: number = saldo.saldoPendiente;
    if (!(remanente > 0)) throw rechazoSaldo('sin_saldo_pendiente', 'El saldo pendiente es 0: no hay nada que condonar.', {});

    // ── El depósito sigue convertido y apuntando a ESTE saldo ─────────────────
    const dep = await tx.getDeposito(depositoId);
    if (!dep) throw rechazoSaldo('conversion_inconsistente', 'El depósito del saldo no existe.', { detalle: 'deposito_inexistente' });
    if (dep.estado !== ESTADO_CONVERTIDO) throw rechazoSaldo('conversion_inconsistente', 'El depósito ya no está convertido en deuda.', { detalle: 'deposito_no_convertido' });
    if (dep.saldoId !== saldoId) throw rechazoSaldo('conversion_inconsistente', 'El depósito apunta a otro saldo.', { detalle: 'saldoId_no_coincide' });

    // ── Ledger: UNA conversión activa del saldo y NINGUNA condonación previa ──
    const conversiones = movimientos.filter((m) => m.data.tipo === TIPO_MOVIMIENTO_CONVERSION && estaVivo(m.data));
    if (conversiones.length !== 1) {
      throw rechazoSaldo('conversion_inconsistente', 'El saldo no tiene exactamente un movimiento de conversión activo.', { detalle: conversiones.length === 0 ? 'sin_movimiento_conversion' : 'movimientos_conversion_multiples' });
    }
    const conv = conversiones[0].data;
    if (conv.saldoId !== saldoId || conv.depositoId !== depositoId) {
      throw rechazoSaldo('conversion_inconsistente', 'El movimiento de conversión pertenece a otro ciclo.', { detalle: 'movimiento_de_otro_ciclo' });
    }
    if (condonacionesActivas.length > 0) {
      throw rechazoSaldo('conciliacion_requerida', 'Hay un movimiento de condonación activo para un saldo que no figura condonado. Hay que conciliarlo: no se corrige solo.', { condonaciones: condonacionesActivas.length });
    }

    // ── ESCRITURAS (todas dentro de esta transacción) ─────────────────────────
    const ahora = deps.serverTimestamp();
    const movimientoId = `cond_${saldoId}`;
    const motorizadoId: string = saldo.motorizadoId;
    if (!idValido(motorizadoId)) throw rechazoSaldo('saldo_inconsistente', 'El saldo no tiene motorizado.', {});

    tx.updateSaldo(saldoId, {
      estado: 'condonado',
      saldoPendiente: 0,
      montoCondonado: remanente,
      motivoCondonacion: motivo,
      movimientoCondonacionId: movimientoId,
      condonadoAt: ahora,
      condonadoPorUid: uid,
      condonadoPorRol: rol,
      updatedAt: ahora,
    });
    tx.updateDeposito(depositoId, {
      condonado: true,
      notaCondonacion: motivo,
      updatedAt: ahora,
    });
    tx.crearMovimiento(movimientoId, {
      tipo: TIPO_MOVIMIENTO_CONDONACION,
      monto: remanente,
      at: ahora,
      creadoPorUid: uid,
      creadoPorRol: rol,
      descripcion: `Deuda condonada · ${String(saldo.motorizadoNombre ?? '')} · ${motivo}`,
      estado: 'activo',
      motorizadoId,
      depositoId,
      saldoId,
      cuentaOrigen: cuentas.deudaMotorizado(motorizadoId),
      cuentaDestino: cuentas.perdidaCondonaciones,
      propietario: 'storkhub',
    });

    return {
      ok: true as const,
      resultado: 'condonada' as const,
      saldoId,
      depositoId,
      movimientoId,
      montoCondonado: remanente,
    };
  });
}
