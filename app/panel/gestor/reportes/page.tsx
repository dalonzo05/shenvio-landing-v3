'use client'

import React, { useCallback, useEffect, useMemo, useState } from 'react'
import {
  collection,
  getDocs,
  getDoc,
  doc,
  query,
  where,
  Timestamp,
} from 'firebase/firestore'
import { db } from '@/fb/config'

// ─── Types ────────────────────────────────────────────────────────────────────

type Solicitud = {
  id: string
  estado?: string
  createdAt?: Timestamp
  userId?: string
  ownerSnapshot?: { companyName?: string; nombre?: string }
  confirmacion?: { precioFinalCordobas?: number }
  asignacion?: { motorizadoId?: string; motorizadoNombre?: string } | null
  cobrosMotorizado?: {
    delivery?: { monto: number; recibio: boolean; at?: any; justificacion?: string }
    producto?: { monto: number; recibio: boolean; at?: any; justificacion?: string }
    resolucion?: { resueltoPor: string; at?: any; nota?: string }
  }
}

type Period = 'hoy' | 'semana' | 'mes' | 'custom'

function getPeriodDates(period: Period, customStart: string, customEnd: string): { start: Date; end: Date } {
  const now = new Date()
  if (period === 'hoy') {
    const start = new Date(now); start.setHours(0, 0, 0, 0)
    const end = new Date(now); end.setHours(23, 59, 59, 999)
    return { start, end }
  }
  if (period === 'semana') {
    const start = new Date(now); start.setDate(now.getDate() - 6); start.setHours(0, 0, 0, 0)
    const end = new Date(now); end.setHours(23, 59, 59, 999)
    return { start, end }
  }
  if (period === 'mes') {
    const start = new Date(now.getFullYear(), now.getMonth(), 1)
    const end = new Date(now); end.setHours(23, 59, 59, 999)
    return { start, end }
  }
  // custom
  const start = customStart ? new Date(customStart + 'T00:00:00') : new Date(now.getFullYear(), now.getMonth(), 1)
  const end = customEnd ? new Date(customEnd + 'T23:59:59') : new Date()
  return { start, end }
}

// ─── Main ─────────────────────────────────────────────────────────────────────

