// MOTO-RANKING-CANDIDATOS-LISTA-UX-1 — el <select> nativo del modal
// "Reasignar motorizado" / "Confirmar y asignar" (tabla principal de
// Solicitudes) ya mostraba score + referencia geográfica (MOTO-RANKING-
// REFERENCIA-UX-1), pero como una sola línea de texto: con 15-20 candidatos
// el dropdown se volvía alto e ilegible, dependiente del navegador. Este
// bloque reemplaza SOLO la presentación por una lista custom scrollable con
// búsqueda local — misma fuente (rankingModal), mismo motorizadoSel, mismo
// submit, mismo ranking. Fija en el código fuente real que ningún dato ni
// contrato cambió, solo el control visual. Mismo patrón de este repo para
// componentes sin runner de UI/DOM (lib/login-rol.test.ts,
// lib/moto-ranking-modal-ux.test.ts).

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

function bloqueLista(src: string): string {
  const inicio = src.indexOf('{(() => {\n                // Filtra sobre el mismo rankingModal ya calculado')
  assert.ok(inicio !== -1, 'no se encontró el bloque de la lista de candidatos')
  return src.slice(inicio, inicio + 4500)
}

// ─── LU1 · ya no depende del <select> nativo ───────────────────────────────

test('LU1 · el modal ya no usa <select>/<option> como selector principal de candidatos', () => {
  const src = fuente(...LISTADO)
  const inicioModal = src.indexOf("modalMode === 'reasignar' ? 'Reasignar motorizado' : 'Confirmar y asignar'")
  const inicioBoton = src.indexOf('mt-4 flex gap-2 flex-wrap')
  const bloqueModal = src.slice(inicioModal, inicioBoton)
  // No debe quedar el elemento <select> real (el comentario que documenta el
  // reemplazo sí puede mencionar la palabra "select" en prosa).
  assert.ok(!bloqueModal.includes('<select value='), 'no debe quedar ningún <select> real en el modal')
  assert.ok(!bloqueModal.includes('<option key='), 'no debe quedar ningún <option> real en el modal')
})

// ─── LU2 · renderiza rankingModal existente, sin fuente nueva ──────────────

test('LU2 · la lista itera rankingModal (mismo useMemo de rankearMotorizados)', () => {
  const src = fuente(...LISTADO)
  assert.ok(src.includes('const rankingModal = useMemo<MotorizadoRankeado[]>(() => {'))
  assert.ok(src.includes('return rankearMotorizados(motorizados, ordenesActivas, nuevaOrden, ahoraOperativo)'))
  const bloque = bloqueLista(src)
  assert.ok(bloque.includes('candidatos.map((m) =>'))
  assert.ok(bloque.includes('rankingModal.filter(') || bloque.includes(': rankingModal'))
})

// ─── LU3 · cada fila usa el motorizadoId real ──────────────────────────────

test('LU3 · cada fila selecciona setMotorizadoSel(m.id), el id real del candidato', () => {
  const bloque = bloqueLista(fuente(...LISTADO))
  assert.ok(bloque.includes('onClick={() => setMotorizadoSel(m.id)}'))
  assert.ok(bloque.includes('key={m.id}'))
})

// ─── LU4 · score proviene de scoreResult ───────────────────────────────────

test('LU4 · el score visible es m.scoreResult.score, no un valor derivado', () => {
  const bloque = bloqueLista(fuente(...LISTADO))
  assert.ok(bloque.includes('{m.scoreResult.score}'))
})

// ─── LU5 · referencia usa el helper existente ──────────────────────────────

test('LU5 · la referencia geográfica sale de textoReferenciaGeografica() sobre scoreResult.detalles', () => {
  const src = fuente(...LISTADO)
  // MOTO-RANKING-REFERENCIA-ZONA-UX-1 agregó getReferenciaZonaTexto al mismo import.
  assert.ok(src.includes("import { textoReferenciaGeografica, getReferenciaZonaTexto } from '@/lib/motorizado-referencia-ux'"))
  const bloque = bloqueLista(src)
  assert.ok(bloque.includes('textoReferenciaGeografica('))
  assert.ok(bloque.includes('m.scoreResult.detalles.referenciaGeografica'))
  assert.ok(bloque.includes('m.scoreResult.detalles.distanciaProximoKm'))
  assert.ok(bloque.includes('ahoraOperativo'))
  // Sin Haversine ni cálculo de distancia propio.
  assert.ok(!bloque.includes('Math.sin('))
  assert.ok(!bloque.includes('Math.atan2('))
})

// ─── LU6 · la selección conserva motorizadoSel ─────────────────────────────

