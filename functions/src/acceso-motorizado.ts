// MOTO-ALTA-AUTH-ROL-1 — Alta y reparación del ACCESO de un motorizado, del lado
// del servidor.
//
// El problema que cierra: `motorizado.authUid` NO equivale a poder entrar. El rol
// sale de `usuarios/{authUid}.rol` (login) y firestore.rules exige además
// `usuarios/{uid}.activo == true`. El alta vieja creaba el usuario de Auth desde
// el navegador con una contraseña que elegía el gestor, escribía el perfil desde
// el cliente y dejaba pegar un UID a mano: cualquier paso podía quedar a medias
// (caso Luigi: Auth y `motorizado.authUid` bien, `usuarios/{uid}` sin `rol` ni
// `activo`, y el login respondía "No tenés un rol asignado").
//
// Acá el servidor decide y escribe la identidad. Tres operaciones, todas puras
// sobre "puertos" inyectables (`AccesoDeps`) para probarlas sin emulador:
//
//   · crearAcceso        admin o gestor activo. Auth + perfil con rol + vínculo.
//                        Sin contraseña: el motorizado la define con el enlace de
//                        activación (mismo patrón que Comercio).
//   · repararAcceso      SOLO admin. Completa un acceso a medias cuando la cadena
//                        es inequívoca; jamás pisa un rol válido distinto.
//   · diagnosticarAcceso admin o gestor. Dice el estado REAL del acceso, una vez,
//                        al abrir el detalle (no una lectura a Auth por fila).
//
// ── emailVerified ──────────────────────────────────────────────────────────
// La Function NO lo marca. El patrón canónico (crearAccesoComercio) tampoco: la
// cuenta queda sin verificar y el enlace de activación (/crear-password →
// confirmPasswordReset) es lo que completa el onboarding. Hasta entonces el
// estado es `pendiente_activacion`; solo con `emailVerified === true` es `activo`.
// El endpoint viejo /api/motorizado/confirmar-acceso deja de ser parte del alta.
//
// ── Consistencia ───────────────────────────────────────────────────────────
// Auth y Firestore no comparten transacción. El alta es reanudable: primero se
// crea el usuario de Auth y se anota su UID en `motorizado.accesoProvisionAuthUid`
// (evidencia de que ESTA operación lo creó); recién después se escribe el perfil
// y el vínculo. Un reintento encuentra esa evidencia y continúa sin crear otro
// Auth. Nunca se borra una identidad de Auth automáticamente, y nunca se adopta
// una cuenta existente por el solo hecho de tener el mismo correo.
//
// No toca `estado`, `activo` ni nada operativo del motorizado.

import { HttpsError } from 'firebase-functions/v2/https';

// ─── Tipos ────────────────────────────────────────────────────────────────────

export interface UsuarioDoc {
  rol?: unknown;
  activo?: unknown;
  email?: unknown;
  name?: unknown;
  [campo: string]: unknown;
}

export interface MotorizadoDoc {
  nombre?: unknown;
  activo?: unknown;
  authUid?: unknown;
  accesoProvisionAuthUid?: unknown;
  [campo: string]: unknown;
}

export interface AuthLite {
  uid: string;
  email?: string | null;
  disabled: boolean;
  emailVerified: boolean;
}

/** Todo lo que estas operaciones necesitan del mundo exterior. */
export interface AccesoDeps {
  getUsuario(uid: string): Promise<UsuarioDoc | null>;
  getMotorizado(id: string): Promise<MotorizadoDoc | null>;
  /** IDs de los motorizados cuyo `authUid` es este. */
  motorizadosConAuthUid(uid: string): Promise<string[]>;
  getAuthPorUid(uid: string): Promise<AuthLite | null>;
  getAuthPorEmail(email: string): Promise<AuthLite | null>;
  /** Crea el usuario de Auth SIN contraseña. Lanza `{ code: 'auth/email-already-exists' }` si hay carrera. */
  crearAuth(email: string, displayName: string): Promise<AuthLite>;
  actualizarMotorizado(id: string, patch: Record<string, unknown>): Promise<void>;
  /** Escribe con merge. */
  escribirUsuario(uid: string, data: Record<string, unknown>): Promise<void>;
  /** Sello de tiempo de servidor. */
  ahora(): unknown;
  /** Marca de "borrar este campo". */
  borrarCampo(): unknown;
}

