// A7-01 — COM-1…7, COD-1…8, MAN-1…8 + extras. Sin Firestore, sin red: un mundo en memoria implementa Lector/Entorno con transacciones
// con escrituras en buffer (se descartan si la transacción lanza), create() que falla si el doc existe y update() que falla si no existe.
// Nada de esto toca staging ni producción.
import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import {
  FRASE_CONFIRMACION, ManifestInvalido, PROYECTO_PRODUCCION, clasificarUsuarioComercio, huellaItems, parsearArgs, planificarApply,
  planificarDominio, validarGuardas, verificarFuente, DOMINIOS, type DocLite, type FuenteActual, type ManifestDryRun,
} from '../src/legacy-prod-migracion';
import { ejecutarApply, ejecutarDryRun, type Entorno, type Lector, type Transaccion } from '../src/legacy-prod-migracion-runner';
import { decidirAsignacion } from '../src/codigos';

type Doc = Record<string, unknown>;
const AHORA = new Date('2026-06-01T12:00:00Z');
const SHA = 'a'.repeat(40);
const FUENTE: FuenteActual = { sourceGitSha: SHA, sourceTreeClean: true, buildSha256: 'b'.repeat(64) };
const META = { projectId: PROYECTO_PRODUCCION, ...FUENTE, generatedAt: AHORA.toISOString() };
const ts = (s: number, n = 0) => ({ seconds: s, nanoseconds: n });

function mundo() {
  const store = new Map<string, Doc>();
  const stats = { writes: 0, tx: 0 };
  const ver = (c: string, id: string): DocLite | null => (store.has(`${c}/${id}`) ? { id, data: structuredClone(store.get(`${c}/${id}`) as Doc) } : null);
  const col = (c: string): DocLite[] => [...store.keys()].filter((k) => k.startsWith(`${c}/`)).sort().map((k) => ver(c, k.slice(c.length + 1)) as DocLite);
  const lector: Lector = { async listar(c) { return col(c); }, async getDoc(c, id) { return ver(c, id); } };
  const entorno: Entorno = {
    async transaccion(fn) {
      stats.tx += 1;
      const buffer: Array<() => void> = [];
      const tx: Transaccion = {
        ...lector,
        actualizar(c, id, campos) {
          buffer.push(() => { const d = store.get(`${c}/${id}`); if (!d) throw new Error(`update sobre inexistente ${c}/${id}`); Object.assign(d, structuredClone(campos)); stats.writes += 1; });
        },
        crear(c, id, campos) {
          buffer.push(() => { if (store.has(`${c}/${id}`)) throw new Error(`create sobre existente ${c}/${id}`); store.set(`${c}/${id}`, structuredClone(campos)); stats.writes += 1; });
        },
      };
      const r = await fn(tx);
      // commit atómico: si alguna escritura falla, se restaura todo.
      const copia = new Map([...store].map(([k, v]) => [k, structuredClone(v)]));
      try { for (const w of buffer) w(); } catch (e) { store.clear(); for (const [k, v] of copia) store.set(k, v); throw e; }
      return r;
    },
  };
  return {
    stats, lector, entorno,
    put(c: string, id: string, data: Doc) { store.set(`${c}/${id}`, structuredClone(data)); },
    patch(c: string, id: string, campos: Doc) { Object.assign(store.get(`${c}/${id}`) as Doc, campos); },
    get: (c: string, id: string) => store.get(`${c}/${id}`),
    foto: () => JSON.stringify([...store].sort()),
  };
}
type Mundo = ReturnType<typeof mundo>;

