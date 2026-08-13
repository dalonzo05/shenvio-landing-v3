// lib/email-safety.ts
//
// RESEND STAGING SAFETY V1 — bloqueo fail-closed de envíos reales de email
// en staging hasta que exista una allowlist explícita de destinatarios de
// prueba. local/Emulator y production NO cambian de comportamiento: la
// única rama nueva es exclusiva de appEnv === 'staging' — ver lib/env.ts
// para la identidad de ambiente (misma fuente que usa el resto del repo,
// no se duplica lógica de detección de ambiente acá).
//
// STAGING_EMAIL_ALLOWLIST es server-only (nunca NEXT_PUBLIC_*, no debe
// viajar al bundle del navegador) — lista de direcciones EXACTAS separadas
// por coma. Ausente o vacía = bloquear TODO envío real en staging — nunca
// un fallback permisivo. Sin wildcards, sin dominios completos: un email
// solo pasa si coincide carácter por carácter (normalizado) con una
// entrada de la lista.

import { getAppEnv } from '@/lib/env'

/**
 * Parsea y normaliza STAGING_EMAIL_ALLOWLIST: separa por coma, recorta
 * espacios, pasa a minúsculas, descarta entradas vacías y duplicados.
 * Pura — no lee process.env por su cuenta, así se puede probar con
 * cualquier string sin depender del entorno real.
 */
export function parseStagingEmailAllowlist(raw: string | undefined): string[] {
  if (!raw) return []
  const normalizados = new Set<string>()
  for (const entrada of raw.split(',')) {
    const limpio = entrada.trim().toLowerCase()
    if (limpio.length > 0) normalizados.add(limpio)
  }
  return [...normalizados]
}

/**
 * true SOLO si `email` (normalizado) coincide EXACTAMENTE con una entrada
 * de `allowlist` (ya normalizada por parseStagingEmailAllowlist). Nunca
 * wildcard, nunca coincidencia de dominio — una entrada como
 * '*@example.com' o '@example.com' nunca hace match porque se compara
 * como string literal completo, no como patrón.
 */
export function isEmailAllowedInStaging(email: string, allowlist: string[]): boolean {
  const normalizado = email.trim().toLowerCase()
  if (normalizado.length === 0) return false
  return allowlist.includes(normalizado)
}

/**
 * Único punto de decisión que los call sites de Resend deben consultar
 * ANTES de construir cualquier request real de envío. Fail-closed:
 *
 *   - appEnv !== 'staging' (local o production) → SIEMPRE false, cero
 *     cambio de comportamiento — el gate existente en cada ruta
 *     (emulatorActivo) sigue siendo el único que aplica ahí.
 *   - appEnv === 'staging' → bloquea (true) salvo que el destinatario
 *     esté exactamente en STAGING_EMAIL_ALLOWLIST. Variable ausente o
 *     vacía = lista vacía = bloquea todo.
 *
 * Loguea un evento genérico SOLO cuando efectivamente bloquea un envío —
 * nunca incluye el email ni ningún otro dato personal.
 */
export function isStagingSendBlocked(email: string): boolean {
  if (getAppEnv() !== 'staging') return false

  const allowlist = parseStagingEmailAllowlist(process.env.STAGING_EMAIL_ALLOWLIST)
  const permitido = isEmailAllowedInStaging(email, allowlist)

  if (!permitido) {
    console.warn('[email-safety] staging send blocked')
  }

  return !permitido
}
