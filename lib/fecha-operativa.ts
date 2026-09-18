// DEPOSITOS-UX-TRAZABILIDAD-1 — Fecha y hora operativas de ShEnvíos.
//
// Las pantallas formateaban con `toLocaleString()` y compañía, que usan el
// huso del NAVEGADOR. Un gestor con el equipo en UTC−3 veía el depósito de
// SH-0001 enviado a las 20:24 cuando en Managua eran las 17:24: tres horas de
// diferencia en un dato de auditoría, y cerca de medianoche, otro día.
//
// Regla autoritativa: la hora operativa es la de America/Managua. Nicaragua
// no aplica horario de verano, así que es UTC−6 todo el año y basta la misma
// constante que ya usa el día operativo (dia-operativo.ts) — sin librería de
// zonas horarias y sin depender de los datos ICU del runtime.
//
// PURO e INDEPENDIENTE DEL PROCESO: se desplaza el epoch y se leen
// componentes UTC. Ningún método local de Date aparece acá; con TZ=UTC,
// TZ=Asia/Tokyo o TZ=America/Managua el resultado es el mismo.

import { OFFSET_NICARAGUA_HORAS } from './dia-operativo'
import { normalizarFecha } from './timeline-orden'

/** Zona que estos helpers representan. Informativa: el cálculo usa el offset. */
export const ZONA_OPERATIVA = 'America/Managua'

/** Lo que se muestra cuando el dato no existe. Nunca se inventa "ahora". */
export const SIN_FECHA = '—'

const OFFSET_MS = OFFSET_NICARAGUA_HORAS * 60 * 60 * 1000
const dos = (n: number) => String(n).padStart(2, '0')

interface Partes {
  dia: string
  mes: string
  anio: string
  hora: string
  minuto: string
}

function partes(v: unknown): Partes | null {
  const d = normalizarFecha(v)
  if (!d) return null
  const x = new Date(d.getTime() + OFFSET_MS)
  if (Number.isNaN(x.getTime())) return null
  return {
    dia: dos(x.getUTCDate()),
    mes: dos(x.getUTCMonth() + 1),
    anio: String(x.getUTCFullYear()),
    hora: dos(x.getUTCHours()),
    minuto: dos(x.getUTCMinutes()),
  }
}

/** `17/09/2026` en Managua. */
export function fechaOperativa(v: unknown): string {
  const p = partes(v)
  return p ? `${p.dia}/${p.mes}/${p.anio}` : SIN_FECHA
}

/** `17:24` en Managua, reloj de 24 horas. */
export function horaOperativa(v: unknown): string {
  const p = partes(v)
  return p ? `${p.hora}:${p.minuto}` : SIN_FECHA
}

/** `17/09/2026 · 17:24` en Managua. */
export function fechaHoraOperativa(v: unknown): string {
  const p = partes(v)
  return p ? `${p.dia}/${p.mes}/${p.anio} · ${p.hora}:${p.minuto}` : SIN_FECHA
}
