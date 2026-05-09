// Tipo de servicio — 'normal' es el default histórico; los demás son envíos especiales
export type TipoServicio = 'normal' | 'terminal_bus' | 'compra_gestion' | 'cargotrans'

export const RECARGO_TERMINAL_BUS = 20  // C$ fijo sobre el delivery base

// Recargos adicionales por zonas especiales (sobre la tarifa base por distancia)
export type RecargoZona =
  | { aplica: false }
  | { aplica: true; monto: number; zona: string; tipo: 'zona_especial' }

// Mapa de zona normalizada → recargo en C$
const ZONAS_ESPECIALES: Record<string, number> = {
  'ciudad sandino': 30,
  'sabana grande': 30,
  'ticuantepe': 30,
  'ciudad doral - xiloa': 50,
}

function normalizar(s: string): string {
  return s
    .toLowerCase()
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .trim()
}

/**
 * Calcula el recargo por zona especial dado los nombres de zona de retiro y entrega.
 * Aplica el recargo mayor (no duplica ambos).
 */
export function calcularRecargoZona(
  zonaRetiro: string | null,
  zonaEntrega: string | null,
): RecargoZona {
  const montoRetiro = zonaRetiro ? (ZONAS_ESPECIALES[normalizar(zonaRetiro)] ?? 0) : 0
  const montoEntrega = zonaEntrega ? (ZONAS_ESPECIALES[normalizar(zonaEntrega)] ?? 0) : 0

  const monto = Math.max(montoRetiro, montoEntrega)
  if (monto === 0) return { aplica: false }

  const zona = montoRetiro >= montoEntrega ? (zonaRetiro ?? '') : (zonaEntrega ?? '')
  return { aplica: true, monto, zona, tipo: 'zona_especial' }
}
