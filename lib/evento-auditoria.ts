// B2-AUDITORIA-UX — Presentación de un movimiento del ledger en Auditoría.
//
// La tabla de Movimientos ponía al frente el `tipo` crudo
// (`deposito_efectivo_storkhub`) y escondía en la fila expandida lo único
// legible que ya existía: `descripcion`, que los writers vienen persistiendo
// en copy humano desde siempre ("Depósito confirmado · Storkhub · Juan").
// Acá no se inventa semántica: se decide qué texto va al frente, qué queda
// como rastro técnico, y a dónde se puede navegar sin afirmar destinos que el
// dato no demuestra.
//
// Tres reglas que este helper no puede violar:
//
//   1. `descripcion` persistida MANDA. El fallback por `tipo` solo entra
//      cuando no hay descripción; nunca la reemplaza ni la "mejora".
//   2. `creadoPorRol` NO demuestra el rol real. `registrarMovimiento()`
//      escribe `opciones?.rol ?? 'gestor'`, así que una acción de Admin queda
//      persistida como `gestor`, y `digitador`/`comercio` ni siquiera existen
//      en el enum. Se presenta como "rol registrado", jamás como identidad.
//      Deuda abierta: AUD-ROL-NO-DISCRIMINA-ADMIN.
//   3. Un depósito que agrupa varias órdenes NO se atribuye a una sola.
//      Elegir "la primera" sería inventar de qué orden habla el movimiento.
//
// Por la regla 2, ninguna etiqueta de `tipo` nombra al actor: se dice
// "Depósito confirmado", no "Gestor confirmó depósito". Quién intervino se
// resuelve aparte, desde `creadoPorUid`, y se muestra como tal.
//
// PURO: sin Firestore, sin React, sin `Date.now()`. Los nombres de usuario y
// el documento del depósito los resuelve la página y llegan ya resueltos.

import { rutaOrden } from './ruta-orden'

// ─── Entrada ──────────────────────────────────────────────────────────────────

/**
 * Superset estructural standalone de `MovimientoFinanciero`.
 *
 * No hace `extends` de la interfaz real a propósito: el helper se alimenta de
 * documentos crudos de Firestore, donde cualquier campo puede faltar o venir
 * con otra forma. Declararlo aparte evita además el TS2320 que ya costó tres
 * veces en esta línea de trabajo.
 */
export interface EntradaEventoAuditoria {
  id?: string | null
  tipo?: string | null
  descripcion?: string | null
  estado?: string | null
  creadoPorRol?: string | null
  creadoPorUid?: string | null
  anuladoPorUid?: string | null
  anuladoAt?: unknown
  motivoAnulacion?: string | null
  anuladoPorMovimientoId?: string | null
  solicitudId?: string | null
  depositoId?: string | null
  motorizadoId?: string | null
  comercioId?: string | null
  saldoId?: string | null
  gastoId?: string | null
  liquidacionId?: string | null
}

/** Documento de `ordenes_deposito` ya leído por la página, si lo hay. */
export interface DepositoRelacionado {
  id: string
  solicitudIds?: string[] | null
}

/** Fila de `motorizado` tal como la página ya la tiene en memoria. */
export interface MotorizadoConocido {
  id: string
  authUid?: string | null
  nombre?: string | null
}

const texto = (v: unknown): string => (typeof v === 'string' ? v.trim() : '')

// ─── Qué ocurrió ──────────────────────────────────────────────────────────────

/**
 * Copy neutro por tipo de movimiento. Describe el HECHO, nunca quién lo hizo:
 * el rol persistido no es confiable (ver cabecera), así que una etiqueta como
 * "Gestor confirmó…" afirmaría algo que el dato no sostiene.
 */
