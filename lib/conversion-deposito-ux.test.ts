// FIN-4A — presentación del resultado de convertirDepositoEnDeuda y CONTRATOS de la pantalla.
//
// La atomicidad, la idempotencia y la demostración del monto las prueba
// functions/test/conversion-deposito-deuda.test.ts. Aquí se prueba lo que le toca al
// cliente: (1) que no confunda los siete resultados y (2) que ninguna superficie del
// producto siga convirtiendo depósitos en deuda por su cuenta.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'
import {
  ErrorConversionDeposito,
  MSG_CONVERTIDO,
  MSG_ESTADO_INVALIDO,
  MSG_PERMISO,
  MSG_TEMPORAL,
  MSG_YA_CONVERTIDO,
  exigirConvertido,
  presentarErrorConversion,
  presentarResultadoConversion,
} from './conversion-deposito-ux'

const err = (code: string, motivo?: string, message = 'msg del servidor') => ({ code, message, details: motivo ? { motivo } : undefined })

// ── presentación ─────────────────────────────────────────────────────────────

test('F4A-U1 · convertido y ya_convertido NO se confunden: el segundo dice que no se registró nada nuevo', () => {
  assert.deepEqual(presentarResultadoConversion({ resultado: 'convertido' }), { categoria: 'exito', mensaje: MSG_CONVERTIDO, convertido: true })
  assert.deepEqual(presentarResultadoConversion({ resultado: 'ya_convertido' }), { categoria: 'ya_convertido', mensaje: MSG_YA_CONVERTIDO, convertido: true })
  assert.match(MSG_YA_CONVERTIDO, /nada nuevo/)
})

test('F4A-U2 · permiso: permission-denied y unauthenticated, con o sin el prefijo functions/', () => {
  for (const code of ['permission-denied', 'functions/permission-denied', 'unauthenticated', 'functions/unauthenticated']) {
    assert.deepEqual(presentarErrorConversion(err(code)), { categoria: 'permiso', mensaje: MSG_PERMISO, convertido: false }, code)
  }
})

test('F4A-U3 · estado inválido: estado_cambio, confirmado_no_convertible, tipo_no_convertible y not-found piden actualizar', () => {
  for (const e of [
    err('functions/failed-precondition', 'estado_cambio'), err('failed-precondition', 'confirmado_no_convertible'),
    err('functions/failed-precondition', 'tipo_no_convertible'), err('functions/not-found'),
  ]) {
    assert.deepEqual(presentarErrorConversion(e), { categoria: 'estado_invalido', mensaje: MSG_ESTADO_INVALIDO, convertido: false })
  }
})

test('F4A-U4 · inconsistencia: monto, órdenes y gastos que el servidor no pudo demostrar dicen que NO se convirtió y traen la causa', () => {
  for (const motivo of ['monto_inconsistente', 'monto_cero', 'orden_invalida', 'gasto_invalido', 'gasto_sin_marca', 'sin_ordenes', 'demasiadas_ordenes']) {
    const p = presentarErrorConversion(err('functions/failed-precondition', motivo, 'El monto no coincide.'))
    assert.equal(p.categoria, 'inconsistencia', motivo)
    assert.equal(p.convertido, false, motivo)
    assert.match(p.mensaje, /No se convirtió/, motivo)
    assert.match(p.mensaje, /El monto no coincide\./, motivo)
  }
  assert.equal(presentarErrorConversion(err('functions/invalid-argument')).categoria, 'inconsistencia')
})

test('F4A-U5 · integridad: un saldo o un movimiento que no cuadran NO se confunden con un monto mal', () => {
  for (const motivo of ['conversion_inconsistente', 'saldo_previo_vivo', 'ledger_inconsistente']) {
    const p = presentarErrorConversion(err('functions/failed-precondition', motivo, 'Hay que revisarlo.'))
    assert.equal(p.categoria, 'integridad', motivo)
    assert.equal(p.convertido, false, motivo)
    assert.match(p.mensaje, /saldo o el movimiento/, motivo)
    assert.match(p.mensaje, /Hay que revisarlo\./, motivo)
  }
})

test('F4A-U6 · error temporal: red, timeout o error interno ⇒ NO se sabe si se convirtió, y se manda a revisar antes de reintentar', () => {
  for (const e of [err('functions/unavailable'), err('functions/deadline-exceeded'), err('functions/internal'), err('functions/unknown'), new Error('Failed to fetch'), null, undefined, 'x']) {
    assert.deepEqual(presentarErrorConversion(e), { categoria: 'temporal', mensaje: MSG_TEMPORAL, convertido: false })
  }
  assert.match(MSG_TEMPORAL, /No sabemos si llegó a convertirse/)
  assert.match(MSG_TEMPORAL, /antes de reintentar/)
})

