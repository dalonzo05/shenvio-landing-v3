// DEPOSITO-AUDITORIA-1 · ROLLOUT — genera las Rules PUENTE.
//
// ─── Por qué hace falta un puente ─────────────────────────────────────────
//
// Esta feature cambia la web, firestore.rules y storage.rules a la vez, y
// ningún orden simple de deploy funciona (demostrado en los casos DC/PB de
// test/storage-rules.test.ts):
//
//   web F2 + Rules F1      ROTO: bouchers/* no tiene match y la subcolección
//                          `eventos` tampoco, así que "Pedir corrección" y el
//                          reemplazo versionado mueren.
//   Rules finales + web F1 ROTO: "Devolver al motorizado" y "Eliminar" del
//                          web viejo hacen delete —ahora DENY—, y confirmar,
//                          rehacer y reemplazar dejaron de pasar sin evento.
//
// ─── Cómo se construye ────────────────────────────────────────────────────
//
// Opción B del traspaso: NO hay un archivo de puente versionado aparte, que
// se desincronizaría de las Rules finales en cuanto alguien tocara una y no
// la otra. El puente se DERIVA de las Rules finales aplicando una lista corta
// y explícita de parches, y cada parche exige que su texto aparezca EXACTAMENTE
// UNA VEZ. Si las Rules finales cambian de forma que un ancla deja de existir
// —o aparece dos veces—, este script FALLA en vez de generar un puente
// silenciosamente incorrecto.
//
// Dos de los tres parches son un booleano: las Rules finales llevan un
// interruptor documentado (`auditoriaF2Obligatoria()` /
// `versionadoF2Obligatorio()`) que vale true, y el puente lo pone en false.
// Así la diferencia entre puente y final se lee en tres renglones.
//
//     node scripts/reglas-puente.mjs [destino]     (por defecto .reglas-puente)
//
// ─── Fin de línea ─────────────────────────────────────────────────────────
//
// Las anclas están escritas con \n, pero en un checkout de Windows con
// core.autocrlf=true los .rules están en el working tree con CRLF: las dos
// anclas multilínea daban 0 coincidencias y el generador fallaba pidiendo
// "actualizá el ancla", cuando las Rules estaban perfectas. Por eso todo lo
// que entra se normaliza a LF y el puente se escribe siempre en LF —que es
// además lo que guarda git y lo que consume el deploy—. El artefacto es
// byte a byte el mismo se genere desde un checkout LF o CRLF
// (scripts/reglas-puente.test.mjs, casos G1–G3).
//
// El puente NO relaja: el sellado de F1, el tipo C pagado, el create-first,
// la subcolección append-only, la inmutabilidad del path versionado, el
// estado 'devuelto' con su motivo obligatorio y los permisos de cualquier
// otro usuario quedan exactamente como en las Rules finales.
//
// NO deploya nada. Solo escribe los dos archivos.

import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { resolve } from 'node:path'

/**
 * Cada parche dice QUÉ vuelve a permitir y POR QUÉ, con el flujo del web F1
 * que lo necesita. Si un `buscar` deja de estar, el script se detiene.
 */
export const PARCHES = [
  {
    archivo: 'firestore.rules',
    porque:
      'El web F1 confirma, rehace y reemplaza el comprobante SIN evento de ' +
      'auditoría (confirmarDepositoExistente, rehacerDeposito, reemplazarBoucher). ' +
      'Con el interruptor en false esas tres transiciones vuelven a la forma de F1. ' +
      'No toca el sellado, ni "Pedir corrección", ni la anulación auditada.',
    buscar: '      function auditoriaF2Obligatoria() {\n        return true;\n      }',
    reemplazar:
      '      function auditoriaF2Obligatoria() {\n' +
      '        return false;  // PUENTE: generado por scripts/reglas-puente.mjs\n' +
      '      }',
  },
  {
    archivo: 'firestore.rules',
    porque:
      'El web F1 borra el documento en "Devolver al motorizado" (gestor, estados ' +
      'abiertos) y en "Eliminar" (admin, cualquier estado). Sin esto el gestor se ' +
      'queda sin ninguna forma de devolver un depósito mientras dure el rollout.',
    buscar: '      allow delete: if false;  // #puente:delete-deposito',
    reemplazar:
      '      // PUENTE: generado por scripts/reglas-puente.mjs — regla de F1,\n' +
      '      // solo mientras el web viejo siga desplegado.\n' +
      '      allow delete: if isAdmin()\n' +
      "        || (isAdminOrGestor() && resource.data.get('estado', '') in ['pendiente_boucher', 'en_revision']);",
  },
  {
    archivo: 'storage.rules',
    porque:
      'El web F1 sube la corrección de staff al path legacy ' +
      'depositos/{uid}/{depId}/boucher.jpg estando el depósito en revisión. ' +
      'No toca la inmutabilidad de bouchers/{versionId} ni el sellado.',
    buscar: '    function versionadoF2Obligatorio() {\n      return true;\n    }',
    reemplazar:
      '    function versionadoF2Obligatorio() {\n' +
      '      return false;  // PUENTE: generado por scripts/reglas-puente.mjs\n' +
      '    }',
  },
]

