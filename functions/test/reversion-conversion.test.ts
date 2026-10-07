// FIN-4B — revertirConversionEnDeudaCore: reversión autoritativa, segura e idempotente de una conversión a deuda.
//
// El "mundo" simula lo que importa de Firestore (el mismo criterio que conversion-deposito-deuda.test.ts):
// transacciones optimistas con reintento, escrituras todo-o-nada, create()/update(), update con rutas con
// puntos y FieldValue.delete(). La prueba con el emulador real vive en el runtime (RT-B1..B10).
import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { DocumentData } from 'firebase-admin/firestore';
import {
  revertirConversionEnDeudaCore, validarPeticionReversion, EVENTO_CONVERSION_REVERTIDA,
  type DepsReversion, type TxReversion,
} from '../src/reversion-conversion';
import { ESTADOS_CONVERTIBLES } from '../src/conversion-deposito-deuda';
import { ESTADOS_ABONABLES } from '../src/abono-directo';

type Doc = Record<string, unknown>;
const TS = (n: number) => ({ __ts: n });
const ELIMINAR = { __delete: true };
const codigo = (code: string, motivo?: string) => (e: unknown) => {
  const err = e as { code?: string; details?: { motivo?: string } };
  return err.code === code && (motivo === undefined || err.details?.motivo === motivo);
};

function mundo() {
  let store = new Map<string, Doc>();
  let revision = 0;
  let relojes = 0;
  let eventos = 0;
  let escrituras = 0;
  const hooks: { antesDeCommit?: () => void; fallarSi?: (op: string, ruta: string) => boolean } = {};
  const clonar = (m: Map<string, Doc>) => new Map([...m].map(([k, v]) => [k, structuredClone(v)]));
  const put = (ruta: string, d: Doc) => { store.set(ruta, d); };
  const get = (ruta: string) => { const d = store.get(ruta); return d ? (structuredClone(d) as DocumentData) : null; };

  // update() con rutas con puntos y FieldValue.delete(), como Firestore.
  function aplicarUpdate(actual: Doc, campos: Doc): Doc {
    const r = structuredClone(actual);
    for (const [k, v] of Object.entries(campos)) {
      const partes = k.split('.');
      let cursor = r as Record<string, unknown>;
      for (const p of partes.slice(0, -1)) {
        if (typeof cursor[p] !== 'object' || cursor[p] === null) cursor[p] = {};
        cursor = cursor[p] as Record<string, unknown>;
      }
      const ultima = partes[partes.length - 1];
      if (v === ELIMINAR) delete cursor[ultima]; else cursor[ultima] = structuredClone(v);
    }
    return r;
  }

  const deps: DepsReversion = {
    serverTimestamp: () => TS(++relojes),
    eliminar: () => ELIMINAR,
    nuevoEventoId: () => `ev${++eventos}`,
    async transaction(fn) {
      for (;;) {
        const inicio = revision;
        const cola: Array<{ op: string; ruta: string; datos: Doc }> = [];
        const tx: TxReversion = {
          async getUsuario(uid) { return get(`usuarios/${uid}`); },
          async getSaldo(id) { return get(`saldos_cargo_motorizado/${id}`); },
          async getDeposito(id) { return get(`ordenes_deposito/${id}`); },
          async getSolicitud(id) { return get(`solicitudes_envio/${id}`); },
          async getMovimientosDeSaldo(saldoId) {
            return [...store].filter(([r, d]) => r.startsWith('movimientos_financieros/') && d.saldoId === saldoId)
              .map(([r, d]) => ({ id: r.split('/')[1], data: structuredClone(d) as DocumentData }));
          },
          updateSaldo(id, c) { cola.push({ op: 'update', ruta: `saldos_cargo_motorizado/${id}`, datos: c }); },
          updateMovimiento(id, c) { cola.push({ op: 'update', ruta: `movimientos_financieros/${id}`, datos: c }); },
          updateDeposito(id, c) { cola.push({ op: 'update', ruta: `ordenes_deposito/${id}`, datos: c }); },
          updateSolicitud(id, c) { cola.push({ op: 'update', ruta: `solicitudes_envio/${id}`, datos: c }); },
          crearEvento(depId, evId, c) { cola.push({ op: 'create', ruta: `ordenes_deposito/${depId}/eventos/${evId}`, datos: c }); },
        };
        const resultado = await fn(tx);
        const hook = hooks.antesDeCommit; hooks.antesDeCommit = undefined; hook?.();
        if (revision !== inicio) continue; // conflicto: se descarta el intento y se relee
        const copia = clonar(store);
        for (const w of cola) {
          if (hooks.fallarSi?.(w.op, w.ruta)) throw new Error('fallo simulado de escritura: ' + w.ruta);
          if (w.op === 'create') {
            if (copia.has(w.ruta)) throw new Error('ALREADY_EXISTS ' + w.ruta);
            copia.set(w.ruta, structuredClone(w.datos));
          } else {
            const actual = copia.get(w.ruta);
            if (!actual) throw new Error('NOT_FOUND ' + w.ruta);
            copia.set(w.ruta, aplicarUpdate(actual, w.datos));
          }
        }
        store = copia; // commit atómico: todo o nada
        if (cola.length) { revision++; escrituras += cola.length; }
        return resultado;
      }
    },
  };
  return {
    deps, hooks, put, get,
    get escrituras() { return escrituras; },
    snapshot: () => JSON.stringify([...store].sort(([a], [b]) => a.localeCompare(b))),
    bump: () => { revision++; },
    eventosDe: (depId: string) => [...store].filter(([r]) => r.startsWith(`ordenes_deposito/${depId}/eventos/`)).map(([, d]) => d),
    movimientos: () => [...store].filter(([r]) => r.startsWith('movimientos_financieros/')).map(([r, d]) => ({ id: r.split('/')[1], ...d } as Doc & { id: string })),
  };
}
type Mundo = ReturnType<typeof mundo>;

