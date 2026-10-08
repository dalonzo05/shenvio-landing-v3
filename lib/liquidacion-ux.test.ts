import { test } from 'node:test'
import * as assert from 'node:assert/strict'
import { finDeSemanaManagua, semanaYaTermino } from './liquidacion-ux'

test('el fin de semana es el domingo 23:59:59.999 de Managua (UTC−6)', () => {
  // 2026-W20: lunes 11-may a domingo 17-may. El domingo 23:59:59.999 Managua = lunes 18-may 05:59:59.999 UTC.
  assert.equal(finDeSemanaManagua('2026-W20'), Date.UTC(2026, 4, 18, 5, 59, 59, 999))
})

test('una semana solo "terminó" DESPUÉS de su último milisegundo en Managua', () => {
  const fin = finDeSemanaManagua('2026-W20') as number
  assert.equal(semanaYaTermino('2026-W20', fin), false)
  assert.equal(semanaYaTermino('2026-W20', fin + 1), true)
  assert.equal(semanaYaTermino('2026-W20', Date.UTC(2026, 4, 13, 12)), false) // a mitad de semana
  assert.equal(semanaYaTermino('2026-W30', Date.UTC(2026, 4, 20, 15)), false) // futura
  assert.equal(semanaYaTermino('2026-W19', Date.UTC(2026, 4, 20, 15)), true) // pasada
})

test('una semana inválida nunca se considera terminada', () => {
  for (const s of ['', '2026-20', '2026-W00', '2026-W54', 'basura']) {
    assert.equal(finDeSemanaManagua(s), null, s)
    assert.equal(semanaYaTermino(s, Date.UTC(2030, 0, 1)), false, s)
  }
})