/** CRLF y CR solitario → LF. Todo lo que entra al generador pasa por acá. */
export const aLF = (contenido) => contenido.replace(/\r\n?/g, '\n')

/** Falla del generador: un ancla que no aparece exactamente una vez. */
export class AnclaPuenteInvalida extends Error {
  constructor(parche, veces) {
    super(
      `\n✗ ${parche.archivo}: el ancla del puente aparece ${veces} veces, se esperaba 1.\n` +
      `  Parche: ${parche.porque}\n` +
      `  Ancla:\n${parche.buscar}\n\n` +
      `  Las Rules finales cambiaron y el puente NO se puede derivar de ellas.\n` +
      `  Actualizá el ancla en scripts/reglas-puente.mjs antes de seguir.\n`,
    )
    this.name = 'AnclaPuenteInvalida'
    this.archivo = parche.archivo
    this.veces = veces
  }
}

/**
 * Deriva el puente de las Rules finales. Puro: recibe el contenido, no lee
 * disco.
 *
 * @param fuentes  objeto o Map con { 'firestore.rules': contenido, ... },
 *                 en LF o CRLF, indistinto
 * @param parches  por defecto PARCHES; el test usa listas propias
 * @returns Map archivo → contenido del puente, siempre en LF
 * @throws AnclaPuenteInvalida si un ancla aparece 0 veces o más de una
 */
export function derivarPuente(fuentes, parches = PARCHES) {
  const leer = (archivo) => (fuentes instanceof Map ? fuentes.get(archivo) : fuentes[archivo])
  const porArchivo = new Map()
  for (const p of parches) {
    if (porArchivo.has(p.archivo)) continue
    const contenido = leer(p.archivo)
    if (typeof contenido !== 'string') throw new Error(`derivarPuente: falta el contenido de ${p.archivo}`)
    porArchivo.set(p.archivo, aLF(contenido))
  }
  for (const parche of parches) {
    const actual = porArchivo.get(parche.archivo)
    const veces = actual.split(parche.buscar).length - 1
    if (veces !== 1) throw new AnclaPuenteInvalida(parche, veces)
    porArchivo.set(parche.archivo, actual.replace(parche.buscar, parche.reemplazar))
  }
  return porArchivo
}

/** Lee las Rules finales del disco (cualquier fin de línea) y escribe el puente en LF. */
export function generarPuente(destino, parches = PARCHES) {
  const fuentes = new Map()
  for (const p of parches) {
    if (!fuentes.has(p.archivo)) fuentes.set(p.archivo, readFileSync(p.archivo, 'utf8'))
  }
  const puente = derivarPuente(fuentes, parches)
  mkdirSync(destino, { recursive: true })
  for (const [archivo, contenido] of puente) writeFileSync(`${destino}/${archivo}`, contenido)
  return puente
}

// ─── CLI ──────────────────────────────────────────────────────────────────

const ejecutadoDirecto = process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url))
if (ejecutadoDirecto) {
  const destino = process.argv[2] || '.reglas-puente'
  let puente
  try {
    puente = generarPuente(destino)
  } catch (e) {
    console.error(e instanceof AnclaPuenteInvalida ? e.message : e)
    process.exit(1)
  }
  for (const archivo of puente.keys()) {
    console.log(`${destino}/${archivo}  ←  ${archivo} + ${PARCHES.filter((p) => p.archivo === archivo).length} parche(s)`)
  }
  console.log('\nParches aplicados:')
  for (const p of PARCHES) console.log(`  · ${p.archivo}: ${p.porque}`)
  console.log('\nEsto NO deploya nada.')
}
