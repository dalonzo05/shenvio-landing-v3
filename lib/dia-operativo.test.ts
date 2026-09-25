// DASH-DATE — suite focal de lib/dia-operativo.ts.
//
// Los instantes de referencia salen de datos reales de staging: las entregas
// ocurren de tarde y noche, y tres de las cinco caen en un día UTC distinto al
// día de Nicaragua. Eso es justo lo que estos tests defienden.
//
// Todo se expresa en instantes UTC explícitos para que la suite valga lo mismo
// con cualquier TZ en el proceso.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  OFFSET_NICARAGUA_HORAS,
  esDiaOperativo,
  diaOperativoDe,
  hoyOperativo,
  esHoyOperativo,
  rangoDiaOperativo,
  sumarDiasOperativos,
  diaAnterior,
  diaSiguiente,
  esDiaFuturo,
  puedeAvanzar,
  normalizarDiaSeleccionado,
  diaDeCreacion,
  diaDeEntrega,
  entregaSinFecha,
  esEntregadaEnDia,
  esEntregadaHoy,
  esEntregadaEnRango,
  rangoDiasDeFiltro,
  type EntradaDiaOrden,
} from './dia-operativo'

const ms = (iso: string) => Date.parse(iso)

// ─── Frontera de medianoche ───────────────────────────────────────────────────

test('DO1 · un instante justo ANTES de medianoche Nicaragua pertenece al día que termina', () => {
  // 05:59:59.999Z = 23:59:59.999 del día anterior en Nicaragua.
  assert.equal(diaOperativoDe(ms('2026-08-22T05:59:59.999Z')), '2026-08-21')
})

test('DO2 · un instante justo DESPUÉS de medianoche Nicaragua pertenece al día nuevo', () => {
  assert.equal(diaOperativoDe(ms('2026-08-22T06:00:00.000Z')), '2026-08-22')
})

test('DO3 · 23:30 en Nicaragua sigue siendo el mismo día aunque en UTC ya sea el siguiente', () => {
  // 2026-08-21 23:30 Nicaragua = 2026-08-22T05:30Z. El día UTC dice 22.
  const instante = ms('2026-08-22T05:30:00.000Z')
  assert.equal(new Date(instante).toISOString().slice(0, 10), '2026-08-22')
  assert.equal(diaOperativoDe(instante), '2026-08-21')
})

test('DO3b · caso real de staging: k5Ve09HM se entregó el 21, no el 22', () => {
  // historial.entregadoAt leído de shenvios-staging.
  assert.equal(diaOperativoDe(ms('2026-08-22T03:23:57.827Z')), '2026-08-21')
  // Y las dos del 19 que en UTC parecen del 20.
  assert.equal(diaOperativoDe(ms('2026-08-20T02:53:29.363Z')), '2026-08-19')
  assert.equal(diaOperativoDe(ms('2026-08-20T02:46:26.861Z')), '2026-08-19')
})

// ─── Rango ────────────────────────────────────────────────────────────────────

test('DO4 · el inicio del rango es 00:00:00.000 de Nicaragua', () => {
  const r = rangoDiaOperativo('2026-08-21')
  assert.ok(r)
  assert.equal(new Date(r.inicioMs).toISOString(), '2026-08-21T06:00:00.000Z')
  assert.equal(diaOperativoDe(r.inicioMs), '2026-08-21')
})

test('DO5 · el fin del rango es 23:59:59.999 de Nicaragua, inclusivo', () => {
  const r = rangoDiaOperativo('2026-08-21')
  assert.ok(r)
  assert.equal(new Date(r.finMs).toISOString(), '2026-08-22T05:59:59.999Z')
  assert.equal(diaOperativoDe(r.finMs), '2026-08-21')
})

test('DO6 · días consecutivos no dejan hueco', () => {
  const a = rangoDiaOperativo('2026-08-21')
  const b = rangoDiaOperativo('2026-08-22')
  assert.ok(a && b)
  // Exactamente 1 ms: ningún instante queda sin día.
  assert.equal(b.inicioMs - a.finMs, 1)
})

test('DO7 · días consecutivos no se solapan', () => {
  const a = rangoDiaOperativo('2026-08-21')
  const b = rangoDiaOperativo('2026-08-22')
  assert.ok(a && b)
  assert.ok(a.finMs < b.inicioMs)
  assert.equal(a.finMs - a.inicioMs, 24 * 60 * 60 * 1000 - 1)
})

