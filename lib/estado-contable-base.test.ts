// B2-BASE-DECISIONAL — Suite focal de lib/estado-contable-base.ts

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { estadoContable, type EntradaEstadoContable } from './estado-contable-base'

const ADMIN = 'RKTw1pLfK5O8Y3A6IIwDU8J3yr43'

/** Base entregada, sin nada abierto. */
function limpia(over: Partial<EntradaEstadoContable> = {}): EntradaEstadoContable {
  return {
    estado: 'entregado',
    tipoCliente: 'contado',
    cobroContraEntrega: { aplica: false },
    confirmacion: { precioFinalCordobas: 110 },
    pagoDelivery: { quienPaga: 'entrega', deducirDelCobroContraEntrega: false },
    cobrosMotorizado: { delivery: { monto: 110, recibio: true } },
    cobroDelivery: { estado: 'pagado', monto: 110 },
    // Con puntero: el depósito existe y esta pantalla no juzga su estado.
    registro: { deposito: { storkhubDepositoId: 'dep1', confirmadoStorkhub: true } },
    ...over,
  }
}

// ── EC1 ─────────────────────────────────────────────────────────────────────
test('EC1 · delivery por cobrar requiere atención', () => {
  // 8MWJtz4G
  const r = estadoContable({
    estado: 'entregado',
    tipoCliente: 'contado',
    cobroContraEntrega: { aplica: true, monto: 500 },
    confirmacion: { precioFinalCordobas: 150 },
    pagoDelivery: { quienPaga: 'entrega', deducirDelCobroContraEntrega: true },
    cobrosMotorizado: {
      delivery: { monto: 150, recibio: false, justificacion: 'D' },
      producto: {
        monto: 500, recibio: false, estado: 'pendiente', justificacion: 'D',
        resolucion: { tipo: 'cliente_pagara', resueltoPor: ADMIN, at: 'x', nota: null },
      },
    },
    cobroDelivery: { estado: 'pendiente', monto: 150, montoDelivery: 150, cubiertoPorDeposito: 0 },
  })
  assert.equal(r.estado, 'requiere_atencion')
  assert.equal(r.etiqueta, 'Requiere atención')
  assert.deepEqual(r.motivos.map((m) => m.texto), ['Delivery C$ 150 por cobrar'])
  assert.equal(r.motivos[0].monto, 150)
})

// ── EC2 ─────────────────────────────────────────────────────────────────────
test('EC2 · incidencia sin clasificar: atención, y sin monto inventado', () => {
  const r = estadoContable(limpia({
    cobroContraEntrega: { aplica: true, monto: 1000 },
    cobrosMotorizado: {
      delivery: { monto: 110, recibio: true },
      producto: { monto: 1000, recibio: false, estado: 'pendiente', justificacion: 'D' },
    },
  }))
  const inc = r.motivos.find((m) => m.id === 'incidencia')!
  assert.equal(r.estado, 'requiere_atencion')
  assert.equal(inc.texto, 'Incidencia de cobro por clasificar')
  assert.equal(inc.monto, undefined)
  // Los C$1.000 no aparecen por ningún lado.
  assert.equal(r.motivos.some((m) => m.monto === 1000), false)
  assert.equal(r.motivos.map((m) => m.texto).join(' ').includes('1,000'), false)
})

// ── EC3 ─────────────────────────────────────────────────────────────────────
test('EC3 · cobro en revisión no es lo mismo que pendiente', () => {
  const r = estadoContable(limpia({
    cobroDelivery: { estado: 'en_revision_deposito', monto: 110 },
  }))
  assert.equal(r.estado, 'en_revision')
  assert.equal(r.etiqueta, 'En revisión')
  assert.equal(r.motivos[0].texto, 'Cobro del delivery en revisión')
})

test('EC3b · en revisión + incidencia abierta sigue exigiendo acción', () => {
  const r = estadoContable(limpia({
    cobroContraEntrega: { aplica: true, monto: 500 },
    cobroDelivery: { estado: 'en_revision_deposito', monto: 110 },
    cobrosMotorizado: {
      delivery: { monto: 110, recibio: true },
      producto: { monto: 500, recibio: false, estado: 'pendiente', justificacion: 'D' },
    },
  }))
  assert.equal(r.estado, 'requiere_atencion')
  assert.equal(r.motivos.length, 2)
})

