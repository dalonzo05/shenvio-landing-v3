import { initializeApp, getApps } from 'firebase/app'
import { getAuth, connectAuthEmulator, createUserWithEmailAndPassword, type Auth } from 'firebase/auth'
import { activeConfig, usandoEmulator, AUTH_EMULATOR_URL, EMULATOR_PROJECT_ID } from './config'

// Nombre estable (no `secondary-${Date.now()}`) para poder reutilizar la
// misma app secundaria entre llamadas y sobrevivir a Fast Refresh sin
// reinicializarla ni reconectarla al Emulator más de una vez.
const SECONDARY_APP_NAME = 'shenvio-secondary-auth'

function obtenerAuthSecundario(): Auth {
  const app = getApps().find((a) => a.name === SECONDARY_APP_NAME) ?? initializeApp(activeConfig, SECONDARY_APP_NAME)

  if (!usandoEmulator) {
    // Producción: misma app, misma config real, sin tocar connectAuthEmulator.
    return getAuth(app)
  }

  // Fail-closed: si la señal central dice "Emulator", la app secundaria
  // DEBE apuntar al proyecto demo. Si por cualquier motivo no es así (ej.
  // quedó una instancia de una corrida anterior con otra config), abortamos
  // ANTES de crear ningún usuario — nunca seguimos "por si acaso" contra
  // producción.
  if (app.options.projectId !== EMULATOR_PROJECT_ID) {
    throw new Error(
      `[createAuthUser] usandoEmulator=true pero la app secundaria tiene projectId='${app.options.projectId}' ` +
      `(se esperaba '${EMULATOR_PROJECT_ID}'). Abortado por seguridad: no se crea ningún usuario de Auth.`,
    )
  }

  const secondaryAuth = getAuth(app)

  // Guard con globalThis: mismo patrón que fb/config.ts para la app
  // principal — evita el error "already connected to emulator" si este
  // módulo se re-ejecuta por Fast Refresh, y evita conectar dos veces la
  // misma instancia de Auth.
  const g = globalThis as typeof globalThis & { __shenvioSecondaryAuthEmulatorConnected?: boolean }
  if (!g.__shenvioSecondaryAuthEmulatorConnected) {
    g.__shenvioSecondaryAuthEmulatorConnected = true
    connectAuthEmulator(secondaryAuth, AUTH_EMULATOR_URL, { disableWarnings: true })
  }

  return secondaryAuth
}

/**
 * Crea un usuario de Firebase Auth sin afectar la sesión principal (`auth`
 * de fb/config.ts) — usa una app secundaria dedicada, reutilizada entre
 * llamadas, que respeta la misma señal de Emulator que el resto de la app.
 * En modo Emulator, nunca puede terminar creando un usuario real: el guard
 * fail-closed de arriba aborta antes de intentarlo si algo no cuadra.
 */
export async function createAuthUser(email: string, password: string): Promise<string> {
  const secondaryAuth = obtenerAuthSecundario()
  const { user } = await createUserWithEmailAndPassword(secondaryAuth, email, password)
  return user.uid
}
