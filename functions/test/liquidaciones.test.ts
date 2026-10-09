// FIN-1D — crearLiquidacionMotorizado y marcarLiquidacionPagada: AUTORITATIVAS.
//
// El "mundo" simula lo que importa de Firestore (transacciones optimistas con reintento, escrituras todo-o-nada, create()/update(), arrayUnion y
// consultas por igualdad), como en finanzas-operativas.test.ts. La prueba con el emulador real vive en el runtime.
import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import type { DocumentData } from 'firebase-admin/firestore';
import { crearLiquidacionMotorizadoCore, validarPeticionCrearLiquidacion, type DepsCrearLiquidacion } from '../src/crear-liquidacion';
import { marcarLiquidacionPagadaCore, type DepsPagarLiquidacion } from '../src/pagar-liquidacion';
import { crearGastoMotorizadoCore, type DepsCrearGasto } from '../src/crear-gasto';
import { registrarAdelantoMotorizadoCore, type DepsRegistrarAdelanto } from '../src/adelantos';
import { rangoDeSemana, semanaKeyDeFecha } from '../src/cobro-semanal';
import { calcularDeposito } from '../src/calculo-deposito';
import { aCentavos, baseComisionOrden, efectivoAStorkhubOrden, formulaLiquidacion } from '../src/liquidacion-calculo';

type Doc = Record<string, unknown>;
const TS = (n: number) => ({ __ms: n });
const codigo = (code: string, motivo?: string) => (e: unknown) => {
  const err = e as { code?: string; details?: { motivo?: string } };
  return err.code === code && (motivo === undefined || err.details?.motivo === motivo);
};

const AHORA = new Date('2026-05-20T15:00:00Z'); // miércoles 09:00 en Managua (semana 2026-W21, en curso)
const SEM = '2026-W20'; // lunes 11-may a domingo 17-may (Managua): CERRADA
const { inicio: INI_D, fin: FIN_D } = rangoDeSemana(SEM);
const INI = INI_D.getTime();
const FIN = FIN_D.getTime();
const MID = Date.UTC(2026, 4, 13, 18, 0, 0);
const OP = 'op-12345678';
const OP2 = 'op-87654321';
const OP3 = 'op-11223344';

function revivir(v: unknown): unknown {
  if (Array.isArray(v)) return v.map(revivir);
  if (v && typeof v === 'object') {
    const o = v as Record<string, unknown>;
    if (typeof o.__ms === 'number') { const ms = o.__ms; return { __ms: ms, toMillis: () => ms, toDate: () => new Date(ms) }; }
    return Object.fromEntries(Object.entries(o).map(([k, x]) => [k, revivir(x)]));
  }
  return v;
}
function desvivir(v: unknown): unknown {
  if (Array.isArray(v)) return v.map(desvivir);
  if (v && typeof v === 'object') {
    const o = v as Record<string, unknown>;
    if (typeof o.__ms === 'number') return { __ms: o.__ms };
    return Object.fromEntries(Object.entries(o).map(([k, x]) => [k, desvivir(x)]));
  }
  return v;
}
function aplicarCampos(actual: Doc, campos: Doc): Doc {
  const copia = structuredClone(actual);
  for (const [k, v] of Object.entries(campos)) {
    const o = v as { __union?: unknown } | null;
    if (o && typeof o === 'object' && '__union' in o) {
      const previo = Array.isArray(copia[k]) ? (copia[k] as unknown[]) : [];
      copia[k] = [...previo, structuredClone(desvivir(o.__union))];
    } else copia[k] = structuredClone(desvivir(v));
  }
  return copia;
}

function mundo() {
  let store = new Map<string, Doc>();
  let revision = 0;
  let relojes = 0;
  let escrituras = 0;
  const hooks: { antesDeCommit?: () => void } = {};
  const clonar = (m: Map<string, Doc>) => new Map([...m].map(([k, v]) => [k, structuredClone(v)]));
  const put = (ruta: string, d: Doc) => { store.set(ruta, d); };
  const get = (ruta: string) => { const d = store.get(ruta); return d ? (revivir(structuredClone(d)) as DocumentData) : null; };
  const raw = (ruta: string) => structuredClone(store.get(ruta)) as Doc;
  const filtrar = (prefijo: string, pred: (d: Doc) => boolean) => [...store]
    .filter(([r, d]) => r.startsWith(prefijo) && !r.slice(prefijo.length).includes('/') && pred(d))
    .map(([r, d]) => ({ id: r.split('/').pop() as string, data: revivir(structuredClone(d)) as DocumentData }));

  function correr(opCol: string) {
    return async function <T>(fn: (tx: never) => Promise<T>): Promise<T> {
      for (;;) {
        const inicio = revision;
        const cola: Array<{ op: string; ruta: string; datos: Doc }> = [];
        const q = (op: string, ruta: string, datos: Doc) => { cola.push({ op, ruta, datos }); };
        const tx = {
          async getUsuario(uid: string) { return get(`usuarios/${uid}`); },
          async getMotorizado(id: string) { return get(`motorizado/${id}`); },
          async getOrden(id: string) { return get(`solicitudes_envio/${id}`); },
          async getOperacion(id: string) { return get(`${opCol}/${id}`); },
          async getGasto(id: string) { return get(`gastos_motorizado/${id}`); },
          async getSaldo(id: string) { return get(`saldos_cargo_motorizado/${id}`); },
          async getMovimiento(id: string) { return get(`movimientos_financieros/${id}`); },
          async getLiquidacion(id: string) { return get(`liquidaciones_motorizado/${id}`); },
          async getLiquidacionesDelMotorizado(mid: string, uid: string | null) {
            return filtrar('liquidaciones_motorizado/', (d) => d.motorizadoId === mid || (uid !== null && d.motorizadoUid === uid));
          },
          async getOrdenesEntregadasDelMotorizado(mid: string) {
            return filtrar('solicitudes_envio/', (d) => (d.asignacion as { motorizadoId?: string } | undefined)?.motorizadoId === mid && d.estado === 'entregado');
          },
          async getDepositosDelMotorizado(uid: string) { return filtrar('ordenes_deposito/', (d) => d.motorizadoUid === uid); },
          async getGastosAprobadosDelMotorizado(mid: string) { return filtrar('gastos_motorizado/', (d) => d.motorizadoId === mid && d.estado === 'aprobado'); },
          async getAdelantosDelMotorizado(mid: string) { return filtrar('movimientos_financieros/', (d) => d.tipo === 'adelanto_motorizado' && d.motorizadoId === mid); },
          async getOrdenesPorPunteroDeposito(depId: string) {
            return filtrar('solicitudes_envio/', (d) => ((d.registro as { deposito?: { storkhubDepositoId?: string } } | undefined)?.deposito?.storkhubDepositoId) === depId);
          },
          async getDepositosConGasto(id: string) { return filtrar('ordenes_deposito/', (d) => Array.isArray(d.gastosIds) && (d.gastosIds as string[]).includes(id)); },
          crearLiquidacion(id: string, c: Doc) { q('create', `liquidaciones_motorizado/${id}`, c); },
          crearOperacion(id: string, c: Doc) { q('create', `${opCol}/${id}`, c); },
          crearSaldo(id: string, c: Doc) { q('create', `saldos_cargo_motorizado/${id}`, c); },
          crearMovimiento(id: string, c: Doc) { q('create', `movimientos_financieros/${id}`, c); },
          crearGasto(id: string, c: Doc) { q('create', `gastos_motorizado/${id}`, c); },
          updateSaldo(id: string, c: Doc) { q('update', `saldos_cargo_motorizado/${id}`, c); },
          updateLiquidacion(id: string, c: Doc) { q('update', `liquidaciones_motorizado/${id}`, c); },
          marcarGastoLiquidado(id: string, liquidacionId: string) { q('update', `gastos_motorizado/${id}`, { liquidacionId }); },
        };
        const resultado = await fn(tx as never);
        const hook = hooks.antesDeCommit; hooks.antesDeCommit = undefined; hook?.();
        if (revision !== inicio) continue;
        const copia = clonar(store);
        for (const w of cola) {
          if (w.op === 'create') {
            if (copia.has(w.ruta)) throw new Error('ALREADY_EXISTS ' + w.ruta);
            copia.set(w.ruta, structuredClone(desvivir(w.datos) as Doc));
          } else {
            const actual = copia.get(w.ruta);
            if (!actual) throw new Error('NOT_FOUND ' + w.ruta);
            copia.set(w.ruta, aplicarCampos(actual, w.datos));
          }
        }
        store = copia;
        if (cola.length) { revision++; escrituras += cola.length; }
        return resultado;
      }
    };
  }
  const comun = { serverTimestamp: () => TS(++relojes) };
  const depsLiq: DepsCrearLiquidacion = {
    transaction: correr('operaciones_liquidacion') as DepsCrearLiquidacion['transaction'], ...comun,
    aTimestamp: (d) => ({ __ms: d.getTime() }), arrayUnion: (item) => ({ __union: item }), ahora: () => AHORA,
  };
  const depsPagar: DepsPagarLiquidacion = { transaction: correr('operaciones_liquidacion') as DepsPagarLiquidacion['transaction'], ...comun };
  const depsGasto: DepsCrearGasto = { transaction: correr('operaciones_gasto') as DepsCrearGasto['transaction'], ...comun, aTimestamp: (d) => ({ __ms: d.getTime() }), ahora: () => AHORA };
  const depsAdelanto: DepsRegistrarAdelanto = { transaction: correr('operaciones_adelanto') as DepsRegistrarAdelanto['transaction'], ...comun, ahora: () => AHORA };
  return {
    depsLiq, depsPagar, depsGasto, depsAdelanto, hooks, put, get, raw, bump: () => { revision++; },
    get escrituras() { return escrituras; },
    snapshot: () => JSON.stringify([...store].sort(([a], [b]) => a.localeCompare(b))),
    movimientos: () => filtrar('movimientos_financieros/', () => true),
    saldos: () => filtrar('saldos_cargo_motorizado/', () => true),
    liquidaciones: () => filtrar('liquidaciones_motorizado/', () => true),
    operaciones: () => filtrar('operaciones_liquidacion/', () => true),
  };
}
type Mundo = ReturnType<typeof mundo>;

function base(w: Mundo) {
  w.put('usuarios/a1', { activo: true, rol: 'admin' });
  w.put('usuarios/g1', { activo: true, rol: 'gestor' });
  w.put('usuarios/u1', { activo: true, rol: 'motorizado' });
  w.put('motorizado/m1', { authUid: 'u1', nombre: 'Luigi' });
  w.put('motorizado/m2', { authUid: 'u2', nombre: 'Otro' });
  w.put('usuarios/u2', { activo: true, rol: 'motorizado' });
}

