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

  // Comercio — el comercioId embebido en estas cuentas es el ID PERMANENTE de
  // comercios/{comercioId} (identidad estable, Bloque A), nunca el Auth UID.
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
  recuperacionDeuda:     'recuperacion_deuda_liquidacion' as const, // deuda recuperada por descuento en liquidación
  // Origen/destino para dinero que entra o sale del sistema (ej: comercio paga en efectivo)
  externo:               'externo'                as const,

  // ── Cargos de delivery (Fase 1A) ──────────────────────────────────────────
  // Cuenta de devengo puro: nunca es destino, solo origen. Su saldo (negativo
  // por diseño) leído en valor absoluto es "ingreso generado" del período,
  // independiente de si ya se cobró (ver ingresos vs ingresosStorkhub/banco).
  ingresosDevengadosDelivery: 'ingresos_devengados_delivery' as const,
  // Cuenta puente única (no parametrizada): dinero que debe el CLIENTE FINAL,
  // no el comercio, mientras no se confirma su pago (efectivo/CE en poder del
  // motorizado sin confirmar, o transferencia directa aún no confirmada).
  porCobrarClienteFinal:      'por_cobrar_cliente_final'     as const,
  // Ajuste manual de un cargo de comercio: NUNCA debe simular una entrada
  // bancaria o de caja real — dinero que no llegó por ningún canal físico.
  ajustesManualesCobros:      'ajustes_manuales_cobros'      as const,
  // Pérdida de un cargo de comercio (perdido u origen cliente_final perdido).
  perdidaCobrosComercio:      'perdida_cobros_comercio'      as const,
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
  | 'abono_deuda_motorizado'           // deuda_motorizado:{id} → banco_storkhub | recuperacion_deuda_liquidacion
  | 'aporte_empresa_gasto'             // gastos_operativos → comision_pendiente (empresa asume gasto)

  // ── Cobros comercios ────────────────────────────────────────────────────────
  | 'cobro_contado_registrado'         // saldo_comercio → banco_storkhub
  | 'cobro_credito_registrado'         // saldo_comercio → ingresos_storkhub

  // ── Ajustes ─────────────────────────────────────────────────────────────────
  | 'ajuste_manual'                    // corrección contable libre (requiere nota)
  | 'anulacion'                        // contra-movimiento para revertir otro movimiento
  | 'deuda_condonada'                  // StorkHub absorbe pérdida: deuda_motorizado → perdida_condonaciones

  // ── Cargos de delivery (Fase 1A) ────────────────────────────────────────────
  // Un cargo_generado representa SOLO devengo — nunca implica que el dinero ya
  // esté en custodia real. La confirmación de custodia/cobro es SIEMPRE un
  // movimiento separado (ver cliente_efectivo_confirmado / ce_deduccion_confirmada
  // / cliente_transferencia_confirmada / pago_comercio_aplicado).
  | 'cargo_generado'                   // ingresos_devengados_delivery → saldo_comercio | por_cobrar_cliente_final
  | 'cliente_efectivo_confirmado'      // por_cobrar_cliente_final → efectivo_en_poder (SOLO si recibio=true)
  | 'ce_deduccion_confirmada'          // por_cobrar_cliente_final → efectivo_en_poder (SOLO si recibio=true, delivery deducido del CE)
  | 'cliente_transferencia_confirmada' // por_cobrar_cliente_final → banco_storkhub (boucher confirmado por gestor)
  | 'pago_comercio_aplicado'           // saldo_comercio → banco_storkhub | caja_storkhub | ajustes_manuales_cobros (según pagos_comercio.metodo)

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
  cargoId?: string        // ref a cargos_delivery (Fase 1A)
  pagoComercioId?: string // ref a pagos_comercio (Fase 1A)
  aplicacionId?: string   // ref a aplicaciones_pago (Fase 1A)

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

export type MetodoAbono = 'descuento_liquidacion' | 'transferencia' | 'ajuste_manual'

export interface AbonoSaldo {
  monto: number
  fecha: unknown
  metodoAbono: MetodoAbono
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

