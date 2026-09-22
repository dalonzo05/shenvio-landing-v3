// DRAWER-CONTEXTUAL-1 — view-model del drawer y de su segundo nivel (DEP),
// con los fixtures reales: SH-0005 (DEP-0004 C$90 + DEP-0005 C$910) y el
// tipo C de SH-0003 (DEP-0002 C$80).

import { test } from 'node:test'
import assert from 'node:assert/strict'
import * as DrawerContextual from './drawer-contextual'
import {
  vistaDrawerOrden,
  depositosPorDestinoDeLaOrden,
  contextoDeposito,
  depositoEnRevision,
  motivoNoRevisable,
  permiteVerEnDepositos,
  TEXTO_VER_DEPOSITO,
  TEXTO_VER_FICHA,
  RUTA_DEPOSITOS,
} from './drawer-contextual'
import type { DepositoRegistrado } from './deposito-orden'
import type { EntradaResumenEjecutivo } from './resumen-ejecutivo-orden'

const ADMIN = 'RKTw1pLfK5O8Y3A6IIwDU8J3yr43'
const MOTO = 'juAOhfxi96dlLv8LV3mZwA3cK362'
const SH_0005_ID = 'UgQP6v3w4qnyyU0fO64l'
const NOMBRES = { [ADMIN]: 'Admin Staging', [MOTO]: 'John Pork 2' }

const sh0005 = (): EntradaResumenEjecutivo => ({
  estado: 'entregado',
  tipoCliente: 'contado',
  createdAt: '2026-09-19T21:05:00.000Z',
  entregadoAt: '2026-09-19T21:37:59.131Z',
  ownerSnapshot: { companyName: 'Mariposita' },
  zonaRetiroNombre: 'Metrocentro',
  zonaEntregaNombre: 'Bo Acahualinca',
  asignacion: { motorizadoNombre: 'John Pork 2', motorizadoAuthUid: MOTO, estadoAceptacion: 'aceptada' },
  confirmacion: { precioFinalCordobas: 90 },
  pagoDelivery: { quienPaga: 'entrega', montoSugerido: 90, deducirDelCobroContraEntrega: true, tipo: 'contado' },
  cobroContraEntrega: { aplica: true, monto: 1000 },
  cobrosMotorizado: { delivery: { monto: 90, recibio: true }, producto: { monto: 1000, recibio: true, estado: 'pagado' } },
  cobroDelivery: { estado: 'pagado', formaPago: 'efectivo', monto: 0, montoDelivery: 90, cubiertoPorDeposito: 90 },
  registro: {
    deposito: {
      storkhubDepositoId: 'PZ04OfRT2R9y27cFfaDN', confirmadoStorkhub: true,
      comercioDepositoId: 'oxbOqPxj3RmPKdXahedk', confirmadoComercio: true,
    },
  },
} as EntradaResumenEjecutivo)

const DEP_0004: DepositoRegistrado = {
  id: 'PZ04OfRT2R9y27cFfaDN', codigo: 'DEP-0004', tipo: 'recaudacion_motorizado_storkhub', estado: 'confirmado',
  destinatario: 'storkhub', destinatarioNombre: 'Storkhub', motorizadoUid: MOTO, solicitudIds: [SH_0005_ID],
  montoTotal: 90, boucherVersion: 2, creadoAt: '2026-09-19T21:43:59.645Z',
  confirmadoAt: '2026-09-21T03:50:49.041Z', confirmadoPorUid: ADMIN,
  boucher: { url: 'https://example.test/v2.jpg', pathStorage: 'x' },
}
const DEP_0005: DepositoRegistrado = {
  id: 'oxbOqPxj3RmPKdXahedk', codigo: 'DEP-0005', tipo: 'recaudacion_motorizado_comercio', estado: 'confirmado',
  destinatario: 'comercio', destinatarioNombre: 'Mariposita', motorizadoUid: MOTO, solicitudIds: [SH_0005_ID],
  montoTotal: 910, creadoAt: '2026-09-19T21:44:07.739Z',
  confirmadoAt: '2026-09-21T03:50:49.085Z', confirmadoPorUid: ADMIN,
  boucher: { url: 'https://example.test/b.jpg', pathStorage: 'y' },
}
const DEP_0002: DepositoRegistrado = {
  id: 'a2HgEC7RcMkgREr4HGD1', codigo: 'DEP-0002', tipo: 'pago_delivery_deposito', estado: 'confirmado',
  destinatario: 'storkhub', solicitudIds: ['OZmiYGHAlUBaAzY4yn9I'], montoTotal: 80,
  boucherUrl: 'https://example.test/c.jpg', creadoAt: '2026-09-18T04:20:53.728Z', confirmadoAt: '2026-09-18T04:20:53.728Z',
}
const vista = (opc = {}) => vistaDrawerOrden(sh0005(), {
  depositos: [DEP_0004, DEP_0005],
  depositosPorDestino: { storkhub: DEP_0004, comercio: DEP_0005 },
  nombresActores: NOMBRES,
  nombreMotorizado: 'John Pork 2',
  estadoEtiqueta: 'Entregado',
  ...opc,
})