export type EstadoAcceso = 'sin_acceso' | 'pendiente_activacion' | 'activo' | 'incompleto';

export type ProblemaAcceso =
  | 'auth_inexistente'
  | 'auth_deshabilitado'
  | 'perfil_inexistente'
  | 'rol_ausente'
  | 'rol_mal_escrito'
  | 'rol_incompatible'
  | 'rol_desconocido'
  | 'perfil_inactivo'
  | 'email_incoherente'
  | 'uid_duplicado';

/** Lo único que la reparación sabe arreglar sin criterio humano. */
const PROBLEMAS_REPARABLES: readonly ProblemaAcceso[] = [
  'perfil_inexistente',
  'rol_ausente',
  'rol_mal_escrito',
  'perfil_inactivo',
];

const ROLES_DEL_SISTEMA = ['admin', 'gestor', 'Comercio', 'cliente', 'digitador'];
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

const texto = (v: unknown): string => (typeof v === 'string' ? v.trim() : '');
const normalizarEmail = (v: unknown): string => texto(v).toLowerCase();

// ─── Clasificación pura ───────────────────────────────────────────────────────

export interface HechosAcceso {
  /** `motorizado.activo !== false`. */
  motorizadoActivo: boolean;
  authUid: string | null;
  /** null si hay `authUid` pero no existe en Auth. */
  auth: AuthLite | null;
  usuario: UsuarioDoc | null;
  /** Cuántos OTROS motorizados apuntan al mismo UID. */
  duplicados: number;
}

export interface DiagnosticoAcceso {
  estado: EstadoAcceso;
  problemas: ProblemaAcceso[];
  /** ¿Puede `repararAcceso` dejarlo sano sin criterio humano? */
  reparable: boolean;
}

function problemaDeRol(rol: unknown): ProblemaAcceso | null {
  if (typeof rol !== 'string' || rol.trim() === '') return 'rol_ausente';
  if (rol === 'motorizado') return null;
  if (rol.trim().toLowerCase() === 'motorizado') return 'rol_mal_escrito';
  if (ROLES_DEL_SISTEMA.includes(rol)) return 'rol_incompatible';
  return 'rol_desconocido';
}

/**
 * Estado real del acceso, a partir de hechos ya leídos. `authUid` en el
 * motorizado no basta: hace falta Auth, perfil con rol y activo, y coherencia.
 */
export function clasificarAcceso(h: HechosAcceso): DiagnosticoAcceso {
  if (!h.authUid) return { estado: 'sin_acceso', problemas: [], reparable: false };

  const problemas: ProblemaAcceso[] = [];
  if (!h.auth) problemas.push('auth_inexistente');
  else if (h.auth.disabled) problemas.push('auth_deshabilitado');

  if (!h.usuario) {
    problemas.push('perfil_inexistente');
  } else {
    const deRol = problemaDeRol(h.usuario.rol);
    if (deRol) problemas.push(deRol);
    // firestore.rules: 'activo' ausente NO es activo. Un perfil con rol pero sin
    // activo entra al login y después no puede leer nada.
    if (h.motorizadoActivo && h.usuario.activo !== true) problemas.push('perfil_inactivo');
    const eu = normalizarEmail(h.usuario.email);
    const ea = normalizarEmail(h.auth?.email);
    if (eu && ea && eu !== ea) problemas.push('email_incoherente');
  }
  if (h.duplicados > 0) problemas.push('uid_duplicado');

  if (problemas.length > 0) {
    return { estado: 'incompleto', problemas, reparable: problemas.every((p) => PROBLEMAS_REPARABLES.includes(p)) };
  }
  return { estado: h.auth!.emailVerified ? 'activo' : 'pendiente_activacion', problemas: [], reparable: false };
}

// ─── Lectura de hechos ────────────────────────────────────────────────────────

async function leerHechos(deps: AccesoDeps, motorizadoId: string, motorizado: MotorizadoDoc): Promise<HechosAcceso> {
  const authUid = texto(motorizado.authUid) || null;
  if (!authUid) {
    return { motorizadoActivo: motorizado.activo !== false, authUid: null, auth: null, usuario: null, duplicados: 0 };
  }
  const [auth, usuario, con] = await Promise.all([
    deps.getAuthPorUid(authUid),
    deps.getUsuario(authUid),
    deps.motorizadosConAuthUid(authUid),
  ]);
  return {
    motorizadoActivo: motorizado.activo !== false,
    authUid,
    auth,
    usuario,
    duplicados: con.filter((id) => id !== motorizadoId).length,
  };
}

