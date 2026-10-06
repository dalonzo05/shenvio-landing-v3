// FIN-4C — registrarAbonoDirectoCore: abono directo autoritativo e idempotente.
//
// El "mundo" simula lo que importa de Firestore para estas garantías (el mismo criterio
// que confirmacion-deposito.test.ts y conversion-deposito-deuda.test.ts):
//   - una transacción relee sus lecturas: si OTRA escribió entre su inicio y su commit se
//     invalida y se REINTENTA (optimismo de Firestore);
//   - sus escrituras se aplican TODAS o ninguna;
//   - create() falla si el documento ya existe, update() si no existe.
// Nada de esto reemplaza al emulador real (sonda de runtime): acota la lógica del núcleo.
import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { DocumentData } from 'firebase-admin/firestore';
import {
  registrarAbonoDirectoCore, validarPeticionAbono, ESTADOS_ABONABLES,
  type DepsAbono, type TxAbono,
} from '../src/abono-directo';

type Doc = Record<string, unknown>;
const TS = (n: number) => ({ __ts: n });
const codigo = (code: string, motivo?: string) => (e: unknown) => {
  const err = e as { code?: string; details?: { motivo?: string } };
  return err.code === code && (motivo === undefined || err.details?.motivo === motivo);
};

function mundo() {
  let store = new Map<string, Doc>();
  let revision = 0;
  let relojes = 0;
  let escrituras = 0;
  const hooks: { fallarSi?: (op: string, ruta: string) => boolean } = {};
  const clonar = (m: Map<string, Doc>) => new Map([...m].map(([k, v]) => [k, structuredClone(v)]));
  const put = (ruta: string, d: Doc) => { store.set(ruta, d); };
  const get = (ruta: string) => { const d = store.get(ruta); return d ? (structuredClone(d) as DocumentData) : null; };

  const deps: DepsAbono = {
    serverTimestamp: () => TS(++relojes),
    ahora: () => TS(1000 + relojes),
    async transaction(fn) {
      for (;;) {
        const inicio = revision;
        const cola: Array<{ op: string; ruta: string; datos: Doc }> = [];
        const tx: TxAbono = {
          async getUsuario(uid) { return get(`usuarios/${uid}`); },
          async getSaldo(id) { return get(`saldos_cargo_motorizado/${id}`); },
          async getMovimiento(id) { return get(`movimientos_financieros/${id}`); },
          async getIntencion(id) { return get(`intenciones_abono_directo/${id}`); },
          updateIntencion(id, campos) { cola.push({ op: 'update', ruta: `intenciones_abono_directo/${id}`, datos: campos }); },
          updateSaldo(id, campos) { cola.push({ op: 'update', ruta: `saldos_cargo_motorizado/${id}`, datos: campos }); },
          crearMovimiento(id, campos) { cola.push({ op: 'create', ruta: `movimientos_financieros/${id}`, datos: campos }); },
        };
        const resultado = await fn(tx);
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
            copia.set(w.ruta, { ...actual, ...structuredClone(w.datos) });
          }
        }
        store = copia; // commit atómico
        if (cola.length) { revision++; escrituras += cola.length; }
        return resultado;
      }
    },
  };

  return {
    deps, hooks, put, get,
    get escrituras() { return escrituras; },
    // El estado FINANCIERO (saldos, ledger, usuarios): las intenciones se auditan aparte, con intencion().
    snapshot: () => JSON.stringify([...store].filter(([r]) => !r.startsWith('intenciones_abono_directo/')).sort(([a], [b]) => a.localeCompare(b))),
    intencion: (op: string) => get(`intenciones_abono_directo/${op}`),
    movimientos: () => [...store].filter(([r]) => r.startsWith('movimientos_financieros/')).map(([r, d]) => ({ id: r.split('/')[1], ...d } as Doc & { id: string })),
    saldo: (id = 's1') => get(`saldos_cargo_motorizado/${id}`)!,
  };
}
type Mundo = ReturnType<typeof mundo>;

