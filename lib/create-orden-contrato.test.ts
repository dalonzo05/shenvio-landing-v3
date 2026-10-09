// CREATE-AUTHORITY-ORDEN-1 — contrato del CREATE de solicitudes_envio: las listas de firestore.rules y los payloads REALES de los dos creadores.
//
// El CREATE es una allowlist (request.resource.data.keys().hasOnly([...]) más una lista por cada mapa anidado). Estas pruebas leen el código fuente de las dos pantallas
// que crean órdenes —comercio/solicitar/_page.tsx e ingresar-orden/page.tsx—, extraen las claves que de verdad envían y las comparan con las listas de las Rules:
//   · si una pantalla empieza a enviar una clave que las Rules no admiten, el create real se rompería: la prueba falla;
//   · si alguien agrega una clave a las Rules que ninguna pantalla envía, también falla: cada clave admitida tiene que tener un dueño y una decisión explícita.
// Límite documentado: la extracción es un análisis léxico del literal del addDoc (sin ejecutar la pantalla); recargoZona no es un literal —viene de calcularRecargoZona—,
// así que sus claves se comparan con el tipo RecargoZona de lib/recargoZona.ts.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const src = (p: string) => readFileSync(join(process.cwd(), p), 'utf8').replace(/\r\n/g, '\n')
const PANTALLAS = ['app/panel/comercio/solicitar/_page.tsx', 'app/panel/gestor/ingresar-orden/page.tsx']

// ── análisis léxico mínimo ──────────────────────────────────────────────────

/** Salta un string, template o comentario que empieza en i; devuelve el índice siguiente (o i si no empieza ninguno). */
function saltar(t: string, i: number): number {
  const c = t[i]
  if (c === '/' && t[i + 1] === '/') { const j = t.indexOf('\n', i); return j < 0 ? t.length : j }
  if (c === '/' && t[i + 1] === '*') { const j = t.indexOf('*/', i + 2); return j < 0 ? t.length : j + 2 }
  if (c === "'" || c === '"') { let j = i + 1; while (j < t.length && t[j] !== c) j += t[j] === '\\' ? 2 : 1; return j + 1 }
  if (c === '`') {
    let j = i + 1
    while (j < t.length && t[j] !== '`') {
      if (t[j] === '\\') { j += 2; continue }
      if (t[j] === '$' && t[j + 1] === '{') { let d = 1; j += 2; while (j < t.length && d > 0) { const k = saltar(t, j); if (k !== j) { j = k; continue } if (t[j] === '{') d++; else if (t[j] === '}') d--; j++ } continue }
      j++
    }
    return j + 1
  }
  return i
}

/** Dado el índice de una '{', devuelve el índice de su '}' pareja. */
function cerrar(t: string, abre: number): number {
  let d = 0
  for (let i = abre; i < t.length;) {
    const k = saltar(t, i); if (k !== i) { i = k; continue }
    if (t[i] === '{') d++
    else if (t[i] === '}') { d--; if (d === 0) return i }
    i++
  }
  throw new Error('llave sin cerrar')
}

/** Parte un texto en elementos separados por comas de nivel 0 (fuera de (), [], {} y strings). */
function elementos(t: string): string[] {
  const out: string[] = []; let d = 0; let ini = 0
  for (let i = 0; i < t.length;) {
    const k = saltar(t, i); if (k !== i) { i = k; continue }
    const c = t[i]
    if (c === '(' || c === '[' || c === '{') d++
    else if (c === ')' || c === ']' || c === '}') d--
    else if (c === ',' && d === 0) { out.push(t.slice(ini, i)); ini = i + 1 }
    i++
  }
  out.push(t.slice(ini))
  return out.map((e) => e.replace(/\/\/[^\n]*/g, '').trim()).filter(Boolean)
}

/** Los literales de objeto más externos de una expresión (sirve para ternarios y spreads). */
function literales(expr: string): string[] {
  const out: string[] = []
  for (let i = 0; i < expr.length;) {
    const k = saltar(expr, i); if (k !== i) { i = k; continue }
    if (expr[i] === '{') { const j = cerrar(expr, i); out.push(expr.slice(i + 1, j)); i = j + 1; continue }
    i++
  }
  return out
}

/** Propiedades de un literal de objeto (contenido sin llaves): clave → texto del valor ('' si es shorthand). Los spreads aportan las propiedades de sus literales. */
function propiedades(contenido: string): Map<string, string> {
  const m = new Map<string, string>()
  for (const el of elementos(contenido)) {
    if (el.startsWith('...')) { for (const lit of literales(el)) for (const [k, v] of propiedades(lit)) m.set(k, v); continue }
    const mt = el.match(/^([A-Za-z_$][\w$]*)\s*(:|$)/)
    if (!mt) continue
    m.set(mt[1], mt[2] === ':' ? el.slice(el.indexOf(':') + 1).trim() : '')
  }
  return m
}

