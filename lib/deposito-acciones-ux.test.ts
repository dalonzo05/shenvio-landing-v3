// FIN-1B — presentación de Rehacer/Anular un depósito y CONTRATOS de la pantalla de Depósitos.
//
// La autoridad (estado, ledger, órdenes, gastos, liquidaciones, idempotencia y concurrencia) la prueban functions/test/
// depositos-autoritativos.test.ts (núcleos reales) y el runtime (emulador). Aquí: (1) que el cliente no confunda los resultados,
// (2) la identidad del intento de Rehacer, y (3) que ninguna superficie del producto rehaga o anule por su cuenta: solo las callables.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import {
  ErrorAccionDeposito,
  MSG_ANULADO,
  MSG_ESTADO_DEPOSITO,
  MSG_INCONSISTENTE_DEPOSITO,
  MSG_MOTIVO_DEPOSITO,
  MSG_PERMISO_DEPOSITO,
  MSG_REHECHO_PENDIENTE,
  MSG_REHECHO_REVISION,
  MSG_TEMPORAL_DEPOSITO,
  MSG_YA_ANULADO_DEPOSITO,
  MSG_YA_REHECHO,
  exigirHechoDeposito,
  operacionDeRehacer,
  presentarErrorAccionDeposito,
  presentarResultadoAnularDeposito,
  presentarResultadoRehacer,
} from './deposito-acciones-ux'

const err = (code: string, motivo?: string) => ({ code, message: 'msg del servidor', details: motivo ? { motivo } : undefined })

test('FIN1B-U1 · los resultados exitosos y los idempotentes no se confunden; el destino de Rehacer se distingue', () => {
  assert.deepEqual(presentarResultadoRehacer({ resultado: 'rehecho', estadoDestino: 'en_revision' }), { categoria: 'exito', mensaje: MSG_REHECHO_REVISION, hecho: true })
  assert.deepEqual(presentarResultadoRehacer({ resultado: 'rehecho', estadoDestino: 'pendiente_boucher' }), { categoria: 'exito', mensaje: MSG_REHECHO_PENDIENTE, hecho: true })
  assert.deepEqual(presentarResultadoRehacer({ resultado: 'ya_rehecho', estadoDestino: 'en_revision' }), { categoria: 'ya_hecho', mensaje: MSG_YA_REHECHO, hecho: true })
  assert.deepEqual(presentarResultadoAnularDeposito({ resultado: 'anulado' }), { categoria: 'exito', mensaje: MSG_ANULADO, hecho: true })
  assert.deepEqual(presentarResultadoAnularDeposito({ resultado: 'ya_anulado' }), { categoria: 'ya_hecho', mensaje: MSG_YA_ANULADO_DEPOSITO, hecho: true })
})

test('FIN1B-U2 · cada rechazo del servidor se presenta con su categoría y mensaje; ninguno cuenta como hecho', () => {
  const casos: Array<[unknown, string, string?]> = [
    [err('functions/failed-precondition', 'usar_reversion_conversion'), 'bloqueado', 'Revertir conversión'],
    [err('functions/failed-precondition', 'usar_revertir_cobro'), 'bloqueado', 'Cobros'],
    [err('failed-precondition', 'deposito_no_rehacible'), 'bloqueado', 'confirmado'],
    [err('functions/failed-precondition', 'deposito_no_anulable'), 'bloqueado', 'no se puede anular'],
    [err('functions/failed-precondition', 'deposito_ya_liquidado'), 'bloqueado', 'liquidación'],
    [err('functions/failed-precondition', 'deposito_comercio_ya_liquidado'), 'bloqueado', 'comercio'],
    [err('functions/failed-precondition', 'operacion_inconsistente'), 'bloqueado', 'otro depósito'],
    [err('functions/failed-precondition', 'ledger_inconsistente'), 'inconsistente', MSG_INCONSISTENTE_DEPOSITO],
    [err('functions/failed-precondition', 'conciliacion_requerida'), 'inconsistente', MSG_INCONSISTENTE_DEPOSITO],
    [err('functions/failed-precondition', 'motivo_que_este_build_no_conoce'), 'inconsistente', MSG_INCONSISTENTE_DEPOSITO],
    [err('functions/not-found'), 'estado_invalido', MSG_ESTADO_DEPOSITO],
    [err('functions/permission-denied'), 'permiso', MSG_PERMISO_DEPOSITO],
    [err('functions/unauthenticated'), 'permiso', MSG_PERMISO_DEPOSITO],
    [err('functions/invalid-argument'), 'invalido', MSG_MOTIVO_DEPOSITO],
  ]
  for (const [e, categoria, texto] of casos) {
    const p = presentarErrorAccionDeposito(e)
    assert.equal(p.categoria, categoria); assert.equal(p.hecho, false)
    if (texto) assert.ok(p.mensaje.includes(texto), `${categoria}: ${p.mensaje}`)
    assert.throws(() => exigirHechoDeposito(p), (x: unknown) => x instanceof ErrorAccionDeposito && x.categoria === categoria)
  }
  for (const e of [err('functions/unavailable'), err('functions/internal'), new Error('Failed to fetch'), null, undefined, 'x']) {
    const p = presentarErrorAccionDeposito(e)
    assert.equal(p.categoria, 'temporal'); assert.equal(p.mensaje, MSG_TEMPORAL_DEPOSITO); assert.equal(p.hecho, false)
  }
  assert.equal(exigirHechoDeposito(presentarResultadoAnularDeposito({ resultado: 'anulado' })).hecho, true)
})

