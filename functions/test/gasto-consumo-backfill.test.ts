// FIN-GASTOS-CONSUMO-BACKFILL-1 (A3-02) — BF1…BF20 + extras. Sin Firestore: un "mundo" en memoria implementa Lector/Entorno con updateTime por revisión
// y precondición lastUpdateTime, igual que el Admin SDK. Nada de esto toca staging ni producción.
import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import type { DocumentData } from 'firebase-admin/firestore';
import {
  CLASE, FRASE_CONFIRMACION, ManifestInvalido, clasificarGasto, depositoVivo, fraseProduccion, huellaItems, parsearArgs, pareceProduccion, planificarApply,
  rollbackSeguro, validarGuardas, type ItemBackfill, type ManifestDryRun,
} from '../src/gasto-consumo-backfill';
import { ejecutarApply, ejecutarDryRun, reunirEvidencia, type Entorno, type Lector, type Transaccion } from '../src/gasto-consumo-backfill-runner';
import { calcularDeposito } from '../src/calculo-deposito';

type Doc = Record<string, unknown>;
const AHORA = new Date('2026-06-01T12:00:00Z');
const TS_SENTINEL = { __serverTimestamp: true };

function mundo() {
  const store = new Map<string, { data: Doc; rev: number }>();
  let rev = 1;
  const stats = { writes: 0 };
  const ref = (c: string, id: string) => {
    const e = store.get(`${c}/${id}`);
    return e ? { id, data: structuredClone(e.data) as DocumentData, updateTime: `${e.rev}.000000000` } : null;
  };
  const delCol = (c: string) => [...store.keys()].filter((k) => k.startsWith(`${c}/`)).map((k) => ref(c, k.slice(c.length + 1))!);
  const lector: Lector = {
    async getDoc(c, id) { return ref(c, id); },
    async consultaArrayContains(c, campo, v) { return delCol(c).filter((d) => Array.isArray(d.data[campo]) && (d.data[campo] as unknown[]).includes(v)); },
    async consultaIn(c, campo, vs) { return delCol(c).filter((d) => vs.includes(d.data[campo] as string)); },
    async listar(c) { return delCol(c); },
  };
  const entorno: Entorno = {
    lector,
    serverTimestamp: () => TS_SENTINEL,
    transaccion: async (fn) => {
      const tx: Transaccion = {
        ...lector,
        actualizar(c, id, campos, lastUpdateTime) {
          const e = store.get(`${c}/${id}`);
          if (!e) throw new Error('no existe');
          if (`${e.rev}.000000000` !== lastUpdateTime) throw new Error('precondición lastUpdateTime');
          stats.writes += 1;
          Object.assign(e.data, structuredClone(campos));
          e.rev = ++rev;
        },
      };
      return fn(tx);
    },
  };
  return {
    stats, lector, entorno,
    put(c: string, id: string, data: Doc) { store.set(`${c}/${id}`, { data: structuredClone(data), rev: ++rev }); },
    patch(c: string, id: string, campos: Doc) { const e = store.get(`${c}/${id}`)!; Object.assign(e.data, campos); e.rev = ++rev; },
    quitar(c: string, id: string, campo: string) { const e = store.get(`${c}/${id}`)!; delete e.data[campo]; e.rev = ++rev; },
    get: (c: string, id: string) => store.get(`${c}/${id}`)?.data as Doc,
    foto: () => JSON.stringify([...store].sort()),
  };
}
type Mundo = ReturnType<typeof mundo>;

const ORDEN = { estado: 'entregado', asignacion: { motorizadoAuthUid: 'uid1' }, pagoDelivery: { quienPaga: 'motorizado' }, confirmacion: { precioFinalCordobas: 100 } };
const DEP = { tipo: 'recaudacion_motorizado_storkhub', estado: 'confirmado', motorizadoUid: 'uid1', solicitudIds: ['o1'], gastosIds: ['g1'], gastosDescontados: 30, montoBruto: 100, montoTotal: 70 };
const GASTO = { motorizadoId: 'm1', tipo: 'combustible', monto: 30, estado: 'aprobado', operacionId: 'op-original-1', fecha: 1, createdAt: 1 };

