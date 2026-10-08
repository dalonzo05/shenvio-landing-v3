// FIN-1C-B — crearGasto, anularGasto, registrarAdelanto, anularAdelanto y resolverIncidenciaCobro: AUTORITATIVOS.
//
// El "mundo" simula lo que importa de Firestore (transacciones optimistas con reintento, escrituras todo-o-nada, create()/update(), campos con
// punto), como en cobros-autoritativos.test.ts. La prueba con el emulador real vive en el runtime.
import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { DocumentData } from 'firebase-admin/firestore';
import { crearGastoMotorizadoCore, type DepsCrearGasto } from '../src/crear-gasto';
import { anularGastoMotorizadoCore, type DepsAnularGasto } from '../src/anular-gasto';
import { registrarAdelantoMotorizadoCore, anularAdelantoMotorizadoCore, type DepsRegistrarAdelanto, type DepsAnularAdelanto } from '../src/adelantos';
import { resolverIncidenciaCobroCore, type DepsResolver } from '../src/resolver-incidencia-cobro';
import { semanaKeyDeFecha } from '../src/cobro-semanal';
import { instanteDeFechaGasto, montoValido } from '../src/finanzas-operativas-comun';

type Doc = Record<string, unknown>;
const TS = (n: number) => ({ __ms: n });
const codigo = (code: string, motivo?: string) => (e: unknown) => {
  const err = e as { code?: string; details?: { motivo?: string } };
  return err.code === code && (motivo === undefined || err.details?.motivo === motivo);
};
const AHORA = new Date('2026-05-20T15:00:00Z'); // miércoles 09:00 en Managua
const SEMANA = semanaKeyDeFecha(AHORA);

function revivir(v: unknown): unknown {
  if (Array.isArray(v)) return v.map(revivir);
  if (v && typeof v === 'object') {
    const o = v as Record<string, unknown>;
    if (typeof o.__ms === 'number') { const ms = o.__ms; return { __ms: ms, toMillis: () => ms, toDate: () => new Date(ms) }; }
    return Object.fromEntries(Object.entries(o).map(([k, x]) => [k, revivir(x)]));
  }
  return v;
}
function desvivir(v: unknown): unknown {
  if (Array.isArray(v)) return v.map(desvivir);
  if (v && typeof v === 'object') {
    const o = v as Record<string, unknown>;
    if (typeof o.__ms === 'number') return { __ms: o.__ms };
    return Object.fromEntries(Object.entries(o).map(([k, x]) => [k, desvivir(x)]));
  }
  return v;
}
function aplicarCampos(actual: Doc, campos: Doc): Doc {
  const copia = structuredClone(actual);
  for (const [k, v] of Object.entries(campos)) {
    const partes = k.split('.');
    let cur: Record<string, unknown> = copia;
    for (let i = 0; i < partes.length - 1; i++) {
      const p = partes[i];
      if (typeof cur[p] !== 'object' || cur[p] === null) cur[p] = {};
      cur = cur[p] as Record<string, unknown>;
    }
    cur[partes[partes.length - 1]] = structuredClone(desvivir(v));
  }
  return copia;
}

function mundo() {
  let store = new Map<string, Doc>();
  let revision = 0;
  let relojes = 0;
  let escrituras = 0;
  const hooks: { antesDeCommit?: () => void; fallarSi?: (op: string, ruta: string) => boolean } = {};
  const clonar = (m: Map<string, Doc>) => new Map([...m].map(([k, v]) => [k, structuredClone(v)]));
  const put = (ruta: string, d: Doc) => { store.set(ruta, d); };
  const get = (ruta: string) => { const d = store.get(ruta); return d ? (revivir(structuredClone(d)) as DocumentData) : null; };
  const raw = (ruta: string) => structuredClone(store.get(ruta)) as Doc;
  const filtrar = (prefijo: string, pred: (d: Doc) => boolean) => [...store]
    .filter(([r, d]) => r.startsWith(prefijo) && !r.slice(prefijo.length).includes('/') && pred(d))
    .map(([r, d]) => ({ id: r.split('/').pop() as string, data: revivir(structuredClone(d)) as DocumentData }));
  const opCol = (id: string) => (id.startsWith('crear_') ? 'operaciones_gasto' : 'operaciones_adelanto');

  async function correr<T>(fn: (tx: never) => Promise<T>): Promise<T> {
    for (;;) {
      const inicio = revision;
      const cola: Array<{ op: string; ruta: string; datos: Doc }> = [];
      const q = (op: string, ruta: string, datos: Doc) => { cola.push({ op, ruta, datos }); };
      const tx = {
        async getUsuario(uid: string) { return get(`usuarios/${uid}`); },
        async getMotorizado(id: string) { return get(`motorizado/${id}`); },
        async getOrden(id: string) { return get(`solicitudes_envio/${id}`); },
        async getOperacion(id: string) { return get(`${opCol(id)}/${id}`); },
        async getGasto(id: string) { return get(`gastos_motorizado/${id}`); },
        async getDeposito(id: string) { return get(`ordenes_deposito/${id}`); },
        async getMovimiento(id: string) { return get(`movimientos_financieros/${id}`); },
        async getDepositosConGasto(id: string) { return filtrar('ordenes_deposito/', (d) => Array.isArray(d.gastosIds) && (d.gastosIds as string[]).includes(id)); },
        async getLiquidacionesConGasto(id: string) { return filtrar('liquidaciones_motorizado/', (d) => Array.isArray(d.gastosIds) && (d.gastosIds as string[]).includes(id)); },
        async getMovimientosDeGasto(id: string) { return filtrar('movimientos_financieros/', (d) => d.gastoId === id); },
        async getLiquidacion(id: string) { return get(`liquidaciones_motorizado/${id}`); },
        async getLiquidacionesDelMotorizado(mid: string, uid: string | null) { return filtrar('liquidaciones_motorizado/', (d) => d.motorizadoId === mid || (uid !== null && d.motorizadoUid === uid)); },
        crearGasto(id: string, c: Doc) { q('create', `gastos_motorizado/${id}`, c); },
        crearMovimiento(id: string, c: Doc) { q('create', `movimientos_financieros/${id}`, c); },
        crearOperacion(id: string, c: Doc) { q('create', `${opCol(id)}/${id}`, c); },
        updateGasto(id: string, c: Doc) { q('update', `gastos_motorizado/${id}`, c); },
        updateMovimiento(id: string, c: Doc) { q('update', `movimientos_financieros/${id}`, c); },
        updateOrden(id: string, c: Doc) { q('update', `solicitudes_envio/${id}`, c); },
      };
      const resultado = await fn(tx as never);
      const hook = hooks.antesDeCommit; hooks.antesDeCommit = undefined; hook?.();
      if (revision !== inicio) continue;
      const copia = clonar(store);
      for (const w of cola) {
        if (hooks.fallarSi?.(w.op, w.ruta)) throw new Error('fallo simulado de escritura: ' + w.ruta);
        if (w.op === 'create') {
          if (copia.has(w.ruta)) throw new Error('ALREADY_EXISTS ' + w.ruta);
          copia.set(w.ruta, structuredClone(desvivir(w.datos) as Doc));
        } else {
          const actual = copia.get(w.ruta);
          if (!actual) throw new Error('NOT_FOUND ' + w.ruta);
          copia.set(w.ruta, aplicarCampos(actual, w.datos));
        }
      }
      store = copia;
      if (cola.length) { revision++; escrituras += cola.length; }
      return resultado;
    }
  }
  const comun = { serverTimestamp: () => TS(++relojes) };
  const depsCrear: DepsCrearGasto = { transaction: correr as DepsCrearGasto['transaction'], ...comun, aTimestamp: (d) => ({ __ms: d.getTime() }), ahora: () => AHORA };
  const depsAnular: DepsAnularGasto = { transaction: correr as DepsAnularGasto['transaction'], ...comun };
  const depsReg: DepsRegistrarAdelanto = { transaction: correr as DepsRegistrarAdelanto['transaction'], ...comun, ahora: () => AHORA };
  const depsAnAd: DepsAnularAdelanto = { transaction: correr as DepsAnularAdelanto['transaction'], ...comun };
  const depsRes: DepsResolver = { transaction: correr as DepsResolver['transaction'], ...comun };
  return {
    depsCrear, depsAnular, depsReg, depsAnAd, depsRes, hooks, put, get, raw, bump: () => { revision++; },
    get escrituras() { return escrituras; },
    snapshot: () => JSON.stringify([...store].sort(([a], [b]) => a.localeCompare(b))),
    movimientos: () => filtrar('movimientos_financieros/', () => true),
    gastos: () => filtrar('gastos_motorizado/', () => true),
    operaciones: () => [...filtrar('operaciones_gasto/', () => true), ...filtrar('operaciones_adelanto/', () => true)],
  };
}
type Mundo = ReturnType<typeof mundo>;

