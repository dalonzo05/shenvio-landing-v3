// FIN-GASTOS-CONSUMO-BACKFILL-1 (A3-02) — lectura de evidencia, dry-run y apply sobre interfaces INYECTADAS.
//
// Separación (testeable sin Firestore): gasto-consumo-backfill.ts = lógica pura; este archivo = orquestación contra un `Lector`/`Transaccion` abstractos;
// scripts/backfill-gastos-consumo.cjs = el único que conoce firebase-admin. No es una Cloud Function y no se exporta desde index.ts.
//
// AUDITORÍA (decisión): NO se crea colección nueva. No se mueve dinero (nada de movimientos_financieros) y una colección nueva ampliaría el alcance de
// Rules/seguridad sin necesidad. La trazabilidad queda (a) en el propio gasto, con campos NUEVOS `consumoBackfillOperacionId` / `consumoBackfillAt`
// (nunca `operacionId`, que identifica la creación del gasto), y (b) en el manifest de apply local (valor anterior/nuevo, updateTime pre/post, rollback).

import type { DocumentData } from 'firebase-admin/firestore';
import { depositoVivo } from './gasto-consumo-backfill';
import {
  CAMPO_BACKFILL_AT, CAMPO_MARCA, COLECCION_DEPOSITOS, COLECCION_GASTOS, COLECCION_LIQUIDACIONES, COLECCION_MOTORIZADOS, COLECCION_ORDENES,
  clasificarGasto, construirManifest, decidirItem, idOperacionBackfill, planificarApply,
  type DocRef, type EntradaClasificacion, type ItemBackfill, type ManifestDryRun, type RegistroRollback, type ResultadoItemApply,
} from './gasto-consumo-backfill';
import { idsUnicos } from './deposito-monto';

export interface Lector {
  getDoc(coleccion: string, id: string): Promise<DocRef | null>;
  /** where(campo, 'array-contains', valor) */
  consultaArrayContains(coleccion: string, campo: string, valor: string): Promise<DocRef[]>;
  /** where(campo, 'in', valores) — máx. 30 valores */
  consultaIn(coleccion: string, campo: string, valores: string[]): Promise<DocRef[]>;
  /** Todos los documentos de la colección. */
  listar(coleccion: string): Promise<DocRef[]>;
}

export interface Transaccion extends Lector {
  /** update con precondición lastUpdateTime: falla si el documento cambió. */
  actualizar(coleccion: string, id: string, campos: DocumentData, lastUpdateTime: string): void;
}

export interface Entorno {
  transaccion<T>(fn: (tx: Transaccion) => Promise<T>): Promise<T>;
  /** Centinela de serverTimestamp del SDK (llega de afuera para que esto siga siendo puro). */
  serverTimestamp(): unknown;
  /** Lector sin transacción, para el updateTime posterior. */
  lector: Lector;
}

const texto = (v: unknown): string | null => (typeof v === 'string' && v.length > 0 ? v : null);