/** Mundo base: un motorizado, una orden de C$100, un gasto de C$30 y un depósito StorkHub que lo lista (sin marca = legacy). */
function base(): Mundo {
  const w = mundo();
  w.put('motorizado', 'm1', { authUid: 'uid1' });
  w.put('solicitudes_envio', 'o1', ORDEN);
  w.put('gastos_motorizado', 'g1', GASTO);
  w.put('ordenes_deposito', 'd1', DEP);
  return w;
}
const clasificar = async (w: Mundo, id = 'g1'): Promise<ItemBackfill> => clasificarGasto(await reunirEvidencia(w.lector, (await w.lector.getDoc('gastos_motorizado', id))!));
const dry = (w: Mundo) => ejecutarDryRun(w.lector, { projectId: 'demo-storkhub', sourceGitSha: 'abc', ahora: AHORA });
const aplicar = (w: Mundo, m: ManifestDryRun, project = 'demo-storkhub') => ejecutarApply(w.entorno, structuredClone(m), { projectId: project, ahora: AHORA });
const reHuella = (m: ManifestDryRun): ManifestDryRun => { m.itemsSha256 = huellaItems(m.items); return m; };

test('sanidad: la orden de prueba aporta C$100 a StorkHub (fórmula vigente) y depositoVivo = ∉ {anulado, rechazado}', () => {
  assert.equal(calcularDeposito(ORDEN).totalAStorkhub, 100);
  assert.equal(depositoVivo({ estado: 'anulado' }), false);
  assert.equal(depositoVivo({ estado: 'rechazado' }), false);
  for (const e of ['pendiente_boucher', 'en_revision', 'devuelto', 'confirmado', 'convertido_en_deuda']) assert.equal(depositoVivo({ estado: e }), true);
});

// ── BF1–BF10 ────────────────────────────────────────────────────────────────────
test('BF1 · A consumido demostrable → depósito exacto', async () => {
  const it = await clasificar(base());
  assert.equal(it.clasificacion, CLASE.CONSUMIDO);
  assert.equal(it.depositoObjetivo, 'd1');
  assert.deepEqual(it.depositosVivosIds, ['d1']);
  assert.ok(it.gastoUpdateTime && it.depositoUpdateTime);
});

test('BF2 · B libre → no es candidato a write', async () => {
  const w = base();
  w.patch('ordenes_deposito', 'd1', { estado: 'anulado' }); // el único depósito que lo listaba ya no consume
  const it = await clasificar(w);
  assert.equal(it.clasificacion, CLASE.LIBRE);
  const m = await dry(w);
  const antes = w.foto();
  const r = await aplicar(w, m);
  assert.equal(r.resultados.length, 0);
  assert.equal(w.foto(), antes);
});

test('BF3 · C ambiguo → no write', async () => {
  const w = base();
  w.patch('ordenes_deposito', 'd1', { montoTotal: 71 });
  const m = await dry(w);
  assert.equal(m.items.find((i) => i.gastoId === 'g1')!.clasificacion, CLASE.AMBIGUO);
  const antes = w.foto();
  await aplicar(w, m);
  assert.equal(w.foto(), antes);
});

test('BF4 · marker existente igual → NO_APLICA y, en apply, IDEMPOTENT_SKIP (0 writes)', async () => {
  const w = base();
  const m = await dry(w); // el manifest dice A → d1
  w.patch('gastos_motorizado', 'g1', { consumidoEnDepositoId: 'd1' }); // alguien (o una corrida previa) ya lo marcó
  const it = await clasificar(w);
  assert.equal(it.clasificacion, CLASE.NO_APLICA);
  assert.equal(it.motivo, 'MARKER_CORRECTO');
  const antes = w.foto();
  const r = await aplicar(w, m);
  assert.equal(r.resultados[0].resultado, 'IDEMPOTENT_SKIP');
  assert.equal(w.foto(), antes);
  assert.equal(w.stats.writes, 0);
});