const MOT = 'motA';
const ordenConvertida = (depId = 'D1'): Doc => ({
  estado: 'entregado', userId: 'comercioUid',
  registro: { deposito: { storkhubDepositoId: depId, confirmadoStorkhub: true, confirmadoStorkhubAt: TS(5), comercioDepositoId: 'DC9' } },
});
const BOUCHER = { url: 'https://ex.test/b.jpg', pathStorage: 'depositos/m/D1/boucher.jpg' };

interface Opciones { boucher?: boolean; saldo?: Doc; dep?: Doc; legacy?: boolean; sinMovimiento?: boolean }
/** Un ciclo FIN-4A coherente: depósito convertido, saldo pendiente, UN movimiento de conversión activo, órdenes y gasto. */
function sembrar(w: Mundo, opts: Opciones = {}) {
  w.put('usuarios/g1', { activo: true, rol: 'gestor' });
  w.put('usuarios/a1', { activo: true, rol: 'admin' });
  w.put('usuarios/dig', { activo: true, rol: 'digitador' });
  w.put('usuarios/mot', { activo: true, rol: 'motorizado' });
  w.put('usuarios/com', { activo: true, rol: 'Comercio' });
  w.put('usuarios/baja', { activo: false, rol: 'gestor' });
  w.put('solicitudes_envio/o1', ordenConvertida());
  w.put('solicitudes_envio/o2', ordenConvertida());
  w.put('solicitudes_envio/ajena', ordenConvertida('D2')); // de OTRO depósito: no se toca
  w.put('gastos_motorizado/g1', { motorizadoId: MOT, estado: 'aprobado', monto: 10, consumidoEnDepositoId: 'D1' });
  w.put('ordenes_deposito/D1', {
    tipo: 'recaudacion_motorizado_storkhub', estado: 'convertido_en_deuda', destinatario: 'storkhub',
    motorizadoUid: 'authMot', motorizadoNombre: 'Luigi', solicitudIds: ['o1', 'o2'],
    montoBruto: 100, gastosDescontados: 10, montoTotal: 90, gastosIds: ['g1'],
    saldoId: 'S1', notaConversion: 'No depositó', convertidoPorUid: 'g1', convertidoAt: TS(7),
    ...(opts.boucher ? { boucher: BOUCHER, boucherVersion: 1 } : {}),
    ...opts.dep,
  });
  w.put('saldos_cargo_motorizado/S1', {
    motorizadoId: MOT, motorizadoNombre: 'Luigi', tipo: 'deposito_no_realizado', origen: 'deposito', depositoId: 'D1',
    montoOriginal: 90, saldoPendiente: 90, estado: 'pendiente', abonos: [], ...opts.saldo,
  });
  if (!opts.sinMovimiento) {
    w.put(opts.legacy ? 'movimientos_financieros/XyZ9legacy' : 'movimientos_financieros/conv_S1', {
      tipo: 'deposito_convertido_en_deuda', monto: 90, estado: 'activo', motorizadoId: MOT, depositoId: 'D1', saldoId: 'S1',
      cuentaOrigen: `efectivo_en_poder:${MOT}`, cuentaDestino: `deuda_motorizado:${MOT}`, propietario: 'storkhub', creadoPorRol: 'gestor',
    });
  }
}

const P = { saldoId: 'S1', motivo: 'Convertido por error' };
const revertir = (w: Mundo, uid: string | undefined = 'g1', data: unknown = P) => revertirConversionEnDeudaCore(w.deps, uid, data);
const sinEfectos = async (w: Mundo, promesa: Promise<unknown>, esperado: (e: unknown) => boolean) => {
  const antes = w.snapshot(); const e0 = w.escrituras;
  await assert.rejects(promesa, esperado);
  assert.equal(w.snapshot(), antes, 'el estado no cambió');
  assert.equal(w.escrituras, e0, '0 escrituras');
};