/** Reúne TODA la evidencia de un gasto. Solo lee. */
export async function reunirEvidencia(lector: Lector, gasto: DocRef): Promise<EntradaClasificacion> {
  const g = gasto.data;
  const [depositosQueLoListan, liquidacionesQueLoListan] = await Promise.all([
    lector.consultaArrayContains(COLECCION_DEPOSITOS, 'gastosIds', gasto.id),
    lector.consultaArrayContains(COLECCION_LIQUIDACIONES, 'gastosIds', gasto.id),
  ]);
  const marca = texto(g[CAMPO_MARCA]);
  const depositoMarcado = marca ? await lector.getDoc(COLECCION_DEPOSITOS, marca) : null;

  // Motorizado del gasto → sus depósitos (por authUid y, para docs antiguos, por doc id).
  const motorizadoId = texto(g.motorizadoId);
  const moto = motorizadoId ? await lector.getDoc(COLECCION_MOTORIZADOS, motorizadoId) : null;
  const authUid = texto(moto?.data.authUid);
  const claves = [...new Set([authUid, motorizadoId].filter((x): x is string => !!x))];
  const depositosDelMotorizado = claves.length > 0 ? await lector.consultaIn(COLECCION_DEPOSITOS, 'motorizadoUid', claves) : [];

  // authUid → doc id canónico para cada motorizadoUid que aparece.
  const uids = [...new Set([...depositosQueLoListan, ...depositosDelMotorizado, ...(depositoMarcado ? [depositoMarcado] : [])]
    .map((d) => texto(d.data.motorizadoUid)).filter((x): x is string => !!x))];
  const docIdPorAuthUid: Record<string, string> = {};
  for (let i = 0; i < uids.length; i += 30) {
    for (const m of await lector.consultaIn(COLECCION_MOTORIZADOS, 'authUid', uids.slice(i, i + 30))) {
      const u = texto(m.data.authUid);
      if (u) docIdPorAuthUid[u] = m.id;
    }
  }

  // Gastos citados por los depósitos relevantes (vivos del motorizado, los que listan el gasto y el marcado).
  const relevantes = new Map<string, DocRef>();
  for (const d of [...depositosQueLoListan, ...depositosDelMotorizado.filter((x) => depositoVivo(x.data)), ...(depositoMarcado ? [depositoMarcado] : [])]) relevantes.set(d.id, d);
  const gastosDeDepositos: Record<string, DocumentData | null> = {};
  for (const d of relevantes.values()) {
    for (const gid of idsUnicos(d.data.gastosIds)) {
      if (gid === gasto.id || gid in gastosDeDepositos) continue;
      gastosDeDepositos[gid] = (await lector.getDoc(COLECCION_GASTOS, gid))?.data ?? null;
    }
  }

  // Órdenes de los depósitos VIVOS que listan el gasto (solo ahí se calcula el bruto).
  const ordenes: Record<string, DocumentData | null> = {};
  for (const d of depositosQueLoListan.filter((x) => depositoVivo(x.data))) {
    for (const sid of idsUnicos(d.data.solicitudIds)) {
      if (sid in ordenes) continue;
      ordenes[sid] = (await lector.getDoc(COLECCION_ORDENES, sid))?.data ?? null;
    }
  }

  return { gasto, depositosQueLoListan, liquidacionesQueLoListan, depositoMarcado, gastosDeDepositos, ordenes, docIdPorAuthUid, depositosDelMotorizado };
}

/** Memoriza lecturas: el dry-run recorre muchos gastos del mismo motorizado/depósito. Solo para lecturas SIN transacción. */
export function conCache(l: Lector): Lector {
  const m = new Map<string, Promise<unknown>>();
  const memo = <T>(k: string, f: () => Promise<T>): Promise<T> => { if (!m.has(k)) m.set(k, f()); return m.get(k) as Promise<T>; };
  return {
    getDoc: (c, id) => memo(`d|${c}|${id}`, () => l.getDoc(c, id)),
    consultaArrayContains: (c, f, v) => memo(`a|${c}|${f}|${v}`, () => l.consultaArrayContains(c, f, v)),
    consultaIn: (c, f, v) => memo(`i|${c}|${f}|${[...v].sort().join(',')}`, () => l.consultaIn(c, f, v)),
    listar: (c) => memo(`l|${c}`, () => l.listar(c)),
  };
}

/** DRY RUN: solo lectura. Devuelve el manifest. */
export async function ejecutarDryRun(lector: Lector, meta: { projectId: string; sourceGitSha: string; ahora: Date }): Promise<ManifestDryRun> {
  const cache = conCache(lector);
  const gastos = (await cache.listar(COLECCION_GASTOS)).sort((a, b) => (a.id < b.id ? -1 : 1));
  const items: ItemBackfill[] = [];
  for (const g of gastos) items.push(clasificarGasto(await reunirEvidencia(cache, g)));
  return construirManifest(items, { projectId: meta.projectId, sourceGitSha: meta.sourceGitSha, generatedAt: meta.ahora.toISOString() });
}

