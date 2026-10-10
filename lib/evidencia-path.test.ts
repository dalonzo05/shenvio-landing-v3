// A4-02 · P1-C — el pathStorage de una evidencia tiene que pertenecer a LA orden.
//
// Estos tests no tocan Storage ni firebase-admin: el helper es puro. Cubren las
// tres puertas que usan el Admin SDK sobre un pathStorage escrito por clientes:
//
//   PATH-*   esPathEvidenciaDeSolicitud y resolverPathEvidencia (lo que usa
//            resolverEvidencia, /api/access/[token]/evidence/[kind])
//   CLEAN-*  extracción de referencias y guard de lib/storage-cleanup.ts
//   contrato el orden de las llamadas en el código real (guard ANTES del
//            download / del delete)

import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import {
  clasificarNombreEvidenciaOperativa,
  esIdSolicitudSeguro,
  esPathEvidenciaDeSolicitud,
  extraerEvidenciaOperativaDeSolicitud,
  resolverPathEvidencia,
} from './evidencia-path'

const S = 'AbC123xyz789SolicitudA'
const OTRA = 'ZzZ999otraSolicitudBBB'

const ok = (kind: string, path: string, solicitud = S) => esPathEvidenciaDeSolicitud(solicitud, kind, path)

// ── PATH ─────────────────────────────────────────────────────────────────────

test('PATH-1 · path correcto de la misma solicitud, para cada kind ⇒ ALLOW', () => {
  assert.equal(ok('retiro', `evidencias/${S}/retiro.jpg`), true)
  assert.equal(ok('entrega', `evidencias/${S}/entrega.jpg`), true)
  assert.equal(ok('terminal_paquete', `evidencias/${S}/terminal_paquete.jpg`), true)
  assert.equal(ok('terminal_ticket', `evidencias/${S}/terminal_ticket.jpg`), true)
  assert.equal(ok('terminal_bus', `evidencias/${S}/terminal_bus.jpg`), true)
  assert.equal(ok('cargotrans_factura', `evidencias/${S}/cargotrans_factura.jpg`), true)
  assert.equal(ok('cargotrans_paquete', `evidencias/${S}/cargotrans_paquete_1.jpg`), true)
  assert.equal(ok('cargotrans_paquete', `evidencias/${S}/cargotrans_paquete_27.jpg`), true)
  assert.equal(ok('delivery_boucher_comercio', `evidencias/${S}/delivery_boucher_comercio.jpg`), true)
  assert.equal(ok('delivery_boucher_gestor', `evidencias/${S}/delivery_boucher_gestor.jpg`), true)
})

test('PATH-2 · path de OTRA solicitud ⇒ DENY (el prefijo "evidencias/" a secas no basta)', () => {
  for (const [kind, nombre] of [['retiro', 'retiro.jpg'], ['entrega', 'entrega.jpg'], ['terminal_bus', 'terminal_bus.jpg'], ['cargotrans_paquete', 'cargotrans_paquete_1.jpg']]) {
    assert.equal(ok(kind, `evidencias/${OTRA}/${nombre}`), false, `${kind} de otra solicitud`)
  }
  // Prefijo parcial: una solicitud cuyo id EMPIEZA con el mío no es la mía.
  assert.equal(ok('retiro', `evidencias/${S}X/retiro.jpg`), false)
  assert.equal(esPathEvidenciaDeSolicitud(S + 'X', 'retiro', `evidencias/${S}/retiro.jpg`), false)
})

test('PATH-3 · depositos/ ⇒ DENY (voucher de depósito: legacy y versionado)', () => {
  assert.equal(ok('retiro', 'depositos/uidMoto/dep1/boucher.jpg'), false)
  assert.equal(ok('entrega', 'depositos/uidMoto/dep1/bouchers/ver00000001AA.jpg'), false)
  assert.equal(ok('retiro', `depositos/${S}/retiro.jpg`), false)
})

test('PATH-4 · saldos/ ⇒ DENY (abonos y propuestas)', () => {
  assert.equal(ok('entrega', 'saldos/saldo1/abono_1.jpg'), false)
  assert.equal(ok('entrega', 'saldos/saldo1/propuestas/p1/comprobante.jpg'), false)
  assert.equal(ok('cargotrans_paquete', 'saldos/saldo1/cargotrans_paquete_1.jpg'), false)
})