const orden = (ms: number, extra: Doc = {}): Doc => ({
  estado: 'entregado', asignacion: { motorizadoId: 'm1', motorizadoAuthUid: 'u1' }, entregadoAt: TS(ms),
  confirmacion: { precioFinalCordobas: 100, comisionBaseCordobas: 100, comisionBaseOrigen: 'tarifa_distancia' }, precioDesglose: { deliveryBase: 100 }, pagoDelivery: { quienPaga: 'efectivo' }, ...extra,
});
const deposito = (monto: number, estado = 'confirmado', extra: Doc = {}): Doc => ({
  motorizadoUid: 'u1', tipo: 'recaudacion_motorizado_storkhub', estado, montoTotal: monto, solicitudIds: ['o1', 'o2'], creadoAt: TS(MID), ...extra,
});
const gasto = (monto: number, extra: Doc = {}): Doc => ({ motorizadoId: 'm1', estado: 'aprobado', monto, tipo: 'otro_gasto_operativo', fecha: TS(MID), ...extra });
const adelanto = (monto: number, extra: Doc = {}): Doc => ({
  tipo: 'adelanto_motorizado', estado: 'activo', motorizadoId: 'm1', monto, semanaKey: SEM, at: TS(MID), ...extra,
});
const saldo = (pendiente: number, extra: Doc = {}): Doc => ({
  motorizadoId: 'm1', motorizadoUid: 'u1', tipo: 'deposito_no_realizado', montoOriginal: pendiente, saldoPendiente: pendiente, estado: 'pendiente', origen: 'deposito', abonos: [], ...extra,
});

/** Dos órdenes de C$100: comisión 160, efectivo 200. */
function semanaNormal(w: Mundo) {
  base(w);
  w.put('solicitudes_envio/o1', orden(MID));
  w.put('solicitudes_envio/o2', orden(MID + 3600_000));
}
const crear = (w: Mundo, extra: Doc = {}, uid = 'a1') =>
  crearLiquidacionMotorizadoCore(w.depsLiq, uid, { motorizadoId: 'm1', semanaKey: SEM, operacionId: OP, ...extra });
const LIQ = `m1_${SEM}`;

// ── Validación del payload ───────────────────────────────────────────────────

test('el payload humano es SOLO { motorizadoId, semanaKey, operacionId, saldos }: ningún campo financiero se acepta', () => {
  const ok = { motorizadoId: 'm1', semanaKey: SEM, operacionId: OP };
  assert.ok(validarPeticionCrearLiquidacion(ok));
  for (const extra of ['netoAPagar', 'comision', 'efectivo', 'gastosIds', 'adelantosIds', 'ordenesIds', 'depositosIds', 'estado', 'actor', 'rol', 'creadoAt', 'monto', 'adelantos']) {
    assert.throws(() => validarPeticionCrearLiquidacion({ ...ok, [extra]: 1 }), codigo('invalid-argument'), extra);
  }
  assert.throws(() => validarPeticionCrearLiquidacion({ ...ok, saldos: [{ saldoId: 's1', monto: 5 }] }), codigo('invalid-argument'));
  assert.throws(() => validarPeticionCrearLiquidacion({ ...ok, saldos: [{ saldoId: 's1' }, { saldoId: 's1' }] }), codigo('invalid-argument'));
  assert.throws(() => validarPeticionCrearLiquidacion({ ...ok, saldos: [{ saldoId: 's1', tope: 0 }] }), codigo('invalid-argument'));
  assert.throws(() => validarPeticionCrearLiquidacion({ ...ok, saldos: [{ saldoId: 's1', tope: 1.234 }] }), codigo('invalid-argument'));
  assert.throws(() => validarPeticionCrearLiquidacion({ ...ok, semanaKey: '2026-W99' }), codigo('invalid-argument'));
  assert.throws(() => validarPeticionCrearLiquidacion({ ...ok, operacionId: 'corto' }), codigo('invalid-argument'));
});

// ── L · creación ─────────────────────────────────────────────────────────────

test('L1 · liquidación válida con neto > 0: documento completo, ids exactos, sin movimientos ni saldo', async () => {
  const w = mundo(); semanaNormal(w);
  w.put('ordenes_deposito/d1', deposito(200));
  const r = await crear(w);
  assert.equal(r.resultado, 'creada');
  assert.equal(r.netoAPagar, 160);
  assert.equal(r.saldoGeneradoId, null);
  const l = w.raw(`liquidaciones_motorizado/${LIQ}`);
  assert.equal(l.estado, 'pendiente');
  assert.equal(l.comision, 160); assert.equal(l.comisionPct, 0.8); assert.equal(l.efectivoEsperado, 200);
  assert.equal(l.totalViajes, 2); assert.equal(l.totalGenerado, 200); assert.equal(l.faltantesDeposito, 0);
  assert.deepEqual(l.ordenesIds, ['o1', 'o2']); assert.deepEqual(l.depositosIds, ['d1']);
  assert.deepEqual(l.gastosIds, []); assert.deepEqual(l.adelantosIds, []); assert.deepEqual(l.deudasAplicadasIds, []);
  assert.equal(l.otrosDescuentos, 0);
  assert.equal(l.motorizadoUid, 'u1'); assert.equal(l.motorizadoNombre, 'Luigi'); assert.equal(l.semanaKey, SEM);
  assert.equal(l.creadoPorUid, 'a1'); assert.equal(l.creadoPorRol, 'admin');
  assert.equal((l.semanaInicio as { __ms: number }).__ms, INI); assert.equal((l.semanaFin as { __ms: number }).__ms, FIN);
  assert.equal(w.movimientos().length, 0); assert.equal(w.saldos().length, 0);
  assert.equal(w.escrituras, 2); // liquidación + marcador
  assert.equal(w.operaciones().length, 1);
});

test('L2 · neto = 0: no crea saldo ni movimiento', async () => {
  const w = mundo(); semanaNormal(w);
  w.put('ordenes_deposito/d1', deposito(200));
  w.put('movimientos_financieros/ad1', adelanto(160));
  const r = await crear(w);
  assert.equal(r.netoAPagar, 0); assert.equal(r.saldoGeneradoId, null);
  assert.equal(w.saldos().length, 0);
  assert.equal(w.movimientos().length, 1); // solo el adelanto sembrado
});

test('L3/N1-N7 · neto < 0: UN saldo (origen liquidación, |neto|, enlazado) y UN saldo_creado 1:1 con las cuentas aprobadas', async () => {
  const w = mundo(); semanaNormal(w); // sin depósitos: faltante 200 → neto = 160 − 200 = −40
  const r = await crear(w);
  assert.equal(r.netoAPagar, -40);
  assert.equal(r.saldoGeneradoId, `saldo_${LIQ}`);
  const [s] = w.saldos();
  assert.equal(s.id, `saldo_${LIQ}`);
  assert.equal(s.data.montoOriginal, 40); assert.equal(s.data.saldoPendiente, 40); assert.equal(s.data.estado, 'pendiente');
  assert.equal(s.data.origen, 'liquidacion'); assert.equal(s.data.liquidacionId, LIQ); assert.equal(s.data.motorizadoId, 'm1'); assert.equal(s.data.motorizadoUid, 'u1');
  assert.equal(s.data.tipo, 'deposito_no_realizado'); assert.deepEqual(s.data.abonos, []); assert.equal(s.data.creadoPorRol, 'admin');
  const movs = w.movimientos();
  assert.equal(movs.length, 1);
  const m = movs[0].data;
  assert.equal(m.tipo, 'saldo_creado'); assert.equal(m.monto, 40); assert.equal(m.saldoId, s.id); assert.equal(m.liquidacionId, LIQ);
  assert.equal(m.cuentaOrigen, 'ajuste_liquidacion'); assert.equal(m.cuentaDestino, 'deuda_motorizado:m1'); assert.equal(m.propietario, 'motorizado:m1');
  assert.equal(m.estado, 'activo'); assert.equal(m.creadoPorUid, 'a1'); assert.equal(m.creadoPorRol, 'admin');
  assert.equal(w.movimientos().filter((x) => x.data.tipo === 'liquidacion_pago_efectivo').length, 0); // N8: nunca un pago negativo
  assert.equal(w.raw(`liquidaciones_motorizado/${LIQ}`).saldoGeneradoId, s.id);
  assert.equal(w.raw(`liquidaciones_motorizado/${LIQ}`).faltantesDeposito, 200);
  // N9: el retry no duplica
  const antes = w.snapshot();
  const r2 = await crear(w);
  assert.equal(r2.resultado, 'ya_creada'); assert.equal(r2.saldoGeneradoId, `saldo_${LIQ}`); assert.equal(w.snapshot(), antes);
});

test('L4/L5 · la semana en curso y las futuras se rechazan (semana_no_cerrada), sin leer ni escribir', async () => {
  const w = mundo(); semanaNormal(w);
  const antes = w.snapshot();
  await assert.rejects(crear(w, { semanaKey: semanaKeyDeFecha(AHORA) }), codigo('failed-precondition', 'semana_no_cerrada'));
  await assert.rejects(crear(w, { semanaKey: '2026-W30' }), codigo('failed-precondition', 'semana_no_cerrada'));
  assert.equal(w.snapshot(), antes);
});

test('L4b · el cierre de la semana es en Managua: el domingo a las 23:59:59 Managua aún NO está cerrada; un instante después sí', async () => {
  const w = mundo(); semanaNormal(w);
  const justoAntes = { ...w.depsLiq, ahora: () => new Date(FIN) };
  await assert.rejects(crearLiquidacionMotorizadoCore(justoAntes, 'a1', { motorizadoId: 'm1', semanaKey: SEM, operacionId: OP }), codigo('failed-precondition', 'semana_no_cerrada'));
  const despues = { ...w.depsLiq, ahora: () => new Date(FIN + 1) };
  const r = await crearLiquidacionMotorizadoCore(despues, 'a1', { motorizadoId: 'm1', semanaKey: SEM, operacionId: OP });
  assert.equal(r.resultado, 'creada');
});

test('L6/L7 · el actor y su rol salen del servidor (admin y gestor); un no-staff no puede', async () => {
  const w1 = mundo(); semanaNormal(w1); w1.put('ordenes_deposito/d1', deposito(200));
  await crear(w1, {}, 'a1');
  assert.equal(w1.raw(`liquidaciones_motorizado/${LIQ}`).creadoPorRol, 'admin');
  const w2 = mundo(); semanaNormal(w2); w2.put('ordenes_deposito/d1', deposito(200));
  await crear(w2, {}, 'g1');
  assert.equal(w2.raw(`liquidaciones_motorizado/${LIQ}`).creadoPorRol, 'gestor'); assert.equal(w2.raw(`liquidaciones_motorizado/${LIQ}`).creadoPorUid, 'g1');
  const w3 = mundo(); semanaNormal(w3);
  await assert.rejects(crear(w3, {}, 'u1'), codigo('permission-denied'));
  await assert.rejects(crearLiquidacionMotorizadoCore(w3.depsLiq, undefined, { motorizadoId: 'm1', semanaKey: SEM, operacionId: OP }), codigo('unauthenticated'));
  w3.put('usuarios/inactivo', { activo: false, rol: 'admin' });
  await assert.rejects(crear(w3, {}, 'inactivo'), codigo('permission-denied'));
  assert.equal(w3.liquidaciones().length, 0); assert.equal(w3.escrituras, 0);
});

test('L8 · motorizado inválido: inexistente, sin acceso o sin rol motorizado', async () => {
  const w = mundo(); semanaNormal(w); const antes = w.snapshot();
  await assert.rejects(crear(w, { motorizadoId: 'nadie' }), codigo('failed-precondition', 'motorizado_inexistente'));
  w.put('motorizado/m3', { nombre: 'Sin acceso' });
  await assert.rejects(crear(w, { motorizadoId: 'm3' }), codigo('failed-precondition', 'motorizado_invalido'));
  w.put('motorizado/m4', { authUid: 'u4', nombre: 'Gestor disfrazado' }); w.put('usuarios/u4', { activo: true, rol: 'gestor' });
  await assert.rejects(crear(w, { motorizadoId: 'm4' }), codigo('failed-precondition', 'motorizado_invalido'));
  assert.notEqual(w.snapshot(), antes); // solo por los puts de la prueba
  assert.equal(w.liquidaciones().length, 0);
});