// ─── RD · el resumen del drawer es el mismo de la ficha ──────────────────────

test('RD1 · SH-0005 muestra el delivery en C$90', () => {
  assert.equal(vista().resumen.cobro.delivery, 'C$ 90')
})

test('RD2 · nunca C$0 como monto del delivery (ese es el pendiente)', () => {
  assert.notEqual(vista().resumen.cobro.delivery, 'C$ 0')
})

test('RD3 · el cobro contra entrega va aparte, en C$1,000', () => {
  const c = vista().resumen.cobro
  assert.equal(c.cobroContraEntrega, 'C$ 1,000')
  assert.equal(c.descontadoDelCE, 'Descontado del cobro contra entrega: C$ 90')
  assert.ok(!JSON.stringify(c).includes('Cubierto con el cobro del producto'))
})

test('RD4 y RD5 · las dos liquidaciones, con su monto y su destino', () => {
  const l = vista().liquidaciones
  assert.deepEqual(l.map((x) => [x.identidad.texto, x.monto]), [['DEP-0004', 90], ['DEP-0005', 910]])
  assert.deepEqual(vista().resumen.liquidaciones.map((x) => [x.codigo, x.destino, x.monto]), [
    ['DEP-0004', 'A StorkHub', 'C$ 90'],
    ['DEP-0005', 'Al comercio (Mariposita)', 'C$ 910'],
  ])
})

test('RD6 · ningún total combinado de C$1,000 en las liquidaciones', () => {
  assert.ok(!JSON.stringify(vista().liquidaciones).includes('1000'))
  assert.ok(!JSON.stringify(vista().resumen.liquidaciones).includes('1,000'))
})

test('RD7 · SH-0005 no tiene pendientes', () => {
  const a = vista().resumen.atencion
  assert.equal(a.hayPendientes, false)
  assert.equal(a.titulo, 'Sin pendientes')
})

test('RD8 · tipo C: C$80, transferencia y StorkHub directo del comercio', () => {
  const sh0003 = {
    estado: 'entregado', tipoCliente: 'contado', ownerSnapshot: { companyName: 'Mariposita' },
    confirmacion: { precioFinalCordobas: 80 }, pagoDelivery: { quienPaga: 'transferencia' },
    cobroContraEntrega: { aplica: false, monto: 0 },
    cobroDelivery: { estado: 'pagado', formaPago: 'transferencia', monto: 80, pagadoAt: '2026-09-18T04:20:53.728Z' },
    asignacion: { motorizadoNombre: 'John Pork 2' },
    registro: { deposito: { storkhubDepositoId: DEP_0002.id, confirmadoStorkhub: true } },
  } as EntradaResumenEjecutivo
  const v = vistaDrawerOrden(sh0003, {
    depositos: [DEP_0002], depositosPorDestino: { storkhub: DEP_0002 },
    nombreMotorizado: 'John Pork 2', estadoEtiqueta: 'Entregado',
  })
  assert.equal(v.resumen.cobro.delivery, 'C$ 80')
  assert.equal(v.resumen.cobro.formaPago, 'transferencia')
  assert.equal(v.resumen.cobro.recibio, 'StorkHub, directo del comercio')
  assert.equal(v.resumen.cobro.cobroContraEntrega, 'No aplica')
  assert.equal(v.resumen.liquidaciones[0].destino, 'A StorkHub, por transferencia del comercio')
})

// ─── DC · el segundo nivel: el depósito ──────────────────────────────────────

test('DC1 · un DEP A/B en revisión ofrece abrir su contexto, mire quien mire', () => {
  const enRevision = { ...DEP_0004, estado: 'en_revision', confirmadoAt: undefined, confirmadoPorUid: undefined }
  assert.equal(depositoEnRevision(enRevision), true)
  assert.equal(motivoNoRevisable(enRevision), null)
  const v = vistaDrawerOrden(sh0005(), { depositos: [enRevision, DEP_0005] })
  assert.deepEqual(v.enRevision, [enRevision.id])
})