// ─── Validaciones comunes ─────────────────────────────────────────────────────

export interface Operador {
  existe: boolean;
  activo: unknown;
  rol: unknown;
}

async function operadorDe(deps: AccesoDeps, uid: string): Promise<Operador> {
  const u = await deps.getUsuario(uid);
  return { existe: u !== null, activo: u?.activo, rol: u?.rol };
}

function exigirOperador(op: Operador, roles: readonly string[], mensaje: string): void {
  if (!op.existe || op.activo !== true || typeof op.rol !== 'string' || !roles.includes(op.rol)) {
    throw new HttpsError('permission-denied', mensaje);
  }
}

/** El payload trae EXACTAMENTE estas claves: nada de rol, uid, contraseña, activo ni emailVerified. */
function exigirPayload(data: unknown, permitidas: readonly string[]): Record<string, unknown> {
  if (typeof data !== 'object' || data === null || Array.isArray(data)) {
    throw new HttpsError('invalid-argument', 'Payload inválido.');
  }
  const claves = Object.keys(data);
  if (claves.length !== permitidas.length || !permitidas.every((c) => claves.includes(c))) {
    throw new HttpsError('invalid-argument', `Solo se aceptan los campos: ${permitidas.join(', ')}.`);
  }
  return data as Record<string, unknown>;
}

function leerMotorizadoId(payload: Record<string, unknown>): string {
  const id = texto(payload.motorizadoId);
  if (!id || id.length > 200) throw new HttpsError('invalid-argument', 'motorizadoId inválido.');
  return id;
}

async function exigirMotorizado(deps: AccesoDeps, id: string): Promise<MotorizadoDoc> {
  const m = await deps.getMotorizado(id);
  if (!m) throw new HttpsError('not-found', `No existe motorizado/${id}.`);
  return m;
}

const MENSAJE_PROBLEMA: Record<ProblemaAcceso, string> = {
  auth_inexistente: 'La cuenta de acceso ya no existe en Firebase Auth.',
  auth_deshabilitado: 'La cuenta de acceso está deshabilitada en Firebase Auth.',
  perfil_inexistente: 'Falta el perfil de usuario.',
  rol_ausente: 'El perfil no tiene rol.',
  rol_mal_escrito: 'El rol del perfil está mal escrito.',
  rol_incompatible: 'El perfil de ese UID tiene otro rol del sistema.',
  rol_desconocido: 'El perfil tiene un rol que el sistema no reconoce.',
  perfil_inactivo: 'El perfil no está activo.',
  email_incoherente: 'El correo del perfil no coincide con el de la cuenta de acceso.',
  uid_duplicado: 'Otro motorizado usa la misma cuenta de acceso.',
};

// ─── crearAcceso ──────────────────────────────────────────────────────────────

export interface ResultadoCrearAcceso {
  ok: true;
  motorizadoId: string;
  authUid: string;
  estado: EstadoAcceso;
  esNuevoAuthUser: boolean;
  esIdempotente: boolean;
  mensaje: string;
}

