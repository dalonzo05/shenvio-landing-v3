// DEPOSITOS-UX-TRAZABILIDAD-1 (v2) — Qué escribe cada transición de un
// depósito en las órdenes que agrupa.
//
// Invariante que el panel del motorizado, el de Depósitos y la ficha leen
// —siempre de la PROPIA orden, en cualquier pantalla—:
//
//   sin puntero, sin confirmar  → dinero pendiente de depositar
//   con puntero, sin confirmar  → depósito enviado, en revisión
//   confirmadoX                 → cerrado (confirmado o convertido en deuda)
//
// Cuatro flujos lo rompían:
//
//   · el digitador registraba el depósito sin enlazar las órdenes: seguían
//     "pendientes" y el mismo dinero se podía volver a depositar;
//   · "Rehacer" y "revertir conversión con boucher" devolvían el depósito a
//     revisión dejando confirmadoX = true: la orden seguía "cerrada";
//   · "Eliminar" borraba el documento dejando el puntero y el flag: la orden
//     afirmaba un depósito confirmado que ya no existe.
//
// Estos helpers devuelven SOLO los campos de la orden, con rutas de
// Firestore. No deciden ledger ni estados del documento de depósito: eso lo
// sigue haciendo cada flujo, sin cambios.
//
// PURO: sin Firestore, sin React, sin efectos.

import type { DestinoDeposito } from './deposito-orden'

interface Claves {
  id: string
  confirmado: string
  confirmadoAt: string
}

export function clavesDeposito(destino: DestinoDeposito): Claves {
  return destino === 'storkhub'
    ? {
        id: 'registro.deposito.storkhubDepositoId',
        confirmado: 'registro.deposito.confirmadoStorkhub',
        confirmadoAt: 'registro.deposito.confirmadoStorkhubAt',
      }
    : {
        id: 'registro.deposito.comercioDepositoId',
        confirmado: 'registro.deposito.confirmadoComercio',
        confirmadoAt: 'registro.deposito.confirmadoComercioAt',
      }
}

/**
 * El digitador registró un depósito en revisión: la orden queda ENLAZADA.
 * Solo el puntero — nunca la confirmación, que sigue siendo del gestor.
 */
export function camposEnlaceDigitacion(destino: DestinoDeposito, depositoId: string): Record<string, string> {
  return { [clavesDeposito(destino).id]: depositoId }
}

/**
 * El depósito vuelve a revisión ("Rehacer", o revertir una conversión en
 * deuda que tenía boucher). El puntero se conserva —el depósito sigue
 * existiendo y sigue siendo de estas órdenes— y la confirmación se retira:
 * la orden ya no puede afirmar que ese destino está cerrado.
 *
 * Mismos valores que ya escribe devolverAlMotorizado para "no confirmado"
 * (false / null). El documento de depósito conserva su historial.
 */
export function camposReaperturaRevision(destino: DestinoDeposito, depositoId: string): Record<string, string | boolean | null> {
  const k = clavesDeposito(destino)
  return { [k.id]: depositoId, [k.confirmado]: false, [k.confirmadoAt]: null }
}

/**
 * El depósito dejó de existir (eliminado por admin): la orden se libera, igual
 * que devolverAlMotorizado. Si la obligación sigue viva, vuelve a pendiente.
 */
export function camposLiberacionDeposito(destino: DestinoDeposito): Record<string, boolean | null> {
  const k = clavesDeposito(destino)
  return { [k.id]: null, [k.confirmado]: false, [k.confirmadoAt]: null }
}

/**
 * ¿Se puede liberar la orden al eliminar este depósito sin romper otra
 * verdad financiera?
 *
 * Un depósito convertido en deuda tiene su saldo en saldos_cargo_motorizado,
 * que eliminar el depósito NO anula: liberar la orden haría que el
 * motorizado debiera el mismo dinero dos veces — como deuda y como depósito
 * pendiente. Ese caso se deja como estaba (deuda DEPOSITO-BORRADO-FISICO).
 */
export function eliminarLiberaOrdenes(estado: string | null | undefined): boolean {
  return estado !== 'convertido_en_deuda'
}
