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
  origenDestinoDeposito,
  comprobanteDeposito,
  nombreMotorizadoDeposito,
} from './presentacion-deposito'
import { momentosDeposito, type MomentoDeposito } from './pago-transferencia'
import { normalizarMotivoEvento } from './deposito-eventos'

// ─── Copy ─────────────────────────────────────────────────────────────────────

/**
 * El segundo nivel es de SOLO LECTURA y el drawer es compartido (gestor,
 * comercio, reportes, dashboard): el verbo describe lo que el botón hace
 * —abrir el depósito— y no promete una aprobación financiera que acá no
 * existe. Confirmar y rechazar siguen viviendo en el panel de Depósitos.
 *
 * CONSULTAR NO ES OPERAR. La acción se ofrece para cualquier depósito
 * asociado y legible, en cualquier estado —pendiente_boucher, en_revision,
 * devuelto, confirmado, convertido_en_deuda, anulado— y también para el tipo
 * C. El estado cambia el badge y los datos, nunca el derecho a mirarlo.
 */
export const TEXTO_VER_DEPOSITO = 'Ver depósito'
export const TEXTO_VOLVER_ORDEN = 'Volver a la orden'
export const TEXTO_VER_EN_DEPOSITOS = 'Ver en Depósitos'
export const TEXTO_VER_FICHA = 'Ver ficha completa'
/** La única ruta de depósitos que existe: no se inventa una por DEP. */
export const RUTA_DEPOSITOS = '/panel/gestor/depositos'
/** Las rutas del gestor, las únicas desde donde RUTA_DEPOSITOS es navegable. */
export const AMBITO_GESTOR = '/panel/gestor'

/**
 * ¿Ofrecer "Ver en Depósitos"? Solo dentro del panel del gestor. El mismo
 * drawer se monta en /panel/comercio, y ahí ese enlace apuntaría a una ruta
 * que ese usuario no puede abrir: el contexto de solo lectura termina en la
 * vuelta a la orden. Se decide con el pathname que la superficie ya conoce —
 * ninguna lectura nueva, ningún rol— y por defecto NO se ofrece.
 */
export function permiteVerEnDepositos(pathname: string | null | undefined): boolean {
  if (typeof pathname !== 'string') return false
  return pathname === AMBITO_GESTOR || pathname.startsWith(`${AMBITO_GESTOR}/`)
}

// ─── Acceso al depósito desde una línea de liquidación ────────────────────────

export interface AccesoLiquidacion {
  destino: DestinoDeposito
  /** El documento que hay que abrir. null = no hay nada que consultar. */
  depositoId: string | null
  /** ¿Se ofrece abrir el depósito en esta línea? */
  abrible: boolean
}

/**
 * Para la columna "Liquidación" de Cobros: por cada línea de la orden, el
 * depósito que esa línea abre. Una entrada por línea y nunca una sola acción
 * agregada para toda la orden: SH-0005 liquida a StorkHub y al comercio con
 * DOS comprobantes distintos, y un botón único no diría cuál abre.
 *
 * Una línea sin documento a mano —pendiente, o registrada y no legible— no
 * ofrece nada: no se inventa un destino ni se dispara una lectura por fila.
 */
export function accesosLiquidacion(
  lineas: Array<{ destino: DestinoDeposito }>,
  depositos: Partial<Record<DestinoDeposito, DepositoRegistrado | null>> = {},
): AccesoLiquidacion[] {
  return lineas.map((l) => {
    const dep = depositos[l.destino] ?? null
    const depositoId = dep && typeof dep.id === 'string' && dep.id ? dep.id : null
    return { destino: l.destino, depositoId, abrible: depositoId !== null }
  })
}

// ─── Vista de la orden en el drawer ───────────────────────────────────────────

export interface VistaDrawerOrden {
  resumen: ResumenEjecutivo
  /**
   * Una línea por depósito, nunca un total. Cada una ofrece "Ver depósito":
   * la vista no trae ningún campo que filtre por estado o por rol, porque
   * consultar un depósito asociado no depende de ninguno de los dos.
   */
  liquidaciones: FilaDepositoAsociado[]
}

export interface OpcionesVistaDrawer extends OpcionesResumenEjecutivo {
  nombresActores?: Record<string, string>
}

export function vistaDrawerOrden(
  orden: EntradaResumenEjecutivo,
  opciones: OpcionesVistaDrawer = {},
): VistaDrawerOrden {
  const { nombresActores = {}, depositos = [], ...resto } = opciones
  const limpios = depositos.filter((d): d is DepositoRegistrado => !!d && typeof d.id === 'string')
  return {
    resumen: resumenEjecutivoOrden(orden, { ...resto, depositos: limpios }),
    liquidaciones: filasDepositosAsociados(limpios, orden as never, (d) => nombreMotorizadoDeposito(d, nombresActores)),
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
  /**
   * El motivo que el documento guarda, con la etiqueta del episodio al que
   * pertenece. Nunca "Motivo:" a secas: un DEP hoy confirmado conserva el
   * `motivoDevolucion` de su corrección anterior, y esa etiqueta suelta lo
   * hacía leer como el motivo de la confirmación.
   */
  motivo: MotivoContexto | null
}

export interface MotivoContexto {
  /** "Motivo de la corrección" | "Motivo de la anulación" | … */
  etiqueta: string
  texto: string
}

/** El motorizado subió otro comprobante: `motivoDevolucion`, estado devuelto. */
export const MOTIVO_CORRECCION = 'Motivo de la corrección'
/** `motivoAnulacion`, que escribe camposAnularDeposito y la reversión tipo C. */
export const MOTIVO_ANULACION = 'Motivo de la anulación'
/** `motivoRechazo`, que escribe el rechazo del panel de Depósitos. */
export const MOTIVO_RECHAZO = 'Motivo del rechazo'

/**
 * El motivo del depósito, etiquetado por el episodio del campo que lo guardó
 * —no por el estado actual—. Si el estado tiene su propio campo, ese manda;
 * si no, se muestra el que exista, diciendo de qué episodio viene. Así un DEP
 * confirmado que arrastra el motivo de su corrección lo dice como tal, y no
 * se mezclan motivos distintos bajo una etiqueta única.
 */
function motivoDeposito(dep: DepositoRegistrado): MotivoContexto | null {
  const candidatos: Array<[string, unknown]> = [
    [MOTIVO_CORRECCION, dep.motivoDevolucion],
    [MOTIVO_ANULACION, (dep as { motivoAnulacion?: unknown }).motivoAnulacion],
    [MOTIVO_RECHAZO, dep.motivoRechazo],
  ]
  const propioDelEstado: Record<string, string> = {
    devuelto: MOTIVO_CORRECCION,
    anulado: MOTIVO_ANULACION,
    rechazado: MOTIVO_RECHAZO,
  }
  const preferida = propioDelEstado[dep.estado ?? '']
  const ordenados = preferida
    ? [...candidatos].sort((a, b) => (a[0] === preferida ? -1 : b[0] === preferida ? 1 : 0))
    : candidatos
  for (const [etiqueta, valor] of ordenados) {
    const texto = normalizarMotivoEvento(valor)
    if (texto) return { etiqueta, texto }
  }
  return null
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
  opciones: { nombresActores?: Record<string, string> } = {},
): ContextoDeposito {
  const { nombresActores = {} } = opciones
  const ids = Array.isArray(dep.solicitudIds) ? dep.solicitudIds : []
  const v = dep.boucherVersion
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
    motivo: motivoDeposito(dep),
  }
}
