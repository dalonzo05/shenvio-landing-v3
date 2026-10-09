// CREDIT-ELIGIBILITY-1 — el crédito semanal lo autoriza comercios/{id}.tipoCliente, no la orden.
//
// CF1-CF7 prueban la decisión (pura) con el perfil del comercio como dato. Los AT prueban, sobre el código fuente, que la defensa vive DENTRO de la transacción
// de cada callable y ANTES de cualquier cálculo o write de dinero (así un rechazo deja 0 writes: lo confirma el runtime RT3 contra el emulador de Firestore).
import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  comercioIdDeCredito,
  evaluarCreditoAutorizado,
  exigirCreditoAutorizado,
  ordenEsCredito,
} from '../src/credito-elegibilidad';

const COM = 'com1';
const ordenBase = (extra: Record<string, unknown> = {}) => ({
  comercioId: COM, userId: COM, comercioUid: COM, ownerSnapshot: { uid: COM, companyName: 'Mariposita' },
  tipoCliente: 'contado', pagoDelivery: { tipo: 'contado', quienPaga: 'recoleccion' }, estado: 'en_camino_entrega', ...extra,
});
const CREDITO = { tipoCliente: 'credito', pagoDelivery: { tipo: 'credito_semanal', quienPaga: 'credito_semanal', montoSugerido: 150 } };
const codigoRechazo = (e: unknown) => {
  const err = e as { code?: string; details?: { motivo?: string } };
  return err.code === 'failed-precondition' && err.details?.motivo === 'credito_no_autorizado';
};

/** Lectura de comercio instrumentada: cuenta cuántas veces se lee y qué id. */
function lector(perfiles: Record<string, Record<string, unknown> | null>) {
  const leidos: string[] = [];
  return { leidos, leer: async (id: string) => { leidos.push(id); return perfiles[id] ?? null; } };
}

test('CF1 · crédito + comercio con tipoCliente=credito ⇒ PASS', async () => {
  const l = lector({ [COM]: { tipoCliente: 'credito' } });
  await exigirCreditoAutorizado(ordenBase(CREDITO), 'o1', l.leer);
  assert.deepEqual(l.leidos, [COM]);
  assert.deepEqual(evaluarCreditoAutorizado(ordenBase(CREDITO), { tipoCliente: 'credito' }), { ok: true });
});

test('CF2 · crédito + comercio contado ⇒ credito_no_autorizado (failed-precondition, motivo específico)', async () => {
  const l = lector({ [COM]: { tipoCliente: 'contado' } });
  await assert.rejects(exigirCreditoAutorizado(ordenBase(CREDITO), 'o2', l.leer), codigoRechazo);
});

test('CF3 · crédito + comercio sin tipoCliente (o doc inexistente) ⇒ rechazo: ausente = contado', async () => {
  await assert.rejects(exigirCreditoAutorizado(ordenBase(CREDITO), 'o3', lector({ [COM]: { name: 'Mariposita' } }).leer), codigoRechazo);
  await assert.rejects(exigirCreditoAutorizado(ordenBase(CREDITO), 'o3b', lector({}).leer), codigoRechazo);
  for (const raro of ['Credito', 'CREDITO', 'credito_semanal', '', null, true, 1, ['credito']]) {
    assert.equal(evaluarCreditoAutorizado(ordenBase(CREDITO), { tipoCliente: raro }).ok, false, `perfil ${JSON.stringify(raro)}`);
  }
});

test('CF4 · orden de contado ⇒ pasa sin leer el comercio (comportamiento existente intacto)', async () => {
  const l = lector({ [COM]: { tipoCliente: 'credito' } });
  await exigirCreditoAutorizado(ordenBase(), 'o4', l.leer);
  await exigirCreditoAutorizado(ordenBase({ pagoDelivery: { tipo: 'contado', quienPaga: 'entrega', deducirDelCobroContraEntrega: true } }), 'o4b', l.leer);
  await exigirCreditoAutorizado(ordenBase({ pagoDelivery: undefined, tipoCliente: undefined }), 'o4c', l.leer);
  assert.deepEqual(l.leidos, [], 'ni una lectura para contado');
});

