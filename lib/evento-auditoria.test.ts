// B2-AUDITORIA-UX — suite focal de lib/evento-auditoria.ts.
//
// Los fixtures están calcados de escrituras reales del repo: las descripciones
// son las que `registrarMovimiento()` persiste hoy desde Depósitos, Cobros y
// Liquidaciones. Lo que se protege acá no es el layout, son las tres reglas
// que el helper no puede violar (ver cabecera del helper).

import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  tituloMovimiento,
  etiquetaRolRegistrado,
  estaAnulado,
  detalleAnulacion,
  refsMovimiento,
  resolverMotorizado,
  TITULO_GENERICO,
  ROL_NO_DISPONIBLE,
  type EntradaEventoAuditoria,
  type MotorizadoConocido,
} from './evento-auditoria'

const MOTORIZADOS: MotorizadoConocido[] = [
  { id: 'motDoc1', authUid: 'authUid1', nombre: 'Juan Pérez' },
  { id: 'motDoc2', authUid: 'authUid2', nombre: '' },
]

// ─── Qué ocurrió ──────────────────────────────────────────────────────────────

test('EA1 · la descripción persistida manda sobre la etiqueta del tipo', () => {
  const m: EntradaEventoAuditoria = {
    tipo: 'deposito_efectivo_storkhub',
    descripcion: 'Gestor confirmó depósito Storkhub · Juan Pérez',
  }
  const r = tituloMovimiento(m)
  assert.equal(r.titulo, 'Gestor confirmó depósito Storkhub · Juan Pérez')
  assert.equal(r.origen, 'descripcion')
  // El tipo crudo sigue disponible para el chip técnico, no se pierde.
  assert.equal(r.tipoCrudo, 'deposito_efectivo_storkhub')
})

test('EA2 · descripción vacía o en blanco cae al fallback legible del tipo', () => {
  for (const desc of ['', '   ', null, undefined]) {
    const r = tituloMovimiento({ tipo: 'deposito_confirmado', descripcion: desc })
    assert.equal(r.titulo, 'Depósito confirmado')
    assert.equal(r.origen, 'tipo')
  }
})

test('EA3 · tipo desconocido degrada sin romper y sin inventar prosa', () => {
  const r = tituloMovimiento({ tipo: 'tipo_que_no_existe_todavia', descripcion: '' })
  assert.equal(r.titulo, TITULO_GENERICO)
  assert.equal(r.origen, 'generico')
  // No se traduce el identificador crudo a una frase inventada…
  assert.ok(!r.titulo.includes('tipo_que_no_existe_todavia'))
  // …pero se conserva para el chip, que es quien desambigua.
  assert.equal(r.tipoCrudo, 'tipo_que_no_existe_todavia')
})

test('EA3b · sin tipo ni descripción no revienta', () => {
  const r = tituloMovimiento({})
  assert.equal(r.titulo, TITULO_GENERICO)
  assert.equal(r.tipoCrudo, '')
})

test('EA3c · ninguna etiqueta de tipo atribuye la acción a un rol', () => {
  // El rol persistido no es confiable: una etiqueta como "Gestor confirmó…"
  // afirmaría autoría que el documento no demuestra.
  const tipos = [
    'deposito_confirmado', 'deposito_rechazado', 'deposito_convertido_en_deuda',
    'pago_recibido', 'liquidacion_pago_efectivo', 'gasto_operativo_aprobado',
    'abono_deuda_motorizado', 'deuda_condonada', 'anulacion',
  ]
  for (const tipo of tipos) {
    const { titulo } = tituloMovimiento({ tipo })
    for (const actor of ['Gestor', 'Admin', 'Digitador', 'Motorizado']) {
      assert.ok(
        !titulo.startsWith(actor),
        `"${titulo}" atribuye la acción a ${actor}`,
      )
    }
  }
})

// ─── Rol registrado ───────────────────────────────────────────────────────────

test('EA4 · rol gestor → Gestor', () => {
  assert.equal(etiquetaRolRegistrado('gestor'), 'Gestor')
})