const OP = (n: number | string) => `op_${String(n).padStart(16, '0')}`;

function sembrar(w: Mundo, opts: { saldo?: Doc; id?: string } = {}) {
  w.put('usuarios/g1', { activo: true, rol: 'gestor' });
  w.put('usuarios/a1', { activo: true, rol: 'admin' });
  w.put('usuarios/g2', { activo: true, rol: 'gestor' });
  w.put('usuarios/dig', { activo: true, rol: 'digitador' });
  w.put('usuarios/mot', { activo: true, rol: 'motorizado' });
  w.put('usuarios/com', { activo: true, rol: 'Comercio' });
  w.put('usuarios/baja', { activo: false, rol: 'gestor' });
  w.put(`saldos_cargo_motorizado/${opts.id ?? 's1'}`, {
    motorizadoId: 'motA', motorizadoUid: 'authA', motorizadoNombre: 'Dickson', tipo: 'deposito_no_realizado',
    montoOriginal: 100, saldoPendiente: 100, estado: 'pendiente', origen: 'deposito', depositoId: 'D1',
    nota: '', creadoPorUid: 'g1', abonos: [], ...opts.saldo,
  });
}

// registrarAbonoDirecto exige una INTENCIÓN preparada (la crea prepararAbonoDirecto): este helper la
// siembra, a nombre de quien llama primero, igual que lo haría la preparación. Con `sinIntencion` no se siembra.
const abonar = (w: Mundo, uid: string | null = 'g1', data: Record<string, unknown> | unknown = {}, sinIntencion = false) => {
  const d = typeof data === 'object' && data !== null && !Array.isArray(data)
    ? { saldoId: 's1', monto: 40, operacionId: OP(1), metodoAbono: 'ajuste_manual', ...(data as Record<string, unknown>) }
    : data;
  const x = d as Record<string, unknown>;
  if (!sinIntencion && uid && typeof d === 'object' && d !== null && typeof x.operacionId === 'string' && typeof x.saldoId === 'string'
    && typeof x.monto === 'number' && typeof x.metodoAbono === 'string' && !w.intencion(x.operacionId)) {
    w.put(`intenciones_abono_directo/${x.operacionId}`, { saldoId: x.saldoId, monto: x.monto, metodoAbono: x.metodoAbono, actorUid: uid, actorRol: 'gestor', estado: 'preparada' });
  }
  return registrarAbonoDirectoCore(w.deps, uid ?? undefined, d);
};

// ── F4C-FC1/2/28 · autenticación y roles ──────────────────────────────────────
test('F4C-FC1 · sin sesión ⇒ unauthenticated, y no se escribe nada', async () => {
  const w = mundo(); sembrar(w);
  const antes = w.snapshot();
  await assert.rejects(abonar(w, null), codigo('unauthenticated'));
  assert.equal(w.snapshot(), antes);
});

test('F4C-FC2 · digitador, motorizado y comercio no abonan (el digitador PROPONE) ⇒ permission-denied', async () => {
  for (const uid of ['dig', 'mot', 'com', 'noexiste']) {
    const w = mundo(); sembrar(w);
    const antes = w.snapshot();
    await assert.rejects(abonar(w, uid), codigo('permission-denied'), uid);
    assert.equal(w.snapshot(), antes, uid + ': sin efectos');
  }
  for (const uid of ['g1', 'a1']) {
    const w = mundo(); sembrar(w);
    assert.equal((await abonar(w, uid)).resultado, 'aplicado', uid);
  }
});

test('F4C-FC28 · usuario inactivo ⇒ permission-denied', async () => {
  const w = mundo(); sembrar(w);
  await assert.rejects(abonar(w, 'baja'), codigo('permission-denied'));
  assert.equal(w.escrituras, 0);
});

// ── F4C-FC3 · saldo inexistente ───────────────────────────────────────────────
test('F4C-FC3 · saldo inexistente ⇒ not-found', async () => {
  const w = mundo(); sembrar(w);
  await assert.rejects(abonar(w, 'g1', { saldoId: 'nada' }), codigo('not-found'));
  assert.equal(w.escrituras, 0);
});

