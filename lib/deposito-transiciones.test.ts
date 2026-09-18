// DEPOSITOS-UX-TRAZABILIDAD-1 (v2) — transiciones de depósito vistas desde la
// orden, y lo que el motorizado ve después de cada una.
//
// `aplicar` imita un updateDoc de Firestore con rutas punteadas: es la forma
// en que los flujos escriben estos campos. Con eso, la matriz corre sobre el
// mismo helper que usa el panel (resumenDepositosMotorizado).
//
// Fixture: SH-0001 (jTIJLEhGeACcymBAj0jY), delivery C$110 cobrado en
// efectivo; DEP-0001 (P4IMui3ILjs0P9U6eDgT).

import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  clavesDeposito,
  camposEnlaceDigitacion,
  camposReaperturaRevision,
  camposLiberacionDeposito,
  eliminarLiberaOrdenes,
} from './deposito-transiciones'
import { resumenDepositosMotorizado } from './depositos-motorizado'
import type { EntradaDepositoOrden } from './deposito-orden'

const DEP = 'P4IMui3ILjs0P9U6eDgT'

function sh0001(deposito: Record<string, unknown> | null = null): EntradaDepositoOrden {
  return {
    estado: 'entregado',
    tipoCliente: 'contado',
    confirmacion: { precioFinalCordobas: 110 },
    pagoDelivery: { quienPaga: 'entrega', montoSugerido: 110, deducirDelCobroContraEntrega: false, tipo: 'contado' },
    cobrosMotorizado: { delivery: { monto: 110, recibio: true } },
    cobroContraEntrega: { aplica: false, monto: 0 },
    registro: { deposito },
  } as EntradaDepositoOrden
}

/** Orden con CE de C$500 al comercio y delivery pagado aparte en efectivo. */
function conProducto(deposito: Record<string, unknown> | null = null): EntradaDepositoOrden {
  return {
    ...sh0001(deposito),
    cobroContraEntrega: { aplica: true, monto: 500 },
    cobrosMotorizado: { delivery: { monto: 110, recibio: true }, producto: { monto: 500, recibio: true } },
  } as EntradaDepositoOrden
}

/** updateDoc con rutas punteadas: un padre null se reemplaza por un mapa. */
function aplicar<T>(orden: T, campos: Record<string, unknown>): T {
  const copia = JSON.parse(JSON.stringify(orden))
  for (const [ruta, valor] of Object.entries(campos)) {
    const partes = ruta.split('.')
    let nodo = copia
    for (const p of partes.slice(0, -1)) {
      if (nodo[p] == null || typeof nodo[p] !== 'object') nodo[p] = {}
      nodo = nodo[p]
    }
    nodo[partes[partes.length - 1]] = valor
  }
  return copia
}

const ver = (o: EntradaDepositoOrden) => {
  const r = resumenDepositosMotorizado([o])
  return { pendiente: r.pendiente.total, enRevision: r.enRevision.total }
}

// ── Campos ───────────────────────────────────────────────────────────────────

test('D1 · rutas reales de la orden por destino', () => {
  assert.deepEqual(clavesDeposito('storkhub'), {
    id: 'registro.deposito.storkhubDepositoId',
    confirmado: 'registro.deposito.confirmadoStorkhub',
    confirmadoAt: 'registro.deposito.confirmadoStorkhubAt',
  })
  assert.equal(clavesDeposito('comercio').id, 'registro.deposito.comercioDepositoId')
})

test('D2 · digitación: SOLO el puntero, nunca la confirmación', () => {
  assert.deepEqual(camposEnlaceDigitacion('storkhub', DEP), { 'registro.deposito.storkhubDepositoId': DEP })
  assert.deepEqual(camposEnlaceDigitacion('comercio', 'depC'), { 'registro.deposito.comercioDepositoId': 'depC' })
})

test('D3 · reapertura a revisión: conserva el puntero y retira la confirmación', () => {
  assert.deepEqual(camposReaperturaRevision('storkhub', DEP), {
    'registro.deposito.storkhubDepositoId': DEP,
    'registro.deposito.confirmadoStorkhub': false,
    'registro.deposito.confirmadoStorkhubAt': null,
  })
})

