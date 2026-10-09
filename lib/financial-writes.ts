import {
  doc,
  serverTimestamp,
  setDoc,
  updateDoc,
} from 'firebase/firestore'
import { db } from '@/fb/config'
import type {
  MetodoAbono,
  PropuestaAbonoSaldo,
} from './financial-types'

// ─── Reglas de timestamps ─────────────────────────────────────────────────────
//
// 1. serverTimestamp()   → siempre para campos top-level en addDoc/updateDoc/setDoc
//                          (at, createdAt, updatedAt, confirmadoAt, etc.)
// 2. Timestamp.fromDate() → solo cuando el usuario ingresa una fecha retroactiva
//                          (ej: fecha del gasto en un formulario con input date)
// 3. Timestamp.now()      → SOLO dentro de objetos que van a arrayUnion().
//                          Firebase SDK rechaza serverTimestamp() en datos anidados
//                          de arrayUnion. No usar Timestamp.now() en ningún otro caso.
//
// ─────────────────────────────────────────────────────────────────────────────

// FIN-1E — registrarMovimiento YA NO VIVE AQUÍ. Era el addDoc de cliente al ledger (movimientos_financieros) y ya no tenía ningún llamador: las Rules cierran
// create, update y delete del ledger a todo cliente. Todo movimiento lo escribe una Cloud Function (Admin SDK) en la misma transacción que el hecho que registra.

// ─── Gastos operativos ────────────────────────────────────────────────────────

// FIN-1C-B — crearGastoMotorizado y anularGastoMotorizado YA NO VIVEN AQUÍ. Crear un gasto era un addDoc de cliente más un movimiento que tragaba
// sus errores, y anularlo era un updateDoc ciego: se podía anular (o crear con cualquier monto) un gasto ya descontado en un depósito. Ahora las hacen
// las Cloud Functions crearGastoMotorizado y anularGastoMotorizado en una transacción (functions/src/crear-gasto.ts y anular-gasto.ts). El cliente las
// invoca con lib/crear-gasto-cliente.ts y lib/anular-gasto-cliente.ts y no escribe nada de eso por su cuenta.

// ─── Saldos a cargo del motorizado ────────────────────────────────────────────

// FIN-1D — crearSaldoCargo YA NO VIVE AQUÍ. Lo llamaba marcarPagada (saldo por faltante de una liquidación, sin movimiento de ledger y duplicable con un doble
// clic). El saldo del neto negativo nace ahora al CREAR la liquidación, en la misma transacción que la liquidación y su movimiento saldo_creado: lo hace la Cloud
// Function crearLiquidacionMotorizado (functions/src/crear-liquidacion.ts). Las Rules ya no dejan a ningún cliente crear ni mover un saldo.

// FIN-4C — registrarAbonoSaldo YA NO VIVE AQUÍ. El abono directo del gestor/admin (saldo +
// historial de abonos + ledger) lo hace la Cloud Function registrarAbonoDirecto en una sola
// transacción, con el monto validado contra el saldo real, el estado protegido, el actor y la
// cuenta derivados en el servidor y un operacionId idempotente: functions/src/abono-directo.ts.
// El cliente la invoca con lib/abono-directo-cliente.ts y no escribe nada de eso por su cuenta.
// El abono por liquidación (crearLiquidacion) y la propuesta de abono (digitador) tienen sus
// propios caminos y no pasan por aquí.

// FIN-1A — anularSaldoCargo YA NO VIVE AQUÍ. Era un updateDoc ciego ({ estado: 'anulado', nota: '' }): no leía nada, pisaba la
// nota y anulaba saldos con abonos o de depósito dejando su ledger vivo. La anulación (solo una deuda manual virgen cuyo
// movimiento saldo_creado se demuestra) la hace la Cloud Function anularSaldoCargo en una transacción:
// functions/src/anulacion-saldo.ts. El cliente la invoca con lib/anular-saldo-cliente.ts.

// ─── Convertir depósito pendiente en deuda ────────────────────────────────────
//
// FIN-4A — convertirDepositoEnDeuda YA NO VIVE AQUÍ. La conversión de un depósito
// en deuda (saldo + depósito + órdenes + ledger) la hace la Cloud Function
// convertirDepositoEnDeuda en una sola transacción: functions/src/conversion-
// deposito-deuda.ts. El cliente la invoca con lib/convertir-deposito-cliente.ts y
// no escribe nada de eso por su cuenta.

// FIN-1A — registrarAdelanto se retiró: no tenía ningún caller y arrastraba un saldo 'adelanto' cuyo ledger no se enlaza al saldo.

// ─── Revertir conversión en deuda ────────────────────────────────────────────
//
// FIN-4B — revertirConversionEnDeuda YA NO VIVE AQUÍ. La reversión de una conversión a deuda (saldo,
// depósito, movimiento, evento y órdenes) la hace la Cloud Function revertirConversionEnDeuda en UNA
// transacción y solo sobre una deuda virgen: functions/src/reversion-conversion.ts. El cliente la invoca con
// lib/revertir-conversion-cliente.ts y no escribe nada de eso por su cuenta. Las Rules ya no dejan a ningún
// cliente sacar un depósito de 'convertido_en_deuda'.

// ─── Condonar deuda del motorizado ───────────────────────────────────────────
//
// FIN-1A — condonarDeudaMotorizado YA NO VIVE AQUÍ. Era una transacción de cliente que recibía de la pantalla el monto, el
// motorizado y el actor. La condonación (siempre el remanente releído, sin tocar los abonos, con un único movimiento
// deuda_condonada y el rol real del actor) la hace la Cloud Function condonarDeudaMotorizado en una transacción:
// functions/src/condonacion-deuda.ts. El cliente la invoca con lib/condonar-deuda-cliente.ts.

