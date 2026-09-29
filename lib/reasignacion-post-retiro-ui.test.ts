// MOTO-REASIGNACION-POST-RETIRO-GUARD-1 — fija en el código fuente real de
// las 4 superficies que la protección backend (functions/src/asignacion-
// motorizado.ts) tiene su espejo en la UI: nadie debe depender solo de que
// el botón esté oculto (el backend ya rechaza igual), pero la UI tampoco
// debe seguir ofreciendo el control. Mismo patrón de este repo para
// componentes sin runner de UI/DOM (lib/login-rol.test.ts,
// lib/motorizado-candidatos.test.ts).

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

function fuente(...ruta: string[]): string {
  return readFileSync(join(__dirname, '..', ...ruta), 'utf8').replace(/\r/g, '')
}

const LISTADO = ['app', 'panel', 'gestor', 'solicitudes', 'page.tsx']
const DRAWER = ['app', 'panel', 'gestor', '_components', 'SolicitudDrawer.tsx']
const DETALLE = ['app', 'panel', 'gestor', 'solicitudes', '[id]', 'page.tsx']
const BASE_DATOS = ['app', 'panel', 'gestor', 'base-datos', 'page.tsx']

// ─── UI1-UI3 · listado ──────────────────────────────────────────────────────

test('UI1-UI3 · el listado ofrece Reasignar según puedeReasignarMotorizado (asignada + en_camino_retiro), no un estado literal', () => {
  const src = fuente(...LISTADO)
  assert.ok(src.includes("import { esEstadoCerrado, MSG_ORDEN_CERRADA, puedeReasignarMotorizado, MSG_ORDEN_NO_REASIGNABLE } from '@/lib/estados-solicitud'"))
  const ocurrencias = src.split('puedeReasignarMotorizado(s.estado)').length - 1
  assert.equal(ocurrencias, 2, 'debe condicionar el botón Reasignar en las 2 superficies del listado (tabla + tarjeta móvil)')
  // Ya no debe quedar ningún gate de Reasignar hardcodeado a solo 'asignada'.
  assert.ok(!/\{s\.estado === 'asignada' && \(\s*\n\s*<div className="flex gap-1">/.test(src))
})

test('UI · reasignarSolo (listado) valida server-side el estado real, no solo esEstadoCerrado', () => {
  const src = fuente(...LISTADO)
  const inicio = src.indexOf('const reasignarSolo')
  const cuerpo = src.slice(inicio, inicio + 1200)
  assert.ok(cuerpo.includes('puedeReasignarMotorizado(solicitud.estado)'))
  assert.ok(cuerpo.includes("'reasignar'"))
})

test('UI · Rebotar en el listado sigue exclusivo de asignada (no se amplía a en_camino_retiro)', () => {
  const src = fuente(...LISTADO)
  const ocurrenciasRebotar = src.split("s.estado === 'asignada' &&").length - 1
  assert.ok(ocurrenciasRebotar >= 2, 'Rebotar debe seguir condicionado literalmente a asignada en ambas superficies')
})

// ─── UI4-UI7 · Drawer y detalle no ofrecen cambio de rider post-retiro ─────

for (const [nombre, ruta] of [['Drawer', DRAWER], ['detalle', DETALLE]] as const) {
  test(`UI · ${nombre}: "Decisión rápida"/"Reasignar motorizado" usa puedeGestionarAsignacion, no esEstadoCerrado ni una lista de negativos`, () => {
    const src = fuente(...ruta)
    assert.ok(src.includes('puedeGestionarAsignacion(estado)'), `${nombre} debe condicionar la sección de asignación con puedeGestionarAsignacion`)
    assert.ok(!src.includes("estado !== 'rechazada' && estado !== 'cancelada' && estado !== 'entregado'"), `${nombre} no debe seguir usando el gate viejo, incompleto`)
  })

  test(`UI4-UI7 · ${nombre}: el handler de guardar decide 'confirmar' vs 'reasignar' según el estado, nunca 'confirmar' fijo`, () => {
    const src = fuente(...ruta)
    const inicio = src.indexOf('const confirmarYAsignar')
    const fin = src.indexOf('\n  }', src.indexOf("finally {", inicio))
    const cuerpo = src.slice(inicio, fin > inicio ? fin : inicio + 1500)
    assert.ok(cuerpo.includes('puedeGestionarAsignacion(solicitud.estado)'))
    assert.ok(cuerpo.includes('puedeReasignarMotorizado(solicitud.estado)'))
    assert.ok(cuerpo.includes("'reasignar'"), `${nombre} debe poder disparar operacion:'reasignar'`)
    assert.ok(cuerpo.includes("'confirmar'"), `${nombre} debe conservar operacion:'confirmar' para asignación inicial`)
  })

  test(`UI · ${nombre}: el precio y "No asignar todavía" quedan detrás de puedeAsignarInicial (no se ofrecen al reasignar)`, () => {
    const src = fuente(...ruta)
    const ocurrenciasGuardPrecio = src.split('puedeAsignarInicial(estado)').length - 1
    assert.ok(ocurrenciasGuardPrecio >= 3, `${nombre}: precio, "No asignar todavía" y el título/label del botón deben usar puedeAsignarInicial`)
  })
}

// ─── UI8 · Base de Datos ────────────────────────────────────────────────────

test('UI8 · Base de Datos no ofrece assignment para entregados ni para retirado/en_camino_entrega (mismo predicado)', () => {
  const src = fuente(...BASE_DATOS)
  assert.ok(src.includes('puedeGestionarAsignacion(estado)'))
  assert.ok(src.includes('puedeAsignarInicial(estado)'))
  assert.ok(!src.includes("estado !== 'rechazada' && estado !== 'cancelada' && estado !== 'entregado'"))
})

test('UI · Base de Datos: confirmarYAsignar también distingue confirmar de reasignar', () => {
  const src = fuente(...BASE_DATOS)
  const inicio = src.indexOf('const confirmarYAsignar')
  const cuerpo = src.slice(inicio, inicio + 1200)
  assert.ok(cuerpo.includes('puedeGestionarAsignacion(solicitud.estado)'))
  assert.ok(cuerpo.includes("'reasignar'"))
})

// ─── UI9 · el motorizado actual sigue visible en las 3 superficies ─────────

test('UI9 · el motorizado asignado sigue mostrándose aunque no pueda reasignarse (el nombre no depende de puedeGestionarAsignacion)', () => {
  for (const ruta of [DRAWER, BASE_DATOS]) {
    const src = fuente(...ruta)
    assert.ok(/Motorizado asignado/.test(src), ruta.join('/'))
  }
  // El detalle no usa ese título literal, pero sí sigue leyendo/mostrando
  // asignacion.motorizadoNombre en su propio bloque, sin condicionarlo a
  // puedeGestionarAsignacion.
  const detalle = fuente(...DETALLE)
  assert.ok(detalle.includes('asignacion?.motorizadoNombre') || detalle.includes('asignacion.motorizadoNombre'))
})

// ─── UI10 · el error del backend se muestra, no falla en silencio ─────────

test('UI10 · las 4 superficies siguen usando errorAsignacion() para mostrar el error real del backend (sin silent failure)', () => {
  for (const ruta of [LISTADO, DRAWER, DETALLE, BASE_DATOS]) {
    const src = fuente(...ruta)
    assert.ok(src.includes('errorAsignacion(e)'), ruta.join('/'))
    assert.ok(src.includes('setErr(error.mensaje)') || src.includes('setToast({ type: \'error\', message: error.mensaje })'), ruta.join('/'))
  }
})

// ─── M7 (mutation check conceptual, cubierto por test real) ───────────────
// "backend correcto pero Drawer sigue ofreciendo la acción" — si alguien
// revierte SOLO el guard de render del Drawer (deja puedeGestionarAsignacion
// en el handler pero vuelve al viejo `estado !== 'rechazada' && ...` en el
// JSX), este mismo test de arriba ("usa puedeGestionarAsignacion, no
// esEstadoCerrado ni una lista de negativos") ya lo detecta, porque exige
// la presencia del nuevo gate Y la ausencia del viejo en el MISMO archivo.
