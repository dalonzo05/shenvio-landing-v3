// B1.2F — Suite focal de lib/incidencia-cobro.ts
//
// El caso de referencia es el E2E real de staging: CE 500, delivery 150,
// deducirDelCobroContraEntrega = true, el motorizado no recibió nada.
// Cobros mostraba C$650 sumando el espejo del delivery al producto.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  resumirIncidencia,
  esDeliveryDeducido,
  deliverySinClasificar,
  productoSinClasificar,
  hayIncidenciaSinClasificar,
  tieneResolucion,
  resolucionPrincipal,
  etiquetaResolucion,
  detalleIncidencia,
  type EntradaIncidencia,
} from './incidencia-cobro'

/**
 * Réplica del documento real. Con deducción la Function espeja la respuesta
 * del producto sobre el delivery, así que ambos submapas comparten `recibio`,
 * `justificacion` y `at`.
 */
function ordenDeducida(over: Partial<EntradaIncidencia> = {}): EntradaIncidencia {
  return {
    pagoDelivery: { deducirDelCobroContraEntrega: true },
    confirmacion: { precioFinalCordobas: 150 },
    cobrosMotorizado: {
      producto: { monto: 500, recibio: false, justificacion: 'D' },
      delivery: { monto: 150, recibio: false, justificacion: 'D' },
    },
    ...over,
  }
}

function ordenSinDeducir(over: Partial<EntradaIncidencia> = {}): EntradaIncidencia {
  return {
    pagoDelivery: { deducirDelCobroContraEntrega: false },
    confirmacion: { precioFinalCordobas: 150 },
    cobrosMotorizado: {
      producto: { monto: 500, recibio: false, justificacion: 'x' },
      delivery: { monto: 150, recibio: false, justificacion: 'y' },
    },
    ...over,
  }
}

// ── T1 ──────────────────────────────────────────────────────────────────────
test('T1 · 500/150 deducido: la incidencia es 500, no 650', () => {
  const r = resumirIncidencia(ordenDeducida())
  assert.equal(r.monto, 500)
  assert.notEqual(r.monto, 650)
  assert.equal(r.deliveryDerivado, true)
})

test('T1b · el desglose interno suma exactamente el CE', () => {
  const r = resumirIncidencia(ordenDeducida())
  assert.equal(r.componenteDelivery, 150)
  assert.equal(r.componenteComercio, 350)
  assert.equal(r.componenteDelivery + r.componenteComercio, 500)
})

// ── T2 ──────────────────────────────────────────────────────────────────────
test('T2 · el label no dice "Delivery + Producto"', () => {
  const r = resumirIncidencia(ordenDeducida())
  assert.equal(r.tipo, 'Cobro contra entrega')
  assert.equal(r.tipo.includes('+'), false)
  assert.match(r.detalle ?? '', /Incluye delivery/)
})

// ── T3 / T4 · resolución del CE ─────────────────────────────────────────────
// El delivery NO es un ítem clasificable cuando va deducido: hubo un solo
// evento. La única clasificación posible es la del CE.
test('T3 · deducido: solo el producto queda por clasificar', () => {
  const o = ordenDeducida()
  assert.equal(deliverySinClasificar(o), false)
  assert.equal(productoSinClasificar(o), true)
  assert.deepEqual(resumirIncidencia(o).itemsAbiertos, ['producto'])
})

test('T3b · clasificado el CE, no queda incidencia sin clasificar', () => {
  // Espeja lo que escribe ResolveModal: resolución sobre el submapa producto.
  const o = ordenDeducida({
    cobrosMotorizado: {
      producto: { monto: 500, recibio: false, justificacion: 'D', resolucion: { tipo: 'cliente_pagara' } },
      delivery: { monto: 150, recibio: false, justificacion: 'D' },
    },
  })
  assert.equal(hayIncidenciaSinClasificar(o), false)
  assert.deepEqual(resumirIncidencia(o).itemsAbiertos, [])
})

