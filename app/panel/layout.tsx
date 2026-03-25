'use client'

import React, { useEffect } from 'react'
import PanelTopBar from './panel-topbar'
import { useUser } from '@/app/Components/UserProvider'
import { useRouter, usePathname } from 'next/navigation'

export default function PanelLayout({ children }: { children: React.ReactNode }) {
  const router = useRouter()
  const pathname = usePathname()
  const { authUser, loading } = useUser()

  useEffect(() => {
    if (loading) return

    if (!authUser) {
      router.replace('/login')
      return
    }

    if (!authUser.emailVerified) {
      router.replace('/login?reason=verify')
      return
    }
  }, [loading, authUser, router])

  if (loading || !authUser || !authUser.emailVerified) return null

  const isGestor = pathname?.startsWith('/panel/gestor')
  const isMotorizado = pathname?.startsWith('/panel/motorizado')

  if (isGestor) {
    return <>{children}</>
  }

  const contentClass = isMotorizado
    ? 'w-full px-4 md:px-6 py-5'
    : 'max-w-6xl mx-auto px-4 py-6'

  return (
    <div className="min-h-screen bg-gray-50">
      <PanelTopBar />
      <div className={contentClass}>{children}</div>
    </div>
  )
}