test('L9/L10 · idempotencia: el retry responde ya_creada sin escribir; otro payload con el mismo operacionId es operacion_inconsistente', async () => {
  const w = mundo(); semanaNormal(w); w.put('ordenes_deposito/d1', deposito(200));
  w.put('saldos_cargo_motorizado/s1', saldo(50));
  await crear(w, { saldos: [{ saldoId: 's1' }] });
  const antes = w.snapshot(); const esc = w.escrituras;
  const r = await crear(w, { saldos: [{ saldoId: 's1' }] });
  assert.equal(r.resultado, 'ya_creada'); assert.equal(r.liquidacionId, LIQ);
  assert.equal(w.snapshot(), antes); assert.equal(w.escrituras, esc);
  await assert.rejects(crear(w, { saldos: [] }), codigo('failed-precondition', 'operacion_inconsistente'));
  await assert.rejects(crear(w, { saldos: [{ saldoId: 's1', tope: 10 }] }), codigo('failed-precondition', 'operacion_inconsistente'));
  assert.equal(w.snapshot(), antes);
});

test('L11 · liquidación moderna duplicada (otro operacionId): liquidacion_existente, sin escrituras', async () => {
  const w = mundo(); semanaNormal(w); w.put('ordenes_deposito/d1', deposito(200));
  await crear(w);
  const antes = w.snapshot();
  await assert.rejects(crear(w, { operacionId: OP2 }), codigo('failed-precondition', 'liquidacion_existente'));
  assert.equal(w.snapshot(), antes);
});

test('L12/L13 · legacy: una liquidación con id aleatorio de esa semana → liquidacion_existente; más de una → conciliacion_requerida', async () => {
  const w = mundo(); semanaNormal(w); w.put('ordenes_deposito/d1', deposito(200));
  w.put('liquidaciones_motorizado/legacy_1', { motorizadoId: 'm1', semanaKey: SEM, estado: 'pagado' });
  await assert.rejects(crear(w), codigo('failed-precondition', 'liquidacion_existente'));
  w.put('liquidaciones_motorizado/legacy_2', { motorizadoUid: 'u1', semanaKey: SEM, estado: 'pendiente' }); // solo con uid
  await assert.rejects(crear(w), codigo('failed-precondition', 'conciliacion_requerida'));
  // moderna + legacy también es conciliación
  const w2 = mundo(); semanaNormal(w2);
  w2.put(`liquidaciones_motorizado/${LIQ}`, { motorizadoId: 'm1', semanaKey: SEM, estado: 'pendiente' });
  w2.put('liquidaciones_motorizado/legacy_x', { motorizadoId: 'm1', semanaKey: SEM, estado: 'pagado' });
  await assert.rejects(crear(w2), codigo('failed-precondition', 'conciliacion_requerida'));
  // otra semana del mismo motorizado no estorba
  const w3 = mundo(); semanaNormal(w3); w3.put('ordenes_deposito/d1', deposito(200));
  w3.put('liquidaciones_motorizado/otra', { motorizadoId: 'm1', semanaKey: '2026-W19', estado: 'pagado' });
  assert.equal((await crear(w3)).resultado, 'creada');
});

test('FIN1E-G1 · una orden candidata que ya figura en el ordenesIds de OTRA liquidación del mismo motorizado → conciliacion_requerida, 0 escrituras', async () => {
  for (const [nombre, previa] of [
    ['moderna de otra semana (pagada)', { motorizadoId: 'm1', motorizadoUid: 'u1', semanaKey: '2026-W19', estado: 'pagado', ordenesIds: ['o1', 'ox'] }],
    ['moderna de otra semana (pendiente)', { motorizadoId: 'm1', motorizadoUid: 'u1', semanaKey: '2026-W19', estado: 'pendiente', ordenesIds: ['o2'] }],
    ['legacy que SÍ declara la orden (solo con uid)', { motorizadoUid: 'u1', semanaKey: '2026-W18', estado: 'pagado', ordenesIds: ['o1'] }],
  ] as const) {
    const w = mundo(); semanaNormal(w); w.put('ordenes_deposito/d1', deposito(200));
    w.put('liquidaciones_motorizado/liq_previa', previa as unknown as Doc);
    const antes = w.snapshot(); const esc = w.escrituras;
    await assert.rejects(crear(w), codigo('failed-precondition', 'conciliacion_requerida'), nombre);
    assert.equal(w.snapshot(), antes, nombre); assert.equal(w.escrituras, esc, nombre); assert.equal(w.liquidaciones().length, 1, nombre);
  }
});

test('FIN1E-G2 · CONTROL: sin orden repetida la liquidación sigue su flujo — la previa sin ordenesIds (legacy), con ordenes de OTRO motorizado o con otras órdenes no estorba', async () => {
  for (const [nombre, previa] of [
    ['legacy sin ordenesIds', { motorizadoId: 'm1', semanaKey: '2026-W19', estado: 'pagado' }],
    ['ordenesIds sin ninguna candidata', { motorizadoId: 'm1', motorizadoUid: 'u1', semanaKey: '2026-W19', estado: 'pagado', ordenesIds: ['otraOrden'] }],
    ['ordenesIds no es un arreglo', { motorizadoId: 'm1', semanaKey: '2026-W19', estado: 'pagado', ordenesIds: 'o1' }],
    ['la repetida está en la liquidación de OTRO motorizado', { motorizadoId: 'm2', motorizadoUid: 'u2', semanaKey: '2026-W19', estado: 'pagado', ordenesIds: ['o1', 'o2'] }],
  ] as const) {
    const w = mundo(); semanaNormal(w); w.put('ordenes_deposito/d1', deposito(200));
    w.put('liquidaciones_motorizado/liq_previa', previa as unknown as Doc);
    assert.equal((await crear(w)).resultado, 'creada', nombre);
  }
});

test('L14 · las órdenes de la semana se derivan en horario de Managua, de ESTE motorizado y solo entregadas', async () => {
  const w = mundo(); base(w);
  w.put('solicitudes_envio/dentro_ini', orden(INI));              // lunes 00:00:00.000 Managua
  w.put('solicitudes_envio/dentro_fin', orden(FIN));              // domingo 23:59:59.999 Managua
  w.put('solicitudes_envio/antes', orden(INI - 1));               // domingo anterior 23:59:59.999
  w.put('solicitudes_envio/despues', orden(FIN + 1));             // lunes siguiente 00:00:00
  w.put('solicitudes_envio/ajena', orden(MID, { asignacion: { motorizadoId: 'm2' } }));
  w.put('solicitudes_envio/no_entregada', orden(MID, { estado: 'en_camino' }));
  w.put('solicitudes_envio/sin_fecha', orden(MID, { entregadoAt: undefined }));
  w.put('solicitudes_envio/respaldo', { ...orden(MID), entregadoAt: undefined, historial: { entregadoAt: TS(MID) } });
  w.put('ordenes_deposito/d1', deposito(300, 'confirmado', { solicitudIds: ['dentro_fin', 'dentro_ini', 'respaldo'] }));
  await crear(w);
  assert.deepEqual(w.raw(`liquidaciones_motorizado/${LIQ}`).ordenesIds, ['dentro_fin', 'dentro_ini', 'respaldo']);
});

test('L14b · sin viajes en la semana no hay nada que liquidar', async () => {
  const w = mundo(); base(w);
  await assert.rejects(crear(w), codigo('failed-precondition', 'sin_viajes'));
  assert.equal(w.liquidaciones().length, 0);
});

test('L15 · el efectivo es EXACTAMENTE el de los depósitos (calcularDeposito), no la suma de precioFinal', () => {
  const casos: Doc[] = [
    orden(MID),
    orden(MID, { pagoDelivery: { quienPaga: 'transferencia' } }),
    orden(MID, { pagoDelivery: { quienPaga: 'credito_semanal' } }),
    orden(MID, { tipoCliente: 'credito' }),
    orden(MID, { cobrosMotorizado: { delivery: { recibio: false } } }),
    orden(MID, { cobroContraEntrega: { aplica: true, monto: 50 }, pagoDelivery: { quienPaga: 'efectivo', deducirDelCobroContraEntrega: true } }),
    orden(MID, { tipoServicio: 'fuera_managua', confirmacion: {}, pagoDelivery: { quienPaga: 'efectivo', montoSugerido: 150 } }),
  ];
  for (const o of casos) assert.equal(efectivoAStorkhubOrden(o), aCentavos(calcularDeposito(o).totalAStorkhub));
});

test('L16 · el crédito semanal NO es efectivo (pero sí genera comisión)', async () => {
  const w = mundo(); base(w);
  w.put('solicitudes_envio/o1', orden(MID, { pagoDelivery: { quienPaga: 'credito_semanal' } }));
  w.put('solicitudes_envio/o2', orden(MID, { tipoCliente: 'credito' }));
  await crear(w);
  const l = w.raw(`liquidaciones_motorizado/${LIQ}`);
  assert.equal(l.efectivoEsperado, 0); assert.equal(l.faltantesDeposito, 0); assert.equal(l.comision, 160); assert.equal(l.netoAPagar, 160);
});

test('L17 · el delivery que el motorizado declaró NO recibido no es efectivo', async () => {
  const w = mundo(); base(w);
  w.put('solicitudes_envio/o1', orden(MID, { cobrosMotorizado: { delivery: { recibio: false, justificacion: 'cliente no pagó' } } }));
  w.put('solicitudes_envio/o2', orden(MID));
  w.put('ordenes_deposito/d1', deposito(100));
  await crear(w);
  const l = w.raw(`liquidaciones_motorizado/${LIQ}`);
  assert.equal(l.efectivoEsperado, 100); assert.equal(l.faltantesDeposito, 0);
});

test('L18 · el delivery deducido del cobro contra entrega solo cuenta lo que el CE cubrió', async () => {
  const w = mundo(); base(w);
  w.put('solicitudes_envio/o1', orden(MID, { cobroContraEntrega: { aplica: true, monto: 40 }, pagoDelivery: { quienPaga: 'efectivo', deducirDelCobroContraEntrega: true } }));
  await crear(w);
  assert.equal(w.raw(`liquidaciones_motorizado/${LIQ}`).efectivoEsperado, 40);
});

test('L19 · fuera de Managua SIN precio confirmado ya NO usa el monto sugerido del cliente: no se liquida (conciliacion_requerida), 0 escrituras', async () => {
  const w = mundo(); base(w);
  w.put('solicitudes_envio/o1', orden(MID, { tipoServicio: 'fuera_managua', confirmacion: {}, pagoDelivery: { quienPaga: 'efectivo', montoSugerido: 150 } }));
  const antes = w.snapshot(); const esc = w.escrituras;
  await assert.rejects(crear(w), codigo('failed-precondition', 'conciliacion_requerida'));
  assert.equal(w.snapshot(), antes); assert.equal(w.escrituras, esc);
  // y calcularDeposito ya no le inventa un delivery
  assert.equal(efectivoAStorkhubOrden({ tipoServicio: 'fuera_managua', confirmacion: {}, pagoDelivery: { quienPaga: 'efectivo', montoSugerido: 888888 } }), 0);
});

