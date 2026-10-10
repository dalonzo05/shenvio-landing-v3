// lib/evidencia-path.ts
//
// A4-02 · P1-C — AUTORIDAD DEL PATH DE EVIDENCIA (puro, sin firebase-admin).
//
// Un `pathStorage` guardado en solicitudes_envio es un dato que el cliente pudo
// escribir: el motorizado asignado puede actualizar evidencias,
// evidenciasTerminal y evidenciasCargotrans, y el staff cualquier campo. Las
// Storage Rules protegen al CLIENTE SDK, pero dos consumidores usan el Admin
// SDK, que NO pasa por esas Rules:
//
//   · resolverEvidencia (lib/temporary-access.ts) — descarga y sirve el objeto
//     al navegador del comercio/destinatario;
//   · lib/storage-cleanup.ts — borra el objeto pasados 45 días.
//
// Sin validar el path contra la orden, un pathStorage apuntado a
// `depositos/…`, `saldos/…`, `liquidaciones/…` o `evidencias/{OTRA}/…` cruzaba
// la frontera de Storage Rules: el servidor leía —o borraba— con permisos de
// admin lo que el cliente jamás habría podido tocar.
//
// Este módulo es la ÚNICA definición de "este path pertenece a esta solicitud
// para este tipo de evidencia". Comparación EXACTA de strings contra el path
// que el sistema construye al subir (fb/storage.ts): nada de startsWith
// ('evidencias/' no basta: permitiría otra solicitud), nada de normalizar
// (`..`, `//`, `%2e`, `\` simplemente no coinciden), y la `url` del documento
// NUNCA entra en la decisión.

export type KindEvidencia =
  | 'retiro'
  | 'entrega'
  | 'terminal_paquete'
  | 'terminal_ticket'
  | 'terminal_bus'
  | 'cargotrans_factura'
  | 'cargotrans_paquete'
  | 'delivery_boucher_comercio'
  | 'delivery_boucher_gestor'

/** Evidencia operativa: la que limpia lib/storage-cleanup.ts. */
export type KindEvidenciaOperativa = Exclude<KindEvidencia, 'delivery_boucher_comercio' | 'delivery_boucher_gestor'>

/** Nombre de archivo EXACTO por kind. cargotrans_paquete es indexado (regex). */
const NOMBRE_FIJO: Readonly<Record<Exclude<KindEvidencia, 'cargotrans_paquete'>, string>> = {
  retiro: 'retiro.jpg',
  entrega: 'entrega.jpg',
  terminal_paquete: 'terminal_paquete.jpg',
  terminal_ticket: 'terminal_ticket.jpg',
  terminal_bus: 'terminal_bus.jpg',
  cargotrans_factura: 'cargotrans_factura.jpg',
  delivery_boucher_comercio: 'delivery_boucher_comercio.jpg',
  delivery_boucher_gestor: 'delivery_boucher_gestor.jpg',
}

// Mismo patrón que storage.rules::nombreValidoEvidenciasMotorizado()
// ('cargotrans_paquete_[0-9]+\\.jpg'), con tope de dígitos para no aceptar
// basura numérica gigante.
const CARGOTRANS_PAQUETE_RE = /^cargotrans_paquete_[0-9]{1,6}\.jpg$/

// Un id de solicitud es un id automático de Firestore (alfanumérico). Se exige
// un solo segmento sin separadores ni puntos: así ninguna interpolación puede
// colar `/`, `..` ni un prefijo distinto.
const ID_SEGURO_RE = /^[A-Za-z0-9_-]{1,128}$/

export function esIdSolicitudSeguro(solicitudId: unknown): solicitudId is string {
  return typeof solicitudId === 'string' && ID_SEGURO_RE.test(solicitudId)
}

