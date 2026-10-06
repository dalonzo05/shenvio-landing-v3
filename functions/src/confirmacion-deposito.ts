// ═════════════════════════════════════════════════
// confirmarDeposito — FIN-3: confirmación de depósito AUTORITATIVA e IDEMPOTENTE
// ═════════════════════════════════════════════════
//
// Antes de FIN-3 confirmar un depósito era una secuencia de commits de cliente:
//
//   1. batch: depósito → 'confirmado' + evento DEPOSITO_CONFIRMADO
//   2. batch: punteros/flags de las órdenes
//   3. registrarMovimiento(): el ledger, con su PROPIO addDoc, que además
//      "nunca lanza" (solo logea)
//
// Si 2 o 3 fallaban quedaba un depósito confirmado sin ledger (o sin órdenes).
// Dos pestañas, o un reintento tras perder la respuesta, creaban un segundo
// movimiento. Y el monto confirmado era el que viajaba en el documento: nadie lo
// demostraba contra las órdenes ni contra los gastos.
//
// Esta Function reemplaza esa secuencia por UNA transacción:
//
//   - La identidad sale de request.auth, y el rol de usuarios/{uid}.
//   - El cliente solo manda `depositoId`. Monto, órdenes, gastos, motorizado,
//     destino y estado se RELEEN y se DEMUESTRAN dentro de la transacción.
//   - Depósito, evento, órdenes y movimiento del ledger se escriben juntos, o
//     no se escribe nada.
//
// ─── Idempotencia (por qué no basta "este depositoId ya se confirmó") ─────────
//
// El ciclo de vida legítimo es  en_revision → confirmado → REHACER → en_revision
// → confirmado.  Un depósito puede confirmarse más de una vez A LO LARGO DE SU
// VIDA, nunca dos veces en el MISMO ciclo. Por eso la guarda es el ESTADO
// releído dentro de la transacción, no una marca permanente:
//
//   en_revision                ⇒ abre un ciclo nuevo: evento nuevo, UN movimiento
//   confirmado                 ⇒ el ciclo ya cerró: no escribe nada y responde
//                                 'ya_confirmado' (doble clic, dos gestores,
//                                 reintento tras perder la respuesta)
//   cualquier otro estado      ⇒ failed-precondition
//
// Firestore serializa las transacciones concurrentes: la segunda detecta que el
// documento cambió, se reintenta y lee 'confirmado'.
//
// Además, el movimiento tiene un id DETERMINISTA del ciclo (`conf_<eventoId>`) y
// se crea con create(): aunque algo fallara en la guarda de estado, el mismo
// ciclo no puede escribir dos movimientos. Y antes de abrir un ciclo se exige
// que el depósito NO tenga movimientos activos: Rehacer (FIN-5) los anula, y un
// depósito en revisión con ledger activo es una inconsistencia que se REPORTA,
// no se repara en silencio.
//
// ─── Lo que NO cierra ────────────────────────────────────────────────────────
//
// FIN-1 (las Rules siguen permitiendo al gestor escribir el ledger y los
// depósitos desde un cliente modificado), FIN-4 (conversión/reversión/abonos), el
// backfill de gastos de FIN-2 y la concurrencia de las demás transiciones.
//
// Patrón: núcleo con dependencias inyectadas (como asignacion-motorizado.ts) para
// poder probar la transacción sin Firestore real.

import { HttpsError } from 'firebase-functions/v2/https';
import type { DocumentData } from 'firebase-admin/firestore';
import { cuentas } from './financial-types';
import {
  TIPO_DEPOSITO_STORKHUB,
  TIPO_DEPOSITO_COMERCIO,
  MAX_ORDENES_POR_DEPOSITO,
  demostrarDeposito,
  esNumeroFinito,
  rechazo,
  type MotivoRechazo,
} from './deposito-monto';

// Siguen exportados desde aquí: los tests y el adaptador de FIN-3 los importan de este módulo.
export { TIPO_DEPOSITO_STORKHUB, TIPO_DEPOSITO_COMERCIO, MAX_ORDENES_POR_DEPOSITO };
export type { MotivoRechazo };
export const ESTADO_CONFIRMABLE = 'en_revision';
export const ESTADO_CONFIRMADO = 'confirmado';
export const EVENTO_DEPOSITO_CONFIRMADO = 'DEPOSITO_CONFIRMADO';

