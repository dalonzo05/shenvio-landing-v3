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
import { SolicitudDrawer } from '../_components/SolicitudDrawer'

// ─── Types ────────────────────────────────────────────────────────────────────

type Solicitud = {
  id: string
  estado?: string
  createdAt?: Timestamp
  userId?: string
  ownerSnapshot?: { companyName?: string; nombre?: string }
  confirmacion?: { precioFinalCordobas?: number }
  asignacion?: { motorizadoId?: string; motorizadoNombre?: string; estadoAceptacion?: string } | null
  cobrosMotorizado?: {
    delivery?: { monto: number; recibio: boolean; at?: any; justificacion?: string }
    producto?: { monto: number; recibio: boolean; at?: any; justificacion?: string }
    resolucion?: { resueltoPor: string; at?: any; nota?: string }
  }
}

type SolicitudFull = Solicitud & {
  entrega?: { nombreApellido?: string; direccionEscrita?: string; celular?: string }
  recoleccion?: { direccionEscrita?: string }
}

type Period = 'hoy' | 'semana' | 'mes' | 'custom'

// ─── ISO Week Helpers ─────────────────────────────────────────────────────────

/** Date → 'YYYY-Www' (ISO week) */
function getSemanaKey(date: Date): string {
  const d = new Date(Date.UTC(date.getFullYear(), date.getMonth(), date.getDate()))
  d.setUTCDate(d.getUTCDate() + 4 - (d.getUTCDay() || 7))
  const yearStart = new Date(Date.UTC(d.getUTCFullYear(), 0, 1))
  const week = Math.ceil(((d.getTime() - yearStart.getTime()) / 86400000 + 1) / 7)
  return `${d.getUTCFullYear()}-W${String(week).padStart(2, '0')}`
}

/** 'YYYY-Www' → { inicio: Monday 00:00, fin: Sunday 23:59 } */
function getSemanaRange(semanaKey: string): { inicio: Date; fin: Date } {
  const [yearStr, weekStr] = semanaKey.split('-W')
  const year = parseInt(yearStr)
  const week = parseInt(weekStr)
  // Jan 4 is always in week 1
  const jan4 = new Date(year, 0, 4)
  const jan4dow = jan4.getDay() || 7
  const monday = new Date(jan4)
  monday.setDate(jan4.getDate() - jan4dow + 1 + (week - 1) * 7)
  monday.setHours(0, 0, 0, 0)
  const sunday = new Date(monday)
  sunday.setDate(monday.getDate() + 6)
  sunday.setHours(23, 59, 59, 999)
  return { inicio: monday, fin: sunday }
}

const MESES = ['ene', 'feb', 'mar', 'abr', 'may', 'jun', 'jul', 'ago', 'sep', 'oct', 'nov', 'dic']

/** 'YYYY-Www' → '30 mar – 05 abr 2026' */
function formatSemanaDisplayFull(semanaKey: string): string {
  const { inicio, fin } = getSemanaRange(semanaKey)
  const d1 = inicio.getDate()
  const m1 = MESES[inicio.getMonth()]
  const d2 = fin.getDate()
  const m2 = MESES[fin.getMonth()]
  const y = fin.getFullYear()
  if (inicio.getMonth() === fin.getMonth()) {
    return `${String(d1).padStart(2, '0')} – ${String(d2).padStart(2, '0')} ${m2} ${y}`
  }
  return `${d1} ${m1} – ${d2} ${m2} ${y}`
}

/** Date range → '23–29 mar' or '23 mar – 5 abr' (for delta badges) */
function formatPeriodLabel(start: Date, end: Date): string {
  const d1 = start.getDate()
  const m1 = MESES[start.getMonth()]
  const d2 = end.getDate()
  const m2 = MESES[end.getMonth()]
  if (start.getMonth() === end.getMonth()) {
    return `${d1}–${d2} ${m2}`
  }
  return `${d1} ${m1} – ${d2} ${m2}`
}

/** Absolute week index since 2020-W01 (for display as sequential week number) */
function getAbsoluteWeekIndex(semanaKey: string): number {
  const [yearStr, weekStr] = semanaKey.split('-W')
  const EPOCH_YEAR = 2020
  return (parseInt(yearStr) - EPOCH_YEAR) * 53 + parseInt(weekStr)
}

// ─── Period Helpers ───────────────────────────────────────────────────────────

