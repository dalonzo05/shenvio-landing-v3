// app/api/admin/storage-cleanup/execute/route.ts
//
// Admin-only. Ejecuta el delete REAL de candidatos previamente identificados
// por /scan. El cliente manda únicamente scanId + candidateIds — nunca un
// bucket path libre. El servidor reconstruye y revalida todo desde
// storage_cleanup_scans + solicitudes_envio antes de borrar (ver
// lib/storage-cleanup.ts::executeCandidates).
//
// Orden obligatorio dentro de executeCandidates: Storage delete primero,
// metadata cleanup solo si el delete de Storage tuvo éxito.

import { NextRequest, NextResponse } from 'next/server'
import { adminAuth, adminDb } from '@/fb/admin'
import { executeCandidates } from '@/lib/storage-cleanup'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

const MAX_CANDIDATE_IDS = 100
const MAX_SCAN_ID_LEN = 200
const MAX_CANDIDATE_ID_LEN = 64

const ERROR_AUTENTICACION = { error: 'No autorizado.' }
const ERROR_PERMISO = { error: 'Sin permiso para esta operación.' }
const ERROR_SOLICITUD = { error: 'Solicitud no permitida.' }
const ERROR_SERVICIO = { error: 'No se pudo ejecutar la limpieza.' }

function cuerpoPara(status: number) {
  if (status === 401) return ERROR_AUTENTICACION
  if (status === 403) return ERROR_PERMISO
  if (status === 400) return ERROR_SOLICITUD
  return ERROR_SERVICIO
}

function rechazar(status: number, codigoInterno: string): NextResponse {
  console.warn(`[admin:storage-cleanup:execute] rechazo=${codigoInterno} status=${status}`)
  return NextResponse.json(cuerpoPara(status), { status })
}

type Autorizacion = { ok: true; uid: string } | { ok: false; status: 401 | 403; codigo: string }

async function autorizarAdmin(req: NextRequest): Promise<Autorizacion> {
  const cabecera = req.headers.get('authorization') ?? ''
  const match = cabecera.match(/^Bearer (.+)$/)
  if (!match) return { ok: false, status: 401, codigo: 'sin_bearer' }

  let uid: string
  try {
    uid = (await adminAuth.verifyIdToken(match[1])).uid
  } catch {
    return { ok: false, status: 401, codigo: 'token_invalido' }
  }

  const snap = await adminDb.collection('usuarios').doc(uid).get()
  if (!snap.exists) return { ok: false, status: 403, codigo: 'sin_perfil' }

  const perfil = snap.data()
  if (perfil?.activo !== true) return { ok: false, status: 403, codigo: 'inactivo' }
  if (perfil?.rol !== 'admin') return { ok: false, status: 403, codigo: 'rol_no_permitido' }

  return { ok: true, uid }
}

export async function POST(req: NextRequest) {
  const auth = await autorizarAdmin(req)
  if (!auth.ok) return rechazar(auth.status, auth.codigo)

  let body: unknown
  try {
    body = await req.json()
  } catch {
    return rechazar(400, 'json_invalido')
  }
  if (typeof body !== 'object' || body === null || Array.isArray(body)) {
    return rechazar(400, 'body_no_objeto')
  }

  // Lista cerrada de campos — cualquier otro rechaza en vez de ignorarlo.
  const claves = Object.keys(body as Record<string, unknown>)
  if (claves.length !== 2 || !claves.includes('scanId') || !claves.includes('candidateIds')) {
    return rechazar(400, 'campo_no_permitido')
  }

  const { scanId, candidateIds } = body as { scanId?: unknown; candidateIds?: unknown }
  if (typeof scanId !== 'string' || scanId.trim().length === 0 || scanId.length > MAX_SCAN_ID_LEN) {
    return rechazar(400, 'scanId_invalido')
  }
  if (
    !Array.isArray(candidateIds) ||
    candidateIds.length === 0 ||
    candidateIds.length > MAX_CANDIDATE_IDS ||
    !candidateIds.every((c) => typeof c === 'string' && c.length > 0 && c.length <= MAX_CANDIDATE_ID_LEN)
  ) {
    return rechazar(400, 'candidateIds_invalido')
  }

  try {
    const outcomes = await executeCandidates(scanId.trim(), candidateIds, auth.uid)
    return NextResponse.json(
      { ok: true, outcomes },
      { status: 200, headers: { 'Cache-Control': 'private, no-store' } },
    )
  } catch (err) {
    console.error('[admin:storage-cleanup:execute] error interno', err instanceof Error ? err.message : err)
    return rechazar(500, 'error_interno')
  }
}