const usuarioComercio = (m: Mundo, id: string, extra: Doc = {}) => m.put('usuarios', id, { rol: 'Comercio', ...extra });
const comercio = (m: Mundo, id: string, extra: Doc = {}) => m.put('comercios', id, { name: `C-${id}`, ...extra });
const orden = (m: Mundo, id: string, extra: Doc = {}) => m.put('solicitudes_envio', id, { estado: 'pendiente', ...extra });
const deposito = (m: Mundo, id: string, extra: Doc = {}) => m.put('ordenes_deposito', id, { estado: 'confirmado', ...extra });
const dry = (m: Mundo) => ejecutarDryRun(m.lector, META);
const apply = (m: Mundo, manifest: unknown, fuente: FuenteActual = FUENTE) => ejecutarApply(m.entorno, manifest, { projectId: PROYECTO_PRODUCCION, ahora: AHORA, fuente });
const resultado = (r: Awaited<ReturnType<typeof apply>>, dominio: string) => r.resultados.find((x) => x.dominio === dominio)?.resultado;

/** Mundo base A6: 7 usuarios Comercio (id == id del comercio), 1 orden y 2 depósitos legacy, contadores vacíos. */
function mundoA6(): Mundo {
  const m = mundo();
  for (let i = 1; i <= 7; i++) { usuarioComercio(m, `u${i}`, { email: `u${i}@x.test` }); comercio(m, `u${i}`); }
  m.put('usuarios', 'gestor1', { rol: 'gestor' });
  orden(m, 'ord1', { createdAt: ts(100) });
  deposito(m, 'dep1', { createdAt: ts(200) });
  deposito(m, 'dep2', { createdAt: ts(100) });
  return m;
}

const u = (id: string, data: Doc): DocLite => ({ id, data });

// ══ COM ═════════════════════════════════════════════════════════════════════════════════════════════════════════════

test('COM-1 · rol Comercio + comercios/{mismo id} + sin comercioId ⇒ BACKFILL_SEGURO', () => {
  const us = [u('a', { rol: 'Comercio' })];
  const r = clasificarUsuarioComercio(us[0], us, [u('a', { name: 'x' })]);
  assert.equal(r.clasificacion, 'COMERCIO_BACKFILL_SEGURO');
  assert.equal(r.comercioIdObjetivo, 'a');
});

test('COM-1b · comercio legacy con authUid == uid también es seguro', () => {
  const us = [u('a', { rol: 'Comercio' })];
  assert.equal(clasificarUsuarioComercio(us[0], us, [u('a', { authUid: 'a' })]).clasificacion, 'COMERCIO_BACKFILL_SEGURO');
});

test('COM-2 · ya tiene el mismo comercioId ⇒ YA_CORRECTO', () => {
  const us = [u('a', { rol: 'Comercio', comercioId: 'a' })];
  assert.equal(clasificarUsuarioComercio(us[0], us, [u('a', {})]).clasificacion, 'YA_CORRECTO');
});

test('COM-3 · comercioId distinto (o vacío / de otro tipo) ⇒ CONFLICTO, nunca se corrige', () => {
  for (const v of ['otro', '', 7]) {
    const us = [u('a', { rol: 'Comercio', comercioId: v })];
    const r = clasificarUsuarioComercio(us[0], us, [u('a', {}), u('otro', {})]);
    assert.equal(r.clasificacion, 'CONFLICTO');
    assert.equal(r.comercioIdObjetivo, null);
  }
});

test('COM-4 · no existe comercios/{uid} ⇒ AMBIGUO', () => {
  const us = [u('a', { rol: 'Comercio' })];
  assert.equal(clasificarUsuarioComercio(us[0], us, [u('b', {})]).clasificacion, 'AMBIGUO');
});

test('COM-5 · rol no comercio ⇒ NO_APLICA (y rol "comercio" mal capitalizado ⇒ AMBIGUO, no se adivina)', () => {
  for (const rol of ['gestor', 'motorizado', 'cliente', undefined]) {
    const us = [u('a', { rol })];
    assert.equal(clasificarUsuarioComercio(us[0], us, [u('a', {})]).clasificacion, 'NO_APLICA');
  }
  const us = [u('a', { rol: 'comercio' })];
  assert.equal(clasificarUsuarioComercio(us[0], us, [u('a', {})]).clasificacion, 'AMBIGUO');
});

