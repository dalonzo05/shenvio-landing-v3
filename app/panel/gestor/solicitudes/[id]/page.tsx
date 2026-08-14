'use client'

import { useEffect, useMemo, useRef, useState } from 'react'
import Link from 'next/link'
import { useParams, useRouter } from 'next/navigation'
import { getMapsLoader } from '@/lib/googleMaps'
import { useModuleGuard } from '../../../_hooks/useModuleGuard'
import {
  doc,
  getDoc,
  onSnapshot,
  updateDoc,
  setDoc,
  writeBatch,
  serverTimestamp,
  collection,
  getDocs,
  query,
  where,
  increment,
} from 'firebase/firestore'
import { auth, db } from '@/fb/config'
import {
  rankearMotorizados,
  type MotorizadoConRanking,
  type OrdenActivaRanking,
  type NuevaOrdenRanking,
  type MotorizadoRankeado,
} from '@/lib/motorizado-ranking'
import {
  ArrowLeft,
  ExternalLink,
  Copy,
  Phone,
  MapPin,
  User,
  Wallet,
  Truck,
  CheckCircle2,
  RotateCcw,
  XCircle,
  Clock3,
  Package,
  Send,
  AlertTriangle,
  CheckCheck,
  Bike,
  Star,
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
  historial?: {
    en_camino_retiroAt?: any
    retiradoAt?: any
    en_camino_entregaAt?: any
    entregadoAt?: any
  }
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
    motorizadoFotoUrl?: string | null
    asignadoPorUid?: string
    asignadoAt?: any
    aceptarAntesDe?: any
    estadoAceptacion?: 'pendiente' | 'aceptada' | 'rechazada' | 'expirada'
    aceptadoAt?: any
    rechazadoAt?: any
    motivoRechazo?: string
  } | null

  evidencias?: {
    retiro?: { url: string; pathStorage: string; uploadedAt?: any; motorizadoUid?: string }
    entrega?: { url: string; pathStorage: string; uploadedAt?: any; motorizadoUid?: string }
    deposito?: { url: string; pathStorage: string; uploadedAt?: any; motorizadoUid?: string }
  }

  tipoServicio?: 'normal' | 'fuera_managua' | 'compra_gestion'
  fueraManagua?: {
    metodoEnvio?: 'bus_terminal' | 'cargotrans'
    destinoFinal?: string | null
    puntoLogisticoNombre?: string | null
    terminalSugerida?: string | null
    direccionPuntoLogistico?: string | null
    horarioApertura?: string | null
    horarioCierre?: string | null
    coordsPuntoLogistico?: { lat: number; lng: number } | null
    transporteNombre?: string | null
    transporteCelular?: string | null
    transporteHoraSalida?: string | null
    cantidadPaquetes?: number
    notaCargotrans?: string | null
    pagoCargotrans?: 'efectivo_motorizado' | 'transferencia_comercio' | null
  }

  evidenciasCargotrans?: {
    fotos?: Array<{ url: string; pathStorage: string }>
    factura?: { url: string; pathStorage: string }
    costoCargotrans?: number | null
    subidasAt?: any
    subidasPorUid?: string
  }

  userId?: string
  requiereBolso?: boolean
  zonaRetiroId?: string | null
  zonaRetiroNombre?: string | null
  zonaEntregaId?: string | null
  zonaEntregaNombre?: string | null
  macroZonaRetiroId?: string | null
  macroZonaRetiroNombre?: string | null
  macroZonaEntregaId?: string | null
  macroZonaEntregaNombre?: string | null
  rechazo?: {
    motivoCodigo?: string
    motivoTexto?: string
    detalle?: string | null
    rechazadoPorUid?: string | null
    rechazadoAt?: any
    visibleParaComercio?: boolean
  }
  registro?: {
    deposito?: {
      monto?: number | null
      formaPago?: string | null
      confirmadoComercio?: boolean
      confirmadoComercioAt?: any
      confirmadoStorkhub?: boolean
      confirmadoStorkhubAt?: any
      storkhubDepositoId?: string
      comercioDepositoId?: string
    }
  }
}

type Motorizado = MotorizadoConRanking

