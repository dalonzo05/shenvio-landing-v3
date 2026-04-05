'use client'

import { useEffect, useMemo, useState } from 'react'
import {
  collection,
  onSnapshot,
  query,
  where,
  doc,
  getDoc,
  writeBatch,
  serverTimestamp,
  Timestamp,
} from 'firebase/firestore'
import { db } from '@/fb/config'
import {
  Wallet,
  CheckCircle2,
  ChevronDown,
  ChevronUp,
  Landmark,
  Store,
  Clock,
} from 'lucide-react'
import { SolicitudDrawer } from '../_components/SolicitudDrawer'

// ─── Types ────────────────────────────────────────────────────────────────────

type Solicitud = {
  id: string
  estado?: string
  tipoCliente?: 'contado' | 'credito'
  createdAt?: Timestamp
  entregadoAt?: Timestamp
  historial?: { entregadoAt?: Timestamp }
  asignacion?: {
    motorizadoId?: string
    motorizadoAuthUid?: string
    motorizadoNombre?: string
  } | null
  ownerSnapshot?: { companyName?: string; nombre?: string; uid?: string; phone?: string }
  userId?: string
  entrega?: { nombreApellido?: string; direccionEscrita?: string; celular?: string }
  cobroContraEntrega?: { aplica?: boolean; monto?: number }
  confirmacion?: { precioFinalCordobas?: number }
  pagoDelivery?: {
    quienPaga?: string
    deducirDelCobroContraEntrega?: boolean
  }
  registro?: {
    deposito?: {
      confirmadoMotorizado?: boolean
      confirmadoAt?: Timestamp
      confirmadoComercio?: boolean
      confirmadoComercioAt?: Timestamp
      confirmadoStorkhub?: boolean
      confirmadoStorkhubAt?: Timestamp
    }
  }
}

type DepositoCalc = {
  totalAlComercio: number
  totalAStorkhub: number
}

type GrupoStorkhub = {
  ordenes: Solicitud[]
  total: number
}

type GrupoComercio = {
  uid: string
  nombre: string
  ordenes: Solicitud[]
  total: number
}

type GrupoMotorizado = {
  motorizadoId: string
  motorizadoNombre: string
  storkhub: GrupoStorkhub
  comercios: GrupoComercio[]
}

type MainTab = 'pendientes' | 'historial'

// Entrada de historial: una confirmación individual (storkhub o comercio) por orden
type HistorialEntry = {
  ordenId: string
  motorizadoNombre: string
  destino: string       // 'Storkhub' o nombre del comercio
  tipo: 'delivery' | 'producto'
  monto: number
  fechaConfirmacion: Timestamp
  ordenCompleta: boolean // ambos destinos confirmados
}

// ─── calcDeposito ─────────────────────────────────────────────────────────────

function calcDeposito(s: Solicitud): DepositoCalc {
  const ceAplica = !!s.cobroContraEntrega?.aplica
  const montoProducto = ceAplica ? (s.cobroContraEntrega?.monto || 0) : 0
  const precioDelivery = s.confirmacion?.precioFinalCordobas || 0
  const quienPaga = s.pagoDelivery?.quienPaga || ''
  const deducir = !!s.pagoDelivery?.deducirDelCobroContraEntrega
  const esPorTransferencia = quienPaga === 'transferencia'
  const esCredito = s.tipoCliente === 'credito' || quienPaga === 'credito_semanal'
  const motorizadoRecaudeDelivery = !esPorTransferencia && !esCredito && precioDelivery > 0
  const productoNeto = deducir ? Math.max(0, montoProducto - precioDelivery) : montoProducto
  return {
    totalAlComercio: productoNeto,
    totalAStorkhub: esPorTransferencia || esCredito ? 0 : (motorizadoRecaudeDelivery ? precioDelivery : 0),
  }
}