// ── F4C-FC4/5/6 · monto ───────────────────────────────────────────────────────
test('F4C-FC4 · monto 0 ⇒ invalid-argument', async () => {
  const w = mundo(); sembrar(w);
  await assert.rejects(abonar(w, 'g1', { monto: 0 }), codigo('invalid-argument'));
  assert.equal(w.escrituras, 0);
});

test('F4C-FC5 · monto negativo ⇒ invalid-argument', async () => {
  const w = mundo(); sembrar(w);
  for (const m of [-1, -0.01, -1000]) await assert.rejects(abonar(w, 'g1', { monto: m }), codigo('invalid-argument'), String(m));
  assert.equal(w.escrituras, 0);
});

test('F4C-FC6 · monto no finito, no numérico o con más de 2 decimales ⇒ invalid-argument', async () => {
  const w = mundo(); sembrar(w);
  for (const m of [NaN, Infinity, -Infinity, '40', null, undefined, {}, [], 10.123, 1e12]) {
    await assert.rejects(abonar(w, 'g1', { monto: m }), codigo('invalid-argument'), String(m));
  }
  assert.equal(w.escrituras, 0);
  assert.equal((await abonar(w, 'g1', { monto: 10.25, operacionId: OP(2) })).resultado, 'aplicado', 'dos decimales sí');
});

// ── F4C-FC7/8/9 · abonos válidos ──────────────────────────────────────────────
test('F4C-FC7 · saldo pendiente: abono parcial válido ⇒ abonado_parcial y pendiente reducido', async () => {
  const w = mundo(); sembrar(w);
  const r = await abonar(w, 'g1', { monto: 40 });
  assert.deepEqual({ ...r }, {
    ok: true, resultado: 'aplicado', saldoId: 's1', operacionId: OP(1), movimientoId: 'abono_' + OP(1), monto: 40,
    estadoAnterior: 'pendiente', estadoNuevo: 'abonado_parcial', saldoPendienteAnterior: 100, saldoPendiente: 60,
  });
  const s = w.saldo();
  assert.equal(s.saldoPendiente, 60);
  assert.equal(s.estado, 'abonado_parcial');
  assert.equal(s.montoOriginal, 100, 'el original no se toca');
});

test('F4C-FC8 · saldo abonado_parcial: un nuevo abono es válido', async () => {
  const w = mundo(); sembrar(w, { saldo: { estado: 'abonado_parcial', saldoPendiente: 60 } });
  const r = await abonar(w, 'g1', { monto: 25, operacionId: OP(2) });
  assert.equal(r.estadoNuevo, 'abonado_parcial');
  assert.equal(w.saldo().saldoPendiente, 35);
});

test('F4C-FC9 · abono exacto ⇒ pagado, pendiente 0', async () => {
  const w = mundo(); sembrar(w);
  const r = await abonar(w, 'g1', { monto: 100 });
  assert.equal(r.estadoNuevo, 'pagado');
  assert.equal(w.saldo().saldoPendiente, 0);
  assert.equal(w.saldo().estado, 'pagado');
});

// ── F4C-FC10 · sobre-abono ────────────────────────────────────────────────────
test('F4C-FC10 · sobre-abono: C$500 sobre un saldo de C$100 ⇒ monto_excede_saldo, 0 efectos (no se esconde con Math.max)', async () => {
  const w = mundo(); sembrar(w);
  const antes = w.snapshot();
  await assert.rejects(abonar(w, 'g1', { monto: 500 }), codigo('failed-precondition', 'monto_excede_saldo'));
  // cada intento es una intención distinta: el rechazo definitivo CIERRA la anterior
  await assert.rejects(abonar(w, 'g1', { monto: 100.01, operacionId: OP(2) }), codigo('failed-precondition', 'monto_excede_saldo'));
  assert.equal(w.intencion(OP(1))!.estado, 'rechazada', 'el rechazo definitivo cierra la intención');
  assert.equal(w.intencion(OP(1))!.motivoRechazo, 'monto_excede_saldo');
  assert.equal(w.snapshot(), antes);
  assert.equal(w.movimientos().length, 0);
});

