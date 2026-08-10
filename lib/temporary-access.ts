// ═══════════════════════════════════════════════════════════════════════════
// ACCESOS TEMPORALES — Bloque 1 (comercio)
// ═══════════════════════════════════════════════════════════════════════════
//
// Módulo server-only por convención de uso, no por dependencia nueva: usa
// 'crypto' de Node y el Admin SDK (fb/admin.ts), ninguno de los dos existe
// en el navegador — si algún día se importara desde un componente
// 'use client', el bundler fallaría al resolver 'crypto', que es la señal
// que se busca (no se instala el paquete 'server-only' para esto).
//
// Principio (D6/D7): el navegador de un link temporal NUNCA recibe el
// documento de solicitudes_envio ni una URL de Firebase Storage. Solo recibe
// lo que este archivo construye explícitamente — ver construirVistaComercio
// y resolverEvidencia. "if (tipo === 'comercio') return todo" está prohibido
// por diseño: cada campo que sale hacia el navegador está escrito a mano acá.

import { randomBytes, createHash } from 'crypto'
import { FieldValue, Timestamp } from 'firebase-admin/firestore'
import { adminDb } from '@/fb/admin'

// ─── Constantes ─────────────────────────────────────────────────────────────

const COLECCION = 'accesos_temporales'

// D1: vigencia fija, sin selector configurable en V1.
export const VIGENCIA_COMERCIO_MS = 48 * 60 * 60 * 1000

// Bloque 2 (destinatario) — D1: 24h máximo, pero nunca más que el padre
// (ver calcularExpiresAtDestinatario).
export const VIGENCIA_DESTINATARIO_MS = 24 * 60 * 60 * 1000

// Scope V1 — lista cerrada. La existencia del array no es decorativa: el
// endpoint de evidencia efectivamente revisa que el kind pedido esté cubierto
// por el scope guardado en el acceso (ver scopeRequeridoParaKind más abajo).
export const SCOPE_COMERCIO = [
  'order:read',
  'timeline:read',
  'financial-summary:read',
  'evidence:retiro',
  'evidence:entrega',
  'evidence:terminal',
  'evidence:cargotrans',
  'voucher:delivery',
  'motorizado:foto',
] as const

// Bloque 2 — D7/D6: cero información económica, cero retiro/terminal/
// cargotrans/bouchers. La ausencia de esos strings en este array es lo que
// hace DENY al endpoint de evidencia genérico (scopeRequeridoParaKind +
// acceso.scope.includes) sin tocar ese endpoint kind por kind.
export const SCOPE_DESTINATARIO = [
  'order-status:read',
  'timeline:read',
  'delivery-info:read',
  'motorizado:read',
  'evidence:entrega',
  'motorizado:foto',
] as const

// ─── Tipos ──────────────────────────────────────────────────────────────────

export type TipoAccesoTemporal = 'comercio' | 'destinatario'

export interface AccesoTemporal {
  tipo: TipoAccesoTemporal
  tokenHash: string
  solicitudId: string
  comercioId: string
  scope: string[]

  // D2 (destinatario): puntero obligatorio al acceso comercio padre. Ausente
  // en accesos tipo 'comercio'.
  parentAccessId?: string

  // creadoPorUid ausente cuando el hijo se crea desde el link temporal
  // comercio (sin Firebase Auth) — sección 6: "NO inventar UID". parentAccessId
  // ya es la trazabilidad completa en ese caso, no hace falta un campo extra.
  creadoPorUid?: string
  creadoPorRol: 'gestor' | 'admin' | 'comercio'

  createdAt: Timestamp
  expiresAt: Timestamp
  revokedAt?: Timestamp
  revokedByUid?: string
  motivoRevocacion?: string
  ultimoAccesoAt?: Timestamp
  contadorAccesos?: number
}

export type AccesoTemporalConId = AccesoTemporal & { id: string }

// ─── Token / hash ───────────────────────────────────────────────────────────
//
// D2: 32 bytes (256 bits) de entropía, base64url (URL-safe, sin padding
// problemático). Solo el HASH se persiste — el token en claro nunca toca
// Firestore ni un log. El lookup es por igualdad exacta de hash (una consulta
// where('tokenHash','==',...)), así que no hace falta un timingSafeEqual
// explícito: la comparación la resuelve el índice de Firestore, no una
// comparación de strings en nuestro código.

export function generarToken(): string {
  return randomBytes(32).toString('base64url')
}