test('COM-6 · match alternativo contradictorio ⇒ CONFLICTO (comercio apunta a otro, otro comercio apunta a él, otro usuario ya vinculado)', () => {
  const us = [u('a', { rol: 'Comercio' }), u('z', { rol: 'Comercio', comercioId: 'a' })];
  const casos: Array<[string, DocLite[], DocLite[]]> = [
    ['comercio.authUid de otro', [us[0]], [u('a', { authUid: 'otro' })]],
    ['otro comercio con authUid == uid', [us[0]], [u('a', {}), u('b', { authUid: 'a' })]],
    ['otro usuario ya apunta al comercio', us, [u('a', {}), u('z', {})]],
  ];
  for (const [nombre, usuarios, comercios] of casos) {
    assert.equal(clasificarUsuarioComercio(usuarios[0], usuarios, comercios).clasificacion, 'CONFLICTO', nombre);
  }
});

test('COM-7 · apply: 7 usuarios se completan con comercioId = uid y NADA MÁS; el retry no cambia nada', async () => {
  const m = mundoA6();
  const antes = Array.from({ length: 7 }, (_, i) => structuredClone(m.get('usuarios', `u${i + 1}`)));
  const manifest = await dry(m);
  assert.equal(manifest.resumen.usuariosBackfillSeguro, 7);
  const r1 = await apply(m, manifest);
  assert.equal(resultado(r1, 'usuarios'), 'APLICADO');
  for (let i = 1; i <= 7; i++) assert.deepEqual(m.get('usuarios', `u${i}`), { ...(antes[i - 1] as Doc), comercioId: `u${i}` });
  assert.deepEqual(m.get('usuarios', 'gestor1'), { rol: 'gestor' });
  const foto = m.foto();
  const w = m.stats.writes;
  const r2 = await apply(m, manifest);
  assert.equal(resultado(r2, 'usuarios'), 'YA_APLICADO');
  assert.equal(m.stats.writes, w);
  assert.equal(m.foto(), foto);
});

test('COM-8 · todo-o-nada: si UN usuario cambió desde el dry-run, ninguno se escribe', async () => {
  const m = mundoA6();
  const manifest = await dry(m);
  m.patch('usuarios', 'u4', { comercioId: 'otro' });
  const antes = m.foto();
  const r = await apply(m, manifest);
  assert.equal(resultado(r, 'usuarios'), 'SKIP_CONFLICT');
  assert.match(r.resultados[0].motivo, /u4/);
  for (let i = 1; i <= 7; i++) if (i !== 4) assert.equal(m.get('usuarios', `u${i}`)?.comercioId, undefined);
  assert.equal(JSON.stringify([...JSON.parse(antes)].filter(([k]: [string]) => k.startsWith('usuarios/'))), JSON.stringify([...JSON.parse(m.foto())].filter(([k]: [string]) => k.startsWith('usuarios/'))));
});

test('COM-9 · si el comercio desaparece o aparece un vínculo contradictorio entre dry-run y apply ⇒ SKIP, 0 writes', async () => {
  const m = mundoA6();
  const manifest = await dry(m);
  m.put('comercios', 'extra', { authUid: 'u2' });
  const r = await apply(m, manifest);
  assert.equal(resultado(r, 'usuarios'), 'SKIP_CONFLICT');
  assert.equal(m.get('usuarios', 'u2')?.comercioId, undefined);
});

// ══ COD ═════════════════════════════════════════════════════════════════════════════════════════════════════════════

test('COD-1 · contador ausente + 1 orden legacy ⇒ SH-0001/1 y contador 1; la próxima creación normal da SH-0002 (helper real)', async () => {
  const m = mundo();
  orden(m, 'o1', { createdAt: ts(10) });
  const manifest = await dry(m);
  const r = await apply(m, manifest);
  assert.equal(resultado(r, 'solicitudes_envio'), 'APLICADO');
  assert.equal(m.get('solicitudes_envio', 'o1')?.codigo, 'SH-0001');
  assert.equal(m.get('solicitudes_envio', 'o1')?.secuencia, 1);
  assert.deepEqual(m.get('contadores', 'ordenes'), { valor: 1 });
  // El helper REAL del trigger, con el contador que dejó la migración:
  const sig = decidirAsignacion({ prefijo: 'SH', codigoActual: undefined, secuenciaActual: undefined, valorContador: m.get('contadores', 'ordenes')?.valor });
  assert.deepEqual(sig, { accion: 'asignar', codigo: 'SH-0002', secuencia: 2, siguienteValor: 2 });
  // Y el dominio sin legacy queda sembrado en 0 (el trigger ya no bloquea por CONTADOR_AUSENTE).
  assert.deepEqual(m.get('contadores', 'depositos'), { valor: 0 });
  assert.equal(decidirAsignacion({ prefijo: 'DEP', codigoActual: undefined, secuenciaActual: undefined, valorContador: 0 }).accion, 'asignar');
});

