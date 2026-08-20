// B1.3 — Suite focal de lib/calculo-deposito.ts
//
// Usa el runner nativo de Node (node:test). No agrega ninguna dependencia:
// `npm test` compila este archivo y el módulo con el TypeScript que el repo
// ya tiene, y los corre. Ver el script "test" de package.json.
//
// Casos A–M del bloque B1.3. Los casos que documentan un defecto conocido y
// NO corregido en este bloque están marcados PENDIENTE con su bloque destino:
// el test fija el comportamiento actual para que el cambio futuro sea visible,
// no para bendecirlo.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  calcularDeposito,
  JUSTIFICACION_DEFER_DELIVERY,
  type EntradaCalculoDeposito,
} from './calculo-deposito'

/** Orden base: sin producto, sin delivery, nada cobrado. */
function orden(over: Partial<EntradaCalculoDeposito> = {}): EntradaCalculoDeposito {
  return {
    cobroContraEntrega: { aplica: false, monto: 0 },
    confirmacion: { precioFinalCordobas: 0 },
    pagoDelivery: { quienPaga: 'entrega', deducirDelCobroContraEntrega: false },
    tipoServicio: 'managua',
    tipoCliente: 'contado',
    cobrosMotorizado: null,
    ...over,
  }
}

// ── A. Solo delivery en efectivo ────────────────────────────────────────────
test('A · solo delivery efectivo recibido', () => {
  const r = calcularDeposito(orden({ confirmacion: { precioFinalCordobas: 100 } }))
  assert.equal(r.totalAlComercio, 0)
  assert.equal(r.totalAStorkhub, 100)
  assert.equal(r.montoTotal, 100)
  assert.equal(r.tieneDelivery, true)
})

// ── B. Producto + delivery ──────────────────────────────────────────────────
test('B · producto + delivery efectivo, sin deducción', () => {
  const r = calcularDeposito(orden({
    cobroContraEntrega: { aplica: true, monto: 1000 },
    confirmacion: { precioFinalCordobas: 100 },
  }))
  assert.equal(r.totalAlComercio, 1000)
  assert.equal(r.totalAStorkhub, 100)
  assert.equal(r.montoTotal, 1100)
})

// ── C. Delivery pagado por transferencia ────────────────────────────────────
test('C · delivery por transferencia: el motorizado no lo recauda', () => {
  const r = calcularDeposito(orden({
    cobroContraEntrega: { aplica: true, monto: 1000 },
    confirmacion: { precioFinalCordobas: 100 },
    pagoDelivery: { quienPaga: 'transferencia' },
  }))
  assert.equal(r.totalAlComercio, 1000)
  assert.equal(r.totalAStorkhub, 0)
  assert.equal(r.deliveryPorTransferencia, true)
})

test('C2 · delivery en crédito semanal: tampoco se recauda', () => {
  const r = calcularDeposito(orden({
    confirmacion: { precioFinalCordobas: 100 },
    pagoDelivery: { quienPaga: 'credito_semanal' },
  }))
  assert.equal(r.totalAStorkhub, 0)
  assert.equal(r.tieneDelivery, false)
})

test('C3 · tipoCliente credito equivale a crédito semanal', () => {
  const r = calcularDeposito(orden({
    confirmacion: { precioFinalCordobas: 100 },
    tipoCliente: 'credito',
  }))
  assert.equal(r.totalAStorkhub, 0)
})

// ── D. Delivery deducido del cobro contra entrega ───────────────────────────
test('D · delivery deducido del CE', () => {
  const r = calcularDeposito(orden({
    cobroContraEntrega: { aplica: true, monto: 1000 },
    confirmacion: { precioFinalCordobas: 100 },
    pagoDelivery: { quienPaga: 'entrega', deducirDelCobroContraEntrega: true },
  }))
  assert.equal(r.totalAlComercio, 900)
  assert.equal(r.totalAStorkhub, 100)
  // El cliente entregó 1000 y el sistema reparte exactamente 1000.
  assert.equal(r.montoTotal, 1000)
})

// ── E/F. Destino del producto ───────────────────────────────────────────────
// El destino (comercio vs StorkHub) NO lo decide este cálculo: se decide en
// la pantalla de Depósitos al agrupar. Acá el producto siempre va al comercio
// y el delivery siempre a StorkHub. Se fija para que quede explícito.
test('E/F · el producto siempre se imputa al comercio y el delivery a StorkHub', () => {
  const r = calcularDeposito(orden({
    cobroContraEntrega: { aplica: true, monto: 500 },
    confirmacion: { precioFinalCordobas: 60 },
  }))
  assert.equal(r.totalAlComercio, 500)
  assert.equal(r.totalAStorkhub, 60)
})

