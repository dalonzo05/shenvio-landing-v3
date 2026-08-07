'use client'

import { useEffect, useState } from 'react'
import { useParams, useRouter } from 'next/navigation'
import Link from 'next/link'
import { doc, onSnapshot, Timestamp } from 'firebase/firestore'
import { db } from '@/fb/config'
import { useUser } from '@/app/Components/UserProvider'
import {
  ChevronLeft, MapPin, Package, Truck, CreditCard,
  Clock, CheckCircle2, XCircle, Camera,
  Navigation, User, Phone, FileText, Calendar, X,
} from 'lucide-react'

// ─── Types ────────────────────────────────────────────────────────────────────

type Solicitud = {
  id: string
  userId?: string
  estado?: string
  createdAt?: Timestamp
  entregadoAt?: Timestamp
  tipoCliente?: string
  tipoServicio?: 'normal' | 'fuera_managua' | 'compra_gestion'
  recoleccion?: { nombreApellido?: string; celular?: string; direccionEscrita?: string; nota?: string | null }
  entrega?: { nombreApellido?: string; celular?: string; direccionEscrita?: string; nota?: string | null }
  fueraManagua?: {
    metodoEnvio?: 'bus_terminal' | 'cargotrans'
    destinoFinal?: string | null
    puntoLogisticoNombre?: string | null
    direccionPuntoLogistico?: string | null
    horarioApertura?: string | null
    horarioCierre?: string | null
    coordsPuntoLogistico?: { lat: number; lng: number } | null
    transporteNombre?: string | null
    transporteCelular?: string | null
    transporteHoraSalida?: string | null
    cantidadPaquetes?: number
    notaCargotrans?: string | null
    terminalSugerida?: string | null
    pagoCargotrans?: 'efectivo_motorizado' | 'transferencia_comercio' | null
  }
  confirmacion?: { precioFinalCordobas?: number }
  cobroContraEntrega?: { aplica?: boolean; monto?: number }
  pagoDelivery?: { tipo?: string; quienPaga?: string; montoSugerido?: number | null; deducirDelCobroContraEntrega?: boolean }
  asignacion?: { motorizadoNombre?: string; motorizadoId?: string; motorizadoFotoUrl?: string } | null
  historial?: {
    en_camino_retiroAt?: any; retiradoAt?: any
    en_camino_entregaAt?: any; entregadoAt?: any
  }
  cobrosMotorizado?: {
    delivery?: { monto: number; recibio: boolean; at?: any }
    producto?: { monto: number; recibio: boolean; at?: any }
  }
  detalle?: string
  evidencias?: {
    retiro?: { url: string; pathStorage: string }
    entrega?: { url: string; pathStorage: string }
  }
  evidenciasTerminal?: {
    fotoBus?: { url: string; pathStorage: string }
    fotoPaquete?: { url: string; pathStorage: string }
    fotoTicket?: { url: string; pathStorage: string }
    sinTicket?: boolean
    busNombre?: string | null
    busNumero?: string | null
    busCelular?: string | null
    horaLlegadaDestino?: string | null
    costoFlete?: number | null
  }
  evidenciasCargotrans?: {
    fotos?: Array<{ url: string; pathStorage: string }>
    factura?: { url: string; pathStorage: string }
    costoCargotrans?: number | null
  }
  rechazo?: {
    motivoTexto?: string
    detalle?: string | null
    rechazadoAt?: any
    visibleParaComercio?: boolean
  }
  cobroDelivery?: {
    estado?: string
    // P1-S2B: un comprobante por actor + puntero de vigencia. Las claves
    // planas siguen para documentos históricos.
    boucherComercio?: { url?: string; path?: string; at?: Timestamp }
    boucherGestor?: { url?: string; path?: string; at?: Timestamp }
    boucherVigente?: 'comercio' | 'gestor'
    boucherUrl?: string
    boucherAt?: any
    subidoPor?: string
    pagadoAt?: any
    monto?: number
  }
}

