import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import type { DocumentData } from 'firebase-admin/firestore';
import { asignarMotorizadoCore, esElegibleParaNuevaAsignacion, type DepsAsignacion, type PeticionAsignacion } from '../src/asignacion-motorizado';

const stamp = (ms: number) => ({ toMillis: () => ms });
const ahora = 1_800_000_000_000;
const moto = { activo: true, estado: 'disponible', nombre: 'Dickson', telefono: '123', authUid: ' uid-moto ', fotoUrl: 'foto' };
const peticion: PeticionAsignacion = { solicitudId: 's1', motorizadoId: 'm1', operacion: 'sugerido', superficie: 'solicitudes', estadoEsperado: 'confirmada', updatedAtEsperado: 1, precioEditado: false };
// PRECIO-CONFIRMADO-ANTES-DE-OPERAR-1 — una orden con el precio cerrado trae su snapshot (base 70 = tarifa de 1 km) y una cotización que la demuestra.
const COT = { cotizacion: { distanciaKm: 1 } };
const CONF130 = { precioFinalCordobas: 130, comisionBaseCordobas: 70, comisionBaseOrigen: 'tarifa_distancia' };
const codigo = (code: string) => (e: unknown) => (e as { code?: string }).code === code;

// Simula el control optimista de Firestore: conflictos invalidan el intento y
// vuelven a ejecutar TODAS las lecturas. Nunca se publica un patch fallido.
function escenario() {
  let usuario: DocumentData | null = { rol: 'gestor', activo: true };
  let solicitud: DocumentData | null = { estado: 'confirmada', updatedAt: stamp(1), ...COT, confirmacion: { ...CONF130, confirmadoPorUid: 'original', confirmadoAt: stamp(0) } };
  let rider: DocumentData | null = { ...moto };
  let revision = 0;
  let antesCommit: (() => void) | undefined;
  const writes: DocumentData[] = [];
  const lecturas: string[] = [];
  const deps: DepsAsignacion = {
    ahoraMs: () => ahora,
    serverTimestamp: () => stamp(ahora),
    async transaction(fn) {
      for (;;) {
        const inicio = revision;
        let patch: DocumentData | undefined;
        const result = await fn({
          async getUsuario(uid) { lecturas.push('actor:' + uid); return usuario; },
          async getSolicitud(id) { lecturas.push('solicitud:' + id); return solicitud; },
          async getMotorizado(id) { lecturas.push('motorizado:' + id); return rider; },
          updateSolicitud(id, p) { assert.equal(id, 's1'); patch = p; },
        });
        const hook = antesCommit; antesCommit = undefined; hook?.();
        if (revision !== inicio) continue;
        assert.ok(patch);
        solicitud = { ...solicitud, ...patch };
        revision++;
        writes.push(patch);
        return result;
      }
    },
  };
  return {
    deps, writes, lecturas,
    actor: (v: typeof usuario) => { usuario = v; },
    orden: (v: typeof solicitud) => { solicitud = v; revision++; },
    rider: (v: typeof rider) => { rider = v; revision++; },
    antesCommit: (fn: () => void) => { antesCommit = fn; },
    actual: () => solicitud!,
    run: (p: Partial<PeticionAsignacion> = {}, uid: string | undefined = 'gestor') => asignarMotorizadoCore(deps, uid, { ...peticion, ...p }),
  };
}

const elegibilidad: Array<[string, Record<string, unknown> | null, boolean]> = [
  ['EL1 disponible', moto, true], ['EL2 ocupado legacy', { ...moto, estado: 'ocupado' }, true],
  ['EL3 inactivo', { ...moto, estado: 'inactivo' }, false], ['EL4 ausente', { activo: true }, false],
  ['EL5 desconocido', { ...moto, estado: 'inventado' }, false], ['EL6 desactivado', { ...moto, activo: false }, false],
  ['EL7 documento ausente', null, false], ['EL8 cero órdenes', { ...moto, carga: 0 }, true],
  ['EL9 múltiples órdenes', { ...moto, carga: 5, ordenesActivas: ['a', 'b', 'c'] }, true],
  ['EL10 activo ausente', { estado: 'disponible' }, false],
];
for (const [name, m, expected] of elegibilidad) test(name, () => assert.equal(esElegibleParaNuevaAsignacion(m), expected));