export function hashToken(token: string): string {
  return createHash('sha256').update(token).digest('hex')
}

// ─── Lookup / validación ────────────────────────────────────────────────────

export async function buscarAccesoPorToken(token: string): Promise<AccesoTemporalConId | null> {
  const tokenHash = hashToken(token)
  const snap = await adminDb.collection(COLECCION).where('tokenHash', '==', tokenHash).limit(1).get()
  if (snap.empty) return null
  const d = snap.docs[0]
  return { id: d.id, ...(d.data() as AccesoTemporal) }
}

// Bloque 2: el hijo apunta al padre por id de documento (parentAccessId), no
// por token — nunca guardamos el token en claro del padre en ningún lado, así
// que la validación del padre se hace releyendo el doc directamente.
export async function obtenerAccesoPorId(accessId: string): Promise<AccesoTemporalConId | null> {
  const snap = await adminDb.collection(COLECCION).doc(accessId).get()
  if (!snap.exists) return null
  return { id: snap.id, ...(snap.data() as AccesoTemporal) }
}

function accesoVigente(acceso: AccesoTemporal): boolean {
  if (acceso.revokedAt) return false
  if (acceso.expiresAt.toMillis() <= Date.now()) return false
  return true
}

export type ResultadoValidacion =
  | { ok: true; acceso: AccesoTemporalConId }
  | { ok: false; motivo: 'no_encontrado' | 'expirado' | 'revocado' }

// Nunca confiar en un temporizador de cliente (sección 20): esta función es
// la única fuente de verdad, y se llama en CADA request — vista, datos y
// evidencia — no solo al abrir la página la primera vez.
export async function validarAcceso(token: string): Promise<ResultadoValidacion> {
  const acceso = await buscarAccesoPorToken(token)
  if (!acceso) return { ok: false, motivo: 'no_encontrado' }
  if (acceso.revokedAt) return { ok: false, motivo: 'revocado' }
  if (acceso.expiresAt.toMillis() <= Date.now()) return { ok: false, motivo: 'expirado' }
  return { ok: true, acceso }
}

// ─── Validación parent/child (Bloque 2 — D3) ────────────────────────────────
//
// Fail-closed: TODO request de un acceso tipo 'destinatario' revalida el
// padre en vivo — nunca basta con que el hijo mismo no esté vencido/revocado,
// porque expiresAt del hijo es una copia tomada al crearlo (sección 21: "no
// confiar solo en expiresAt copiado al hijo"). Esta función es la única
// entrada que usan tanto la vista (/s/[token]) como el endpoint de evidencia
// — ningún otro código vuelve a validar el padre por su cuenta.
export type ResultadoValidacionCompleta =
  | { ok: true; acceso: AccesoTemporalConId; parent?: AccesoTemporalConId }
  | { ok: false; motivo: 'no_encontrado' | 'expirado' | 'revocado' | 'parent_invalido' }

export async function validarAccesoCompleto(token: string): Promise<ResultadoValidacionCompleta> {
  const base = await validarAcceso(token)
  if (!base.ok) return base
  const { acceso } = base
  if (acceso.tipo !== 'destinatario') return { ok: true, acceso }

  if (!acceso.parentAccessId) return { ok: false, motivo: 'parent_invalido' }
  const parent = await obtenerAccesoPorId(acceso.parentAccessId)
  if (!parent) return { ok: false, motivo: 'parent_invalido' }
  if (parent.tipo !== 'comercio') return { ok: false, motivo: 'parent_invalido' }
  if (parent.solicitudId !== acceso.solicitudId) return { ok: false, motivo: 'parent_invalido' }
  if (parent.comercioId !== acceso.comercioId) return { ok: false, motivo: 'parent_invalido' }
  if (!accesoVigente(parent)) return { ok: false, motivo: 'parent_invalido' }

  return { ok: true, acceso, parent }
}

// D5: "un acceso" es la apertura de la vista/datos principal — una vez por
// request de vista, NUNCA desde el endpoint de evidencia (ver comentario en
// ese route handler).
export async function registrarAccesoVista(accessId: string): Promise<void> {
  await adminDb.collection(COLECCION).doc(accessId).update({
    ultimoAccesoAt: FieldValue.serverTimestamp(),
    contadorAccesos: FieldValue.increment(1),
  })
}

