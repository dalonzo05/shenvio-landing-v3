// DEPOSITOS-UX-TRAZABILIDAD-1 — P0 del panel Motorizado y su historial.
//
// Caso real SH-0001: delivery C$110 cobrado en efectivo por John Pork 2.
//   antes de enviar         → pendiente C$110
//   enviado, sin confirmar  → pendiente C$0 · en revisión C$110
//   confirmado              → nada pendiente, nada en revisión
// El panel viejo seguía diciendo "Total a depositar hoy C$110" en el segundo
// caso: le pedía dinero que ya había enviado.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  resumenDepositosMotorizado,
  historialDepositosMotorizado,
  filasPestanaDepositos,
  siguienteLimiteDepositos,
  avisoTopeDepositos,
  PASO_VER_MAS_DEPOSITOS,
  TOPE_QUERY_HISTORIAL_MOTORIZADO,
  MENSAJE_IMAGEN_ILEGIBLE,
  requiereAtencionMotorizado,
  depositosQueRequierenAtencion,
  cantidadDepositosQueRequierenAtencion,
  cantidadTareasDepositoMotorizado,
  etiquetaBadgeDepositos,
  avisoAtencionMotorizado,
  ETIQUETA_ATENCION_MOTORIZADO,
  RUTA_DEPOSITOS_MOTORIZADO,
} from './depositos-motorizado'
import type { EntradaDepositoOrden, DepositoRegistrado } from './deposito-orden'

const SH_0001 = 'jTIJLEhGeACcymBAj0jY'

function sh0001(registro: EntradaDepositoOrden['registro'] = { deposito: null }): EntradaDepositoOrden {
  return {
    estado: 'entregado',
    tipoCliente: 'contado',
    confirmacion: { precioFinalCordobas: 110 },
    pagoDelivery: { quienPaga: 'entrega', montoSugerido: 110, deducirDelCobroContraEntrega: false, tipo: 'contado' },
    cobrosMotorizado: { delivery: { monto: 110, recibio: true } },
    cobroContraEntrega: { aplica: false, monto: 0 },
    registro,
  } as EntradaDepositoOrden
}

// Precondición: la fórmula real dice que SH-0001 obliga C$110 a StorkHub.
test('M0 · precondición: SH-0001 genera C$110 de obligación a StorkHub', () => {
  const r = resumenDepositosMotorizado([sh0001()])
  assert.equal(r.pendiente.storkhubBruto, 110)
})

test('M1 · sin puntero ⇒ pendiente de depositar C$110', () => {
  const r = resumenDepositosMotorizado([sh0001()])
  assert.equal(r.pendiente.total, 110)
  assert.equal(r.pendiente.ordenes, 1)
  assert.equal(r.enRevision.total, 0)
})

test('M2 · P0 · con puntero y sin confirmar ⇒ pendiente C$0 · en revisión C$110', () => {
  const r = resumenDepositosMotorizado([sh0001({ deposito: { storkhubDepositoId: 'P4IMui3ILjs0P9U6eDgT' } })])
  assert.equal(r.pendiente.total, 0, 'el dinero ya enviado no puede seguir como pendiente')
  assert.equal(r.pendiente.ordenes, 0)
  assert.equal(r.enRevision.storkhub, 110)
  assert.equal(r.enRevision.total, 110)
  assert.equal(r.enRevision.ordenes, 1)
})

test('M3 · confirmado ⇒ cerrado: ni pendiente ni en revisión', () => {
  const r = resumenDepositosMotorizado([sh0001({
    deposito: { storkhubDepositoId: 'P4IMui3ILjs0P9U6eDgT', confirmadoStorkhub: true, confirmadoStorkhubAt: '2026-09-18T01:03:05.221Z' },
  })])
  assert.equal(r.pendiente.total, 0)
  assert.equal(r.enRevision.total, 0)
})

test('M4 · convertido en deuda (escribe confirmadoStorkhub) ⇒ tampoco se le pide depositar', () => {
  // convertirDepositoEnDeuda() pone confirmadoStorkhub = true: el faltante
  // pasa a ser una deuda de liquidación, no un depósito por enviar.
  const r = resumenDepositosMotorizado([sh0001({ deposito: { storkhubDepositoId: 'x', confirmadoStorkhub: true } })])
  assert.equal(r.pendiente.total, 0)
  assert.equal(r.enRevision.total, 0)
})

