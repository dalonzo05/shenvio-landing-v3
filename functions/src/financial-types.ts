// ═══════════════════════════════════════════════════════════════════════════
// ESPEJO SERVER-SIDE de lib/financial-types.ts
// ═══════════════════════════════════════════════════════════════════════════
//
// functions/ es un proyecto TypeScript independiente (tsconfig incluye solo
// "src", el deploy solo empaqueta functions/) y no puede importar archivos
// fuera de functions/src — por eso este archivo duplica manualmente los tipos
// financieros que las Cloud Functions necesitan, en vez de importarlos desde
// la raíz del proyecto Next.js.
//
// RIESGO CONOCIDO: este archivo puede desincronizarse de lib/financial-types.ts
// si uno se edita sin el otro. Mantenerlos iguales es una disciplina manual,
// no algo forzado por el compilador. Si en el futuro se justifica, migrar a
// un paquete compartido (workspace) eliminaría este riesgo — no se hace ahora
// porque excede el alcance de Fase 1A.
//
// Todo lo demás (comentarios, principios, nombres) es idéntico al archivo
// original — ver lib/financial-types.ts como fuente primaria de verdad para
// el código cliente.

// ─── Cuentas del ledger ────────────────────────────────────────────────────────
export const cuentas = {
  // Motorizado
  efectivoEnPoder:    (motorizadoId: string) => `efectivo_en_poder:${motorizadoId}`,
  deudaMotorizado:    (motorizadoId: string) => `deuda_motorizado:${motorizadoId}`,
  comisionPendiente:  (motorizadoId: string) => `comision_pendiente:${motorizadoId}`,

  // Comercio
  saldoComercio:      (comercioId: string)   => `saldo_comercio:${comercioId}`,
  transitorioProducto:(comercioId: string)   => `transitorio_producto:${comercioId}`,

  // StorkHub (cuentas estáticas)
  ingresos:              'ingresos_storkhub'      as const,
  banco:                 'banco_storkhub'         as const,
  caja:                  'caja_storkhub'          as const,
  gastosOp:              'gastos_operativos'      as const,
  perdidaCondonaciones:  'perdida_condonaciones'  as const,
  recuperacionDeuda:     'recuperacion_deuda_liquidacion' as const,
  externo:               'externo'                as const,

  // ── Cargos de delivery (Fase 1A) ──────────────────────────────────────────
  ingresosDevengadosDelivery: 'ingresos_devengados_delivery' as const,
  porCobrarClienteFinal:      'por_cobrar_cliente_final'     as const,
  ajustesManualesCobros:      'ajustes_manuales_cobros'      as const,
  perdidaCobrosComercio:      'perdida_cobros_comercio'      as const,
} as const

// ─── Tipos de movimiento financiero (solo los usados por Cloud Functions) ─────
// NOTA: no se copia la unión completa de lib/financial-types.ts porque las
// Functions de Fase 1A solo emiten un subconjunto. Si una función futura
// necesita un tipo legacy adicional, agregarlo aquí explícitamente.
export type TipoMovimiento =
  | 'monto_perdido'
  | 'cargo_generado'
  | 'cliente_efectivo_confirmado'
  | 'ce_deduccion_confirmada'
  | 'cliente_transferencia_confirmada'
  | 'pago_comercio_aplicado'
  | 'deposito_efectivo_storkhub' // ya emitido por Depósitos — no se re-implementa, solo se referencia el nombre
  | 'abono_deuda_motorizado' // emitido por confirmarPropuestaAbono (DIGITADOR V1)

// ─── Movimiento financiero (colección movimientos_financieros) ─────────────────
export interface MovimientoFinanciero {
  id?: string
  tipo: TipoMovimiento
  monto: number
  at: unknown
  creadoPorUid: string
  creadoPorRol: 'gestor' | 'motorizado' | 'sistema'
  descripcion: string
  estado: 'activo' | 'anulado'
  anuladoPorMovimientoId?: string
  anuladoAt?: unknown
  anuladoPorUid?: string
  motivoAnulacion?: string

