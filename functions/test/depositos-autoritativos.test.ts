// FIN-1B — rehacerDepositoCore y anularDepositoCore: Rehacer y Anular AUTORITATIVOS.
//
// El "mundo" simula lo que importa de Firestore (transacciones optimistas con reintento, escrituras todo-o-nada, create()/update(),
// campos con punto y FieldValue.delete()), como en saldos-deuda-autoritativos.test.ts. La prueba con el emulador real vive en el runtime.
import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { DocumentData } from 'firebase-admin/firestore';
import { rehacerDepositoCore, type DepsRehacer } from '../src/rehacer-deposito';
import { anularDepositoCore, type DepsAnularDeposito } from '../src/anular-deposito';
import { validarPeticionAnular, validarPeticionRehacer } from '../src/deposito-acciones-comun';

type Doc = Record<string, unknown>;
const TS = (n: number) => ({ __ms: n });
const ELIMINAR = { __eliminar: true };
const codigo = (code: string, motivo?: string) => (e: unknown) => {
  const err = e as { code?: string; details?: { motivo?: string } };
  return err.code === code && (motivo === undefined || err.details?.motivo === motivo);
};

/** Los timestamps del mundo se guardan como { __ms } y salen como un Timestamp (toMillis). */
function revivir(v: unknown): unknown {
  if (Array.isArray(v)) return v.map(revivir);
  if (v && typeof v === 'object') {
    const o = v as Record<string, unknown>;
    if (typeof o.__ms === 'number') { const ms = o.__ms; return { __ms: ms, toMillis: () => ms }; }
    return Object.fromEntries(Object.entries(o).map(([k, x]) => [k, revivir(x)]));
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
    const ultimo = partes[partes.length - 1];
    if (v && typeof v === 'object' && (v as Doc).__eliminar === true) delete cur[ultimo];
    else cur[ultimo] = structuredClone(v);
  }
  return copia;
}

function mundo() {
  let store = new Map<string, Doc>();
  let revision = 0;
  let relojes = 0;
  let escrituras = 0;
  let eventoSeq = 0;
  const hooks: { antesDeCommit?: () => void; fallarSi?: (op: string, ruta: string) => boolean } = {};
  const clonar = (m: Map<string, Doc>) => new Map([...m].map(([k, v]) => [k, structuredClone(v)]));
  const put = (ruta: string, d: Doc) => { store.set(ruta, d); };
  const get = (ruta: string) => { const d = store.get(ruta); return d ? (revivir(structuredClone(d)) as DocumentData) : null; };
  const raw = (ruta: string) => structuredClone(store.get(ruta)) as Doc;
  const filtrar = (prefijo: string, pred: (d: Doc) => boolean) => [...store]
    .filter(([r, d]) => r.startsWith(prefijo) && !r.slice(prefijo.length).includes('/') && pred(d))
    .map(([r, d]) => ({ id: r.split('/').pop() as string, data: revivir(structuredClone(d)) as DocumentData }));

  async function correr<T>(fn: (tx: never) => Promise<T>): Promise<T> {
    for (;;) {
      const inicio = revision;
      const cola: Array<{ op: string; ruta: string; datos: Doc }> = [];
      const q = (op: string, ruta: string, datos: Doc) => { cola.push({ op, ruta, datos }); };
      const tx = {
        async getUsuario(uid: string) { return get(`usuarios/${uid}`); },
        async getDeposito(id: string) { return get(`ordenes_deposito/${id}`); },
        async getSolicitud(id: string) { return get(`solicitudes_envio/${id}`); },
        async getGasto(id: string) { return get(`gastos_motorizado/${id}`); },
        async getOperacion(id: string) { return get(`operaciones_deposito/${id}`); },
        async getMotorizadoDocId(authUid: string) { return filtrar('motorizado/', (d) => d.authUid === authUid)[0]?.id ?? null; },
        async getMovimientosDeDeposito(id: string) { return filtrar('movimientos_financieros/', (d) => d.depositoId === id); },
        async getSaldosDeDeposito(id: string) { return filtrar('saldos_cargo_motorizado/', (d) => d.depositoId === id); },
        async getLiquidacionesDelMotorizado(uid: string, docId: string) { return filtrar('liquidaciones_motorizado/', (d) => d.motorizadoUid === uid || d.motorizadoId === docId); },
        updateDeposito(id: string, c: Doc) { q('update', `ordenes_deposito/${id}`, c); },
        crearEvento(dep: string, id: string, c: Doc) { q('create', `ordenes_deposito/${dep}/eventos/${id}`, c); },
        updateSolicitud(id: string, c: Doc) { q('update', `solicitudes_envio/${id}`, c); },
        updateMovimiento(id: string, c: Doc) { q('update', `movimientos_financieros/${id}`, c); },
        updateGasto(id: string, c: Doc) { q('update', `gastos_motorizado/${id}`, c); },
        crearOperacion(id: string, c: Doc) { q('create', `operaciones_deposito/${id}`, c); },
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
          copia.set(w.ruta, aplicarCampos(actual, w.datos));
        }
      }
      store = copia;
      if (cola.length) { revision++; escrituras += cola.length; }
      return resultado;
    }
  }
  const depsReh: DepsRehacer = { transaction: correr as DepsRehacer['transaction'], serverTimestamp: () => TS(++relojes) };
  const depsAnu: DepsAnularDeposito = {
    transaction: correr as DepsAnularDeposito['transaction'],
    serverTimestamp: () => TS(++relojes),
    eliminar: () => ELIMINAR,
    nuevoEventoId: () => `ev${++eventoSeq}`,
  };
  return {
    depsReh, depsAnu, hooks, put, get, raw, bump: () => { revision++; },
    get escrituras() { return escrituras; },
    snapshot: () => JSON.stringify([...store].sort(([a], [b]) => a.localeCompare(b))),
    eventos: (dep: string) => filtrar(`ordenes_deposito/${dep}/eventos/`, () => true),
    movimientos: () => filtrar('movimientos_financieros/', () => true),
  };
}
type Mundo = ReturnType<typeof mundo>;

const MOT_UID = 'motUid';
const MOT = 'mot1';
const MOTIVO = 'Se registró el comprobante equivocado';
const OP = 'op-12345678';

function usuarios(w: Mundo) {
  w.put('usuarios/a1', { activo: true, rol: 'admin' });
  w.put('usuarios/g1', { activo: true, rol: 'gestor' });
  w.put('usuarios/dig', { activo: true, rol: 'digitador' });
  w.put('usuarios/baja', { activo: false, rol: 'admin' });
  w.put('motorizado/mot1', { authUid: MOT_UID, nombre: 'Luigi' });
}

