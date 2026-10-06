// ═════════════════════════════════════════════════
// Intención de abono directo — FIN-4C (corrección): la identidad vive en el SERVIDOR
// ═════════════════════════════════════════════════
//
// La preintegración de FIN-4C demostró un blocker real: el operacionId vivía solo en la
// memoria de la pantalla. Commit exitoso → respuesta perdida → recarga → la pantalla
// inventa OTRO operacionId para "la misma" intención → el servidor lo acepta como un abono
// NUEVO (C$100 − 40 − 40 = 20). El servidor no puede distinguir un reintento de un abono
// nuevo del mismo monto si la identidad de la intención no existe antes del efecto.
//
// Esta pieza la hace existir ANTES del efecto y del lado del servidor:
//
//   intenciones_abono_directo/{operacionId}     operacionId lo genera el SERVIDOR
//     { saldoId, monto, metodoAbono, nota?, comprobante*, actorUid, actorRol,
//       estado: 'preparada' | 'aplicada' | 'rechazada', movimientoId?, motivoRechazo?,
//       createdAt, updatedAt, aplicadaAt? }
//   punteros_abono_directo/{saldoId}__{uid}      la intención VIGENTE de ese usuario en ese saldo
//     { intencionId, saldoId, actorUid, updatedAt }
//
// 'preparada' ⇒ NO se aplicó (aplicar y marcarla 'aplicada' ocurren en la MISMA transacción,
// functions/src/abono-directo.ts). Por eso recuperar una intención dice la verdad sobre un
// resultado incierto: si está 'aplicada', el commit ocurrió.
//
// ─── Reintento ≠ abono nuevo ─────────────────────────────────────────────────
//
//   sin intención vigente                 ⇒ crea una (preparada)
//   preparada, mismos parámetros          ⇒ devuelve LA MISMA (recarga, otra pestaña, otro dispositivo)
//   preparada, parámetros distintos       ⇒ NO se reemplaza en silencio: 'operacion_pendiente_existente'
//                                           (se continúa con ella o se descarta explícitamente)
//   aplicada                              ⇒ 'ya_aplicada': NO crea otra. Para un abono NUEVO el cliente
//                                           tiene que RECONOCER esa operación (reconoceOperacionId): "ya vi
//                                           que A quedó aplicada y quiero otro". Es una acción explícita; una
//                                           recarga, cerrar el modal o navegar no lo son.
//   rechazada                             ⇒ está cerrada: se crea una nueva
//
// Reconocer lleva el id de la intención que se vio: si otra pestaña ya creó la siguiente, el
// puntero ya no apunta a esa y el servidor devuelve la vigente en lugar de crear otra más.
//
// El puntero hace que dos "preparar" simultáneos no puedan crear A y B: leen el mismo documento
// dentro de la transacción y Firestore serializa; el segundo relee y recupera la intención creada.
//
// Las intenciones NO caducan ni se borran: son evidencia financiera. Las Rules las cierran al
// cliente (no hay regla para estas colecciones): solo las tocan estas Functions (Admin SDK).

import { HttpsError } from 'firebase-functions/v2/https';
import type { DocumentData } from 'firebase-admin/firestore';
import {
  ESTADOS_ABONABLES, RE_OPERACION_ID, RE_SALDO_ID, centavos, esNumeroFinito, exigirGestorOAdmin,
  rechazo, validarCamposAbono, type CamposAbono,
} from './abono-directo';

export const COLECCION_INTENCIONES = 'intenciones_abono_directo';
export const COLECCION_PUNTEROS = 'punteros_abono_directo';

export type EstadoIntencion = 'preparada' | 'aplicada' | 'rechazada';

/** Lo que se le devuelve al cliente (sin marcas de tiempo del servidor, que no viajan por la callable). */
export interface IntencionPublica {
  operacionId: string;
  saldoId: string;
  monto: number;
  metodoAbono: string;
  estado: EstadoIntencion;
  movimientoId?: string;
  motivoRechazo?: string;
}

