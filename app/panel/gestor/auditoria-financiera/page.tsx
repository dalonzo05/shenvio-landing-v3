'use client'

import { useCallback, useEffect, useMemo, useState, Fragment } from 'react'
import {
  collection,
  getDocs,
  query,
  where,
  Timestamp,
} from 'firebase/firestore'
import { db } from '@/fb/config'
import {
  ShieldCheck,
  AlertTriangle,
  RefreshCw,
  ChevronDown,
  ChevronUp,
  Search,
  CheckCircle2,
  XCircle,
  Minus,
} from 'lucide-react'
import type { MovimientoFinanciero } from '@/lib/financial-types'
import {
  calcularDeudaOperativaMotorizado,
  calcularEfectivoEnPoderMotorizado,
  calcularComisionPendienteMotorizado,
  calcularResumenCobertura,
  movimientosSinCuentas,
  movimientosHuerfanos,
  movimientosConCoberturaPendiente,
  calcularTodosLosBalances,
} from '@/lib/financial-ledger'

// ─── Types ────────────────────────────────────────────────────────────────────

type Motorizado = {
  id: string
  authUid: string
  nombre?: string
  estado?: string
}

type SaldoCargo = {
  id: string
  motorizadoId: string
  motorizadoNombre: string
  saldoPendiente: number
  estado: string
}

type DepositoPendiente = {
  id: string
  motorizadoUid: string
  motorizadoNombre: string
  montoTotal: number
  estado: string
  destinatario: string
  creadoAt?: Timestamp
}

type Movimiento = MovimientoFinanciero & { id: string }

type Tab = 'resumen' | 'motorizados' | 'movimientos' | 'issues'

// ─── Formato ──────────────────────────────────────────────────────────────────

function fmt(n: number) {
  const sign = n < 0 ? '-' : ''
  return `${sign}C$ ${Math.abs(n).toLocaleString('es-NI', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`
}