const OP = 'op-12345678';
const OP2 = 'op-87654321';

function base(w: Mundo) {
  w.put('usuarios/a1', { activo: true, rol: 'admin' });
  w.put('usuarios/g1', { activo: true, rol: 'gestor' });
  w.put('usuarios/dig', { activo: true, rol: 'digitador' });
  w.put('usuarios/mot', { activo: true, rol: 'motorizado' });
  w.put('usuarios/baja', { activo: false, rol: 'gestor' });
  w.put('motorizado/m1', { authUid: 'mauth1', nombre: 'Luigi' });
}
const crear = (w: Mundo, uid: string | undefined, d: Doc) => crearGastoMotorizadoCore(w.depsCrear, uid, d);
const anular = (w: Mundo, uid: string | undefined, d: Doc) => anularGastoMotorizadoCore(w.depsAnular, uid, d);
const registrar = (w: Mundo, uid: string | undefined, d: Doc) => registrarAdelantoMotorizadoCore(w.depsReg, uid, d);
const anularAd = (w: Mundo, uid: string | undefined, d: Doc) => anularAdelantoMotorizadoCore(w.depsAnAd, uid, d);
const resolver = (w: Mundo, uid: string | undefined, d: Doc) => resolverIncidenciaCobroCore(w.depsRes, uid, d);
const gp = (extra: Doc = {}) => ({ operacionId: OP, motorizadoId: 'm1', tipo: 'peaje_terminal', monto: 40, ...extra });
const ap = (extra: Doc = {}) => ({ operacionId: OP, motorizadoId: 'm1', monto: 100, semanaKey: SEMANA, ...extra });

// ═══ GASTOS · CREAR ══════════════════════════════════════════════════════════

test('FIN1CB-G1 · crear un gasto válido: gasto aprobado, UN movimiento gasto_aprobado con las cuentas de siempre, marcador server-only, actor y rol reales', async () => {
  const w = mundo(); base(w);
  const r = await crear(w, 'g1', gp({ nota: ' peaje a Rivas ', fecha: '2026-05-18' }));
  assert.equal(r.resultado, 'registrado');
  const g = w.raw(`gastos_motorizado/${r.gastoId}`);
  assert.equal(g.estado, 'aprobado'); assert.equal(g.monto, 40); assert.equal(g.motorizadoId, 'm1'); assert.equal(g.motorizadoNombre, 'Luigi');
  assert.equal(g.nota, 'peaje a Rivas'); assert.equal(g.creadoPorUid, 'g1'); assert.equal(g.creadoPorRol, 'gestor'); assert.ok(!('consumidoEnDepositoId' in g));
  assert.deepEqual(g.fecha, { __ms: Date.UTC(2026, 4, 18, 18, 0, 0) }, 'mediodía de Managua del día elegido');
  const movs = w.movimientos();
  assert.equal(movs.length, 1);
  assert.equal(movs[0].data.tipo, 'gasto_aprobado'); assert.equal(movs[0].data.monto, 40); assert.equal(movs[0].data.estado, 'activo');
  assert.equal(movs[0].data.cuentaOrigen, 'efectivo_en_poder:m1'); assert.equal(movs[0].data.cuentaDestino, 'gastos_operativos');
  assert.equal(movs[0].data.gastoId, r.gastoId); assert.equal(movs[0].data.creadoPorUid, 'g1'); assert.equal(movs[0].data.creadoPorRol, 'gestor');
  assert.equal(w.operaciones().length, 1);
});

test('FIN1CB-G2 · monto 0, negativo, NaN, Infinity, texto, nulo o con más de 2 decimales ⇒ invalid-argument y nada se escribe', async () => {
  const w = mundo(); base(w);
  for (const m of [0, -1, NaN, Infinity, -Infinity, '40', null, undefined, 10.123, 0.001, 1e20]) {
    await assert.rejects(crear(w, 'g1', gp({ monto: m })), codigo('invalid-argument'));
  }
  assert.equal(w.escrituras, 0);
  assert.equal(montoValido(10.5), 10.5); assert.equal(montoValido(0.1 + 0.2 > 0.3 ? 0.3 : 0.3), 0.3); assert.equal(montoValido(1000000), 1000000);
});

test('FIN1CB-G3 · el cliente NO manda estado, marca de consumo, actor, rol, ledger ni snapshot: cualquier campo extra se rechaza', async () => {
  const w = mundo(); base(w);
  for (const extra of [{ estado: 'aprobado' }, { consumidoEnDepositoId: 'D1' }, { creadoPorUid: 'x' }, { actorRol: 'admin' }, { creadoPorRol: 'admin' }, { cuentaOrigen: 'caja' }, { movimientoId: 'm' }, { ordenSnapshot: {} }, { liquidacionId: 'L' }]) {
    await assert.rejects(crear(w, 'g1', gp(extra)), codigo('invalid-argument'));
  }
  for (const mal of [{ tipo: 'otro' }, { tipo: undefined }, { motorizadoId: '' }, { operacionId: 'corto' }, { nota: 5 }, { nota: 'x'.repeat(1001) }]) {
    await assert.rejects(crear(w, 'g1', gp(mal)), codigo('invalid-argument'));
  }
  await assert.rejects(crear(w, 'g1', null as never), codigo('invalid-argument'));
  assert.equal(w.escrituras, 0);
});

