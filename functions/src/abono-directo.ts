// ═════════════════════════════════════════════════
// registrarAbonoDirecto — FIN-4C: abono directo AUTORITATIVO e IDEMPOTENTE
// ═════════════════════════════════════════════════
//
// Antes de FIN-4C el abono directo del gestor/admin era un writer de cliente
// (lib/financial-writes.ts: registrarAbonoSaldo) que abría una transacción CLIENTE:
//
//   - la única validación de monto vivía en la pantalla, sobre el snapshot de React
//     (monto > 0 y monto <= saldoPendiente); la transacción NO validaba nada y
//     escondía el sobre-abono con Math.max(0, pendiente - monto): un abono de C$500
//     sobre un saldo de C$100 dejaba pendiente 0 y un movimiento de C$500;
//   - tampoco miraba el estado: un saldo anulado, condonado o pagado recibía el
//     abono y pasaba a 'pagado' / 'abonado_parcial' (se "resucitaba");
//   - no había identidad de la operación: un reintento tras perder la respuesta, o un
//     doble clic, aplicaba el abono dos veces (dos entradas en abonos[] y dos
//     movimientos, ids aleatorios);
//   - el actor era `auth.currentUser?.uid` del cliente, el rol quedaba fijo en
//     'gestor' aunque actuara un admin, y el motorizado de la cuenta del ledger
//     viajaba desde la pantalla.
//
// Esta Function reemplaza ese writer por UNA transacción:
//
//   - La identidad sale de request.auth y el rol de usuarios/{uid}.
//   - El cliente manda la INTENCIÓN: saldoId, monto, operacionId y la metadata del
//     producto (método, nota, comprobante). El monto es una intención legítima, NO una
//     autoridad: se valida contra el saldo RELEÍDO dentro de la transacción.
//   - Saldo (pendiente, estado, abonos[]) y movimiento del ledger se escriben juntos, o
//     no se escribe nada.
//
// ─── Idempotencia (por qué `operacionId`) ────────────────────────────────────
//
// Dos abonos legítimos pueden tener EXACTAMENTE el mismo monto sobre el mismo saldo
// (C$30 y C$30). Deduplicar por saldo, por monto, por saldo+monto o por actor los
// fusionaría o rechazaría. La identidad tiene que ser la de la INTENCIÓN: el cliente
// genera un `operacionId` al iniciar el submit, lo conserva mientras el resultado sea
// incierto y estrena uno nuevo para el siguiente abono.
//
//   movimiento   id determinista `abono_<operacionId>`, creado con create()
//   abonos[]     la entrada lleva `operacionId` y `movimientoId` (abono ↔ movimiento 1:1)
//
// La guarda es el estado releído DENTRO de la transacción (no la UI): si la operación ya
// está aplicada y es COHERENTE ⇒ 'ya_aplicado' sin escribir nada; si el mismo operacionId
// llega con otro saldo, otro monto u otro método ⇒ 'conflicto_idempotencia'; si falta
// una de las dos piezas (abono sin movimiento, movimiento sin abono) ⇒
// 'abono_inconsistente', sin reparar en silencio.
//
// La guarda de idempotencia va ANTES de validar estado y monto: el reintento de un
// abono que ya dejó el saldo 'pagado' no puede ser rechazado por "saldo no abonable".
//
// ─── Lo que NO cierra ────────────────────────────────────────────────────────
//
// FIN-4B (revertir), FIN-1 (las Rules siguen permitiendo al gestor escribir saldos y
// ledger desde un cliente modificado), liquidaciones (su abono inline), propuestas de
// abono, condonación y anular saldo.

import { HttpsError } from 'firebase-functions/v2/https';
import type { DocumentData } from 'firebase-admin/firestore';
import { cuentas } from './financial-types';

export const ESTADOS_ABONABLES: readonly string[] = ['pendiente', 'abonado_parcial'];
export const METODOS_ABONO: readonly string[] = ['transferencia', 'descuento_liquidacion', 'ajuste_manual'];
export const TIPO_MOVIMIENTO_ABONO = 'abono_deuda_motorizado';
export const RE_OPERACION_ID = /^[A-Za-z0-9_-]{16,64}$/;
const CLAVES_PETICION = ['saldoId', 'monto', 'operacionId', 'metodoAbono', 'nota', 'comprobanteUrl', 'comprobantePath'];
const MAX_ID = 200;
const MAX_NOTA = 500;
const MAX_URL = 2048;
const MAX_PATH = 300;
const MAX_MONTO = 1_000_000_000;

