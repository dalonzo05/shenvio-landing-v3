'use client'

import { useEffect, useMemo, useRef, useState } from 'react'
import {
  collection,
  onSnapshot,
  query,
  where,
  doc,
  getDoc,
  setDoc,
  writeBatch,
  serverTimestamp,
  Timestamp,
} from 'firebase/firestore'
import { auth, db } from '@/fb/config'
import { compressImage, uploadDepositoBoucher } from '@/fb/storage'
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
      storkhubDepositoId?: string
      comercioDepositoId?: string
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

type MainTab = 'pendientes' | 'por_revisar' | 'historial'

// Documento de ordenes_deposito (una transferencia bancaria completa)
type DepositoOrderDoc = {
  id: string
  creadoAt?: Timestamp
  destinatario: 'storkhub' | 'comercio'
  destinatarioNombre: string
  motorizadoUid: string
  motorizadoNombre: string
  solicitudIds: string[]
  montoTotal: number
  boucher?: { url: string; pathStorage: string } | null
  confirmadoMotorizado: boolean
  confirmadoMotorizadoAt?: Timestamp
  confirmadoGestor?: boolean
  confirmadoGestorAt?: Timestamp
}

// Versión reducida cargada en runtime (solo lo que necesitamos mostrar)
type DepositoOrder = {
  boucher?: { url: string; pathStorage: string } | null
}

// Entrada del historial de depósitos
type HistorialEntry = {
  ordenId: string
  motorizadoNombre: string
  destino: string
  tipo: 'delivery' | 'producto'
  monto: number
  fechaConfirmacion: Timestamp
  ordenCompleta: boolean
  depositoId?: string
}

