// PRECIO-CONFIRMADO-ANTES-DE-OPERAR-1 — qué precio de una orden es AUTORITATIVO y de dónde sale la BASE DE LA COMISIÓN.
//
// Hasta ahora la comisión del motorizado salía de `precioDesglose.deliveryBase`, un valor que el navegador escribe al crear la orden y que nadie recalculaba:
// un comercio con un cliente modificado podía poner 5000 y el motorizado cobraba el 80% (E1). Además una orden podía asignarse, entregarse y liquidarse sin
// precio confirmado (E2).
//
// El contrato económico NO cambia: el precio final al cliente puede incluir recargos; la comisión se calcula sobre la BASE (sin recargos), no sobre el precio
// final. Lo único que cambia es quién ESTABLECE esa base, y hay DOS caminos, nunca un tercero:
//
//   A · AUTOMÁTICO — el servidor demuestra la base con la tarifa canónica (./tarifa-envio) a partir de la distancia cotizada: origen `tarifa_distancia`.
//   B · MANUAL — el servidor NO puede derivarla (viaje anterior sin distancia, distancia fuera del tarifario…): el GESTOR la declara, sin recargos, al confirmar
//       el precio (`comisionBaseManualCordobas`); origen `manual_gestor`. Nunca se asume que es el precio final: el precio final puede traer recargos.
//
// En los dos casos queda un snapshot en `confirmacion` (lo escribe asignarMotorizado con el Admin SDK) y rige una invariante: 0 < base <= precio final.
//
// Este archivo y lib/precio-orden.ts son byte a byte el mismo (lib/precio-orden.test.ts lo comprueba): el navegador lo usa para saber si pide la base manual,
// el servidor para decidir.
//
// LÍMITES QUE QUEDAN, sin adornos: (1) la distancia (\`cotizacion.distanciaKm\`) la envía el navegador y el servidor no la recalcula: un cliente modificado ya NO
// puede poner el monto, pero sí declarar otra distancia y obtener otra tarifa (acotada por el tarifario, y nunca mayor que el precio final que confirma el gestor);
// una distancia falsa menor produce una base menor. (2) En el camino manual la base es una decisión del gestor y queda auditada (actor y fecha del servidor).

import { tarifa } from './tarifa-envio';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type Orden = { [clave: string]: any };

export type OrigenBaseComision = 'tarifa_distancia' | 'manual_gestor';

export type MotivoBaseNoDemostrable =
  | 'sin_precio_confirmado'
  | 'cotizacion_incompleta'
  | 'cotizacion_inconsistente'
  | 'precio_incoherente'
  | 'base_comision_requerida'
  | 'base_manual_no_aplica';

export type ResultadoBaseComision =
  | { ok: true; base: number; origen: OrigenBaseComision }
  | { ok: false; motivo: MotivoBaseNoDemostrable };

/** Un precio utilizable: número finito y positivo. Texto, NaN, Infinity, 0 y negativos no lo son. */
export const precioValido = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v) && v > 0;

const presente = (v: unknown): boolean => v !== undefined && v !== null;

export type ClasificacionBase =
  | { tipo: 'automatica'; base: number }
  | { tipo: 'manual' }
  | { tipo: 'rechazo'; motivo: 'cotizacion_incompleta' | 'cotizacion_inconsistente' };

/**
 * ¿Cómo se obtiene la base de esta orden? Solo mira lo que el cliente cotizó (distancia y desglose); no mira ningún precio confirmado.
 *
 *  · Distancia legible dentro del tarifario → AUTOMÁTICA: `tarifa(distancia)`. Si el desglose del cliente declara otra base → rechazo (`cotizacion_inconsistente`).
 *  · Distancia legible fuera del tarifario (54 km o más): con un desglose que pretende una base → rechazo; sin desglose → MANUAL.
 *  · Sin distancia legible: con un desglose que pretende una base (un valor que no se puede verificar) → rechazo (`cotizacion_incompleta`); sin desglose → MANUAL
 *    (p. ej. el precio salió de un viaje anterior).
 */