function fmtFecha(v: unknown): string {
  if (!v) return '—'
  const d = typeof (v as any)?.toDate === 'function' ? (v as any).toDate() : null
  if (!d) return '—'
  return d.toLocaleString('es-NI', { day: '2-digit', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' })
}

function fmtFechaCorta(v: unknown): string {
  if (!v) return '—'
  const d = typeof (v as any)?.toDate === 'function' ? (v as any).toDate() : null
  if (!d) return '—'
  return d.toLocaleDateString('es-NI', { day: '2-digit', month: 'short', year: 'numeric' })
}

const UMBRAL_DIFERENCIA = 0.01 // diferencia mínima para marcar como discrepancia

function diffColor(diff: number) {
  if (Math.abs(diff) < UMBRAL_DIFERENCIA) return { bg: '#f0fdf4', text: '#16a34a', icon: <CheckCircle2 size={13} /> }
  return { bg: '#fef2f2', text: '#dc2626', icon: <AlertTriangle size={13} /> }
}

// ─── Componentes menores ──────────────────────────────────────────────────────

function KpiCard({ label, value, sub, accent = '#004aad', warn = false }: {
  label: string; value: string | number; sub?: string; accent?: string; warn?: boolean
}) {
  return (
    <div className={`rounded-xl border p-4 ${warn && Number(value) > 0 ? 'border-amber-200 bg-amber-50' : 'border-gray-200 bg-white'}`}>
      <p className="text-xs font-semibold uppercase tracking-wide text-gray-500">{label}</p>
      <p className="mt-1 text-2xl font-black" style={{ color: warn && Number(value) > 0 ? '#d97706' : accent }}>
        {value}
      </p>
      {sub && <p className="mt-0.5 text-xs text-gray-400">{sub}</p>}
    </div>
  )
}

function Badge({ ok, label }: { ok: boolean; label: string }) {
  return (
    <span className={`inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[11px] font-semibold ${ok ? 'bg-green-100 text-green-700' : 'bg-red-100 text-red-700'}`}>
      {ok ? <CheckCircle2 size={11} /> : <XCircle size={11} />}
      {label}
    </span>
  )
}

const thCls = 'px-3 py-2 text-left text-[11px] font-semibold uppercase tracking-wide text-gray-500 whitespace-nowrap'
const tdCls = 'px-3 py-2.5 text-xs text-gray-700'

// ─── Page ─────────────────────────────────────────────────────────────────────

export default function AuditoriaFinancieraPage() {
  const [tab, setTab] = useState<Tab>('resumen')
  const [loading, setLoading] = useState(true)
  const [loadedAt, setLoadedAt] = useState<Date | null>(null)

  // ── Datos brutos ──────────────────────────────────────────────────────────
  const [movimientos, setMovimientos] = useState<Movimiento[]>([])
  const [motorizados, setMotorizados] = useState<Motorizado[]>([])
  const [saldos, setSaldos] = useState<SaldoCargo[]>([])
  const [depositosPendientes, setDepositosPendientes] = useState<DepositoPendiente[]>([])

  // ── Filtros ───────────────────────────────────────────────────────────────
  const [filtroMotorizado, setFiltroMotorizado] = useState<string>('todos')
  const [soloDiferencias, setSoloDiferencias] = useState(false)
  const [soloHuerfanos, setSoloHuerfanos] = useState(false)
  const [soloSinCuentas, setSoloSinCuentas] = useState(false)
  const [busquedaMov, setBusquedaMov] = useState('')
  const [movsExpandidos, setMovsExpandidos] = useState<Set<string>>(new Set())
  const toggleMovExpand = (id: string) =>
    setMovsExpandidos((prev) => { const s = new Set(prev); s.has(id) ? s.delete(id) : s.add(id); return s })

  // ── Filtro de fecha para la tabla de movimientos ──────────────────────────
  const [desde, setDesde] = useState<string>(() => {
    const d = new Date(); d.setDate(d.getDate() - 90)
    return d.toISOString().slice(0, 10)
  })
  const [hasta, setHasta] = useState<string>(() => new Date().toISOString().slice(0, 10))

  // ─── Carga de datos ────────────────────────────────────────────────────────

  const cargarDatos = useCallback(async () => {
    setLoading(true)
    try {
      const [movsSnap, motSnap, saldosSnap, depSnap] = await Promise.all([
        getDocs(collection(db, 'movimientos_financieros')),
        getDocs(collection(db, 'motorizado')),
        getDocs(query(
          collection(db, 'saldos_cargo_motorizado'),
          where('estado', 'in', ['pendiente', 'abonado_parcial']),
        )),
        getDocs(query(
          collection(db, 'ordenes_deposito'),
          where('confirmadoGestor', '==', false),
        )),
      ])

      setMovimientos(
        movsSnap.docs.map((d) => ({ id: d.id, ...(d.data() as MovimientoFinanciero) })),
      )
      setMotorizados(
        motSnap.docs.map((d) => {
          const data = d.data() as any
          return { id: d.id, authUid: data.authUid ?? '', nombre: data.nombre ?? data.email ?? d.id, estado: data.estado }
        }),
      )
      setSaldos(
        saldosSnap.docs.map((d) => {
          const data = d.data() as any
          return {
            id: d.id,
            motorizadoId: data.motorizadoId,
            motorizadoNombre: data.motorizadoNombre ?? '',
            saldoPendiente: data.saldoPendiente ?? 0,
            estado: data.estado,
          }
        }),
      )
      setDepositosPendientes(
        depSnap.docs.map((d) => {
          const data = d.data() as any
          return {
            id: d.id,
            motorizadoUid: data.motorizadoUid ?? '',
            motorizadoNombre: data.motorizadoNombre ?? '',
            montoTotal: data.montoTotal ?? 0,
            estado: data.estado ?? 'en_revision',
            destinatario: data.destinatario ?? '—',
            creadoAt: data.creadoAt,
          }
        }),
      )
      setLoadedAt(new Date())
    } catch (err) {
      console.error('[auditoria] Error cargando datos:', err)
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => { cargarDatos() }, [cargarDatos])

  // ─── Resumen de cobertura ─────────────────────────────────────────────────

  const cobertura = useMemo(() => calcularResumenCobertura(movimientos), [movimientos])

  // ─── Auditoría por motorizado ─────────────────────────────────────────────

  const auditMotorizados = useMemo(() => {
    // Saldos agrupados por motorizadoId
    const saldosPorMot: Record<string, number> = {}
    saldos.forEach((s) => {
      saldosPorMot[s.motorizadoId] = (saldosPorMot[s.motorizadoId] ?? 0) + s.saldoPendiente
    })

    // Depósitos pendientes agrupados por motorizadoUid
    const depsPorUid: Record<string, number> = {}
    depositosPendientes.forEach((d) => {
      depsPorUid[d.motorizadoUid] = (depsPorUid[d.motorizadoUid] ?? 0) + d.montoTotal
    })

    return motorizados.map((mot) => {
      const deudaLedger = calcularDeudaOperativaMotorizado(movimientos, mot.id)
      const efectivoLedger = calcularEfectivoEnPoderMotorizado(movimientos, mot.id)
      const comisionLedger = calcularComisionPendienteMotorizado(movimientos, mot.id)
      const deudaOperativa = saldosPorMot[mot.id] ?? 0
      const deposPendientes = depsPorUid[mot.authUid] ?? 0
      const deudaDiff = deudaLedger - deudaOperativa

      return {
        mot,
        deudaLedger,
        efectivoLedger,
        comisionLedger,
        deudaOperativa,
        deposPendientes,
        deudaDiff,
        tieneDiferencia: Math.abs(deudaDiff) >= UMBRAL_DIFERENCIA,
      }
    }).sort((a, b) => Math.abs(b.deudaDiff) - Math.abs(a.deudaDiff))
  }, [motorizados, movimientos, saldos, depositosPendientes])

  const auditFiltrado = useMemo(() => {
    let list = auditMotorizados
    if (filtroMotorizado !== 'todos')
      list = list.filter((r) => r.mot.id === filtroMotorizado)
    if (soloDiferencias)
      list = list.filter((r) => r.tieneDiferencia)
    return list
  }, [auditMotorizados, filtroMotorizado, soloDiferencias])

  // ─── Filtrado de movimientos ──────────────────────────────────────────────

  const movsFiltrados = useMemo(() => {
    const desdeMs = new Date(desde + 'T00:00:00').getTime()
    const hastaMs = new Date(hasta + 'T23:59:59').getTime()
    const busq = busquedaMov.toLowerCase().trim()

    return movimientos.filter((m) => {
      // Filtro de fecha
      const at = (m.at as any)?.toDate?.()
      if (at) {
        const ms = at.getTime()
        if (ms < desdeMs || ms > hastaMs) return false
      }

      // Filtros de estado
      if (soloHuerfanos) {
        const esHuerfano =
          !m.solicitudId && !m.depositoId && !m.motorizadoId &&
          !m.comercioId && !m.saldoId && !m.gastoId && !m.liquidacionId
        if (!esHuerfano) return false
      }
      if (soloSinCuentas) {
        if (m.cuentaOrigen || m.cuentaDestino) return false
      }

      // Filtro de motorizado
      if (filtroMotorizado !== 'todos') {
        const mot = motorizados.find((x) => x.id === filtroMotorizado)
        if (mot && m.motorizadoId !== mot.id && m.motorizadoId !== mot.authUid) return false
      }

      // Búsqueda libre
      if (busq) {
        const texto = [m.tipo, m.descripcion, m.cuentaOrigen, m.cuentaDestino, m.solicitudId, m.depositoId].join(' ').toLowerCase()
        if (!texto.includes(busq)) return false
      }

      return true
    }).sort((a, b) => {
      const ta = (a.at as any)?.toMillis?.() ?? 0
      const tb = (b.at as any)?.toMillis?.() ?? 0
      return tb - ta
    })
  }, [movimientos, desde, hasta, soloHuerfanos, soloSinCuentas, filtroMotorizado, motorizados, busquedaMov])

  // ─── Issues ───────────────────────────────────────────────────────────────

  const issues = useMemo(() => ({
    sinCuentas: movimientosSinCuentas(movimientos),
    huerfanos: movimientosHuerfanos(movimientos),
    coberturaPendiente: movimientosConCoberturaPendiente(movimientos),
  }), [movimientos])

  // ─── Balance sheet general ────────────────────────────────────────────────

  const balanceSheet = useMemo(() => {
    const map = calcularTodosLosBalances(movimientos)
    return [...map.entries()]
      .filter(([, bal]) => Math.abs(bal) > 0.01)
      .sort((a, b) => Math.abs(b[1]) - Math.abs(a[1]))
  }, [movimientos])

  // ─── Render ───────────────────────────────────────────────────────────────

  return (
    <div className="flex flex-col gap-5 pb-8">
      {/* Header */}
      <div className="flex items-start justify-between">
        <div>
          <h1 className="text-2xl font-black tracking-tight text-gray-900 flex items-center gap-2">
            <ShieldCheck size={22} className="text-[#004aad]" />
            Auditoría financiera
          </h1>
          <p className="mt-0.5 text-sm text-gray-500">
            Solo lectura — compara el ledger con los datos operativos. No modifica nada.
          </p>
          {loadedAt && (
            <p className="text-xs text-gray-400 mt-0.5">
              Datos cargados: {loadedAt.toLocaleTimeString('es-NI')}
            </p>
          )}
        </div>
        <button
          onClick={cargarDatos}
          disabled={loading}
          className="flex items-center gap-2 rounded-xl border border-gray-200 bg-white px-4 py-2 text-sm font-semibold text-gray-700 shadow-sm hover:bg-gray-50 disabled:opacity-50 transition"
        >
          <RefreshCw size={14} className={loading ? 'animate-spin' : ''} />
          Recargar
        </button>
      </div>

      {loading && (
        <div className="rounded-xl border border-gray-200 bg-white py-12 text-center text-sm text-gray-400">
          Cargando datos del ledger…
        </div>
      )}

      {!loading && (
        <>
          {/* Filtros globales */}
          <div className="flex flex-wrap items-center gap-3 rounded-xl border border-gray-200 bg-white p-3">
            <div className="flex items-center gap-2">
              <Search size={14} className="text-gray-400" />
              <select
                value={filtroMotorizado}
                onChange={(e) => setFiltroMotorizado(e.target.value)}
                className="text-sm border border-gray-200 rounded-lg px-3 py-1.5 text-gray-700 bg-white focus:outline-none focus:ring-2 focus:ring-[#004aad]/20"
              >
                <option value="todos">Todos los motorizados</option>
                {motorizados.map((m) => (
                  <option key={m.id} value={m.id}>{m.nombre}</option>
                ))}
              </select>
            </div>

            <label className="flex items-center gap-2 text-sm text-gray-700 cursor-pointer select-none">
              <input
                type="checkbox"
                checked={soloDiferencias}
                onChange={(e) => setSoloDiferencias(e.target.checked)}
                className="rounded"
              />
              Solo diferencias
            </label>

            <label className="flex items-center gap-2 text-sm text-gray-700 cursor-pointer select-none">
              <input
                type="checkbox"
                checked={soloHuerfanos}
                onChange={(e) => setSoloHuerfanos(e.target.checked)}
                className="rounded"
              />
              Solo huérfanos
            </label>

            <label className="flex items-center gap-2 text-sm text-gray-700 cursor-pointer select-none">
              <input
                type="checkbox"
                checked={soloSinCuentas}
                onChange={(e) => setSoloSinCuentas(e.target.checked)}
                className="rounded"
              />
              Sin cuentas
            </label>
          </div>

          {/* Tabs */}
          <div className="flex gap-1 rounded-xl border border-gray-200 bg-gray-100 p-1 w-fit">
            {([
              ['resumen', 'Resumen'],
              ['motorizados', `Motorizados (${motorizados.length})`],
              ['movimientos', `Movimientos (${movimientos.length})`],
              ['issues', `Issues (${issues.sinCuentas.length + issues.huerfanos.length})`],
            ] as const).map(([t, label]) => (
              <button
                key={t}
                onClick={() => setTab(t as Tab)}
                className={`rounded-lg px-4 py-1.5 text-sm font-semibold transition ${
                  tab === t ? 'bg-white shadow-sm text-gray-900' : 'text-gray-500 hover:text-gray-700'
                }`}
              >
                {label}
              </button>
            ))}
          </div>

          {/* ── Tab: Resumen ────────────────────────────────────────────────── */}
          {tab === 'resumen' && (
            <div className="flex flex-col gap-5">
              {/* KPIs cobertura */}
              <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
                <KpiCard label="Total movimientos" value={cobertura.total} sub="activos (excl. anulados)" />
                <KpiCard
                  label="Cobertura doble entrada"
                  value={`${cobertura.porcentajeCoberturaDobleEntrada}%`}
                  sub={`${cobertura.conCuentas} con cuentas`}
                  accent={cobertura.porcentajeCoberturaDobleEntrada >= 80 ? '#16a34a' : '#d97706'}
                />
                <KpiCard label="Sin cuentas" value={cobertura.sinCuentas} sub="sin origen ni destino" warn />
                <KpiCard label="Huérfanos" value={cobertura.huerfanos} sub="sin referencias operacionales" warn />
              </div>

              {/* KPIs auditoría */}
              <div className="grid grid-cols-2 gap-3 sm:grid-cols-3">
                <KpiCard
                  label="Motorizados con diferencia"
                  value={auditMotorizados.filter((r) => r.tieneDiferencia).length}
                  sub={`de ${motorizados.length} totales`}
                  warn
                />
                <KpiCard
                  label="Depósitos pendientes"
                  value={depositosPendientes.length}
                  sub="no confirmados por gestor"
                />
                <KpiCard
                  label="Saldos a cargo activos"
                  value={saldos.length}
                  sub="pendiente + abonado_parcial"
                />
              </div>

              {/* Balance sheet general */}
              {balanceSheet.length > 0 && (
                <div className="rounded-xl border border-gray-200 bg-white overflow-hidden">
                  <div className="px-4 py-3 border-b border-gray-100">
                    <h2 className="text-sm font-bold text-gray-900">Balance sheet del ledger</h2>
                    <p className="text-xs text-gray-400 mt-0.5">Saldo de cada cuenta según movimientos_financieros (positivo = a favor)</p>
                  </div>
                  <div className="overflow-x-auto">
                    <table className="w-full text-sm">
                      <thead className="bg-gray-50 border-b border-gray-200">
                        <tr>
                          <th className={thCls}>Cuenta</th>
                          <th className={`${thCls} text-right`}>Saldo</th>
                        </tr>
                      </thead>
                      <tbody className="divide-y divide-gray-100">
                        {balanceSheet.map(([cuenta, saldo]) => (
                          <tr key={cuenta} className="hover:bg-gray-50">
                            <td className={`${tdCls} font-mono text-xs`}>{cuenta}</td>
                            <td className={`${tdCls} text-right font-semibold ${saldo >= 0 ? 'text-green-700' : 'text-red-700'}`}>
                              {fmt(saldo)}
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                </div>
              )}
            </div>
          )}

          {/* ── Tab: Motorizados ────────────────────────────────────────────── */}
          {tab === 'motorizados' && (
            <div className="rounded-xl border border-gray-200 bg-white overflow-hidden">
              <div className="px-4 py-3 border-b border-gray-100 flex items-center justify-between">
                <div>
                  <h2 className="text-sm font-bold text-gray-900">Comparación por motorizado</h2>
                  <p className="text-xs text-gray-400 mt-0.5">
                    Ledger = derivado de movimientos_financieros · Operativo = datos almacenados
                  </p>
                </div>
                <span className={`text-xs font-semibold rounded-full px-2.5 py-1 ${
                  auditFiltrado.filter((r) => r.tieneDiferencia).length === 0
                    ? 'bg-green-100 text-green-700'
                    : 'bg-red-100 text-red-700'
                }`}>
                  {auditFiltrado.filter((r) => r.tieneDiferencia).length} diferencias
                </span>
              </div>
              <div className="overflow-x-auto">
                <table className="w-full text-sm">
                  <thead className="bg-gray-50 border-b border-gray-200">
                    <tr>
                      <th className={thCls}>Motorizado</th>
                      <th className={`${thCls} text-right`}>Deuda (ledger)</th>
                      <th className={`${thCls} text-right`}>Deuda (operativo)</th>
                      <th className={`${thCls} text-right`}>Diferencia</th>
                      <th className={`${thCls} text-right`}>Efectivo (ledger)</th>
                      <th className={`${thCls} text-right`}>Deps. pendientes</th>
                      <th className={`${thCls} text-right`}>Comisión (ledger)</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-gray-100">
                    {auditFiltrado.length === 0 && (
                      <tr>
                        <td colSpan={7} className="px-4 py-8 text-center text-sm text-gray-400">
                          {soloDiferencias ? 'No se detectaron diferencias ✓' : 'Sin datos'}
                        </td>
                      </tr>
                    )}
                    {auditFiltrado.map(({ mot, deudaLedger, efectivoLedger, comisionLedger, deudaOperativa, deposPendientes, deudaDiff, tieneDiferencia }) => {
                      const dc = diffColor(deudaDiff)
                      return (
                        <tr key={mot.id} className={`hover:bg-gray-50 ${tieneDiferencia ? 'bg-red-50/30' : ''}`}>
                          <td className={tdCls}>
                            <div className="flex flex-col">
                              <span className="font-semibold text-gray-900">{mot.nombre}</span>
                              <span className="font-mono text-[10px] text-gray-400">{mot.id}</span>
                            </div>
                          </td>
                          <td className={`${tdCls} text-right font-mono`}>
                            {deudaLedger === 0
                              ? <span className="text-gray-300">—</span>
                              : <span className={deudaLedger > 0 ? 'text-red-700' : 'text-green-700'}>{fmt(deudaLedger)}</span>}
                          </td>
                          <td className={`${tdCls} text-right font-mono`}>
                            {deudaOperativa === 0
                              ? <span className="text-gray-300">—</span>
                              : <span className="text-red-700">{fmt(deudaOperativa)}</span>}
                          </td>
                          <td className={`${tdCls} text-right`}>
                            <span
                              className="inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-xs font-semibold"
                              style={{ background: dc.bg, color: dc.text }}
                            >
                              {dc.icon}
                              {Math.abs(deudaDiff) < UMBRAL_DIFERENCIA ? '✓' : fmt(deudaDiff)}
                            </span>
                          </td>
                          <td className={`${tdCls} text-right font-mono`}>
                            {efectivoLedger === 0
                              ? <span className="text-gray-300">—</span>
                              : <span className="text-blue-700">{fmt(efectivoLedger)}</span>}
                          </td>
                          <td className={`${tdCls} text-right font-mono`}>
                            {deposPendientes === 0
                              ? <span className="text-gray-300">—</span>
                              : <span className="text-purple-700">{fmt(deposPendientes)}</span>}
                          </td>
                          <td className={`${tdCls} text-right font-mono`}>
                            {comisionLedger === 0
                              ? <span className="text-gray-300">—</span>
                              : <span className={comisionLedger > 0 ? 'text-green-700' : 'text-red-700'}>{fmt(comisionLedger)}</span>}
                          </td>
                        </tr>
                      )
                    })}
                  </tbody>
                </table>
              </div>
              {/* Leyenda */}
              <div className="px-4 py-3 border-t border-gray-100 bg-gray-50">
                <p className="text-xs text-gray-400">
                  <strong>Diferencia</strong> = Deuda (ledger) − Deuda (operativo). &nbsp;
                  <strong>Deps. pendientes</strong> = montoTotal en ordenes_deposito no confirmadas. &nbsp;
                  <span className="text-amber-600">⚠ En Fase 1 el ledger tiene cobertura parcial — diferencias ≠ errores necesariamente.</span>
                </p>
              </div>
            </div>
          )}

          {/* ── Tab: Movimientos ────────────────────────────────────────────── */}
          {tab === 'movimientos' && (
            <div className="flex flex-col gap-3">
              {/* Filtros de fecha + búsqueda */}
              <div className="flex flex-wrap gap-3 items-center rounded-xl border border-gray-200 bg-white p-3">
                <div className="flex items-center gap-2">
                  <label className="text-xs font-semibold text-gray-500 uppercase tracking-wide">Desde</label>
                  <input
                    type="date"
                    value={desde}
                    onChange={(e) => setDesde(e.target.value)}
                    className="rounded-lg border border-gray-200 px-3 py-1.5 text-sm text-gray-700 focus:outline-none focus:ring-2 focus:ring-[#004aad]/20"
                  />
                </div>
                <div className="flex items-center gap-2">
                  <label className="text-xs font-semibold text-gray-500 uppercase tracking-wide">Hasta</label>
                  <input
                    type="date"
                    value={hasta}
                    onChange={(e) => setHasta(e.target.value)}
                    className="rounded-lg border border-gray-200 px-3 py-1.5 text-sm text-gray-700 focus:outline-none focus:ring-2 focus:ring-[#004aad]/20"
                  />
                </div>
                <div className="flex-1 flex items-center gap-2">
                  <Search size={14} className="text-gray-400 shrink-0" />
                  <input
                    type="text"
                    placeholder="Buscar por tipo, descripción, cuenta, ID…"
                    value={busquedaMov}
                    onChange={(e) => setBusquedaMov(e.target.value)}
                    className="w-full rounded-lg border border-gray-200 px-3 py-1.5 text-sm text-gray-700 focus:outline-none focus:ring-2 focus:ring-[#004aad]/20"
                  />
                </div>
                <span className="text-xs text-gray-400 shrink-0">
                  {movsFiltrados.length} resultado{movsFiltrados.length !== 1 ? 's' : ''}
                </span>
              </div>

              <div className="rounded-xl border border-gray-200 bg-white overflow-hidden">
                <div className="overflow-x-auto">
                  <table className="w-full text-sm">
                    <thead className="bg-gray-50 border-b border-gray-200">
                      <tr>
                        <th className={thCls}>Fecha</th>
                        <th className={thCls}>Tipo</th>
                        <th className={`${thCls} text-right`}>Monto</th>
                        <th className={thCls}>Origen</th>
                        <th className={thCls}>Destino</th>
                        <th className={thCls}>Estado</th>
                        <th className={thCls}></th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-gray-100">
                      {movsFiltrados.length === 0 && (
                        <tr>
                          <td colSpan={7} className="px-4 py-8 text-center text-sm text-gray-400">
                            No hay movimientos con los filtros actuales
                          </td>
                        </tr>
                      )}
                      {movsFiltrados.slice(0, 200).map((m) => {
                        const sinCuentas = !m.cuentaOrigen && !m.cuentaDestino
                        const esHuerfano = !m.solicitudId && !m.depositoId && !m.motorizadoId && !m.comercioId && !m.saldoId && !m.gastoId && !m.liquidacionId
                        const isExpanded = movsExpandidos.has(m.id)
                        return (
                          <Fragment key={m.id}>
                            <tr
                              className={`hover:bg-gray-50 cursor-pointer ${sinCuentas ? 'bg-amber-50/40' : ''} ${esHuerfano ? 'bg-red-50/30' : ''}`}
                              onClick={() => toggleMovExpand(m.id)}
                            >
                              <td className={`${tdCls} whitespace-nowrap`}>{fmtFechaCorta(m.at)}</td>
                              <td className={tdCls}>
                                <span className="inline-flex items-center gap-1">
                                  <code className="rounded bg-gray-100 px-1.5 py-0.5 text-[11px] text-gray-700">{m.tipo}</code>
                                  {sinCuentas && <span title="Sin cuentas" className="text-amber-500"><AlertTriangle size={11} /></span>}
                                  {esHuerfano && <span title="Sin referencias" className="text-red-500"><XCircle size={11} /></span>}
                                </span>
                              </td>
                              <td className={`${tdCls} text-right font-semibold font-mono`}>
                                <span className="text-green-700">{fmt(m.monto)}</span>
                              </td>
                              <td className={`${tdCls} font-mono text-[11px]`}>
                                {m.cuentaOrigen
                                  ? <span className="text-gray-600">{m.cuentaOrigen}</span>
                                  : <span className="text-gray-300">—</span>}
                              </td>
                              <td className={`${tdCls} font-mono text-[11px]`}>
                                {m.cuentaDestino
                                  ? <span className="text-gray-600">{m.cuentaDestino}</span>
                                  : <span className="text-gray-300">—</span>}
                              </td>
                              <td className={tdCls}>
                                <span className={`rounded-full px-2 py-0.5 text-[11px] font-semibold ${
                                  m.estado === 'anulado' ? 'bg-gray-100 text-gray-500' : 'bg-green-100 text-green-700'
                                }`}>
                                  {m.estado}
                                </span>
                              </td>
                              <td className={tdCls}>
                                {isExpanded ? <ChevronUp size={14} /> : <ChevronDown size={14} />}
                              </td>
                            </tr>
                            {isExpanded && (
                              <tr key={`${m.id}-exp`} className="bg-gray-50">
                                <td colSpan={7} className="px-4 py-3">
                                  <div className="grid grid-cols-2 gap-x-8 gap-y-1.5 text-xs sm:grid-cols-4">
                                    <div><span className="text-gray-400">ID:</span> <code className="font-mono text-gray-700">{m.id}</code></div>
                                    <div><span className="text-gray-400">Fecha:</span> <span className="text-gray-700">{fmtFecha(m.at)}</span></div>
                                    <div><span className="text-gray-400">Creado por:</span> <code className="font-mono text-gray-700">{m.creadoPorUid ?? '—'}</code></div>
                                    <div><span className="text-gray-400">Rol:</span> <span className="text-gray-700">{m.creadoPorRol ?? '—'}</span></div>
                                    {m.descripcion && <div className="col-span-2"><span className="text-gray-400">Descripción:</span> <span className="text-gray-700">{m.descripcion}</span></div>}
                                    {m.solicitudId && <div><span className="text-gray-400">Solicitud:</span> <code className="font-mono text-gray-700">{m.solicitudId}</code></div>}
                                    {m.depositoId && <div><span className="text-gray-400">Depósito:</span> <code className="font-mono text-gray-700">{m.depositoId}</code></div>}
                                    {m.motorizadoId && <div><span className="text-gray-400">Motorizado:</span> <code className="font-mono text-gray-700">{m.motorizadoId}</code></div>}
                                    {m.comercioId && <div><span className="text-gray-400">Comercio:</span> <code className="font-mono text-gray-700">{m.comercioId}</code></div>}
                                    {m.saldoId && <div><span className="text-gray-400">Saldo:</span> <code className="font-mono text-gray-700">{m.saldoId}</code></div>}
                                    {m.gastoId && <div><span className="text-gray-400">Gasto:</span> <code className="font-mono text-gray-700">{m.gastoId}</code></div>}
                                    {m.liquidacionId && <div><span className="text-gray-400">Liquidación:</span> <code className="font-mono text-gray-700">{m.liquidacionId}</code></div>}
                                    {m.semanaKey && <div><span className="text-gray-400">Semana:</span> <span className="text-gray-700">{m.semanaKey}</span></div>}
                                    {m.propietario && <div><span className="text-gray-400">Propietario:</span> <span className="text-gray-700">{m.propietario}</span></div>}
                                  </div>
                                </td>
                              </tr>
                            )}
                          </Fragment>
                        )
                      })}
                    </tbody>
                  </table>
                </div>
                {movsFiltrados.length > 200 && (
                  <div className="px-4 py-2 border-t border-gray-100 bg-gray-50 text-xs text-gray-400 text-center">
                    Mostrando los primeros 200 de {movsFiltrados.length} resultados. Usa los filtros para acotar.
                  </div>
                )}
              </div>
            </div>
          )}

          {/* ── Tab: Issues ─────────────────────────────────────────────────── */}
          {tab === 'issues' && (
            <div className="flex flex-col gap-4">
              {/* Sin cuentas */}
              <IssueSection
                title="Movimientos sin cuentaOrigen ni cuentaDestino"
                subtitle="No aportan a los cálculos del ledger — cobertura Fase 1 incompleta"
                items={issues.sinCuentas}
                badgeColor="amber"
                emptyMsg="Todos los movimientos tienen al menos una cuenta ✓"
              />

              {/* Con cobertura pendiente */}
              <IssueSection
                title="Movimientos que deberían tener cuentas pero no las tienen"
                subtitle="Tipos de movimiento semánticamente importantes sin doble entrada"
                items={issues.coberturaPendiente}
                badgeColor="orange"
                emptyMsg="Sin movimientos con cobertura pendiente ✓"
              />

              {/* Huérfanos */}
              <IssueSection
                title="Movimientos huérfanos"
                subtitle="Sin ninguna referencia a solicitud, depósito, motorizado, saldo, gasto ni liquidación"
                items={issues.huerfanos}
                badgeColor="red"
                emptyMsg="No hay movimientos huérfanos ✓"
              />
            </div>
          )}
        </>
      )}
    </div>
  )
}

// ─── IssueSection ─────────────────────────────────────────────────────────────

function IssueSection({
  title,
  subtitle,
  items,
  badgeColor,
  emptyMsg,
}: {
  title: string
  subtitle: string
  items: MovimientoFinanciero[]
  badgeColor: 'amber' | 'orange' | 'red'
  emptyMsg: string
}) {
  const [expanded, setExpanded] = useState(false)

  const colorMap = {
    amber: { badge: 'bg-amber-100 text-amber-700 border-amber-200', border: 'border-amber-200' },
    orange: { badge: 'bg-orange-100 text-orange-700 border-orange-200', border: 'border-orange-200' },
    red: { badge: 'bg-red-100 text-red-700 border-red-200', border: 'border-red-200' },
  }
  const colors = colorMap[badgeColor]

  function fmtFechaCorta(v: unknown): string {
    if (!v) return '—'
    const d = typeof (v as any)?.toDate === 'function' ? (v as any).toDate() : null
    if (!d) return '—'
    return d.toLocaleDateString('es-NI', { day: '2-digit', month: 'short', year: 'numeric' })
  }

  return (
    <div className={`rounded-xl border bg-white overflow-hidden ${items.length > 0 ? colors.border : 'border-gray-200'}`}>
      <button
        className="w-full px-4 py-3 flex items-center justify-between hover:bg-gray-50 text-left"
        onClick={() => setExpanded((v) => !v)}
      >
        <div>
          <div className="flex items-center gap-2">
            <span className="text-sm font-bold text-gray-900">{title}</span>
            <span className={`rounded-full border px-2 py-0.5 text-xs font-semibold ${colors.badge}`}>
              {items.length}
            </span>
          </div>
          <p className="text-xs text-gray-400 mt-0.5">{subtitle}</p>
        </div>
        {expanded ? <ChevronUp size={16} className="text-gray-400" /> : <ChevronDown size={16} className="text-gray-400" />}
      </button>

      {expanded && (
        items.length === 0 ? (
          <div className="px-4 py-4 text-sm text-green-600 border-t border-gray-100 bg-green-50/30">
            ✓ {emptyMsg}
          </div>
        ) : (
          <div className="border-t border-gray-100 overflow-x-auto">
            <table className="w-full text-sm">
              <thead className="bg-gray-50 border-b border-gray-100">
                <tr>
                  <th className="px-3 py-2 text-left text-[11px] font-semibold uppercase tracking-wide text-gray-500">Fecha</th>
                  <th className="px-3 py-2 text-left text-[11px] font-semibold uppercase tracking-wide text-gray-500">Tipo</th>
                  <th className="px-3 py-2 text-right text-[11px] font-semibold uppercase tracking-wide text-gray-500">Monto</th>
                  <th className="px-3 py-2 text-left text-[11px] font-semibold uppercase tracking-wide text-gray-500">Descripción</th>
                  <th className="px-3 py-2 text-left text-[11px] font-semibold uppercase tracking-wide text-gray-500">Origen</th>
                  <th className="px-3 py-2 text-left text-[11px] font-semibold uppercase tracking-wide text-gray-500">Destino</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-gray-100">
                {items.slice(0, 50).map((m: any) => (
                  <tr key={m.id} className="hover:bg-gray-50">
                    <td className="px-3 py-2 text-xs text-gray-500 whitespace-nowrap">{fmtFechaCorta(m.at)}</td>
                    <td className="px-3 py-2">
                      <code className="rounded bg-gray-100 px-1.5 py-0.5 text-[11px] text-gray-700">{m.tipo}</code>
                    </td>
                    <td className="px-3 py-2 text-right text-xs font-semibold font-mono text-green-700">
                      C$ {(m.monto ?? 0).toLocaleString('es-NI')}
                    </td>
                    <td className="px-3 py-2 text-xs text-gray-600 max-w-[200px] truncate">{m.descripcion ?? '—'}</td>
                    <td className="px-3 py-2 font-mono text-[11px] text-gray-500">{m.cuentaOrigen ?? <span className="text-gray-300">—</span>}</td>
                    <td className="px-3 py-2 font-mono text-[11px] text-gray-500">{m.cuentaDestino ?? <span className="text-gray-300">—</span>}</td>
                  </tr>
                ))}
              </tbody>
            </table>
            {items.length > 50 && (
              <div className="px-4 py-2 text-xs text-gray-400 text-center border-t border-gray-100">
                Mostrando 50 de {items.length}. Usa los filtros globales para ver todos.
              </div>
            )}
          </div>
        )
      )}
    </div>
  )
}
