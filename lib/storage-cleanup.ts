// lib/storage-cleanup.ts
//
// STORAGE CLEANUP V1 — evidencia operativa solamente (retiro, entrega,
// terminal, Cargotrans). Nada financiero: depositos/*, saldos/*,
// saldos/*/propuestas/*, liquidaciones/*, delivery bouchers y cualquier
// nombre desconocido quedan fuera por construcción — este módulo nunca lee
// esos campos, no hace falta una denylist.
//
// Allowlist cerrada: classifyFilename() es la ÚNICA fuente de verdad sobre
// qué nombre de archivo es un candidato válido. "todo debajo de evidencias/"
// NUNCA es suficiente — cada extracción además vuelve a pasar por
// classifyFilename() como defensa en profundidad, incluso cuando el path ya
// viene de un campo Firestore conocido.
//
// Orden obligatorio en execute: Storage delete primero; metadata cleanup
// SOLO si el delete de Storage tuvo éxito. Nunca al revés (ver
// executeCandidates).

import { FieldValue, Timestamp } from 'firebase-admin/firestore'
import { adminDb, adminBucket } from '@/fb/admin'

export const RETENTION_DAYS = 45
export const MAX_CANDIDATES_PER_SCAN = 100
// Un scan viejo puede reflejar un estado de orden que ya cambió (ej. una
// reclamación reabrió el pedido). Pasado este plazo, execute rechaza todos
// sus candidatos con 'skipped_revalidation' en vez de confiar en el snapshot.
const SCAN_VALID_MS = 24 * 60 * 60 * 1000

const SCAN_COLLECTION = 'storage_cleanup_scans'
const SOLICITUDES_COLLECTION = 'solicitudes_envio'

export type CandidateKind =
  | 'retiro'
  | 'entrega'
  | 'terminal_paquete'
  | 'terminal_ticket'
  | 'terminal_bus'
  | 'cargotrans_factura'
  | 'cargotrans_paquete'

export type CandidateClass = 'expired_referenced' | 'orphan_unreferenced'

export type ExecuteResult =
  | 'deleted'
  | 'storage_delete_failed'
  | 'metadata_cleanup_failed'
  | 'skipped_revalidation'

export interface StorageCleanupCandidate {
  candidateId: string
  solicitudId: string
  kind: CandidateKind
  pathStorage: string
  classification: CandidateClass
  eligibleForDelete: boolean
  entregadoAtMillis: number | null
  ageDays: number | null
  result?: ExecuteResult
  resultAt?: number
  resultReason?: string
  executedByUid?: string
}

interface StorageCleanupScanDoc {
  scanId: string
  createdAt: FirebaseFirestore.Timestamp
  createdByUid: string
  cutoffMillis: number
  hasMore: boolean
  candidates: Record<string, StorageCleanupCandidate>
}

// ── Allowlist ────────────────────────────────────────────────────────────
// Mismos nombres que storage.rules::nombreValidoEvidenciasMotorizado(),
// restringidos a evidencia operativa (sin 'deposito.jpg' — es el boucher
// financiero del depósito, ver SolicitudDrawer label '🏦 Boucher').
const CARGOTRANS_PAQUETE_RE = /^cargotrans_paquete_[0-9]+\.jpg$/

export function classifyFilename(filename: string): CandidateKind | null {
  switch (filename) {
    case 'retiro.jpg':
      return 'retiro'
    case 'entrega.jpg':
      return 'entrega'
    case 'terminal_paquete.jpg':
      return 'terminal_paquete'
    case 'terminal_ticket.jpg':
      return 'terminal_ticket'
    case 'terminal_bus.jpg':
      return 'terminal_bus'
    case 'cargotrans_factura.jpg':
      return 'cargotrans_factura'
    default:
      return CARGOTRANS_PAQUETE_RE.test(filename) ? 'cargotrans_paquete' : null
  }
}

function basename(path: string): string {
  const parts = path.split('/')
  return parts[parts.length - 1] ?? ''
}

interface BucketFileEntry {
  name: string
  timeCreatedMillis: number | null
}

