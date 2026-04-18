'use client'

import { useEffect, useMemo, useRef, useState } from 'react'
import Link from 'next/link'
import { useParams, useRouter } from 'next/navigation'
import { getMapsLoader } from '@/lib/googleMaps'
import {
  doc,
  onSnapshot,
  updateDoc,
  serverTimestamp,
  collection,
  getDocs,
  query,
} from 'firebase/firestore'
import { auth, db } from '@/fb/config'
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
}

type Motorizado = {
  id: string
  authUid?: string
  nombre: string
  telefono?: string
  estado?: string
  activo?: boolean
}

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
  const params = useParams()
  const router = useRouter()
  const id = String(params?.id || '')

  const [solicitud, setSolicitud] = useState<Solicitud | null>(null)
  const [loading, setLoading] = useState(true)
  const [err, setErr] = useState<string | null>(null)

  const [motorizados, setMotorizados] = useState<Motorizado[]>([])
  const [precioFinal, setPrecioFinal] = useState<number | ''>('')
  const [motorizadoSel, setMotorizadoSel] = useState('')

  const [tick, setTick] = useState(Date.now())
  useEffect(() => {
    const t = setInterval(() => setTick(Date.now()), 1000)
    return () => clearInterval(t)
  }, [])

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

    try {
      await updateDoc(doc(db, 'solicitudes_envio', solicitud.id), {
        estado: 'confirmada',
        asignacion: null,
        updatedAt: serverTimestamp(),
      } as any)
    } catch (e) {
      console.error(e)
      setErr('No se pudo rebotar la asignación.')
    }
  }

  const cambiarEstado = async (nuevo: EstadoSolicitud) => {
    if (!solicitud) return
    setErr(null)

    try {
      await updateDoc(doc(db, 'solicitudes_envio', solicitud.id), {
        estado: nuevo,
        updatedAt: serverTimestamp(),
        [`historial.${nuevo}At`]: serverTimestamp(),
      })
    } catch (e) {
      console.error(e)
      setErr('No se pudo cambiar el estado.')
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
            entrega={solicitud.cotizacion?.destinoCoord ?? (solicitud.entrega as any)?.coord ?? null}
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
                <h2 className="font-semibold text-gray-900">Entrega</h2>
              </div>

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
          <div className="rounded-2xl border border-gray-200 bg-white p-5 shadow-sm">
            <h2 className="font-semibold text-gray-900 mb-4">Decisión rápida</h2>

            <div className="space-y-4">
              <div>
                <label className="block text-sm font-medium mb-1">Precio final (C$)</label>
                <input
                  type="number"
                  step={10}
                  value={precioFinal}
                  onChange={(e) => {
                    const v = e.target.value === '' ? '' : Number(e.target.value)
                    setPrecioFinal(v === '' ? '' : Number(roundTo10(v)))
                  }}
                  className="w-full rounded-lg border px-3 py-2"
                  placeholder="Ej: 130"
                />
                <div className="text-xs text-gray-500 mt-1">Se redondea a múltiplos de 10.</div>
              </div>

              <div>
                <label className="block text-sm font-medium mb-1">Motorizado</label>
                <select
                  value={motorizadoSel}
                  onChange={(e) => setMotorizadoSel(e.target.value)}
                  className="w-full rounded-lg border px-3 py-2"
                >
                  <option value="">-- No asignar todavía --</option>
                  {motorizados.map((m) => (
                    <option key={m.id} value={m.id}>
                      {m.estado === 'disponible' ? '✅ ' : '⛔ '}
                      {m.nombre}
                      {m.telefono ? ` · ${m.telefono}` : ''}
                    </option>
                  ))}
                </select>
              </div>

              <div className="grid grid-cols-1 gap-2">
                <button
                  onClick={confirmarYAsignar}
                  className="inline-flex items-center justify-center gap-2 rounded-lg bg-[#004aad] px-4 py-2.5 text-sm font-semibold text-white hover:bg-[#003d94]"
                >
                  <CheckCircle2 className="h-4 w-4" />
                  Guardar confirmación / asignación
                </button>

                {estado === 'pendiente_confirmacion' && (
                  <button
                    onClick={() => cambiarEstado('rechazada')}
                    className="inline-flex items-center justify-center gap-2 rounded-lg border border-red-200 bg-red-50 px-4 py-2.5 text-sm font-semibold text-red-700"
                  >
                    <XCircle className="h-4 w-4" />
                    Rechazar orden
                  </button>
                )}

                {estado === 'confirmada' && (
                  <button
                    onClick={() => cambiarEstado('cancelada')}
                    className="inline-flex items-center justify-center gap-2 rounded-lg border border-gray-200 px-4 py-2.5 text-sm font-semibold text-gray-700 hover:bg-gray-50"
                  >
                    <AlertTriangle className="h-4 w-4" />
                    Cancelar
                  </button>
                )}

                {estado === 'asignada' && (
                  <button
                    onClick={rebotarAsignacion}
                    className="inline-flex items-center justify-center gap-2 rounded-lg border border-gray-200 px-4 py-2.5 text-sm font-semibold text-gray-700 hover:bg-gray-50"
                  >
                    <RotateCcw className="h-4 w-4" />
                    Rebotar a confirmada
                  </button>
                )}

                {estado === 'en_camino_retiro' && (
                  <button
                    onClick={() => cambiarEstado('retirado')}
                    className="inline-flex items-center justify-center gap-2 rounded-lg border border-gray-200 px-4 py-2.5 text-sm font-semibold text-gray-700 hover:bg-gray-50"
                  >
                    <Package className="h-4 w-4" />
                    Marcar retirado
                  </button>
                )}

                {estado === 'retirado' && (
                  <button
                    onClick={() => cambiarEstado('en_camino_entrega')}
                    className="inline-flex items-center justify-center gap-2 rounded-lg border border-gray-200 px-4 py-2.5 text-sm font-semibold text-gray-700 hover:bg-gray-50"
                  >
                    <Truck className="h-4 w-4" />
                    Pasar a entrega
                  </button>
                )}

                {estado === 'en_camino_entrega' && (
                  <button
                    onClick={() => cambiarEstado('entregado')}
                    className="inline-flex items-center justify-center gap-2 rounded-lg border border-green-200 bg-green-50 px-4 py-2.5 text-sm font-semibold text-green-700"
                  >
                    <CheckCheck className="h-4 w-4" />
                    Marcar entregado
                  </button>
                )}
              </div>
            </div>
          </div>

          <div className="rounded-2xl border border-gray-200 bg-white p-5 shadow-sm">
            <h2 className="font-semibold text-gray-900 mb-4">Asignación actual</h2>

            {solicitud.asignacion?.motorizadoNombre ? (
              <div className="space-y-3 text-sm">
                <div>
                  <div className="text-gray-500">Motorizado</div>
                  <div className="font-medium text-gray-900 flex items-center gap-2">
                    <Bike className="h-4 w-4 text-gray-400" />
                    {solicitud.asignacion.motorizadoNombre}
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

          {solicitud.evidencias && (Object.keys(solicitud.evidencias).length > 0) && (
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
                      className="flex flex-col items-center gap-1 rounded-xl border border-gray-200 bg-gray-50 p-2 hover:bg-gray-100 transition-colors cursor-pointer"
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
  )
}