// app/api/access/[token]/recipient/route.ts
//
// Genera/revoca el link de DESTINATARIO desde el propio link temporal
// comercio (sección 8) — el token de la URL es la única credencial, no hay
// Firebase Auth acá. Sibling de app/api/access/[token]/evidence/[kind], mismo
// segmento dinámico 'token' (sin colisión de nombres, ver nota histórica en
// app/api/access/revoke/[id]/route.ts).
//
// POST: genera un hijo nuevo (revoca el anterior — D4).
// DELETE: revoca el hijo actualmente activo de este parent, si existe.
//
// El cliente NO manda nada más que el token en la URL — comercioId,
// solicitudId, scope, expiresAt y parentAccessId los decide el servidor.

import { NextRequest, NextResponse } from 'next/server'
import { adminDb } from '@/fb/admin'
import {
  validarAccesoCompleto,
  crearAccesoDestinatarioTemporal,
  revocarDestinatarioActivoDelParent,
  estadoPermiteDestinatario,
  crearLimitadorDeTasa,
} from '@/lib/temporary-access'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

const MAX_TOKEN_LEN = 128

// Defensa en profundidad (sección 8): sin esto, cualquiera con el link
// comercio podría regenerar en bucle y así revocar (D4) el destinatario de
// otra persona una y otra vez. El token de 256 bits sigue siendo la
// autorización real; esto solo acota el ritmo de escritura.
const superaRateLimit = crearLimitadorDeTasa(20, 60_000)

const ERROR_NO_DISPONIBLE = { error: 'Este enlace ya no está disponible.' }
const ERROR_SOLICITUD = { error: 'Solicitud no permitida.' }
const ERROR_ESTADO = { error: 'Esta orden aún no tiene un envío que compartir.' }
const ERROR_SERVICIO = { error: 'No se pudo completar la operación.' }

function rechazar(status: number, codigoInterno: string): NextResponse {
  console.warn(`[access:recipient:token] rechazo=${codigoInterno} status=${status}`)
  const cuerpo = status === 400 ? ERROR_SOLICITUD : status === 422 ? ERROR_ESTADO
    : status === 401 ? ERROR_NO_DISPONIBLE : ERROR_SERVICIO
  return NextResponse.json(cuerpo, { status, headers: { 'Cache-Control': 'private, no-store' } })
}

function ipDelRequest(req: NextRequest): string {
  return req.headers.get('x-forwarded-for')?.split(',')[0]?.trim() || 'unknown'
}

async function validarParentComercio(token: string) {
  if (!token || token.length > MAX_TOKEN_LEN) return { ok: false as const, status: 400, codigo: 'token_formato' }
  const resultado = await validarAccesoCompleto(token)
  if (!resultado.ok) return { ok: false as const, status: 401, codigo: `acceso_${resultado.motivo}` }
  const { acceso } = resultado
  // Solo un acceso tipo 'comercio' puede generar/revocar un destinatario —
  // un destinatario nunca puede crear un "nieto" (scope no lo permitiría de
  // todos modos, pero la restricción se hace explícita acá también).
  if (acceso.tipo !== 'comercio') return { ok: false as const, status: 401, codigo: 'tipo_no_permitido' }
  return { ok: true as const, acceso }
}

export async function POST(req: NextRequest, { params }: { params: Promise<{ token: string }> }) {
  const { token } = await params

  if (superaRateLimit(ipDelRequest(req))) return rechazar(429, 'rate_limit')

  const parentCheck = await validarParentComercio(token)
  if (!parentCheck.ok) return rechazar(parentCheck.status, parentCheck.codigo)
  const parent = parentCheck.acceso

  const solicitudSnap = await adminDb.collection('solicitudes_envio').doc(parent.solicitudId).get()
  if (!solicitudSnap.exists) return rechazar(404, 'solicitud_inexistente')
  const data = solicitudSnap.data() ?? {}

  if (!estadoPermiteDestinatario(data.estado)) return rechazar(422, 'estado_no_permitido')

  try {
    const resultado = await crearAccesoDestinatarioTemporal({
      parent,
      solicitudId: parent.solicitudId,
      comercioId: parent.comercioId,
      // Sin Firebase Auth acá — nunca se inventa un UID (sección 6).
      // parentAccessId (dentro de crearAccesoDestinatarioTemporal) ya es la
      // trazabilidad completa de este origen.
    })
    if (!resultado.ok) return rechazar(401, 'parent_invalido')

    const appUrl = process.env.NEXT_PUBLIC_APP_URL ?? 'https://shenvios.com'
    const url = `${appUrl}/s/${resultado.token}`

    return NextResponse.json(
      { ok: true, id: resultado.id, url },
      { status: 200, headers: { 'Cache-Control': 'private, no-store' } }
    )
  } catch (err) {
    console.error('[access:recipient:token] error interno', err instanceof Error ? err.message : err)
    return rechazar(500, 'error_interno')
  }
}

export async function DELETE(req: NextRequest, { params }: { params: Promise<{ token: string }> }) {
  const { token } = await params

  if (superaRateLimit(ipDelRequest(req))) return rechazar(429, 'rate_limit')

  const parentCheck = await validarParentComercio(token)
  if (!parentCheck.ok) return rechazar(parentCheck.status, parentCheck.codigo)

  try {
    const { huboActivo } = await revocarDestinatarioActivoDelParent(parentCheck.acceso.id)
    return NextResponse.json(
      { ok: true, huboActivo },
      { status: 200, headers: { 'Cache-Control': 'private, no-store' } }
    )
  } catch (err) {
    console.error('[access:recipient:token] error interno', err instanceof Error ? err.message : err)
    return rechazar(500, 'error_interno')
  }
}
