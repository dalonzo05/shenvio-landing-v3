// MOTO-RANKING-UBICACION-FRESCA-1 — suite de actualizarPresenciaMotorizadoCore.
//
// Núcleo puro con deps inyectadas (mismo patrón que acceso-motorizado.ts y
// asignacion-respuesta.ts): sin emulador.

import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  actualizarPresenciaMotorizadoCore,
  leerPresenciaSolicitada,
  type DepsPresencia,
  type PresenciaEscribible,
} from '../src/presencia-motorizado';

const UID = 'uid_moto';
const AHORA = 'SERVER_TS';

function crearDeps(opts: {
  usuario?: { rol?: unknown; activo?: unknown } | null;
  ids?: string[];
} = {}) {
  const usuario = opts.usuario !== undefined ? opts.usuario : { rol: 'motorizado', activo: true };
  const ids = opts.ids ?? ['moto1'];
  const escrituras: { motorizadoId: string; estado: PresenciaEscribible; ahora: unknown }[] = [];
  const llamadas: string[] = [];
  const deps: DepsPresencia = {
    async getUsuario(uid) {
      llamadas.push(`getUsuario:${uid}`);
      return usuario;
    },
    async motorizadosConAuthUid(uid) {
      llamadas.push(`motorizadosConAuthUid:${uid}`);
      return ids;
    },
    async actualizarPresencia(motorizadoId, estado, ahora) {
      escrituras.push({ motorizadoId, estado, ahora });
    },
  };
  return { deps, escrituras, llamadas };
}

const codigo = (esperado: string) => (e: unknown) => (e as { code?: string }).code === esperado;

// ─── leerPresenciaSolicitada ────────────────────────────────────────────────

test('leerPresenciaSolicitada · acepta exactamente { estado } con disponible o inactivo', () => {
  assert.equal(leerPresenciaSolicitada({ estado: 'disponible' }), 'disponible');
  assert.equal(leerPresenciaSolicitada({ estado: 'inactivo' }), 'inactivo');
});

test('PRES6 · leerPresenciaSolicitada · payload con estado inventado → invalid-argument', () => {
  for (const malo of ['ocupado', 'en_linea', 'ACTIVO', '', 1, true, null]) {
    assert.throws(() => leerPresenciaSolicitada({ estado: malo }), codigo('invalid-argument'), String(malo));
  }
});

test('PRES7 · leerPresenciaSolicitada · protocolo/estado = ocupado se rechaza (no se genera un ocupado nuevo)', () => {
  assert.throws(() => leerPresenciaSolicitada({ estado: 'ocupado' }), codigo('invalid-argument'));
});

test('leerPresenciaSolicitada · payload malformado o con campos de más → invalid-argument', () => {
  for (const malo of [null, undefined, 'x', 1, [], {}, { estado: 'disponible', extra: 1 }, { otraCosa: 'disponible' }]) {
    assert.throws(() => leerPresenciaSolicitada(malo), codigo('invalid-argument'), JSON.stringify(malo));
  }
});

// ─── actualizarPresenciaMotorizadoCore ──────────────────────────────────────

test('PRES1 · motorizado activo autenticado → disponible: estado + presenciaUpdatedAt server-side, una sola escritura', async () => {
  const { deps, escrituras } = crearDeps();
  const r = await actualizarPresenciaMotorizadoCore(deps, UID, { estado: 'disponible' }, AHORA);
  assert.deepEqual(r, { ok: true, estado: 'disponible' });
  assert.equal(escrituras.length, 1);
  assert.deepEqual(escrituras[0], { motorizadoId: 'moto1', estado: 'disponible', ahora: AHORA });
});

test('PRES2 · motorizado activo autenticado → inactivo: mismo contrato', async () => {
  const { deps, escrituras } = crearDeps();
  const r = await actualizarPresenciaMotorizadoCore(deps, UID, { estado: 'inactivo' }, AHORA);
  assert.deepEqual(r, { ok: true, estado: 'inactivo' });
  assert.equal(escrituras.length, 1);
  assert.equal(escrituras[0].estado, 'inactivo');
});

test('PRES3 · no autenticado → la callable (no el core) exige auth; el core en sí exige uid', async () => {
  // El core recibe siempre un uid (la callable revisa request.auth antes de llamarlo).
  // Acá se demuestra que sin perfil válido para ESE uid, se deniega igual.
  const { deps } = crearDeps({ usuario: null });
  await assert.rejects(actualizarPresenciaMotorizadoCore(deps, 'uid_fantasma', { estado: 'disponible' }, AHORA), codigo('permission-denied'));
});

