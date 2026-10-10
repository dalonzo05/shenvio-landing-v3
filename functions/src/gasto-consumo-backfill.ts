// ═════════════════════════════════════════════════
// FIN-GASTOS-CONSUMO-BACKFILL-1 (A3-02) — clasificación PURA, manifest, guardas y plan de apply
// ═════════════════════════════════════════════════
//
// Contexto: FIN-2 marca un gasto consumido por un depósito StorkHub con `gastos_motorizado/{id}.consumidoEnDepositoId`. Los depósitos anteriores a FIN-2 listan
// el gasto en `ordenes_deposito.gastosIds` pero el gasto NO tiene la marca: otro depósito (o `confirmarDeposito`, que exige la marca) lo vuelve a tratar como libre.
// Este módulo decide, SIN I/O, qué gastos tienen un destino DEMOSTRABLE para escribirles la marca. Todo lo que no se demuestra se reporta y NO se escribe.
//
// Semántica REUTILIZADA (no reinventada), con la fuente de cada pieza:
//   · depósito vivo = estado ∉ {anulado, rechazado}                         → anular-gasto.ts / crear-liquidacion.ts (`depositoVivo`) y firestore.rules (`depositoConsumeEsteGasto`).
//   · depósito StorkHub = tipo === 'recaudacion_motorizado_storkhub'        → deposito-monto.ts (TIPO_DEPOSITO_STORKHUB), exacto, como Rules y demostrarDeposito.
//   · gasto elegible/consumible = aprobado, sin liquidacionId, sin marca    → deposito-monto.ts (demostrarDeposito) + liquidacion-calculo.ts (gastoTieneMarca).
//   · bruto de las órdenes = calcularDeposito(orden).totalAStorkhub         → deposito-monto.ts; orden entregada y de ese motorizado (asignacion.motorizadoAuthUid).
//   · monto total = max(0, bruto − gastos); gastosDescontados; montoBruto   → deposito-monto.ts (demostrarDeposito).
//   · gasto.motorizadoId es el doc id canónico; el depósito guarda el authUid → `motorizado.authUid`, con el mismo respaldo (authUid) que getMotorizadoDocId.
//   · XOR depósito/liquidación: `liquidacionId` y `consumidoEnDepositoId` nunca coexisten → firestore.rules (consumoDeGastoValido).
//   · una liquidación "captura" un gasto si lo lista en gastosIds o si el gasto trae liquidacionId → anular-gasto.ts.
//
// PRECISIÓN MONETARIA: todo se compara en CENTAVOS enteros con `aCentavos` (Math.round(v*100)), la normalización de las liquidaciones. NO se usa la tolerancia
// 0.005 de `mismoMonto` ni ninguna otra: dos montos coinciden si y solo si coinciden sus centavos.
//
// Este módulo NO es una Cloud Function: no se exporta desde index.ts, no es callable ni trigger.

import { createHash } from 'node:crypto';
import type { DocumentData } from 'firebase-admin/firestore';
import { calcularDeposito } from './calculo-deposito';
import { TIPO_DEPOSITO_COMERCIO, TIPO_DEPOSITO_STORKHUB, esNumeroFinito, idsUnicos } from './deposito-monto';
import { aCentavos } from './liquidacion-calculo';

export const SCHEMA_VERSION = 1;
export const COLECCION_GASTOS = 'gastos_motorizado';
export const COLECCION_DEPOSITOS = 'ordenes_deposito';
export const COLECCION_LIQUIDACIONES = 'liquidaciones_motorizado';
export const COLECCION_ORDENES = 'solicitudes_envio';
export const COLECCION_MOTORIZADOS = 'motorizado';

export const CAMPO_MARCA = 'consumidoEnDepositoId';
/** Trazabilidad propia del backfill. NUNCA se reutiliza `operacionId` del gasto (identifica su creación). */
export const CAMPO_BACKFILL_OPERACION = 'consumoBackfillOperacionId';
export const CAMPO_BACKFILL_AT = 'consumoBackfillAt';

