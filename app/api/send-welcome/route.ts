import { NextRequest, NextResponse } from 'next/server'
import { Resend } from 'resend'
import { adminAuth, adminDb, emulatorActivo } from '@/fb/admin'
import { FieldValue } from 'firebase-admin/firestore'
import { getAppUrl } from '@/lib/env'

const resend = new Resend(process.env.RESEND_API_KEY)

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/
const MAX_ATTEMPTS = 5
const WINDOW_MS = 24 * 60 * 60 * 1000 // 24 horas

const GENERIC_ERROR = { error: 'No se pudo procesar la solicitud.' }

// ── Autenticación + autorización ────────────────────────────────────────────
// Mismo criterio que functions/src/comercio-acceso.ts: operador autenticado
// vía ID token de Firebase, con usuarios/{uid}.rol en ('admin'|'gestor') y
// activo === true, verificado server-side contra Firestore — nunca se confía
// en nada que venga del cliente (ni el rol, ni el email, ni el comercioId
// sirven de nada sin esta comprobación).
async function autorizarOperador(req: NextRequest, db: FirebaseFirestore.Firestore): Promise<string | null> {
  const authHeader = req.headers.get('authorization') || ''
  const match = authHeader.match(/^Bearer (.+)$/)
  if (!match) return null

  let operadorUid: string
  try {
    const decoded = await adminAuth.verifyIdToken(match[1])
    operadorUid = decoded.uid
  } catch {
    return null
  }

  const operadorSnap = await db.collection('usuarios').doc(operadorUid).get()
  const operador = operadorSnap.data()
  const rol = operador?.rol
  if (!operadorSnap.exists || operador?.activo !== true || (rol !== 'admin' && rol !== 'gestor')) {
    return null
  }
  return operadorUid
}