// revokedByUid opcional (Bloque 2, sección 15): cuando la revocación la
// dispara el propio comercio vía su link temporal (sin Firebase Auth), no
// hay UID que registrar — nunca se inventa uno. 'motivo' lleva la
// explicación real ('replaced', 'comercio_link_revoke', etc.) para que el
// documento siga siendo auditable sin falsear identidad.
export async function revocarAcceso(
  accessId: string,
  revokedByUid: string | undefined,
  motivo?: string
): Promise<{ ok: true; yaEstabaRevocado: boolean } | { ok: false; motivo: 'no_encontrado' }> {
  const ref = adminDb.collection(COLECCION).doc(accessId)
  const snap = await ref.get()
  if (!snap.exists) return { ok: false, motivo: 'no_encontrado' }
  const data = snap.data() as AccesoTemporal
  // Idempotente (sección 21): revocar dos veces no es un error, no
  // sobreescribe quién/cuándo revocó la primera vez.
  if (data.revokedAt) return { ok: true, yaEstabaRevocado: true }
  await ref.update({
    revokedAt: FieldValue.serverTimestamp(),
    ...(revokedByUid ? { revokedByUid } : {}),
    ...(motivo ? { motivoRevocacion: motivo } : {}),
  })
  return { ok: true, yaEstabaRevocado: false }
}

// ─── Generación (comercio) ──────────────────────────────────────────────────

export async function crearAccesoComercioTemporal(params: {
  solicitudId: string
  comercioId: string
  creadoPorUid: string
  creadoPorRol: 'gestor' | 'admin' | 'comercio'
}): Promise<{ id: string; token: string }> {
  const token = generarToken()
  const tokenHash = hashToken(token)
  const now = Timestamp.now()
  const expiresAt = Timestamp.fromMillis(now.toMillis() + VIGENCIA_COMERCIO_MS)

  const doc: AccesoTemporal = {
    tipo: 'comercio',
    tokenHash,
    solicitudId: params.solicitudId,
    comercioId: params.comercioId,
    scope: [...SCOPE_COMERCIO],
    creadoPorUid: params.creadoPorUid,
    creadoPorRol: params.creadoPorRol,
    createdAt: now,
    expiresAt,
  }
  const ref = await adminDb.collection(COLECCION).add(doc)
  return { id: ref.id, token }
}

// ─── Generación (destinatario) — Bloque 2 ───────────────────────────────────

// D5: allowlist explícita releída de los estados reales del flujo (ver
// EstadoSolicitud en app/panel/gestor/solicitudes/page.tsx) — nunca una
// comparación ambigua de strings. 'pendiente_confirmacion', 'rechazada' y
// 'cancelada' quedan fuera a propósito.
const ESTADOS_PERMITIDOS_DESTINATARIO = new Set([
  'confirmada', 'asignada', 'en_camino_retiro', 'retirado', 'en_camino_entrega', 'entregado',
])

export function estadoPermiteDestinatario(estado: unknown): boolean {
  return typeof estado === 'string' && ESTADOS_PERMITIDOS_DESTINATARIO.has(estado)
}

// D1: nunca más de 24h, y nunca más que lo que le queda al padre — sección 21
// ("parent vence en 6 horas → nuevo hijo expiresAt <= 6 horas", "no 24h ciegas").
function calcularExpiresAtDestinatario(parent: AccesoTemporalConId): Timestamp {
  const now = Date.now()
  const techoPropio = now + VIGENCIA_DESTINATARIO_MS
  const techoPadre = parent.expiresAt.toMillis()
  return Timestamp.fromMillis(Math.min(techoPropio, techoPadre))
}

// Comercio autenticado (sección 7 / decisión sección 9, opción A): reutiliza
// un acceso comercio vigente y no revocado de esta orden si ya existe;
// si no, crea uno nuevo — nunca deja un hijo sin un parent real. No hay
// límite de "un parent por orden" en el modelo (ya existían múltiples
// accesos comercio por gestor/admin antes de este bloque); simplemente se
// prefiere reutilizar el más reciente vigente para no acumular parents
// invisibles innecesarios.
export async function resolverOCrearAccesoComercioParent(params: {
  solicitudId: string
  comercioId: string
  creadoPorUid: string
}): Promise<AccesoTemporalConId> {
  const snap = await adminDb
    .collection(COLECCION)
    .where('tipo', '==', 'comercio')
    .where('solicitudId', '==', params.solicitudId)
    .where('comercioId', '==', params.comercioId)
    .get()

  const ahora = Date.now()
  let mejor: AccesoTemporalConId | null = null
  snap.docs.forEach((d) => {
    const data = { id: d.id, ...(d.data() as AccesoTemporal) }
    if (data.revokedAt) return
    if (data.expiresAt.toMillis() <= ahora) return
    if (!mejor || data.expiresAt.toMillis() > mejor.expiresAt.toMillis()) mejor = data
  })
  if (mejor) return mejor

  const { id } = await crearAccesoComercioTemporal({
    solicitudId: params.solicitudId,
    comercioId: params.comercioId,
    creadoPorUid: params.creadoPorUid,
    creadoPorRol: 'comercio',
  })
  const creado = await obtenerAccesoPorId(id)
  if (!creado) throw new Error('No se pudo releer el acceso comercio recién creado.')
  return creado
}

