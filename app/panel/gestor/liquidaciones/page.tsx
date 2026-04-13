'use client'

import { useEffect, useMemo, useState } from 'react'
import {
  collection,
  onSnapshot,
  query,
  where,
  doc,
  addDoc,
  updateDoc,
  serverTimestamp,
  Timestamp,
  orderBy,
  limit,
} from 'firebase/firestore'
import { auth, db } from '@/fb/config'
import { registrarMovimiento } from '@/lib/financial-writes'
import { Receipt, ChevronDown, ChevronUp, CheckCircle2 } from 'lucide-react'

// ─── Types ────────────────────────────────────────────────────────────────────

type Motorizado = {
  id: string
  authUid: string
  nombre?: string
  estado?: string
}

type Solicitud = {
  id: string
  estado?: string
  entregadoAt?: Timestamp
  asignacion?: {
    motorizadoId?: string
    motorizadoAuthUid?: string
    motorizadoNombre?: string
  } | null
  confirmacion?: { precioFinalCordobas?: number }
  cobrosMotorizado?: {
    delivery?: { recibio: boolean; monto: number }
    producto?: { recibio: boolean; monto: number }
  }
}

type DepositoOrderDoc = {
  id: string
  estado?: string
  confirmadoGestor?: boolean
  motorizadoUid: string
  montoTotal: number
  creadoAt?: Timestamp
  tipo?: string
}

type Liquidacion = {
  id: string
  motorizadoId: string
  motorizadoUid: string
  motorizadoNombre: string
  semanaKey: string
  semanaInicio: Timestamp
  semanaFin: Timestamp
  totalViajes: number
  totalGenerado: number
  comisionPct: number
  comision: number
  adelantos: number
  faltantesDeposito: number
  otrosDescuentos: number
  netoAPagar: number
  estado: 'pendiente' | 'pagado'
  creadoAt?: Timestamp
  pagadoAt?: Timestamp
  pagadoPor?: string
}

// ─── Semana helpers (ISO 8601) ────────────────────────────────────────────────

function getSemanaKey(date: Date): string {
  const d = new Date(Date.UTC(date.getFullYear(), date.getMonth(), date.getDate()))
  const day = d.getUTCDay() || 7
  d.setUTCDate(d.getUTCDate() + 4 - day)
  const yearStart = new Date(Date.UTC(d.getUTCFullYear(), 0, 1))
  const week = Math.ceil((((d.getTime() - yearStart.getTime()) / 86400000) + 1) / 7)
  return `${d.getUTCFullYear()}-W${String(week).padStart(2, '0')}`
}

function getSemanaRange(semanaKey: string): { inicio: Date; fin: Date } {
  const [yearStr, weekStr] = semanaKey.split('-W')
  const year = parseInt(yearStr)
  const week = parseInt(weekStr)
  const jan4 = new Date(year, 0, 4)
  const jan4Day = jan4.getDay() || 7
  const monday = new Date(jan4)
  monday.setDate(jan4.getDate() - jan4Day + 1 + (week - 1) * 7)
  monday.setHours(0, 0, 0, 0)
  const sunday = new Date(monday)
  sunday.setDate(monday.getDate() + 6)
  sunday.setHours(23, 59, 59, 999)
  return { inicio: monday, fin: sunday }
}

function formatSemana(semanaKey: string): string {
  try {
    const { inicio, fin } = getSemanaRange(semanaKey)
    const opts: Intl.DateTimeFormatOptions = { day: '2-digit', month: 'short' }
    return `${inicio.toLocaleDateString('es-NI', opts)} – ${fin.toLocaleDateString('es-NI', opts)}`
  } catch { return semanaKey }
}

