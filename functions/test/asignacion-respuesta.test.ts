// VIAJE-RESPONDER-ASIGNACION-GUARD-1 — suite de `responderAsignacion`.
//
// Ejecuta la implementación real de `src/asignacion-respuesta.ts` con una
// transacción inyectada que registra cada escritura: sin emulador, y con la
// prueba directa de que un guard que falla NO deja ninguna escritura.
//
// El hallazgo que motiva el bloque: la callable validaba la pertenencia y que la
// asignación estuviera `pendiente`, pero no el estado de la solicitud. Una orden
// cancelada o cambiada por el gestor que conservara una asignación pendiente
// podía recibir después una aceptación o un rechazo (este último la devolvía a
// `confirmada`).

import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { DocumentData } from 'firebase-admin/firestore';
import {
  responderAsignacionEnTransaccion,
  ESTADO_RESPONDIBLE,
  type TransaccionRespuesta,
} from '../src/asignacion-respuesta';

const UID_MOTO = 'uid_moto';
const UID_OTRO = 'uid_otro';
const REF = { id: 'sol1' };

type Doc = DocumentData;

/** Transacción falsa con estado: aplica las escrituras al documento. */
function crearTx(inicial: Doc | null) {
  const actual: Doc | null = inicial === null ? null : JSON.parse(JSON.stringify(inicial));
  const escrituras: Record<string, unknown>[] = [];
  const tx: TransaccionRespuesta = {
    async get() {
      return { exists: actual !== null, data: () => (actual === null ? undefined : actual) };
    },
    update(_ref, data) {
      escrituras.push(data);
      if (actual === null) return;
      for (const [k, v] of Object.entries(data)) {
        if (k.includes('.')) {
          const [padre, hijo] = k.split('.');
          actual[padre] = { ...(actual[padre] ?? {}), [hijo]: v };
        } else {
          actual[k] = v;
        }
      }
    },
  };
  return { tx, escrituras, estado: () => actual };
}

function orden(extra: Doc = {}): Doc {
  return {
    estado: 'asignada',
    asignacion: { motorizadoAuthUid: UID_MOTO, motorizadoId: 'moto1', estadoAceptacion: 'pendiente' },
    ...extra,
  };
}

const codigo = (esperado: string) => (e: unknown) => (e as { code?: string }).code === esperado;

// ─── Permitido ────────────────────────────────────────────────────────────────

test('RA1 · aceptar desde asignada con la asignación pendiente → conserva el comportamiento', async () => {
  const { tx, escrituras } = crearTx(orden());
  await responderAsignacionEnTransaccion(tx, REF, UID_MOTO, 'aceptar');
  assert.equal(escrituras.length, 1);
  assert.deepEqual(Object.keys(escrituras[0]).sort(), ['asignacion.aceptadoAt', 'asignacion.estadoAceptacion', 'updatedAt']);
  assert.equal(escrituras[0]['asignacion.estadoAceptacion'], 'aceptada');
  assert.ok(!('estado' in escrituras[0]), 'aceptar no mueve el estado de la solicitud');
});

test('RA2 · rechazar desde asignada con la asignación pendiente → conserva el comportamiento', async () => {
  const { tx, escrituras } = crearTx(orden());
  await responderAsignacionEnTransaccion(tx, REF, UID_MOTO, 'rechazar');
  assert.equal(escrituras.length, 1);
  assert.equal(escrituras[0].estado, 'confirmada');
  assert.equal(escrituras[0].asignacion, null);
  assert.deepEqual(Object.keys(escrituras[0]).sort(), ['asignacion', 'estado', 'updatedAt']);
});

// ─── Denegado: la solicitud ya no está en `asignada` ──────────────────────────

// Estados reales de solicitudes_envio. `pendiente_confirmacion` es el estado
// inicial y el destino de "Reactivar orden"; `programada` se escribe en la
// creación aunque no tenga máquina declarada (VIAJE-ESTADO-PROGRAMADA-SIN-MAQUINA).
const NO_RESPONDIBLES: [string, string][] = [
  ['RA3', 'confirmada'],
  ['RA4', 'cancelada'],
  ['RA5', 'rechazada'],
  ['RA6', 'en_camino_retiro'],
  ['RA7', 'retirado'],
  ['RA8', 'en_camino_entrega'],
  ['RA9', 'entregado'],
  ['RA9b', 'pendiente_confirmacion'],
  ['RA9c', 'programada'],
];