test('FIN1CB-G4 · fecha: futura ⇒ fecha_futura; inexistente o mal formada ⇒ invalid-argument; retroactiva y de hoy ⇒ PASS; sin fecha ⇒ la del servidor', async () => {
  const w = mundo(); base(w);
  await assert.rejects(crear(w, 'g1', gp({ fecha: '2026-05-21' })), codigo('failed-precondition', 'fecha_futura'));
  await assert.rejects(crear(w, 'g1', gp({ fecha: '2027-01-01' })), codigo('failed-precondition', 'fecha_futura'));
  for (const f of ['2026-02-30', '2026-13-01', '20-05-2026', 'ayer', 20260520, '2026-5-20']) await assert.rejects(crear(w, 'g1', gp({ fecha: f })), codigo('invalid-argument'));
  assert.equal(w.escrituras, 0);
  assert.equal((await crear(w, 'g1', gp({ fecha: '2026-05-20' }))).resultado, 'registrado');
  assert.equal((await crear(w, 'g1', gp({ operacionId: OP2, fecha: '2020-01-15' }))).resultado, 'registrado');
  const sin = await crear(w, 'g1', gp({ operacionId: 'op-sinfecha1' }));
  assert.ok(typeof (w.raw(`gastos_motorizado/${sin.gastoId}`).fecha as { __ms: number }).__ms === 'number');
  // 22:00 de Managua del 20 aún es 20 (04:00Z del 21): el día de Managua, no el UTC.
  assert.equal(instanteDeFechaGasto('2026-05-20', new Date('2026-05-21T04:00:00Z')).toISOString(), '2026-05-20T18:00:00.000Z');
  assert.throws(() => instanteDeFechaGasto('2026-05-21', new Date('2026-05-21T04:00:00Z')), codigo('failed-precondition', 'fecha_futura'));
});

test('FIN1CB-G5 · solo admin o gestor ACTIVO; el rol real queda en el gasto y en el ledger', async () => {
  const w = mundo(); base(w);
  await assert.rejects(crear(w, undefined, gp()), codigo('unauthenticated'));
  for (const uid of ['dig', 'mot', 'baja', 'nadie']) await assert.rejects(crear(w, uid, gp()), codigo('permission-denied'));
  assert.equal(w.escrituras, 0);
  const a = await crear(w, 'a1', gp());
  assert.equal(w.raw(`gastos_motorizado/${a.gastoId}`).creadoPorRol, 'admin');
  assert.equal(w.movimientos()[0].data.creadoPorRol, 'admin');
  const g = await crear(w, 'g1', gp({ operacionId: OP2 }));
  assert.equal(w.raw(`gastos_motorizado/${g.gastoId}`).creadoPorRol, 'gestor');
});

test('FIN1CB-G6 · motorizado inexistente ⇒ motorizado_inexistente; orden inexistente, no entregada o de OTRO motorizado ⇒ orden_invalida; el snapshot lo arma el servidor', async () => {
  const w = mundo(); base(w);
  await assert.rejects(crear(w, 'g1', gp({ motorizadoId: 'fantasma' })), codigo('failed-precondition', 'motorizado_inexistente'));
  w.put('solicitudes_envio/o1', { estado: 'entregado', asignacion: { motorizadoId: 'm1' }, ownerSnapshot: { companyName: 'Tienda Sol' }, entrega: { nombreApellido: 'Ana' }, confirmacion: { precioFinalCordobas: 90 }, tipoEnvio: 'normal', puntoRetiroNombre: 'Punto' });
  w.put('solicitudes_envio/o2', { estado: 'en_camino_entrega', asignacion: { motorizadoId: 'm1' } });
  w.put('solicitudes_envio/o3', { estado: 'entregado', asignacion: { motorizadoId: 'otro' } });
  for (const id of ['nadie', 'o2', 'o3']) await assert.rejects(crear(w, 'g1', gp({ ordenId: id })), codigo('failed-precondition', 'orden_invalida'));
  assert.equal(w.escrituras, 0);
  const r = await crear(w, 'g1', gp({ ordenId: 'o1' }));
  const g = w.raw(`gastos_motorizado/${r.gastoId}`) as { ordenId: string; ordenSnapshot: Doc };
  assert.equal(g.ordenId, 'o1');
  assert.deepEqual(g.ordenSnapshot, { ordenId: 'o1', comercioNombre: 'Tienda Sol', clienteNombre: 'Ana', entregadoAt: null, tipoEnvio: 'normal', metodoEnvio: null, puntoLogistico: 'Punto', precioDelivery: 90 });
  assert.equal(w.movimientos()[0].data.solicitudId, 'o1');
});

test('FIN1CB-G7 · idempotencia: el retry idéntico responde ya_registrado SIN escribir; la misma operación con otros datos ⇒ operacion_inconsistente; sin duplicados', async () => {
  const w = mundo(); base(w);
  const a = await crear(w, 'g1', gp({ nota: 'x' }));
  const antes = w.snapshot();
  const b = await crear(w, 'a1', gp({ nota: 'x' }));
  assert.equal(b.resultado, 'ya_registrado'); assert.equal(b.gastoId, a.gastoId); assert.equal(b.movimientoId, a.movimientoId);
  assert.equal(w.snapshot(), antes);
  for (const otro of [{ monto: 41 }, { tipo: 'pago_cargotrans' }, { nota: 'y' }, { fecha: '2026-05-01' }, { motorizadoId: 'm2' }]) {
    await assert.rejects(crear(w, 'g1', gp({ nota: 'x', ...otro })), codigo('failed-precondition', 'operacion_inconsistente'));
  }
  assert.equal(w.gastos().length, 1); assert.equal(w.movimientos().length, 1);
});

test('FIN1CB-G8 · atomicidad: un fallo al escribir el movimiento no deja gasto ni marcador', async () => {
  const w = mundo(); base(w);
  const antes = w.snapshot();
  w.hooks.fallarSi = (_o, ruta) => ruta.startsWith('movimientos_financieros/');
  await assert.rejects(crear(w, 'g1', gp()), /fallo simulado/);
  assert.equal(w.snapshot(), antes);
});

test('FIN1CB-G9 · race: dos gestores crean con la MISMA operación a la vez ⇒ un solo gasto y un solo movimiento', async () => {
  const w = mundo(); base(w);
  const [x, y] = await Promise.allSettled([crear(w, 'g1', gp()), crear(w, 'a1', gp())]);
  assert.equal([x, y].filter((r) => r.status === 'fulfilled').length, 2);
  assert.equal(w.gastos().length, 1); assert.equal(w.movimientos().length, 1);
});

// ═══ GASTOS · ANULAR ═════════════════════════════════════════════════════════