test('CF5 · credito_semanal plantado con tipoCliente=contado en un comercio contado ⇒ rechazo (quienPaga y tipo, cada uno por sí solo)', async () => {
  const contado = lector({ [COM]: { tipoCliente: 'contado' } });
  for (const pagoDelivery of [
    { tipo: 'credito_semanal', quienPaga: 'credito_semanal' },
    { tipo: 'contado', quienPaga: 'credito_semanal' },
    { tipo: 'credito_semanal', quienPaga: 'entrega' },
  ]) {
    await assert.rejects(exigirCreditoAutorizado(ordenBase({ tipoCliente: 'contado', pagoDelivery }), 'o5', contado.leer), codigoRechazo, JSON.stringify(pagoDelivery));
  }
  // y tampoco sin tipoCliente
  await assert.rejects(exigirCreditoAutorizado(ordenBase({ tipoCliente: undefined, pagoDelivery: CREDITO.pagoDelivery }), 'o5b', contado.leer), codigoRechazo);
  // en un comercio elegible la misma combinación mixta ya es crédito para el servidor ⇒ autorizada
  await exigirCreditoAutorizado(ordenBase({ tipoCliente: 'contado', pagoDelivery: CREDITO.pagoDelivery }), 'o5c', lector({ [COM]: { tipoCliente: 'credito' } }).leer);
});

test('CF6 · cliente individual con crédito ⇒ rechazo (su userId no es un comercio; clienteUid no autoriza crédito)', async () => {
  const cliente = { userId: 'uid_cliente', comercioUid: 'uid_cliente', ownerSnapshot: { uid: 'uid_cliente', companyName: 'C' }, ...CREDITO, estado: 'en_camino_entrega' };
  // sin doc de comercio con ese id
  await assert.rejects(exigirCreditoAutorizado(cliente, 'o6', lector({ [COM]: { tipoCliente: 'credito' } }).leer), codigoRechazo);
  // aunque exista un comercio de crédito en el sistema, el cliente no lo hereda
  assert.equal(comercioIdDeCredito(cliente), 'uid_cliente');
});

test('CF7 · legacy de crédito no elegible: identidades divergentes, vacías o de tipo raro ⇒ fail closed sin leer un comercio ajeno', async () => {
  const l = lector({ [COM]: { tipoCliente: 'credito' }, otro: { tipoCliente: 'credito' } });
  for (const orden of [
    ordenBase({ ...CREDITO, userId: 'otro' }),                                  // userId ≠ comercioId: la deuda iría a otro
    ordenBase({ ...CREDITO, ownerSnapshot: { uid: 'otro' } }),                  // ownerSnapshot.uid ≠ comercioId
    ordenBase({ ...CREDITO, comercioUid: 'otro' }),
    ordenBase({ ...CREDITO, comercioId: undefined, userId: undefined, comercioUid: undefined, ownerSnapshot: {} }), // sin dueño
    ordenBase({ ...CREDITO, comercioId: 42 }),
    ordenBase({ ...CREDITO, comercioId: '   ' }),
  ]) {
    await assert.rejects(exigirCreditoAutorizado(orden, 'o7', l.leer), codigoRechazo);
  }
  assert.deepEqual(l.leidos, [], 'si no se puede demostrar el comercio no se lee ninguno');
  // Legacy SIN comercioId pero con userId/ownerSnapshot coherentes (anterior al Bloque 1): se resuelve por esa identidad única.
  const legacyElegible = ordenBase({ ...CREDITO, comercioId: undefined, comercioUid: undefined });
  assert.equal(comercioIdDeCredito(legacyElegible), COM);
  await exigirCreditoAutorizado(legacyElegible, 'o7b', lector({ [COM]: { tipoCliente: 'credito' } }).leer);
});

test('CF-def · una sola definición de "es crédito": tipoCliente, quienPaga o tipo; contado y datos raros no lo son', () => {
  assert.equal(ordenEsCredito({ tipoCliente: 'credito' }), true);
  assert.equal(ordenEsCredito({ pagoDelivery: { quienPaga: 'credito_semanal' } }), true);
  assert.equal(ordenEsCredito({ pagoDelivery: { tipo: 'credito_semanal' } }), true);
  assert.equal(ordenEsCredito({ tipoCliente: 'contado', pagoDelivery: { tipo: 'contado', quienPaga: 'entrega' } }), false);
  assert.equal(ordenEsCredito({}), false);
  assert.equal(ordenEsCredito({ pagoDelivery: null }), false);
  assert.equal(ordenEsCredito({ pagoDelivery: 'credito_semanal' }), false);
});

