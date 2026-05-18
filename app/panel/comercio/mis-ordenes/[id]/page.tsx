'use client'

import { useEffect, useState } from 'react'
import { useParams, useRouter } from 'next/navigation'
import Link from 'next/link'
import { doc, onSnapshot, Timestamp } from 'firebase/firestore'
import { auth, db } from '@/fb/config'
import { ChevronLeft } from 'lucide-react'

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
  pagoDelivery?: { tipo?: string; quienPaga?: string; montoSugerido?: number | null }
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
    boucherUrl?: string
    boucherAt?: any
    subidoPor?: string
    pagadoAt?: any
    monto?: number
  }
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

const estadoLabel: Record<string, string> = {
  pendiente_confirmacion: 'Pendiente de confirmación',
  confirmada: 'Confirmada',
  asignada: 'Asignada a motorizado',
  en_camino_retiro: 'En camino al retiro',
  retirado: 'Paquete retirado',
  en_camino_entrega: 'En camino a entrega',
  entregado: 'Entregada ✓',
  cancelada: 'Cancelada',
  rechazada: 'Solicitud rechazada',
}

const estadoCls: Record<string, string> = {
  pendiente_confirmacion: 'bg-gray-100 text-gray-600',
  confirmada: 'bg-blue-50 text-blue-700',
  asignada: 'bg-yellow-50 text-yellow-700',
  en_camino_retiro: 'bg-yellow-50 text-yellow-700',
  retirado: 'bg-purple-50 text-purple-700',
  en_camino_entrega: 'bg-purple-50 text-purple-700',
  entregado: 'bg-green-50 text-green-700',
  cancelada: 'bg-red-50 text-red-600',
  rechazada: 'bg-red-50 text-red-700',
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

function fmt(n?: number) {
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

// ─── Component ───────────────────────────────────────────────────────────────

export default function OrdenDetallePage() {
  const { id } = useParams<{ id: string }>()
  const router = useRouter()
  const [orden, setOrden] = useState<Solicitud | null>(null)
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    if (!id) return
    const unsub = onSnapshot(doc(db, 'solicitudes_envio', id), (snap) => {
      if (!snap.exists()) { router.replace('/panel/comercio/mis-ordenes'); return }
      const data = { id: snap.id, ...(snap.data() as any) } as Solicitud
      // Verificar que pertenece al usuario actual
      const user = auth.currentUser
      if (user && data.userId && data.userId !== user.uid) {
        router.replace('/panel/comercio/mis-ordenes'); return
      }
      setOrden(data)
      setLoading(false)
    })
    return () => unsub()
  }, [id, router])

  if (loading) return <div className="py-10 text-center text-sm text-gray-400">Cargando orden…</div>
  if (!orden) return null

  const estadoCl = estadoCls[orden.estado || ''] || 'bg-gray-100 text-gray-600'
  const delivery = debeDelivery(orden)

  const timeline = [
    { key: 'createdAt', label: 'Solicitud creada', ts: orden.createdAt },
    { key: 'en_camino_retiro', label: 'En camino al retiro', ts: orden.historial?.en_camino_retiroAt },
    { key: 'retirado', label: 'Paquete retirado', ts: orden.historial?.retiradoAt },
    { key: 'en_camino_entrega', label: 'En camino a entrega', ts: orden.historial?.en_camino_entregaAt },
    { key: 'entregado', label: 'Entregado al destinatario', ts: orden.historial?.entregadoAt || orden.entregadoAt },
  ].filter((t) => tsToDate(t.ts))

  return (
    <div className="flex flex-col gap-4 max-w-2xl">
      {/* Back + Header */}
      <div>
        <Link href="/panel/comercio/mis-ordenes"
          className="inline-flex items-center gap-1 text-sm text-gray-500 hover:text-[#004aad] mb-3 transition">
          <ChevronLeft size={16} /> Mis órdenes
        </Link>
        <div className="flex items-center justify-between flex-wrap gap-2">
          <div>
            <h1 className="text-xl font-black text-gray-900">Orden #{id.slice(0, 10)}</h1>
            <p className="text-xs text-gray-400 mt-0.5">{fmtDatetime(orden.createdAt)}</p>
          </div>
          <span className={`inline-flex text-sm font-semibold px-3 py-1.5 rounded-full ${estadoCl}`}>
            {estadoLabel[orden.estado || ''] || orden.estado}
          </span>
        </div>
      </div>

      {/* Ruta */}
      <div className="rounded-xl border border-gray-200 bg-white p-4 space-y-4">
        <h2 className="text-xs font-bold text-gray-500 uppercase tracking-wide">Ruta</h2>
        {/* Retiro — siempre igual */}
        <div className="flex items-start gap-3">
          <div className="w-3 h-3 rounded-full bg-yellow-400 mt-1.5 flex-shrink-0" />
          <div>
            <p className="text-xs font-bold text-gray-500 uppercase">Retiro</p>
            <p className="text-sm font-semibold text-gray-900">{orden.recoleccion?.nombreApellido || '—'}</p>
            {orden.recoleccion?.celular && <p className="text-sm text-gray-500">{orden.recoleccion.celular}</p>}
            <p className="text-sm text-gray-600">{orden.recoleccion?.direccionEscrita || '—'}</p>
            {orden.recoleccion?.nota && (
              <p className="text-xs text-amber-700 bg-amber-50 border border-amber-200 rounded-lg px-2 py-1 mt-1">
                📝 {orden.recoleccion.nota}
              </p>
            )}
          </div>
        </div>
        {/* Entrega — normal o punto logístico */}
        {orden.tipoServicio === 'fuera_managua' && orden.fueraManagua ? (
          <div className="flex items-start gap-3">
            <div className="w-3 h-3 rounded-full bg-violet-500 mt-1.5 flex-shrink-0" />
            <div>
              <p className="text-xs font-bold text-gray-500 uppercase">
                {orden.fueraManagua.metodoEnvio === 'cargotrans' ? 'Sucursal Cargotrans' : 'Terminal / Bus'}
              </p>
              <p className="text-sm font-semibold text-gray-900">
                {orden.fueraManagua.puntoLogisticoNombre || orden.fueraManagua.terminalSugerida || '—'}
              </p>
              {orden.fueraManagua.direccionPuntoLogistico && (
                <p className="text-sm text-gray-600">📌 {orden.fueraManagua.direccionPuntoLogistico}</p>
              )}
              {orden.fueraManagua.destinoFinal && (
                <p className="text-sm text-violet-700 font-semibold">Destino: {orden.fueraManagua.destinoFinal}</p>
              )}
              {(orden.fueraManagua.horarioApertura || orden.fueraManagua.horarioCierre) && (
                <p className="text-xs text-gray-500">🕐 {orden.fueraManagua.horarioApertura || '?'}–{orden.fueraManagua.horarioCierre || '?'}</p>
              )}
              {orden.fueraManagua.metodoEnvio === 'bus_terminal' && orden.fueraManagua.transporteNombre && (
                <p className="text-xs text-gray-600 mt-1">🚌 Transporte: {orden.fueraManagua.transporteNombre}</p>
              )}
              {orden.fueraManagua.metodoEnvio === 'bus_terminal' && orden.fueraManagua.transporteHoraSalida && (
                <p className="text-xs text-gray-600">⏰ Salida: {orden.fueraManagua.transporteHoraSalida}</p>
              )}
              {orden.fueraManagua.metodoEnvio === 'cargotrans' && orden.fueraManagua.cantidadPaquetes != null && (
                <p className="text-xs text-gray-600">📦 Paquetes: {orden.fueraManagua.cantidadPaquetes}</p>
              )}
              {orden.fueraManagua.metodoEnvio === 'cargotrans' && orden.fueraManagua.pagoCargotrans && (
                <p className="text-xs text-gray-600">
                  {orden.fueraManagua.pagoCargotrans === 'efectivo_motorizado' ? '💵 Pago flete: Efectivo (motorizado adelanta)' : '🏦 Pago flete: Transferencia del comercio'}
                </p>
              )}
              {orden.fueraManagua.metodoEnvio === 'cargotrans' && orden.fueraManagua.notaCargotrans && (
                <p className="text-xs text-amber-700 bg-amber-50 border border-amber-200 rounded-lg px-2 py-1 mt-1">
                  📝 {orden.fueraManagua.notaCargotrans}
                </p>
              )}
              {orden.fueraManagua.coordsPuntoLogistico && (
                <a
                  href={`https://www.google.com/maps?q=${orden.fueraManagua.coordsPuntoLogistico.lat},${orden.fueraManagua.coordsPuntoLogistico.lng}`}
                  target="_blank" rel="noopener noreferrer"
                  className="inline-flex items-center gap-1 text-xs text-blue-700 font-semibold mt-1 underline"
                >
                  🗺️ Ver en Maps
                </a>
              )}
            </div>
          </div>
        ) : (
          <div className="flex items-start gap-3">
            <div className="w-3 h-3 rounded-full bg-green-500 mt-1.5 flex-shrink-0" />
            <div>
              <p className="text-xs font-bold text-gray-500 uppercase">Entrega</p>
              <p className="text-sm font-semibold text-gray-900">{orden.entrega?.nombreApellido || '—'}</p>
              {orden.entrega?.celular && <p className="text-sm text-gray-500">{orden.entrega.celular}</p>}
              <p className="text-sm text-gray-600">{orden.entrega?.direccionEscrita || '—'}</p>
              {orden.entrega?.nota && (
                <p className="text-xs text-amber-700 bg-amber-50 border border-amber-200 rounded-lg px-2 py-1 mt-1">
                  📝 {orden.entrega.nota}
                </p>
              )}
            </div>
          </div>
        )}
        {orden.detalle && (
          <div className="pt-2 border-t border-gray-100">
            <p className="text-xs font-bold text-gray-500 uppercase mb-1">Instrucciones adicionales</p>
            <p className="text-sm text-gray-600">{orden.detalle}</p>
          </div>
        )}
      </div>

      {/* Rechazo */}
      {orden.estado === 'rechazada' && (
        <div className="rounded-xl border border-red-200 bg-red-50 p-4 space-y-1.5">
          <p className="text-sm font-bold text-red-700">Tu solicitud fue rechazada</p>
          {orden.rechazo?.visibleParaComercio && orden.rechazo?.motivoTexto && (
            <p className="text-sm text-red-600">Motivo: {orden.rechazo.motivoTexto}</p>
          )}
          {orden.rechazo?.visibleParaComercio && orden.rechazo?.detalle && (
            <p className="text-sm text-red-600">Detalle: {orden.rechazo.detalle}</p>
          )}
          <p className="text-xs text-red-400 mt-1">
            Si tienes dudas, comunícate con el equipo de soporte.
          </p>
        </div>
      )}

      {/* Cobros */}
      <div className="rounded-xl border border-gray-200 bg-white p-4 space-y-3">
        <h2 className="text-xs font-bold text-gray-500 uppercase tracking-wide">Resumen de cobros</h2>

        {/* Delivery */}
        <div className="flex items-center justify-between py-2 border-b border-gray-100">
          <div>
            <p className="text-sm font-semibold text-gray-900">Delivery</p>
            <p className={`text-xs mt-0.5 ${delivery.debe === true ? 'text-red-500' : delivery.debe === false ? 'text-green-600' : 'text-gray-400'}`}>
              {delivery.label}
            </p>
          </div>
          <div className="text-right">
            <p className="text-sm font-bold text-[#004aad]">{fmt(orden.confirmacion?.precioFinalCordobas)}</p>
            {delivery.debe !== null && (
              <span className={`inline-flex text-xs font-semibold px-2 py-0.5 rounded-full ${delivery.debe ? 'bg-red-50 text-red-600' : 'bg-green-50 text-green-700'}`}>
                {delivery.debe ? 'Debe' : 'Pagado'}
              </span>
            )}
          </div>
        </div>

        {/* Boucher de transferencia */}
        {orden.pagoDelivery?.quienPaga === 'transferencia' && (
          <div className="py-3 border-b border-gray-100 space-y-2">
            <div className="flex items-center justify-between">
              <div>
                <p className="text-sm font-semibold text-gray-900">Boucher de transferencia</p>
                <p className={`text-xs mt-0.5 ${
                  orden.cobroDelivery?.estado === 'pagado' ? 'text-green-600'
                  : orden.cobroDelivery?.estado === 'en_revision_deposito' ? 'text-blue-600'
                  : 'text-gray-400'
                }`}>
                  {orden.cobroDelivery?.estado === 'pagado' ? '✓ Pago confirmado'
                  : orden.cobroDelivery?.estado === 'en_revision_deposito' ? '🔍 En revisión por el gestor'
                  : '⏳ Pendiente — sube el boucher de tu transferencia'}
                </p>
              </div>
              {orden.cobroDelivery?.boucherUrl && (
                <a
                  href={orden.cobroDelivery.boucherUrl}
                  target="_blank"
                  rel="noreferrer"
                  className="text-xs font-semibold text-blue-600 hover:underline"
                >
                  Ver boucher →
                </a>
              )}
            </div>
            {orden.cobroDelivery?.boucherUrl && (
              <a href={orden.cobroDelivery.boucherUrl} target="_blank" rel="noreferrer" className="block">
                {/* eslint-disable-next-line @next/next/no-img-element */}
                <img
                  src={orden.cobroDelivery.boucherUrl}
                  alt="Boucher de transferencia"
                  className="w-full max-h-40 object-contain rounded-xl border border-blue-100 bg-blue-50"
                />
              </a>
            )}
          </div>
        )}

        {/* Producto CCE */}
        {orden.cobroContraEntrega?.aplica && (
          <div className="flex items-center justify-between py-2">
            <div>
              <p className="text-sm font-semibold text-gray-900">Cobro del producto</p>
              {orden.cobrosMotorizado?.producto ? (
                <p className={`text-xs mt-0.5 ${orden.cobrosMotorizado.producto.recibio ? 'text-green-600' : 'text-red-500'}`}>
                  {orden.cobrosMotorizado.producto.recibio
                    ? '✓ El motorizado cobró el producto al cliente'
                    : '✗ El motorizado no cobró el producto'}
                </p>
              ) : (
                <p className="text-xs text-gray-400 mt-0.5">Pendiente de entrega</p>
              )}
            </div>
            <div className="text-right">
              <p className="text-sm font-bold text-purple-700">{fmt(orden.cobroContraEntrega.monto)}</p>
              {orden.cobrosMotorizado?.producto && (
                <span className={`inline-flex text-xs font-semibold px-2 py-0.5 rounded-full ${orden.cobrosMotorizado.producto.recibio ? 'bg-green-50 text-green-700' : 'bg-red-50 text-red-600'}`}>
                  {orden.cobrosMotorizado.producto.recibio ? 'Cobrado' : 'No cobrado'}
                </span>
              )}
            </div>
          </div>
        )}
      </div>

      {/* Motorizado */}
      {orden.asignacion?.motorizadoNombre && (
        <div className="rounded-xl border border-gray-200 bg-white p-4">
          <h2 className="text-xs font-bold text-gray-500 uppercase tracking-wide mb-3">Motorizado asignado</h2>
          <div className="flex items-center gap-3">
            <div className="w-10 h-10 rounded-full bg-[#004aad]/10 grid place-items-center flex-shrink-0 overflow-hidden border border-gray-200">
              {orden.asignacion.motorizadoFotoUrl ? (
                // eslint-disable-next-line @next/next/no-img-element
                <img
                  src={orden.asignacion.motorizadoFotoUrl}
                  alt={orden.asignacion.motorizadoNombre}
                  className="w-full h-full object-cover"
                />
              ) : (
                <span className="text-sm font-black text-[#004aad]">
                  {(orden.asignacion.motorizadoNombre || '?')[0].toUpperCase()}
                </span>
              )}
            </div>
            <div>
              <p className="text-sm font-semibold text-gray-900">{orden.asignacion.motorizadoNombre}</p>
              <p className="text-xs text-gray-400 mt-0.5">{estadoLabel[orden.estado || ''] || orden.estado}</p>
            </div>
          </div>
        </div>
      )}

      {/* Evidencias fotográficas */}
      {orden.estado === 'entregado' && (orden.evidencias?.retiro || orden.evidencias?.entrega) && (
        <div className="rounded-xl border border-green-200 bg-green-50 p-4">
          <h2 className="text-xs font-bold text-green-700 uppercase tracking-wide mb-3">📸 Fotos de tu entrega</h2>
          <div className="flex gap-3">
            {orden.evidencias?.retiro && (
              <button
                onClick={() => window.open(orden.evidencias!.retiro!.url, '_blank')}
                className="flex flex-col items-center gap-1 flex-1"
              >
                {/* eslint-disable-next-line @next/next/no-img-element */}
                <img
                  src={orden.evidencias.retiro.url}
                  alt="Foto de retiro"
                  className="w-full aspect-square object-cover rounded-xl border border-green-200"
                  loading="lazy"
                />
                <span className="text-xs text-green-700 font-medium">📦 Retiro</span>
              </button>
            )}
            {orden.evidencias?.entrega && (
              <button
                onClick={() => window.open(orden.evidencias!.entrega!.url, '_blank')}
                className="flex flex-col items-center gap-1 flex-1"
              >
                {/* eslint-disable-next-line @next/next/no-img-element */}
                <img
                  src={orden.evidencias.entrega.url}
                  alt="Foto de entrega"
                  className="w-full aspect-square object-cover rounded-xl border border-green-200"
                  loading="lazy"
                />
                <span className="text-xs text-green-700 font-medium">✅ Entrega</span>
              </button>
            )}
          </div>
        </div>
      )}

      {/* Evidencias entrega bus/terminal */}
      {orden.tipoServicio === 'fuera_managua' && orden.fueraManagua?.metodoEnvio === 'bus_terminal' && orden.evidenciasTerminal?.fotoPaquete && (
        <div className="rounded-xl border border-violet-200 bg-violet-50 p-4 space-y-3">
          <h2 className="text-xs font-bold text-violet-700 uppercase tracking-wide">📸 Fotos de entrega al bus</h2>
          <div className="flex gap-3">
            {orden.evidenciasTerminal.fotoPaquete && (
              <button onClick={() => window.open(orden.evidenciasTerminal!.fotoPaquete!.url, '_blank')} className="flex flex-col items-center gap-1 flex-1">
                {/* eslint-disable-next-line @next/next/no-img-element */}
                <img src={orden.evidenciasTerminal.fotoPaquete.url} alt="Paquete" className="w-full aspect-square object-cover rounded-xl border border-violet-200" loading="lazy" />
                <span className="text-xs text-violet-700 font-medium">📦 Paquete</span>
              </button>
            )}
            {orden.evidenciasTerminal.fotoTicket && (
              <button onClick={() => window.open(orden.evidenciasTerminal!.fotoTicket!.url, '_blank')} className="flex flex-col items-center gap-1 flex-1">
                {/* eslint-disable-next-line @next/next/no-img-element */}
                <img src={orden.evidenciasTerminal.fotoTicket.url} alt="Ticket" className="w-full aspect-square object-cover rounded-xl border border-violet-200" loading="lazy" />
                <span className="text-xs text-violet-700 font-medium">🎫 Ticket</span>
              </button>
            )}
            {orden.evidenciasTerminal.fotoBus && (
              <button onClick={() => window.open(orden.evidenciasTerminal!.fotoBus!.url, '_blank')} className="flex flex-col items-center gap-1 flex-1">
                {/* eslint-disable-next-line @next/next/no-img-element */}
                <img src={orden.evidenciasTerminal.fotoBus.url} alt="Bus" className="w-full aspect-square object-cover rounded-xl border border-violet-200" loading="lazy" />
                <span className="text-xs text-violet-700 font-medium">🚌 Bus</span>
              </button>
            )}
          </div>
          {orden.evidenciasTerminal.sinTicket && (
            <div className="rounded-lg bg-amber-50 border border-amber-200 p-3 space-y-1.5">
              <p className="text-xs font-bold text-amber-700">Sin ticket — datos del transporte</p>
              {orden.evidenciasTerminal.busNombre && <p className="text-sm text-gray-800"><span className="text-xs text-gray-500">Bus/empresa: </span>{orden.evidenciasTerminal.busNombre}</p>}
              {orden.evidenciasTerminal.busNumero && <p className="text-sm text-gray-800"><span className="text-xs text-gray-500">Número/placa: </span>{orden.evidenciasTerminal.busNumero}</p>}
              {orden.evidenciasTerminal.busCelular && <p className="text-sm text-gray-800"><span className="text-xs text-gray-500">Celular cobrador: </span>{orden.evidenciasTerminal.busCelular}</p>}
              {orden.evidenciasTerminal.horaLlegadaDestino && <p className="text-sm text-gray-800"><span className="text-xs text-gray-500">Llega a destino: </span>{orden.evidenciasTerminal.horaLlegadaDestino}</p>}
              {orden.evidenciasTerminal.costoFlete != null && <p className="text-sm text-gray-800"><span className="text-xs text-gray-500">Costo flete: </span>C$ {orden.evidenciasTerminal.costoFlete}</p>}
            </div>
          )}
        </div>
      )}

      {/* Evidencias entrega Cargotrans */}
      {orden.tipoServicio === 'fuera_managua' && orden.fueraManagua?.metodoEnvio === 'cargotrans' && orden.evidenciasCargotrans && (
        <div className="rounded-xl border border-violet-200 bg-violet-50 p-4 space-y-3">
          <h2 className="text-xs font-bold text-violet-700 uppercase tracking-wide">📸 Fotos de entrega en Cargotrans</h2>
          {(orden.evidenciasCargotrans.fotos ?? []).length > 0 && (
            <div>
              <p className="text-xs text-gray-500 mb-2">Paquetes ({orden.evidenciasCargotrans.fotos!.length})</p>
              <div className="flex gap-2 flex-wrap">
                {orden.evidenciasCargotrans.fotos!.map((f, i) => (
                  <button key={i} onClick={() => window.open(f.url, '_blank')} className="flex flex-col items-center gap-1 w-24">
                    {/* eslint-disable-next-line @next/next/no-img-element */}
                    <img src={f.url} alt={`Paquete ${i + 1}`} className="w-full aspect-square object-cover rounded-xl border border-violet-200" loading="lazy" />
                    <span className="text-xs text-violet-700 font-medium">📦 #{i + 1}</span>
                  </button>
                ))}
              </div>
            </div>
          )}
          {orden.evidenciasCargotrans.factura && (
            <button onClick={() => window.open(orden.evidenciasCargotrans!.factura!.url, '_blank')} className="inline-flex items-center gap-1.5 text-sm text-indigo-700 font-semibold underline">
              🧾 Ver factura
            </button>
          )}
          {orden.evidenciasCargotrans.costoCargotrans != null && (
            <div className="flex items-center gap-2 text-sm">
              <span className="text-gray-500">Costo pagado en Cargotrans:</span>
              <span className="font-bold text-violet-700">C$ {orden.evidenciasCargotrans.costoCargotrans}</span>
            </div>
          )}
        </div>
      )}

      {/* Timeline */}
      {timeline.length > 0 && (
        <div className="rounded-xl border border-gray-200 bg-white p-4">
          <h2 className="text-xs font-bold text-gray-500 uppercase tracking-wide mb-3">Historial</h2>
          <ol className="space-y-3">
            {timeline.map((t, i) => (
              <li key={t.key} className="flex items-start gap-3">
                <div className="flex flex-col items-center">
                  <div className={`w-3 h-3 rounded-full flex-shrink-0 mt-0.5 ${i === timeline.length - 1 ? 'bg-[#004aad]' : 'bg-gray-300'}`} />
                  {i < timeline.length - 1 && <div className="w-px flex-1 bg-gray-200 mt-1 min-h-[16px]" />}
                </div>
                <div>
                  <p className="text-sm font-semibold text-gray-900">{t.label}</p>
                  <p className="text-xs text-gray-400">{fmtDatetime(t.ts)}</p>
                </div>
              </li>
            ))}
          </ol>
        </div>
      )}
    </div>
  )
}
