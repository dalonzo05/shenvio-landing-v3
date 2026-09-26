// MOTO-ALTA-AUTH-ROL-1 — Qué pasa en /crear-password después de definir la
// contraseña, como decisión de negocio testeable.
//
// El enlace de esa página es un código de restablecimiento (PASSWORD_RESET):
// definir la contraseña con él NO garantiza, por lo que demuestra este repo, que
// la cuenta quede verificada. Así que después de definirla la página continúa
// sola: inicia sesión con la contraseña que el usuario acaba de elegir (eso
// prueba que controla la cuenta) y le pide al servidor que cierre su activación
// (finalizarActivacionMotorizado, sin payload: todo sale de su sesión). El
// gestor no hace ningún paso más y el usuario no necesita "Olvidé mi contraseña".
//
// La misma página la usan los comercios. Para ellos el cierre lo rechaza el
// servidor (no son motorizados); en ese caso se cierra la sesión que se abrió y el
// resultado es exactamente el de antes: contraseña creada, sin sesión iniciada.
// Ningún fallo posterior a definir la contraseña la deshace ni se muestra como un
// error de la contraseña.
//
// PURO: los efectos (Firebase Auth, callable) entran por `PuertosActivacion`.

export interface PuertosActivacion {
  /** Firebase: confirmPasswordReset. Si falla, la contraseña NO se definió. */
  confirmarPassword(oobCode: string, password: string): Promise<void>
  iniciarSesion(email: string, password: string): Promise<void>
  /** Callable finalizarActivacionMotorizado. Rechaza si la cuenta no es un motorizado con activación pendiente. */
  finalizarActivacion(): Promise<void>
  /** Recarga el usuario y su token para que el panel vea `emailVerified`. */
  refrescarSesion(): Promise<void>
  cerrarSesion(): Promise<void>
}

export type ResultadoActivacion =
  /** Contraseña definida y activación cerrada por el servidor: ya puede entrar. */
  | { tipo: 'activada' }
  /** Contraseña definida; no hubo cierre de activación (p. ej. un comercio). Sin sesión abierta. */
  | { tipo: 'solo_password' }

export interface EntradaActivacion {
  oobCode: string
  /** Correo de la cuenta, tal como lo devolvió la verificación del código. */
  email: string
  password: string
}

export async function completarActivacion(
  puertos: PuertosActivacion,
  entrada: EntradaActivacion,
): Promise<ResultadoActivacion> {
  // 1. La contraseña. Si esto falla, el error sube tal cual: no se hace nada más.
  await puertos.confirmarPassword(entrada.oobCode, entrada.password)

  if (!entrada.email.trim()) return { tipo: 'solo_password' }

  // 2. Sesión con la contraseña recién definida + cierre de la activación.
  try {
    await puertos.iniciarSesion(entrada.email, entrada.password)
    await puertos.finalizarActivacion()
  } catch {
    // No es motorizado, o no hay activación pendiente, o la red falló: la
    // contraseña ya quedó definida. Se deja todo como estaba, sin sesión abierta.
    try {
      await puertos.cerrarSesion()
    } catch {
      /* nada que hacer */
    }
    return { tipo: 'solo_password' }
  }

  // 3. La activación ya está cerrada en el servidor: que la recarga falle no la deshace.
  try {
    await puertos.refrescarSesion()
  } catch {
    /* el panel lo verá al recargar la sesión */
  }
  return { tipo: 'activada' }
}
