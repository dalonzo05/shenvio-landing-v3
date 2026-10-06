// FIN-4C — presentación del resultado de registrarAbonoDirecto, ciclo de vida del operacionId
// y CONTRATOS de la pantalla de Saldos.
//
// La atomicidad, la idempotencia, el sobre-abono y la concurrencia los prueba
// functions/test/abono-directo.test.ts. Aquí se prueba lo que le toca al cliente: (1) que no
// confunda los diez resultados, (2) que el operacionId se conserve mientras el resultado sea
// incierto y cambie para una intención nueva, y (3) que ninguna superficie del producto siga
// escribiendo el abono directo por su cuenta.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'
import {
  ErrorAbonoDirecto,
  MSG_APLICADO,
  MSG_CONFLICTO,
  MSG_MONTO_EXCEDE,
  MSG_NO_ABONABLE,
  MSG_PERMISO,
  MSG_SALDO_INEXISTENTE,
  MSG_TEMPORAL,
  MSG_YA_APLICADO,
  exigirAbonado,
  presentarErrorAbono,
  presentarResultadoAbono,
} from './abono-directo-ux'
import { conservarOperacion, generarOperacionId, obtenerOperacion } from './abono-operacion'

const err = (code: string, motivo?: string, message = 'msg del servidor') => ({ code, message, details: motivo ? { motivo } : undefined })

// ── presentación ─────────────────────────────────────────────────────────────

test('F4C-U1 · aplicado y ya_aplicado NO se confunden: el segundo dice que no se registró nada nuevo', () => {
  assert.deepEqual(presentarResultadoAbono({ resultado: 'aplicado' }), { categoria: 'exito', mensaje: MSG_APLICADO, aplicado: true })
  assert.deepEqual(presentarResultadoAbono({ resultado: 'ya_aplicado' }), { categoria: 'ya_aplicado', mensaje: MSG_YA_APLICADO, aplicado: true })
  assert.match(MSG_YA_APLICADO, /nada nuevo/)
})

test('F4C-U2 · cada rechazo del servidor tiene su categoría y su mensaje (monto, estado, saldo, conflicto, permiso)', () => {
  assert.deepEqual(presentarErrorAbono(err('functions/failed-precondition', 'monto_excede_saldo')), { categoria: 'monto_excede', mensaje: MSG_MONTO_EXCEDE, aplicado: false })
  assert.deepEqual(presentarErrorAbono(err('failed-precondition', 'saldo_no_abonable')), { categoria: 'no_abonable', mensaje: MSG_NO_ABONABLE, aplicado: false })
  assert.deepEqual(presentarErrorAbono(err('functions/failed-precondition', 'conflicto_idempotencia')), { categoria: 'conflicto', mensaje: MSG_CONFLICTO, aplicado: false })
  assert.deepEqual(presentarErrorAbono(err('functions/not-found')), { categoria: 'saldo_inexistente', mensaje: MSG_SALDO_INEXISTENTE, aplicado: false })
  for (const code of ['permission-denied', 'functions/permission-denied', 'unauthenticated', 'functions/unauthenticated']) {
    assert.deepEqual(presentarErrorAbono(err(code)), { categoria: 'permiso', mensaje: MSG_PERMISO, aplicado: false }, code)
  }
})

test('F4C-U3 · monto/petición inválida e integridad se distinguen y traen la causa del servidor', () => {
  const a = presentarErrorAbono(err('functions/invalid-argument', undefined, 'El monto debe ser mayor que 0.'))
  assert.equal(a.categoria, 'monto_invalido')
  assert.match(a.mensaje, /El monto debe ser mayor que 0\./)
  const b = presentarErrorAbono(err('functions/failed-precondition', 'abono_inconsistente', 'Falta el movimiento.'))
  assert.equal(b.categoria, 'integridad')
  assert.match(b.mensaje, /Falta el movimiento\./)
  assert.equal(b.aplicado, false)
})

test('F4C-U4 · resultado incierto: red, timeout o error interno ⇒ NO se sabe si se aplicó, y reintentar es seguro', () => {
  for (const e of [err('functions/unavailable'), err('functions/deadline-exceeded'), err('functions/internal'), err('functions/unknown'), new Error('Failed to fetch'), null, undefined, 'x']) {
    assert.deepEqual(presentarErrorAbono(e), { categoria: 'temporal', mensaje: MSG_TEMPORAL, aplicado: false })
  }
  assert.match(MSG_TEMPORAL, /No sabemos si el abono llegó a registrarse/)
  assert.match(MSG_TEMPORAL, /reintentar es seguro/)
})

