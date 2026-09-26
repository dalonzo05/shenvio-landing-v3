// MOTO-ALTA-AUTH-ROL-1 — suite del alta, la reparación y el diagnóstico del
// acceso de un motorizado.
//
// Ejecuta la implementación real de src/acceso-motorizado.ts sobre un "mundo"
// en memoria: Auth, `usuarios` y `motorizado` falsos que aplican las escrituras
// y cuentan cada llamada. Sin emulador, y con la prueba directa de que un guard
// que falla no deja ninguna escritura.

import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import {
  crearAcceso,
  repararAcceso,
  diagnosticarAcceso,
  clasificarAcceso,
  type AccesoDeps,
  type AuthLite,
  type MotorizadoDoc,
  type UsuarioDoc,
} from '../src/acceso-motorizado';

const BORRAR = '__BORRAR__';
const TS = '__TS__';

const ADMIN = 'uid_admin';
const GESTOR = 'uid_gestor';

interface MundoInicial {
  usuarios?: Record<string, UsuarioDoc>;
  motorizados?: Record<string, MotorizadoDoc>;
  auths?: Record<string, AuthLite>;
}

function mundo(inicial: MundoInicial = {}) {
  const usuarios = new Map<string, UsuarioDoc>(Object.entries({
    [ADMIN]: { rol: 'admin', activo: true },
    [GESTOR]: { rol: 'gestor', activo: true },
    ...(inicial.usuarios ?? {}),
  }));
  const motorizados = new Map<string, MotorizadoDoc>(Object.entries(inicial.motorizados ?? {}));
  const auths = new Map<string, AuthLite>(Object.entries(inicial.auths ?? {}));
  const llamadas = {
    crearAuth: 0,
    escribirUsuario: [] as { uid: string; data: Record<string, unknown> }[],
    actualizarMotorizado: [] as { id: string; patch: Record<string, unknown> }[],
  };
  let fallaEscribirUsuario = false;

  const deps: AccesoDeps = {
    async getUsuario(uid) {
      const u = usuarios.get(uid);
      return u ? JSON.parse(JSON.stringify(u)) : null;
    },
    async getMotorizado(id) {
      const m = motorizados.get(id);
      return m ? JSON.parse(JSON.stringify(m)) : null;
    },
    async motorizadosConAuthUid(uid) {
      return [...motorizados.entries()].filter(([, m]) => m.authUid === uid).map(([id]) => id);
    },
    async getAuthPorUid(uid) {
      return auths.get(uid) ?? null;
    },
    async getAuthPorEmail(email) {
      return [...auths.values()].find((a) => (a.email ?? '').toLowerCase() === email.toLowerCase()) ?? null;
    },
    async crearAuth(email) {
      llamadas.crearAuth++;
      const a: AuthLite = { uid: `auth_${llamadas.crearAuth}`, email, disabled: false, emailVerified: false };
      auths.set(a.uid, a);
      return a;
    },
    async actualizarMotorizado(id, patch) {
      llamadas.actualizarMotorizado.push({ id, patch });
      const m = motorizados.get(id) ?? {};
      for (const [k, v] of Object.entries(patch)) {
        if (v === BORRAR) delete m[k];
        else m[k] = v;
      }
      motorizados.set(id, m);
    },
    async escribirUsuario(uid, data) {
      if (fallaEscribirUsuario) {
        fallaEscribirUsuario = false;
        throw new Error('fallo simulado al escribir el perfil');
      }
      llamadas.escribirUsuario.push({ uid, data });
      usuarios.set(uid, { ...(usuarios.get(uid) ?? {}), ...data });
    },
    ahora: () => TS,
    borrarCampo: () => BORRAR,
  };
  return {
    deps,
    usuarios,
    motorizados,
    auths,
    llamadas,
    fallarProximaEscrituraDePerfil() {
      fallaEscribirUsuario = true;
    },
    sinEscrituras() {
      return llamadas.crearAuth === 0 && llamadas.escribirUsuario.length === 0 && llamadas.actualizarMotorizado.length === 0;
    },
  };
}