export interface ResultadoItem {
  gastoId: string;
  depositoObjetivo: string;
  resultado: ResultadoItemApply | 'ERROR_STOP';
  motivo: string;
  rollback: RegistroRollback | null;
}

export interface ManifestApply {
  schemaVersion: number;
  kind: 'gastos-consumo-backfill-apply';
  mode: 'apply';
  projectId: string;
  operacionBackfillId: string;
  generatedAt: string;
  sourceManifestSha256: string;
  totales: Record<string, number>;
  omitidos: Array<{ gastoId: string; clasificacion: string; resultado: string }>;
  detenido: boolean;
  resultados: ResultadoItem[];
}

/**
 * APPLY. El caller ya validó las guardas (args/producción). Aquí: valida el manifest (huella, proyecto, clases), y por cada candidato A, DENTRO de una transacción,
 * relee gasto y toda la evidencia, re-clasifica, y escribe SOLO si coincide con el manifest (incluidos los updateTime) y con precondición lastUpdateTime.
 * Un error inesperado detiene la corrida (fail-closed); un conflicto salta ese gasto y sigue.
 */
export async function ejecutarApply(env: Entorno, manifest: unknown, meta: { projectId: string; ahora: Date }): Promise<ManifestApply> {
  const plan = planificarApply(manifest, meta.projectId); // lanza ManifestInvalido ⇒ 0 writes
  const m = manifest as ManifestDryRun;
  const operacionBackfillId = idOperacionBackfill(meta.ahora, m.itemsSha256);
  const resultados: ResultadoItem[] = [];
  let detenido = false;

  for (const it of plan.candidatos) {
    const objetivo = it.depositoObjetivo as string;
    try {
      const decision = await env.transaccion(async (tx) => {
        const gasto = await tx.getDoc(COLECCION_GASTOS, it.gastoId);
        const fresco = gasto ? clasificarGasto(await reunirEvidencia(tx, gasto)) : null;
        const d = decidirItem(it, fresco, operacionBackfillId);
        if (d.resultado === 'APLICADO' && gasto && d.campos) {
          tx.actualizar(COLECCION_GASTOS, it.gastoId, { ...d.campos, [CAMPO_BACKFILL_AT]: env.serverTimestamp() }, gasto.updateTime as string);
        }
        return d;
      });
      let rollback: RegistroRollback | null = null;
      if (decision.resultado === 'APLICADO' && decision.campos) {
        const post = await env.lector.getDoc(COLECCION_GASTOS, it.gastoId);
        rollback = {
          gastoId: it.gastoId,
          operacionBackfillId,
          valorAnterior: { [CAMPO_MARCA]: null },
          valorNuevo: { [CAMPO_MARCA]: objetivo, consumoBackfillOperacionId: operacionBackfillId },
          updateTimePre: it.gastoUpdateTime,
          updateTimePost: post?.updateTime ?? null,
        };
      }
      resultados.push({ gastoId: it.gastoId, depositoObjetivo: objetivo, resultado: decision.resultado, motivo: decision.motivo, rollback });
    } catch (e) {
      resultados.push({ gastoId: it.gastoId, depositoObjetivo: objetivo, resultado: 'ERROR_STOP', motivo: e instanceof Error ? e.message : String(e), rollback: null });
      detenido = true;
      break;
    }
  }

  const totales: Record<string, number> = { APLICADO: 0, IDEMPOTENT_SKIP: 0, SKIP_CONFLICT: 0, ERROR_STOP: 0, SKIP_CLASE_NO_APLICABLE: plan.omitidos.length };
  for (const r of resultados) totales[r.resultado] += 1;
  return {
    schemaVersion: m.schemaVersion,
    kind: 'gastos-consumo-backfill-apply',
    mode: 'apply',
    projectId: meta.projectId,
    operacionBackfillId,
    generatedAt: meta.ahora.toISOString(),
    sourceManifestSha256: m.itemsSha256,
    totales,
    omitidos: plan.omitidos,
    detenido,
    resultados,
  };
}