// ── F4C-FC11/12/13 · estados ──────────────────────────────────────────────────
test('F4C-FC11/12/13 · saldo pagado, anulado o condonado (o de estado desconocido) no se abona ⇒ saldo_no_abonable, 0 efectos', async () => {
  assert.deepEqual([...ESTADOS_ABONABLES].sort(), ['abonado_parcial', 'pendiente']);
  for (const estado of ['pagado', 'anulado', 'condonado', 'otro', '']) {
    const w = mundo(); sembrar(w, { saldo: { estado } });
    const antes = w.snapshot();
    await assert.rejects(abonar(w), codigo('failed-precondition', 'saldo_no_abonable'), estado);
    assert.equal(w.snapshot(), antes, estado);
    assert.equal(w.saldo().estado, estado, 'un saldo cerrado no se resucita: ' + estado);
  }
});

test('F4C-FC11b · un saldo "pendiente" sin monto pendiente no se abona', async () => {
  const w = mundo(); sembrar(w, { saldo: { saldoPendiente: 0 } });
  await assert.rejects(abonar(w), codigo('failed-precondition', 'saldo_no_abonable'));
});

// ── F4C-FC14 · jamás negativo ─────────────────────────────────────────────────
test('F4C-FC14 · el saldo nunca queda negativo, ni con pendiente con decimales', async () => {
  const w = mundo(); sembrar(w, { saldo: { saldoPendiente: 0.3, montoOriginal: 0.3 } });
  await assert.rejects(abonar(w, 'g1', { monto: 0.31 }), codigo('failed-precondition', 'monto_excede_saldo'));
  const r = await abonar(w, 'g1', { monto: 0.3, operacionId: OP(3) });
  assert.equal(r.saldoPendiente, 0);
  assert.ok(w.saldo().saldoPendiente >= 0);
  // aritmética de centavos: 0.1 + 0.2 no deja residuos de coma flotante
  const x = mundo(); sembrar(x, { saldo: { saldoPendiente: 0.3, montoOriginal: 0.3 } });
  await abonar(x, 'g1', { monto: 0.1, operacionId: OP(1) });
  const r2 = await abonar(x, 'g1', { monto: 0.2, operacionId: OP(2) });
  assert.equal(r2.estadoNuevo, 'pagado');
  assert.equal(x.saldo().saldoPendiente, 0);
});

// ── F4C-FC15/16 · actor y cuenta ──────────────────────────────────────────────
test('F4C-FC15 · el actor y el rol REALES salen del servidor: un admin queda como admin, no como "gestor"', async () => {
  for (const [uid, rol] of [['g1', 'gestor'], ['a1', 'admin']] as const) {
    const w = mundo(); sembrar(w);
    await abonar(w, uid);
    const m = w.movimientos()[0];
    assert.equal(m.creadoPorUid, uid);
    assert.equal(m.creadoPorRol, rol);
    const a = (w.saldo().abonos as Doc[])[0];
    assert.equal(a.creadoPorUid, uid);
    assert.equal(a.creadoPorRol, rol);
    assert.deepEqual(a.fecha, TS(1001), 'la hora de la entrada la pone el servidor');
    assert.deepEqual(m.at, TS(1), 'la hora del movimiento la pone el servidor');
  }
});

