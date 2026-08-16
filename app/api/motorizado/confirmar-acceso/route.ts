import { NextRequest, NextResponse } from 'next/server'
import { adminAuth, adminDb } from '@/fb/admin'
import { operadorAutorizado, evaluarConfirmacionMotorizado } from '@/lib/motorizado-acceso'

// MOTORIZADO EMAIL VERIFIED V1
//
// Confirma el acceso de un Motorizado ya creado por un Gestor/Admin — marca
// emailVerified=true vía Admin SDK para que el guard global de
// app/panel/layout.tsx (sin cambios, sin excepciones por rol) deje de
// mandarlo a /login?reason=verify. Ver auditoría previa (MOTORIZADO EMAIL
// VERIFICATION — CAUSA CONFIRMADA): el alta actual usa el SDK cliente
// (fb/createAuthUser.ts), que nunca puede dejar emailVerified=true por sí
// solo — este endpoint es el único lugar que lo hace, y solo lo hace para
// la cuenta que el propio operador autorizado acaba de vincular.
//
// Contrato deliberadamente mínimo: { motorizadoId } — el authUid SIEMPRE se
// lee server-side desde motorizado/{motorizadoId}.authUid, nunca del
// request. Ver lib/motorizado-acceso.ts para la cadena de evidencia
// completa y el motivo de cada rechazo posible.
//
// Idempotente: si el usuario ya tiene emailVerified=true, responde éxito
// sin volver a llamar updateUser — permite reintentar sin efectos
// secundarios, y permite procesar cuentas de motorizado ya existentes
// (creadas antes de este fix) sin recrearlas.
//
// Fallos parciales: este endpoint NUNCA borra ni deshabilita nada. Si el
// alta de Auth/Firestore/vínculo ya se completó pero esta confirmación
// falla (red, token vencido, etc.), el acceso queda creado pero sin
// verificar — el llamador (ver app/panel/gestor/motorizados/page.tsx) debe
// reportarlo explícitamente, nunca ocultar el fallo ni intentar un rollback.

const GENERIC_ERROR = { error: 'No se pudo confirmar el acceso.' }

// Mismo patrón que app/api/send-welcome/route.ts: operador autenticado vía
// ID token de Firebase, con usuarios/{uid}.rol en ('admin'|'gestor') y
// activo === true, verificado server-side contra Firestore. No se confía en
// nada que venga del cliente — ni el rol, ni el uid, ni el email.
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
  if (
    !operadorAutorizado({
      existe: operadorSnap.exists,
      activo: operador?.activo === true,
      rol: operador?.rol,
    })
  ) {
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

  const body = await req.json().catch(() => null)
  const motorizadoId = typeof body?.motorizadoId === 'string' ? body.motorizadoId.trim() : ''
  if (!motorizadoId) {
    return NextResponse.json(GENERIC_ERROR, { status: 400 })
  }

  const motorizadoSnap = await db.collection('motorizado').doc(motorizadoId).get()
  const motorizado = motorizadoSnap.data()
  // authUid SIEMPRE sale de este documento — el request nunca aporta uno.
  const authUidMotorizado = motorizado?.authUid
  const authUid = typeof authUidMotorizado === 'string' ? authUidMotorizado.trim() : ''

  let usuarioSnap: FirebaseFirestore.DocumentSnapshot | null = null
  if (authUid) {
    usuarioSnap = await db.collection('usuarios').doc(authUid).get()
  }
  const usuario = usuarioSnap?.data()

  let authUser: import('firebase-admin/auth').UserRecord | null = null
  if (authUid) {
    try {
      authUser = await adminAuth.getUser(authUid)
    } catch {
      authUser = null
    }
  }

  const decision = evaluarConfirmacionMotorizado({
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
    // El motivo detallado solo va al log del servidor — el cliente recibe
    // siempre el mismo error genérico, sin información sensible.
    console.warn(`[motorizado-confirmar-acceso] rechazado (${decision.motivo}) — motorizadoId=${motorizadoId}, operador=${operadorUid}`)
    return NextResponse.json(GENERIC_ERROR, { status: 400 })
  }

  if (!decision.yaVerificado) {
    await adminAuth.updateUser(authUid, { emailVerified: true })
  }

  return NextResponse.json({ ok: true, alreadyVerified: decision.yaVerificado })
}