export const CLASE = {
  CONSUMIDO: 'CONSUMIDO_DEMOSTRADO',
  LIBRE: 'LIBRE_DEMOSTRADO',
  AMBIGUO: 'AMBIGUO',
  NO_APLICA: 'NO_APLICA',
  CONFLICTO: 'CONFLICTO',
  LEGACY_LIQUIDACION: 'LEGACY_LIQUIDACION',
} as const;
export type Clase = (typeof CLASE)[keyof typeof CLASE];
export const CLASES: readonly Clase[] = Object.values(CLASE);

export const DEPOSITO_VIVO_ESTADOS_EXCLUIDOS = ['anulado', 'rechazado'] as const;
export const depositoVivo = (d: DocumentData): boolean => !(DEPOSITO_VIVO_ESTADOS_EXCLUIDOS as readonly string[]).includes(String(d.estado ?? ''));

// ── Entrada / salida del clasificador ───────────────────────────────────────────

export interface DocRef { id: string; data: DocumentData; updateTime: string | null }

export interface EntradaClasificacion {
  gasto: DocRef;
  /** Depósitos (de cualquier estado y tipo) que listan el gasto en gastosIds. */
  depositosQueLoListan: DocRef[];
  /** Liquidaciones (de cualquier estado) que listan el gasto en gastosIds. */
  liquidacionesQueLoListan: DocRef[];
  /** El documento al que apunta la marca actual del gasto (null si no hay marca o el documento no existe). */
  depositoMarcado: DocRef | null;
  /** Gastos referenciados por los gastosIds de los depósitos relevantes (id → documento o null si no existe). */
  gastosDeDepositos: Record<string, DocumentData | null>;
  /** Órdenes referenciadas por los depósitos que listan el gasto (id → documento o null). */
  ordenes: Record<string, DocumentData | null>;
  /** authUid del motorizado → doc id canónico. Sin entrada se usa el authUid (docs antiguos), como getMotorizadoDocId. */
  docIdPorAuthUid: Record<string, string>;
  /** Todos los depósitos del motorizado del gasto (para la guarda de "descuento sin explicar" de la clase B). */
  depositosDelMotorizado: DocRef[];
}

export interface ItemBackfill {
  gastoId: string;
  clasificacion: Clase;
  motivo: string;
  monto: number | null;
  motorizadoId: string | null;
  depositosVivosIds: string[];
  liquidacionesIds: string[];
  /** Solo en CONSUMIDO_DEMOSTRADO. */
  depositoObjetivo: string | null;
  markerActual: string | null;
  gastoUpdateTime: string | null;
  /** Solo si aplica (depósito objetivo, o el marcado). */
  depositoUpdateTime: string | null;
  evidencia: Record<string, unknown>;
}

const texto = (v: unknown): string | null => (typeof v === 'string' && v.length > 0 ? v : null);
const ord = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

function item(e: EntradaClasificacion, clasificacion: Clase, motivo: string, extra: Partial<ItemBackfill> = {}): ItemBackfill {
  const g = e.gasto.data;
  const vivos = e.depositosQueLoListan.filter((d) => depositoVivo(d.data)).map((d) => d.id).sort(ord);
  return {
    gastoId: e.gasto.id,
    clasificacion,
    motivo,
    monto: esNumeroFinito(g.monto) ? g.monto : null,
    motorizadoId: texto(g.motorizadoId),
    depositosVivosIds: vivos,
    liquidacionesIds: e.liquidacionesQueLoListan.map((l) => l.id).sort(ord),
    depositoObjetivo: null,
    markerActual: texto(g[CAMPO_MARCA]),
    gastoUpdateTime: e.gasto.updateTime,
    depositoUpdateTime: null,
    evidencia: {},
    ...extra,
  };
}

const docDelGasto = (e: EntradaClasificacion, gid: string): DocumentData | null => (gid === e.gasto.id ? e.gasto.data : e.gastosDeDepositos[gid] ?? null);

