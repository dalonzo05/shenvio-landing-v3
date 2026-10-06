// FIN-4C (corrección) — la INTENCIÓN de abono vive en el servidor: prepararAbonoDirecto /
// obtenerIntencionAbono / descartarIntencionAbono + registrarAbonoDirecto exigiéndola.
//
// El blocker de la preintegración: commit exitoso → respuesta perdida → recarga → la pantalla
// inventaba OTRO operacionId y el mismo abono se aplicaba dos veces. Aquí se prueba que, sin
// ninguna memoria del cliente, la operación se RECUPERA del servidor y no se duplica; y que un
// abono NUEVO y legítimo (aunque sea del mismo monto) sigue siendo posible cuando el usuario lo
// inicia explícitamente.
//
// El "mundo" simula lo que importa de Firestore (transacciones optimistas con reintento, escrituras
// todo-o-nada, create/update) y COMPARTE el almacén entre ambos núcleos, como en producción.
import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { DocumentData } from 'firebase-admin/firestore';
import {
  prepararAbonoDirectoCore, obtenerIntencionAbonoCore, descartarIntencionAbonoCore, validarPeticionPreparar,
  idPuntero, type DepsIntencion,
} from '../src/abono-intencion';
import { registrarAbonoDirectoCore, validarPeticionAbono, type DepsAbono } from '../src/abono-directo';

type Doc = Record<string, unknown>;
const TS = (n: number) => ({ __ts: n });
const codigo = (code: string, motivo?: string) => (e: unknown) => {
  const err = e as { code?: string; details?: { motivo?: string } };
  return err.code === code && (motivo === undefined || err.details?.motivo === motivo);
};

function mundo() {
  let store = new Map<string, Doc>();
  let revision = 0;
  let relojes = 0;
  let ids = 0;
  const hooks: { fallarSi?: (op: string, ruta: string) => boolean } = {};
  const clonar = (m: Map<string, Doc>) => new Map([...m].map(([k, v]) => [k, structuredClone(v)]));
  const put = (ruta: string, d: Doc) => { store.set(ruta, d); };
  const get = (ruta: string) => { const d = store.get(ruta); return d ? (structuredClone(d) as DocumentData) : null; };

  // Una sola implementación de transacción para los dos núcleos: el tx expone la unión de ambas interfaces.
  async function correr<T>(fn: (tx: never) => Promise<T>): Promise<T> {
    for (;;) {
      const inicio = revision;
      const cola: Array<{ op: string; ruta: string; datos: Doc }> = [];
      const q = (op: string, ruta: string, datos: Doc) => { cola.push({ op, ruta, datos }); };
      const tx = {
        async getUsuario(uid: string) { return get(`usuarios/${uid}`); },
        async getSaldo(id: string) { return get(`saldos_cargo_motorizado/${id}`); },
        async getMovimiento(id: string) { return get(`movimientos_financieros/${id}`); },
        async getIntencion(id: string) { return get(`intenciones_abono_directo/${id}`); },
        async getPuntero(id: string) { return get(`punteros_abono_directo/${id}`); },
        updateSaldo(id: string, c: Doc) { q('update', `saldos_cargo_motorizado/${id}`, c); },
        crearMovimiento(id: string, c: Doc) { q('create', `movimientos_financieros/${id}`, c); },
        crearIntencion(id: string, c: Doc) { q('create', `intenciones_abono_directo/${id}`, c); },
        updateIntencion(id: string, c: Doc) { q('update', `intenciones_abono_directo/${id}`, c); },
        setPuntero(id: string, c: Doc) { q('set', `punteros_abono_directo/${id}`, c); },
      };
      const resultado = await fn(tx as never);
      if (revision !== inicio) continue; // conflicto: se descarta el intento y se relee
      const copia = clonar(store);
      for (const w of cola) {
        if (hooks.fallarSi?.(w.op, w.ruta)) throw new Error('fallo simulado de escritura: ' + w.ruta);
        if (w.op === 'create') {
          if (copia.has(w.ruta)) throw new Error('ALREADY_EXISTS ' + w.ruta);
          copia.set(w.ruta, structuredClone(w.datos));
        } else if (w.op === 'set') {
          copia.set(w.ruta, structuredClone(w.datos));
        } else {
          const actual = copia.get(w.ruta);
          if (!actual) throw new Error('NOT_FOUND ' + w.ruta);
          copia.set(w.ruta, { ...actual, ...structuredClone(w.datos) });
        }
      }
      store = copia; // commit atómico
      if (cola.length) revision++;
      return resultado;
    }
  }

  const depsInt: DepsIntencion = {
    transaction: correr as DepsIntencion['transaction'],
    serverTimestamp: () => TS(++relojes),
    nuevoId: () => `intencion_${String(++ids).padStart(10, '0')}_srv`,
  };
  const depsAbo: DepsAbono = {
    transaction: correr as DepsAbono['transaction'],
    serverTimestamp: () => TS(++relojes),
    ahora: () => TS(1000 + relojes),
  };
  const lista = (p: string) => [...store].filter(([r]) => r.startsWith(p)).map(([r, d]) => ({ id: r.split('/').pop()!, ...d } as Doc & { id: string }));
  return {
    depsInt, depsAbo, hooks, put, get,
    snapshot: () => JSON.stringify([...store].sort(([a], [b]) => a.localeCompare(b))),
    intenciones: () => lista('intenciones_abono_directo/'),
    movimientos: () => lista('movimientos_financieros/'),
    saldo: (id = 's1') => get(`saldos_cargo_motorizado/${id}`)!,
  };
}
type Mundo = ReturnType<typeof mundo>;

function sembrar(w: Mundo, opts: { saldo?: Doc; id?: string } = {}) {
  w.put('usuarios/g1', { activo: true, rol: 'gestor' });
  w.put('usuarios/g2', { activo: true, rol: 'gestor' });
  w.put('usuarios/a1', { activo: true, rol: 'admin' });
  w.put('usuarios/dig', { activo: true, rol: 'digitador' });
  w.put('usuarios/baja', { activo: false, rol: 'gestor' });
  for (const id of opts.id ? [opts.id] : ['s1']) {
    w.put(`saldos_cargo_motorizado/${id}`, {
      motorizadoId: 'motA', motorizadoNombre: 'Dickson', tipo: 'deposito_no_realizado', montoOriginal: 100, saldoPendiente: 100,
      estado: 'pendiente', origen: 'deposito', abonos: [], ...opts.saldo,
    });
  }
}

