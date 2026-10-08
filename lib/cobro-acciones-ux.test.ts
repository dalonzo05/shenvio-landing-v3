// FIN-1C-A — presentación de Cobrar / Revertir / Pagar crédito semanal y CONTRATOS de la pantalla de Cobros.
//
// La autoridad (monto, estado, ledger, DEP tipo C, idempotencia y concurrencia) la prueban functions/test/cobros-autoritativos.test.ts
// (núcleos reales) y el runtime (emulador). Aquí: (1) que el cliente no confunda los resultados, (2) la identidad de cada intento,
// y (3) que ninguna superficie de Cobros escriba un pago, un DEP tipo C o un cobro semanal por su cuenta: solo las callables.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import {
  ErrorAccionCobro,
  MSG_COBRADO,
  MSG_COBRADO_LOTE,
  MSG_INCONSISTENTE_COBRO,
  MSG_INVALIDO_COBRO,
  MSG_PAGO_SEMANAL,
  MSG_PERMISO_COBRO,
  MSG_REVERTIDO,
  MSG_TEMPORAL_COBRO,
  MSG_YA_COBRADO,
  MSG_YA_PAGO_SEMANAL,
  MSG_YA_REVERTIDO,
  exigirHechoCobro,
  operacionDeCobro,
  operacionDeReversion,
  presentarErrorAccionCobro,
  presentarResultadoCobro,
  presentarResultadoPagoSemanal,
  presentarResultadoReversion,
} from './cobro-acciones-ux'

const err = (code: string, motivo?: string, extra: Record<string, unknown> = {}) => ({ code, message: 'msg del servidor', details: motivo ? { motivo, ...extra } : undefined })

test('FIN1C-U1 · los resultados exitosos y los idempotentes no se confunden', () => {
  assert.deepEqual(presentarResultadoCobro({ resultado: 'registrado', ordenIds: ['a'] }), { categoria: 'exito', mensaje: MSG_COBRADO, hecho: true })
  assert.deepEqual(presentarResultadoCobro({ resultado: 'registrado', ordenIds: ['a', 'b'] }), { categoria: 'exito', mensaje: MSG_COBRADO_LOTE, hecho: true })
  assert.deepEqual(presentarResultadoCobro({ resultado: 'ya_registrado', ordenIds: ['a'] }), { categoria: 'ya_hecho', mensaje: MSG_YA_COBRADO, hecho: true })
  assert.deepEqual(presentarResultadoReversion({ resultado: 'revertido' }), { categoria: 'exito', mensaje: MSG_REVERTIDO, hecho: true })
  assert.deepEqual(presentarResultadoReversion({ resultado: 'ya_revertido' }), { categoria: 'ya_hecho', mensaje: MSG_YA_REVERTIDO, hecho: true })
  assert.deepEqual(presentarResultadoPagoSemanal({ resultado: 'registrado' }), { categoria: 'exito', mensaje: MSG_PAGO_SEMANAL, hecho: true })
  assert.deepEqual(presentarResultadoPagoSemanal({ resultado: 'ya_registrado' }), { categoria: 'ya_hecho', mensaje: MSG_YA_PAGO_SEMANAL, hecho: true })
})

