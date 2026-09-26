// MOTO-ALTA-AUTH-ROL-1 — decisión de /crear-password: contraseña usable +
// activación cerrada, sin pasos manuales.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { completarActivacion, type PuertosActivacion } from './activacion-password'

const ENTRADA = { oobCode: 'codigo123', email: 'luigi@example.com', password: 'Nueva#Clave1' }

/** Puertos que registran el orden de las llamadas y pueden fallar a pedido. */
function puertos(fallos: Partial<Record<keyof PuertosActivacion, string>> = {}) {
  const llamadas: string[] = []
  const paso = (nombre: keyof PuertosActivacion) => async () => {
    llamadas.push(nombre)
    if (fallos[nombre]) throw new Error(fallos[nombre])
  }
  const p: PuertosActivacion = {
    confirmarPassword: async (codigo, pw) => {
      llamadas.push('confirmarPassword')
      assert.equal(codigo, ENTRADA.oobCode)
      assert.equal(pw, ENTRADA.password)
      if (fallos.confirmarPassword) throw new Error(fallos.confirmarPassword)
    },
    iniciarSesion: async (email, pw) => {
      llamadas.push('iniciarSesion')
      assert.equal(email, ENTRADA.email)
      assert.equal(pw, ENTRADA.password, 'inicia sesión con la contraseña que acaba de definir')
      if (fallos.iniciarSesion) throw new Error(fallos.iniciarSesion)
    },
    finalizarActivacion: paso('finalizarActivacion'),
    refrescarSesion: paso('refrescarSesion'),
    cerrarSesion: paso('cerrarSesion'),
  }
  return { p, llamadas }
}

test('AVP1 · motorizado: define la contraseña, inicia sesión y el servidor cierra la activación, en ese orden', async () => {
  const { p, llamadas } = puertos()
  const r = await completarActivacion(p, ENTRADA)
  assert.deepEqual(r, { tipo: 'activada' })
  assert.deepEqual(llamadas, ['confirmarPassword', 'iniciarSesion', 'finalizarActivacion', 'refrescarSesion'])
  assert.ok(!llamadas.includes('cerrarSesion'), 'la sesión queda abierta para entrar al panel')
})

test('AVP2 · si la contraseña no se pudo definir, el error sube y no se hace nada más', async () => {
  const { p, llamadas } = puertos({ confirmarPassword: 'auth/expired-action-code' })
  await assert.rejects(completarActivacion(p, ENTRADA), /expired-action-code/)
  assert.deepEqual(llamadas, ['confirmarPassword'], 'ni sesión ni activación sin contraseña')
})

test('AVP3 · un comercio (el servidor rechaza el cierre): contraseña creada y SIN sesión, como antes', async () => {
  const { p, llamadas } = puertos({ finalizarActivacion: 'permission-denied' })
  const r = await completarActivacion(p, ENTRADA)
  assert.deepEqual(r, { tipo: 'solo_password' })
  assert.deepEqual(llamadas, ['confirmarPassword', 'iniciarSesion', 'finalizarActivacion', 'cerrarSesion'])
  assert.ok(!llamadas.includes('refrescarSesion'))
})

test('AVP4 · si no se puede iniciar sesión, la contraseña igual quedó definida y no se intenta activar', async () => {
  const { p, llamadas } = puertos({ iniciarSesion: 'auth/network-request-failed' })
  const r = await completarActivacion(p, ENTRADA)
  assert.deepEqual(r, { tipo: 'solo_password' })
  assert.ok(!llamadas.includes('finalizarActivacion'), 'sin sesión no hay activación')
  assert.equal(llamadas[0], 'confirmarPassword')
})

test('AVP5 · un fallo al cerrar sesión no rompe el resultado', async () => {
  const { p } = puertos({ finalizarActivacion: 'x', cerrarSesion: 'y' })
  assert.deepEqual(await completarActivacion(p, ENTRADA), { tipo: 'solo_password' })
})

test('AVP6 · si la recarga de la sesión falla después de activar, la activación sigue en pie', async () => {
  const { p, llamadas } = puertos({ refrescarSesion: 'boom' })
  const r = await completarActivacion(p, ENTRADA)
  assert.deepEqual(r, { tipo: 'activada' })
  assert.ok(!llamadas.includes('cerrarSesion'))
})

test('AVP7 · sin correo no se intenta iniciar sesión, pero la contraseña queda definida', async () => {
  const { p, llamadas } = puertos()
  const r = await completarActivacion(p, { ...ENTRADA, email: '  ' })
  assert.deepEqual(r, { tipo: 'solo_password' })
  assert.deepEqual(llamadas, ['confirmarPassword'])
})

test('AVP8 · la página real usa este flujo y la callable no recibe datos', () => {
  // La página sigue siendo la misma para comercios: el cierre lo decide el servidor.
  const src = readFileSync(join(__dirname, '..', 'app', 'crear-password', 'page.tsx'), 'utf8')
  assert.ok(src.includes('completarActivacion('), 'la página no usa el orquestador')
  // La callable se invoca SIN datos: el servidor no acepta uid, verified ni nada parecido.
  assert.ok(src.includes("httpsCallable(functions, 'finalizarActivacionMotorizado')()"), 'la callable debe llamarse sin payload')
  assert.ok(!src.includes('emailVerified'), 'el cliente no marca ni envía emailVerified')
  // El correo sale de la verificación del código, no de un campo del formulario.
  assert.ok(/verifyPasswordResetCode\(auth, oobCode\)\s*\.then\(\(correo\) =>/.test(src))
  // El código de restablecimiento sigue verificándose antes de mostrar el formulario.
  assert.ok(src.includes('verifyPasswordResetCode(auth, oobCode)'))
})
