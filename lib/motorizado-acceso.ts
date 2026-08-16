// MOTORIZADO EMAIL VERIFIED V1
//
// Lógica de decisión PURA (sin I/O, sin Admin SDK) para el endpoint
// app/api/motorizado/confirmar-acceso/route.ts. Separada a propósito para
// poder probarla sin Admin SDK/emulador — mismo criterio que ya se usó para
// validar lib/permissions.ts en RBAC INTERNO V1 (compilación standalone).
//
// Causa raíz que este módulo resuelve (ver auditoría previa, MOTORIZADO
// EMAIL VERIFICATION — CAUSA CONFIRMADA): el alta de Motorizado se hace con
// el SDK cliente (createUserWithEmailAndPassword vía fb/createAuthUser.ts),
// que nunca puede dejar emailVerified=true. El guard global de
// app/panel/layout.tsx exige emailVerified=true para TODOS los roles por
// igual — no se toca ese guard ni se le agrega una excepción. En su lugar,
// un operador admin/gestor YA autorizado (verificado server-side, nunca
// confiado del cliente) confirma el acceso que él mismo otorgó, y recién
// entonces el backend marca emailVerified=true vía Admin SDK.
//
// Cadena de evidencia obligatoria (nunca se acepta un authUid directo del
// cliente): motorizadoId (input) → motorizado/{motorizadoId}.authUid (nunca
// del request) → usuarios/{authUid} debe existir con rol==='motorizado' y
// activo===true → Firebase Auth user debe existir → email de Firestore y de
// Auth deben ser coherentes cuando ambos estén presentes.

export type OperadorInput = {
  existe: boolean
  activo: boolean
  rol: string | undefined
}

/**
 * Único criterio de "operador autorizado" para este flujo: activo===true y
 * rol admin o gestor. No acepta rol/actorUid del cliente — el llamador debe
 * haber resuelto `existe`/`activo`/`rol` leyendo usuarios/{uid} server-side
 * con el uid que salió de adminAuth.verifyIdToken, nunca del body.
 */
export function operadorAutorizado(op: OperadorInput): boolean {
  return op.existe && op.activo === true && (op.rol === 'admin' || op.rol === 'gestor')
}

export type MotivoRechazo =
  | 'motorizado_no_encontrado'
  | 'authUid_invalido'
  | 'usuario_no_encontrado'
  | 'usuario_no_valido'
  | 'auth_user_no_encontrado'
  | 'email_incoherente'

export type DecisionAcceso =
  | { tipo: 'rechazar'; motivo: MotivoRechazo }
  | { tipo: 'confirmar'; yaVerificado: boolean }

export type MotorizadoTargetInput = {
  motorizadoExiste: boolean
  /** Tal cual viene de motorizado/{motorizadoId}.authUid — NUNCA del request. */
  authUidMotorizado: unknown
  usuarioExiste: boolean
  usuarioActivo: unknown
  usuarioRol: unknown
  usuarioEmail: unknown
  authUserExiste: boolean
  authUserEmail: string | null | undefined
  authUserEmailVerified: boolean | undefined
}

/**
 * Evalúa la cadena de evidencia completa y decide si corresponde confirmar
 * (marcar emailVerified=true) o rechazar — y con qué motivo interno (solo
 * para logs server-side; el endpoint nunca expone `motivo` al cliente).
 * Fail-closed en cada paso: cualquier eslabón faltante o inconsistente
 * rechaza, nunca "sigue de largo" con un valor por defecto.
 */
export function evaluarConfirmacionMotorizado(input: MotorizadoTargetInput): DecisionAcceso {
  if (!input.motorizadoExiste) return { tipo: 'rechazar', motivo: 'motorizado_no_encontrado' }

  const authUid = typeof input.authUidMotorizado === 'string' ? input.authUidMotorizado.trim() : ''
  if (!authUid) return { tipo: 'rechazar', motivo: 'authUid_invalido' }

  if (!input.usuarioExiste) return { tipo: 'rechazar', motivo: 'usuario_no_encontrado' }
  if (input.usuarioActivo !== true || input.usuarioRol !== 'motorizado') {
    return { tipo: 'rechazar', motivo: 'usuario_no_valido' }
  }

  if (!input.authUserExiste) return { tipo: 'rechazar', motivo: 'auth_user_no_encontrado' }

  // Coherencia de email: solo rechaza si AMBAS fuentes tienen un valor y
  // difieren — un email ausente en una de las dos no es por sí solo un
  // motivo de rechazo (ya se validó rol/activo/existencia arriba).
  const emailFirestore = typeof input.usuarioEmail === 'string' ? input.usuarioEmail.trim().toLowerCase() : ''
  const emailAuth = (input.authUserEmail ?? '').trim().toLowerCase()
  if (emailFirestore && emailAuth && emailFirestore !== emailAuth) {
    return { tipo: 'rechazar', motivo: 'email_incoherente' }
  }

  return { tipo: 'confirmar', yaVerificado: input.authUserEmailVerified === true }
}