const base = { saldoId: 's1', monto: 40, metodoAbono: 'ajuste_manual' };
const preparar = (w: Mundo, uid: string | null = 'g1', extra: Record<string, unknown> = {}) =>
  prepararAbonoDirectoCore(w.depsInt, uid ?? undefined, { ...base, ...extra });
const registrar = (w: Mundo, uid: string | null, op: string, extra: Record<string, unknown> = {}) =>
  registrarAbonoDirectoCore(w.depsAbo, uid ?? undefined, { ...base, operacionId: op, ...extra });
const obtener = (w: Mundo, uid: string | null = 'g1', saldoId = 's1') => obtenerIntencionAbonoCore(w.depsInt, uid ?? undefined, { saldoId });
const descartar = (w: Mundo, uid: string | null, operacionId: string) => descartarIntencionAbonoCore(w.depsInt, uid ?? undefined, { operacionId });

// ── F4C-I1 · crear ────────────────────────────────────────────────────────────
test('F4C-I1 · una intención NUEVA: la crea el servidor (id, actor y rol del servidor), preparada, sin tocar el saldo', async () => {
  const w = mundo(); sembrar(w);
  const antesSaldo = JSON.stringify(w.saldo());
  const r = await preparar(w, 'a1', { nota: '  recibido  ' });
  assert.equal(r.resultado, 'preparada');
  const op = r.intencion.operacionId;
  assert.match(op, /^[A-Za-z0-9_-]{16,64}$/, 'cumple el formato que valida registrarAbonoDirecto');
  assert.deepEqual({ ...r.intencion }, { operacionId: op, saldoId: 's1', monto: 40, metodoAbono: 'ajuste_manual', estado: 'preparada' });
  const doc = w.get(`intenciones_abono_directo/${op}`)!;
  assert.equal(doc.actorUid, 'a1', 'el actor sale de request.auth');
  assert.equal(doc.actorRol, 'admin', 'el rol sale de usuarios/{uid}');
  assert.equal(doc.nota, 'recibido');
  assert.equal(doc.estado, 'preparada');
  assert.deepEqual(doc.createdAt, TS(1));
  assert.equal(w.get(`punteros_abono_directo/${idPuntero('s1', 'a1')}`)!.intencionId, op);
  assert.equal(JSON.stringify(w.saldo()), antesSaldo, 'preparar NO es el efecto financiero');
  assert.equal(w.movimientos().length, 0);
});

// ── F4C-I2 · recuperar ────────────────────────────────────────────────────────
test('F4C-I2 · preparar de nuevo con los mismos parámetros ⇒ la MISMA intención (recuperada), sin crear otra', async () => {
  const w = mundo(); sembrar(w);
  const a = await preparar(w);
  const b = await preparar(w);
  const c = await preparar(w, 'g1', { nota: 'otra nota' });
  assert.equal(b.resultado, 'recuperada');
  assert.equal(b.intencion.operacionId, a.intencion.operacionId);
  assert.equal(c.intencion.operacionId, a.intencion.operacionId);
  assert.equal(w.intenciones().length, 1);
  assert.equal(w.get(`intenciones_abono_directo/${a.intencion.operacionId}`)!.nota, 'otra nota', 'la metadata sí se refresca');
});

// ── F4C-I3 · recarga antes de aplicar ─────────────────────────────────────────
test('F4C-I3 · recarga ANTES de aplicar: el cliente no recuerda nada y recupera la preparada; aplica y deja 1 abono, 1 movimiento', async () => {
  const w = mundo(); sembrar(w);
  const a = await preparar(w);
  // ── recarga: no queda memoria del cliente; solo lo que diga el servidor ──
  const visto = await obtener(w);
  assert.equal(visto.intencion!.estado, 'preparada');
  assert.equal(visto.intencion!.operacionId, a.intencion.operacionId);
  const r = await registrar(w, 'g1', visto.intencion!.operacionId);
  assert.equal(r.resultado, 'aplicado');
  assert.equal(w.intenciones().length, 1, 'NO se generó otra intención');
  assert.equal(w.movimientos().length, 1);
  assert.equal((w.saldo().abonos as Doc[]).length, 1);
  assert.equal(w.saldo().saldoPendiente, 60);
  assert.equal(w.get(`intenciones_abono_directo/${a.intencion.operacionId}`)!.estado, 'aplicada');
});

// ── F4C-I4 · otra pestaña ─────────────────────────────────────────────────────
test('F4C-I4 · otra pestaña (misma cuenta): ve y recupera la MISMA intención; no crea otra en silencio', async () => {
  const w = mundo(); sembrar(w);
  const pestana1 = await preparar(w);
  const pestana2 = await obtener(w); // la pestaña 2 abre el mismo saldo
  assert.equal(pestana2.intencion!.operacionId, pestana1.intencion.operacionId);
  const pestana2prepara = await preparar(w);
  assert.equal(pestana2prepara.resultado, 'recuperada');
  assert.equal(w.intenciones().length, 1);
});

// ── F4C-I5 · aplicada → recuperar aplicada ────────────────────────────────────
test('F4C-I5 · una intención APLICADA se recupera como aplicada: preparar no crea otra y registrar responde ya_aplicado', async () => {
  const w = mundo(); sembrar(w);
  const a = await preparar(w);
  await registrar(w, 'g1', a.intencion.operacionId);
  const antes = w.snapshot();
  const r = await preparar(w);
  assert.equal(r.resultado, 'ya_aplicada');
  assert.equal(r.intencion.operacionId, a.intencion.operacionId);
  assert.equal(r.intencion.estado, 'aplicada');
  assert.equal(r.intencion.movimientoId, 'abono_' + a.intencion.operacionId);
  assert.equal((await obtener(w)).intencion!.estado, 'aplicada');
  assert.equal((await registrar(w, 'g1', a.intencion.operacionId)).resultado, 'ya_aplicado');
  assert.equal(w.snapshot(), antes, 'ninguna de esas lecturas/retries escribió nada');
});