/** URL del comprobante vigente; los históricos resuelven por boucherUrl. */
function urlBoucherVigente(cd?: Solicitud['cobroDelivery']): string | undefined {
  if (!cd) return undefined
  if (cd.boucherVigente === 'gestor') return cd.boucherGestor?.url
  if (cd.boucherVigente === 'comercio') return cd.boucherComercio?.url
  return cd.boucherUrl
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

const estadoLabel: Record<string, string> = {
  pendiente_confirmacion: 'Pendiente de confirmación',
  confirmada: 'Confirmada',
  asignada: 'Asignada a motorizado',
  en_camino_retiro: 'En camino al retiro',
  retirado: 'Paquete retirado',
  en_camino_entrega: 'En camino a entrega',
  entregado: 'Entregada',
  cancelada: 'Cancelada',
  rechazada: 'Solicitud rechazada',
}

const estadoCls: Record<string, string> = {
  pendiente_confirmacion: 'bg-gray-100 text-gray-600',
  confirmada: 'bg-blue-50 text-blue-700',
  asignada: 'bg-yellow-50 text-yellow-700',
  en_camino_retiro: 'bg-amber-50 text-amber-700',
  retirado: 'bg-purple-50 text-purple-700',
  en_camino_entrega: 'bg-purple-50 text-purple-700',
  entregado: 'bg-green-50 text-green-700',
  cancelada: 'bg-red-50 text-red-600',
  rechazada: 'bg-red-50 text-red-700',
}

const estadoBorder: Record<string, string> = {
  pendiente_confirmacion: 'border-l-gray-300',
  confirmada: 'border-l-blue-400',
  asignada: 'border-l-yellow-400',
  en_camino_retiro: 'border-l-amber-400',
  retirado: 'border-l-purple-400',
  en_camino_entrega: 'border-l-purple-500',
  entregado: 'border-l-green-500',
  cancelada: 'border-l-red-400',
  rechazada: 'border-l-red-500',
}

function tsToDate(v: any): Date | null {
  if (!v) return null
  if (typeof v?.toDate === 'function') return v.toDate()
  if (v instanceof Date) return v
  return null
}

function fmtDatetime(v: any) {
  const d = tsToDate(v)
  if (!d) return null
  return d.toLocaleString('es-NI', { day: '2-digit', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' })
}

function fmt(n?: number | null) {
  if (typeof n !== 'number') return '—'
  return `C$ ${n.toLocaleString('es-NI')}`
}

function debeDelivery(s: Solicitud): { debe: boolean | null; label: string } {
  const qp = s.pagoDelivery?.quienPaga || ''
  if (s.tipoCliente === 'credito' || qp === 'credito_semanal')
    return { debe: true, label: 'Crédito semanal — pendiente de cobro' }
  if (qp === 'transferencia')
    return { debe: false, label: 'Pagado por transferencia' }
  if (s.cobrosMotorizado?.delivery !== undefined) {
    const r = s.cobrosMotorizado.delivery.recibio
    return { debe: !r, label: r ? 'Cobrado al momento de la entrega' : 'No cobrado aún' }
  }
  return { debe: null, label: 'Pendiente de entrega' }
}

// ─── Lightbox ────────────────────────────────────────────────────────────────

function Lightbox({ url, onClose }: { url: string; onClose: () => void }) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose() }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])
  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/80 backdrop-blur-sm p-4"
      onClick={onClose}
    >
      <button
        onClick={onClose}
        className="absolute top-4 right-4 w-9 h-9 rounded-full bg-white/10 hover:bg-white/20 flex items-center justify-center transition text-white"
      >
        <X size={18} />
      </button>
      {/* eslint-disable-next-line @next/next/no-img-element */}
      <img
        src={url}
        alt="Vista ampliada"
        className="max-w-full max-h-[90vh] object-contain rounded-2xl shadow-2xl"
        onClick={(e) => e.stopPropagation()}
      />
    </div>
  )
}

// ─── Sub-components ──────────────────────────────────────────────────────────

function SectionCard({ children, className = '' }: { children: React.ReactNode; className?: string }) {
  return (
    <div className={`rounded-2xl border border-gray-200 bg-white shadow-sm overflow-hidden ${className}`}>
      {children}
    </div>
  )
}

function SectionHeader({
  icon: Icon,
  title,
  accent = 'blue',
}: {
  icon: React.ElementType
  title: string
  accent?: 'blue' | 'green' | 'violet' | 'amber' | 'red' | 'gray'
}) {
  const colors = {
    blue:   'bg-blue-50 text-[#004aad] border-b border-blue-100',
    green:  'bg-green-50 text-green-700 border-b border-green-100',
    violet: 'bg-violet-50 text-violet-700 border-b border-violet-100',
    amber:  'bg-amber-50 text-amber-700 border-b border-amber-100',
    red:    'bg-red-50 text-red-700 border-b border-red-100',
    gray:   'bg-gray-50 text-gray-600 border-b border-gray-100',
  }
  return (
    <div className={`flex items-center gap-2 px-4 py-3 ${colors[accent]}`}>
      <Icon className="w-4 h-4 flex-shrink-0" />
      <h2 className="text-xs font-bold uppercase tracking-wide">{title}</h2>
    </div>
  )
}

function InfoRow({ label, value, mono = false }: { label: string; value?: React.ReactNode; mono?: boolean }) {
  if (!value && value !== 0) return null
  return (
    <div className="flex items-start gap-3 py-2 border-b border-gray-50 last:border-0">
      <span className="text-xs text-gray-400 min-w-[110px] pt-0.5 flex-shrink-0">{label}</span>
      <span className={`text-sm text-gray-800 font-medium ${mono ? 'font-mono' : ''}`}>{value}</span>
    </div>
  )
}

// ─── Component ───────────────────────────────────────────────────────────────