const MAX_ID = 200;

export type ResultadoConfirmacion = {
  ok: true;
  /** 'confirmado': se abrió y cerró un ciclo. 'ya_confirmado': el ciclo ya estaba cerrado; no se escribió nada. */
  resultado: 'confirmado' | 'ya_confirmado';
  depositoId: string;
  movimientoId: string | null;
  montoTotal: number;
  estadoAnterior: string;
  estadoNuevo: string;
};

export interface TxConfirmacion {
  getUsuario(uid: string): Promise<DocumentData | null>;
  getDeposito(id: string): Promise<DocumentData | null>;
  /** Doc id canónico del motorizado a partir de su authUid, o null si no hay (docs antiguos usan el authUid). */
  getMotorizadoDocId(authUid: string): Promise<string | null>;
  getSolicitud(id: string): Promise<DocumentData | null>;
  getGasto(id: string): Promise<DocumentData | null>;
  /** TODOS los movimientos del ledger con depositoId == id (activos y anulados). */
  getMovimientosDeDeposito(depositoId: string): Promise<Array<{ id: string; data: DocumentData }>>;
  updateDeposito(id: string, campos: DocumentData): void;
  crearEvento(depositoId: string, eventoId: string, campos: DocumentData): void;
  updateSolicitud(id: string, campos: DocumentData): void;
  crearMovimiento(id: string, campos: DocumentData): void;
}

export interface DepsConfirmacion {
  transaction<T>(fn: (tx: TxConfirmacion) => Promise<T>): Promise<T>;
  serverTimestamp(): unknown;
  /** Id nuevo para el evento del ciclo. */
  nuevoEventoId(): string;
}

function idValido(v: unknown): v is string {
  return typeof v === 'string' && v.trim().length > 0 && v.length <= MAX_ID;
}

/** El único campo aceptado es `depositoId`: ni monto, ni estado, ni actor, ni órdenes. */
export function validarPeticionConfirmacion(data: unknown): string {
  if (typeof data !== 'object' || data === null || Array.isArray(data)) {
    throw new HttpsError('invalid-argument', 'Petición inválida.');
  }
  const claves = Object.keys(data);
  if (claves.length !== 1 || claves[0] !== 'depositoId' || !idValido((data as { depositoId?: unknown }).depositoId)) {
    throw new HttpsError('invalid-argument', 'Solo se acepta el campo depositoId.');
  }
  return ((data as { depositoId: string }).depositoId).trim();
}

/** Mismo criterio que isAdminOrGestor() en firestore.rules: usuario ACTIVO con rol admin o gestor. */
function exigirGestorOAdmin(usuario: DocumentData | null): 'admin' | 'gestor' {
  const rol = usuario?.rol;
  if (!usuario || usuario.activo !== true || (rol !== 'admin' && rol !== 'gestor')) {
    throw new HttpsError('permission-denied', 'Solo un gestor o admin activo puede confirmar un depósito.');
  }
  return rol;
}

