// DRAWER-CONTEXTUAL-1 — Qué muestra el drawer de una orden, y qué muestra su
// segundo nivel cuando el gestor entra a un depósito.
//
// Dos capas como máximo: el listado detrás (Cobros, Depósitos, Solicitudes) y
// el drawer. Entrar a un depósito NO abre una tercera: cambia el contenido del
// mismo drawer, con vuelta a la orden.
//
// COMPONE, no decide. El resumen es el mismo de la ficha
// (resumen-ejecutivo-orden) y los depósitos, los mismos de "Depósitos
// asociados" (depositos-asociados). Acá no hay regla financiera nueva ni una
// segunda fuente de verdad, y nunca se suman obligaciones distintas.
//
// PURO: sin Firestore, sin React.

import {
  resumenEjecutivoOrden,
  type EntradaResumenEjecutivo,
  type OpcionesResumenEjecutivo,
  type ResumenEjecutivo,
  SIN_DATO,
} from './resumen-ejecutivo-orden'
import { filasDepositosAsociados, type FilaDepositoAsociado } from './depositos-asociados'
import type { DepositoRegistrado, DestinoDeposito } from './deposito-orden'
import {
  identidadDeposito,
  estadoDeposito,
  claseDeposito,
  origenDestinoDeposito,
  comprobanteDeposito,
  nombreMotorizadoDeposito,
} from './presentacion-deposito'
import { momentosDeposito, type MomentoDeposito } from './pago-transferencia'
import { normalizarMotivoEvento } from './deposito-eventos'

// ─── Copy ─────────────────────────────────────────────────────────────────────

export const TEXTO_REVISAR_DEPOSITO = 'Revisar depósito'
export const TEXTO_VOLVER_ORDEN = 'Volver a la orden'
export const TEXTO_VER_EN_DEPOSITOS = 'Ver en Depósitos'
export const TEXTO_VER_FICHA = 'Ver ficha completa'
/** La única ruta de depósitos que existe: no se inventa una por DEP. */
export const RUTA_DEPOSITOS = '/panel/gestor/depositos'

// ─── ¿Se puede revisar este depósito? ─────────────────────────────────────────

/** Estado en el que un depósito del motorizado espera la revisión del gestor. */
export const ESTADO_REVISABLE = 'en_revision'
/** Quién revisa depósitos. El digitador registra, no confirma. */
export const ROLES_REVISION = ['gestor', 'admin']

export type MotivoNoRevisable = 'sin_deposito' | 'tipo_c' | 'rol' | 'estado'

/**
 * El tipo C (pago del delivery por transferencia) NO se revisa como un
 * depósito del motorizado: su corrección es Cobros → Revertir. Y un depósito
 * confirmado, devuelto, anulado o todavía sin comprobante no está en revisión.
 */
export function motivoNoRevisable(
  dep: DepositoRegistrado | null | undefined,
  rol: string | null | undefined,
): MotivoNoRevisable | null {
  if (!dep) return 'sin_deposito'
  if (claseDeposito(dep) === 'transferencia_delivery') return 'tipo_c'
  if (!ROLES_REVISION.includes(typeof rol === 'string' ? rol : '')) return 'rol'
  if ((dep.estado ?? '') !== ESTADO_REVISABLE) return 'estado'
  return null
}

export function puedeRevisarDeposito(
  dep: DepositoRegistrado | null | undefined,
  rol: string | null | undefined,
): boolean {
  return motivoNoRevisable(dep, rol) === null
}

/**
 * ¿Este depósito está esperando revisión? Solo mira el documento: tipo A/B y
 * estado 'en_revision'. Es lo que decide si el drawer ofrece ABRIR el contexto
 * del depósito, que es de solo lectura y no necesita saber el rol —así un
 * listado no tiene que leer el perfil para pintar una fila—. Las acciones que
 * sí escriben viven en el panel de Depósitos, que ya valida rol y Rules.
 */
export function depositoEnRevision(dep: DepositoRegistrado | null | undefined): boolean {
  const m = motivoNoRevisable(dep, ROLES_REVISION[0])
  return m === null
}

// ─── Vista de la orden en el drawer ───────────────────────────────────────────

export interface VistaDrawerOrden {
  resumen: ResumenEjecutivo
  /** Una línea por depósito, nunca un total. */
  liquidaciones: FilaDepositoAsociado[]
  /** IDs de los depósitos que el rol actual puede revisar ahora. */
  revisables: string[]
  /** IDs de los depósitos en revisión, mire quien mire: no depende del rol. */
  enRevision: string[]
}

export interface OpcionesVistaDrawer extends OpcionesResumenEjecutivo {
  /** Rol del usuario de la sesión; decide si "Revisar depósito" se ofrece. */
  rol?: string | null
  nombresActores?: Record<string, string>
}

export function vistaDrawerOrden(
  orden: EntradaResumenEjecutivo,
  opciones: OpcionesVistaDrawer = {},
): VistaDrawerOrden {
  const { rol = null, nombresActores = {}, depositos = [], ...resto } = opciones
  const limpios = depositos.filter((d): d is DepositoRegistrado => !!d && typeof d.id === 'string')
  return {
    resumen: resumenEjecutivoOrden(orden, { ...resto, depositos: limpios }),
    liquidaciones: filasDepositosAsociados(limpios, orden as never, (d) => nombreMotorizadoDeposito(d, nombresActores)),
    revisables: limpios.filter((d) => puedeRevisarDeposito(d, rol)).map((d) => d.id),
    enRevision: limpios.filter((d) => depositoEnRevision(d)).map((d) => d.id),
  }
}

// ─── De la lista canónica al índice por destino ───────────────────────────────