test('T4 · "se pierde" tampoco reabre el delivery como incidencia', () => {
  const o = ordenDeducida({
    cobrosMotorizado: {
      producto: { monto: 500, recibio: false, justificacion: 'D', resolucion: { tipo: 'se_pierde' } },
      delivery: { monto: 150, recibio: false, justificacion: 'D' },
    },
  })
  assert.equal(hayIncidenciaSinClasificar(o), false)
  assert.equal(deliverySinClasificar(o), false)
})

// ── T5 · sin deducción son dos cobros reales ────────────────────────────────
test('T5 · 500/150 sin deducir: 650 y dos incidencias', () => {
  const r = resumirIncidencia(ordenSinDeducir())
  assert.equal(r.monto, 650)
  assert.equal(r.tipo, 'Delivery + Producto')
  assert.equal(r.deliveryDerivado, false)
  assert.deepEqual(r.itemsAbiertos, ['delivery', 'producto'])
})

// ── T6 · sin deducción, resolver una no cierra la otra ──────────────────────
test('T6 · sin deducir: resuelto el producto, el delivery sigue abierto', () => {
  const o = ordenSinDeducir({
    cobrosMotorizado: {
      producto: { monto: 500, recibio: false, justificacion: 'x', resolucion: { tipo: 'se_pierde' } },
      delivery: { monto: 150, recibio: false, justificacion: 'y' },
    },
  })
  assert.equal(productoSinClasificar(o), false)
  assert.equal(deliverySinClasificar(o), true)
  assert.equal(hayIncidenciaSinClasificar(o), true)
})

test('T6b · sin deducir: resuelto el delivery, el producto sigue abierto', () => {
  const o = ordenSinDeducir({
    cobrosMotorizado: {
      producto: { monto: 500, recibio: false, justificacion: 'x' },
      delivery: { monto: 150, recibio: false, justificacion: 'y' },
      resolucion: { tipo: 'cliente_pagara' },
    },
  })
  assert.equal(deliverySinClasificar(o), false)
  assert.equal(productoSinClasificar(o), true)
  assert.equal(hayIncidenciaSinClasificar(o), true)
})

// ── T7 · producto menor que el delivery ─────────────────────────────────────
test('T7 · 100/150 deducido: incidencia 100, no 250', () => {
  const r = resumirIncidencia(ordenDeducida({
    cobrosMotorizado: {
      producto: { monto: 100, recibio: false, justificacion: 'D' },
      delivery: { monto: 150, recibio: false, justificacion: 'D' },
    },
  }))
  assert.equal(r.monto, 100)
  // El CE no alcanza a cubrir el delivery: todo el CE es componente delivery.
  assert.equal(r.componenteDelivery, 100)
  assert.equal(r.componenteComercio, 0)
  assert.equal(r.componenteDelivery + r.componenteComercio, r.monto)
})

// ── T8 · legacy ─────────────────────────────────────────────────────────────
test('T8 · sin pagoDelivery: se trata como no deducido', () => {
  const o: EntradaIncidencia = {
    cobrosMotorizado: { producto: { monto: 500, recibio: false } },
  }
  assert.equal(esDeliveryDeducido(o), false)
  assert.equal(resumirIncidencia(o).monto, 500)
})

test('T8b · orden sin incidencias', () => {
  const r = resumirIncidencia({
    pagoDelivery: { deducirDelCobroContraEntrega: true },
    cobrosMotorizado: { producto: { monto: 500, recibio: true }, delivery: { monto: 150, recibio: true } },
  })
  assert.equal(r.monto, 0)
  assert.equal(r.tipo, '—')
  assert.deepEqual(r.itemsAbiertos, [])
})

test('T8c · documento vacío no revienta', () => {
  const r = resumirIncidencia({})
  assert.equal(r.monto, 0)
  assert.equal(r.tipo, '—')
})

