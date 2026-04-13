'use client'

import { useEffect, useState } from 'react'
import { useRouter, usePathname } from 'next/navigation'
import Link from 'next/link'
import { auth, db } from '@/fb/config'
import { collection, doc, getDoc, onSnapshot, query, where, orderBy } from 'firebase/firestore'
import {
  LayoutDashboard,
  ClipboardList,
  Bike,
  BarChart3,
  Database,
  Store,
  ChevronLeft,
  ChevronRight,
  AlertCircle,
  Wallet,
  Receipt,
  TrendingUp,
  Users,
  Star,
  AlertTriangle,
  DollarSign,
} from 'lucide-react'

export default function GestorLayout({ children }: { children: React.ReactNode }) {
  const router = useRouter()
  const pathname = usePathname()
  const [loading, setLoading] = useState(true)
  const [collapsed, setCollapsed] = useState(false)
  const [cobrosPendientes, setCobrosPendientes] = useState(0)
  const [metricas, setMetricas] = useState({ activas: 0, entregadasHoy: 0, conProblema: 0, pendCobro: 0, prioritarias: 0 })

  useEffect(() => {
    const run = async () => {
      const user = auth.currentUser

      if (!user) {
        router.replace('/login')
        return
      }

      try {
        const snap = await getDoc(doc(db, 'usuarios', user.uid))
        const data = snap.exists() ? (snap.data() as any) : null

        const rol = data?.rol ?? null
        const activo = data?.activo === true

        const permitido = activo && (rol === 'admin' || rol === 'gestor')

        if (!permitido) {
          router.replace('/panel')
          return
        }

        setLoading(false)
      } catch (error) {
        console.error('Error validando acceso gestor:', error)
        router.replace('/panel')
      }
    }

    run()
  }, [router])

  // Badge: cobros pendientes en tiempo real
  useEffect(() => {
    const q = query(
      collection(db, 'solicitudes_envio'),
      where('cobroPendiente', '==', true)
    )
    const unsub = onSnapshot(q, (snap) => {
      // Solo contar si realmente hay un cobro no recibido (excluir incidencias fantasma)
      const reales = snap.docs.filter((d) => {
        const data = d.data()
        const delivery = data?.cobrosMotorizado?.delivery
        const producto = data?.cobrosMotorizado?.producto
        const hayNoRecibido = (delivery != null && delivery.recibio === false) || (producto != null && producto.recibio === false)
        const hayCobroRegistrado = delivery != null || producto != null
        return !hayCobroRegistrado || hayNoRecibido
      })
      setCobrosPendientes(reales.length)
    })
    return () => unsub()
  }, [])

  useEffect(() => {
    if (loading) return
    const q = query(collection(db, 'solicitudes_envio'), orderBy('createdAt', 'desc'))
    const unsub = onSnapshot(q, (snap) => {
      const docs = snap.docs.map(d => ({ id: d.id, ...d.data() } as any))
      const hoy = new Date()
      const isToday = (ts: any) => {
        const d = ts?.toDate ? ts.toDate() : ts instanceof Date ? ts : null
        if (!d) return false
        return d.getDate() === hoy.getDate() && d.getMonth() === hoy.getMonth() && d.getFullYear() === hoy.getFullYear()
      }
      const TERMINALES = ['entregado', 'cancelada', 'rechazada']
      const activas = docs.filter((s: any) => !TERMINALES.includes(s.estado)).length
      const entregadasHoy = docs.filter((s: any) => s.estado === 'entregado' && isToday(s.entregadoAt || s.updatedAt)).length
      const conProblema = docs.filter((s: any) => {
        if (s.estado === 'entregado' && s.pagoDelivery?.tipo !== 'credito_semanal' && s.cobrosMotorizado?.delivery?.recibio === false) return true
        if (s.registro?.deposito && !s.registro.deposito.confirmadoStorkhub) return true
        return false
      }).length
      const pendCobro = docs.filter((s: any) => {
        if (s.estado !== 'entregado') return false
        if (s.pagoDelivery?.tipo === 'credito_semanal') return false
        if (s.cobrosMotorizado?.delivery?.recibio === true) return false
        return true
      }).length
      const prioritarias = docs.filter((s: any) => s.prioridad === true).length
      setMetricas({ activas, entregadasHoy, conProblema, pendCobro, prioritarias })
    })
    return () => unsub()
  }, [loading])

  if (loading) {
    return <div className="w-full px-6 py-6 text-sm text-gray-600">Validando permisos...</div>
  }

  return (
    <div className="flex h-screen w-full bg-gray-50">
      <aside
        className={`relative border-r border-gray-200 bg-white transition-all duration-300 ease-in-out ${
          collapsed ? 'w-[84px]' : 'w-[250px]'
        }`}
      >
        <div className="flex h-full flex-col">
          <div
            className={`border-b border-gray-200 px-4 py-4 ${
              collapsed ? 'flex justify-center' : ''
            }`}
          >
            {collapsed ? (
              <div className="text-2xl font-black text-[#004aad]">S</div>
            ) : (
              <>
                <h2 className="text-3xl font-black tracking-tight text-[#004aad]">STORKHUB</h2>
                <p className="mt-1 text-xs text-gray-500">Panel gestor</p>
              </>
            )}
          </div>

          <button
            onClick={() => setCollapsed((v) => !v)}
            className="absolute -right-3 top-5 z-20 flex h-7 w-7 items-center justify-center rounded-full border border-gray-200 bg-white shadow-sm hover:bg-gray-50"
            title={collapsed ? 'Expandir menú' : 'Colapsar menú'}
          >
            {collapsed ? <ChevronRight size={16} /> : <ChevronLeft size={16} />}
          </button>

          <nav className="flex-1 space-y-2 p-3">
            <NavItem
              href="/panel/gestor"
              icon={<LayoutDashboard size={18} />}
              label="Dashboard"
              active={pathname === '/panel/gestor'}
              collapsed={collapsed}
            />

            <NavItem
              href="/panel/gestor/solicitudes"
              icon={<ClipboardList size={18} />}
              label="Solicitudes"
              active={pathname.startsWith('/panel/gestor/solicitudes')}
              collapsed={collapsed}
            />

            <NavItem
              href="/panel/gestor/motorizados"
              icon={<Bike size={18} />}
              label="Motorizados"
              active={pathname.startsWith('/panel/gestor/motorizados')}
              collapsed={collapsed}
            />

            <NavItem
              href="/panel/gestor/comercios"
              icon={<Store size={18} />}
              label="Comercios"
              active={pathname.startsWith('/panel/gestor/comercios')}
              collapsed={collapsed}
            />

            <NavItem
              href="/panel/gestor/clientes"
              icon={<Users size={18} />}
              label="Clientes"
              active={pathname.startsWith('/panel/gestor/clientes')}
              collapsed={collapsed}
            />

            <NavItem
              href="/panel/gestor/base-datos"
              icon={<Database size={18} />}
              label="Base de datos"
              active={pathname.startsWith('/panel/gestor/base-datos')}
              collapsed={collapsed}
            />

            <NavItem
              href="/panel/gestor/reportes"
              icon={<BarChart3 size={18} />}
              label="Reportes"
              active={pathname.startsWith('/panel/gestor/reportes')}
              collapsed={collapsed}
            />

            {/* Cobros — con badge si hay pendientes */}
            <NavItem
              href="/panel/gestor/cobros"
              icon={<AlertCircle size={18} />}
              label="Cobros"
              active={pathname.startsWith('/panel/gestor/cobros')}
              collapsed={collapsed}
              badge={cobrosPendientes > 0 ? cobrosPendientes : undefined}
            />

            <NavItem
              href="/panel/gestor/depositos"
              icon={<Wallet size={18} />}
              label="Depósitos"
              active={pathname.startsWith('/panel/gestor/depositos')}
              collapsed={collapsed}
            />

            <NavItem
              href="/panel/gestor/liquidaciones"
              icon={<Receipt size={18} />}
              label="Liquidaciones"
              active={pathname.startsWith('/panel/gestor/liquidaciones')}
              collapsed={collapsed}
            />

            <NavItem
              href="/panel/gestor/financiero"
              icon={<TrendingUp size={18} />}
              label="Financiero"
              active={pathname.startsWith('/panel/gestor/financiero')}
              collapsed={collapsed}
            />
          </nav>
        </div>
      </aside>

      <main className="min-w-0 flex-1 overflow-hidden flex flex-col">
        <div className="flex-1 overflow-auto flex flex-col p-4 min-h-0">{children}</div>

        {/* ── BARRA INFERIOR GLOBAL ─── */}
        <div className="shrink-0 bg-white border-t border-gray-200 shadow-[0_-1px_4px_rgba(0,0,0,0.06)]">
          <div className="flex items-center gap-2 px-4 py-2 overflow-x-auto">
            {([
              { key: 'todos',           label: 'Activas',        value: metricas.activas,       color: 'blue',   filtro: '' },
              { key: 'entregadas_hoy',  label: 'Entregadas hoy', value: metricas.entregadasHoy, color: 'green',  filtro: 'entregadas_hoy' },
              { key: 'con_riesgo',      label: 'Con riesgo',     value: metricas.conProblema,   color: 'red',    filtro: 'con_riesgo' },
              { key: 'pendiente_cobro', label: 'Pend. cobro',    value: metricas.pendCobro,     color: 'yellow', filtro: 'pendiente_cobro' },
              { key: 'prioritarias',    label: 'Prioritarias',   value: metricas.prioritarias,  color: 'purple', filtro: 'prioritarias' },
            ] as const).map(({ key, label, value, color, filtro }) => {
              const colorMap: Record<string, string> = {
                blue:   'bg-blue-50 text-blue-700 border-blue-200 hover:bg-blue-100',
                green:  value > 0 ? 'bg-green-50 text-green-700 border-green-200 hover:bg-green-100' : 'bg-gray-50 text-gray-400 border-gray-200',
                red:    value > 0 ? 'bg-red-50 text-red-700 border-red-200 hover:bg-red-100' : 'bg-gray-50 text-gray-400 border-gray-200',
                yellow: value > 0 ? 'bg-yellow-50 text-yellow-700 border-yellow-200 hover:bg-yellow-100' : 'bg-gray-50 text-gray-400 border-gray-200',
                purple: value > 0 ? 'bg-purple-50 text-purple-700 border-purple-200 hover:bg-purple-100' : 'bg-gray-50 text-gray-400 border-gray-200',
              }
              const href = filtro ? `/panel/gestor/solicitudes?filtro=${filtro}` : '/panel/gestor/solicitudes'
              return (
                <Link
                  key={key}
                  href={href}
                  className={`inline-flex items-center gap-1.5 rounded-full border px-3 py-1 text-xs font-semibold whitespace-nowrap transition shrink-0 ${colorMap[color]}`}
                >
                  <span className="font-bold">{value}</span>
                  {label}
                </Link>
              )
            })}
          </div>
        </div>
      </main>
    </div>
  )
}

