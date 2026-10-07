// FIN-4B — presentación de la reversión, cuándo se ofrece "Revertir" y CONTRATOS de la pantalla de Saldos.
//
// La atomicidad, la idempotencia, el bloqueo por abonos/pago/condonación, la concurrencia y el destino con y sin
// boucher los prueban functions/test/reversion-conversion.test.ts (núcleo real) y el runtime (emulador). Aquí se
// prueba lo que le toca al cliente: (1) que no confunda los resultados, (2) que solo ofrezca "Revertir" en una
// deuda aparentemente virgen y diga la razón en el resto, (3) que el texto no prometa siempre "En revisión", y
// (4) que ninguna superficie del producto revierta por su cuenta: solo la callable, con { saldoId, motivo }.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'
import {
  ErrorReversionConversion,
  MSG_CON_ABONOS,
  MSG_CONDONADA,
  MSG_ESTADO_INVALIDO,
  MSG_INCONSISTENTE,
  MSG_MOTIVO,
  MSG_PAGADA,
  MSG_PERMISO,
  MSG_REVERTIDA_CON_BOUCHER,
  MSG_REVERTIDA_SIN_BOUCHER,
  MSG_TEMPORAL,
  MSG_YA_REVERTIDA,
  depositoTieneBoucher,
  evaluarReversibilidad,
  exigirRevertida,
  presentarErrorReversion,
  presentarResultadoReversion,
  textoConfirmacionReversion,
} from './reversion-conversion-ux'

const err = (code: string, motivo?: string, message = 'msg del servidor') => ({ code, message, details: motivo ? { motivo } : undefined })

// ── Presentación ─────────────────────────────────────────────────────────────
test('F4B-U1 · el resultado se presenta según el destino: con boucher "En revisión"; sin boucher "Pendiente de boucher"; ya_revertida no escribe nada nuevo', () => {
  assert.deepEqual(presentarResultadoReversion({ resultado: 'revertida', estadoDeposito: 'en_revision' }), { categoria: 'exito', mensaje: MSG_REVERTIDA_CON_BOUCHER, revertida: true })
  assert.deepEqual(presentarResultadoReversion({ resultado: 'revertida', estadoDeposito: 'pendiente_boucher' }), { categoria: 'exito', mensaje: MSG_REVERTIDA_SIN_BOUCHER, revertida: true })
  assert.deepEqual(presentarResultadoReversion({ resultado: 'ya_revertida', estadoDeposito: 'en_revision' }), { categoria: 'ya_revertida', mensaje: MSG_YA_REVERTIDA, revertida: true })
  assert.ok(MSG_REVERTIDA_CON_BOUCHER.includes('En revisión') && MSG_REVERTIDA_SIN_BOUCHER.includes('Pendiente de boucher'))
})

test('F4B-U2 · cada rechazo del servidor se presenta con SU categoría y su mensaje; ninguno cuenta como revertida', () => {
  const casos: Array<[unknown, string, string]> = [
    [err('functions/failed-precondition', 'deuda_con_abonos'), 'con_abonos', MSG_CON_ABONOS],
    [err('failed-precondition', 'deuda_pagada'), 'pagada', MSG_PAGADA],
    [err('functions/failed-precondition', 'deuda_condonada'), 'condonada', MSG_CONDONADA],
    [err('functions/failed-precondition', 'conversion_inconsistente'), 'inconsistente', MSG_INCONSISTENTE],
    [err('functions/failed-precondition', 'movimientos_activos'), 'inconsistente', MSG_INCONSISTENTE],
    [err('functions/failed-precondition', 'motivo_que_este_build_no_conoce'), 'inconsistente', MSG_INCONSISTENTE],
    [err('functions/failed-precondition', 'saldo_no_revertible'), 'estado_invalido', MSG_ESTADO_INVALIDO],
    [err('functions/not-found'), 'estado_invalido', MSG_ESTADO_INVALIDO],
    [err('functions/permission-denied'), 'permiso', MSG_PERMISO],
    [err('functions/unauthenticated'), 'permiso', MSG_PERMISO],
    [err('functions/invalid-argument'), 'invalido', MSG_MOTIVO],
  ]
  for (const [e, categoria, mensaje] of casos) {
    const p = presentarErrorReversion(e)
    assert.equal(p.categoria, categoria); assert.equal(p.mensaje, mensaje); assert.equal(p.revertida, false)
    assert.throws(() => exigirRevertida(p), (x: unknown) => x instanceof ErrorReversionConversion && x.categoria === categoria)
  }
})