const BOUCHER = { url: 'https://e/b.jpg', pathStorage: `depositos/${MOT_UID}/D1/boucher.jpg` };
const SEMANA = { ini: 1_000_000, fin: 2_000_000, creado: 1_500_000 };

interface Opciones {
  clase?: 'storkhub' | 'comercio';
  estado?: string;
  boucher?: boolean;
  dep?: Doc;
  sinMov?: boolean;
  mov?: Doc;
  movExtra?: Array<[string, Doc]>;
  ordenes?: Doc[];
  gasto?: Doc | null;
}

/** Un depósito coherente (FIN-3): en el estado pedido, con su movimiento originario (si está confirmado), órdenes y gastos. */
function sembrar(w: Mundo, o: Opciones = {}) {
  usuarios(w);
  const clase = o.clase ?? 'storkhub';
  const estado = o.estado ?? 'confirmado';
  const storkhub = clase === 'storkhub';
  w.put('ordenes_deposito/D1', {
    tipo: storkhub ? 'recaudacion_motorizado_storkhub' : 'recaudacion_motorizado_comercio',
    estado,
    destinatario: storkhub ? 'storkhub' : 'comercio',
    destinatarioId: storkhub ? 'storkhub' : 'com9',
    motorizadoUid: MOT_UID,
    solicitudIds: ['o1', 'o2'],
    montoTotal: storkhub ? 90 : 100,
    montoBruto: 100,
    gastosDescontados: storkhub ? 10 : 0,
    gastosIds: storkhub ? ['g1'] : [],
    creadoAt: TS(SEMANA.creado),
    confirmadoPorUid: 'g1',
    confirmadoAt: TS(5),
    ...(o.boucher === false ? {} : { boucher: BOUCHER }),
    ...o.dep,
  });
  const k = storkhub ? { id: 'storkhubDepositoId', c: 'confirmadoStorkhub', at: 'confirmadoStorkhubAt' } : { id: 'comercioDepositoId', c: 'confirmadoComercio', at: 'confirmadoComercioAt' };
  const confirmado = estado === 'confirmado';
  const ordenes = o.ordenes ?? [{}, {}];
  ordenes.forEach((extra, i) => {
    w.put(`solicitudes_envio/o${i + 1}`, {
      estado: 'entregado',
      cobroDelivery: { estado: 'pagado', formaPago: 'efectivo' },
      registro: { deposito: { [k.id]: 'D1', [k.c]: confirmado, [k.at]: confirmado ? TS(5) : null, ...(storkhub ? { comercioDepositoId: 'DC9' } : { storkhubDepositoId: 'DS9' }) } },
      ...extra,
    });
  });
  if (storkhub && o.gasto !== null) w.put('gastos_motorizado/g1', { estado: 'aprobado', monto: 10, motorizadoId: MOT, consumidoEnDepositoId: 'D1', ...o.gasto });
  if (confirmado && !o.sinMov) {
    w.put('movimientos_financieros/conf_ev9', storkhub
      ? { tipo: 'deposito_efectivo_storkhub', monto: 90, estado: 'activo', depositoId: 'D1', motorizadoId: MOT, cuentaOrigen: `efectivo_en_poder:${MOT}`, cuentaDestino: 'banco_storkhub', propietario: 'storkhub', ...o.mov }
      : { tipo: 'deposito_efectivo_comercio', monto: 100, estado: 'activo', depositoId: 'D1', motorizadoId: MOT, comercioId: 'com9', cuentaOrigen: `efectivo_en_poder:${MOT}`, cuentaDestino: 'saldo_comercio:com9', propietario: 'comercio:com9', ...o.mov });
  }
  for (const [r, d] of o.movExtra ?? []) w.put(r, d);
}

const rehacer = (w: Mundo, uid: string | undefined = 'a1', data: unknown = { depositoId: 'D1', motivo: MOTIVO, operacionId: OP }) => rehacerDepositoCore(w.depsReh, uid, data);
const anular = (w: Mundo, uid: string | undefined = 'a1', data: unknown = { depositoId: 'D1', motivo: MOTIVO }) => anularDepositoCore(w.depsAnu, uid, data);
const sinEfectos = async (w: Mundo, p: Promise<unknown>, esperado: (e: unknown) => boolean) => {
  const antes = w.snapshot(); const e0 = w.escrituras;
  await assert.rejects(p, esperado);
  assert.equal(w.snapshot(), antes, 'el estado no cambió');
  assert.equal(w.escrituras, e0, '0 escrituras');
};
const liquidacion = (extra: Doc = {}): [string, Doc] => ['liquidaciones_motorizado/L1', { motorizadoUid: MOT_UID, motorizadoId: MOT, estado: 'pendiente', semanaInicio: TS(SEMANA.ini), semanaFin: TS(SEMANA.fin), depositosIds: [], ...extra }];

// ═══ REHACER ════════════════════════════════════════════════════════════

test('FIN1B-R1 · confirmado Storkhub CON boucher ⇒ en_revision: ledger anulado, puntero conservado y confirmación retirada, gasto intacto, un evento', async () => {
  const w = mundo(); sembrar(w);
  const gastoAntes = JSON.stringify(w.get('gastos_motorizado/g1'));
  const r = await rehacer(w);
  assert.deepEqual({ ...r }, { ok: true, resultado: 'rehecho', depositoId: 'D1', estadoDestino: 'en_revision', eventoId: `rehecho_${OP}`, movimientoId: 'conf_ev9' });
  const d = w.get('ordenes_deposito/D1')!;
  assert.equal(d.estado, 'en_revision'); assert.equal(d.rehechoPorUid, 'a1'); assert.equal(d.rehechoPorRol, 'admin'); assert.equal(d.motivoRehacer, MOTIVO);
  assert.equal(d.ultimoEventoId, `rehecho_${OP}`);
  assert.deepEqual(d.boucher, BOUCHER); assert.equal(d.montoTotal, 90); assert.equal(d.montoBruto, 100); assert.deepEqual(d.gastosIds, ['g1']); assert.deepEqual(d.solicitudIds, ['o1', 'o2']);
  assert.equal(d.confirmadoPorUid, 'g1', 'la confirmación anterior queda como historial');
  const m = w.get('movimientos_financieros/conf_ev9')!;
  assert.equal(m.estado, 'anulado'); assert.equal(m.anuladoPorUid, 'a1'); assert.equal(m.anuladoPorRol, 'admin'); assert.equal(m.monto, 90); assert.equal(m.tipo, 'deposito_efectivo_storkhub');
  for (const sid of ['o1', 'o2']) {
    const o = w.get(`solicitudes_envio/${sid}`)! as { registro: { deposito: Record<string, unknown> }; cobroDelivery: unknown };
    assert.equal(o.registro.deposito.storkhubDepositoId, 'D1'); assert.equal(o.registro.deposito.confirmadoStorkhub, false); assert.equal(o.registro.deposito.confirmadoStorkhubAt, null);
    assert.equal(o.registro.deposito.comercioDepositoId, 'DC9', 'no toca la contraparte');
    assert.deepEqual(o.cobroDelivery, { estado: 'pagado', formaPago: 'efectivo' });
  }
  assert.equal(JSON.stringify(w.get('gastos_motorizado/g1')), gastoAntes, 'R9 · el gasto sigue consumido por el depósito y no se tocó');
  const ev = w.eventos('D1'); assert.equal(ev.length, 1); assert.equal(ev[0].id, `rehecho_${OP}`);
  assert.equal(ev[0].data.tipo, 'DEPOSITO_REHECHO'); assert.equal(ev[0].data.porUid, 'a1'); assert.equal(ev[0].data.porRol, 'admin'); assert.equal(ev[0].data.estadoAnterior, 'confirmado'); assert.equal(ev[0].data.estadoDestino, 'en_revision'); assert.equal(ev[0].data.operacionId, OP);
  assert.equal((w.get(`operaciones_deposito/rehacer_${OP}`) as Doc).depositoId, 'D1');
});

