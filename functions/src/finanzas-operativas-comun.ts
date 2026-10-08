// FIN-1C-B — piezas comunes de crearGastoMotorizado, anularGastoMotorizado, registrarAdelantoMotorizado, anularAdelantoMotorizado y
// resolverIncidenciaCobro (autoritativas, server-side).
//
// Antes de FIN-1C-B el navegador del gestor escribía el gasto, el adelanto y la resolución de una incidencia: el monto, el estado, el actor
// y su rol, las cuentas del ledger y hasta el movimiento salían de la pantalla. Aquí el actor y el rol salen de request.auth y de
// usuarios/{uid}; el estado, el ledger y la identidad de cada documento los deriva el servidor; y todo lo que decide el dinero se RELEE y se
// DEMUESTRA dentro de la transacción.

import { createHash } from 'node:crypto';
import { HttpsError } from 'firebase-functions/v2/https';
import type { DocumentData } from 'firebase-admin/firestore';
import { cuentas } from './financial-types';
import { esNumeroFinito } from './deposito-monto';

export const TIPOS_GASTO = ['peaje_terminal', 'pago_cargotrans', 'otro_gasto_operativo'] as const;
export type TipoGastoOp = (typeof TIPOS_GASTO)[number];
export const TIPO_MOV_GASTO = 'gasto_aprobado';
export const TIPO_MOV_ADELANTO = 'adelanto_motorizado';
export const MAX_NOTA_OP = 1000;
const MAX_ID = 200;
const RE_OPERACION_ID = /^[A-Za-z0-9_-]{8,64}$/;
const RE_SEMANA = /^\d{4}-W(0[1-9]|[1-4]\d|5[0-3])$/;
const RE_FECHA = /^(\d{4})-(\d{2})-(\d{2})$/;
// Nicaragua no aplica horario de verano: el desfase es constante (igual que cobro-semanal.ts).
const MANAGUA_UTC_OFFSET_MIN = -6 * 60;

export type MotivoRechazoOp =
  | 'motorizado_inexistente'
  | 'orden_invalida'
  | 'fecha_futura'
  | 'gasto_consumido'
  | 'gasto_liquidado'
  | 'semana_liquidada'
  | 'movimiento_invalido'
  | 'conciliacion_requerida'
  | 'operacion_inconsistente'
  | 'incidencia_no_abierta'
  | 'cobro_ya_pagado'
  | 'orden_no_entregada'
  | 'estado_incompatible';

export function rechazoOp(motivo: MotivoRechazoOp, mensaje: string, extra: Record<string, unknown> = {}): HttpsError {
  return new HttpsError('failed-precondition', mensaje, { motivo, ...extra });
}

export function idValido(v: unknown): v is string {
  return typeof v === 'string' && v.trim().length > 0 && v.length <= MAX_ID;
}

function objetoPlano(data: unknown): Record<string, unknown> {
  if (typeof data !== 'object' || data === null || Array.isArray(data)) throw new HttpsError('invalid-argument', 'Petición inválida.');
  return data as Record<string, unknown>;
}

function soloClaves(d: Record<string, unknown>, permitidas: readonly string[]): void {
  if (Object.keys(d).some((k) => !permitidas.includes(k))) {
    throw new HttpsError('invalid-argument', `Solo se aceptan los campos ${permitidas.join(', ')}.`);
  }
}

function operacionIdValido(v: unknown): string {
  if (typeof v !== 'string' || !RE_OPERACION_ID.test(v)) throw new HttpsError('invalid-argument', 'operacionId inválido.');
  return v;
}

function notaOpcional(v: unknown): string | null {
  if (v === undefined || v === null) return null;
  if (typeof v !== 'string') throw new HttpsError('invalid-argument', 'La nota debe ser texto.');
  const n = v.trim();
  if (n.length > MAX_NOTA_OP) throw new HttpsError('invalid-argument', `La nota admite hasta ${MAX_NOTA_OP} caracteres.`);
  return n || null;
}

/**
 * Monto humano legítimo: finito, > 0, a lo más 2 decimales y representable de forma segura en centavos. No hay tope comercial: la UI
 * y el modelo no tienen uno y no se inventa.
 */
export function montoValido(v: unknown): number {
  if (!esNumeroFinito(v) || v <= 0) throw new HttpsError('invalid-argument', 'Ingresá un monto válido.');
  const centavos = Math.round(v * 100);
  if (Math.abs(v * 100 - centavos) > 1e-6) throw new HttpsError('invalid-argument', 'El monto admite hasta 2 decimales.');
  if (!Number.isSafeInteger(centavos)) throw new HttpsError('invalid-argument', 'El monto es demasiado grande.');
  return centavos / 100;
}

