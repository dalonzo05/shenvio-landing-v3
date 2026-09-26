// MOTO-ALTA-AUTH-ROL-1 — fija el contrato del login sin reescribirlo.
//
// El síntoma de Luigi ("No tenés un rol asignado") sale de getRedirectByRole en
// app/login/page.tsx, que es una función interna de una pantalla. En vez de
// moverla, se comprueba sobre la fuente real que el contrato sigue siendo el
// mismo: el rol sale de usuarios/{uid}.rol, `motorizado` lleva al panel del
// motorizado, y un perfil sin rol termina en el mensaje de siempre.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const src = readFileSync(join(__dirname, '..', 'app', 'login', 'page.tsx'), 'utf8')
const cuerpo = src.slice(src.indexOf('async function getRedirectByRole'), src.indexOf('function LoginContent'))

test('LG1 · el rol sale de usuarios/{uid}.rol', () => {
  assert.ok(cuerpo.includes("doc(db, 'usuarios', uid)"))
  assert.ok(cuerpo.includes('data?.rol'))
})

test('LG2 · rol "motorizado" (exacto, minúsculas) resuelve al panel del motorizado', () => {
  assert.ok(/rol === 'motorizado'\) return '\/panel\/motorizado'/.test(cuerpo))
})

test('LG3 · los demás roles conocidos siguen resolviendo a su panel', () => {
  assert.ok(/rol === 'admin' \|\| rol === 'gestor'\) return '\/panel\/gestor'/.test(cuerpo))
  assert.ok(/rol === 'Comercio'\) return '\/panel\/comercio'/.test(cuerpo))
  assert.ok(/rol === 'digitador'\) return '\/panel\/digitador'/.test(cuerpo))
})

test('LG4 · un perfil sin rol (o con un rol desconocido) termina en el mensaje actual', () => {
  const iUltimoRol = cuerpo.lastIndexOf("rol === 'digitador'")
  const iMensaje = cuerpo.indexOf("throw new Error('No tenés un rol asignado. Contacta al administrador.')")
  assert.ok(iMensaje > iUltimoRol, 'el mensaje es lo último: solo se llega ahí si ningún rol coincidió')
})

test('LG5 · sin perfil, o con el perfil inactivo, los mensajes son otros y salen antes que el del rol', () => {
  const iSinPerfil = cuerpo.indexOf('No tenés acceso al sistema')
  const iInactivo = cuerpo.indexOf('Tu usuario está inactivo')
  const iSinRol = cuerpo.indexOf('No tenés un rol asignado')
  assert.ok(iSinPerfil > 0 && iInactivo > iSinPerfil && iSinRol > iInactivo)
  assert.ok(cuerpo.includes('data?.activo === false'))
})