test('LU6 · la fila seleccionada se determina por motorizadoSel === m.id, mismo estado existente', () => {
  const src = fuente(...LISTADO)
  assert.ok(src.includes("const [motorizadoSel, setMotorizadoSel] = useState('')"))
  const bloque = bloqueLista(src)
  assert.ok(bloque.includes('const seleccionado = motorizadoSel === m.id'))
})

// ─── LU7 · la búsqueda solo filtra nombre/teléfono ─────────────────────────

test('LU7 · el filtro de búsqueda compara solo contra nombre y teléfono', () => {
  const bloque = bloqueLista(fuente(...LISTADO))
  assert.ok(bloque.includes('m.nombre.toLowerCase().includes(q)'))
  assert.ok(bloque.includes("(m.telefono || '').toLowerCase().includes(q)"))
})

// ─── LU8 · la búsqueda no reordena ──────────────────────────────────────────

test('LU8 · el filtrado usa .filter(), nunca .sort()/.reverse() sobre rankingModal', () => {
  const bloque = bloqueLista(fuente(...LISTADO))
  assert.ok(bloque.includes('rankingModal.filter('))
  assert.ok(!bloque.includes('rankingModal.sort('))
  assert.ok(!bloque.includes('.sort('))
  assert.ok(!bloque.includes('.reverse('))
})

// ─── LU9 · sin búsqueda conserva rankingModal completo ─────────────────────

test('LU9 · sin texto de búsqueda, candidatos es exactamente rankingModal (sin copia filtrada)', () => {
  const bloque = bloqueLista(fuente(...LISTADO))
  assert.ok(bloque.includes('const candidatos = q'))
  assert.ok(bloque.includes(': rankingModal'), 'la rama sin query debe ser el array completo, no un subconjunto')
})

// ─── LU10 · la lista tiene max-height + overflow scroll ────────────────────

test('LU10 · el contenedor de la lista limita altura y hace scroll interno', () => {
  const bloque = bloqueLista(fuente(...LISTADO))
  assert.match(bloque, /max-h-\[\d+px\]/)
  assert.ok(bloque.includes('overflow-y-auto'))
})

// ─── LU11 · sin query/listener adicional ───────────────────────────────────

test('LU11 · la lista y el input de búsqueda no abren listeners ni queries', () => {
  const src = fuente(...LISTADO)
  const inicio = src.indexOf('Buscar motorizado por nombre o teléfono')
  const bloque = src.slice(inicio - 300, inicio) + bloqueLista(src)
  for (const prohibido of ['onSnapshot(', 'getDocs(', 'collection(', 'getDoc(', 'query(', 'fetch(']) {
    assert.ok(!bloque.includes(prohibido), `no debe llamar ${prohibido} en el bloque de búsqueda/lista`)
  }
})

// ─── LU12 · indicador de selección no depende solo del color ───────────────

test('LU12 · cada fila muestra un indicador visual (ícono) además del color de fondo', () => {
  const bloque = bloqueLista(fuente(...LISTADO))
  assert.ok(bloque.includes('<CheckCircle2'), 'seleccionado debe mostrar un ícono, no solo cambiar el fondo')
  assert.ok(bloque.includes('aria-pressed={seleccionado}'))
  // El fondo (bg-indigo-50) es un refuerzo, no el único indicador.
  assert.ok(bloque.includes('rounded-full border border-gray-300'), 'no seleccionado también tiene un indicador visible (círculo vacío)')
})

// ─── LU13 · submit sigue usando el mismo motorizadoId ──────────────────────

test('LU13 · reasignarSolo/confirmarYAsignar siguen leyendo motorizadoSel sin cambios', () => {
  const src = fuente(...LISTADO)
  assert.ok(src.includes("await guardarAsignacion(solicitud, motorizadoSel, 'reasignar', 'solicitudes')"))
  assert.ok(src.includes("await guardarAsignacion(solicitud, motorizadoSel || null, 'confirmar', 'solicitudes', precioFinal, precioEditado)"))
  assert.ok(src.includes('disabled={guardandoAsignacion || !motorizadoSel}'))
})

// ─── LU14 · "Asignar sugerido" permanece intacto ───────────────────────────

test('LU14 · la tarjeta de motorizado sugerido no cambió (mismo top, mismo score, misma acción)', () => {
  const src = fuente(...LISTADO)
  assert.ok(src.includes("modalMode === 'confirmar' && rankingModal.length > 0 && (() => {"))
  assert.ok(src.includes('const top = rankingModal[0]'))
  assert.ok(src.includes('{top.scoreResult.score} pts'))
  assert.ok(src.includes('{top.scoreResult.explicacion}'))
  assert.ok(src.includes('onClick={() => setMotorizadoSel(top.id)}'))
  assert.ok(src.includes('Asignar sugerido'))
})