const codigo = (esperado: string) => (e: unknown) => (e as { code?: string }).code === esperado;

const MOTO_LIMPIO: MotorizadoDoc = { nombre: 'Luigi Alonzo', telefono: '77889911', estado: 'disponible', activo: true, authUid: null };

// ─── crearAcceso ──────────────────────────────────────────────────────────────

test('MA1 · un admin crea un acceso nuevo válido: Auth, perfil con rol y vínculo', async () => {
  const m = mundo({ motorizados: { moto1: { ...MOTO_LIMPIO } } });
  const r = await crearAcceso(m.deps, ADMIN, { motorizadoId: 'moto1', email: ' Luigi@Example.com ' });

  assert.equal(m.llamadas.crearAuth, 1);
  assert.equal(r.esNuevoAuthUser, true);
  assert.equal(r.esIdempotente, false);
  assert.equal(r.estado, 'pendiente_activacion', 'sin emailVerified el acceso espera la activación');

  const perfil = m.usuarios.get(r.authUid)!;
  assert.equal(perfil.rol, 'motorizado');
  assert.equal(perfil.activo, true);
  assert.equal(perfil.email, 'luigi@example.com');
  assert.equal(perfil.name, 'Luigi Alonzo');
  assert.equal(perfil.creadoPorUid, ADMIN);
  assert.equal(perfil.createdAt, TS);

  const moto = m.motorizados.get('moto1')!;
  assert.equal(moto.authUid, r.authUid);
  assert.ok(!('accesoProvisionAuthUid' in moto), 'la evidencia de provisión se limpia al terminar');
  // Sin contraseña en ninguna parte: ni en el Auth ni en el perfil.
  assert.ok(!JSON.stringify([...m.usuarios.values()]).toLowerCase().includes('password'));
  assert.ok(!('password' in (m.auths.get(r.authUid) as object)));
});

test('MA2 · un gestor activo crea un acceso válido', async () => {
  const m = mundo({ motorizados: { moto1: { ...MOTO_LIMPIO } } });
  const r = await crearAcceso(m.deps, GESTOR, { motorizadoId: 'moto1', email: 'luigi@example.com' });
  assert.equal(r.esNuevoAuthUser, true);
  assert.equal(m.usuarios.get(r.authUid)!.rol, 'motorizado');
});

test('MA3 · un actor no autorizado recibe permission-denied y no deja nada', async () => {
  const actores: Record<string, UsuarioDoc | null> = {
    uid_moto: { rol: 'motorizado', activo: true },
    uid_comercio: { rol: 'Comercio', activo: true },
    uid_digitador: { rol: 'digitador', activo: true },
    uid_gestor_inactivo: { rol: 'gestor', activo: false },
    uid_gestor_sin_activo: { rol: 'gestor' },
    uid_sin_rol: { email: 'x@x.com' },
  };
  for (const [uid, perfil] of Object.entries(actores)) {
    const m = mundo({ motorizados: { moto1: { ...MOTO_LIMPIO } }, usuarios: perfil ? { [uid]: perfil } : {} });
    await assert.rejects(crearAcceso(m.deps, uid, { motorizadoId: 'moto1', email: 'l@x.com' }), codigo('permission-denied'), uid);
    assert.ok(m.sinEscrituras(), uid);
  }
  // Un uid que ni siquiera tiene perfil.
  const m = mundo({ motorizados: { moto1: { ...MOTO_LIMPIO } } });
  await assert.rejects(crearAcceso(m.deps, 'uid_fantasma', { motorizadoId: 'moto1', email: 'l@x.com' }), codigo('permission-denied'));
  assert.ok(m.sinEscrituras());
});

