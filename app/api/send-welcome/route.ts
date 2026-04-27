import { NextRequest, NextResponse } from 'next/server'
import { Resend } from 'resend'
import { adminAuth } from '@/fb/admin'

const resend = new Resend(process.env.RESEND_API_KEY)

export async function POST(req: NextRequest) {
  const { nombre, email } = await req.json()

  if (!email || !nombre) {
    return NextResponse.json({ error: 'Faltan datos' }, { status: 400 })
  }

  const resetLink = await adminAuth.generatePasswordResetLink(email)

  const { error } = await resend.emails.send({
    from: 'StorkHub <onboarding@resend.dev>',
    to: email,
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
              Hola, ${nombre}
            </p>
            <p style="margin:0 0 28px;font-size:15px;color:#52525b;line-height:1.6;">
              Tu cuenta de acceso al panel de StorkHub fue creada. Para empezar, creá tu contraseña con el botón de abajo.
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

  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 })
  }

  return NextResponse.json({ ok: true })
}