// ── PRECIO-CONFIRMADO-ANTES-DE-OPERAR-1 · la comisión solo se paga sobre una base que el servidor aprobó ──

const conSnapshot = (base: number, final: number, extra: Doc = {}): Doc => ({ confirmacion: { precioFinalCordobas: final, comisionBaseCordobas: base, comisionBaseOrigen: 'tarifa_distancia' }, ...extra });

test('FIN1F-F8 / E1 · el deliveryBase fabricado por el cliente (5000) NO mueve la comisión: se paga sobre la base aprobada (150)', async () => {
  const w = mundo(); base(w);
  w.put('solicitudes_envio/o1', orden(MID, { ...conSnapshot(150, 150), precioDesglose: { deliveryBase: 5000, totalCobrado: 5000 }, cotizacion: { distanciaKm: 13.859 } }));
  w.put('ordenes_deposito/d1', deposito(150, 'confirmado', { solicitudIds: ['o1'] }));
  await crear(w);
  const l = w.raw(`liquidaciones_motorizado/${LIQ}`);
  assert.equal(l.comision, 120); assert.equal(l.netoAPagar, 120); assert.notEqual(l.comision, 4000);
});

test('FIN1F-F9 / E2 · una orden ENTREGADA sin precio confirmado no paga comisión: conciliacion_requerida, 0 escrituras', async () => {
  const w = mundo(); base(w);
  w.put('solicitudes_envio/o1', orden(MID, { confirmacion: undefined, precioDesglose: { deliveryBase: 150 }, cotizacion: { distanciaKm: 13.859 } }));
  delete (w.raw('solicitudes_envio/o1') as Doc).confirmacion;
  const antes = w.snapshot(); const esc = w.escrituras;
  await assert.rejects(crear(w), (e: unknown) => codigo('failed-precondition', 'conciliacion_requerida')(e) && (e as { details?: { motivoPrecio?: string } }).details?.motivoPrecio === 'sin_precio_confirmado');
  assert.equal(w.snapshot(), antes); assert.equal(w.escrituras, esc); assert.equal(w.liquidaciones().length, 0);
});

test('FIN1F-F10 / SH-0012 · precio final 260 = base 210 + recargo 50: la comisión sigue siendo el 80% de 210 (168), NO de 260', async () => {
  const w = mundo(); base(w);
  w.put('solicitudes_envio/o1', orden(MID, conSnapshot(210, 260, { precioDesglose: { deliveryBase: 210, recargoZona: 50, totalCobrado: 260 } })));
  w.put('ordenes_deposito/d1', deposito(260, 'confirmado', { solicitudIds: ['o1'] }));
  await crear(w);
  const l = w.raw(`liquidaciones_motorizado/${LIQ}`);
  assert.equal(l.comision, 168); assert.notEqual(l.comision, 208);
});

test('FIN1F-F10b · lo mismo SIN snapshot (orden anterior al cambio): la base se deriva de la distancia (21.759 km → 210), no del precio final', async () => {
  const w = mundo(); base(w);
  w.put('solicitudes_envio/o1', orden(MID, { confirmacion: { precioFinalCordobas: 260 }, precioDesglose: { deliveryBase: 210, recargoZona: 50, totalCobrado: 260 }, cotizacion: { distanciaKm: 21.759 } }));
  w.put('ordenes_deposito/d1', deposito(260, 'confirmado', { solicitudIds: ['o1'] }));
  await crear(w);
  assert.equal(w.raw(`liquidaciones_motorizado/${LIQ}`).comision, 168);
});

test('FIN1F-SH0010 · regresión del caso legítimo: 13.859 km → 150, confirmado 150 ⇒ comisión 120, igual que antes', async () => {
  const w = mundo(); base(w);
  w.put('solicitudes_envio/o1', orden(MID, { confirmacion: { precioFinalCordobas: 150 }, precioDesglose: { deliveryBase: 150, totalCobrado: 150 }, cotizacion: { distanciaKm: 13.859, precioSugerido: 150 } }));
  w.put('ordenes_deposito/d1', deposito(150, 'confirmado', { solicitudIds: ['o1'] }));
  await crear(w);
  const l = w.raw(`liquidaciones_motorizado/${LIQ}`);
  assert.equal(l.comision, 120); assert.equal(l.netoAPagar, 120);
});

test('FIN1F-LEG · sin snapshot, una cotización que NO se demuestra con la tarifa no se paga (inconsistente / incompleta), con motivo y 0 escrituras', async () => {
  for (const [nombre, extra, motivo] of [
    ['deliveryBase fabricado contra la distancia', { precioDesglose: { deliveryBase: 5000 }, cotizacion: { distanciaKm: 13.859 } }, 'cotizacion_inconsistente'],
    ['deliveryBase sin distancia verificable', { precioDesglose: { deliveryBase: 5000 } }, 'cotizacion_incompleta'],
    ['deliveryBase con distancia fuera del tarifario', { precioDesglose: { deliveryBase: 5000 }, cotizacion: { distanciaKm: 80 } }, 'cotizacion_inconsistente'],
  ] as const) {
    const w = mundo(); base(w);
    w.put('solicitudes_envio/o1', orden(MID, { confirmacion: { precioFinalCordobas: 150 }, ...extra } as Doc));
    const antes = w.snapshot(); const esc = w.escrituras;
    await assert.rejects(crear(w), (e: unknown) => codigo('failed-precondition', 'conciliacion_requerida')(e) && (e as { details?: { motivoPrecio?: string } }).details?.motivoPrecio === motivo, nombre);
    assert.equal(w.snapshot(), antes, nombre); assert.equal(w.escrituras, esc, nombre);
  }
});

test('FIN1F-LEG2 · una orden anterior SIN desglose ni cotización ya NO toma el precio final como base (podría traer recargos): conciliacion_requerida / base_comision_requerida, 0 escrituras', async () => {
  const w = mundo(); base(w);
  w.put('solicitudes_envio/o1', orden(MID, { confirmacion: { precioFinalCordobas: 50 }, precioDesglose: undefined }));
  const antes = w.snapshot(); const esc = w.escrituras;
  await assert.rejects(crear(w), (e: unknown) => codigo('failed-precondition', 'conciliacion_requerida')(e) && (e as { details?: { motivoPrecio?: string } }).details?.motivoPrecio === 'base_comision_requerida');
  assert.equal(w.snapshot(), antes); assert.equal(w.escrituras, esc);
});

test('L20 · un depósito relevante NO terminal bloquea la liquidación; anulado, rechazado, sin órdenes de la semana y de comercio no', async () => {
  for (const estado of ['pendiente_boucher', 'en_revision', 'devuelto', 'estado_desconocido']) {
    const w = mundo(); semanaNormal(w); w.put('ordenes_deposito/dp', deposito(200, estado));
    const antes = w.snapshot();
    await assert.rejects(crear(w), codigo('failed-precondition', 'deposito_pendiente_conciliacion'), estado);
    assert.equal(w.snapshot(), antes);
  }
  const w = mundo(); semanaNormal(w);
  w.put('ordenes_deposito/anulado', deposito(999, 'anulado'));
  w.put('ordenes_deposito/rechazado', deposito(999, 'rechazado'));
  w.put('ordenes_deposito/sin_ordenes_de_la_semana', deposito(999, 'en_revision', { solicitudIds: ['otra1', 'otra2'] })); // creado en la semana, pero de OTRAS órdenes
  w.put('ordenes_deposito/comercio', deposito(999, 'en_revision', { tipo: 'recaudacion_motorizado_comercio' }));
  w.put('ordenes_deposito/ajeno', deposito(999, 'en_revision', { motorizadoUid: 'u2' }));
  w.put('ordenes_deposito/ok', deposito(200));
  await crear(w);
  const l = w.raw(`liquidaciones_motorizado/${LIQ}`);
  assert.deepEqual(l.depositosIds, ['ok']); assert.equal(l.faltantesDeposito, 0);
});

test('L20b · un depósito convertido en deuda SUMA (su faltante ya es un saldo)', async () => {
  const w = mundo(); semanaNormal(w);
  w.put('ordenes_deposito/d1', deposito(200, 'convertido_en_deuda'));
  const r = await crear(w);
  assert.equal(r.netoAPagar, 160);
});

// ── D · depósitos: la semana económica la dan sus órdenes, no su creadoAt ──────

const DOMINGO = FIN - 3600_000; // domingo 22:59 (Managua): órdenes de la semana
const LUNES_ORDEN = FIN + 3 * 3600_000; // lunes siguiente: orden de OTRA semana
const LUNES_DEPOSITO = FIN + 2 * 3600_000; // el depósito se crea el lunes

/** Semana con una orden del domingo y otra de mitad de semana; una orden del lunes siguiente (otra semana) existe aparte. */
function semanaConDomingo(w: Mundo) {
  base(w);
  w.put('solicitudes_envio/o1', orden(MID));
  w.put('solicitudes_envio/oDom', orden(DOMINGO));
  w.put('solicitudes_envio/oLun', orden(LUNES_ORDEN));
}

test('D1 · el efectivo del domingo depositado el lunes se reconoce en la semana ANTERIOR (no en la del creadoAt)', async () => {
  const w = mundo(); semanaConDomingo(w);
  w.put('ordenes_deposito/dLun', deposito(200, 'confirmado', { solicitudIds: ['o1', 'oDom'], creadoAt: TS(LUNES_DEPOSITO) }));
  const r = await crear(w);
  const l = w.raw(`liquidaciones_motorizado/${LIQ}`);
  assert.deepEqual(l.depositosIds, ['dLun']); assert.equal(l.totalDepositado, 200); assert.equal(l.faltantesDeposito, 0); assert.equal(r.netoAPagar, 160);
  assert.equal(r.saldoGeneradoId, null);
});

test('D2 · el mismo depósito del lunes EN REVISIÓN (o pendiente de boucher) bloquea la semana anterior: createdAt del lunes no permite ignorarlo', async () => {
  for (const estado of ['en_revision', 'pendiente_boucher', 'devuelto']) {
    const w = mundo(); semanaConDomingo(w);
    w.put('ordenes_deposito/dLun', deposito(200, estado, { solicitudIds: ['o1', 'oDom'], creadoAt: TS(LUNES_DEPOSITO) }));
    const antes = w.snapshot();
    await assert.rejects(crear(w), codigo('failed-precondition', 'deposito_pendiente_conciliacion'), estado);
    assert.equal(w.snapshot(), antes, estado);
  }
});

test('D3 · un depósito del lunes SIN órdenes de la semana anterior no la afecta (ni suma ni bloquea), aunque esté pendiente', async () => {
  const w = mundo(); semanaConDomingo(w);
  w.put('ordenes_deposito/dLun', deposito(100, 'en_revision', { solicitudIds: ['oLun'], creadoAt: TS(LUNES_DEPOSITO) }));
  w.put('ordenes_deposito/dSem', deposito(200, 'confirmado', { solicitudIds: ['o1', 'oDom'], creadoAt: TS(MID) }));
  await crear(w);
  assert.deepEqual(w.raw(`liquidaciones_motorizado/${LIQ}`).depositosIds, ['dSem']);
});