/** Un gasto "cuenta" para un depósito si existe, está aprobado, es del motorizado, sin liquidación, monto válido y marca vacía o de ese depósito. */
function gastoDemostrableEn(g: DocumentData | null, motorizadoId: string, depositoId: string): string | null {
  if (!g) return 'GASTO_DEL_DEPOSITO_INEXISTENTE';
  if (g.estado !== 'aprobado') return 'GASTO_DEL_DEPOSITO_NO_APROBADO';
  if (g.motorizadoId !== motorizadoId) return 'GASTO_DEL_DEPOSITO_DE_OTRO_MOTORIZADO';
  if (texto(g.liquidacionId)) return 'GASTO_DEL_DEPOSITO_CON_LIQUIDACION';
  if (!esNumeroFinito(g.monto) || g.monto <= 0) return 'GASTO_DEL_DEPOSITO_MONTO_INVALIDO';
  const marca = texto(g[CAMPO_MARCA]);
  if (marca !== null && marca !== depositoId) return 'GASTO_DEL_DEPOSITO_CONSUMIDO_POR_OTRO';
  return null;
}

/** Descuento de un depósito VIVO que sus gastosIds no explican (cuenta en centavos). true = sin explicar. */
export function descuentoSinExplicar(e: EntradaClasificacion, dep: DocRef): boolean {
  const descontado = aCentavos(dep.data.gastosDescontados);
  const ids = idsUnicos(dep.data.gastosIds);
  if (descontado === 0 && ids.length === 0) return false;
  if (dep.data.tipo !== TIPO_DEPOSITO_STORKHUB) return true;
  let suma = 0;
  for (const gid of ids) {
    const g = docDelGasto(e, gid);
    if (!g || !esNumeroFinito(g.monto)) return true;
    suma += aCentavos(g.monto);
  }
  return suma !== descontado;
}

/**
 * Clasificación determinista de UN gasto. No lee nada, no escribe nada. Misma entrada ⇒ misma salida.
 * Orden de decisión (el primero que aplica gana): D(anulado) → liquidacionId → marca → sin marca (liquidaciones, depósitos).
 */
