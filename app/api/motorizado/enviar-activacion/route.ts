import { NextRequest, NextResponse } from 'next/server'
import { Resend } from 'resend'
import { FieldValue } from 'firebase-admin/firestore'
import { adminAuth, adminDb, emulatorActivo } from '@/fb/admin'
import { getAppUrl } from '@/lib/env'
import { isStagingSendBlocked } from '@/lib/email-safety'
import { operadorAutorizado, evaluarInvitacionMotorizado } from '@/lib/motorizado-acceso'

// MOTO-ALTA-AUTH-ROL-1 — Invitación de activación de un motorizado.
//
// crearAccesoMotorizado deja la cuenta sin contraseña y sin verificar. Esta ruta
// envía el enlace con el que el motorizado elige la suya (/crear-password), el
// mismo mecanismo que send-welcome usa con los comercios: es el onboarding
// oficial, no "Olvidé mi contraseña" (que queda para recuperar una cuenta ya
// activa).
//
// Contrato deliberadamente mínimo: { motorizadoId }. El destinatario sale de la
// cuenta de Firebase Auth, nunca del request. Se envía SOLO si la cadena de
// evidencia está completa (lib/motorizado-acceso.ts): el motorizado apunta a la
// cuenta, el perfil tiene rol 'motorizado' y está activo, Auth existe y los
// correos coinciden. Con un acceso a medias no se manda nada: se repara primero.
// Si la cuenta ya está verificada, tampoco: no hay nada que activar.

const resend = new Resend(process.env.RESEND_API_KEY)

const MAX_ATTEMPTS = 5
const WINDOW_MS = 24 * 60 * 60 * 1000 // 24 horas

const GENERIC_ERROR = { error: 'No se pudo enviar la invitación.' }
const STAGING_EMAIL_BLOCKED = {
  error: 'Envío bloqueado: el destinatario no está en la allowlist de staging.',
  code: 'staging_email_not_allowed',
}

// Mismo criterio que send-welcome / confirmar-acceso: operador autenticado con
// ID token y usuarios/{uid}.rol admin|gestor activo, verificado server-side.
async function autorizarOperador(req: NextRequest, db: FirebaseFirestore.Firestore): Promise<string | null> {
  const match = (req.headers.get('authorization') || '').match(/^Bearer (.+)$/)
  if (!match) return null

  let operadorUid: string
  try {
    operadorUid = (await adminAuth.verifyIdToken(match[1])).uid
  } catch {
    return null
  }

  const snap = await db.collection('usuarios').doc(operadorUid).get()
  const operador = snap.data()
  if (!operadorAutorizado({ existe: snap.exists, activo: operador?.activo === true, rol: operador?.rol })) return null
  return operadorUid
}

