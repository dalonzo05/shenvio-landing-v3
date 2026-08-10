// lib/env.ts
//
// ENVIRONMENT ISOLATION V1 — identidad única de ambiente + guards
// fail-closed. Fuente única de verdad para "¿en qué ambiente estoy?" y
// para decidir si una combinación (appEnv, useEmulator, projectId,
// storageBucket, appUrl) es segura antes de inicializar cualquier cosa.
//
// Diseño deliberado de UNA sola variable de identidad de ambiente
// (NEXT_PUBLIC_APP_ENV), no dos (server APP_ENV + client
// NEXT_PUBLIC_APP_ENV): con dos variables existe el riesgo real de que
// diverjan (ej. alguien setea una y olvida la otra) y el código termine
// leyendo señales distintas en server vs. cliente. NEXT_PUBLIC_APP_ENV ya
// es legible en ambos lados en Next.js, así que una sola variable cubre
// los dos casos sin duplicar semántica.
//
// Este módulo es puro (sin side effects más allá de leer process.env) e
// intencionalmente client-safe: no importa nada server-only, así que
// fb/config.ts (bundle de cliente) puede importarlo sin arrastrar
// secretos al bundle. Las funciones que SÍ validan datos server-only
// (fb/admin.ts) le pasan esos valores como argumento — este módulo nunca
// los lee de process.env por su cuenta.

export type AppEnv = 'local' | 'staging' | 'production'

const VALID_APP_ENVS: readonly AppEnv[] = ['local', 'staging', 'production']

/**
 * Identidad de ambiente. Fail-closed: valor ausente o desconocido lanza,
 * nunca cae a un default silencioso (ej. asumir 'production' o 'local').
 */
export function getAppEnv(): AppEnv {
  const raw = process.env.NEXT_PUBLIC_APP_ENV
  if ((VALID_APP_ENVS as readonly string[]).includes(raw ?? '')) {
    return raw as AppEnv
  }
  throw new Error(
    `[env] NEXT_PUBLIC_APP_ENV inválido o ausente: '${raw ?? '(vacío)'}'. ` +
      `Debe ser exactamente uno de: ${VALID_APP_ENVS.join(', ')}. ` +
      `Fail-closed: no existe default — ver .env.example.`,
  )
}

export function isEmulatorMode(): boolean {
  return process.env.NEXT_PUBLIC_USE_EMULATOR === 'true'
}

// ── Guards de identidad Firebase ────────────────────────────────────────
//
// Constantes usadas EXCLUSIVAMENTE para comparar contra la configuración
// activa y rechazarla si no corresponde a su ambiente — nunca como
// configuración runtime real. `PRODUCTION_PROJECT_ID` en particular es un
// guard de seguridad, no una fuente de config: production igual debe leer
// su projectId real de sus propias variables de entorno/credencial.
export const PRODUCTION_PROJECT_ID = 'storkhub-9f719'
export const LOCAL_EMULATOR_PROJECT_ID = 'demo-storkhub'

export interface FirebaseIdentity {
  projectId: string
  storageBucket: string
}

export type EnvValidationResult = { ok: true } | { ok: false; reason: string }

/**
 * Guard central fail-closed: única fuente de verdad sobre qué combinación
 * de (appEnv, useEmulator, projectId, storageBucket) es válida. Pura —
 * sin conexión real a nada — para poder probarse de forma aislada (ver
 * matriz C1-C8) y para que fb/config.ts (cliente) y fb/admin.ts (server)
 * compartan exactamente la misma lógica en vez de reimplementarla cada
 * uno por su lado.
 */
export function validateFirebaseIdentity(
  appEnv: AppEnv,
  useEmulator: boolean,
  identity: FirebaseIdentity,
): EnvValidationResult {
  if (!identity.projectId) return { ok: false, reason: 'projectId ausente' }
  if (!identity.storageBucket) return { ok: false, reason: 'storageBucket ausente' }

  if (appEnv === 'local') {
    if (!useEmulator) {
      return { ok: false, reason: "appEnv='local' requiere NEXT_PUBLIC_USE_EMULATOR=true — nunca Firebase real" }
    }
    if (identity.projectId === PRODUCTION_PROJECT_ID) {
      return { ok: false, reason: 'local+Emulator no puede apuntar al Firebase project de producción' }
    }
    return { ok: true }
  }

  // staging / production: nunca Emulator.
  if (useEmulator) {
    return { ok: false, reason: `appEnv='${appEnv}' no puede tener NEXT_PUBLIC_USE_EMULATOR=true` }
  }
  if (identity.projectId === LOCAL_EMULATOR_PROJECT_ID) {
    return { ok: false, reason: `appEnv='${appEnv}' no puede apuntar a '${LOCAL_EMULATOR_PROJECT_ID}'` }
  }
  if (appEnv === 'staging' && identity.projectId === PRODUCTION_PROJECT_ID) {
    return { ok: false, reason: "appEnv='staging' no puede apuntar al Firebase project de producción conocido" }
  }
  if (appEnv === 'production' && identity.projectId !== PRODUCTION_PROJECT_ID) {
    return { ok: false, reason: "appEnv='production' debe apuntar exactamente al Firebase project de producción conocido" }
  }

  return { ok: true }
}

/** Envoltorio que lanza — para el código de inicialización real (nunca en tests). */
export function assertFirebaseIdentity(appEnv: AppEnv, useEmulator: boolean, identity: FirebaseIdentity): void {
  const result = validateFirebaseIdentity(appEnv, useEmulator, identity)
  if (!result.ok) {
    throw new Error(`[env] Configuración Firebase rechazada (fail-closed): ${result.reason}`)
  }
}

// ── APP URL ──────────────────────────────────────────────────────────────

// Guard, no config runtime: se usa solo para que staging no pueda quedar
// apuntando silenciosamente al dominio real de producción.
const KNOWN_PRODUCTION_APP_URL = 'https://shenvios.com'

export function validateAppUrl(appEnv: AppEnv, url: string | undefined): EnvValidationResult {
  if (appEnv === 'local') return { ok: true } // local puede caer a localhost, ver getAppUrl()
  if (!url || url.length === 0) {
    return { ok: false, reason: `NEXT_PUBLIC_APP_URL ausente con appEnv='${appEnv}' — sin fallback a producción` }
  }
  if (appEnv === 'staging' && url === KNOWN_PRODUCTION_APP_URL) {
    return { ok: false, reason: "appEnv='staging' no puede usar la APP URL de producción conocida" }
  }
  return { ok: true }
}

/**
 * APP URL explícita por ambiente. Reemplaza el fallback histórico
 * `?? 'https://shenvios.com'` que existía en cada call site — ese
 * fallback significaba que un staging o incluso un build local sin la
 * variable seteada podía enviar links de verdad apuntando a producción.
 * Fail-closed fuera de local: si falta en staging/production, lanza en
 * vez de adivinar.
 */
export function getAppUrl(): string {
  const raw = process.env.NEXT_PUBLIC_APP_URL
  const appEnv = getAppEnv()
  const result = validateAppUrl(appEnv, raw)
  if (!result.ok) {
    throw new Error(`[env] APP URL rechazada (fail-closed): ${result.reason}`)
  }
  if (raw && raw.length > 0) return raw
  // Solo llega acá si appEnv === 'local' y no hay variable seteada.
  return 'http://localhost:3000'
}