export function clasificarGasto(e: EntradaClasificacion): ItemBackfill {
  const g = e.gasto.data;
  const marca = texto(g[CAMPO_MARCA]);
  const liqMarca = texto(g.liquidacionId);
  const depVivos = e.depositosQueLoListan.filter((d) => depositoVivo(d.data));
  const liqs = e.liquidacionesQueLoListan;

  // ── D · estados que el contrato excluye ─────────────────────────────────────
  if (g.estado === 'anulado') return item(e, CLASE.NO_APLICA, 'GASTO_ANULADO');
  if (g.estado !== 'aprobado') return item(e, CLASE.AMBIGUO, 'ESTADO_DE_GASTO_DESCONOCIDO', { evidencia: { estado: String(g.estado ?? '') } });

  // ── liquidacionId (marcador separado de la marca de depósito) ───────────────
  if (liqMarca) {
    if (marca) return item(e, CLASE.CONFLICTO, 'MARCA_Y_LIQUIDACION_A_LA_VEZ', { evidencia: { liquidacionId: liqMarca } });
    if (depVivos.length > 0) return item(e, CLASE.CONFLICTO, 'LIQUIDACION_Y_DEPOSITO_VIVO_A_LA_VEZ', { evidencia: { liquidacionId: liqMarca } });
    if (liqs.some((l) => l.id === liqMarca)) return item(e, CLASE.NO_APLICA, 'LIQUIDACION_ID_CORRECTO', { evidencia: { liquidacionId: liqMarca } });
    return item(e, CLASE.CONFLICTO, 'LIQUIDACION_ID_SIN_RESPALDO', { evidencia: { liquidacionId: liqMarca } });
  }

  // ── Marca de depósito ya escrita ────────────────────────────────────────────
  if (marca) {
    const dm = e.depositoMarcado;
    const conflicto = (motivo: string) => item(e, CLASE.CONFLICTO, motivo, { depositoUpdateTime: dm?.updateTime ?? null, evidencia: { marca } });
    if (!dm || dm.id !== marca) return conflicto('MARCA_APUNTA_A_DEPOSITO_INEXISTENTE');
    if (!idsUnicos(dm.data.gastosIds).includes(e.gasto.id)) return conflicto('MARCA_APUNTA_A_DEPOSITO_QUE_NO_LO_LISTA');
    if (!depositoVivo(dm.data)) return conflicto('MARCA_APUNTA_A_DEPOSITO_NO_VIVO');
    if (dm.data.tipo !== TIPO_DEPOSITO_STORKHUB) return conflicto('MARCA_APUNTA_A_DEPOSITO_QUE_NO_ES_STORKHUB');
    const docIdMarca = e.docIdPorAuthUid[String(dm.data.motorizadoUid ?? '')] ?? String(dm.data.motorizadoUid ?? '');
    if (docIdMarca !== g.motorizadoId) return conflicto('MARCA_APUNTA_A_DEPOSITO_DE_OTRO_MOTORIZADO');
    if (depVivos.some((d) => d.id !== marca)) return conflicto('MARCA_Y_OTRO_DEPOSITO_VIVO_LO_LISTAN');
    if (liqs.length > 0) return conflicto('MARCA_Y_LIQUIDACION_A_LA_VEZ');
    return item(e, CLASE.NO_APLICA, 'MARKER_CORRECTO', { depositoUpdateTime: dm.updateTime, evidencia: { marca } });
  }

  // ── Sin marca y sin liquidacionId ───────────────────────────────────────────
  if (!esNumeroFinito(g.monto) || g.monto <= 0) return item(e, CLASE.AMBIGUO, 'MONTO_DE_GASTO_INVALIDO');
  const motorizadoId = texto(g.motorizadoId);
  if (!motorizadoId) return item(e, CLASE.AMBIGUO, 'GASTO_SIN_MOTORIZADO');

  // Legacy de liquidación: la liquidación lo lista pero el gasto no trae liquidacionId. Riesgo distinto, para un bloque posterior: 0 write.
  if (liqs.length > 0) {
    if (depVivos.length > 0) return item(e, CLASE.AMBIGUO, 'APARECE_EN_DEPOSITO_Y_LIQUIDACION');
    return item(e, CLASE.LEGACY_LIQUIDACION, 'LIQUIDACION_LO_LISTA_SIN_LIQUIDACION_ID');
  }

  // Un depósito de comercio vivo que lista gastos es una contradicción con el contrato (no descuenta gastos).
  if (depVivos.some((d) => d.data.tipo === TIPO_DEPOSITO_COMERCIO)) return item(e, CLASE.AMBIGUO, 'DEPOSITO_COMERCIO_LO_LISTA');
  if (depVivos.length >= 2) return item(e, CLASE.AMBIGUO, 'VARIOS_DEPOSITOS_VIVOS_LO_LISTAN');

  // ── B · libre ────────────────────────────────────────────────────────────────
  if (depVivos.length === 0) {
    const sinExplicar = e.depositosDelMotorizado.filter((d) => depositoVivo(d.data) && descuentoSinExplicar(e, d)).map((d) => d.id).sort(ord);
    if (sinExplicar.length > 0) return item(e, CLASE.AMBIGUO, 'DESCUENTO_SIN_EXPLICAR_EN_DEPOSITOS_DEL_MOTORIZADO', { evidencia: { depositosConDescuentoSinExplicar: sinExplicar } });
    const noVivos = e.depositosQueLoListan.filter((d) => !depositoVivo(d.data)).map((d) => ({ id: d.id, estado: String(d.data.estado ?? '') }));
    return item(e, CLASE.LIBRE, noVivos.length > 0 ? 'LIBRE_SOLO_LO_LISTAN_DEPOSITOS_NO_VIVOS' : 'LIBRE_SIN_EVIDENCIA_DE_CONSUMO', {
      evidencia: { depositosNoVivosQueLoListan: noVivos, depositosDelMotorizadoRevisados: e.depositosDelMotorizado.length },
    });
  }

  // ── A · exactamente UN depósito vivo lo lista ───────────────────────────────
  const dep = depVivos[0];
  const d = dep.data;
  const ambiguo = (motivo: string, evidencia: Record<string, unknown> = {}) =>
    item(e, CLASE.AMBIGUO, motivo, { depositoUpdateTime: dep.updateTime, evidencia: { depositoId: dep.id, ...evidencia } });

  if (d.tipo !== TIPO_DEPOSITO_STORKHUB) return ambiguo('DEPOSITO_NO_ES_STORKHUB', { tipo: String(d.tipo ?? '') });
  const motUid = texto(d.motorizadoUid);
  if (!motUid) return ambiguo('DEPOSITO_SIN_MOTORIZADO');
  const docIdDeposito = e.docIdPorAuthUid[motUid] ?? motUid;
  if (docIdDeposito !== motorizadoId) return ambiguo('MOTORIZADO_NO_COINCIDE');

  // Órdenes: existen, entregadas y del motorizado → bruto en centavos (la misma fórmula del depósito).
  const solicitudIds = idsUnicos(d.solicitudIds);
  if (solicitudIds.length === 0) return ambiguo('DEPOSITO_SIN_ORDENES');
  let bruto = 0;
  for (const sid of solicitudIds) {
    const o = e.ordenes[sid] ?? null;
    if (!o) return ambiguo('ORDEN_DEL_DEPOSITO_INEXISTENTE', { solicitudId: sid });
    if (o.estado !== 'entregado') return ambiguo('ORDEN_DEL_DEPOSITO_NO_ENTREGADA', { solicitudId: sid });
    if (o.asignacion?.motorizadoAuthUid !== motUid) return ambiguo('ORDEN_DEL_DEPOSITO_DE_OTRO_MOTORIZADO', { solicitudId: sid });
    bruto += aCentavos(calcularDeposito(o).totalAStorkhub);
  }

  // Gastos del depósito: todos demostrables y Σ == gastosDescontados.
  const gastosIds = idsUnicos(d.gastosIds);
  let suma = 0;
  for (const gid of gastosIds) {
    const motivo = gastoDemostrableEn(docDelGasto(e, gid), motorizadoId, dep.id);
    if (motivo) return ambiguo(motivo, { gastoDelDepositoId: gid });
    suma += aCentavos(docDelGasto(e, gid)?.monto);
  }
  const descontado = aCentavos(d.gastosDescontados);
  if (suma !== descontado) return ambiguo('SUMA_DE_GASTOS_NO_CUADRA', { sumaGastosCentavos: suma, gastosDescontadosCentavos: descontado });

  // montoTotal / montoBruto con la fórmula vigente.
  const esperado = Math.max(0, bruto - suma);
  if (aCentavos(d.montoTotal) !== esperado) return ambiguo('MONTO_TOTAL_INCONSISTENTE', { esperadoCentavos: esperado, guardadoCentavos: aCentavos(d.montoTotal) });
  if (d.montoBruto !== undefined && aCentavos(d.montoBruto) !== bruto) return ambiguo('MONTO_BRUTO_INCONSISTENTE', { esperadoCentavos: bruto, guardadoCentavos: aCentavos(d.montoBruto) });

  return item(e, CLASE.CONSUMIDO, 'UN_DEPOSITO_VIVO_LO_LISTA_Y_CUADRA', {
    depositoObjetivo: dep.id,
    depositoUpdateTime: dep.updateTime,
    evidencia: {
      estadoDeposito: String(d.estado ?? ''), ordenes: solicitudIds.length, gastosDelDeposito: gastosIds.length,
      brutoCentavos: bruto, gastosCentavos: suma, montoTotalCentavos: esperado,
    },
  });
}

