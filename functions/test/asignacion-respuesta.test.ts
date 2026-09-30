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
  construirRechazo,
  construirAceptacion,
  proyectarMetricasAceptacion,
  espejoLegacy,
  leerProtocoloRespuesta,
  PROTOCOLO_METRICAS_SERVIDOR,
  type OpcionesRespuesta,
  EVENTO_RECHAZO_MOTORIZADO,
  EVENTO_ACEPTACION_MOTORIZADO,
  VERSION_METRICAS_ACEPTACION,
  ESTADO_RESPONDIBLE,
  type TransaccionRespuesta,
} from '../src/asignacion-respuesta';

const UID_MOTO = 'uid_moto';
const UID_OTRO = 'uid_otro';
// Referencia falsa a la solicitud: `collection('eventos').doc()` entrega ids
// distintos en cada llamada, como Firestore.
function crearRef(id = 'sol1') {
  let n = 0;
  return { id, collection: () => ({ doc: () => ({ id: `ev${++n}` }) }) };
}
const REF = crearRef();

type Doc = DocumentData;

/** Referencia falsa a motorizado/{id}. */
const REFMOTO = (id: string) => ({ motoId: id });
const AHORA_MS = 1_800_000_000_000;

/**
 * Transacción falsa con estado: aplica las escrituras a la solicitud. `escrituras`
 * son los update de la SOLICITUD; los del motorizado van aparte (`motoEscrituras`).
 * El motorizado, si no se indica, es el dueño de la asignación (mismo authUid).
 */
function clonar<T>(v: T): T {
  if (typeof v !== 'object' || v === null) return v;
  if (Array.isArray(v)) return v.map(clonar) as unknown as T;
  return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, clonar(x)])) as T;
}

function crearTx(inicial: Doc | null, motoInicial?: Doc | null) {
  let actual: Doc | null = inicial === null ? null : clonar(inicial);
  const uidAsignado = inicial?.asignacion?.motorizadoAuthUid;
  const moto: Doc | null =
    motoInicial !== undefined
      ? motoInicial === null ? null : clonar(motoInicial)
      : typeof uidAsignado === 'string' ? { authUid: uidAsignado } : null;
  const escrituras: Record<string, unknown>[] = [];
  const motoEscrituras: Record<string, unknown>[] = [];
  // Lo creado con `set` (los eventos): una entrada por evento, nunca se pisa.
  const sets: { ref: unknown; data: Record<string, unknown> }[] = [];
  const esMoto = (ref: unknown) => typeof ref === 'object' && ref !== null && 'motoId' in ref;
  const tx: TransaccionRespuesta = {
    async get(ref) {
      if (esMoto(ref)) return { exists: moto !== null, data: () => (moto === null ? undefined : moto) };
      return { exists: actual !== null, data: () => (actual === null ? undefined : actual) };
    },
    update(ref, data) {
      if (esMoto(ref)) {
        motoEscrituras.push(data);
        if (moto !== null) Object.assign(moto, data);
        return;
      }
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
    set(ref, data) {
      sets.push({ ref, data });
    },
  };
  // El gestor reasigna: cambia el documento por fuera de la transacción.
  const reemplazar = (nuevo: Doc | null) => {
    actual = nuevo === null ? null : clonar(nuevo);
  };
  return { tx, escrituras, motoEscrituras, sets, estado: () => actual, moto: () => moto, reemplazar };
}

const responder = (
  tx: TransaccionRespuesta,
  ref: Parameters<typeof responderAsignacionEnTransaccion>[1],
  uid: string,
  accion: 'aceptar' | 'rechazar',
  opciones: OpcionesRespuesta = { espejoLegacy: true },
) => responderAsignacionEnTransaccion(tx, ref, uid, accion, REFMOTO, opciones, AHORA_MS);

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
  await responder(tx, REF, UID_MOTO, 'aceptar');
  assert.equal(escrituras.length, 1);
  assert.deepEqual(Object.keys(escrituras[0]).sort(), ['asignacion.aceptadoAt', 'asignacion.estadoAceptacion', 'updatedAt']);
  assert.equal(escrituras[0]['asignacion.estadoAceptacion'], 'aceptada');
  assert.ok(!('estado' in escrituras[0]), 'aceptar no mueve el estado de la solicitud');
});

test('RA2 · rechazar desde asignada con la asignación pendiente → conserva el comportamiento', async () => {
  const { tx, escrituras } = crearTx(orden());
  await responder(tx, REF, UID_MOTO, 'rechazar');
  assert.equal(escrituras.length, 1);
  assert.equal(escrituras[0].estado, 'confirmada');
  assert.equal(escrituras[0].asignacion, null);
  assert.deepEqual(Object.keys(escrituras[0]).sort(), ['asignacion', 'estado', 'ultimoRechazoMotorizado', 'updatedAt']);
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
        await assert.rejects(responder(tx, REF, UID_MOTO, accion), codigo('failed-precondition'));
        assert.equal(escrituras.length, 0, `${estado}/${aceptacion}/${accion}`);
        assert.equal(JSON.stringify(doc()), antes, 'el documento no cambió');
      }
    }
  });
}

test('RA9d · una solicitud sin estado tampoco se puede responder', async () => {
  const { tx, escrituras } = crearTx({ asignacion: { motorizadoAuthUid: UID_MOTO, estadoAceptacion: 'pendiente' } });
  await assert.rejects(responder(tx, REF, UID_MOTO, 'aceptar'), codigo('failed-precondition'));
  assert.equal(escrituras.length, 0);
});

// ─── Los guards existentes siguen intactos ────────────────────────────────────

test('RA10 · asignada pero el llamador no es el motorizado asignado → permission-denied y 0 escrituras', async () => {
  const { tx, escrituras } = crearTx(orden());
  await assert.rejects(responder(tx, REF, UID_OTRO, 'aceptar'), codigo('permission-denied'));
  assert.equal(escrituras.length, 0);
});

test('RA10b · un ajeno recibe permission-denied también cuando la orden no es respondible: no se filtra el estado', async () => {
  for (const [, estado] of NO_RESPONDIBLES) {
    const { tx, escrituras } = crearTx(orden({ estado }));
    await assert.rejects(responder(tx, REF, UID_OTRO, 'rechazar'), codigo('permission-denied'), estado);
    assert.equal(escrituras.length, 0);
  }
  // Sin asignación (p. ej. ya rechazada o rebotada): tampoco es suya.
  const sinAsignacion = crearTx(orden({ estado: 'confirmada', asignacion: null }));
  await assert.rejects(responder(sinAsignacion.tx, REF, UID_MOTO, 'aceptar'), codigo('permission-denied'));
  assert.equal(sinAsignacion.escrituras.length, 0);
});

