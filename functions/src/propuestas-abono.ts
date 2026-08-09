// ═══════════════════════════════════════════════════════════════════════════
// confirmarPropuestaAbono / rechazarPropuestaAbono — DIGITADOR V1 (D3)
// ═══════════════════════════════════════════════════════════════════════════
//
// El Digitador solo REGISTRA una propuesta (propuestas_abono_saldo, escritura
// de cliente vía crearPropuestaAbono/corregirPropuestaAbono en
// lib/financial-writes.ts, permitida por firestore.rules mientras
// estado == 'pendiente'). Aplicar el abono al saldo real — o rechazarlo — es
// exclusivo de estas dos Cloud Functions: el cliente NUNCA escribe la
// transición 'pendiente' → 'confirmado'/'rechazado' (ver firestore.rules,
// match /propuestas_abono_saldo/{id}, allow update solo para el Digitador
// mientras sigue 'pendiente').
//
// Principio de mínima confianza (igual que motorizado-transiciones.ts):
// - confirmadoPorUid/confirmadoAt/rechazadoPorUid/rechazadoAt SIEMPRE se
//   derivan de request.auth y request.time del servidor, nunca del payload.
// - El monto aplicado es el que quedó guardado en la propuesta al digitarla
//   (el Digitador no puede alterarlo después de que el Gestor empieza a
//   revisarla porque Rules ya se lo impide en cuanto deja de estar
//   'pendiente' — pero igual se revalida acá contra el saldo real).
// - Todo el efecto contable (saldo + ledger + propuesta) se aplica en UNA
//   sola transacción — si algo falla, nada se aplica a medias.
// - Idempotencia: la transacción vuelve a leer el estado de la propuesta
//   DENTRO de la transacción antes de decidir. Una segunda confirmación (doble
//   clic, reintento de red) sobre una propuesta que ya dejó de estar
//   'pendiente' falla con 'failed-precondition' y no aplica un segundo abono.

import { onCall, HttpsError } from 'firebase-functions/v2/https';
import * as admin from 'firebase-admin';
import { FieldValue, Timestamp } from 'firebase-admin/firestore';
import { cuentas } from './financial-types';

const MAX_ID = 200;
const MAX_MOTIVO = 500;

type ConfirmarPayload = { propuestaId?: unknown };
type RechazarPayload = { propuestaId?: unknown; motivo?: unknown };

/** Usuario activo con rol admin o gestor — mismo criterio que isAdminOrGestor() en firestore.rules. */
async function exigirGestorOAdmin(db: FirebaseFirestore.Firestore, uid: string): Promise<void> {
  const snap = await db.collection('usuarios').doc(uid).get();
  const usuario = snap.data();
  const rol = usuario?.rol;
  if (!snap.exists || usuario?.activo !== true || (rol !== 'admin' && rol !== 'gestor')) {
    throw new HttpsError('permission-denied', 'Solo un gestor o admin activo puede resolver una propuesta de abono.');
  }
}

function idValido(v: unknown): v is string {
  return typeof v === 'string' && v.trim().length > 0 && v.length <= MAX_ID;
}

