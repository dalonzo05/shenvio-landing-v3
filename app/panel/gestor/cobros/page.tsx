'use client'

import { useEffect, useMemo, useState } from 'react'
import {
  collection,
  onSnapshot,
  query,
  where,
  doc,
  getDoc,
  updateDoc,
  serverTimestamp,
  Timestamp,
  writeBatch,
  increment,
  arrayUnion,
  deleteField,
} from 'firebase/firestore'
import { auth, db } from '@/fb/config'
import { registrarMovimiento } from '@/lib/financial-writes'
import {
  AlertCircle,
  CheckCircle2,
  X,
  CreditCard,
  Banknote,
  ArrowRightLeft,
  ChevronDown,
  ChevronUp,
} from 'lucide-react'

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
  tipo?: 'cliente_pagara' | 'se_pierde'
}

type CobroDelivery = {
  monto: number
  tipoCliente: 'contado' | 'credito'
  quienPaga: string
  estado: 'pendiente' | 'pagado' | 'no_cobrar'
  registradoAt?: Timestamp
  pagadoAt?: Timestamp
  semanaKey?: string
  formaPago?: 'efectivo' | 'transferencia' | string
  notaPago?: string
}

type Solicitud = {
  id: string
  createdAt?: Timestamp
  entregadoAt?: Timestamp
  cobroPendiente?: boolean
  cobroDelivery?: CobroDelivery
  ownerSnapshot?: { uid?: string; companyName?: string; nombre?: string }
  userId?: string
  tipoCliente?: 'contado' | 'credito'
  pagoDelivery?: { quienPaga?: string; tipo?: string }
  asignacion?: { motorizadoNombre?: string; motorizadoId?: string } | null
  cobrosMotorizado?: {
    delivery?: CobroItem
    producto?: CobroItem
    resolucion?: Resolucion
  }
}

type CobroSemanal = {
  id: string
  clienteUid: string
  clienteNombre: string
  clienteCompany: string
  semanaKey: string
  semanaInicio?: Timestamp
  semanaFin?: Timestamp
  totalMonto: number
  totalPagado: number
  estado: 'pendiente' | 'parcial' | 'pagado'
  pagos: Array<{ monto: number; at: Timestamp; nota?: string; registradoPor: string }>
  ordenesIds: string[]
}

type MainTab = 'contado' | 'credito' | 'incidencias'
type ContadoSub = 'por_orden' | 'por_cliente' | 'pagados'
type IncidenciasTab = 'pendientes' | 'resueltos'

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