test('FIN1B-R2 · confirmado SIN boucher ⇒ pendiente_boucher (no se fabrica un comprobante)', async () => {
  const w = mundo(); sembrar(w, { boucher: false });
  const r = await rehacer(w);
  assert.equal(r.estadoDestino, 'pendiente_boucher');
  const d = w.get('ordenes_deposito/D1')!; assert.equal(d.estado, 'pendiente_boucher'); assert.equal('boucher' in d, false);
  assert.equal(w.eventos('D1')[0].data.estadoDestino, 'pendiente_boucher');
});

test('FIN1B-R3 · convertido_en_deuda o con saldoId ⇒ usar_reversion_conversion; 0 escrituras', async () => {
  for (const o of [{ estado: 'convertido_en_deuda' }, { estado: 'confirmado', dep: { saldoId: 'S1' } }]) {
    const w = mundo(); sembrar(w, o);
    await sinEfectos(w, rehacer(w), codigo('failed-precondition', 'usar_reversion_conversion'));
  }
});

test('FIN1B-R4 · tipo C (pago_delivery_deposito) ⇒ usar_revertir_cobro; 0 escrituras', async () => {
  const w = mundo(); sembrar(w, { dep: { tipo: 'pago_delivery_deposito' } });
  await sinEfectos(w, rehacer(w), codigo('failed-precondition', 'usar_revertir_cobro'));
});

test('FIN1B-R5 · solo desde confirmado: pendiente_boucher, en_revision, devuelto, rechazado, anulado y un tipo desconocido ⇒ deposito_no_rehacible', async () => {
  for (const estado of ['pendiente_boucher', 'en_revision', 'devuelto', 'rechazado', 'anulado', 'inventado']) {
    const w = mundo(); sembrar(w, { estado });
    await sinEfectos(w, rehacer(w), codigo('failed-precondition', 'deposito_no_rehacible'));
  }
  const w = mundo(); sembrar(w, { dep: { tipo: 'raro' } });
  await sinEfectos(w, rehacer(w), codigo('failed-precondition', 'deposito_no_rehacible'));
});

test('FIN1B-R6 · actor y rol del servidor: solo un admin ACTIVO; gestor, digitador, inactivo, sin sesión o sin perfil ⇒ rechazo y 0 escrituras; el payload no manda actor', async () => {
  for (const uid of ['g1', 'dig', 'baja', 'fantasma']) {
    const w = mundo(); sembrar(w);
    await sinEfectos(w, rehacer(w, uid), codigo('permission-denied'));
  }
  const w = mundo(); sembrar(w);
  await sinEfectos(w, rehacerDepositoCore(w.depsReh, undefined, { depositoId: 'D1', motivo: MOTIVO, operacionId: OP }), codigo('unauthenticated'));
  for (const extra of [{ actorUid: 'x' }, { actorRol: 'admin' }, { estado: 'en_revision' }, { estadoDestino: 'en_revision' }, { movimientoId: 'm' }, { ordenIds: ['o1'] }, { gastosIds: ['g1'] }, { saldoId: 'S' }, { monto: 1 }]) {
    await sinEfectos(w, rehacer(w, 'a1', { depositoId: 'D1', motivo: MOTIVO, operacionId: OP, ...extra }), codigo('invalid-argument'));
  }
  for (const malo of [null, [], 'x', { motivo: MOTIVO, operacionId: OP }, { depositoId: 'D1', operacionId: OP }, { depositoId: 'D1', motivo: 'ab', operacionId: OP }, { depositoId: 'D1', motivo: 'x'.repeat(301), operacionId: OP }, { depositoId: 'D1', motivo: MOTIVO }, { depositoId: 'D1', motivo: MOTIVO, operacionId: 'corto' }, { depositoId: 'D1', motivo: MOTIVO, operacionId: 'con espacios y símbolos!' }]) {
    await sinEfectos(w, rehacer(w, 'a1', malo), codigo('invalid-argument'));
  }
  assert.throws(() => validarPeticionRehacer({ depositoId: 'D1', motivo: MOTIVO, operacionId: OP, extra: 1 }));
});

test('FIN1B-R7 · exactamente UN movimiento activo y es el originario: 0 o 2 ⇒ ledger_inconsistente; un movimiento ajeno o con otra cuenta ⇒ bloquea; localiza por contenido, no por id', async () => {
  let w = mundo(); sembrar(w, { sinMov: true });
  await sinEfectos(w, rehacer(w), codigo('failed-precondition', 'ledger_inconsistente'));
  w = mundo(); sembrar(w, { movExtra: [['movimientos_financieros/otro', { tipo: 'deposito_efectivo_storkhub', monto: 90, estado: 'activo', depositoId: 'D1', motorizadoId: MOT, cuentaOrigen: `efectivo_en_poder:${MOT}`, cuentaDestino: 'banco_storkhub', propietario: 'storkhub' }]] });
  await sinEfectos(w, rehacer(w), codigo('failed-precondition', 'ledger_inconsistente'));
  for (const mov of [{ monto: 91 }, { cuentaOrigen: 'efectivo_en_poder:otro' }, { cuentaDestino: 'caja' }, { propietario: 'comercio:x' }, { depositoId: 'D2' }]) {
    w = mundo(); sembrar(w, { mov });
    await sinEfectos(w, rehacer(w), (e) => codigo('failed-precondition')(e) && ['conciliacion_requerida', 'ledger_inconsistente'].includes((e as { details: { motivo: string } }).details.motivo));
  }
  w = mundo(); sembrar(w);  // id aleatorio (legacy): el contenido es lo que cuenta
  const m = w.raw('movimientos_financieros/conf_ev9');
  w.put('movimientos_financieros/AzarLegacy', { ...m });
  w.put('movimientos_financieros/conf_ev9', { ...m, estado: 'anulado' });
  const r = await rehacer(w); assert.equal(r.movimientoId, 'AzarLegacy');
});

