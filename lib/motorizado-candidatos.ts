// MOTO-RANKING-DATOS-REALTIME-1 — decisiones puras que las 4 superficies de
// asignación comparten sobre el roster en vivo. No calcula el ranking (eso
// sigue siendo rankearMotorizados, sin cambios semánticos); solo decide qué
// hacer con la lista de candidatos y con la selección del gestor.

import { diaOperativoDe } from './dia-operativo'

/**
 * ¿Sigue siendo válida la selección actual? No hay selección (''), o el id
 * elegido todavía aparece entre los candidatos elegibles vigentes.
 *
 * Un candidato que deja de ser elegible (pasa a inactivo, se desactiva, etc.)
 * desaparece de `candidatos` porque rankearMotorizados ya lo filtra — esta
 * función es la que le dice a la UI que además debe soltar esa selección, en
 * vez de dejarla como un id fantasma que ya no se ve pero se podría enviar.
 */
export function seleccionSigueValida(motorizadoSel: string, candidatos: ReadonlyArray<{ id: string }>): boolean {
  if (!motorizadoSel) return true
  return candidatos.some((c) => c.id === motorizadoSel)
}

/**
 * Día operativo (Managua) que corresponde a `ahoraMs`, como clave de dependencia
 * de un useMemo: cuando cambia (cruza medianoche Nicaragua), fuerza recomputar el
 * ranking aunque ningún documento de Firestore haya cambiado — ver useTickOperativo.
 * `null` si `ahoraMs` no es un instante válido (no debería ocurrir en producción).
 */
export function diaOperativoParaRecomputo(ahoraMs: number): string | null {
  return diaOperativoDe(ahoraMs)
}