/**
 * Lista objetos bajo `prefix` normalizados a {name, timeCreatedMillis}.
 * `timeCreatedMillis` viene del metadata que ya incluye la respuesta de
 * listado de GCS (sin round-trip extra de getMetadata por archivo).
 * Defensivo: cualquier error de red/permiso devuelve [] en vez de tumbar
 * el scan completo — mismo criterio que el resto de este módulo.
 */
async function listEvidenciaPrefix(prefix: string, maxResults?: number): Promise<BucketFileEntry[]> {
  const [files] = await adminBucket
    .getFiles(maxResults ? { prefix, maxResults } : { prefix })
    .catch(() => [[]] as [Array<{ name: string; metadata?: { timeCreated?: string } }>])
  return files.map((f) => ({
    name: f.name,
    timeCreatedMillis: f.metadata?.timeCreated ? new Date(f.metadata.timeCreated).getTime() : null,
  }))
}

interface ExtractedRef {
  kind: CandidateKind
  pathStorage: string
}

/**
 * Extrae SOLO las referencias de evidencia operativa allowlisted de una
 * orden. Nunca lee evidencias.deposito, cobroDelivery.* ni ningún campo
 * financiero — el alcance está en los campos que se leen, no en un filtro
 * posterior.
 */
export function extractEvidenciaOperativa(data: FirebaseFirestore.DocumentData): ExtractedRef[] {
  const out: ExtractedRef[] = []

  const push = (kind: CandidateKind, pathStorage: unknown) => {
    if (typeof pathStorage === 'string' && pathStorage.length > 0 && classifyFilename(basename(pathStorage)) === kind) {
      out.push({ kind, pathStorage })
    }
  }

  push('retiro', data.evidencias?.retiro?.pathStorage)
  push('entrega', data.evidencias?.entrega?.pathStorage)
  push('terminal_paquete', data.evidenciasTerminal?.fotoPaquete?.pathStorage)
  push('terminal_ticket', data.evidenciasTerminal?.fotoTicket?.pathStorage)
  push('terminal_bus', data.evidenciasTerminal?.fotoBus?.pathStorage)
  push('cargotrans_factura', data.evidenciasCargotrans?.factura?.pathStorage)

  const fotos = Array.isArray(data.evidenciasCargotrans?.fotos) ? data.evidenciasCargotrans.fotos : []
  for (const f of fotos as Array<{ pathStorage?: unknown }>) {
    push('cargotrans_paquete', f?.pathStorage)
  }

  return out
}

// ── Scan ─────────────────────────────────────────────────────────────────

export interface RunScanResult {
  scanId: string
  hasMore: boolean
  candidateCount: number
}

/**
 * Admin-only. NO borra nada — solo lee y clasifica.
 *
 * expired_referenced: orden entregada, entregadoAt > 45 días, objeto
 * referenciado por Firestore Y verificado que existe en Storage.
 *
 * orphan_unreferenced: objeto allowlisted presente en Storage bajo
 * evidencias/{solicitudId}/ de una orden ya vieja, pero sin referencia en
 * Firestore. V1 conservador: SIEMPRE eligibleForDelete=false — no se fuerza
 * limpieza de huérfanos ambiguos (decisión de negocio ya cerrada).
 *
 * Cobertura de huérfanos con orden eliminada (pass 2 más abajo): un objeto
 * evidencias/{solicitudId}/archivo.jpg cuyo documento solicitudes_envio/
 * {solicitudId} ya no existe NUNCA aparecería en el loop de arriba, porque
 * ese loop solo visita `doc.id` de órdenes que la query devuelve. Ese caso
 * también se reporta como orphan_unreferenced/eligibleForDelete=false,
 * acotado por prefijo fijo 'evidencias/' (nunca depositos/saldos/
 * liquidaciones — namespaces distintos, ver storage.rules) y por el mismo
 * MAX_CANDIDATES_PER_SCAN — nunca un listado global del bucket.
 */
