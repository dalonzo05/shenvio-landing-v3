// COMERCIO-PAGOS-PRE-ENTREGA (A5-02) — el boucher que el comercio sube ANTES de la entrega sobrevive a confirmarTransicionConCobro.
//
// Se ejecuta el constructor REAL del cobroDelivery de la entrega (construirCobroDelivery, el mismo que llama la callable) y, para la
// revisión del gestor, el evaluador REAL de registrarCobroDelivery (evaluarOrdenParaCobro).
import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { DocumentData } from 'firebase-admin/firestore';
import { construirCobroDelivery, conservarBoucherPrevio } from '../src/cobro-delivery-entrega';
import { evaluarOrdenParaCobro } from '../src/registrar-cobro-delivery';

const AT = { __ts: 1 };
const BOUCHER_COMERCIO = { url: 'https://example.test/c.jpg', path: 'evidencias/o1/delivery_boucher_comercio.jpg', at: AT };
const BOUCHER_GESTOR = { url: 'https://example.test/g.jpg', path: 'evidencias/o1/delivery_boucher_gestor.jpg', at: AT };

const ordenTransferencia = (extra: DocumentData = {}): DocumentData => ({
  estado: 'en_camino_entrega',
  tipoCliente: 'contado',
  confirmacion: { precioFinalCordobas: 110 },
  pagoDelivery: { quienPaga: 'transferencia' },
  cobroDelivery: { estado: 'en_revision_deposito', boucherComercio: BOUCHER_COMERCIO, boucherVigente: 'comercio' },
  ...extra,
});

const claves = (o: Record<string, unknown>) => Object.keys(o).sort();

// ── PRE-1..PRE-5 · el caso obligatorio ──────────────────────────────────────────────────────────────
test('PRE-1 · boucher pre-entrega + en_revision_deposito + entrega → boucherComercio preservado', () => {
  const cd = construirCobroDelivery(ordenTransferencia(), null, null);
  assert.deepEqual(cd.boucherComercio, BOUCHER_COMERCIO);
});

test('PRE-2 · boucherVigente preservado', () => {
  assert.equal(construirCobroDelivery(ordenTransferencia(), null, null).boucherVigente, 'comercio');
  const gestor = ordenTransferencia({ cobroDelivery: { estado: 'en_revision_deposito', boucherComercio: BOUCHER_COMERCIO, boucherGestor: BOUCHER_GESTOR, boucherVigente: 'gestor' } });
  const cd = construirCobroDelivery(gestor, null, null);
  assert.equal(cd.boucherVigente, 'gestor');
  assert.deepEqual(cd.boucherGestor, BOUCHER_GESTOR);
  assert.deepEqual(cd.boucherComercio, BOUCHER_COMERCIO, 'el histórico del comercio también queda');
});

test('PRE-3 · el estado de revisión no vuelve a pendiente', () => {
  assert.equal(construirCobroDelivery(ordenTransferencia(), null, null).estado, 'en_revision_deposito');
});

test('PRE-4 · el monto y el resto de lo económico se recalculan en el servidor, no se heredan', () => {
  const o = ordenTransferencia({
    cobroDelivery: { estado: 'en_revision_deposito', boucherComercio: BOUCHER_COMERCIO, boucherVigente: 'comercio',
      monto: 1, tipoCliente: 'credito', quienPaga: 'entrega', cubiertoPorDeposito: 99, montoDelivery: 99 },
  });
  const cd = construirCobroDelivery(o, null, null);
  assert.equal(cd.monto, 110);
  assert.equal(cd.tipoCliente, 'contado');
  assert.equal(cd.quienPaga, 'transferencia');
  assert.equal(cd.cubiertoPorDeposito, undefined);
  assert.equal(cd.montoDelivery, undefined);
  assert.ok('registradoAt' in cd);
  // solo el comprobante se agrega a lo que ya calculaba el servidor
  const sinBoucher = construirCobroDelivery(ordenTransferencia({ cobroDelivery: undefined }), null, null);
  assert.deepEqual(claves(cd), claves({ ...sinBoucher, boucherComercio: 1, boucherVigente: 1 }));
});

test('PRE-5 · entregar no crea ledger ni pago: el cobro sigue en revisión y no hay formaPago inventada', () => {
  const cd = construirCobroDelivery(ordenTransferencia(), null, null);
  assert.equal(cd.estado, 'en_revision_deposito');
  assert.equal(cd.formaPago, undefined);
  const s = readFileSync(join(__dirname, '..', '..', 'src', 'motorizado-transiciones.ts'), 'utf8');
  const cuerpo = s.slice(s.indexOf('export const confirmarTransicionConCobro'));
  assert.equal(/movimientos_|ordenes_deposito|ledger/.test(cuerpo.replace(/\/\/.*$/gm, '')), false, 'la entrega no escribe ledger');
});

// ── PRE-6..PRE-9 · regresiones ─────────────────────────────────────────────────────────────────────
test('PRE-6 · sin boucher: resultado idéntico al de siempre, y no se introduce en_revision_deposito', () => {
  for (const previo of [undefined, null, {}, { estado: 'pendiente' }, { estado: 'pendiente', monto: 5 }, { estado: 'en_revision_deposito' }]) {
    const base = ordenTransferencia({ cobroDelivery: undefined });
    const esperado = construirCobroDelivery(base, null, null);
    const cd = construirCobroDelivery(ordenTransferencia({ cobroDelivery: previo }), null, null);
    assert.equal(cd.estado, 'pendiente', JSON.stringify(previo));
    assert.deepEqual(claves(cd), claves(esperado));
    assert.equal('boucherVigente' in cd, false);
  }
  // en_revision_deposito sin comprobante vigente completo tampoco se conserva
  for (const cdPrevio of [
    { estado: 'en_revision_deposito', boucherVigente: 'comercio' },
    { estado: 'en_revision_deposito', boucherVigente: 'comercio', boucherComercio: { url: '', path: 'p' } },
    { estado: 'en_revision_deposito', boucherVigente: 'gestor', boucherComercio: BOUCHER_COMERCIO },
    { estado: 'en_revision_deposito', boucherVigente: 'otro', boucherComercio: BOUCHER_COMERCIO },
    { estado: 'pendiente', boucherVigente: 'comercio', boucherComercio: BOUCHER_COMERCIO },
  ]) {
    assert.equal(construirCobroDelivery(ordenTransferencia({ cobroDelivery: cdPrevio }), null, null).estado, 'pendiente', JSON.stringify(cdPrevio));
  }
});

