// VIAJE-RECHAZO-MOTORIZADO-TRAZA-1 — suite de la celda Aceptación y del texto del
// rechazo. Los instantes son UTC explícitos: 00:47Z del 26 = 18:47 del 25 en
// Managua, así la suite defiende también la hora operativa.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  celdaAceptacion,
  textoRechazoMotorizado,
  nombreMotorizadoRechazo,
  NOMBRE_MOTORIZADO_DESCONOCIDO,
} from './rechazo-motorizado'

const ts = (iso: string) => ({ toDate: () => new Date(iso) })
const RECHAZO = {
  eventoId: 'ev1',
  motorizadoId: 'moto_a',
  motorizadoNombre: 'John Pork 2',
  rechazadoAt: ts('2026-09-26T00:47:00.000Z'),
}

test('UI1 · sin asignación y con un rechazo previo → "John Pork 2 rechazó · 18:47"', () => {
  const celda = celdaAceptacion({ estado: 'confirmada', asignacion: null, ultimoRechazoMotorizado: RECHAZO })
  assert.equal(celda.tipo, 'rechazo_previo')
  if (celda.tipo !== 'rechazo_previo') return
  assert.equal(celda.texto, 'John Pork 2 rechazó · 18:47')
  assert.equal(celda.detalle, 'John Pork 2 rechazó la asignación · 25/09/2026 · 18:47')
  // Es historia: no habla de "Pendiente" ni de una asignación vigente.
  assert.ok(!/pendiente|aceptada|asignad/i.test(celda.texto))
})

test('UI2 · con una asignación pendiente vigente manda el estado actual, no el rechazo histórico', () => {
  const celda = celdaAceptacion({
    estado: 'asignada',
    asignacion: { estadoAceptacion: 'pendiente' },
    ultimoRechazoMotorizado: RECHAZO,
  })
  assert.deepEqual(celda, { tipo: 'vigente' })
})

test('UI3 · una nueva asignación después del rechazo es la información principal', () => {
  // El resumen sigue en el documento (es el último rechazo), pero la solicitud
  // volvió a `asignada` con otro motorizado.
  for (const estadoAceptacion of ['pendiente', 'aceptada']) {
    assert.deepEqual(
      celdaAceptacion({ estado: 'asignada', asignacion: { estadoAceptacion }, ultimoRechazoMotorizado: RECHAZO }),
      { tipo: 'vigente' },
    )
  }
})

test('UI3b · el rechazo previo solo aparece con la solicitud confirmada y sin asignación', () => {
  const ninguna = { tipo: 'ninguna' }
  assert.deepEqual(
    celdaAceptacion({ estado: 'confirmada', asignacion: { estadoAceptacion: 'pendiente' }, ultimoRechazoMotorizado: RECHAZO }),
    ninguna,
  )
  for (const estado of ['cancelada', 'entregado', 'en_camino_retiro', 'pendiente_confirmacion', 'rechazada', undefined, null]) {
    assert.deepEqual(celdaAceptacion({ estado, asignacion: null, ultimoRechazoMotorizado: RECHAZO }), ninguna, String(estado))
  }
  // Sin rechazo persistido no hay nada que mostrar (no se inventa historia).
  assert.deepEqual(celdaAceptacion({ estado: 'confirmada', asignacion: null }), ninguna)
  assert.deepEqual(celdaAceptacion({ estado: 'confirmada', asignacion: null, ultimoRechazoMotorizado: null }), ninguna)
})

test('UI5 · sin nombre demostrable se usa un genérico seguro, nunca un UID', () => {
  for (const nombre of [null, undefined, '', '   ', 42]) {
    assert.equal(nombreMotorizadoRechazo(nombre), NOMBRE_MOTORIZADO_DESCONOCIDO)
  }
  const t = textoRechazoMotorizado({
    eventoId: 'ev1',
    motorizadoId: 'uid_crudo_123',
    motorizadoNombre: null,
    rechazadoAt: RECHAZO.rechazadoAt,
  })
  assert.equal(t!.texto, 'Un motorizado rechazó · 18:47')
  assert.ok(!t!.texto.includes('uid_crudo_123') && !t!.detalle.includes('uid_crudo_123'))
})

test('UI5b · sin hora demostrable no se muestra hora ni se inventa "ahora"', () => {
  for (const rechazadoAt of [undefined, null, 'no es fecha', {}]) {
    const t = textoRechazoMotorizado({ motorizadoNombre: 'John Pork 2', rechazadoAt })
    assert.equal(t!.texto, 'John Pork 2 rechazó', String(rechazadoAt))
    assert.equal(t!.detalle, 'John Pork 2 rechazó la asignación')
  }
  assert.equal(textoRechazoMotorizado(null), null)
  assert.equal(textoRechazoMotorizado(undefined), null)
})
