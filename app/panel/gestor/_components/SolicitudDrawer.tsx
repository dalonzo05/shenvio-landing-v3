'use client'

import { useEffect, useMemo, useState } from 'react'
import Link from 'next/link'
import {
  collection,
  onSnapshot,
  doc,
  updateDoc,
  setDoc,
  writeBatch,
  getDocs,
  getDoc,
  query,
  serverTimestamp,
  increment,
  Timestamp,
  where,
} from 'firebase/firestore'
import { db, auth } from '@/fb/config'
import { compressImage, uploadEvidenciaPath } from '@/fb/storage'
import {
  rankearMotorizados,
  type MotorizadoConRanking,
  type OrdenActivaRanking,
  type NuevaOrdenRanking,
  type MotorizadoRankeado,
} from '@/lib/motorizado-ranking'
import {
  LABELS_TIPO_GASTO,
  type GastoMotorizado,
} from '@/lib/financial-types'
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
    motorizadoTelefono?: string; motorizadoFotoUrl?: string
    asignadoPorUid?: string; asignadoAt?: any
    aceptarAntesDe?: any; estadoAceptacion?: 'pendiente' | 'aceptada' | 'rechazada' | 'expirada'
    aceptadoAt?: any; rechazadoAt?: any; motivoRechazo?: string
  } | null
  detalle?: string
  historial?: {
    en_camino_retiroAt?: any; retiradoAt?: any
    en_camino_entregaAt?: any; entregadoAt?: any
  }
  userId?: string
  requiereBolso?: boolean
  ownerSnapshot?: { companyName?: string; phone?: string; nombre?: string; uid?: string }
  cobrosMotorizado?: {
    delivery?: { monto: number; recibio: boolean; at?: any; justificacion?: string }
    producto?: { monto: number; recibio: boolean; at?: any; justificacion?: string }
    resolucion?: { resueltoPor: string; at?: any; nota?: string }
  }
  cobroDelivery?: {
    estado?: string; formaPago?: string; notaPago?: string; pagadoAt?: any; monto?: number
    boucherUrl?: string; boucherPath?: string; boucherAt?: any; subidoPor?: string
  }
  registro?: {
    semana?: number; zona?: string
    deposito?: {
      monto?: number | null; formaPago?: string | null
      confirmadoMotorizado?: boolean; confirmadoAt?: Timestamp | null  // legacy
      confirmadoComercio?: boolean; confirmadoComercioAt?: Timestamp | null
      confirmadoStorkhub?: boolean; confirmadoStorkhubAt?: Timestamp | null
      storkhubDepositoId?: string; comercioDepositoId?: string
    }
  }
  evidencias?: {
    retiro?: { url: string; pathStorage: string; uploadedAt?: any; motorizadoUid?: string }
    entrega?: { url: string; pathStorage: string; uploadedAt?: any; motorizadoUid?: string }
    deposito?: { url: string; pathStorage: string; uploadedAt?: any; motorizadoUid?: string }
  }
  zonaRetiroId?: string | null
  zonaRetiroNombre?: string | null
  zonaEntregaId?: string | null
  zonaEntregaNombre?: string | null
  macroZonaRetiroId?: string | null
  macroZonaRetiroNombre?: string | null
  macroZonaEntregaId?: string | null
  macroZonaEntregaNombre?: string | null
  tipoServicio?: 'normal' | 'fuera_managua' | 'compra_gestion'
  fueraManagua?: {
    metodoEnvio?: 'bus_terminal' | 'cargotrans'
    destinoFinal?: string | null
    puntoLogisticoId?: string | null
    puntoLogisticoNombre?: string | null
    puntoLogisticoTipo?: string | null
    coordsPuntoLogistico?: { lat: number; lng: number } | null
    direccionPuntoLogistico?: string | null
    horarioApertura?: string | null
    horarioCierre?: string | null
    notaPuntoLogistico?: string | null
    terminalSugerida?: string | null
    transporteNombre?: string | null
    transporteCelular?: string | null
    transporteHoraSalida?: string | null
    transporteNota?: string | null
    cantidadPaquetes?: number
    notaCargotrans?: string | null
    pagoCargotrans?: 'efectivo_motorizado' | 'transferencia_comercio' | null
  }
  precioDesglose?: {
    deliveryBase?: number
    recargoZona?: number
    recargoServicio?: number
    totalCobrado?: number
  } | null
  gastosEspeciales?: {
    tipo: string
    monto: number
    reportadoPorMotorizado: boolean
    autorizadoPorGestor: boolean
    comprobante?: { url: string; pathStorage: string }
    nota?: string | null
    estado: 'reportado' | 'pendiente' | 'aprobado' | 'rechazado'
    montoOficial?: number | null
    reportadoAt?: any
  }[]
  evidenciasTerminal?: {
    fotoBus?: { url: string; pathStorage: string; uploadedAt?: any }
    fotoPaquete?: { url: string; pathStorage: string; uploadedAt?: any }
    fotoTicket?: { url: string; pathStorage: string; uploadedAt?: any }
    sinTicket?: boolean
    busNombre?: string | null
    busNumero?: string | null
    busCelular?: string | null
    horaLlegadaDestino?: string | null
    costoFlete?: number | null
    nota?: string | null
    horaEntregaBus?: string | null
  }
  evidenciasCargotrans?: {
    fotos?: Array<{ url: string; pathStorage: string; uploadedAt?: any }>
    factura?: { url: string; pathStorage: string; uploadedAt?: any }
    costoCargotrans?: number | null
    subidasAt?: any
    subidasPorUid?: string
  }
  rechazo?: {
    motivoCodigo?: string
    motivoTexto?: string
    detalle?: string | null
    rechazadoPorUid?: string | null
    rechazadoAt?: any
    visibleParaComercio?: boolean
  }
}