// ─── La defensa vive dentro de la transacción y antes de todo efecto económico ───────────────────────────────────
const src = (f: string) => readFileSync(join(__dirname, '..', '..', 'src', f), 'utf8');

test('CF-AT1 · confirmarTransicionConCobro: la defensa corre DENTRO de runTransaction, después de la precondición de estado y ANTES de calcDeposito / construirCobroDelivery / tx.update', () => {
  const s = src('motorizado-transiciones.ts');
  const ini = s.indexOf('export const confirmarTransicionConCobro');
  const cuerpo = s.slice(ini);
  const iTx = cuerpo.indexOf('db.runTransaction(');
  const iEstado = cuerpo.indexOf("const estadoRequerido = nuevo === 'retirado'");
  const iGate = cuerpo.indexOf('exigirCreditoAutorizado(');
  const iDep = cuerpo.indexOf('calcDeposito(orden)');
  const iCobro = cuerpo.indexOf('construirCobroDelivery(orden');
  const iUpdate = cuerpo.indexOf('tx.update(solicitudRef');
  assert.ok(iTx > 0 && iEstado > iTx && iGate > iEstado, 'la defensa va dentro de la transacción y después del estado');
  assert.ok(iGate < iDep && iGate < iCobro && iGate < iUpdate, 'la defensa va antes de cualquier cálculo o write de dinero');
  assert.equal((cuerpo.match(/exigirCreditoAutorizado\(/g) ?? []).length, 1);
  // el gate lee el comercio con tx.get (misma transacción), no con una lectura suelta
  assert.match(cuerpo.slice(iGate, iDep), /tx\.get\(db\.collection\('comercios'\)\.doc\(comercioId\)\)/);
  // y no hay ningún write antes de la defensa
  assert.equal(/tx\.(update|set|create|delete)\(|\.set\(|\.update\(/.test(cuerpo.slice(iTx, iGate)), false, 'ningún write antes del gate');
});

test('CF-AT2 · acumularCobroSemanalPorOrden (callable independiente): la defensa corre en la transacción, tras la rama idempotente y antes de crear o engrosar cobros_semanales', () => {
  const s = src('cobro-semanal.ts');
  const iTx = s.indexOf('db.runTransaction(');
  const iIdem = s.indexOf('yaAcumulada: true');
  const iGate = s.indexOf('exigirCreditoAutorizado(');
  const iAlta = s.indexOf('tx.set(cobroRef');
  const iInc = s.indexOf('tx.update(cobroRef');
  assert.ok(iTx > 0 && iIdem > iTx && iGate > iIdem && iGate < iAlta && iGate < iInc);
  assert.equal(/tx\.(update|set|create|delete)\(/.test(s.slice(s.indexOf('const marcadorAcumulado'), iGate).replace(/tx\.update\(ordenRef, marcadorAcumulado\)/g, '')), false, 'solo la corrección idempotente del marcador precede al gate');
});

test('CF-AT3 · el módulo de elegibilidad es puro: no importa firebase-admin ni toca Firestore, y no introduce callables nuevas', () => {
  const s = src('credito-elegibilidad.ts');
  assert.equal(/firebase-admin/.test(s), false);
  assert.equal(/onCall|onRequest|onDocument|onSchedule/.test(s), false);
  assert.equal(/\.(set|update|create|delete)\(/.test(s), false);
  const index = src('index.ts');
  assert.equal(/credito-elegibilidad/.test(index), false, 'no se exporta como Function');
});

test('CF-AT4 · registrarPagoCobroSemanal no decide elegibilidad: el pago de deuda ya creada no depende del perfil del comercio', () => {
  assert.equal(/credito-elegibilidad|exigirCreditoAutorizado/.test(src('registrar-pago-cobro-semanal.ts')), false);
  assert.equal(/credito-elegibilidad|exigirCreditoAutorizado/.test(src('registrar-pago-cobro-semanal-callable.ts')), false);
});
