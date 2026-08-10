// app/api/access/generate/route.ts
//
// Genera un link temporal de comercio para una orden. Solo Gestor/Admin.
// Mismo patrón de autorización que app/api/proxy/route.ts: ID token
// verificado server-side + perfil releído de Firestore en el momento de la
// petición — nunca se confía en el rol que traiga el propio token.
//
// El cliente manda EXCLUSIVAMENTE solicitudId. comercioId, scope y
// expiresAt los decide el servidor — nunca se aceptan desde el body (D-10
// del bloque: "NO aceptar desde cliente: comercioId como autoridad,
// expiresAt, scope arbitrario, rol, creadoPorUid").

import { NextRequest, NextResponse } from 'next/server'
import { adminAuth, adminDb } from '@/fb/admin'
import { crearAccesoComercioTemporal } from '@/lib/temporary-access'
import { getAppUrl } from '@/lib/env'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

const ROLES_PERMITIDOS = new Set(['admin', 'gestor'])
const MAX_SOLICITUD_ID = 200

const ERROR_AUTENTICACION = { error: 'No autorizado.' }
const ERROR_PERMISO = { error: 'Sin permiso para esta operación.' }
const ERROR_SOLICITUD = { error: 'Solicitud no permitida.' }
const ERROR_NO_ENCONTRADA = { error: 'La orden no existe.' }
const ERROR_SIN_COMERCIO = { error: 'Esta orden no tiene un comercio asociado.' }
const ERROR_SERVICIO = { error: 'No se pudo generar el enlace.' }

function cuerpoPara(status: number) {
  if (status === 401) return ERROR_AUTENTICACION
  if (status === 403) return ERROR_PERMISO
  if (status === 400) return ERROR_SOLICITUD
  if (status === 404) return ERROR_NO_ENCONTRADA
  if (status === 422) return ERROR_SIN_COMERCIO
  return ERROR_SERVICIO
}

// Log deliberadamente pobre (mismo criterio que app/api/proxy): código +
// rol, nunca el body, el token ni ids completos.
function rechazar(status: number, codigoInterno: string, rol = '-'): NextResponse {
  console.warn(`[access:generate] rechazo=${codigoInterno} rol=${rol} status=${status}`)
  return NextResponse.json(cuerpoPara(status), { status })
}

type Autorizacion =
  | { ok: true; uid: string; rol: 'admin' | 'gestor' }
  | { ok: false; status: 401 | 403; codigo: string }

async function autorizar(req: NextRequest): Promise<Autorizacion> {
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

  const rol = typeof perfil?.rol === 'string' ? perfil.rol : ''
  if (!ROLES_PERMITIDOS.has(rol)) return { ok: false, status: 403, codigo: 'rol_no_permitido' }

  return { ok: true, uid, rol: rol as 'admin' | 'gestor' }
}

export async function POST(req: NextRequest) {
  const auth = await autorizar(req)
  if (!auth.ok) return rechazar(auth.status, auth.codigo)

  let body: unknown
  try {
    body = await req.json()
  } catch {
    return rechazar(400, 'json_invalido', auth.rol)
  }
  if (typeof body !== 'object' || body === null || Array.isArray(body)) {
    return rechazar(400, 'body_no_objeto', auth.rol)
  }

  // Lista cerrada de campos — cualquier otro (comercioId, scope, expiresAt,
  // creadoPorUid...) hace fallar la petición en vez de ignorarlo.
  const claves = Object.keys(body as Record<string, unknown>)
  if (claves.length !== 1 || claves[0] !== 'solicitudId') {
    return rechazar(400, 'campo_no_permitido', auth.rol)
  }

  const { solicitudId } = body as { solicitudId?: unknown }
  if (typeof solicitudId !== 'string' || solicitudId.trim().length === 0 || solicitudId.length > MAX_SOLICITUD_ID) {
    return rechazar(400, 'solicitudId_invalido', auth.rol)
  }

  const solicitudRef = adminDb.collection('solicitudes_envio').doc(solicitudId.trim())
  const solicitudSnap = await solicitudRef.get()
  if (!solicitudSnap.exists) return rechazar(404, 'solicitud_inexistente', auth.rol)

  // comercioId se DERIVA del documento real, nunca del cliente. 'comercioUid'
  // es el nombre real del campo (guarda el comercioId canónico, no el Auth
  // UID — deuda de naming ya documentada en lib/financial-types.ts).
  const data = solicitudSnap.data() ?? {}
  const comercioId = typeof data.comercioUid === 'string' ? data.comercioUid.trim() : ''
  if (!comercioId) return rechazar(422, 'sin_comercio', auth.rol)

  try {
    const { id, token } = await crearAccesoComercioTemporal({
      solicitudId: solicitudId.trim(),
      comercioId,
      creadoPorUid: auth.uid,
      creadoPorRol: auth.rol,
    })

    const appUrl = getAppUrl()
    const url = `${appUrl}/s/${token}`

    return NextResponse.json(
      { ok: true, id, url },
      { status: 200, headers: { 'Cache-Control': 'private, no-store' } }
    )
  } catch (err) {
    console.error('[access:generate] error interno', err instanceof Error ? err.message : err)
    return rechazar(500, 'error_interno', auth.rol)
  }
}