test('DC2 · un DEP confirmado no ofrece nada: ya no hay nada que mirar en revisión', () => {
  assert.equal(depositoEnRevision(DEP_0004), false)
  assert.equal(motivoNoRevisable(DEP_0004), 'estado')
  assert.equal(motivoNoRevisable(null), 'sin_deposito')
  assert.deepEqual(vista().enRevision, [])
})

test('DC3 · un DEP devuelto muestra su estado y su motivo, y no queda en revisión', () => {
  const devuelto = {
    ...DEP_0004, estado: 'devuelto', motivoDevolucion: 'Comprobante incorrecto, por favor subir nuevamente.',
    confirmadoAt: undefined, confirmadoPorUid: undefined,
  }
  const c = contextoDeposito(devuelto, null, { nombresActores: NOMBRES })
  assert.equal(c.estado, 'Corrección solicitada')
  assert.equal(c.motivo, 'Comprobante incorrecto, por favor subir nuevamente.')
  assert.equal(depositoEnRevision(devuelto), false)
  assert.equal(c.confirmadoPorUid, null)
})

test('DC4 · el tipo C no entra en la revisión A/B: su corrección es Cobros → Revertir', () => {
  assert.equal(motivoNoRevisable(DEP_0002), 'tipo_c')
  const enRevision = { ...DEP_0002, estado: 'en_revision' }
  assert.equal(depositoEnRevision(enRevision), false)
  const c = contextoDeposito(DEP_0002, null, {})
  assert.equal(c.destino, 'Pago del delivery por transferencia')
})

test('DC5 · el contexto describe el depósito con los campos de su propio documento', () => {
  const c = contextoDeposito(DEP_0004, sh0005() as never, { nombresActores: NOMBRES })
  assert.equal(c.codigo, 'DEP-0004')
  assert.equal(c.estado, 'Confirmado')
  assert.equal(c.monto, 'C$ 90')
  assert.equal(c.destino, 'John Pork 2 → StorkHub')
  assert.equal(c.motorizado, 'John Pork 2')
  assert.equal(c.ordenesIncluidas, 1)
  assert.equal(c.esAgrupado, false)
  assert.equal(c.version, 2)
  assert.equal(c.comprobante, 'https://example.test/v2.jpg')
  assert.equal(c.confirmadoPorUid, ADMIN)
  assert.deepEqual(c.momentos.map((m) => m.etiqueta), ['Enviado', 'Confirmado'])
  assert.equal(c.motivo, null)
})

test('DC6 · con dos depósitos, cada contexto es el suyo', () => {
  const a = contextoDeposito(DEP_0004, null, { nombresActores: NOMBRES })
  const b = contextoDeposito(DEP_0005, null, { nombresActores: NOMBRES })
  assert.notEqual(a.id, b.id)
  assert.deepEqual([a.codigo, a.monto], ['DEP-0004', 'C$ 90'])
  assert.deepEqual([b.codigo, b.monto], ['DEP-0005', 'C$ 910'])
  assert.equal(b.destino, 'John Pork 2 → Mariposita')
})

test('DC7 · navegación: solo la ruta de Depósitos que ya existe, y el copy oficial', () => {
  assert.equal(RUTA_DEPOSITOS, '/panel/gestor/depositos')
  assert.equal(TEXTO_VER_FICHA, 'Ver ficha completa')
})

// ─── COPY · qué promete el drawer compartido, y a quién ──────────────────────
//
// SolicitudDrawer se monta en gestor, comercio, reportes y dashboard. Todo lo
// que diga tiene que ser cierto para los cuatro: el segundo nivel es de solo
// lectura y no aprueba dinero.

test('COPY1 · la acción del segundo nivel se llama "Ver depósito"', () => {
  assert.equal(TEXTO_VER_DEPOSITO, 'Ver depósito')
})

test('COPY2 · ningún copy del drawer compartido promete revisar un depósito', () => {
  const copys = Object.entries(DrawerContextual).filter(([, v]) => typeof v === 'string') as Array<[string, string]>
  assert.ok(copys.length > 0)
  assert.deepEqual(copys.filter(([, v]) => v.toLowerCase().includes('revisar')), [])
  assert.equal('TEXTO_REVISAR_DEPOSITO' in DrawerContextual, false)
})

test('COPY3 · abrir el contexto sigue trayendo el DEP correcto, no otro', () => {
  const enRevision = { ...DEP_0004, estado: 'en_revision', confirmadoAt: undefined, confirmadoPorUid: undefined }
  const deps = [enRevision, DEP_0005]
  const v = vistaDrawerOrden(sh0005(), { depositos: deps, nombresActores: NOMBRES })
  assert.deepEqual(v.enRevision, [enRevision.id])
  const abierto = deps.find((d) => d.id === v.enRevision[0])!
  const c = contextoDeposito(abierto, sh0005() as never, { nombresActores: NOMBRES })
  assert.equal(c.id, DEP_0004.id)
  assert.equal(c.codigo, 'DEP-0004')
  assert.equal(c.monto, 'C$ 90')
})

