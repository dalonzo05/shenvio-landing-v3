import {
  addDoc,
  collection,
  deleteField,
  doc,
  getDoc,
  getDocs,
  query,
  serverTimestamp,
  updateDoc,
  where,
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
  PropietarioEfectivo,
} from './financial-types'
import { cuentas } from './financial-types'

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

// ─── Tipos auxiliares ─────────────────────────────────────────────────────────

type Cuentas = {
  origen: string
  destino: string
}

type RefsMovimiento = Pick<
  MovimientoFinanciero,
  'solicitudId' | 'depositoId' | 'motorizadoId' | 'comercioId' | 'saldoId' | 'gastoId' | 'liquidacionId'
>

// ─── Registrar movimiento ─────────────────────────────────────────────────────

/**
 * Registra un evento financiero en el ledger (movimientos_financieros).
 * Solo gestor/admin puede leer esta colección.
 *
 * Estrategia Fase 1: el ledger es auditoría enriquecida.
 * Las cuentas (origen/destino) son opcionales mientras se migra gradualmente.
 * A partir de Fase 4, todas las escrituras deben incluirlas.
 *
 * Esta función nunca lanza — los errores se logean sin interrumpir al llamador.
 * @returns ID del documento creado, o null si hubo error
 */
export async function registrarMovimiento(
  tipo: TipoMovimiento,
  monto: number,
  operadorId: string,
  descripcion: string,
  refs?: Partial<RefsMovimiento>,
  opciones?: {
    cuentas?: Cuentas
    propietario?: PropietarioEfectivo
    semanaKey?: string
    metadata?: Record<string, unknown>
    rol?: MovimientoFinanciero['creadoPorRol']
  }
): Promise<string | null> {
  try {
    const payload: Omit<MovimientoFinanciero, 'id'> = {
      tipo,
      monto,
      at: serverTimestamp(),
      creadoPorUid: operadorId,
      creadoPorRol: opciones?.rol ?? 'gestor',
      descripcion,
      estado: 'activo',
      ...(refs ?? {}),
      ...(opciones?.cuentas ? {
        cuentaOrigen: opciones.cuentas.origen,
        cuentaDestino: opciones.cuentas.destino,
      } : {}),
      ...(opciones?.propietario ? { propietario: opciones.propietario } : {}),
      ...(opciones?.semanaKey ? { semanaKey: opciones.semanaKey } : {}),
      ...(opciones?.metadata ? { metadata: opciones.metadata } : {}),
    }

    const docRef = await addDoc(collection(db, 'movimientos_financieros'), payload)
    return docRef.id
  } catch (err) {
    console.error('[financial-writes] Error registrando movimiento:', err)
    return null
  }
}

// ─── Gastos operativos ────────────────────────────────────────────────────────

/**
 * Crea un gasto operativo para un motorizado.
 * Solo gestor puede llamar esto. Los gastos nacen como 'aprobado'.
 *
 * Cuenta origen varía por tipo:
 * - peaje_terminal: efectivo_en_poder (motorizado pagó en efectivo)
 * - pago_cargotrans: puede ser externo (comercio pagó) o efectivo_en_poder
 * - otro_gasto_operativo: efectivo_en_poder
 * destino siempre: gastos_operativos
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
    nota: nota ?? '',
    ...(ordenId ? { ordenId } : {}),
    ...(ordenSnapshot ? { ordenSnapshot } : {}),
    // fecha es el momento del gasto (puede ser ingresado por el gestor retroactivamente)
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
    { motorizadoId, gastoId: ref.id, ...(ordenId ? { solicitudId: ordenId } : {}) },
    {
      cuentas: {
        origen: cuentas.efectivoEnPoder(motorizadoId),
        destino: cuentas.gastosOp,
      },
    }
  )

  return ref.id
}

/**
 * Anula un gasto operativo existente y sus movimientos del ledger.
 *
 * 1. Marca el documento en `gastos_motorizado` como anulado.
 * 2. Busca todos los movimientos en `movimientos_financieros` que referencian
 *    este gastoId y los marca como anulados (batch).
 *
 * Ambas operaciones deben ocurrir juntas para mantener consistencia entre
 * la colección operativa y el ledger financiero.
 */
