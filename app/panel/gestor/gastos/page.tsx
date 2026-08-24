'use client'

import { useEffect, useMemo, useRef, useState } from 'react'
import {
  collection,
  onSnapshot,
  query,
  where,
  orderBy,
  getDocs,
  Timestamp,
} from 'firebase/firestore'
import { auth, db } from '@/fb/config'
import { useModuleGuard } from '../../_hooks/useModuleGuard'
import { crearGastoMotorizado, anularGastoMotorizado } from '@/lib/financial-writes'
import {
  LABELS_TIPO_GASTO,
  type TipoGasto,
  type GastoMotorizado,
  type OrdenSnapshot,
} from '@/lib/financial-types'
import { Receipt, PlusCircle, XCircle, Search, X, ChevronDown, ChevronUp } from 'lucide-react'
import Link from 'next/link'
import { rutaOrden } from '@/lib/ruta-orden'

// ─── Types ────────────────────────────────────────────────────────────────────

type Motorizado = { id: string; authUid: string; nombre?: string }

type Gasto = GastoMotorizado & { id: string }

type OrdenOption = {
  id: string
  entregadoAt?: Timestamp
  createdAt?: Timestamp
  ownerSnapshot?: { companyName?: string; nombre?: string }
  entrega?: { nombreApellido?: string; direccionEscrita?: string }
  confirmacion?: { precioFinalCordobas?: number }
  tipoServicio?: string
  tipoEnvio?: string
  metodoEnvio?: string
  puntoRetiroNombre?: string
  zonaEntregaNombre?: string
  asignacion?: { motorizadoId?: string }
  fueraManagua?: {
    destinoFinal?: string | null
    puntoLogisticoNombre?: string | null
    metodoEnvio?: string | null
  }
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

const TIPOS_GASTO: TipoGasto[] = ['peaje_terminal', 'pago_cargotrans', 'otro_gasto_operativo']

function fmt(n: number) { return `C$ ${n.toLocaleString('es-NI')}` }

/** Fecha local YYYY-MM-DD sin usar UTC (evita mostrar el día siguiente en UTC-6) */
function todayLocal(): string {
  const d = new Date()
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}

function tsToDate(v: any): Date | null {
  if (!v) return null
  if (typeof v?.toDate === 'function') return v.toDate()
  if (v instanceof Date) return v
  return null
}

function fmtDate(v: any): string {
  const d = tsToDate(v)
  if (!d) return '—'
  return d.toLocaleDateString('es-NI', { day: '2-digit', month: 'short', year: 'numeric' })
}

function fmtOrdenLabel(o: OrdenOption): string {
  const comercio = o.ownerSnapshot?.companyName || o.ownerSnapshot?.nombre || ''
  const cliente = o.entrega?.nombreApellido ||
    (o.tipoServicio === 'fuera_managua' ? (o.fueraManagua?.destinoFinal || '') : '')
  const fecha = fmtDate(o.entregadoAt || o.createdAt)
  const precio = o.confirmacion?.precioFinalCordobas ? fmt(o.confirmacion.precioFinalCordobas) : ''
  return [comercio, cliente, fecha, precio].filter(Boolean).join(' · ')
}

const BADGE_TIPO: Record<TipoGasto, string> = {
  peaje_terminal: 'bg-orange-100 text-orange-700 border-orange-200',
  pago_cargotrans: 'bg-blue-100 text-blue-700 border-blue-200',
  otro_gasto_operativo: 'bg-gray-100 text-gray-700 border-gray-200',
}

// ─── OrdenSelector ────────────────────────────────────────────────────────────

function OrdenSelector({
  motorizadoId,
  value,
  onChange,
  fechaFiltro,
}: {
  motorizadoId: string
  value: OrdenOption | null
  onChange: (o: OrdenOption | null) => void
  fechaFiltro?: string   // YYYY-MM-DD local — filtra órdenes entregadas ese día
}) {
  const [ordenes, setOrdenes] = useState<OrdenOption[]>([])
  const [loading, setLoading] = useState(false)
  const [open, setOpen] = useState(false)
  const [busqueda, setBusqueda] = useState('')
  const inputRef = useRef<HTMLInputElement>(null)
  const containerRef = useRef<HTMLDivElement>(null)

  // Cargar órdenes del motorizado seleccionado
  useEffect(() => {
    if (!motorizadoId) { setOrdenes([]); return }
    setLoading(true)
    getDocs(
      query(
        collection(db, 'solicitudes_envio'),
        where('asignacion.motorizadoId', '==', motorizadoId),
        where('estado', '==', 'entregado')
      )
    ).then((snap) => {
      const list = snap.docs
        .map((d) => ({ id: d.id, ...(d.data() as any) } as OrdenOption))
        .sort((a, b) => (tsToDate(b.entregadoAt)?.getTime() ?? 0) - (tsToDate(a.entregadoAt)?.getTime() ?? 0))
      setOrdenes(list)
      setLoading(false)
    })
  }, [motorizadoId])

  // Cerrar al hacer click fuera
  useEffect(() => {
    function handler(e: MouseEvent) {
      if (containerRef.current && !containerRef.current.contains(e.target as Node)) {
        setOpen(false)
      }
    }
    document.addEventListener('mousedown', handler)
    return () => document.removeEventListener('mousedown', handler)
  }, [])

  // Órdenes filtradas por fecha seleccionada en el formulario
  const ordenesDeFecha = useMemo(() => {
    if (!fechaFiltro) return ordenes
    const [yyyy, mm, dd] = fechaFiltro.split('-').map(Number)
    return ordenes.filter((o) => {
      const d = tsToDate(o.entregadoAt)
      if (!d) return false
      return d.getFullYear() === yyyy && d.getMonth() + 1 === mm && d.getDate() === dd
    })
  }, [ordenes, fechaFiltro])

  const filtradas = useMemo(() => {
    if (!busqueda.trim()) return ordenesDeFecha.slice(0, 60)
    const q = busqueda.toLowerCase()
    return ordenesDeFecha.filter((o) => {
      const id = o.id.toLowerCase()
      const comercio = (o.ownerSnapshot?.companyName || o.ownerSnapshot?.nombre || '').toLowerCase()
      const cliente = (o.entrega?.nombreApellido || o.fueraManagua?.destinoFinal || '').toLowerCase()
      const dir = (o.entrega?.direccionEscrita || o.fueraManagua?.puntoLogisticoNombre || '').toLowerCase()
      const fecha = fmtDate(o.entregadoAt).toLowerCase()
      return id.includes(q) || comercio.includes(q) || cliente.includes(q) || dir.includes(q) || fecha.includes(q)
    }).slice(0, 60)
  }, [ordenesDeFecha, busqueda])

  if (!motorizadoId) {
    return (
      <div className="w-full border border-dashed border-gray-200 rounded-lg px-3 py-2.5 text-xs text-gray-400">
        Seleccioná un motorizado primero
      </div>
    )
  }

  return (
    <div ref={containerRef} className="relative">
      {/* Trigger */}
      <button
        type="button"
        onClick={() => { setOpen((v) => !v); setTimeout(() => inputRef.current?.focus(), 50) }}
        className="w-full border border-gray-200 rounded-lg px-3 py-2 text-sm text-left flex items-center gap-2 hover:bg-gray-50 transition focus:outline-none focus:ring-2 focus:ring-[#004aad]/30"
      >
        {value ? (
          <div className="flex-1 min-w-0">
            <p className="text-xs font-mono text-[#004aad] truncate">#{value.id.slice(0, 12)}</p>
            <p className="text-xs text-gray-500 truncate">{fmtOrdenLabel(value)}</p>
          </div>
        ) : (
          <span className="flex-1 text-gray-400 text-xs flex items-center gap-1.5">
            <Search className="h-3.5 w-3.5" />
            {loading ? 'Cargando órdenes…' : `Buscar entre ${ordenesDeFecha.length} órdenes entregadas`}
          </span>
        )}
        {value ? (
          <span
            onClick={(e) => { e.stopPropagation(); onChange(null) }}
            className="text-gray-400 hover:text-gray-600 cursor-pointer p-0.5"
          >
            <X className="h-3.5 w-3.5" />
          </span>
        ) : (
          <ChevronDown className="h-3.5 w-3.5 text-gray-400 shrink-0" />
        )}
      </button>

      {/* Dropdown */}
      {open && (
        <div className="absolute z-50 top-full left-0 right-0 mt-1 bg-white border border-gray-200 rounded-xl shadow-xl overflow-hidden">
          {/* Buscador */}
          <div className="p-2 border-b border-gray-100">
            <div className="flex items-center gap-2 bg-gray-50 border border-gray-200 rounded-lg px-3 py-1.5">
              <Search className="h-3.5 w-3.5 text-gray-400 shrink-0" />
              <input
                ref={inputRef}
                type="text"
                value={busqueda}
                onChange={(e) => setBusqueda(e.target.value)}
                placeholder="Buscar por ID, comercio, cliente, fecha…"
                className="flex-1 bg-transparent text-xs outline-none text-gray-700 placeholder:text-gray-400"
              />
              {busqueda && (
                <button onClick={() => setBusqueda('')} className="text-gray-400 hover:text-gray-600">
                  <X className="h-3 w-3" />
                </button>
              )}
            </div>
          </div>

          {/* Lista */}
          <div className="max-h-64 overflow-y-auto">
            {loading ? (
              <div className="py-6 text-center text-xs text-gray-400">Cargando…</div>
            ) : filtradas.length === 0 ? (
              <div className="py-6 text-center text-xs text-gray-400">Sin resultados</div>
            ) : (
              filtradas.map((o) => (
                <button
                  key={o.id}
                  type="button"
                  onClick={() => { onChange(o); setOpen(false); setBusqueda('') }}
                  className="w-full text-left px-3 py-2.5 hover:bg-blue-50 transition border-b border-gray-50 last:border-0"
                >
                  <div className="flex items-center gap-2">
                    <span className="font-mono text-[11px] text-[#004aad] shrink-0">#{o.id.slice(0, 10)}</span>
                    <span className="text-[11px] text-gray-400 shrink-0">{fmtDate(o.entregadoAt)}</span>
                    {o.confirmacion?.precioFinalCordobas && (
                      <span className="text-[11px] font-semibold text-gray-600 shrink-0">{fmt(o.confirmacion.precioFinalCordobas)}</span>
                    )}
                  </div>
                  <div className="flex items-center gap-2 mt-0.5">
                    {(o.ownerSnapshot?.companyName || o.ownerSnapshot?.nombre) && (
                      <span className="text-xs text-gray-700 font-medium truncate">
                        {o.ownerSnapshot?.companyName || o.ownerSnapshot?.nombre}
                      </span>
                    )}
                    {(o.entrega?.nombreApellido || (o.tipoServicio === 'fuera_managua' && o.fueraManagua?.destinoFinal)) && (
                      <span className="text-xs text-gray-500 truncate">
                        → {o.entrega?.nombreApellido || o.fueraManagua?.destinoFinal}
                      </span>
                    )}
                    {o.tipoServicio === 'fuera_managua' && (
                      <span className="text-[10px] bg-purple-100 text-purple-700 px-1.5 py-0.5 rounded-full font-semibold shrink-0">FM</span>
                    )}
                  </div>
                  {(o.entrega?.direccionEscrita || (o.tipoServicio === 'fuera_managua' && o.fueraManagua?.puntoLogisticoNombre)) && (
                    <p className="text-[11px] text-gray-400 truncate mt-0.5">
                      {o.entrega?.direccionEscrita || o.fueraManagua?.puntoLogisticoNombre}
                    </p>
                  )}
                </button>
              ))
            )}
          </div>
          <div className="px-3 py-1.5 border-t border-gray-100 text-[10px] text-gray-400">
            {filtradas.length} de {ordenesDeFecha.length} órdenes
          </div>
        </div>
      )}
    </div>
  )
}

// ─── Main ─────────────────────────────────────────────────────────────────────

export default function GastosPage() {
  const estadoGuardModulo = useModuleGuard('gastos')
  if (estadoGuardModulo !== 'autorizado') {
    return (
      <div className="w-full px-6 py-6 text-sm text-gray-600">
        {estadoGuardModulo === 'redirigiendo' ? 'Redirigiendo a tu panel...' : 'Validando permisos...'}
      </div>
    )
  }
  return <GastosPageContent />
}

function GastosPageContent() {
  const [motorizados, setMotorizados] = useState<Motorizado[]>([])
  const [gastos, setGastos] = useState<Gasto[]>([])
  const [loading, setLoading] = useState(true)

  // Formulario
  const [showForm, setShowForm] = useState(false)
  const [fMotorizadoId, setFMotorizadoId] = useState('')
  const [fTipo, setFTipo] = useState<TipoGasto>('peaje_terminal')
  const [fMonto, setFMonto] = useState('')
  const [fNota, setFNota] = useState('')
  const [fOrden, setFOrden] = useState<OrdenOption | null>(null)
  const [fFecha, setFFecha] = useState(todayLocal())
  const [saving, setSaving] = useState(false)
  const [err, setErr] = useState<string | null>(null)

  // Estado de anulación individual
  const [anulandoId, setAnulandoId] = useState<string | null>(null)
  const [anulError, setAnulError] = useState<string | null>(null)

  // Filtros
  const [filtroMoto, setFiltroMoto] = useState('todos')
  const [filtroTipo, setFiltroTipo] = useState<TipoGasto | 'todos'>('todos')
  const [filtroEstado, setFiltroEstado] = useState<'aprobado' | 'anulado' | 'todos'>('aprobado')

  // ── Queries ───────────────────────────────────────────────────────────────

  useEffect(() => {
    return onSnapshot(query(collection(db, 'motorizado')), (snap) => {
      setMotorizados(
        snap.docs
          .map((d) => ({ id: d.id, ...(d.data() as any) } as Motorizado))
          .sort((a, b) => (a.nombre || '').localeCompare(b.nombre || ''))
      )
    })
  }, [])

  useEffect(() => {
    return onSnapshot(
      query(collection(db, 'gastos_motorizado'), orderBy('createdAt', 'desc')),
      (snap) => {
        setGastos(snap.docs.map((d) => ({ id: d.id, ...(d.data() as any) } as Gasto)))
        setLoading(false)
      }
    )
  }, [])

  // ── Filtros ───────────────────────────────────────────────────────────────

  const gastosFiltrados = useMemo(() => gastos.filter((g) => {
    if (filtroMoto !== 'todos' && g.motorizadoId !== filtroMoto) return false
    if (filtroTipo !== 'todos' && g.tipo !== filtroTipo) return false
    if (filtroEstado !== 'todos' && g.estado !== filtroEstado) return false
    return true
  }), [gastos, filtroMoto, filtroTipo, filtroEstado])

  const totalFiltrado = useMemo(
    () => gastosFiltrados.filter((g) => g.estado === 'aprobado').reduce((s, g) => s + g.monto, 0),
    [gastosFiltrados]
  )

  const kpis = useMemo(() => {
    const aprobados = gastos.filter((g) => g.estado === 'aprobado')
    return {
      totalAprobado: aprobados.reduce((s, g) => s + g.monto, 0),
      countAprobado: aprobados.length,
      countAnulado: gastos.filter((g) => g.estado === 'anulado').length,
    }
  }, [gastos])

  // ── Crear gasto ───────────────────────────────────────────────────────────

  async function handleCrear() {
    const monto = parseFloat(fMonto)
    if (!fMotorizadoId || isNaN(monto) || monto <= 0) {
      setErr('Completá todos los campos requeridos.')
      return
    }
    const moto = motorizados.find((m) => m.id === fMotorizadoId)
    if (!moto) return

    // Construir snapshot de la orden seleccionada
    let ordenSnapshot: OrdenSnapshot | undefined
    if (fOrden) {
      ordenSnapshot = {
        ordenId: fOrden.id,
        comercioNombre: fOrden.ownerSnapshot?.companyName || fOrden.ownerSnapshot?.nombre || null,
        clienteNombre: fOrden.entrega?.nombreApellido ?? null,
        entregadoAt: fOrden.entregadoAt ?? null,
        tipoEnvio: fOrden.tipoEnvio ?? null,
        metodoEnvio: fOrden.metodoEnvio ?? null,
        puntoLogistico: fOrden.puntoRetiroNombre ?? null,
        precioDelivery: fOrden.confirmacion?.precioFinalCordobas ?? null,
      }
    }

    setSaving(true); setErr(null)
    try {
      await crearGastoMotorizado({
        motorizadoId: fMotorizadoId,
        motorizadoNombre: moto.nombre || moto.authUid,
        tipo: fTipo,
        monto,
        nota: fNota,
        ordenId: fOrden?.id,
        ordenSnapshot,
        operadorId: auth.currentUser?.uid ?? '',
        fecha: fFecha ? new Date(fFecha + 'T12:00:00') : undefined,
      })
      setFMonto(''); setFNota(''); setFOrden(null)
      setFFecha(todayLocal())
      setShowForm(false)
    } catch (e: any) {
      setErr(e?.message || 'Error al crear gasto')
    } finally {
      setSaving(false)
    }
  }

  // ── Anular gasto ──────────────────────────────────────────────────────────

  async function handleAnular(gasto: Gasto) {
    const ok = window.confirm(
      `¿Anular este gasto?\n\nTipo: ${LABELS_TIPO_GASTO[gasto.tipo]}\nMonto: ${fmt(gasto.monto)}\nMotorizado: ${gasto.motorizadoNombre}`
    )
    if (!ok) return

    setAnulandoId(gasto.id)
    setAnulError(null)

    try {
      const uid = auth.currentUser?.uid ?? ''
      await anularGastoMotorizado(gasto.id, uid)
    } catch (e: any) {
      console.error('[gastos] Error anulando gasto:', e)
      setAnulError(e?.message || 'Error al anular el gasto. Revisá la consola.')
    } finally {
      setAnulandoId(null)
    }
  }

  // ── Render ────────────────────────────────────────────────────────────────

  return (
    <div className="flex flex-col gap-4 max-w-4xl mx-auto">
      {/* Header */}
      <div className="flex items-start justify-between gap-3">
        <div>
          <h1 className="text-2xl font-black text-gray-900 tracking-tight flex items-center gap-2">
            <Receipt className="h-6 w-6 text-[#004aad]" />
            Gastos motorizado
          </h1>
          <p className="text-sm text-gray-500 mt-0.5">
            Gastos operativos vinculados a órdenes — peajes, Cargotrans y otros.
          </p>
        </div>
        <button
          onClick={() => setShowForm((v) => !v)}
          className="flex items-center gap-1.5 bg-[#004aad] text-white text-sm font-semibold px-4 py-2.5 rounded-xl hover:bg-[#0a49a4] transition shrink-0"
        >
          <PlusCircle className="h-4 w-4" />
          Nuevo gasto
        </button>
      </div>

      {/* KPIs */}
      <div className="grid grid-cols-3 gap-3">
        <div className="border rounded-xl px-4 py-3 bg-blue-50 border-blue-200">
          <p className="text-2xl font-black text-[#004aad]">{fmt(kpis.totalAprobado)}</p>
          <p className="text-xs font-semibold mt-0.5 text-blue-500">Total aprobado</p>
        </div>
        <div className="border rounded-xl px-4 py-3 bg-green-50 border-green-200">
          <p className="text-2xl font-black text-green-700">{kpis.countAprobado}</p>
          <p className="text-xs font-semibold mt-0.5 text-green-500">Aprobados</p>
        </div>
        <div className="border rounded-xl px-4 py-3 bg-gray-50 border-gray-200">
          <p className="text-2xl font-black text-gray-500">{kpis.countAnulado}</p>
          <p className="text-xs font-semibold mt-0.5 text-gray-400">Anulados</p>
        </div>
      </div>

      {/* Formulario */}
      {showForm && (
        <div className="bg-white rounded-xl border-2 border-[#004aad]/30 p-4 flex flex-col gap-3">
          <p className="text-sm font-bold text-gray-900">Registrar nuevo gasto operativo</p>

          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            <div>
              <label className="block text-xs font-semibold text-gray-500 mb-1">Motorizado *</label>
              <select
                value={fMotorizadoId}
                onChange={(e) => { setFMotorizadoId(e.target.value); setFOrden(null) }}
                className="w-full border border-gray-200 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-[#004aad]/30"
              >
                <option value="">— Seleccionar —</option>
                {motorizados.map((m) => (
                  <option key={m.id} value={m.id}>{m.nombre || m.authUid}</option>
                ))}
              </select>
            </div>

            <div>
              <label className="block text-xs font-semibold text-gray-500 mb-1">Tipo de gasto *</label>
              <select
                value={fTipo}
                onChange={(e) => setFTipo(e.target.value as TipoGasto)}
                className="w-full border border-gray-200 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-[#004aad]/30"
              >
                {TIPOS_GASTO.map((t) => (
                  <option key={t} value={t}>{LABELS_TIPO_GASTO[t]}</option>
                ))}
              </select>
            </div>

            <div>
              <label className="block text-xs font-semibold text-gray-500 mb-1">Monto (C$) *</label>
              <input
                type="number" min="0" step="0.01"
                value={fMonto}
                onChange={(e) => setFMonto(e.target.value)}
                placeholder="0.00"
                className="w-full border border-gray-200 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-[#004aad]/30"
              />
            </div>

            <div>
              <label className="block text-xs font-semibold text-gray-500 mb-1">Fecha</label>
              <input
                type="date" value={fFecha}
                onChange={(e) => { setFFecha(e.target.value); setFOrden(null) }}
                className="w-full border border-gray-200 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-[#004aad]/30"
              />
            </div>
          </div>

          {/* Selector de orden */}
          <div>
            <label className="block text-xs font-semibold text-gray-500 mb-1">
              Orden vinculada
              <span className="ml-1 text-gray-400 font-normal">(recomendado para peaje y Cargotrans)</span>
            </label>
            <OrdenSelector
              motorizadoId={fMotorizadoId}
              value={fOrden}
              onChange={setFOrden}
              fechaFiltro={fFecha}
            />
            {fOrden && (
              <div className="mt-1.5 bg-blue-50 border border-blue-100 rounded-lg px-3 py-2 text-xs text-blue-700 flex flex-wrap gap-x-3 gap-y-0.5">
                <span className="font-mono font-bold">#{fOrden.id.slice(0, 12)}</span>
                {(fOrden.ownerSnapshot?.companyName || fOrden.ownerSnapshot?.nombre) && (
                  <span>{fOrden.ownerSnapshot?.companyName || fOrden.ownerSnapshot?.nombre}</span>
                )}
                {fOrden.entrega?.nombreApellido && <span>→ {fOrden.entrega.nombreApellido}</span>}
                {fOrden.confirmacion?.precioFinalCordobas && (
                  <span className="font-semibold">{fmt(fOrden.confirmacion.precioFinalCordobas)}</span>
                )}
                <span className="text-blue-500">{fmtDate(fOrden.entregadoAt)}</span>
              </div>
            )}
          </div>

          <div>
            <label className="block text-xs font-semibold text-gray-500 mb-1">Nota</label>
            <input
              type="text" value={fNota}
              onChange={(e) => setFNota(e.target.value)}
              placeholder="Descripción del gasto"
              className="w-full border border-gray-200 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-[#004aad]/30"
            />
          </div>

          {err && (
            <p className="text-xs text-red-600 bg-red-50 border border-red-200 rounded-lg px-3 py-2">{err}</p>
          )}

          {/* Aviso sobre ajuste_manual y aporte_empresa */}
          <div className="text-xs text-amber-700 bg-amber-50 border border-amber-200 rounded-lg px-3 py-2">
            <p className="font-semibold mb-0.5">¿Necesitás registrar un ajuste manual o aporte empresa?</p>
            <p>Usá <strong>Saldos a cargo</strong> para ajustes contables, y <strong>Movimientos financieros</strong> para aportes de empresa al motorizado. Estos no son gastos operativos vinculables a una orden.</p>
          </div>

          <div className="flex gap-2">
            <button
              onClick={() => { setShowForm(false); setErr(null) }}
              disabled={saving}
              className="flex-1 border border-gray-200 text-gray-600 text-sm font-semibold py-2.5 rounded-xl hover:bg-gray-50 transition disabled:opacity-40"
            >
              Cancelar
            </button>
            <button
              onClick={handleCrear}
              disabled={saving || !fMotorizadoId || !fMonto}
              className="flex-1 bg-[#004aad] text-white text-sm font-semibold py-2.5 rounded-xl hover:bg-[#0a49a4] transition disabled:opacity-40 disabled:cursor-not-allowed"
            >
              {saving ? 'Guardando…' : '✓ Registrar gasto'}
            </button>
          </div>
        </div>
      )}

      {/* Filtros */}
      <div className="flex flex-wrap gap-2 items-center">
        <select
          value={filtroMoto}
          onChange={(e) => setFiltroMoto(e.target.value)}
          className="border border-gray-200 rounded-lg px-2 py-1.5 text-xs focus:outline-none focus:ring-2 focus:ring-[#004aad]/30"
        >
          <option value="todos">Todos los motorizados</option>
          {motorizados.map((m) => (
            <option key={m.id} value={m.id}>{m.nombre || m.authUid}</option>
          ))}
        </select>

        <select
          value={filtroTipo}
          onChange={(e) => setFiltroTipo(e.target.value as TipoGasto | 'todos')}
          className="border border-gray-200 rounded-lg px-2 py-1.5 text-xs focus:outline-none focus:ring-2 focus:ring-[#004aad]/30"
        >
          <option value="todos">Todos los tipos</option>
          {TIPOS_GASTO.map((t) => <option key={t} value={t}>{LABELS_TIPO_GASTO[t]}</option>)}
        </select>

        {(['todos', 'aprobado', 'anulado'] as const).map((e) => (
          <button key={e} onClick={() => setFiltroEstado(e)}
            className={`px-3 py-1 rounded-full text-xs font-semibold border transition ${filtroEstado === e ? 'bg-gray-900 text-white border-gray-900' : 'bg-white text-gray-600 border-gray-200 hover:bg-gray-50'}`}
          >
            {e === 'todos' ? 'Todos' : e === 'aprobado' ? 'Aprobados' : 'Anulados'}
          </button>
        ))}

        {gastosFiltrados.length > 0 && (
          <span className="ml-auto text-xs text-gray-500 font-semibold">
            {gastosFiltrados.length} gastos · {fmt(totalFiltrado)}
          </span>
        )}
      </div>

      {/* Error de anulación */}
      {anulError && (
        <div className="rounded-xl border border-red-200 bg-red-50 px-4 py-3 flex items-start justify-between gap-3">
          <p className="text-xs text-red-700 font-semibold">{anulError}</p>
          <button onClick={() => setAnulError(null)} className="text-red-400 hover:text-red-600 shrink-0 text-xs">✕</button>
        </div>
      )}

      {/* Tabla */}
      <div className="bg-white rounded-xl border border-gray-200 shadow-sm overflow-hidden">
        {loading ? (
          <div className="py-12 text-center text-sm text-gray-400">Cargando…</div>
        ) : gastosFiltrados.length === 0 ? (
          <div className="py-12 text-center text-sm text-gray-400">
            <Receipt className="h-10 w-10 opacity-20 mx-auto mb-2" />
            Sin gastos registrados
          </div>
        ) : (
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b bg-gray-50">
                <th className="px-4 py-2.5 text-left text-[11px] font-semibold uppercase tracking-wide text-gray-500">Fecha</th>
                <th className="px-4 py-2.5 text-left text-[11px] font-semibold uppercase tracking-wide text-gray-500">Motorizado</th>
                <th className="px-4 py-2.5 text-left text-[11px] font-semibold uppercase tracking-wide text-gray-500">Tipo</th>
                <th className="px-4 py-2.5 text-left text-[11px] font-semibold uppercase tracking-wide text-gray-500">Orden vinculada</th>
                <th className="px-4 py-2.5 text-left text-[11px] font-semibold uppercase tracking-wide text-gray-500">Nota</th>
                <th className="px-4 py-2.5 text-right text-[11px] font-semibold uppercase tracking-wide text-gray-500">Monto</th>
                <th className="px-4 py-2.5 text-left text-[11px] font-semibold uppercase tracking-wide text-gray-500">Estado</th>
                <th className="px-4 py-2.5" />
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-100">
              {gastosFiltrados.map((g) => (
                <tr key={g.id} className={`hover:bg-gray-50 transition-colors ${g.estado === 'anulado' ? 'opacity-50' : ''}`}>
                  <td className="px-4 py-2.5 text-xs text-gray-600">{fmtDate(g.fecha || g.createdAt)}</td>
                  <td className="px-4 py-2.5 text-xs font-semibold text-gray-800">{g.motorizadoNombre}</td>
                  <td className="px-4 py-2.5">
                    <span className={`inline-flex text-[11px] font-semibold px-2 py-0.5 rounded-full border ${BADGE_TIPO[g.tipo]}`}>
                      {LABELS_TIPO_GASTO[g.tipo]}
                    </span>
                  </td>
                  <td className="px-4 py-2.5 text-xs">
                    {/* B2.5 — un gasto atado a una orden concreta ahora lleva a
                        su ficha. Los gastos generales no tienen ordenId y siguen
                        mostrando "—": no se inventa un destino. */}
                    {g.ordenSnapshot ? (
                      <div>
                        {rutaOrden(g.ordenSnapshot.ordenId) ? (
                          <Link
                            href={rutaOrden(g.ordenSnapshot.ordenId)!}
                            title={`Ver ficha completa · ${g.ordenSnapshot.ordenId}`}
                            className="font-mono text-[#004aad] hover:underline"
                          >
                            #{g.ordenSnapshot.ordenId.slice(0, 10)}
                          </Link>
                        ) : (
                          <p className="font-mono text-[#004aad]">#{g.ordenSnapshot.ordenId.slice(0, 10)}</p>
                        )}
                        {g.ordenSnapshot.comercioNombre && (
                          <p className="text-gray-500 text-[11px]">{g.ordenSnapshot.comercioNombre}</p>
                        )}
                        {g.ordenSnapshot.clienteNombre && (
                          <p className="text-gray-400 text-[11px]">→ {g.ordenSnapshot.clienteNombre}</p>
                        )}
                      </div>
                    ) : g.ordenId ? (
                      rutaOrden(g.ordenId) ? (
                        <Link
                          href={rutaOrden(g.ordenId)!}
                          title={`Ver ficha completa · ${g.ordenId}`}
                          className="font-mono text-[11px] text-blue-600 hover:underline"
                        >
                          #{g.ordenId.slice(0, 10)}
                        </Link>
                      ) : (
                        <span className="font-mono text-[11px] text-gray-500">#{g.ordenId.slice(0, 10)}</span>
                      )
                    ) : (
                      <span className="text-[11px] text-gray-300">—</span>
                    )}
                  </td>
                  <td className="px-4 py-2.5 text-xs text-gray-500 max-w-[160px] truncate" title={g.nota}>
                    {g.nota || '—'}
                  </td>
                  <td className="px-4 py-2.5 text-right font-semibold text-gray-900 text-xs">{fmt(g.monto)}</td>
                  <td className="px-4 py-2.5">
                    <span className={`inline-flex text-[11px] font-semibold px-2 py-0.5 rounded-full ${g.estado === 'aprobado' ? 'bg-green-100 text-green-700' : 'bg-gray-100 text-gray-500'}`}>
                      {g.estado === 'aprobado' ? 'Aprobado' : 'Anulado'}
                    </span>
                  </td>
                  <td className="px-4 py-2.5">
                    {g.estado === 'aprobado' && (
                      <button
                        onClick={() => handleAnular(g)}
                        disabled={anulandoId === g.id}
                        className="text-[11px] font-semibold text-red-400 hover:text-red-600 hover:bg-red-50 px-2 py-0.5 rounded transition flex items-center gap-1 disabled:opacity-40 disabled:cursor-not-allowed"
                      >
                        <XCircle className="h-3 w-3" />
                        {anulandoId === g.id ? 'Anulando…' : 'Anular'}
                      </button>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>

      <div className="text-xs text-gray-400 bg-gray-50 border border-gray-100 rounded-xl px-4 py-3">
        <p className="font-semibold text-gray-500 mb-1">Sobre los tipos de gasto</p>
        <ul className="list-disc list-inside space-y-0.5">
          <li><strong>Peaje terminal / Cargotrans / Otro operativo</strong> — reducen el delivery a depositar a Storkhub. Vinculables a una orden.</li>
          <li><strong>Ajuste manual</strong> — usá <em>Saldos a cargo</em> con tipo "ajuste_manual".</li>
          <li><strong>Aporte empresa</strong> — registralo en <em>Movimientos financieros</em> como egreso de caja.</li>
        </ul>
      </div>
    </div>
  )
}