export async function runScan(actorUid: string): Promise<RunScanResult> {
  const cutoffMillis = Date.now() - RETENTION_DAYS * 24 * 60 * 60 * 1000
  const cutoff = Timestamp.fromMillis(cutoffMillis)

  // Se piden órdenes, no candidatos: una orden puede aportar varios
  // candidatos, así que MAX_CANDIDATES_PER_SCAN se aplica sobre candidatos
  // más abajo, no sobre este límite de órdenes.
  const snap = await adminDb
    .collection(SOLICITUDES_COLLECTION)
    .where('estado', '==', 'entregado')
    .where('entregadoAt', '<', cutoff)
    .orderBy('entregadoAt', 'asc')
    .limit(MAX_CANDIDATES_PER_SCAN)
    .get()

  const candidates: Record<string, StorageCleanupCandidate> = {}
  let hasMore = snap.size === MAX_CANDIDATES_PER_SCAN
  let seq = 0
  // Órdenes ya recorridas por el loop principal — pass 2 las salta para no
  // reprocesar ni duplicar candidatos sobre la misma solicitudId.
  const visitedSolicitudIds = new Set<string>()

  outer: for (const doc of snap.docs) {
    visitedSolicitudIds.add(doc.id)
    const data = doc.data()
    const entregadoAtMillis = data.entregadoAt instanceof Timestamp ? data.entregadoAt.toMillis() : null
    const ageDays = entregadoAtMillis ? Math.floor((Date.now() - entregadoAtMillis) / 86_400_000) : null

    const refs = extractEvidenciaOperativa(data)
    const referencedPaths = new Set(refs.map((r) => r.pathStorage))

    for (const ref of refs) {
      if (seq >= MAX_CANDIDATES_PER_SCAN) {
        hasMore = true
        break outer
      }
      const [existe] = await adminBucket
        .file(ref.pathStorage)
        .exists()
        .catch(() => [false] as [boolean])
      if (!existe) continue

      const candidateId = `c${seq}`
      seq++
      candidates[candidateId] = {
        candidateId,
        solicitudId: doc.id,
        kind: ref.kind,
        pathStorage: ref.pathStorage,
        classification: 'expired_referenced',
        eligibleForDelete: true,
        entregadoAtMillis,
        ageDays,
      }
    }

    // Huérfanos: acotado al mismo prefijo evidencias/{solicitudId}/ de una
    // orden ya candidata — nunca un listado global del bucket.
    if (seq >= MAX_CANDIDATES_PER_SCAN) {
      hasMore = true
      break
    }
    const [files] = await adminBucket
      .getFiles({ prefix: `evidencias/${doc.id}/` })
      .catch(() => [[]] as [Array<{ name: string }>])
    for (const file of files) {
      if (seq >= MAX_CANDIDATES_PER_SCAN) {
        hasMore = true
        break outer
      }
      const filename = basename(file.name)
      const kind = classifyFilename(filename)
      if (!kind) continue // no reconocido o hard deny (financiero/boucher) → nunca candidato
      if (referencedPaths.has(file.name)) continue // referenciado → no es huérfano

      const candidateId = `c${seq}`
      seq++
      candidates[candidateId] = {
        candidateId,
        solicitudId: doc.id,
        kind,
        pathStorage: file.name,
        classification: 'orphan_unreferenced',
        eligibleForDelete: false,
        entregadoAtMillis,
        ageDays,
      }
    }
  }

  // ── Pass 2: huérfanos de órdenes eliminadas de Firestore ────────────────
  // Ver comentario de runScan más arriba. Acotado: prefijo fijo
  // 'evidencias/', maxResults=MAX_CANDIDATES_PER_SCAN sobre el listado
  // superior, allowlist idéntica (classifyFilename), eligibleForDelete
  // SIEMPRE false y respeta el mismo tope de candidatos que el resto.
  if (seq < MAX_CANDIDATES_PER_SCAN) {
    const topLevel = await listEvidenciaPrefix('evidencias/', MAX_CANDIDATES_PER_SCAN)
    if (topLevel.length === MAX_CANDIDATES_PER_SCAN) hasMore = true

    const unvisitedSolicitudIds = new Set<string>()
    for (const f of topLevel) {
      const parts = f.name.split('/')
      if (parts.length < 3 || parts[0] !== 'evidencias') continue
      if (!visitedSolicitudIds.has(parts[1])) unvisitedSolicitudIds.add(parts[1])
    }

    pass2: for (const solicitudId of unvisitedSolicitudIds) {
      visitedSolicitudIds.add(solicitudId) // no reprocesar el mismo id dos veces

      // La orden existe pero no calificó en la query (no entregada / no
      // vieja todavía) → no es el caso 'orden eliminada', no se toca acá.
      const solicitudSnap = await adminDb.collection(SOLICITUDES_COLLECTION).doc(solicitudId).get()
      if (solicitudSnap.exists) continue

      const orphanFiles = await listEvidenciaPrefix(`evidencias/${solicitudId}/`)
      for (const f of orphanFiles) {
        if (seq >= MAX_CANDIDATES_PER_SCAN) {
          hasMore = true
          break pass2
        }
        const filename = basename(f.name)
        const kind = classifyFilename(filename)
        if (!kind) continue // no reconocido o hard deny (financiero/boucher) → nunca candidato
        // Sin doc de orden no hay entregadoAt de referencia — se usa la
        // antigüedad del objeto mismo en Storage.
        if (!f.timeCreatedMillis || f.timeCreatedMillis >= cutoffMillis) continue

        const candidateId = `c${seq}`
        seq++
        candidates[candidateId] = {
          candidateId,
          solicitudId,
          kind,
          pathStorage: f.name,
          classification: 'orphan_unreferenced',
          eligibleForDelete: false,
          entregadoAtMillis: null,
          ageDays: Math.floor((Date.now() - f.timeCreatedMillis) / 86_400_000),
        }
      }
    }
  }

  const scanRef = adminDb.collection(SCAN_COLLECTION).doc()
  await scanRef.set({
    scanId: scanRef.id,
    createdAt: FieldValue.serverTimestamp(),
    createdByUid: actorUid,
    cutoffMillis,
    hasMore,
    candidates,
  })

  return { scanId: scanRef.id, hasMore, candidateCount: Object.keys(candidates).length }
}