// ── F4C-I6 · parámetros distintos ─────────────────────────────────────────────
test('F4C-I6 · una preparada con OTROS parámetros no se reemplaza en silencio: operacion_pendiente_existente; se resuelve descartándola', async () => {
  const w = mundo(); sembrar(w);
  const a = await preparar(w, 'g1', { monto: 40 });
  const b = await preparar(w, 'g1', { monto: 55 });
  assert.equal(b.resultado, 'operacion_pendiente_existente');
  assert.equal(b.intencion.operacionId, a.intencion.operacionId);
  assert.equal(b.intencion.monto, 40, 'la existente queda intacta');
  const c = await preparar(w, 'g1', { metodoAbono: 'descuento_liquidacion' });
  assert.equal(c.resultado, 'operacion_pendiente_existente');
  assert.equal(w.intenciones().length, 1);
  // la resolución es EXPLÍCITA
  assert.equal((await descartar(w, 'g1', a.intencion.operacionId)).resultado, 'descartada');
  const d = await preparar(w, 'g1', { monto: 55 });
  assert.equal(d.resultado, 'preparada');
  assert.notEqual(d.intencion.operacionId, a.intencion.operacionId);
  assert.equal(w.get(`intenciones_abono_directo/${a.intencion.operacionId}`)!.estado, 'rechazada');
  assert.equal(w.get(`intenciones_abono_directo/${a.intencion.operacionId}`)!.motivoRechazo, 'descartada_por_usuario');
});

// ── F4C-I7 · actor distinto ───────────────────────────────────────────────────
test('F4C-I7 · otro usuario no puede apropiarse de la intención de alguien: ni registrarla, ni descartarla, ni verla', async () => {
  const w = mundo(); sembrar(w);
  const a = await preparar(w, 'g1');
  const op = a.intencion.operacionId;
  const antes = w.snapshot();
  await assert.rejects(registrar(w, 'g2', op), codigo('failed-precondition', 'intencion_ajena'));
  await assert.rejects(registrar(w, 'a1', op), codigo('failed-precondition', 'intencion_ajena'));
  await assert.rejects(descartar(w, 'g2', op), codigo('failed-precondition', 'intencion_ajena'));
  assert.equal((await obtener(w, 'g2')).intencion, null, 'g2 no ve la de g1');
  assert.equal(w.snapshot(), antes);
  // g2 tiene la SUYA, independiente
  const b = await preparar(w, 'g2');
  assert.equal(b.resultado, 'preparada');
  assert.notEqual(b.intencion.operacionId, op);
  assert.equal(w.get(`intenciones_abono_directo/${b.intencion.operacionId}`)!.actorUid, 'g2');
});

// ── F4C-I8 · saldo distinto ───────────────────────────────────────────────────
test('F4C-I8 · otro saldo no reutiliza la intención: cada saldo tiene la suya; registrar con el saldo equivocado ⇒ conflicto', async () => {
  const w = mundo(); sembrar(w); sembrar(w, { id: 's2' });
  const a = await preparar(w, 'g1', { saldoId: 's1' });
  const b = await preparar(w, 'g1', { saldoId: 's2' });
  assert.notEqual(a.intencion.operacionId, b.intencion.operacionId);
  assert.equal(w.intenciones().length, 2);
  const antes = w.snapshot();
  await assert.rejects(registrar(w, 'g1', a.intencion.operacionId, { saldoId: 's2' }), codigo('failed-precondition', 'conflicto_idempotencia'));
  await assert.rejects(registrar(w, 'g1', a.intencion.operacionId, { monto: 41 }), codigo('failed-precondition', 'conflicto_idempotencia'));
  await assert.rejects(registrar(w, 'g1', a.intencion.operacionId, { metodoAbono: 'descuento_liquidacion' }), codigo('failed-precondition', 'conflicto_idempotencia'));
  assert.equal(w.snapshot(), antes);
});

// ── F4C-I9 / I10 · abono NUEVO explícito ──────────────────────────────────────
test('F4C-I9 · un abono NUEVO tras una aplicada exige RECONOCERLA: con el id correcto nace otra intención; con otro id, no', async () => {
  const w = mundo(); sembrar(w);
  const a = await preparar(w);
  await registrar(w, 'g1', a.intencion.operacionId);
  const sinReconocer = await preparar(w);
  assert.equal(sinReconocer.resultado, 'ya_aplicada', 'una recarga no equivale a un abono nuevo');
  const ajeno = await preparar(w, 'g1', { reconoceOperacionId: 'op_que_no_es_la_vigente_xxxx' });
  assert.equal(ajeno.resultado, 'ya_aplicada', 'reconocer una intención que ya no es la vigente no crea otra');
  assert.equal(w.intenciones().length, 1);
  const b = await preparar(w, 'g1', { reconoceOperacionId: a.intencion.operacionId });
  assert.equal(b.resultado, 'preparada');
  assert.notEqual(b.intencion.operacionId, a.intencion.operacionId);
  assert.equal(w.intenciones().length, 2);
  assert.equal(w.get(`intenciones_abono_directo/${a.intencion.operacionId}`)!.estado, 'aplicada', 'la anterior es evidencia: no se toca');
});

test('F4C-I10 · el nuevo abono del MISMO monto es legítimo: 30 + 30 ⇒ ambos aplicados, saldo 40, 2 abonos, 2 movimientos', async () => {
  const w = mundo(); sembrar(w);
  const a = await preparar(w, 'g1', { monto: 30 });
  await registrar(w, 'g1', a.intencion.operacionId, { monto: 30 });
  const b = await preparar(w, 'g1', { monto: 30, reconoceOperacionId: a.intencion.operacionId });
  assert.equal(b.resultado, 'preparada');
  const r = await registrar(w, 'g1', b.intencion.operacionId, { monto: 30 });
  assert.equal(r.resultado, 'aplicado');
  assert.equal(w.saldo().saldoPendiente, 40);
  assert.equal((w.saldo().abonos as Doc[]).length, 2);
  assert.equal(w.movimientos().length, 2);
});