// ── Manifest ───────────────────────────────────────────────────────────────────

export interface ManifestDryRun {
  schemaVersion: number;
  kind: 'gastos-consumo-backfill';
  generatedAt: string;
  projectId: string;
  sourceGitSha: string;
  mode: 'dry-run';
  totales: Record<string, number>;
  conflictos: Array<{ gastoId: string; motivo: string }>;
  porMotorizado: Record<string, Record<string, number>>;
  porDeposito: Record<string, number>;
  itemsSha256: string;
  items: ItemBackfill[];
}

const ordenar = (v: unknown): unknown => {
  if (Array.isArray(v)) return v.map(ordenar);
  if (v && typeof v === 'object') return Object.fromEntries(Object.keys(v as object).sort().map((k) => [k, ordenar((v as Record<string, unknown>)[k])]));
  return v;
};
/** JSON canónico (claves ordenadas): la huella no depende del orden de inserción. */
export const jsonCanonico = (v: unknown): string => JSON.stringify(ordenar(v));
export const huellaItems = (items: ItemBackfill[]): string => createHash('sha256').update(jsonCanonico(items)).digest('hex');

export function construirManifest(items: ItemBackfill[], meta: { projectId: string; sourceGitSha: string; generatedAt: string }): ManifestDryRun {
  const ordenados = [...items].sort((a, b) => ord(a.gastoId, b.gastoId));
  const totales: Record<string, number> = Object.fromEntries(CLASES.map((c) => [c, 0]));
  const porMotorizado: Record<string, Record<string, number>> = {};
  const porDeposito: Record<string, number> = {};
  for (const it of ordenados) {
    totales[it.clasificacion] += 1;
    const m = it.motorizadoId ?? '(sin motorizado)';
    porMotorizado[m] = porMotorizado[m] ?? {};
    porMotorizado[m][it.clasificacion] = (porMotorizado[m][it.clasificacion] ?? 0) + 1;
    if (it.depositoObjetivo) porDeposito[it.depositoObjetivo] = (porDeposito[it.depositoObjetivo] ?? 0) + 1;
  }
  return {
    schemaVersion: SCHEMA_VERSION,
    kind: 'gastos-consumo-backfill',
    generatedAt: meta.generatedAt,
    projectId: meta.projectId,
    sourceGitSha: meta.sourceGitSha,
    mode: 'dry-run',
    totales,
    conflictos: ordenados.filter((i) => i.clasificacion === CLASE.CONFLICTO).map((i) => ({ gastoId: i.gastoId, motivo: i.motivo })),
    porMotorizado,
    porDeposito,
    itemsSha256: huellaItems(ordenados),
    items: ordenados,
  };
}