test('F4C-U5 · nunca se muestra éxito si la callable falló: exigirAbonado lanza con la categoría', () => {
  assert.doesNotThrow(() => exigirAbonado(presentarResultadoAbono({ resultado: 'aplicado' })))
  assert.doesNotThrow(() => exigirAbonado(presentarResultadoAbono({ resultado: 'ya_aplicado' })))
  for (const e of [err('functions/permission-denied'), err('functions/failed-precondition', 'monto_excede_saldo'), err('functions/unavailable')]) {
    assert.throws(() => exigirAbonado(presentarErrorAbono(e)), (x: unknown) => x instanceof ErrorAbonoDirecto && x.message.length > 0)
  }
})

// ── operacionId: ciclo de vida ───────────────────────────────────────────────

const FORMATO_SERVIDOR = /^[A-Za-z0-9_-]{16,64}$/

test('F4C-O1 · el operacionId generado cumple el formato que valida el servidor y no se repite', () => {
  const ids = new Set<string>()
  for (let i = 0; i < 500; i++) {
    const id = generarOperacionId()
    assert.match(id, FORMATO_SERVIDOR)
    ids.add(id)
  }
  assert.equal(ids.size, 500)
})

test('F4C-O2 · un REINTENTO (mismo saldo, operación abierta) reusa el MISMO operacionId; no genera uno nuevo', () => {
  let n = 0
  const nuevo = () => `op_generado_${++n}_xxxxxxxxxx`
  const intento1 = obtenerOperacion(null, 's1', nuevo)
  const intento2 = obtenerOperacion(intento1, 's1', nuevo) // timeout → reintento
  const intento3 = obtenerOperacion(intento2, 's1', nuevo)
  assert.equal(intento2.operacionId, intento1.operacionId)
  assert.equal(intento3.operacionId, intento1.operacionId)
  assert.equal(n, 1, 'solo se generó UN id para la misma intención')
})

test('F4C-O3 · un abono NUEVO (operación cerrada) estrena operacionId aunque el monto sea el mismo; otro saldo también', () => {
  let n = 0
  const nuevo = () => `op_generado_${++n}_xxxxxxxxxx`
  const a = obtenerOperacion(null, 's1', nuevo)
  const b = obtenerOperacion(null, 's1', nuevo) // la anterior se cerró con un resultado definitivo
  const c = obtenerOperacion(a, 's2', nuevo)    // otro saldo
  assert.notEqual(a.operacionId, b.operacionId)
  assert.notEqual(a.operacionId, c.operacionId)
  assert.equal(c.saldoId, 's2')
})

test('F4C-O4 · solo un resultado INCIERTO conserva la operación; todo resultado definitivo la cierra', () => {
  assert.equal(conservarOperacion('temporal'), true)
  for (const c of ['exito', 'ya_aplicado', 'monto_invalido', 'monto_excede', 'no_abonable', 'saldo_inexistente', 'conflicto', 'integridad', 'permiso']) {
    assert.equal(conservarOperacion(c), false, c)
  }
})

// ── contratos de la pantalla ─────────────────────────────────────────────────

const RAIZ = join(__dirname, '..')
const leer = (...ruta: string[]) => readFileSync(join(RAIZ, ...ruta), 'utf8').replace(/\r/g, '')
const PAGINA = () => leer('app', 'panel', 'gestor', 'saldos', 'page.tsx')
const sinComentarios = (s: string) => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '')

function cuerpoDe(src: string, nombre: string): string {
  const ini = src.indexOf(`async function ${nombre}(`)
  assert.ok(ini >= 0, `existe ${nombre}`)
  const candidatos = [src.indexOf('\n  async function ', ini + 10), src.indexOf('\n  // ── ', ini + 10), src.indexOf('\n  function ', ini + 10), src.indexOf('\n  /**\n', ini + 10)].filter((x) => x > 0)
  return src.slice(ini, Math.min(...candidatos))
}

const PROHIBIDO_EN_ABONO = ['runTransaction', 'writeBatch', 'updateDoc', 'setDoc', 'addDoc', 'arrayUnion', 'movimientos_financieros', 'saldos_cargo_motorizado', 'registrarMovimiento', 'registrarAbonoSaldo', 'creadoPorRol', 'auth.currentUser']