test('COD-2 · 2 depósitos legacy ⇒ secuencias únicas y determinísticas por createdAt', async () => {
  const m = mundoA6(); // dep2 (t=100) es anterior a dep1 (t=200)
  const manifest = await dry(m);
  await apply(m, manifest);
  assert.deepEqual([m.get('ordenes_deposito', 'dep2')?.codigo, m.get('ordenes_deposito', 'dep2')?.secuencia], ['DEP-0001', 1]);
  assert.deepEqual([m.get('ordenes_deposito', 'dep1')?.codigo, m.get('ordenes_deposito', 'dep1')?.secuencia], ['DEP-0002', 2]);
  assert.deepEqual(m.get('contadores', 'depositos'), { valor: 2 });
  assert.deepEqual(manifest.criterioOrden, { solicitudes_envio: 'createdAt+docId', ordenes_deposito: 'createdAt+docId' });
});

test('COD-2b · mismo mundo ⇒ mismo manifest (orden de lectura irrelevante)', async () => {
  const a = await dry(mundoA6());
  const m2 = mundo();
  // inserción en otro orden
  deposito(m2, 'dep2', { createdAt: ts(100) }); deposito(m2, 'dep1', { createdAt: ts(200) }); orden(m2, 'ord1', { createdAt: ts(100) });
  m2.put('usuarios', 'gestor1', { rol: 'gestor' });
  for (let i = 7; i >= 1; i--) { comercio(m2, `u${i}`); usuarioComercio(m2, `u${i}`, { email: `u${i}@x.test` }); }
  const b = await dry(m2);
  assert.equal(a.itemsSha256, b.itemsSha256);
});

test('COD-3 · documento ya codificado y coherente no cambia', async () => {
  const m = mundo();
  orden(m, 'o1', { codigo: 'SH-0007', secuencia: 7 });
  m.put('contadores', 'ordenes', { valor: 7 });
  const manifest = await dry(m);
  const r = await apply(m, manifest);
  assert.deepEqual(m.get('solicitudes_envio', 'o1'), { estado: 'pendiente', codigo: 'SH-0007', secuencia: 7 });
  assert.deepEqual(m.get('contadores', 'ordenes'), { valor: 7 });
  assert.equal(resultado(r, 'solicitudes_envio'), 'SIN_CAMBIOS');
});

test('COD-4 · códigos existentes evitan colisión: el legacy sigue a la mayor secuencia y nunca la reutiliza', async () => {
  const m = mundo();
  orden(m, 'a', { codigo: 'SH-0003', secuencia: 3 });
  orden(m, 'b', { codigo: 'SH-0001', secuencia: 1 });
  orden(m, 'leg', { createdAt: ts(5) });
  m.put('contadores', 'ordenes', { valor: 2 }); // contador por detrás de lo ya repartido
  const manifest = await dry(m);
  assert.ok(manifest.warnings.some((w) => /por detrás/.test(w)));
  await apply(m, manifest);
  assert.equal(m.get('solicitudes_envio', 'leg')?.codigo, 'SH-0004');
  assert.deepEqual(m.get('contadores', 'ordenes'), { valor: 4 });
});