const ETIQUETA_TIPO: Record<string, string> = {
  cobro_generado: 'Cobro generado',
  pago_recibido: 'Pago recibido',
  pago_revertido: 'Pago revertido',
  monto_perdido: 'Monto dado por perdido',
  deposito_subido: 'Depósito subido',
  deposito_confirmado: 'Depósito confirmado',
  deposito_rechazado: 'Depósito rechazado',
  deposito_convertido_en_deuda: 'Depósito convertido en deuda',
  adelanto_motorizado: 'Adelanto a motorizado',
  faltante: 'Faltante registrado',
  ajuste: 'Ajuste',
  liquidacion_pagada: 'Liquidación pagada',
  gasto_aprobado: 'Gasto aprobado',
  saldo_creado: 'Saldo a cargo creado',
  abono_saldo: 'Abono a saldo',
  aporte_empresa_motorizado: 'Aporte de la empresa al motorizado',
  ajuste_manual_saldo: 'Ajuste manual de saldo',
  delivery_efectivo_cobrado: 'Delivery cobrado en efectivo',
  delivery_transferencia_cobrado: 'Delivery cobrado por transferencia',
  delivery_credito_generado: 'Delivery a crédito generado',
  producto_cobrado_efectivo: 'Producto cobrado en efectivo',
  deposito_efectivo_storkhub: 'Depósito de efectivo a Storkhub',
  deposito_efectivo_comercio: 'Depósito de efectivo al comercio',
  vuelto_cargotrans_a_efectivo: 'Vuelto de Cargotrans a efectivo',
  vuelto_cargotrans_a_comercio: 'Vuelto de Cargotrans al comercio',
  pago_cargotrans_por_comercio: 'Cargotrans pagado por el comercio',
  pago_cargotrans_por_storkhub: 'Cargotrans pagado por Storkhub',
  peaje_terminal: 'Peaje de terminal',
  peaje_terminal_sin_efectivo: 'Peaje de terminal sin efectivo',
  gasto_operativo_aprobado: 'Gasto operativo aprobado',
  liquidacion_comision_calculada: 'Comisión de liquidación calculada',
  liquidacion_pago_efectivo: 'Liquidación pagada en efectivo',
  liquidacion_pago_transferencia: 'Liquidación pagada por transferencia',
  abono_deuda_motorizado: 'Abono a deuda del motorizado',
  aporte_empresa_gasto: 'Aporte de la empresa a un gasto',
  cobro_contado_registrado: 'Cobro de contado registrado',
  cobro_credito_registrado: 'Cobro a crédito registrado',
  ajuste_manual: 'Ajuste manual',
  anulacion: 'Anulación',
  deuda_condonada: 'Deuda condonada',
  cargo_generado: 'Cargo generado',
  cliente_efectivo_confirmado: 'Efectivo del cliente confirmado',
  ce_deduccion_confirmada: 'Deducción sobre contra entrega confirmada',
  cliente_transferencia_confirmada: 'Transferencia del cliente confirmada',
  pago_comercio_aplicado: 'Pago del comercio aplicado',
}

/** Último recurso: ni descripción ni tipo conocido. El chip técnico desambigua. */
export const TITULO_GENERICO = 'Movimiento registrado'

export type OrigenTitulo = 'descripcion' | 'tipo' | 'generico'

export interface TituloMovimiento {
  /** Texto principal de la fila. */
  titulo: string
  /** De dónde salió: la UI puede tratar distinto lo derivado. */
  origen: OrigenTitulo
  /** `tipo` crudo, para el chip técnico. '' si el documento no lo trae. */
  tipoCrudo: string
}

/**
 * Qué ocurrió, en una línea.
 *
 * Orden de autoridad: descripción persistida → etiqueta del tipo → genérico.
 * No concatena las tres: la descripción ya suele incluir el contexto, y
 * repetirlo produciría "Depósito confirmado · Depósito confirmado · Juan".
 */
export function tituloMovimiento(m: EntradaEventoAuditoria): TituloMovimiento {
  const tipoCrudo = texto(m.tipo)
  const desc = texto(m.descripcion)
  if (desc) return { titulo: desc, origen: 'descripcion', tipoCrudo }
  const porTipo = tipoCrudo ? ETIQUETA_TIPO[tipoCrudo] : undefined
  if (porTipo) return { titulo: porTipo, origen: 'tipo', tipoCrudo }
  // Tipo desconocido: no se traduce el identificador a prosa inventada. El
  // título queda genérico y el `tipo` crudo sigue visible en el chip.
  return { titulo: TITULO_GENERICO, origen: 'generico', tipoCrudo }
}

