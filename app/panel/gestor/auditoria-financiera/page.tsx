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
  Info,
} from 'lucide-react'
import type { MovimientoFinanciero } from '@/lib/financial-types'
import {
  calcularDeudaOperativaMotorizado,
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
  montoOriginal?: number
  nota?: string
  tipo?: string
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
  const [expandedMotId, setExpandedMotId] = useState<string | null>(null)
  const [detalleTecnicoMots, setDetalleTecnicoMots] = useState<Set<string>>(new Set())
  const toggleDetalleTecnico = (id: string) =>
    setDetalleTecnicoMots((prev) => { const s = new Set(prev); s.has(id) ? s.delete(id) : s.add(id); return s })

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
            montoOriginal: data.montoOriginal,
            nota: data.nota,
            tipo: data.tipo,
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
    // ── Saldos formales agrupados por motorizadoId ──────────────────────────
    const saldosPorMot: Record<string, number> = {}
    saldos.forEach((s) => {
      saldosPorMot[s.motorizadoId] = (saldosPorMot[s.motorizadoId] ?? 0) + s.saldoPendiente
    })

    // ── Depósitos pendientes por destino (motorizadoUid) ───────────────────
    const depsPorUidStorkhub: Record<string, number> = {}
    const depsPorUidComercio: Record<string, number> = {}
    depositosPendientes.forEach((d) => {
      if (d.destinatario === 'storkhub') {
        depsPorUidStorkhub[d.motorizadoUid] = (depsPorUidStorkhub[d.motorizadoUid] ?? 0) + d.montoTotal
      } else {
        depsPorUidComercio[d.motorizadoUid] = (depsPorUidComercio[d.motorizadoUid] ?? 0) + d.montoTotal
      }
    })

    // ── Umbral de antigüedad: depósitos con más de 7 días son riesgo medio ──
    const hace7dias = Date.now() - 7 * 24 * 60 * 60 * 1000

    return motorizados.map((mot) => {
      // ── Obligaciones operativas ────────────────────────────────────────────
      const saldosACargoOp = saldosPorMot[mot.id] ?? 0

      const adelantosActivos = movimientos
        .filter((m) => m.motorizadoId === mot.id && m.tipo === 'adelanto_motorizado' && m.estado !== 'anulado')
        .reduce((s, m) => s + m.monto, 0)

      const gastosActivos = movimientos
        .filter((m) => m.motorizadoId === mot.id && (m.tipo === 'gasto_aprobado' || m.tipo === 'gasto_operativo_aprobado') && m.estado !== 'anulado')
        .reduce((s, m) => s + m.monto, 0)

      // ── Dinero pendiente de depositar ──────────────────────────────────────
      const pendienteStorkhub = depsPorUidStorkhub[mot.authUid] ?? 0
      const pendienteComercio = depsPorUidComercio[mot.authUid] ?? 0

      // ── Antigüedad de depósitos (cualquier destino) ────────────────────────
      const depsMot = depositosPendientes.filter((d) => d.motorizadoUid === mot.authUid)
      const hayDepositosAncianos = depsMot.some((d) => {
        const ms = (d.creadoAt as any)?.toMillis?.()
        return ms != null && ms < hace7dias
      })

      // ── Referencias técnicas del ledger ────────────────────────────────────
      const comisionLedger = calcularComisionPendienteMotorizado(movimientos, mot.id)
      const deudaLedger    = calcularDeudaOperativaMotorizado(movimientos, mot.id)

      // ── Alertas con severidad ──────────────────────────────────────────────
      type Alerta = { msg: string; nivel: 'alto' | 'medio' | 'bajo'; detalle?: string }
      const alertas: Alerta[] = []

      // Alto: fondos StorkHub pendientes > C$500
      if (pendienteStorkhub > 500) {
        alertas.push({ msg: 'Fondos StorkHub pendientes superiores a C$500', nivel: 'alto' })
      }
      // Alto: fondos comercio pendientes > C$500
      if (pendienteComercio > 500) {
        alertas.push({ msg: 'Fondos de comercio pendientes superiores a C$500', nivel: 'alto' })
      }
      // Medio: saldo a cargo activo
      if (saldosACargoOp > 0) {
        alertas.push({ msg: 'Motorizado mantiene deuda activa con StorkHub', nivel: 'medio' })
      }
      // Medio: adelantos sin regularizar
      if (adelantosActivos > 0) {
        alertas.push({ msg: 'Adelantos pendientes de regularización', nivel: 'medio' })
      }
      // Medio: fondos con más de 7 días sin confirmar
      if (hayDepositosAncianos) {
        alertas.push({ msg: 'Fondos pendientes con más de 7 días sin confirmar', nivel: 'medio' })
      }
      // Medio: StorkHub pendiente entre C$1–C$500 (no alto pero sigue activo)
      if (pendienteStorkhub > 0 && pendienteStorkhub <= 500) {
        alertas.push({ msg: 'Depósitos StorkHub sin confirmar', nivel: 'medio' })
      }
      // Medio: comercio pendiente entre C$1–C$500
      if (pendienteComercio > 0 && pendienteComercio <= 500) {
        alertas.push({ msg: 'Fondos de comercio pendientes de depositar', nivel: 'medio' })
      }
      // Bajo: gastos operativos pendientes de compensar
      if (gastosActivos > 0) {
        alertas.push({ msg: 'Gastos operativos pendientes de compensación', nivel: 'bajo' })
      }
      // Bajo: movimientos sin cuentas contables
      const movsMot = movimientos.filter((m) => m.estado !== 'anulado' && m.motorizadoId === mot.id)
      if (movsMot.some((m) => !m.cuentaOrigen && !m.cuentaDestino)) {
        alertas.push({ msg: 'Movimientos sin cuentas contables', nivel: 'bajo' })
      }
      // Medio: inconsistencia entre saldos operativos y ledger
      const deudaAbs = Math.abs(deudaLedger)
      if ((saldosACargoOp > 0 || deudaAbs > 0) && Math.abs(saldosACargoOp - deudaAbs) > 1) {
        alertas.push({
          msg: 'Inconsistencia financiera detectada',
          nivel: 'medio',
          detalle: `Saldos cargo: ${fmt(saldosACargoOp)} · Deuda ledger: ${fmt(deudaAbs)} · Diferencia: ${fmt(Math.abs(saldosACargoOp - deudaAbs))}`,
        })
      }

      return {
        mot,
        saldosACargoOp,
        adelantosActivos,
        gastosActivos,
        pendienteStorkhub,
        pendienteComercio,
        comisionLedger,
        deudaLedger,
        alertas,
      }
    }).sort((a, b) => {
      const peso = (al: { nivel: 'alto' | 'medio' | 'bajo' }) =>
        al.nivel === 'alto' ? 3 : al.nivel === 'medio' ? 2 : 1
      const pA = a.alertas.reduce((s, al) => s + peso(al), 0)
      const pB = b.alertas.reduce((s, al) => s + peso(al), 0)
      return pB - pA || b.pendienteStorkhub - a.pendienteStorkhub
    })
  }, [motorizados, movimientos, saldos, depositosPendientes])

  const auditFiltrado = useMemo(() => {
    let list = auditMotorizados
    if (filtroMotorizado !== 'todos')
      list = list.filter((r) => r.mot.id === filtroMotorizado)
    if (soloDiferencias)
      list = list.filter((r) => r.alertas.length > 0)
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
              Solo con alertas
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
              <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-5">
                <KpiCard
                  label="Fondos StorkHub pendientes"
                  value={auditMotorizados.filter((r) => r.pendienteStorkhub > 0).length}
                  sub="motorizados con depósitos sin confirmar"
                  warn
                />
                <KpiCard
                  label="Fondos comercio pendientes"
                  value={auditMotorizados.filter((r) => r.pendienteComercio > 0).length}
                  sub="dinero de comercios sin depositar"
                  warn
                />
                <KpiCard
                  label="Con saldos a cargo"
                  value={auditMotorizados.filter((r) => r.saldosACargoOp > 0).length}
                  sub="deuda activa con StorkHub"
                  warn
                />
                <KpiCard
                  label="Con adelantos activos"
                  value={auditMotorizados.filter((r) => r.adelantosActivos > 0).length}
                  sub="adelantos sin regularizar"
                  warn
                />
                <KpiCard
                  label="Motorizados con alertas"
                  value={auditMotorizados.filter((r) => r.alertas.length > 0).length}
                  sub={`de ${motorizados.length} totales`}
                  warn
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
            <div className="flex flex-col gap-4">

              {/* KPIs de control rápido */}
              <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
                <KpiCard
                  label="Fondos StorkHub pendientes"
                  value={auditMotorizados.filter((r) => r.pendienteStorkhub > 0).length}
                  sub="motorizados con depósitos sin confirmar"
                  warn
                />
                <KpiCard
                  label="Fondos comercio pendientes"
                  value={auditMotorizados.filter((r) => r.pendienteComercio > 0).length}
                  sub="dinero de comercios sin depositar"
                  warn
                />
                <KpiCard
                  label="Con saldos a cargo"
                  value={auditMotorizados.filter((r) => r.saldosACargoOp > 0).length}
                  sub="deuda activa con StorkHub"
                  warn
                />
                <KpiCard
                  label="Con alertas"
                  value={auditMotorizados.filter((r) => r.alertas.length > 0).length}
                  sub={`de ${motorizados.length} motorizados`}
                  warn
                />
              </div>

              {/* Tabla */}
              <div className="rounded-xl border border-gray-200 bg-white overflow-hidden">
                <div className="px-4 py-3 border-b border-gray-100 flex items-center justify-between">
                  <div>
                    <h2 className="text-sm font-bold text-gray-900">Control financiero por motorizado</h2>
                    <p className="text-xs text-gray-400 mt-0.5">
                      Ubicación del dinero · obligaciones · alertas de riesgo · haz clic para ver desglose
                    </p>
                  </div>
                  <span className={`text-xs font-semibold rounded-full px-2.5 py-1 ${
                    auditFiltrado.filter((r) => r.alertas.some((a) => a.nivel === 'alto')).length === 0
                      ? 'bg-green-100 text-green-700'
                      : 'bg-red-100 text-red-700'
                  }`}>
                    {auditFiltrado.filter((r) => r.alertas.some((a) => a.nivel === 'alto')).length} riesgo alto
                  </span>
                </div>
                <div className="overflow-x-auto">
                  <table className="w-full text-sm">
                    <thead className="bg-gray-50 border-b border-gray-200">
                      <tr>
                        <th className={thCls}>Motorizado</th>
                        <th className={`${thCls} text-right`}>
                          <span className="inline-flex items-center gap-1">
                            Pendiente StorkHub
                            <span title="Depósitos para StorkHub generados pero aún sin confirmar" className="cursor-help text-gray-400"><Info size={11} /></span>
                          </span>
                        </th>
                        <th className={`${thCls} text-right`}>
                          <span className="inline-flex items-center gap-1">
                            Pendiente Comercio
                            <span title="Dinero de cobros a comercios que el motorizado aún no ha depositado" className="cursor-help text-gray-400"><Info size={11} /></span>
                          </span>
                        </th>
                        <th className={`${thCls} text-right`}>Saldos a cargo</th>
                        <th className={`${thCls} text-right`}>Adelantos activos</th>
                        <th className={`${thCls} text-right`}>Gastos op.</th>
                        <th className={thCls}>Alertas de riesgo</th>
                        <th className={thCls}></th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-gray-100">
                      {auditFiltrado.length === 0 && (
                        <tr>
                          <td colSpan={8} className="px-4 py-8 text-center text-sm text-gray-400">
                            {soloDiferencias ? 'Sin alertas — todo en orden ✓' : 'Sin datos'}
                          </td>
                        </tr>
                      )}
                      {auditFiltrado.map(({ mot, saldosACargoOp, adelantosActivos, gastosActivos, pendienteStorkhub, pendienteComercio, comisionLedger, deudaLedger, alertas }) => {
                        const isExpanded = expandedMotId === mot.id
                        const saldosMot = saldos.filter((s) => s.motorizadoId === mot.id)
                        const adelantosMot = movimientos.filter(
                          (m) => m.motorizadoId === mot.id && m.tipo === 'adelanto_motorizado' && m.estado !== 'anulado',
                        )
                        const gastosMot = movimientos.filter(
                          (m) => m.motorizadoId === mot.id && (m.tipo === 'gasto_aprobado' || m.tipo === 'gasto_operativo_aprobado') && m.estado !== 'anulado',
                        )
                        const depsMot = depositosPendientes.filter((d) => d.motorizadoUid === mot.authUid)
                        const tieneAltoRiesgo = alertas.some((a) => a.nivel === 'alto')
                        return (
                          <Fragment key={mot.id}>
                            {/* Fila principal */}
                            <tr
                              className={`cursor-pointer hover:bg-gray-50 transition-colors ${tieneAltoRiesgo ? 'bg-red-50/20' : alertas.length > 0 ? 'bg-amber-50/20' : ''}`}
                              onClick={() => setExpandedMotId(isExpanded ? null : mot.id)}
                            >
                              <td className={tdCls}>
                                <div className="flex flex-col">
                                  <span className="font-semibold text-gray-900">{mot.nombre}</span>
                                  <span className="font-mono text-[10px] text-gray-400">{mot.id}</span>
                                </div>
                              </td>
                              <td className={`${tdCls} text-right font-mono`}>
                                {pendienteStorkhub === 0
                                  ? <span className="text-gray-300">—</span>
                                  : <span className="font-semibold text-red-700">{fmt(pendienteStorkhub)}</span>}
                              </td>
                              <td className={`${tdCls} text-right font-mono`}>
                                {pendienteComercio === 0
                                  ? <span className="text-gray-300">—</span>
                                  : <span className="font-semibold text-orange-700">{fmt(pendienteComercio)}</span>}
                              </td>
                              <td className={`${tdCls} text-right font-mono`}>
                                {saldosACargoOp === 0
                                  ? <span className="text-gray-300">—</span>
                                  : <span className="font-semibold text-red-700">{fmt(saldosACargoOp)}</span>}
                              </td>
                              <td className={`${tdCls} text-right font-mono`}>
                                {adelantosActivos === 0
                                  ? <span className="text-gray-300">—</span>
                                  : <span className="font-semibold text-amber-700">{fmt(adelantosActivos)}</span>}
                              </td>
                              <td className={`${tdCls} text-right font-mono`}>
                                {gastosActivos === 0
                                  ? <span className="text-gray-300">—</span>
                                  : <span className="font-semibold text-purple-700">{fmt(gastosActivos)}</span>}
                              </td>
                              <td className={tdCls}>
                                {alertas.length === 0 ? (
                                  <span className="inline-flex items-center gap-1 text-[11px] font-semibold text-green-700">
                                    <CheckCircle2 size={12} /> Sin alertas
                                  </span>
                                ) : (
                                  <div className="flex flex-col gap-1">
                                    {alertas.map((a, i) => (
                                      <span
                                        key={i}
                                        className={`inline-flex items-center gap-1 text-[11px] font-semibold rounded-full px-2 py-0.5 whitespace-nowrap ${
                                          a.nivel === 'alto'
                                            ? 'bg-red-100 text-red-700'
                                            : a.nivel === 'medio'
                                            ? 'bg-amber-100 text-amber-700'
                                            : 'bg-gray-100 text-gray-600'
                                        }`}
                                      >
                                        <AlertTriangle size={10} /> {a.msg}
                                      </span>
                                    ))}
                                  </div>
                                )}
                              </td>
                              <td className={`${tdCls} text-right`}>
                                {isExpanded
                                  ? <ChevronUp size={14} className="text-gray-400" />
                                  : <ChevronDown size={14} className="text-gray-400" />}
                              </td>
                            </tr>

                            {/* Fila de desglose expandible */}
                            {isExpanded && (
                              <tr className="bg-gray-50/60">
                                <td colSpan={8} className="px-4 py-4">
                                  <div className="flex flex-col gap-5">

                                    {/* Sección 1: Ubicación del dinero */}
                                    <div>
                                      <p className="text-[11px] font-semibold uppercase tracking-wide text-gray-400 mb-2">Ubicación del dinero</p>
                                      <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">

                                        {/* Pendiente StorkHub */}
                                        <div className="bg-white rounded-xl border border-red-100 overflow-hidden">
                                          <div className="px-3 py-2 bg-red-50 border-b border-red-100 flex items-center justify-between">
                                            <span className="text-xs font-bold text-red-800">Pendiente de depositar a StorkHub</span>
                                            <span className="text-xs font-black text-red-700">{fmt(pendienteStorkhub)}</span>
                                          </div>
                                          {/* Depósitos enviados sin confirmar */}
                                          {depsMot.filter((d) => d.destinatario === 'storkhub').length === 0 ? (
                                            <p className="px-3 py-2 text-[11px] text-gray-400">Sin depósitos StorkHub enviados pendientes</p>
                                          ) : (
                                            <div className="divide-y divide-red-50">
                                              <p className="px-3 pt-2 text-[10px] font-semibold uppercase tracking-wide text-gray-400">Depósitos enviados sin confirmar</p>
                                              {depsMot.filter((d) => d.destinatario === 'storkhub').map((d) => (
                                                <div key={d.id} className="px-3 py-2 flex items-center justify-between gap-2">
                                                  <div className="flex flex-col gap-0.5">
                                                    <span className="text-[11px] text-gray-500">{fmtFechaCorta(d.creadoAt)}</span>
                                                    <span className="text-[11px] text-gray-400 capitalize">{d.estado}</span>
                                                  </div>
                                                  <span className="text-xs font-black text-red-700">{fmt(d.montoTotal)}</span>
                                                </div>
                                              ))}
                                            </div>
                                          )}
                                        </div>

                                        {/* Pendiente Comercio */}
                                        <div className="bg-white rounded-xl border border-orange-100 overflow-hidden">
                                          <div className="px-3 py-2 bg-orange-50 border-b border-orange-100 flex items-center justify-between">
                                            <span className="text-xs font-bold text-orange-800">Pendiente de depositar a comercios</span>
                                            <span className="text-xs font-black text-orange-700">{fmt(pendienteComercio)}</span>
                                          </div>
                                          {depsMot.filter((d) => d.destinatario !== 'storkhub').length === 0 ? (
                                            <p className="px-3 py-2 text-[11px] text-gray-400">Sin fondos de comercio pendientes</p>
                                          ) : (
                                            <div className="divide-y divide-orange-50">
                                              {depsMot.filter((d) => d.destinatario !== 'storkhub').map((d) => (
                                                <div key={d.id} className="px-3 py-2 flex items-center justify-between gap-2">
                                                  <div className="flex flex-col gap-0.5">
                                                    <span className="text-[11px] text-gray-500">{fmtFechaCorta(d.creadoAt)}</span>
                                                    <span className="text-[11px] text-gray-400 capitalize">{d.destinatario} · {d.estado}</span>
                                                  </div>
                                                  <span className="text-xs font-black text-orange-700">{fmt(d.montoTotal)}</span>
                                                </div>
                                              ))}
                                            </div>
                                          )}
                                        </div>
                                      </div>
                                    </div>

                                    {/* Sección 2: Obligaciones */}
                                    <div>
                                      <p className="text-[11px] font-semibold uppercase tracking-wide text-gray-400 mb-2">Obligaciones con StorkHub</p>
                                      <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">

                                        {/* Saldos a cargo */}
                                        <div className="bg-white rounded-xl border border-red-100 overflow-hidden">
                                          <div className="px-3 py-2 bg-red-50 border-b border-red-100 flex items-center justify-between">
                                            <span className="text-xs font-bold text-red-800">Saldos a cargo</span>
                                            <span className="text-xs font-black text-red-700">{fmt(saldosACargoOp)}</span>
                                          </div>
                                          {saldosMot.length === 0 ? (
                                            <p className="px-3 py-2 text-[11px] text-gray-400">Sin saldos formales registrados</p>
                                          ) : (
                                            <div className="divide-y divide-red-50">
                                              {saldosMot.map((s) => (
                                                <div key={s.id} className="px-3 py-2 flex items-start justify-between gap-2">
                                                  <div className="flex flex-col gap-0.5 min-w-0">
                                                    {s.tipo && <span className="text-[11px] font-semibold text-gray-700">{s.tipo}</span>}
                                                    {s.nota && <span className="text-[11px] text-gray-400 italic truncate">{s.nota}</span>}
                                                    <span className={`text-[11px] font-semibold ${s.estado === 'abonado_parcial' ? 'text-amber-600' : 'text-gray-400'}`}>
                                                      {s.estado === 'abonado_parcial' ? 'Abonado parcial' : 'Pendiente'}
                                                    </span>
                                                  </div>
                                                  <div className="text-right shrink-0">
                                                    <p className="text-xs font-black text-red-700">{fmt(s.saldoPendiente)}</p>
                                                    {s.montoOriginal != null && s.montoOriginal !== s.saldoPendiente && (
                                                      <p className="text-[11px] text-gray-400">orig. {fmt(s.montoOriginal)}</p>
                                                    )}
                                                  </div>
                                                </div>
                                              ))}
                                            </div>
                                          )}
                                        </div>

                                        {/* Adelantos activos */}
                                        <div className="bg-white rounded-xl border border-amber-100 overflow-hidden">
                                          <div className="px-3 py-2 bg-amber-50 border-b border-amber-100 flex items-center justify-between">
                                            <span className="text-xs font-bold text-amber-800">Adelantos activos</span>
                                            <span className="text-xs font-black text-amber-700">{fmt(adelantosActivos)}</span>
                                          </div>
                                          {adelantosMot.length === 0 ? (
                                            <p className="px-3 py-2 text-[11px] text-gray-400">Sin adelantos activos</p>
                                          ) : (
                                            <div className="divide-y divide-amber-50">
                                              {adelantosMot.map((a: any) => (
                                                <div key={a.id} className="px-3 py-2 flex items-center justify-between gap-2">
                                                  <div className="flex flex-col gap-0.5 min-w-0">
                                                    <span className="text-[11px] text-gray-500">{fmtFechaCorta(a.at)}</span>
                                                    {a.descripcion && <span className="text-[11px] text-gray-400 truncate">{a.descripcion}</span>}
                                                  </div>
                                                  <span className="text-xs font-black text-amber-700 shrink-0">{fmt(a.monto)}</span>
                                                </div>
                                              ))}
                                            </div>
                                          )}
                                        </div>

                                        {/* Gastos operativos */}
                                        <div className="bg-white rounded-xl border border-purple-100 overflow-hidden">
                                          <div className="px-3 py-2 bg-purple-50 border-b border-purple-100 flex items-center justify-between">
                                            <div>
                                              <p className="text-xs font-bold text-purple-800">Gastos op. activos</p>
                                              <p className="text-[10px] text-purple-400">Solo informativo</p>
                                            </div>
                                            <span className="text-xs font-black text-purple-700">{fmt(gastosActivos)}</span>
                                          </div>
                                          {gastosMot.length === 0 ? (
                                            <p className="px-3 py-2 text-[11px] text-gray-400">Sin gastos activos</p>
                                          ) : (
                                            <div className="divide-y divide-purple-50">
                                              {gastosMot.map((g: any) => (
                                                <div key={g.id} className="px-3 py-2 flex items-center justify-between gap-2">
                                                  <div className="flex flex-col gap-0.5 min-w-0">
                                                    <span className="text-[11px] text-gray-500">{fmtFechaCorta(g.at)}</span>
                                                    {g.descripcion && <span className="text-[11px] text-gray-400 truncate">{g.descripcion}</span>}
                                                  </div>
                                                  <span className="text-xs font-black text-purple-700 shrink-0">{fmt(g.monto)}</span>
                                                </div>
                                              ))}
                                            </div>
                                          )}
                                        </div>
                                      </div>
                                    </div>

                                    {/* Sección 3: Alertas de riesgo */}
                                    {alertas.length > 0 && (
                                      <div>
                                        <p className="text-[11px] font-semibold uppercase tracking-wide text-gray-400 mb-2">Alertas de riesgo</p>
                                        <div className="flex flex-col gap-2">
                                          {alertas.map((a, i) => (
                                            <div
                                              key={i}
                                              className={`flex items-start gap-3 rounded-lg px-3 py-2 border ${
                                                a.nivel === 'alto'
                                                  ? 'bg-red-50 border-red-200'
                                                  : a.nivel === 'medio'
                                                  ? 'bg-amber-50 border-amber-200'
                                                  : 'bg-gray-50 border-gray-200'
                                              }`}
                                            >
                                              <AlertTriangle size={14} className={
                                                a.nivel === 'alto' ? 'text-red-600 shrink-0 mt-0.5' : a.nivel === 'medio' ? 'text-amber-600 shrink-0 mt-0.5' : 'text-gray-400 shrink-0 mt-0.5'
                                              } />
                                              <div className="flex flex-col min-w-0">
                                                <span className={`text-xs font-bold ${
                                                  a.nivel === 'alto' ? 'text-red-800' : a.nivel === 'medio' ? 'text-amber-800' : 'text-gray-700'
                                                }`}>{a.msg}</span>
                                                {a.detalle && (
                                                  <span className="text-[11px] text-gray-500 mt-0.5 font-mono">{a.detalle}</span>
                                                )}
                                                <span className="text-[11px] text-gray-400 uppercase tracking-wide mt-0.5">Riesgo {a.nivel}</span>
                                              </div>
                                            </div>
                                          ))}
                                        </div>
                                      </div>
                                    )}

                                    {/* Sección 4: Estado financiero registrado */}
                                    <div className="rounded-xl border border-gray-100 bg-gray-50 px-4 py-3">
                                      <p className="text-[11px] font-semibold uppercase tracking-wide text-gray-400 mb-3">Estado financiero registrado</p>
                                      <div className="grid grid-cols-1 sm:grid-cols-2 gap-3 text-xs">
                                        {/* Comisión disponible */}
                                        <div className="rounded-lg bg-green-50 border border-green-100 px-3 py-2 flex flex-col gap-0.5">
                                          <span className="text-[10px] font-semibold uppercase tracking-wide text-green-600">Comisión disponible</span>
                                          <span className={`font-black text-sm ${comisionLedger > 0 ? 'text-green-700' : 'text-gray-400'}`}>
                                            {fmt(comisionLedger > 0 ? comisionLedger : 0)}
                                          </span>
                                          {comisionLedger < 0 && (
                                            <span className="text-[10px] text-amber-600 mt-0.5">
                                              Comisión ya usada en abonos/deudas: {fmt(Math.abs(comisionLedger))}
                                            </span>
                                          )}
                                          {comisionLedger >= 0 && (
                                            <span className="text-[10px] text-green-600/70">Pendiente de liquidar</span>
                                          )}
                                        </div>
                                        {/* Deuda formal pendiente */}
                                        <div className="rounded-lg bg-red-50 border border-red-100 px-3 py-2 flex flex-col gap-0.5">
                                          <span className="text-[10px] font-semibold uppercase tracking-wide text-red-500">Deuda formal pendiente</span>
                                          <span className={`font-black text-sm ${Math.abs(deudaLedger) > 0 ? 'text-red-700' : 'text-gray-400'}`}>
                                            {fmt(Math.abs(deudaLedger))}
                                          </span>
                                          <span className="text-[10px] text-red-500/70">Registrada en ledger a favor de StorkHub</span>
                                        </div>
                                      </div>
                                      {/* Nota + toggle técnico */}
                                      <div className="mt-2 flex items-center justify-between gap-2 flex-wrap">
                                        <p className="text-[10px] text-gray-400 font-sans">
                                          Datos tomados del ledger financiero. La liquidación oficial se calcula en el módulo Liquidaciones.
                                        </p>
                                        <button
                                          onClick={() => toggleDetalleTecnico(mot.id)}
                                          className="text-[10px] text-gray-400 hover:text-gray-600 underline underline-offset-2 shrink-0"
                                        >
                                          {detalleTecnicoMots.has(mot.id) ? 'Ocultar detalle técnico' : 'Ver detalle técnico'}
                                        </button>
                                      </div>
                                      {/* Detalle técnico colapsable */}
                                      {detalleTecnicoMots.has(mot.id) && (
                                        <div className="mt-2 grid grid-cols-1 sm:grid-cols-2 gap-2 font-mono text-[10px] text-gray-400 border-t border-gray-200 pt-2">
                                          <span>comision_pendiente = {fmt(comisionLedger)}</span>
                                          <span>deuda_motorizado = {fmt(deudaLedger)}</span>
                                        </div>
                                      )}
                                    </div>

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
                {/* Leyenda */}
                <div className="px-4 py-3 border-t border-gray-100 bg-gray-50">
                  <p className="text-xs text-gray-400 leading-relaxed">
                    <strong>Pendiente StorkHub</strong>: depósitos para StorkHub sin confirmar por el gestor. &nbsp;
                    <strong>Pendiente Comercio</strong>: fondos de cobros a comercios aún no depositados. &nbsp;
                    <strong>Saldos a cargo</strong>: deudas formales en <code>saldos_cargo_motorizado</code>. &nbsp;
                    <strong>Adelantos activos</strong>: adelantos del ledger no anulados. &nbsp;
                    <strong>Gastos op.</strong>: gastos aprobados sin anular (informativo). &nbsp;
                    Haz clic en una fila para ver desglose y alertas de riesgo.
                  </p>
                </div>
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