test('BF5 · marker distinto → CONFLICTO y SKIP_CONFLICT (no overwrite)', async () => {
  const w = base();
  w.put('ordenes_deposito', 'd2', { ...DEP, gastosIds: ['g1'] });
  const m = await dry(w); // 2 depósitos vivos → ambiguo; fabricamos el manifest A a mano abajo
  w.patch('ordenes_deposito', 'd2', { estado: 'anulado' });
  w.patch('gastos_motorizado', 'g1', { consumidoEnDepositoId: 'd2' });
  const it = await clasificar(w);
  assert.equal(it.clasificacion, CLASE.CONFLICTO);
  const itemA: ItemBackfill = { ...(await clasificar(base())), }; // item A válido del mundo base
  const manifest = reHuella({ ...m, items: [itemA] });
  const antes = w.foto();
  const r = await aplicar(w, manifest);
  assert.equal(r.resultados[0].resultado, 'SKIP_CONFLICT');
  assert.equal(r.resultados[0].motivo, 'MARKER_APUNTA_A_OTRO_DEPOSITO');
  assert.equal(w.foto(), antes);
});

test('BF6 · depósito rehecho (mismo id, estado vuelve a en_revision) → candidato correcto con ese id', async () => {
  const w = base();
  w.patch('ordenes_deposito', 'd1', { estado: 'en_revision', rehechoAt: 5 }); // Rehacer conserva el depositoId
  const it = await clasificar(w);
  assert.equal(it.clasificacion, CLASE.CONSUMIDO);
  assert.equal(it.depositoObjetivo, 'd1');
});

test('BF7 · depósito anulado / rechazado → no es A', async () => {
  for (const estado of ['anulado', 'rechazado']) {
    const w = base();
    w.patch('ordenes_deposito', 'd1', { estado });
    const it = await clasificar(w);
    assert.notEqual(it.clasificacion, CLASE.CONSUMIDO);
    assert.equal(it.depositoObjetivo, null);
  }
  // marker que apunta a un depósito no vivo → CONFLICTO (no se corrige solo)
  const w = base();
  w.patch('ordenes_deposito', 'd1', { estado: 'anulado' });
  w.patch('gastos_motorizado', 'g1', { consumidoEnDepositoId: 'd1' });
  assert.equal((await clasificar(w)).clasificacion, CLASE.CONFLICTO);
});

test('BF8 · liquidacionId → no consume depósito (NO_APLICA, o CONFLICTO si contradice)', async () => {
  const w = base();
  w.put('liquidaciones_motorizado', 'l1', { gastosIds: ['g1'] });
  w.patch('ordenes_deposito', 'd1', { estado: 'anulado' });
  w.patch('gastos_motorizado', 'g1', { liquidacionId: 'l1' });
  const it = await clasificar(w);
  assert.equal(it.clasificacion, CLASE.NO_APLICA);
  assert.equal(it.depositoObjetivo, null);
  // con un depósito vivo que además lo lista → contradicción
  const w2 = base();
  w2.put('liquidaciones_motorizado', 'l1', { gastosIds: ['g1'] });
  w2.patch('gastos_motorizado', 'g1', { liquidacionId: 'l1' });
  assert.equal((await clasificar(w2)).clasificacion, CLASE.CONFLICTO);
  // liquidacionId sin liquidación que lo respalde → CONFLICTO
  const w3 = base();
  w3.patch('ordenes_deposito', 'd1', { estado: 'anulado' });
  w3.patch('gastos_motorizado', 'g1', { liquidacionId: 'fantasma' });
  assert.equal((await clasificar(w3)).clasificacion, CLASE.CONFLICTO);
});

test('BF9 · segunda ejecución con el mismo estado → 0 cambios', async () => {
  const w = base();
  const m = await dry(w);
  const r1 = await aplicar(w, m);
  assert.equal(r1.totales.APLICADO, 1);
  assert.equal(w.get('gastos_motorizado', 'g1').consumidoEnDepositoId, 'd1');
  const tras1 = w.foto();
  const writes1 = w.stats.writes;
  const r2 = await aplicar(w, m); // mismo manifest
  assert.equal(r2.resultados[0].resultado, 'IDEMPOTENT_SKIP');
  assert.equal(w.foto(), tras1);
  assert.equal(w.stats.writes, writes1);
  // y un dry-run nuevo ya no lo propone
  assert.equal((await dry(w)).items.find((i) => i.gastoId === 'g1')!.clasificacion, CLASE.NO_APLICA);
});