test('M5 · gastos aprobados se descuentan solo de lo pendiente a StorkHub', () => {
  const r = resumenDepositosMotorizado([sh0001()], 30)
  assert.equal(r.pendiente.storkhubBruto, 110)
  assert.equal(r.pendiente.storkhub, 80)
  assert.equal(r.pendiente.total, 80)
  // Nunca negativo.
  assert.equal(resumenDepositosMotorizado([sh0001()], 500).pendiente.storkhub, 0)
})

test('M6 · orden sin obligación no aparece en ningún lado', () => {
  const transfer = { ...sh0001(), pagoDelivery: { quienPaga: 'transferencia' }, cobrosMotorizado: { delivery: { monto: 0, recibio: false } } } as EntradaDepositoOrden
  const r = resumenDepositosMotorizado([transfer])
  assert.equal(r.pendiente.total + r.enRevision.total, 0)
})

// ── Historial ────────────────────────────────────────────────────────────────

const DEP_0001: DepositoRegistrado = {
  id: 'P4IMui3ILjs0P9U6eDgT', codigo: 'DEP-0001', tipo: 'recaudacion_motorizado_storkhub', estado: 'confirmado',
  destinatario: 'storkhub', destinatarioNombre: 'Storkhub', motorizadoUid: 'juAOhfxi96dlLv8LV3mZwA3cK362',
  solicitudIds: [SH_0001], montoTotal: 110,
  boucher: { url: 'https://example.test/b.jpg' },
  creadoAt: '2026-09-17T23:24:40.777Z', confirmadoAt: '2026-09-18T01:03:05.221Z', confirmadoPorUid: 'RKTw1pLfK5O8Y3A6IIwDU8J3yr43',
}

test('M7 · historial: DEP-0001 con SH-0001, envío, confirmación y "StorkHub" como confirmador', () => {
  const [f] = historialDepositosMotorizado([DEP_0001], { [SH_0001]: 'SH-0001' })
  assert.equal(f.identidad.texto, 'DEP-0001')
  assert.equal(f.enviado, '2026-09-17T23:24:40.777Z')
  assert.equal(f.confirmado, '2026-09-18T01:03:05.221Z')
  assert.equal(f.destino, 'StorkHub')
  assert.equal(f.monto, 110)
  assert.equal(f.ordenes, 1)
  assert.deepEqual(f.codigosOrdenes, ['SH-0001'])
  assert.equal(f.estado, 'Confirmado')
  assert.equal(f.comprobante, 'https://example.test/b.jpg')
  // El motorizado no lee `usuarios`: nunca un UID, nunca un nombre adivinado.
  assert.equal(f.confirmadoPor, 'StorkHub')
})

test('M8 · historial: en revisión no tiene confirmador ni fecha de confirmación', () => {
  const [f] = historialDepositosMotorizado([{ ...DEP_0001, estado: 'en_revision', confirmadoAt: undefined, confirmadoPorUid: undefined }])
  assert.equal(f.estado, 'En revisión')
  assert.equal(f.confirmado, null)
  assert.equal(f.confirmadoPor, null)
  // Orden que el motorizado no tiene cargada: ID corto, no se inventa código.
  assert.deepEqual(f.codigosOrdenes, ['jTIJLEhG'])
})

test('M9 · historial excluye el pago del delivery por transferencia (tipo C)', () => {
  const c: DepositoRegistrado = { ...DEP_0001, id: 'c', codigo: 'DEP-0003', tipo: 'pago_delivery_deposito' }
  const filas = historialDepositosMotorizado([DEP_0001, c])
  assert.deepEqual(filas.map((f) => f.identidad.texto), ['DEP-0001'])
})

test('M10 · historial: más reciente primero y recortado al límite', () => {
  const deps = [1, 3, 2].map((n) => ({ ...DEP_0001, id: `d${n}`, codigo: `DEP-000${n}`, creadoAt: `2026-09-1${n}T12:00:00.000Z` }))
  const filas = historialDepositosMotorizado(deps, {}, 2)
  assert.deepEqual(filas.map((f) => f.identidad.texto), ['DEP-0003', 'DEP-0002'])
})

// ── MOTORIZADO-UX-OPERATIVA-1 · pestañas y "Ver más" ─────────────────────────

function depEn(estado: string, i: number, tipo = 'recaudacion_motorizado_storkhub'): DepositoRegistrado {
  return { ...DEP_0001, id: 'dep' + String(i).padStart(3, '0'), codigo: undefined, estado, tipo, creadoAt: new Date(Date.UTC(2026, 8, 1, 0, i)).toISOString() }
}