test('D4/D5 · un depósito anulado o rechazado con órdenes de la semana no suma ni bloquea', async () => {
  for (const estado of ['anulado', 'rechazado']) {
    const w = mundo(); semanaConDomingo(w);
    w.put('ordenes_deposito/dX', deposito(200, estado, { solicitudIds: ['o1', 'oDom'], creadoAt: TS(LUNES_DEPOSITO) }));
    const r = await crear(w);
    const l = w.raw(`liquidaciones_motorizado/${LIQ}`);
    assert.deepEqual(l.depositosIds, [], estado); assert.equal(l.totalDepositado, 0, estado); assert.equal(l.faltantesDeposito, 200, estado); assert.equal(r.netoAPagar, -40, estado);
  }
});

test('D6 · un depósito que mezcla semanas aporta SOLO el efectivo de las órdenes de esta semana (sin prorrata ni todo el monto)', async () => {
  const w = mundo(); semanaConDomingo(w);
  // dMix: oDom (esta semana, 100) + oLun (la siguiente, 100) = 200 en total; la semana anterior solo reconoce la del domingo.
  w.put('ordenes_deposito/dMix', deposito(200, 'confirmado', { solicitudIds: ['oDom', 'oLun'], creadoAt: TS(LUNES_DEPOSITO) }));
  const r = await crear(w);
  const l = w.raw(`liquidaciones_motorizado/${LIQ}`);
  assert.deepEqual(l.depositosIds, ['dMix']); assert.equal(l.totalDepositado, 100); // NO 200
  assert.equal(l.efectivoEsperado, 200); assert.equal(l.faltantesDeposito, 100); assert.equal(r.netoAPagar, 160 - 100);
  const detalle = (l.depositosDetalle as Doc[])[0];
  assert.equal(detalle.completo, false); assert.equal(detalle.contribucion, 100); assert.deepEqual(detalle.ordenes, ['oDom']);
});

test('D6b · mezcla de semanas con un gasto LIGADO (ordenId) a una orden de esta semana: la contribución es neta de ese gasto', async () => {
  const w = mundo(); semanaConDomingo(w);
  w.put('gastos_motorizado/gx', gasto(20, { consumidoEnDepositoId: 'dMix', ordenId: 'oDom' }));
  w.put('ordenes_deposito/dMix', deposito(180, 'confirmado', { solicitudIds: ['oDom', 'oLun'], gastosIds: ['gx'], gastosDescontados: 20, creadoAt: TS(LUNES_DEPOSITO) }));
  await crear(w);
  const l = w.raw(`liquidaciones_motorizado/${LIQ}`);
  assert.equal(l.totalDepositado, 80); assert.equal(l.gastosEnDepositos, 20); // 100 − 20
  assert.equal(l.efectivoEsperado, 200); assert.equal(l.faltantesDeposito, 200 - 20 - 80);
});

test('D6c · un depósito con un gasto ligado a una orden de OTRA semana no le resta nada a esta', async () => {
  const w = mundo(); semanaConDomingo(w);
  w.put('gastos_motorizado/gx', gasto(20, { consumidoEnDepositoId: 'dMix', ordenId: 'oLun' }));
  w.put('ordenes_deposito/dMix', deposito(180, 'confirmado', { solicitudIds: ['oDom', 'oLun'], gastosIds: ['gx'], gastosDescontados: 20, creadoAt: TS(LUNES_DEPOSITO) }));
  await crear(w);
  const l = w.raw(`liquidaciones_motorizado/${LIQ}`);
  assert.equal(l.totalDepositado, 100); assert.equal(l.gastosEnDepositos, 0);
});

test('D7 · mezcla de semanas SIN atribución exacta (gasto no ligado a una orden, o gastos que recortan el monto) ⇒ conciliacion_requerida, 0 escrituras', async () => {
  const w = mundo(); semanaConDomingo(w);
  w.put('gastos_motorizado/gx', gasto(20, { consumidoEnDepositoId: 'dMix' })); // sin ordenId
  w.put('ordenes_deposito/dMix', deposito(180, 'confirmado', { solicitudIds: ['oDom', 'oLun'], gastosIds: ['gx'], gastosDescontados: 20, creadoAt: TS(LUNES_DEPOSITO) }));
  const antes = w.snapshot();
  await assert.rejects(crear(w), codigo('failed-precondition', 'conciliacion_requerida'));
  assert.equal(w.snapshot(), antes);
  // el gasto está ligado a una orden que NO es del depósito
  const w2 = mundo(); semanaConDomingo(w2);
  w2.put('gastos_motorizado/gx', gasto(20, { consumidoEnDepositoId: 'dMix', ordenId: 'o1' }));
  w2.put('ordenes_deposito/dMix', deposito(180, 'confirmado', { solicitudIds: ['oDom', 'oLun'], gastosIds: ['gx'], gastosDescontados: 20, creadoAt: TS(LUNES_DEPOSITO) }));
  await assert.rejects(crear(w2), codigo('failed-precondition', 'conciliacion_requerida'));
  // gastos mayores que el efectivo del depósito (el recorte a 0 pierde la parte de cada semana)
  const w3 = mundo(); semanaConDomingo(w3);
  w3.put('gastos_motorizado/gx', gasto(500, { consumidoEnDepositoId: 'dMix', ordenId: 'oDom' }));
  w3.put('ordenes_deposito/dMix', deposito(0, 'confirmado', { solicitudIds: ['oDom', 'oLun'], gastosIds: ['gx'], gastosDescontados: 500, creadoAt: TS(LUNES_DEPOSITO) }));
  await assert.rejects(crear(w3), codigo('failed-precondition', 'conciliacion_requerida'));
  assert.equal(w3.liquidaciones().length, 0);
});

test('D8 · una orden de la semana en dos depósitos vivos ⇒ conciliacion_requerida (cobertura duplicada), 0 escrituras', async () => {
  const w = mundo(); semanaNormal(w);
  w.put('ordenes_deposito/d1', deposito(200));
  w.put('ordenes_deposito/d2', deposito(100, 'confirmado', { solicitudIds: ['o1'] }));
  const antes = w.snapshot();
  await assert.rejects(crear(w), codigo('failed-precondition', 'conciliacion_requerida'));
  assert.equal(w.snapshot(), antes);
});

test('D9 · depósito anterior a solicitudIds, demostrable por el PUNTERO coherente de sus órdenes: se reconoce', async () => {
  const w = mundo(); base(w);
  const punt = { registro: { deposito: { storkhubDepositoId: 'dViejo' } } };
  w.put('solicitudes_envio/o1', orden(MID, punt)); w.put('solicitudes_envio/o2', orden(MID + 3600_000, punt));
  w.put('ordenes_deposito/dViejo', deposito(200, 'confirmado', { solicitudIds: undefined, creadoAt: TS(LUNES_DEPOSITO) }));
  const r = await crear(w);
  assert.deepEqual(w.raw(`liquidaciones_motorizado/${LIQ}`).depositosIds, ['dViejo']); assert.equal(r.netoAPagar, 160);
  // …y si su monto no cuadra con lo que el puntero demuestra, se concilia
  const w2 = mundo(); base(w2);
  w2.put('solicitudes_envio/o1', orden(MID, punt)); w2.put('solicitudes_envio/o2', orden(MID + 3600_000, punt));
  w2.put('ordenes_deposito/dViejo', deposito(150, 'confirmado', { solicitudIds: undefined }));
  await assert.rejects(crear(w2), codigo('failed-precondition', 'conciliacion_requerida'));
});

test('D10 · depósito sin solicitudIds y SIN punteros: no se demuestra a qué semana pertenece ⇒ conciliacion_requerida (nunca por fecha)', async () => {
  const w = mundo(); semanaNormal(w);
  w.put('ordenes_deposito/dHuerfano', deposito(200, 'confirmado', { solicitudIds: undefined, creadoAt: TS(MID) })); // creado EN la semana: igual no se adivina
  const antes = w.snapshot();
  await assert.rejects(crear(w), codigo('failed-precondition', 'conciliacion_requerida'));
  assert.equal(w.snapshot(), antes);
  // sus punteros señalan solo órdenes de OTRA semana: demostrablemente irrelevante
  const w2 = mundo(); semanaNormal(w2); w2.put('ordenes_deposito/dMio', deposito(200));
  w2.put('solicitudes_envio/oOtra', orden(INI - 5 * 86400_000, { registro: { deposito: { storkhubDepositoId: 'dViejo' } } }));
  w2.put('ordenes_deposito/dViejo', deposito(100, 'confirmado', { solicitudIds: undefined }));
  await crear(w2);
  assert.deepEqual(w2.raw(`liquidaciones_motorizado/${LIQ}`).depositosIds, ['dMio']);
  // un depósito anulado sin vínculo se ignora (no hay nada que demostrar)
  const w3 = mundo(); semanaNormal(w3); w3.put('ordenes_deposito/dMio', deposito(200));
  w3.put('ordenes_deposito/dAnulado', deposito(5, 'anulado', { solicitudIds: undefined }));
  await crear(w3);
});

test('D11/D12 · un depósito cuyo monto no cuadra con sus órdenes, o cuya orden apunta a OTRO depósito, no se acepta: conciliacion_requerida', async () => {
  const w = mundo(); semanaNormal(w);
  w.put('ordenes_deposito/d1', deposito(170)); // sus órdenes suman 200
  await assert.rejects(crear(w), codigo('failed-precondition', 'conciliacion_requerida'));
  const w2 = mundo(); base(w2);
  w2.put('solicitudes_envio/o1', orden(MID, { registro: { deposito: { storkhubDepositoId: 'otroDeposito' } } })); w2.put('solicitudes_envio/o2', orden(MID));
  w2.put('ordenes_deposito/d1', deposito(200));
  await assert.rejects(crear(w2), codigo('failed-precondition', 'conciliacion_requerida'));
  assert.equal(w2.liquidaciones().length, 0);
});

// ── G · gastos ───────────────────────────────────────────────────────────────

test('G1/G4 · un gasto libre de la semana entra, se captura y queda marcado con liquidacionId (sin tocar consumidoEnDepositoId)', async () => {
  const w = mundo(); semanaNormal(w);
  w.put('gastos_motorizado/g1', gasto(30));
  w.put('ordenes_deposito/d1', deposito(200)); // el depósito no consumió el gasto: su monto es el bruto de sus órdenes
  await crear(w);
  const l = w.raw(`liquidaciones_motorizado/${LIQ}`);
  assert.deepEqual(l.gastosIds, ['g1']); assert.equal(l.gastosAprobados, 30); assert.equal(l.faltantesDeposito, 0); assert.equal(l.gastosAsumidosStorkhub, 0);
  const g = w.raw('gastos_motorizado/g1');
  assert.equal(g.liquidacionId, LIQ); assert.equal(g.consumidoEnDepositoId, undefined); assert.equal(g.monto, 30); assert.equal(g.estado, 'aprobado');
});

