// FIN-1A — presentación de condonar/anular, cuándo se ofrece "Anular" y CONTRATOS de la pantalla de Saldos.
//
// La autoridad (monto condonado derivado, ledger, idempotencia, bloqueos y concurrencia) la prueban
// functions/test/saldos-deuda-autoritativos.test.ts (núcleos reales) y el runtime (emulador). Aquí: (1) que el cliente no
// confunda los resultados, (2) que solo ofrezca "Anular" donde procede y diga la razón en el resto, y (3) que ninguna
// superficie del producto condone o anule por su cuenta: solo las callables, con { saldoId, motivo }.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'
import {
  ErrorAccionSaldo,
  MSG_ANULADA,
  MSG_CONDONADA,
  MSG_ESTADO_INVALIDO,
  MSG_INCONSISTENTE,
  MSG_MOTIVO,
  MSG_PERMISO,
  MSG_TEMPORAL,
  MSG_YA_ANULADO,
  MSG_YA_CONDONADA,
  evaluarAnulacion,
  exigirHecho,
  presentarErrorAccionSaldo,
  presentarResultadoAnulacion,
  presentarResultadoCondonacion,
} from './saldo-acciones-ux'

const err = (code: string, motivo?: string) => ({ code, message: 'msg del servidor', details: motivo ? { motivo } : undefined })

test('FIN1A-U1 · los resultados exitosos y los idempotentes no se confunden', () => {
  assert.deepEqual(presentarResultadoCondonacion({ resultado: 'condonada' }), { categoria: 'exito', mensaje: MSG_CONDONADA, hecho: true })
  assert.deepEqual(presentarResultadoCondonacion({ resultado: 'ya_condonada' }), { categoria: 'ya_hecho', mensaje: MSG_YA_CONDONADA, hecho: true })
  assert.deepEqual(presentarResultadoAnulacion({ resultado: 'anulada' }), { categoria: 'exito', mensaje: MSG_ANULADA, hecho: true })
  assert.deepEqual(presentarResultadoAnulacion({ resultado: 'ya_anulado' }), { categoria: 'ya_hecho', mensaje: MSG_YA_ANULADO, hecho: true })
})

test('FIN1A-U2 · cada rechazo del servidor se presenta con su categoría y su mensaje; ninguno cuenta como hecho', () => {
  const casos: Array<[unknown, string, string?]> = [
    [err('functions/failed-precondition', 'usar_reversion_conversion'), 'bloqueado', 'Revertir'],
    [err('functions/failed-precondition', 'usar_correccion_liquidacion'), 'bloqueado', 'liquidación'],
    [err('failed-precondition', 'ledger_no_demostrable'), 'bloqueado', 'legacy'],
    [err('functions/failed-precondition', 'saldo_con_abonos'), 'bloqueado', 'abonos'],
    [err('functions/failed-precondition', 'saldo_pagado'), 'bloqueado', 'pagada'],
    [err('functions/failed-precondition', 'saldo_condonado'), 'bloqueado', 'condonada'],
    [err('functions/failed-precondition', 'saldo_no_condonable'), 'bloqueado', 'condonar'],
    [err('functions/failed-precondition', 'sin_saldo_pendiente'), 'bloqueado', 'nada que condonar'],
    [err('functions/failed-precondition', 'conversion_inconsistente'), 'inconsistente', MSG_INCONSISTENTE],
    [err('functions/failed-precondition', 'saldo_inconsistente'), 'inconsistente', MSG_INCONSISTENTE],
    [err('functions/failed-precondition', 'conciliacion_requerida'), 'inconsistente', MSG_INCONSISTENTE],
    [err('functions/failed-precondition', 'ledger_inconsistente'), 'inconsistente', MSG_INCONSISTENTE],
    [err('functions/failed-precondition', 'motivo_que_este_build_no_conoce'), 'inconsistente', MSG_INCONSISTENTE],
    [err('functions/not-found'), 'estado_invalido', MSG_ESTADO_INVALIDO],
    [err('functions/permission-denied'), 'permiso', MSG_PERMISO],
    [err('functions/unauthenticated'), 'permiso', MSG_PERMISO],
    [err('functions/invalid-argument'), 'invalido', MSG_MOTIVO],
  ]
  for (const [e, categoria, texto] of casos) {
    const p = presentarErrorAccionSaldo(e)
    assert.equal(p.categoria, categoria); assert.equal(p.hecho, false)
    if (texto) assert.ok(p.mensaje.includes(texto), `${categoria}: ${p.mensaje}`)
    assert.throws(() => exigirHecho(p), (x: unknown) => x instanceof ErrorAccionSaldo && x.categoria === categoria)
  }
  for (const e of [err('functions/unavailable'), err('functions/internal'), new Error('Failed to fetch'), null, undefined, 'x']) {
    const p = presentarErrorAccionSaldo(e)
    assert.equal(p.categoria, 'temporal'); assert.equal(p.mensaje, MSG_TEMPORAL); assert.equal(p.hecho, false)
  }
  assert.equal(exigirHecho(presentarResultadoAnulacion({ resultado: 'anulada' })).hecho, true)
})

