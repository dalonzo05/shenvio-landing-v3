// DEPOSITOS-ALERTA-REVISION-1 — suite focal.
//
// Lo que se fija acá: qué cuenta como "por revisar" del gestor (solo A/B en
// 'en_revision'), qué no (devuelto, confirmado, anulado, pendiente_boucher,
// tipo C) y el copy del aviso, que NO puede decir "requiere atención" —esa es
// la frase del motorizado—.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  requiereRevisionGestor,
  depositosPorRevisarGestor,
  cantidadDepositosPorRevisarGestor,
  avisoRevisionGestor,
  rutaDepositosPorRevisar,
  etiquetaBadgeDepositosGestor,
  ESTADO_POR_REVISAR_GESTOR,
  RUTA_DEPOSITOS_GESTOR,
  TAB_POR_REVISAR_GESTOR,
  clasificarColaRevision,
  esperaComprobanteDelMotorizado,
  TITULO_ESPERANDO_COMPROBANTE,
  DETALLE_ESPERANDO_COMPROBANTE,
} from './revision-depositos-gestor'
import type { DepositoRegistrado } from './deposito-orden'

const MOTO = 'juAOhfxi96dlLv8LV3mZwA3cK362'
/** DEP-0006 real de staging: C$90 del delivery de SH-0006, en revisión. */
const dep = (over: Partial<DepositoRegistrado> = {}): DepositoRegistrado => ({
  id: 'UcuXE4eKywpvleA7AdZO', codigo: 'DEP-0006', tipo: 'recaudacion_motorizado_storkhub',
  estado: 'en_revision', destinatario: 'storkhub', destinatarioNombre: 'Storkhub',
  motorizadoUid: MOTO, solicitudIds: ['cV7FJbxoI3Ci2k5srhlz'], montoTotal: 90,
  creadoAt: '2026-09-23T01:44:00.000Z',
  ...over,
})

test('GR1 · un DEP tipo A en revisión requiere revisión del gestor', () => {
  assert.equal(requiereRevisionGestor(dep()), true)
  assert.equal(ESTADO_POR_REVISAR_GESTOR, 'en_revision')
})

test('GR2 · un DEP tipo B en revisión también', () => {
  const tipoB = dep({ id: 'dep_b', tipo: 'recaudacion_motorizado_comercio', destinatario: 'comercio', destinatarioNombre: 'Mariposita', montoTotal: 1000 })
  assert.equal(requiereRevisionGestor(tipoB), true)
})

test('GR3 · devuelto NO: la pelota está en el motorizado', () => {
  assert.equal(requiereRevisionGestor(dep({ estado: 'devuelto' })), false)
})

test('GR4 · confirmado NO', () => {
  assert.equal(requiereRevisionGestor(dep({ estado: 'confirmado' })), false)
})

test('GR5 · anulado NO, y tampoco pendiente_boucher ni convertido_en_deuda', () => {
  for (const estado of ['anulado', 'pendiente_boucher', 'convertido_en_deuda', 'rechazado', '']) {
    assert.equal(requiereRevisionGestor(dep({ estado })), false, estado)
  }
  assert.equal(requiereRevisionGestor(null), false)
  assert.equal(requiereRevisionGestor(undefined), false)
})

test('GR6 · el tipo C NO entra: nace confirmado en Cobros y se corrige ahí', () => {
  const tipoC = dep({ id: 'dep_c', codigo: 'DEP-0002', tipo: 'pago_delivery_deposito' })
  // Incluso con el estado que sí cuenta para A/B.
  assert.equal(tipoC.estado, 'en_revision')
  assert.equal(requiereRevisionGestor(tipoC), false)
  assert.equal(cantidadDepositosPorRevisarGestor([tipoC]), 0)
  // Un tipo desconocido tampoco se cuela.
  assert.equal(requiereRevisionGestor(dep({ id: 'x', tipo: 'otra_cosa' })), false)
})

test('GR7 · dos A/B en revisión ⇒ 2', () => {
  const a = dep({ id: 'a' })
  const b = dep({ id: 'b', tipo: 'recaudacion_motorizado_comercio', destinatario: 'comercio' })
  assert.equal(cantidadDepositosPorRevisarGestor([a, b]), 2)
  assert.deepEqual(depositosPorRevisarGestor([a, b]).map((d) => d.id), ['a', 'b'])
})

test('GR8 · un mismo DEP repetido cuenta una vez', () => {
  const a = dep({ id: 'a' })
  assert.equal(cantidadDepositosPorRevisarGestor([a, a, { ...a }]), 1)
})

test('GR9 · un documento sin id no se cuenta: no hay nada que abrir', () => {
  assert.equal(cantidadDepositosPorRevisarGestor([dep({ id: '' })]), 0)
  assert.equal(cantidadDepositosPorRevisarGestor([dep({ id: undefined as unknown as string })]), 0)
})