test('FIN1B-R8 · cualquier OTRO movimiento activo asociado bloquea: conversión, abono, condonación, un tipo desconocido; el legacy deposito_confirmado ⇒ conciliacion_requerida', async () => {
  const caso = (tipo: string, motivo: string, solo = false) => async () => {
    const w = mundo(); sembrar(w, solo ? { mov: { tipo } } : { movExtra: [['movimientos_financieros/x1', { tipo, monto: 5, estado: 'activo', depositoId: 'D1' }]] });
    await sinEfectos(w, rehacer(w), codigo('failed-precondition', motivo));
  };
  await caso('abono_deuda_motorizado', 'ledger_inconsistente')();
  await caso('deuda_condonada', 'ledger_inconsistente')();
  await caso('cosa_rara', 'ledger_inconsistente')();
  await caso('deposito_convertido_en_deuda', 'usar_reversion_conversion', true)();
  await caso('deposito_confirmado', 'conciliacion_requerida', true)();
});

test('FIN1B-R10 · las órdenes se LEEN: una que apunta a otro depósito, sin puntero o inexistente ⇒ conciliacion_requerida y 0 escrituras', async () => {
  for (const ordenes of [[{ registro: { deposito: { storkhubDepositoId: 'OTRO', confirmadoStorkhub: true } } }, {}], [{ registro: { deposito: {} } }, {}]]) {
    const w = mundo(); sembrar(w, { ordenes });
    await sinEfectos(w, rehacer(w), codigo('failed-precondition', 'conciliacion_requerida'));
  }
  const w = mundo(); sembrar(w, { dep: { solicitudIds: ['o1', 'oFantasma'] } });
  await sinEfectos(w, rehacer(w), codigo('failed-precondition', 'conciliacion_requerida'));
  const w2 = mundo(); sembrar(w2, { dep: { solicitudIds: [] } });
  await sinEfectos(w2, rehacer(w2), codigo('failed-precondition', 'conciliacion_requerida'));
});

test('FIN1B-R9b · gastos Storkhub: debe seguir consumido por ESTE depósito; consumido por otro, libre o inexistente ⇒ conciliacion_requerida; comercio con gastosIds ⇒ bloquea', async () => {
  for (const gasto of [{ consumidoEnDepositoId: 'OTRO' }, { consumidoEnDepositoId: null }]) {
    const w = mundo(); sembrar(w, { gasto });
    await sinEfectos(w, rehacer(w), codigo('failed-precondition', 'conciliacion_requerida'));
  }
  let w = mundo(); sembrar(w, { gasto: null });
  await sinEfectos(w, rehacer(w), codigo('failed-precondition', 'conciliacion_requerida'));
  w = mundo(); sembrar(w, { clase: 'comercio', dep: { gastosIds: ['g1'] } });
  await sinEfectos(w, rehacer(w), codigo('failed-precondition', 'conciliacion_requerida'));
});

test('FIN1B-R12 · retry con el MISMO operacionId ⇒ ya_rehecho, 0 escrituras, aun si el depósito ya cambió; un único evento', async () => {
  const w = mundo(); sembrar(w);
  const r1 = await rehacer(w);
  const antes = w.snapshot(); const e0 = w.escrituras;
  const r2 = await rehacer(w);
  assert.deepEqual({ ...r2 }, { ok: true, resultado: 'ya_rehecho', depositoId: 'D1', estadoDestino: r1.estadoDestino, eventoId: r1.eventoId, movimientoId: r1.movimientoId });
  assert.equal(w.snapshot(), antes); assert.equal(w.escrituras, e0);
  assert.equal(w.eventos('D1').length, 1);
  // Con el depósito ya re-confirmado el retry sigue siendo ya_rehecho (la identidad es la operación, no el estado).
  w.put('ordenes_deposito/D1', { ...w.raw('ordenes_deposito/D1'), estado: 'confirmado' });
  const r3 = await rehacer(w); assert.equal(r3.resultado, 'ya_rehecho');
});

test('FIN1B-R13 · un operacionId ya usado en OTRO depósito ⇒ operacion_inconsistente; un operacionId nuevo sobre un depósito ya rehecho no repite el ciclo', async () => {
  const w = mundo(); sembrar(w);
  w.put(`operaciones_deposito/rehacer_${OP}`, { depositoId: 'OTRO', eventoId: 'x' });
  await sinEfectos(w, rehacer(w), codigo('failed-precondition', 'operacion_inconsistente'));
  const w2 = mundo(); sembrar(w2); await rehacer(w2);
  await sinEfectos(w2, rehacer(w2, 'a1', { depositoId: 'D1', motivo: MOTIVO, operacionId: 'op-otra-9999' }), codigo('failed-precondition', 'deposito_no_rehacible'));
});

test('FIN1B-R14 · una liquidación del motorizado que CAPTURÓ el depósito (depositosIds) bloquea, abierta o cerrada: Storkhub ⇒ deposito_ya_liquidado', async () => {
  for (const estado of ['pendiente', 'pagada']) {
    const w = mundo(); sembrar(w); const [r, d] = liquidacion({ estado, depositosIds: ['D1', 'D7'] }); w.put(r, d);
    await sinEfectos(w, rehacer(w), codigo('failed-precondition', 'deposito_ya_liquidado'));
  }
  // por motorizadoId solo (una liquidación legacy sin motorizadoUid)
  const w = mundo(); sembrar(w); const [r, d] = liquidacion({ depositosIds: ['D1'] }); w.put(r, { ...d, motorizadoUid: undefined } as Doc);
  await sinEfectos(w, rehacer(w), codigo('failed-precondition', 'deposito_ya_liquidado'));
});

