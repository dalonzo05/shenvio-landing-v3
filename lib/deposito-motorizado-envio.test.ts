// STORAGE-EVIDENCIA-INTEGRIDAD-1 — payloads del writer create-first del
// motorizado. La suite de reglas (test/storage-rules.test.ts) ejecuta estos
// mismos payloads contra los emuladores; acá se fija su forma.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import {
  anularLiberaGastos,
  esGastoElegibleParaDeposito,
  gastosALiberarAlAnular,
  liberarGastosDeDeposito,
  marcarGastosConsumidos,
  type GastoParaDeposito,
  camposCreacionDepositoMotorizado,
  camposEnvioBoucherMotorizado,
  campoPunteroDepositoMotorizado,
  pathBoucherDepositoMotorizado,
  firmaEnvioDeposito,
  envioReutilizable,
  pasosPendientesEnvio,
  type DatosDepositoMotorizado,
} from './deposito-motorizado-envio'

const AHORA = { __ts: 'serverTimestamp' }

function datosA(extra: Partial<DatosDepositoMotorizado> = {}): DatosDepositoMotorizado {
  return {
    tipo: 'recaudacion_motorizado_storkhub',
    destinatario: 'storkhub',
    destinatarioId: 'storkhub',
    destinatarioNombre: 'Storkhub',
    cuentasDestino: [{ banco: 'LAFISE', numero: '000', titular: 'StorkHub', moneda: 'C$' }],
    motorizadoUid: 'juAO',
    motorizadoNombre: 'John Pork 2',
    solicitudIds: ['HDpf'],
    montoTotal: 80,
    montoBruto: 80,
    gastosDescontados: 0,
    gastosIds: [],
    ...extra,
  }
}

test('E1 · la creación nace en pendiente_boucher, SIN boucher ni campos de cierre', () => {
  const c = camposCreacionDepositoMotorizado(datosA(), AHORA)
  assert.equal(c.estado, 'pendiente_boucher')
  assert.equal(c.creadoAt, AHORA)
  for (const k of ['boucher', 'boucherUrl', 'confirmadoAt', 'confirmadoPorUid', 'saldoId', 'anuladoAt', 'digitadoPorUid', 'codigo', 'secuencia']) {
    assert.ok(!(k in c), k)
  }
  assert.deepEqual(Object.keys(c).sort(), [
    'creadoAt', 'cuentasDestino', 'destinatario', 'destinatarioId', 'destinatarioNombre', 'estado',
    'gastosDescontados', 'gastosIds', 'montoBruto', 'montoTotal', 'motorizadoNombre', 'motorizadoUid',
    'solicitudIds', 'tipo',
  ])
})

test('E2 · tipo B: sin montoBruto/gastos si no vienen (no se escriben undefined)', () => {
  const c = camposCreacionDepositoMotorizado(datosA({
    tipo: 'recaudacion_motorizado_comercio', destinatario: 'comercio', destinatarioId: 'com1',
    montoBruto: undefined, gastosDescontados: undefined, gastosIds: undefined,
  }), AHORA)
  assert.equal(c.tipo, 'recaudacion_motorizado_comercio')
  assert.ok(!('montoBruto' in c) && !('gastosDescontados' in c) && !('gastosIds' in c))
})

test('E3 · el envío pone boucher y en_revision juntos, con el UID del motorizado', () => {
  const e = camposEnvioBoucherMotorizado({ url: 'https://x/b.jpg', pathStorage: 'depositos/juAO/d1/boucher.jpg' }, 'juAO', AHORA)
  assert.deepEqual(e, {
    boucher: { url: 'https://x/b.jpg', pathStorage: 'depositos/juAO/d1/boucher.jpg', uploadedAt: AHORA, motorizadoUid: 'juAO' },
    estado: 'en_revision',
  })
})

test('E4 · puntero por destino y path con el UID del motorizado', () => {
  assert.equal(campoPunteroDepositoMotorizado('recaudacion_motorizado_storkhub'), 'registro.deposito.storkhubDepositoId')
  assert.equal(campoPunteroDepositoMotorizado('recaudacion_motorizado_comercio'), 'registro.deposito.comercioDepositoId')
  assert.equal(pathBoucherDepositoMotorizado('juAO', 'd1'), 'depositos/juAO/d1/boucher.jpg')
})