test('PATH-5 · liquidaciones/ y motorizados/ ⇒ DENY', () => {
  assert.equal(ok('entrega', 'liquidaciones/liq1/comprobante.pdf'), false)
  assert.equal(ok('retiro', `liquidaciones/${S}/retiro.jpg`), false)
  assert.equal(ok('retiro', 'motorizados/moto1/foto.jpg'), false)
})

test('PATH-6 · traversal y segmentos raros ⇒ DENY', () => {
  const raros = [
    `evidencias/${S}/../${OTRA}/retiro.jpg`,
    `evidencias/${S}/../../depositos/u/d/boucher.jpg`,
    `evidencias/../depositos/u/d/retiro.jpg`,
    `evidencias/${S}/./retiro.jpg`,
    `evidencias//${S}/retiro.jpg`,
    `evidencias/${S}//retiro.jpg`,
    `/evidencias/${S}/retiro.jpg`,
    `evidencias/${S}/retiro.jpg/`,
    `evidencias/${S}/retiro.jpg/extra`,
    `evidencias/${S}/%2e%2e/retiro.jpg`,
    `evidencias/${S}\\retiro.jpg`,
    `evidencias/${S}/retiro.jpg\u0000`,
    `evidencias/${S}/retiro.jpg?alt=media`,
    ` evidencias/${S}/retiro.jpg`,
    `EVIDENCIAS/${S}/retiro.jpg`,
    `gs://bucket/evidencias/${S}/retiro.jpg`,
    `https://firebasestorage.googleapis.com/v0/b/x/o/evidencias%2F${S}%2Fretiro.jpg`,
    '',
    'evidencias/',
    `evidencias/${S}`,
    `evidencias/${S}/`,
  ]
  for (const p of raros) assert.equal(ok('retiro', p), false, JSON.stringify(p))
  // El id de solicitud NO puede colar separadores ni puntos.
  for (const id of ['', '.', '..', 'a/b', 'a\\b', '../x', 'a b', 'a.b', 'x'.repeat(129)]) {
    assert.equal(esIdSolicitudSeguro(id), false, JSON.stringify(id))
    assert.equal(esPathEvidenciaDeSolicitud(id, 'retiro', `evidencias/${id}/retiro.jpg`), false, JSON.stringify(id))
  }
})

test('PATH-7 · basename fuera de la allowlist, subcarpeta o extensión distinta ⇒ DENY', () => {
  for (const nombre of [
    'peaje.jpg', 'deposito.jpg', 'boucher.jpg', 'delivery_boucher.jpg', 'foto.jpg', 'comprobante.pdf',
    'retiro.png', 'retiro.JPG', 'retiro.jpeg', 'Retiro.jpg', 'retiro', '.jpg', 'retiro.jpg.exe',
    'cargotrans_paquete_.jpg', 'cargotrans_paquete_a.jpg', 'cargotrans_paquete_-1.jpg', 'cargotrans_paquete_1.png',
    'cargotrans_paquete_1234567.jpg',
  ]) {
    for (const kind of ['retiro', 'entrega', 'cargotrans_paquete', 'cargotrans_factura']) {
      assert.equal(ok(kind, `evidencias/${S}/${nombre}`), false, `${kind} · ${nombre}`)
    }
  }
  assert.equal(ok('retiro', `evidencias/${S}/sub/retiro.jpg`), false)
  assert.equal(ok('retiro', `evidencias/${S}/cargotrans/retiro.jpg`), false)
})