export async function crearAcceso(
  deps: AccesoDeps,
  operadorUid: string,
  data: unknown,
): Promise<ResultadoCrearAcceso> {
  exigirOperador(await operadorDe(deps, operadorUid), ['admin', 'gestor'], 'Solo un gestor o admin activo puede crear acceso a un motorizado.');

  const payload = exigirPayload(data, ['motorizadoId', 'email']);
  const motorizadoId = leerMotorizadoId(payload);
  const email = normalizarEmail(payload.email);
  if (!email || !EMAIL_RE.test(email)) throw new HttpsError('invalid-argument', 'email inválido.');

  const motorizado = await exigirMotorizado(deps, motorizadoId);
  const nombre = texto(motorizado.nombre);
  if (!nombre) {
    throw new HttpsError('failed-precondition', `motorizado/${motorizadoId} no tiene un nombre válido: corregí el registro antes de crear el acceso.`);
  }
  const motorizadoActivo = motorizado.activo !== false;

  // ── Ya tiene un vínculo: solo es idempotente si está sano ────────────────
  if (texto(motorizado.authUid)) {
    const hechos = await leerHechos(deps, motorizadoId, motorizado);
    const dx = clasificarAcceso(hechos);
    if (dx.estado === 'incompleto') {
      throw new HttpsError(
        'failed-precondition',
        `El motorizado tiene un acceso incompleto (${dx.problemas.map((p) => MENSAJE_PROBLEMA[p]).join(' ')}). Un admin debe repararlo; no se crea otro.`,
      );
    }
    if (normalizarEmail(hechos.auth?.email) !== email) {
      throw new HttpsError('failed-precondition', 'El motorizado ya tiene acceso con otro correo.');
    }
    return {
      ok: true,
      motorizadoId,
      authUid: hechos.authUid!,
      estado: dx.estado,
      esNuevoAuthUser: false,
      esIdempotente: true,
      mensaje: dx.estado === 'activo' ? 'El motorizado ya tiene acceso activo.' : 'El acceso ya estaba creado y espera la activación del motorizado.',
    };
  }

  // ── Resolver el usuario de Auth ──────────────────────────────────────────
  let auth: AuthLite | null = null;
  let esNuevoAuthUser = false;

  const provision = texto(motorizado.accesoProvisionAuthUid);
  if (provision) {
    // Evidencia de que ESTA operación ya creó la cuenta en un intento anterior.
    const previa = await deps.getAuthPorUid(provision);
    if (previa) {
      if (normalizarEmail(previa.email) !== email) {
        throw new HttpsError('failed-precondition', 'Hay una activación pendiente con otro correo para este motorizado.');
      }
      auth = previa;
    }
  }

  if (!auth) {
    const existente = await deps.getAuthPorEmail(email);
    if (existente) {
      // Sin evidencia de pertenencia no se adopta: una cuenta ajena o un perfil
      // sin rol se resuelven con criterio humano (reparación), no acá.
      throw new HttpsError('already-exists', 'Ese correo ya pertenece a otra cuenta. Un admin debe revisarla antes de vincularla.');
    }
    try {
      auth = await deps.crearAuth(email, nombre);
    } catch (e) {
      if ((e as { code?: string }).code === 'auth/email-already-exists') {
        throw new HttpsError('already-exists', 'Ese correo ya pertenece a otra cuenta. Un admin debe revisarla antes de vincularla.');
      }
      throw e;
    }
    esNuevoAuthUser = true;
    // Primero la evidencia, antes de cualquier otra escritura: si algo falla
    // después, el reintento sabe que esta cuenta es de esta operación.
    await deps.actualizarMotorizado(motorizadoId, { accesoProvisionAuthUid: auth.uid, accesoEmail: email });
  }
  const uid = auth.uid;

  // ── Conflictos antes de escribir el perfil ───────────────────────────────
  const otros = (await deps.motorizadosConAuthUid(uid)).filter((id) => id !== motorizadoId);
  if (otros.length > 0) {
    throw new HttpsError('failed-precondition', 'Otro motorizado ya usa esa cuenta de acceso.');
  }
  const perfil = await deps.getUsuario(uid);
  if (perfil) {
    const p = problemaDeRol(perfil.rol);
    if (p === 'rol_incompatible' || p === 'rol_desconocido') {
      throw new HttpsError('failed-precondition', 'Esa cuenta ya tiene otro rol en el sistema; no se convierte en motorizado.');
    }
  }

  // ── Perfil con rol + vínculo ─────────────────────────────────────────────
  const ahora = deps.ahora();
  await deps.escribirUsuario(uid, {
    name: nombre,
    email,
    rol: 'motorizado',
    activo: motorizadoActivo,
    creadoPorGestor: true,
    creadoPorUid: operadorUid,
    updatedAt: ahora,
    ...(perfil ? {} : { createdAt: ahora }),
  });
  await deps.actualizarMotorizado(motorizadoId, {
    authUid: uid,
    accesoEmail: email,
    accesoProvisionAuthUid: deps.borrarCampo(),
  });

  const dx = clasificarAcceso(await leerHechos(deps, motorizadoId, { ...motorizado, authUid: uid }));
  return {
    ok: true,
    motorizadoId,
    authUid: uid,
    estado: dx.estado,
    esNuevoAuthUser,
    esIdempotente: false,
    mensaje: 'Acceso creado. El motorizado debe activar su cuenta con el enlace de activación.',
  };
}

// ─── repararAcceso ────────────────────────────────────────────────────────────

export interface ResultadoRepararAcceso {
  ok: true;
  motorizadoId: string;
  authUid: string;
  yaReparado: boolean;
  estado: EstadoAcceso;
  mensaje: string;
}

