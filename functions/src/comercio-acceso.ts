// ═══════════════════════════════════════════════════════════════════════════
// crearAccesoComercio — Callable Cloud Function (Bloque B, identidad estable)
// ═══════════════════════════════════════════════════════════════════════════
//
// comercioId es PERMANENTE (asignado una sola vez en crearComercio(), ID del
// doc comercios/{comercioId}) y NUNCA cambia. Esta función solo vincula/
// desvincula un authUid de acceso — jamás toca el comercioId, ni migra, ni
// reescribe solicitudes/clientes/cobros/depósitos/ledger.
//
// ── Máquina de estados de comercios/{comercioId}.accesoEstado ──────────────
//   sin_acceso      → nunca se otorgó acceso.
//   provisionando   → hay una operación en curso (reserva activa). Reanudable.
//   activo          → authUid vinculado, cuenta Auth habilitada, perfil activo.
//   error_provision → un intento falló por algo que NO se arregla
//                     reintentando el mismo input (ej. cuenta incompatible).
//   desactivado     → acceso revocado sin reemplazo (esta función no lo
//                     produce — reservado para una futura acción dedicada).
//
// ── Principio de "nunca dos accesos utilizables a la vez" ──────────────────
// Se prefiere una ventana breve SIN acceso a una ventana con DOS accesos
// simultáneamente válidos. Por eso el nuevo Auth user siempre se prepara con
// disabled:true y usuarios.activo:false, y solo se habilita DESPUÉS de haber
// deshabilitado por completo el anterior (ver secuencia detallada abajo).
//
// ── Concurrencia ────────────────────────────────────────────────────────
// operacionId = hash determinístico de (comercioId, email normalizado,
// reemplazar) — SIEMPRE calculado server-side, nunca recibido del cliente.
// Dos llamadas con los mismos 3 valores producen el MISMO operacionId y se
// tratan como el mismo intento lógico (la segunda se une/reanuda). Una
// llamada con datos distintos mientras hay una reserva vigente (< 5 min) se
// rechaza con ABORTED.
//
// RACE en Firebase Auth (punto 1): aunque compartan operacionId, dos
// invocaciones pueden ejecutar getUserByEmail→no-existe casi al mismo tiempo
// y ambas intentar createUser. Como el operacionId es determinístico a
// partir de los mismos 3 valores, SI createUser falla con
// 'auth/email-already-exists' en este punto del código, la única explicación
// posible es que otra invocación de este MISMO operacionId (ya admitida por
// el join de la reserva en TX1) ganó la carrera — por eso es seguro
// recuperar esa cuenta con getUserByEmail y continuar con ella sin tratarla
// como cuenta ajena.
//
// ── Evidencia para adoptar cuentas Auth sin perfil (punto 4) ────────────────
// Una cuenta Auth encontrada por email que NO tiene usuarios/{authUid} NO se
// adopta automáticamente solo por no aparecer en motorizado/. Se adopta
// ÚNICAMENTE si:
//   - comercios/{comercioId}.authUid === esa cuenta Y emailAcceso coincide
//     (evidencia fuerte: es la cuenta que YA pertenece a este comercio), o
//   - comercios/{comercioId}.accesoProvisionAuthUid === esa cuenta (evidencia
//     de que ESTA MISMA operación la creó en un intento previo), o
//   - fue recién creada por esta invocación, o recuperada del race de arriba
//     (mismo operacionId, ver nota anterior).
// Si no hay ninguna de esas evidencias, se rechaza con failed-precondition
// para revisión manual — nunca se adopta un huérfano "porque no está en uso
// en otro lado".
//
// ── Secuencia sin dos accesos simultáneos (punto 2) ─────────────────────────
//  1. Resolver/crear el Auth user del nuevo acceso — SIEMPRE disabled:true.
//  2. Persistir accesoProvisionAuthUid (evidencia para reintentos).
//  3. Escribir/completar usuarios/{authUid} con activo:FALSE todavía.
//  4. Si es reemplazo: deshabilitar el Auth user anterior.
//  5. Marcar usuarios/{authUidAnterior}.activo = false.
//  6. Habilitar el nuevo Auth user (disabled:false).
//  7. Marcar usuarios/{authUid}.activo = true.
//  8. Finalizar: comercios/{comercioId}.accesoEstado = 'activo', limpiar
//     reserva, trazabilidad.
// Cada paso vuelve a comprobar el estado REAL (no confía en haber llegado
// hasta ahí sin errores) — ver tabla de reanudación en el código.
//
// ── Enlace de activación de contraseña (punto 6) ────────────────────────────
// Auditamos app/api/send-welcome/route.ts: HOY genera su PROPIO enlace con
// adminAuth.generatePasswordResetLink(email) y lo envía por Resend — pero no
// tiene NINGUNA autenticación/autorización (cualquiera puede invocarlo con
// cualquier email) y no acepta un enlace externo como parámetro (lo que le
// pasáramos sería ignorado). No lo llamamos desde esta función ni le
// delegamos nada — eso sería "implementar un envío inseguro para completar
// el flujo", exactamente lo que se pidió evitar. Mientras no exista un envío
// de correo seguro y auditado:
//   - en el emulador (FUNCTIONS_EMULATOR==='true'): se genera y se devuelve
//     enlaceActivacionDev, para poder probar el flujo sin correo real.
//   - fuera del emulador (se asume producción, fail-closed): NUNCA se genera
//     ni se devuelve ningún enlace — se devuelve advertenciaEnvioCorreo
//     estructurada avisando que el acceso quedó activo pero sin notificación
//     automática todavía.
//
// ── ⚠️ BLOQUEO OBLIGATORIO ANTES DE DEPLOY (pendiente de seguridad) ─────────
//   1. app/api/send-welcome/route.ts NO tiene autenticación ni autorización
//      — cualquiera puede invocarlo con cualquier email existente en Auth.
//   2. Esta Cloud Function todavía NO envía el enlace de activación en
//      producción (solo lo genera/devuelve en el emulador).
//   3. El acceso productivo NO se considera completo hasta que exista un
//      envío de correo server-side seguro y auditado para este flujo.
//   4. En producción, el enlace de activación NUNCA debe devolverse al
//      cliente bajo ninguna circunstancia.
// No desplegar este Bloque a producción hasta resolver los 4 puntos.
//
// ── Nombre autoritativo (ajuste posterior a la aprobación) ──────────────────
// displayName de Auth y usuarios/{authUid}.name se toman EXCLUSIVAMENTE de
// comercios/{comercioId}.name. No se acepta ningún "nombre" del cliente como
// entrada ni como fallback — si el comercio no tiene un name string no
// vacío, se rechaza con failed-precondition indicando que hay que corregir
// el registro del comercio primero (nunca se inventa ni se acepta un nombre
// de sesión del navegador para esta escritura).