const gastoModerno = (w: Mundo, id = 'g', extra: Doc = {}, conMov: Doc | null = {}) => {
  w.put(`gastos_motorizado/${id}`, { motorizadoId: 'm1', motorizadoNombre: 'Luigi', tipo: 'peaje_terminal', monto: 40, estado: 'aprobado', ...extra });
  if (conMov) w.put(`movimientos_financieros/mv-${id}`, { tipo: 'gasto_aprobado', monto: 40, estado: 'activo', motorizadoId: 'm1', gastoId: id, cuentaOrigen: 'efectivo_en_poder:m1', cuentaDestino: 'gastos_operativos', ...conMov });
};

test('FIN1CB-G10 · anular un gasto NO consumido: gasto y su movimiento coherente quedan anulados (actor y rol reales), sin tocar la marca', async () => {
  const w = mundo(); base(w); gastoModerno(w);
  const r = await anular(w, 'a1', { gastoId: 'g' });
  assert.equal(r.resultado, 'anulado'); assert.equal(r.movimientoId, 'mv-g');
  const g = w.raw('gastos_motorizado/g'); const m = w.raw('movimientos_financieros/mv-g');
  assert.equal(g.estado, 'anulado'); assert.equal(g.anuladoPorUid, 'a1'); assert.equal(g.anuladoPorRol, 'admin'); assert.ok(!('consumidoEnDepositoId' in g));
  assert.equal(m.estado, 'anulado'); assert.equal(m.anuladoPorUid, 'a1'); assert.equal(m.anuladoPorRol, 'admin'); assert.ok(m.motivoAnulacion);
});

test('FIN1CB-G11 · ya anulado ⇒ ya_anulado sin escribir; petición con campos extra o sin permiso se rechaza', async () => {
  const w = mundo(); base(w); gastoModerno(w);
  await anular(w, 'g1', { gastoId: 'g' });
  const antes = w.snapshot();
  const r = await anular(w, 'a1', { gastoId: 'g' });
  assert.equal(r.resultado, 'ya_anulado'); assert.equal(w.snapshot(), antes);
  await assert.rejects(anular(w, 'g1', { gastoId: 'g', motivo: 'x', estado: 'aprobado' }), codigo('invalid-argument'));
  await assert.rejects(anular(w, 'dig', { gastoId: 'g' }), codigo('permission-denied'));
  await assert.rejects(anular(w, undefined, { gastoId: 'g' }), codigo('unauthenticated'));
  await assert.rejects(anular(w, 'g1', { gastoId: 'nada' }), codigo('not-found'));
});

test('FIN1CB-G12 · un gasto CONSUMIDO por un depósito vivo (marca FIN-2) no se anula, en cualquier estado vivo del depósito', async () => {
  for (const estado of ['pendiente_boucher', 'en_revision', 'devuelto', 'confirmado', 'convertido_en_deuda']) {
    const w = mundo(); base(w); gastoModerno(w, 'g', { consumidoEnDepositoId: 'D1' });
    w.put('ordenes_deposito/D1', { tipo: 'recaudacion_motorizado_storkhub', estado, gastosIds: ['g'] });
    const antes = w.snapshot();
    await assert.rejects(anular(w, 'g1', { gastoId: 'g' }), codigo('failed-precondition', 'gasto_consumido'));
    assert.equal(w.snapshot(), antes, estado);
  }
});

test('FIN1CB-G13 · marca y depósito que se contradicen (depósito anulado/rechazado/inexistente/que no lo lista, o dos depósitos vivos) ⇒ conciliacion_requerida', async () => {
  const casos: Array<[string, (w: Mundo) => void]> = [
    ['dep anulado con marca', (w) => w.put('ordenes_deposito/D1', { estado: 'anulado', gastosIds: ['g'] })],
    ['dep rechazado con marca', (w) => w.put('ordenes_deposito/D1', { estado: 'rechazado', gastosIds: ['g'] })],
    ['dep inexistente', () => undefined],
    ['dep que no lo lista', (w) => w.put('ordenes_deposito/D1', { estado: 'confirmado', gastosIds: ['otro'] })],
    ['dos depósitos vivos', (w) => { w.put('ordenes_deposito/D1', { estado: 'confirmado', gastosIds: ['g'] }); w.put('ordenes_deposito/D2', { estado: 'en_revision', gastosIds: ['g'] }); }],
  ];
  for (const [nombre, f] of casos) {
    const w = mundo(); base(w); gastoModerno(w, 'g', { consumidoEnDepositoId: 'D1' }); f(w);
    const antes = w.snapshot();
    await assert.rejects(anular(w, 'g1', { gastoId: 'g' }), codigo('failed-precondition', 'conciliacion_requerida'), nombre);
    assert.equal(w.snapshot(), antes, nombre);
  }
});

test('FIN1CB-G14 · legacy anterior a FIN-2 (SIN marca): un depósito vivo que lo lista en gastosIds bloquea; uno anulado o rechazado no', async () => {
  const w = mundo(); base(w); gastoModerno(w, 'g');
  w.put('ordenes_deposito/D1', { estado: 'confirmado', gastosIds: ['g'] });
  await assert.rejects(anular(w, 'g1', { gastoId: 'g' }), codigo('failed-precondition', 'gasto_consumido'));
  const w2 = mundo(); base(w2); gastoModerno(w2, 'g');
  w2.put('ordenes_deposito/D1', { estado: 'anulado', gastosIds: ['g'] }); w2.put('ordenes_deposito/D2', { estado: 'rechazado', gastosIds: ['g'] });
  assert.equal((await anular(w2, 'g1', { gastoId: 'g' })).resultado, 'anulado');
});

test('FIN1CB-G15 · un gasto que una liquidación capturó (gastosIds, o liquidacionId en el gasto) no se anula', async () => {
  const w = mundo(); base(w); gastoModerno(w, 'g');
  w.put('liquidaciones_motorizado/m1_2026-W19', { motorizadoId: 'm1', semanaKey: '2026-W19', estado: 'pagado', gastosIds: ['g'] });
  await assert.rejects(anular(w, 'g1', { gastoId: 'g' }), codigo('failed-precondition', 'gasto_liquidado'));
  const w2 = mundo(); base(w2); gastoModerno(w2, 'g', { liquidacionId: 'L1' });
  await assert.rejects(anular(w2, 'g1', { gastoId: 'g' }), codigo('failed-precondition', 'gasto_liquidado'));
  assert.equal(w.get('gastos_motorizado/g')!.estado, 'aprobado');
});

test('FIN1CB-G16 · legacy: gasto SIN ningún movimiento (el writer viejo tragaba el error del ledger) ⇒ se anula el gasto sin inventar un movimiento', async () => {
  const w = mundo(); base(w); gastoModerno(w, 'g', {}, null);
  const r = await anular(w, 'g1', { gastoId: 'g' });
  assert.equal(r.resultado, 'anulado'); assert.equal(r.movimientoId, null);
  assert.equal(w.get('gastos_motorizado/g')!.estado, 'anulado'); assert.equal(w.movimientos().length, 0);
});

