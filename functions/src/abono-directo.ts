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
//   - Saldo (pendiente, estado, abonos[]), movimiento del ledger e INTENCIÓN se escriben
//     juntos, o no se escribe nada.
//
// ─── Idempotencia: la intención vive en el SERVIDOR ──────────────────────────
//
// Dos abonos legítimos pueden tener EXACTAMENTE el mismo monto sobre el mismo saldo
// (C$30 y C$30). Deduplicar por saldo, por monto, por saldo+monto o por actor los
// fusionaría o rechazaría. La identidad es la de la INTENCIÓN, y NO la fabrica el
// cliente: la crea prepararAbonoDirecto (functions/src/abono-intencion.ts) en
// intenciones_abono_directo/{operacionId} y la recupera desde cualquier pantalla,
// pestaña o dispositivo del mismo usuario. Una recarga que perdió la respuesta de un
// commit exitoso no puede entonces inventar OTRA operación: recupera la misma, ya aplicada.
//
//   movimiento   id determinista `abono_<operacionId>`, creado con create()
//   abonos[]     la entrada lleva `operacionId` y `movimientoId` (abono ↔ movimiento 1:1)
//   intención    preparada → aplicada (en la MISMA transacción que el saldo y el ledger)
//                           → rechazada (cuando el servidor demuestra que NO se aplicó)
//
// registrarAbonoDirecto exige una intención válida: que exista, sea del actor, del saldo y
// coincida en monto y método. Una operacionId arbitraria se rechaza.
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
/**
 * Los métodos que exigen comprobante: los mismos que la pantalla (METODOS_REQUIEREN_COMPROBANTE en
 * app/panel/gestor/saldos/page.tsx). La pantalla sube la imagen y manda AMBOS: comprobanteUrl y comprobantePath.
 */
export const METODOS_REQUIEREN_COMPROBANTE: readonly string[] = ['transferencia'];
export const TIPO_MOVIMIENTO_ABONO = 'abono_deuda_motorizado';
export const RE_OPERACION_ID = /^[A-Za-z0-9_-]{16,64}$/;
export const RE_SALDO_ID = /^[A-Za-z0-9_-]{1,200}$/;
const CLAVES_PETICION = ['saldoId', 'monto', 'operacionId', 'metodoAbono', 'nota', 'comprobanteUrl', 'comprobantePath'];
const MAX_NOTA = 500;
const MAX_URL = 2048;
const MAX_PATH = 300;
const MAX_MONTO = 1_000_000_000;

export type MotivoRechazoAbono =
  | 'saldo_no_abonable'
  | 'monto_excede_saldo'
  | 'conflicto_idempotencia'
  | 'abono_inconsistente'
  | 'intencion_inexistente'
  | 'intencion_ajena'
  | 'intencion_cerrada'
  | 'comprobante_requerido'
  | 'comprobante_path_invalido'
  | 'operacion_pendiente_existente';

export interface CamposAbono {
  monto: number;
  metodoAbono: string;
  nota: string;
  comprobanteUrl?: string;
  comprobantePath?: string;
}

export interface PeticionAbono extends CamposAbono {
  saldoId: string;
  operacionId: string;
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
  getIntencion(id: string): Promise<DocumentData | null>;
  updateSaldo(id: string, campos: DocumentData): void;
  crearMovimiento(id: string, campos: DocumentData): void;
  updateIntencion(id: string, campos: DocumentData): void;
}

export interface DepsAbono {
  transaction<T>(fn: (tx: TxAbono) => Promise<T>): Promise<T>;
  /** FieldValue.serverTimestamp(): para campos de primer nivel. */
  serverTimestamp(): unknown;
  /** Timestamp.now(): serverTimestamp() no puede ir dentro de un objeto de un array. */
  ahora(): unknown;
}

export function rechazo(motivo: MotivoRechazoAbono, mensaje: string, extra: Record<string, unknown> = {}): HttpsError {
  return new HttpsError('failed-precondition', mensaje, { motivo, ...extra });
}

export function esNumeroFinito(v: unknown): v is number {
  return typeof v === 'number' && Number.isFinite(v);
}

export function idValido(v: unknown): v is string {
  return typeof v === 'string' && v.trim().length > 0 && v.length <= 200;
}

/** Centavos enteros: el dinero se compara sin errores de coma flotante. */
export function centavos(n: number): number {
  return Math.round(n * 100);
}

function tieneAcuerdoDeCentavos(n: number): boolean {
  return Math.abs(n * 100 - Math.round(n * 100)) < 1e-6;
}

