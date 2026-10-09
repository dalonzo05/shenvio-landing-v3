// FIN-1D — la fórmula de una liquidación semanal, PURA (sin Firestore): el servidor la calcula; el navegador ya no decide ningún monto.
//
// Antes la pantalla de Liquidaciones sumaba `precioFinalCordobas` de toda orden que no fuera por transferencia (y contaba como efectivo el
// crédito semanal, el delivery no recibido y el delivery deducido del cobro contra entrega). El depósito, en cambio, ya demostraba su monto con
// `calcularDeposito`. Ahora el efectivo esperado de la liquidación es la SUMA de `calcularDeposito(orden).totalAStorkhub`: una sola definición de
// "qué efectivo le debe el motorizado a StorkHub".
//
// Todo se calcula en CENTAVOS enteros: la suma de montos con decimales no deriva y el neto es exacto.

import type { DocumentData } from 'firebase-admin/firestore';
import { calcularDeposito } from './calculo-deposito';
import { esNumeroFinito } from './deposito-monto';

export const COMISION_PCT = 0.8;
export const TIPO_DEPOSITO_STORKHUB_LIQ = 'recaudacion_motorizado_storkhub';

export const aCentavos = (v: unknown): number => (esNumeroFinito(v) ? Math.round(v * 100) : 0);
export const aMonto = (centavos: number): number => centavos / 100;

type ConToDate = { toDate?: () => Date; toMillis?: () => number } | null | undefined;

/** Instante (ms) de un Timestamp del SDK; null si no es un instante legible. */
export function milis(v: unknown): number | null {
  const t = v as ConToDate;
  if (t && typeof t.toMillis === 'function') {
    const n = t.toMillis();
    return Number.isFinite(n) ? n : null;
  }
  if (t && typeof t.toDate === 'function') {
    const n = t.toDate().getTime();
    return Number.isFinite(n) ? n : null;
  }
  return null;
}

/** Fecha de entrega canónica: `entregadoAt`, con `historial.entregadoAt` de respaldo (igual que acumularCobroSemanalPorOrden). */
export function entregaDeOrden(o: DocumentData): number | null {
  return milis(o.entregadoAt) ?? milis(o.historial?.entregadoAt);
}

const dentro = (ms: number | null, ini: number, fin: number): boolean => ms !== null && ms >= ini && ms <= fin;

export interface DocConId { id: string; data: DocumentData }

/** Órdenes que entran en la semana: entregadas, de ESTE motorizado y entregadas dentro de la semana de Managua. */
export function ordenesElegibles(ordenes: DocConId[], motorizadoId: string, ini: number, fin: number): DocConId[] {
  return ordenes
    .filter((o) => o.data.estado === 'entregado' && o.data.asignacion?.motorizadoId === motorizadoId && dentro(entregaDeOrden(o.data), ini, fin))
    .sort((a, b) => a.id.localeCompare(b.id));
}

/** Comisión de la orden: la base real aprobada (deliveryBase, o el precio final si no hay desglose), sin el 80%. */
export function baseComisionOrden(o: DocumentData): number {
  const base = o.precioDesglose?.deliveryBase;
  if (base !== undefined && base !== null) return aCentavos(base);
  return aCentavos(o.confirmacion?.precioFinalCordobas);
}

/** Efectivo que el motorizado le debe a StorkHub por la orden: la MISMA semántica que el depósito (calcularDeposito). */
export function efectivoAStorkhubOrden(o: DocumentData): number {
  return aCentavos(calcularDeposito(o).totalAStorkhub);
}

// ── Gastos ───────────────────────────────────────────────────────────────────

/** ¿El gasto tiene dueño económico ya? consumido por un depósito, o capturado por una liquidación. */
export function gastoTieneMarca(g: DocumentData): boolean {
  const dep = g.consumidoEnDepositoId;
  const liq = g.liquidacionId;
  return (typeof dep === 'string' && dep.length > 0) || (typeof liq === 'string' && liq.length > 0);
}

/** Gastos candidatos de la semana: aprobados, de este motorizado, con fecha dentro de la semana y SIN marca de consumo ni de liquidación. */
export function gastosCandidatos(gastos: DocConId[], motorizadoId: string, ini: number, fin: number): DocConId[] {
  return gastos
    .filter((g) => g.data.estado === 'aprobado' && g.data.motorizadoId === motorizadoId && dentro(milis(g.data.fecha), ini, fin)
      && !gastoTieneMarca(g.data) && esNumeroFinito(g.data.monto) && g.data.monto > 0)
    .sort((a, b) => a.id.localeCompare(b.id));
}

