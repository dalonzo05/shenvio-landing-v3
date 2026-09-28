import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import ts from 'typescript'
import { precioInicialAsignacion, precioParaConfirmar } from './asignacion-precio'

const confirmada = { id: 's', estado: 'confirmada', confirmacion: { precioFinalCordobas: 130 } }
test('P1 pendiente usa sugerido como inicial', () => assert.equal(precioInicialAsignacion({ id: 's', estado: 'pendiente_confirmacion' }, 90), 90))
test('P2 confirmada C$130 no prioriza sugerido C$90', () => assert.equal(precioInicialAsignacion(confirmada, 90), 130))
test('P3 no editar no envía precio ni nueva confirmación', () => assert.deepEqual(precioParaConfirmar(confirmada, 130, false), { precioEditado: false }))
test('P4 edición explícita envía C$140', () => assert.deepEqual(precioParaConfirmar(confirmada, 140, true), { precioEditado: true, precioFinal: 140 }))
test('P6 cambiar candidato no modifica precio ni dirty flag', () => {
  for (const motorizadoId of ['m1', 'm2', null]) {
    const formulario = { ...confirmada, motorizadoId }
    assert.equal(precioInicialAsignacion(formulario, 90), 130)
    assert.deepEqual(precioParaConfirmar(formulario, 130, false), { precioEditado: false })
  }
})
test('Precio confirmado válido no se redondea al abrir', () => assert.equal(precioInicialAsignacion({ ...confirmada, confirmacion: { precioFinalCordobas: 135 } }, 90), 135))
test('Precio inicial inválido no se inventa', () => {
  assert.equal(precioInicialAsignacion({ ...confirmada, confirmacion: null }, undefined), '')
  assert.equal(precioInicialAsignacion({ ...confirmada, confirmacion: { precioFinalCordobas: NaN } }, 90), 90)
})

const root = join(__dirname, '..')
const superficies = ['solicitudes/page.tsx', '_components/SolicitudDrawer.tsx', 'solicitudes/[id]/page.tsx', 'base-datos/page.tsx']
test('M6 auditoría AST: ningún payload directo Gestor crea/reemplaza asignación', () => {
  function archivos(dir: string): string[] { return readdirSync(dir, { withFileTypes: true }).flatMap((e) => e.isDirectory() ? archivos(join(dir, e.name)) : /\.tsx?$/.test(e.name) ? [join(dir, e.name)] : []) }
  for (const path of archivos(join(root, 'app/panel/gestor'))) {
    const src = ts.createSourceFile(path, readFileSync(path, 'utf8'), ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX)
    function visit(n: ts.Node) {
      if (ts.isCallExpression(n) && /(?:updateDoc|setDoc|\.update|\.set)$/.test(n.expression.getText(src))) {
        for (const arg of n.arguments.slice(1)) {
          function payload(x: ts.Node) {
            if (ts.isPropertyAssignment(x) && /^['"]?asignacion(?:[.'"]|$)/.test(x.name.getText(src))) {
              assert.equal(x.initializer.kind, ts.SyntaxKind.NullKeyword, path + ': writer directo de asignación: ' + x.getText(src))
            }
            ts.forEachChild(x, payload)
          }
          payload(arg)
        }
      }
      ts.forEachChild(n, visit)
    }
    visit(src)
  }
})
test('Seis call sites migrados; selección no marca precio editado', () => {
  let llamadas = 0
  for (const path of superficies) {
    const s = readFileSync(join(root, 'app/panel/gestor', path), 'utf8')
    llamadas += (s.match(/await guardarAsignacion\(/g) ?? []).length
    assert.ok(s.includes('setPrecioEditado(true)'), path)
    assert.ok(s.includes('precioInicialAsignacion('), path)
    assert.ok(s.includes('errorAsignacion(e)'), path)
    assert.ok(s.includes('asignacionEnCurso.current'), path)
    assert.ok(!/setMotorizadoSel\([^\n]*setPrecioEditado\(true\)/.test(s), path)
  }
  assert.equal(llamadas, 6)
})
test('P5 UI de reasignación no envía precio', () => {
  const s = readFileSync(join(root, 'app/panel/gestor/solicitudes/page.tsx'), 'utf8')
  assert.ok(s.includes("guardarAsignacion(solicitud, motorizadoSel, 'reasignar', 'solicitudes')"))
})
test('Modal conserva versión de apertura: otra sesión no convierte guardar en reasignación implícita', () => {
  const s = readFileSync(join(root, 'app/panel/gestor/solicitudes/page.tsx'), 'utf8')
  for (const abrir of ['abrirConfirmarYAsignar', 'abrirReasignar']) {
    const start = s.indexOf('const ' + abrir + ' =')
    assert.ok(s.slice(start, s.indexOf('\n  const ', start)).includes('solicitudModalRef.current = s'))
  }
  for (const guardar of ['confirmarYAsignar', 'reasignarSolo']) {
    const start = s.indexOf('const ' + guardar + ' =')
    const handler = s.slice(start, s.indexOf('\n  const ', start))
    assert.ok(handler.includes('const solicitud = solicitudModalRef.current'))
    assert.ok(!handler.includes('allItems.find'))
  }
})
test('Callable usa lecturas y escritura de la misma transaction; export conectada', () => {
  const s = readFileSync(join(root, 'functions/src/asignacion-motorizado-callable.ts'), 'utf8')
  assert.ok(s.includes('db.runTransaction'))
  assert.ok(s.includes('await tx.get('))
  assert.ok(s.includes("getMotorizado: (id) => leer('motorizado', id)"))
  assert.ok(s.includes('tx.update('))
  assert.ok(readFileSync(join(root, 'functions/src/index.ts'), 'utf8').includes("export { asignarMotorizado }"))
})