test('E5 · reintento: mismo grupo reusa el envío; si cambian órdenes o monto, no', () => {
  const previo = { depositoId: 'd1', creado: true, firma: firmaEnvioDeposito(datosA()) }
  assert.equal(envioReutilizable(previo, datosA()), true)
  // El orden de las órdenes no cambia la identidad.
  assert.equal(firmaEnvioDeposito(datosA({ solicitudIds: ['b', 'a'] })), firmaEnvioDeposito(datosA({ solicitudIds: ['a', 'b'] })))
  assert.equal(envioReutilizable(previo, datosA({ solicitudIds: ['HDpf', 'otra'] })), false)
  assert.equal(envioReutilizable(previo, datosA({ montoTotal: 90 })), false)
  assert.equal(envioReutilizable(null, datosA()), false)
})

test('E6 · pasos: sin crear → crear, subir, enviar; ya creado → solo subir y enviar', () => {
  assert.deepEqual(pasosPendientesEnvio(null), ['crear', 'subir', 'enviar'])
  assert.deepEqual(pasosPendientesEnvio({ depositoId: 'd1', creado: false, firma: 'f' }), ['crear', 'subir', 'enviar'])
  assert.deepEqual(pasosPendientesEnvio({ depositoId: 'd1', creado: true, firma: 'f' }), ['subir', 'enviar'])
})

// ─── FIN-2 · un gasto se descuenta una sola vez ──────────────────────────────
//
// GASTO-APROBADO-DESCUENTO-REPETIDO-1. Antes de FIN-2 la elegibilidad era
// `estado == aprobado && !liquidacionId` y NADA marcaba el gasto al entrar en un
// depósito: el segundo depósito volvía a descontarlo. La guardia de concurrencia
// es de firestore.rules (test/firestore-rules.test.ts, FG-R*); acá se fija la
// elegibilidad, el ciclo de vida del marcador y que AMBOS flujos (gestor y
// motorizado) lo escriben en el mismo commit que crea el depósito.

function fuenteFin2(...ruta: string[]): string {
  return readFileSync(join(__dirname, '..', ...ruta), 'utf8').replace(/\r/g, '')
}

/** Dos depósitos A/B que se llevan gastos: el bug es que el segundo vuelve a tomar los del primero. */
function gastosElegibles(gastos: Array<{ id: string } & GastoParaDeposito>) {
  return gastos.filter((g) => esGastoElegibleParaDeposito(g)).map((g) => g.id)
}

test('FG1 · un gasto aprobado, libre, es elegible', () => {
  assert.equal(esGastoElegibleParaDeposito({ estado: 'aprobado' }), true)
})

test('FG2 · un gasto anulado, liquidado o sin estado no es elegible', () => {
  assert.equal(esGastoElegibleParaDeposito({ estado: 'anulado' }), false)
  assert.equal(esGastoElegibleParaDeposito({ estado: 'aprobado', liquidacionId: 'liq1' }), false)
  assert.equal(esGastoElegibleParaDeposito({}), false)
  assert.equal(esGastoElegibleParaDeposito(null), false)
  assert.equal(esGastoElegibleParaDeposito(undefined), false)
})

test('FG3 · BUG BASELINE: el gasto que consumió D1 no es elegible para D2', () => {
  const g = { id: 'g1', estado: 'aprobado' }
  assert.deepEqual(gastosElegibles([g]), ['g1'])            // antes de D1
  const trasD1 = { ...g, consumidoEnDepositoId: 'D1' }
  assert.deepEqual(gastosElegibles([trasD1]), [], 'D2 no debe volver a descontar el gasto de D1')
})

