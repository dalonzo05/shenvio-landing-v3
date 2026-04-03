'use client'

import React, { useEffect, useMemo, useRef, useState } from 'react'
import Link from 'next/link'
import {
  collection,
  onSnapshot,
  orderBy,
  query,
  updateDoc,
  doc,
  getDoc,
  where,
  Timestamp,
  getDocs,
  serverTimestamp,
} from 'firebase/firestore'
import { db, auth } from '@/fb/config'
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
} from 'lucide-react'

// ─── Shared Types ─────────────────────────────────────────────────────────────

type EstadoSolicitud =
  | 'pendiente_confirmacion' | 'confirmada' | 'rechazada' | 'asignada'
  | 'en_camino_retiro' | 'retirado' | 'en_camino_entrega' | 'entregado' | 'cancelada'

type Registro = {
  semana?: number
  zona?: string
  pago?: { realizo?: boolean; esCash?: boolean }
  deposito?: { fecha?: Timestamp | null; monto?: number | null; formaPago?: string | null; confirmadoMotorizado?: boolean; confirmadoAt?: Timestamp | null; confirmadoComercio?: boolean; confirmadoComercioAt?: Timestamp | null; confirmadoStorkhub?: boolean; confirmadoStorkhubAt?: Timestamp | null }
  csRecaudado?: number
  usdRecaudado?: number
  numEntregas?: number
}

type Solicitud = {
  id: string
  createdAt?: Timestamp
  updatedAt?: Timestamp
  estado?: EstadoSolicitud
  tipoCliente?: 'contado' | 'credito'
  tieneCotizacion?: boolean
  recoleccion?: {
    nombreApellido?: string
    celular?: string
    direccionEscrita?: string
    nota?: string | null
    puntoGoogleTexto?: string | null
    puntoGoogleLink?: string | null
    puntoGoogleTipo?: 'referencial' | 'exacto'
    coord?: { lat: number; lng: number } | null
  }
  entrega?: {
    nombreApellido?: string
    celular?: string
    direccionEscrita?: string
    nota?: string | null
    puntoGoogleTexto?: string | null
    puntoGoogleLink?: string | null
    puntoGoogleTipo?: 'referencial' | 'exacto'
    coord?: { lat: number; lng: number } | null
  }
  cobroContraEntrega?: { aplica?: boolean; monto?: number }
  pagoDelivery?: {
    tipo?: string
    quienPaga?: string
    montoSugerido?: number | null
    deducirDelCobroContraEntrega?: boolean
  }
  cotizacion?: {
    distanciaKm?: number | null
    precioSugerido?: number | null
    origenCoord?: { lat: number; lng: number } | null
    destinoCoord?: { lat: number; lng: number } | null
  }
  confirmacion?: { precioFinalCordobas?: number; confirmadoPorUid?: string; confirmadoAt?: any }
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
  detalle?: string
  historial?: {
    en_camino_retiroAt?: any
    retiradoAt?: any
    en_camino_entregaAt?: any
    entregadoAt?: any
  }
  userId?: string
  ownerSnapshot?: { companyName?: string; phone?: string; nombre?: string; uid?: string }
  cobrosMotorizado?: {
    delivery?: { monto: number; recibio: boolean; at?: any; justificacion?: string }
    producto?: { monto: number; recibio: boolean; at?: any; justificacion?: string }
    resolucion?: { resueltoPor: string; at?: any; nota?: string }
  }
  registro?: Registro
}

type Motorizado = { id: string; nombre: string; telefono?: string; estado?: string; authUid?: string }

// ─── Helpers ──────────────────────────────────────────────────────────────────

function getWeekNumber(date: Date): number {
  const d = new Date(Date.UTC(date.getFullYear(), date.getMonth(), date.getDate()))
  d.setUTCDate(d.getUTCDate() + 4 - (d.getUTCDay() || 7))
  const yearStart = new Date(Date.UTC(d.getUTCFullYear(), 0, 1))
  return Math.ceil(((d.getTime() - yearStart.getTime()) / 86400000 + 1) / 7)
}

function formatDate(ts?: Timestamp | null): string {
  if (!ts) return '—'
  return ts.toDate().toLocaleDateString('es-NI', { day: '2-digit', month: '2-digit', year: 'numeric' })
}

function formatDateTime(ts: any): string {
  if (!ts) return '—'
  const d = typeof ts?.toDate === 'function' ? ts.toDate() : ts instanceof Date ? ts : null
  if (!d) return '—'
  return d.toLocaleString()
}

function money(n: any): string {
  const v = Number(n)
  return Number.isFinite(v) ? `C$ ${v}` : '—'
}

function getPrecio(s: Solicitud): number | null {
  return s.confirmacion?.precioFinalCordobas ?? s.pagoDelivery?.montoSugerido ?? s.cotizacion?.precioSugerido ?? null
}