export async function anularGastoMotorizado(
  gastoId: string,
  operadorId: string
): Promise<void> {
  // 1. Anular el gasto en la colección operativa
  await updateDoc(doc(db, 'gastos_motorizado', gastoId), {
    estado: 'anulado',
    updatedAt: serverTimestamp(),
  })

  // 2. Anular los movimientos del ledger vinculados por gastoId
  const snap = await getDocs(
    query(collection(db, 'movimientos_financieros'), where('gastoId', '==', gastoId))
  )
  const activos = snap.docs.filter((d) => (d.data() as any).estado !== 'anulado')
  if (activos.length > 0) {
    const batch = writeBatch(db)
    activos.forEach((d) => {
      batch.update(d.ref, {
        estado: 'anulado',
        anuladoAt: serverTimestamp(),
        anuladoPorUid: operadorId,
        motivoAnulacion: 'Gasto operativo anulado',
      })
    })
    await batch.commit()
  }
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
    nota: nota ?? '',
    creadoPorUid: operadorId,
    createdAt: serverTimestamp(),
    abonos: [],
  }

  const ref = await addDoc(collection(db, 'saldos_cargo_motorizado'), saldoData)

  // 'deposito_no_realizado' NO emite movimiento de ledger aquí.
  // El movimiento ya fue registrado por el llamador (convertirDepositoEnDeuda)
  // como 'deposito_convertido_en_deuda': efectivo_en_poder → deuda_motorizado.
  // Emitir un segundo movimiento (deuda_motorizado → banco) sería incorrecto:
  // cancelaría la deuda y registraría un ingreso bancario que nunca ocurrió.
  if (tipo !== 'deposito_no_realizado') {
    const cuentasMovimiento: Cuentas | undefined =
      tipo === 'adelanto'
        ? { origen: cuentas.efectivoEnPoder(motorizadoId), destino: cuentas.deudaMotorizado(motorizadoId) }
        : undefined // ajuste_manual y otro no tienen cuentas predefinidas

    await registrarMovimiento(
      'saldo_creado',
      monto,
      operadorId,
      `Saldo a cargo (${tipo}) · ${motorizadoNombre}`,
      { motorizadoId, saldoId: ref.id, ...(depositoId ? { depositoId } : {}) },
      { cuentas: cuentasMovimiento }
    )
  }

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
  comprobanteUrl?: string
  comprobantePath?: string
}): Promise<void> {
  const {
    saldoId, montoAbono, saldoPendienteActual, metodo, nota, operadorId,
    motorizadoId, motorizadoNombre, comprobanteUrl, comprobantePath,
  } = params

  const nuevoSaldo = Math.max(0, saldoPendienteActual - montoAbono)
  const nuevoEstado = nuevoSaldo <= 0 ? 'pagado' : 'abonado_parcial'

  const abono: AbonoSaldo = {
    monto: montoAbono,
    fecha: Timestamp.now(), // serverTimestamp() no puede usarse dentro de arrayUnion()
    metodo: metodo ?? 'efectivo',
    nota: nota ?? '',
    creadoPorUid: operadorId,
    ...(comprobanteUrl ? { comprobanteUrl } : {}),
    ...(comprobantePath ? { comprobantePath } : {}),
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
    { motorizadoId, saldoId },
    {
      cuentas: {
        origen: cuentas.comisionPendiente(motorizadoId),
        destino: cuentas.deudaMotorizado(motorizadoId),
      },
    }
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
    nota: nota ?? '',
    updatedAt: serverTimestamp(),
  })
}

// ─── Convertir depósito pendiente en deuda ────────────────────────────────────

/**
 * Convierte un depósito pendiente en un saldo a cargo del motorizado.
 *
 * - Marca el depósito como `convertido_en_deuda` en ordenes_deposito
 * - Marca las solicitudes como confirmadas (para sacarlas de pendientes)
 * - Crea un SaldoCargoMotorizado de tipo 'deposito_no_realizado'
 * - Registra movimiento en el ledger
 *
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
    notaConversion: nota,
    updatedAt: serverTimestamp(),
  })

  // 2. Marcar las solicitudes como "depósito gestionado" para sacarlas de pendientes
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

  // 3. Crear el saldo a cargo (genera su propio movimiento interno)
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

  // Referenciar saldoId en ordenes_deposito para mostrar en historial
  await updateDoc(doc(db, 'ordenes_deposito', depositoId), { saldoId })

  // 4. Movimiento de auditoría enriquecido
  await registrarMovimiento(
    'deposito_convertido_en_deuda',
    monto,
    operadorId,
    `Depósito convertido en deuda · ${motorizadoNombre} · ${nota}`,
    { motorizadoId, depositoId, saldoId },
    {
      cuentas: {
        origen: cuentas.efectivoEnPoder(motorizadoId),
        destino: cuentas.deudaMotorizado(motorizadoId),
      },
      propietario: destinatario === 'storkhub' ? 'storkhub' : undefined,
    }
  )

  return saldoId
}

// ─── Adelantos ────────────────────────────────────────────────────────────────

/**
 * Registra un adelanto al motorizado.
 * Crea un movimiento financiero y un saldo a cargo de tipo 'adelanto'.
 *
 * Flujo contable:
 * StorkHub entrega efectivo al motorizado → efectivo_en_poder (owner: motorizado)
 * Se crea deuda → deuda_motorizado
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

  const movimientoId = await registrarMovimiento(
    'adelanto_motorizado',
    monto,
    operadorId,
    `Adelanto C$${monto} · ${motorizadoNombre} · Sem ${semanaKey}`,
    { motorizadoId },
    {
      semanaKey,
      cuentas: {
        // StorkHub desembolsa → entra a efectivo_en_poder del motorizado
        // La propiedad de ese efectivo es del motorizado (su anticipo de comisión)
        origen: cuentas.ingresos,
        destino: cuentas.efectivoEnPoder(motorizadoId),
      },
      propietario: `motorizado:${motorizadoId}`,
    }
  )

  // El adelanto genera deuda automáticamente
  const saldoId = await crearSaldoCargo({
    motorizadoId,
    motorizadoUid,
    motorizadoNombre,
    tipo: 'adelanto',
    monto,
    origen: 'manual',
    nota: nota ?? `Adelanto semana ${semanaKey}`,
    operadorId,
  })

  return { movimientoId, saldoId }
}

// ─── Revertir conversión en deuda (depósito convertido por error) ─────────────

/**
 * Revierte completamente una conversión de depósito en deuda.
 * Usar cuando el gestor convirtió por error.
 *
 * - Anula saldo_cargo_motorizado
 * - Restaura ordenes_deposito a 'en_revision'
 * - Limpia confirmación en solicitudes_envio → vuelven a aparecer como pendientes
 * - Anula el movimiento deposito_convertido_en_deuda del ledger → deuda = C$0
 */