const manual = { estado: 'pendiente', tipo: 'ajuste_manual', origen: 'manual', saldoPendiente: 50, montoOriginal: 50, abonos: [] as unknown[] }

test('FIN1A-U3 · "Anular" es accionable SOLO en una deuda manual (ajuste_manual / otro) virgen; en el resto se muestra la razón', () => {
  assert.deepEqual(evaluarAnulacion(manual), { anulable: true })
  assert.deepEqual(evaluarAnulacion({ ...manual, tipo: 'otro', abonos: undefined }), { anulable: true })
  const no = (s: Parameters<typeof evaluarAnulacion>[0]) => evaluarAnulacion(s) as { anulable: false; razon: string }
  assert.match(no({ ...manual, origen: 'deposito', tipo: 'deposito_no_realizado', depositoId: 'D1' }).razon, /Revertir/)
  assert.match(no({ ...manual, tipo: 'deposito_no_realizado', origen: 'liquidacion', liquidacionId: 'L1' }).razon, /liquidación/)
  assert.match(no({ ...manual, liquidacionId: 'L1' }).razon, /liquidación/)
  assert.match(no({ ...manual, tipo: 'adelanto' }).razon, /legacy/)
  assert.match(no({ ...manual, estado: 'abonado_parcial', saldoPendiente: 40, abonos: [{}] }).razon, /abonos/)
  assert.match(no({ ...manual, abonos: [{}] }).razon, /abonos/)
  assert.match(no({ ...manual, saldoPendiente: 20 }).razon, /abonos/)
  assert.match(no({ ...manual, estado: 'pagado', saldoPendiente: 0 }).razon, /pagada/)
  assert.match(no({ ...manual, estado: 'condonado', saldoPendiente: 0 }).razon, /condonada/)
  assert.match(no({ ...manual, montoCondonado: 5 }).razon, /condonada/)
  assert.equal(no({ ...manual, estado: 'anulado' }).razon, MSG_INCONSISTENTE)
  assert.match(no({ ...manual, origen: 'raro' }).razon, /no se puede anular/)
})

// ── Contratos de la pantalla y los wrappers ──────────────────────────────────
const RAIZ = join(__dirname, '..')
const leer = (...ruta: string[]) => readFileSync(join(RAIZ, ...ruta), 'utf8').replace(/\r/g, '')
const sinComentarios = (s: string) => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '')