function NavItem({
  href,
  icon,
  label,
  active,
  collapsed,
  badge,
}: {
  href: string
  icon: React.ReactNode
  label: string
  active: boolean
  collapsed: boolean
  badge?: number
}) {
  return (
    <Link
      href={href}
      title={collapsed ? label : undefined}
      className={`relative flex items-center rounded-xl px-3 py-3 text-sm font-medium transition ${
        active
          ? 'bg-[#004aad] text-white shadow-sm'
          : 'text-gray-700 hover:bg-gray-100'
      } ${collapsed ? 'justify-center' : 'gap-3'}`}
    >
      <span className="relative shrink-0">
        {icon}
        {badge !== undefined && collapsed && (
          <span className="absolute -top-1 -right-1 flex h-4 w-4 items-center justify-center rounded-full bg-red-500 text-[9px] font-black text-white">
            {badge > 9 ? '9+' : badge}
          </span>
        )}
      </span>
      {!collapsed && <span className="flex-1">{label}</span>}
      {!collapsed && badge !== undefined && (
        <span className="ml-auto flex h-5 min-w-5 items-center justify-center rounded-full bg-red-500 px-1 text-[10px] font-black text-white">
          {badge > 99 ? '99+' : badge}
        </span>
      )}
    </Link>
  )
}