// ─── Rol registrado ───────────────────────────────────────────────────────────

/** Prefijo obligatorio: el valor solo es válido acompañado de "registrado". */
export const LABEL_ROL_REGISTRADO = 'Rol registrado'
export const ROL_NO_DISPONIBLE = 'No disponible'

const ETIQUETA_ROL: Record<string, string> = {
  gestor: 'Gestor',
  motorizado: 'Motorizado',
  sistema: 'Sistema',
}

/**
 * Rol tal como quedó REGISTRADO en el movimiento. No es el rol real del
 * actor: ver regla 2 de la cabecera. Un valor fuera del enum —incluido
 * 'admin', que el writer nunca escribe— cae a "No disponible" en vez de
 * afirmar una jerarquía que este documento no puede demostrar.
 */
export function etiquetaRolRegistrado(rol: string | null | undefined): string {
  const clave = texto(rol).toLowerCase()
  return ETIQUETA_ROL[clave] ?? ROL_NO_DISPONIBLE
}

// ─── Anulación ────────────────────────────────────────────────────────────────

export interface DetalleAnulacion {
  /** Quién la ejecutó, si el documento lo trae. */
  porUid: string | null
  motivo: string | null
  /** Movimiento que la revirtió, si existe. */
  movimientoId: string | null
  /** `anuladoAt` crudo; la página lo formatea. */
  at: unknown
}

/**
 * ¿El movimiento sigue vigente?
 *
 * `estado === 'anulado'` es la señal principal, pero no la única: un documento
 * con rastro de anulación (`anuladoAt`, `anuladoPorMovimientoId`) cuyo
 * `estado` quedó sin actualizar sigue estando revertido. Ante rastro de
 * anulación se marca como anulado: presentar como vigente algo ya revertido
 * es el error caro.
 */
export function estaAnulado(m: EntradaEventoAuditoria): boolean {
  if (texto(m.estado).toLowerCase() === 'anulado') return true
  return Boolean(
    texto(m.anuladoPorMovimientoId) ||
    texto(m.anuladoPorUid) ||
    texto(m.motivoAnulacion) ||
    (m.anuladoAt !== undefined && m.anuladoAt !== null),
  )
}

/**
 * Datos de la anulación, solo los persistidos. Devuelve null cuando el
 * movimiento está vigente o cuando no hay ni un campo que mostrar — para que
 * la UI no pinte una ficha de anulación vacía.
 */
export function detalleAnulacion(m: EntradaEventoAuditoria): DetalleAnulacion | null {
  if (!estaAnulado(m)) return null
  const porUid = texto(m.anuladoPorUid) || null
  const motivo = texto(m.motivoAnulacion) || null
  const movimientoId = texto(m.anuladoPorMovimientoId) || null
  const at = m.anuladoAt ?? null
  if (!porUid && !motivo && !movimientoId && at === null) return null
  return { porUid, motivo, movimientoId, at }
}

// ─── Referencias ──────────────────────────────────────────────────────────────

export type ClaveRef =
  | 'solicitud'
  | 'deposito'
  | 'motorizado'
  | 'comercio'
  | 'saldo'
  | 'gasto'
  | 'liquidacion'

export interface RefMovimiento {
  clave: ClaveRef
  etiqueta: string
  /** ID crudo. Se conserva para trazabilidad, pero es dato secundario. */
  id: string
  /** Destino demostrable, o null: sin ruta la UI pinta texto plano. */
  ruta: string | null
  /** Aclaración corta cuando el ID no habla por sí solo. */
  nota?: string
  /** Órdenes de un depósito agrupado, cada una con su propia ruta. */
  ordenes?: { id: string; ruta: string }[]
}

const ETIQUETA_REF: Record<ClaveRef, string> = {
  solicitud: 'Solicitud',
  deposito: 'Depósito',
  motorizado: 'Motorizado',
  comercio: 'Comercio',
  saldo: 'Saldo',
  gasto: 'Gasto',
  liquidacion: 'Liquidación',
}