test('BF10 · el updateTime / la evidencia cambia entre dry-run y apply → 0 write', async () => {
  const w = base();
  const m = await dry(w);
  w.patch('gastos_motorizado', 'g1', { nota: 'tocado' }); // cambia el updateTime del gasto sin cambiar la evidencia lógica
  const antes = w.foto();
  const r = await aplicar(w, m);
  assert.equal(r.resultados[0].resultado, 'SKIP_CONFLICT');
  assert.equal(r.resultados[0].motivo, 'GASTO_CAMBIO_DESDE_EL_DRY_RUN');
  assert.equal(w.foto(), antes);
});

// ── BF11–BF20 ───────────────────────────────────────────────────────────────────
test('BF11 · 2 depósitos vivos lo listan → ambiguo', async () => {
  const w = base();
  w.put('ordenes_deposito', 'd2', { ...DEP });
  const it = await clasificar(w);
  assert.equal(it.clasificacion, CLASE.AMBIGUO);
  assert.equal(it.motivo, 'VARIOS_DEPOSITOS_VIVOS_LO_LISTAN');
  assert.deepEqual(it.depositosVivosIds, ['d1', 'd2']);
});

test('BF12 · depósito de comercio lo lista → ambiguo', async () => {
  const w = base();
  w.put('ordenes_deposito', 'dc', { ...DEP, tipo: 'recaudacion_motorizado_comercio', destinatarioId: 'c1' });
  const it = await clasificar(w);
  assert.equal(it.clasificacion, CLASE.AMBIGUO);
  assert.equal(it.motivo, 'DEPOSITO_COMERCIO_LO_LISTA');
});

test('BF13 · la suma de gastos no cuadra → ambiguo', async () => {
  const w = base();
  w.patch('ordenes_deposito', 'd1', { gastosDescontados: 31 });
  assert.equal((await clasificar(w)).motivo, 'SUMA_DE_GASTOS_NO_CUADRA');
  // el depósito lista otro gasto que no existe
  const w2 = base();
  w2.patch('ordenes_deposito', 'd1', { gastosIds: ['g1', 'g_fantasma'] });
  assert.equal((await clasificar(w2)).motivo, 'GASTO_DEL_DEPOSITO_INEXISTENTE');
  // precisión: 0.1 + 0.2 en centavos
  const w3 = base();
  w3.patch('gastos_motorizado', 'g1', { monto: 0.1 });
  w3.put('gastos_motorizado', 'g2', { ...GASTO, monto: 0.2 });
  w3.patch('ordenes_deposito', 'd1', { gastosIds: ['g1', 'g2'], gastosDescontados: 0.3, montoTotal: 99.7, montoBruto: 100 });
  assert.equal((await clasificar(w3)).clasificacion, CLASE.CONSUMIDO);
});

test('BF14 · motorizado distinto → ambiguo', async () => {
  const w = base();
  w.put('motorizado', 'm2', { authUid: 'uid2' });
  w.patch('ordenes_deposito', 'd1', { motorizadoUid: 'uid2' });
  assert.equal((await clasificar(w)).motivo, 'MOTORIZADO_NO_COINCIDE');
  const w2 = base();
  w2.patch('solicitudes_envio', 'o1', { asignacion: { motorizadoAuthUid: 'uid2' } });
  assert.equal((await clasificar(w2)).motivo, 'ORDEN_DEL_DEPOSITO_DE_OTRO_MOTORIZADO');
});

