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
  finalizarActivacion,
  VENTANA_SESION_RECIENTE_SEG,
  type ActivacionDeps,
  type ContextoSesion,
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
    /** UIDs a los que el servidor les marcó emailVerified = true. */
    verificar: [] as string[],
  };
  let fallaEscribirUsuario = false;

  const deps: ActivacionDeps = {
    async marcarEmailVerificado(uid) {
      llamadas.verificar.push(uid);
      const a = auths.get(uid);
      if (a) auths.set(uid, { ...a, emailVerified: true });
    },
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
      return llamadas.crearAuth === 0 && llamadas.escribirUsuario.length === 0 && llamadas.actualizarMotorizado.length === 0 && llamadas.verificar.length === 0;
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

// ─── AV · finalizarActivacion: cerrar la activación con evidencia del servidor ──
//
// Que definir la contraseña por el enlace de /crear-password deje la cuenta
// verificada NO se asume. El propio motorizado, ya autenticado con la contraseña
// que acaba de definir, pide cerrar su activación; el servidor decide con la
// sesión y con Firestore, y nunca con algo que mande el cliente.

const AHORA = 1_800_000_000;

/** Sesión válida: contraseña, iniciada hace 30 s. */
function sesion(uid: string, over: Partial<ContextoSesion> = {}): ContextoSesion {
  return { uid, proveedor: 'password', authTimeSec: AHORA - 30, ahoraSec: AHORA, ...over };
}

/** Un acceso creado por el alta y a la espera de que el motorizado active su cuenta. */
function pendiente(over: { verificado?: boolean; motorizado?: MotorizadoDoc; usuario?: UsuarioDoc } = {}) {
  return mundo({
    motorizados: {
      moto1: { ...MOTO_LIMPIO, authUid: 'uid_l', accesoEmail: 'luigi@example.com', ...(over.motorizado ?? {}) },
    },
    auths: { uid_l: { uid: 'uid_l', email: 'luigi@example.com', disabled: false, emailVerified: over.verificado === true } },
    usuarios: { uid_l: over.usuario ?? { rol: 'motorizado', activo: true, email: 'luigi@example.com' } },
  });
}

test('AV1 · un acceso recién creado (sin verificar) queda "pendiente de activación", no activo', async () => {
  const m = mundo({ motorizados: { moto1: { ...MOTO_LIMPIO } } });
  const r = await crearAcceso(m.deps, ADMIN, { motorizadoId: 'moto1', email: 'luigi@example.com' });
  assert.equal(m.auths.get(r.authUid)!.emailVerified, false);
  assert.equal(r.estado, 'pendiente_activacion');
  const d = await diagnosticarAcceso(m.deps, GESTOR, { motorizadoId: 'moto1' });
  assert.equal(d.estado, 'pendiente_activacion');
  assert.equal(m.llamadas.verificar.length, 0, 'crear acceso no verifica nada');
  // La evidencia de la activación pendiente quedó escrita por el servidor.
  assert.equal(m.motorizados.get('moto1')!.accesoEmail, 'luigi@example.com');
});

test('AV2 · definir la contraseña SIN cerrar la activación no verifica la cuenta: sigue pendiente', async () => {
  const m = pendiente();
  // Firebase ya aceptó la contraseña, pero nadie llamó al cierre.
  assert.equal((await diagnosticarAcceso(m.deps, ADMIN, { motorizadoId: 'moto1' })).estado, 'pendiente_activacion');

  // Sin una sesión de contraseña (por ejemplo, un token de otro proveedor) no se cierra.
  for (const proveedor of [null, 'google.com', 'custom', 'anonymous']) {
    await assert.rejects(finalizarActivacion(m.deps, sesion('uid_l', { proveedor }), {}), codigo('permission-denied'), String(proveedor));
  }
  // Con una sesión vieja tampoco: tiene que ser un inicio de sesión reciente.
  for (const authTimeSec of [null, AHORA - VENTANA_SESION_RECIENTE_SEG - 1, AHORA - 86_400, AHORA + 3_600]) {
    await assert.rejects(finalizarActivacion(m.deps, sesion('uid_l', { authTimeSec }), {}), codigo('failed-precondition'), String(authTimeSec));
  }
  assert.equal(m.llamadas.verificar.length, 0);
  assert.equal(m.auths.get('uid_l')!.emailVerified, false);
});

test('AV3 · la finalización válida verifica la cuenta y el acceso pasa a activo', async () => {
  const m = pendiente();
  const r = await finalizarActivacion(m.deps, sesion('uid_l'), {});
  assert.equal(r.yaVerificado, false);
  assert.equal(r.estado, 'activo');
  assert.equal(m.auths.get('uid_l')!.emailVerified, true);
  assert.deepEqual(m.llamadas.verificar, ['uid_l']);
  assert.equal((await diagnosticarAcceso(m.deps, ADMIN, { motorizadoId: 'moto1' })).estado, 'activo');
  // No toca el motorizado ni el perfil.
  assert.equal(m.llamadas.actualizarMotorizado.length, 0);
  assert.equal(m.llamadas.escribirUsuario.length, 0);
});

test('AV4 · otro actor no puede finalizar la activación de un tercero, ni con un payload libre', async () => {
  const m = pendiente();
  m.usuarios.set('uid_b', { rol: 'motorizado', activo: true, email: 'b@example.com' });
  m.auths.set('uid_b', { uid: 'uid_b', email: 'b@example.com', disabled: false, emailVerified: false });
  m.motorizados.set('moto2', { ...MOTO_LIMPIO, nombre: 'B', authUid: 'uid_b' }); // sin accesoEmail: nadie autorizó su activación

  // Un gestor o un admin no activan cuentas ajenas: esto es solo del propio motorizado.
  for (const uid of [GESTOR, ADMIN]) {
    await assert.rejects(finalizarActivacion(m.deps, sesion(uid), {}), codigo('permission-denied'), uid);
  }
  // Otro motorizado solo puede cerrar SU activación, y no tiene una pendiente.
  await assert.rejects(finalizarActivacion(m.deps, sesion('uid_b'), {}), codigo('failed-precondition'));
  // Un payload que intente señalar a otro UID, o afirmar "verificado", se rechaza entero.
  for (const extra of [{ uid: 'uid_l' }, { verified: true }, { emailVerified: true }, { motorizadoId: 'moto1' }, { authUid: 'uid_l' }]) {
    await assert.rejects(finalizarActivacion(m.deps, sesion('uid_b'), extra), codigo('invalid-argument'), JSON.stringify(extra));
  }
  for (const data of ['x', 5, ['a'], true]) {
    await assert.rejects(finalizarActivacion(m.deps, sesion('uid_b'), data), codigo('invalid-argument'));
  }
  assert.equal(m.llamadas.verificar.length, 0);
  assert.equal(m.auths.get('uid_l')!.emailVerified, false);
  assert.equal(m.auths.get('uid_b')!.emailVerified, false);
});

test('AV4b · una activación con otro correo que el de la cuenta no cuenta como pendiente', async () => {
  for (const cambio of [
    { motorizado: { accesoEmail: 'otro@example.com' } },
    { motorizado: { accesoEmail: undefined } },
    { usuario: { rol: 'motorizado', activo: true, email: 'otro@example.com' } as UsuarioDoc },
  ]) {
    const m = pendiente(cambio);
    await assert.rejects(finalizarActivacion(m.deps, sesion('uid_l'), {}), codigo('failed-precondition'), JSON.stringify(cambio));
    assert.equal(m.llamadas.verificar.length, 0);
  }
  // La cuenta deshabilitada tampoco se activa.
  const off = pendiente();
  off.auths.set('uid_l', { ...off.auths.get('uid_l')!, disabled: true });
  await assert.rejects(finalizarActivacion(off.deps, sesion('uid_l'), {}), codigo('permission-denied'));
  const sinAuth = pendiente();
  sinAuth.auths.clear();
  await assert.rejects(finalizarActivacion(sinAuth.deps, sesion('uid_l'), {}), codigo('failed-precondition'));
  assert.equal(off.llamadas.verificar.length + sinAuth.llamadas.verificar.length, 0);
});

test('AV5 · un perfil sin rol (o con otro rol, o inactivo) no puede finalizar como acceso sano', async () => {
  const perfiles: UsuarioDoc[] = [
    { email: 'luigi@example.com' }, // el caso Luigi antes de reparar
    { rol: 'gestor', activo: true, email: 'luigi@example.com' },
    { rol: 'Motorizado', activo: true, email: 'luigi@example.com' },
    { rol: 'motorizado', activo: false, email: 'luigi@example.com' },
    { rol: 'motorizado', email: 'luigi@example.com' },
  ];
  for (const usuario of perfiles) {
    const m = pendiente({ usuario });
    await assert.rejects(finalizarActivacion(m.deps, sesion('uid_l'), {}), codigo('permission-denied'), JSON.stringify(usuario));
    assert.equal(m.llamadas.verificar.length, 0);
  }
  const sinPerfil = pendiente();
  sinPerfil.usuarios.delete('uid_l');
  await assert.rejects(finalizarActivacion(sinPerfil.deps, sesion('uid_l'), {}), codigo('permission-denied'));
});

test('AV6 · si no hay un motorizado vinculado a ese UID, no se activa nada', async () => {
  const sinVinculo = pendiente();
  sinVinculo.motorizados.set('moto1', { ...MOTO_LIMPIO, authUid: 'uid_otro', accesoEmail: 'luigi@example.com' });
  await assert.rejects(finalizarActivacion(sinVinculo.deps, sesion('uid_l'), {}), codigo('permission-denied'));

  const duplicado = pendiente();
  duplicado.motorizados.set('moto2', { ...MOTO_LIMPIO, nombre: 'Otro', authUid: 'uid_l', accesoEmail: 'luigi@example.com' });
  await assert.rejects(finalizarActivacion(duplicado.deps, sesion('uid_l'), {}), codigo('failed-precondition'));
  assert.equal(sinVinculo.llamadas.verificar.length + duplicado.llamadas.verificar.length, 0);
});

test('AV7 · una cuenta ya verificada es idempotente: éxito y sin escribir nada', async () => {
  const m = pendiente({ verificado: true });
  const r = await finalizarActivacion(m.deps, sesion('uid_l'), {});
  assert.equal(r.yaVerificado, true);
  assert.equal(r.estado, 'activo');
  assert.ok(m.sinEscrituras());
});

test('AV8 · reintentar la finalización no duplica ni rompe nada', async () => {
  const m = pendiente();
  const primera = await finalizarActivacion(m.deps, sesion('uid_l'), {});
  const segunda = await finalizarActivacion(m.deps, sesion('uid_l'), {});
  const tercera = await finalizarActivacion(m.deps, sesion('uid_l'), {});
  assert.equal(primera.yaVerificado, false);
  assert.equal(segunda.yaVerificado, true);
  assert.equal(tercera.yaVerificado, true);
  assert.deepEqual(m.llamadas.verificar, ['uid_l'], 'se verificó una sola vez');
  assert.equal(m.auths.get('uid_l')!.emailVerified, true);
});

test('AV9 · Luigi reparado pero sin activar sigue "pendiente de activación", nunca activo', async () => {
  const m = luigi();
  await repararAcceso(m.deps, ADMIN, { motorizadoId: 'moto1' });
  const d = await diagnosticarAcceso(m.deps, GESTOR, { motorizadoId: 'moto1' });
  assert.equal(d.estado, 'pendiente_activacion');
  assert.equal(d.problemas.length, 0, 'ya no hay nada roto: solo falta activarlo');
  // Y reparar no verifica la cuenta.
  assert.equal(m.llamadas.verificar.length, 0);
  assert.equal(m.auths.get('uid_l')!.emailVerified, false);
});

test('AV10 · Luigi reparado + invitación + activación completada → acceso activo', async () => {
  const m = luigi();
  await repararAcceso(m.deps, ADMIN, { motorizadoId: 'moto1' });

  // Sin una invitación autorizada por un operador, no hay activación pendiente que cerrar.
  await assert.rejects(finalizarActivacion(m.deps, sesion('uid_l'), {}), codigo('failed-precondition'));
  assert.equal(m.auths.get('uid_l')!.emailVerified, false);

  // El envío de la invitación (ruta enviar-activacion) deja la evidencia: el correo de la cuenta.
  await m.deps.actualizarMotorizado('moto1', { accesoEmail: 'luigi@example.com' });
  const r = await finalizarActivacion(m.deps, sesion('uid_l'), {});
  assert.equal(r.estado, 'activo');
  assert.equal(m.auths.get('uid_l')!.emailVerified, true);
  assert.equal((await diagnosticarAcceso(m.deps, ADMIN, { motorizadoId: 'moto1' })).estado, 'activo');
});

test('AV11 · alta nueva de punta a punta: crear → definir contraseña → cerrar la activación → activo', async () => {
  const m = mundo({ motorizados: { moto1: { ...MOTO_LIMPIO } } });
  const alta = await crearAcceso(m.deps, GESTOR, { motorizadoId: 'moto1', email: 'luigi@example.com' });
  assert.equal(alta.estado, 'pendiente_activacion');

  // El motorizado abre el enlace, define su contraseña y se autentica con ella.
  const r = await finalizarActivacion(m.deps, sesion(alta.authUid), {});
  assert.equal(r.estado, 'activo');
  assert.equal(m.auths.get(alta.authUid)!.emailVerified, true);
  assert.equal(m.usuarios.get(alta.authUid)!.rol, 'motorizado');
  assert.equal(m.motorizados.get('moto1')!.authUid, alta.authUid);
});