/**
 * Referencia al depósito.
 *
 * El movimiento de depósito guarda `depositoId` y `motorizadoId`, pero no
 * `solicitudId` (ver AUD-MOV-SIN-SOLICITUD), así que el destino solo se
 * conoce leyendo `ordenes_deposito`. Tres desenlaces:
 *
 *   · sin documento leído todavía → sin ruta, texto plano;
 *   · exactamente una orden      → ruta directa a su bloque #depositos;
 *   · varias órdenes             → NINGUNA ruta principal. El depósito no
 *     "es" de la primera orden de la lista; se ofrecen todas por separado.
 */
function refDeposito(depositoId: string, deposito?: DepositoRelacionado | null): RefMovimiento {
  const base: RefMovimiento = {
    clave: 'deposito',
    etiqueta: ETIQUETA_REF.deposito,
    id: depositoId,
    ruta: null,
  }
  const ids = (deposito?.solicitudIds ?? [])
    .map((x) => texto(x))
    .filter((x) => x !== '')
  if (deposito == null || ids.length === 0) return base
  if (ids.length === 1) return { ...base, ruta: rutaOrden(ids[0], 'depositos') }
  const ordenes = ids
    .map((id) => ({ id, ruta: rutaOrden(id, 'depositos') }))
    .filter((o): o is { id: string; ruta: string } => o.ruta !== null)
  return {
    ...base,
    nota: `${ids.length} órdenes`,
    ...(ordenes.length > 0 ? { ordenes } : {}),
  }
}

/**
 * Referencias del movimiento, en orden de utilidad para decidir.
 *
 * Solo Solicitud y Depósito tienen destino: no existe superficie por
 * motorizado, comercio, saldo, gasto ni liquidación (auditado en el
 * diagnóstico). Esas se devuelven con `ruta: null` en vez de omitirse —
 * siguen siendo trazabilidad, solo que no se navega a ellas.
 */
export function refsMovimiento(
  m: EntradaEventoAuditoria,
  deposito?: DepositoRelacionado | null,
): RefMovimiento[] {
  const refs: RefMovimiento[] = []

  const solicitudId = texto(m.solicitudId)
  if (solicitudId) {
    refs.push({
      clave: 'solicitud',
      etiqueta: ETIQUETA_REF.solicitud,
      id: solicitudId,
      ruta: rutaOrden(solicitudId, 'historial'),
    })
  }

  const depositoId = texto(m.depositoId)
  if (depositoId) refs.push(refDeposito(depositoId, deposito))

  const planas: [ClaveRef, string][] = [
    ['motorizado', texto(m.motorizadoId)],
    ['comercio', texto(m.comercioId)],
    ['saldo', texto(m.saldoId)],
    ['gasto', texto(m.gastoId)],
    ['liquidacion', texto(m.liquidacionId)],
  ]
  for (const [clave, id] of planas) {
    if (id) refs.push({ clave, etiqueta: ETIQUETA_REF[clave], id, ruta: null })
  }

  return refs
}

// ─── Motorizado ───────────────────────────────────────────────────────────────

export interface MotorizadoResuelto {
  nombre: string
  /** El id del documento, no lo que venía en el movimiento. */
  id: string
  /** false cuando la fila existe pero no tiene nombre legible. */
  tieneNombre: boolean
}

/**
 * Nombre del motorizado sin una sola lectura extra: la colección `motorizado`
 * ya está en memoria en Auditoría.
 *
 * El movimiento guarda a veces el id del documento y a veces el `authUid`
 * —los writers no son consistentes—, así que se busca por ambos. El filtro de
 * la pantalla ya operaba con este mismo criterio.
 */
export function resolverMotorizado(
  motorizadoId: string | null | undefined,
  motorizados: readonly MotorizadoConocido[],
): MotorizadoResuelto | null {
  const buscado = texto(motorizadoId)
  if (!buscado) return null
  const fila = motorizados.find((x) => x.id === buscado || texto(x.authUid) === buscado)
  if (!fila) return null
  const nombre = texto(fila.nombre)
  return { nombre, id: fila.id, tieneNombre: nombre !== '' }
}
