'use client'

import { useEffect, useMemo, useState } from 'react'
import Link from 'next/link'
import { collection, onSnapshot, query, where, orderBy, Timestamp } from 'firebase/firestore'
import { auth, db } from '@/fb/config'
import { Package } from 'lucide-react'

// ─── Types ────────────────────────────────────────────────────────────────────

type Solicitud = {
  id: string
  estado?: string
  createdAt?: Timestamp
  recoleccion?: { direccionEscrita?: string; nombreApellido?: string }
  entrega?: { direccionEscrita?: string; nombreApellido?: string }
  confirmacion?: { precioFinalCordobas?: number }
  cobroContraEntrega?: { aplica?: boolean; monto?: number }
  pagoDelivery?: { tipo?: string; quienPaga?: string }
  tipoCliente?: string
  cobrosMotorizado?: {
    delivery?: { monto: number; recibio: boolean }
    producto?: { monto: number; recibio: boolean }
  }
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

const estadoLabel: Record<string, string> = {
  pendiente_confirmacion: 'Pendiente',
  confirmada: 'Confirmada',
  asignada: 'Asignada',
  en_camino_retiro: 'En camino al retiro',
  retirado: 'Retirado',
  en_camino_entrega: 'En camino a entrega',
  entregado: 'Entregada',
  cancelada: 'Cancelada',
}

const estadoCls: Record<string, string> = {
  pendiente_confirmacion: 'bg-gray-100 text-gray-600 border-gray-200',
  confirmada: 'bg-blue-50 text-blue-700 border-blue-200',
  asignada: 'bg-yellow-50 text-yellow-700 border-yellow-200',
  en_camino_retiro: 'bg-yellow-50 text-yellow-700 border-yellow-200',
  retirado: 'bg-purple-50 text-purple-700 border-purple-200',
  en_camino_entrega: 'bg-purple-50 text-purple-700 border-purple-200',
  entregado: 'bg-green-50 text-green-700 border-green-200',
  cancelada: 'bg-red-50 text-red-600 border-red-200',
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

function fmtDate(v: any) {
  const d = tsToDate(v)
  if (!d) return '—'
  return d.toLocaleDateString('es-NI', { day: '2-digit', month: 'short', year: 'numeric' })
}

function debeDelivery(s: Solicitud): boolean | null {
  const qp = s.pagoDelivery?.quienPaga || ''
  if (s.tipoCliente === 'credito' || qp === 'credito_semanal') return true
  if (qp === 'transferencia') return false
  // efectivo — depende de si motorizado confirmó recibo
  if (s.cobrosMotorizado?.delivery !== undefined) return !s.cobrosMotorizado.delivery.recibio
  return null // sin info aún
}

// ─── Component ───────────────────────────────────────────────────────────────

type FiltroEstado = 'todas' | 'activas' | 'entregadas'

export default function MisOrdenesPage() {
  const [ordenes, setOrdenes] = useState<Solicitud[]>([])
  const [loading, setLoading] = useState(true)
  const [filtro, setFiltro] = useState<FiltroEstado>('todas')

  useEffect(() => {
    const user = auth.currentUser
    if (!user) return
    const q = query(
      collection(db, 'solicitudes_envio'),
      where('userId', '==', user.uid),
      orderBy('createdAt', 'desc')
    )
    const unsub = onSnapshot(q, (snap) => {
      setOrdenes(snap.docs.map((d) => ({ id: d.id, ...(d.data() as any) })))
      setLoading(false)
    })
    return () => unsub()
  }, [])

  const activas = ['pendiente_confirmacion', 'confirmada', 'asignada', 'en_camino_retiro', 'retirado', 'en_camino_entrega']

  const filtered = useMemo(() => {
    if (filtro === 'activas') return ordenes.filter((o) => activas.includes(o.estado || ''))
    if (filtro === 'entregadas') return ordenes.filter((o) => o.estado === 'entregado')
    return ordenes
  }, [ordenes, filtro])

  const thCls = 'px-4 py-3 text-left text-[11px] font-semibold uppercase tracking-wide text-gray-500'
  const tdCls = 'px-4 py-3 text-sm text-gray-700'

  const btnFiltro = (f: FiltroEstado) =>
    `px-3 py-1.5 rounded-lg text-sm font-semibold border transition ${
      filtro === f ? 'bg-[#004aad] text-white border-[#004aad]' : 'bg-white text-gray-600 border-gray-200 hover:bg-gray-50'
    }`

  return (
    <div className="flex flex-col gap-4">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-black text-gray-900 tracking-tight">Mis órdenes</h1>
          <p className="text-sm text-gray-500 mt-0.5">Historial y estado de todos tus envíos.</p>
        </div>
        <Link
          href="/panel/comercio/solicitar"
          className="bg-[#004aad] text-white text-sm font-semibold px-4 py-2 rounded-xl hover:bg-[#003a8c] transition"
        >
          + Nueva orden
        </Link>
      </div>

      {/* Filtros */}
      <div className="flex gap-2">
        <button onClick={() => setFiltro('todas')} className={btnFiltro('todas')}>Todas ({ordenes.length})</button>
        <button onClick={() => setFiltro('activas')} className={btnFiltro('activas')}>
          Activas ({ordenes.filter((o) => activas.includes(o.estado || '')).length})
        </button>
        <button onClick={() => setFiltro('entregadas')} className={btnFiltro('entregadas')}>
          Entregadas ({ordenes.filter((o) => o.estado === 'entregado').length})
        </button>
      </div>

      {/* Tabla */}
      <div className="overflow-x-auto rounded-xl border border-gray-200 bg-white shadow-sm">
        {loading ? (
          <div className="py-16 text-center text-sm text-gray-400">Cargando órdenes…</div>
        ) : filtered.length === 0 ? (
          <div className="flex flex-col items-center justify-center py-16 gap-2 text-gray-400">
            <Package className="h-10 w-10 opacity-30" />
            <p className="text-sm font-medium">No hay órdenes en esta categoría</p>
          </div>
        ) : (
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b bg-gray-50">
                <th className={thCls}>#</th>
                <th className={thCls}>Fecha</th>
                <th className={thCls}>Retiro</th>
                <th className={thCls}>Entrega</th>
                <th className={`${thCls} text-right`}>Delivery</th>
                <th className={thCls}>Estado</th>
                <th className={thCls}>Producto</th>
                <th className={thCls}>Delivery pago</th>
                <th className={thCls} />
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-100">
              {filtered.map((o, idx) => {
                const estadoCl = estadoCls[o.estado || ''] || 'bg-gray-100 text-gray-600 border-gray-200'
                const debe = debeDelivery(o)
                const cobrado = o.cobrosMotorizado?.producto

                return (
                  <tr key={o.id} className="hover:bg-gray-50 transition-colors">
                    <td className={`${tdCls} text-gray-400 font-mono text-xs`}>{idx + 1}</td>
                    <td className={tdCls}>{fmtDate(o.createdAt)}</td>
                    <td className={`${tdCls} max-w-[140px]`}>
                      <p className="truncate text-gray-900 font-medium">{o.recoleccion?.nombreApellido || '—'}</p>
                      <p className="truncate text-gray-400 text-xs">{o.recoleccion?.direccionEscrita || ''}</p>
                    </td>
                    <td className={`${tdCls} max-w-[140px]`}>
                      <p className="truncate text-gray-900 font-medium">{o.entrega?.nombreApellido || '—'}</p>
                      <p className="truncate text-gray-400 text-xs">{o.entrega?.direccionEscrita || ''}</p>
                    </td>
                    <td className={`${tdCls} text-right font-semibold text-[#004aad]`}>
                      {fmt(o.confirmacion?.precioFinalCordobas)}
                    </td>
                    <td className={tdCls}>
                      <span className={`inline-flex text-xs font-semibold px-2.5 py-1 rounded-full border ${estadoCl}`}>
                        {estadoLabel[o.estado || ''] || o.estado}
                      </span>
                    </td>
                    <td className={tdCls}>
                      {!o.cobroContraEntrega?.aplica ? (
                        <span className="text-gray-400 text-xs">N/A</span>
                      ) : cobrado ? (
                        <span className={`inline-flex text-xs font-semibold px-2 py-0.5 rounded-full ${cobrado.recibio ? 'bg-green-50 text-green-700' : 'bg-red-50 text-red-600'}`}>
                          {cobrado.recibio ? `✓ ${fmt(cobrado.monto)}` : '✗ No cobrado'}
                        </span>
                      ) : (
                        <span className="text-gray-400 text-xs">{fmt(o.cobroContraEntrega?.monto)}</span>
                      )}
                    </td>
                    <td className={tdCls}>
                      {debe === null ? (
                        <span className="text-gray-400 text-xs">—</span>
                      ) : debe ? (
                        <span className="inline-flex text-xs font-semibold px-2 py-0.5 rounded-full bg-red-50 text-red-600">Debe</span>
                      ) : (
                        <span className="inline-flex text-xs font-semibold px-2 py-0.5 rounded-full bg-green-50 text-green-700">Pagado</span>
                      )}
                    </td>
                    <td className="px-4 py-3 text-right">
                      <Link href={`/panel/comercio/mis-ordenes/${o.id}`}
                        className="text-[#004aad] text-xs font-semibold hover:underline">
                        Ver →
                      </Link>
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
