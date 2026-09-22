// B2.2 — Suite focal de lib/actor-resolucion.ts
//
// Lo que importa acá es el fallback: nunca inventar un nombre, y nunca dejar
// al operador sin ningún identificador.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  presentarActor,
  nombreDeUsuario,
  NOMBRE_ACTOR_DESCONOCIDO,
  uidsPorResolver,
  resolverNombresActores,
  type DatosUsuario,
} from './actor-resolucion'

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

// ─── AR · resolver nombres por UID, contando lecturas ────────────────────────
//
// DRAWER-CONTEXTUAL-1 · ACTOR — la unidad de lectura es el UID DISTINTO no
// cacheado. El lector se inyecta, así que acá se cuenta cuántas veces se leyó
// y con qué UIDs: es exactamente lo que el drawer no puede demostrar solo.

const UID_2 = 'juAOhfxi96dlLv8LV3mZwA3cK362'
const lector = (datos: Record<string, DatosUsuario>, fallan: string[] = []) => {
  const pedidos: string[] = []
  const leer = async (uid: string): Promise<DatosUsuario> => {
    pedidos.push(uid)
    if (fallan.includes(uid)) throw new Error('permission-denied')
    return datos[uid] ?? null
  }
  return { pedidos, leer }
}

test('AR1 · dos depósitos con el mismo confirmador: UNA sola lectura', async () => {
  const cache = new Map<string, string>()
  const { pedidos, leer } = lector({ [UID]: { name: 'Admin Staging' } })
  const res = await resolverNombresActores([UID, UID, UID], cache, leer)
  assert.deepEqual(pedidos, [UID])
  assert.deepEqual(res, { [UID]: 'Admin Staging' })
  assert.equal(cache.get(UID), 'Admin Staging')
})

test('AR2 · un UID ya cacheado no se vuelve a pedir', async () => {
  const cache = new Map<string, string>([[UID, 'Admin Staging']])
  const { pedidos } = lector({})
  assert.deepEqual(uidsPorResolver([UID], cache), [])
  const { pedidos: p2, leer } = lector({})
  await resolverNombresActores([UID], cache, leer)
  assert.deepEqual(p2, [])
  assert.deepEqual(pedidos, [])
  // Un '' cacheado también cuenta como "ya se intentó": no se reintenta.
  const cacheVacio = new Map<string, string>([[UID, '']])
  assert.deepEqual(uidsPorResolver([UID], cacheVacio), [])
})

test('AR3 · dos UIDs distintos: dos lecturas, una por cada uno', async () => {
  const cache = new Map<string, string>()
  const { pedidos, leer } = lector({ [UID]: { name: 'Admin Staging' }, [UID_2]: { name: 'John Pork 2' } })
  const res = await resolverNombresActores([UID, UID_2, UID], cache, leer)
  assert.deepEqual([...pedidos].sort(), [UID, UID_2].sort())
  assert.equal(pedidos.length, 2)
  assert.deepEqual(res, { [UID]: 'Admin Staging', [UID_2]: 'John Pork 2' })
})

test('AR4 · un UID vacío, nulo o de espacios no se lee', async () => {
  const cache = new Map<string, string>()
  const { pedidos, leer } = lector({})
  assert.deepEqual(uidsPorResolver(['', '   ', null, undefined], cache), [])
  const res = await resolverNombresActores(['', null, undefined, '  '], cache, leer)
  assert.deepEqual(pedidos, [])
  assert.deepEqual(res, {})
  assert.equal(cache.size, 0)
})

test('AR5 · usuario sin name: se cachea vacío y la UI cae a "Usuario interno"', async () => {
  const cache = new Map<string, string>()
  const { leer } = lector({ [UID]: { name: '   ' } })
  await resolverNombresActores([UID], cache, leer)
  assert.equal(cache.get(UID), '')
  assert.equal(presentarActor(UID, cache.get(UID))?.nombre, NOMBRE_ACTOR_DESCONOCIDO)
  // Y un usuario que no existe, igual.
  const cache2 = new Map<string, string>()
  await resolverNombresActores([UID], cache2, lector({}).leer)
  assert.equal(cache2.get(UID), '')
})

test('AR6 · una lectura que falla no rompe nada y no se reintenta', async () => {
  const cache = new Map<string, string>()
  const { pedidos, leer } = lector({ [UID_2]: { name: 'John Pork 2' } }, [UID])
  const res = await resolverNombresActores([UID, UID_2], cache, leer)
  assert.equal(res[UID], '')
  assert.equal(res[UID_2], 'John Pork 2')
  assert.equal(cache.get(UID), '')
  assert.equal(pedidos.length, 2)
  // Segunda vuelta: el que falló ya está marcado, no se vuelve a pedir.
  const { pedidos: p2, leer: leer2 } = lector({}, [UID])
  await resolverNombresActores([UID, UID_2], cache, leer2)
  assert.deepEqual(p2, [])
  assert.equal(presentarActor(UID, cache.get(UID))?.nombre, 'Usuario interno')
})

test('AR7 · SH-0005: DEP-0004 y DEP-0005 reciben el mismo nombre resuelto', async () => {
  const cache = new Map<string, string>()
  const { pedidos, leer } = lector({ [UID]: { name: 'Admin Staging' } })
  // Los dos depósitos de SH-0005, confirmados por el mismo admin.
  const depositos = [{ confirmadoPorUid: UID }, { confirmadoPorUid: UID }]
  await resolverNombresActores(depositos.map((d) => d.confirmadoPorUid), cache, leer)
  assert.equal(pedidos.length, 1)
  for (const d of depositos) {
    assert.equal(presentarActor(d.confirmadoPorUid, cache.get(d.confirmadoPorUid))?.nombre, 'Admin Staging')
  }
})

test('AR8 · nada de esto infiere un rol: solo el nombre realmente leído', async () => {
  const cache = new Map<string, string>()
  await resolverNombresActores([UID], cache, lector({ [UID]: { rol: 'admin' } as unknown as DatosUsuario }).leer)
  const actor = presentarActor(UID, cache.get(UID))
  assert.equal(actor?.nombre, 'Usuario interno')
  for (const inventado of ['Admin', 'Gestor', 'Digitador', 'admin', UID]) {
    assert.notEqual(actor?.nombre, inventado)
  }
})
