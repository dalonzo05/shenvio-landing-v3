'use client'

import { useEffect, useMemo, useState } from 'react'
import {
  collection,
  onSnapshot,
  query,
  where,
  doc,
  updateDoc,
  serverTimestamp,
  Timestamp,
} from 'firebase/firestore'
import { auth, db } from '@/fb/config'
import { AlertCircle, CheckCircle2, X } from 'lucide-react'

// ─── Types ────────────────────────────────────────────────────────────────────

type CobroItem = {
  monto: number
  recibio: boolean
  at?: Timestamp
  justificacion?: string
}

type Resolucion = {
  resueltoPor: string
  at: Timestamp
  nota?: string
}

type Solicitud = {
  id: string
  createdAt?: Timestamp
  cobroPendiente?: boolean
  ownerSnapshot?: { companyName?: string; nombre?: string }
  userId?: string
  asignacion?: { motorizadoNombre?: string; motorizadoId?: string } | null
  cobrosMotorizado?: {
    delivery?: CobroItem
    producto?: CobroItem
    resolucion?: Resolucion
  }
}

type Tab = 'pendientes' | 'resueltos'

// ─── Helpers ─────────────────────────────────────────────────────────────────

function fmt(n?: number) {
  if (typeof n !== 'number') return '—'
  return `C$ ${n.toLocaleString('es-NI')}`
}

function fmtDate(v: any) {
  if (!v) return '—'
  const d = typeof v?.toDate === 'function' ? v.toDate() : v instanceof Date ? v : null
  if (!d) return '—'
  return d.toLocaleDateString('es-NI', { day: '2-digit', month: 'short', year: 'numeric' })
}

function getTipoCobro(s: Solicitud): string {
  const d = s.cobrosMotorizado?.delivery
  const p = s.cobrosMotorizado?.producto
  const parts: string[] = []
  if (d && !d.recibio) parts.push('Delivery')
  if (p && !p.recibio) parts.push('Producto')
  return parts.join(' + ') || '—'
}

function getMontoPendiente(s: Solicitud): number {
  let total = 0
  const d = s.cobrosMotorizado?.delivery
  const p = s.cobrosMotorizado?.producto
  if (d && !d.recibio) total += d.monto
  if (p && !p.recibio) total += p.monto
  return total
}

function getJustificaciones(s: Solicitud): string[] {
  const out: string[] = []
  const d = s.cobrosMotorizado?.delivery
  const p = s.cobrosMotorizado?.producto
  if (d && !d.recibio && d.justificacion) out.push(`Delivery: ${d.justificacion}`)
  if (p && !p.recibio && p.justificacion) out.push(`Producto: ${p.justificacion}`)
  return out
}

// ─── Resolve Modal (inline) ──────────────────────────────────────────────────

function ResolveModal({ orderId, onClose }: { orderId: string; onClose: () => void }) {
  const [nota, setNota] = useState('')
  const [saving, setSaving] = useState(false)
  const [err, setErr] = useState<string | null>(null)

  async function handleResolver() {
    setSaving(true); setErr(null)
    try {
      const uid = auth.currentUser?.uid || 'desconocido'
      await updateDoc(doc(db, 'solicitudes_envio', orderId), {
        cobroPendiente: false,
        'cobrosMotorizado.resolucion': {
          resueltoPor: uid,
          at: serverTimestamp(),
          nota: nota.trim() || null,
        },
      })
      onClose()
    } catch (e: any) {
      setErr(e?.message || 'Error al guardar')
    } finally {
      setSaving(false)
    }
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 backdrop-blur-sm px-4">
      <div className="bg-white rounded-2xl shadow-2xl w-full max-w-sm p-5">
        <div className="flex items-center justify-between mb-4">
          <h3 className="text-base font-black text-gray-900">Marcar como resuelto</h3>
          <button onClick={onClose} className="w-8 h-8 grid place-items-center rounded-full border border-gray-200 hover:bg-gray-50">
            <X className="h-4 w-4 text-gray-500" />
          </button>
        </div>
        <p className="text-sm text-gray-500 mb-3">Agrega una nota opcional sobre cómo se resolvió el cobro.</p>
        <textarea
          value={nota}
          onChange={(e) => setNota(e.target.value)}
          placeholder="Ej: El comercio pagará en la liquidación semanal…"
          className="w-full border border-gray-200 rounded-xl px-3 py-2.5 text-sm resize-none h-24 focus:outline-none focus:ring-2 focus:ring-[#004aad]/30 focus:border-[#004aad]"
        />
        {err && <p className="text-xs text-red-600 mt-1">{err}</p>}
        <div className="flex gap-2 mt-4">
          <button onClick={onClose} className="flex-1 border border-gray-200 text-gray-600 text-sm font-semibold py-2.5 rounded-xl hover:bg-gray-50 transition">
            Cancelar
          </button>
          <button
            onClick={handleResolver}
            disabled={saving}
            className="flex-1 bg-green-600 text-white text-sm font-semibold py-2.5 rounded-xl hover:bg-green-700 transition disabled:opacity-50"
          >
            {saving ? 'Guardando…' : '✓ Confirmar resolución'}
          </button>
        </div>
      </div>
    </div>
  )
}

