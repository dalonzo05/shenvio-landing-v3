'use client'

import React, { useEffect } from 'react'
import PanelTopBar from './panel-topbar'
import { useUser } from '@/app/Components/UserProvider'
import { useRouter } from 'next/navigation'

export default function PanelLayout({ children }: { children: React.ReactNode }) {
  const router = useRouter()
  const { authUser, loading } = useUser()

  useEffect(() => {
    if (loading) return
    if (!authUser) {
      router.replace('/login')
      return
    }
    // Bloquea completamente el panel si el correo NO está verificado
    if (!authUser.emailVerified) {
      router.replace('/login?reason=verify')
      return
    }
  }, [loading, authUser, router])

  if (loading || !authUser || !authUser.emailVerified) return null

  return (
    <div className="min-h-screen bg-gray-50">
      <PanelTopBar />
      <div className="max-w-6xl mx-auto px-4 py-6">{children}</div>
    </div>
  )
}
