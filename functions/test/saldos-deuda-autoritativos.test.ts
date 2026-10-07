// FIN-1A — condonarDeudaMotorizadoCore y anularSaldoCargoCore: saldos y deuda AUTORITATIVOS.
//
// El "mundo" simula lo que importa de Firestore (transacciones optimistas con reintento, escrituras todo-o-nada,
// create()/update()), como en reversion-conversion.test.ts. La prueba con el emulador real vive en el runtime.
import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { DocumentData } from 'firebase-admin/firestore';
import { condonarDeudaMotorizadoCore, type DepsCondonacion } from '../src/condonacion-deuda';
import { anularSaldoCargoCore, type DepsAnulacion } from '../src/anulacion-saldo';
import { validarSaldoYMotivo } from '../src/saldo-acciones-comun';
import { ESTADOS_ABONABLES } from '../src/abono-directo';

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
  const hooks: { antesDeCommit?: () => void; fallarSi?: (op: string, ruta: string) => boolean } = {};
  const clonar = (m: Map<string, Doc>) => new Map([...m].map(([k, v]) => [k, structuredClone(v)]));
  const put = (ruta: string, d: Doc) => { store.set(ruta, d); };
  const get = (ruta: string) => { const d = store.get(ruta); return d ? (structuredClone(d) as DocumentData) : null; };
  const movsDe = (saldoId: string) => [...store].filter(([r, d]) => r.startsWith('movimientos_financieros/') && d.saldoId === saldoId)
    .map(([r, d]) => ({ id: r.split('/')[1], data: structuredClone(d) as DocumentData }));

  async function correr<T>(fn: (tx: never) => Promise<T>): Promise<T> {
    for (;;) {
      const inicio = revision;
      const cola: Array<{ op: string; ruta: string; datos: Doc }> = [];
      const q = (op: string, ruta: string, datos: Doc) => { cola.push({ op, ruta, datos }); };
      const tx = {
        async getUsuario(uid: string) { return get(`usuarios/${uid}`); },
        async getSaldo(id: string) { return get(`saldos_cargo_motorizado/${id}`); },
        async getDeposito(id: string) { return get(`ordenes_deposito/${id}`); },
        async getMovimientosDeSaldo(id: string) { return movsDe(id); },
        updateSaldo(id: string, c: Doc) { q('update', `saldos_cargo_motorizado/${id}`, c); },
        updateDeposito(id: string, c: Doc) { q('update', `ordenes_deposito/${id}`, c); },
        updateMovimiento(id: string, c: Doc) { q('update', `movimientos_financieros/${id}`, c); },
        crearMovimiento(id: string, c: Doc) { q('create', `movimientos_financieros/${id}`, c); },
      };
      const resultado = await fn(tx as never);
      const hook = hooks.antesDeCommit; hooks.antesDeCommit = undefined; hook?.();
      if (revision !== inicio) continue;
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
      store = copia;
      if (cola.length) { revision++; escrituras += cola.length; }
      return resultado;
    }
  }
  const depsCond: DepsCondonacion = { transaction: correr as DepsCondonacion['transaction'], serverTimestamp: () => TS(++relojes) };
  const depsAnul: DepsAnulacion = { transaction: correr as DepsAnulacion['transaction'], serverTimestamp: () => TS(++relojes) };
  return {
    depsCond, depsAnul, hooks, put, get, bump: () => { revision++; },
    get escrituras() { return escrituras; },
    snapshot: () => JSON.stringify([...store].sort(([a], [b]) => a.localeCompare(b))),
    movimientos: () => [...store].filter(([r]) => r.startsWith('movimientos_financieros/')).map(([r, d]) => ({ id: r.split('/')[1], ...d } as Doc & { id: string })),
  };
}
type Mundo = ReturnType<typeof mundo>;

const MOT = 'motA';
const conv = (id = 'conv_S1', extra: Doc = {}): [string, Doc] => [`movimientos_financieros/${id}`, {
  tipo: 'deposito_convertido_en_deuda', monto: 100, estado: 'activo', motorizadoId: MOT, depositoId: 'D1', saldoId: 'S1',
  cuentaOrigen: `efectivo_en_poder:${MOT}`, cuentaDestino: `deuda_motorizado:${MOT}`, ...extra,
}];

function usuarios(w: Mundo) {
  w.put('usuarios/g1', { activo: true, rol: 'gestor' });
  w.put('usuarios/a1', { activo: true, rol: 'admin' });
  w.put('usuarios/dig', { activo: true, rol: 'digitador' });
  w.put('usuarios/mot', { activo: true, rol: 'motorizado' });
  w.put('usuarios/com', { activo: true, rol: 'Comercio' });
  w.put('usuarios/baja', { activo: false, rol: 'gestor' });
}