// ─── Main ─────────────────────────────────────────────────────────────────────

export default function CobrosPage() {
  const [solicitudes, setSolicitudes] = useState<Solicitud[]>([])
  const [loading, setLoading] = useState(true)
  const [tab, setTab] = useState<Tab>('pendientes')
  const [resolvingId, setResolvingId] = useState<string | null>(null)

  // Query orders that ever had a pending cobro (cobroPendiente=true covers active ones;
  // resolved ones have cobroPendiente=false but resolucion set — we fetch all and filter client-side)
  useEffect(() => {
    // We use two queries and merge: pending=true + recently resolved (last 30 days)
    // Simpler: just listen to all with cobrosMotorizado having recibio:false — not directly queryable.
    // Best approach: fetch cobroPendiente==true for pending tab,
    // and cobroPendiente==false with resolucion for resolved tab.
    // We do both with onSnapshot and merge.
    const qPending = query(
      collection(db, 'solicitudes_envio'),
      where('cobroPendiente', '==', true)
    )
    const qResolved = query(
      collection(db, 'solicitudes_envio'),
      where('cobroPendiente', '==', false)
    )

    const map = new Map<string, Solicitud>()

    const unsubPending = onSnapshot(qPending, (snap) => {
      snap.docs.forEach((d) => map.set(d.id, { id: d.id, ...(d.data() as any) }))
      setSolicitudes([...map.values()])
      setLoading(false)
    })

    const unsubResolved = onSnapshot(qResolved, (snap) => {
      snap.docs.forEach((d) => {
        const data = d.data() as any
        // Only keep resolved ones that actually have a resolucion record
        if (data?.cobrosMotorizado?.resolucion) {
          map.set(d.id, { id: d.id, ...data })
        }
      })
      setSolicitudes([...map.values()])
      setLoading(false)
    })

    return () => { unsubPending(); unsubResolved() }
  }, [])

  const pendientes = useMemo(() =>
    solicitudes
      .filter((s) => s.cobroPendiente === true)
      .sort((a, b) => (b.createdAt?.toMillis?.() || 0) - (a.createdAt?.toMillis?.() || 0)),
    [solicitudes]
  )

  const resueltos = useMemo(() =>
    solicitudes
      .filter((s) => s.cobroPendiente === false && s.cobrosMotorizado?.resolucion)
      .sort((a, b) => (b.cobrosMotorizado?.resolucion?.at?.toMillis?.() || 0) - (a.cobrosMotorizado?.resolucion?.at?.toMillis?.() || 0)),
    [solicitudes]
  )

  const rows = tab === 'pendientes' ? pendientes : resueltos

  const thCls = 'px-4 py-3 text-left text-[11px] font-semibold uppercase tracking-wide text-gray-500'
  const tdCls = 'px-4 py-3 text-sm text-gray-700'

  const btnTab = (t: Tab) =>
    `px-4 py-2 rounded-lg text-sm font-semibold border transition ${
      tab === t ? 'bg-[#004aad] text-white border-[#004aad]' : 'bg-white text-gray-600 border-gray-200 hover:bg-gray-50'
    }`

  return (
    <div className="flex flex-col gap-4">
      {resolvingId && (
        <ResolveModal orderId={resolvingId} onClose={() => setResolvingId(null)} />
      )}

      {/* Header */}
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-black text-gray-900 tracking-tight flex items-center gap-2">
            <AlertCircle className="h-6 w-6 text-orange-500" />
            Cobros pendientes
          </h1>
          <p className="text-sm text-gray-500 mt-0.5">
            Órdenes donde el motorizado reportó no haber recibido un cobro.
          </p>
        </div>
      </div>

      {/* KPI row */}
      <div className="grid grid-cols-2 gap-3">
        <div className="bg-red-50 border border-red-200 rounded-xl px-4 py-3">
          <p className="text-2xl font-black text-red-600">{loading ? '…' : pendientes.length}</p>
          <p className="text-xs font-semibold text-red-400 mt-0.5">Pendientes de resolución</p>
        </div>
        <div className="bg-green-50 border border-green-200 rounded-xl px-4 py-3">
          <p className="text-2xl font-black text-green-700">{loading ? '…' : resueltos.length}</p>
          <p className="text-xs font-semibold text-green-500 mt-0.5">Resueltos</p>
        </div>
      </div>

      {/* Tabs */}
      <div className="flex gap-2">
        <button onClick={() => setTab('pendientes')} className={btnTab('pendientes')}>
          Pendientes {!loading && pendientes.length > 0 && (
            <span className="ml-1.5 inline-flex items-center justify-center w-5 h-5 rounded-full bg-red-500 text-white text-[10px] font-black">
              {pendientes.length}
            </span>
          )}
        </button>
        <button onClick={() => setTab('resueltos')} className={btnTab('resueltos')}>
          Resueltos
        </button>
      </div>

      {/* Table */}
      <div className="overflow-x-auto rounded-xl border border-gray-200 bg-white shadow-sm">
        {loading ? (
          <div className="py-16 text-center text-sm text-gray-400">Cargando…</div>
        ) : rows.length === 0 ? (
          <div className="flex flex-col items-center justify-center py-16 gap-2 text-gray-400">
            <CheckCircle2 className="h-10 w-10 opacity-30" />
            <p className="text-sm font-medium">
              {tab === 'pendientes' ? 'Sin cobros pendientes' : 'No hay casos resueltos aún'}
            </p>
          </div>
        ) : (
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b bg-gray-50">
                <th className={thCls}>Fecha</th>
                <th className={thCls}>Orden</th>
                <th className={thCls}>Comercio</th>
                <th className={thCls}>Motorizado</th>
                <th className={thCls}>Tipo</th>
                <th className={`${thCls} text-right`}>Monto</th>
                <th className={thCls}>Justificación</th>
                {tab === 'pendientes' && <th className={thCls}>Acción</th>}
                {tab === 'resueltos' && <th className={thCls}>Resolución</th>}
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-100">
              {rows.map((s) => {
                const comercio = s.ownerSnapshot?.companyName || s.ownerSnapshot?.nombre || s.userId?.slice(0, 8) || '—'
                const motorizado = s.asignacion?.motorizadoNombre || s.asignacion?.motorizadoId?.slice(0, 8) || '—'
                const tipo = getTipoCobro(s)
                const monto = getMontoPendiente(s)
                const justs = getJustificaciones(s)
                return (
                  <tr key={s.id} className="hover:bg-gray-50 transition-colors">
                    <td className={tdCls}>{fmtDate(s.createdAt)}</td>
                    <td className={`${tdCls} font-mono text-xs text-gray-400`}>{s.id.slice(0, 8)}</td>
                    <td className={`${tdCls} font-semibold text-gray-900`}>{comercio}</td>
                    <td className={tdCls}>
                      <div className="flex items-center gap-2">
                        <div className="w-6 h-6 rounded-full bg-[#004aad]/10 grid place-items-center flex-shrink-0">
                          <span className="text-[10px] font-black text-[#004aad]">
                            {(motorizado || '?')[0].toUpperCase()}
                          </span>
                        </div>
                        {motorizado}
                      </div>
                    </td>
                    <td className={tdCls}>
                      <span className="inline-flex text-xs font-semibold px-2 py-0.5 rounded-full bg-orange-50 text-orange-700 border border-orange-200">
                        {tipo}
                      </span>
                    </td>
                    <td className={`${tdCls} text-right font-semibold text-red-600`}>
                      {monto > 0 ? fmt(monto) : '—'}
                    </td>
                    <td className={`${tdCls} max-w-[200px]`}>
                      {justs.length === 0 ? (
                        <span className="text-gray-400 text-xs">Sin justificación</span>
                      ) : (
                        <ul className="space-y-0.5">
                          {justs.map((j, i) => (
                            <li key={i} className="text-xs text-gray-600 truncate" title={j}>{j}</li>
                          ))}
                        </ul>
                      )}
                    </td>
                    {tab === 'pendientes' && (
                      <td className="px-4 py-3">
                        <button
                          onClick={() => setResolvingId(s.id)}
                          className="text-xs font-semibold px-3 py-1.5 rounded-lg bg-green-50 text-green-700 border border-green-200 hover:bg-green-100 transition"
                        >
                          Marcar resuelto
                        </button>
                      </td>
                    )}
                    {tab === 'resueltos' && (
                      <td className={`${tdCls} max-w-[160px]`}>
                        <p className="text-xs text-green-700 font-semibold">✓ Resuelto</p>
                        <p className="text-xs text-gray-400 truncate">{fmtDate(s.cobrosMotorizado?.resolucion?.at)}</p>
                        {s.cobrosMotorizado?.resolucion?.nota && (
                          <p className="text-xs text-gray-500 truncate" title={s.cobrosMotorizado.resolucion.nota}>
                            {s.cobrosMotorizado.resolucion.nota}
                          </p>
                        )}
                      </td>
                    )}
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
