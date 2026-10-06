// FIN-4C — identidad de la INTENCIÓN de abono (operacionId) y su ciclo de vida en la pantalla.
//
// La callable registrarAbonoDirecto es idempotente por `operacionId`, pero solo si la
// pantalla lo usa bien:
//
//   clic 1 → ID A → timeout (¿llegó a aplicarse?)
//   clic 2 → ID A        ← el MISMO: si ya se aplicó, el servidor responde 'ya_aplicado'
//
// Si el segundo clic generara un ID B, un abono que SÍ se aplicó se aplicaría dos veces.
// Y al revés: un abono nuevo y legítimo —aunque lleve el mismo monto— debe llevar un ID
// nuevo, o el servidor lo tomaría por un reintento.
//
// Reglas (todas puras, para poder probarlas):
//   1. Una intención NUEVA (no hay operación abierta para ese saldo) estrena ID.
//   2. Mientras el resultado sea INCIERTO (error temporal) la operación se conserva y
//      el reintento reusa el mismo ID.
//   3. Con un resultado DEFINITIVO (aplicado, ya aplicado o un rechazo del servidor) la
//      operación se cierra: lo siguiente es otra intención.
//   4. Cambiar de saldo, o cancelar el formulario, abandona la intención.

export interface OperacionAbono {
  saldoId: string
  operacionId: string
}

/** `op_` + 32 hex: cumple el formato que valida el servidor (16–64 de [A-Za-z0-9_-]). */
export function generarOperacionId(): string {
  const c = (globalThis as { crypto?: { randomUUID?: () => string; getRandomValues?: (a: Uint8Array) => Uint8Array } }).crypto
  if (c?.randomUUID) return 'op_' + c.randomUUID().replace(/-/g, '')
  const bytes = new Uint8Array(16)
  if (c?.getRandomValues) c.getRandomValues(bytes)
  else for (let i = 0; i < bytes.length; i++) bytes[i] = Math.floor(Math.random() * 256)
  return 'op_' + Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('')
}

/**
 * La operación de ESTE intento: la abierta si es del mismo saldo (reintento), o una
 * nueva (intención nueva). Nunca genera un ID nuevo para un reintento.
 */
export function obtenerOperacion(
  actual: OperacionAbono | null,
  saldoId: string,
  nuevoId: () => string = generarOperacionId,
): OperacionAbono {
  if (actual && actual.saldoId === saldoId) return actual
  return { saldoId, operacionId: nuevoId() }
}

/** ¿Hay que conservar la operación tras este resultado? Solo si es incierto. */
export function conservarOperacion(categoria: string): boolean {
  return categoria === 'temporal'
}
