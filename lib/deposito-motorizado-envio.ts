// STORAGE-EVIDENCIA-INTEGRIDAD-1 — Cómo el motorizado registra un depósito
// A/B: primero el documento, después el comprobante.
//
// Antes subía boucher.jpg ANTES de que existiera ordenes_deposito/{id} y
// creaba el documento directo en 'en_revision' con el boucher adentro. Con
// eso storage.rules no tenía contra qué validar la subida (el documento no
// existía) y firestore.rules le dejaba crear el depósito en cualquier estado
// (deuda MOTO-CREATE-DEPOSITO-CONFIRMADO).
//
// Ahora son tres pasos, el mismo patrón que ya usa el digitador:
//
//   1. create  → estado 'pendiente_boucher', SIN boucher
//   2. upload  → depositos/{uid}/{depId}/boucher.jpg (Storage lo acepta solo
//                porque el depósito ya existe, es suyo y espera comprobante)
//   3. batch   → boucher + 'en_revision' en el depósito, y el puntero en
//                cada orden, en una sola escritura atómica
//
// Si falla 1, no se sube nada. Si falla 2, queda un depósito en
// 'pendiente_boucher' sin boucher, reintentable con el MISMO id. Si falla 3,
// queda en 'pendiente_boucher' y el objeto puede haber quedado subido: el
// reintento lo vuelve a subir en el mismo path (sigue en pendiente_boucher)
// y repite el batch. No hay limpieza automática (deuda de F2).
//
// PURO: sin Firestore, sin React. El sello de tiempo lo pasa quien llama
// (serverTimestamp() en la app, lo mismo en los tests de reglas).

export const TIPO_DEPOSITO_MOTORIZADO_STORKHUB = 'recaudacion_motorizado_storkhub'
export const TIPO_DEPOSITO_MOTORIZADO_COMERCIO = 'recaudacion_motorizado_comercio'

export type TipoDepositoMotorizado =
  | typeof TIPO_DEPOSITO_MOTORIZADO_STORKHUB
  | typeof TIPO_DEPOSITO_MOTORIZADO_COMERCIO

export interface CuentaDestinoDeposito {
  banco: string
  numero: string
  titular: string
  moneda: string
}

export interface DatosDepositoMotorizado {
  tipo: TipoDepositoMotorizado
  destinatario: 'storkhub' | 'comercio'
  destinatarioId: string
  destinatarioNombre: string
  cuentasDestino: CuentaDestinoDeposito[]
  /** Auth UID del motorizado: el mismo que va en el path de Storage. */
  motorizadoUid: string
  motorizadoNombre: string
  solicitudIds: string[]
  montoTotal: number
  /** Solo StorkHub: neto = bruto − gastos. */
  montoBruto?: number
  gastosDescontados?: number
  gastosIds?: string[]
}

/** Paso 1: el documento nace esperando comprobante, sin boucher. */
export function camposCreacionDepositoMotorizado<T>(datos: DatosDepositoMotorizado, ahora: T) {
  const campos: Record<string, unknown> = {
    creadoAt: ahora,
    tipo: datos.tipo,
    estado: 'pendiente_boucher',
    destinatario: datos.destinatario,
    destinatarioId: datos.destinatarioId,
    destinatarioNombre: datos.destinatarioNombre,
    cuentasDestino: datos.cuentasDestino,
    motorizadoUid: datos.motorizadoUid,
    motorizadoNombre: datos.motorizadoNombre,
    solicitudIds: datos.solicitudIds,
    montoTotal: datos.montoTotal,
  }
  if (datos.montoBruto !== undefined) campos.montoBruto = datos.montoBruto
  if (datos.gastosDescontados !== undefined) campos.gastosDescontados = datos.gastosDescontados
  if (datos.gastosIds !== undefined) campos.gastosIds = datos.gastosIds
  return campos
}

/** Paso 3 (depósito): boucher y transición a revisión en la misma escritura. */
export function camposEnvioBoucherMotorizado<T>(
  subida: { url: string; pathStorage: string },
  motorizadoUid: string,
  ahora: T,
) {
  return {
    boucher: { url: subida.url, pathStorage: subida.pathStorage, uploadedAt: ahora, motorizadoUid },
    estado: 'en_revision' as const,
  }
}

/** Paso 3 (órdenes): el puntero que las saca de "Por depositar". */
export function campoPunteroDepositoMotorizado(tipo: TipoDepositoMotorizado): string {
  return tipo === TIPO_DEPOSITO_MOTORIZADO_STORKHUB
    ? 'registro.deposito.storkhubDepositoId'
    : 'registro.deposito.comercioDepositoId'
}

/** Path del comprobante: el UID del motorizado dueño va en el path. */
export function pathBoucherDepositoMotorizado(motorizadoUid: string, depositoId: string): string {
  return `depositos/${motorizadoUid}/${depositoId}/boucher.jpg`
}

/**
 * Estado del envío en curso de un grupo, para reintentar sin crear un
 * segundo depósito: si el paso 1 ya se hizo, el reintento usa el mismo id y
 * no vuelve a crear (un segundo create sobre el mismo id sería un update, que
 * firestore.rules no le da al motorizado).
 */
export interface EnvioDepositoEnCurso {
  depositoId: string
  creado: boolean
  /** Qué depósito se estaba creando: si el grupo cambió, no se reutiliza. */
  firma: string
}

/** Identidad de lo que se deposita: tipo, destino, órdenes y monto. */
export function firmaEnvioDeposito(datos: DatosDepositoMotorizado): string {
  return [datos.tipo, datos.destinatarioId, [...datos.solicitudIds].sort().join(','), String(datos.montoTotal)].join('|')
}

/**
 * ¿El reintento puede seguir con el envío anterior? Solo si es el mismo
 * depósito. Si entre intentos cambiaron las órdenes o el monto, el documento
 * ya creado no los representa: se empieza uno nuevo (y el anterior queda en
 * 'pendiente_boucher', visible para el gestor — sin limpieza automática).
 */
export function envioReutilizable(
  previo: EnvioDepositoEnCurso | null | undefined,
  datos: DatosDepositoMotorizado,
): previo is EnvioDepositoEnCurso {
  return !!previo && previo.firma === firmaEnvioDeposito(datos)
}

export function pasosPendientesEnvio(envio: EnvioDepositoEnCurso | null | undefined): Array<'crear' | 'subir' | 'enviar'> {
  return envio?.creado ? ['subir', 'enviar'] : ['crear', 'subir', 'enviar']
}