/** Una deuda de conversión coherente (FIN-4A): depósito convertido, saldo pendiente de C$100, UN movimiento de conversión. */
function sembrarDeposito(w: Mundo, opts: { saldo?: Doc; dep?: Doc; legacy?: boolean; sinMov?: boolean } = {}) {
  usuarios(w);
  w.put('ordenes_deposito/D1', { tipo: 'recaudacion_motorizado_storkhub', estado: 'convertido_en_deuda', saldoId: 'S1', notaConversion: 'n', montoTotal: 100, ...opts.dep });
  w.put('saldos_cargo_motorizado/S1', {
    motorizadoId: MOT, motorizadoNombre: 'Luigi', tipo: 'deposito_no_realizado', origen: 'deposito', depositoId: 'D1',
    montoOriginal: 100, saldoPendiente: 100, estado: 'pendiente', abonos: [], nota: 'nota original', ...opts.saldo,
  });
  if (!opts.sinMov) { const [r, d] = conv(opts.legacy ? 'AzarLegacy9' : 'conv_S1'); w.put(r, d); }
}

/** Un saldo MANUAL coherente: ajuste_manual de C$50 con su movimiento saldo_creado activo. */
function sembrarManual(w: Mundo, opts: { saldo?: Doc; sinMov?: boolean; mov?: Doc; movId?: string } = {}) {
  usuarios(w);
  w.put('saldos_cargo_motorizado/M1', {
    motorizadoId: MOT, motorizadoNombre: 'Luigi', tipo: 'ajuste_manual', origen: 'manual',
    montoOriginal: 50, saldoPendiente: 50, estado: 'pendiente', abonos: [], nota: 'nota del ajuste', ...opts.saldo,
  });
  if (!opts.sinMov) w.put(`movimientos_financieros/${opts.movId ?? 'sc_M1'}`, { tipo: 'saldo_creado', monto: 50, estado: 'activo', motorizadoId: MOT, saldoId: 'M1', ...opts.mov });
}

const MOTIVO = 'Se decide absorber la deuda';
const condonar = (w: Mundo, uid: string | undefined = 'g1', data: unknown = { saldoId: 'S1', motivo: MOTIVO }) => condonarDeudaMotorizadoCore(w.depsCond, uid, data);
const anular = (w: Mundo, uid: string | undefined = 'g1', data: unknown = { saldoId: 'M1', motivo: 'Se creó por error' }) => anularSaldoCargoCore(w.depsAnul, uid, data);
const sinEfectos = async (w: Mundo, p: Promise<unknown>, esperado: (e: unknown) => boolean) => {
  const antes = w.snapshot(); const e0 = w.escrituras;
  await assert.rejects(p, esperado);
  assert.equal(w.snapshot(), antes, 'el estado no cambió');
  assert.equal(w.escrituras, e0, '0 escrituras');
};
const abono = (monto: number): Doc => ({ monto, metodoAbono: 'ajuste_manual', operacionId: 'op' + monto, movimientoId: 'abono_op' + monto });
const movAbono = (monto: number): [string, Doc] => [`movimientos_financieros/abono_op${monto}`, { tipo: 'abono_deuda_motorizado', monto, estado: 'activo', saldoId: 'S1', motorizadoId: MOT }];

// ═══ CONDONAR ═══════════════════════════════════════════════════════════════

test('FIN1A-A1 · pendiente virgen ⇒ condona C$100: saldo condonado y en 0; un movimiento deuda_condonada; el depósito sigue convertido con condonado:true', async () => {
  const w = mundo(); sembrarDeposito(w);
  const r = await condonar(w);
  assert.deepEqual({ ...r }, { ok: true, resultado: 'condonada', saldoId: 'S1', depositoId: 'D1', movimientoId: 'cond_S1', montoCondonado: 100 });
  const s = w.get('saldos_cargo_motorizado/S1')!;
  assert.equal(s.estado, 'condonado'); assert.equal(s.saldoPendiente, 0); assert.equal(s.montoCondonado, 100);
  assert.equal(s.movimientoCondonacionId, 'cond_S1'); assert.equal(s.motivoCondonacion, MOTIVO);
  assert.equal(s.montoOriginal, 100); assert.equal(s.depositoId, 'D1'); assert.equal(s.nota, 'nota original'); assert.deepEqual(s.abonos, []);
  const d = w.get('ordenes_deposito/D1')!;
  assert.equal(d.estado, 'convertido_en_deuda'); assert.equal(d.condonado, true); assert.equal(d.notaCondonacion, MOTIVO);
  const m = w.get('movimientos_financieros/cond_S1')!;
  assert.equal(m.tipo, 'deuda_condonada'); assert.equal(m.monto, 100); assert.equal(m.estado, 'activo');
  assert.equal(m.cuentaOrigen, `deuda_motorizado:${MOT}`); assert.equal(m.cuentaDestino, 'perdida_condonaciones');
  assert.equal(m.saldoId, 'S1'); assert.equal(m.depositoId, 'D1'); assert.equal(m.motorizadoId, MOT);
  assert.equal(w.get('movimientos_financieros/conv_S1')!.estado, 'activo', 'la conversión NO se anula: la deuda sigue naciendo de ella');
});