test('PATH-8 · el kind tiene que corresponder al basename ⇒ DENY si no', () => {
  assert.equal(ok('retiro', `evidencias/${S}/entrega.jpg`), false)
  assert.equal(ok('entrega', `evidencias/${S}/retiro.jpg`), false)
  assert.equal(ok('terminal_bus', `evidencias/${S}/terminal_paquete.jpg`), false)
  assert.equal(ok('cargotrans_factura', `evidencias/${S}/cargotrans_paquete_1.jpg`), false)
  assert.equal(ok('cargotrans_paquete', `evidencias/${S}/cargotrans_factura.jpg`), false)
  assert.equal(ok('delivery_boucher_gestor', `evidencias/${S}/delivery_boucher_comercio.jpg`), false)
  assert.equal(ok('delivery_boucher_comercio', `evidencias/${S}/retiro.jpg`), false)
  // kind inventado, vacío o con nombres heredados del prototipo de Object.
  for (const kind of ['', 'foto', 'constructor', '__proto__', 'toString', 'hasOwnProperty', 'deposito', 'peaje']) {
    assert.equal(ok(kind, `evidencias/${S}/retiro.jpg`), false, JSON.stringify(kind))
  }
})

test('PATH-9 · tipos inesperados fallan cerrado', () => {
  for (const malo of [undefined, null, 0, 1, {}, [], true, ['evidencias', S, 'retiro.jpg']]) {
    assert.equal(esPathEvidenciaDeSolicitud(S, 'retiro', malo), false)
    assert.equal(esPathEvidenciaDeSolicitud(malo, 'retiro', `evidencias/${S}/retiro.jpg`), false)
    assert.equal(esPathEvidenciaDeSolicitud(S, malo, `evidencias/${S}/retiro.jpg`), false)
  }
})

// ── resolverEvidencia (resolverPathEvidencia) ────────────────────────────────

const ordenLimpia = () => ({
  evidencias: {
    retiro: { url: 'https://x/r', pathStorage: `evidencias/${S}/retiro.jpg` },
    entrega: { url: 'https://x/e', pathStorage: `evidencias/${S}/entrega.jpg` },
  },
  evidenciasTerminal: {
    fotoPaquete: { pathStorage: `evidencias/${S}/terminal_paquete.jpg` },
    fotoTicket: { pathStorage: `evidencias/${S}/terminal_ticket.jpg` },
    fotoBus: { pathStorage: `evidencias/${S}/terminal_bus.jpg` },
  },
  evidenciasCargotrans: {
    factura: { pathStorage: `evidencias/${S}/cargotrans_factura.jpg` },
    fotos: [
      { pathStorage: `evidencias/${S}/cargotrans_paquete_1.jpg` },
      { pathStorage: `evidencias/${S}/cargotrans_paquete_2.jpg` },
    ],
  },
  cobroDelivery: {
    boucherVigente: 'gestor',
    boucherGestor: { path: `evidencias/${S}/delivery_boucher_gestor.jpg` },
    boucherComercio: { path: `evidencias/${S}/delivery_boucher_comercio.jpg` },
  },
  asignacion: { motorizadoId: 'moto1' },
})

const KINDS_URL = [
  'retiro', 'entrega', 'terminal-paquete', 'terminal-ticket', 'terminal-bus',
  'cargotrans-factura', 'cargotrans-paquete-1', 'cargotrans-paquete-2', 'delivery-boucher',
]

test('PATH-R1 · una orden consistente se sirve igual que antes, kind por kind', () => {
  const s = ordenLimpia()
  const esperado: Record<string, string> = {
    retiro: `evidencias/${S}/retiro.jpg`,
    entrega: `evidencias/${S}/entrega.jpg`,
    'terminal-paquete': `evidencias/${S}/terminal_paquete.jpg`,
    'terminal-ticket': `evidencias/${S}/terminal_ticket.jpg`,
    'terminal-bus': `evidencias/${S}/terminal_bus.jpg`,
    'cargotrans-factura': `evidencias/${S}/cargotrans_factura.jpg`,
    'cargotrans-paquete-1': `evidencias/${S}/cargotrans_paquete_1.jpg`,
    'cargotrans-paquete-2': `evidencias/${S}/cargotrans_paquete_2.jpg`,
    'delivery-boucher': `evidencias/${S}/delivery_boucher_gestor.jpg`,
    'motorizado-foto': 'motorizados/moto1/foto.jpg',
  }
  for (const [kind, path] of Object.entries(esperado)) {
    assert.deepEqual(resolverPathEvidencia(S, s, kind), { pathStorage: path, contentType: 'image/jpeg' }, kind)
  }
  s.cobroDelivery.boucherVigente = 'comercio'
  assert.equal(resolverPathEvidencia(S, s, 'delivery-boucher')?.pathStorage, `evidencias/${S}/delivery_boucher_comercio.jpg`)
})