// ── Argumentos y guardas ───────────────────────────────────────────────────────

export const FRASE_CONFIRMACION = 'APPLY-GASTOS-CONSUMO-BACKFILL';
export const fraseProduccion = (projectId: string): string => `APPLY-PRODUCCION-${projectId}`;

export interface Args {
  modo: 'dry-run' | 'apply';
  project: string | null;
  out: string | null;
  manifest: string | null;
  confirm: string | null;
  allowProduction: boolean;
  confirmProduction: string | null;
}

const FLAGS_CON_VALOR = ['--project', '--out', '--manifest', '--confirm', '--confirm-production'];
const FLAGS_BOOL = ['--apply', '--allow-production'];

/** Parser ESTRICTO: un flag desconocido (un typo) es un error, nunca un dry-run silencioso ni un apply. El default es dry-run. */
export function parsearArgs(argv: string[]): Args {
  const v: Record<string, string> = {};
  const b = new Set<string>();
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (FLAGS_BOOL.includes(a)) { b.add(a); continue; }
    if (FLAGS_CON_VALOR.includes(a)) {
      const val = argv[i + 1];
      if (val === undefined || val.startsWith('--')) throw new Error(`Falta el valor de ${a}.`);
      v[a] = val; i++; continue;
    }
    throw new Error(`Argumento desconocido: ${a}`);
  }
  const apply = b.has('--apply');
  const args: Args = {
    modo: apply ? 'apply' : 'dry-run',
    project: v['--project'] ?? null,
    out: v['--out'] ?? null,
    manifest: v['--manifest'] ?? null,
    confirm: v['--confirm'] ?? null,
    allowProduction: b.has('--allow-production'),
    confirmProduction: v['--confirm-production'] ?? null,
  };
  if (!apply && (args.manifest || args.confirm || args.allowProduction || args.confirmProduction)) {
    throw new Error('--manifest, --confirm, --allow-production y --confirm-production solo se aceptan junto con --apply. Sin --apply el script es DRY RUN.');
  }
  if (apply && args.out) throw new Error('--out es del dry-run; en apply el resultado se escribe junto al manifest.');
  return args;
}

/** ¿Parece un proyecto de producción? Fail-safe: todo lo que no se reconoce como demo/staging/dev/test se trata como producción. */
export function pareceProduccion(projectId: string): boolean {
  return !(/^demo-/i.test(projectId) || /(staging|stage|stg|dev|test|qa|sandbox|emulator|local)/i.test(projectId));
}