// D4: al crear un destinatario nuevo para el mismo parent, revoca los
// destinatarios activos previos de ese mismo parent — nunca acumula links
// vivos olvidados. No hay índice compuesto nuevo: se filtra en memoria sobre
// el resultado de una única query por parentAccessId (cardinalidad esperada
// muy baja — unos pocos documentos por parent en toda su vida).
async function revocarDestinatariosPreviosDelParent(parentAccessId: string): Promise<void> {
  const snap = await adminDb
    .collection(COLECCION)
    .where('tipo', '==', 'destinatario')
    .where('parentAccessId', '==', parentAccessId)
    .get()

  const activos = snap.docs.filter((d) => !(d.data() as AccesoTemporal).revokedAt)
  if (activos.length === 0) return

  const batch = adminDb.batch()
  activos.forEach((d) => {
    batch.update(d.ref, { revokedAt: FieldValue.serverTimestamp(), motivoRevocacion: 'replaced' })
  })
  await batch.commit()
}

export type ResultadoCrearDestinatario =
  | { ok: true; id: string; token: string }
  | { ok: false; motivo: 'parent_invalido' }

// Función central usada por AMBOS orígenes (comercio autenticado y link
// temporal comercio) — sección 1: "reutilizar... NO construir una segunda
// infraestructura paralela". El caller ya validó pertenencia/estado de la
// orden antes de llegar acá; esta función solo sabe de accesos.
export async function crearAccesoDestinatarioTemporal(params: {
  parent: AccesoTemporalConId
  solicitudId: string
  comercioId: string
  creadoPorUid?: string
}): Promise<ResultadoCrearDestinatario> {
  if (params.parent.tipo !== 'comercio' || !accesoVigente(params.parent)) {
    return { ok: false, motivo: 'parent_invalido' }
  }
  if (params.parent.solicitudId !== params.solicitudId || params.parent.comercioId !== params.comercioId) {
    return { ok: false, motivo: 'parent_invalido' }
  }

  await revocarDestinatariosPreviosDelParent(params.parent.id)

  const token = generarToken()
  const tokenHash = hashToken(token)
  const now = Timestamp.now()
  const expiresAt = calcularExpiresAtDestinatario(params.parent)

  const doc: AccesoTemporal = {
    tipo: 'destinatario',
    tokenHash,
    solicitudId: params.solicitudId,
    comercioId: params.comercioId,
    scope: [...SCOPE_DESTINATARIO],
    parentAccessId: params.parent.id,
    ...(params.creadoPorUid ? { creadoPorUid: params.creadoPorUid } : {}),
    creadoPorRol: 'comercio',
    createdAt: now,
    expiresAt,
  }
  const ref = await adminDb.collection(COLECCION).add(doc)
  return { ok: true, id: ref.id, token }
}

// Sección 16: "comercio vía link temporal puede revocar solo hijos cuyo
// parentAccessId == access comercio actual" — no recibe un id de destinatario
// desde el cliente (evita tener que verificar ownership de un id arbitrario);
// revoca lo que sea que esté activo bajo ESE parent, que es inequívoco por
// construcción (D4 ya garantiza que hay a lo sumo un hijo activo por parent).
export async function revocarDestinatarioActivoDelParent(
  parentAccessId: string
): Promise<{ huboActivo: boolean }> {
  const snap = await adminDb
    .collection(COLECCION)
    .where('tipo', '==', 'destinatario')
    .where('parentAccessId', '==', parentAccessId)
    .get()

  const activos = snap.docs.filter((d) => !(d.data() as AccesoTemporal).revokedAt)
  if (activos.length === 0) return { huboActivo: false }

  const batch = adminDb.batch()
  activos.forEach((d) => {
    batch.update(d.ref, { revokedAt: FieldValue.serverTimestamp(), motivoRevocacion: 'comercio_link_revoke' })
  })
  await batch.commit()
  return { huboActivo: true }
}

