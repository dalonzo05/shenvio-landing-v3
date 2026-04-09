'use client'

import { useEffect, useMemo, useState } from 'react'
import Link from 'next/link'
import { useRouter } from 'next/navigation'
import { collection, onSnapshot, query, where, Timestamp } from 'firebase/firestore'
import { auth, db } from '@/fb/config'
import { useUser } from '@/app/Components/UserProvider'
import { Plus, Package } from 'lucide-react'

type Solicitud = {
  id: string
  estado?: string
  createdAt?: Timestamp
  entregadoAt?: Timestamp
  recoleccion?: { direccionEscrita?: string }
  entrega?: { nombreApellido?: string; direccionEscrita?: string }
  confirmacion?: { precioFinalCordobas?: number }
  cobroContraEntrega?: { aplica?: boolean }
  registro?: {
    deposito?: {
      confirmadoComercio?: boolean
      confirmadoMotorizado?: boolean
    }
  }
}

const estadoLabel: Record<string, string> = {
  pendiente_confirmacion: 'Pendiente',
  confirmada: 'Confirmada',
  asignada: 'Asignada',
  en_camino_retiro: 'En camino',
  retirado: 'Retirado',
  en_camino_entrega: 'En camino',
  entregado: 'Entregada',
  cancelada: 'Cancelada',
}

const estadoCls: Record<string, string> = {
  pendiente_confirmacion: 'bg-gray-100 text-gray-600',
  confirmada: 'bg-blue-50 text-blue-700',
  asignada: 'bg-yellow-50 text-yellow-700',
  en_camino_retiro: 'bg-yellow-50 text-yellow-700',
  retirado: 'bg-purple-50 text-purple-700',
  en_camino_entrega: 'bg-purple-50 text-purple-700',
  entregado: 'bg-green-50 text-green-700',
  cancelada: 'bg-red-50 text-red-600',
}

function tsToDate(v: any): Date | null {
  if (!v) return null
  if (typeof v?.toDate === 'function') return v.toDate()
  if (v instanceof Date) return v
  return null
}

function fmt(n?: number) {
  if (typeof n !== 'number') return '—'
  return `C$ ${n.toLocaleString('es-NI')}`
}