test('A1 admin y gestor activos autorizados', async () => {
  for (const rol of ['admin', 'gestor']) { const e = escenario(); e.actor({ rol, activo: true }); await e.run(); assert.equal(e.writes.length, 1); }
});
test('A2 sin auth', async () => { const e = escenario(); await assert.rejects(asignarMotorizadoCore(e.deps, undefined, peticion), codigo('unauthenticated')); assert.equal(e.writes.length, 0); });
test('A3 roles no autorizados, incluido digitador', async () => {
  for (const rol of ['digitador', 'motorizado', 'Comercio', 'cliente', 'otro']) { const e = escenario(); e.actor({ rol, activo: true }); await assert.rejects(e.run(), codigo('permission-denied')); assert.equal(e.writes.length, 0); }
});
test('A4 actor inactivo, ausente o activo ausente', async () => {
  for (const actor of [null, { rol: 'admin', activo: false }, { rol: 'gestor' }]) { const e = escenario(); e.actor(actor); await assert.rejects(e.run(), codigo('permission-denied')); }
});
test('A5 claves extras y datos cliente del rider rechazados', async () => {
  for (const extra of [{ extra: true }, { motorizado: moto }, { activo: true }, { carga: 0 }]) {
    const e = escenario(); await assert.rejects(asignarMotorizadoCore(e.deps, 'gestor', { ...peticion, ...extra }), codigo('invalid-argument')); assert.equal(e.writes.length, 0);
  }
});
test('Base de datos conserva autoridad solo admin', async () => {
  const e = escenario(); await assert.rejects(e.run({ superficie: 'baseDatos' }), codigo('permission-denied'));
  e.actor({ rol: 'admin', activo: true }); await e.run({ superficie: 'baseDatos' });
});
test('R1 disponible: lee actor, solicitud y rider dentro de transaction', async () => {
  const e = escenario(); await e.run(); assert.deepEqual(e.lecturas, ['actor:gestor', 'solicitud:s1', 'motorizado:m1']);
});
for (const [name, m] of [
  ['R2 offline al guardar', { ...moto, estado: 'inactivo' }], ['R3 eliminado', null],
  ['R4 activo=false', { ...moto, activo: false }], ['estado desconocido en transaction', { ...moto, estado: '?' }],
  ['estado ausente en transaction', { activo: true }],
] as const) test(name, async () => {
  const e = escenario(); e.rider(m); await assert.rejects(e.run(), (error: unknown) => {
    const err = error as { code: string; details: { motivo: string } };
    return err.code === 'failed-precondition' && err.details.motivo === 'motorizado_no_elegible';
  }); assert.equal(e.writes.length, 0);
});
test('R5 legacy ocupado permitido sin modificar presencia', async () => { const e = escenario(); e.rider({ ...moto, estado: 'ocupado' }); await e.run(); assert.equal(e.writes.length, 1); assert.equal(e.writes[0].asignacion.estadoAceptacion, 'pendiente'); });
test('R6 múltiples órdenes permitidas sin queries de carga', async () => { const e = escenario(); e.rider({ ...moto, carga: 9, ordenesActivas: ['a', 'b'] }); await e.run(); assert.equal(e.writes.length, 1); assert.equal(e.lecturas.length, 3); });
test('R7 solicitud cerrada o eliminada', async () => {
  for (const estado of ['entregado', 'cancelada', 'rechazada', 'desconocida']) { const e = escenario(); e.orden({ estado, updatedAt: stamp(1) }); await assert.rejects(e.run(), codigo('failed-precondition')); assert.equal(e.writes.length, 0); }
  const e = escenario(); e.orden(null); await assert.rejects(e.run(), codigo('not-found'));
});
test('R8 sugerido no reemplaza una asignación concurrente', async () => {
  const e = escenario(); e.orden({ estado: 'asignada', updatedAt: stamp(2), asignacion: { motorizadoId: 'otro' } }); await assert.rejects(e.run(), codigo('failed-precondition')); assert.equal(e.writes.length, 0);
});
test('R8b modal abierto confirmada no sobrescribe asignación de otra sesión', async () => {
  const e = escenario(); const otro = { motorizadoId: 'otro' };
  e.orden({ estado: 'asignada', updatedAt: stamp(2), asignacion: otro });
  await assert.rejects(e.run({ operacion: 'confirmar' }), codigo('failed-precondition'));
  assert.equal(e.writes.length, 0); assert.deepEqual(e.actual().asignacion, otro);
});
test('R9 reasignación valida el destino y conserva anterior si falla', async () => {
  const e = escenario(); const anterior = { motorizadoId: 'anterior' }; e.orden({ estado: 'asignada', updatedAt: stamp(1), asignacion: anterior }); e.rider({ ...moto, estado: 'inactivo' });
  await assert.rejects(e.run({ operacion: 'reasignar', estadoEsperado: 'asignada' }), codigo('failed-precondition')); assert.deepEqual(e.actual().asignacion, anterior); assert.equal(e.writes.length, 0);
});
test('Race realista: disponible leído, offline antes del commit, retry rechaza', async () => {
  const e = escenario(); e.antesCommit(() => e.rider({ ...moto, estado: 'inactivo' }));
  await assert.rejects(e.run(), codigo('failed-precondition')); assert.equal(e.writes.length, 0); assert.equal(e.lecturas.filter((x) => x === 'motorizado:m1').length, 2);
});
test('Race inversa: verdad actual online permite asignar', async () => { const e = escenario(); e.rider({ ...moto, estado: 'inactivo' }); e.rider(moto); await e.run(); assert.equal(e.writes.length, 1); });
test('Doble click/concurrencia: solo una escritura, segundo intento falla por versión', async () => {
  const e = escenario(); const results = await Promise.allSettled([e.run(), e.run()]); assert.equal(results.filter((r) => r.status === 'fulfilled').length, 1); assert.equal(e.writes.length, 1);
});
test('Versión también protege confirmar sobre estado que no cambia', async () => {
  const e = escenario(); await e.run({ operacion: 'confirmar', motorizadoId: null }); await assert.rejects(e.run({ operacion: 'confirmar', motorizadoId: null }), codigo('failed-precondition'));
});
test('Payload exacto de tabla sin foto, identidad desde servidor y ventana 10 min', async () => {
  const e = escenario(); await e.run(); assert.deepEqual(e.writes[0], {
    estado: 'asignada', updatedAt: e.writes[0].updatedAt,
    asignacion: { motorizadoId: 'm1', motorizadoAuthUid: 'uid-moto', motorizadoNombre: 'Dickson', motorizadoTelefono: '123', asignadoPorUid: 'gestor', asignadoAt: e.writes[0].updatedAt, estadoAceptacion: 'pendiente', aceptadoAt: null, rechazadoAt: null, motivoRechazo: '', aceptarAntesDe: new Date(ahora + 600000) },
  }); assert.equal(e.writes[0].updatedAt.toMillis(), ahora);
});
test('Payloads drawer/detalle/base preservan foto y normalización histórica de UID', async () => {
  for (const superficie of ['drawer', 'detalle', 'baseDatos'] as const) { const e = escenario(); e.actor({ rol: 'admin', activo: true }); await e.run({ operacion: 'confirmar', superficie }); const a = e.writes[0].asignacion; assert.equal(a.motorizadoFotoUrl, 'foto'); assert.equal(a.motorizadoAuthUid, superficie === 'detalle' ? 'uid-moto' : ' uid-moto '); }
});
test('Fallback teléfono/foto vacíos', async () => { const e = escenario(); e.rider({ activo: true, estado: 'disponible', nombre: 'M' }); await e.run({ operacion: 'confirmar', superficie: 'drawer' }); assert.equal(e.writes[0].asignacion.motorizadoTelefono, ''); assert.equal(e.writes[0].asignacion.motorizadoFotoUrl, null); });
test('Confirmar precio y asignar es un patch; fallo rider no confirma precio', async () => {
  const e = escenario(); e.orden({ estado: 'pendiente_confirmacion', updatedAt: stamp(1), ...COT }); e.rider({ ...moto, estado: 'inactivo' });
  const p = { operacion: 'confirmar', estadoEsperado: 'pendiente_confirmacion', precioFinal: 90 } as const;
  await assert.rejects(e.run(p), codigo('failed-precondition')); assert.equal(e.writes.length, 0);
  e.rider(moto); await e.run(p); assert.equal(e.writes.length, 1); assert.equal(e.writes[0].confirmacion.precioFinalCordobas, 90); assert.equal(e.writes[0].estado, 'asignada');
});
test('No asignar todavía confirma precio sin leer rider', async () => {
  const e = escenario(); e.orden({ estado: 'pendiente_confirmacion', updatedAt: stamp(1), ...COT }); await e.run({ operacion: 'confirmar', motorizadoId: null, estadoEsperado: 'pendiente_confirmacion', precioFinal: 90 }); assert.equal(e.actual().estado, 'confirmada'); assert.equal(e.actual().asignacion, null); assert.equal(e.lecturas.some((x) => x.startsWith('motorizado:')), false);
});
test('P3 sin editar conserva C$130 y metadata de confirmación idéntica', async () => { const e = escenario(); const original = e.actual().confirmacion; await e.run({ operacion: 'confirmar' }); assert.equal(e.actual().confirmacion, original); assert.equal(e.writes[0].confirmacion, undefined); });
test('P4 edición explícita confirma C$140', async () => { const e = escenario(); await e.run({ operacion: 'confirmar', precioEditado: true, precioFinal: 140 }); assert.equal(e.actual().confirmacion.precioFinalCordobas, 140); assert.equal(e.actual().confirmacion.confirmadoPorUid, 'gestor'); });
test('P5 reasignar conserva confirmación entera', async () => { const e = escenario(); const confirmacion = e.actual().confirmacion; e.orden({ estado: 'asignada', updatedAt: stamp(1), confirmacion }); await e.run({ operacion: 'reasignar', estadoEsperado: 'asignada' }); assert.equal(e.actual().confirmacion, confirmacion); assert.equal(e.writes[0].confirmacion, undefined); });
test('Precio no editado no puede sustituirse silenciosamente', async () => { const e = escenario(); await assert.rejects(e.run({ operacion: 'confirmar', precioFinal: 90 }), codigo('invalid-argument')); assert.equal(e.writes.length, 0); });
test('Payloads inválidos no escriben', async () => {
  for (const patch of [{ precioFinal: -1 }, { precioEditado: true }, { solicitudId: '../x' }, { motorizadoId: null }, { updatedAtEsperado: undefined }, { superficie: 'otra' }, { operacion: 'otra' }, { precioFinal: Infinity }]) {
    const e = escenario(); await assert.rejects(asignarMotorizadoCore(e.deps, 'gestor', { ...peticion, ...patch }), codigo('invalid-argument')); assert.equal(e.writes.length, 0);
  }
});
test('Reoferta no excluye al último rechazante', async () => { const e = escenario(); e.orden({ ...e.actual(), ultimoRechazoMotorizado: { motorizadoId: 'm1' } }); await e.run(); assert.equal(e.actual().asignacion.motorizadoId, 'm1'); });

