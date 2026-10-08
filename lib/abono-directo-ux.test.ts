// FIN-4C — presentación del resultado del abono directo, decisiones de la INTENCIÓN (que vive en el
// servidor) y CONTRATOS de la pantalla de Saldos.
//
// La atomicidad, la idempotencia, el sobre-abono, la concurrencia y el comportamiento de la intención
// (recuperar tras recargar, otra pestaña, nuevo abono explícito) los prueban functions/test/abono-directo.test.ts
// y functions/test/abono-intencion.test.ts contra el núcleo real. Aquí se prueba lo que le toca al cliente:
// (1) que no confunda los resultados, (2) que decida solo a partir de lo que dice el servidor —no de su
// memoria— y (3) que ninguna superficie del producto fabrique la identidad de la operación ni escriba el
// abono por su cuenta.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'
import {
  ErrorAbonoDirecto,
  MSG_APLICADA_RECUPERADA,
  MSG_APLICADO,
  MSG_CONFLICTO,
  MSG_INTENCION_NO_DISPONIBLE,
  MSG_MONTO_EXCEDE,
  MSG_NO_ABONABLE,
  MSG_PENDIENTE_EXISTENTE,
  MSG_PERMISO,
  MSG_SALDO_INEXISTENTE,
  MSG_TEMPORAL,
  MSG_YA_APLICADO,
  decidirTrasPreparar,
  exigirAbonado,
  presentarErrorAbono,
  presentarResultadoAbono,
  vistaIntencionAlAbrir,
  type IntencionAbono,
} from './abono-directo-ux'

const err = (code: string, motivo?: string, message = 'msg del servidor') => ({ code, message, details: motivo ? { motivo } : undefined })

// ── presentación ─────────────────────────────────────────────────────────────

test('F4C-U1 · aplicado y ya_aplicado NO se confunden: el segundo dice que no se registró nada nuevo', () => {
  assert.deepEqual(presentarResultadoAbono({ resultado: 'aplicado' }), { categoria: 'exito', mensaje: MSG_APLICADO, aplicado: true })
  assert.deepEqual(presentarResultadoAbono({ resultado: 'ya_aplicado' }), { categoria: 'ya_aplicado', mensaje: MSG_YA_APLICADO, aplicado: true })
  assert.match(MSG_YA_APLICADO, /nada nuevo/)
})