// ── B1 / B2 · el caso feliz, con y sin boucher ───────────────────────────────
test('F4B-B1 · deuda virgen CON boucher ⇒ depósito en_revision; saldo y movimiento anulados; evento; órdenes como Rehacer; gastos intactos', async () => {
  const w = mundo(); sembrar(w, { boucher: true });
  const r = await revertir(w);
  assert.deepEqual({ ...r }, { ok: true, resultado: 'revertida', saldoId: 'S1', depositoId: 'D1', estadoDeposito: 'en_revision', movimientoId: 'conv_S1', eventoId: 'ev1' });
  const dep = w.get('ordenes_deposito/D1')!;
  assert.equal(dep.estado, 'en_revision');
  for (const k of ['saldoId', 'notaConversion', 'convertidoPorUid', 'convertidoAt']) assert.equal(k in dep, false, `${k} limpiado`);
  assert.deepEqual(dep.boucher, BOUCHER, 'el boucher no se toca');
  assert.equal(dep.ultimoEventoId, 'ev1');
  assert.deepEqual(dep.solicitudIds, ['o1', 'o2']);
  const saldo = w.get('saldos_cargo_motorizado/S1')!;
  assert.equal(saldo.estado, 'anulado');
  assert.equal(saldo.motivoAnulacion, 'conversion_revertida');
  assert.equal(saldo.revertidoPorUid, 'g1'); assert.equal(saldo.revertidoPorRol, 'gestor'); assert.equal(saldo.motivoReversion, 'Convertido por error');
  assert.ok(saldo.revertidoAt);
  for (const k of ['montoOriginal', 'depositoId', 'motorizadoId', 'abonos', 'saldoPendiente']) assert.ok(k in saldo, `${k} se conserva`);
  const mov = w.get('movimientos_financieros/conv_S1')!;
  assert.equal(mov.estado, 'anulado'); assert.equal(mov.anuladoPorUid, 'g1'); assert.equal(mov.anuladoPorRol, 'gestor');
  assert.equal(mov.tipo, 'deposito_convertido_en_deuda'); assert.equal(mov.monto, 90, 'la metadata original se conserva');
  for (const o of ['o1', 'o2']) {
    const d = (w.get(`solicitudes_envio/${o}`)!.registro as { deposito: Doc }).deposito;
    assert.equal(d.storkhubDepositoId, 'D1', 'el puntero se conserva (Rehacer)');
    assert.equal(d.confirmadoStorkhub, false); assert.equal(d.confirmadoStorkhubAt, null);
    assert.equal(d.comercioDepositoId, 'DC9', 'el destino comercio no se toca');
  }
  assert.equal(w.get('gastos_motorizado/g1')!.consumidoEnDepositoId, 'D1');
  const ev = w.eventosDe('D1'); assert.equal(ev.length, 1);
  assert.equal(ev[0].tipo, EVENTO_CONVERSION_REVERTIDA); assert.equal(ev[0].estadoDestino, 'en_revision'); assert.equal(ev[0].estadoAnterior, 'convertido_en_deuda');
  assert.equal(ev[0].saldoId, 'S1'); assert.equal(ev[0].porUid, 'g1'); assert.equal(ev[0].porRol, 'gestor'); assert.equal(ev[0].motivo, 'Convertido por error');
});

test('F4B-B2 · deuda virgen SIN boucher ⇒ pendiente_boucher (nunca anulado); las órdenes vuelven a como estaban antes de convertir', async () => {
  const w = mundo(); sembrar(w);
  const r = await revertir(w);
  assert.equal(r.estadoDeposito, 'pendiente_boucher');
  assert.equal(w.get('ordenes_deposito/D1')!.estado, 'pendiente_boucher');
  for (const o of ['o1', 'o2']) {
    const d = (w.get(`solicitudes_envio/${o}`)!.registro as { deposito: Doc }).deposito;
    for (const k of ['storkhubDepositoId', 'confirmadoStorkhub', 'confirmadoStorkhubAt']) assert.equal(k in d, false, `${k} eliminado`);
    assert.equal(d.comercioDepositoId, 'DC9', 'solo se quitan los campos de Storkhub');
  }
  assert.equal(w.get('gastos_motorizado/g1')!.consumidoEnDepositoId, 'D1', 'los gastos siguen reservados: el depósito sigue vivo');
  assert.equal(w.eventosDe('D1')[0].estadoDestino, 'pendiente_boucher');
});

// ── B3 · cualquier efecto económico bloquea ──────────────────────────────────
const abonoActivo: Doc = { tipo: 'abono_deuda_motorizado', monto: 40, estado: 'activo', motorizadoId: MOT, saldoId: 'S1', cuentaOrigen: `deuda_motorizado:${MOT}`, cuentaDestino: 'banco_storkhub' };
test('F4B-B3 · abono parcial (estado, abonos[] o movimiento) ⇒ deuda_con_abonos y 0 escrituras; el abono no se revierte', async () => {
  const casos: Array<[string, Opciones, Doc?]> = [
    ['abonado_parcial', { saldo: { estado: 'abonado_parcial', saldoPendiente: 50, abonos: [{ monto: 40, operacionId: 'x' }] } }, abonoActivo],
    ['abonos[] > 0 aunque el pendiente haya vuelto al original', { saldo: { abonos: [{ monto: 40 }] } }],
    ['saldoPendiente distinto del original, sin abonos', { saldo: { saldoPendiente: 50 } }],
    ['movimiento de abono activo con abonos[] vacío', {}, abonoActivo],
  ];
  for (const [nombre, opts, mov] of casos) {
    const w = mundo(); sembrar(w, { boucher: true, ...opts });
    if (mov) w.put('movimientos_financieros/abono_x', mov);
    await sinEfectos(w, revertir(w), codigo('failed-precondition', 'deuda_con_abonos'));
    assert.equal(w.get('ordenes_deposito/D1')!.estado, 'convertido_en_deuda', nombre);
  }
});

