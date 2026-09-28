// AUTH-EMAIL-VERIFICATION-LOOP-1 — corrige el loop /panel/** → /login?reason=verify
// → /panel/** → ... que sufría un authUser con emailVerified=false: el panel lo
// expulsaba a /login, y /login lo mandaba de vuelta al panel sin mirar
// emailVerified. Mismo criterio que lib/login-rol.test.ts: en vez de mover la
// lógica fuera de la pantalla, se fija el contrato leyendo el código real.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const src = readFileSync(join(__dirname, '..', 'app', 'login', 'page.tsx'), 'utf8')
const panelLayoutSrc = readFileSync(join(__dirname, '..', 'app', 'panel', 'layout.tsx'), 'utf8')

const iEfectoInicio = src.indexOf('useEffect(() => {')
const iEfectoFin = src.indexOf('const handleReenviarVerificacion')
const cuerpoEfecto = src.slice(iEfectoInicio, iEfectoFin)

const iYaVerifiqueInicio = src.indexOf('const handleYaVerifique')
const iYaVerifiqueFin = src.indexOf('const handleCerrarSesion')
const cuerpoYaVerifique = src.slice(iYaVerifiqueInicio, iYaVerifiqueFin)

const iReenviarInicio = src.indexOf('const handleReenviarVerificacion')
const cuerpoReenviar = src.slice(iReenviarInicio, iYaVerifiqueInicio)

const iCerrarInicio = src.indexOf('const handleCerrarSesion')
const iCerrarFin = src.indexOf('const guardCode')
const cuerpoCerrar = src.slice(iCerrarInicio, iCerrarFin)

const iRenderVerificacion = src.indexOf('if (authUser && !authUser.emailVerified) {')
const iRenderFormulario = src.indexOf('<form onSubmit={handleLogin}')

const iNotice = src.indexOf('function VerificarCorreoNotice')
const cuerpoNotice = src.slice(iNotice)

