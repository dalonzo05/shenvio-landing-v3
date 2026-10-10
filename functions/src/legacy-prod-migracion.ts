// A7-01 — Migrador determinístico de legacy de producción: LÓGICA PURA (sin Firestore, sin I/O).
//
// Alcance cerrado (A6 → A7):
//   A. usuarios/{uid}.comercioId   — solo cuando la evidencia 1:1 es demostrable.
//   B. contadores/{ordenes,depositos} — inicialización / avance coherente.
//   C. codigo + secuencia en solicitudes_envio / ordenes_deposito legacy.
//
// NO hace nada más: ni historia, ni montos, ni estados, ni timestamps históricos.
//
// Separación (misma que A3): este archivo = decisiones puras; legacy-prod-migracion-runner.ts = orquestación sobre
// interfaces inyectadas; scripts/a7-prod-legacy.cjs = el único que conoce firebase-admin. NO es una Cloud Function y NO
// se exporta desde index.ts.
//
// ── Contrato REAL (demostrado desde functions/src/codigos.ts, firestore.rules y comercio-acceso.ts) ───────────────────
//   · usuarios/{uid}.comercioId = ID del documento comercios/{comercioId} (string). Rol real: 'Comercio' (capitalizado).
//   · contadores/ordenes y contadores/depositos guardan { valor: number } = ÚLTIMA secuencia repartida (no la próxima).
//   · Secuencia empieza en 1; el trigger asigna `valor + 1`; contador ausente ⇒ el trigger BLOQUEA (CONTADOR_AUSENTE).
//   · Código = PREFIJO-NNNN (SH / DEP), padding mínimo 4, sin tope: formatearCodigo() de codigos.ts. Se REUSA ese helper
//     para que migrador y trigger no puedan divergir.

import { createHash } from 'node:crypto';
import {
  CONTADOR_DEPOSITOS, CONTADOR_ORDENES, PREFIJO_DEPOSITO, PREFIJO_ORDEN, formatearCodigo,
} from './codigos';

export const SCHEMA_VERSION = 1;
export const KIND_DRY_RUN = 'a7-prod-legacy';
export const KIND_APPLY = 'a7-prod-legacy-apply';
export const PROYECTO_PRODUCCION = 'storkhub-9f719';
export const FRASE_CONFIRMACION = 'APPLY-A7-PROD-LEGACY';
export const ROL_COMERCIO = 'Comercio';

export const COL_USUARIOS = 'usuarios';
export const COL_COMERCIOS = 'comercios';
export const COL_CONTADORES = 'contadores';
export const COL_ORDENES = 'solicitudes_envio';
export const COL_DEPOSITOS = 'ordenes_deposito';

/** Tope de writes por transacción (Firestore: 500). Por encima ⇒ STOP, no se parte en silencio. */
export const MAX_WRITES_POR_TX = 450;

export type Clase =
  | 'COMERCIO_BACKFILL_SEGURO'
  | 'CODIGO_BACKFILL_SEGURO'
  | 'CONTADOR_ACTUALIZAR'
  | 'YA_CORRECTO'
  | 'AMBIGUO'
  | 'CONFLICTO'
  | 'NO_APLICA';
export const CLASES: readonly Clase[] = [
  'COMERCIO_BACKFILL_SEGURO', 'CODIGO_BACKFILL_SEGURO', 'CONTADOR_ACTUALIZAR', 'YA_CORRECTO', 'AMBIGUO', 'CONFLICTO', 'NO_APLICA',
];

/** Documento leído: id + data. (El updateTime no entra en la decisión: la revalidación es por contenido, dentro de la transacción.) */
export interface DocLite { id: string; data: Record<string, unknown> }

const esObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);
const ausente = (v: unknown): boolean => v === undefined || v === null;
const ord = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);
const esEntero = (v: unknown): v is number => typeof v === 'number' && Number.isSafeInteger(v);

// ══ A. COMERCIO ═════════════════════════════════════════════════════════════════════════════════════════════════════

export interface ItemComercio {
  dominio: 'usuarios_comercio';
  usuarioId: string;
  clasificacion: Clase;
  motivo: string;
  /** Valor a escribir en usuarios/{usuarioId}.comercioId (solo con COMERCIO_BACKFILL_SEGURO). */
  comercioIdObjetivo: string | null;
}

/**
 * Clasifica UN usuario. `usuarios` y `comercios` son la foto completa (para detectar vínculos contradictorios).
 *
 * BACKFILL_SEGURO solo si TODO se demuestra: rol exacto 'Comercio'; comercioId ausente; existe comercios/{uid};
 * comercios/{uid}.authUid ausente o == uid; ningún OTRO comercio tiene authUid == uid; ningún OTRO usuario ya apunta a comercios/{uid}.
 * El único write permitido es usuarios/{uid}.comercioId = uid.
 */