export default function ReportesPage() {
  const [period, setPeriod] = useState<Period>('mes')
  const [customStart, setCustomStart] = useState('')
  const [customEnd, setCustomEnd] = useState('')

  const [solicitudes, setSolicitudes] = useState<Solicitud[]>([])
  const [loading, setLoading] = useState(false)
  const [comercioNames, setComercioNames] = useState<Record<string, string>>({})

  // ── Fetch solicitudes by period ──────────────────────────────────────────
  const fetchData = useCallback(async () => {
    const { start, end } = getPeriodDates(period, customStart, customEnd)
    setLoading(true)
    try {
      const q = query(
        collection(db, 'solicitudes_envio'),
        where('createdAt', '>=', Timestamp.fromDate(start)),
        where('createdAt', '<=', Timestamp.fromDate(end))
      )
      const snap = await getDocs(q)
      const list: Solicitud[] = snap.docs.map((d) => ({ id: d.id, ...(d.data() as any) }))
      setSolicitudes(list)
    } finally {
      setLoading(false)
    }
  }, [period, customStart, customEnd])

  useEffect(() => {
    fetchData()
  }, [fetchData])

  // ── Fetch missing comercio names ─────────────────────────────────────────
  useEffect(() => {
    const missing = [
      ...new Set(
        solicitudes
          .filter((s) => !s.ownerSnapshot?.companyName && !s.ownerSnapshot?.nombre && s.userId)
          .map((s) => s.userId!)
      ),
    ].filter((uid) => !comercioNames[uid])
    if (missing.length === 0) return
    Promise.all(missing.map((uid) => getDoc(doc(db, 'comercios', uid)))).then((snaps) => {
      const updates: Record<string, string> = {}
      snaps.forEach((snap, i) => {
        const data = snap.exists() ? (snap.data() as any) : null
        updates[missing[i]] = data?.name || data?.companyName || missing[i].slice(0, 8)
      })
      setComercioNames((prev) => ({ ...prev, ...updates }))
    })
  }, [solicitudes])

  // ── Computed metrics ─────────────────────────────────────────────────────
  const { total, entregadas, tasa, ingresos } = useMemo(() => {
    const total = solicitudes.length
    const entregadasList = solicitudes.filter((s) => s.estado === 'entregado')
    const entregadas = entregadasList.length
    const tasa = total > 0 ? ((entregadas / total) * 100).toFixed(1) : '0.0'
    const ingresos = entregadasList.reduce((sum, s) => sum + (s.confirmacion?.precioFinalCordobas || 0), 0)
    return { total, entregadas, tasa, ingresos }
  }, [solicitudes])

  // ── Per-comercio grouping ────────────────────────────────────────────────
  const comercioRows = useMemo(() => {
    const map: Record<string, { nombre: string; ordenes: number; entregadas: number; ingresos: number }> = {}
    for (const s of solicitudes) {
      const uid = s.userId || '__sin_comercio'
      const nombre =
        s.ownerSnapshot?.companyName ||
        s.ownerSnapshot?.nombre ||
        comercioNames[uid] ||
        (uid === '__sin_comercio' ? 'Sin comercio' : uid.slice(0, 8))
      if (!map[uid]) map[uid] = { nombre, ordenes: 0, entregadas: 0, ingresos: 0 }
      map[uid].ordenes++
      if (s.estado === 'entregado') {
        map[uid].entregadas++
        map[uid].ingresos += s.confirmacion?.precioFinalCordobas || 0
      }
    }
    return Object.values(map).sort((a, b) => b.ingresos - a.ingresos)
  }, [solicitudes, comercioNames])

  // ── Per-motorizado grouping ──────────────────────────────────────────────
  const motorizadoRows = useMemo(() => {
    const map: Record<string, { nombre: string; asignadas: number; entregadas: number }> = {}
    for (const s of solicitudes) {
      if (!s.asignacion?.motorizadoId) continue
      const id = s.asignacion.motorizadoId
      const nombre = s.asignacion.motorizadoNombre || id.slice(0, 8)
      if (!map[id]) map[id] = { nombre, asignadas: 0, entregadas: 0 }
      map[id].asignadas++
      if (s.estado === 'entregado') map[id].entregadas++
    }
    return Object.values(map).sort((a, b) => b.entregadas - a.entregadas)
  }, [solicitudes])

  // ── Styles ───────────────────────────────────────────────────────────────
  const btnPeriod = (p: Period) =>
    `px-3 py-1.5 rounded-lg text-sm font-semibold border transition ${
      period === p
        ? 'bg-[#004aad] text-white border-[#004aad]'
        : 'bg-white text-gray-600 border-gray-200 hover:bg-gray-50'
    }`

  const thCls = 'px-4 py-3 text-left text-[11px] font-semibold uppercase tracking-wide text-gray-500'
  const tdCls = 'px-4 py-3 text-sm text-gray-700'

  return (
    <div className="flex flex-col gap-4">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-black text-gray-900 tracking-tight">Reportes</h1>
          <p className="text-sm text-gray-500 mt-0.5">Métricas operativas del negocio.</p>
        </div>
        <button
          onClick={fetchData}
          disabled={loading}
          className="text-xs font-semibold text-[#004aad] border border-[#004aad]/30 px-3 py-1.5 rounded-lg hover:bg-[#004aad]/5 transition disabled:opacity-50"
        >
          {loading ? 'Cargando…' : '↻ Actualizar'}
        </button>
      </div>

      {/* Period selector */}
      <div className="flex flex-wrap items-center gap-2 bg-white border border-gray-200 rounded-xl px-4 py-3">
        <span className="text-xs font-bold text-gray-500 uppercase tracking-wide mr-1">Período:</span>
        {(['hoy', 'semana', 'mes'] as Period[]).map((p) => (
          <button key={p} onClick={() => setPeriod(p)} className={btnPeriod(p)}>
            {p === 'hoy' ? 'Hoy' : p === 'semana' ? 'Esta semana' : 'Este mes'}
          </button>
        ))}
        <button onClick={() => setPeriod('custom')} className={btnPeriod('custom')}>
          Personalizado
        </button>
        {period === 'custom' && (
          <div className="flex items-center gap-2 ml-2">
            <input
              type="date"
              value={customStart}
              onChange={(e) => setCustomStart(e.target.value)}
              className="border border-gray-200 rounded-lg px-2 py-1 text-sm focus:outline-none focus:ring-2 focus:ring-[#004aad]/30"
            />
            <span className="text-gray-400 text-sm">→</span>
            <input
              type="date"
              value={customEnd}
              onChange={(e) => setCustomEnd(e.target.value)}
              className="border border-gray-200 rounded-lg px-2 py-1 text-sm focus:outline-none focus:ring-2 focus:ring-[#004aad]/30"
            />
          </div>
        )}
      </div>

      {/* KPI Cards */}
      <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
        {[
          { label: 'Total órdenes', value: loading ? '…' : total, color: 'text-gray-900', bg: 'bg-white' },
          { label: 'Entregadas', value: loading ? '…' : entregadas, color: 'text-green-700', bg: 'bg-green-50' },
          { label: 'Tasa de éxito', value: loading ? '…' : `${tasa}%`, color: 'text-blue-700', bg: 'bg-blue-50' },
          { label: 'Ingresos delivery', value: loading ? '…' : `C$ ${ingresos.toLocaleString('es-NI', { minimumFractionDigits: 0, maximumFractionDigits: 0 })}`, color: 'text-[#004aad]', bg: 'bg-[#004aad]/5' },
        ].map((c) => (
          <div key={c.label} className={`${c.bg} rounded-xl border border-gray-200 px-4 py-3`}>
            <p className={`text-2xl font-black ${c.color}`}>{c.value}</p>
            <p className="text-xs font-semibold text-gray-500 mt-0.5">{c.label}</p>
          </div>
        ))}
      </div>

      {/* Por comercio */}
      <div className="overflow-x-auto rounded-xl border border-gray-200 bg-white shadow-sm">
        <div className="px-4 py-3 border-b border-gray-100">
          <h2 className="text-sm font-black text-gray-800">Por comercio</h2>
        </div>
        {loading ? (
          <div className="py-10 text-center text-sm text-gray-400">Cargando…</div>
        ) : comercioRows.length === 0 ? (
          <div className="py-10 text-center text-sm text-gray-400">Sin datos en este período</div>
        ) : (
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b bg-gray-50">
                <th className={thCls}>Comercio</th>
                <th className={`${thCls} text-right`}>Órdenes</th>
                <th className={`${thCls} text-right`}>Entregadas</th>
                <th className={`${thCls} text-right`}>Tasa</th>
                <th className={`${thCls} text-right`}>Ingresos delivery</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-100">
              {comercioRows.map((r) => (
                <tr key={r.nombre} className="hover:bg-gray-50 transition-colors">
                  <td className={`${tdCls} font-semibold text-gray-900`}>{r.nombre}</td>
                  <td className={`${tdCls} text-right`}>{r.ordenes}</td>
                  <td className={`${tdCls} text-right text-green-700 font-semibold`}>{r.entregadas}</td>
                  <td className={`${tdCls} text-right`}>
                    {r.ordenes > 0 ? `${((r.entregadas / r.ordenes) * 100).toFixed(0)}%` : '—'}
                  </td>
                  <td className={`${tdCls} text-right font-semibold text-[#004aad]`}>
                    {r.ingresos > 0 ? `C$ ${r.ingresos.toLocaleString('es-NI', { minimumFractionDigits: 0, maximumFractionDigits: 0 })}` : '—'}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>

      {/* Por motorizado */}
      <div className="overflow-x-auto rounded-xl border border-gray-200 bg-white shadow-sm">
        <div className="px-4 py-3 border-b border-gray-100">
          <h2 className="text-sm font-black text-gray-800">Por motorizado</h2>
        </div>
        {loading ? (
          <div className="py-10 text-center text-sm text-gray-400">Cargando…</div>
        ) : motorizadoRows.length === 0 ? (
          <div className="py-10 text-center text-sm text-gray-400">Sin datos en este período</div>
        ) : (
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b bg-gray-50">
                <th className={thCls}>Motorizado</th>
                <th className={`${thCls} text-right`}>Asignadas</th>
                <th className={`${thCls} text-right`}>Entregadas</th>
                <th className={`${thCls} text-right`}>Tasa</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-100">
              {motorizadoRows.map((r) => (
                <tr key={r.nombre} className="hover:bg-gray-50 transition-colors">
                  <td className={`${tdCls} font-semibold text-gray-900`}>
                    <div className="flex items-center gap-2">
                      <div className="w-7 h-7 rounded-full bg-[#004aad]/10 grid place-items-center flex-shrink-0">
                        <span className="text-xs font-black text-[#004aad]">
                          {(r.nombre || '?')[0].toUpperCase()}
                        </span>
                      </div>
                      {r.nombre}
                    </div>
                  </td>
                  <td className={`${tdCls} text-right`}>{r.asignadas}</td>
                  <td className={`${tdCls} text-right text-green-700 font-semibold`}>{r.entregadas}</td>
                  <td className={`${tdCls} text-right`}>
                    {r.asignadas > 0 ? `${((r.entregadas / r.asignadas) * 100).toFixed(0)}%` : '—'}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </div>
  )
}
