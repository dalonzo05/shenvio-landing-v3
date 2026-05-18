import {
  addDoc,
  collection,
  doc,
  serverTimestamp,
  updateDoc,
  writeBatch,
  arrayUnion,
  Timestamp,
} from 'firebase/firestore'
import { db } from '@/fb/config'
import type {
  MovimientoFinanciero,
  TipoMovimiento,
  TipoGasto,
  GastoMotorizado,
  TipoSaldo,
  SaldoCargoMotorizado,
  AbonoSaldo,
  OrigenSaldo,
} from './financial-types'

/**
 * Registra un evento financiero en la colección movimientos_financieros.
 * Solo gestor/admin puede leer esta colección (ver firestore.rules).
 *
 * Esta función nunca lanza — los errores se logean en consola sin interrumpir
 * la operación principal del llamador.
 *
 * @returns ID del documento creado, o null si hubo error
 */
export async function registrarMovimiento(
  tipo: TipoMovimiento,
  monto: number,
  operadorId: string,
  descripcion: string,
  refs?: Pick<MovimientoFinanciero, 'solicitudId' | 'depositoId' | 'motorizadoId' | 'comercioId' | 'saldoId' | 'gastoId'>,
  metadata?: Record<string, unknown>
): Promise<string | null> {
  try {
    const docRef = await addDoc(collection(db, 'movimientos_financieros'), {
      tipo,
      monto,
      at: serverTimestamp(),
      operadorId,
      descripcion,
      ...(refs ?? {}),
      ...(metadata ? { metadata } : {}),
    } satisfies Omit<MovimientoFinanciero, 'id'>)
    return docRef.id
  } catch (err) {
    console.error('[financial-writes] Error registrando movimiento:', err)
    return null
  }
}

// ─── Gastos operativos ────────────────────────────────────────────────────────

/**
 * Crea un gasto operativo para un motorizado.
 * Solo gestor/admin puede llamar esto.
 * Los gastos nacen directamente como 'aprobado'.
 */
export async function crearGastoMotorizado(params: {
  motorizadoId: string
  motorizadoNombre: string
  tipo: TipoGasto
  monto: number
  nota?: string
  ordenId?: string
  ordenSnapshot?: import('./financial-types').OrdenSnapshot
  operadorId: string
  fecha?: Date
}): Promise<string> {
  const { motorizadoId, motorizadoNombre, tipo, monto, nota, ordenId, ordenSnapshot, operadorId, fecha } = params

  const gastoData: Omit<GastoMotorizado, 'id'> = {
    motorizadoId,
    motorizadoNombre,
    tipo,
    monto,
    estado: 'aprobado',
    nota: nota || '',
    ...(ordenId ? { ordenId } : {}),
    ...(ordenSnapshot ? { ordenSnapshot } : {}),
    fecha: fecha ? Timestamp.fromDate(fecha) : serverTimestamp(),
    creadoPorUid: operadorId,
    createdAt: serverTimestamp(),
  }

  const ref = await addDoc(collection(db, 'gastos_motorizado'), gastoData)

  await registrarMovimiento(
    'gasto_aprobado',
    monto,
    operadorId,
    `Gasto ${tipo} · ${motorizadoNombre}`,
    { motorizadoId, gastoId: ref.id, ...(ordenId ? { solicitudId: ordenId } : {}) }
  )

  return ref.id
}

/**
 * Anula un gasto operativo existente.
 */
export async function anularGastoMotorizado(
  gastoId: string,
  operadorId: string
): Promise<void> {
  await updateDoc(doc(db, 'gastos_motorizado', gastoId), {
    estado: 'anulado',
    updatedAt: serverTimestamp(),
  })
}

// ─── Saldos a cargo del motorizado ────────────────────────────────────────────

/**
 * Crea un nuevo saldo a cargo del motorizado.
 * Usado para adelantos, depósitos no realizados, ajustes manuales.
 */
export async function crearSaldoCargo(params: {
  motorizadoId: string
  motorizadoUid: string
  motorizadoNombre: string
  tipo: TipoSaldo
  monto: number
  origen: OrigenSaldo
  depositoId?: string
  liquidacionId?: string
  nota?: string
  operadorId: string
  fecha?: Date
}): Promise<string> {
  const {
    motorizadoId, motorizadoUid, motorizadoNombre, tipo, monto, origen,
    depositoId, liquidacionId, nota, operadorId, fecha,
  } = params

  const saldoData: Omit<SaldoCargoMotorizado, 'id'> = {
    motorizadoId,
    motorizadoUid,
    motorizadoNombre,
    tipo,
    montoOriginal: monto,
    saldoPendiente: monto,
    estado: 'pendiente',
    origen,
    ...(depositoId ? { depositoId } : {}),
    ...(liquidacionId ? { liquidacionId } : {}),
    fecha: fecha ? Timestamp.fromDate(fecha) : serverTimestamp(),
    nota: nota || '',
    creadoPorUid: operadorId,
    createdAt: serverTimestamp(),
    abonos: [],
  }

  const ref = await addDoc(collection(db, 'saldos_cargo_motorizado'), saldoData)

  await registrarMovimiento(
    'saldo_creado',
    monto,
    operadorId,
    `Saldo a cargo (${tipo}) · ${motorizadoNombre}`,
    { motorizadoId, saldoId: ref.id, ...(depositoId ? { depositoId } : {}) }
  )

  return ref.id
}

/**
 * Registra un abono (pago parcial o total) a un saldo a cargo.
 */