test('M11 · Por revisar = pendiente_boucher + en_revision; Confirmados = confirmado', () => {
  const filas = historialDepositosMotorizado([
    depEn('pendiente_boucher', 1), depEn('en_revision', 2), depEn('confirmado', 3),
    depEn('convertido_en_deuda', 4), depEn('rechazado', 5),
  ], {}, 100)
  assert.deepEqual(filasPestanaDepositos(filas, 'por_revisar').map((f) => f.estadoClave).sort(), ['en_revision', 'pendiente_boucher'])
  assert.deepEqual(filasPestanaDepositos(filas, 'confirmados').map((f) => f.estadoClave), ['confirmado'])
  assert.equal(filasPestanaDepositos(filas, 'todos').length, 5)
})

test('M12 · convertido_en_deuda no entra en Confirmados; sí en Todos, con su propio estado', () => {
  const filas = historialDepositosMotorizado([depEn('convertido_en_deuda', 1)], {}, 100)
  assert.equal(filasPestanaDepositos(filas, 'confirmados').length, 0)
  const [f] = filasPestanaDepositos(filas, 'todos')
  assert.equal(f.estadoClave, 'convertido_en_deuda')
  const confirmado = filasPestanaDepositos(historialDepositosMotorizado([depEn('confirmado', 2)], {}, 100), 'todos')[0]
  assert.notEqual(f.estado, confirmado.estado)
})

test('M13 · el tipo C sigue excluido en todas las pestañas', () => {
  const filas = historialDepositosMotorizado([depEn('confirmado', 1, 'pago_delivery_deposito'), depEn('confirmado', 2)], {}, 100)
  for (const p of ['por_revisar', 'confirmados', 'todos'] as const) {
    assert.ok(filasPestanaDepositos(filas, p).every((f) => f.id !== 'dep001'))
  }
  assert.equal(filasPestanaDepositos(filas, 'todos').length, 1)
})

test('M14 · Ver más: 30 → 60 → 90 → máximo disponible (≤ 100)', () => {
  assert.equal(PASO_VER_MAS_DEPOSITOS, 30)
  assert.equal(siguienteLimiteDepositos(30, 100), 60)
  assert.equal(siguienteLimiteDepositos(60, 100), 90)
  assert.equal(siguienteLimiteDepositos(90, 100), 100)
  assert.equal(siguienteLimiteDepositos(30, 45), 45)
  assert.equal(siguienteLimiteDepositos(100, 100), 100)
  // Con el tope pasado a historialDepositosMotorizado se ven hasta 100, no 30.
  const deps = Array.from({ length: 100 }, (_, i) => depEn('confirmado', i))
  assert.equal(historialDepositosMotorizado(deps, {}, TOPE_QUERY_HISTORIAL_MOTORIZADO).length, 100)
})

test('M15 · aviso de tope: solo al llegar a 100 y sin afirmar que son los más recientes', () => {
  assert.equal(avisoTopeDepositos(99), null)
  const aviso = avisoTopeDepositos(100)
  assert.equal(aviso, 'Mostrando los registros cargados. El historial completo se habilitará próximamente.')
  assert.ok(aviso!.includes('Mostrando los registros cargados'))
  // La query no tiene orderBy: nada que sugiera recencia.
  assert.ok(!/[úu]ltim/i.test(aviso!))
  assert.ok(!/reciente/i.test(aviso!))
  assert.ok(!/nuev|actual/i.test(aviso!))
  assert.ok(!/100/.test(aviso!))
})

test('M16 · mensaje de imagen ilegible: entendible y sin prometer PDF', () => {
  assert.equal(MENSAJE_IMAGEN_ILEGIBLE, 'No se pudo leer la imagen. Probá con una captura o una imagen JPG.')
  assert.ok(!/pdf/i.test(MENSAJE_IMAGEN_ILEGIBLE))
})

// ─── MA · MOTO-DEPOSITOS-AVISOS-1: qué requiere acción del motorizado ────────
//
// "Requiere atención" = StorkHub devolvió el depósito para que corrija el
// comprobante. Nada más: ni lo que espera a StorkHub, ni lo que ya terminó.
// Fixtures sintéticos, sin tocar staging.

const MOTO = 'juAOhfxi96dlLv8LV3mZwA3cK362'
const OTRO_MOTO = 'otro-motorizado-uid'
const dep = (over: Partial<DepositoRegistrado>): DepositoRegistrado => ({
  id: 'dep_a', codigo: 'DEP-0010', tipo: 'recaudacion_motorizado_storkhub', estado: 'devuelto',
  destinatario: 'storkhub', motorizadoUid: MOTO, solicitudIds: [SH_0001], montoTotal: 110,
  creadoAt: '2026-09-20T10:00:00.000Z',
  ...over,
})

