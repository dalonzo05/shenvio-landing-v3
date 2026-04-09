'use client'

import React, { useEffect } from 'react'
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
    if (!authUser.emailVerified) {
      router.replace('/login?reason=verify')
      return
    }
  }, [loading, authUser, router])

  if (loading || !authUser || !authUser.emailVerified) return null

  return (
    <div className="min-h-screen bg-gray-50">{children}</div>
  )
}
