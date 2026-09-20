// DEPOSITO-AUDITORIA-1 · ROLLOUT — el generador del puente es portable.
//
// El generador falló en el checkout de Windows (core.autocrlf=true): sus dos
// anclas multilínea están en \n y los .rules del working tree estaban en
// CRLF, así que daban 0 coincidencias y el script pedía "actualizá el ancla"
// aunque las Rules estuvieran perfectas. Estos casos fijan que el artefacto
// sea el mismo desde LF y desde CRLF, y que la protección de 0 / >1 ancla
// siga intacta.
//
//     node --test scripts/reglas-puente.test.mjs
//
// No escribe en el repo: trabaja con contenido en memoria y, para el caso del
// CLI, con un destino temporal del sistema.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, mkdtempSync, rmSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { PARCHES, aLF, derivarPuente, generarPuente, AnclaPuenteInvalida } from './reglas-puente.mjs'

const sha = (s) => createHash('sha256').update(s).digest('hex')
const aCRLF = (s) => aLF(s).replace(/\n/g, '\r\n')

/**
 * Hashes aprobados del rollout, sobre contenido LF (lo que guarda git y lo
 * que se despliega). Son un ancla del rollout, no una verdad eterna: cuando
 * las Rules finales cambien a propósito, estos cuatro valores se actualizan
 * en el mismo commit que las cambia.
 */
const HASH = {
  finalFirestore: '9cc515a26600e0b7f1635d27a3c7d71a1b3f361ebb20f4ec9470a1f8a01242c2',
  finalStorage: 'f66904c97c0d335197fb758fe4b44760a00e98f70bcec1a8f06f516812173389',
  puenteFirestore: '357e972aed5414233b22882979d3963a839f692ecc8d67993bcfb9ca3cd36f1b',
  puenteStorage: '374cbec93a2769d194e76ab082dacc3a1c66861206f480426a44385dd034b876',
}

/** Las Rules finales tal como las guarda git (LF), sin depender del working tree. */
function finalesEnLF() {
  const de = (archivo) => aLF(execFileSync('git', ['show', `HEAD:${archivo}`], { encoding: 'utf8' }))
  return { 'firestore.rules': de('firestore.rules'), 'storage.rules': de('storage.rules') }
}

test('G0 · las Rules finales del commit son las aprobadas (ancla del rollout)', () => {
  const f = finalesEnLF()
  assert.equal(sha(f['firestore.rules']), HASH.finalFirestore)
  assert.equal(sha(f['storage.rules']), HASH.finalStorage)
})

test('G1 · fuente en LF ⇒ el puente aprobado', () => {
  const p = derivarPuente(finalesEnLF())
  assert.equal(sha(p.get('firestore.rules')), HASH.puenteFirestore)
  assert.equal(sha(p.get('storage.rules')), HASH.puenteStorage)
  // Y el puente es lo que dice ser: los interruptores en false y el delete de F1.
  assert.match(p.get('firestore.rules'), /function auditoriaF2Obligatoria\(\) \{\n {8}return false;/)
  assert.match(p.get('storage.rules'), /function versionadoF2Obligatorio\(\) \{\n {6}return false;/)
  assert.match(p.get('firestore.rules'), /allow delete: if isAdmin\(\)/)
  assert.ok(!p.get('firestore.rules').includes('#puente:delete-deposito'))
})

test('G2 · la misma fuente convertida a CRLF ⇒ exactamente el mismo puente', () => {
  const lf = finalesEnLF()
  const crlf = Object.fromEntries(Object.entries(lf).map(([k, v]) => [k, aCRLF(v)]))
  // Precondición del caso: la fuente CRLF no contiene las anclas multilínea.
  const multilinea = PARCHES.filter((p) => p.buscar.includes('\n'))
  assert.equal(multilinea.length, 2)
  for (const p of multilinea) assert.equal(crlf[p.archivo].split(p.buscar).length - 1, 0)

  const desdeLF = derivarPuente(lf)
  const desdeCRLF = derivarPuente(crlf)
  for (const archivo of ['firestore.rules', 'storage.rules']) {
    assert.equal(desdeCRLF.get(archivo), desdeLF.get(archivo), archivo)
    // Sin CR en la salida: el puente se entrega en LF.
    assert.ok(!desdeCRLF.get(archivo).includes('\r'), archivo)
  }
})

test('G3 · hash del puente desde LF == desde CRLF == aprobado', () => {
  const lf = finalesEnLF()
  const desdeLF = derivarPuente(lf)
  const desdeCRLF = derivarPuente(Object.fromEntries(Object.entries(lf).map(([k, v]) => [k, aCRLF(v)])))
  assert.equal(sha(desdeCRLF.get('firestore.rules')), sha(desdeLF.get('firestore.rules')))
  assert.equal(sha(desdeCRLF.get('storage.rules')), sha(desdeLF.get('storage.rules')))
  assert.equal(sha(desdeCRLF.get('firestore.rules')), HASH.puenteFirestore)
  assert.equal(sha(desdeCRLF.get('storage.rules')), HASH.puenteStorage)
})

test('G4 · ancla inexistente ⇒ falla, no genera un puente silenciosamente malo', () => {
  const parche = { archivo: 'x.rules', porque: 'caso de prueba', buscar: 'NO ESTA', reemplazar: 'y' }
  assert.throws(() => derivarPuente({ 'x.rules': 'contenido cualquiera\n' }, [parche]), (e) => {
    assert.ok(e instanceof AnclaPuenteInvalida)
    assert.equal(e.veces, 0)
    assert.match(e.message, /aparece 0 veces, se esperaba 1/)
    return true
  })
  // Y con las Rules reales: si se le quita el ancla, también falla.
  const sinAncla = { ...finalesEnLF() }
  sinAncla['storage.rules'] = sinAncla['storage.rules'].replace(PARCHES[2].buscar, '// quitada')
  assert.throws(() => derivarPuente(sinAncla), AnclaPuenteInvalida)
})

test('G5 · ancla duplicada ⇒ falla', () => {
  const parche = { archivo: 'x.rules', porque: 'caso de prueba', buscar: 'ANCLA\nDOS', reemplazar: 'y' }
  assert.throws(() => derivarPuente({ 'x.rules': 'ANCLA\nDOS ... ANCLA\nDOS' }, [parche]), (e) => {
    assert.ok(e instanceof AnclaPuenteInvalida)
    assert.equal(e.veces, 2)
    assert.match(e.message, /aparece 2 veces, se esperaba 1/)
    return true
  })
  // Con las Rules reales: duplicar el interruptor también rompe.
  const duplicada = { ...finalesEnLF() }
  duplicada['firestore.rules'] = duplicada['firestore.rules'].replace(PARCHES[0].buscar, PARCHES[0].buscar + '\n' + PARCHES[0].buscar)
  assert.throws(() => derivarPuente(duplicada), AnclaPuenteInvalida)
})

test('G6 · generarPuente escribe en LF desde el working tree real (destino temporal)', () => {
  const destino = mkdtempSync(join(tmpdir(), 'puente-'))
  try {
    generarPuente(destino)
    for (const [archivo, hash] of [['firestore.rules', HASH.puenteFirestore], ['storage.rules', HASH.puenteStorage]]) {
      const escrito = readFileSync(join(destino, archivo), 'utf8')
      assert.ok(!escrito.includes('\r'), archivo)
      assert.equal(sha(escrito), hash, archivo)
    }
  } finally {
    rmSync(destino, { recursive: true, force: true })
  }
})