test('MA4 · un motorizado inexistente o sin nombre falla sin crear nada', async () => {
  const m = mundo();
  await assert.rejects(crearAcceso(m.deps, ADMIN, { motorizadoId: 'no_existe', email: 'l@x.com' }), codigo('not-found'));
  assert.ok(m.sinEscrituras());

  const sinNombre = mundo({ motorizados: { moto1: { ...MOTO_LIMPIO, nombre: '   ' } } });
  await assert.rejects(crearAcceso(sinNombre.deps, ADMIN, { motorizadoId: 'moto1', email: 'l@x.com' }), codigo('failed-precondition'));
  assert.ok(sinNombre.sinEscrituras());
});

test('MA5 · un motorizado ya vinculado con acceso sano no duplica nada', async () => {
  for (const emailVerified of [false, true]) {
    const m = mundo({
      motorizados: { moto1: { ...MOTO_LIMPIO, authUid: 'uid_l' } },
      auths: { uid_l: { uid: 'uid_l', email: 'luigi@example.com', disabled: false, emailVerified } },
      usuarios: { uid_l: { rol: 'motorizado', activo: true, email: 'luigi@example.com' } },
    });
    const r = await crearAcceso(m.deps, GESTOR, { motorizadoId: 'moto1', email: 'LUIGI@example.com' });
    assert.equal(r.esIdempotente, true);
    assert.equal(r.esNuevoAuthUser, false);
    assert.equal(r.estado, emailVerified ? 'activo' : 'pendiente_activacion');
    assert.ok(m.sinEscrituras(), 'la segunda llamada no escribe nada');
  }
  // Con OTRO correo, no se crea un segundo acceso.
  const otro = mundo({
    motorizados: { moto1: { ...MOTO_LIMPIO, authUid: 'uid_l' } },
    auths: { uid_l: { uid: 'uid_l', email: 'luigi@example.com', disabled: false, emailVerified: true } },
    usuarios: { uid_l: { rol: 'motorizado', activo: true } },
  });
  await assert.rejects(crearAcceso(otro.deps, GESTOR, { motorizadoId: 'moto1', email: 'otro@example.com' }), codigo('failed-precondition'));
  assert.ok(otro.sinEscrituras());
});

test('MA5b · un acceso incompleto no se "crea otra vez": se manda a reparar', async () => {
  const m = mundo({
    motorizados: { moto1: { ...MOTO_LIMPIO, authUid: 'uid_l' } },
    auths: { uid_l: { uid: 'uid_l', email: 'luigi@example.com', disabled: false, emailVerified: false } },
    usuarios: { uid_l: { email: 'luigi@example.com' } },
  });
  await assert.rejects(
    crearAcceso(m.deps, ADMIN, { motorizadoId: 'moto1', email: 'luigi@example.com' }),
    (e: unknown) => (e as { code?: string }).code === 'failed-precondition' && /repar/i.test((e as { message: string }).message),
  );
  assert.ok(m.sinEscrituras());
});

test('MA6 · un correo que ya pertenece a otra identidad falla de forma segura, sin adoptarla', async () => {
  const m = mundo({
    motorizados: { moto1: { ...MOTO_LIMPIO } },
    auths: { uid_ajeno: { uid: 'uid_ajeno', email: 'luigi@example.com', disabled: false, emailVerified: true } },
    usuarios: { uid_ajeno: { rol: 'gestor', activo: true } },
  });
  await assert.rejects(crearAcceso(m.deps, ADMIN, { motorizadoId: 'moto1', email: 'luigi@example.com' }), codigo('already-exists'));
  assert.ok(m.sinEscrituras());
  assert.equal(m.usuarios.get('uid_ajeno')!.rol, 'gestor', 'el rol ajeno no se toca');
  assert.equal(m.motorizados.get('moto1')!.authUid, null, 'no se vinculó nada');

  // Y si el correo aparece por una carrera al crear, tampoco se adopta.
  const carrera = mundo({ motorizados: { moto1: { ...MOTO_LIMPIO } } });
  carrera.deps.crearAuth = async () => {
    throw Object.assign(new Error('ya existe'), { code: 'auth/email-already-exists' });
  };
  await assert.rejects(crearAcceso(carrera.deps, ADMIN, { motorizadoId: 'moto1', email: 'luigi@example.com' }), codigo('already-exists'));
  assert.equal(carrera.llamadas.escribirUsuario.length, 0);
});