test('FIN1CB-G17 · ledger incoherente ⇒ conciliacion_requerida y NO se anula a ciegas: varios activos, monto o cuentas distintos, otro tipo, o solo anulados', async () => {
  const casos: Array<[string, (w: Mundo) => void]> = [
    ['dos activos', (w) => { gastoModerno(w); w.put('movimientos_financieros/mv-2', { tipo: 'gasto_aprobado', monto: 40, estado: 'activo', motorizadoId: 'm1', gastoId: 'g', cuentaOrigen: 'efectivo_en_poder:m1', cuentaDestino: 'gastos_operativos' }); }],
    ['monto distinto', (w) => gastoModerno(w, 'g', {}, { monto: 41 })],
    ['cuenta distinta', (w) => gastoModerno(w, 'g', {}, { cuentaDestino: 'banco_storkhub' })],
    ['otro motorizado', (w) => gastoModerno(w, 'g', {}, { motorizadoId: 'm9' })],
    ['otro tipo', (w) => gastoModerno(w, 'g', {}, { tipo: 'gasto_operativo_aprobado' })],
    ['solo anulados', (w) => gastoModerno(w, 'g', {}, { estado: 'anulado' })],
    ['estado desconocido del gasto', (w) => gastoModerno(w, 'g', { estado: 'raro' })],
  ];
  for (const [nombre, f] of casos) {
    const w = mundo(); base(w); f(w);
    const antes = w.snapshot();
    await assert.rejects(anular(w, 'g1', { gastoId: 'g' }), codigo('failed-precondition', 'conciliacion_requerida'), nombre);
    assert.equal(w.snapshot(), antes, nombre);
  }
});

test('FIN1CB-G18 · atomicidad de la anulación y race: consumir vs anular ⇒ una sola realidad económica', async () => {
  const w = mundo(); base(w); gastoModerno(w);
  const antes = w.snapshot();
  w.hooks.fallarSi = (_o, ruta) => ruta.startsWith('movimientos_financieros/');
  await assert.rejects(anular(w, 'g1', { gastoId: 'g' }), /fallo simulado/);
  assert.equal(w.snapshot(), antes);
  w.hooks.fallarSi = undefined;
  // Entre la lectura y el commit, el depósito (batch de captura) consume el gasto.
  w.hooks.antesDeCommit = () => {
    const g = w.raw('gastos_motorizado/g'); g.consumidoEnDepositoId = 'D1'; w.put('gastos_motorizado/g', g);
    w.put('ordenes_deposito/D1', { tipo: 'recaudacion_motorizado_storkhub', estado: 'pendiente_boucher', gastosIds: ['g'] });
    w.bump();
  };
  await assert.rejects(anular(w, 'g1', { gastoId: 'g' }), codigo('failed-precondition', 'gasto_consumido'));
  assert.equal(w.get('gastos_motorizado/g')!.estado, 'aprobado'); assert.equal(w.get('movimientos_financieros/mv-g')!.estado, 'activo');
});

// ═══ ADELANTOS ═══════════════════════════════════════════════════════════════

test('FIN1CB-A1 · registrar un adelanto válido: UN movimiento adelanto_motorizado (caja → deuda_motorizado) con propietario, semana, actor y rol reales', async () => {
  const w = mundo(); base(w);
  const r = await registrar(w, 'g1', ap({ nota: ' semana 20 ' }));
  assert.equal(r.resultado, 'registrado');
  const m = w.raw(`movimientos_financieros/${r.adelantoId}`) as Record<string, unknown>;
  assert.equal(m.tipo, 'adelanto_motorizado'); assert.equal(m.monto, 100); assert.equal(m.estado, 'activo'); assert.equal(m.motorizadoId, 'm1'); assert.equal(m.semanaKey, SEMANA);
  assert.equal(m.cuentaOrigen, 'caja_storkhub'); assert.equal(m.cuentaDestino, 'deuda_motorizado:m1'); assert.equal(m.propietario, 'motorizado:m1');
  assert.equal(m.creadoPorUid, 'g1'); assert.equal(m.creadoPorRol, 'gestor');
  assert.deepEqual(m.metadata, { operacionId: OP, nota: 'semana 20' });
  assert.equal(w.movimientos().length, 1); assert.equal(w.operaciones().length, 1);
});

test('FIN1CB-A2 · monto inválido, semana inválida y campos extra (tipo, cuentas, actor, estado) se rechazan sin escribir', async () => {
  const w = mundo(); base(w);
  for (const m of [0, -5, NaN, Infinity, '100', 1.234]) await assert.rejects(registrar(w, 'g1', ap({ monto: m })), codigo('invalid-argument'));
  for (const s of ['2026-W00', '2026-W54', '2026W20', 'semana', '26-W20', null, 202620]) await assert.rejects(registrar(w, 'g1', ap({ semanaKey: s })), codigo('invalid-argument'));
  for (const extra of [{ tipo: 'otro' }, { cuentaOrigen: 'x' }, { propietario: 'x' }, { creadoPorUid: 'x' }, { creadoPorRol: 'admin' }, { estado: 'activo' }]) await assert.rejects(registrar(w, 'g1', ap(extra)), codigo('invalid-argument'));
  assert.equal(w.escrituras, 0);
});

test('FIN1CB-A3 · solo admin o gestor ACTIVO (rol real en el movimiento); motorizado inexistente ⇒ motorizado_inexistente; cualquier motorizado existente es válido', async () => {
  const w = mundo(); base(w); w.put('motorizado/m2', { nombre: 'Otro' });
  await assert.rejects(registrar(w, undefined, ap()), codigo('unauthenticated'));
  for (const uid of ['dig', 'mot', 'baja', 'nadie']) await assert.rejects(registrar(w, uid, ap()), codigo('permission-denied'));
  await assert.rejects(registrar(w, 'g1', ap({ motorizadoId: 'fantasma' })), codigo('failed-precondition', 'motorizado_inexistente'));
  assert.equal(w.escrituras, 0);
  const a = await registrar(w, 'a1', ap());
  assert.equal(w.raw(`movimientos_financieros/${a.adelantoId}`).creadoPorRol, 'admin');
  const b = await registrar(w, 'g1', ap({ operacionId: OP2, motorizadoId: 'm2' }));
  assert.equal(w.raw(`movimientos_financieros/${b.adelantoId}`).motorizadoId, 'm2');
});

test('FIN1CB-A4 · idempotencia: el retry idéntico ⇒ ya_registrado SIN escribir; la misma operación con otros datos ⇒ operacion_inconsistente; sin duplicados', async () => {
  const w = mundo(); base(w);
  const a = await registrar(w, 'g1', ap());
  const antes = w.snapshot();
  const b = await registrar(w, 'a1', ap());
  assert.equal(b.resultado, 'ya_registrado'); assert.equal(b.adelantoId, a.adelantoId); assert.equal(w.snapshot(), antes);
  for (const otro of [{ monto: 101 }, { semanaKey: '2026-W19' }, { motorizadoId: 'm9' }, { nota: 'otra' }]) {
    await assert.rejects(registrar(w, 'g1', ap(otro)), codigo('failed-precondition', 'operacion_inconsistente'));
  }
  assert.equal(w.movimientos().length, 1);
});

