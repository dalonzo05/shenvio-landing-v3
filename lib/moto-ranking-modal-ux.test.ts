// MOTO-RANKING-REFERENCIA-UX-1 — cierre E2E del modal "Reasignar motorizado"
// abierto desde la tabla principal de Solicitudes: el <select> nativo recibía
// el score de cada candidato pero perdía la referencia geográfica que lo
// explica (Drawer y ficha completa ya la mostraban correctamente). Fija en
// el código fuente real que el <option> compone la MISMA metadata que ya
// produjo rankearMotorizados() — vía textoReferenciaGeografica(), el mismo
// formateador puro que usan las otras dos superficies — sin recalcular nada.
// Mismo patrón de este repo para componentes sin runner de UI/DOM
// (lib/login-rol.test.ts, lib/reasignacion-post-retiro-ui.test.ts).

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

function fuente(...ruta: string[]): string {
  return readFileSync(join(__dirname, '..', ...ruta), 'utf8').replace(/\r/g, '')
}

const LISTADO = ['app', 'panel', 'gestor', 'solicitudes', 'page.tsx']
const DRAWER = ['app', 'panel', 'gestor', '_components', 'SolicitudDrawer.tsx']
const DETALLE = ['app', 'panel', 'gestor', 'solicitudes', '[id]', 'page.tsx']

function bloqueOptionModal(src: string): string {
  const inicio = src.indexOf('return rankingModal.map((m) => {')
  assert.ok(inicio !== -1, 'no se encontró el map de <option> del modal')
  return src.slice(inicio, inicio + 1300)
}

// ─── MR1 · el modal usa candidatos ya rankeados, no una fuente nueva ───────

test('MR1 · el <option> del modal itera rankingModal (mismo useMemo de rankearMotorizados), sin fuente nueva', () => {
  const src = fuente(...LISTADO)
  assert.ok(src.includes('const rankingModal = useMemo<MotorizadoRankeado[]>(() => {'))
  assert.ok(src.includes('return rankearMotorizados(motorizados, ordenesActivas, nuevaOrden, ahoraOperativo)'))
  const bloque = bloqueOptionModal(src)
  assert.ok(bloque.includes('rankingModal.map((m) =>'))
})

// ─── MR2 · el <option> sigue incluyendo el score ───────────────────────────

test('MR2 · el <option> sigue mostrando el score entre corchetes', () => {
  const bloque = bloqueOptionModal(fuente(...LISTADO))
  assert.ok(bloque.includes('scoreLabel'))
  assert.ok(bloque.includes('score !== undefined ? ` [${score}]` : \'\''))
})

// ─── MR3 · el <option> ahora incluye la explicación/referencia ────────────

test('MR3 · el <option> agrega la referencia geográfica vía textoReferenciaGeografica()', () => {
  const src = fuente(...LISTADO)
  assert.ok(src.includes("import { textoReferenciaGeografica } from '@/lib/motorizado-referencia-ux'"))
  const bloque = bloqueOptionModal(src)
  assert.ok(bloque.includes('textoReferenciaGeografica('))
  assert.ok(bloque.includes('referenciaLabel'))
  // El texto final del <option> concatena score Y referencia — ninguno reemplaza al otro.
  const jsxOption = bloque.slice(bloque.indexOf('<option'), bloque.indexOf('</option>') + 9)
  assert.ok(jsxOption.includes('{scoreLabel}'))
  assert.ok(jsxOption.includes('{referenciaLabel}'))
})

// ─── MR4-MR7 · la fuente de la referencia es la MISMA metadata del ranking,
// nunca un segundo cálculo — el formateo en sí (próximo punto, ubicación
// base, última ubicación, sin referencia) ya está probado exhaustivamente en
// lib/motorizado-referencia-ux.test.ts; acá solo se fija que este archivo no
// reimplementa esa lógica. ──────────────────────────────────────────────────

test('MR4-MR7 · la referencia sale de scoreResult.detalles, no de un cálculo propio del listado', () => {
  const bloque = bloqueOptionModal(fuente(...LISTADO))
  assert.ok(bloque.includes('m.scoreResult.detalles.referenciaGeografica'))
  assert.ok(bloque.includes('m.scoreResult.detalles.distanciaProximoKm'))
  assert.ok(bloque.includes('ahoraOperativo'))
  // Ningún Haversine ni cálculo de distancia propio cerca del <option>.
  assert.ok(!bloque.includes('Math.sin('))
  assert.ok(!bloque.includes('Math.cos('))
  assert.ok(!bloque.includes('Math.atan2('))
})

test('MR6 · el listado no introduce su propio texto "ubicación actual"', () => {
  const src = fuente(...LISTADO)
  assert.ok(!src.toLowerCase().includes('ubicación actual'))
  assert.ok(!src.toLowerCase().includes('ubicacion actual'))
})

// ─── MR8 · orden y score no cambian: mismo array, mismo .map, sin sort/filter
// nuevos entre el useMemo y el render. ──────────────────────────────────────

test('MR8 · el <option> no reordena ni filtra rankingModal antes de mapearlo', () => {
  const src = fuente(...LISTADO)
  const inicioMemo = src.indexOf('const rankingModal = useMemo<MotorizadoRankeado[]>(() => {')
  const inicioOption = src.indexOf('return rankingModal.map((m) => {')
  const entreMemoYOption = src.slice(inicioMemo, inicioOption)
  // Ni un .sort ni un .filter aplicado a rankingModal entre su cálculo y su uso.
  assert.ok(!entreMemoYOption.includes('rankingModal.sort('))
  assert.ok(!entreMemoYOption.includes('rankingModal.filter('))
  assert.ok(!entreMemoYOption.includes('rankingModal.reverse('))
  // rankearMotorizados ya ordena por score (motorizado-ranking.ts); el modal no reordena.
  const bloque = bloqueOptionModal(src)
  assert.ok(!bloque.includes('.sort('))
})

// ─── MR9 · no hay listener/query nuevo por candidato ───────────────────────

test('MR9 · el bloque del <option> no abre listeners ni queries por candidato', () => {
  const bloque = bloqueOptionModal(fuente(...LISTADO))
  for (const prohibido of ['onSnapshot(', 'getDocs(', 'collection(', 'getDoc(', 'query(']) {
    assert.ok(!bloque.includes(prohibido), `no debe llamar ${prohibido} dentro del map del <option>`)
  }
})

// ─── MR10 · Drawer y ficha completa siguen consumiendo su propia explicación
// exactamente como antes — 0 cambios en esas dos superficies. ──────────────

test('MR10 · Drawer sigue mostrando scoreResult.explicacion sin cambios', () => {
  const src = fuente(...DRAWER)
  assert.ok(src.includes('sr?.explicacion &&'))
  assert.ok(src.includes('{sr.explicacion}'))
  // El Drawer no importa el helper nuevo: sigue usando la explicación completa que ya tenía.
  assert.ok(!src.includes("from '@/lib/motorizado-referencia-ux'"))
})

test('MR10b · la ficha completa no fue tocada por este bloque (misma explicación que antes)', () => {
  const src = fuente(...DETALLE)
  assert.ok(!src.includes("from '@/lib/motorizado-referencia-ux'"))
})