test('DO8 · 00:00 pertenece al día nuevo', () => {
  const r = rangoDiaOperativo('2026-08-22')
  assert.ok(r)
  assert.equal(diaOperativoDe(r.inicioMs), '2026-08-22')
  assert.notEqual(diaOperativoDe(r.inicioMs), '2026-08-21')
})

test('DO9 · 23:59:59.999 pertenece al día que termina', () => {
  const r = rangoDiaOperativo('2026-08-21')
  assert.ok(r)
  assert.equal(diaOperativoDe(r.finMs), '2026-08-21')
  // Y un milisegundo más ya es del siguiente.
  assert.equal(diaOperativoDe(r.finMs + 1), '2026-08-22')
})

// ─── Calendario ───────────────────────────────────────────────────────────────

test('DO10 · cambio de mes', () => {
  assert.equal(diaSiguiente('2026-08-31'), '2026-09-01')
  assert.equal(diaAnterior('2026-09-01'), '2026-08-31')
})

test('DO11 · cambio de año', () => {
  assert.equal(diaSiguiente('2026-12-31'), '2027-01-01')
  assert.equal(diaAnterior('2027-01-01'), '2026-12-31')
})

test('DO12 · año bisiesto: 2028 tiene 29 de febrero y 2026 no', () => {
  assert.equal(diaSiguiente('2028-02-28'), '2028-02-29')
  assert.equal(diaSiguiente('2028-02-29'), '2028-03-01')
  assert.equal(diaSiguiente('2026-02-28'), '2026-03-01')
  // Una fecha que no existe no se acepta aunque tenga el formato correcto.
  assert.equal(esDiaOperativo('2026-02-29'), false)
  assert.equal(rangoDiaOperativo('2026-02-29'), null)
})

test('DO12b · sumar y restar N días es reversible', () => {
  assert.equal(sumarDiasOperativos('2026-08-21', 40), '2026-09-30')
  assert.equal(sumarDiasOperativos('2026-09-30', -40), '2026-08-21')
  assert.equal(sumarDiasOperativos('2026-08-21', 0), '2026-08-21')
})

// ─── Hoy / ayer / mañana ──────────────────────────────────────────────────────

test('DO13 · hoy operativo se calcula con el "ahora" inyectado', () => {
  assert.equal(hoyOperativo(ms('2026-08-22T05:30:00.000Z')), '2026-08-21')
  assert.equal(hoyOperativo(ms('2026-08-22T06:00:00.000Z')), '2026-08-22')
  assert.equal(esHoyOperativo('2026-08-21', ms('2026-08-22T05:30:00.000Z')), true)
  assert.equal(esHoyOperativo('2026-08-22', ms('2026-08-22T05:30:00.000Z')), false)
})

test('DO14 · ayer', () => {
  const ahora = ms('2026-08-22T18:00:00.000Z') // 12:00 Nicaragua del 22
  assert.equal(hoyOperativo(ahora), '2026-08-22')
  assert.equal(diaAnterior(hoyOperativo(ahora)), '2026-08-21')
  assert.equal(esDiaFuturo('2026-08-21', ahora), false)
})

test('DO15 · mañana es futuro y la navegación no lo permite', () => {
  const ahora = ms('2026-08-22T18:00:00.000Z')
  assert.equal(esDiaFuturo('2026-08-23', ahora), true)
  assert.equal(puedeAvanzar('2026-08-22', ahora), false)
  assert.equal(puedeAvanzar('2026-08-21', ahora), true)
})

test('DO18 · una fecha futura escrita a mano se corrige a hoy', () => {
  const ahora = ms('2026-08-22T18:00:00.000Z')
  assert.equal(normalizarDiaSeleccionado('2027-01-01', ahora), '2026-08-22')
  assert.equal(normalizarDiaSeleccionado('2026-08-20', ahora), '2026-08-20')
  // Basura o vacío tampoco se consulta: cae a hoy.
  assert.equal(normalizarDiaSeleccionado('no-es-fecha', ahora), '2026-08-22')
  assert.equal(normalizarDiaSeleccionado(null, ahora), '2026-08-22')
})

test('DO18b · el último instante de hoy todavía no habilita avanzar', () => {
  const finDeHoy = ms('2026-08-22T05:59:59.999Z') // 23:59:59.999 del 21
  assert.equal(hoyOperativo(finDeHoy), '2026-08-21')
  assert.equal(puedeAvanzar('2026-08-21', finDeHoy), false)
  // Un milisegundo después ya es otro día y el 21 pasa a ser navegable.
  assert.equal(puedeAvanzar('2026-08-21', finDeHoy + 1), true)
})

// ─── Independencia del proceso ────────────────────────────────────────────────

