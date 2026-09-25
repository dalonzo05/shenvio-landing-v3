// VIAJE-MOTORIZADO-COLUMNA-SEMANTICA-1 — la columna Motorizado muestra al
// motorizado ASIGNADO y nunca al sugerido ni al que rechazó.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { celdaMotorizado } from './columna-motorizado'
import { celdaAceptacion } from './rechazo-motorizado'

const SIN_ASIGNAR = { tipo: 'sin_asignar' }
const ts = (iso: string) => ({ toDate: () => new Date(iso) })

test('MC1 · confirmada sin asignación → "Sin asignar", aunque haya un sugerido disponible', () => {
  // El sugerido no entra al helper: no hay forma de que lo use.
  assert.equal(celdaMotorizado.length, 1)
  assert.deepEqual(celdaMotorizado({ asignacion: null }), SIN_ASIGNAR)
  assert.deepEqual(celdaMotorizado({}), SIN_ASIGNAR)
})

test('MC2 · SH-0010: confirmada, rechazo de John Pork 2 y sugerido John Pork 2 → Motorizado "Sin asignar", Aceptación con el rechazo', () => {
  const orden = {
    estado: 'confirmada',
    asignacion: null,
    ultimoRechazoMotorizado: {
      eventoId: 'ev1',
      motorizadoId: 'moto_a',
      motorizadoNombre: 'John Pork 2',
      rechazadoAt: ts('2026-09-26T00:47:00.000Z'),
    },
  }
  assert.deepEqual(celdaMotorizado(orden), SIN_ASIGNAR)
  const aceptacion = celdaAceptacion(orden)
  assert.equal(aceptacion.tipo, 'rechazo_previo')
  if (aceptacion.tipo === 'rechazo_previo') assert.equal(aceptacion.texto, 'John Pork 2 rechazó · 18:47')
})

test('MC3 · asignada con asignación real de John Pork → la columna dice John Pork', () => {
  const celda = celdaMotorizado({ asignacion: { motorizadoNombre: 'John Pork', motorizadoTelefono: '8888-1111' } })
  assert.deepEqual(celda, { tipo: 'asignado', nombre: 'John Pork', telefono: '8888-1111' })
})

test('MC4 · asignación real de María con John Pork sugerido → María; la asignación real manda', () => {
  const orden = { asignacion: { motorizadoNombre: 'María López', motorizadoTelefono: '8888-2222' } }
  const celda = celdaMotorizado(orden)
  assert.equal(celda.tipo, 'asignado')
  if (celda.tipo === 'asignado') {
    assert.equal(celda.nombre, 'María López')
    assert.notEqual(celda.nombre, 'John Pork')
  }
})

test('MC5 · sin asignación y sin sugerido → "Sin asignar"; y una asignación sin nombre demostrable tampoco inventa uno', () => {
  assert.deepEqual(celdaMotorizado({ asignacion: null }), SIN_ASIGNAR)
  for (const motorizadoNombre of [undefined, null, '', '   ', 42]) {
    assert.deepEqual(celdaMotorizado({ asignacion: { motorizadoNombre } }), SIN_ASIGNAR, String(motorizadoNombre))
  }
  // Sin teléfono, el teléfono queda en null y el nombre se conserva.
  assert.deepEqual(celdaMotorizado({ asignacion: { motorizadoNombre: 'John Pork' } }), {
    tipo: 'asignado',
    nombre: 'John Pork',
    telefono: null,
  })
})

test('MC5b · el estado de la solicitud no cambia qué motorizado se muestra: solo cuenta la asignación', () => {
  // Terminales y en curso conservan a su motorizado asignado, como antes.
  for (const estado of ['asignada', 'en_camino_retiro', 'retirado', 'en_camino_entrega', 'entregado', 'cancelada', 'rechazada']) {
    const celda = celdaMotorizado({ asignacion: { motorizadoNombre: 'John Pork' }, ...{ estado } } as never)
    assert.equal(celda.tipo, 'asignado', estado)
  }
})

test('MC6 · la corrección no toca las sugerencias: siguen el botón, "Ver opciones" y el ranking', () => {
  // Se comprueba sobre la fuente real del listado: la columna usa el helper y ya
  // no consulta el ranking; las acciones y el cálculo del sugerido siguen ahí.
  const src = readFileSync(join(__dirname, '..', 'app', 'panel', 'gestor', 'solicitudes', 'page.tsx'), 'utf8')
  const iColumna = src.indexOf('celdaMotorizado(s)')
  const iAceptacion = src.indexOf('celdaAceptacion(s)')
  assert.ok(iColumna > 0 && iAceptacion > iColumna, 'la columna Motorizado debe usar el helper y venir antes de Aceptación')
  const columna = src.slice(iColumna, iAceptacion)
  assert.ok(!columna.includes('rankingTabla'), 'la columna Motorizado no debe consultar el ranking')
  assert.ok(!columna.includes('top.nombre'), 'la columna Motorizado no debe pintar al candidato sugerido')

  assert.ok(src.includes('const rankingTabla = useMemo<Map<string, MotorizadoRankeado>>'), 'el cálculo del sugerido cambió')
  assert.ok(src.includes('rankearMotorizados(motorizados, ordenesActivas, nuevaOrden)[0]'), 'el ranking cambió')
  assert.ok(src.includes('asignarSugerido(s.id, top)'), 'el botón dejó de asignar al sugerido')
  assert.ok(src.includes("'Asignar sugerido'"), 'falta el botón "Asignar sugerido"')
  assert.ok(src.includes("top ? 'Ver opciones' : 'Asignar'"), 'falta el acceso a "Ver opciones"')
})
