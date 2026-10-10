// A7-01 — Migrador determinístico de legacy de producción (comercioId + contadores + codigo/secuencia).
//
//   cd functions && npm run build && cd ..
//   DRY RUN (default, SOLO lectura):  node scripts/a7-prod-legacy.cjs --project <id> [--out manifest.json]
//   APPLY (NO usar hasta la preintegración aprobada):
//     node scripts/a7-prod-legacy.cjs --project storkhub-9f719 --apply --manifest <archivo> \
//       --confirm APPLY-A7-PROD-LEGACY --allow-production
//
// Sin --apply NO existe ninguna operación de escritura en este proceso. El manifest se escribe FUERA de Git (usar --out fuera del repo).
// Toda la lógica vive en functions/src/legacy-prod-migracion*.ts y está testeada sin Firestore; este archivo solo adapta firebase-admin.
const path = require('node:path');
const fs = require('node:fs');
const crypto = require('node:crypto');
const { execFileSync } = require('node:child_process');
const raiz = path.join(__dirname, '..');
const lib = path.join(raiz, 'functions', 'lib');
const {
  parsearArgs, validarGuardas, ManifestInvalido,
} = require(path.join(lib, 'legacy-prod-migracion.js'));
const { ejecutarDryRun, ejecutarApply } = require(path.join(lib, 'legacy-prod-migracion-runner.js'));

function salir(msgs, code = 2) { for (const m of [].concat(msgs)) console.error(m); process.exit(code); }

let args;
try { args = parsearArgs(process.argv.slice(2)); } catch (e) { salir(`Error de argumentos: ${e.message}`); }
const errores = validarGuardas(args);
if (errores.length) salir(errores);

// ── Fuente: qué código se está ejecutando ────────────────────────────────────────────────────────────────────────────
const git = (...a) => execFileSync('git', a, { cwd: raiz }).toString().trim();
function fuenteActual() {
  let sha = 'desconocido';
  let limpio = false;
  try {
    sha = git('rev-parse', 'HEAD');
    // Solo archivos rastreados: el manifest de salida puede vivir en el árbol sin invalidar la fuente.
    limpio = git('status', '--porcelain', '--untracked-files=no') === '';
  } catch { /* sin git ⇒ sha 'desconocido' ⇒ el apply aborta */ }
  // Huella del JS compilado + del propio script: un build desactualizado respecto del commit no pasa.
  const h = crypto.createHash('sha256');
  for (const f of [
    path.join(lib, 'legacy-prod-migracion.js'), path.join(lib, 'legacy-prod-migracion-runner.js'), path.join(lib, 'codigos.js'), __filename,
  ]) h.update(path.basename(f)).update('\0').update(fs.readFileSync(f)).update('\0');
  return { sourceGitSha: sha, sourceTreeClean: limpio, buildSha256: h.digest('hex') };
}

const admin = require(path.join(raiz, 'functions', 'node_modules', 'firebase-admin'));
admin.initializeApp({ projectId: args.project });
const db = admin.firestore();

const aDoc = (d) => ({ id: d.id, data: d.data() });
function lectorDe(leer) {
  return {
    async listar(c) { return (await leer(db.collection(c))).docs.map(aDoc); },
    async getDoc(c, id) { const s = await leer(db.collection(c).doc(id)); return s.exists ? aDoc(s) : null; },
  };
}

async function main() {
  const ahora = new Date();
  const fuente = fuenteActual();
  if (args.modo === 'dry-run') {
    if (process.env.FIRESTORE_EMULATOR_HOST) console.error(`Emulador: ${process.env.FIRESTORE_EMULATOR_HOST}`);
    const manifest = await ejecutarDryRun(lectorDe((r) => r.get()), { projectId: args.project, ...fuente, generatedAt: ahora.toISOString() });
    const out = args.out || `a7-prod-legacy.${args.project}.${ahora.toISOString().replace(/[:.]/g, '-')}.dry-run.json`;
    fs.writeFileSync(out, JSON.stringify(manifest, null, 2) + '\n');
    console.log(`DRY RUN (0 writes) · proyecto ${args.project} · manifest: ${out}`);
    console.log(JSON.stringify(manifest.resumen));
    for (const w of manifest.warnings) console.log(`AVISO: ${w}`);
    return;
  }
  const manifest = JSON.parse(fs.readFileSync(args.manifest, 'utf8'));
  const env = {
    transaccion: (fn) => db.runTransaction((tx) => {
      const tr = lectorDe((r) => tx.get(r));
      tr.actualizar = (c, id, campos) => { tx.update(db.collection(c).doc(id), campos); };
      tr.crear = (c, id, campos) => { tx.create(db.collection(c).doc(id), campos); };
      return fn(tr);
    }),
  };
  const res = await ejecutarApply(env, manifest, { projectId: args.project, ahora, fuente });
  const out = `${args.manifest}.apply-${ahora.toISOString().replace(/[:.]/g, '-')}.json`;
  fs.writeFileSync(out, JSON.stringify(res, null, 2) + '\n');
  console.log(`APPLY · proyecto ${args.project} · resultado: ${out}`);
  console.log(JSON.stringify(res.totales));
  if (res.detenido || res.totales.SKIP_CONFLICT > 0) process.exit(1);
}

main().catch((e) => { if (e instanceof ManifestInvalido) salir(`STOP (0 writes): ${e.message}`); console.error(e); process.exit(1); });