export async function POST(req: NextRequest) {
  const db = adminDb

  const operadorUid = await autorizarOperador(req, db)
  if (!operadorUid) {
    return NextResponse.json({ error: 'No autorizado.' }, { status: 401 })
  }

  // ── Payload: solo comercioId. Nunca se acepta email/nombre del cliente —
  // ambos se leen exclusivamente de comercios/{comercioId} más abajo.
  const body = await req.json().catch(() => null)
  const comercioId = typeof body?.comercioId === 'string' ? body.comercioId.trim() : ''
  if (!comercioId) {
    return NextResponse.json(GENERIC_ERROR, { status: 400 })
  }

  const comercioRef = db.collection('comercios').doc(comercioId)
  const comercioSnap = await comercioRef.get()
  const comercio = comercioSnap.data()
  if (!comercioSnap.exists || !comercio) {
    return NextResponse.json(GENERIC_ERROR, { status: 400 })
  }

  const emailAcceso: string = typeof comercio.emailAcceso === 'string' ? comercio.emailAcceso.trim().toLowerCase() : ''
  const nombre: string = typeof comercio.name === 'string' ? comercio.name : ''

  // ── Confirmar provisión/acceso compatible: el comercio debe tener acceso
  // activo (otorgado por crearAccesoComercio) con authUid y emailAcceso
  // consistentes — nunca se genera un enlace para un comercio sin_acceso,
  // desactivado, o en error_provision.
  if (
    comercio.accesoEstado !== 'activo' ||
    !comercio.authUid ||
    !emailAcceso ||
    !EMAIL_RE.test(emailAcceso)
  ) {
    return NextResponse.json(GENERIC_ERROR, { status: 400 })
  }

  // ── Rate limiting por comercioId — defensa contra abuso incluso desde una
  // sesión de gestor legítima (mismo patrón que send-reset-password).
  const ahora = Date.now()
  const intentos: number[] = (
    Array.isArray(comercio.welcomeAttempts) ? comercio.welcomeAttempts : []
  ).filter((ts: number) => ahora - ts < WINDOW_MS)
  if (intentos.length >= MAX_ATTEMPTS) {
    return NextResponse.json(
      { error: 'Límite de envíos alcanzado para este comercio. Probá de nuevo más tarde.' },
      { status: 429 }
    )
  }

  // ── Generar el enlace únicamente para el correo de acceso del comercio.
  // adminAuth ya está redirigido al Auth Emulator local cuando
  // emulatorActivo (ver fb/admin.ts) — este link jamás es un link real
  // fuera de ese modo, sin necesitar ninguna rama especial acá.
  let resetLink: string
  try {
    const firebaseLink = await adminAuth.generatePasswordResetLink(emailAcceso)
    const oobCode = new URL(firebaseLink).searchParams.get('oobCode')
    const appUrl = getAppUrl()
    resetLink = `${appUrl}/crear-password?oobCode=${oobCode}`
  } catch {
    return NextResponse.json(GENERIC_ERROR, { status: 500 })
  }

  // ── Resend real NUNCA se llama en modo emulador — ni siquiera se
  // construye el request HTTP. En su lugar, se deja una señal de prueba
  // solo en el log del servidor (el link apunta al Auth Emulator local, es
  // inútil fuera de esa sesión, así que no es un secreto que valga ocultar).
  if (emulatorActivo) {
    console.log(`[emulator] send-welcome: envío real omitido. Link de activación (solo emulador) para ${emailAcceso}: ${resetLink}`)
    await comercioRef.set({ welcomeAttempts: FieldValue.arrayUnion(ahora) }, { merge: true })
    return NextResponse.json({ ok: true, emulator: true })
  }

  const { error: mailError } = await resend.emails.send({
    from: 'StorkHub <noreply@shenvios.com>',
    to: emailAcceso,
    subject: 'Tu cuenta en StorkHub está lista',
    html: `
<!DOCTYPE html>
<html lang="es">
<head><meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1.0"></head>
<body style="margin:0;padding:0;background:#f4f4f5;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;">
  <table width="100%" cellpadding="0" cellspacing="0" style="background:#f4f4f5;padding:40px 0;">
    <tr><td align="center">
      <table width="520" cellpadding="0" cellspacing="0" style="background:#ffffff;border-radius:8px;border:1px solid #e4e4e7;overflow:hidden;">

        <!-- Header -->
        <tr>
          <td style="padding:32px 40px 24px;border-bottom:1px solid #f4f4f5;">
            <span style="font-size:20px;font-weight:700;color:#004aad;letter-spacing:-0.3px;">StorkHub</span>
          </td>
        </tr>

        <!-- Body -->
        <tr>
          <td style="padding:36px 40px 32px;">
            <p style="margin:0 0 8px;font-size:22px;font-weight:600;color:#18181b;line-height:1.3;">
              ¡Hola${nombre ? `, ${nombre}` : ''}!
            </p>
            <p style="margin:0 0 6px;font-size:15px;color:#52525b;line-height:1.6;">
              Estamos felices de que trabajes con nosotros. Tu cuenta en StorkHub ya está lista y te esperamos en el panel para gestionar tus envíos de forma rápida y sencilla.
            </p>
            <p style="margin:0 0 28px;font-size:15px;color:#52525b;line-height:1.6;">
              Para empezar, creá tu contraseña con el botón de abajo.
            </p>

            <!-- CTA Button -->
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

            <p style="margin:0 0 4px;font-size:12px;color:#a1a1aa;">
              Si el botón no funciona, copiá este enlace en tu navegador:
            </p>
            <p style="margin:0;font-size:11px;color:#71717a;word-break:break-all;line-height:1.5;">
              ${resetLink}
            </p>
          </td>
        </tr>

        <!-- Divider -->
        <tr><td style="padding:0 40px;"><div style="height:1px;background:#f4f4f5;"></div></td></tr>

        <!-- Footer -->
        <tr>
          <td style="padding:24px 40px 32px;">
            <p style="margin:0 0 12px;font-size:13px;color:#71717a;line-height:1.6;">
              Este enlace es válido por <strong>24 horas</strong>. Si no esperabas este correo, podés ignorarlo — tu cuenta no tendrá acceso hasta que establezcas una contraseña.
            </p>
            <p style="margin:0;font-size:13px;color:#a1a1aa;">
              Equipo StorkHub &middot; <a href="https://shenvios.com" style="color:#a1a1aa;text-decoration:none;">shenvios.com</a>
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

  if (mailError) {
    return NextResponse.json(GENERIC_ERROR, { status: 500 })
  }

  await comercioRef.set({ welcomeAttempts: FieldValue.arrayUnion(ahora) }, { merge: true })

  // En producción (emulatorActivo === false) el enlace nunca se devuelve ni
  // se loguea — solo confirmamos el envío.
  return NextResponse.json({ ok: true })
}
