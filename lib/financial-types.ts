// ─── Estados del cobro de delivery ────────────────────────────────────────────
export type EstadoCobroDelivery =
  | 'pendiente'
  | 'pagado'
  | 'no_cobrar'
  | 'en_revision_deposito' // cliente pagó por depósito, esperando confirmación gestor
  | 'revertido' // pago revertido después de confirmado

// ─── Tipos de depósito ─────────────────────────────────────────────────────────
export type TipoDeposito =
  | 'recaudacion_motorizado_storkhub' // motorizado deposita efectivo a Storkhub
  | 'recaudacion_motorizado_comercio' // motorizado deposita efectivo a comercio
  | 'pago_delivery_deposito' // cliente/comercio paga delivery por transferencia

// ─── Estados del depósito ──────────────────────────────────────────────────────
export type EstadoDeposito =
  | 'pendiente_boucher'   // creado, esperando que motorizado suba boucher
  | 'en_revision'         // boucher subido, esperando al gestor
  | 'confirmado'          // gestor confirmó
  | 'rechazado'           // gestor rechazó
  | 'convertido_en_deuda' // gestor convirtió el pendiente en saldo a cargo del motorizado
  | 'anulado'             // revertido por error (creado desde Pendientes, sin boucher real)

// ─── Tipos de cartera comercial ───────────────────────────────────────────────
// Más flexible que solo 'contado' | 'crédito', permite convenios futuros.
export type TipoCartera =
  | 'diaria'     // pago esperado cada día (clásico contado)
  | 'semanal'    // cobro agrupado semanal (clásico crédito)
  | 'quincenal'
  | 'mensual'
  | 'libre'      // términos especiales acordados

// ─── Propietario del efectivo ──────────────────────────────────────────────────
// Quién es el dueño real de un monto en custodia del motorizado.
// El motorizado puede tener C$500 donde C$200 son de StorkHub,
// C$250 de comercio A y C$50 de comercio B.
export type PropietarioEfectivo =
  | 'storkhub'
  | `comercio:${string}` // comercio:{comercioId}
  | `motorizado:${string}` // motorizado:{motorizadoId} (ej: su propia comisión)

// ─── Cuentas del ledger ────────────────────────────────────────────────────────
// Helpers para construir los identificadores de cuenta. Usamos strings con prefijo
// en vez de enums para soportar IDs dinámicos (por motorizado, comercio, etc.).
//
// IMPORTANTE: el motorizado NO tiene una "caja chica propia". El efectivo bajo
// su custodia pertenece parcialmente a StorkHub, parcialmente a comercios, y
// parcialmente puede incluir vueltos. Usamos "efectivo_en_poder" para reflejar
// esa realidad: es dinero en tránsito bajo su responsabilidad, no suyo.
export const cuentas = {
  // Motorizado
  efectivoEnPoder:    (motorizadoId: string) => `efectivo_en_poder:${motorizadoId}`,
  deudaMotorizado:    (motorizadoId: string) => `deuda_motorizado:${motorizadoId}`,
  comisionPendiente:  (motorizadoId: string) => `comision_pendiente:${motorizadoId}`,

  // Comercio
  saldoComercio:      (comercioId: string)   => `saldo_comercio:${comercioId}`,
  // Dinero de producto cobrado: es retención temporal, NO deuda del comercio.
  // Solo transita por el motorizado hasta que lo deposita al comercio.
  transitorioProducto:(comercioId: string)   => `transitorio_producto:${comercioId}`,

  // StorkHub (cuentas estáticas)
  ingresos:              'ingresos_storkhub'      as const,
  banco:                 'banco_storkhub'         as const,
  caja:                  'caja_storkhub'          as const, // efectivo en mano (adelantos, pagos en cash)
  gastosOp:              'gastos_operativos'      as const,
  perdidaCondonaciones:  'perdida_condonaciones'  as const, // pérdidas asumidas por condonar deudas
  // Origen/destino para dinero que entra o sale del sistema (ej: comercio paga en efectivo)
  externo:               'externo'                as const,
} as const

