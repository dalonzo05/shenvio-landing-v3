// FIN-4C (fix post-E2E) — el payload que entrega el cliente a httpsCallable, pasando por la semántica REAL
// de @firebase/functions: se levanta un servidor HTTP local, se apunta el SDK real a él con
// connectFunctionsEmulator y se lee el cuerpo que el SDK realmente envía. Lo que escapó a los tests
// anteriores fue justo esto: JSON.stringify directo omite `undefined`; el SDK lo convierte en `null`.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { createServer } from 'node:http'
import type { AddressInfo } from 'node:net'
import { initializeApp, deleteApp } from 'firebase/app'
import { getFunctions, connectFunctionsEmulator, httpsCallable } from 'firebase/functions'
import { payloadPreparar, payloadRegistrar } from './abono-directo-payload'

const tiene = (o: object, k: string) => Object.prototype.hasOwnProperty.call(o, k)

/** Envía `data` por el SDK real a un servidor local y devuelve el `data` que llegó por el cable. */
async function porElSdkReal(data: unknown): Promise<Record<string, unknown>> {
  let cuerpo = ''
  const srv = createServer((req, res) => {
    req.on('data', (c) => (cuerpo += c))
    req.on('end', () => {
      res.setHeader('content-type', 'application/json')
      res.end(JSON.stringify({ result: { ok: true } }))
    })
  })
  await new Promise<void>((r) => srv.listen(0, '127.0.0.1', r))
  const app = initializeApp({ projectId: 'demo-sdk-real', apiKey: 'x' }, 'sdk-' + Math.random().toString(36).slice(2))
  try {
    const fns = getFunctions(app)
    connectFunctionsEmulator(fns, '127.0.0.1', (srv.address() as AddressInfo).port)
    await httpsCallable(fns, 'prepararAbonoDirecto')(data)
    return JSON.parse(cuerpo).data as Record<string, unknown>
  } finally {
    await deleteApp(app)
    await new Promise<void>((r) => srv.close(() => r()))
  }
}

const base = { saldoId: 'aBqbjktRAVQ6xubSnFru', monto: 10, metodoAbono: 'ajuste_manual' }

test('F4C-SDK0 · REPRODUCCIÓN: el SDK real convierte `undefined` en `null` (lo que rompió el E2E); JSON.stringify no', async () => {
  const conUndefined = { ...base, reconoceOperacionId: undefined }
  assert.ok(!('reconoceOperacionId' in JSON.parse(JSON.stringify(conUndefined))), 'JSON.stringify directo omite la clave: por eso los tests anteriores no lo vieron')
  const enElCable = await porElSdkReal(conUndefined)
  assert.ok(tiene(enElCable, 'reconoceOperacionId'), 'el SDK real la ENVÍA')
  assert.equal(enElCable.reconoceOperacionId, null, 'undefined → null')
})

test('F4C-SDK1 · el wrapper corregido omite reconoceOperacionId en el primer abono: la clave NO viaja por el cable', async () => {
  for (const ausente of [undefined, null, '']) {
    const p = payloadPreparar({ ...base, nota: 'E2E', reconoceOperacionId: ausente })
    assert.equal(tiene(p, 'reconoceOperacionId'), false, `la propiedad está AUSENTE (${String(ausente)})`)
    const enElCable = await porElSdkReal(p)
    assert.equal(tiene(enElCable, 'reconoceOperacionId'), false, 'tampoco llega por el cable')
    assert.deepEqual(Object.keys(enElCable).sort(), ['metodoAbono', 'monto', 'nota', 'saldoId'])
  }
})

test('F4C-SDK1b · con reconocimiento explícito, la clave sí viaja con su valor', async () => {
  const enElCable = await porElSdkReal(payloadPreparar({ ...base, reconoceOperacionId: 'opAaaaaaaaaaaaaaaaaaa' }))
  assert.equal(enElCable.reconoceOperacionId, 'opAaaaaaaaaaaaaaaaaaa')
})

test('F4C-SDK4 · los demás opcionales (nota, comprobanteUrl, comprobantePath) también viajan ausentes si no existen', async () => {
  const p = payloadPreparar({ ...base, nota: undefined, comprobanteUrl: undefined, comprobantePath: null })
  for (const k of ['nota', 'comprobanteUrl', 'comprobantePath', 'reconoceOperacionId']) assert.equal(tiene(p, k), false, k)
  const r = payloadRegistrar({ ...base, operacionId: 'opAaaaaaaaaaaaaaaaaaa', nota: undefined, comprobanteUrl: undefined, comprobantePath: undefined })
  for (const k of ['nota', 'comprobanteUrl', 'comprobantePath']) assert.equal(tiene(r, k), false, k)
  assert.deepEqual(Object.keys(await porElSdkReal(r)).sort(), ['metodoAbono', 'monto', 'operacionId', 'saldoId'])
  const conTodo = payloadRegistrar({ ...base, operacionId: 'opAaaaaaaaaaaaaaaaaaa', nota: 'n', comprobanteUrl: 'https://x/y.jpg', comprobantePath: 'saldos/aBqbjktRAVQ6xubSnFru/abono_0.jpg' })
  assert.deepEqual(Object.keys(await porElSdkReal(conTodo)).sort(), ['comprobantePath', 'comprobanteUrl', 'metodoAbono', 'monto', 'nota', 'operacionId', 'saldoId'])
})

test('F4C-SDK-C · contrato: los wrappers reales entregan a httpsCallable lo que construyen los constructores de payload (ningún wrapper arma un objeto con opcionales a mano)', () => {
  const w = readFileSync(join(__dirname, '..', 'lib', 'abono-directo-cliente.ts'), 'utf8').replace(/\r\n/g, '\n').replace(/\/\/.*$/gm, '')
  assert.ok(/'prepararAbonoDirecto'\)\(payloadPreparar\(p\)\)/.test(w), 'preparar pasa por payloadPreparar')
  assert.ok(/'registrarAbonoDirecto'\)\(payloadRegistrar\(p\)\)/.test(w), 'registrar pasa por payloadRegistrar')
  assert.ok(!/\)\(p\)/.test(w), 'ningún wrapper entrega `p` crudo')
})