test('F4B-U3 · un error de red / servidor es "temporal": no se sabe si se revirtió, no se reintenta solo', () => {
  for (const e of [err('functions/unavailable'), err('functions/deadline-exceeded'), err('functions/internal'), err('functions/unknown'), new Error('Failed to fetch'), null, undefined, 'x']) {
    const p = presentarErrorReversion(e)
    assert.equal(p.categoria, 'temporal'); assert.equal(p.mensaje, MSG_TEMPORAL); assert.equal(p.revertida, false)
  }
  assert.equal(exigirRevertida(presentarResultadoReversion({ resultado: 'revertida', estadoDeposito: 'en_revision' })).revertida, true)
})

// ── ¿Se ofrece "Revertir"? ───────────────────────────────────────────────────
const virgen = { estado: 'pendiente', saldoPendiente: 90, montoOriginal: 90, abonos: [] as unknown[] }

test('F4B-U4 · "Revertir" es accionable SOLO en una deuda aparentemente virgen; en el resto se muestra la razón exacta', () => {
  assert.deepEqual(evaluarReversibilidad(virgen), { reversible: true })
  assert.deepEqual(evaluarReversibilidad({ ...virgen, abonos: undefined }), { reversible: true })
  const no = (s: Parameters<typeof evaluarReversibilidad>[0]) => evaluarReversibilidad(s) as { reversible: false; categoria: string; razon: string }
  assert.equal(no({ ...virgen, estado: 'abonado_parcial', saldoPendiente: 50, abonos: [{}] }).categoria, 'con_abonos')
  assert.match(no({ ...virgen, estado: 'abonado_parcial', saldoPendiente: 50, abonos: [{}] }).razon, /abonos registrados.*no puede revertirse automáticamente/i)
  assert.equal(no({ ...virgen, abonos: [{}] }).categoria, 'con_abonos', 'un abono bloquea aunque el pendiente haya vuelto al original')
  assert.equal(no({ ...virgen, saldoPendiente: 50 }).categoria, 'con_abonos')
  assert.deepEqual(no({ ...virgen, estado: 'pagado', saldoPendiente: 0, abonos: [{}] }), { reversible: false, categoria: 'pagada', razon: MSG_PAGADA })
  assert.deepEqual(no({ ...virgen, estado: 'condonado', saldoPendiente: 0, montoCondonado: 90 }), { reversible: false, categoria: 'condonada', razon: MSG_CONDONADA })
  assert.equal(no({ ...virgen, condonadoAt: {} }).categoria, 'condonada')
  assert.equal(no({ ...virgen, movimientoCondonacionId: 'mc' }).categoria, 'condonada')
  assert.deepEqual(no({ ...virgen, estado: 'anulado' }), { reversible: false, categoria: 'inconsistente', razon: MSG_INCONSISTENTE })
})

test('F4B-U5 · el texto de confirmación depende del boucher: no promete siempre "En revisión"', () => {
  const con = textoConfirmacionReversion({ motorizado: 'Luigi', monto: 'C$ 90', tieneBoucher: true })
  const sin = textoConfirmacionReversion({ motorizado: 'Luigi', monto: 'C$ 90', tieneBoucher: false })
  assert.ok(con.includes('"En revisión"') && !con.includes('Pendiente de boucher'))
  assert.ok(sin.includes('"Pendiente de boucher"') && !sin.includes('"En revisión"'))
  for (const t of [con, sin]) assert.ok(t.includes('Luigi') && t.includes('C$ 90') && /sin abonos/i.test(t))
  assert.equal(depositoTieneBoucher({ boucher: { url: 'https://x/y.jpg' } }), true)
  assert.equal(depositoTieneBoucher({ boucher: { pathStorage: 'depositos/a/b/boucher.jpg' } }), true)
  assert.equal(depositoTieneBoucher({ boucher: {} }), false)
  assert.equal(depositoTieneBoucher({}), false)
  assert.equal(depositoTieneBoucher(null), false)
})