test('DO16 · el resultado no depende del timezone del proceso', () => {
  const original = process.env.TZ
  const instante = ms('2026-08-22T03:23:57.827Z')
  const resultados: string[] = []
  for (const tz of ['UTC', 'Asia/Tokyo', 'America/Managua', 'Pacific/Kiritimati']) {
    process.env.TZ = tz
    resultados.push(
      [
        diaOperativoDe(instante),
        String(rangoDiaOperativo('2026-08-21')?.inicioMs),
        String(rangoDiaOperativo('2026-08-21')?.finMs),
        diaSiguiente('2026-08-31'),
        String(esDiaFuturo('2026-08-23', ms('2026-08-22T18:00:00.000Z'))),
      ].join('|'),
    )
  }
  if (original === undefined) delete process.env.TZ
  else process.env.TZ = original
  assert.equal(new Set(resultados).size, 1, `resultados divergentes por TZ: ${resultados.join(' vs ')}`)
  assert.equal(resultados[0].startsWith('2026-08-21|'), true)
})

test('DO17 · el helper no consulta el reloj: mismo "ahora" ⇒ mismo resultado', () => {
  // Si hubiera un Date.now() interno, dos llamadas separadas podrían diferir
  // en la frontera. Con el instante inyectado el resultado es una función pura.
  const frontera = ms('2026-08-22T05:59:59.999Z')
  const a = [hoyOperativo(frontera), esHoyOperativo('2026-08-21', frontera), puedeAvanzar('2026-08-21', frontera)]
  const b = [hoyOperativo(frontera), esHoyOperativo('2026-08-21', frontera), puedeAvanzar('2026-08-21', frontera)]
  assert.deepEqual(a, b)
  assert.equal(OFFSET_NICARAGUA_HORAS, -6)
})

test('DO17b · entradas inválidas devuelven null en vez de una fecha inventada', () => {
  assert.equal(diaOperativoDe(Number.NaN), null)
  assert.equal(diaOperativoDe(Number.POSITIVE_INFINITY), null)
  assert.equal(rangoDiaOperativo('21-08-2026'), null)
  assert.equal(rangoDiaOperativo(''), null)
  assert.equal(sumarDiasOperativos('2026-13-01', 1), null)
  assert.equal(esDiaOperativo('2026-8-1'), false)
})

// ─── Atribución de la orden a un día ──────────────────────────────────────────

const ts = (iso: string) => ({ toDate: () => new Date(iso) })

test('DO19 · una entregada SIN historial.entregadoAt no se atribuye a ningún día', () => {
  const orden: EntradaDiaOrden = {
    estado: 'entregado',
    createdAt: ts('2026-08-21T18:00:00.000Z'),
    historial: {},
  }
  assert.equal(diaDeEntrega(orden), null)
  assert.equal(entregaSinFecha(orden), true)
  // La creación sí se conoce; son dos preguntas distintas.
  assert.equal(diaDeCreacion(orden), '2026-08-21')
})

test('DO19b · sin historial completo tampoco revienta', () => {
  assert.equal(diaDeEntrega({ estado: 'entregado' }), null)
  assert.equal(diaDeEntrega({ estado: 'entregado', historial: null }), null)
  assert.equal(diaDeEntrega({}), null)
})

test('DO20 · createdAt NO reemplaza a entregadoAt', () => {
  // Creada el 19, entregada el 21: cada métrica cuenta en su propio día.
  const orden: EntradaDiaOrden = {
    estado: 'entregado',
    createdAt: ts('2026-08-19T20:00:00.000Z'),
    historial: { entregadoAt: ts('2026-08-22T03:23:57.827Z') },
  }
  assert.equal(diaDeCreacion(orden), '2026-08-19')
  assert.equal(diaDeEntrega(orden), '2026-08-21')
  assert.notEqual(diaDeEntrega(orden), diaDeCreacion(orden))
  assert.equal(entregaSinFecha(orden), false)
})

test('DO20b · el estado "entregado" por sí solo no fecha nada', () => {
  // Aunque la orden esté entregada y tenga createdAt de hoy, sin el timestamp
  // de entrega no cuenta: el estado dice QUÉ pasó, no CUÁNDO.
  const orden: EntradaDiaOrden = {
    estado: 'entregado',
    createdAt: ts('2026-08-22T18:00:00.000Z'),
    historial: { entregadoAt: null },
  }
  assert.equal(diaDeEntrega(orden), null)
  assert.equal(entregaSinFecha(orden), true)
})