// ── Adelantos ────────────────────────────────────────────────────────────────

export interface ResultadoAdelantos {
  incluidos: DocConId[];
  /** Adelantos activos que NO se pueden ubicar en una semana: el llamador los concilia (no se excluyen en silencio). */
  ambiguos: DocConId[];
}

/**
 * Semana de un adelanto: su `semanaKey` declarada. Un adelanto anterior a FIN-1C-B pudo no traerla: entonces la semana de su `at` (resuelta por el
 * llamador, que es quien conoce la zona horaria). Sin `semanaKey` ni `at` legible —o con un monto inválido— no se puede saber si se descuenta: es ambiguo.
 */
export function adelantosDeSemana(
  movimientos: DocConId[],
  motorizadoId: string,
  semanaKey: string,
  semanaDeInstante: (ms: number) => string,
): ResultadoAdelantos {
  const incluidos: DocConId[] = [];
  const ambiguos: DocConId[] = [];
  for (const m of [...movimientos].sort((x, y) => x.id.localeCompare(y.id))) {
    if (m.data.tipo !== 'adelanto_motorizado' || m.data.motorizadoId !== motorizadoId || m.data.estado !== 'activo') continue;
    if (!esNumeroFinito(m.data.monto) || m.data.monto <= 0) { ambiguos.push(m); continue; }
    const declarada = typeof m.data.semanaKey === 'string' && m.data.semanaKey ? m.data.semanaKey : null;
    if (declarada) { if (declarada === semanaKey) incluidos.push(m); continue; }
    const at = milis(m.data.at);
    if (at === null) { ambiguos.push(m); continue; }
    if (semanaDeInstante(at) === semanaKey) incluidos.push(m);
  }
  return { incluidos, ambiguos };
}

// ── La fórmula ───────────────────────────────────────────────────────────────

export interface EntradaFormula {
  /** Σ base de comisión de las órdenes (centavos, sin el 80%). */
  baseComision: number;
  efectivoEsperado: number;
  gastosLiquidacion: number;
  gastosEnDepositos: number;
  depositado: number;
  adelantos: number;
  deudasAplicadas: number;
}

export interface ResultadoFormula {
  comision: number;
  efectivoEsperado: number;
  gastosTotales: number;
  gastosAsumidosStorkhub: number;
  totalADepositar: number;
  depositado: number;
  faltantesDeposito: number;
  adelantos: number;
  deudasAplicadas: number;
  netoAPagar: number;
}

/**
 * neto = comisión − adelantos − faltante + gastosAsumidosStorkhub − deudasAplicadas, con:
 *   gastos totales   = gastos que captura la liquidación + gastos que ya descontaron los depósitos de la semana
 *   asumidos         = máx(0, gastos totales − efectivo esperado)        (StorkHub asume el excedente)
 *   a depositar      = máx(0, efectivo esperado − gastos totales)
 *   faltante         = máx(0, a depositar − depositado)
 * Cada gasto cuenta UNA vez: o lo descontó un depósito (consumidoEnDepositoId) o lo captura la liquidación (liquidacionId).
 * Todo en centavos enteros: el resultado se devuelve en centavos.
 */
export function formulaLiquidacion(e: EntradaFormula): ResultadoFormula {
  const comision = Math.round(e.baseComision * COMISION_PCT);
  const gastosTotales = e.gastosLiquidacion + e.gastosEnDepositos;
  const gastosAsumidosStorkhub = Math.max(0, gastosTotales - e.efectivoEsperado);
  const totalADepositar = Math.max(0, e.efectivoEsperado - gastosTotales);
  const faltantesDeposito = Math.max(0, totalADepositar - e.depositado);
  const netoAPagar = comision - e.adelantos - faltantesDeposito + gastosAsumidosStorkhub - e.deudasAplicadas;
  return {
    comision, efectivoEsperado: e.efectivoEsperado, gastosTotales, gastosAsumidosStorkhub, totalADepositar, depositado: e.depositado,
    faltantesDeposito, adelantos: e.adelantos, deudasAplicadas: e.deudasAplicadas, netoAPagar,
  };
}