function getBestMapsUrl(s: Solicitud, tipo: 'recoleccion' | 'entrega'): string | null {
  const coord = tipo === 'recoleccion' ? s.cotizacion?.origenCoord : s.cotizacion?.destinoCoord
  if (coord) return `https://www.google.com/maps?q=${coord.lat},${coord.lng}`
  const link = tipo === 'recoleccion' ? s.recoleccion?.puntoGoogleLink : s.entrega?.puntoGoogleLink
  if (link?.trim()) return link.trim()
  const texto = tipo === 'recoleccion' ? s.recoleccion?.puntoGoogleTexto : s.entrega?.puntoGoogleTexto
  if (texto) return `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(texto)}`
  const dir = tipo === 'recoleccion' ? s.recoleccion?.direccionEscrita : s.entrega?.direccionEscrita
  return dir ? `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(dir)}` : null
}

async function copyToClipboard(text: string) {
  try { await navigator.clipboard.writeText(text) } catch {
    const ta = document.createElement('textarea')
    ta.value = text; document.body.appendChild(ta); ta.select()
    document.execCommand('copy'); document.body.removeChild(ta)
  }
}

function statusLabel(e?: EstadoSolicitud): string {
  const map: Record<string, string> = {
    pendiente_confirmacion: 'Pendiente', confirmada: 'Confirmada', rechazada: 'Rechazada',
    asignada: 'Asignada', en_camino_retiro: 'En camino retiro', retirado: 'Retirado',
    en_camino_entrega: 'En camino entrega', entregado: 'Entregado', cancelada: 'Cancelada',
  }
  return e ? (map[e] || e) : '—'
}