test('COD-4b · estados parciales / incoherentes / duplicados ⇒ AMBIGUO/CONFLICTO y el dominio no reparte nada', () => {
  const cfg = DOMINIOS[0];
  const p1 = planificarDominio(cfg, [u('a', { codigo: 'SH-0001' }), u('l', {})], null);
  assert.equal(p1.items.find((i) => i.docId === 'a')?.clasificacion, 'AMBIGUO');
  assert.equal(p1.items.find((i) => i.docId === 'l')?.clasificacion, 'AMBIGUO');
  const p2 = planificarDominio(cfg, [u('a', { codigo: 'SH-0009', secuencia: 1 })], null);
  assert.equal(p2.items[0].clasificacion, 'CONFLICTO');
  const p3 = planificarDominio(cfg, [u('a', { codigo: 'SH-0001', secuencia: 1 }), u('b', { codigo: 'SH-0001', secuencia: 1 })], null);
  assert.deepEqual(p3.items.map((i) => i.motivo), ['SECUENCIA_DUPLICADA_EXISTENTE', 'SECUENCIA_DUPLICADA_EXISTENTE']);
  const p4 = planificarDominio(cfg, [u('l', {})], u('ordenes', { valor: -3 }));
  assert.equal(p4.contador.clasificacion, 'CONFLICTO');
  assert.equal(p4.items[0].clasificacion, 'AMBIGUO');
});

test('COD-5 · el contador apareció tras el dry-run: coherente ⇒ se completa sin pisarlo; distinto ⇒ SKIP sin tocarlo', async () => {
  const coherente = mundo();
  orden(coherente, 'o1', { createdAt: ts(1) });
  const mc = await dry(coherente);
  coherente.put('contadores', 'ordenes', { valor: 0 });
  const r1 = await apply(coherente, mc);
  assert.equal(resultado(r1, 'solicitudes_envio'), 'APLICADO');
  assert.deepEqual(coherente.get('contadores', 'ordenes'), { valor: 1 });

  const avanzado = mundo();
  orden(avanzado, 'o1', { createdAt: ts(1) });
  const ma = await dry(avanzado);
  avanzado.put('contadores', 'ordenes', { valor: 5 });
  const r2 = await apply(avanzado, ma);
  assert.equal(resultado(r2, 'solicitudes_envio'), 'SKIP_CONFLICT');
  assert.deepEqual(avanzado.get('contadores', 'ordenes'), { valor: 5 });
  assert.equal(avanzado.get('solicitudes_envio', 'o1')?.codigo, undefined);
});

test('COD-6 · contador adelantado: nunca retrocede (en el plan ni en el apply)', async () => {
  const m = mundo();
  m.put('contadores', 'ordenes', { valor: 10 });
  orden(m, 'o1', { createdAt: ts(1) });
  const manifest = await dry(m);
  const item = manifest.items.find((i) => i.dominio === 'contadores' && i.contadorId === 'ordenes') as { valorAntes: number; valorDespues: number };
  assert.deepEqual([item.valorAntes, item.valorDespues], [10, 11]);
  assert.equal(manifest.items.find((i) => i.dominio === 'solicitudes_envio')?.['secuenciaPropuesta' as never], 11);
  m.patch('contadores', 'ordenes', { valor: 12 }); // avanzó por operación normal antes del apply
  const r = await apply(m, manifest);
  assert.equal(resultado(r, 'solicitudes_envio'), 'SKIP_CONFLICT');
  assert.deepEqual(m.get('contadores', 'ordenes'), { valor: 12 });
  assert.equal(m.get('solicitudes_envio', 'o1')?.codigo, undefined);
});

test('COD-7 · retry de apply: 0 writes, no incrementa ni cambia códigos; vale también si el contador siguió avanzando', async () => {
  const m = mundoA6();
  const manifest = await dry(m);
  await apply(m, manifest);
  const foto = m.foto();
  const w = m.stats.writes;
  const r = await apply(m, manifest);
  assert.equal(m.stats.writes, w);
  assert.equal(m.foto(), foto);
  assert.equal(resultado(r, 'solicitudes_envio'), 'YA_APLICADO');
  assert.equal(resultado(r, 'ordenes_deposito'), 'YA_APLICADO');
  // producción siguió creando órdenes: el contador avanza y el retry sigue sin tocar nada
  m.patch('contadores', 'ordenes', { valor: 9 });
  const w2 = m.stats.writes;
  const r3 = await apply(m, manifest);
  assert.equal(resultado(r3, 'solicitudes_envio'), 'YA_APLICADO');
  assert.equal(m.stats.writes, w2);
  assert.deepEqual(m.get('contadores', 'ordenes'), { valor: 9 });
});

