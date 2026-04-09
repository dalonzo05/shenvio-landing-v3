'use client'

import React, {
  createContext,
  useContext,
  useEffect,
  useState,
  type ReactNode,
} from 'react'
import {
  onAuthStateChanged,
  signInWithEmailAndPassword,
  createUserWithEmailAndPassword,
  sendEmailVerification,
  sendPasswordResetEmail,
  signOut as fbSignOut,
  User,
  reload,
} from 'firebase/auth'
import { auth } from '@/fb/config'
import { readUserProfileByUid, upsertUserProfileByUid } from '@/fb/data'

export type ThemePref = 'light' | 'dark'
export type UserProfile = { email?: string; name?: string; theme?: ThemePref }

type Ctx = {
  authUser: User | null
  profile: UserProfile | null
  loading: boolean
  signIn: (email: string, password: string) => Promise<void>
  signUp: (email: string, password: string, name?: string) => Promise<void>
  resendVerification: () => Promise<void>
  resetPassword: (email: string) => Promise<void>
  refreshProfile: () => Promise<void>
  signOut: () => Promise<void>
}

const UserCtx = createContext<Ctx | undefined>(undefined)

export function UserProvider({ children }: { children: ReactNode }) {
  const [authUser, setAuthUser] = useState<User | null>(null)
  const [profile, setProfile] = useState<UserProfile | null>(null)
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    const unsub = onAuthStateChanged(auth, async (u) => {
      setLoading(true)
      setAuthUser(u)

      if (!u) {
        setProfile(null)
        try {
          localStorage.removeItem('storkhub:user')
        } catch {}
        setLoading(false)
        return
      }

      try {
        // Intenta asegurar doc mínimo
        try {
          await upsertUserProfileByUid(u.uid, { email: u.email ?? '' })
        } catch (err) {
          console.warn('No se pudo crear/actualizar el perfil en Firestore:', err)
        }

        // Intenta leer perfil extendido
        let p: UserProfile | null = null
        try {
          p = await readUserProfileByUid(u.uid)
        } catch (err) {
          console.warn('No se pudo leer el perfil desde Firestore:', err)
        }

        const newProfile: UserProfile = {
          email: u.email ?? '',
          name: p?.name ?? '',
          theme: p?.theme,
        }

        setProfile(newProfile)

        try {
          localStorage.setItem('storkhub:user', JSON.stringify(newProfile))
        } catch {}
      } finally {
        setLoading(false)
      }
    })

    return () => unsub()
  }, [])

  useEffect(() => {
    const refresh = async () => {
      if (auth.currentUser) {
        try {
          await reload(auth.currentUser)
        } catch {}
        setAuthUser(auth.currentUser)
      }
    }

    refresh()

    const onFocus = () => {
      refresh()
    }

    if (typeof window !== 'undefined') {
      window.addEventListener('focus', onFocus)
      return () => window.removeEventListener('focus', onFocus)
    }
  }, [authUser?.uid])

  useEffect(() => {
    if (!authUser) return
    let remember = false
    try { remember = localStorage.getItem('storkhub:remember') === 'true' } catch {}
    if (remember) return

    const TIMEOUT_MS = 30 * 60 * 1000
    let timer: ReturnType<typeof setTimeout>

    const reset = () => {
      clearTimeout(timer)
      timer = setTimeout(async () => {
        await fbSignOut(auth)
        try {
          localStorage.removeItem('storkhub:user')
          localStorage.removeItem('storkhub:remember')
        } catch {}
      }, TIMEOUT_MS)
    }

    const events = ['mousemove', 'keydown', 'click', 'touchstart'] as const
    events.forEach((e) => window.addEventListener(e, reset))
    reset()

    return () => {
      clearTimeout(timer)
      events.forEach((e) => window.removeEventListener(e, reset))
    }
  }, [authUser?.uid])

  const signIn = async (email: string, password: string) => {
    setLoading(true)
    try {
      await signInWithEmailAndPassword(auth, email, password)
    } finally {
      setLoading(false)
    }
  }

  const signUp = async (email: string, password: string, name?: string) => {
    setLoading(true)
    try {
      const cred = await createUserWithEmailAndPassword(auth, email, password)

      try {
        await upsertUserProfileByUid(cred.user.uid, { email, name })
      } catch (err) {
        console.warn('No se pudo guardar el perfil al registrarse:', err)
      }

      try {
        await sendEmailVerification(cred.user)
      } catch {}
    } finally {
      setLoading(false)
    }
  }

  const resendVerification = async () => {
    if (!auth.currentUser) return
    await reload(auth.currentUser)
    if (!auth.currentUser.emailVerified) {
      await sendEmailVerification(auth.currentUser)
    }
  }

  const resetPassword = async (email: string) => {
    if (!email) throw new Error('Ingresá tu correo')
    await sendPasswordResetEmail(auth, email.trim())
  }

  const refreshProfile = async () => {
    if (!auth.currentUser) return

    const u = auth.currentUser

    let p: UserProfile | null = null
    try {
      p = await readUserProfileByUid(u.uid)
    } catch (err) {
      console.warn('No se pudo refrescar el perfil desde Firestore:', err)
    }

    const merged: UserProfile = {
      email: u.email ?? '',
      name: p?.name ?? '',
      theme: p?.theme,
    }

    setProfile(merged)

    try {
      localStorage.setItem('storkhub:user', JSON.stringify(merged))
    } catch {}

    try {
      await reload(u)
      setAuthUser(auth.currentUser)
    } catch {}
  }

  const signOut = async () => {
    await fbSignOut(auth)
    try {
      localStorage.removeItem('storkhub:user')
      localStorage.removeItem('storkhub:remember')
    } catch {}
  }

  return (
    <UserCtx.Provider
      value={{
        authUser,
        profile,
        loading,
        signIn,
        signUp,
        resendVerification,
        resetPassword,
        refreshProfile,
        signOut,
      }}
    >
      {children}
    </UserCtx.Provider>
  )
}

export function useUser() {
  const ctx = useContext(UserCtx)
  if (!ctx) throw new Error('useUser must be used within <UserProvider>')
  return ctx
}

export default UserProvider