export function clasificarUsuarioComercio(usuario: DocLite, usuarios: DocLite[], comercios: DocLite[]): ItemComercio {
  const base = { dominio: 'usuarios_comercio' as const, usuarioId: usuario.id, comercioIdObjetivo: null };
  const r = (clasificacion: Clase, motivo: string, objetivo: string | null = null): ItemComercio =>
    ({ ...base, clasificacion, motivo, comercioIdObjetivo: objetivo });

  const rol = usuario.data.rol;
  if (typeof rol !== 'string' || rol !== ROL_COMERCIO) {
    // 'comercio'/' Comercio ' etc.: parece comercio pero las Rules no lo tratarían como tal ⇒ no se decide por intuición.
    if (typeof rol === 'string' && rol.trim().toLowerCase() === 'comercio') return r('AMBIGUO', 'ROL_COMERCIO_CON_CAPITALIZACION_NO_CANONICA');
    return r('NO_APLICA', 'ROL_NO_COMERCIO');
  }

  const actual = usuario.data.comercioId;
  if (!ausente(actual)) {
    if (typeof actual === 'string' && actual === usuario.id) return r('YA_CORRECTO', 'COMERCIOID_YA_COINCIDE');
    // Nunca se corrige un valor existente por intuición (ni '' ni otro tipo ni otro id).
    return r('CONFLICTO', 'COMERCIOID_EXISTENTE_DISTINTO');
  }

  const comercio = comercios.find((c) => c.id === usuario.id);
  const alternativos = comercios.filter((c) => c.id !== usuario.id && c.data.authUid === usuario.id);
  if (alternativos.length > 0) return r('CONFLICTO', 'OTRO_COMERCIO_APUNTA_A_ESTE_USUARIO');
  if (!comercio) return r('AMBIGUO', 'COMERCIO_INEXISTENTE');
  const authUid = comercio.data.authUid;
  if (!ausente(authUid) && authUid !== usuario.id) return r('CONFLICTO', 'COMERCIO_APUNTA_A_OTRO_USUARIO');
  const otrosUsuarios = usuarios.filter((u) => u.id !== usuario.id && u.data.comercioId === usuario.id);
  if (otrosUsuarios.length > 0) return r('CONFLICTO', 'OTRO_USUARIO_YA_VINCULADO_AL_COMERCIO');
  return r('COMERCIO_BACKFILL_SEGURO', 'USUARIO_Y_COMERCIO_MISMO_ID_SIN_VINCULO_CONTRADICTORIO', usuario.id);
}

/** Planner de comercio. Orden determinístico por usuarioId; NO_APLICA no entra a items (solo al conteo). */
export function planificarComercio(usuarios: DocLite[], comercios: DocLite[]): { items: ItemComercio[]; analizados: number; noAplica: number } {
  const todos = usuarios.map((u) => clasificarUsuarioComercio(u, usuarios, comercios));
  const items = todos.filter((i) => i.clasificacion !== 'NO_APLICA').sort((a, b) => ord(a.usuarioId, b.usuarioId));
  return { items, analizados: usuarios.length, noAplica: todos.length - items.length };
}

// ══ B + C. CÓDIGOS Y CONTADORES ═════════════════════════════════════════════════════════════════════════════════════

export type Dominio = 'solicitudes_envio' | 'ordenes_deposito';
export interface ConfigDominio { coleccion: Dominio; prefijo: string; contadorId: string }
export const DOMINIOS: readonly ConfigDominio[] = [
  { coleccion: COL_ORDENES, prefijo: PREFIJO_ORDEN, contadorId: CONTADOR_ORDENES },
  { coleccion: COL_DEPOSITOS, prefijo: PREFIJO_DEPOSITO, contadorId: CONTADOR_DEPOSITOS },
];

export interface ItemCodigo {
  dominio: Dominio;
  docId: string;
  clasificacion: Clase;
  motivo: string;
  /** createdAt canónico "segundos.nanos" (9 dígitos) o null. Solo auditoría/orden; no se escribe. */
  createdAt: string | null;
  codigoPropuesto: string | null;
  secuenciaPropuesta: number | null;
}

export interface ItemContador {
  dominio: 'contadores';
  contadorId: string;
  clasificacion: Clase;
  motivo: string;
  existe: boolean;
  /** Valor actual del contador (null si no existe). */
  valorAntes: number | null;
  /** Valor con el que debe quedar: última secuencia repartida. NUNCA menor que valorAntes. */
  valorDespues: number | null;
  /** Mayor secuencia ya presente en documentos con código coherente. */
  maxSecuenciaExistente: number;
  /** Cantidad de documentos legacy a los que se asignará secuencia. */
  legacyPendientes: number;
}

export interface PlanDominio {
  config: ConfigDominio;
  criterioOrden: 'createdAt+docId' | 'docId';
  items: ItemCodigo[];
  contador: ItemContador;
  /** Documentos ya codificados y coherentes (no entran a items). */
  yaCorrectos: number;
  analizados: number;
  warnings: string[];
}