test('F4B-B4 · pagado ⇒ deuda_pagada y 0 escrituras', async () => {
  const w = mundo(); sembrar(w, { saldo: { estado: 'pagado', saldoPendiente: 0, abonos: [{ monto: 90 }] } });
  await sinEfectos(w, revertir(w), codigo('failed-precondition', 'deuda_pagada'));
});

test('F4B-B5 · condonado (estado o evidencia de condonación, o movimiento deuda_condonada activo) ⇒ deuda_condonada y 0 escrituras', async () => {
  const casos: Array<Opciones> = [
    { saldo: { estado: 'condonado', saldoPendiente: 0, montoCondonado: 90, movimientoCondonacionId: 'mc' } },
    { saldo: { condonadoAt: TS(9) } },
    { saldo: { montoCondonado: 90 } },
  ];
  for (const opts of casos) { const w = mundo(); sembrar(w, opts); await sinEfectos(w, revertir(w), codigo('failed-precondition', 'deuda_condonada')); }
  const w = mundo(); sembrar(w);
  w.put('movimientos_financieros/mc', { tipo: 'deuda_condonada', monto: 90, estado: 'activo', saldoId: 'S1', motorizadoId: MOT });
  await sinEfectos(w, revertir(w), codigo('failed-precondition', 'deuda_condonada'));
});

// ── B6 · saldo anulado ───────────────────────────────────────────────────────
test('F4B-B6 · saldo anulado CON la marca de FIN-4B ⇒ ya_revertida sin escribir; SIN marca (anularSaldoCargo) ⇒ conversion_inconsistente', async () => {
  const w = mundo(); sembrar(w, { boucher: true });
  await revertir(w);
  const e0 = w.escrituras;
  const r = await revertir(w);
  assert.equal(r.resultado, 'ya_revertida'); assert.equal(r.eventoId, null); assert.equal(r.estadoDeposito, 'en_revision');
  assert.equal(w.escrituras, e0);
  // anulado a mano: sin revertidoAt/revertidoPorUid/motivoReversion
  const x = mundo(); sembrar(x, { saldo: { estado: 'anulado', nota: '' } });
  await sinEfectos(x, revertir(x), codigo('failed-precondition', 'conversion_inconsistente'));
  // con marca pero el ciclo incoherente (el depósito sigue apuntando al saldo): no se asume nada
  const y = mundo(); sembrar(y, { saldo: { estado: 'anulado', revertidoAt: TS(1), revertidoPorUid: 'g1', motivoReversion: 'x' } });
  await sinEfectos(y, revertir(y), codigo('failed-precondition', 'conversion_inconsistente'));
});

// ── B7–B10 · integridad ──────────────────────────────────────────────────────
test('F4B-B7 · saldoId que no coincide con deposito.saldoId, saldo sin depósito, depósito no convertido o no Storkhub ⇒ conversion_inconsistente, 0 escrituras', async () => {
  const casos: Array<[Opciones, string]> = [
    [{ dep: { saldoId: 'OTRO' } }, 'saldoId_no_coincide'],
    [{ dep: { saldoId: undefined } }, 'saldoId_no_coincide'],
    [{ dep: { estado: 'en_revision' } }, 'deposito_no_convertido'],
    [{ dep: { tipo: 'recaudacion_motorizado_comercio' } }, 'deposito_no_storkhub'],
    [{ saldo: { depositoId: undefined } }, 'saldo_sin_depositoId'],
    [{ saldo: { depositoId: 'NOEXISTE' } }, 'deposito_inexistente'],
    [{ saldo: { origen: 'manual' } }, 'saldo_ajeno'],
    [{ saldo: { tipo: 'adelanto' } }, 'saldo_ajeno'],
  ];
  for (const [opts, detalle] of casos) {
    const w = mundo(); sembrar(w, opts);
    await sinEfectos(w, revertir(w), (e) => codigo('failed-precondition', 'conversion_inconsistente')(e) && (e as { details?: { detalle?: string } }).details?.detalle === detalle);
  }
  const w = mundo(); sembrar(w);
  await sinEfectos(w, revertir(w, 'g1', { saldoId: 'NOHAY', motivo: 'motivo valido' }), codigo('not-found'));
});