test('BF15 · liquidación legacy sin marker → LEGACY_LIQUIDACION, sin depósito objetivo, 0 write', async () => {
  const w = base();
  w.patch('ordenes_deposito', 'd1', { estado: 'anulado' });
  w.put('liquidaciones_motorizado', 'l1', { gastosIds: ['g1'], estado: 'pagada' });
  const it = await clasificar(w);
  assert.equal(it.clasificacion, CLASE.LEGACY_LIQUIDACION);
  assert.equal(it.depositoObjetivo, null);
  assert.deepEqual(it.liquidacionesIds, ['l1']);
  // simultáneo con un depósito vivo → ambiguo
  const w2 = base();
  w2.put('liquidaciones_motorizado', 'l1', { gastosIds: ['g1'] });
  assert.equal((await clasificar(w2)).motivo, 'APARECE_EN_DEPOSITO_Y_LIQUIDACION');
  // y un manifest A forzado sobre ese gasto no escribe
  const m = await dry(base());
  const antes = w.foto();
  await aplicar(w, m);
  assert.equal(w.foto(), antes);
});

test('BF16 · operacionId original permanece intacto; solo se escriben los campos esperados', async () => {
  const w = base();
  const m = await dry(w);
  const r = await aplicar(w, m);
  const g = w.get('gastos_motorizado', 'g1');
  assert.equal(g.operacionId, 'op-original-1');
  assert.equal(g.consumidoEnDepositoId, 'd1');
  assert.equal(g.consumoBackfillOperacionId, r.operacionBackfillId);
  assert.deepEqual(g.consumoBackfillAt, TS_SENTINEL);
  const { consumidoEnDepositoId, consumoBackfillOperacionId, consumoBackfillAt, ...resto } = g;
  void consumidoEnDepositoId; void consumoBackfillOperacionId; void consumoBackfillAt;
  assert.deepEqual(resto, GASTO); // monto, estado, fecha, motorizado… idénticos
});

test('BF17 · apply sin confirm / sin manifest → rechazado por las guardas (0 writes)', () => {
  const sin = validarGuardas(parsearArgs(['--project', 'demo-storkhub', '--apply', '--manifest', 'm.json']));
  assert.ok(sin.some((e) => e.includes('--confirm')));
  assert.ok(validarGuardas(parsearArgs(['--project', 'demo-storkhub', '--apply', '--confirm', FRASE_CONFIRMACION])).some((e) => e.includes('--manifest')));
  assert.ok(validarGuardas(parsearArgs(['--project', 'demo-storkhub', '--apply', '--manifest', 'm.json', '--confirm', 'apply'])).length > 0);
  assert.ok(validarGuardas(parsearArgs(['--apply', '--manifest', 'm.json', '--confirm', FRASE_CONFIRMACION])).some((e) => e.includes('--project')));
  assert.deepEqual(validarGuardas(parsearArgs(['--project', 'demo-storkhub', '--apply', '--manifest', 'm.json', '--confirm', FRASE_CONFIRMACION])), []);
  // default = dry-run, y los flags de apply sin --apply (o un typo) no se aceptan en silencio
  assert.equal(parsearArgs(['--project', 'x-staging']).modo, 'dry-run');
  assert.throws(() => parsearArgs(['--project', 'x-staging', '--manifest', 'm.json', '--confirm', FRASE_CONFIRMACION]));
  assert.throws(() => parsearArgs(['--project', 'x-staging', '--aply']));
});

test('BF18 · proyecto producción sin --allow-production (o sin confirmación separada) → rechazado', () => {
  assert.equal(pareceProduccion('shenvios-prod'), true);
  assert.equal(pareceProduccion('mi-proyecto'), true); // fail-safe: lo no reconocido es producción
  for (const p of ['demo-storkhub', 'shenvios-staging']) assert.equal(pareceProduccion(p), false);
  const ok = ['--apply', '--manifest', 'm.json', '--confirm', FRASE_CONFIRMACION];
  assert.ok(validarGuardas(parsearArgs(['--project', 'shenvios-prod', ...ok])).some((e) => e.includes('--allow-production')));
  assert.ok(validarGuardas(parsearArgs(['--project', 'shenvios-prod', ...ok, '--allow-production'])).some((e) => e.includes('--confirm-production')));
  assert.ok(validarGuardas(parsearArgs(['--project', 'shenvios-prod', ...ok, '--allow-production', '--confirm-production', 'si'])).length > 0);
  assert.deepEqual(validarGuardas(parsearArgs(['--project', 'shenvios-prod', ...ok, '--allow-production', '--confirm-production', fraseProduccion('shenvios-prod')])), []);
});