/** Los campos de la INTENCIÓN de abono (monto, método, nota y comprobante). Comunes a preparar y registrar. */
export function validarCamposAbono(d: Record<string, unknown>, saldoId: string): CamposAbono {
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
  const out: CamposAbono = { monto: d.monto, metodoAbono: d.metodoAbono, nota };
  // El SDK de Firebase entrega `undefined` como `null`: en un opcional REAL, null equivale a ausente.
  // Un tipo equivocado distinto de null sigue siendo inválido; los obligatorios no pasan por aquí.
  if (d.comprobanteUrl !== undefined && d.comprobanteUrl !== null) {
    if (typeof d.comprobanteUrl !== 'string' || !d.comprobanteUrl.startsWith('https://') || d.comprobanteUrl.length > MAX_URL) {
      throw new HttpsError('invalid-argument', 'comprobanteUrl inválido.');
    }
    out.comprobanteUrl = d.comprobanteUrl;
  }
  if (d.comprobantePath !== undefined && d.comprobantePath !== null) {
    // El comprobante de un abono vive en saldos/<saldoId>/…: no se acepta una ruta de otro lado.
    if (typeof d.comprobantePath !== 'string' || !d.comprobantePath.startsWith(`saldos/${saldoId}/`) || d.comprobantePath.includes('..') || d.comprobantePath.length > MAX_PATH) {
      throw new HttpsError('invalid-argument', 'comprobantePath inválido.');
    }
    out.comprobantePath = d.comprobantePath;
  }
  return out;
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
  return { saldoId, operacionId: d.operacionId, ...validarCamposAbono(d, saldoId) };
}

/**
 * A4-04 · P1-B — el comprobante de un abono se ata al índice que el SERVIDOR autoriza. Storage sella
 * saldos/{saldoId}/abono_N.jpg cuando N < abonos.length; eso solo respalda dinero si un abono aplicado
 * únicamente puede apuntar al N que le tocaba (N == abonos.length al aplicarlo). Un cliente modificado
 * podía registrar `abono_5.jpg` con abonos.length == 0: el abono quedaba aplicado con un comprobante que
 * Storage seguía considerando reemplazable.
 *
 * Igualdad EXACTA de strings (no startsWith): otro saldo, subcarpeta, traversal, otro basename u otra
 * extensión son todos distintos del único path esperado. El índice nunca lo decide el cliente.
 */
export function esComprobanteAbonoEsperado(saldoId: string, indiceEsperado: number, path: unknown): boolean {
  return typeof path === 'string'
    && typeof saldoId === 'string' && saldoId.length > 0 && !saldoId.includes('/')
    && Number.isInteger(indiceEsperado) && indiceEsperado >= 0
    && path === `saldos/${saldoId}/abono_${indiceEsperado}.jpg`;
}

/**
 * A4-04 · P1-B (ruta alternativa) — el comprobante de una PROPUESTA confirmada es EXACTAMENTE el de esa propuesta
 * (lo que sube uploadComprobantePropuesta). Storage lo sella al dejar de estar 'pendiente'. Cualquier otro path
 * (p. ej. un abono_N.jpg que el digitador escribió en la propuesta) se rechaza antes de aplicar dinero.
 */
export function esComprobantePropuestaEsperado(saldoId: string, propuestaId: string, path: unknown): boolean {
  return typeof path === 'string'
    && typeof saldoId === 'string' && saldoId.length > 0 && !saldoId.includes('/')
    && typeof propuestaId === 'string' && propuestaId.length > 0 && !propuestaId.includes('/')
    && path === `saldos/${saldoId}/propuestas/${propuestaId}/comprobante.jpg`;
}

