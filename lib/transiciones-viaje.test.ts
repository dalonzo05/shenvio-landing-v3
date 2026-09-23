// VIAJE-ENTREGADO-SIN-COBRO-1 — suite focal del contrato de transiciones.
//
// Lo que se fija: los cuatro estados operativos no los escribe el gestor ni el
// admin desde cliente; `retirado` y `entregado` no los escribe nadie desde
// cliente; y el motorizado solo manda las dos señales, sin saltos. Además, que
// este bloque NO cambia la fórmula financiera: VE17 deja constancia de que
// `calcularDeposito` se comporta igual que antes.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  esEstadoOperativoDelMotorizado,
  esEstadoServerAuthoritative,
  puedeMotorizadoCambiarEstadoCliente,
  puedeGestorCambiarEstadoCliente,
  ESTADOS_OPERATIVOS_VIAJE,
  ESTADOS_SERVER_AUTHORITATIVE,
  TRANSICIONES_CLIENTE_MOTORIZADO,
  MSG_ESTADO_OPERATIVO_DEL_MOTORIZADO,
} from './transiciones-viaje'
import { calcularDeposito } from './calculo-deposito'
import { esEstadoCerrado, esEstadoReactivable, esTerminalDefinitivo, ESTADO_TRAS_REACTIVAR } from './estados-solicitud'
import type { EntradaDepositoOrden } from './deposito-orden'

const ADMINISTRATIVOS = ['pendiente_confirmacion', 'confirmada', 'asignada', 'rechazada', 'cancelada']

test('VE1 · el gestor no puede llevar una orden a entregado desde cliente', () => {
  assert.equal(puedeGestorCambiarEstadoCliente('entregado'), false)
  assert.equal(puedeGestorCambiarEstadoCliente('retirado'), false)
  assert.equal(puedeGestorCambiarEstadoCliente('en_camino_retiro'), false)
  assert.equal(puedeGestorCambiarEstadoCliente('en_camino_entrega'), false)
})

test('VE2 · el admin no tiene excepción: la política no conoce roles privilegiados', () => {
  // La función no recibe rol a propósito. Si mañana alguien quisiera un
  // `if (admin)`, tendría que cambiar la firma, y eso se ve en el diff.
  assert.equal(puedeGestorCambiarEstadoCliente.length, 1)
  for (const destino of ESTADOS_OPERATIVOS_VIAJE) {
    assert.equal(puedeGestorCambiarEstadoCliente(destino), false, destino)
  }
  // Lo administrativo sigue disponible para los dos roles.
  for (const destino of ADMINISTRATIVOS) {
    assert.equal(puedeGestorCambiarEstadoCliente(destino), true, destino)
  }
})

test('VE3 · retirado es server-authoritative', () => {
  assert.equal(esEstadoServerAuthoritative('retirado'), true)
})

test('VE4 · entregado es server-authoritative', () => {
  assert.equal(esEstadoServerAuthoritative('entregado'), true)
  assert.deepEqual([...ESTADOS_SERVER_AUTHORITATIVE], ['retirado', 'entregado'])
})

test('VE5 · motorizado: asignada → en_camino_retiro es una señal suya', () => {
  assert.equal(puedeMotorizadoCambiarEstadoCliente('asignada', 'en_camino_retiro'), true)
})

test('VE6 · motorizado: retirado → en_camino_entrega también', () => {
  assert.equal(puedeMotorizadoCambiarEstadoCliente('retirado', 'en_camino_entrega'), true)
  assert.deepEqual(TRANSICIONES_CLIENTE_MOTORIZADO, { asignada: 'en_camino_retiro', retirado: 'en_camino_entrega' })
})

test('VE7 · en_camino_retiro → retirado NO es cliente: hay cobro de por medio', () => {
  assert.equal(puedeMotorizadoCambiarEstadoCliente('en_camino_retiro', 'retirado'), false)
})

test('VE8 · en_camino_entrega → entregado NO es cliente: cierra el dinero', () => {
  assert.equal(puedeMotorizadoCambiarEstadoCliente('en_camino_entrega', 'entregado'), false)
})

test('VE9 · asignada → entregado: salto imposible', () => {
  assert.equal(puedeMotorizadoCambiarEstadoCliente('asignada', 'entregado'), false)
})

test('VE10 · asignada → en_camino_entrega: salto imposible', () => {
  assert.equal(puedeMotorizadoCambiarEstadoCliente('asignada', 'en_camino_entrega'), false)
  // Y ningún otro par inventado pasa.
  for (const origen of [...ADMINISTRATIVOS, ...ESTADOS_OPERATIVOS_VIAJE]) {
    for (const destino of [...ADMINISTRATIVOS, ...ESTADOS_OPERATIVOS_VIAJE]) {
      const esperado = TRANSICIONES_CLIENTE_MOTORIZADO[origen] === destino
      assert.equal(puedeMotorizadoCambiarEstadoCliente(origen, destino), esperado, `${origen} → ${destino}`)
    }
  }
  // Entradas vacías o ausentes no habilitan nada.
  assert.equal(puedeMotorizadoCambiarEstadoCliente('', 'en_camino_retiro'), false)
  assert.equal(puedeMotorizadoCambiarEstadoCliente('asignada', ''), false)
  assert.equal(puedeMotorizadoCambiarEstadoCliente(null, null), false)
  assert.equal(puedeGestorCambiarEstadoCliente(undefined), false)
})

