'use client'

import { useEffect, useMemo, useState } from 'react'
import Link from 'next/link'
import {
  ClipboardList,
  Bike,
  Send,
  ArrowRight,
  Phone,
  MapPin,
  CircleDot,
  Search,
  Eye,
  AlertCircle,
  Zap,
  DollarSign,
  Layers,
} from 'lucide-react'
import { collection, onSnapshot, query, where, limit, Timestamp } from 'firebase/firestore'
import { db } from '@/fb/config'
import { SolicitudDrawer } from './_components/SolicitudDrawer'
import { IrAFicha } from './_components/IrAFicha'
import { useModuleGuard } from '../_hooks/useModuleGuard'

type OrdenActiva = {
  id: string
  estado?: string
  createdAt?: Timestamp
  updatedAt?: Timestamp
  ownerSnapshot?: { companyName?: string; nombre?: string }
  userId?: string
  asignacion?: { motorizadoNombre?: string; motorizadoId?: string } | null
  cobroDelivery?: { estado?: string; registradoAt?: Timestamp }
  macroZonaRetiroNombre?: string | null
  macroZonaEntregaNombre?: string | null
}

type CobroAlerta = {
  id: string
  ownerSnapshot?: { companyName?: string; nombre?: string }
  asignacion?: { motorizadoNombre?: string } | null
  cobrosMotorizado?: {
    delivery?: { monto: number; recibio: boolean; justificacion?: string }
    producto?: { monto: number; recibio: boolean; justificacion?: string }
  }
  createdAt?: Timestamp
}

type Motorizado = {
  id: string
  authUid?: string
  nombre?: string
  telefono?: string
  activo?: boolean
  estado?: string
  licencia?: string
  ubicacion?: any
  zonaBase?: string
  macroZonaBase?: string
  zonaOperativa?: string
}

type FiltroEstado = 'todos' | 'disponible' | 'ocupado' | 'inactivo'

function estadoColor(estado?: string, activo?: boolean) {
  if (!activo) return 'bg-red-50 text-red-700 border-red-200'
  switch ((estado || '').toLowerCase()) {
    case 'disponible': return 'bg-green-50 text-green-700 border-green-200'
    case 'ocupado': return 'bg-yellow-50 text-yellow-700 border-yellow-200'
    case 'inactivo': return 'bg-red-50 text-red-700 border-red-200'
    default: return 'bg-gray-50 text-gray-700 border-gray-200'
  }
}

function estadoTexto(estado?: string, activo?: boolean) {
  if (!activo) return 'Inactivo'
  if (!estado) return 'Sin estado'
  return estado.charAt(0).toUpperCase() + estado.slice(1)
}

function formatUbicacion(ubicacion: any): string | null {
  if (!ubicacion) return null
  if (typeof ubicacion === 'string') return ubicacion
  if (typeof ubicacion === 'object') {
    if (typeof ubicacion.direccion === 'string') return ubicacion.direccion
    if (typeof ubicacion.texto === 'string') return ubicacion.texto
  }
  return null
}

function normalizarEstado(m: Motorizado): 'disponible' | 'ocupado' | 'inactivo' | 'sin_estado' {
  if (!m.activo) return 'inactivo'
  const estado = (m.estado || '').toLowerCase()
  if (estado === 'disponible') return 'disponible'
  if (estado === 'ocupado') return 'ocupado'
  return 'sin_estado'
}

function ordenarMotorizados(arr: Motorizado[]) {
  const prioridad: Record<string, number> = { disponible: 0, ocupado: 1, inactivo: 2, sin_estado: 3 }
  return [...arr].sort((a, b) => {
    const ea = normalizarEstado(a)
    const eb = normalizarEstado(b)
    if (prioridad[ea] !== prioridad[eb]) return prioridad[ea] - prioridad[eb]
    return (a.nombre || '').localeCompare(b.nombre || '')
  })
}

// RBAC INTERNO V1: wrapper de guard de módulo. El contenido real
// (PanelGestorPageContent) no se monta —ni sus listeners de Firestore se
// suscriben— hasta que useModuleGuard resuelve 'autorizado'. Mismo patrón
// en las 17 páginas de gestor/**, ver lib/permissions.ts.
export default function PanelGestorPage() {
  const estadoGuardModulo = useModuleGuard('dashboard')
  if (estadoGuardModulo !== 'autorizado') {
    return (
      <div className="w-full px-6 py-6 text-sm text-gray-600">
        {estadoGuardModulo === 'redirigiendo' ? 'Redirigiendo a tu panel...' : 'Validando permisos...'}
      </div>
    )
  }
  return <PanelGestorPageContent />
}