// ── GATE ORIGINAL ─────────────────────────────────────────────────────────────
test('F4C-GATE · saldo 100, A=40 aplicada, respuesta PERDIDA, recarga: se recupera A como aplicada, NO nace B ⇒ saldo 60, 1 abono, 1 movimiento', async () => {
  const w = mundo(); sembrar(w);
  // 1–4. el cliente prepara y pide aplicar; el commit OCURRE; la respuesta se pierde (el cliente no se entera)
  const a = await preparar(w);
  await registrar(w, 'g1', a.intencion.operacionId);
  // 5–6. recarga/remonta: sin memoria alguna del cliente
  // 7–9. vuelve al saldo, el servidor recupera A y dice que está aplicada
  const alAbrir = await obtener(w);
  assert.equal(alAbrir.intencion!.operacionId, a.intencion.operacionId);
  assert.equal(alAbrir.intencion!.estado, 'aplicada');
  // 10–11. el usuario repite "la misma intención": NO se crea B, no se aplica de nuevo
  const repite = await preparar(w);
  assert.equal(repite.resultado, 'ya_aplicada');
  assert.equal(repite.intencion.operacionId, a.intencion.operacionId);
  assert.equal((await registrar(w, 'g1', repite.intencion.operacionId)).resultado, 'ya_aplicado');
  assert.equal(w.saldo().saldoPendiente, 60);
  assert.equal((w.saldo().abonos as Doc[]).length, 1);
  assert.equal(w.movimientos().length, 1);
  assert.equal(w.intenciones().length, 1);
  assert.equal(w.intenciones()[0].estado, 'aplicada');
});

test('F4C-GATE2 · después del gate, el usuario inicia EXPLÍCITAMENTE otro abono de C$40: B ≠ A y se aplica ⇒ saldo 20, 2 abonos, 2 movimientos (no se deduplica por monto)', async () => {
  const w = mundo(); sembrar(w);
  const a = await preparar(w);
  await registrar(w, 'g1', a.intencion.operacionId);
  assert.equal((await preparar(w)).resultado, 'ya_aplicada');
  const b = await preparar(w, 'g1', { reconoceOperacionId: a.intencion.operacionId });
  assert.notEqual(b.intencion.operacionId, a.intencion.operacionId);
  assert.equal((await registrar(w, 'g1', b.intencion.operacionId)).resultado, 'aplicado');
  assert.equal(w.saldo().saldoPendiente, 20);
  assert.equal((w.saldo().abonos as Doc[]).length, 2);
  assert.equal(w.movimientos().length, 2);
});

// ── Concurrencia de intenciones ───────────────────────────────────────────────
test('F4C-CONC1 · cinco "preparar" simultáneos (pestañas/dispositivos) ⇒ UNA intención: 1 preparada + 4 recuperadas; nunca A y B por carrera', async () => {
  const w = mundo(); sembrar(w);
  const rs = await Promise.all([1, 2, 3, 4, 5].map(() => preparar(w)));
  assert.equal(rs.filter((r) => r.resultado === 'preparada').length, 1);
  assert.equal(rs.filter((r) => r.resultado === 'recuperada').length, 4);
  assert.equal(new Set(rs.map((r) => r.intencion.operacionId)).size, 1);
  assert.equal(w.intenciones().length, 1);
});

test('F4C-CONC2 · "preparar" simultáneos con parámetros DISTINTOS ⇒ una sola intención; el otro recibe operacion_pendiente_existente', async () => {
  const w = mundo(); sembrar(w);
  const rs = await Promise.all([preparar(w, 'g1', { monto: 30 }), preparar(w, 'g1', { monto: 70 })]);
  assert.deepEqual(rs.map((r) => r.resultado).sort(), ['operacion_pendiente_existente', 'preparada']);
  assert.equal(w.intenciones().length, 1);
});

test('F4C-CONC3 · dos pestañas reconocen la MISMA aplicada y piden "nuevo abono" a la vez ⇒ una sola intención nueva', async () => {
  const w = mundo(); sembrar(w);
  const a = await preparar(w);
  await registrar(w, 'g1', a.intencion.operacionId);
  const rs = await Promise.all([preparar(w, 'g1', { reconoceOperacionId: a.intencion.operacionId }), preparar(w, 'g1', { reconoceOperacionId: a.intencion.operacionId })]);
  assert.deepEqual(rs.map((r) => r.resultado).sort(), ['preparada', 'recuperada']);
  assert.equal(w.intenciones().length, 2, 'A + una sola B');
});

test('F4C-CONC4 · la misma operación aplicada por varias llamadas simultáneas ⇒ 1 aplicado + N ya_aplicado, 1 abono, 1 movimiento', async () => {
  const w = mundo(); sembrar(w);
  const a = await preparar(w);
  const rs = await Promise.all([1, 2, 3, 4, 5].map(() => registrar(w, 'g1', a.intencion.operacionId)));
  assert.equal(rs.filter((r) => r.resultado === 'aplicado').length, 1);
  assert.equal(rs.filter((r) => r.resultado === 'ya_aplicado').length, 4);
  assert.equal(w.movimientos().length, 1);
  assert.equal(w.saldo().saldoPendiente, 60);
});

test('F4C-CONC5 · dos operaciones distintas 40 + 60 sobre 100 ⇒ ambas; 70 + 40 ⇒ una rechazada (y su intención CERRADA); nunca negativo', async () => {
  const w = mundo(); sembrar(w);
  const a = await preparar(w, 'g1', { monto: 40 }); const b = await preparar(w, 'g2', { monto: 60 });
  const rs = await Promise.all([registrar(w, 'g1', a.intencion.operacionId, { monto: 40 }), registrar(w, 'g2', b.intencion.operacionId, { monto: 60 })]);
  assert.deepEqual(rs.map((r) => r.resultado), ['aplicado', 'aplicado']);
  assert.equal(w.saldo().saldoPendiente, 0);
  const x = mundo(); sembrar(x);
  const p = await preparar(x, 'g1', { monto: 70 }); const q = await preparar(x, 'g2', { monto: 40 });
  const ss = await Promise.allSettled([registrar(x, 'g1', p.intencion.operacionId, { monto: 70 }), registrar(x, 'g2', q.intencion.operacionId, { monto: 40 })]);
  assert.equal(ss.filter((s) => s.status === 'fulfilled').length, 1);
  const perdedora = ss.find((s) => s.status === 'rejected') as PromiseRejectedResult;
  assert.ok(codigo('failed-precondition', 'monto_excede_saldo')(perdedora.reason));
  assert.ok((x.saldo().saldoPendiente as number) >= 0);
  assert.equal(x.intenciones().filter((i) => i.estado === 'rechazada').length, 1, 'el rechazo definitivo CERRÓ su intención');
  assert.equal(x.intenciones().filter((i) => i.estado === 'preparada').length, 0, 'ninguna queda preparada para siempre');
});

