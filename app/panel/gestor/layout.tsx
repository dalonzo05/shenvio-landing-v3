'use client'

import React, { useEffect, useState } from 'react'
import { useRouter } from 'next/navigation'
import { doc, getDoc } from 'firebase/firestore'
import { db } from '@/fb/config'
import { useUser } from '@/app/Components/UserProvider'

type Rol = 'admin' | 'gestor' | 'motorizado' | 'cliente' | null

async function getUserRole(uid: string): Promise<Rol> {
  const ref = doc(db, 'usuarios', uid)
  const snap = await getDoc(ref)

  if (!snap.exists()) return null

  const data = snap.data()
  if (!data?.activo) return null

  return (data?.rol || null) as Rol
}

export default function GestorLayout({ children }: { children: React.ReactNode }) {
  const router = useRouter()
  const { authUser, loading } = useUser()
  const [checkingRole, setCheckingRole] = useState(true)

  useEffect(() => {
    const run = async () => {
      if (loading) return

      if (!authUser) {
        router.replace('/login')
        return
      }

      if (!authUser.emailVerified) {
        router.replace('/login?reason=verify')
        return
      }

      try {
        const rol = await getUserRole(authUser.uid)

        if (rol === 'admin' || rol === 'gestor') {
          setCheckingRole(false)
          return
        }

        if (rol === 'motorizado') {
          router.replace('/panel/motorizado')
          return
        }

        router.replace('/panel')
      } catch (e) {
        console.error(e)
        router.replace('/login')
      }
    }

    run()
  }, [authUser, loading, router])

  if (loading || checkingRole) {
    return (
      <div className="max-w-6xl mx-auto px-4 py-10">
        <p className="text-sm text-gray-600">Validando permisos...</p>
      </div>
    )
  }

  return <>{children}</>
}