// ── MOTO-REASIGNACION-POST-RETIRO-GUARD-1 ───────────────────────────────────
//
// P1 confirmado en diagnóstico previo: 'confirmar' solo exigía
// estadosAbiertos, así que una solicitud 'retirado'/'en_camino_entrega' podía
// volver a 'asignada' con un motorizado NUEVO desde el mismo botón que arma
// el precio (Drawer/detalle/Base de datos, que solo usaban 'confirmar'). Acá
// se fija la matriz completa: 'confirmar' es asignación INICIAL
// (pendiente_confirmacion/confirmada); 'reasignar' es la única vía para
// cambiar el motorizado de una solicitud que ya lo tiene, y solo ANTES del
// retiro físico (asignada/en_camino_retiro) — nunca después.

const motivo = (m: string) => (e: unknown) => (e as { details?: { motivo?: string } }).details?.motivo === m;

// RG1-RG5: reasignar por estado.
for (const [name, estado, permitido] of [
  ['RG1 asignada', 'asignada', true],
  ['RG2 en_camino_retiro', 'en_camino_retiro', true],
  ['RG3 retirado', 'retirado', false],
  ['RG4 en_camino_entrega', 'en_camino_entrega', false],
] as const) {
  test(name, async () => {
    const e = escenario();
    const anterior = { motorizadoId: 'anterior', motorizadoAuthUid: 'uid-anterior' };
    e.orden({ estado, updatedAt: stamp(1), asignacion: anterior, confirmacion: CONF130 });
    if (permitido) {
      await e.run({ operacion: 'reasignar', estadoEsperado: estado });
      assert.equal(e.writes.length, 1);
      assert.equal(e.actual().asignacion.motorizadoId, 'm1');
      assert.equal(e.actual().estado, 'asignada');
    } else {
      await assert.rejects(e.run({ operacion: 'reasignar', estadoEsperado: estado }), (err: unknown) => {
        const e2 = err as { code: string };
        return e2.code === 'failed-precondition' && motivo('solicitud_no_reasignable')(err);
      });
      assert.equal(e.writes.length, 0);
      assert.deepEqual(e.actual().asignacion, anterior);
      assert.equal(e.actual().estado, estado);
    }
  });
}

