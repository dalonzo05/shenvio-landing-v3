// FIN-1C-A — piezas comunes de registrarCobroDelivery, revertirCobroDelivery y registrarPagoCobroSemanal (autoritativas).
//
// Antes de FIN-1C-A el navegador del gestor escribía el pago de un cobro: la orden (cobroDelivery.estado = 'pagado'), el movimiento
// pago_recibido del ledger, el DEP tipo C y el cobro semanal, con montos que salían de la pantalla. Aquí el actor y el rol salen de
// request.auth y de usuarios/{uid}; el monto se RECALCULA desde la orden (cobro-delivery-monto.ts) y se compara con el guardado;
// la orden, el movimiento, el depósito y el cobro semanal se releen y se demuestran dentro de la transacción.

import { HttpsError } from 'firebase-functions/v2/https';
import type { DocumentData } from 'firebase-admin/firestore';
import { esNumeroFinito } from './deposito-monto';

export const TIPO_MOVIMIENTO_PAGO = 'pago_recibido';
export const TIPO_DEPOSITO_PAGO_COBRO = 'pago_delivery_deposito';
export const FORMAS_PAGO = ['efectivo', 'transferencia'] as const;
export type FormaPago = (typeof FORMAS_PAGO)[number];

/**
 * Tope de órdenes por lote. La transacción escribe, por orden, 1 actualización + 1 movimiento (+ 1 depósito en transferencia) y
 * lee 2 documentos más una consulta; con 25 órdenes son ≤ 75 escrituras y ~75 lecturas, muy por debajo de las 500 de Firestore.
 * Un grupo real (mismo cliente y día) tiene unas pocas órdenes: el tope existe para fallar con un mensaje claro.
 */
export const MAX_ORDENES_POR_LOTE_COBRO = 25;
export const MAX_NOTA_COBRO = 300;
const MAX_ID = 200;
const RE_OPERACION_ID = /^[A-Za-z0-9_-]{8,64}$/;
const TOLERANCIA = 0.005;

export type MotivoRechazoCobro =
  | 'orden_no_entregada'
  | 'orden_credito'
  | 'orden_ya_pagada'
  | 'orden_no_cobrable'
  | 'incidencia_abierta'
  | 'monto_inconsistente'
  | 'monto_cero'
  | 'boucher_requerido'
  | 'puntero_ocupado'
  | 'cobro_no_pagado'
  | 'conciliacion_requerida'
  | 'operacion_inconsistente'
  | 'saldo_insuficiente'
  | 'cobro_semanal_invalido'
  | 'demasiadas_ordenes';

export function rechazoCobro(motivo: MotivoRechazoCobro, mensaje: string, extra: Record<string, unknown> = {}): HttpsError {
  return new HttpsError('failed-precondition', mensaje, { motivo, ...extra });
}

export function idValido(v: unknown): v is string {
  return typeof v === 'string' && v.trim().length > 0 && v.length <= MAX_ID;
}

export const mismoMontoCobro = (a: unknown, b: unknown): boolean => esNumeroFinito(a) && esNumeroFinito(b) && Math.abs(a - b) < TOLERANCIA;

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
  if (n.length > MAX_NOTA_COBRO) throw new HttpsError('invalid-argument', `La nota admite hasta ${MAX_NOTA_COBRO} caracteres.`);
  return n || null;
}

/** Cobro de delivery: SOLO { operacionId, ordenIds, formaPago, nota? }. Ni monto, ni estado, ni actor, ni rol. */
export function validarPeticionCobro(data: unknown): { operacionId: string; ordenIds: string[]; formaPago: FormaPago; nota: string | null } {
  const d = objetoPlano(data);
  soloClaves(d, ['operacionId', 'ordenIds', 'formaPago', 'nota']);
  const operacionId = operacionIdValido(d.operacionId);
  if (!Array.isArray(d.ordenIds) || d.ordenIds.length === 0) throw new HttpsError('invalid-argument', 'Indicá al menos una orden.');
  if (d.ordenIds.length > MAX_ORDENES_POR_LOTE_COBRO) {
    throw rechazoCobro('demasiadas_ordenes', `Un lote admite hasta ${MAX_ORDENES_POR_LOTE_COBRO} órdenes.`, { max: MAX_ORDENES_POR_LOTE_COBRO });
  }
  if (!d.ordenIds.every(idValido)) throw new HttpsError('invalid-argument', 'ordenIds inválido.');
  const ordenIds = (d.ordenIds as string[]).map((x) => x.trim());
  if (new Set(ordenIds).size !== ordenIds.length) throw new HttpsError('invalid-argument', 'ordenIds repetido.');
  if (!(FORMAS_PAGO as readonly unknown[]).includes(d.formaPago)) throw new HttpsError('invalid-argument', 'La forma de pago debe ser efectivo o transferencia.');
  return { operacionId, ordenIds, formaPago: d.formaPago as FormaPago, nota: notaOpcional(d.nota) };
}