// Detalle mínimo de una solicitud para mostrar en el desglose
type SolicitudDetail = {
  id: string
  entrega?: { nombreApellido?: string; direccionEscrita?: string }
  ownerSnapshot?: { companyName?: string; nombre?: string }
  cobroContraEntrega?: { aplica?: boolean; monto?: number }
  confirmacion?: { precioFinalCordobas?: number }
  pagoDelivery?: { quienPaga?: string; deducirDelCobroContraEntrega?: boolean }
  tipoCliente?: string
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

function tsToDate(v: any): Date | null {
  if (!v) return null
  if (typeof v?.toDate === 'function') return v.toDate()
  if (v instanceof Date) return v
  return null
}

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
  const [depositoOrders, setDepositoOrders] = useState<Record<string, DepositoOrder>>({})
  const loadedDepositoIds = useRef<Set<string>>(new Set())

  // Por revisar: ordenes_deposito pendientes de confirmación del gestor
  const [porRevisar, setPorRevisar] = useState<DepositoOrderDoc[]>([])
  const [confirmandoId, setConfirmandoId] = useState<string | null>(null)
  const [boucherModalUrl, setBoucherModalUrl] = useState<string | null>(null)
  const [expandedPorRevisar, setExpandedPorRevisar] = useState<Set<string>>(new Set())
  const toggleExpandPorRevisar = (id: string) =>
    setExpandedPorRevisar((prev) => { const s = new Set(prev); s.has(id) ? s.delete(id) : s.add(id); return s })

  // Historial: ordenes_deposito confirmados por gestor
  const [historialDepositos, setHistorialDepositos] = useState<DepositoOrderDoc[]>([])

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

  // Query: ordenes_deposito pendientes de revisión gestora (motorizado las creó, gestor aún no confirmó)
  useEffect(() => {
    const q = query(collection(db, 'ordenes_deposito'), where('confirmadoGestor', '==', false))
    return onSnapshot(q, (snap) => {
      const list = snap.docs
        .map((d) => ({ id: d.id, ...(d.data() as any) } as DepositoOrderDoc))
        .sort((a, b) => (tsToDate(b.creadoAt)?.getTime() ?? 0) - (tsToDate(a.creadoAt)?.getTime() ?? 0))
      setPorRevisar(list)
    })
  }, [])

  // Query: ordenes_deposito confirmados por gestor (para historial limpio 1-fila-por-depósito)
  useEffect(() => {
    const q = query(collection(db, 'ordenes_deposito'), where('confirmadoGestor', '==', true))
    return onSnapshot(q, (snap) => {
      const list = snap.docs
        .map((d) => ({ id: d.id, ...(d.data() as any) } as DepositoOrderDoc))
        .sort((a, b) => (tsToDate(b.confirmadoGestorAt)?.getTime() ?? 0) - (tsToDate(a.confirmadoGestorAt)?.getTime() ?? 0))
      setHistorialDepositos(list)
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
              depositoId: depoR?.storkhubDepositoId,
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
              depositoId: depoR?.comercioDepositoId,
            })
          }
        }
      }
    })

    return entries.sort((a, b) => b.fechaConfirmacion.toMillis() - a.fechaConfirmacion.toMillis())
  }, [ordenesConDeposito, desde, hasta, filtroMotorizado, comercioNames])

  // ── Cargar ordenes_deposito para mostrar boucher en historial ─────────────

  useEffect(() => {
    const ids = [...new Set(
      historialEntries
        .map((e) => e.depositoId)
        .filter((id): id is string => !!id && !loadedDepositoIds.current.has(id))
    )]
    if (ids.length === 0) return
    ids.forEach((id) => loadedDepositoIds.current.add(id))
    Promise.all(ids.map((id) => getDoc(doc(db, 'ordenes_deposito', id)))).then((snaps) => {
      const updates: Record<string, DepositoOrder> = {}
      snaps.forEach((snap, i) => {
        if (snap.exists()) {
          const data = snap.data() as any
          updates[ids[i]] = { boucher: data.boucher ?? null }
        }
      })
      setDepositoOrders((prev) => ({ ...prev, ...updates }))
    })
  }, [historialEntries])

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

  async function confirmarStorkhub(ordenes: Solicitud[], motId: string, motNombre: string, boucherFile: File) {
    const depositoRef = doc(collection(db, 'ordenes_deposito'))
    const depositoId = depositoRef.id
    const blob = await compressImage(boucherFile)
    const { url, pathStorage } = await uploadDepositoBoucher(depositoId, blob)
    const boucherData = { url, pathStorage, uploadedAt: serverTimestamp(), motorizadoUid: motId }
    const montoTotal = ordenes.reduce((s, o) => s + calcDeposito(o).totalAStorkhub, 0)
    await setDoc(depositoRef, {
      creadoAt: serverTimestamp(),
      destinatario: 'storkhub',
      destinatarioId: 'storkhub',
      destinatarioNombre: 'Storkhub',
      cuentasDestino: [],
      motorizadoUid: motId,
      motorizadoNombre: motNombre,
      solicitudIds: ordenes.map((o) => o.id),
      montoTotal,
      boucher: boucherData,
      confirmadoMotorizado: false,
      confirmadoGestor: true,
      confirmadoGestorAt: serverTimestamp(),
      confirmadoGestorUid: auth.currentUser?.uid ?? '',
    })
    const b = writeBatch(db)
    ordenes.forEach((o) =>
      b.update(doc(db, 'solicitudes_envio', o.id), {
        'registro.deposito.confirmadoStorkhub': true,
        'registro.deposito.confirmadoStorkhubAt': serverTimestamp(),
        'registro.deposito.storkhubDepositoId': depositoId,
      })
    )
    await b.commit()
  }

  async function confirmarComercio(ordenes: Solicitud[], comercioUid: string, comercioNombre: string, motId: string, motNombre: string, boucherFile: File) {
    const depositoRef = doc(collection(db, 'ordenes_deposito'))
    const depositoId = depositoRef.id
    const blob = await compressImage(boucherFile)
    const { url, pathStorage } = await uploadDepositoBoucher(depositoId, blob)
    const boucherData = { url, pathStorage, uploadedAt: serverTimestamp(), motorizadoUid: motId }
    const montoTotal = ordenes.reduce((s, o) => s + calcDeposito(o).totalAlComercio, 0)
    await setDoc(depositoRef, {
      creadoAt: serverTimestamp(),
      destinatario: 'comercio',
      destinatarioId: comercioUid,
      destinatarioNombre: comercioNombre,
      cuentasDestino: [],
      motorizadoUid: motId,
      motorizadoNombre: motNombre,
      solicitudIds: ordenes.map((o) => o.id),
      montoTotal,
      boucher: boucherData,
      confirmadoMotorizado: false,
      confirmadoGestor: true,
      confirmadoGestorAt: serverTimestamp(),
      confirmadoGestorUid: auth.currentUser?.uid ?? '',
    })
    const b = writeBatch(db)
    ordenes.forEach((o) =>
      b.update(doc(db, 'solicitudes_envio', o.id), {
        'registro.deposito.confirmadoComercio': true,
        'registro.deposito.confirmadoComercioAt': serverTimestamp(),
        'registro.deposito.comercioDepositoId': depositoId,
      })
    )
    await b.commit()
  }

  // ── Confirmar depósito existente (creado por motorizado) ──────────────────

  async function confirmarDepositoExistente(dep: DepositoOrderDoc) {
    setConfirmandoId(dep.id)
    try {
      const { updateDoc: upd, doc: docRef } = await import('firebase/firestore')
      const ref = docRef(db, 'ordenes_deposito', dep.id)
      const b = writeBatch(db)
      b.update(ref, {
        confirmadoGestor: true,
        confirmadoGestorAt: serverTimestamp(),
        confirmadoGestorUid: auth.currentUser?.uid ?? '',
      })
      const fieldKey = dep.destinatario === 'storkhub'
        ? 'registro.deposito.confirmadoStorkhub'
        : 'registro.deposito.confirmadoComercio'
      const atKey = dep.destinatario === 'storkhub'
        ? 'registro.deposito.confirmadoStorkhubAt'
        : 'registro.deposito.confirmadoComercioAt'
      const idKey = dep.destinatario === 'storkhub'
        ? 'registro.deposito.storkhubDepositoId'
        : 'registro.deposito.comercioDepositoId'
      dep.solicitudIds.forEach((sid) => {
        b.update(docRef(db, 'solicitudes_envio', sid), {
          [fieldKey]: true,
          [atKey]: serverTimestamp(),
          [idKey]: dep.id,
        })
      })
      await b.commit()
    } finally {
      setConfirmandoId(null)
    }
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
      <div className="flex gap-2 flex-wrap">
        {(['pendientes', 'por_revisar', 'historial'] as MainTab[]).map((t) => (
          <button
            key={t}
            onClick={() => setTab(t)}
            className={`px-4 py-2 rounded-lg text-sm font-semibold border transition ${
              tab === t
                ? 'bg-[#004aad] text-white border-[#004aad]'
                : 'bg-white text-gray-600 border-gray-200 hover:bg-gray-50'
            }`}
          >
            {t === 'pendientes' ? 'Pendientes' : t === 'por_revisar' ? 'Por revisar' : 'Historial'}
            {t === 'pendientes' && !loading && gruposMotorizado.length > 0 && (
              <span className="ml-1.5 inline-flex items-center justify-center w-5 h-5 rounded-full bg-orange-500 text-white text-[10px] font-black">
                {gruposMotorizado.length}
              </span>
            )}
            {t === 'por_revisar' && porRevisar.length > 0 && (
              <span className="ml-1.5 inline-flex items-center justify-center w-5 h-5 rounded-full bg-blue-500 text-white text-[10px] font-black">
                {porRevisar.length}
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
                      onConfirmar={(f) => confirmarStorkhub(gm.storkhub.ordenes, gm.motorizadoId, gm.motorizadoNombre, f)}
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
                      onConfirmar={(f) => confirmarComercio(gc.ordenes, gc.uid, gc.nombre, gm.motorizadoId, gm.motorizadoNombre, f)}
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

      {/* ── TAB: POR REVISAR ──────────────────────────────────────────────── */}
      {tab === 'por_revisar' && (
        <div className="flex flex-col gap-4">
          {porRevisar.length === 0 ? (
            <div className="bg-white rounded-xl border flex flex-col items-center justify-center py-16 gap-2 text-gray-400">
              <CheckCircle2 className="h-12 w-12 opacity-25" />
              <p className="text-sm font-semibold">Sin depósitos por revisar</p>
              <p className="text-xs">Los depósitos subidos por motorizados aparecerán aquí.</p>
            </div>
          ) : (
            porRevisar.map((dep) => {
              const isExp = expandedPorRevisar.has(dep.id)
              const esStorkhub = dep.destinatario === 'storkhub'
              return (
                <div key={dep.id} className={`bg-white rounded-xl border-2 overflow-hidden ${esStorkhub ? 'border-blue-200' : 'border-purple-200'}`}>
                  {/* Header */}
                  <div className={`px-4 py-3 flex items-center gap-3 ${esStorkhub ? 'bg-blue-50' : 'bg-purple-50'}`}>
                    <span>{esStorkhub ? <Landmark className="h-4 w-4 text-blue-600" /> : <Store className="h-4 w-4 text-purple-600" />}</span>
                    <div className="flex-1 min-w-0">
                      <p className="text-sm font-bold text-gray-900 truncate">{dep.destinatarioNombre}</p>
                      <p className="text-xs text-gray-500">
                        Motorizado: {dep.motorizadoNombre} · {fmtDate(dep.creadoAt)} · {dep.solicitudIds?.length ?? 0} órdenes
                      </p>
                    </div>
                    <span className="text-sm font-black text-gray-900 whitespace-nowrap">{fmt(dep.montoTotal)}</span>
                    <button onClick={() => toggleExpandPorRevisar(dep.id)} className="text-gray-500 hover:text-gray-700 transition p-1">
                      {isExp ? <ChevronUp className="h-4 w-4" /> : <ChevronDown className="h-4 w-4" />}
                    </button>
                  </div>

                  {/* Expanded order IDs */}
                  {isExp && (dep.solicitudIds?.length ?? 0) > 0 && (
                    <div className="border-t border-gray-100 px-4 py-3 bg-gray-50">
                      <p className="mb-1.5 text-xs font-semibold uppercase tracking-wide text-gray-400">Órdenes incluidas</p>
                      <div className="flex flex-wrap gap-1.5">
                        {dep.solicitudIds.map((sid) => (
                          <button
                            key={sid}
                            onClick={() => setSelectedOrdenId(sid)}
                            className="rounded bg-white border border-gray-200 px-2 py-0.5 font-mono text-xs text-blue-600 hover:bg-blue-50 transition"
                          >
                            {sid.slice(0, 8)}…
                          </button>
                        ))}
                      </div>
                    </div>
                  )}

                  {/* Boucher + confirm */}
                  <div className="px-4 py-3 border-t border-gray-100 flex flex-col gap-2">
                    {dep.boucher?.url ? (
                      <div className="flex items-center gap-3">
                        <button
                          onClick={() => setBoucherModalUrl(dep.boucher!.url)}
                          className="flex items-center gap-2 rounded-lg border border-gray-200 bg-gray-50 px-3 py-2 text-xs font-semibold text-gray-700 hover:bg-gray-100 transition"
                        >
                          {/* eslint-disable-next-line @next/next/no-img-element */}
                          <img src={dep.boucher.url} alt="boucher" className="h-8 w-8 rounded object-cover border border-gray-200" />
                          Ver comprobante del motorizado
                        </button>
                      </div>
                    ) : (
                      <p className="text-xs text-gray-400 italic">Sin comprobante adjunto</p>
                    )}
                    <button
                      onClick={() => confirmarDepositoExistente(dep)}
                      disabled={confirmandoId === dep.id}
                      className={`w-full text-xs font-semibold px-3 py-2.5 rounded-lg transition disabled:opacity-40 disabled:cursor-not-allowed ${esStorkhub ? 'bg-blue-600 text-white hover:bg-blue-700' : 'bg-purple-600 text-white hover:bg-purple-700'}`}
                    >
                      {confirmandoId === dep.id ? 'Confirmando…' : '✓ Confirmar depósito'}
                    </button>
                  </div>
                </div>
              )
            })
          )}
        </div>
      )}

      {/* Boucher modal */}
      {boucherModalUrl && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 p-4" onClick={() => setBoucherModalUrl(null)}>
          <div className="relative" onClick={(e) => e.stopPropagation()}>
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img src={boucherModalUrl} alt="Comprobante" className="max-h-[85vh] max-w-full rounded-xl object-contain shadow-2xl" />
            <button onClick={() => setBoucherModalUrl(null)} className="absolute -right-3 -top-3 flex h-8 w-8 items-center justify-center rounded-full bg-white shadow text-gray-700 hover:bg-gray-100">✕</button>
          </div>
        </div>
      )}

      {/* ── TAB: HISTORIAL ─────────────────────────────────────────────────── */}
      {tab === 'historial' && (() => {
        // Build motorizado list from historialDepositos
        const motorizadosHist = (() => {
          const map = new Map<string, string>()
          historialDepositos.forEach((d) => {
            if (d.motorizadoUid && d.motorizadoNombre) map.set(d.motorizadoUid, d.motorizadoNombre)
          })
          return [...map.entries()].map(([id, nombre]) => ({ id, nombre }))
        })()

        const desdeMs = new Date(desde + 'T00:00:00').getTime()
        const hastaMs = new Date(hasta + 'T23:59:59').getTime()

        const filtered = historialDepositos.filter((d) => {
          const ts = tsToDate(d.confirmadoGestorAt)?.getTime() ?? tsToDate(d.creadoAt)?.getTime() ?? 0
          if (ts < desdeMs || ts > hastaMs) return false
          if (filtroMotorizado !== 'todos' && d.motorizadoUid !== filtroMotorizado) return false
          return true
        })

        return (
          <div className="flex flex-col gap-3">
            {/* Filtros fecha */}
            <div className="flex flex-wrap gap-3 items-center">
              <div className="flex items-center gap-2">
                <label className="text-xs font-semibold text-gray-500">Desde</label>
                <input type="date" value={desde} onChange={(e) => setDesde(e.target.value)}
                  className="border border-gray-200 rounded-lg px-2 py-1.5 text-xs focus:outline-none focus:ring-2 focus:ring-[#004aad]/30" />
              </div>
              <div className="flex items-center gap-2">
                <label className="text-xs font-semibold text-gray-500">Hasta</label>
                <input type="date" value={hasta} onChange={(e) => setHasta(e.target.value)}
                  className="border border-gray-200 rounded-lg px-2 py-1.5 text-xs focus:outline-none focus:ring-2 focus:ring-[#004aad]/30" />
              </div>
              <span className="text-xs text-gray-400">{filtered.length} depósito{filtered.length !== 1 ? 's' : ''}</span>
            </div>

            {/* Pills motorizado */}
            {motorizadosHist.length > 0 && (
              <div className="flex flex-wrap gap-2">
                <button onClick={() => setFiltroMotorizado('todos')}
                  className={`px-3 py-1 rounded-full text-xs font-semibold border transition ${filtroMotorizado === 'todos' ? 'bg-gray-900 text-white border-gray-900' : 'bg-white text-gray-600 border-gray-200 hover:bg-gray-50'}`}>
                  Todos
                </button>
                {motorizadosHist.map((m) => (
                  <button key={m.id} onClick={() => setFiltroMotorizado(m.id)}
                    className={`px-3 py-1 rounded-full text-xs font-semibold border transition ${filtroMotorizado === m.id ? 'bg-[#004aad] text-white border-[#004aad]' : 'bg-white text-gray-600 border-gray-200 hover:bg-gray-50'}`}>
                    {m.nombre}
                  </button>
                ))}
              </div>
            )}

            {/* Tabla: 1 fila por depósito */}
            <div className="overflow-x-auto rounded-xl border border-gray-200 bg-white shadow-sm">
              {filtered.length === 0 ? (
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
                      <th className={thCls}>Comercio</th>
                      <th className={thCls}>Tipo</th>
                      <th className={`${thCls} text-right`}>Monto</th>
                      <th className={thCls}>Órdenes</th>
                      <th className={thCls}>Comprobante</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-gray-100">
                    {filtered.map((dep) => (
                      <tr key={dep.id} className="hover:bg-gray-50 transition-colors">
                        <td className={tdCls}>{fmtDateTime(dep.confirmadoGestorAt ?? dep.creadoAt)}</td>
                        <td className={`${tdCls} font-semibold text-gray-800`}>{dep.motorizadoNombre}</td>
                        <td className={tdCls}>
                          <span className="flex items-center gap-1.5">
                            {dep.destinatario === 'storkhub'
                              ? <Landmark className="h-3.5 w-3.5 text-blue-500 flex-shrink-0" />
                              : <Store className="h-3.5 w-3.5 text-purple-500 flex-shrink-0" />}
                            {dep.destinatarioNombre}
                          </span>
                        </td>
                        <td className={tdCls}>
                          {dep.destinatario === 'storkhub' ? (
                            <span className="inline-flex text-[11px] font-semibold px-2 py-0.5 rounded-full bg-blue-50 text-blue-700 border border-blue-200">Delivery</span>
                          ) : (
                            <span className="inline-flex text-[11px] font-semibold px-2 py-0.5 rounded-full bg-purple-50 text-purple-700 border border-purple-200">Producto</span>
                          )}
                        </td>
                        <td className={`${tdCls} text-right font-semibold text-gray-900`}>{fmt(dep.montoTotal)}</td>
                        <td className={tdCls}>
                          <div className="flex flex-wrap gap-1">
                            {(dep.solicitudIds ?? []).map((sid) => (
                              <button key={sid} onClick={() => setSelectedOrdenId(sid)}
                                className="font-mono text-[11px] text-blue-600 bg-blue-50 hover:bg-blue-100 px-1.5 py-0.5 rounded transition" title={sid}>
                                {sid.slice(0, 6)}…
                              </button>
                            ))}
                          </div>
                        </td>
                        <td className={tdCls}>
                          {dep.boucher?.url ? (
                            <button onClick={() => window.open(dep.boucher!.url, '_blank')} title="Ver comprobante">
                              {/* eslint-disable-next-line @next/next/no-img-element */}
                              <img src={dep.boucher.url} alt="boucher" className="w-8 h-8 rounded object-cover border border-green-200 hover:opacity-80 transition" />
                            </button>
                          ) : <span className="text-[11px] text-gray-400">—</span>}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}
            </div>
          </div>
        )
      })()}

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
  onConfirmar: (boucherFile: File) => Promise<void>
  tipoDeposito: 'storkhub' | 'comercio'
  onSelectOrden: (id: string) => void
  comercioNames: Record<string, string>
}) {
  const [saving, setSaving] = useState(false)
  const [boucherFile, setBoucherFile] = useState<File | null>(null)
  const boucherRef = useRef<HTMLInputElement>(null)

  async function handleConfirmar() {
    if (!boucherFile) return
    setSaving(true)
    try { await onConfirmar(boucherFile) } finally { setSaving(false) }
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

      {/* Boucher obligatorio + botón confirmar */}
      <div className="px-4 py-3 border-t border-gray-100 flex flex-col gap-2">
        <input
          ref={boucherRef}
          type="file"
          accept="image/*"
          style={{ display: 'none' }}
          onChange={(e) => {
            const f = e.target.files?.[0]
            if (f) setBoucherFile(f)
            if (boucherRef.current) boucherRef.current.value = ''
          }}
        />
        <button
          onClick={() => boucherRef.current?.click()}
          className={`w-full text-xs font-semibold py-2 px-3 rounded-lg border transition ${
            boucherFile
              ? 'bg-green-50 border-green-200 text-green-700'
              : 'bg-gray-50 border-gray-200 text-gray-600 hover:bg-gray-100'
          }`}
        >
          {boucherFile
            ? `✅ Boucher: ${boucherFile.name.slice(0, 30)} · Cambiar`
            : '📸 Adjuntar boucher del depósito (obligatorio)'}
        </button>
        {!boucherFile && (
          <p className="text-[11px] text-red-500 text-center">Se requiere boucher para confirmar</p>
        )}
        <button
          onClick={handleConfirmar}
          disabled={saving || !boucherFile}
          className={`w-full text-xs font-semibold px-3 py-2 rounded-lg transition whitespace-nowrap disabled:opacity-40 disabled:cursor-not-allowed ${
            tipoDeposito === 'storkhub'
              ? 'bg-blue-600 text-white hover:bg-blue-700'
              : 'bg-purple-600 text-white hover:bg-purple-700'
          }`}
        >
          {saving ? 'Subiendo boucher y confirmando…' : '✓ Confirmar depósito'}
        </button>
      </div>
    </div>
  )
}