test('PATH-R2 · un pathStorage ajeno en el documento NO se resuelve (otra solicitud, depositos, saldos, liquidaciones, motorizados, traversal)', () => {
  const ajenos = [
    `evidencias/${OTRA}/retiro.jpg`,
    'depositos/uidMoto/dep1/boucher.jpg',
    'saldos/saldo1/abono_1.jpg',
    'liquidaciones/liq1/comprobante.pdf',
    'motorizados/moto1/foto.jpg',
    `evidencias/${S}/../${OTRA}/retiro.jpg`,
    `evidencias/${S}/sub/retiro.jpg`,
  ]
  for (const ajeno of ajenos) {
    const s = ordenLimpia()
    s.evidencias.retiro.pathStorage = ajeno
    s.evidencias.entrega.pathStorage = ajeno
    s.evidenciasTerminal.fotoPaquete.pathStorage = ajeno
    s.evidenciasTerminal.fotoTicket.pathStorage = ajeno
    s.evidenciasTerminal.fotoBus.pathStorage = ajeno
    s.evidenciasCargotrans.factura.pathStorage = ajeno
    s.evidenciasCargotrans.fotos[0].pathStorage = ajeno
    s.evidenciasCargotrans.fotos[1].pathStorage = ajeno
    s.cobroDelivery.boucherGestor.path = ajeno
    for (const kind of KINDS_URL) {
      assert.equal(resolverPathEvidencia(S, s, kind), null, `${kind} ← ${ajeno}`)
    }
  }
})

test('PATH-R3 · la url del documento no cambia la decisión; un path inválido no se vuelve válido por traer una url "bonita"', () => {
  const s = ordenLimpia()
  s.evidencias.retiro = {
    url: `https://firebasestorage.googleapis.com/v0/b/b/o/evidencias%2F${S}%2Fretiro.jpg?alt=media&token=t`,
    pathStorage: 'depositos/uidMoto/dep1/boucher.jpg',
  }
  assert.equal(resolverPathEvidencia(S, s, 'retiro'), null)
  // Y al revés: path válido + url arbitraria se resuelve (la url es otro problema, P2).
  s.evidencias.entrega.url = 'https://evil.example/x.jpg'
  assert.equal(resolverPathEvidencia(S, s, 'entrega')?.pathStorage, `evidencias/${S}/entrega.jpg`)
})

test('PATH-R4 · evidencia de OTRA solicitud servida bajo mi token: el id de la solicitud viene del token, no del documento', () => {
  const s = ordenLimpia()
  // El mismo documento, preguntado como si fuera la solicitud B, no resuelve nada.
  for (const kind of KINDS_URL) assert.equal(resolverPathEvidencia(OTRA, s, kind), null, kind)
})

test('PATH-R5 · delivery-boucher: el vigente decide y el basename tiene que ser el de ese actor', () => {
  const s = ordenLimpia()
  s.cobroDelivery.boucherVigente = 'gestor'
  s.cobroDelivery.boucherGestor.path = `evidencias/${S}/delivery_boucher_comercio.jpg` // actor cruzado
  assert.equal(resolverPathEvidencia(S, s, 'delivery-boucher'), null)
  s.cobroDelivery.boucherVigente = 'otro'
  assert.equal(resolverPathEvidencia(S, s, 'delivery-boucher'), null)
})