test('FIN1B-R15 · liquidación legacy SIN depositosIds: la semana que cubre creadoAt bloquea; otra semana no; sin datos legibles falla cerrado', async () => {
  let w = mundo(); sembrar(w); let [r, d] = liquidacion();
  w.put(r, (({ depositosIds, ...resto }) => resto)(d as { depositosIds: unknown } & Doc));
  await sinEfectos(w, rehacer(w), codigo('failed-precondition', 'deposito_ya_liquidado'));
  w = mundo(); sembrar(w); [r, d] = liquidacion({ semanaInicio: TS(10), semanaFin: TS(20) });
  w.put(r, (({ depositosIds, ...resto }) => resto)(d as { depositosIds: unknown } & Doc));
  assert.equal((await rehacer(w)).resultado, 'rehecho');
  w = mundo(); sembrar(w); [r, d] = liquidacion();
  w.put(r, (({ depositosIds, semanaInicio, ...resto }) => resto)(d as { depositosIds: unknown; semanaInicio: unknown } & Doc));
  await sinEfectos(w, rehacer(w), codigo('failed-precondition', 'conciliacion_requerida'));
  // Una liquidación CON depositosIds que no lo incluye no bloquea aunque la semana lo cubra (se hizo antes de que existiera).
  w = mundo(); sembrar(w); [r, d] = liquidacion({ depositosIds: ['D7'] }); w.put(r, d);
  assert.equal((await rehacer(w)).resultado, 'rehecho');
});

test('FIN1B-R16 · Comercio simple ⇒ rehace: ledger de comercio anulado, puntero de comercio conservado, la contraparte Storkhub intacta', async () => {
  const w = mundo(); sembrar(w, { clase: 'comercio' });
  const r = await rehacer(w);
  assert.equal(r.estadoDestino, 'en_revision');
  const m = w.get('movimientos_financieros/conf_ev9')!; assert.equal(m.estado, 'anulado'); assert.equal(m.tipo, 'deposito_efectivo_comercio');
  const o = w.get('solicitudes_envio/o1')! as { registro: { deposito: Record<string, unknown> } };
  assert.equal(o.registro.deposito.comercioDepositoId, 'D1'); assert.equal(o.registro.deposito.confirmadoComercio, false); assert.equal(o.registro.deposito.confirmadoComercioAt, null);
  assert.equal(o.registro.deposito.storkhubDepositoId, 'DS9');
});

test('FIN1B-R17 · Comercio liquidado (abierto o cerrado) ⇒ deposito_comercio_ya_liquidado; 0 escrituras', async () => {
  for (const estado of ['pendiente', 'pagada']) {
    const w = mundo(); sembrar(w, { clase: 'comercio' }); const [r, d] = liquidacion({ estado, depositosIds: ['D1'] }); w.put(r, d);
    await sinEfectos(w, rehacer(w), codigo('failed-precondition', 'deposito_comercio_ya_liquidado'));
  }
});

test('FIN1B-R18 · movimientos POSTERIORES de la cuenta saldo_comercio SIN depositoId no bloquean (cuenta fungible)', async () => {
  const w = mundo(); sembrar(w, { clase: 'comercio', movExtra: [
    ['movimientos_financieros/pago1', { tipo: 'pago_comercio_aplicado', monto: 40, estado: 'activo', cuentaOrigen: 'saldo_comercio:com9', cuentaDestino: 'banco_storkhub', comercioId: 'com9' }],
    ['movimientos_financieros/cargo1', { tipo: 'cargo_generado', monto: 15, estado: 'activo', cuentaOrigen: 'ingresos_devengados_delivery', cuentaDestino: 'saldo_comercio:com9', comercioId: 'com9' }],
  ] });
  assert.equal((await rehacer(w)).resultado, 'rehecho');
  assert.equal(w.get('movimientos_financieros/pago1')!.estado, 'activo'); assert.equal(w.get('movimientos_financieros/cargo1')!.estado, 'activo');
});

test('FIN1B-R19 · Comercio legacy no demostrable (cuenta por nombre, sin comercioId coherente, formato anterior, sin destinatarioId) ⇒ conciliacion_requerida', async () => {
  for (const o of [
    { mov: { cuentaDestino: 'saldo_comercio:Pizzeria' } },
    { mov: { comercioId: 'otro' } },
    { mov: { propietario: 'comercio:Pizzeria' } },
    { dep: { destinatarioId: '' } },
    { dep: { destinatario: 'storkhub' } },
  ]) {
    const w = mundo(); sembrar(w, { clase: 'comercio', ...o });
    await sinEfectos(w, rehacer(w), codigo('failed-precondition', 'conciliacion_requerida'));
  }
  const w = mundo(); sembrar(w, { clase: 'comercio', mov: { tipo: 'deposito_confirmado' } });
  await sinEfectos(w, rehacer(w), codigo('failed-precondition', 'conciliacion_requerida'));
});

test('FIN1B-R20 · carrera: si entre la lectura y el commit el depósito cambia (otro lo anuló o lo confirmó de nuevo), la transacción relee y bloquea con 0 escrituras', async () => {
  const w = mundo(); sembrar(w);
  w.hooks.antesDeCommit = () => { w.put('ordenes_deposito/D1', { ...w.raw('ordenes_deposito/D1'), estado: 'anulado' }); w.bump(); };
  const e0 = w.escrituras;
  await assert.rejects(rehacer(w), codigo('failed-precondition', 'deposito_no_rehacible'));
  assert.equal(w.escrituras, e0); assert.equal(w.eventos('D1').length, 0);
});

test('FIN1B-R21 · atomicidad: si CUALQUIERA de las escrituras falla no queda nada aplicado; el reintento deja un único ciclo', async () => {
  for (const ruta of [`operaciones_deposito/rehacer_${OP}`, 'movimientos_financieros/conf_ev9', 'solicitudes_envio/o2', `ordenes_deposito/D1/eventos/rehecho_${OP}`]) {
    const w = mundo(); sembrar(w);
    w.hooks.fallarSi = (_op, r) => r === ruta;
    const antes = w.snapshot();
    await assert.rejects(rehacer(w), /fallo simulado/);
    assert.equal(w.snapshot(), antes);
    w.hooks.fallarSi = undefined;
    assert.equal((await rehacer(w)).resultado, 'rehecho'); assert.equal(w.eventos('D1').length, 1);
  }
});

// ═══ ANULAR ═════════════════════════════════════════════════════════════