test('F4B-B8 · movimiento de conversión ausente (o ya anulado con el saldo vivo) ⇒ conversion_inconsistente, 0 escrituras', async () => {
  const a = mundo(); sembrar(a, { sinMovimiento: true });
  await sinEfectos(a, revertir(a), codigo('failed-precondition', 'conversion_inconsistente'));
  const b = mundo(); sembrar(b);
  b.put('movimientos_financieros/conv_S1', { ...b.get('movimientos_financieros/conv_S1')!, estado: 'anulado' });
  await sinEfectos(b, revertir(b), codigo('failed-precondition', 'conversion_inconsistente'));
});

test('F4B-B9 · dos movimientos de conversión activos ⇒ conversion_inconsistente, 0 escrituras', async () => {
  const w = mundo(); sembrar(w);
  w.put('movimientos_financieros/otra_conv', { ...w.get('movimientos_financieros/conv_S1')! });
  await sinEfectos(w, revertir(w), codigo('failed-precondition', 'conversion_inconsistente'));
});

test('F4B-B10 · monto incoherente entre saldo, movimiento y depósito, o cuentas/motorizado distintos ⇒ conversion_inconsistente, 0 escrituras', async () => {
  const casos: Array<[string, (w: Mundo) => void]> = [
    ['movimiento', (w) => w.put('movimientos_financieros/conv_S1', { ...w.get('movimientos_financieros/conv_S1')!, monto: 80 })],
    ['deposito.montoTotal', (w) => w.put('ordenes_deposito/D1', { ...w.get('ordenes_deposito/D1')!, montoTotal: 100 })],
    ['saldo.montoOriginal', (w) => w.put('saldos_cargo_motorizado/S1', { ...w.get('saldos_cargo_motorizado/S1')!, montoOriginal: 100, saldoPendiente: 100 })],
    ['cuentaDestino', (w) => w.put('movimientos_financieros/conv_S1', { ...w.get('movimientos_financieros/conv_S1')!, cuentaDestino: 'deuda_motorizado:otro' })],
    ['motorizado del movimiento', (w) => w.put('movimientos_financieros/conv_S1', { ...w.get('movimientos_financieros/conv_S1')!, motorizadoId: 'otro' })],
    ['depositoId del movimiento', (w) => w.put('movimientos_financieros/conv_S1', { ...w.get('movimientos_financieros/conv_S1')!, depositoId: 'D9' })],
  ];
  for (const [nombre, mut] of casos) {
    const w = mundo(); sembrar(w); mut(w);
    await sinEfectos(w, revertir(w), codigo('failed-precondition', 'conversion_inconsistente'));
    assert.ok(nombre);
  }
});

// ── B11 / B12 · órdenes y gastos ─────────────────────────────────────────────
test('F4B-B11 · solo se modifican las órdenes de ESTE depósito; una orden que ya no le apunta bloquea', async () => {
  const w = mundo(); sembrar(w, { boucher: true });
  const ajena = JSON.stringify(w.get('solicitudes_envio/ajena'));
  await revertir(w);
  assert.equal(JSON.stringify(w.get('solicitudes_envio/ajena')), ajena, 'la orden de otro depósito no se toca');
  for (const mut of [
    (x: Mundo) => x.put('solicitudes_envio/o1', ordenConvertida('D2')),
    (x: Mundo) => x.put('solicitudes_envio/o2', { ...ordenConvertida(), registro: { deposito: { storkhubDepositoId: 'D1', confirmadoStorkhub: false } } }),
    (x: Mundo) => x.put('solicitudes_envio/o1', { estado: 'entregado' }),
  ]) {
    const x = mundo(); sembrar(x, { boucher: true }); mut(x);
    await sinEfectos(x, revertir(x), codigo('failed-precondition', 'conversion_inconsistente'));
  }
  const y = mundo(); sembrar(y, { dep: { solicitudIds: ['noexiste'] } });
  await sinEfectos(y, revertir(y), codigo('failed-precondition', 'conversion_inconsistente'));
  const z = mundo(); sembrar(z, { dep: { solicitudIds: [] } });
  await sinEfectos(z, revertir(z), codigo('failed-precondition', 'conversion_inconsistente'));
});

test('F4B-B12 · los gastos FIN-2 siguen reservados por el depósito (con y sin boucher): FIN-4B no los libera', async () => {
  for (const boucher of [true, false]) {
    const w = mundo(); sembrar(w, { boucher });
    const antes = JSON.stringify(w.get('gastos_motorizado/g1'));
    await revertir(w);
    assert.equal(JSON.stringify(w.get('gastos_motorizado/g1')), antes);
    assert.equal(w.get('gastos_motorizado/g1')!.consumidoEnDepositoId, 'D1');
  }
});

// ── B13 / B24 · idempotencia y retry tardío ──────────────────────────────────
test('F4B-B13 · retry tras el éxito (mismo saldoId) ⇒ ya_revertida, 0 escrituras, mismo estado', async () => {
  const w = mundo(); sembrar(w);
  await revertir(w);
  const antes = w.snapshot(); const e0 = w.escrituras;
  for (let i = 0; i < 3; i++) assert.equal((await revertir(w, i % 2 ? 'a1' : 'g1')).resultado, 'ya_revertida');
  assert.equal(w.snapshot(), antes); assert.equal(w.escrituras, e0);
  assert.equal(w.eventosDe('D1').length, 1, 'un solo evento');
});