export type ResultadoPreparar = {
  ok: true;
  /**
   * 'preparada'   se creó una intención nueva
   * 'recuperada'  ya existía una preparada con los mismos parámetros: es la misma
   * 'ya_aplicada' la intención vigente YA se aplicó y no se reconoció: no se creó otra
   * 'operacion_pendiente_existente'  hay una preparada con OTROS parámetros: no se reemplazó
   */
  resultado: 'preparada' | 'recuperada' | 'ya_aplicada' | 'operacion_pendiente_existente';
  intencion: IntencionPublica;
};

export interface TxIntencion {
  getUsuario(uid: string): Promise<DocumentData | null>;
  getSaldo(id: string): Promise<DocumentData | null>;
  getIntencion(id: string): Promise<DocumentData | null>;
  getPuntero(id: string): Promise<DocumentData | null>;
  crearIntencion(id: string, campos: DocumentData): void;
  updateIntencion(id: string, campos: DocumentData): void;
  setPuntero(id: string, campos: DocumentData): void;
}

export interface DepsIntencion {
  transaction<T>(fn: (tx: TxIntencion) => Promise<T>): Promise<T>;
  serverTimestamp(): unknown;
  /** Id NUEVO para la intención (lo genera el servidor). */
  nuevoId(): string;
}

export interface PeticionPreparar extends CamposAbono {
  saldoId: string;
  reconoceOperacionId?: string;
}

const CLAVES_PREPARAR = ['saldoId', 'monto', 'metodoAbono', 'nota', 'comprobanteUrl', 'comprobantePath', 'reconoceOperacionId'];

function objeto(data: unknown): Record<string, unknown> {
  if (typeof data !== 'object' || data === null || Array.isArray(data)) throw new HttpsError('invalid-argument', 'Petición inválida.');
  return data as Record<string, unknown>;
}

function saldoIdValido(v: unknown): string {
  if (typeof v !== 'string' || !RE_SALDO_ID.test(v)) throw new HttpsError('invalid-argument', 'saldoId inválido.');
  return v;
}

export function validarPeticionPreparar(data: unknown): PeticionPreparar {
  const d = objeto(data);
  if (Object.keys(d).some((k) => !CLAVES_PREPARAR.includes(k))) {
    throw new HttpsError('invalid-argument', `Solo se aceptan los campos ${CLAVES_PREPARAR.join(', ')}.`);
  }
  const saldoId = saldoIdValido(d.saldoId);
  const out: PeticionPreparar = { saldoId, ...validarCamposAbono(d, saldoId) };
  // null (así llega `undefined` desde el SDK de Firebase) == ausente: no reconoce ninguna operación.
  if (d.reconoceOperacionId !== undefined && d.reconoceOperacionId !== null) {
    if (typeof d.reconoceOperacionId !== 'string' || !RE_OPERACION_ID.test(d.reconoceOperacionId)) {
      throw new HttpsError('invalid-argument', 'reconoceOperacionId inválido.');
    }
    out.reconoceOperacionId = d.reconoceOperacionId;
  }
  return out;
}

function validarSoloSaldo(data: unknown): string {
  const d = objeto(data);
  if (Object.keys(d).some((k) => k !== 'saldoId')) throw new HttpsError('invalid-argument', 'Solo se acepta el campo saldoId.');
  return saldoIdValido(d.saldoId);
}

function validarSoloOperacion(data: unknown): string {
  const d = objeto(data);
  if (Object.keys(d).some((k) => k !== 'operacionId')) throw new HttpsError('invalid-argument', 'Solo se acepta el campo operacionId.');
  if (typeof d.operacionId !== 'string' || !RE_OPERACION_ID.test(d.operacionId)) throw new HttpsError('invalid-argument', 'operacionId inválido.');
  return d.operacionId;
}

