'use client'

import { useEffect, useMemo, useState } from 'react'
import Link from 'next/link'
import {
  collection,
  onSnapshot,
  doc,
  updateDoc,
  getDocs,
  query,
  serverTimestamp,
  Timestamp,
  where,
} from 'firebase/firestore'
import { db, auth } from '@/fb/config'
import {
  rankearMotorizados,
  type MotorizadoConRanking,
  type OrdenActivaRanking,
  type NuevaOrdenRanking,
  type MotorizadoRankeado,
} from '@/lib/motorizado-ranking'
import {
  X,
  ExternalLink,
  Copy,
  Phone,
  MapPin,
  Bike,
  CheckCircle2,
  RotateCcw,
  XCircle,
  Clock3,
  Package,
  Truck,
  AlertTriangle,
  CheckCheck,
  Star,
} from 'lucide-react'

// ─── Types ────────────────────────────────────────────────────────────────────

export type EstadoSolicitud =
  | 'pendiente_confirmacion' | 'confirmada' | 'rechazada' | 'asignada'
  | 'en_camino_retiro' | 'retirado' | 'en_camino_entrega' | 'entregado' | 'cancelada'

export type SolicitudDetalle = {
  id: string
  createdAt?: Timestamp
  updatedAt?: Timestamp
  estado?: EstadoSolicitud
  tipoCliente?: 'contado' | 'credito'
  recoleccion?: {
    nombreApellido?: string; celular?: string; direccionEscrita?: string
    nota?: string | null; puntoGoogleTexto?: string | null; puntoGoogleLink?: string | null
    puntoGoogleTipo?: 'referencial' | 'exacto'; coord?: { lat: number; lng: number } | null
  }
  entrega?: {
    nombreApellido?: string; celular?: string; direccionEscrita?: string
    nota?: string | null; puntoGoogleTexto?: string | null; puntoGoogleLink?: string | null
    puntoGoogleTipo?: 'referencial' | 'exacto'; coord?: { lat: number; lng: number } | null
  }
  cobroContraEntrega?: { aplica?: boolean; monto?: number }
  pagoDelivery?: {
    tipo?: string; quienPaga?: string; montoSugerido?: number | null
    deducirDelCobroContraEntrega?: boolean
  }
  cotizacion?: {
    distanciaKm?: number | null; precioSugerido?: number | null
    origenCoord?: { lat: number; lng: number } | null
    destinoCoord?: { lat: number; lng: number } | null
  }
  confirmacion?: { precioFinalCordobas?: number; confirmadoPorUid?: string; confirmadoAt?: any }
  asignacion?: {
    motorizadoId?: string; motorizadoAuthUid?: string; motorizadoNombre?: string
    motorizadoTelefono?: string; asignadoPorUid?: string; asignadoAt?: any
    aceptarAntesDe?: any; estadoAceptacion?: 'pendiente' | 'aceptada' | 'rechazada' | 'expirada'
    aceptadoAt?: any; rechazadoAt?: any; motivoRechazo?: string
  } | null
  detalle?: string
  historial?: {
    en_camino_retiroAt?: any; retiradoAt?: any
    en_camino_entregaAt?: any; entregadoAt?: any
  }
  userId?: string
  ownerSnapshot?: { companyName?: string; phone?: string; nombre?: string; uid?: string }
  cobrosMotorizado?: {
    delivery?: { monto: number; recibio: boolean; at?: any; justificacion?: string }
    producto?: { monto: number; recibio: boolean; at?: any; justificacion?: string }
    resolucion?: { resueltoPor: string; at?: any; nota?: string }
  }
  cobroDelivery?: {
    estado?: string; formaPago?: string; notaPago?: string; pagadoAt?: any; monto?: number
  }
  registro?: {
    semana?: number; zona?: string
    deposito?: {
      monto?: number | null; formaPago?: string | null
      confirmadoMotorizado?: boolean; confirmadoAt?: Timestamp | null
      confirmadoComercio?: boolean; confirmadoComercioAt?: Timestamp | null
      confirmadoStorkhub?: boolean; confirmadoStorkhubAt?: Timestamp | null
    }
  }
  evidencias?: {
    retiro?: { url: string; pathStorage: string; uploadedAt?: any; motorizadoUid?: string }
    entrega?: { url: string; pathStorage: string; uploadedAt?: any; motorizadoUid?: string }
    deposito?: { url: string; pathStorage: string; uploadedAt?: any; motorizadoUid?: string }
  }
}

type Motorizado = MotorizadoConRanking

// ─── Helpers exportados ───────────────────────────────────────────────────────

export function formatDateTime(ts: any): string {
  if (!ts) return '—'
  const d = typeof ts?.toDate === 'function' ? ts.toDate() : ts instanceof Date ? ts : null
  if (!d) return '—'
  return d.toLocaleString()
}

export function money(n: any): string {
  const v = Number(n)
  return Number.isFinite(v) ? `C$ ${v}` : '—'
}