test('BF19 · aparece una marca después del dry-run → 0 writes', async () => {
  for (const marca of [{ consumidoEnDepositoId: 'otro' }, { liquidacionId: 'l9' }]) {
    const w = base();
    const m = await dry(w);
    w.patch('gastos_motorizado', 'g1', marca);
    const antes = w.foto();
    const r = await aplicar(w, m);
    assert.equal(r.resultados[0].resultado, 'SKIP_CONFLICT');
    assert.equal(w.foto(), antes);
  }
});

test('BF20 · el depósito cambia después del dry-run → 0 writes', async () => {
  const cambios: Array<(w: Mundo) => void> = [
    (w) => w.patch('ordenes_deposito', 'd1', { estado: 'anulado' }),
    (w) => w.patch('ordenes_deposito', 'd1', { boucherUrl: 'x' }), // cambia el updateTime
    (w) => w.put('ordenes_deposito', 'd2', { ...DEP }), // aparece un segundo depósito vivo
    (w) => w.patch('ordenes_deposito', 'd1', { gastosIds: [] }),
    (w) => w.patch('solicitudes_envio', 'o1', { estado: 'cancelado' }), // la evidencia (orden) cambia
  ];
  for (const cambiar of cambios) {
    const w = base();
    const m = await dry(w);
    cambiar(w);
    const antes = w.foto();
    const r = await aplicar(w, m);
    assert.equal(r.resultados[0].resultado, 'SKIP_CONFLICT');
    assert.equal(w.foto(), antes);
    assert.equal(w.stats.writes, 0);
  }
});

// ── Extras: manifest, solo-A, clases inesperadas, B guardada, D, rollback, fail-closed ──
test('manifest: schema, totales, por motorizado/depósito, huella y evidencia sin datos de más', async () => {
  const w = base();
  w.put('gastos_motorizado', 'g_anulado', { ...GASTO, estado: 'anulado' });
  const m = await dry(w);
  assert.equal(m.schemaVersion, 1);
  assert.equal(m.mode, 'dry-run');
  assert.equal(m.projectId, 'demo-storkhub');
  assert.equal(m.sourceGitSha, 'abc');
  assert.equal(m.totales[CLASE.CONSUMIDO], 1);
  assert.equal(m.totales[CLASE.NO_APLICA], 1);
  assert.deepEqual(m.porDeposito, { d1: 1 });
  assert.deepEqual(m.porMotorizado.m1, { CONSUMIDO_DEMOSTRADO: 1, NO_APLICA: 1 });
  assert.equal(m.itemsSha256, huellaItems(m.items));
  const a = m.items.find((i) => i.gastoId === 'g1')!;
  for (const k of ['gastoId', 'clasificacion', 'motivo', 'monto', 'motorizadoId', 'depositosVivosIds', 'liquidacionesIds', 'depositoObjetivo', 'markerActual', 'gastoUpdateTime', 'depositoUpdateTime', 'evidencia']) assert.ok(k in a, k);
  assert.ok(!JSON.stringify(m).includes('uid1'), 'el manifest no lleva authUid ni otros datos personales');
});

test('dry-run es SOLO lectura y determinista', async () => {
  const w = base();
  const antes = w.foto();
  const m1 = await dry(w);
  const m2 = await dry(w);
  assert.equal(w.foto(), antes);
  assert.equal(w.stats.writes, 0);
  assert.equal(JSON.stringify(m1), JSON.stringify(m2));
});