test('EA5 · rol motorizado → Motorizado', () => {
  assert.equal(etiquetaRolRegistrado('motorizado'), 'Motorizado')
})

test('EA6 · rol sistema → Sistema', () => {
  assert.equal(etiquetaRolRegistrado('sistema'), 'Sistema')
})

test('EA7 · rol ausente o desconocido no inventa Admin ni Digitador', () => {
  for (const rol of [null, undefined, '', '   ', 'admin', 'digitador', 'comercio', 'root']) {
    assert.equal(etiquetaRolRegistrado(rol), ROL_NO_DISPONIBLE)
  }
})

test('EA7b · el copy nunca afirma un rol que la fuente no demuestra', () => {
  // 'admin' es el caso crítico: el writer NUNCA lo persiste (escribe 'gestor'
  // por defecto), así que verlo en el documento no lo vuelve verdadero.
  const etiqueta = etiquetaRolRegistrado('admin')
  assert.equal(etiqueta, ROL_NO_DISPONIBLE)
  assert.ok(!etiqueta.toLowerCase().includes('admin'))
})

// ─── Anulación ────────────────────────────────────────────────────────────────

test('EA13 · movimiento anulado queda marcado como anulado', () => {
  assert.equal(estaAnulado({ estado: 'anulado' }), true)
})

test('EA13b · rastro de anulación basta aunque el estado no se haya actualizado', () => {
  assert.equal(estaAnulado({ estado: 'activo', anuladoPorMovimientoId: 'mov9' }), true)
  assert.equal(estaAnulado({ estado: 'activo', anuladoPorUid: 'uidX' }), true)
  assert.equal(estaAnulado({ estado: 'activo', motivoAnulacion: 'Boucher ilegible' }), true)
  assert.equal(estaAnulado({ estado: 'activo', anuladoAt: { seconds: 1 } }), true)
})

test('EA14 · movimiento activo NO queda marcado como anulado', () => {
  const m: EntradaEventoAuditoria = {
    tipo: 'pago_recibido',
    estado: 'activo',
    descripcion: 'Pago delivery por transferencia confirmado · Comercio X',
  }
  assert.equal(estaAnulado(m), false)
  assert.equal(detalleAnulacion(m), null)
})

test('EA14b · el detalle de anulación solo muestra campos persistidos', () => {
  const d = detalleAnulacion({
    estado: 'anulado',
    anuladoPorUid: 'uidGestor',
    motivoAnulacion: 'Depósito duplicado',
  })
  assert.ok(d)
  assert.equal(d.porUid, 'uidGestor')
  assert.equal(d.motivo, 'Depósito duplicado')
  // Lo ausente queda null: no se rellena con nada.
  assert.equal(d.movimientoId, null)
  assert.equal(d.at, null)
})

test('EA14c · anulado sin ningún dato de anulación no pinta ficha vacía', () => {
  assert.equal(detalleAnulacion({ estado: 'anulado' }), null)
})

// ─── Referencias y navegación ─────────────────────────────────────────────────

test('EA8 · solicitud válida navega al historial de la ficha', () => {
  const refs = refsMovimiento({ solicitudId: 'k5Ve09HMvKYJxwgw8ba3' })
  const solicitud = refs.find((r) => r.clave === 'solicitud')
  assert.ok(solicitud)
  assert.equal(solicitud.ruta, '/panel/gestor/solicitudes/k5Ve09HMvKYJxwgw8ba3#historial')
})

test('EA9 · sin solicitudId no se inventa ningún link de solicitud', () => {
  const refs = refsMovimiento({ depositoId: 'dep1' })
  assert.equal(refs.some((r) => r.clave === 'solicitud'), false)
})

test('EA10 · depósito sin documento leído no inventa destino', () => {
  const refs = refsMovimiento({ depositoId: 'dep1' })
  const dep = refs.find((r) => r.clave === 'deposito')
  assert.ok(dep)
  assert.equal(dep.ruta, null)
  assert.equal(dep.ordenes, undefined)
})