test('F4C-U2 · cada rechazo del servidor tiene su categoría y su mensaje (monto, estado, saldo, conflicto, intención, permiso)', () => {
  assert.deepEqual(presentarErrorAbono(err('functions/failed-precondition', 'monto_excede_saldo')), { categoria: 'monto_excede', mensaje: MSG_MONTO_EXCEDE, aplicado: false })
  assert.deepEqual(presentarErrorAbono(err('failed-precondition', 'saldo_no_abonable')), { categoria: 'no_abonable', mensaje: MSG_NO_ABONABLE, aplicado: false })
  assert.deepEqual(presentarErrorAbono(err('functions/failed-precondition', 'conflicto_idempotencia')), { categoria: 'conflicto', mensaje: MSG_CONFLICTO, aplicado: false })
  assert.deepEqual(presentarErrorAbono(err('functions/not-found')), { categoria: 'saldo_inexistente', mensaje: MSG_SALDO_INEXISTENTE, aplicado: false })
  for (const motivo of ['intencion_inexistente', 'intencion_ajena', 'intencion_cerrada']) {
    assert.deepEqual(presentarErrorAbono(err('functions/failed-precondition', motivo)), { categoria: 'intencion', mensaje: MSG_INTENCION_NO_DISPONIBLE, aplicado: false }, motivo)
  }
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

test('F4C-U4 · resultado incierto: red, timeout o error interno ⇒ NO se sabe si se aplicó; se verificará la operación existente y reintentar es seguro', () => {
  for (const e of [err('functions/unavailable'), err('functions/deadline-exceeded'), err('functions/internal'), err('functions/unknown'), new Error('Failed to fetch'), null, undefined, 'x']) {
    assert.deepEqual(presentarErrorAbono(e), { categoria: 'temporal', mensaje: MSG_TEMPORAL, aplicado: false })
  }
  assert.match(MSG_TEMPORAL, /No sabemos si el abono llegó a registrarse/)
  assert.match(MSG_TEMPORAL, /Verificaremos la operación existente/)
  assert.match(MSG_TEMPORAL, /reintentar es seguro/)
})

test('F4C-U5 · nunca se muestra éxito si la callable falló: exigirAbonado lanza con la categoría', () => {
  assert.doesNotThrow(() => exigirAbonado(presentarResultadoAbono({ resultado: 'aplicado' })))
  assert.doesNotThrow(() => exigirAbonado(presentarResultadoAbono({ resultado: 'ya_aplicado' })))
  for (const e of [err('functions/permission-denied'), err('functions/failed-precondition', 'monto_excede_saldo'), err('functions/unavailable')]) {
    assert.throws(() => exigirAbonado(presentarErrorAbono(e)), (x: unknown) => x instanceof ErrorAbonoDirecto && x.message.length > 0)
  }
})

// ── la intención: la pantalla decide con lo que dice el SERVIDOR ─────────────

const intencion = (extra: Partial<IntencionAbono> = {}): IntencionAbono => ({ operacionId: 'srv_op_A_0000000001', saldoId: 's1', monto: 40, metodoAbono: 'transferencia', estado: 'preparada', ...extra })

test('F4C-UI1 · abrir un saldo SIN intención no inventa nada: la vista es "ninguna" y la operación se pide al servidor al registrar', () => {
  assert.deepEqual(vistaIntencionAlAbrir(null, {}, 's1'), { tipo: 'ninguna' })
  const prep = decidirTrasPreparar({ resultado: 'preparada', intencion: intencion() })
  assert.deepEqual(prep, { accion: 'continuar', operacionId: 'srv_op_A_0000000001', recuperada: false }, 'el id sale de la respuesta del servidor')
})

test('F4C-UI2 · REMOUNT: una preparada se recupera con la misma operación, sin importar la memoria local (vacía o con otras operaciones)', () => {
  const I = intencion()
  const memorias: Array<Record<string, string>> = [{}, { s1: 'otra_operacion_xxxxxxx' }, { s2: 'srv_op_A_0000000001' }]
  for (const memoria of memorias) {
    assert.deepEqual(vistaIntencionAlAbrir(I, memoria, 's1'), { tipo: 'pendiente', intencion: I })
  }
  assert.deepEqual(decidirTrasPreparar({ resultado: 'recuperada', intencion: I }), { accion: 'continuar', operacionId: I.operacionId, recuperada: true })
})

test('F4C-UI3 · RECARGA simulada: la memoria se pierde por completo y la vista sale IGUAL del servidor ⇒ misma operación, ninguna B', () => {
  const I = intencion({ estado: 'aplicada', movimientoId: 'abono_srv_op_A_0000000001' })
  const antesDeRecargar = vistaIntencionAlAbrir(I, { s1: I.operacionId }, 's1')   // el usuario ya la había reconocido
  const trasRecargar = vistaIntencionAlAbrir(I, {}, 's1')                        // la memoria desapareció
  assert.deepEqual(antesDeRecargar, { tipo: 'ninguna' })
  assert.deepEqual(trasRecargar, { tipo: 'aplicada_sin_reconocer', intencion: I }, 'tras recargar se MUESTRA la aplicada; no se asume un abono nuevo')
})

test('F4C-UI4 · una intención ya APLICADA se muestra como recuperada: preparar no deja continuar con otra operación', () => {
  const I = intencion({ estado: 'aplicada', movimientoId: 'abono_srv_op_A_0000000001' })
  const d = decidirTrasPreparar({ resultado: 'ya_aplicada', intencion: I })
  assert.deepEqual(d, { accion: 'mostrar_aplicada', intencion: I, mensaje: MSG_APLICADA_RECUPERADA })
  assert.match(MSG_APLICADA_RECUPERADA, /No se creó otro/)
  const p = decidirTrasPreparar({ resultado: 'operacion_pendiente_existente', intencion: intencion({ monto: 99 }) })
  assert.equal(p.accion, 'resolver_pendiente')
  assert.match(MSG_PENDIENTE_EXISTENTE, /descartalo/)
})

test('F4C-UI5 · resultado INCIERTO: la operación persiste en el servidor; la pantalla no la cierra ni inventa otra (el siguiente intento la recupera)', () => {
  assert.equal(presentarErrorAbono(err('functions/unavailable')).categoria, 'temporal')
  const src = sinComentarios(PAGINA())
  const c = sinComentarios(cuerpoDe(PAGINA(), 'handleAbono'))
  const iCatch = c.indexOf('} catch (e: unknown)')
  assert.ok(iCatch > 0)
  const enCatch = c.slice(iCatch)
  assert.ok(!enCatch.includes('resetAbono()') && !enCatch.includes('reconocidasRef') && !enCatch.includes('descartarAbonoDirectoServidor'), 'el catch no cierra ni reconoce ni descarta')
  assert.ok(!/randomUUID|Math\.random|Date\.now|generarOperacionId/.test(src), 'la pantalla no fabrica identidad')
})

test('F4C-UI6 · CANCELAR/cerrar el modal solo afecta la pantalla: no llama al servidor; descartar es una acción explícita y única', () => {
  const src = sinComentarios(PAGINA())
  const i = src.indexOf('function resetAbono()')
  assert.ok(i > 0)
  const reset = src.slice(i, src.indexOf('\n  }', i))
  assert.ok(!/Servidor\(|descartar|httpsCallable|await /.test(reset), 'resetAbono no toca el servidor')
  assert.equal((src.match(/descartarAbonoDirectoServidor\(/g) ?? []).length, 1, 'un solo llamador de descartar')
  assert.ok(sinComentarios(cuerpoDe(PAGINA(), 'handleDescartarIntencion')).includes('descartarAbonoDirectoServidor(intencionAbono.operacionId)'))
})

test('F4C-UI7 · el NUEVO abono es explícito: «Registrar otro abono» reconoce la aplicada y handleAbono manda ese reconocimiento', () => {
  const I = intencion({ estado: 'aplicada' })
  assert.deepEqual(vistaIntencionAlAbrir(I, { s1: I.operacionId }, 's1'), { tipo: 'ninguna' }, 'reconocida: ya no estorba')
  const otro = sinComentarios(PAGINA())
  const h = sinComentarios(cuerpoDe(PAGINA(), 'handleAbono'))
  assert.ok(h.includes('reconoceOperacionId: reconocidasRef.current[saldo.id]'))
  const ini = otro.indexOf('function handleRegistrarOtroAbono()')
  assert.ok(ini > 0 && otro.slice(ini, ini + 300).includes('reconocidasRef.current[intencionAbono.saldoId] = intencionAbono.operacionId'))
})

test('F4C-UI8 · el nuevo abono del MISMO monto es legítimo: la operación nueva trae otro id y la pantalla no compara montos para impedirlo', () => {
  const A = intencion()
  const B = decidirTrasPreparar({ resultado: 'preparada', intencion: intencion({ operacionId: 'srv_op_B_0000000002' }) })
  assert.equal(B.accion, 'continuar')
  if (B.accion === 'continuar') assert.notEqual(B.operacionId, A.operacionId)
  const h = sinComentarios(cuerpoDe(PAGINA(), 'handleAbono'))
  assert.ok(!/intencionAbono\.monto|\.monto ===|\.monto !==/.test(h), 'handleAbono no deduplica por monto')
})

// ── contratos de la pantalla ─────────────────────────────────────────────────

const RAIZ = join(__dirname, '..')
const leer = (...ruta: string[]) => readFileSync(join(RAIZ, ...ruta), 'utf8').replace(/\r/g, '')
const PAGINA = () => leer('app', 'panel', 'gestor', 'saldos', 'page.tsx')
function sinComentarios(s: string): string { return s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '') }

function cuerpoDe(src: string, nombre: string): string {
  const ini = src.indexOf(`async function ${nombre}(`) >= 0 ? src.indexOf(`async function ${nombre}(`) : src.indexOf(`function ${nombre}(`)
  assert.ok(ini >= 0, `existe ${nombre}`)
  const candidatos = [src.indexOf('\n  async function ', ini + 10), src.indexOf('\n  // ── ', ini + 10), src.indexOf('\n  function ', ini + 10), src.indexOf('\n  /**\n', ini + 10)].filter((x) => x > 0)
  return src.slice(ini, Math.min(...candidatos))
}

const PROHIBIDO_EN_ABONO = ['runTransaction', 'writeBatch', 'updateDoc', 'setDoc', 'addDoc', 'arrayUnion', 'movimientos_financieros', 'saldos_cargo_motorizado', 'intenciones_abono_directo', 'registrarMovimiento', 'registrarAbonoSaldo', 'creadoPorRol', 'auth.currentUser']

test('F4C-C1 · el abono directo llama a las callables y no escribe nada financiero desde la pantalla', () => {
  const src = PAGINA()
  const c = sinComentarios(cuerpoDe(src, 'handleAbono'))
  assert.ok(c.includes('await prepararEnServidor({') && c.includes('await abonarEnServidor({'), 'prepara y registra en el servidor')
  for (const t of PROHIBIDO_EN_ABONO) assert.ok(!c.includes(t), `handleAbono no contiene ${t}`)
  const e = sinComentarios(cuerpoDe(src, 'abonarEnServidor'))
  assert.ok(e.includes('registrarAbonoDirectoServidor(p)'))
  assert.ok(e.includes('exigirAbonado('), 'un fallo lanza; no se muestra éxito')
  assert.ok(!/for \(|while \(|setTimeout|retry/i.test(e), 'sin reintentos automáticos')
  assert.equal((src.match(/registrarAbonoDirectoServidor\(/g) ?? []).length, 1, 'un solo punto de invocación')
  assert.equal((src.match(/prepararAbonoDirectoServidor\(/g) ?? []).length, 1, 'preparar se invoca desde un solo punto: prepararEnServidor')
})

test('F4C-C2 · el orden es PREPARAR → comprobante → REGISTRAR, y el operacionId que se registra es el que devolvió el servidor', () => {
  const c = sinComentarios(cuerpoDe(PAGINA(), 'handleAbono'))
  const iPrep = c.indexOf('await prepararEnServidor(')
  const iDecide = c.indexOf('decidirTrasPreparar(preparada)')
  const iSube = c.indexOf('uploadComprobante(')
  const iReg = c.indexOf('await abonarEnServidor(')
  assert.ok(iPrep > 0 && iDecide > iPrep && iSube > iDecide && iReg > iSube, 'preparar → decidir → subir comprobante → registrar')
  assert.ok(c.includes('operacionId: decision.operacionId'))
  assert.ok(c.includes("decision.accion !== 'continuar'"), 'si la operación ya está aplicada o hay otra pendiente, NO se registra')
})

test('F4C-C3 · al abrir el formulario se RECONCILIA con el servidor (obtenerIntencionAbono); la memoria local no es la autoridad', () => {
  const src = sinComentarios(PAGINA())
  assert.ok(src.includes('obtenerIntencionAbonoServidor(abonoId)'))
  assert.ok(src.includes('vistaIntencionAlAbrir(r.intencion, reconocidasRef.current, abonoId)'))
  assert.ok(!/operacionAbonoRef|obtenerOperacion|conservarOperacion/.test(src), 'ya no hay una operación guardada solo en memoria')
  assert.ok(!/sessionStorage|localStorage|indexedDB/.test(src), 'tampoco en el almacenamiento del navegador: la autoridad es el servidor')
})

test('F4C-C4 · los wrappers mandan la INTENCIÓN: nada de saldo pendiente, estado, motorizado, actor ni rol; el cliente no manda un operacionId inventado al preparar', () => {
  const w = sinComentarios(leer('lib', 'abono-directo-cliente.ts'))
  for (const n of ["'prepararAbonoDirecto'", "'obtenerIntencionAbono'", "'descartarIntencionAbono'", "'registrarAbonoDirecto'"]) assert.ok(w.includes(n), n)
  assert.ok(!/saldoPendiente|montoOriginal|estado|motorizadoId|depositoId|uid|rol\b|actor/i.test(w.replace(/IntencionAbono|ResultadoAbonoServidor|RespuestaPreparar/g, '')), 'el payload no lleva autoridad financiera')
  const iPrep = w.indexOf('export interface PeticionPrepararCliente')
  assert.ok(!w.slice(iPrep, w.indexOf('export interface PeticionAbonoCliente')).includes('operacionId:'), 'preparar no recibe un operacionId del cliente')
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

test('F4C-C6 · propuestas y liquidaciones siguen con SU camino: handleProponerAbono crea propuestas y la liquidación aplica su abono EN EL SERVIDOR (FIN-1D)', () => {
  const src = sinComentarios(PAGINA())
  const p = cuerpoDe(PAGINA(), 'handleProponerAbono')
  assert.ok(p.includes('crearPropuestaAbono(') && !p.includes('abonarEnServidor') && !p.includes('prepararEnServidor'), 'el digitador sigue PROponiendo')
  assert.ok(src.includes('confirmarPropuestaAbonoCallable({ propuestaId: p.id })'), 'confirmar propuesta sigue por su callable')
  const liq = sinComentarios(leer('app', 'panel', 'gestor', 'liquidaciones', 'page.tsx'))
  // FIN-1D — el abono por liquidación ya no es inline en el cliente: lo escribe crearLiquidacionMotorizado (saldo + abono + movimiento, una transacción).
  assert.ok(liq.includes('crearLiquidacionMotorizadoServidor(') && !liq.includes("'abono_deuda_motorizado'") && !liq.includes("'descuento_liquidacion'"), 'la liquidación aplica su abono por su callable')
  assert.ok(!liq.includes('registrarAbonoDirecto') && !liq.includes('prepararAbonoDirecto'), 'la liquidación no se migró')
})
