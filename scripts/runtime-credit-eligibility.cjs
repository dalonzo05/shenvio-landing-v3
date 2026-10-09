// CREDIT-ELIGIBILITY-1 — runtime contra el EMULADOR de Firestore (proyecto demo-storkhub). Nunca staging ni producción.
//
//   cd functions && npm run build && cd ..
//   firebase emulators:exec --only firestore --project demo-storkhub "node scripts/runtime-credit-eligibility.cjs"
//
// Invoca las callables REALES (confirmarTransicionConCobro y acumularCobroSemanalPorOrden, vía .run) con Admin SDK contra el emulador, y para cada rechazo compara
// un volcado COMPLETO de la base antes y después: 0 cambios (ni solicitud, ni cobroDelivery, ni cobros_semanales, ni depósito, ni ledger, ni saldo).
// RT1/RT2/RT4 (Rules DENY/ALLOW del CREATE) viven en la suite de Rules (test/firestore-rules.test.ts: CREDIT-R1…R12), que también corre en el emulador.
const path = require('node:path');
const assert = require('node:assert/strict');
const fn = path.join(__dirname, '..', 'functions');
process.env.GCLOUD_PROJECT = 'demo-storkhub';
if (!process.env.FIRESTORE_EMULATOR_HOST) { console.error('Falta FIRESTORE_EMULATOR_HOST: correr dentro de firebase emulators:exec.'); process.exit(2); }
const admin = require(path.join(fn, 'node_modules', 'firebase-admin'));
admin.initializeApp({ projectId: 'demo-storkhub' });
const db = admin.firestore();
db.settings({ ignoreUndefinedProperties: true });
const { confirmarTransicionConCobro } = require(path.join(fn, 'lib', 'motorizado-transiciones.js'));
const { acumularCobroSemanalPorOrden } = require(path.join(fn, 'lib', 'cobro-semanal.js'));

const COLECCIONES = ['usuarios', 'comercios', 'solicitudes_envio', 'cobros_semanales', 'ordenes_deposito', 'movimientos_financieros', 'saldos_cargo_motorizado',
  'liquidaciones_motorizado', 'gastos_motorizado', 'adelantos_motorizado', 'pagos_comercio', 'cargos_delivery', 'aplicaciones_pago'];
async function volcado() {
  const out = {};
  for (const c of COLECCIONES) { const s = await db.collection(c).get(); for (const d of s.docs) out[`${c}/${d.id}`] = JSON.stringify(d.data()); }
  return out;
}
const MOTO = 'uid_moto';
const asignacion = { motorizadoAuthUid: MOTO, motorizadoId: 'm1', motorizadoNombre: 'Moto', estadoAceptacion: 'aceptada' };
function orden(extra = {}) {
  return {
    comercioId: 'com_cred', userId: 'com_cred', comercioUid: 'com_cred', ownerSnapshot: { uid: 'com_cred', companyName: 'Credito SA', nombre: 'Credito SA' },
    estado: 'en_camino_entrega', asignacion, tipoCliente: 'credito', pagoDelivery: { tipo: 'credito_semanal', quienPaga: 'credito_semanal', montoSugerido: 150 },
    cobroContraEntrega: { aplica: false, monto: 0 }, confirmacion: { precioFinalCordobas: 150, comisionBaseCordobas: 150, comisionBaseOrigen: 'tarifa_distancia' },
    tieneCotizacion: true, createdAt: admin.firestore.Timestamp.now(), ...extra,
  };
}
const CONTADO = { tipoCliente: 'contado', pagoDelivery: { tipo: 'contado', quienPaga: 'entrega', montoSugerido: 150, deducirDelCobroContraEntrega: false } };
const llamar = (callable, data, uid = MOTO) => callable.run({ auth: { uid, token: {} }, data, rawRequest: {} });
async function rechazo(callable, data, motivo) {
  const antes = await volcado();
  await assert.rejects(llamar(callable, data), (e) => e.code === 'failed-precondition' && e.details && e.details.motivo === motivo, 'debía rechazar con ' + motivo);
  const despues = await volcado();
  assert.deepEqual(despues, antes, 'el rechazo dejó escrituras');
}
let ok = 0;
const paso = async (nombre, f) => { await f(); ok++; console.log('  ✓', nombre); };