test('FG8 · un gasto histórico sin marcador (o con null) sigue siendo elegible: compatible hacia atrás', () => {
  assert.equal(esGastoElegibleParaDeposito({ estado: 'aprobado' }), true)
  assert.equal(esGastoElegibleParaDeposito({ estado: 'aprobado', consumidoEnDepositoId: null }), true)
  assert.equal(esGastoElegibleParaDeposito({ estado: 'aprobado', consumidoEnDepositoId: '' }), true)
})

test('FG10 · el snapshot de D1 no cambia al crear D2', () => {
  const gastos = [
    { id: 'g1', estado: 'aprobado', consumidoEnDepositoId: 'D1' },
    { id: 'g2', estado: 'aprobado' },
  ]
  const d1 = camposCreacionDepositoMotorizado(datosA({ gastosIds: ['g1'], gastosDescontados: 30, montoBruto: 110, montoTotal: 80 }), AHORA)
  const antes = JSON.stringify(d1)
  const d2 = camposCreacionDepositoMotorizado(datosA({ gastosIds: gastosElegibles(gastos), gastosDescontados: 20, montoBruto: 100, montoTotal: 80 }), AHORA)
  assert.deepEqual(d2.gastosIds, ['g2'], 'D2 solo se lleva el gasto libre')
  assert.equal(JSON.stringify(d1), antes, 'crear D2 no toca el snapshot histórico de D1')
  assert.deepEqual(d1.gastosIds, ['g1'])
})

test('FG-U1 · marcarGastosConsumidos escribe consumidoEnDepositoId = depósito, una vez por gasto, sin duplicar', () => {
  const escritos: Array<{ ref: string; data: Record<string, unknown> }> = []
  const batch = { update: (ref: string, data: Record<string, unknown>) => { escritos.push({ ref, data }) } }
  const n = marcarGastosConsumidos(batch, (id) => `gastos_motorizado/${id}`, ['g1', 'g2', 'g1', ''], 'D1')
  assert.equal(n, 2)
  assert.deepEqual(escritos, [
    { ref: 'gastos_motorizado/g1', data: { consumidoEnDepositoId: 'D1' } },
    { ref: 'gastos_motorizado/g2', data: { consumidoEnDepositoId: 'D1' } },
  ])
  assert.equal(marcarGastosConsumidos(batch, (id) => id, undefined, 'D1'), 0)
  assert.throws(() => marcarGastosConsumidos(batch, (id) => id, ['g1'], ''), /depositoId/)
})

test('FG6 · convertido en deuda NO libera los gastos; cualquier otra anulación sí', () => {
  assert.equal(anularLiberaGastos('convertido_en_deuda'), false)
  for (const e of ['pendiente_boucher', 'en_revision', 'devuelto', 'confirmado', 'rechazado']) {
    assert.equal(anularLiberaGastos(e), true, e)
  }
})

test('FG7/FG11/FG12 · al anular D1 solo se liberan los gastos que siguen marcados por D1', () => {
  const leidos = [
    { id: 'g1', consumidoEnDepositoId: 'D1' },   // de D1: se libera
    { id: 'g2', consumidoEnDepositoId: 'D2' },   // ya es de otro depósito: NO se toca
    { id: 'g3' },                                 // histórico sin marca: NO se toca
    null,                                         // gasto que ya no existe
  ]
  assert.deepEqual(gastosALiberarAlAnular(leidos, 'D1'), ['g1'])
  const escritos: Array<{ ref: string; data: Record<string, unknown> }> = []
  const batch = { update: (ref: string, data: Record<string, unknown>) => { escritos.push({ ref, data }) } }
  const LIMPIAR = { __deleteField: true }
  const n = liberarGastosDeDeposito(batch, (id) => `g/${id}`, leidos, 'D1', LIMPIAR)
  assert.equal(n, 1)
  assert.deepEqual(escritos, [{ ref: 'g/g1', data: { consumidoEnDepositoId: LIMPIAR } }])
})

// ─── FG-S · los DOS flujos escriben la marca en el commit que crea el depósito ──

const DEPOSITOS_GESTOR = ['app', 'panel', 'gestor', 'depositos', 'page.tsx']
const PANEL_MOTORIZADO = ['app', 'panel', 'motorizado', 'page.tsx']

