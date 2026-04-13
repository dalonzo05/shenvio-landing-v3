'use client'

import { useEffect, useMemo, useState } from 'react'
import Link from 'next/link'
import {
  ClipboardList,
  Bike,
  Users,
  BarChart3,
  Clock3,
  ArrowRight,
  Bell,
  ShieldCheck,
  Phone,
  MapPin,
  CircleDot,
  Search,
  ChevronRight,
  Eye,
  Send,
  AlertCircle,
} from 'lucide-react'
import { collection, onSnapshot, query, where, limit, Timestamp } from 'firebase/firestore'
import { db } from '@/fb/config'
import { SolicitudDrawer } from './_components/SolicitudDrawer'

type OrdenActiva = {
  id: string
  estado?: string
  createdAt?: Timestamp
  updatedAt?: Timestamp
  ownerSnapshot?: { companyName?: string; nombre?: string }
  userId?: string
  asignacion?: { motorizadoNombre?: string; motorizadoId?: string } | null
  cobroDelivery?: { estado?: string; registradoAt?: Timestamp }
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
}

type FiltroEstado = 'todos' | 'disponible' | 'ocupado' | 'inactivo'

function estadoColor(estado?: string, activo?: boolean) {
  if (!activo) return 'bg-red-50 text-red-700 border-red-200'

  switch ((estado || '').toLowerCase()) {
    case 'disponible':
      return 'bg-green-50 text-green-700 border-green-200'
    case 'ocupado':
      return 'bg-yellow-50 text-yellow-700 border-yellow-200'
    case 'inactivo':
      return 'bg-red-50 text-red-700 border-red-200'
    default:
      return 'bg-gray-50 text-gray-700 border-gray-200'
  }
}

function estadoTexto(estado?: string, activo?: boolean) {
  if (!activo) return 'Inactivo'
  if (!estado) return 'Sin estado'
  return estado.charAt(0).toUpperCase() + estado.slice(1)
}

function formatUbicacion(ubicacion: any) {
  if (!ubicacion) return 'Ubicación no registrada'
  if (typeof ubicacion === 'string') return ubicacion

  if (typeof ubicacion === 'object') {
    if (typeof ubicacion.direccion === 'string') return ubicacion.direccion
    if (typeof ubicacion.texto === 'string') return ubicacion.texto
    return 'Ubicación no registrada'
  }

  return 'Ubicación no registrada'
}

function normalizarEstado(m: Motorizado): 'disponible' | 'ocupado' | 'inactivo' | 'sin_estado' {
  if (!m.activo) return 'inactivo'
  const estado = (m.estado || '').toLowerCase()
  if (estado === 'disponible') return 'disponible'
  if (estado === 'ocupado') return 'ocupado'
  return 'sin_estado'
}

function ordenarMotorizados(arr: Motorizado[]) {
  const prioridad: Record<string, number> = {
    disponible: 0,
    ocupado: 1,
    inactivo: 2,
    sin_estado: 3,
  }

  return [...arr].sort((a, b) => {
    const ea = normalizarEstado(a)
    const eb = normalizarEstado(b)

    if (prioridad[ea] !== prioridad[eb]) {
      return prioridad[ea] - prioridad[eb]
    }

    return (a.nombre || '').localeCompare(b.nombre || '')
  })
}