export function idPuntero(saldoId: string, uid: string): string {
  return `${saldoId}__${uid}`;
}

function publica(id: string, i: DocumentData): IntencionPublica {
  const out: IntencionPublica = {
    operacionId: id,
    saldoId: String(i.saldoId ?? ''),
    monto: i.monto,
    metodoAbono: String(i.metodoAbono ?? ''),
    estado: i.estado,
  };
  if (typeof i.movimientoId === 'string') out.movimientoId = i.movimientoId;
  if (typeof i.motivoRechazo === 'string') out.motivoRechazo = i.motivoRechazo;
  return out;
}

/** La intención vigente de (saldo, usuario), verificada: un puntero colgante o ajeno es una inconsistencia, no se repara. */
async function intencionVigente(tx: Pick<TxIntencion, 'getPuntero' | 'getIntencion'>, saldoId: string, uid: string): Promise<{ id: string; data: DocumentData } | null> {
  const p = await tx.getPuntero(idPuntero(saldoId, uid));
  if (!p) return null;
  const id = typeof p.intencionId === 'string' ? p.intencionId : '';
  const i = id ? await tx.getIntencion(id) : null;
  if (!i || i.saldoId !== saldoId || i.actorUid !== uid || !['preparada', 'aplicada', 'rechazada'].includes(i.estado)) {
    throw rechazo('abono_inconsistente', 'La intención vigente de este saldo no es coherente. Hay que revisarla; no se corrige sola.');
  }
  return { id, data: i };
}

export async function prepararAbonoDirectoCore(deps: DepsIntencion, uid: string | undefined, data: unknown): Promise<ResultadoPreparar> {
  if (!uid) throw new HttpsError('unauthenticated', 'Debés iniciar sesión.');
  const req = validarPeticionPreparar(data);

  return deps.transaction(async (tx) => {
    const rol = exigirGestorOAdmin(await tx.getUsuario(uid));
    const saldo = await tx.getSaldo(req.saldoId);
    if (!saldo) throw new HttpsError('not-found', 'El saldo no existe.');
    const vigente = await intencionVigente(tx, req.saldoId, uid);

    if (vigente) {
      const { id, data: i } = vigente;
      if (i.estado === 'preparada') {
        const mismos = esNumeroFinito(i.monto) && centavos(i.monto) === centavos(req.monto) && i.metodoAbono === req.metodoAbono;
        if (!mismos) return { ok: true as const, resultado: 'operacion_pendiente_existente' as const, intencion: publica(id, i) };
        // La misma intención: solo la metadata (nota, comprobante) puede refrescarse.
        const meta: DocumentData = {};
        if (req.nota !== (i.nota ?? '')) meta.nota = req.nota;
        if (req.comprobanteUrl && req.comprobanteUrl !== i.comprobanteUrl) meta.comprobanteUrl = req.comprobanteUrl;
        if (req.comprobantePath && req.comprobantePath !== i.comprobantePath) meta.comprobantePath = req.comprobantePath;
        if (Object.keys(meta).length > 0) tx.updateIntencion(id, { ...meta, updatedAt: deps.serverTimestamp() });
        return { ok: true as const, resultado: 'recuperada' as const, intencion: publica(id, i) };
      }
      if (i.estado === 'aplicada' && req.reconoceOperacionId !== id) {
        // Pudo no haberla visto: se le dice que ya está aplicada, no se crea otra.
        return { ok: true as const, resultado: 'ya_aplicada' as const, intencion: publica(id, i) };
      }
      // aplicada y RECONOCIDA, o rechazada (cerrada): sigue una intención nueva.
    }

    // Una intención nueva solo nace si el abono tiene sentido hoy: no se crean intenciones condenadas.
    const estado = String(saldo.estado ?? '');
    if (!ESTADOS_ABONABLES.includes(estado)) {
      throw rechazo('saldo_no_abonable', `No se puede abonar un saldo en estado "${estado || 'desconocido'}".`, { estado });
    }
    if (!esNumeroFinito(saldo.saldoPendiente) || saldo.saldoPendiente < 0 || centavos(saldo.saldoPendiente) <= 0) {
      throw rechazo('saldo_no_abonable', 'El saldo no tiene monto pendiente.', { estado });
    }
    if (centavos(req.monto) > centavos(saldo.saldoPendiente)) {
      throw rechazo('monto_excede_saldo', `El monto (${req.monto}) supera el saldo pendiente actual (${saldo.saldoPendiente}).`, { saldoPendiente: saldo.saldoPendiente });
    }

    const id = deps.nuevoId();
    const ahora = deps.serverTimestamp();
    const nueva: DocumentData = {
      saldoId: req.saldoId,
      monto: req.monto,
      metodoAbono: req.metodoAbono,
      nota: req.nota,
      actorUid: uid,
      actorRol: rol,
      estado: 'preparada',
      createdAt: ahora,
      updatedAt: ahora,
    };
    if (req.comprobanteUrl) nueva.comprobanteUrl = req.comprobanteUrl;
    if (req.comprobantePath) nueva.comprobantePath = req.comprobantePath;
    tx.crearIntencion(id, nueva);
    tx.setPuntero(idPuntero(req.saldoId, uid), { intencionId: id, saldoId: req.saldoId, actorUid: uid, updatedAt: ahora });
    return { ok: true as const, resultado: 'preparada' as const, intencion: publica(id, nueva) };
  });
}