export type MotivoRechazoAbono =
  | 'saldo_no_abonable'
  | 'monto_excede_saldo'
  | 'conflicto_idempotencia'
  | 'abono_inconsistente';

export interface PeticionAbono {
  saldoId: string;
  monto: number;
  operacionId: string;
  metodoAbono: string;
  nota: string;
  comprobanteUrl?: string;
  comprobantePath?: string;
}

export type ResultadoAbono = {
  ok: true;
  /** 'aplicado': se escribió el abono. 'ya_aplicado': la operación ya estaba aplicada y coherente; no se escribió nada. */
  resultado: 'aplicado' | 'ya_aplicado';
  saldoId: string;
  operacionId: string;
  movimientoId: string;
  monto: number;
  estadoAnterior: string;
  estadoNuevo: string;
  /** null en 'ya_aplicado': el saldo anterior de aquella operación ya no se conoce. */
  saldoPendienteAnterior: number | null;
  saldoPendiente: number;
};

export interface TxAbono {
  getUsuario(uid: string): Promise<DocumentData | null>;
  getSaldo(id: string): Promise<DocumentData | null>;
  getMovimiento(id: string): Promise<DocumentData | null>;
  updateSaldo(id: string, campos: DocumentData): void;
  crearMovimiento(id: string, campos: DocumentData): void;
}

export interface DepsAbono {
  transaction<T>(fn: (tx: TxAbono) => Promise<T>): Promise<T>;
  /** FieldValue.serverTimestamp(): para campos de primer nivel. */
  serverTimestamp(): unknown;
  /** Timestamp.now(): serverTimestamp() no puede ir dentro de un objeto de un array. */
  ahora(): unknown;
}

function rechazo(motivo: MotivoRechazoAbono, mensaje: string, extra: Record<string, unknown> = {}): HttpsError {
  return new HttpsError('failed-precondition', mensaje, { motivo, ...extra });
}

function esNumeroFinito(v: unknown): v is number {
  return typeof v === 'number' && Number.isFinite(v);
}

function idValido(v: unknown): v is string {
  return typeof v === 'string' && v.trim().length > 0 && v.length <= MAX_ID;
}

/** Centavos enteros: el dinero se compara sin errores de coma flotante. */
function centavos(n: number): number {
  return Math.round(n * 100);
}

function tieneAcuerdoDeCentavos(n: number): boolean {
  return Math.abs(n * 100 - Math.round(n * 100)) < 1e-6;
}

/**
 * Payload estricto. Acepta la INTENCIÓN del usuario y la metadata del producto; nunca
 * saldo pendiente, monto original, estado, motorizado, depósito, actor, rol ni hora.
 */
export function validarPeticionAbono(data: unknown): PeticionAbono {
  if (typeof data !== 'object' || data === null || Array.isArray(data)) {
    throw new HttpsError('invalid-argument', 'Petición inválida.');
  }
  const d = data as Record<string, unknown>;
  if (Object.keys(d).some((k) => !CLAVES_PETICION.includes(k))) {
    throw new HttpsError('invalid-argument', `Solo se aceptan los campos ${CLAVES_PETICION.join(', ')}.`);
  }
  if (!idValido(d.saldoId)) throw new HttpsError('invalid-argument', 'saldoId inválido.');
  const saldoId = d.saldoId.trim();
  if (typeof d.operacionId !== 'string' || !RE_OPERACION_ID.test(d.operacionId)) {
    throw new HttpsError('invalid-argument', 'operacionId inválido: de 16 a 64 caracteres (letras, números, guion o guion bajo).');
  }
  if (!esNumeroFinito(d.monto) || d.monto <= 0 || d.monto > MAX_MONTO || !tieneAcuerdoDeCentavos(d.monto)) {
    throw new HttpsError('invalid-argument', 'El monto debe ser un número mayor que 0, con a lo sumo 2 decimales.');
  }
  if (typeof d.metodoAbono !== 'string' || !METODOS_ABONO.includes(d.metodoAbono)) {
    throw new HttpsError('invalid-argument', 'metodoAbono inválido.');
  }
  let nota = '';
  if (d.nota !== undefined && d.nota !== null) {
    if (typeof d.nota !== 'string' || d.nota.length > MAX_NOTA) throw new HttpsError('invalid-argument', `La nota no puede superar ${MAX_NOTA} caracteres.`);
    nota = d.nota.trim();
  }
  const out: PeticionAbono = { saldoId, monto: d.monto, operacionId: d.operacionId, metodoAbono: d.metodoAbono, nota };
  if (d.comprobanteUrl !== undefined) {
    if (typeof d.comprobanteUrl !== 'string' || !d.comprobanteUrl.startsWith('https://') || d.comprobanteUrl.length > MAX_URL) {
      throw new HttpsError('invalid-argument', 'comprobanteUrl inválido.');
    }
    out.comprobanteUrl = d.comprobanteUrl;
  }
  if (d.comprobantePath !== undefined) {
    // El comprobante de un abono vive en saldos/<saldoId>/…: no se acepta una ruta de otro lado.
    if (typeof d.comprobantePath !== 'string' || !d.comprobantePath.startsWith(`saldos/${saldoId}/`) || d.comprobantePath.includes('..') || d.comprobantePath.length > MAX_PATH) {
      throw new HttpsError('invalid-argument', 'comprobantePath inválido.');
    }
    out.comprobantePath = d.comprobantePath;
  }
  return out;
}