test('MA7 · si el UID ya lo usa otro motorizado, falla y no escribe el perfil', async () => {
  const m = mundo({
    motorizados: {
      moto1: { ...MOTO_LIMPIO, accesoProvisionAuthUid: 'uid_x' },
      moto2: { ...MOTO_LIMPIO, nombre: 'Otro', authUid: 'uid_x' },
    },
    auths: { uid_x: { uid: 'uid_x', email: 'luigi@example.com', disabled: false, emailVerified: false } },
  });
  await assert.rejects(crearAcceso(m.deps, ADMIN, { motorizadoId: 'moto1', email: 'luigi@example.com' }), codigo('failed-precondition'));
  assert.equal(m.llamadas.escribirUsuario.length, 0);
  assert.equal(m.llamadas.crearAuth, 0);
});

test('MA8 · un reintento tras un estado parcial recuperable no crea otro Auth', async () => {
  // La primera llamada creó el Auth y anotó la evidencia, pero no llegó al perfil.
  const m = mundo({ motorizados: { moto1: { ...MOTO_LIMPIO } } });
  m.fallarProximaEscrituraDePerfil();
  await assert.rejects(crearAcceso(m.deps, ADMIN, { motorizadoId: 'moto1', email: 'luigi@example.com' }), /fallo simulado/);
  assert.equal(m.llamadas.crearAuth, 1);
  const parcial = m.motorizados.get('moto1')!;
  assert.ok(parcial.accesoProvisionAuthUid, 'quedó la evidencia para reanudar');
  assert.equal(parcial.authUid, null, 'todavía sin vínculo');

  const r = await crearAcceso(m.deps, ADMIN, { motorizadoId: 'moto1', email: 'luigi@example.com' });
  assert.equal(m.llamadas.crearAuth, 1, 'no se creó un segundo Auth');
  assert.equal(r.esNuevoAuthUser, false);
  assert.equal(r.authUid, 'auth_1');
  assert.equal(m.usuarios.get('auth_1')!.rol, 'motorizado');
  assert.equal(m.motorizados.get('moto1')!.authUid, 'auth_1');
  assert.ok(!('accesoProvisionAuthUid' in m.motorizados.get('moto1')!));

  // Y una tercera llamada ya es idempotente.
  const otra = await crearAcceso(m.deps, ADMIN, { motorizadoId: 'moto1', email: 'luigi@example.com' });
  assert.equal(otra.esIdempotente, true);
  assert.equal(m.llamadas.crearAuth, 1);
});

test('MA8b · la evidencia con otro correo, o con la cuenta ya borrada, se maneja sin adoptar nada ajeno', async () => {
  const otroCorreo = mundo({
    motorizados: { moto1: { ...MOTO_LIMPIO, accesoProvisionAuthUid: 'uid_x' } },
    auths: { uid_x: { uid: 'uid_x', email: 'otro@example.com', disabled: false, emailVerified: false } },
  });
  await assert.rejects(crearAcceso(otroCorreo.deps, ADMIN, { motorizadoId: 'moto1', email: 'luigi@example.com' }), codigo('failed-precondition'));
  assert.equal(otroCorreo.llamadas.crearAuth, 0);

  // Si la cuenta de la evidencia ya no existe, se crea una nueva y la evidencia se reemplaza.
  const borrada = mundo({ motorizados: { moto1: { ...MOTO_LIMPIO, accesoProvisionAuthUid: 'uid_borrado' } } });
  const r = await crearAcceso(borrada.deps, ADMIN, { motorizadoId: 'moto1', email: 'luigi@example.com' });
  assert.equal(r.esNuevoAuthUser, true);
  assert.equal(borrada.llamadas.crearAuth, 1);
});

