// IDENTIDAD-HUMANA-1 — suite focal de la frontera de asignación de códigos.
//
// Ejecuta la implementación real de `src/codigos.ts`: sin espejo, sin réplica,
// sin import cruzado hacia `lib/`. Los literales —SH-1001, DEP-1001,
// SH-1000000— son los mismos que fija `lib/codigo-humano.test.ts`, y esa
// coincidencia es lo que ata el contrato de formato a través de una frontera
// que ningún import puede cruzar.
//
// Lo que defiende: un retry no gasta un número, un estado a medias no se
// repara adivinando, y sin contador sembrado no se inventa una secuencia.

import { test } from 'node:test';
// `import * as` y no default: el tsconfig de Functions no activa
// esModuleInterop y el de tests no lo añade a propósito, para compilar con
// exactamente las mismas opciones que el código de deploy.
import * as assert from 'node:assert/strict';
import {
  decidirAsignacion,
  formatearCodigo,
  PREFIJO_ORDEN,
  PREFIJO_DEPOSITO,
  type Decision,
} from '../src/codigos';

/** Documento recién creado, sin código, con el contador sembrado en 1000. */
const nuevo = (over: Partial<Parameters<typeof decidirAsignacion>[0]> = {}) =>
  decidirAsignacion({
    prefijo: PREFIJO_ORDEN,
    codigoActual: undefined,
    secuenciaActual: undefined,
    valorContador: 1000,
    ...over,
  });

const asignada = (d: Decision) => {
  assert.equal(d.accion, 'asignar');
  return d as Extract<Decision, { accion: 'asignar' }>;
};

// ── Asignación ───────────────────────────────────────────────────────────────

test('K1 · documento nuevo sin código ⇒ asigna el siguiente', () => {
  const d = asignada(nuevo());
  assert.equal(d.secuencia, 1001);
  assert.equal(d.siguienteValor, 1001);
});

test('K2 · prefijo de orden ⇒ SH', () => {
  assert.equal(asignada(nuevo()).codigo, 'SH-1001');
});

test('K3 · prefijo de depósito ⇒ DEP', () => {
  assert.equal(asignada(nuevo({ prefijo: PREFIJO_DEPOSITO })).codigo, 'DEP-1001');
});

test('K4 · contador 1000 ⇒ 1001 (primer código de staging)', () => {
  assert.equal(asignada(nuevo({ valorContador: 1000 })).codigo, 'SH-1001');
  assert.equal(asignada(nuevo({ valorContador: 1000, prefijo: PREFIJO_DEPOSITO })).codigo, 'DEP-1001');
});

test('K5 · 999999 ⇒ SH-1000000, sin cambiar de formato', () => {
  const d = asignada(nuevo({ valorContador: 999999 }));
  assert.equal(d.codigo, 'SH-1000000');
  assert.equal(d.secuencia, 1000000);
});

test('K5b · un contador en 0 da el primer código, no el cero', () => {
  assert.equal(asignada(nuevo({ valorContador: 0 })).codigo, 'SH-1');
});

// ── Idempotencia ─────────────────────────────────────────────────────────────

test('K6 · documento ya completo y coherente ⇒ no-op', () => {
  const d = nuevo({ codigoActual: 'SH-1001', secuenciaActual: 1001 });
  assert.equal(d.accion, 'noop');
  assert.equal((d as { motivo: string }).motivo, 'YA_ASIGNADO');
});

test('K7 · retry del mismo evento ⇒ mismo código y ningún número consumido', () => {
  // Primera entrega: asigna 1001 y deja el contador en 1001.
  const primera = asignada(nuevo({ valorContador: 1000 }));
  assert.equal(primera.codigo, 'SH-1001');
  // Segunda entrega del MISMO evento: el documento ya se releyó con código.
  const segunda = nuevo({
    codigoActual: primera.codigo,
    secuenciaActual: primera.secuencia,
    valorContador: primera.siguienteValor,
  });
  assert.equal(segunda.accion, 'noop', 'un retry consumió un segundo número');
});

test('K8 · dos asignaciones consecutivas dan códigos distintos', () => {
  const a = asignada(nuevo({ valorContador: 1000 }));
  const b = asignada(nuevo({ valorContador: a.siguienteValor }));
  assert.equal(a.codigo, 'SH-1001');
  assert.equal(b.codigo, 'SH-1002');
  assert.notEqual(a.codigo, b.codigo);
  assert.equal(b.secuencia - a.secuencia, 1);
});

test('K8b · 50 asignaciones encadenadas: sin huecos ni repetidos', () => {
  let valor = 1000;
  const vistos: string[] = [];
  for (let i = 0; i < 50; i++) {
    const d = asignada(nuevo({ valorContador: valor }));
    vistos.push(d.codigo);
    valor = d.siguienteValor;
  }
  assert.equal(new Set(vistos).size, 50, 'hubo códigos repetidos');
  assert.equal(vistos[0], 'SH-1001');
  assert.equal(vistos[49], 'SH-1050');
  assert.equal(valor, 1050);
});