/** Mismo criterio que isAdminOrGestor() en firestore.rules: usuario ACTIVO con rol admin o gestor. */
export function exigirGestorOAdmin(usuario: DocumentData | null): 'admin' | 'gestor' {
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
  intencion: DocumentData,
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
    && (a.movimientoId === undefined || a.movimientoId === movimientoId)
    && intencion.estado === 'aplicada'
    && intencion.movimientoId === movimientoId;
  if (!coherente) {
    throw rechazo('abono_inconsistente', 'El abono, su movimiento y su intención no coinciden. Hay que revisarlo; no se corrige solo.');
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

  // Un rechazo DEFINITIVO tiene que PERSISTIR el cierre de la intención: lanzar dentro de la
  // transacción revertiría esa escritura. Se devuelve y se lanza fuera, ya confirmada.
  const r = await deps.transaction<ResultadoAbono | { rechazado: HttpsError }>(async (tx) => {
    // ── LECTURAS (todas antes de cualquier escritura) ─────────────────────────
    const rol = exigirGestorOAdmin(await tx.getUsuario(uid));

    // La operación tiene que corresponder a una INTENCIÓN válida de este actor.
    const intencion = await tx.getIntencion(req.operacionId);
    if (!intencion) throw rechazo('intencion_inexistente', 'La operación no existe: hay que prepararla primero.');
    if (intencion.actorUid !== uid) throw rechazo('intencion_ajena', 'Esta operación pertenece a otro usuario.');
    if (intencion.saldoId !== req.saldoId || !esNumeroFinito(intencion.monto) || centavos(intencion.monto) !== centavos(req.monto) || intencion.metodoAbono !== req.metodoAbono) {
      throw rechazo('conflicto_idempotencia', 'Esta operación se preparó con otro saldo, monto o método. No se registró nada.');
    }

    const saldo = await tx.getSaldo(req.saldoId);
    if (!saldo) throw new HttpsError('not-found', 'El saldo no existe.');
    const mov = await tx.getMovimiento(movimientoId);
    const abonos: DocumentData[] = Array.isArray(saldo.abonos) ? saldo.abonos : [];
    const abonoExistente = abonos.find((a) => a && a.operacionId === req.operacionId);
    const hayHuella = !!(abonoExistente || mov);

    // Guarda de idempotencia: ANTES de validar estado y monto (ver cabecera).
    if (intencion.estado === 'aplicada' && !hayHuella) {
      throw rechazo('abono_inconsistente', 'La intención figura aplicada pero no hay abono ni movimiento. Hay que revisarlo; no se corrige solo.');
    }
    if (intencion.estado === 'preparada' && hayHuella) {
      throw rechazo('abono_inconsistente', 'Hay un abono o un movimiento de esta operación pero la intención sigue preparada. Hay que revisarlo; no se corrige solo.');
    }
    if (hayHuella) {
      return resolverOperacionExistente(req, saldo, abonoExistente, mov, movimientoId, intencion);
    }
    if (intencion.estado !== 'preparada') {
      throw rechazo('intencion_cerrada', 'Esta operación ya se cerró sin aplicarse. Preparala de nuevo.', { estadoIntencion: String(intencion.estado ?? '') });
    }

    // ── Comprobante de la transferencia (regla de negocio; null y ausente son lo mismo) ──
    // Se lanza SIN cerrar la intención: no es un rechazo definitivo de la operación sino un dato que falta;
    // la intención sigue preparada y se aplica cuando llegue con su comprobante. La transacción se revierte:
    // 0 saldo, 0 abono, 0 movimiento.
    if (METODOS_REQUIEREN_COMPROBANTE.includes(req.metodoAbono) && (!req.comprobanteUrl || !req.comprobantePath)) {
      throw rechazo('comprobante_requerido', 'La transferencia requiere el comprobante: subí la imagen y volvé a registrar el abono.', { metodoAbono: req.metodoAbono });
    }

    // ── Validación contra el saldo REAL releído ───────────────────────────────
    const estadoAnterior = String(saldo.estado ?? '');
    const cerrarSinAplicar = (e: HttpsError, motivo: string) => {
      tx.updateIntencion(req.operacionId, { estado: 'rechazada', motivoRechazo: motivo, updatedAt: deps.serverTimestamp() });
      return { rechazado: e };
    };
    if (!ESTADOS_ABONABLES.includes(estadoAnterior)) {
      return cerrarSinAplicar(rechazo('saldo_no_abonable', `No se puede abonar un saldo en estado "${estadoAnterior || 'desconocido'}".`, { estado: estadoAnterior }), 'saldo_no_abonable');
    }
    // Sin identidad suficiente para el ledger no se inventa nada.
    if (typeof saldo.motorizadoId !== 'string' || saldo.motorizadoId.length === 0 || !esNumeroFinito(saldo.saldoPendiente) || saldo.saldoPendiente < 0) {
      throw rechazo('abono_inconsistente', 'El saldo no tiene los datos necesarios (motorizado, pendiente) para abonarlo con seguridad.');
    }
    const pendienteC = centavos(saldo.saldoPendiente);
    const montoC = centavos(req.monto);
    if (pendienteC <= 0) {
      return cerrarSinAplicar(rechazo('saldo_no_abonable', 'El saldo no tiene monto pendiente.', { estado: estadoAnterior }), 'saldo_no_abonable');
    }
    if (montoC > pendienteC) {
      return cerrarSinAplicar(rechazo('monto_excede_saldo', `El monto (${req.monto}) supera el saldo pendiente actual (${saldo.saldoPendiente}).`, { saldoPendiente: saldo.saldoPendiente }), 'monto_excede_saldo');
    }

    // ── Path del comprobante: el índice lo decide el SERVIDOR (A4-04 · P1-B) ──
    // N == abonos.length del saldo RELEÍDO en esta transacción (si otro abono ganó entre el upload y el registro,
    // Firestore reintenta la transacción con el saldo nuevo y el path viejo se rechaza). Se lanza SIN cerrar la
    // intención —igual que comprobante_requerido—: es un dato incorrecto, no un rechazo definitivo; la transacción
    // se revierte (0 saldo, 0 abono, 0 movimiento) y el reintento con el path correcto sigue siendo posible.
    if (req.comprobantePath !== undefined && !esComprobanteAbonoEsperado(req.saldoId, abonos.length, req.comprobantePath)) {
      throw rechazo('comprobante_path_invalido', `El comprobante debe ser saldos/${req.saldoId}/abono_${abonos.length}.jpg. No se registró nada.`, { indiceEsperado: abonos.length });
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

    // La intención se cierra en la MISMA transacción: nunca "aplicado pero preparada".
    tx.updateIntencion(req.operacionId, {
      estado: 'aplicada',
      movimientoId,
      aplicadaAt: ahora,
      updatedAt: ahora,
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

  if ('rechazado' in r) throw r.rechazado;
  return r;
}