test('FIN1CB-A5 · una semana con liquidación (pendiente O pagada, por id determinista o legacy de id aleatorio, por motorizadoId o por motorizadoUid) bloquea el adelanto', async () => {
  const casos: Array<[string, Doc, string]> = [
    ['id determinista pagada', { _id: `m1_${SEMANA}`, estado: 'pagado' }, SEMANA],
    ['id determinista pendiente', { _id: `m1_${SEMANA}`, estado: 'pendiente' }, SEMANA],
    ['legacy aleatoria por motorizadoId', { _id: 'ABC123', motorizadoId: 'm1', semanaKey: SEMANA, estado: 'pendiente' }, SEMANA],
    ['legacy aleatoria por motorizadoUid', { _id: 'XYZ789', motorizadoUid: 'mauth1', semanaKey: SEMANA, estado: 'pagado' }, SEMANA],
    ['semana de ahora aunque el adelanto declare otra', { _id: 'LLL', motorizadoId: 'm1', semanaKey: SEMANA, estado: 'pagado' }, '2026-W10'],
  ];
  for (const [nombre, liq, semana] of casos) {
    const w = mundo(); base(w);
    const { _id, ...resto } = liq; w.put(`liquidaciones_motorizado/${String(_id)}`, resto);
    const antes = w.snapshot();
    await assert.rejects(registrar(w, 'g1', ap({ semanaKey: semana })), codigo('failed-precondition', 'semana_liquidada'), nombre);
    assert.equal(w.snapshot(), antes, nombre);
  }
  // Otra semana, otro motorizado: no bloquea.
  const w2 = mundo(); base(w2); w2.put('motorizado/m2', { nombre: 'Otro' });
  w2.put('liquidaciones_motorizado/m1_2026-W05', { motorizadoId: 'm1', semanaKey: '2026-W05', estado: 'pagado' });
  w2.put(`liquidaciones_motorizado/m2_${SEMANA}`, { motorizadoId: 'm2', semanaKey: SEMANA, estado: 'pagado' });
  assert.equal((await registrar(w2, 'g1', ap({ semanaKey: '2026-W06' }))).resultado, 'registrado');
});

test('FIN1CB-A6 · race: una liquidación aparece entre la lectura y el commit ⇒ el reintento ve semana_liquidada y no escribe', async () => {
  const w = mundo(); base(w);
  w.hooks.antesDeCommit = () => { w.put(`liquidaciones_motorizado/m1_${SEMANA}`, { motorizadoId: 'm1', semanaKey: SEMANA, estado: 'pendiente' }); w.bump(); };
  await assert.rejects(registrar(w, 'g1', ap()), codigo('failed-precondition', 'semana_liquidada'));
  assert.equal(w.movimientos().length, 0); assert.equal(w.operaciones().length, 0);
});

const adelantoModerno = (w: Mundo, id = 'ad', extra: Doc = {}) => w.put(`movimientos_financieros/${id}`, {
  tipo: 'adelanto_motorizado', monto: 100, estado: 'activo', motorizadoId: 'm1', semanaKey: SEMANA, cuentaOrigen: 'caja_storkhub', cuentaDestino: 'deuda_motorizado:m1',
  propietario: 'motorizado:m1', at: TS(AHORA.getTime()), ...extra,
});

test('FIN1CB-A7 · anular un adelanto válido: el mismo movimiento queda anulado (actor y rol reales); ya anulado ⇒ ya_anulado sin escribir; nunca se reactiva', async () => {
  const w = mundo(); base(w); adelantoModerno(w);
  const r = await anularAd(w, 'a1', { adelantoId: 'ad' });
  assert.equal(r.resultado, 'anulado');
  const m = w.raw('movimientos_financieros/ad');
  assert.equal(m.estado, 'anulado'); assert.equal(m.anuladoPorUid, 'a1'); assert.equal(m.anuladoPorRol, 'admin'); assert.ok(m.motivoAnulacion);
  const antes = w.snapshot();
  assert.equal((await anularAd(w, 'g1', { adelantoId: 'ad' })).resultado, 'ya_anulado');
  assert.equal(w.snapshot(), antes);
  await assert.rejects(anularAd(w, 'g1', { adelantoId: 'ad', estado: 'activo' }), codigo('invalid-argument'));
  await assert.rejects(anularAd(w, 'dig', { adelantoId: 'ad' }), codigo('permission-denied'));
  await assert.rejects(anularAd(w, 'g1', { adelantoId: 'nada' }), codigo('not-found'));
});

test('FIN1CB-A8 · el id solo no basta: un movimiento que no es adelanto ⇒ movimiento_invalido; uno incoherente (cuentas, monto, motorizado) o de estado raro ⇒ conciliacion_requerida', async () => {
  const w = mundo(); base(w);
  w.put('movimientos_financieros/otro', { tipo: 'pago_recibido', estado: 'activo', monto: 10 });
  await assert.rejects(anularAd(w, 'g1', { adelantoId: 'otro' }), codigo('failed-precondition', 'movimiento_invalido'));
  const malos: Array<[string, Doc]> = [
    ['cuentas', { cuentaDestino: 'banco_storkhub' }], ['origen', { cuentaOrigen: 'efectivo_en_poder:m1' }], ['monto', { monto: 0 }], ['monto texto', { monto: '100' }],
    ['sin motorizado', { motorizadoId: '' }], ['deuda de otro', { motorizadoId: 'm9' }], ['estado raro', { estado: 'raro' }],
  ];
  for (const [n, extra] of malos) {
    const w2 = mundo(); base(w2); adelantoModerno(w2, 'ad', extra);
    const antes = w2.snapshot();
    await assert.rejects(anularAd(w2, 'g1', { adelantoId: 'ad' }), codigo('failed-precondition', 'conciliacion_requerida'), n);
    assert.equal(w2.snapshot(), antes, n);
  }
});

test('FIN1CB-A9 · anular en una semana liquidada ⇒ semana_liquidada (por la semana declarada O por la del movimiento; id determinista o legacy); race con la liquidación', async () => {
  const w = mundo(); base(w); adelantoModerno(w);
  w.put(`liquidaciones_motorizado/m1_${SEMANA}`, { motorizadoId: 'm1', semanaKey: SEMANA, estado: 'pagado' });
  await assert.rejects(anularAd(w, 'g1', { adelantoId: 'ad' }), codigo('failed-precondition', 'semana_liquidada'));
  assert.equal(w.get('movimientos_financieros/ad')!.estado, 'activo');
  const w2 = mundo(); base(w2); adelantoModerno(w2, 'ad', { semanaKey: '2026-W03' }); // declara W03 pero cayó en la semana actual
  w2.put('liquidaciones_motorizado/RANDOM1', { motorizadoId: 'm1', semanaKey: SEMANA, estado: 'pendiente' });
  await assert.rejects(anularAd(w2, 'g1', { adelantoId: 'ad' }), codigo('failed-precondition', 'semana_liquidada'));
  const w3 = mundo(); base(w3); adelantoModerno(w3);
  w3.hooks.antesDeCommit = () => { w3.put(`liquidaciones_motorizado/m1_${SEMANA}`, { motorizadoId: 'm1', semanaKey: SEMANA, estado: 'pendiente' }); w3.bump(); };
  await assert.rejects(anularAd(w3, 'g1', { adelantoId: 'ad' }), codigo('failed-precondition', 'semana_liquidada'));
  assert.equal(w3.get('movimientos_financieros/ad')!.estado, 'activo');
});

