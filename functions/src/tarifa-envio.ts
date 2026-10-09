// PRECIO-CONFIRMADO-ANTES-DE-OPERAR-1 — la tarifa del delivery por distancia, UNA sola fórmula pura.
//
// Antes estaba copiada a mano en la calculadora, en Solicitar (comercio) y en Ingresar orden (gestor); el servidor no tenía ninguna. Ahora el cliente la usa
// para el PREVIEW y las Functions la usan como autoridad: este archivo y functions/src/tarifa-envio.ts son byte a byte el mismo (lib/tarifa-envio.test.ts
// lo comprueba). Cambiar la tarifa es cambiar los DOS archivos.
//
// Es solo la tarifa BASE (deliveryBase). Los recargos (zona, terminal) no entran: el precio final puede incluirlos, la base de la comisión no.

/** Límite superior (km, exclusivo) → precio base en córdobas. */
export const TRAMOS_TARIFA: ReadonlyArray<readonly [number, number]> = [
  [2, 70], [4, 80], [6, 90], [8, 110], [10, 120], [12, 130],
  [14, 150], [16, 160], [18, 180], [20, 190], [22, 210], [24, 220],
  [26, 240], [28, 250], [30, 270], [32, 280], [34, 300], [36, 310],
  [38, 330], [40, 340], [42, 360], [44, 370], [46, 390], [48, 400],
  [50, 420], [52, 430], [54, 440],
]

/** Tarifa base para una distancia en km; -1 si la distancia excede el tarifario (o no es un número). */
export function tarifa(km: number): number {
  for (const [limite, precio] of TRAMOS_TARIFA) if (km < limite) return precio
  return -1
}