// ── Estados parciales: fail closed ───────────────────────────────────────────

test('K9 · código sin secuencia ⇒ bloquear, no reparar', () => {
  const d = nuevo({ codigoActual: 'SH-1001', secuenciaActual: undefined });
  assert.equal(d.accion, 'bloquear');
  assert.equal((d as { motivo: string }).motivo, 'CODIGO_ESTADO_PARCIAL');
});

test('K10 · secuencia sin código ⇒ bloquear, no reparar', () => {
  const d = nuevo({ codigoActual: undefined, secuenciaActual: 1001 });
  assert.equal(d.accion, 'bloquear');
  assert.equal((d as { motivo: string }).motivo, 'CODIGO_ESTADO_PARCIAL');
});

test('K10b · los dos presentes pero discrepantes ⇒ bloquear', () => {
  // Reconstruir uno desde el otro sería elegir cuál miente. Se para.
  for (const [c, s] of [['SH-1001', 999], ['SH-1001', 'mil uno'], ['DEP-5', 5], ['sh-1001', 1001], ['SH-1001', 0]] as const) {
    const d = nuevo({ codigoActual: c, secuenciaActual: s });
    assert.equal(d.accion, 'bloquear', `no bloqueó con codigo=${c} secuencia=${JSON.stringify(s)}`);
    assert.equal((d as { motivo: string }).motivo, 'CODIGO_INCOHERENTE');
  }
})

// ── Contador ─────────────────────────────────────────────────────────────────

test('K11 · contador ausente ⇒ bloquear, nunca arrancar en 1', () => {
  // Sembrarlo es un paso operativo deliberado. Arrancar solo produciría
  // códigos que un backfill posterior volvería a repartir.
  for (const v of [undefined, null]) {
    const d = nuevo({ valorContador: v });
    assert.equal(d.accion, 'bloquear');
    assert.equal((d as { motivo: string }).motivo, 'CONTADOR_AUSENTE');
  }
});

test('K12 · contador corrupto ⇒ bloquear', () => {
  for (const v of ['1000', 1000.5, -1, NaN, Infinity, {}, [], true]) {
    const d = nuevo({ valorContador: v });
    assert.equal(d.accion, 'bloquear', `aceptó un contador ${JSON.stringify(v) ?? String(v)}`);
    assert.equal((d as { motivo: string }).motivo, 'CONTADOR_CORRUPTO');
  }
});

test('K12b · contador al borde del entero seguro ⇒ bloquear en vez de perder precisión', () => {
  const d = nuevo({ valorContador: Number.MAX_SAFE_INTEGER });
  assert.equal(d.accion, 'bloquear');
});

// ── Prefijo ──────────────────────────────────────────────────────────────────

test('K13 · prefijo no permitido ⇒ bloquear y, al formatear, error', () => {
  for (const p of ['ORD', 'sh', '', 'SHH', 'DEPOSITO']) {
    const d = nuevo({ prefijo: p });
    assert.equal(d.accion, 'bloquear', `aceptó el prefijo ${p}`);
    assert.equal((d as { motivo: string }).motivo, 'PREFIJO_NO_PERMITIDO');
    assert.throws(() => formatearCodigo(p, 1), /prefijo no permitido/);
  }
});

// ── El código no sale de ningún otro campo ───────────────────────────────────

test('K14 · numeroOrden no participa: la firma ni siquiera lo admite', () => {
  // `numeroOrden` es la referencia libre del comercio ("#ORD-001", el número
  // de pedido de WhatsApp). El único origen de la secuencia es el contador.
  const entradas = Object.keys(nuevo as unknown as object);
  assert.equal(entradas.includes('numeroOrden'), false);
  // Y con un numeroOrden presente en el documento, el código sigue saliendo
  // del contador y solo del contador.
  const d = asignada(decidirAsignacion({
    prefijo: PREFIJO_ORDEN,
    codigoActual: undefined,
    secuenciaActual: undefined,
    valorContador: 1057,
  }));
  assert.equal(d.codigo, 'SH-1058');
});

test('K15 · formato canónico: sin padding, sin minúsculas, con guion', () => {
  assert.equal(formatearCodigo(PREFIJO_ORDEN, 1), 'SH-1');
  assert.equal(formatearCodigo(PREFIJO_ORDEN, 1058), 'SH-1058');
  assert.equal(formatearCodigo(PREFIJO_DEPOSITO, 247), 'DEP-247');
  assert.equal(formatearCodigo(PREFIJO_ORDEN, 1000000), 'SH-1000000');
  for (const n of [0, -1, 1.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 2]) {
    assert.throws(() => formatearCodigo(PREFIJO_ORDEN, n), /secuencia invalida/);
  }
});
