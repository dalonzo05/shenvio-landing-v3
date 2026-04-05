'use client'

import React, { useEffect, useState } from 'react'
import {
  collection,
  onSnapshot,
  doc,
  addDoc,
  updateDoc,
  query,
  where,
  orderBy,
  limit,
  getCountFromServer,
  getDocs,
  serverTimestamp,
  Timestamp,
} from 'firebase/firestore'
import { db } from '@/fb/config'
import { X, Bike, Plus, TrendingUp, AlertCircle } from 'lucide-react'

// ─── Types ────────────────────────────────────────────────────────────────────

type EstadoMoto = 'disponible' | 'ocupado'

type Motorizado = {
  id: string
  nombre: string
  telefono?: string
  estado?: EstadoMoto
  activo?: boolean
  authUid?: string
  createdAt?: any
}

type Stats = {
  total: number
  hoy: number
  semana: number
  tasaAceptacion: number | null  // 0-100, null si sin datos
  rechazos: number
  ultimosRechazos: { id: string; fecha?: Timestamp }[]
  depositosPendientes: number
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

const estadoConfig = {
  disponible: { label: 'Disponible', cls: 'bg-green-50 text-green-700 border-green-200' },
  ocupado:    { label: 'Ocupado',    cls: 'bg-yellow-50 text-yellow-700 border-yellow-200' },
}

async function fetchStats(motorizadoId: string): Promise<Stats> {
  const col = collection(db, 'solicitudes_envio')
  const hoyStart = new Date(); hoyStart.setHours(0, 0, 0, 0)
  const semanaStart = new Date(); semanaStart.setDate(semanaStart.getDate() - semanaStart.getDay() + (semanaStart.getDay() === 0 ? -6 : 1)); semanaStart.setHours(0, 0, 0, 0)

  const [totalSnap, hoySnap, semanaSnap, aceptadasSnap, rechazadasSnap, depositosSnap] = await Promise.all([
    getCountFromServer(query(col, where('asignacion.motorizadoId', '==', motorizadoId), where('estado', '==', 'entregado'))),
    getCountFromServer(query(col, where('asignacion.motorizadoId', '==', motorizadoId), where('estado', '==', 'entregado'), where('entregadoAt', '>=', hoyStart))),
    getCountFromServer(query(col, where('asignacion.motorizadoId', '==', motorizadoId), where('estado', '==', 'entregado'), where('entregadoAt', '>=', semanaStart))),
    getCountFromServer(query(col, where('asignacion.motorizadoId', '==', motorizadoId), where('asignacion.estadoAceptacion', '==', 'aceptada'))),
    getDocs(query(col, where('asignacion.motorizadoId', '==', motorizadoId), where('asignacion.estadoAceptacion', '==', 'rechazada'), orderBy('updatedAt', 'desc'), limit(3))),
    getDocs(query(col, where('asignacion.motorizadoId', '==', motorizadoId), where('estado', '==', 'entregado'))),
  ])

  const aceptadas = aceptadasSnap.data().count
  const rechazadas = rechazadasSnap.size
  const tasaAceptacion = (aceptadas + rechazadas) > 0
    ? Math.round((aceptadas / (aceptadas + rechazadas)) * 100)
    : null

  const ultimosRechazos = rechazadasSnap.docs.map((d) => ({
    id: d.id,
    fecha: (d.data() as any).updatedAt as Timestamp | undefined,
  }))

  // Depósitos pendientes: órdenes sin confirmar que requieren depósito
  let depositosPendientes = 0
  depositosSnap.docs.forEach((d) => {
    const data = d.data() as any
    const dep = data?.registro?.deposito
    if (dep?.confirmadoMotorizado) return // legacy: ya ok
    const ceAplica = !!data?.cobroContraEntrega?.aplica
    const quienPaga = data?.pagoDelivery?.quienPaga || ''
    const esCredito = data?.tipoCliente === 'credito' || quienPaga === 'credito_semanal'
    const esTransferencia = quienPaga === 'transferencia'
    const precio = data?.confirmacion?.precioFinalCordobas || 0
    const needsStorkhub = !esTransferencia && !esCredito && precio > 0
    const needsComercio = ceAplica && (data?.cobroContraEntrega?.monto || 0) > 0
    if (!needsStorkhub && !needsComercio) return
    const storkhubOk = !needsStorkhub || !!dep?.confirmadoStorkhub
    const comercioOk = !needsComercio || !!dep?.confirmadoComercio
    if (!storkhubOk || !comercioOk) depositosPendientes++
  })

  return {
    total: totalSnap.data().count,
    hoy: hoySnap.data().count,
    semana: semanaSnap.data().count,
    tasaAceptacion,
    rechazos: rechazadas,
    ultimosRechazos,
    depositosPendientes,
  }
}

// ─── Main ─────────────────────────────────────────────────────────────────────

export default function MotorizadosPage() {
  const [motorizados, setMotorizados] = useState<Motorizado[]>([])
  const [loading, setLoading] = useState(true)

  // Drawer
  const [selected, setSelected] = useState<Motorizado | null>(null)
  const [drawerOpen, setDrawerOpen] = useState(false)
  const [isNew, setIsNew] = useState(false)

  // Edit fields
  const [eName, setEName] = useState('')
  const [ePhone, setEPhone] = useState('')
  const [eAuthUid, setEAuthUid] = useState('')
  const [eActivo, setEActivo] = useState(true)
  const [eEstado, setEEstado] = useState<EstadoMoto>('disponible')
  const [saving, setSaving] = useState(false)
  const [msg, setMsg] = useState<string | null>(null)

  // Stats in drawer
  const [stats, setStats] = useState<Stats | null>(null)
  const [loadingStats, setLoadingStats] = useState(false)

  // Real-time listener
  useEffect(() => {
    const unsub = onSnapshot(collection(db, 'motorizado'), (snap) => {
      const list: Motorizado[] = snap.docs.map((d) => ({ id: d.id, ...(d.data() as any) }))
      list.sort((a, b) => (a.nombre || '').localeCompare(b.nombre || ''))
      setMotorizados(list)
      setLoading(false)
    })
    return () => unsub()
  }, [])

  // Summary counts
  const totalCount = motorizados.length
  const disponibles = motorizados.filter((m) => m.activo !== false && m.estado === 'disponible').length
  const ocupados = motorizados.filter((m) => m.activo !== false && m.estado === 'ocupado').length
  const inactivos = motorizados.filter((m) => m.activo === false).length

  function openEdit(m: Motorizado) {
    setIsNew(false)
    setSelected(m)
    setEName(m.nombre || '')
    setEPhone(m.telefono || '')
    setEAuthUid(m.authUid || '')
    setEActivo(m.activo !== false)
    setEEstado(m.estado || 'disponible')
    setMsg(null)
    setStats(null)
    setDrawerOpen(true)
    // Load stats
    setLoadingStats(true)
    fetchStats(m.id).then((s) => { setStats(s); setLoadingStats(false) }).catch(() => setLoadingStats(false))
  }

  function openNew() {
    setIsNew(true)
    setSelected(null)
    setEName('')
    setEPhone('')
    setEAuthUid('')
    setEActivo(true)
    setEEstado('disponible')
    setMsg(null)
    setStats(null)
    setDrawerOpen(true)
  }

  function closeDrawer() {
    setDrawerOpen(false)
    setTimeout(() => { setSelected(null); setIsNew(false) }, 300)
  }

  async function save() {
    if (!eName.trim()) { setMsg('❌ El nombre es obligatorio.'); return }
    setSaving(true); setMsg(null)
    try {
      if (isNew) {
        await addDoc(collection(db, 'motorizado'), {
          nombre: eName.trim(),
          telefono: ePhone.trim(),
          estado: eEstado,
          activo: eActivo,
          authUid: eAuthUid.trim() || null,
          createdAt: serverTimestamp(),
        })
        setMsg('✅ Motorizado creado')
        setIsNew(false)
      } else if (selected) {
        await updateDoc(doc(db, 'motorizado', selected.id), {
          nombre: eName.trim(),
          telefono: ePhone.trim(),
          estado: eEstado,
          activo: eActivo,
          authUid: eAuthUid.trim() || null,
        })
        setMsg('✅ Guardado')
      }
    } catch (e: any) {
      setMsg(`❌ Error: ${e?.message || 'No se pudo guardar'}`)
    } finally {
      setSaving(false)
    }
  }

  const S = {
    input: 'w-full border border-gray-200 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-[#004aad]/30 focus:border-[#004aad]',
    label: 'block text-xs font-semibold text-gray-500 mb-1 uppercase tracking-wide',
    btnPrimary: 'bg-[#004aad] text-white text-sm font-semibold px-4 py-2 rounded-lg hover:bg-[#003a8c] transition',
  }

  return (
    <div className="flex flex-col gap-4">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-black text-gray-900 tracking-tight">Motorizados</h1>
          <p className="text-sm text-gray-500 mt-0.5">Gestioná el equipo de entrega en tiempo real.</p>
        </div>
        <button onClick={openNew} className="flex items-center gap-2 bg-[#004aad] text-white text-sm font-semibold px-4 py-2 rounded-xl hover:bg-[#003a8c] transition">
          <Plus className="h-4 w-4" />
          Nuevo motorizado
        </button>
      </div>

      {/* Stats */}
      <div className="grid grid-cols-4 gap-3">
        {[
          { label: 'Total', value: totalCount, color: 'text-gray-900', bg: 'bg-white' },
          { label: 'Disponibles', value: disponibles, color: 'text-green-700', bg: 'bg-green-50' },
          { label: 'Ocupados', value: ocupados, color: 'text-yellow-700', bg: 'bg-yellow-50' },
          { label: 'Inactivos', value: inactivos, color: 'text-red-600', bg: 'bg-red-50' },
        ].map((s) => (
          <div key={s.label} className={`${s.bg} rounded-xl border border-gray-200 px-4 py-3`}>
            <p className={`text-2xl font-black ${s.color}`}>{s.value}</p>
            <p className="text-xs font-semibold text-gray-500 mt-0.5">{s.label}</p>
          </div>
        ))}
      </div>

      {/* Table */}
      <div className="overflow-x-auto rounded-xl border border-gray-200 bg-white shadow-sm">
        {loading ? (
          <div className="py-20 text-center text-sm text-gray-400">Cargando motorizados…</div>
        ) : motorizados.length === 0 ? (
          <div className="flex flex-col items-center justify-center py-20 gap-2 text-gray-400">
            <Bike className="h-10 w-10 opacity-30" />
            <p className="text-sm font-medium">No hay motorizados registrados</p>
          </div>
        ) : (
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b bg-gray-50 text-left text-[11px] font-semibold uppercase tracking-wide text-gray-500">
                <th className="px-4 py-3">Motorizado</th>
                <th className="px-4 py-3">Teléfono</th>
                <th className="px-4 py-3">Estado</th>
                <th className="px-4 py-3">Activo</th>
                <th className="px-4 py-3" />
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-100">
              {motorizados.map((m) => {
                const activo = m.activo !== false
                const cfg = estadoConfig[m.estado || 'disponible'] || estadoConfig.disponible
                return (
                  <tr key={m.id} className="hover:bg-gray-50 transition-colors">
                    <td className="px-4 py-3">
                      <div className="flex items-center gap-3">
                        <div className="w-9 h-9 rounded-full bg-[#004aad]/10 grid place-items-center flex-shrink-0">
                          <span className="text-sm font-black text-[#004aad]">
                            {(m.nombre || '?')[0].toUpperCase()}
                          </span>
                        </div>
                        <span className="font-semibold text-gray-900">{m.nombre}</span>
                      </div>
                    </td>
                    <td className="px-4 py-3 text-gray-600">{m.telefono || '—'}</td>
                    <td className="px-4 py-3">
                      {activo ? (
                        <span className={`inline-flex items-center gap-1.5 text-xs font-semibold px-2.5 py-1 rounded-full border ${cfg.cls}`}>
                          <span className={`w-1.5 h-1.5 rounded-full ${m.estado === 'ocupado' ? 'bg-yellow-500' : 'bg-green-500'}`} />
                          {cfg.label}
                        </span>
                      ) : (
                        <span className="inline-flex items-center text-xs font-semibold px-2.5 py-1 rounded-full border bg-red-50 text-red-600 border-red-200">
                          Inactivo
                        </span>
                      )}
                    </td>
                    <td className="px-4 py-3">
                      <span className={`inline-flex text-xs font-semibold px-2 py-0.5 rounded-full border ${activo ? 'bg-green-50 text-green-700 border-green-200' : 'bg-gray-100 text-gray-500 border-gray-200'}`}>
                        {activo ? 'Activo' : 'Inactivo'}
                      </span>
                    </td>
                    <td className="px-4 py-3 text-right">
                      <button onClick={() => openEdit(m)} className="text-[#004aad] text-xs font-semibold hover:underline">
                        Editar
                      </button>
                    </td>
                  </tr>
                )
              })}
            </tbody>
          </table>
        )}
      </div>

      {/* Drawer overlay */}
      <div
        className={`fixed inset-0 z-40 bg-black/40 backdrop-blur-sm transition-opacity ${drawerOpen ? 'opacity-100 pointer-events-auto' : 'opacity-0 pointer-events-none'}`}
        onClick={closeDrawer}
      />

      {/* Drawer */}
      <div className={`fixed right-0 top-0 z-50 h-full w-full max-w-[460px] bg-white shadow-2xl flex flex-col transition-transform duration-300 ${drawerOpen ? 'translate-x-0' : 'translate-x-full'}`}>
        {/* Header */}
        <div className="flex items-center justify-between px-5 py-4 border-b border-gray-200">
          <div>
            <h2 className="text-lg font-black text-gray-900">
              {isNew ? 'Nuevo motorizado' : (selected?.nombre || 'Editar')}
            </h2>
            {!isNew && selected && (
              <p className="text-xs text-gray-400 mt-0.5">
                {selected.activo !== false ? 'Motorizado activo' : 'Motorizado inactivo'}
              </p>
            )}
          </div>
          <button onClick={closeDrawer} className="w-9 h-9 grid place-items-center rounded-full border border-gray-200 hover:bg-gray-50 transition">
            <X className="h-4 w-4 text-gray-500" />
          </button>
        </div>

        {/* Body */}
        <div className="flex-1 overflow-y-auto p-5 space-y-6">

          {/* Stats rápidas (solo en edición) */}
          {!isNew && (
            <section className="space-y-3">
              <div className="flex items-center gap-2">
                <TrendingUp className="h-4 w-4 text-[#004aad]" />
                <h3 className="text-xs font-bold text-gray-500 uppercase tracking-wide">Rendimiento</h3>
              </div>

              {/* Grid KPIs */}
              <div className="grid grid-cols-3 gap-2">
                {[
                  { label: 'Hoy', value: stats?.hoy, color: 'text-blue-700', bg: 'bg-blue-50 border-blue-200' },
                  { label: 'Esta semana', value: stats?.semana, color: 'text-indigo-700', bg: 'bg-indigo-50 border-indigo-200' },
                  { label: 'Total', value: stats?.total, color: 'text-gray-800', bg: 'bg-gray-50 border-gray-200' },
                ].map((k) => (
                  <div key={k.label} className={`${k.bg} border rounded-xl px-3 py-2.5 text-center`}>
                    <p className={`text-xl font-black ${k.color}`}>
                      {loadingStats ? '…' : (k.value ?? '—')}
                    </p>
                    <p className="text-[10px] font-semibold text-gray-500 mt-0.5">{k.label}</p>
                  </div>
                ))}
              </div>

              <div className="grid grid-cols-3 gap-2">
                <div className={`border rounded-xl px-3 py-2.5 text-center ${
                  !loadingStats && stats?.tasaAceptacion !== null && (stats?.tasaAceptacion ?? 0) < 70
                    ? 'bg-red-50 border-red-200'
                    : 'bg-green-50 border-green-200'
                }`}>
                  <p className={`text-xl font-black ${
                    !loadingStats && stats?.tasaAceptacion !== null && (stats?.tasaAceptacion ?? 0) < 70
                      ? 'text-red-600'
                      : 'text-green-700'
                  }`}>
                    {loadingStats ? '…' : stats?.tasaAceptacion !== null ? `${stats?.tasaAceptacion}%` : '—'}
                  </p>
                  <p className="text-[10px] font-semibold text-gray-500 mt-0.5">Tasa acept.</p>
                </div>
                <div className={`border rounded-xl px-3 py-2.5 text-center ${(stats?.rechazos ?? 0) > 0 ? 'bg-orange-50 border-orange-200' : 'bg-gray-50 border-gray-200'}`}>
                  <p className={`text-xl font-black ${(stats?.rechazos ?? 0) > 0 ? 'text-orange-600' : 'text-gray-700'}`}>
                    {loadingStats ? '…' : (stats?.rechazos ?? '—')}
                  </p>
                  <p className="text-[10px] font-semibold text-gray-500 mt-0.5">Rechazos</p>
                </div>
                <div className={`border rounded-xl px-3 py-2.5 text-center ${(stats?.depositosPendientes ?? 0) > 0 ? 'bg-yellow-50 border-yellow-200' : 'bg-gray-50 border-gray-200'}`}>
                  <p className={`text-xl font-black ${(stats?.depositosPendientes ?? 0) > 0 ? 'text-yellow-600' : 'text-gray-700'}`}>
                    {loadingStats ? '…' : (stats?.depositosPendientes ?? '—')}
                  </p>
                  <p className="text-[10px] font-semibold text-gray-500 mt-0.5">Dep. pend.</p>
                </div>
              </div>

              {/* Últimos rechazos */}
              {!loadingStats && (stats?.ultimosRechazos?.length ?? 0) > 0 && (
                <div className="bg-orange-50 border border-orange-200 rounded-xl p-3">
                  <div className="flex items-center gap-1.5 mb-2">
                    <AlertCircle className="h-3.5 w-3.5 text-orange-500" />
                    <p className="text-xs font-bold text-orange-700">Últimos rechazos</p>
                  </div>
                  <ul className="space-y-1">
                    {stats!.ultimosRechazos.map((r) => (
                      <li key={r.id} className="flex items-center justify-between text-xs">
                        <span className="font-mono text-gray-500">{r.id.slice(0, 8)}</span>
                        <span className="text-gray-400">
                          {r.fecha ? (typeof r.fecha.toDate === 'function' ? r.fecha.toDate() : new Date(r.fecha as any)).toLocaleDateString('es-NI', { day: '2-digit', month: 'short' }) : '—'}
                        </span>
                      </li>
                    ))}
                  </ul>
                </div>
              )}
            </section>
          )}

          {/* Datos */}
          <section className="space-y-3">
            <h3 className="text-xs font-bold text-gray-500 uppercase tracking-wide">Datos del motorizado</h3>
            <div>
              <label className={S.label}>Nombre <span className="text-red-500">*</span></label>
              <input value={eName} onChange={(e) => setEName(e.target.value)} placeholder="Nombre completo" className={S.input} />
            </div>
            <div>
              <label className={S.label}>Teléfono</label>
              <input value={ePhone} onChange={(e) => setEPhone(e.target.value)} placeholder="8888-8888" className={S.input} />
            </div>
            <div>
              <label className={S.label}>UID de Firebase Auth <span className="text-gray-400 font-normal normal-case">(opcional)</span></label>
              <input value={eAuthUid} onChange={(e) => setEAuthUid(e.target.value)} placeholder="abc123xyz..." className={S.input} />
              <p className="text-xs text-gray-400 mt-1">Se asigna cuando el motorizado tenga cuenta creada en la app.</p>
            </div>
          </section>

          {/* Estado */}
          <section className="space-y-3">
            <h3 className="text-xs font-bold text-gray-500 uppercase tracking-wide">Estado operativo</h3>
            <div className="flex gap-2">
              {(['disponible', 'ocupado'] as EstadoMoto[]).map((e) => (
                <button
                  key={e}
                  onClick={() => setEEstado(e)}
                  className={`flex-1 py-2 rounded-xl text-sm font-semibold border transition ${eEstado === e
                    ? e === 'disponible' ? 'bg-green-50 text-green-700 border-green-300' : 'bg-yellow-50 text-yellow-700 border-yellow-300'
                    : 'bg-white text-gray-500 border-gray-200 hover:bg-gray-50'
                  }`}
                >
                  {e === 'disponible' ? '🟢 Disponible' : '🟡 Ocupado'}
                </button>
              ))}
            </div>
          </section>

          {/* Activo / Inactivo */}
          <section>
            <h3 className="text-xs font-bold text-gray-500 uppercase tracking-wide mb-3">Cuenta</h3>
            <button
              onClick={() => setEActivo(!eActivo)}
              className={`w-full flex items-center justify-between px-4 py-3 rounded-xl border transition ${eActivo ? 'bg-green-50 border-green-200' : 'bg-red-50 border-red-200'}`}
            >
              <div>
                <p className={`text-sm font-bold ${eActivo ? 'text-green-700' : 'text-red-600'}`}>
                  {eActivo ? 'Motorizado activo' : 'Motorizado inactivo'}
                </p>
                <p className="text-xs text-gray-500 mt-0.5">
                  {eActivo ? 'Puede recibir y operar órdenes.' : 'No aparece para asignación de órdenes.'}
                </p>
              </div>
              <div className={`w-11 h-6 rounded-full transition-colors ${eActivo ? 'bg-green-500' : 'bg-gray-300'} relative`}>
                <div className={`absolute top-0.5 w-5 h-5 bg-white rounded-full shadow transition-transform ${eActivo ? 'translate-x-5' : 'translate-x-0.5'}`} />
              </div>
            </button>
          </section>

        </div>

        {/* Footer */}
        <div className="px-5 py-4 border-t border-gray-200 flex items-center gap-3">
          <button onClick={save} disabled={saving} className={S.btnPrimary}>
            {saving ? 'Guardando…' : isNew ? 'Crear motorizado' : 'Guardar cambios'}
          </button>
          {msg && (
            <span className={`text-sm font-semibold ${msg.startsWith('✅') ? 'text-green-600' : 'text-red-600'}`}>
              {msg}
            </span>
          )}
        </div>
      </div>
    </div>
  )
}