/** createdAt → [segundos, nanos] si es un timestamp semánticamente fiable; null si no. Acepta Timestamp (seconds/_seconds) y Date. */
export function tiempoFiable(v: unknown): [number, number] | null {
  if (v instanceof Date) {
    const ms = v.getTime();
    return Number.isFinite(ms) && ms > 0 ? [Math.floor(ms / 1000), (ms % 1000) * 1_000_000] : null;
  }
  if (!esObj(v)) return null;
  const s = v.seconds ?? v._seconds;
  const n = v.nanoseconds ?? v._nanoseconds ?? 0;
  if (!esEntero(s) || !esEntero(n) || s <= 0 || n < 0 || n > 999_999_999) return null;
  return [s, n];
}
const textoTiempo = (t: [number, number] | null): string | null => (t ? `${t[0]}.${String(t[1]).padStart(9, '0')}` : null);
const cmpTiempo = (a: [number, number], b: [number, number]): number => (a[0] - b[0]) || (a[1] - b[1]);

/**
 * Planner de un dominio. Entradas: TODOS los documentos de la colección y el documento contador (o null).
 *
 * Orden de asignación (determinístico, nunca el de Firestore):
 *   · si TODOS los legacy del dominio tienen createdAt fiable ⇒ createdAt asc, desempate docId asc;
 *   · si falta o es dudoso en CUALQUIERA ⇒ TODOS por docId asc (un solo criterio; no se mezcla cronología parcial) + warning.
 *
 * Secuencias: base = max(mayor secuencia ya existente, contador actual o 0); los legacy reciben base+1, base+2…;
 * el contador queda en base+n. Nunca reduce el contador, nunca reutiliza una secuencia.
 */
export function planificarDominio(config: ConfigDominio, docs: DocLite[], contadorDoc: DocLite | null): PlanDominio {
  const warnings: string[] = [];
  const items: ItemCodigo[] = [];
  const mk = (d: DocLite, clasificacion: Clase, motivo: string): ItemCodigo => ({
    dominio: config.coleccion, docId: d.id, clasificacion, motivo,
    createdAt: textoTiempo(tiempoFiable(d.data.createdAt)), codigoPropuesto: null, secuenciaPropuesta: null,
  });

  // 1 · Inventario de lo ya codificado.
  const legacy: DocLite[] = [];
  const secuenciasExistentes = new Map<number, string[]>();
  let yaCorrectos = 0;
  const coherentes: Array<{ d: DocLite; sec: number }> = [];
  for (const d of [...docs].sort((a, b) => ord(a.id, b.id))) {
    const tieneCodigo = !ausente(d.data.codigo);
    const tieneSecuencia = !ausente(d.data.secuencia);
    if (!tieneCodigo && !tieneSecuencia) { legacy.push(d); continue; }
    if (tieneCodigo !== tieneSecuencia) { items.push(mk(d, 'AMBIGUO', 'CODIGO_ESTADO_PARCIAL')); continue; }
    const sec = d.data.secuencia;
    const coherente = esEntero(sec) && sec >= 1 && d.data.codigo === formatearCodigo(config.prefijo, sec);
    if (!coherente) { items.push(mk(d, 'CONFLICTO', 'CODIGO_INCOHERENTE')); continue; }
    coherentes.push({ d, sec: sec as number });
    secuenciasExistentes.set(sec as number, [...(secuenciasExistentes.get(sec as number) ?? []), d.id]);
  }
  for (const { d, sec } of coherentes) {
    if ((secuenciasExistentes.get(sec) as string[]).length > 1) items.push(mk(d, 'CONFLICTO', 'SECUENCIA_DUPLICADA_EXISTENTE'));
    else yaCorrectos += 1;
  }
  const maxExistente = coherentes.reduce((m, c) => Math.max(m, c.sec), 0);

  // 2 · Contador.
  const existe = contadorDoc !== null;
  const bruto = contadorDoc?.data.valor;
  const contadorCorrupto = existe && (!esEntero(bruto) || bruto < 0);
  const valorAntes = existe && !contadorCorrupto ? (bruto as number) : null;

  const bloqueado = contadorCorrupto || items.some((i) => i.clasificacion === 'CONFLICTO' || i.clasificacion === 'AMBIGUO');
  const itemContador = (clasificacion: Clase, motivo: string, despues: number | null): ItemContador => ({
    dominio: 'contadores', contadorId: config.contadorId, clasificacion, motivo, existe, valorAntes, valorDespues: despues,
    maxSecuenciaExistente: maxExistente, legacyPendientes: legacy.length,
  });

  if (contadorCorrupto) {
    for (const d of legacy) items.push(mk(d, 'AMBIGUO', 'CONTADOR_CORRUPTO_SIN_BASE_SEGURA'));
    return {
      config, criterioOrden: 'docId', items: items.sort(porDoc), yaCorrectos, analizados: docs.length, warnings,
      contador: itemContador('CONFLICTO', 'CONTADOR_CORRUPTO', null),
    };
  }
  if (bloqueado) {
    // Hay conflicto/ambigüedad en documentos ya codificados: no se reparte nada sobre una base dudosa.
    for (const d of legacy) items.push(mk(d, 'AMBIGUO', 'DOMINIO_CON_CODIGOS_DUDOSOS'));
    return {
      config, criterioOrden: 'docId', items: items.sort(porDoc), yaCorrectos, analizados: docs.length, warnings,
      contador: itemContador('AMBIGUO', 'DOMINIO_CON_CODIGOS_DUDOSOS', null),
    };
  }

  // 3 · Orden determinístico de los legacy.
  const conTiempo = legacy.map((d) => ({ d, t: tiempoFiable(d.data.createdAt) }));
  const todosConTiempo = conTiempo.length > 0 && conTiempo.every((x) => x.t !== null);
  const criterioOrden: PlanDominio['criterioOrden'] = todosConTiempo ? 'createdAt+docId' : 'docId';
  if (!todosConTiempo && conTiempo.length > 1) warnings.push(`${config.coleccion}: createdAt ausente o no fiable en algún legacy ⇒ orden por docId asc.`);
  const ordenados = [...conTiempo].sort((a, b) =>
    (todosConTiempo ? cmpTiempo(a.t as [number, number], b.t as [number, number]) : 0) || ord(a.d.id, b.d.id));

  // 4 · Asignación.
  const base = Math.max(maxExistente, valorAntes ?? 0);
  let sec = base;
  for (const { d } of ordenados) {
    sec += 1;
    items.push({ ...mk(d, 'CODIGO_BACKFILL_SEGURO', 'SIN_CODIGO_NI_SECUENCIA'), codigoPropuesto: formatearCodigo(config.prefijo, sec), secuenciaPropuesta: sec });
  }
  const final = sec;
  if (existe && (valorAntes as number) < maxExistente) warnings.push(`${config.coleccion}: el contador (${valorAntes}) estaba por detrás de la mayor secuencia existente (${maxExistente}); se adelanta.`);

  let contador: ItemContador;
  if (!existe) contador = itemContador('CONTADOR_ACTUALIZAR', 'CONTADOR_AUSENTE_SE_INICIALIZA', final);
  else if (final === valorAntes) contador = itemContador('YA_CORRECTO', 'CONTADOR_YA_COHERENTE', final);
  else contador = itemContador('CONTADOR_ACTUALIZAR', 'CONTADOR_SE_ADELANTA', final);

  return { config, criterioOrden, items: items.sort(porDoc), contador, yaCorrectos, analizados: docs.length, warnings };
}
const porDoc = (a: ItemCodigo, b: ItemCodigo): number => ord(a.docId, b.docId);