test('FIN1A-A2 · abonado_parcial (100 − 40) ⇒ condona SOLO el remanente de C$60 y preserva los abonos y su movimiento', async () => {
  const w = mundo(); sembrarDeposito(w, { saldo: { estado: 'abonado_parcial', saldoPendiente: 60, abonos: [abono(40)] } });
  const [r, d] = movAbono(40); w.put(r, d);
  const res = await condonar(w);
  assert.equal(res.montoCondonado, 60);
  const s = w.get('saldos_cargo_motorizado/S1')!;
  assert.equal(s.montoCondonado, 60); assert.equal(s.saldoPendiente, 0); assert.equal(s.montoOriginal, 100);
  assert.equal((s.abonos as Doc[]).length, 1); assert.equal((s.abonos as Doc[])[0].monto, 40);
  assert.equal(w.get('movimientos_financieros/cond_S1')!.monto, 60, 'la pérdida es el remanente, no el original');
  assert.equal(w.get('movimientos_financieros/abono_op40')!.estado, 'activo', 'el abono no se toca');
});

test('FIN1A-A3 / A5 · pagado y anulado bloquean (saldo_no_condonable) y estado desconocido o evidencia de condonación suelta ⇒ saldo_inconsistente; 0 escrituras', async () => {
  for (const [saldo, motivo] of [
    [{ estado: 'pagado', saldoPendiente: 0, abonos: [abono(100)] }, 'saldo_no_condonable'],
    [{ estado: 'anulado' }, 'saldo_no_condonable'],
    [{ estado: 'raro' }, 'saldo_inconsistente'],
    [{ montoCondonado: 50 }, 'saldo_inconsistente'],
  ] as Array<[Doc, string]>) {
    const w = mundo(); sembrarDeposito(w, { saldo });
    await sinEfectos(w, condonar(w), codigo('failed-precondition', motivo));
  }
});

test('FIN1A-A4 · retry tras el éxito ⇒ ya_condonada, 0 escrituras; se resuelve ANTES de los guards (aunque el depósito ya no cumpla)', async () => {
  const w = mundo(); sembrarDeposito(w);
  await condonar(w);
  const antes = w.snapshot(); const e0 = w.escrituras;
  for (const uid of ['g1', 'a1', 'g1']) assert.equal((await condonar(w, uid)).resultado, 'ya_condonada');
  assert.equal(w.snapshot(), antes); assert.equal(w.escrituras, e0);
  assert.equal(w.movimientos().filter((m) => m.tipo === 'deuda_condonada').length, 1, 'una sola condonación');
  // el depósito cambió de estado después: el retry legítimo no se convierte en inconsistencia
  w.put('ordenes_deposito/D1', { ...w.get('ordenes_deposito/D1')!, estado: 'en_revision' });
  assert.equal((await condonar(w)).resultado, 'ya_condonada');
});

test('FIN1A-A4b · condonado legacy SIN movimientoCondonacionId pero con UNA condonación activa ⇒ ya_condonada; con 0 o 2 ⇒ conciliacion_requerida', async () => {
  const mov = (id: string) => w2.put(`movimientos_financieros/${id}`, { tipo: 'deuda_condonada', monto: 100, estado: 'activo', saldoId: 'S1' });
  const w1 = mundo(); sembrarDeposito(w1, { saldo: { estado: 'condonado', saldoPendiente: 0, montoCondonado: 100 } });
  w1.put('movimientos_financieros/legacyCond', { tipo: 'deuda_condonada', monto: 100, estado: 'activo', saldoId: 'S1' });
  assert.equal((await condonar(w1)).resultado, 'ya_condonada');
  const w2 = mundo(); sembrarDeposito(w2, { saldo: { estado: 'condonado', saldoPendiente: 0, montoCondonado: 100 } });
  await sinEfectos(w2, condonar(w2), codigo('failed-precondition', 'conciliacion_requerida'));
  mov('c1'); mov('c2');
  await sinEfectos(w2, condonar(w2), codigo('failed-precondition', 'conciliacion_requerida'));
});

test('FIN1A-A6 · el monto NO lo decide el cliente: cualquier campo monto/estado/motorizado/actor/rol ⇒ invalid-argument; el monto sale del saldo releído', async () => {
  const w = mundo(); sembrarDeposito(w);
  for (const extra of [{ monto: 1 }, { montoCondonado: 1 }, { motorizadoId: 'otro' }, { motorizadoNombre: 'x' }, { depositoId: 'D1' }, { estado: 'x' }, { actorUid: 'a1' }, { actorRol: 'admin' }, { rol: 'admin' }, { saldoPendiente: 1 }, { operadorId: 'a1' }, { nota: 'x' }]) {
    await sinEfectos(w, condonar(w, 'g1', { saldoId: 'S1', motivo: MOTIVO, ...extra }), codigo('invalid-argument'));
  }
  await condonar(w);
  assert.equal(w.get('movimientos_financieros/cond_S1')!.monto, 100);
});