test('FG-S1 · Gestor: confirmar, digitar y convertir pendiente crean depósito + marca de gastos en UN batch', () => {
  const src = fuenteFin2(...DEPOSITOS_GESTOR)
  const bloques = src.match(/bCrear\.set\(depositoRef[\s\S]*?marcarGastosConsumidos\(bCrear,[\s\S]*?await bCrear\.commit\(\)/g) ?? []
  assert.equal(bloques.length, 3, 'confirmarStorkhub, digitarDepositoStorkhub y convertirPendienteEnDeuda')
  for (const b of bloques) {
    assert.ok(b.includes("'gastos_motorizado'"), 'la marca va sobre gastos_motorizado')
    assert.ok(!b.includes('await setDoc'), 'la creación ya no es un setDoc suelto')
  }
  // Ningún depósito a StorkHub con gastosIds nace fuera de esos 3 batches.
  assert.equal((src.match(/gastosIds:/g) ?? []).length, 3)
  assert.ok(!/await setDoc\(depositoRef, \{[\s\S]{0,700}gastosIds:/.test(src), 'no queda un setDoc que cree un depósito con gastosIds')
})

test('FG-S2 · Gestor: la lista de gastos descontables usa la elegibilidad compartida, no solo !liquidacionId', () => {
  const src = fuenteFin2(...DEPOSITOS_GESTOR)
  assert.ok(src.includes('.filter((g: any) => esGastoElegibleParaDeposito(g))'))
  assert.ok(!src.includes('.filter((g: any) => !g.liquidacionId)'), 'el filtro viejo no puede volver')
})

test('FG-S3 · Gestor: anular un depósito libera sus gastos en el MISMO batch que libera sus órdenes', () => {
  const src = fuenteFin2(...DEPOSITOS_GESTOR)
  const m = src.match(/if \(eliminarLiberaOrdenes\(dep\.estado\)\) \{[\s\S]*?liberarGastosDeDeposito\(b,[\s\S]*?deleteField\(\)\)[\s\S]*?\}\s*(?:agregarAnulacionDeMovimientosAlBatch\(b,[^\n]*\)\s*)?await b\.commit\(\)/)
  assert.ok(m, 'la liberación de gastos va dentro del if de liberación de órdenes y antes del commit')
  assert.ok(src.includes('anularLiberaGastos(dep.estado)'), 'solo se leen/liberan gastos cuando la anulación libera órdenes')
})

test('FG-S4 · Gestor: un reintento de confirmar no recalcula el monto con los gastos que quedaron libres', () => {
  const src = fuenteFin2(...DEPOSITOS_GESTOR)
  assert.ok(src.includes("const reanuda = previo?.estado === 'pendiente_boucher'"))
  assert.ok(src.includes('montoTotal = reanuda ? (previo?.montoTotal ?? 0) :'))
  assert.ok(/if \(!reanuda\) \{\s*const bCrear = writeBatch\(db\)/.test(src))
})

test('FG-M1 · Motorizado: el depósito y la marca de sus gastos se crean en UN batch', () => {
  const src = fuenteFin2(...PANEL_MOTORIZADO)
  const m = src.match(/const bCrear = writeBatch\(db\);\s*bCrear\.set\(depositoRef, camposCreacionDepositoMotorizado\(datos, serverTimestamp\(\)\)\);\s*marcarGastosConsumidos\(bCrear, [^;]*datos\.gastosIds, envio\.depositoId\);\s*await bCrear\.commit\(\);/)
  assert.ok(m, 'create + marcarGastosConsumidos(datos.gastosIds) + commit')
  assert.ok(!/await setDoc\(depositoRef, camposCreacionDepositoMotorizado/.test(src), 'el setDoc suelto no puede volver')
})

test('FG-M2 · Motorizado: la lista de gastos descontables usa la elegibilidad compartida', () => {
  const src = fuenteFin2(...PANEL_MOTORIZADO)
  assert.ok(src.includes('.filter((g: any) => esGastoElegibleParaDeposito(g))'))
  assert.ok(!src.includes('.filter((g: any) => !g.liquidacionId)'))
})