test('G2 · un gasto consumido por un depósito NO entra (ni uno que otro depósito vivo lista sin marca); su monto ya va neto en el depósito', async () => {
  const w = mundo(); semanaNormal(w);
  w.put('gastos_motorizado/consumido', gasto(30, { consumidoEnDepositoId: 'd1' }));
  w.put('ordenes_deposito/d1', deposito(170, 'confirmado', { gastosIds: ['consumido'], gastosDescontados: 30 })); // 200 − 30
  await crear(w);
  const l = w.raw(`liquidaciones_motorizado/${LIQ}`);
  assert.deepEqual(l.gastosIds, []);
  assert.equal(l.gastosEnDepositos, 30); assert.equal(l.faltantesDeposito, 0); assert.equal(l.totalDepositado, 170);
  assert.equal(w.raw('gastos_motorizado/consumido').liquidacionId, undefined);
  // un depósito vivo (de OTRAS órdenes) que lista el gasto sin marca de consumo: tampoco se descuenta dos veces
  const w1 = mundo(); semanaNormal(w1);
  w1.put('gastos_motorizado/sin_marca', gasto(20));
  w1.put('ordenes_deposito/dy', deposito(0, 'confirmado', { solicitudIds: ['x1'], gastosIds: ['sin_marca'] }));
  w1.put('ordenes_deposito/d1', deposito(200));
  await crear(w1);
  assert.deepEqual(w1.raw(`liquidaciones_motorizado/${LIQ}`).gastosIds, []);
  assert.equal(w1.raw('gastos_motorizado/sin_marca').liquidacionId, undefined);
  // un depósito anulado que lo listaba ya no es dueño del gasto
  const w2 = mundo(); semanaNormal(w2);
  w2.put('gastos_motorizado/g1', gasto(20)); w2.put('ordenes_deposito/dx', deposito(0, 'anulado', { gastosIds: ['g1'] })); w2.put('ordenes_deposito/d1', deposito(200));
  await crear(w2);
  assert.deepEqual(w2.raw(`liquidaciones_motorizado/${LIQ}`).gastosIds, ['g1']);
});

test('G2b · un depósito anterior a FIN-2 (con gastos pero sin gastosDescontados) no se puede demostrar: conciliacion_requerida, 0 escrituras', async () => {
  const w = mundo(); semanaNormal(w);
  w.put('gastos_motorizado/viejo', gasto(40, { consumidoEnDepositoId: 'd1' }));
  w.put('ordenes_deposito/d1', deposito(160, 'confirmado', { gastosIds: ['viejo'] }));
  const antes = w.snapshot();
  await assert.rejects(crear(w), codigo('failed-precondition', 'conciliacion_requerida'));
  assert.equal(w.snapshot(), antes);
});

test('G3 · un gasto ya capturado por otra liquidación (liquidacionId) no entra; tampoco los anulados, de otro motorizado ni de otra semana', async () => {
  const w = mundo(); semanaNormal(w);
  w.put('gastos_motorizado/liquidado', gasto(30, { liquidacionId: 'm1_2026-W19' }));
  w.put('gastos_motorizado/anulado', gasto(30, { estado: 'anulado' }));
  w.put('gastos_motorizado/ajeno', gasto(30, { motorizadoId: 'm2' }));
  w.put('gastos_motorizado/otra_semana', gasto(30, { fecha: TS(FIN + 86400_000) }));
  w.put('gastos_motorizado/valido', gasto(10));
  w.put('ordenes_deposito/d1', deposito(200));
  await crear(w);
  assert.deepEqual(w.raw(`liquidaciones_motorizado/${LIQ}`).gastosIds, ['valido']);
  assert.equal(w.raw('gastos_motorizado/liquidado').liquidacionId, 'm1_2026-W19');
  assert.equal(w.raw('gastos_motorizado/otra_semana').liquidacionId, undefined);
});

test('G · los gastos que superan el efectivo los asume StorkHub (y suman al neto)', async () => {
  const w = mundo(); base(w);
  w.put('solicitudes_envio/o1', orden(MID));
  w.put('gastos_motorizado/g1', gasto(150));
  await crear(w);
  const l = w.raw(`liquidaciones_motorizado/${LIQ}`);
  assert.equal(l.gastosAsumidosStorkhub, 50); assert.equal(l.faltantesDeposito, 0); assert.equal(l.netoAPagar, 80 + 50);
});

test('G5 · un gasto retroactivo en una semana ya liquidada (pendiente o pagada, moderna o legacy) → semana_liquidada, 0 escrituras', async () => {
  const intentar = (w: Mundo) => crearGastoMotorizadoCore(w.depsGasto, 'a1', { operacionId: OP3, motorizadoId: 'm1', tipo: 'otro_gasto_operativo', monto: 10, fecha: '2026-05-13' });
  const w = mundo(); semanaNormal(w); w.put('ordenes_deposito/d1', deposito(200));
  await crear(w);
  const antes = w.snapshot(); const esc = w.escrituras;
  await assert.rejects(intentar(w), codigo('failed-precondition', 'semana_liquidada'));
  assert.equal(w.snapshot(), antes); assert.equal(w.escrituras, esc);
  await marcarLiquidacionPagadaCore(w.depsPagar, 'a1', { liquidacionId: LIQ, operacionId: OP2 });
  await assert.rejects(intentar(w), codigo('failed-precondition', 'semana_liquidada'));
  const w2 = mundo(); base(w2);
  w2.put('liquidaciones_motorizado/legacy', { motorizadoUid: 'u1', semanaKey: SEM, estado: 'pagado' });
  await assert.rejects(intentar(w2), codigo('failed-precondition', 'semana_liquidada'));
});

test('G6 · un gasto de otra semana (o sin fecha: hoy) sigue siendo válido aunque haya una liquidación', async () => {
  const w = mundo(); semanaNormal(w); w.put('ordenes_deposito/d1', deposito(200));
  await crear(w);
  const r = await crearGastoMotorizadoCore(w.depsGasto, 'a1', { operacionId: OP3, motorizadoId: 'm1', tipo: 'otro_gasto_operativo', monto: 10, fecha: '2026-05-19' });
  assert.equal(r.resultado, 'registrado');
  const r2 = await crearGastoMotorizadoCore(w.depsGasto, 'a1', { operacionId: 'op-99999999', motorizadoId: 'm1', tipo: 'otro_gasto_operativo', monto: 10 });
  assert.equal(r2.resultado, 'registrado');
});

test('G · el retry de un gasto ya creado sigue respondiendo ya_registrado aunque la semana se liquide después', async () => {
  const w = mundo(); semanaNormal(w); w.put('ordenes_deposito/d1', deposito(200));
  const payload = { operacionId: OP3, motorizadoId: 'm1', tipo: 'otro_gasto_operativo', monto: 10, fecha: '2026-05-12' };
  // se crea antes de existir la liquidación
  assert.equal((await crearGastoMotorizadoCore(w.depsGasto, 'a1', payload)).resultado, 'registrado');
  await crear(w);
  assert.equal((await crearGastoMotorizadoCore(w.depsGasto, 'a1', payload)).resultado, 'ya_registrado');
});

test('G7 · carrera: el depósito gana (consume el gasto mientras se liquida) → la liquidación relee y lo excluye', async () => {
  const w = mundo(); semanaNormal(w);
  w.put('gastos_motorizado/g1', gasto(30)); w.put('ordenes_deposito/d1', deposito(200));
  w.hooks.antesDeCommit = () => { w.put('gastos_motorizado/g1', gasto(30, { consumidoEnDepositoId: 'dX' })); w.bump(); };
  await crear(w);
  assert.deepEqual(w.raw(`liquidaciones_motorizado/${LIQ}`).gastosIds, []);
  assert.equal(w.raw('gastos_motorizado/g1').liquidacionId, undefined);
  assert.equal(w.raw('gastos_motorizado/g1').consumidoEnDepositoId, 'dX');
});

test('G8 · carrera: la liquidación gana → el gasto queda con liquidacionId y ya no es elegible (el depósito lo ve y no lo consume)', async () => {
  const w = mundo(); semanaNormal(w);
  w.put('gastos_motorizado/g1', gasto(30)); w.put('ordenes_deposito/d1', deposito(200));
  await crear(w);
  const g = w.raw('gastos_motorizado/g1');
  assert.equal(g.liquidacionId, LIQ);
  // la condición que el depósito ya aplica (deposito-monto.ts y esGastoElegibleParaDeposito): un gasto con liquidacionId no se descuenta
  assert.ok(typeof g.liquidacionId === 'string' && g.liquidacionId.length > 0);
});

// ── A · adelantos ────────────────────────────────────────────────────────────

test('A1/A2/A3/A4/A5 · adelantos: por semanaKey, activos, ids exactos', async () => {
  const w = mundo(); semanaNormal(w); w.put('ordenes_deposito/d1', deposito(200));
  w.put('movimientos_financieros/ad_a', adelanto(10));                                              // A1: activo, misma semana
  w.put('movimientos_financieros/ad_b', adelanto(20, { estado: 'anulado' }));                        // A2: anulado
  w.put('movimientos_financieros/ad_c', adelanto(30, { semanaKey: '2026-W19', at: TS(MID) }));      // A3: at dentro de la semana pero otra semanaKey
  w.put('movimientos_financieros/ad_d', adelanto(40, { at: TS(INI - 86400_000 * 10) }));            // A4: semanaKey correcta aunque at difiera
  w.put('movimientos_financieros/ad_e', adelanto(50, { motorizadoId: 'm2' }));                       // ajeno
  w.put('movimientos_financieros/ad_f', { tipo: 'gasto_aprobado', estado: 'activo', motorizadoId: 'm1', monto: 99, semanaKey: SEM });
  w.put('movimientos_financieros/ad_legacy', { tipo: 'adelanto_motorizado', estado: 'activo', motorizadoId: 'm1', monto: 5, at: TS(MID) }); // legacy sin semanaKey: por su at
  await crear(w);
  const l = w.raw(`liquidaciones_motorizado/${LIQ}`);
  assert.deepEqual(l.adelantosIds, ['ad_a', 'ad_d', 'ad_legacy']);
  assert.equal(l.adelantos, 55); assert.equal(l.netoAPagar, 160 - 55);
});

test('A8 · un adelanto activo sin semanaKey NI fecha legible (o con monto inválido) no se excluye en silencio: conciliacion_requerida, 0 liquidación', async () => {
  for (const [nombre, mov] of [
    ['sin semanaKey ni at', { tipo: 'adelanto_motorizado', estado: 'activo', motorizadoId: 'm1', monto: 30 }],
    ['sin semanaKey y at ilegible', { tipo: 'adelanto_motorizado', estado: 'activo', motorizadoId: 'm1', monto: 30, at: 'ayer' }],
    ['monto inválido', { tipo: 'adelanto_motorizado', estado: 'activo', motorizadoId: 'm1', monto: 'mucho', semanaKey: SEM }],
  ] as Array<[string, Doc]>) {
    const w = mundo(); semanaNormal(w); w.put('ordenes_deposito/d1', deposito(200)); w.put('movimientos_financieros/ad_raro', mov);
    const antes = w.snapshot();
    await assert.rejects(crear(w), codigo('failed-precondition', 'conciliacion_requerida'), nombre);
    assert.equal(w.snapshot(), antes, nombre); assert.equal(w.liquidaciones().length, 0, nombre);
  }
  // un adelanto anulado, o de otro motorizado, o de otra semana NO es ambiguo aunque esté incompleto
  const w = mundo(); semanaNormal(w); w.put('ordenes_deposito/d1', deposito(200));
  w.put('movimientos_financieros/a1', { tipo: 'adelanto_motorizado', estado: 'anulado', motorizadoId: 'm1', monto: 30 });
  w.put('movimientos_financieros/a2', { tipo: 'adelanto_motorizado', estado: 'activo', motorizadoId: 'm2', monto: 30 });
  w.put('movimientos_financieros/a3', adelanto(10, { semanaKey: '2026-W10' }));
  await crear(w);
  assert.deepEqual(w.raw(`liquidaciones_motorizado/${LIQ}`).adelantosIds, []);
});