  cuentaOrigen?: string
  cuentaDestino?: string

  propietario?: string

  semanaKey?: string

  solicitudId?: string
  depositoId?: string
  motorizadoId?: string
  comercioId?: string
  saldoId?: string
  gastoId?: string
  liquidacionId?: string
  cargoId?: string
  pagoComercioId?: string
  aplicacionId?: string

  metadata?: Record<string, unknown>
}

// ─── cargos_delivery ─────────────────────────────────────────────────────────

export type ResponsableCargo = 'comercio' | 'cliente_final' | 'tercero'

export type CoberturaTipoCargo =
  | 'cliente_efectivo'
  | 'cliente_transferencia'
  | 'deduccion_ce'
  | 'comercio_contado'
  | 'comercio_credito'
  | 'tercero'

export type EstadoCoberturaCargo = 'pendiente' | 'parcial' | 'cubierto' | 'perdido' | 'anulado'

export type ReceptorInicialCargo = 'motorizado' | 'storkhub_directo'

export interface CargoDelivery {
  id?: string
  solicitudId: string
  comercioId: string
  comercioNombreSnapshot: string
  montoOriginal: number
  montoAjustado: number
  montoPendiente: number
  responsableOriginal: ResponsableCargo
  coberturaTipo: CoberturaTipoCargo
  estadoCobertura: EstadoCoberturaCargo
  receptorInicial: ReceptorInicialCargo
  beneficiarioEconomico: 'storkhub'
  semanaKey?: string
  motorizadoId?: string
  anulado: boolean
  motivoAnulacion?: string
  anuladoPorUid?: string
  anuladoAt?: unknown
  creadoAt: unknown
  actualizadoAt: unknown
}

// ─── pagos_comercio ──────────────────────────────────────────────────────────

export type EstadoPagoComercio =
  | 'borrador'
  | 'reportado'
  | 'en_revision'
  | 'confirmado'
  | 'parcial'
  | 'rechazado'
  | 'anulado'

export type MetodoPagoComercio = 'transferencia' | 'efectivo' | 'ajuste_manual'

export interface PagoComercio {
  id?: string
  comercioId: string
  comercioNombreSnapshot: string
  monto: number
  metodo: MetodoPagoComercio
  estado: EstadoPagoComercio
  comprobanteUrl?: string
  comprobantePath?: string
  reportadoPor?: string
  reportadoAt?: unknown
  confirmadoPor?: string
  confirmadoAt?: unknown
  rechazadoPor?: string
  rechazadoAt?: unknown
  motivoRechazo?: string
  montoAplicado: number
  excedenteSinResolver?: number
  cargosSeleccionadosIds?: string[]
  pagoAnteriorRechazadoId?: string
  creadoPorUid: string
  creadoAt: unknown
  actualizadoAt: unknown
  anuladoPorUid?: string
  anuladoAt?: unknown
  motivoAnulacion?: string
}

// ─── aplicaciones_pago ───────────────────────────────────────────────────────

export type OrigenTipoAplicacion = 'pago_comercio' | 'deposito_motorizado'
export type EstadoAplicacion = 'activa' | 'revertida'

export interface AplicacionPago {
  id?: string
  cargoId: string
  comercioId: string
  origenTipo: OrigenTipoAplicacion
  origenId: string
  motorizadoId?: string
  montoAplicado: number
  estado: EstadoAplicacion
  creadoAt: unknown
  creadoPorUid: string
  revertidoAt?: unknown
  revertidoPorUid?: string
  motivoReversion?: string
}

// ─── configuracion_cobros (singleton, id='global') ──────────────────────────

export interface ConfiguracionCobros {
  id?: string
  umbralDiasMorosidadDefault: number
  comisionPctDefault?: number
  canalesNotificacionHabilitados?: string[]
  actualizadoAt: unknown
  actualizadoPorUid: string
}