/** Unión de las propiedades de TODOS los literales más externos de una expresión (ternarios con dos ramas, etc.). */
function clavesDe(expr: string): Set<string> {
  const s = new Set<string>()
  for (const lit of literales(expr)) for (const k of propiedades(lit).keys()) s.add(k)
  return s
}

function payloadDe(pantalla: string): Map<string, string> {
  const t = src(pantalla)
  const marca = "addDoc(collection(db, 'solicitudes_envio'), {"
  const i = t.indexOf(marca)
  assert.ok(i >= 0, `${pantalla}: no encontré el addDoc de solicitudes_envio`)
  assert.equal(t.indexOf(marca, i + 1), -1, `${pantalla}: hay más de un addDoc de solicitudes_envio`)
  const abre = i + marca.length - 1
  return propiedades(t.slice(abre + 1, cerrar(t, abre)))
}

// ── las listas de las Rules ─────────────────────────────────────────────────

const reglas = src('firestore.rules')
const sinComentarios = (t: string) => t.replace(/\/\/[^\n]*/g, '')
const lista = (t: string): string[] => [...t.matchAll(/'([^']+)'/g)].map((m) => m[1])
function cuerpoFuncion(nombre: string): string {
  const i = reglas.indexOf(`function ${nombre}(`)
  assert.ok(i >= 0, `firestore.rules: no existe function ${nombre}()`)
  const abre = reglas.indexOf('{', i)
  return sinComentarios(reglas.slice(abre, cerrar(reglas, abre) + 1))
}
const permitidasTop = lista(cuerpoFuncion('creacionSoloClavesPermitidas').match(/hasOnly\(\[([\s\S]*?)\]\)/)![1])
const cuerpoMapas = cuerpoFuncion('creacionMapasSoloClavesPermitidas')
const anidada = (patron: RegExp, nombre: string): string[] => { const m = cuerpoMapas.match(patron); assert.ok(m, `firestore.rules: falta la allowlist anidada de ${nombre}`); return lista(m![1]) }
const permitidasAnidadas: Record<string, string[]> = {
  ownerSnapshot: anidada(/d\.get\('ownerSnapshot', \{\}\)\.keys\(\)\.hasOnly\(\[([^\]]*)\]\)/, 'ownerSnapshot'),
  cotizacion: anidada(/d\.get\('cotizacion', \{\}\)\.keys\(\)\.hasOnly\(\[([^\]]*)\]\)/, 'cotizacion'),
  recoleccion: anidada(/d\.get\('recoleccion', \{\}\)\.keys\(\)\.hasOnly\(\[([^\]]*)\]\)/, 'recoleccion'),
  entrega: anidada(/d\.get\('entrega', \{\}\)\.keys\(\)\.hasOnly\(\[([^\]]*)\]\)/, 'entrega'),
  cobroContraEntrega: anidada(/d\.get\('cobroContraEntrega', \{\}\)\.keys\(\)\.hasOnly\(\[([^\]]*)\]\)/, 'cobroContraEntrega'),
  pagoDelivery: anidada(/d\.get\('pagoDelivery', \{\}\)\.keys\(\)\.hasOnly\(\[([^\]]*)\]\)/, 'pagoDelivery'),
  recargoZona: anidada(/d\.get\('recargoZona', \{\}\)\.keys\(\)\.hasOnly\(\[([^\]]*)\]\)/, 'recargoZona'),
  fueraManagua: anidada(/d\.get\('fueraManagua', \{\}\)\.keys\(\)\.hasOnly\(\[([^\]]*)\]\)/, 'fueraManagua'),
  paquete: anidada(/paq\.keys\(\)\.hasOnly\(\[([^\]]*)\]\)/, 'paquete'),
  precioDesglose: anidada(/desg\.keys\(\)\.hasOnly\(\[([^\]]*)\]\)/, 'precioDesglose'),
  programado: anidada(/prog\.keys\(\)\.hasOnly\(\[([^\]]*)\]\)/, 'programado'),
}
const permitidasSubProgramado = anidada(/prog\.retiro\.keys\(\)\.hasOnly\(\[([^\]]*)\]\)/, 'programado.retiro')

const orden = (a: Iterable<string>) => [...a].sort()

test('CC1 · el parser extrae las claves esperadas del addDoc (control del propio análisis)', () => {
  const p = payloadDe(PANTALLAS[0])
  for (const k of ['comercioId', 'userId', 'comercioUid', 'ownerSnapshot', 'cotizacion', 'recoleccion', 'entrega', 'pagoDelivery', 'precioDesglose', 'fueraManagua', 'createdAt', 'estado']) assert.ok(p.has(k), `payload comercio: ${k}`)
  assert.ok(payloadDe(PANTALLAS[1]).has('creadoInternamente') && payloadDe(PANTALLAS[1]).has('creadoPorGestorUid'))
  assert.ok(permitidasTop.length >= 30, 'se leyó la allowlist de las Rules')
})