test('MA8c · si el perfil del UID ya existe con otro rol del sistema, no se pisa', async () => {
  for (const rol of ['gestor', 'admin', 'Comercio', 'digitador', 'cliente', 'cualquier_cosa']) {
    const m = mundo({
      motorizados: { moto1: { ...MOTO_LIMPIO, accesoProvisionAuthUid: 'uid_x' } },
      auths: { uid_x: { uid: 'uid_x', email: 'luigi@example.com', disabled: false, emailVerified: false } },
      usuarios: { uid_x: { rol, activo: true } },
    });
    await assert.rejects(crearAcceso(m.deps, ADMIN, { motorizadoId: 'moto1', email: 'luigi@example.com' }), codigo('failed-precondition'), rol);
    assert.equal(m.usuarios.get('uid_x')!.rol, rol);
    assert.equal(m.llamadas.escribirUsuario.length, 0, rol);
  }
});

test('MA9 · crear acceso no toca el estado operativo ni ningún otro campo del motorizado', async () => {
  const m = mundo({ motorizados: { moto1: { ...MOTO_LIMPIO, estado: 'ocupado', tieneBolso: true, tasaAceptacion: 0.5 } } });
  await crearAcceso(m.deps, ADMIN, { motorizadoId: 'moto1', email: 'luigi@example.com' });
  const permitidas = ['accesoProvisionAuthUid', 'accesoEmail', 'authUid'];
  for (const { patch } of m.llamadas.actualizarMotorizado) {
    for (const k of Object.keys(patch)) assert.ok(permitidas.includes(k), `campo inesperado: ${k}`);
  }
  const moto = m.motorizados.get('moto1')!;
  assert.equal(moto.estado, 'ocupado');
  assert.equal(moto.activo, true);
  assert.equal(moto.tieneBolso, true);
  assert.equal(moto.tasaAceptacion, 0.5);
});

test('MA10 · el payload no admite rol, uid, contraseña, activo ni emailVerified', async () => {
  const extras: Record<string, unknown>[] = [
    { rol: 'admin' },
    { authUid: 'uid_cualquiera' },
    { uid: 'uid_cualquiera' },
    { password: '123456' },
    { contrasena: '123456' },
    { activo: true },
    { emailVerified: true },
    { nombre: 'Otro' },
  ];
  for (const extra of extras) {
    const m = mundo({ motorizados: { moto1: { ...MOTO_LIMPIO } } });
    await assert.rejects(
      crearAcceso(m.deps, ADMIN, { motorizadoId: 'moto1', email: 'luigi@example.com', ...extra }),
      codigo('invalid-argument'),
      JSON.stringify(extra),
    );
    assert.ok(m.sinEscrituras());
  }
  // Y le faltan campos, o no es un objeto, o el email no sirve.
  const m = mundo({ motorizados: { moto1: { ...MOTO_LIMPIO } } });
  for (const data of [{ motorizadoId: 'moto1' }, { email: 'a@b.com' }, null, [], 'x', { motorizadoId: 'moto1', email: 'no-es-correo' }, { motorizadoId: '', email: 'a@b.com' }]) {
    await assert.rejects(crearAcceso(m.deps, ADMIN, data), codigo('invalid-argument'), JSON.stringify(data));
  }
  assert.ok(m.sinEscrituras());
});

test('MA11 · el perfil se marca inactivo si el motorizado lo está, como en el alta anterior', async () => {
  const m = mundo({ motorizados: { moto1: { ...MOTO_LIMPIO, activo: false } } });
  const r = await crearAcceso(m.deps, ADMIN, { motorizadoId: 'moto1', email: 'luigi@example.com' });
  assert.equal(m.usuarios.get(r.authUid)!.activo, false);
});

// ─── repararAcceso ────────────────────────────────────────────────────────────

/** El caso Luigi tal como lo mostró staging. */
function luigi(over: { verificado?: boolean; usuario?: UsuarioDoc | null } = {}) {
  return mundo({
    motorizados: { moto1: { ...MOTO_LIMPIO, authUid: 'uid_l' } },
    auths: { uid_l: { uid: 'uid_l', email: 'luigi@example.com', disabled: false, emailVerified: over.verificado === true } },
    usuarios: over.usuario === null ? {} : { uid_l: over.usuario ?? { email: 'luigi@example.com', createdAt: 'x', updatedAt: 'y' } },
  });
}

