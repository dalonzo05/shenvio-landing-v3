// A7-01 — Orquestación del migrador sobre interfaces INYECTADAS (dry-run y apply). Sin firebase-admin: testeable con un mundo en memoria.
// El adaptador real vive en scripts/a7-prod-legacy.cjs. No es una Cloud Function y no se exporta desde index.ts.
//
// Garantías:
//   · DRY-RUN: solo `Lector` (no existe método de escritura en su tipo).
//   · APPLY: valida el manifest (guardas, fuente, huella, 0 conflictos) ANTES de abrir cualquier transacción; luego una transacción
//     por dominio (comercio / órdenes / depósitos), cada una releyendo TODO lo que decide dentro de la propia transacción.
//   · Comercio es todo-o-nada. Códigos + contador se escriben en la MISMA transacción (nunca queda un contador desincronizado).
//   · Un dominio que cambió desde el dry-run se SALTA entero (SKIP_CONFLICT, 0 writes en él) y se reporta; un error inesperado DETIENE la corrida.
//   · No hay rollback: el reporte lista cada write con su valor previo para una operación separada y explícita.

import {
  COL_COMERCIOS, COL_CONTADORES, COL_USUARIOS, DOMINIOS, KIND_APPLY, SCHEMA_VERSION,
  construirManifest, decidirComercio, decidirDominio, planificarApply, planificarTodo,
  type DocLite, type Foto, type FuenteActual, type ManifestDryRun, type MetaManifest, type ResultadoDominio,
} from './legacy-prod-migracion';

export interface Lector {
  /** Todos los documentos de la colección (data cruda, tal como llega del SDK). */
  listar(coleccion: string): Promise<DocLite[]>;
  getDoc(coleccion: string, id: string): Promise<DocLite | null>;
}

export interface Transaccion extends Lector {
  /** update: falla si el documento no existe. */
  actualizar(coleccion: string, id: string, campos: Record<string, unknown>): void;
  /** create: falla si el documento ya existe (nunca pisa un contador que apareció). */
  crear(coleccion: string, id: string, campos: Record<string, unknown>): void;
}

export interface Entorno {
  transaccion<T>(fn: (tx: Transaccion) => Promise<T>): Promise<T>;
}

async function leerFoto(l: Lector): Promise<Foto> {
  const [usuarios, comercios, ordenes, depositos, contadores] = await Promise.all([
    l.listar(COL_USUARIOS), l.listar(COL_COMERCIOS), l.listar(DOMINIOS[0].coleccion), l.listar(DOMINIOS[1].coleccion), l.listar(COL_CONTADORES),
  ]);
  return { usuarios, comercios, ordenes, depositos, contadores };
}

/** DRY RUN: solo lectura. Devuelve el manifest. */
export async function ejecutarDryRun(lector: Lector, meta: MetaManifest): Promise<ManifestDryRun> {
  return construirManifest(planificarTodo(await leerFoto(lector)), meta);
}

export interface WriteRegistrado {
  coleccion: string;
  id: string;
  operacion: 'update' | 'create';
  anterior: Record<string, unknown>;
  nuevo: Record<string, unknown>;
}

export interface ResultadoDominioApply {
  dominio: string;
  resultado: ResultadoDominio | 'ERROR_STOP';
  motivo: string;
  writes: WriteRegistrado[];
}

export interface ManifestApply {
  schemaVersion: number;
  kind: typeof KIND_APPLY;
  mode: 'apply';
  projectId: string;
  generatedAt: string;
  sourceGitSha: string;
  sourceManifestSha256: string;
  totales: Record<string, number>;
  detenido: boolean;
  resultados: ResultadoDominioApply[];
}

const ref = (coleccion: string, id: string, anterior: Record<string, unknown>, nuevo: Record<string, unknown>, operacion: 'update' | 'create' = 'update'): WriteRegistrado =>
  ({ coleccion, id, operacion, anterior, nuevo });