// ── EC4 ─────────────────────────────────────────────────────────────────────
test('EC4 · producto no cobrado pero clasificado no es deuda de ShEnvíos', () => {
  // k5Ve09HM sin la parte de depósito: producto resuelto, delivery cobrado.
  const r = estadoContable(limpia({
    cobroContraEntrega: { aplica: true, monto: 1000 },
    confirmacion: { precioFinalCordobas: 80 },
    cobrosMotorizado: {
      delivery: { monto: 80, recibio: true },
      producto: {
        monto: 1000, recibio: false, estado: 'pendiente', justificacion: 'Otro',
        resolucion: { tipo: 'cliente_pagara', resueltoPor: ADMIN, at: 'x', nota: null },
      },
    },
    cobroDelivery: { estado: 'pagado', monto: 80 },
    registro: { deposito: { storkhubDepositoId: 'dep1' } },
  }))
  assert.equal(r.estado, 'sin_alertas')
  assert.deepEqual(r.motivos, [])
})

// ── EC5 ─────────────────────────────────────────────────────────────────────
test('EC5 · sin señales abiertas: sin alertas, nunca "cerrado contablemente"', () => {
  const r = estadoContable(limpia())
  assert.equal(r.estado, 'sin_alertas')
  assert.equal(r.etiqueta, 'Sin alertas')
  assert.deepEqual(r.motivos, [])
  for (const prohibido of ['Cerrado', 'Conciliado', 'Liquidado', 'Al día']) {
    assert.equal(r.etiqueta.includes(prohibido), false)
  }
})

test('EC5b · documento vacío no rompe', () => {
  const r = estadoContable({})
  assert.equal(r.estado, 'sin_alertas')
  assert.deepEqual(r.motivos, [])
})

// ── EC6 ─────────────────────────────────────────────────────────────────────
test('EC6 · varios motivos se listan, nunca se suman', () => {
  // fq6w3pXc: C$50 por cobrar y C$100 a depositar. Son dos billetes.
  const r = estadoContable({
    estado: 'entregado',
    tipoCliente: 'contado',
    cobroContraEntrega: { aplica: true, monto: 100 },
    confirmacion: { precioFinalCordobas: 150 },
    pagoDelivery: { quienPaga: 'entrega', deducirDelCobroContraEntrega: true },
    cobrosMotorizado: { delivery: { monto: 150, recibio: true }, producto: { monto: 100, recibio: true } },
    cobroDelivery: { estado: 'pendiente', monto: 50, montoDelivery: 150, cubiertoPorDeposito: 100 },
  })
  assert.equal(r.estado, 'requiere_atencion')
  assert.deepEqual(r.motivos.map((m) => m.monto), [50, 100])
  // Ni 150 ni un total fusionado.
  assert.equal(r.motivos.some((m) => m.monto === 150), false)
  assert.equal(r.motivos.reduce((s, m) => s + (m.monto ?? 0), 0), 150) // suma real, no mostrada
  assert.equal(r.motivos.length, 2)
})

// ── EC7 ─────────────────────────────────────────────────────────────────────
test('EC7 · el depósito solo se afirma cuando no hay ningún puntero', () => {
  // k5Ve09HM real: obligación C$80 y registro.deposito ausente.
  const sinPuntero = estadoContable(limpia({
    confirmacion: { precioFinalCordobas: 80 },
    cobrosMotorizado: { delivery: { monto: 80, recibio: true } },
    cobroDelivery: { estado: 'pagado', monto: 80 },
    registro: null,
  }))
  assert.equal(sinPuntero.estado, 'requiere_atencion')
  assert.equal(sinPuntero.motivos[0].texto, 'Depósito pendiente C$ 80')

  // Con puntero: existe un documento cuyo estado esta pantalla no lee. No se
  // afirma alerta ni se usa para cerrar.
  const conPuntero = estadoContable(limpia({
    confirmacion: { precioFinalCordobas: 80 },
    cobrosMotorizado: { delivery: { monto: 80, recibio: true } },
    cobroDelivery: { estado: 'pagado', monto: 80 },
    registro: { deposito: { storkhubDepositoId: 'dep1' } },
  }))
  assert.equal(conPuntero.motivos.some((m) => m.id === 'deposito'), false)
})

test('EC7b · sin obligación no se inventa depósito pendiente', () => {
  // Los flags legacy dirían "Pendiente"; acá no hay nada que depositar.
  const r = estadoContable({
    estado: 'entregado',
    tipoCliente: 'contado',
    cobroContraEntrega: { aplica: false },
    confirmacion: { precioFinalCordobas: 130 },
    pagoDelivery: { quienPaga: 'entrega', deducirDelCobroContraEntrega: false },
    cobrosMotorizado: { delivery: { monto: 130, recibio: false, justificacion: 'x' } },
    cobroDelivery: { estado: 'pendiente', monto: 130 },
    registro: null,
  })
  assert.equal(r.motivos.some((m) => m.id === 'deposito'), false)
  // Lo vivo es el cobro y, porque el motorizado declaró no haberlo recibido
  // sin que nadie lo clasificara todavía, también la incidencia. Ninguno de
  // los dos es un depósito.
  assert.deepEqual(r.motivos.map((m) => m.id), ['delivery', 'incidencia'])
})