test('MR1 · caso Luigi: Auth, vínculo y perfil sin rol → un admin lo repara a motorizado activo', async () => {
  const m = luigi();
  const antes = clasificarAcceso({
    motorizadoActivo: true,
    authUid: 'uid_l',
    auth: m.auths.get('uid_l')!,
    usuario: m.usuarios.get('uid_l')!,
    duplicados: 0,
  });
  assert.equal(antes.estado, 'incompleto');
  assert.deepEqual(antes.problemas, ['rol_ausente', 'perfil_inactivo']);
  assert.equal(antes.reparable, true);

  const r = await repararAcceso(m.deps, ADMIN, { motorizadoId: 'moto1' });
  assert.equal(r.yaReparado, false);
  assert.equal(r.estado, 'pendiente_activacion', 'falta que complete el enlace: no se finge acceso completo');

  const perfil = m.usuarios.get('uid_l')!;
  assert.equal(perfil.rol, 'motorizado');
  assert.equal(perfil.activo, true, 'firestore.rules exige activo == true además del rol');
  assert.equal(perfil.email, 'luigi@example.com');
  assert.equal(perfil.name, 'Luigi Alonzo');
  assert.equal(perfil.createdAt, 'x', 'no se pisa lo que ya había');
  assert.equal(perfil.reparadoPorUid, ADMIN);
  // El motorizado y el Auth no se tocan.
  assert.equal(m.llamadas.actualizarMotorizado.length, 0);
  assert.equal(m.llamadas.crearAuth, 0);

  // Si además el Auth ya estaba verificado, queda activo.
  const verificado = luigi({ verificado: true });
  const r2 = await repararAcceso(verificado.deps, ADMIN, { motorizadoId: 'moto1' });
  assert.equal(r2.estado, 'activo');
});

test('MR2 · un perfil ya sano es idempotente, y reparar dos veces no duplica nada', async () => {
  const sano = mundo({
    motorizados: { moto1: { ...MOTO_LIMPIO, authUid: 'uid_l' } },
    auths: { uid_l: { uid: 'uid_l', email: 'luigi@example.com', disabled: false, emailVerified: true } },
    usuarios: { uid_l: { rol: 'motorizado', activo: true, email: 'luigi@example.com' } },
  });
  const r = await repararAcceso(sano.deps, ADMIN, { motorizadoId: 'moto1' });
  assert.equal(r.yaReparado, true);
  assert.ok(sano.sinEscrituras());

  const m = luigi();
  await repararAcceso(m.deps, ADMIN, { motorizadoId: 'moto1' });
  const escrituras = m.llamadas.escribirUsuario.length;
  const segunda = await repararAcceso(m.deps, ADMIN, { motorizadoId: 'moto1' });
  assert.equal(segunda.yaReparado, true);
  assert.equal(m.llamadas.escribirUsuario.length, escrituras, 'la segunda ejecución no escribe');
});

test('MR3 · un perfil con otro rol válido NO se sobrescribe', async () => {
  for (const rol of ['gestor', 'admin', 'Comercio', 'digitador', 'cliente', 'algo_desconocido']) {
    const m = luigi({ usuario: { rol, activo: true, email: 'luigi@example.com' } });
    await assert.rejects(repararAcceso(m.deps, ADMIN, { motorizadoId: 'moto1' }), codigo('failed-precondition'), rol);
    assert.equal(m.usuarios.get('uid_l')!.rol, rol, 'el rol no cambió');
    assert.equal(m.llamadas.escribirUsuario.length, 0, rol);
  }
});

