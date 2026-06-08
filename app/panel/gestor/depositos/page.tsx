'use client'

import { Fragment, useEffect, useMemo, useRef, useState } from 'react'
import {
  collection,
  onSnapshot,
  query,
  where,
  getDocs,
  doc,
  getDoc,
  setDoc,
  writeBatch,
  deleteDoc,
  serverTimestamp,
  Timestamp,
} from 'firebase/firestore'
import { auth, db } from '@/fb/config'
import { compressImage, uploadDepositoBoucher } from '@/fb/storage'
import { registrarMovimiento, convertirDepositoEnDeuda } from '@/lib/financial-writes'
import { getDepositoEstado, cuentas } from '@/lib/financial-types'
import {
  Wallet,
  CheckCircle2,
  ChevronDown,
  ChevronUp,
  Landmark,
  Store,
  Clock,
  Search,
  X,
  Users,
  Zap,
  Eye,
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
  total: number       // neto (bruto − gastos deducibles)
  totalBruto: number  // antes de gastos
  gastosDeducibles: number
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
  tipo?: string
  estado?: string
  destinatario: 'storkhub' | 'comercio'
  destinatarioNombre: string
  destinatarioId?: string
  motorizadoUid: string
  motorizadoNombre: string
  solicitudIds: string[]
  montoTotal: number     // neto enviado por el motorizado
  montoBruto?: number    // delivery bruto antes de gastos (guardado por motorizado)
  gastosDescontados?: number  // gastos deducidos del bruto
  gastosIds?: string[]   // IDs de gastos_motorizado descontados
  boucher?: { url: string; pathStorage: string } | null
  rechazadoPor?: string
  rechazadoAt?: Timestamp
  motivoRechazo?: string
  notaConversion?: string
  saldoId?: string
}

type BankAccount = { bank: string; number: string; holder: string; currency: string }
type ComercioBankInfo = { name?: string; accounts?: BankAccount[] }

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