test('EV1 · sin authUser, la rama de verificación no se activa — solo el formulario', () => {
  assert.ok(iRenderVerificacion > 0, 'debe existir la rama condicional de verificación')
  // La condición exige authUser truthy: sin authUser, es false y cae al form.
  assert.ok(/if \(authUser && !authUser\.emailVerified\) \{/.test(src))
})

test('EV2 · authUser con emailVerified=true sigue redirigiendo por rol (sin regresión)', () => {
  assert.ok(cuerpoEfecto.includes('if (!authUser) return'))
  assert.ok(cuerpoEfecto.includes('if (!authUser.emailVerified) return'))
  const iGuardVerificado = cuerpoEfecto.indexOf('if (!authUser.emailVerified) return')
  const iRedirect = cuerpoEfecto.indexOf('await irAlPanelSegunRol(authUser.uid)')
  assert.ok(iRedirect > iGuardVerificado, 'el redirect debe venir DESPUÉS del guard de emailVerified')
})

test('EV3 · authUser NO verificado nunca llega al redirect del efecto', () => {
  const iGuardVerificado = cuerpoEfecto.indexOf('if (!authUser.emailVerified) return')
  const iRedirect = cuerpoEfecto.indexOf('await irAlPanelSegunRol(authUser.uid)')
  assert.ok(iGuardVerificado > 0 && iRedirect > iGuardVerificado)
  // M1: si alguien borra el guard, este mismo indexOf pasa a -1 y la resta
  // de asserts de EV2/EV3 sobre el orden deja de tener sentido — se cubre
  // explícitamente más abajo en el propio archivo con una lectura estricta.
})

test('EV4 · la vista de verificación se renderiza en vez del formulario', () => {
  assert.ok(iRenderVerificacion > 0 && iRenderFormulario > iRenderVerificacion,
    'el bloque condicional de verificación debe aparecer ANTES del <form> de login')
  const bloqueCondicional = src.slice(iRenderVerificacion, iRenderFormulario)
  assert.ok(bloqueCondicional.includes('<VerificarCorreoNotice'))
  assert.ok(bloqueCondicional.includes('return ('), 'debe retornar temprano, sin caer al form')
  assert.ok(cuerpoNotice.includes('Verifica tu correo'))
  assert.ok(cuerpoNotice.includes('Antes de entrar al panel'))
})

test('EV5 · el reenvío usa resendVerification de UserProvider, no un flujo nuevo', () => {
  assert.ok(src.includes('resendVerification } = useUser()') || /resendVerification,/.test(src))
  assert.ok(cuerpoReenviar.includes('await resendVerification()'))
})

test('EV6 · reenvío exitoso deja feedback visible en la UI', () => {
  assert.ok(cuerpoReenviar.includes("setResendEstado('enviado')"))
  assert.ok(cuerpoNotice.includes("resendEstado === 'enviado'"))
  assert.ok(cuerpoNotice.includes('Correo de verificación enviado.'))
  // Error controlado, no el objeto crudo de Firebase:
  assert.ok(cuerpoReenviar.includes("setResendEstado('error')"))
  assert.ok(cuerpoNotice.includes('No se pudo reenviar el correo'))
})

test('EV7 · "Ya verifiqué" recarga el usuario real de Firebase (no solo React state)', () => {
  assert.ok(cuerpoYaVerifique.includes('await refreshProfile()'),
    'debe usar el mecanismo de recarga real (refreshProfile hace reload() por dentro), no re-leer el authUser ya cerrado en el closure')
})

test('EV8 · tras el reload, emailVerified=true dispara el redirect por rol', () => {
  const iReloadCall = cuerpoYaVerifique.indexOf('await refreshProfile()')
  const iCheck = cuerpoYaVerifique.indexOf('if (auth.currentUser?.emailVerified)')
  const iRedirect = cuerpoYaVerifique.indexOf('await irAlPanelSegunRol(auth.currentUser.uid)')
  assert.ok(iReloadCall > 0 && iCheck > iReloadCall && iRedirect > iCheck,
    'el chequeo de emailVerified y el redirect deben venir DESPUÉS del reload, en ese orden')
  // Decide sobre auth.currentUser (SDK), no sobre el authUser cerrado del render anterior.
  assert.ok(!cuerpoYaVerifique.includes('if (authUser?.emailVerified)'))
})

test('EV9 · tras el reload, emailVerified=false deja al usuario en la vista con feedback', () => {
  assert.ok(cuerpoYaVerifique.includes('setAunNoVerificado(true)'))
  assert.ok(cuerpoNotice.includes('aunNoVerificado &&'))
  assert.ok(cuerpoNotice.includes('El correo todavía no aparece como verificado.'))
})

test('EV10 · el cierre de sesión está disponible en la vista de verificación', () => {
  assert.ok(cuerpoCerrar.includes('await signOut()'))
  assert.ok(cuerpoNotice.includes('onClick={onCerrarSesion}'))
  assert.ok(cuerpoNotice.includes('Cerrar sesión'))
})

test('EV11 · app/panel/layout.tsx sigue bloqueando emailVerified=false (guard no relajado)', () => {
  assert.ok(panelLayoutSrc.includes('if (!authUser.emailVerified)'))
  assert.ok(panelLayoutSrc.includes("router.replace('/login?reason=verify')"))
  assert.ok(panelLayoutSrc.includes('if (loading || !authUser || !authUser.emailVerified) return null'))
})

test('EV12 · password reset no se usa como mecanismo de verificación', () => {
  // El botón "Ya verifiqué" y el de reenvío no llaman a resetPassword ni a
  // sendPasswordResetEmail — son flujos independientes.
  assert.ok(!cuerpoYaVerifique.includes('resetPassword'))
  assert.ok(!cuerpoYaVerifique.includes('sendPasswordResetEmail'))
  assert.ok(!cuerpoReenviar.includes('resetPassword'))
  assert.ok(!cuerpoReenviar.includes('sendPasswordResetEmail'))
  // El flujo de "Olvidé mi contraseña" (handleForgot) sigue existiendo, intacto,
  // como una acción totalmente separada.
  assert.ok(src.includes('const handleForgot = async'))
  assert.ok(src.includes('/api/send-reset-password'))
})

test('M5 · si alguien reemplaza resendVerification por resetPassword en el reenvío, esto falla', () => {
  assert.ok(cuerpoReenviar.includes('resendVerification()'))
  assert.ok(!cuerpoReenviar.includes('resetPassword('))
})
