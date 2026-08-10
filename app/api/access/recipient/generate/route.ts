// app/api/access/recipient/generate/route.ts
//
// Genera un link temporal de DESTINATARIO desde el comercio autenticado
// (sección 7). El comercio nunca ve ni copia un link "comercio" para sí
// mismo en este flujo — el parent que hace falta por D2 se resuelve/crea
// server-side de forma invisible (decisión sección 9, opción A: reutiliza un
// acceso comercio vigente de esta orden si existe, o crea uno nuevo vía la
// misma crearAccesoComercioTemporal ya usada por el flujo de Gestor/Admin).
//
// Mismo patrón de autorización que el resto de app/api/access/*: ID token
// verificado server-side + perfil releído de Firestore en cada petición.

import { NextRequest, NextResponse } from 'next/server'
import { adminAuth, adminDb } from '@/fb/admin'
import {
  resolverOCrearAccesoComercioParent,
  crearAccesoDestinatarioTemporal,
  estadoPermiteDestinatario,
} from '@/lib/temporary-access'
import { getAppUrl } from '@/lib/env'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

const MAX_SOLICITUD_ID = 200

const ERROR_AUTENTICACION = { error: 'No autorizado.' }
const ERROR_PERMISO = { error: 'Sin permiso para esta operación.' }
const ERROR_SOLICITUD = { error: 'Solicitud no permitida.' }
const ERROR_NO_ENCONTRADA = { error: 'La orden no existe.' }
const ERROR_ESTADO = { error: 'Esta orden aún no tiene un envío que compartir.' }
const ERROR_SERVICIO = { error: 'No se pudo generar el enlace.' }

function cuerpoPara(status: number) {
  if (status === 401) return ERROR_AUTENTICACION
  if (status === 403) return ERROR_PERMISO
  if (status === 400) return ERROR_SOLICITUD
  if (status === 404) return ERROR_NO_ENCONTRADA
  if (status === 422) return ERROR_ESTADO
  return ERROR_SERVICIO
}

// Log deliberadamente pobre (mismo criterio que el resto de app/api/access):
// código + rol, nunca el body, el token ni ids completos.
function rechazar(status: number, codigoInterno: string, rol = '-'): NextResponse {
  console.warn(`[access:recipient:generate] rechazo=${codigoInterno} rol=${rol} status=${status}`)
  return NextResponse.json(cuerpoPara(status), { status })
}

type Autorizacion =
  | { ok: true; uid: string; comercioId: string }
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
  // 'Comercio' (mayúscula) — valor real del campo, ver firestore.rules isComercioRole().
  if (perfil?.rol !== 'Comercio') return { ok: false, status: 403, codigo: 'rol_no_permitido' }

  const comercioId = typeof perfil?.comercioId === 'string' ? perfil.comercioId.trim() : ''
  if (!comercioId) return { ok: false, status: 403, codigo: 'sin_comercioId' }

  return { ok: true, uid, comercioId }
}

export async function POST(req: NextRequest) {
  const auth = await autorizar(req)
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
  // Lista cerrada de campos — igual que /api/access/generate: nada de
  // parentAccessId, scope, expiresAt, tipo desde el cliente.
  const claves = Object.keys(body as Record<string, unknown>)
  if (claves.length !== 1 || claves[0] !== 'solicitudId') {
    return rechazar(400, 'campo_no_permitido')
  }

  const { solicitudId } = body as { solicitudId?: unknown }
  if (typeof solicitudId !== 'string' || solicitudId.trim().length === 0 || solicitudId.length > MAX_SOLICITUD_ID) {
    return rechazar(400, 'solicitudId_invalido')
  }
  const solicitudIdLimpio = solicitudId.trim()

  const solicitudSnap = await adminDb.collection('solicitudes_envio').doc(solicitudIdLimpio).get()
  if (!solicitudSnap.exists) return rechazar(404, 'solicitud_inexistente')
  const data = solicitudSnap.data() ?? {}

  // Pertenencia real: comercioUid guarda el comercioId canónico (deuda de
  // naming ya documentada), nunca el Auth UID.
  const comercioIdOrden = typeof data.comercioUid === 'string' ? data.comercioUid.trim() : ''
  if (!comercioIdOrden || comercioIdOrden !== auth.comercioId) {
    // 404 y no 403: no revela si la orden existe cuando no es del comercio.
    return rechazar(404, 'solicitud_ajena')
  }

  // D5: allowlist explícita de estados — nunca antes de 'confirmada', nunca
  // 'rechazada'/'cancelada'.
  if (!estadoPermiteDestinatario(data.estado)) return rechazar(422, 'estado_no_permitido')

  try {
    const parent = await resolverOCrearAccesoComercioParent({
      solicitudId: solicitudIdLimpio,
      comercioId: auth.comercioId,
      creadoPorUid: auth.uid,
    })

    const resultado = await crearAccesoDestinatarioTemporal({
      parent,
      solicitudId: solicitudIdLimpio,
      comercioId: auth.comercioId,
      creadoPorUid: auth.uid,
    })
    if (!resultado.ok) return rechazar(422, 'parent_invalido')

    const appUrl = getAppUrl()
    const url = `${appUrl}/s/${resultado.token}`

    return NextResponse.json(
      { ok: true, id: resultado.id, url },
      { status: 200, headers: { 'Cache-Control': 'private, no-store' } }
    )
  } catch (err) {
    console.error('[access:recipient:generate] error interno', err instanceof Error ? err.message : err)
    return rechazar(500, 'error_interno')
  }
}