export function clasificarBaseComision(o: Orden): ClasificacionBase {
  const declarada = o.precioDesglose?.deliveryBase;
  const km = o.cotizacion?.distanciaKm;
  if (typeof km === 'number' && Number.isFinite(km) && km >= 0) {
    const t = tarifa(km);
    if (t > 0) {
      if (presente(declarada) && Number(declarada) !== t) return { tipo: 'rechazo', motivo: 'cotizacion_inconsistente' };
      return { tipo: 'automatica', base: t };
    }
    if (presente(declarada)) return { tipo: 'rechazo', motivo: 'cotizacion_inconsistente' };
    return { tipo: 'manual' };
  }
  if (presente(declarada)) return { tipo: 'rechazo', motivo: 'cotizacion_incompleta' };
  return { tipo: 'manual' };
}

/**
 * La base que queda en el snapshot al CONFIRMAR el precio de una orden (asignarMotorizado). `manual` es lo que el gestor declaró (sin recargos), o undefined.
 *
 *  · Automática: la base sale de la tarifa; una base manual enviada se rechaza (`base_manual_no_aplica`: el sistema ya la demuestra).
 *  · Manual: la base manual es OBLIGATORIA (`base_comision_requerida`); nunca se usa el precio final ni el desglose del cliente como respaldo.
 *  · Siempre: 0 < base <= precio final (`precio_incoherente`).
 */
export function resolverBaseConfirmacion(o: Orden, precioFinal: unknown, manual: unknown): ResultadoBaseComision {
  if (!precioValido(precioFinal)) return { ok: false, motivo: 'sin_precio_confirmado' };
  const c = clasificarBaseComision(o);
  if (c.tipo === 'rechazo') return { ok: false, motivo: c.motivo };
  if (c.tipo === 'automatica') {
    if (manual !== undefined) return { ok: false, motivo: 'base_manual_no_aplica' };
    if (c.base > precioFinal) return { ok: false, motivo: 'precio_incoherente' };
    return { ok: true, base: c.base, origen: 'tarifa_distancia' };
  }
  if (manual === undefined || !precioValido(manual)) return { ok: false, motivo: 'base_comision_requerida' };
  if (manual > precioFinal) return { ok: false, motivo: 'precio_incoherente' };
  return { ok: true, base: manual, origen: 'manual_gestor' };
}

/**
 * La base de la comisión que la liquidación puede PAGAR.
 *
 *  · Orden con snapshot (confirmada después de este cambio): el snapshot, si es coherente (origen conocido, base > 0 y <= precio final). Un snapshot corrupto no
 *    se "repara" con otra fuente: se concilia.
 *  · Orden anterior sin snapshot: solo la derivación AUTOMÁTICA (la tarifa de su distancia). Si necesitaría una base manual, no se asume nada.
 *  · Siempre exige un precio final confirmado: una orden que nunca se confirmó no paga comisión.
 */
export function baseComisionAprobada(o: Orden): ResultadoBaseComision {
  const precioFinal = o.confirmacion?.precioFinalCordobas;
  if (!precioValido(precioFinal)) return { ok: false, motivo: 'sin_precio_confirmado' };
  const snap = o.confirmacion?.comisionBaseCordobas;
  if (presente(snap)) {
    const origen = o.confirmacion?.comisionBaseOrigen;
    if (!precioValido(snap) || (origen !== 'tarifa_distancia' && origen !== 'manual_gestor')) return { ok: false, motivo: 'base_comision_requerida' };
    if (snap > precioFinal) return { ok: false, motivo: 'precio_incoherente' };
    return { ok: true, base: snap, origen };
  }
  const c = clasificarBaseComision(o);
  if (c.tipo === 'rechazo') return { ok: false, motivo: c.motivo };
  if (c.tipo === 'manual') return { ok: false, motivo: 'base_comision_requerida' };
  if (c.base > precioFinal) return { ok: false, motivo: 'precio_incoherente' };
  return { ok: true, base: c.base, origen: 'tarifa_distancia' };
}