test('FIN1A-A7 · actor y rol salen del servidor: un admin queda admin, un gestor gestor (en saldo, movimiento y no con rol fijo)', async () => {
  const g = mundo(); sembrarDeposito(g); await condonar(g, 'g1');
  const a = mundo(); sembrarDeposito(a); await condonar(a, 'a1');
  for (const [w, uid, rol] of [[g, 'g1', 'gestor'], [a, 'a1', 'admin']] as const) {
    const s = w.get('saldos_cargo_motorizado/S1')!; const m = w.get('movimientos_financieros/cond_S1')!;
    assert.equal(s.condonadoPorUid, uid); assert.equal(s.condonadoPorRol, rol);
    assert.equal(m.creadoPorUid, uid); assert.equal(m.creadoPorRol, rol);
  }
});

test('FIN1A-A7b · sin sesión ⇒ unauthenticated; digitador, motorizado, comercio, inactivo o inexistente ⇒ permission-denied; motivo inválido ⇒ invalid-argument', async () => {
  const w = mundo(); sembrarDeposito(w);
  await sinEfectos(w, condonarDeudaMotorizadoCore(w.depsCond, undefined, { saldoId: 'S1', motivo: MOTIVO }), codigo('unauthenticated'));
  for (const uid of ['dig', 'mot', 'com', 'baja', 'fantasma']) await sinEfectos(w, condonar(w, uid), codigo('permission-denied'));
  for (const motivo of ['', '  ', 'ab', 'x'.repeat(301), 5, null, undefined]) await sinEfectos(w, condonar(w, 'g1', { saldoId: 'S1', motivo }), codigo('invalid-argument'));
  for (const malo of [null, [], 'S1', {}, { saldoId: '', motivo: MOTIVO }, { saldoId: 5, motivo: MOTIVO }, { motivo: MOTIVO }]) await sinEfectos(w, condonar(w, 'g1', malo), codigo('invalid-argument'));
  assert.deepEqual(validarSaldoYMotivo({ saldoId: ' S1 ', motivo: '  por X  ' }), { saldoId: 'S1', motivo: 'por X' });
});

test('FIN1A-A8 · exactamente UNA deuda_condonada: un movimiento previo activo sin condonar el saldo ⇒ conciliacion_requerida; el id determinista no se pisa', async () => {
  const w = mundo(); sembrarDeposito(w);
  w.put('movimientos_financieros/otra', { tipo: 'deuda_condonada', monto: 100, estado: 'activo', saldoId: 'S1' });
  await sinEfectos(w, condonar(w), codigo('failed-precondition', 'conciliacion_requerida'));
  const x = mundo(); sembrarDeposito(x);
  x.put('movimientos_financieros/cond_S1', { tipo: 'deuda_condonada', monto: 1, estado: 'anulado', saldoId: 'S1' });
  await assert.rejects(condonar(x), /ALREADY_EXISTS/); // create(): nunca sobrescribe
});

test('FIN1A-A9 · condonar vs ABONAR (FIN-4C): si el abono commitea mientras corre la condonación, esta relee y condona SOLO el remanente nuevo (nunca un monto viejo)', async () => {
  const w = mundo(); sembrarDeposito(w);
  w.hooks.antesDeCommit = () => {
    w.put('saldos_cargo_motorizado/S1', { ...w.get('saldos_cargo_motorizado/S1')!, saldoPendiente: 60, estado: 'abonado_parcial', abonos: [abono(40)] });
    const [r, d] = movAbono(40); w.put(r, d);
    w.bump();
  };
  const res = await condonar(w);
  assert.equal(res.montoCondonado, 60);
  assert.equal(w.get('movimientos_financieros/cond_S1')!.monto, 60);
  assert.equal((w.get('saldos_cargo_motorizado/S1')!.abonos as Doc[]).length, 1);
  // y al revés: con la deuda condonada el saldo ya no es abonable
  assert.equal(ESTADOS_ABONABLES.includes(String(w.get('saldos_cargo_motorizado/S1')!.estado)), false);
});

test('FIN1A-A10 · condonar vs REVERTIR (FIN-4B): si la reversión anula el saldo primero, la condonación bloquea; si condona primero, el saldo condonado queda (FIN-4B lo bloquea por deuda_condonada)', async () => {
  const w = mundo(); sembrarDeposito(w);
  w.hooks.antesDeCommit = () => {
    w.put('saldos_cargo_motorizado/S1', { ...w.get('saldos_cargo_motorizado/S1')!, estado: 'anulado', revertidoAt: TS(9) });
    w.put('ordenes_deposito/D1', { ...w.get('ordenes_deposito/D1')!, estado: 'pendiente_boucher', saldoId: undefined });
    w.bump();
  };
  await assert.rejects(condonar(w), codigo('failed-precondition', 'saldo_no_condonable'));
  assert.equal(w.get('movimientos_financieros/cond_S1'), null, 'ninguna pérdida contable sobre un saldo anulado');
  assert.equal(w.get('ordenes_deposito/D1')!.condonado, undefined);
});