// ══ MANIFEST ════════════════════════════════════════════════════════════════════════════════════════════════════════

export type ItemManifest = ItemComercio | ItemCodigo | ItemContador;

const ordenar = (v: unknown): unknown => {
  if (Array.isArray(v)) return v.map(ordenar);
  if (esObj(v)) return Object.fromEntries(Object.keys(v).sort().map((k) => [k, ordenar(v[k])]));
  return v;
};
/** JSON canónico (claves ordenadas): la huella no depende del orden de inserción. */
export const jsonCanonico = (v: unknown): string => JSON.stringify(ordenar(v));
export const sha256 = (s: string): string => createHash('sha256').update(s).digest('hex');
export const huellaItems = (items: unknown[]): string => sha256(jsonCanonico(items));

const claveItem = (i: ItemManifest): string =>
  i.dominio === 'usuarios_comercio' ? `0|${i.usuarioId}` : i.dominio === 'contadores' ? `2|${i.contadorId}` : `1|${i.dominio}|${i.docId}`;

export interface Resumen {
  usuariosAnalizados: number;
  usuariosBackfillSeguro: number;
  usuariosYaCorrectos: number;
  usuariosAmbiguos: number;
  usuariosConflicto: number;
  ordenesLegacy: number;
  depositosLegacy: number;
  codigosPropuestos: number;
  secuenciasPropuestas: number;
  codigosAmbiguosOConflicto: number;
  contadoresAntes: Record<string, number | null>;
  contadoresDespues: Record<string, number | null>;
}

export interface ManifestDryRun {
  schemaVersion: number;
  kind: typeof KIND_DRY_RUN;
  mode: 'dry-run';
  projectId: string;
  sourceGitSha: string;
  /** Árbol de trabajo sin cambios al generar el manifest (un manifest de árbol sucio no es aplicable). */
  sourceTreeClean: boolean;
  /** sha256 del JS compilado que generó el manifest (cierra el hueco "código compilado ≠ fuente"). */
  buildSha256: string;
  generatedAt: string;
  resumen: Resumen;
  criterioOrden: Record<string, string>;
  warnings: string[];
  itemsSha256: string;
  items: ItemManifest[];
}

export interface Foto { usuarios: DocLite[]; comercios: DocLite[]; ordenes: DocLite[]; depositos: DocLite[]; contadores: DocLite[] }

export interface PlanCompleto { comercio: ReturnType<typeof planificarComercio>; dominios: PlanDominio[] }