test('RA10c · la solicitud inexistente → not-found', async () => {
  const { tx, escrituras } = crearTx(null);
  await assert.rejects(responder(tx, REF, UID_MOTO, 'aceptar'), codigo('not-found'));
  assert.equal(escrituras.length, 0);
});

test('RA11 · asignada con la asignación ya respondida → conserva el error y el mensaje actuales', async () => {
  for (const aceptacion of ['aceptada', 'rechazada', 'expirada', undefined]) {
    const { tx, escrituras } = crearTx(orden({ asignacion: { motorizadoAuthUid: UID_MOTO, estadoAceptacion: aceptacion } }));
    await assert.rejects(
      responder(tx, REF, UID_MOTO, 'aceptar'),
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
  await responder(aceptada.tx, REF, UID_MOTO, 'aceptar');
  for (const accion of ['aceptar', 'rechazar'] as const) {
    await assert.rejects(responder(aceptada.tx, REF, UID_MOTO, accion), codigo('failed-precondition'));
  }
  assert.equal(aceptada.escrituras.length, 1, 'el segundo intento no escribió nada');

  const rechazada = crearTx(orden());
  await responder(rechazada.tx, REF, UID_MOTO, 'rechazar');
  // Tras rechazar, la asignación ya no existe: la orden dejó de ser suya.
  for (const accion of ['aceptar', 'rechazar'] as const) {
    await assert.rejects(responder(rechazada.tx, REF, UID_MOTO, accion), codigo('permission-denied'));
  }
  assert.equal(rechazada.escrituras.length, 1);
});

test('RA13 · una solicitud cancelada con asignación residual NO vuelve a confirmada al rechazar', async () => {
  // El daño concreto que este bloque cierra.
  const { tx, escrituras, estado } = crearTx(orden({ estado: 'cancelada' }));
  await assert.rejects(responder(tx, REF, UID_MOTO, 'rechazar'), codigo('failed-precondition'));
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
  const iTx = cuerpo.indexOf('responderAsignacionEnTransaccion(tx, solicitudRef, motorizadoUid, accion, (id) =>');
  assert.ok(iAuth > 0 && iPayload > 0 && iPerfil > 0 && iTx > 0, 'falta un guard');
  assert.ok(iAuth < iPayload && iPayload < iPerfil && iPerfil < iTx, 'los guards de la callable cambiaron de orden');
  assert.ok(!cuerpo.includes('tx.update('), 'la callable no debe escribir por fuera del módulo con los guards');
});

// ─── VIAJE-RECHAZO-MOTORIZADO-TRAZA-1 · la traza del rechazo ──────────────────
//
// Rechazar devuelve la solicitud a `confirmada` y borra la asignación. Antes de
// borrarla, quién rechazó y cuándo queda en un evento append-only escrito en la
// MISMA transacción, más un resumen en la solicitud para el listado.

const UID_A = 'uid_moto_a';
const UID_B = 'uid_moto_b';

function asignadaA(uid: string, id: string, nombre: string | null, extra: DocumentData = {}): Doc {
  return orden({
    asignacion: {
      motorizadoAuthUid: uid,
      motorizadoId: id,
      ...(nombre === null ? {} : { motorizadoNombre: nombre }),
      motorizadoTelefono: '8888-0000',
      estadoAceptacion: 'pendiente',
      ...extra,
    },
  });
}

test('RM1 · rechazar desde asignada vuelve a confirmada, limpia la asignación y deja UN evento con la identidad', async () => {
  const { tx, escrituras, sets, estado } = crearTx(asignadaA(UID_A, 'moto_a', 'John Pork 2'));
  await responder(tx, crearRef(), UID_A, 'rechazar');

  assert.equal(estado()!.estado, 'confirmada');
  assert.equal(estado()!.asignacion, null);

  assert.equal(sets.length, 1, 'exactamente un evento');
  const evento = sets[0].data;
  assert.equal(evento.tipo, EVENTO_RECHAZO_MOTORIZADO);
  assert.equal(evento.tipo, 'rechazo_motorizado');
  assert.equal(evento.porUid, UID_A);
  assert.equal(evento.motorizadoId, 'moto_a');
  assert.equal(evento.motorizadoNombre, 'John Pork 2');
  assert.equal(evento.solicitudId, 'sol1');
  // El sello lo pone el servidor: nunca una hora que mande el cliente.
  assert.equal(typeof evento.at, 'object');
  assert.ok(!(evento.at instanceof Date));
  assert.equal(evento.at, escrituras[0].updatedAt, 'mismo instante que la transición');
  // Sin motivo inventado, sin teléfono, sin rol.
  assert.deepEqual(Object.keys(evento).sort(), ['at', 'motorizadoId', 'motorizadoNombre', 'porUid', 'solicitudId', 'tipo']);
});

test('RM2 · aceptar no crea evento ni resumen de rechazo (deja el de aceptación)', async () => {
  const { tx, escrituras, sets, estado } = crearTx(asignadaA(UID_A, 'moto_a', 'John Pork 2'));
  await responder(tx, crearRef(), UID_A, 'aceptar');
  assert.equal(sets.length, 1);
  assert.equal(sets[0].data.tipo, 'aceptacion_motorizado');
  assert.notEqual(sets[0].data.tipo, 'rechazo_motorizado');
  assert.ok(!('ultimoRechazoMotorizado' in escrituras[0]));
  assert.ok(!('ultimoRechazoMotorizado' in estado()!));
});

test('RM3 · un rechazo bloqueado por estado inválido no cambia nada ni deja evento', async () => {
  for (const estadoOrden of ['confirmada', 'cancelada', 'en_camino_retiro', 'entregado']) {
    const { tx, escrituras, sets } = crearTx({ ...asignadaA(UID_A, 'moto_a', 'John Pork 2'), estado: estadoOrden });
    await assert.rejects(responder(tx, crearRef(), UID_A, 'rechazar'), codigo('failed-precondition'));
    assert.equal(escrituras.length, 0, estadoOrden);
    assert.equal(sets.length, 0, estadoOrden);
  }
});

test('RM4 · un llamador ajeno no deja evento', async () => {
  const { tx, escrituras, sets } = crearTx(asignadaA(UID_A, 'moto_a', 'John Pork 2'));
  await assert.rejects(responder(tx, crearRef(), UID_B, 'rechazar'), codigo('permission-denied'));
  assert.equal(sets.length, 0);
  assert.equal(escrituras.length, 0);
});

test('RM5 · una asignación que ya no está pendiente no deja evento', async () => {
  for (const aceptacion of ['aceptada', 'rechazada', 'expirada']) {
    const { tx, sets } = crearTx(asignadaA(UID_A, 'moto_a', 'John Pork 2', { estadoAceptacion: aceptacion }));
    await assert.rejects(responder(tx, crearRef(), UID_A, 'rechazar'), codigo('failed-precondition'));
    assert.equal(sets.length, 0, aceptacion);
  }
});

test('RM6 · dos rechazos por motorizados distintos dejan dos eventos y ninguno pisa al otro', async () => {
  const ref = crearRef();
  const t = crearTx(asignadaA(UID_A, 'moto_a', 'John Pork 2'));
  await responder(t.tx, ref, UID_A, 'rechazar');
  const primero = JSON.stringify(t.sets[0]);

  // El gestor reasigna a B y B también rechaza.
  t.reemplazar(asignadaA(UID_B, 'moto_b', 'María López'));
  await responder(t.tx, ref, UID_B, 'rechazar');

  assert.equal(t.sets.length, 2);
  assert.notEqual((t.sets[0].ref as { id: string }).id, (t.sets[1].ref as { id: string }).id, 'ids de evento distintos');
  assert.equal(JSON.stringify(t.sets[0]), primero, 'el primer evento no cambió');
  assert.equal(t.sets[0].data.motorizadoNombre, 'John Pork 2');
  assert.equal(t.sets[1].data.motorizadoNombre, 'María López');
  assert.equal(t.sets[0].data.porUid, UID_A);
  assert.equal(t.sets[1].data.porUid, UID_B);
});

test('RM7 · el resumen apunta al rechazo más reciente', async () => {
  const ref = crearRef();
  const t = crearTx(asignadaA(UID_A, 'moto_a', 'John Pork 2'));
  await responder(t.tx, ref, UID_A, 'rechazar');
  const idA = (t.sets[0].ref as { id: string }).id;
  assert.equal((t.estado()!.ultimoRechazoMotorizado as DocumentData).eventoId, idA);

  t.reemplazar({ ...asignadaA(UID_B, 'moto_b', 'María López'), ultimoRechazoMotorizado: t.estado()!.ultimoRechazoMotorizado });
  await responder(t.tx, ref, UID_B, 'rechazar');
  const idB = (t.sets[1].ref as { id: string }).id;
  const resumen = t.estado()!.ultimoRechazoMotorizado as DocumentData;
  assert.equal(resumen.eventoId, idB, 'apunta al evento de B');
  assert.notEqual(resumen.eventoId, idA);
  assert.equal(resumen.motorizadoNombre, 'María López');
  assert.equal(resumen.motorizadoId, 'moto_b');
  assert.equal(resumen.rechazadoAt, t.sets[1].data.at, 'mismo instante que el evento');
});

test('RM8 · la identidad del evento sale de la asignación en el instante del rechazo, no de una lectura posterior', async () => {
  const t = crearTx(asignadaA(UID_A, 'moto_a', 'John Pork 2'));
  await responder(t.tx, crearRef(), UID_A, 'rechazar');
  // La asignación ya no existe, pero el evento y el resumen conservan quién fue.
  assert.equal(t.estado()!.asignacion, null);
  assert.equal(t.sets[0].data.motorizadoNombre, 'John Pork 2');
  assert.equal((t.estado()!.ultimoRechazoMotorizado as DocumentData).motorizadoNombre, 'John Pork 2');

  // Sin nombre o sin id demostrables no se inventan: quedan null.
  const sinNombre = construirRechazo('sol9', UID_A, { motorizadoAuthUid: UID_A, motorizadoNombre: '   ' }, 'ev9', 'T');
  assert.equal(sinNombre.evento.motorizadoNombre, null);
  assert.equal(sinNombre.evento.motorizadoId, null);
  assert.equal(sinNombre.evento.porUid, UID_A);
  // El teléfono de la asignación no se copia a la historia.
  assert.ok(!JSON.stringify(sinNombre).includes('telefono'));
  assert.ok(!JSON.stringify(t.sets[0].data).includes('8888-0000'));
});

// ─── MOTO-STATS-ACEPTACION-TRAZA-1 · autoridad server-side y traza canónica ──
//
// Cada RESPUESTA a una oferta queda registrada por el servidor en la misma
// transacción: evento append-only + proyección canónica `metricasAceptacion` +
// espejo legacy (misma fórmula que calculaba el cliente). Sin respuesta explícita
// no se cuenta nada.

const fuenteRaiz = (...ruta: string[]) => readFileSync(join(__dirname, '..', '..', '..', ...ruta), 'utf8').replace(/\r/g, '');

function pendienteDe(uid: string, motorizadoId: string, nombre = 'John Pork 2'): Doc {
  return asignadaA(uid, motorizadoId, nombre, { asignadoAt: { toMillis: () => AHORA_MS - 42_000 } });
}

const metricas = (m: Doc | null) => m!.metricasAceptacion as Doc;

test('MAT1 · aceptar: asignación aceptada, evento aceptacion_motorizado y proyección +1 decisión +1 aceptada, en la misma transacción', async () => {
  const t = crearTx(pendienteDe(UID_A, 'moto_a'), { authUid: UID_A });
  await responder(t.tx, crearRef(), UID_A, 'aceptar');

  assert.equal(t.estado()!.asignacion.estadoAceptacion, 'aceptada');
  assert.ok('aceptadoAt' in t.estado()!.asignacion);
  assert.equal(t.sets.length, 1);
  const ev = t.sets[0].data;
  assert.equal(ev.tipo, EVENTO_ACEPTACION_MOTORIZADO);
  assert.equal(ev.tipo, 'aceptacion_motorizado');
  assert.equal(ev.porUid, UID_A);
  assert.equal(ev.motorizadoId, 'moto_a');
  assert.equal(ev.motorizadoNombre, 'John Pork 2');
  assert.equal(ev.solicitudId, 'sol1');
  assert.equal(typeof ev.at, 'object', 'sello de servidor');
  assert.ok(!(ev.at instanceof Date));
  assert.equal(t.motoEscrituras.length, 1, 'una sola escritura al motorizado');
  const m = metricas(t.moto());
  assert.deepEqual([m.totalDecisiones, m.totalAceptadas, m.totalRechazadas], [1, 1, 0]);
  assert.equal(m.version, VERSION_METRICAS_ACEPTACION);
});

test('MAT2 · la primera decisión canónica es una aceptación → 1 / 1 / 0 y tasa 1', async () => {
  const t = crearTx(pendienteDe(UID_A, 'moto_a'), { authUid: UID_A });
  await responder(t.tx, crearRef(), UID_A, 'aceptar');
  const m = metricas(t.moto());
  assert.deepEqual([m.totalDecisiones, m.totalAceptadas, m.totalRechazadas, m.tasaAceptacion], [1, 1, 0, 1]);
  assert.ok(m.desde !== undefined && m.desde !== null, '`desde` marca el inicio de la telemetría canónica');
});

test('MAT3 · rechazar: solicitud a confirmada sin asignación, evento rechazo_motorizado y proyección +1 decisión +1 rechazada', async () => {
  const t = crearTx(pendienteDe(UID_A, 'moto_a'), { authUid: UID_A });
  await responder(t.tx, crearRef(), UID_A, 'rechazar');

  assert.equal(t.estado()!.estado, 'confirmada');
  assert.equal(t.estado()!.asignacion, null);
  assert.equal(t.sets.length, 1);
  assert.equal(t.sets[0].data.tipo, 'rechazo_motorizado');
  const m = metricas(t.moto());
  assert.deepEqual([m.totalDecisiones, m.totalAceptadas, m.totalRechazadas], [1, 0, 1]);
});

test('MAT4 · la primera decisión canónica es un rechazo → 1 / 0 / 1 y tasa 0 (un 0 real)', async () => {
  const t = crearTx(pendienteDe(UID_A, 'moto_a'), { authUid: UID_A });
  await responder(t.tx, crearRef(), UID_A, 'rechazar');
  const m = metricas(t.moto());
  assert.deepEqual([m.totalDecisiones, m.totalAceptadas, m.totalRechazadas, m.tasaAceptacion], [1, 0, 1, 0]);
});

test('MAT5 · reoferta: rechaza y luego acepta la MISMA solicitud → 2 decisiones, 1 / 1, tasa 0.5 y dos eventos', async () => {
  const ref = crearRef();
  const t = crearTx(pendienteDe(UID_A, 'moto_a'), { authUid: UID_A });
  await responder(t.tx, ref, UID_A, 'rechazar');
  // El gestor vuelve a ofrecer S al mismo motorizado (episodio nuevo).
  t.reemplazar(pendienteDe(UID_A, 'moto_a'));
  await responder(t.tx, ref, UID_A, 'aceptar');

  const m = metricas(t.moto());
  assert.deepEqual([m.totalDecisiones, m.totalAceptadas, m.totalRechazadas, m.tasaAceptacion], [2, 1, 1, 0.5]);
  assert.deepEqual(t.sets.map((s) => s.data.tipo), ['rechazo_motorizado', 'aceptacion_motorizado']);
  assert.notEqual((t.sets[0].ref as { id: string }).id, (t.sets[1].ref as { id: string }).id);
});

test('MAT6 · reasignación: M1 rechaza y M2 acepta → cada uno con SUS métricas, sin mezclarlas', async () => {
  const ref = crearRef();
  const m1 = crearTx(pendienteDe(UID_A, 'moto_a'), { authUid: UID_A });
  await responder(m1.tx, ref, UID_A, 'rechazar');
  const m2 = crearTx(pendienteDe(UID_B, 'moto_b', 'María López'), { authUid: UID_B });
  await responder(m2.tx, ref, UID_B, 'aceptar');

  const a = metricas(m1.moto());
  const b = metricas(m2.moto());
  assert.deepEqual([a.totalDecisiones, a.totalAceptadas, a.totalRechazadas], [1, 0, 1]);
  assert.deepEqual([b.totalDecisiones, b.totalAceptadas, b.totalRechazadas], [1, 1, 0]);
});

test('MAT7 · sin respuesta explícita no se cuenta nada: un guard que falla no deja evento ni métricas, y solo las decisiones escriben la proyección', async () => {
  for (const estado of ['cancelada', 'confirmada', 'pendiente_confirmacion']) {
    const t = crearTx({ ...pendienteDe(UID_A, 'moto_a'), estado }, { authUid: UID_A });
    await assert.rejects(responder(t.tx, crearRef(), UID_A, 'rechazar'), codigo('failed-precondition'));
    assert.equal(t.sets.length, 0, estado);
    assert.equal(t.motoEscrituras.length, 0, estado);
    assert.equal(t.moto()!.metricasAceptacion, undefined, estado);
  }
  // Ninguna otra función del servidor toca la proyección ni el espejo: ni expirar, ni cancelar, ni rebotar.
  for (const archivo of ['motorizado-transiciones.ts', 'cobro-semanal.ts', 'propuestas-abono.ts', 'comercio-acceso.ts', 'codigos.ts', 'acceso-motorizado.ts']) {
    const src = readFileSync(join(__dirname, '..', '..', 'src', archivo), 'utf8');
    assert.ok(!src.includes('metricasAceptacion'), archivo);
    assert.ok(!src.includes('totalRechazos'), archivo);
  }
  // Y las pantallas que cancelan, rebotan o reactivan no acreditan nada.
  for (const ruta of [
    ['app', 'panel', 'gestor', 'solicitudes', 'page.tsx'],
    ['app', 'panel', 'gestor', 'solicitudes', '[id]', 'page.tsx'],
    ['app', 'panel', 'gestor', '_components', 'SolicitudDrawer.tsx'],
  ]) {
    const src = fuenteRaiz(...ruta);
    assert.ok(!src.includes('metricasAceptacion') && !src.includes('registrarRechazo') && !src.includes('registrarAceptacion'), ruta.join('/'));
  }
});

test('MAT8 · aceptar exitoso + retry del mismo callable → 1 aceptación, 1 evento, 1 incremento', async () => {
  const t = crearTx(pendienteDe(UID_A, 'moto_a'), { authUid: UID_A });
  await responder(t.tx, crearRef(), UID_A, 'aceptar');
  for (const accion of ['aceptar', 'rechazar'] as const) {
    await assert.rejects(responder(t.tx, crearRef(), UID_A, accion), codigo('failed-precondition'));
  }
  assert.equal(t.sets.length, 1, 'un solo evento');
  assert.equal(t.motoEscrituras.length, 1, 'un solo incremento');
  const m = metricas(t.moto());
  assert.deepEqual([m.totalDecisiones, m.totalAceptadas, m.totalRechazadas], [1, 1, 0]);
});

test('MAT9 · rechazo exitoso + retry → 1 rechazo, 1 evento, 1 incremento', async () => {
  const t = crearTx(pendienteDe(UID_A, 'moto_a'), { authUid: UID_A });
  await responder(t.tx, crearRef(), UID_A, 'rechazar');
  for (const accion of ['aceptar', 'rechazar'] as const) {
    await assert.rejects(responder(t.tx, crearRef(), UID_A, accion), codigo('permission-denied'));
  }
  assert.equal(t.sets.length, 1);
  assert.equal(t.motoEscrituras.length, 1);
  const m = metricas(t.moto());
  assert.deepEqual([m.totalDecisiones, m.totalAceptadas, m.totalRechazadas], [1, 0, 1]);
});

test('MAT13 · un motorizado sin decisiones no tiene proyección: no se fabrica una tasa', async () => {
  const t = crearTx(pendienteDe(UID_A, 'moto_a'), { authUid: UID_A });
  assert.equal(t.moto()!.metricasAceptacion, undefined);
  // Una respuesta bloqueada tampoco la crea.
  await assert.rejects(responder(t.tx, crearRef(), UID_B, 'aceptar'), codigo('permission-denied'));
  assert.equal(t.moto()!.metricasAceptacion, undefined);
  // Con 0 decisiones no existe una proyección de la que salga una tasa.
  const previa = proyectarMetricasAceptacion(undefined, 'aceptar', 'T');
  assert.equal(previa.totalDecisiones, 1, 'la proyección solo nace con una decisión');
});

test('MAT14 · legacy existente: se preserva y se actualiza como antes; la proyección canónica NO parte de él', async () => {
  const legacy = { authUid: UID_A, totalAsignaciones: 10, totalAceptadas: 7, totalRechazos: 3, tasaAceptacion: 0.7, tiempoPromedioAceptacion: 30 };
  const acepta = crearTx(pendienteDe(UID_A, 'moto_a'), legacy);
  await responder(acepta.tx, crearRef(), UID_A, 'aceptar');
  const m = metricas(acepta.moto());
  assert.deepEqual([m.totalDecisiones, m.totalAceptadas, m.totalRechazadas, m.tasaAceptacion], [1, 1, 0, 1], 'canónica: desde cero');
  // Espejo legacy, la misma fórmula que el cliente: (7+1)/(10+1).
  assert.equal(acepta.moto()!.totalAsignaciones, 11);
  assert.equal(acepta.moto()!.totalAceptadas, 8);
  assert.equal(acepta.moto()!.totalRechazos, 3, 'los rechazos legacy no se tocan al aceptar');
  assert.equal(acepta.moto()!.tasaAceptacion, 8 / 11);
  // tiempo promedio: (30*(8-1) + 42) / 8, con asignadoAt 42 s antes.
  assert.equal(acepta.moto()!.tiempoPromedioAceptacion, (30 * 7 + 42) / 8);

  const rechaza = crearTx(pendienteDe(UID_A, 'moto_a'), legacy);
  await responder(rechaza.tx, crearRef(), UID_A, 'rechazar');
  assert.equal(rechaza.moto()!.totalAsignaciones, 11);
  assert.equal(rechaza.moto()!.totalAceptadas, 7);
  assert.equal(rechaza.moto()!.totalRechazos, 4);
  assert.equal(rechaza.moto()!.tasaAceptacion, 7 / 11);
  assert.equal(rechaza.moto()!.tiempoPromedioAceptacion, 30, 'rechazar no toca el tiempo promedio');
});

test('MAT-espejo · el espejo legacy reproduce exactamente la fórmula del cliente (lib/motorizado-stats.ts) sobre una secuencia', () => {
  // Réplica literal de registrarAceptacion / registrarRechazo del cliente.
  let cli = { totalAsignaciones: 0, totalAceptadas: 0, totalRechazos: 0, tasaAceptacion: 0 } as Doc;
  let srv: Doc = {};
  for (const accion of ['aceptar', 'aceptar', 'rechazar', 'aceptar', 'rechazar'] as const) {
    if (accion === 'aceptar') {
      const a = (cli.totalAceptadas ?? 0) + 1;
      const n = (cli.totalAsignaciones ?? 0) + 1;
      cli = { ...cli, totalAceptadas: a, totalAsignaciones: n, tasaAceptacion: a / n };
    } else {
      const r = (cli.totalRechazos ?? 0) + 1;
      const a = cli.totalAceptadas ?? 0;
      const n = (cli.totalAsignaciones ?? 0) + 1;
      cli = { ...cli, totalRechazos: r, totalAsignaciones: n, tasaAceptacion: a / n };
    }
    srv = { ...srv, ...espejoLegacy(srv, accion, null, AHORA_MS) };
  }
  for (const k of ['totalAsignaciones', 'totalAceptadas', 'totalRechazos', 'tasaAceptacion']) {
    assert.equal(srv[k], cli[k], k);
  }
});

test('MAT-seguridad · la proyección solo se acredita al documento del llamador; sin vínculo la decisión y su evento se registran igual', async () => {
  // Documento de otro motorizado (authUid distinto).
  const ajeno = crearTx(pendienteDe(UID_A, 'moto_a'), { authUid: UID_B });
  await responder(ajeno.tx, crearRef(), UID_A, 'aceptar');
  assert.equal(ajeno.motoEscrituras.length, 0, 'no se acredita a otro');
  assert.equal(ajeno.sets.length, 1, 'el evento se registra');
  assert.equal(ajeno.estado()!.asignacion.estadoAceptacion, 'aceptada');
  // Documento inexistente.
  const sinDoc = crearTx(pendienteDe(UID_A, 'moto_a'), null);
  await responder(sinDoc.tx, crearRef(), UID_A, 'rechazar');
  assert.equal(sinDoc.motoEscrituras.length, 0);
  assert.equal(sinDoc.sets.length, 1);
  assert.equal(sinDoc.estado()!.estado, 'confirmada');
});

test('proyección · parte solo de una proyección canónica v2; una versión distinta o corrupta empieza de cero; el `desde` original se conserva', () => {
  const primera = proyectarMetricasAceptacion(undefined, 'aceptar', 'T1');
  assert.equal(primera.desde, 'T1');
  const segunda = proyectarMetricasAceptacion(primera, 'rechazar', 'T2');
  assert.equal(segunda.desde, 'T1', 'el corte canónico no se mueve');
  assert.deepEqual([segunda.totalDecisiones, segunda.totalAceptadas, segunda.totalRechazadas, segunda.tasaAceptacion], [2, 1, 1, 0.5]);
  for (const previa of [{ version: 1, totalAceptadas: 50, totalRechazadas: 50 }, 'x', 42, { version: 2, totalAceptadas: -3, totalRechazadas: NaN }]) {
    const p = proyectarMetricasAceptacion(previa, 'aceptar', 'T3');
    assert.deepEqual([p.totalDecisiones, p.totalAceptadas, p.totalRechazadas], [1, 1, 0]);
  }
});

test('evento de aceptación · mismo formato que el de rechazo, con el actor del llamador autenticado y sello de servidor', () => {
  const asig = { motorizadoAuthUid: UID_A, motorizadoId: 'moto_a', motorizadoNombre: 'John Pork 2', motorizadoTelefono: '8888-0000', porUid: 'falsificado' };
  const a = construirAceptacion('sol9', UID_A, asig, 'SERVER_TS');
  const r = construirRechazo('sol9', UID_A, asig, 'ev9', 'SERVER_TS').evento;
  assert.deepEqual(Object.keys(a).sort(), Object.keys(r).sort());
  assert.equal(a.tipo, 'aceptacion_motorizado');
  assert.equal(a.porUid, UID_A, 'el actor es el llamador, no un dato de la asignación');
  assert.equal(a.at, 'SERVER_TS');
  assert.ok(!JSON.stringify(a).includes('8888-0000'), 'sin teléfono en la historia');
  assert.ok(!JSON.stringify(a).match(/precio|monto|cobro/i), 'sin datos financieros');
});

test('MAT-cliente · el panel del motorizado ya no acredita métricas: la única autoridad es responderAsignacion', () => {
  const pagina = fuenteRaiz('app', 'panel', 'motorizado', 'page.tsx');
  assert.ok(!/registrarAceptacion\(/.test(pagina), 'registrarAceptacion ya no se llama desde el panel vigente');
  assert.ok(!/registrarRechazo\(/.test(pagina), 'registrarRechazo ya no se llama desde el panel vigente');
  assert.ok(pagina.includes("accion: 'aceptar'") && pagina.includes("accion: 'rechazar'"), 'sigue respondiendo por la callable');
  // Las copias DAPC no son rutas: no se tocan.
  assert.ok(fuenteRaiz('app', 'panel', 'motorizado', 'page-DAPC.tsx').includes('registrarAceptacion('));
});

// MOTO-RANKING-ACEPTACION-SIN-HISTORIAL-1 migró deliberadamente el
// componente de aceptación del ranking (ya no `?? 1.0`, que favorecía a
// riders sin historial; ahora vía resolverAceptacionRanking(), que sí lee
// metricasAceptacion) — exactamente la frontera que este test fijaba como
// "todavía no". Los coeficientes de peso y el resto de la fórmula (carga,
// cercanía, compatibilidad, bolso) siguen intactos, y eso se reafirma acá;
// la cobertura de la fórmula de aceptación nueva vive en
// lib/motorizado-ranking.test.ts / lib/motorizado-ranking-aceptacion.test.ts.
test('MAT-ranking · el ranking migró la aceptación a metricasAceptacion; el resto de la fórmula no cambió', () => {
  const r = fuenteRaiz('lib', 'motorizado-ranking.ts');
  assert.ok(!r.includes('motorizado.tasaAceptacion ?? 1.0'));
  for (const c of ['PESO_CARGA      = 0.40', 'PESO_CERCANIA   = 0.30', 'PESO_COMPAT     = 0.20', 'PESO_ACEPTACION = 0.10']) assert.ok(r.includes(c), c);
  assert.ok(r.includes('Math.max(0, 1 - cargaActual * 0.25)'));
  assert.ok(r.includes('metricasAceptacion'), 'ahora SÍ debe migrar a la fuente canónica (vía resolverAceptacionRanking)');
});

// ─── MOTO-STATS-ACEPTACION-TRAZA-1 · compatibilidad de rollout ────────────────
//
// El cliente anterior acredita el legacy por su cuenta después de la callable
// (registrarAceptacion / registrarRechazo, sin payload `protocolo`). El cliente nuevo
// envía `protocolo: 2` y no acredita nada. El servidor escribe el espejo legacy
// SOLO con `protocolo: 2`; lo canónico se escribe siempre. Así el legacy avanza
// exactamente una vez por decisión con cualquier combinación de web y Functions.

const LEGACY_INICIAL = { totalAsignaciones: 10, totalAceptadas: 7, totalRechazos: 3, tasaAceptacion: 0.7 };

/** Réplica literal de lo que hacía el cliente anterior (lib/motorizado-stats.ts) sobre el documento del motorizado. */
function clienteAnteriorAcredita(m: Doc, accion: 'aceptar' | 'rechazar'): void {
  if (accion === 'aceptar') {
    const totalAceptadas = (m.totalAceptadas ?? 0) + 1;
    const totalAsignaciones = (m.totalAsignaciones ?? 0) + 1;
    m.totalAceptadas = totalAceptadas;
    m.totalAsignaciones = totalAsignaciones;
    m.tasaAceptacion = totalAceptadas / totalAsignaciones;
  } else {
    const totalAceptadas = m.totalAceptadas ?? 0;
    const totalAsignaciones = (m.totalAsignaciones ?? 0) + 1;
    m.totalRechazos = (m.totalRechazos ?? 0) + 1;
    m.totalAsignaciones = totalAsignaciones;
    m.tasaAceptacion = totalAceptadas / totalAsignaciones;
  }
}

const SIN_PROTOCOLO = {}; // el payload del cliente anterior: solo { solicitudId, accion }
const PROTOCOLO_2 = { espejoLegacy: true }; // el payload del cliente nuevo: { …, protocolo: 2 }

test('ROL1 · web anterior + Functions nuevas + aceptación → el legacy avanza exactamente UNA vez (lo acredita el cliente), lo canónico lo registra el servidor', async () => {
  const t = crearTx(pendienteDe(UID_A, 'moto_a'), { authUid: UID_A, ...LEGACY_INICIAL });
  await responder(t.tx, crearRef(), UID_A, 'aceptar', SIN_PROTOCOLO);

  // El servidor NO tocó el legacy: sigue igual hasta que el cliente anterior acredite.
  for (const k of Object.keys(LEGACY_INICIAL)) assert.equal(t.moto()![k], (LEGACY_INICIAL as Doc)[k], `servidor sin protocolo no escribe ${k}`);
  // Sí quedó lo canónico.
  assert.deepEqual([metricas(t.moto()).totalDecisiones, metricas(t.moto()).totalAceptadas], [1, 1]);
  assert.equal(t.sets.length, 1);

  clienteAnteriorAcredita(t.moto()!, 'aceptar'); // el cliente anterior, después de la callable
  assert.equal(t.moto()!.totalAsignaciones, 11, '+1, no +2');
  assert.equal(t.moto()!.totalAceptadas, 8, '+1, no +2');
  assert.equal(t.moto()!.totalRechazos, 3);
});

test('ROL2 · web anterior + Functions nuevas + rechazo → el legacy avanza exactamente UNA vez', async () => {
  const t = crearTx(pendienteDe(UID_A, 'moto_a'), { authUid: UID_A, ...LEGACY_INICIAL });
  await responder(t.tx, crearRef(), UID_A, 'rechazar', SIN_PROTOCOLO);
  for (const k of Object.keys(LEGACY_INICIAL)) assert.equal(t.moto()![k], (LEGACY_INICIAL as Doc)[k], k);
  assert.deepEqual([metricas(t.moto()).totalDecisiones, metricas(t.moto()).totalRechazadas], [1, 1]);
  assert.equal(t.sets.length, 1);

  clienteAnteriorAcredita(t.moto()!, 'rechazar');
  assert.equal(t.moto()!.totalAsignaciones, 11, '+1, no +2');
  assert.equal(t.moto()!.totalRechazos, 4, '+1, no +2');
  assert.equal(t.moto()!.totalAceptadas, 7);
});

test('ROL3 · web nueva + Functions nuevas + aceptación → exactamente UNA vez (la del servidor), sin segunda escritura del cliente', async () => {
  const t = crearTx(pendienteDe(UID_A, 'moto_a'), { authUid: UID_A, ...LEGACY_INICIAL });
  await responder(t.tx, crearRef(), UID_A, 'aceptar', PROTOCOLO_2);
  assert.equal(t.moto()!.totalAsignaciones, 11);
  assert.equal(t.moto()!.totalAceptadas, 8);
  assert.equal(t.motoEscrituras.length, 1, 'una sola escritura al motorizado');
  assert.deepEqual([metricas(t.moto()).totalDecisiones, metricas(t.moto()).totalAceptadas], [1, 1]);
});

test('ROL4 · web nueva + Functions nuevas + rechazo → exactamente UNA vez', async () => {
  const t = crearTx(pendienteDe(UID_A, 'moto_a'), { authUid: UID_A, ...LEGACY_INICIAL });
  await responder(t.tx, crearRef(), UID_A, 'rechazar', PROTOCOLO_2);
  assert.equal(t.moto()!.totalAsignaciones, 11);
  assert.equal(t.moto()!.totalRechazos, 4);
  assert.equal(t.motoEscrituras.length, 1);
  assert.deepEqual([metricas(t.moto()).totalDecisiones, metricas(t.moto()).totalRechazadas], [1, 1]);
});

test('ROL5 · retry de la callable después de una decisión exitosa no duplica nada, con o sin protocolo', async () => {
  for (const opciones of [SIN_PROTOCOLO, PROTOCOLO_2]) {
    for (const accion of ['aceptar', 'rechazar'] as const) {
      const t = crearTx(pendienteDe(UID_A, 'moto_a'), { authUid: UID_A, ...LEGACY_INICIAL });
      await responder(t.tx, crearRef(), UID_A, accion, opciones);
      const antes = JSON.stringify(t.moto());
      for (const otra of ['aceptar', 'rechazar'] as const) {
        await assert.rejects(responder(t.tx, crearRef(), UID_A, otra, opciones), (e) => ['failed-precondition', 'permission-denied'].includes((e as { code?: string }).code ?? ''));
      }
      assert.equal(JSON.stringify(t.moto()), antes, `${accion}/${JSON.stringify(opciones)}`);
      assert.equal(t.sets.length, 1);
      assert.equal(t.motoEscrituras.length, 1);
    }
  }
});

test('ROL6 · el protocolo: ausente = cliente anterior; 2 = el servidor escribe el espejo; cualquier otro valor se rechaza; el cliente nuevo no llama a los helpers', () => {
  assert.equal(leerProtocoloRespuesta({ solicitudId: 's', accion: 'aceptar' }), false);
  assert.equal(leerProtocoloRespuesta({ solicitudId: 's', accion: 'aceptar', protocolo: 2 }), true);
  for (const malo of [1, 3, '2', true, null, undefined, {}, 0]) {
    assert.throws(() => leerProtocoloRespuesta({ solicitudId: 's', accion: 'aceptar', protocolo: malo }), codigo('invalid-argument'), String(malo));
  }
  assert.equal(PROTOCOLO_METRICAS_SERVIDOR, 2);
  const pagina = fuenteRaiz('app', 'panel', 'motorizado', 'page.tsx');
  assert.ok(pagina.includes("accion: 'aceptar', protocolo: 2") && pagina.includes("accion: 'rechazar', protocolo: 2"));
  assert.ok(!pagina.includes('registrarAceptacion(') && !pagina.includes('registrarRechazo('), 'sin segunda escritura de cliente');
  // La callable sigue aceptando el payload del cliente anterior (exactamente solicitudId + accion).
  const callable = readFileSync(join(__dirname, '..', '..', 'src', 'motorizado-transiciones.ts'), 'utf8');
  assert.ok(callable.includes("c !== 'solicitudId' && c !== 'accion' && c !== 'protocolo'"));
  assert.ok(callable.includes('leerProtocoloRespuesta('));
});

test('ROL7 · la proyección canónica nunca depende del cliente: es la misma con o sin protocolo, y no lee el legacy', async () => {
  const resultados: unknown[] = [];
  for (const opciones of [SIN_PROTOCOLO, PROTOCOLO_2]) {
    // Legacy corrupto a propósito: lo canónico no debe enterarse.
    const t = crearTx(pendienteDe(UID_A, 'moto_a'), { authUid: UID_A, totalAsignaciones: 9999, totalAceptadas: -5, tasaAceptacion: 'basura' });
    await responder(t.tx, crearRef(), UID_A, 'aceptar', opciones);
    const m = metricas(t.moto());
    resultados.push([m.version, m.totalDecisiones, m.totalAceptadas, m.totalRechazadas, m.tasaAceptacion]);
    assert.equal(t.sets.length, 1, 'el evento se escribe siempre');
  }
  assert.deepEqual(resultados[0], resultados[1]);
  assert.deepEqual(resultados[0], [VERSION_METRICAS_ACEPTACION, 1, 1, 0, 1]);
  // El código que arma la proyección no toca los campos legacy ni el payload del cliente.
  const src = readFileSync(join(__dirname, '..', '..', 'src', 'asignacion-respuesta.ts'), 'utf8');
  const iProy = src.indexOf('export function proyectarMetricasAceptacion');
  const iFin = src.indexOf('export function espejoLegacy');
  assert.ok(iProy > 0 && iFin > iProy);
  assert.ok(!/totalAsignaciones|totalRechazos|tasaAceptacion:\s*contador|opciones/.test(src.slice(iProy, iFin)));
});

test('ROL8 · las Rules siguen impidiendo fabricar métricas: el motorizado ya no lista los contadores y nadie escribe la proyección', () => {
  const rules = fuenteRaiz('firestore.rules');
  const iMoto = rules.indexOf('match /motorizado/{docId}');
  const iFin = rules.indexOf('match /cotizaciones/{docId}');
  assert.ok(iMoto > 0 && iFin > iMoto);
  const bloque = rules.slice(iMoto, iFin);
  for (const campo of ['totalAsignaciones', 'totalAceptadas', 'totalRechazos', 'tasaAceptacion', 'tiempoPromedioAceptacion']) {
    assert.ok(!bloque.includes(`'${campo}'`), `el motorizado no puede escribir ${campo}`);
  }
  assert.ok(bloque.includes("return ['metricasAceptacion']"));
  assert.ok(bloque.includes('!request.resource.data.keys().hasAny(camposDeMetricasServidor())'));
  assert.ok(bloque.includes('!request.resource.data.diff(resource.data).affectedKeys().hasAny(camposDeMetricasServidor())'));
});

// Ver nota en MAT-ranking arriba: el ranking migró deliberadamente en
// MOTO-RANKING-ACEPTACION-SIN-HISTORIAL-1. `protocolo` sigue sin tener
// ninguna relación con el ranking (eso no cambió: es exclusivo del payload
// de responderAsignacion).
test('ROL9 · el ranking migró los coeficientes de aceptación a metricasAceptacion; protocolo sigue sin relación con el ranking', () => {
  const r = fuenteRaiz('lib', 'motorizado-ranking.ts');
  assert.ok(!r.includes('motorizado.tasaAceptacion ?? 1.0'));
  for (const c of ['PESO_CARGA      = 0.40', 'PESO_CERCANIA   = 0.30', 'PESO_COMPAT     = 0.20', 'PESO_ACEPTACION = 0.10']) assert.ok(r.includes(c), c);
  assert.ok(r.includes('metricasAceptacion') && !r.includes('protocolo'));
});

test('ROL10 · el cliente anterior no entra en falso error: sus helpers nunca lanzan y se llaman sin await; y las Functions nuevas aceptan su payload', () => {
  const stats = fuenteRaiz('lib', 'motorizado-stats.ts');
  for (const fn of ['registrarAceptacion', 'registrarRechazo']) {
    const i = stats.indexOf(`export async function ${fn}`);
    assert.ok(i > 0, fn);
    const cuerpo = stats.slice(i, stats.indexOf('\n}\n', i));
    assert.ok(/try \{/.test(cuerpo) && /catch \(e\) \{\s*console\.error/.test(cuerpo), `${fn} captura todo y solo loguea`);
  }
  // Las pestañas del cliente anterior (copias DAPC = misma forma) los llaman sin await ni .then.
  for (const copia of ['page-DAPC.tsx', 'page-DAPC-2.tsx']) {
    const src = fuenteRaiz('app', 'panel', 'motorizado', copia);
    assert.ok(/^\s+registrarAceptacion\(motorizadoDocId/m.test(src) && /^\s+registrarRechazo\(motorizadoDocId/m.test(src), copia);
    assert.ok(!/await registrar(Aceptacion|Rechazo)\(/.test(src), `${copia}: sin await`);
  }
  // Lo único que ese cliente ve de la callable es su payload de siempre, que el servidor sigue aceptando.
  assert.equal(leerProtocoloRespuesta({ solicitudId: 's', accion: 'rechazar' }), false);
});

test('diagnóstico · si la proyección no se puede acreditar (sin documento, otro authUid o sin id), el resultado lo dice y la decisión y el evento se registran igual', async () => {
  const casos: [string, Doc | null, string][] = [
    ['sin documento', null, 'sin_documento'],
    ['otro authUid', { authUid: UID_B }, 'authuid_distinto'],
  ];
  for (const [nombre, moto, motivo] of casos) {
    const t = crearTx(pendienteDe(UID_A, 'moto_a'), moto);
    const r = await responderAsignacionEnTransaccion(t.tx, crearRef(), UID_A, 'aceptar', REFMOTO, PROTOCOLO_2, AHORA_MS);
    assert.deepEqual(r, { metricasAcreditadas: false, motivoOmision: motivo }, nombre);
    assert.equal(t.sets.length, 1, nombre);
    assert.equal(t.motoEscrituras.length, 0, nombre);
  }
  const sinId = crearTx({ ...pendienteDe(UID_A, 'moto_a'), asignacion: { ...pendienteDe(UID_A, 'moto_a').asignacion, motorizadoId: '' } });
  const r = await responderAsignacionEnTransaccion(sinId.tx, crearRef(), UID_A, 'aceptar', REFMOTO, PROTOCOLO_2, AHORA_MS);
  assert.deepEqual(r, { metricasAcreditadas: false, motivoOmision: 'sin_motorizado_id' });
  const ok = crearTx(pendienteDe(UID_A, 'moto_a'), { authUid: UID_A });
  assert.deepEqual(await responderAsignacionEnTransaccion(ok.tx, crearRef(), UID_A, 'aceptar', REFMOTO, PROTOCOLO_2, AHORA_MS), { metricasAcreditadas: true });
  const callable = readFileSync(join(__dirname, '..', '..', 'src', 'motorizado-transiciones.ts'), 'utf8');
  assert.ok(callable.includes("aviso: 'metricas_omitidas'"), 'la callable deja el aviso en el log');
});