export async function revertirConversionEnDeuda(params: {
  saldoId: string
  depositoId: string
  operadorId: string
}): Promise<void> {
  const { saldoId, depositoId, operadorId } = params

  // Leer el depósito para obtener solicitudIds y destinatario
  const depSnap = await getDoc(doc(db, 'ordenes_deposito', depositoId))
  if (!depSnap.exists()) throw new Error(`ordenes_deposito/${depositoId} no encontrado`)
  const depData = depSnap.data() as any
  const solicitudIds: string[] = depData.solicitudIds ?? []
  const destinatario: 'storkhub' | 'comercio' = depData.destinatario ?? 'storkhub'

  // Batch: anular saldo + restaurar depósito + limpiar solicitudes
  const b = writeBatch(db)

  b.update(doc(db, 'saldos_cargo_motorizado', saldoId), {
    estado: 'anulado',
    motivoAnulacion: 'revertido_por_error',
    updatedAt: serverTimestamp(),
  })

  b.update(doc(db, 'ordenes_deposito', depositoId), {
    estado: 'en_revision',
    saldoId: deleteField(),
    notaConversion: deleteField(),
    updatedAt: serverTimestamp(),
  })

  // Campos a limpiar según destinatario
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
      [fieldKey]: deleteField(),
      [atKey]: deleteField(),
      [idKey]: deleteField(),
    })
  })

  await b.commit()

  // Anular movimientos del ledger vinculados al depósito
  const movsSnap = await getDocs(
    query(collection(db, 'movimientos_financieros'), where('depositoId', '==', depositoId))
  )
  const activos = movsSnap.docs.filter((d) => {
    const data = d.data() as any
    return data.estado !== 'anulado' && data.tipo === 'deposito_convertido_en_deuda'
  })
  if (activos.length > 0) {
    const batch2 = writeBatch(db)
    activos.forEach((d) => {
      batch2.update(d.ref, {
        estado: 'anulado',
        anuladoAt: serverTimestamp(),
        anuladoPorUid: operadorId,
        motivoAnulacion: 'Conversión en deuda revertida por error',
      })
    })
    await batch2.commit()
  }
}

// ─── Condonar deuda del motorizado ────────────────────────────────────────────

/**
 * Condona (perdona) una deuda del motorizado originada en depósito no realizado.
 * Usar cuando StorkHub decide absorber la pérdida.
 *
 * - Anula saldo_cargo_motorizado
 * - Anula el movimiento deposito_convertido_en_deuda del ledger → deuda = C$0
 * - NO toca solicitudes_envio (el depósito fue gestionado, no vuelve a pendiente)
 * - ordenes_deposito queda como registro histórico (convertido_en_deuda)
 */
export async function condonarDeudaMotorizado(params: {
  saldoId: string
  depositoId: string
  operadorId: string
  nota?: string
}): Promise<void> {
  const { saldoId, depositoId, operadorId, nota } = params

  await updateDoc(doc(db, 'saldos_cargo_motorizado', saldoId), {
    estado: 'anulado',
    motivoAnulacion: 'condonado',
    ...(nota ? { nota } : {}),
    updatedAt: serverTimestamp(),
  })

  const movsSnap = await getDocs(
    query(collection(db, 'movimientos_financieros'), where('depositoId', '==', depositoId))
  )
  const activos = movsSnap.docs.filter((d) => {
    const data = d.data() as any
    return data.estado !== 'anulado' && data.tipo === 'deposito_convertido_en_deuda'
  })
  if (activos.length > 0) {
    const b = writeBatch(db)
    activos.forEach((d) => {
      b.update(d.ref, {
        estado: 'anulado',
        anuladoAt: serverTimestamp(),
        anuladoPorUid: operadorId,
        motivoAnulacion: 'Deuda condonada',
      })
    })
    await b.commit()
  }
}