test('D4 · liberación: mismos valores que devolverAlMotorizado', () => {
  assert.deepEqual(camposLiberacionDeposito('comercio'), {
    'registro.deposito.comercioDepositoId': null,
    'registro.deposito.confirmadoComercio': false,
    'registro.deposito.confirmadoComercioAt': null,
  })
})

test('D5 · eliminar no libera un depósito convertido en deuda (su saldo sigue vivo)', () => {
  assert.equal(eliminarLiberaOrdenes('confirmado'), true)
  assert.equal(eliminarLiberaOrdenes('en_revision'), true)
  assert.equal(eliminarLiberaOrdenes('convertido_en_deuda'), false)
})

// ── Matriz: lo que ve el motorizado ──────────────────────────────────────────

test('X1 · motorizado normal: 110/0 → envía 0/110 → confirmado 0/0', () => {
  assert.deepEqual(ver(sh0001()), { pendiente: 110, enRevision: 0 })
  const enviada = aplicar(sh0001(), { 'registro.deposito.storkhubDepositoId': DEP })
  assert.deepEqual(ver(enviada), { pendiente: 0, enRevision: 110 })
  const confirmada = aplicar(enviada, { 'registro.deposito.confirmadoStorkhub': true, 'registro.deposito.confirmadoStorkhubAt': 'T' })
  assert.deepEqual(ver(confirmada), { pendiente: 0, enRevision: 0 })
})

test('X2 · P0 · digitador registra el depósito (StorkHub): 110/0 → 0/110', () => {
  const antes = sh0001()
  assert.deepEqual(ver(antes), { pendiente: 110, enRevision: 0 })
  // registro.deposito null, como SH-0001 antes de su depósito.
  const despues = aplicar(antes, camposEnlaceDigitacion('storkhub', DEP))
  assert.deepEqual(ver(despues), { pendiente: 0, enRevision: 110 })
  assert.equal(despues.registro?.deposito?.confirmadoStorkhub, undefined, 'la digitación no confirma')
})

test('X3 · P0 · digitador registra el depósito al comercio: solo ese destino pasa a revisión', () => {
  const antes = conProducto()
  const r0 = resumenDepositosMotorizado([antes])
  assert.equal(r0.pendiente.comercio, 500)
  const despues = aplicar(antes, camposEnlaceDigitacion('comercio', 'depC'))
  const r1 = resumenDepositosMotorizado([despues])
  assert.equal(r1.pendiente.comercio, 0)
  assert.equal(r1.enRevision.comercio, 500)
  // StorkHub no se toca: sigue pendiente.
  assert.equal(r1.pendiente.storkhub, 110)
})

test('X4 · rehacer un depósito confirmado: cerrado → 0/110', () => {
  const confirmada = sh0001({ storkhubDepositoId: DEP, confirmadoStorkhub: true, confirmadoStorkhubAt: 'T' })
  assert.deepEqual(ver(confirmada), { pendiente: 0, enRevision: 0 })
  const rehecha = aplicar(confirmada, camposReaperturaRevision('storkhub', DEP))
  assert.deepEqual(ver(rehecha), { pendiente: 0, enRevision: 110 })
  assert.equal(rehecha.registro?.deposito?.storkhubDepositoId, DEP, 'el puntero se conserva')
})

test('X5 · revertir una conversión en deuda con boucher: → 0/110', () => {
  const convertida = sh0001({ storkhubDepositoId: DEP, confirmadoStorkhub: true, confirmadoStorkhubAt: 'T' })
  const revertida = aplicar(convertida, camposReaperturaRevision('storkhub', DEP))
  assert.deepEqual(ver(revertida), { pendiente: 0, enRevision: 110 })
})

test('X6 · eliminar un depósito confirmado: la obligación vuelve a 110/0, sin puntero roto', () => {
  const confirmada = sh0001({ storkhubDepositoId: DEP, confirmadoStorkhub: true, confirmadoStorkhubAt: 'T' })
  const liberada = aplicar(confirmada, camposLiberacionDeposito('storkhub'))
  assert.deepEqual(ver(liberada), { pendiente: 110, enRevision: 0 })
  assert.equal(liberada.registro?.deposito?.storkhubDepositoId, null)
  assert.equal(liberada.registro?.deposito?.confirmadoStorkhub, false)
})