test('FIN1C-U2 · cada rechazo del servidor se presenta con su categoría y mensaje; ninguno cuenta como hecho', () => {
  const casos: Array<[unknown, string, string?]> = [
    [err('functions/failed-precondition', 'orden_ya_pagada'), 'bloqueado', 'ya está pagada'],
    [err('functions/failed-precondition', 'orden_no_entregada'), 'bloqueado', 'entregada'],
    [err('functions/failed-precondition', 'orden_credito'), 'bloqueado', 'crédito semanal'],
    [err('functions/failed-precondition', 'orden_no_cobrable'), 'bloqueado', 'no cobrable'],
    [err('functions/failed-precondition', 'incidencia_abierta'), 'bloqueado', 'incidencia'],
    [err('functions/failed-precondition', 'monto_cero'), 'bloqueado', 'monto'],
    [err('functions/failed-precondition', 'boucher_requerido'), 'bloqueado', 'comprobante'],
    [err('functions/failed-precondition', 'puntero_ocupado'), 'bloqueado', 'depósito de Storkhub'],
    [err('functions/failed-precondition', 'cobro_no_pagado'), 'bloqueado', 'ya no está pagada'],
    [err('functions/failed-precondition', 'operacion_inconsistente'), 'bloqueado', 'otros datos'],
    [err('functions/failed-precondition', 'demasiadas_ordenes'), 'bloqueado', 'grupos más chicos'],
    [err('functions/failed-precondition', 'monto_inconsistente'), 'inconsistente', MSG_INCONSISTENTE_COBRO],
    [err('functions/failed-precondition', 'conciliacion_requerida'), 'inconsistente', MSG_INCONSISTENTE_COBRO],
    [err('functions/failed-precondition', 'cobro_semanal_invalido'), 'inconsistente', MSG_INCONSISTENTE_COBRO],
    [err('functions/failed-precondition', 'motivo_que_este_build_no_conoce'), 'inconsistente', MSG_INCONSISTENTE_COBRO],
    [err('functions/not-found'), 'estado_invalido', 'cambió'],
    [err('functions/permission-denied'), 'permiso', MSG_PERMISO_COBRO],
    [err('functions/unauthenticated'), 'permiso', MSG_PERMISO_COBRO],
    [err('functions/invalid-argument'), 'invalido', MSG_INVALIDO_COBRO],
  ]
  for (const [e, categoria, texto] of casos) {
    const p = presentarErrorAccionCobro(e)
    assert.equal(p.categoria, categoria); assert.equal(p.hecho, false)
    if (texto) assert.ok(p.mensaje.includes(texto), `${categoria}: ${p.mensaje}`)
    assert.throws(() => exigirHechoCobro(p), (x: unknown) => x instanceof ErrorAccionCobro && x.categoria === categoria)
  }
  for (const e of [err('functions/unavailable'), err('functions/internal'), err('functions/aborted'), new Error('Failed to fetch'), null, undefined, 'x']) {
    const p = presentarErrorAccionCobro(e)
    assert.equal(p.categoria, 'temporal'); assert.equal(p.mensaje, MSG_TEMPORAL_COBRO); assert.equal(p.hecho, false)
  }
  assert.equal(exigirHechoCobro(presentarResultadoCobro({ resultado: 'registrado', ordenIds: ['a'] })).hecho, true)
})

test('FIN1C-U3 · saldo_insuficiente lleva el saldo real que dijo el servidor y lo formatea con la función de la pantalla', () => {
  const p = presentarErrorAccionCobro(err('functions/failed-precondition', 'saldo_insuficiente', { saldoReal: 50 }), (n) => `C$ ${n.toFixed(2)}`)
  assert.equal(p.categoria, 'saldo'); assert.equal(p.hecho, false); assert.equal(p.saldoReal, 50)
  assert.equal(p.mensaje, 'El monto excede el saldo pendiente real (C$ 50.00).')
  const sin = presentarErrorAccionCobro(err('functions/failed-precondition', 'saldo_insuficiente'))
  assert.equal(sin.categoria, 'saldo'); assert.equal(sin.saldoReal, undefined)
  assert.throws(() => exigirHechoCobro(p), (x: unknown) => x instanceof ErrorAccionCobro && x.saldoReal === 50)
})

test('FIN1C-U4 · un intento conserva su operacionId mientras son las mismas órdenes y la misma forma de pago (sin importar el orden); cambia con otras órdenes u otra forma', () => {
  let n = 0
  const nuevo = () => `op-${++n}-xxxxxxxx`
  const a = operacionDeCobro(null, ['b', 'a'], 'efectivo', nuevo)
  assert.equal(a.operacionId, 'op-1-xxxxxxxx')
  assert.equal(operacionDeCobro(a, ['a', 'b'], 'efectivo', nuevo), a, 'el reintento (misma clave) reusa la operación')
  assert.notEqual(operacionDeCobro(a, ['a', 'b'], 'transferencia', nuevo).operacionId, a.operacionId)
  assert.notEqual(operacionDeCobro(a, ['a'], 'efectivo', nuevo).operacionId, a.operacionId)
  assert.match(a.operacionId, /^[A-Za-z0-9_-]{8,64}$/)
  const r = operacionDeReversion(null, 'S1', nuevo)
  assert.equal(operacionDeReversion(r, 'S1', nuevo), r)
  assert.notEqual(operacionDeReversion(r, 'S2', nuevo).operacionId, r.operacionId)
})

