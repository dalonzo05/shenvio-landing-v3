// A4-04 · P1-B (ruta alternativa) — confirmarPropuestaAbono aplica un abono con el comprobantePath de la
// PROPUESTA. Antes lo copiaba sin mirar: un digitador podía plantar `saldos/{id}/abono_N.jpg` (el slot que
// Storage sella por abonos.length) y confirmarlo. Ahora tiene que ser EXACTAMENTE el de esa propuesta.
import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { confirmarPropuestaAbonoCore } from '../src/propuestas-abono';
import { esComprobantePropuestaEsperado } from '../src/abono-directo';

type Doc = Record<string, unknown>;
const codigo = (code: string, motivo?: string) => (e: unknown) => {
  const err = e as { code?: string; details?: { motivo?: string } };
  return err.code === code && (motivo === undefined || err.details?.motivo === motivo);
};

// Firestore mínimo: lo que usa confirmarPropuestaAbonoCore. Escrituras atómicas al commit.
function fakeDb(docs: Record<string, Doc>) {
  const store = new Map(Object.entries(docs).map(([k, v]) => [k, structuredClone(v)]));
  let ids = 0;
  let escrituras = 0;
  const ref = (path: string) => ({ path, id: path.split('/')[1], get: async () => ({ exists: store.has(path), data: () => structuredClone(store.get(path)) }) });
  const db = {
    collection: (c: string) => ({ doc: (id?: string) => ref(`${c}/${id ?? `auto${++ids}`}`) }),
    async runTransaction<T>(fn: (tx: unknown) => Promise<T>): Promise<T> {
      const cola: Array<{ path: string; datos: Doc }> = [];
      const tx = {
        get: async (r: { path: string }) => ({ exists: store.has(r.path), data: () => structuredClone(store.get(r.path)) }),
        update: (r: { path: string }, datos: Doc) => { cola.push({ path: r.path, datos }); },
        set: (r: { path: string }, datos: Doc) => { cola.push({ path: r.path, datos }); },
      };
      const out = await fn(tx);
      for (const w of cola) {
        const previo = store.get(w.path) ?? {};
        const datos: Doc = { ...w.datos };
        // arrayUnion de Firestore: se resuelve contra el array previo (el resto de sentinels se guarda tal cual).
        for (const [k, v] of Object.entries(datos)) {
          const el = (v as { elements?: unknown[] } | null)?.elements;
          if (Array.isArray(el) && (v as object).constructor.name === 'ArrayUnionTransform') datos[k] = [...((previo[k] as unknown[]) ?? []), ...el];
        }
        store.set(w.path, { ...previo, ...datos }); escrituras++;
      }
      return out;
    },
  };
  return { db: db as unknown as FirebaseFirestore.Firestore, store, get escrituras() { return escrituras; } };
}

const sembrar = (comprobantePath: unknown, abonosPrevios = 0) => fakeDb({
  'usuarios/g1': { activo: true, rol: 'gestor' },
  'usuarios/dig': { activo: true, rol: 'digitador' },
  'saldos_cargo_motorizado/s1': {
    motorizadoId: 'motA', montoOriginal: 100, saldoPendiente: 100, estado: 'pendiente',
    abonos: Array.from({ length: abonosPrevios }, (_, i) => ({ monto: 1, operacionId: 'o' + i })),
  },
  'propuestas_abono_saldo/p1': {
    estado: 'pendiente', saldoId: 's1', monto: 40, metodoAbono: 'transferencia', nota: '', digitadoPorUid: 'dig',
    motorizadoId: 'motA', motorizadoNombre: 'Dickson', comprobanteUrl: 'https://ex.test/c.jpg',
    ...(comprobantePath === undefined ? {} : { comprobantePath }),
  },
});
const snap = (m: Map<string, Doc>) => JSON.stringify([...m].sort(([a], [b]) => a.localeCompare(b)));

test('ABP-P1 · helper de propuesta: solo saldos/{saldo}/propuestas/{propuesta}/comprobante.jpg exacto', () => {
  assert.equal(esComprobantePropuestaEsperado('s1', 'p1', 'saldos/s1/propuestas/p1/comprobante.jpg'), true);
  for (const m of ['saldos/s1/abono_0.jpg', 'saldos/s1/abono_5.jpg', 'saldos/s2/propuestas/p1/comprobante.jpg', 'saldos/s1/propuestas/p2/comprobante.jpg',
    'saldos/s1/propuestas/p1/x/comprobante.jpg', 'saldos/s1/propuestas/p1/otro.jpg', 'saldos/s1/propuestas/p1/comprobante.png', 'saldos/s1/propuestas/../abono_0.jpg', '', undefined, null, 5]) {
    assert.equal(esComprobantePropuestaEsperado('s1', 'p1', m), false, String(m));
  }
});