// ── registrarAbonoDirecto exige una intención válida ──────────────────────────
test('F4C-R1 · una operacionId arbitraria (sin intención) se rechaza ⇒ intencion_inexistente, 0 efectos', async () => {
  const w = mundo(); sembrar(w);
  const antes = w.snapshot();
  await assert.rejects(registrar(w, 'g1', 'op_inventada_por_el_cliente_1'), codigo('failed-precondition', 'intencion_inexistente'));
  assert.equal(w.snapshot(), antes);
});

test('F4C-R2 · registrar y la intención se cierran JUNTOS: si falla cualquiera de las tres escrituras, no queda nada a medias', async () => {
  for (const objetivo of ['saldos_cargo_motorizado/s1', 'intenciones_abono_directo/']) {
    const w = mundo(); sembrar(w);
    const a = await preparar(w);
    const antes = w.snapshot();
    w.hooks.fallarSi = (_op, ruta) => ruta.startsWith(objetivo);
    await assert.rejects(registrar(w, 'g1', a.intencion.operacionId), /fallo simulado/, objetivo);
    assert.equal(w.snapshot(), antes, 'sin efectos parciales cuando falla ' + objetivo);
    assert.equal(w.get(`intenciones_abono_directo/${a.intencion.operacionId}`)!.estado, 'preparada');
    w.hooks.fallarSi = undefined;
    assert.equal((await registrar(w, 'g1', a.intencion.operacionId)).resultado, 'aplicado');
    assert.equal(w.get(`intenciones_abono_directo/${a.intencion.operacionId}`)!.estado, 'aplicada');
  }
});

test('F4C-R3 · un rechazo DEFINITIVO cierra la intención (rechazada, con motivo) y la siguiente preparación crea otra; no queda preparada eternamente', async () => {
  const w = mundo(); sembrar(w);
  const a = await preparar(w, 'g1', { monto: 80 });
  w.put('saldos_cargo_motorizado/s1', { ...w.saldo(), saldoPendiente: 50, estado: 'abonado_parcial' }); // otro abono lo redujo
  await assert.rejects(registrar(w, 'g1', a.intencion.operacionId, { monto: 80 }), codigo('failed-precondition', 'monto_excede_saldo'));
  const cerrada = w.get(`intenciones_abono_directo/${a.intencion.operacionId}`)!;
  assert.equal(cerrada.estado, 'rechazada');
  assert.equal(cerrada.motivoRechazo, 'monto_excede_saldo');
  assert.equal(w.movimientos().length, 0);
  // un reintento con la misma operación ya cerrada no la revive
  await assert.rejects(registrar(w, 'g1', a.intencion.operacionId, { monto: 80 }), codigo('failed-precondition', 'intencion_cerrada'));
  const b = await preparar(w, 'g1', { monto: 30 });
  assert.equal(b.resultado, 'preparada');
  assert.notEqual(b.intencion.operacionId, a.intencion.operacionId);
  // saldo cerrado ⇒ tampoco se crean intenciones condenadas
  const x = mundo(); sembrar(x, { saldo: { estado: 'condonado' } });
  await assert.rejects(preparar(x), codigo('failed-precondition', 'saldo_no_abonable'));
  assert.equal(x.intenciones().length, 0);
  const y = mundo(); sembrar(y);
  await assert.rejects(preparar(y, 'g1', { monto: 500 }), codigo('failed-precondition', 'monto_excede_saldo'));
  assert.equal(y.intenciones().length, 0);
});

test('F4C-R4 · integridad: aplicada sin movimiento, o preparada con movimiento ⇒ abono_inconsistente, sin reparar', async () => {
  const w = mundo(); sembrar(w);
  const a = await preparar(w);
  w.put(`intenciones_abono_directo/${a.intencion.operacionId}`, { ...w.get(`intenciones_abono_directo/${a.intencion.operacionId}`)!, estado: 'aplicada', movimientoId: 'abono_' + a.intencion.operacionId });
  const antes = w.snapshot();
  await assert.rejects(registrar(w, 'g1', a.intencion.operacionId), codigo('failed-precondition', 'abono_inconsistente'));
  assert.equal(w.snapshot(), antes);
  const x = mundo(); sembrar(x);
  const b = await preparar(x);
  x.put('movimientos_financieros/abono_' + b.intencion.operacionId, { tipo: 'abono_deuda_motorizado', estado: 'activo', saldoId: 's1', monto: 40 });
  await assert.rejects(registrar(x, 'g1', b.intencion.operacionId), codigo('failed-precondition', 'abono_inconsistente'));
  // un puntero colgante tampoco se "arregla"
  const y = mundo(); sembrar(y);
  y.put(`punteros_abono_directo/${idPuntero('s1', 'g1')}`, { intencionId: 'fantasma', saldoId: 's1', actorUid: 'g1' });
  await assert.rejects(preparar(y), codigo('failed-precondition', 'abono_inconsistente'));
  await assert.rejects(obtener(y), codigo('failed-precondition', 'abono_inconsistente'));
});

// ── descartar ─────────────────────────────────────────────────────────────────
test('F4C-D1 · cerrar el modal NO toca la intención; descartar es explícito, idempotente y solo de una PREPARADA (una aplicada no se descarta)', async () => {
  const w = mundo(); sembrar(w);
  const a = await preparar(w);
  // "cerrar el modal" = no llamar a nada: la intención sigue ahí
  assert.equal((await obtener(w)).intencion!.estado, 'preparada');
  assert.equal((await descartar(w, 'g1', a.intencion.operacionId)).resultado, 'descartada');
  assert.equal((await descartar(w, 'g1', a.intencion.operacionId)).resultado, 'ya_descartada');
  await assert.rejects(registrar(w, 'g1', a.intencion.operacionId), codigo('failed-precondition', 'intencion_cerrada'));
  const x = mundo(); sembrar(x);
  const b = await preparar(x);
  await registrar(x, 'g1', b.intencion.operacionId);
  await assert.rejects(descartar(x, 'g1', b.intencion.operacionId), codigo('failed-precondition', 'intencion_cerrada'));
  assert.equal(x.saldo().saldoPendiente, 60, 'descartar una aplicada no deshace nada');
  await assert.rejects(descartar(x, 'g1', 'op_que_no_existe_xxxxxxxx'), codigo('failed-precondition', 'intencion_inexistente'));
});