export function statusLabel(e?: EstadoSolicitud): string {
  const map: Record<string, string> = {
    pendiente_confirmacion: 'Pendiente', confirmada: 'Confirmada', rechazada: 'Rechazada',
    asignada: 'Asignada', en_camino_retiro: 'En camino retiro', retirado: 'Retirado',
    en_camino_entrega: 'En camino entrega', entregado: 'Entregado', cancelada: 'Cancelada',
  }
  return e ? (map[e] || e) : '—'
}

export function estadoClass(e?: EstadoSolicitud): string {
  const map: Record<string, string> = {
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
  return e ? (map[e] || 'bg-gray-100 text-gray-700 border-gray-200') : ''
}

export function roundTo10(n: any): number { return Math.round(Number(n) / 10) * 10 }

export function getBestMapsUrl(s: SolicitudDetalle, tipo: 'recoleccion' | 'entrega'): string | null {
  const coord = tipo === 'recoleccion' ? s.cotizacion?.origenCoord : s.cotizacion?.destinoCoord
  if (coord) return `https://www.google.com/maps?q=${coord.lat},${coord.lng}`
  const link = tipo === 'recoleccion' ? s.recoleccion?.puntoGoogleLink : s.entrega?.puntoGoogleLink
  if (link?.trim()) return link.trim()
  const texto = tipo === 'recoleccion' ? s.recoleccion?.puntoGoogleTexto : s.entrega?.puntoGoogleTexto
  if (texto) return `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(texto)}`
  const dir = tipo === 'recoleccion' ? s.recoleccion?.direccionEscrita : s.entrega?.direccionEscrita
  return dir ? `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(dir)}` : null
}

export async function copyToClipboard(text: string) {
  try { await navigator.clipboard.writeText(text) } catch {
    const ta = document.createElement('textarea')
    ta.value = text; document.body.appendChild(ta); ta.select()
    document.execCommand('copy'); document.body.removeChild(ta)
  }
}

// ─── Sub-componentes ──────────────────────────────────────────────────────────

type AccentColor = 'blue' | 'orange' | 'emerald' | 'amber' | 'indigo' | 'purple' | 'teal' | 'gray' | 'red'

const accentBorder: Record<AccentColor, string> = {
  blue:    'border-l-[#004aad]',
  orange:  'border-l-orange-400',
  emerald: 'border-l-emerald-500',
  amber:   'border-l-amber-400',
  indigo:  'border-l-indigo-500',
  purple:  'border-l-purple-500',
  teal:    'border-l-teal-500',
  gray:    'border-l-gray-300',
  red:     'border-l-red-400',
}

const accentTitle: Record<AccentColor, string> = {
  blue:    'text-[#004aad]',
  orange:  'text-orange-500',
  emerald: 'text-emerald-600',
  amber:   'text-amber-500',
  indigo:  'text-indigo-500',
  purple:  'text-purple-500',
  teal:    'text-teal-600',
  gray:    'text-gray-400',
  red:     'text-red-500',
}

export function Section({
  title,
  children,
  accent = 'blue',
}: {
  title: string
  children: React.ReactNode
  accent?: AccentColor
}) {
  return (
    <div className={`rounded-xl border border-gray-200 bg-white shadow-sm border-l-4 overflow-hidden ${accentBorder[accent]}`}>
      <div className="px-4 pt-3 pb-2.5 border-b border-gray-100 bg-gray-50/60">
        <h3 className={`text-[10px] font-bold uppercase tracking-widest ${accentTitle[accent]}`}>
          {title}
        </h3>
      </div>
      <div className="p-4 space-y-3">{children}</div>
    </div>
  )
}

export function InfoRow({ label, value, icon }: { label: string; value?: string | null; icon?: React.ReactNode }) {
  return (
    <div className="flex flex-col gap-0.5">
      <div className="text-[10px] font-semibold uppercase tracking-wide text-gray-400">{label}</div>
      <div className="text-sm font-medium text-gray-900 flex items-center gap-1.5">
        {icon && <span className="text-gray-400">{icon}</span>}
        {value || <span className="text-gray-300">—</span>}
      </div>
    </div>
  )
}

// ─── SolicitudDrawer ──────────────────────────────────────────────────────────

export function SolicitudDrawer({
  solicitudId,
  onClose,
  comercioNames = {},
}: {
  solicitudId: string
  onClose: () => void
  comercioNames?: Record<string, string>
}) {
  const [solicitud, setSolicitud] = useState<SolicitudDetalle | null>(null)
  const [loading, setLoading] = useState(true)
  const [err, setErr] = useState<string | null>(null)
  const [motorizados, setMotorizados] = useState<Motorizado[]>([])
  const [precioFinal, setPrecioFinal] = useState<number | ''>('')
  const [motorizadoSel, setMotorizadoSel] = useState('')
  const [tick, setTick] = useState(Date.now())
  const [ordenesActivas, setOrdenesActivas] = useState<OrdenActivaRanking[]>([])
  const [loadingOrdenes, setLoadingOrdenes] = useState(false)

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
    })
  }, [])

  // Cargar órdenes activas del sistema para el cálculo de carga y ranking
  useEffect(() => {
    setLoadingOrdenes(true)
    getDocs(
      query(
        collection(db, 'solicitudes_envio'),
        where('estado', 'in', ['asignada', 'en_camino_retiro', 'retirado', 'en_camino_entrega'])
      )
    )
      .then((snap) =>
        setOrdenesActivas(snap.docs.map((d) => ({ id: d.id, ...(d.data() as any) })))
      )
      .catch((e) => console.error('[SolicitudDrawer] Error cargando órdenes activas:', e))
      .finally(() => setLoadingOrdenes(false))
  }, [])

  useEffect(() => {
    setLoading(true)
    const unsub = onSnapshot(
      doc(db, 'solicitudes_envio', solicitudId),
      (snap) => {
        if (!snap.exists()) { setErr('La orden no existe.'); setLoading(false); return }
        const data = { id: snap.id, ...(snap.data() as any) } as SolicitudDetalle
        setSolicitud(data)
        setPrecioFinal(data.confirmacion?.precioFinalCordobas ?? '')
        setMotorizadoSel(data.asignacion?.motorizadoId || '')
        setLoading(false)
      },
      (e) => { console.error(e); setErr('No se pudo cargar.'); setLoading(false) }
    )
    return () => unsub()
  }, [solicitudId])

  const tiempoRestante = useMemo(() => {
    if (!solicitud) return null
    if (solicitud.estado === 'pendiente_confirmacion') {
      const created = typeof solicitud.createdAt?.toDate === 'function' ? solicitud.createdAt.toDate() : null
      if (!created) return null
      return created.getTime() + 10 * 60 * 1000 - tick
    }
    if (solicitud.estado === 'asignada') {
      const aBefore = solicitud.asignacion?.aceptarAntesDe
      if (aBefore) {
        const d = typeof aBefore?.toDate === 'function' ? aBefore.toDate() : aBefore instanceof Date ? aBefore : null
        if (d) return d.getTime() - tick
      }
      const asignadoAt = typeof solicitud.asignacion?.asignadoAt?.toDate === 'function' ? solicitud.asignacion.asignadoAt.toDate() : null
      if (asignadoAt) return asignadoAt.getTime() + 10 * 60 * 1000 - tick
    }
    return null
  }, [solicitud, tick])

  // Ranking de sugerencia — función pura, sin I/O
  const rankingCalculado = useMemo<MotorizadoRankeado[]>(() => {
    if (!solicitud || motorizados.length === 0) return []
    const nuevaOrden: NuevaOrdenRanking = {
      recoleccion: { coord: solicitud.recoleccion?.coord ?? null },
      entrega: { coord: solicitud.entrega?.coord ?? null },
      requiereBolso: false, // campo no existe en Firestore aún → siempre false
    }
    return rankearMotorizados(motorizados as MotorizadoConRanking[], ordenesActivas, nuevaOrden)
  }, [solicitud, motorizados, ordenesActivas])

  const confirmarYAsignar = async () => {
    if (!solicitud) return
    const user = auth.currentUser
    if (!user) return setErr('Sin sesión.')
    if (precioFinal === '' || Number(precioFinal) <= 0) return setErr('Ingresá un precio válido.')
    const m = motorizadoSel ? motorizados.find((x) => x.id === motorizadoSel) : null
    try {
      const aceptarAntesDe = new Date(Date.now() + 10 * 60 * 1000)
      await updateDoc(doc(db, 'solicitudes_envio', solicitud.id), {
        estado: m ? 'asignada' : 'confirmada',
        confirmacion: { precioFinalCordobas: Number(precioFinal), confirmadoPorUid: user.uid, confirmadoAt: serverTimestamp() },
        ...(m ? { asignacion: { motorizadoId: m.id, motorizadoAuthUid: m.authUid || '', motorizadoNombre: m.nombre, motorizadoTelefono: m.telefono || '', asignadoPorUid: user.uid, asignadoAt: serverTimestamp(), estadoAceptacion: 'pendiente', aceptadoAt: null, rechazadoAt: null, motivoRechazo: '', aceptarAntesDe } } : { asignacion: null }),
        updatedAt: serverTimestamp(),
      } as any)
      setErr(null)
    } catch (e) { console.error(e); setErr('No se pudo guardar.') }
  }

  const cambiarEstado = async (nuevo: EstadoSolicitud) => {
    if (!solicitud) return
    try {
      await updateDoc(doc(db, 'solicitudes_envio', solicitud.id), {
        estado: nuevo,
        updatedAt: serverTimestamp(),
        [`historial.${nuevo}At`]: serverTimestamp(),
      })
    } catch { setErr('No se pudo cambiar el estado.') }
  }

  const rebotarAsignacion = async () => {
    if (!solicitud) return
    try {
      await updateDoc(doc(db, 'solicitudes_envio', solicitud.id), { estado: 'confirmada', asignacion: null, updatedAt: serverTimestamp() } as any)
    } catch { setErr('No se pudo rebotar.') }
  }

  const retiroMaps = solicitud ? getBestMapsUrl(solicitud, 'recoleccion') : null
  const entregaMaps = solicitud ? getBestMapsUrl(solicitud, 'entrega') : null
  const estado = solicitud?.estado
  const minLeft = tiempoRestante !== null ? Math.floor(tiempoRestante / 60000) : null

  return (
    <>
      {/* Overlay */}
      <div className="fixed inset-0 z-40 bg-black/25 backdrop-blur-[1px]" onClick={onClose} />

      {/* Panel */}
      <div className="fixed right-0 top-0 z-50 flex h-full w-full max-w-[500px] flex-col shadow-2xl">

        {/* Brand strip */}
        <div className="h-1 w-full shrink-0 bg-gradient-to-r from-[#004aad] via-[#0057d0] to-[#3b82f6]" />

        {/* Header */}
        <div className="flex items-center justify-between border-b border-gray-200 bg-white px-4 py-3 shrink-0">
          <div className="flex items-center gap-2.5 min-w-0">
            <button
              onClick={onClose}
              className="rounded-lg p-1.5 text-gray-500 hover:bg-gray-100 hover:text-gray-700 transition shrink-0"
            >
              <X size={16} />
            </button>
            <div className="min-w-0">
              <div className="text-[11px] text-gray-400 font-mono truncate leading-none mb-1">{solicitudId}</div>
              {solicitud ? (
                <span className={`inline-flex rounded-full border px-2.5 py-0.5 text-[11px] font-semibold ${estadoClass(solicitud.estado)}`}>
                  {statusLabel(solicitud.estado)}
                </span>
              ) : (
                <span className="inline-block h-5 w-20 rounded-full bg-gray-100 animate-pulse" />
              )}
            </div>
          </div>
          <Link
            href={`/panel/gestor/solicitudes/${solicitudId}`}
            target="_blank"
            className="inline-flex shrink-0 items-center gap-1.5 rounded-lg border border-gray-200 bg-white px-2.5 py-1.5 text-xs font-medium text-gray-600 hover:bg-gray-50 transition"
          >
            <ExternalLink size={12} />
            Ver página
          </Link>
        </div>

        {/* Contenido */}
        <div className="flex-1 overflow-y-auto bg-gray-50">
          {loading && (
            <div className="p-6 space-y-3">
              {[1,2,3].map(i => (
                <div key={i} className="h-24 rounded-xl bg-white border border-gray-200 animate-pulse" />
              ))}
            </div>
          )}
          {err && !loading && (
            <div className="m-4 rounded-xl border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700">{err}</div>
          )}

          {solicitud && (
            <div className="p-4 space-y-3">

              {/* Timeline operativo */}
              {(() => {
                const est = solicitud.estado
                const estadoAceptacion = solicitud.asignacion?.estadoAceptacion
                const timeline = [
                  { title: 'Creada',       done: true,  current: false, subtitle: formatDateTime(solicitud.createdAt) },
                  {
                    title: 'Confirmada',
                    done: ['confirmada','asignada','en_camino_retiro','retirado','en_camino_entrega','entregado'].includes(est || ''),
                    current: est === 'pendiente_confirmacion',
                    subtitle: solicitud.confirmacion?.confirmadoAt ? formatDateTime(solicitud.confirmacion.confirmadoAt) : undefined,
                  },
                  {
                    title: 'Asignada',
                    done: ['asignada','en_camino_retiro','retirado','en_camino_entrega','entregado'].includes(est || ''),
                    current: est === 'confirmada',
                    subtitle: solicitud.asignacion?.asignadoAt ? formatDateTime(solicitud.asignacion.asignadoAt) : undefined,
                  },
                  {
                    title: 'Aceptada motorizado',
                    done: ['en_camino_retiro','retirado','en_camino_entrega','entregado'].includes(est || '') || estadoAceptacion === 'aceptada',
                    current: est === 'asignada',
                    subtitle: solicitud.asignacion?.aceptadoAt ? formatDateTime(solicitud.asignacion.aceptadoAt) : estadoAceptacion || undefined,
                  },
                  {
                    title: 'Retiro en proceso',
                    done: ['retirado','en_camino_entrega','entregado'].includes(est || ''),
                    current: est === 'en_camino_retiro',
                    subtitle: solicitud.historial?.en_camino_retiroAt ? formatDateTime(solicitud.historial.en_camino_retiroAt) : undefined,
                  },
                  {
                    title: 'Paquete retirado',
                    done: ['retirado','en_camino_entrega','entregado'].includes(est || ''),
                    current: est === 'retirado',
                    subtitle: solicitud.historial?.retiradoAt ? formatDateTime(solicitud.historial.retiradoAt) : undefined,
                  },
                  {
                    title: 'En camino entrega',
                    done: est === 'entregado',
                    current: est === 'en_camino_entrega',
                    subtitle: solicitud.historial?.en_camino_entregaAt ? formatDateTime(solicitud.historial.en_camino_entregaAt) : undefined,
                  },
                  {
                    title: 'Entregado',
                    done: est === 'entregado',
                    current: false,
                    subtitle: solicitud.historial?.entregadoAt ? formatDateTime(solicitud.historial.entregadoAt) : (solicitud as any).entregadoAt ? formatDateTime((solicitud as any).entregadoAt) : undefined,
                  },
                ]
                return (
                  <Section title="Timeline operativo" accent="blue">
                    <div className="grid grid-cols-2 gap-x-6 gap-y-3">
                      {timeline.map((step, i) => (
                        <div key={step.title} className="flex items-start gap-2.5">
                          <div className={`mt-0.5 flex h-5 w-5 shrink-0 items-center justify-center rounded-full text-[10px] font-bold ring-2 ${
                            step.current
                              ? 'ring-blue-300 bg-blue-100 text-blue-700'
                              : step.done
                              ? 'ring-green-300 bg-green-100 text-green-700'
                              : 'ring-gray-200 bg-white text-gray-300'
                          }`}>
                            {step.done ? '✓' : i + 1}
                          </div>
                          <div className="min-w-0">
                            <div className={`text-xs font-medium leading-tight ${step.current ? 'text-blue-700' : step.done ? 'text-gray-800' : 'text-gray-400'}`}>
                              {step.title}
                            </div>
                            {step.subtitle && (
                              <div className="text-[10px] text-gray-400 mt-0.5 leading-tight">{step.subtitle}</div>
                            )}
                          </div>
                        </div>
                      ))}
                    </div>
                  </Section>
                )
              })()}

              {/* Tiempo restante */}
              {tiempoRestante !== null && (
                <div className={`flex items-center gap-2.5 rounded-xl border px-4 py-3 text-sm font-semibold ${
                  minLeft !== null && minLeft <= 2
                    ? 'border-red-200 bg-red-50 text-red-700'
                    : 'border-amber-200 bg-amber-50 text-amber-800'
                }`}>
                  <Clock3 size={16} className="shrink-0" />
                  <span>
                    {Math.floor(Math.max(0, tiempoRestante) / 60000)}:{String(Math.floor((Math.max(0, tiempoRestante) % 60000) / 1000)).padStart(2, '0')}
                    <span className="font-normal ml-1 text-xs opacity-75">restantes</span>
                  </span>
                </div>
              )}

              {/* Retiro */}
              <Section title="Retiro" accent="orange">
                <div className="space-y-2.5">
                  <div className="flex items-start gap-3">
                    <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-orange-100 text-orange-500">
                      <MapPin size={15} />
                    </div>
                    <div className="min-w-0 flex-1">
                      <div className="text-sm font-semibold text-gray-900 leading-tight">{solicitud.recoleccion?.nombreApellido || '—'}</div>
                      {solicitud.recoleccion?.celular && (
                        <div className="mt-0.5 inline-flex items-center gap-1 rounded-full bg-gray-100 px-2 py-0.5 text-xs text-gray-600">
                          <Phone size={10} />{solicitud.recoleccion.celular}
                        </div>
                      )}
                      {solicitud.recoleccion?.direccionEscrita && (
                        <div className="mt-1 text-xs text-gray-500 leading-snug">{solicitud.recoleccion.direccionEscrita}</div>
                      )}
                      {solicitud.recoleccion?.nota && (
                        <div className="mt-1 rounded-lg bg-orange-50 border border-orange-100 px-2.5 py-1.5 text-xs text-orange-700 italic">{solicitud.recoleccion.nota}</div>
                      )}
                    </div>
                  </div>
                  {retiroMaps && (
                    <div className="flex gap-2 pt-0.5">
                      <a href={retiroMaps} target="_blank" rel="noreferrer"
                        className="inline-flex items-center gap-1.5 rounded-lg border border-blue-200 bg-blue-50 px-3 py-1.5 text-xs font-medium text-blue-700 hover:bg-blue-100 transition">
                        <ExternalLink size={11} /> Ver en Maps
                      </a>
                      <button onClick={() => copyToClipboard(retiroMaps)}
                        className="inline-flex items-center gap-1.5 rounded-lg border border-gray-200 bg-white px-3 py-1.5 text-xs font-medium text-gray-600 hover:bg-gray-50 transition">
                        <Copy size={11} /> Copiar
                      </button>
                    </div>
                  )}
                </div>
              </Section>

              {/* Entrega */}
              <Section title="Entrega" accent="emerald">
                <div className="space-y-2.5">
                  <div className="flex items-start gap-3">
                    <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-emerald-100 text-emerald-600">
                      <Package size={15} />
                    </div>
                    <div className="min-w-0 flex-1">
                      <div className="text-sm font-semibold text-gray-900 leading-tight">{solicitud.entrega?.nombreApellido || '—'}</div>
                      {solicitud.entrega?.celular && (
                        <div className="mt-0.5 inline-flex items-center gap-1 rounded-full bg-gray-100 px-2 py-0.5 text-xs text-gray-600">
                          <Phone size={10} />{solicitud.entrega.celular}
                        </div>
                      )}
                      {solicitud.cobroContraEntrega?.aplica && (
                        <div className="mt-1 inline-flex items-center gap-1 rounded-full bg-emerald-50 border border-emerald-200 px-2 py-0.5 text-xs font-semibold text-emerald-700">
                          CE: {money(solicitud.cobroContraEntrega.monto)}
                        </div>
                      )}
                      {solicitud.entrega?.direccionEscrita && (
                        <div className="mt-1 text-xs text-gray-500 leading-snug">{solicitud.entrega.direccionEscrita}</div>
                      )}
                      {solicitud.entrega?.nota && (
                        <div className="mt-1 rounded-lg bg-emerald-50 border border-emerald-100 px-2.5 py-1.5 text-xs text-emerald-700 italic">{solicitud.entrega.nota}</div>
                      )}
                    </div>
                  </div>
                  {entregaMaps && (
                    <div className="flex gap-2 pt-0.5">
                      <a href={entregaMaps} target="_blank" rel="noreferrer"
                        className="inline-flex items-center gap-1.5 rounded-lg border border-blue-200 bg-blue-50 px-3 py-1.5 text-xs font-medium text-blue-700 hover:bg-blue-100 transition">
                        <ExternalLink size={11} /> Ver en Maps
                      </a>
                      <button onClick={() => copyToClipboard(entregaMaps)}
                        className="inline-flex items-center gap-1.5 rounded-lg border border-gray-200 bg-white px-3 py-1.5 text-xs font-medium text-gray-600 hover:bg-gray-50 transition">
                        <Copy size={11} /> Copiar
                      </button>
                    </div>
                  )}
                </div>
              </Section>

              {/* Resumen comercial */}
              <Section title="Resumen comercial" accent="amber">
                <div className="grid grid-cols-2 gap-x-4 gap-y-3">
                  <InfoRow label="Comercio" value={solicitud.ownerSnapshot?.companyName || solicitud.ownerSnapshot?.nombre || (solicitud.userId ? comercioNames[solicitud.userId] : undefined)} />
                  <InfoRow label="Tipo cliente" value={solicitud.tipoCliente} />
                  <InfoRow label="Distancia" value={solicitud.cotizacion?.distanciaKm != null ? `${solicitud.cotizacion.distanciaKm} km` : undefined} />
                  <InfoRow label="Precio sugerido" value={solicitud.cotizacion?.precioSugerido != null ? money(solicitud.cotizacion.precioSugerido) : solicitud.pagoDelivery?.montoSugerido != null ? money(solicitud.pagoDelivery.montoSugerido) : undefined} />
                  <InfoRow label="Precio final" value={solicitud.confirmacion?.precioFinalCordobas != null ? money(solicitud.confirmacion.precioFinalCordobas) : undefined} />
                  <InfoRow label="Cobro CE" value={solicitud.cobroContraEntrega?.aplica ? money(solicitud.cobroContraEntrega.monto) : 'No aplica'} />
                  <InfoRow label="Quién paga delivery" value={solicitud.tipoCliente === 'credito' ? 'Crédito semanal' : solicitud.pagoDelivery?.quienPaga} />
                  <InfoRow label="Creada" value={formatDateTime(solicitud.createdAt)} />
                </div>
                {solicitud.detalle?.trim() && (
                  <div className="mt-1 rounded-lg border border-amber-100 bg-amber-50 p-3 text-xs text-amber-800 whitespace-pre-wrap leading-relaxed">{solicitud.detalle.trim()}</div>
                )}
              </Section>

              {/* Motorizado actual */}
              {solicitud.asignacion?.motorizadoNombre && (
                <Section title="Motorizado asignado" accent="indigo">
                  <div className="flex items-start gap-3">
                    <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-indigo-100 text-indigo-600">
                      <Bike size={15} />
                    </div>
                    <div className="flex-1 min-w-0">
                      <div className="text-sm font-semibold text-gray-900">{solicitud.asignacion.motorizadoNombre}</div>
                      {solicitud.asignacion.motorizadoTelefono && (
                        <div className="mt-0.5 inline-flex items-center gap-1 rounded-full bg-gray-100 px-2 py-0.5 text-xs text-gray-600">
                          <Phone size={10} />{solicitud.asignacion.motorizadoTelefono}
                        </div>
                      )}
                      <div className="mt-1.5 grid grid-cols-2 gap-x-4 gap-y-1.5">
                        <InfoRow label="Asignado" value={formatDateTime(solicitud.asignacion.asignadoAt)} />
                        <InfoRow label="Aceptación" value={solicitud.asignacion.estadoAceptacion} />
                        {solicitud.asignacion.motivoRechazo && (
                          <InfoRow label="Motivo rechazo" value={solicitud.asignacion.motivoRechazo} />
                        )}
                      </div>
                    </div>
                  </div>
                </Section>
              )}

              {/* Depósito */}
              {(() => {
                const dep = solicitud.registro?.deposito
                if (!dep) return null
                const tieneInfo = dep.confirmadoComercio || dep.confirmadoStorkhub || dep.confirmadoMotorizado
                if (!tieneInfo) return null
                return (
                  <Section title="Depósito" accent="teal">
                    <div className="grid grid-cols-2 gap-x-4 gap-y-3">
                      {dep.confirmadoStorkhub && (
                        <>
                          <InfoRow label="Storkhub" value="✓ Confirmado" />
                          <InfoRow label="Fecha Storkhub" value={formatDateTime(dep.confirmadoStorkhubAt)} />
                        </>
                      )}
                      {dep.confirmadoComercio && (
                        <>
                          <InfoRow label="Comercio" value="✓ Confirmado" />
                          <InfoRow label="Fecha Comercio" value={formatDateTime(dep.confirmadoComercioAt)} />
                        </>
                      )}
                      {dep.confirmadoMotorizado && !dep.confirmadoStorkhub && !dep.confirmadoComercio && (
                        <>
                          <InfoRow label="Confirmado (legacy)" value="✓ Sí" />
                          <InfoRow label="Fecha" value={formatDateTime(dep.confirmadoAt)} />
                        </>
                      )}
                    </div>
                  </Section>
                )
              })()}

              {/* Evidencias fotográficas */}
              {solicitud.evidencias && (['retiro', 'entrega', 'deposito'] as const).some((k) => solicitud.evidencias?.[k]) && (
                <Section title="Evidencias fotográficas" accent="purple">
                  <div className="grid grid-cols-3 gap-2">
                    {([
                      { key: 'retiro',  label: 'Retiro' },
                      { key: 'entrega', label: 'Entrega' },
                      { key: 'deposito', label: 'Boucher' },
                    ] as const).map(({ key, label }) => {
                      const ev = solicitud.evidencias?.[key]
                      if (!ev) return null
                      return (
                        <button
                          key={key}
                          onClick={() => window.open(ev.url, '_blank')}
                          className="flex flex-col items-center gap-1.5 rounded-xl border border-gray-200 bg-gray-50 p-1.5 hover:bg-gray-100 hover:border-gray-300 transition cursor-pointer"
                        >
                          {/* eslint-disable-next-line @next/next/no-img-element */}
                          <img src={ev.url} alt={label} className="w-full aspect-square object-cover rounded-lg" loading="lazy" />
                          <span className="text-[10px] font-medium text-gray-500 uppercase tracking-wide">{label}</span>
                        </button>
                      )
                    })}
                  </div>
                </Section>
              )}

              {/* Motorizado sugerido */}
              {(estado === 'pendiente_confirmacion' || estado === 'confirmada') &&
                rankingCalculado.length > 0 && (
                  <Section title="Motorizado sugerido" accent="indigo">
                    {(() => {
                      const top = rankingCalculado[0]
                      return (
                        <div className="rounded-xl border border-indigo-200 bg-indigo-50 p-3 space-y-2.5">
                          <div className="flex items-center justify-between">
                            <div className="flex items-center gap-2 min-w-0">
                              <Star size={13} className="text-indigo-500 shrink-0" />
                              <span className="text-sm font-bold text-indigo-900 truncate">{top.nombre}</span>
                              {top.telefono && (
                                <span className="text-xs text-indigo-400 shrink-0">{top.telefono}</span>
                              )}
                            </div>
                            <span className="text-xs font-black text-indigo-700 bg-indigo-100 border border-indigo-200 rounded-full px-2.5 py-0.5 shrink-0 ml-2">
                              {top.scoreResult.score} pts
                            </span>
                          </div>
                          <p className="text-xs text-indigo-700 leading-relaxed">
                            {top.scoreResult.explicacion}
                          </p>
                          <button
                            onClick={() => setMotorizadoSel(top.id)}
                            className="w-full inline-flex items-center justify-center gap-2 rounded-lg bg-indigo-600 px-3 py-2 text-sm font-semibold text-white hover:bg-indigo-700 transition"
                          >
                            <Bike size={13} /> Asignar sugerido
                          </button>
                        </div>
                      )
                    })()}
                  </Section>
                )}

              {/* Decisión rápida */}
              <Section title="Decisión rápida" accent="blue">
                <div className="space-y-3">
                  <div>
                    <label className="block text-[10px] font-bold uppercase tracking-wide text-gray-400 mb-1.5">Precio final (C$)</label>
                    <input
                      type="number"
                      step={10}
                      value={precioFinal}
                      onChange={(e) => setPrecioFinal(e.target.value === '' ? '' : roundTo10(e.target.value))}
                      className="w-full rounded-lg border border-gray-200 px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-blue-200 focus:border-blue-300"
                      placeholder="Ej: 130"
                    />
                    <div className="text-[10px] text-gray-400 mt-1">Se redondea a múltiplos de 10</div>
                  </div>

                  <div>
                    <label className="block text-[10px] font-bold uppercase tracking-wide text-gray-400 mb-1.5">
                      Motorizado
                      {loadingOrdenes && (
                        <span className="ml-1 text-gray-300 font-normal normal-case">(calculando scores…)</span>
                      )}
                    </label>
                    <select
                      value={motorizadoSel}
                      onChange={(e) => setMotorizadoSel(e.target.value)}
                      className="w-full rounded-lg border border-gray-200 px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-blue-200"
                    >
                      <option value="">— No asignar todavía —</option>
                      {(() => {
                        const scoreMap = new Map(rankingCalculado.map((r) => [r.id, r.scoreResult.score]))
                        const ordenMostrar = rankingCalculado.length > 0 ? rankingCalculado : motorizados
                        return ordenMostrar.map((m) => {
                          const score = scoreMap.get(m.id)
                          const scoreLabel = score !== undefined ? ` [${score}]` : ''
                          return (
                            <option key={m.id} value={m.id}>
                              {m.estado === 'disponible' ? '✅ ' : '⛔ '}{m.nombre}{m.telefono ? ` · ${m.telefono}` : ''}{scoreLabel}
                            </option>
                          )
                        })
                      })()}
                    </select>
                    {rankingCalculado.length > 0 && (
                      <div className="text-[10px] text-gray-400 mt-1">Ordenados por score · [100] = ideal</div>
                    )}
                  </div>

                  <div className="space-y-2 pt-1">
                    <button
                      onClick={confirmarYAsignar}
                      className="w-full inline-flex items-center justify-center gap-2 rounded-xl bg-[#004aad] px-4 py-2.5 text-sm font-semibold text-white hover:bg-[#003d94] transition shadow-sm"
                    >
                      <CheckCircle2 size={15} /> Guardar confirmación / asignación
                    </button>

                    {estado === 'pendiente_confirmacion' && (
                      <button
                        onClick={() => cambiarEstado('rechazada')}
                        className="w-full inline-flex items-center justify-center gap-2 rounded-xl border border-red-200 bg-red-50 px-4 py-2.5 text-sm font-semibold text-red-700 hover:bg-red-100 transition"
                      >
                        <XCircle size={15} /> Rechazar orden
                      </button>
                    )}
                    {estado === 'confirmada' && (
                      <button
                        onClick={() => cambiarEstado('cancelada')}
                        className="w-full inline-flex items-center justify-center gap-2 rounded-xl border border-gray-200 bg-white px-4 py-2.5 text-sm font-semibold text-gray-700 hover:bg-gray-50 transition"
                      >
                        <AlertTriangle size={15} /> Cancelar
                      </button>
                    )}
                    {estado === 'asignada' && (
                      <button
                        onClick={rebotarAsignacion}
                        className="w-full inline-flex items-center justify-center gap-2 rounded-xl border border-gray-200 bg-white px-4 py-2.5 text-sm font-semibold text-gray-700 hover:bg-gray-50 transition"
                      >
                        <RotateCcw size={15} /> Rebotar a confirmada
                      </button>
                    )}
                    {estado === 'en_camino_retiro' && (
                      <button
                        onClick={() => cambiarEstado('retirado')}
                        className="w-full inline-flex items-center justify-center gap-2 rounded-xl border border-gray-200 bg-white px-4 py-2.5 text-sm font-semibold text-gray-700 hover:bg-gray-50 transition"
                      >
                        <Package size={15} /> Marcar retirado
                      </button>
                    )}
                    {estado === 'retirado' && (
                      <button
                        onClick={() => cambiarEstado('en_camino_entrega')}
                        className="w-full inline-flex items-center justify-center gap-2 rounded-xl border border-gray-200 bg-white px-4 py-2.5 text-sm font-semibold text-gray-700 hover:bg-gray-50 transition"
                      >
                        <Truck size={15} /> Pasar a entrega
                      </button>
                    )}
                    {estado === 'en_camino_entrega' && (
                      <button
                        onClick={() => cambiarEstado('entregado')}
                        className="w-full inline-flex items-center justify-center gap-2 rounded-xl border border-green-200 bg-green-50 px-4 py-2.5 text-sm font-semibold text-green-700 hover:bg-green-100 transition"
                      >
                        <CheckCheck size={15} /> Marcar entregado
                      </button>
                    )}
                  </div>

                  {err && (
                    <div className="rounded-xl border border-red-200 bg-red-50 px-3 py-2 text-xs text-red-700">{err}</div>
                  )}
                </div>
              </Section>

            </div>
          )}
        </div>
      </div>
    </>
  )
}
