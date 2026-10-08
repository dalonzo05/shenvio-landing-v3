// FIN-1C-B — presentación de crear/anular gasto, registrar/anular adelanto y resolver incidencia, y CONTRATOS de las pantallas.
//
// La autoridad (monto, fecha, ledger, guards de depósito y liquidación, idempotencia, concurrencia) la prueban functions/test/
// finanzas-operativas.test.ts (núcleos reales) y el runtime (emulador). Aquí: (1) que el cliente no confunda los resultados, (2) la identidad de
// cada intento y (3) que ninguna pantalla escriba un gasto, un adelanto ni una resolución por su cuenta: solo las callables.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import {
  ErrorOp,
  MSG_ADELANTO_ANULADO,
  MSG_ADELANTO_REGISTRADO,
  MSG_ADELANTO_YA_ANULADO,
  MSG_ADELANTO_YA_REGISTRADO,
  MSG_GASTO_ANULADO,
  MSG_GASTO_CREADO,
  MSG_GASTO_YA_ANULADO,
  MSG_GASTO_YA_CREADO,
  MSG_INCIDENCIA_RESUELTA,
  MSG_INCIDENCIA_YA_RESUELTA,
  MSG_INCONSISTENTE_OP,
  MSG_INVALIDO_OP,
  MSG_PERMISO_OP,
  MSG_TEMPORAL_OP,
  exigirHechoOp,
  operacionDeIntento,
  presentarErrorOp,
  presentarResultadoAnularAdelanto,
  presentarResultadoAnularGasto,
  presentarResultadoCrearGasto,
  presentarResultadoRegistrarAdelanto,
  presentarResultadoResolver,
} from './finanzas-operativas-ux'

const err = (code: string, motivo?: string) => ({ code, message: 'msg del servidor', details: motivo ? { motivo } : undefined })

test('FIN1CB-U1 · los resultados exitosos y los idempotentes no se confunden', () => {
  assert.deepEqual(presentarResultadoCrearGasto({ resultado: 'registrado' }), { categoria: 'exito', mensaje: MSG_GASTO_CREADO, hecho: true })
  assert.deepEqual(presentarResultadoCrearGasto({ resultado: 'ya_registrado' }), { categoria: 'ya_hecho', mensaje: MSG_GASTO_YA_CREADO, hecho: true })
  assert.deepEqual(presentarResultadoAnularGasto({ resultado: 'anulado' }), { categoria: 'exito', mensaje: MSG_GASTO_ANULADO, hecho: true })
  assert.deepEqual(presentarResultadoAnularGasto({ resultado: 'ya_anulado' }), { categoria: 'ya_hecho', mensaje: MSG_GASTO_YA_ANULADO, hecho: true })
  assert.deepEqual(presentarResultadoRegistrarAdelanto({ resultado: 'registrado' }), { categoria: 'exito', mensaje: MSG_ADELANTO_REGISTRADO, hecho: true })
  assert.deepEqual(presentarResultadoRegistrarAdelanto({ resultado: 'ya_registrado' }), { categoria: 'ya_hecho', mensaje: MSG_ADELANTO_YA_REGISTRADO, hecho: true })
  assert.deepEqual(presentarResultadoAnularAdelanto({ resultado: 'anulado' }), { categoria: 'exito', mensaje: MSG_ADELANTO_ANULADO, hecho: true })
  assert.deepEqual(presentarResultadoAnularAdelanto({ resultado: 'ya_anulado' }), { categoria: 'ya_hecho', mensaje: MSG_ADELANTO_YA_ANULADO, hecho: true })
  assert.deepEqual(presentarResultadoResolver({ resultado: 'resuelto' }), { categoria: 'exito', mensaje: MSG_INCIDENCIA_RESUELTA, hecho: true })
  assert.deepEqual(presentarResultadoResolver({ resultado: 'ya_resuelto' }), { categoria: 'ya_hecho', mensaje: MSG_INCIDENCIA_YA_RESUELTA, hecho: true })
})

