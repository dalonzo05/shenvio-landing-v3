import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import { baseComisionAprobada, clasificarBaseComision, precioValido, resolverBaseConfirmacion } from '../src/precio-orden';

// PRECIO-CONFIRMADO-ANTES-DE-OPERAR-1 · la base de la comisión: de dónde sale, cuándo es manual y cuándo NO se puede demostrar.

test('PO1 precioValido: solo números finitos y positivos', () => {
  for (const v of [1, 0.01, 150, 1e6]) assert.equal(precioValido(v), true, String(v));
  for (const v of [0, -1, NaN, Infinity, -Infinity, '150', null, undefined, {}, [150], true]) assert.equal(precioValido(v), false, String(v));
});

test('PO2 clasificar: distancia dentro del tarifario → AUTOMÁTICA (la base sale de la tarifa, no del desglose ni del precio final)', () => {
  assert.deepEqual(clasificarBaseComision({ cotizacion: { distanciaKm: 21.759 }, precioDesglose: { deliveryBase: 210 } }), { tipo: 'automatica', base: 210 });
  assert.deepEqual(clasificarBaseComision({ cotizacion: { distanciaKm: 13.859 } }), { tipo: 'automatica', base: 150 }); // sin desglose
  assert.deepEqual(clasificarBaseComision({ cotizacion: { distanciaKm: 0 } }), { tipo: 'automatica', base: 70 });
});

test('PO3 clasificar: un desglose que no cuadra con la tarifa, o que no se puede verificar, se RECHAZA (no se rescata con la base manual)', () => {
  assert.deepEqual(clasificarBaseComision({ cotizacion: { distanciaKm: 13.859 }, precioDesglose: { deliveryBase: 5000 } }), { tipo: 'rechazo', motivo: 'cotizacion_inconsistente' });
  assert.deepEqual(clasificarBaseComision({ cotizacion: { distanciaKm: 13.859 }, precioDesglose: { deliveryBase: 1 } }), { tipo: 'rechazo', motivo: 'cotizacion_inconsistente' });
  assert.deepEqual(clasificarBaseComision({ cotizacion: { distanciaKm: 80 }, precioDesglose: { deliveryBase: 5000 } }), { tipo: 'rechazo', motivo: 'cotizacion_inconsistente' });
  assert.deepEqual(clasificarBaseComision({ precioDesglose: { deliveryBase: 150 } }), { tipo: 'rechazo', motivo: 'cotizacion_incompleta' });
  assert.deepEqual(clasificarBaseComision({ cotizacion: { distanciaKm: 'trece' }, precioDesglose: { deliveryBase: 150 } }), { tipo: 'rechazo', motivo: 'cotizacion_incompleta' });
});

test('PO4 clasificar: sin distancia legible (viaje anterior) o fuera del tarifario, sin desglose → MANUAL', () => {
  for (const o of [{}, { cotizacion: null, precioDesglose: null }, { cotizacion: { distanciaKm: null, fuentePrecio: 'viaje_anterior' } }, { cotizacion: { distanciaKm: 54 } }, { cotizacion: { distanciaKm: 80 } }, { cotizacion: { distanciaKm: NaN } }, { cotizacion: { distanciaKm: -3 } }, { cotizacion: { distanciaKm: Infinity } }]) {
    assert.deepEqual(clasificarBaseComision(o), { tipo: 'manual' }, JSON.stringify(o));
  }
});

test('PO5 resolver AUTOMÁTICO: base de la tarifa; 420/150 y 440/70 se rechazan (precio_incoherente); 210/260 y 70/150 pasan; una base manual enviada NO aplica', () => {
  assert.deepEqual(resolverBaseConfirmacion({ cotizacion: { distanciaKm: 13.859 } }, 150, undefined), { ok: true, base: 150, origen: 'tarifa_distancia' });
  assert.deepEqual(resolverBaseConfirmacion({ cotizacion: { distanciaKm: 21.759 }, precioDesglose: { deliveryBase: 210 } }, 260, undefined), { ok: true, base: 210, origen: 'tarifa_distancia' });
  assert.deepEqual(resolverBaseConfirmacion({ cotizacion: { distanciaKm: 49.5 }, precioDesglose: { deliveryBase: 420 } }, 150, undefined), { ok: false, motivo: 'precio_incoherente' });
  assert.deepEqual(resolverBaseConfirmacion({ cotizacion: { distanciaKm: 53.9 }, precioDesglose: { deliveryBase: 440 } }, 70, undefined), { ok: false, motivo: 'precio_incoherente' });
  assert.deepEqual(resolverBaseConfirmacion({ cotizacion: { distanciaKm: 1 } }, 150, undefined), { ok: true, base: 70, origen: 'tarifa_distancia' }); // distancia falsa menor: P2 documentado, base <= final
  assert.deepEqual(resolverBaseConfirmacion({ cotizacion: { distanciaKm: 13.859 } }, 150, 100), { ok: false, motivo: 'base_manual_no_aplica' });
});

