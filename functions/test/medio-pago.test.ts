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
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  resolverFormaPago,
  esMedioPago,
  MEDIOS_PAGO,
  permiteCierreSinConfirmaciones,
  calcularFlagsConfirmacion,
  requiereConfirmacionDeCobro,
} from '../src/medio-pago';

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

test('MP10 · el guard admite los dos cierres server-authoritative, y nada más', () => {
  // B2-PAGO-MEDIO abrió 'entregado'. VIAJE-ENTREGADO-SIN-COBRO-1 abre
  // 'retirado' por la misma razón: el retiro también dejó de escribirlo el
  // cliente. Lo que NO cambia es que un payload de cobro presente invalida el
  // cierre, y que las dos señales del motorizado no pasan nunca por acá.
  assert.equal(permiteCierreSinConfirmaciones({ nuevo: 'entregado', traePayloadDeCobro: false }), true);
  assert.equal(permiteCierreSinConfirmaciones({ nuevo: 'retirado', traePayloadDeCobro: false }), true);
  for (const nuevo of ['entregado', 'retirado']) {
    assert.equal(permiteCierreSinConfirmaciones({ nuevo, traePayloadDeCobro: true }), false, nuevo);
  }
  for (const nuevo of ['en_camino_retiro', 'en_camino_entrega', 'asignada', 'cancelada', '']) {
    assert.equal(permiteCierreSinConfirmaciones({ nuevo, traePayloadDeCobro: false }), false, nuevo);
  }
});

// ─── VF · VIAJE-ENTREGADO-SIN-COBRO-1: el retiro también es del servidor ──────
//
// El E2E de SH-0007 mostró el agujero: "Paquete recogido" llamaba a la callable
// SOLO cuando había un cobro que confirmar en la recolección. Con
// `quienPaga: 'entrega'` —el caso corriente— no hay nada que cobrar al retirar,
// así que el cliente escribía `retirado` con un updateDoc directo… que las
// Rules del cierre financiero deniegan. El SDK aplicaba el write local, el
// servidor lo revertía, y en pantalla el estado "cambiaba y volvía".
//
// La respuesta no fue reabrirle `retirado` al cliente —las Rules quedan como
// están— sino que el retiro pase por la Function SIEMPRE. Estos casos fijan la
// derivación autoritativa que decide si esa llamada trae cobro o no: la que
// recalcula el servidor desde la orden, sin mirar el payload del cliente.

/** Depósito con delivery y con producto: el caso que sí exige confirmar. */
const DEP_COMPLETO = { tieneDelivery: true, tieneProducto: true };

test('VF1 · retiro sin cobro en la recolección: nada que confirmar, cierra sin payload', () => {
  // quienPaga: 'entrega' — el delivery se cobra al entregar, no al retirar.
  const orden = { pagoDelivery: { quienPaga: 'entrega' }, tipoServicio: 'managua' };
  const flags = calcularFlagsConfirmacion(orden, DEP_COMPLETO, 'retirado');
  assert.equal(flags.showDelivery, false);
  assert.equal(flags.showProducto, false, 'el producto se cobra en la entrega');
  assert.equal(flags.showCargotransCobro, false);
  assert.equal(requiereConfirmacionDeCobro(flags), false);
  // Y por eso la callable acepta el cierre: es exactamente la combinación que
  // antes se iba por updateDoc y moría contra Rules.
  assert.equal(permiteCierreSinConfirmaciones({ nuevo: 'retirado', traePayloadDeCobro: false }), true);
});

test('VF2 · retiro con delivery cobrado en la recolección: sí hay que confirmar', () => {
  const orden = { pagoDelivery: { quienPaga: 'recoleccion' }, tipoServicio: 'managua' };
  const flags = calcularFlagsConfirmacion(orden, DEP_COMPLETO, 'retirado');
  assert.equal(flags.showDelivery, true);
  assert.equal(requiereConfirmacionDeCobro(flags), true);
  // En este camino la callable exige el payload y falla sin él; el guard del
  // cierre ni se consulta. Lo que fija el caso es que la derivación no lo
  // apague: si lo hiciera, un retiro cobrado se cerraría sin confirmar nada.
});

test('VF3 · fuera de Managua: el comercio paga en la recolección aunque diga entrega', () => {
  // Regla de negocio: en fuera_managua el cobro del delivery cae en el retiro,
  // sin importar lo que traiga `quienPaga`.
  const orden = { pagoDelivery: { quienPaga: 'entrega' }, tipoServicio: 'fuera_managua' };
  const enRetiro = calcularFlagsConfirmacion(orden, DEP_COMPLETO, 'retirado');
  assert.equal(enRetiro.showDelivery, true);
  assert.equal(requiereConfirmacionDeCobro(enRetiro), true);
  // Y en la entrega ya no se vuelve a pedir.
  const enEntrega = calcularFlagsConfirmacion(orden, { tieneDelivery: true, tieneProducto: false }, 'entregado');
  assert.equal(enEntrega.showDelivery, false);
});