test('GR10 · al confirmar baja el contador', () => {
  const antes = [dep({ id: 'a' }), dep({ id: 'b' })]
  assert.equal(cantidadDepositosPorRevisarGestor(antes), 2)
  const despues = antes.map((d) => (d.id === 'a' ? { ...d, estado: 'confirmado' } : d))
  assert.equal(cantidadDepositosPorRevisarGestor(despues), 1)
})

test('GR11 · al devolver también baja: pasa a esperar al motorizado', () => {
  const antes = [dep({ id: 'a' })]
  assert.equal(cantidadDepositosPorRevisarGestor(antes), 1)
  const devuelto = antes.map((d) => ({ ...d, estado: 'devuelto', motivoDevolucion: 'Comprobante ilegible' }))
  assert.equal(cantidadDepositosPorRevisarGestor(devuelto), 0)
  assert.equal(avisoRevisionGestor(0), null)
})

test('GR12 · con 0 no hay aviso', () => {
  assert.equal(avisoRevisionGestor(0), null)
  assert.equal(avisoRevisionGestor(-2), null)
  assert.equal(avisoRevisionGestor(Number.NaN), null)
  assert.equal(cantidadDepositosPorRevisarGestor([]), 0)
})

// ─── GUI · copy y destino ────────────────────────────────────────────────────

test('GUI1 · con 1, singular', () => {
  const a = avisoRevisionGestor(1)
  assert.equal(a?.titulo, 'Tienes 1 depósito por revisar')
  assert.equal(a?.detalle, 'Hay comprobantes enviados por motorizados esperando tu revisión.')
  assert.equal(a?.cta, 'Revisar depósitos')
})

test('GUI2 · con 2 o más, plural', () => {
  assert.equal(avisoRevisionGestor(2)?.titulo, 'Tienes 2 depósitos por revisar')
  assert.equal(avisoRevisionGestor(9)?.titulo, 'Tienes 9 depósitos por revisar')
  // El CTA no cambia de número: lleva al módulo, no a un depósito.
  assert.equal(avisoRevisionGestor(2)?.cta, 'Revisar depósitos')
})

test('GUI3 · con 0 no hay banner', () => {
  assert.equal(avisoRevisionGestor(0), null)
})

test('GUI4 · el CTA va al módulo de Depósitos que ya existe', () => {
  assert.equal(RUTA_DEPOSITOS_GESTOR, '/panel/gestor/depositos')
  assert.ok(avisoRevisionGestor(1)?.href.startsWith('/panel/gestor/depositos'))
  // Nunca una ruta por depósito.
  assert.ok(!/\/depositos\/[^?]/.test(avisoRevisionGestor(1)!.href))
})

test('GUI5 · el CTA abre la pestaña Por revisar', () => {
  assert.equal(TAB_POR_REVISAR_GESTOR, 'por_revisar')
  assert.equal(rutaDepositosPorRevisar(), '/panel/gestor/depositos?tab=por_revisar')
  assert.equal(avisoRevisionGestor(3)?.href, '/panel/gestor/depositos?tab=por_revisar')
})

test('GUI6 · el copy no invade el del motorizado, y el badge tiene su etiqueta', () => {
  const a = avisoRevisionGestor(2)!
  assert.ok(!/requiere[n]? atenci/i.test(a.titulo + a.detalle + a.cta))
  assert.equal(etiquetaBadgeDepositosGestor(1), 'Depósitos, 1 por revisar')
  assert.equal(etiquetaBadgeDepositosGestor(4), 'Depósitos, 4 por revisar')
  assert.equal(etiquetaBadgeDepositosGestor(0), 'Depósitos')
})

test('GUI7 · DEP-0006 real: un depósito por revisar, con su aviso', () => {
  // Estado actual de staging: DEP-0006 C$90 en revisión, tipo A.
  const n = cantidadDepositosPorRevisarGestor([dep()])
  assert.equal(n, 1)
  assert.equal(avisoRevisionGestor(n)?.titulo, 'Tienes 1 depósito por revisar')
})

// ─── ALIGN · las cuatro superficies dicen lo mismo ───────────────────────────
//
// El KPI y la pestaña de Depósitos contaban 'pendiente_boucher' junto con
// 'en_revision', así que la página podía decir 2 donde el gestor tenía 1
// decisión por tomar, y el dashboard decía 1. Ahora las cuatro superficies
// —dashboard, badge, pestaña y KPI— salen del mismo helper, y el
// pendiente_boucher tiene su propia sección: sale de los contadores, no del
// módulo.

const pendienteBoucher = dep({ id: 'dep_pb', codigo: 'DEP-0007', estado: 'pendiente_boucher' })
const enRevision = dep({ id: 'dep_er', codigo: 'DEP-0006', estado: 'en_revision' })