test('F4C-FC16 · el motorizado y la cuenta salen del SALDO; ningún campo del cliente los redirige', async () => {
  const w = mundo(); sembrar(w);
  for (const extra of [{ motorizadoId: 'otro' }, { cuentaOrigen: 'x' }, { depositoId: 'D9' }, { uid: 'a1' }, { creadoPorRol: 'admin' }, { estado: 'pagado' }, { saldoPendiente: 1 }]) {
    await assert.rejects(abonar(w, 'g1', extra), codigo('invalid-argument'), JSON.stringify(extra));
  }
  assert.equal(w.escrituras, 0);
  await abonar(w, 'g1', { operacionId: OP(2), metodoAbono: 'transferencia', comprobanteUrl: 'https://ex.test/c.jpg', comprobantePath: 'saldos/s1/abono_0.jpg' });
  const m = w.movimientos()[0];
  assert.equal(m.motorizadoId, 'motA');
  assert.equal(m.cuentaOrigen, 'deuda_motorizado:motA');
  assert.equal(m.cuentaDestino, 'banco_storkhub');
  assert.equal(m.depositoId, undefined, 'no se enlaza al depósito: Rehacer/Anular de un depósito anulan sus movimientos por depositoId');
  const x = mundo(); sembrar(x);
  await abonar(x, 'g1', { metodoAbono: 'ajuste_manual' });
  assert.equal(x.movimientos()[0].cuentaDestino, 'recuperacion_deuda_liquidacion');
});

test('F4C-FC16b · un saldo sin identidad de motorizado no se abona: no se inventa la cuenta ⇒ abono_inconsistente', async () => {
  const w = mundo(); sembrar(w, { saldo: { motorizadoId: undefined } });
  const antes = w.snapshot();
  await assert.rejects(abonar(w), codigo('failed-precondition', 'abono_inconsistente'));
  assert.equal(w.snapshot(), antes);
});

// ── F4C-FC17 · atomicidad ─────────────────────────────────────────────────────
test('F4C-FC17 · si una escritura falla dentro de la transacción, NADA queda aplicado; el reintento deja UN solo efecto', async () => {
  for (const fallo of ['saldos_cargo_motorizado/s1', 'movimientos_financieros/abono_' + OP(1)]) {
    const w = mundo(); sembrar(w);
    const antes = w.snapshot();
    w.hooks.fallarSi = (_op, ruta) => ruta === fallo;
    await assert.rejects(abonar(w), /fallo simulado/, fallo);
    assert.equal(w.snapshot(), antes, 'sin efectos parciales cuando falla ' + fallo);
    w.hooks.fallarSi = undefined;
    assert.equal((await abonar(w)).resultado, 'aplicado');
    assert.equal(w.movimientos().length, 1);
    assert.equal((w.saldo().abonos as Doc[]).length, 1);
  }
});

test('F4C-FC17b · abono ↔ movimiento 1:1: la entrada de abonos[] apunta a su movimiento y el movimiento a su operación', async () => {
  const w = mundo(); sembrar(w);
  await abonar(w, 'g1', { nota: '  recibido en oficina  ', comprobanteUrl: 'https://ex.test/c.jpg', comprobantePath: 'saldos/s1/abono_0.jpg' });
  const a = (w.saldo().abonos as Doc[])[0];
  const m = w.movimientos()[0];
  assert.equal(a.movimientoId, m.id);
  assert.equal(a.operacionId, m.operacionId);
  assert.equal(a.monto, m.monto);
  assert.equal(a.nota, 'recibido en oficina');
  assert.equal(a.comprobanteUrl, 'https://ex.test/c.jpg');
  assert.equal(a.comprobantePath, 'saldos/s1/abono_0.jpg');
});

// ── F4C-FC18/19/20 · idempotencia ─────────────────────────────────────────────
test('F4C-FC18 · retry del MISMO operacionId ⇒ ya_aplicado, mismo movimiento y CERO escrituras', async () => {
  const w = mundo(); sembrar(w);
  const primera = await abonar(w, 'g1', { monto: 40 });
  const escrituras = w.escrituras;
  const antes = w.snapshot();
  const segunda = await abonar(w, 'g1', { monto: 40 }); // el reintento es del MISMO usuario (otra pestaña, otro dispositivo)
  assert.equal(segunda.resultado, 'ya_aplicado');
  assert.equal(segunda.movimientoId, primera.movimientoId);
  assert.equal(segunda.monto, 40);
  assert.equal(w.escrituras, escrituras);
  assert.equal(w.snapshot(), antes);
  assert.equal(w.movimientos().length, 1);
});