export function planificarTodo(f: Foto): PlanCompleto {
  const contador = (id: string): DocLite | null => f.contadores.find((c) => c.id === id) ?? null;
  return {
    comercio: planificarComercio(f.usuarios, f.comercios),
    dominios: [
      planificarDominio(DOMINIOS[0], f.ordenes, contador(CONTADOR_ORDENES)),
      planificarDominio(DOMINIOS[1], f.depositos, contador(CONTADOR_DEPOSITOS)),
    ],
  };
}

export function itemsDePlan(p: PlanCompleto): ItemManifest[] {
  const todos: ItemManifest[] = [...p.comercio.items, ...p.dominios.flatMap((d) => [...d.items, d.contador])];
  return todos.sort((a, b) => ord(claveItem(a), claveItem(b)));
}

export function resumirItems(p: PlanCompleto): Resumen {
  const u = p.comercio.items;
  const cuenta = (c: Clase) => u.filter((i) => i.clasificacion === c).length;
  const [o, d] = p.dominios;
  const codigos = p.dominios.flatMap((x) => x.items).filter((i) => i.clasificacion === 'CODIGO_BACKFILL_SEGURO');
  return {
    usuariosAnalizados: p.comercio.analizados,
    usuariosBackfillSeguro: cuenta('COMERCIO_BACKFILL_SEGURO'),
    usuariosYaCorrectos: cuenta('YA_CORRECTO'),
    usuariosAmbiguos: cuenta('AMBIGUO'),
    usuariosConflicto: cuenta('CONFLICTO'),
    ordenesLegacy: o.contador.legacyPendientes,
    depositosLegacy: d.contador.legacyPendientes,
    codigosPropuestos: codigos.length,
    secuenciasPropuestas: codigos.filter((i) => i.secuenciaPropuesta !== null).length,
    codigosAmbiguosOConflicto: p.dominios.flatMap((x) => x.items).filter((i) => i.clasificacion === 'AMBIGUO' || i.clasificacion === 'CONFLICTO').length,
    contadoresAntes: Object.fromEntries(p.dominios.map((x) => [x.config.contadorId, x.contador.valorAntes])),
    contadoresDespues: Object.fromEntries(p.dominios.map((x) => [x.config.contadorId, x.contador.valorDespues])),
  };
}

export interface MetaManifest { projectId: string; sourceGitSha: string; sourceTreeClean: boolean; buildSha256: string; generatedAt: string }

export function construirManifest(plan: PlanCompleto, meta: MetaManifest): ManifestDryRun {
  const items = itemsDePlan(plan);
  const warnings = plan.dominios.flatMap((d) => d.warnings);
  if (!meta.sourceTreeClean) warnings.push('ARBOL_DE_TRABAJO_SUCIO: este manifest NO es aplicable (apply exige sourceTreeClean).');
  return {
    schemaVersion: SCHEMA_VERSION,
    kind: KIND_DRY_RUN,
    mode: 'dry-run',
    projectId: meta.projectId,
    sourceGitSha: meta.sourceGitSha,
    sourceTreeClean: meta.sourceTreeClean,
    buildSha256: meta.buildSha256,
    generatedAt: meta.generatedAt,
    resumen: resumirItems(plan),
    criterioOrden: Object.fromEntries(plan.dominios.map((d) => [d.config.coleccion, d.criterioOrden])),
    warnings,
    itemsSha256: huellaItems(items),
    items,
  };
}

// ══ ARGUMENTOS Y GUARDAS ═════════════════════════════════════════════════════════════════════════════════════════════

export interface Args {
  modo: 'dry-run' | 'apply';
  project: string | null;
  out: string | null;
  manifest: string | null;
  confirm: string | null;
  allowProduction: boolean;
}
const FLAGS_CON_VALOR = ['--project', '--out', '--manifest', '--confirm'];
const FLAGS_BOOL = ['--apply', '--allow-production'];

/** Parser ESTRICTO: un flag desconocido es error, nunca un dry-run/apply silencioso. Default = dry-run. */
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
  };
  if (!apply && (args.manifest || args.confirm || args.allowProduction)) {
    throw new Error('--manifest, --confirm y --allow-production solo se aceptan junto con --apply. Sin --apply el script es DRY RUN (0 writes).');
  }
  if (apply && args.out) throw new Error('--out es del dry-run; en apply el resultado se escribe junto al manifest.');
  return args;
}

/** Guardas de seguridad; devuelve TODOS los errores (vacío = puede seguir). Sin I/O. */
export function validarGuardas(args: Args): string[] {
  const errores: string[] = [];
  if (!args.project) errores.push('Falta --project <id>: el proyecto objetivo es explícito.');
  if (args.modo === 'dry-run') return errores;
  if (args.project !== PROYECTO_PRODUCCION) errores.push(`apply exige --project ${PROYECTO_PRODUCCION} (recibido: ${String(args.project)}).`);
  if (!args.manifest) errores.push('apply requiere --manifest <archivo>.');
  if (args.confirm !== FRASE_CONFIRMACION) errores.push(`apply requiere --confirm ${FRASE_CONFIRMACION} (frase exacta).`);
  if (!args.allowProduction) errores.push('apply requiere --allow-production.');
  return errores;
}

