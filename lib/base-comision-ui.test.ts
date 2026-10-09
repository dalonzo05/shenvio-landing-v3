// PRECIO-CONFIRMADO-ANTES-DE-OPERAR-1 — la base de comisión manual en las pantallas del gestor: cuándo aparece, que empiece vacía, que se exija y cómo viaja.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { necesitaBaseManual, parseBaseManual, errorBaseManual, MSG_BASE_REQUERIDA, MSG_BASE_SUPERA_PRECIO, MSG_BASE_INVALIDA } from './base-comision-ui'

const src = (p: string) => readFileSync(join(process.cwd(), p), 'utf8').replace(/\r\n/g, '\n')
const PANTALLAS = [
  'app/panel/gestor/solicitudes/page.tsx',
  'app/panel/gestor/_components/SolicitudDrawer.tsx',
  'app/panel/gestor/solicitudes/[id]/page.tsx',
  'app/panel/gestor/base-datos/page.tsx',
]

test('BC1 · el campo aparece SOLO cuando el servidor no puede derivar la base (viaje anterior sin distancia, fuera del tarifario)', () => {
  const pend = { estado: 'pendiente_confirmacion' }
  assert.equal(necesitaBaseManual({ ...pend, cotizacion: { distanciaKm: 13.859 }, precioDesglose: { deliveryBase: 150 } }, false), false) // cotización automática normal
  assert.equal(necesitaBaseManual({ ...pend, cotizacion: { distanciaKm: 13.859 } }, false), false)                                         // borrador con distancia
  assert.equal(necesitaBaseManual({ ...pend, cotizacion: { distanciaKm: null, fuentePrecio: 'viaje_anterior' } }, false), true)             // viaje anterior
  assert.equal(necesitaBaseManual({ ...pend, cotizacion: { distanciaKm: 80 } }, false), true)                                              // fuera del tarifario
  assert.equal(necesitaBaseManual({ ...pend }, false), true)                                                                                 // sin cotización alguna
  assert.equal(necesitaBaseManual(null, false), false)
  assert.equal(necesitaBaseManual(undefined, true), false)
})

test('BC2 · una orden con precio y base ya confirmados no la vuelve a pedir, salvo que se edite el precio', () => {
  const o = { estado: 'confirmada', cotizacion: { distanciaKm: null }, confirmacion: { precioFinalCordobas: 260, comisionBaseCordobas: 210, comisionBaseOrigen: 'manual_gestor' } }
  assert.equal(necesitaBaseManual(o, false), false)
  assert.equal(necesitaBaseManual(o, true), true)   // editar el precio vuelve a resolver la base
  // anterior al snapshot: derivable → nada; no derivable → se pide
  assert.equal(necesitaBaseManual({ estado: 'confirmada', cotizacion: { distanciaKm: 21.759 }, confirmacion: { precioFinalCordobas: 260 } }, false), false)
  assert.equal(necesitaBaseManual({ estado: 'confirmada', cotizacion: { distanciaKm: null }, confirmacion: { precioFinalCordobas: 260 } }, false), true)
})

test('BC3 · la base es obligatoria, numérica, > 0 y <= precio final; nunca se autocompleta', () => {
  assert.equal(errorBaseManual('', 260), MSG_BASE_REQUERIDA)
  assert.equal(MSG_BASE_REQUERIDA, 'Ingresá la base de comisión (sin recargos) antes de confirmar.')
  for (const t of ['0', '-5', 'abc', 'NaN', 'Infinity']) assert.equal(errorBaseManual(t, 260), MSG_BASE_INVALIDA, t)
  assert.equal(errorBaseManual('300', 260), MSG_BASE_SUPERA_PRECIO)
  assert.equal(errorBaseManual('210', 260), null)
  assert.equal(errorBaseManual('260', 260), null)
  assert.equal(errorBaseManual('70', 150), null)
  assert.equal(parseBaseManual('210'), 210)
  assert.equal(parseBaseManual('210,5'), 210.5)
  assert.equal(parseBaseManual(''), undefined)
  assert.equal(parseBaseManual('0'), undefined)
})

test('BC4 · las 4 pantallas usan el MISMO componente y helper, el campo nace vacío y se valida antes de llamar al servidor', () => {
  for (const p of PANTALLAS) {
    const s = src(p)
    assert.ok(/import \{ BaseComisionManual \} from/.test(s), `${p} importa el componente compartido`)
    assert.ok(/necesitaBaseManual, errorBaseManual, parseBaseManual/.test(s), `${p} usa los helpers compartidos`)
    assert.ok(/const \[baseManual, setBaseManual\] = useState\(''\)/.test(s), `${p}: la base manual empieza VACÍA`)
    assert.ok(!/setBaseManual\(\s*(precioFinal|String\(precioFinal|precioInicial)/.test(s), `${p}: NO se precarga con el precio final`)
    assert.ok(/<BaseComisionManual /.test(s), `${p} renderiza el campo`)
    assert.ok(/errorBaseManual\(baseManual, precioFinal\)/.test(s), `${p} valida antes de confirmar`)
    assert.ok(/pideBase \? parseBaseManual\(baseManual\) : undefined/.test(s), `${p} envía la base SOLO cuando se pide`)
  }
})

test('BC5 · el componente no se precarga y solo se muestra cuando corresponde; guardarAsignacion manda la base solo en confirmar', () => {
  const c = src('app/panel/gestor/_components/BaseComisionManual.tsx')
  assert.ok(/if \(!necesitaBaseManual\(solicitud, precioEditado\)\) return null/.test(c))
  assert.ok(!/defaultValue|value=\{precioFinal/.test(c), 'el input solo refleja lo que escribe el gestor')
  assert.ok(/sin recargos/i.test(c))
  const g = src('lib/asignacion-cliente.ts')
  assert.ok(/operacion === 'confirmar' && comisionBaseManual !== undefined \? \{ comisionBaseManualCordobas: comisionBaseManual \}/.test(g))
})

test('BC6 · reasignar y sugerido de las pantallas NO mandan base manual', () => {
  for (const p of PANTALLAS) {
    const s = src(p)
    for (const m of s.matchAll(/guardarAsignacion\([^)]*'(reasignar|sugerido)'[^)]*\)/g)) assert.ok(!/baseManual|parseBaseManual/.test(m[0]), `${p}: ${m[0]}`)
  }
})

test('BC7 · la ganancia del motorizado sale de la base aprobada por el servidor y se marca como estimada mientras no exista', () => {
  const s = src('app/panel/motorizado/page.tsx')
  assert.ok(/const baseGanancia = \(o: Solicitud\): number \| null => o\.confirmacion\?\.comisionBaseCordobas \?\? o\.precioDesglose\?\.deliveryBase \?\? null/.test(s))
  assert.ok(/const gananciaEsEstimada = \(o: Solicitud\): boolean => o\.confirmacion\?\.comisionBaseCordobas == null/.test(s))
  assert.ok(!/precioDesglose\?\.deliveryBase \?\? o\.confirmacion\?\.precioFinalCordobas/.test(s), 'ya no suma el precio final como ganancia')
  assert.ok(/\(estimada\)/.test(s))
})