/** Kind operativo de un nombre de archivo, o null si no es evidencia operativa. */
export function clasificarNombreEvidenciaOperativa(filename: string): KindEvidenciaOperativa | null {
  switch (filename) {
    case NOMBRE_FIJO.retiro:
      return 'retiro'
    case NOMBRE_FIJO.entrega:
      return 'entrega'
    case NOMBRE_FIJO.terminal_paquete:
      return 'terminal_paquete'
    case NOMBRE_FIJO.terminal_ticket:
      return 'terminal_ticket'
    case NOMBRE_FIJO.terminal_bus:
      return 'terminal_bus'
    case NOMBRE_FIJO.cargotrans_factura:
      return 'cargotrans_factura'
    default:
      return CARGOTRANS_PAQUETE_RE.test(filename) ? 'cargotrans_paquete' : null
  }
}

function nombreCoincide(kind: KindEvidencia, nombre: string): boolean {
  if (kind === 'cargotrans_paquete') return CARGOTRANS_PAQUETE_RE.test(nombre)
  return Object.prototype.hasOwnProperty.call(NOMBRE_FIJO, kind) && nombre === NOMBRE_FIJO[kind]
}

/**
 * ¿`pathStorage` es exactamente un objeto de evidencia del tipo `kind` de la
 * solicitud `solicitudId`?
 *
 * Falla cerrado ante cualquier tipo inesperado. Devuelve false para: otra
 * solicitud, depositos/, saldos/, liquidaciones/, motorizados/, traversal
 * (`..`, `//`, `\`, `%2e`), subcarpeta inesperada, basename fuera de la
 * allowlist del kind y un kind que no corresponde al basename.
 */
export function esPathEvidenciaDeSolicitud(
  solicitudId: unknown,
  kind: unknown,
  pathStorage: unknown,
): boolean {
  if (!esIdSolicitudSeguro(solicitudId)) return false
  if (typeof kind !== 'string' || typeof pathStorage !== 'string') return false
  const prefijo = `evidencias/${solicitudId}/`
  if (!pathStorage.startsWith(prefijo)) return false
  const nombre = pathStorage.slice(prefijo.length)
  // Un solo segmento después del prefijo: `a/b.jpg` es subcarpeta inesperada.
  if (nombre.length === 0 || nombre.includes('/')) return false
  return nombreCoincide(kind as KindEvidencia, nombre)
}

// ── Extracción desde el documento de la orden ───────────────────────────────

type DatosOrden = { [campo: string]: any }

export interface RefEvidenciaOperativa {
  kind: KindEvidenciaOperativa
  pathStorage: string
}

/**
 * Referencias de evidencia operativa de UNA orden, SOLO las que apuntan a un
 * objeto de ESA orden. Una referencia con path ajeno se ignora: no es una
 * evidencia de esta solicitud y nadie debe leerla ni borrarla en su nombre.
 *
 * Nunca lee evidencias.deposito, cobroDelivery.* ni campo financiero alguno.
 */
export function extraerEvidenciaOperativaDeSolicitud(
  solicitudId: string,
  data: DatosOrden,
): RefEvidenciaOperativa[] {
  const out: RefEvidenciaOperativa[] = []
  const push = (kind: KindEvidenciaOperativa, pathStorage: unknown) => {
    if (esPathEvidenciaDeSolicitud(solicitudId, kind, pathStorage)) {
      out.push({ kind, pathStorage: pathStorage as string })
    }
  }

  push('retiro', data?.evidencias?.retiro?.pathStorage)
  push('entrega', data?.evidencias?.entrega?.pathStorage)
  push('terminal_paquete', data?.evidenciasTerminal?.fotoPaquete?.pathStorage)
  push('terminal_ticket', data?.evidenciasTerminal?.fotoTicket?.pathStorage)
  push('terminal_bus', data?.evidenciasTerminal?.fotoBus?.pathStorage)
  push('cargotrans_factura', data?.evidenciasCargotrans?.factura?.pathStorage)

  const fotos = Array.isArray(data?.evidenciasCargotrans?.fotos) ? data.evidenciasCargotrans.fotos : []
  for (const f of fotos as Array<{ pathStorage?: unknown }>) {
    push('cargotrans_paquete', f?.pathStorage)
  }
  return out
}