test('CC2 · cada clave top-level que ENVÍA una pantalla está en la allowlist del CREATE (si no, el create real se rompería)', () => {
  for (const pantalla of PANTALLAS) {
    const faltan = [...payloadDe(pantalla).keys()].filter((k) => !permitidasTop.includes(k))
    assert.deepEqual(faltan, [], `${pantalla} envía claves que firestore.rules rechazaría al crear: ${faltan.join(', ')}`)
  }
})

test('CC3 · cada clave de la allowlist top-level la envía al menos una pantalla (no hay claves admitidas sin dueño)', () => {
  const enviadas = new Set([...PANTALLAS.flatMap((p) => [...payloadDe(p).keys()])])
  const huerfanas = permitidasTop.filter((k) => !enviadas.has(k))
  assert.deepEqual(huerfanas, [], `claves admitidas por las Rules que ninguna pantalla envía: ${huerfanas.join(', ')}`)
})

test('CC4 · MAPAS ANIDADOS: las claves que envía cada pantalla dentro de cada mapa están en su allowlist, y cada clave admitida la envía alguna pantalla', () => {
  for (const [mapa, permitidas] of Object.entries(permitidasAnidadas)) {
    if (mapa === 'recargoZona') continue // no es un literal: ver CC5
    const enviadas = new Set<string>()
    for (const pantalla of PANTALLAS) {
      const valor = payloadDe(pantalla).get(mapa)
      assert.ok(valor !== undefined, `${pantalla}: no envía ${mapa}`)
      for (const k of clavesDe(valor!)) enviadas.add(k)
    }
    assert.deepEqual(orden(enviadas).filter((k) => !permitidas.includes(k)), [], `${mapa}: claves enviadas que las Rules rechazarían`)
    assert.deepEqual(permitidas.filter((k) => !enviadas.has(k)), [], `${mapa}: claves admitidas que ninguna pantalla envía`)
  }
})

test('CC5 · recargoZona: sus claves son las del tipo RecargoZona (lib/recargoZona.ts) y nada más', () => {
  const tipo = src('lib/recargoZona.ts').match(/export type RecargoZona =([\s\S]*?)\n\nconst /)![1]
  const claves = new Set([...tipo.matchAll(/\b([a-zA-Z]+)\s*:/g)].map((m) => m[1]))
  assert.deepEqual(orden(claves), orden(permitidasAnidadas.recargoZona))
  for (const p of PANTALLAS) assert.ok(/recargoZona: recargoFinal,/.test(src(p)), `${p} envía recargoZona desde calcularRecargoZona`)
})

test('CC6 · programado: sus submapas retiro y entrega usan la allowlist de fecha/hora/fechaHoraISO', () => {
  for (const pantalla of PANTALLAS) {
    const prog = payloadDe(pantalla).get('programado')!
    const [lit] = literales(prog)
    const props = propiedades(lit)
    for (const sub of ['retiro', 'entrega']) {
      const claves = clavesDe(props.get(sub)!)
      assert.deepEqual(orden(claves), orden(permitidasSubProgramado), `${pantalla}: programado.${sub}`)
    }
  }
})

test('CC7 · los campos de servidor NO están en la allowlist (ni top-level ni dentro de mapas): lo que un create jamás debe traer', () => {
  const servidor = [
    'confirmacion', 'asignacion', 'entregadoAt', 'historial', 'ultimoRechazoMotorizado', 'cobrosMotorizado', 'cobroDelivery', 'cobroPendiente', 'registro',
    'storkhubDepositoId', 'comercioDepositoId', 'evidencias', 'evidenciasTerminal', 'evidenciasCargotrans', 'acumulacionCobroSemanal', 'codigo', 'secuencia', 'updatedAt',
  ]
  for (const c of servidor) assert.ok(!permitidasTop.includes(c), `la allowlist top-level no debe admitir ${c}`)
  assert.ok(!permitidasAnidadas.fueraManagua.includes('efectivoRecibidoMotorizado'), 'efectivoRecibidoMotorizado lo escribe el servidor')
  for (const [mapa, claves] of Object.entries(permitidasAnidadas)) for (const k of claves) assert.ok(!/confirmad|pagad|recibio|comisionBase|precioFinal|estado/i.test(k), `${mapa}.${k} parece un hecho de servidor`)
})

test('CC8 · la protección de A2 sigue en el CREATE (confirmacion, entregadoAt, historial.entregadoAt) y las dos reglas nuevas conviven con ella', () => {
  const create = reglas.slice(reglas.indexOf('allow create: if isActiveUser()'), reglas.indexOf('sinCodigoEntrante();', reglas.indexOf('allow create: if isActiveUser()')))
  for (const f of ['creacionSoloClavesPermitidas()', 'nacimientoSinAsignacion()', 'creacionSinAutoridadDeServidor()', 'creacionMapasSoloClavesPermitidas()', 'creacionMetadataDeStaff()', 'creacionDuenoValido()']) assert.ok(create.includes(f), `allow create usa ${f}`)
  assert.ok(/!\('confirmacion' in request\.resource\.data\)/.test(reglas) && /!\('entregadoAt' in request\.resource\.data\)/.test(reglas))
})