test('MA1 · un DEP tipo A devuelto requiere atención del motorizado', () => {
  const d = dep({})
  assert.equal(requiereAtencionMotorizado(d), true)
  assert.equal(requiereAtencionMotorizado(d, MOTO), true)
})

test('MA2 · un DEP tipo B devuelto también: la corrección es suya igual', () => {
  const d = dep({ id: 'dep_b', tipo: 'recaudacion_motorizado_comercio', destinatario: 'comercio', destinatarioNombre: 'Mariposita' })
  assert.equal(requiereAtencionMotorizado(d, MOTO), true)
})

test('MA3 · en_revision NO requiere atención: ya hizo su parte y espera a StorkHub', () => {
  assert.equal(requiereAtencionMotorizado(dep({ estado: 'en_revision' }), MOTO), false)
  assert.equal(cantidadDepositosQueRequierenAtencion([dep({ estado: 'en_revision' })], MOTO), 0)
})

test('MA4 · confirmado NO requiere atención', () => {
  assert.equal(requiereAtencionMotorizado(dep({ estado: 'confirmado' }), MOTO), false)
})

test('MA5 · anulado NO, y tampoco convertido_en_deuda ni pendiente_boucher', () => {
  for (const estado of ['anulado', 'convertido_en_deuda', 'pendiente_boucher', 'rechazado', '']) {
    assert.equal(requiereAtencionMotorizado(dep({ estado }), MOTO), false, estado)
  }
  assert.equal(requiereAtencionMotorizado(null), false)
  assert.equal(requiereAtencionMotorizado(undefined), false)
})

test('MA6 · el tipo C NO es un depósito del motorizado, ni devuelto', () => {
  const tipoC = dep({ id: 'dep_c', codigo: 'DEP-0002', tipo: 'pago_delivery_deposito', estado: 'devuelto' })
  assert.equal(requiereAtencionMotorizado(tipoC, MOTO), false)
  assert.equal(cantidadDepositosQueRequierenAtencion([tipoC], MOTO), 0)
})

test('MA7 · dos devueltos y uno en revisión: el contador dice 2', () => {
  const lista = [dep({ id: 'a' }), dep({ id: 'b' }), dep({ id: 'c', estado: 'en_revision' })]
  assert.equal(cantidadDepositosQueRequierenAtencion(lista, MOTO), 2)
  assert.deepEqual(depositosQueRequierenAtencion(lista, MOTO).map((d) => d.id), ['a', 'b'])
})

test('MA8 · sin devueltos el contador es 0', () => {
  assert.equal(cantidadDepositosQueRequierenAtencion([], MOTO), 0)
  assert.equal(cantidadDepositosQueRequierenAtencion([dep({ estado: 'confirmado' }), dep({ id: 'x', estado: 'en_revision' })], MOTO), 0)
})

test('MA9 · al corregir (devuelto → en_revision) el contador baja', () => {
  const antes = [dep({ id: 'a' }), dep({ id: 'b' })]
  assert.equal(cantidadDepositosQueRequierenAtencion(antes, MOTO), 2)
  const despues = [dep({ id: 'a', estado: 'en_revision' }), dep({ id: 'b' })]
  assert.equal(cantidadDepositosQueRequierenAtencion(despues, MOTO), 1)
  const todos = [dep({ id: 'a', estado: 'en_revision' }), dep({ id: 'b', estado: 'en_revision' })]
  assert.equal(cantidadDepositosQueRequierenAtencion(todos, MOTO), 0)
  assert.equal(avisoAtencionMotorizado(cantidadDepositosQueRequierenAtencion(todos, MOTO)), null)
})

test('MA10 · dos depósitos de la MISMA solicitud cuentan dos: la unidad es el DEP', () => {
  const lista = [
    dep({ id: 'a', solicitudIds: [SH_0001] }),
    dep({ id: 'b', solicitudIds: [SH_0001], tipo: 'recaudacion_motorizado_comercio', destinatario: 'comercio' }),
  ]
  assert.equal(cantidadDepositosQueRequierenAtencion(lista, MOTO), 2)
})

test('MA11 · el devuelto de OTRO motorizado no cuenta', () => {
  const ajeno = dep({ id: 'ajeno', motorizadoUid: OTRO_MOTO })
  assert.equal(requiereAtencionMotorizado(ajeno, MOTO), false)
  assert.equal(cantidadDepositosQueRequierenAtencion([ajeno, dep({ id: 'mio' })], MOTO), 1)
  // Sin uid se confía en la query que trajo la lista (where motorizadoUid == su uid).
  assert.equal(cantidadDepositosQueRequierenAtencion([ajeno]), 1)
  // Un documento sin motorizadoUid no se cuela cuando se exige pertenencia.
  assert.equal(requiereAtencionMotorizado(dep({ motorizadoUid: undefined }), MOTO), false)
})