/** Reversión: SOLO { operacionId, ordenId }. */
export function validarPeticionReversion(data: unknown): { operacionId: string; ordenId: string } {
  const d = objetoPlano(data);
  soloClaves(d, ['operacionId', 'ordenId']);
  const operacionId = operacionIdValido(d.operacionId);
  if (!idValido(d.ordenId)) throw new HttpsError('invalid-argument', 'ordenId inválido.');
  return { operacionId, ordenId: d.ordenId.trim() };
}

/** Pago de crédito semanal: SOLO { pagoId, cobroSemanalId, monto, nota? }. */
export function validarPeticionPagoSemanal(data: unknown): { pagoId: string; cobroSemanalId: string; monto: number; nota: string | null } {
  const d = objetoPlano(data);
  soloClaves(d, ['pagoId', 'cobroSemanalId', 'monto', 'nota']);
  const pagoId = operacionIdValido(d.pagoId);
  if (!idValido(d.cobroSemanalId)) throw new HttpsError('invalid-argument', 'cobroSemanalId inválido.');
  const monto = d.monto;
  if (!esNumeroFinito(monto) || monto <= 0) throw new HttpsError('invalid-argument', 'Ingresá un monto válido.');
  // Centavos: el ledger no admite fracciones de centavo.
  if (Math.abs(monto * 100 - Math.round(monto * 100)) > 1e-6) throw new HttpsError('invalid-argument', 'El monto admite hasta 2 decimales.');
  return { pagoId, cobroSemanalId: d.cobroSemanalId.trim(), monto: Math.round(monto * 100) / 100, nota: notaOpcional(d.nota) };
}

/** Admin o gestor ACTIVO. El rol sale de usuarios/{uid}, nunca del cliente. */
export function exigirStaffCobros(usuario: DocumentData | null): 'admin' | 'gestor' {
  if (!usuario || usuario.activo !== true || (usuario.rol !== 'admin' && usuario.rol !== 'gestor')) {
    throw new HttpsError('permission-denied', 'Solo un administrador o gestor activo puede operar cobros.');
  }
  return usuario.rol;
}

/** Comprobante VIGENTE de la orden, resuelto por el puntero (nunca "el último objeto que exista"). */
export function boucherVigenteDeCobro(cd: DocumentData | null | undefined): string | null {
  if (!cd) return null;
  const url = cd.boucherVigente === 'gestor' ? cd.boucherGestor?.url
    : cd.boucherVigente === 'comercio' ? cd.boucherComercio?.url
      : cd.boucherUrl;
  return typeof url === 'string' && url.trim() ? url : null;
}

export function nombreClienteDeOrden(orden: DocumentData): string {
  const o = orden.ownerSnapshot as { companyName?: unknown; nombre?: unknown } | undefined;
  const n = (typeof o?.companyName === 'string' && o.companyName.trim()) || (typeof o?.nombre === 'string' && o.nombre.trim()) || '';
  return n || 'Cliente';
}

/** Lo que una transacción de cobro necesita LEER (todo antes de escribir). */
export interface LecturasCobro {
  getUsuario(uid: string): Promise<DocumentData | null>;
  getSolicitud(id: string): Promise<DocumentData | null>;
  getMovimiento(id: string): Promise<DocumentData | null>;
  getDeposito(id: string): Promise<DocumentData | null>;
  getOperacion(id: string): Promise<DocumentData | null>;
  /** TODOS los movimientos del ledger con solicitudId == id (activos y anulados). */
  getMovimientosDeSolicitud(solicitudId: string): Promise<Array<{ id: string; data: DocumentData }>>;
}