// ══ VALIDACIÓN DEL MANIFEST PARA APPLY ═══════════════════════════════════════════════════════════════════════════════

export class ManifestInvalido extends Error {}

export interface FuenteActual { sourceGitSha: string; sourceTreeClean: boolean; buildSha256: string }
const SHA_GIT = /^[0-9a-f]{40}$/;

/** El código que se EJECUTA debe ser el del manifest: mismo commit, árbol limpio y mismo JS compilado. Falta de evidencia ⇒ abort. */
export function verificarFuente(m: Pick<ManifestDryRun, 'sourceGitSha' | 'sourceTreeClean' | 'buildSha256'>, actual: FuenteActual): void {
  if (typeof m.sourceGitSha !== 'string' || !SHA_GIT.test(m.sourceGitSha)) throw new ManifestInvalido('El manifest no trae un sourceGitSha válido (40 hex).');
  if (!SHA_GIT.test(actual.sourceGitSha)) throw new ManifestInvalido('No se pudo determinar el commit que se ejecuta (git rev-parse HEAD).');
  if (m.sourceGitSha !== actual.sourceGitSha) throw new ManifestInvalido(`sourceGitSha distinto: manifest ${m.sourceGitSha}, código actual ${actual.sourceGitSha}.`);
  if (m.sourceTreeClean !== true) throw new ManifestInvalido('El manifest se generó con el árbol de trabajo sucio.');
  if (!actual.sourceTreeClean) throw new ManifestInvalido('El árbol de trabajo actual está sucio: el commit no describe el código que se ejecutaría.');
  if (typeof m.buildSha256 !== 'string' || m.buildSha256 !== actual.buildSha256) throw new ManifestInvalido('El JS compilado difiere del que generó el manifest (¿build desactualizado?).');
}

export interface PlanApply {
  comercio: ItemComercio[];
  dominios: Array<{ config: ConfigDominio; items: ItemCodigo[]; contador: ItemContador }>;
}

/**
 * Valida el manifest y arma el plan de apply. No confía a ciegas: schema, kind, modo, proyecto, fuente, huella, resumen recalculado,
 * forma de cada item y AUSENCIA de CONFLICTO/AMBIGUO. Cualquier problema lanza ⇒ 0 writes.
 */
export function planificarApply(manifest: unknown, projectId: string, fuente: FuenteActual): PlanApply {
  const m = manifest as Partial<ManifestDryRun> | null;
  if (!esObj(m)) throw new ManifestInvalido('El manifest no es un objeto.');
  if (m.schemaVersion !== SCHEMA_VERSION) throw new ManifestInvalido(`schemaVersion no soportado: ${String(m.schemaVersion)}.`);
  if (m.kind !== KIND_DRY_RUN) throw new ManifestInvalido('El manifest no es de esta migración.');
  if (m.mode !== 'dry-run') throw new ManifestInvalido('Solo se aplica un manifest generado por un dry-run.');
  if (m.projectId !== projectId) throw new ManifestInvalido(`El manifest es del proyecto "${String(m.projectId)}", no de "${projectId}".`);
  verificarFuente(m as ManifestDryRun, fuente);
  if (!Array.isArray(m.items)) throw new ManifestInvalido('El manifest no trae items.');
  if (huellaItems(m.items) !== m.itemsSha256) throw new ManifestInvalido('itemsSha256 no coincide: el manifest fue modificado.');

  const comercio: ItemComercio[] = [];
  const porDominio = new Map<string, { items: ItemCodigo[]; contador: ItemContador | null }>(
    DOMINIOS.map((c) => [c.coleccion, { items: [], contador: null }]),
  );
  const vistos = new Set<string>();
  for (const raw of m.items as ItemManifest[]) {
    if (!esObj(raw) || typeof raw.dominio !== 'string' || typeof raw.clasificacion !== 'string') throw new ManifestInvalido('Item sin dominio/clasificacion.');
    if (!CLASES.includes(raw.clasificacion as Clase)) throw new ManifestInvalido(`Clase inesperada (${raw.clasificacion}): STOP.`);
    const k = claveItem(raw);
    if (vistos.has(k)) throw new ManifestInvalido(`Item repetido en el manifest: ${k}.`);
    vistos.add(k);
    if (raw.clasificacion === 'CONFLICTO' || raw.clasificacion === 'AMBIGUO') {
      throw new ManifestInvalido(`El manifest contiene ${raw.clasificacion} (${k}): resolverlo antes de aplicar. Apply abortado (0 writes).`);
    }
    if (raw.dominio === 'usuarios_comercio') {
      const it = raw as ItemComercio;
      if (it.clasificacion === 'COMERCIO_BACKFILL_SEGURO' && (typeof it.usuarioId !== 'string' || it.comercioIdObjetivo !== it.usuarioId)) {
        throw new ManifestInvalido(`Backfill de comercio sin objetivo == usuarioId (${k}).`);
      }
      comercio.push(it);
    } else if (raw.dominio === 'contadores') {
      const it = raw as ItemContador;
      const bucket = DOMINIOS.find((c) => c.contadorId === it.contadorId);
      if (!bucket) throw new ManifestInvalido(`Contador desconocido: ${String(it.contadorId)}.`);
      if (it.clasificacion === 'CONTADOR_ACTUALIZAR' && (!esEntero(it.valorDespues) || it.valorDespues < 0 || (it.valorAntes !== null && it.valorDespues < it.valorAntes))) {
        throw new ManifestInvalido(`Contador ${it.contadorId}: valorDespues inválido o retrocede.`);
      }
      (porDominio.get(bucket.coleccion) as { contador: ItemContador | null }).contador = it;
    } else if (raw.dominio === COL_ORDENES || raw.dominio === COL_DEPOSITOS) {
      const it = raw as ItemCodigo;
      const cfg = DOMINIOS.find((c) => c.coleccion === it.dominio) as ConfigDominio;
      if (it.clasificacion === 'CODIGO_BACKFILL_SEGURO'
        && (!esEntero(it.secuenciaPropuesta) || it.secuenciaPropuesta < 1 || it.codigoPropuesto !== formatearCodigo(cfg.prefijo, it.secuenciaPropuesta))) {
        throw new ManifestInvalido(`Código propuesto incoherente con su secuencia (${k}).`);
      }
      (porDominio.get(it.dominio) as { items: ItemCodigo[] }).items.push(it);
    } else {
      throw new ManifestInvalido(`Dominio desconocido: ${String(raw.dominio)}.`);
    }
  }
  const dominios: PlanApply['dominios'] = [];
  for (const cfg of DOMINIOS) {
    const b = porDominio.get(cfg.coleccion) as { items: ItemCodigo[]; contador: ItemContador | null };
    if (!b.contador) throw new ManifestInvalido(`Falta el item del contador de ${cfg.coleccion}.`);
    const secs = b.items.map((i) => i.secuenciaPropuesta);
    if (new Set(secs).size !== secs.length) throw new ManifestInvalido(`Secuencias repetidas en ${cfg.coleccion}.`);
    if (b.items.length + 1 > MAX_WRITES_POR_TX) throw new ManifestInvalido(`${cfg.coleccion}: ${b.items.length} writes exceden el tope de una transacción (${MAX_WRITES_POR_TX}).`);
    dominios.push({ config: cfg, items: b.items, contador: b.contador });
  }
  if (comercio.length > MAX_WRITES_POR_TX) throw new ManifestInvalido('Demasiados usuarios Comercio para una transacción.');
  return { comercio, dominios };
}