import { onCall, HttpsError } from 'firebase-functions/v2/https';
import * as admin from 'firebase-admin';
import * as crypto from 'crypto';

interface CrearAccesoComercioData {
  comercioId?: string;
  email?: string;
  reemplazar?: boolean;
}

interface CrearAccesoComercioResultado {
  ok: true;
  comercioId: string;
  authUid: string;
  authUidAnterior: string | null;
  esNuevoAuthUser: boolean;
  esReemplazo: boolean;
  esIdempotente: boolean;
  recuperacionAdministrativa: boolean;
  mensaje: string;
  /** Solo en emulador — nunca en producción. Nunca se loguea. */
  enlaceActivacionDev?: string;
  /** Solo fuera del emulador, cuando no se pudo/debió enviar correo. */
  advertenciaEnvioCorreo?: string;
}

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const RESERVA_TIMEOUT_MS = 5 * 60 * 1000; // 5 minutos
const ROLES_PRIVILEGIADOS = ['admin', 'gestor', 'motorizado', 'cliente'];

function normalizarEmail(email: unknown): string {
  return typeof email === 'string' ? email.trim().toLowerCase() : '';
}

function calcularOperacionId(comercioId: string, email: string, reemplazar: boolean): string {
  return crypto.createHash('sha256').update(`${comercioId}:${email}:${reemplazar}`).digest('hex').slice(0, 24);
}