/** Solo lectura: la intención vigente de este usuario en este saldo (o ninguna). Es lo que se reconcilia al abrir/recargar. */
export async function obtenerIntencionAbonoCore(deps: DepsIntencion, uid: string | undefined, data: unknown): Promise<{ ok: true; intencion: IntencionPublica | null }> {
  if (!uid) throw new HttpsError('unauthenticated', 'Debés iniciar sesión.');
  const saldoId = validarSoloSaldo(data);
  return deps.transaction(async (tx) => {
    exigirGestorOAdmin(await tx.getUsuario(uid));
    const vigente = await intencionVigente(tx, saldoId, uid);
    return { ok: true as const, intencion: vigente ? publica(vigente.id, vigente.data) : null };
  });
}

/**
 * El abandono EXPLÍCITO de una intención preparada. Solo una preparada se descarta: como 'preparada'
 * significa "no se aplicó", descartarla no puede deshacer un abono. Una aplicada no se descarta.
 */
export async function descartarIntencionAbonoCore(deps: DepsIntencion, uid: string | undefined, data: unknown): Promise<{ ok: true; resultado: 'descartada' | 'ya_descartada'; intencion: IntencionPublica }> {
  if (!uid) throw new HttpsError('unauthenticated', 'Debés iniciar sesión.');
  const operacionId = validarSoloOperacion(data);
  return deps.transaction(async (tx) => {
    exigirGestorOAdmin(await tx.getUsuario(uid));
    const i = await tx.getIntencion(operacionId);
    if (!i) throw rechazo('intencion_inexistente', 'La operación no existe.');
    if (i.actorUid !== uid) throw rechazo('intencion_ajena', 'Esta operación pertenece a otro usuario.');
    if (i.estado === 'aplicada') throw rechazo('intencion_cerrada', 'Esta operación ya se aplicó: no se puede descartar.', { estadoIntencion: 'aplicada' });
    if (i.estado === 'rechazada') return { ok: true as const, resultado: 'ya_descartada' as const, intencion: publica(operacionId, i) };
    tx.updateIntencion(operacionId, { estado: 'rechazada', motivoRechazo: 'descartada_por_usuario', updatedAt: deps.serverTimestamp() });
    return { ok: true as const, resultado: 'descartada' as const, intencion: publica(operacionId, { ...i, estado: 'rechazada', motivoRechazo: 'descartada_por_usuario' }) };
  });
}