// ─── Propuestas de abono (DIGITADOR V1 — doble control, D3) ──────────────────
//
// Estas dos funciones son las ÚNICAS escrituras de cliente sobre
// propuestas_abono_saldo. Confirmar/rechazar NO están acá — son exclusivas
// de confirmarPropuestaAbono/rechazarPropuestaAbono (Cloud Functions, Admin
// SDK), que aplican el efecto contable real. Ver DIGITADOR V1, secciones
// 12-14 y functions/src/propuestas-abono.ts.

/**
 * Registra una propuesta de abono pendiente de revisión SIN comprobante
 * (métodos que no lo requieren — ver METODOS_REQUIEREN_COMPROBANTE en
 * saldos/page.tsx). NO toca saldos_cargo_motorizado ni
 * movimientos_financieros — eso ocurre solo si un Gestor/Admin la confirma
 * después.
 *
 * STORAGE ORPHANS BLOQUE 1: propuestaId ahora lo genera y provee el
 * llamador (antes esta función usaba addDoc con un id propio, DISTINTO del
 * que el llamador ya había generado para el path de Storage cuando SÍ había
 * comprobante — un desajuste real entre el id del documento y el segmento
 * de carpeta en Storage). Cuando el método requiere comprobante, usar
 * crearPropuestaAbonoPendienteComprobante + completarComprobantePropuesta
 * en su lugar — ver esas dos funciones más abajo.
 */
export async function crearPropuestaAbono(params: {
  propuestaId: string
  saldoId: string
  motorizadoId: string
  motorizadoUid: string
  motorizadoNombre: string
  monto: number
  metodoAbono: MetodoAbono
  nota?: string
  operadorId: string
  comprobanteUrl?: string
  comprobantePath?: string
}): Promise<void> {
  const {
    propuestaId, saldoId, motorizadoId, motorizadoUid, motorizadoNombre, monto, metodoAbono,
    nota, operadorId, comprobanteUrl, comprobantePath,
  } = params

  const propuesta: Omit<PropuestaAbonoSaldo, 'id'> = {
    saldoId,
    motorizadoId,
    motorizadoUid,
    motorizadoNombre,
    monto,
    metodoAbono,
    ...(nota ? { nota } : {}),
    ...(comprobanteUrl ? { comprobanteUrl } : {}),
    ...(comprobantePath ? { comprobantePath } : {}),
    estado: 'pendiente',
    digitadoPorUid: operadorId,
    digitadoAt: serverTimestamp(),
  }

  await setDoc(doc(db, 'propuestas_abono_saldo', propuestaId), propuesta)
}

/**
 * Crea el documento de una propuesta ANTES de subir el comprobante —
 * STORAGE ORPHANS BLOQUE 1. El doc nace en 'pendiente_comprobante' (nunca
 * 'pendiente' — ese estado significa "lista para revisión" y el Gestor
 * actúa sobre él; un doc sin comprobante real nunca debe aparecer ahí). El
 * llamador debe generar propuestaId ANTES de llamar a esta función y
 * reutilizarlo tanto acá como en el upload a Storage
 * (saldos/{saldoId}/propuestas/{propuestaId}/comprobante.jpg) — así un
 * reintento tras un fallo de upload reutiliza el mismo path en vez de
 * generar uno nuevo cada vez.
 */
export async function crearPropuestaAbonoPendienteComprobante(params: {
  propuestaId: string
  saldoId: string
  motorizadoId: string
  motorizadoUid: string
  motorizadoNombre: string
  monto: number
  metodoAbono: MetodoAbono
  nota?: string
  operadorId: string
}): Promise<void> {
  const { propuestaId, saldoId, motorizadoId, motorizadoUid, motorizadoNombre, monto, metodoAbono, nota, operadorId } = params

  const propuesta: Omit<PropuestaAbonoSaldo, 'id'> = {
    saldoId,
    motorizadoId,
    motorizadoUid,
    motorizadoNombre,
    monto,
    metodoAbono,
    ...(nota ? { nota } : {}),
    estado: 'pendiente_comprobante',
    digitadoPorUid: operadorId,
    digitadoAt: serverTimestamp(),
  }

  await setDoc(doc(db, 'propuestas_abono_saldo', propuestaId), propuesta)
}

/**
 * Completa una propuesta 'pendiente_comprobante' con el comprobante ya
 * subido y la transiciona a 'pendiente' (recién ahí queda visible para el
 * Gestor). Boucher y transición en la MISMA escritura, nunca uno sin el
 * otro — mismo criterio que digitarDepositoStorkhub en depositos/page.tsx.
 */
export async function completarComprobantePropuesta(
  propuestaId: string,
  comprobante: { comprobanteUrl: string; comprobantePath: string }
): Promise<void> {
  await updateDoc(doc(db, 'propuestas_abono_saldo', propuestaId), {
    comprobanteUrl: comprobante.comprobanteUrl,
    comprobantePath: comprobante.comprobantePath,
    estado: 'pendiente',
  })
}

/**
 * Corrige una propuesta propia MIENTRAS sigue pendiente (D2). Firestore
 * Rules son las que realmente exigen ownership y estado — este helper solo
 * evita mandar campos fuera de la allowlist por accidente.
 */
export async function corregirPropuestaAbono(
  propuestaId: string,
  patch: {
    monto?: number
    metodoAbono?: MetodoAbono
    nota?: string
    comprobanteUrl?: string
    comprobantePath?: string
  }
): Promise<void> {
  await updateDoc(doc(db, 'propuestas_abono_saldo', propuestaId), { ...patch })
}