// RG5: 'entregado' no está en estadosAbiertos en absoluto — el payload ni
// siquiera entra a la transacción, se rechaza más temprano (invalid-argument
// en la validación de forma), que es una protección MÁS estricta, no menor.
test('RG5 entregado — ni siquiera es un estadoEsperado válido, rechazo más temprano (invalid-argument)', async () => {
  const e = escenario();
  const anterior = { motorizadoId: 'anterior' };
  e.orden({ estado: 'entregado', updatedAt: stamp(1), asignacion: anterior });
  await assert.rejects(e.run({ operacion: 'reasignar', estadoEsperado: 'entregado' }), codigo('invalid-argument'));
  assert.equal(e.writes.length, 0);
  assert.deepEqual(e.actual().asignacion, anterior);
});

test('RG6 modal stale: asignada → retirado sin refrescar → backend rechaza por staleness', async () => {
  const e = escenario();
  const anterior = { motorizadoId: 'anterior' };
  e.orden({ estado: 'retirado', updatedAt: stamp(2), asignacion: anterior });
  // El cliente todavía cree que está en 'asignada' (modal abierto sin refrescar).
  await assert.rejects(e.run({ operacion: 'reasignar', estadoEsperado: 'asignada' }), (err: unknown) => {
    const e2 = err as { code: string };
    return e2.code === 'failed-precondition' && motivo('solicitud_cambio')(err);
  });
  assert.equal(e.writes.length, 0);
  assert.deepEqual(e.actual().asignacion, anterior);
});

test('RG7-RG11 intento prohibido conserva motorizado/estado/asignadoAt/aceptarAntesDe/estadoAceptacion originales', async () => {
  const e = escenario();
  const anterior = {
    motorizadoId: 'anterior', motorizadoAuthUid: 'uid-anterior',
    asignadoAt: stamp(500), estadoAceptacion: 'aceptado', aceptarAntesDe: stamp(999),
  };
  e.orden({ estado: 'retirado', updatedAt: stamp(1), asignacion: anterior });
  await assert.rejects(e.run({ operacion: 'reasignar', estadoEsperado: 'retirado' }), codigo('failed-precondition'));
  assert.equal(e.writes.length, 0);
  assert.deepEqual(e.actual().asignacion, anterior); // RG7, RG9, RG10, RG11
  assert.equal(e.actual().estado, 'retirado'); // RG8
});

test('RG12 intento prohibido no toca el precio confirmado', async () => {
  const e = escenario();
  const precioOriginal = e.actual().confirmacion;
  e.orden({ estado: 'retirado', updatedAt: stamp(1), asignacion: { motorizadoId: 'anterior' }, confirmacion: precioOriginal });
  await assert.rejects(e.run({ operacion: 'reasignar', estadoEsperado: 'retirado' }), codigo('failed-precondition'));
  assert.deepEqual(e.actual().confirmacion, precioOriginal);
  assert.equal(e.writes.length, 0);
});

