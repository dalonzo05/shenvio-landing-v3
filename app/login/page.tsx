'use client'

import React, { Suspense, useCallback, useEffect, useState } from 'react'
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

  if (!snap.exists()) {
    throw new Error('No tenés acceso al sistema. Contacta al administrador.')
  }

  const data = snap.data()

  if (data?.activo === false) {
    throw new Error('Tu usuario está inactivo. Contacta al administrador.')
  }

  const rol = data?.rol

  if (rol === 'admin' || rol === 'gestor') return '/panel/gestor'
  if (rol === 'motorizado') return '/panel/motorizado'
  if (rol === 'Comercio') return '/panel/comercio'
  // DIGITADOR V1: mismo destino que rutaDeRol() en app/panel/_hooks/useRoleGuard.ts
  // — si alguno cambia, el otro tiene que cambiar también (deuda de duplicación
  // ya documentada ahí, no introducida por este bloque).
  if (rol === 'digitador') return '/panel/digitador'

  throw new Error('No tenés un rol asignado. Contacta al administrador.')
}

function LoginContent() {
  const router = useRouter()
  const search = useSearchParams()
  const next = search.get('next')
  const { authUser, loading, signIn, resendVerification, refreshProfile, signOut } = useUser()

  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [code, setCode] = useState('')
  const [remember, setRemember] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [submitting, setSubmitting] = useState(false)

  const [resendEstado, setResendEstado] = useState<'idle' | 'enviando' | 'enviado' | 'error'>('idle')
  const [verificando, setVerificando] = useState(false)
  const [aunNoVerificado, setAunNoVerificado] = useState(false)

  // AUTH-EMAIL-VERIFICATION-LOOP-1: único punto que decide a dónde va un
  // usuario ya autenticado y verificado — lo usan tanto el efecto de abajo
  // como el botón "Ya verifiqué mi correo", para no duplicar el criterio de
  // "next" vs. rol.
  const irAlPanelSegunRol = useCallback(async (uid: string) => {
    if (next && next.startsWith('/panel')) {
      router.replace(next)
      return
    }
    const target = await getRedirectByRole(uid)
    router.replace(target)
  }, [next, router])

  useEffect(() => {
    const redirectLoggedUser = async () => {
      if (loading) return
      if (!authUser) return
      // AUTH-EMAIL-VERIFICATION-LOOP-1: un authUser sin emailVerified NUNCA
      // redirige al panel desde acá. Antes sí lo hacía, y era la otra mitad
      // del loop: app/panel/layout.tsx lo expulsaba de vuelta a
      // /login?reason=verify, y este efecto lo mandaba otra vez al panel sin
      // mirar emailVerified — ninguna de las dos pantallas pintaba nada
      // mientras tanto. Ahora se queda en /login y se renderiza la vista de
      // verificación (VerificarCorreoNotice) en su lugar.
      if (!authUser.emailVerified) return
      try {
        await irAlPanelSegunRol(authUser.uid)
      } catch (err: unknown) {
        setError((err as Error)?.message || 'No se pudo determinar el rol del usuario.')
      }
    }

    redirectLoggedUser()
  }, [loading, authUser, irAlPanelSegunRol])

  const handleReenviarVerificacion = async () => {
    setResendEstado('enviando')
    try {
      await resendVerification()
      setResendEstado('enviado')
    } catch {
      setResendEstado('error')
    }
  }

  const handleYaVerifique = async () => {
    setVerificando(true)
    setAunNoVerificado(false)
    try {
      // No basta con refrescar el estado de React: hay que recargar el
      // usuario real de Firebase Auth (refreshProfile hace reload() por
      // dentro) y decidir sobre auth.currentUser, no sobre el authUser
      // capturado en este cierre, que todavía sería el de antes de recargar.
      await refreshProfile()
      if (auth.currentUser?.emailVerified) {
        await irAlPanelSegunRol(auth.currentUser.uid)
      } else {
        setAunNoVerificado(true)
      }
    } catch {
      setAunNoVerificado(true)
    } finally {
      setVerificando(false)
    }
  }

  const handleCerrarSesion = async () => {
    await signOut()
  }

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
      const res = await fetch('/api/send-reset-password', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email: e }),
      })
      const data = await res.json()
      if (!res.ok) {
        setError(data.error || 'No se pudo enviar el correo de recuperación.')
        return
      }
      alert('Te enviamos un enlace para restablecer tu contraseña. Revisá tu bandeja de entrada.')
    } catch {
      setError('No se pudo enviar el correo de recuperación.')
    }
  }

  // AUTH-EMAIL-VERIFICATION-LOOP-1 — Caso C del contrato: authUser existe
  // pero emailVerified es false. No se redirige (ver efecto arriba) ni se
  // muestra el formulario de login: se muestra esta vista en su lugar, para
  // que la persona pueda reenviar el correo, comprobar de nuevo o cerrar
  // sesión sin quedar atrapada en una pantalla blanca.
  if (authUser && !authUser.emailVerified) {
    return (
      <VerificarCorreoNotice
        email={authUser.email}
        resendEstado={resendEstado}
        verificando={verificando}
        aunNoVerificado={aunNoVerificado}
        onReenviar={handleReenviarVerificacion}
        onYaVerifique={handleYaVerifique}
        onCerrarSesion={handleCerrarSesion}
      />
    )
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

          <div className="flex items-center justify-center text-sm text-gray-600 pt-2">
            <button type="button" onClick={handleForgot} className="hover:underline">
              Olvidé mi contraseña
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

// AUTH-EMAIL-VERIFICATION-LOOP-1 — sin lenguaje técnico (nada de
// "emailVerified", "Firebase" ni "Auth" en el copy visible, por pedido
// explícito del bloque).
function VerificarCorreoNotice({
  email,
  resendEstado,
  verificando,
  aunNoVerificado,
  onReenviar,
  onYaVerifique,
  onCerrarSesion,
}: {
  email: string | null
  resendEstado: 'idle' | 'enviando' | 'enviado' | 'error'
  verificando: boolean
  aunNoVerificado: boolean
  onReenviar: () => void
  onYaVerifique: () => void
  onCerrarSesion: () => void
}) {
  return (
    <div className="min-h-screen flex items-center justify-center bg-gray-50 px-4">
      <div className="w-full max-w-md bg-white shadow-lg rounded-2xl p-8 text-center">
        <div className="mb-6">
          <Link
            href="/"
            className={`text-[#004aad] text-2xl font-bold tracking-wide ${fredoka.className}`}
          >
            STORKHUB
          </Link>
        </div>

        <h1 className="text-lg font-semibold text-gray-900 mb-2">Verifica tu correo</h1>
        <p className="text-sm text-gray-600 mb-1">
          Antes de entrar al panel, verifica tu dirección de correo electrónico.
        </p>
        {email && <p className="text-sm text-gray-500 mb-6">{email}</p>}

        <div className="space-y-3 mt-4">
          <button
            type="button"
            onClick={onReenviar}
            disabled={resendEstado === 'enviando'}
            className="w-full rounded-full bg-[#004aad] text-white font-semibold py-2 hover:bg-[#003a92] disabled:opacity-70"
          >
            {resendEstado === 'enviando' ? 'Enviando…' : 'Reenviar correo de verificación'}
          </button>

          {resendEstado === 'enviado' && (
            <p className="text-sm text-green-600">Correo de verificación enviado.</p>
          )}
          {resendEstado === 'error' && (
            <p className="text-sm text-red-600">
              No se pudo reenviar el correo. Intentá de nuevo en unos minutos.
            </p>
          )}

          <button
            type="button"
            onClick={onYaVerifique}
            disabled={verificando}
            className="w-full rounded-full border border-[#004aad] text-[#004aad] font-semibold py-2 hover:bg-blue-50 disabled:opacity-70"
          >
            {verificando ? 'Comprobando…' : 'Ya verifiqué mi correo'}
          </button>

          {aunNoVerificado && (
            <p className="text-sm text-red-600">El correo todavía no aparece como verificado.</p>
          )}

          <button
            type="button"
            onClick={onCerrarSesion}
            className="w-full text-sm text-gray-500 hover:underline py-2"
          >
            Cerrar sesión
          </button>
        </div>
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