test('ALIGN1 · solo pendiente_boucher ⇒ 0 por revisar, y no se pierde', () => {
  const cola = clasificarColaRevision([pendienteBoucher])
  assert.equal(cola.porRevisar.length, 0)
  assert.deepEqual(cola.esperandoComprobante.map((d) => d.id), ['dep_pb'])
  assert.equal(cantidadDepositosPorRevisarGestor([pendienteBoucher]), 0)
  assert.equal(avisoRevisionGestor(0), null)
  assert.equal(esperaComprobanteDelMotorizado(pendienteBoucher), true)
  assert.equal(requiereRevisionGestor(pendienteBoucher), false)
})

test('ALIGN2 · solo en_revision ⇒ 1 por revisar, nada esperando comprobante', () => {
  const cola = clasificarColaRevision([enRevision])
  assert.deepEqual(cola.porRevisar.map((d) => d.id), ['dep_er'])
  assert.equal(cola.esperandoComprobante.length, 0)
  assert.equal(cantidadDepositosPorRevisarGestor([enRevision]), 1)
  assert.equal(avisoRevisionGestor(1)?.titulo, 'Tienes 1 depósito por revisar')
})

test('ALIGN3 · uno de cada ⇒ por revisar 1, esperando 1, nunca 2', () => {
  const cola = clasificarColaRevision([pendienteBoucher, enRevision])
  assert.equal(cola.porRevisar.length, 1)
  assert.equal(cola.esperandoComprobante.length, 1)
  assert.notEqual(cola.porRevisar.length, 2)
  assert.equal(cantidadDepositosPorRevisarGestor([pendienteBoucher, enRevision]), 1)
})

test('ALIGN4 · el contador del dashboard es exactamente el del KPI', () => {
  const lista = [pendienteBoucher, enRevision, dep({ id: 'c1', estado: 'confirmado' }), dep({ id: 'd1', estado: 'devuelto' })]
  const kpi = clasificarColaRevision(lista).porRevisar.length
  const dashboard = cantidadDepositosPorRevisarGestor(lista)
  assert.equal(dashboard, kpi)
  assert.equal(kpi, 1)
  assert.equal(avisoRevisionGestor(dashboard)?.titulo, 'Tienes 1 depósito por revisar')
})

test('ALIGN5 · el badge es el mismo número, con su propia etiqueta', () => {
  const lista = [pendienteBoucher, enRevision, dep({ id: 'x', estado: 'en_revision', tipo: 'recaudacion_motorizado_comercio', destinatario: 'comercio' })]
  const kpi = clasificarColaRevision(lista).porRevisar.length
  assert.equal(kpi, 2)
  assert.equal(cantidadDepositosPorRevisarGestor(lista), kpi)
  assert.equal(etiquetaBadgeDepositosGestor(kpi), 'Depósitos, 2 por revisar')
})

test('ALIGN6 · el tipo C no entra en ninguna de las dos colas', () => {
  const tipoCRevision = dep({ id: 'c_rev', tipo: 'pago_delivery_deposito', estado: 'en_revision' })
  const tipoCPendiente = dep({ id: 'c_pb', tipo: 'pago_delivery_deposito', estado: 'pendiente_boucher' })
  const cola = clasificarColaRevision([tipoCRevision, tipoCPendiente])
  assert.equal(cola.porRevisar.length, 0)
  assert.equal(cola.esperandoComprobante.length, 0)
  assert.equal(esperaComprobanteDelMotorizado(tipoCPendiente), false)
})

test('ALIGN7 · en_revision → devuelto: por revisar baja y el aviso se apaga', () => {
  const antes = [enRevision]
  assert.equal(cantidadDepositosPorRevisarGestor(antes), 1)
  const despues = antes.map((d) => ({ ...d, estado: 'devuelto' }))
  const cola = clasificarColaRevision(despues)
  assert.equal(cola.porRevisar.length, 0)
  // Un devuelto no cae en "esperando comprobante": es otra cosa, y su lugar
  // sigue siendo el historial del módulo.
  assert.equal(cola.esperandoComprobante.length, 0)
  assert.equal(avisoRevisionGestor(cantidadDepositosPorRevisarGestor(despues)), null)
})

test('ALIGN8 · la cola deduplica y no se queda con documentos sin id', () => {
  const cola = clasificarColaRevision([enRevision, enRevision, { ...enRevision }, dep({ id: '', estado: 'en_revision' }), null, undefined])
  assert.equal(cola.porRevisar.length, 1)
  assert.equal(cola.esperandoComprobante.length, 0)
})

test('ALIGN9 · el copy de la sección aparte no habla de revisión', () => {
  assert.equal(TITULO_ESPERANDO_COMPROBANTE, 'Esperando comprobante')
  assert.equal(DETALLE_ESPERANDO_COMPROBANTE, 'El envío no se completó: todavía no hay comprobante que revisar.')
  assert.ok(!/por revisar/i.test(TITULO_ESPERANDO_COMPROBANTE))
})