test('COPY4 · dentro del panel del gestor se ofrece "Ver en Depósitos"', () => {
  assert.equal(permiteVerEnDepositos('/panel/gestor/cobros'), true)
  assert.equal(permiteVerEnDepositos('/panel/gestor/depositos'), true)
  assert.equal(permiteVerEnDepositos('/panel/gestor/solicitudes/abc123'), true)
  assert.equal(permiteVerEnDepositos('/panel/gestor'), true)
})

test('COPY5 · desde Comercio NO se ofrece un enlace a una ruta del gestor', () => {
  assert.equal(permiteVerEnDepositos('/panel/comercio/depositos'), false)
  assert.equal(permiteVerEnDepositos('/panel/motorizado'), false)
  // Fail-closed: sin ruta conocida, no se ofrece.
  assert.equal(permiteVerEnDepositos(null), false)
  assert.equal(permiteVerEnDepositos(undefined), false)
  // Y no alcanza con empezar parecido.
  assert.equal(permiteVerEnDepositos('/panel/gestorx/depositos'), false)
})

// ─── API · nada muerto en el view-model ──────────────────────────────────────

test('API1 · la vista del drawer expone solo lo que la UI consume', () => {
  assert.deepEqual(Object.keys(vista()).sort(), ['enRevision', 'liquidaciones', 'resumen'])
  assert.equal('revisables' in vista(), false)
  assert.equal('puedeRevisarDeposito' in DrawerContextual, false)
})

test('API2 · el contexto del DEP no afirma permisos: no depende del rol', () => {
  const c = contextoDeposito(DEP_0004, null, { nombresActores: NOMBRES })
  assert.equal('puedeRevisar' in c, false)
  // El mismo contexto, sin opciones: idéntico salvo el nombre resuelto.
  const sinOpciones = contextoDeposito(DEP_0004)
  assert.equal(sinOpciones.id, c.id)
  assert.equal(sinOpciones.estado, c.estado)
  assert.equal(sinOpciones.monto, c.monto)
})

// ─── DAW · fuente canónica de los depósitos asociados ────────────────────────
//
// El drawer dejó de mirar los dos punteros de la orden: lee los depósitos que
// la nombran en solicitudIds, igual que la ficha. Estos casos fijan qué
// aparece y cómo queda el índice por destino que usan las líneas de depósito.

const REG_0005 = {
  deposito: {
    storkhubDepositoId: DEP_0004.id, confirmadoStorkhub: true,
    comercioDepositoId: DEP_0005.id, confirmadoComercio: true,
  },
}
const vistaCon = (deps: DepositoRegistrado[], registro: unknown = REG_0005) => vistaDrawerOrden(
  { ...sh0005(), registro } as EntradaResumenEjecutivo,
  {
    depositos: deps,
    depositosPorDestino: depositosPorDestinoDeLaOrden(deps, registro as never),
    nombresActores: NOMBRES, nombreMotorizado: 'John Pork 2', estadoEtiqueta: 'Entregado',
  },
)

test('DAW1 · orden sin depósitos ⇒ lista vacía y sin índice por destino', () => {
  const v = vistaCon([], { deposito: null })
  assert.deepEqual(v.liquidaciones, [])
  assert.deepEqual(v.resumen.liquidaciones, [])
  assert.deepEqual(depositosPorDestinoDeLaOrden([], null), {})
})

test('DAW2 · orden con un solo depósito ⇒ una fila, y esa es la línea de su destino', () => {
  const v = vistaCon([DEP_0004], { deposito: { storkhubDepositoId: DEP_0004.id } })
  assert.equal(v.liquidaciones.length, 1)
  assert.equal(depositosPorDestinoDeLaOrden([DEP_0004], { deposito: { storkhubDepositoId: DEP_0004.id } }).storkhub?.id, DEP_0004.id)
})

test('DAW3 · SH-0005 ⇒ DEP-0004 y DEP-0005, cada uno en su destino', () => {
  const v = vistaCon([DEP_0004, DEP_0005])
  assert.deepEqual(v.liquidaciones.map((l) => l.identidad.texto), ['DEP-0004', 'DEP-0005'])
  const idx = depositosPorDestinoDeLaOrden([DEP_0004, DEP_0005], REG_0005)
  assert.equal(idx.storkhub?.codigo, 'DEP-0004')
  assert.equal(idx.comercio?.codigo, 'DEP-0005')
})

