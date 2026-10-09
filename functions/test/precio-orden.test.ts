import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import { baseComisionAprobada, derivarBaseComision, precioValido } from '../src/precio-orden';

// PRECIO-CONFIRMADO-ANTES-DE-OPERAR-1 · la base de la comisión: de dónde sale y cuándo NO se puede demostrar.

test('PO1 precioValido: solo números finitos y positivos', () => {
  for (const v of [1, 0.01, 150, 1e6]) assert.equal(precioValido(v), true, String(v));
  for (const v of [0, -1, NaN, Infinity, -Infinity, '150', null, undefined, {}, [150], true]) assert.equal(precioValido(v), false, String(v));
});

test('PO2 derivar: la base sale de la tarifa de la distancia, no del desglose ni del precio final', () => {
  const r = derivarBaseComision({ confirmacion: { precioFinalCordobas: 260 }, cotizacion: { distanciaKm: 21.759 }, precioDesglose: { deliveryBase: 210 } });
  assert.deepEqual(r, { ok: true, base: 210, origen: 'tarifa_distancia' });
  assert.deepEqual(derivarBaseComision({ confirmacion: { precioFinalCordobas: 150 }, cotizacion: { distanciaKm: 13.859 } }), { ok: true, base: 150, origen: 'tarifa_distancia' }); // sin desglose
});

test('PO3 derivar: sin precio final confirmado nunca hay base (E2)', () => {
  for (const confirmacion of [undefined, {}, { precioFinalCordobas: 0 }, { precioFinalCordobas: -1 }, { precioFinalCordobas: 'x' }, { precioFinalCordobas: NaN }]) {
    assert.deepEqual(derivarBaseComision({ confirmacion, cotizacion: { distanciaKm: 13.859 }, precioDesglose: { deliveryBase: 150 } }), { ok: false, motivo: 'sin_precio_confirmado' });
    assert.deepEqual(baseComisionAprobada({ confirmacion, comisionBaseCordobas: 150 }), { ok: false, motivo: 'sin_precio_confirmado' });
  }
});

test('PO4 derivar: un desglose que no cuadra con la tarifa o que no se puede verificar no se usa', () => {
  const conf = { precioFinalCordobas: 150 };
  assert.deepEqual(derivarBaseComision({ confirmacion: conf, cotizacion: { distanciaKm: 13.859 }, precioDesglose: { deliveryBase: 5000 } }), { ok: false, motivo: 'cotizacion_inconsistente' });
  assert.deepEqual(derivarBaseComision({ confirmacion: conf, cotizacion: { distanciaKm: 13.859 }, precioDesglose: { deliveryBase: 1 } }), { ok: false, motivo: 'cotizacion_inconsistente' });
  assert.deepEqual(derivarBaseComision({ confirmacion: conf, precioDesglose: { deliveryBase: 150 } }), { ok: false, motivo: 'cotizacion_incompleta' });
  assert.deepEqual(derivarBaseComision({ confirmacion: conf, cotizacion: { distanciaKm: 'trece' }, precioDesglose: { deliveryBase: 150 } }), { ok: false, motivo: 'cotizacion_incompleta' });
  assert.deepEqual(derivarBaseComision({ confirmacion: conf, cotizacion: { distanciaKm: 80 }, precioDesglose: { deliveryBase: 5000 } }), { ok: false, motivo: 'cotizacion_inconsistente' });
});

test('PO5 derivar: sin ningún dato del cliente (o distancia fuera del tarifario sin desglose) la base es el precio final que fijó el gestor', () => {
  assert.deepEqual(derivarBaseComision({ confirmacion: { precioFinalCordobas: 50 } }), { ok: true, base: 50, origen: 'precio_final_sin_desglose' });
  assert.deepEqual(derivarBaseComision({ confirmacion: { precioFinalCordobas: 700 }, cotizacion: { distanciaKm: 80 } }), { ok: true, base: 700, origen: 'precio_final_sin_desglose' });
  assert.deepEqual(derivarBaseComision({ confirmacion: { precioFinalCordobas: 50 }, precioDesglose: null, cotizacion: null }), { ok: true, base: 50, origen: 'precio_final_sin_desglose' });
});

test('PO6 aprobada: el snapshot del servidor gana sobre cualquier valor del cliente; sin snapshot se deriva', () => {
  const o = { confirmacion: { precioFinalCordobas: 260, comisionBaseCordobas: 210, comisionBaseOrigen: 'tarifa_distancia' }, precioDesglose: { deliveryBase: 99999 }, cotizacion: { distanciaKm: 2 } };
  assert.deepEqual(baseComisionAprobada(o), { ok: true, base: 210, origen: 'tarifa_distancia' });
  // un snapshot inválido (no positivo / texto) se ignora y se deriva
  assert.deepEqual(baseComisionAprobada({ ...o, confirmacion: { precioFinalCordobas: 260, comisionBaseCordobas: 0 } }), { ok: false, motivo: 'cotizacion_inconsistente' });
  assert.deepEqual(baseComisionAprobada({ confirmacion: { precioFinalCordobas: 260, comisionBaseCordobas: 'x' }, cotizacion: { distanciaKm: 21.759 }, precioDesglose: { deliveryBase: 210 } }), { ok: true, base: 210, origen: 'tarifa_distancia' });
});