test('F4C-FC18b · el retry del abono que dejó el saldo PAGADO sigue siendo ya_aplicado (no "saldo no abonable")', async () => {
  const w = mundo(); sembrar(w);
  await abonar(w, 'g1', { monto: 100 });
  assert.equal(w.saldo().estado, 'pagado');
  const r = await abonar(w, 'g1', { monto: 100 });
  assert.equal(r.resultado, 'ya_aplicado');
  assert.equal(w.movimientos().length, 1);
  assert.equal(w.saldo().saldoPendiente, 0);
});

test('F4C-FC19 · mismo operacionId con OTRO monto o método ⇒ conflicto_idempotencia, 0 escrituras', async () => {
  const w = mundo(); sembrar(w);
  await abonar(w, 'g1', { monto: 50 });
  const antes = w.snapshot();
  await assert.rejects(abonar(w, 'g1', { monto: 70 }), codigo('failed-precondition', 'conflicto_idempotencia'));
  await assert.rejects(abonar(w, 'g1', { monto: 50, metodoAbono: 'descuento_liquidacion' }), codigo('failed-precondition', 'conflicto_idempotencia'));
  assert.equal(w.snapshot(), antes);
});

test('F4C-FC20 · mismo operacionId con OTRO saldo ⇒ conflicto_idempotencia, 0 escrituras en ninguno', async () => {
  const w = mundo(); sembrar(w); sembrar(w, { id: 's2' });
  await abonar(w, 'g1', { saldoId: 's1', monto: 50 });
  const antes = w.snapshot();
  await assert.rejects(abonar(w, 'g1', { saldoId: 's2', monto: 50 }), codigo('failed-precondition', 'conflicto_idempotencia'));
  assert.equal(w.snapshot(), antes);
  assert.equal(w.saldo('s2').saldoPendiente, 100);
});

// ── F4C-FC21 · concurrencia misma operación ───────────────────────────────────
test('F4C-FC21 · dos y cinco llamadas simultáneas con el MISMO operacionId ⇒ un solo efecto', async () => {
  const w = mundo(); sembrar(w);
  const [a, b] = await Promise.all([abonar(w, 'g1'), abonar(w, 'g1')]);
  assert.deepEqual([a.resultado, b.resultado].sort(), ['aplicado', 'ya_aplicado']);
  assert.equal(w.movimientos().length, 1);
  assert.equal(w.saldo().saldoPendiente, 60);
  const x = mundo(); sembrar(x);
  const rs = await Promise.all(['g1', 'g1', 'g1', 'g1', 'g1'].map((u) => abonar(x, u)));
  assert.equal(rs.filter((r) => r.resultado === 'aplicado').length, 1);
  assert.equal(rs.filter((r) => r.resultado === 'ya_aplicado').length, 4);
  assert.equal(x.movimientos().length, 1);
  assert.equal((x.saldo().abonos as Doc[]).length, 1);
  assert.equal(x.saldo().saldoPendiente, 60);
});

// ── F4C-FC22/23/24 · concurrencia de operaciones distintas ────────────────────
test('F4C-FC22 · dos operaciones DISTINTAS, 40 + 60 sobre 100 ⇒ ambas válidas, saldo 0, pagado, 2 movimientos', async () => {
  const w = mundo(); sembrar(w);
  const [a, b] = await Promise.all([
    abonar(w, 'g1', { monto: 40, operacionId: OP('A') }),
    abonar(w, 'g2', { monto: 60, operacionId: OP('B') }),
  ]);
  assert.equal(a.resultado, 'aplicado');
  assert.equal(b.resultado, 'aplicado');
  assert.equal(w.saldo().saldoPendiente, 0);
  assert.equal(w.saldo().estado, 'pagado');
  assert.equal(w.movimientos().length, 2);
  assert.equal((w.saldo().abonos as Doc[]).length, 2);
});