test('DAW4 · tres depósitos asociados ⇒ se muestran los tres, sin tope de dos', () => {
  const DEP_EXTRA: DepositoRegistrado = {
    ...DEP_0004, id: 'dep_extra', codigo: 'DEP-0009', estado: 'anulado',
    creadoAt: '2026-09-19T20:00:00.000Z', confirmadoAt: undefined, confirmadoPorUid: undefined,
  }
  const v = vistaCon([DEP_EXTRA, DEP_0004, DEP_0005])
  assert.equal(v.liquidaciones.length, 3)
  assert.deepEqual(v.liquidaciones.map((l) => l.identidad.texto), ['DEP-0009', 'DEP-0004', 'DEP-0005'])
})

test('DAW5 · un anulado sin puntero sigue en la lista; la línea viva es el vigente', () => {
  const ANULADO: DepositoRegistrado = {
    ...DEP_0004, id: 'dep_anulado', codigo: 'DEP-0008', estado: 'anulado',
    creadoAt: '2026-09-19T20:00:00.000Z', confirmadoAt: undefined, confirmadoPorUid: undefined,
  }
  const deps = [ANULADO, DEP_0004]
  const v = vistaCon(deps, { deposito: { storkhubDepositoId: DEP_0004.id } })
  assert.deepEqual(v.liquidaciones.map((l) => [l.identidad.texto, l.estado]), [['DEP-0008', 'Anulado'], ['DEP-0004', 'Confirmado']])
  // El puntero manda para la línea de StorkHub…
  assert.equal(depositosPorDestinoDeLaOrden(deps, { deposito: { storkhubDepositoId: DEP_0004.id } }).storkhub?.codigo, 'DEP-0004')
  // …y sin puntero se prefiere el último NO anulado.
  assert.equal(depositosPorDestinoDeLaOrden(deps, null).storkhub?.codigo, 'DEP-0004')
  // Si todos están anulados, se muestra el anulado y no se inventa ninguno.
  assert.equal(depositosPorDestinoDeLaOrden([ANULADO], null).storkhub?.codigo, 'DEP-0008')
})

test('DAW6 · un depósito agrupado aparece una sola vez para esta orden', () => {
  const AGRUPADO = { ...DEP_0005, solicitudIds: [SH_0005_ID, 'otra_orden'] }
  const v = vistaCon([AGRUPADO, AGRUPADO, DEP_0004])
  assert.equal(v.liquidaciones.filter((l) => l.identidad.texto === 'DEP-0005').length, 1)
  assert.equal(v.liquidaciones.find((l) => l.identidad.texto === 'DEP-0005')?.esAgrupado, true)
})

test('DAW7 · la lista no suma montos: cada depósito con el suyo', () => {
  const v = vistaCon([DEP_0004, DEP_0005])
  assert.deepEqual(v.liquidaciones.map((l) => l.monto), [90, 910])
  assert.ok(!JSON.stringify(v.liquidaciones).includes('1000'))
  assert.ok(!JSON.stringify(v.resumen.liquidaciones).includes('1,000'))
})

test('DAW8 · el tipo C conserva su presentación y su destino', () => {
  const v = vistaCon([DEP_0002], { deposito: { storkhubDepositoId: DEP_0002.id } })
  assert.equal(v.liquidaciones[0].origenDestino, 'Pago del delivery por transferencia')
  assert.equal(v.resumen.liquidaciones[0].destino, 'A StorkHub, por transferencia del comercio')
  // Y su línea sigue siendo la de StorkHub, como su puntero.
  assert.equal(depositosPorDestinoDeLaOrden([DEP_0002], { deposito: { storkhubDepositoId: DEP_0002.id } }).storkhub?.codigo, 'DEP-0002')
})

test('DAW9 · el contexto se abre con cualquiera de los asociados, no solo con los punteros', () => {
  const SUELTO: DepositoRegistrado = { ...DEP_0004, id: 'dep_suelto', codigo: 'DEP-0010', estado: 'en_revision', confirmadoAt: undefined, confirmadoPorUid: undefined }
  const deps = [DEP_0004, DEP_0005, SUELTO]
  const v = vistaCon(deps)
  assert.ok(v.liquidaciones.some((l) => l.id === SUELTO.id))
  assert.deepEqual(v.enRevision, [SUELTO.id])
  assert.equal(contextoDeposito(deps.find((d) => d.id === SUELTO.id)!, null).codigo, 'DEP-0010')
})
