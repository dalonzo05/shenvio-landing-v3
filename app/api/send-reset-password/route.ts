import { NextRequest, NextResponse } from 'next/server'
import { Resend } from 'resend'
import { adminAuth } from '@/fb/admin'
import { getFirestore, FieldValue } from 'firebase-admin/firestore'
import { getApps, initializeApp, cert } from 'firebase-admin/app'

const resend = new Resend(process.env.RESEND_API_KEY)

function getAdminDb() {
  const adminApp =
    getApps().find((a) => a.name === 'admin') ??
    initializeApp(
      { credential: cert(JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT_JSON!)) },
      'admin'
    )
  return getFirestore(adminApp)
}

const MAX_ATTEMPTS = 3
const WINDOW_MS = 24 * 60 * 60 * 1000 // 24 horas

export async function POST(req: NextRequest) {
  const { email } = await req.json()

  if (!email) {
    return NextResponse.json({ error: 'Correo requerido.' }, { status: 400 })
  }

  // Buscar usuario en Firebase Auth
  let uid: string
  try {
    const user = await adminAuth.getUserByEmail(email.trim())
    uid = user.uid
  } catch {
    // No revelar si el correo existe o no
    return NextResponse.json({ ok: true })
  }

  // Leer doc de Firestore para obtener nombre y rate limit
  const db = getAdminDb()
  const ref = db.collection('usuarios').doc(uid)
  const snap = await ref.get()
  const data = snap.data() ?? {}
  const nombre: string = data.name || data.nombre || ''

  const ahora = Date.now()
  const intentos: number[] = (data.resetAttempts ?? []).filter(
    (ts: number) => ahora - ts < WINDOW_MS
  )

  if (intentos.length >= MAX_ATTEMPTS) {
    return NextResponse.json(
      { error: `Límite alcanzado. Podés volver a intentarlo en ${Math.ceil((intentos[0] + WINDOW_MS - ahora) / 3600000)} hora(s).` },
      { status: 429 }
    )
  }

  // Generar link personalizado
  const firebaseLink = await adminAuth.generatePasswordResetLink(email.trim())
  const oobCode = new URL(firebaseLink).searchParams.get('oobCode')
  const appUrl = process.env.NEXT_PUBLIC_APP_URL ?? 'https://shenvios.com'
  const resetLink = `${appUrl}/crear-password?oobCode=${oobCode}`

  // Enviar correo
  const { error: mailError } = await resend.emails.send({
    from: 'StorkHub <noreply@shenvios.com>',
    to: email.trim(),
    subject: 'Restablecé tu contraseña de StorkHub',
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
            <p style="margin:0 0 28px;font-size:15px;color:#52525b;line-height:1.6;">
              Recibimos una solicitud para restablecer la contraseña de tu cuenta en StorkHub. Hacé clic en el botón de abajo para crear una nueva contraseña y seguir gestionando tus envíos sin interrupciones.
            </p>

            <!-- CTA Button -->
            <table cellpadding="0" cellspacing="0" style="margin-bottom:28px;">
              <tr>
                <td style="background:#004aad;border-radius:6px;">
                  <a href="${resetLink}"
                     style="display:inline-block;padding:13px 28px;color:#ffffff;font-size:15px;font-weight:600;text-decoration:none;letter-spacing:-0.1px;">
                    Restablecer contraseña
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
              Este enlace es válido por <strong>1 hora</strong>. Si no solicitaste este cambio, podés ignorar este correo — tu contraseña actual seguirá siendo la misma.
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
    return NextResponse.json({ error: 'No se pudo enviar el correo.' }, { status: 500 })
  }

  // Guardar intento en Firestore
  await ref.set(
    { resetAttempts: FieldValue.arrayUnion(ahora) },
    { merge: true }
  )

  return NextResponse.json({ ok: true })
}