// ══ B1.2H · incidencias resueltas ═══════════════════════════════════════════
// Réplica del documento real tras el E2E de resolución: la clasificación quedó
// en producto.resolucion, y cobrosMotorizado.resolucion NUNCA se escribió.
function ordenResuelta(tipo: 'cliente_pagara' | 'se_pierde' = 'cliente_pagara'): EntradaIncidencia {
  return ordenDeducida({
    cobrosMotorizado: {
      producto: {
        monto: 500, recibio: false, justificacion: 'D', estado: 'pendiente',
        resolucion: { tipo, resueltoPor: 'gestor-1', nota: null },
      },
      delivery: { monto: 150, recibio: false, justificacion: 'D' },
    },
  })
}

test('R1 · producto.resolucion presente → cuenta como resuelta', () => {
  const o = ordenResuelta()
  assert.equal(tieneResolucion(o), true)
  assert.equal(hayIncidenciaSinClasificar(o), false)
  assert.equal(resolucionPrincipal(o)?.tipo, 'cliente_pagara')
})

test('R1b · sin ninguna resolución no cuenta como resuelta', () => {
  assert.equal(tieneResolucion(ordenDeducida()), false)
  assert.equal(resolucionPrincipal(ordenDeducida()), null)
})

test('R2 · Resueltos muestra 500, no 650', () => {
  const r = resumirIncidencia(ordenResuelta())
  assert.equal(r.monto, 500)
  assert.notEqual(r.monto, 650)
  assert.equal(r.tipo, 'Cobro contra entrega')
  assert.match(r.detalle ?? '', /Incluye delivery/)
})

test('R3 · resolver el producto no altera el delivery', () => {
  // El resumen no toca cobroDelivery: la cuenta del comercio vive aparte y
  // sigue su curso en el tab Contado.
  const r = resumirIncidencia(ordenResuelta())
  assert.equal(r.componenteDelivery, 150)
  assert.equal(r.componenteComercio, 350)
})

test('R4 · el producto no genera una cuenta propia de ShEnvíos', () => {
  // Lo único que ShEnvíos cobra es el delivery. El CE queda registrado, no
  // perseguido: por eso la clasificación de "cliente_pagara" no dice "Pasa a
  // Cobros" sino que remite a la relación comercio ↔ cliente.
  assert.equal(etiquetaResolucion(resolucionPrincipal(ordenResuelta())), 'Cliente/comercio lo resolverá')
  assert.equal(etiquetaResolucion(resolucionPrincipal(ordenResuelta('se_pierde'))), 'Se dio por perdido')
  assert.equal(etiquetaResolucion(null), '—')
})

test('R5 · sin deducir: resolución de delivery a nivel de orden sigue contando', () => {
  const o = ordenSinDeducir({
    cobrosMotorizado: {
      producto: { monto: 500, recibio: false, justificacion: 'x' },
      delivery: { monto: 150, recibio: false, justificacion: 'y' },
      resolucion: { tipo: 'cliente_pagara', resueltoPor: 'gestor-1' },
    },
  })
  assert.equal(tieneResolucion(o), true)
  // El producto sigue sin clasificar, así que la incidencia no está cerrada.
  assert.equal(hayIncidenciaSinClasificar(o), true)
})

test('R6 · sin deducir con ambas resueltas', () => {
  const o = ordenSinDeducir({
    cobrosMotorizado: {
      producto: { monto: 500, recibio: false, justificacion: 'x', resolucion: { tipo: 'se_pierde' } },
      delivery: { monto: 150, recibio: false, justificacion: 'y' },
      resolucion: { tipo: 'cliente_pagara' },
    },
  })
  assert.equal(tieneResolucion(o), true)
  assert.equal(hayIncidenciaSinClasificar(o), false)
  // Con ambas, se prefiere la del producto por ser la del monto principal.
  assert.equal(resolucionPrincipal(o)?.tipo, 'se_pierde')
  assert.equal(resumirIncidencia(o).monto, 650)
})

// ══ B2.1 · detalle para la ficha autoritativa ═══════════════════════════════

test('D1f · deducido: un solo ítem por el CE, nunca dos que se sumen', () => {
  const items = detalleIncidencia(ordenResuelta())
  assert.equal(items.length, 1)
  assert.equal(items[0].item, 'producto')
  assert.equal(items[0].etiqueta, 'Cobro contra entrega')
  assert.equal(items[0].monto, 500)
  assert.equal(items[0].estado, 'No cobrado en la entrega')
  // El producto no es cartera de ShEnvíos.
  assert.equal(items[0].esCuentaPorCobrarShenvios, false)
})