export default function ComercioDashboard() {
  const { profile } = useUser()
  const router = useRouter()
  const [ordenes, setOrdenes] = useState<Solicitud[]>([])
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    const user = auth.currentUser
    if (!user) return
    const q = query(collection(db, 'solicitudes_envio'), where('userId', '==', user.uid))
    const unsub = onSnapshot(q, (snap) => {
      const list: Solicitud[] = snap.docs
        .map((d) => ({ id: d.id, ...(d.data() as any) }))
        .sort((a, b) => (tsToDate(b.createdAt)?.getTime() || 0) - (tsToDate(a.createdAt)?.getTime() || 0))
      setOrdenes(list)
      setLoading(false)
    })
    return () => unsub()
  }, [])

  const hoy = new Date()
  const inicioMes = new Date(hoy.getFullYear(), hoy.getMonth(), 1)

  const stats = useMemo(() => {
    const hoyStart = new Date(); hoyStart.setHours(0, 0, 0, 0)
    return {
      hoy: ordenes.filter((o) => {
        const d = tsToDate(o.createdAt); return d && d >= hoyStart
      }).length,
      pendientes: ordenes.filter((o) => o.estado === 'pendiente_confirmacion').length,
      entregadasMes: ordenes.filter((o) => {
        const d = tsToDate(o.entregadoAt) || tsToDate(o.createdAt)
        return o.estado === 'entregado' && d && d >= inicioMes
      }).length,
      depositosPendientes: ordenes.filter((o) =>
        o.cobroContraEntrega?.aplica &&
        o.estado === 'entregado' &&
        !o.registro?.deposito?.confirmadoComercio &&
        !o.registro?.deposito?.confirmadoMotorizado
      ).length,
    }
  }, [ordenes])

  const ultimas = ordenes.slice(0, 5)

  return (
    <div className="flex flex-col gap-4">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-black text-gray-900 tracking-tight">
            ¡Hola, {profile?.name || 'Bienvenido'}!
          </h1>
          <p className="text-sm text-gray-500 mt-0.5">Aquí podés ver y gestionar tus envíos.</p>
        </div>
        <Link
          href="/panel/comercio/solicitar"
          className="flex items-center gap-2 bg-[#004aad] text-white text-sm font-semibold px-4 py-2 rounded-xl hover:bg-[#003a8c] transition"
        >
          <Plus className="h-4 w-4" />
          Nueva orden
        </Link>
      </div>

      {/* Stats */}
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
        {[
          { label: 'Órdenes hoy', value: loading ? '…' : stats.hoy, color: 'text-[#004aad]', bg: 'bg-blue-50', href: '/panel/comercio/mis-ordenes' },
          { label: 'Pendientes', value: loading ? '…' : stats.pendientes, color: 'text-yellow-700', bg: 'bg-yellow-50', href: '/panel/comercio/mis-ordenes' },
          { label: 'Entregadas este mes', value: loading ? '…' : stats.entregadasMes, color: 'text-green-700', bg: 'bg-green-50', href: '/panel/comercio/mis-ordenes' },
          { label: 'Depósitos pendientes', value: loading ? '…' : stats.depositosPendientes, color: 'text-orange-700', bg: 'bg-orange-50', href: '/panel/comercio/depositos' },
        ].map((s) => (
          <Link key={s.label} href={s.href} className={`${s.bg} rounded-xl border border-gray-200 px-4 py-3 hover:opacity-80 transition`}>
            <p className={`text-3xl font-black ${s.color}`}>{s.value}</p>
            <p className="text-xs font-semibold text-gray-500 mt-0.5">{s.label}</p>
          </Link>
        ))}
      </div>

      {/* Últimas órdenes */}
      <div className="overflow-x-auto rounded-xl border border-gray-200 bg-white shadow-sm">
        <div className="flex items-center justify-between px-4 py-3 border-b border-gray-100">
          <h2 className="text-sm font-black text-gray-800">Órdenes recientes</h2>
          <Link href="/panel/comercio/mis-ordenes" className="text-xs font-semibold text-[#004aad] hover:underline">
            Ver todas →
          </Link>
        </div>
        {loading ? (
          <div className="py-10 text-center text-sm text-gray-400">Cargando…</div>
        ) : ultimas.length === 0 ? (
          <div className="flex flex-col items-center justify-center py-12 gap-2 text-gray-400">
            <Package className="h-8 w-8 opacity-30" />
            <p className="text-sm">Aún no tenés órdenes</p>
            <Link href="/panel/comercio/solicitar" className="text-sm font-semibold text-[#004aad] hover:underline">
              Crear primera orden →
            </Link>
          </div>
        ) : (
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b bg-gray-50 text-left text-[11px] font-semibold uppercase tracking-wide text-gray-500">
                <th className="px-4 py-3">Destinatario</th>
                <th className="px-4 py-3">Dirección</th>
                <th className="px-4 py-3">Delivery</th>
                <th className="px-4 py-3">Estado</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-100">
              {ultimas.map((o) => {
                const cls = estadoCls[o.estado || ''] || 'bg-gray-100 text-gray-600'
                return (
                  <tr key={o.id} className="hover:bg-gray-50 transition-colors cursor-pointer"
                    onClick={() => router.push(`/panel/comercio/mis-ordenes/${o.id}`)}>
                    <td className="px-4 py-3 font-semibold text-gray-900">
                      {o.entrega?.nombreApellido || '—'}
                    </td>
                    <td className="px-4 py-3 text-gray-500 max-w-[200px] truncate">
                      {o.entrega?.direccionEscrita || '—'}
                    </td>
                    <td className="px-4 py-3 text-[#004aad] font-semibold">
                      {fmt(o.confirmacion?.precioFinalCordobas)}
                    </td>
                    <td className="px-4 py-3">
                      <span className={`inline-flex text-xs font-semibold px-2.5 py-1 rounded-full ${cls}`}>
                        {estadoLabel[o.estado || ''] || o.estado}
                      </span>
                    </td>
                  </tr>
                )
              })}
            </tbody>
          </table>
        )}
      </div>
    </div>
  )
}
