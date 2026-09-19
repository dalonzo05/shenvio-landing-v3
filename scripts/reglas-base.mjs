// DEPOSITO-AUDITORIA-1 · S.38 — materializa las Rules DESPLEGADAS para poder
// probar la compatibilidad del rollout contra ellas.
//
// No se commitea una copia de las reglas viejas: se sacarían de sincronía con
// lo que realmente está desplegado en el momento en que alguien mire, que es
// justo cuando importa. Se leen de git, de la ref que representa el ambiente.
//
//     node scripts/reglas-base.mjs [ref]      (por defecto origin/staging)
//
// Deja firestore.rules y storage.rules en .reglas-base/, que la suite de
// storage lee vía REGLAS_BASE_DIR. Ver `npm run test:compat-rules`.

import { execFileSync } from 'node:child_process'
import { mkdirSync, writeFileSync } from 'node:fs'

const ref = process.argv[2] || process.env.REGLAS_BASE_REF || 'origin/staging'
const destino = '.reglas-base'

mkdirSync(destino, { recursive: true })
for (const archivo of ['firestore.rules', 'storage.rules']) {
  const contenido = execFileSync('git', ['show', `${ref}:${archivo}`], { encoding: 'utf8' })
  writeFileSync(`${destino}/${archivo}`, contenido)
  console.log(`${destino}/${archivo}  ←  ${ref}:${archivo}  (${contenido.length} bytes)`)
}
