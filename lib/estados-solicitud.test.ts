// MOTO-REASIGNACION-POST-RETIRO-GUARD-1 — fija la MISMA matriz que
// functions/src/asignacion-motorizado.ts (estadosAsignacionInicial /
// estadosReasignables), duplicada allá porque Functions no puede importar
// de lib/. Cualquier cambio en uno de los dos archivos que no se refleje en
// el otro debe hacer fallar la suite correspondiente.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  esEstadoCerrado,
  puedeAsignarInicial,
  puedeReasignarMotorizado,
  puedeGestionarAsignacion,
  ESTADOS_ASIGNACION_INICIAL,
  ESTADOS_REASIGNABLES,
} from './estados-solicitud'

const TODOS_LOS_ESTADOS = [
  'pendiente_confirmacion', 'confirmada', 'asignada', 'en_camino_retiro',
  'retirado', 'en_camino_entrega', 'entregado', 'rechazada', 'cancelada',
] as const

test('ESTADOS_ASIGNACION_INICIAL es exactamente pendiente_confirmacion y confirmada', () => {
  assert.deepEqual([...ESTADOS_ASIGNACION_INICIAL], ['pendiente_confirmacion', 'confirmada'])
})

test('ESTADOS_REASIGNABLES es exactamente asignada y en_camino_retiro', () => {
  assert.deepEqual([...ESTADOS_REASIGNABLES], ['asignada', 'en_camino_retiro'])
})

test('RG1 · asignada → puedeReasignarMotorizado = true', () => {
  assert.equal(puedeReasignarMotorizado('asignada'), true)
})

test('RG2 · en_camino_retiro → puedeReasignarMotorizado = true (todavía no ocurrió el retiro físico)', () => {
  assert.equal(puedeReasignarMotorizado('en_camino_retiro'), true)
})

test('RG3 · retirado → puedeReasignarMotorizado = false', () => {
  assert.equal(puedeReasignarMotorizado('retirado'), false)
})

test('RG4 · en_camino_entrega → puedeReasignarMotorizado = false', () => {
  assert.equal(puedeReasignarMotorizado('en_camino_entrega'), false)
})

test('RG5 · entregado → puedeReasignarMotorizado = false', () => {
  assert.equal(puedeReasignarMotorizado('entregado'), false)
})

test('rechazada/cancelada → puedeReasignarMotorizado = false (tampoco se asignan/reasignan)', () => {
  assert.equal(puedeReasignarMotorizado('rechazada'), false)
  assert.equal(puedeReasignarMotorizado('cancelada'), false)
})

test('estado ausente/desconocido → puedeReasignarMotorizado = false (fail-closed, no fail-open)', () => {
  assert.equal(puedeReasignarMotorizado(undefined), false)
  assert.equal(puedeReasignarMotorizado(null), false)
  assert.equal(puedeReasignarMotorizado(''), false)
  assert.equal(puedeReasignarMotorizado('estado_inventado'), false)
})

test('puedeAsignarInicial · solo pendiente_confirmacion y confirmada', () => {
  assert.equal(puedeAsignarInicial('pendiente_confirmacion'), true)
  assert.equal(puedeAsignarInicial('confirmada'), true)
  for (const estado of ['asignada', 'en_camino_retiro', 'retirado', 'en_camino_entrega', 'entregado', 'rechazada', 'cancelada']) {
    assert.equal(puedeAsignarInicial(estado), false, estado)
  }
})

test('puedeGestionarAsignacion · unión de asignación inicial y reasignación, fail-closed para el resto', () => {
  const esperados: Record<string, boolean> = {
    pendiente_confirmacion: true, confirmada: true,
    asignada: true, en_camino_retiro: true,
    retirado: false, en_camino_entrega: false, entregado: false,
    rechazada: false, cancelada: false,
  }
  for (const estado of TODOS_LOS_ESTADOS) {
    assert.equal(puedeGestionarAsignacion(estado), esperados[estado], estado)
  }
})

test('retirado NO está en ESTADOS_CERRADOS (sigue abierto para cobros/depósitos) pero SÍ está bloqueado para reasignar — son predicados distintos', () => {
  assert.equal(esEstadoCerrado('retirado'), false)
  assert.equal(puedeReasignarMotorizado('retirado'), false)
})

test('en_camino_entrega NO está en ESTADOS_CERRADOS pero SÍ está bloqueado para reasignar', () => {
  assert.equal(esEstadoCerrado('en_camino_entrega'), false)
  assert.equal(puedeReasignarMotorizado('en_camino_entrega'), false)
})
