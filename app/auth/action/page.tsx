// app/auth/action/page.tsx
'use client'
import { useEffect, useState } from 'react'
import { useRouter, useSearchParams } from 'next/navigation'
import { auth } from '@/fb/config'
import {
  applyActionCode,
  verifyPasswordResetCode,
  confirmPasswordReset,
} from 'firebase/auth'

export default function AuthActionPage() {
  const router = useRouter()
  const qp = useSearchParams()

  const mode = qp.get('mode') || ''
  const oobCode = qp.get('oobCode') || ''
  const continueUrl = qp.get('continueUrl') || '/login'

  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [submitting, setSubmitting] = useState(false)
  const [status, setStatus] = useState<'idle'|'loading'|'ok'|'error'>('loading')
  const [error, setError] = useState<string | null>(null)

  // Cargar estado inicial según el modo
  useEffect(() => {
    const run = async () => {
      try {
        if (!mode || !oobCode) throw new Error('Enlace inválido.')
        setError(null)

        if (mode === 'verifyEmail') {
          await applyActionCode(auth, oobCode)
          setStatus('ok')
          return
        }

        if (mode === 'resetPassword') {
          const mail = await verifyPasswordResetCode(auth, oobCode)
          setEmail(mail)
          setStatus('idle')
          return
        }

        throw new Error('Acción no soportada.')
      } catch (e: any) {
        setError(e?.message || 'No se pudo procesar el enlace.')
        setStatus('error')
      }
    }
    run()
  }, [mode, oobCode])

  const doReset = async (e: React.FormEvent) => {
    e.preventDefault()
    setSubmitting(true)
    setError(null)
    try {
      if (!password || password.length < 6) throw new Error('Usá al menos 6 caracteres.')
      await confirmPasswordReset(auth, oobCode, password)
      setStatus('ok')
    } catch (e: any) {
      setError(e?.message || 'No se pudo cambiar la contraseña.')
    } finally {
      setSubmitting(false)
    }
  }

  // UI
  return (
    <div className="min-h-screen flex items-center justify-center bg-gray-50 px-4">
      <div className="w-full max-w-md rounded-2xl bg-white p-6 shadow-lg">
        <h1 className="text-xl font-bold text-center text-[#004aad]">STORKHUB</h1>

        {/* VERIFY EMAIL */}
        {mode === 'verifyEmail' && (
          <div className="mt-6">
            {status === 'loading' && <p>Verificando tu correo…</p>}
            {status === 'ok' && (
              <>
                <p className="mb-4">¡Tu correo fue verificado correctamente! 🎉</p>
                <button
                  onClick={() => router.replace(continueUrl || '/login')}
                  className="w-full rounded-full bg-[#004aad] text-white font-semibold py-2 hover:brightness-110"
                >
                  Ir a iniciar sesión
                </button>
              </>
            )}
            {status === 'error' && (
              <>
                <p className="text-red-600 text-sm mb-4">{error}</p>
                <button
                  onClick={() => router.replace('/login')}
                  className="w-full rounded-full border py-2"
                >
                  Volver al login
                </button>
              </>
            )}
          </div>
        )}

        {/* RESET PASSWORD */}
        {mode === 'resetPassword' && (
          <div className="mt-6">
            {status === 'loading' && <p>Comprobando enlace…</p>}
            {status === 'error' && (
              <>
                <p className="text-red-600 text-sm mb-4">{error}</p>
                <button
                  onClick={() => router.replace('/login')}
                  className="w-full rounded-full border py-2"
                >
                  Volver al login
                </button>
              </>
            )}
            {status !== 'loading' && status !== 'error' && (
              <form onSubmit={doReset} className="space-y-4">
                <div className="text-sm text-gray-600">Para: <span className="font-medium">{email}</span></div>
                <label className="block text-sm">
                  <span className="mb-1 block text-gray-700">Nueva contraseña</span>
                  <input
                    type="password"
                    className="w-full rounded-lg border px-3 py-2 focus:ring-2 focus:ring-[#004aad]"
                    value={password}
                    onChange={(e) => setPassword(e.target.value)}
                    minLength={6}
                    required
                  />
                </label>

                {error && <p className="text-sm text-red-600">{error}</p>}

                {status === 'ok' ? (
                  <button
                    type="button"
                    onClick={() => router.replace('/login')}
                    className="w-full rounded-full bg-[#004aad] text-white font-semibold py-2 hover:brightness-110"
                  >
                    Ir a iniciar sesión
                  </button>
                ) : (
                  <button
                    type="submit"
                    disabled={submitting}
                    className="w-full rounded-full bg-[#004aad] text-white font-semibold py-2 hover:brightness-110 disabled:opacity-60"
                  >
                    {submitting ? 'Guardando…' : 'Guardar nueva contraseña'}
                  </button>
                )}
              </form>
            )}
          </div>
        )}

        {/* fallback de modo desconocido */}
        {!mode && (
          <div className="mt-6">
            <p>Enlace inválido.</p>
            <button
              onClick={() => router.replace('/login')}
              className="mt-3 w-full rounded-full border py-2"
            >
              Volver al login
            </button>
          </div>
        )}
      </div>
    </div>
  )
}