for (const [id, estado] of NO_RESPONDIBLES) {
  test(`${id} · estado ${estado} → failed-precondition y 0 escrituras`, async () => {
    for (const aceptacion of ['pendiente', 'aceptada']) {
      for (const accion of ['aceptar', 'rechazar'] as const) {
        const asignacion = { motorizadoAuthUid: UID_MOTO, estadoAceptacion: aceptacion };
        const { tx, escrituras, estado: doc } = crearTx(orden({ estado, asignacion }));
        const antes = JSON.stringify(doc());
        await assert.rejects(responderAsignacionEnTransaccion(tx, REF, UID_MOTO, accion), codigo('failed-precondition'));
        assert.equal(escrituras.length, 0, `${estado}/${aceptacion}/${accion}`);
        assert.equal(JSON.stringify(doc()), antes, 'el documento no cambió');
      }
    }
  });
}

test('RA9d · una solicitud sin estado tampoco se puede responder', async () => {
  const { tx, escrituras } = crearTx({ asignacion: { motorizadoAuthUid: UID_MOTO, estadoAceptacion: 'pendiente' } });
  await assert.rejects(responderAsignacionEnTransaccion(tx, REF, UID_MOTO, 'aceptar'), codigo('failed-precondition'));
  assert.equal(escrituras.length, 0);
});

// ─── Los guards existentes siguen intactos ────────────────────────────────────

test('RA10 · asignada pero el llamador no es el motorizado asignado → permission-denied y 0 escrituras', async () => {
  const { tx, escrituras } = crearTx(orden());
  await assert.rejects(responderAsignacionEnTransaccion(tx, REF, UID_OTRO, 'aceptar'), codigo('permission-denied'));
  assert.equal(escrituras.length, 0);
});

test('RA10b · un ajeno recibe permission-denied también cuando la orden no es respondible: no se filtra el estado', async () => {
  for (const [, estado] of NO_RESPONDIBLES) {
    const { tx, escrituras } = crearTx(orden({ estado }));
    await assert.rejects(responderAsignacionEnTransaccion(tx, REF, UID_OTRO, 'rechazar'), codigo('permission-denied'), estado);
    assert.equal(escrituras.length, 0);
  }
  // Sin asignación (p. ej. ya rechazada o rebotada): tampoco es suya.
  const sinAsignacion = crearTx(orden({ estado: 'confirmada', asignacion: null }));
  await assert.rejects(responderAsignacionEnTransaccion(sinAsignacion.tx, REF, UID_MOTO, 'aceptar'), codigo('permission-denied'));
  assert.equal(sinAsignacion.escrituras.length, 0);
});

test('RA10c · la solicitud inexistente → not-found', async () => {
  const { tx, escrituras } = crearTx(null);
  await assert.rejects(responderAsignacionEnTransaccion(tx, REF, UID_MOTO, 'aceptar'), codigo('not-found'));
  assert.equal(escrituras.length, 0);
});

test('RA11 · asignada con la asignación ya respondida → conserva el error y el mensaje actuales', async () => {
  for (const aceptacion of ['aceptada', 'rechazada', 'expirada', undefined]) {
    const { tx, escrituras } = crearTx(orden({ asignacion: { motorizadoAuthUid: UID_MOTO, estadoAceptacion: aceptacion } }));
    await assert.rejects(
      responderAsignacionEnTransaccion(tx, REF, UID_MOTO, 'aceptar'),
      (e: unknown) =>
        (e as { code?: string }).code === 'failed-precondition' &&
        (e as { message?: string }).message === 'Esta asignación ya no está pendiente de respuesta.',
      String(aceptacion),
    );
    assert.equal(escrituras.length, 0);
  }
});