test('MR3b · un rol de motorizado mal escrito sí se corrige; un perfil inexistente se crea con la cadena inequívoca', async () => {
  const malEscrito = luigi({ usuario: { rol: 'Motorizado', activo: true, email: 'luigi@example.com' } });
  await repararAcceso(malEscrito.deps, ADMIN, { motorizadoId: 'moto1' });
  assert.equal(malEscrito.usuarios.get('uid_l')!.rol, 'motorizado');

  const sinPerfil = luigi({ usuario: null });
  const r = await repararAcceso(sinPerfil.deps, ADMIN, { motorizadoId: 'moto1' });
  assert.equal(r.yaReparado, false);
  const perfil = sinPerfil.usuarios.get('uid_l')!;
  assert.equal(perfil.rol, 'motorizado');
  assert.equal(perfil.activo, true);
  assert.equal(perfil.email, 'luigi@example.com');
  assert.equal(perfil.createdAt, TS);
});

test('MR4 · si la cuenta de Auth no existe, falla y no escribe', async () => {
  const m = luigi();
  m.auths.clear();
  await assert.rejects(repararAcceso(m.deps, ADMIN, { motorizadoId: 'moto1' }), codigo('failed-precondition'));
  assert.equal(m.llamadas.escribirUsuario.length, 0);
});

test('MR5 · si dos motorizados usan el mismo UID, falla y no escribe', async () => {
  const m = luigi();
  m.motorizados.set('moto2', { ...MOTO_LIMPIO, nombre: 'Otro', authUid: 'uid_l' });
  await assert.rejects(repararAcceso(m.deps, ADMIN, { motorizadoId: 'moto1' }), codigo('failed-precondition'));
  assert.equal(m.llamadas.escribirUsuario.length, 0);
});

test('MR6 · si el correo del perfil no coincide con el de la cuenta, falla y no escribe', async () => {
  const m = luigi({ usuario: { email: 'otra-persona@example.com' } });
  await assert.rejects(repararAcceso(m.deps, ADMIN, { motorizadoId: 'moto1' }), codigo('failed-precondition'));
  assert.equal(m.llamadas.escribirUsuario.length, 0);
});

test('MR6b · una cuenta de Auth deshabilitada no se repara sola', async () => {
  const m = luigi();
  m.auths.set('uid_l', { ...m.auths.get('uid_l')!, disabled: true });
  await assert.rejects(repararAcceso(m.deps, ADMIN, { motorizadoId: 'moto1' }), codigo('failed-precondition'));
  assert.equal(m.llamadas.escribirUsuario.length, 0);
});

test('MR7 · un gestor (o cualquiera que no sea admin activo) NO puede reparar', async () => {
  const m = luigi();
  for (const uid of [GESTOR, 'uid_moto', 'uid_fantasma']) {
    m.usuarios.set('uid_moto', { rol: 'motorizado', activo: true });
    await assert.rejects(repararAcceso(m.deps, uid, { motorizadoId: 'moto1' }), codigo('permission-denied'), uid);
  }
  const adminInactivo = luigi();
  adminInactivo.usuarios.set('uid_admin_off', { rol: 'admin', activo: false });
  await assert.rejects(repararAcceso(adminInactivo.deps, 'uid_admin_off', { motorizadoId: 'moto1' }), codigo('permission-denied'));
  assert.equal(m.llamadas.escribirUsuario.length, 0);
  assert.equal(adminInactivo.llamadas.escribirUsuario.length, 0);
});

test('MR8 · un admin activo repara (ALLOW)', async () => {
  const m = luigi();
  const r = await repararAcceso(m.deps, ADMIN, { motorizadoId: 'moto1' });
  assert.equal(r.ok, true);
  assert.equal(m.usuarios.get('uid_l')!.rol, 'motorizado');
});