// ─── Tipos de movimiento financiero ───────────────────────────────────────────
// Los tipos más específicos (delivery_efectivo_cobrado, etc.) coexisten con los
// genéricos legacy (cobro_generado, pago_recibido) para no romper el flujo actual.
// Fase 1: el ledger es auditoría enriquecida. Fase 4+ lo convierte en fuente de verdad.
export type TipoMovimiento =
  // ── Legacy (mantener para compatibilidad) ──────────────────────────────────
  | 'cobro_generado'
  | 'pago_recibido'
  | 'pago_revertido'
  | 'monto_perdido'
  | 'deposito_subido'
  | 'deposito_confirmado'
  | 'deposito_rechazado'
  | 'deposito_convertido_en_deuda'
  | 'adelanto_motorizado'
  | 'faltante'
  | 'ajuste'
  | 'liquidacion_pagada'
  | 'gasto_aprobado'
  | 'saldo_creado'
  | 'abono_saldo'
  | 'aporte_empresa_motorizado'
  | 'ajuste_manual_saldo'

  // ── Delivery ────────────────────────────────────────────────────────────────
  | 'delivery_efectivo_cobrado'        // motorizado recibe efectivo delivery → efectivo_en_poder (owner: storkhub)
  | 'delivery_transferencia_cobrado'   // delivery pagado por transferencia → banco_storkhub directamente
  | 'delivery_credito_generado'        // delivery a crédito → saldo_comercio (se cobra después)

  // ── Producto ────────────────────────────────────────────────────────────────
  | 'producto_cobrado_efectivo'        // motorizado recibe efectivo de producto → transitorio_producto (owner: comercio)
  // El dinero de producto NUNCA entra a gastos ni caja de StorkHub.
  // Es retención temporal hasta que el motorizado lo deposita al comercio.

  // ── Depósitos (enriquecidos) ────────────────────────────────────────────────
  | 'deposito_efectivo_storkhub'       // efectivo_en_poder → banco_storkhub
  | 'deposito_efectivo_comercio'       // efectivo_en_poder → externo (entregado al comercio)

  // ── Cargotrans ─────────────────────────────────────────────────────────────
  | 'vuelto_cargotrans_a_efectivo'     // vuelto de Cargotrans → efectivo_en_poder
  | 'vuelto_cargotrans_a_comercio'     // vuelto devuelto al comercio → saldo_comercio o externo
  | 'pago_cargotrans_por_comercio'     // comercio paga Cargotrans directamente
  | 'pago_cargotrans_por_storkhub'     // StorkHub paga/transfiere Cargotrans → gastos_operativos

  // ── Terminales ─────────────────────────────────────────────────────────────
  | 'peaje_terminal'                   // recargo C$20 → efectivo_en_poder o comision_pendiente
  | 'peaje_terminal_sin_efectivo'      // motorizado no tenía efectivo → pasa a favor en liquidación

  // ── Gastos operativos ───────────────────────────────────────────────────────
  | 'gasto_operativo_aprobado'         // gasto aprobado por gestor (más específico que gasto_aprobado)

  // ── Liquidación ─────────────────────────────────────────────────────────────
  | 'liquidacion_comision_calculada'   // ingresos_storkhub → comision_pendiente
  | 'liquidacion_pago_efectivo'        // comision_pendiente → externo
  | 'liquidacion_pago_transferencia'   // comision_pendiente → externo

  // ── Saldos y deudas ─────────────────────────────────────────────────────────
  | 'abono_deuda_motorizado'           // comision_pendiente → deuda_motorizado
  | 'aporte_empresa_gasto'             // gastos_operativos → comision_pendiente (empresa asume gasto)

  // ── Cobros comercios ────────────────────────────────────────────────────────
  | 'cobro_contado_registrado'         // saldo_comercio → banco_storkhub
  | 'cobro_credito_registrado'         // saldo_comercio → ingresos_storkhub

  // ── Ajustes ─────────────────────────────────────────────────────────────────
  | 'ajuste_manual'                    // corrección contable libre (requiere nota)
  | 'anulacion'                        // contra-movimiento para revertir otro movimiento
  | 'deuda_condonada'                  // StorkHub absorbe pérdida: deuda_motorizado → perdida_condonaciones

// ─── Movimiento financiero (colección movimientos_financieros) ─────────────────
// Fase 1: ledger como auditoría enriquecida. Los campos cuentaOrigen/cuentaDestino
// son opcionales para no romper el flujo actual mientras se migra gradualmente.
export interface MovimientoFinanciero {
  id?: string
  tipo: TipoMovimiento
  monto: number
  at: unknown // siempre serverTimestamp() — nunca Date ni Timestamp.fromDate()
  creadoPorUid: string  // UID de quien disparó la escritura
  creadoPorRol: 'gestor' | 'motorizado' | 'sistema'
  descripcion: string
  estado: 'activo' | 'anulado'
  anuladoPorMovimientoId?: string // si fue revertido por otro movimiento
  anuladoAt?: unknown              // timestamp de anulación
  anuladoPorUid?: string           // UID de quien anuló
  motivoAnulacion?: string         // motivo de la anulación

  // ── Doble entrada (opcional en Fase 1, requerido en Fase 4+) ────────────────
  cuentaOrigen?: string  // ej: "efectivo_en_poder:moto123"
  cuentaDestino?: string // ej: "banco_storkhub"

  // ── Ownership del efectivo ─────────────────────────────────────────────────
  // A qué entidad pertenece el dinero que se mueve. Crítico para saber
  // "de los C$500 que tiene el motorizado, quién es dueño de cada peso".
  propietario?: PropietarioEfectivo

  // ── Semana operativa ────────────────────────────────────────────────────────
  semanaKey?: string // ej: "2025-W14" — para filtrar por período

  // ── Referencias (contexto operacional) ─────────────────────────────────────
  solicitudId?: string
  depositoId?: string
  motorizadoId?: string
  comercioId?: string
  saldoId?: string
  gastoId?: string
  liquidacionId?: string

  // ── Datos extra sin schema fijo ─────────────────────────────────────────────
  metadata?: Record<string, unknown>