test('F4C-FC23 · 70 + 40 sobre 100 ⇒ uno aplica y el otro, al releer, recibe monto_excede_saldo; nunca negativo', async () => {
  const w = mundo(); sembrar(w);
  const rs = await Promise.allSettled([
    abonar(w, 'g1', { monto: 70, operacionId: OP('A') }),
    abonar(w, 'g2', { monto: 40, operacionId: OP('B') }),
  ]);
  assert.equal(rs.filter((r) => r.status === 'fulfilled').length, 1);
  const rechazado = rs.find((r) => r.status === 'rejected') as PromiseRejectedResult;
  assert.ok(codigo('failed-precondition', 'monto_excede_saldo')(rechazado.reason));
  assert.ok((w.saldo().saldoPendiente as number) >= 0);
  assert.equal(w.movimientos().length, 1);
  assert.equal((w.saldo().abonos as Doc[]).length, 1);
});

test('F4C-FC24 · dos operaciones distintas del MISMO monto (30 + 30) ⇒ ambas válidas: la idempotencia no depende del monto', async () => {
  const w = mundo(); sembrar(w);
  await abonar(w, 'g1', { monto: 30, operacionId: OP('A') });
  await abonar(w, 'g1', { monto: 30, operacionId: OP('B') });
  assert.equal(w.saldo().saldoPendiente, 40);
  assert.equal(w.movimientos().length, 2);
  assert.equal((w.saldo().abonos as Doc[]).length, 2);
  const x = mundo(); sembrar(x);
  const rs = await Promise.all([abonar(x, 'g1', { monto: 30, operacionId: OP('A') }), abonar(x, 'g2', { monto: 30, operacionId: OP('B') })]);
  assert.deepEqual(rs.map((r) => r.resultado), ['aplicado', 'aplicado']);
  assert.equal(x.saldo().saldoPendiente, 40);
});

// ── F4C-FC25/26 · integridad parcial ──────────────────────────────────────────
test('F4C-FC25 · hay MOVIMIENTO de la operación pero el saldo no tiene su abono ⇒ abono_inconsistente, sin reparar', async () => {
  const w = mundo(); sembrar(w);
  w.put('movimientos_financieros/abono_' + OP(1), { tipo: 'abono_deuda_motorizado', estado: 'activo', saldoId: 's1', monto: 40 });
  const antes = w.snapshot();
  await assert.rejects(abonar(w), codigo('failed-precondition', 'abono_inconsistente'));
  assert.equal(w.snapshot(), antes);
  assert.equal(w.saldo().saldoPendiente, 100);
});

test('F4C-FC26 · el saldo tiene el ABONO de la operación pero falta su movimiento ⇒ abono_inconsistente, sin reparar', async () => {
  const w = mundo(); sembrar(w, { saldo: { saldoPendiente: 60, estado: 'abonado_parcial', abonos: [{ monto: 40, metodoAbono: 'transferencia', operacionId: OP(1), movimientoId: 'abono_' + OP(1) }] } });
  const antes = w.snapshot();
  await assert.rejects(abonar(w), codigo('failed-precondition', 'abono_inconsistente'));
  assert.equal(w.snapshot(), antes);
});

test('F4C-FC26b · abono y movimiento que no coinciden (monto, saldo, tipo o estado) ⇒ abono_inconsistente', async () => {
  const base = { saldoPendiente: 60, estado: 'abonado_parcial', abonos: [{ monto: 40, metodoAbono: 'transferencia', operacionId: OP(1), movimientoId: 'abono_' + OP(1) }] };
  const mov = { tipo: 'abono_deuda_motorizado', estado: 'activo', saldoId: 's1', monto: 40 };
  for (const [nombre, m] of [['monto', { ...mov, monto: 41 }], ['tipo', { ...mov, tipo: 'otro' }], ['estado', { ...mov, estado: 'anulado' }], ['saldo', { ...mov, saldoId: 'sX' }]] as const) {
    const w = mundo(); sembrar(w, { saldo: base }); w.put('movimientos_financieros/abono_' + OP(1), m);
    await assert.rejects(abonar(w), (e) => codigo('failed-precondition')(e), nombre);
    assert.equal(w.escrituras, 0, nombre);
  }
});