test('MR9 · reparar exige un vínculo existente y un payload exacto', async () => {
  const sinVinculo = mundo({ motorizados: { moto1: { ...MOTO_LIMPIO } } });
  await assert.rejects(repararAcceso(sinVinculo.deps, ADMIN, { motorizadoId: 'moto1' }), codigo('failed-precondition'));
  await assert.rejects(repararAcceso(sinVinculo.deps, ADMIN, { motorizadoId: 'no_existe' }), codigo('not-found'));
  for (const extra of [{ rol: 'motorizado' }, { authUid: 'uid_x' }, { activo: true }, { email: 'a@b.com' }]) {
    const m = luigi();
    await assert.rejects(repararAcceso(m.deps, ADMIN, { motorizadoId: 'moto1', ...extra }), codigo('invalid-argument'), JSON.stringify(extra));
    assert.equal(m.llamadas.escribirUsuario.length, 0);
  }
});

// ─── diagnosticarAcceso y clasificación ───────────────────────────────────────

test('DG1 · sin authUid es "sin acceso", y un gestor puede consultarlo', async () => {
  const m = mundo({ motorizados: { moto1: { ...MOTO_LIMPIO } } });
  const d = await diagnosticarAcceso(m.deps, GESTOR, { motorizadoId: 'moto1' });
  assert.equal(d.estado, 'sin_acceso');
  assert.equal(d.authUid, null);
  assert.deepEqual(d.problemas, []);
});

test('DG2 · el caso Luigi se diagnostica como acceso incompleto y reparable, con detalle legible', async () => {
  const m = luigi();
  const d = await diagnosticarAcceso(m.deps, GESTOR, { motorizadoId: 'moto1' });
  assert.equal(d.estado, 'incompleto');
  assert.equal(d.reparable, true);
  assert.deepEqual(d.problemas, ['rol_ausente', 'perfil_inactivo']);
  assert.equal(d.detalle.length, 2);
  assert.equal(d.emailAcceso, 'luigi@example.com');
});

test('DG3 · pendiente de activación vs activo depende solo de emailVerified', async () => {
  for (const [emailVerified, esperado] of [[false, 'pendiente_activacion'], [true, 'activo']] as const) {
    const m = mundo({
      motorizados: { moto1: { ...MOTO_LIMPIO, authUid: 'uid_l' } },
      auths: { uid_l: { uid: 'uid_l', email: 'l@x.com', disabled: false, emailVerified } },
      usuarios: { uid_l: { rol: 'motorizado', activo: true, email: 'l@x.com' } },
    });
    assert.equal((await diagnosticarAcceso(m.deps, ADMIN, { motorizadoId: 'moto1' })).estado, esperado);
  }
});

test('DG4 · un motorizado, un comercio o un digitador no pueden consultar el acceso ajeno', async () => {
  const m = mundo({ motorizados: { moto1: { ...MOTO_LIMPIO } }, usuarios: { u1: { rol: 'motorizado', activo: true }, u2: { rol: 'Comercio', activo: true }, u3: { rol: 'digitador', activo: true } } });
  for (const uid of ['u1', 'u2', 'u3', 'fantasma']) {
    await assert.rejects(diagnosticarAcceso(m.deps, uid, { motorizadoId: 'moto1' }), codigo('permission-denied'), uid);
  }
});

test('DG5 · un authUid pegado a mano que no existe NO es "acceso activo"', () => {
  const dx = clasificarAcceso({ motorizadoActivo: true, authUid: 'uid_inventado', auth: null, usuario: null, duplicados: 0 });
  assert.equal(dx.estado, 'incompleto');
  assert.ok(dx.problemas.includes('auth_inexistente'));
  assert.equal(dx.reparable, false, 'sin cuenta de Auth no hay nada que reparar solo');
});

test('DG6 · un perfil con otro rol es un conflicto, no algo reparable', () => {
  const dx = clasificarAcceso({
    motorizadoActivo: true,
    authUid: 'u',
    auth: { uid: 'u', email: 'a@b.com', disabled: false, emailVerified: true },
    usuario: { rol: 'gestor', activo: true, email: 'a@b.com' },
    duplicados: 0,
  });
  assert.equal(dx.estado, 'incompleto');
  assert.deepEqual(dx.problemas, ['rol_incompatible']);
  assert.equal(dx.reparable, false);
});
