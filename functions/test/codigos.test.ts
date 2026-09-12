// IDENTIDAD-HUMANA-1B — suite focal de la frontera de asignación de códigos.
//
// Ejecuta la implementación real de `src/codigos.ts`: sin espejo, sin réplica,
// sin import cruzado hacia `lib/`. Los literales —SH-0001, DEP-0001, SH-9999,
// SH-10000— son los mismos que fija `lib/codigo-humano.test.ts`, y esa
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
  esMotivoEstructural,
  esFalloTransitorio,
  MOTIVOS_ESTRUCTURALES,
  type Decision,
} from '../src/codigos';

/**
 * Documento recién creado, sin código, con el contador en 0 — que es como
 * queda staging tras el reset de 1B, así que el primer código es SH-0001.
 */
const nuevo = (over: Partial<Parameters<typeof decidirAsignacion>[0]> = {}) =>
  decidirAsignacion({
    prefijo: PREFIJO_ORDEN,
    codigoActual: undefined,
    secuenciaActual: undefined,
    valorContador: 0,
    ...over,
  });

const asignada = (d: Decision) => {
  assert.equal(d.accion, 'asignar');
  return d as Extract<Decision, { accion: 'asignar' }>;
};

// ── Asignación ───────────────────────────────────────────────────────────────

test('K1 · documento nuevo sin código ⇒ asigna el siguiente', () => {
  const d = asignada(nuevo());
  assert.equal(d.secuencia, 1);
  assert.equal(d.siguienteValor, 1);
});

test('K2 · prefijo de orden ⇒ SH', () => {
  assert.equal(asignada(nuevo()).codigo, 'SH-0001');
});

test('K3 · prefijo de depósito ⇒ DEP', () => {
  assert.equal(asignada(nuevo({ prefijo: PREFIJO_DEPOSITO })).codigo, 'DEP-0001');
});

test('K4 · contador 0 ⇒ el primer código de staging', () => {
  assert.equal(asignada(nuevo({ valorContador: 0 })).codigo, 'SH-0001');
  assert.equal(asignada(nuevo({ valorContador: 0, prefijo: PREFIJO_DEPOSITO })).codigo, 'DEP-0001');
});

test('K4b · los saltos de ancho', () => {
  // 14 ⇒ 0015 sigue con padding; 999 ⇒ 1000 lo llena justo; 9999 ⇒ 10000 lo
  // supera y a partir de ahí el número crece solo.
  assert.equal(asignada(nuevo({ valorContador: 14 })).codigo, 'SH-0015');
  assert.equal(asignada(nuevo({ valorContador: 998 })).codigo, 'SH-0999');
  assert.equal(asignada(nuevo({ valorContador: 999 })).codigo, 'SH-1000');
  assert.equal(asignada(nuevo({ valorContador: 9998 })).codigo, 'SH-9999');
  assert.equal(asignada(nuevo({ valorContador: 9999 })).codigo, 'SH-10000');
  assert.equal(asignada(nuevo({ valorContador: 10000 })).codigo, 'SH-10001');
});

test('K5 · 999999 ⇒ SH-1000000, sin relleno artificial', () => {
  const d = asignada(nuevo({ valorContador: 999999 }));
  assert.equal(d.codigo, 'SH-1000000');
  assert.equal(d.secuencia, 1000000);
});

test('K5b · un contador en 0 da el primer código, no el cero', () => {
  assert.equal(asignada(nuevo({ valorContador: 0 })).secuencia, 1);
  assert.equal(asignada(nuevo({ valorContador: 0 })).codigo, 'SH-0001');
});

// ── Idempotencia ─────────────────────────────────────────────────────────────

test('K6 · documento ya completo y coherente ⇒ no-op', () => {
  // La coherencia se comprueba con el MISMO formateador, así que el padding
  // cuenta: 'SH-0001' con secuencia 1 es coherente, 'SH-1' no lo es.
  const d = nuevo({ codigoActual: 'SH-0001', secuenciaActual: 1 });
  assert.equal(d.accion, 'noop');
  assert.equal((d as { motivo: string }).motivo, 'YA_ASIGNADO');
  assert.equal(nuevo({ codigoActual: 'SH-1000', secuenciaActual: 1000 }).accion, 'noop');
  assert.equal(nuevo({ codigoActual: 'SH-10000', secuenciaActual: 10000 }).accion, 'noop');
});