test('PRE-7 · pago de cliente / efectivo: no hereda el boucher del comercio y el motorizado cobra como siempre', () => {
  for (const quienPaga of ['entrega', 'recoleccion']) {
    const o = ordenTransferencia({ pagoDelivery: { quienPaga } });
    const cd = construirCobroDelivery(o, { recibio: true }, null);
    assert.equal(cd.estado, 'pagado', quienPaga);
    assert.equal(cd.formaPago, 'efectivo');
    assert.equal('boucherComercio' in cd, false);
    assert.equal('boucherVigente' in cd, false);
    const sinCobro = construirCobroDelivery(o, { recibio: false, justificacion: 'x' }, null);
    assert.equal(sinCobro.estado, 'pendiente');
    assert.equal('boucherComercio' in sinCobro, false);
  }
});

test('PRE-8 · crédito semanal: no hereda boucher, queda pendiente de la acumulación semanal', () => {
  for (const extra of [{ tipoCliente: 'credito' }, { pagoDelivery: { quienPaga: 'credito_semanal' } }, { tipoCliente: 'credito', pagoDelivery: { quienPaga: 'transferencia' } }]) {
    const cd = construirCobroDelivery(ordenTransferencia(extra), null, null);
    assert.equal(cd.tipoCliente, 'credito');
    assert.equal(cd.estado, 'pendiente');
    assert.ok(typeof cd.semanaKey === 'string');
    assert.equal('boucherComercio' in cd, false);
    assert.equal('boucherVigente' in cd, false);
  }
});

test('PRE-9 · incidencia de no pago: sigue pendiente y sin boucher; precio 0 sigue no_cobrar', () => {
  const inc = construirCobroDelivery(ordenTransferencia({ pagoDelivery: { quienPaga: 'entrega' } }), { recibio: false, justificacion: 'no tenía dinero' }, null);
  assert.equal(inc.estado, 'pendiente');
  assert.equal('boucherVigente' in inc, false);
  const cero = construirCobroDelivery(ordenTransferencia({ confirmacion: { precioFinalCordobas: 0 } }), null, null);
  assert.equal(cero.estado, 'no_cobrar');
  assert.equal(cero.monto, 0);
});

// ── Gestor, idempotencia, rebote ───────────────────────────────────────────────────────────────────
test('GESTOR · registrarCobroDelivery procesa la orden entregada con boucher previo: no hay boucher_requerido', () => {
  const cd = construirCobroDelivery(ordenTransferencia(), null, null);
  const entregada = ordenTransferencia({ estado: 'entregado', cobroDelivery: cd });
  const ev = evaluarOrdenParaCobro('o1', entregada, [], 'transferencia');
  assert.equal(ev.boucherUrl, BOUCHER_COMERCIO.url);
  assert.equal(ev.monto, 110);
  // contraste: sin el fix (cobroDelivery reemplazado a pendiente sin boucher) sí se exigía
  const perdido = ordenTransferencia({ estado: 'entregado', cobroDelivery: { ...cd, estado: 'pendiente', boucherComercio: undefined, boucherVigente: undefined } });
  assert.throws(() => evaluarOrdenParaCobro('o1', perdido, [], 'transferencia'), (e: unknown) => (e as { details?: { motivo?: string } }).details?.motivo === 'boucher_requerido');
});

test('IDEMP · reintento de entrega: la orden ya entregada falla la precondición de estado ANTES de cualquier write; recalcular sobre el resultado no pierde nada', () => {
  const cd1 = construirCobroDelivery(ordenTransferencia(), null, null);
  const cd2 = conservarBoucherPrevio(cd1, construirCobroDelivery(ordenTransferencia({ cobroDelivery: undefined }), null, null));
  assert.equal(cd2.estado, 'en_revision_deposito');
  assert.deepEqual(cd2.boucherComercio, BOUCHER_COMERCIO);
  const s = readFileSync(join(__dirname, '..', '..', 'src', 'motorizado-transiciones.ts'), 'utf8');
  const cuerpo = s.slice(s.indexOf('export const confirmarTransicionConCobro'));
  assert.ok(cuerpo.indexOf('estadoRequerido') < cuerpo.indexOf('tx.update(solicitudRef'), 'la precondición de estado precede al write');
  assert.equal((cuerpo.match(/tx\.update\(/g) ?? []).length, 1, 'un único write');
});

test('REBOTE · rebotar la asignación antes de entregar no toca cobroDelivery (el boucher no se pierde)', () => {
  const root = join(__dirname, '..', '..', '..');
  const s = readFileSync(join(root, 'app', 'panel', 'gestor', 'solicitudes', 'page.tsx'), 'utf8');
  const ini = s.indexOf('const rebotarAsignacion');
  const fin = s.indexOf('Asignación rebotada', ini);
  assert.ok(ini > 0 && fin > ini);
  assert.equal(s.slice(ini, fin).includes('cobroDelivery'), false);
});