test('FIN1A-A11 · el depósito no está convertido, no existe o apunta a otro saldo ⇒ conversion_inconsistente; 0 escrituras', async () => {
  for (const dep of [{ estado: 'en_revision' }, { estado: 'pendiente_boucher' }, { saldoId: 'OTRO' }] as Doc[]) {
    const w = mundo(); sembrarDeposito(w, { dep });
    await sinEfectos(w, condonar(w), codigo('failed-precondition', 'conversion_inconsistente'));
  }
  const x = mundo(); sembrarDeposito(x, { saldo: { depositoId: 'NOEXISTE' } });
  await sinEfectos(x, condonar(x), codigo('failed-precondition', 'conversion_inconsistente'));
});

test('FIN1A-A12 / A13 · 0 movimientos de conversión activos, o 2 ⇒ conversion_inconsistente; 0 escrituras', async () => {
  const sin = mundo(); sembrarDeposito(sin, { sinMov: true });
  await sinEfectos(sin, condonar(sin), codigo('failed-precondition', 'conversion_inconsistente'));
  const anulado = mundo(); sembrarDeposito(anulado); anulado.put('movimientos_financieros/conv_S1', { ...anulado.get('movimientos_financieros/conv_S1')!, estado: 'anulado' });
  await sinEfectos(anulado, condonar(anulado), codigo('failed-precondition', 'conversion_inconsistente'));
  const dos = mundo(); sembrarDeposito(dos); const [r, d] = conv('conv_otra'); dos.put(r, d);
  await sinEfectos(dos, condonar(dos), codigo('failed-precondition', 'conversion_inconsistente'));
});

test('FIN1A-A14 · el movimiento de conversión LEGACY (id aleatorio) se localiza por saldoId y tipo, igual que uno moderno', async () => {
  const w = mundo(); sembrarDeposito(w, { legacy: true });
  assert.equal((await condonar(w)).resultado, 'condonada');
  const m = mundo(); sembrarDeposito(m);
  assert.equal((await condonar(m)).resultado, 'condonada');
});

test('FIN1A-A15 · un saldo matemáticamente incoherente (pendiente ≠ original − Σ abonos, abonos no numéricos, pendiente 0) ⇒ saldo_inconsistente / sin_saldo_pendiente; 0 escrituras', async () => {
  for (const [saldo, motivo] of [
    [{ saldoPendiente: 70 }, 'saldo_inconsistente'],
    [{ estado: 'abonado_parcial', saldoPendiente: 50, abonos: [abono(40)] }, 'saldo_inconsistente'],
    [{ estado: 'abonado_parcial', saldoPendiente: 60, abonos: [{ monto: 'x' }] }, 'saldo_inconsistente'],
    [{ saldoPendiente: -5 }, 'saldo_inconsistente'],
  ] as Array<[Doc, string]>) {
    const w = mundo(); sembrarDeposito(w, { saldo });
    await sinEfectos(w, condonar(w), codigo('failed-precondition', motivo));
  }
  const cero = mundo(); sembrarDeposito(cero, { saldo: { estado: 'abonado_parcial', saldoPendiente: 0, abonos: [abono(100)] } });
  await sinEfectos(cero, condonar(cero), codigo('failed-precondition', 'sin_saldo_pendiente'));
});

test('FIN1A-A16 · solo una deuda de depósito: origen liquidacion / manual, o tipo distinto ⇒ saldo_no_condonable; no existe ⇒ not-found', async () => {
  for (const saldo of [{ origen: 'liquidacion', depositoId: undefined, liquidacionId: 'L1' }, { origen: 'manual', tipo: 'ajuste_manual' }, { tipo: 'adelanto' }, { depositoId: undefined }] as Doc[]) {
    const w = mundo(); sembrarDeposito(w, { saldo });
    await sinEfectos(w, condonar(w), codigo('failed-precondition', 'saldo_no_condonable'));
  }
  const w = mundo(); sembrarDeposito(w);
  await sinEfectos(w, condonar(w, 'g1', { saldoId: 'NOHAY', motivo: MOTIVO }), codigo('not-found'));
});

test('FIN1A-A17 · atomicidad: si CUALQUIERA de las 3 escrituras falla no queda nada aplicado; el reintento deja un solo efecto', async () => {
  for (const ruta of ['saldos_cargo_motorizado/S1', 'ordenes_deposito/D1', 'movimientos_financieros/cond_S1']) {
    const w = mundo(); sembrarDeposito(w);
    const antes = w.snapshot();
    w.hooks.fallarSi = (_op, r) => r === ruta;
    await assert.rejects(condonar(w), /fallo simulado/);
    assert.equal(w.snapshot(), antes, `rollback total (falló ${ruta})`);
    w.hooks.fallarSi = undefined;
    assert.equal((await condonar(w)).resultado, 'condonada');
    assert.equal(w.movimientos().filter((m) => m.tipo === 'deuda_condonada').length, 1);
  }
});