// ── auth, roles y payload ─────────────────────────────────────────────────────
test('F4C-A1 · sin sesión, digitador o cuenta inactiva ⇒ rechazados en las tres callables; 0 efectos', async () => {
  const w = mundo(); sembrar(w);
  const antes = w.snapshot();
  await assert.rejects(preparar(w, null), codigo('unauthenticated'));
  await assert.rejects(obtener(w, null), codigo('unauthenticated'));
  await assert.rejects(descartar(w, null, 'op_cualquiera_xxxxxxxxxx'), codigo('unauthenticated'));
  for (const uid of ['dig', 'baja', 'noexiste']) {
    await assert.rejects(preparar(w, uid), codigo('permission-denied'), uid);
    await assert.rejects(obtener(w, uid), codigo('permission-denied'), uid);
  }
  await assert.rejects(preparar(w, 'g1', { saldoId: 'nada' }), codigo('not-found'));
  assert.equal(w.snapshot(), antes);
});

test('F4C-A2 · el payload de preparar solo admite la intención: nada de actor, rol, operacionId, estado ni saldo pendiente ⇒ invalid-argument', async () => {
  const w = mundo(); sembrar(w);
  for (const malo of [null, [], 's1', {}, { ...base, operacionId: 'op_cliente_fabricado_xx' }, { ...base, actorUid: 'a1' }, { ...base, actorRol: 'admin' }, { ...base, estado: 'aplicada' },
    { ...base, saldoPendiente: 1 }, { ...base, motorizadoId: 'm' }, { ...base, monto: 0 }, { ...base, monto: -1 }, { ...base, monto: 1.234 }, { ...base, monto: NaN },
    { ...base, metodoAbono: 'efectivo' }, { ...base, saldoId: '' }, { ...base, saldoId: 'a/b' }, { ...base, reconoceOperacionId: 'corto' }, { ...base, reconoceOperacionId: 5 },
    { ...base, comprobantePath: 'saldos/s2/abono_0.jpg' }]) {
    await assert.rejects(prepararAbonoDirectoCore(w.depsInt, 'g1', malo), codigo('invalid-argument'), JSON.stringify(malo));
  }
  for (const malo of [null, {}, { saldoId: 's1', extra: 1 }, { saldoId: '' }]) await assert.rejects(obtenerIntencionAbonoCore(w.depsInt, 'g1', malo), codigo('invalid-argument'));
  for (const malo of [null, {}, { operacionId: 'corto' }, { operacionId: 'op_valida_de_16_chars', extra: 1 }]) await assert.rejects(descartarIntencionAbonoCore(w.depsInt, 'g1', malo), codigo('invalid-argument'));
  assert.equal(w.intenciones().length, 0);
  assert.equal(validarPeticionPreparar({ ...base, nota: '  x ' }).nota, 'x');
});

