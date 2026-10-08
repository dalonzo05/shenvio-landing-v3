// FIN-1D — piezas puras de la pantalla de Liquidaciones (sin Firebase): ¿ya terminó la semana?
//
// El servidor es la autoridad (semana_no_cerrada); esto solo deja la pantalla en línea con él para no ofrecer una acción que va a rechazar.
// Nicaragua no aplica horario de verano: Managua es UTC−6 todo el año (igual que functions/src/cobro-semanal.ts).

const MANAGUA_UTC_OFFSET_MIN = -6 * 60
const RE_SEMANA = /^(\d{4})-W(0[1-9]|[1-4]\d|5[0-3])$/

/** Domingo 23:59:59.999 (Managua) de la semana ISO, como instante UTC en ms. null si la semana no es válida. */
export function finDeSemanaManagua(semanaKey: string): number | null {
  const m = RE_SEMANA.exec(semanaKey)
  if (!m) return null
  const year = Number(m[1])
  const week = Number(m[2])
  const jan4 = new Date(Date.UTC(year, 0, 4))
  const jan4Day = jan4.getUTCDay() || 7
  const lunes = new Date(jan4)
  lunes.setUTCDate(jan4.getUTCDate() - jan4Day + 1 + (week - 1) * 7)
  lunes.setUTCHours(0, 0, 0, 0)
  const domingo = new Date(lunes)
  domingo.setUTCDate(lunes.getUTCDate() + 6)
  domingo.setUTCHours(23, 59, 59, 999)
  return domingo.getTime() - MANAGUA_UTC_OFFSET_MIN * 60_000
}

/** ¿La semana ya terminó (en Managua)? La semana en curso y las futuras NO se liquidan. */
export function semanaYaTermino(semanaKey: string, ahoraMs: number): boolean {
  const fin = finDeSemanaManagua(semanaKey)
  return fin !== null && ahoraMs > fin
}

export const MSG_SEMANA_EN_CURSO = 'La semana todavía no terminó: solo se liquidan semanas cerradas (domingo 23:59, hora de Managua).'