test('F4B-B24 · retry TARDÍO del ciclo viejo después de una conversión nueva ⇒ ya_revertida y el ciclo nuevo NO se toca', async () => {
  const w = mundo(); sembrar(w, { boucher: true });
  await revertir(w);
  // FIN-4A abre otro ciclo sobre el mismo depósito
  w.put('ordenes_deposito/D1', { ...w.get('ordenes_deposito/D1')!, estado: 'convertido_en_deuda', saldoId: 'S2', notaConversion: 'otra vez', convertidoPorUid: 'g1', convertidoAt: TS(30) });
  w.put('saldos_cargo_motorizado/S2', { motorizadoId: MOT, tipo: 'deposito_no_realizado', origen: 'deposito', depositoId: 'D1', montoOriginal: 90, saldoPendiente: 90, estado: 'pendiente', abonos: [] });
  w.put('movimientos_financieros/conv_S2', { tipo: 'deposito_convertido_en_deuda', monto: 90, estado: 'activo', motorizadoId: MOT, depositoId: 'D1', saldoId: 'S2', cuentaOrigen: `efectivo_en_poder:${MOT}`, cuentaDestino: `deuda_motorizado:${MOT}` });
  w.put('solicitudes_envio/o1', ordenConvertida()); w.put('solicitudes_envio/o2', ordenConvertida());
  const antes = w.snapshot(); const e0 = w.escrituras;
  assert.equal((await revertir(w, 'g1', P)).resultado, 'ya_revertida');
  assert.equal(w.snapshot(), antes, 'ni el depósito, ni el saldo S2, ni su movimiento, ni las órdenes cambiaron');
  assert.equal(w.escrituras, e0);
  // y el ciclo NUEVO sí se puede revertir, por su propio saldoId
  assert.equal((await revertir(w, 'g1', { saldoId: 'S2', motivo: 'otro error' })).resultado, 'revertida');
});

// ── B14 / B15 · concurrencia ─────────────────────────────────────────────────
test('F4B-B14 · revertir vs ABONAR: si el abono commitea mientras la reversión corre, la reversión reintenta, ve el abono y BLOQUEA (nunca depósito reactivado + abono activo)', async () => {
  const w = mundo(); sembrar(w, { boucher: true });
  w.hooks.antesDeCommit = () => {
    w.put('saldos_cargo_motorizado/S1', { ...w.get('saldos_cargo_motorizado/S1')!, saldoPendiente: 50, estado: 'abonado_parcial', abonos: [{ monto: 40, operacionId: 'op1', movimientoId: 'abono_op1' }] });
    w.put('movimientos_financieros/abono_op1', { ...abonoActivo, operacionId: 'op1' });
    w.bump();
  };
  await assert.rejects(revertir(w), codigo('failed-precondition', 'deuda_con_abonos'));
  assert.equal(w.get('ordenes_deposito/D1')!.estado, 'convertido_en_deuda');
  assert.equal(w.get('movimientos_financieros/conv_S1')!.estado, 'activo');
  assert.equal(w.eventosDe('D1').length, 0);
  // y al revés: con la reversión aplicada el saldo anulado ya no admite abonos
  const x = mundo(); sembrar(x); await revertir(x);
  assert.equal(ESTADOS_ABONABLES.includes(String(x.get('saldos_cargo_motorizado/S1')!.estado)), false);
});

test('F4B-B15 · revertir vs CONDONAR (y vs anular el saldo a mano): el perdedor ve el estado nuevo y no escribe', async () => {
  const w = mundo(); sembrar(w, { boucher: true });
  w.hooks.antesDeCommit = () => {
    w.put('saldos_cargo_motorizado/S1', { ...w.get('saldos_cargo_motorizado/S1')!, estado: 'condonado', saldoPendiente: 0, montoCondonado: 90, movimientoCondonacionId: 'mc' });
    w.put('movimientos_financieros/mc', { tipo: 'deuda_condonada', monto: 90, estado: 'activo', saldoId: 'S1', motorizadoId: MOT });
    w.bump();
  };
  await assert.rejects(revertir(w), codigo('failed-precondition', 'deuda_condonada'));
  assert.equal(w.get('ordenes_deposito/D1')!.estado, 'convertido_en_deuda');
  const x = mundo(); sembrar(x, { boucher: true });
  x.hooks.antesDeCommit = () => { x.put('saldos_cargo_motorizado/S1', { ...x.get('saldos_cargo_motorizado/S1')!, estado: 'anulado' }); x.bump(); };
  await assert.rejects(revertir(x), codigo('failed-precondition', 'conversion_inconsistente'));
  assert.equal(x.get('ordenes_deposito/D1')!.estado, 'convertido_en_deuda');
});

