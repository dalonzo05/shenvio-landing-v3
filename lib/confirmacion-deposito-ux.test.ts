// FIN-3 — presentación del resultado de confirmarDeposito y CONTRATOS de la pantalla.
//
// La atomicidad, la idempotencia y la demostración del monto las prueba
// functions/test/confirmacion-deposito.test.ts. Aquí se prueba lo que le toca al
// cliente: (1) que no confunda los seis resultados y (2) que ninguna superficie
// del producto siga confirmando depósitos por su cuenta.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'
import {
  ErrorConfirmacionDeposito,
  MSG_CONFIRMADO,
  MSG_ESTADO_CAMBIO,
  MSG_PERMISO,
  MSG_TEMPORAL,
  MSG_YA_PROCESADO,
  exigirConfirmado,
  presentarErrorConfirmacion,
  presentarResultadoConfirmacion,
} from './confirmacion-deposito-ux'

const err = (code: string, motivo?: string, message = 'msg del servidor') => ({ code, message, details: motivo ? { motivo } : undefined })

// ── presentación ─────────────────────────────────────────────────────────────

test('F3-U1 · confirmado y ya_confirmado NO se confunden: el segundo dice que no se registró nada nuevo', () => {
  assert.deepEqual(presentarResultadoConfirmacion({ resultado: 'confirmado' }), { categoria: 'exito', mensaje: MSG_CONFIRMADO, confirmado: true })
  assert.deepEqual(presentarResultadoConfirmacion({ resultado: 'ya_confirmado' }), { categoria: 'ya_procesada', mensaje: MSG_YA_PROCESADO, confirmado: true })
  assert.match(MSG_YA_PROCESADO, /nada nuevo/)
})

test('F3-U2 · permiso: permission-denied y unauthenticated, con o sin el prefijo functions/', () => {
  for (const code of ['permission-denied', 'functions/permission-denied', 'unauthenticated', 'functions/unauthenticated']) {
    assert.deepEqual(presentarErrorConfirmacion(err(code)), { categoria: 'permiso', mensaje: MSG_PERMISO, confirmado: false }, code)
  }
})

test('F3-U3 · estado cambió: motivo estado_cambio y not-found piden actualizar, no hablan de montos', () => {
  for (const e of [err('functions/failed-precondition', 'estado_cambio'), err('failed-precondition', 'estado_cambio'), err('functions/not-found')]) {
    assert.deepEqual(presentarErrorConfirmacion(e), { categoria: 'estado_cambio', mensaje: MSG_ESTADO_CAMBIO, confirmado: false })
  }
})

test('F3-U4 · inconsistencia financiera: cualquier otro failed-precondition dice que NO se confirmó y trae la causa del servidor', () => {
  for (const motivo of ['monto_inconsistente', 'orden_invalida', 'gasto_invalido', 'gasto_sin_marca', 'ledger_inconsistente', 'sin_ordenes', 'tipo_no_confirmable']) {
    const p = presentarErrorConfirmacion(err('functions/failed-precondition', motivo, 'El monto no coincide.'))
    assert.equal(p.categoria, 'inconsistencia', motivo)
    assert.equal(p.confirmado, false, motivo)
    assert.match(p.mensaje, /No se confirmó/, motivo)
    assert.match(p.mensaje, /El monto no coincide\./, motivo)
  }
})

test('F3-U5 · error temporal: red, timeout o error interno ⇒ NO se sabe si se confirmó, y se manda a revisar antes de reintentar', () => {
  for (const e of [err('functions/unavailable'), err('functions/deadline-exceeded'), err('functions/internal'), err('functions/unknown'), new Error('Failed to fetch'), null, undefined, 'x']) {
    const p = presentarErrorConfirmacion(e)
    assert.deepEqual(p, { categoria: 'temporal', mensaje: MSG_TEMPORAL, confirmado: false })
  }
  assert.match(MSG_TEMPORAL, /No sabemos si llegó a confirmarse/)
  assert.match(MSG_TEMPORAL, /antes de reintentar/)
})