export async function repararAcceso(
  deps: AccesoDeps,
  operadorUid: string,
  data: unknown,
): Promise<ResultadoRepararAcceso> {
  // ADMIN ONLY: reparar toca identidad y rol; un gestor solo crea altas normales.
  exigirOperador(await operadorDe(deps, operadorUid), ['admin'], 'Solo un admin activo puede reparar el acceso de un motorizado.');

  const payload = exigirPayload(data, ['motorizadoId']);
  const motorizadoId = leerMotorizadoId(payload);
  const motorizado = await exigirMotorizado(deps, motorizadoId);

  const hechos = await leerHechos(deps, motorizadoId, motorizado);
  if (!hechos.authUid) {
    throw new HttpsError('failed-precondition', 'El motorizado no tiene una cuenta vinculada: usá "Crear acceso".');
  }
  const uid = hechos.authUid;
  const dx = clasificarAcceso(hechos);

  if (dx.estado !== 'incompleto') {
    return {
      ok: true,
      motorizadoId,
      authUid: uid,
      yaReparado: true,
      estado: dx.estado,
      mensaje: 'El acceso ya estaba correcto: no hubo nada que reparar.',
    };
  }
  if (!dx.reparable) {
    const causa = dx.problemas.filter((p) => !PROBLEMAS_REPARABLES.includes(p)).map((p) => MENSAJE_PROBLEMA[p]).join(' ');
    throw new HttpsError('failed-precondition', `No se puede reparar automáticamente: ${causa}`);
  }

  // Cadena inequívoca: el motorizado apunta a ese UID, la cuenta existe y está
  // habilitada, nadie más la usa, el correo es coherente y el perfil no tiene un
  // rol válido distinto. Solo entonces se completa lo que falta.
  const auth = hechos.auth!;
  const usuario = hechos.usuario;
  const ahora = deps.ahora();
  const emailAuth = normalizarEmail(auth.email);

  const parche: Record<string, unknown> = {
    rol: 'motorizado',
    activo: hechos.motorizadoActivo,
    updatedAt: ahora,
    reparadoPorUid: operadorUid,
    reparadoAt: ahora,
  };
  if (!texto(usuario?.name)) parche.name = texto(motorizado.nombre);
  if (!normalizarEmail(usuario?.email) && emailAuth) parche.email = emailAuth;
  if (!usuario) {
    parche.createdAt = ahora;
    parche.creadoPorGestor = true;
    parche.creadoPorUid = operadorUid;
  }
  await deps.escribirUsuario(uid, parche);

  const despues = clasificarAcceso(await leerHechos(deps, motorizadoId, motorizado));
  return {
    ok: true,
    motorizadoId,
    authUid: uid,
    yaReparado: false,
    estado: despues.estado,
    mensaje:
      despues.estado === 'activo'
        ? 'Acceso reparado: el motorizado ya puede iniciar sesión.'
        : 'Acceso reparado. Falta que el motorizado complete la activación con el enlace de invitación.',
  };
}

// ─── diagnosticarAcceso ───────────────────────────────────────────────────────

export interface ResultadoDiagnostico extends DiagnosticoAcceso {
  ok: true;
  motorizadoId: string;
  authUid: string | null;
  /** Correo de la cuenta de acceso, si existe. */
  emailAcceso: string | null;
  /** Mensajes legibles, uno por problema. */
  detalle: string[];
}

export async function diagnosticarAcceso(
  deps: AccesoDeps,
  operadorUid: string,
  data: unknown,
): Promise<ResultadoDiagnostico> {
  exigirOperador(await operadorDe(deps, operadorUid), ['admin', 'gestor'], 'Solo un gestor o admin activo puede consultar el acceso de un motorizado.');

  const payload = exigirPayload(data, ['motorizadoId']);
  const motorizadoId = leerMotorizadoId(payload);
  const motorizado = await exigirMotorizado(deps, motorizadoId);

  const hechos = await leerHechos(deps, motorizadoId, motorizado);
  const dx = clasificarAcceso(hechos);
  return {
    ok: true,
    motorizadoId,
    authUid: hechos.authUid,
    emailAcceso: hechos.auth?.email ?? null,
    ...dx,
    detalle: dx.problemas.map((p) => MENSAJE_PROBLEMA[p]),
  };
}