// ═══ ANULAR ═════════════════════════════════════════════════════════════════

test('FIN1A-B1 / B12 · manual ajuste_manual virgen + 1 saldo_creado ⇒ anula SALDO y MOVIMIENTO juntos y conserva la nota original', async () => {
  const w = mundo(); sembrarManual(w);
  const r = await anular(w);
  assert.deepEqual({ ...r }, { ok: true, resultado: 'anulada', saldoId: 'M1', movimientoId: 'sc_M1' });
  const s = w.get('saldos_cargo_motorizado/M1')!;
  assert.equal(s.estado, 'anulado'); assert.equal(s.motivoAnulacion, 'Se creó por error'); assert.equal(s.anuladoPorUid, 'g1'); assert.equal(s.anuladoPorRol, 'gestor'); assert.ok(s.anuladoAt);
  assert.equal(s.nota, 'nota del ajuste', 'la nota NO se pisa (el writer viejo escribía nota: "")');
  assert.equal(s.montoOriginal, 50); assert.equal(s.saldoPendiente, 50);
  const m = w.get('movimientos_financieros/sc_M1')!;
  assert.equal(m.estado, 'anulado'); assert.equal(m.anuladoPorUid, 'g1'); assert.equal(m.anuladoPorRol, 'gestor'); assert.equal(m.motivoAnulacion, 'Se creó por error');
  assert.equal(m.tipo, 'saldo_creado'); assert.equal(m.monto, 50); assert.equal(m.saldoId, 'M1');
  const o = mundo(); sembrarManual(o, { saldo: { tipo: 'otro' } });
  assert.equal((await anular(o)).resultado, 'anulada');
});

test('FIN1A-B2 / B3 / B4 · abonos, abonado_parcial, pagado, condonado, pendiente cambiado o estado desconocido bloquean; 0 escrituras', async () => {
  for (const [saldo, motivo] of [
    [{ abonos: [{ monto: 10 }], saldoPendiente: 40 }, 'saldo_con_abonos'],
    [{ estado: 'abonado_parcial', abonos: [{ monto: 10 }], saldoPendiente: 40 }, 'saldo_con_abonos'],
    [{ abonos: [{ monto: 10 }], saldoPendiente: 50 }, 'saldo_inconsistente'],
    [{ saldoPendiente: 20 }, 'saldo_inconsistente'],
    [{ estado: 'pagado', saldoPendiente: 0, abonos: [{ monto: 50 }] }, 'saldo_pagado'],
    [{ estado: 'condonado', saldoPendiente: 0, montoCondonado: 50 }, 'saldo_condonado'],
    [{ condonadoAt: TS(1) }, 'saldo_condonado'],
    [{ estado: 'raro' }, 'saldo_inconsistente'],
    [{ estado: undefined }, 'saldo_inconsistente'],
  ] as Array<[Doc, string]>) {
    const w = mundo(); sembrarManual(w, { saldo });
    await sinEfectos(w, anular(w), codigo('failed-precondition', motivo));
  }
});

test('FIN1A-B5 / B6 / B7 · origen depósito ⇒ usar_reversion_conversion; origen/liquidacionId de liquidación ⇒ usar_correccion_liquidacion; adelanto ⇒ ledger_no_demostrable; otros ⇒ saldo_no_anulable; 0 escrituras', async () => {
  const dep = mundo(); sembrarDeposito(dep); dep.put('saldos_cargo_motorizado/M1', { ...dep.get('saldos_cargo_motorizado/S1')! });
  await sinEfectos(dep, anular(dep, 'g1', { saldoId: 'S1', motivo: 'motivo valido' }), codigo('failed-precondition', 'usar_reversion_conversion'));
  await sinEfectos(dep, anular(dep, 'g1', { saldoId: 'M1', motivo: 'motivo valido' }), codigo('failed-precondition', 'usar_reversion_conversion'));
  for (const saldo of [{ origen: 'liquidacion', tipo: 'deposito_no_realizado' }, { liquidacionId: 'L1' }] as Doc[]) {
    const w = mundo(); sembrarManual(w, { saldo });
    await sinEfectos(w, anular(w), codigo('failed-precondition', 'usar_correccion_liquidacion'));
  }
  const ade = mundo(); sembrarManual(ade, { saldo: { tipo: 'adelanto' } });
  await sinEfectos(ade, anular(ade), codigo('failed-precondition', 'ledger_no_demostrable'));
  for (const saldo of [{ tipo: 'deposito_no_realizado' }, { origen: 'raro' }, { tipo: 'raro' }] as Doc[]) {
    const w = mundo(); sembrarManual(w, { saldo });
    await sinEfectos(w, anular(w), codigo('failed-precondition', 'saldo_no_anulable'));
  }
});

