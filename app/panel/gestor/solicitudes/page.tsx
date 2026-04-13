'use client'

import { useEffect, useMemo, useRef, useState } from 'react'
import Link from 'next/link'
import { useSearchParams } from 'next/navigation'
import {
  collection,
  doc,
  getDocs,
  onSnapshot,
  orderBy,
  query,
  serverTimestamp,
  updateDoc,
} from 'firebase/firestore'
import { auth, db } from '@/fb/config'
import {
  Search,
  ExternalLink,
  Copy,
  Truck,
  CheckCircle2,
  RotateCcw,
  XCircle,
  Send,
  Eye,
  Filter,
  Phone,
  MapPin,
  Wallet,
  User,
  RefreshCcw,
  Activity,
  Sparkles,
  ChevronLeft,
  ChevronRight,
  SlidersHorizontal,
  Eraser,
  CalendarDays,
  Lock,
  Star,
  AlertTriangle,
  X,
  DollarSign,
  Clock,
  FileCheck,
} from 'lucide-react'

type EstadoSolicitud =
  | 'pendiente_confirmacion'
  | 'confirmada'
  | 'rechazada'
  | 'asignada'
  | 'en_camino_retiro'
  | 'retirado'
  | 'en_camino_entrega'
  | 'entregado'
  | 'cancelada'

type Solicitud = {
  id: string
  createdAt?: any
  updatedAt?: any
  estado: EstadoSolicitud
  tipoCliente: 'contado' | 'credito'
  tieneCotizacion: boolean

  recoleccion: {
    direccionEscrita: string
    puntoGoogleTexto?: string | null
    puntoGoogleLink?: string | null
    puntoGoogleTipo: 'referencial' | 'exacto'
    nombreApellido?: string
    celular: string
  }

  entrega: {
    direccionEscrita: string
    puntoGoogleTexto?: string | null
    puntoGoogleLink?: string | null
    puntoGoogleTipo: 'referencial' | 'exacto'
    nombreApellido?: string
    celular: string
  }

  cobroContraEntrega: { aplica: boolean; monto: number }

  pagoDelivery:
    | { tipo: 'credito_semanal'; quienPaga: 'credito_semanal'; montoSugerido?: number | null }
    | {
        tipo: 'contado'
        quienPaga: 'recoleccion' | 'entrega' | 'transferencia'
        montoSugerido?: number | null
        deducirDelCobroContraEntrega: boolean
      }

  cotizacion?: {
    distanciaKm?: number | null
    precioSugerido?: number | null
    origenCoord?: { lat: number; lng: number } | null
    destinoCoord?: { lat: number; lng: number } | null
  }

  detalle?: string
  confirmacion?: {
    precioFinalCordobas?: number
    confirmadoPorUid?: string
    confirmadoAt?: any
  }

  asignacion?: {
    motorizadoId?: string
    motorizadoAuthUid?: string
    motorizadoNombre?: string
    motorizadoTelefono?: string
    asignadoPorUid?: string
    asignadoAt?: any
    aceptarAntesDe?: any
    estadoAceptacion?: 'pendiente' | 'aceptada' | 'rechazada' | 'expirada'
    aceptadoAt?: any
    rechazadoAt?: any
    motivoRechazo?: string
  } | null

  prioridad?: boolean
  entregadoAt?: any
  cobrosMotorizado?: {
    delivery?: { monto: number; recibio: boolean; at?: any; justificacion?: string }
    producto?: { monto: number; recibio: boolean; at?: any; justificacion?: string }
  }
  registro?: {
    deposito?: {
      confirmadoMotorizado?: boolean
      confirmadoAt?: any
      confirmadoComercio?: boolean
      confirmadoStorkhub?: boolean
      confirmadoStorkhubAt?: any
      storkhubDepositoId?: string
      comercioDepositoId?: string
    }
  }
}

type Motorizado = {
  id: string
  authUid?: string
  nombre: string
  telefono?: string
  estado?: string
  activo?: boolean
}

type FiltroCotizacion = 'todas' | 'con' | 'sin'
type FiltroOrden = 'recientes' | 'antiguas' | 'prioritario'
type FiltroAsignacion = 'todas' | 'sin_asignar' | 'asignadas'
type FiltroPrecio = 'todos' | 'con_precio' | 'sin_precio'
type FiltroFecha = 'todos' | 'hoy' | 'ayer' | '7dias' | 'personalizado'
type ModalMode = 'confirmar' | 'reasignar'
type EstadoFinanciero = 'pendiente' | 'pagado' | 'en_revision' | 'problema' | 'credito'
type FiltroRapido = 'todos' | 'con_riesgo' | 'pendiente_cobro' | 'entregadas_hoy' | 'prioritarias'

const TRANSICIONES_VALIDAS: Record<EstadoSolicitud, EstadoSolicitud[]> = {
  pendiente_confirmacion: ['confirmada', 'rechazada', 'cancelada'],
  confirmada: ['asignada', 'cancelada'],
  asignada: ['en_camino_retiro', 'confirmada', 'cancelada'],
  en_camino_retiro: ['retirado', 'cancelada'],
  retirado: ['en_camino_entrega'],
  en_camino_entrega: ['entregado'],
  entregado: [],
  rechazada: [],
  cancelada: [],
}

function getEstadoFinanciero(s: Solicitud): EstadoFinanciero {
  if (s.pagoDelivery?.tipo === 'credito_semanal') return 'credito'
  if (s.cobrosMotorizado?.delivery?.recibio === true) return 'pagado'
  if (s.estado === 'entregado' && s.cobrosMotorizado?.delivery?.recibio === false) return 'problema'
  if (s.registro?.deposito && !s.registro.deposito.confirmadoStorkhub) return 'en_revision'
  return 'pendiente'
}

type Riesgo = { tipo: string; label: string }
function getRiesgos(s: Solicitud): Riesgo[] {
  const riesgos: Riesgo[] = []
  if (
    s.estado === 'entregado' &&
    s.pagoDelivery?.tipo !== 'credito_semanal' &&
    s.cobrosMotorizado?.delivery?.recibio === false
  ) {
    riesgos.push({ tipo: 'entregada_sin_cobro', label: 'Sin cobro' })
  }
  if (s.registro?.deposito && !s.registro.deposito.confirmadoStorkhub) {
    riesgos.push({ tipo: 'deposito_pendiente', label: 'Depósito pendiente' })
  }
  return riesgos
}

function isToday(ts: any): boolean {
  const d = tsToDate(ts)
  if (!d) return false
  const hoy = new Date()
  return d.getDate() === hoy.getDate() && d.getMonth() === hoy.getMonth() && d.getFullYear() === hoy.getFullYear()
}

const ESTADOS: { key: EstadoSolicitud; label: string; short: string }[] = [
  { key: 'pendiente_confirmacion', label: 'Pendiente confirmación', short: 'Pendientes' },
  { key: 'confirmada', label: 'Confirmada', short: 'Confirmadas' },
  { key: 'asignada', label: 'Asignada', short: 'Asignadas' },
  { key: 'en_camino_retiro', label: 'En camino retiro', short: 'A retiro' },
  { key: 'retirado', label: 'Retirado', short: 'Retiradas' },
  { key: 'en_camino_entrega', label: 'En camino entrega', short: 'A entrega' },
  { key: 'entregado', label: 'Entregado', short: 'Entregadas' },
  { key: 'rechazada', label: 'Rechazada', short: 'Rechazadas' },
  { key: 'cancelada', label: 'Cancelada', short: 'Canceladas' },
]

function tsToDate(ts: any): Date | null {
  if (!ts) return null
  if (typeof ts?.toDate === 'function') return ts.toDate()
  if (ts instanceof Date) return ts
  return null
}

function formatDateTime(ts: any) {
  const d = tsToDate(ts)
  if (!d) return '—'
  return d.toLocaleString()
}

function formatDateShort(date: Date | null) {
  if (!date) return '—'
  return date.toLocaleDateString()
}

function startOfDay(d: Date) {
  const x = new Date(d)
  x.setHours(0, 0, 0, 0)
  return x
}

function endOfDay(d: Date) {
  const x = new Date(d)
  x.setHours(23, 59, 59, 999)
  return x
}

function formatDateInput(date: Date) {
  const yyyy = date.getFullYear()
  const mm = String(date.getMonth() + 1).padStart(2, '0')
  const dd = String(date.getDate()).padStart(2, '0')
  return `${yyyy}-${mm}-${dd}`
}

function parseDateInput(value: string) {
  if (!value) return null
  const [y, m, d] = value.split('-').map(Number)
  if (!y || !m || !d) return null
  return new Date(y, m - 1, d)
}

function mapsUrlFromCoord(coord?: { lat: number; lng: number } | null) {
  if (!coord) return null
  return `https://www.google.com/maps?q=${coord.lat},${coord.lng}`
}

function mapsSearchUrlFromText(text?: string | null) {
  if (!text) return null
  return `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(text)}`
}

function getBestMapsUrl(s: Solicitud, tipo: 'recoleccion' | 'entrega') {
  const coord =
    tipo === 'recoleccion' ? s?.cotizacion?.origenCoord : s?.cotizacion?.destinoCoord
  const byCoord = mapsUrlFromCoord(coord)
  if (byCoord) return byCoord

  const link = tipo === 'recoleccion' ? s.recoleccion.puntoGoogleLink : s.entrega.puntoGoogleLink
  if (link && link.trim()) return link.trim()

  const texto = tipo === 'recoleccion' ? s.recoleccion.puntoGoogleTexto : s.entrega.puntoGoogleTexto
  const byText = mapsSearchUrlFromText(texto || null)
  if (byText) return byText

  const dir = tipo === 'recoleccion' ? s.recoleccion.direccionEscrita : s.entrega.direccionEscrita
  return mapsSearchUrlFromText(dir || null)
}

async function copyToClipboard(text: string) {
  try {
    await navigator.clipboard.writeText(text)
  } catch {
    const ta = document.createElement('textarea')
    ta.value = text
    document.body.appendChild(ta)
    ta.select()
    document.execCommand('copy')
    document.body.removeChild(ta)
  }
}

function money(n: any) {
  const v = Number(n)
  if (!Number.isFinite(v)) return '—'
  return `C$ ${v}`
}

function roundTo10(n: any) {
  const v = Number(n)
  if (!Number.isFinite(v)) return ''
  return Math.round(v / 10) * 10
}

function statusLabel(estado: EstadoSolicitud) {
  const found = ESTADOS.find((e) => e.key === estado)
  return found?.label || estado
}

function estadoClass(estado: EstadoSolicitud) {
  const map: Record<EstadoSolicitud, string> = {
    pendiente_confirmacion: 'bg-yellow-50 text-yellow-800 border-yellow-200',
    confirmada: 'bg-blue-50 text-blue-700 border-blue-200',
    rechazada: 'bg-red-50 text-red-700 border-red-200',
    asignada: 'bg-indigo-50 text-indigo-700 border-indigo-200',
    en_camino_retiro: 'bg-orange-50 text-orange-700 border-orange-200',
    retirado: 'bg-sky-50 text-sky-700 border-sky-200',
    en_camino_entrega: 'bg-violet-50 text-violet-700 border-violet-200',
    entregado: 'bg-green-50 text-green-700 border-green-200',
    cancelada: 'bg-gray-100 text-gray-700 border-gray-200',
  }
  return map[estado]
}

function aceptacionLabel(s?: Solicitud['asignacion']) {
  const estado = s?.estadoAceptacion
  if (!estado) return '—'
  const map: Record<string, string> = {
    pendiente: 'Pendiente',
    aceptada: 'Aceptada',
    rechazada: 'Rechazada',
    expirada: 'Expirada',
  }
  return map[estado] || estado
}

function aceptacionClass(s?: Solicitud['asignacion']) {
  const estado = s?.estadoAceptacion
  switch (estado) {
    case 'pendiente':
      return 'bg-yellow-50 text-yellow-800 border-yellow-200'
    case 'aceptada':
      return 'bg-green-50 text-green-700 border-green-200'
    case 'rechazada':
    case 'expirada':
      return 'bg-red-50 text-red-700 border-red-200'
    default:
      return 'bg-gray-100 text-gray-700 border-gray-200'
  }
}