test('FIN1CB-U2 · cada rechazo del servidor se presenta con su categoría y mensaje; ninguno cuenta como hecho', () => {
  const casos: Array<[unknown, string, string?]> = [
    [err('functions/failed-precondition', 'gasto_consumido'), 'bloqueado', 'descontó en un depósito'],
    [err('functions/failed-precondition', 'gasto_liquidado'), 'bloqueado', 'liquidación'],
    [err('functions/failed-precondition', 'semana_liquidada'), 'bloqueado', 'liquidación'],
    [err('functions/failed-precondition', 'fecha_futura'), 'bloqueado', 'futura'],
    [err('functions/failed-precondition', 'motorizado_inexistente'), 'bloqueado', 'motorizado'],
    [err('functions/failed-precondition', 'orden_invalida'), 'bloqueado', 'orden'],
    [err('functions/failed-precondition', 'movimiento_invalido'), 'bloqueado', 'adelanto'],
    [err('functions/failed-precondition', 'operacion_inconsistente'), 'bloqueado', 'otros datos'],
    [err('functions/failed-precondition', 'incidencia_no_abierta'), 'bloqueado', 'ya se resolvió'],
    [err('functions/failed-precondition', 'cobro_ya_pagado'), 'bloqueado', 'pagado'],
    [err('functions/failed-precondition', 'orden_no_entregada'), 'bloqueado', 'entregada'],
    [err('functions/failed-precondition', 'estado_incompatible'), 'bloqueado', 'revisión'],
    [err('functions/failed-precondition', 'conciliacion_requerida'), 'inconsistente', MSG_INCONSISTENTE_OP],
    [err('functions/failed-precondition', 'motivo_que_este_build_no_conoce'), 'inconsistente', MSG_INCONSISTENTE_OP],
    [err('functions/not-found'), 'estado_invalido'],
    [err('functions/permission-denied'), 'permiso', MSG_PERMISO_OP],
    [err('functions/unauthenticated'), 'permiso', MSG_PERMISO_OP],
    [err('functions/invalid-argument'), 'invalido', MSG_INVALIDO_OP],
  ]
  for (const [e, categoria, texto] of casos) {
    const p = presentarErrorOp(e)
    assert.equal(p.categoria, categoria); assert.equal(p.hecho, false)
    if (texto) assert.ok(p.mensaje.includes(texto), `${categoria}: ${p.mensaje}`)
    assert.throws(() => exigirHechoOp(p), (x: unknown) => x instanceof ErrorOp && x.categoria === categoria)
  }
  for (const e of [err('functions/unavailable'), err('functions/internal'), err('functions/aborted'), new Error('Failed to fetch'), null, undefined, 'x']) {
    const p = presentarErrorOp(e)
    assert.equal(p.categoria, 'temporal'); assert.equal(p.mensaje, MSG_TEMPORAL_OP); assert.equal(p.hecho, false)
  }
  assert.equal(exigirHechoOp(presentarResultadoCrearGasto({ resultado: 'registrado' })).hecho, true)
})

test('FIN1CB-U3 · un intento conserva su operacionId mientras los datos son los mismos (espacios y nulos no cuentan) y cambia con otros datos', () => {
  let n = 0
  const nuevo = () => `op-${++n}-xxxxxxxx`
  const a = operacionDeIntento(null, ['m1', 'peaje', 40, '2026-05-20', ' nota ', undefined], nuevo)
  assert.equal(a.operacionId, 'op-1-xxxxxxxx')
  assert.equal(operacionDeIntento(a, ['m1', 'peaje', 40, '2026-05-20', 'nota', null], nuevo), a, 'el reintento (misma clave) reusa la operación')
  for (const otro of [['m2', 'peaje', 40, '2026-05-20', 'nota', null], ['m1', 'peaje', 41, '2026-05-20', 'nota', null], ['m1', 'peaje', 40, '2026-05-21', 'nota', null], ['m1', 'peaje', 40, '2026-05-20', 'otra', null]]) {
    assert.notEqual(operacionDeIntento(a, otro as never, nuevo).operacionId, a.operacionId)
  }
  assert.match(a.operacionId, /^[A-Za-z0-9_-]{8,64}$/)
})

// ── Contratos de las pantallas y los wrappers ────────────────────────────────
const RAIZ = join(__dirname, '..')
const leer = (...ruta: string[]) => readFileSync(join(RAIZ, ...ruta), 'utf8').replace(/\r/g, '')
const sinComentarios = (s: string) => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '').replace(/\{\/\*[\s\S]*?\*\/\}/g, '')
function bloque(src: string, desde: string, hasta: string): string {
  const i = src.indexOf(desde)
  const j = src.indexOf(hasta, i + desde.length)
  assert.ok(i >= 0 && j > i, `${desde} … ${hasta}`)
  return src.slice(i, j)
}
const PROHIBIDOS = ['updateDoc', 'setDoc', 'addDoc', 'writeBatch', 'runTransaction', 'registrarMovimiento', 'deleteField', 'serverTimestamp']