function estadoClass(e?: EstadoSolicitud): string {
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

function roundTo10(n: any): number { return Math.round(Number(n) / 10) * 10 }

// ─── Drawer de detalle ────────────────────────────────────────────────────────

function SolicitudDrawer({
  solicitudId,
  onClose,
  comercioNames = {},
}: {
  solicitudId: string
  onClose: () => void
  comercioNames?: Record<string, string>
}) {
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
    getDocs(query(collection(db, 'motorizado'))).then((snap) => {
      setMotorizados(
        snap.docs
          .map((d) => ({ id: d.id, ...(d.data() as any) }))
          .sort((a, b) => (b.estado === 'disponible' ? 1 : 0) - (a.estado === 'disponible' ? 1 : 0))
      )
    })
  }, [])

  useEffect(() => {
    setLoading(true)
    const unsub = onSnapshot(
      doc(db, 'solicitudes_envio', solicitudId),
      (snap) => {
        if (!snap.exists()) { setErr('La orden no existe.'); setLoading(false); return }
        const data = { id: snap.id, ...(snap.data() as any) } as Solicitud
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
      <div
        className="fixed inset-0 z-40 bg-black/20"
        onClick={onClose}
      />

      {/* Panel */}
      <div className="fixed right-0 top-0 z-50 flex h-full w-full max-w-[520px] flex-col bg-white shadow-2xl">
        {/* Header */}
        <div className="flex items-center justify-between border-b px-5 py-4">
          <div className="flex items-center gap-3">
            <button onClick={onClose} className="rounded-lg p-1.5 hover:bg-gray-100">
              <X size={18} />
            </button>
            <div>
              <div className="text-xs text-gray-400 font-mono">{solicitudId}</div>
              {solicitud && (
                <span className={`inline-flex rounded-full border px-2.5 py-0.5 text-xs font-medium mt-0.5 ${estadoClass(solicitud.estado)}`}>
                  {statusLabel(solicitud.estado)}
                </span>
              )}
            </div>
          </div>
          <Link
            href={`/panel/gestor/solicitudes/${solicitudId}`}
            target="_blank"
            className="inline-flex items-center gap-1.5 rounded-lg border px-3 py-1.5 text-xs font-medium text-gray-700 hover:bg-gray-50"
          >
            <ExternalLink size={13} />
            Pantalla completa
          </Link>
        </div>

        {/* Contenido */}
        <div className="flex-1 overflow-y-auto">
          {loading && <div className="p-6 text-sm text-gray-400">Cargando...</div>}
          {err && <div className="m-4 rounded-xl border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700">{err}</div>}

          {solicitud && (
            <div className="p-5 space-y-5">
              {/* Timeline operativo */}
              {(() => {
                const est = solicitud.estado
                const estadoAceptacion = solicitud.asignacion?.estadoAceptacion
                const timeline = [
                  { title: 'Creada', done: true, current: false, subtitle: formatDateTime(solicitud.createdAt) },
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
                    title: 'Aceptada por motorizado',
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
                    title: 'En camino a entrega',
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
                  <Section title="🗂 Timeline operativo">
                    <div className="grid grid-cols-2 gap-x-4 gap-y-3 pt-1">
                      {timeline.map((step) => (
                        <div key={step.title} className="flex items-start gap-2">
                          <div className={`mt-0.5 flex h-6 w-6 shrink-0 items-center justify-center rounded-full border text-xs font-bold ${
                            step.current
                              ? 'border-blue-300 bg-blue-50 text-blue-700'
                              : step.done
                              ? 'border-green-300 bg-green-50 text-green-700'
                              : 'border-gray-200 bg-white text-gray-400'
                          }`}>
                            {step.done ? '✓' : '•'}
                          </div>
                          <div>
                            <div className={`text-xs font-medium ${step.current || step.done ? 'text-gray-900' : 'text-gray-400'}`}>
                              {step.title}
                            </div>
                            {step.subtitle && (
                              <div className="text-[11px] text-gray-500 mt-0.5">{step.subtitle}</div>
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
                <div className={`flex items-center gap-2 rounded-xl border px-4 py-3 text-sm font-medium ${minLeft !== null && minLeft <= 2 ? 'border-red-200 bg-red-50 text-red-700' : 'border-yellow-200 bg-yellow-50 text-yellow-800'}`}>
                  <Clock3 size={15} />
                  {Math.floor(Math.max(0, tiempoRestante) / 60000)}:{String(Math.floor((Math.max(0, tiempoRestante) % 60000) / 1000)).padStart(2, '0')} restantes
                </div>
              )}

              {/* Retiro */}
              <Section title="📍 Retiro">
                <InfoRow label="Nombre" value={solicitud.recoleccion?.nombreApellido} />
                <InfoRow label="Teléfono" value={solicitud.recoleccion?.celular} icon={<Phone size={13} />} />
                <InfoRow label="Dirección" value={solicitud.recoleccion?.direccionEscrita} icon={<MapPin size={13} />} />
                {solicitud.recoleccion?.nota && <InfoRow label="Nota" value={solicitud.recoleccion.nota} />}
                {retiroMaps && (
                  <div className="flex gap-2 pt-1">
                    <a href={retiroMaps} target="_blank" rel="noreferrer" className="inline-flex items-center gap-1.5 rounded-lg border px-3 py-1.5 text-xs text-blue-700 hover:bg-gray-50">
                      <ExternalLink size={12} /> Maps
                    </a>
                    <button onClick={() => copyToClipboard(retiroMaps)} className="inline-flex items-center gap-1.5 rounded-lg border px-3 py-1.5 text-xs text-gray-700 hover:bg-gray-50">
                      <Copy size={12} /> Copiar link
                    </button>
                  </div>
                )}
              </Section>

              {/* Entrega */}
              <Section title="📦 Entrega">
                <InfoRow label="Nombre" value={solicitud.entrega?.nombreApellido} />
                <InfoRow label="Teléfono" value={solicitud.entrega?.celular} icon={<Phone size={13} />} />
                <InfoRow label="Dirección" value={solicitud.entrega?.direccionEscrita} icon={<MapPin size={13} />} />
                {solicitud.entrega?.nota && <InfoRow label="Nota" value={solicitud.entrega.nota} />}
                {entregaMaps && (
                  <div className="flex gap-2 pt-1">
                    <a href={entregaMaps} target="_blank" rel="noreferrer" className="inline-flex items-center gap-1.5 rounded-lg border px-3 py-1.5 text-xs text-blue-700 hover:bg-gray-50">
                      <ExternalLink size={12} /> Maps
                    </a>
                    <button onClick={() => copyToClipboard(entregaMaps)} className="inline-flex items-center gap-1.5 rounded-lg border px-3 py-1.5 text-xs text-gray-700 hover:bg-gray-50">
                      <Copy size={12} /> Copiar link
                    </button>
                  </div>
                )}
              </Section>

              {/* Resumen comercial */}
              <Section title="💰 Resumen comercial">
                <div className="grid grid-cols-2 gap-x-4 gap-y-3">
                  <InfoRow label="Comercio" value={solicitud.ownerSnapshot?.companyName || solicitud.ownerSnapshot?.nombre || (solicitud.userId ? comercioNames[solicitud.userId] : undefined)} />
                  <InfoRow label="Tipo" value={solicitud.tipoCliente} />
                  <InfoRow label="Distancia" value={solicitud.cotizacion?.distanciaKm != null ? `${solicitud.cotizacion.distanciaKm} km` : undefined} />
                  <InfoRow label="Precio sugerido" value={solicitud.cotizacion?.precioSugerido != null ? money(solicitud.cotizacion.precioSugerido) : solicitud.pagoDelivery?.montoSugerido != null ? money(solicitud.pagoDelivery.montoSugerido) : undefined} />
                  <InfoRow label="Precio final" value={solicitud.confirmacion?.precioFinalCordobas != null ? money(solicitud.confirmacion.precioFinalCordobas) : undefined} />
                  <InfoRow label="Cobro CE" value={solicitud.cobroContraEntrega?.aplica ? money(solicitud.cobroContraEntrega.monto) : 'No aplica'} />
                  <InfoRow label="Quién paga delivery" value={solicitud.tipoCliente === 'credito' ? 'Crédito semanal' : solicitud.pagoDelivery?.quienPaga} />
                  <InfoRow label="Creada" value={formatDateTime(solicitud.createdAt)} />
                </div>
                {solicitud.detalle?.trim() && (
                  <div className="mt-3 rounded-xl border bg-gray-50 p-3 text-sm text-gray-700 whitespace-pre-wrap">{solicitud.detalle.trim()}</div>
                )}
              </Section>

              {/* Motorizado actual */}
              {solicitud.asignacion?.motorizadoNombre && (
                <Section title="🛵 Motorizado asignado">
                  <InfoRow label="Nombre" value={solicitud.asignacion.motorizadoNombre} icon={<Bike size={13} />} />
                  <InfoRow label="Teléfono" value={solicitud.asignacion.motorizadoTelefono} />
                  <InfoRow label="Asignado" value={formatDateTime(solicitud.asignacion.asignadoAt)} />
                  <InfoRow label="Aceptación" value={solicitud.asignacion.estadoAceptacion} />
                  {solicitud.asignacion.motivoRechazo && <InfoRow label="Motivo rechazo" value={solicitud.asignacion.motivoRechazo} />}
                </Section>
              )}

              {/* Decisión rápida */}
              <Section title="⚡ Decisión rápida">
                <div className="space-y-3">
                  <div>
                    <label className="block text-xs font-medium text-gray-700 mb-1">Precio final (C$)</label>
                    <input
                      type="number"
                      step={10}
                      value={precioFinal}
                      onChange={(e) => setPrecioFinal(e.target.value === '' ? '' : roundTo10(e.target.value))}
                      className="w-full rounded-lg border px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-blue-200"
                      placeholder="Ej: 130"
                    />
                    <div className="text-xs text-gray-400 mt-1">Se redondea a múltiplos de 10.</div>
                  </div>

                  <div>
                    <label className="block text-xs font-medium text-gray-700 mb-1">Motorizado</label>
                    <select
                      value={motorizadoSel}
                      onChange={(e) => setMotorizadoSel(e.target.value)}
                      className="w-full rounded-lg border px-3 py-2 text-sm focus:outline-none"
                    >
                      <option value="">-- No asignar todavía --</option>
                      {motorizados.map((m) => (
                        <option key={m.id} value={m.id}>
                          {m.estado === 'disponible' ? '✅ ' : '⛔ '}{m.nombre}{m.telefono ? ` · ${m.telefono}` : ''}
                        </option>
                      ))}
                    </select>
                  </div>

                  <div className="space-y-2 pt-1">
                    <button onClick={confirmarYAsignar} className="w-full inline-flex items-center justify-center gap-2 rounded-lg bg-[#004aad] px-4 py-2.5 text-sm font-semibold text-white hover:bg-[#003d94]">
                      <CheckCircle2 size={15} /> Guardar confirmación / asignación
                    </button>

                    {estado === 'pendiente_confirmacion' && (
                      <button onClick={() => cambiarEstado('rechazada')} className="w-full inline-flex items-center justify-center gap-2 rounded-lg border border-red-200 bg-red-50 px-4 py-2.5 text-sm font-semibold text-red-700">
                        <XCircle size={15} /> Rechazar orden
                      </button>
                    )}
                    {estado === 'confirmada' && (
                      <button onClick={() => cambiarEstado('cancelada')} className="w-full inline-flex items-center justify-center gap-2 rounded-lg border px-4 py-2.5 text-sm font-semibold text-gray-700 hover:bg-gray-50">
                        <AlertTriangle size={15} /> Cancelar
                      </button>
                    )}
                    {estado === 'asignada' && (
                      <button onClick={rebotarAsignacion} className="w-full inline-flex items-center justify-center gap-2 rounded-lg border px-4 py-2.5 text-sm font-semibold text-gray-700 hover:bg-gray-50">
                        <RotateCcw size={15} /> Rebotar a confirmada
                      </button>
                    )}
                    {estado === 'en_camino_retiro' && (
                      <button onClick={() => cambiarEstado('retirado')} className="w-full inline-flex items-center justify-center gap-2 rounded-lg border px-4 py-2.5 text-sm font-semibold text-gray-700 hover:bg-gray-50">
                        <Package size={15} /> Marcar retirado
                      </button>
                    )}
                    {estado === 'retirado' && (
                      <button onClick={() => cambiarEstado('en_camino_entrega')} className="w-full inline-flex items-center justify-center gap-2 rounded-lg border px-4 py-2.5 text-sm font-semibold text-gray-700 hover:bg-gray-50">
                        <Truck size={15} /> Pasar a entrega
                      </button>
                    )}
                    {estado === 'en_camino_entrega' && (
                      <button onClick={() => cambiarEstado('entregado')} className="w-full inline-flex items-center justify-center gap-2 rounded-lg border border-green-200 bg-green-50 px-4 py-2.5 text-sm font-semibold text-green-700">
                        <CheckCheck size={15} /> Marcar entregado
                      </button>
                    )}
                  </div>
                </div>
              </Section>
            </div>
          )}
        </div>
      </div>
    </>
  )
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="rounded-2xl border border-gray-200 bg-white p-4 shadow-sm">
      <h3 className="text-sm font-semibold text-gray-900 mb-3">{title}</h3>
      <div className="space-y-2">{children}</div>
    </div>
  )
}

function InfoRow({ label, value, icon }: { label: string; value?: string | null; icon?: React.ReactNode }) {
  return (
    <div>
      <div className="text-xs text-gray-400">{label}</div>
      <div className="text-sm font-medium text-gray-900 flex items-center gap-1.5">
        {icon}{value || <span className="text-gray-300">—</span>}
      </div>
    </div>
  )
}

// ─── Inline editable cell ─────────────────────────────────────────────────────

function EditableCell({ value, onSave, type = 'text', placeholder = '—', prefix = '' }: {
  value: string | number | null | undefined
  onSave: (val: string) => void
  type?: 'text' | 'number' | 'date'
  placeholder?: string
  prefix?: string
}) {
  const [editing, setEditing] = useState(false)
  const [draft, setDraft] = useState('')
  const inputRef = useRef<HTMLInputElement>(null)

  const startEdit = () => { setDraft(value != null ? String(value) : ''); setEditing(true); setTimeout(() => inputRef.current?.focus(), 0) }
  const commit = () => { setEditing(false); if (draft !== String(value ?? '')) onSave(draft) }

  if (editing) {
    return <input ref={inputRef} type={type} value={draft} onChange={(e) => setDraft(e.target.value)} onBlur={commit} onKeyDown={(e) => { if (e.key === 'Enter') commit(); if (e.key === 'Escape') setEditing(false) }} className="w-full min-w-[80px] rounded border border-blue-400 px-1 py-0.5 text-xs focus:outline-none" />
  }

  return (
    <span onClick={startEdit} className="cursor-pointer rounded px-1 py-0.5 text-xs hover:bg-blue-50 hover:text-blue-700" title="Click para editar">
      {value != null && value !== '' ? `${prefix}${value}` : <span className="text-gray-300">{placeholder}</span>}
    </span>
  )
}

function BoolCell({ value, onToggle, labelTrue = 'Sí', labelFalse = 'No' }: {
  value: boolean | null | undefined; onToggle: (val: boolean) => void; labelTrue?: string; labelFalse?: string
}) {
  return (
    <button onClick={() => onToggle(!value)} className={`rounded px-2 py-0.5 text-xs font-medium ${value ? 'bg-green-100 text-green-700' : 'bg-gray-100 text-gray-500'}`}>
      {value ? labelTrue : labelFalse}
    </button>
  )
}

// ─── Main page ────────────────────────────────────────────────────────────────

export default function BaseDatosPage() {
  const [solicitudes, setSolicitudes] = useState<Solicitud[]>([])
  const [motorizados, setMotorizados] = useState<Motorizado[]>([])
  const [tabMotorizado, setTabMotorizado] = useState<string>('todos')
  const [search, setSearch] = useState('')
  const [loading, setLoading] = useState(true)
  const [selectedId, setSelectedId] = useState<string | null>(null)

  const [desde, setDesde] = useState<string>(() => { const d = new Date(); d.setDate(d.getDate() - 30); return d.toISOString().split('T')[0] })
  const [hasta, setHasta] = useState<string>(() => new Date().toISOString().split('T')[0])

  // Names for orders that don't have ownerSnapshot (self-created by comercio)
  const [comercioNames, setComercioNames] = useState<Record<string, string>>({})

  useEffect(() => {
    const unsub = onSnapshot(collection(db, 'motorizado'), (snap) => {
      setMotorizados(snap.docs.map((d) => ({ id: d.id, nombre: (d.data() as any).nombre || d.id, authUid: (d.data() as any).authUid })))
    })
    return () => unsub()
  }, [])

  useEffect(() => {
    const desdeTs = Timestamp.fromDate(new Date(desde + 'T00:00:00'))
    const hastaTs = Timestamp.fromDate(new Date(hasta + 'T23:59:59'))
    const q = query(collection(db, 'solicitudes_envio'), where('createdAt', '>=', desdeTs), where('createdAt', '<=', hastaTs), orderBy('createdAt', 'desc'))
    const unsub = onSnapshot(q, (snap) => { setSolicitudes(snap.docs.map((d) => ({ id: d.id, ...(d.data() as Omit<Solicitud, 'id'>) }))); setLoading(false) })
    return () => unsub()
  }, [desde, hasta])

  // Fetch comercio names for orders without ownerSnapshot (self-created by comercio)
  useEffect(() => {
    const missing = [...new Set(
      solicitudes
        .filter((s) => !s.ownerSnapshot?.companyName && !s.ownerSnapshot?.nombre && s.userId)
        .map((s) => s.userId!)
    )].filter((uid) => !comercioNames[uid])
    if (missing.length === 0) return
    Promise.all(missing.map((uid) => getDoc(doc(db, 'comercios', uid)))).then((snaps) => {
      const updates: Record<string, string> = {}
      snaps.forEach((snap, i) => {
        const data = snap.exists() ? (snap.data() as any) : null
        updates[missing[i]] = data?.name || data?.companyName || missing[i].slice(0, 8)
      })
      setComercioNames((prev) => ({ ...prev, ...updates }))
    })
  }, [solicitudes])

  const updateRegistro = async (id: string, patch: Partial<Registro>) => {
    const updates: Record<string, unknown> = {}
    for (const [k, v] of Object.entries(patch)) updates[`registro.${k}`] = v
    await updateDoc(doc(db, 'solicitudes_envio', id), updates)
  }

  const updateRegistroNested = async (id: string, path: string, value: unknown) => {
    await updateDoc(doc(db, 'solicitudes_envio', id), { [`registro.${path}`]: value })
  }

  const filtered = solicitudes.filter((s) => {
    // Solo viajes entregados
    if (s.estado !== 'entregado') return false

    if (tabMotorizado !== 'todos') {
      if (s.asignacion?.motorizadoId !== tabMotorizado && s.asignacion?.motorizadoAuthUid !== tabMotorizado) return false
    }
    if (search.trim()) {
      const q = search.toLowerCase()
      const comercio = (s.ownerSnapshot?.companyName || s.ownerSnapshot?.nombre || (s.userId ? comercioNames[s.userId] : '') || '').toLowerCase()
      const entrega = (s.entrega?.nombreApellido || '').toLowerCase()
      const zona = (s.registro?.zona || '').toLowerCase()
      if (!comercio.includes(q) && !entrega.includes(q) && !zona.includes(q)) return false
    }
    return true
  })

  const totales = filtered.reduce(
    (acc, s) => { acc.precio += getPrecio(s) || 0; acc.totalDelivery += s.cobroContraEntrega?.monto || 0; acc.depositado += s.registro?.deposito?.monto || 0; acc.cs += s.registro?.csRecaudado || 0; acc.usd += s.registro?.usdRecaudado || 0; return acc },
    { precio: 0, totalDelivery: 0, depositado: 0, cs: 0, usd: 0 }
  )

  return (
    <div className="flex flex-col gap-4">
      <div>
        <h1 className="text-xl font-bold text-gray-900">Base de datos</h1>
        <p className="text-sm text-gray-500">Viajes entregados · estados de cuenta y cobros por comercio</p>
      </div>

      {/* Filtros */}
      <div className="flex flex-wrap items-center gap-3">
        <div className="flex items-center gap-2 rounded-lg border bg-white px-3 py-2">
          <span className="text-xs text-gray-500">Desde</span>
          <input type="date" value={desde} onChange={(e) => setDesde(e.target.value)} className="text-xs focus:outline-none" />
        </div>
        <div className="flex items-center gap-2 rounded-lg border bg-white px-3 py-2">
          <span className="text-xs text-gray-500">Hasta</span>
          <input type="date" value={hasta} onChange={(e) => setHasta(e.target.value)} className="text-xs focus:outline-none" />
        </div>
        <input type="text" placeholder="Buscar comercio, cliente, zona..." value={search} onChange={(e) => setSearch(e.target.value)} className="rounded-lg border bg-white px-3 py-2 text-xs focus:outline-none focus:ring-2 focus:ring-blue-200" />
        <span className="text-xs text-gray-400">{filtered.length} registros</span>
      </div>

      {/* Tabs motorizados */}
      <div className="flex gap-1 overflow-x-auto">
        <TabBtn active={tabMotorizado === 'todos'} onClick={() => setTabMotorizado('todos')}>Todos</TabBtn>
        {motorizados.map((m) => (
          <TabBtn key={m.id} active={tabMotorizado === m.id} onClick={() => setTabMotorizado(m.id)}>{m.nombre}</TabBtn>
        ))}
      </div>

      {/* Tabla */}
      <div className="overflow-x-auto rounded-xl border bg-white shadow-sm">
        {loading ? (
          <div className="px-6 py-10 text-center text-sm text-gray-400">Cargando registros...</div>
        ) : filtered.length === 0 ? (
          <div className="px-6 py-10 text-center text-sm text-gray-400">No hay registros en este rango</div>
        ) : (
          <table className="min-w-max w-full text-xs">
            <thead>
              <tr className="border-b bg-gray-50 text-left text-[11px] font-semibold uppercase tracking-wide text-gray-500">
                <Th>#</Th><Th>Estado</Th><Th>Semana</Th><Th>Motorizado</Th><Th>Fecha</Th><Th>Pagó</Th>
                <Th>Comercio</Th><Th>Teléfono</Th><Th>Retiro</Th><Th>Entrega</Th><Th>Zona</Th><Th>Delivery</Th>
                <Th>C/E Producto</Th><Th>F. Depósito</Th><Th>Depositado</Th><Th>Forma Pago</Th>
                <Th>C$</Th><Th>$</Th><Th>Dist.</Th>
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-100">
              {filtered.map((s, idx) => {
                const semana = s.registro?.semana ?? (s.createdAt ? getWeekNumber(s.createdAt.toDate()) : null)
                const precio = getPrecio(s)

                return (
                  <tr key={s.id} className={`hover:bg-gray-50 transition-colors ${selectedId === s.id ? 'bg-blue-50' : ''}`}>
                    {/* # orden → abre drawer */}
                    <Td>
                      <button
                        onClick={() => setSelectedId(s.id)}
                        className="font-mono text-[#004aad] hover:underline"
                      >
                        <span className="text-gray-400 mr-1">{idx + 1}.</span>{s.id.slice(0, 6)}
                      </button>
                    </Td>

                    {/* Estado */}
                    <Td>
                      <span className={`inline-flex rounded-full border px-2 py-0.5 text-[11px] font-medium ${estadoClass(s.estado)}`}>
                        {statusLabel(s.estado)}
                      </span>
                    </Td>

                    {/* Semana (solo lectura) */}
                    <Td><span className="text-gray-700">{semana ?? <span className="text-gray-300">—</span>}</span></Td>

                    <Td><span className="text-gray-700">{s.asignacion?.motorizadoNombre || <span className="text-gray-300">—</span>}</span></Td>
                    <Td>{formatDate(s.createdAt)}</Td>
                    <Td><BoolCell value={s.registro?.pago?.realizo} onToggle={(v) => updateRegistroNested(s.id, 'pago.realizo', v)} labelTrue="Sí" labelFalse="No" /></Td>
                    <Td><span className="font-medium text-gray-800">{s.ownerSnapshot?.companyName || s.ownerSnapshot?.nombre || (s.userId ? comercioNames[s.userId] : undefined) || '—'}</span></Td>
                    <Td><span className="text-gray-600">{s.ownerSnapshot?.phone || '—'}</span></Td>
                    <Td><span className="max-w-[160px] truncate block text-gray-500" title={s.recoleccion?.direccionEscrita}>{s.recoleccion?.direccionEscrita || '—'}</span></Td>
                    <Td><span className="max-w-[160px] truncate block text-gray-500" title={s.entrega?.direccionEscrita}>{s.entrega?.direccionEscrita || '—'}</span></Td>
                    <Td><EditableCell value={s.registro?.zona} placeholder="zona" onSave={(v) => updateRegistro(s.id, { zona: v || undefined })} /></Td>
                    <Td>{precio != null ? <span className="font-medium text-[#004aad]">C${precio}</span> : <span className="text-gray-300">—</span>}</Td>
                    <Td>{s.cobroContraEntrega?.aplica && s.cobroContraEntrega.monto ? <span className="font-medium text-green-700">C${s.cobroContraEntrega.monto}</span> : <span className="text-gray-300">C$0</span>}</Td>
                    <Td>
                      {(() => {
                        const dep = s.registro?.deposito
                        if (dep?.confirmadoMotorizado && dep?.confirmadoAt)
                          return <span className="text-xs text-gray-700">{formatDateTime(dep.confirmadoAt)}</span>
                        const dateC = dep?.confirmadoComercioAt
                        const dateS = dep?.confirmadoStorkhubAt
                        if (!dateC && !dateS) return <span className="text-gray-300 text-xs">—</span>
                        if (!dateC || !dateS)
                          return <span className="text-xs text-gray-700">{formatDateTime((dateC || dateS)!)}</span>
                        const strC = formatDateTime(dateC), strS = formatDateTime(dateS)
                        if (strC === strS) return <span className="text-xs text-gray-700">{strC}</span>
                        return (
                          <div className="flex flex-col gap-0.5 text-xs text-gray-700">
                            <span title="Comercio">{strC}</span>
                            <span title="Storkhub">{strS}</span>
                          </div>
                        )
                      })()}
                    </Td>
                    <Td>
                      {(() => {
                        const dep = s.registro?.deposito
                        if (dep?.confirmadoMotorizado)
                          return <span className="inline-flex items-center gap-1 rounded-full bg-green-50 border border-green-200 px-2 py-0.5 text-[11px] font-semibold text-green-700">✓ Todo</span>
                        const okC = dep?.confirmadoComercio
                        const okS = dep?.confirmadoStorkhub
                        if (!okC && !okS) return <span className="inline-flex items-center rounded-full bg-yellow-50 border border-yellow-200 px-2 py-0.5 text-[11px] font-semibold text-yellow-700">Pendiente</span>
                        if (okC && okS) return <span className="inline-flex items-center gap-1 rounded-full bg-green-50 border border-green-200 px-2 py-0.5 text-[11px] font-semibold text-green-700">✓ Todo</span>
                        return (
                          <div className="flex flex-col gap-0.5">
                            <span className={`inline-flex items-center rounded-full px-2 py-0.5 text-[10px] font-semibold border ${okC ? 'bg-green-50 border-green-200 text-green-700' : 'bg-yellow-50 border-yellow-200 text-yellow-700'}`}>{okC ? '✓ Comercio' : '⏳ Comercio'}</span>
                            <span className={`inline-flex items-center rounded-full px-2 py-0.5 text-[10px] font-semibold border ${okS ? 'bg-green-50 border-green-200 text-green-700' : 'bg-yellow-50 border-yellow-200 text-yellow-700'}`}>{okS ? '✓ Storkhub' : '⏳ Storkhub'}</span>
                          </div>
                        )
                      })()}
                    </Td>
                    <Td>
                      <select value={s.registro?.deposito?.formaPago || ''} onChange={(e) => updateRegistroNested(s.id, 'deposito.formaPago', e.target.value || null)} className="rounded border border-gray-200 bg-transparent px-1 py-0.5 text-xs focus:outline-none">
                        <option value="">—</option>
                        <option value="efectivo_retiro">Ef. retiro</option>
                        <option value="efectivo_entrega">Ef. entrega</option>
                        <option value="deposito">Depósito</option>
                        <option value="credito">Crédito</option>
                      </select>
                    </Td>
                    <Td><EditableCell value={s.registro?.csRecaudado ?? ''} type="number" prefix="C$" placeholder="—" onSave={(v) => updateRegistro(s.id, { csRecaudado: v ? Number(v) : undefined })} /></Td>
                    <Td><EditableCell value={s.registro?.usdRecaudado ?? ''} type="number" prefix="$" placeholder="—" onSave={(v) => updateRegistro(s.id, { usdRecaudado: v ? Number(v) : undefined })} /></Td>
                    <Td>{s.cotizacion?.distanciaKm != null ? `${Number(s.cotizacion.distanciaKm).toFixed(1)} km` : <span className="text-gray-300">—</span>}</Td>
                  </tr>
                )
              })}
            </tbody>
            <tfoot>
              <tr className="border-t-2 border-gray-200 bg-gray-50 font-semibold text-gray-700">
                <Td colSpan={11}><span className="text-[11px] uppercase tracking-wide text-gray-500">Totales</span></Td>
                <Td><span className="text-[#004aad]">C${totales.precio.toFixed(0)}</span></Td>
                <Td><span className="text-green-700">C${totales.totalDelivery.toFixed(0)}</span></Td>
                <Td /><Td><span>C${totales.depositado.toFixed(0)}</span></Td><Td /><Td />
                <Td><span>C${totales.cs.toFixed(0)}</span></Td>
                <Td><span>${totales.usd.toFixed(2)}</span></Td>
                <Td />
              </tr>
            </tfoot>
          </table>
        )}
      </div>

      {/* Drawer de detalle */}
      {selectedId && (
        <SolicitudDrawer solicitudId={selectedId} onClose={() => setSelectedId(null)} comercioNames={comercioNames} />
      )}
    </div>
  )
}

function Th({ children }: { children: React.ReactNode }) {
  return <th className="whitespace-nowrap px-3 py-2">{children}</th>
}

function Td({ children, colSpan }: { children: React.ReactNode; colSpan?: number }) {
  return <td className="whitespace-nowrap px-3 py-2" colSpan={colSpan}>{children}</td>
}

function TabBtn({ children, active, onClick }: { children: React.ReactNode; active: boolean; onClick: () => void }) {
  return (
    <button onClick={onClick} className={`shrink-0 rounded-lg px-3 py-1.5 text-xs font-medium transition ${active ? 'bg-[#004aad] text-white' : 'bg-white border border-gray-200 text-gray-600 hover:bg-gray-50'}`}>
      {children}
    </button>
  )
}
