// ─── lib/motorizado-referencia-ux.ts ─────────────────────────────────────────
// MOTO-RANKING-REFERENCIA-UX-1 — convierte la ReferenciaGeografica que ya
// decide lib/motorizado-ranking.ts (getReferenciaGeografica) en copy humano
// para el Gestor. Separado a propósito de la fórmula del ranking: este
// archivo NO decide nada, solo redacta lo que la decisión matemática ya
// entregó — misma distancia, mismo punto, mismo tipo. Puro, sin Firebase,
// sin React.

import { mostrarCodigo } from './codigo-humano'
import { normalizarFecha } from './timeline-orden'
import type { ReferenciaGeografica } from './motorizado-ranking'

/**
 * "hace X min" / "hace Xh Ym" a partir de un timestamp real (Firestore
 * Timestamp, Date, string ISO — lo que acepte normalizarFecha). Nunca
 * inventa una antigüedad: si el timestamp no es legible, o cae en el
 * futuro (reloj desincronizado), devuelve null y el llamador simplemente
 * omite ese dato.
 */
export function formatearAntiguedad(timestamp: unknown, ahoraMs: number): string | null {
  const fecha = normalizarFecha(timestamp)
  if (!fecha) return null
  const diffMin = Math.floor((ahoraMs - fecha.getTime()) / 60000)
  if (diffMin < 0) return null
  if (diffMin < 1) return 'hace instantes'
  if (diffMin < 60) return `hace ${diffMin} min`
  const horas = Math.floor(diffMin / 60)
  const minutos = diffMin % 60
  return `hace ${horas}h ${minutos}m`
}

const ETIQUETA_TIPO_PUNTO: Record<'retiro' | 'entrega', string> = {
  retiro: 'Retiro',
  entrega: 'Entrega',
}

/**
 * Línea de copy que explica de dónde sale la cercanía de un candidato.
 * Reutiliza la MISMA distancia que ya calculó el ranking (`distanciaKm`,
 * el `detalles.distanciaProximoKm` de ScoreResult) — nunca la recalcula acá.
 *
 * Nunca llama "ubicación actual" a una última ubicación operativa: esa es,
 * por contrato, una posición histórica de la sesión de presencia vigente,
 * no un GPS en vivo.
 */
export function textoReferenciaGeografica(
  referencia: ReferenciaGeografica,
  distanciaKm: number | null,
  ahoraMs: number = Date.now()
): string {
  const sufijoDistancia = distanciaKm !== null ? ` · ${distanciaKm.toFixed(1)} km` : ''

  switch (referencia.tipo) {
    case 'proximo_punto_operativo': {
      const codigo = mostrarCodigo(referencia.codigoOrden, referencia.ordenId)
      const etiquetaPunto = referencia.tipoPunto ? ETIQUETA_TIPO_PUNTO[referencia.tipoPunto] : null
      return `Próximo punto · ${codigo}${etiquetaPunto ? ` · ${etiquetaPunto}` : ''}${sufijoDistancia}`
    }
    case 'ultima_ubicacion_operativa': {
      const antiguedad = formatearAntiguedad(referencia.timestamp, ahoraMs)
      return `Última ubicación operativa${antiguedad ? ` · ${antiguedad}` : ''}${sufijoDistancia}`
    }
    case 'ubicacion_base':
      return `Ubicación base${sufijoDistancia}`
    case 'sin_referencia':
    default:
      return 'Sin ubicación disponible · referencia neutral'
  }
}

/**
 * MOTO-RANKING-REFERENCIA-ZONA-UX-1 — tercera línea opcional con el contexto
 * territorial (zona/macrozona) del mismo punto que ya describe
 * textoReferenciaGeografica(). Nunca inventa: si `referencia` no trae
 * ninguno de los dos campos (dato no autoritativo, ej. última ubicación
 * operativa hoy), retorna null y el llamador simplemente omite la línea —
 * nunca "Zona desconocida" ni "Sin zona".
 */
export function getReferenciaZonaTexto(referencia: ReferenciaGeografica): string | null {
  const zona = typeof referencia.zonaNombre === 'string' && referencia.zonaNombre.trim() !== '' ? referencia.zonaNombre : null
  const macroZona = typeof referencia.macroZonaNombre === 'string' && referencia.macroZonaNombre.trim() !== '' ? referencia.macroZonaNombre : null
  if (zona && macroZona) return `${zona} · ${macroZona}`
  if (zona) return zona
  if (macroZona) return macroZona
  return null
}