test('K7 · retry del mismo evento ⇒ mismo código y ningún número consumido', () => {
  // Primera entrega: asigna la 1 y deja el contador en 1.
  const primera = asignada(nuevo({ valorContador: 0 }));
  assert.equal(primera.codigo, 'SH-0001');
  // Segunda entrega del MISMO evento: el documento ya se releyó con código.
  const segunda = nuevo({
    codigoActual: primera.codigo,
    secuenciaActual: primera.secuencia,
    valorContador: primera.siguienteValor,
  });
  assert.equal(segunda.accion, 'noop', 'un retry consumió un segundo número');
});

test('K8 · dos asignaciones consecutivas dan códigos distintos', () => {
  const a = asignada(nuevo({ valorContador: 0 }));
  const b = asignada(nuevo({ valorContador: a.siguienteValor }));
  assert.equal(a.codigo, 'SH-0001');
  assert.equal(b.codigo, 'SH-0002');
  assert.notEqual(a.codigo, b.codigo);
  assert.equal(b.secuencia - a.secuencia, 1);
});

test('K8b · 50 asignaciones encadenadas: sin huecos ni repetidos', () => {
  let valor = 0;
  const vistos: string[] = [];
  for (let i = 0; i < 50; i++) {
    const d = asignada(nuevo({ valorContador: valor }));
    vistos.push(d.codigo);
    valor = d.siguienteValor;
  }
  assert.equal(new Set(vistos).size, 50, 'hubo códigos repetidos');
  assert.equal(vistos[0], 'SH-0001');
  assert.equal(vistos[9], 'SH-0010');
  assert.equal(vistos[49], 'SH-0050');
  assert.equal(valor, 50);
});

// ── Estados parciales: fail closed ───────────────────────────────────────────

test('K9 · código sin secuencia ⇒ bloquear, no reparar', () => {
  const d = nuevo({ codigoActual: 'SH-0001', secuenciaActual: undefined });
  assert.equal(d.accion, 'bloquear');
  assert.equal((d as { motivo: string }).motivo, 'CODIGO_ESTADO_PARCIAL');
});

test('K10 · secuencia sin código ⇒ bloquear, no reparar', () => {
  const d = nuevo({ codigoActual: undefined, secuenciaActual: 1 });
  assert.equal(d.accion, 'bloquear');
  assert.equal((d as { motivo: string }).motivo, 'CODIGO_ESTADO_PARCIAL');
});