test('VE11 · el estado financiero no participa en la decisión operativa', () => {
  // La política solo recibe estados de viaje: no hay forma de que un cobro
  // pagado, un depósito en revisión o una deuda cambien el resultado.
  assert.equal(puedeMotorizadoCambiarEstadoCliente.length, 2)
  for (const financiero of ['pagado', 'pendiente', 'en_revision', 'confirmado', 'devuelto', 'anulado', 'convertido_en_deuda']) {
    assert.equal(esEstadoOperativoDelMotorizado(financiero), false, financiero)
    assert.equal(esEstadoServerAuthoritative(financiero), false, financiero)
  }
})

test('VE12 · no se toca el cálculo del depósito: este bloque cierra una puerta', () => {
  // Control explícito: el helper de transiciones no exporta nada que pueda
  // alterar montos ni obligaciones.
  const exportado = JSON.stringify([...ESTADOS_OPERATIVOS_VIAJE, ...ESTADOS_SERVER_AUTHORITATIVE])
  assert.ok(!/monto|deposito|cobro|C\$/i.test(exportado))
})

test('VE13 · el tipo C no participa: no es un estado de viaje', () => {
  assert.equal(esEstadoOperativoDelMotorizado('pago_delivery_deposito'), false)
  assert.equal(esEstadoServerAuthoritative('pago_delivery_deposito'), false)
  assert.equal(puedeGestorCambiarEstadoCliente('pago_delivery_deposito'), true, 'no es asunto de esta política')
})

test('VE14 · los terminales siguen como estaban', () => {
  assert.equal(esTerminalDefinitivo('entregado'), true)
  assert.equal(esEstadoCerrado('entregado'), true)
  assert.equal(esEstadoCerrado('rechazada'), true)
  assert.equal(esEstadoCerrado('cancelada'), true)
  assert.equal(esEstadoCerrado('asignada'), false)
})

test('VE15 · los reactivables siguen como estaban', () => {
  assert.equal(esEstadoReactivable('rechazada'), true)
  assert.equal(esEstadoReactivable('cancelada'), true)
  assert.equal(esEstadoReactivable('entregado'), false)
  assert.equal(ESTADO_TRAS_REACTIVAR, 'pendiente_confirmacion')
  // Reactivar sigue siendo una transición administrativa permitida.
  assert.equal(puedeGestorCambiarEstadoCliente(ESTADO_TRAS_REACTIVAR), true)
})

test('VE16 · una sola política para las cuatro superficies del gestor', () => {
  // Listado, ficha, drawer y base-datos consultan estas dos funciones; no hay
  // una lista paralela de estados "seguros" que pueda quedar desalineada.
  for (const destino of ESTADOS_OPERATIVOS_VIAJE) {
    assert.equal(puedeGestorCambiarEstadoCliente(destino), false)
    assert.equal(esEstadoOperativoDelMotorizado(destino), true)
  }
  assert.equal(MSG_ESTADO_OPERATIVO_DEL_MOTORIZADO, 'Este estado lo registra el motorizado desde su panel.')
})

test('VE17 · calcularDeposito sin cobrosMotorizado mantiene el resultado de hoy', () => {
  // Este bloque NO arregla el síntoma cambiando la fórmula: cierra la puerta
  // que fabrica el dato inválido. Si alguien tocara calculo-deposito.ts, este
  // caso lo delata.
  const orden = {
    estado: 'entregado',
    tipoCliente: 'contado',
    confirmacion: { precioFinalCordobas: 90 },
    pagoDelivery: { quienPaga: 'entrega', montoSugerido: 90, deducirDelCobroContraEntrega: false, tipo: 'contado' },
    cobroContraEntrega: { aplica: true, monto: 1000 },
    registro: { deposito: null },
  } as EntradaDepositoOrden
  const sinCobros = calcularDeposito(orden)
  assert.equal(sinCobros.totalAStorkhub, 90)
  assert.equal(sinCobros.totalAlComercio, 1000)
  // Y con la confirmación real de que NO cobró el delivery, sigue bajando a 0.
  const noRecibio = calcularDeposito({
    ...orden,
    cobrosMotorizado: { delivery: { monto: 90, recibio: false }, producto: { monto: 1000, recibio: true } },
  } as EntradaDepositoOrden)
  assert.equal(noRecibio.totalAStorkhub, 0)
  assert.equal(noRecibio.totalAlComercio, 1000)
})
