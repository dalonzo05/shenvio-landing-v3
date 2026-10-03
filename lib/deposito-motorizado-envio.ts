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

// ─── FIN-2 — un gasto se descuenta una sola vez ───────────────────────────────
//
// Un depósito a StorkHub resta del bruto los gastos aprobados del motorizado
// (`gastosIds` / `gastosDescontados`). Hasta FIN-2 nada marcaba el gasto como
// usado, así que el mismo gasto se volvía a restar en cada depósito siguiente.
//
// Marcador: `consumidoEnDepositoId` en el gasto = el depósito que lo consumió.
// NO se reutiliza `liquidacionId`: en un gasto significa "aplicado en una
// liquidación semanal" (comentario de origen, financial-types), lo lee solo el
// filtro de elegibilidad y ningún writer vivo lo escribe. Guardar ahí un
// depositoId cambiaría su contrato.
//
// Ciclo de vida (misma vida que las órdenes del depósito, deposito-transiciones):
//   · nace con el depósito, en el MISMO commit que fija `gastosIds`;
//   · devuelto / en_revision / rehacer / confirmado / convertido_en_deuda:
//     el depósito sigue vivo o ya produjo efecto económico → se conserva;
//   · anulado, y solo si libera sus órdenes (eliminarLiberaOrdenes): la
//     obligación vuelve a pendiente, así que el gasto también → se libera,
//     y solo si la marca sigue apuntando a ESE depósito.
//
// Un gasto histórico sin marcador es elegible (compatible hacia atrás): el
// backfill desde `ordenes_deposito.gastosIds` es FIN-GASTOS-CONSUMO-BACKFILL-1.
//
// PURO: sin Firestore.

export const CAMPO_GASTO_CONSUMIDO = 'consumidoEnDepositoId'

export interface GastoParaDeposito {
  estado?: string | null
  liquidacionId?: string | null
  consumidoEnDepositoId?: string | null
}

/** ¿Este gasto puede descontarse en un depósito nuevo? */
export function esGastoElegibleParaDeposito(g: GastoParaDeposito | null | undefined): boolean {
  if (!g) return false
  if (g.estado !== 'aprobado') return false
  if (g.liquidacionId) return false
  if (typeof g.consumidoEnDepositoId === 'string' && g.consumidoEnDepositoId.length > 0) return false
  return true
}

/** Campos que marcan el gasto como consumido por ESTE depósito. */
export function camposConsumoGasto(depositoId: string): Record<string, string> {
  if (!depositoId) throw new Error('camposConsumoGasto: falta el depositoId')
  return { [CAMPO_GASTO_CONSUMIDO]: depositoId }
}

/**
 * Gastos que se pueden liberar al anular `depositoId`: solo los que siguen
 * marcados por ESE depósito. Un gasto que ya apunta a otro documento (o que
 * nunca se marcó, histórico) no se toca.
 */
export function gastosALiberarAlAnular<T extends { id: string; consumidoEnDepositoId?: string | null }>(
  gastos: Array<T | null | undefined>,
  depositoId: string,
): string[] {
  return gastos
    .filter((g): g is T => !!g && g.consumidoEnDepositoId === depositoId)
    .map((g) => g.id)
}

/** ¿Anular este depósito libera sus gastos? Misma regla que libera sus órdenes. */
export function anularLiberaGastos(estadoDelDeposito: string | null | undefined): boolean {
  return estadoDelDeposito !== 'convertido_en_deuda'
}

/** Lo mínimo que se le pide a un batch de Firestore: así el helper es puro. */
export interface BatchActualiza<R> {
  update(ref: R, data: Record<string, unknown>): unknown
}

/**
 * Marca, en el batch que CREA el depósito, cada gasto de `gastosIds` como
 * consumido por ese depósito. Va en el mismo commit que fija `gastosIds`: no
 * existe "depósito con gastos y gasto libre" ni "gasto consumido y depósito sin
 * crear". La guardia contra dos depósitos concurrentes es de firestore.rules.
 * @returns cuántos gastos marcó
 */
export function marcarGastosConsumidos<R>(
  batch: BatchActualiza<R>,
  refGasto: (gastoId: string) => R,
  gastosIds: readonly string[] | null | undefined,
  depositoId: string,
): number {
  const ids = [...new Set((gastosIds ?? []).filter((id) => typeof id === 'string' && id.length > 0))]
  const campos = camposConsumoGasto(depositoId)
  ids.forEach((id) => batch.update(refGasto(id), campos))
  return ids.length
}

/**
 * Libera, en el batch que ANULA el depósito, solo los gastos que siguen
 * marcados por ese depósito. `limpiar` es el centinela de borrado del SDK
 * (deleteField()), que llega de afuera para que esto siga siendo puro.
 * @returns cuántos gastos liberó
 */
export function liberarGastosDeDeposito<R>(
  batch: BatchActualiza<R>,
  refGasto: (gastoId: string) => R,
  gastosLeidos: Array<{ id: string; consumidoEnDepositoId?: string | null } | null | undefined>,
  depositoId: string,
  limpiar: unknown,
): number {
  const ids = gastosALiberarAlAnular(gastosLeidos, depositoId)
  ids.forEach((id) => batch.update(refGasto(id), { [CAMPO_GASTO_CONSUMIDO]: limpiar }))
  return ids.length
}