// ── G. delivery.recibio === false ───────────────────────────────────────────
// LA CORRECCIÓN DE B1.3: antes gestor y auditoría ignoraban esto.
test('G · recibio=false excluye el delivery del depósito exigido', () => {
  const r = calcularDeposito(orden({
    confirmacion: { precioFinalCordobas: 100 },
    cobrosMotorizado: { delivery: { recibio: false, justificacion: 'Cliente no tenía efectivo' } },
  }))
  assert.equal(r.tieneDelivery, false)
  assert.equal(r.totalAStorkhub, 0)
  assert.equal(r.montoTotal, 0)
})

test('G2 · el defer NO es un no-cobro: sigue exigiéndose', () => {
  const r = calcularDeposito(orden({
    confirmacion: { precioFinalCordobas: 100 },
    cobrosMotorizado: { delivery: { recibio: false, justificacion: JUSTIFICACION_DEFER_DELIVERY } },
  }))
  assert.equal(r.tieneDelivery, true)
  assert.equal(r.totalAStorkhub, 100)
})

test('G3 · recibio=true no altera nada', () => {
  const r = calcularDeposito(orden({
    confirmacion: { precioFinalCordobas: 100 },
    cobrosMotorizado: { delivery: { recibio: true } },
  }))
  assert.equal(r.totalAStorkhub, 100)
})

// ── H. Producto = 0 ─────────────────────────────────────────────────────────
test('H · sin cobro contra entrega', () => {
  const r = calcularDeposito(orden({
    cobroContraEntrega: { aplica: false, monto: 0 },
    confirmacion: { precioFinalCordobas: 80 },
  }))
  assert.equal(r.totalAlComercio, 0)
  assert.equal(r.totalAStorkhub, 80)
  assert.equal(r.tieneProducto, false)
})

test('H2 · aplica=true pero monto ausente cuenta como 0', () => {
  const r = calcularDeposito(orden({ cobroContraEntrega: { aplica: true } }))
  assert.equal(r.montoProducto, 0)
  assert.equal(r.totalAlComercio, 0)
})

// ── I. Delivery = 0 ─────────────────────────────────────────────────────────
test('I · delivery 0 no genera obligación con StorkHub', () => {
  const r = calcularDeposito(orden({
    cobroContraEntrega: { aplica: true, monto: 400 },
    confirmacion: { precioFinalCordobas: 0 },
  }))
  assert.equal(r.tieneDelivery, false)
  assert.equal(r.totalAStorkhub, 0)
  assert.equal(r.totalAlComercio, 400)
})

// ── J. Producto < delivery, con deducción ───────────────────────────────────
// B1.2 — CORREGIDO. El cliente entregó 100; solo se le exigen 100 al
// motorizado. Los 30 restantes del delivery quedan como faltante a cobrar
// aparte, no como deuda suya.
test('J/D1 · producto < delivery: solo se exige lo recibido', () => {
  const r = calcularDeposito(orden({
    cobroContraEntrega: { aplica: true, monto: 100 },
    confirmacion: { precioFinalCordobas: 130 },
    pagoDelivery: { quienPaga: 'entrega', deducirDelCobroContraEntrega: true },
  }))
  assert.equal(r.totalAlComercio, 0)
  assert.equal(r.totalAStorkhub, 100)
  assert.equal(r.montoTotal, 100)
  assert.equal(r.montoRecibidoReal, 100)
  assert.equal(r.faltanteDelivery, 30)
  assert.equal(r.requiereCobroPosterior, true)
  // El faltante más lo cubierto reconstruyen el delivery completo.
  assert.equal(r.totalAStorkhub + r.faltanteDelivery, 130)
})

// ── K. Producto = delivery ──────────────────────────────────────────────────
test('K · producto igual al delivery: el comercio no recibe nada', () => {
  const r = calcularDeposito(orden({
    cobroContraEntrega: { aplica: true, monto: 120 },
    confirmacion: { precioFinalCordobas: 120 },
    pagoDelivery: { quienPaga: 'entrega', deducirDelCobroContraEntrega: true },
  }))
  assert.equal(r.totalAlComercio, 0)
  assert.equal(r.totalAStorkhub, 120)
  assert.equal(r.montoTotal, 120) // cuadra con lo que entregó el cliente
})

// ── L. Producto > delivery ──────────────────────────────────────────────────
test('L · producto mayor al delivery: reparto exacto', () => {
  const r = calcularDeposito(orden({
    cobroContraEntrega: { aplica: true, monto: 800 },
    confirmacion: { precioFinalCordobas: 150 },
    pagoDelivery: { quienPaga: 'entrega', deducirDelCobroContraEntrega: true },
  }))
  assert.equal(r.totalAlComercio, 650)
  assert.equal(r.totalAStorkhub, 150)
  assert.equal(r.montoTotal, 800)
})