// ─── DTO — vista comercio (D6) ──────────────────────────────────────────────
//
// Todo lo que sigue construye, campo por campo, lo único que sale hacia el
// navegador. Nunca `return solicitud` ni un spread del documento.

const ESTADO_LABEL: Record<string, string> = {
  pendiente_confirmacion: 'Pendiente de confirmación',
  confirmada: 'Confirmada',
  asignada: 'Asignada a motorizado',
  en_camino_retiro: 'En camino al retiro',
  retirado: 'Paquete retirado',
  en_camino_entrega: 'En camino a entrega',
  entregado: 'Entregada',
  cancelada: 'Cancelada',
  rechazada: 'Solicitud rechazada',
}

function toMillis(v: unknown): number | null {
  if (!v) return null
  const t = v as { toMillis?: () => number }
  return typeof t.toMillis === 'function' ? t.toMillis() : null
}

// Compartido entre comercio y destinatario (Bloque 2) — datos operativos de
// logística fuera de Managua, cero costos (costoFlete/costoCargotrans quedan
// fuera de ambos DTOs, no solo del de destinatario).
export interface FueraManaguaDTO {
  metodoEnvio?: string
  destinoFinal?: string | null
  puntoLogisticoNombre?: string | null
  direccionPuntoLogistico?: string | null
  horarioApertura?: string | null
  horarioCierre?: string | null
  transporteNombre?: string | null
  transporteHoraSalida?: string | null
  terminalSugerida?: string | null
  cantidadPaquetes?: number
}

function construirFueraManagua(s: FirebaseFirestore.DocumentData): FueraManaguaDTO | undefined {
  if (s.tipoServicio !== 'fuera_managua' || !s.fueraManagua) return undefined
  return {
    metodoEnvio: s.fueraManagua.metodoEnvio,
    destinoFinal: s.fueraManagua.destinoFinal ?? null,
    puntoLogisticoNombre: s.fueraManagua.puntoLogisticoNombre ?? null,
    direccionPuntoLogistico: s.fueraManagua.direccionPuntoLogistico ?? null,
    horarioApertura: s.fueraManagua.horarioApertura ?? null,
    horarioCierre: s.fueraManagua.horarioCierre ?? null,
    transporteNombre: s.fueraManagua.transporteNombre ?? null,
    transporteHoraSalida: s.fueraManagua.transporteHoraSalida ?? null,
    terminalSugerida: s.fueraManagua.terminalSugerida ?? null,
    cantidadPaquetes: s.fueraManagua.cantidadPaquetes,
  }
}

// Compartido entre comercio y destinatario — AUDITORÍA FINAL (Gate B): NUNCA
// fotoUrl cruda — asignacion.motorizadoFotoUrl es una URL de Firebase
// Storage; entregarla tal cual (a) filtra un recurso permanente de Firebase
// igual que cualquier evidencia, y (b) esa carga de imagen de un tercero
// mandaría el token completo como Referer sin política explícita. 'tieneFoto'
// es solo una señal — la imagen real se sirve por el kind 'motorizado-foto'
// del propio endpoint de evidencia. Nunca motorizadoId/authUid.
export interface MotorizadoDTO {
  nombre: string
  tieneFoto: boolean
}

function construirMotorizado(s: FirebaseFirestore.DocumentData): MotorizadoDTO | undefined {
  return s.asignacion?.motorizadoNombre
    ? { nombre: s.asignacion.motorizadoNombre, tieneFoto: !!s.asignacion?.motorizadoId && !!s.asignacion?.motorizadoFotoUrl }
    : undefined
}

export interface VistaComercioTemporal {
  id: string
  estado: string
  estadoLabel: string
  createdAt: number | null
  entregadoAt: number | null
  ruta: {
    recoleccion: { nombreApellido?: string; celular?: string; direccionEscrita?: string; nota?: string | null }
    entrega: { nombreApellido?: string; celular?: string; direccionEscrita?: string; nota?: string | null }
    fueraManagua?: FueraManaguaDTO
    detalle?: string
  }
  timeline: Array<{ key: string; label: string; at: number }>
  motorizado?: MotorizadoDTO
  financiero: {
    delivery: { monto: number | null; pagado: boolean | null; label: string }
    cobroContraEntrega?: { monto: number; recibido: boolean | null }
  }
  rechazo?: { motivoTexto?: string; detalle?: string }
  evidenciasDisponibles: string[]
}

