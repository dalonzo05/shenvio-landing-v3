'use client'

import { useEffect, useState } from 'react'
import {
  collection,
  onSnapshot,
  query,
  where,
} from 'firebase/firestore'
import { db } from '@/fb/config'
import {
  TrendingUp,
  AlertCircle,
  Clock,
  Banknote,
  Bike,
  FileSearch,
} from 'lucide-react'

// ─── Types ────────────────────────────────────────────────────────────────────

type KpiData = {
  cuentasPorCobrar: number
  cuentasPorCobrarCount: number
  pagosEnRevision: number
  pagosEnRevisionCount: number
  depositosPendientes: number
  deudaMotorizados: number
  pagoPendienteMotorizados: number
  incidencias: number
  creditoSemanal: number
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function fmt(n?: number) {
  if (typeof n !== 'number') return '—'
  return `C$ ${n.toLocaleString('es-NI')}`
}

// ─── Main ─────────────────────────────────────────────────────────────────────

export default function FinancieroDashboard() {
  const [kpis, setKpis] = useState<KpiData>({
    cuentasPorCobrar: 0,
    cuentasPorCobrarCount: 0,
    pagosEnRevision: 0,
    pagosEnRevisionCount: 0,
    depositosPendientes: 0,
    deudaMotorizados: 0,
    pagoPendienteMotorizados: 0,
    incidencias: 0,
    creditoSemanal: 0,
  })
  const [loading, setLoading] = useState(true)

  // ── KPI 1: Cuentas por cobrar (delivery pendiente de cobro) ────────────────

  useEffect(() => {
    const q = query(
      collection(db, 'solicitudes_envio'),
      where('cobroDelivery.estado', '==', 'pendiente')
    )
    return onSnapshot(q, (snap) => {
      const total = snap.docs.reduce((s, d) => s + ((d.data() as any).cobroDelivery?.monto || 0), 0)
      setKpis((prev) => ({ ...prev, cuentasPorCobrar: total, cuentasPorCobrarCount: snap.size }))
      setLoading(false)
    })
  }, [])

  // ── KPI 2: Pagos en revisión (depósitos con boucher pendiente de confirm.) ──

  useEffect(() => {
    const q = query(
      collection(db, 'ordenes_deposito'),
      where('confirmadoGestor', '==', false)
    )
    return onSnapshot(q, (snap) => {
      const docs = snap.docs.map((d) => d.data() as any)
      const enRevision = docs.filter((d) => d.estado === 'en_revision' || (!d.estado && d.boucher?.url))
      const total = enRevision.reduce((s, d) => s + (d.montoTotal || 0), 0)
      setKpis((prev) => ({ ...prev, pagosEnRevision: total, pagosEnRevisionCount: enRevision.length }))
    })
  }, [])

  // ── KPI 3: Depósitos sin boucher (motorizado aún no sube comprobante) ──────

  useEffect(() => {
    const q = query(
      collection(db, 'ordenes_deposito'),
      where('estado', '==', 'pendiente_boucher')
    )
    return onSnapshot(q, (snap) => {
      setKpis((prev) => ({ ...prev, depositosPendientes: snap.size }))
    })
  }, [])

  // ── KPI 4 & 5: Liquidaciones pendientes (deuda y pago a motorizados) ───────

  useEffect(() => {
    const q = query(
      collection(db, 'liquidaciones_motorizado'),
      where('estado', '==', 'pendiente')
    )
    return onSnapshot(q, (snap) => {
      const docs = snap.docs.map((d) => d.data() as any)
      const deuda = docs.reduce((s, d) => s + Math.max(0, d.faltantesDeposito || 0), 0)
      const pago = docs.reduce((s, d) => s + Math.max(0, d.netoAPagar || 0), 0)
      setKpis((prev) => ({ ...prev, deudaMotorizados: deuda, pagoPendienteMotorizados: pago }))
    })
  }, [])

  // ── KPI 6: Incidencias financieras (cobroPendiente) ───────────────────────

  useEffect(() => {
    const q = query(
      collection(db, 'solicitudes_envio'),
      where('cobroPendiente', '==', true)
    )
    return onSnapshot(q, (snap) => {
      setKpis((prev) => ({ ...prev, incidencias: snap.size }))
    })
  }, [])

  // ── KPI 7: Crédito semanal pendiente ──────────────────────────────────────

  useEffect(() => {
    const q = query(
      collection(db, 'cobros_semanales'),
      where('estado', 'in', ['pendiente', 'parcial'])
    )
    return onSnapshot(q, (snap) => {
      const total = snap.docs.reduce((s, d) => {
        const data = d.data() as any
        return s + Math.max(0, (data.totalMonto || 0) - (data.totalPagado || 0))
      }, 0)
      setKpis((prev) => ({ ...prev, creditoSemanal: total }))
    })
  }, [])

  // ── Render ─────────────────────────────────────────────────────────────────

  return (
    <div className="flex flex-col gap-5 max-w-4xl mx-auto">
      {/* Header */}
      <div>
        <h1 className="text-2xl font-black text-gray-900 tracking-tight flex items-center gap-2">
          <TrendingUp className="h-6 w-6 text-[#004aad]" />
          Dashboard Financiero
        </h1>
        <p className="text-sm text-gray-500 mt-0.5">
          Visión consolidada en tiempo real · Actualiza automáticamente
        </p>
      </div>

      {loading ? (
        <div className="py-20 text-center text-sm text-gray-400">Cargando datos financieros…</div>
      ) : (
        <>
          {/* KPI grid — 3 columnas */}
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">

            <KpiCard
              icon={<Banknote className="h-5 w-5" />}
              title="Cuentas por cobrar"
              value={fmt(kpis.cuentasPorCobrar)}
              sub={`${kpis.cuentasPorCobrarCount} orden${kpis.cuentasPorCobrarCount !== 1 ? 'es' : ''} pendientes`}
              color="orange"
              urgent={kpis.cuentasPorCobrar > 0}
            />

            <KpiCard
              icon={<Clock className="h-5 w-5" />}
              title="Pagos en revisión"
              value={fmt(kpis.pagosEnRevision)}
              sub={`${kpis.pagosEnRevisionCount} depósito${kpis.pagosEnRevisionCount !== 1 ? 's' : ''} con boucher adjunto`}
              color="blue"
              urgent={kpis.pagosEnRevisionCount > 0}
            />

            <KpiCard
              icon={<FileSearch className="h-5 w-5" />}
              title="Depósitos sin boucher"
              value={kpis.depositosPendientes.toString()}
              sub="Motorizado aún no sube comprobante"
              color="yellow"
              urgent={kpis.depositosPendientes > 0}
            />

            <KpiCard
              icon={<Bike className="h-5 w-5" />}
              title="Deuda motorizados"
              value={fmt(kpis.deudaMotorizados)}
              sub="Faltantes en depósitos pendientes"
              color={kpis.deudaMotorizados > 0 ? 'red' : 'green'}
              urgent={kpis.deudaMotorizados > 0}
            />

            <KpiCard
              icon={<Banknote className="h-5 w-5" />}
              title="Pagos a motorizados"
              value={fmt(kpis.pagoPendienteMotorizados)}
              sub="Liquidaciones pendientes de pago"
              color="purple"
              urgent={kpis.pagoPendienteMotorizados > 0}
            />

            <KpiCard
              icon={<AlertCircle className="h-5 w-5" />}
              title="Incidencias activas"
              value={kpis.incidencias.toString()}
              sub="Cobros con problema no resuelto"
              color={kpis.incidencias > 0 ? 'red' : 'green'}
              urgent={kpis.incidencias > 0}
            />

          </div>

          {/* Crédito semanal — ancho completo */}
          <div className="bg-white rounded-xl border border-gray-200 shadow-sm p-4 flex items-center justify-between">
            <div>
              <p className="text-sm font-bold text-gray-900">Crédito semanal pendiente</p>
              <p className="text-xs text-gray-500 mt-0.5">Cobros a clientes en modalidad crédito aún no pagados</p>
            </div>
            <div className="text-right">
              <p className="text-2xl font-black text-[#004aad]">{fmt(kpis.creditoSemanal)}</p>
            </div>
          </div>

          {/* Nota de ayuda */}
          <p className="text-xs text-gray-400 text-center">
            Todos los valores se actualizan en tiempo real. Los montos se expresan en córdobas (C$).
          </p>
        </>
      )}
    </div>
  )
}

// ─── KpiCard ──────────────────────────────────────────────────────────────────

type CardColor = 'orange' | 'blue' | 'yellow' | 'red' | 'green' | 'purple'

function KpiCard({
  icon,
  title,
  value,
  sub,
  color,
  urgent,
}: {
  icon: React.ReactNode
  title: string
  value: string
  sub: string
  color: CardColor
  urgent: boolean
}) {
  const styles: Record<CardColor, string> = {
    orange: 'border-orange-200 bg-orange-50 text-orange-700',
    blue: 'border-blue-200 bg-blue-50 text-[#004aad]',
    yellow: 'border-yellow-200 bg-yellow-50 text-yellow-700',
    red: 'border-red-200 bg-red-50 text-red-700',
    green: 'border-green-200 bg-green-50 text-green-700',
    purple: 'border-purple-200 bg-purple-50 text-purple-700',
  }
  return (
    <div className={`rounded-xl border p-4 shadow-sm transition ${styles[color]} ${urgent ? 'ring-1 ring-current/20' : ''}`}>
      <div className="flex items-center justify-between mb-3">
        <span className="opacity-70">{icon}</span>
        {urgent && (
          <span className="w-2 h-2 rounded-full bg-current opacity-70 animate-pulse" />
        )}
      </div>
      <p className="text-2xl font-black tracking-tight mb-1">{value}</p>
      <p className="text-xs font-semibold opacity-60 leading-tight">{title}</p>
      <p className="text-[11px] opacity-50 mt-0.5 leading-tight">{sub}</p>
    </div>
  )
}