// ── M. Campos legacy / ausentes ─────────────────────────────────────────────
test('M · orden vacía no revienta ni inventa dinero', () => {
  const r = calcularDeposito({})
  assert.equal(r.totalAlComercio, 0)
  assert.equal(r.totalAStorkhub, 0)
  assert.equal(r.montoTotal, 0)
  assert.equal(r.descripcion, 'No recaudó efectivo')
})

test('M2 · nulls explícitos se tratan como ausentes', () => {
  const r = calcularDeposito({
    cobroContraEntrega: null,
    confirmacion: null,
    pagoDelivery: null,
    cobrosMotorizado: null,
  })
  assert.equal(r.montoTotal, 0)
})

test('M3 · fuera_managua cae al montoSugerido si no hay precio confirmado', () => {
  const r = calcularDeposito(orden({
    confirmacion: { precioFinalCordobas: 0 },
    tipoServicio: 'fuera_managua',
    pagoDelivery: { quienPaga: 'recoleccion', montoSugerido: 250 },
  }))
  assert.equal(r.totalAStorkhub, 250)
})

test('M4 · el precio confirmado gana sobre el sugerido', () => {
  const r = calcularDeposito(orden({
    confirmacion: { precioFinalCordobas: 300 },
    tipoServicio: 'fuera_managua',
    pagoDelivery: { quienPaga: 'recoleccion', montoSugerido: 250 },
  }))
  assert.equal(r.totalAStorkhub, 300)
})

test('M5 · el fallback NO aplica dentro de Managua', () => {
  const r = calcularDeposito(orden({
    confirmacion: { precioFinalCordobas: 0 },
    tipoServicio: 'managua',
    pagoDelivery: { quienPaga: 'entrega', montoSugerido: 250 },
  }))
  assert.equal(r.totalAStorkhub, 0)
})

// ── B1.2 · Caso A — producto no recibido ────────────────────────────────────
test('P1 · producto.recibio=false libera el depósito al comercio', () => {
  const r = calcularDeposito(orden({
    cobroContraEntrega: { aplica: true, monto: 500 },
    cobrosMotorizado: { producto: { recibio: false } },
  }))
  assert.equal(r.tieneProducto, false)
  // No se le exige un producto que declaró no haber cobrado.
  assert.equal(r.totalAlComercio, 0)
  assert.equal(r.montoRecibidoReal, 0)
  assert.equal(r.requiereCobroPosterior, true)
  // El monto declarado se conserva para la incidencia.
  assert.equal(r.montoProducto, 500)
})

test('P2 · producto.recibio=true se exige normalmente', () => {
  const r = calcularDeposito(orden({
    cobroContraEntrega: { aplica: true, monto: 500 },
    cobrosMotorizado: { producto: { recibio: true } },
  }))
  assert.equal(r.tieneProducto, true)
  assert.equal(r.totalAlComercio, 500)
  assert.equal(r.requiereCobroPosterior, false)
})

test('P3 · sin campo producto se exige normalmente', () => {
  const r = calcularDeposito(orden({
    cobroContraEntrega: { aplica: true, monto: 500 },
    cobrosMotorizado: null,
  }))
  assert.equal(r.totalAlComercio, 500)
  assert.equal(r.requiereCobroPosterior, false)
})

// ── B1.2 · Caso B — matriz producto vs delivery con deducción ───────────────
const conDeduccion = (prod: number, del: number) => calcularDeposito(orden({
  cobroContraEntrega: { aplica: prod > 0, monto: prod },
  confirmacion: { precioFinalCordobas: del },
  pagoDelivery: { quienPaga: 'entrega', deducirDelCobroContraEntrega: true },
}))

test('D2 · producto = delivery: cubre exacto, sin faltante', () => {
  const r = conDeduccion(130, 130)
  assert.equal(r.totalAlComercio, 0)
  assert.equal(r.totalAStorkhub, 130)
  assert.equal(r.faltanteDelivery, 0)
})

test('D3 · producto > delivery: el remanente va al comercio', () => {
  const r = conDeduccion(200, 130)
  assert.equal(r.totalAlComercio, 70)
  assert.equal(r.totalAStorkhub, 130)
  assert.equal(r.faltanteDelivery, 0)
  assert.equal(r.montoTotal, 200)
})

test('D4 · producto 0 / delivery 130: no se exige nada al motorizado', () => {
  const r = conDeduccion(0, 130)
  assert.equal(r.totalAlComercio, 0)
  assert.equal(r.totalAStorkhub, 0)
  assert.equal(r.faltanteDelivery, 130)
  assert.equal(r.montoRecibidoReal, 0)
})

test('D5 · producto 100 / delivery 0: todo al comercio', () => {
  const r = conDeduccion(100, 0)
  assert.equal(r.totalAlComercio, 100)
  assert.equal(r.totalAStorkhub, 0)
  assert.equal(r.faltanteDelivery, 0)
})

