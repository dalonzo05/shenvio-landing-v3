'use client'

import { useEffect, useMemo, useState } from 'react'
import Link from 'next/link'
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
  Package,
  Eye,
  Filter,
  Phone,
  MapPin,
  Wallet,
  User,
  RefreshCcw,
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
type FiltroOrden = 'recientes' | 'antiguas'
type FiltroAsignacion = 'todas' | 'sin_asignar' | 'asignadas'

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

export default function GestorSolicitudesPage() {
  const [estadoFiltro, setEstadoFiltro] = useState<EstadoSolicitud>('pendiente_confirmacion')
  const [allItems, setAllItems] = useState<Solicitud[]>([])
  const [loading, setLoading] = useState(true)
  const [err, setErr] = useState<string | null>(null)

  const [cotizacionFiltro, setCotizacionFiltro] = useState<FiltroCotizacion>('todas')
  const [ordenUI, setOrdenUI] = useState<FiltroOrden>('recientes')
  const [asignacionFiltro, setAsignacionFiltro] = useState<FiltroAsignacion>('todas')
  const [busqueda, setBusqueda] = useState('')

  const [nowTick, setNowTick] = useState(Date.now())
  useEffect(() => {
    const t = setInterval(() => setNowTick(Date.now()), 1000)
    return () => clearInterval(t)
  }, [])

  const [openId, setOpenId] = useState<string | null>(null)
  const [precioFinal, setPrecioFinal] = useState<number | ''>('')
  const [motorizados, setMotorizados] = useState<Motorizado[]>([])
  const [motorizadoSel, setMotorizadoSel] = useState('')

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

  const titulo = useMemo(() => {
    const found = ESTADOS.find((e) => e.key === estadoFiltro)
    return found?.label || estadoFiltro
  }, [estadoFiltro])

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

    if (ordenUI === 'antiguas') arr = [...arr].reverse()

    return arr
  }, [allItems, estadoFiltro, cotizacionFiltro, asignacionFiltro, ordenUI, busqueda])

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

  const rebotarAsignacion = async (id: string) => {
    setErr(null)
    try {
      await updateDoc(doc(db, 'solicitudes_envio', id), {
        estado: 'confirmada',
        asignacion: null,
        updatedAt: serverTimestamp(),
      } as any)
    } catch (e) {
      console.error(e)
      setErr('No se pudo rebotar la asignación.')
    }
  }

  const abrirConfirmarYAsignar = (s: Solicitud) => {
    setOpenId(s.id)
    const sugerido = s?.cotizacion?.precioSugerido ?? (s as any)?.pagoDelivery?.montoSugerido ?? null
    const redondeado = typeof sugerido === 'number' ? roundTo10(sugerido) : ''
    setPrecioFinal(redondeado === '' ? '' : Number(redondeado))
    setMotorizadoSel(s.asignacion?.motorizadoId || '')
  }

  const cerrarModal = () => {
    setOpenId(null)
    setPrecioFinal('')
    setMotorizadoSel('')
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
    } catch (e) {
      console.error(e)
      setErr('No se pudo confirmar/asignar.')
    }
  }

  const abrirReasignar = (s: Solicitud) => {
    setOpenId(s.id)
    setPrecioFinal(s.confirmacion?.precioFinalCordobas ?? '')
    setMotorizadoSel(s.asignacion?.motorizadoId || '')
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
    } catch (e) {
      console.error(e)
      setErr('No se pudo reasignar.')
    }
  }

  const cambiarEstado = async (id: string, nuevo: EstadoSolicitud) => {
    setErr(null)
    try {
      await updateDoc(doc(db, 'solicitudes_envio', id), {
        estado: nuevo,
        updatedAt: serverTimestamp(),
      })
    } catch (e) {
      console.error(e)
      setErr('No se pudo cambiar el estado.')
    }
  }

  return (
    <div className="w-full px-4 md:px-6 py-5 md:py-6 space-y-5">
      <section className="rounded-2xl border border-gray-200 bg-white p-4 md:p-5 shadow-sm">
        <div className="flex flex-col gap-4">
          <div className="flex flex-col 2xl:flex-row 2xl:items-end 2xl:justify-between gap-4">
            <div className="min-w-0">
              <h1 className="text-3xl font-bold text-gray-900">Solicitudes</h1>
              <p className="text-sm text-gray-600 mt-1">
                Panel operativo para confirmar, asignar y monitorear pedidos.
              </p>
            </div>

            <div className="w-full 2xl:w-auto grid grid-cols-1 md:grid-cols-2 xl:grid-cols-5 gap-3">
              <div className="relative min-w-0">
                <Search className="h-4 w-4 text-gray-400 absolute left-3 top-1/2 -translate-y-1/2" />
                <input
                  value={busqueda}
                  onChange={(e) => setBusqueda(e.target.value)}
                  placeholder="Buscar orden, nombre o teléfono"
                  className="w-full rounded-xl border border-gray-200 bg-white py-2.5 pl-9 pr-3 text-sm outline-none focus:border-blue-300"
                />
              </div>

              <select
                value={estadoFiltro}
                onChange={(e) => setEstadoFiltro(e.target.value as EstadoSolicitud)}
                className="rounded-xl border border-gray-200 bg-white px-3 py-2.5 text-sm outline-none focus:border-blue-300"
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
                className="rounded-xl border border-gray-200 bg-white px-3 py-2.5 text-sm outline-none focus:border-blue-300"
              >
                <option value="todas">Todas</option>
                <option value="con">Con cotización</option>
                <option value="sin">Sin cotización</option>
              </select>

              <select
                value={asignacionFiltro}
                onChange={(e) => setAsignacionFiltro(e.target.value as FiltroAsignacion)}
                className="rounded-xl border border-gray-200 bg-white px-3 py-2.5 text-sm outline-none focus:border-blue-300"
              >
                <option value="todas">Todas</option>
                <option value="sin_asignar">Sin asignar</option>
                <option value="asignadas">Con motorizado</option>
              </select>

              <select
                value={ordenUI}
                onChange={(e) => setOrdenUI(e.target.value as FiltroOrden)}
                className="rounded-xl border border-gray-200 bg-white px-3 py-2.5 text-sm outline-none focus:border-blue-300"
              >
                <option value="recientes">Recientes primero</option>
                <option value="antiguas">Antiguas primero</option>
              </select>
            </div>
          </div>

          <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-5 xl:grid-cols-9 gap-2">
            {ESTADOS.map((estado) => {
              const count = resumenEstados[estado.key]
              const activo = estadoFiltro === estado.key

              return (
                <button
                  key={estado.key}
                  onClick={() => setEstadoFiltro(estado.key)}
                  className={`rounded-xl border px-3 py-2.5 text-left transition ${
                    activo
                      ? 'border-blue-300 bg-blue-50 shadow-sm'
                      : 'border-gray-200 bg-white hover:border-gray-300'
                  }`}
                >
                  <div className="flex items-center justify-between gap-2">
                    <span className={`text-xs font-medium ${activo ? 'text-blue-700' : 'text-gray-600'}`}>
                      {estado.short}
                    </span>
                    <Package className={`h-3.5 w-3.5 ${activo ? 'text-blue-700' : 'text-gray-400'}`} />
                  </div>
                  <div className={`mt-1 text-xl font-bold ${activo ? 'text-blue-700' : 'text-gray-900'}`}>
                    {count}
                  </div>
                </button>
              )
            })}
          </div>

          <div className="flex flex-wrap items-center gap-3 text-sm">
            <span className="font-semibold text-gray-900">{titulo}</span>
            <span className="text-gray-500">({itemsFiltrados.length})</span>
            <span className="inline-flex items-center gap-1 rounded-full border border-gray-200 bg-gray-50 px-2.5 py-1 text-xs text-gray-600">
              <Filter className="h-3.5 w-3.5" />
              Filtros activos sobre la operación
            </span>
          </div>
        </div>
      </section>

      {err && (
        <div className="rounded-xl border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700">
          {err}
        </div>
      )}

      {loading ? (
        <div className="rounded-2xl border border-gray-200 bg-white p-6 text-sm text-gray-600 shadow-sm">
          Cargando...
        </div>
      ) : itemsFiltrados.length === 0 ? (
        <div className="rounded-2xl border border-gray-200 bg-white p-6 text-sm text-gray-600 shadow-sm">
          No hay solicitudes en este estado.
        </div>
      ) : (
        <>
          <div className="hidden xl:block rounded-2xl border border-gray-200 bg-white shadow-sm overflow-hidden">
            <div className="overflow-auto h-[72vh]" style={{ scrollbarGutter: 'stable' as any }}>
              <table className="min-w-[1700px] w-full text-sm">
                <thead className="sticky top-0 z-20 bg-gray-50 border-b border-gray-200 shadow-sm">
                  <tr className="text-left text-gray-600">
                    <th className="px-4 py-3 font-medium min-w-[250px]">Orden</th>
                    <th className="px-4 py-3 font-medium min-w-[150px]">Estado</th>
                    <th className="px-4 py-3 font-medium min-w-[340px]">Retiro</th>
                    <th className="px-4 py-3 font-medium min-w-[340px]">Entrega</th>
                    <th className="px-4 py-3 font-medium min-w-[170px]">Precio</th>
                    <th className="px-4 py-3 font-medium min-w-[230px]">Motorizado</th>
                    <th className="px-4 py-3 font-medium min-w-[160px]">Aceptación</th>
                    <th className="px-4 py-3 font-medium min-w-[240px] sticky right-0 bg-gray-50 z-20 border-l border-gray-200">
                      Acciones
                    </th>
                  </tr>
                </thead>

                <tbody className="divide-y divide-gray-100">
                  {itemsFiltrados.map((s) => {
                    const retiroMaps = getBestMapsUrl(s, 'recoleccion')
                    const entregaMaps = getBestMapsUrl(s, 'entrega')

                    const rem =
                      s.estado === 'pendiente_confirmacion'
                        ? getRemainingConfirmacion(s)
                        : s.estado === 'asignada'
                        ? getRemainingAceptacion(s)
                        : null

                    const sem = semaforoForRemaining(rem)

                    return (
                      <tr key={s.id} className="align-top hover:bg-gray-50/70">
                        <td className="px-4 py-4">
                          <Link
                            href={`/panel/gestor/solicitudes/${s.id}`}
                            className="font-semibold text-gray-900 hover:text-blue-700 hover:underline"
                          >
                            {s.id}
                          </Link>

                          <div className="text-xs text-gray-500 mt-1">{formatDateTime(s.createdAt)}</div>
                          <div className="text-xs text-gray-500 mt-1">
                            {s.tieneCotizacion ? 'Con cotización' : 'Sin cotización'} · {s.tipoCliente}
                          </div>

                          {typeof s?.cotizacion?.distanciaKm === 'number' && (
                            <div className="text-xs text-gray-500 mt-1">
                              Distancia: {s.cotizacion.distanciaKm} km
                            </div>
                          )}

                          {s.detalle?.trim() && (
                            <div className="text-xs text-gray-500 mt-2 line-clamp-2">
                              {s.detalle.trim()}
                            </div>
                          )}
                        </td>

                        <td className="px-4 py-4">
                          <span className={`inline-flex rounded-full border px-2.5 py-1 text-xs font-medium ${estadoClass(s.estado)}`}>
                            {statusLabel(s.estado)}
                          </span>

                          {typeof rem === 'number' && (
                            <div className="mt-2">
                              <span className={`inline-flex rounded-full border px-2.5 py-1 text-xs font-medium ${sem.className}`}>
                                {formatMMSS(rem)} · {sem.label}
                              </span>
                            </div>
                          )}
                        </td>

                        <td className="px-4 py-4">
                          <div className="flex items-start gap-2">
                            <User className="h-4 w-4 text-gray-400 mt-0.5 shrink-0" />
                            <div className="min-w-0">
                              <div className="font-medium text-gray-900">{s.recoleccion.nombreApellido || '—'}</div>
                              <div className="text-gray-700 mt-1 flex items-center gap-1">
                                <Phone className="h-3.5 w-3.5 text-gray-400" />
                                {s.recoleccion.celular}
                              </div>
                              <div className="text-gray-600 mt-1 break-words flex items-start gap-1">
                                <MapPin className="h-3.5 w-3.5 text-gray-400 mt-0.5 shrink-0" />
                                <span>{s.recoleccion.direccionEscrita}</span>
                              </div>
                            </div>
                          </div>

                          <div className="mt-2 flex flex-wrap gap-2">
                            {retiroMaps && (
                              <a
                                href={retiroMaps}
                                target="_blank"
                                rel="noreferrer"
                                className="inline-flex items-center gap-1 text-xs text-blue-700 hover:underline"
                              >
                                <ExternalLink className="h-3.5 w-3.5" />
                                Maps
                              </a>
                            )}
                            {retiroMaps && (
                              <button
                                onClick={() => copyToClipboard(retiroMaps)}
                                className="inline-flex items-center gap-1 text-xs text-gray-700 hover:underline"
                              >
                                <Copy className="h-3.5 w-3.5" />
                                Copiar link
                              </button>
                            )}
                          </div>
                        </td>

                        <td className="px-4 py-4">
                          <div className="flex items-start gap-2">
                            <User className="h-4 w-4 text-gray-400 mt-0.5 shrink-0" />
                            <div className="min-w-0">
                              <div className="font-medium text-gray-900">{s.entrega.nombreApellido || '—'}</div>
                              <div className="text-gray-700 mt-1 flex items-center gap-1">
                                <Phone className="h-3.5 w-3.5 text-gray-400" />
                                {s.entrega.celular}
                              </div>
                              <div className="text-gray-600 mt-1 break-words flex items-start gap-1">
                                <MapPin className="h-3.5 w-3.5 text-gray-400 mt-0.5 shrink-0" />
                                <span>{s.entrega.direccionEscrita}</span>
                              </div>
                            </div>
                          </div>

                          {s.cobroContraEntrega?.aplica && (
                            <div className="text-xs text-gray-700 mt-2 flex items-center gap-1">
                              <Wallet className="h-3.5 w-3.5 text-gray-400" />
                              CE: <span className="font-semibold">{money(s.cobroContraEntrega.monto)}</span>
                            </div>
                          )}

                          <div className="mt-2 flex flex-wrap gap-2">
                            {entregaMaps && (
                              <a
                                href={entregaMaps}
                                target="_blank"
                                rel="noreferrer"
                                className="inline-flex items-center gap-1 text-xs text-blue-700 hover:underline"
                              >
                                <ExternalLink className="h-3.5 w-3.5" />
                                Maps
                              </a>
                            )}
                            {entregaMaps && (
                              <button
                                onClick={() => copyToClipboard(entregaMaps)}
                                className="inline-flex items-center gap-1 text-xs text-gray-700 hover:underline"
                              >
                                <Copy className="h-3.5 w-3.5" />
                                Copiar link
                              </button>
                            )}
                          </div>
                        </td>

                        <td className="px-4 py-4">
                          {typeof s.confirmacion?.precioFinalCordobas === 'number' ? (
                            <div className="font-semibold text-gray-900">
                              {money(s.confirmacion.precioFinalCordobas)}
                            </div>
                          ) : typeof (s as any)?.pagoDelivery?.montoSugerido === 'number' ? (
                            <div className="text-gray-700">
                              Sugerido: {money((s as any).pagoDelivery.montoSugerido)}
                            </div>
                          ) : typeof s?.cotizacion?.precioSugerido === 'number' ? (
                            <div className="text-gray-700">
                              Sugerido: {money(s.cotizacion.precioSugerido)}
                            </div>
                          ) : (
                            <div className="text-gray-500">—</div>
                          )}

                          <div className="text-xs text-gray-500 mt-1">
                            {s.tipoCliente === 'credito'
                              ? 'Crédito semanal'
                              : `Contado (${(s.pagoDelivery as any)?.quienPaga || '—'})`}
                          </div>
                        </td>

                        <td className="px-4 py-4">
                          {s.asignacion?.motorizadoNombre ? (
                            <>
                              <div className="font-medium text-gray-900">{s.asignacion.motorizadoNombre}</div>
                              <div className="text-gray-700 mt-1">{s.asignacion.motorizadoTelefono || '—'}</div>
                              <div className="text-xs text-gray-500 mt-1">
                                Asignado: {formatDateTime(s.asignacion.asignadoAt)}
                              </div>
                            </>
                          ) : (
                            <div className="text-gray-500">Sin asignar</div>
                          )}
                        </td>

                        <td className="px-4 py-4">
                          {s.estado === 'asignada' ? (
                            <>
                              <span className={`inline-flex rounded-full border px-2.5 py-1 text-xs font-medium ${aceptacionClass(s.asignacion || undefined)}`}>
                                {aceptacionLabel(s.asignacion || undefined)}
                              </span>
                              {s.asignacion?.aceptadoAt && (
                                <div className="text-xs text-gray-500 mt-1">
                                  {formatDateTime(s.asignacion.aceptadoAt)}
                                </div>
                              )}
                            </>
                          ) : (
                            <div className="text-gray-500">—</div>
                          )}
                        </td>

                        <td className="px-4 py-4 sticky right-0 bg-white z-10 border-l border-gray-100">
                          <div className="flex flex-col gap-2 min-w-[210px]">
                            <button
                              onClick={() => copyToClipboard(buildCopyRetiroEntrega(s))}
                              className="inline-flex items-center gap-2 rounded-lg border border-gray-200 px-3 py-2 text-xs font-medium text-gray-700 hover:bg-gray-50"
                            >
                              <Copy className="h-4 w-4" />
                              Copiar retiro/entrega
                            </button>

                            <button
                              onClick={() => copyToClipboard(buildCopyTelegramFull(s))}
                              className="inline-flex items-center gap-2 rounded-lg border border-gray-200 px-3 py-2 text-xs font-medium text-gray-700 hover:bg-gray-50"
                            >
                              <Send className="h-4 w-4" />
                              Copiar Telegram
                            </button>

                            {s.estado === 'pendiente_confirmacion' && (
                              <>
                                <button
                                  onClick={() => abrirConfirmarYAsignar(s)}
                                  className="inline-flex items-center gap-2 rounded-lg bg-[#004aad] px-3 py-2 text-xs font-medium text-white hover:bg-[#003d94]"
                                >
                                  <CheckCircle2 className="h-4 w-4" />
                                  Confirmar + asignar
                                </button>

                                <button
                                  onClick={() => cambiarEstado(s.id, 'rechazada')}
                                  className="inline-flex items-center gap-2 rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-xs font-medium text-red-700"
                                >
                                  <XCircle className="h-4 w-4" />
                                  Rechazar
                                </button>
                              </>
                            )}

                            {s.estado === 'confirmada' && (
                              <button
                                onClick={() => abrirConfirmarYAsignar(s)}
                                className="inline-flex items-center gap-2 rounded-lg border border-gray-200 px-3 py-2 text-xs font-medium text-gray-700 hover:bg-gray-50"
                              >
                                <Truck className="h-4 w-4" />
                                Asignar rápido
                              </button>
                            )}

                            {s.estado === 'asignada' && (
                              <>
                                <button
                                  onClick={() => abrirReasignar(s)}
                                  className="inline-flex items-center gap-2 rounded-lg border border-gray-200 px-3 py-2 text-xs font-medium text-gray-700 hover:bg-gray-50"
                                >
                                  <RefreshCcw className="h-4 w-4" />
                                  Reasignar
                                </button>

                                <button
                                  onClick={() => rebotarAsignacion(s.id)}
                                  className="inline-flex items-center gap-2 rounded-lg border border-gray-200 px-3 py-2 text-xs font-medium text-gray-700 hover:bg-gray-50"
                                >
                                  <RotateCcw className="h-4 w-4" />
                                  Rebotar
                                </button>
                              </>
                            )}

                            <Link
                              href={`/panel/gestor/solicitudes/${s.id}`}
                              className="inline-flex items-center gap-2 rounded-lg border border-gray-200 px-3 py-2 text-xs font-medium text-gray-700 hover:bg-gray-50"
                            >
                              <Eye className="h-4 w-4" />
                              Ver detalle
                            </Link>
                          </div>
                        </td>
                      </tr>
                    )
                  })}
                </tbody>
              </table>
            </div>
          </div>

          <div className="xl:hidden space-y-3">
            {itemsFiltrados.map((s) => {
              const retiroMaps = getBestMapsUrl(s, 'recoleccion')
              const entregaMaps = getBestMapsUrl(s, 'entrega')

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
                      onClick={() => copyToClipboard(buildCopyRetiroEntrega(s))}
                      className="rounded-lg border border-gray-200 px-3 py-2 text-xs font-medium text-gray-700"
                    >
                      Copiar retiro
                    </button>

                    <button
                      onClick={() => copyToClipboard(buildCopyTelegramFull(s))}
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
          </div>
        </>
      )}

      {openId && (
        <div className="fixed inset-0 bg-black/30 flex items-center justify-center p-4 z-50">
          <div className="w-full max-w-md rounded-2xl bg-white p-5 shadow-lg">
            <div className="flex items-center justify-between">
              <h3 className="font-semibold text-lg">Confirmar y asignar</h3>
              <button onClick={cerrarModal} className="text-sm underline">
                Cerrar
              </button>
            </div>

            <p className="text-sm text-gray-600 mt-2">
              1) Confirmás el <strong>precio final</strong>. 2) Si quieres, asignás motorizado en el mismo paso.
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
              <label className="block text-sm font-medium mb-1">Motorizado (opcional)</label>
              <select
                value={motorizadoSel}
                onChange={(e) => setMotorizadoSel(e.target.value)}
                className="w-full border rounded-lg px-3 py-2"
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
              <div className="text-xs text-gray-500 mt-1">
                Si asignás ahora, el motorizado tendrá <strong>10 minutos</strong> para aceptar.
              </div>
            </div>

            <div className="mt-4 flex gap-2 flex-wrap">
              <button
                onClick={() => confirmarYAsignar(openId)}
                className="rounded-full bg-[#004aad] text-white px-4 py-2 text-sm font-semibold"
              >
                Guardar
              </button>

              <button onClick={cerrarModal} className="rounded-full border px-4 py-2 text-sm font-semibold">
                Cancelar
              </button>

              {estadoFiltro === 'asignada' && (
                <button
                  onClick={() => reasignarSolo(openId)}
                  className="rounded-full border px-4 py-2 text-sm font-semibold"
                >
                  Reasignar
                </button>
              )}
            </div>
          </div>
        </div>
      )}
    </div>
  )
} 