test('EA10b · depósito leído pero sin solicitudIds tampoco inventa destino', () => {
  const refs = refsMovimiento({ depositoId: 'dep1' }, { id: 'dep1', solicitudIds: [] })
  const dep = refs.find((r) => r.clave === 'deposito')
  assert.ok(dep)
  assert.equal(dep.ruta, null)
})

test('EA11 · depósito de UNA sola orden navega a su bloque de depósitos', () => {
  const refs = refsMovimiento(
    { depositoId: 'dep1' },
    { id: 'dep1', solicitudIds: ['8MWJtz4GWqfesGg9qkuF'] },
  )
  const dep = refs.find((r) => r.clave === 'deposito')
  assert.ok(dep)
  assert.equal(dep.ruta, '/panel/gestor/solicitudes/8MWJtz4GWqfesGg9qkuF#depositos')
  assert.equal(dep.nota, undefined)
})

test('EA12 · depósito agrupado NO elige arbitrariamente una orden', () => {
  const ids = ['8MWJtz4GWqfesGg9qkuF', 'OxGVVg3HYP0lf3NSOqAI', 'k5Ve09HMvKYJxwgw8ba3']
  const refs = refsMovimiento({ depositoId: 'dep1' }, { id: 'dep1', solicitudIds: ids })
  const dep = refs.find((r) => r.clave === 'deposito')
  assert.ok(dep)
  // Sin ruta principal: el depósito no "es" de la primera orden de la lista.
  assert.equal(dep.ruta, null)
  assert.equal(dep.nota, '3 órdenes')
  // Todas se ofrecen por separado, ninguna privilegiada.
  assert.equal(dep.ordenes?.length, 3)
  assert.deepEqual(dep.ordenes?.map((o) => o.id), ids)
  for (const o of dep.ordenes ?? []) {
    assert.ok(o.ruta.endsWith('#depositos'))
  }
})

test('EA12b · los IDs sin superficie propia se conservan sin ruta inventada', () => {
  const refs = refsMovimiento({
    motorizadoId: 'motDoc1',
    comercioId: 'comercio1',
    saldoId: 'saldo1',
    gastoId: 'gasto1',
    liquidacionId: 'liq1',
  })
  assert.equal(refs.length, 5)
  for (const r of refs) assert.equal(r.ruta, null)
})

test('EA12c · un movimiento sin ninguna referencia devuelve lista vacía', () => {
  assert.deepEqual(refsMovimiento({ tipo: 'ajuste_manual' }), [])
})

// ─── Motorizado ───────────────────────────────────────────────────────────────

test('EA15 · el motorizado se resuelve por id de documento', () => {
  const r = resolverMotorizado('motDoc1', MOTORIZADOS)
  assert.ok(r)
  assert.equal(r.nombre, 'Juan Pérez')
  assert.equal(r.id, 'motDoc1')
  assert.equal(r.tieneNombre, true)
})

test('EA16 · el motorizado también se resuelve por authUid', () => {
  const r = resolverMotorizado('authUid1', MOTORIZADOS)
  assert.ok(r)
  assert.equal(r.nombre, 'Juan Pérez')
  // Devuelve SIEMPRE el id del documento, no lo que traía el movimiento.
  assert.equal(r.id, 'motDoc1')
})

test('EA16b · motorizado desconocido o vacío devuelve null, nunca un nombre inventado', () => {
  assert.equal(resolverMotorizado('noExiste', MOTORIZADOS), null)
  assert.equal(resolverMotorizado('', MOTORIZADOS), null)
  assert.equal(resolverMotorizado(null, MOTORIZADOS), null)
})

test('EA16c · fila sin nombre se declara sin nombre en vez de caer al UID', () => {
  const r = resolverMotorizado('motDoc2', MOTORIZADOS)
  assert.ok(r)
  assert.equal(r.nombre, '')
  assert.equal(r.tieneNombre, false)
})