test('F3-U6 · nunca se muestra éxito si la callable falló: exigirConfirmado lanza con la categoría', () => {
  assert.doesNotThrow(() => exigirConfirmado(presentarResultadoConfirmacion({ resultado: 'confirmado' })))
  assert.doesNotThrow(() => exigirConfirmado(presentarResultadoConfirmacion({ resultado: 'ya_confirmado' })))
  for (const e of [err('functions/permission-denied'), err('functions/failed-precondition', 'monto_inconsistente'), err('functions/unavailable')]) {
    assert.throws(() => exigirConfirmado(presentarErrorConfirmacion(e)), (x: unknown) => x instanceof ErrorConfirmacionDeposito && x.message.length > 0)
  }
})

// ── contratos de la pantalla ─────────────────────────────────────────────────

const RAIZ = join(__dirname, '..')
const leer = (...ruta: string[]) => readFileSync(join(RAIZ, ...ruta), 'utf8').replace(/\r/g, '')
const PAGINA = () => leer('app', 'panel', 'gestor', 'depositos', 'page.tsx')

function cuerpoDe(src: string, nombre: string): string {
  const ini = src.indexOf(`async function ${nombre}(`)
  assert.ok(ini >= 0, `existe ${nombre}`)
  const candidatos = [src.indexOf('\n  async function ', ini + 10), src.indexOf('\n  // ── ', ini + 10), src.indexOf('\n  /**\n', ini + 10)].filter((x) => x > 0)
  return src.slice(ini, Math.min(...candidatos))
}

const PROHIBIDO_EN_CONFIRMAR = [
  'registrarMovimiento',
  'camposConfirmarDeposito',
  'camposEventoDepositoConfirmado',
  'confirmadoStorkhub',
  'confirmadoComercio',
  "estado: 'confirmado'",
  'estado: "confirmado"',
  'movimientos_financieros',
  'SUBCOLECCION_EVENTOS_DEPOSITO',
]

test('F3-C1 · confirmar un depósito EXISTENTE llama a la callable y no escribe nada financiero', () => {
  const c = cuerpoDe(PAGINA(), 'confirmarDepositoExistente')
  assert.ok(c.includes('confirmarDepositoServidor(dep.id)'), 'invoca la callable con el id')
  for (const t of PROHIBIDO_EN_CONFIRMAR) assert.ok(!c.includes(t), `no contiene ${t}`)
  assert.ok(!c.includes('writeBatch') && !c.includes('.commit(') && !c.includes('setDoc') && !c.includes('updateDoc'), 'ningún write de cliente')
})