/** Mismo criterio que isAdminOrGestor() en firestore.rules: usuario ACTIVO con rol admin o gestor. */
function exigirGestorOAdmin(usuario: DocumentData | null): 'admin' | 'gestor' {
  const rol = usuario?.rol;
  if (!usuario || usuario.activo !== true || (rol !== 'admin' && rol !== 'gestor')) {
    throw new HttpsError('permission-denied', 'Solo un gestor o admin activo puede registrar un abono.');
  }
  return rol;
}

/**
 * La operación ya dejó huella (un abono con su operacionId en el saldo y/o su movimiento).
 * Se resuelve SIEMPRE a 'ya_aplicado' (coherente) o a un error; nunca escribe.
 */
function resolverOperacionExistente(
  req: PeticionAbono,
  saldo: DocumentData,
  abono: DocumentData | undefined,
  mov: DocumentData | null,
  movimientoId: string,
): ResultadoAbono {
  if (!abono && mov) {
    // El mismo operacionId ya se usó en OTRO saldo: no es un reintento, es un conflicto.
    if (mov.saldoId !== req.saldoId) {
      throw rechazo('conflicto_idempotencia', 'Esta operación ya se aplicó sobre otro saldo. No se registró nada.');
    }
    throw rechazo('abono_inconsistente', 'Hay un movimiento de esta operación pero el saldo no tiene su abono. Hay que revisarlo; no se corrige solo.');
  }
  if (abono && !mov) {
    throw rechazo('abono_inconsistente', 'El saldo tiene el abono de esta operación pero falta su movimiento contable. Hay que revisarlo; no se corrige solo.');
  }
  // abono && mov
  const a = abono as DocumentData;
  const m = mov as DocumentData;
  if (centavos(a.monto) !== centavos(req.monto) || a.metodoAbono !== req.metodoAbono) {
    throw rechazo('conflicto_idempotencia', 'Esta operación ya se aplicó con otro monto o método. No se registró nada.');
  }
  const coherente = m.tipo === TIPO_MOVIMIENTO_ABONO
    && m.estado === 'activo'
    && m.saldoId === req.saldoId
    && esNumeroFinito(a.monto) && esNumeroFinito(m.monto) && centavos(m.monto) === centavos(a.monto)
    && (a.movimientoId === undefined || a.movimientoId === movimientoId);
  if (!coherente) {
    throw rechazo('abono_inconsistente', 'El abono y su movimiento de esta operación no coinciden. Hay que revisarlo; no se corrige solo.');
  }
  return {
    ok: true as const,
    resultado: 'ya_aplicado' as const,
    saldoId: req.saldoId,
    operacionId: req.operacionId,
    movimientoId,
    monto: a.monto,
    estadoAnterior: String(saldo.estado ?? ''),
    estadoNuevo: String(saldo.estado ?? ''),
    saldoPendienteAnterior: null,
    saldoPendiente: esNumeroFinito(saldo.saldoPendiente) ? saldo.saldoPendiente : 0,
  };
}