test('FIN1B-A1/A2/A3/A4 · pendiente_boucher, en_revision, devuelto y rechazado válidos ⇒ anulan, sin ledger; liberan SOLO las órdenes que apuntan a este depósito y los gastos que consumió', async () => {
  for (const estado of ['pendiente_boucher', 'en_revision', 'devuelto', 'rechazado']) {
    const w = mundo(); sembrar(w, { estado });
    const r = await anular(w);
    assert.deepEqual({ ...r }, { ok: true, resultado: 'anulado', depositoId: 'D1', estadoAnterior: estado, eventoId: 'ev1', movimientoId: null, gastosLiberados: 1 });
    const d = w.get('ordenes_deposito/D1')!;
    assert.equal(d.estado, 'anulado'); assert.equal(d.anuladoPorUid, 'a1'); assert.equal(d.anuladoPorRol, 'admin'); assert.equal(d.motivoAnulacion, MOTIVO); assert.equal(d.ultimoEventoId, 'ev1');
    assert.deepEqual(d.boucher, BOUCHER); assert.equal(d.montoTotal, 90);
    for (const sid of ['o1', 'o2']) {
      const o = w.get(`solicitudes_envio/${sid}`)! as { registro: { deposito: Record<string, unknown> } };
      assert.equal(o.registro.deposito.storkhubDepositoId, null); assert.equal(o.registro.deposito.confirmadoStorkhub, false); assert.equal(o.registro.deposito.confirmadoStorkhubAt, null);
      assert.equal(o.registro.deposito.comercioDepositoId, 'DC9');
    }
    assert.equal('consumidoEnDepositoId' in (w.get('gastos_motorizado/g1') as Doc), false);
    assert.equal(w.eventos('D1').length, 1); assert.equal(w.eventos('D1')[0].data.tipo, 'DEPOSITO_ANULADO');
  }
});

test('FIN1B-A5 · confirmado Storkhub simple ⇒ anula depósito + ledger, libera órdenes y gastos, un evento', async () => {
  const w = mundo(); sembrar(w);
  const r = await anular(w);
  assert.equal(r.resultado, 'anulado'); assert.equal(r.movimientoId, 'conf_ev9'); assert.equal(r.gastosLiberados, 1);
  const m = w.get('movimientos_financieros/conf_ev9')!; assert.equal(m.estado, 'anulado'); assert.equal(m.anuladoPorUid, 'a1'); assert.equal(m.anuladoPorRol, 'admin'); assert.equal(m.monto, 90);
  assert.equal(w.get('ordenes_deposito/D1')!.estado, 'anulado');
  assert.equal((w.get('solicitudes_envio/o1') as { registro: { deposito: Record<string, unknown> } }).registro.deposito.confirmadoStorkhub, false);
  assert.equal(w.eventos('D1')[0].data.movimientoId, 'conf_ev9');
});

test('FIN1B-A6 · ya anulado ⇒ ya_anulado, 0 escrituras, ANTES de cualquier guard (aun con un estado raro, tipo C o ledger vivo)', async () => {
  const w = mundo(); sembrar(w); await anular(w);
  const antes = w.snapshot(); const e0 = w.escrituras;
  const r = await anular(w, 'a1', { depositoId: 'D1', motivo: 'otro motivo' });
  assert.deepEqual({ ...r }, { ok: true, resultado: 'ya_anulado', depositoId: 'D1', estadoAnterior: 'anulado', eventoId: null, movimientoId: null, gastosLiberados: 0 });
  assert.equal(w.snapshot(), antes); assert.equal(w.escrituras, e0);
  const w2 = mundo(); sembrar(w2, { estado: 'anulado', dep: { tipo: 'pago_delivery_deposito' }, movExtra: [['movimientos_financieros/v', { tipo: 'x', estado: 'activo', depositoId: 'D1', monto: 1 }]] });
  assert.equal((await anular(w2)).resultado, 'ya_anulado');
});

test('FIN1B-A7 · convertido_en_deuda, con saldoId o con un saldo vivo asociado ⇒ usar_reversion_conversion; un saldo ya anulado no bloquea', async () => {
  for (const o of [{ estado: 'convertido_en_deuda' }, { estado: 'en_revision', dep: { saldoId: 'S1' } }]) {
    const w = mundo(); sembrar(w, o);
    await sinEfectos(w, anular(w), codigo('failed-precondition', 'usar_reversion_conversion'));
  }
  for (const estadoSaldo of ['pendiente', 'abonado_parcial', 'condonado', 'pagado']) {
    const w = mundo(); sembrar(w, { estado: 'en_revision' }); w.put('saldos_cargo_motorizado/S1', { depositoId: 'D1', estado: estadoSaldo, montoOriginal: 80 });
    await sinEfectos(w, anular(w), codigo('failed-precondition', 'usar_reversion_conversion'));
  }
  const w = mundo(); sembrar(w, { estado: 'en_revision' }); w.put('saldos_cargo_motorizado/S1', { depositoId: 'D1', estado: 'anulado', montoOriginal: 80 });
  assert.equal((await anular(w)).resultado, 'anulado');
});

test('FIN1B-A8 · tipo C ⇒ usar_revertir_cobro; tipo desconocido o estado desconocido ⇒ deposito_no_anulable', async () => {
  let w = mundo(); sembrar(w, { dep: { tipo: 'pago_delivery_deposito' } });
  await sinEfectos(w, anular(w), codigo('failed-precondition', 'usar_revertir_cobro'));
  w = mundo(); sembrar(w, { dep: { tipo: 'raro' } });
  await sinEfectos(w, anular(w), codigo('failed-precondition', 'deposito_no_anulable'));
  w = mundo(); sembrar(w, { estado: 'inventado' });
  await sinEfectos(w, anular(w), codigo('failed-precondition', 'deposito_no_anulable'));
});

test('FIN1B-A9/A10 · ledger incompatible: un preconfirmado con movimiento activo, un confirmado con 0, 2 o uno ajeno ⇒ bloquea; 0 escrituras', async () => {
  let w = mundo(); sembrar(w, { estado: 'en_revision', movExtra: [['movimientos_financieros/x', { tipo: 'deposito_efectivo_storkhub', monto: 90, estado: 'activo', depositoId: 'D1' }]] });
  await sinEfectos(w, anular(w), codigo('failed-precondition', 'ledger_inconsistente'));
  w = mundo(); sembrar(w, { sinMov: true });
  await sinEfectos(w, anular(w), codigo('failed-precondition', 'ledger_inconsistente'));
  w = mundo(); sembrar(w, { movExtra: [['movimientos_financieros/dos', { tipo: 'deposito_efectivo_storkhub', monto: 90, estado: 'activo', depositoId: 'D1' }]] });
  await sinEfectos(w, anular(w), codigo('failed-precondition', 'ledger_inconsistente'));
  w = mundo(); sembrar(w, { mov: { tipo: 'abono_deuda_motorizado' } });
  await sinEfectos(w, anular(w), codigo('failed-precondition', 'ledger_inconsistente'));
  w = mundo(); sembrar(w, { estado: 'en_revision', movExtra: [['movimientos_financieros/anul', { tipo: 'deposito_efectivo_storkhub', monto: 90, estado: 'anulado', depositoId: 'D1' }]] });
  assert.equal((await anular(w)).resultado, 'anulado');
});

