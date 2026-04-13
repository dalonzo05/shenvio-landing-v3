'use client'

import { useEffect, useMemo, useState } from 'react'
import { collection, doc, getDoc, onSnapshot, query, Timestamp, where } from 'firebase/firestore'
import { auth, db } from '@/fb/config'
import { Wallet, FileImage, ChevronDown, ChevronUp, CheckCircle2, Clock, Search, Lock } from 'lucide-react'
import { SolicitudDrawer } from '@/app/panel/gestor/_components/SolicitudDrawer'

// ─── Types ────────────────────────────────────────────────────────────────────

type DepositoDoc = {
  id: string
  creadoAt?: Timestamp
  motorizadoNombre: string
  solicitudIds: string[]
  montoTotal: number
  boucher?: { url: string; pathStorage?: string } | null
  confirmadoGestor?: boolean
}

type SolicitudDetalle = {
  fecha?: any
  retiro?: string
  entrega?: string
  entregaNombre?: string
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

function tsToDate(v: any): Date | null {
  if (!v) return null
  if (typeof v?.toDate === 'function') return v.toDate()
  if (v instanceof Date) return v
  return null
}

function fmt(n: number) {
  return `C$ ${n.toLocaleString('es-NI')}`
}

function fmtFecha(v: any): string {
  const d = tsToDate(v)
  if (!d) return '—'
  return d.toLocaleDateString('es-NI', { day: 'numeric', month: 'short', year: 'numeric' })
}

function fmtFechaCorta(v: any): string {
  const d = tsToDate(v)
  if (!d) return '—'
  return d.toLocaleDateString('es-NI', { day: 'numeric', month: 'short' })
}

function monthLabel(key: string): string {
  if (key === 'sin-fecha') return 'Sin fecha'
  const [y, m] = key.split('-')
  const d = new Date(Number(y), Number(m) - 1, 1)
  const label = d.toLocaleDateString('es-NI', { month: 'long', year: 'numeric' })
  return label.charAt(0).toUpperCase() + label.slice(1)
}

function monthKey(v: any): string {
  const d = tsToDate(v)
  if (!d) return 'sin-fecha'
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`
}

/** Muestra solo la parte antes del @ si parece un email, o el nombre completo si no */
function fmtMotorizadoNombre(raw: string): string {
  if (!raw) return '—'
  if (raw.includes('@')) return raw.split('@')[0]
  return raw
}

type DepStatus = 'confirmado' | 'en_revision' | 'pendiente'

function getStatus(dep: DepositoDoc): DepStatus {
  if (dep.confirmadoGestor === true) return 'confirmado'
  if (dep.boucher?.url) return 'en_revision'
  return 'pendiente'
}

const STATUS_CONFIG: Record<DepStatus, { label: string; bg: string; text: string; border: string; accent: string; icon: React.ReactNode }> = {
  confirmado: {
    label: 'Confirmado',
    bg: '#f0fdf4', text: '#16a34a', border: '#bbf7d0', accent: '#16a34a',
    icon: <CheckCircle2 size={13} />,
  },
  en_revision: {
    label: 'En revisión',
    bg: '#eff6ff', text: '#2563eb', border: '#bfdbfe', accent: '#2563eb',
    icon: <Search size={13} />,
  },
  pendiente: {
    label: 'Pendiente',
    bg: '#fffbeb', text: '#d97706', border: '#fde68a', accent: '#d97706',
    icon: <Clock size={13} />,
  },
}

// ─── Component ───────────────────────────────────────────────────────────────

export default function DepositosPage() {
  const [depositos, setDepositos] = useState<DepositoDoc[]>([])
  const [loading, setLoading] = useState(true)
  const [expandedId, setExpandedId] = useState<string | null>(null)
  const [boucherModal, setBoucherModal] = useState<string | null>(null)
  const [drawerOrdenId, setDrawerOrdenId] = useState<string | null>(null)
  const [filtroMes, setFiltroMes] = useState<string>('todos')
  const [solicitudesDetalle, setSolicitudesDetalle] = useState<Record<string, SolicitudDetalle>>({})

  useEffect(() => {
    const user = auth.currentUser
    if (!user) return
    const q = query(
      collection(db, 'ordenes_deposito'),
      where('destinatario', '==', 'comercio'),
      where('destinatarioId', '==', user.uid),
    )
    const unsub = onSnapshot(q, (snap) => {
      const list: DepositoDoc[] = snap.docs
        .map((d) => ({ id: d.id, ...(d.data() as any) }))
        .sort((a, b) => (tsToDate(b.creadoAt)?.getTime() ?? 0) - (tsToDate(a.creadoAt)?.getTime() ?? 0))
      setDepositos(list)
      setLoading(false)
    }, (err) => {
      console.error('[depositos] onSnapshot error:', err)
      setLoading(false)
    })
    return () => unsub()
  }, [])

  // Lazy-load solicitud details when a card is expanded
  useEffect(() => {
    if (!expandedId) return
    const dep = depositos.find((d) => d.id === expandedId)
    if (!dep) return
    const missing = dep.solicitudIds.filter((sid) => !solicitudesDetalle[sid])
    if (missing.length === 0) return
    Promise.all(missing.map((sid) => getDoc(doc(db, 'solicitudes_envio', sid)))).then((snaps) => {
      const updates: Record<string, SolicitudDetalle> = {}
      snaps.forEach((snap, i) => {
        if (snap.exists()) {
          const data = snap.data() as any
          updates[missing[i]] = {
            fecha: data.entregadoAt || data.createdAt,
            retiro: data.recoleccion?.direccionEscrita || data.recoleccion?.nombreApellido,
            entrega: data.entrega?.direccionEscrita,
            entregaNombre: data.entrega?.nombreApellido,
          }
        }
      })
      setSolicitudesDetalle((prev) => ({ ...prev, ...updates }))
    }).catch((err) => {
      console.error('[depositos] solicitudes getDoc error:', err)
    })
  }, [expandedId, depositos])

  // Build month keys for filter chips
  const mesesDisponibles = useMemo(() => {
    const keys = new Set<string>()
    depositos.forEach((d) => keys.add(monthKey(d.creadoAt)))
    return [...keys].sort((a, b) => b.localeCompare(a))
  }, [depositos])

  const byMonth = useMemo(() => {
    const filtered = filtroMes === 'todos' ? depositos : depositos.filter((d) => monthKey(d.creadoAt) === filtroMes)
    const map = new Map<string, DepositoDoc[]>()
    filtered.forEach((d) => {
      const key = monthKey(d.creadoAt)
      map.set(key, [...(map.get(key) ?? []), d])
    })
    return [...map.entries()].sort((a, b) => b[0].localeCompare(a[0]))
  }, [depositos, filtroMes])

  // Summary stats
  const totalConfirmado = depositos.filter((d) => d.confirmadoGestor).reduce((s, d) => s + (d.montoTotal ?? 0), 0)
  const totalEnRevision = depositos.filter((d) => !d.confirmadoGestor && d.boucher?.url).reduce((s, d) => s + (d.montoTotal ?? 0), 0)
  const countEnRevision = depositos.filter((d) => !d.confirmadoGestor && d.boucher?.url).length

  return (
    <div className="flex flex-col gap-6">
      {/* Header */}
      <div>
        <h1 className="text-2xl font-black tracking-tight text-gray-900">Depósitos</h1>
        <p className="mt-0.5 text-sm text-gray-500">
          Registro de los cobros que el motorizado te depositó.
        </p>
      </div>

      {/* Summary cards */}
      {!loading && depositos.length > 0 && (
        <div className="grid grid-cols-2 gap-3">
          <div className="rounded-xl border border-green-200 bg-green-50 p-4">
            <p className="text-xs font-semibold uppercase tracking-wide text-green-600">Confirmado</p>
            <p className="mt-1 text-xl font-black text-green-700">{fmt(totalConfirmado)}</p>
            <p className="text-xs text-green-600">
              {depositos.filter((d) => d.confirmadoGestor).length} depósito{depositos.filter((d) => d.confirmadoGestor).length !== 1 ? 's' : ''}
            </p>
          </div>
          <div className="rounded-xl border border-blue-200 bg-blue-50 p-4">
            <p className="text-xs font-semibold uppercase tracking-wide text-blue-600">En revisión</p>
            <p className="mt-1 text-xl font-black text-blue-700">{fmt(totalEnRevision)}</p>
            <p className="text-xs text-blue-600">{countEnRevision} depósito{countEnRevision !== 1 ? 's' : ''} por verificar</p>
          </div>
        </div>
      )}

      {/* Hint sobre "En revisión" */}
      {!loading && depositos.some((d) => !d.confirmadoGestor && d.boucher?.url) && (
        <div className="flex gap-2 rounded-xl border border-blue-200 bg-blue-50 px-4 py-3">
          <Search size={16} className="mt-0.5 shrink-0 text-blue-500" />
          <p className="text-sm text-blue-700">
            <span className="font-semibold">En revisión:</span> el motorizado ya realizó el depósito y subió el comprobante. El gestor está verificando el pago.
          </p>
        </div>
      )}

      {/* Filtro de mes */}
      {!loading && mesesDisponibles.length > 1 && (
        <div className="flex flex-wrap gap-2">
          <button
            onClick={() => setFiltroMes('todos')}
            className={`rounded-full border px-3 py-1 text-xs font-semibold transition ${filtroMes === 'todos' ? 'bg-gray-900 text-white border-gray-900' : 'bg-white text-gray-600 border-gray-200 hover:bg-gray-50'}`}
          >
            Todos
          </button>
          {mesesDisponibles.map((mk) => (
            <button
              key={mk}
              onClick={() => setFiltroMes(mk)}
              className={`rounded-full border px-3 py-1 text-xs font-semibold transition ${filtroMes === mk ? 'bg-[#004aad] text-white border-[#004aad]' : 'bg-white text-gray-600 border-gray-200 hover:bg-gray-50'}`}
            >
              {monthLabel(mk)}
            </button>
          ))}
        </div>
      )}

      {/* Loading */}
      {loading && (
        <div className="rounded-xl border border-gray-200 bg-white py-16 text-center text-sm text-gray-400 shadow-sm">
          Cargando depósitos…
        </div>
      )}

      {/* Empty */}
      {!loading && depositos.length === 0 && (
        <div className="flex flex-col items-center justify-center gap-2 rounded-xl border border-gray-200 bg-white py-16 shadow-sm">
          <Wallet className="h-10 w-10 opacity-20 text-gray-400" />
          <p className="text-sm font-medium text-gray-600">Aún no tenés depósitos registrados</p>
          <p className="text-xs text-gray-400">
            Los depósitos aparecerán aquí cuando el motorizado los confirme.
          </p>
        </div>
      )}

      {/* Months */}
      {!loading &&
        byMonth.map(([mk, items]) => {
          const subtotal = items.reduce((s, d) => s + (d.montoTotal ?? 0), 0)
          return (
            <div key={mk} className="flex flex-col gap-3">
              {/* Month header */}
              <div className="flex items-center justify-between px-1">
                <h2 className="text-xs font-black uppercase tracking-wider text-gray-400">
                  {monthLabel(mk)}
                </h2>
                <span className="text-xs font-bold text-gray-400">{fmt(subtotal)}</span>
              </div>

              {/* Cards */}
              {items.map((dep) => {
                const isExpanded = expandedId === dep.id
                const status = getStatus(dep)
                const cfg = STATUS_CONFIG[status]
                const orderCount = dep.solicitudIds?.length ?? 0

                return (
                  <div
                    key={dep.id}
                    className="overflow-hidden rounded-xl border bg-white shadow-sm transition-shadow hover:shadow-md"
                    style={{ borderColor: cfg.border, borderLeftWidth: 4, borderLeftColor: cfg.accent }}
                  >
                    <div className="px-4 pt-4 pb-3">
                      {/* Top row: fecha + status badge */}
                      <div className="mb-3 flex items-center justify-between">
                        <span className="text-xs font-medium text-gray-400">{fmtFecha(dep.creadoAt)}</span>
                        <span
                          className="inline-flex items-center gap-1 rounded-full px-2.5 py-1 text-xs font-semibold"
                          style={{ background: cfg.bg, color: cfg.text, border: `1px solid ${cfg.border}` }}
                        >
                          {cfg.icon}
                          {cfg.label}
                        </span>
                      </div>

                      {/* Amount */}
                      <p className="text-2xl font-black tracking-tight" style={{ color: '#004aad' }}>
                        {fmt(dep.montoTotal ?? 0)}
                      </p>

                      {/* Motorizado */}
                      <p className="mt-0.5 text-sm text-gray-600">
                        <span className="font-medium text-gray-400">Motorizado: </span>
                        {fmtMotorizadoNombre(dep.motorizadoNombre)}
                      </p>

                      {/* Bottom row: orders + boucher */}
                      <div className="mt-3 flex items-center gap-2">
                        {/* Orders expand button */}
                        <button
                          onClick={() => setExpandedId(isExpanded ? null : dep.id)}
                          className="flex flex-1 items-center justify-center gap-1.5 rounded-lg border border-gray-200 bg-gray-50 py-2 text-xs font-semibold text-gray-600 transition hover:bg-gray-100"
                        >
                          {isExpanded ? <ChevronUp size={14} /> : <ChevronDown size={14} />}
                          {orderCount} {orderCount === 1 ? 'orden' : 'órdenes'}
                        </button>

                        {/* Boucher: only visible if confirmed by gestor */}
                        {status === 'confirmado' && dep.boucher?.url ? (
                          <button
                            onClick={() => setBoucherModal(dep.boucher!.url)}
                            className="flex flex-1 items-center justify-center gap-1.5 rounded-lg border py-2 text-xs font-semibold transition"
                            style={{ borderColor: cfg.border, background: cfg.bg, color: cfg.text }}
                          >
                            <FileImage size={14} />
                            Ver comprobante
                          </button>
                        ) : status === 'en_revision' ? (
                          <div
                            className="flex flex-1 items-center justify-center gap-1.5 rounded-lg border border-dashed py-2 text-xs"
                            style={{ borderColor: '#bfdbfe', color: '#93c5fd' }}
                          >
                            <Lock size={13} />
                            Comprobante en revisión
                          </div>
                        ) : (
                          <div className="flex flex-1 items-center justify-center gap-1.5 rounded-lg border border-dashed border-gray-200 py-2 text-xs text-gray-300">
                            <FileImage size={14} />
                            Sin comprobante
                          </div>
                        )}
                      </div>
                    </div>

                    {/* Expanded: order details */}
                    {isExpanded && orderCount > 0 && (
                      <div className="border-t border-gray-100 bg-gray-50 px-4 py-3">
                        <p className="mb-2 text-xs font-semibold uppercase tracking-wide text-gray-400">
                          Órdenes incluidas
                        </p>
                        <div className="flex flex-col gap-2">
                          {dep.solicitudIds.map((sid) => {
                            const det = solicitudesDetalle[sid]
                            return (
                              <div
                                key={sid}
                                className="flex items-center justify-between rounded-lg border border-gray-200 bg-white px-3 py-2.5"
                              >
                                <div className="min-w-0 flex-1">
                                  {det ? (
                                    <>
                                      <p className="text-xs font-semibold text-gray-700">
                                        {fmtFechaCorta(det.fecha)}
                                        {det.entregaNombre && <span className="ml-1 font-normal text-gray-500">· {det.entregaNombre}</span>}
                                      </p>
                                      {det.retiro && (
                                        <p className="mt-0.5 truncate text-[11px] text-gray-400">
                                          {det.retiro}
                                          {det.entrega && <> → {det.entrega}</>}
                                        </p>
                                      )}
                                    </>
                                  ) : (
                                    <p className="font-mono text-xs text-gray-400">#{sid.slice(0, 12)}…</p>
                                  )}
                                </div>
                                <button
                                  onClick={() => setDrawerOrdenId(sid)}
                                  className="ml-3 shrink-0 text-xs font-semibold text-[#004aad] hover:underline"
                                >
                                  Ver →
                                </button>
                              </div>
                            )
                          })}
                        </div>
                      </div>
                    )}
                  </div>
                )
              })}
            </div>
          )
        })}

      {/* Boucher lightbox */}
      {boucherModal && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 p-4"
          onClick={() => setBoucherModal(null)}
        >
          <div className="relative" onClick={(e) => e.stopPropagation()}>
            <img
              src={boucherModal}
              alt="Comprobante de depósito"
              className="max-h-[85vh] max-w-full rounded-xl object-contain shadow-2xl"
            />
            <button
              onClick={() => setBoucherModal(null)}
              className="absolute -right-3 -top-3 flex h-8 w-8 items-center justify-center rounded-full bg-white shadow text-gray-700 hover:bg-gray-100 transition"
            >
              ✕
            </button>
          </div>
        </div>
      )}

      {/* Order drawer */}
      {drawerOrdenId && (
        <SolicitudDrawer
          solicitudId={drawerOrdenId}
          onClose={() => setDrawerOrdenId(null)}
        />
      )}
    </div>
  )
}