// ══ REVALIDACIÓN LIVE (por contenido, sobre la foto releída DENTRO de la transacción) ═════════════════════════════════

export type ResultadoDominio = 'APLICADO' | 'YA_APLICADO' | 'SIN_CAMBIOS' | 'SKIP_CONFLICT';

export interface DecisionComercio {
  resultado: ResultadoDominio;
  motivo: string;
  /** usuarioId a escribir con comercioId = usuarioId. Vacío salvo APLICADO. */
  escribir: string[];
}

/**
 * Todo-o-nada. `fresco` = foto releída en la transacción.
 *  · APLICADO: cada item BACKFILL_SEGURO sigue siéndolo (o ya está YA_CORRECTO) y al menos uno requiere write.
 *  · YA_APLICADO: todos ya están YA_CORRECTO ⇒ 0 writes (retry).
 *  · SKIP_CONFLICT: cualquier otro caso ⇒ 0 writes en TODO el dominio.
 */
export function decidirComercio(items: ItemComercio[], usuarios: DocLite[], comercios: DocLite[]): DecisionComercio {
  const aplicables = items.filter((i) => i.clasificacion === 'COMERCIO_BACKFILL_SEGURO');
  const yaOk = items.filter((i) => i.clasificacion === 'YA_CORRECTO');
  if (aplicables.length === 0 && yaOk.length === 0) return { resultado: 'SIN_CAMBIOS', motivo: 'SIN_ITEMS_DE_COMERCIO', escribir: [] };
  const escribir: string[] = [];
  for (const it of [...aplicables, ...yaOk]) {
    const u = usuarios.find((x) => x.id === it.usuarioId);
    if (!u) return { resultado: 'SKIP_CONFLICT', motivo: `USUARIO_DESAPARECIO:${it.usuarioId}`, escribir: [] };
    const fresco = clasificarUsuarioComercio(u, usuarios, comercios);
    if (fresco.clasificacion === 'YA_CORRECTO') continue;
    if (fresco.clasificacion === 'COMERCIO_BACKFILL_SEGURO' && it.clasificacion === 'COMERCIO_BACKFILL_SEGURO') { escribir.push(u.id); continue; }
    return { resultado: 'SKIP_CONFLICT', motivo: `CAMBIO_DESDE_EL_DRY_RUN:${it.usuarioId}:${fresco.clasificacion}:${fresco.motivo}`, escribir: [] };
  }
  return escribir.length === 0
    ? { resultado: 'YA_APLICADO', motivo: 'TODOS_YA_TIENEN_COMERCIOID', escribir: [] }
    : { resultado: 'APLICADO', motivo: 'REVALIDADO', escribir: escribir.sort(ord) };
}