test('FIN1B-A11 · confirmado Storkhub capturado por una liquidación ⇒ deposito_ya_liquidado; un preconfirmado no mira liquidaciones', async () => {
  let w = mundo(); sembrar(w); let [r, d] = liquidacion({ depositosIds: ['D1'] }); w.put(r, d);
  await sinEfectos(w, anular(w), codigo('failed-precondition', 'deposito_ya_liquidado'));
  w = mundo(); sembrar(w, { estado: 'en_revision' }); [r, d] = liquidacion({ depositosIds: ['D1'] }); w.put(r, d);
  assert.equal((await anular(w)).resultado, 'anulado');
});

test('FIN1B-A12/A13 · actor y rol del servidor: solo un admin activo; un evento único con su porUid/porRol; payload estricto', async () => {
  for (const uid of ['g1', 'dig', 'baja', 'fantasma']) {
    const w = mundo(); sembrar(w);
    await sinEfectos(w, anular(w, uid), codigo('permission-denied'));
  }
  const w = mundo(); sembrar(w);
  await sinEfectos(w, anularDepositoCore(w.depsAnu, undefined, { depositoId: 'D1', motivo: MOTIVO }), codigo('unauthenticated'));
  for (const extra of [{ actorUid: 'x' }, { estado: 'anulado' }, { movimientoId: 'm' }, { ordenIds: [] }, { gastosIds: [] }, { operacionId: OP }, { monto: 1 }]) {
    await sinEfectos(w, anular(w, 'a1', { depositoId: 'D1', motivo: MOTIVO, ...extra }), codigo('invalid-argument'));
  }
  for (const malo of [null, [], { motivo: MOTIVO }, { depositoId: 'D1' }, { depositoId: 'D1', motivo: ' ab ' }, { depositoId: '', motivo: MOTIVO }]) {
    await sinEfectos(w, anular(w, 'a1', malo), codigo('invalid-argument'));
  }
  assert.throws(() => validarPeticionAnular({ depositoId: 'D1', motivo: MOTIVO, otro: 1 }));
  await anular(w);
  const ev = w.eventos('D1'); assert.equal(ev.length, 1); assert.equal(ev[0].data.porUid, 'a1'); assert.equal(ev[0].data.porRol, 'admin');
});

test('FIN1B-A14 · Comercio simple confirmado ⇒ anula: libera SOLO las 3 claves de comercio, no toca cobroDelivery ni la contraparte', async () => {
  const w = mundo(); sembrar(w, { clase: 'comercio' });
  const r = await anular(w);
  assert.equal(r.resultado, 'anulado'); assert.equal(r.gastosLiberados, 0);
  const o = w.get('solicitudes_envio/o1')! as { registro: { deposito: Record<string, unknown> }; cobroDelivery: unknown };
  assert.equal(o.registro.deposito.comercioDepositoId, null); assert.equal(o.registro.deposito.confirmadoComercio, false); assert.equal(o.registro.deposito.confirmadoComercioAt, null);
  assert.equal(o.registro.deposito.storkhubDepositoId, 'DS9'); assert.deepEqual(o.cobroDelivery, { estado: 'pagado', formaPago: 'efectivo' });
  assert.equal(w.get('movimientos_financieros/conf_ev9')!.estado, 'anulado');
});

test('FIN1B-A15/A16 · Comercio liquidado, abierto o cerrado, por depositosIds o por semana legacy ⇒ deposito_comercio_ya_liquidado', async () => {
  for (const estado of ['pendiente', 'pagada']) {
    const w = mundo(); sembrar(w, { clase: 'comercio' }); const [r, d] = liquidacion({ estado, depositosIds: ['D1'] }); w.put(r, d);
    await sinEfectos(w, anular(w), codigo('failed-precondition', 'deposito_comercio_ya_liquidado'));
  }
  const w = mundo(); sembrar(w, { clase: 'comercio' }); const [r, d] = liquidacion();
  w.put(r, (({ depositosIds, ...resto }) => resto)(d as { depositosIds: unknown } & Doc));
  await sinEfectos(w, anular(w), codigo('failed-precondition', 'deposito_comercio_ya_liquidado'));
});

test('FIN1B-A17 · Comercio con movimientos posteriores fungibles (sin depositoId) ⇒ anula igual', async () => {
  const w = mundo(); sembrar(w, { clase: 'comercio', movExtra: [['movimientos_financieros/pago1', { tipo: 'pago_comercio_aplicado', monto: 40, estado: 'activo', cuentaOrigen: 'saldo_comercio:com9', cuentaDestino: 'banco_storkhub' }]] });
  assert.equal((await anular(w)).resultado, 'anulado'); assert.equal(w.get('movimientos_financieros/pago1')!.estado, 'activo');
});

test('FIN1B-A18 · Comercio legacy no demostrable ⇒ conciliacion_requerida; un confirmado de comercio con una orden no confirmada ⇒ conciliacion_requerida', async () => {
  for (const o of [{ mov: { cuentaDestino: 'saldo_comercio:Pizzeria' } }, { mov: { tipo: 'deposito_confirmado' } }, { dep: { destinatarioId: '' } }, { dep: { gastosIds: ['g1'] } }]) {
    const w = mundo(); sembrar(w, { clase: 'comercio', ...o });
    await sinEfectos(w, anular(w), codigo('failed-precondition', 'conciliacion_requerida'));
  }
  const w = mundo(); sembrar(w, { clase: 'comercio', ordenes: [{ registro: { deposito: { comercioDepositoId: 'D1', confirmadoComercio: false } } }, {}] });
  await sinEfectos(w, anular(w), codigo('failed-precondition', 'conciliacion_requerida'));
});

test('FIN1B-A19 · una orden que apunta a OTRO depósito ⇒ conciliacion_requerida y 0 escrituras (no se libera nada ajeno); una orden sin puntero en un preconfirmado se acepta y no se toca', async () => {
  let w = mundo(); sembrar(w, { estado: 'en_revision', ordenes: [{ registro: { deposito: { storkhubDepositoId: 'OTRO' } } }, {}] });
  await sinEfectos(w, anular(w), codigo('failed-precondition', 'conciliacion_requerida'));
  w = mundo(); sembrar(w, { estado: 'en_revision', ordenes: [{ registro: { deposito: {} } }, {}] });
  assert.equal((await anular(w)).resultado, 'anulado');
  assert.deepEqual((w.get('solicitudes_envio/o1') as { registro: unknown }).registro, { deposito: {} }, 'sin puntero no se escribe nada');
  w = mundo(); sembrar(w, { dep: { solicitudIds: ['o1', 'oFantasma'] } });
  await sinEfectos(w, anular(w), codigo('failed-precondition', 'conciliacion_requerida'));
});