// ── B1.2 · combinaciones de incidencias ─────────────────────────────────────
test('D6 · delivery no recibido + producto recibido', () => {
  const r = calcularDeposito(orden({
    cobroContraEntrega: { aplica: true, monto: 500 },
    confirmacion: { precioFinalCordobas: 100 },
    cobrosMotorizado: {
      delivery: { recibio: false, justificacion: 'El cliente no tenía efectivo' },
      producto: { recibio: true },
    },
  }))
  assert.equal(r.totalAlComercio, 500)
  assert.equal(r.totalAStorkhub, 0)
})

test('D7 · producto no recibido + delivery recibido', () => {
  const r = calcularDeposito(orden({
    cobroContraEntrega: { aplica: true, monto: 500 },
    confirmacion: { precioFinalCordobas: 100 },
    cobrosMotorizado: {
      delivery: { recibio: true },
      producto: { recibio: false, justificacion: 'El cliente rechazó el producto' },
    },
  }))
  assert.equal(r.totalAlComercio, 0)
  assert.equal(r.totalAStorkhub, 100)
  assert.equal(r.montoRecibidoReal, 100)
})

test('D8 · ambos no recibidos: no se exige nada', () => {
  const r = calcularDeposito(orden({
    cobroContraEntrega: { aplica: true, monto: 500 },
    confirmacion: { precioFinalCordobas: 100 },
    cobrosMotorizado: {
      delivery: { recibio: false, justificacion: 'El cliente no estaba / no atendió' },
      producto: { recibio: false, justificacion: 'El cliente no estaba / no atendió' },
    },
  }))
  assert.equal(r.montoTotal, 0)
  assert.equal(r.montoRecibidoReal, 0)
})

// Estado legacy: no alcanzable por el flujo actual (con deducción no se le
// pregunta al motorizado por el delivery), pero sí posible en documentos
// viejos o por edición manual del gestor. Antes descontaba al comercio un
// delivery que nadie cobró; ahora la deducción usa el monto real.
test('D9 · legacy: deducir + delivery.recibio=false no descuenta al comercio', () => {
  const r = calcularDeposito(orden({
    cobroContraEntrega: { aplica: true, monto: 1000 },
    confirmacion: { precioFinalCordobas: 100 },
    pagoDelivery: { quienPaga: 'entrega', deducirDelCobroContraEntrega: true },
    cobrosMotorizado: { delivery: { recibio: false, justificacion: 'El cliente no tenía efectivo' } },
  }))
  // El comercio recibe su producto completo: el delivery nunca entró en caja.
  assert.equal(r.totalAlComercio, 1000)
  assert.equal(r.totalAStorkhub, 0)
  assert.equal(r.montoTotal, r.montoRecibidoReal)
})

// ── B1.2 · INVARIANTE CENTRAL ───────────────────────────────────────────────
// El principio del bloque, verificado sobre toda la matriz representativa.
test('INV · nunca se exige más de lo recibido, y el faltante nunca es negativo', () => {
  const montos = [0, 50, 100, 130, 200]
  const incidencias = [
    null,
    { producto: { recibio: false as const, justificacion: 'x' } },
    { delivery: { recibio: false as const, justificacion: 'x' } },
    { delivery: { recibio: false as const, justificacion: 'x' }, producto: { recibio: false as const, justificacion: 'x' } },
  ]
  let combinaciones = 0
  for (const prod of montos) {
    for (const del of montos) {
      for (const deducir of [true, false]) {
        for (const cobros of incidencias) {
          const r = calcularDeposito({
            cobroContraEntrega: { aplica: prod > 0, monto: prod },
            confirmacion: { precioFinalCordobas: del },
            pagoDelivery: { quienPaga: 'entrega', deducirDelCobroContraEntrega: deducir },
            tipoServicio: 'managua',
            tipoCliente: 'contado',
            cobrosMotorizado: cobros,
          })
          const ctx = `prod=${prod} del=${del} deducir=${deducir} cobros=${JSON.stringify(cobros)}`
          assert.ok(
            r.totalAlComercio + r.totalAStorkhub <= r.montoRecibidoReal,
            `se exige más de lo recibido — ${ctx}`,
          )
          assert.ok(r.faltanteDelivery >= 0, `faltante negativo — ${ctx}`)
          assert.ok(r.totalAlComercio >= 0 && r.totalAStorkhub >= 0, `negativo — ${ctx}`)
          // Con deducción, lo cubierto más lo faltante reconstruyen el delivery cobrable.
          if (deducir) {
            assert.equal(
              r.totalAStorkhub + r.faltanteDelivery, r.montoDelivery,
              `cubierto + faltante != delivery — ${ctx}`,
            )
          }
          combinaciones++
        }
      }
    }
  }
  assert.equal(combinaciones, 200)
})
