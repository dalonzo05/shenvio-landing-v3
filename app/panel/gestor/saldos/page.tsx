'use client'

import { useEffect, useMemo, useState } from 'react'
import {
  collection,
  onSnapshot,
  query,
  where,
  orderBy,
} from 'firebase/firestore'
import { auth, db } from '@/fb/config'
import { registrarAbonoSaldo, anularSaldoCargo } from '@/lib/financial-writes'
import {
  LABELS_TIPO_SALDO,
  type SaldoCargoMotorizado,
  type EstadoSaldo,
} from '@/lib/financial-types'
import { AlertTriangle, CheckCircle2, ChevronDown, ChevronUp } from 'lucide-react'

// ─── Types ────────────────────────────────────────────────────────────────────

type Motorizado = { id: string; authUid: string; nombre?: string }
type Saldo = SaldoCargoMotorizado & { id: string }

// ─── Helpers ──────────────────────────────────────────────────────────────────

function fmt(n: number) {
  return `C$ ${n.toLocaleString('es-NI')}`
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

const BADGE_ESTADO: Record<EstadoSaldo, string> = {
  pendiente: 'bg-red-100 text-red-700',
  abonado_parcial: 'bg-orange-100 text-orange-700',
  pagado: 'bg-green-100 text-green-700',
  anulado: 'bg-gray-100 text-gray-500',
}

const LABEL_ESTADO: Record<EstadoSaldo, string> = {
  pendiente: 'Pendiente',
  abonado_parcial: 'Abonado parcial',
  pagado: 'Pagado',
  anulado: 'Anulado',
}

// ─── Main ─────────────────────────────────────────────────────────────────────

export default function SaldosPage() {
  const [motorizados, setMotorizados] = useState<Motorizado[]>([])
  const [saldos, setSaldos] = useState<Saldo[]>([])
  const [loading, setLoading] = useState(true)

  // Filtros
  const [filtroMoto, setFiltroMoto] = useState('todos')
  const [filtroEstado, setFiltroEstado] = useState<EstadoSaldo | 'todos'>('pendiente')
  const [expandedId, setExpandedId] = useState<string | null>(null)

  // Abono
  const [abonoId, setAbonoId] = useState<string | null>(null)
  const [montoAbono, setMontoAbono] = useState('')
  const [metodoAbono, setMetodoAbono] = useState('efectivo')
  const [notaAbono, setNotaAbono] = useState('')
  const [savingAbono, setSavingAbono] = useState(false)

  // ── Queries ───────────────────────────────────────────────────────────────

  useEffect(() => {
    const q = query(collection(db, 'motorizado'))
    return onSnapshot(q, (snap) => {
      setMotorizados(
        snap.docs
          .map((d) => ({ id: d.id, ...(d.data() as any) } as Motorizado))
          .sort((a, b) => (a.nombre || '').localeCompare(b.nombre || ''))
      )
    })
  }, [])

  useEffect(() => {
    const q = query(collection(db, 'saldos_cargo_motorizado'), orderBy('createdAt', 'desc'))
    return onSnapshot(q, (snap) => {
      setSaldos(snap.docs.map((d) => ({ id: d.id, ...(d.data() as any) } as Saldo)))
      setLoading(false)
    })
  }, [])

  // ── Filtros ───────────────────────────────────────────────────────────────

  const saldosFiltrados = useMemo(() => {
    return saldos.filter((s) => {
      if (filtroMoto !== 'todos' && s.motorizadoId !== filtroMoto) return false
      if (filtroEstado !== 'todos' && s.estado !== filtroEstado) return false
      return true
    })
  }, [saldos, filtroMoto, filtroEstado])

  const kpis = useMemo(() => {
    const activos = saldos.filter((s) => s.estado === 'pendiente' || s.estado === 'abonado_parcial')
    return {
      totalPendiente: activos.reduce((s, x) => s + x.saldoPendiente, 0),
      count: activos.length,
      pagados: saldos.filter((s) => s.estado === 'pagado').length,
    }
  }, [saldos])

  // ── Abonar ────────────────────────────────────────────────────────────────

  async function handleAbono(saldo: Saldo) {
    const monto = parseFloat(montoAbono)
    if (isNaN(monto) || monto <= 0) return
    setSavingAbono(true)
    try {
      await registrarAbonoSaldo({
        saldoId: saldo.id,
        montoAbono: monto,
        saldoPendienteActual: saldo.saldoPendiente,
        metodo: metodoAbono,
        nota: notaAbono,
        operadorId: auth.currentUser?.uid ?? '',
        motorizadoId: saldo.motorizadoId,
        motorizadoNombre: saldo.motorizadoNombre,
      })
      setAbonoId(null)
      setMontoAbono('')
      setNotaAbono('')
    } catch (e) {
      console.error('Error registrando abono:', e)
    } finally {
      setSavingAbono(false)
    }
  }

  async function handleAnular(saldo: Saldo) {
    const ok = window.confirm(
      `¿Anular este saldo?\n\nMotorizado: ${saldo.motorizadoNombre}\nMonto: ${fmt(saldo.saldoPendiente)}\nTipo: ${LABELS_TIPO_SALDO[saldo.tipo]}\n\nEsta acción no se puede deshacer.`
    )
    if (!ok) return
    await anularSaldoCargo(saldo.id, auth.currentUser?.uid ?? '')
  }

  // ── Render ────────────────────────────────────────────────────────────────

  return (
    <div className="flex flex-col gap-4 max-w-4xl mx-auto">
      {/* Header */}
      <div>
        <h1 className="text-2xl font-black text-gray-900 tracking-tight flex items-center gap-2">
          <AlertTriangle className="h-6 w-6 text-red-500" />
          Saldos a cargo
        </h1>
        <p className="text-sm text-gray-500 mt-0.5">
          Deudas de motorizados — depósitos no realizados, adelantos, ajustes.
        </p>
      </div>

      {/* KPIs */}
      <div className="grid grid-cols-3 gap-3">
        <div className="border rounded-xl px-4 py-3 bg-red-50 border-red-200">
          <p className="text-2xl font-black text-red-700">{fmt(kpis.totalPendiente)}</p>
          <p className="text-xs font-semibold mt-0.5 text-red-400">Total pendiente</p>
        </div>
        <div className="border rounded-xl px-4 py-3 bg-orange-50 border-orange-200">
          <p className="text-2xl font-black text-orange-700">{kpis.count}</p>
          <p className="text-xs font-semibold mt-0.5 text-orange-400">Saldos activos</p>
        </div>
        <div className="border rounded-xl px-4 py-3 bg-green-50 border-green-200">
          <p className="text-2xl font-black text-green-700">{kpis.pagados}</p>
          <p className="text-xs font-semibold mt-0.5 text-green-400">Pagados</p>
        </div>
      </div>

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

        {(['todos', 'pendiente', 'abonado_parcial', 'pagado', 'anulado'] as const).map((e) => (
          <button
            key={e}
            onClick={() => setFiltroEstado(e)}
            className={`px-3 py-1 rounded-full text-xs font-semibold border transition ${
              filtroEstado === e
                ? 'bg-gray-900 text-white border-gray-900'
                : 'bg-white text-gray-600 border-gray-200 hover:bg-gray-50'
            }`}
          >
            {e === 'todos' ? 'Todos' : LABEL_ESTADO[e]}
          </button>
        ))}

        <span className="ml-auto text-xs text-gray-400">{saldosFiltrados.length} saldos</span>
      </div>

      {/* Lista */}
      <div className="flex flex-col gap-3">
        {loading ? (
          <div className="bg-white rounded-xl border py-12 text-center text-sm text-gray-400">Cargando…</div>
        ) : saldosFiltrados.length === 0 ? (
          <div className="bg-white rounded-xl border flex flex-col items-center justify-center py-12 gap-2 text-gray-400">
            <CheckCircle2 className="h-10 w-10 opacity-20" />
            <p className="text-sm font-semibold">Sin saldos en esta vista</p>
          </div>
        ) : (
          saldosFiltrados.map((s) => {
            const isExp = expandedId === s.id
            const isAbono = abonoId === s.id
            const puedeAbono = s.estado === 'pendiente' || s.estado === 'abonado_parcial'

            return (
              <div key={s.id} className="bg-white rounded-xl border border-gray-200 overflow-hidden">
                {/* Header */}
                <div className="px-4 py-3 flex items-center gap-3">
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-2 flex-wrap">
                      <p className="text-sm font-bold text-gray-900">{s.motorizadoNombre}</p>
                      <span className={`text-[11px] font-semibold px-2 py-0.5 rounded-full ${BADGE_ESTADO[s.estado]}`}>
                        {LABEL_ESTADO[s.estado]}
                      </span>
                      <span className="text-[11px] text-gray-400 border border-gray-200 px-1.5 py-0.5 rounded">
                        {LABELS_TIPO_SALDO[s.tipo]}
                      </span>
                    </div>
                    <p className="text-xs text-gray-500 mt-0.5">
                      {s.nota || '—'} · {fmtDate(s.fecha || s.createdAt)}
                    </p>
                  </div>
                  <div className="text-right shrink-0">
                    <p className="text-sm font-black text-gray-900">{fmt(s.saldoPendiente)}</p>
                    {s.montoOriginal !== s.saldoPendiente && (
                      <p className="text-[11px] text-gray-400">de {fmt(s.montoOriginal)}</p>
                    )}
                  </div>
                  <button
                    onClick={() => setExpandedId(isExp ? null : s.id)}
                    className="text-gray-400 hover:text-gray-600 p-1"
                  >
                    {isExp ? <ChevronUp className="h-4 w-4" /> : <ChevronDown className="h-4 w-4" />}
                  </button>
                </div>

                {/* Expanded: historial de abonos */}
                {isExp && (
                  <div className="border-t border-gray-100 px-4 py-3 bg-gray-50">
                    <p className="text-xs font-semibold text-gray-500 mb-2">Historial de abonos</p>
                    {!s.abonos || s.abonos.length === 0 ? (
                      <p className="text-xs text-gray-400">Sin abonos registrados.</p>
                    ) : (
                      <div className="flex flex-col gap-1.5">
                        {s.abonos.map((a, i) => (
                          <div key={i} className="flex items-center justify-between text-xs">
                            <span className="text-gray-600">{fmtDate(a.fecha)} · {a.metodo || 'efectivo'}</span>
                            <span className="text-gray-500 italic">{a.nota}</span>
                            <span className="font-semibold text-green-700">{fmt(a.monto)}</span>
                          </div>
                        ))}
                      </div>
                    )}
                  </div>
                )}

                {/* Acciones */}
                {puedeAbono && (
                  <div className="border-t border-gray-100 px-4 py-3">
                    {isAbono ? (
                      <div className="flex flex-col gap-2">
                        <div className="flex gap-2">
                          <input
                            type="number"
                            min="0"
                            max={s.saldoPendiente}
                            step="0.01"
                            value={montoAbono}
                            onChange={(e) => setMontoAbono(e.target.value)}
                            placeholder={`Monto (máx ${fmt(s.saldoPendiente)})`}
                            className="flex-1 border border-gray-200 rounded-lg px-2 py-1.5 text-xs focus:outline-none focus:ring-1 focus:ring-blue-300"
                            autoFocus
                          />
                          <select
                            value={metodoAbono}
                            onChange={(e) => setMetodoAbono(e.target.value)}
                            className="border border-gray-200 rounded-lg px-2 py-1.5 text-xs focus:outline-none"
                          >
                            <option value="efectivo">Efectivo</option>
                            <option value="transferencia">Transferencia</option>
                            <option value="descuento_liquidacion">Descuento liquidación</option>
                          </select>
                        </div>
                        <input
                          type="text"
                          value={notaAbono}
                          onChange={(e) => setNotaAbono(e.target.value)}
                          placeholder="Nota (opcional)"
                          className="border border-gray-200 rounded-lg px-2 py-1.5 text-xs focus:outline-none focus:ring-1 focus:ring-blue-300"
                        />
                        <div className="flex gap-2">
                          <button
                            onClick={() => { setAbonoId(null); setMontoAbono(''); setNotaAbono('') }}
                            className="flex-1 text-xs font-semibold px-3 py-2 rounded-lg border border-gray-200 text-gray-600 hover:bg-gray-50 transition"
                          >
                            Cancelar
                          </button>
                          <button
                            onClick={() => handleAbono(s)}
                            disabled={savingAbono || !montoAbono}
                            className="flex-1 text-xs font-semibold px-3 py-2 rounded-lg bg-green-600 text-white hover:bg-green-700 transition disabled:opacity-40"
                          >
                            {savingAbono ? 'Guardando…' : '✓ Registrar abono'}
                          </button>
                        </div>
                      </div>
                    ) : (
                      <div className="flex gap-2">
                        <button
                          onClick={() => setAbonoId(s.id)}
                          className="flex-1 text-xs font-semibold px-3 py-2 rounded-lg bg-green-600 text-white hover:bg-green-700 transition"
                        >
                          + Registrar abono
                        </button>
                        <button
                          onClick={() => handleAnular(s)}
                          className="text-xs font-semibold px-3 py-2 rounded-lg border border-gray-200 text-gray-500 hover:bg-gray-50 transition"
                        >
                          Anular
                        </button>
                      </div>
                    )}
                  </div>
                )}
              </div>
            )
          })
        )}
      </div>
    </div>
  )
}