// ── Execute ──────────────────────────────────────────────────────────────

export interface ExecuteOutcome {
  candidateId: string
  result: ExecuteResult
  reason: string
}

async function persistResult(
  scanRef: FirebaseFirestore.DocumentReference,
  candidateId: string,
  result: ExecuteResult,
  actorUid: string,
  reason: string,
): Promise<void> {
  try {
    await scanRef.update({
      [`candidates.${candidateId}.result`]: result,
      [`candidates.${candidateId}.resultAt`]: FieldValue.serverTimestamp(),
      [`candidates.${candidateId}.executedByUid`]: actorUid,
      [`candidates.${candidateId}.resultReason`]: reason.slice(0, 200),
    })
  } catch (err) {
    console.error(
      '[storage-cleanup] no se pudo persistir auditoría',
      candidateId,
      err instanceof Error ? err.message : err,
    )
  }
}

/**
 * Limpia ÚNICAMENTE el campo/elemento exacto que corresponde al candidato
 * borrado. Nunca 'evidencias = null' ni borra un mapa completo por un solo
 * archivo.
 */
async function cleanupMetadata(
  solicitudRef: FirebaseFirestore.DocumentReference,
  candidate: StorageCleanupCandidate,
): Promise<void> {
  switch (candidate.kind) {
    case 'retiro':
      await solicitudRef.update({ 'evidencias.retiro': FieldValue.delete() })
      return
    case 'entrega':
      await solicitudRef.update({ 'evidencias.entrega': FieldValue.delete() })
      return
    case 'terminal_paquete':
      await solicitudRef.update({ 'evidenciasTerminal.fotoPaquete': FieldValue.delete() })
      return
    case 'terminal_ticket':
      await solicitudRef.update({ 'evidenciasTerminal.fotoTicket': FieldValue.delete() })
      return
    case 'terminal_bus':
      await solicitudRef.update({ 'evidenciasTerminal.fotoBus': FieldValue.delete() })
      return
    case 'cargotrans_factura':
      await solicitudRef.update({ 'evidenciasCargotrans.factura': FieldValue.delete() })
      return
    case 'cargotrans_paquete': {
      // arrayRemove exige el valor EXACTO — se relee la orden para tomar el
      // objeto {url, pathStorage} tal cual vive hoy, no el snapshot del scan.
      const fresh = await solicitudRef.get()
      const fotos = (fresh.data()?.evidenciasCargotrans?.fotos ?? []) as Array<{
        url?: string
        pathStorage?: string
      }>
      const target = fotos.find((f) => f?.pathStorage === candidate.pathStorage)
      if (!target) return // ya no está — nada que limpiar
      await solicitudRef.update({ 'evidenciasCargotrans.fotos': FieldValue.arrayRemove(target) })
      return
    }
  }
}