test('MA12 · un mismo DEP repetido cuenta una sola vez', () => {
  const d = dep({ id: 'a' })
  assert.equal(cantidadDepositosQueRequierenAtencion([d, d, { ...d }], MOTO), 1)
  // Un documento sin id no se cuenta: no hay nada que abrir.
  assert.equal(cantidadDepositosQueRequierenAtencion([dep({ id: '' })], MOTO), 0)
})

// ─── UI · copy del aviso y del badge ─────────────────────────────────────────

test('UI1 · con 1 depósito, el aviso habla en singular', () => {
  const a = avisoAtencionMotorizado(1)
  assert.equal(a?.titulo, 'Tienes 1 depósito que requiere atención')
  assert.equal(a?.detalle, 'StorkHub solicitó corregir un comprobante.')
  assert.equal(a?.cta, 'Revisar depósito')
})

test('UI2 · con 2 o más, en plural', () => {
  const a = avisoAtencionMotorizado(2)
  assert.equal(a?.titulo, 'Tienes 2 depósitos que requieren atención')
  assert.equal(a?.detalle, 'StorkHub solicitó corregir los comprobantes.')
  assert.equal(a?.cta, 'Revisar depósitos')
  assert.equal(avisoAtencionMotorizado(7)?.titulo, 'Tienes 7 depósitos que requieren atención')
})

test('UI3 · con 0 no hay aviso: null, no un banner vacío', () => {
  assert.equal(avisoAtencionMotorizado(0), null)
  assert.equal(avisoAtencionMotorizado(-3), null)
  assert.equal(avisoAtencionMotorizado(Number.NaN), null)
})

test('UI4 y UI5 · el badge sale del contador: 0 se oculta, >0 se muestra', () => {
  assert.equal(cantidadDepositosQueRequierenAtencion([dep({ estado: 'en_revision' })], MOTO), 0)
  assert.equal(cantidadDepositosQueRequierenAtencion([dep({ id: 'a' }), dep({ id: 'b' }), dep({ id: 'c' })], MOTO), 3)
})

test('UI6 · el CTA lleva a los depósitos de su propio panel, sin inventar ruta', () => {
  const a = avisoAtencionMotorizado(1)
  assert.equal(a?.ruta, '/panel/motorizado')
  assert.equal(a?.tab, 'depositos')
  assert.equal(RUTA_DEPOSITOS_MOTORIZADO, '/panel/motorizado')
  assert.equal(ETIQUETA_ATENCION_MOTORIZADO, 'Requiere atención')
  assert.ok(!/notificacion/i.test(JSON.stringify(a)))
})

// ─── MC · el aviso no depende del recorte del historial ──────────────────────
//
// HARDENING: el historial trae ≤100 documentos sin orderBy. Si el aviso saliera
// de ahí, un motorizado con más de 100 depósitos podría tener uno devuelto
// fuera del recorte y el panel diría "0 requiere atención": un falso negativo
// en una alerta operativa. Por eso el aviso tiene su propia fuente —los
// devueltos— y estos casos fijan que el contador no se apoya en el listado.

/** Lo que devuelve la query de atención: solo los devueltos del motorizado. */
const comoQueryAtencion = (todos: DepositoRegistrado[], uid: string) =>
  todos.filter((d) => d.motorizadoUid === uid && d.estado === 'devuelto')

const historicoDe = (n: number, over: (i: number) => Partial<DepositoRegistrado> = () => ({})) =>
  Array.from({ length: n }, (_, i) => dep({
    id: `dep_${String(i).padStart(3, '0')}`,
    codigo: `DEP-${String(i).padStart(4, '0')}`,
    estado: 'confirmado',
    // Más nuevo primero al ordenar: el índice 0 es el más reciente.
    creadoAt: new Date(Date.UTC(2026, 8, 1) + (n - i) * 3600_000).toISOString(),
    confirmadoAt: new Date(Date.UTC(2026, 8, 2) + (n - i) * 3600_000).toISOString(),
    ...over(i),
  }))