test('RA12 · un segundo intento después de responder falla: no hay éxito idempotente', async () => {
  const aceptada = crearTx(orden());
  await responderAsignacionEnTransaccion(aceptada.tx, REF, UID_MOTO, 'aceptar');
  for (const accion of ['aceptar', 'rechazar'] as const) {
    await assert.rejects(responderAsignacionEnTransaccion(aceptada.tx, REF, UID_MOTO, accion), codigo('failed-precondition'));
  }
  assert.equal(aceptada.escrituras.length, 1, 'el segundo intento no escribió nada');

  const rechazada = crearTx(orden());
  await responderAsignacionEnTransaccion(rechazada.tx, REF, UID_MOTO, 'rechazar');
  // Tras rechazar, la asignación ya no existe: la orden dejó de ser suya.
  for (const accion of ['aceptar', 'rechazar'] as const) {
    await assert.rejects(responderAsignacionEnTransaccion(rechazada.tx, REF, UID_MOTO, accion), codigo('permission-denied'));
  }
  assert.equal(rechazada.escrituras.length, 1);
});

test('RA13 · una solicitud cancelada con asignación residual NO vuelve a confirmada al rechazar', async () => {
  // El daño concreto que este bloque cierra.
  const { tx, escrituras, estado } = crearTx(orden({ estado: 'cancelada' }));
  await assert.rejects(responderAsignacionEnTransaccion(tx, REF, UID_MOTO, 'rechazar'), codigo('failed-precondition'));
  assert.equal(estado()!.estado, 'cancelada');
  assert.equal(escrituras.length, 0);
});

// ─── Orden de los guards, sobre la fuente real ────────────────────────────────

test('VG1 · el guard de estado no desplaza las garantías de actor y pertenencia', () => {
  // El test corre compilado desde `.test-build/test/`: la fuente real queda en
  // `functions/src/`, dos niveles arriba.
  const src = readFileSync(join(__dirname, '..', '..', 'src', 'asignacion-respuesta.ts'), 'utf8');
  const iExiste = src.indexOf("'not-found'");
  const iPertenencia = src.indexOf('asignacion.motorizadoAuthUid !== motorizadoUid');
  const iEstado = src.indexOf('solicitud.estado !== ESTADO_RESPONDIBLE');
  const iPendiente = src.indexOf("asignacion.estadoAceptacion !== 'pendiente'");
  const iEscritura = src.indexOf('tx.update(');
  for (const [nombre, i] of Object.entries({ iExiste, iPertenencia, iEstado, iPendiente, iEscritura })) {
    assert.ok(i > 0, `falta ${nombre}`);
  }
  assert.ok(iExiste < iPertenencia, 'la existencia va primero');
  assert.ok(iPertenencia < iEstado, 'un ajeno llegaría a saber el estado de una orden que no es suya');
  assert.ok(iEstado < iPendiente, 'el estado se valida antes que la aceptación');
  assert.ok(iPendiente < iEscritura, 'se escribiría antes de terminar de validar');
  assert.ok(iEstado < iEscritura, 'el guard de estado debe ir antes de cualquier mutación');
  assert.equal(ESTADO_RESPONDIBLE, 'asignada');
});

test('VG2 · la callable sigue validando auth y perfil antes de entrar a la transacción', () => {
  const src = readFileSync(join(__dirname, '..', '..', 'src', 'motorizado-transiciones.ts'), 'utf8');
  const iInicio = src.indexOf('export const responderAsignacion');
  const iFin = src.indexOf('// confirmarTransicionConCobro');
  assert.ok(iInicio > 0 && iFin > iInicio, 'no se encontró la callable');
  const cuerpo = src.slice(iInicio, iFin);
  const iAuth = cuerpo.indexOf("'unauthenticated'");
  const iPayload = cuerpo.indexOf("'Payload inválido.'");
  const iPerfil = cuerpo.indexOf('await usuarioMotorizadoActivo(db, motorizadoUid)');
  const iTx = cuerpo.indexOf('responderAsignacionEnTransaccion(tx, solicitudRef, motorizadoUid, accion)');
  assert.ok(iAuth > 0 && iPayload > 0 && iPerfil > 0 && iTx > 0, 'falta un guard');
  assert.ok(iAuth < iPayload && iPayload < iPerfil && iPerfil < iTx, 'los guards de la callable cambiaron de orden');
  assert.ok(!cuerpo.includes('tx.update('), 'la callable no debe escribir por fuera del módulo con los guards');
});