test('PO6 resolver MANUAL: la base es obligatoria, finita, > 0 y <= precio final; nunca cae al precio final ni al desglose', () => {
  const manual = { cotizacion: { distanciaKm: null, fuentePrecio: 'viaje_anterior' } };
  assert.deepEqual(resolverBaseConfirmacion(manual, 260, undefined), { ok: false, motivo: 'base_comision_requerida' });
  for (const m of [0, -5, NaN, Infinity, '210', null, {}]) assert.deepEqual(resolverBaseConfirmacion(manual, 260, m), { ok: false, motivo: 'base_comision_requerida' }, String(m));
  assert.deepEqual(resolverBaseConfirmacion(manual, 260, 210), { ok: true, base: 210, origen: 'manual_gestor' });
  assert.deepEqual(resolverBaseConfirmacion(manual, 150, 70), { ok: true, base: 70, origen: 'manual_gestor' });
  assert.deepEqual(resolverBaseConfirmacion(manual, 260, 260), { ok: true, base: 260, origen: 'manual_gestor' }); // válido: el gestor declara que los 260 son comisionables
  assert.deepEqual(resolverBaseConfirmacion(manual, 150, 420), { ok: false, motivo: 'precio_incoherente' });
  assert.deepEqual(resolverBaseConfirmacion(manual, 70, 440), { ok: false, motivo: 'precio_incoherente' });
  assert.deepEqual(resolverBaseConfirmacion({ cotizacion: { distanciaKm: 80 } }, 700, 600), { ok: true, base: 600, origen: 'manual_gestor' }); // fuera del tarifario
});

test('PO7 resolver: sin precio final válido nunca hay base', () => {
  for (const p of [undefined, null, 0, -1, NaN, 'x']) assert.deepEqual(resolverBaseConfirmacion({ cotizacion: { distanciaKm: 13.859 } }, p, undefined), { ok: false, motivo: 'sin_precio_confirmado' }, String(p));
});

test('PO8 aprobada (liquidación): el snapshot coherente gana sobre todo valor del cliente; ambos orígenes', () => {
  const o = (conf: object, extra: object = {}) => ({ confirmacion: { precioFinalCordobas: 260, ...conf }, precioDesglose: { deliveryBase: 99999 }, cotizacion: { distanciaKm: 2 }, ...extra });
  assert.deepEqual(baseComisionAprobada(o({ comisionBaseCordobas: 210, comisionBaseOrigen: 'tarifa_distancia' })), { ok: true, base: 210, origen: 'tarifa_distancia' });
  assert.deepEqual(baseComisionAprobada(o({ comisionBaseCordobas: 210, comisionBaseOrigen: 'manual_gestor' })), { ok: true, base: 210, origen: 'manual_gestor' });
});

test('PO9 aprobada: snapshot con base > precio final (420/150) → precio_incoherente; snapshot corrupto (origen ajeno, base inválida) → no se "repara" con otra fuente', () => {
  const base = { cotizacion: { distanciaKm: 13.859 } };
  assert.deepEqual(baseComisionAprobada({ ...base, confirmacion: { precioFinalCordobas: 150, comisionBaseCordobas: 420, comisionBaseOrigen: 'tarifa_distancia' } }), { ok: false, motivo: 'precio_incoherente' });
  assert.deepEqual(baseComisionAprobada({ ...base, confirmacion: { precioFinalCordobas: 150, comisionBaseCordobas: 420, comisionBaseOrigen: 'manual_gestor' } }), { ok: false, motivo: 'precio_incoherente' });
  for (const conf of [
    { comisionBaseCordobas: 150, comisionBaseOrigen: 'precio_final_sin_desglose' },
    { comisionBaseCordobas: 150 },
    { comisionBaseCordobas: 0, comisionBaseOrigen: 'tarifa_distancia' },
    { comisionBaseCordobas: 'x', comisionBaseOrigen: 'manual_gestor' },
    { comisionBaseCordobas: -3, comisionBaseOrigen: 'manual_gestor' },
  ]) assert.deepEqual(baseComisionAprobada({ ...base, confirmacion: { precioFinalCordobas: 150, ...conf } }), { ok: false, motivo: 'base_comision_requerida' }, JSON.stringify(conf));
});

test('PO10 aprobada, orden anterior SIN snapshot: solo la derivación automática; lo que necesitaría base manual o no cuadra, NO se paga', () => {
  const conf = { precioFinalCordobas: 260 };
  assert.deepEqual(baseComisionAprobada({ confirmacion: conf, cotizacion: { distanciaKm: 21.759 }, precioDesglose: { deliveryBase: 210 } }), { ok: true, base: 210, origen: 'tarifa_distancia' });
  assert.deepEqual(baseComisionAprobada({ confirmacion: conf }), { ok: false, motivo: 'base_comision_requerida' });                          // sin desglose ni cotización: NO base = precio final
  assert.deepEqual(baseComisionAprobada({ confirmacion: conf, cotizacion: { distanciaKm: 80 } }), { ok: false, motivo: 'base_comision_requerida' });
  assert.deepEqual(baseComisionAprobada({ confirmacion: conf, cotizacion: { distanciaKm: 13.859 }, precioDesglose: { deliveryBase: 5000 } }), { ok: false, motivo: 'cotizacion_inconsistente' });
  assert.deepEqual(baseComisionAprobada({ confirmacion: conf, precioDesglose: { deliveryBase: 210 } }), { ok: false, motivo: 'cotizacion_incompleta' });
  assert.deepEqual(baseComisionAprobada({ confirmacion: { precioFinalCordobas: 100 }, cotizacion: { distanciaKm: 49.5 } }), { ok: false, motivo: 'precio_incoherente' }); // tarifa 420 > 100
  for (const confirmacion of [undefined, {}, { precioFinalCordobas: 0 }, { precioFinalCordobas: 'x' }]) assert.deepEqual(baseComisionAprobada({ confirmacion, comisionBaseCordobas: 150, cotizacion: { distanciaKm: 13.859 } }), { ok: false, motivo: 'sin_precio_confirmado' });
});