test('DO20c · una orden no entregada nunca es "entrega sin fecha"', () => {
  assert.equal(entregaSinFecha({ estado: 'cancelada', createdAt: ts('2026-08-21T18:00:00.000Z') }), false)
  assert.equal(entregaSinFecha({ estado: 'confirmada' }), false)
})

// ─── VIAJE-FECHA-ENTREGA-CANONICA-1 · "entregada hoy" ─────────────────────────
//
// `updatedAt` y `createdAt` no forman parte de EntradaDiaOrden; estas órdenes
// los llevan igual, como los lleva un documento real de Firestore, para probar
// que ninguno de los dos cambia la respuesta.

type OrdenReal = EntradaDiaOrden & {
  updatedAt?: unknown
  entregadoAt?: unknown
  cobroDelivery?: unknown
  registro?: unknown
}

// 20:00Z del 25/09 = 14:00 en Nicaragua: hoy operativo = 2026-09-25.
const AHORA = ms('2026-09-25T20:00:00.000Z')
const HOY = '2026-09-25'

test('DO21 · F1 · entregada hoy por timestamp real → cuenta hoy', () => {
  const orden: OrdenReal = {
    estado: 'entregado',
    createdAt: ts('2026-09-25T15:00:00.000Z'),
    historial: { entregadoAt: ts('2026-09-25T18:00:00.000Z') },
  }
  assert.equal(esEntregadaHoy(orden, AHORA), true)
  assert.equal(esEntregadaEnDia(orden, HOY), true)
})

test('DO22 · F2 · entregada AYER con updatedAt de hoy → NO cuenta hoy', () => {
  const orden: OrdenReal = {
    estado: 'entregado',
    createdAt: ts('2026-09-24T15:00:00.000Z'),
    historial: { entregadoAt: ts('2026-09-24T22:00:00.000Z') },
    updatedAt: ts('2026-09-25T17:00:00.000Z'),
  }
  assert.equal(esEntregadaHoy(orden, AHORA), false)
  assert.equal(esEntregadaEnDia(orden, '2026-09-24'), true)
})

test('DO23 · F3 · entregada hoy con updatedAt de otro día → cuenta por la entrega', () => {
  const orden: OrdenReal = {
    estado: 'entregado',
    historial: { entregadoAt: ts('2026-09-25T19:00:00.000Z') },
    updatedAt: ts('2026-09-20T12:00:00.000Z'),
  }
  assert.equal(esEntregadaHoy(orden, AHORA), true)
})

test('DO24 · F4 · estado entregado SIN timestamp de entrega → NO cuenta hoy y es entregaSinFecha', () => {
  const sinHistorial: OrdenReal = {
    estado: 'entregado',
    createdAt: ts('2026-09-25T15:00:00.000Z'),
    updatedAt: ts('2026-09-25T17:00:00.000Z'),
  }
  const historialVacio: OrdenReal = { ...sinHistorial, historial: { entregadoAt: null } }
  for (const orden of [sinHistorial, historialVacio]) {
    assert.equal(esEntregadaHoy(orden, AHORA), false)
    assert.equal(esEntregadaEnDia(orden, HOY), false)
    assert.equal(esEntregadaEnRango(orden, HOY, HOY), false)
    assert.equal(entregaSinFecha(orden), true)
  }
})

test('DO25 · F5 · updatedAt sin entregadoAt jamás se convierte en fecha de entrega', () => {
  const orden: OrdenReal = {
    estado: 'entregado',
    updatedAt: ts('2026-09-25T17:00:00.000Z'),
    createdAt: ts('2026-09-25T15:00:00.000Z'),
  }
  assert.equal(diaDeEntrega(orden), null)
  for (const dia of ['2026-09-24', HOY, '2026-09-26']) {
    assert.equal(esEntregadaEnDia(orden, dia), false)
  }
  assert.equal(esEntregadaEnRango(orden, '2026-01-01', '2026-12-31'), false)
})

test('DO26 · F6 · el día lo decide Nicaragua (UTC−6), no el huso del proceso', () => {
  // 03:30Z del 26 = 21:30 del 25 en Nicaragua: en UTC ya es "mañana".
  const tarde: OrdenReal = {
    estado: 'entregado',
    historial: { entregadoAt: ts('2026-09-26T03:30:00.000Z') },
  }
  assert.equal(esEntregadaEnDia(tarde, '2026-09-25'), true)
  assert.equal(esEntregadaEnDia(tarde, '2026-09-26'), false)
  // 22:00 del 25 en Nicaragua (04:00Z del 26): sigue siendo hoy 25.
  assert.equal(esEntregadaHoy(tarde, ms('2026-09-26T04:00:00.000Z')), true)
  // 00:00 del 26 en Nicaragua (06:00Z): el día cambió y la orden ya es de ayer.
  assert.equal(esEntregadaHoy(tarde, ms('2026-09-26T06:00:00.000Z')), false)
  // Un día inválido no coincide con nada.
  assert.equal(esEntregadaEnDia(tarde, '2026-02-30'), false)
  assert.equal(esEntregadaEnDia(tarde, ''), false)
})

