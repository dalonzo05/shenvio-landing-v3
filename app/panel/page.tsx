'use client'

import React, { useEffect, useState } from 'react'
import Link from 'next/link'
import { useRouter } from 'next/navigation'
import { Calculator, Send, MapPin, History, Package, ShieldCheck } from 'lucide-react'
import { doc, getDoc } from 'firebase/firestore'
import { db } from '@/fb/config'
import { useUser } from '@/app/Components/UserProvider'

type Rol = 'admin' | 'gestor' | 'motorizado' | 'Comercio' | null

async function getUserRole(uid: string): Promise<Rol> {
  const ref = doc(db, 'usuarios', uid)
  const snap = await getDoc(ref)

  if (!snap.exists()) return null

  const data = snap.data()
  if (!data?.activo) return null

  return (data?.rol || null) as Rol
}

export default function PanelHome() {
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
          router.replace('/panel/gestor')
          return
        }

        if (rol === 'motorizado') {
          router.replace('/panel/motorizado')
          return
        }

        if (rol === 'Comercio') {
          router.replace('/panel/comercio')
          return
        }

        setCheckingRole(false)
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
        <p className="text-sm text-gray-600">Validando acceso...</p>
      </div>
    )
  }

  return (
    <div className="max-w-6xl mx-auto px-4 py-6 space-y-8">
      <div className="rounded-2xl bg-white border shadow-sm p-6">
        <div className="inline-flex items-center gap-2 rounded-full border border-blue-200 bg-blue-50 px-3 py-1 text-sm text-blue-700">
          <ShieldCheck className="h-4 w-4" />
          Panel del cliente
        </div>

        <h1 className="text-3xl font-bold mt-4 text-[#004aad]">Bienvenido a tu panel</h1>
        <p className="text-gray-600 mt-2 max-w-3xl">
          Desde aquí podés cotizar precios, solicitar envíos y más adelante revisar el historial
          de tus pedidos, tus direcciones guardadas y el seguimiento de tus entregas.
        </p>
      </div>

      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-6">
        <Link
          href="/panel/calculadora"
          className="group rounded-2xl border bg-white p-6 shadow-sm hover:shadow-md hover:-translate-y-0.5 transition"
        >
          <div className="flex items-center gap-3">
            <div className="rounded-lg bg-[#004aad]/10 p-2">
              <Calculator className="h-6 w-6 text-[#004aad]" />
            </div>
            <h2 className="text-lg font-semibold">Calculadora</h2>
          </div>
          <p className="text-gray-600 text-sm mt-2">Cotizá tus envíos por distancia.</p>
          <div className="mt-4 text-sm font-semibold text-[#004aad]">Abrir →</div>
        </Link>

        <Link
          href="/panel/solicitar"
          className="group rounded-2xl border bg-white p-6 shadow-sm hover:shadow-md hover:-translate-y-0.5 transition"
        >
          <div className="flex items-center gap-3">
            <div className="rounded-lg bg-[#004aad]/10 p-2">
              <Send className="h-6 w-6 text-[#004aad]" />
            </div>
            <h2 className="text-lg font-semibold">Solicitar envío</h2>
          </div>
          <p className="text-gray-600 text-sm mt-2">Creá tu orden de entrega desde aquí.</p>
          <div className="mt-4 text-sm font-semibold text-[#004aad]">Abrir →</div>
        </Link>

        <div className="pointer-events-none opacity-60 rounded-2xl border bg-white p-6 shadow-sm">
          <div className="flex items-center gap-3">
            <div className="rounded-lg bg-[#004aad]/10 p-2">
              <MapPin className="h-6 w-6 text-[#004aad]" />
            </div>
            <h2 className="text-lg font-semibold">Mis direcciones</h2>
          </div>
          <p className="text-gray-600 text-sm mt-2">Próximamente: guarda tus lugares.</p>
        </div>

        <div className="pointer-events-none opacity-60 rounded-2xl border bg-white p-6 shadow-sm">
          <div className="flex items-center gap-3">
            <div className="rounded-lg bg-[#004aad]/10 p-2">
              <History className="h-6 w-6 text-[#004aad]" />
            </div>
            <h2 className="text-lg font-semibold">Historial</h2>
          </div>
          <p className="text-gray-600 text-sm mt-2">Próximamente: tus entregas y estados.</p>
        </div>
      </div>

      <div className="rounded-2xl border bg-white p-6 shadow-sm">
        <div className="flex items-start gap-3">
          <div className="rounded-lg bg-gray-100 p-2">
            <Package className="h-5 w-5 text-gray-700" />
          </div>
          <div>
            <h3 className="text-lg font-semibold">¿Qué vendrá después?</h3>
            <p className="text-sm text-gray-600 mt-1 max-w-2xl">
              Este panel crecerá para que el cliente pueda solicitar pedidos, ver estados, revisar
              su historial y administrar información frecuente sin depender de mensajes manuales.
            </p>
          </div>
        </div>
      </div>
    </div>
  )
}