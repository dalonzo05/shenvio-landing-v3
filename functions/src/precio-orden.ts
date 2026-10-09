// PRECIO-CONFIRMADO-ANTES-DE-OPERAR-1 — qué precio de una orden es AUTORITATIVO y de dónde sale la BASE DE LA COMISIÓN.
//
// Hasta ahora la comisión del motorizado salía de `precioDesglose.deliveryBase`, un valor que el navegador escribe al crear la orden y que nadie recalculaba:
// un comercio con un cliente modificado podía poner 5000 y el motorizado cobraba el 80% (E1). Además una orden podía asignarse, entregarse y liquidarse sin
// precio confirmado (E2).
//
// El contrato económico NO cambia: el precio final al cliente puede incluir recargos; la comisión se calcula sobre la BASE (la tarifa por distancia), no sobre
// el precio final. Lo único que cambia es quién ESTABLECE esa base:
//
//   · al confirmar el precio (asignarMotorizado, Admin SDK) el servidor deriva la base con la fórmula canónica (./tarifa-envio) y la deja en
//     `confirmacion.comisionBaseCordobas` junto con su origen. Es un snapshot: lo que el cliente edite después en `cotizacion` ya no la mueve;
//   · una orden anterior a este cambio no trae snapshot: se deriva AL LIQUIDAR con la misma fórmula, y solo si lo que trae la orden la demuestra;
//   · lo que no se puede demostrar NO se paga: la liquidación pide conciliación.
//
// LÍMITE QUE QUEDA, dicho sin adornos: la distancia (`cotizacion.distanciaKm`) la envía el navegador y el servidor no la recalcula (no llama a Google). Un
// cliente modificado ya NO puede poner el monto directamente (eso es lo que se cerró), pero sí puede declarar una distancia distinta y obtener otra tarifa
// del tarifario (acotada: máximo C$440). El gestor ve y confirma el precio final antes de que la orden opere.

import type { DocumentData } from 'firebase-admin/firestore';
import { tarifa } from './tarifa-envio';

export type OrigenBaseComision = 'tarifa_distancia' | 'precio_final_sin_desglose';

export type MotivoBaseNoDemostrable =
  | 'sin_precio_confirmado'
  | 'cotizacion_incompleta'
  | 'cotizacion_inconsistente';

export type ResultadoBaseComision =
  | { ok: true; base: number; origen: OrigenBaseComision }
  | { ok: false; motivo: MotivoBaseNoDemostrable };

/** Un precio utilizable: número finito y positivo. Texto, NaN, Infinity, 0 y negativos no lo son. */
export const precioValido = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v) && v > 0;

const presente = (v: unknown): boolean => v !== undefined && v !== null;

/**
 * Deriva la base de la comisión de una orden con la fórmula canónica, SIN mirar ningún snapshot.
 *
 *  1. Sin precio final confirmado → no hay nada que demostrar (`sin_precio_confirmado`).
 *  2. Con una distancia legible dentro del tarifario: la base es `tarifa(distancia)`. Si el desglose del cliente declara otra base → `cotizacion_inconsistente`.
 *  3. Con una distancia fuera del tarifario (más de 54 km: cotización manual del gestor): sin desglose, la base es el precio final que el gestor fijó; con un
 *     desglose que pretende una base → `cotizacion_inconsistente`.
 *  4. Sin distancia legible: con un desglose que pretende una base → `cotizacion_incompleta` (un valor del cliente que no se puede verificar NO se usa);
 *     sin desglose alguno, la base es el precio final (la regla que ya existía para las órdenes sin desglose).
 */
export function derivarBaseComision(o: DocumentData): ResultadoBaseComision {
  const precioFinal = o.confirmacion?.precioFinalCordobas;
  if (!precioValido(precioFinal)) return { ok: false, motivo: 'sin_precio_confirmado' };

  const declarada = o.precioDesglose?.deliveryBase;
  const km = o.cotizacion?.distanciaKm;

  if (typeof km === 'number' && Number.isFinite(km)) {
    const t = tarifa(km);
    if (t > 0) {
      if (presente(declarada) && Number(declarada) !== t) return { ok: false, motivo: 'cotizacion_inconsistente' };
      return { ok: true, base: t, origen: 'tarifa_distancia' };
    }
    if (presente(declarada)) return { ok: false, motivo: 'cotizacion_inconsistente' };
    return { ok: true, base: precioFinal, origen: 'precio_final_sin_desglose' };
  }

  if (presente(declarada)) return { ok: false, motivo: 'cotizacion_incompleta' };
  return { ok: true, base: precioFinal, origen: 'precio_final_sin_desglose' };
}

/**
 * La base de la comisión que la liquidación puede PAGAR: el snapshot que dejó el servidor al confirmar el precio; si la orden es anterior al snapshot, la
 * derivación. Exige siempre un precio final confirmado: una orden que nunca se confirmó no paga comisión.
 */
export function baseComisionAprobada(o: DocumentData): ResultadoBaseComision {
  if (!precioValido(o.confirmacion?.precioFinalCordobas)) return { ok: false, motivo: 'sin_precio_confirmado' };
  const snap = o.confirmacion?.comisionBaseCordobas;
  if (precioValido(snap)) {
    const origen: OrigenBaseComision = o.confirmacion?.comisionBaseOrigen === 'precio_final_sin_desglose' ? 'precio_final_sin_desglose' : 'tarifa_distancia';
    return { ok: true, base: snap, origen };
  }
  return derivarBaseComision(o);
}