function diffToMs(ts: any) {
  const d = tsToDate(ts)
  if (!d) return null
  return d.getTime() - Date.now()
}

function formatMMSS(ms: number) {
  const total = Math.max(0, Math.floor(ms / 1000))
  const m = Math.floor(total / 60)
  const s = total % 60
  return `${m}:${String(s).padStart(2, '0')}`
}

function semaforoForRemaining(ms: number | null) {
  if (ms === null) return { label: '—', className: 'bg-gray-100 text-gray-700 border-gray-200' }
  const min = ms / 60000
  if (min <= 0) return { label: 'Vencido', className: 'bg-red-50 text-red-700 border-red-200' }
  if (min <= 2) return { label: 'Urgente', className: 'bg-red-50 text-red-700 border-red-200' }
  if (min <= 5) return { label: 'Atención', className: 'bg-yellow-50 text-yellow-800 border-yellow-200' }
  return { label: 'A tiempo', className: 'bg-green-50 text-green-800 border-green-200' }
}

function buildCopyRetiroEntrega(s: Solicitud) {
  const retiroUrl = getBestMapsUrl(s, 'recoleccion')
  const entregaUrl = getBestMapsUrl(s, 'entrega')

  const ceAplica = !!s.cobroContraEntrega?.aplica
  const ceMonto = ceAplica ? s.cobroContraEntrega.monto : null

  const pago = s.pagoDelivery as any
  const deduce =
    s.tipoCliente === 'contado' &&
    ceAplica &&
    pago?.quienPaga === 'entrega' &&
    pago?.deducirDelCobroContraEntrega === true

  const precioFinal = s.confirmacion?.precioFinalCordobas
  const sugerido = (s as any)?.pagoDelivery?.montoSugerido ?? s?.cotizacion?.precioSugerido ?? null

  const deliveryTexto =
    typeof precioFinal === 'number'
      ? `Delivery: ${money(precioFinal)} (confirmado)`
      : typeof sugerido === 'number'
      ? `Delivery: ${money(sugerido)} (sugerido)`
      : `Delivery: —`

  return [
    `🧾 STORKHUB | Orden: ${s.id}`,
    `Hora: ${formatDateTime(s.createdAt)}`,
    s.asignacion?.motorizadoNombre ? `Motorizado: ${s.asignacion.motorizadoNombre}` : '',
    '',
    '📍 RETIRO',
    `Nombre: ${s.recoleccion.nombreApellido || '—'}`,
    `Tel: ${s.recoleccion.celular || '—'}`,
    `Dirección: ${s.recoleccion.direccionEscrita || '—'}`,
    `Link Maps: ${retiroUrl || '—'} (${s.recoleccion.puntoGoogleTipo || '—'})`,
    '',
    '📍 ENTREGA',
    `Nombre: ${s.entrega.nombreApellido || '—'}`,
    `Tel: ${s.entrega.celular || '—'}`,
    `Dirección: ${s.entrega.direccionEscrita || '—'}`,
    `Link Maps: ${entregaUrl || '—'} (${s.entrega.puntoGoogleTipo || '—'})`,
    '',
    `💰 Cobro CE: ${ceAplica ? money(ceMonto) : 'No'}`,
    `💸 ${deliveryTexto}`,
    `Paga delivery: ${
      s.tipoCliente === 'credito' ? 'Crédito semanal' : `Contado (${pago?.quienPaga || '—'})`
    }`,
    deduce ? `Nota: deducir delivery del CE (deposito = CE - delivery)` : '',
    s.detalle?.trim() ? `📝 Detalle: ${s.detalle.trim()}` : '',
  ]
    .filter(Boolean)
    .join('\n')
}

function buildCopyTelegramFull(s: Solicitud) {
  const retiroUrl = getBestMapsUrl(s, 'recoleccion')
  const entregaUrl = getBestMapsUrl(s, 'entrega')

  const ceAplica = !!s.cobroContraEntrega?.aplica
  const ceMonto = ceAplica ? s.cobroContraEntrega.monto : null

  const pago = s.pagoDelivery as any
  const deduce =
    s.tipoCliente === 'contado' &&
    ceAplica &&
    pago?.quienPaga === 'entrega' &&
    pago?.deducirDelCobroContraEntrega === true

  const precioFinal = s.confirmacion?.precioFinalCordobas
  const sugerido = (s as any)?.pagoDelivery?.montoSugerido ?? s?.cotizacion?.precioSugerido ?? null
  const distancia = typeof s?.cotizacion?.distanciaKm === 'number' ? `${s.cotizacion.distanciaKm} km` : '—'

  return [
    `📦 STORKHUB | ${s.tieneCotizacion ? 'Con cotización' : 'Sin cotización'} | ${s.tipoCliente.toUpperCase()}`,
    `🆔 ID: ${s.id}`,
    `🕒 Hora: ${formatDateTime(s.createdAt)}`,
    `📍 Estado: ${s.estado}`,
    s.tieneCotizacion ? `📏 Distancia: ${distancia}` : '',
    s.asignacion?.motorizadoNombre ? `🛵 Motorizado: ${s.asignacion.motorizadoNombre}` : '',
    '',
    `📍 RETIRO (${s.recoleccion.puntoGoogleTipo})`,
    `• Dir: ${s.recoleccion.direccionEscrita || '—'}`,
    `• Maps: ${retiroUrl || '—'}`,
    `• Contacto: ${(s.recoleccion.nombreApellido || '—')} | ${s.recoleccion.celular || '—'}`,
    '',
    `📍 ENTREGA (${s.entrega.puntoGoogleTipo})`,
    `• Dir: ${s.entrega.direccionEscrita || '—'}`,
    `• Maps: ${entregaUrl || '—'}`,
    `• Contacto: ${(s.entrega.nombreApellido || '—')} | ${s.entrega.celular || '—'}`,
    '',
    `💰 Cobro CE: ${ceAplica ? money(ceMonto) : 'No'}`,
    `💸 Delivery: ${
      typeof precioFinal === 'number'
        ? `${money(precioFinal)} (confirmado)`
        : typeof sugerido === 'number'
        ? `${money(sugerido)} (sugerido)`
        : '—'
    }`,
    `👤 Quién paga delivery: ${s.tipoCliente === 'credito' ? 'Crédito semanal' : (pago?.quienPaga || '—')}`,
    deduce ? `🧮 Deducir delivery del CE: Sí (deposito = CE - delivery)` : `🧮 Deducir delivery del CE: No`,
    s.detalle?.trim() ? `📝 Detalle: ${s.detalle.trim()}` : '',
  ]
    .filter(Boolean)
    .join('\n')
}

function incluyeTexto(value: string | undefined | null, q: string) {
  return (value || '').toLowerCase().includes(q)
}

