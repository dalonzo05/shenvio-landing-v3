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
  rutaTransicionMotorizado,
  efectosCambioAdministrativo,
  puedeGestorCancelarDesde,
  ORIGENES_CANCELABLES_POR_GESTOR,
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

// ─── VU · Por dónde sale cada transición del panel del motorizado ────────────
//
// El E2E de SH-0007: el botón "Paquete recogido" llamaba a la callable SOLO
// cuando había un cobro que confirmar en la recolección. En el caso corriente
// —`quienPaga: 'entrega'`, nada que cobrar al recoger— caía en el updateDoc del
// cliente, que VR7 deniega: el SDK lo aplicaba local y el servidor lo revertía,
// y en pantalla el estado "cambiaba y volvía". Las Rules no se tocaron; lo que
// cambió es que el retiro pasa por la Function con cobro o sin él.

test('VU1 · retirado sin nada que confirmar va DIRECTO a la Function', () => {
  // Este es el caso que estaba roto: el retiro corriente.
  assert.equal(rutaTransicionMotorizado('retirado', { showDelivery: false, showProducto: false, showCargotransCobro: false }), 'function')
  // Y sin pasarle flags tampoco se cae al cliente: el default es seguro.
  assert.equal(rutaTransicionMotorizado('retirado'), 'function')
})

test('VU2 · retirado con un cobro que confirmar pasa por el modal, y después la Function', () => {
  // Cualquiera de los tres flags basta; ninguno devuelve la orden al cliente.
  assert.equal(rutaTransicionMotorizado('retirado', { showDelivery: true, showProducto: false, showCargotransCobro: false }), 'modal')
  assert.equal(rutaTransicionMotorizado('retirado', { showDelivery: false, showProducto: true, showCargotransCobro: false }), 'modal')
  assert.equal(rutaTransicionMotorizado('retirado', { showDelivery: false, showProducto: false, showCargotransCobro: true }), 'modal')
})

test('VU3 · entregado conserva su contrato: Function siempre, modal si hay cobro', () => {
  // B2-PAGO-MEDIO ya lo había centralizado; este bloque no lo mueve.
  assert.equal(rutaTransicionMotorizado('entregado', { showDelivery: false, showProducto: false, showCargotransCobro: false }), 'function')
  assert.equal(rutaTransicionMotorizado('entregado'), 'function')
  assert.equal(rutaTransicionMotorizado('entregado', { showDelivery: true, showProducto: true, showCargotransCobro: false }), 'modal')
})

test('VU4 · las dos señales siguen siendo updateDoc del cliente', () => {
  // VR5 y VR6 las permiten en Rules; no hay razón para pagar una callable por
  // avisar que vas en camino, y meterlas acá rompería el viaje del motorizado.
  for (const señal of ['en_camino_retiro', 'en_camino_entrega']) {
    assert.equal(rutaTransicionMotorizado(señal, { showDelivery: false, showProducto: false, showCargotransCobro: false }), 'cliente', señal)
    // Ni siquiera con flags encendidos: una señal no confirma dinero.
    assert.equal(rutaTransicionMotorizado(señal, { showDelivery: true, showProducto: true, showCargotransCobro: true }), 'cliente', señal)
  }
})

test('VU5 · ningún camino del cliente termina escribiendo un estado server-authoritative', () => {
  // Barrido exhaustivo de las ocho combinaciones de flags por estado: los dos
  // que cierran dinero nunca devuelven 'cliente', y los demás nunca llaman a la
  // Function. Si alguien reabriera el atajo, este caso lo delata.
  const BOOLS = [false, true]
  for (const showDelivery of BOOLS) {
    for (const showProducto of BOOLS) {
      for (const showCargotransCobro of BOOLS) {
        const flags = { showDelivery, showProducto, showCargotransCobro }
        const etiqueta = JSON.stringify(flags)
        for (const destino of ESTADOS_SERVER_AUTHORITATIVE) {
          const ruta = rutaTransicionMotorizado(destino, flags)
          assert.notEqual(ruta, 'cliente', destino + ' ' + etiqueta)
          assert.equal(
            ruta,
            showDelivery || showProducto || showCargotransCobro ? 'modal' : 'function',
            destino + ' ' + etiqueta,
          )
        }
        for (const señal of ['en_camino_retiro', 'en_camino_entrega', ...ADMINISTRATIVOS]) {
          assert.equal(rutaTransicionMotorizado(señal, flags), 'cliente', señal + ' ' + etiqueta)
        }
      }
    }
  }
  // Entradas vacías no habilitan la Function.
  assert.equal(rutaTransicionMotorizado(''), 'cliente')
  assert.equal(rutaTransicionMotorizado(null), 'cliente')
  assert.equal(rutaTransicionMotorizado(undefined), 'cliente')
})