(async () => {
  await db.collection('usuarios').doc(MOTO).set({ activo: true, rol: 'motorizado' });
  await db.collection('comercios').doc('com_cred').set({ name: 'Credito SA', tipoCliente: 'credito' });
  await db.collection('comercios').doc('com_cont').set({ name: 'Contado SA', tipoCliente: 'contado' });
  await db.collection('comercios').doc('com_none').set({ name: 'Sin tipo SA' });
  await db.collection('usuarios').doc('uid_cliente').set({ activo: true, rol: 'cliente' });
  const pedido = (id) => ({ solicitudId: id, nuevo: 'entregado' });
  const seed = (id, o) => db.collection('solicitudes_envio').doc(id).set(o);
  const dueno = (c) => ({ comercioId: c, userId: c, comercioUid: c, ownerSnapshot: { uid: c, companyName: c, nombre: c } });

  console.log('RT1 · perfil credito + orden credito ⇒ PASS');
  await paso('confirmarTransicionConCobro entrega la orden de crédito elegible y marca la acumulación', async () => {
    await seed('rt1', orden());
    const r = await llamar(confirmarTransicionConCobro, pedido('rt1'));
    assert.equal(r.ok, true); assert.equal(r.necesitaAcumularCobroSemanal, true);
    const o = (await db.collection('solicitudes_envio').doc('rt1').get()).data();
    assert.equal(o.estado, 'entregado'); assert.equal(o.acumulacionCobroSemanal.estado, 'pendiente'); assert.equal(o.cobroDelivery.tipoCliente, 'credito');
  });
  await paso('acumularCobroSemanalPorOrden abre la semana del comercio elegible', async () => {
    await db.collection('solicitudes_envio').doc('rt1').update({ 'evidencias.entrega': { url: 'x' } });
    const r = await llamar(acumularCobroSemanalPorOrden, { ordenId: 'rt1' });
    assert.equal(r.ok, true); assert.equal(r.totalMonto, 150);
    const cs = await db.collection('cobros_semanales').get(); assert.equal(cs.size, 1); assert.equal(cs.docs[0].data().clienteUid, 'com_cred');
  });

  console.log('RT3 · crédito no elegible (legacy / Admin-seeded) ⇒ la Function rechaza, 0 writes');
  await paso('comercio contado + tipoCliente=credito', async () => { await seed('rt3a', orden(dueno('com_cont'))); await rechazo(confirmarTransicionConCobro, pedido('rt3a'), 'credito_no_autorizado'); });
  await paso('comercio sin tipoCliente', async () => { await seed('rt3b', orden(dueno('com_none'))); await rechazo(confirmarTransicionConCobro, pedido('rt3b'), 'credito_no_autorizado'); });
  await paso('comercio inexistente', async () => { await seed('rt3c', orden(dueno('com_fantasma'))); await rechazo(confirmarTransicionConCobro, pedido('rt3c'), 'credito_no_autorizado'); });
  await paso('credito_semanal plantado con tipoCliente=contado en comercio contado', async () => {
    await seed('rt3d', orden({ ...dueno('com_cont'), tipoCliente: 'contado' })); await rechazo(confirmarTransicionConCobro, pedido('rt3d'), 'credito_no_autorizado');
  });
  await paso('solo pagoDelivery.tipo=credito_semanal en comercio contado', async () => {
    await seed('rt3e', orden({ ...dueno('com_cont'), ...CONTADO, pagoDelivery: { tipo: 'credito_semanal', quienPaga: 'entrega' } })); await rechazo(confirmarTransicionConCobro, pedido('rt3e'), 'credito_no_autorizado');
  });
  await paso('identidades divergentes (userId de otro comercio)', async () => { await seed('rt3f', orden({ userId: 'com_cont' })); await rechazo(confirmarTransicionConCobro, pedido('rt3f'), 'credito_no_autorizado'); });
  await paso('retiro (nuevo=retirado) de una orden de crédito no elegible tampoco avanza', async () => {
    await seed('rt3g', orden({ ...dueno('com_cont'), estado: 'en_camino_retiro' })); await rechazo(confirmarTransicionConCobro, { solicitudId: 'rt3g', nuevo: 'retirado' }, 'credito_no_autorizado');
  });
  await paso('acumularCobroSemanalPorOrden: orden ya entregada de comercio no elegible ⇒ rechazo, cobros_semanales intacto', async () => {
    await seed('rt3h', orden({ ...dueno('com_cont'), estado: 'entregado', entregadoAt: admin.firestore.Timestamp.now(), evidencias: { entrega: { url: 'x' } } }));
    await rechazo(acumularCobroSemanalPorOrden, { ordenId: 'rt3h' }, 'credito_no_autorizado');
  });

  console.log('RT4 (servidor) · cliente individual con crédito ⇒ la Function rechaza');
  await paso('cliente individual (sin comercioId, userId = uid de cliente)', async () => {
    await seed('rt4', orden({ comercioId: undefined, userId: 'uid_cliente', comercioUid: 'uid_cliente', ownerSnapshot: { uid: 'uid_cliente', companyName: 'C', nombre: 'C' } }));
    await rechazo(confirmarTransicionConCobro, pedido('rt4'), 'credito_no_autorizado');
  });

  console.log('Regresión · contado intacto');
  await paso('orden de contado en comercio contado (y en comercio de crédito) se entrega como siempre, sin acumulación', async () => {
    for (const [id, c] of [['rt5a', 'com_cont'], ['rt5b', 'com_cred']]) {
      await seed(id, orden({ ...dueno(c), ...CONTADO }));
      const r = await llamar(confirmarTransicionConCobro, { ...pedido(id), cobros: { delivery: { recibio: true } } });
      assert.equal(r.ok, true); assert.equal(r.necesitaAcumularCobroSemanal, false);
      const o = (await db.collection('solicitudes_envio').doc(id).get()).data();
      assert.equal(o.estado, 'entregado'); assert.equal(o.acumulacionCobroSemanal, undefined); assert.equal(o.cobroDelivery.tipoCliente, 'contado');
    }
  });

  console.log(`\nRuntime OK: ${ok} casos`);
  process.exit(0);
})().catch((e) => { console.error('FALLÓ:', e); process.exit(1); });