test('D2f · la justificación llega completa, sin truncar', () => {
  const texto = 'Otro: Cliente indico que realizara transferencia solo pago delivery'
  const items = detalleIncidencia(ordenDeducida({
    cobrosMotorizado: {
      producto: { monto: 1000, recibio: false, justificacion: texto },
      delivery: { monto: 80, recibio: false, justificacion: texto },
    },
  }))
  assert.equal(items[0].justificacion, texto)
})

test('D3f · resolución y su etiqueta', () => {
  const items = detalleIncidencia(ordenResuelta('cliente_pagara'))
  assert.equal(items[0].textoResolucion, 'Cliente/comercio lo resolverá')
  assert.equal(items[0].resolucion?.resueltoPor, 'gestor-1')
  const perdido = detalleIncidencia(ordenResuelta('se_pierde'))
  assert.equal(perdido[0].textoResolucion, 'Se dio por perdido')
})

test('D4f · sin resolución, textoResolucion es null', () => {
  const items = detalleIncidencia(ordenDeducida())
  assert.equal(items[0].textoResolucion, null)
  assert.equal(items[0].resolucion, null)
})

test('D5f · sin deducir: el delivery es ítem propio y SÍ es cuenta de ShEnvíos', () => {
  const items = detalleIncidencia(ordenSinDeducir())
  assert.equal(items.length, 2)
  const del = items.find((i) => i.item === 'delivery')!
  const prod = items.find((i) => i.item === 'producto')!
  assert.equal(del.etiqueta, 'Delivery')
  assert.equal(del.monto, 150)
  assert.equal(del.esCuentaPorCobrarShenvios, true)
  assert.equal(prod.esCuentaPorCobrarShenvios, false)
})

test('D6f · producto cobrado no genera incidencia', () => {
  const items = detalleIncidencia({
    pagoDelivery: { deducirDelCobroContraEntrega: true },
    cobrosMotorizado: { producto: { monto: 500, recibio: true }, delivery: { monto: 150, recibio: true } },
  })
  assert.deepEqual(items, [])
})

test('D7f · orden sin cobros no revienta', () => {
  assert.deepEqual(detalleIncidencia({}), [])
})

test('D8f · legacy: resolución a nivel de orden alimenta el ítem de delivery', () => {
  const items = detalleIncidencia(ordenSinDeducir({
    cobrosMotorizado: {
      producto: { monto: 500, recibio: false, justificacion: 'x' },
      delivery: { monto: 150, recibio: false, justificacion: 'y' },
      resolucion: { tipo: 'cliente_pagara', resueltoPor: 'g1' },
    },
  }))
  const del = items.find((i) => i.item === 'delivery')!
  assert.equal(del.textoResolucion, 'Cliente/comercio lo resolverá')
  // El producto sigue sin clasificar.
  assert.equal(items.find((i) => i.item === 'producto')!.textoResolucion, null)
})

// ── Invariante ──────────────────────────────────────────────────────────────
test('INV · con deducción la incidencia nunca supera el CE', () => {
  const productos = [0, 100, 150, 500, 1000]
  const deliveries = [0, 50, 150, 600]
  for (const prod of productos) {
    for (const del of deliveries) {
      const r = resumirIncidencia(ordenDeducida({
        confirmacion: { precioFinalCordobas: del },
        cobrosMotorizado: {
          producto: { monto: prod, recibio: false },
          delivery: { monto: del, recibio: false },
        },
      }))
      const ctx = `prod=${prod} del=${del}`
      assert.equal(r.monto, prod, `la incidencia debe ser el CE — ${ctx}`)
      assert.equal(r.componenteDelivery + r.componenteComercio, prod, `desglose != CE — ${ctx}`)
      assert.ok(r.componenteDelivery >= 0 && r.componenteComercio >= 0, `negativo — ${ctx}`)
    }
  }
})