// ── B16 · reconversión ───────────────────────────────────────────────────────
test('F4B-B16 · tras revertir, el depósito cumple las precondiciones de FIN-4A para abrir un ciclo NUEVO (estado convertible, sin saldoId, sin movimientos ni saldos vivos)', async () => {
  for (const boucher of [true, false]) {
    const w = mundo(); sembrar(w, { boucher });
    await revertir(w);
    const dep = w.get('ordenes_deposito/D1')!;
    assert.ok(ESTADOS_CONVERTIBLES.includes(String(dep.estado)));
    assert.equal(dep.saldoId, undefined);
    assert.equal(w.movimientos().filter((m) => m.depositoId === 'D1' && m.estado !== 'anulado').length, 0);
    assert.equal(w.get('saldos_cargo_motorizado/S1')!.estado, 'anulado');
  }
});

// ── B17 / B18 · auth, actor, payload ─────────────────────────────────────────
test('F4B-B17 · sin sesión ⇒ unauthenticated; digitador, motorizado, comercio, cuenta inactiva o inexistente ⇒ permission-denied; gestor y admin pasan con SU rol', async () => {
  const w = mundo(); sembrar(w);
  await sinEfectos(w, revertirConversionEnDeudaCore(w.deps, undefined, P), codigo('unauthenticated'));
  for (const uid of ['dig', 'mot', 'com', 'baja', 'fantasma']) await sinEfectos(w, revertir(w, uid), codigo('permission-denied'));
  const a = mundo(); sembrar(a); await revertir(a, 'a1');
  assert.equal(a.get('saldos_cargo_motorizado/S1')!.revertidoPorRol, 'admin');
  assert.equal(a.get('movimientos_financieros/conv_S1')!.anuladoPorRol, 'admin');
  assert.equal(a.eventosDe('D1')[0].porRol, 'admin'); assert.equal(a.eventosDe('D1')[0].porUid, 'a1');
});

test('F4B-B18 · payload estricto: solo saldoId y motivo; cualquier otro campo, tipo o motivo inválido ⇒ invalid-argument y 0 escrituras', async () => {
  const w = mundo(); sembrar(w);
  const malos: unknown[] = [
    null, [], 'S1', {}, { saldoId: 'S1' }, { motivo: 'motivo valido' },
    { ...P, depositoId: 'D1' }, { ...P, estado: 'x' }, { ...P, monto: 90 }, { ...P, motorizadoId: 'm' }, { ...P, actorUid: 'a1' }, { ...P, rol: 'admin' },
    { ...P, saldoPendiente: 90 }, { ...P, boucher: {} }, { ...P, ordenes: [] }, { ...P, gastos: [] }, { ...P, extra: null },
    { saldoId: '', motivo: 'motivo valido' }, { saldoId: 5, motivo: 'motivo valido' }, { saldoId: 'x'.repeat(201), motivo: 'motivo valido' },
    { saldoId: 'S1', motivo: '' }, { saldoId: 'S1', motivo: '   ' }, { saldoId: 'S1', motivo: 'ab' }, { saldoId: 'S1', motivo: 5 }, { saldoId: 'S1', motivo: 'x'.repeat(301) }, { saldoId: 'S1', motivo: null },
  ];
  for (const m of malos) await sinEfectos(w, revertir(w, 'g1', m), codigo('invalid-argument'));
  assert.deepEqual(validarPeticionReversion({ saldoId: ' S1 ', motivo: '  por error  ' }), { saldoId: 'S1', motivo: 'por error' });
});

// ── B19–B23 · defensas extra y evidencia ─────────────────────────────────────
test('F4B-B19 · cualquier OTRO movimiento activo del saldo bloquea, aunque abonos[] esté vacío', async () => {
  const w = mundo(); sembrar(w);
  w.put('movimientos_financieros/raro', { tipo: 'ajuste_manual_x', monto: 5, estado: 'activo', saldoId: 'S1', motorizadoId: MOT });
  await sinEfectos(w, revertir(w), codigo('failed-precondition', 'movimientos_activos'));
  // un movimiento ANULADO del mismo saldo no estorba
  const x = mundo(); sembrar(x);
  x.put('movimientos_financieros/viejo', { tipo: 'abono_deuda_motorizado', monto: 5, estado: 'anulado', saldoId: 'S1', motorizadoId: MOT });
  assert.equal((await revertir(x)).resultado, 'revertida');
});

test('F4B-B20 / B21 · un movimiento LEGACY con id aleatorio pero coherente se revierte igual que un conv_<saldoId> moderno', async () => {
  const l = mundo(); sembrar(l, { legacy: true, dep: { convertidoPorUid: undefined, convertidoAt: undefined } });
  const r = await revertir(l);
  assert.equal(r.resultado, 'revertida'); assert.equal(r.movimientoId, 'XyZ9legacy');
  assert.equal(l.get('movimientos_financieros/XyZ9legacy')!.estado, 'anulado');
  assert.deepEqual(Object.keys(l.eventosDe('D1')[0].conversionPrevia as object), ['notaConversion'], 'un ciclo legacy no tenía convertidoPorUid/At: no se inventan');
  const m = mundo(); sembrar(m);
  assert.equal((await revertir(m)).movimientoId, 'conv_S1');
});