// ── Contrato del adaptador real y de la regla "sin TTL" ───────────────────────
test('F4C-AT2 · las intenciones solo las escriben las Functions (Admin SDK, dentro de runTransaction); nada las borra ni las caduca; las Rules no las abren', () => {
  const norm = (p: string[]) => readFileSync(join(__dirname, ...p), 'utf8').replace(/\r\n/g, '\n');
  const callable = norm(['..', '..', 'src', 'abono-intencion-callable.ts']).replace(/\/\/.*$/gm, '');
  const nucleo = norm(['..', '..', 'src', 'abono-intencion.ts']).replace(/\/\/.*$/gm, '');
  assert.equal((callable.match(/db\.runTransaction\(/g) ?? []).length, 1, 'una sola transacción');
  const sinTx = callable.replace(/tx\.(create|update|set)\(/g, 'TX_$1(');
  for (const w of ['.add(', '.set(', '.create(', '.update(', '.batch(', 'bulkWriter', '.delete(']) assert.ok(!sinTx.includes(w), `sin ${w} fuera de la transacción`);
  for (const x of ['delete', 'TTL', 'ttl', 'expira', 'caduca', 'FieldValue.delete']) assert.ok(!nucleo.includes(x) && !callable.includes(x), `ninguna ruta borra o caduca intenciones (${x})`);
  const rules = norm(['..', '..', '..', 'firestore.rules']);
  assert.ok(!rules.includes('intenciones_abono_directo') && !rules.includes('punteros_abono_directo'), 'sin reglas de cliente: el cliente no las lee ni las escribe');
});

// ── Fix post-E2E: opcionales que el SDK de Firebase entrega como null ─────────
// @firebase/functions serializa `undefined` como `null`: el primer abono real llegó con
// `reconoceOperacionId: null` y el parser lo rechazó como inválido. Para los campos REALMENTE opcionales
// (reconoceOperacionId, nota, comprobanteUrl, comprobantePath) null == ausente; los obligatorios siguen
// estrictos y un tipo equivocado distinto de null sigue siendo inválido.
test('F4C-NULL1 · REPRODUCCIÓN E2E: saldo 80, primer abono C$10 por ajuste_manual con reconoceOperacionId:null (como lo entrega el SDK) ⇒ se prepara, se aplica: 80→70, abonado_parcial', async () => {
  const w = mundo(); sembrar(w, { saldo: { montoOriginal: 80, saldoPendiente: 80 } });
  const peticion = { saldoId: 's1', monto: 10, metodoAbono: 'ajuste_manual', nota: 'E2E FIN-4C abono directo autoritativo', reconoceOperacionId: null };
  const p = await prepararAbonoDirectoCore(w.depsInt, 'a1', peticion);
  assert.equal(p.resultado, 'preparada');
  const r = await registrarAbonoDirectoCore(w.depsAbo, 'a1', { saldoId: 's1', monto: 10, operacionId: p.intencion.operacionId, metodoAbono: 'ajuste_manual', nota: 'E2E FIN-4C abono directo autoritativo' });
  assert.equal(r.resultado, 'aplicado');
  assert.equal(w.saldo().saldoPendiente, 70);
  assert.equal(w.saldo().estado, 'abonado_parcial');
  assert.equal((w.saldo().abonos as Doc[]).length, 1);
  assert.equal(w.movimientos().length, 1);
  assert.equal(w.intenciones()[0].estado, 'aplicada');
  assert.equal(w.intenciones()[0].actorRol, 'admin');
});

test('F4C-NULL2 · (SDK-2) null en un opcional REAL equivale a ausente: la petición normalizada es idéntica a la que lo omite', () => {
  const sin = validarPeticionPreparar({ ...base, metodoAbono: 'ajuste_manual' });
  for (const campo of ['reconoceOperacionId', 'nota', 'comprobanteUrl', 'comprobantePath']) {
    const con = validarPeticionPreparar({ ...base, metodoAbono: 'ajuste_manual', [campo]: null });
    assert.deepEqual(con, sin, `${campo}: null ≡ ausente`);
  }
  const todos = validarPeticionPreparar({ ...base, nota: null, comprobanteUrl: null, comprobantePath: null, reconoceOperacionId: null });
  assert.equal(Object.prototype.hasOwnProperty.call(todos, 'reconoceOperacionId'), false);
  assert.equal(Object.prototype.hasOwnProperty.call(todos, 'comprobanteUrl'), false);
  const reg = validarPeticionAbono({ ...base, operacionId: 'op_valida_de_16_chars', comprobanteUrl: null, comprobantePath: null, nota: null });
  assert.equal(Object.prototype.hasOwnProperty.call(reg, 'comprobanteUrl'), false);
  assert.equal(Object.prototype.hasOwnProperty.call(reg, 'comprobantePath'), false);
});

test('F4C-NULL3 · (SDK-3) un tipo equivocado distinto de null SIGUE siendo inválido en cada opcional', () => {
  const invalido = (extra: Record<string, unknown>) => assert.throws(() => validarPeticionPreparar({ ...base, ...extra }), codigo('invalid-argument'), JSON.stringify(extra));
  for (const v of [123, {}, [], true, '', 'corto', 'con espacios no validos 1234']) invalido({ reconoceOperacionId: v });
  for (const v of [123, {}, [], true, 'http://x/y.jpg', '']) invalido({ comprobanteUrl: v });
  for (const v of [123, {}, [], true, 'otro/lugar.jpg', 'saldos/s2/abono_0.jpg', 'saldos/s1/../x']) invalido({ comprobantePath: v });
  for (const v of [123, {}, [], true]) invalido({ nota: v });
  for (const v of [123, {}, [], true, '']) assert.throws(() => validarPeticionAbono({ ...base, operacionId: 'op_valida_de_16_chars', comprobanteUrl: v }), codigo('invalid-argument'));
});

test('F4C-NULL4 · null NO relaja los OBLIGATORIOS: saldoId, monto, metodoAbono (y operacionId al registrar) nulos ⇒ invalid-argument; los campos extra siguen rechazados', () => {
  for (const campo of ['saldoId', 'monto', 'metodoAbono']) {
    assert.throws(() => validarPeticionPreparar({ ...base, [campo]: null }), codigo('invalid-argument'), `preparar ${campo}`);
    assert.throws(() => validarPeticionAbono({ ...base, operacionId: 'op_valida_de_16_chars', [campo]: null }), codigo('invalid-argument'), `registrar ${campo}`);
  }
  assert.throws(() => validarPeticionAbono({ ...base, operacionId: null }), codigo('invalid-argument'));
  assert.throws(() => validarPeticionAbono({ ...base }), codigo('invalid-argument'), 'operacionId ausente');
  assert.throws(() => validarPeticionPreparar({ ...base, extra: null }), codigo('invalid-argument'), 'campo extra aunque sea null');
  assert.throws(() => validarPeticionPreparar({ ...base, operacionId: null }), codigo('invalid-argument'), 'preparar no acepta operacionId');
});

test('F4C-NULL5 · reconoceOperacionId:null NO rompe la protección de la intención: tras A aplicada no nace B; con el reconocimiento explícito de A sí', async () => {
  const w = mundo(); sembrar(w);
  const a = await preparar(w);
  await registrar(w, 'g1', a.intencion.operacionId);
  const sinReconocer = await preparar(w, 'g1', { reconoceOperacionId: null });
  assert.equal(sinReconocer.resultado, 'ya_aplicada');
  assert.equal(sinReconocer.intencion.operacionId, a.intencion.operacionId);
  assert.equal(w.intenciones().length, 1, 'no se creó B en silencio');
  const b = await preparar(w, 'g1', { reconoceOperacionId: a.intencion.operacionId });
  assert.notEqual(b.intencion.operacionId, a.intencion.operacionId);
  assert.equal(w.intenciones().length, 2);
  assert.equal((await preparar(w, 'g1', { reconoceOperacionId: null })).resultado, 'recuperada');
  assert.equal(w.intenciones().length, 2);
});

// ── Comprobante de la transferencia: regla de negocio SERVER-SIDE ─────────────
// La pantalla exige comprobante solo para `transferencia` (METODOS_REQUIEREN_COMPROBANTE) y manda AMBOS campos
// (comprobanteUrl y comprobantePath, que produce uploadComprobante). El servidor ahora lo hace autoritativo en
// registrarAbonoDirecto: preparar corre ANTES de subir la imagen, así que no puede exigirlo; la intención queda
// preparada (no se cierra) y se aplica cuando llega con su comprobante.
const COMPROBANTE = { comprobanteUrl: 'https://ex.test/c.jpg', comprobantePath: 'saldos/s1/abono_0.jpg' };

test('F4C-TR1 · transferencia SIN comprobante ⇒ rechazo de negocio (failed-precondition/comprobante_requerido): 0 saldo, 0 abono, 0 ledger; la intención sigue preparada', async () => {
  const w = mundo(); sembrar(w);
  const p = await preparar(w, 'g1', { metodoAbono: 'transferencia' });
  assert.equal(p.resultado, 'preparada', 'preparar no puede exigirlo: la pantalla sube la imagen DESPUÉS');
  const antes = w.snapshot();
  await assert.rejects(registrar(w, 'g1', p.intencion.operacionId, { metodoAbono: 'transferencia' }), codigo('failed-precondition', 'comprobante_requerido'));
  assert.equal(w.snapshot(), antes, 'ni una escritura');
  assert.equal(w.saldo().saldoPendiente, 100);
  assert.equal((w.saldo().abonos as Doc[]).length, 0);
  assert.equal(w.movimientos().length, 0);
  assert.equal(w.intenciones()[0].estado, 'preparada');
  // el mismo operacionId se aplica después, con su comprobante
  assert.equal((await registrar(w, 'g1', p.intencion.operacionId, { metodoAbono: 'transferencia', ...COMPROBANTE })).resultado, 'aplicado');
  assert.equal(w.saldo().saldoPendiente, 60);
});

test('F4C-TR2 · transferencia CON comprobante válido (url + path) ⇒ permitida y el abono guarda el comprobante', async () => {
  const w = mundo(); sembrar(w);
  const p = await preparar(w, 'g1', { metodoAbono: 'transferencia' });
  assert.equal((await registrar(w, 'g1', p.intencion.operacionId, { metodoAbono: 'transferencia', ...COMPROBANTE })).resultado, 'aplicado');
  const abono = (w.saldo().abonos as Doc[])[0];
  assert.equal(abono.comprobanteUrl, COMPROBANTE.comprobanteUrl);
  assert.equal(abono.comprobantePath, COMPROBANTE.comprobantePath);
});

test('F4C-TR3 · transferencia con comprobante null (como lo manda el SDK) o a medias ⇒ rechazo de NEGOCIO, no invalid-argument del parser', async () => {
  for (const comp of [{ comprobanteUrl: null, comprobantePath: null }, { comprobanteUrl: null }, { comprobanteUrl: COMPROBANTE.comprobanteUrl }, { comprobantePath: COMPROBANTE.comprobantePath }, { comprobanteUrl: COMPROBANTE.comprobanteUrl, comprobantePath: null }]) {
    const w = mundo(); sembrar(w);
    const p = await preparar(w, 'g1', { metodoAbono: 'transferencia' });
    const antes = w.snapshot();
    await assert.rejects(registrar(w, 'g1', p.intencion.operacionId, { metodoAbono: 'transferencia', ...comp }), codigo('failed-precondition', 'comprobante_requerido'), JSON.stringify(comp));
    assert.equal(w.snapshot(), antes);
  }
});

test('F4C-TR4 · ajuste_manual sin comprobante (ausente o null) ⇒ permitido: la regla NO es global', async () => {
  for (const comp of [{}, { comprobanteUrl: null, comprobantePath: null }]) {
    const w = mundo(); sembrar(w);
    const p = await preparar(w, 'g1', { metodoAbono: 'ajuste_manual' });
    assert.equal((await registrar(w, 'g1', p.intencion.operacionId, { metodoAbono: 'ajuste_manual', ...comp })).resultado, 'aplicado');
    const abono = (w.saldo().abonos as Doc[])[0];
    assert.equal('comprobanteUrl' in abono, false);
    assert.equal('comprobantePath' in abono, false);
  }
});

test('F4C-TR5 · descuento_liquidacion sin comprobante ⇒ se preserva el contrato actual (permitido)', async () => {
  const w = mundo(); sembrar(w);
  const p = await preparar(w, 'g1', { metodoAbono: 'descuento_liquidacion' });
  assert.equal((await registrar(w, 'g1', p.intencion.operacionId, { metodoAbono: 'descuento_liquidacion' })).resultado, 'aplicado');
  assert.equal(w.movimientos().length, 1);
});

test('F4C-TR6 · comprobantePath de OTRO saldo sigue rechazado (invalid-argument), también en transferencia', async () => {
  const w = mundo(); sembrar(w);
  const p = await preparar(w, 'g1', { metodoAbono: 'transferencia' });
  const antes = w.snapshot();
  await assert.rejects(registrar(w, 'g1', p.intencion.operacionId, { metodoAbono: 'transferencia', comprobanteUrl: COMPROBANTE.comprobanteUrl, comprobantePath: 'saldos/s2/abono_0.jpg' }), codigo('invalid-argument'));
  assert.equal(w.snapshot(), antes);
});

test('F4C-TR7 · URL o path inválidos siguen rechazados (invalid-argument) en transferencia; el parser corre antes que la regla de negocio', async () => {
  const w = mundo(); sembrar(w);
  const p = await preparar(w, 'g1', { metodoAbono: 'transferencia' });
  for (const comp of [{ comprobanteUrl: 'http://ex.test/c.jpg', comprobantePath: COMPROBANTE.comprobantePath }, { comprobanteUrl: 5, comprobantePath: COMPROBANTE.comprobantePath }, { comprobanteUrl: COMPROBANTE.comprobanteUrl, comprobantePath: 'otro/lugar.jpg' },
    { comprobanteUrl: COMPROBANTE.comprobanteUrl, comprobantePath: 'saldos/s1/../x.jpg' }, { comprobanteUrl: COMPROBANTE.comprobanteUrl, comprobantePath: 7 }]) {
    await assert.rejects(registrar(w, 'g1', p.intencion.operacionId, { metodoAbono: 'transferencia', ...comp }), codigo('invalid-argument'), JSON.stringify(comp));
  }
  assert.equal(w.movimientos().length, 0);
});

test('F4C-TR8 · el idempotente ya_aplicado de una transferencia no pide el comprobante otra vez; la regla corre solo para una operación que aún se va a aplicar', async () => {
  const w = mundo(); sembrar(w);
  const p = await preparar(w, 'g1', { metodoAbono: 'transferencia' });
  await registrar(w, 'g1', p.intencion.operacionId, { metodoAbono: 'transferencia', ...COMPROBANTE });
  assert.equal((await registrar(w, 'g1', p.intencion.operacionId, { metodoAbono: 'transferencia', ...COMPROBANTE })).resultado, 'ya_aplicado');
  assert.equal(w.saldo().saldoPendiente, 60);
  assert.equal(w.movimientos().length, 1);
});