function construirTimeline(s: FirebaseFirestore.DocumentData): VistaComercioTemporal['timeline'] {
  const items = [
    { key: 'createdAt', label: 'Solicitud creada', ts: s.createdAt },
    { key: 'en_camino_retiro', label: 'En camino al retiro', ts: s.historial?.en_camino_retiroAt },
    { key: 'retirado', label: 'Paquete retirado', ts: s.historial?.retiradoAt },
    { key: 'en_camino_entrega', label: 'En camino a entrega', ts: s.historial?.en_camino_entregaAt },
    { key: 'entregado', label: 'Entregado al destinatario', ts: s.historial?.entregadoAt || s.entregadoAt },
  ]
  return items
    .map((i) => ({ key: i.key, label: i.label, at: toMillis(i.ts) }))
    .filter((i): i is { key: string; label: string; at: number } => i.at !== null)
}

function resumenFinanciero(s: FirebaseFirestore.DocumentData): VistaComercioTemporal['financiero'] {
  const precioConfirmado = s.confirmacion?.precioFinalCordobas
  const precioSugerido = s.pagoDelivery?.montoSugerido
  const monto =
    typeof precioConfirmado === 'number' ? precioConfirmado
    : typeof precioSugerido === 'number' ? precioSugerido
    : null

  const qp = s.pagoDelivery?.quienPaga || ''
  let pagado: boolean | null = null
  let label = 'Pendiente de entrega'
  if (s.tipoCliente === 'credito' || qp === 'credito_semanal') {
    pagado = false
    label = 'Crédito semanal — pendiente de cobro'
  } else if (qp === 'transferencia') {
    pagado = s.cobroDelivery?.estado === 'pagado'
    label = pagado ? 'Pagado por transferencia'
      : s.cobroDelivery?.estado === 'en_revision_deposito' ? 'En revisión por el gestor'
      : 'Pendiente — boucher de transferencia'
  } else if (s.cobrosMotorizado?.delivery !== undefined) {
    pagado = !!s.cobrosMotorizado.delivery.recibio
    label = pagado ? 'Cobrado al momento de la entrega' : 'No cobrado aún'
  }

  const cobroContraEntrega = s.cobroContraEntrega?.aplica
    ? {
        monto: s.cobroContraEntrega.monto ?? 0,
        recibido: s.cobrosMotorizado?.producto ? !!s.cobrosMotorizado.producto.recibio : null,
      }
    : undefined

  return { delivery: { monto, pagado, label }, cobroContraEntrega }
}

// ─── Evidencias — kinds y resolución de path (D7/sección 16-18) ────────────
//
// Enum cerrado a propósito (sección 19): nunca se acepta un path libre desde
// el cliente. El boucher de depósito AGRUPADO queda deliberadamente fuera de
// este bloque — ver nota en el reporte final, sección 18 del bloque.

const KIND_SIMPLES = new Set([
  'retiro', 'entrega', 'terminal-paquete', 'terminal-ticket', 'terminal-bus',
  'cargotrans-factura', 'delivery-boucher', 'motorizado-foto',
])
const KIND_CARGOTRANS_PAQUETE = /^cargotrans-paquete-([0-9]+)$/

const KIND_SCOPE: Record<string, string> = {
  retiro: 'evidence:retiro',
  entrega: 'evidence:entrega',
  'terminal-paquete': 'evidence:terminal',
  'terminal-ticket': 'evidence:terminal',
  'terminal-bus': 'evidence:terminal',
  'cargotrans-factura': 'evidence:cargotrans',
  'delivery-boucher': 'voucher:delivery',
  'motorizado-foto': 'motorizado:foto',
}

export function scopeRequeridoParaKind(kind: string): string | null {
  if (KIND_SCOPE[kind]) return KIND_SCOPE[kind]
  if (KIND_CARGOTRANS_PAQUETE.test(kind)) return 'evidence:cargotrans'
  return null
}

export function kindValido(kind: string): boolean {
  return KIND_SIMPLES.has(kind) || KIND_CARGOTRANS_PAQUETE.test(kind)
}

interface EvidenciaResuelta {
  pathStorage: string
  contentType: 'image/jpeg'
}

/** Resuelve el path REAL en Storage desde los campos ya existentes de la
 * orden — nunca desde un parámetro de ruta. Devuelve null si esa evidencia
 * no existe para esta orden (se traduce a 404 en el route handler). */