  // @deprecated usar creadoPorUid
  operadorId?: string
}

// ─── Estado de la liquidación semanal ─────────────────────────────────────────
export type EstadoLiquidacion = 'pendiente' | 'pagado'

// ─── Liquidación semanal del motorizado (colección liquidaciones_motorizado) ──
export interface LiquidacionMotorizado {
  id?: string
  motorizadoId: string
  motorizadoUid: string
  motorizadoNombre: string
  semanaKey: string
  semanaInicio: unknown
  semanaFin: unknown
  totalViajes: number
  totalGenerado: number
  comisionPct: number
  comision: number
  adelantos: number
  faltantesDeposito: number
  otrosDescuentos: number
  deudasAplicadas: number
  deudasAplicadasIds: string[]
  gastosAprobados?: number
  gastosAsumidosStorkhub?: number
  gastosIds?: string[]
  netoAPagar: number
  estado: EstadoLiquidacion
  creadoAt: unknown
  creadoPor: string
  pagadoAt?: unknown
  pagadoPor?: string
  saldoGeneradoId?: string
  ordenesIds: string[]
  depositosIds?: string[]
  movimientosIds?: string[]
  pdfUrl?: string      // URL del PDF generado al marcar como pagado
  pdfPath?: string     // path en Firebase Storage
  pdfGeneradoAt?: unknown
}

// ─── Gastos operativos del motorizado (colección gastos_motorizado) ────────────
export type TipoGasto =
  | 'peaje_terminal'
  | 'pago_cargotrans'
  | 'otro_gasto_operativo'

export type EstadoGasto = 'aprobado' | 'anulado'

export interface OrdenSnapshot {
  ordenId: string
  comercioNombre?: string
  comercioId?: string
  clienteNombre?: string
  entregadoAt?: unknown
  tipoEnvio?: string
  metodoEnvio?: string
  puntoLogistico?: string
  precioDelivery?: number
}

export interface GastoMotorizado {
  id?: string
  motorizadoId: string
  motorizadoNombre: string
  ordenId?: string
  ordenSnapshot?: OrdenSnapshot
  tipo: TipoGasto
  monto: number
  estado: EstadoGasto
  nota?: string
  fecha: unknown // Timestamp del gasto (puede ser distinto a createdAt)
  creadoPorUid: string
  createdAt: unknown
  updatedAt?: unknown
}

// ─── Saldos a cargo del motorizado (colección saldos_cargo_motorizado) ─────────
export type TipoSaldo =
  | 'deposito_no_realizado'
  | 'adelanto'
  | 'ajuste_manual'
  | 'otro'

export type EstadoSaldo = 'pendiente' | 'abonado_parcial' | 'pagado' | 'anulado' | 'condonado'

export type OrigenSaldo = 'deposito' | 'liquidacion' | 'manual'

export interface AbonoSaldo {
  monto: number
  fecha: unknown
  metodo?: string
  nota?: string
  creadoPorUid: string
  comprobanteUrl?: string   // URL pública del comprobante/boucher subido a Storage
  comprobantePath?: string  // path en Firebase Storage para referencia
}

export interface SaldoCargoMotorizado {
  id?: string
  motorizadoId: string
  motorizadoUid: string
  motorizadoNombre: string
  tipo: TipoSaldo
  montoOriginal: number
  saldoPendiente: number
  estado: EstadoSaldo
  origen: OrigenSaldo
  depositoId?: string
  liquidacionId?: string
  fecha: unknown
  nota?: string
  creadoPorUid: string
  createdAt: unknown
  updatedAt?: unknown
  abonos?: AbonoSaldo[]
}

// ─── Adelantos al motorizado (colección adelantos_motorizado) ─────────────────
export interface AdelantoMotorizado {
  id?: string
  motorizadoId: string
  motorizadoUid: string
  motorizadoNombre: string
  monto: number
  semanaKey: string
  nota?: string
  fecha: unknown
  creadoPorUid: string
  createdAt: unknown
  saldoId?: string
}

// ─── Helpers de display ────────────────────────────────────────────────────────
export const LABELS_TIPO_GASTO: Record<TipoGasto, string> = {
  peaje_terminal: 'Peaje terminal',
  pago_cargotrans: 'Pago Cargotrans',
  otro_gasto_operativo: 'Otro gasto operativo',
}

export const LABELS_TIPO_SALDO: Record<TipoSaldo, string> = {
  deposito_no_realizado: 'Depósito no realizado',
  adelanto: 'Adelanto',
  ajuste_manual: 'Ajuste manual',
  otro: 'Otro',
}

export const LABELS_TIPO_CARTERA: Record<TipoCartera, string> = {
  diaria:     'Contado diario',
  semanal:    'Crédito semanal',
  quincenal:  'Crédito quincenal',
  mensual:    'Crédito mensual',
  libre:      'Convenio especial',
}

export function getDepositoEstado(dep: {
  estado?: string
}): EstadoDeposito {
  return (dep.estado as EstadoDeposito) ?? 'pendiente_boucher'
}