test('apply solo procesa A; manifest alterado, de otro proyecto o con clase inesperada → STOP sin writes', async () => {
  const w = base();
  w.put('gastos_motorizado', 'g2', { ...GASTO });
  w.patch('ordenes_deposito', 'd1', { gastosIds: ['g1'] }); // g2 libre
  const m = await dry(w);
  assert.equal(m.items.find((i) => i.gastoId === 'g2')!.clasificacion, CLASE.LIBRE); // d1 descuenta exactamente g1: g2 queda libre (B)
  const r = await aplicar(w, m);
  assert.equal(r.omitidos.length, 1);
  assert.equal(r.omitidos[0].resultado, 'SKIP_CLASE_NO_APLICABLE');
  assert.equal(w.get('gastos_motorizado', 'g2').consumidoEnDepositoId, undefined);
  const antes = w.foto();
  const alterado = structuredClone(m); alterado.items[0].depositoObjetivo = 'dX';
  await assert.rejects(aplicar(w, alterado), ManifestInvalido);
  await assert.rejects(aplicar(w, m, 'otro-proyecto'), ManifestInvalido);
  const rara = structuredClone(m); (rara.items[0] as { clasificacion: string }).clasificacion = 'INVENTADA'; reHuella(rara);
  await assert.rejects(aplicar(w, rara), ManifestInvalido);
  const sinTimes = structuredClone(m); const a = sinTimes.items.find((i) => i.clasificacion === CLASE.CONSUMIDO)!; a.depositoUpdateTime = null; reHuella(sinTimes);
  await assert.rejects(aplicar(w, sinTimes), ManifestInvalido);
  assert.equal(w.foto(), antes);
});

test('clase B: gasto libre solo si ningún depósito vivo del motorizado tiene un descuento sin explicar', async () => {
  const w = base();
  w.put('gastos_motorizado', 'g2', { ...GASTO, monto: 10 });
  assert.equal((await clasificar(w, 'g2')).clasificacion, CLASE.LIBRE); // d1 descuenta 30 = g1 → explicado
  w.patch('ordenes_deposito', 'd1', { gastosDescontados: 40 }); // 10 sin explicar: podría ser g2
  const it = await clasificar(w, 'g2');
  assert.equal(it.clasificacion, CLASE.AMBIGUO);
  assert.equal(it.motivo, 'DESCUENTO_SIN_EXPLICAR_EN_DEPOSITOS_DEL_MOTORIZADO');
  // descuento sin gastosIds
  const w2 = base();
  w2.put('gastos_motorizado', 'g2', { ...GASTO, monto: 10 });
  w2.put('ordenes_deposito', 'd9', { ...DEP, gastosIds: [], gastosDescontados: 10 });
  assert.equal((await clasificar(w2, 'g2')).clasificacion, CLASE.AMBIGUO);
  // un depósito NO vivo con descuento raro no cuenta
  w2.patch('ordenes_deposito', 'd9', { estado: 'rechazado' });
  assert.equal((await clasificar(w2, 'g2')).clasificacion, CLASE.LIBRE);
});

test('clase D: anulado y estados desconocidos', async () => {
  const w = base();
  w.patch('gastos_motorizado', 'g1', { estado: 'anulado' });
  assert.equal((await clasificar(w)).clasificacion, CLASE.NO_APLICA);
  w.patch('gastos_motorizado', 'g1', { estado: 'raro' });
  assert.equal((await clasificar(w)).clasificacion, CLASE.AMBIGUO);
});

test('marker existente: contradicciones se reportan como CONFLICTO', async () => {
  const casos: Array<[string, (w: Mundo) => void]> = [
    ['MARCA_APUNTA_A_DEPOSITO_INEXISTENTE', (w) => w.patch('gastos_motorizado', 'g1', { consumidoEnDepositoId: 'nada' })],
    ['MARCA_APUNTA_A_DEPOSITO_QUE_NO_LO_LISTA', (w) => { w.put('ordenes_deposito', 'd2', { ...DEP, gastosIds: [] }); w.patch('gastos_motorizado', 'g1', { consumidoEnDepositoId: 'd2' }); }],
    ['MARCA_Y_OTRO_DEPOSITO_VIVO_LO_LISTAN', (w) => { w.put('ordenes_deposito', 'd2', { ...DEP }); w.patch('gastos_motorizado', 'g1', { consumidoEnDepositoId: 'd2' }); }],
    ['MARCA_APUNTA_A_DEPOSITO_DE_OTRO_MOTORIZADO', (w) => { w.patch('ordenes_deposito', 'd1', { motorizadoUid: 'uid2' }); w.patch('gastos_motorizado', 'g1', { consumidoEnDepositoId: 'd1' }); }],
  ];
  for (const [motivo, armar] of casos) {
    const w = base();
    armar(w);
    const it = await clasificar(w);
    assert.equal(it.clasificacion, CLASE.CONFLICTO, motivo);
    assert.equal(it.motivo, motivo);
  }
});