  // ── Condonación (ver condonarDeudaMotorizado en lib/financial-writes.ts) ──
  // Presentes solo cuando estado === 'condonado'. movimientoCondonacionId
  // identifica sin ambigüedad el único movimiento deuda_condonada activo
  // asociado — ausente en saldos condonados antes de esta corrección
  // (condonarDeudaMotorizado resuelve esos casos por búsqueda legacy).
  motivoCondonacion?: string
  montoCondonado?: number
  movimientoCondonacionId?: string
  condonadoAt?: unknown
  condonadoPorUid?: string
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

// ═══════════════════════════════════════════════════════════════════════════
// ─── Fase 1A — Cuentas por cobrar de delivery ───────────────────────────────
// ═══════════════════════════════════════════════════════════════════════════
//
// Reemplaza gradualmente a cobroDelivery/cobros_semanales (que se mantienen
// intactos en paralelo mientras se valida este modelo — ver plan de migración).
//
// Principios (ya aprobados, no reabrir sin discutirlo primero):
// - cargos_delivery NO persiste ubicacionActual, recepcionResumen ni
//   depositoIdConciliacion. La conciliación vive exclusivamente en
//   aplicaciones_pago; la ubicación del dinero se deriva del ledger.
// - aplicaciones_pago es la única fuente de verdad de cuánto se aplicó a
//   cada cargo.
// - Toda escritura en estas 4 colecciones pasa por Cloud Functions — el
//   cliente nunca escribe cargos_delivery ni aplicaciones_pago directamente,
//   y solo puede crear pagos_comercio en borrador/reportado.
//
// Identidad de comercio (Bloque A, identidad estable — no reabrir sin
// discutirlo primero):
// - comercioId es el ID PERMANENTE del documento comercios/{comercioId},
//   asignado una sola vez al crear el comercio. NUNCA es el Auth UID y NUNCA
//   cambia, exista o no un Auth UID vinculado (authUid es solo el acceso de
//   login, opcional y reemplazable). CargoDelivery.comercioId,
//   PagoComercio.comercioId, AplicacionPago.comercioId y
//   MovimientoFinanciero.comercioId siguen esta regla.
// - DEUDA TÉCNICA DE NAMING (no renombrar todavía, solo documentar): otras
//   colecciones fuera de este archivo guardan el mismo comercioId estable
//   bajo nombres que sugieren "UID de Auth" cuando NO lo son:
//     · solicitudes_envio.userId / .comercioUid
//     · clientes_envio.comercioUid
//     · cobros_semanales.clienteUid  (el nombre es el más engañoso: no es un
//       "cliente", es el comercio al que se le factura el crédito semanal —
//       confirmado en app/panel/motorizado/page.tsx, siempre proviene de
//       solicitud.userId)
//     · ordenes_deposito.destinatarioId (solo cuando destinatario=='comercio')
//   Candidato prioritario a normalizar en una limpieza futura: renombrar
//   comercioUid/clienteUid a comercioId en todas las colecciones. Módulos
//   nuevos (cargos_delivery, pagos_comercio, aplicaciones_pago) ya usan
//   comercioId directamente — no repetir el error de naming en código nuevo.

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
// NOTA: 'condonado' está reservado en el diseño pero no es alcanzable en
// Fase 1A — condonaciones_comercio no existe todavía.

export type ReceptorInicialCargo = 'motorizado' | 'storkhub_directo'

export interface CargoDelivery {
  id?: string // = solicitudId (determinístico, 1:1) — ver generarCargoDelivery
  solicitudId: string
  comercioId: string
  comercioNombreSnapshot: string
  montoOriginal: number
  montoAjustado: number
  // Cache mantenido TRANSACCIONALMENTE junto con aplicaciones_pago — no es un
  // campo "libre", nunca se edita fuera de las Cloud Functions de esta fase.
  montoPendiente: number
  responsableOriginal: ResponsableCargo
  coberturaTipo: CoberturaTipoCargo
  estadoCobertura: EstadoCoberturaCargo
  receptorInicial: ReceptorInicialCargo
  beneficiarioEconomico: 'storkhub'
  semanaKey?: string      // solo si coberturaTipo === 'comercio_credito'
  motorizadoId?: string   // requerido si receptorInicial === 'motorizado'
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
  | 'rechazado' // terminal — nunca vuelve a 'reportado'
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
  // Cache mantenido transaccionalmente por confirmarPagoComercio.
  montoAplicado: number
  // Sobrepago sin resolver — Fase 1B (saldos a favor) todavía no existe.
  excedenteSinResolver?: number
  cargosSeleccionadosIds?: string[]
  // Si este pago es un reintento tras un rechazo, referencia al anterior.
  // 'rechazado' es terminal: un comprobante nuevo SIEMPRE crea un documento
  // pagos_comercio nuevo, nunca reabre el rechazado.
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
  id?: string // = `${origenTipo}_${origenId}_${cargoId}` (determinístico)
  cargoId: string
  comercioId: string // denormalizado desde cargo.comercioId — para reglas/queries
  origenTipo: OrigenTipoAplicacion
  origenId: string
  motorizadoId?: string // denormalizado desde cargo.motorizadoId, solo si origenTipo='deposito_motorizado'
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
  id?: string // siempre 'global'
  umbralDiasMorosidadDefault: number
  // Reservado, NO usado en Fase 1A — comisión configurable queda fuera de
  // alcance hasta que se apruebe explícitamente.
  comisionPctDefault?: number
  // Reservado, NO usado en Fase 1A.
  canalesNotificacionHabilitados?: string[]
  actualizadoAt: unknown
  actualizadoPorUid: string
}
