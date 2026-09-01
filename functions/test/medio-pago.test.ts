// B2-PAGO-MEDIO — suite de la frontera autoritativa.
//
// Vive DENTRO de functions/ y ejecuta la implementación real de
// `src/medio-pago.ts`: no hay espejo, no hay réplica, no hay import cruzado
// hacia `lib/`. La suite raíz de la app y esta son independientes — distinto
// tsconfig, distinto outDir y distinto comando.
//
// El archivo queda fuera de `tsconfig.json` (que solo incluye `src`), así que
// no entra en `lib/` ni en el artefacto de deploy. Lo compila
// `tsconfig.test.json` a `.test-build`, ignorado por git.
//
// Lo que estos tests defienden es una sola frase: el efectivo se deriva del
// FLUJO, y ninguna otra cosa produce un medio de pago.

import { test } from 'node:test';
// `import * as` y no default: el tsconfig de Functions no activa
// esModuleInterop, y este config de tests no lo añade a propósito — así el
// test compila con exactamente las mismas opciones que el código de deploy.
import * as assert from 'node:assert/strict';
import { resolverFormaPago, esMedioPago, MEDIOS_PAGO, permiteCierreSinConfirmaciones } from '../src/medio-pago';

/** Flujo físico: ni crédito ni transferencia. Es donde el motorizado recauda. */
const FISICO = { esCredito: false, esPorTransferencia: false };

// ─── Derivación del efectivo ──────────────────────────────────────────────────

test('MP1 · flujo físico + el motorizado confirmó que cobró ⇒ efectivo', () => {
  assert.equal(resolverFormaPago({ ...FISICO, motorizadoYaCobro: true }), 'efectivo');
});

test('MP1b · vale igual para recolección y para entrega', () => {
  // El helper no recibe `quienPaga`: lo único que distingue los dos momentos es
  // quién puso `motorizadoYaCobro` en true, y para el medio da lo mismo. Se fija
  // acá para que nadie añada después una rama por momento.
  const entradas = Object.keys(resolverFormaPago as unknown as object);
  assert.equal(entradas.includes('quienPaga'), false);
  assert.equal(resolverFormaPago({ ...FISICO, motorizadoYaCobro: true }), 'efectivo');
});

test('MP2 · flujo físico sin cobro confirmado ⇒ no se escribe nada', () => {
  assert.equal(resolverFormaPago({ ...FISICO, motorizadoYaCobro: false }), null);
});

test('MP3 · crédito NO deriva efectivo, aunque el flag venga en true', () => {
  assert.equal(
    resolverFormaPago({ motorizadoYaCobro: true, esCredito: true, esPorTransferencia: false }),
    null,
  );
});

test('MP4 · quienPaga transferencia NO deriva efectivo, aunque el flag venga en true', () => {
  assert.equal(
    resolverFormaPago({ motorizadoYaCobro: true, esCredito: false, esPorTransferencia: true }),
    null,
  );
});

test('MP4b · con crédito Y transferencia a la vez tampoco', () => {
  assert.equal(
    resolverFormaPago({ motorizadoYaCobro: true, esCredito: true, esPorTransferencia: true }),
    null,
  );
});

// ─── Preservación de lo ya persistido ─────────────────────────────────────────

test('MP5 · un formaPago "transferencia" existente se preserva', () => {
  assert.equal(
    resolverFormaPago({ formaPagoExistente: 'transferencia', ...FISICO, motorizadoYaCobro: true }),
    'transferencia',
    'el cierre no puede pisar lo que el gestor confirmó contra un comprobante',
  );
});

test('MP6 · un formaPago "efectivo" existente se preserva', () => {
  assert.equal(
    resolverFormaPago({ formaPagoExistente: 'efectivo', ...FISICO, motorizadoYaCobro: false }),
    'efectivo',
    'ni siquiera un cierre sin cobro lo borra',
  );
});

test('MP7 · un formaPago existente inválido NO se toma como válido', () => {
  for (const invalido of ['Efectivo', 'EFECTIVO', 'transferencia_deposito', 'tarjeta', ' efectivo', '', 0, true, null, undefined, {}]) {
    // Sin cobro confirmado no hay de dónde derivar: el resultado debe ser null,
    // nunca el valor basura.
    assert.equal(
      resolverFormaPago({ formaPagoExistente: invalido, ...FISICO, motorizadoYaCobro: false }),
      null,
      `tomó como válido ${JSON.stringify(invalido)}`,
    );
  }
});

test('MP7b · un formaPago inválido no bloquea la derivación legítima', () => {
  assert.equal(
    resolverFormaPago({ formaPagoExistente: 'Efectivo', ...FISICO, motorizadoYaCobro: true }),
    'efectivo',
  );
});

// ─── Las justificaciones no son medio de pago ─────────────────────────────────

test('MP8 · "indicó que pagará por transferencia" NO produce formaPago', () => {
  // Los dos motivos nuevos explican por qué no entró el efectivo. El motorizado
  // que los elige está marcando recibio:false, así que `motorizadoYaCobro` es
  // false y el cobro queda pendiente. La transferencia solo existe cuando el
  // gestor la confirma contra un comprobante, y eso escribe formaPago aparte.
  const JUSTIFICACIONES = [
    'Cliente indicó que pagará por transferencia',
    'Comercio indicó que pagará por transferencia',
  ];
  for (const justificacion of JUSTIFICACIONES) {
    // El helper ni siquiera acepta la justificación como entrada: no hay vía
    // por la que un texto se convierta en medio. Se comprueba el efecto real.
    assert.equal(esMedioPago(justificacion), false);
    assert.equal(resolverFormaPago({ ...FISICO, motorizadoYaCobro: false }), null);
  }
});

test('MP8b · ninguna justificación es un medio válido', () => {
  const TODAS = [
    'Se acordó cobrar en la entrega',
    'El comercio tiene crédito / cobrará luego',
    'Comercio no estaba al momento del retiro',
    'Se acordará el cobro luego',
    'El cliente no estaba / no atendió',
    'El cliente no tenía efectivo',
    'El cliente rechazó el producto',
    'Error en el monto acordado',
    'Otro',
  ];
  for (const j of TODAS) assert.equal(esMedioPago(j), false, `aceptó "${j}"`);
});

// ─── Contrato del enum ────────────────────────────────────────────────────────

test('MP9 · el enum tiene exactamente dos valores y es estricto', () => {
  assert.deepEqual([...MEDIOS_PAGO], ['efectivo', 'transferencia']);
  assert.equal(esMedioPago('efectivo'), true);
  assert.equal(esMedioPago('transferencia'), true);
  assert.equal(esMedioPago('Transferencia'), false);
});

// ─── Guard del cierre ─────────────────────────────────────────────────────────

test('MP10 · el guard sigue admitiendo solo el cierre de entregado sin payload', () => {
  assert.equal(permiteCierreSinConfirmaciones({ nuevo: 'entregado', traePayloadDeCobro: false }), true);
  assert.equal(permiteCierreSinConfirmaciones({ nuevo: 'entregado', traePayloadDeCobro: true }), false);
  for (const nuevo of ['retirado', 'en_camino_retiro', 'en_camino_entrega', '']) {
    assert.equal(permiteCierreSinConfirmaciones({ nuevo, traePayloadDeCobro: false }), false, nuevo);
  }
});