export const confirmarPropuestaAbono = onCall<ConfirmarPayload>(async (request) => {
  const db = admin.firestore();

  if (!request.auth) throw new HttpsError('unauthenticated', 'Debés iniciar sesión.');
  const uid = request.auth.uid;

  const data = request.data;
  if (typeof data !== 'object' || data === null || Array.isArray(data)) {
    throw new HttpsError('invalid-argument', 'Payload inválido.');
  }
  const claves = Object.keys(data);
  if (claves.length !== 1 || claves[0] !== 'propuestaId' || !idValido(data.propuestaId)) {
    throw new HttpsError('invalid-argument', 'Solo se acepta el campo propuestaId.');
  }
  const propuestaId = (data.propuestaId as string).trim();

  await exigirGestorOAdmin(db, uid);

  const propuestaRef = db.collection('propuestas_abono_saldo').doc(propuestaId);
  const movRef = db.collection('movimientos_financieros').doc();

  await db.runTransaction(async (tx) => {
    const propSnap = await tx.get(propuestaRef);
    if (!propSnap.exists) throw new HttpsError('not-found', 'La propuesta no existe.');
    const prop = propSnap.data()!;

    // Releída DENTRO de la transacción: la guarda real de idempotencia.
    if (prop.estado !== 'pendiente') {
      throw new HttpsError('failed-precondition', `Esta propuesta ya fue ${prop.estado === 'confirmado' ? 'confirmada' : 'procesada'} anteriormente.`);
    }

    const monto = prop.monto;
    if (typeof monto !== 'number' || !Number.isFinite(monto) || monto <= 0) {
      throw new HttpsError('failed-precondition', 'La propuesta tiene un monto inválido.');
    }

    const saldoId = prop.saldoId as string;
    const saldoRef = db.collection('saldos_cargo_motorizado').doc(saldoId);
    const saldoSnap = await tx.get(saldoRef);
    if (!saldoSnap.exists) throw new HttpsError('not-found', 'El saldo asociado ya no existe.');
    const saldo = saldoSnap.data()!;

    if (saldo.estado !== 'pendiente' && saldo.estado !== 'abonado_parcial') {
      throw new HttpsError('failed-precondition', `No se puede abonar un saldo en estado "${saldo.estado}".`);
    }

    const pendienteActual = saldo.saldoPendiente as number;
    if (monto > pendienteActual) {
      throw new HttpsError('failed-precondition', `El monto (${monto}) supera el saldo pendiente actual (${pendienteActual}).`);
    }

    const nuevoSaldo = Math.max(0, pendienteActual - monto);
    const nuevoEstado = nuevoSaldo <= 0 ? 'pagado' : 'abonado_parcial';
    const abonoIndex = Array.isArray(saldo.abonos) ? saldo.abonos.length : 0;

    const cuentaDestino: string =
      prop.metodoAbono === 'transferencia' ? cuentas.banco : cuentas.recuperacionDeuda;

    // Timestamp.now(), NO FieldValue.serverTimestamp(): Firestore rechaza
    // serverTimestamp() dentro de un objeto anidado en arrayUnion() (mismo
    // límite ya documentado en lib/financial-writes.ts:registrarAbonoSaldo).
    const abono: Record<string, unknown> = {
      monto,
      fecha: Timestamp.now(),
      metodoAbono: prop.metodoAbono,
      nota: prop.nota ?? '',
      creadoPorUid: uid,
      digitadoPorUid: prop.digitadoPorUid,
      propuestaId,
    };
    if (prop.comprobanteUrl) abono.comprobanteUrl = prop.comprobanteUrl;
    if (prop.comprobantePath) abono.comprobantePath = prop.comprobantePath;

    tx.update(saldoRef, {
      saldoPendiente: nuevoSaldo,
      estado: nuevoEstado,
      abonos: FieldValue.arrayUnion(abono),
      updatedAt: FieldValue.serverTimestamp(),
    });

    tx.set(movRef, {
      tipo: 'abono_deuda_motorizado',
      monto,
      at: FieldValue.serverTimestamp(),
      creadoPorUid: uid,
      creadoPorRol: 'gestor',
      descripcion: `Abono deuda (${prop.metodoAbono}) · ${prop.motorizadoNombre} · propuesta digitada`,
      estado: 'activo',
      cuentaOrigen: cuentas.deudaMotorizado(prop.motorizadoId),
      cuentaDestino,
      motorizadoId: prop.motorizadoId,
      saldoId,
    });

    tx.update(propuestaRef, {
      estado: 'confirmado',
      confirmadoPorUid: uid,
      confirmadoAt: FieldValue.serverTimestamp(),
      abonoIndex,
      movimientoId: movRef.id,
    });
  });

  return { ok: true as const, movimientoId: movRef.id };
});

export const rechazarPropuestaAbono = onCall<RechazarPayload>(async (request) => {
  const db = admin.firestore();

  if (!request.auth) throw new HttpsError('unauthenticated', 'Debés iniciar sesión.');
  const uid = request.auth.uid;

  const data = request.data;
  if (typeof data !== 'object' || data === null || Array.isArray(data)) {
    throw new HttpsError('invalid-argument', 'Payload inválido.');
  }
  const claves = Object.keys(data);
  if (claves.length < 1 || claves.length > 2 || !claves.includes('propuestaId') || !idValido(data.propuestaId)) {
    throw new HttpsError('invalid-argument', 'Payload inválido.');
  }
  if (claves.length === 2 && !claves.includes('motivo')) {
    throw new HttpsError('invalid-argument', 'Campo inesperado en el payload.');
  }
  const propuestaId = (data.propuestaId as string).trim();
  let motivo: string | undefined;
  if ('motivo' in data && data.motivo != null) {
    if (typeof data.motivo !== 'string' || data.motivo.length > MAX_MOTIVO) {
      throw new HttpsError('invalid-argument', 'motivo inválido.');
    }
    motivo = data.motivo.trim() || undefined;
  }

  await exigirGestorOAdmin(db, uid);

  const propuestaRef = db.collection('propuestas_abono_saldo').doc(propuestaId);

  await db.runTransaction(async (tx) => {
    const propSnap = await tx.get(propuestaRef);
    if (!propSnap.exists) throw new HttpsError('not-found', 'La propuesta no existe.');
    const prop = propSnap.data()!;

    if (prop.estado !== 'pendiente') {
      throw new HttpsError('failed-precondition', `Esta propuesta ya fue ${prop.estado === 'confirmado' ? 'confirmada' : 'procesada'} anteriormente.`);
    }

    const patch: FirebaseFirestore.UpdateData<FirebaseFirestore.DocumentData> = {
      estado: 'rechazado',
      rechazadoPorUid: uid,
      rechazadoAt: FieldValue.serverTimestamp(),
    };
    if (motivo) patch.motivoRechazo = motivo;

    tx.update(propuestaRef, patch);
  });

  return { ok: true as const };
});