export async function registrarAbonoSaldo(params: {
  saldoId: string
  montoAbono: number
  saldoPendienteActual: number
  metodo?: string
  nota?: string
  operadorId: string
  motorizadoId: string
  motorizadoNombre: string
}): Promise<void> {
  const {
    saldoId, montoAbono, saldoPendienteActual, metodo, nota, operadorId,
    motorizadoId, motorizadoNombre,
  } = params

  const nuevoSaldo = Math.max(0, saldoPendienteActual - montoAbono)
  const nuevoEstado = nuevoSaldo <= 0 ? 'pagado' : 'abonado_parcial'

  const abono: AbonoSaldo = {
    monto: montoAbono,
    fecha: serverTimestamp(),
    metodo: metodo || 'efectivo',
    nota: nota || '',
    creadoPorUid: operadorId,
  }

  await updateDoc(doc(db, 'saldos_cargo_motorizado', saldoId), {
    saldoPendiente: nuevoSaldo,
    estado: nuevoEstado,
    abonos: arrayUnion(abono),
    updatedAt: serverTimestamp(),
  })

  await registrarMovimiento(
    'abono_saldo',
    montoAbono,
    operadorId,
    `Abono saldo · ${motorizadoNombre}`,
    { motorizadoId, saldoId }
  )
}

/**
 * Anula un saldo a cargo del motorizado.
 */
export async function anularSaldoCargo(
  saldoId: string,
  operadorId: string,
  nota?: string
): Promise<void> {
  await updateDoc(doc(db, 'saldos_cargo_motorizado', saldoId), {
    estado: 'anulado',
    nota: nota || '',
    updatedAt: serverTimestamp(),
  })
}

// ─── Convertir depósito pendiente en deuda ────────────────────────────────────

/**
 * Convierte un depósito pendiente en un saldo a cargo del motorizado.
 *
 * Reglas:
 * - Marca el depósito como `convertido_en_deuda` en ordenes_deposito
 * - Marca las solicitudes como confirmadas en Storkhub para sacarlas de pendientes
 * - Crea un SaldoCargoMotorizado de tipo 'deposito_no_realizado'
 * - Registra movimiento de auditoría
 */
export async function convertirDepositoEnDeuda(params: {
  depositoId: string
  solicitudIds: string[]
  destinatario: 'storkhub' | 'comercio'
  monto: number
  motorizadoId: string
  motorizadoUid: string
  motorizadoNombre: string
  nota: string
  operadorId: string
}): Promise<string> {
  const {
    depositoId, solicitudIds, destinatario, monto,
    motorizadoId, motorizadoUid, motorizadoNombre, nota, operadorId,
  } = params

  const b = writeBatch(db)

  // 1. Marcar el depósito como convertido_en_deuda
  b.update(doc(db, 'ordenes_deposito', depositoId), {
    estado: 'convertido_en_deuda',
    confirmadoGestor: true,
    confirmadoGestorAt: serverTimestamp(),
    confirmadoGestorUid: operadorId,
    notaConversion: nota,
  })

  // 2. Marcar las solicitudes como "depósito confirmado" para sacarlas de pendientes
  const fieldKey = destinatario === 'storkhub'
    ? 'registro.deposito.confirmadoStorkhub'
    : 'registro.deposito.confirmadoComercio'
  const atKey = destinatario === 'storkhub'
    ? 'registro.deposito.confirmadoStorkhubAt'
    : 'registro.deposito.confirmadoComercioAt'
  const idKey = destinatario === 'storkhub'
    ? 'registro.deposito.storkhubDepositoId'
    : 'registro.deposito.comercioDepositoId'

  solicitudIds.forEach((sid) => {
    b.update(doc(db, 'solicitudes_envio', sid), {
      [fieldKey]: true,
      [atKey]: serverTimestamp(),
      [idKey]: depositoId,
    })
  })

  await b.commit()

  // 3. Crear el saldo a cargo
  const saldoId = await crearSaldoCargo({
    motorizadoId,
    motorizadoUid,
    motorizadoNombre,
    tipo: 'deposito_no_realizado',
    monto,
    origen: 'deposito',
    depositoId,
    nota,
    operadorId,
  })

  // 4. Auditoría
  await registrarMovimiento(
    'deposito_convertido_en_deuda',
    monto,
    operadorId,
    `Depósito convertido en deuda · ${motorizadoNombre} · ${nota}`,
    { motorizadoId, depositoId, saldoId }
  )

  return saldoId
}

// ─── Adelantos ────────────────────────────────────────────────────────────────

/**
 * Registra un adelanto al motorizado.
 * Crea un movimiento financiero y un saldo a cargo de tipo 'adelanto'.
 */
export async function registrarAdelanto(params: {
  motorizadoId: string
  motorizadoUid: string
  motorizadoNombre: string
  monto: number
  semanaKey: string
  nota?: string
  operadorId: string
}): Promise<{ movimientoId: string | null; saldoId: string }> {
  const { motorizadoId, motorizadoUid, motorizadoNombre, monto, semanaKey, nota, operadorId } = params

  // Registrar como movimiento financiero (para compatibilidad con liquidaciones actuales)
  const movimientoId = await registrarMovimiento(
    'adelanto_motorizado',
    monto,
    operadorId,
    `Adelanto C$${monto} · ${motorizadoNombre} · Sem ${semanaKey}`,
    { motorizadoId }
  )

  // Crear saldo a cargo de tipo adelanto
  const saldoId = await crearSaldoCargo({
    motorizadoId,
    motorizadoUid,
    motorizadoNombre,
    tipo: 'adelanto',
    monto,
    origen: 'manual',
    nota: nota || `Adelanto semana ${semanaKey}`,
    operadorId,
  })

  return { movimientoId, saldoId }
}
