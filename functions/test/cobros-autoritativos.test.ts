// FIN-1C-A — registrarCobroDelivery, revertirCobroDelivery y registrarPagoCobroSemanal: cobros AUTORITATIVOS.
//
// El "mundo" simula lo que importa de Firestore (transacciones optimistas con reintento, escrituras todo-o-nada, create()/update(),
// campos con punto y FieldValue.delete()), como en depositos-autoritativos.test.ts. La prueba con el emulador real vive en el runtime.
import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { DocumentData } from 'firebase-admin/firestore';
import { registrarCobroDeliveryCore, type DepsCobro } from '../src/registrar-cobro-delivery';
import { revertirCobroDeliveryCore, type DepsReversion } from '../src/revertir-cobro-delivery';
import { registrarPagoCobroSemanalCore, type DepsPagoSemanal } from '../src/registrar-pago-cobro-semanal';
import { calcularMontoCobroDelivery } from '../src/cobro-delivery-monto';
import { validarPeticionCobro, validarPeticionPagoSemanal, validarPeticionReversion, MAX_ORDENES_POR_LOTE_COBRO } from '../src/cobro-acciones-comun';

type Doc = Record<string, unknown>;
const TS = (n: number) => ({ __ms: n });
const ELIMINAR = { __eliminar: true };
const codigo = (code: string, motivo?: string) => (e: unknown) => {
  const err = e as { code?: string; details?: { motivo?: string } };
  return err.code === code && (motivo === undefined || err.details?.motivo === motivo);
};

function revivir(v: unknown): unknown {
  if (Array.isArray(v)) return v.map(revivir);
  if (v && typeof v === 'object') {
    const o = v as Record<string, unknown>;
    if (typeof o.__ms === 'number') { const ms = o.__ms; return { __ms: ms, toMillis: () => ms }; }
    return Object.fromEntries(Object.entries(o).map(([k, x]) => [k, revivir(x)]));
  }
  return v;
}