test('FIN1B-U3 · un intento de Rehacer conserva su operacionId mientras es el mismo depósito y motivo; cambia con otro depósito u otro motivo', () => {
  let n = 0
  const nuevo = () => `op-${++n}-xxxxxxxx`
  const a = operacionDeRehacer(null, 'D1', 'Motivo uno', nuevo)
  assert.equal(a.operacionId, 'op-1-xxxxxxxx')
  const reintento = operacionDeRehacer(a, 'D1', '  Motivo uno ', nuevo)
  assert.equal(reintento, a, 'el reintento (misma clave) reusa la operación')
  assert.notEqual(operacionDeRehacer(a, 'D2', 'Motivo uno', nuevo).operacionId, a.operacionId)
  assert.notEqual(operacionDeRehacer(a, 'D1', 'Otro motivo', nuevo).operacionId, a.operacionId)
  assert.match(a.operacionId, /^[A-Za-z0-9_-]{8,64}$/)
})

// ── Contratos de la pantalla y los wrappers ──────────────────────────────────
const RAIZ = join(__dirname, '..')
const leer = (...ruta: string[]) => readFileSync(join(RAIZ, ...ruta), 'utf8').replace(/\r/g, '')
const sinComentarios = (s: string) => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '')

test('FIN1B-C1 · rehacerDeposito y anularDeposito de la pantalla llaman SOLO a las callables: sin writeBatch, runTransaction, updateDoc, setDoc ni lectura de movimientos', () => {
  const p = sinComentarios(leer('app', 'panel', 'gestor', 'depositos', 'page.tsx'))
  const bloque = (desde: string, hasta: string) => { const i = p.indexOf(desde); const j = p.indexOf(hasta, i + desde.length); assert.ok(i > 0 && j > i, desde); return p.slice(i, j) }
  const hReh = bloque('async function rehacerDeposito', 'async function anularDeposito')
  const hAnu = bloque('async function anularDeposito', 'return (')
  assert.ok(hReh.includes('rehacerDepositoServidor(dep.id, motivo.trim(), intentoRehacerRef.current.operacionId)'))
  assert.ok(hAnu.includes('anularDepositoServidor(dep.id, motivo.trim())'))
  for (const [nombre, h] of [['rehacerDeposito', hReh], ['anularDeposito', hAnu]] as const) {
    for (const prohibido of ['writeBatch', 'runTransaction', 'updateDoc', 'setDoc', 'addDoc', 'deleteField', 'getDocs', 'getDoc(', 'movimientos_financieros', 'solicitudes_envio', 'gastos_motorizado', 'camposRehacer', 'camposAnular', 'agregarAnulacion', 'liberarGastos', 'camposLiberacion', 'camposReapertura']) {
      assert.ok(!h.includes(prohibido), `${nombre} no usa ${prohibido}`)
    }
    assert.ok(h.includes('MSG_MOTIVO_DEPOSITO'), `${nombre}: el motivo es obligatorio`)
  }
  assert.ok(!/(^|[^\w])leerMovimientosDeDeposito/.test(p), 'la lectura de movimientos para decidir writes desapareció')
})

test('FIN1B-C2 · los wrappers entregan a httpsCallable SOLO { depositoId, motivo (, operacionId) } (sin estado, movimientos, órdenes, gastos, actor ni rol)', () => {
  const reh = sinComentarios(leer('lib', 'rehacer-deposito-cliente.ts'))
  assert.ok(/httpsCallable<\{ depositoId: string; motivo: string; operacionId: string \}, \w+>\(functions, 'rehacerDeposito'\)\(\{ depositoId, motivo, operacionId \}\)/.test(reh), 'payload exacto de Rehacer')
  const anu = sinComentarios(leer('lib', 'anular-deposito-cliente.ts'))
  assert.ok(/httpsCallable<\{ depositoId: string; motivo: string \}, \w+>\(functions, 'anularDeposito'\)\(\{ depositoId, motivo \}\)/.test(anu), 'payload exacto de Anular')
  for (const w of [reh, anu]) for (const prohibido of ['estado', 'monto', 'movimiento', 'orden', 'gasto', 'actorUid', 'rol', 'undefined']) assert.ok(!w.includes(prohibido), `wrapper: ${prohibido}`)
})

test('FIN1B-C3 · ningún writer cliente de Rehacer/Anular reaparece: los helpers de campos y de ledger ya no se importan en la pantalla', () => {
  const p = sinComentarios(leer('app', 'panel', 'gestor', 'depositos', 'page.tsx'))
  for (const n of ['camposRehacerDeposito', 'camposAnularDeposito', 'camposEventoDepositoRehecho', 'camposEventoDepositoAnulado', 'agregarAnulacionDeMovimientosAlBatch', 'camposReaperturaRevision', 'camposLiberacionDeposito', 'eliminarLiberaOrdenes', 'liberarGastosDeDeposito', 'anularLiberaGastos']) {
    assert.ok(!new RegExp(`\\b${n}\\b`).test(p), `${n} ya no lo usa la pantalla`)
  }
  // Lo legítimo sigue: captura, boucher, corrección y rechazo.
  for (const n of ['camposPedirCorreccion', 'marcarGastosConsumidos', 'camposEnlaceDigitacion', 'confirmarDepositoServidor', 'convertirDepositoEnDeudaServidor']) {
    assert.ok(new RegExp(`\\b${n}\\b`).test(p), `${n} sigue (flujo legítimo)`)
  }
})