test('F3-C2 · confirmarStorkhub y confirmarComercio terminan en la callable, DESPUÉS de dejar el depósito en revisión', () => {
  const src = PAGINA()
  for (const [nombre, destino] of [['confirmarStorkhub', 'storkhub'], ['confirmarComercio', 'comercio']] as const) {
    const c = cuerpoDe(src, nombre)
    for (const t of PROHIBIDO_EN_CONFIRMAR.filter((x) => x !== 'movimientos_financieros')) assert.ok(!c.includes(t), `${nombre} no contiene ${t}`)
    const iRev = c.indexOf(`enviarARevision(depositoRef, boucherData, ordenes, '${destino}', depositoId)`)
    const iSrv = c.indexOf('await confirmarEnServidor(depositoId)')
    assert.ok(iRev > 0, `${nombre} materializa el depósito en revisión`)
    assert.ok(iSrv > iRev, `${nombre} confirma DESPUÉS`)
    assert.equal((c.match(/confirmarEnServidor\(/g) ?? []).length, 1, `${nombre} confirma una sola vez`)
    assert.ok(c.includes("['en_revision', 'confirmado'].includes("), `${nombre} reanuda un depósito ya materializado en vez de recrearlo`)
  }
})

test('F3-C3 · enviarARevision deja el depósito en en_revision (jamás confirmado) y enlaza las órdenes en el mismo batch', () => {
  const src = PAGINA()
  const c = cuerpoDe(src, 'enviarARevision')
  assert.ok(c.includes("estado: 'en_revision'"))
  assert.ok(!c.includes("'confirmado'"))
  assert.ok(c.includes('camposEnlaceDigitacion(destino, depositoId)'))
  assert.equal((c.match(/writeBatch\(db\)/g) ?? []).length, 1)
  assert.equal((c.match(/\.commit\(\)/g) ?? []).length, 1)
})

test('F3-C4 · confirmarEnServidor es el único punto que invoca la callable y no reintenta por su cuenta', () => {
  const src = PAGINA()
  const c = cuerpoDe(src, 'confirmarEnServidor')
  assert.ok(c.includes('confirmarDepositoServidor(depositoId)'))
  assert.ok(c.includes('exigirConfirmado('), 'un fallo lanza; no se muestra éxito')
  assert.ok(!/for \(|while \(|setTimeout|retry/i.test(c), 'sin reintentos automáticos')
  // y la página invoca la callable solo desde los dos puntos previstos
  assert.equal((src.match(/confirmarDepositoServidor\(/g) ?? []).length, 2)
})

test('F3-C5 · el writer cliente viejo desapareció: ni escribirConfirmacionConEvento, ni registrarMovimiento, ni el ledger de depósitos', () => {
  const src = PAGINA()
  assert.ok(!src.includes('escribirConfirmacionConEvento'))
  assert.ok(!/import \{[^}]*registrarMovimiento[^}]*\} from/.test(src), 'la página ni importa registrarMovimiento')
  assert.ok(!src.includes('deposito_efectivo_'), 'la página no arma movimientos de depósito')
  assert.ok(!src.includes('camposConfirmarDeposito') && !src.includes('camposEventoDepositoConfirmado'))
})

test('F3-C6 · ninguna otra pantalla de la app crea movimientos de depósito A/B ni confirma depósitos de motorizado', () => {
  const ofensores: string[] = []
  const recorrer = (dir: string) => {
    for (const nombre of readdirSync(dir)) {
      if (nombre === 'node_modules' || nombre.startsWith('.')) continue
      const ruta = join(dir, nombre)
      if (statSync(ruta).isDirectory()) { recorrer(ruta); continue }
      if (!/\.(ts|tsx)$/.test(nombre) || /\.test\./.test(nombre)) continue
      const t = readFileSync(ruta, 'utf8')
      if (/deposito_efectivo_(storkhub|comercio)/.test(t)) ofensores.push(ruta.replace(RAIZ, ''))
    }
  }
  recorrer(join(RAIZ, 'app'))
  assert.deepEqual(ofensores, [], 'solo la callable del servidor escribe esos movimientos')
})

test('F3-C7 · el wrapper de la callable manda SOLO el id: ni monto, ni actor, ni estado, ni órdenes', () => {
  const w = leer('lib', 'confirmar-deposito-cliente.ts')
  assert.ok(w.includes("'confirmarDeposito'"))
  assert.ok(w.includes('({ depositoId })'))
  assert.ok(!/monto|uid|estado|solicitudIds|gastosIds|rol/i.test(w.replace(/\/\/.*$/gm, '')), 'el payload no lleva nada financiero')
  assert.ok(!/retry|setTimeout|while \(|for \(/.test(w), 'sin reintentos')
})

test('F3-C8 · la pantalla muestra el rechazo del servidor y no lo disfraza de "error de boucher"', () => {
  const src = PAGINA()
  assert.ok(src.includes('e instanceof ErrorConfirmacionDeposito ? e.message'))
  assert.ok(src.includes('presentarErrorConfirmacion(e).mensaje'), 'el depósito existente también presenta el error')
})