test('MC1 · 105 depósitos y el devuelto fuera de los primeros 100: el aviso lo ve igual', () => {
  // El devuelto es el más ANTIGUO: en el historial ordenado queda en la
  // posición 104 y el recorte de 100 lo deja afuera.
  const todos = historicoDe(105, (i) => (i === 104 ? { estado: 'devuelto', confirmadoAt: undefined } : {}))
  const filas = historialDepositosMotorizado(todos, {}, 100)
  assert.equal(filas.length, 100)
  assert.equal(filas.some((f) => f.estadoClave === 'devuelto'), false, 'el listado recortado no lo trae')
  // El aviso no sale del listado: sale de su propia query.
  assert.equal(cantidadDepositosQueRequierenAtencion(comoQueryAtencion(todos, MOTO), MOTO), 1)
  assert.equal(avisoAtencionMotorizado(1)?.titulo, 'Tienes 1 depósito que requiere atención')
})

test('MC2 · la query de atención con dos devueltos da 2', () => {
  const todos = [...historicoDe(3), dep({ id: 'x1' }), dep({ id: 'x2' })]
  const atencion = comoQueryAtencion(todos, MOTO)
  assert.deepEqual(atencion.map((d) => d.id), ['x1', 'x2'])
  assert.equal(cantidadDepositosQueRequierenAtencion(atencion, MOTO), 2)
})

test('MC3 · 100 confirmados + 1 devuelto: el badge dice 1', () => {
  const todos = [...historicoDe(100), dep({ id: 'devuelto_1' })]
  assert.equal(cantidadDepositosQueRequierenAtencion(comoQueryAtencion(todos, MOTO), MOTO), 1)
})

test('MC4 · al corregir, la query de atención deja de traerlo y el badge baja a 0', () => {
  const antes = [...historicoDe(2), dep({ id: 'd1' })]
  assert.equal(cantidadDepositosQueRequierenAtencion(comoQueryAtencion(antes, MOTO), MOTO), 1)
  const despues = antes.map((d) => (d.id === 'd1' ? { ...d, estado: 'en_revision' } : d))
  assert.deepEqual(comoQueryAtencion(despues, MOTO), [], 'ya no entra en la query')
  assert.equal(cantidadDepositosQueRequierenAtencion(comoQueryAtencion(despues, MOTO), MOTO), 0)
  assert.equal(avisoAtencionMotorizado(0), null)
})

test('MC5 · un tipo C devuelto que llegara por la query lo excluye el helper', () => {
  const tipoC = dep({ id: 'c1', codigo: 'DEP-0002', tipo: 'pago_delivery_deposito' })
  const atencion = comoQueryAtencion([tipoC, dep({ id: 'a1' })], MOTO)
  assert.equal(atencion.length, 2, 'la query por estado sí lo trae')
  assert.equal(cantidadDepositosQueRequierenAtencion(atencion, MOTO), 1, 'el helper lo descarta')
})

test('MC6 · un tipo B devuelto cuenta igual: no se filtra por destino', () => {
  const tipoB = dep({ id: 'b1', tipo: 'recaudacion_motorizado_comercio', destinatario: 'comercio', destinatarioNombre: 'Mariposita' })
  assert.equal(cantidadDepositosQueRequierenAtencion(comoQueryAtencion([tipoB], MOTO), MOTO), 1)
})

test('MC7 · el historial no es fuente del contador: mismo dato, resultados distintos', () => {
  const todos = historicoDe(105, (i) => (i === 104 ? { estado: 'devuelto', confirmadoAt: undefined } : {}))
  // Contar sobre el listado recortado daría 0 —el falso negativo que motivó el
  // hardening—; contar sobre la fuente de atención da 1.
  const idsDelListado = new Set(historialDepositosMotorizado(todos, {}, 100).map((f) => f.id))
  const recortados = todos.filter((d) => idsDelListado.has(d.id))
  assert.equal(cantidadDepositosQueRequierenAtencion(recortados, MOTO), 0)
  assert.equal(cantidadDepositosQueRequierenAtencion(comoQueryAtencion(todos, MOTO), MOTO), 1)
})

// ─── CT · tareas de depósito: obligaciones, no órdenes ───────────────────────
//
// SH-0006 (E2E real): una sola orden con delivery C$90 en efectivo a StorkHub y
// cobro contra entrega C$1,000 al comercio. Son DOS envíos distintos y el panel
// decía 1, porque contaba órdenes. Y con el depósito de los C$90 devuelto
// seguía diciendo 1, aunque había dos cosas por hacer.

