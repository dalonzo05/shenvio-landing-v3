// FIN-4A — convertirDepositoEnDeudaCore: conversión de depósito a deuda autoritativa e idempotente.
//
// El "mundo" de abajo simula lo que importa de Firestore para estas garantías (el mismo
// criterio que functions/test/confirmacion-deposito.test.ts):
//   - una transacción relee sus lecturas: si OTRA transacción escribió entre su
//     inicio y su commit, se invalida y se REINTENTA (optimismo de Firestore);
//   - sus escrituras se aplican TODAS o ninguna (rollback si una falla);
//   - create() falla si el documento ya existe, update() si no existe.
// Nada de esto reemplaza la prueba con el emulador real (functions/test-runtime): acota la lógica del núcleo.
import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { DocumentData } from 'firebase-admin/firestore';
import {
  convertirDepositoEnDeudaCore, validarPeticionConversion, ESTADOS_CONVERTIBLES,
  type DepsConversion, type TxConversion,
} from '../src/conversion-deposito-deuda';

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
  let saldosNuevos = 0;
  let escrituras = 0;
  const hooks: { antesDeCommit?: () => void; fallarSi?: (op: string, ruta: string) => boolean } = {};

  const clonar = (m: Map<string, Doc>) => new Map([...m].map(([k, v]) => [k, structuredClone(v)]));
  const put = (ruta: string, d: Doc) => { store.set(ruta, d); };
  const get = (ruta: string) => { const d = store.get(ruta); return d ? (structuredClone(d) as DocumentData) : null; };
  const lista = (prefijo: string, campo: string, valor: unknown) =>
    [...store].filter(([r, d]) => r.startsWith(prefijo) && d[campo] === valor)
      .map(([r, d]) => ({ id: r.split('/')[1], data: structuredClone(d) as DocumentData }));

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

  const deps: DepsConversion = {
    serverTimestamp: () => TS(++relojes),
    nuevoSaldoId: () => `sal${++saldosNuevos}`,
    async transaction(fn) {
      for (;;) {
        const inicio = revision;
        const cola: Array<{ op: string; ruta: string; datos: Doc }> = [];
        const tx: TxConversion = {
          async getUsuario(uid) { return get(`usuarios/${uid}`); },
          async getDeposito(id) { return get(`ordenes_deposito/${id}`); },
          async getSaldo(id) { return get(`saldos_cargo_motorizado/${id}`); },
          async getMotorizadoDocId(authUid) {
            for (const [ruta, d] of store) if (ruta.startsWith('motorizado/') && d.authUid === authUid) return ruta.split('/')[1];
            return null;
          },
          async getSolicitud(id) { return get(`solicitudes_envio/${id}`); },
          async getGasto(id) { return get(`gastos_motorizado/${id}`); },
          async getSaldosDeDeposito(depId) { return lista('saldos_cargo_motorizado/', 'depositoId', depId); },
          async getMovimientosDeDeposito(depId) { return lista('movimientos_financieros/', 'depositoId', depId); },
          updateDeposito(id, campos) { cola.push({ op: 'update', ruta: `ordenes_deposito/${id}`, datos: campos }); },
          updateSolicitud(id, campos) { cola.push({ op: 'update', ruta: `solicitudes_envio/${id}`, datos: campos }); },
          crearSaldo(id, campos) { cola.push({ op: 'create', ruta: `saldos_cargo_motorizado/${id}`, datos: campos }); },
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

  const coleccion = (prefijo: string) => [...store].filter(([r]) => r.startsWith(prefijo)).map(([r, d]) => ({ id: r.split('/').pop()!, ...d } as Doc & { id: string }));
  return {
    deps, hooks, put, get,
    get escrituras() { return escrituras; },
    snapshot: () => JSON.stringify([...store].sort(([a], [b]) => a.localeCompare(b))),
    movimientos: () => coleccion('movimientos_financieros/'),
    saldos: () => coleccion('saldos_cargo_motorizado/'),
    bump: () => { revision++; },
  };
}
type Mundo = ReturnType<typeof mundo>;

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

function sembrar(w: Mundo, opts: { storkhub?: Doc; gastos?: boolean; estado?: string; comercio?: boolean } = {}) {
  w.put('usuarios/g1', { activo: true, rol: 'gestor' });
  w.put('usuarios/a1', { activo: true, rol: 'admin' });
  w.put('usuarios/g2', { activo: true, rol: 'gestor' });
  w.put('usuarios/dig', { activo: true, rol: 'digitador' });
  w.put('usuarios/mot', { activo: true, rol: 'motorizado' });
  w.put('usuarios/com', { activo: true, rol: 'Comercio' });
  w.put('usuarios/baja', { activo: false, rol: 'gestor' });
  w.put(`motorizado/${MOT_DOC}`, { authUid: MOT_AUTH, nombre: 'Luigi' });
  w.put('solicitudes_envio/o1', orden());
  w.put('solicitudes_envio/o2', orden());
  const conGastos = opts.gastos !== false;
  if (conGastos) w.put('gastos_motorizado/g1', { motorizadoId: MOT_DOC, estado: 'aprobado', monto: 10, consumidoEnDepositoId: 'D1' });
  w.put('ordenes_deposito/D1', {
    tipo: opts.comercio ? 'recaudacion_motorizado_comercio' : 'recaudacion_motorizado_storkhub',
    estado: opts.estado ?? 'en_revision', destinatario: opts.comercio ? 'comercio' : 'storkhub',
    destinatarioId: opts.comercio ? 'comercioUid' : 'storkhub', destinatarioNombre: 'Storkhub',
    motorizadoUid: MOT_AUTH, motorizadoNombre: 'Luigi', solicitudIds: ['o1', 'o2'],
    montoBruto: 100, gastosDescontados: conGastos ? 10 : 0, montoTotal: conGastos ? 90 : 100, gastosIds: conGastos ? ['g1'] : [],
    ...opts.storkhub,
  });
}

const NOTA = 'No depositó, indicó que utilizó el dinero';
// uid === null simula "sin sesión" (un parámetro por defecto convertiría undefined en 'g1').
const convertir = (w: Mundo, uid: string | null = 'g1', data: unknown = { depositoId: 'D1', nota: NOTA }) =>
  convertirDepositoEnDeudaCore(w.deps, uid ?? undefined, data);

const flagsDe = (w: Mundo, id: string) => (w.get(`solicitudes_envio/${id}`)!.registro as { deposito: Doc }).deposito;

// ── F4A-FC1 · autenticación ───────────────────────────────────────────────────
test('F4A-FC1 · sin sesión ⇒ unauthenticated, y no se escribe nada', async () => {
  const w = mundo(); sembrar(w);
  const antes = w.snapshot();
  await assert.rejects(convertir(w, null), codigo('unauthenticated'));
  assert.equal(w.snapshot(), antes);
});

// ── F4A-FC2 · roles ───────────────────────────────────────────────────────────
test('F4A-FC2 · solo gestor y admin ACTIVOS convierten: digitador, motorizado, comercio, cuenta de baja o inexistente ⇒ permission-denied', async () => {
  for (const uid of ['dig', 'mot', 'com', 'baja', 'noexiste']) {
    const w = mundo(); sembrar(w);
    const antes = w.snapshot();
    await assert.rejects(convertir(w, uid), codigo('permission-denied'), uid);
    assert.equal(w.snapshot(), antes, uid + ': sin efectos');
  }
  for (const uid of ['g1', 'a1']) {
    const w = mundo(); sembrar(w);
    assert.equal((await convertir(w, uid)).resultado, 'convertido', uid);
  }
});

// ── F4A-FC3 · inexistente ─────────────────────────────────────────────────────
test('F4A-FC3 · depósito inexistente ⇒ not-found', async () => {
  const w = mundo(); sembrar(w);
  await assert.rejects(convertir(w, 'g1', { depositoId: 'nada', nota: NOTA }), codigo('not-found'));
  assert.equal(w.escrituras, 0);
});

// ── F4A-FC4 · estados convertibles ────────────────────────────────────────────
test('F4A-FC4 · pendiente_boucher, en_revision y devuelto abren una conversión', async () => {
  assert.deepEqual([...ESTADOS_CONVERTIBLES].sort(), ['devuelto', 'en_revision', 'pendiente_boucher']);
  for (const estado of ESTADOS_CONVERTIBLES) {
    const w = mundo(); sembrar(w, { estado });
    const r = await convertir(w);
    assert.equal(r.resultado, 'convertido', estado);
    assert.equal(r.estadoAnterior, estado);
    assert.equal(w.get('ordenes_deposito/D1')!.estado, 'convertido_en_deuda', estado);
  }
});

test('F4A-FC4b · un depósito que no es Storkhub (comercio, tipo C) no se convierte ⇒ tipo_no_convertible', async () => {
  const a = mundo(); sembrar(a, { comercio: true });
  await assert.rejects(convertir(a), codigo('failed-precondition', 'tipo_no_convertible'));
  const b = mundo(); sembrar(b, { storkhub: { tipo: 'pago_delivery_deposito' } });
  await assert.rejects(convertir(b), codigo('failed-precondition', 'tipo_no_convertible'));
  assert.equal(a.escrituras + b.escrituras, 0);
});

// ── F4A-FC5 · confirmado NO se convierte ──────────────────────────────────────
test('F4A-FC5 · un depósito CONFIRMADO no se convierte (doble efecto con su conf_*) ⇒ confirmado_no_convertible, sin efectos', async () => {
  const w = mundo(); sembrar(w, { estado: 'confirmado' });
  w.put('movimientos_financieros/conf_ev1', { depositoId: 'D1', estado: 'activo', tipo: 'deposito_efectivo_storkhub', monto: 90 });
  const antes = w.snapshot();
  await assert.rejects(convertir(w, 'a1'), codigo('failed-precondition', 'confirmado_no_convertible'));
  await assert.rejects(convertir(w, 'g1'), codigo('failed-precondition', 'confirmado_no_convertible'));
  assert.equal(w.snapshot(), antes);
  assert.equal(w.saldos().length, 0);
  assert.equal(w.movimientos().length, 1);
});

// ── F4A-FC6 · otros estados ───────────────────────────────────────────────────
test('F4A-FC6 · anulado, rechazado y cualquier otro estado ⇒ estado_cambio, sin efectos', async () => {
  for (const estado of ['anulado', 'rechazado', 'otro', '']) {
    const w = mundo(); sembrar(w, { estado });
    const antes = w.snapshot();
    await assert.rejects(convertir(w), codigo('failed-precondition', 'estado_cambio'), estado);
    assert.equal(w.snapshot(), antes, estado);
  }
});

// ── F4A-FC7 · conversión válida crea saldo ────────────────────────────────────
test('F4A-FC7 · conversión válida: UN saldo nuevo con el monto DEMOSTRADO, estado pendiente y actor del servidor', async () => {
  const w = mundo(); sembrar(w);
  const r = await convertir(w, 'a1');
  assert.deepEqual({ ...r }, {
    ok: true, resultado: 'convertido', depositoId: 'D1', saldoId: 'sal1', movimientoId: 'conv_sal1',
    montoTotal: 90, estadoAnterior: 'en_revision', estadoNuevo: 'convertido_en_deuda',
  });
  const s = w.saldos();
  assert.equal(s.length, 1);
  assert.deepEqual({ ...s[0] }, {
    id: 'sal1', motorizadoId: MOT_DOC, motorizadoUid: MOT_AUTH, motorizadoNombre: 'Luigi',
    tipo: 'deposito_no_realizado', montoOriginal: 90, saldoPendiente: 90, estado: 'pendiente',
    origen: 'deposito', depositoId: 'D1', fecha: TS(1), nota: NOTA, creadoPorUid: 'a1', createdAt: TS(1), abonos: [],
  });
});

// ── F4A-FC8 · depósito convertido con backlink ────────────────────────────────
test('F4A-FC8 · el depósito queda convertido con su saldoId, la nota y el actor; el monto no se reescribe', async () => {
  const w = mundo(); sembrar(w);
  await convertir(w, 'g1');
  const d = w.get('ordenes_deposito/D1')!;
  assert.equal(d.estado, 'convertido_en_deuda');
  assert.equal(d.saldoId, 'sal1');
  assert.equal(d.notaConversion, NOTA);
  assert.equal(d.convertidoPorUid, 'g1', 'el actor sale de request.auth');
  assert.deepEqual(d.convertidoAt, TS(1), 'la hora la pone el servidor');
  assert.equal(d.montoTotal, 90);
  assert.equal(d.ultimoEventoId, undefined, 'la conversión no escribe evento');
});

// ── F4A-FC9 · órdenes ─────────────────────────────────────────────────────────
test('F4A-FC9 · TODAS las órdenes quedan cerradas y apuntando al depósito (mismos campos que confirmar)', async () => {
  const w = mundo(); sembrar(w);
  await convertir(w);
  for (const id of ['o1', 'o2']) {
    const dep = flagsDe(w, id);
    assert.equal(dep.confirmadoStorkhub, true, id);
    assert.deepEqual(dep.confirmadoStorkhubAt, TS(1), id);
    assert.equal(dep.storkhubDepositoId, 'D1', id);
  }
});

// ── F4A-FC10 · ledger ─────────────────────────────────────────────────────────
test('F4A-FC10 · exactamente UN movimiento activo de conversión, con monto, cuentas y referencias', async () => {
  const w = mundo(); sembrar(w);
  await convertir(w, 'a1');
  const movs = w.movimientos();
  assert.equal(movs.length, 1);
  assert.deepEqual({ ...movs[0] }, {
    id: 'conv_sal1', tipo: 'deposito_convertido_en_deuda', monto: 90, at: TS(1), creadoPorUid: 'a1', creadoPorRol: 'gestor',
    descripcion: `Depósito convertido en deuda · Luigi · ${NOTA}`, estado: 'activo', motorizadoId: MOT_DOC,
    depositoId: 'D1', saldoId: 'sal1', cuentaOrigen: `efectivo_en_poder:${MOT_DOC}`, cuentaDestino: `deuda_motorizado:${MOT_DOC}`,
    propietario: 'storkhub',
  });
});

test('F4A-FC10b · el depósito no marca confirmado: no hay movimiento de depósito_efectivo ni evento', async () => {
  const w = mundo(); sembrar(w);
  await convertir(w);
  assert.equal(w.movimientos().filter((m) => String(m.tipo).startsWith('deposito_efectivo')).length, 0);
});

// ── F4A-FC11 · monto manipulado ───────────────────────────────────────────────
test('F4A-FC11 · el monto del documento se DEMUESTRA: total, bruto o gastos manipulados ⇒ monto_inconsistente, 0 efectos', async () => {
  for (const alterado of [{ montoTotal: 9000 }, { montoTotal: 1 }, { montoBruto: 500 }, { gastosDescontados: 0, montoTotal: 100 }, { gastosDescontados: 50 }]) {
    const w = mundo(); sembrar(w, { storkhub: alterado });
    const antes = w.snapshot();
    await assert.rejects(convertir(w), codigo('failed-precondition', 'monto_inconsistente'), JSON.stringify(alterado));
    assert.equal(w.snapshot(), antes);
    assert.equal(w.saldos().length, 0);
    assert.equal(w.movimientos().length, 0);
  }
});

test('F4A-FC11b · el monto del saldo sale de las órdenes, no de lo que diga el cliente', async () => {
  const w = mundo(); sembrar(w);
  // el cliente intenta imponer monto, saldo y actor: invalid-argument, nada se escribe
  for (const malo of [{ depositoId: 'D1', nota: NOTA, monto: 1 }, { depositoId: 'D1', nota: NOTA, saldoId: 'x' }, { depositoId: 'D1', nota: NOTA, uid: 'a1' }]) {
    await assert.rejects(convertir(w, 'g1', malo), codigo('invalid-argument'));
  }
  assert.equal((await convertir(w)).montoTotal, 90);
});

// ── F4A-FC12 · órdenes manipuladas ────────────────────────────────────────────
test('F4A-FC12 · órdenes inválidas (inexistente, no entregada, de otro motorizado, de otro depósito) ⇒ orden_invalida, 0 efectos', async () => {
  const casos: Array<[string, (w: Mundo) => void]> = [
    ['inexistente', (w) => w.put('ordenes_deposito/D1', { ...w.get('ordenes_deposito/D1')!, solicitudIds: ['o1', 'fantasma'] })],
    ['no entregada', (w) => w.put('solicitudes_envio/o2', orden({ estado: 'en_camino_entrega' }))],
    ['otro motorizado', (w) => w.put('solicitudes_envio/o2', orden({ asignacion: { motorizadoAuthUid: 'otro' } }))],
    ['sin asignación', (w) => w.put('solicitudes_envio/o2', orden({ asignacion: undefined }))],
    ['otro depósito', (w) => w.put('solicitudes_envio/o2', orden({ registro: { deposito: { storkhubDepositoId: 'DX' } } }))],
  ];
  for (const [nombre, preparar] of casos) {
    const w = mundo(); sembrar(w); preparar(w);
    const antes = w.snapshot();
    await assert.rejects(convertir(w), codigo('failed-precondition', 'orden_invalida'), nombre);
    assert.equal(w.snapshot(), antes, nombre);
    assert.equal(w.saldos().length + w.movimientos().length, 0, nombre);
  }
  const sin = mundo(); sembrar(sin, { storkhub: { solicitudIds: [] } });
  await assert.rejects(convertir(sin), codigo('failed-precondition', 'sin_ordenes'));
});

test('F4A-FC12b · una orden que ya apunta a ESTE depósito (revertir con boucher la deja así) sí cuenta', async () => {
  const w = mundo(); sembrar(w);
  w.put('solicitudes_envio/o2', orden({ registro: { deposito: { storkhubDepositoId: 'D1', confirmadoStorkhub: false } } }));
  assert.equal((await convertir(w)).resultado, 'convertido');
});

// ── F4A-FC13 · gastos manipulados ─────────────────────────────────────────────
test('F4A-FC13 · gastos inválidos (FIN-2) ⇒ rechazado, 0 efectos; y sin marca NO se debilita (depende del backfill)', async () => {
  const base = { motorizadoId: MOT_DOC, estado: 'aprobado', monto: 10, consumidoEnDepositoId: 'D1' };
  const casos: Array<[string, Doc | null, string]> = [
    ['inexistente', null, 'gasto_invalido'],
    ['de otro motorizado', { ...base, motorizadoId: 'otro' }, 'gasto_invalido'],
    ['no aprobado', { ...base, estado: 'anulado' }, 'gasto_invalido'],
    ['consumido por OTRO depósito', { ...base, consumidoEnDepositoId: 'D9' }, 'gasto_invalido'],
    ['ya descontado en una liquidación', { ...base, liquidacionId: 'L1' }, 'gasto_invalido'],
    ['monto inválido', { ...base, monto: 0 }, 'gasto_invalido'],
    ['sin marca de consumo (anterior a FIN-2)', { motorizadoId: MOT_DOC, estado: 'aprobado', monto: 10 }, 'gasto_sin_marca'],
  ];
  for (const [nombre, gasto, motivo] of casos) {
    const w = mundo(); sembrar(w);
    if (gasto === null) w.put('ordenes_deposito/D1', { ...w.get('ordenes_deposito/D1')!, gastosIds: ['fantasma'] });
    else w.put('gastos_motorizado/g1', gasto);
    const antes = w.snapshot();
    await assert.rejects(convertir(w), codigo('failed-precondition', motivo), nombre);
    assert.equal(w.snapshot(), antes, nombre);
  }
});

test('F4A-FC13b · FIN-4A NO vuelve a consumir ni libera gastos: quedan exactamente como estaban', async () => {
  const w = mundo(); sembrar(w);
  const antes = w.get('gastos_motorizado/g1');
  await convertir(w);
  assert.deepEqual(w.get('gastos_motorizado/g1'), antes);
});

// ── F4A-FC14 · sin gastos ─────────────────────────────────────────────────────
test('F4A-FC14 · depósito sin gastos convierte sin exigir marcas, por el bruto', async () => {
  const w = mundo(); sembrar(w, { gastos: false });
  const r = await convertir(w);
  assert.equal(r.resultado, 'convertido');
  assert.equal(r.montoTotal, 100);
  assert.equal(w.saldos()[0].saldoPendiente, 100);
  assert.equal(w.movimientos()[0].monto, 100);
});

test('F4A-FC14b · si los gastos cubren todo el bruto no hay deuda que crear ⇒ monto_cero', async () => {
  const w = mundo(); sembrar(w, { storkhub: { montoTotal: 0, gastosDescontados: 120, gastosIds: ['g1'] } });
  w.put('gastos_motorizado/g1', { motorizadoId: MOT_DOC, estado: 'aprobado', monto: 120, consumidoEnDepositoId: 'D1' });
  const antes = w.snapshot();
  await assert.rejects(convertir(w), codigo('failed-precondition', 'monto_cero'));
  assert.equal(w.snapshot(), antes);
});

// ── F4A-FC15 · retry ──────────────────────────────────────────────────────────
test('F4A-FC15 · retry tras perder la respuesta: ya_convertido, el MISMO saldo y movimiento, y CERO escrituras nuevas', async () => {
  const w = mundo(); sembrar(w);
  const primera = await convertir(w);
  const escrituras = w.escrituras;
  const antes = w.snapshot();
  const segunda = await convertir(w, 'g2');
  assert.equal(segunda.resultado, 'ya_convertido');
  assert.equal(segunda.saldoId, primera.saldoId);
  assert.equal(segunda.movimientoId, primera.movimientoId);
  assert.equal(segunda.montoTotal, 90);
  assert.equal(w.escrituras, escrituras, 'ninguna escritura');
  assert.equal(w.snapshot(), antes);
  assert.equal(w.saldos().length, 1);
  assert.equal(w.movimientos().length, 1);
  assert.equal(w.get('ordenes_deposito/D1')!.saldoId, primera.saldoId, 'el saldoId no se pisa');
});

// ── F4A-FC16 · concurrencia ───────────────────────────────────────────────────
test('F4A-FC16 · dos gestores a la vez: UNA conversión efectiva, un saldo, un movimiento, un saldoId final', async () => {
  const w = mundo(); sembrar(w);
  const [a, b] = await Promise.all([convertir(w, 'g1'), convertir(w, 'g2')]);
  assert.deepEqual([a.resultado, b.resultado].sort(), ['convertido', 'ya_convertido']);
  assert.equal(a.saldoId, b.saldoId, 'ambas respuestas nombran el mismo saldo');
  assert.equal(w.saldos().length, 1);
  assert.equal(w.movimientos().length, 1);
  assert.equal(w.movimientos().filter((m) => m.estado === 'activo').length, 1);
  assert.equal(w.get('ordenes_deposito/D1')!.saldoId, a.saldoId);
});

test('F4A-FC16b · cinco llamadas simultáneas (doble clic, pestañas, reintentos) ⇒ un solo efecto', async () => {
  const w = mundo(); sembrar(w);
  const rs = await Promise.all(['g1', 'g1', 'g2', 'a1', 'g1'].map((u) => convertir(w, u)));
  assert.equal(rs.filter((r) => r.resultado === 'convertido').length, 1);
  assert.equal(rs.filter((r) => r.resultado === 'ya_convertido').length, 4);
  assert.equal(w.saldos().length, 1);
  assert.equal(w.movimientos().length, 1);
  assert.equal(new Set(rs.map((r) => r.saldoId)).size, 1);
});

// ── F4A-FC17 · atomicidad ─────────────────────────────────────────────────────
test('F4A-FC17 · si una escritura falla dentro de la transacción, NADA queda aplicado (ni saldo, ni depósito, ni órdenes, ni ledger)', async () => {
  for (const fallo of ['solicitudes_envio/o2', 'movimientos_financieros/conv_sal1', 'saldos_cargo_motorizado/sal1', 'ordenes_deposito/D1']) {
    const w = mundo(); sembrar(w);
    const antes = w.snapshot();
    w.hooks.fallarSi = (_op, ruta) => ruta === fallo;
    await assert.rejects(convertir(w), /fallo simulado/, fallo);
    assert.equal(w.snapshot(), antes, 'sin efectos parciales cuando falla ' + fallo);
    assert.equal(w.saldos().length + w.movimientos().length, 0);
    // y después de un fallo, el reintento funciona y deja UN solo efecto
    w.hooks.fallarSi = undefined;
    const r = await convertir(w);
    assert.equal(r.resultado, 'convertido');
    assert.equal(w.saldos().length, 1);
    assert.equal(w.movimientos().length, 1);
  }
});

// ── F4A-FC18 · convertido inconsistente ───────────────────────────────────────
function convertidoCon(w: Mundo, quitar: string) {
  sembrar(w, { estado: 'convertido_en_deuda', storkhub: { saldoId: 'salX', notaConversion: NOTA } });
  const saldo = { motorizadoId: MOT_DOC, tipo: 'deposito_no_realizado', origen: 'deposito', depositoId: 'D1', montoOriginal: 90, saldoPendiente: 90, estado: 'pendiente' };
  const mov = { tipo: 'deposito_convertido_en_deuda', depositoId: 'D1', saldoId: 'salX', monto: 90, estado: 'activo' };
  if (quitar !== 'saldo') w.put('saldos_cargo_motorizado/salX', quitar === 'saldo_anulado' ? { ...saldo, estado: 'anulado' } : quitar === 'saldo_ajeno' ? { ...saldo, origen: 'manual' } : saldo);
  if (quitar !== 'movimiento') w.put('movimientos_financieros/conv_salX', quitar === 'movimiento_de_otro_saldo' ? { ...mov, saldoId: 'otro' } : mov);
  if (quitar === 'movimientos_multiples') w.put('movimientos_financieros/dup', { ...mov });
  if (quitar === 'saldos_multiples') w.put('saldos_cargo_motorizado/salY', saldo);
  if (quitar === 'sin_saldoId') { const d = w.get('ordenes_deposito/D1')!; delete d.saldoId; w.put('ordenes_deposito/D1', d as Doc); }
}

test('F4A-FC18 · un depósito "convertido" al que le falta o le sobra una pieza NO devuelve falso éxito: conversion_inconsistente, 0 escrituras', async () => {
  for (const quitar of ['saldo', 'saldo_anulado', 'saldo_ajeno', 'movimiento', 'movimiento_de_otro_saldo', 'movimientos_multiples', 'saldos_multiples', 'sin_saldoId']) {
    const w = mundo(); convertidoCon(w, quitar);
    const antes = w.snapshot();
    await assert.rejects(convertir(w), codigo('failed-precondition', 'conversion_inconsistente'), quitar);
    assert.equal(w.snapshot(), antes, quitar);
    assert.equal(w.escrituras, 0, quitar);
  }
  // y el caso sano de la misma fixture SÍ es idempotente
  const ok = mundo(); convertidoCon(ok, 'nada');
  const r = await convertir(ok);
  assert.equal(r.resultado, 'ya_convertido');
  assert.equal(r.saldoId, 'salX');
  assert.equal(r.movimientoId, 'conv_salX');
  assert.equal(ok.escrituras, 0);
});

test('F4A-FC18b · un movimiento de condonación activo junto a la conversión es legítimo (no cuenta como duplicado)', async () => {
  const w = mundo(); convertidoCon(w, 'nada');
  w.put('movimientos_financieros/cond', { tipo: 'deuda_condonada', depositoId: 'D1', saldoId: 'salX', monto: 90, estado: 'activo' });
  assert.equal((await convertir(w)).resultado, 'ya_convertido');
});

// ── F4A-FC19 · futuro ciclo ───────────────────────────────────────────────────
/** Lo que deja una reversión coherente (FIN-4B, hoy no implementada): ciclo cerrado y depósito otra vez convertible. */
function cerrarCiclo(w: Mundo, saldoId: string, conservarPuntero: boolean) {
  const s = w.get(`saldos_cargo_motorizado/${saldoId}`)!;
  w.put(`saldos_cargo_motorizado/${saldoId}`, { ...s, estado: 'anulado', motivoAnulacion: 'revertido_por_error' });
  const movId = `conv_${saldoId}`;
  const m = w.get(`movimientos_financieros/${movId}`)!;
  w.put(`movimientos_financieros/${movId}`, { ...m, estado: 'anulado', motivoAnulacion: 'Conversión en deuda revertida por error' });
  const d = w.get('ordenes_deposito/D1')!;
  delete d.notaConversion; delete d.convertidoPorUid; delete d.convertidoAt;
  if (!conservarPuntero) delete d.saldoId;
  w.put('ordenes_deposito/D1', { ...d, estado: 'en_revision' } as Doc);
  for (const id of ['o1', 'o2']) {
    const o = w.get(`solicitudes_envio/${id}`)!;
    w.put(`solicitudes_envio/${id}`, { ...o, registro: { deposito: { storkhubDepositoId: 'D1', confirmadoStorkhub: false, confirmadoStorkhubAt: null } } });
  }
  w.bump();
}

test('F4A-FC19 · un ciclo anterior CERRADO no bloquea una conversión futura: saldo y movimiento NUEVOS, sin reutilizar los viejos', async () => {
  for (const conservarPuntero of [false, true]) {
    const w = mundo(); sembrar(w);
    const c1 = await convertir(w);
    cerrarCiclo(w, c1.saldoId, conservarPuntero);
    const c2 = await convertir(w, 'a1', { depositoId: 'D1', nota: 'segunda conversión' });
    assert.equal(c2.resultado, 'convertido', 'conservarPuntero=' + conservarPuntero);
    assert.notEqual(c2.saldoId, c1.saldoId);
    assert.notEqual(c2.movimientoId, c1.movimientoId);
    assert.equal(w.saldos().length, 2);
    assert.equal(w.saldos().filter((s) => s.estado !== 'anulado').length, 1, 'un solo saldo vivo');
    assert.equal(w.movimientos().filter((m) => m.estado === 'activo').length, 1, 'un solo movimiento activo');
    assert.equal(w.movimientos().find((m) => m.id === c1.movimientoId)!.estado, 'anulado', 'el ciclo viejo no se toca');
    assert.equal(w.get('ordenes_deposito/D1')!.saldoId, c2.saldoId);
    // y dentro del ciclo nuevo el reintento vuelve a ser idempotente
    assert.equal((await convertir(w, 'g1')).resultado, 'ya_convertido');
    assert.equal(w.saldos().length, 2);
  }
});

test('F4A-FC19b · un ciclo anterior VIVO sí bloquea: saldo previo vivo, o movimiento activo previo ⇒ rechazado sin efectos', async () => {
  const a = mundo(); sembrar(a);
  a.put('saldos_cargo_motorizado/viejo', { depositoId: 'D1', estado: 'abonado_parcial', origen: 'deposito', tipo: 'deposito_no_realizado' });
  const antesA = a.snapshot();
  await assert.rejects(convertir(a), codigo('failed-precondition', 'saldo_previo_vivo'));
  assert.equal(a.snapshot(), antesA);
  // backlink colgando hacia un saldo vivo que ni siquiera lleva depositoId
  const b = mundo(); sembrar(b, { storkhub: { saldoId: 'huerfano' } });
  b.put('saldos_cargo_motorizado/huerfano', { estado: 'pendiente' });
  await assert.rejects(convertir(b), codigo('failed-precondition', 'saldo_previo_vivo'));
  // movimiento activo previo
  const c = mundo(); sembrar(c);
  c.put('movimientos_financieros/viejo', { depositoId: 'D1', estado: 'activo', tipo: 'deposito_convertido_en_deuda', saldoId: 'x', monto: 90 });
  await assert.rejects(convertir(c), codigo('failed-precondition', 'ledger_inconsistente'));
  assert.equal(c.escrituras, 0);
});

// ── F4A-FC20 · payload ────────────────────────────────────────────────────────
test('F4A-FC20 · el payload solo admite depositoId y nota: nada de monto, estado, actor, órdenes ni saldo ⇒ invalid-argument', async () => {
  const w = mundo(); sembrar(w);
  for (const malo of [null, [], 'D1', {}, { depositoId: '', nota: NOTA }, { depositoId: 5, nota: NOTA }, { depositoId: 'D1' },
    { depositoId: 'D1', nota: '' }, { depositoId: 'D1', nota: '   ' }, { depositoId: 'D1', nota: 5 }, { depositoId: 'D1', nota: 'x'.repeat(501) },
    { depositoId: 'D1', nota: NOTA, montoTotal: 1 }, { depositoId: 'D1', nota: NOTA, estado: 'convertido_en_deuda' },
    { depositoId: 'D1', nota: NOTA, solicitudIds: ['o1'] }, { depositoId: 'D1', nota: NOTA, motorizadoId: 'm' },
    { depositoId: 'D1', nota: NOTA, creadoPorUid: 'a1' }, { depositoId: 'D1', nota: NOTA, saldoPendiente: 1 }, { nota: NOTA }]) {
    await assert.rejects(convertir(w, 'g1', malo), codigo('invalid-argument'), JSON.stringify(malo));
  }
  assert.deepEqual(validarPeticionConversion({ depositoId: '  D1  ', nota: '  motivo  ' }), { depositoId: 'D1', nota: 'motivo' }, 'se normaliza');
  assert.equal(w.escrituras, 0);
});

// ── La nota no decide nada financiero ─────────────────────────────────────────
test('F4A-NOTA · la nota solo viaja como metadata: cambia el texto, no el monto ni el saldo', async () => {
  const a = mundo(); sembrar(a);
  const b = mundo(); sembrar(b);
  const ra = await convertir(a, 'g1', { depositoId: 'D1', nota: 'uno' });
  const rb = await convertir(b, 'g1', { depositoId: 'D1', nota: 'otro motivo distinto' });
  assert.equal(ra.montoTotal, rb.montoTotal);
  assert.equal(a.saldos()[0].saldoPendiente, b.saldos()[0].saldoPendiente);
});

// ── Contrato del adaptador real: nada financiero fuera de la transacción ──────
// El núcleo se prueba con un mundo en memoria; esto ata al ADAPTADOR de Firestore
// (el que corre en producción) a la misma garantía: saldo y movimiento se crean con
// tx.create dentro de runTransaction, jamás con un write suelto.
test('F4A-AT1 · el adaptador crea saldo y movimiento SOLO con tx.create dentro de runTransaction, y el núcleo hace una sola transacción', () => {
  const norm = (p: string[]) => readFileSync(join(__dirname, ...p), 'utf8').replace(/\r\n/g, '\n');
  const callable = norm(['..', '..', 'src', 'conversion-deposito-deuda-callable.ts']);
  const nucleo = norm(['..', '..', 'src', 'conversion-deposito-deuda.ts']);
  const codigo = callable.replace(/\/\/.*$/gm, '');
  assert.match(codigo, /crearSaldo: \(id, campos\) => \{ tx\.create\(db\.collection\('saldos_cargo_motorizado'\)\.doc\(id\), campos\); \}/);
  assert.match(codigo, /crearMovimiento: \(id, campos\) => \{ tx\.create\(db\.collection\('movimientos_financieros'\)\.doc\(id\), campos\); \}/);
  assert.equal((codigo.match(/db\.runTransaction\(/g) ?? []).length, 1, 'una sola transacción');
  // ningún write de Admin SDK fuera de tx: ni .add( ni .set( ni .create( ni .update( ni batch
  const sinTx = codigo.replace(/tx\.(create|update)\(/g, 'TX_$1(');
  for (const w of ['.add(', '.set(', '.create(', '.update(', '.batch(', 'bulkWriter']) assert.ok(!sinTx.includes(w), `sin ${w} fuera de la transacción`);
  // el núcleo: una sola transacción y el movimiento sin registrarMovimiento
  assert.equal((nucleo.match(/deps\.transaction\(/g) ?? []).length, 1);
  const codigoNucleo = nucleo.replace(/\/\/.*$/gm, '');
  assert.ok(!codigoNucleo.includes('registrarMovimiento') && !codigoNucleo.includes('addDoc'));
  assert.ok(nucleo.includes('tx.crearSaldo(') && nucleo.includes('tx.crearMovimiento(') && nucleo.includes('tx.updateDeposito(') && nucleo.includes('tx.updateSolicitud('));
});