test('COD-8 · timestamps empatados ⇒ desempate por docId asc; sin timestamps ⇒ todo por docId con aviso', async () => {
  const m = mundo();
  orden(m, 'zz', { createdAt: ts(50, 7) }); orden(m, 'aa', { createdAt: ts(50, 7) }); orden(m, 'mm', { createdAt: ts(50, 7) });
  await apply(m, await dry(m));
  assert.deepEqual(['aa', 'mm', 'zz'].map((id) => m.get('solicitudes_envio', id)?.secuencia), [1, 2, 3]);

  const sin = mundo();
  orden(sin, 'b', { createdAt: ts(1) }); orden(sin, 'a'); // uno sin createdAt ⇒ no se mezcla cronología parcial
  const mf = await dry(sin);
  assert.equal(mf.criterioOrden.solicitudes_envio, 'docId');
  assert.ok(mf.warnings.some((w) => /docId asc/.test(w)));
  await apply(sin, mf);
  assert.deepEqual(['a', 'b'].map((id) => sin.get('solicitudes_envio', id)?.secuencia), [1, 2]);
});

test('COD-9 · aparecieron docs nuevos tras el dry-run ⇒ SKIP', async () => {
  const m = mundo();
  const manifest = await dry(m);
  orden(m, 'nuevo', { createdAt: ts(9) }); // creado después, sin código (el trigger bloqueaba por contador ausente)
  const r = await apply(m, manifest);
  assert.equal(resultado(r, 'solicitudes_envio'), 'SKIP_CONFLICT'); // el plan viejo (0 legacy) no cubre al nuevo: hace falta otro dry-run
  assert.equal(m.get('solicitudes_envio', 'nuevo')?.codigo, undefined);
  assert.equal(m.get('contadores', 'ordenes'), undefined);
  assert.deepEqual(m.get('contadores', 'depositos'), { valor: 0 }); // el otro dominio es independiente y se siembra
});

// ══ MAN ═════════════════════════════════════════════════════════════════════════════════════════════════════════════

test('MAN-1 · dry-run no escribe: el Lector no tiene métodos de escritura y el mundo queda idéntico', async () => {
  const m = mundoA6();
  const antes = m.foto();
  const manifest = await dry(m);
  assert.equal(m.foto(), antes);
  assert.equal(m.stats.writes, 0);
  assert.equal(m.stats.tx, 0);
  assert.equal(manifest.mode, 'dry-run');
  assert.equal(manifest.kind, 'a7-prod-legacy');
  assert.equal(manifest.sourceGitSha, SHA);
  assert.equal(manifest.resumen.usuariosAnalizados, 8);
  assert.equal(manifest.resumen.usuariosBackfillSeguro, 7);
  assert.equal(manifest.resumen.ordenesLegacy, 1);
  assert.equal(manifest.resumen.depositosLegacy, 2);
  assert.equal(manifest.resumen.codigosPropuestos, 3);
  assert.deepEqual(manifest.resumen.contadoresAntes, { ordenes: null, depositos: null });
  assert.deepEqual(manifest.resumen.contadoresDespues, { ordenes: 1, depositos: 2 });
  assert.equal(manifest.itemsSha256, huellaItems(manifest.items));
});

test('MAN-1b · el manifest no lleva PII (ni emails ni nombres)', async () => {
  const m = mundoA6();
  m.patch('usuarios', 'u1', { name: 'Nombre Persona' });
  const texto = JSON.stringify(await dry(m));
  assert.doesNotMatch(texto, /@x\.test|Nombre Persona|C-u1/);
});