/** Delivery C$90 en efectivo (no deducido del CE) + CE C$1,000 al comercio. */
function sh0006(registro: EntradaDepositoOrden['registro'] = { deposito: null }): EntradaDepositoOrden {
  return {
    estado: 'entregado',
    tipoCliente: 'contado',
    confirmacion: { precioFinalCordobas: 90 },
    pagoDelivery: { quienPaga: 'entrega', montoSugerido: 90, deducirDelCobroContraEntrega: false, tipo: 'contado' },
    cobroContraEntrega: { aplica: true, monto: 1000 },
    cobrosMotorizado: { delivery: { monto: 90, recibio: true }, producto: { monto: 1000, recibio: true } },
    registro,
  } as EntradaDepositoOrden
}
const tareas = (ordenes: EntradaDepositoOrden[], devueltos = 0, gastos = 0) =>
  cantidadTareasDepositoMotorizado(resumenDepositosMotorizado(ordenes, gastos), devueltos)

test('CT0 · precondición: SH-0006 obliga C$90 a StorkHub y C$1,000 al comercio', () => {
  const r = resumenDepositosMotorizado([sh0006()])
  assert.equal(r.pendiente.storkhubBruto, 90)
  assert.equal(r.pendiente.comercio, 1000)
  // Una sola orden…
  assert.equal(r.pendiente.ordenes, 1)
  // …y DOS obligaciones. Ahí estaba el bug del contador.
  assert.equal(r.pendiente.obligaciones, 2)
})

test('CT1 · una orden con obligación a StorkHub y al comercio ⇒ 2 tareas', () => {
  assert.equal(tareas([sh0006()]), 2)
})

test('CT2 · solo StorkHub pendiente ⇒ 1', () => {
  const r = resumenDepositosMotorizado([sh0001()])
  assert.equal(r.pendiente.obligacionesStorkhub, 1)
  assert.equal(r.pendiente.obligacionesComercio, 0)
  assert.equal(tareas([sh0001()]), 1)
})

test('CT3 · solo el comercio pendiente ⇒ 1', () => {
  // El depósito a StorkHub ya se envió; queda el del comercio.
  const reg = { deposito: { storkhubDepositoId: 'dep_sh' } }
  const r = resumenDepositosMotorizado([sh0006(reg)])
  assert.equal(r.pendiente.obligacionesStorkhub, 0)
  assert.equal(r.pendiente.obligacionesComercio, 1)
  assert.equal(tareas([sh0006(reg)]), 1)
})

test('CT4 · las dos enviadas (en revisión) ⇒ 0 tareas', () => {
  const reg = { deposito: { storkhubDepositoId: 'dep_sh', comercioDepositoId: 'dep_co' } }
  const r = resumenDepositosMotorizado([sh0006(reg)])
  assert.equal(r.pendiente.obligaciones, 0)
  assert.equal(r.enRevision.obligaciones, 2)
  assert.equal(tareas([sh0006(reg)]), 0)
})

test('CT5 · comercio pendiente + StorkHub devuelto ⇒ 2', () => {
  // Devuelto = el puntero existe (el depósito está registrado) y además hay un
  // DEP en estado devuelto: la corrección es la segunda tarea.
  const reg = { deposito: { storkhubDepositoId: 'dep_sh' } }
  const devueltos = cantidadDepositosQueRequierenAtencion([dep({ id: 'dep_sh' })], MOTO)
  assert.equal(devueltos, 1)
  assert.equal(tareas([sh0006(reg)], devueltos), 2)
})

test('CT6 · un devuelto no se cuenta dos veces: el puntero lo saca de pendiente', () => {
  const reg = { deposito: { storkhubDepositoId: 'dep_sh' } }
  const r = resumenDepositosMotorizado([sh0006(reg)])
  // A StorkHub ya no hay nada PENDIENTE aunque el depósito esté devuelto…
  assert.equal(r.pendiente.storkhub, 0)
  assert.equal(r.pendiente.obligacionesStorkhub, 0)
  // …así que sumar la corrección no duplica esa deuda.
  assert.equal(tareas([sh0006(reg)], 1), 2)
  // Y si esa orden no tuviera nada más pendiente, la tarea es solo la corrección.
  const soloStorkhub = sh0001({ deposito: { storkhubDepositoId: 'dep_sh' } })
  assert.equal(resumenDepositosMotorizado([soloStorkhub]).pendiente.obligaciones, 0)
  assert.equal(tareas([soloStorkhub], 1), 1)
})

test('CT7 · dos órdenes con cuatro obligaciones pendientes ⇒ 4', () => {
  const otra = { ...sh0006(), confirmacion: { precioFinalCordobas: 50 } } as EntradaDepositoOrden
  const r = resumenDepositosMotorizado([sh0006(), otra])
  assert.equal(r.pendiente.obligaciones, 4)
  assert.equal(r.pendiente.ordenes, 2)
  assert.equal(tareas([sh0006(), otra]), 4)
})