test('F4A-U7 · nunca se muestra éxito si la callable falló: exigirConvertido lanza con la categoría', () => {
  assert.doesNotThrow(() => exigirConvertido(presentarResultadoConversion({ resultado: 'convertido' })))
  assert.doesNotThrow(() => exigirConvertido(presentarResultadoConversion({ resultado: 'ya_convertido' })))
  for (const e of [err('functions/permission-denied'), err('functions/failed-precondition', 'monto_inconsistente'), err('functions/failed-precondition', 'conversion_inconsistente'), err('functions/unavailable')]) {
    assert.throws(() => exigirConvertido(presentarErrorConversion(e)), (x: unknown) => x instanceof ErrorConversionDeposito && x.message.length > 0)
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

/** Lo que hacía el writer cliente viejo y que la pantalla ya no puede escribir al convertir. */
const PROHIBIDO_EN_CONVERTIR = [
  'registrarMovimiento',
  'crearSaldoCargo',
  "estado: 'convertido_en_deuda'",
  'estado: "convertido_en_deuda"',
  'saldos_cargo_motorizado',
  'movimientos_financieros',
  'notaConversion',
  'confirmadoStorkhub',
  'confirmadoComercio',
  'addDoc',
]

test('F4A-C1 · convertir un depósito EXISTENTE llama a la callable y no escribe nada financiero', () => {
  const c = cuerpoDe(PAGINA(), 'convertirEnDeuda')
  assert.ok(c.includes('convertirEnServidor(dep.id, motivo)'), 'invoca la callable con el id y la nota')
  for (const t of PROHIBIDO_EN_CONVERTIR) assert.ok(!c.includes(t), `no contiene ${t}`)
  assert.ok(!c.includes('writeBatch') && !c.includes('.commit(') && !c.includes('setDoc') && !c.includes('updateDoc'), 'ningún write de cliente')
})

test('F4A-C2 · convertir desde PENDIENTES materializa el depósito en pendiente_boucher y termina en la MISMA callable', () => {
  const c = cuerpoDe(PAGINA(), 'convertirPendienteEnDeuda')
  for (const t of PROHIBIDO_EN_CONVERTIR.filter((x) => x !== 'addDoc')) assert.ok(!c.includes(t), `no contiene ${t}`)
  assert.ok(c.includes("estado: 'pendiente_boucher'"), 'el depósito nace en un estado seguro')
  const iCrea = c.indexOf('await bCrear.commit()')
  const iSrv = c.indexOf('await convertirEnServidor(depositoId, motivo)')
  assert.ok(iCrea > 0, 'materializa el depósito')
  assert.ok(iSrv > iCrea, 'convierte DESPUÉS, en el servidor')
  assert.equal((c.match(/convertirEnServidor\(/g) ?? []).length, 1, 'una sola conversión')
  assert.equal((c.match(/\.commit\(\)/g) ?? []).length, 1, 'el único commit del cliente es la materialización')
  assert.ok(c.includes('materializadoPendienteRef.current[gm.motorizadoId]'), 'el reintento reutiliza el depósito ya materializado')
})

test('F4A-C3 · convertirEnServidor es el único punto que invoca la callable y no reintenta por su cuenta', () => {
  const src = PAGINA()
  const c = cuerpoDe(src, 'convertirEnServidor')
  assert.ok(c.includes('convertirDepositoEnDeudaServidor(depositoId, nota)'))
  assert.ok(c.includes('exigirConvertido('), 'un fallo lanza; no se muestra éxito')
  assert.ok(!/for \(|while \(|setTimeout|retry/i.test(c), 'sin reintentos automáticos')
  assert.equal((src.match(/convertirDepositoEnDeudaServidor\(/g) ?? []).length, 1, 'la página invoca la callable desde un solo punto')
})

test('F4A-C4 · el writer cliente viejo desapareció: ni convertirDepositoEnDeuda en financial-writes, ni su import', () => {
  const fw = leer('lib', 'financial-writes.ts')
  assert.ok(!/export (async )?function convertirDepositoEnDeuda/.test(fw), 'financial-writes ya no exporta el writer')
  assert.ok(!fw.includes("'deposito_convertido_en_deuda',"), 'financial-writes ya no arma el movimiento de conversión')
  assert.ok(!/import \{[^}]*\bconvertirDepositoEnDeuda\b[^}]*\} from/.test(PAGINA()), 'la página no lo importa')
})

test('F4A-C5 · ninguna pantalla de la app escribe la conversión: el movimiento y el estado convertido solo salen del servidor', () => {
  const ofensores: string[] = []
  const recorrer = (dir: string) => {
    for (const nombre of readdirSync(dir)) {
      if (nombre === 'node_modules' || nombre.startsWith('.')) continue
      const ruta = join(dir, nombre)
      if (statSync(ruta).isDirectory()) { recorrer(ruta); continue }
      if (!/\.(ts|tsx)$/.test(nombre) || /\.test\./.test(nombre)) continue
      const t = readFileSync(ruta, 'utf8')
      // escribir el tipo de movimiento de conversión, o el estado convertido, como VALOR de un write
      if (/tipo:\s*'deposito_convertido_en_deuda'|estado:\s*'convertido_en_deuda'|'deposito_convertido_en_deuda',\s*\n?\s*(monto|\w+,)/.test(t)) ofensores.push(ruta.replace(RAIZ, ''))
    }
  }
  recorrer(join(RAIZ, 'app'))
  recorrer(join(RAIZ, 'lib'))
  assert.deepEqual(ofensores, [], 'solo la callable del servidor convierte')
})

test('F4A-C6 · el wrapper de la callable manda SOLO el id y la nota: ni monto, ni actor, ni estado, ni saldo, ni órdenes', () => {
  const w = leer('lib', 'convertir-deposito-cliente.ts')
  assert.ok(w.includes("'convertirDepositoEnDeuda'"))
  assert.ok(w.includes('({ depositoId, nota })'))
  const codigo = w.replace(/\/\/.*$/gm, '')
  assert.ok(!/monto|uid|estado|solicitudIds|gastosIds|rol|saldo/i.test(codigo.replace(/nota/g, '').replace(/ResultadoConversionServidor/g, '')), 'el payload no lleva nada financiero')
  assert.ok(!/retry|setTimeout|while \(|for \(/.test(codigo), 'sin reintentos')
})

test('F4A-C7 · la pantalla muestra el rechazo del servidor y no lo disfraza', () => {
  const src = PAGINA()
  assert.ok(src.includes('e instanceof ErrorConversionDeposito ? e.message : presentarErrorConversion(e).mensaje'))
  assert.ok(src.includes('setAvisoAccion(presentada.mensaje)'), 'el éxito y el "ya convertido" se cuentan distinto')
})