test('RG13 confirmar NO sirve de bypass para reasignar una solicitud retirado', async () => {
  const e = escenario();
  const anterior = { motorizadoId: 'anterior' };
  e.orden({ estado: 'retirado', updatedAt: stamp(1), asignacion: anterior });
  await assert.rejects(e.run({ operacion: 'confirmar', estadoEsperado: 'retirado', motorizadoId: 'm1' }), (err: unknown) => {
    const e2 = err as { code: string };
    return e2.code === 'failed-precondition' && motivo('solicitud_no_reasignable')(err);
  });
  assert.equal(e.writes.length, 0);
  assert.deepEqual(e.actual().asignacion, anterior);
});

test('RG14 confirmar NO sirve de bypass para reasignar una solicitud en_camino_entrega', async () => {
  const e = escenario();
  const anterior = { motorizadoId: 'anterior' };
  e.orden({ estado: 'en_camino_entrega', updatedAt: stamp(1), asignacion: anterior });
  await assert.rejects(e.run({ operacion: 'confirmar', estadoEsperado: 'en_camino_entrega', motorizadoId: 'm1' }), (err: unknown) => {
    const e2 = err as { code: string };
    return e2.code === 'failed-precondition' && motivo('solicitud_no_reasignable')(err);
  });
  assert.equal(e.writes.length, 0);
  assert.deepEqual(e.actual().asignacion, anterior);
});

test('RG15 confirmar también queda bloqueado sobre una solicitud ya asignada (asignación inicial != reasignación)', async () => {
  const e = escenario();
  const anterior = { motorizadoId: 'anterior' };
  e.orden({ estado: 'asignada', updatedAt: stamp(1), asignacion: anterior });
  await assert.rejects(e.run({ operacion: 'confirmar', estadoEsperado: 'asignada', motorizadoId: 'm1' }), (err: unknown) => {
    const e2 = err as { code: string };
    return e2.code === 'failed-precondition' && motivo('solicitud_no_reasignable')(err);
  });
  assert.equal(e.writes.length, 0);
  assert.deepEqual(e.actual().asignacion, anterior);
});

test('RG15b reasignar en en_camino_retiro vuelve a estado asignada (semántica ya existente de nueva asignación)', async () => {
  const e = escenario();
  e.orden({ estado: 'en_camino_retiro', updatedAt: stamp(1), asignacion: { motorizadoId: 'anterior' }, confirmacion: CONF130 });
  await e.run({ operacion: 'reasignar', estadoEsperado: 'en_camino_retiro' });
  assert.equal(e.actual().estado, 'asignada');
  assert.equal(e.actual().asignacion.motorizadoId, 'm1');
});

test('confirmar sigue funcionando para asignación inicial desde pendiente_confirmacion y confirmada (sin regresión)', async () => {
  for (const estado of ['pendiente_confirmacion', 'confirmada'] as const) {
    const e = escenario();
    e.orden({ estado, updatedAt: stamp(1), ...COT });
    await e.run({ operacion: 'confirmar', estadoEsperado: estado, precioFinal: 130 });
    assert.equal(e.writes.length, 1);
    assert.equal(e.actual().estado, 'asignada');
  }
});

// ═══ PRECIO-CONFIRMADO-ANTES-DE-OPERAR-1 · una orden solo queda asignada con el precio cerrado, y el servidor deja la base de la comisión ═══

const motivoDe = (m: string) => (err: unknown) => (err as { details?: { motivo?: string } }).details?.motivo === m;
const pendiente = (extra: Record<string, unknown> = {}) => ({ estado: 'pendiente_confirmacion', updatedAt: stamp(1), ...extra });
const confirmarP = { operacion: 'confirmar', estadoEsperado: 'pendiente_confirmacion' } as const;

test('FIN1F-F1 confirmar un precio válido deja el snapshot del servidor: precio final + base de comisión derivada de la tarifa (13.859 km → 150)', async () => {
  const e = escenario(); e.orden(pendiente({ cotizacion: { distanciaKm: 13.859 }, precioDesglose: { deliveryBase: 150, totalCobrado: 150 } }));
  await e.run({ ...confirmarP, precioFinal: 150 });
  const c = e.actual().confirmacion;
  assert.equal(c.precioFinalCordobas, 150); assert.equal(c.comisionBaseCordobas, 150); assert.equal(c.comisionBaseOrigen, 'tarifa_distancia');
  assert.equal(c.confirmadoPorUid, 'gestor'); assert.equal(e.actual().estado, 'asignada');
});

test('FIN1F-F10 SH-0012: precio final 260 con recargo 50 → la base del snapshot es 210 (NO 260)', async () => {
  const e = escenario(); e.orden(pendiente({ cotizacion: { distanciaKm: 21.759 }, precioDesglose: { deliveryBase: 210, recargoZona: 50, totalCobrado: 260 } }));
  await e.run({ ...confirmarP, precioFinal: 260 });
  assert.equal(e.actual().confirmacion.precioFinalCordobas, 260); assert.equal(e.actual().confirmacion.comisionBaseCordobas, 210);
});