export function resolverEvidencia(s: FirebaseFirestore.DocumentData, kind: string): EvidenciaResuelta | null {
  switch (kind) {
    case 'retiro':
      return s.evidencias?.retiro?.pathStorage ? { pathStorage: s.evidencias.retiro.pathStorage, contentType: 'image/jpeg' } : null
    case 'entrega':
      return s.evidencias?.entrega?.pathStorage ? { pathStorage: s.evidencias.entrega.pathStorage, contentType: 'image/jpeg' } : null
    case 'terminal-paquete':
      return s.evidenciasTerminal?.fotoPaquete?.pathStorage ? { pathStorage: s.evidenciasTerminal.fotoPaquete.pathStorage, contentType: 'image/jpeg' } : null
    case 'terminal-ticket':
      return s.evidenciasTerminal?.fotoTicket?.pathStorage ? { pathStorage: s.evidenciasTerminal.fotoTicket.pathStorage, contentType: 'image/jpeg' } : null
    case 'terminal-bus':
      return s.evidenciasTerminal?.fotoBus?.pathStorage ? { pathStorage: s.evidenciasTerminal.fotoBus.pathStorage, contentType: 'image/jpeg' } : null
    case 'cargotrans-factura':
      return s.evidenciasCargotrans?.factura?.pathStorage ? { pathStorage: s.evidenciasCargotrans.factura.pathStorage, contentType: 'image/jpeg' } : null
    case 'delivery-boucher': {
      // Sección 17: el servidor decide cuál objeto según boucherVigente — el
      // navegador nunca elige 'comercio' vs 'gestor' directamente.
      const vigente = s.cobroDelivery?.boucherVigente
      const obj = vigente === 'gestor' ? s.cobroDelivery?.boucherGestor
        : vigente === 'comercio' ? s.cobroDelivery?.boucherComercio
        : null
      // Este objeto usa el campo 'path', no 'pathStorage' (naming distinto
      // al resto de evidencias — confirmado en el tipo real, no asumido).
      return obj?.path ? { pathStorage: obj.path, contentType: 'image/jpeg' } : null
    }
    case 'motorizado-foto': {
      // Gate B: la orden solo guarda asignacion.motorizadoFotoUrl (una URL
      // de Firebase), nunca un pathStorage — pero el path real es
      // predecible: motorizados/{motorizadoId}/foto.jpg (ver
      // uploadFotoMotorizado en fb/storage.ts y storage.rules). motorizadoId
      // es el doc-id interno; se usa solo server-side para construir el
      // path, nunca sale hacia el cliente.
      const motorizadoId = s.asignacion?.motorizadoId
      return typeof motorizadoId === 'string' && motorizadoId.length > 0
        ? { pathStorage: `motorizados/${motorizadoId}/foto.jpg`, contentType: 'image/jpeg' }
        : null
    }
    default: {
      const m = kind.match(KIND_CARGOTRANS_PAQUETE)
      if (!m) return null
      const idx = Number(m[1])
      const foto = s.evidenciasCargotrans?.fotos?.[idx - 1]
      return foto?.pathStorage ? { pathStorage: foto.pathStorage, contentType: 'image/jpeg' } : null
    }
  }
}

// 'motorizado-foto' se resuelve aparte (VistaComercioTemporal.motorizado.tieneFoto)
// y se renderiza como avatar, no en la galería general de evidencias.
const KINDS_GALERIA = [...KIND_SIMPLES].filter((k) => k !== 'motorizado-foto')

function kindsDisponibles(s: FirebaseFirestore.DocumentData): string[] {
  const kinds: string[] = []
  for (const kind of KINDS_GALERIA) {
    if (resolverEvidencia(s, kind)) kinds.push(kind)
  }
  const fotos = Array.isArray(s.evidenciasCargotrans?.fotos) ? s.evidenciasCargotrans.fotos : []
  fotos.forEach((f: { pathStorage?: string }, i: number) => {
    if (f?.pathStorage) kinds.push(`cargotrans-paquete-${i + 1}`)
  })
  return kinds
}