test('DO27 · F7 · una escritura financiera posterior no mueve el día histórico de la entrega', () => {
  const orden: OrdenReal = {
    estado: 'entregado',
    createdAt: ts('2026-09-22T15:00:00.000Z'),
    historial: { entregadoAt: ts('2026-09-24T22:00:00.000Z') },
    // Hoy alguien confirma un depósito, paga el cobro y toca la orden.
    updatedAt: ts('2026-09-25T18:00:00.000Z'),
    cobroDelivery: { estado: 'pagado', pagadoAt: ts('2026-09-25T18:00:00.000Z') },
    registro: { deposito: { confirmadoStorkhubAt: ts('2026-09-25T18:00:00.000Z') } },
  }
  assert.equal(diaDeEntrega(orden), '2026-09-24')
  assert.equal(esEntregadaHoy(orden, AHORA), false)
  assert.equal(esEntregadaEnDia(orden, '2026-09-24'), true)
})

test('DO28 · una orden que no está entregada no cuenta aunque conserve una fecha de entrega vieja', () => {
  const reabierta: OrdenReal = {
    estado: 'pendiente_confirmacion',
    historial: { entregadoAt: ts('2026-09-25T18:00:00.000Z') },
  }
  assert.equal(esEntregadaHoy(reabierta, AHORA), false)
  assert.equal(esEntregadaEnRango(reabierta, HOY, HOY), false)
})

test('DO29 · rangoDiasDeFiltro resuelve hoy, ayer y 7 días en días operativos', () => {
  assert.deepEqual(rangoDiasDeFiltro('hoy', AHORA), { desde: HOY, hasta: HOY })
  assert.deepEqual(rangoDiasDeFiltro('ayer', AHORA), { desde: '2026-09-24', hasta: '2026-09-24' })
  assert.deepEqual(rangoDiasDeFiltro('7dias', AHORA), { desde: '2026-09-19', hasta: HOY })
  // Cambio de mes: 7 días terminando el 2 de octubre empiezan el 26 de septiembre.
  assert.deepEqual(rangoDiasDeFiltro('7dias', ms('2026-10-02T20:00:00.000Z')), { desde: '2026-09-26', hasta: '2026-10-02' })
  // A las 03:00Z del 26 todavía es 25 en Nicaragua.
  assert.deepEqual(rangoDiasDeFiltro('hoy', ms('2026-09-26T03:00:00.000Z')), { desde: HOY, hasta: HOY })
})

test('DO30 · rangoDiasDeFiltro personalizado solo acepta fechas reales', () => {
  assert.deepEqual(rangoDiasDeFiltro('personalizado', AHORA, '2026-09-01', '2026-09-10'), { desde: '2026-09-01', hasta: '2026-09-10' })
  assert.equal(rangoDiasDeFiltro('personalizado', AHORA, '', '2026-09-10'), null)
  assert.equal(rangoDiasDeFiltro('personalizado', AHORA, '2026-09-01', undefined), null)
  assert.equal(rangoDiasDeFiltro('personalizado', AHORA, '2026-02-30', '2026-03-01'), null)
  assert.equal(rangoDiasDeFiltro('hoy', Number.NaN), null)
})

test('DO31 · esEntregadaEnRango incluye ambos extremos y descarta fuera del rango', () => {
  const entregadaEl = (iso: string): OrdenReal => ({ estado: 'entregado', historial: { entregadoAt: ts(iso) } })
  assert.equal(esEntregadaEnRango(entregadaEl('2026-09-19T18:00:00.000Z'), '2026-09-19', HOY), true)
  assert.equal(esEntregadaEnRango(entregadaEl('2026-09-25T18:00:00.000Z'), '2026-09-19', HOY), true)
  assert.equal(esEntregadaEnRango(entregadaEl('2026-09-18T18:00:00.000Z'), '2026-09-19', HOY), false)
  assert.equal(esEntregadaEnRango(entregadaEl('2026-09-26T18:00:00.000Z'), '2026-09-19', HOY), false)
  assert.equal(esEntregadaEnRango(entregadaEl('2026-09-20T18:00:00.000Z'), 'x', HOY), false)
})