export async function confirmarDepositoCore(
  deps: DepsConfirmacion,
  uid: string | undefined,
  data: unknown,
): Promise<ResultadoConfirmacion> {
  if (!uid) throw new HttpsError('unauthenticated', 'Debés iniciar sesión.');
  const depositoId = validarPeticionConfirmacion(data);

  return deps.transaction(async (tx) => {
    // ── LECTURAS (todas antes de cualquier escritura) ─────────────────────────
    const rol = exigirGestorOAdmin(await tx.getUsuario(uid));

    const dep = await tx.getDeposito(depositoId);
    if (!dep) throw new HttpsError('not-found', 'El depósito no existe.');

    if (dep.tipo !== TIPO_DEPOSITO_STORKHUB && dep.tipo !== TIPO_DEPOSITO_COMERCIO) {
      throw rechazo('tipo_no_confirmable', 'Este tipo de depósito no se confirma desde Depósitos.');
    }
    const esStorkhub = dep.tipo === TIPO_DEPOSITO_STORKHUB;
    const estadoAnterior = String(dep.estado ?? '');

    const movimientos = await tx.getMovimientosDeDeposito(depositoId);
    const activos = movimientos.filter((m) => m.data.estado !== 'anulado');

    // Guarda de idempotencia: el estado releído DENTRO de la transacción.
    if (estadoAnterior === ESTADO_CONFIRMADO) {
      return {
        ok: true as const,
        resultado: 'ya_confirmado' as const,
        depositoId,
        movimientoId: activos.length === 1 ? activos[0].id : null,
        montoTotal: esNumeroFinito(dep.montoTotal) ? dep.montoTotal : 0,
        estadoAnterior,
        estadoNuevo: ESTADO_CONFIRMADO,
      };
    }
    if (estadoAnterior !== ESTADO_CONFIRMABLE) {
      throw rechazo('estado_cambio', `El depósito está en estado "${estadoAnterior || 'desconocido'}" y no se puede confirmar. Actualizá la pantalla.`, { estado: estadoAnterior });
    }
    // Un depósito en revisión NO debería tener ledger activo (Rehacer lo anula).
    if (activos.length > 0) {
      throw rechazo('ledger_inconsistente', 'El depósito tiene movimientos activos sin estar confirmado. Hay que revisarlo antes de confirmar.', { activos: activos.length });
    }

    // ── Órdenes, gastos (FIN-2) y monto: se DEMUESTRAN (deposito-monto.ts) ─────
    // La misma demostración que usa la conversión en deuda (FIN-4A).
    const { solicitudIds, motDocId, montoTotal } = await demostrarDeposito(tx, dep, depositoId);

    // ── ESCRITURAS (todas dentro de esta transacción) ─────────────────────────
    const ahora = deps.serverTimestamp();
    const eventoId = deps.nuevoEventoId();
    const movimientoId = `conf_${eventoId}`;

    tx.updateDeposito(depositoId, {
      estado: ESTADO_CONFIRMADO,
      confirmadoPorUid: uid,
      confirmadoAt: ahora,
      ultimoEventoId: eventoId,
    });
    tx.crearEvento(depositoId, eventoId, {
      tipo: EVENTO_DEPOSITO_CONFIRMADO,
      at: ahora,
      porUid: uid,
      porRol: rol,
    });
    const flags = esStorkhub
      ? { 'registro.deposito.confirmadoStorkhub': true, 'registro.deposito.confirmadoStorkhubAt': ahora, 'registro.deposito.storkhubDepositoId': depositoId }
      : { 'registro.deposito.confirmadoComercio': true, 'registro.deposito.confirmadoComercioAt': ahora, 'registro.deposito.comercioDepositoId': depositoId };
    for (const sid of solicitudIds) tx.updateSolicitud(sid, flags);

    const destinatarioNombre = dep.destinatarioNombre ?? '';
    const motorizadoNombre = dep.motorizadoNombre ?? '';
    tx.crearMovimiento(movimientoId, {
      tipo: esStorkhub ? 'deposito_efectivo_storkhub' : 'deposito_efectivo_comercio',
      monto: montoTotal,
      at: ahora,
      creadoPorUid: uid,
      creadoPorRol: 'gestor', // el tipo del ledger solo admite gestor|motorizado|sistema; el rol real queda en el evento
      descripcion: `Depósito confirmado · ${destinatarioNombre} · ${motorizadoNombre}`,
      estado: 'activo',
      depositoId,
      motorizadoId: motDocId,
      ...(esStorkhub ? {} : { comercioId: dep.destinatarioId }),
      cuentaOrigen: cuentas.efectivoEnPoder(motDocId),
      cuentaDestino: esStorkhub ? cuentas.banco : cuentas.saldoComercio(dep.destinatarioId),
      propietario: esStorkhub ? 'storkhub' : `comercio:${dep.destinatarioId}`,
    });

    return {
      ok: true as const,
      resultado: 'confirmado' as const,
      depositoId,
      movimientoId,
      montoTotal,
      estadoAnterior,
      estadoNuevo: ESTADO_CONFIRMADO,
    };
  });
}