function tieneDepositoPendiente(s: Solicitud): boolean {
  const dep = calcDeposito(s)
  if (dep.totalAlComercio === 0 && dep.totalAStorkhub === 0) return false
  if (s.registro?.deposito?.confirmadoMotorizado) return false // legacy
  const comercioOk = dep.totalAlComercio === 0 || !!s.registro?.deposito?.confirmadoComercio
  const storkhubOk = dep.totalAStorkhub === 0 || !!s.registro?.deposito?.confirmadoStorkhub
  return !comercioOk || !storkhubOk
}

// ─── Helpers visuales ─────────────────────────────────────────────────────────

function fmt(n: number) {
  return `C$ ${n.toLocaleString('es-NI')}`
}

function fmtDateTime(v: any): string {
  if (!v) return '—'
  const d = typeof v?.toDate === 'function' ? v.toDate() : v instanceof Date ? v : null
  if (!d) return '—'
  return d.toLocaleString('es-NI', { day: '2-digit', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' })
}

function fmtDate(v: any): string {
  if (!v) return '—'
  const d = typeof v?.toDate === 'function' ? v.toDate() : v instanceof Date ? v : null
  if (!d) return '—'
  return d.toLocaleDateString('es-NI', { day: '2-digit', month: 'short', year: 'numeric' })
}

function isToday(ts: Timestamp | undefined): boolean {
  if (!ts) return false
  const d = ts.toDate()
  const now = new Date()
  return d.getFullYear() === now.getFullYear() && d.getMonth() === now.getMonth() && d.getDate() === now.getDate()
}

function getEntregadoAt(s: Solicitud): Timestamp | undefined {
  return (s as any).entregadoAt || s.historial?.entregadoAt
}

function getNombreComercio(s: Solicitud, names: Record<string, string> = {}): string {
  return s.ownerSnapshot?.companyName || s.ownerSnapshot?.nombre || (s.userId ? names[s.userId] : undefined) || '—'
}

// ─── Estilos ──────────────────────────────────────────────────────────────────

const thCls = 'px-3 py-2 text-left text-[11px] font-semibold uppercase tracking-wide text-gray-500'
const tdCls = 'px-3 py-2.5 text-xs text-gray-700'

// ─── Main ─────────────────────────────────────────────────────────────────────

export default function DepositosPage() {
  const [tab, setTab] = useState<MainTab>('pendientes')
  const [ordenes, setOrdenes] = useState<Solicitud[]>([])
  const [loading, setLoading] = useState(true)
  const [selectedOrdenId, setSelectedOrdenId] = useState<string | null>(null)
  const [comercioNames, setComercioNames] = useState<Record<string, string>>({})

  // Filtros historial
  const [filtroMotorizado, setFiltroMotorizado] = useState<string>('todos')
  const [desde, setDesde] = useState<string>(() => {
    const d = new Date(); d.setDate(d.getDate() - 30)
    return d.toISOString().slice(0, 10)
  })
  const [hasta, setHasta] = useState<string>(() => new Date().toISOString().slice(0, 10))

  // Expandir grupos
  const [expandedGroups, setExpandedGroups] = useState<Set<string>>(new Set())

  const toggleExpand = (key: string) =>
    setExpandedGroups((prev) => {
      const next = new Set(prev)
      next.has(key) ? next.delete(key) : next.add(key)
      return next
    })

  // ── Query ──────────────────────────────────────────────────────────────────

  useEffect(() => {
    const q = query(collection(db, 'solicitudes_envio'), where('estado', '==', 'entregado'))
    return onSnapshot(q, (snap) => {
      setOrdenes(snap.docs.map((d) => ({ id: d.id, ...(d.data() as any) } as Solicitud)))
      setLoading(false)
    })
  }, [])

  // ── Fetch nombres de comercios que no tienen ownerSnapshot ────────────────

  useEffect(() => {
    const missing = [...new Set(
      ordenes
        .filter((s) => !s.ownerSnapshot?.companyName && !s.ownerSnapshot?.nombre && s.userId)
        .map((s) => s.userId!)
    )].filter((uid) => !comercioNames[uid])
    if (missing.length === 0) return
    Promise.all(missing.map((uid) => getDoc(doc(db, 'comercios', uid)))).then((snaps) => {
      const updates: Record<string, string> = {}
      snaps.forEach((snap, i) => {
        const data = snap.exists() ? (snap.data() as any) : null
        updates[missing[i]] = data?.name || data?.companyName || data?.nombre || '—'
      })
      setComercioNames((prev) => ({ ...prev, ...updates }))
    })
  }, [ordenes])

  // ── Órdenes con depósito requerido ─────────────────────────────────────────

  const ordenesConDeposito = useMemo(
    () => ordenes.filter((o) => {
      const dep = calcDeposito(o)
      return dep.totalAlComercio > 0 || dep.totalAStorkhub > 0
    }),
    [ordenes]
  )

  // ── KPIs ───────────────────────────────────────────────────────────────────

  const kpis = useMemo(() => {
    let pendStorkhub = 0
    let pendComercios = 0
    let confirmadosHoy = 0

    ordenesConDeposito.forEach((o) => {
      const dep = calcDeposito(o)
      const legacyOk = !!o.registro?.deposito?.confirmadoMotorizado

      if (!legacyOk) {
        if (dep.totalAStorkhub > 0 && !o.registro?.deposito?.confirmadoStorkhub) {
          pendStorkhub += dep.totalAStorkhub
        }
        if (dep.totalAlComercio > 0 && !o.registro?.deposito?.confirmadoComercio) {
          pendComercios += dep.totalAlComercio
        }
      }

      // Contabilizar confirmados hoy
      const depR = o.registro?.deposito
      if (isToday(depR?.confirmadoStorkhubAt) || isToday(depR?.confirmadoComercioAt) || isToday(depR?.confirmadoAt)) {
        confirmadosHoy++
      }
    })

    return { pendStorkhub, pendComercios, confirmadosHoy }
  }, [ordenesConDeposito])

  // ── Grupos pendientes ──────────────────────────────────────────────────────

  const gruposMotorizado = useMemo((): GrupoMotorizado[] => {
    const pendientes = ordenesConDeposito.filter(tieneDepositoPendiente)
    const map = new Map<string, GrupoMotorizado>()

    pendientes.forEach((o) => {
      const motId = o.asignacion?.motorizadoId || o.asignacion?.motorizadoAuthUid || '__sin'
      const motNombre = o.asignacion?.motorizadoNombre || 'Sin asignar'

      if (!map.has(motId)) {
        map.set(motId, {
          motorizadoId: motId,
          motorizadoNombre: motNombre,
          storkhub: { ordenes: [], total: 0 },
          comercios: [],
        })
      }
      const grupo = map.get(motId)!
      const dep = calcDeposito(o)
      const depoR = o.registro?.deposito

      // Storkhub pendiente
      if (dep.totalAStorkhub > 0 && !depoR?.confirmadoStorkhub && !depoR?.confirmadoMotorizado) {
        grupo.storkhub.ordenes.push(o)
        grupo.storkhub.total += dep.totalAStorkhub
      }

      // Comercio pendiente
      if (dep.totalAlComercio > 0 && !depoR?.confirmadoComercio && !depoR?.confirmadoMotorizado) {
        const uid = o.userId || o.ownerSnapshot?.uid || '__sin'
        const nombre = getNombreComercio(o, comercioNames)
        let gc = grupo.comercios.find((c) => c.uid === uid)
        if (!gc) {
          gc = { uid, nombre, ordenes: [], total: 0 }
          grupo.comercios.push(gc)
        }
        gc.ordenes.push(o)
        gc.total += dep.totalAlComercio
      }
    })

    return [...map.values()].filter(
      (g) => g.storkhub.ordenes.length > 0 || g.comercios.length > 0
    )
  }, [ordenesConDeposito, comercioNames])

  // ── Historial ──────────────────────────────────────────────────────────────

  const historialEntries = useMemo((): HistorialEntry[] => {
    const entries: HistorialEntry[] = []
    const desdeMs = new Date(desde + 'T00:00:00').getTime()
    const hastaMs = new Date(hasta + 'T23:59:59').getTime()

    ordenesConDeposito.forEach((o) => {
      const dep = calcDeposito(o)
      const depoR = o.registro?.deposito
      const motNombre = o.asignacion?.motorizadoNombre || 'Sin asignar'
      const motId = o.asignacion?.motorizadoId || o.asignacion?.motorizadoAuthUid || '__sin'
      const comercioNombre = getNombreComercio(o, comercioNames)

      const storkhubConfirmado = depoR?.confirmadoStorkhub || depoR?.confirmadoMotorizado
      const comercioConfirmado = depoR?.confirmadoComercio || depoR?.confirmadoMotorizado

      const storkhubAt = depoR?.confirmadoStorkhubAt || (depoR?.confirmadoMotorizado ? depoR?.confirmadoAt : undefined)
      const comercioAt = depoR?.confirmadoComercioAt || (depoR?.confirmadoMotorizado ? depoR?.confirmadoAt : undefined)

      const ordenCompleta =
        (dep.totalAStorkhub === 0 || !!storkhubConfirmado) &&
        (dep.totalAlComercio === 0 || !!comercioConfirmado)

      // Entrada Storkhub
      if (dep.totalAStorkhub > 0 && storkhubAt) {
        const ms = storkhubAt.toMillis()
        if (ms >= desdeMs && ms <= hastaMs) {
          if (filtroMotorizado === 'todos' || filtroMotorizado === motId) {
            entries.push({
              ordenId: o.id,
              motorizadoNombre: motNombre,
              destino: 'Storkhub',
              tipo: 'delivery',
              monto: dep.totalAStorkhub,
              fechaConfirmacion: storkhubAt,
              ordenCompleta,
            })
          }
        }
      }

      // Entrada Comercio
      if (dep.totalAlComercio > 0 && comercioAt) {
        const ms = comercioAt.toMillis()
        if (ms >= desdeMs && ms <= hastaMs) {
          if (filtroMotorizado === 'todos' || filtroMotorizado === motId) {
            entries.push({
              ordenId: o.id,
              motorizadoNombre: motNombre,
              destino: comercioNombre,
              tipo: 'producto',
              monto: dep.totalAlComercio,
              fechaConfirmacion: comercioAt,
              ordenCompleta,
            })
          }
        }
      }
    })

    return entries.sort((a, b) => b.fechaConfirmacion.toMillis() - a.fechaConfirmacion.toMillis())
  }, [ordenesConDeposito, desde, hasta, filtroMotorizado, comercioNames])

  // Lista de motorizados únicos para filtro
  const motorizados = useMemo(() => {
    const map = new Map<string, string>()
    ordenesConDeposito.forEach((o) => {
      const id = o.asignacion?.motorizadoId || o.asignacion?.motorizadoAuthUid
      const nombre = o.asignacion?.motorizadoNombre
      if (id && nombre) map.set(id, nombre)
    })
    return [...map.entries()].map(([id, nombre]) => ({ id, nombre }))
  }, [ordenesConDeposito])

  // ── Confirmar depósito ─────────────────────────────────────────────────────

  async function confirmarStorkhub(ordenes: Solicitud[]) {
    const b = writeBatch(db)
    ordenes.forEach((o) =>
      b.update(doc(db, 'solicitudes_envio', o.id), {
        'registro.deposito.confirmadoStorkhub': true,
        'registro.deposito.confirmadoStorkhubAt': serverTimestamp(),
      })
    )
    await b.commit()
  }

  async function confirmarComercio(ordenes: Solicitud[]) {
    const b = writeBatch(db)
    ordenes.forEach((o) =>
      b.update(doc(db, 'solicitudes_envio', o.id), {
        'registro.deposito.confirmadoComercio': true,
        'registro.deposito.confirmadoComercioAt': serverTimestamp(),
      })
    )
    await b.commit()
  }

  // ── Render ─────────────────────────────────────────────────────────────────

  return (
    <div className="flex flex-col gap-4">
      {/* Header */}
      <div>
        <h1 className="text-2xl font-black text-gray-900 tracking-tight flex items-center gap-2">
          <Wallet className="h-6 w-6 text-[#004aad]" />
          Depósitos
        </h1>
        <p className="text-sm text-gray-500 mt-0.5">
          Seguimiento de depósitos generados por motorizados · Storkhub y comercios.
        </p>
      </div>

      {/* KPIs */}
      <div className="grid grid-cols-3 gap-3">
        <div className="border rounded-xl px-4 py-3 bg-blue-50 border-blue-200">
          <p className="text-2xl font-black text-[#004aad]">
            {loading ? '…' : fmt(kpis.pendStorkhub)}
          </p>
          <p className="text-xs font-semibold mt-0.5 text-blue-500 flex items-center gap-1">
            <Landmark className="h-3 w-3" /> Storkhub pendiente
          </p>
        </div>
        <div className="border rounded-xl px-4 py-3 bg-purple-50 border-purple-200">
          <p className="text-2xl font-black text-purple-700">
            {loading ? '…' : fmt(kpis.pendComercios)}
          </p>
          <p className="text-xs font-semibold mt-0.5 text-purple-400 flex items-center gap-1">
            <Store className="h-3 w-3" /> Comercios pendiente
          </p>
        </div>
        <div className="border rounded-xl px-4 py-3 bg-green-50 border-green-200">
          <p className="text-2xl font-black text-green-700">
            {loading ? '…' : kpis.confirmadosHoy}
          </p>
          <p className="text-xs font-semibold mt-0.5 text-green-400 flex items-center gap-1">
            <Clock className="h-3 w-3" /> Confirmados hoy
          </p>
        </div>
      </div>

      {/* Tabs */}
      <div className="flex gap-2">
        {(['pendientes', 'historial'] as MainTab[]).map((t) => (
          <button
            key={t}
            onClick={() => setTab(t)}
            className={`px-4 py-2 rounded-lg text-sm font-semibold border transition ${
              tab === t
                ? 'bg-[#004aad] text-white border-[#004aad]'
                : 'bg-white text-gray-600 border-gray-200 hover:bg-gray-50'
            }`}
          >
            {t === 'pendientes' ? 'Pendientes' : 'Historial'}
            {t === 'pendientes' && !loading && gruposMotorizado.length > 0 && (
              <span className="ml-1.5 inline-flex items-center justify-center w-5 h-5 rounded-full bg-orange-500 text-white text-[10px] font-black">
                {gruposMotorizado.length}
              </span>
            )}
          </button>
        ))}
      </div>

      {/* ── TAB: PENDIENTES ────────────────────────────────────────────────── */}
      {tab === 'pendientes' && (
        <div className="flex flex-col gap-4">
          {loading ? (
            <div className="bg-white rounded-xl border py-16 text-center text-sm text-gray-400">Cargando…</div>
          ) : gruposMotorizado.length === 0 ? (
            <div className="bg-white rounded-xl border flex flex-col items-center justify-center py-16 gap-2 text-gray-400">
              <CheckCircle2 className="h-12 w-12 opacity-25" />
              <p className="text-sm font-semibold">Sin depósitos pendientes</p>
              <p className="text-xs">Todos los motorizados han confirmado sus depósitos.</p>
            </div>
          ) : (
            gruposMotorizado.map((gm) => (
              <div key={gm.motorizadoId} className="bg-white rounded-xl border border-gray-200 shadow-sm overflow-hidden">
                {/* Header motorizado */}
                <div className="px-4 py-3 bg-gray-50 border-b border-gray-100 flex items-center gap-2">
                  <div className="w-8 h-8 rounded-full bg-[#004aad]/10 grid place-items-center flex-shrink-0">
                    <span className="text-sm font-black text-[#004aad]">
                      {gm.motorizadoNombre[0]?.toUpperCase() ?? '?'}
                    </span>
                  </div>
                  <div>
                    <p className="text-sm font-bold text-gray-900">{gm.motorizadoNombre}</p>
                    <p className="text-xs text-gray-400">
                      {[
                        gm.storkhub.ordenes.length > 0 && `Storkhub: ${fmt(gm.storkhub.total)}`,
                        ...gm.comercios.map((c) => `${c.nombre}: ${fmt(c.total)}`),
                      ].filter(Boolean).join(' · ')}
                    </p>
                  </div>
                </div>

                <div className="p-3 flex flex-col gap-3">
                  {/* Grupo Storkhub */}
                  {gm.storkhub.ordenes.length > 0 && (
                    <DepositoGrupo
                      icon={<Landmark className="h-4 w-4 text-blue-600" />}
                      titulo="Storkhub"
                      subtitulo="Delivery en efectivo"
                      colorBorder="border-blue-200"
                      colorBg="bg-blue-50"
                      total={gm.storkhub.total}
                      ordenes={gm.storkhub.ordenes}
                      expandKey={`${gm.motorizadoId}-storkhub`}
                      expanded={expandedGroups.has(`${gm.motorizadoId}-storkhub`)}
                      onToggle={() => toggleExpand(`${gm.motorizadoId}-storkhub`)}
                      onConfirmar={() => confirmarStorkhub(gm.storkhub.ordenes)}
                      tipoDeposito="storkhub"
                      onSelectOrden={setSelectedOrdenId}
                      comercioNames={comercioNames}
                    />
                  )}

                  {/* Grupos Comercio */}
                  {gm.comercios.map((gc) => (
                    <DepositoGrupo
                      key={gc.uid}
                      icon={<Store className="h-4 w-4 text-purple-600" />}
                      titulo={gc.nombre}
                      subtitulo="Cobro contra entrega"
                      colorBorder="border-purple-200"
                      colorBg="bg-purple-50"
                      total={gc.total}
                      ordenes={gc.ordenes}
                      expandKey={`${gm.motorizadoId}-${gc.uid}`}
                      expanded={expandedGroups.has(`${gm.motorizadoId}-${gc.uid}`)}
                      onToggle={() => toggleExpand(`${gm.motorizadoId}-${gc.uid}`)}
                      onConfirmar={() => confirmarComercio(gc.ordenes)}
                      tipoDeposito="comercio"
                      onSelectOrden={setSelectedOrdenId}
                      comercioNames={comercioNames}
                    />
                  ))}
                </div>
              </div>
            ))
          )}
        </div>
      )}

      {/* ── TAB: HISTORIAL ─────────────────────────────────────────────────── */}
      {tab === 'historial' && (
        <div className="flex flex-col gap-3">
          {/* Filtros */}
          <div className="flex flex-wrap gap-3 items-center">
            <div className="flex items-center gap-2">
              <label className="text-xs font-semibold text-gray-500">Desde</label>
              <input
                type="date"
                value={desde}
                onChange={(e) => setDesde(e.target.value)}
                className="border border-gray-200 rounded-lg px-2 py-1.5 text-xs focus:outline-none focus:ring-2 focus:ring-[#004aad]/30"
              />
            </div>
            <div className="flex items-center gap-2">
              <label className="text-xs font-semibold text-gray-500">Hasta</label>
              <input
                type="date"
                value={hasta}
                onChange={(e) => setHasta(e.target.value)}
                className="border border-gray-200 rounded-lg px-2 py-1.5 text-xs focus:outline-none focus:ring-2 focus:ring-[#004aad]/30"
              />
            </div>
            <span className="text-xs text-gray-400">{historialEntries.length} registros</span>
          </div>

          {/* Pills de motorizado */}
          {motorizados.length > 0 && (
            <div className="flex flex-wrap gap-2">
              <button
                onClick={() => setFiltroMotorizado('todos')}
                className={`px-3 py-1 rounded-full text-xs font-semibold border transition ${
                  filtroMotorizado === 'todos'
                    ? 'bg-gray-900 text-white border-gray-900'
                    : 'bg-white text-gray-600 border-gray-200 hover:bg-gray-50'
                }`}
              >
                Todos
              </button>
              {motorizados.map((m) => (
                <button
                  key={m.id}
                  onClick={() => setFiltroMotorizado(m.id)}
                  className={`px-3 py-1 rounded-full text-xs font-semibold border transition ${
                    filtroMotorizado === m.id
                      ? 'bg-[#004aad] text-white border-[#004aad]'
                      : 'bg-white text-gray-600 border-gray-200 hover:bg-gray-50'
                  }`}
                >
                  {m.nombre}
                </button>
              ))}
            </div>
          )}

          {/* Tabla */}
          <div className="overflow-x-auto rounded-xl border border-gray-200 bg-white shadow-sm">
            {loading ? (
              <div className="py-16 text-center text-sm text-gray-400">Cargando…</div>
            ) : historialEntries.length === 0 ? (
              <div className="flex flex-col items-center justify-center py-16 gap-2 text-gray-400">
                <CheckCircle2 className="h-10 w-10 opacity-30" />
                <p className="text-sm font-medium">Sin depósitos confirmados en este período</p>
              </div>
            ) : (
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b bg-gray-50">
                    <th className={thCls}>Fecha confirmación</th>
                    <th className={thCls}>Motorizado</th>
                    <th className={thCls}>Destino</th>
                    <th className={thCls}>Tipo</th>
                    <th className={`${thCls} text-right`}>Monto</th>
                    <th className={thCls}>Orden</th>
                    <th className={thCls}>Estado</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-gray-100">
                  {historialEntries.map((entry, i) => (
                    <tr key={`${entry.ordenId}-${entry.tipo}-${i}`} className="hover:bg-gray-50 transition-colors">
                      <td className={tdCls}>{fmtDateTime(entry.fechaConfirmacion)}</td>
                      <td className={`${tdCls} font-semibold text-gray-800`}>{entry.motorizadoNombre}</td>
                      <td className={tdCls}>
                        <span className="flex items-center gap-1.5">
                          {entry.destino === 'Storkhub'
                            ? <Landmark className="h-3.5 w-3.5 text-blue-500 flex-shrink-0" />
                            : <Store className="h-3.5 w-3.5 text-purple-500 flex-shrink-0" />
                          }
                          {entry.destino}
                        </span>
                      </td>
                      <td className={tdCls}>
                        {entry.tipo === 'delivery' ? (
                          <span className="inline-flex text-[11px] font-semibold px-2 py-0.5 rounded-full bg-blue-50 text-blue-700 border border-blue-200">
                            Delivery
                          </span>
                        ) : (
                          <span className="inline-flex text-[11px] font-semibold px-2 py-0.5 rounded-full bg-purple-50 text-purple-700 border border-purple-200">
                            Producto
                          </span>
                        )}
                      </td>
                      <td className={`${tdCls} text-right font-semibold text-gray-900`}>{fmt(entry.monto)}</td>
                      <td className={tdCls}>
                        <button
                          onClick={() => setSelectedOrdenId(entry.ordenId)}
                          className="font-mono text-xs text-blue-600 hover:text-blue-800 hover:underline transition"
                          title="Ver detalles de la orden"
                        >
                          {entry.ordenId.slice(0, 8)}
                        </button>
                      </td>
                      <td className={tdCls}>
                        {entry.ordenCompleta ? (
                          <span className="inline-flex items-center gap-1 text-[11px] font-semibold px-2 py-0.5 rounded-full bg-green-50 text-green-700 border border-green-200">
                            <CheckCircle2 className="h-3 w-3" /> Completo
                          </span>
                        ) : (
                          <span className="inline-flex text-[11px] font-semibold px-2 py-0.5 rounded-full bg-yellow-50 text-yellow-700 border border-yellow-200">
                            Parcial
                          </span>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </div>
        </div>
      )}

      {/* Drawer de detalle */}
      {selectedOrdenId && (
        <SolicitudDrawer
          solicitudId={selectedOrdenId}
          onClose={() => setSelectedOrdenId(null)}
        />
      )}
    </div>
  )
}

// ─── Componente de grupo de depósito ─────────────────────────────────────────

function DepositoGrupo({
  icon,
  titulo,
  subtitulo,
  colorBorder,
  colorBg,
  total,
  ordenes,
  expandKey,
  expanded,
  onToggle,
  onConfirmar,
  tipoDeposito,
  onSelectOrden,
  comercioNames,
}: {
  icon: React.ReactNode
  titulo: string
  subtitulo: string
  colorBorder: string
  colorBg: string
  total: number
  ordenes: Solicitud[]
  expandKey: string
  expanded: boolean
  onToggle: () => void
  onConfirmar: () => Promise<void>
  tipoDeposito: 'storkhub' | 'comercio'
  onSelectOrden: (id: string) => void
  comercioNames: Record<string, string>
}) {
  const [saving, setSaving] = useState(false)

  async function handleConfirmar() {
    setSaving(true)
    try { await onConfirmar() } finally { setSaving(false) }
  }

  return (
    <div className={`rounded-xl border-2 ${colorBorder} overflow-hidden`}>
      <div className={`px-4 py-3 ${colorBg} flex items-center gap-3`}>
        <span>{icon}</span>
        <div className="flex-1 min-w-0">
          <p className="text-sm font-bold text-gray-900 truncate">{titulo}</p>
          <p className="text-xs text-gray-500">{subtitulo} · {ordenes.length} {ordenes.length === 1 ? 'orden' : 'órdenes'}</p>
        </div>
        <span className="text-sm font-black text-gray-900 whitespace-nowrap">{`C$ ${total.toLocaleString('es-NI')}`}</span>
        <button
          onClick={onToggle}
          className="text-gray-500 hover:text-gray-700 transition p-1"
          title="Ver órdenes"
        >
          {expanded ? <ChevronUp className="h-4 w-4" /> : <ChevronDown className="h-4 w-4" />}
        </button>
        <button
          onClick={handleConfirmar}
          disabled={saving}
          className={`text-xs font-semibold px-3 py-1.5 rounded-lg transition whitespace-nowrap disabled:opacity-40 ${
            tipoDeposito === 'storkhub'
              ? 'bg-blue-600 text-white hover:bg-blue-700'
              : 'bg-purple-600 text-white hover:bg-purple-700'
          }`}
        >
          {saving ? 'Guardando…' : '✓ Confirmar depósito'}
        </button>
      </div>

      {expanded && (
        <div className="border-t border-gray-100">
          <table className="w-full">
            <thead>
              <tr className="bg-gray-50 border-b border-gray-100">
                <th className="px-4 py-2 text-left text-[11px] font-semibold uppercase tracking-wide text-gray-500">Orden</th>
                <th className="px-4 py-2 text-left text-[11px] font-semibold uppercase tracking-wide text-gray-500">Fecha entrega</th>
                <th className="px-4 py-2 text-left text-[11px] font-semibold uppercase tracking-wide text-gray-500">
                  Comercio · Dirección · Cliente
                </th>
                <th className="px-4 py-2 text-right text-[11px] font-semibold uppercase tracking-wide text-gray-500">Monto</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-50">
              {ordenes.map((o) => {
                const dep = calcDeposito(o)
                const monto = tipoDeposito === 'storkhub' ? dep.totalAStorkhub : dep.totalAlComercio
                return (
                  <tr key={o.id} className="hover:bg-gray-50 transition-colors">
                    <td className="px-4 py-2.5">
                      <button
                        onClick={() => onSelectOrden(o.id)}
                        className="font-mono text-xs text-blue-600 hover:text-blue-800 hover:underline transition"
                        title="Ver detalles de la orden"
                      >
                        {o.id.slice(0, 8)}
                      </button>
                    </td>
                    <td className="px-4 py-2.5 text-xs text-gray-600">{fmtDate(getEntregadoAt(o))}</td>
                    <td className="px-4 py-2.5">
                      <p className="text-xs font-semibold text-gray-800">{getNombreComercio(o, comercioNames)}</p>
                      {o.entrega?.direccionEscrita && (
                        <p className="text-[11px] text-gray-500 mt-0.5">{o.entrega.direccionEscrita}</p>
                      )}
                      {o.entrega?.nombreApellido && (
                        <p className="text-[11px] text-gray-400 mt-0.5">{o.entrega.nombreApellido}</p>
                      )}
                    </td>
                    <td className="px-4 py-2.5 text-xs text-right font-semibold text-gray-900">
                      {`C$ ${monto.toLocaleString('es-NI')}`}
                    </td>
                  </tr>
                )
              })}
            </tbody>
          </table>
        </div>
      )}
    </div>
  )
}