test('PRES4 · usuario no motorizado (u otro rol) → permission-denied, 0 escrituras', async () => {
  for (const usuario of [{ rol: 'gestor', activo: true }, { rol: 'admin', activo: true }, { rol: 'Comercio', activo: true }, null]) {
    const { deps, escrituras } = crearDeps({ usuario });
    await assert.rejects(actualizarPresenciaMotorizadoCore(deps, UID, { estado: 'disponible' }, AHORA), codigo('permission-denied'));
    assert.equal(escrituras.length, 0);
  }
});

test('PRES5 · motorizado con activo !== true → permission-denied, mismo criterio que isMotorizadoRole() en Rules', async () => {
  for (const usuario of [{ rol: 'motorizado', activo: false }, { rol: 'motorizado', activo: undefined }, { rol: 'motorizado' }]) {
    const { deps, escrituras } = crearDeps({ usuario });
    await assert.rejects(actualizarPresenciaMotorizadoCore(deps, UID, { estado: 'disponible' }, AHORA), codigo('permission-denied'));
    assert.equal(escrituras.length, 0);
  }
});

test('vínculo · sin motorizado vinculado → permission-denied; más de uno → failed-precondition (mismo criterio que acceso-motorizado.ts)', async () => {
  const sinVinculo = crearDeps({ ids: [] });
  await assert.rejects(actualizarPresenciaMotorizadoCore(sinVinculo.deps, UID, { estado: 'disponible' }, AHORA), codigo('permission-denied'));
  assert.equal(sinVinculo.escrituras.length, 0);

  const dosVinculos = crearDeps({ ids: ['moto1', 'moto2'] });
  await assert.rejects(actualizarPresenciaMotorizadoCore(dosVinculos.deps, UID, { estado: 'disponible' }, AHORA), codigo('failed-precondition'));
  assert.equal(dosVinculos.escrituras.length, 0);
});

test('PRES8 · legacy ocupado → inactivo: el core lo permite igual que cualquier transición a inactivo (no distingue el valor previo)', async () => {
  // El core no lee el estado previo del motorizado (no lo necesita: sobrescribe
  // `estado` sin condicionarlo al valor anterior, igual que hacía el updateDoc directo).
  const { deps, escrituras } = crearDeps();
  await actualizarPresenciaMotorizadoCore(deps, UID, { estado: 'inactivo' }, AHORA);
  assert.equal(escrituras[0].estado, 'inactivo');
});

test('PRES9 · la escritura toca únicamente estado/presenciaUpdatedAt/updatedAt: nada de métricas, asignaciones, ubicación ni finanzas', () => {
  const src = readFileSyncSrc('presencia-motorizado-callable.ts');
  const i = src.indexOf('async actualizarPresencia(');
  const fin = src.indexOf('};', i);
  const cuerpo = src.slice(i, fin);
  assert.ok(cuerpo.includes('estado,') && cuerpo.includes('presenciaUpdatedAt: ahora') && cuerpo.includes('updatedAt: ahora'));
  for (const campoAjeno of ['metricasAceptacion', 'totalAceptadas', 'totalRechazos', 'ultimaUbicacionOperativa', 'asignacion', 'cobros']) {
    assert.ok(!cuerpo.includes(campoAjeno), campoAjeno);
  }
});

test('PRES10 · presenciaUpdatedAt nunca sale del payload del cliente: siempre es el `ahora` que inyecta la callable (FieldValue.serverTimestamp())', async () => {
  const { deps, escrituras } = crearDeps();
  // Un intento de colar un timestamp propio en el payload no cambia nada: leerPresenciaSolicitada
  // solo acepta la clave `estado`, así que un campo extra lo rechaza de entrada.
  await assert.rejects(
    actualizarPresenciaMotorizadoCore(deps, UID, { estado: 'disponible', presenciaUpdatedAt: 'falsificado' }, AHORA),
    codigo('invalid-argument'),
  );
  assert.equal(escrituras.length, 0);
  // Con el payload válido, el `ahora` escrito es exactamente el que inyecta la callable.
  await actualizarPresenciaMotorizadoCore(deps, UID, { estado: 'disponible' }, AHORA);
  assert.equal(escrituras[0].ahora, AHORA);

  const callable = readFileSyncSrc('presencia-motorizado-callable.ts');
  assert.ok(callable.includes('FieldValue.serverTimestamp()'));
  assert.ok(!callable.includes('request.data.presenciaUpdatedAt') && !callable.includes('request.data.ahora'));
});

// ─── helper ──────────────────────────────────────────────────────────────────

function readFileSyncSrc(nombre: string): string {
  return readFileSync(join(__dirname, '..', '..', 'src', nombre), 'utf8');
}