test('FIN1A-B8 / B9 · 0 movimientos saldo_creado ⇒ ledger_no_demostrable; 2, u otro movimiento activo además ⇒ ledger_inconsistente; monto o saldoId que no coinciden ⇒ ledger_inconsistente; 0 escrituras', async () => {
  const cero = mundo(); sembrarManual(cero, { sinMov: true });
  await sinEfectos(cero, anular(cero), codigo('failed-precondition', 'ledger_no_demostrable'));
  const otro = mundo(); sembrarManual(otro, { sinMov: true }); otro.put('movimientos_financieros/x', { tipo: 'ajuste_x', monto: 50, estado: 'activo', saldoId: 'M1' });
  await sinEfectos(otro, anular(otro), codigo('failed-precondition', 'ledger_no_demostrable'));
  const anulado = mundo(); sembrarManual(anulado, { mov: { estado: 'anulado' } });
  await sinEfectos(anulado, anular(anulado), codigo('failed-precondition', 'ledger_no_demostrable'));
  const dos = mundo(); sembrarManual(dos); dos.put('movimientos_financieros/sc_dup', { tipo: 'saldo_creado', monto: 50, estado: 'activo', saldoId: 'M1' });
  await sinEfectos(dos, anular(dos), codigo('failed-precondition', 'ledger_inconsistente'));
  const extra = mundo(); sembrarManual(extra); extra.put('movimientos_financieros/x', { tipo: 'ajuste_x', monto: 1, estado: 'activo', saldoId: 'M1' });
  await sinEfectos(extra, anular(extra), codigo('failed-precondition', 'ledger_inconsistente'));
  const monto = mundo(); sembrarManual(monto, { mov: { monto: 49 } });
  await sinEfectos(monto, anular(monto), codigo('failed-precondition', 'ledger_inconsistente'));
  const sinEstado = mundo(); sembrarManual(sinEstado, { mov: { estado: undefined } }); // sin estado = activo (semántica del ledger)
  assert.equal((await anular(sinEstado)).resultado, 'anulada');
});

test('FIN1A-B10 · retry tras el éxito ⇒ ya_anulado, 0 escrituras; un saldo anulado por cualquier vía responde ya_anulado ANTES de los guards', async () => {
  const w = mundo(); sembrarManual(w);
  await anular(w);
  const antes = w.snapshot(); const e0 = w.escrituras;
  for (const uid of ['g1', 'a1']) assert.equal((await anular(w, uid)).resultado, 'ya_anulado');
  assert.equal(w.snapshot(), antes); assert.equal(w.escrituras, e0);
  for (const saldo of [{ estado: 'anulado', origen: 'deposito', depositoId: 'D1' }, { estado: 'anulado', tipo: 'adelanto' }, { estado: 'anulado', origen: 'liquidacion' }] as Doc[]) {
    const x = mundo(); sembrarManual(x, { saldo, sinMov: true });
    assert.equal((await anular(x)).resultado, 'ya_anulado');
  }
});

test('FIN1A-B11 · actor y rol del servidor (admin queda admin); roles inválidos y payload extra ⇒ rechazo y 0 escrituras', async () => {
  const a = mundo(); sembrarManual(a); await anular(a, 'a1');
  assert.equal(a.get('saldos_cargo_motorizado/M1')!.anuladoPorRol, 'admin'); assert.equal(a.get('movimientos_financieros/sc_M1')!.anuladoPorRol, 'admin');
  const w = mundo(); sembrarManual(w);
  await sinEfectos(w, anularSaldoCargoCore(w.depsAnul, undefined, { saldoId: 'M1', motivo: 'motivo valido' }), codigo('unauthenticated'));
  for (const uid of ['dig', 'mot', 'com', 'baja', 'fantasma']) await sinEfectos(w, anular(w, uid), codigo('permission-denied'));
  for (const extra of [{ estado: 'anulado' }, { tipo: 'x' }, { origen: 'manual' }, { movimientoId: 'sc_M1' }, { monto: 1 }, { motorizadoId: 'm' }, { actorUid: 'a1' }, { nota: '' }]) {
    await sinEfectos(w, anular(w, 'g1', { saldoId: 'M1', motivo: 'motivo valido', ...extra }), codigo('invalid-argument'));
  }
  await sinEfectos(w, anular(w, 'g1', { saldoId: 'M1', motivo: 'ab' }), codigo('invalid-argument'));
  await sinEfectos(w, anular(w, 'g1', { saldoId: 'NOHAY', motivo: 'motivo valido' }), codigo('not-found'));
});