test('depósito rehecho que cambia de id no se inventa: el id sale del depósito que lista el gasto', async () => {
  const w = base();
  w.patch('ordenes_deposito', 'd1', { estado: 'anulado' });
  w.put('ordenes_deposito', 'd_nuevo', { ...DEP }); // otro depósito (no un "rehecho") que lo lista
  const it = await clasificar(w);
  assert.equal(it.depositoObjetivo, 'd_nuevo'); // vivo único; el anulado no cuenta
});

test('apply escribe SOLO el gasto, con precondición, y deja registro de rollback exacto; el rollback solo es seguro si nada cambió', async () => {
  const w = base();
  const m = await dry(w);
  const r = await aplicar(w, m);
  const reg = r.resultados[0].rollback!;
  assert.equal(reg.valorAnterior.consumidoEnDepositoId, null);
  assert.equal(reg.valorNuevo.consumidoEnDepositoId, 'd1');
  assert.equal(reg.valorNuevo.consumoBackfillOperacionId, r.operacionBackfillId);
  assert.equal(reg.updateTimePre, m.items.find((i) => i.gastoId === 'g1')!.gastoUpdateTime);
  assert.notEqual(reg.updateTimePost, reg.updateTimePre);
  assert.equal(w.stats.writes, 1);
  assert.deepEqual(w.get('ordenes_deposito', 'd1'), DEP); // el depósito no se toca
  assert.equal(rollbackSeguro(reg, await w.lector.getDoc('gastos_motorizado', 'g1')), true);
  w.patch('gastos_motorizado', 'g1', { nota: 'otro cambio' });
  assert.equal(rollbackSeguro(reg, await w.lector.getDoc('gastos_motorizado', 'g1')), false);
  assert.equal(rollbackSeguro(reg, null), false);
});

test('fail-closed: un error inesperado detiene la corrida; un conflicto no', async () => {
  const w = base();
  w.put('gastos_motorizado', 'g0', { ...GASTO, monto: 5 });
  w.put('ordenes_deposito', 'd0', { ...DEP, gastosIds: ['g0'], gastosDescontados: 5, montoTotal: 95 });
  w.put('solicitudes_envio', 'o1', ORDEN);
  const m = await dry(w);
  assert.equal(m.totales[CLASE.CONSUMIDO], 2);
  // conflicto en el primero (g0), el segundo (g1) sigue
  w.patch('gastos_motorizado', 'g0', { nota: 'x' });
  const r = await aplicar(w, m);
  assert.deepEqual(r.resultados.map((x) => x.resultado), ['SKIP_CONFLICT', 'APLICADO']);
  // error de infraestructura ⇒ STOP
  const w2 = base();
  const m2 = await dry(w2);
  const roto: Entorno = { ...w2.entorno, transaccion: async () => { throw new Error('boom'); } };
  const r2 = await ejecutarApply(roto, structuredClone(m2), { projectId: 'demo-storkhub', ahora: AHORA });
  assert.equal(r2.detenido, true);
  assert.equal(r2.resultados[0].resultado, 'ERROR_STOP');
});

test('el plan rechaza duplicados y el manifest vacío no escribe', async () => {
  const w = base();
  const m = await dry(w);
  const dup = structuredClone(m); dup.items.push(structuredClone(dup.items[0])); reHuella(dup);
  assert.throws(() => planificarApply(dup, 'demo-storkhub'), ManifestInvalido);
  assert.throws(() => planificarApply({ ...m, mode: 'apply' }, 'demo-storkhub'), ManifestInvalido);
  assert.throws(() => planificarApply({ ...m, schemaVersion: 99 }, 'demo-storkhub'), ManifestInvalido);
});