test('VF4 · cargotrans pagado en efectivo por el motorizado: confirmación en el retiro', () => {
  const orden = {
    pagoDelivery: { quienPaga: 'entrega' },
    tipoServicio: 'fuera_managua',
    fueraManagua: { metodoEnvio: 'cargotrans', pagoCargotrans: 'efectivo_motorizado' },
  };
  const flags = calcularFlagsConfirmacion(orden, { tieneDelivery: false, tieneProducto: false }, 'retirado');
  assert.equal(flags.showCargotransCobro, true);
  assert.equal(requiereConfirmacionDeCobro(flags), true);
  // Si lo paga otro, el retiro vuelve a no pedir nada y cierra derecho.
  const pagaOtro = calcularFlagsConfirmacion(
    { ...orden, fueraManagua: { metodoEnvio: 'cargotrans', pagoCargotrans: 'transferencia_storkhub' } },
    { tieneDelivery: false, tieneProducto: false },
    'retirado',
  );
  assert.equal(pagaOtro.showCargotransCobro, false);
  assert.equal(requiereConfirmacionDeCobro(pagaOtro), false);
});

test('VF5 · delivery deducido del cobro contra entrega: no se confirma por separado', () => {
  // El cliente paga un solo monto y el sistema descuenta el delivery adentro,
  // así que el motorizado no lo cobra aparte en ninguna de las dos puntas.
  const orden = {
    pagoDelivery: { quienPaga: 'recoleccion', deducirDelCobroContraEntrega: true },
    tipoServicio: 'managua',
  };
  const enRetiro = calcularFlagsConfirmacion(orden, DEP_COMPLETO, 'retirado');
  assert.equal(enRetiro.deducirDelCE, true);
  assert.equal(enRetiro.showDelivery, false);
  assert.equal(requiereConfirmacionDeCobro(enRetiro), false);
});

test('VF6 · entregado: sin confirmaciones cierra, con payload de cobro no', () => {
  // Sin producto ni delivery pendiente —típicamente ya cobrado en el retiro—
  // el cierre pasa sin payload: es la excepción que abrió B2-PAGO-MEDIO.
  const yaCobrado = calcularFlagsConfirmacion(
    { pagoDelivery: { quienPaga: 'recoleccion' }, tipoServicio: 'managua' },
    { tieneDelivery: true, tieneProducto: false },
    'entregado',
  );
  assert.equal(requiereConfirmacionDeCobro(yaCobrado), false);
  assert.equal(permiteCierreSinConfirmaciones({ nuevo: 'entregado', traePayloadDeCobro: false }), true);
  assert.equal(permiteCierreSinConfirmaciones({ nuevo: 'entregado', traePayloadDeCobro: true }), false);
  // Con producto que cobrar, la entrega sí exige confirmación.
  const conProducto = calcularFlagsConfirmacion(
    { pagoDelivery: { quienPaga: 'recoleccion' }, tipoServicio: 'managua' },
    DEP_COMPLETO,
    'entregado',
  );
  assert.equal(conProducto.showProducto, true);
  assert.equal(requiereConfirmacionDeCobro(conProducto), true);
});

test('VF7 · ampliar el cierre no relaja las precondiciones de la callable', () => {
  // `permiteCierreSinConfirmaciones` no valida identidad ni estado de origen:
  // solo dice "esta transición puede cerrarse sin payload". Que ahora acepte
  // 'retirado' sería un agujero si el guard del actor o el del origen
  // desaparecieran o quedaran DESPUÉS. Se comprueba sobre la fuente real, con
  // el mismo criterio con que la suite de Rules lee su archivo.
  // Dos niveles: el test corre compilado desde `.test-build/test/`, así que la
  // fuente real queda en `functions/src/`.
  const src = readFileSync(join(__dirname, '..', '..', 'src', 'motorizado-transiciones.ts'), 'utf8');
  const iAsignado = src.indexOf('asignacion.motorizadoAuthUid !== motorizadoUid');
  const iOrigen = src.indexOf(
    "const estadoRequerido = nuevo === 'retirado' ? 'en_camino_retiro' : 'en_camino_entrega'",
  );
  const iCierre = src.indexOf('permiteCierreSinConfirmaciones({ nuevo, traePayloadDeCobro })');
  assert.ok(iAsignado > 0, 'falta el guard de asignación al llamador');
  assert.ok(iOrigen > 0, 'falta la precondición de estado origen');
  assert.ok(iCierre > 0, 'falta la consulta al guard del cierre');
  assert.ok(iAsignado < iCierre, 'un motorizado ajeno llegaría al cierre');
  assert.ok(iOrigen < iCierre, 'se podría cerrar desde un estado origen distinto');
  // Y el origen exigido sigue siendo exacto: no hay reintento idempotente —un
  // segundo clic encuentra la orden ya en 'retirado' y falla la precondición.
  assert.ok(src.includes('orden.estado !== estadoRequerido'), 'la precondición dejó de ser exacta');
});