function PanelGestorPageContent() {
  const [motorizados, setMotorizados] = useState<Motorizado[]>([])
  const [loadingMotos, setLoadingMotos] = useState(true)
  const [busqueda, setBusqueda] = useState('')
  const [filtroEstado, setFiltroEstado] = useState<FiltroEstado>('todos')
  const [cobrosAlerta, setCobrosAlerta] = useState<CobroAlerta[]>([])
  const [ordenesHoy, setOrdenesHoy] = useState<OrdenActiva[]>([])
  const [ordenesActivas, setOrdenesActivas] = useState<OrdenActiva[]>([])
  const [ordenesPendientes, setOrdenesPendientes] = useState<OrdenActiva[]>([])
  const [selectedOrdenId, setSelectedOrdenId] = useState<string | null>(null)

  useEffect(() => {
    const hoyStart = new Date(); hoyStart.setHours(0, 0, 0, 0)
    const q = query(collection(db, 'solicitudes_envio'), where('createdAt', '>=', Timestamp.fromDate(hoyStart)))
    return onSnapshot(q, (snap) => setOrdenesHoy(snap.docs.map((d) => ({ id: d.id, ...(d.data() as any) }))))
  }, [])

  useEffect(() => {
    const q = query(collection(db, 'solicitudes_envio'), where('estado', 'in', ['asignada', 'en_camino_retiro', 'retirado', 'en_camino_entrega']))
    return onSnapshot(q, (snap) => setOrdenesActivas(snap.docs.map((d) => ({ id: d.id, ...(d.data() as any) }))))
  }, [])

  useEffect(() => {
    const q = query(collection(db, 'solicitudes_envio'), where('estado', 'in', ['pendiente', 'nueva']))
    return onSnapshot(q, (snap) => setOrdenesPendientes(snap.docs.map((d) => ({ id: d.id, ...(d.data() as any) }))))
  }, [])

  useEffect(() => {
    const q = query(collection(db, 'solicitudes_envio'), where('cobroPendiente', '==', true), limit(5))
    const unsub = onSnapshot(q, (snap) => {
      const reales = snap.docs
        .map((d) => ({ id: d.id, ...(d.data() as any) }))
        .filter((s: any) => {
          const d = s.cobrosMotorizado?.delivery
          const p = s.cobrosMotorizado?.producto
          const hayNoRecibido = (d != null && d.recibio === false) || (p != null && p.recibio === false)
          const hayCobroRegistrado = d != null || p != null
          return !hayCobroRegistrado || hayNoRecibido
        })
      setCobrosAlerta(reales)
    })
    return () => unsub()
  }, [])

  useEffect(() => {
    const unsub = onSnapshot(
      query(collection(db, 'motorizado')),
      (snap) => {
        setMotorizados(snap.docs.map((d) => ({ id: d.id, ...(d.data() as any) })))
        setLoadingMotos(false)
      },
      (err) => {
        console.error('Error cargando motorizados:', err)
        setLoadingMotos(false)
      }
    )
    return () => unsub()
  }, [])

  const resumenMotorizados = useMemo(() => {
    const disponibles = motorizados.filter(m => m.activo === true && (m.estado || '').toLowerCase() === 'disponible').length
    const ocupados = motorizados.filter(m => m.activo === true && (m.estado || '').toLowerCase() === 'ocupado').length
    const inactivos = motorizados.filter(m => m.activo !== true).length
    return { total: motorizados.length, disponibles, ocupados, inactivos }
  }, [motorizados])

  const motorizadosFiltrados = useMemo(() => {
    const texto = busqueda.trim().toLowerCase()
    let rows = ordenarMotorizados(motorizados)
    if (filtroEstado !== 'todos') rows = rows.filter(m => normalizarEstado(m) === filtroEstado)
    if (texto) {
      rows = rows.filter(m => {
        const nombre = (m.nombre || '').toLowerCase()
        const telefono = (m.telefono || '').toLowerCase()
        const zona = (m.zonaBase || m.zonaOperativa || m.macroZonaBase || '').toLowerCase()
        const ub = (formatUbicacion(m.ubicacion) || '').toLowerCase()
        return nombre.includes(texto) || telefono.includes(texto) || zona.includes(texto) || ub.includes(texto)
      })
    }
    return rows
  }, [motorizados, busqueda, filtroEstado])

  const kpisHoy = useMemo(() => ({
    creadas: ordenesHoy.length,
    entregadas: ordenesHoy.filter(o => o.estado === 'entregado').length,
    enCurso: ordenesActivas.length,
    sinAsignar: ordenesHoy.filter(o => o.estado === 'confirmada' && !o.asignacion?.motorizadoId).length,
    rechazadas: ordenesHoy.filter(o => o.estado === 'rechazada').length,
  }), [ordenesHoy, ordenesActivas])

  const resumenMacroZonas = useMemo(() => {
    const retiro = new Map<string, number>()
    const entrega = new Map<string, number>()
    for (const o of ordenesHoy) {
      if (o.macroZonaRetiroNombre) retiro.set(o.macroZonaRetiroNombre, (retiro.get(o.macroZonaRetiroNombre) ?? 0) + 1)
      if (o.macroZonaEntregaNombre) entrega.set(o.macroZonaEntregaNombre, (entrega.get(o.macroZonaEntregaNombre) ?? 0) + 1)
    }
    return {
      topRetiro: [...retiro.entries()].sort((a, b) => b[1] - a[1]).slice(0, 3),
      topEntrega: [...entrega.entries()].sort((a, b) => b[1] - a[1]).slice(0, 3),
      hasData: retiro.size > 0 || entrega.size > 0,
    }
  }, [ordenesHoy])

  const ordenesAccion = useMemo(() => {
    const now = Date.now()
    const DOS_HORAS = 2 * 60 * 60 * 1000

    const pendientesConfirmacion = ordenesPendientes
    const confirmadasSinAsignar = ordenesHoy.filter(o => o.estado === 'confirmada' && !o.asignacion?.motorizadoId)
    const asignadasPendienteAceptacion = ordenesActivas.filter(o => o.estado === 'asignada')
    const enRiesgo = ordenesActivas.filter(o => {
      const ts = typeof o.updatedAt?.toDate === 'function' ? o.updatedAt.toDate().getTime() : 0
      return ts > 0 && (now - ts) > DOS_HORAS
    })

    const seen = new Set<string>()
    const todas: Array<OrdenActiva & { _categoria: 'pendiente' | 'sin_asignar' | 'en_riesgo' | 'asignada' }> = []

    for (const o of pendientesConfirmacion) {
      if (!seen.has(o.id)) { seen.add(o.id); todas.push({ ...o, _categoria: 'pendiente' }) }
    }
    for (const o of confirmadasSinAsignar) {
      if (!seen.has(o.id)) { seen.add(o.id); todas.push({ ...o, _categoria: 'sin_asignar' }) }
    }
    for (const o of enRiesgo) {
      if (!seen.has(o.id)) { seen.add(o.id); todas.push({ ...o, _categoria: 'en_riesgo' }) }
    }
    for (const o of asignadasPendienteAceptacion) {
      if (!seen.has(o.id)) { seen.add(o.id); todas.push({ ...o, _categoria: 'asignada' }) }
    }

    return {
      pendientesConfirmacion: pendientesConfirmacion.length,
      confirmadasSinAsignar: confirmadasSinAsignar.length,
      asignadasPendienteAceptacion: asignadasPendienteAceptacion.length,
      enRiesgo: enRiesgo.length,
      todas,
    }
  }, [ordenesPendientes, ordenesHoy, ordenesActivas])

  const alertas = useMemo(() => {
    const now = Date.now()
    const TREINTA_MIN = 30 * 60 * 1000
    const DOS_HORAS = 2 * 60 * 60 * 1000

    const sinAsignarMucho = ordenesHoy.filter(o => {
      if (o.estado !== 'confirmada' || o.asignacion?.motorizadoId) return false
      const ts = typeof o.createdAt?.toDate === 'function' ? o.createdAt.toDate().getTime() : 0
      return ts > 0 && (now - ts) > TREINTA_MIN
    })

    const atascadas = ordenesActivas.filter(o => {
      const ts = typeof o.updatedAt?.toDate === 'function' ? o.updatedAt.toDate().getTime() : 0
      return ts > 0 && (now - ts) > DOS_HORAS
    })

    return { sinAsignarMucho, atascadas }
  }, [ordenesHoy, ordenesActivas])

  const ordenesPorMotorizado = useMemo(() => {
    const map = new Map<string, number>()
    for (const o of ordenesActivas) {
      const mid = o.asignacion?.motorizadoId
      if (mid) map.set(mid, (map.get(mid) ?? 0) + 1)
    }
    return map
  }, [ordenesActivas])

  function tiempoRelativo(ts?: Timestamp): string {
    if (!ts || typeof ts.toDate !== 'function') return '—'
    const diff = Math.floor((Date.now() - ts.toDate().getTime()) / 60000)
    if (diff < 1) return 'ahora'
    if (diff < 60) return `hace ${diff}m`
    return `hace ${Math.floor(diff / 60)}h ${diff % 60}m`
  }

  const categoriaConfig = {
    pendiente: { label: 'Pend. confirmación', cls: 'bg-yellow-50 text-yellow-700 border-yellow-200', accion: 'Confirmar' },
    sin_asignar: { label: 'Sin asignar', cls: 'bg-orange-50 text-orange-700 border-orange-200', accion: 'Asignar' },
    en_riesgo: { label: 'En riesgo', cls: 'bg-red-50 text-red-700 border-red-200', accion: 'Ver' },
    asignada: { label: 'Pend. aceptación', cls: 'bg-blue-50 text-blue-700 border-blue-200', accion: 'Ver' },
  }

  const accesos = [
    { titulo: 'Solicitudes', href: '/panel/gestor/solicitudes', icon: ClipboardList },
    { titulo: 'Ingresar orden', href: '/panel/gestor/ingresar-orden', icon: Send },
    { titulo: 'Motorizados', href: '#motorizados', icon: Bike },
    { titulo: 'Zonas', href: '/panel/gestor/zonas', icon: Layers },
    { titulo: 'Financiero', href: '/panel/gestor/cobros', icon: DollarSign },
  ]

  return (
    <div className="max-w-7xl mx-auto px-4 py-6 space-y-5">

      {/* KPIs del día */}
      <div className="grid grid-cols-5 gap-3">
        {[
          { label: 'Creadas hoy', value: kpisHoy.creadas, color: 'text-gray-900', bg: 'bg-white border-gray-200' },
          { label: 'Entregadas', value: kpisHoy.entregadas, color: 'text-green-700', bg: 'bg-green-50 border-green-200' },
          { label: 'En curso', value: kpisHoy.enCurso, color: 'text-blue-700', bg: 'bg-blue-50 border-blue-200' },
          { label: 'Sin asignar', value: kpisHoy.sinAsignar, color: kpisHoy.sinAsignar > 0 ? 'text-orange-600' : 'text-gray-500', bg: kpisHoy.sinAsignar > 0 ? 'bg-orange-50 border-orange-200' : 'bg-white border-gray-200' },
          { label: 'Rechazadas', value: kpisHoy.rechazadas, color: kpisHoy.rechazadas > 0 ? 'text-red-600' : 'text-gray-500', bg: kpisHoy.rechazadas > 0 ? 'bg-red-50 border-red-200' : 'bg-white border-gray-200' },
        ].map(k => (
          <div key={k.label} className={`${k.bg} border rounded-xl px-4 py-3`}>
            <p className={`text-2xl font-black ${k.color}`}>{k.value}</p>
            <p className="text-xs font-semibold text-gray-500 mt-0.5">{k.label}</p>
          </div>
        ))}
      </div>

      {/* Alertas operacionales */}
      {(alertas.sinAsignarMucho.length > 0 || alertas.atascadas.length > 0 || cobrosAlerta.length > 0) && (
        <section className="rounded-2xl border border-red-200 bg-red-50 p-4 shadow-sm">
          <div className="flex items-center gap-2 mb-3">
            <AlertCircle className="h-5 w-5 text-red-500" />
            <h2 className="text-sm font-black text-red-800">Alertas operacionales</h2>
          </div>
          <div className="flex flex-col gap-2">
            {alertas.sinAsignarMucho.length > 0 && (
              <div className="bg-white rounded-xl border border-red-100 px-4 py-3 flex items-center justify-between">
                <div>
                  <p className="text-sm font-bold text-gray-900">
                    🔴 {alertas.sinAsignarMucho.length} orden{alertas.sinAsignarMucho.length > 1 ? 'es' : ''} sin asignar +30 min
                  </p>
                  <p className="text-xs text-gray-500 mt-0.5">
                    {alertas.sinAsignarMucho.slice(0, 2).map(o => `${o.id.slice(0, 8)} (${tiempoRelativo(o.createdAt)})`).join(' · ')}
                    {alertas.sinAsignarMucho.length > 2 && ` +${alertas.sinAsignarMucho.length - 2} más`}
                  </p>
                </div>
                <Link href="/panel/gestor/solicitudes" className="text-xs font-semibold text-red-600 hover:underline whitespace-nowrap">
                  Asignar →
                </Link>
              </div>
            )}
            {alertas.atascadas.length > 0 && (
              <div className="bg-white rounded-xl border border-orange-100 px-4 py-3 flex items-center justify-between">
                <div>
                  <p className="text-sm font-bold text-gray-900">
                    🟠 {alertas.atascadas.length} orden{alertas.atascadas.length > 1 ? 'es' : ''} en curso +2 horas
                  </p>
                  <p className="text-xs text-gray-500 mt-0.5">
                    {alertas.atascadas.slice(0, 2).map(o => `${o.id.slice(0, 8)} (${tiempoRelativo(o.updatedAt)})`).join(' · ')}
                    {alertas.atascadas.length > 2 && ` +${alertas.atascadas.length - 2} más`}
                  </p>
                </div>
                <Link href="/panel/gestor/solicitudes" className="text-xs font-semibold text-orange-600 hover:underline whitespace-nowrap">
                  Revisar →
                </Link>
              </div>
            )}
            {cobrosAlerta.length > 0 && (
              <div className="bg-white rounded-xl border border-yellow-100 px-4 py-3 flex items-center justify-between">
                <div>
                  <p className="text-sm font-bold text-gray-900">
                    🟡 {cobrosAlerta.length} cobro{cobrosAlerta.length > 1 ? 's' : ''} sin confirmar
                  </p>
                  <p className="text-xs text-gray-500 mt-0.5">
                    {cobrosAlerta.slice(0, 2).map(c => c.ownerSnapshot?.companyName || c.ownerSnapshot?.nombre || c.id.slice(0, 8)).join(' · ')}
                    {cobrosAlerta.length > 2 && ` +${cobrosAlerta.length - 2} más`}
                  </p>
                </div>
                <Link href="/panel/gestor/cobros" className="text-xs font-semibold text-yellow-700 hover:underline whitespace-nowrap">
                  Resolver →
                </Link>
              </div>
            )}
          </div>
        </section>
      )}

      {/* Órdenes que requieren acción */}
      <section className="rounded-2xl border border-gray-200 bg-white shadow-sm overflow-hidden">
        <div className="px-5 py-3 border-b border-gray-100 flex items-center justify-between">
          <div className="flex items-center gap-2">
            <Zap className="h-4 w-4 text-amber-500" />
            <h2 className="text-sm font-black text-gray-900">Órdenes que requieren acción</h2>
          </div>
          <Link href="/panel/gestor/solicitudes" className="text-xs font-semibold text-[#004aad] hover:underline">
            Ver todas →
          </Link>
        </div>

        <div className="grid grid-cols-4 divide-x divide-gray-100 border-b border-gray-100">
          {[
            { label: 'Pend. confirmación', count: ordenesAccion.pendientesConfirmacion, color: ordenesAccion.pendientesConfirmacion > 0 ? 'text-yellow-700' : 'text-gray-400' },
            { label: 'Sin asignar', count: ordenesAccion.confirmadasSinAsignar, color: ordenesAccion.confirmadasSinAsignar > 0 ? 'text-orange-600' : 'text-gray-400' },
            { label: 'Pend. aceptación', count: ordenesAccion.asignadasPendienteAceptacion, color: ordenesAccion.asignadasPendienteAceptacion > 0 ? 'text-blue-700' : 'text-gray-400' },
            { label: 'En riesgo', count: ordenesAccion.enRiesgo, color: ordenesAccion.enRiesgo > 0 ? 'text-red-600' : 'text-gray-400' },
          ].map(c => (
            <div key={c.label} className="px-4 py-3 text-center">
              <p className={`text-xl font-black ${c.color}`}>{c.count}</p>
              <p className="text-[10px] font-semibold text-gray-500 mt-0.5">{c.label}</p>
            </div>
          ))}
        </div>

        {ordenesAccion.todas.length === 0 ? (
          <div className="px-5 py-8 text-center text-sm text-gray-400">
            Sin órdenes pendientes de acción.
          </div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-xs">
              <thead>
                <tr className="bg-gray-50 border-b border-gray-100 text-[10px] font-semibold uppercase tracking-wide text-gray-500">
                  <th className="px-4 py-2 text-left">Orden</th>
                  <th className="px-4 py-2 text-left">Comercio</th>
                  <th className="px-4 py-2 text-left">Estado</th>
                  <th className="px-4 py-2 text-left">Tiempo</th>
                  <th className="px-4 py-2 text-left">Acción</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-gray-50">
                {ordenesAccion.todas.slice(0, 12).map(o => {
                  const cfg = categoriaConfig[o._categoria]
                  const comercio = o.ownerSnapshot?.companyName || o.ownerSnapshot?.nombre || '—'
                  const ts = o._categoria === 'sin_asignar' ? o.createdAt : (o.updatedAt || o.createdAt)
                  return (
                    <tr key={o.id} className="hover:bg-gray-50 transition-colors">
                      <td className="px-4 py-2.5">
                        {/* B2.5 — el botón sigue abriendo el drawer; la flecha
                            lleva a la ficha autoritativa. */}
                        <span className="inline-flex items-center">
                          <button onClick={() => setSelectedOrdenId(o.id)} title={`Vista rápida · ${o.id}`}
                            className="font-mono text-blue-600 hover:underline">
                            {o.id.slice(0, 8)}
                          </button>
                          <IrAFicha id={o.id} className="ml-0.5" />
                        </span>
                      </td>
                      <td className="px-4 py-2.5 font-medium text-gray-800">{comercio}</td>
                      <td className="px-4 py-2.5">
                        <span className={`inline-flex text-[10px] font-semibold px-2 py-0.5 rounded-full border ${cfg.cls}`}>
                          {cfg.label}
                        </span>
                      </td>
                      <td className="px-4 py-2.5 text-gray-400">{tiempoRelativo(ts)}</td>
                      <td className="px-4 py-2.5">
                        {cfg.accion === 'Ver' ? (
                          <button onClick={() => setSelectedOrdenId(o.id)} className="text-xs font-semibold text-gray-700 hover:text-blue-600">
                            Ver →
                          </button>
                        ) : (
                          <Link href="/panel/gestor/solicitudes" className="text-xs font-semibold text-[#004aad] hover:underline">
                            {cfg.accion} →
                          </Link>
                        )}
                      </td>
                    </tr>
                  )
                })}
              </tbody>
            </table>
          </div>
        )}
      </section>

      {/* Distribución por macrozona */}
      <section className="rounded-2xl border border-gray-200 bg-white shadow-sm overflow-hidden">
        <div className="px-5 py-3 border-b border-gray-100 flex items-center gap-2">
          <MapPin className="h-4 w-4 text-violet-500" />
          <h2 className="text-sm font-black text-gray-900">Distribución por macrozona — hoy</h2>
        </div>
        {!resumenMacroZonas.hasData ? (
          <div className="px-5 py-8 text-center text-sm text-gray-400">
            Sin datos de macrozona en las órdenes de hoy.
          </div>
        ) : (
          <div className="grid grid-cols-2 divide-x divide-gray-100">
            <div className="px-5 py-4">
              <p className="text-[10px] font-semibold uppercase tracking-wide text-gray-400 mb-3">Retiro</p>
              {resumenMacroZonas.topRetiro.length === 0 ? (
                <p className="text-xs text-gray-400">Sin datos</p>
              ) : (
                <div className="space-y-2.5">
                  {resumenMacroZonas.topRetiro.map(([nombre, count], i) => {
                    const pct = resumenMacroZonas.topRetiro[0][1] > 0 ? Math.round((count / resumenMacroZonas.topRetiro[0][1]) * 100) : 0
                    return (
                      <div key={nombre}>
                        <div className="flex items-center justify-between mb-0.5">
                          <span className="text-xs font-medium text-gray-800 flex items-center gap-1.5">
                            <span className="text-[10px] font-bold text-violet-500">{i + 1}</span>
                            {nombre}
                          </span>
                          <span className="text-xs font-bold text-gray-700">{count}</span>
                        </div>
                        <div className="h-1.5 bg-gray-100 rounded-full overflow-hidden">
                          <div className="h-full bg-violet-400 rounded-full" style={{ width: `${pct}%` }} />
                        </div>
                      </div>
                    )
                  })}
                </div>
              )}
            </div>
            <div className="px-5 py-4">
              <p className="text-[10px] font-semibold uppercase tracking-wide text-gray-400 mb-3">Entrega</p>
              {resumenMacroZonas.topEntrega.length === 0 ? (
                <p className="text-xs text-gray-400">Sin datos</p>
              ) : (
                <div className="space-y-2.5">
                  {resumenMacroZonas.topEntrega.map(([nombre, count], i) => {
                    const pct = resumenMacroZonas.topEntrega[0][1] > 0 ? Math.round((count / resumenMacroZonas.topEntrega[0][1]) * 100) : 0
                    return (
                      <div key={nombre}>
                        <div className="flex items-center justify-between mb-0.5">
                          <span className="text-xs font-medium text-gray-800 flex items-center gap-1.5">
                            <span className="text-[10px] font-bold text-indigo-500">{i + 1}</span>
                            {nombre}
                          </span>
                          <span className="text-xs font-bold text-gray-700">{count}</span>
                        </div>
                        <div className="h-1.5 bg-gray-100 rounded-full overflow-hidden">
                          <div className="h-full bg-indigo-400 rounded-full" style={{ width: `${pct}%` }} />
                        </div>
                      </div>
                    )
                  })}
                </div>
              )}
            </div>
          </div>
        )}
      </section>

      {/* Módulo de motorizados */}
      <section id="motorizados" className="rounded-2xl border border-gray-200 bg-white shadow-sm overflow-hidden">
        <div className="px-5 py-3 border-b border-gray-100 flex flex-col xl:flex-row xl:items-center xl:justify-between gap-3">
          <div className="flex items-center gap-4 flex-wrap">
            <div className="flex items-center gap-2">
              <Bike className="h-4 w-4 text-gray-500" />
              <h2 className="text-sm font-black text-gray-900">Motorizados operativos</h2>
            </div>
            <div className="flex items-center gap-2 text-xs">
              <span className="bg-green-50 text-green-700 border border-green-200 rounded-full px-2 py-0.5 font-semibold">{resumenMotorizados.disponibles} disponibles</span>
              <span className="bg-yellow-50 text-yellow-700 border border-yellow-200 rounded-full px-2 py-0.5 font-semibold">{resumenMotorizados.ocupados} ocupados</span>
              <span className="bg-red-50 text-red-700 border border-red-200 rounded-full px-2 py-0.5 font-semibold">{resumenMotorizados.inactivos} inactivos</span>
            </div>
          </div>
          <div className="flex flex-col sm:flex-row gap-2">
            <div className="relative">
              <Search className="h-3.5 w-3.5 text-gray-400 absolute left-3 top-1/2 -translate-y-1/2" />
              <input
                value={busqueda}
                onChange={e => setBusqueda(e.target.value)}
                placeholder="Buscar motorizado..."
                className="rounded-xl border border-gray-200 bg-white py-2 pl-8 pr-3 text-xs outline-none focus:border-blue-300 w-52"
              />
            </div>
            <select
              value={filtroEstado}
              onChange={e => setFiltroEstado(e.target.value as FiltroEstado)}
              className="rounded-xl border border-gray-200 bg-white px-3 py-2 text-xs outline-none focus:border-blue-300"
            >
              <option value="todos">Todos</option>
              <option value="disponible">Disponibles</option>
              <option value="ocupado">Ocupados</option>
              <option value="inactivo">Inactivos</option>
            </select>
          </div>
        </div>

        {loadingMotos ? (
          <div className="animate-pulse p-4 space-y-3">
            {Array.from({ length: 5 }).map((_, i) => <div key={i} className="h-10 rounded-lg bg-gray-100" />)}
          </div>
        ) : motorizadosFiltrados.length === 0 ? (
          <div className="px-5 py-8 text-center text-sm text-gray-400">
            No se encontraron motorizados con ese filtro.
          </div>
        ) : (
          <>
            {/* Desktop */}
            <div className="hidden lg:block overflow-x-auto">
              <table className="min-w-full text-xs">
                <thead className="bg-gray-50 border-b border-gray-100">
                  <tr className="text-[10px] font-semibold uppercase tracking-wide text-gray-500 text-left">
                    <th className="px-4 py-2.5">Motorizado</th>
                    <th className="px-4 py-2.5">Teléfono</th>
                    <th className="px-4 py-2.5">Zona base</th>
                    <th className="px-4 py-2.5">Estado</th>
                    <th className="px-4 py-2.5">Órdenes activas</th>
                    <th className="px-4 py-2.5">Acción</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-gray-50">
                  {motorizadosFiltrados.map(m => {
                    const zonaLabel = m.zonaBaseNombre || m.macroZonaBaseNombre || m.zonaBase || m.zonaOperativa || m.macroZonaBase || 'Sin zona registrada'
                    const ordenesCount = ordenesPorMotorizado.get(m.authUid ?? '') ?? ordenesPorMotorizado.get(m.id) ?? 0
                    return (
                      <tr key={m.id} className="hover:bg-gray-50/70 transition-colors">
                        <td className="px-4 py-3">
                          <div className="font-medium text-gray-900">{m.nombre || 'Sin nombre'}</div>
                          <div className="text-[10px] text-gray-400 font-mono">{m.id.slice(0, 8)}</div>
                        </td>
                        <td className="px-4 py-3 text-gray-700">{m.telefono || '—'}</td>
                        <td className="px-4 py-3 text-gray-600 max-w-[200px] truncate" title={zonaLabel}>{zonaLabel}</td>
                        <td className="px-4 py-3">
                          <span className={`inline-flex rounded-full border px-2.5 py-0.5 text-[10px] font-semibold ${estadoColor(m.estado, m.activo)}`}>
                            {estadoTexto(m.estado, m.activo)}
                          </span>
                        </td>
                        <td className="px-4 py-3">
                          {ordenesCount > 0
                            ? <span className="font-bold text-blue-700">{ordenesCount}</span>
                            : <span className="text-gray-400">—</span>
                          }
                        </td>
                        <td className="px-4 py-3">
                          <Link href="/panel/gestor/solicitudes" className="inline-flex items-center gap-1.5 rounded-lg border border-gray-200 px-2.5 py-1.5 text-xs font-medium text-gray-700 hover:bg-gray-50 transition-colors">
                            <Eye className="h-3 w-3" />
                            Ver solicitudes
                          </Link>
                        </td>
                      </tr>
                    )
                  })}
                </tbody>
              </table>
            </div>

            {/* Mobile */}
            <div className="lg:hidden p-4 grid gap-3">
              {motorizadosFiltrados.map(m => {
                const zonaLabel = m.zonaBase || m.zonaOperativa || m.macroZonaBase || formatUbicacion(m.ubicacion) || 'Sin zona registrada'
                const ordenesCount = ordenesPorMotorizado.get(m.authUid ?? '') ?? ordenesPorMotorizado.get(m.id) ?? 0
                return (
                  <div key={m.id} className="rounded-xl border border-gray-200 bg-white p-4">
                    <div className="flex items-start justify-between gap-3">
                      <div>
                        <p className="font-semibold text-gray-900">{m.nombre || 'Sin nombre'}</p>
                        <p className="text-[10px] text-gray-400 font-mono">{m.id.slice(0, 8)}</p>
                      </div>
                      <span className={`shrink-0 rounded-full border px-2.5 py-0.5 text-xs font-semibold ${estadoColor(m.estado, m.activo)}`}>
                        {estadoTexto(m.estado, m.activo)}
                      </span>
                    </div>
                    <div className="mt-3 space-y-1.5 text-xs text-gray-700">
                      <div className="flex items-center gap-2">
                        <Phone className="h-3.5 w-3.5 text-gray-400" />
                        <span>{m.telefono || '—'}</span>
                      </div>
                      <div className="flex items-center gap-2">
                        <MapPin className="h-3.5 w-3.5 text-gray-400" />
                        <span>{zonaLabel}</span>
                      </div>
                      {ordenesCount > 0 && (
                        <div className="flex items-center gap-2">
                          <CircleDot className="h-3.5 w-3.5 text-blue-400" />
                          <span className="text-blue-700 font-semibold">{ordenesCount} orden{ordenesCount > 1 ? 'es' : ''} activa{ordenesCount > 1 ? 's' : ''}</span>
                        </div>
                      )}
                    </div>
                    <div className="mt-3">
                      <Link href="/panel/gestor/solicitudes" className="inline-flex items-center gap-1.5 rounded-lg border border-gray-200 px-3 py-1.5 text-xs font-medium text-gray-700 hover:bg-gray-50">
                        <Eye className="h-3.5 w-3.5" />
                        Ver solicitudes
                      </Link>
                    </div>
                  </div>
                )
              })}
            </div>
          </>
        )}
      </section>

      {/* Accesos rápidos */}
      <section className="rounded-2xl border border-gray-200 bg-white shadow-sm p-4">
        <p className="text-[10px] font-semibold uppercase tracking-wide text-gray-400 mb-3">Accesos rápidos</p>
        <div className="grid grid-cols-2 sm:grid-cols-5 gap-3">
          {accesos.map(item => {
            const Icon = item.icon
            return (
              <Link
                key={item.titulo}
                href={item.href}
                className="flex flex-col items-center gap-2 rounded-xl border border-gray-200 px-3 py-4 text-center text-xs font-semibold text-gray-700 hover:border-blue-200 hover:bg-blue-50 hover:text-blue-700 transition-colors"
              >
                <Icon className="h-5 w-5" />
                {item.titulo}
              </Link>
            )
          })}
        </div>
      </section>

      {selectedOrdenId && (
        <SolicitudDrawer
          solicitudId={selectedOrdenId}
          onClose={() => setSelectedOrdenId(null)}
        />
      )}
    </div>
  )
}