/**
 * APPLY. El caller ya validó las guardas de argumentos. Aquí: valida el manifest (lanza ManifestInvalido ⇒ 0 writes) y aplica cada dominio
 * en su transacción, revalidando contra lo releído dentro de ella.
 */
export async function ejecutarApply(
  env: Entorno, manifest: unknown, meta: { projectId: string; ahora: Date; fuente: FuenteActual },
): Promise<ManifestApply> {
  const plan = planificarApply(manifest, meta.projectId, meta.fuente); // lanza ⇒ 0 writes
  const m = manifest as ManifestDryRun;
  const resultados: ResultadoDominioApply[] = [];
  let detenido = false;

  const correr = async (dominio: string, fn: () => Promise<Omit<ResultadoDominioApply, 'dominio'>>): Promise<void> => {
    if (detenido) return;
    try {
      resultados.push({ dominio, ...(await fn()) });
    } catch (e) {
      resultados.push({ dominio, resultado: 'ERROR_STOP', motivo: e instanceof Error ? e.message : String(e), writes: [] });
      detenido = true;
    }
  };

  // 1 · Comercio — todo-o-nada.
  await correr(COL_USUARIOS, () => env.transaccion(async (tx) => {
    const [usuarios, comercios] = await Promise.all([tx.listar(COL_USUARIOS), tx.listar(COL_COMERCIOS)]);
    const d = decidirComercio(plan.comercio, usuarios, comercios);
    const writes: WriteRegistrado[] = [];
    for (const uid of d.escribir) {
      tx.actualizar(COL_USUARIOS, uid, { comercioId: uid }); // y NADA MÁS
      writes.push(ref(COL_USUARIOS, uid, { comercioId: null }, { comercioId: uid }));
    }
    return { resultado: d.resultado, motivo: d.motivo, writes };
  }));

  // 2 · Códigos + contador, una transacción por dominio.
  for (const dom of plan.dominios) {
    await correr(dom.config.coleccion, () => env.transaccion(async (tx) => {
      const [docs, contador] = await Promise.all([tx.listar(dom.config.coleccion), tx.getDoc(COL_CONTADORES, dom.config.contadorId)]);
      const d = decidirDominio(dom, docs, contador);
      const writes: WriteRegistrado[] = [];
      for (const a of d.asignaciones) {
        tx.actualizar(dom.config.coleccion, a.docId, { codigo: a.codigo, secuencia: a.secuencia }); // sin historia, sin timestamps
        writes.push(ref(dom.config.coleccion, a.docId, { codigo: null, secuencia: null }, { codigo: a.codigo, secuencia: a.secuencia }));
      }
      if (d.contador) {
        const anterior = contador ? { valor: contador.data.valor ?? null } : { valor: null };
        if (d.contador.accion === 'crear') tx.crear(COL_CONTADORES, dom.config.contadorId, { valor: d.contador.valor });
        else tx.actualizar(COL_CONTADORES, dom.config.contadorId, { valor: d.contador.valor });
        writes.push(ref(COL_CONTADORES, dom.config.contadorId, anterior, { valor: d.contador.valor }, d.contador.accion === 'crear' ? 'create' : 'update'));
      }
      return { resultado: d.resultado, motivo: d.motivo, writes };
    }));
  }

  const totales: Record<string, number> = { APLICADO: 0, YA_APLICADO: 0, SIN_CAMBIOS: 0, SKIP_CONFLICT: 0, ERROR_STOP: 0, writes: 0 };
  for (const r of resultados) { totales[r.resultado] += 1; totales.writes += r.writes.length; }
  return {
    schemaVersion: SCHEMA_VERSION,
    kind: KIND_APPLY,
    mode: 'apply',
    projectId: meta.projectId,
    generatedAt: meta.ahora.toISOString(),
    sourceGitSha: meta.fuente.sourceGitSha,
    sourceManifestSha256: m.itemsSha256,
    totales,
    detenido,
    resultados,
  };
}