// ─── LU15 · Drawer y ficha completa no cambian ─────────────────────────────

test('LU15 · Drawer sigue con su propia lista de candidatos, sin tocar', () => {
  const src = fuente(...DRAWER)
  assert.ok(src.includes('sr?.explicacion &&'))
  assert.ok(src.includes('{sr.explicacion}'))
  assert.ok(!src.includes('MOTO-RANKING-CANDIDATOS-LISTA-UX-1'))
})

test('LU15b · la ficha completa no fue tocada por este bloque', () => {
  const src = fuente(...DETALLE)
  assert.ok(!src.includes('MOTO-RANKING-CANDIDATOS-LISTA-UX-1'))
})

// ─── Regresión heredada de MOTO-RANKING-REFERENCIA-UX-1 (antes cubierta en
// lib/moto-ranking-modal-ux.test.ts, retirado porque probaba el <select>
// que este bloque reemplaza) ─────────────────────────────────────────────

test('MR6-regresión · el listado no introduce su propio texto "ubicación actual"', () => {
  const src = fuente(...LISTADO)
  assert.ok(!src.toLowerCase().includes('ubicación actual'))
  assert.ok(!src.toLowerCase().includes('ubicacion actual'))
})

// ─── Precio fuera de scope ──────────────────────────────────────────────────

test('precio · el campo "Precio final (C$)" no fue tocado por este bloque', () => {
  const src = fuente(...LISTADO)
  assert.ok(src.includes('Precio final (C$)'))
  assert.ok(src.includes('step={10}'))
})

// ═══ MOTO-RANKING-REFERENCIA-ZONA-UX-1 ══════════════════════════════════════
// Tercera línea opcional (zona/macrozona) en la misma fila de candidato.
// Puramente presentacional sobre el mismo scoreResult.detalles.referenciaGeografica
// ya usado por LU5 — no reconstruye metadata mirando solicitudes por su cuenta.

test('RZ16 · getReferenciaZonaTexto se calcula sobre la misma referenciaGeografica que usa la línea 2', () => {
  const src = fuente(...LISTADO)
  assert.ok(src.includes("import { textoReferenciaGeografica, getReferenciaZonaTexto } from '@/lib/motorizado-referencia-ux'"))
  const bloque = bloqueLista(src)
  assert.ok(bloque.includes('const zonaTexto = getReferenciaZonaTexto(m.scoreResult.detalles.referenciaGeografica)'))
})

test('RZ17 · la tercera línea es condicional: solo se renderiza si zonaTexto no es null', () => {
  const bloque = bloqueLista(fuente(...LISTADO))
  assert.ok(bloque.includes('{zonaTexto && ('), 'debe ser condicional, nunca mostrar una línea vacía/"Sin zona"')
  assert.ok(!bloque.includes('Sin zona'))
  assert.ok(!bloque.includes('Zona desconocida'))
})

test('RZ18 · la tercera línea usa clases mínimas (texto discreto, truncate) sin overflow horizontal nuevo', () => {
  const bloque = bloqueLista(fuente(...LISTADO))
  const inicio = bloque.indexOf('{zonaTexto && (')
  const fragmento = bloque.slice(inicio, inicio + 200)
  assert.ok(fragmento.includes('text-xs'))
  assert.ok(fragmento.includes('truncate'))
  assert.ok(!fragmento.includes('whitespace-nowrap'), 'no debe forzar una sola línea que provoque scroll horizontal')
})

test('RZ-selección · motorizadoSel/setMotorizadoSel y la búsqueda nombre/teléfono no cambiaron al agregar la 3ª línea', () => {
  const bloque = bloqueLista(fuente(...LISTADO))
  assert.ok(bloque.includes('const seleccionado = motorizadoSel === m.id'))
  assert.ok(bloque.includes('onClick={() => setMotorizadoSel(m.id)}'))
})

test('RZ-no-query · el bloque de la lista sigue sin abrir queries/listeners al agregar la 3ª línea', () => {
  const bloque = bloqueLista(fuente(...LISTADO))
  for (const prohibido of ['onSnapshot(', 'getDocs(', 'getDoc(', 'query(', 'fetch(', 'getZonasActivas(', 'clasificarPuntoEnZona(', 'clasificarOrdenCompleto(']) {
    assert.ok(!bloque.includes(prohibido), `no debe llamar ${prohibido} en el bloque de la lista`)
  }
})