/**
 * Admin-only. Revalida TODO contra el estado actual antes de borrar — nunca
 * confía en el snapshot del scan salvo para decidir qué candidatos mirar.
 *
 * Orden obligatorio: Storage delete primero. Metadata cleanup SOLO si el
 * delete de Storage tuvo éxito. Si el delete de Storage falla, la metadata
 * queda intacta (storage_delete_failed). Si el delete de Storage funciona
 * pero la metadata falla, el resultado es metadata_cleanup_failed y NO se
 * declara éxito completo.
 */
export async function executeCandidates(
  scanId: string,
  candidateIds: string[],
  actorUid: string,
): Promise<ExecuteOutcome[]> {
  const scanRef = adminDb.collection(SCAN_COLLECTION).doc(scanId)
  const scanSnap = await scanRef.get()

  if (!scanSnap.exists) {
    return candidateIds.map((candidateId) => ({
      candidateId,
      result: 'skipped_revalidation' as const,
      reason: 'scan_inexistente',
    }))
  }

  const scan = scanSnap.data() as StorageCleanupScanDoc
  const createdAtMillis = scan.createdAt instanceof Timestamp ? scan.createdAt.toMillis() : 0
  const scanExpired = Date.now() - createdAtMillis > SCAN_VALID_MS

  const outcomes: ExecuteOutcome[] = []

  for (const candidateId of candidateIds) {
    const stored = scan.candidates?.[candidateId]

    const skip = async (reason: string) => {
      await persistResult(scanRef, candidateId, 'skipped_revalidation', actorUid, reason)
      outcomes.push({ candidateId, result: 'skipped_revalidation', reason })
    }

    if (!stored) {
      await skip('candidato_no_pertenece_al_scan')
      continue
    }

    // 'deleted' y 'skipped_revalidation' son terminales: el primero ya
    // completó Storage+metadata, el segundo requiere un scan nuevo, no un
    // retry ciego. 'storage_delete_failed' y 'metadata_cleanup_failed' NO
    // son terminales — ver más abajo — nunca deben caer en este bloque.
    if (stored.result === 'deleted' || stored.result === 'skipped_revalidation') {
      outcomes.push({ candidateId, result: stored.result, reason: 'ya_procesado' })
      continue
    }

    if (stored.result === 'metadata_cleanup_failed') {
      // Recovery focal: el intento anterior YA borró el objeto de Storage
      // (ver orden obligatorio de executeCandidates) — acá nunca se
      // reintenta ese delete. Solo se repara metadata, y solo si el estado
      // actual lo confirma exactamente: si el objeto reapareció/cambió, no
      // se toca nada ciegamente.
      if (scanExpired) {
        await skip('scan_expirado')
        continue
      }
      if (!classifyFilename(basename(stored.pathStorage))) {
        await skip('kind_no_allowlisted')
        continue
      }
      const solicitudRefMcf = adminDb.collection(SOLICITUDES_COLLECTION).doc(stored.solicitudId)
      const solicitudSnapMcf = await solicitudRefMcf.get()
      if (!solicitudSnapMcf.exists) {
        await skip('solicitud_inexistente')
        continue
      }
      const dataMcf = solicitudSnapMcf.data() ?? {}
      const refsMcf = extractEvidenciaOperativa(dataMcf)
      const stillReferencedMcf = refsMcf.some(
        (r) => r.kind === stored.kind && r.pathStorage === stored.pathStorage,
      )
      if (!stillReferencedMcf) {
        // Metadata ya no referencia el path — el estado deseado (Storage
        // borrado + metadata limpia) ya está alcanzado por otra vía.
        await persistResult(scanRef, candidateId, 'deleted', actorUid, 'metadata_ya_resuelta')
        outcomes.push({ candidateId, result: 'deleted', reason: 'metadata_ya_resuelta' })
        continue
      }
      // Fail-safe: si no se puede confirmar la ausencia, se asume que
      // existe y no se toca metadata.
      const [existeAhora] = await adminBucket
        .file(stored.pathStorage)
        .exists()
        .catch(() => [true] as [boolean])
      if (existeAhora) {
        // El objeto reapareció/cambió respecto al delete original — estado
        // ambiguo, no se borra nada ciegamente.
        await skip('objeto_reapareciendo_recovery_manual')
        continue
      }
      try {
        await cleanupMetadata(solicitudRefMcf, stored)
      } catch (err) {
        const reason = err instanceof Error ? err.message : 'metadata_cleanup_error'
        await persistResult(scanRef, candidateId, 'metadata_cleanup_failed', actorUid, reason)
        outcomes.push({ candidateId, result: 'metadata_cleanup_failed', reason })
        continue
      }
      await persistResult(scanRef, candidateId, 'deleted', actorUid, 'metadata_reparada')
      outcomes.push({ candidateId, result: 'deleted', reason: 'metadata_reparada' })
      continue
    }

    // A partir de acá: stored.result es undefined (nunca procesado) o
    // 'storage_delete_failed' (retry normal — la metadata sigue intacta
    // porque el delete de Storage nunca llegó a completarse, así que se
    // revalida todo desde cero exactamente igual que un candidato nuevo).
    if (scanExpired) {
      await skip('scan_expirado')
      continue
    }
    if (stored.classification !== 'expired_referenced' || !stored.eligibleForDelete) {
      await skip('no_elegible')
      continue
    }
    if (!classifyFilename(basename(stored.pathStorage))) {
      // Defensa en profundidad sobre datos ya guardados en el scan.
      await skip('kind_no_allowlisted')
      continue
    }

    const solicitudRef = adminDb.collection(SOLICITUDES_COLLECTION).doc(stored.solicitudId)
    const solicitudSnap = await solicitudRef.get()
    if (!solicitudSnap.exists) {
      await skip('solicitud_inexistente')
      continue
    }
    const data = solicitudSnap.data() ?? {}
    if (data.estado !== 'entregado') {
      await skip('orden_no_entregada')
      continue
    }
    const entregadoAtMillis = data.entregadoAt instanceof Timestamp ? data.entregadoAt.toMillis() : null
    if (!entregadoAtMillis || Date.now() - entregadoAtMillis < RETENTION_DAYS * 24 * 60 * 60 * 1000) {
      await skip('antiguedad_insuficiente')
      continue
    }

    const currentRefs = extractEvidenciaOperativa(data)
    const stillReferenced = currentRefs.some(
      (r) => r.kind === stored.kind && r.pathStorage === stored.pathStorage,
    )
    if (!stillReferenced) {
      await skip('metadata_ya_no_referencia_el_objeto')
      continue
    }

    const file = adminBucket.file(stored.pathStorage)
    const [existe] = await file.exists().catch(() => [false] as [boolean])
    if (!existe) {
      await skip('objeto_ya_no_existe')
      continue
    }

    // ── Storage delete primero ──────────────────────────────────────────
    try {
      await file.delete()
    } catch (err) {
      const reason = err instanceof Error ? err.message : 'storage_delete_error'
      await persistResult(scanRef, candidateId, 'storage_delete_failed', actorUid, reason)
      outcomes.push({ candidateId, result: 'storage_delete_failed', reason })
      continue
    }

    // ── Metadata cleanup SOLO si Storage delete tuvo éxito ──────────────
    try {
      await cleanupMetadata(solicitudRef, stored)
    } catch (err) {
      const reason = err instanceof Error ? err.message : 'metadata_cleanup_error'
      await persistResult(scanRef, candidateId, 'metadata_cleanup_failed', actorUid, reason)
      outcomes.push({ candidateId, result: 'metadata_cleanup_failed', reason })
      continue
    }

    await persistResult(scanRef, candidateId, 'deleted', actorUid, 'ok')
    outcomes.push({ candidateId, result: 'deleted', reason: 'ok' })
  }

  return outcomes
}