test('MAN-2 · sin --apply ⇒ DRY RUN: aceptar --manifest/--confirm/--allow-production sin --apply es error', () => {
  assert.equal(parsearArgs(['--project', 'p']).modo, 'dry-run');
  assert.equal(parsearArgs([]).modo, 'dry-run');
  for (const extra of [['--manifest', 'm.json'], ['--confirm', FRASE_CONFIRMACION], ['--allow-production']]) {
    assert.throws(() => parsearArgs(['--project', 'p', ...extra]));
  }
  assert.throws(() => parsearArgs(['--project', 'p', '--aplly']));
  assert.deepEqual(validarGuardas(parsearArgs(['--project', 'cualquiera'])), []);
});

const argsApply = (o: Partial<Record<string, string | boolean>> = {}) => {
  const a: string[] = ['--apply'];
  const base: Record<string, string | boolean> = { '--project': PROYECTO_PRODUCCION, '--manifest': 'm.json', '--confirm': FRASE_CONFIRMACION, '--allow-production': true, ...o };
  for (const [k, v] of Object.entries(base)) { if (v === false || v === undefined) continue; a.push(k); if (v !== true) a.push(v as string); }
  return a;
};

test('MAN-3 · sin --allow-production ⇒ abort', () => {
  assert.deepEqual(validarGuardas(parsearArgs(argsApply())), []);
  assert.match(validarGuardas(parsearArgs(argsApply({ '--allow-production': false }))).join('|'), /allow-production/);
});

test('MAN-4 · frase de confirmación incorrecta o ausente ⇒ abort', () => {
  assert.match(validarGuardas(parsearArgs(argsApply({ '--confirm': 'apply-a7-prod-legacy' }))).join('|'), /confirm/);
  assert.match(validarGuardas(parsearArgs(argsApply({ '--confirm': undefined }))).join('|'), /confirm/);
});

test('MAN-5 · proyecto distinto de producción, o ausente ⇒ abort (apply); sin manifest ⇒ abort', async () => {
  assert.match(validarGuardas(parsearArgs(argsApply({ '--project': 'storkhub-staging' }))).join('|'), /storkhub-9f719/);
  assert.match(validarGuardas(parsearArgs(argsApply({ '--project': undefined }))).join('|'), /--project/);
  assert.match(validarGuardas(parsearArgs(argsApply({ '--manifest': undefined }))).join('|'), /manifest/);
  // y el manifest de otro proyecto no se aplica
  const m = mundoA6();
  const manifest = await dry(m);
  await assert.rejects(ejecutarApply(m.entorno, { ...manifest, projectId: 'otro' }, { projectId: PROYECTO_PRODUCCION, ahora: AHORA, fuente: FUENTE }), ManifestInvalido);
  assert.equal(m.stats.tx, 0);
});

test('MAN-6 · sourceGitSha distinto / árbol sucio / build distinto / sha desconocido ⇒ abort con 0 transacciones', async () => {
  const m = mundoA6();
  const manifest = await dry(m);
  const malas: FuenteActual[] = [
    { ...FUENTE, sourceGitSha: 'c'.repeat(40) },
    { ...FUENTE, sourceTreeClean: false },
    { ...FUENTE, buildSha256: 'd'.repeat(64) },
    { ...FUENTE, sourceGitSha: 'desconocido' },
  ];
  for (const f of malas) await assert.rejects(apply(m, manifest, f), ManifestInvalido);
  await assert.rejects(apply(m, { ...manifest, sourceGitSha: 'desconocido' }), ManifestInvalido);
  await assert.rejects(apply(m, { ...manifest, sourceTreeClean: false }), ManifestInvalido);
  assert.equal(m.stats.tx, 0);
  assert.equal(m.stats.writes, 0);
  assert.doesNotThrow(() => verificarFuente(manifest, FUENTE));
});

test('MAN-7 · itemsSha256 distinto o items editados ⇒ abort', async () => {
  const m = mundoA6();
  const manifest = await dry(m);
  const editado = structuredClone(manifest) as ManifestDryRun;
  (editado.items.find((i) => i.dominio === 'ordenes_deposito') as { secuenciaPropuesta: number }).secuenciaPropuesta = 99;
  await assert.rejects(apply(m, editado), /itemsSha256/);
  await assert.rejects(apply(m, { ...manifest, itemsSha256: '0'.repeat(64) }), /itemsSha256/);
  assert.equal(m.stats.tx, 0);
});