/** Semana ISO 'YYYY-Www' (la misma convención que Liquidaciones). */
export function semanaValida(v: unknown): string {
  if (typeof v !== 'string' || !RE_SEMANA.test(v)) throw new HttpsError('invalid-argument', 'La semana no es válida.');
  return v;
}

/** Fecha de Managua (YYYY-MM-DD) de un instante. */
export function fechaManagua(ahora: Date): string {
  const l = new Date(ahora.getTime() + MANAGUA_UTC_OFFSET_MIN * 60_000);
  return `${l.getUTCFullYear()}-${String(l.getUTCMonth() + 1).padStart(2, '0')}-${String(l.getUTCDate()).padStart(2, '0')}`;
}

/**
 * 'YYYY-MM-DD' (como la manda el selector de fecha) → el instante del mediodía de Managua de ese día, igual que la pantalla ("T12:00:00").
 * Se rechaza una fecha inexistente o FUTURA (respecto del día de Managua). Los retroactivos se preservan: la UI los permite.
 */
export function instanteDeFechaGasto(v: unknown, ahora: Date): Date {
  if (typeof v !== 'string') throw new HttpsError('invalid-argument', 'La fecha no es válida.');
  const m = RE_FECHA.exec(v);
  if (!m) throw new HttpsError('invalid-argument', 'La fecha no es válida.');
  const [y, mo, d] = [Number(m[1]), Number(m[2]), Number(m[3])];
  const probe = new Date(Date.UTC(y, mo - 1, d));
  if (probe.getUTCFullYear() !== y || probe.getUTCMonth() !== mo - 1 || probe.getUTCDate() !== d) throw new HttpsError('invalid-argument', 'La fecha no es válida.');
  if (v > fechaManagua(ahora)) throw rechazoOp('fecha_futura', 'La fecha del gasto no puede ser futura.');
  return new Date(Date.UTC(y, mo - 1, d, 12, 0, 0) - MANAGUA_UTC_OFFSET_MIN * 60_000);
}

export interface PeticionCrearGasto {
  operacionId: string; motorizadoId: string; tipo: TipoGastoOp; monto: number; fecha: string | null; nota: string | null; ordenId: string | null;
}

/** Crear gasto: SOLO { operacionId, motorizadoId, tipo, monto, fecha?, nota?, ordenId? }. Ni estado, ni marca de consumo, ni actor, ni ledger. */
export function validarPeticionCrearGasto(data: unknown): PeticionCrearGasto {
  const d = objetoPlano(data);
  soloClaves(d, ['operacionId', 'motorizadoId', 'tipo', 'monto', 'fecha', 'nota', 'ordenId']);
  const operacionId = operacionIdValido(d.operacionId);
  if (!idValido(d.motorizadoId)) throw new HttpsError('invalid-argument', 'motorizadoId inválido.');
  if (!(TIPOS_GASTO as readonly unknown[]).includes(d.tipo)) throw new HttpsError('invalid-argument', 'El tipo de gasto no es válido.');
  const monto = montoValido(d.monto);
  let fecha: string | null = null;
  if (d.fecha !== undefined && d.fecha !== null) {
    if (typeof d.fecha !== 'string' || !RE_FECHA.test(d.fecha)) throw new HttpsError('invalid-argument', 'La fecha no es válida.');
    fecha = d.fecha;
  }
  let ordenId: string | null = null;
  if (d.ordenId !== undefined && d.ordenId !== null) {
    if (!idValido(d.ordenId)) throw new HttpsError('invalid-argument', 'ordenId inválido.');
    ordenId = d.ordenId.trim();
  }
  return { operacionId, motorizadoId: d.motorizadoId.trim(), tipo: d.tipo as TipoGastoOp, monto, fecha, nota: notaOpcional(d.nota), ordenId };
}

/** Anular gasto: SOLO { gastoId }. */
export function validarPeticionAnularGasto(data: unknown): { gastoId: string } {
  const d = objetoPlano(data);
  soloClaves(d, ['gastoId']);
  if (!idValido(d.gastoId)) throw new HttpsError('invalid-argument', 'gastoId inválido.');
  return { gastoId: d.gastoId.trim() };
}

export interface PeticionRegistrarAdelanto { operacionId: string; motorizadoId: string; monto: number; semanaKey: string; nota: string | null }

/** Registrar adelanto: SOLO { operacionId, motorizadoId, monto, semanaKey, nota? }. */
export function validarPeticionRegistrarAdelanto(data: unknown): PeticionRegistrarAdelanto {
  const d = objetoPlano(data);
  soloClaves(d, ['operacionId', 'motorizadoId', 'monto', 'semanaKey', 'nota']);
  const operacionId = operacionIdValido(d.operacionId);
  if (!idValido(d.motorizadoId)) throw new HttpsError('invalid-argument', 'motorizadoId inválido.');
  return { operacionId, motorizadoId: d.motorizadoId.trim(), monto: montoValido(d.monto), semanaKey: semanaValida(d.semanaKey), nota: notaOpcional(d.nota) };
}

