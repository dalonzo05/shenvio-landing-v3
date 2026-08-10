// app/api/access/revoke/[id]/route.ts
//
// Revoca un acceso temporal. Gestor/Admin pueden revocar cualquier acceso —
// no se exige creadoPorUid == self (D4/sección 21, mismo criterio que el
// resto del panel gestor). Idempotente: revocar dos veces responde 200 sin
// sobreescribir quién/cuándo revocó la primera vez.
//
// Bloque 2 (sección 16): Comercio autenticado también puede revocar, pero
// SOLO su propio destinatario — nunca un acceso 'comercio' (ni propio ni
// ajeno), nunca un destinatario de otra orden. La verificación de propiedad
// vive acá (releyendo el doc antes de revocar), no en revocarAcceso(), que
// sigue siendo un primitivo genérico sin noción de "dueño".
//
// Ruta 'revoke/[id]' (no '[id]/revoke'): Next.js exige el MISMO nombre de
// segmento dinámico en toda la posición del árbol bajo /api/access/ — ya
// existe /api/access/[token]/evidence/[kind], así que un '[id]' al mismo
// nivel colisionaría ('id' !== 'token'). Anteponer el segmento estático
// 'revoke' evita el choque sin tocar la ruta de evidencia.

import { NextRequest, NextResponse } from 'next/server'
import { adminAuth, adminDb } from '@/fb/admin'
import { revocarAcceso, obtenerAccesoPorId } from '@/lib/temporary-access'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

const ROLES_STAFF = new Set(['admin', 'gestor'])
const MAX_MOTIVO = 300

const ERROR_AUTENTICACION = { error: 'No autorizado.' }
const ERROR_PERMISO = { error: 'Sin permiso para esta operación.' }
const ERROR_SOLICITUD = { error: 'Solicitud no permitida.' }
const ERROR_NO_ENCONTRADO = { error: 'El enlace no existe.' }
const ERROR_SERVICIO = { error: 'No se pudo revocar el enlace.' }

function cuerpoPara(status: number) {
  if (status === 401) return ERROR_AUTENTICACION
  if (status === 403) return ERROR_PERMISO
  if (status === 400) return ERROR_SOLICITUD
  if (status === 404) return ERROR_NO_ENCONTRADO
  return ERROR_SERVICIO
}

function rechazar(status: number, codigoInterno: string, rol = '-'): NextResponse {
  console.warn(`[access:revoke] rechazo=${codigoInterno} rol=${rol} status=${status}`)
  return NextResponse.json(cuerpoPara(status), { status })
}

type Autorizacion =
  | { ok: true; uid: string; rol: 'admin' | 'gestor' | 'comercio'; comercioId?: string }
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
  const rolReal = typeof perfil?.rol === 'string' ? perfil.rol : ''

  if (ROLES_STAFF.has(rolReal)) {
    return { ok: true, uid, rol: rolReal as 'admin' | 'gestor' }
  }
  // 'Comercio' (mayúscula) es el valor real del campo — ver firestore.rules
  // isComercioRole(). Se normaliza a 'comercio' minúscula para el resto de
  // este archivo, coherente con AccesoTemporal.creadoPorRol.
  if (rolReal === 'Comercio') {
    const comercioId = typeof perfil?.comercioId === 'string' ? perfil.comercioId : ''
    if (!comercioId) return { ok: false, status: 403, codigo: 'comercio_sin_comercioId' }
    return { ok: true, uid, rol: 'comercio', comercioId }
  }

  return { ok: false, status: 403, codigo: 'rol_no_permitido' }
}

export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const auth = await autorizar(req)
  if (!auth.ok) return rechazar(auth.status, auth.codigo)

  const { id } = await params
  if (!id || id.length > 200) return rechazar(400, 'id_invalido', auth.rol)

  if (auth.rol === 'comercio') {
    const acceso = await obtenerAccesoPorId(id)
    if (!acceso) return rechazar(404, 'acceso_inexistente', auth.rol)
    if (acceso.tipo !== 'destinatario' || acceso.comercioId !== auth.comercioId) {
      // Mismo 404 que "no existe" (sección 16: nunca revelar si un id ajeno
      // existe) — no se distingue "no es tuyo" de "no existe".
      return rechazar(404, 'acceso_ajeno', auth.rol)
    }
  }

  // Body opcional: solo se acepta 'motivo', cualquier otro campo rechaza.
  let motivo: string | undefined
  const rawBody = await req.text()
  if (rawBody.trim().length > 0) {
    let body: unknown
    try {
      body = JSON.parse(rawBody)
    } catch {
      return rechazar(400, 'json_invalido', auth.rol)
    }
    if (typeof body !== 'object' || body === null || Array.isArray(body)) {
      return rechazar(400, 'body_no_objeto', auth.rol)
    }
    const claves = Object.keys(body as Record<string, unknown>)
    if (claves.length > 1 || (claves.length === 1 && claves[0] !== 'motivo')) {
      return rechazar(400, 'campo_no_permitido', auth.rol)
    }
    const m = (body as { motivo?: unknown }).motivo
    if (m !== undefined) {
      if (typeof m !== 'string' || m.length > MAX_MOTIVO) return rechazar(400, 'motivo_invalido', auth.rol)
      motivo = m.trim() || undefined
    }
  }

  const resultado = await revocarAcceso(id, auth.uid, motivo)
  if (!resultado.ok) return rechazar(404, 'acceso_inexistente', auth.rol)

  return NextResponse.json(
    { ok: true, yaEstabaRevocado: resultado.yaEstabaRevocado },
    { status: 200, headers: { 'Cache-Control': 'private, no-store' } }
  )
}