export function construirVistaComercio(solicitudId: string, s: FirebaseFirestore.DocumentData): VistaComercioTemporal {
  return {
    id: solicitudId,
    estado: s.estado ?? 'desconocido',
    estadoLabel: ESTADO_LABEL[s.estado] ?? String(s.estado ?? '—'),
    createdAt: toMillis(s.createdAt),
    entregadoAt: toMillis(s.entregadoAt),
    ruta: {
      recoleccion: {
        nombreApellido: s.recoleccion?.nombreApellido,
        celular: s.recoleccion?.celular,
        direccionEscrita: s.recoleccion?.direccionEscrita,
        nota: s.recoleccion?.nota ?? null,
      },
      entrega: {
        nombreApellido: s.entrega?.nombreApellido,
        celular: s.entrega?.celular,
        direccionEscrita: s.entrega?.direccionEscrita,
        nota: s.entrega?.nota ?? null,
      },
      fueraManagua: construirFueraManagua(s),
      detalle: s.detalle,
    },
    timeline: construirTimeline(s),
    motorizado: construirMotorizado(s),
    financiero: resumenFinanciero(s),
    rechazo: (s.estado === 'rechazada' && s.rechazo?.visibleParaComercio === true)
      ? { motivoTexto: s.rechazo.motivoTexto, detalle: s.rechazo.detalle ?? undefined }
      : undefined,
    evidenciasDisponibles: kindsDisponibles(s),
  }
}

// ─── DTO — vista destinatario (Bloque 2, D6/D7/D8) ──────────────────────────
//
// Mismo principio que construirVistaComercio: cada campo escrito a mano.
// Deliberadamente SIN: financiero (D7 — cero información económica), SIN
// recoleccion (no es asunto del destinatario ver el punto de retiro del
// comercio), SIN rechazo (D5 hace que generar un hijo para una orden
// 'rechazada' sea imposible desde el inicio, y la máquina de estados real no
// permite 'confirmada'→'rechazada', así que ese estado nunca puede aparecer
// bajo un hijo ya emitido — no hace falta el campo).
export interface VistaDestinatarioTemporal {
  id: string
  estado: string
  estadoLabel: string
  createdAt: number | null
  entrega: { nombreApellido?: string; celular?: string; direccionEscrita?: string; nota?: string | null }
  fueraManagua?: FueraManaguaDTO
  timeline: Array<{ key: string; label: string; at: number }>
  motorizado?: MotorizadoDTO
  evidenciaEntregaDisponible: boolean
}

export function construirVistaDestinatario(solicitudId: string, s: FirebaseFirestore.DocumentData): VistaDestinatarioTemporal {
  return {
    id: solicitudId,
    estado: s.estado ?? 'desconocido',
    estadoLabel: ESTADO_LABEL[s.estado] ?? String(s.estado ?? '—'),
    createdAt: toMillis(s.createdAt),
    entrega: {
      nombreApellido: s.entrega?.nombreApellido,
      celular: s.entrega?.celular,
      direccionEscrita: s.entrega?.direccionEscrita,
      nota: s.entrega?.nota ?? null,
    },
    fueraManagua: construirFueraManagua(s),
    timeline: construirTimeline(s),
    motorizado: construirMotorizado(s),
    evidenciaEntregaDisponible: !!resolverEvidencia(s, 'entrega'),
  }
}

// ─── Rate limit (sección 24) ────────────────────────────────────────────────
//
// Mismo patrón ya aceptado en app/api/proxy/route.ts: contador en memoria del
// proceso, por instancia, se reinicia en cada cold start — no es un límite
// distribuido. Es defensa en profundidad, no la protección principal (esa es
// la validación de token en sí). Un límite distribuido real exigiría
// almacenamiento compartido, fuera de alcance de este bloque.
//
// Cada route handler que lo use crea SU PROPIA instancia (import = módulo
// separado por archivo), así que generación/validación/evidencia quedan
// naturalmente separadas sin coordinarse entre sí.
export function crearLimitadorDeTasa(maxPeticiones: number, ventanaMs: number, maxClaves = 5_000) {
  const registro = new Map<string, number[]>()
  return function superaRateLimit(clave: string): boolean {
    const ahora = Date.now()
    if (registro.size > maxClaves) {
      for (const [k, marcas] of registro) {
        const vivas = marcas.filter((t) => ahora - t < ventanaMs)
        if (vivas.length === 0) registro.delete(k)
        else registro.set(k, vivas)
      }
    }
    const previas = (registro.get(clave) ?? []).filter((t) => ahora - t < ventanaMs)
    if (previas.length >= maxPeticiones) {
      registro.set(clave, previas)
      return true
    }
    previas.push(ahora)
    registro.set(clave, previas)
    return false
  }
}