// ── Contratos de la pantalla y los wrappers ──────────────────────────────────
const RAIZ = join(__dirname, '..')
const leer = (...ruta: string[]) => readFileSync(join(RAIZ, ...ruta), 'utf8').replace(/\r/g, '')
const sinComentarios = (s: string) => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '').replace(/\{\/\*[\s\S]*?\*\/\}/g, '')

function bloque(src: string, desde: string, hasta: string): string {
  const i = src.indexOf(desde)
  const j = src.indexOf(hasta, i + desde.length)
  assert.ok(i >= 0 && j > i, `${desde} … ${hasta}`)
  return src.slice(i, j)
}

test('FIN1C-K1 · los writers financieros de Cobros llaman SOLO a las callables: sin movimiento, DEP tipo C, cobro semanal, estado pagado ni transacción', () => {
  const p = sinComentarios(leer('app', 'panel', 'gestor', 'cobros', 'page.tsx'))
  const writers: Array<[string, string, string, string]> = [
    ['PagoModal.handlePago', 'async function handlePago() {', '  return (', 'registrarPagoCobroSemanalServidor(cobroSemanal.id, montoNum, pagoId, nota)'],
    ['BoucherModal.handleConfirmar', 'async function handleConfirmar() {\n    setSaving(true); setErr(null)\n    try {\n      // ', '  return (', "registrarCobroDeliveryServidor([orden.id], 'transferencia', intentoRef.current.operacionId)"],
    ['PagoContadoModal.handleConfirmar', "async function handleConfirmar() {\n    if (formaPago !== 'efectivo'", '  return (', 'registrarCobroDeliveryServidor([orden.id], formaPago, intentoRef.current.operacionId, nota)'],
    ['revertirPagada', 'async function revertirPagada(', '  // Contado pagados (historial)', 'revertirCobroDeliveryServidor(orden.id, intentoReversionRef.current.operacionId)'],
    ['marcarGrupoPagado', 'async function marcarGrupoPagado(', '  // ── Subida de boucher por gestor', 'registrarCobroDeliveryServidor(ids, formaPago, intentoGrupoRef.current.operacionId)'],
  ]
  for (const [nombre, desde, hasta, llamada] of writers) {
    const h = bloque(leer('app', 'panel', 'gestor', 'cobros', 'page.tsx'), desde, hasta)
    const hs = sinComentarios(h)
    assert.ok(hs.includes(llamada), `${nombre}: llama a su callable`)
    for (const prohibido of ['runTransaction', 'writeBatch', 'updateDoc', 'setDoc', 'addDoc', 'tx.', 'getDocs', 'getDoc(', 'registrarMovimiento', 'movimientos_financieros', 'ordenes_deposito', 'cobros_semanales', "'pagado'", 'serverTimestamp', 'Timestamp.now']) {
      assert.ok(!hs.includes(prohibido), `${nombre} no usa ${prohibido}`)
    }
  }
  for (const n of ['registrarMovimiento', 'camposReversionCobro', 'planReversionDeposito', 'camposAnulacionDeposito', 'MOTIVO_ANULACION_REVERSION', 'camposConfirmacionDeposito', 'asegurarCobroConfirmable', 'SaldoInsuficienteError']) {
    assert.ok(!new RegExp(`\\b${n}\\b`).test(p), `${n} ya no lo usa la pantalla`)
  }
  assert.ok(!p.includes("'cobroDelivery.estado': 'pagado'"), 'la pantalla no escribe cobroDelivery.estado = pagado')
  assert.ok(!/tx\.set\(|addDoc\(|setDoc\(|writeBatch\(/.test(p), 'la pantalla no crea ningún documento')
  assert.ok(!/collection\(db, 'movimientos_financieros'\)/.test(p))
})

test('FIN1C-K2 · lo legítimo de Cobros sigue en el cliente: boucher (subir, reemplazar, quitar) y ResolveModal; y la pantalla sigue LEYENDO cobros_semanales', () => {
  const p = sinComentarios(leer('app', 'panel', 'gestor', 'cobros', 'page.tsx'))
  for (const n of ['handleQuitar', 'handleReemplazar', 'handleGestorBoucherUpload', 'handleResolver', 'asegurarBoucherCobroMutable']) {
    assert.ok(new RegExp(`\\b${n}\\b`).test(p), `${n} sigue (flujo legítimo)`)
  }
  assert.ok(p.includes("'cobrosMotorizado.resolucion'") && p.includes("'cobrosMotorizado.producto.resolucion'"), 'ResolveModal conserva sus campos')
  assert.ok(p.includes("collection(db, 'cobros_semanales')"), 'la pantalla lee cobros_semanales')
  // Lo único que el cliente escribe en cobroDelivery.estado es pendiente / en_revision_deposito / no_cobrar (las Rules lo exigen igual).
  const estados = [...p.matchAll(/'cobroDelivery\.estado':\s*([^,\n}]+)/g)].map((m) => m[1].trim())
  assert.ok(estados.length > 0)
  for (const e of estados) assert.ok(!e.includes('pagado'), `estado escrito por el cliente: ${e}`)
})

test('FIN1C-K3 · los wrappers entregan a httpsCallable SOLO los campos del contrato (sin monto, estado, movimientos, depósitos, actor ni rol)', () => {
  const cobro = sinComentarios(leer('lib', 'registrar-cobro-delivery-cliente.ts'))
  assert.ok(cobro.includes("httpsCallable<typeof payload, ResultadoCobroServidor>(functions, 'registrarCobroDelivery')(payload)"))
  assert.ok(cobro.includes('{ operacionId, ordenIds, formaPago }'))
  const rev = sinComentarios(leer('lib', 'revertir-cobro-delivery-cliente.ts'))
  assert.ok(/httpsCallable<\{ operacionId: string; ordenId: string \}, \w+>\(functions, 'revertirCobroDelivery'\)\(\{ operacionId, ordenId \}\)/.test(rev), 'payload exacto de la reversión')
  const sem = sinComentarios(leer('lib', 'registrar-pago-cobro-semanal-cliente.ts'))
  assert.ok(sem.includes("httpsCallable<typeof payload, ResultadoPagoSemanalServidor>(functions, 'registrarPagoCobroSemanal')(payload)"))
  assert.ok(sem.includes('{ pagoId, cobroSemanalId, monto }'))
  // Ningún wrapper manda estado, movimientos, depósitos, actor ni rol; solo el de pago semanal manda un monto (el del propio pago).
  const limpio = (w: string) => w.replace(/Resultado\w+Servidor/g, '')
  for (const w of [cobro, rev, sem]) assert.ok(!/estado|movimiento|deposito|actorUid|\brol\b|totalPagado|undefined/i.test(limpio(w)), 'wrapper: campo prohibido')
  for (const w of [cobro, rev]) assert.ok(!/\bmonto\b|total/i.test(limpio(w)), 'wrapper de cobro/reversión: el monto lo calcula el servidor')
})

test('FIN1C-K4 · ninguna otra pantalla escribe un pago_recibido, un DEP tipo C ni cobros_semanales (salvo la deuda explícita FIN-1E del ledger global)', () => {
  const archivos = [
    ['app', 'panel', 'gestor', 'cobros', 'page.tsx'],
    ['app', 'panel', 'gestor', 'depositos', 'page.tsx'],
    ['app', 'panel', 'gestor', 'financiero', 'page.tsx'],
    ['app', 'panel', 'motorizado', 'page.tsx'],
    ['app', 'panel', 'comercio', 'mis-ordenes', 'page.tsx'],
  ]
  for (const a of archivos) {
    const p = sinComentarios(leer(...a))
    assert.ok(!/['"]pago_delivery_deposito['"][\s\S]{0,200}(setDoc|addDoc|tx\.set|batch\.set)/.test(p), `${a.join('/')} no crea un DEP tipo C`)
    assert.ok(!/(setDoc|updateDoc|addDoc|tx\.update|tx\.set)\([^)]*cobros_semanales/.test(p), `${a.join('/')} no escribe cobros_semanales`)
    assert.ok(!/registrarMovimiento\(\s*['"]pago_recibido['"]/.test(p), `${a.join('/')} no registra pago_recibido`)
  }
})