// ── Resolución para servir (temporary-access) ────────────────────────────────

export interface EvidenciaResuelta {
  pathStorage: string
  contentType: 'image/jpeg'
}

const KIND_CARGOTRANS_PAQUETE_N = /^cargotrans-paquete-([0-9]+)$/
const MOTORIZADO_DOC_ID_RE = /^[A-Za-z0-9_-]{1,128}$/

/**
 * Path REAL en Storage de una evidencia de la orden, validado contra ella.
 *
 * `kind` es el enum cerrado de la URL pública (kindValido en
 * lib/temporary-access.ts). El path sale del documento, nunca del request, y
 * además tiene que pasar esPathEvidenciaDeSolicitud: un documento con un
 * pathStorage ajeno devuelve null (→ 404), no un download.
 */
export function resolverPathEvidencia(
  solicitudId: string,
  s: DatosOrden,
  kind: string,
): EvidenciaResuelta | null {
  const valido = (kindPath: KindEvidencia, candidato: unknown): EvidenciaResuelta | null =>
    esPathEvidenciaDeSolicitud(solicitudId, kindPath, candidato)
      ? { pathStorage: candidato as string, contentType: 'image/jpeg' }
      : null

  switch (kind) {
    case 'retiro':
      return valido('retiro', s?.evidencias?.retiro?.pathStorage)
    case 'entrega':
      return valido('entrega', s?.evidencias?.entrega?.pathStorage)
    case 'terminal-paquete':
      return valido('terminal_paquete', s?.evidenciasTerminal?.fotoPaquete?.pathStorage)
    case 'terminal-ticket':
      return valido('terminal_ticket', s?.evidenciasTerminal?.fotoTicket?.pathStorage)
    case 'terminal-bus':
      return valido('terminal_bus', s?.evidenciasTerminal?.fotoBus?.pathStorage)
    case 'cargotrans-factura':
      return valido('cargotrans_factura', s?.evidenciasCargotrans?.factura?.pathStorage)
    case 'delivery-boucher': {
      // El servidor decide cuál objeto según boucherVigente — el navegador
      // nunca elige 'comercio' vs 'gestor'. Este objeto usa el campo 'path',
      // no 'pathStorage' (naming distinto, confirmado en el tipo real).
      const vigente = s?.cobroDelivery?.boucherVigente
      if (vigente === 'gestor') return valido('delivery_boucher_gestor', s?.cobroDelivery?.boucherGestor?.path)
      if (vigente === 'comercio') return valido('delivery_boucher_comercio', s?.cobroDelivery?.boucherComercio?.path)
      return null
    }
    case 'motorizado-foto': {
      // La orden solo guarda una URL; el path real es predecible:
      // motorizados/{motorizadoId}/foto.jpg. motorizadoId es el doc-id interno
      // y se usa solo server-side. Se exige un solo segmento seguro para que
      // un id fabricado no pueda salirse de motorizados/.
      const motorizadoId = s?.asignacion?.motorizadoId
      return typeof motorizadoId === 'string' && MOTORIZADO_DOC_ID_RE.test(motorizadoId)
        ? { pathStorage: `motorizados/${motorizadoId}/foto.jpg`, contentType: 'image/jpeg' }
        : null
    }
    default: {
      const m = kind.match(KIND_CARGOTRANS_PAQUETE_N)
      if (!m) return null
      const foto = s?.evidenciasCargotrans?.fotos?.[Number(m[1]) - 1]
      // El índice de la galería NO tiene que coincidir con el número del
      // archivo: limpiar un paquete desplaza el arreglo.
      return valido('cargotrans_paquete', foto?.pathStorage)
    }
  }
}