/** Valida las guardas de seguridad; devuelve los errores (vacío = puede seguir). No hace I/O. */
export function validarGuardas(args: Args): string[] {
  const errores: string[] = [];
  if (!args.project) errores.push('Falta --project <id>: el proyecto objetivo es explícito.');
  if (args.modo === 'dry-run') return errores;
  if (!args.manifest) errores.push('apply requiere --manifest <archivo>.');
  if (args.confirm !== FRASE_CONFIRMACION) errores.push(`apply requiere --confirm ${FRASE_CONFIRMACION} (frase exacta).`);
  if (args.project && pareceProduccion(args.project)) {
    if (!args.allowProduction) errores.push(`El proyecto "${args.project}" parece producción: apply requiere además --allow-production.`);
    if (args.confirmProduction !== fraseProduccion(args.project)) errores.push(`El proyecto "${args.project}" parece producción: apply requiere --confirm-production ${fraseProduccion(args.project)}.`);
  }
  return errores;
}

// ── Plan de apply ──────────────────────────────────────────────────────────────

export class ManifestInvalido extends Error {}

export interface PlanApply {
  /** Items CONSUMIDO_DEMOSTRADO a revalidar y, si siguen válidos, escribir. */
  candidatos: ItemBackfill[];
  /** Items que NO se procesan (clase distinta de A): se reportan, nunca se escriben. */
  omitidos: Array<{ gastoId: string; clasificacion: Clase; resultado: 'SKIP_CLASE_NO_APLICABLE' }>;
}

/**
 * Valida el manifest y arma el plan. NO confía a ciegas en él: schema, tipo, modo, proyecto, huella de los items y forma de cada candidato.
 * Una clase desconocida o un manifest alterado es STOP (lanza): 0 writes.
 */
export function planificarApply(manifest: unknown, projectId: string): PlanApply {
  const m = manifest as Partial<ManifestDryRun> | null;
  if (!m || typeof m !== 'object') throw new ManifestInvalido('El manifest no es un objeto.');
  if (m.schemaVersion !== SCHEMA_VERSION) throw new ManifestInvalido(`schemaVersion no soportado: ${String(m.schemaVersion)}.`);
  if (m.kind !== 'gastos-consumo-backfill') throw new ManifestInvalido('El manifest no es de este backfill.');
  if (m.mode !== 'dry-run') throw new ManifestInvalido('Solo se aplica un manifest generado por un dry-run.');
  if (m.projectId !== projectId) throw new ManifestInvalido(`El manifest es del proyecto "${String(m.projectId)}", no de "${projectId}".`);
  if (!Array.isArray(m.items)) throw new ManifestInvalido('El manifest no trae items.');
  if (huellaItems(m.items as ItemBackfill[]) !== m.itemsSha256) throw new ManifestInvalido('La huella de los items no coincide: el manifest fue modificado.');
  const candidatos: ItemBackfill[] = [];
  const omitidos: PlanApply['omitidos'] = [];
  const vistos = new Set<string>();
  for (const it of m.items as ItemBackfill[]) {
    if (!it || typeof it.gastoId !== 'string' || !it.gastoId) throw new ManifestInvalido('Un item no tiene gastoId.');
    if (vistos.has(it.gastoId)) throw new ManifestInvalido(`gastoId repetido en el manifest: ${it.gastoId}.`);
    vistos.add(it.gastoId);
    if (!CLASES.includes(it.clasificacion)) throw new ManifestInvalido(`Clase inesperada en el manifest (${String(it.clasificacion)}): STOP.`);
    if (it.clasificacion !== CLASE.CONSUMIDO) { omitidos.push({ gastoId: it.gastoId, clasificacion: it.clasificacion, resultado: 'SKIP_CLASE_NO_APLICABLE' }); continue; }
    if (!texto(it.depositoObjetivo) || !texto(it.gastoUpdateTime) || !texto(it.depositoUpdateTime)) {
      throw new ManifestInvalido(`El item ${it.gastoId} es CONSUMIDO_DEMOSTRADO pero no trae depositoObjetivo y updateTime del gasto y del depósito.`);
    }
    candidatos.push(it);
  }
  return { candidatos, omitidos };
}