// ─── VC · VIAJE-CANCELACION-CONSISTENCIA-1 ────────────────────────────────────
//
// Cancelar y devolver `asignada → confirmada` son desasignaciones: la orden no
// puede quedar vinculada a un motorizado que ya no la tiene.

const TODOS_LOS_ESTADOS = [...ADMINISTRATIVOS, ...ESTADOS_OPERATIVOS_VIAJE]

// El contrato es solo sobre la solicitud: la disponibilidad del motorizado no se
// deriva de una sola orden (puede tener varias) y por eso el helper no la decide.

test('VC1 · asignada → confirmada limpia la asignación y no decide nada sobre el motorizado', () => {
  assert.deepEqual(efectosCambioAdministrativo('asignada', 'confirmada', true), {
    limpiarAsignacion: true,
    registrarCanceladaAt: false,
  })
})

test('VC2 · asignada → cancelada limpia la asignación y registra la cancelación, sin decidir disponibilidad', () => {
  assert.deepEqual(efectosCambioAdministrativo('asignada', 'cancelada', true), {
    limpiarAsignacion: true,
    registrarCanceladaAt: true,
  })
})

test('VC3 · confirmada → cancelada sin asignación registra la cancelación y no toca perfiles', () => {
  assert.deepEqual(efectosCambioAdministrativo('confirmada', 'cancelada', false), {
    limpiarAsignacion: false,
    registrarCanceladaAt: true,
  })
})

test('VC4 · confirmada → cancelada con asignación residual la limpia y registra la cancelación', () => {
  assert.deepEqual(efectosCambioAdministrativo('confirmada', 'cancelada', true), {
    limpiarAsignacion: true,
    registrarCanceladaAt: true,
  })
})

test('VC5 · el helper nunca devuelve ocupado ni disponible: ese concepto no es parte de su contrato', () => {
  for (const origen of TODOS_LOS_ESTADOS) {
    for (const destino of TODOS_LOS_ESTADOS) {
      for (const tiene of [true, false]) {
        const efectos = efectosCambioAdministrativo(origen, destino, tiene)
        assert.deepEqual(Object.keys(efectos).sort(), ['limpiarAsignacion', 'registrarCanceladaAt'], `${origen} → ${destino}`)
        assert.ok(!JSON.stringify(efectos).includes('ocupado'), `${origen} → ${destino}`)
        assert.ok(!JSON.stringify(efectos).includes('disponible'), `${origen} → ${destino}`)
      }
    }
  }
})

test('VC6 · una transición administrativa no relacionada no recibe efectos nuevos', () => {
  const sinEfectos = { limpiarAsignacion: false, registrarCanceladaAt: false }
  const casos: [string, string][] = [
    ['pendiente_confirmacion', 'confirmada'],
    ['pendiente_confirmacion', 'rechazada'],
    ['confirmada', 'asignada'],
    ['confirmada', 'confirmada'],
    ['rechazada', 'pendiente_confirmacion'],
    ['cancelada', 'pendiente_confirmacion'],
    ['asignada', 'asignada'],
  ]
  for (const [origen, destino] of casos) {
    for (const tiene of [true, false]) {
      assert.deepEqual(efectosCambioAdministrativo(origen, destino, tiene), sinEfectos, `${origen} → ${destino}`)
    }
  }
  // Entradas vacías tampoco inventan efectos.
  assert.deepEqual(efectosCambioAdministrativo(null, undefined, true), sinEfectos)
  // Solo asignada → confirmada es desasignación: confirmar desde otro origen no.
  assert.deepEqual(efectosCambioAdministrativo('pendiente_confirmacion', 'confirmada', true), sinEfectos)
})

test('VC7 · el Gestor no cancela una operación en curso: en_camino_retiro no es un origen cancelable', () => {
  assert.deepEqual([...ORIGENES_CANCELABLES_POR_GESTOR], ['pendiente_confirmacion', 'confirmada', 'asignada'])
  for (const origen of ['pendiente_confirmacion', 'confirmada', 'asignada']) {
    assert.equal(puedeGestorCancelarDesde(origen), true, origen)
  }
  for (const origen of [...ESTADOS_OPERATIVOS_VIAJE, 'rechazada', 'cancelada', '', null, undefined]) {
    assert.equal(puedeGestorCancelarDesde(origen), false, String(origen))
  }
})