test('FIN1F-F2/F3/F4 precio 0, negativo, texto, NaN, Infinity → rechazado, 0 escrituras', async () => {
  for (const precio of [0, -5, -0.01, '150', 'abc', NaN, Infinity, -Infinity, null, {}, [150]]) {
    const e = escenario(); e.orden(pendiente());
    await assert.rejects(e.run({ ...confirmarP, precioFinal: precio as never }), codigo('invalid-argument'), String(precio));
    assert.equal(e.writes.length, 0, String(precio));
  }
  const e = escenario(); e.orden(pendiente()); // confirmar sin precio alguno
  await assert.rejects(e.run({ ...confirmarP }), codigo('invalid-argument')); assert.equal(e.writes.length, 0);
});

test('FIN1F-F5 sugerido sobre una orden SIN precio confirmado → precio_sin_confirmar, 0 escrituras (la orden no queda asignada)', async () => {
  for (const confirmacion of [undefined, {}, { precioFinalCordobas: 0 }, { precioFinalCordobas: -3 }, { precioFinalCordobas: 'x' }, { precioFinalCordobas: NaN }]) {
    const e = escenario(); e.orden({ estado: 'confirmada', updatedAt: stamp(1), ...(confirmacion === undefined ? {} : { confirmacion }) });
    await assert.rejects(e.run({ operacion: 'sugerido', estadoEsperado: 'confirmada' }), (err: unknown) => codigo('failed-precondition')(err) && motivoDe('precio_sin_confirmar')(err));
    assert.equal(e.writes.length, 0); assert.equal(e.actual().estado, 'confirmada');
  }
});

test('FIN1F-F5b sugerido CON precio confirmado sigue funcionando (sin regresión) y no toca la confirmación', async () => {
  const e = escenario(); const antes = e.actual().confirmacion;
  await e.run({ operacion: 'sugerido', estadoEsperado: 'confirmada' });
  assert.equal(e.actual().estado, 'asignada'); assert.deepEqual(e.actual().confirmacion, antes);
});

test('FIN1F-F6 reasignar con precio confirmado → PASS y conserva el snapshot; F7 sin precio confirmado → precio_sin_confirmar', async () => {
  const e = escenario(); const conf = { precioFinalCordobas: 150, comisionBaseCordobas: 150, comisionBaseOrigen: 'tarifa_distancia', confirmadoPorUid: 'g0' };
  e.orden({ estado: 'asignada', updatedAt: stamp(1), asignacion: { motorizadoId: 'anterior' }, confirmacion: conf });
  await e.run({ operacion: 'reasignar', estadoEsperado: 'asignada' });
  assert.deepEqual(e.actual().confirmacion, conf); assert.equal(e.actual().asignacion.motorizadoId, 'm1');
  const e2 = escenario(); e2.orden({ estado: 'asignada', updatedAt: stamp(1), asignacion: { motorizadoId: 'anterior' } });
  await assert.rejects(e2.run({ operacion: 'reasignar', estadoEsperado: 'asignada' }), (err: unknown) => motivoDe('precio_sin_confirmar')(err));
  assert.equal(e2.writes.length, 0);
});

test('FIN1F-E1 confirmar con un desglose fabricado (deliveryBase 5000 contra 13.859 km) NO se confirma: cotizacion_inconsistente, 0 escrituras', async () => {
  const e = escenario(); e.orden(pendiente({ cotizacion: { distanciaKm: 13.859 }, precioDesglose: { deliveryBase: 5000, totalCobrado: 5000 } }));
  await assert.rejects(e.run({ ...confirmarP, precioFinal: 150 }), (err: unknown) => codigo('failed-precondition')(err) && motivoDe('cotizacion_inconsistente')(err));
  assert.equal(e.writes.length, 0); assert.equal(e.actual().estado, 'pendiente_confirmacion');
});

test('FIN1F-E1b desglose sin distancia verificable → cotizacion_incompleta; distancia fuera del tarifario con desglose → inconsistente', async () => {
  const e = escenario(); e.orden(pendiente({ precioDesglose: { deliveryBase: 5000 } }));
  await assert.rejects(e.run({ ...confirmarP, precioFinal: 150 }), motivoDe('cotizacion_incompleta')); assert.equal(e.writes.length, 0);
  const e2 = escenario(); e2.orden(pendiente({ cotizacion: { distanciaKm: 80 }, precioDesglose: { deliveryBase: 5000 } }));
  await assert.rejects(e2.run({ ...confirmarP, precioFinal: 150 }), motivoDe('cotizacion_inconsistente')); assert.equal(e2.writes.length, 0);
});

test('FIN1F-EDIT editar el precio de una orden ya confirmada recalcula la base con la misma fórmula', async () => {
  const e = escenario(); e.orden({ estado: 'confirmada', updatedAt: stamp(1), cotizacion: { distanciaKm: 21.759 }, precioDesglose: { deliveryBase: 210 }, confirmacion: { precioFinalCordobas: 210, comisionBaseCordobas: 210 } });
  await e.run({ operacion: 'confirmar', precioEditado: true, precioFinal: 260 });
  assert.equal(e.actual().confirmacion.precioFinalCordobas, 260); assert.equal(e.actual().confirmacion.comisionBaseCordobas, 210);
});

// ═══ A2 · la base de comisión: AUTOMÁTICA (tarifa de la distancia) o MANUAL (la declara el gestor, sin recargos) — y nunca mayor que el precio final ═══

