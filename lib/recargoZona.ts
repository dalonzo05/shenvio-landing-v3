export type TipoServicio = 'normal' | 'fuera_managua' | 'compra_gestion'
export type MetodoFueraManagua = 'bus_terminal' | 'cargotrans'

export const RECARGO_TERMINAL_BUS = 20  // C$ fijo sobre el delivery base (bus/terminal)

// ── Base de terminales y sus destinos ──────────────────────────────────────
const TERMINALES_DB: { terminal: string; destinos: string[] }[] = [
  {
    terminal: 'Terminal Israel Lewites',
    destinos: ['León', 'Chinandega', 'Corinto', 'El Viejo', 'Chichigalpa'],
  },
  {
    terminal: 'Terminal UCA',
    destinos: ['Carazo', 'Diriamba', 'Jinotepe', 'San Marcos', 'Masaya', 'Granada', 'Nandaime'],
  },
  {
    terminal: 'Terminal Huembes',
    destinos: ['Rivas', 'San Juan del Sur', 'Peñas Blancas', 'Tola', 'Belén'],
  },
  {
    terminal: 'Terminal Mayoreo',
    destinos: [
      'Matagalpa', 'Jinotega', 'Estelí', 'Madriz', 'Somoto', 'Ocotal',
      'Nueva Segovia', 'Boaco', 'Juigalpa', 'Chontales', 'Acoyapa',
      'Río San Juan', 'San Carlos', 'El Rama',
    ],
  },
  {
    terminal: 'Terminal Costa Atlántico',
    destinos: ['Bluefields', 'Puerto Cabezas', 'Bilwi', 'RAAN', 'RAAS', 'Siuna', 'Rosita', 'Bonanza', 'Waspam'],
  },
]

// Lista de destinos disponibles para sugerencias de autocompletado
export const DESTINOS_FUERA_MANAGUA: string[] = [
  ...new Set(TERMINALES_DB.flatMap(t => t.destinos)),
].sort()

function normalizar(s: string): string {
  return s
    .toLowerCase()
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .trim()
}

/**
 * Dado un destino escrito por el comercio, sugiere la terminal de Managua
 * desde donde debería salir el paquete.
 */
export function sugerirTerminal(destino: string): string | null {
  if (!destino.trim()) return null
  const norm = normalizar(destino)
  for (const t of TERMINALES_DB) {
    if (t.destinos.some(d => {
      const dn = normalizar(d)
      return dn.includes(norm) || norm.includes(dn)
    })) {
      return t.terminal
    }
  }
  return null
}

// ── Recargos por zona especial (dentro de Managua) ─────────────────────────
export type RecargoZona =
  | { aplica: false }
  | { aplica: true; monto: number; zona: string; tipo: 'zona_especial' }

const ZONAS_ESPECIALES: Record<string, number> = {
  'ciudad sandino': 30,
  'sabana grande': 30,
  'ticuantepe': 30,
  'ciudad doral - xiloa': 50,
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