async function obtenerAuthUser(uid: string): Promise<admin.auth.UserRecord | null> {
  try {
    return await admin.auth().getUser(uid);
  } catch (err) {
    if ((err as { code?: string }).code === 'auth/user-not-found') return null;
    throw err;
  }
}

async function buscarAuthUserPorEmail(email: string): Promise<admin.auth.UserRecord | null> {
  try {
    return await admin.auth().getUserByEmail(email);
  } catch (err) {
    if ((err as { code?: string }).code === 'auth/user-not-found') return null;
    throw err;
  }
}

type ResultadoCompatibilidad =
  | { compatible: true }
  | { compatible: false; http: 'already-exists' | 'failed-precondition'; motivo: string };

/**
 * Tabla de reutilización — SOLO se aplica a cuentas Auth que SÍ tienen un
 * doc usuarios/{authUid} (las que no lo tienen se rigen por la regla de
 * evidencia del punto 4, no por esta tabla):
 *
 * | usuarios/{authUid}.rol                          | comercioId          | Resultado |
 * |--------------------------------------------------|---------------------|-----------|
 * | 'Comercio'                                        | ausente             | compatible |
 * | 'Comercio'                                        | === este comercioId | compatible |
 * | 'Comercio'                                        | !== este comercioId | rechazar (already-exists) |
 * | admin / gestor / motorizado / cliente / otro      | —                   | rechazar (failed-precondition) |
 * | (sin campo rol)                                   | —                   | rechazar (failed-precondition, no se asume default) |
 */
function evaluarCompatibilidad(usuario: FirebaseFirestore.DocumentData, comercioId: string): ResultadoCompatibilidad {
  const rol = usuario.rol;
  if (rol === undefined || ROLES_PRIVILEGIADOS.includes(rol)) {
    return {
      compatible: false,
      http: 'failed-precondition',
      motivo: `Ese correo ya tiene una cuenta con rol '${rol ?? 'sin rol definido'}' — no se puede convertir a Comercio.`,
    };
  }
  if (rol !== 'Comercio') {
    return { compatible: false, http: 'failed-precondition', motivo: `Rol desconocido ('${rol}') — se rechaza por seguridad.` };
  }
  if (usuario.comercioId && usuario.comercioId !== comercioId) {
    return { compatible: false, http: 'already-exists', motivo: 'Ese correo ya tiene un perfil vinculado a otro comercioId distinto.' };
  }
  return { compatible: true };
}

interface EstadoCuenta {
  usuario: FirebaseFirestore.DocumentData | undefined;
  auth: admin.auth.UserRecord | null;
}

async function leerEstadoCuenta(db: admin.firestore.Firestore, uid: string): Promise<EstadoCuenta> {
  const [usuarioSnap, authUser] = await Promise.all([db.collection('usuarios').doc(uid).get(), obtenerAuthUser(uid)]);
  return { usuario: usuarioSnap.exists ? usuarioSnap.data() : undefined, auth: authUser };
}