test('FIN1CB-A10 · los adelantos históricos y FIN-1A no se tocan: un saldo de tipo adelanto no interviene y no se crea ningún saldo ni liquidación', async () => {
  const w = mundo(); base(w);
  w.put('saldos_cargo_motorizado/s1', { tipo: 'adelanto', estado: 'pendiente', saldoPendiente: 50 });
  await registrar(w, 'g1', ap());
  assert.deepEqual(w.raw('saldos_cargo_motorizado/s1'), { tipo: 'adelanto', estado: 'pendiente', saldoPendiente: 50 });
  const src = readFileSync(join(__dirname, '..', '..', 'src', 'adelantos.ts'), 'utf8');
  assert.ok(!/saldos_cargo_motorizado/.test(src), 'los adelantos no escriben saldos');
});

// ═══ RESOLUCIÓN DE INCIDENCIAS ═══════════════════════════════════════════════

const ordenIncidencia = (w: Mundo, id = 'r', extra: Doc = {}) => w.put(`solicitudes_envio/${id}`, {
  estado: 'entregado', tipoCliente: 'contado', pagoDelivery: { quienPaga: 'entrega' }, confirmacion: { precioFinalCordobas: 100 }, cobroPendiente: true,
  cobrosMotorizado: { delivery: { recibio: false, monto: 100 } }, cobroDelivery: { monto: 100, tipoCliente: 'contado', quienPaga: 'entrega', estado: 'pendiente' }, ...extra,
});
const rp = (extra: Doc = {}) => ({ ordenId: 'r', item: 'delivery', decision: 'cliente_pagara', ...extra });
const raizOrden = (w: Mundo, id = 'r') => w.raw(`solicitudes_envio/${id}`) as { cobroDelivery: Doc; cobrosMotorizado: { resolucion?: Doc; producto?: { resolucion?: Doc; estado?: string } }; cobroPendiente: boolean };

test('FIN1CB-R1 · delivery cliente_pagara: queda pendiente (no cobrado), con la resolución del servidor (actor y fecha), sin tocar el monto; cobroPendiente se recalcula', async () => {
  const w = mundo(); base(w); ordenIncidencia(w);
  const r = await resolver(w, 'g1', rp({ nota: ' llamar el lunes ' }));
  assert.equal(r.resultado, 'resuelto'); assert.equal(r.cobroPendiente, false);
  const o = raizOrden(w);
  assert.equal(o.cobroDelivery.estado, 'pendiente'); assert.equal(o.cobroDelivery.monto, 100);
  assert.deepEqual(o.cobrosMotorizado.resolucion, { resueltoPor: 'g1', at: { __ms: 1 }, nota: 'llamar el lunes', tipo: 'cliente_pagara' });
  assert.equal(o.cobroPendiente, false);
});

test('FIN1CB-R2 · delivery se_pierde: cobroDelivery.estado = no_cobrar (la condonación de siempre), sin saldo, deuda ni movimiento', async () => {
  const w = mundo(); base(w); ordenIncidencia(w);
  await resolver(w, 'a1', rp({ decision: 'se_pierde' }));
  const o = raizOrden(w);
  assert.equal(o.cobroDelivery.estado, 'no_cobrar'); assert.equal(o.cobroDelivery.monto, 100); assert.equal(o.cobrosMotorizado.resolucion!.tipo, 'se_pierde'); assert.equal(o.cobrosMotorizado.resolucion!.resueltoPor, 'a1');
  assert.equal(w.movimientos().length, 0);
});

test('FIN1CB-R3 · producto: solo la clasificación del producto (resolucion + estado); NO toca cobroDelivery ni el ledger; cobroPendiente por el otro ítem', async () => {
  for (const [decision, estado] of [['cliente_pagara', 'pendiente'], ['se_pierde', 'no_cobrar']] as const) {
    const w = mundo(); base(w);
    ordenIncidencia(w, 'r', { pagoDelivery: { quienPaga: 'entrega', deducirDelCobroContraEntrega: true }, cobrosMotorizado: { delivery: { recibio: false }, producto: { recibio: false, monto: 60 } } });
    const antesCd = JSON.stringify(raizOrden(w).cobroDelivery);
    const r = await resolver(w, 'g1', rp({ item: 'producto', decision }));
    const o = raizOrden(w);
    assert.equal(o.cobrosMotorizado.producto!.estado, estado); assert.equal(o.cobrosMotorizado.producto!.resolucion!.tipo, decision); assert.equal(o.cobrosMotorizado.producto!.resolucion!.resueltoPor, 'g1');
    assert.equal(JSON.stringify(o.cobroDelivery), antesCd, 'el cobro del delivery no se toca');
    assert.ok(!o.cobrosMotorizado.resolucion, 'la resolución a nivel orden es del delivery');
    assert.equal(r.cobroPendiente, false, 'con delivery deducido el delivery nunca es incidencia propia');
    assert.equal(w.movimientos().length, 0);
  }
  // Sin deducción y con las dos incidencias abiertas: resolver una deja cobroPendiente en true.
  const w = mundo(); base(w);
  ordenIncidencia(w, 'r', { cobrosMotorizado: { delivery: { recibio: false }, producto: { recibio: false, monto: 60 } } });
  assert.equal((await resolver(w, 'g1', rp({ item: 'producto' }))).cobroPendiente, true);
  assert.equal(raizOrden(w).cobroPendiente, true);
  assert.equal((await resolver(w, 'g1', rp({ item: 'delivery' }))).cobroPendiente, false);
  assert.equal(raizOrden(w).cobroPendiente, false);
});

test('FIN1CB-R4 · cliente_pagara sobre una orden SIN cobroDelivery lo crea pendiente (sin monto: lo fija registrarCobroDelivery); sobre no_cobrar lo devuelve a pendiente', async () => {
  const w = mundo(); base(w); ordenIncidencia(w); const o0 = w.raw('solicitudes_envio/r'); delete o0.cobroDelivery; w.put('solicitudes_envio/r', o0);
  await resolver(w, 'g1', rp());
  const o = raizOrden(w);
  assert.equal(o.cobroDelivery.estado, 'pendiente'); assert.ok(o.cobroDelivery.registradoAt); assert.ok(!('monto' in o.cobroDelivery));
  const w2 = mundo(); base(w2); ordenIncidencia(w2, 'r', { cobroDelivery: { monto: 100, estado: 'no_cobrar' } });
  await resolver(w2, 'g1', rp());
  assert.equal(raizOrden(w2).cobroDelivery.estado, 'pendiente');
});