function getPeriodDates(period: Period, customStart: string, customEnd: string): { start: Date; end: Date } {
  const now = new Date()
  if (period === 'hoy') {
    const start = new Date(now); start.setHours(0, 0, 0, 0)
    const end = new Date(now); end.setHours(23, 59, 59, 999)
    return { start, end }
  }
  if (period === 'semana') {
    // ISO week: Monday 00:00 → Sunday 23:59
    const dow = now.getDay() || 7
    const start = new Date(now); start.setDate(now.getDate() - dow + 1); start.setHours(0, 0, 0, 0)
    const end = new Date(start); end.setDate(start.getDate() + 6); end.setHours(23, 59, 59, 999)
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

function getPrevPeriodDates(period: Period, customStart: string, customEnd: string): { start: Date; end: Date } {
  if (period === 'semana') {
    // Previous ISO week: last Monday → last Sunday
    const now = new Date()
    const dow = now.getDay() || 7
    const thisMonday = new Date(now); thisMonday.setDate(now.getDate() - dow + 1); thisMonday.setHours(0, 0, 0, 0)
    const prevMonday = new Date(thisMonday); prevMonday.setDate(thisMonday.getDate() - 7)
    const prevSunday = new Date(prevMonday); prevSunday.setDate(prevMonday.getDate() + 6); prevSunday.setHours(23, 59, 59, 999)
    return { start: prevMonday, end: prevSunday }
  }
  const { start, end } = getPeriodDates(period, customStart, customEnd)
  const diff = end.getTime() - start.getTime()
  return { start: new Date(start.getTime() - diff - 1), end: new Date(start.getTime() - 1) }
}

// ─── Main ─────────────────────────────────────────────────────────────────────

export default function ReportesPage() {
  const [period, setPeriod] = useState<Period>('mes')
  const [customStart, setCustomStart] = useState('')
  const [customEnd, setCustomEnd] = useState('')

  const [solicitudes, setSolicitudes] = useState<Solicitud[]>([])
  const [prevSolicitudes, setPrevSolicitudes] = useState<Solicitud[]>([])
  const [loading, setLoading] = useState(false)
  const [comercioNames, setComercioNames] = useState<Record<string, string>>({})

  // ── Semanas state ────────────────────────────────────────────────────────
  const [semanasSolicitudes, setSemanasSolicitudes] = useState<SolicitudFull[]>([])
  const [semanasLoading, setSemanasLoading] = useState(false)
  const [expandedSemana, setExpandedSemana] = useState<string | null>(null)
  const [drawerSolicitudId, setDrawerSolicitudId] = useState<string | null>(null)

  // ── Fetch solicitudes by period ──────────────────────────────────────────
  const fetchData = useCallback(async () => {
    const { start, end } = getPeriodDates(period, customStart, customEnd)
    const { start: prevStart, end: prevEnd } = getPrevPeriodDates(period, customStart, customEnd)
    setLoading(true)
    try {
      const makeQ = (s: Date, e: Date) => query(
        collection(db, 'solicitudes_envio'),
        where('createdAt', '>=', Timestamp.fromDate(s)),
        where('createdAt', '<=', Timestamp.fromDate(e))
      )
      const [snap, prevSnap] = await Promise.all([getDocs(makeQ(start, end)), getDocs(makeQ(prevStart, prevEnd))])
      setSolicitudes(snap.docs.map((d) => ({ id: d.id, ...(d.data() as any) })))
      setPrevSolicitudes(prevSnap.docs.map((d) => ({ id: d.id, ...(d.data() as any) })))
    } finally {
      setLoading(false)
    }
  }, [period, customStart, customEnd])

  useEffect(() => {
    fetchData()
  }, [fetchData])

  // ── Fetch 16 weeks of data ───────────────────────────────────────────────
  const fetchSemanasData = useCallback(async () => {
    const now = new Date()
    const dow = now.getDay() || 7
    const thisMonday = new Date(now)
    thisMonday.setDate(now.getDate() - dow + 1)
    thisMonday.setHours(0, 0, 0, 0)
    const windowStart = new Date(thisMonday)
    windowStart.setDate(thisMonday.getDate() - 15 * 7)
    const thisSunday = new Date(thisMonday)
    thisSunday.setDate(thisMonday.getDate() + 6)
    thisSunday.setHours(23, 59, 59, 999)

    setSemanasLoading(true)
    try {
      const q = query(
        collection(db, 'solicitudes_envio'),
        where('createdAt', '>=', Timestamp.fromDate(windowStart)),
        where('createdAt', '<=', Timestamp.fromDate(thisSunday))
      )
      const snap = await getDocs(q)
      setSemanasSolicitudes(snap.docs.map((d) => ({ id: d.id, ...(d.data() as any) })))
    } finally {
      setSemanasLoading(false)
    }
  }, [])

  useEffect(() => {
    fetchSemanasData()
  }, [fetchSemanasData])

  // ── Fetch missing comercio names ─────────────────────────────────────────
  useEffect(() => {
    const allSolicitudes = [...solicitudes, ...semanasSolicitudes]
    const missing = [
      ...new Set(
        allSolicitudes
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
  }, [solicitudes, semanasSolicitudes])

  // ── Helpers ──────────────────────────────────────────────────────────────
  function calcMetrics(list: Solicitud[]) {
    const total = list.length
    const ent = list.filter((s) => s.estado === 'entregado')
    const entregadas = ent.length
    const tasa = total > 0 ? (entregadas / total) * 100 : 0
    const ingresos = ent.reduce((sum, s) => sum + (s.confirmacion?.precioFinalCordobas || 0), 0)
    return { total, entregadas, tasa, ingresos }
  }

  function delta(curr: number, prev: number): { pct: number; dir: 'up' | 'down' | 'flat' } | null {
    if (prev === 0) return null
    const pct = Math.round(((curr - prev) / prev) * 100)
    return { pct, dir: pct > 0 ? 'up' : pct < 0 ? 'down' : 'flat' }
  }

  function getNombreComercio(s: Solicitud): string {
    const uid = s.userId || ''
    return s.ownerSnapshot?.companyName || s.ownerSnapshot?.nombre || comercioNames[uid] || '—'
  }

  function fmtDate(ts?: Timestamp | null): string {
    if (!ts) return '—'
    const d = ts.toDate()
    return `${d.getDate()} ${MESES[d.getMonth()]}`
  }

  // ── Computed metrics ─────────────────────────────────────────────────────
  const { total, entregadas, tasa, ingresos } = useMemo(() => calcMetrics(solicitudes), [solicitudes])
  const prev = useMemo(() => calcMetrics(prevSolicitudes), [prevSolicitudes])

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
    const map: Record<string, { nombre: string; asignadas: number; entregadas: number; rechazadas: number; ingresos: number }> = {}
    for (const s of solicitudes) {
      if (!s.asignacion?.motorizadoId) continue
      const id = s.asignacion.motorizadoId
      const nombre = s.asignacion.motorizadoNombre || id.slice(0, 8)
      if (!map[id]) map[id] = { nombre, asignadas: 0, entregadas: 0, rechazadas: 0, ingresos: 0 }
      if (s.asignacion?.estadoAceptacion === 'rechazada') { map[id].rechazadas++; continue }
      map[id].asignadas++
      if (s.estado === 'entregado') {
        map[id].entregadas++
        map[id].ingresos += s.confirmacion?.precioFinalCordobas || 0
      }
    }
    return Object.values(map).sort((a, b) => b.entregadas - a.entregadas)
  }, [solicitudes])

  // ── Semana rows ──────────────────────────────────────────────────────────
  const semanaRows = useMemo(() => {
    const map: Record<string, { key: string; solicitudes: SolicitudFull[]; total: number; entregadas: number; ingresos: number }> = {}
    for (const s of semanasSolicitudes) {
      if (!s.createdAt) continue
      const key = getSemanaKey(s.createdAt.toDate())
      if (!map[key]) map[key] = { key, solicitudes: [], total: 0, entregadas: 0, ingresos: 0 }
      map[key].solicitudes.push(s)
      map[key].total++
      if (s.estado === 'entregado') {
        map[key].entregadas++
        map[key].ingresos += s.confirmacion?.precioFinalCordobas || 0
      }
    }
    return Object.values(map).sort((a, b) => b.key.localeCompare(a.key))
  }, [semanasSolicitudes])

  // ── Export CSV ───────────────────────────────────────────────────────────
  function exportCSV() {
    const esc = (v: any) => `"${String(v ?? '').replace(/"/g, '""')}"`
    const { start, end } = getPeriodDates(period, customStart, customEnd)
    const periodStr = `${start.toLocaleDateString('es-NI')}_${end.toLocaleDateString('es-NI')}`

    const comHeaders = ['Comercio', 'Órdenes', 'Entregadas', 'Tasa %', 'Ingresos C$']
    const comRows = comercioRows.map((r) => [r.nombre, r.ordenes, r.entregadas, r.ordenes > 0 ? ((r.entregadas / r.ordenes) * 100).toFixed(0) : 0, r.ingresos].map(esc).join(','))

    const motHeaders = ['Motorizado', 'Asignadas', 'Entregadas', 'Rechazadas', 'Tasa acept. %', 'Ingresos C$']
    const motRows = motorizadoRows.map((r) => {
      const tot = r.asignadas + r.rechazadas
      const tasa = tot > 0 ? ((r.asignadas / tot) * 100).toFixed(0) : 0
      return [r.nombre, r.asignadas, r.entregadas, r.rechazadas, tasa, r.ingresos].map(esc).join(',')
    })

    const csv = [
      '=== REPORTE POR COMERCIO ===',
      comHeaders.map(esc).join(','),
      ...comRows,
      '',
      '=== REPORTE POR MOTORIZADO ===',
      motHeaders.map(esc).join(','),
      ...motRows,
    ].join('\n')

    const blob = new Blob(['\uFEFF' + csv], { type: 'text/csv;charset=utf-8;' })
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url; a.download = `reporte-${periodStr}.csv`; a.click()
    URL.revokeObjectURL(url)
  }

  // ── Estado badge ─────────────────────────────────────────────────────────
  const estadoBadge: Record<string, string> = {
    entregado: 'bg-green-100 text-green-700',
    confirmada: 'bg-blue-100 text-blue-700',
    asignada: 'bg-indigo-100 text-indigo-700',
    en_camino_retiro: 'bg-purple-100 text-purple-700',
    retirado: 'bg-violet-100 text-violet-700',
    en_camino_entrega: 'bg-orange-100 text-orange-700',
    rechazada: 'bg-red-100 text-red-700',
    cancelada: 'bg-gray-100 text-gray-500',
  }

  // ── Styles ───────────────────────────────────────────────────────────────
  const btnPeriod = (p: Period) =>
    `px-3 py-1.5 rounded-lg text-sm font-semibold border transition ${
      period === p
        ? 'bg-[#004aad] text-white border-[#004aad]'
        : 'bg-white text-gray-600 border-gray-200 hover:bg-gray-50'
    }`

  const thCls = 'px-4 py-3 text-left text-[11px] font-semibold uppercase tracking-wide text-gray-500'
  const tdCls = 'px-4 py-3 text-sm text-gray-700'

  // ── Delta label ──────────────────────────────────────────────────────────
  const { start: prevStart, end: prevEnd } = getPrevPeriodDates(period, customStart, customEnd)
  const prevLabel = `vs ${formatPeriodLabel(prevStart, prevEnd)}`

  return (
    <div className="flex flex-col gap-4">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-black text-gray-900 tracking-tight">Reportes</h1>
          <p className="text-sm text-gray-500 mt-0.5">Métricas operativas del negocio.</p>
        </div>
        <div className="flex gap-2">
          <button
            onClick={exportCSV}
            disabled={loading || solicitudes.length === 0}
            className="text-xs font-semibold text-gray-700 border border-gray-200 px-3 py-1.5 rounded-lg hover:bg-gray-50 transition disabled:opacity-40"
          >
            ⬇ Exportar CSV
          </button>
          <button
            onClick={fetchData}
            disabled={loading}
            className="text-xs font-semibold text-[#004aad] border border-[#004aad]/30 px-3 py-1.5 rounded-lg hover:bg-[#004aad]/5 transition disabled:opacity-50"
          >
            {loading ? 'Cargando…' : '↻ Actualizar'}
          </button>
        </div>
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
      {(() => {
        const kpis = [
          { label: 'Total órdenes', curr: total, prev: prev.total, fmt: (v: number) => String(v), color: 'text-gray-900', bg: 'bg-white border-gray-200' },
          { label: 'Entregadas', curr: entregadas, prev: prev.entregadas, fmt: (v: number) => String(v), color: 'text-green-700', bg: 'bg-green-50 border-green-200' },
          { label: 'Tasa de éxito', curr: tasa, prev: prev.tasa, fmt: (v: number) => `${v.toFixed(1)}%`, color: 'text-blue-700', bg: 'bg-blue-50 border-blue-200' },
          { label: 'Ingresos delivery', curr: ingresos, prev: prev.ingresos, fmt: (v: number) => `C$ ${v.toLocaleString('es-NI', { minimumFractionDigits: 0 })}`, color: 'text-[#004aad]', bg: 'bg-[#004aad]/5 border-[#004aad]/20' },
        ]
        return (
          <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
            {kpis.map((k) => {
              const d = loading ? null : delta(k.curr, k.prev)
              return (
                <div key={k.label} className={`${k.bg} rounded-xl border px-4 py-3`}>
                  <p className={`text-2xl font-black ${k.color}`}>{loading ? '…' : k.fmt(k.curr)}</p>
                  <p className="text-xs font-semibold text-gray-500 mt-0.5">{k.label}</p>
                  {d && (
                    <p className={`text-[10px] font-semibold mt-1 ${d.dir === 'up' ? 'text-green-600' : d.dir === 'down' ? 'text-red-500' : 'text-gray-400'}`}>
                      {d.dir === 'up' ? '↑' : d.dir === 'down' ? '↓' : '='} {Math.abs(d.pct)}% {prevLabel}
                    </p>
                  )}
                </div>
              )
            })}
          </div>
        )
      })()}

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
                <th className={`${thCls} text-right`}>Rechazadas</th>
                <th className={`${thCls} text-right`}>Tasa acept.</th>
                <th className={`${thCls} text-right`}>Ingresos</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-100">
              {motorizadoRows.map((r) => {
                const tot = r.asignadas + r.rechazadas
                const tasaAcept = tot > 0 ? Math.round((r.asignadas / tot) * 100) : null
                return (
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
                    <td className={`${tdCls} text-right ${r.rechazadas > 0 ? 'text-orange-600 font-semibold' : 'text-gray-400'}`}>{r.rechazadas}</td>
                    <td className={`${tdCls} text-right font-semibold ${tasaAcept !== null && tasaAcept < 70 ? 'text-red-500' : 'text-gray-700'}`}>
                      {tasaAcept !== null ? `${tasaAcept}%` : '—'}
                    </td>
                    <td className={`${tdCls} text-right font-semibold text-[#004aad]`}>
                      {r.ingresos > 0 ? `C$ ${r.ingresos.toLocaleString('es-NI', { minimumFractionDigits: 0 })}` : '—'}
                    </td>
                  </tr>
                )
              })}
            </tbody>
          </table>
        )}
      </div>

      {/* Producción por semana */}
      <div className="rounded-xl border border-gray-200 bg-white shadow-sm overflow-hidden">
        <div className="px-4 py-3 border-b border-gray-100 flex items-center justify-between">
          <h2 className="text-sm font-black text-gray-800">Producción por semana</h2>
          <button
            onClick={fetchSemanasData}
            disabled={semanasLoading}
            className="text-xs font-semibold text-[#004aad] border border-[#004aad]/30 px-3 py-1.5 rounded-lg hover:bg-[#004aad]/5 transition disabled:opacity-50"
          >
            {semanasLoading ? 'Cargando…' : '↻ Actualizar'}
          </button>
        </div>

        {semanasLoading ? (
          <div className="py-10 text-center text-sm text-gray-400">Cargando semanas…</div>
        ) : semanaRows.length === 0 ? (
          <div className="py-10 text-center text-sm text-gray-400">Sin datos en las últimas 16 semanas</div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b bg-gray-50">
                  <th className={thCls}>#</th>
                  <th className={thCls}>Sem.</th>
                  <th className={thCls}>Rango</th>
                  <th className={`${thCls} text-right`}>Total</th>
                  <th className={`${thCls} text-right`}>Entregadas</th>
                  <th className={`${thCls} text-right`}>Tasa</th>
                  <th className={`${thCls} text-right`}>Ingresos</th>
                  <th className={thCls}></th>
                </tr>
              </thead>
              <tbody className="divide-y divide-gray-100">
                {semanaRows.map((row, i) => {
                  const isExpanded = expandedSemana === row.key
                  const tasa = row.total > 0 ? Math.round((row.entregadas / row.total) * 100) : 0
                  const semNum = getAbsoluteWeekIndex(row.key)
                  const rowNum = semanaRows.length - i
                  return (
                    <React.Fragment key={row.key}>
                      {/* Main row */}
                      <tr
                        className="hover:bg-gray-50 transition-colors cursor-pointer"
                        onClick={() => setExpandedSemana(isExpanded ? null : row.key)}
                      >
                        <td className={`${tdCls} text-gray-400 font-medium`}>{rowNum}</td>
                        <td className={`${tdCls} font-black text-gray-900`}>
                          <span className="inline-flex items-center justify-center w-8 h-8 rounded-full bg-[#004aad]/10 text-[#004aad] text-xs font-black">
                            {semNum}
                          </span>
                        </td>
                        <td className={`${tdCls} font-semibold text-gray-800`}>{formatSemanaDisplayFull(row.key)}</td>
                        <td className={`${tdCls} text-right font-semibold`}>{row.total}</td>
                        <td className={`${tdCls} text-right text-green-700 font-semibold`}>{row.entregadas}</td>
                        <td className={`${tdCls} text-right`}>
                          <span className={`font-semibold ${tasa < 80 ? 'text-orange-600' : 'text-gray-700'}`}>
                            {tasa}%
                          </span>
                        </td>
                        <td className={`${tdCls} text-right font-semibold text-[#004aad]`}>
                          {row.ingresos > 0
                            ? `C$ ${row.ingresos.toLocaleString('es-NI', { minimumFractionDigits: 0, maximumFractionDigits: 0 })}`
                            : '—'}
                        </td>
                        <td className={`${tdCls} text-gray-400`}>
                          <span className={`transition-transform inline-block ${isExpanded ? 'rotate-90' : ''}`}>▶</span>
                        </td>
                      </tr>

                      {/* Expanded sub-table */}
                      {isExpanded && (
                        <tr>
                          <td colSpan={8} className="p-0">
                            <div className="bg-gray-50 border-t border-b border-gray-100">
                              <div className="overflow-x-auto">
                                <table className="w-full text-xs">
                                  <thead>
                                    <tr className="border-b border-gray-200 bg-gray-100">
                                      <th className="px-4 py-2 text-left font-semibold uppercase tracking-wide text-gray-500 text-[10px]">ID</th>
                                      <th className="px-4 py-2 text-left font-semibold uppercase tracking-wide text-gray-500 text-[10px]">Fecha</th>
                                      <th className="px-4 py-2 text-left font-semibold uppercase tracking-wide text-gray-500 text-[10px]">Estado</th>
                                      <th className="px-4 py-2 text-left font-semibold uppercase tracking-wide text-gray-500 text-[10px]">Comercio</th>
                                      <th className="px-4 py-2 text-left font-semibold uppercase tracking-wide text-gray-500 text-[10px]">Motorizado</th>
                                      <th className="px-4 py-2 text-left font-semibold uppercase tracking-wide text-gray-500 text-[10px]">Destinatario</th>
                                      <th className="px-4 py-2 text-right font-semibold uppercase tracking-wide text-gray-500 text-[10px]">Precio</th>
                                    </tr>
                                  </thead>
                                  <tbody className="divide-y divide-gray-100">
                                    {row.solicitudes
                                      .slice()
                                      .sort((a, b) => (b.createdAt?.seconds || 0) - (a.createdAt?.seconds || 0))
                                      .map((s) => (
                                        <tr key={s.id} className="hover:bg-white transition-colors">
                                          <td className="px-4 py-2">
                                            <button
                                              onClick={(e) => { e.stopPropagation(); setDrawerSolicitudId(s.id) }}
                                              className="font-mono text-[#004aad] font-semibold hover:underline"
                                            >
                                              {s.id.slice(0, 8)}
                                            </button>
                                          </td>
                                          <td className="px-4 py-2 text-gray-600">{fmtDate(s.createdAt)}</td>
                                          <td className="px-4 py-2">
                                            <span className={`px-1.5 py-0.5 rounded text-[10px] font-semibold ${estadoBadge[s.estado || ''] || 'bg-gray-100 text-gray-500'}`}>
                                              {s.estado || '—'}
                                            </span>
                                          </td>
                                          <td className="px-4 py-2 text-gray-700 font-medium">{getNombreComercio(s)}</td>
                                          <td className="px-4 py-2 text-gray-600">{s.asignacion?.motorizadoNombre || '—'}</td>
                                          <td className="px-4 py-2 text-gray-600">{(s as SolicitudFull).entrega?.nombreApellido || '—'}</td>
                                          <td className="px-4 py-2 text-right font-semibold text-[#004aad]">
                                            {s.confirmacion?.precioFinalCordobas
                                              ? `C$ ${s.confirmacion.precioFinalCordobas}`
                                              : '—'}
                                          </td>
                                        </tr>
                                      ))}
                                  </tbody>
                                </table>
                              </div>
                            </div>
                          </td>
                        </tr>
                      )}
                    </React.Fragment>
                  )
                })}
              </tbody>
            </table>
          </div>
        )}
      </div>

      {/* Solicitud Drawer */}
      {drawerSolicitudId && (
        <SolicitudDrawer
          solicitudId={drawerSolicitudId}
          onClose={() => setDrawerSolicitudId(null)}
          comercioNames={comercioNames}
        />
      )}
    </div>
  )
}