/** Inversa de revivir: lo que se vuelve a escribir al mundo no lleva funciones (un Timestamp real sí se reescribe como valor). */
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
    const ultimo = partes[partes.length - 1];
    if (v && typeof v === 'object' && (v as Doc).__eliminar === true) delete cur[ultimo];
    else cur[ultimo] = structuredClone(desvivir(v));
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

  async function correr<T>(fn: (tx: never) => Promise<T>): Promise<T> {
    for (;;) {
      const inicio = revision;
      const cola: Array<{ op: string; ruta: string; datos: Doc }> = [];
      const q = (op: string, ruta: string, datos: Doc) => { cola.push({ op, ruta, datos }); };
      const tx = {
        async getUsuario(uid: string) { return get(`usuarios/${uid}`); },
        async getSolicitud(id: string) { return get(`solicitudes_envio/${id}`); },
        async getMovimiento(id: string) { return get(`movimientos_financieros/${id}`); },
        async getDeposito(id: string) { return get(`ordenes_deposito/${id}`); },
        async getOperacion(id: string) { return get(`operaciones_cobro/${id}`); },
        async getCobroSemanal(id: string) { return get(`cobros_semanales/${id}`); },
        async getMovimientosDeSolicitud(id: string) { return filtrar('movimientos_financieros/', (d) => d.solicitudId === id); },
        updateSolicitud(id: string, c: Doc) { q('update', `solicitudes_envio/${id}`, c); },
        updateMovimiento(id: string, c: Doc) { q('update', `movimientos_financieros/${id}`, c); },
        updateDeposito(id: string, c: Doc) { q('update', `ordenes_deposito/${id}`, c); },
        updateCobroSemanal(id: string, c: Doc) { q('update', `cobros_semanales/${id}`, c); },
        crearMovimiento(id: string, c: Doc) { q('create', `movimientos_financieros/${id}`, c); },
        crearDeposito(id: string, c: Doc) { q('create', `ordenes_deposito/${id}`, c); },
        crearOperacion(id: string, c: Doc) { q('create', `operaciones_cobro/${id}`, c); },
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
  const depsCobro: DepsCobro = { transaction: correr as DepsCobro['transaction'], serverTimestamp: () => TS(++relojes) };
  const depsRev: DepsReversion = { transaction: correr as DepsReversion['transaction'], serverTimestamp: () => TS(++relojes), borrar: () => ELIMINAR };
  const depsSem: DepsPagoSemanal = { transaction: correr as DepsPagoSemanal['transaction'], serverTimestamp: () => TS(++relojes), ahora: () => TS(++relojes) };
  return {
    depsCobro, depsRev, depsSem, hooks, put, get, raw, bump: () => { revision++; },
    get escrituras() { return escrituras; },
    snapshot: () => JSON.stringify([...store].sort(([a], [b]) => a.localeCompare(b))),
    movimientos: () => filtrar('movimientos_financieros/', () => true),
    depositos: () => filtrar('ordenes_deposito/', () => true),
    operaciones: () => filtrar('operaciones_cobro/', () => true),
  };
}
type Mundo = ReturnType<typeof mundo>;

const OP = 'op-12345678';
const OP2 = 'op-87654321';

function usuarios(w: Mundo) {
  w.put('usuarios/a1', { activo: true, rol: 'admin' });
  w.put('usuarios/g1', { activo: true, rol: 'gestor' });
  w.put('usuarios/dig', { activo: true, rol: 'digitador' });
  w.put('usuarios/baja', { activo: false, rol: 'gestor' });
}

/** Orden entregada, de contado, con su cobro pendiente por 100. */
function orden(w: Mundo, id: string, extra: Doc = {}, cobro: Doc | null | undefined = undefined) {
  const base: Doc = {
    estado: 'entregado',
    tipoCliente: 'contado',
    pagoDelivery: { quienPaga: 'entrega' },
    confirmacion: { precioFinalCordobas: 100 },
    asignacion: { motorizadoId: 'mot1', motorizadoNombre: 'Luigi' },
    ownerSnapshot: { companyName: 'Tienda Sol' },
    registro: { deposito: {} },
    ...extra,
  };
  if (cobro !== null) base.cobroDelivery = { monto: 100, tipoCliente: 'contado', quienPaga: 'entrega', estado: 'pendiente', registradoAt: TS(1), ...(cobro ?? {}) };
  w.put(`solicitudes_envio/${id}`, base);
}
const conBoucher = { estado: 'en_revision_deposito', boucherVigente: 'gestor', boucherGestor: { url: 'https://e/b.jpg', path: 'p' } };

const cobrar = (w: Mundo, uid: string | undefined, d: Doc) => registrarCobroDeliveryCore(w.depsCobro, uid, d);
const revertir = (w: Mundo, uid: string | undefined, d: Doc) => revertirCobroDeliveryCore(w.depsRev, uid, d);
const pagarSem = (w: Mundo, uid: string | undefined, d: Doc) => registrarPagoCobroSemanalCore(w.depsSem, uid, d);
const pet = (ordenIds: string[], formaPago = 'efectivo', extra: Doc = {}) => ({ operacionId: OP, ordenIds, formaPago, ...extra });

// ═══ COBRO ═══════════════════════════════════════════════════════════════════

test('FIN1C-C1 · efectivo individual: la orden queda pagada, un pago_recibido activo y SIN DEP tipo C', async () => {
  const w = mundo(); usuarios(w); orden(w, 'S1');
  const r = await cobrar(w, 'g1', pet(['S1'], 'efectivo', { nota: ' recibido en caja ' }));
  assert.equal(r.resultado, 'registrado'); assert.equal(r.total, 100); assert.deepEqual(r.depositoIds, []);
  const o = w.raw('solicitudes_envio/S1') as { cobroDelivery: Doc };
  assert.equal(o.cobroDelivery.estado, 'pagado'); assert.equal(o.cobroDelivery.formaPago, 'efectivo');
  assert.equal(o.cobroDelivery.metodoPagoReal, 'efectivo'); assert.equal(o.cobroDelivery.confirmadoPor, 'g1');
  assert.equal(o.cobroDelivery.notaPago, 'recibido en caja'); assert.equal(o.cobroDelivery.movimientoPagoId, `pago_${OP}_S1`);
  const movs = w.movimientos();
  assert.equal(movs.length, 1); assert.equal(movs[0].data.tipo, 'pago_recibido'); assert.equal(movs[0].data.monto, 100);
  assert.equal(movs[0].data.estado, 'activo'); assert.equal(movs[0].data.solicitudId, 'S1'); assert.equal(movs[0].data.creadoPorRol, 'gestor');
  assert.equal(w.depositos().length, 0);
  assert.equal(w.operaciones().length, 1);
});

test('FIN1C-C2 · transferencia individual: un DEP tipo C confirmado, puntero y confirmación en la orden, movimiento con depositoId', async () => {
  const w = mundo(); usuarios(w); orden(w, 'S1', {}, conBoucher);
  const r = await cobrar(w, 'a1', pet(['S1'], 'transferencia'));
  assert.equal(r.depositoIds.length, 1);
  const dep = w.depositos()[0];
  assert.equal(dep.data.tipo, 'pago_delivery_deposito'); assert.equal(dep.data.estado, 'confirmado'); assert.equal(dep.data.montoTotal, 100);
  assert.deepEqual(dep.data.solicitudIds, ['S1']); assert.equal(dep.data.boucherUrl, 'https://e/b.jpg'); assert.equal(dep.data.confirmadoPorUid, 'a1');
  assert.equal(dep.data.destinatario, 'storkhub'); assert.equal(dep.data.motorizadoUid, 'mot1');
  const o = w.raw('solicitudes_envio/S1') as { cobroDelivery: Doc; registro: { deposito: Doc } };
  assert.equal(o.registro.deposito.storkhubDepositoId, dep.id); assert.equal(o.registro.deposito.confirmadoStorkhub, true);
  assert.equal(o.cobroDelivery.metodoPagoReal, 'transferencia_deposito');
  assert.equal(w.movimientos()[0].data.depositoId, dep.id); assert.equal(w.movimientos()[0].data.creadoPorRol, 'admin');
});

test('FIN1C-C3 · lote en efectivo: todas las órdenes y un movimiento por orden, en una sola operación', async () => {
  const w = mundo(); usuarios(w); orden(w, 'S1'); orden(w, 'S2', { confirmacion: { precioFinalCordobas: 60 } }, { monto: 60 }); orden(w, 'S3');
  const r = await cobrar(w, 'g1', pet(['S1', 'S2', 'S3']));
  assert.equal(r.total, 260); assert.equal(w.movimientos().length, 3); assert.equal(w.operaciones().length, 1);
  for (const id of ['S1', 'S2', 'S3']) assert.equal((w.raw(`solicitudes_envio/${id}`) as { cobroDelivery: Doc }).cobroDelivery.estado, 'pagado');
});

test('FIN1C-C4 · lote por transferencia: UN DEP tipo C por orden (no uno agrupado)', async () => {
  const w = mundo(); usuarios(w); orden(w, 'S1', {}, conBoucher); orden(w, 'S2', {}, conBoucher);
  const r = await cobrar(w, 'g1', pet(['S1', 'S2'], 'transferencia'));
  assert.equal(r.depositoIds.length, 2); assert.equal(w.depositos().length, 2);
  for (const d of w.depositos()) assert.equal((d.data.solicitudIds as string[]).length, 1);
  assert.notEqual(r.depositoIds[0], r.depositoIds[1]);
});

test('FIN1C-C5 · el cliente NO manda monto, estado, actor, rol ni movimientos: cualquier campo extra se rechaza', async () => {
  const w = mundo(); usuarios(w); orden(w, 'S1');
  for (const extra of [{ monto: 1 }, { estado: 'pagado' }, { actorUid: 'x' }, { rol: 'admin' }, { movimientoId: 'm' }, { depositoId: 'd' }, { cobroDelivery: {} }]) {
    await assert.rejects(cobrar(w, 'g1', pet(['S1'], 'efectivo', extra)), codigo('invalid-argument'));
  }
  assert.equal(w.escrituras, 0);
  assert.throws(() => validarPeticionCobro({ operacionId: OP, ordenIds: ['S1'], formaPago: 'cheque' }), codigo('invalid-argument'));
  assert.throws(() => validarPeticionCobro({ operacionId: 'corto', ordenIds: ['S1'], formaPago: 'efectivo' }), codigo('invalid-argument'));
  assert.throws(() => validarPeticionCobro({ operacionId: OP, ordenIds: [], formaPago: 'efectivo' }), codigo('invalid-argument'));
  assert.throws(() => validarPeticionCobro(null), codigo('invalid-argument'));
});

test('FIN1C-C6 · monto guardado distinto del que sale de la fórmula ⇒ monto_inconsistente y nada se escribe', async () => {
  const w = mundo(); usuarios(w); orden(w, 'S1', {}, { monto: 999 }); orden(w, 'S2');
  await assert.rejects(cobrar(w, 'g1', pet(['S2', 'S1'])), codigo('failed-precondition', 'monto_inconsistente'));
  assert.equal(w.escrituras, 0);
});

test('FIN1C-C7 · delivery deducido del CE: cobra el faltante recalculado; el precio de lista guardado por el bug viejo se rechaza', async () => {
  const w = mundo(); usuarios(w);
  const ce = { pagoDelivery: { quienPaga: 'entrega', deducirDelCobroContraEntrega: true }, cobroContraEntrega: { aplica: true, monto: 100 }, confirmacion: { precioFinalCordobas: 130 } };
  orden(w, 'OK', ce, { monto: 30, montoDelivery: 130, cubiertoPorDeposito: 100 });
  orden(w, 'MAL', ce, { monto: 130 });
  assert.equal(calcularMontoCobroDelivery(w.get('solicitudes_envio/OK')!).monto, 30);
  const r = await cobrar(w, 'g1', pet(['OK']));
  assert.equal(r.total, 30);
  await assert.rejects(cobrar(w, 'g1', { ...pet(['MAL']), operacionId: OP2 }), codigo('failed-precondition', 'monto_inconsistente'));
});

test('FIN1C-C8 · una orden ya pagada rechaza TODO el lote (nada parcial); no se cobra dos veces', async () => {
  const w = mundo(); usuarios(w); orden(w, 'S1'); orden(w, 'S2', {}, { estado: 'pagado', formaPago: 'efectivo' }); orden(w, 'S3');
  await assert.rejects(cobrar(w, 'g1', pet(['S1', 'S2', 'S3'])), codigo('failed-precondition', 'orden_ya_pagada'));
  assert.equal(w.escrituras, 0);
  assert.equal(w.movimientos().length, 0);
});

test('FIN1C-C9 · no entregada, crédito, no cobrable e incidencia abierta se rechazan con su motivo', async () => {
  const w = mundo(); usuarios(w);
  orden(w, 'A', { estado: 'en_camino_entrega' });
  orden(w, 'B', { tipoCliente: 'credito' });
  orden(w, 'B2', { pagoDelivery: { quienPaga: 'credito_semanal' } });
  orden(w, 'C', {}, { estado: 'no_cobrar' });
  orden(w, 'D', { cobroPendiente: true });
  const casos: Array<[string, string]> = [['A', 'orden_no_entregada'], ['B', 'orden_credito'], ['B2', 'orden_credito'], ['C', 'orden_no_cobrable'], ['D', 'incidencia_abierta']];
  for (const [id, motivo] of casos) await assert.rejects(cobrar(w, 'g1', pet([id])), codigo('failed-precondition', motivo));
  await assert.rejects(cobrar(w, 'g1', pet(['NOEXISTE'])), codigo('not-found'));
  assert.equal(w.escrituras, 0);
});

test('FIN1C-C10 · una transferencia exige el boucher vigente de la orden', async () => {
  const w = mundo(); usuarios(w); orden(w, 'S1');
  await assert.rejects(cobrar(w, 'g1', pet(['S1'], 'transferencia')), codigo('failed-precondition', 'boucher_requerido'));
  orden(w, 'S2', {}, { estado: 'en_revision_deposito', boucherVigente: 'gestor', boucherComercio: { url: 'https://e/c.jpg' } });
  await assert.rejects(cobrar(w, 'g1', { ...pet(['S2'], 'transferencia'), operacionId: OP2 }), codigo('failed-precondition', 'boucher_requerido'));
  orden(w, 'S3', {}, { estado: 'en_revision_deposito', boucherVigente: 'comercio', boucherComercio: { url: 'https://e/c.jpg' } });
  const r = await cobrar(w, 'g1', { ...pet(['S3'], 'transferencia'), operacionId: 'op-aaaaaaaa' });
  assert.equal(w.get(`ordenes_deposito/${r.depositoIds[0]}`)!.boucherUrl, 'https://e/c.jpg');
  // Efectivo no exige boucher.
  orden(w, 'S4'); await cobrar(w, 'g1', { ...pet(['S4']), operacionId: 'op-bbbbbbbb' });
});

test('FIN1C-C11 · puntero_ocupado: la orden ya apunta a un depósito de Storkhub o figura confirmada', async () => {
  const w = mundo(); usuarios(w);
  orden(w, 'S1', { registro: { deposito: { storkhubDepositoId: 'DEPX' } } }, conBoucher);
  orden(w, 'S2', { registro: { deposito: { confirmadoStorkhub: true } } }, conBoucher);
  await assert.rejects(cobrar(w, 'g1', pet(['S1'], 'transferencia')), codigo('failed-precondition', 'puntero_ocupado'));
  await assert.rejects(cobrar(w, 'g1', pet(['S2'], 'transferencia')), codigo('failed-precondition', 'puntero_ocupado'));
  assert.equal(w.escrituras, 0);
});

test('FIN1C-C12 · si la orden figura por cobrar pero ya tiene un pago_recibido activo ⇒ conciliacion_requerida (no se duplica el ledger)', async () => {
  const w = mundo(); usuarios(w); orden(w, 'S1');
  w.put('movimientos_financieros/viejo', { tipo: 'pago_recibido', estado: 'activo', solicitudId: 'S1', monto: 100 });
  await assert.rejects(cobrar(w, 'g1', pet(['S1'])), codigo('failed-precondition', 'conciliacion_requerida'));
  // Un pago ya anulado NO bloquea (es el caso de revertir y volver a cobrar).
  w.put('movimientos_financieros/viejo', { tipo: 'pago_recibido', estado: 'anulado', solicitudId: 'S1', monto: 100 });
  const r = await cobrar(w, 'g1', { ...pet(['S1']), operacionId: OP2 });
  assert.equal(r.resultado, 'registrado');
});

test('FIN1C-C13 · idempotencia: el retry de la misma operación responde ya_registrado SIN escribir; otra orden con la misma operación se rechaza', async () => {
  const w = mundo(); usuarios(w); orden(w, 'S1'); orden(w, 'S2');
  const a = await cobrar(w, 'g1', pet(['S1']));
  const antes = w.snapshot();
  const b = await cobrar(w, 'g1', pet(['S1']));
  assert.equal(b.resultado, 'ya_registrado'); assert.deepEqual(b.movimientoIds, a.movimientoIds); assert.equal(b.total, 100);
  assert.equal(w.snapshot(), antes);
  await assert.rejects(cobrar(w, 'g1', pet(['S2'])), codigo('failed-precondition', 'operacion_inconsistente'));
  await assert.rejects(cobrar(w, 'g1', pet(['S1'], 'transferencia')), codigo('failed-precondition', 'operacion_inconsistente'));
  assert.equal(w.movimientos().length, 1);
});

test('FIN1C-C14 · solo admin o gestor ACTIVO; el rol sale de usuarios/{uid}', async () => {
  const w = mundo(); usuarios(w); orden(w, 'S1');
  await assert.rejects(cobrar(w, undefined, pet(['S1'])), codigo('unauthenticated'));
  for (const uid of ['dig', 'baja', 'nadie']) await assert.rejects(cobrar(w, uid, pet(['S1'])), codigo('permission-denied'));
  assert.equal(w.escrituras, 0);
  await cobrar(w, 'g1', pet(['S1']));
});

test('FIN1C-C15 · orden legacy SIN cobroDelivery: el servidor lo crea con el monto recalculado', async () => {
  const w = mundo(); usuarios(w); orden(w, 'S1', { pagoDelivery: { quienPaga: 'transferencia' } }, null);
  await cobrar(w, 'g1', pet(['S1']));
  const cd = (w.raw('solicitudes_envio/S1') as { cobroDelivery: Doc }).cobroDelivery;
  assert.equal(cd.monto, 100); assert.equal(cd.tipoCliente, 'contado'); assert.equal(cd.quienPaga, 'transferencia'); assert.equal(cd.estado, 'pagado');
  assert.ok(cd.registradoAt);
});

test('FIN1C-C16 · cobro clasificado por Cobros (sin monto guardado): el servidor fija el monto recalculado', async () => {
  const w = mundo(); usuarios(w); orden(w, 'S1', {}, { monto: undefined });
  const o = w.raw('solicitudes_envio/S1') as { cobroDelivery: Doc }; delete o.cobroDelivery.monto; w.put('solicitudes_envio/S1', o);
  await cobrar(w, 'g1', pet(['S1']));
  assert.equal((w.raw('solicitudes_envio/S1') as { cobroDelivery: Doc }).cobroDelivery.monto, 100);
});

test('FIN1C-C17 · tope del lote y órdenes repetidas', async () => {
  const w = mundo(); usuarios(w);
  const muchas = Array.from({ length: MAX_ORDENES_POR_LOTE_COBRO + 1 }, (_, i) => `S${i}`);
  await assert.rejects(cobrar(w, 'g1', pet(muchas)), codigo('failed-precondition', 'demasiadas_ordenes'));
  await assert.rejects(cobrar(w, 'g1', pet(['S1', 'S1'])), codigo('invalid-argument'));
  const justas = Array.from({ length: MAX_ORDENES_POR_LOTE_COBRO }, (_, i) => { orden(w, `L${i}`); return `L${i}`; });
  assert.equal((await cobrar(w, 'g1', pet(justas))).movimientoIds.length, MAX_ORDENES_POR_LOTE_COBRO);
});

test('FIN1C-C18 · atomicidad: un fallo de escritura a mitad del lote no deja nada (ni orden, ni movimiento, ni DEP, ni marcador)', async () => {
  const w = mundo(); usuarios(w); orden(w, 'S1', {}, conBoucher); orden(w, 'S2', {}, conBoucher);
  const antes = w.snapshot();
  w.hooks.fallarSi = (_op, ruta) => ruta.startsWith('movimientos_financieros/') && ruta.endsWith('S2');
  await assert.rejects(cobrar(w, 'g1', pet(['S1', 'S2'], 'transferencia')), /fallo simulado/);
  assert.equal(w.snapshot(), antes);
});

test('FIN1C-C19 · race: dos gestores cobran la misma orden con operaciones distintas ⇒ exactamente un pago activo', async () => {
  const w = mundo(); usuarios(w); orden(w, 'S1');
  w.hooks.antesDeCommit = () => {
    // Entre la lectura y el commit del PRIMERO, el otro gestor cobra la orden.
    const o = w.raw('solicitudes_envio/S1') as { cobroDelivery: Doc };
    o.cobroDelivery.estado = 'pagado'; w.put('solicitudes_envio/S1', o);
    w.put('movimientos_financieros/otro', { tipo: 'pago_recibido', estado: 'activo', solicitudId: 'S1', monto: 100 });
    w.bump();
  };
  await assert.rejects(cobrar(w, 'g1', pet(['S1'])), codigo('failed-precondition', 'orden_ya_pagada'));
  assert.equal(w.movimientos().filter((m) => m.data.estado === 'activo').length, 1);
  const w2 = mundo(); usuarios(w2); orden(w2, 'S1');
  const [x, y] = await Promise.allSettled([cobrar(w2, 'g1', pet(['S1'])), cobrar(w2, 'a1', { ...pet(['S1']), operacionId: OP2 })]);
  assert.equal([x, y].filter((r) => r.status === 'fulfilled').length, 1);
  assert.equal(w2.movimientos().filter((m) => m.data.estado === 'activo').length, 1);
});

// ═══ REVERSIÓN ═══════════════════════════════════════════════════════════════

const revPet = (ordenId: string, operacionId = OP) => ({ operacionId, ordenId });

async function pagada(w: Mundo, id: string, forma: 'efectivo' | 'transferencia' = 'efectivo', op = 'pago-' + id + '-xxxx') {
  orden(w, id, {}, forma === 'transferencia' ? conBoucher : undefined);
  await cobrar(w, 'g1', { operacionId: op, ordenIds: [id], formaPago: forma });
}

test('FIN1C-R1 · revertir un cobro en efectivo: movimiento anulado, cobro pendiente, campos del pago borrados y rastro conservado', async () => {
  const w = mundo(); usuarios(w); await pagada(w, 'S1');
  const r = await revertir(w, 'g1', revPet('S1'));
  assert.equal(r.resultado, 'revertido'); assert.equal(r.depositoAnuladoId, null);
  const cd = (w.raw('solicitudes_envio/S1') as { cobroDelivery: Doc }).cobroDelivery;
  assert.equal(cd.estado, 'pendiente'); assert.equal(cd.monto, 100);
  for (const k of ['pagadoAt', 'formaPago', 'notaPago', 'confirmadoPor', 'confirmadoAt', 'metodoPagoReal']) assert.ok(!(k in cd), k);
  assert.equal(cd.movimientoPagoId, r.movimientoId); assert.equal(cd.revertidoPorUid, 'g1');
  const m = w.get(`movimientos_financieros/${r.movimientoId}`)!;
  assert.equal(m.estado, 'anulado'); assert.equal(m.anuladoPorUid, 'g1'); assert.equal(m.anuladoPorRol, 'gestor'); assert.ok(m.motivoAnulacion);
});

test('FIN1C-R2 · revertir una transferencia: anula el DEP tipo C y libera la orden', async () => {
  const w = mundo(); usuarios(w); await pagada(w, 'S1', 'transferencia');
  const depId = w.depositos()[0].id;
  const r = await revertir(w, 'a1', revPet('S1'));
  assert.equal(r.depositoAnuladoId, depId);
  const dep = w.get(`ordenes_deposito/${depId}`)!;
  assert.equal(dep.estado, 'anulado'); assert.equal(dep.anuladoPorUid, 'a1');
  const o = w.raw('solicitudes_envio/S1') as { registro: { deposito: Doc } };
  assert.equal(o.registro.deposito.storkhubDepositoId, null); assert.equal(o.registro.deposito.confirmadoStorkhub, false); assert.equal(o.registro.deposito.confirmadoStorkhubAt, null);
});

test('FIN1C-R3 · legacy SIN movimientoPagoId: se revierte solo si hay EXACTAMENTE un pago activo y coherente', async () => {
  const w = mundo(); usuarios(w);
  orden(w, 'S1', {}, { estado: 'pagado', formaPago: 'efectivo' });
  w.put('movimientos_financieros/L1', { tipo: 'pago_recibido', estado: 'activo', solicitudId: 'S1', monto: 100 });
  const r = await revertir(w, 'g1', revPet('S1'));
  assert.equal(r.movimientoId, 'L1'); assert.equal(w.get('movimientos_financieros/L1')!.estado, 'anulado');
});

test('FIN1C-R4 · legacy: 0 pagos activos, varios, o de monto distinto ⇒ conciliacion_requerida y nada cambia', async () => {
  const w = mundo(); usuarios(w);
  orden(w, 'CERO', {}, { estado: 'pagado' });
  orden(w, 'DOS', {}, { estado: 'pagado' });
  w.put('movimientos_financieros/d1', { tipo: 'pago_recibido', estado: 'activo', solicitudId: 'DOS', monto: 100 });
  w.put('movimientos_financieros/d2', { tipo: 'pago_recibido', estado: 'activo', solicitudId: 'DOS', monto: 100 });
  orden(w, 'MONTO', {}, { estado: 'pagado' });
  w.put('movimientos_financieros/m1', { tipo: 'pago_recibido', estado: 'activo', solicitudId: 'MONTO', monto: 70 });
  w.put('movimientos_financieros/anul', { tipo: 'pago_recibido', estado: 'anulado', solicitudId: 'CERO', monto: 100 });
  const antes = w.snapshot();
  for (const id of ['CERO', 'DOS', 'MONTO']) await assert.rejects(revertir(w, 'g1', revPet(id)), codigo('failed-precondition', 'conciliacion_requerida'));
  assert.equal(w.snapshot(), antes);
});

test('FIN1C-R5 · movimientoPagoId inconsistente (inexistente, de otra orden, de otro tipo, ya anulado, o con otro pago activo) ⇒ conciliacion_requerida', async () => {
  const w = mundo(); usuarios(w);
  const conPuntero = (id: string, mov: string) => orden(w, id, {}, { estado: 'pagado', movimientoPagoId: mov });
  conPuntero('A', 'noexiste');
  conPuntero('B', 'ajeno'); w.put('movimientos_financieros/ajeno', { tipo: 'pago_recibido', estado: 'activo', solicitudId: 'OTRA', monto: 100 });
  conPuntero('C', 'otrotipo'); w.put('movimientos_financieros/otrotipo', { tipo: 'deposito_efectivo_storkhub', estado: 'activo', solicitudId: 'C', monto: 100 });
  conPuntero('D', 'anul'); w.put('movimientos_financieros/anul', { tipo: 'pago_recibido', estado: 'anulado', solicitudId: 'D', monto: 100 });
  conPuntero('E', 'e1'); w.put('movimientos_financieros/e1', { tipo: 'pago_recibido', estado: 'activo', solicitudId: 'E', monto: 100 });
  w.put('movimientos_financieros/e2', { tipo: 'pago_recibido', estado: 'activo', solicitudId: 'E', monto: 100 });
  const antes = w.snapshot();
  for (const id of ['A', 'B', 'C', 'D', 'E']) await assert.rejects(revertir(w, 'g1', revPet(id)), codigo('failed-precondition', 'conciliacion_requerida'));
  assert.equal(w.snapshot(), antes);
});

test('FIN1C-R6 · una orden que no está pagada ⇒ cobro_no_pagado; inexistente ⇒ not-found; crédito ⇒ orden_credito', async () => {
  const w = mundo(); usuarios(w); orden(w, 'S1'); orden(w, 'C', { tipoCliente: 'credito' }, { estado: 'pagado' });
  await assert.rejects(revertir(w, 'g1', revPet('S1')), codigo('failed-precondition', 'cobro_no_pagado'));
  await assert.rejects(revertir(w, 'g1', revPet('NOEXISTE')), codigo('not-found'));
  await assert.rejects(revertir(w, 'g1', revPet('C')), codigo('failed-precondition', 'orden_credito'));
  assert.equal(w.escrituras, 0);
});

test('FIN1C-R7 · DEP tipo C de varias órdenes, o inexistente ⇒ conciliacion_requerida', async () => {
  const w = mundo(); usuarios(w); await pagada(w, 'S1', 'transferencia');
  const depId = w.depositos()[0].id;
  const dep = w.raw(`ordenes_deposito/${depId}`); dep.solicitudIds = ['S1', 'S2']; w.put(`ordenes_deposito/${depId}`, dep);
  await assert.rejects(revertir(w, 'g1', revPet('S1')), codigo('failed-precondition', 'conciliacion_requerida'));
  const w2 = mundo(); usuarios(w2);
  orden(w2, 'S1', { registro: { deposito: { storkhubDepositoId: 'FANTASMA', confirmadoStorkhub: true } } }, { estado: 'pagado', movimientoPagoId: 'm1' });
  w2.put('movimientos_financieros/m1', { tipo: 'pago_recibido', estado: 'activo', solicitudId: 'S1', monto: 100 });
  await assert.rejects(revertir(w2, 'g1', revPet('S1')), codigo('failed-precondition', 'conciliacion_requerida'));
  assert.equal(w2.get('movimientos_financieros/m1')!.estado, 'activo');
});

test('FIN1C-R8 · un depósito del MOTORIZADO (A/B) apuntado por la orden no se toca; un DEP tipo C ya anulado solo libera la orden', async () => {
  const w = mundo(); usuarios(w);
  orden(w, 'S1', { registro: { deposito: { storkhubDepositoId: 'DEPA', confirmadoStorkhub: true } } }, { estado: 'pagado', movimientoPagoId: 'm1' });
  w.put('movimientos_financieros/m1', { tipo: 'pago_recibido', estado: 'activo', solicitudId: 'S1', monto: 100 });
  w.put('ordenes_deposito/DEPA', { tipo: 'recaudacion_motorizado_storkhub', estado: 'confirmado', solicitudIds: ['S1', 'S9'] });
  const r = await revertir(w, 'g1', revPet('S1'));
  assert.equal(r.depositoAnuladoId, null);
  assert.equal(w.get('ordenes_deposito/DEPA')!.estado, 'confirmado');
  assert.equal(((w.raw('solicitudes_envio/S1') as { registro: { deposito: Doc } }).registro.deposito).storkhubDepositoId, 'DEPA');

  const w2 = mundo(); usuarios(w2);
  orden(w2, 'S1', { registro: { deposito: { storkhubDepositoId: 'DEPC', confirmadoStorkhub: true } } }, { estado: 'pagado', movimientoPagoId: 'm1' });
  w2.put('movimientos_financieros/m1', { tipo: 'pago_recibido', estado: 'activo', solicitudId: 'S1', monto: 100 });
  w2.put('ordenes_deposito/DEPC', { tipo: 'pago_delivery_deposito', estado: 'anulado', solicitudIds: ['S1'] });
  const r2 = await revertir(w2, 'g1', revPet('S1'));
  assert.equal(r2.depositoAnuladoId, null);
  assert.equal(((w2.raw('solicitudes_envio/S1') as { registro: { deposito: Doc } }).registro.deposito).storkhubDepositoId, null);
});

test('FIN1C-R9 · idempotencia: el retry responde ya_revertido SIN escribir; la misma operación en otra orden se rechaza', async () => {
  const w = mundo(); usuarios(w); await pagada(w, 'S1'); await pagada(w, 'S2');
  const a = await revertir(w, 'g1', revPet('S1'));
  const antes = w.snapshot();
  const b = await revertir(w, 'g1', revPet('S1'));
  assert.equal(b.resultado, 'ya_revertido'); assert.equal(b.movimientoId, a.movimientoId);
  assert.equal(w.snapshot(), antes);
  await assert.rejects(revertir(w, 'g1', revPet('S2')), codigo('failed-precondition', 'operacion_inconsistente'));
});

test('FIN1C-R10 · solo admin o gestor ACTIVO', async () => {
  const w = mundo(); usuarios(w); await pagada(w, 'S1');
  await assert.rejects(revertir(w, undefined, revPet('S1')), codigo('unauthenticated'));
  for (const uid of ['dig', 'baja', 'nadie']) await assert.rejects(revertir(w, uid, revPet('S1')), codigo('permission-denied'));
  assert.equal((w.get('movimientos_financieros/pago_pago-S1-xxxx_S1')!).estado, 'activo');
});

test('FIN1C-R11 · la petición es SOLO { operacionId, ordenId }: campos extra o inválidos se rechazan', () => {
  assert.throws(() => validarPeticionReversion({ operacionId: OP, ordenId: 'S1', movimientoId: 'm' }), codigo('invalid-argument'));
  assert.throws(() => validarPeticionReversion({ operacionId: OP, ordenId: 'S1', monto: 1 }), codigo('invalid-argument'));
  assert.throws(() => validarPeticionReversion({ operacionId: 'x', ordenId: 'S1' }), codigo('invalid-argument'));
  assert.throws(() => validarPeticionReversion({ operacionId: OP, ordenId: '' }), codigo('invalid-argument'));
  assert.throws(() => validarPeticionReversion([]), codigo('invalid-argument'));
});

test('FIN1C-R12 · ida y vuelta: revertir y volver a cobrar deja UN solo pago activo y el anulado como rastro', async () => {
  const w = mundo(); usuarios(w); await pagada(w, 'S1', 'transferencia');
  await revertir(w, 'g1', revPet('S1'));
  const o = w.raw('solicitudes_envio/S1') as { cobroDelivery: Doc }; o.cobroDelivery.estado = 'en_revision_deposito'; w.put('solicitudes_envio/S1', o);
  await cobrar(w, 'g1', { operacionId: 'op-nuevo-1234', ordenIds: ['S1'], formaPago: 'transferencia' });
  const movs = w.movimientos();
  assert.equal(movs.filter((m) => m.data.estado === 'activo').length, 1); assert.equal(movs.filter((m) => m.data.estado === 'anulado').length, 1);
  assert.equal(w.depositos().filter((d) => d.data.estado === 'confirmado').length, 1); assert.equal(w.depositos().filter((d) => d.data.estado === 'anulado').length, 1);
});

test('FIN1C-R13 · race: dos reversiones con operaciones distintas ⇒ una gana y la otra ve cobro_no_pagado', async () => {
  const w = mundo(); usuarios(w); await pagada(w, 'S1');
  const [x, y] = await Promise.allSettled([revertir(w, 'g1', revPet('S1')), revertir(w, 'a1', revPet('S1', OP2))]);
  assert.equal([x, y].filter((r) => r.status === 'fulfilled').length, 1);
  const rechazada = [x, y].find((r) => r.status === 'rejected') as PromiseRejectedResult;
  assert.ok(codigo('failed-precondition', 'cobro_no_pagado')(rechazada.reason));
  assert.equal(w.movimientos().filter((m) => m.data.estado === 'anulado').length, 1);
});

test('FIN1C-R14 · atomicidad: un fallo al anular el movimiento no deja la orden revertida ni el DEP anulado', async () => {
  const w = mundo(); usuarios(w); await pagada(w, 'S1', 'transferencia');
  const antes = w.snapshot();
  w.hooks.fallarSi = (_op, ruta) => ruta.startsWith('movimientos_financieros/');
  await assert.rejects(revertir(w, 'g1', revPet('S1')), /fallo simulado/);
  assert.equal(w.snapshot(), antes);
});

// ═══ PAGO DE CRÉDITO SEMANAL ═════════════════════════════════════════════════

function semana(w: Mundo, extra: Doc = {}) {
  w.put('cobros_semanales/C1_2026-W20', {
    clienteUid: 'C1', clienteNombre: 'Ana', clienteCompany: 'Tienda Luna', semanaKey: '2026-W20',
    totalMonto: 300, totalPagado: 0, estado: 'pendiente', pagos: [], ordenesIds: ['A', 'B', 'C'], ...extra,
  });
}
const pagoPet = (monto: unknown, pagoId = 'pago-aaaa-1111', extra: Doc = {}) => ({ pagoId, cobroSemanalId: 'C1_2026-W20', monto, ...extra });

test('FIN1C-S1 · pago parcial: estado parcial, pagos[] con la entrada y un pago_recibido determinista', async () => {
  const w = mundo(); usuarios(w); semana(w);
  const r = await pagarSem(w, 'g1', pagoPet(100, 'pago-aaaa-1111', { nota: ' ref 123 ' }));
  assert.equal(r.resultado, 'registrado'); assert.equal(r.estado, 'parcial'); assert.equal(r.totalPagado, 100); assert.equal(r.saldoPendiente, 200);
  const c = w.raw('cobros_semanales/C1_2026-W20') as { pagos: Doc[]; totalPagado: number; estado: string; totalMonto: number };
  assert.equal(c.totalPagado, 100); assert.equal(c.totalMonto, 300); assert.equal(c.pagos.length, 1);
  assert.equal(c.pagos[0].pagoId, 'pago-aaaa-1111'); assert.equal(c.pagos[0].registradoPor, 'g1'); assert.equal(c.pagos[0].nota, 'ref 123');
  const m = w.get('movimientos_financieros/pago_semanal_C1_2026-W20_pago-aaaa-1111')!;
  assert.equal(m.tipo, 'pago_recibido'); assert.equal(m.monto, 100); assert.equal(m.estado, 'activo'); assert.equal(m.comercioId, 'C1'); assert.equal(m.creadoPorRol, 'gestor');
});

test('FIN1C-S2 · el pago que salda la semana la deja pagada con pagadoAt; los pagos sucesivos acumulan', async () => {
  const w = mundo(); usuarios(w); semana(w);
  await pagarSem(w, 'g1', pagoPet(100, 'pago-aaaa-0001'));
  await pagarSem(w, 'a1', pagoPet(50.5, 'pago-aaaa-0002'));
  const r = await pagarSem(w, 'g1', pagoPet(149.5, 'pago-aaaa-0003'));
  assert.equal(r.estado, 'pagado'); assert.equal(r.totalPagado, 300); assert.equal(r.saldoPendiente, 0);
  const c = w.raw('cobros_semanales/C1_2026-W20') as { pagos: Doc[]; pagadoAt?: unknown };
  assert.equal(c.pagos.length, 3); assert.ok(c.pagadoAt);
  assert.equal(w.movimientos().length, 3);
});

test('FIN1C-S3 · un monto que excede el saldo real ⇒ saldo_insuficiente con el saldo, y nada se escribe', async () => {
  const w = mundo(); usuarios(w); semana(w, { totalPagado: 250 });
  await assert.rejects(pagarSem(w, 'g1', pagoPet(60)), (e: unknown) => codigo('failed-precondition', 'saldo_insuficiente')(e) && (e as { details: { saldoReal: number } }).details.saldoReal === 50);
  assert.equal(w.escrituras, 0);
  const r = await pagarSem(w, 'g1', pagoPet(50)); assert.equal(r.estado, 'pagado');
});

test('FIN1C-S4 · idempotencia: el retry del mismo pagoId responde ya_registrado SIN escribir, aunque el saldo ya no alcance', async () => {
  const w = mundo(); usuarios(w); semana(w, { totalMonto: 100 });
  await pagarSem(w, 'g1', pagoPet(100));
  const antes = w.snapshot();
  const r = await pagarSem(w, 'g1', pagoPet(100));
  assert.equal(r.resultado, 'ya_registrado'); assert.equal(w.snapshot(), antes);
  await assert.rejects(pagarSem(w, 'g1', pagoPet(40)), codigo('failed-precondition', 'operacion_inconsistente'));
});

test('FIN1C-S5 · un pagoId ya presente en pagos[] (versión anterior de la pantalla) o con movimiento determinista ya existente ⇒ ya_registrado', async () => {
  const w = mundo(); usuarios(w);
  semana(w, { totalPagado: 100, pagos: [{ pagoId: 'pago-viejo-0001', monto: 100, registradoPor: 'g1' }] });
  const antes = w.snapshot();
  assert.equal((await pagarSem(w, 'g1', pagoPet(100, 'pago-viejo-0001'))).resultado, 'ya_registrado');
  assert.equal(w.snapshot(), antes);
  w.put('movimientos_financieros/pago_semanal_C1_2026-W20_pago-viejo-0002', { tipo: 'pago_recibido', estado: 'activo', monto: 10 });
  const antes2 = w.snapshot();
  assert.equal((await pagarSem(w, 'g1', pagoPet(10, 'pago-viejo-0002'))).resultado, 'ya_registrado');
  assert.equal(w.snapshot(), antes2);
});

test('FIN1C-S6 · cobro inexistente ⇒ not-found; total inválido o total pagado inválido ⇒ cobro_semanal_invalido', async () => {
  const w = mundo(); usuarios(w);
  await assert.rejects(pagarSem(w, 'g1', pagoPet(10)), codigo('not-found'));
  for (const extra of [{ totalMonto: 0 }, { totalMonto: -5 }, { totalMonto: 'x' }, { totalPagado: 'x' }]) {
    semana(w, extra);
    await assert.rejects(pagarSem(w, 'g1', pagoPet(10)), codigo('failed-precondition', 'cobro_semanal_invalido'));
  }
  assert.equal(w.escrituras, 0);
});

test('FIN1C-S7 · monto inválido (0, negativo, NaN, texto, más de 2 decimales) y campos extra (totalPagado, estado…) se rechazan', async () => {
  const w = mundo(); usuarios(w); semana(w);
  for (const m of [0, -1, NaN, Infinity, '10', null, undefined, 10.123]) await assert.rejects(pagarSem(w, 'g1', pagoPet(m)), codigo('invalid-argument'));
  for (const extra of [{ totalPagado: 300 }, { estado: 'pagado' }, { totalMonto: 1 }, { actorUid: 'x' }, { pagos: [] }]) {
    await assert.rejects(pagarSem(w, 'g1', pagoPet(10, 'pago-aaaa-1111', extra)), codigo('invalid-argument'));
  }
  assert.throws(() => validarPeticionPagoSemanal({ pagoId: 'corto', cobroSemanalId: 'C1', monto: 5 }), codigo('invalid-argument'));
  assert.equal(w.escrituras, 0);
});

test('FIN1C-S8 · solo admin o gestor ACTIVO', async () => {
  const w = mundo(); usuarios(w); semana(w);
  await assert.rejects(pagarSem(w, undefined, pagoPet(10)), codigo('unauthenticated'));
  for (const uid of ['dig', 'baja', 'nadie']) await assert.rejects(pagarSem(w, uid, pagoPet(10)), codigo('permission-denied'));
  assert.equal(w.escrituras, 0);
});

test('FIN1C-S9 · un historial inconsistente (suma de pagos ≠ totalPagado) no se repara: manda totalPagado', async () => {
  const w = mundo(); usuarios(w); semana(w, { totalPagado: 120, pagos: [{ pagoId: 'p', monto: 100, registradoPor: 'g1' }] });
  const r = await pagarSem(w, 'g1', pagoPet(30));
  assert.equal(r.totalPagado, 150); assert.equal(r.saldoPendiente, 150);
  assert.equal(((w.raw('cobros_semanales/C1_2026-W20') as { pagos: Doc[] }).pagos).length, 2);
});

test('FIN1C-S10 · race: dos pagos que juntos exceden el saldo ⇒ el segundo ve el saldo real y se rechaza; atomicidad ante fallo', async () => {
  const w = mundo(); usuarios(w); semana(w, { totalMonto: 100 });
  const [x, y] = await Promise.allSettled([pagarSem(w, 'g1', pagoPet(80, 'pago-aaaa-0001')), pagarSem(w, 'a1', pagoPet(80, 'pago-aaaa-0002'))]);
  assert.equal([x, y].filter((r) => r.status === 'fulfilled').length, 1);
  assert.equal((w.raw('cobros_semanales/C1_2026-W20') as { totalPagado: number }).totalPagado, 80);
  assert.equal(w.movimientos().length, 1);
  const w2 = mundo(); usuarios(w2); semana(w2);
  const antes = w2.snapshot();
  w2.hooks.fallarSi = (_op, ruta) => ruta.startsWith('movimientos_financieros/');
  await assert.rejects(pagarSem(w2, 'g1', pagoPet(10)), /fallo simulado/);
  assert.equal(w2.snapshot(), antes);
});

// ═══ CONTRATO ════════════════════════════════════════════════════════════════

test('FIN1C-K1 · la fórmula del monto vive en UN módulo y la usan la entrega y las callables (sin copia)', () => {
  const src = (f: string) => readFileSync(join(__dirname, '..', '..', 'src', f), 'utf8');
  assert.ok(src('motorizado-transiciones.ts').includes("from './cobro-delivery-monto'"));
  assert.ok(src('registrar-cobro-delivery.ts').includes('calcularMontoCobroDelivery'));
  assert.ok(!/Math\.max\(0, precioDelivery/.test(src('motorizado-transiciones.ts')), 'la matemática del faltante ya no está duplicada');
  assert.ok(/Math\.max\(0, precioDelivery/.test(src('cobro-delivery-monto.ts')));
});