const manualP = (extra: Record<string, unknown> = {}) => ({ ...confirmarP, ...extra }) as const;
const sinDistancia = { cotizacion: { distanciaKm: null, fuentePrecio: 'viaje_anterior' } };

test('FIN1F-F11 automático 420/150 (cliente declara 49.5 km; gestor confirma 150) → precio_incoherente, sin snapshot ni asignación', async () => {
  const e = escenario(); e.orden(pendiente({ cotizacion: { distanciaKm: 49.5 }, precioDesglose: { deliveryBase: 420, totalCobrado: 420 } }));
  await assert.rejects(e.run({ ...confirmarP, precioFinal: 150 }), (err: unknown) => codigo('failed-precondition')(err) && motivoDe('precio_incoherente')(err));
  assert.equal(e.writes.length, 0); assert.equal(e.actual().estado, 'pendiente_confirmacion'); assert.equal(e.actual().confirmacion, undefined); assert.equal(e.actual().asignacion, undefined);
});

test('FIN1F-F12 automático 440/70 (53.9 km) → precio_incoherente', async () => {
  const e = escenario(); e.orden(pendiente({ cotizacion: { distanciaKm: 53.9 } }));
  await assert.rejects(e.run({ ...confirmarP, precioFinal: 70 }), motivoDe('precio_incoherente')); assert.equal(e.writes.length, 0);
});

test('FIN1F-F13 automático 210/260 (recargo 50) → PASS con base 210; y 70/150 automático (distancia menor) también pasa porque base <= final', async () => {
  const e = escenario(); e.orden(pendiente({ cotizacion: { distanciaKm: 21.759 }, precioDesglose: { deliveryBase: 210, recargoZona: 50, totalCobrado: 260 } }));
  await e.run({ ...confirmarP, precioFinal: 260 });
  assert.equal(e.actual().confirmacion.comisionBaseCordobas, 210); assert.equal(e.actual().confirmacion.comisionBaseOrigen, 'tarifa_distancia');
  const e2 = escenario(); e2.orden(pendiente({ cotizacion: { distanciaKm: 1 } }));
  await e2.run({ ...confirmarP, precioFinal: 150 });
  assert.equal(e2.actual().confirmacion.comisionBaseCordobas, 70);
});

test('FIN1F-F14 manual: viaje anterior / fuera del tarifario sin base manual → base_comision_requerida (NO cae al precio final), 0 escrituras', async () => {
  for (const extra of [sinDistancia, { cotizacion: { distanciaKm: 80 } }, {}, { cotizacion: null, precioDesglose: null }]) {
    const e = escenario(); e.orden(pendiente(extra));
    await assert.rejects(e.run({ ...confirmarP, precioFinal: 260 }), (err: unknown) => codigo('failed-precondition')(err) && motivoDe('base_comision_requerida')(err), JSON.stringify(extra));
    assert.equal(e.writes.length, 0); assert.equal(e.actual().confirmacion, undefined);
  }
});

test('FIN1F-F15 manual 210/260: el gestor declara la base SIN recargos → snapshot manual_gestor 210, actor y fecha del servidor', async () => {
  for (const extra of [sinDistancia, { cotizacion: { distanciaKm: 80 } }]) {
    const e = escenario(); e.orden(pendiente(extra));
    await e.run(manualP({ precioFinal: 260, comisionBaseManualCordobas: 210 }));
    const c = e.actual().confirmacion;
    assert.equal(c.precioFinalCordobas, 260); assert.equal(c.comisionBaseCordobas, 210); assert.equal(c.comisionBaseOrigen, 'manual_gestor');
    assert.equal(c.confirmadoPorUid, 'gestor'); assert.equal(c.confirmadoAt.toMillis(), ahora); assert.equal(e.actual().estado, 'asignada');
  }
});

test('FIN1F-F16 manual 420/150 y 440/70 → precio_incoherente; la base manual inválida (0, negativa, texto, NaN, Infinity) se rechaza en el payload', async () => {
  for (const [base, final] of [[420, 150], [440, 70]] as const) {
    const e = escenario(); e.orden(pendiente(sinDistancia));
    await assert.rejects(e.run(manualP({ precioFinal: final, comisionBaseManualCordobas: base })), motivoDe('precio_incoherente')); assert.equal(e.writes.length, 0);
  }
  for (const m of [0, -1, '210', NaN, Infinity, null, {}]) {
    const e = escenario(); e.orden(pendiente(sinDistancia));
    await assert.rejects(e.run(manualP({ precioFinal: 260, comisionBaseManualCordobas: m as never })), codigo('invalid-argument'), String(m)); assert.equal(e.writes.length, 0);
  }
});