test('CT8 · en_revision no es tarea del motorizado', () => {
  const reg = { deposito: { storkhubDepositoId: 'dep_sh', comercioDepositoId: 'dep_co' } }
  assert.equal(tareas([sh0006(reg)], 0), 0)
  // Y un DEP en_revision tampoco entra por el lado de las correcciones.
  assert.equal(cantidadDepositosQueRequierenAtencion([dep({ estado: 'en_revision' })], MOTO), 0)
})

test('CT9 · confirmado no es tarea', () => {
  const reg = {
    deposito: {
      storkhubDepositoId: 'dep_sh', confirmadoStorkhub: true,
      comercioDepositoId: 'dep_co', confirmadoComercio: true,
    },
  }
  assert.equal(tareas([sh0006(reg)]), 0)
  assert.equal(cantidadDepositosQueRequierenAtencion([dep({ estado: 'confirmado' })], MOTO), 0)
})

test('CT10 · el tipo C nunca es tarea del motorizado', () => {
  const tipoC = dep({ id: 'c1', tipo: 'pago_delivery_deposito' })
  const devueltos = cantidadDepositosQueRequierenAtencion([tipoC], MOTO)
  assert.equal(devueltos, 0)
  assert.equal(tareas([], devueltos), 0)
})

test('CT11 · el banner sigue contando SOLO devueltos, no las tareas', () => {
  // Estado E2E de SH-0006: C$1,000 pendiente al comercio + DEP-0006 devuelto.
  const reg = { deposito: { storkhubDepositoId: 'dep_sh' } }
  const devueltos = cantidadDepositosQueRequierenAtencion([dep({ id: 'dep_sh' })], MOTO)
  assert.equal(tareas([sh0006(reg)], devueltos), 2, 'contador general')
  const aviso = avisoAtencionMotorizado(devueltos)
  assert.equal(aviso?.titulo, 'Tienes 1 depósito que requiere atención')
  assert.equal(aviso?.cta, 'Revisar depósito')
})

test('CT12 · StatCard y badge comparten el contador, con su etiqueta propia', () => {
  const reg = { deposito: { storkhubDepositoId: 'dep_sh' } }
  const n = tareas([sh0006(reg)], 1)
  assert.equal(n, 2)
  // El mismo número alimenta los dos; la etiqueta del badge no dice "atención".
  assert.equal(etiquetaBadgeDepositos(n), 'Depósitos, 2 pendientes')
  assert.equal(etiquetaBadgeDepositos(1), 'Depósitos, 1 pendiente')
  assert.equal(etiquetaBadgeDepositos(0), 'Depósitos')
  assert.ok(!/atenci/i.test(etiquetaBadgeDepositos(2)))
})

test('CT13 · lifecycle SH-0006: 2 → 1 → 2 → 1 → 0', () => {
  const DEP_SH = 'dep_sh_0006'
  // 1. recién entregada: los dos depósitos por hacer.
  assert.equal(tareas([sh0006()], 0), 2)
  // 2. envía los C$90: queda el del comercio.
  const enviado = sh0006({ deposito: { storkhubDepositoId: DEP_SH } })
  assert.equal(tareas([enviado], 0), 1)
  // 3. StorkHub devuelve ese depósito: corregirlo + depositar al comercio.
  const devueltos = cantidadDepositosQueRequierenAtencion([dep({ id: DEP_SH })], MOTO)
  assert.equal(tareas([enviado], devueltos), 2)
  // 4. lo corrige: vuelve a en_revision.
  const corregidos = cantidadDepositosQueRequierenAtencion([dep({ id: DEP_SH, estado: 'en_revision' })], MOTO)
  assert.equal(tareas([enviado], corregidos), 1)
  // 5. envía los C$1,000: nada por hacer.
  const ambos = sh0006({ deposito: { storkhubDepositoId: DEP_SH, comercioDepositoId: 'dep_co_0006' } })
  assert.equal(tareas([ambos], corregidos), 0)
  assert.equal(avisoAtencionMotorizado(corregidos), null)
})

test('CT14 · un pendiente que los gastos dejan en C$0 neto sigue siendo tarea', () => {
  // El monto no decide: la obligación existe aunque el neto a StorkHub sea 0.
  const r = resumenDepositosMotorizado([sh0001()], 500)
  assert.equal(r.pendiente.storkhub, 0)
  assert.equal(r.pendiente.obligaciones, 1)
  assert.equal(tareas([sh0001()], 0, 500), 1)
})