function fmtNombreMotorizado(raw: string, names?: Record<string, string>, uid?: string): string {
  if (uid && names?.[uid]) return names[uid]
  if (!raw) return '—'
  if (raw.includes('@')) return raw.split('@')[0]
  return raw
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
  const [userRol, setUserRol] = useState<string | null>(null)
  const [comercioNames, setComercioNames] = useState<Record<string, string>>({})
  const [depositoOrders, setDepositoOrders] = useState<Record<string, DepositoOrder>>({})
  const loadedDepositoIds = useRef<Set<string>>(new Set())

  // Por revisar: ordenes_deposito pendientes de confirmación del gestor
  const [porRevisar, setPorRevisar] = useState<DepositoOrderDoc[]>([])
  const [confirmandoId, setConfirmandoId] = useState<string | null>(null)
  const [devolviendoId, setDevolviendoId] = useState<string | null>(null)
  const [motivoDevolucion, setMotivoDevolucion] = useState<string>('')
  const [convirtiendo, setConvirtiendo] = useState<string | null>(null)
  const [motivoConversion, setMotivoConversion] = useState<string>('')
  const [editingBoucherId, setEditingBoucherId] = useState<string | null>(null)
  const [replacingBoucherId, setReplacingBoucherId] = useState<string | null>(null)
  const boucherReplaceRef = useRef<HTMLInputElement>(null)
  const [boucherModalUrl, setBoucherModalUrl] = useState<string | null>(null)
  const [expandedPorRevisar, setExpandedPorRevisar] = useState<Set<string>>(new Set())
  const toggleExpandPorRevisar = (id: string) =>
    setExpandedPorRevisar((prev) => { const s = new Set(prev); s.has(id) ? s.delete(id) : s.add(id); return s })

  // Historial: ordenes_deposito confirmados por gestor
  const [historialDepositos, setHistorialDepositos] = useState<DepositoOrderDoc[]>([])

  // Cuentas bancarias de comercios (para mostrar en Por revisar)
  const [comercioBankInfo, setComercioBankInfo] = useState<Record<string, ComercioBankInfo>>({})

  // Nombres reales de motorizados (authUid → nombre)
  const [motorizadoNames, setMotorizadoNames] = useState<Record<string, string>>({})

  // Gastos aprobados no liquidados (para deducir del neto Storkhub)
  const [gastosAprobados, setGastosAprobados] = useState<Array<{ id: string; motorizadoId: string; monto: number }>>([])

  // Convertir pendiente en deuda (sin ordenes_deposito previo)
  const [convertPendienteMotId, setConvertPendienteMotId] = useState<string | null>(null)
  const [motivoConvertPendiente, setMotivoConvertPendiente] = useState('')
  const [convertingPendienteId, setConvertingPendienteId] = useState<string | null>(null)

  // ── Tabla resumen: búsqueda, filtros y expansión por motorizado ─────────────
  const [busqueda, setBusqueda] = useState('')
  const [filtroTipoDeposito, setFiltroTipoDeposito] = useState<'todos' | 'storkhub' | 'comercio'>('todos')
  const [expandedMotorizado, setExpandedMotorizado] = useState<Set<string>>(new Set())
  const toggleExpandedMotorizado = (id: string) =>
    setExpandedMotorizado((prev) => { const s = new Set(prev); s.has(id) ? s.delete(id) : s.add(id); return s })

  // Filtros historial
  const [filtroMotorizado, setFiltroMotorizado] = useState<string>('todos')

  // Filtro por motorizado en "Por revisar"
  const [filtroMotorizadoPorRevisar, setFiltroMotorizadoPorRevisar] = useState<string>('todos')
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

  // ── Rol del usuario actual ─────────────────────────────────────────────────

  useEffect(() => {
    const user = auth.currentUser
    if (!user) return
    getDoc(doc(db, 'usuarios', user.uid)).then((snap) => {
      setUserRol(snap.exists() ? (snap.data() as any)?.rol ?? null : null)
    })
  }, [])

  // ── Query ──────────────────────────────────────────────────────────────────

  useEffect(() => {
    const q = query(collection(db, 'solicitudes_envio'), where('estado', '==', 'entregado'))
    return onSnapshot(q, (snap) => {
      setOrdenes(snap.docs.map((d) => ({ id: d.id, ...(d.data() as any) } as Solicitud)))
      setLoading(false)
    })
  }, [])

  // Cargar gastos aprobados no liquidados para deducir del neto Storkhub
  useEffect(() => {
    const q = query(collection(db, 'gastos_motorizado'), where('estado', '==', 'aprobado'))
    return onSnapshot(q, (snap) => {
      const list = snap.docs
        .map((d) => ({ id: d.id, ...(d.data() as any) }))
        .filter((g: any) => !g.liquidacionId)
        .map((g: any) => ({ id: g.id, motorizadoId: g.motorizadoId as string, monto: g.monto as number }))
      setGastosAprobados(list)
    })
  }, [])

  // Query: ordenes_deposito pendientes de revisión gestora (motorizado las creó, gestor aún no confirmó)
  useEffect(() => {
    const q = query(collection(db, 'ordenes_deposito'), where('estado', 'in', ['pendiente_boucher', 'en_revision']))
    return onSnapshot(q, (snap) => {
      const list = snap.docs
        .map((d) => ({ id: d.id, ...(d.data() as any) } as DepositoOrderDoc))
        .sort((a, b) => (tsToDate(b.creadoAt)?.getTime() ?? 0) - (tsToDate(a.creadoAt)?.getTime() ?? 0))
      setPorRevisar(list)
    })
  }, [])

  // Fetch nombres reales de motorizados desde la colección 'motorizado' por authUid
  useEffect(() => {
    const allDeps = [...porRevisar, ...historialDepositos]
    const missing = [...new Set(
      allDeps
        .map((d) => d.motorizadoUid)
        .filter((uid) => uid && !motorizadoNames[uid])
    )] as string[]
    if (missing.length === 0) return
    Promise.all(
      missing.map((uid) =>
        getDocs(query(collection(db, 'motorizado'), where('authUid', '==', uid)))
      )
    ).then((results) => {
      const updates: Record<string, string> = {}
      results.forEach((snap, i) => {
        const data = snap.docs[0]?.data() as any
        if (data?.nombre) updates[missing[i]] = data.nombre
      })
      if (Object.keys(updates).length > 0)
        setMotorizadoNames((prev) => ({ ...prev, ...updates }))
    })
  }, [porRevisar, historialDepositos])

  // Fetch cuentas bancarias de comercios en "Por revisar"
  useEffect(() => {
    const missing = [...new Set(
      porRevisar
        .filter((d) => d.destinatario === 'comercio' && d.destinatarioId && !comercioBankInfo[d.destinatarioId])
        .map((d) => d.destinatarioId!)
    )]
    if (missing.length === 0) return
    Promise.all(missing.map((uid) => getDoc(doc(db, 'comercios', uid)))).then((snaps) => {
      const updates: Record<string, ComercioBankInfo> = {}
      snaps.forEach((snap, i) => {
        const data = snap.exists() ? (snap.data() as any) : {}
        updates[missing[i]] = { name: data.name || data.companyName || '', accounts: data.accounts ?? [] }
      })
      setComercioBankInfo((prev) => ({ ...prev, ...updates }))
    })
  }, [porRevisar])

  // Query: ordenes_deposito procesados por gestor (historial: confirmados y convertidos en deuda)
  useEffect(() => {
    const q = query(collection(db, 'ordenes_deposito'), where('estado', 'in', ['confirmado', 'convertido_en_deuda']))
    return onSnapshot(q, (snap) => {
      const list = snap.docs
        .map((d) => ({ id: d.id, ...(d.data() as any) } as DepositoOrderDoc))
        .sort((a, b) => (tsToDate(b.creadoAt)?.getTime() ?? 0) - (tsToDate(a.creadoAt)?.getTime() ?? 0))
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

  // ── Mapa de gastos deducibles por motorizado (doc ID) ─────────────────────

  const gastosMap = useMemo(() => {
    const map: Record<string, number> = {}
    gastosAprobados.forEach((g) => {
      if (!g.motorizadoId) return
      map[g.motorizadoId] = (map[g.motorizadoId] || 0) + g.monto
    })
    return map
  }, [gastosAprobados])

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
          storkhub: { ordenes: [], total: 0, totalBruto: 0, gastosDeducibles: 0 },
          comercios: [],
        })
      }
      const grupo = map.get(motId)!
      const dep = calcDeposito(o)
      const depoR = o.registro?.deposito

      // Storkhub pendiente: excluir si ya confirmado o si hay ordenes_deposito en curso.
      if (dep.totalAStorkhub > 0 && !depoR?.confirmadoStorkhub && !depoR?.storkhubDepositoId) {
        grupo.storkhub.ordenes.push(o)
        grupo.storkhub.totalBruto += dep.totalAStorkhub
      }

      // Comercio pendiente.
      // Misma lógica: excluir si ya confirmado o si el motorizado ya creó el depósito.
      if (dep.totalAlComercio > 0 && !depoR?.confirmadoComercio && !depoR?.comercioDepositoId) {
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

    // Aplicar gastos deducibles al neto de Storkhub
    map.forEach((grupo) => {
      const gastos = gastosMap[grupo.motorizadoId] || 0
      grupo.storkhub.gastosDeducibles = gastos
      grupo.storkhub.total = Math.max(0, grupo.storkhub.totalBruto - gastos)
    })

    return [...map.values()].filter(
      (g) => g.storkhub.ordenes.length > 0 || g.comercios.length > 0
    )
  }, [ordenesConDeposito, comercioNames, gastosMap])

  // ── KPIs (deriva de gruposMotorizado para usar neto Storkhub) ──────────────

  const kpis = useMemo(() => {
    let pendStorkhub = 0
    let pendComercios = 0
    let confirmadosHoy = 0

    gruposMotorizado.forEach((g) => {
      pendStorkhub += g.storkhub.total       // ya es neto
      g.comercios.forEach((c) => { pendComercios += c.total })
    })

    ordenesConDeposito.forEach((o) => {
      const depR = o.registro?.deposito
      if (isToday(depR?.confirmadoStorkhubAt) || isToday(depR?.confirmadoComercioAt) || isToday(depR?.confirmadoAt)) {
        confirmadosHoy++
      }
    })

    return { pendStorkhub, pendComercios, confirmadosHoy }
  }, [gruposMotorizado, ordenesConDeposito])

  // ── Grupos filtrados (tabla resumen Pendientes) ────────────────────────────

  const gruposFiltrados = useMemo(() => {
    let list = gruposMotorizado
    if (busqueda.trim()) {
      const q = busqueda.toLowerCase()
      list = list.filter((g) => {
        if (g.motorizadoNombre.toLowerCase().includes(q)) return true
        if (g.storkhub.ordenes.some((o) =>
          o.id.toLowerCase().includes(q) ||
          (o.ownerSnapshot?.companyName || o.ownerSnapshot?.nombre || '').toLowerCase().includes(q) ||
          (o.entrega?.nombreApellido || '').toLowerCase().includes(q)
        )) return true
        if (g.comercios.some((c) =>
          c.nombre.toLowerCase().includes(q) ||
          c.ordenes.some((o) =>
            o.id.toLowerCase().includes(q) ||
            (o.entrega?.nombreApellido || '').toLowerCase().includes(q)
          )
        )) return true
        return false
      })
    }
    if (filtroTipoDeposito === 'storkhub') list = list.filter((g) => g.storkhub.ordenes.length > 0)
    if (filtroTipoDeposito === 'comercio') list = list.filter((g) => g.comercios.length > 0)
    return list
  }, [gruposMotorizado, busqueda, filtroTipoDeposito])

  // ── KPIs extendidos ────────────────────────────────────────────────────────

  const kpisExtended = useMemo(() => ({
    ...kpis,
    totalGastosDescontados: gruposMotorizado.reduce((s, g) => s + g.storkhub.gastosDeducibles, 0),
    motorizadosConPendientes: gruposMotorizado.length,
    totalPorRevisar: porRevisar.length,
  }), [kpis, gruposMotorizado, porRevisar])

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

      const storkhubConfirmado = depoR?.confirmadoStorkhub
      const comercioConfirmado = depoR?.confirmadoComercio

      const storkhubAt = depoR?.confirmadoStorkhubAt
      const comercioAt = depoR?.confirmadoComercioAt

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
    const montoBruto = ordenes.reduce((s, o) => s + calcDeposito(o).totalAStorkhub, 0)
    const gastosDeMotorizado = gastosAprobados.filter((g) => g.motorizadoId === motId)
    const gastosDescontados = gastosDeMotorizado.reduce((s, g) => s + g.monto, 0)
    const montoTotal = Math.max(0, montoBruto - gastosDescontados)
    await setDoc(depositoRef, {
      creadoAt: serverTimestamp(),
      tipo: 'recaudacion_motorizado_storkhub',
      estado: 'confirmado',
      destinatario: 'storkhub',
      destinatarioId: 'storkhub',
      destinatarioNombre: 'Storkhub',
      cuentasDestino: [],
      motorizadoUid: motId,
      motorizadoNombre: motNombre,
      solicitudIds: ordenes.map((o) => o.id),
      montoTotal,
      montoBruto,
      gastosDescontados,
      gastosIds: gastosDeMotorizado.map((g) => g.id),
      boucher: boucherData,
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
    await registrarMovimiento('deposito_efectivo_storkhub', montoTotal,
      auth.currentUser?.uid ?? '',
      `Gestor confirmó depósito Storkhub · ${motNombre}`,
      { depositoId, motorizadoId: motId },
      {
        cuentas: { origen: cuentas.efectivoEnPoder(motId), destino: cuentas.banco },
        propietario: 'storkhub',
      }
    )
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
      tipo: 'recaudacion_motorizado_comercio',
      estado: 'confirmado',
      destinatario: 'comercio',
      destinatarioId: comercioUid,
      destinatarioNombre: comercioNombre,
      cuentasDestino: [],
      motorizadoUid: motId,
      motorizadoNombre: motNombre,
      solicitudIds: ordenes.map((o) => o.id),
      montoTotal,
      boucher: boucherData,
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
    await registrarMovimiento('deposito_efectivo_comercio', montoTotal,
      auth.currentUser?.uid ?? '',
      `Gestor confirmó depósito comercio ${comercioNombre} · ${motNombre}`,
      { depositoId, motorizadoId: motId, comercioId: comercioUid },
      {
        cuentas: { origen: cuentas.efectivoEnPoder(motId), destino: cuentas.saldoComercio(comercioUid) },
        propietario: `comercio:${comercioUid}`,
      }
    )
  }

  // ── Confirmar depósito existente (creado por motorizado) ──────────────────

  async function confirmarDepositoExistente(dep: DepositoOrderDoc) {
    setConfirmandoId(dep.id)
    try {
      const { doc: docRef } = await import('firebase/firestore')
      const ref = docRef(db, 'ordenes_deposito', dep.id)
      const b = writeBatch(db)
      b.update(ref, {
        estado: 'confirmado',
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
      const _esStorkhub = dep.destinatario === 'storkhub'
      await registrarMovimiento(
        _esStorkhub ? 'deposito_efectivo_storkhub' : 'deposito_efectivo_comercio',
        dep.montoTotal,
        auth.currentUser?.uid ?? '',
        `Depósito confirmado · ${dep.destinatarioNombre} · ${dep.motorizadoNombre}`,
        { depositoId: dep.id, motorizadoId: dep.motorizadoUid },
        {
          cuentas: {
            origen: cuentas.efectivoEnPoder(dep.motorizadoUid),
            destino: _esStorkhub ? cuentas.banco : cuentas.saldoComercio(dep.destinatarioId ?? dep.destinatarioNombre),
          },
          propietario: _esStorkhub ? 'storkhub' : `comercio:${dep.destinatarioId ?? dep.destinatarioNombre}`,
        }
      )
    } finally {
      setConfirmandoId(null)
    }
  }

  // ── Devolver depósito al motorizado (lo elimina y resetea las órdenes) ──────

  async function devolverAlMotorizado(dep: DepositoOrderDoc, motivo: string) {
    setDevolviendoId(dep.id)
    try {
      const b = writeBatch(db)
      // Eliminar el doc de ordenes_deposito — el motorizado creará uno nuevo al re-subir
      b.delete(doc(db, 'ordenes_deposito', dep.id))
      // Resetear las solicitudes para que el motorizado las vea como pendientes.
      const esStorkhub = dep.destinatario === 'storkhub'
      dep.solicitudIds.forEach((sid) => {
        b.update(doc(db, 'solicitudes_envio', sid), esStorkhub ? {
          'registro.deposito.confirmadoStorkhub': false,
          'registro.deposito.confirmadoStorkhubAt': null,
          'registro.deposito.storkhubDepositoId': null,
        } : {
          'registro.deposito.confirmadoComercio': false,
          'registro.deposito.confirmadoComercioAt': null,
          'registro.deposito.comercioDepositoId': null,
        })
      })
      await b.commit()
      // No se registra movimiento financiero: el rechazo por boucher incorrecto
      // no representa movimiento real de dinero — es solo un evento operativo.
    } finally {
      setDevolviendoId(null)
      setMotivoDevolucion('')
    }
  }

  // ── Convertir depósito pendiente en saldo a cargo del motorizado ─────────

  async function convertirEnDeuda(dep: DepositoOrderDoc, motivo: string) {
    if (!motivo.trim()) return
    setConvirtiendo(dep.id)
    try {
      // Buscar el motorizadoId (doc ID en colección motorizado) a partir del authUid
      const { getDocs: _getDocs, query: _query, collection: _col, where: _where } = await import('firebase/firestore')
      const snap = await _getDocs(_query(_col(db, 'motorizado'), _where('authUid', '==', dep.motorizadoUid)))
      const motDoc = snap.docs[0]
      const motorizadoId = motDoc?.id ?? dep.motorizadoUid

      await convertirDepositoEnDeuda({
        depositoId: dep.id,
        solicitudIds: dep.solicitudIds ?? [],
        destinatario: dep.destinatario,
        monto: dep.montoTotal,
        motorizadoId,
        motorizadoUid: dep.motorizadoUid,
        motorizadoNombre: dep.motorizadoNombre,
        nota: motivo,
        operadorId: auth.currentUser?.uid ?? '',
      })
    } catch (e) {
      console.error('Error convirtiendo en deuda:', e)
    } finally {
      setConvirtiendo(null)
      setMotivoConversion('')
    }
  }

  // ── Convertir grupo Storkhub pendiente (sin ordenes_deposito) en deuda ──────

  async function convertirPendienteEnDeuda(gm: GrupoMotorizado, motivo: string) {
    if (!motivo.trim()) return
    setConvertingPendienteId(gm.motorizadoId)
    try {
      const ordenes = gm.storkhub.ordenes
      const motAuthUid = ordenes[0]?.asignacion?.motorizadoAuthUid || gm.motorizadoId
      const monto = gm.storkhub.total  // neto

      // 1. Crear ordenes_deposito (convertirDepositoEnDeuda lo requiere existente)
      const depositoRef = doc(collection(db, 'ordenes_deposito'))
      const depositoId = depositoRef.id
      await setDoc(depositoRef, {
        creadoAt: serverTimestamp(),
        tipo: 'recaudacion_motorizado_storkhub',
        estado: 'pendiente_boucher',
        destinatario: 'storkhub',
        destinatarioId: 'storkhub',
        destinatarioNombre: 'Storkhub',
        motorizadoUid: motAuthUid,
        motorizadoNombre: gm.motorizadoNombre,
        solicitudIds: ordenes.map((o) => o.id),
        montoTotal: monto,
        montoBruto: gm.storkhub.totalBruto,
        gastosDescontados: gm.storkhub.gastosDeducibles,
        gastosIds: gastosAprobados.filter((g) => g.motorizadoId === gm.motorizadoId).map((g) => g.id),
      })

      // 2. Convertir en deuda
      await convertirDepositoEnDeuda({
        depositoId,
        solicitudIds: ordenes.map((o) => o.id),
        destinatario: 'storkhub',
        monto,
        motorizadoId: gm.motorizadoId,
        motorizadoUid: motAuthUid,
        motorizadoNombre: gm.motorizadoNombre,
        nota: motivo,
        operadorId: auth.currentUser?.uid ?? '',
      })
    } catch (e) {
      console.error('Error convirtiendo pendiente en deuda:', e)
    } finally {
      setConvertingPendienteId(null)
      setConvertPendienteMotId(null)
      setMotivoConvertPendiente('')
    }
  }

  // ── Reemplazar boucher de un depósito en "Por revisar" ────────────────────

  async function reemplazarBoucher(dep: DepositoOrderDoc, file: File) {
    setReplacingBoucherId(dep.id)
    try {
      const blob = await compressImage(file)
      const { url, pathStorage } = await uploadDepositoBoucher(dep.id, blob)
      await setDoc(doc(db, 'ordenes_deposito', dep.id), { boucher: { url, pathStorage } }, { merge: true })
      setEditingBoucherId(null)
    } catch (e: any) {
      console.error('Error reemplazando boucher:', e)
    } finally {
      setReplacingBoucherId(null)
    }
  }

  // ── Anular movimientos financieros activos de un depósito ────────────────
  // Usado antes de rehacer o eliminar un depósito confirmado para evitar
  // que el ledger cuente el mismo depósito dos veces.
  // No borra nada — solo marca estado: 'anulado' con trazabilidad.

  async function anularMovimientosDeDeposito(depositoId: string, motivo: string) {
    const snap = await getDocs(
      query(collection(db, 'movimientos_financieros'), where('depositoId', '==', depositoId))
    )
    const activos = snap.docs.filter((d) => (d.data() as any).estado !== 'anulado')
    if (activos.length === 0) return
    const b = writeBatch(db)
    activos.forEach((d) => {
      b.update(d.ref, {
        estado: 'anulado',
        anuladoAt: serverTimestamp(),
        anuladoPorUid: auth.currentUser?.uid ?? '',
        motivoAnulacion: motivo,
      })
    })
    await b.commit()
  }

  // ── Rehacer depósito: vuelve a "Por revisar" para que el motorizado reenvíe ──

  async function rehacerDeposito(dep: DepositoOrderDoc) {
    const ok = window.confirm(
      `¿Rehacer este depósito?\n\nMonto: ${fmt(dep.montoTotal)}\nMotorizado: ${dep.motorizadoNombre}\n\nEl depósito volverá a "Por revisar" para que se corrija.\nSe anularán los movimientos financieros asociados.`
    )
    if (!ok) return
    // 1. Anular movimientos del ledger — el depósito no está más confirmado
    await anularMovimientosDeDeposito(dep.id, 'Depósito revertido a revisión por gestor')
    // 2. Resetear estado operativo
    const ref = doc(db, 'ordenes_deposito', dep.id)
    await setDoc(ref, {
      estado: 'en_revision',
    }, { merge: true })
  }

  // ── Eliminar depósito (solo admin) ────────────────────────────────────────

  async function eliminarDeposito(dep: DepositoOrderDoc) {
    const ok = window.confirm(
      `¿Eliminar este depósito?\n\nMonto: ${fmt(dep.montoTotal)}\nMotorizado: ${dep.motorizadoNombre}\nÓrdenes: ${dep.solicitudIds.join(', ')}\n\nEsta acción no se puede deshacer.`
    )
    if (!ok) return
    // Anular movimientos del ledger antes de eliminar el doc
    await anularMovimientosDeDeposito(dep.id, 'Depósito eliminado por gestor')
    await deleteDoc(doc(db, 'ordenes_deposito', dep.id))
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
      <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-5 gap-3">
        <div className="border rounded-xl px-4 py-3 bg-blue-50 border-blue-200">
          <p className="text-xl font-black text-[#004aad]">{loading ? '…' : fmt(kpisExtended.pendStorkhub)}</p>
          <p className="text-[11px] font-semibold mt-0.5 text-blue-500 flex items-center gap-1">
            <Landmark className="h-3 w-3" /> Storkhub neto
          </p>
        </div>
        <div className="border rounded-xl px-4 py-3 bg-purple-50 border-purple-200">
          <p className="text-xl font-black text-purple-700">{loading ? '…' : fmt(kpisExtended.pendComercios)}</p>
          <p className="text-[11px] font-semibold mt-0.5 text-purple-400 flex items-center gap-1">
            <Store className="h-3 w-3" /> Comercios pendiente
          </p>
        </div>
        <div className="border rounded-xl px-4 py-3 bg-amber-50 border-amber-200">
          <p className="text-xl font-black text-amber-600">{loading ? '…' : kpisExtended.totalPorRevisar}</p>
          <p className="text-[11px] font-semibold mt-0.5 text-amber-500 flex items-center gap-1">
            <Clock className="h-3 w-3" /> Por revisar
          </p>
        </div>
        <div className="border rounded-xl px-4 py-3 bg-orange-50 border-orange-200">
          <p className="text-xl font-black text-orange-600">{loading ? '…' : fmt(kpisExtended.totalGastosDescontados)}</p>
          <p className="text-[11px] font-semibold mt-0.5 text-orange-400 flex items-center gap-1">
            <Zap className="h-3 w-3" /> Gastos descontados
          </p>
        </div>
        <div className="border rounded-xl px-4 py-3 bg-gray-50 border-gray-200">
          <p className="text-xl font-black text-gray-700">{loading ? '…' : kpisExtended.motorizadosConPendientes}</p>
          <p className="text-[11px] font-semibold mt-0.5 text-gray-400 flex items-center gap-1">
            <Users className="h-3 w-3" /> Motorizados activos
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
        <div className="flex flex-col gap-3">

          {/* Barra búsqueda + filtros */}
          <div className="flex flex-wrap gap-2 items-center">
            <div className="flex items-center border border-gray-200 rounded-lg px-3 py-2 bg-white gap-2 flex-1 min-w-[180px]">
              <Search className="h-3.5 w-3.5 text-gray-400 shrink-0" />
              <input
                value={busqueda}
                onChange={(e) => setBusqueda(e.target.value)}
                placeholder="Buscar motorizado, orden, comercio…"
                className="text-xs flex-1 outline-none text-gray-700 placeholder:text-gray-400"
              />
              {busqueda && (
                <button onClick={() => setBusqueda('')}><X className="h-3 w-3 text-gray-400" /></button>
              )}
            </div>
            {(['todos', 'storkhub', 'comercio'] as const).map((t) => (
              <button key={t} onClick={() => setFiltroTipoDeposito(t)}
                className={`px-3 py-1.5 rounded-lg text-xs font-semibold border transition ${filtroTipoDeposito === t ? 'bg-gray-900 text-white border-gray-900' : 'bg-white text-gray-600 border-gray-200 hover:bg-gray-50'}`}>
                {t === 'todos' ? 'Todos' : t === 'storkhub' ? '🏦 Storkhub' : '🏪 Comercio'}
              </button>
            ))}
            <span className="text-xs text-gray-400 ml-auto">{gruposFiltrados.length} motorizado{gruposFiltrados.length !== 1 ? 's' : ''}</span>
          </div>

          {loading ? (
            <div className="bg-white rounded-xl border py-16 text-center text-sm text-gray-400">Cargando…</div>
          ) : gruposFiltrados.length === 0 ? (
            <div className="bg-white rounded-xl border flex flex-col items-center justify-center py-16 gap-2 text-gray-400">
              <CheckCircle2 className="h-12 w-12 opacity-25" />
              <p className="text-sm font-semibold">{busqueda ? 'Sin resultados' : 'Sin depósitos pendientes'}</p>
              <p className="text-xs">{busqueda ? 'Cambiá los filtros de búsqueda.' : 'Todos los motorizados confirmaron sus depósitos.'}</p>
            </div>
          ) : (
            /* ── TABLA RESUMEN ── */
            <div className="bg-white rounded-xl border border-gray-200 shadow-sm overflow-hidden">
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b bg-gray-50">
                    <th className="px-4 py-2.5 text-left text-[11px] font-semibold uppercase tracking-wide text-gray-500 w-8"></th>
                    <th className="px-4 py-2.5 text-left text-[11px] font-semibold uppercase tracking-wide text-gray-500">Motorizado</th>
                    <th className="px-4 py-2.5 text-right text-[11px] font-semibold uppercase tracking-wide text-blue-500">Storkhub neto</th>
                    <th className="px-4 py-2.5 text-right text-[11px] font-semibold uppercase tracking-wide text-purple-500">Comercios</th>
                    <th className="px-4 py-2.5 text-right text-[11px] font-semibold uppercase tracking-wide text-orange-400">Gastos desc.</th>
                    <th className="px-4 py-2.5 text-center text-[11px] font-semibold uppercase tracking-wide text-gray-500">Órdenes</th>
                    <th className="px-4 py-2.5 text-center text-[11px] font-semibold uppercase tracking-wide text-amber-500">Por revisar</th>
                    <th className="px-4 py-2.5 text-left text-[11px] font-semibold uppercase tracking-wide text-gray-500">Último dep.</th>
                    <th className="px-4 py-2.5 text-right text-[11px] font-semibold uppercase tracking-wide text-gray-500">Acciones</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-gray-100">
                  {gruposFiltrados.map((gm) => {
                    const comercioTotal = gm.comercios.reduce((s, c) => s + c.total, 0)
                    const totalOrdenes = gm.storkhub.ordenes.length + gm.comercios.reduce((s, c) => s + c.ordenes.length, 0)
                    const motAuthUid = gm.storkhub.ordenes[0]?.asignacion?.motorizadoAuthUid ?? ''
                    const porRevisarCount = porRevisar.filter((d) =>
                      d.motorizadoUid === motAuthUid || d.motorizadoNombre === gm.motorizadoNombre
                    ).length
                    const todasLasOrdenes = [...gm.storkhub.ordenes, ...gm.comercios.flatMap((c) => c.ordenes)]
                    const ultimoTs = todasLasOrdenes
                      .map((o) => getEntregadoAt(o))
                      .filter(Boolean)
                      .sort((a, b) => (b as Timestamp).toMillis() - (a as Timestamp).toMillis())[0]
                    const isExp = expandedMotorizado.has(gm.motorizadoId)

                    return (
                      <Fragment key={gm.motorizadoId}>
                        {/* ── FILA RESUMEN ── */}
                        <tr
                          className={`hover:bg-gray-50 transition-colors cursor-pointer select-none ${isExp ? 'bg-blue-50/40' : ''}`}
                          onClick={() => toggleExpandedMotorizado(gm.motorizadoId)}
                        >
                          <td className="px-4 py-3 text-center">
                            {isExp
                              ? <ChevronUp className="h-4 w-4 text-gray-400" />
                              : <ChevronDown className="h-4 w-4 text-gray-400" />}
                          </td>
                          <td className="px-4 py-3">
                            <div className="flex items-center gap-2">
                              <div className="w-7 h-7 rounded-full bg-[#004aad]/10 grid place-items-center shrink-0">
                                <span className="text-xs font-black text-[#004aad]">{gm.motorizadoNombre[0]?.toUpperCase() ?? '?'}</span>
                              </div>
                              <span className="text-sm font-semibold text-gray-900">{gm.motorizadoNombre}</span>
                            </div>
                          </td>
                          <td className="px-4 py-3 text-right">
                            {gm.storkhub.ordenes.length > 0 ? (
                              <div>
                                <span className="text-sm font-black text-[#004aad]">{fmt(gm.storkhub.total)}</span>
                                {gm.storkhub.gastosDeducibles > 0 && (
                                  <p className="text-[10px] text-orange-500 mt-0.5">bruto {fmt(gm.storkhub.totalBruto)}</p>
                                )}
                              </div>
                            ) : <span className="text-xs text-gray-300">—</span>}
                          </td>
                          <td className="px-4 py-3 text-right">
                            {comercioTotal > 0
                              ? <span className="text-sm font-black text-purple-700">{fmt(comercioTotal)}</span>
                              : <span className="text-xs text-gray-300">—</span>}
                          </td>
                          <td className="px-4 py-3 text-right">
                            {gm.storkhub.gastosDeducibles > 0
                              ? <span className="text-xs font-semibold text-orange-500">− {fmt(gm.storkhub.gastosDeducibles)}</span>
                              : <span className="text-xs text-gray-300">—</span>}
                          </td>
                          <td className="px-4 py-3 text-center">
                            <span className="inline-flex items-center justify-center w-6 h-6 rounded-full bg-gray-100 text-xs font-black text-gray-700">{totalOrdenes}</span>
                          </td>
                          <td className="px-4 py-3 text-center">
                            {porRevisarCount > 0
                              ? <span className="inline-flex items-center justify-center w-6 h-6 rounded-full bg-amber-100 text-xs font-black text-amber-700">{porRevisarCount}</span>
                              : <span className="text-xs text-gray-300">—</span>}
                          </td>
                          <td className="px-4 py-3 text-xs text-gray-500">{ultimoTs ? fmtDate(ultimoTs) : '—'}</td>
                          <td className="px-4 py-3 text-right" onClick={(e) => e.stopPropagation()}>
                            <div className="flex items-center justify-end gap-1.5">
                              <button
                                onClick={() => toggleExpandedMotorizado(gm.motorizadoId)}
                                className="flex items-center gap-1 text-[11px] font-semibold text-[#004aad] bg-blue-50 hover:bg-blue-100 px-2 py-1 rounded-lg transition"
                              >
                                <Eye className="h-3 w-3" />
                                {isExp ? 'Cerrar' : 'Detalle'}
                              </button>
                              {gm.storkhub.ordenes.length > 0 && convertPendienteMotId !== gm.motorizadoId && (
                                <button
                                  onClick={() => setConvertPendienteMotId(gm.motorizadoId)}
                                  className="text-[11px] font-semibold text-red-500 hover:text-red-700 hover:bg-red-50 border border-red-200 px-2 py-1 rounded-lg transition"
                                  title="Convertir en saldo a cargo"
                                >
                                  → Deuda
                                </button>
                              )}
                            </div>
                          </td>
                        </tr>

                        {/* ── DETALLE EXPANDIDO ── */}
                        {isExp && (
                          <tr>
                            <td colSpan={9} className="bg-gray-50/60 px-4 py-4">
                              <div className="flex flex-col gap-3">

                                {/* Convertir en deuda form (si activo) */}
                                {convertPendienteMotId === gm.motorizadoId && (
                                  <div className="flex flex-col gap-2">
                                    <p className="text-[11px] font-semibold text-red-700 bg-red-50 border border-red-200 rounded-lg px-3 py-2">
                                      ⚠️ El monto neto ({fmt(gm.storkhub.total)}) se registrará como <strong>saldo a cargo</strong> del motorizado.
                                    </p>
                                    <input
                                      value={motivoConvertPendiente}
                                      onChange={(e) => setMotivoConvertPendiente(e.target.value)}
                                      placeholder="Motivo (ej: no depositó, se acordó descuento)…"
                                      className="text-xs border border-red-200 rounded-lg px-3 py-2 focus:outline-none focus:ring-1 focus:ring-red-300"
                                      autoFocus
                                    />
                                    <div className="flex gap-2 max-w-sm">
                                      <button onClick={() => { setConvertPendienteMotId(null); setMotivoConvertPendiente('') }}
                                        className="flex-1 text-xs font-semibold px-3 py-2 rounded-lg border border-gray-200 text-gray-600 hover:bg-gray-50 transition">
                                        Cancelar
                                      </button>
                                      <button
                                        onClick={() => convertirPendienteEnDeuda(gm, motivoConvertPendiente)}
                                        disabled={!motivoConvertPendiente.trim() || convertingPendienteId === gm.motorizadoId}
                                        className="flex-1 text-xs font-semibold px-3 py-2 rounded-lg bg-red-600 text-white hover:bg-red-700 transition disabled:opacity-40 disabled:cursor-not-allowed">
                                        {convertingPendienteId === gm.motorizadoId ? 'Procesando…' : 'Confirmar — crear deuda'}
                                      </button>
                                    </div>
                                  </div>
                                )}

                                {/* Grupo Storkhub */}
                                {gm.storkhub.ordenes.length > 0 && (
                                  <DepositoGrupo
                                    icon={<Landmark className="h-4 w-4 text-blue-600" />}
                                    titulo="Storkhub"
                                    subtitulo="Delivery en efectivo"
                                    colorBorder="border-blue-200"
                                    colorBg="bg-blue-50"
                                    total={gm.storkhub.total}
                                    totalBruto={gm.storkhub.totalBruto}
                                    gastosDeducibles={gm.storkhub.gastosDeducibles}
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
                            </td>
                          </tr>
                        )}
                      </Fragment>
                    )
                  })}
                </tbody>
              </table>
            </div>
          )}
        </div>
      )}

      {/* ── TAB: POR REVISAR ──────────────────────────────────────────────── */}
      {tab === 'por_revisar' && (() => {
        const motorizadosPR = (() => {
          const map = new Map<string, string>()
          porRevisar.forEach((d) => { if (d.motorizadoUid && d.motorizadoNombre) map.set(d.motorizadoUid, d.motorizadoNombre) })
          return [...map.entries()].map(([id, nombre]) => ({ id, nombre }))
        })()
        const porRevisarFiltrado = filtroMotorizadoPorRevisar === 'todos'
          ? porRevisar
          : porRevisar.filter((d) => d.motorizadoUid === filtroMotorizadoPorRevisar)
        return (
        <>
        <div className="flex flex-col gap-3">
          {/* Pills filtro motorizado */}
          {motorizadosPR.length > 0 && (
            <div className="flex flex-wrap gap-2">
              <button onClick={() => setFiltroMotorizadoPorRevisar('todos')}
                className={`px-3 py-1 rounded-full text-xs font-semibold border transition ${filtroMotorizadoPorRevisar === 'todos' ? 'bg-gray-900 text-white border-gray-900' : 'bg-white text-gray-600 border-gray-200 hover:bg-gray-50'}`}>
                Todos ({porRevisar.length})
              </button>
              {motorizadosPR.map((m) => (
                <button key={m.id} onClick={() => setFiltroMotorizadoPorRevisar(m.id)}
                  className={`px-3 py-1 rounded-full text-xs font-semibold border transition ${filtroMotorizadoPorRevisar === m.id ? 'bg-[#004aad] text-white border-[#004aad]' : 'bg-white text-gray-600 border-gray-200 hover:bg-gray-50'}`}>
                  {fmtNombreMotorizado(m.nombre, motorizadoNames, m.id)}
                </button>
              ))}
            </div>
          )}
          {porRevisarFiltrado.length === 0 ? (
            <div className="bg-white rounded-xl border flex flex-col items-center justify-center py-16 gap-2 text-gray-400">
              <CheckCircle2 className="h-12 w-12 opacity-25" />
              <p className="text-sm font-semibold">Sin depósitos por revisar</p>
              <p className="text-xs">Los depósitos subidos por motorizados aparecerán aquí.</p>
            </div>
          ) : (
            /* ── TABLA RESUMEN POR REVISAR ── */
            <div className="bg-white rounded-xl border border-gray-200 shadow-sm overflow-hidden">
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b bg-gray-50">
                    <th className="px-3 py-2.5 w-8"></th>
                    <th className="px-3 py-2.5 text-left text-[11px] font-semibold uppercase tracking-wide text-gray-500">Motorizado</th>
                    <th className="px-3 py-2.5 text-left text-[11px] font-semibold uppercase tracking-wide text-gray-500">Destino</th>
                    <th className="px-3 py-2.5 text-left text-[11px] font-semibold uppercase tracking-wide text-gray-500">Fecha</th>
                    <th className="px-3 py-2.5 text-right text-[11px] font-semibold uppercase tracking-wide text-gray-500">Monto</th>
                    <th className="px-3 py-2.5 text-center text-[11px] font-semibold uppercase tracking-wide text-gray-500">Órd.</th>
                    <th className="px-3 py-2.5 text-center text-[11px] font-semibold uppercase tracking-wide text-gray-500">Boucher</th>
                    <th className="px-3 py-2.5 text-right text-[11px] font-semibold uppercase tracking-wide text-gray-500">Acciones</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-gray-100">
                  {porRevisarFiltrado.map((dep) => {
                    const esStorkhub = dep.destinatario === 'storkhub'
                    const bankInfo = dep.destinatarioId ? comercioBankInfo[dep.destinatarioId] : undefined
                    const isExp = expandedPorRevisar.has(dep.id)
                    const isBusy = confirmandoId === dep.id || devolviendoId === dep.id || convirtiendo === dep.id
                    return (
                      <Fragment key={dep.id}>
                        {/* ── FILA RESUMEN ── */}
                        <tr className={`hover:bg-gray-50 transition-colors ${isExp || isBusy ? 'bg-blue-50/30' : ''}`}>
                          <td className="px-3 py-3 text-center cursor-pointer" onClick={() => toggleExpandPorRevisar(dep.id)}>
                            {isExp ? <ChevronUp className="h-3.5 w-3.5 text-gray-400" /> : <ChevronDown className="h-3.5 w-3.5 text-gray-400" />}
                          </td>
                          <td className="px-3 py-3">
                            <span className="text-xs font-semibold text-gray-800">{fmtNombreMotorizado(dep.motorizadoNombre, motorizadoNames, dep.motorizadoUid)}</span>
                          </td>
                          <td className="px-3 py-3">
                            <span className={`inline-flex items-center gap-1 text-[11px] font-semibold px-2 py-0.5 rounded-full border ${esStorkhub ? 'bg-blue-50 text-blue-700 border-blue-200' : 'bg-purple-50 text-purple-700 border-purple-200'}`}>
                              {esStorkhub ? <Landmark className="h-2.5 w-2.5" /> : <Store className="h-2.5 w-2.5" />}
                              {dep.destinatarioNombre}
                            </span>
                          </td>
                          <td className="px-3 py-3 text-xs text-gray-500">{fmtDate(dep.creadoAt)}</td>
                          <td className="px-3 py-3 text-right">
                            <div>
                              <span className="text-sm font-black text-gray-900">{fmt(dep.montoTotal)}</span>
                              {esStorkhub && dep.montoBruto != null && dep.gastosDescontados != null && dep.gastosDescontados > 0 && (
                                <p className="text-[10px] text-orange-500 mt-0.5">bruto {fmt(dep.montoBruto)} − {fmt(dep.gastosDescontados)}</p>
                              )}
                            </div>
                          </td>
                          <td className="px-3 py-3 text-center">
                            <span className="text-xs text-gray-500">{dep.solicitudIds?.length ?? 0}</span>
                          </td>
                          <td className="px-3 py-3 text-center">
                            {dep.boucher?.url ? (
                              <button onClick={() => setBoucherModalUrl(dep.boucher!.url)}>
                                {/* eslint-disable-next-line @next/next/no-img-element */}
                                <img src={dep.boucher.url} alt="boucher" className="w-8 h-8 rounded object-cover border border-green-200 hover:opacity-80 transition mx-auto" />
                              </button>
                            ) : (
                              <button
                                onClick={() => { setEditingBoucherId(dep.id); boucherReplaceRef.current?.click() }}
                                className="text-[10px] text-red-400 font-semibold hover:text-red-600 transition"
                              >
                                Sin boucher
                              </button>
                            )}
                          </td>
                          <td className="px-3 py-3 text-right">
                            <div className="flex items-center justify-end gap-1">
                              {/* Devolver */}
                              {devolviendoId !== dep.id && convirtiendo !== dep.id && (
                                <button
                                  onClick={() => setDevolviendoId(dep.id)}
                                  disabled={isBusy}
                                  className="text-[11px] font-semibold px-2 py-1 rounded-lg border border-orange-200 text-orange-500 hover:bg-orange-50 transition disabled:opacity-40"
                                  title="Devolver al motorizado"
                                >↩</button>
                              )}
                              {/* Confirmar */}
                              {devolviendoId !== dep.id && convirtiendo !== dep.id && (
                                <button
                                  onClick={() => confirmarDepositoExistente(dep)}
                                  disabled={isBusy}
                                  className={`text-[11px] font-semibold px-2 py-1 rounded-lg transition disabled:opacity-40 ${esStorkhub ? 'bg-blue-600 text-white hover:bg-blue-700' : 'bg-purple-600 text-white hover:bg-purple-700'}`}
                                >
                                  {confirmandoId === dep.id ? '…' : '✓'}
                                </button>
                              )}
                              {/* Deuda (solo Storkhub) */}
                              {esStorkhub && devolviendoId !== dep.id && convirtiendo !== dep.id && (
                                <button
                                  onClick={() => setConvirtiendo(dep.id)}
                                  disabled={isBusy}
                                  className="text-[11px] font-semibold px-2 py-1 rounded-lg border border-red-200 text-red-500 hover:bg-red-50 transition disabled:opacity-40"
                                  title="Convertir en deuda"
                                >→ Deuda</button>
                              )}
                              {/* Ver detalle */}
                              <button
                                onClick={() => toggleExpandPorRevisar(dep.id)}
                                className="text-[11px] font-semibold px-2 py-1 rounded-lg border border-gray-200 text-gray-500 hover:bg-gray-50 transition flex items-center gap-1"
                              >
                                <Eye className="h-3 w-3" />
                              </button>
                            </div>
                          </td>
                        </tr>

                        {/* ── DETALLE / FORMULARIOS EXPANDIDOS ── */}
                        {(isExp || devolviendoId === dep.id || convirtiendo === dep.id) && (
                          <tr>
                            <td colSpan={8} className="bg-gray-50/60 px-4 py-4 border-t border-gray-100">
                              <div className="flex flex-col gap-3">

                                {/* Cuentas bancarias del comercio */}
                                {!esStorkhub && bankInfo?.accounts && bankInfo.accounts.length > 0 && (
                                  <div className="flex flex-wrap gap-3">
                                    {bankInfo.accounts.map((acc, i) => (
                                      <div key={i} className="flex items-center gap-2 text-xs bg-purple-50 border border-purple-100 rounded-lg px-3 py-2">
                                        <span className="font-semibold text-purple-700 bg-purple-100 px-1.5 py-0.5 rounded">{acc.bank}</span>
                                        <span className="font-mono text-gray-800 select-all">{acc.number}</span>
                                        <span className="text-gray-500">{acc.holder}</span>
                                        <span className="text-gray-400">{acc.currency}</span>
                                      </div>
                                    ))}
                                  </div>
                                )}

                                {/* Órdenes incluidas */}
                                {isExp && (dep.solicitudIds?.length ?? 0) > 0 && (
                                  <div>
                                    <p className="mb-1.5 text-[11px] font-semibold uppercase tracking-wide text-gray-400">Órdenes incluidas</p>
                                    <div className="flex flex-wrap gap-1.5">
                                      {dep.solicitudIds.map((sid) => (
                                        <button key={sid} onClick={() => setSelectedOrdenId(sid)}
                                          className="rounded bg-white border border-gray-200 px-2 py-0.5 font-mono text-xs text-blue-600 hover:bg-blue-50 transition">
                                          {sid.slice(0, 8)}…
                                        </button>
                                      ))}
                                    </div>
                                  </div>
                                )}

                                {/* Boucher detalle */}
                                {isExp && (
                                  <div className="flex items-center gap-3 flex-wrap">
                                    {dep.boucher?.url ? (
                                      <>
                                        <button onClick={() => setBoucherModalUrl(dep.boucher!.url)}
                                          className="flex items-center gap-2 rounded-lg border border-gray-200 bg-white px-3 py-2 text-xs font-semibold text-gray-700 hover:bg-gray-50 transition">
                                          {/* eslint-disable-next-line @next/next/no-img-element */}
                                          <img src={dep.boucher.url} alt="boucher" className="h-8 w-8 rounded object-cover border border-gray-200" />
                                          Ver comprobante
                                        </button>
                                        <button onClick={() => { setEditingBoucherId(dep.id); boucherReplaceRef.current?.click() }}
                                          disabled={replacingBoucherId === dep.id}
                                          className="text-[11px] text-blue-500 hover:text-blue-700 hover:underline transition disabled:opacity-40">
                                          {replacingBoucherId === dep.id ? '⏳ Subiendo…' : '📷 Reemplazar'}
                                        </button>
                                      </>
                                    ) : (
                                      <button onClick={() => { setEditingBoucherId(dep.id); boucherReplaceRef.current?.click() }}
                                        disabled={replacingBoucherId === dep.id}
                                        className="text-[11px] font-semibold text-blue-500 hover:text-blue-700 transition border border-blue-200 bg-blue-50 px-3 py-1.5 rounded-lg disabled:opacity-40">
                                        {replacingBoucherId === dep.id ? '⏳ Subiendo…' : '📷 Subir boucher'}
                                      </button>
                                    )}
                                    <p className="text-[10px] text-gray-400 font-mono">ID: {dep.id}</p>
                                  </div>
                                )}

                                {/* Form devolver */}
                                {devolviendoId === dep.id && (
                                  <div className="flex flex-col gap-2 max-w-lg">
                                    <input value={motivoDevolucion} onChange={(e) => setMotivoDevolucion(e.target.value)}
                                      placeholder="Motivo de devolución…"
                                      className="text-xs border border-orange-200 rounded-lg px-3 py-2 focus:outline-none focus:ring-1 focus:ring-orange-300"
                                      autoFocus />
                                    <div className="flex gap-2">
                                      <button onClick={() => { setDevolviendoId(null); setMotivoDevolucion('') }}
                                        className="flex-1 text-xs font-semibold px-3 py-2 rounded-lg border border-gray-200 text-gray-600 hover:bg-gray-50 transition">
                                        Cancelar
                                      </button>
                                      <button onClick={() => devolverAlMotorizado(dep, motivoDevolucion)}
                                        disabled={!motivoDevolucion.trim()}
                                        className="flex-1 text-xs font-semibold px-3 py-2 rounded-lg bg-orange-500 text-white hover:bg-orange-600 transition disabled:opacity-40 disabled:cursor-not-allowed">
                                        Confirmar devolución
                                      </button>
                                    </div>
                                  </div>
                                )}

                                {/* Form convertir en deuda */}
                                {convirtiendo === dep.id && (
                                  <div className="flex flex-col gap-2 max-w-lg">
                                    <p className="text-[11px] font-semibold text-red-700 bg-red-50 border border-red-200 rounded-lg px-3 py-2">
                                      ⚠️ El depósito se marcará como <strong>saldo a cargo</strong> del motorizado. Registrá el motivo.
                                    </p>
                                    <input value={motivoConversion} onChange={(e) => setMotivoConversion(e.target.value)}
                                      placeholder="Motivo (ej: motorizado justificó uso del dinero)…"
                                      className="text-xs border border-red-200 rounded-lg px-3 py-2 focus:outline-none focus:ring-1 focus:ring-red-300"
                                      autoFocus />
                                    <div className="flex gap-2">
                                      <button onClick={() => { setConvirtiendo(null); setMotivoConversion('') }}
                                        className="flex-1 text-xs font-semibold px-3 py-2 rounded-lg border border-gray-200 text-gray-600 hover:bg-gray-50 transition">
                                        Cancelar
                                      </button>
                                      <button onClick={() => convertirEnDeuda(dep, motivoConversion)}
                                        disabled={!motivoConversion.trim()}
                                        className="flex-1 text-xs font-semibold px-3 py-2 rounded-lg bg-red-600 text-white hover:bg-red-700 transition disabled:opacity-40 disabled:cursor-not-allowed">
                                        Confirmar — crear deuda
                                      </button>
                                    </div>
                                  </div>
                                )}
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
          )}
        </div>
        {/* Input oculto compartido para reemplazar boucher en Por revisar */}
        <input
          ref={boucherReplaceRef}
          type="file"
          accept="image/*"
          style={{ display: 'none' }}
          onChange={async (e) => {
            const f = e.target.files?.[0]
            if (f && editingBoucherId) {
              const dep = porRevisar.find((d) => d.id === editingBoucherId)
              if (dep) await reemplazarBoucher(dep, f)
            }
            if (boucherReplaceRef.current) boucherReplaceRef.current.value = ''
          }}
        />
        </>
        )
      })()}

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
          const ts = tsToDate(d.creadoAt)?.getTime() ?? 0
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
                    {fmtNombreMotorizado(m.nombre, motorizadoNames, m.id)}
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
                      <th className={thCls}>Fecha gestión</th>
                      <th className={thCls}>Motorizado</th>
                      <th className={thCls}>Comercio</th>
                      <th className={thCls}>Estado</th>
                      <th className={`${thCls} text-right`}>Monto</th>
                      <th className={thCls}>Órdenes</th>
                      <th className={thCls}>Comprobante</th>
                      <th className={thCls}></th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-gray-100">
                    {filtered.map((dep) => (
                      <tr key={dep.id} className="hover:bg-gray-50 transition-colors">
                        <td className={tdCls}>{fmtDateTime(dep.creadoAt)}</td>
                        <td className={`${tdCls} font-semibold text-gray-800`}>{fmtNombreMotorizado(dep.motorizadoNombre, motorizadoNames, dep.motorizadoUid)}</td>
                        <td className={tdCls}>
                          <span className="flex items-center gap-1.5">
                            {dep.destinatario === 'storkhub'
                              ? <Landmark className="h-3.5 w-3.5 text-blue-500 flex-shrink-0" />
                              : <Store className="h-3.5 w-3.5 text-purple-500 flex-shrink-0" />}
                            {dep.destinatarioNombre}
                          </span>
                        </td>
                        <td className={tdCls}>
                          {dep.estado === 'convertido_en_deuda' ? (
                            <div className="flex flex-col gap-0.5">
                              <span className="inline-flex text-[11px] font-semibold px-2 py-0.5 rounded-full bg-red-50 text-red-700 border border-red-200">Convertido en deuda</span>
                              {dep.notaConversion && (
                                <p className="text-[10px] text-gray-400 max-w-[160px] truncate" title={dep.notaConversion}>{dep.notaConversion}</p>
                              )}
                            </div>
                          ) : dep.destinatario === 'storkhub' ? (
                            <span className="inline-flex text-[11px] font-semibold px-2 py-0.5 rounded-full bg-blue-50 text-blue-700 border border-blue-200">Delivery confirmado</span>
                          ) : (
                            <span className="inline-flex text-[11px] font-semibold px-2 py-0.5 rounded-full bg-purple-50 text-purple-700 border border-purple-200">Producto confirmado</span>
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
                            <button onClick={() => setBoucherModalUrl(dep.boucher!.url)} title="Ver comprobante">
                              {/* eslint-disable-next-line @next/next/no-img-element */}
                              <img src={dep.boucher.url} alt="boucher" className="w-8 h-8 rounded object-cover border border-green-200 hover:opacity-80 transition" />
                            </button>
                          ) : <span className="text-[11px] text-gray-400">—</span>}
                        </td>
                        <td className={tdCls}>
                          <div className="flex items-center gap-2">
                            {dep.saldoId && (
                              <span
                                className="font-mono text-[10px] font-semibold text-red-600 bg-red-50 border border-red-200 px-1.5 py-0.5 rounded cursor-default select-all"
                                title={`Saldo ID: ${dep.saldoId}`}
                              >
                                Saldo {dep.saldoId.slice(0, 6)}…
                              </span>
                            )}
                            {userRol === 'admin' && dep.estado !== 'convertido_en_deuda' && (
                              <button
                                onClick={() => rehacerDeposito(dep)}
                                title="Rehacer depósito — vuelve a Por revisar"
                                className="text-orange-500 hover:text-orange-700 transition text-[11px] font-semibold px-1.5 py-0.5 rounded hover:bg-orange-50"
                              >
                                Rehacer
                              </button>
                            )}
                            {userRol === 'admin' && (
                              <button
                                onClick={() => eliminarDeposito(dep)}
                                title="Eliminar depósito (solo admin)"
                                className="text-red-400 hover:text-red-600 transition text-[11px] font-semibold px-1.5 py-0.5 rounded hover:bg-red-50"
                              >
                                Eliminar
                              </button>
                            )}
                          </div>
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
  totalBruto,
  gastosDeducibles,
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
  totalBruto?: number
  gastosDeducibles?: number
  ordenes: Solicitud[]
  expandKey: string
  expanded: boolean
  onToggle: () => void
  onConfirmar: (boucherFile: File) => Promise<void>
  tipoDeposito: 'storkhub' | 'comercio'
  onSelectOrden: (id: string) => void
  comercioNames: Record<string, string>
}) {
  const [modalOpen, setModalOpen] = useState(false)
  const [boucherFile, setBoucherFile] = useState<File | null>(null)
  const [uploading, setUploading] = useState(false)
  const [success, setSuccess] = useState(false)
  const [err, setErr] = useState<string | null>(null)

  async function handleConfirmar() {
    if (!boucherFile) return
    setUploading(true)
    setErr(null)
    try {
      await onConfirmar(boucherFile)
      setSuccess(true)
      setTimeout(() => {
        setSuccess(false)
        setModalOpen(false)
        setBoucherFile(null)
      }, 2000)
    } catch {
      setErr('Error al subir el boucher. Intentá de nuevo.')
    } finally {
      setUploading(false)
    }
  }

  const tieneGastos = tipoDeposito === 'storkhub' && (gastosDeducibles ?? 0) > 0

  return (
    <div className={`rounded-xl border-2 ${colorBorder} overflow-hidden`}>
      <div className={`px-4 py-3 ${colorBg} flex items-center gap-3`}>
        <span>{icon}</span>
        <div className="flex-1 min-w-0">
          <p className="text-sm font-bold text-gray-900 truncate">{titulo}</p>
          <p className="text-xs text-gray-500">{subtitulo} · {ordenes.length} {ordenes.length === 1 ? 'orden' : 'órdenes'}</p>
          {/* Desglose gastos cuando hay deducción */}
          {tieneGastos && (
            <p className="text-[11px] text-blue-600 mt-0.5">
              Bruto {fmt(totalBruto!)} − gastos {fmt(gastosDeducibles!)} = <strong>neto {fmt(total)}</strong>
            </p>
          )}
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
      <div className="px-4 py-3 border-t border-gray-100">
        <button
          onClick={() => setModalOpen(true)}
          className="w-full text-xs font-semibold py-2 px-3 rounded-lg border transition bg-gray-50 border-gray-200 text-gray-600 hover:bg-gray-100"
        >
          📸 Adjuntar boucher del depósito (obligatorio)
        </button>
      </div>

      {modalOpen && (
        <BoucherDepositoModal
          file={boucherFile}
          uploading={uploading}
          success={success}
          err={err}
          tipoDeposito={tipoDeposito}
          onFile={setBoucherFile}
          onSubmit={handleConfirmar}
          onCancel={() => { if (!uploading) { setModalOpen(false); setBoucherFile(null); setErr(null) } }}
        />
      )}
    </div>
  )
}

// ── Modal de boucher para gestor ──────────────────────────────────────────────

function BoucherDepositoModal({
  file, uploading, success, err, tipoDeposito, onFile, onSubmit, onCancel,
}: {
  file: File | null
  uploading: boolean
  success: boolean
  err: string | null
  tipoDeposito: 'storkhub' | 'comercio'
  onFile: (f: File) => void
  onSubmit: () => void
  onCancel: () => void
}) {
  const inputRef = useRef<HTMLInputElement>(null)
  const previewUrl = file ? URL.createObjectURL(file) : null
  const confirmColor = tipoDeposito === 'storkhub' ? '#2563eb' : '#7c3aed'

  if (success) {
    return (
      <div style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.6)', zIndex: 1000, display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 20 }}>
        <div style={{ background: '#fff', borderRadius: 24, padding: 36, maxWidth: 360, width: '100%', boxShadow: '0 20px 60px rgba(0,0,0,0.3)', display: 'flex', flexDirection: 'column' as const, alignItems: 'center', gap: 12 }}>
          <div style={{ width: 72, height: 72, borderRadius: '50%', background: '#f0fdf4', border: '3px solid #16a34a', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
            <span style={{ fontSize: 36 }}>✅</span>
          </div>
          <p style={{ fontSize: 20, fontWeight: 900, color: '#15803d', margin: 0, textAlign: 'center' as const }}>¡Boucher cargado!</p>
          <p style={{ fontSize: 14, color: '#6b7280', margin: 0, textAlign: 'center' as const, lineHeight: 1.5 }}>
            El depósito fue confirmado correctamente.
          </p>
          <div style={{ width: '100%', height: 4, background: '#f3f4f6', borderRadius: 4, overflow: 'hidden', marginTop: 8 }}>
            <div style={{ height: '100%', background: '#16a34a', borderRadius: 4, animation: 'progress2s 2s linear forwards' }} />
          </div>
        </div>
      </div>
    )
  }

  return (
    <div style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.6)', zIndex: 1000, display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 20 }}>
      <div style={{ background: '#fff', borderRadius: 24, padding: 24, maxWidth: 360, width: '100%', boxShadow: '0 20px 60px rgba(0,0,0,0.3)' }}>
        <p style={{ fontSize: 18, fontWeight: 800, color: '#111827', margin: '0 0 4px' }}>
          🏦 Boucher del depósito
        </p>
        <p style={{ fontSize: 13, color: '#6b7280', margin: '0 0 20px', lineHeight: 1.5 }}>
          Tomá o adjuntá una foto clara del boucher como comprobante del depósito realizado.
        </p>

        <input
          ref={inputRef}
          type="file"
          accept="image/*"
          capture="environment"
          style={{ display: 'none' }}
          onChange={(e) => { const f = e.target.files?.[0]; if (f) onFile(f) }}
        />

        {previewUrl ? (
          <div style={{ marginBottom: 16 }}>
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img
              src={previewUrl}
              alt="preview boucher"
              style={{ width: '100%', maxHeight: 200, objectFit: 'cover', borderRadius: 14, border: '2px solid #e5e7eb' }}
            />
            <button
              onClick={() => inputRef.current?.click()}
              style={{ marginTop: 8, width: '100%', background: '#f3f4f6', border: '1px solid #e5e7eb', borderRadius: 10, padding: '9px', fontSize: 13, color: '#374151', fontWeight: 600, cursor: 'pointer' }}>
              🔄 Cambiar foto
            </button>
          </div>
        ) : (
          <button
            onClick={() => inputRef.current?.click()}
            style={{ width: '100%', background: '#eff6ff', border: '2px dashed #93c5fd', borderRadius: 14, padding: '24px 16px', fontSize: 15, color: '#2563eb', fontWeight: 700, cursor: 'pointer', marginBottom: 16, display: 'flex', flexDirection: 'column' as const, alignItems: 'center', gap: 6 }}>
            <span style={{ fontSize: 36 }}>📷</span>
            Tomar o seleccionar foto
          </button>
        )}

        {uploading && (
          <div style={{ marginBottom: 12 }}>
            <p style={{ fontSize: 12, color: '#6b7280', textAlign: 'center' as const, marginBottom: 6 }}>Subiendo boucher…</p>
            <div style={{ width: '100%', height: 4, background: '#f3f4f6', borderRadius: 4, overflow: 'hidden' }}>
              <div style={{ height: '100%', background: confirmColor, borderRadius: 4, animation: 'uploadPulse 1s ease-in-out infinite alternate', width: '60%' }} />
            </div>
          </div>
        )}

        {err && (
          <p style={{ fontSize: 12, color: '#dc2626', background: '#fef2f2', border: '1px solid #fecaca', borderRadius: 8, padding: '8px 12px', margin: '0 0 12px' }}>
            ⚠️ {err}
          </p>
        )}

        <div style={{ display: 'flex', gap: 10 }}>
          <button
            onClick={onCancel}
            disabled={uploading}
            style={{ flex: 1, background: '#fff', border: '1px solid #e5e7eb', borderRadius: 14, padding: '13px', color: '#6b7280', fontSize: 14, fontWeight: 700, cursor: uploading ? 'not-allowed' : 'pointer' }}>
            Cerrar
          </button>
          <button
            onClick={onSubmit}
            disabled={!file || uploading}
            style={{ flex: 2, background: !file || uploading ? '#d1d5db' : confirmColor, border: 'none', borderRadius: 14, padding: '13px', color: '#fff', fontSize: 14, fontWeight: 800, cursor: !file || uploading ? 'not-allowed' : 'pointer' }}>
            {uploading ? 'Subiendo…' : file ? '✓ Confirmar depósito' : 'Seleccioná una foto'}
          </button>
        </div>
      </div>
    </div>
  )
}
