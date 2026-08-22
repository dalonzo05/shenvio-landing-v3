// B2.2 — Suite focal de lib/actor-resolucion.ts
//
// Lo que importa acá es el fallback: nunca inventar un nombre, y nunca dejar
// al operador sin ningún identificador.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { presentarActor, nombreDeUsuario, NOMBRE_ACTOR_DESCONOCIDO } from './actor-resolucion'

const UID = 'RKTw1pLfK5O8Y3A6IIwDU8J3yr43'

test('A1 · con nombre, el nombre va al frente y el uid se conserva', () => {
  const a = presentarActor(UID, 'Admin Staging')!
  assert.equal(a.nombre, 'Admin Staging')
  assert.equal(a.uid, UID)
  assert.equal(a.tieneNombre, true)
})

test('A2 · sin nombre: "Usuario interno", nunca un nombre inventado', () => {
  const a = presentarActor(UID, undefined)!
  assert.equal(a.nombre, NOMBRE_ACTOR_DESCONOCIDO)
  assert.equal(a.tieneNombre, false)
  // El UID sigue disponible: es lo único identificable que hay.
  assert.equal(a.uid, UID)
})

test('A3 · nombre vacío o solo espacios cuenta como ausente', () => {
  assert.equal(presentarActor(UID, '')!.nombre, NOMBRE_ACTOR_DESCONOCIDO)
  assert.equal(presentarActor(UID, '   ')!.nombre, NOMBRE_ACTOR_DESCONOCIDO)
  assert.equal(presentarActor(UID, null)!.tieneNombre, false)
})

test('A4 · el nombre se muestra sin espacios sobrantes', () => {
  assert.equal(presentarActor(UID, '  David Alonzo  ')!.nombre, 'David Alonzo')
})

test('A5 · sin uid no hay actor que mostrar', () => {
  assert.equal(presentarActor(null, 'X'), null)
  assert.equal(presentarActor(undefined, 'X'), null)
  assert.equal(presentarActor('', 'X'), null)
  assert.equal(presentarActor('   ', 'X'), null)
})

// ── nombreDeUsuario ─────────────────────────────────────────────────────────

test('B1 · prefiere name, que es lo que traen los documentos reales', () => {
  assert.equal(nombreDeUsuario({ name: 'Admin Staging' }), 'Admin Staging')
})

test('B2 · cae a nombre cuando no hay name', () => {
  assert.equal(nombreDeUsuario({ nombre: 'Gestor Uno' }), 'Gestor Uno')
})

test('B3 · name gana sobre nombre si están los dos', () => {
  assert.equal(nombreDeUsuario({ name: 'A', nombre: 'B' }), 'A')
})

test('B4 · sin nada legible devuelve cadena vacía, no un uid', () => {
  assert.equal(nombreDeUsuario({}), '')
  assert.equal(nombreDeUsuario(null), '')
  assert.equal(nombreDeUsuario(undefined), '')
  assert.equal(nombreDeUsuario({ name: '   ' }), '')
  // Un valor no-string no se cuela como nombre.
  assert.equal(nombreDeUsuario({ name: 123 as unknown as string }), '')
})