const MOTIVOS_RECHAZO = [
  { codigo: 'fuera_cobertura', label: 'Fuera de cobertura' },
  { codigo: 'direccion_incompleta', label: 'Dirección incompleta o poco clara' },
  { codigo: 'precio_no_aceptado', label: 'Precio no aceptado' },
  { codigo: 'sin_motorizado_disponible', label: 'Sin motorizado disponible' },
  { codigo: 'pedido_duplicado', label: 'Pedido duplicado' },
  { codigo: 'problema_comercio_cliente', label: 'Problema con la información del comercio o cliente' },
  { codigo: 'otro', label: 'Otro motivo' },
]

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
  const coord = tipo === 'recoleccion' ? s.cotizacion?.origenCoord : (s.cotizacion?.destinoCoord ?? s.fueraManagua?.coordsPuntoLogistico)
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
  const [comercioRequiereBolso, setComercioRequiereBolso] = useState<boolean | null>(null)
  const [showRechazarModal, setShowRechazarModal] = useState(false)
  const [motivoCodigo, setMotivoCodigo] = useState('')
  const [motivoTexto, setMotivoTexto] = useState('')
  const [detalleRechazo, setDetalleRechazo] = useState('')
  const [ctransFiles, setCtransFiles] = useState<File[]>([])
  const [ctransFactura, setCtransFactura] = useState<File | null>(null)
  const [ctransUploading, setCtransUploading] = useState(false)
  const [ctransErr, setCtransErr] = useState<string | null>(null)
  const [gastosOperativos, setGastosOperativos] = useState<(GastoMotorizado & { id: string })[]>([])
  const [lightboxUrl, setLightboxUrl] = useState<string | null>(null)

  useEffect(() => {
    const t = setInterval(() => setTick(Date.now()), 1000)
    return () => clearInterval(t)
  }, [])

  useEffect(() => {
    const q = query(
      collection(db, 'gastos_motorizado'),
      where('ordenId', '==', solicitudId),
    )
    return onSnapshot(q, (snap) => {
      const docs = snap.docs.map((d) => ({ id: d.id, ...(d.data() as GastoMotorizado) }))
      docs.sort((a, b) => {
        const ta = typeof (a.createdAt as any)?.toMillis === 'function' ? (a.createdAt as any).toMillis() : 0
        const tb = typeof (b.createdAt as any)?.toMillis === 'function' ? (b.createdAt as any).toMillis() : 0
        return tb - ta
      })
      setGastosOperativos(docs)
    }, (e) => console.error('[SolicitudDrawer] gastos_motorizado:', e))
  }, [solicitudId])

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
        setComercioRequiereBolso(null)
        setSolicitud(data)
        setPrecioFinal(
          data.confirmacion?.precioFinalCordobas ??
          data.pagoDelivery?.montoSugerido ??
          ''
        )
        setMotorizadoSel(data.asignacion?.motorizadoId || '')
        setLoading(false)
      },
      (e) => { console.error(e); setErr('No se pudo cargar.'); setLoading(false) }
    )
    return () => unsub()
  }, [solicitudId])

  // Fetch del comercio para resolver requiereBolso
  useEffect(() => {
    if (!solicitud?.userId) return
    getDoc(doc(db, 'comercios', solicitud.userId))
      .then((snap) => {
        setComercioRequiereBolso(snap.exists() ? (snap.data()?.requiereBolso ?? false) : false)
      })
      .catch(() => setComercioRequiereBolso(false))
  }, [solicitud?.userId])

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

  async function handleCargotransUpload() {
    if (!solicitud || ctransFiles.length === 0) return
    setCtransUploading(true); setCtransErr(null)
    try {
      const fotos: Array<{ url: string; pathStorage: string }> = []
      for (let i = 0; i < ctransFiles.length; i++) {
        const blob = await compressImage(ctransFiles[i])
        const path = `evidencias/${solicitud.id}/cargotrans_paquete_${i + 1}.jpg`
        const result = await uploadEvidenciaPath(path, blob)
        fotos.push(result)
      }
      let factura: { url: string; pathStorage: string } | undefined
      if (ctransFactura) {
        const blob = await compressImage(ctransFactura)
        const path = `evidencias/${solicitud.id}/cargotrans_factura.jpg`
        factura = await uploadEvidenciaPath(path, blob)
      }
      await updateDoc(doc(db, 'solicitudes_envio', solicitud.id), {
        evidenciasCargotrans: {
          fotos,
          ...(factura ? { factura } : {}),
          subidasAt: serverTimestamp(),
          subidasPorUid: auth.currentUser?.uid ?? '',
        },
        updatedAt: serverTimestamp(),
      })
      setCtransFiles([]); setCtransFactura(null)
    } catch (e) {
      console.error(e)
      setCtransErr('Error al subir las fotos. Intentá de nuevo.')
    } finally {
      setCtransUploading(false)
    }
  }

  // Ranking de sugerencia — función pura, sin I/O
  const rankingCalculado = useMemo<MotorizadoRankeado[]>(() => {
    if (!solicitud || motorizados.length === 0) return []
    // Cadena de herencia: orden explícita → comercio → false
    const requiereBolso =
      solicitud.requiereBolso ??
      (comercioRequiereBolso !== null ? comercioRequiereBolso : false)
    const nuevaOrden: NuevaOrdenRanking = {
      recoleccion: { coord: solicitud.recoleccion?.coord ?? null },
      entrega: { coord: solicitud.entrega?.coord ?? null },
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
        ...(m ? { asignacion: { motorizadoId: m.id, motorizadoAuthUid: m.authUid || '', motorizadoNombre: m.nombre, motorizadoTelefono: m.telefono || '', motorizadoFotoUrl: (m as any).fotoUrl || null, asignadoPorUid: user.uid, asignadoAt: serverTimestamp(), estadoAceptacion: 'pendiente', aceptadoAt: null, rechazadoAt: null, motivoRechazo: '', aceptarAntesDe } } : { asignacion: null }),
        updatedAt: serverTimestamp(),
      } as any)
      setErr(null)
    } catch (e) { console.error(e); setErr('No se pudo guardar.') }
  }

  const cambiarEstado = async (nuevo: EstadoSolicitud) => {
    if (!solicitud) return
    const motorizadoId = solicitud.asignacion?.motorizadoId
    try {
      const b = writeBatch(db)
      b.update(doc(db, 'solicitudes_envio', solicitud.id), {
        estado: nuevo,
        updatedAt: serverTimestamp(),
        [`historial.${nuevo}At`]: serverTimestamp(),
      } as any)

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
            { totalViajes: increment(1), totalEntregados: increment(1), updatedAt: serverTimestamp() },
            { merge: true }
          )
        }
      }
    } catch { setErr('No se pudo cambiar el estado.') }
  }

  const rebotarAsignacion = async () => {
    if (!solicitud) return
    const motorizadoId = solicitud.asignacion?.motorizadoId
    try {
      const b = writeBatch(db)
      b.update(doc(db, 'solicitudes_envio', solicitud.id), { estado: 'confirmada', asignacion: null, updatedAt: serverTimestamp() } as any)
      if (motorizadoId) b.update(doc(db, 'motorizado', motorizadoId), { estado: 'disponible', updatedAt: serverTimestamp() })
      await b.commit()
    } catch { setErr('No se pudo rebotar.') }
  }

  const reactivarOrden = async () => {
    if (!solicitud) return
    const motorizadoId = solicitud.asignacion?.motorizadoId
    try {
      const b = writeBatch(db)
      b.update(doc(db, 'solicitudes_envio', solicitud.id), {
        estado: 'pendiente_confirmacion',
        rechazo: null,
        asignacion: null,
        updatedAt: serverTimestamp(),
      } as any)
      if (motorizadoId) b.update(doc(db, 'motorizado', motorizadoId), { estado: 'disponible', updatedAt: serverTimestamp() })
      await b.commit()
      setErr(null)
    } catch { setErr('No se pudo reactivar la orden.') }
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
      if (motorizadoId) b.update(doc(db, 'motorizado', motorizadoId), { estado: 'disponible', updatedAt: serverTimestamp() })
      await b.commit()
      setShowRechazarModal(false)
      setMotivoCodigo('')
      setMotivoTexto('')
      setDetalleRechazo('')
      setErr(null)
    } catch { setErr('No se pudo rechazar la orden.') }
  }

  const retiroMaps = solicitud ? getBestMapsUrl(solicitud, 'recoleccion') : null
  const entregaMaps = solicitud ? getBestMapsUrl(solicitud, 'entrega') : null
  const estado = solicitud?.estado
  const minLeft = tiempoRestante !== null ? Math.floor(tiempoRestante / 60000) : null

  return (
    <>
      {/* Lightbox */}
      {lightboxUrl && (
        <div
          className="fixed inset-0 z-[70] flex items-center justify-center bg-black/85 backdrop-blur-sm p-4"
          onClick={() => setLightboxUrl(null)}
        >
          <button
            onClick={() => setLightboxUrl(null)}
            className="absolute top-4 right-4 w-9 h-9 rounded-full bg-white/10 hover:bg-white/20 flex items-center justify-center transition text-white"
          >
            <X size={18} />
          </button>
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img
            src={lightboxUrl}
            alt="Vista ampliada"
            className="max-w-full max-h-[90vh] object-contain rounded-2xl shadow-2xl"
            onClick={(e) => e.stopPropagation()}
          />
        </div>
      )}

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
                      {solicitud.zonaRetiroNombre && (
                        <div className="mt-1 inline-flex items-center gap-1 rounded-full bg-indigo-50 border border-indigo-200 px-2 py-0.5 text-[11px] font-semibold text-indigo-700">
                          <MapPin size={10} />
                          {solicitud.zonaRetiroNombre}
                        </div>
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
              <Section
                title={
                  solicitud.tipoServicio === 'fuera_managua'
                    ? solicitud.fueraManagua?.metodoEnvio === 'cargotrans'
                      ? 'Entrega — Sucursal Cargotrans'
                      : 'Entrega — Terminal / Bus'
                    : 'Entrega'
                }
                accent="emerald"
              >
                <div className="space-y-2.5">
                  {solicitud.tipoServicio === 'fuera_managua' && solicitud.fueraManagua ? (
                    <div className="flex items-start gap-3">
                      <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-violet-100 text-violet-600">
                        <Package size={15} />
                      </div>
                      <div className="min-w-0 flex-1">
                        <div className="text-sm font-semibold text-gray-900 leading-tight">
                          {solicitud.fueraManagua.puntoLogisticoNombre || solicitud.fueraManagua.terminalSugerida || '—'}
                        </div>
                        {solicitud.fueraManagua.direccionPuntoLogistico && (
                          <div className="mt-1 text-xs text-gray-500 leading-snug">
                            📌 {solicitud.fueraManagua.direccionPuntoLogistico}
                          </div>
                        )}
                        {solicitud.fueraManagua.destinoFinal && (
                          <div className="mt-1 inline-flex items-center gap-1 rounded-full bg-violet-50 border border-violet-200 px-2 py-0.5 text-xs font-semibold text-violet-700">
                            Destino: {solicitud.fueraManagua.destinoFinal}
                          </div>
                        )}
                        {(solicitud.fueraManagua.horarioApertura || solicitud.fueraManagua.horarioCierre) && (
                          <div className="mt-1 text-xs text-gray-500">
                            🕐 {solicitud.fueraManagua.horarioApertura || '?'}–{solicitud.fueraManagua.horarioCierre || '?'}
                          </div>
                        )}
                        {solicitud.fueraManagua.cantidadPaquetes != null && (
                          <div className="mt-1 text-xs text-gray-600">📦 Paquetes: {solicitud.fueraManagua.cantidadPaquetes}</div>
                        )}
                        {solicitud.zonaEntregaNombre && (
                          <div className="mt-1 inline-flex items-center gap-1 rounded-full bg-indigo-50 border border-indigo-200 px-2 py-0.5 text-[11px] font-semibold text-indigo-700">
                            <MapPin size={10} />
                            {solicitud.zonaEntregaNombre}
                          </div>
                        )}
                        {solicitud.cobroContraEntrega?.aplica && (
                          <div className="mt-1 inline-flex items-center gap-1 rounded-full bg-emerald-50 border border-emerald-200 px-2 py-0.5 text-xs font-semibold text-emerald-700">
                            CE: {money(solicitud.cobroContraEntrega.monto)}
                          </div>
                        )}
                      </div>
                    </div>
                  ) : (
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
                        {solicitud.zonaEntregaNombre && (
                          <div className="mt-1 inline-flex items-center gap-1 rounded-full bg-indigo-50 border border-indigo-200 px-2 py-0.5 text-[11px] font-semibold text-indigo-700">
                            <MapPin size={10} />
                            {solicitud.zonaEntregaNombre}
                          </div>
                        )}
                        {solicitud.entrega?.nota && (
                          <div className="mt-1 rounded-lg bg-emerald-50 border border-emerald-100 px-2.5 py-1.5 text-xs text-emerald-700 italic">{solicitud.entrega.nota}</div>
                        )}
                      </div>
                    </div>
                  )}
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
                  <InfoRow label="Tipo servicio" value={solicitud.tipoServicio === 'fuera_managua' ? (solicitud.fueraManagua?.metodoEnvio === 'cargotrans' ? '📦 Cargotrans' : '🚌 Bus / terminal') : solicitud.tipoServicio === 'normal' || !solicitud.tipoServicio ? '📦 Normal' : solicitud.tipoServicio} />
                  <InfoRow label="Distancia" value={solicitud.cotizacion?.distanciaKm != null ? `${solicitud.cotizacion.distanciaKm} km` : undefined} />
                  {solicitud.precioDesglose ? (
                    <>
                      <InfoRow label="Delivery base" value={solicitud.precioDesglose.deliveryBase != null ? money(solicitud.precioDesglose.deliveryBase) : undefined} />
                      {(solicitud.precioDesglose.recargoZona ?? 0) > 0 && <InfoRow label="Recargo zona" value={money(solicitud.precioDesglose.recargoZona!)} />}
                      {(solicitud.precioDesglose.recargoServicio ?? 0) > 0 && <InfoRow label="Recargo fuera Managua" value={money(solicitud.precioDesglose.recargoServicio!)} />}
                      <InfoRow label="Total cobrado" value={solicitud.precioDesglose.totalCobrado != null ? money(solicitud.precioDesglose.totalCobrado) : undefined} />
                    </>
                  ) : (
                    <InfoRow label="Precio sugerido" value={solicitud.cotizacion?.precioSugerido != null ? money(solicitud.cotizacion.precioSugerido) : solicitud.pagoDelivery?.montoSugerido != null ? money(solicitud.pagoDelivery.montoSugerido) : undefined} />
                  )}
                  <InfoRow label="Precio final" value={solicitud.confirmacion?.precioFinalCordobas != null ? money(solicitud.confirmacion.precioFinalCordobas) : undefined} />
                  <InfoRow label="Cobro CE" value={solicitud.cobroContraEntrega?.aplica ? money(solicitud.cobroContraEntrega.monto) : 'No aplica'} />
                  <InfoRow label="Quién paga delivery" value={solicitud.tipoCliente === 'credito' ? 'Crédito semanal' : solicitud.pagoDelivery?.quienPaga} />
                  <InfoRow label="Creada" value={formatDateTime(solicitud.createdAt)} />
                </div>
                {/* Lógica de deducción delivery ↔ cobro producto */}
                {solicitud.cobroContraEntrega?.aplica && solicitud.pagoDelivery?.quienPaga === 'entrega' && (() => {
                  const montoProducto = solicitud.cobroContraEntrega.monto ?? 0
                  const precioDelivery = solicitud.confirmacion?.precioFinalCordobas ?? solicitud.pagoDelivery?.montoSugerido ?? 0
                  const deducir = solicitud.pagoDelivery.deducirDelCobroContraEntrega === true
                  const clientePaga = deducir ? montoProducto : montoProducto + precioDelivery
                  const deposito = deducir ? Math.max(montoProducto - precioDelivery, 0) : montoProducto
                  return (
                    <div className={`mt-3 rounded-xl border p-3 space-y-2 ${deducir ? 'bg-orange-50 border-orange-200' : 'bg-blue-50 border-blue-200'}`}>
                      <div className="flex items-center gap-2">
                        <span className={`text-[10px] font-black uppercase tracking-wide ${deducir ? 'text-orange-700' : 'text-blue-700'}`}>
                          {deducir ? 'Delivery deducido del cobro' : 'Delivery cobrado aparte'}
                        </span>
                        <span className={`text-[10px] font-semibold px-2 py-0.5 rounded-full ${deducir ? 'bg-orange-200 text-orange-800' : 'bg-blue-200 text-blue-800'}`}>
                          {deducir ? 'Incluido en el cobro' : 'Cobro adicional'}
                        </span>
                      </div>
                      <div className="grid grid-cols-3 gap-2 text-center">
                        <div className="rounded-lg bg-white border border-gray-200 p-2">
                          <p className="text-[9px] font-bold uppercase text-gray-400 mb-0.5">Cliente paga</p>
                          <p className="text-sm font-black text-gray-900">{precioDelivery > 0 ? money(clientePaga) : '—'}</p>
                          <p className="text-[9px] text-gray-400">{deducir ? 'todo incluido' : 'producto + delivery'}</p>
                        </div>
                        <div className="rounded-lg bg-white border border-gray-200 p-2">
                          <p className="text-[9px] font-bold uppercase text-gray-400 mb-0.5">Delivery</p>
                          <p className="text-sm font-black text-[#004aad]">{precioDelivery > 0 ? money(precioDelivery) : '—'}</p>
                          <p className="text-[9px] text-gray-400">{deducir ? 'sale del cobro' : 'cobra aparte'}</p>
                        </div>
                        <div className="rounded-lg bg-white border border-gray-200 p-2">
                          <p className="text-[9px] font-bold uppercase text-gray-400 mb-0.5">Depósito comercio</p>
                          <p className={`text-sm font-black ${deducir && precioDelivery > 0 ? 'text-orange-700' : 'text-green-700'}`}>{precioDelivery > 0 ? money(deposito) : money(montoProducto)}</p>
                          <p className="text-[9px] text-gray-400">{deducir ? 'ya descontado' : 'monto producto'}</p>
                        </div>
                      </div>
                    </div>
                  )
                })()}
                {solicitud.detalle?.trim() && (
                  <div className="mt-1 rounded-lg border border-amber-100 bg-amber-50 p-3 text-xs text-amber-800 whitespace-pre-wrap leading-relaxed">{solicitud.detalle.trim()}</div>
                )}
              </Section>

              {/* Boucher de pago delivery (transferencia) */}
              {solicitud.pagoDelivery?.quienPaga === 'transferencia' && (
                <Section title="Pago delivery — Transferencia" accent="blue">
                  <div className="space-y-3">
                    <div className="grid grid-cols-2 gap-x-4 gap-y-2">
                      <InfoRow label="Estado" value={
                        solicitud.cobroDelivery?.estado === 'pagado' ? '✓ Confirmado'
                        : solicitud.cobroDelivery?.estado === 'en_revision_deposito' ? '🔍 En revisión'
                        : '⏳ Pendiente'
                      } />
                      <InfoRow label="Monto" value={solicitud.cobroDelivery?.monto != null ? money(solicitud.cobroDelivery.monto) : solicitud.confirmacion?.precioFinalCordobas != null ? money(solicitud.confirmacion.precioFinalCordobas) : undefined} />
                      {solicitud.cobroDelivery?.pagadoAt && <InfoRow label="Confirmado" value={formatDateTime(solicitud.cobroDelivery.pagadoAt)} />}
                      {solicitud.cobroDelivery?.subidoPor && <InfoRow label="Subido por" value={solicitud.cobroDelivery.subidoPor === 'gestor' ? 'Gestor' : 'Comercio'} />}
                      {solicitud.cobroDelivery?.boucherAt && <InfoRow label="Fecha boucher" value={formatDateTime(solicitud.cobroDelivery.boucherAt)} />}
                    </div>
                    {solicitud.cobroDelivery?.boucherUrl ? (
                      <div className="space-y-2">
                        <div className="text-[10px] font-bold uppercase tracking-wide text-blue-500">📎 Boucher adjunto</div>
                        <button onClick={() => setLightboxUrl(solicitud.cobroDelivery!.boucherUrl!)} className="block w-full text-left">
                          {/* eslint-disable-next-line @next/next/no-img-element */}
                          <img
                            src={solicitud.cobroDelivery.boucherUrl}
                            alt="Boucher de transferencia"
                            className="w-full max-h-48 object-contain rounded-xl border border-blue-100 bg-blue-50 hover:opacity-90 transition"
                            loading="lazy"
                          />
                          <p className="text-xs text-center text-blue-600 mt-1 hover:underline">Ver imagen completa →</p>
                        </button>
                      </div>
                    ) : (
                      <div className="rounded-xl border border-dashed border-blue-200 py-5 text-center text-xs text-blue-400">
                        Sin boucher adjunto aún
                      </div>
                    )}
                  </div>
                </Section>
              )}

              {/* Fuera de Managua */}
              {solicitud.tipoServicio === 'fuera_managua' && solicitud.fueraManagua && (
                <Section title={solicitud.fueraManagua.metodoEnvio === 'cargotrans' ? '📦 Envío fuera de Managua — Cargotrans' : '🚌 Envío fuera de Managua — Bus / terminal'} accent="indigo">
                  <div className="grid grid-cols-2 gap-x-4 gap-y-3">
                    {solicitud.fueraManagua.destinoFinal && <InfoRow label="Destino" value={solicitud.fueraManagua.destinoFinal} />}
                    {solicitud.fueraManagua.puntoLogisticoNombre && (
                      <InfoRow
                        label={solicitud.fueraManagua.metodoEnvio === 'cargotrans' ? 'Sucursal Cargotrans' : 'Terminal seleccionada'}
                        value={solicitud.fueraManagua.puntoLogisticoNombre}
                      />
                    )}
                    {solicitud.fueraManagua.transporteNombre && <InfoRow label="Transporte" value={solicitud.fueraManagua.transporteNombre} />}
                    {solicitud.fueraManagua.transporteCelular && <InfoRow label="Celular transporte" value={solicitud.fueraManagua.transporteCelular} />}
                    {solicitud.fueraManagua.transporteHoraSalida && <InfoRow label="Hora salida Managua" value={solicitud.fueraManagua.transporteHoraSalida} />}
                    {solicitud.fueraManagua.transporteNota && <InfoRow label="Nota transporte" value={solicitud.fueraManagua.transporteNota} />}
                    {solicitud.fueraManagua.cantidadPaquetes != null && <InfoRow label="Paquetes" value={String(solicitud.fueraManagua.cantidadPaquetes)} />}
                    {solicitud.fueraManagua.pagoCargotrans && <InfoRow label="Pago flete Cargotrans" value={solicitud.fueraManagua.pagoCargotrans === 'efectivo_motorizado' ? '💵 Efectivo (comercio entrega al motorizado)' : '🏦 Transferencia del comercio'} />}
                    {solicitud.fueraManagua.notaCargotrans && <InfoRow label="Nota Cargotrans" value={solicitud.fueraManagua.notaCargotrans} />}
                  </div>
                  {solicitud.evidenciasTerminal && (
                    <div className="mt-3 space-y-3 border-t border-gray-100 pt-3">
                      <div className="text-[10px] font-bold uppercase tracking-wide text-violet-500">📸 Evidencias de entrega al bus</div>
                      <div className="grid grid-cols-3 gap-2">
                        {solicitud.evidenciasTerminal.fotoPaquete && (
                          <button onClick={() => setLightboxUrl(solicitud.evidenciasTerminal!.fotoPaquete!.url)} className="flex flex-col items-center gap-1 rounded-xl border border-gray-200 bg-gray-50 p-1.5 hover:bg-gray-100 transition">
                            {/* eslint-disable-next-line @next/next/no-img-element */}
                            <img src={solicitud.evidenciasTerminal.fotoPaquete.url} alt="Paquete" className="w-full aspect-square object-cover rounded-lg" loading="lazy" />
                            <span className="text-[10px] text-gray-500 uppercase font-medium">📦 Paquete</span>
                          </button>
                        )}
                        {solicitud.evidenciasTerminal.fotoTicket && (
                          <button onClick={() => setLightboxUrl(solicitud.evidenciasTerminal!.fotoTicket!.url)} className="flex flex-col items-center gap-1 rounded-xl border border-gray-200 bg-gray-50 p-1.5 hover:bg-gray-100 transition">
                            {/* eslint-disable-next-line @next/next/no-img-element */}
                            <img src={solicitud.evidenciasTerminal.fotoTicket.url} alt="Ticket" className="w-full aspect-square object-cover rounded-lg" loading="lazy" />
                            <span className="text-[10px] text-gray-500 uppercase font-medium">🎫 Ticket</span>
                          </button>
                        )}
                        {solicitud.evidenciasTerminal.fotoBus && (
                          <button onClick={() => setLightboxUrl(solicitud.evidenciasTerminal!.fotoBus!.url)} className="flex flex-col items-center gap-1 rounded-xl border border-gray-200 bg-gray-50 p-1.5 hover:bg-gray-100 transition">
                            {/* eslint-disable-next-line @next/next/no-img-element */}
                            <img src={solicitud.evidenciasTerminal.fotoBus.url} alt="Bus" className="w-full aspect-square object-cover rounded-lg" loading="lazy" />
                            <span className="text-[10px] text-gray-500 uppercase font-medium">🚌 Bus</span>
                          </button>
                        )}
                      </div>
                      {solicitud.evidenciasTerminal.sinTicket && (
                        <div className="rounded-lg bg-amber-50 border border-amber-200 p-2.5 space-y-1.5">
                          <div className="text-[10px] font-bold uppercase text-amber-600">Sin ticket — datos del transporte</div>
                          {solicitud.evidenciasTerminal.busNombre && <InfoRow label="Bus / empresa" value={solicitud.evidenciasTerminal.busNombre} />}
                          {solicitud.evidenciasTerminal.busNumero && <InfoRow label="Número / placa" value={solicitud.evidenciasTerminal.busNumero} />}
                          {solicitud.evidenciasTerminal.busCelular && <InfoRow label="Celular cobrador" value={solicitud.evidenciasTerminal.busCelular} />}
                          {solicitud.evidenciasTerminal.horaLlegadaDestino && <InfoRow label="Hora llegada destino" value={solicitud.evidenciasTerminal.horaLlegadaDestino} />}
                          {solicitud.evidenciasTerminal.costoFlete != null && <InfoRow label="Costo flete (informativo)" value={`C$ ${solicitud.evidenciasTerminal.costoFlete}`} />}
                        </div>
                      )}
                    </div>
                  )}
                  {/* Cargotrans: subida de fotos por el gestor */}
                  {solicitud.fueraManagua?.metodoEnvio === 'cargotrans' && (
                    <div className="mt-3 border-t border-gray-100 pt-3 space-y-3">
                      <div className="text-[10px] font-bold uppercase tracking-wide text-violet-500">📸 Fotos de entrega en Cargotrans</div>
                      {solicitud.evidenciasCargotrans ? (
                        <div className="space-y-2">
                          {(solicitud.evidenciasCargotrans.fotos ?? []).length > 0 && (
                            <div>
                              <div className="text-[10px] font-semibold text-gray-400 uppercase mb-1.5">Paquetes ({solicitud.evidenciasCargotrans.fotos!.length})</div>
                              <div className="grid grid-cols-3 gap-2">
                                {solicitud.evidenciasCargotrans.fotos!.map((f, i) => (
                                  <button key={i} onClick={() => setLightboxUrl(f.url)} className="flex flex-col items-center gap-1 rounded-xl border border-gray-200 bg-gray-50 p-1.5 hover:bg-gray-100 transition">
                                    {/* eslint-disable-next-line @next/next/no-img-element */}
                                    <img src={f.url} alt={`Paquete ${i + 1}`} className="w-full aspect-square object-cover rounded-lg" loading="lazy" />
                                    <span className="text-[10px] text-gray-500 uppercase font-medium">📦 #{i + 1}</span>
                                  </button>
                                ))}
                              </div>
                            </div>
                          )}
                          {solicitud.evidenciasCargotrans.factura && (
                            <button onClick={() => setLightboxUrl(solicitud.evidenciasCargotrans!.factura!.url)} className="flex items-center gap-2 text-xs text-indigo-600 underline font-semibold">
                              🧾 Ver factura
                            </button>
                          )}
                          {solicitud.evidenciasCargotrans.costoCargotrans != null && (
                            <div className="flex items-center gap-1.5 text-xs">
                              <span className="text-gray-500">Costo Cargotrans:</span>
                              <span className="font-bold text-violet-700">C$ {solicitud.evidenciasCargotrans.costoCargotrans}</span>
                            </div>
                          )}
                        </div>
                      ) : solicitud.estado === 'entregado' ? (
                        <div className="space-y-2.5">
                          <div>
                            <label className="text-[11px] font-semibold text-gray-600 block mb-1">Fotos de paquetes <span className="text-red-500">*</span></label>
                            <input
                              type="file" accept="image/*" multiple
                              onChange={e => setCtransFiles(e.target.files ? Array.from(e.target.files) : [])}
                              className="block w-full text-xs text-gray-500 file:mr-2 file:py-1 file:px-3 file:rounded-lg file:border-0 file:text-xs file:font-semibold file:bg-violet-50 file:text-violet-700 hover:file:bg-violet-100"
                            />
                            {ctransFiles.length > 0 && <p className="text-[11px] text-violet-600 mt-1">{ctransFiles.length} foto(s) seleccionada(s)</p>}
                          </div>
                          <div>
                            <label className="text-[11px] font-semibold text-gray-600 block mb-1">Factura de Cargotrans</label>
                            <input
                              type="file" accept="image/*"
                              onChange={e => setCtransFactura(e.target.files?.[0] ?? null)}
                              className="block w-full text-xs text-gray-500 file:mr-2 file:py-1 file:px-3 file:rounded-lg file:border-0 file:text-xs file:font-semibold file:bg-violet-50 file:text-violet-700 hover:file:bg-violet-100"
                            />
                          </div>
                          {ctransErr && <p className="text-xs text-red-500 font-semibold">{ctransErr}</p>}
                          <button
                            type="button"
                            onClick={handleCargotransUpload}
                            disabled={ctransFiles.length === 0 || ctransUploading}
                            className={`w-full rounded-xl px-4 py-2.5 text-sm font-bold transition ${ctransFiles.length === 0 || ctransUploading ? 'bg-gray-200 text-gray-400 cursor-not-allowed' : 'bg-violet-600 text-white hover:bg-violet-700'}`}
                          >
                            {ctransUploading ? 'Subiendo...' : '📤 Subir fotos de entrega'}
                          </button>
                        </div>
                      ) : (
                        <p className="text-xs text-gray-400">Disponible cuando la orden esté entregada.</p>
                      )}
                    </div>
                  )}
                </Section>
              )}

              {/* Gastos especiales / peaje */}
              {solicitud.gastosEspeciales && solicitud.gastosEspeciales.length > 0 && (
                <Section title="Gastos especiales" accent="red">
                  <div className="space-y-3">
                    {solicitud.gastosEspeciales.map((gasto, idx) => (
                      <div key={idx} className="rounded-lg border border-red-100 bg-red-50 p-3 space-y-1.5">
                        <div className="flex items-center justify-between">
                          <span className="text-sm font-bold text-red-800 capitalize">{gasto.tipo === 'peaje' ? '🛣️ Peaje' : gasto.tipo}</span>
                          <span className={`text-xs font-bold rounded-full px-2 py-0.5 ${gasto.estado === 'aprobado' ? 'bg-green-100 text-green-700' : gasto.estado === 'rechazado' ? 'bg-red-200 text-red-700' : 'bg-yellow-100 text-yellow-700'}`}>
                            {gasto.estado === 'reportado' ? 'Reportado' : gasto.estado === 'pendiente' ? 'Pendiente' : gasto.estado === 'aprobado' ? 'Aprobado' : 'Rechazado'}
                          </span>
                        </div>
                        <div className="text-xs text-red-700">Monto reportado: <strong>C$ {gasto.monto}</strong></div>
                        {gasto.montoOficial != null && <div className="text-xs text-green-700 font-semibold">Monto oficial: C$ {gasto.montoOficial}</div>}
                        {gasto.nota && <div className="text-xs text-gray-600">📝 {gasto.nota}</div>}
                        {gasto.comprobante && (
                          <a href={gasto.comprobante.url} target="_blank" rel="noopener noreferrer" className="text-xs text-indigo-600 underline">📷 Ver comprobante</a>
                        )}
                        {(gasto.estado === 'reportado' || gasto.estado === 'pendiente') && (
                          <div className="flex gap-2 mt-1.5 pt-1.5 border-t border-red-200">
                            <button
                              type="button"
                              onClick={async () => {
                                const montoStr = window.prompt(`Monto oficial del peaje (C$):`, String(gasto.monto))
                                if (!montoStr || isNaN(Number(montoStr))) return
                                const updated = [...(solicitud.gastosEspeciales ?? [])]
                                updated[idx] = { ...updated[idx], estado: 'aprobado', montoOficial: Number(montoStr), autorizadoPorGestor: true }
                                await updateDoc(doc(db, 'solicitudes_envio', solicitud.id), { gastosEspeciales: updated, updatedAt: serverTimestamp() })
                              }}
                              className="text-xs bg-green-600 text-white rounded px-2 py-1 font-semibold"
                            >
                              ✓ Aprobar
                            </button>
                            <button
                              type="button"
                              onClick={async () => {
                                const updated = [...(solicitud.gastosEspeciales ?? [])]
                                updated[idx] = { ...updated[idx], estado: 'rechazado', autorizadoPorGestor: true }
                                await updateDoc(doc(db, 'solicitudes_envio', solicitud.id), { gastosEspeciales: updated, updatedAt: serverTimestamp() })
                              }}
                              className="text-xs bg-red-600 text-white rounded px-2 py-1 font-semibold"
                            >
                              ✗ Rechazar
                            </button>
                          </div>
                        )}
                      </div>
                    ))}
                  </div>
                </Section>
              )}

              {/* Gastos operativos vinculados */}
              {gastosOperativos.length > 0 && (
                <Section title="Gastos operativos" accent="red">
                  <div className="space-y-2">
                    {gastosOperativos.map((g) => {
                      const tipoLabel = LABELS_TIPO_GASTO[g.tipo] ?? g.tipo
                      const fecha = typeof (g.fecha as any)?.toDate === 'function'
                        ? (g.fecha as any).toDate()
                        : g.fecha instanceof Date ? g.fecha : null
                      return (
                        <div key={g.id} className="rounded-lg border border-red-100 bg-red-50 px-3 py-2.5 space-y-1">
                          <div className="flex items-center justify-between gap-2">
                            <span className="text-sm font-bold text-red-800">{tipoLabel}</span>
                            <div className="flex items-center gap-2 shrink-0">
                              <span className="text-sm font-black text-red-700">C$ {g.monto}</span>
                              <span className={`text-[11px] font-semibold px-2 py-0.5 rounded-full ${g.estado === 'aprobado' ? 'bg-green-100 text-green-700' : 'bg-gray-100 text-gray-500'}`}>
                                {g.estado === 'aprobado' ? 'Aprobado' : 'Anulado'}
                              </span>
                            </div>
                          </div>
                          {g.nota && (
                            <p className="text-xs text-red-700 italic">{g.nota}</p>
                          )}
                          {fecha && (
                            <p className="text-[11px] text-gray-400">
                              {fecha.toLocaleDateString('es-NI', { day: '2-digit', month: 'short', year: 'numeric' })}
                            </p>
                          )}
                        </div>
                      )
                    })}
                  </div>
                </Section>
              )}

              {/* Motorizado actual */}
              {solicitud.asignacion?.motorizadoNombre && (
                <Section title="Motorizado asignado" accent="indigo">
                  <div className="flex items-start gap-3">
                    <div className="h-10 w-10 shrink-0 rounded-full overflow-hidden bg-indigo-100 border border-indigo-200">
                      {solicitud.asignacion.motorizadoFotoUrl ? (
                        // eslint-disable-next-line @next/next/no-img-element
                        <img
                          src={solicitud.asignacion.motorizadoFotoUrl}
                          alt={solicitud.asignacion.motorizadoNombre}
                          className="w-full h-full object-cover"
                        />
                      ) : (
                        <div className="w-full h-full flex items-center justify-center text-indigo-600">
                          <Bike size={15} />
                        </div>
                      )}
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
                // Fuente de verdad: confirmadoStorkhub / confirmadoComercio / depositoIds.
                // confirmadoMotorizado es legacy — se muestra solo si existe en docs anteriores.
                const tieneInfo = dep.confirmadoComercio || dep.confirmadoStorkhub
                  || dep.storkhubDepositoId || dep.comercioDepositoId
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
                      {!dep.confirmadoStorkhub && dep.storkhubDepositoId && (
                        <InfoRow label="Storkhub" value="⏳ En revisión" />
                      )}
                      {dep.confirmadoComercio && (
                        <>
                          <InfoRow label="Comercio" value="✓ Confirmado" />
                          <InfoRow label="Fecha Comercio" value={formatDateTime(dep.confirmadoComercioAt)} />
                        </>
                      )}
                      {!dep.confirmadoComercio && dep.comercioDepositoId && (
                        <InfoRow label="Comercio" value="⏳ En revisión" />
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
                          onClick={() => setLightboxUrl(ev.url)}
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

              {/* Tarjeta de rechazo */}
              {estado === 'rechazada' && solicitud?.rechazo && (
                <Section title="Rechazo" accent="red">
                  <div className="rounded-xl border border-red-200 bg-red-50 p-3 space-y-1">
                    <p className="text-sm font-semibold text-red-700">Orden rechazada</p>
                    {solicitud.rechazo.motivoTexto && (
                      <p className="text-xs text-red-600">Motivo: {solicitud.rechazo.motivoTexto}</p>
                    )}
                    {solicitud.rechazo.detalle && (
                      <p className="text-xs text-red-600">Detalle: {solicitud.rechazo.detalle}</p>
                    )}
                    {solicitud.rechazo.rechazadoAt && (
                      <p className="text-xs text-gray-400">{formatDateTime(solicitud.rechazo.rechazadoAt)}</p>
                    )}
                  </div>
                </Section>
              )}

              {/* Reactivar — solo para estados terminales recuperables */}
              {(estado === 'rechazada' || estado === 'cancelada') && (
                <Section title="Acciones" accent="gray">
                  <div className="space-y-2">
                    <p className="text-xs text-gray-500">
                      {estado === 'rechazada'
                        ? 'Esta orden fue rechazada. Puedes reactivarla para volver a evaluarla.'
                        : 'Esta orden fue cancelada. Puedes reactivarla para volver a procesarla.'}
                    </p>
                    <button
                      onClick={reactivarOrden}
                      className="w-full inline-flex items-center justify-center gap-2 rounded-xl border border-amber-200 bg-amber-50 px-4 py-2.5 text-sm font-semibold text-amber-700 hover:bg-amber-100 transition"
                    >
                      <RotateCcw size={15} /> Reactivar orden
                    </button>
                    {err && (
                      <div className="rounded-xl border border-red-200 bg-red-50 px-3 py-2 text-xs text-red-700">{err}</div>
                    )}
                  </div>
                </Section>
              )}

              {/* Decisión rápida — oculta para estados terminales */}
              {estado !== 'rechazada' && estado !== 'cancelada' && estado !== 'entregado' && (
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

                    {/* Lista de candidatos */}
                    <div className="space-y-1.5 max-h-[280px] overflow-y-auto pr-0.5">
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
                              {/* Badge estado */}
                              <span className={`shrink-0 inline-flex items-center gap-1 text-[10px] font-bold px-2 py-1 rounded-full border ${
                                m.estado === 'disponible'
                                  ? 'bg-green-50 text-green-700 border-green-200'
                                  : 'bg-yellow-50 text-yellow-700 border-yellow-200'
                              }`}>
                                <span className={`w-1.5 h-1.5 rounded-full ${m.estado === 'disponible' ? 'bg-green-500' : 'bg-yellow-500'}`} />
                                {m.estado === 'disponible' ? 'Disp.' : (m.estado || 'Ocup.')}
                              </span>

                              {/* Nombre + explicacion */}
                              <div className="flex-1 min-w-0">
                                <div className="flex items-center gap-1.5 min-w-0">
                                  {esMejor && <Star size={10} className="text-amber-500 shrink-0" />}
                                  <span className="text-xs font-bold text-gray-900 truncate">{m.nombre}</span>
                                  {m.telefono && <span className="text-[10px] text-gray-400 shrink-0">{m.telefono}</span>}
                                </div>
                                {sr?.explicacion && (
                                  <p className="text-[10px] text-gray-500 mt-0.5 leading-snug truncate">{sr.explicacion}</p>
                                )}
                              </div>

                              {/* Score badge con color */}
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
                      <CheckCircle2 size={15} /> Guardar confirmación / asignación
                    </button>

                    {estado === 'pendiente_confirmacion' && (
                      <button
                        onClick={() => { setShowRechazarModal(true); setErr(null) }}
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
              )}

            </div>
          )}
        </div>
      </div>

      {/* Modal de rechazo */}
      {showRechazarModal && (
        <div className="fixed inset-0 z-[60] flex items-center justify-center bg-black/40 backdrop-blur-[2px] p-4">
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