/**
 * Los depósitos asociados, indexados por destino, para las partes del drawer
 * que razonan por línea (obligación a StorkHub / al comercio): lineasDeposito,
 * trazabilidadPago, resumenOrden.
 *
 * La lista canónica es la de la query `solicitudIds array-contains`, que puede
 * traer más de uno por destino —un anulado cuyo puntero se liberó y el que lo
 * reemplazó—. Para cada destino manda:
 *
 *   1. el que apunta el registro de la orden (es el vigente por definición);
 *   2. si no hay puntero, el último NO anulado;
 *   3. si todos están anulados, el último.
 *
 * Así el índice describe la línea viva y la lista completa sigue mostrándose
 * entera en "Depósitos asociados", sin perder el anulado.
 */
export function depositosPorDestinoDeLaOrden(
  depositos: Array<DepositoRegistrado | null | undefined>,
  registro?: { deposito?: { storkhubDepositoId?: string | null; comercioDepositoId?: string | null } | null } | null,
): Partial<Record<DestinoDeposito, DepositoRegistrado | null>> {
  const limpios = depositos.filter((d): d is DepositoRegistrado => !!d && typeof d.id === 'string')
  const punteros: Partial<Record<DestinoDeposito, string | null>> = {
    storkhub: registro?.deposito?.storkhubDepositoId ?? null,
    comercio: registro?.deposito?.comercioDepositoId ?? null,
  }
  const out: Partial<Record<DestinoDeposito, DepositoRegistrado | null>> = {}
  for (const destino of ['storkhub', 'comercio'] as DestinoDeposito[]) {
    const candidatos = limpios.filter((d) => destinoDeDeposito(d) === destino)
    if (candidatos.length === 0) continue
    const puntero = punteros[destino]
    const apuntado = puntero ? candidatos.find((d) => d.id === puntero) : undefined
    if (apuntado) { out[destino] = apuntado; continue }
    const ordenados = [...candidatos].sort((a, b) => msCreado(a) - msCreado(b))
    const vivos = ordenados.filter((d) => (d.estado ?? '') !== 'anulado')
    out[destino] = (vivos.length > 0 ? vivos : ordenados)[Math.max(0, (vivos.length > 0 ? vivos : ordenados).length - 1)]
  }
  return out
}

/** El destino real del documento; el tipo C va a StorkHub, como su puntero. */
function destinoDeDeposito(dep: DepositoRegistrado): DestinoDeposito {
  return dep.destinatario === 'comercio' ? 'comercio' : 'storkhub'
}

const msCreado = (dep: DepositoRegistrado): number => {
  const v = dep.creadoAt as { toDate?: () => Date } | string | number | null | undefined
  if (typeof v === 'string' || typeof v === 'number') { const t = new Date(v).getTime(); return Number.isFinite(t) ? t : 0 }
  const d = typeof v?.toDate === 'function' ? v.toDate() : null
  return d ? d.getTime() : 0
}

// ─── Segundo nivel: el depósito ───────────────────────────────────────────────

export interface ContextoDeposito {
  id: string
  codigo: string
  estado: string
  estadoClave: string | null
  monto: string
  destino: string
  motorizado: string
  ordenesIncluidas: number
  esAgrupado: boolean
  comprobante: string | null
  /** Versión vigente del comprobante cuando se corrigió (≥ 2); null si nunca. */
  version: number | null
  momentos: MomentoDeposito[]
  confirmadoPorUid: string | null
  /** Por qué se devolvió o se anuló, cuando el documento lo guarda. */
  motivo: string | null
  puedeRevisar: boolean
}

const money = (n: unknown) => (typeof n === 'number' && Number.isFinite(n) ? `C$ ${n.toLocaleString('es-NI')}` : SIN_DATO)

/**
 * Lo que el drawer muestra de un depósito. Solo campos del propio documento
 * —nada de auditoría nueva— y los mismos helpers de presentación que usan la
 * ficha y el panel de Depósitos.
 */
export function contextoDeposito(
  dep: DepositoRegistrado,
  orden?: Parameters<typeof momentosDeposito>[1],
  opciones: { rol?: string | null; nombresActores?: Record<string, string> } = {},
): ContextoDeposito {
  const { rol = null, nombresActores = {} } = opciones
  const ids = Array.isArray(dep.solicitudIds) ? dep.solicitudIds : []
  const v = dep.boucherVersion
  const motivo = normalizarMotivoEvento(dep.motivoDevolucion)
    || normalizarMotivoEvento((dep as { motivoAnulacion?: unknown }).motivoAnulacion)
    || normalizarMotivoEvento(dep.motivoRechazo)
  return {
    id: dep.id,
    codigo: identidadDeposito(dep).texto,
    estado: estadoDeposito(dep),
    estadoClave: dep.estado ?? null,
    monto: money(dep.montoTotal),
    destino: origenDestinoDeposito(dep, nombreMotorizadoDeposito(dep, nombresActores)).texto,
    motorizado: nombreMotorizadoDeposito(dep, nombresActores) ?? SIN_DATO,
    ordenesIncluidas: ids.length,
    esAgrupado: ids.length > 1,
    comprobante: comprobanteDeposito(dep),
    version: typeof v === 'number' && Number.isInteger(v) && v >= 2 ? v : null,
    momentos: momentosDeposito(dep, orden ?? null),
    confirmadoPorUid: dep.estado === 'confirmado' && typeof dep.confirmadoPorUid === 'string' && dep.confirmadoPorUid
      ? dep.confirmadoPorUid
      : null,
    motivo: motivo || null,
    puedeRevisar: puedeRevisarDeposito(dep, rol),
  }
}