test('A6 · carrera: la liquidación gana → registrar un adelanto de esa semana se rechaza (semana_liquidada)', async () => {
  const w = mundo(); semanaNormal(w); w.put('ordenes_deposito/d1', deposito(200));
  await crear(w);
  const antes = w.snapshot();
  await assert.rejects(
    registrarAdelantoMotorizadoCore(w.depsAdelanto, 'a1', { operacionId: OP3, motorizadoId: 'm1', monto: 10, semanaKey: SEM }),
    codigo('failed-precondition', 'semana_liquidada'),
  );
  assert.equal(w.snapshot(), antes);
});

test('A7 · carrera: el adelanto gana (se registra mientras se liquida) → la liquidación reintenta, lo relee y lo incluye', async () => {
  const w = mundo(); semanaNormal(w); w.put('ordenes_deposito/d1', deposito(200));
  w.hooks.antesDeCommit = () => { w.put('movimientos_financieros/adelanto_nuevo', adelanto(25)); w.bump(); };
  await crear(w);
  const l = w.raw(`liquidaciones_motorizado/${LIQ}`);
  assert.deepEqual(l.adelantosIds, ['adelanto_nuevo']); assert.equal(l.adelantos, 25); assert.equal(l.netoAPagar, 135);
});

// ── S · saldos ───────────────────────────────────────────────────────────────

test('S1/S9/S10/S11 · un saldo válido: se abona completo, 1 movimiento por abono con el actor real, el retry no duplica', async () => {
  const w = mundo(); semanaNormal(w); w.put('ordenes_deposito/d1', deposito(200));
  w.put('saldos_cargo_motorizado/s1', saldo(100));
  const r = await crear(w, { saldos: [{ saldoId: 's1' }] }, 'g1');
  assert.equal(r.deudasAplicadas, 100); assert.equal(r.netoAPagar, 60);
  const s = w.raw('saldos_cargo_motorizado/s1');
  assert.equal(s.saldoPendiente, 0); assert.equal(s.estado, 'pagado');
  const abonos = s.abonos as Doc[];
  assert.equal(abonos.length, 1);
  assert.equal(abonos[0].monto, 100); assert.equal(abonos[0].metodoAbono, 'descuento_liquidacion'); assert.equal(abonos[0].liquidacionId, LIQ);
  assert.equal(abonos[0].aplicacionId, `${LIQ}_s1`); assert.equal(abonos[0].creadoPorUid, 'g1'); assert.equal(abonos[0].creadoPorRol, 'gestor');
  const movs = w.movimientos();
  assert.equal(movs.length, 1);
  const m = movs[0].data;
  assert.equal(m.tipo, 'abono_deuda_motorizado'); assert.equal(m.monto, 100); assert.equal(m.saldoId, 's1'); assert.equal(m.liquidacionId, LIQ);
  assert.equal(m.cuentaOrigen, 'deuda_motorizado:m1'); assert.equal(m.cuentaDestino, 'recuperacion_deuda_liquidacion');
  assert.equal(m.creadoPorUid, 'g1'); assert.equal(m.creadoPorRol, 'gestor'); assert.equal(m.estado, 'activo');
  assert.equal(abonos[0].movimientoId, movs[0].id);
  const l = w.raw(`liquidaciones_motorizado/${LIQ}`);
  assert.deepEqual(l.deudasAplicadasIds, ['s1']); assert.equal(l.deudasAplicadas, 100);
  const antes = w.snapshot();
  await crear(w, { saldos: [{ saldoId: 's1' }] }, 'g1');
  assert.equal(w.snapshot(), antes); assert.equal((w.raw('saldos_cargo_motorizado/s1').abonos as unknown[]).length, 1);
});

test('S2/S3 · el tope limita el abono; un tope mayor al pendiente se reduce al pendiente', async () => {
  const w = mundo(); semanaNormal(w); w.put('ordenes_deposito/d1', deposito(200));
  w.put('saldos_cargo_motorizado/s1', saldo(100)); w.put('saldos_cargo_motorizado/s2', saldo(50));
  await crear(w, { saldos: [{ saldoId: 's1', tope: 30 }, { saldoId: 's2', tope: 9999 }] });
  const s1 = w.raw('saldos_cargo_motorizado/s1'); const s2 = w.raw('saldos_cargo_motorizado/s2');
  assert.equal(s1.saldoPendiente, 70); assert.equal(s1.estado, 'abonado_parcial');
  assert.equal(s2.saldoPendiente, 0); assert.equal(s2.estado, 'pagado');
  assert.equal(w.raw(`liquidaciones_motorizado/${LIQ}`).deudasAplicadas, 80);
});

test('S8 · dos saldos: dos abonos y dos movimientos, y un abonado_parcial previo se continúa', async () => {
  const w = mundo(); semanaNormal(w); w.put('ordenes_deposito/d1', deposito(200));
  w.put('saldos_cargo_motorizado/s1', saldo(100));
  w.put('saldos_cargo_motorizado/s2', saldo(60, { montoOriginal: 100, estado: 'abonado_parcial', abonos: [{ monto: 40, metodoAbono: 'transferencia' }] }));
  await crear(w, { saldos: [{ saldoId: 's1' }, { saldoId: 's2' }] });
  assert.equal(w.movimientos().length, 2);
  assert.equal((w.raw('saldos_cargo_motorizado/s2').abonos as unknown[]).length, 2);
  assert.equal(w.raw('saldos_cargo_motorizado/s2').estado, 'pagado');
  assert.equal(w.raw(`liquidaciones_motorizado/${LIQ}`).deudasAplicadas, 160);
});

test('S4-S7 · un saldo ajeno, anulado, condonado, sin pendiente, inexistente o incoherente aborta TODA la liquidación', async () => {
  const casos: Array<[string, Doc | null]> = [
    ['ajeno', saldo(50, { motorizadoId: 'm2', motorizadoUid: 'u2' })],
    ['ajeno_uid', saldo(50, { motorizadoUid: 'u2' })],
    ['anulado', saldo(50, { estado: 'anulado' })],
    ['condonado', saldo(0, { montoOriginal: 50, estado: 'condonado' })],
    ['pagado', saldo(0, { montoOriginal: 50, estado: 'pagado', abonos: [{ monto: 50 }] })],
    ['cero_pendiente', saldo(0, { montoOriginal: 0 })],
    ['incoherente', saldo(50, { montoOriginal: 100 })],
    ['inexistente', null],
  ];
  for (const [nombre, s] of casos) {
    const w = mundo(); semanaNormal(w); w.put('ordenes_deposito/d1', deposito(200));
    w.put('saldos_cargo_motorizado/ok', saldo(10));
    if (s) w.put('saldos_cargo_motorizado/malo', s);
    const antes = w.snapshot();
    await assert.rejects(crear(w, { saldos: [{ saldoId: 'ok' }, { saldoId: 'malo' }] }), codigo('failed-precondition', 'saldo_invalido'), nombre);
    assert.equal(w.snapshot(), antes, nombre);
  }
});

test('S · un saldo cuyo motorizado coincide pero abre con saldo de liquidación anterior se puede descontar', async () => {
  const w = mundo(); semanaNormal(w); w.put('ordenes_deposito/d1', deposito(200));
  w.put('saldos_cargo_motorizado/viejo', saldo(30, { origen: 'liquidacion', liquidacionId: 'm1_2026-W19' }));
  await crear(w, { saldos: [{ saldoId: 'viejo' }] });
  assert.equal(w.raw('saldos_cargo_motorizado/viejo').estado, 'pagado');
});

test('N · un neto negativo causado por deudas aplicadas genera el saldo por el residuo, junto con los abonos', async () => {
  const w = mundo(); semanaNormal(w); w.put('ordenes_deposito/d1', deposito(200));
  w.put('saldos_cargo_motorizado/s1', saldo(300)); // comisión 160 − deuda 300 = −140
  const r = await crear(w, { saldos: [{ saldoId: 's1' }] });
  assert.equal(r.netoAPagar, -140);
  assert.equal(w.saldos().length, 2);
  assert.equal(w.raw(`saldos_cargo_motorizado/saldo_${LIQ}`).montoOriginal, 140);
  assert.deepEqual(w.movimientos().map((m) => m.data.tipo).sort(), ['abono_deuda_motorizado', 'saldo_creado']);
});

// ── Atomicidad y semántica de la fórmula ─────────────────────────────────────

test('la fórmula trabaja en centavos exactos y es la del diseño', () => {
  const r = formulaLiquidacion({ baseComision: 1010, efectivoEsperado: 1010, gastosLiquidacion: 10, gastosEnDepositos: 0, depositado: 900, adelantos: 100, deudasAplicadas: 33 });
  // comisión = round(1010×0.8)=808; a depositar = 1000; faltante = 100; neto = 808 − 100 − 100 + 0 − 33 = 575
  assert.equal(r.comision, 808); assert.equal(r.totalADepositar, 1000); assert.equal(r.faltantesDeposito, 100); assert.equal(r.netoAPagar, 575);
  // la base sale del snapshot del servidor; un deliveryBase del cliente sin respaldo NO se usa
  assert.equal(baseComisionOrden({ precioDesglose: { deliveryBase: 80.1 }, confirmacion: { precioFinalCordobas: 999, comisionBaseCordobas: 80.1, comisionBaseOrigen: 'tarifa_distancia' } }), 8010);
  assert.equal(baseComisionOrden({ precioDesglose: { deliveryBase: 80.1 }, confirmacion: { precioFinalCordobas: 999 } }), null);
  assert.equal(baseComisionOrden({ confirmacion: { precioFinalCordobas: 55.55 } }), null); // sin desglose ni cotización: la base NO es el precio final
  assert.equal(baseComisionOrden({ precioDesglose: { deliveryBase: 80 } }), null);
});

test('atomicidad: si cualquier escritura falla, NO queda nada a medias (ni liquidación, ni abonos, ni marcas, ni saldo)', async () => {
  const w = mundo(); semanaNormal(w);
  w.put('gastos_motorizado/g1', gasto(10)); w.put('saldos_cargo_motorizado/s1', saldo(20));
  w.put(`liquidaciones_motorizado/${LIQ}x`, { motorizadoId: 'm9' });
  // un movimiento ya existente con el id determinista del abono fuerza un ALREADY_EXISTS en mitad de las escrituras
  w.put(`movimientos_financieros/abono_${LIQ}_s1`, { tipo: 'otro' });
  const antes = w.snapshot();
  await assert.rejects(crear(w, { saldos: [{ saldoId: 's1' }] }), /ALREADY_EXISTS/);
  assert.equal(w.snapshot(), antes);
});

// ── P · pagar ────────────────────────────────────────────────────────────────

const pagar = (w: Mundo, extra: Doc = {}, uid = 'a1') => marcarLiquidacionPagadaCore(w.depsPagar, uid, { liquidacionId: LIQ, operacionId: OP2, ...extra });

async function conLiquidacion(neto: 'positivo' | 'cero' | 'negativo'): Promise<Mundo> {
  const w = mundo(); semanaNormal(w);
  if (neto === 'positivo') w.put('ordenes_deposito/d1', deposito(200));
  if (neto === 'cero') { w.put('ordenes_deposito/d1', deposito(200)); w.put('movimientos_financieros/ad1', adelanto(160)); }
  await crear(w);
  return w;
}