// ── Contratos de la pantalla y del wrapper ───────────────────────────────────
const RAIZ = join(__dirname, '..')
const leer = (...ruta: string[]) => readFileSync(join(RAIZ, ...ruta), 'utf8').replace(/\r/g, '')
const sinComentarios = (s: string) => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '')

test('F4B-C1 · el writer cliente desapareció: ni exportado en financial-writes, ni importado, ni usado en ninguna superficie del producto', () => {
  const writes = sinComentarios(leer('lib', 'financial-writes.ts'))
  assert.ok(!/export\s+(async\s+)?function\s+revertirConversionEnDeuda\b/.test(writes), 'el writer cliente ya no existe')
  const pagina = sinComentarios(leer('app', 'panel', 'gestor', 'saldos', 'page.tsx'))
  assert.ok(!/revertirConversionEnDeuda\b/.test(pagina.replace(/revertirConversionEnDeudaServidor/g, '')), 'la pantalla no usa el writer cliente')
  const stack = [join(RAIZ, 'app'), join(RAIZ, 'lib')]
  const archivos: string[] = []
  while (stack.length) {
    const d = stack.pop()!
    for (const n of readdirSync(d)) {
      const p = join(d, n)
      if (statSync(p).isDirectory()) stack.push(p)
      else if (/\.(ts|tsx)$/.test(n) && !/\.test\.ts$/.test(n)) archivos.push(p)
    }
  }
  const usos = archivos.filter((p) => /revertirConversionEnDeuda\b/.test(sinComentarios(readFileSync(p, 'utf8')).replace(/revertirConversionEnDeudaServidor/g, '')) && !p.endsWith('revertir-conversion-cliente.ts'))
  assert.deepEqual(usos, [], 'ningún archivo del producto referencia el writer retirado')
})

test('F4B-C2 · handleRevertir llama a la callable con { saldoId, motivo } y a nada más: sin batch, sin movimiento, sin saldo, sin depósito escritos por la pantalla', () => {
  const p = sinComentarios(leer('app', 'panel', 'gestor', 'saldos', 'page.tsx'))
  const ini = p.indexOf('async function handleRevertir'); const fin = p.indexOf('async function handleCondonar')
  assert.ok(ini > 0 && fin > ini)
  const h = p.slice(ini, fin)
  assert.ok(h.includes('revertirConversionEnDeudaServidor(saldo.id, motivo.trim())'))
  for (const prohibido of ['writeBatch', 'updateDoc', 'setDoc', 'addDoc', 'runTransaction', 'deleteField', 'movimientos_financieros', 'saldos_cargo_motorizado']) {
    assert.ok(!h.includes(prohibido), `handleRevertir no usa ${prohibido}`)
  }
  assert.ok(h.includes('evaluarReversibilidad(saldo)') && h.includes('textoConfirmacionReversion') && h.includes('depositoTieneBoucher'))
  assert.ok(h.includes('MSG_MOTIVO'), 'el motivo es obligatorio')
})

test('F4B-C3 · el wrapper entrega a httpsCallable SOLO { saldoId, motivo } (sin opcionales ni depósito/estado/monto/actor)', () => {
  const w = sinComentarios(leer('lib', 'revertir-conversion-cliente.ts'))
  assert.match(w, /httpsCallable<\{ saldoId: string; motivo: string \}, ResultadoReversionServidor>\(functions, 'revertirConversionEnDeuda'\)\(\{ saldoId, motivo \}\)/)
  for (const prohibido of ['depositoId', 'estado', 'monto', 'operadorId', 'actorUid', 'rol', 'undefined']) assert.ok(!w.includes(prohibido), prohibido)
})

test('F4B-C4 · el botón "Revertir" de la pantalla pasa por evaluarReversibilidad: accionable solo si es reversible; si no, deshabilitado con la razón visible', () => {
  const p = sinComentarios(leer('app', 'panel', 'gestor', 'saldos', 'page.tsx'))
  assert.ok(p.includes('evaluarReversibilidad(s).reversible ?'))
  assert.ok(p.includes('disabled') && p.includes('(evaluarReversibilidad(s) as { razon: string }).razon'))
})
