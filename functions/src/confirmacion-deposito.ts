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
import { calcularDeposito } from './calculo-deposito';
import { cuentas } from './financial-types';

export const TIPO_DEPOSITO_STORKHUB = 'recaudacion_motorizado_storkhub';
export const TIPO_DEPOSITO_COMERCIO = 'recaudacion_motorizado_comercio';
export const ESTADO_CONFIRMABLE = 'en_revision';
export const ESTADO_CONFIRMADO = 'confirmado';
export const EVENTO_DEPOSITO_CONFIRMADO = 'DEPOSITO_CONFIRMADO';

/**
 * Tope de órdenes por depósito. La transacción escribe 1 depósito + 1 evento +
 * N órdenes + 1 movimiento, y Firestore admite 500 escrituras por transacción.
 * Un depósito real agrupa unas pocas órdenes; el tope existe para fallar con un
 * mensaje claro y no con un error opaco de Firestore.
 */
export const MAX_ORDENES_POR_DEPOSITO = 450;
const MAX_ID = 200;

export type MotivoRechazo =
  | 'estado_cambio'
  | 'tipo_no_confirmable'
  | 'sin_ordenes'
  | 'demasiadas_ordenes'
  | 'orden_invalida'
  | 'gasto_invalido'
  | 'gasto_sin_marca'
  | 'monto_inconsistente'
  | 'ledger_inconsistente';

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

function rechazo(motivo: MotivoRechazo, mensaje: string, extra: Record<string, unknown> = {}): HttpsError {
  return new HttpsError('failed-precondition', mensaje, { motivo, ...extra });
}

function esNumeroFinito(v: unknown): v is number {
  return typeof v === 'number' && Number.isFinite(v);
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

function idsUnicos(v: unknown): string[] {
  if (!Array.isArray(v)) return [];
  return [...new Set(v.filter((x): x is string => typeof x === 'string' && x.length > 0))];
}

function mismoMonto(a: unknown, b: number): boolean {
  return esNumeroFinito(a) && Math.abs(a - b) < 0.005;
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

    // ── Órdenes ───────────────────────────────────────────────────────────────
    const solicitudIds = idsUnicos(dep.solicitudIds);
    if (solicitudIds.length === 0) throw rechazo('sin_ordenes', 'El depósito no tiene órdenes asociadas.');
    if (solicitudIds.length > MAX_ORDENES_POR_DEPOSITO) {
      throw rechazo('demasiadas_ordenes', `El depósito supera el máximo de ${MAX_ORDENES_POR_DEPOSITO} órdenes por confirmación.`);
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

    // ── Gastos (FIN-2): FIN-3 CONFIRMA lo que FIN-2 ya consumió ───────────────
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

    // ── Monto: se DEMUESTRA, no se acepta ─────────────────────────────────────
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
      throw rechazo('monto_inconsistente', 'El monto guardado del depósito no coincide con sus órdenes y gastos. No se confirma ni se corrige solo.', {
        esperado: { montoBruto, gastosDescontados, montoTotal },
      });
    }

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