test('FIN1A-B13 · anular vs ABONAR (FIN-4C): si el abono commitea mientras corre la anulación, esta relee y BLOQUEA (nunca saldo anulado + abono aceptado); si anula primero, el saldo anulado no es abonable', async () => {
  const w = mundo(); sembrarManual(w);
  w.hooks.antesDeCommit = () => {
    w.put('saldos_cargo_motorizado/M1', { ...w.get('saldos_cargo_motorizado/M1')!, saldoPendiente: 40, estado: 'abonado_parcial', abonos: [{ monto: 10 }] });
    w.put('movimientos_financieros/abono_x', { tipo: 'abono_deuda_motorizado', monto: 10, estado: 'activo', saldoId: 'M1' });
    w.bump();
  };
  await assert.rejects(anular(w), codigo('failed-precondition', 'saldo_con_abonos'));
  assert.equal(w.get('saldos_cargo_motorizado/M1')!.estado, 'abonado_parcial');
  assert.equal(w.get('movimientos_financieros/sc_M1')!.estado, 'activo');
  const x = mundo(); sembrarManual(x); await anular(x);
  assert.equal(ESTADOS_ABONABLES.includes(String(x.get('saldos_cargo_motorizado/M1')!.estado)), false);
});

test('FIN1A-B14 · el movimiento de creación con id ALEATORIO (legacy) pero saldoId coherente se localiza igual', async () => {
  const w = mundo(); sembrarManual(w, { movId: 'AzarXyZ77' });
  const r = await anular(w);
  assert.equal(r.movimientoId, 'AzarXyZ77');
  assert.equal(w.get('movimientos_financieros/AzarXyZ77')!.estado, 'anulado');
});

test('FIN1A-B16 · atomicidad: si falla la escritura del saldo o del movimiento no queda nada aplicado; el reintento deja un solo efecto', async () => {
  for (const ruta of ['saldos_cargo_motorizado/M1', 'movimientos_financieros/sc_M1']) {
    const w = mundo(); sembrarManual(w);
    const antes = w.snapshot();
    w.hooks.fallarSi = (_op, r) => r === ruta;
    await assert.rejects(anular(w), /fallo simulado/);
    assert.equal(w.snapshot(), antes);
    w.hooks.fallarSi = undefined;
    assert.equal((await anular(w)).resultado, 'anulada');
  }
});

// ═══ CONTRATOS de la fuente ═════════════════════════════════════════════════

test('FIN1A-AT1 · los adaptadores reales escriben SOLO con tx.* dentro de una runTransaction; la condonación con create(); exports en index', () => {
  const norm = (p: string[]) => readFileSync(join(__dirname, ...p), 'utf8').replace(/\r\n/g, '\n');
  for (const f of ['condonacion-deuda-callable.ts', 'anulacion-saldo-callable.ts']) {
    const callable = norm(['..', '..', 'src', f]).replace(/\/\/.*$/gm, '');
    assert.equal((callable.match(/db\.runTransaction\(/g) ?? []).length, 1, `${f}: una sola transacción`);
    const sinTx = callable.replace(/tx\.(create|update)\(/g, 'TX_$1(');
    for (const w of ['.add(', '.set(', '.create(', '.update(', '.batch(', 'bulkWriter', '.delete(']) assert.ok(!sinTx.includes(w), `${f}: sin ${w} fuera de la transacción`);
  }
  assert.match(norm(['..', '..', 'src', 'condonacion-deuda-callable.ts']), /crearMovimiento: \(id, campos\) => \{ tx\.create\(/);
  const idx = norm(['..', '..', 'src', 'index.ts']);
  assert.match(idx, /export \{ condonarDeudaMotorizado \} from '\.\/condonacion-deuda-callable'/);
  assert.match(idx, /export \{ anularSaldoCargo \} from '\.\/anulacion-saldo-callable'/);
});

test('FIN1A-AT2 · los núcleos no leen del cliente el monto, el actor ni el rol, y la anulación NO escribe nota ni toca abonos; la condonación no anula la conversión', () => {
  const norm = (p: string) => readFileSync(join(__dirname, '..', '..', 'src', p), 'utf8').replace(/\r\n/g, '\n').replace(/\/\/.*$/gm, '');
  const cond = norm('condonacion-deuda.ts'); const anul = norm('anulacion-saldo.ts');
  for (const src of [cond, anul]) {
    // `data` suelto es el payload del cliente; `mov.data.monto` es un documento releído del servidor.
    assert.ok(!/(^|[^.\w])data\.(monto|actorUid|rol|motorizadoId)/.test(src), 'nada del cliente decide el dinero ni el actor');
    assert.ok(!/creadoPorRol: 'gestor'/.test(src), 'sin rol fijo');
  }
  const escrituraAnul = anul.slice(anul.indexOf('tx.updateSaldo('), anul.indexOf('return { ok: true as const, resultado: \'anulada\''));
  assert.ok(!escrituraAnul.includes('nota') && !escrituraAnul.includes('abonos') && !escrituraAnul.includes('saldoPendiente'), 'la anulación no pisa nota, abonos ni montos');
  assert.ok(!/updateMovimiento/.test(cond), 'la condonación no anula movimientos');
});