export default function PanelGestorPage() {
  const [motorizados, setMotorizados] = useState<Motorizado[]>([])
  const [loadingMotos, setLoadingMotos] = useState(true)
  const [busqueda, setBusqueda] = useState('')
  const [filtroEstado, setFiltroEstado] = useState<FiltroEstado>('todos')
  const [cobrosAlerta, setCobrosAlerta] = useState<CobroAlerta[]>([])
  const [ordenesHoy, setOrdenesHoy] = useState<OrdenActiva[]>([])
  const [ordenesActivas, setOrdenesActivas] = useState<OrdenActiva[]>([])
  const [selectedOrdenId, setSelectedOrdenId] = useState<string | null>(null)

  // Órdenes de hoy (KPIs del día)
  useEffect(() => {
    const hoyStart = new Date(); hoyStart.setHours(0, 0, 0, 0)
    const q = query(collection(db, 'solicitudes_envio'), where('createdAt', '>=', Timestamp.fromDate(hoyStart)))
    return onSnapshot(q, (snap) => setOrdenesHoy(snap.docs.map((d) => ({ id: d.id, ...(d.data() as any) }))))
  }, [])

  // Órdenes activas en curso (independiente del día)
  useEffect(() => {
    const q = query(collection(db, 'solicitudes_envio'), where('estado', 'in', ['asignada', 'en_camino_retiro', 'retirado', 'en_camino_entrega']))
    return onSnapshot(q, (snap) => setOrdenesActivas(snap.docs.map((d) => ({ id: d.id, ...(d.data() as any) }))))
  }, [])

  // Cobros pendientes en tiempo real (máx 5 para el widget)
  useEffect(() => {
    const q = query(
      collection(db, 'solicitudes_envio'),
      where('cobroPendiente', '==', true),
      limit(5)
    )
    const unsub = onSnapshot(q, (snap) => {
      // Igual que en Cobros: excluir incidencias fantasma donde el motorizado ya cobró todo
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
    const ref = collection(db, 'motorizado')
    const q = query(ref)

    const unsub = onSnapshot(
      q,
      (snap) => {
        const rows: Motorizado[] = snap.docs.map((d) => ({
          id: d.id,
          ...(d.data() as any),
        }))
        setMotorizados(rows)
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
    const total = motorizados.length
    const activos = motorizados.filter((m) => m.activo === true).length
    const disponibles = motorizados.filter(
      (m) => m.activo === true && (m.estado || '').toLowerCase() === 'disponible'
    ).length
    const ocupados = motorizados.filter(
      (m) => m.activo === true && (m.estado || '').toLowerCase() === 'ocupado'
    ).length
    const inactivos = motorizados.filter((m) => m.activo !== true).length

    return { total, activos, disponibles, ocupados, inactivos }
  }, [motorizados])

  const motorizadosFiltrados = useMemo(() => {
    const texto = busqueda.trim().toLowerCase()

    let rows = ordenarMotorizados(motorizados)

    if (filtroEstado !== 'todos') {
      rows = rows.filter((m) => normalizarEstado(m) === filtroEstado)
    }

    if (texto) {
      rows = rows.filter((m) => {
        const nombre = (m.nombre || '').toLowerCase()
        const telefono = (m.telefono || '').toLowerCase()
        const ubicacion = formatUbicacion(m.ubicacion).toLowerCase()

        return (
          nombre.includes(texto) ||
          telefono.includes(texto) ||
          ubicacion.includes(texto)
        )
      })
    }

    return rows
  }, [motorizados, busqueda, filtroEstado])

  // KPIs del día
  const kpisHoy = useMemo(() => {
    const now = Date.now()
    const creadas = ordenesHoy.length
    const entregadas = ordenesHoy.filter((o) => o.estado === 'entregado').length
    const enCurso = ordenesActivas.length
    const sinAsignar = ordenesHoy.filter((o) => o.estado === 'confirmada' && !o.asignacion?.motorizadoId).length
    const rechazadas = ordenesHoy.filter((o) => o.estado === 'rechazada').length
    return { creadas, entregadas, enCurso, sinAsignar, rechazadas }
  }, [ordenesHoy, ordenesActivas])

  // Alertas operacionales
  const alertas = useMemo(() => {
    const now = Date.now()
    const TREINTA_MIN = 30 * 60 * 1000
    const DOS_HORAS = 2 * 60 * 60 * 1000

    const sinAsignarMucho = ordenesHoy.filter((o) => {
      if (o.estado !== 'confirmada' || o.asignacion?.motorizadoId) return false
      const ts = typeof o.createdAt?.toDate === 'function' ? o.createdAt.toDate().getTime() : 0
      return ts > 0 && (now - ts) > TREINTA_MIN
    })

    const atascadas = ordenesActivas.filter((o) => {
      const ts = typeof o.updatedAt?.toDate === 'function' ? o.updatedAt.toDate().getTime() : 0
      return ts > 0 && (now - ts) > DOS_HORAS
    })

    return { sinAsignarMucho, atascadas }
  }, [ordenesHoy, ordenesActivas])

  function tiempoRelativo(ts?: Timestamp): string {
    if (!ts || typeof ts.toDate !== 'function') return ''
    const diff = Math.floor((Date.now() - ts.toDate().getTime()) / 60000)
    if (diff < 60) return `hace ${diff} min`
    return `hace ${Math.floor(diff / 60)}h ${diff % 60}min`
  }

  const accesos = [
    {
      titulo: 'Solicitudes',
      descripcion: 'Revisa, confirma y asigna pedidos nuevos a motorizados.',
      href: '/panel/gestor/solicitudes',
      icon: ClipboardList,
      estado: 'Módulo activo',
    },
    {
      titulo: 'Ingresar orden',
      descripcion: 'Crear pedidos manuales para comercios que escriben por WhatsApp.',
      href: '/panel/gestor/ingresar-orden',
      icon: Send,
      estado: 'Módulo activo',
    },  
    {
      titulo: 'Motorizados',
      descripcion: 'Base operativa de motorizados, disponibilidad y seguimiento.',
      href: '#motorizados',
      icon: Bike,
      estado: 'Módulo activo',
    },
    {
      titulo: 'Clientes',
      descripcion: 'Próximamente: seguimiento de clientes y solicitudes frecuentes.',
      href: '#',
      icon: Users,
      estado: 'Próximamente',
      disabled: true,
    },
    {
      titulo: 'Reportes',
      descripcion: 'Próximamente: métricas de tiempos, entregas y operación diaria.',
      href: '#',
      icon: BarChart3,
      estado: 'Próximamente',
      disabled: true,
    },
  ]

  const prioridades = [
    {
      titulo: 'Confirmar solicitudes nuevas',
      detalle:
        'Revisa rápidamente las órdenes recién creadas y valida datos clave antes de asignarlas.',
    },
    {
      titulo: 'Asignar al motorizado correcto',
      detalle:
        'Prioriza disponibilidad, zona, tiempo de respuesta y tipo de entrega para evitar rebotes.',
    },
    {
      titulo: 'Monitorear tiempos de aceptación',
      detalle:
        'Verifica qué órdenes fueron asignadas y aún siguen pendientes por aceptar para actuar a tiempo.',
    },
    {
      titulo: 'Dar seguimiento a incidencias',
      detalle:
        'Mantén control sobre rechazos, atrasos y entregas sensibles para no afectar la experiencia del cliente.',
    },
  ]

  const buenasPracticas = [
    'Confirmar bien retiro, entrega y teléfonos antes de asignar.',
    'Evitar asignar órdenes vencidas o incompletas sin revisión.',
    'Reasignar rápido si el motorizado no acepta dentro del tiempo esperado.',
    'Mantener comunicación clara con el cliente y con el motorizado.',
  ]

  return (
    <div className="max-w-7xl mx-auto px-4 py-6 md:py-8 space-y-6">

      {/* ── KPIs del día ── */}
      <div className="grid grid-cols-5 gap-3">
        {[
          { label: 'Creadas hoy', value: kpisHoy.creadas, color: 'text-gray-900', bg: 'bg-white border-gray-200' },
          { label: 'Entregadas hoy', value: kpisHoy.entregadas, color: 'text-green-700', bg: 'bg-green-50 border-green-200' },
          { label: 'En curso', value: kpisHoy.enCurso, color: 'text-blue-700', bg: 'bg-blue-50 border-blue-200' },
          { label: 'Sin asignar', value: kpisHoy.sinAsignar, color: kpisHoy.sinAsignar > 0 ? 'text-orange-600' : 'text-gray-500', bg: kpisHoy.sinAsignar > 0 ? 'bg-orange-50 border-orange-200' : 'bg-white border-gray-200' },
          { label: 'Rechazadas hoy', value: kpisHoy.rechazadas, color: kpisHoy.rechazadas > 0 ? 'text-red-600' : 'text-gray-500', bg: kpisHoy.rechazadas > 0 ? 'bg-red-50 border-red-200' : 'bg-white border-gray-200' },
        ].map((k) => (
          <div key={k.label} className={`${k.bg} border rounded-xl px-4 py-3`}>
            <p className={`text-2xl font-black ${k.color}`}>{k.value}</p>
            <p className="text-xs font-semibold text-gray-500 mt-0.5">{k.label}</p>
          </div>
        ))}
      </div>

      {/* ── Alertas operacionales ── */}
      {(alertas.sinAsignarMucho.length > 0 || alertas.atascadas.length > 0) && (
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
                    {alertas.sinAsignarMucho.slice(0, 2).map((o) => `${o.id.slice(0,8)} (${tiempoRelativo(o.createdAt)})`).join(' · ')}
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
                    {alertas.atascadas.slice(0, 2).map((o) => `${o.id.slice(0,8)} (${tiempoRelativo(o.updatedAt)})`).join(' · ')}
                    {alertas.atascadas.length > 2 && ` +${alertas.atascadas.length - 2} más`}
                  </p>
                </div>
                <Link href="/panel/gestor/solicitudes" className="text-xs font-semibold text-orange-600 hover:underline whitespace-nowrap">
                  Revisar →
                </Link>
              </div>
            )}
          </div>
        </section>
      )}

      {/* ── Órdenes activas en tiempo real ── */}
      {ordenesActivas.length > 0 && (
        <section className="rounded-2xl border border-gray-200 bg-white shadow-sm overflow-hidden">
          <div className="px-5 py-3 border-b border-gray-100 flex items-center justify-between">
            <h2 className="text-sm font-black text-gray-900 flex items-center gap-2">
              <span className="w-2 h-2 rounded-full bg-blue-500 animate-pulse" />
              Órdenes en curso ({ordenesActivas.length})
            </h2>
            <Link href="/panel/gestor/solicitudes" className="text-xs font-semibold text-[#004aad] hover:underline">
              Ver todas →
            </Link>
          </div>
          <div className="overflow-x-auto">
            <table className="w-full text-xs">
              <thead>
                <tr className="bg-gray-50 border-b border-gray-100 text-[10px] font-semibold uppercase tracking-wide text-gray-500">
                  <th className="px-4 py-2 text-left">Orden</th>
                  <th className="px-4 py-2 text-left">Comercio</th>
                  <th className="px-4 py-2 text-left">Motorizado</th>
                  <th className="px-4 py-2 text-left">Estado</th>
                  <th className="px-4 py-2 text-left">Tiempo</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-gray-50">
                {ordenesActivas.slice(0, 8).map((o) => {
                  const estadoLabel: Record<string, { label: string; cls: string }> = {
                    asignada: { label: 'Asignada', cls: 'bg-indigo-50 text-indigo-700 border-indigo-200' },
                    en_camino_retiro: { label: '→ Retiro', cls: 'bg-blue-50 text-blue-700 border-blue-200' },
                    retirado: { label: 'Retirado', cls: 'bg-cyan-50 text-cyan-700 border-cyan-200' },
                    en_camino_entrega: { label: '→ Entrega', cls: 'bg-purple-50 text-purple-700 border-purple-200' },
                  }
                  const cfg = estadoLabel[o.estado || ''] || { label: o.estado || '—', cls: 'bg-gray-50 text-gray-600 border-gray-200' }
                  const comercio = o.ownerSnapshot?.companyName || o.ownerSnapshot?.nombre || '—'
                  return (
                    <tr key={o.id} className="hover:bg-gray-50 transition-colors">
                      <td className="px-4 py-2.5">
                        <button onClick={() => setSelectedOrdenId(o.id)} className="font-mono text-blue-600 hover:underline">
                          {o.id.slice(0, 8)}
                        </button>
                      </td>
                      <td className="px-4 py-2.5 font-medium text-gray-800">{comercio}</td>
                      <td className="px-4 py-2.5 text-gray-600">{o.asignacion?.motorizadoNombre || '—'}</td>
                      <td className="px-4 py-2.5">
                        <span className={`inline-flex text-[10px] font-semibold px-2 py-0.5 rounded-full border ${cfg.cls}`}>
                          {cfg.label}
                        </span>
                      </td>
                      <td className="px-4 py-2.5 text-gray-400">{tiempoRelativo(o.updatedAt || o.createdAt)}</td>
                    </tr>
                  )
                })}
              </tbody>
            </table>
          </div>
        </section>
      )}

      {/* ── Widget: cobros pendientes ── */}
      {cobrosAlerta.length > 0 && (
        <section className="rounded-2xl border border-orange-200 bg-orange-50 p-4 shadow-sm">
          <div className="flex items-center justify-between mb-3">
            <div className="flex items-center gap-2">
              <AlertCircle className="h-5 w-5 text-orange-500" />
              <h2 className="text-sm font-black text-orange-800">
                {cobrosAlerta.length} cobro{cobrosAlerta.length !== 1 ? 's' : ''} sin confirmar
              </h2>
            </div>
            <Link href="/panel/gestor/cobros" className="text-xs font-semibold text-orange-600 hover:underline flex items-center gap-1">
              Ver todos <ArrowRight className="h-3 w-3" />
            </Link>
          </div>
          <ul className="space-y-2">
            {cobrosAlerta.map((c) => {
              const comercio = c.ownerSnapshot?.companyName || c.ownerSnapshot?.nombre || '—'
              const motorizado = c.asignacion?.motorizadoNombre || '—'
              const partes: string[] = []
              if (c.cobrosMotorizado?.delivery && !c.cobrosMotorizado.delivery.recibio) partes.push(`Delivery C$ ${c.cobrosMotorizado.delivery.monto}`)
              if (c.cobrosMotorizado?.producto && !c.cobrosMotorizado.producto.recibio) partes.push(`Producto C$ ${c.cobrosMotorizado.producto.monto}`)
              return (
                <li key={c.id} className="flex items-center justify-between bg-white rounded-xl px-3 py-2 border border-orange-100">
                  <div>
                    <p className="text-sm font-semibold text-gray-900">{comercio}</p>
                    <p className="text-xs text-gray-500">Motorizado: {motorizado} · {partes.join(' + ')}</p>
                  </div>
                  <Link href="/panel/gestor/cobros" className="text-xs font-semibold text-orange-600 hover:underline">
                    Resolver →
                  </Link>
                </li>
              )
            })}
          </ul>
        </section>
      )}

      <section className="rounded-2xl border border-gray-200 bg-white p-5 md:p-7 shadow-sm">
        <div className="flex flex-col gap-5 lg:flex-row lg:items-start lg:justify-between">
          <div className="max-w-3xl">
            <div className="inline-flex items-center gap-2 rounded-full border border-blue-200 bg-blue-50 px-3 py-1 text-sm text-blue-700">
              <ShieldCheck className="h-4 w-4" />
              Panel de gestión operativa
            </div>

            <h1 className="mt-4 text-3xl md:text-4xl font-bold tracking-tight text-gray-900">
              Panel Gestor
            </h1>

            <p className="mt-3 text-gray-600 leading-7">
              Este espacio está pensado para la persona encargada de revisar, organizar y asignar
              pedidos. La prioridad aquí es mantener la operación clara, rápida y ordenada para que
              cada solicitud llegue al motorizado correcto en el menor tiempo posible.
            </p>
          </div>

          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3 w-full lg:w-auto lg:min-w-[320px]">
            <div className="rounded-2xl border border-gray-200 bg-gray-50 p-4">
              <div className="flex items-center gap-2 text-sm font-medium text-gray-700">
                <Clock3 className="h-4 w-4" />
                Prioridad operativa
              </div>
              <p className="mt-2 text-sm text-gray-600">
                Entrar a solicitudes, confirmar y asignar sin demoras.
              </p>
            </div>

            <div className="rounded-2xl border border-gray-200 bg-gray-50 p-4">
              <div className="flex items-center gap-2 text-sm font-medium text-gray-700">
                <Bell className="h-4 w-4" />
                Enfoque del rol
              </div>
              <p className="mt-2 text-sm text-gray-600">
                Controlar pedidos, tiempos, rechazos e incidencias.
              </p>
            </div>
          </div>
        </div>
      </section>

      <section className="grid grid-cols-2 lg:grid-cols-5 gap-4">
        <div className="rounded-2xl border border-gray-200 bg-white p-4 shadow-sm">
          <p className="text-sm text-gray-500">Motorizados totales</p>
          <p className="mt-2 text-2xl font-bold text-gray-900">{resumenMotorizados.total}</p>
        </div>

        <div className="rounded-2xl border border-gray-200 bg-white p-4 shadow-sm">
          <p className="text-sm text-gray-500">Activos</p>
          <p className="mt-2 text-2xl font-bold text-gray-900">{resumenMotorizados.activos}</p>
        </div>

        <div className="rounded-2xl border border-gray-200 bg-white p-4 shadow-sm">
          <p className="text-sm text-gray-500">Disponibles</p>
          <p className="mt-2 text-2xl font-bold text-green-700">
            {resumenMotorizados.disponibles}
          </p>
        </div>

        <div className="rounded-2xl border border-gray-200 bg-white p-4 shadow-sm">
          <p className="text-sm text-gray-500">Ocupados</p>
          <p className="mt-2 text-2xl font-bold text-yellow-700">
            {resumenMotorizados.ocupados}
          </p>
        </div>

        <div className="rounded-2xl border border-gray-200 bg-white p-4 shadow-sm">
          <p className="text-sm text-gray-500">Inactivos</p>
          <p className="mt-2 text-2xl font-bold text-red-700">
            {resumenMotorizados.inactivos}
          </p>
        </div>
      </section>

      <section className="grid grid-cols-1 xl:grid-cols-3 gap-6">
        <div className="xl:col-span-2 rounded-2xl border border-gray-200 bg-white p-5 md:p-6 shadow-sm">
          <div className="flex items-center justify-between gap-3">
            <div>
              <h2 className="text-xl font-semibold text-gray-900">Accesos del gestor</h2>
              <p className="mt-1 text-sm text-gray-600">
                Módulos clave para operar y futuras secciones del panel.
              </p>
            </div>
          </div>

          <div className="mt-5 grid grid-cols-1 md:grid-cols-2 gap-4">
            {accesos.map((item) => {
              const Icon = item.icon

              if (item.disabled) {
                return (
                  <div
                    key={item.titulo}
                    className="rounded-2xl border border-gray-200 bg-gray-50 p-5 opacity-80"
                  >
                    <div className="flex items-start justify-between gap-3">
                      <div className="flex h-11 w-11 items-center justify-center rounded-xl bg-white border border-gray-200">
                        <Icon className="h-5 w-5 text-gray-700" />
                      </div>
                      <span className="rounded-full border border-gray-200 bg-white px-2.5 py-1 text-xs text-gray-600">
                        {item.estado}
                      </span>
                    </div>

                    <h3 className="mt-4 text-lg font-semibold text-gray-900">{item.titulo}</h3>
                    <p className="mt-2 text-sm leading-6 text-gray-600">{item.descripcion}</p>

                    <div className="mt-4 text-sm font-medium text-gray-400">Disponible luego</div>
                  </div>
                )
              }

              return (
                <Link
                  key={item.titulo}
                  href={item.href}
                  className="group rounded-2xl border border-gray-200 bg-white p-5 transition hover:border-blue-300 hover:shadow-md"
                >
                  <div className="flex items-start justify-between gap-3">
                    <div className="flex h-11 w-11 items-center justify-center rounded-xl bg-blue-50 border border-blue-100">
                      <Icon className="h-5 w-5 text-blue-700" />
                    </div>
                    <span className="rounded-full border border-green-200 bg-green-50 px-2.5 py-1 text-xs text-green-700">
                      {item.estado}
                    </span>
                  </div>

                  <h3 className="mt-4 text-lg font-semibold text-gray-900">{item.titulo}</h3>
                  <p className="mt-2 text-sm leading-6 text-gray-600">{item.descripcion}</p>

                  <div className="mt-4 inline-flex items-center gap-2 text-sm font-medium text-blue-700">
                    Abrir módulo
                    <ArrowRight className="h-4 w-4 transition group-hover:translate-x-0.5" />
                  </div>
                </Link>
              )
            })}
          </div>
        </div>

        <div className="rounded-2xl border border-gray-200 bg-white p-5 md:p-6 shadow-sm">
          <h2 className="text-xl font-semibold text-gray-900">Checklist rápido</h2>
          <p className="mt-1 text-sm text-gray-600">
            Lo más importante para mantener fluidez en la asignación.
          </p>

          <div className="mt-5 space-y-4">
            {prioridades.map((item, idx) => (
              <div key={item.titulo} className="flex gap-3">
                <div className="flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-blue-600 text-sm font-semibold text-white">
                  {idx + 1}
                </div>
                <div>
                  <p className="font-medium text-gray-900">{item.titulo}</p>
                  <p className="mt-1 text-sm leading-6 text-gray-600">{item.detalle}</p>
                </div>
              </div>
            ))}
          </div>

          <Link
            href="/panel/gestor/solicitudes"
            className="mt-6 inline-flex w-full items-center justify-center rounded-xl bg-[#004aad] px-4 py-3 font-medium text-white transition hover:bg-[#003c96]"
          >
            Ir a solicitudes
          </Link>
        </div>
      </section>

      <section
        id="motorizados"
        className="rounded-2xl border border-gray-200 bg-white p-5 md:p-6 shadow-sm"
      >
        <div className="flex flex-col xl:flex-row xl:items-end xl:justify-between gap-4">
          <div>
            <h2 className="text-xl font-semibold text-gray-900">Módulo de motorizados</h2>
            <p className="mt-1 text-sm text-gray-600">
              Vista administrativa del equipo operativo para apoyar la asignación y el control diario.
            </p>
          </div>

          <div className="flex flex-col sm:flex-row gap-3 w-full xl:w-auto">
            <div className="relative w-full sm:w-80">
              <Search className="h-4 w-4 text-gray-400 absolute left-3 top-1/2 -translate-y-1/2" />
              <input
                value={busqueda}
                onChange={(e) => setBusqueda(e.target.value)}
                placeholder="Buscar por nombre, teléfono o zona"
                className="w-full rounded-xl border border-gray-200 bg-white py-2.5 pl-9 pr-3 text-sm outline-none focus:border-blue-300"
              />
            </div>

            <select
              value={filtroEstado}
              onChange={(e) => setFiltroEstado(e.target.value as FiltroEstado)}
              className="rounded-xl border border-gray-200 bg-white px-3 py-2.5 text-sm outline-none focus:border-blue-300"
            >
              <option value="todos">Todos</option>
              <option value="disponible">Disponibles</option>
              <option value="ocupado">Ocupados</option>
              <option value="inactivo">Inactivos</option>
            </select>
          </div>
        </div>

        <div className="mt-4 flex flex-wrap gap-2 text-xs">
          <span className="inline-flex items-center rounded-full border border-green-200 bg-green-50 px-2.5 py-1 text-green-700">
            Disponible = listo para asignación
          </span>
          <span className="inline-flex items-center rounded-full border border-yellow-200 bg-yellow-50 px-2.5 py-1 text-yellow-700">
            Ocupado = con orden en proceso
          </span>
          <span className="inline-flex items-center rounded-full border border-red-200 bg-red-50 px-2.5 py-1 text-red-700">
            Inactivo = fuera de operación
          </span>
        </div>

        {loadingMotos ? (
          <div className="mt-5 rounded-2xl border border-gray-200 bg-white overflow-hidden">
            <div className="animate-pulse p-4 space-y-3">
              {Array.from({ length: 5 }).map((_, i) => (
                <div key={i} className="h-12 rounded-lg bg-gray-100" />
              ))}
            </div>
          </div>
        ) : motorizadosFiltrados.length === 0 ? (
          <div className="mt-5 rounded-2xl border border-dashed border-gray-300 bg-gray-50 p-6 text-sm text-gray-600">
            No encontramos motorizados con ese filtro.
          </div>
        ) : (
          <>
            <div className="mt-5 hidden lg:block overflow-hidden rounded-2xl border border-gray-200 bg-white">
              <div className="overflow-x-auto">
                <table className="min-w-full text-sm">
                  <thead className="bg-gray-50 border-b border-gray-200">
                    <tr className="text-left text-gray-600">
                      <th className="px-4 py-3 font-medium">Motorizado</th>
                      <th className="px-4 py-3 font-medium">Teléfono</th>
                      <th className="px-4 py-3 font-medium">Zona / ubicación base</th>
                      <th className="px-4 py-3 font-medium">Estado</th>
                      <th className="px-4 py-3 font-medium">Licencia</th>
                      <th className="px-4 py-3 font-medium">Activo</th>
                      <th className="px-4 py-3 font-medium">Acción</th>
                    </tr>
                  </thead>

                  <tbody className="divide-y divide-gray-100">
                    {motorizadosFiltrados.map((m) => (
                      <tr key={m.id} className="hover:bg-gray-50/70">
                        <td className="px-4 py-3 align-top">
                          <div className="font-medium text-gray-900">{m.nombre || 'Sin nombre'}</div>
                          <div className="text-xs text-gray-500 mt-0.5">
                            ID interno: {m.id.slice(0, 8)}
                          </div>
                        </td>

                        <td className="px-4 py-3 align-top text-gray-700">
                          {m.telefono || '-'}
                        </td>

                        <td className="px-4 py-3 align-top text-gray-700 max-w-[250px]">
                          <div className="break-words">{formatUbicacion(m.ubicacion)}</div>
                        </td>

                        <td className="px-4 py-3 align-top">
                          <span
                            className={`inline-flex rounded-full border px-2.5 py-1 text-xs font-medium ${estadoColor(
                              m.estado,
                              m.activo
                            )}`}
                          >
                            {estadoTexto(m.estado, m.activo)}
                          </span>
                        </td>

                        <td className="px-4 py-3 align-top text-gray-700">
                          {m.licencia || '-'}
                        </td>

                        <td className="px-4 py-3 align-top text-gray-700">
                          {m.activo ? 'Sí' : 'No'}
                        </td>

                        <td className="px-4 py-3 align-top">
                          <Link
                            href="/panel/gestor/solicitudes"
                            className="inline-flex items-center gap-2 rounded-lg border border-gray-200 px-3 py-2 text-sm font-medium text-gray-700 hover:bg-gray-50"
                          >
                            <Eye className="h-4 w-4" />
                            Ver solicitudes
                          </Link>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>

            <div className="mt-5 grid grid-cols-1 gap-4 lg:hidden">
              {motorizadosFiltrados.map((m) => (
                <div
                  key={m.id}
                  className="rounded-2xl border border-gray-200 bg-white p-4 shadow-sm"
                >
                  <div className="flex items-start justify-between gap-3">
                    <div className="min-w-0">
                      <h3 className="text-lg font-semibold text-gray-900 truncate">
                        {m.nombre || 'Sin nombre'}
                      </h3>
                      <p className="mt-1 text-sm text-gray-500">ID interno: {m.id.slice(0, 8)}</p>
                    </div>

                    <span
                      className={`shrink-0 rounded-full border px-2.5 py-1 text-xs font-medium ${estadoColor(
                        m.estado,
                        m.activo
                      )}`}
                    >
                      {estadoTexto(m.estado, m.activo)}
                    </span>
                  </div>

                  <div className="mt-4 space-y-2 text-sm text-gray-700">
                    <div className="flex items-center gap-2">
                      <Phone className="h-4 w-4 text-gray-400 shrink-0" />
                      <span>{m.telefono || '-'}</span>
                    </div>

                    <div className="flex items-start gap-2">
                      <MapPin className="h-4 w-4 text-gray-400 mt-0.5 shrink-0" />
                      <span className="break-words">{formatUbicacion(m.ubicacion)}</span>
                    </div>

                    <div className="flex items-center gap-2">
                      <CircleDot className="h-4 w-4 text-gray-400 shrink-0" />
                      <span>Licencia: {m.licencia || '-'}</span>
                    </div>

                    <div className="flex items-center gap-2">
                      <ShieldCheck className="h-4 w-4 text-gray-400 shrink-0" />
                      <span>{m.activo ? 'Activo en sistema' : 'Inactivo en sistema'}</span>
                    </div>
                  </div>

                  <div className="mt-5 flex flex-wrap gap-2">
                    <Link
                      href="/panel/gestor/solicitudes"
                      className="inline-flex items-center gap-2 rounded-lg border border-gray-200 px-3 py-2 text-sm font-medium text-gray-700 hover:bg-gray-50"
                    >
                      <Eye className="h-4 w-4" />
                      Ver solicitudes
                    </Link>
                  </div>
                </div>
              ))}
            </div>
          </>
        )}
      </section>

      <section className="grid grid-cols-1 lg:grid-cols-2 gap-6">
        <div className="rounded-2xl border border-gray-200 bg-white p-5 md:p-6 shadow-sm">
          <h2 className="text-xl font-semibold text-gray-900">Buenas prácticas del gestor</h2>
          <p className="mt-1 text-sm text-gray-600">
            Recomendaciones para una operación más ordenada y confiable.
          </p>

          <div className="mt-5 space-y-3">
            {buenasPracticas.map((item) => (
              <div
                key={item}
                className="rounded-xl border border-gray-200 bg-gray-50 px-4 py-3 text-sm text-gray-700"
              >
                {item}
              </div>
            ))}
          </div>
        </div>

        <div className="rounded-2xl border border-gray-200 bg-white p-5 md:p-6 shadow-sm">
          <h2 className="text-xl font-semibold text-gray-900">Qué se añadirá después</h2>
          <p className="mt-1 text-sm text-gray-600">
            Estructura prevista para ir profesionalizando el panel.
          </p>

          <div className="mt-5 grid grid-cols-1 sm:grid-cols-2 gap-3">
            <div className="rounded-xl border border-gray-200 bg-gray-50 p-4">
              <p className="font-medium text-gray-900">Resumen operativo</p>
              <p className="mt-1 text-sm text-gray-600">
                Pedidos nuevos, asignados, entregados e incidencias del día.
              </p>
            </div>

            <div className="rounded-xl border border-gray-200 bg-gray-50 p-4">
              <p className="font-medium text-gray-900">Control de motorizados</p>
              <p className="mt-1 text-sm text-gray-600">
                Disponibilidad, rendimiento, rechazos y tiempos de aceptación.
              </p>
            </div>

            <div className="rounded-xl border border-gray-200 bg-gray-50 p-4">
              <p className="font-medium text-gray-900">Pagos y cortes</p>
              <p className="mt-1 text-sm text-gray-600">
                Liquidaciones, ingresos por viaje y cierres por período.
              </p>
            </div>

            <div className="rounded-xl border border-gray-200 bg-gray-50 p-4">
              <p className="font-medium text-gray-900">Métricas</p>
              <p className="mt-1 text-sm text-gray-600">
                Tiempo promedio de asignación, entrega y cumplimiento.
              </p>
            </div>
          </div>
        </div>
      </section>

      {/* Drawer de detalle */}
      {selectedOrdenId && (
        <SolicitudDrawer
          solicitudId={selectedOrdenId}
          onClose={() => setSelectedOrdenId(null)}
        />
      )}
    </div>
  )
}