test('FIN1F-F17 manual 70/150 → permitido (base <= final): snapshot manual_gestor 70', async () => {
  const e = escenario(); e.orden(pendiente(sinDistancia));
  await e.run(manualP({ precioFinal: 150, comisionBaseManualCordobas: 70 }));
  assert.equal(e.actual().confirmacion.comisionBaseCordobas, 70); assert.equal(e.actual().confirmacion.comisionBaseOrigen, 'manual_gestor');
  // y 260/260 es válido por la desigualdad: el gestor declara explícitamente que todo el precio es comisionable
  const e2 = escenario(); e2.orden(pendiente(sinDistancia));
  await e2.run(manualP({ precioFinal: 260, comisionBaseManualCordobas: 260 }));
  assert.equal(e2.actual().confirmacion.comisionBaseCordobas, 260); assert.equal(e2.actual().confirmacion.comisionBaseOrigen, 'manual_gestor');
});

test('FIN1F-F18 reasignar conserva el snapshot manual intacto (precio, base, origen); una base manual NO viaja en reasignar', async () => {
  const conf = { precioFinalCordobas: 260, comisionBaseCordobas: 210, comisionBaseOrigen: 'manual_gestor', confirmadoPorUid: 'g0' };
  const e = escenario(); e.orden({ estado: 'asignada', updatedAt: stamp(1), asignacion: { motorizadoId: 'anterior' }, ...sinDistancia, confirmacion: conf });
  await e.run({ operacion: 'reasignar', estadoEsperado: 'asignada' });
  assert.deepEqual(e.actual().confirmacion, conf);
  const e2 = escenario(); e2.orden({ estado: 'asignada', updatedAt: stamp(1), asignacion: { motorizadoId: 'anterior' }, ...sinDistancia, confirmacion: conf });
  await assert.rejects(e2.run({ operacion: 'reasignar', estadoEsperado: 'asignada', comisionBaseManualCordobas: 100 } as never), codigo('invalid-argument')); assert.equal(e2.writes.length, 0);
});

test('FIN1F-F19 sugerido NO acepta una base manual para saltarse la confirmación (ni con precio ni sin él)', async () => {
  for (const orden of [{ estado: 'confirmada', updatedAt: stamp(1), ...sinDistancia }, { estado: 'confirmada', updatedAt: stamp(1), ...sinDistancia, confirmacion: { precioFinalCordobas: 260 } }]) {
    const e = escenario(); e.orden(orden);
    await assert.rejects(e.run({ operacion: 'sugerido', estadoEsperado: 'confirmada', comisionBaseManualCordobas: 210 } as never), codigo('invalid-argument'));
    assert.equal(e.writes.length, 0); assert.equal(e.actual().estado, 'confirmada');
  }
  // sugerido sobre una orden con precio pero SIN base demostrable (anterior al snapshot): no la inventa, pide confirmar
  const e = escenario(); e.orden({ estado: 'confirmada', updatedAt: stamp(1), ...sinDistancia, confirmacion: { precioFinalCordobas: 260 } });
  await assert.rejects(e.run({ operacion: 'sugerido', estadoEsperado: 'confirmada' }), motivoDe('base_comision_requerida')); assert.equal(e.writes.length, 0);
});

test('FIN1F-F19b base manual enviada en una orden AUTOMÁTICA → base_manual_no_aplica (el sistema ya demuestra la base); sin cotización coherente no se rescata', async () => {
  const e = escenario(); e.orden(pendiente({ cotizacion: { distanciaKm: 13.859 } }));
  await assert.rejects(e.run(manualP({ precioFinal: 150, comisionBaseManualCordobas: 100 })), motivoDe('base_manual_no_aplica')); assert.equal(e.writes.length, 0);
  const e2 = escenario(); e2.orden(pendiente({ cotizacion: { distanciaKm: 13.859 }, precioDesglose: { deliveryBase: 5000 } }));
  await assert.rejects(e2.run(manualP({ precioFinal: 150, comisionBaseManualCordobas: 100 })), motivoDe('cotizacion_inconsistente')); assert.equal(e2.writes.length, 0);
});

test('FIN1F-F20 confirmar sobre una orden anterior (precio sí, snapshot no): derivable → no toca nada; no derivable → exige la base; con la base la COMPLETA conservando el resto', async () => {
  const conf = { precioFinalCordobas: 260, confirmadoPorUid: 'g0', confirmadoAt: stamp(0) };
  const e = escenario(); e.orden({ estado: 'confirmada', updatedAt: stamp(1), cotizacion: { distanciaKm: 21.759 }, confirmacion: conf });
  await e.run({ operacion: 'confirmar' }); assert.deepEqual(e.actual().confirmacion, conf);
  const e2 = escenario(); e2.orden({ estado: 'confirmada', updatedAt: stamp(1), ...sinDistancia, confirmacion: conf });
  await assert.rejects(e2.run({ operacion: 'confirmar' }), motivoDe('base_comision_requerida')); assert.equal(e2.writes.length, 0);
  const e3 = escenario(); e3.orden({ estado: 'confirmada', updatedAt: stamp(1), ...sinDistancia, confirmacion: conf });
  await e3.run(manualP({ estadoEsperado: 'confirmada', comisionBaseManualCordobas: 210 } as never));
  const c = e3.actual().confirmacion;
  assert.equal(c.precioFinalCordobas, 260); assert.equal(c.confirmadoPorUid, 'g0'); assert.equal(c.comisionBaseCordobas, 210); assert.equal(c.comisionBaseOrigen, 'manual_gestor'); assert.equal(c.comisionBaseActorUid, 'gestor');
});