test('FIN1B-A20 · un gasto que consumió OTRO depósito o que ya no existe ⇒ conciliacion_requerida y 0 escrituras; uno libre no se toca', async () => {
  for (const gasto of [{ consumidoEnDepositoId: 'OTRO' }]) {
    const w = mundo(); sembrar(w, { estado: 'en_revision', gasto });
    await sinEfectos(w, anular(w), codigo('failed-precondition', 'conciliacion_requerida'));
  }
  let w = mundo(); sembrar(w, { estado: 'en_revision', gasto: null });
  await sinEfectos(w, anular(w), codigo('failed-precondition', 'conciliacion_requerida'));
  w = mundo(); sembrar(w, { estado: 'en_revision', gasto: { consumidoEnDepositoId: null } });
  const r = await anular(w); assert.equal(r.gastosLiberados, 0);
});

test('FIN1B-A21 · carrera con confirmar: si entre la lectura (en_revision) y el commit el depósito se confirma, la transacción relee y anula el confirmado COMPLETO (ledger, órdenes, gasto) o bloquea; nunca queda un confirmado con ledger vivo', async () => {
  const w = mundo(); sembrar(w, { estado: 'en_revision' });
  w.hooks.antesDeCommit = () => {
    w.put('ordenes_deposito/D1', { ...w.raw('ordenes_deposito/D1'), estado: 'confirmado' });
    w.put('movimientos_financieros/conf_ev9', { tipo: 'deposito_efectivo_storkhub', monto: 90, estado: 'activo', depositoId: 'D1', motorizadoId: MOT, cuentaOrigen: `efectivo_en_poder:${MOT}`, cuentaDestino: 'banco_storkhub', propietario: 'storkhub' });
    for (const sid of ['o1', 'o2']) w.put(`solicitudes_envio/${sid}`, { estado: 'entregado', registro: { deposito: { storkhubDepositoId: 'D1', confirmadoStorkhub: true } } });
    w.bump();
  };
  const r = await anular(w);
  assert.equal(r.estadoAnterior, 'confirmado'); assert.equal(r.movimientoId, 'conf_ev9');
  assert.equal(w.get('movimientos_financieros/conf_ev9')!.estado, 'anulado'); assert.equal(w.get('ordenes_deposito/D1')!.estado, 'anulado');
});

test('FIN1B-A22 · carrera con convertir: si entre la lectura y el commit el depósito se convierte en deuda, la transacción relee y bloquea con usar_reversion_conversion y 0 escrituras', async () => {
  const w = mundo(); sembrar(w, { estado: 'en_revision' });
  w.hooks.antesDeCommit = () => {
    w.put('ordenes_deposito/D1', { ...w.raw('ordenes_deposito/D1'), estado: 'convertido_en_deuda', saldoId: 'S1' });
    w.put('saldos_cargo_motorizado/S1', { depositoId: 'D1', estado: 'pendiente', montoOriginal: 90 });
    w.bump();
  };
  const e0 = w.escrituras;
  await assert.rejects(anular(w), codigo('failed-precondition', 'usar_reversion_conversion'));
  assert.equal(w.escrituras, e0); assert.equal(w.eventos('D1').length, 0);
});

test('FIN1B-A23 · atomicidad: si cualquier escritura falla no queda nada aplicado; el reintento deja un único evento', async () => {
  for (const ruta of ['gastos_motorizado/g1', 'movimientos_financieros/conf_ev9', 'solicitudes_envio/o1', 'ordenes_deposito/D1/eventos/ev1']) {
    const w = mundo(); sembrar(w);
    w.hooks.fallarSi = (_op, r) => r === ruta;
    const antes = w.snapshot();
    await assert.rejects(anular(w), /fallo simulado/);
    assert.equal(w.snapshot(), antes);
    w.hooks.fallarSi = undefined;
    assert.equal((await anular(w)).resultado, 'anulado');
    assert.equal(w.eventos('D1').filter((e) => e.data.tipo === 'DEPOSITO_ANULADO').length, 1);
  }
});

test('FIN1B-A24 · Rehacer y Anular no existen para un depósito inexistente: not-found', async () => {
  const w = mundo(); usuarios(w);
  await assert.rejects(rehacer(w), codigo('not-found'));
  await assert.rejects(anular(w), codigo('not-found'));
});

// ═══ CONTRATOS DE CÓDIGO ═════════════════════════════════════════════════

const leer = (...r: string[]) => readFileSync(join(__dirname, '..', '..', 'src', ...r), 'utf8');
const sinComentarios = (s: string) => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

test('FIN1B-C1 · las callables exportan rehacerDeposito y anularDeposito y no aceptan monto/actor/estado/movimientos/órdenes/gastos del cliente', () => {
  const idx = leer('index.ts');
  assert.match(idx, /export \{ rehacerDeposito \} from '\.\/rehacer-deposito-callable'/);
  assert.match(idx, /export \{ anularDeposito \} from '\.\/anular-deposito-callable'/);
  for (const f of ['rehacer-deposito.ts', 'anular-deposito.ts']) {
    const s = sinComentarios(leer(f));
    assert.ok(!/(^|[^.\w])data\.(monto|actorUid|actorRol|estado|estadoDestino|movimientoId|ordenIds|gastosIds|saldoId)\b/.test(s), `${f}: no lee autoridad de data`);
  }
});

test('FIN1B-C2 · las dos transacciones leen TODO antes de escribir y escriben solo con create/update de la transacción (sin batch posterior)', () => {
  for (const f of ['rehacer-deposito.ts', 'anular-deposito.ts']) {
    const crudo = leer(f);
    const iEscritura = crudo.indexOf('// ── ESCRITURAS');
    assert.ok(iEscritura > 0);
    assert.ok(!/await tx\.get/.test(sinComentarios(crudo.slice(iEscritura))), `${f}: ninguna lectura después de la primera escritura`);
    assert.ok(!/writeBatch|\.batch\(\)/.test(sinComentarios(crudo)));
  }
  for (const f of ['rehacer-deposito-callable.ts', 'anular-deposito-callable.ts']) {
    const s = sinComentarios(leer(f));
    assert.equal((s.match(/runTransaction/g) ?? []).length, 1);
    assert.ok(!/\.(set|update|create|delete)\(/.test(s.replace(/tx\.(update|create)\(/g, '').replace(/FieldValue\.delete\(/g, '')), `${f}: sin escrituras fuera de la transacción`);
  }
});