function fmtDateShort(v: any) {
  if (!v) return '—'
  const d = typeof v?.toDate === 'function' ? v.toDate() : v instanceof Date ? v : null
  if (!d) return '—'
  return d.toLocaleDateString('es-NI', { day: '2-digit', month: 'short' })
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

function formatSemanaDisplay(semanaKey: string): string {
  try {
    const { inicio, fin } = getSemanaRange(semanaKey)
    const opts: Intl.DateTimeFormatOptions = { day: '2-digit', month: 'short' }
    return `${inicio.toLocaleDateString('es-NI', opts)} – ${fin.toLocaleDateString('es-NI', opts)}`
  } catch {
    return semanaKey
  }
}

function getClienteNombre(s: Solicitud, nombres: Record<string, string> = {}) {
  return (
    s.ownerSnapshot?.companyName ||
    s.ownerSnapshot?.nombre ||
    (s.userId ? nombres[s.userId] : undefined) ||
    s.userId?.slice(0, 8) ||
    '—'
  )
}

function getClienteUid(s: Solicitud) {
  return (s.ownerSnapshot as any)?.uid || s.userId || '__sin'
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

// ─── Estilos compartidos ──────────────────────────────────────────────────────

const thCls = 'px-4 py-3 text-left text-[11px] font-semibold uppercase tracking-wide text-gray-500'
const tdCls = 'px-4 py-3 text-sm text-gray-700'

function btnTab(active: boolean) {
  return `px-4 py-2 rounded-lg text-sm font-semibold border transition ${
    active ? 'bg-[#004aad] text-white border-[#004aad]' : 'bg-white text-gray-600 border-gray-200 hover:bg-gray-50'
  }`
}

// ─── Resolve Modal (Incidencias) ──────────────────────────────────────────────

function ResolveModal({
  solicitud,
  onClose,
}: {
  solicitud: Solicitud
  onClose: () => void
}) {
  const [tipo, setTipo] = useState<'cliente_pagara' | 'se_pierde' | null>(null)
  const [nota, setNota] = useState('')
  const [saving, setSaving] = useState(false)
  const [err, setErr] = useState<string | null>(null)

  async function handleResolver() {
    if (!tipo) return
    setSaving(true); setErr(null)
    try {
      const uid = auth.currentUser?.uid || 'desconocido'
      const updates: any = {
        cobroPendiente: false,
        'cobrosMotorizado.resolucion': {
          resueltoPor: uid,
          at: serverTimestamp(),
          nota: nota.trim() || null,
          tipo,
        },
      }
      if (tipo === 'cliente_pagara') {
        // Asegurar que cobroDelivery quede en estado pendiente
        if (!solicitud.cobroDelivery) {
          updates['cobroDelivery.estado'] = 'pendiente'
          updates['cobroDelivery.registradoAt'] = serverTimestamp()
        } else if (solicitud.cobroDelivery.estado === 'no_cobrar') {
          updates['cobroDelivery.estado'] = 'pendiente'
        }
      } else {
        updates['cobroDelivery.estado'] = 'no_cobrar'
      }
      await updateDoc(doc(db, 'solicitudes_envio', solicitud.id), updates)
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
          <h3 className="text-base font-black text-gray-900">Resolver incidencia</h3>
          <button onClick={onClose} className="w-8 h-8 grid place-items-center rounded-full border border-gray-200 hover:bg-gray-50">
            <X className="h-4 w-4 text-gray-500" />
          </button>
        </div>
        <p className="text-sm text-gray-500 mb-4">¿Cómo se resuelve este cobro pendiente?</p>

        {/* Opción A */}
        <button
          onClick={() => setTipo('cliente_pagara')}
          className={`w-full text-left rounded-xl border-2 px-4 py-3 mb-3 transition ${
            tipo === 'cliente_pagara' ? 'border-[#004aad] bg-blue-50' : 'border-gray-200 hover:border-gray-300'
          }`}
        >
          <p className={`text-sm font-semibold ${tipo === 'cliente_pagara' ? 'text-[#004aad]' : 'text-gray-800'}`}>
            Cliente pagará después
          </p>
          <p className="text-xs text-gray-500 mt-0.5">Pasa al módulo de Cobros para seguimiento</p>
        </button>

        {/* Opción B */}
        <button
          onClick={() => setTipo('se_pierde')}
          className={`w-full text-left rounded-xl border-2 px-4 py-3 mb-4 transition ${
            tipo === 'se_pierde' ? 'border-red-400 bg-red-50' : 'border-gray-200 hover:border-gray-300'
          }`}
        >
          <p className={`text-sm font-semibold ${tipo === 'se_pierde' ? 'text-red-600' : 'text-gray-800'}`}>
            Se pierde
          </p>
          <p className="text-xs text-gray-500 mt-0.5">No se cobrará este monto</p>
        </button>

        <textarea
          value={nota}
          onChange={(e) => setNota(e.target.value)}
          placeholder="Nota opcional sobre la resolución…"
          className="w-full border border-gray-200 rounded-xl px-3 py-2.5 text-sm resize-none h-20 focus:outline-none focus:ring-2 focus:ring-[#004aad]/30 focus:border-[#004aad]"
        />
        {err && <p className="text-xs text-red-600 mt-1">{err}</p>}
        <div className="flex gap-2 mt-4">
          <button onClick={onClose} className="flex-1 border border-gray-200 text-gray-600 text-sm font-semibold py-2.5 rounded-xl hover:bg-gray-50 transition">
            Cancelar
          </button>
          <button
            onClick={handleResolver}
            disabled={saving || !tipo}
            className="flex-1 bg-[#004aad] text-white text-sm font-semibold py-2.5 rounded-xl hover:bg-[#0a49a4] transition disabled:opacity-40"
          >
            {saving ? 'Guardando…' : 'Confirmar'}
          </button>
        </div>
      </div>
    </div>
  )
}

// ─── Pago Modal (Crédito) ─────────────────────────────────────────────────────

function PagoModal({
  cobroSemanal,
  onClose,
}: {
  cobroSemanal: CobroSemanal
  onClose: () => void
}) {
  const [monto, setMonto] = useState('')
  const [nota, setNota] = useState('')
  const [saving, setSaving] = useState(false)
  const [err, setErr] = useState<string | null>(null)

  const pendiente = cobroSemanal.totalMonto - cobroSemanal.totalPagado
  const montoNum = parseFloat(monto) || 0

  async function handlePago() {
    if (!montoNum || montoNum <= 0) { setErr('Ingresa un monto válido'); return }
    setSaving(true); setErr(null)
    try {
      const uid = auth.currentUser?.uid || 'desconocido'
      const nuevoPagado = cobroSemanal.totalPagado + montoNum
      const nuevoEstado: CobroSemanal['estado'] =
        nuevoPagado >= cobroSemanal.totalMonto ? 'pagado' : nuevoPagado > 0 ? 'parcial' : 'pendiente'

      const pagoEntry = {
        monto: montoNum,
        at: Timestamp.now(),
        nota: nota.trim() || null,
        registradoPor: uid,
      }
      await updateDoc(doc(db, 'cobros_semanales', cobroSemanal.id), {
        totalPagado: increment(montoNum),
        estado: nuevoEstado,
        pagos: arrayUnion(pagoEntry),
        updatedAt: serverTimestamp(),
      })
      await registrarMovimiento('pago_recibido', montoNum, uid,
        `Pago crédito semanal · ${cobroSemanal.clienteCompany || cobroSemanal.clienteNombre} · sem ${cobroSemanal.semanaKey}`,
        { comercioId: cobroSemanal.clienteUid })
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
          <div>
            <h3 className="text-base font-black text-gray-900">Registrar pago</h3>
            <p className="text-xs text-gray-500 mt-0.5">
              {cobroSemanal.clienteCompany || cobroSemanal.clienteNombre} · {formatSemanaDisplay(cobroSemanal.semanaKey)}
            </p>
          </div>
          <button onClick={onClose} className="w-8 h-8 grid place-items-center rounded-full border border-gray-200 hover:bg-gray-50">
            <X className="h-4 w-4 text-gray-500" />
          </button>
        </div>

        <div className="grid grid-cols-2 gap-2 mb-4">
          <div className="bg-gray-50 rounded-xl px-3 py-2">
            <p className="text-xs text-gray-500">Total</p>
            <p className="text-sm font-bold text-gray-900">{fmt(cobroSemanal.totalMonto)}</p>
          </div>
          <div className="bg-orange-50 rounded-xl px-3 py-2">
            <p className="text-xs text-orange-500">Pendiente</p>
            <p className="text-sm font-bold text-orange-700">{fmt(pendiente)}</p>
          </div>
        </div>

        <label className="block text-xs font-semibold text-gray-600 mb-1">Monto a registrar (C$)</label>
        <input
          type="number"
          min="0"
          step="0.01"
          value={monto}
          onChange={(e) => setMonto(e.target.value)}
          placeholder={`Máx. ${pendiente}`}
          className="w-full border border-gray-200 rounded-xl px-3 py-2.5 text-sm focus:outline-none focus:ring-2 focus:ring-[#004aad]/30 focus:border-[#004aad] mb-3"
        />
        <textarea
          value={nota}
          onChange={(e) => setNota(e.target.value)}
          placeholder="Nota opcional (referencia, banco, etc.)"
          className="w-full border border-gray-200 rounded-xl px-3 py-2.5 text-sm resize-none h-16 focus:outline-none focus:ring-2 focus:ring-[#004aad]/30 focus:border-[#004aad]"
        />
        {err && <p className="text-xs text-red-600 mt-1">{err}</p>}
        <div className="flex gap-2 mt-4">
          <button onClick={onClose} className="flex-1 border border-gray-200 text-gray-600 text-sm font-semibold py-2.5 rounded-xl hover:bg-gray-50 transition">
            Cancelar
          </button>
          <button
            onClick={handlePago}
            disabled={saving || !montoNum}
            className="flex-1 bg-green-600 text-white text-sm font-semibold py-2.5 rounded-xl hover:bg-green-700 transition disabled:opacity-40"
          >
            {saving ? 'Guardando…' : '✓ Registrar pago'}
          </button>
        </div>
      </div>
    </div>
  )
}

// ─── Pago Contado Modal ───────────────────────────────────────────────────────

function PagoContadoModal({
  orden,
  nombres,
  onClose,
}: {
  orden: Solicitud
  nombres: Record<string, string>
  onClose: () => void
}) {
  const [formaPago, setFormaPago] = useState<string>('')
  const [nota, setNota] = useState('')
  const [saving, setSaving] = useState(false)
  const [err, setErr] = useState<string | null>(null)

  const monto = orden.cobroDelivery?.monto ?? (orden as any).confirmacion?.precioFinalCordobas
  const nombre = getClienteNombre(orden, nombres)

  async function handleConfirmar() {
    if (!formaPago) { setErr('Selecciona la forma de cobro'); return }
    setSaving(true); setErr(null)
    try {
      const uid = auth.currentUser?.uid || 'desconocido'
      const montoFinal = monto ?? 0
      const updates: any = {
        'cobroDelivery.estado': 'pagado',
        'cobroDelivery.pagadoAt': serverTimestamp(),
        'cobroDelivery.formaPago': formaPago,
        'cobroDelivery.confirmadoPor': uid,
        'cobroDelivery.confirmadoAt': serverTimestamp(),
        'cobroDelivery.metodoPagoReal': formaPago === 'efectivo' ? 'efectivo' : 'transferencia_deposito',
      }
      if (nota.trim()) updates['cobroDelivery.notaPago'] = nota.trim()
      if (!orden.cobroDelivery) {
        updates['cobroDelivery.monto'] = (orden as any).confirmacion?.precioFinalCordobas ?? 0
        updates['cobroDelivery.tipoCliente'] = orden.tipoCliente || 'contado'
        updates['cobroDelivery.quienPaga'] = orden.pagoDelivery?.quienPaga || ''
        updates['cobroDelivery.registradoAt'] = serverTimestamp()
      }

      if (formaPago === 'transferencia') {
        // Crear registro de depósito por transferencia del cliente
        const depositoRef = doc(collection(db, 'ordenes_deposito'))
        const depositoId = depositoRef.id
        const b = writeBatch(db)
        b.set(depositoRef, {
          creadoAt: serverTimestamp(),
          tipo: 'pago_delivery_deposito',
          estado: 'confirmado',
          destinatario: 'storkhub',
          destinatarioId: 'storkhub',
          destinatarioNombre: 'Storkhub',
          cuentasDestino: [],
          motorizadoUid: orden.asignacion?.motorizadoId ?? '',
          motorizadoNombre: orden.asignacion?.motorizadoNombre ?? '',
          solicitudIds: [orden.id],
          montoTotal: montoFinal,
          confirmadoMotorizado: false,
          confirmadoGestor: true,
          confirmadoGestorAt: serverTimestamp(),
          confirmadoGestorUid: uid,
          metadata: { referencia: nota.trim() || null, clienteNombre: nombre },
        })
        b.update(doc(db, 'solicitudes_envio', orden.id), {
          ...updates,
          'registro.deposito.confirmadoStorkhub': true,
          'registro.deposito.confirmadoStorkhubAt': serverTimestamp(),
          'registro.deposito.storkhubDepositoId': depositoId,
        })
        await b.commit()
        await registrarMovimiento('pago_recibido', montoFinal, uid,
          `Pago delivery por transferencia confirmado · ${nombre}`,
          { solicitudId: orden.id, depositoId })
      } else {
        await updateDoc(doc(db, 'solicitudes_envio', orden.id), updates)
        await registrarMovimiento('pago_recibido', montoFinal, uid,
          `Pago contado confirmado · ${nombre} · ${formaPago}`,
          { solicitudId: orden.id })
      }
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
        <div className="flex items-center justify-between mb-1">
          <h3 className="text-base font-black text-gray-900">Confirmar cobro</h3>
          <button onClick={onClose} className="w-8 h-8 grid place-items-center rounded-full border border-gray-200 hover:bg-gray-50">
            <X className="h-4 w-4 text-gray-500" />
          </button>
        </div>
        <p className="text-xs text-gray-500 mb-4">
          Orden <span className="font-mono">{orden.id.slice(0, 8)}</span> · {nombre} · <span className="font-semibold text-gray-700">{fmt(monto)}</span>
        </p>

        <p className="text-xs font-semibold text-gray-600 mb-2">Forma de cobro</p>
        <div className="grid grid-cols-2 gap-2 mb-3">
          {([
            { value: 'efectivo', label: 'Efectivo', Icon: Banknote },
            { value: 'transferencia', label: 'Transferencia', Icon: ArrowRightLeft },
          ] as const).map(({ value, label, Icon }) => (
            <button
              key={value}
              onClick={() => setFormaPago(value)}
              className={`flex items-center gap-2 rounded-xl border-2 px-3 py-2.5 transition ${
                formaPago === value ? 'border-[#004aad] bg-blue-50' : 'border-gray-200 hover:border-gray-300'
              }`}
            >
              <Icon className={`h-4 w-4 ${formaPago === value ? 'text-[#004aad]' : 'text-gray-400'}`} />
              <span className={`text-sm font-semibold ${formaPago === value ? 'text-[#004aad]' : 'text-gray-700'}`}>{label}</span>
            </button>
          ))}
        </div>

        <textarea
          value={nota}
          onChange={(e) => setNota(e.target.value)}
          placeholder="Nota opcional (ej. referencia de transferencia, fecha, etc.)"
          className="w-full border border-gray-200 rounded-xl px-3 py-2.5 text-sm resize-none h-16 focus:outline-none focus:ring-2 focus:ring-[#004aad]/30 focus:border-[#004aad]"
        />
        {err && <p className="text-xs text-red-600 mt-1">{err}</p>}
        <div className="flex gap-2 mt-4">
          <button onClick={onClose} className="flex-1 border border-gray-200 text-gray-600 text-sm font-semibold py-2.5 rounded-xl hover:bg-gray-50 transition">
            Cancelar
          </button>
          <button
            onClick={handleConfirmar}
            disabled={saving || !formaPago}
            className="flex-1 bg-green-600 text-white text-sm font-semibold py-2.5 rounded-xl hover:bg-green-700 transition disabled:opacity-40"
          >
            {saving ? 'Guardando…' : '✓ Confirmar pago'}
          </button>
        </div>
      </div>
    </div>
  )
}

// ─── Estado badge ─────────────────────────────────────────────────────────────

function EstadoBadge({ estado }: { estado: CobroSemanal['estado'] }) {
  const styles = {
    pendiente: 'bg-orange-50 text-orange-700 border-orange-200',
    parcial: 'bg-yellow-50 text-yellow-700 border-yellow-200',
    pagado: 'bg-green-50 text-green-700 border-green-200',
  }
  const labels = { pendiente: 'Pendiente', parcial: 'Parcial', pagado: 'Pagado' }
  return (
    <span className={`inline-flex text-xs font-semibold px-2 py-0.5 rounded-full border ${styles[estado]}`}>
      {labels[estado]}
    </span>
  )
}

// ─── Main ─────────────────────────────────────────────────────────────────────

export default function CobrosPage() {
  const [mainTab, setMainTab] = useState<MainTab>('contado')
  const [contadoSub, setContadoSub] = useState<ContadoSub>('por_orden')
  const [incidenciasTab, setIncidenciasTab] = useState<IncidenciasTab>('pendientes')

  // Contado: todas las órdenes entregadas (filtramos client-side para capturar históricas)
  const [contadoRaw, setContadoRaw] = useState<Solicitud[]>([])
  const [loadingContado, setLoadingContado] = useState(true)

  // Crédito: cobros_semanales
  const [cobrosSemanales, setCobrosSemanales] = useState<CobroSemanal[]>([])
  const [loadingCredito, setLoadingCredito] = useState(true)

  // Incidencias
  const [incidencias, setIncidencias] = useState<Solicitud[]>([])
  const [loadingIncidencias, setLoadingIncidencias] = useState(true)

  // Nombres de comercios faltantes (fallback desde colección usuarios)
  const [comercioNames, setComercioNames] = useState<Record<string, string>>({})

  // Modales
  const [resolvingIncidencia, setResolvingIncidencia] = useState<Solicitud | null>(null)
  const [pagandoSemana, setPagandoSemana] = useState<CobroSemanal | null>(null)
  const [marcandoPago, setMarcandoPago] = useState<Solicitud | null>(null)
  const [expandedSemana, setExpandedSemana] = useState<string | null>(null)

  // ── Queries ────────────────────────────────────────────────────────────────

  useEffect(() => {
    // Traer todas las órdenes entregadas para cubrir históricas (sin cobroDelivery)
    // y las nuevas con cobroDelivery.estado=pendiente
    const q = query(
      collection(db, 'solicitudes_envio'),
      where('estado', '==', 'entregado')
    )
    return onSnapshot(q, (snap) => {
      const rows = snap.docs
        .map((d) => ({ id: d.id, ...(d.data() as any) } as Solicitud))
        .sort((a, b) => (b.entregadoAt?.toMillis?.() || 0) - (a.entregadoAt?.toMillis?.() || 0))
      setContadoRaw(rows)
      setLoadingContado(false)
    })
  }, [])

  useEffect(() => {
    const q = query(
      collection(db, 'cobros_semanales'),
      where('estado', 'in', ['pendiente', 'parcial'])
    )
    return onSnapshot(q, (snap) => {
      const rows = snap.docs
        .map((d) => ({ id: d.id, ...(d.data() as any) } as CobroSemanal))
        .sort((a, b) => b.semanaKey.localeCompare(a.semanaKey))
      setCobrosSemanales(rows)
      setLoadingCredito(false)
    })
  }, [])

  useEffect(() => {
    const qPending = query(collection(db, 'solicitudes_envio'), where('cobroPendiente', '==', true))
    const qResolved = query(collection(db, 'solicitudes_envio'), where('cobroPendiente', '==', false))
    const map = new Map<string, Solicitud>()

    const unsubP = onSnapshot(qPending, (snap) => {
      snap.docs.forEach((d) => map.set(d.id, { id: d.id, ...(d.data() as any) }))
      setIncidencias([...map.values()])
      setLoadingIncidencias(false)
    })
    const unsubR = onSnapshot(qResolved, (snap) => {
      snap.docs.forEach((d) => {
        const data = d.data() as any
        if (data?.cobrosMotorizado?.resolucion) map.set(d.id, { id: d.id, ...data })
      })
      setIncidencias([...map.values()])
      setLoadingIncidencias(false)
    })
    return () => { unsubP(); unsubR() }
  }, [])

  // ── Cargar nombres faltantes desde usuarios ────────────────────────────────

  useEffect(() => {
    const missing = [...new Set(
      contadoRaw
        .filter((s) => !s.ownerSnapshot?.companyName && !s.ownerSnapshot?.nombre && s.userId)
        .map((s) => s.userId!)
    )].filter((uid) => !comercioNames[uid])

    if (missing.length === 0) return

    Promise.all(missing.map((uid) => getDoc(doc(db, 'usuarios', uid)))).then((snaps) => {
      const updates: Record<string, string> = {}
      snaps.forEach((snap, i) => {
        const data = snap.exists() ? (snap.data() as any) : null
        updates[missing[i]] = data?.companyName || data?.name || data?.nombre || missing[i].slice(0, 8)
      })
      setComercioNames((prev) => ({ ...prev, ...updates }))
    })
  }, [contadoRaw])

  // ── Derived state ──────────────────────────────────────────────────────────

  // Filtrar contado pendientes — solo órdenes con razón explícita de cobro
  const contadoOrdenes = useMemo(() =>
    contadoRaw.filter((s) => {
      // Excluir crédito
      if (s.tipoCliente === 'credito' || s.pagoDelivery?.quienPaga === 'credito_semanal') return false

      // Excluir incidencias activas (van en tab Incidencias)
      if (s.cobroPendiente === true) return false

      const cd = s.cobroDelivery

      // Excluir ya pagadas o no cobrar
      if (cd?.estado === 'pagado' || cd?.estado === 'no_cobrar') return false

      // ✅ Mostrar: el sistema lo marcó explícitamente como pendiente
      // (nuevo sistema: se escribe al marcar entregado, o desde resolución de incidencia)
      if (cd?.estado === 'pendiente') return true

      // ✅ Mostrar: transferencia bancaria aún no confirmada
      // (el cliente debe depositar a Storkhub, no pasa por el motorizado)
      if (s.pagoDelivery?.quienPaga === 'transferencia') return true

      // Todo lo demás (legacy, efectivo ya cobrado por motorizado, etc.) → NO mostrar
      // Las órdenes históricas donde el motorizado cobró en efectivo
      // ya están manejadas por el flujo de depósito.
      return false
    }),
    [contadoRaw]
  )

  const incidenciasPendientes = useMemo(() =>
    incidencias
      .filter((s) => {
        if (s.cobroPendiente !== true) return false
        // Solo mostrar si realmente hay un cobro no recibido.
        // Si cobroPendiente quedó stale (motorizado eventualmente cobró todo), no mostrar.
        const d = s.cobrosMotorizado?.delivery
        const p = s.cobrosMotorizado?.producto
        const hayNoRecibido = (d != null && d.recibio === false) || (p != null && p.recibio === false)
        // Si no hay ningún cobro registrado todavía (motorizado aún no respondió), sí mostrar
        const hayCobroRegistrado = d != null || p != null
        return !hayCobroRegistrado || hayNoRecibido
      })
      .sort((a, b) => (b.createdAt?.toMillis?.() || 0) - (a.createdAt?.toMillis?.() || 0)),
    [incidencias]
  )

  const incidenciasResueltas = useMemo(() =>
    incidencias
      .filter((s) => s.cobroPendiente === false && s.cobrosMotorizado?.resolucion)
      .sort((a, b) => (b.cobrosMotorizado?.resolucion?.at?.toMillis?.() || 0) - (a.cobrosMotorizado?.resolucion?.at?.toMillis?.() || 0)),
    [incidencias]
  )

  // Agrupado por cliente + día (Contado)
  const contadoPorClienteDia = useMemo(() => {
    type Group = {
      key: string
      clienteUid: string
      clienteNombre: string
      fecha: string
      fechaRaw: any
      ordenes: Solicitud[]
      total: number
    }
    const map = new Map<string, Group>()
    contadoOrdenes.forEach((s) => {
      const uid = getClienteUid(s)
      const nombre = getClienteNombre(s, comercioNames)
      const fecha = fmtDate(s.entregadoAt)
      const key = `${uid}_${fecha}`
      if (!map.has(key)) map.set(key, { key, clienteUid: uid, clienteNombre: nombre, fecha, fechaRaw: s.entregadoAt, ordenes: [], total: 0 })
      const g = map.get(key)!
      g.ordenes.push(s)
      g.total += s.cobroDelivery?.monto || 0
    })
    return [...map.values()].sort((a, b) => (b.fechaRaw?.toMillis?.() || 0) - (a.fechaRaw?.toMillis?.() || 0))
  }, [contadoOrdenes, comercioNames])

  const totalContadoPendiente = useMemo(
    // Para históricas sin cobroDelivery, usar confirmacion.precioFinalCordobas
    () => contadoOrdenes.reduce((s, o) => s + (o.cobroDelivery?.monto ?? (o as any).confirmacion?.precioFinalCordobas ?? 0), 0),
    [contadoOrdenes]
  )

  // ── Acciones contado ───────────────────────────────────────────────────────

  // (marcarPagada es invocado desde PagoContadoModal — ver modal arriba)

  async function revertirPagada(orden: Solicitud) {
    await updateDoc(doc(db, 'solicitudes_envio', orden.id), {
      'cobroDelivery.estado': 'pendiente',
      'cobroDelivery.pagadoAt': deleteField(),
      'cobroDelivery.formaPago': deleteField(),
      'cobroDelivery.notaPago': deleteField(),
    })
  }

  // Contado pagados (historial)
  const contadoPagados = useMemo(() =>
    contadoRaw
      .filter((s) => {
        if (s.tipoCliente === 'credito' || s.pagoDelivery?.quienPaga === 'credito_semanal') return false
        return s.cobroDelivery?.estado === 'pagado'
      })
      .sort((a, b) => (b.cobroDelivery?.pagadoAt?.toMillis?.() || 0) - (a.cobroDelivery?.pagadoAt?.toMillis?.() || 0)),
    [contadoRaw]
  )

  async function marcarGrupoPagado(ordenes: Solicitud[], formaPago: string) {
    const b = writeBatch(db)
    ordenes.forEach((o) => {
      const updates: any = {
        'cobroDelivery.estado': 'pagado',
        'cobroDelivery.pagadoAt': serverTimestamp(),
        'cobroDelivery.formaPago': formaPago,
      }
      if (!o.cobroDelivery) {
        updates['cobroDelivery.monto'] = (o as any).confirmacion?.precioFinalCordobas ?? 0
        updates['cobroDelivery.tipoCliente'] = o.tipoCliente || 'contado'
        updates['cobroDelivery.quienPaga'] = o.pagoDelivery?.quienPaga || ''
        updates['cobroDelivery.registradoAt'] = serverTimestamp()
      }
      b.update(doc(db, 'solicitudes_envio', o.id), updates)
    })
    await b.commit()
  }

  // ── KPIs ───────────────────────────────────────────────────────────────────

  const kpis = [
    {
      label: 'Contado pendiente',
      value: loadingContado ? '…' : String(contadoOrdenes.length),
      sub: loadingContado ? '' : fmt(totalContadoPendiente),
      color: 'bg-blue-50 border-blue-200',
      valueColor: 'text-[#004aad]',
      subColor: 'text-blue-400',
    },
    {
      label: 'Crédito pendiente',
      value: loadingCredito ? '…' : String(cobrosSemanales.length),
      sub: loadingCredito ? '' : 'semanas activas',
      color: 'bg-purple-50 border-purple-200',
      valueColor: 'text-purple-700',
      subColor: 'text-purple-400',
    },
    {
      label: 'Incidencias activas',
      value: loadingIncidencias ? '…' : String(incidenciasPendientes.length),
      sub: '',
      color: incidenciasPendientes.length > 0 ? 'bg-red-50 border-red-200' : 'bg-gray-50 border-gray-200',
      valueColor: incidenciasPendientes.length > 0 ? 'text-red-600' : 'text-gray-500',
      subColor: 'text-gray-400',
    },
  ]

  // ── Render ─────────────────────────────────────────────────────────────────

  return (
    <div className="flex flex-col gap-4">
      {resolvingIncidencia && (
        <ResolveModal solicitud={resolvingIncidencia} onClose={() => setResolvingIncidencia(null)} />
      )}
      {pagandoSemana && (
        <PagoModal cobroSemanal={pagandoSemana} onClose={() => setPagandoSemana(null)} />
      )}
      {marcandoPago && (
        <PagoContadoModal orden={marcandoPago} nombres={comercioNames} onClose={() => setMarcandoPago(null)} />
      )}

      {/* Header */}
      <div>
        <h1 className="text-2xl font-black text-gray-900 tracking-tight flex items-center gap-2">
          <CreditCard className="h-6 w-6 text-[#004aad]" />
          Cobros
        </h1>
        <p className="text-sm text-gray-500 mt-0.5">
          Seguimiento de cobros de delivery por cliente.
        </p>
      </div>

      {/* KPIs */}
      <div className="grid grid-cols-3 gap-3">
        {kpis.map((k) => (
          <div key={k.label} className={`border rounded-xl px-4 py-3 ${k.color}`}>
            <p className={`text-2xl font-black ${k.valueColor}`}>{k.value}</p>
            <p className={`text-xs font-semibold mt-0.5 ${k.subColor}`}>{k.label}</p>
            {k.sub && <p className={`text-xs mt-0.5 ${k.subColor}`}>{k.sub}</p>}
          </div>
        ))}
      </div>

      {/* Main tabs */}
      <div className="flex gap-2 flex-wrap">
        <button onClick={() => setMainTab('contado')} className={btnTab(mainTab === 'contado')}>
          <Banknote className="inline h-4 w-4 mr-1.5 opacity-70" />
          Contado
          {!loadingContado && contadoOrdenes.length > 0 && (
            <span className="ml-1.5 inline-flex items-center justify-center w-5 h-5 rounded-full bg-[#004aad] text-white text-[10px] font-black">
              {contadoOrdenes.length > 99 ? '99+' : contadoOrdenes.length}
            </span>
          )}
        </button>
        <button onClick={() => setMainTab('credito')} className={btnTab(mainTab === 'credito')}>
          <ArrowRightLeft className="inline h-4 w-4 mr-1.5 opacity-70" />
          Crédito
          {!loadingCredito && cobrosSemanales.length > 0 && (
            <span className="ml-1.5 inline-flex items-center justify-center w-5 h-5 rounded-full bg-purple-600 text-white text-[10px] font-black">
              {cobrosSemanales.length > 99 ? '99+' : cobrosSemanales.length}
            </span>
          )}
        </button>
        <button onClick={() => setMainTab('incidencias')} className={btnTab(mainTab === 'incidencias')}>
          <AlertCircle className="inline h-4 w-4 mr-1.5 opacity-70" />
          Incidencias
          {!loadingIncidencias && incidenciasPendientes.length > 0 && (
            <span className="ml-1.5 inline-flex items-center justify-center w-5 h-5 rounded-full bg-red-500 text-white text-[10px] font-black">
              {incidenciasPendientes.length > 9 ? '9+' : incidenciasPendientes.length}
            </span>
          )}
        </button>
      </div>

      {/* ── TAB: CONTADO ─────────────────────────────────────────────────── */}
      {mainTab === 'contado' && (
        <div className="flex flex-col gap-3">
          {/* Sub-toggle */}
          <div className="flex gap-2 flex-wrap">
            <button
              onClick={() => setContadoSub('por_orden')}
              className={`px-3 py-1.5 rounded-lg text-xs font-semibold border transition ${
                contadoSub === 'por_orden' ? 'bg-gray-900 text-white border-gray-900' : 'bg-white text-gray-600 border-gray-200 hover:bg-gray-50'
              }`}
            >
              Por orden
            </button>
            <button
              onClick={() => setContadoSub('por_cliente')}
              className={`px-3 py-1.5 rounded-lg text-xs font-semibold border transition ${
                contadoSub === 'por_cliente' ? 'bg-gray-900 text-white border-gray-900' : 'bg-white text-gray-600 border-gray-200 hover:bg-gray-50'
              }`}
            >
              Por cliente / día
            </button>
            <button
              onClick={() => setContadoSub('pagados')}
              className={`px-3 py-1.5 rounded-lg text-xs font-semibold border transition ${
                contadoSub === 'pagados' ? 'bg-green-700 text-white border-green-700' : 'bg-white text-gray-600 border-gray-200 hover:bg-gray-50'
              }`}
            >
              Historial cobrados
              {contadoPagados.length > 0 && (
                <span className="ml-1.5 inline-flex items-center justify-center w-4 h-4 rounded-full bg-green-100 text-green-800 text-[10px] font-black">
                  {contadoPagados.length > 99 ? '99+' : contadoPagados.length}
                </span>
              )}
            </button>
          </div>

          {/* Por orden */}
          {contadoSub === 'por_orden' && (
            <div className="overflow-x-auto rounded-xl border border-gray-200 bg-white shadow-sm">
              {loadingContado ? (
                <div className="py-16 text-center text-sm text-gray-400">Cargando…</div>
              ) : contadoOrdenes.length === 0 ? (
                <div className="flex flex-col items-center justify-center py-16 gap-2 text-gray-400">
                  <CheckCircle2 className="h-10 w-10 opacity-30" />
                  <p className="text-sm font-medium">Sin cobros contado pendientes</p>
                </div>
              ) : (
                <table className="w-full text-sm">
                  <thead>
                    <tr className="border-b bg-gray-50">
                      <th className={thCls}>Entregado</th>
                      <th className={thCls}>Orden</th>
                      <th className={thCls}>Cliente</th>
                      <th className={thCls}>Forma pago</th>
                      <th className={`${thCls} text-right`}>Monto</th>
                      <th className={thCls}>Acción</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-gray-100">
                    {contadoOrdenes.map((s) => {
                      const esTransferencia = s.cobroDelivery?.quienPaga === 'transferencia' || s.pagoDelivery?.quienPaga === 'transferencia'
                      return (
                        <tr key={s.id} className="hover:bg-gray-50 transition-colors">
                          <td className={tdCls}>{fmtDate(s.entregadoAt)}</td>
                          <td className={`${tdCls} font-mono text-xs text-gray-400`}>{s.id.slice(0, 8)}</td>
                          <td className={`${tdCls} font-semibold text-gray-900`}>{getClienteNombre(s, comercioNames)}</td>
                          <td className={tdCls}>
                            {esTransferencia ? (
                              <span className="inline-flex items-center gap-1 text-xs font-semibold px-2 py-0.5 rounded-full bg-blue-50 text-blue-700 border border-blue-200">
                                <ArrowRightLeft className="h-3 w-3" /> Transferencia
                              </span>
                            ) : (
                              <span className="inline-flex items-center gap-1 text-xs font-semibold px-2 py-0.5 rounded-full bg-gray-100 text-gray-700 border border-gray-200">
                                <Banknote className="h-3 w-3" /> Efectivo
                              </span>
                            )}
                          </td>
                          <td className={`${tdCls} text-right font-semibold text-gray-900`}>
                            {fmt(s.cobroDelivery?.monto ?? (s as any).confirmacion?.precioFinalCordobas)}
                          </td>
                          <td className="px-4 py-3">
                            <button
                              onClick={() => setMarcandoPago(s)}
                              className="text-xs font-semibold px-3 py-1.5 rounded-lg bg-green-50 text-green-700 border border-green-200 hover:bg-green-100 transition"
                            >
                              Marcar pagada
                            </button>
                          </td>
                        </tr>
                      )
                    })}
                  </tbody>
                </table>
              )}
            </div>
          )}

          {/* Por cliente / día */}
          {contadoSub === 'por_cliente' && (
            <div className="overflow-x-auto rounded-xl border border-gray-200 bg-white shadow-sm">
              {loadingContado ? (
                <div className="py-16 text-center text-sm text-gray-400">Cargando…</div>
              ) : contadoPorClienteDia.length === 0 ? (
                <div className="flex flex-col items-center justify-center py-16 gap-2 text-gray-400">
                  <CheckCircle2 className="h-10 w-10 opacity-30" />
                  <p className="text-sm font-medium">Sin cobros contado pendientes</p>
                </div>
              ) : (
                <table className="w-full text-sm">
                  <thead>
                    <tr className="border-b bg-gray-50">
                      <th className={thCls}>Cliente</th>
                      <th className={thCls}>Fecha</th>
                      <th className={thCls}># Órdenes</th>
                      <th className={`${thCls} text-right`}>Total día</th>
                      <th className={thCls}>Acción</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-gray-100">
                    {contadoPorClienteDia.map((g) => (
                      <tr key={g.key} className="hover:bg-gray-50 transition-colors">
                        <td className={`${tdCls} font-semibold text-gray-900`}>{g.clienteNombre}</td>
                        <td className={tdCls}>{g.fecha}</td>
                        <td className={tdCls}>
                          <span className="inline-flex items-center justify-center w-6 h-6 rounded-full bg-gray-100 text-xs font-semibold text-gray-700">
                            {g.ordenes.length}
                          </span>
                        </td>
                        <td className={`${tdCls} text-right font-semibold text-gray-900`}>{fmt(g.total)}</td>
                        <td className="px-4 py-3">
                          <div className="flex gap-1.5">
                            <button
                              onClick={() => marcarGrupoPagado(g.ordenes, 'efectivo')}
                              className="text-xs font-semibold px-2.5 py-1.5 rounded-lg bg-green-50 text-green-700 border border-green-200 hover:bg-green-100 transition whitespace-nowrap"
                            >
                              <Banknote className="inline h-3 w-3 mr-1" />Efectivo
                            </button>
                            <button
                              onClick={() => marcarGrupoPagado(g.ordenes, 'transferencia')}
                              className="text-xs font-semibold px-2.5 py-1.5 rounded-lg bg-blue-50 text-blue-700 border border-blue-200 hover:bg-blue-100 transition whitespace-nowrap"
                            >
                              <ArrowRightLeft className="inline h-3 w-3 mr-1" />Trans.
                            </button>
                          </div>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}
            </div>
          )}

          {/* Historial cobrados */}
          {contadoSub === 'pagados' && (
            <div className="overflow-x-auto rounded-xl border border-gray-200 bg-white shadow-sm">
              {loadingContado ? (
                <div className="py-16 text-center text-sm text-gray-400">Cargando…</div>
              ) : contadoPagados.length === 0 ? (
                <div className="flex flex-col items-center justify-center py-16 gap-2 text-gray-400">
                  <CheckCircle2 className="h-10 w-10 opacity-30" />
                  <p className="text-sm font-medium">Sin cobros registrados aún</p>
                </div>
              ) : (
                <table className="w-full text-sm">
                  <thead>
                    <tr className="border-b bg-gray-50">
                      <th className={thCls}>Cobrado</th>
                      <th className={thCls}>Orden</th>
                      <th className={thCls}>Cliente</th>
                      <th className={thCls}>Forma</th>
                      <th className={thCls}>Nota</th>
                      <th className={`${thCls} text-right`}>Monto</th>
                      <th className={thCls}>Acción</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-gray-100">
                    {contadoPagados.map((s) => {
                      const fp = s.cobroDelivery?.formaPago
                      return (
                        <tr key={s.id} className="hover:bg-gray-50 transition-colors">
                          <td className={tdCls}>{fmtDate(s.cobroDelivery?.pagadoAt)}</td>
                          <td className={`${tdCls} font-mono text-xs text-gray-400`}>{s.id.slice(0, 8)}</td>
                          <td className={`${tdCls} font-semibold text-gray-900`}>{getClienteNombre(s, comercioNames)}</td>
                          <td className={tdCls}>
                            {fp === 'transferencia' ? (
                              <span className="inline-flex items-center gap-1 text-xs font-semibold px-2 py-0.5 rounded-full bg-blue-50 text-blue-700 border border-blue-200">
                                <ArrowRightLeft className="h-3 w-3" /> Trans.
                              </span>
                            ) : fp === 'efectivo' ? (
                              <span className="inline-flex items-center gap-1 text-xs font-semibold px-2 py-0.5 rounded-full bg-green-50 text-green-700 border border-green-200">
                                <Banknote className="h-3 w-3" /> Efectivo
                              </span>
                            ) : (
                              <span className="text-xs text-gray-400">—</span>
                            )}
                          </td>
                          <td className={`${tdCls} max-w-[160px]`}>
                            {s.cobroDelivery?.notaPago
                              ? <span className="text-xs text-gray-600 truncate block" title={s.cobroDelivery.notaPago}>{s.cobroDelivery.notaPago}</span>
                              : <span className="text-xs text-gray-300">—</span>
                            }
                          </td>
                          <td className={`${tdCls} text-right font-semibold text-green-700`}>
                            {fmt(s.cobroDelivery?.monto ?? (s as any).confirmacion?.precioFinalCordobas)}
                          </td>
                          <td className="px-4 py-3">
                            <button
                              onClick={() => revertirPagada(s)}
                              className="text-xs font-semibold px-3 py-1.5 rounded-lg bg-red-50 text-red-600 border border-red-200 hover:bg-red-100 transition"
                            >
                              Revertir
                            </button>
                          </td>
                        </tr>
                      )
                    })}
                  </tbody>
                </table>
              )}
            </div>
          )}
        </div>
      )}

      {/* ── TAB: CRÉDITO ─────────────────────────────────────────────────── */}
      {mainTab === 'credito' && (
        <div className="flex flex-col gap-3">
          {loadingCredito ? (
            <div className="bg-white rounded-xl border border-gray-200 py-16 text-center text-sm text-gray-400">Cargando…</div>
          ) : cobrosSemanales.length === 0 ? (
            <div className="bg-white rounded-xl border border-gray-200 flex flex-col items-center justify-center py-16 gap-2 text-gray-400">
              <CheckCircle2 className="h-10 w-10 opacity-30" />
              <p className="text-sm font-medium">Sin créditos semanales pendientes</p>
            </div>
          ) : (
            cobrosSemanales.map((cs) => {
              const pendiente = cs.totalMonto - cs.totalPagado
              const isExpanded = expandedSemana === cs.id
              return (
                <div key={cs.id} className="bg-white rounded-xl border border-gray-200 shadow-sm overflow-hidden">
                  <div className="px-4 py-3 flex items-center gap-3">
                    <div className="flex-1 min-w-0">
                      <p className="text-sm font-bold text-gray-900 truncate">
                        {cs.clienteCompany || cs.clienteNombre}
                      </p>
                      <p className="text-xs text-gray-500 mt-0.5">{formatSemanaDisplay(cs.semanaKey)}</p>
                    </div>
                    <div className="text-right hidden sm:block">
                      <p className="text-xs text-gray-400">Total</p>
                      <p className="text-sm font-semibold text-gray-800">{fmt(cs.totalMonto)}</p>
                    </div>
                    <div className="text-right hidden sm:block">
                      <p className="text-xs text-gray-400">Pagado</p>
                      <p className="text-sm font-semibold text-green-700">{fmt(cs.totalPagado)}</p>
                    </div>
                    <div className="text-right">
                      <p className="text-xs text-gray-400">Pendiente</p>
                      <p className="text-sm font-bold text-orange-700">{fmt(pendiente)}</p>
                    </div>
                    <EstadoBadge estado={cs.estado} />
                    <button
                      onClick={() => setPagandoSemana(cs)}
                      className="text-xs font-semibold px-3 py-1.5 rounded-lg bg-[#004aad] text-white hover:bg-[#0a49a4] transition whitespace-nowrap"
                    >
                      Registrar pago
                    </button>
                    <button
                      onClick={() => setExpandedSemana(isExpanded ? null : cs.id)}
                      className="text-gray-400 hover:text-gray-600 transition"
                      title="Ver órdenes"
                    >
                      {isExpanded ? <ChevronUp className="h-4 w-4" /> : <ChevronDown className="h-4 w-4" />}
                    </button>
                  </div>

                  {/* Detalle expandido */}
                  {isExpanded && (
                    <div className="border-t border-gray-100 px-4 py-3 bg-gray-50">
                      <p className="text-xs font-semibold text-gray-500 mb-2">
                        Órdenes incluidas ({cs.ordenesIds.length})
                      </p>
                      <div className="flex flex-wrap gap-1.5 mb-3">
                        {cs.ordenesIds.map((oid) => (
                          <span key={oid} className="font-mono text-xs bg-white border border-gray-200 rounded px-1.5 py-0.5 text-gray-600">
                            {oid.slice(0, 8)}
                          </span>
                        ))}
                      </div>
                      {cs.pagos.length > 0 && (
                        <>
                          <p className="text-xs font-semibold text-gray-500 mb-2">Pagos registrados</p>
                          <div className="space-y-1.5">
                            {cs.pagos.map((p, i) => (
                              <div key={i} className="flex items-center gap-3 text-xs text-gray-600">
                                <span className="font-semibold text-green-700">{fmt(p.monto)}</span>
                                <span className="text-gray-400">{fmtDateShort(p.at)}</span>
                                {p.nota && <span className="text-gray-500 truncate">{p.nota}</span>}
                              </div>
                            ))}
                          </div>
                        </>
                      )}
                    </div>
                  )}
                </div>
              )
            })
          )}
        </div>
      )}

      {/* ── TAB: INCIDENCIAS ─────────────────────────────────────────────── */}
      {mainTab === 'incidencias' && (
        <div className="flex flex-col gap-3">
          {/* Sub-tabs */}
          <div className="flex gap-2">
            <button onClick={() => setIncidenciasTab('pendientes')} className={btnTab(incidenciasTab === 'pendientes')}>
              Pendientes
              {!loadingIncidencias && incidenciasPendientes.length > 0 && (
                <span className="ml-1.5 inline-flex items-center justify-center w-5 h-5 rounded-full bg-red-500 text-white text-[10px] font-black">
                  {incidenciasPendientes.length > 9 ? '9+' : incidenciasPendientes.length}
                </span>
              )}
            </button>
            <button onClick={() => setIncidenciasTab('resueltos')} className={btnTab(incidenciasTab === 'resueltos')}>
              Resueltos
            </button>
          </div>

          {/* Tabla */}
          <div className="overflow-x-auto rounded-xl border border-gray-200 bg-white shadow-sm">
            {loadingIncidencias ? (
              <div className="py-16 text-center text-sm text-gray-400">Cargando…</div>
            ) : (incidenciasTab === 'pendientes' ? incidenciasPendientes : incidenciasResueltas).length === 0 ? (
              <div className="flex flex-col items-center justify-center py-16 gap-2 text-gray-400">
                <CheckCircle2 className="h-10 w-10 opacity-30" />
                <p className="text-sm font-medium">
                  {incidenciasTab === 'pendientes' ? 'Sin incidencias pendientes' : 'No hay casos resueltos aún'}
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
                    {incidenciasTab === 'pendientes' && <th className={thCls}>Acción</th>}
                    {incidenciasTab === 'resueltos' && <th className={thCls}>Resolución</th>}
                  </tr>
                </thead>
                <tbody className="divide-y divide-gray-100">
                  {(incidenciasTab === 'pendientes' ? incidenciasPendientes : incidenciasResueltas).map((s) => {
                    const comercio = s.ownerSnapshot?.companyName || s.ownerSnapshot?.nombre || s.userId?.slice(0, 8) || '—'
                    const motorizado = s.asignacion?.motorizadoNombre || s.asignacion?.motorizadoId?.slice(0, 8) || '—'
                    const tipo = getTipoCobro(s)
                    const monto = getMontoPendiente(s)
                    const justs = getJustificaciones(s)
                    const resolucion = s.cobrosMotorizado?.resolucion
                    return (
                      <tr key={s.id} className="hover:bg-gray-50 transition-colors">
                        <td className={tdCls}>
                          {incidenciasTab === 'resueltos'
                            ? fmtDate(s.cobrosMotorizado?.resolucion?.at)
                            : fmtDate(s.createdAt)}
                        </td>
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
                        {incidenciasTab === 'pendientes' && (
                          <td className="px-4 py-3">
                            <button
                              onClick={() => setResolvingIncidencia(s)}
                              className="text-xs font-semibold px-3 py-1.5 rounded-lg bg-[#004aad] text-white hover:bg-[#0a49a4] transition"
                            >
                              Resolver
                            </button>
                          </td>
                        )}
                        {incidenciasTab === 'resueltos' && (
                          <td className={`${tdCls} max-w-[180px]`}>
                            {resolucion?.tipo === 'cliente_pagara' ? (
                              <p className="text-xs text-blue-700 font-semibold">→ Pasa a Cobros</p>
                            ) : resolucion?.tipo === 'se_pierde' ? (
                              <p className="text-xs text-red-600 font-semibold">✗ Se perdió</p>
                            ) : (
                              <p className="text-xs text-green-700 font-semibold">✓ Resuelto</p>
                            )}
                            <p className="text-xs text-gray-400 truncate">{fmtDate(resolucion?.at)}</p>
                            {resolucion?.nota && (
                              <p className="text-xs text-gray-500 truncate" title={resolucion.nota}>
                                {resolucion.nota}
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
      )}
    </div>
  )
}