// ── F4C-FC27 · payload ────────────────────────────────────────────────────────
test('F4C-FC27 · el payload solo admite la intención y su metadata ⇒ invalid-argument ante cualquier otro campo o valor malo', async () => {
  const w = mundo(); sembrar(w);
  const base = { saldoId: 's1', monto: 40, operacionId: OP(1), metodoAbono: 'transferencia' };
  for (const malo of [null, [], 's1', {}, { ...base, saldoId: '' }, { ...base, saldoId: 5 }, { ...base, operacionId: 'corto' }, { ...base, operacionId: 'x'.repeat(65) },
    { ...base, operacionId: 'con espacios 1234567890' }, { ...base, operacionId: undefined }, { ...base, metodoAbono: 'efectivo' }, { ...base, metodoAbono: undefined },
    { ...base, nota: 'x'.repeat(501) }, { ...base, nota: 5 }, { ...base, comprobanteUrl: 'http://ex.test/c.jpg' }, { ...base, comprobanteUrl: 5 },
    { ...base, comprobantePath: 'otro/s1/abono_0.jpg' }, { ...base, comprobantePath: 'saldos/s2/abono_0.jpg' }, { ...base, comprobantePath: 'saldos/s1/../x.jpg' },
    { ...base, extra: 1 }, { ...base, motorizadoId: 'm' }, { ...base, creadoPorUid: 'a1' }]) {
    await assert.rejects(registrarAbonoDirectoCore(w.deps, 'g1', malo), codigo('invalid-argument'), JSON.stringify(malo));
  }
  assert.equal(w.escrituras, 0);
  assert.equal(validarPeticionAbono({ ...base, nota: '  hola  ' }).nota, 'hola');
  assert.equal(validarPeticionAbono(base).nota, '');
});

// ── Contrato del adaptador real: nada financiero fuera de la transacción ──────
test('F4C-AT1 · el adaptador escribe saldo y movimiento SOLO con tx.* dentro de runTransaction, y el núcleo hace una sola transacción', () => {
  const norm = (p: string[]) => readFileSync(join(__dirname, ...p), 'utf8').replace(/\r\n/g, '\n');
  const callable = norm(['..', '..', 'src', 'abono-directo-callable.ts']).replace(/\/\/.*$/gm, '');
  const nucleo = norm(['..', '..', 'src', 'abono-directo.ts']).replace(/\/\/.*$/gm, '');
  assert.match(callable, /updateSaldo: \(id, campos\) => \{ tx\.update\(db\.collection\('saldos_cargo_motorizado'\)\.doc\(id\), campos\); \}/);
  assert.match(callable, /crearMovimiento: \(id, campos\) => \{ tx\.create\(db\.collection\('movimientos_financieros'\)\.doc\(id\), campos\); \}/);
  assert.equal((callable.match(/db\.runTransaction\(/g) ?? []).length, 1, 'una sola transacción');
  const sinTx = callable.replace(/tx\.(create|update)\(/g, 'TX_$1(');
  for (const w of ['.add(', '.set(', '.create(', '.update(', '.batch(', 'bulkWriter']) assert.ok(!sinTx.includes(w), `sin ${w} fuera de la transacción`);
  assert.equal((nucleo.match(/deps\.transaction[<(]/g) ?? []).length, 1);
  assert.ok(!nucleo.includes('registrarMovimiento') && !nucleo.includes('addDoc') && !nucleo.includes('arrayUnion'));
  assert.ok(nucleo.includes('tx.updateSaldo(') && nucleo.includes('tx.crearMovimiento(') && nucleo.includes('tx.updateIntencion('), 'saldo, ledger e intención en la MISMA transacción');
  assert.match(callable, /updateIntencion: \(id, campos\) => \{ tx\.update\(db\.collection\('intenciones_abono_directo'\)\.doc\(id\), campos\); \}/);
});