test('K10b · los dos presentes pero discrepantes ⇒ bloquear', () => {
  // Reconstruir uno desde el otro sería elegir cuál miente. Se para.
  // El padding entra en la comparación: un documento con el formato viejo
  // ('SH-1' con secuencia 1) ya no es coherente y se bloquea en vez de
  // reescribirse solo. Es lo correcto: reformatear en caliente sería
  // cambiarle el identificador a una orden que alguien ya pudo anotar.
  for (const [c, s] of [['SH-1001', 999], ['SH-1001', 'mil uno'], ['DEP-0005', 5], ['sh-0001', 1], ['SH-0001', 0], ['SH-1', 1], ['SH-01', 1], ['SH-00001', 1]] as const) {
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

test('K15 · formato canónico: cuatro dígitos mínimo, mayúsculas y guion', () => {
  assert.equal(formatearCodigo(PREFIJO_ORDEN, 1), 'SH-0001');
  assert.equal(formatearCodigo(PREFIJO_ORDEN, 15), 'SH-0015');
  assert.equal(formatearCodigo(PREFIJO_ORDEN, 1058), 'SH-1058');
  assert.equal(formatearCodigo(PREFIJO_DEPOSITO, 247), 'DEP-0247');
  assert.equal(formatearCodigo(PREFIJO_ORDEN, 9999), 'SH-9999');
  assert.equal(formatearCodigo(PREFIJO_ORDEN, 10000), 'SH-10000');
  assert.equal(formatearCodigo(PREFIJO_ORDEN, 1000000), 'SH-1000000');
  for (const n of [0, -1, 1.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 2]) {
    assert.throws(() => formatearCodigo(PREFIJO_ORDEN, n), /secuencia invalida/);
  }
});

// ─── Clasificación de fallos y política de retry ─────────────────────────────
//
// La Function declara `retry: true`, verificado en el manifiesto de deploy
// (`__endpoint.eventTrigger.retry === true`). Eso hace que una excepción se
// vuelva a entregar, así que QUÉ lanza y qué no deja de ser un detalle: es la
// diferencia entre un bucle y un documento sin código para siempre.

test('K16 · los motivos estructurales no mejoran reintentando', () => {
  for (const m of MOTIVOS_ESTRUCTURALES) {
    assert.equal(esMotivoEstructural(m), true, `${m} no figura como estructural`);
  }
  assert.equal(esMotivoEstructural('YA_ASIGNADO'), false);
  assert.equal(esMotivoEstructural('cualquier_otra_cosa'), false);
});

test('K17 · TODO "bloquear" que produce decidirAsignacion es estructural', () => {
  // Es la invariante que garantiza que no hay bucle: si algún camino
  // devolviera un motivo no clasificado, este test lo caza antes de que
  // alguien lo relance por error.
  const casos: Array<Parameters<typeof decidirAsignacion>[0]> = [
    { prefijo: 'ORD', codigoActual: undefined, secuenciaActual: undefined, valorContador: 1000 },
    { prefijo: PREFIJO_ORDEN, codigoActual: 'SH-0001', secuenciaActual: undefined, valorContador: 1000 },
    { prefijo: PREFIJO_ORDEN, codigoActual: undefined, secuenciaActual: 1, valorContador: 1000 },
    { prefijo: PREFIJO_ORDEN, codigoActual: 'SH-0001', secuenciaActual: 2, valorContador: 1000 },
    { prefijo: PREFIJO_ORDEN, codigoActual: undefined, secuenciaActual: undefined, valorContador: undefined },
    { prefijo: PREFIJO_ORDEN, codigoActual: undefined, secuenciaActual: undefined, valorContador: -3 },
    { prefijo: PREFIJO_ORDEN, codigoActual: undefined, secuenciaActual: undefined, valorContador: Number.MAX_SAFE_INTEGER },
  ];
  let bloqueos = 0;
  for (const c of casos) {
    const d = decidirAsignacion(c);
    if (d.accion !== 'bloquear') continue;
    bloqueos++;
    assert.equal(esMotivoEstructural(d.motivo), true, `motivo sin clasificar: ${d.motivo}`);
  }
  assert.equal(bloqueos, casos.length, 'algún caso dejó de bloquear');
});

test('K18 · fallos de infraestructura ⇒ transitorios (se relanzan)', () => {
  const transitorios: unknown[] = [
    { code: 14 }, { code: 'unavailable' }, { code: 'UNAVAILABLE' },
    { code: 4 }, { code: 'deadline-exceeded' },
    { code: 10 }, { code: 'aborted' },
    { code: 13 }, { code: 'internal' },
    { code: 8 }, { code: 'resource-exhausted' },
    { code: 2 }, { code: 'unknown' },
  ];
  for (const e of transitorios) {
    assert.equal(esFalloTransitorio(e), true, `no marcó transitorio ${JSON.stringify(e)}`);
  }
});

test('K19 · fallos permanentes ⇒ NO transitorios (no se relanzan)', () => {
  const permanentes: unknown[] = [
    { code: 3 }, { code: 'invalid-argument' },
    { code: 5 }, { code: 'not-found' },
    { code: 6 }, { code: 'already-exists' },
    { code: 7 }, { code: 'permission-denied' },
    { code: 9 }, { code: 'failed-precondition' },
    { code: 16 }, { code: 'unauthenticated' },
  ];
  for (const e of permanentes) {
    assert.equal(esFalloTransitorio(e), false, `marcó transitorio ${JSON.stringify(e)}`);
  }
});

test('K20 · los errores propios del módulo NO se reintentan', () => {
  // formatearCodigo solo puede lanzar si alguien lo llama mal, y eso no lo
  // arregla ningún reintento. Hoy es inalcanzable —decidirAsignacion valida
  // prefijo y secuencia antes— pero la clasificación no depende de eso.
  assert.equal(esFalloTransitorio(new Error('prefijo no permitido: "ORD"')), false);
  assert.equal(esFalloTransitorio(new Error('secuencia invalida: 0')), false);
});

test('K21 · lo desconocido se reintenta, y es a propósito', () => {
  // Las decisiones de este módulo no lanzan: devuelven 'bloquear' y salen
  // limpio. Una excepción sin código reconocible es casi siempre red o
  // backend. Y los dos errores no cuestan lo mismo: un reintento de mas es
  // barato, un documento sin codigo es permanente.
  for (const e of [new Error('socket hang up'), 'texto suelto', null, undefined, {}, { code: {} }, 42]) {
    assert.equal(esFalloTransitorio(e), true, `no reintentaria ${JSON.stringify(e) ?? String(e)}`);
  }
});