export default function OrdenDetallePage() {
  const { id } = useParams<{ id: string }>()
  const router = useRouter()
  const { profile } = useUser()
  const [orden, setOrden] = useState<Solicitud | null>(null)
  const [loading, setLoading] = useState(true)
  const [lightboxUrl, setLightboxUrl] = useState<string | null>(null)

  useEffect(() => {
    if (!id) return
    const unsub = onSnapshot(doc(db, 'solicitudes_envio', id), (snap) => {
      if (!snap.exists()) { router.replace('/panel/comercio/mis-ordenes'); return }
      const data = { id: snap.id, ...(snap.data() as any) } as Solicitud
      // Identidad estable (Bloque A): comparar contra comercioId, no auth.uid.
      if (profile?.comercioId && data.userId && data.userId !== profile.comercioId) {
        router.replace('/panel/comercio/mis-ordenes'); return
      }
      setOrden(data)
      setLoading(false)
    })
    return () => unsub()
  }, [id, router, profile?.comercioId])

  if (loading) return (
    <div className="flex items-center justify-center py-20 text-sm text-gray-400 gap-2">
      <div className="w-4 h-4 rounded-full border-2 border-gray-300 border-t-[#004aad] animate-spin" />
      Cargando orden…
    </div>
  )
  if (!orden) return null

  const estadoCl = estadoCls[orden.estado || ''] || 'bg-gray-100 text-gray-600'
  const accentBorder = estadoBorder[orden.estado || ''] || 'border-l-gray-300'
  const delivery = debeDelivery(orden)

  const precioConfirmado = orden.confirmacion?.precioFinalCordobas
  const precioSugerido = orden.pagoDelivery?.montoSugerido

  const timeline = [
    { key: 'createdAt',         label: 'Solicitud creada',       ts: orden.createdAt },
    { key: 'en_camino_retiro',  label: 'En camino al retiro',    ts: orden.historial?.en_camino_retiroAt },
    { key: 'retirado',          label: 'Paquete retirado',        ts: orden.historial?.retiradoAt },
    { key: 'en_camino_entrega', label: 'En camino a entrega',    ts: orden.historial?.en_camino_entregaAt },
    { key: 'entregado',         label: 'Entregado al destinatario', ts: orden.historial?.entregadoAt || orden.entregadoAt },
  ].filter((t) => tsToDate(t.ts))

  const esFuera = orden.tipoServicio === 'fuera_managua'
  const esCargotrans = orden.fueraManagua?.metodoEnvio === 'cargotrans'

  return (
    <>
    {lightboxUrl && <Lightbox url={lightboxUrl} onClose={() => setLightboxUrl(null)} />}
    <div className="flex flex-col gap-4 max-w-2xl pb-8">

      {/* ── Back ── */}
      <Link href="/panel/comercio/mis-ordenes"
        className="inline-flex items-center gap-1 text-sm text-gray-500 hover:text-[#004aad] transition w-fit">
        <ChevronLeft size={16} /> Mis órdenes
      </Link>

      {/* ── Header card ── */}
      <div className={`rounded-2xl border border-gray-200 bg-white shadow-sm border-l-4 ${accentBorder} overflow-hidden`}>
        <div className="px-5 py-4 flex items-start justify-between gap-3 flex-wrap">
          <div>
            <p className="text-xs font-semibold text-gray-400 uppercase tracking-wide mb-1">Orden</p>
            <h1 className="text-lg font-black text-gray-900 font-mono tracking-tight">#{id.slice(0, 10)}</h1>
            {orden.createdAt && (
              <p className="text-xs text-gray-400 mt-1 flex items-center gap-1">
                <Calendar size={11} /> {fmtDatetime(orden.createdAt)}
              </p>
            )}
          </div>
          <div className="flex flex-col items-end gap-1.5">
            <span className={`inline-flex text-xs font-bold px-3 py-1.5 rounded-full ${estadoCl}`}>
              {estadoLabel[orden.estado || ''] || orden.estado}
            </span>
            {esFuera && (
              <span className="inline-flex text-xs font-semibold px-2.5 py-1 rounded-full bg-violet-50 text-violet-700">
                {esCargotrans ? 'Cargotrans' : 'Bus / Terminal'}
              </span>
            )}
          </div>
        </div>
      </div>

      {/* ── Rechazo ── */}
      {orden.estado === 'rechazada' && (
        <SectionCard>
          <SectionHeader icon={XCircle} title="Solicitud rechazada" accent="red" />
          <div className="p-4 space-y-2">
            {orden.rechazo?.visibleParaComercio && orden.rechazo?.motivoTexto && (
              <InfoRow label="Motivo" value={orden.rechazo.motivoTexto} />
            )}
            {orden.rechazo?.visibleParaComercio && orden.rechazo?.detalle && (
              <InfoRow label="Detalle" value={orden.rechazo.detalle} />
            )}
            <p className="text-xs text-red-400 pt-1">Si tienes dudas, comunícate con el equipo de soporte.</p>
          </div>
        </SectionCard>
      )}

      {/* ── Ruta ── */}
      <SectionCard>
        <SectionHeader icon={Navigation} title="Ruta" accent="blue" />
        <div className="p-4 space-y-4">

          {/* Retiro */}
          <div className="flex items-start gap-3">
            <div className="flex flex-col items-center pt-1 flex-shrink-0">
              <div className="w-8 h-8 rounded-full bg-amber-100 grid place-items-center">
                <MapPin size={14} className="text-amber-600" />
              </div>
              <div className="w-px flex-1 bg-gray-200 my-1 min-h-[24px]" />
            </div>
            <div className="flex-1 pb-4">
              <p className="text-[10px] font-bold text-amber-600 uppercase tracking-wide mb-1">Retiro</p>
              <p className="text-sm font-bold text-gray-900">{orden.recoleccion?.nombreApellido || '—'}</p>
              {orden.recoleccion?.celular && (
                <p className="text-xs text-gray-500 flex items-center gap-1 mt-0.5">
                  <Phone size={10} /> {orden.recoleccion.celular}
                </p>
              )}
              <p className="text-sm text-gray-600 mt-1">{orden.recoleccion?.direccionEscrita || '—'}</p>
              {orden.recoleccion?.nota && (
                <div className="mt-2 flex items-start gap-1.5 text-xs text-amber-700 bg-amber-50 border border-amber-200 rounded-lg px-2.5 py-1.5">
                  <FileText size={11} className="mt-0.5 flex-shrink-0" />
                  {orden.recoleccion.nota}
                </div>
              )}
            </div>
          </div>

          {/* Entrega */}
          {esFuera && orden.fueraManagua ? (
            <div className="flex items-start gap-3">
              <div className="flex flex-col items-center pt-1 flex-shrink-0">
                <div className="w-8 h-8 rounded-full bg-violet-100 grid place-items-center">
                  <Truck size={14} className="text-violet-600" />
                </div>
              </div>
              <div className="flex-1">
                <p className="text-[10px] font-bold text-violet-600 uppercase tracking-wide mb-1">
                  {esCargotrans ? 'Sucursal Cargotrans' : 'Terminal / Bus'}
                </p>
                <p className="text-sm font-bold text-gray-900">
                  {orden.fueraManagua.puntoLogisticoNombre || orden.fueraManagua.terminalSugerida || '—'}
                </p>
                {orden.fueraManagua.destinoFinal && (
                  <p className="text-sm text-violet-700 font-semibold mt-0.5">
                    Destino: {orden.fueraManagua.destinoFinal}
                  </p>
                )}
                {orden.fueraManagua.direccionPuntoLogistico && (
                  <p className="text-xs text-gray-500 mt-1">{orden.fueraManagua.direccionPuntoLogistico}</p>
                )}
                {(orden.fueraManagua.horarioApertura || orden.fueraManagua.horarioCierre) && (
                  <p className="text-xs text-gray-500 mt-0.5">
                    Horario: {orden.fueraManagua.horarioApertura || '?'} – {orden.fueraManagua.horarioCierre || '?'}
                  </p>
                )}
                {!esCargotrans && orden.fueraManagua.transporteNombre && (
                  <p className="text-xs text-gray-600 mt-1">Transporte: {orden.fueraManagua.transporteNombre}</p>
                )}
                {!esCargotrans && orden.fueraManagua.transporteHoraSalida && (
                  <p className="text-xs text-gray-600">Salida: {orden.fueraManagua.transporteHoraSalida}</p>
                )}
                {esCargotrans && orden.fueraManagua.cantidadPaquetes != null && (
                  <p className="text-xs text-gray-600 mt-1">Paquetes: {orden.fueraManagua.cantidadPaquetes}</p>
                )}
                {esCargotrans && orden.fueraManagua.pagoCargotrans && (
                  <p className="text-xs text-gray-600 mt-0.5">
                    {orden.fueraManagua.pagoCargotrans === 'efectivo_motorizado'
                      ? 'Pago flete: Efectivo (motorizado adelanta)'
                      : 'Pago flete: Transferencia del comercio'}
                  </p>
                )}
                {esCargotrans && orden.fueraManagua.notaCargotrans && (
                  <div className="mt-2 flex items-start gap-1.5 text-xs text-amber-700 bg-amber-50 border border-amber-200 rounded-lg px-2.5 py-1.5">
                    <FileText size={11} className="mt-0.5 flex-shrink-0" />
                    {orden.fueraManagua.notaCargotrans}
                  </div>
                )}
                {orden.fueraManagua.coordsPuntoLogistico && (
                  <a
                    href={`https://www.google.com/maps?q=${orden.fueraManagua.coordsPuntoLogistico.lat},${orden.fueraManagua.coordsPuntoLogistico.lng}`}
                    target="_blank" rel="noopener noreferrer"
                    className="inline-flex items-center gap-1 text-xs text-blue-700 font-semibold mt-2 hover:underline"
                  >
                    <MapPin size={10} /> Ver en Maps
                  </a>
                )}
              </div>
            </div>
          ) : (
            <div className="flex items-start gap-3">
              <div className="flex flex-col items-center pt-1 flex-shrink-0">
                <div className="w-8 h-8 rounded-full bg-green-100 grid place-items-center">
                  <CheckCircle2 size={14} className="text-green-600" />
                </div>
              </div>
              <div className="flex-1">
                <p className="text-[10px] font-bold text-green-600 uppercase tracking-wide mb-1">Entrega</p>
                <p className="text-sm font-bold text-gray-900">{orden.entrega?.nombreApellido || '—'}</p>
                {orden.entrega?.celular && (
                  <p className="text-xs text-gray-500 flex items-center gap-1 mt-0.5">
                    <Phone size={10} /> {orden.entrega.celular}
                  </p>
                )}
                <p className="text-sm text-gray-600 mt-1">{orden.entrega?.direccionEscrita || '—'}</p>
                {orden.entrega?.nota && (
                  <div className="mt-2 flex items-start gap-1.5 text-xs text-amber-700 bg-amber-50 border border-amber-200 rounded-lg px-2.5 py-1.5">
                    <FileText size={11} className="mt-0.5 flex-shrink-0" />
                    {orden.entrega.nota}
                  </div>
                )}
              </div>
            </div>
          )}

          {orden.detalle && (
            <div className="pt-2 border-t border-gray-100">
              <p className="text-[10px] font-bold text-gray-400 uppercase tracking-wide mb-1">Instrucciones adicionales</p>
              <p className="text-sm text-gray-600">{orden.detalle}</p>
            </div>
          )}
        </div>
      </SectionCard>

      {/* ── Cobros ── */}
      <SectionCard>
        <SectionHeader icon={CreditCard} title="Resumen de cobros" accent="blue" />
        <div className="p-4 space-y-0">

          {/* Delivery */}
          <div className="flex items-center justify-between py-3 border-b border-gray-100">
            <div>
              <p className="text-sm font-semibold text-gray-900">Delivery</p>
              <p className={`text-xs mt-0.5 ${
                delivery.debe === true ? 'text-orange-500'
                : delivery.debe === false ? 'text-green-600'
                : 'text-gray-400'
              }`}>
                {delivery.label}
              </p>
            </div>
            <div className="text-right flex flex-col items-end gap-1">
              {typeof precioConfirmado === 'number' ? (
                <p className="text-base font-black text-[#004aad]">{fmt(precioConfirmado)}</p>
              ) : typeof precioSugerido === 'number' ? (
                <p className="text-base font-black text-gray-400" title="Precio estimado, aún no confirmado">
                  ~{fmt(precioSugerido)}
                </p>
              ) : (
                <p className="text-sm text-gray-300">—</p>
              )}
              {delivery.debe !== null && (
                <span className={`inline-flex text-[11px] font-bold px-2 py-0.5 rounded-full ${
                  delivery.debe
                    ? 'bg-orange-50 text-orange-600'
                    : 'bg-green-50 text-green-700'
                }`}>
                  {delivery.debe ? 'Pendiente' : 'Pagado'}
                </span>
              )}
            </div>
          </div>

          {/* Boucher transferencia */}
          {orden.pagoDelivery?.quienPaga === 'transferencia' && (
            <div className="py-3 border-b border-gray-100 space-y-3">
              <div className="flex items-start justify-between gap-2">
                <div>
                  <p className="text-sm font-semibold text-gray-900">Boucher de transferencia</p>
                  <p className={`text-xs mt-0.5 ${
                    orden.cobroDelivery?.estado === 'pagado' ? 'text-green-600'
                    : orden.cobroDelivery?.estado === 'en_revision_deposito' ? 'text-blue-600'
                    : 'text-gray-400'
                  }`}>
                    {orden.cobroDelivery?.estado === 'pagado' ? '✓ Pago confirmado'
                    : orden.cobroDelivery?.estado === 'en_revision_deposito' ? 'En revisión por el gestor'
                    : 'Pendiente — sube el boucher de tu transferencia'}
                  </p>
                </div>
                {urlBoucherVigente(orden.cobroDelivery) && (
                  <button
                    onClick={() => setLightboxUrl(urlBoucherVigente(orden.cobroDelivery)!)}
                    className="text-xs font-semibold text-blue-600 hover:underline flex-shrink-0"
                  >
                    Ver boucher →
                  </button>
                )}
              </div>
              {urlBoucherVigente(orden.cobroDelivery) && (
                <button onClick={() => setLightboxUrl(urlBoucherVigente(orden.cobroDelivery)!)} className="block w-full">
                  {/* eslint-disable-next-line @next/next/no-img-element */}
                  <img
                    src={urlBoucherVigente(orden.cobroDelivery)}
                    alt="Boucher de transferencia"
                    className="w-full max-h-40 object-contain rounded-xl border border-blue-100 bg-blue-50 hover:opacity-90 transition"
                  />
                </button>
              )}
            </div>
          )}

          {/* Callout: lógica deducción delivery */}
          {orden.cobroContraEntrega?.aplica && orden.pagoDelivery?.quienPaga === 'entrega' && (() => {
            const montoProducto = orden.cobroContraEntrega!.monto ?? 0
            const precioDelivery = precioConfirmado ?? precioSugerido ?? 0
            const deducir = orden.pagoDelivery?.deducirDelCobroContraEntrega === true
            const clientePaga = deducir ? montoProducto : montoProducto + precioDelivery
            const deposito = deducir ? Math.max(montoProducto - precioDelivery, 0) : montoProducto
            return (
              <div className={`mx-0 my-1 rounded-xl border p-3 space-y-3 ${deducir ? 'bg-orange-50 border-orange-200' : 'bg-blue-50 border-blue-200'}`}>
                <div className="flex items-center gap-2 flex-wrap">
                  <span className={`text-xs font-black ${deducir ? 'text-orange-700' : 'text-blue-700'}`}>
                    {deducir ? 'Delivery incluido en el cobro del producto' : 'Delivery cobrado por separado'}
                  </span>
                  <span className={`text-[10px] font-bold px-2 py-0.5 rounded-full ${deducir ? 'bg-orange-200 text-orange-800' : 'bg-blue-200 text-blue-800'}`}>
                    Tu elección al crear la orden
                  </span>
                </div>
                <div className="grid grid-cols-3 gap-2 text-center">
                  <div className="rounded-xl bg-white border border-gray-200 p-2.5">
                    <p className="text-[10px] font-bold text-gray-400 uppercase mb-1">Cliente paga</p>
                    <p className="text-sm font-black text-gray-900">{precioDelivery > 0 ? fmt(clientePaga) : fmt(montoProducto)}</p>
                    <p className="text-[9px] text-gray-400 mt-0.5">{deducir ? 'todo incluido' : 'producto + delivery'}</p>
                  </div>
                  <div className="rounded-xl bg-white border border-gray-200 p-2.5">
                    <p className="text-[10px] font-bold text-gray-400 uppercase mb-1">Delivery</p>
                    <p className="text-sm font-black text-[#004aad]">{precioDelivery > 0 ? fmt(precioDelivery) : '—'}</p>
                    <p className="text-[9px] text-gray-400 mt-0.5">{deducir ? 'sale del cobro' : 'cobra aparte'}</p>
                  </div>
                  <div className="rounded-xl bg-white border border-gray-200 p-2.5">
                    <p className="text-[10px] font-bold text-gray-400 uppercase mb-1">Te depositan</p>
                    <p className={`text-sm font-black ${deducir && precioDelivery > 0 ? 'text-orange-700' : 'text-green-700'}`}>
                      {precioDelivery > 0 ? fmt(deposito) : fmt(montoProducto)}
                    </p>
                    <p className="text-[9px] text-gray-400 mt-0.5">{deducir ? 'ya descontado' : 'monto producto'}</p>
                  </div>
                </div>
              </div>
            )
          })()}

          {/* Cobro contra entrega */}
          {orden.cobroContraEntrega?.aplica && (
            <div className="flex items-center justify-between py-3">
              <div>
                <p className="text-sm font-semibold text-gray-900">Cobro del producto</p>
                {orden.cobrosMotorizado?.producto ? (
                  <p className={`text-xs mt-0.5 ${orden.cobrosMotorizado.producto.recibio ? 'text-green-600' : 'text-red-500'}`}>
                    {orden.cobrosMotorizado.producto.recibio
                      ? '✓ El motorizado cobró al cliente'
                      : '✗ El motorizado no cobró aún'}
                  </p>
                ) : (
                  <p className="text-xs text-gray-400 mt-0.5">Pendiente de entrega</p>
                )}
              </div>
              <div className="text-right flex flex-col items-end gap-1">
                <p className="text-base font-black text-purple-700">{fmt(orden.cobroContraEntrega.monto)}</p>
                {orden.cobrosMotorizado?.producto && (
                  <span className={`inline-flex text-[11px] font-bold px-2 py-0.5 rounded-full ${
                    orden.cobrosMotorizado.producto.recibio
                      ? 'bg-green-50 text-green-700'
                      : 'bg-red-50 text-red-600'
                  }`}>
                    {orden.cobrosMotorizado.producto.recibio ? 'Cobrado' : 'No cobrado'}
                  </span>
                )}
              </div>
            </div>
          )}
        </div>
      </SectionCard>

      {/* ── Motorizado ── */}
      {orden.asignacion?.motorizadoNombre && (
        <SectionCard>
          <SectionHeader icon={User} title="Motorizado asignado" accent="gray" />
          <div className="p-4">
            <div className="flex items-center gap-4">
              <div className="w-14 h-14 rounded-2xl bg-[#004aad]/10 grid place-items-center flex-shrink-0 overflow-hidden border border-gray-200">
                {orden.asignacion.motorizadoFotoUrl ? (
                  // eslint-disable-next-line @next/next/no-img-element
                  <img
                    src={orden.asignacion.motorizadoFotoUrl}
                    alt={orden.asignacion.motorizadoNombre}
                    className="w-full h-full object-cover"
                  />
                ) : (
                  <span className="text-xl font-black text-[#004aad]">
                    {(orden.asignacion.motorizadoNombre || '?')[0].toUpperCase()}
                  </span>
                )}
              </div>
              <div>
                <p className="text-base font-black text-gray-900">{orden.asignacion.motorizadoNombre}</p>
                <span className={`inline-flex text-xs font-semibold px-2.5 py-1 rounded-full mt-1 ${estadoCls[orden.estado || ''] || 'bg-gray-100 text-gray-600'}`}>
                  {estadoLabel[orden.estado || ''] || orden.estado}
                </span>
              </div>
            </div>
          </div>
        </SectionCard>
      )}

      {/* ── Evidencias fotográficas (normal) ── */}
      {orden.estado === 'entregado' && (orden.evidencias?.retiro || orden.evidencias?.entrega) && (
        <SectionCard>
          <SectionHeader icon={Camera} title="Fotos de tu entrega" accent="green" />
          <div className="p-4">
            <div className="grid grid-cols-2 gap-3">
              {orden.evidencias?.retiro && (
                <button
                  onClick={() => setLightboxUrl(orden.evidencias!.retiro!.url)}
                  className="flex flex-col items-center gap-2 group"
                >
                  {/* eslint-disable-next-line @next/next/no-img-element */}
                  <img
                    src={orden.evidencias.retiro.url}
                    alt="Foto de retiro"
                    className="w-full aspect-square object-cover rounded-xl border border-green-200 group-hover:opacity-90 transition"
                    loading="lazy"
                  />
                  <span className="text-xs text-green-700 font-semibold flex items-center gap-1">
                    <Package size={11} /> Retiro
                  </span>
                </button>
              )}
              {orden.evidencias?.entrega && (
                <button
                  onClick={() => setLightboxUrl(orden.evidencias!.entrega!.url)}
                  className="flex flex-col items-center gap-2 group"
                >
                  {/* eslint-disable-next-line @next/next/no-img-element */}
                  <img
                    src={orden.evidencias.entrega.url}
                    alt="Foto de entrega"
                    className="w-full aspect-square object-cover rounded-xl border border-green-200 group-hover:opacity-90 transition"
                    loading="lazy"
                  />
                  <span className="text-xs text-green-700 font-semibold flex items-center gap-1">
                    <CheckCircle2 size={11} /> Entrega
                  </span>
                </button>
              )}
            </div>
          </div>
        </SectionCard>
      )}

      {/* ── Evidencias Bus/Terminal ── */}
      {esFuera && !esCargotrans && orden.evidenciasTerminal?.fotoPaquete && (
        <SectionCard>
          <SectionHeader icon={Camera} title="Fotos de entrega al bus" accent="violet" />
          <div className="p-4 space-y-4">
            <div className="grid grid-cols-3 gap-2">
              {orden.evidenciasTerminal.fotoPaquete && (
                <button onClick={() => setLightboxUrl(orden.evidenciasTerminal!.fotoPaquete!.url)}
                  className="flex flex-col items-center gap-1.5 group">
                  {/* eslint-disable-next-line @next/next/no-img-element */}
                  <img src={orden.evidenciasTerminal.fotoPaquete.url} alt="Paquete"
                    className="w-full aspect-square object-cover rounded-xl border border-violet-200 group-hover:opacity-90 transition" loading="lazy" />
                  <span className="text-xs text-violet-700 font-semibold">Paquete</span>
                </button>
              )}
              {orden.evidenciasTerminal.fotoTicket && (
                <button onClick={() => setLightboxUrl(orden.evidenciasTerminal!.fotoTicket!.url)}
                  className="flex flex-col items-center gap-1.5 group">
                  {/* eslint-disable-next-line @next/next/no-img-element */}
                  <img src={orden.evidenciasTerminal.fotoTicket.url} alt="Ticket"
                    className="w-full aspect-square object-cover rounded-xl border border-violet-200 group-hover:opacity-90 transition" loading="lazy" />
                  <span className="text-xs text-violet-700 font-semibold">Ticket</span>
                </button>
              )}
              {orden.evidenciasTerminal.fotoBus && (
                <button onClick={() => setLightboxUrl(orden.evidenciasTerminal!.fotoBus!.url)}
                  className="flex flex-col items-center gap-1.5 group">
                  {/* eslint-disable-next-line @next/next/no-img-element */}
                  <img src={orden.evidenciasTerminal.fotoBus.url} alt="Bus"
                    className="w-full aspect-square object-cover rounded-xl border border-violet-200 group-hover:opacity-90 transition" loading="lazy" />
                  <span className="text-xs text-violet-700 font-semibold">Bus</span>
                </button>
              )}
            </div>
            {orden.evidenciasTerminal.sinTicket && (
              <div className="rounded-xl bg-amber-50 border border-amber-200 p-3">
                <p className="text-xs font-bold text-amber-700 mb-2">Sin ticket — datos del transporte</p>
                <div className="space-y-0">
                  {orden.evidenciasTerminal.busNombre && <InfoRow label="Bus / empresa" value={orden.evidenciasTerminal.busNombre} />}
                  {orden.evidenciasTerminal.busNumero && <InfoRow label="Número / placa" value={orden.evidenciasTerminal.busNumero} />}
                  {orden.evidenciasTerminal.busCelular && <InfoRow label="Celular cobrador" value={orden.evidenciasTerminal.busCelular} />}
                  {orden.evidenciasTerminal.horaLlegadaDestino && <InfoRow label="Llega a destino" value={orden.evidenciasTerminal.horaLlegadaDestino} />}
                  {orden.evidenciasTerminal.costoFlete != null && <InfoRow label="Costo flete" value={`C$ ${orden.evidenciasTerminal.costoFlete}`} />}
                </div>
              </div>
            )}
          </div>
        </SectionCard>
      )}

      {/* ── Evidencias Cargotrans ── */}
      {esFuera && esCargotrans && orden.evidenciasCargotrans && (
        <SectionCard>
          <SectionHeader icon={Camera} title="Fotos de entrega en Cargotrans" accent="violet" />
          <div className="p-4 space-y-4">
            {(orden.evidenciasCargotrans.fotos ?? []).length > 0 && (
              <div>
                <p className="text-xs text-gray-400 mb-2 font-medium">
                  Paquetes ({orden.evidenciasCargotrans.fotos!.length})
                </p>
                <div className="flex gap-2 flex-wrap">
                  {orden.evidenciasCargotrans.fotos!.map((f, i) => (
                    <button key={i} onClick={() => setLightboxUrl(f.url)}
                      className="flex flex-col items-center gap-1 w-24 group">
                      {/* eslint-disable-next-line @next/next/no-img-element */}
                      <img src={f.url} alt={`Paquete ${i + 1}`}
                        className="w-full aspect-square object-cover rounded-xl border border-violet-200 group-hover:opacity-90 transition" loading="lazy" />
                      <span className="text-xs text-violet-700 font-semibold">#{i + 1}</span>
                    </button>
                  ))}
                </div>
              </div>
            )}
            {orden.evidenciasCargotrans.factura && (
              <button
                onClick={() => setLightboxUrl(orden.evidenciasCargotrans!.factura!.url)}
                className="inline-flex items-center gap-1.5 text-sm text-indigo-700 font-semibold hover:underline"
              >
                <FileText size={14} /> Ver factura
              </button>
            )}
            {orden.evidenciasCargotrans.costoCargotrans != null && (
              <div className="flex items-center justify-between py-2 border-t border-violet-100">
                <span className="text-sm text-gray-500">Costo pagado en Cargotrans</span>
                <span className="text-sm font-bold text-violet-700">C$ {orden.evidenciasCargotrans.costoCargotrans}</span>
              </div>
            )}
          </div>
        </SectionCard>
      )}

      {/* ── Timeline ── */}
      {timeline.length > 0 && (
        <SectionCard>
          <SectionHeader icon={Clock} title="Historial" accent="gray" />
          <div className="p-4">
            <ol className="space-y-0">
              {timeline.map((t, i) => {
                const isLast = i === timeline.length - 1
                return (
                  <li key={t.key} className="flex items-start gap-3">
                    <div className="flex flex-col items-center flex-shrink-0">
                      <div className={`w-3 h-3 rounded-full mt-1 ${isLast ? 'bg-[#004aad] ring-2 ring-blue-200' : 'bg-gray-300'}`} />
                      {!isLast && <div className="w-px bg-gray-200 flex-1 min-h-[28px]" />}
                    </div>
                    <div className={`pb-4 ${isLast ? '' : ''}`}>
                      <p className={`text-sm font-semibold ${isLast ? 'text-[#004aad]' : 'text-gray-700'}`}>
                        {t.label}
                      </p>
                      <p className="text-xs text-gray-400 mt-0.5 flex items-center gap-1">
                        <Calendar size={10} /> {fmtDatetime(t.ts)}
                      </p>
                    </div>
                  </li>
                )
              })}
            </ol>
          </div>
        </SectionCard>
      )}
    </div>
    </>
  )
}