export interface DecisionDominio {
  resultado: ResultadoDominio;
  motivo: string;
  /** Asignaciones a escribir (docId, codigo, secuencia). Vacío salvo APLICADO. */
  asignaciones: Array<{ docId: string; codigo: string; secuencia: number }>;
  /** Contador: null = no tocar; accion 'crear' si no existe, 'actualizar' si existe. */
  contador: { accion: 'crear' | 'actualizar'; valor: number } | null;
}

const sinEscritura = (resultado: ResultadoDominio, motivo: string): DecisionDominio => ({ resultado, motivo, asignaciones: [], contador: null });

/**
 * Revalida un dominio de códigos contra el estado ACTUAL (releído en la transacción) y decide.
 *  · YA_APLICADO: todos los items del manifest ya tienen EXACTAMENTE el código/secuencia planificado y el contador existe con
 *    valor ≥ valorDespues (puede haber avanzado por operación normal) ⇒ 0 writes. No incrementa nada.
 *  · APLICADO: la foto fresca produce el MISMO plan (mismos docs, mismos códigos, mismo valorDespues y misma base) ⇒ escribe.
 *  · SKIP_CONFLICT: cualquier otra cosa (contador avanzó, aparecieron/desaparecieron docs, algo cambió) ⇒ 0 writes; hace falta un dry-run nuevo.
 *    NUNCA retrocede un contador.
 */
export function decidirDominio(
  plan: PlanApply['dominios'][number], docs: DocLite[], contadorDoc: DocLite | null,
): DecisionDominio {
  const { config, items, contador } = plan;
  const aAsignar = items.filter((i) => i.clasificacion === 'CODIGO_BACKFILL_SEGURO');
  const valorFresco = contadorDoc && esEntero(contadorDoc.data.valor) && contadorDoc.data.valor >= 0 ? contadorDoc.data.valor : null;
  if (contadorDoc && valorFresco === null) return sinEscritura('SKIP_CONFLICT', 'CONTADOR_CORRUPTO_AHORA');

  // ¿Ya aplicado?
  const todosEnSuLugar = aAsignar.every((i) => {
    const d = docs.find((x) => x.id === i.docId);
    return !!d && d.data.codigo === i.codigoPropuesto && d.data.secuencia === i.secuenciaPropuesta;
  });
  if (aAsignar.length > 0 && todosEnSuLugar) {
    const contadorOk = valorFresco !== null && contador.valorDespues !== null && valorFresco >= contador.valorDespues;
    return contadorOk
      ? sinEscritura('YA_APLICADO', 'CODIGOS_Y_CONTADOR_YA_APLICADOS')
      : sinEscritura('SKIP_CONFLICT', 'CODIGOS_APLICADOS_PERO_CONTADOR_INCOHERENTE');
  }

  // Re-planificar sobre la foto fresca y exigir el MISMO plan.
  const fresco = planificarDominio(config, docs, contadorDoc);
  if (fresco.items.some((i) => i.clasificacion === 'CONFLICTO' || i.clasificacion === 'AMBIGUO') || fresco.contador.clasificacion === 'CONFLICTO' || fresco.contador.clasificacion === 'AMBIGUO') {
    return sinEscritura('SKIP_CONFLICT', 'ESTADO_ACTUAL_CON_CONFLICTO_O_AMBIGUEDAD');
  }
  const propios = (xs: ItemCodigo[]) => xs.filter((i) => i.clasificacion === 'CODIGO_BACKFILL_SEGURO')
    .map((i) => `${i.docId}|${i.codigoPropuesto}|${i.secuenciaPropuesta}`).sort();
  if (jsonCanonico(propios(fresco.items)) !== jsonCanonico(propios(items))) return sinEscritura('SKIP_CONFLICT', 'DOCUMENTOS_LEGACY_O_SECUENCIAS_CAMBIARON_DESDE_EL_DRY_RUN');
  if (fresco.contador.valorDespues !== contador.valorDespues) return sinEscritura('SKIP_CONFLICT', 'CONTADOR_CAMBIO_DESDE_EL_DRY_RUN');
  if (valorFresco !== null && contador.valorDespues !== null && valorFresco > contador.valorDespues) return sinEscritura('SKIP_CONFLICT', 'CONTADOR_ADELANTADO_NO_SE_RETROCEDE');

  const valorFinal = contador.valorDespues as number;
  const asignaciones = aAsignar.map((i) => ({ docId: i.docId, codigo: i.codigoPropuesto as string, secuencia: i.secuenciaPropuesta as number }));
  if (valorFresco === valorFinal && asignaciones.length === 0) return sinEscritura('SIN_CAMBIOS', 'CONTADOR_YA_COHERENTE_Y_SIN_LEGACY');
  return {
    resultado: 'APLICADO', motivo: 'REVALIDADO', asignaciones,
    contador: valorFresco === null ? { accion: 'crear', valor: valorFinal } : { accion: 'actualizar', valor: valorFinal },
  };
}