export type ResultadoItemApply = 'APLICADO' | 'IDEMPOTENT_SKIP' | 'SKIP_CONFLICT';

export interface DecisionItem {
  resultado: ResultadoItemApply;
  motivo: string;
  /** Campos a escribir (solo con APLICADO). */
  campos: { [CAMPO_MARCA]: string; [CAMPO_BACKFILL_OPERACION]: string } | null;
}

/**
 * Revalidación contra el estado ACTUAL (releído, con la evidencia completa re-clasificada): decide APLICAR, saltar por idempotencia o saltar por conflicto.
 * `fresco` es la clasificación recalculada ahora; `item` es lo que dijo el manifest.
 */
export function decidirItem(item: ItemBackfill, fresco: ItemBackfill | null, operacionBackfillId: string): DecisionItem {
  const saltar = (motivo: string): DecisionItem => ({ resultado: 'SKIP_CONFLICT', motivo, campos: null });
  if (!fresco) return saltar('GASTO_INEXISTENTE');
  const objetivo = item.depositoObjetivo as string;
  // Idempotencia: la marca ya vale el objetivo y la evidencia la respalda → no se reescribe nada (ni el timestamp).
  if (fresco.markerActual === objetivo) {
    return fresco.clasificacion === CLASE.NO_APLICA && fresco.motivo === 'MARKER_CORRECTO'
      ? { resultado: 'IDEMPOTENT_SKIP', motivo: 'MARKER_YA_COINCIDE', campos: null }
      : saltar('MARKER_COINCIDE_PERO_LA_EVIDENCIA_LO_CONTRADICE');
  }
  if (fresco.markerActual) return saltar('MARKER_APUNTA_A_OTRO_DEPOSITO');
  if (fresco.clasificacion !== CLASE.CONSUMIDO) return saltar(`CLASIFICACION_CAMBIO_A_${fresco.clasificacion}`);
  if (fresco.depositoObjetivo !== objetivo) return saltar('DEPOSITO_OBJETIVO_CAMBIO');
  if (fresco.gastoUpdateTime !== item.gastoUpdateTime) return saltar('GASTO_CAMBIO_DESDE_EL_DRY_RUN');
  if (fresco.depositoUpdateTime !== item.depositoUpdateTime) return saltar('DEPOSITO_CAMBIO_DESDE_EL_DRY_RUN');
  return { resultado: 'APLICADO', motivo: 'REVALIDADO', campos: { [CAMPO_MARCA]: objetivo, [CAMPO_BACKFILL_OPERACION]: operacionBackfillId } };
}

export const idOperacionBackfill = (ahora: Date, manifestSha256: string): string =>
  `backfill_gc_${ahora.toISOString().replace(/[-:T.Z]/g, '').slice(0, 14)}_${manifestSha256.slice(0, 8)}`;

// ── Rollback (solo información; no se ejecuta en esta fase) ──────────────────────

export interface RegistroRollback {
  gastoId: string;
  operacionBackfillId: string;
  valorAnterior: { [CAMPO_MARCA]: null };
  valorNuevo: { [CAMPO_MARCA]: string; [CAMPO_BACKFILL_OPERACION]: string };
  updateTimePre: string | null;
  updateTimePost: string | null;
}

/**
 * Rollback seguro SOLO si el documento sigue exactamente como lo dejó el backfill: misma marca, misma operación y mismo updateTime post.
 * Cualquier cambio posterior (otro writer, anulación del depósito que libera la marca…) ⇒ false. No hay rollback ciego.
 */
export function rollbackSeguro(r: RegistroRollback, gastoActual: DocRef | null): boolean {
  if (!gastoActual || r.updateTimePost === null) return false;
  return gastoActual.id === r.gastoId
    && gastoActual.data[CAMPO_MARCA] === r.valorNuevo[CAMPO_MARCA]
    && gastoActual.data[CAMPO_BACKFILL_OPERACION] === r.operacionBackfillId
    && gastoActual.updateTime === r.updateTimePost;
}