test('FIN1A-C1 · los writers cliente antiguos desaparecieron: ni exportados en financial-writes, ni importados, ni usados en ninguna superficie del producto', () => {
  const writes = sinComentarios(leer('lib', 'financial-writes.ts'))
  for (const nombre of ['condonarDeudaMotorizado', 'anularSaldoCargo', 'registrarAdelanto', 'crearSaldoCargo']) {
    assert.ok(!new RegExp(`export\\s+(async\\s+)?function\\s+${nombre}\\b`).test(writes), `${nombre} ya no existe en el cliente`)
  }
  // FIN-1D — crearSaldoCargo también se retiró: el saldo del neto negativo lo crea crearLiquidacionMotorizado.
  const stack = [join(RAIZ, 'app'), join(RAIZ, 'lib')]
  const archivos: string[] = []
  while (stack.length) {
    const d = stack.pop()!
    for (const n of readdirSync(d)) {
      const p = join(d, n)
      if (statSync(p).isDirectory()) stack.push(p)
      else if (/\.(ts|tsx)$/.test(n) && !/\.test\.ts$/.test(n) && !/-cliente\.ts$/.test(n)) archivos.push(p)
    }
  }
  const usos = archivos.filter((p) => /\b(condonarDeudaMotorizado|anularSaldoCargo|registrarAdelanto|crearSaldoCargo)\b/.test(sinComentarios(readFileSync(p, 'utf8'))))
  assert.deepEqual(usos, [], 'ningún archivo del producto referencia los writers retirados (salvo los wrappers -cliente.ts, que llaman a las callables por su nombre de string)')
})

test('FIN1A-C2 · handleCondonar y handleAnular llaman SOLO a las callables, con { saldoId, motivo }; sin writes directos ni monto/motorizado/actor/rol en el payload', () => {
  const p = sinComentarios(leer('app', 'panel', 'gestor', 'saldos', 'page.tsx'))
  const bloque = (desde: string, hasta: string) => { const i = p.indexOf(desde); const j = p.indexOf(hasta, i); assert.ok(i > 0 && j > i, desde); return p.slice(i, j) }
  const hCond = bloque('async function handleCondonar', 'async function handleAnular')
  const hAnul = bloque('async function handleAnular', 'return (')
  assert.ok(hCond.includes('condonarDeudaServidor(saldo.id, motivo.trim())'))
  assert.ok(hAnul.includes('anularSaldoServidor(saldo.id, motivo.trim())'))
  for (const [nombre, h] of [['handleCondonar', hCond], ['handleAnular', hAnul]] as const) {
    for (const prohibido of ['writeBatch', 'updateDoc', 'setDoc', 'addDoc', 'runTransaction', 'deleteField', 'movimientos_financieros', 'saldos_cargo_motorizado', 'monto:', 'operadorId', 'motorizadoId']) {
      assert.ok(!h.includes(prohibido), `${nombre} no usa ${prohibido}`)
    }
    assert.ok(h.includes('MSG_MOTIVO_SALDO'), `${nombre}: el motivo es obligatorio`)
  }
  assert.ok(hAnul.includes('evaluarAnulacion(saldo)'))
})

test('FIN1A-C3 · los wrappers entregan a httpsCallable SOLO { saldoId, motivo } (sin opcionales, monto, depósito, estado, actor ni rol)', () => {
  for (const [archivo, callable] of [['condonar-deuda-cliente.ts', 'condonarDeudaMotorizado'], ['anular-saldo-cliente.ts', 'anularSaldoCargo']] as const) {
    const w = sinComentarios(leer('lib', archivo))
    assert.ok(new RegExp(`httpsCallable<\\{ saldoId: string; motivo: string \\}, \\w+>\\(functions, '${callable}'\\)\\(\\{ saldoId, motivo \\}\\)`).test(w), `${archivo}: payload exacto`)
    for (const prohibido of ['depositoId', 'estado', 'monto', 'operadorId', 'actorUid', 'rol', 'undefined']) assert.ok(!w.includes(prohibido), `${archivo}: ${prohibido}`)
  }
})

test('FIN1A-C4 · el botón "Anular" pasa por evaluarAnulacion: accionable solo si procede; si no, deshabilitado con la razón visible', () => {
  const p = sinComentarios(leer('app', 'panel', 'gestor', 'saldos', 'page.tsx'))
  assert.ok(p.includes('evaluarAnulacion(s).anulable ?'))
  assert.ok(p.includes('disabled') && p.includes('(evaluarAnulacion(s) as { razon: string }).razon'))
})