test('F4C-C1 · el abono directo llama a la callable y no escribe nada financiero desde la pantalla', () => {
  const src = PAGINA()
  const c = sinComentarios(cuerpoDe(src, 'handleAbono'))
  assert.ok(c.includes('await abonarEnServidor({'), 'invoca la callable')
  for (const t of PROHIBIDO_EN_ABONO) assert.ok(!c.includes(t), `handleAbono no contiene ${t}`)
  const e = sinComentarios(cuerpoDe(src, 'abonarEnServidor'))
  assert.ok(e.includes('registrarAbonoDirectoServidor(p)'))
  assert.ok(e.includes('exigirAbonado('), 'un fallo lanza; no se muestra éxito')
  assert.ok(!/for \(|while \(|setTimeout|retry/i.test(e), 'sin reintentos automáticos')
  assert.equal((src.match(/registrarAbonoDirectoServidor\(/g) ?? []).length, 1, 'un solo punto de invocación')
})

test('F4C-C2 · el operacionId nace de obtenerOperacion y se guarda ANTES de llamar: un reintento incierto lo reusa', () => {
  const src = PAGINA()
  const c = sinComentarios(cuerpoDe(src, 'handleAbono'))
  const iObtener = c.indexOf('obtenerOperacion(operacionAbonoRef.current, saldo.id)')
  const iGuarda = c.indexOf('operacionAbonoRef.current = operacion')
  const iLlama = c.indexOf('await abonarEnServidor(')
  assert.ok(iObtener > 0 && iGuarda > iObtener && iLlama > iGuarda, 'obtener → guardar en la ref → llamar')
  assert.ok(c.includes('operacionId: operacion.operacionId'))
  assert.ok(!c.includes('generarOperacionId') && !/Date\.now|Math\.random|randomUUID/.test(c), 'handleAbono no inventa ids por su cuenta')
  assert.ok(c.includes('if (!conservarOperacion(e.categoria)) operacionAbonoRef.current = null'), 'solo lo incierto conserva la operación')
})

test('F4C-C3 · éxito y cancelar cierran la operación (resetAbono); un error incierto NO pasa por resetAbono', () => {
  const src = sinComentarios(PAGINA())
  const ini = src.indexOf('function resetAbono()')
  assert.ok(ini > 0)
  assert.ok(src.slice(ini, ini + 200).includes('operacionAbonoRef.current = null'))
  const c = sinComentarios(cuerpoDe(PAGINA(), 'handleAbono'))
  const iCatch = c.indexOf('} catch (e: unknown)')
  assert.ok(iCatch > 0)
  assert.ok(!c.slice(iCatch).includes('resetAbono()'), 'el catch no cierra la operación incierta')
})

test('F4C-C4 · el wrapper de la callable manda la INTENCIÓN: nada de saldo pendiente, estado, motorizado, actor ni rol', () => {
  const w = sinComentarios(leer('lib', 'abono-directo-cliente.ts'))
  assert.ok(w.includes("'registrarAbonoDirecto'"))
  assert.ok(w.includes('(p)'))
  assert.ok(!/saldoPendiente|montoOriginal|estado|motorizadoId|depositoId|uid|rol/i.test(w.replace(/ResultadoAbonoServidor/g, '')), 'el payload no lleva autoridad financiera')
  assert.ok(!/retry|setTimeout|while \(|for \(/.test(w), 'sin reintentos')
})

test('F4C-C5 · el writer cliente viejo desapareció: ni registrarAbonoSaldo exportado, ni importado, ni usado', () => {
  const fw = sinComentarios(leer('lib', 'financial-writes.ts'))
  assert.ok(!/registrarAbonoSaldo/.test(fw), 'financial-writes ya no lo define')
  assert.ok(!/registrarAbonoSaldo/.test(sinComentarios(PAGINA())), 'la pantalla de Saldos ya no lo usa')
  const ofensores: string[] = []
  const recorrer = (dir: string) => {
    for (const nombre of readdirSync(dir)) {
      if (nombre === 'node_modules' || nombre.startsWith('.')) continue
      const ruta = join(dir, nombre)
      if (statSync(ruta).isDirectory()) { recorrer(ruta); continue }
      if (!/\.(ts|tsx)$/.test(nombre) || /\.test\./.test(nombre)) continue
      if (/registrarAbonoSaldo/.test(sinComentarios(readFileSync(ruta, 'utf8')))) ofensores.push(ruta.replace(RAIZ, ''))
    }
  }
  recorrer(join(RAIZ, 'app'))
  recorrer(join(RAIZ, 'lib'))
  assert.deepEqual(ofensores, [], 'nadie más usa el writer retirado')
})

test('F4C-C6 · propuestas y liquidaciones siguen con SU camino: handleProponerAbono crea propuestas y crearLiquidacion conserva su abono inline', () => {
  const src = sinComentarios(PAGINA())
  const p = cuerpoDe(PAGINA(), 'handleProponerAbono')
  assert.ok(p.includes('crearPropuestaAbono(') && !p.includes('abonarEnServidor'), 'el digitador sigue PROponiendo')
  assert.ok(src.includes('confirmarPropuestaAbonoCallable({ propuestaId: p.id })'), 'confirmar propuesta sigue por su callable')
  const liq = sinComentarios(leer('app', 'panel', 'gestor', 'liquidaciones', 'page.tsx'))
  assert.ok(liq.includes("tipo: 'abono_deuda_motorizado'") && liq.includes("metodoAbono: 'descuento_liquidacion'"), 'la liquidación conserva su abono inline')
  assert.ok(!liq.includes('registrarAbonoDirecto'), 'la liquidación no se migró')
})