test('P1/P3/P6/P9/P10 · neto > 0: UN pago positivo con el neto RELEÍDO, cuentas aprobadas, actor real y marcador', async () => {
  const w = await conLiquidacion('positivo');
  const r = await pagar(w, {}, 'g1');
  assert.equal(r.resultado, 'pagada'); assert.equal(r.netoAPagar, 160); assert.equal(r.movimientoId, `pago_${LIQ}`);
  const pagos = w.movimientos().filter((m) => m.data.tipo === 'liquidacion_pago_efectivo');
  assert.equal(pagos.length, 1);
  const m = pagos[0].data;
  assert.equal(pagos[0].id, `pago_${LIQ}`); assert.equal(m.monto, 160);
  assert.equal(m.cuentaOrigen, 'comision_pendiente:m1'); assert.equal(m.cuentaDestino, 'externo'); assert.equal(m.propietario, 'motorizado:m1');
  assert.equal(m.motorizadoId, 'm1'); assert.equal(m.liquidacionId, LIQ); assert.equal(m.estado, 'activo'); assert.equal(m.creadoPorUid, 'g1'); assert.equal(m.creadoPorRol, 'gestor');
  const l = w.raw(`liquidaciones_motorizado/${LIQ}`);
  assert.equal(l.estado, 'pagado'); assert.equal(l.pagadoPorUid, 'g1'); assert.equal(l.pagadoPorRol, 'gestor'); assert.equal(l.pagadoPor, 'g1'); assert.ok(l.pagadoAt); assert.equal(l.movimientoPagoId, `pago_${LIQ}`);
  assert.equal(l.netoAPagar, 160); // el neto no se tocó
  const op = w.raw(`operaciones_liquidacion/pagar_${LIQ}`);
  assert.equal(op.tipo, 'pagar_liquidacion'); assert.equal(op.actorUid, 'g1'); assert.equal(op.operacionId, OP2);
});

test('P2 · el pago NO acepta monto, actor, cuentas ni estado desde el cliente', async () => {
  const w = await conLiquidacion('positivo'); const antes = w.snapshot();
  for (const extra of ['monto', 'netoAPagar', 'actor', 'rol', 'cuentaOrigen', 'cuentaDestino', 'estado', 'propietario']) {
    await assert.rejects(pagar(w, { [extra]: 1 }), codigo('invalid-argument'), extra);
  }
  await assert.rejects(pagar(w, { liquidacionId: '' }), codigo('invalid-argument'));
  await assert.rejects(pagar(w, { operacionId: 'x' }), codigo('invalid-argument'));
  assert.equal(w.snapshot(), antes);
});

test('P4 · neto = 0: marca pagada y NO crea movimiento de pago', async () => {
  const w = await conLiquidacion('cero');
  const movs = w.movimientos().length;
  const r = await pagar(w);
  assert.equal(r.resultado, 'pagada'); assert.equal(r.movimientoId, null);
  assert.equal(w.movimientos().length, movs);
  assert.equal(w.raw(`liquidaciones_motorizado/${LIQ}`).estado, 'pagado');
  assert.equal(w.raw(`liquidaciones_motorizado/${LIQ}`).movimientoPagoId, undefined);
});

test('P5 · neto < 0: marca pagada SIN movimiento (nunca un pago negativo); el saldo ya existía desde la creación', async () => {
  const w = await conLiquidacion('negativo');
  const movs = w.movimientos().length; const saldos = w.saldos().length;
  const r = await pagar(w);
  assert.equal(r.resultado, 'pagada'); assert.equal(r.movimientoId, null); assert.equal(r.netoAPagar, -40);
  assert.equal(w.movimientos().length, movs); assert.equal(w.saldos().length, saldos);
  assert.equal(w.movimientos().filter((m) => m.data.tipo === 'liquidacion_pago_efectivo').length, 0);
  assert.equal(w.raw(`liquidaciones_motorizado/${LIQ}`).estado, 'pagado');
  assert.equal(w.raw(`liquidaciones_motorizado/${LIQ}`).saldoGeneradoId, `saldo_${LIQ}`);
});

test('P7/P8 · ya pagada (retry idéntico, doble clic u otro operacionId): ya_pagada con 0 escrituras y SIN duplicar el movimiento', async () => {
  const w = await conLiquidacion('positivo');
  await pagar(w);
  const antes = w.snapshot(); const esc = w.escrituras;
  const r1 = await pagar(w);
  const r2 = await pagar(w, { operacionId: OP3 });
  assert.equal(r1.resultado, 'ya_pagada'); assert.equal(r2.resultado, 'ya_pagada'); assert.equal(r2.movimientoId, `pago_${LIQ}`);
  assert.equal(w.snapshot(), antes); assert.equal(w.escrituras, esc);
  assert.equal(w.movimientos().filter((m) => m.data.tipo === 'liquidacion_pago_efectivo').length, 1);
});

test('P · carrera de doble clic: dos pagos concurrentes terminan en UN movimiento', async () => {
  const w = await conLiquidacion('positivo');
  const [a, b] = await Promise.all([pagar(w), pagar(w, { operacionId: OP3 })]);
  assert.deepEqual([a.resultado, b.resultado].sort(), ['pagada', 'ya_pagada']);
  assert.equal(w.movimientos().filter((m) => m.data.tipo === 'liquidacion_pago_efectivo').length, 1);
});

test('P · guards: no existe, estado desconocido, no-staff, liquidación anterior sin saldo y movimiento huérfano', async () => {
  const w = await conLiquidacion('positivo');
  await assert.rejects(pagar(w, { liquidacionId: 'm1_2026-W01' }), codigo('not-found'));
  await assert.rejects(pagar(w, {}, 'u1'), codigo('permission-denied'));
  await assert.rejects(marcarLiquidacionPagadaCore(w.depsPagar, undefined, { liquidacionId: LIQ, operacionId: OP2 }), codigo('unauthenticated'));
  w.put('liquidaciones_motorizado/m1_2026-W10', { motorizadoId: 'm1', estado: 'anulada', netoAPagar: 10 });
  await assert.rejects(pagar(w, { liquidacionId: 'm1_2026-W10' }), codigo('failed-precondition', 'estado_invalido'));
  w.put('liquidaciones_motorizado/m1_2026-W11', { motorizadoId: 'm1', estado: 'pendiente', netoAPagar: -30, semanaKey: '2026-W11' });
  await assert.rejects(pagar(w, { liquidacionId: 'm1_2026-W11' }), codigo('failed-precondition', 'conciliacion_requerida'));
  w.put('liquidaciones_motorizado/m1_2026-W12', { motorizadoId: 'm1', estado: 'pendiente', netoAPagar: 30, semanaKey: '2026-W12' });
  w.put('movimientos_financieros/pago_m1_2026-W12', { tipo: 'liquidacion_pago_efectivo' });
  await assert.rejects(pagar(w, { liquidacionId: 'm1_2026-W12' }), codigo('failed-precondition', 'conciliacion_requerida'));
  w.put('liquidaciones_motorizado/m1_2026-W13', { estado: 'pendiente', netoAPagar: 'mucho' });
  await assert.rejects(pagar(w, { liquidacionId: 'm1_2026-W13' }), codigo('failed-precondition', 'conciliacion_requerida'));
  assert.equal(w.raw(`liquidaciones_motorizado/${LIQ}`).estado, 'pendiente');
});

test('P · atomicidad: si el movimiento no se puede crear, la liquidación sigue pendiente', async () => {
  const w = await conLiquidacion('positivo');
  w.put(`operaciones_liquidacion/pagar_${LIQ}x`, {});
  // un marcador de pago ya presente en una liquidación pendiente es una inconsistencia: no se escribe nada
  w.put(`operaciones_liquidacion/pagar_${LIQ}`, { tipo: 'pagar_liquidacion' });
  const antes = w.snapshot();
  await assert.rejects(pagar(w), codigo('failed-precondition', 'conciliacion_requerida'));
  assert.equal(w.snapshot(), antes);
  assert.equal(w.raw(`liquidaciones_motorizado/${LIQ}`).estado, 'pendiente');
});

test('FIN1F-F14b / E1C · snapshot HISTÓRICO corrupto (base 420 > precio final 150, de cualquier origen) → conciliacion_requerida / precio_incoherente, 0 escrituras', async () => {
  for (const origen of ['tarifa_distancia', 'manual_gestor']) {
    const w = mundo(); base(w);
    w.put('solicitudes_envio/o1', orden(MID, { confirmacion: { precioFinalCordobas: 150, comisionBaseCordobas: 420, comisionBaseOrigen: origen } }));
    const antes = w.snapshot(); const esc = w.escrituras;
    await assert.rejects(crear(w), (e: unknown) => codigo('failed-precondition', 'conciliacion_requerida')(e) && (e as { details?: { motivoPrecio?: string } }).details?.motivoPrecio === 'precio_incoherente', origen);
    assert.equal(w.snapshot(), antes, origen); assert.equal(w.escrituras, esc, origen);
  }
});

test('FIN1F-F16b · legacy A–E: snapshot válido PASS; derivación coherente PASS; snapshot base>final / sin base demostrable / deliveryBase incoherente → conciliacion_requerida', async () => {
  const casos: Array<[string, Doc, string | null]> = [
    ['A snapshot manual válido', { confirmacion: { precioFinalCordobas: 260, comisionBaseCordobas: 210, comisionBaseOrigen: 'manual_gestor' } }, null],
    ['B derivación por tarifa (21.759 km)', { confirmacion: { precioFinalCordobas: 260 }, cotizacion: { distanciaKm: 21.759 }, precioDesglose: { deliveryBase: 210 } }, null],
    ['C snapshot base>final', { confirmacion: { precioFinalCordobas: 150, comisionBaseCordobas: 420, comisionBaseOrigen: 'tarifa_distancia' } }, 'precio_incoherente'],
    ['D sin base demostrable', { confirmacion: { precioFinalCordobas: 150 } }, 'base_comision_requerida'],
    ['E deliveryBase incoherente', { confirmacion: { precioFinalCordobas: 150 }, cotizacion: { distanciaKm: 13.859 }, precioDesglose: { deliveryBase: 5000 } }, 'cotizacion_inconsistente'],
    ['F origen heredado precio_final_sin_desglose no se acepta', { confirmacion: { precioFinalCordobas: 150, comisionBaseCordobas: 150, comisionBaseOrigen: 'precio_final_sin_desglose' } }, 'base_comision_requerida'],
  ];
  for (const [nombre, extra, motivo] of casos) {
    const w = mundo(); base(w);
    w.put('solicitudes_envio/o1', orden(MID, { precioDesglose: undefined, ...extra }));
    if (motivo === null) { w.put('ordenes_deposito/d1', deposito(Number((extra.confirmacion as Doc).precioFinalCordobas), 'confirmado', { solicitudIds: ['o1'] })); await crear(w); continue; }
    const antes = w.snapshot(); const esc = w.escrituras;
    await assert.rejects(crear(w), (e: unknown) => codigo('failed-precondition', 'conciliacion_requerida')(e) && (e as { details?: { motivoPrecio?: string } }).details?.motivoPrecio === motivo, nombre);
    assert.equal(w.snapshot(), antes, nombre); assert.equal(w.escrituras, esc, nombre);
  }
});
