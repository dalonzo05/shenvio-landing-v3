// FIN-3 — confirmarDepositoCore: confirmación de depósito autoritativa e idempotente.
//
// El "mundo" de abajo simula lo que importa de Firestore para estas garantías:
//   - una transacción relee sus lecturas: si OTRA transacción escribió entre su
//     inicio y su commit, se invalida y se REINTENTA (optimismo de Firestore);
//   - sus escrituras se aplican TODAS o ninguna (rollback si una falla);
//   - create() falla si el documento ya existe, update() si no existe.
// Nada de esto reemplaza la prueba con el emulador real: acota la lógica del núcleo.
import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { DocumentData } from 'firebase-admin/firestore';
import {
  confirmarDepositoCore, validarPeticionConfirmacion, MAX_ORDENES_POR_DEPOSITO,
  type DepsConfirmacion, type TxConfirmacion,
} from '../src/confirmacion-deposito';

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
  let eventos = 0;
  let escrituras = 0;
  const hooks: { antesDeCommit?: () => void; fallarSi?: (op: string, ruta: string) => boolean } = {};

  const clonar = (m: Map<string, Doc>) => new Map([...m].map(([k, v]) => [k, structuredClone(v)]));
  const put = (ruta: string, d: Doc) => { store.set(ruta, d); };
  const get = (ruta: string) => { const d = store.get(ruta); return d ? (structuredClone(d) as DocumentData) : null; };

  // update() con rutas con puntos, como Firestore: 'registro.deposito.x' anida.
  function aplicarUpdate(actual: Doc, campos: Doc): Doc {
    const r = structuredClone(actual);
    for (const [k, v] of Object.entries(campos)) {
      const partes = k.split('.');
      let cursor = r as Record<string, unknown>;
      for (const p of partes.slice(0, -1)) {
        if (typeof cursor[p] !== 'object' || cursor[p] === null) cursor[p] = {};
        cursor = cursor[p] as Record<string, unknown>;
      }
      cursor[partes[partes.length - 1]] = v;
    }
    return r;
  }

  const deps: DepsConfirmacion = {
    serverTimestamp: () => TS(++relojes),
    nuevoEventoId: () => `ev${++eventos}`,
    async transaction(fn) {
      for (;;) {
        const inicio = revision;
        const cola: Array<{ op: string; ruta: string; datos: Doc }> = [];
        const tx: TxConfirmacion = {
          async getUsuario(uid) { return get(`usuarios/${uid}`); },
          async getDeposito(id) { return get(`ordenes_deposito/${id}`); },
          async getMotorizadoDocId(authUid) {
            for (const [ruta, d] of store) if (ruta.startsWith('motorizado/') && d.authUid === authUid) return ruta.split('/')[1];
            return null;
          },
          async getSolicitud(id) { return get(`solicitudes_envio/${id}`); },
          async getGasto(id) { return get(`gastos_motorizado/${id}`); },
          async getMovimientosDeDeposito(depositoId) {
            return [...store].filter(([r, d]) => r.startsWith('movimientos_financieros/') && d.depositoId === depositoId)
              .map(([r, d]) => ({ id: r.split('/')[1], data: structuredClone(d) as DocumentData }));
          },
          updateDeposito(id, campos) { cola.push({ op: 'update', ruta: `ordenes_deposito/${id}`, datos: campos }); },
          crearEvento(depId, evId, campos) { cola.push({ op: 'create', ruta: `ordenes_deposito/${depId}/eventos/${evId}`, datos: campos }); },
          updateSolicitud(id, campos) { cola.push({ op: 'update', ruta: `solicitudes_envio/${id}`, datos: campos }); },
          crearMovimiento(id, campos) { cola.push({ op: 'create', ruta: `movimientos_financieros/${id}`, datos: campos }); },
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
    movimientos: () => [...store].filter(([r]) => r.startsWith('movimientos_financieros/')).map(([r, d]) => ({ id: r.split('/')[1], ...d } as Doc & { id: string })),
    eventosDe: (depId: string) => [...store].filter(([r]) => r.startsWith(`ordenes_deposito/${depId}/eventos/`)).map(([r, d]) => ({ id: r.split('/').pop()!, ...d } as Doc & { id: string })),
    bump: () => { revision++; },
  };
}

// ── datos base ────────────────────────────────────────────────────────────────
const MOT_AUTH = 'authMot';
const MOT_DOC = 'motDoc1';
const orden = (extra: Doc = {}): Doc => ({
  estado: 'entregado', userId: 'comercioUid',
  asignacion: { motorizadoAuthUid: MOT_AUTH, motorizadoId: MOT_DOC },
  confirmacion: { precioFinalCordobas: 50 },
  pagoDelivery: { quienPaga: 'recoleccion', deducirDelCobroContraEntrega: false },
  tipoCliente: 'contado', tipoServicio: 'normal',
  cobrosMotorizado: { delivery: { recibio: true, monto: 50 } },
  registro: { deposito: { storkhubDepositoId: null, confirmadoStorkhub: false } },
  ...extra,
});
const ordenComercio = (extra: Doc = {}): Doc => orden({
  cobroContraEntrega: { aplica: true, monto: 200 }, pagoDelivery: { quienPaga: 'transferencia' },
  cobrosMotorizado: { producto: { recibio: true } }, registro: { deposito: { comercioDepositoId: null } }, ...extra,
});

function sembrar(w: ReturnType<typeof mundo>, opts: { storkhub?: Doc; gastos?: boolean; comercio?: boolean; estado?: string } = {}) {
  w.put('usuarios/g1', { activo: true, rol: 'gestor' });
  w.put('usuarios/a1', { activo: true, rol: 'admin' });
  w.put('usuarios/g2', { activo: true, rol: 'gestor' });
  w.put('usuarios/dig', { activo: true, rol: 'digitador' });
  w.put('usuarios/mot', { activo: true, rol: 'motorizado' });
  w.put('usuarios/com', { activo: true, rol: 'Comercio' });
  w.put('usuarios/baja', { activo: false, rol: 'gestor' });
  w.put(`motorizado/${MOT_DOC}`, { authUid: MOT_AUTH, nombre: 'Luigi' });
  if (opts.comercio) {
    w.put('solicitudes_envio/o1', ordenComercio());
    w.put('ordenes_deposito/D1', {
      tipo: 'recaudacion_motorizado_comercio', estado: opts.estado ?? 'en_revision', destinatario: 'comercio', destinatarioId: 'comercioUid',
      destinatarioNombre: 'Mariposita', motorizadoUid: MOT_AUTH, motorizadoNombre: 'Luigi', solicitudIds: ['o1'], montoTotal: 200,
      boucher: { url: 'u' },
    });
    return;
  }
  w.put('solicitudes_envio/o1', orden());
  w.put('solicitudes_envio/o2', orden());
  const conGastos = opts.gastos !== false;
  if (conGastos) {
    w.put('gastos_motorizado/g1', { motorizadoId: MOT_DOC, estado: 'aprobado', monto: 10, consumidoEnDepositoId: 'D1' });
  }
  w.put('ordenes_deposito/D1', {
    tipo: 'recaudacion_motorizado_storkhub', estado: opts.estado ?? 'en_revision', destinatario: 'storkhub', destinatarioId: 'storkhub',
    destinatarioNombre: 'Storkhub', motorizadoUid: MOT_AUTH, motorizadoNombre: 'Luigi', solicitudIds: ['o1', 'o2'],
    montoBruto: 100, gastosDescontados: conGastos ? 10 : 0, montoTotal: conGastos ? 90 : 100, gastosIds: conGastos ? ['g1'] : [],
    boucher: { url: 'u' }, ...opts.storkhub,
  });
}

// uid === null simula "sin sesión" (un parámetro por defecto convertiría undefined en 'g1').
const confirmar = (w: ReturnType<typeof mundo>, uid: string | null = 'g1', data: unknown = { depositoId: 'D1' }) =>
  confirmarDepositoCore(w.deps, uid ?? undefined, data);

// ── FC1 · autenticación y payload ─────────────────────────────────────────────
test('FC1 · sin sesión ⇒ unauthenticated, y no se escribe nada', async () => {
  const w = mundo(); sembrar(w);
  const antes = w.snapshot();
  await assert.rejects(confirmar(w, null), codigo('unauthenticated'));
  assert.equal(w.snapshot(), antes);
});

test('FC1b · el payload solo admite depositoId: nada de monto, estado, actor ni órdenes ⇒ invalid-argument', async () => {
  const w = mundo(); sembrar(w);
  for (const malo of [null, [], 'D1', {}, { depositoId: '' }, { depositoId: 5 }, { depositoId: 'D1', montoTotal: 1 },
    { depositoId: 'D1', uid: 'a1' }, { depositoId: 'D1', estado: 'confirmado' }, { depositoId: 'D1', solicitudIds: ['o1'] }, { monto: 1 }]) {
    await assert.rejects(confirmar(w, 'g1', malo), codigo('invalid-argument'), JSON.stringify(malo));
  }
  assert.equal(validarPeticionConfirmacion({ depositoId: '  D1  ' }), 'D1', 'el id se normaliza');
  assert.equal(w.escrituras, 0);
});

// ── FC2 · roles ───────────────────────────────────────────────────────────────
test('FC2 · solo gestor y admin ACTIVOS confirman: digitador, motorizado, comercio, cuenta de baja o inexistente ⇒ permission-denied', async () => {
  for (const uid of ['dig', 'mot', 'com', 'baja', 'noexiste']) {
    const w = mundo(); sembrar(w);
    const antes = w.snapshot();
    await assert.rejects(confirmar(w, uid), codigo('permission-denied'), uid);
    assert.equal(w.snapshot(), antes, uid + ': sin efectos');
  }
  for (const uid of ['g1', 'a1']) {
    const w = mundo(); sembrar(w);
    assert.equal((await confirmar(w, uid)).resultado, 'confirmado', uid);
  }
});

// ── FC3 · inexistente ─────────────────────────────────────────────────────────
test('FC3 · depósito inexistente ⇒ not-found', async () => {
  const w = mundo(); sembrar(w);
  await assert.rejects(confirmar(w, 'g1', { depositoId: 'nada' }), codigo('not-found'));
});

// ── FC4 · estados ─────────────────────────────────────────────────────────────
test('FC4 · solo en_revision abre una confirmación: pendiente_boucher, devuelto, anulado, convertido_en_deuda y rechazado ⇒ failed-precondition sin efectos', async () => {
  for (const estado of ['pendiente_boucher', 'devuelto', 'anulado', 'convertido_en_deuda', 'rechazado', 'otro']) {
    const w = mundo(); sembrar(w, { estado });
    const antes = w.snapshot();
    await assert.rejects(confirmar(w), codigo('failed-precondition', 'estado_cambio'), estado);
    assert.equal(w.snapshot(), antes, estado);
  }
});

test('FC4b · un depósito que no es A/B (tipo C, cobros) no se confirma aquí ⇒ tipo_no_confirmable', async () => {
  const w = mundo(); sembrar(w, { storkhub: { tipo: 'pago_delivery_deposito' } });
  await assert.rejects(confirmar(w), codigo('failed-precondition', 'tipo_no_confirmable'));
});

// ── FC5–FC8 · confirmación válida ─────────────────────────────────────────────
test('FC5 · confirmación válida: depósito confirmado con su actor, resultado estable y UN ciclo', async () => {
  const w = mundo(); sembrar(w);
  const r = await confirmar(w, 'g1');
  assert.deepEqual({ ...r }, { ok: true, resultado: 'confirmado', depositoId: 'D1', movimientoId: 'conf_ev1', montoTotal: 90, estadoAnterior: 'en_revision', estadoNuevo: 'confirmado' });
  const d = w.get('ordenes_deposito/D1')!;
  assert.equal(d.estado, 'confirmado');
  assert.equal(d.confirmadoPorUid, 'g1', 'el actor sale de request.auth');
  assert.deepEqual(d.confirmadoAt, TS(1), 'la hora la pone el servidor');
  assert.equal(d.ultimoEventoId, 'ev1');
  assert.equal(d.montoTotal, 90, 'el monto no se reescribe');
});

test('FC6 · el evento DEPOSITO_CONFIRMADO es exactamente uno, con actor y rol del servidor', async () => {
  for (const [uid, rol] of [['g1', 'gestor'], ['a1', 'admin']] as const) {
    const w = mundo(); sembrar(w);
    await confirmar(w, uid);
    const evs = w.eventosDe('D1');
    assert.equal(evs.length, 1);
    assert.deepEqual({ ...evs[0] }, { id: 'ev1', tipo: 'DEPOSITO_CONFIRMADO', at: TS(1), porUid: uid, porRol: rol });
  }
});

test('FC7 · todas las órdenes del depósito quedan confirmadas y apuntando a él', async () => {
  const w = mundo(); sembrar(w);
  await confirmar(w);
  for (const id of ['o1', 'o2']) {
    const dep = (w.get(`solicitudes_envio/${id}`)!.registro as { deposito: Doc }).deposito;
    assert.equal(dep.confirmadoStorkhub, true, id);
    assert.deepEqual(dep.confirmadoStorkhubAt, TS(1), id);
    assert.equal(dep.storkhubDepositoId, 'D1', id);
  }
});

test('FC8 · exactamente UN movimiento activo, con monto demostrado, cuentas y referencias', async () => {
  const w = mundo(); sembrar(w);
  await confirmar(w, 'a1');
  const movs = w.movimientos();
  assert.equal(movs.length, 1);
  const m = movs[0];
  assert.equal(m.id, 'conf_ev1');
  assert.equal(m.tipo, 'deposito_efectivo_storkhub');
  assert.equal(m.monto, 90);
  assert.equal(m.estado, 'activo');
  assert.equal(m.depositoId, 'D1');
  assert.equal(m.motorizadoId, MOT_DOC, 'el doc id canónico del motorizado, no su authUid');
  assert.equal(m.creadoPorUid, 'a1');
  assert.equal(m.cuentaOrigen, `efectivo_en_poder:${MOT_DOC}`);
  assert.equal(m.cuentaDestino, 'banco_storkhub');
  assert.equal(m.propietario, 'storkhub');
  assert.deepEqual(m.at, TS(1));
});

test('FC8b · un depósito en revisión con un movimiento ACTIVO previo no abre otro ciclo ⇒ ledger_inconsistente, sin efectos', async () => {
  const w = mundo(); sembrar(w);
  w.put('movimientos_financieros/viejo', { depositoId: 'D1', estado: 'activo', tipo: 'deposito_efectivo_storkhub', monto: 90 });
  const antes = w.snapshot();
  await assert.rejects(confirmar(w), codigo('failed-precondition', 'ledger_inconsistente'));
  assert.equal(w.snapshot(), antes);
});

// ── FC9–FC10 · idempotencia ───────────────────────────────────────────────────
test('FC9 · retry tras perder la respuesta: ya_confirmado, el MISMO movimiento, y CERO escrituras nuevas', async () => {
  const w = mundo(); sembrar(w);
  const primera = await confirmar(w);
  const escrituras = w.escrituras;
  const antes = w.snapshot();
  const segunda = await confirmar(w, 'g2');
  assert.equal(segunda.resultado, 'ya_confirmado');
  assert.equal(segunda.movimientoId, primera.movimientoId);
  assert.equal(w.escrituras, escrituras, 'ninguna escritura');
  assert.equal(w.snapshot(), antes);
  assert.equal(w.movimientos().length, 1);
  assert.equal(w.eventosDe('D1').length, 1);
});

test('FC10 · dos gestores a la vez: UNA confirmación efectiva, un evento, un movimiento', async () => {
  const w = mundo(); sembrar(w);
  const [a, b] = await Promise.all([confirmar(w, 'g1'), confirmar(w, 'g2')]);
  assert.deepEqual([a.resultado, b.resultado].sort(), ['confirmado', 'ya_confirmado']);
  assert.equal(w.eventosDe('D1').length, 1);
  assert.equal(w.movimientos().length, 1);
  assert.equal(w.movimientos().filter((m) => m.estado === 'activo').length, 1);
});

test('FC10b · cinco llamadas simultáneas (doble clic, pestañas, reintentos) ⇒ un solo efecto', async () => {
  const w = mundo(); sembrar(w);
  const rs = await Promise.all(['g1', 'g1', 'g2', 'a1', 'g1'].map((u) => confirmar(w, u)));
  assert.equal(rs.filter((r) => r.resultado === 'confirmado').length, 1);
  assert.equal(rs.filter((r) => r.resultado === 'ya_confirmado').length, 4);
  assert.equal(w.eventosDe('D1').length, 1);
  assert.equal(w.movimientos().length, 1);
});

// ── FC11 · monto manipulado ───────────────────────────────────────────────────
test('FC11 · el monto del documento se DEMUESTRA: total, bruto o gastos manipulados ⇒ monto_inconsistente, sin efectos', async () => {
  for (const alterado of [{ montoTotal: 9000 }, { montoTotal: 1 }, { montoBruto: 500 }, { gastosDescontados: 0, montoTotal: 100 }, { gastosDescontados: 50 }]) {
    const w = mundo(); sembrar(w, { storkhub: alterado });
    const antes = w.snapshot();
    await assert.rejects(confirmar(w), codigo('failed-precondition', 'monto_inconsistente'), JSON.stringify(alterado));
    assert.equal(w.snapshot(), antes);
    assert.equal(w.movimientos().length, 0);
  }
});

test('FC11b · un depósito anterior a los gastos (sin montoBruto/gastosDescontados) confirma si su total es demostrable', async () => {
  const w = mundo(); sembrar(w, { gastos: false });
  const d = w.get('ordenes_deposito/D1')!;
  delete d.montoBruto; delete d.gastosDescontados; delete d.gastosIds;
  w.put('ordenes_deposito/D1', d as Doc);
  assert.equal((await confirmar(w)).montoTotal, 100);
});

// ── FC12 · órdenes manipuladas ────────────────────────────────────────────────
test('FC12 · órdenes inválidas (inexistente, no entregada, de otro motorizado, de otro depósito) ⇒ orden_invalida, 0 ledger', async () => {
  const casos: Array<[string, (w: ReturnType<typeof mundo>) => void]> = [
    ['inexistente', (w) => w.put('ordenes_deposito/D1', { ...w.get('ordenes_deposito/D1')!, solicitudIds: ['o1', 'fantasma'] })],
    ['no entregada', (w) => w.put('solicitudes_envio/o2', orden({ estado: 'en_camino_entrega' }))],
    ['otro motorizado', (w) => w.put('solicitudes_envio/o2', orden({ asignacion: { motorizadoAuthUid: 'otro' } }))],
    ['sin asignación', (w) => w.put('solicitudes_envio/o2', orden({ asignacion: undefined }))],
    ['otro depósito', (w) => w.put('solicitudes_envio/o2', orden({ registro: { deposito: { storkhubDepositoId: 'DX' } } }))],
  ];
  for (const [nombre, preparar] of casos) {
    const w = mundo(); sembrar(w); preparar(w);
    const antes = w.snapshot();
    await assert.rejects(confirmar(w), codigo('failed-precondition', 'orden_invalida'), nombre);
    assert.equal(w.snapshot(), antes, nombre);
    assert.equal(w.movimientos().length, 0, nombre);
  }
});

test('FC12b · depósito sin órdenes, o con más del tope ⇒ rechazado', async () => {
  const a = mundo(); sembrar(a, { storkhub: { solicitudIds: [] } });
  await assert.rejects(confirmar(a), codigo('failed-precondition', 'sin_ordenes'));
  const b = mundo(); sembrar(b, { storkhub: { solicitudIds: Array.from({ length: MAX_ORDENES_POR_DEPOSITO + 1 }, (_, i) => `x${i}`) } });
  await assert.rejects(confirmar(b), codigo('failed-precondition', 'demasiadas_ordenes'));
});

test('FC12c · una orden que ya apunta a ESTE depósito (Rehacer la deja así) sí cuenta', async () => {
  const w = mundo(); sembrar(w);
  w.put('solicitudes_envio/o2', orden({ registro: { deposito: { storkhubDepositoId: 'D1', confirmadoStorkhub: false } } }));
  assert.equal((await confirmar(w)).resultado, 'confirmado');
});

// ── FC13 · gastos manipulados ─────────────────────────────────────────────────
test('FC13 · gastos inválidos ⇒ rechazado, sin efectos', async () => {
  const base = { motorizadoId: MOT_DOC, estado: 'aprobado', monto: 10, consumidoEnDepositoId: 'D1' };
  const casos: Array<[string, Doc | null, string]> = [
    ['inexistente', null, 'gasto_invalido'],
    ['de otro motorizado', { ...base, motorizadoId: 'otro' }, 'gasto_invalido'],
    ['no aprobado', { ...base, estado: 'anulado' }, 'gasto_invalido'],
    ['consumido por OTRO depósito', { ...base, consumidoEnDepositoId: 'D9' }, 'gasto_invalido'],
    ['ya descontado en una liquidación', { ...base, liquidacionId: 'L1' }, 'gasto_invalido'],
    ['monto inválido', { ...base, monto: 0 }, 'gasto_invalido'],
    ['sin marca de consumo (anterior a FIN-2)', { motorizadoId: MOT_DOC, estado: 'aprobado', monto: 10 }, 'gasto_sin_marca'],
    ['marca vacía', { ...base, consumidoEnDepositoId: '' }, 'gasto_sin_marca'],
  ];
  for (const [nombre, gasto, motivo] of casos) {
    const w = mundo(); sembrar(w);
    if (gasto === null) w.put('ordenes_deposito/D1', { ...w.get('ordenes_deposito/D1')!, gastosIds: ['fantasma'] });
    else w.put('gastos_motorizado/g1', gasto);
    const antes = w.snapshot();
    await assert.rejects(confirmar(w), codigo('failed-precondition', motivo), nombre);
    assert.equal(w.snapshot(), antes, nombre);
  }
});

test('FC13b · el gasto cuyo monto no coincide con lo descontado en el depósito ⇒ monto_inconsistente', async () => {
  const w = mundo(); sembrar(w);
  w.put('gastos_motorizado/g1', { motorizadoId: MOT_DOC, estado: 'aprobado', monto: 40, consumidoEnDepositoId: 'D1' });
  await assert.rejects(confirmar(w), codigo('failed-precondition', 'monto_inconsistente'));
});

test('FC13c · FIN-3 CONFIRMA, no vuelve a marcar: los gastos quedan exactamente como estaban', async () => {
  const w = mundo(); sembrar(w);
  const antes = w.get('gastos_motorizado/g1');
  await confirmar(w);
  assert.deepEqual(w.get('gastos_motorizado/g1'), antes);
});

// ── FC14 · sin gastos ─────────────────────────────────────────────────────────
test('FC14 · depósito sin gastos confirma sin exigir marcas', async () => {
  const w = mundo(); sembrar(w, { gastos: false });
  const r = await confirmar(w);
  assert.equal(r.resultado, 'confirmado');
  assert.equal(r.montoTotal, 100);
  assert.equal(w.movimientos()[0].monto, 100);
});

// ── FC15 · Rehacer → reconfirmar ──────────────────────────────────────────────
// FIN-5 deja el depósito en en_revision, las órdenes reabiertas y los movimientos anulados.
function rehacer(w: ReturnType<typeof mundo>) {
  const d = w.get('ordenes_deposito/D1')!;
  w.put('ordenes_deposito/D1', { ...d, estado: 'en_revision', rehechoPorUid: 'a1', ultimoEventoId: 'evRehecho' });
  for (const id of ['o1', 'o2']) {
    const o = w.get(`solicitudes_envio/${id}`)!;
    w.put(`solicitudes_envio/${id}`, { ...o, registro: { deposito: { storkhubDepositoId: 'D1', confirmadoStorkhub: false, confirmadoStorkhubAt: null } } });
  }
  for (const m of w.movimientos()) {
    const { id, ...resto } = m; w.put(`movimientos_financieros/${id}`, { ...resto, estado: 'anulado', motivoAnulacion: 'Depósito revertido a revisión por gestor' });
  }
  w.bump();
}

test('FC15 · Rehacer → reconfirmar es legítimo: evento NUEVO, movimiento NUEVO activo, el anterior sigue anulado', async () => {
  const w = mundo(); sembrar(w);
  const primera = await confirmar(w);
  rehacer(w);
  const segunda = await confirmar(w, 'a1');
  assert.equal(segunda.resultado, 'confirmado');
  assert.notEqual(segunda.movimientoId, primera.movimientoId);
  const movs = w.movimientos();
  assert.equal(movs.length, 2);
  assert.equal(movs.find((m) => m.id === primera.movimientoId)!.estado, 'anulado');
  assert.equal(movs.find((m) => m.id === segunda.movimientoId)!.estado, 'activo');
  assert.equal(movs.filter((m) => m.estado === 'activo').length, 1);
  assert.equal(w.eventosDe('D1').length, 2, 'un DEPOSITO_CONFIRMADO por ciclo');
  assert.equal((w.get('ordenes_deposito/D1')!).estado, 'confirmado');
  assert.equal(((w.get('solicitudes_envio/o1')!.registro as { deposito: Doc }).deposito).confirmadoStorkhub, true);
  // y dentro del ciclo nuevo, el reintento vuelve a ser idempotente
  assert.equal((await confirmar(w, 'g1')).resultado, 'ya_confirmado');
  assert.equal(w.movimientos().length, 2);
});

// ── FC16 · atomicidad ─────────────────────────────────────────────────────────
test('FC16 · si una escritura falla dentro de la transacción, NADA queda aplicado (ni evento, ni órdenes, ni ledger)', async () => {
  for (const fallo of ['solicitudes_envio/o2', 'movimientos_financieros/conf_ev1', 'ordenes_deposito/D1/eventos/ev1', 'ordenes_deposito/D1']) {
    const w = mundo(); sembrar(w);
    const antes = w.snapshot();
    w.hooks.fallarSi = (_op, ruta) => ruta === fallo;
    await assert.rejects(confirmar(w), /fallo simulado/, fallo);
    assert.equal(w.snapshot(), antes, 'sin efectos parciales cuando falla ' + fallo);
    assert.equal(w.movimientos().length, 0);
    assert.equal(w.eventosDe('D1').length, 0);
    // y después de un fallo, el reintento funciona y deja UN solo efecto
    w.hooks.fallarSi = undefined;
    assert.equal((await confirmar(w)).resultado, 'confirmado');
    assert.equal(w.movimientos().length, 1);
    assert.equal(w.eventosDe('D1').length, 1);
  }
});

// ── Comercio ──────────────────────────────────────────────────────────────────
test('CC1 · depósito al comercio: monto = lo que va al comercio, flags de comercio y cuenta saldo_comercio', async () => {
  const w = mundo(); sembrar(w, { comercio: true });
  const r = await confirmar(w);
  assert.equal(r.montoTotal, 200);
  const dep = (w.get('solicitudes_envio/o1')!.registro as { deposito: Doc }).deposito;
  assert.equal(dep.confirmadoComercio, true);
  assert.equal(dep.comercioDepositoId, 'D1');
  const m = w.movimientos()[0];
  assert.equal(m.tipo, 'deposito_efectivo_comercio');
  assert.equal(m.comercioId, 'comercioUid');
  assert.equal(m.cuentaDestino, 'saldo_comercio:comercioUid');
  assert.equal(m.propietario, 'comercio:comercioUid');
});

test('CC2 · al comercio: orden de otro comercio, monto manipulado o gastos ⇒ rechazado', async () => {
  const a = mundo(); sembrar(a, { comercio: true });
  a.put('solicitudes_envio/o1', ordenComercio({ userId: 'otroComercio' }));
  await assert.rejects(confirmar(a), codigo('failed-precondition', 'orden_invalida'));
  const b = mundo(); sembrar(b, { comercio: true });
  b.put('ordenes_deposito/D1', { ...b.get('ordenes_deposito/D1')!, montoTotal: 999 });
  await assert.rejects(confirmar(b), codigo('failed-precondition', 'monto_inconsistente'));
  const c = mundo(); sembrar(c, { comercio: true });
  c.put('ordenes_deposito/D1', { ...c.get('ordenes_deposito/D1')!, gastosIds: ['g1'] });
  await assert.rejects(confirmar(c), codigo('failed-precondition', 'gasto_invalido'));
});

test('CC3 · ya_confirmado sin movimiento activo (legacy inconsistente) responde sin inventar un movimiento ni repararlo', async () => {
  const w = mundo(); sembrar(w, { estado: 'confirmado' });
  const r = await confirmar(w);
  assert.equal(r.resultado, 'ya_confirmado');
  assert.equal(r.movimientoId, null);
  assert.equal(w.movimientos().length, 0);
  assert.equal(w.escrituras, 0);
});

// ── La copia del cálculo no deriva de la del cliente ──────────────────────────
test('CD1 · functions/src/calculo-deposito.ts es IDÉNTICO a lib/calculo-deposito.ts (no puede derivar)', () => {
  const norm = (p: string[]) => readFileSync(join(__dirname, ...p), 'utf8').replace(/\r\n/g, '\n');
  const servidor = norm(['..', '..', 'src', 'calculo-deposito.ts']);
  const cliente = norm(['..', '..', '..', 'lib', 'calculo-deposito.ts']);
  assert.equal(servidor, cliente);
});