test('PATH-R6 · motorizado-foto: solo un doc-id de un segmento; nada de traversal; kinds desconocidos ⇒ null', () => {
  for (const id of ['../depositos/u', 'a/b', '..', '', 'a.b', 5, null, undefined, {}]) {
    const s = { asignacion: { motorizadoId: id } }
    assert.equal(resolverPathEvidencia(S, s, 'motorizado-foto'), null, JSON.stringify(id))
  }
  assert.equal(resolverPathEvidencia(S, {}, 'motorizado-foto'), null)
  for (const kind of ['', 'foto', 'cargotrans-paquete-', 'cargotrans-paquete-x', 'cargotrans-paquete-1/../x', '../retiro', 'RETIRO']) {
    assert.equal(resolverPathEvidencia(S, ordenLimpia(), kind), null, JSON.stringify(kind))
  }
  // Datos ausentes o malformados no lanzan.
  for (const malo of [{}, { evidencias: null }, { evidencias: { retiro: 'https://x' } }, { evidenciasCargotrans: { fotos: 'no' } }]) {
    assert.equal(resolverPathEvidencia(S, malo as never, 'retiro'), null)
    assert.equal(resolverPathEvidencia(S, malo as never, 'cargotrans-paquete-1'), null)
  }
})

test('PATH-R7 · cargotrans-paquete-N: el índice de la galería no tiene que coincidir con el número del archivo (limpiar un paquete desplaza el arreglo)', () => {
  const s = ordenLimpia()
  s.evidenciasCargotrans.fotos = [{ pathStorage: `evidencias/${S}/cargotrans_paquete_2.jpg` }]
  assert.equal(resolverPathEvidencia(S, s, 'cargotrans-paquete-1')?.pathStorage, `evidencias/${S}/cargotrans_paquete_2.jpg`)
  assert.equal(resolverPathEvidencia(S, s, 'cargotrans-paquete-2'), null)
})

// ── CLEAN ────────────────────────────────────────────────────────────────────

test('CLEAN-1 · path correcto de la misma solicitud ⇒ elegible: se extrae y puede borrarse', () => {
  const refs = extraerEvidenciaOperativaDeSolicitud(S, ordenLimpia())
  assert.deepEqual(
    refs.map((r) => `${r.kind}:${r.pathStorage.replace(`evidencias/${S}/`, '')}`).sort(),
    [
      'cargotrans_factura:cargotrans_factura.jpg',
      'cargotrans_paquete:cargotrans_paquete_1.jpg',
      'cargotrans_paquete:cargotrans_paquete_2.jpg',
      'entrega:entrega.jpg',
      'retiro:retiro.jpg',
      'terminal_bus:terminal_bus.jpg',
      'terminal_paquete:terminal_paquete.jpg',
      'terminal_ticket:terminal_ticket.jpg',
    ],
  )
  for (const r of refs) assert.equal(esPathEvidenciaDeSolicitud(S, r.kind, r.pathStorage), true)
})

test('CLEAN-2 · path de OTRA solicitud ⇒ no se extrae ni pasa el guard: no se borra', () => {
  const s = ordenLimpia()
  s.evidencias.retiro.pathStorage = `evidencias/${OTRA}/retiro.jpg`
  s.evidenciasCargotrans.fotos[0].pathStorage = `evidencias/${OTRA}/cargotrans_paquete_1.jpg`
  const refs = extraerEvidenciaOperativaDeSolicitud(S, s)
  assert.equal(refs.some((r) => r.kind === 'retiro'), false)
  assert.equal(refs.filter((r) => r.kind === 'cargotrans_paquete').length, 1)
  assert.equal(esPathEvidenciaDeSolicitud(S, 'retiro', `evidencias/${OTRA}/retiro.jpg`), false)
})

test('CLEAN-3 · path de depósito (y de cualquier namespace financiero) con basename "válido" ⇒ no se borra', () => {
  // Mismo basename que la allowlist, distinto directorio: lo que el viejo
  // classifyFilename(basename(path)) aceptaba.
  for (const p of ['depositos/uidMoto/dep1/retiro.jpg', 'depositos/uidMoto/dep1/bouchers/entrega.jpg', 'saldos/s1/terminal_bus.jpg', 'liquidaciones/l1/cargotrans_factura.jpg']) {
    assert.ok(clasificarNombreEvidenciaOperativa(p.split('/').pop()!) !== null, 'el basename SÍ está en la allowlist')
    const s = { evidencias: { retiro: { pathStorage: p }, entrega: { pathStorage: p } }, evidenciasTerminal: { fotoBus: { pathStorage: p } }, evidenciasCargotrans: { factura: { pathStorage: p }, fotos: [{ pathStorage: p }] } }
    assert.deepEqual(extraerEvidenciaOperativaDeSolicitud(S, s), [], p)
    for (const kind of ['retiro', 'entrega', 'terminal_bus', 'cargotrans_factura', 'cargotrans_paquete']) {
      assert.equal(esPathEvidenciaDeSolicitud(S, kind, p), false, `${kind} ← ${p}`)
    }
  }
})

