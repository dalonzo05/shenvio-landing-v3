'use client'

import { Suspense, useEffect, useState } from 'react'
import { useRouter, useSearchParams } from 'next/navigation'
import { Fredoka } from 'next/font/google'
import { auth } from '@/fb/config'
import { verifyPasswordResetCode, confirmPasswordReset } from 'firebase/auth'
import { Eye, EyeOff, CheckCircle2, XCircle } from 'lucide-react'

const fredoka = Fredoka({ subsets: ['latin'], weight: ['400', '700'] })

const SYMBOL_RE = /[!#$%&/()?.*@_\-+]/
const UPPER_RE = /[A-Z]/

function validate(pw: string, confirm: string): string | null {
  if (pw.length < 8) return 'La contraseña debe tener al menos 8 caracteres.'
  if (!UPPER_RE.test(pw)) return 'Debe incluir al menos una letra mayúscula.'
  if (!SYMBOL_RE.test(pw)) return 'Debe incluir al menos un símbolo (!#$%&/()?.*@_-+).'
  if (pw !== confirm) return 'Las contraseñas no coinciden.'
  return null
}

function CrearPasswordContent() {
  const router = useRouter()
  const qp = useSearchParams()
  const oobCode = qp.get('oobCode') ?? ''

  const [status, setStatus] = useState<'loading' | 'idle' | 'submitting' | 'ok' | 'error'>('loading')
  const [errorMsg, setErrorMsg] = useState<string | null>(null)
  const [password, setPassword] = useState('')
  const [confirm, setConfirm] = useState('')
  const [showPw, setShowPw] = useState(false)
  const [showConfirm, setShowConfirm] = useState(false)
  const [inlineError, setInlineError] = useState<string | null>(null)

  useEffect(() => {
    if (!oobCode) {
      setErrorMsg('El enlace no es válido. Solicitá uno nuevo.')
      setStatus('error')
      return
    }
    verifyPasswordResetCode(auth, oobCode)
      .then(() => setStatus('idle'))
      .catch(() => {
        setErrorMsg('El enlace expiró o ya fue usado. Solicitá uno nuevo al administrador.')
        setStatus('error')
      })
  }, [oobCode])

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault()
    setInlineError(null)
    const err = validate(password, confirm)
    if (err) { setInlineError(err); return }

    setStatus('submitting')
    try {
      await confirmPasswordReset(auth, oobCode, password)
      setStatus('ok')
    } catch {
      setInlineError('No se pudo guardar la contraseña. El enlace puede haber expirado.')
      setStatus('idle')
    }
  }

  return (
    <div className="min-h-screen flex items-center justify-center bg-gray-50 px-4">
      <div className="w-full max-w-md bg-white shadow-lg rounded-2xl p-8">

        {/* Logo */}
        <div className="text-center mb-6">
          <span className={`text-[#004aad] text-2xl font-bold tracking-wide ${fredoka.className}`}>
            STORKHUB
          </span>
        </div>

        {/* Estado: verificando link */}
        {status === 'loading' && (
          <div className="text-center py-8">
            <div className="mx-auto mb-4 h-8 w-8 animate-spin rounded-full border-4 border-[#004aad] border-t-transparent" />
            <p className="text-gray-500 text-sm">Comprobando enlace…</p>
          </div>
        )}

        {/* Estado: link inválido / expirado */}
        {status === 'error' && (
          <div className="text-center py-4">
            <XCircle className="mx-auto mb-3 text-red-500" size={40} />
            <p className="text-red-600 text-sm font-medium mb-1">Enlace inválido o expirado</p>
            <p className="text-gray-500 text-sm mb-6">{errorMsg}</p>
            <button
              onClick={() => router.replace('/login')}
              className="w-full rounded-full border border-[#004aad] text-[#004aad] font-semibold py-2 hover:bg-[#004aad] hover:text-white transition-colors"
            >
              Volver al inicio de sesión
            </button>
          </div>
        )}

        {/* Estado: éxito */}
        {status === 'ok' && (
          <div className="text-center py-4">
            <CheckCircle2 className="mx-auto mb-3 text-green-500" size={40} />
            <p className="text-gray-900 font-semibold text-lg mb-1">¡Contraseña creada!</p>
            <p className="text-gray-500 text-sm mb-6">
              Ya podés ingresar a tu panel de StorkHub con tu correo y la contraseña que acabás de crear.
            </p>
            <button
              onClick={() => router.replace('/login')}
              className="w-full rounded-full bg-[#004aad] text-white font-semibold py-2 hover:bg-[#003a92] transition-colors"
            >
              Ir al inicio de sesión
            </button>
          </div>
        )}

        {/* Estado: formulario */}
        {(status === 'idle' || status === 'submitting') && (
          <>
            <div className="mb-6">
              <h1 className="text-xl font-bold text-gray-900">Crear tu contraseña</h1>
              <p className="mt-1 text-sm text-gray-500">
                Estás a un paso de acceder a tu panel de StorkHub.
              </p>
            </div>

            <form onSubmit={handleSubmit} className="space-y-4">
              {/* Nueva contraseña */}
              <label className="block text-sm">
                <span className="mb-1 block text-gray-700 font-medium">Nueva contraseña</span>
                <div className="relative">
                  <input
                    type={showPw ? 'text' : 'password'}
                    value={password}
                    onChange={(e) => { setPassword(e.target.value); setInlineError(null) }}
                    placeholder="••••••••"
                    className="w-full px-3 py-2 pr-10 border rounded-lg focus:outline-none focus:ring-2 focus:ring-[#004aad]"
                    required
                  />
                  <button
                    type="button"
                    onClick={() => setShowPw(v => !v)}
                    className="absolute right-3 top-1/2 -translate-y-1/2 text-gray-400 hover:text-gray-600"
                    tabIndex={-1}
                  >
                    {showPw ? <EyeOff size={18} /> : <Eye size={18} />}
                  </button>
                </div>
              </label>

              {/* Confirmar contraseña */}
              <label className="block text-sm">
                <span className="mb-1 block text-gray-700 font-medium">Confirmar contraseña</span>
                <div className="relative">
                  <input
                    type={showConfirm ? 'text' : 'password'}
                    value={confirm}
                    onChange={(e) => { setConfirm(e.target.value); setInlineError(null) }}
                    placeholder="••••••••"
                    className="w-full px-3 py-2 pr-10 border rounded-lg focus:outline-none focus:ring-2 focus:ring-[#004aad]"
                    required
                  />
                  <button
                    type="button"
                    onClick={() => setShowConfirm(v => !v)}
                    className="absolute right-3 top-1/2 -translate-y-1/2 text-gray-400 hover:text-gray-600"
                    tabIndex={-1}
                  >
                    {showConfirm ? <EyeOff size={18} /> : <Eye size={18} />}
                  </button>
                </div>
              </label>

              {/* Requisitos */}
              <ul className="text-xs text-gray-400 space-y-0.5 pl-1">
                <li className={password.length >= 8 ? 'text-green-600' : ''}>• Mínimo 8 caracteres</li>
                <li className={UPPER_RE.test(password) ? 'text-green-600' : ''}>• Al menos una letra mayúscula</li>
                <li className={SYMBOL_RE.test(password) ? 'text-green-600' : ''}>• Al menos un símbolo (!#$%&amp;/()?.*@_-+)</li>
              </ul>

              {/* Error inline */}
              {inlineError && (
                <p className="text-sm text-red-600">{inlineError}</p>
              )}

              <button
                type="submit"
                disabled={status === 'submitting'}
                className="w-full rounded-full bg-[#004aad] text-white font-semibold py-2 hover:bg-[#003a92] disabled:opacity-60 transition-colors mt-2"
              >
                {status === 'submitting' ? 'Guardando…' : 'Crear contraseña'}
              </button>
            </form>
          </>
        )}

      </div>
    </div>
  )
}

export default function CrearPasswordPage() {
  return (
    <Suspense fallback={
      <div className="min-h-screen flex items-center justify-center bg-gray-50">
        <p className="text-gray-500">Cargando…</p>
      </div>
    }>
      <CrearPasswordContent />
    </Suspense>
  )
}