test('FIN1CB-K1 · Gastos llama SOLO a las callables: sin addDoc, updateDoc, setDoc, batch, transacción ni registrarMovimiento; y financial-writes ya no tiene los writers de gasto', () => {
  const src = leer('app', 'panel', 'gestor', 'gastos', 'page.tsx')
  const p = sinComentarios(src)
  for (const prohibido of PROHIBIDOS) assert.ok(!p.includes(prohibido), `la pantalla de Gastos no usa ${prohibido}`)
  assert.ok(p.includes('crearGastoMotorizadoServidor(') && p.includes('anularGastoMotorizadoServidor('))
  assert.ok(!/from '@\/lib\/financial-writes'/.test(p), 'Gastos ya no importa financial-writes')
  const fw = sinComentarios(leer('lib', 'financial-writes.ts'))
  assert.ok(!/export async function (crearGastoMotorizado|anularGastoMotorizado)\b/.test(fw), 'los writers de cliente de gasto desaparecieron')
  assert.ok(!/['"]gastos_motorizado['"]/.test(fw), 'financial-writes no toca gastos_motorizado')
})

test('FIN1CB-K2 · Liquidaciones: el adelanto (registrar y anular) llama SOLO a las callables; no escribe movimientos de adelanto por su cuenta', () => {
  const src = leer('app', 'panel', 'gestor', 'liquidaciones', 'page.tsx')
  const reg = sinComentarios(bloque(src, 'async function handleAdelanto() {', '  // ── Anular adelanto'))
  const anu = sinComentarios(bloque(src, 'async function anularAdelanto(', '  // ── '.length ? 'return (' : 'return ('))
  for (const [nombre, h] of [['handleAdelanto', reg], ['anularAdelanto', anu]] as const) {
    for (const prohibido of [...PROHIBIDOS, 'movimientos_financieros', "'adelanto_motorizado'", 'cuentas.']) assert.ok(!h.includes(prohibido), `${nombre} no usa ${prohibido}`)
  }
  assert.ok(reg.includes('registrarAdelantoMotorizadoServidor(selectedMotoId, monto, selectedSemana, intentoAdelantoRef.current.operacionId, notaAdelanto)'))
  assert.ok(anu.includes('anularAdelantoMotorizadoServidor(movimientoId)'))
  // No tocó lo que es de FIN-1D: crear/cerrar liquidación y el saldo por faltante siguen donde estaban.
  const p = sinComentarios(src)
  assert.ok(p.includes('crearSaldoCargo(') && p.includes("'liquidacion_pago_efectivo'") && p.includes('tx.set(liqRef'), 'las liquidaciones no se tocan en este bloque')
})

test('FIN1CB-K3 · Cobros: ResolveModal llama SOLO a la callable; nada del cliente escribe resoluciones, cobroPendiente ni cobroDelivery.estado = no_cobrar/pendiente por resolución', () => {
  const src = leer('app', 'panel', 'gestor', 'cobros', 'page.tsx')
  const h = sinComentarios(bloque(src, 'async function handleResolver() {', 'return ('))
  for (const prohibido of [...PROHIBIDOS, 'cobrosMotorizado', 'cobroDelivery', 'cobroPendiente']) assert.ok(!h.includes(prohibido), `handleResolver no usa ${prohibido}`)
  assert.ok(h.includes('resolverIncidenciaCobroServidor(solicitud.id, item, tipo, nota)'))
  const p = sinComentarios(src)
  assert.ok(!p.includes("'cobrosMotorizado.resolucion'") && !p.includes("'cobrosMotorizado.producto"), 'la pantalla ya no escribe resoluciones')
  assert.ok(!p.includes("'cobroDelivery.estado': 'no_cobrar'") && !/cobroPendiente\s*[:=]\s*(true|false|quedaOtra)/.test(p), 'ni la condonación ni cobroPendiente')
  // Lo legítimo del cliente sigue: el boucher.
  for (const n of ['handleQuitar', 'handleReemplazar', 'handleGestorBoucherUpload']) assert.ok(new RegExp(`\\b${n}\\b`).test(p), n)
})

test('FIN1CB-K4 · los wrappers entregan a httpsCallable SOLO los campos del contrato (sin estado, actor, rol, cuentas, tipo de movimiento ni cobroPendiente)', () => {
  const w = (f: string) => sinComentarios(leer('lib', f))
  const crear = w('crear-gasto-cliente.ts'), anular = w('anular-gasto-cliente.ts'), reg = w('registrar-adelanto-cliente.ts'), anAd = w('anular-adelanto-cliente.ts'), res = w('resolver-incidencia-cliente.ts')
  assert.ok(crear.includes("functions, 'crearGastoMotorizado')(payload)") && crear.includes('{ operacionId, motorizadoId: datos.motorizadoId, tipo: datos.tipo, monto: datos.monto }'))
  assert.ok(/httpsCallable<\{ gastoId: string \}, \w+>\(functions, 'anularGastoMotorizado'\)\(\{ gastoId \}\)/.test(anular))
  assert.ok(reg.includes("functions, 'registrarAdelantoMotorizado')(payload)") && reg.includes('{ operacionId, motorizadoId, monto, semanaKey }'))
  assert.ok(/httpsCallable<\{ adelantoId: string \}, \w+>\(functions, 'anularAdelantoMotorizado'\)\(\{ adelantoId \}\)/.test(anAd))
  assert.ok(res.includes("functions, 'resolverIncidenciaCobro')(payload)") && res.includes('{ ordenId, item, decision }'))
  const limpio = (x: string) => x.replace(/Resultado\w+Servidor/g, '')
  for (const x of [crear, anular, reg, anAd, res]) assert.ok(!/estado|actorUid|\brol\b|creadoPor|cuenta|propietario|cobroPendiente|undefined|resueltoPor/i.test(limpio(x)), 'wrapper: campo prohibido')
})