export async function POST(req: NextRequest) {
  const db = adminDb

  if (!(await autorizarOperador(req, db))) {
    return NextResponse.json({ error: 'No autorizado.' }, { status: 401 })
  }

  const body = await req.json().catch(() => null)
  const motorizadoId = typeof body?.motorizadoId === 'string' ? body.motorizadoId.trim() : ''
  if (!motorizadoId) return NextResponse.json(GENERIC_ERROR, { status: 400 })

  const motorizadoRef = db.collection('motorizado').doc(motorizadoId)
  const motorizadoSnap = await motorizadoRef.get()
  const motorizado = motorizadoSnap.data()
  const authUidMotorizado = motorizado?.authUid
  const authUid = typeof authUidMotorizado === 'string' ? authUidMotorizado.trim() : ''

  const usuarioSnap = authUid ? await db.collection('usuarios').doc(authUid).get() : null
  const usuario = usuarioSnap?.data()

  let authUser: import('firebase-admin/auth').UserRecord | null = null
  if (authUid) {
    try {
      authUser = await adminAuth.getUser(authUid)
    } catch {
      authUser = null
    }
  }

  const decision = evaluarInvitacionMotorizado({
    motorizadoExiste: motorizadoSnap.exists,
    authUidMotorizado,
    usuarioExiste: usuarioSnap?.exists === true,
    usuarioActivo: usuario?.activo,
    usuarioRol: usuario?.rol,
    usuarioEmail: usuario?.email,
    authUserExiste: authUser !== null,
    authUserEmail: authUser?.email,
    authUserEmailVerified: authUser?.emailVerified,
  })

  if (decision.tipo === 'rechazar') {
    // El motivo detallado solo va al log del servidor.
    console.warn(`[motorizado-enviar-activacion] rechazado (${decision.motivo}) — motorizadoId=${motorizadoId}`)
    return NextResponse.json(GENERIC_ERROR, { status: 400 })
  }
  if (decision.tipo === 'ya_activo') {
    return NextResponse.json({ ok: true, yaActivo: true })
  }

  // El destinatario es la cuenta de Auth: nunca un correo del cliente.
  const email = (authUser!.email ?? '').trim().toLowerCase()
  if (!email) return NextResponse.json(GENERIC_ERROR, { status: 400 })

  if (isStagingSendBlocked(email)) {
    return NextResponse.json(STAGING_EMAIL_BLOCKED, { status: 403 })
  }

  const ahora = Date.now()
  const intentos: number[] = (
    Array.isArray(motorizado?.welcomeAttempts) ? motorizado!.welcomeAttempts : []
  ).filter((ts: number) => ahora - ts < WINDOW_MS)
  if (intentos.length >= MAX_ATTEMPTS) {
    return NextResponse.json(
      { error: 'Límite de invitaciones alcanzado para este motorizado. Probá de nuevo más tarde.' },
      { status: 429 },
    )
  }

  // Evidencia de que un operador autorizado inició la activación de ESTA cuenta:
  // finalizarActivacionMotorizado solo cierra la activación si este correo
  // coincide con el de la cuenta. La escribe el servidor, antes de que exista el
  // enlace, y cubre también los accesos creados antes o reparados (que no la traen).
  await motorizadoRef.set({ accesoEmail: email }, { merge: true })

  let resetLink: string
  try {
    const firebaseLink = await adminAuth.generatePasswordResetLink(email)
    const oobCode = new URL(firebaseLink).searchParams.get('oobCode')
    resetLink = `${getAppUrl()}/crear-password?oobCode=${oobCode}`
  } catch {
    return NextResponse.json(GENERIC_ERROR, { status: 500 })
  }

  if (emulatorActivo) {
    console.log(`[emulator] enviar-activacion: envío real omitido. Link (solo emulador) para ${email}: ${resetLink}`)
    await motorizadoRef.set({ welcomeAttempts: FieldValue.arrayUnion(ahora) }, { merge: true })
    return NextResponse.json({ ok: true, emulator: true })
  }

  const nombre = typeof motorizado?.nombre === 'string' ? motorizado.nombre : ''
  const { error: mailError } = await resend.emails.send({
    from: 'StorkHub <noreply@shenvios.com>',
    to: email,
    subject: 'Activá tu cuenta de StorkHub',
    html: `
<!DOCTYPE html>
<html lang="es">
<head><meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1.0"></head>
<body style="margin:0;padding:0;background:#f4f4f5;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;">
  <table width="100%" cellpadding="0" cellspacing="0" style="background:#f4f4f5;padding:40px 0;">
    <tr><td align="center">
      <table width="520" cellpadding="0" cellspacing="0" style="background:#ffffff;border-radius:8px;border:1px solid #e4e4e7;overflow:hidden;">
        <tr>
          <td style="padding:32px 40px 24px;border-bottom:1px solid #f4f4f5;">
            <span style="font-size:20px;font-weight:700;color:#004aad;letter-spacing:-0.3px;">StorkHub</span>
          </td>
        </tr>
        <tr>
          <td style="padding:36px 40px 32px;">
            <p style="margin:0 0 8px;font-size:22px;font-weight:600;color:#18181b;line-height:1.3;">
              ¡Hola${nombre ? `, ${nombre}` : ''}!
            </p>
            <p style="margin:0 0 28px;font-size:15px;color:#52525b;line-height:1.6;">
              Tu acceso como motorizado en StorkHub ya está creado. Para empezar, elegí tu contraseña con el botón de abajo.
            </p>
            <table cellpadding="0" cellspacing="0" style="margin-bottom:28px;">
              <tr>
                <td style="background:#004aad;border-radius:6px;">
                  <a href="${resetLink}"
                     style="display:inline-block;padding:13px 28px;color:#ffffff;font-size:15px;font-weight:600;text-decoration:none;letter-spacing:-0.1px;">
                    Crear contraseña
                  </a>
                </td>
              </tr>
            </table>
            <p style="margin:0 0 4px;font-size:12px;color:#a1a1aa;">Si el botón no funciona, copiá este enlace en tu navegador:</p>
            <p style="margin:0;font-size:11px;color:#71717a;word-break:break-all;line-height:1.5;">${resetLink}</p>
          </td>
        </tr>
        <tr>
          <td style="padding:24px 40px 32px;">
            <p style="margin:0;font-size:13px;color:#71717a;line-height:1.6;">
              Este enlace es válido por <strong>24 horas</strong>. Si no esperabas este correo, podés ignorarlo: tu cuenta no tendrá acceso hasta que elijas una contraseña.
            </p>
          </td>
        </tr>
      </table>
    </td></tr>
  </table>
</body>
</html>
    `,
  })

  if (mailError) return NextResponse.json(GENERIC_ERROR, { status: 500 })

  await motorizadoRef.set({ welcomeAttempts: FieldValue.arrayUnion(ahora) }, { merge: true })

  // El enlace nunca se devuelve ni se loguea fuera del emulador.
  return NextResponse.json({ ok: true })
}