export default function GestorSolicitudesPage() {
  const hoy = useMemo(() => new Date(), [])
  const [estadoFiltro, setEstadoFiltro] = useState<EstadoSolicitud>('pendiente_confirmacion')
  const [allItems, setAllItems] = useState<Solicitud[]>([])
  const [loading, setLoading] = useState(true)
  const [err, setErr] = useState<string | null>(null)

  const [cotizacionFiltro, setCotizacionFiltro] = useState<FiltroCotizacion>('todas')
  const [ordenUI, setOrdenUI] = useState<FiltroOrden>('recientes')
  const [asignacionFiltro, setAsignacionFiltro] = useState<FiltroAsignacion>('todas')
  const [fechaFiltro, setFechaFiltro] = useState<FiltroFecha>('todos')
  const [fechaDesde, setFechaDesde] = useState(formatDateInput(hoy))
  const [fechaHasta, setFechaHasta] = useState(formatDateInput(hoy))
  const [busqueda, setBusqueda] = useState('')

  const [ordenColFiltro, setOrdenColFiltro] = useState('')
  const [retiroColFiltro, setRetiroColFiltro] = useState('')
  const [entregaColFiltro, setEntregaColFiltro] = useState('')
  const [motorizadoColFiltro, setMotorizadoColFiltro] = useState('')
  const [precioColFiltro, setPrecioColFiltro] = useState<FiltroPrecio>('todos')

  const [page, setPage] = useState(1)
  const [pageSize, setPageSize] = useState(10)

  const [nowTick, setNowTick] = useState(Date.now())
  useEffect(() => {
    const t = setInterval(() => setNowTick(Date.now()), 1000)
    return () => clearInterval(t)
  }, [])

  const [openId, setOpenId] = useState<string | null>(null)
  const [modalMode, setModalMode] = useState<ModalMode>('confirmar')
  const [precioFinal, setPrecioFinal] = useState<number | ''>('')
  const [motorizados, setMotorizados] = useState<Motorizado[]>([])
  const [motorizadoSel, setMotorizadoSel] = useState('')

  const [cardsAnimating, setCardsAnimating] = useState<string[]>([])
  const prevResumenRef = useRef<Record<EstadoSolicitud, number> | null>(null)

  const [toast, setToast] = useState<null | { type: 'success' | 'error'; message: string }>(null)
  const searchParams = useSearchParams()
  const [filtroRapido, setFiltroRapido] = useState<FiltroRapido>(
    (searchParams.get('filtro') as FiltroRapido) ?? 'todos'
  )
  const [drawerSolicitudId, setDrawerSolicitudId] = useState<string | null>(null)
  const tableScrollRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (!toast) return
    const t = setTimeout(() => setToast(null), 2400)
    return () => clearTimeout(t)
  }, [toast])

  useEffect(() => {
    if (estadoFiltro === 'entregado') {
      const hoyStr = formatDateInput(new Date())
      setFechaFiltro('hoy')
      setFechaDesde(hoyStr)
      setFechaHasta(hoyStr)
    }
  }, [estadoFiltro])

  useEffect(() => {
    ;(async () => {
      try {
        const snap = await getDocs(query(collection(db, 'motorizado')))
        const list: Motorizado[] = snap.docs.map((d) => ({
          id: d.id,
          ...(d.data() as any),
        }))
        list.sort((a, b) => {
          const aDisp = a.estado === 'disponible' ? 1 : 0
          const bDisp = b.estado === 'disponible' ? 1 : 0
          return bDisp - aDisp
        })
        setMotorizados(list)
      } catch (e) {
        console.error(e)
      }
    })()
  }, [])

  useEffect(() => {
    setLoading(true)
    setErr(null)

    const q = query(collection(db, 'solicitudes_envio'), orderBy('createdAt', 'desc'))

    const unsub = onSnapshot(
      q,
      (snap) => {
        const data: Solicitud[] = snap.docs.map((d) => ({
          id: d.id,
          ...(d.data() as any),
        }))
        setAllItems(data)
        setLoading(false)
      },
      (e) => {
        console.error(e)
        setErr('No se pudieron cargar las solicitudes.')
        setLoading(false)
      }
    )

    return () => unsub()
  }, [])

  const resumenEstados = useMemo(() => {
    const base: Record<EstadoSolicitud, number> = {
      pendiente_confirmacion: 0,
      confirmada: 0,
      rechazada: 0,
      asignada: 0,
      en_camino_retiro: 0,
      retirado: 0,
      en_camino_entrega: 0,
      entregado: 0,
      cancelada: 0,
    }

    allItems.forEach((item) => {
      if (base[item.estado] !== undefined) base[item.estado] += 1
    })

    return base
  }, [allItems])

  useEffect(() => {
    const prev = prevResumenRef.current
    if (!prev) {
      prevResumenRef.current = resumenEstados
      return
    }

    const changed = ESTADOS.filter((e) => prev[e.key] !== resumenEstados[e.key]).map((e) => e.key)
    if (changed.length) {
      setCardsAnimating(changed)
      const t = setTimeout(() => setCardsAnimating([]), 650)
      prevResumenRef.current = resumenEstados
      return () => clearTimeout(t)
    }

    prevResumenRef.current = resumenEstados
  }, [resumenEstados])

  const titulo = useMemo(() => {
    const found = ESTADOS.find((e) => e.key === estadoFiltro)
    return found?.label || estadoFiltro
  }, [estadoFiltro])

  function getRelevantDateForFilter(s: Solicitud) {
    if (estadoFiltro === 'entregado') {
      return tsToDate(s.updatedAt) || tsToDate(s.confirmacion?.confirmadoAt) || tsToDate(s.createdAt)
    }
    return tsToDate(s.createdAt) || tsToDate(s.updatedAt)
  }

  const rangoFechaActivo = useMemo(() => {
    if (fechaFiltro === 'todos') return null

    const ahora = new Date()

    if (fechaFiltro === 'hoy') {
      return { desde: startOfDay(ahora), hasta: endOfDay(ahora) }
    }

    if (fechaFiltro === 'ayer') {
      const ayer = new Date()
      ayer.setDate(ayer.getDate() - 1)
      return { desde: startOfDay(ayer), hasta: endOfDay(ayer) }
    }

    if (fechaFiltro === '7dias') {
      const desde = new Date()
      desde.setDate(desde.getDate() - 6)
      return { desde: startOfDay(desde), hasta: endOfDay(ahora) }
    }

    if (fechaFiltro === 'personalizado') {
      const dDesde = parseDateInput(fechaDesde)
      const dHasta = parseDateInput(fechaHasta)
      if (!dDesde || !dHasta) return null
      return { desde: startOfDay(dDesde), hasta: endOfDay(dHasta) }
    }

    return null
  }, [fechaFiltro, fechaDesde, fechaHasta])

  const itemsFiltrados = useMemo(() => {
    let arr = allItems.filter((x) => x.estado === estadoFiltro)

    if (cotizacionFiltro === 'con') arr = arr.filter((x) => x.tieneCotizacion)
    if (cotizacionFiltro === 'sin') arr = arr.filter((x) => !x.tieneCotizacion)

    if (asignacionFiltro === 'sin_asignar') {
      arr = arr.filter((x) => !x.asignacion?.motorizadoNombre)
    }
    if (asignacionFiltro === 'asignadas') {
      arr = arr.filter((x) => !!x.asignacion?.motorizadoNombre)
    }

    if (rangoFechaActivo) {
      arr = arr.filter((s) => {
        const d = getRelevantDateForFilter(s)
        if (!d) return false
        return d >= rangoFechaActivo.desde && d <= rangoFechaActivo.hasta
      })
    }

    const q = busqueda.trim().toLowerCase()
    if (q) {
      arr = arr.filter((s) => {
        const values = [
          s.id,
          s.recoleccion?.nombreApellido,
          s.recoleccion?.celular,
          s.recoleccion?.direccionEscrita,
          s.entrega?.nombreApellido,
          s.entrega?.celular,
          s.entrega?.direccionEscrita,
          s.asignacion?.motorizadoNombre,
          s.asignacion?.motorizadoTelefono,
          s.detalle,
        ]
          .filter(Boolean)
          .join(' ')
          .toLowerCase()

        return values.includes(q)
      })
    }

    const qOrden = ordenColFiltro.trim().toLowerCase()
    if (qOrden) {
      arr = arr.filter((s) => incluyeTexto(s.id, qOrden))
    }

    const qRetiro = retiroColFiltro.trim().toLowerCase()
    if (qRetiro) {
      arr = arr.filter((s) => {
        const full = [
          s.recoleccion?.nombreApellido,
          s.recoleccion?.celular,
          s.recoleccion?.direccionEscrita,
        ]
          .filter(Boolean)
          .join(' ')
          .toLowerCase()
        return full.includes(qRetiro)
      })
    }

    const qEntrega = entregaColFiltro.trim().toLowerCase()
    if (qEntrega) {
      arr = arr.filter((s) => {
        const full = [
          s.entrega?.nombreApellido,
          s.entrega?.celular,
          s.entrega?.direccionEscrita,
        ]
          .filter(Boolean)
          .join(' ')
          .toLowerCase()
        return full.includes(qEntrega)
      })
    }

    const qMotorizado = motorizadoColFiltro.trim().toLowerCase()
    if (qMotorizado) {
      arr = arr.filter((s) => {
        const full = [s.asignacion?.motorizadoNombre, s.asignacion?.motorizadoTelefono]
          .filter(Boolean)
          .join(' ')
          .toLowerCase()
        return full.includes(qMotorizado)
      })
    }

    if (precioColFiltro === 'con_precio') {
      arr = arr.filter((s) => {
        return (
          typeof s.confirmacion?.precioFinalCordobas === 'number' ||
          typeof (s as any)?.pagoDelivery?.montoSugerido === 'number' ||
          typeof s?.cotizacion?.precioSugerido === 'number'
        )
      })
    }

    if (precioColFiltro === 'sin_precio') {
      arr = arr.filter((s) => {
        return !(
          typeof s.confirmacion?.precioFinalCordobas === 'number' ||
          typeof (s as any)?.pagoDelivery?.montoSugerido === 'number' ||
          typeof s?.cotizacion?.precioSugerido === 'number'
        )
      })
    }

    // Filtro rápido
    if (filtroRapido === 'con_riesgo') arr = arr.filter((s) => getRiesgos(s).length > 0)
    if (filtroRapido === 'pendiente_cobro') arr = arr.filter((s) => ['pendiente', 'problema'].includes(getEstadoFinanciero(s)) && s.estado === 'entregado')
    if (filtroRapido === 'entregadas_hoy') arr = arr.filter((s) => s.estado === 'entregado' && isToday(s.entregadoAt || s.updatedAt))
    if (filtroRapido === 'prioritarias') arr = arr.filter((s) => s.prioridad === true)

    if (ordenUI === 'antiguas') arr = [...arr].reverse()

    if (ordenUI === 'prioritario') {
      arr = [...arr].sort((a, b) => {
        const aRiesgo = getRiesgos(a).length > 0 ? 0 : 1
        const bRiesgo = getRiesgos(b).length > 0 ? 0 : 1
        if (aRiesgo !== bRiesgo) return aRiesgo - bRiesgo
        const aPrio = a.prioridad ? 0 : 1
        const bPrio = b.prioridad ? 0 : 1
        if (aPrio !== bPrio) return aPrio - bPrio
        const aT = tsToDate(a.updatedAt)?.getTime() ?? 0
        const bT = tsToDate(b.updatedAt)?.getTime() ?? 0
        return aT - bT
      })
    }

    return arr
  }, [
    allItems,
    estadoFiltro,
    cotizacionFiltro,
    asignacionFiltro,
    ordenUI,
    busqueda,
    ordenColFiltro,
    retiroColFiltro,
    entregaColFiltro,
    motorizadoColFiltro,
    precioColFiltro,
    rangoFechaActivo,
    filtroRapido,
  ])

  useEffect(() => {
    setPage(1)
  }, [
    estadoFiltro,
    cotizacionFiltro,
    asignacionFiltro,
    ordenUI,
    busqueda,
    ordenColFiltro,
    retiroColFiltro,
    entregaColFiltro,
    motorizadoColFiltro,
    precioColFiltro,
    fechaFiltro,
    fechaDesde,
    fechaHasta,
    pageSize,
  ])

  const totalPages = Math.max(1, Math.ceil(itemsFiltrados.length / pageSize))
  const safePage = Math.min(page, totalPages)
  const startIndex = (safePage - 1) * pageSize
  const endIndex = Math.min(startIndex + pageSize, itemsFiltrados.length)
  const itemsPaginados = itemsFiltrados.slice(startIndex, endIndex)

  const totalActivos = useMemo(() => {
    const vals = [
      cotizacionFiltro !== 'todas',
      asignacionFiltro !== 'todas',
      ordenUI !== 'recientes',
      fechaFiltro !== 'todos',
      !!busqueda.trim(),
      !!ordenColFiltro.trim(),
      !!retiroColFiltro.trim(),
      !!entregaColFiltro.trim(),
      !!motorizadoColFiltro.trim(),
      precioColFiltro !== 'todos',
    ]
    return vals.filter(Boolean).length
  }, [
    cotizacionFiltro,
    asignacionFiltro,
    ordenUI,
    fechaFiltro,
    busqueda,
    ordenColFiltro,
    retiroColFiltro,
    entregaColFiltro,
    motorizadoColFiltro,
    precioColFiltro,
  ])

  const hoyEntregadas = useMemo(() => {
    const hoyLocal = new Date()
    return allItems.filter((s) => {
      if (s.estado !== 'entregado') return false
      const d = tsToDate(s.updatedAt) || tsToDate(s.confirmacion?.confirmadoAt) || tsToDate(s.createdAt)
      if (!d) return false
      return (
        d.getDate() === hoyLocal.getDate() &&
        d.getMonth() === hoyLocal.getMonth() &&
        d.getFullYear() === hoyLocal.getFullYear()
      )
    }).length
  }, [allItems])

  const sinAsignarConfirmadas = useMemo(() => {
    return allItems.filter((s) => s.estado === 'confirmada' && !s.asignacion?.motorizadoNombre).length
  }, [allItems])

  const pendientesTotales = resumenEstados.pendiente_confirmacion

  const metricas = useMemo(() => {
    const TERMINALES = ['entregado', 'cancelada', 'rechazada']
    const activas = allItems.filter((s) => !TERMINALES.includes(s.estado)).length
    const entregadasHoy = allItems.filter((s) => s.estado === 'entregado' && isToday(s.entregadoAt || s.updatedAt)).length
    const conProblema = allItems.filter((s) => getRiesgos(s).length > 0).length
    const pendCobro = allItems.filter((s) => ['pendiente', 'problema'].includes(getEstadoFinanciero(s)) && s.estado === 'entregado').length
    const prioritarias = allItems.filter((s) => s.prioridad === true).length
    return { activas, entregadasHoy, conProblema, pendCobro, prioritarias }
  }, [allItems])

  function getRemainingConfirmacion(s: Solicitud) {
    const created = tsToDate(s.createdAt)
    if (!created) return null
    const deadline = created.getTime() + 10 * 60 * 1000
    return deadline - nowTick
  }

  function getRemainingAceptacion(s: Solicitud) {
    const aceptarAntesDe = s.asignacion?.aceptarAntesDe
    const ms = diffToMs(aceptarAntesDe)
    if (ms !== null) return ms

    const asig = tsToDate(s.asignacion?.asignadoAt)
    if (!asig) return null
    const deadline = asig.getTime() + 10 * 60 * 1000
    return deadline - nowTick
  }

  const handleCopy = async (text: string, message = 'Copiado') => {
    await copyToClipboard(text)
    setToast({ type: 'success', message })
  }

  const rebotarAsignacion = async (id: string) => {
    setErr(null)
    try {
      await updateDoc(doc(db, 'solicitudes_envio', id), {
        estado: 'confirmada',
        asignacion: null,
        updatedAt: serverTimestamp(),
      } as any)
      setToast({ type: 'success', message: 'Asignación rebotada' })
    } catch (e) {
      console.error(e)
      setErr('No se pudo rebotar la asignación.')
      setToast({ type: 'error', message: 'No se pudo rebotar la asignación' })
    }
  }

  const abrirConfirmarYAsignar = (s: Solicitud) => {
    setModalMode('confirmar')
    setOpenId(s.id)
    const sugerido = s?.cotizacion?.precioSugerido ?? (s as any)?.pagoDelivery?.montoSugerido ?? null
    const redondeado = typeof sugerido === 'number' ? roundTo10(sugerido) : ''
    setPrecioFinal(redondeado === '' ? '' : Number(redondeado))
    setMotorizadoSel(s.asignacion?.motorizadoId || '')
  }

  const abrirReasignar = (s: Solicitud) => {
    setModalMode('reasignar')
    setOpenId(s.id)
    setPrecioFinal(s.confirmacion?.precioFinalCordobas ?? '')
    setMotorizadoSel(s.asignacion?.motorizadoId || '')
  }

  const cerrarModal = () => {
    setOpenId(null)
    setPrecioFinal('')
    setMotorizadoSel('')
    setModalMode('confirmar')
  }

  const confirmarYAsignar = async (id: string) => {
    setErr(null)
    const user = auth.currentUser
    if (!user) return setErr('No hay sesión iniciada.')
    if (precioFinal === '' || Number(precioFinal) <= 0) return setErr('Ingresá un precio final válido.')

    const m = motorizadoSel ? motorizados.find((x) => x.id === motorizadoSel) : null

    try {
      const now = new Date()
      const aceptarAntesDe = new Date(now.getTime() + 10 * 60 * 1000)

      await updateDoc(doc(db, 'solicitudes_envio', id), {
        estado: m ? 'asignada' : 'confirmada',
        confirmacion: {
          precioFinalCordobas: Number(precioFinal),
          confirmadoPorUid: user.uid,
          confirmadoAt: serverTimestamp(),
        },
        ...(m
          ? {
              asignacion: {
                motorizadoId: m.id,
                motorizadoAuthUid: (m.authUid || '').trim(),
                motorizadoNombre: m.nombre,
                motorizadoTelefono: m.telefono || '',
                asignadoPorUid: user.uid,
                asignadoAt: serverTimestamp(),
                estadoAceptacion: 'pendiente',
                aceptadoAt: null,
                rechazadoAt: null,
                motivoRechazo: '',
                aceptarAntesDe,
              },
            }
          : { asignacion: null }),
        updatedAt: serverTimestamp(),
      } as any)

      cerrarModal()
      setToast({ type: 'success', message: m ? 'Orden confirmada y asignada' : 'Orden confirmada' })
    } catch (e) {
      console.error(e)
      setErr('No se pudo confirmar/asignar.')
      setToast({ type: 'error', message: 'No se pudo guardar la orden' })
    }
  }

  const reasignarSolo = async (id: string) => {
    setErr(null)
    const user = auth.currentUser
    if (!user) return setErr('No hay sesión iniciada.')
    if (!motorizadoSel) return setErr('Elegí un motorizado.')

    const m = motorizados.find((x) => x.id === motorizadoSel)
    if (!m) return setErr('Motorizado inválido.')

    try {
      const now = new Date()
      const aceptarAntesDe = new Date(now.getTime() + 10 * 60 * 1000)

      await updateDoc(doc(db, 'solicitudes_envio', id), {
        estado: 'asignada',
        asignacion: {
          motorizadoId: m.id,
          motorizadoAuthUid: (m.authUid || '').trim(),
          motorizadoNombre: m.nombre,
          motorizadoTelefono: m.telefono || '',
          asignadoPorUid: user.uid,
          asignadoAt: serverTimestamp(),
          estadoAceptacion: 'pendiente',
          aceptadoAt: null,
          rechazadoAt: null,
          motivoRechazo: '',
          aceptarAntesDe,
        },
        updatedAt: serverTimestamp(),
      } as any)

      cerrarModal()
      setToast({ type: 'success', message: 'Motorizado reasignado' })
    } catch (e) {
      console.error(e)
      setErr('No se pudo reasignar.')
      setToast({ type: 'error', message: 'No se pudo reasignar' })
    }
  }

  const cambiarEstado = async (id: string, nuevo: EstadoSolicitud) => {
    setErr(null)
    const solicitud = allItems.find((x) => x.id === id)
    if (solicitud) {
      const validos = TRANSICIONES_VALIDAS[solicitud.estado] ?? []
      if (!validos.includes(nuevo)) {
        const labelActual = ESTADOS.find((e) => e.key === solicitud.estado)?.label || solicitud.estado
        const labelNuevo = ESTADOS.find((e) => e.key === nuevo)?.label || nuevo
        setToast({ type: 'error', message: `No se puede pasar de "${labelActual}" a "${labelNuevo}"` })
        return
      }
    }
    try {
      await updateDoc(doc(db, 'solicitudes_envio', id), {
        estado: nuevo,
        updatedAt: serverTimestamp(),
      })
      setToast({ type: 'success', message: 'Estado actualizado' })
    } catch (e) {
      console.error(e)
      setErr('No se pudo cambiar el estado.')
      setToast({ type: 'error', message: 'No se pudo cambiar el estado' })
    }
  }

  const togglePrioridad = async (id: string, actual?: boolean) => {
    try {
      await updateDoc(doc(db, 'solicitudes_envio', id), {
        prioridad: !actual,
        updatedAt: serverTimestamp(),
      } as any)
      setToast({ type: 'success', message: !actual ? '⭐ Marcada como prioritaria' : 'Prioridad removida' })
    } catch (e) {
      console.error(e)
      setToast({ type: 'error', message: 'No se pudo cambiar la prioridad' })
    }
  }

  function limpiarFiltrosTabla() {
    const hoyStr = formatDateInput(new Date())
    setBusqueda('')
    setCotizacionFiltro('todas')
    setAsignacionFiltro('todas')
    setOrdenUI('recientes')
    setOrdenColFiltro('')
    setRetiroColFiltro('')
    setEntregaColFiltro('')
    setMotorizadoColFiltro('')
    setPrecioColFiltro('todos')
    setFechaFiltro(estadoFiltro === 'entregado' ? 'hoy' : 'todos')
    setFechaDesde(hoyStr)
    setFechaHasta(hoyStr)
    setFiltroRapido('todos')
  }

  const resumenFecha = useMemo(() => {
    if (fechaFiltro === 'todos') return 'Sin filtro de fecha'
    if (fechaFiltro === 'hoy') return 'Hoy'
    if (fechaFiltro === 'ayer') return 'Ayer'
    if (fechaFiltro === '7dias') return 'Últimos 7 días'
    if (fechaFiltro === 'personalizado') {
      return `${formatDateShort(parseDateInput(fechaDesde))} → ${formatDateShort(parseDateInput(fechaHasta))}`
    }
    return 'Sin filtro de fecha'
  }, [fechaFiltro, fechaDesde, fechaHasta])

  return (
    <div className="h-full flex flex-col gap-3 min-w-0">
      <style jsx>{`
        @keyframes cardPop {
          0% {
            transform: scale(1);
          }
          35% {
            transform: scale(1.04);
          }
          100% {
            transform: scale(1);
          }
        }
        .animate-card-pop {
          animation: cardPop 0.65s ease;
        }
      `}</style>

      {toast && (
        <div className="fixed right-4 top-4 z-[70]">
          <div
            className={`rounded-2xl border px-4 py-3 shadow-lg backdrop-blur-sm ${
              toast.type === 'success'
                ? 'border-emerald-200 bg-emerald-50 text-emerald-800'
                : 'border-red-200 bg-red-50 text-red-800'
            }`}
          >
            <div className="flex items-center gap-2 text-sm font-medium">
              {toast.type === 'success' ? (
                <CheckCircle2 className="h-4 w-4" />
              ) : (
                <XCircle className="h-4 w-4" />
              )}
              {toast.message}
            </div>
          </div>
        </div>
      )}

      <section className="shrink-0 rounded-3xl border border-gray-200 bg-white shadow-sm overflow-hidden">
        <div className="border-b border-gray-100 bg-gradient-to-r from-slate-50 via-white to-blue-50/70 px-4 md:px-5 py-5">
          <div className="flex flex-col gap-4">
            <div className="flex flex-col 2xl:flex-row 2xl:items-center 2xl:justify-between gap-4">
              <div className="min-w-0">
                <div className="flex flex-wrap items-center gap-2">
                  <span className="inline-flex items-center gap-1 rounded-full border border-blue-200 bg-blue-50 px-2.5 py-1 text-[11px] font-semibold text-blue-700">
                    <Activity className="h-3.5 w-3.5" />
                    En vivo
                  </span>
                  <span className="inline-flex items-center gap-1 rounded-full border border-emerald-200 bg-emerald-50 px-2.5 py-1 text-[11px] font-semibold text-emerald-700">
                    <Sparkles className="h-3.5 w-3.5" />
                    Operación sincronizada
                  </span>
                </div>

                <h1 className="mt-3 text-3xl font-bold tracking-tight text-gray-900">
                  Centro de solicitudes
                </h1>
                <p className="mt-1 text-sm text-gray-600">
                  Confirma, asigna y monitorea pedidos en tiempo real desde un solo panel.
                </p>
              </div>

              <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-5 gap-2.5 w-full 2xl:w-auto">
                <div className="relative min-w-[220px]">
                  <Search className="h-4 w-4 text-gray-400 absolute left-3 top-1/2 -translate-y-1/2" />
                  <input
                    value={busqueda}
                    onChange={(e) => setBusqueda(e.target.value)}
                    placeholder="Buscar orden, nombre o teléfono"
                    className="w-full rounded-xl border border-gray-200 bg-white py-2.5 pl-9 pr-3 text-sm outline-none transition focus:border-blue-300 focus:ring-4 focus:ring-blue-50"
                  />
                </div>

                <select
                  value={estadoFiltro}
                  onChange={(e) => setEstadoFiltro(e.target.value as EstadoSolicitud)}
                  className="rounded-xl border border-gray-200 bg-white px-3 py-2.5 text-sm outline-none transition focus:border-blue-300 focus:ring-4 focus:ring-blue-50"
                >
                  {ESTADOS.map((estado) => (
                    <option key={estado.key} value={estado.key}>
                      {estado.label}
                    </option>
                  ))}
                </select>

                <select
                  value={cotizacionFiltro}
                  onChange={(e) => setCotizacionFiltro(e.target.value as FiltroCotizacion)}
                  className="rounded-xl border border-gray-200 bg-white px-3 py-2.5 text-sm outline-none transition focus:border-blue-300 focus:ring-4 focus:ring-blue-50"
                >
                  <option value="todas">Todas las cotizaciones</option>
                  <option value="con">Con cotización</option>
                  <option value="sin">Sin cotización</option>
                </select>

                <select
                  value={asignacionFiltro}
                  onChange={(e) => setAsignacionFiltro(e.target.value as FiltroAsignacion)}
                  className="rounded-xl border border-gray-200 bg-white px-3 py-2.5 text-sm outline-none transition focus:border-blue-300 focus:ring-4 focus:ring-blue-50"
                >
                  <option value="todas">Todas las asignaciones</option>
                  <option value="sin_asignar">Sin asignar</option>
                  <option value="asignadas">Con motorizado</option>
                </select>

                <select
                  value={ordenUI}
                  onChange={(e) => setOrdenUI(e.target.value as FiltroOrden)}
                  className="rounded-xl border border-gray-200 bg-white px-3 py-2.5 text-sm outline-none transition focus:border-blue-300 focus:ring-4 focus:ring-blue-50"
                >
                  <option value="recientes">Recientes primero</option>
                  <option value="antiguas">Antiguas primero</option>
                  <option value="prioritario">Prioridad operativa</option>
                </select>
              </div>
            </div>

            <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-5 gap-2.5">
              <select
                value={fechaFiltro}
                onChange={(e) => setFechaFiltro(e.target.value as FiltroFecha)}
                className="rounded-xl border border-gray-200 bg-white px-3 py-2.5 text-sm outline-none transition focus:border-blue-300 focus:ring-4 focus:ring-blue-50"
              >
                <option value="todos">Todas las fechas</option>
                <option value="hoy">Hoy</option>
                <option value="ayer">Ayer</option>
                <option value="7dias">Últimos 7 días</option>
                <option value="personalizado">Rango personalizado</option>
              </select>

              {fechaFiltro === 'personalizado' && (
                <>
                  <input
                    type="date"
                    value={fechaDesde}
                    onChange={(e) => setFechaDesde(e.target.value)}
                    className="rounded-xl border border-gray-200 bg-white px-3 py-2.5 text-sm outline-none transition focus:border-blue-300 focus:ring-4 focus:ring-blue-50"
                  />
                  <input
                    type="date"
                    value={fechaHasta}
                    onChange={(e) => setFechaHasta(e.target.value)}
                    className="rounded-xl border border-gray-200 bg-white px-3 py-2.5 text-sm outline-none transition focus:border-blue-300 focus:ring-4 focus:ring-blue-50"
                  />
                </>
              )}

              <div className="xl:col-span-2 flex flex-wrap items-center gap-2">
                <span className="inline-flex items-center gap-1 rounded-full border border-gray-200 bg-white px-3 py-2 text-xs text-gray-700">
                  <CalendarDays className="h-3.5 w-3.5" />
                  Fecha: {resumenFecha}
                </span>

                {estadoFiltro === 'entregado' && (
                  <span className="inline-flex items-center gap-1 rounded-full border border-amber-200 bg-amber-50 px-3 py-2 text-xs text-amber-800">
                    Entregadas muestra hoy por defecto; lo anterior queda para historial
                  </span>
                )}
              </div>
            </div>
          </div>
        </div>

        <div className="px-4 md:px-5 py-4 border-b border-gray-100">
          <div className="grid grid-cols-2 md:grid-cols-3 xl:grid-cols-5 2xl:grid-cols-9 gap-2.5">
            {ESTADOS.map((estado) => {
              const count = resumenEstados[estado.key]
              const activo = estadoFiltro === estado.key
              const animating = cardsAnimating.includes(estado.key)

              return (
                <button
                  key={estado.key}
                  onClick={() => setEstadoFiltro(estado.key)}
                  className={`rounded-xl border px-3 py-2.5 text-left transition-all duration-200 ${
                    activo
                      ? 'border-blue-300 bg-blue-50 shadow-sm ring-1 ring-blue-100'
                      : 'border-gray-200 bg-white hover:border-gray-300'
                  } ${animating ? 'animate-card-pop' : ''}`}
                >
                  <div className="flex items-center justify-between gap-2">
                    <span className="text-[11px] font-semibold uppercase tracking-wide text-gray-500">
                      {estado.short}
                    </span>
                    <span
                      className={`text-lg font-bold tabular-nums ${
                        activo ? 'text-blue-700' : 'text-gray-900'
                      }`}
                    >
                      {count}
                    </span>
                  </div>
                </button>
              )
            })}
          </div>

          <div className="mt-3 grid grid-cols-1 sm:grid-cols-2 xl:grid-cols-3 gap-3">
            <div className="rounded-xl border border-gray-200 bg-gray-50/70 px-4 py-3">
              <div className="text-[11px] font-semibold uppercase tracking-wide text-gray-500">
                Pendientes por confirmar
              </div>
              <div className="mt-1 text-xl font-bold text-gray-900 tabular-nums">{pendientesTotales}</div>
            </div>

            <div className="rounded-xl border border-gray-200 bg-gray-50/70 px-4 py-3">
              <div className="text-[11px] font-semibold uppercase tracking-wide text-gray-500">
                Confirmadas sin motorizado
              </div>
              <div className="mt-1 text-xl font-bold text-gray-900 tabular-nums">
                {sinAsignarConfirmadas}
              </div>
            </div>

            <div className="rounded-xl border border-gray-200 bg-gray-50/70 px-4 py-3">
              <div className="text-[11px] font-semibold uppercase tracking-wide text-gray-500">
                Entregadas hoy
              </div>
              <div className="mt-1 text-xl font-bold text-gray-900 tabular-nums">{hoyEntregadas}</div>
            </div>
          </div>

          <div className="mt-4 flex flex-wrap items-center gap-3 text-sm">
            <span className="font-semibold text-gray-900">{titulo}</span>
            <span className="text-gray-500">({itemsFiltrados.length})</span>

            <span className="inline-flex items-center gap-1 rounded-full border border-gray-200 bg-gray-50 px-2.5 py-1 text-xs text-gray-600">
              <Filter className="h-3.5 w-3.5" />
              {totalActivos > 0 ? `${totalActivos} filtro(s) activos` : 'Sin filtros extra'}
            </span>

            <span className="inline-flex items-center gap-1 rounded-full border border-emerald-200 bg-emerald-50 px-2.5 py-1 text-xs text-emerald-700">
              <Activity className="h-3.5 w-3.5" />
              Actualización automática
            </span>

            {totalActivos > 0 && (
              <button
                onClick={limpiarFiltrosTabla}
                className="inline-flex items-center gap-1 rounded-full border border-gray-200 bg-white px-2.5 py-1 text-xs font-medium text-gray-700 hover:bg-gray-50"
              >
                <Eraser className="h-3.5 w-3.5" />
                Limpiar filtros
              </button>
            )}
          </div>
        </div>
      </section>

      {err && (
        <div className="shrink-0 rounded-xl border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700">
          {err}
        </div>
      )}

      {loading ? (
        <div className="flex-1 min-h-0 rounded-2xl border border-gray-200 bg-white p-6 text-sm text-gray-600 shadow-sm">
          Cargando...
        </div>
      ) : itemsFiltrados.length === 0 ? (
        <div className="flex-1 min-h-0 rounded-2xl border border-gray-200 bg-white p-6 text-sm text-gray-600 shadow-sm">
          No hay solicitudes en este estado con los filtros actuales.
        </div>
      ) : (
        <div className="flex-1 min-h-0 flex flex-col gap-3 min-w-0">
          <div className="hidden xl:flex flex-col flex-1 min-h-0 rounded-2xl border border-gray-200 bg-white shadow-sm overflow-hidden">
            <div className="shrink-0 border-b border-gray-200 bg-gray-50/80 px-4 py-3">
              <div className="flex flex-col lg:flex-row lg:items-center lg:justify-between gap-3">
                <div className="flex flex-wrap items-center gap-2 text-sm text-gray-600">
                  <span className="inline-flex items-center gap-1 font-medium text-gray-900">
                    <SlidersHorizontal className="h-4 w-4 text-gray-500" />
                    Tabla operativa
                  </span>
                  <span className="text-gray-400">•</span>
                  <span>
                    Mostrando <strong>{itemsFiltrados.length === 0 ? 0 : startIndex + 1}</strong>–
                    <strong>{endIndex}</strong> de <strong>{itemsFiltrados.length}</strong>
                  </span>
                </div>

                <div className="flex flex-wrap items-center gap-2">
                  <select
                    value={pageSize}
                    onChange={(e) => setPageSize(Number(e.target.value))}
                    className="rounded-lg border border-gray-200 bg-white px-3 py-2 text-sm outline-none focus:border-blue-300"
                  >
                    <option value={10}>10 por página</option>
                    <option value={20}>20 por página</option>
                    <option value={50}>50 por página</option>
                  </select>

                  <button
                    onClick={() => setPage((p) => Math.max(1, p - 1))}
                    disabled={safePage === 1}
                    className="inline-flex items-center gap-1 rounded-lg border border-gray-200 bg-white px-3 py-2 text-sm font-medium text-gray-700 disabled:cursor-not-allowed disabled:opacity-40"
                  >
                    <ChevronLeft className="h-4 w-4" />
                    Anterior
                  </button>

                  <div className="rounded-lg border border-gray-200 bg-white px-3 py-2 text-sm text-gray-700">
                    Página <strong>{safePage}</strong> de <strong>{totalPages}</strong>
                  </div>

                  <button
                    onClick={() => setPage((p) => Math.min(totalPages, p + 1))}
                    disabled={safePage === totalPages}
                    className="inline-flex items-center gap-1 rounded-lg border border-gray-200 bg-white px-3 py-2 text-sm font-medium text-gray-700 disabled:cursor-not-allowed disabled:opacity-40"
                  >
                    Siguiente
                    <ChevronRight className="h-4 w-4" />
                  </button>
                </div>
              </div>
            </div>

            <div ref={tableScrollRef} className="flex-1 min-h-0 overflow-auto" style={{ scrollbarGutter: 'stable' as any }}>
              <table className="min-w-[1520px] w-full text-sm">
                <thead className="sticky top-0 z-20 bg-gray-50 border-b border-gray-200 shadow-sm">
                  <tr className="text-left text-gray-600">
                    <th className="px-3 py-2.5 font-medium min-w-[190px] border-r border-gray-200">Orden</th>
                    <th className="px-3 py-2.5 font-medium min-w-[210px] border-r border-gray-200">Estado</th>
                    <th className="px-3 py-2.5 font-medium min-w-[260px] border-r border-gray-200">Retiro</th>
                    <th className="px-3 py-2.5 font-medium min-w-[260px] border-r border-gray-200">Entrega</th>
                    <th className="px-3 py-2.5 font-medium min-w-[140px] border-r border-gray-200">Precio</th>
                    <th className="px-3 py-2.5 font-medium min-w-[170px] border-r border-gray-200">Motorizado</th>
                    <th className="px-3 py-2.5 font-medium min-w-[130px] border-r border-gray-200">Aceptación</th>
                    <th className="px-3 py-2.5 font-medium min-w-[160px] sticky right-0 bg-gray-50 z-20 border-l border-gray-200">
                      Acciones
                    </th>
                  </tr>

                  <tr className="border-t border-gray-200">
                    <th className="px-3 py-2 border-r border-gray-200 bg-gray-50">
                      <input
                        value={ordenColFiltro}
                        onChange={(e) => setOrdenColFiltro(e.target.value)}
                        placeholder="Filtrar por ID"
                        className="w-full rounded-lg border border-gray-200 bg-white px-2.5 py-2 text-xs outline-none focus:border-blue-300"
                      />
                    </th>

                    <th className="px-3 py-2 border-r border-gray-200 bg-gray-50">
                      <div className="text-xs text-gray-500">Editable hasta entregar</div>
                    </th>

                    <th className="px-3 py-2 border-r border-gray-200 bg-gray-50">
                      <input
                        value={retiroColFiltro}
                        onChange={(e) => setRetiroColFiltro(e.target.value)}
                        placeholder="Nombre, teléfono o dirección"
                        className="w-full rounded-lg border border-gray-200 bg-white px-2.5 py-2 text-xs outline-none focus:border-blue-300"
                      />
                    </th>

                    <th className="px-3 py-2 border-r border-gray-200 bg-gray-50">
                      <input
                        value={entregaColFiltro}
                        onChange={(e) => setEntregaColFiltro(e.target.value)}
                        placeholder="Nombre, teléfono o dirección"
                        className="w-full rounded-lg border border-gray-200 bg-white px-2.5 py-2 text-xs outline-none focus:border-blue-300"
                      />
                    </th>

                    <th className="px-3 py-2 border-r border-gray-200 bg-gray-50">
                      <select
                        value={precioColFiltro}
                        onChange={(e) => setPrecioColFiltro(e.target.value as FiltroPrecio)}
                        className="w-full rounded-lg border border-gray-200 bg-white px-2.5 py-2 text-xs outline-none focus:border-blue-300"
                      >
                        <option value="todos">Todos</option>
                        <option value="con_precio">Con precio</option>
                        <option value="sin_precio">Sin precio</option>
                      </select>
                    </th>

                    <th className="px-3 py-2 border-r border-gray-200 bg-gray-50">
                      <input
                        value={motorizadoColFiltro}
                        onChange={(e) => setMotorizadoColFiltro(e.target.value)}
                        placeholder="Nombre o teléfono"
                        className="w-full rounded-lg border border-gray-200 bg-white px-2.5 py-2 text-xs outline-none focus:border-blue-300"
                      />
                    </th>

                    <th className="px-3 py-2 border-r border-gray-200 bg-gray-50">
                      <div className="text-xs text-gray-500">Informativo</div>
                    </th>

                    <th className="px-3 py-2 sticky right-0 bg-gray-50 z-20 border-l border-gray-200">
                      <button
                        onClick={limpiarFiltrosTabla}
                        className="inline-flex items-center gap-1 rounded-lg border border-gray-200 bg-white px-2.5 py-2 text-xs font-medium text-gray-700 hover:bg-gray-50"
                      >
                        <Eraser className="h-3.5 w-3.5" />
                        Limpiar
                      </button>
                    </th>
                  </tr>
                </thead>

                <tbody className="divide-y divide-gray-100">
                  {itemsPaginados.map((s) => {
                    const retiroMaps = getBestMapsUrl(s, 'recoleccion')
                    const entregaMaps = getBestMapsUrl(s, 'entrega')
                    const esEntregada = s.estado === 'entregado'

                    const rem =
                      s.estado === 'pendiente_confirmacion'
                        ? getRemainingConfirmacion(s)
                        : s.estado === 'asignada'
                        ? getRemainingAceptacion(s)
                        : null

                    const sem = semaforoForRemaining(rem)

                    return (
                      <tr key={s.id} className="align-middle hover:bg-blue-50/60 transition-colors group">
                        <td className="px-3 py-2 border-r border-gray-100">
                          <Link
                            href={`/panel/gestor/solicitudes/${s.id}`}
                            className="block font-semibold text-xs text-gray-900 hover:text-blue-700 hover:underline truncate max-w-[170px]"
                            title={s.id}
                          >
                            {s.id}
                          </Link>
                          <div className="text-[11px] text-gray-500 mt-0.5 truncate">
                            {formatDateTime(s.createdAt)}
                          </div>
                          <div className="text-[11px] text-gray-400 mt-0.5">
                            {s.tipoCliente}{typeof s?.cotizacion?.distanciaKm === 'number' ? ` · ${s.cotizacion.distanciaKm}km` : ''}
                          </div>
                        </td>

                        <td className="px-3 py-2 border-r border-gray-100">
                          {/* Fila 1: estado + prioridad + timer */}
                          <div className="flex flex-wrap items-center gap-1">
                            <span className={`inline-flex rounded-full border px-2 py-0.5 text-[11px] font-medium ${estadoClass(s.estado)}`}>
                              {statusLabel(s.estado)}
                            </span>
                            {s.prioridad && (
                              <span className="inline-flex items-center rounded-full border border-yellow-300 bg-yellow-50 px-1.5 py-0.5 text-[10px] font-semibold text-yellow-700">
                                <Star className="h-2.5 w-2.5 fill-yellow-400" />
                              </span>
                            )}
                            {typeof rem === 'number' && (
                              <span className={`inline-flex rounded-full border px-1.5 py-0.5 text-[10px] font-medium ${sem.className}`}>
                                {formatMMSS(rem)}
                              </span>
                            )}
                          </div>

                          {/* Fila 2: financiero + riesgo */}
                          {(() => {
                            const ef = getEstadoFinanciero(s)
                            const riesgos = getRiesgos(s)
                            const efMap: Record<EstadoFinanciero, { label: string; className: string }> = {
                              pendiente: { label: 'Pend. cobro', className: 'bg-yellow-50 text-yellow-700 border-yellow-200' },
                              pagado:    { label: 'Cobrado',     className: 'bg-green-50 text-green-700 border-green-200' },
                              en_revision:{ label: 'En revisión',className: 'bg-blue-50 text-blue-700 border-blue-200' },
                              problema:  { label: '⚠ Pago',     className: 'bg-red-50 text-red-700 border-red-200' },
                              credito:   { label: 'Crédito',    className: 'bg-gray-100 text-gray-600 border-gray-200' },
                            }
                            const efInfo = efMap[ef]
                            return (
                              <div className="mt-1 flex flex-wrap gap-1">
                                <span className={`inline-flex rounded-full border px-1.5 py-0.5 text-[10px] font-medium ${efInfo.className}`}>
                                  {efInfo.label}
                                </span>
                                {riesgos.length > 0 && (
                                  <span className="inline-flex items-center gap-0.5 rounded-full border border-red-300 bg-red-50 px-1.5 py-0.5 text-[10px] font-semibold text-red-700">
                                    <AlertTriangle className="h-2.5 w-2.5" />{riesgos.length}
                                  </span>
                                )}
                              </div>
                            )
                          })()}

                          {/* Fila 3: dropdown de estado (sin label) */}
                          <div className="mt-1.5">
                            {(esEntregada || s.estado === 'rechazada' || s.estado === 'cancelada') ? (
                              <div className="inline-flex items-center gap-1 rounded border border-gray-200 bg-gray-50 px-2 py-1 text-[10px] text-gray-500">
                                <Lock className="h-3 w-3" /> Cerrada
                              </div>
                            ) : (
                              <select
                                value={s.estado}
                                onChange={(e) => cambiarEstado(s.id, e.target.value as EstadoSolicitud)}
                                className="w-full rounded border border-gray-200 bg-white px-2 py-1 text-[11px] outline-none focus:border-blue-300"
                              >
                                <option value={s.estado} disabled>{statusLabel(s.estado)}</option>
                                {(TRANSICIONES_VALIDAS[s.estado] ?? []).map((key) => {
                                  const e = ESTADOS.find((x) => x.key === key)
                                  return e ? <option key={e.key} value={e.key}>{e.label}</option> : null
                                })}
                              </select>
                            )}
                          </div>
                        </td>

                        <td className="px-3 py-2 border-r border-gray-100">
                          <div className="text-xs font-medium text-gray-900 truncate">{s.recoleccion.nombreApellido || '—'}</div>
                          <div className="text-[11px] text-gray-600 mt-0.5">{s.recoleccion.celular}</div>
                          <div className="text-[11px] text-gray-500 mt-0.5 truncate" title={s.recoleccion.direccionEscrita}>{s.recoleccion.direccionEscrita}</div>
                          {retiroMaps && (
                            <div className="mt-1 flex gap-1">
                              <a href={retiroMaps} target="_blank" rel="noreferrer" title="Ver en Maps" className="rounded p-1 text-blue-600 bg-blue-50 hover:bg-blue-100 transition">
                                <MapPin className="h-3 w-3" />
                              </a>
                              <button onClick={() => handleCopy(retiroMaps, 'Link retiro copiado')} title="Copiar link" className="rounded p-1 text-gray-500 bg-gray-100 hover:bg-gray-200 transition">
                                <Copy className="h-3 w-3" />
                              </button>
                            </div>
                          )}
                        </td>

                        <td className="px-3 py-2 border-r border-gray-100">
                          <div className="text-xs font-medium text-gray-900 truncate">{s.entrega.nombreApellido || '—'}</div>
                          <div className="text-[11px] text-gray-600 mt-0.5 flex items-center gap-1.5">
                            <span>{s.entrega.celular}</span>
                            {s.cobroContraEntrega?.aplica && (
                              <span className="inline-flex items-center gap-0.5 rounded-full bg-emerald-50 border border-emerald-200 px-1.5 py-0.5 text-[10px] font-semibold text-emerald-700">
                                <Wallet className="h-2.5 w-2.5" />{money(s.cobroContraEntrega.monto)}
                              </span>
                            )}
                          </div>
                          <div className="text-[11px] text-gray-500 mt-0.5 truncate" title={s.entrega.direccionEscrita}>{s.entrega.direccionEscrita}</div>
                          {entregaMaps && (
                            <div className="mt-1 flex gap-1">
                              <a href={entregaMaps} target="_blank" rel="noreferrer" title="Ver en Maps" className="rounded p-1 text-blue-600 bg-blue-50 hover:bg-blue-100 transition">
                                <MapPin className="h-3 w-3" />
                              </a>
                              <button onClick={() => handleCopy(entregaMaps, 'Link entrega copiado')} title="Copiar link" className="rounded p-1 text-gray-500 bg-gray-100 hover:bg-gray-200 transition">
                                <Copy className="h-3 w-3" />
                              </button>
                            </div>
                          )}
                        </td>

                        <td className="px-3 py-2 border-r border-gray-100">
                          {typeof s.confirmacion?.precioFinalCordobas === 'number' ? (
                            <div className="font-semibold text-xs text-gray-900">{money(s.confirmacion.precioFinalCordobas)}</div>
                          ) : typeof (s as any)?.pagoDelivery?.montoSugerido === 'number' ? (
                            <div className="text-[11px] text-gray-500">~{money((s as any).pagoDelivery.montoSugerido)}</div>
                          ) : typeof s?.cotizacion?.precioSugerido === 'number' ? (
                            <div className="text-[11px] text-gray-500">~{money(s.cotizacion.precioSugerido)}</div>
                          ) : (
                            <div className="text-[11px] text-gray-400">—</div>
                          )}
                          <div className="text-[11px] text-gray-400 mt-0.5 truncate">
                            {s.tipoCliente === 'credito' ? 'Crédito' : `Contado · ${(s.pagoDelivery as any)?.quienPaga || '—'}`}
                          </div>
                        </td>

                        <td className="px-3 py-2 border-r border-gray-100">
                          {s.asignacion?.motorizadoNombre ? (
                            <>
                              <div className="text-xs font-medium text-gray-900 truncate">{s.asignacion.motorizadoNombre}</div>
                              <div className="text-[11px] text-gray-600 mt-0.5">{s.asignacion.motorizadoTelefono || '—'}</div>
                            </>
                          ) : (
                            <div className="text-[11px] text-gray-400">Sin asignar</div>
                          )}
                        </td>

                        <td className="px-3 py-2 border-r border-gray-100">
                          {s.estado === 'asignada' ? (
                            <span className={`inline-flex rounded-full border px-2 py-0.5 text-[11px] font-medium ${aceptacionClass(s.asignacion || undefined)}`}>
                              {aceptacionLabel(s.asignacion || undefined)}
                            </span>
                          ) : (
                            <div className="text-[11px] text-gray-400">—</div>
                          )}
                        </td>

                        <td className="px-2 py-2 sticky right-0 bg-white z-10 border-l border-gray-200 group-hover:bg-blue-50">
                          <div className="flex flex-col gap-1 min-w-[150px]">

                            {/* CTA primaria según estado */}
                            {s.estado === 'pendiente_confirmacion' && (
                              <button
                                onClick={() => abrirConfirmarYAsignar(s)}
                                className="inline-flex items-center justify-center gap-1.5 rounded-lg bg-[#004aad] px-2.5 py-1.5 text-[11px] font-semibold text-white hover:bg-[#003d94] w-full"
                              >
                                <CheckCircle2 className="h-3.5 w-3.5 shrink-0" />
                                Confirmar + asignar
                              </button>
                            )}
                            {s.estado === 'confirmada' && (
                              <button
                                onClick={() => abrirConfirmarYAsignar(s)}
                                className="inline-flex items-center justify-center gap-1.5 rounded-lg bg-[#004aad] px-2.5 py-1.5 text-[11px] font-semibold text-white hover:bg-[#003d94] w-full"
                              >
                                <Truck className="h-3.5 w-3.5 shrink-0" />
                                Asignar
                              </button>
                            )}
                            {s.estado === 'asignada' && (
                              <div className="flex gap-1">
                                <button
                                  onClick={() => abrirReasignar(s)}
                                  className="flex-1 inline-flex items-center justify-center gap-1 rounded-lg border border-gray-300 bg-white px-2 py-1.5 text-[11px] font-medium text-gray-700 hover:bg-gray-100"
                                  title="Reasignar motorizado"
                                >
                                  <RefreshCcw className="h-3 w-3" />
                                  Reasignar
                                </button>
                                <button
                                  onClick={() => rebotarAsignacion(s.id)}
                                  className="flex-1 inline-flex items-center justify-center gap-1 rounded-lg border border-gray-300 bg-white px-2 py-1.5 text-[11px] font-medium text-gray-700 hover:bg-gray-100"
                                  title="Rebotar asignación"
                                >
                                  <RotateCcw className="h-3 w-3" />
                                  Rebotar
                                </button>
                              </div>
                            )}

                            {/* Iconos de acciones secundarias */}
                            <div className="flex items-center gap-0.5 flex-wrap">
                              <button
                                onClick={() => togglePrioridad(s.id, s.prioridad)}
                                title={s.prioridad ? 'Quitar prioridad' : 'Marcar prioritaria'}
                                className={`rounded-md p-1.5 transition ${s.prioridad ? 'text-yellow-500 bg-yellow-100 hover:bg-yellow-200' : 'text-gray-500 bg-gray-100 hover:bg-gray-200'}`}
                              >
                                <Star className={`h-3.5 w-3.5 ${s.prioridad ? 'fill-yellow-400' : ''}`} />
                              </button>

                              <button
                                onClick={() => handleCopy(buildCopyRetiroEntrega(s), 'Copiado')}
                                title="Copiar retiro/entrega"
                                className="rounded-md p-1.5 text-gray-500 bg-gray-100 hover:bg-gray-200 transition"
                              >
                                <Copy className="h-3.5 w-3.5" />
                              </button>

                              <button
                                onClick={() => handleCopy(buildCopyTelegramFull(s), 'Telegram copiado')}
                                title="Copiar Telegram"
                                className="rounded-md p-1.5 text-gray-500 bg-gray-100 hover:bg-gray-200 transition"
                              >
                                <Send className="h-3.5 w-3.5" />
                              </button>

                              <button
                                onClick={() => setDrawerSolicitudId(s.id)}
                                title="Ver detalle"
                                className="rounded-md p-1.5 text-gray-500 bg-gray-100 hover:bg-gray-200 transition"
                              >
                                <Eye className="h-3.5 w-3.5" />
                              </button>

                              <Link
                                href={`/panel/gestor/solicitudes/${s.id}`}
                                title="Abrir página completa"
                                className="rounded-md p-1.5 text-gray-500 bg-gray-100 hover:bg-gray-200 transition"
                              >
                                <ExternalLink className="h-3.5 w-3.5" />
                              </Link>

                              {s.estado === 'pendiente_confirmacion' && (
                                <button
                                  onClick={() => cambiarEstado(s.id, 'rechazada')}
                                  title="Rechazar orden"
                                  className="rounded-md p-1.5 text-red-600 bg-red-100 hover:bg-red-200 transition"
                                >
                                  <XCircle className="h-3.5 w-3.5" />
                                </button>
                              )}

                              {getEstadoFinanciero(s) === 'problema' && (
                                <button
                                  onClick={() => setDrawerSolicitudId(s.id)}
                                  title="Ver incidencia de cobro"
                                  className="rounded-md p-1.5 text-orange-600 bg-orange-100 hover:bg-orange-200 transition"
                                >
                                  <AlertTriangle className="h-3.5 w-3.5" />
                                </button>
                              )}

                              {s.registro?.deposito && !s.registro.deposito.confirmadoStorkhub && (
                                <button
                                  onClick={() => setDrawerSolicitudId(s.id)}
                                  title="Ver comprobante depósito"
                                  className="rounded-md p-1.5 text-blue-600 bg-blue-100 hover:bg-blue-200 transition"
                                >
                                  <FileCheck className="h-3.5 w-3.5" />
                                </button>
                              )}
                            </div>
                          </div>
                        </td>
                      </tr>
                    )
                  })}
                </tbody>
              </table>
            </div>
          </div>

          <div className="xl:hidden flex-1 min-h-0 overflow-auto space-y-3">
            <div className="rounded-2xl border border-gray-200 bg-white p-3 shadow-sm">
              <div className="flex items-center justify-between gap-3 flex-wrap">
                <div className="text-sm text-gray-600">
                  Mostrando <strong>{itemsFiltrados.length === 0 ? 0 : startIndex + 1}</strong>–
                  <strong>{endIndex}</strong> de <strong>{itemsFiltrados.length}</strong>
                </div>

                <select
                  value={pageSize}
                  onChange={(e) => setPageSize(Number(e.target.value))}
                  className="rounded-lg border border-gray-200 bg-white px-3 py-2 text-sm outline-none"
                >
                  <option value={10}>10 por página</option>
                  <option value={20}>20 por página</option>
                  <option value={50}>50 por página</option>
                </select>
              </div>
            </div>

            {itemsPaginados.map((s) => {
              const retiroMaps = getBestMapsUrl(s, 'recoleccion')
              const entregaMaps = getBestMapsUrl(s, 'entrega')
              const esEntregada = s.estado === 'entregado'

              const rem =
                s.estado === 'pendiente_confirmacion'
                  ? getRemainingConfirmacion(s)
                  : s.estado === 'asignada'
                  ? getRemainingAceptacion(s)
                  : null

              const sem = semaforoForRemaining(rem)

              return (
                <div key={s.id} className="rounded-2xl border border-gray-200 bg-white p-4 shadow-sm">
                  <div className="flex items-start justify-between gap-3 flex-wrap">
                    <div>
                      <Link
                        href={`/panel/gestor/solicitudes/${s.id}`}
                        className="font-semibold text-gray-900 hover:text-blue-700 hover:underline"
                      >
                        {s.id}
                      </Link>
                      <div className="text-xs text-gray-500 mt-1">{formatDateTime(s.createdAt)}</div>
                    </div>

                    <span className={`inline-flex rounded-full border px-2.5 py-1 text-xs font-medium ${estadoClass(s.estado)}`}>
                      {statusLabel(s.estado)}
                    </span>
                  </div>

                  <div className="mt-3">
                    <label className="block text-[11px] font-medium uppercase tracking-wide text-gray-500 mb-1">
                      Corregir estado
                    </label>

                    {esEntregada ? (
                      <div className="flex items-center gap-2 rounded-lg border border-gray-200 bg-gray-50 px-3 py-2 text-sm text-gray-600">
                        <Lock className="h-4 w-4" />
                        Orden cerrada
                      </div>
                    ) : (
                      <select
                        value={s.estado}
                        onChange={(e) => cambiarEstado(s.id, e.target.value as EstadoSolicitud)}
                        className="w-full rounded-lg border border-gray-200 bg-white px-3 py-2 text-sm outline-none focus:border-blue-300"
                      >
                        {ESTADOS.map((estado) => (
                          <option key={estado.key} value={estado.key}>
                            {estado.label}
                          </option>
                        ))}
                      </select>
                    )}
                  </div>

                  <div className="mt-3 space-y-2 text-sm">
                    <div>
                      <span className="font-medium">Retiro:</span> {s.recoleccion.nombreApellido || '—'} · {s.recoleccion.celular}
                    </div>
                    <div className="text-gray-600">{s.recoleccion.direccionEscrita}</div>

                    <div className="pt-2">
                      <span className="font-medium">Entrega:</span> {s.entrega.nombreApellido || '—'} · {s.entrega.celular}
                    </div>
                    <div className="text-gray-600">{s.entrega.direccionEscrita}</div>

                    <div className="pt-2">
                      <span className="font-medium">Precio:</span>{' '}
                      {typeof s.confirmacion?.precioFinalCordobas === 'number'
                        ? money(s.confirmacion.precioFinalCordobas)
                        : '—'}
                    </div>

                    <div>
                      <span className="font-medium">Motorizado:</span> {s.asignacion?.motorizadoNombre || 'Sin asignar'}
                    </div>

                    {typeof rem === 'number' && (
                      <div>
                        <span className={`inline-flex rounded-full border px-2.5 py-1 text-xs font-medium ${sem.className}`}>
                          {formatMMSS(rem)} · {sem.label}
                        </span>
                      </div>
                    )}
                  </div>

                  <div className="mt-4 grid grid-cols-2 gap-2">
                    <button
                      onClick={() => handleCopy(buildCopyRetiroEntrega(s), 'Información copiada')}
                      className="rounded-lg border border-gray-200 px-3 py-2 text-xs font-medium text-gray-700"
                    >
                      Copiar retiro
                    </button>

                    <button
                      onClick={() => handleCopy(buildCopyTelegramFull(s), 'Formato Telegram copiado')}
                      className="rounded-lg border border-gray-200 px-3 py-2 text-xs font-medium text-gray-700"
                    >
                      Telegram
                    </button>

                    {s.estado === 'pendiente_confirmacion' && (
                      <button
                        onClick={() => abrirConfirmarYAsignar(s)}
                        className="rounded-lg bg-[#004aad] px-3 py-2 text-xs font-medium text-white col-span-2"
                      >
                        Confirmar + asignar
                      </button>
                    )}

                    {s.estado === 'confirmada' && (
                      <button
                        onClick={() => abrirConfirmarYAsignar(s)}
                        className="rounded-lg border border-gray-200 px-3 py-2 text-xs font-medium text-gray-700 col-span-2"
                      >
                        Asignar rápido
                      </button>
                    )}

                    {s.estado === 'asignada' && (
                      <>
                        <button
                          onClick={() => abrirReasignar(s)}
                          className="rounded-lg border border-gray-200 px-3 py-2 text-xs font-medium text-gray-700"
                        >
                          Reasignar
                        </button>

                        <button
                          onClick={() => rebotarAsignacion(s.id)}
                          className="rounded-lg border border-gray-200 px-3 py-2 text-xs font-medium text-gray-700"
                        >
                          Rebotar
                        </button>
                      </>
                    )}

                    <Link
                      href={`/panel/gestor/solicitudes/${s.id}`}
                      className="rounded-lg border border-gray-200 px-3 py-2 text-xs font-medium text-gray-700 col-span-2 text-center"
                    >
                      Ver detalle
                    </Link>
                  </div>

                  <div className="mt-3 flex flex-wrap gap-3 text-xs">
                    {retiroMaps && (
                      <a href={retiroMaps} target="_blank" rel="noreferrer" className="text-blue-700 underline">
                        Abrir retiro en Maps
                      </a>
                    )}
                    {entregaMaps && (
                      <a href={entregaMaps} target="_blank" rel="noreferrer" className="text-blue-700 underline">
                        Abrir entrega en Maps
                      </a>
                    )}
                  </div>
                </div>
              )
            })}

            <div className="rounded-2xl border border-gray-200 bg-white p-3 shadow-sm">
              <div className="flex items-center justify-between gap-2">
                <button
                  onClick={() => setPage((p) => Math.max(1, p - 1))}
                  disabled={safePage === 1}
                  className="inline-flex items-center gap-1 rounded-lg border border-gray-200 bg-white px-3 py-2 text-sm font-medium text-gray-700 disabled:cursor-not-allowed disabled:opacity-40"
                >
                  <ChevronLeft className="h-4 w-4" />
                  Anterior
                </button>

                <div className="text-sm text-gray-700">
                  Página <strong>{safePage}</strong> de <strong>{totalPages}</strong>
                </div>

                <button
                  onClick={() => setPage((p) => Math.min(totalPages, p + 1))}
                  disabled={safePage === totalPages}
                  className="inline-flex items-center gap-1 rounded-lg border border-gray-200 bg-white px-3 py-2 text-sm font-medium text-gray-700 disabled:cursor-not-allowed disabled:opacity-40"
                >
                  Siguiente
                  <ChevronRight className="h-4 w-4" />
                </button>
              </div>
            </div>
          </div>
        </div>
      )}

      {/* ── DRAWER LATERAL ─────────────────────────────────────────────────── */}
      {drawerSolicitudId && (() => {
        const s = allItems.find((x) => x.id === drawerSolicitudId)
        if (!s) return null
        const ef = getEstadoFinanciero(s)
        const riesgos = getRiesgos(s)
        const efColors: Record<EstadoFinanciero, string> = {
          pendiente: 'bg-yellow-50 text-yellow-700 border-yellow-200',
          pagado: 'bg-green-50 text-green-700 border-green-200',
          en_revision: 'bg-blue-50 text-blue-700 border-blue-200',
          problema: 'bg-red-50 text-red-700 border-red-200',
          credito: 'bg-gray-100 text-gray-600 border-gray-200',
        }
        const efLabels: Record<EstadoFinanciero, string> = {
          pendiente: 'Pendiente cobro', pagado: 'Cobrado', en_revision: 'En revisión', problema: 'Problema pago', credito: 'Crédito semanal',
        }
        const precioFinalDrawer = s.confirmacion?.precioFinalCordobas
        return (
          <>
            {/* Backdrop */}
            <div className="fixed inset-0 z-40 bg-black/20" onClick={() => setDrawerSolicitudId(null)} />
            {/* Panel */}
            <div className="fixed right-0 top-0 h-full w-full max-w-[440px] bg-white shadow-2xl z-50 flex flex-col overflow-hidden">
              {/* Header */}
              <div className="flex items-center justify-between px-5 py-4 border-b border-gray-100 bg-gray-50 shrink-0">
                <div>
                  <div className="text-xs text-gray-500 font-mono">#{s.id.slice(0, 8)}</div>
                  <div className="font-semibold text-gray-900 text-sm mt-0.5 flex items-center gap-2">
                    <span className={`inline-flex rounded-full border px-2.5 py-0.5 text-xs font-medium ${estadoClass(s.estado)}`}>{statusLabel(s.estado)}</span>
                    {s.prioridad && <span className="inline-flex items-center gap-0.5 rounded-full border border-yellow-300 bg-yellow-50 px-2 py-0.5 text-[10px] font-semibold text-yellow-700"><Star className="h-2.5 w-2.5 fill-yellow-400 text-yellow-400" />Prioritaria</span>}
                  </div>
                </div>
                <button onClick={() => setDrawerSolicitudId(null)} className="rounded-full p-1.5 hover:bg-gray-200 transition text-gray-500">
                  <X className="h-4 w-4" />
                </button>
              </div>

              {/* Contenido scrolleable */}
              <div className="flex-1 overflow-y-auto px-5 py-4 space-y-4 text-sm">

                {/* Estado financiero */}
                <div className="rounded-xl border p-3 bg-white">
                  <div className="text-[11px] font-semibold uppercase tracking-wide text-gray-400 mb-2">Estado financiero</div>
                  <div className="flex flex-wrap gap-2">
                    <span className={`inline-flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-xs font-medium ${efColors[ef]}`}>
                      <DollarSign className="h-3 w-3" />
                      {efLabels[ef]}
                    </span>
                    {riesgos.map((r) => (
                      <span key={r.tipo} className="inline-flex items-center gap-1.5 rounded-full border border-red-300 bg-red-50 px-2.5 py-1 text-xs font-semibold text-red-700">
                        <AlertTriangle className="h-3 w-3" />{r.label}
                      </span>
                    ))}
                  </div>
                  {s.cobrosMotorizado?.delivery && (
                    <div className="mt-2 text-xs text-gray-600">
                      Delivery cobrado: <strong>{s.cobrosMotorizado.delivery.recibio ? 'Sí' : 'No'}</strong>
                      {s.cobrosMotorizado.delivery.justificacion && <span className="ml-1 text-orange-600">— {s.cobrosMotorizado.delivery.justificacion}</span>}
                    </div>
                  )}
                </div>

                {/* Precio */}
                <div className="rounded-xl border p-3 bg-white">
                  <div className="text-[11px] font-semibold uppercase tracking-wide text-gray-400 mb-2">Precio delivery</div>
                  {typeof precioFinalDrawer === 'number' ? (
                    <div className="text-lg font-bold text-gray-900">{money(precioFinalDrawer)}</div>
                  ) : (
                    <div className="text-gray-500 text-xs">Sin confirmar</div>
                  )}
                  <div className="text-xs text-gray-500 mt-1">
                    {s.tipoCliente === 'credito' ? 'Crédito semanal' : `Contado · paga: ${(s.pagoDelivery as any)?.quienPaga || '—'}`}
                  </div>
                  {s.cobroContraEntrega?.aplica && (
                    <div className="mt-1 text-xs text-gray-700 flex items-center gap-1">
                      <Wallet className="h-3 w-3 text-gray-400" />
                      CE: <strong className="ml-0.5">{money(s.cobroContraEntrega.monto)}</strong>
                    </div>
                  )}
                </div>

                {/* Retiro */}
                <div className="rounded-xl border p-3 bg-white">
                  <div className="text-[11px] font-semibold uppercase tracking-wide text-gray-400 mb-2 flex items-center gap-1">
                    <MapPin className="h-3 w-3" />Retiro
                  </div>
                  <div className="font-medium text-gray-900">{s.recoleccion.nombreApellido || '—'}</div>
                  <div className="text-gray-600 mt-0.5 flex items-center gap-1"><Phone className="h-3 w-3 text-gray-400" />{s.recoleccion.celular}</div>
                  <div className="text-gray-600 mt-0.5 text-xs">{s.recoleccion.direccionEscrita}</div>
                  {getBestMapsUrl(s, 'recoleccion') && (
                    <a href={getBestMapsUrl(s, 'recoleccion')!} target="_blank" rel="noreferrer" className="inline-flex items-center gap-1 text-xs text-blue-600 hover:underline mt-1">
                      <ExternalLink className="h-3 w-3" />Ver en Maps
                    </a>
                  )}
                </div>

                {/* Entrega */}
                <div className="rounded-xl border p-3 bg-white">
                  <div className="text-[11px] font-semibold uppercase tracking-wide text-gray-400 mb-2 flex items-center gap-1">
                    <MapPin className="h-3 w-3" />Entrega
                  </div>
                  <div className="font-medium text-gray-900">{s.entrega.nombreApellido || '—'}</div>
                  <div className="text-gray-600 mt-0.5 flex items-center gap-1"><Phone className="h-3 w-3 text-gray-400" />{s.entrega.celular}</div>
                  <div className="text-gray-600 mt-0.5 text-xs">{s.entrega.direccionEscrita}</div>
                  {getBestMapsUrl(s, 'entrega') && (
                    <a href={getBestMapsUrl(s, 'entrega')!} target="_blank" rel="noreferrer" className="inline-flex items-center gap-1 text-xs text-blue-600 hover:underline mt-1">
                      <ExternalLink className="h-3 w-3" />Ver en Maps
                    </a>
                  )}
                </div>

                {/* Motorizado */}
                {s.asignacion?.motorizadoNombre && (
                  <div className="rounded-xl border p-3 bg-white">
                    <div className="text-[11px] font-semibold uppercase tracking-wide text-gray-400 mb-2 flex items-center gap-1">
                      <Truck className="h-3 w-3" />Motorizado
                    </div>
                    <div className="font-medium text-gray-900">{s.asignacion.motorizadoNombre}</div>
                    {s.asignacion.motorizadoTelefono && <div className="text-gray-600 text-xs mt-0.5">{s.asignacion.motorizadoTelefono}</div>}
                    <div className="text-xs text-gray-500 mt-1">Aceptación: <span className={`font-medium ${s.asignacion.estadoAceptacion === 'aceptada' ? 'text-green-700' : s.asignacion.estadoAceptacion === 'rechazada' ? 'text-red-700' : 'text-yellow-700'}`}>{s.asignacion.estadoAceptacion || '—'}</span></div>
                  </div>
                )}

                {/* Fechas */}
                <div className="rounded-xl border p-3 bg-white">
                  <div className="text-[11px] font-semibold uppercase tracking-wide text-gray-400 mb-2">Historial</div>
                  <div className="space-y-1 text-xs text-gray-600">
                    <div>Creado: <span className="font-medium">{formatDateTime(s.createdAt)}</span></div>
                    <div>Actualizado: <span className="font-medium">{formatDateTime(s.updatedAt)}</span></div>
                    {s.entregadoAt && <div>Entregado: <span className="font-medium text-green-700">{formatDateTime(s.entregadoAt)}</span></div>}
                  </div>
                </div>

                {/* Acciones */}
                <div className="rounded-xl border p-3 bg-white">
                  <div className="text-[11px] font-semibold uppercase tracking-wide text-gray-400 mb-2">Acciones</div>
                  <div className="flex flex-col gap-2">
                    <button onClick={() => togglePrioridad(s.id, s.prioridad)}
                      className={`inline-flex items-center gap-2 rounded-lg border px-3 py-2 text-xs font-medium ${s.prioridad ? 'border-yellow-300 bg-yellow-50 text-yellow-700' : 'border-gray-200 text-gray-600 hover:bg-gray-50'}`}>
                      <Star className={`h-4 w-4 ${s.prioridad ? 'fill-yellow-400 text-yellow-400' : ''}`} />
                      {s.prioridad ? 'Quitar prioridad' : 'Marcar prioritaria'}
                    </button>
                    {s.estado === 'pendiente_confirmacion' && (
                      <button onClick={() => { setDrawerSolicitudId(null); abrirConfirmarYAsignar(s) }}
                        className="inline-flex items-center gap-2 rounded-lg bg-[#004aad] px-3 py-2 text-xs font-medium text-white hover:bg-[#003d94]">
                        <CheckCircle2 className="h-4 w-4" />Confirmar + asignar
                      </button>
                    )}
                    {s.estado === 'confirmada' && (
                      <button onClick={() => { setDrawerSolicitudId(null); abrirConfirmarYAsignar(s) }}
                        className="inline-flex items-center gap-2 rounded-lg border border-gray-200 px-3 py-2 text-xs font-medium text-gray-700 hover:bg-gray-50">
                        <Truck className="h-4 w-4" />Asignar rápido
                      </button>
                    )}
                    {s.estado === 'asignada' && (
                      <>
                        <button onClick={() => { setDrawerSolicitudId(null); abrirReasignar(s) }}
                          className="inline-flex items-center gap-2 rounded-lg border border-gray-200 px-3 py-2 text-xs font-medium text-gray-700 hover:bg-gray-50">
                          <RefreshCcw className="h-4 w-4" />Reasignar
                        </button>
                        <button onClick={() => { rebotarAsignacion(s.id); setDrawerSolicitudId(null) }}
                          className="inline-flex items-center gap-2 rounded-lg border border-gray-200 px-3 py-2 text-xs font-medium text-gray-700 hover:bg-gray-50">
                          <RotateCcw className="h-4 w-4" />Rebotar
                        </button>
                      </>
                    )}
                    <Link href={`/panel/gestor/solicitudes/${s.id}`}
                      className="inline-flex items-center gap-2 rounded-lg border border-gray-200 px-3 py-2 text-xs font-medium text-gray-700 hover:bg-gray-50">
                      <ExternalLink className="h-4 w-4" />Abrir página completa
                    </Link>
                  </div>
                </div>
              </div>
            </div>
          </>
        )
      })()}

      {openId && (
        <div className="fixed inset-0 bg-black/30 flex items-center justify-center p-4 z-50">
          <div className="w-full max-w-md rounded-2xl bg-white p-5 shadow-lg">
            <div className="flex items-center justify-between">
              <h3 className="font-semibold text-lg">
                {modalMode === 'reasignar' ? 'Reasignar motorizado' : 'Confirmar y asignar'}
              </h3>
              <button onClick={cerrarModal} className="text-sm underline">
                Cerrar
              </button>
            </div>

            <p className="text-sm text-gray-600 mt-2">
              {modalMode === 'reasignar'
                ? 'Selecciona un nuevo motorizado y reinicia la ventana de aceptación.'
                : '1) Confirmás el precio final. 2) Si quieres, asignás motorizado en el mismo paso.'}
            </p>

            <div className="mt-4">
              <label className="block text-sm font-medium mb-1">Precio final (C$)</label>
              <input
                type="number"
                step={10}
                value={precioFinal}
                onChange={(e) => {
                  const v = e.target.value === '' ? '' : Number(e.target.value)
                  setPrecioFinal(v === '' ? '' : Number(roundTo10(v)))
                }}
                className="w-full border rounded-lg px-3 py-2"
                placeholder="Ej: 130"
              />
              <div className="text-xs text-gray-500 mt-1">Se redondea automáticamente a múltiplos de 10.</div>
            </div>

            <div className="mt-4">
              <label className="block text-sm font-medium mb-1">
                Motorizado {modalMode === 'confirmar' ? '(opcional)' : ''}
              </label>
              <select
                value={motorizadoSel}
                onChange={(e) => setMotorizadoSel(e.target.value)}
                className="w-full border rounded-lg px-3 py-2"
              >
                {modalMode === 'confirmar' && <option value="">-- No asignar todavía --</option>}
                {motorizados.map((m) => (
                  <option key={m.id} value={m.id}>
                    {m.estado === 'disponible' ? '✅ ' : '⛔ '}
                    {m.nombre}
                    {m.telefono ? ` · ${m.telefono}` : ''}
                  </option>
                ))}
              </select>
              <div className="text-xs text-gray-500 mt-1">
                Si asignás ahora, el motorizado tendrá <strong>10 minutos</strong> para aceptar.
              </div>
            </div>

            <div className="mt-4 flex gap-2 flex-wrap">
              {modalMode === 'reasignar' ? (
                <button
                  onClick={() => reasignarSolo(openId)}
                  className="rounded-full bg-[#004aad] text-white px-4 py-2 text-sm font-semibold"
                >
                  Reasignar
                </button>
              ) : (
                <button
                  onClick={() => confirmarYAsignar(openId)}
                  className="rounded-full bg-[#004aad] text-white px-4 py-2 text-sm font-semibold"
                >
                  Guardar
                </button>
              )}

              <button onClick={cerrarModal} className="rounded-full border px-4 py-2 text-sm font-semibold">
                Cancelar
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}