const MOTIVOS_RECHAZO = [
  { codigo: 'fuera_cobertura', label: 'Fuera de cobertura' },
  { codigo: 'direccion_incompleta', label: 'Dirección incompleta o poco clara' },
  { codigo: 'precio_no_aceptado', label: 'Precio no aceptado' },
  { codigo: 'sin_motorizado_disponible', label: 'Sin motorizado disponible' },
  { codigo: 'pedido_duplicado', label: 'Pedido duplicado' },
  { codigo: 'problema_comercio_cliente', label: 'Problema con la información del comercio o cliente' },
  { codigo: 'otro', label: 'Otro motivo' },
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

function statusLabel(estado: EstadoSolicitud) {
  const map: Record<EstadoSolicitud, string> = {
    pendiente_confirmacion: 'Pendiente confirmación',
    confirmada: 'Confirmada',
    rechazada: 'Rechazada',
    asignada: 'Asignada',
    en_camino_retiro: 'En camino retiro',
    retirado: 'Retirado',
    en_camino_entrega: 'En camino entrega',
    entregado: 'Entregado',
    cancelada: 'Cancelada',
  }
  return map[estado] || estado
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

function aceptacionLabel(estado?: string) {
  if (!estado) return '—'
  const map: Record<string, string> = {
    pendiente: 'Pendiente',
    aceptada: 'Aceptada',
    rechazada: 'Rechazada',
    expirada: 'Expirada',
  }
  return map[estado] || estado
}

function aceptacionClass(estado?: string) {
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

// ─── Mapa con retiro y entrega ───────────────────────────────────────────────

type LatLng = { lat: number; lng: number }

function MapaOrden({ retiro, entrega }: { retiro: LatLng | null; entrega: LatLng | null }) {
  const ref = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (!retiro && !entrega) return
    let map: google.maps.Map
    let destroyed = false

    getMapsLoader()
      .load()
      .then(() => {
        if (destroyed || !ref.current) return

        const center = retiro ?? entrega!
        map = new google.maps.Map(ref.current, {
          center,
          zoom: 13,
          mapTypeControl: false,
          streetViewControl: false,
          fullscreenControl: false,
          zoomControl: true,
        })

        const bounds = new google.maps.LatLngBounds()

        if (retiro) {
          bounds.extend(retiro)
          new google.maps.Marker({
            map,
            position: retiro,
            title: 'Retiro',
            label: { text: 'R', color: 'white', fontWeight: 'bold' },
            icon: {
              path: google.maps.SymbolPath.CIRCLE,
              scale: 14,
              fillColor: '#004aad',
              fillOpacity: 1,
              strokeColor: '#fff',
              strokeWeight: 2,
            },
          })
        }

        if (entrega) {
          bounds.extend(entrega)
          new google.maps.Marker({
            map,
            position: entrega,
            title: 'Entrega',
            label: { text: 'E', color: 'white', fontWeight: 'bold' },
            icon: {
              path: google.maps.SymbolPath.CIRCLE,
              scale: 14,
              fillColor: '#dc2626',
              fillOpacity: 1,
              strokeColor: '#fff',
              strokeWeight: 2,
            },
          })
        }

        if (retiro && entrega) {
          // Línea entre los dos puntos
          new google.maps.Polyline({
            map,
            path: [retiro, entrega],
            strokeColor: '#004aad',
            strokeOpacity: 0.5,
            strokeWeight: 2,
            geodesic: true,
          })
          map.fitBounds(bounds, 60)
        } else {
          map.setCenter(center)
          map.setZoom(15)
        }
      })
      .catch(console.error)

    return () => { destroyed = true }
  }, [retiro, entrega])

  if (!retiro && !entrega) return null

  return (
    <div className="rounded-2xl border border-gray-200 bg-white shadow-sm overflow-hidden">
      <div className="flex items-center gap-3 px-5 py-3 border-b">
        <MapPin className="h-4 w-4 text-gray-500" />
        <h2 className="font-semibold text-gray-900">Mapa del viaje</h2>
        <span className="flex items-center gap-1.5 text-xs text-gray-500">
          <span className="inline-block w-3 h-3 rounded-full bg-[#004aad]" /> Retiro
          <span className="ml-2 inline-block w-3 h-3 rounded-full bg-red-600" /> Entrega
        </span>
      </div>
      <div ref={ref} className="w-full h-[300px]" />
    </div>
  )
}

function TimelineStep({
  title,
  done,
  current,
  subtitle,
}: {
  title: string
  done?: boolean
  current?: boolean
  subtitle?: string
}) {
  return (
    <div className="flex items-start gap-3">
      <div
        className={`mt-0.5 flex h-7 w-7 shrink-0 items-center justify-center rounded-full border text-xs font-bold ${
          current
            ? 'border-blue-300 bg-blue-50 text-blue-700'
            : done
            ? 'border-green-300 bg-green-50 text-green-700'
            : 'border-gray-200 bg-white text-gray-400'
        }`}
      >
        {done ? '✓' : '•'}
      </div>
      <div>
        <div className={`text-sm font-medium ${current || done ? 'text-gray-900' : 'text-gray-500'}`}>
          {title}
        </div>
        {subtitle ? <div className="text-xs text-gray-500 mt-0.5">{subtitle}</div> : null}
      </div>
    </div>
  )
}

export default function GestorSolicitudDetallePage() {
  // Mismo módulo que el listado ('solicitudes'): esta es su ruta de detalle,
  // no un módulo aparte — ver lib/permissions.ts.
  const estadoGuardModulo = useModuleGuard('solicitudes')
  if (estadoGuardModulo !== 'autorizado') {
    return (
      <div className="w-full px-6 py-6 text-sm text-gray-600">
        {estadoGuardModulo === 'redirigiendo' ? 'Redirigiendo a tu panel...' : 'Validando permisos...'}
      </div>
    )
  }
  return <GestorSolicitudDetallePageContent />
}

function GestorSolicitudDetallePageContent() {
  const params = useParams()
  const router = useRouter()
  const id = String(params?.id || '')

  const [solicitud, setSolicitud] = useState<Solicitud | null>(null)
  const [loading, setLoading] = useState(true)
  const [err, setErr] = useState<string | null>(null)

  const [motorizados, setMotorizados] = useState<Motorizado[]>([])
  const [precioFinal, setPrecioFinal] = useState<number | ''>('')
  const [motorizadoSel, setMotorizadoSel] = useState('')
  const [ordenesActivas, setOrdenesActivas] = useState<OrdenActivaRanking[]>([])
  const [loadingOrdenes, setLoadingOrdenes] = useState(false)
  const [comercioRequiereBolso, setComercioRequiereBolso] = useState<boolean | null>(null)
  const [showRechazarModal, setShowRechazarModal] = useState(false)
  const [motivoCodigo, setMotivoCodigo] = useState('')
  const [motivoTexto, setMotivoTexto] = useState('')
  const [detalleRechazo, setDetalleRechazo] = useState('')

  const [tick, setTick] = useState(Date.now())
  useEffect(() => {
    const t = setInterval(() => setTick(Date.now()), 1000)
    return () => clearInterval(t)
  }, [])

  useEffect(() => {
    getDocs(query(collection(db, 'motorizado'))).then((snap) => {
      setMotorizados(
        snap.docs
          .map((d) => ({ id: d.id, ...(d.data() as any) }))
          .sort((a, b) => (b.estado === 'disponible' ? 1 : 0) - (a.estado === 'disponible' ? 1 : 0))
      )
    }).catch(console.error)
  }, [])

  useEffect(() => {
    setLoadingOrdenes(true)
    getDocs(
      query(
        collection(db, 'solicitudes_envio'),
        where('estado', 'in', ['asignada', 'en_camino_retiro', 'retirado', 'en_camino_entrega'])
      )
    )
      .then((snap) => setOrdenesActivas(snap.docs.map((d) => ({ id: d.id, ...(d.data() as any) }))))
      .catch(console.error)
      .finally(() => setLoadingOrdenes(false))
  }, [])

  useEffect(() => {
    if (!id) return

    setLoading(true)
    const ref = doc(db, 'solicitudes_envio', id)

    const unsub = onSnapshot(
      ref,
      (snap) => {
        if (!snap.exists()) {
          setSolicitud(null)
          setErr('La orden no existe.')
          setLoading(false)
          return
        }

        const data = { id: snap.id, ...(snap.data() as any) } as Solicitud
        setComercioRequiereBolso(null)
        setSolicitud(data)
        setPrecioFinal(data.confirmacion?.precioFinalCordobas ?? '')
        setMotorizadoSel(data.asignacion?.motorizadoId || '')
        setErr(null)
        setLoading(false)
      },
      (e) => {
        console.error(e)
        setErr('No se pudo cargar la orden.')
        setLoading(false)
      }
    )

    return () => unsub()
  }, [id])

  useEffect(() => {
    if (!solicitud?.userId) return
    getDoc(doc(db, 'comercios', solicitud.userId))
      .then((snap) => setComercioRequiereBolso(snap.exists() ? (snap.data()?.requiereBolso ?? false) : false))
      .catch(() => setComercioRequiereBolso(false))
  }, [solicitud?.userId])

  const tiempoRestante = useMemo(() => {
    if (!solicitud) return null

    if (solicitud.estado === 'pendiente_confirmacion') {
      const created = tsToDate(solicitud.createdAt)
      if (!created) return null
      return created.getTime() + 10 * 60 * 1000 - tick
    }

    if (solicitud.estado === 'asignada') {
      const aceptarAntesDe = solicitud.asignacion?.aceptarAntesDe
      const byField = diffToMs(aceptarAntesDe)
      if (byField !== null) return byField

      const asignadoAt = tsToDate(solicitud.asignacion?.asignadoAt)
      if (!asignadoAt) return null
      return asignadoAt.getTime() + 10 * 60 * 1000 - tick
    }

    return null
  }, [solicitud, tick])

  const rankingCalculado = useMemo<MotorizadoRankeado[]>(() => {
    if (!solicitud || motorizados.length === 0) return []
    const requiereBolso =
      solicitud.requiereBolso ??
      (comercioRequiereBolso !== null ? comercioRequiereBolso : false)
    const nuevaOrden: NuevaOrdenRanking = {
      recoleccion: { coord: (solicitud.recoleccion as any)?.coord ?? solicitud.cotizacion?.origenCoord ?? null },
      entrega: { coord: (solicitud.entrega as any)?.coord ?? solicitud.cotizacion?.destinoCoord ?? null },
      cotizacion: {
        origenCoord: solicitud.cotizacion?.origenCoord ?? null,
        destinoCoord: solicitud.cotizacion?.destinoCoord ?? null,
      },
      requiereBolso,
      zonaRetiroId: solicitud.zonaRetiroId ?? null,
      zonaEntregaId: solicitud.zonaEntregaId ?? null,
      macroZonaRetiroId: solicitud.macroZonaRetiroId ?? null,
      macroZonaEntregaId: solicitud.macroZonaEntregaId ?? null,
    }
    return rankearMotorizados(motorizados as MotorizadoConRanking[], ordenesActivas, nuevaOrden)
  }, [solicitud, motorizados, ordenesActivas, comercioRequiereBolso])

  const sem = semaforoForRemaining(tiempoRestante)

  const confirmarYAsignar = async () => {
    if (!solicitud) return
    setErr(null)

    const user = auth.currentUser
    if (!user) return setErr('No hay sesión iniciada.')
    if (precioFinal === '' || Number(precioFinal) <= 0) return setErr('Ingresá un precio final válido.')

    const m = motorizadoSel ? motorizados.find((x) => x.id === motorizadoSel) : null

    try {
      const now = new Date()
      const aceptarAntesDe = new Date(now.getTime() + 10 * 60 * 1000)

      await updateDoc(doc(db, 'solicitudes_envio', solicitud.id), {
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
                motorizadoFotoUrl: (m as any).fotoUrl || null,
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
    } catch (e) {
      console.error(e)
      setErr('No se pudo guardar la orden.')
    }
  }

  const rebotarAsignacion = async () => {
    if (!solicitud) return
    setErr(null)
    const motorizadoId = solicitud.asignacion?.motorizadoId
    try {
      const b = writeBatch(db)
      b.update(doc(db, 'solicitudes_envio', solicitud.id), {
        estado: 'confirmada',
        asignacion: null,
        updatedAt: serverTimestamp(),
      } as any)
      if (motorizadoId) {
        b.update(doc(db, 'motorizado', motorizadoId), { estado: 'disponible', updatedAt: serverTimestamp() })
      }
      await b.commit()
    } catch (e) {
      console.error(e)
      setErr('No se pudo rebotar la asignación.')
    }
  }

  const cambiarEstado = async (nuevo: EstadoSolicitud) => {
    if (!solicitud) return
    setErr(null)
    const motorizadoId = solicitud.asignacion?.motorizadoId

    try {
      const b = writeBatch(db)
      b.update(doc(db, 'solicitudes_envio', solicitud.id), {
        estado: nuevo,
        updatedAt: serverTimestamp(),
        [`historial.${nuevo}At`]: serverTimestamp(),
      } as any)

      // Sincronizar estado del motorizado
      if (motorizadoId) {
        const nuevoEstadoMoto = nuevo === 'entregado' ? 'disponible' : 'ocupado'
        b.update(doc(db, 'motorizado', motorizadoId), { estado: nuevoEstadoMoto, updatedAt: serverTimestamp() })
      }

      await b.commit()

      if (nuevo === 'entregado') {
        const celular = solicitud.entrega?.celular?.replace(/\D/g, '')
        const comercioUid = solicitud.userId
        if (celular && comercioUid) {
          await setDoc(
            doc(db, 'clientes_envio', `${comercioUid}_${celular}`),
            { totalViajes: increment(1), updatedAt: serverTimestamp() },
            { merge: true }
          )
        }
      }
    } catch (e) {
      console.error(e)
      setErr('No se pudo cambiar el estado.')
    }
  }

  const reactivarOrden = async () => {
    if (!solicitud) return
    setErr(null)
    const motorizadoId = solicitud.asignacion?.motorizadoId
    try {
      const b = writeBatch(db)
      b.update(doc(db, 'solicitudes_envio', solicitud.id), {
        estado: 'pendiente_confirmacion',
        rechazo: null,
        asignacion: null,
        updatedAt: serverTimestamp(),
      } as any)
      if (motorizadoId) {
        b.update(doc(db, 'motorizado', motorizadoId), { estado: 'disponible', updatedAt: serverTimestamp() })
      }
      await b.commit()
    } catch (e) {
      console.error(e)
      setErr('No se pudo reactivar la orden.')
    }
  }

  const rechazarSolicitud = async () => {
    if (!solicitud) return
    if (!motivoCodigo) { setErr('Debes seleccionar un motivo.'); return }
    if (motivoCodigo === 'otro' && !detalleRechazo.trim()) {
      setErr('El detalle es obligatorio cuando el motivo es "Otro".')
      return
    }
    const motorizadoId = solicitud.asignacion?.motorizadoId
    try {
      const b = writeBatch(db)
      b.update(doc(db, 'solicitudes_envio', solicitud.id), {
        estado: 'rechazada',
        rechazo: {
          motivoCodigo,
          motivoTexto,
          detalle: detalleRechazo.trim() || null,
          rechazadoPorUid: auth.currentUser?.uid || null,
          rechazadoAt: serverTimestamp(),
          visibleParaComercio: true,
        },
        asignacion: null,
        updatedAt: serverTimestamp(),
        'historial.rechazadaAt': serverTimestamp(),
      } as any)
      if (motorizadoId) {
        b.update(doc(db, 'motorizado', motorizadoId), { estado: 'disponible', updatedAt: serverTimestamp() })
      }
      await b.commit()
      setShowRechazarModal(false)
      setMotivoCodigo('')
      setMotivoTexto('')
      setDetalleRechazo('')
      setErr(null)
    } catch (e) {
      console.error(e)
      setErr('No se pudo rechazar la orden.')
    }
  }

  if (loading) {
    return (
      <div className="w-full p-4">
        <div className="rounded-2xl border border-gray-200 bg-white p-6 text-sm text-gray-600 shadow-sm">
          Cargando orden...
        </div>
      </div>
    )
  }

  if (!solicitud) {
    return (
      <div className="w-full p-4 space-y-4">
        <Link
          href="/panel/gestor/solicitudes"
          className="inline-flex items-center gap-2 text-sm text-gray-700 hover:underline"
        >
          <ArrowLeft className="h-4 w-4" />
          Volver a solicitudes
        </Link>

        <div className="rounded-2xl border border-red-200 bg-red-50 p-6 text-sm text-red-700 shadow-sm">
          {err || 'No se encontró la orden.'}
        </div>
      </div>
    )
  }

  const retiroMaps = getBestMapsUrl(solicitud, 'recoleccion')
  const entregaMaps = getBestMapsUrl(solicitud, 'entrega')

  const estado = solicitud.estado
  const estadoAceptacion = solicitud.asignacion?.estadoAceptacion

  const timeline = [
    {
      title: 'Creada',
      done: true,
      current: false,
      subtitle: formatDateTime(solicitud.createdAt),
    },
    {
      title: 'Confirmada',
      done: ['confirmada', 'asignada', 'en_camino_retiro', 'retirado', 'en_camino_entrega', 'entregado'].includes(estado),
      current: estado === 'pendiente_confirmacion',
      subtitle: solicitud.confirmacion?.confirmadoAt ? formatDateTime(solicitud.confirmacion.confirmadoAt) : undefined,
    },
    {
      title: 'Asignada',
      done: ['asignada', 'en_camino_retiro', 'retirado', 'en_camino_entrega', 'entregado'].includes(estado),
      current: estado === 'confirmada',
      subtitle: solicitud.asignacion?.asignadoAt ? formatDateTime(solicitud.asignacion.asignadoAt) : undefined,
    },
    {
      title: 'Aceptada por motorizado',
      done: ['en_camino_retiro', 'retirado', 'en_camino_entrega', 'entregado'].includes(estado) || estadoAceptacion === 'aceptada',
      current: estado === 'asignada',
      subtitle: solicitud.asignacion?.aceptadoAt ? formatDateTime(solicitud.asignacion.aceptadoAt) : aceptacionLabel(estadoAceptacion),
    },
    {
      title: 'Retiro en proceso',
      done: ['retirado', 'en_camino_entrega', 'entregado'].includes(estado),
      current: estado === 'en_camino_retiro',
      subtitle: solicitud.historial?.en_camino_retiroAt ? formatDateTime(solicitud.historial.en_camino_retiroAt) : undefined,
    },
    {
      title: 'Paquete retirado',
      done: ['retirado', 'en_camino_entrega', 'entregado'].includes(estado),
      current: estado === 'retirado',
      subtitle: solicitud.historial?.retiradoAt ? formatDateTime(solicitud.historial.retiradoAt) : undefined,
    },
    {
      title: 'En camino a entrega',
      done: ['entregado'].includes(estado),
      current: estado === 'en_camino_entrega',
      subtitle: solicitud.historial?.en_camino_entregaAt ? formatDateTime(solicitud.historial.en_camino_entregaAt) : undefined,
    },
    {
      title: 'Entregado',
      done: estado === 'entregado',
      current: false,
      subtitle: solicitud.historial?.entregadoAt ? formatDateTime(solicitud.historial.entregadoAt) : (solicitud as any).entregadoAt ? formatDateTime((solicitud as any).entregadoAt) : undefined,
    },
  ]

  return (
    <>
    <div className="w-full p-4 space-y-5">
      <div className="flex flex-col xl:flex-row xl:items-start xl:justify-between gap-4">
        <div className="space-y-2">
          <Link
            href="/panel/gestor/solicitudes"
            className="inline-flex items-center gap-2 text-sm text-gray-700 hover:underline"
          >
            <ArrowLeft className="h-4 w-4" />
            Volver a solicitudes
          </Link>

          <div>
            <h1 className="text-3xl font-bold text-gray-900">Orden {solicitud.id}</h1>
            <div className="flex flex-wrap items-center gap-2 mt-2">
              <span className={`inline-flex rounded-full border px-2.5 py-1 text-xs font-medium ${estadoClass(solicitud.estado)}`}>
                {statusLabel(solicitud.estado)}
              </span>

              {solicitud.estado === 'asignada' && (
                <span className={`inline-flex rounded-full border px-2.5 py-1 text-xs font-medium ${aceptacionClass(solicitud.asignacion?.estadoAceptacion)}`}>
                  {aceptacionLabel(solicitud.asignacion?.estadoAceptacion)}
                </span>
              )}

              {typeof tiempoRestante === 'number' && (
                <span className={`inline-flex rounded-full border px-2.5 py-1 text-xs font-medium ${sem.className}`}>
                  <Clock3 className="mr-1 h-3.5 w-3.5" />
                  {formatMMSS(tiempoRestante)} · {sem.label}
                </span>
              )}
            </div>
          </div>
        </div>

        <div className="flex flex-wrap gap-2">
          <button
            onClick={() => copyToClipboard(solicitud.id)}
            className="rounded-lg border border-gray-200 bg-white px-3 py-2 text-sm font-medium text-gray-700 hover:bg-gray-50"
          >
            Copiar ID
          </button>

          <button
            onClick={() => copyToClipboard(JSON.stringify(solicitud, null, 2))}
            className="rounded-lg border border-gray-200 bg-white px-3 py-2 text-sm font-medium text-gray-700 hover:bg-gray-50"
          >
            Copiar JSON
          </button>
        </div>
      </div>

      {err && (
        <div className="rounded-xl border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700">
          {err}
        </div>
      )}

      <div className="grid grid-cols-1 2xl:grid-cols-[1.35fr_0.95fr] gap-5">
        <section className="space-y-5">
          <div className="rounded-2xl border border-gray-200 bg-white p-5 shadow-sm">
            <div className="flex items-center gap-2 mb-4">
              <Package className="h-4 w-4 text-gray-500" />
              <h2 className="font-semibold text-gray-900">Timeline operativo</h2>
            </div>

            <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-4 gap-4">
              {timeline.map((item) => (
                <TimelineStep
                  key={item.title}
                  title={item.title}
                  done={item.done}
                  current={item.current}
                  subtitle={item.subtitle}
                />
              ))}
            </div>
          </div>

          <MapaOrden
            retiro={solicitud.cotizacion?.origenCoord ?? (solicitud.recoleccion as any)?.coord ?? null}
            entrega={
              solicitud.tipoServicio === 'fuera_managua'
                ? solicitud.fueraManagua?.coordsPuntoLogistico ?? solicitud.cotizacion?.destinoCoord ?? null
                : solicitud.cotizacion?.destinoCoord ?? (solicitud.entrega as any)?.coord ?? null
            }
          />

          <div className="grid grid-cols-1 xl:grid-cols-2 gap-5">
            <div className="rounded-2xl border border-gray-200 bg-white p-5 shadow-sm">
              <div className="flex items-center gap-2 mb-4">
                <User className="h-4 w-4 text-gray-500" />
                <h2 className="font-semibold text-gray-900">Retiro</h2>
              </div>

              <div className="space-y-3 text-sm">
                <div>
                  <div className="text-gray-500">Nombre</div>
                  <div className="font-medium text-gray-900">{solicitud.recoleccion.nombreApellido || '—'}</div>
                </div>

                <div>
                  <div className="text-gray-500">Teléfono</div>
                  <div className="font-medium text-gray-900 flex items-center gap-2">
                    <Phone className="h-4 w-4 text-gray-400" />
                    {solicitud.recoleccion.celular}
                  </div>
                </div>

                <div>
                  <div className="text-gray-500">Dirección</div>
                  <div className="font-medium text-gray-900 flex items-start gap-2">
                    <MapPin className="h-4 w-4 text-gray-400 mt-0.5" />
                    <span>{solicitud.recoleccion.direccionEscrita}</span>
                  </div>
                </div>

                <div>
                  <div className="text-gray-500">Tipo punto</div>
                  <div className="font-medium text-gray-900">{solicitud.recoleccion.puntoGoogleTipo || '—'}</div>
                </div>

                <div className="flex flex-wrap gap-2 pt-1">
                  {retiroMaps && (
                    <a
                      href={retiroMaps}
                      target="_blank"
                      rel="noreferrer"
                      className="inline-flex items-center gap-2 rounded-lg border border-gray-200 px-3 py-2 text-sm text-blue-700 hover:bg-gray-50"
                    >
                      <ExternalLink className="h-4 w-4" />
                      Abrir Maps
                    </a>
                  )}
                  {retiroMaps && (
                    <button
                      onClick={() => copyToClipboard(retiroMaps)}
                      className="inline-flex items-center gap-2 rounded-lg border border-gray-200 px-3 py-2 text-sm text-gray-700 hover:bg-gray-50"
                    >
                      <Copy className="h-4 w-4" />
                      Copiar link
                    </button>
                  )}
                </div>
              </div>
            </div>

            <div className="rounded-2xl border border-gray-200 bg-white p-5 shadow-sm">
              <div className="flex items-center gap-2 mb-4">
                <User className="h-4 w-4 text-gray-500" />
                <h2 className="font-semibold text-gray-900">
                  {solicitud.tipoServicio === 'fuera_managua'
                    ? (solicitud.fueraManagua?.metodoEnvio === 'cargotrans' ? '📦 Entrega — Sucursal Cargotrans' : '🚌 Entrega — Bus / Terminal')
                    : 'Entrega'}
                </h2>
              </div>

              {solicitud.tipoServicio === 'fuera_managua' && solicitud.fueraManagua ? (
                <div className="space-y-3 text-sm">
                  <div>
                    <div className="text-gray-500">{solicitud.fueraManagua.metodoEnvio === 'cargotrans' ? 'Sucursal Cargotrans' : 'Terminal / Bus'}</div>
                    <div className="font-medium text-gray-900">{solicitud.fueraManagua.puntoLogisticoNombre || solicitud.fueraManagua.terminalSugerida || '—'}</div>
                  </div>

                  {solicitud.fueraManagua.destinoFinal && (
                    <div>
                      <div className="text-gray-500">Destino final</div>
                      <div className="font-medium text-violet-700">{solicitud.fueraManagua.destinoFinal}</div>
                    </div>
                  )}

                  {solicitud.fueraManagua.direccionPuntoLogistico && (
                    <div>
                      <div className="text-gray-500">Dirección</div>
                      <div className="font-medium text-gray-900 flex items-start gap-2">
                        <MapPin className="h-4 w-4 text-gray-400 mt-0.5" />
                        <span>{solicitud.fueraManagua.direccionPuntoLogistico}</span>
                      </div>
                    </div>
                  )}

                  {(solicitud.fueraManagua.horarioApertura || solicitud.fueraManagua.horarioCierre) && (
                    <div>
                      <div className="text-gray-500">Horario</div>
                      <div className="font-medium text-gray-900">
                        {solicitud.fueraManagua.horarioApertura || '?'}–{solicitud.fueraManagua.horarioCierre || '?'}
                      </div>
                    </div>
                  )}

                  {solicitud.fueraManagua.metodoEnvio === 'bus_terminal' && solicitud.fueraManagua.transporteNombre && (
                    <div>
                      <div className="text-gray-500">Transporte</div>
                      <div className="font-medium text-gray-900">{solicitud.fueraManagua.transporteNombre}</div>
                    </div>
                  )}

                  {solicitud.fueraManagua.metodoEnvio === 'bus_terminal' && solicitud.fueraManagua.transporteCelular && (
                    <div>
                      <div className="text-gray-500">Celular transporte</div>
                      <div className="font-medium text-gray-900 flex items-center gap-2">
                        <Phone className="h-4 w-4 text-gray-400" />
                        {solicitud.fueraManagua.transporteCelular}
                      </div>
                    </div>
                  )}

                  {solicitud.fueraManagua.metodoEnvio === 'bus_terminal' && solicitud.fueraManagua.transporteHoraSalida && (
                    <div>
                      <div className="text-gray-500">Hora de salida</div>
                      <div className="font-medium text-gray-900">{solicitud.fueraManagua.transporteHoraSalida}</div>
                    </div>
                  )}

                  {solicitud.fueraManagua.metodoEnvio === 'cargotrans' && solicitud.fueraManagua.cantidadPaquetes != null && (
                    <div>
                      <div className="text-gray-500">Cantidad de paquetes</div>
                      <div className="font-medium text-violet-700">📦 {solicitud.fueraManagua.cantidadPaquetes} paquete(s)</div>
                    </div>
                  )}

                  {solicitud.fueraManagua.metodoEnvio === 'cargotrans' && solicitud.fueraManagua.pagoCargotrans && (
                    <div>
                      <div className="text-gray-500">Pago flete Cargotrans</div>
                      <div className="font-medium text-gray-900">
                        {solicitud.fueraManagua.pagoCargotrans === 'efectivo_motorizado' ? '💵 Efectivo (motorizado adelanta)' : '🏦 Transferencia del comercio'}
                      </div>
                    </div>
                  )}

                  {solicitud.fueraManagua.metodoEnvio === 'cargotrans' && solicitud.fueraManagua.notaCargotrans && (
                    <div>
                      <div className="text-gray-500">Nota Cargotrans</div>
                      <div className="font-medium text-gray-900">{solicitud.fueraManagua.notaCargotrans}</div>
                    </div>
                  )}

                  {solicitud.fueraManagua.metodoEnvio === 'cargotrans' && (solicitud as any).evidenciasCargotrans?.costoCargotrans != null && (
                    <div>
                      <div className="text-gray-500">Costo pagado en Cargotrans</div>
                      <div className="font-medium text-violet-700">C$ {(solicitud as any).evidenciasCargotrans.costoCargotrans}</div>
                    </div>
                  )}

                  {solicitud.fueraManagua.coordsPuntoLogistico && (
                    <div className="flex flex-wrap gap-2 pt-1">
                      <a
                        href={`https://www.google.com/maps?q=${solicitud.fueraManagua.coordsPuntoLogistico.lat},${solicitud.fueraManagua.coordsPuntoLogistico.lng}`}
                        target="_blank"
                        rel="noreferrer"
                        className="inline-flex items-center gap-2 rounded-lg border border-gray-200 px-3 py-2 text-sm text-blue-700 hover:bg-gray-50"
                      >
                        <ExternalLink className="h-4 w-4" />
                        Abrir Maps
                      </a>
                    </div>
                  )}
                </div>
              ) : (
                <div className="space-y-3 text-sm">
                  <div>
                    <div className="text-gray-500">Nombre</div>
                    <div className="font-medium text-gray-900">{solicitud.entrega.nombreApellido || '—'}</div>
                  </div>

                  <div>
                    <div className="text-gray-500">Teléfono</div>
                    <div className="font-medium text-gray-900 flex items-center gap-2">
                      <Phone className="h-4 w-4 text-gray-400" />
                      {solicitud.entrega.celular}
                    </div>
                  </div>

                  <div>
                    <div className="text-gray-500">Dirección</div>
                    <div className="font-medium text-gray-900 flex items-start gap-2">
                      <MapPin className="h-4 w-4 text-gray-400 mt-0.5" />
                      <span>{solicitud.entrega.direccionEscrita}</span>
                    </div>
                  </div>

                  <div>
                    <div className="text-gray-500">Tipo punto</div>
                    <div className="font-medium text-gray-900">{solicitud.entrega.puntoGoogleTipo || '—'}</div>
                  </div>

                  <div className="flex flex-wrap gap-2 pt-1">
                    {entregaMaps && (
                      <a
                        href={entregaMaps}
                        target="_blank"
                        rel="noreferrer"
                        className="inline-flex items-center gap-2 rounded-lg border border-gray-200 px-3 py-2 text-sm text-blue-700 hover:bg-gray-50"
                      >
                        <ExternalLink className="h-4 w-4" />
                        Abrir Maps
                      </a>
                    )}
                    {entregaMaps && (
                      <button
                        onClick={() => copyToClipboard(entregaMaps)}
                        className="inline-flex items-center gap-2 rounded-lg border border-gray-200 px-3 py-2 text-sm text-gray-700 hover:bg-gray-50"
                      >
                        <Copy className="h-4 w-4" />
                        Copiar link
                      </button>
                    )}
                  </div>
                </div>
              )}
            </div>
          </div>

          <div className="rounded-2xl border border-gray-200 bg-white p-5 shadow-sm">
            <h2 className="font-semibold text-gray-900 mb-4">Resumen comercial</h2>

            <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-4 gap-4 text-sm">
              <div>
                <div className="text-gray-500">Tipo cliente</div>
                <div className="font-medium text-gray-900">{solicitud.tipoCliente}</div>
              </div>

              <div>
                <div className="text-gray-500">Cotización</div>
                <div className="font-medium text-gray-900">{solicitud.tieneCotizacion ? 'Sí' : 'No'}</div>
              </div>

              <div>
                <div className="text-gray-500">Distancia</div>
                <div className="font-medium text-gray-900">
                  {typeof solicitud?.cotizacion?.distanciaKm === 'number'
                    ? `${solicitud.cotizacion.distanciaKm} km`
                    : '—'}
                </div>
              </div>

              <div>
                <div className="text-gray-500">Delivery sugerido</div>
                <div className="font-medium text-gray-900">
                  {typeof solicitud?.cotizacion?.precioSugerido === 'number'
                    ? money(solicitud.cotizacion.precioSugerido)
                    : typeof (solicitud as any)?.pagoDelivery?.montoSugerido === 'number'
                    ? money((solicitud as any).pagoDelivery.montoSugerido)
                    : '—'}
                </div>
              </div>

              <div>
                <div className="text-gray-500">Precio final</div>
                <div className="font-medium text-gray-900">
                  {typeof solicitud.confirmacion?.precioFinalCordobas === 'number'
                    ? money(solicitud.confirmacion.precioFinalCordobas)
                    : '—'}
                </div>
              </div>

              <div>
                <div className="text-gray-500">Cobro contra entrega</div>
                <div className="font-medium text-gray-900">
                  {solicitud.cobroContraEntrega?.aplica
                    ? money(solicitud.cobroContraEntrega.monto)
                    : 'No aplica'}
                </div>
              </div>

              <div>
                <div className="text-gray-500">Quién paga delivery</div>
                <div className="font-medium text-gray-900">
                  {solicitud.tipoCliente === 'credito'
                    ? 'Crédito semanal'
                    : (solicitud.pagoDelivery as any)?.quienPaga || '—'}
                </div>
              </div>

              <div>
                <div className="text-gray-500">Creada</div>
                <div className="font-medium text-gray-900">{formatDateTime(solicitud.createdAt)}</div>
              </div>
            </div>

            {solicitud.detalle?.trim() && (
              <div className="mt-4 rounded-xl border border-gray-200 bg-gray-50 p-4 text-sm">
                <div className="text-gray-500 mb-1">Detalle adicional</div>
                <div className="text-gray-900 whitespace-pre-wrap">{solicitud.detalle.trim()}</div>
              </div>
            )}
          </div>
        </section>

        <aside className="space-y-5">

          {/* Motorizado sugerido — solo en estados relevantes */}
          {(estado === 'pendiente_confirmacion' || estado === 'confirmada') && rankingCalculado.length > 0 && (
            <div className="rounded-2xl border border-indigo-200 bg-indigo-50 p-5 shadow-sm">
              <div className="flex items-center gap-2 mb-3">
                <Star className="h-4 w-4 text-indigo-500" />
                <h2 className="font-semibold text-indigo-900">Motorizado sugerido</h2>
              </div>
              {(() => {
                const top = rankingCalculado[0]
                return (
                  <div className="space-y-2.5">
                    <div className="flex items-center justify-between">
                      <div className="flex items-center gap-2 min-w-0">
                        <span className="text-sm font-bold text-indigo-900 truncate">{top.nombre}</span>
                        {top.telefono && (
                          <span className="text-xs text-indigo-400 shrink-0">{top.telefono}</span>
                        )}
                      </div>
                      <span className="text-xs font-black text-indigo-700 bg-indigo-100 border border-indigo-200 rounded-full px-2.5 py-0.5 shrink-0 ml-2">
                        {top.scoreResult.score} pts
                      </span>
                    </div>
                    <p className="text-xs text-indigo-700 leading-relaxed">{top.scoreResult.explicacion}</p>
                    <button
                      onClick={() => setMotorizadoSel(top.id)}
                      className="w-full inline-flex items-center justify-center gap-2 rounded-xl bg-indigo-600 px-3 py-2 text-sm font-semibold text-white hover:bg-indigo-700 transition"
                    >
                      <Bike className="h-4 w-4" /> Asignar sugerido
                    </button>
                  </div>
                )
              })()}
            </div>
          )}

          {/* Decisión rápida — oculta para estados terminales */}
          {estado !== 'rechazada' && estado !== 'cancelada' && estado !== 'entregado' && (
          <div className="rounded-2xl border border-gray-200 bg-white p-5 shadow-sm">
            <h2 className="font-semibold text-gray-900 mb-4">
              Decisión rápida
            </h2>

            <div className="space-y-4">
              <div>
                <label className="block text-xs font-bold uppercase tracking-wide text-gray-400 mb-1.5">Precio final (C$)</label>
                <input
                  type="number"
                  step={10}
                  value={precioFinal}
                  onChange={(e) => {
                    const v = e.target.value === '' ? '' : Number(e.target.value)
                    setPrecioFinal(v === '' ? '' : Number(roundTo10(v)))
                  }}
                  className="w-full rounded-lg border border-gray-200 px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-blue-200 focus:border-blue-300"
                  placeholder="Ej: 130"
                />
                <div className="text-[10px] text-gray-400 mt-1">Se redondea a múltiplos de 10</div>
              </div>

              <div>
                <label className="block text-xs font-bold uppercase tracking-wide text-gray-400 mb-1.5">
                  Motorizado
                  {loadingOrdenes && (
                    <span className="ml-1 text-gray-300 font-normal normal-case">(calculando scores…)</span>
                  )}
                </label>

                {/* Opción "No asignar" */}
                <button
                  onClick={() => setMotorizadoSel('')}
                  className={`w-full flex items-center gap-3 px-3 py-2.5 rounded-xl border mb-2 text-left transition ${
                    motorizadoSel === ''
                      ? 'border-gray-400 bg-gray-100 ring-1 ring-gray-300'
                      : 'border-gray-200 bg-white hover:bg-gray-50'
                  }`}
                >
                  <span className="text-xs font-semibold text-gray-500 italic">— No asignar todavía —</span>
                </button>

                {/* Lista rankeada de candidatos */}
                <div className="space-y-1.5 max-h-[300px] overflow-y-auto pr-0.5">
                  {(() => {
                    const scoreMap = new Map(rankingCalculado.map((r) => [r.id, r.scoreResult]))
                    const ordenMostrar = rankingCalculado.length > 0 ? rankingCalculado : motorizados
                    return ordenMostrar.map((m, idx) => {
                      const sr = scoreMap.get(m.id)
                      const esSeleccionado = motorizadoSel === m.id
                      const esMejor = idx === 0 && rankingCalculado.length > 0
                      return (
                        <button
                          key={m.id}
                          onClick={() => setMotorizadoSel(m.id)}
                          className={`w-full flex items-center gap-3 px-3 py-2.5 rounded-xl border text-left transition ${
                            esSeleccionado
                              ? 'border-indigo-400 bg-indigo-50 ring-1 ring-indigo-300'
                              : 'border-gray-200 bg-white hover:bg-gray-50'
                          }`}
                        >
                          <span className={`shrink-0 inline-flex items-center gap-1 text-[10px] font-bold px-2 py-1 rounded-full border ${
                            m.estado === 'disponible'
                              ? 'bg-green-50 text-green-700 border-green-200'
                              : 'bg-yellow-50 text-yellow-700 border-yellow-200'
                          }`}>
                            <span className={`w-1.5 h-1.5 rounded-full ${m.estado === 'disponible' ? 'bg-green-500' : 'bg-yellow-500'}`} />
                            {m.estado === 'disponible' ? 'Disp.' : (m.estado || 'Ocup.')}
                          </span>

                          <div className="flex-1 min-w-0">
                            <div className="flex items-center gap-1.5 min-w-0">
                              {esMejor && <Star className="h-2.5 w-2.5 text-amber-500 shrink-0" />}
                              <span className="text-xs font-bold text-gray-900 truncate">{m.nombre}</span>
                              {m.telefono && <span className="text-[10px] text-gray-400 shrink-0">{m.telefono}</span>}
                            </div>
                            {sr?.explicacion && (
                              <p className="text-[10px] text-gray-500 mt-0.5 leading-snug truncate">{sr.explicacion}</p>
                            )}
                          </div>

                          {sr !== undefined && (
                            <span className={`shrink-0 text-xs font-black px-2 py-1 rounded-full border ${
                              sr.score >= 70 ? 'bg-green-50 text-green-700 border-green-200'
                              : sr.score >= 40 ? 'bg-yellow-50 text-yellow-700 border-yellow-200'
                              : 'bg-red-50 text-red-600 border-red-200'
                            }`}>
                              {sr.score}
                            </span>
                          )}
                        </button>
                      )
                    })
                  })()}
                </div>

                {rankingCalculado.length > 0 && (
                  <div className="text-[10px] text-gray-400 mt-1.5">
                    Ordenados por score · 100 = ideal · {rankingCalculado.length} candidatos
                  </div>
                )}
              </div>

              <div className="space-y-2 pt-1">
                <button
                  onClick={confirmarYAsignar}
                  className="w-full inline-flex items-center justify-center gap-2 rounded-xl bg-[#004aad] px-4 py-2.5 text-sm font-semibold text-white hover:bg-[#003d94] transition shadow-sm"
                >
                  <CheckCircle2 className="h-4 w-4" /> Guardar confirmación / asignación
                </button>

                {estado === 'pendiente_confirmacion' && (
                  <button
                    onClick={() => { setShowRechazarModal(true); setErr(null) }}
                    className="w-full inline-flex items-center justify-center gap-2 rounded-xl border border-red-200 bg-red-50 px-4 py-2.5 text-sm font-semibold text-red-700 hover:bg-red-100 transition"
                  >
                    <XCircle className="h-4 w-4" /> Rechazar orden
                  </button>
                )}

                {estado === 'confirmada' && (
                  <button
                    onClick={() => cambiarEstado('cancelada')}
                    className="w-full inline-flex items-center justify-center gap-2 rounded-xl border border-gray-200 bg-white px-4 py-2.5 text-sm font-semibold text-gray-700 hover:bg-gray-50 transition"
                  >
                    <AlertTriangle className="h-4 w-4" /> Cancelar
                  </button>
                )}

                {estado === 'asignada' && (
                  <button
                    onClick={rebotarAsignacion}
                    className="w-full inline-flex items-center justify-center gap-2 rounded-xl border border-gray-200 bg-white px-4 py-2.5 text-sm font-semibold text-gray-700 hover:bg-gray-50 transition"
                  >
                    <RotateCcw className="h-4 w-4" /> Rebotar a confirmada
                  </button>
                )}

                {estado === 'en_camino_retiro' && (
                  <button
                    onClick={() => cambiarEstado('retirado')}
                    className="w-full inline-flex items-center justify-center gap-2 rounded-xl border border-gray-200 bg-white px-4 py-2.5 text-sm font-semibold text-gray-700 hover:bg-gray-50 transition"
                  >
                    <Package className="h-4 w-4" /> Marcar retirado
                  </button>
                )}

                {estado === 'retirado' && (
                  <button
                    onClick={() => cambiarEstado('en_camino_entrega')}
                    className="w-full inline-flex items-center justify-center gap-2 rounded-xl border border-gray-200 bg-white px-4 py-2.5 text-sm font-semibold text-gray-700 hover:bg-gray-50 transition"
                  >
                    <Truck className="h-4 w-4" /> Pasar a entrega
                  </button>
                )}

                {estado === 'en_camino_entrega' && (
                  <button
                    onClick={() => cambiarEstado('entregado')}
                    className="w-full inline-flex items-center justify-center gap-2 rounded-xl border border-green-200 bg-green-50 px-4 py-2.5 text-sm font-semibold text-green-700 hover:bg-green-100 transition"
                  >
                    <CheckCheck className="h-4 w-4" /> Marcar entregado
                  </button>
                )}

                {err && (
                  <div className="rounded-xl border border-red-200 bg-red-50 px-3 py-2 text-xs text-red-700">{err}</div>
                )}
              </div>
            </div>
          </div>
          )}

          {/* Reactivar — solo para estados terminales recuperables */}
          {(estado === 'rechazada' || estado === 'cancelada') && (
            <div className="rounded-2xl border border-gray-200 bg-white p-5 shadow-sm">
              <h2 className="font-semibold text-gray-900 mb-3">Acciones</h2>
              <p className="text-xs text-gray-500 mb-3">
                {estado === 'rechazada'
                  ? 'Esta orden fue rechazada. Puedes reactivarla para volver a evaluarla.'
                  : 'Esta orden fue cancelada. Puedes reactivarla para volver a procesarla.'}
              </p>
              <button
                onClick={reactivarOrden}
                className="w-full inline-flex items-center justify-center gap-2 rounded-xl border border-amber-200 bg-amber-50 px-4 py-2.5 text-sm font-semibold text-amber-700 hover:bg-amber-100 transition"
              >
                <RotateCcw className="h-4 w-4" /> Reactivar orden
              </button>
              {err && (
                <div className="mt-2 rounded-xl border border-red-200 bg-red-50 px-3 py-2 text-xs text-red-700">{err}</div>
              )}
            </div>
          )}

          {/* Asignación actual */}
          <div className="rounded-2xl border border-gray-200 bg-white p-5 shadow-sm">
            <h2 className="font-semibold text-gray-900 mb-4">Asignación actual</h2>

            {solicitud.asignacion?.motorizadoNombre ? (
              <div className="space-y-3 text-sm">
                <div className="flex items-center gap-3">
                  <div className="w-10 h-10 rounded-full bg-indigo-100 grid place-items-center flex-shrink-0 overflow-hidden border border-indigo-200">
                    {solicitud.asignacion.motorizadoFotoUrl ? (
                      // eslint-disable-next-line @next/next/no-img-element
                      <img
                        src={solicitud.asignacion.motorizadoFotoUrl}
                        alt={solicitud.asignacion.motorizadoNombre}
                        className="w-full h-full object-cover"
                      />
                    ) : (
                      <Bike className="h-4 w-4 text-indigo-500" />
                    )}
                  </div>
                  <div>
                    <div className="font-semibold text-gray-900">{solicitud.asignacion.motorizadoNombre}</div>
                    <div className="text-xs text-gray-500">{solicitud.asignacion.motorizadoTelefono || '—'}</div>
                  </div>
                </div>

                <div>
                  <div className="text-gray-500">Teléfono</div>
                  <div className="font-medium text-gray-900">{solicitud.asignacion.motorizadoTelefono || '—'}</div>
                </div>

                <div>
                  <div className="text-gray-500">Asignado</div>
                  <div className="font-medium text-gray-900">{formatDateTime(solicitud.asignacion.asignadoAt)}</div>
                </div>

                <div>
                  <div className="text-gray-500">Aceptación</div>
                  <span className={`inline-flex rounded-full border px-2.5 py-1 text-xs font-medium ${aceptacionClass(solicitud.asignacion.estadoAceptacion)}`}>
                    {aceptacionLabel(solicitud.asignacion.estadoAceptacion)}
                  </span>
                </div>

                {solicitud.asignacion?.motivoRechazo && (
                  <div>
                    <div className="text-gray-500">Motivo rechazo</div>
                    <div className="font-medium text-gray-900">{solicitud.asignacion.motivoRechazo}</div>
                  </div>
                )}
              </div>
            ) : (
              <div className="text-sm text-gray-500">Todavía no hay motorizado asignado.</div>
            )}
          </div>

          {/* Tarjeta de rechazo */}
          {estado === 'rechazada' && solicitud.rechazo && (
            <div className="rounded-2xl border border-red-200 bg-red-50 p-5 shadow-sm">
              <h2 className="font-semibold text-red-800 mb-3">Rechazo</h2>
              <div className="space-y-1.5 text-sm">
                <div className="font-semibold text-red-700">Orden rechazada</div>
                {solicitud.rechazo.motivoTexto && (
                  <div className="text-red-600">Motivo: {solicitud.rechazo.motivoTexto}</div>
                )}
                {solicitud.rechazo.detalle && (
                  <div className="text-red-600">Detalle: {solicitud.rechazo.detalle}</div>
                )}
                {solicitud.rechazo.rechazadoAt && (
                  <div className="text-xs text-red-400">{formatDateTime(solicitud.rechazo.rechazadoAt)}</div>
                )}
              </div>
            </div>
          )}

          {/* Depósito */}
          {(() => {
            const dep = solicitud.registro?.deposito
            if (!dep) return null
            // Fuente de verdad: storkhubDepositoId / comercioDepositoId + confirmadoStorkhub / confirmadoComercio.
            const tieneInfo = dep.confirmadoComercio || dep.confirmadoStorkhub
              || dep.storkhubDepositoId || dep.comercioDepositoId
            if (!tieneInfo) return null
            return (
              <div className="rounded-2xl border border-teal-200 bg-white p-5 shadow-sm">
                <h2 className="font-semibold text-teal-700 mb-4">Depósito</h2>
                <div className="grid grid-cols-2 gap-3 text-sm">
                  {dep.confirmadoStorkhub && (
                    <>
                      <div>
                        <div className="text-gray-500">Storkhub</div>
                        <div className="font-medium text-green-700">✓ Confirmado</div>
                      </div>
                      <div>
                        <div className="text-gray-500">Fecha</div>
                        <div className="font-medium text-gray-900">{formatDateTime(dep.confirmadoStorkhubAt)}</div>
                      </div>
                    </>
                  )}
                  {!dep.confirmadoStorkhub && dep.storkhubDepositoId && (
                    <div>
                      <div className="text-gray-500">Storkhub</div>
                      <div className="font-medium text-blue-600">⏳ En revisión</div>
                    </div>
                  )}
                  {dep.confirmadoComercio && (
                    <>
                      <div>
                        <div className="text-gray-500">Comercio</div>
                        <div className="font-medium text-green-700">✓ Confirmado</div>
                      </div>
                      <div>
                        <div className="text-gray-500">Fecha</div>
                        <div className="font-medium text-gray-900">{formatDateTime(dep.confirmadoComercioAt)}</div>
                      </div>
                    </>
                  )}
                  {!dep.confirmadoComercio && dep.comercioDepositoId && (
                    <div>
                      <div className="text-gray-500">Comercio</div>
                      <div className="font-medium text-blue-600">⏳ En revisión</div>
                    </div>
                  )}
                </div>
              </div>
            )
          })()}

          {/* Evidencias fotográficas */}
          {solicitud.evidencias && (['retiro', 'entrega', 'deposito'] as const).some((k) => solicitud.evidencias?.[k]) && (
            <div className="rounded-2xl border border-gray-200 bg-white p-5 shadow-sm">
              <h2 className="font-semibold text-gray-900 mb-4">Evidencias fotográficas</h2>
              <div className="grid grid-cols-3 gap-3">
                {([
                  { key: 'retiro', label: '📦 Retiro' },
                  { key: 'entrega', label: '✅ Entrega' },
                  { key: 'deposito', label: '🏦 Boucher' },
                ] as const).map(({ key, label }) => {
                  const ev = solicitud.evidencias?.[key]
                  if (!ev) return null
                  return (
                    <button
                      key={key}
                      onClick={() => window.open(ev.url, '_blank')}
                      className="flex flex-col items-center gap-1.5 rounded-xl border border-gray-200 bg-gray-50 p-2 hover:bg-gray-100 hover:border-gray-300 transition cursor-pointer"
                    >
                      {/* eslint-disable-next-line @next/next/no-img-element */}
                      <img
                        src={ev.url}
                        alt={label}
                        className="w-full aspect-square object-cover rounded-lg"
                        loading="lazy"
                      />
                      <span className="text-xs text-gray-500 font-medium">{label}</span>
                    </button>
                  )
                })}
              </div>
            </div>
          )}

          {/* Evidencias Cargotrans */}
          {(solicitud as any).evidenciasCargotrans && (
            <div className="rounded-2xl border border-violet-200 bg-white p-5 shadow-sm">
              <h2 className="font-semibold text-violet-800 mb-4">📸 Evidencias entrega Cargotrans</h2>
              <div className="space-y-4">
                {((solicitud as any).evidenciasCargotrans.fotos ?? []).length > 0 && (
                  <div>
                    <div className="text-xs font-semibold text-gray-500 uppercase tracking-wide mb-2">
                      Paquetes ({(solicitud as any).evidenciasCargotrans.fotos.length})
                    </div>
                    <div className="grid grid-cols-3 gap-3">
                      {(solicitud as any).evidenciasCargotrans.fotos.map((f: { url: string }, i: number) => (
                        <button
                          key={i}
                          onClick={() => window.open(f.url, '_blank')}
                          className="flex flex-col items-center gap-1.5 rounded-xl border border-violet-200 bg-violet-50 p-2 hover:bg-violet-100 transition cursor-pointer"
                        >
                          {/* eslint-disable-next-line @next/next/no-img-element */}
                          <img src={f.url} alt={`Paquete ${i + 1}`} className="w-full aspect-square object-cover rounded-lg" loading="lazy" />
                          <span className="text-xs text-violet-600 font-medium">📦 #{i + 1}</span>
                        </button>
                      ))}
                    </div>
                  </div>
                )}
                {(solicitud as any).evidenciasCargotrans.factura && (
                  <button
                    onClick={() => window.open((solicitud as any).evidenciasCargotrans.factura.url, '_blank')}
                    className="inline-flex items-center gap-2 text-sm text-indigo-700 font-semibold underline"
                  >
                    🧾 Ver factura
                  </button>
                )}
                {(solicitud as any).evidenciasCargotrans.costoCargotrans != null && (
                  <div className="flex items-center gap-2 text-sm">
                    <span className="text-gray-500">Costo pagado en Cargotrans:</span>
                    <span className="font-bold text-violet-700">C$ {(solicitud as any).evidenciasCargotrans.costoCargotrans}</span>
                  </div>
                )}
              </div>
            </div>
          )}

          {/* Atajos */}
          <div className="rounded-2xl border border-gray-200 bg-white p-5 shadow-sm">
            <h2 className="font-semibold text-gray-900 mb-4">Atajos</h2>

            <div className="grid grid-cols-1 gap-2">
              <button
                onClick={() => copyToClipboard(solicitud.id)}
                className="rounded-lg border border-gray-200 px-3 py-2 text-sm text-gray-700 hover:bg-gray-50"
              >
                Copiar ID
              </button>

              <button
                onClick={() => copyToClipboard(buildCopyRetiroEntrega(solicitud))}
                className="rounded-lg border border-gray-200 px-3 py-2 text-sm text-gray-700 hover:bg-gray-50"
              >
                Copiar retiro / entrega
              </button>

              <button
                onClick={() => copyToClipboard(buildCopyTelegramFull(solicitud))}
                className="rounded-lg border border-gray-200 px-3 py-2 text-sm text-gray-700 hover:bg-gray-50"
              >
                Copiar para Telegram
              </button>

              <button
                onClick={() => router.push('/panel/gestor/solicitudes')}
                className="rounded-lg border border-gray-200 px-3 py-2 text-sm text-gray-700 hover:bg-gray-50"
              >
                Volver al listado
              </button>
            </div>
          </div>
        </aside>
      </div>
    </div>

    {/* Modal de rechazo */}
    {showRechazarModal && (
      <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 backdrop-blur-[2px] p-4">
        <div className="w-full max-w-sm rounded-2xl border border-gray-200 bg-white shadow-xl">
          <div className="border-b border-gray-100 px-5 py-4">
            <h2 className="text-sm font-bold text-gray-900">Rechazar orden</h2>
            <p className="text-xs text-gray-400 mt-0.5">Selecciona el motivo del rechazo. Será visible para el comercio.</p>
          </div>
          <div className="p-5 space-y-4">
            <div>
              <label className="block text-[10px] font-bold uppercase tracking-wide text-gray-500 mb-1.5">
                Motivo <span className="text-red-500">*</span>
              </label>
              <select
                value={motivoCodigo}
                onChange={(e) => {
                  const found = MOTIVOS_RECHAZO.find((m) => m.codigo === e.target.value)
                  setMotivoCodigo(e.target.value)
                  setMotivoTexto(found?.label ?? '')
                }}
                className="w-full rounded-xl border border-gray-200 bg-gray-50 px-3 py-2 text-sm text-gray-800 focus:border-[#004aad] focus:outline-none"
              >
                <option value="">— Seleccionar motivo —</option>
                {MOTIVOS_RECHAZO.map((m) => (
                  <option key={m.codigo} value={m.codigo}>{m.label}</option>
                ))}
              </select>
            </div>
            <div>
              <label className="block text-[10px] font-bold uppercase tracking-wide text-gray-500 mb-1.5">
                Detalle {motivoCodigo === 'otro' && <span className="text-red-500">*</span>}
                {motivoCodigo && motivoCodigo !== 'otro' && <span className="text-gray-400 normal-case font-normal"> (opcional)</span>}
              </label>
              <textarea
                value={detalleRechazo}
                onChange={(e) => setDetalleRechazo(e.target.value)}
                rows={3}
                placeholder={motivoCodigo === 'otro' ? 'Describe el motivo…' : 'Información adicional (opcional)'}
                className="w-full rounded-xl border border-gray-200 bg-gray-50 px-3 py-2 text-sm text-gray-800 placeholder-gray-300 focus:border-[#004aad] focus:outline-none resize-none"
              />
            </div>
            {err && (
              <p className="rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-xs text-red-700">{err}</p>
            )}
          </div>
          <div className="flex gap-2 border-t border-gray-100 px-5 py-4">
            <button
              onClick={() => { setShowRechazarModal(false); setMotivoCodigo(''); setMotivoTexto(''); setDetalleRechazo(''); setErr(null) }}
              className="flex-1 rounded-xl border border-gray-200 bg-white px-4 py-2 text-sm font-semibold text-gray-700 hover:bg-gray-50 transition"
            >
              Cancelar
            </button>
            <button
              onClick={rechazarSolicitud}
              disabled={!motivoCodigo}
              className="flex-1 rounded-xl bg-red-600 px-4 py-2 text-sm font-semibold text-white hover:bg-red-700 transition disabled:opacity-40 disabled:cursor-not-allowed"
            >
              Confirmar rechazo
            </button>
          </div>
        </div>
      </div>
    )}
  </>
  )
}