// DEPOSITO-AUDITORIA-1 · ROLLOUT — corre la suite de storage.rules en los
// emuladores, opcionalmente contra otro juego de Rules.
//
//     node scripts/suite-storage.mjs                 Rules finales del repo
//     node scripts/suite-storage.mjs .reglas-base    Rules desplegadas (compat)
//     node scripts/suite-storage.mjs .reglas-puente  Rules puente
//
// Existe por portabilidad: los scripts de npm pasaban la carpeta con
// `REGLAS_BASE_DIR=... firebase ...`, que es sintaxis de shell POSIX y en
// Windows npm ejecuta con cmd.exe ("REGLAS_BASE_DIR no se reconoce como un
// comando"). Acá la variable se pone en el entorno del proceso hijo, que
// funciona igual en Windows, macOS y Linux, y sin dependencias nuevas.
//
// La suite ya tiene que estar compilada (tsc -p tsconfig.storage-rules.json).
// NO deploya nada: todo corre contra los emuladores.

import { spawnSync } from 'node:child_process'

const dirReglas = process.argv[2] || ''
const env = { ...process.env }
if (dirReglas) env.REGLAS_BASE_DIR = dirReglas

// Un solo comando con shell: el comando que ejecuta el emulador va entre
// comillas dobles —válidas en cmd.exe y en sh— porque si se pasa como un
// argumento más, firebase lee el `--test` como opción propia.
const comando = 'firebase emulators:exec --only firestore,storage'
  + ' --project demo-storage-evidencia "node --test .storage-rules-build/test"'

const r = spawnSync(comando, { stdio: 'inherit', env, shell: true })
process.exit(r.status === null ? 1 : r.status)