test('CLEAN-4 · traversal ⇒ no se borra', () => {
  const p = `evidencias/${S}/../${OTRA}/retiro.jpg`
  const s = { evidencias: { retiro: { pathStorage: p }, entrega: { pathStorage: `evidencias/${S}/../../depositos/u/d/entrega.jpg` } } }
  assert.deepEqual(extraerEvidenciaOperativaDeSolicitud(S, s), [])
  assert.equal(esPathEvidenciaDeSolicitud(S, 'retiro', p), false)
  assert.deepEqual(extraerEvidenciaOperativaDeSolicitud(S, {}), [])
  assert.deepEqual(extraerEvidenciaOperativaDeSolicitud(S, { evidenciasCargotrans: { fotos: [null, 5, {}, { pathStorage: 7 }] } }), [])
})

test('CLEAN-5 · nunca lee evidencias.deposito ni campos financieros', () => {
  const s = {
    evidencias: { deposito: { pathStorage: `evidencias/${S}/deposito.jpg` } },
    cobroDelivery: { boucherGestor: { path: `evidencias/${S}/delivery_boucher_gestor.jpg` } },
  }
  assert.deepEqual(extraerEvidenciaOperativaDeSolicitud(S, s), [])
  assert.equal(clasificarNombreEvidenciaOperativa('deposito.jpg'), null)
  assert.equal(clasificarNombreEvidenciaOperativa('delivery_boucher_gestor.jpg'), null)
})

// ── Contratos del código real ────────────────────────────────────────────────

const RAIZ = join(__dirname, '..')
const leer = (...ruta: string[]) => readFileSync(join(RAIZ, ...ruta), 'utf8').replace(/\r/g, '')
const sinComentarios = (s: string) => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '')

test('contrato · storage-cleanup valida el path de la orden ANTES de cada file.delete()', () => {
  const src = sinComentarios(leer('lib', 'storage-cleanup.ts'))
  const guard = "esPathEvidenciaDeSolicitud(stored.solicitudId, stored.kind, stored.pathStorage)"
  const usos = src.split(guard).length - 1
  assert.equal(usos, 2, 'guard en el recovery y en el flujo principal')
  const iDelete = src.indexOf('await file.delete()')
  assert.ok(iDelete > 0)
  assert.ok(src.lastIndexOf(guard, iDelete) > 0 && src.lastIndexOf(guard, iDelete) < iDelete, 'el guard precede al delete')
  assert.ok(src.indexOf("skip('invalid_path')") > 0, 'se reporta como invalid_path')
  // Y las referencias vigentes se extraen contra la solicitud (no solo por basename).
  assert.ok(!/extractEvidenciaOperativa\(data\)|extractEvidenciaOperativa\(dataMcf\)/.test(src))
  assert.ok(/return extraerEvidenciaOperativaDeSolicitud\(solicitudId, data\)/.test(src), 'la extracción se acota a la solicitud')
})

test('contrato · resolverEvidencia delega en el helper con el id de la solicitud; la ruta lo pasa desde el token', () => {
  const ta = sinComentarios(leer('lib', 'temporary-access.ts'))
  assert.ok(/export function resolverEvidencia\(solicitudId: string,/.test(ta))
  assert.ok(/return resolverPathEvidencia\(solicitudId, s, kind\)/.test(ta))
  assert.ok(!/s\.evidencias\??\.(retiro|entrega)\??\.pathStorage/.test(ta), 'ya no lee pathStorage a mano')
  const ruta = sinComentarios(leer('app', 'api', 'access', '[token]', 'evidence', '[kind]', 'route.ts'))
  const iResolver = ruta.indexOf('resolverEvidencia(acceso.solicitudId,')
  const iDownload = ruta.indexOf('.download()')
  assert.ok(iResolver > 0 && iDownload > iResolver, 'el path se resuelve y valida antes del download')
})