/** Anular adelanto: SOLO { adelantoId } (el id del movimiento que eligió la pantalla). */
export function validarPeticionAnularAdelanto(data: unknown): { adelantoId: string } {
  const d = objetoPlano(data);
  soloClaves(d, ['adelantoId']);
  if (!idValido(d.adelantoId)) throw new HttpsError('invalid-argument', 'adelantoId inválido.');
  return { adelantoId: d.adelantoId.trim() };
}

export type ItemResolucion = 'delivery' | 'producto';
export type DecisionResolucion = 'cliente_pagara' | 'se_pierde';

/** Resolver incidencia: SOLO { ordenId, item, decision, nota? }. Ni actor, ni fecha, ni estado final, ni monto, ni cobroPendiente. */
export function validarPeticionResolver(data: unknown): { ordenId: string; item: ItemResolucion; decision: DecisionResolucion; nota: string | null } {
  const d = objetoPlano(data);
  soloClaves(d, ['ordenId', 'item', 'decision', 'nota']);
  if (!idValido(d.ordenId)) throw new HttpsError('invalid-argument', 'ordenId inválido.');
  if (d.item !== 'delivery' && d.item !== 'producto') throw new HttpsError('invalid-argument', 'El ítem debe ser delivery o producto.');
  if (d.decision !== 'cliente_pagara' && d.decision !== 'se_pierde') throw new HttpsError('invalid-argument', 'La decisión no es válida.');
  return { ordenId: d.ordenId.trim(), item: d.item, decision: d.decision, nota: notaOpcional(d.nota) };
}

/** Admin o gestor ACTIVO. El rol sale de usuarios/{uid}, nunca del cliente (los mismos roles que ya operaban estas pantallas). */
export function exigirStaffFinanzas(usuario: DocumentData | null): 'admin' | 'gestor' {
  if (!usuario || usuario.activo !== true || (usuario.rol !== 'admin' && usuario.rol !== 'gestor')) {
    throw new HttpsError('permission-denied', 'Solo un administrador o gestor activo puede operar gastos, adelantos y resoluciones.');
  }
  return usuario.rol;
}

/** Huella estable del payload de una operación (retry idéntico ⇒ ya_registrado; otro payload con el mismo id ⇒ operacion_inconsistente). */
export function huellaPayload(p: Record<string, unknown>): string {
  const claves = Object.keys(p).sort();
  return createHash('sha256').update(JSON.stringify(claves.map((k) => [k, p[k] ?? null]))).digest('hex').slice(0, 32);
}

export const mismoMontoOp = (a: unknown, b: unknown): boolean => esNumeroFinito(a) && esNumeroFinito(b) && Math.abs(a - b) < 0.005;

export const nombreMotorizado = (m: DocumentData, id: string): string => {
  const n = typeof m.nombre === 'string' && m.nombre.trim() ? m.nombre.trim() : typeof m.authUid === 'string' && m.authUid ? m.authUid : id;
  return n;
};

/** Cuentas del ledger, EXACTAMENTE las que usaba el writer de cliente. */
export const cuentasGasto = (motorizadoId: string) => ({ origen: cuentas.efectivoEnPoder(motorizadoId), destino: cuentas.gastosOp });
export const cuentasAdelanto = (motorizadoId: string) => ({ origen: cuentas.caja, destino: cuentas.deudaMotorizado(motorizadoId) });

// ── Incidencias: copia fiel de lib/incidencia-cobro.ts (las Functions no importan del front) ─────────────────────────────────────────
// Una sola definición de "qué queda por clasificar": la pantalla y el servidor tienen que coincidir.
export interface OrdenIncidencia {
  pagoDelivery?: { deducirDelCobroContraEntrega?: boolean | null } | null;
  cobrosMotorizado?: {
    delivery?: { recibio?: boolean | null } | null;
    producto?: { recibio?: boolean | null; resolucion?: { tipo?: string | null } | null } | null;
    resolucion?: { tipo?: string | null } | null;
  } | null;
}
export const esDeliveryDeducidoOp = (o: OrdenIncidencia): boolean => o.pagoDelivery?.deducirDelCobroContraEntrega === true;
export function deliverySinClasificarOp(o: OrdenIncidencia): boolean {
  if (esDeliveryDeducidoOp(o)) return false;
  const d = o.cobrosMotorizado?.delivery;
  return !!d && d.recibio === false && !o.cobrosMotorizado?.resolucion;
}
export function productoSinClasificarOp(o: OrdenIncidencia): boolean {
  const p = o.cobrosMotorizado?.producto;
  return !!p && p.recibio === false && !p.resolucion;
}
