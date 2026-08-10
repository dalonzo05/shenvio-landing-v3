// app/api/access/[token]/evidence/[kind]/route.ts
//
// Sirve UNA evidencia de UNA orden, server-side. El navegador nunca recibe
// una URL de Firebase Storage — recibe bytes, servidos por este handler tras
// validar token, expiración, revocación, scope y pertenencia real de la
// evidencia a la orden vinculada al token.
//
// 'kind' es un enum cerrado (kindValido en lib/temporary-access.ts) — nunca
// se acepta un path o nombre de archivo libre desde el cliente. Mismo
// aprendizaje ya documentado en app/api/proxy/route.ts sobre SSRF/path
// injection: el servidor construye la ruta real, el cliente solo elige entre
// opciones predefinidas.
//
// D5: esta ruta NUNCA incrementa contadorAccesos — ese contador es "se abrió
// la vista", no "se pidió una imagen" (una sola vista puede pedir varias).

import { NextRequest, NextResponse } from 'next/server'
import { adminDb, adminBucket } from '@/fb/admin'
import {
  validarAccesoCompleto,
  kindValido,
  scopeRequeridoParaKind,
  resolverEvidencia,
  crearLimitadorDeTasa,
} from '@/lib/temporary-access'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

const MAX_TOKEN_LEN = 128
const MAX_KIND_LEN = 64

const superaRateLimit = crearLimitadorDeTasa(120, 60_000)

const ERROR_NO_DISPONIBLE = { error: 'Este recurso ya no está disponible.' }
const ERROR_SOLICITUD = { error: 'Solicitud no permitida.' }
const ERROR_NO_ENCONTRADO = { error: 'No encontrado.' }

function rechazar(status: number, codigoInterno: string): NextResponse {
  console.warn(`[access:evidence] rechazo=${codigoInterno} status=${status}`)
  const cuerpo = status === 400 ? ERROR_SOLICITUD : status === 404 ? ERROR_NO_ENCONTRADO : ERROR_NO_DISPONIBLE
  return NextResponse.json(cuerpo, {
    status,
    headers: { 'Cache-Control': 'private, no-store', 'X-Robots-Tag': 'noindex, nofollow' },
  })
}

function ipDelRequest(req: NextRequest): string {
  return req.headers.get('x-forwarded-for')?.split(',')[0]?.trim() || 'unknown'
}

export async function GET(
  req: NextRequest,
  { params }: { params: Promise<{ token: string; kind: string }> }
) {
  const { token, kind } = await params

  if (!token || token.length > MAX_TOKEN_LEN) return rechazar(400, 'token_formato')
  if (!kind || kind.length > MAX_KIND_LEN) return rechazar(400, 'kind_formato')
  if (!kindValido(kind)) return rechazar(400, 'kind_desconocido')

  if (superaRateLimit(ipDelRequest(req))) return rechazar(429, 'rate_limit')

  // Bloque 2 (D3): validarAccesoCompleto también revalida el padre en vivo
  // cuando el token es tipo 'destinatario' — nunca basta con que el hijo
  // mismo no esté vencido/revocado (ver comentario en esa función).
  const resultado = await validarAccesoCompleto(token)
  if (!resultado.ok) return rechazar(401, `acceso_${resultado.motivo}`)
  const { acceso } = resultado

  const scopeRequerido = scopeRequeridoParaKind(kind)
  if (!scopeRequerido || !acceso.scope.includes(scopeRequerido)) {
    return rechazar(403, 'scope_insuficiente')
  }

  const solicitudSnap = await adminDb.collection('solicitudes_envio').doc(acceso.solicitudId).get()
  if (!solicitudSnap.exists) return rechazar(404, 'solicitud_inexistente')

  const evidencia = resolverEvidencia(solicitudSnap.data() ?? {}, kind)
  if (!evidencia) return rechazar(404, 'evidencia_inexistente')

  try {
    const file = adminBucket.file(evidencia.pathStorage)
    const [existe] = await file.exists()
    if (!existe) return rechazar(404, 'archivo_inexistente')

    const [buffer] = await file.download()
    return new NextResponse(buffer, {
      status: 200,
      headers: {
        'Content-Type': evidencia.contentType,
        'Content-Disposition': 'inline',
        'Cache-Control': 'private, no-store',
        'X-Robots-Tag': 'noindex, nofollow',
        'X-Content-Type-Options': 'nosniff',
      },
    })
  } catch (err) {
    console.error('[access:evidence] error interno', err instanceof Error ? err.message : err)
    return rechazar(500, 'error_interno')
  }
}
