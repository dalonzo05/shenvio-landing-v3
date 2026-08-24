// B2.5 — Suite focal de lib/ruta-orden.ts

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { rutaOrden, BASE_ORDEN, type AnchorOrden } from './ruta-orden'

const ID = 'k5Ve09HMvKYJxwgw8ba3'

// ── N1 ──────────────────────────────────────────────────────────────────────
test('N1 · ID normal sin anchor apunta a la ficha', () => {
  assert.equal(rutaOrden(ID), `/panel/gestor/solicitudes/${ID}`)
  assert.equal(rutaOrden(ID)!.includes('#'), false)
})

// ── N2-N5 ───────────────────────────────────────────────────────────────────
test('N2 · #cobros', () => {
  assert.equal(rutaOrden(ID, 'cobros'), `/panel/gestor/solicitudes/${ID}#cobros`)
})

test('N3 · #incidencia', () => {
  assert.equal(rutaOrden(ID, 'incidencia'), `/panel/gestor/solicitudes/${ID}#incidencia`)
})

test('N4 · #depositos', () => {
  assert.equal(rutaOrden(ID, 'depositos'), `/panel/gestor/solicitudes/${ID}#depositos`)
})

test('N5 · #historial', () => {
  assert.equal(rutaOrden(ID, 'historial'), `/panel/gestor/solicitudes/${ID}#historial`)
})

// ── N6 ──────────────────────────────────────────────────────────────────────
test('N6 · sin ID devuelve null, nunca una ruta al listado', () => {
  for (const malo of [null, undefined, '', '   ', 123 as unknown as string]) {
    assert.equal(rutaOrden(malo), null)
    assert.equal(rutaOrden(malo, 'cobros'), null)
  }
  // El fallo importa: `/panel/gestor/solicitudes/` abriría el listado
  // haciendo creer que se abrió la orden.
  assert.notEqual(rutaOrden(''), `${BASE_ORDEN}/`)
})

// ── N7 ──────────────────────────────────────────────────────────────────────
test('N7 · el ID se encodea y no puede romper la ruta', () => {
  assert.equal(rutaOrden('a/b'), '/panel/gestor/solicitudes/a%2Fb')
  assert.equal(rutaOrden('a b'), '/panel/gestor/solicitudes/a%20b')
  assert.equal(rutaOrden('a#b'), '/panel/gestor/solicitudes/a%23b')
  assert.equal(rutaOrden('a?b=1'), '/panel/gestor/solicitudes/a%3Fb%3D1')
  // Un `#` dentro del ID no puede fabricar un anchor falso.
  assert.equal(rutaOrden('a#cobros')!.split('#').length, 1)
})

test('N7b · espacios sobrantes no llegan a la URL', () => {
  assert.equal(rutaOrden(`  ${ID}  `), `/panel/gestor/solicitudes/${ID}`)
})

// ── N8 ──────────────────────────────────────────────────────────────────────
test('N8 · solo los cuatro anchors que la ficha define', () => {
  const validos: AnchorOrden[] = ['cobros', 'incidencia', 'depositos', 'historial']
  for (const a of validos) assert.ok(rutaOrden(ID, a)!.endsWith(`#${a}`))
  // Uno inventado se ignora: mejor la ficha completa que un ancla muerta.
  assert.equal(rutaOrden(ID, 'evidencias' as AnchorOrden), `/panel/gestor/solicitudes/${ID}`)
  assert.equal(rutaOrden(ID, '' as AnchorOrden), `/panel/gestor/solicitudes/${ID}`)
})

// ── N9 ──────────────────────────────────────────────────────────────────────
test('N9 · nunca hay más de un hash', () => {
  for (const a of ['cobros', 'incidencia', 'depositos', 'historial'] as AnchorOrden[]) {
    assert.equal(rutaOrden(ID, a)!.split('#').length, 2)
  }
  assert.equal(rutaOrden('a#b', 'cobros')!.split('#').length, 2)
})

// ── N10 ─────────────────────────────────────────────────────────────────────
test('N10 · la ruta es estable y arranca en la base autoritativa', () => {
  assert.equal(BASE_ORDEN, '/panel/gestor/solicitudes')
  assert.equal(rutaOrden(ID), rutaOrden(ID))
  assert.equal(rutaOrden(ID, 'depositos'), rutaOrden(ID, 'depositos'))
  for (const a of [undefined, 'cobros', 'historial'] as const) {
    assert.ok(rutaOrden(ID, a)!.startsWith(`${BASE_ORDEN}/`))
  }
  // No se inventan rutas paralelas.
  assert.equal(rutaOrden(ID)!.includes('/detalle'), false)
  assert.equal(rutaOrden(ID)!.includes('/ordenes/'), false)
})
