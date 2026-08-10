// app/api/admin/storage-cleanup/scan/route.ts
//
// Admin-only. Dry-run: lee y clasifica candidatos de evidencia operativa
// (retiro, entrega, terminal, Cargotrans) con más de 45 días — NUNCA borra.
// Mismo patrón de autorización que app/api/access/generate/route.ts: ID
// token verificado server-side + perfil releído de Firestore en el momento
// de la petición, nunca se confía en el rol que traiga el propio token.
//
// El cliente no manda ningún parámetro — el servidor decide todo (cutoff,
// allowlist, límite) vía lib/storage-cleanup.ts.

import { NextRequest, NextResponse } from 'next/server'
import { adminAuth, adminDb } from '@/fb/admin'
import { runScan } from '@/lib/storage-cleanup'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

const ERROR_AUTENTICACION = { error: 'No autorizado.' }
const ERROR_PERMISO = { error: 'Sin permiso para esta operación.' }
const ERROR_SERVICIO = { error: 'No se pudo generar el scan.' }

function cuerpoPara(status: number) {
  if (status === 401) return ERROR_AUTENTICACION
  if (status === 403) return ERROR_PERMISO
  return ERROR_SERVICIO
}

// Log deliberadamente pobre (mismo criterio que app/api/proxy): código +
// rol, nunca el body, el token ni ids completos.
function rechazar(status: number, codigoInterno: string): NextResponse {
  console.warn(`[admin:storage-cleanup:scan] rechazo=${codigoInterno} status=${status}`)
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

  try {
    const { scanId, hasMore, candidateCount } = await runScan(auth.uid)
    return NextResponse.json(
      { ok: true, scanId, hasMore, candidateCount },
      { status: 200, headers: { 'Cache-Control': 'private, no-store' } },
    )
  } catch (err) {
    console.error('[admin:storage-cleanup:scan] error interno', err instanceof Error ? err.message : err)
    return rechazar(500, 'error_interno')
  }
}