test('F4B-B22 / B23 · convertidoPorUid, convertidoAt y notaConversion se PRESERVAN en el evento y se LIMPIAN del depósito', async () => {
  const w = mundo(); sembrar(w, { boucher: true });
  await revertir(w);
  const previa = w.eventosDe('D1')[0].conversionPrevia as Doc;
  assert.equal(previa.convertidoPorUid, 'g1'); assert.deepEqual(previa.convertidoAt, TS(7)); assert.equal(previa.notaConversion, 'No depositó');
  const dep = w.get('ordenes_deposito/D1')!;
  for (const k of ['convertidoPorUid', 'convertidoAt', 'notaConversion', 'saldoId']) assert.equal(k in dep, false);
});

// ── Atomicidad ───────────────────────────────────────────────────────────────
test('F4B-AT1 · si CUALQUIERA de las escrituras falla (saldo, movimiento, depósito, orden, evento) no queda NADA aplicado; el reintento deja un solo efecto', async () => {
  for (const ruta of ['saldos_cargo_motorizado/S1', 'movimientos_financieros/conv_S1', 'ordenes_deposito/D1', 'solicitudes_envio/o2', 'ordenes_deposito/D1/eventos/ev1']) {
    const w = mundo(); sembrar(w, { boucher: true });
    const antes = w.snapshot();
    w.hooks.fallarSi = (_op, r) => r === ruta;
    await assert.rejects(revertir(w), /fallo simulado/);
    assert.equal(w.snapshot(), antes, `rollback total (falló ${ruta})`);
    assert.equal(w.escrituras, 0);
    w.hooks.fallarSi = undefined;
    assert.equal((await revertir(w)).resultado, 'revertida');
    assert.equal(w.eventosDe('D1').length, 1);
  }
});

// ── Contratos del adaptador real, la fuente y los lectores ───────────────────
test('F4B-AT2 · el adaptador real escribe SOLO con tx.* dentro de una runTransaction; el evento con create(); nada fuera de la transacción', () => {
  const norm = (p: string[]) => readFileSync(join(__dirname, ...p), 'utf8').replace(/\r\n/g, '\n');
  const callable = norm(['..', '..', 'src', 'reversion-conversion-callable.ts']).replace(/\/\/.*$/gm, '');
  const nucleo = norm(['..', '..', 'src', 'reversion-conversion.ts']).replace(/\/\/.*$/gm, '');
  assert.equal((callable.match(/db\.runTransaction\(/g) ?? []).length, 1, 'una sola transacción');
  assert.match(callable, /crearEvento: \(depositoId, eventoId, campos\) => \{ tx\.create\(/);
  // FieldValue.delete() es un valor centinela de campo (lo recibe un update), no un borrado de documento.
  const sinTx = callable.replace(/tx\.(create|update)\(/g, 'TX_$1(').replace(/FieldValue\.delete\(\)/g, 'CENTINELA');
  for (const w of ['.add(', '.set(', '.create(', '.update(', '.batch(', 'bulkWriter', '.delete(']) assert.ok(!sinTx.includes(w), `sin ${w} fuera de la transacción`);
  assert.equal((nucleo.match(/deps\.transaction[<(]/g) ?? []).length, 1, 'el núcleo hace una sola transacción');
  assert.ok(!nucleo.includes('gastos_motorizado') && !nucleo.includes('consumidoEnDepositoId'), 'FIN-4B no toca los gastos');
  const escrituraSaldo = nucleo.slice(nucleo.indexOf('tx.updateSaldo('), nucleo.indexOf('tx.updateMovimiento('));
  assert.ok(escrituraSaldo.length > 20 && !escrituraSaldo.includes('abonos') && !escrituraSaldo.includes('saldoPendiente') && !escrituraSaldo.includes('montoOriginal'), 'FIN-4B no toca abonos[] ni los montos del saldo');
  const idx = norm(['..', '..', 'src', 'index.ts']);
  assert.match(idx, /export \{ revertirConversionEnDeuda \} from '\.\/reversion-conversion-callable'/);
});

test('F4B-AT3 · el tipo de evento del servidor es el mismo que registra el cliente (lib/deposito-eventos.ts) y las Rules NO lo dejan crear al cliente', () => {
  const lib = readFileSync(join(__dirname, '..', '..', '..', 'lib', 'deposito-eventos.ts'), 'utf8');
  assert.match(lib, new RegExp(`EVENTO_DEPOSITO_CONVERSION_REVERTIDA = '${EVENTO_CONVERSION_REVERTIDA}'`));
  const rules = readFileSync(join(__dirname, '..', '..', '..', 'firestore.rules'), 'utf8');
  assert.ok(!rules.includes(EVENTO_CONVERSION_REVERTIDA), 'solo la callable (Admin SDK) escribe este evento');
});