test('ABP-P2 · comprobante legítimo de la propuesta ⇒ se confirma y el abono apunta a ese path', async () => {
  const w = sembrar('saldos/s1/propuestas/p1/comprobante.jpg');
  const r = await confirmarPropuestaAbonoCore(w.db, 'g1', { propuestaId: 'p1' });
  assert.equal(r.ok, true);
  assert.equal(w.store.get('saldos_cargo_motorizado/s1')!.saldoPendiente, 60);
  assert.equal(((w.store.get('saldos_cargo_motorizado/s1')!.abonos as Doc[])[0]).comprobantePath, 'saldos/s1/propuestas/p1/comprobante.jpg');
  assert.equal(w.store.get('propuestas_abono_saldo/p1')!.estado, 'confirmado');
});

test('ABP-P3 · propuesta SIN comprobante (método sin comprobante) sigue confirmándose', async () => {
  const w = sembrar(undefined);
  assert.equal((await confirmarPropuestaAbonoCore(w.db, 'g1', { propuestaId: 'p1' })).ok, true);
});

test('ABP-P4 · propuesta con comprobantePath plantado abono_5 / abono_0 / ajeno ⇒ failed-precondition y 0 efecto financiero', async () => {
  for (const malo of ['saldos/s1/abono_5.jpg', 'saldos/s1/abono_0.jpg', 'saldos/s1/abono_1.jpg', 'saldos/s2/propuestas/p1/comprobante.jpg',
    'saldos/s1/propuestas/p9/comprobante.jpg', 'saldos/s1/../x.jpg', 'depositos/d1/boucher.jpg', '']) {
    for (const previos of [0, 1]) {
      const w = sembrar(malo, previos);
      const antes = snap(w.store);
      await assert.rejects(confirmarPropuestaAbonoCore(w.db, 'g1', { propuestaId: 'p1' }), codigo('failed-precondition', 'comprobante_path_invalido'), malo);
      assert.equal(snap(w.store), antes, 'saldo, abonos[], ledger y propuesta intactos: ' + malo);
      assert.equal(w.escrituras, 0);
      assert.equal(w.store.get('propuestas_abono_saldo/p1')!.estado, 'pendiente');
      assert.equal([...w.store.keys()].filter((k) => k.startsWith('movimientos_financieros/')).length, 0);
    }
  }
});

test('ABP-P5 · el resto del contrato de confirmarPropuestaAbono sigue: sin sesión, digitador y doble confirmación', async () => {
  const w = sembrar('saldos/s1/propuestas/p1/comprobante.jpg');
  await assert.rejects(confirmarPropuestaAbonoCore(w.db, undefined, { propuestaId: 'p1' }), codigo('unauthenticated'));
  await assert.rejects(confirmarPropuestaAbonoCore(w.db, 'dig', { propuestaId: 'p1' }), codigo('permission-denied'));
  await confirmarPropuestaAbonoCore(w.db, 'g1', { propuestaId: 'p1' });
  await assert.rejects(confirmarPropuestaAbonoCore(w.db, 'g1', { propuestaId: 'p1' }), codigo('failed-precondition'));
  assert.equal(w.store.get('saldos_cargo_motorizado/s1')!.saldoPendiente, 60);
});

test('ABP-P6 · la callable exportada delega en el núcleo (misma ruta, sin segundo camino)', () => {
  const src = readFileSync(join(__dirname, '..', '..', 'src', 'propuestas-abono.ts'), 'utf8').replace(/\/\/.*$/gm, '');
  assert.match(src, /export const confirmarPropuestaAbono = onCall<ConfirmarPayload>\(async \(request\) => \{\s*return confirmarPropuestaAbonoCore\(admin\.firestore\(\), request\.auth\?\.uid, request\.data\);/);
  assert.match(src, /esComprobantePropuestaEsperado\(saldoId, propuestaId, prop\.comprobantePath\)/);
});