export async function registrarAbonoDirectoCore(
  deps: DepsAbono,
  uid: string | undefined,
  data: unknown,
): Promise<ResultadoAbono> {
  if (!uid) throw new HttpsError('unauthenticated', 'Debés iniciar sesión.');
  const req = validarPeticionAbono(data);
  const movimientoId = `abono_${req.operacionId}`;

  return deps.transaction(async (tx) => {
    // ── LECTURAS (todas antes de cualquier escritura) ─────────────────────────
    const rol = exigirGestorOAdmin(await tx.getUsuario(uid));

    const saldo = await tx.getSaldo(req.saldoId);
    if (!saldo) throw new HttpsError('not-found', 'El saldo no existe.');
    const mov = await tx.getMovimiento(movimientoId);
    const abonos: DocumentData[] = Array.isArray(saldo.abonos) ? saldo.abonos : [];
    const abonoExistente = abonos.find((a) => a && a.operacionId === req.operacionId);

    // Guarda de idempotencia: ANTES de validar estado y monto (ver cabecera).
    if (abonoExistente || mov) {
      return resolverOperacionExistente(req, saldo, abonoExistente, mov, movimientoId);
    }

    // ── Validación contra el saldo REAL releído ───────────────────────────────
    const estadoAnterior = String(saldo.estado ?? '');
    if (!ESTADOS_ABONABLES.includes(estadoAnterior)) {
      throw rechazo('saldo_no_abonable', `No se puede abonar un saldo en estado "${estadoAnterior || 'desconocido'}".`, { estado: estadoAnterior });
    }
    // Sin identidad suficiente para el ledger no se inventa nada.
    if (typeof saldo.motorizadoId !== 'string' || saldo.motorizadoId.length === 0 || !esNumeroFinito(saldo.saldoPendiente) || saldo.saldoPendiente < 0) {
      throw rechazo('abono_inconsistente', 'El saldo no tiene los datos necesarios (motorizado, pendiente) para abonarlo con seguridad.');
    }
    const pendienteC = centavos(saldo.saldoPendiente);
    const montoC = centavos(req.monto);
    if (pendienteC <= 0) {
      throw rechazo('saldo_no_abonable', 'El saldo no tiene monto pendiente.', { estado: estadoAnterior });
    }
    if (montoC > pendienteC) {
      throw rechazo('monto_excede_saldo', `El monto (${req.monto}) supera el saldo pendiente actual (${saldo.saldoPendiente}).`, { saldoPendiente: saldo.saldoPendiente });
    }

    // ── ESCRITURAS (todas dentro de esta transacción) ─────────────────────────
    const nuevoPendiente = (pendienteC - montoC) / 100;
    const estadoNuevo = pendienteC - montoC === 0 ? 'pagado' : 'abonado_parcial';
    const ahora = deps.serverTimestamp();

    const abono: Record<string, unknown> = {
      monto: req.monto,
      fecha: deps.ahora(),
      metodoAbono: req.metodoAbono,
      nota: req.nota,
      creadoPorUid: uid,
      creadoPorRol: rol,
      operacionId: req.operacionId,
      movimientoId,
    };
    if (req.comprobanteUrl) abono.comprobanteUrl = req.comprobanteUrl;
    if (req.comprobantePath) abono.comprobantePath = req.comprobantePath;

    tx.updateSaldo(req.saldoId, {
      saldoPendiente: nuevoPendiente,
      estado: estadoNuevo,
      abonos: [...abonos, abono],
      updatedAt: ahora,
    });

    tx.crearMovimiento(movimientoId, {
      tipo: TIPO_MOVIMIENTO_ABONO,
      monto: req.monto,
      at: ahora,
      creadoPorUid: uid,
      creadoPorRol: rol,
      descripcion: `Abono deuda (${req.metodoAbono}) · ${saldo.motorizadoNombre ?? ''}`,
      estado: 'activo',
      // La cuenta sale del SALDO, nunca de la petición.
      cuentaOrigen: cuentas.deudaMotorizado(saldo.motorizadoId),
      cuentaDestino: req.metodoAbono === 'transferencia' ? cuentas.banco : cuentas.recuperacionDeuda,
      motorizadoId: saldo.motorizadoId,
      saldoId: req.saldoId,
      operacionId: req.operacionId,
    });

    return {
      ok: true as const,
      resultado: 'aplicado' as const,
      saldoId: req.saldoId,
      operacionId: req.operacionId,
      movimientoId,
      monto: req.monto,
      estadoAnterior,
      estadoNuevo,
      saldoPendienteAnterior: saldo.saldoPendiente,
      saldoPendiente: nuevoPendiente,
    };
  });
}