export const crearAccesoComercio = onCall<CrearAccesoComercioData>(async (request) => {
  const db = admin.firestore();
  const authAdmin = admin.auth();
  const esEmulador = process.env.FUNCTIONS_EMULATOR === 'true';

  // ── 1-2. Autenticado + rol real admin/gestor ────────────────────────────
  if (!request.auth) throw new HttpsError('unauthenticated', 'Debés iniciar sesión.');
  const operadorUid = request.auth.uid;

  const operadorSnap = await db.collection('usuarios').doc(operadorUid).get();
  const operador = operadorSnap.data();
  const rolOperador = operador?.rol;
  if (!operadorSnap.exists || operador?.activo !== true || (rolOperador !== 'admin' && rolOperador !== 'gestor')) {
    throw new HttpsError('permission-denied', 'Solo un gestor o admin activo puede otorgar acceso a un comercio.');
  }

  const data = request.data ?? {};
  const comercioId = typeof data.comercioId === 'string' ? data.comercioId.trim() : '';
  const reemplazar = data.reemplazar === true;
  const emailNormalizado = normalizarEmail(data.email);

  if (!comercioId) throw new HttpsError('invalid-argument', 'comercioId es obligatorio.');
  if (!emailNormalizado || !EMAIL_RE.test(emailNormalizado)) {
    throw new HttpsError('invalid-argument', 'email inválido.');
  }

  const comercioRef = db.collection('comercios').doc(comercioId);
  const comercioInicialSnap = await comercioRef.get();
  if (!comercioInicialSnap.exists) throw new HttpsError('not-found', `No existe comercios/${comercioId}.`);
  const comercioInicial = comercioInicialSnap.data()!;
  if (comercioInicial.eliminado === true) {
    throw new HttpsError('failed-precondition', 'El comercio está marcado como eliminado.');
  }

  // ── 5. Nombre autoritativo: EXCLUSIVAMENTE comercios/{comercioId}.name —
  //      nunca se acepta ni se usa ningún "nombre" recibido del cliente,
  //      ni siquiera como fallback. Si el registro del comercio no tiene un
  //      nombre válido, se rechaza y hay que corregir el comercio primero. ──
  const nombreAutoritativo = (comercioInicial.name as string | undefined)?.trim() ?? '';
  if (!nombreAutoritativo) {
    throw new HttpsError(
      'failed-precondition',
      `comercios/${comercioId} no tiene un nombre válido — corregí el registro del comercio antes de otorgar acceso.`,
    );
  }

  const operacionId = calcularOperacionId(comercioId, emailNormalizado, reemplazar);

  // ── 3. Idempotencia basada en estado SALUDABLE (no solo "estaba activo") ─
  // Todas las condiciones deben cumplirse; si falta una sola, NO es
  // idempotente — se cae al flujo de reparación/reanudación de abajo.
  if (comercioInicial.accesoEstado === 'activo' && comercioInicial.emailAcceso === emailNormalizado && comercioInicial.authUid) {
    const estado = await leerEstadoCuenta(db, comercioInicial.authUid);
    const saludable =
      !!estado.auth &&
      estado.auth.disabled === false &&
      !!estado.usuario &&
      estado.usuario.activo === true &&
      estado.usuario.rol === 'Comercio' &&
      estado.usuario.comercioId === comercioId;

    if (saludable) {
      return {
        ok: true,
        comercioId,
        authUid: comercioInicial.authUid,
        authUidAnterior: null,
        esNuevoAuthUser: false,
        esReemplazo: false,
        esIdempotente: true,
        recuperacionAdministrativa: false,
        mensaje: 'El comercio ya tenía este acceso activo y saludable — sin cambios.',
      } satisfies CrearAccesoComercioResultado;
    }
    // No saludable pese a mismo email → sigue de largo y se REPARA (no es
    // "otro acceso distinto", así que no exige reemplazar:true).
  }

  // ¿Hay un acceso activo con OTRO email? Ahí sí se exige reemplazar:true.
  const authUidAnterior: string | null =
    comercioInicial.accesoEstado === 'activo' && comercioInicial.authUid && comercioInicial.emailAcceso !== emailNormalizado
      ? comercioInicial.authUid
      : null;
  if (authUidAnterior && !reemplazar) {
    throw new HttpsError(
      'already-exists',
      'Este comercio ya tiene un acceso activo con otro correo. Pasá reemplazar:true para reemplazarlo explícitamente.',
    );
  }
  const esReemplazo = authUidAnterior !== null;

  // ── TX1: lock de concurrencia (reserva), con autoría (punto 7) ──────────
  const reserva = await db.runTransaction(async (tx) => {
    const snap = await tx.get(comercioRef);
    if (!snap.exists) throw new HttpsError('not-found', `comercios/${comercioId} desapareció.`);
    const c = snap.data()!;

    let recuperacionAdministrativa = false;
    if (c.accesoProvisionEstado === 'reservado') {
      if (c.accesoProvisionOperacionId === operacionId) {
        // Mismo intento lógico — nos unimos. Si el operador es distinto del
        // que la inició, queda registrado como recuperación administrativa.
        recuperacionAdministrativa = c.accesoProvisionIniciadoPorUid !== operadorUid;
        return { reanudando: true, recuperacionAdministrativa, accesoProvisionAuthUid: c.accesoProvisionAuthUid ?? null };
      }
      const iniciadoAtMs = (c.accesoProvisionIniciadoAt as admin.firestore.Timestamp | undefined)?.toMillis?.() ?? 0;
      if (Date.now() - iniciadoAtMs <= RESERVA_TIMEOUT_MS) {
        throw new HttpsError('aborted', 'Ya hay otra operación de acceso en curso para este comercio. Reintentá en unos minutos.');
      }
      console.warn(`crearAccesoComercio: reserva vencida reclamada para comercios/${comercioId}`);
    }

    tx.set(comercioRef, {
      accesoProvisionEstado: 'reservado',
      accesoProvisionOperacionId: operacionId,
      accesoProvisionEmail: emailNormalizado,
      accesoProvisionIniciadoAt: admin.firestore.FieldValue.serverTimestamp(),
      accesoProvisionIniciadoPorUid: operadorUid,
      accesoEstado: 'provisionando',
    }, { merge: true });

    return { reanudando: false, recuperacionAdministrativa: false, accesoProvisionAuthUid: null as string | null };
  });

  try {
    // ── Resolver qué authUid usar, con evidencia (punto 4) y manejo de
    //    carrera (punto 1) ────────────────────────────────────────────────
    let authUid: string;
    let esNuevoAuthUser = false;

    if (authUidAnterior === null && comercioInicial.authUid && comercioInicial.emailAcceso === emailNormalizado) {
      // No debería llegar aquí (ya habría vuelto por el atajo idempotente o
      // por reparación) salvo el caso "mismo email, pero authUid ya no
      // existe en Auth" — cubierto por el bloque de abajo igual.
      authUid = comercioInicial.authUid;
    } else if (reserva.accesoProvisionAuthUid && (await obtenerAuthUser(reserva.accesoProvisionAuthUid))?.email === emailNormalizado) {
      // Evidencia fuerte: esta MISMA operación ya resolvió/creó esta cuenta
      // en un intento previo.
      authUid = reserva.accesoProvisionAuthUid;
    } else {
      const existente = await buscarAuthUserPorEmail(emailNormalizado);
      if (existente) {
        const usuarioExistenteSnap = await db.collection('usuarios').doc(existente.uid).get();
        if (usuarioExistenteSnap.exists) {
          const compat = evaluarCompatibilidad(usuarioExistenteSnap.data()!, comercioId);
          if (!compat.compatible) throw new HttpsError(compat.http, compat.motivo);
        } else {
          // Punto 4: sin perfil y SIN evidencia de pertenecer a esta
          // operación (ya descartamos accesoProvisionAuthUid arriba) →
          // rechazar para revisión manual, no adoptar por descarte.
          throw new HttpsError(
            'failed-precondition',
            `Existe una cuenta de Auth con este correo (uid ${existente.uid}) sin perfil en usuarios/ y sin evidencia de pertenecer a esta operación. Requiere revisión manual antes de vincularla.`,
          );
        }
        authUid = existente.uid;
      } else {
        try {
          authUid = (await authAdmin.createUser({ email: emailNormalizado, displayName: nombreAutoritativo, disabled: true })).uid;
          esNuevoAuthUser = true;
        } catch (err) {
          if ((err as { code?: string }).code !== 'auth/email-already-exists') throw err;
          // Punto 1: carrera de creación — otra invocación del MISMO
          // operacionId (ya admitida por el join de la reserva de arriba)
          // ganó. Es seguro recuperarla y continuar, no es una cuenta ajena.
          const recuperada = await buscarAuthUserPorEmail(emailNormalizado);
          if (!recuperada) throw err; // no debería pasar — no ocultamos el error real
          authUid = recuperada.uid;
        }
      }
    }

    // Defensa adicional: ese authUid no debe estar en OTRO comercios/*.
    const otroComercio = await db.collection('comercios').where('authUid', '==', authUid).get();
    if (otroComercio.docs.some((d) => d.id !== comercioId)) {
      throw new HttpsError('already-exists', 'Ese correo ya está vinculado como acceso de OTRO comercio distinto.');
    }

    // ── Paso 2 de la secuencia: persistir evidencia para reintentos ────────
    if (reserva.accesoProvisionAuthUid !== authUid) {
      await comercioRef.set({ accesoProvisionAuthUid: authUid }, { merge: true });
    }

    // ── Paso 3: completar perfil TODAVÍA inactivo ──────────────────────────
    const usuarioNuevoSnap = await db.collection('usuarios').doc(authUid).get();
    const usuarioPayload: Record<string, unknown> = {
      uid: authUid,
      rol: 'Comercio',
      activo: false, // se activa recién en el paso 7, después de deshabilitar el anterior
      comercioId,
      email: emailNormalizado,
      name: nombreAutoritativo,
      updatedAt: admin.firestore.FieldValue.serverTimestamp(),
    };
    if (!usuarioNuevoSnap.exists) usuarioPayload.createdAt = admin.firestore.FieldValue.serverTimestamp();
    await db.collection('usuarios').doc(authUid).set(usuarioPayload, { merge: true });

    // ── Paso 4-5: deshabilitar el anterior POR COMPLETO antes de habilitar
    //    el nuevo — nunca al revés. ─────────────────────────────────────────
    if (esReemplazo && authUidAnterior && authUidAnterior !== authUid) {
      const anterior = await obtenerAuthUser(authUidAnterior);
      if (anterior && !anterior.disabled) {
        await authAdmin.updateUser(authUidAnterior, { disabled: true });
      }
      const usuarioAnteriorSnap = await db.collection('usuarios').doc(authUidAnterior).get();
      if (!usuarioAnteriorSnap.exists || usuarioAnteriorSnap.data()?.activo !== false) {
        await db.collection('usuarios').doc(authUidAnterior).set(
          { activo: false, updatedAt: admin.firestore.FieldValue.serverTimestamp() },
          { merge: true },
        );
      }
    }

    // ── Paso 6: habilitar el nuevo (recién ahora) ──────────────────────────
    const nuevoActual = await obtenerAuthUser(authUid);
    if (nuevoActual?.disabled) {
      await authAdmin.updateUser(authUid, { disabled: false });
    }

    // ── Paso 7: activar el perfil nuevo ─────────────────────────────────────
    await db.collection('usuarios').doc(authUid).set(
      { activo: true, updatedAt: admin.firestore.FieldValue.serverTimestamp() },
      { merge: true },
    );

    // ── Enlace de activación — solo emulador (punto 6) ─────────────────────
    let enlaceActivacionDev: string | undefined;
    let advertenciaEnvioCorreo: string | undefined;
    if (esEmulador) {
      try {
        enlaceActivacionDev = await authAdmin.generatePasswordResetLink(emailNormalizado);
      } catch (err) {
        console.warn('crearAccesoComercio: no se pudo generar el enlace en el emulador (no crítico):', (err as Error).message);
      }
    } else {
      advertenciaEnvioCorreo =
        'El acceso quedó activo, pero todavía no hay un envío de correo seguro conectado a este flujo. ' +
        'Notificá al comercio por otro medio para que establezca su contraseña (Restablecer contraseña ' +
        'desde la consola de Firebase Auth, o esperá a que se implemente el envío server-side).';
    }

    // ── Paso 8: finalizar — releer todo dentro de la transacción ───────────
    const { esPrimeraVez } = await db.runTransaction(async (tx) => {
      const cFinal = (await tx.get(comercioRef)).data();
      if (!cFinal) throw new HttpsError('not-found', `comercios/${comercioId} desapareció al finalizar.`);
      if (cFinal.accesoProvisionOperacionId !== operacionId) {
        throw new HttpsError('aborted', 'La reserva de esta operación ya no es válida al finalizar.');
      }
      const esPrimeraVez = !cFinal.accesoCreadoAt;

      const payload: Record<string, unknown> = {
        accesoEstado: 'activo',
        accesoActualizadoPorUid: operadorUid,
        accesoActualizadoAt: admin.firestore.FieldValue.serverTimestamp(),
        accesoProvisionEstado: admin.firestore.FieldValue.delete(),
        accesoProvisionOperacionId: admin.firestore.FieldValue.delete(),
        accesoProvisionEmail: admin.firestore.FieldValue.delete(),
        accesoProvisionIniciadoAt: admin.firestore.FieldValue.delete(),
        accesoProvisionIniciadoPorUid: admin.firestore.FieldValue.delete(),
        accesoProvisionAuthUid: admin.firestore.FieldValue.delete(),
      };
      if (esPrimeraVez) {
        payload.accesoCreadoPorUid = operadorUid;
        payload.accesoCreadoAt = admin.firestore.FieldValue.serverTimestamp();
      }
      if (esReemplazo) payload.accesoAnteriorUid = authUidAnterior;
      if (reserva.recuperacionAdministrativa) {
        payload.accesoRecuperadoPorUid = operadorUid;
        payload.accesoRecuperadoAt = admin.firestore.FieldValue.serverTimestamp();
      }

      tx.set(comercioRef, payload, { merge: true });
      return { esPrimeraVez };
    });

    return {
      ok: true,
      comercioId,
      authUid,
      authUidAnterior: esReemplazo ? authUidAnterior : null,
      esNuevoAuthUser,
      esReemplazo,
      esIdempotente: false,
      recuperacionAdministrativa: reserva.recuperacionAdministrativa,
      mensaje: esReemplazo
        ? 'Acceso reemplazado correctamente.'
        : esNuevoAuthUser
          ? 'Acceso creado correctamente.'
          : esPrimeraVez
            ? 'Acceso vinculado a una cuenta de Auth existente.'
            : 'Acceso reparado/reactivado.',
      ...(enlaceActivacionDev ? { enlaceActivacionDev } : {}),
      ...(advertenciaEnvioCorreo ? { advertenciaEnvioCorreo } : {}),
    } satisfies CrearAccesoComercioResultado;
  } catch (err) {
    // Solo limpiamos la reserva (error_provision) para errores de VALIDACIÓN
    // que no se arreglan reintentando el mismo input — un error transitorio
    // deja la reserva viva para que el reintento la retome.
    if (err instanceof HttpsError && err.code !== 'internal' && err.code !== 'unavailable' && err.code !== 'deadline-exceeded') {
      await comercioRef.set(
        {
          accesoEstado: 'error_provision',
          accesoProvisionEstado: admin.firestore.FieldValue.delete(),
          accesoProvisionOperacionId: admin.firestore.FieldValue.delete(),
          accesoProvisionEmail: admin.firestore.FieldValue.delete(),
          accesoProvisionIniciadoAt: admin.firestore.FieldValue.delete(),
          accesoProvisionIniciadoPorUid: admin.firestore.FieldValue.delete(),
          accesoProvisionAuthUid: admin.firestore.FieldValue.delete(),
        },
        { merge: true },
      ).catch(() => {});
    }
    throw err;
  }
});