// Semanas recientes para el selector (últimas 8)
function getSemanasRecientes(): string[] {
  const semanas: string[] = []
  const now = new Date()
  for (let i = 0; i < 8; i++) {
    const d = new Date(now)
    d.setDate(d.getDate() - i * 7)
    const key = getSemanaKey(d)
    if (!semanas.includes(key)) semanas.push(key)
  }
  return semanas
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function fmt(n?: number) {
  if (typeof n !== 'number') return '—'
  return `C$ ${n.toLocaleString('es-NI')}`
}

function tsToDate(v: any): Date | null {
  if (!v) return null
  if (typeof v?.toDate === 'function') return v.toDate()
  if (v instanceof Date) return v
  return null
}

function fmtDate(v: any) {
  const d = tsToDate(v)
  if (!d) return '—'
  return d.toLocaleDateString('es-NI', { day: '2-digit', month: 'short', year: 'numeric' })
}

// ─── Main ─────────────────────────────────────────────────────────────────────

export default function LiquidacionesPage() {
  const [motorizados, setMotorizados] = useState<Motorizado[]>([])
  const [selectedMotoId, setSelectedMotoId] = useState<string>('')
  const [selectedSemana, setSelectedSemana] = useState<string>(getSemanaKey(new Date()))

  // Data for the selected motorizado + semana
  const [ordenes, setOrdenes] = useState<Solicitud[]>([])
  const [depositos, setDepositos] = useState<DepositoOrderDoc[]>([])
  const [adelantos, setAdelantos] = useState<number>(0)
  const [loading, setLoading] = useState(false)
  const [expanded, setExpanded] = useState(false)

  // Liquidaciones existentes
  const [liquidaciones, setLiquidaciones] = useState<Liquidacion[]>([])
  const [loadingLiq, setLoadingLiq] = useState(true)
  const [saving, setSaving] = useState(false)
  const [err, setErr] = useState<string | null>(null)

  const semanasOpciones = useMemo(() => getSemanasRecientes(), [])

  // ── Load motorizados ─────────────────────────────────────────────────────

  useEffect(() => {
    const q = query(collection(db, 'motorizado'))
    return onSnapshot(q, (snap) => {
      const list = snap.docs.map((d) => ({ id: d.id, ...(d.data() as any) } as Motorizado))
        .sort((a, b) => (a.nombre || '').localeCompare(b.nombre || ''))
      setMotorizados(list)
    })
  }, [])

  // ── Load liquidaciones del motorizado seleccionado ────────────────────────

  useEffect(() => {
    if (!selectedMotoId) { setLiquidaciones([]); setLoadingLiq(false); return }
    const moto = motorizados.find((m) => m.id === selectedMotoId)
    if (!moto) return
    setLoadingLiq(true)
    const q = query(
      collection(db, 'liquidaciones_motorizado'),
      where('motorizadoUid', '==', moto.authUid),
      orderBy('semanaKey', 'desc'),
      limit(20)
    )
    return onSnapshot(q, (snap) => {
      setLiquidaciones(snap.docs.map((d) => ({ id: d.id, ...(d.data() as any) } as Liquidacion)))
      setLoadingLiq(false)
    })
  }, [selectedMotoId, motorizados])

  // ── Load órdenes del motorizado en la semana seleccionada ─────────────────

  useEffect(() => {
    if (!selectedMotoId) { setOrdenes([]); return }
    const { inicio, fin } = getSemanaRange(selectedSemana)
    setLoading(true)

    const q = query(
      collection(db, 'solicitudes_envio'),
      where('asignacion.motorizadoId', '==', selectedMotoId),
      where('estado', '==', 'entregado')
    )
    return onSnapshot(q, (snap) => {
      const all = snap.docs.map((d) => ({ id: d.id, ...(d.data() as any) } as Solicitud))
      // Filtrar por semana en cliente (entregadoAt en rango)
      const filtradas = all.filter((o) => {
        const d = tsToDate(o.entregadoAt)
        if (!d) return false
        return d >= inicio && d <= fin
      })
      setOrdenes(filtradas)
      setLoading(false)
    })
  }, [selectedMotoId, selectedSemana])

  // ── Load depósitos confirmados del motorizado en la semana ────────────────

  useEffect(() => {
    if (!selectedMotoId) { setDepositos([]); return }
    const moto = motorizados.find((m) => m.id === selectedMotoId)
    if (!moto?.authUid) return

    const q = query(
      collection(db, 'ordenes_deposito'),
      where('motorizadoUid', '==', moto.authUid),
      where('confirmadoGestor', '==', true)
    )
    return onSnapshot(q, (snap) => {
      const all = snap.docs.map((d) => ({ id: d.id, ...(d.data() as any) } as DepositoOrderDoc))
      const { inicio, fin } = getSemanaRange(selectedSemana)
      const filtrados = all.filter((dep) => {
        const d = tsToDate(dep.creadoAt)
        if (!d) return false
        return d >= inicio && d <= fin
      })
      setDepositos(filtrados)
    })
  }, [selectedMotoId, selectedSemana, motorizados])

  // ── Load adelantos del motorizado en la semana ────────────────────────────

  useEffect(() => {
    if (!selectedMotoId) { setAdelantos(0); return }
    const moto = motorizados.find((m) => m.id === selectedMotoId)
    if (!moto?.authUid) return

    const q = query(
      collection(db, 'movimientos_financieros'),
      where('tipo', '==', 'adelanto_motorizado'),
      where('motorizadoId', '==', selectedMotoId)
    )
    const { inicio, fin } = getSemanaRange(selectedSemana)
    return onSnapshot(q, (snap) => {
      const total = snap.docs.reduce((sum, d) => {
        const data = d.data() as any
        const at = tsToDate(data.at)
        if (at && at >= inicio && at <= fin) return sum + (data.monto || 0)
        return sum
      }, 0)
      setAdelantos(total)
    })
  }, [selectedMotoId, selectedSemana, motorizados])

  // ── Cálculos ──────────────────────────────────────────────────────────────

  const calculo = useMemo(() => {
    const totalGenerado = ordenes.reduce((s, o) => s + (o.confirmacion?.precioFinalCordobas || 0), 0)
    const totalDepositado = depositos
      .filter((d) => !d.tipo || d.tipo === 'recaudacion_motorizado_storkhub')
      .reduce((s, d) => s + d.montoTotal, 0)
    const comisionPct = 0.8
    const comision = totalGenerado * comisionPct
    const faltantesDeposito = Math.max(0, totalGenerado - totalDepositado)
    const netoAPagar = Math.max(0, comision - adelantos - faltantesDeposito)

    return {
      totalViajes: ordenes.length,
      totalGenerado,
      totalDepositado,
      comisionPct,
      comision,
      adelantos,
      faltantesDeposito,
      otrosDescuentos: 0,
      netoAPagar,
    }
  }, [ordenes, depositos, adelantos])

  // ── Verificar si ya existe liquidación para esta semana ───────────────────

  const liquidacionExistente = useMemo(
    () => liquidaciones.find((l) => l.semanaKey === selectedSemana),
    [liquidaciones, selectedSemana]
  )

  // ── Crear liquidación ─────────────────────────────────────────────────────

  async function crearLiquidacion() {
    if (!selectedMotoId || liquidacionExistente) return
    const moto = motorizados.find((m) => m.id === selectedMotoId)
    if (!moto) return

    setSaving(true); setErr(null)
    try {
      const uid = auth.currentUser?.uid ?? ''
      const { inicio, fin } = getSemanaRange(selectedSemana)
      const docRef = await addDoc(collection(db, 'liquidaciones_motorizado'), {
        motorizadoId: selectedMotoId,
        motorizadoUid: moto.authUid,
        motorizadoNombre: moto.nombre || moto.authUid,
        semanaKey: selectedSemana,
        semanaInicio: Timestamp.fromDate(inicio),
        semanaFin: Timestamp.fromDate(fin),
        totalViajes: calculo.totalViajes,
        totalGenerado: calculo.totalGenerado,
        comisionPct: calculo.comisionPct,
        comision: calculo.comision,
        adelantos: calculo.adelantos,
        faltantesDeposito: calculo.faltantesDeposito,
        otrosDescuentos: 0,
        netoAPagar: calculo.netoAPagar,
        estado: 'pendiente',
        creadoAt: serverTimestamp(),
        creadoPor: uid,
        ordenesIds: ordenes.map((o) => o.id),
        depositosIds: depositos.map((d) => d.id),
      })
      await registrarMovimiento('liquidacion_pagada', calculo.netoAPagar, uid,
        `Liquidación creada sem ${selectedSemana} · ${moto.nombre || moto.authUid}`,
        { motorizadoId: selectedMotoId, depositoId: docRef.id })
    } catch (e: any) {
      setErr(e?.message || 'Error al crear liquidación')
    } finally {
      setSaving(false)
    }
  }

  async function marcarPagada(liq: Liquidacion) {
    setSaving(true); setErr(null)
    try {
      const uid = auth.currentUser?.uid ?? ''
      await updateDoc(doc(db, 'liquidaciones_motorizado', liq.id), {
        estado: 'pagado',
        pagadoAt: serverTimestamp(),
        pagadoPor: uid,
      })
      await registrarMovimiento('liquidacion_pagada', liq.netoAPagar, uid,
        `Liquidación pagada sem ${liq.semanaKey} · ${liq.motorizadoNombre}`,
        { motorizadoId: liq.motorizadoId })
    } catch (e: any) {
      setErr(e?.message || 'Error')
    } finally {
      setSaving(false)
    }
  }

  const selectedMoto = motorizados.find((m) => m.id === selectedMotoId)

  // ── Render ─────────────────────────────────────────────────────────────────

  return (
    <div className="flex flex-col gap-5 max-w-3xl mx-auto">
      {/* Header */}
      <div>
        <h1 className="text-2xl font-black text-gray-900 tracking-tight flex items-center gap-2">
          <Receipt className="h-6 w-6 text-[#004aad]" />
          Liquidaciones
        </h1>
        <p className="text-sm text-gray-500 mt-0.5">
          Cálculo y pago semanal de motorizados · Comisión 80%
        </p>
      </div>

      {/* Selector */}
      <div className="grid grid-cols-1 sm:grid-cols-2 gap-3 bg-white rounded-xl border border-gray-200 p-4">
        <div>
          <label className="block text-xs font-semibold text-gray-500 mb-1">Motorizado</label>
          <select
            value={selectedMotoId}
            onChange={(e) => setSelectedMotoId(e.target.value)}
            className="w-full border border-gray-200 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-[#004aad]/30"
          >
            <option value="">— Seleccionar —</option>
            {motorizados.map((m) => (
              <option key={m.id} value={m.id}>{m.nombre || m.authUid}</option>
            ))}
          </select>
        </div>
        <div>
          <label className="block text-xs font-semibold text-gray-500 mb-1">Semana</label>
          <select
            value={selectedSemana}
            onChange={(e) => setSelectedSemana(e.target.value)}
            className="w-full border border-gray-200 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-[#004aad]/30"
          >
            {semanasOpciones.map((s) => (
              <option key={s} value={s}>{s} · {formatSemana(s)}</option>
            ))}
          </select>
        </div>
      </div>

      {/* Cálculo */}
      {selectedMotoId && (
        <div className="bg-white rounded-xl border border-gray-200 shadow-sm overflow-hidden">
          <div className="px-4 py-3 border-b border-gray-100 flex items-center justify-between">
            <div>
              <p className="text-sm font-bold text-gray-900">{selectedMoto?.nombre}</p>
              <p className="text-xs text-gray-400">{selectedSemana} · {formatSemana(selectedSemana)}</p>
            </div>
            {liquidacionExistente && (
              <span className={`text-xs font-bold px-2 py-1 rounded-full ${
                liquidacionExistente.estado === 'pagado'
                  ? 'bg-green-100 text-green-700'
                  : 'bg-orange-100 text-orange-700'
              }`}>
                {liquidacionExistente.estado === 'pagado' ? '✓ Pagado' : '⏳ Pendiente'}
              </span>
            )}
          </div>

          {loading ? (
            <div className="py-10 text-center text-sm text-gray-400">Cargando datos…</div>
          ) : (
            <div className="p-4">
              {/* KPIs grid */}
              <div className="grid grid-cols-2 sm:grid-cols-3 gap-3 mb-4">
                <KpiCard label="Viajes" value={calculo.totalViajes.toString()} color="blue" />
                <KpiCard label="Total delivery" value={fmt(calculo.totalGenerado)} color="gray" />
                <KpiCard label="Comisión (80%)" value={fmt(calculo.comision)} color="green" />
                <KpiCard label="Total depositado" value={fmt(calculo.totalDepositado)} color="gray" />
                <KpiCard label="Faltante depósito" value={fmt(calculo.faltantesDeposito)} color={calculo.faltantesDeposito > 0 ? 'red' : 'gray'} />
                <KpiCard label="Adelantos" value={fmt(calculo.adelantos)} color={calculo.adelantos > 0 ? 'orange' : 'gray'} />
              </div>

              {/* Neto a pagar */}
              <div className="rounded-xl bg-[#004aad] text-white px-4 py-4 flex items-center justify-between mb-4">
                <div>
                  <p className="text-xs font-semibold opacity-70">NETO A PAGAR</p>
                  <p className="text-2xl font-black mt-0.5">{fmt(calculo.netoAPagar)}</p>
                </div>
                <div className="text-right text-xs opacity-70 space-y-0.5">
                  <p>Comisión {fmt(calculo.comision)}</p>
                  {calculo.adelantos > 0 && <p>− Adelantos {fmt(calculo.adelantos)}</p>}
                  {calculo.faltantesDeposito > 0 && <p>− Faltante {fmt(calculo.faltantesDeposito)}</p>}
                </div>
              </div>

              {/* Desglose de órdenes colapsable */}
              <button
                onClick={() => setExpanded((v) => !v)}
                className="flex items-center gap-1 text-xs text-[#004aad] font-semibold mb-2"
              >
                {expanded ? <ChevronUp className="h-3 w-3" /> : <ChevronDown className="h-3 w-3" />}
                {calculo.totalViajes} viaje{calculo.totalViajes !== 1 ? 's' : ''} en esta semana
              </button>

              {expanded && ordenes.length > 0 && (
                <div className="rounded-xl border border-gray-100 overflow-hidden mb-4">
                  <table className="w-full text-xs">
                    <thead>
                      <tr className="bg-gray-50 border-b">
                        <th className="px-3 py-2 text-left font-semibold text-gray-500">Orden</th>
                        <th className="px-3 py-2 text-left font-semibold text-gray-500">Entregado</th>
                        <th className="px-3 py-2 text-right font-semibold text-gray-500">Delivery</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-gray-50">
                      {ordenes.map((o) => (
                        <tr key={o.id}>
                          <td className="px-3 py-2 font-mono text-gray-400">{o.id.slice(0, 10)}</td>
                          <td className="px-3 py-2 text-gray-600">{fmtDate(o.entregadoAt)}</td>
                          <td className="px-3 py-2 text-right font-semibold text-gray-800">
                            {fmt(o.confirmacion?.precioFinalCordobas)}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}

              {err && <p className="text-xs text-red-600 mb-3">{err}</p>}

              {/* Acciones */}
              {liquidacionExistente ? (
                liquidacionExistente.estado === 'pendiente' ? (
                  <button
                    onClick={() => marcarPagada(liquidacionExistente)}
                    disabled={saving}
                    className="w-full bg-green-600 text-white text-sm font-semibold py-2.5 rounded-xl hover:bg-green-700 transition disabled:opacity-40"
                  >
                    {saving ? 'Guardando…' : '✓ Marcar como pagado'}
                  </button>
                ) : (
                  <div className="flex items-center gap-2 text-green-700 bg-green-50 rounded-xl px-4 py-3">
                    <CheckCircle2 className="h-4 w-4" />
                    <span className="text-sm font-semibold">Liquidación pagada · {fmtDate(liquidacionExistente.pagadoAt)}</span>
                  </div>
                )
              ) : (
                <button
                  onClick={crearLiquidacion}
                  disabled={saving || calculo.totalViajes === 0}
                  className="w-full bg-[#004aad] text-white text-sm font-semibold py-2.5 rounded-xl hover:bg-[#0a49a4] transition disabled:opacity-40"
                >
                  {saving ? 'Creando…' : calculo.totalViajes === 0 ? 'Sin viajes en esta semana' : '+ Crear liquidación'}
                </button>
              )}
            </div>
          )}
        </div>
      )}

      {/* Historial de liquidaciones */}
      {selectedMotoId && (
        <div className="bg-white rounded-xl border border-gray-200 shadow-sm overflow-hidden">
          <div className="px-4 py-3 border-b border-gray-100">
            <p className="text-sm font-bold text-gray-900">Historial de liquidaciones</p>
          </div>
          {loadingLiq ? (
            <div className="py-8 text-center text-sm text-gray-400">Cargando…</div>
          ) : liquidaciones.length === 0 ? (
            <div className="py-8 text-center text-sm text-gray-400">Sin liquidaciones registradas</div>
          ) : (
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b bg-gray-50">
                  <th className="px-4 py-2.5 text-left text-xs font-semibold uppercase tracking-wide text-gray-500">Semana</th>
                  <th className="px-4 py-2.5 text-left text-xs font-semibold uppercase tracking-wide text-gray-500">Viajes</th>
                  <th className="px-4 py-2.5 text-right text-xs font-semibold uppercase tracking-wide text-gray-500">Neto</th>
                  <th className="px-4 py-2.5 text-left text-xs font-semibold uppercase tracking-wide text-gray-500">Estado</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-gray-100">
                {liquidaciones.map((l) => (
                  <tr key={l.id} className="hover:bg-gray-50 transition-colors">
                    <td className="px-4 py-3">
                      <p className="text-xs font-bold text-gray-900">{l.semanaKey}</p>
                      <p className="text-xs text-gray-400">{formatSemana(l.semanaKey)}</p>
                    </td>
                    <td className="px-4 py-3 text-sm text-gray-700">{l.totalViajes}</td>
                    <td className="px-4 py-3 text-right font-semibold text-gray-900">{fmt(l.netoAPagar)}</td>
                    <td className="px-4 py-3">
                      <span className={`text-xs font-semibold px-2 py-1 rounded-full ${
                        l.estado === 'pagado'
                          ? 'bg-green-100 text-green-700'
                          : 'bg-orange-100 text-orange-700'
                      }`}>
                        {l.estado === 'pagado' ? 'Pagado' : 'Pendiente'}
                      </span>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
      )}

      {!selectedMotoId && (
        <div className="flex flex-col items-center justify-center py-20 gap-3 text-gray-400">
          <Receipt className="h-12 w-12 opacity-25" />
          <p className="text-sm font-semibold">Selecciona un motorizado para ver sus liquidaciones</p>
        </div>
      )}
    </div>
  )
}

// ─── KpiCard helper ───────────────────────────────────────────────────────────

function KpiCard({ label, value, color }: { label: string; value: string; color: 'blue' | 'green' | 'gray' | 'red' | 'orange' }) {
  const styles = {
    blue: 'bg-blue-50 border-blue-200 text-[#004aad]',
    green: 'bg-green-50 border-green-200 text-green-700',
    gray: 'bg-gray-50 border-gray-200 text-gray-700',
    red: 'bg-red-50 border-red-200 text-red-700',
    orange: 'bg-orange-50 border-orange-200 text-orange-700',
  }
  return (
    <div className={`rounded-xl border px-3 py-2.5 ${styles[color]}`}>
      <p className="text-xs font-semibold opacity-60 mb-0.5">{label}</p>
      <p className="text-sm font-black">{value}</p>
    </div>
  )
}