test('FIN1CB-R5 · el cliente NO manda actor, fecha, estado final, monto ni cobroPendiente; campos extra o inválidos se rechazan', async () => {
  const w = mundo(); base(w); ordenIncidencia(w);
  for (const extra of [{ resueltoPor: 'x' }, { at: 1 }, { estado: 'pagado' }, { monto: 1 }, { cobroPendiente: false }, { precioFinalCordobas: 1 }, { actorUid: 'x' }]) await assert.rejects(resolver(w, 'g1', rp(extra)), codigo('invalid-argument'));
  for (const mal of [{ item: 'otro' }, { decision: 'condonar' }, { ordenId: '' }, { nota: 3 }, { nota: 'x'.repeat(1001) }]) await assert.rejects(resolver(w, 'g1', rp(mal)), codigo('invalid-argument'));
  await assert.rejects(resolver(w, undefined, rp()), codigo('unauthenticated'));
  for (const uid of ['dig', 'mot', 'baja', 'nadie']) await assert.rejects(resolver(w, uid, rp()), codigo('permission-denied'));
  assert.equal(w.escrituras, 0);
});

test('FIN1CB-R6 · nunca toca monto, precio, movimientos, depósitos ni saldos: solo escribe resolución, cobroDelivery.estado/registradoAt, cobroPendiente y updatedAt', async () => {
  const w = mundo(); base(w); ordenIncidencia(w);
  w.put('ordenes_deposito/D', { x: 1 }); w.put('movimientos_financieros/M', { y: 1 }); w.put('saldos_cargo_motorizado/S', { z: 1 });
  const antes = JSON.stringify(['ordenes_deposito/D', 'movimientos_financieros/M', 'saldos_cargo_motorizado/S'].map((r) => w.raw(r)));
  const o0 = raizOrden(w) as unknown as Doc;
  await resolver(w, 'g1', rp({ decision: 'se_pierde' }));
  const o1 = raizOrden(w) as unknown as Doc;
  assert.deepEqual((o1.confirmacion), (o0.confirmacion)); assert.equal((o1.cobroDelivery as Doc).monto, (o0.cobroDelivery as Doc).monto);
  assert.equal(JSON.stringify(['ordenes_deposito/D', 'movimientos_financieros/M', 'saldos_cargo_motorizado/S'].map((r) => w.raw(r))), antes);
});

test('FIN1CB-R7 · cobro pagado ⇒ cobro_ya_pagado (delivery); en revisión de depósito no se pierde; estado de cobro desconocido o ítem no abierto ⇒ conciliacion / incidencia_no_abierta; orden no entregada ⇒ orden_no_entregada', async () => {
  const w = mundo(); base(w); ordenIncidencia(w, 'r', { cobroDelivery: { monto: 100, estado: 'pagado' } });
  await assert.rejects(resolver(w, 'g1', rp()), codigo('failed-precondition', 'cobro_ya_pagado'));
  await assert.rejects(resolver(w, 'g1', rp({ decision: 'se_pierde' })), codigo('failed-precondition', 'cobro_ya_pagado'));
  const w2 = mundo(); base(w2); ordenIncidencia(w2, 'r', { cobroDelivery: { monto: 100, estado: 'en_revision_deposito' } });
  await assert.rejects(resolver(w2, 'g1', rp({ decision: 'se_pierde' })), codigo('failed-precondition', 'estado_incompatible'));
  assert.equal((await resolver(w2, 'g1', rp())).resultado, 'resuelto');
  const w3 = mundo(); base(w3); ordenIncidencia(w3, 'r', { cobroDelivery: { monto: 100, estado: 'raro' } });
  await assert.rejects(resolver(w3, 'g1', rp()), codigo('failed-precondition', 'conciliacion_requerida'));
  const w4 = mundo(); base(w4); ordenIncidencia(w4, 'r', { cobrosMotorizado: { delivery: { recibio: true } }, cobroPendiente: false });
  await assert.rejects(resolver(w4, 'g1', rp()), codigo('failed-precondition', 'incidencia_no_abierta'));
  await assert.rejects(resolver(w4, 'g1', rp({ item: 'producto' })), codigo('failed-precondition', 'incidencia_no_abierta'));
  const w5 = mundo(); base(w5); ordenIncidencia(w5, 'r', { estado: 'en_camino_entrega' });
  await assert.rejects(resolver(w5, 'g1', rp()), codigo('failed-precondition', 'orden_no_entregada'));
  await assert.rejects(resolver(w5, 'g1', rp({ ordenId: 'nada' })), codigo('not-found'));
});

test('FIN1CB-R8 · sin reapertura: un ítem ya resuelto no se puede "deshacer" ni cambiar de decisión; el retry de la MISMA decisión es idempotente (ya_resuelto, 0 writes)', async () => {
  const w = mundo(); base(w); ordenIncidencia(w);
  await resolver(w, 'g1', rp({ decision: 'se_pierde' }));
  const antes = w.snapshot();
  const otra = await resolver(w, 'a1', rp({ decision: 'se_pierde' }));
  assert.equal(otra.resultado, 'ya_resuelto'); assert.equal(w.snapshot(), antes);
  await assert.rejects(resolver(w, 'g1', rp({ decision: 'cliente_pagara' })), codigo('failed-precondition', 'incidencia_no_abierta'));
  assert.equal(raizOrden(w).cobroDelivery.estado, 'no_cobrar', 'la condonación no se deshace desde aquí');
  assert.equal(w.snapshot(), antes);
});

test('FIN1CB-R9 · race: el cobro gana entre la lectura y el commit ⇒ el reintento rechaza por cobro pagado; sin estado mixto', async () => {
  const w = mundo(); base(w); ordenIncidencia(w);
  w.hooks.antesDeCommit = () => { const o = w.raw('solicitudes_envio/r') as { cobroDelivery: Doc }; o.cobroDelivery.estado = 'pagado'; w.put('solicitudes_envio/r', o); w.bump(); };
  await assert.rejects(resolver(w, 'g1', rp({ decision: 'se_pierde' })), codigo('failed-precondition', 'cobro_ya_pagado'));
  const o = raizOrden(w);
  assert.equal(o.cobroDelivery.estado, 'pagado'); assert.ok(!o.cobrosMotorizado.resolucion, 'no quedó una resolución a medias');
});

// ═══ CONTRATO ════════════════════════════════════════════════════════════════

test('FIN1CB-K1 · las callables nuevas están exportadas y los núcleos no aceptan actor ni rol del cliente', () => {
  const idx = readFileSync(join(__dirname, '..', '..', 'src', 'index.ts'), 'utf8');
  for (const n of ['crearGastoMotorizado', 'anularGastoMotorizado', 'registrarAdelantoMotorizado', 'anularAdelantoMotorizado', 'resolverIncidenciaCobro']) assert.ok(idx.includes(n), n);
  const comun = readFileSync(join(__dirname, '..', '..', 'src', 'finanzas-operativas-comun.ts'), 'utf8');
  for (const campo of ["'actorUid'", "'actorRol'", "'creadoPorUid'", "'creadoPorRol'", "'estado'"]) {
    assert.ok(!new RegExp(`soloClaves\\([^)]*${campo}`).test(comun), `${campo} no es un campo aceptado`);
  }
});