test('MAN-8 · manifest con CONFLICTO o AMBIGUO ⇒ apply abort, 0 writes', async () => {
  for (const mutar of [
    (m: Mundo) => m.patch('usuarios', 'u3', { comercioId: 'otro' }),
    (m: Mundo) => m.put('comercios', 'u5', { authUid: 'otro' }),
    (m: Mundo) => m.put('solicitudes_envio', 'raro', { codigo: 'SH-0001' }),
  ]) {
    const m = mundoA6();
    mutar(m);
    const manifest = await dry(m);
    assert.ok(manifest.resumen.usuariosConflicto + manifest.resumen.codigosAmbiguosOConflicto > 0);
    await assert.rejects(apply(m, manifest), /CONFLICTO|AMBIGUO/);
    assert.equal(m.stats.tx, 0);
    assert.equal(m.stats.writes, 0);
  }
});

test('MAN-9 · resumen/huella coherentes: items repetidos o código incoherente con su secuencia ⇒ abort', async () => {
  const m = mundoA6();
  const manifest = await dry(m);
  const dup = structuredClone(manifest) as ManifestDryRun;
  dup.items.push(structuredClone(dup.items[0]));
  dup.itemsSha256 = huellaItems(dup.items);
  assert.throws(() => planificarApply(dup, PROYECTO_PRODUCCION, FUENTE), /repetido/);
  const mal = structuredClone(manifest) as ManifestDryRun;
  (mal.items.find((i) => i.dominio === 'solicitudes_envio') as { codigoPropuesto: string }).codigoPropuesto = 'SH-0009';
  mal.itemsSha256 = huellaItems(mal.items);
  assert.throws(() => planificarApply(mal, PROYECTO_PRODUCCION, FUENTE), /incoherente/);
});

test('EXTRA · un fallo inesperado detiene la corrida y la transacción no deja writes parciales', async () => {
  const m = mundoA6();
  const manifest = await dry(m);
  m.put('contadores', 'ordenes', { valor: 0 });
  const base = m.entorno;
  const roto: Entorno = {
    transaccion: (fn) => base.transaccion(async (tx) => {
      const r = await fn(tx);
      if (tx && (r as { writes?: unknown[] }).writes?.some((w) => (w as { coleccion: string }).coleccion === 'contadores')) throw new Error('boom');
      return r;
    }),
  };
  const r = await ejecutarApply(roto, manifest, { projectId: PROYECTO_PRODUCCION, ahora: AHORA, fuente: FUENTE });
  assert.equal(r.detenido, true);
  assert.equal(resultado(r, 'solicitudes_envio'), 'ERROR_STOP');
  assert.equal(m.get('solicitudes_envio', 'ord1')?.codigo, undefined); // código y contador van juntos: ninguno quedó escrito
  assert.deepEqual(m.get('contadores', 'ordenes'), { valor: 0 });
  assert.equal(r.resultados.length, 2); // usuarios aplicado + ordenes detenido; depósitos ni se intentó
});

test('EXTRA · el reporte de apply lista cada write con su valor previo (auditoría) y nada de historia inventada', async () => {
  const m = mundoA6();
  const r = await apply(m, await dry(m));
  const writes = r.resultados.flatMap((x) => x.writes);
  assert.equal(writes.length, 7 + (1 + 1) + (2 + 1));
  assert.deepEqual(writes.find((w) => w.id === 'ord1')?.nuevo, { codigo: 'SH-0001', secuencia: 1 });
  assert.equal(writes.find((w) => w.coleccion === 'contadores' && w.id === 'ordenes')?.operacion, 'create');
  assert.deepEqual(m.get('solicitudes_envio', 'ord1'), { estado: 'pendiente', createdAt: ts(100), codigo: 'SH-0001', secuencia: 1 });
  assert.equal(r.sourceGitSha, SHA);
});
