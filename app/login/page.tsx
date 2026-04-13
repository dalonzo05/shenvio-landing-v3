'use client'

import React, { Suspense, useEffect, useState } from 'react'
import Link from 'next/link'
import { useRouter, useSearchParams } from 'next/navigation'
import { Fredoka } from 'next/font/google'
import { useUser } from '@/app/Components/UserProvider'

import {
  setPersistence,
  browserLocalPersistence,
  browserSessionPersistence,
} from 'firebase/auth'
import { auth, db } from '@/fb/config'
import { doc, getDocFromServer } from 'firebase/firestore'

const fredoka = Fredoka({ subsets: ['latin'], weight: ['400', '700'] })

const ACCESS_CODE = process.env.NEXT_PUBLIC_ACCESS_CODE
const requireAccessCode = !!ACCESS_CODE

async function getRedirectByRole(uid: string) {
  const ref = doc(db, 'usuarios', uid)
  const snap = await getDocFromServer(ref)

  if (!snap.exists()) return '/panel'

  const data = snap.data()

  if (!data?.activo) {
    throw new Error('Tu usuario está inactivo. Contacta al administrador.')
  }

  const rol = data?.rol

  if (rol === 'admin' || rol === 'gestor') return '/panel/gestor'
  if (rol === 'motorizado') return '/panel/motorizado'
  if (rol === 'Comercio') return '/panel/comercio'
  return '/panel'
}

function LoginContent() {
  const router = useRouter()
  const search = useSearchParams()
  const next = search.get('next')
  const { authUser, loading, signIn, resetPassword, resendVerification } = useUser()

  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [code, setCode] = useState('')
  const [remember, setRemember] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [submitting, setSubmitting] = useState(false)

  useEffect(() => {
    const redirectLoggedUser = async () => {
      if (loading) return
      if (!authUser) return
      if (!authUser.emailVerified) return

      try {
        if (next && next.startsWith('/panel')) {
          router.replace(next)
          return
        }

        const target = await getRedirectByRole(authUser.uid)
        router.replace(target)
      } catch (err: unknown) {
        setError((err as Error)?.message || 'No se pudo determinar el rol del usuario.')
      }
    }

    redirectLoggedUser()
  }, [loading, authUser, next, router])

  const guardCode = () => {
    if (!requireAccessCode) return true
    if (code.trim() === ACCESS_CODE) return true
    setError('Código de acceso inválido.')
    return false
  }

  const handleLogin = async (e: React.FormEvent) => {
    e.preventDefault()
    setError(null)
    if (!guardCode()) return

    setSubmitting(true)
    try {
      await setPersistence(
        auth,
        remember ? browserLocalPersistence : browserSessionPersistence
      )

      await signIn(email.trim(), password)
      try { localStorage.setItem('storkhub:remember', remember ? 'true' : 'false') } catch {}
      // La redirección la hace el useEffect cuando authUser ya está cargado
    } catch (err: unknown) {
      setError((err as Error)?.message || 'No se pudo iniciar sesión.')
    } finally {
      setSubmitting(false)
    }
  }

  const handleForgot = async () => {
    setError(null)
    const e = email.trim()
    if (!e) {
      setError('Ingresá tu correo y luego presioná "Olvidé mi contraseña".')
      return
    }
    try {
      await resetPassword(e)
      alert('Te enviamos un enlace para restablecer tu contraseña.')
    } catch (err: unknown) {
      setError((err as Error)?.message || 'No se pudo enviar el correo de recuperación.')
    }
  }

  const handleResend = async () => {
    setError(null)
    try {
      await resendVerification()
      alert('Si tu cuenta no estaba verificada, te enviamos un correo de verificación.')
    } catch (err: unknown) {
      setError((err as Error)?.message || 'No se pudo reenviar el correo.')
    }
  }

  return (
    <div className="min-h-screen flex items-center justify-center bg-gray-50 px-4">
      <div className="w-full max-w-md bg-white shadow-lg rounded-2xl p-8">
        <div className="text-center mb-6">
          <Link
            href="/"
            className={`text-[#004aad] text-2xl font-bold tracking-wide ${fredoka.className}`}
          >
            STORKHUB
          </Link>
          <p className="mt-2 text-gray-500 text-sm">Acceso al sistema</p>
        </div>

        <form onSubmit={handleLogin} className="space-y-4">
          <label className="block text-sm">
            <span className="mb-1 block text-gray-700">Correo</span>
            <input
              type="email"
              placeholder="usuario@ejemplo.com"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              className="w-full px-3 py-2 border rounded-lg focus:ring-2 focus:ring-[#004aad]"
              autoComplete="email"
              required
            />
          </label>

          <label className="block text-sm">
            <span className="mb-1 block text-gray-700">Contraseña</span>
            <input
              type="password"
              placeholder="••••••••"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              className="w-full px-3 py-2 border rounded-lg focus:ring-2 focus:ring-[#004aad]"
              autoComplete="current-password"
              required
              minLength={6}
            />
          </label>

          <label className="flex items-center gap-2 text-sm select-none">
            <input
              type="checkbox"
              checked={remember}
              onChange={(e) => setRemember(e.target.checked)}
            />
            Recordarme (mantener sesión iniciada)
          </label>

          {requireAccessCode && (
            <label className="block text-sm">
              <span className="mb-1 block text-gray-700">Código de acceso</span>
              <input
                type="password"
                placeholder="••••••"
                value={code}
                onChange={(e) => setCode(e.target.value)}
                className="w-full px-3 py-2 border rounded-lg focus:ring-2 focus:ring-[#004aad]"
              />
            </label>
          )}

          {error && <p className="text-sm text-red-600">{error}</p>}

          <button
            type="submit"
            disabled={submitting || loading}
            className="w-full rounded-full bg-[#004aad] text-white font-semibold py-2 hover:bg-[#003a92] disabled:opacity-70"
          >
            {submitting ? 'Ingresando…' : 'Iniciar sesión'}
          </button>

          <div className="flex items-center justify-between text-sm text-gray-600 pt-2">
            <button type="button" onClick={handleForgot} className="hover:underline">
              Olvidé mi contraseña
            </button>
            <button type="button" onClick={handleResend} className="hover:underline">
              Reenviar verificación
            </button>
          </div>
        </form>

        <p className="mt-6 text-center text-sm text-gray-500">
          <Link href="/" className="hover:underline">
            ← Volver al inicio
          </Link>
        </p>
      </div>
    </div>
  )
}

export default function LoginPage() {
  return (
    <Suspense fallback={
      <div className="min-h-screen flex items-center justify-center bg-gray-50">
        <p className="text-gray-500">Cargando…</p>
      </div>
    }>
      <LoginContent />
    </Suspense>
  )
}
