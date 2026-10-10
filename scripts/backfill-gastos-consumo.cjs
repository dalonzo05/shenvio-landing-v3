// FIN-GASTOS-CONSUMO-BACKFILL-1 (A3-02) — backfill de `gastos_motorizado.consumidoEnDepositoId` desde `ordenes_deposito.gastosIds`.
//
//   cd functions && npm run build && cd ..
//   DRY RUN (default, SOLO lectura):  node scripts/backfill-gastos-consumo.cjs --project <id> [--out manifest.json]
//   APPLY (guardado, requiere un manifest de dry-run):
//     node scripts/backfill-gastos-consumo.cjs --project <id> --apply --manifest <archivo> --confirm APPLY-GASTOS-CONSUMO-BACKFILL
//     (un proyecto que parece producción exige además --allow-production y --confirm-production APPLY-PRODUCCION-<id>)
//
// Toda la lógica (clasificación, guardas, plan, revalidación) vive en functions/src/gasto-consumo-backfill*.ts y está testeada sin Firestore;
// este archivo solo adapta firebase-admin a las interfaces `Lector`/`Entorno`. Sin --apply NO escribe nada.
const path = require('node:path');
const fs = require('node:fs');
const { execSync } = require('node:child_process');
const lib = path.join(__dirname, '..', 'functions', 'lib');
const { parsearArgs, validarGuardas, ManifestInvalido, pareceProduccion } = require(path.join(lib, 'gasto-consumo-backfill.js'));
const { ejecutarDryRun, ejecutarApply } = require(path.join(lib, 'gasto-consumo-backfill-runner.js'));

function salir(msgs, code = 2) { for (const m of [].concat(msgs)) console.error(m); process.exit(code); }

let args;
try { args = parsearArgs(process.argv.slice(2)); } catch (e) { salir(`Error de argumentos: ${e.message}`); }
const errores = validarGuardas(args);
if (errores.length) salir(errores);

const admin = require(path.join(__dirname, '..', 'functions', 'node_modules', 'firebase-admin'));
admin.initializeApp({ projectId: args.project });
const db = admin.firestore();
const Timestamp = admin.firestore.Timestamp;

const tiempo = (t) => (t ? `${t.seconds}.${String(t.nanoseconds).padStart(9, '0')}` : null);
const aTimestamp = (s) => { const [sec, ns] = s.split('.'); return new Timestamp(Number(sec), Number(ns)); };
const aRef = (d) => ({ id: d.id, data: d.data(), updateTime: tiempo(d.updateTime) });
const aRefs = (snap) => snap.docs.map(aRef);

// Lector sobre db o sobre una transacción (misma forma). Los `in` se parten ya en el runner (≤30).
function lectorDe(leer) {
  return {
    async getDoc(c, id) { const s = await leer(db.collection(c).doc(id)); return s.exists ? aRef(s) : null; },
    async consultaArrayContains(c, campo, v) { return aRefs(await leer(db.collection(c).where(campo, 'array-contains', v))); },
    async consultaIn(c, campo, vs) { return aRefs(await leer(db.collection(c).where(campo, 'in', vs))); },
    async listar(c) { return aRefs(await leer(db.collection(c))); },
  };
}

function sourceGitSha() { try { return execSync('git rev-parse HEAD', { cwd: path.join(__dirname, '..') }).toString().trim(); } catch { return 'desconocido'; } }

async function main() {
  const ahora = new Date();
  if (args.modo === 'dry-run') {
    if (pareceProduccion(args.project)) console.error(`AVISO: "${args.project}" parece producción. DRY RUN: solo lectura.`);
    const manifest = await ejecutarDryRun(lectorDe((r) => r.get()), { projectId: args.project, sourceGitSha: sourceGitSha(), ahora });
    const out = args.out || `backfill-gastos-consumo.${args.project}.${ahora.toISOString().replace(/[:.]/g, '-')}.dry-run.json`;
    fs.writeFileSync(out, JSON.stringify(manifest, null, 2) + '\n');
    console.log(`DRY RUN (0 writes) · proyecto ${args.project} · manifest: ${out}`);
    console.log(JSON.stringify(manifest.totales));
    return;
  }
  const manifest = JSON.parse(fs.readFileSync(args.manifest, 'utf8'));
  const env = {
    serverTimestamp: () => admin.firestore.FieldValue.serverTimestamp(),
    lector: lectorDe((r) => r.get()),
    transaccion: (fn) => db.runTransaction((tx) => {
      const tr = lectorDe((r) => tx.get(r));
      tr.actualizar = (c, id, campos, lastUpdateTime) => { tx.update(db.collection(c).doc(id), campos, { lastUpdateTime: aTimestamp(lastUpdateTime) }); };
      return fn(tr);
    }),
  };
  const res = await ejecutarApply(env, manifest, { projectId: args.project, ahora });
  const out = `${args.manifest}.apply-${res.operacionBackfillId}.json`;
  fs.writeFileSync(out, JSON.stringify(res, null, 2) + '\n');
  console.log(`APPLY · proyecto ${args.project} · operación ${res.operacionBackfillId} · resultado: ${out}`);
  console.log(JSON.stringify(res.totales));
  if (res.detenido) process.exit(1);
}

main().catch((e) => { if (e instanceof ManifestInvalido) salir(`STOP (0 writes): ${e.message}`); console.error(e); process.exit(1); });
