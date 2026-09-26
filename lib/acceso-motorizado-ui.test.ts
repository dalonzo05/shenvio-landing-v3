// MOTO-ALTA-AUTH-ROL-1 — suite de la vista del acceso del motorizado.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { estadoSinConsultar, vistaAcceso } from './acceso-motorizado-ui'

test('MUI1 · sin authUid la pantalla dice "Sin acceso" sin consultar nada', () => {
  for (const authUid of [undefined, null, '', '   ']) {
    assert.equal(estadoSinConsultar(authUid), 'sin_acceso', String(authUid))
  }
  const v = vistaAcceso('sin_acceso', 'gestor')
  assert.equal(v.etiqueta, 'Sin acceso')
  assert.equal(v.puedeCrear, true)
  assert.equal(v.mostrarUid, false)
  // Con un authUid no se supone nada: hay que preguntarle al servidor.
  assert.equal(estadoSinConsultar('uid_l'), null)
})

test('MUI2 · la cadena sana es "Acceso activo" y no ofrece acciones', () => {
  const v = vistaAcceso('activo', 'admin')
  assert.equal(v.etiqueta, 'Acceso activo')
  assert.equal(v.tono, 'verde')
  assert.equal(v.puedeCrear, false)
  assert.equal(v.puedeEnviarInvitacion, false)
  assert.equal(v.puedeReparar, false)
})

test('MUI3 · authUid con el perfil roto es "Acceso incompleto", nunca "con acceso"', () => {
  const v = vistaAcceso('incompleto', 'gestor', { reparable: true })
  assert.equal(v.etiqueta, 'Acceso incompleto')
  assert.equal(v.tono, 'rojo')
  assert.ok(!/con acceso|activo/i.test(v.etiqueta))
  assert.equal(v.puedeCrear, false, 'no se crea otro acceso encima de uno roto')
})

test('MUI4 · el onboarding sin completar es "Pendiente de activación" y permite reenviar la invitación', () => {
  const v = vistaAcceso('pendiente_activacion', 'gestor')
  assert.equal(v.etiqueta, 'Pendiente de activación')
  assert.equal(v.puedeEnviarInvitacion, true)
  assert.equal(v.puedeReparar, false)
  assert.equal(v.mostrarUid, true)
})

test('MUI5 · el gestor NO ve el control de reparación, aunque el acceso sea reparable', () => {
  const v = vistaAcceso('incompleto', 'gestor', { reparable: true })
  assert.equal(v.puedeReparar, false)
  assert.ok(/admin/i.test(v.explicacion), 'le dice que un admin debe revisarlo')
  for (const rol of ['motorizado', 'digitador', 'Comercio', 'cliente', null, undefined, '']) {
    assert.equal(vistaAcceso('incompleto', rol, { reparable: true }).puedeReparar, false, String(rol))
    assert.equal(vistaAcceso('sin_acceso', rol).puedeCrear, false, String(rol))
    assert.equal(vistaAcceso('pendiente_activacion', rol).puedeEnviarInvitacion, false, String(rol))
  }
})

test('MUI6 · el admin sí ve "Reparar acceso", pero solo si el servidor dice que es reparable', () => {
  assert.equal(vistaAcceso('incompleto', 'admin', { reparable: true }).puedeReparar, true)
  assert.equal(vistaAcceso('incompleto', 'admin', { reparable: false }).puedeReparar, false)
  assert.equal(vistaAcceso('incompleto', 'admin').puedeReparar, false)
  // Y reparar solo existe con el acceso incompleto.
  for (const estado of ['sin_acceso', 'pendiente_activacion', 'activo'] as const) {
    assert.equal(vistaAcceso(estado, 'admin', { reparable: true }).puedeReparar, false, estado)
  }
})

test('MUI7 · el alta nueva no pide contraseña en ningún estado', () => {
  for (const estado of ['sin_acceso', 'pendiente_activacion', 'activo', 'incompleto', null] as const) {
    for (const rol of ['admin', 'gestor']) {
      assert.equal(vistaAcceso(estado, rol, { reparable: true }).pideContrasena, false, `${estado}/${rol}`)
    }
  }
  // Se comprueba también sobre la fuente real del panel: ya no hay campo de contraseña.
  const src = readFileSync(join(__dirname, '..', 'app', 'panel', 'gestor', 'motorizados', 'page.tsx'), 'utf8')
  assert.ok(!src.includes('caPassword'), 'el panel todavía pide una contraseña')
  assert.ok(!src.includes('createAuthUser'), 'el panel todavía crea usuarios de Auth desde el navegador')
  assert.ok(!src.includes("type=\"password\""), 'hay un campo de contraseña en el panel')
})

test('MUI8 · el UID no es editable libremente: ni en la vista ni en el formulario', () => {
  for (const estado of ['sin_acceso', 'pendiente_activacion', 'activo', 'incompleto'] as const) {
    assert.equal(vistaAcceso(estado, 'admin', { reparable: true }).uidEditable, false, estado)
  }
  const src = readFileSync(join(__dirname, '..', 'app', 'panel', 'gestor', 'motorizados', 'page.tsx'), 'utf8')
  assert.ok(!src.includes('setEAuthUid'), 'el UID sigue teniendo un estado editable')
  assert.ok(!src.includes('UID de Firebase Auth'), 'sigue el campo de texto libre para pegar un UID')
  // Ningún guardado del panel escribe authUid: solo lo escribe el servidor.
  assert.ok(!/authUid:\s*eAuthUid/.test(src))
})

test('MUI9 · mientras no se sabe el estado, no se afirma nada ni se ofrece ninguna acción', () => {
  for (const estado of [null, undefined]) {
    const v = vistaAcceso(estado, 'admin', { reparable: true })
    assert.equal(v.etiqueta, 'Verificando acceso…')
    assert.equal(v.puedeCrear || v.puedeEnviarInvitacion || v.puedeReparar, false)
  }
})
