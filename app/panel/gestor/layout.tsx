'use client'

import { useEffect, useState } from 'react'
import { useRouter, usePathname } from 'next/navigation'
import Link from 'next/link'
import { auth, db } from '@/fb/config'
import { collection, doc, getDoc, onSnapshot, query, where } from 'firebase/firestore'
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
} from 'lucide-react'

export default function GestorLayout({ children }: { children: React.ReactNode }) {
  const router = useRouter()
  const pathname = usePathname()
  const [loading, setLoading] = useState(true)
  const [collapsed, setCollapsed] = useState(false)
  const [cobrosPendientes, setCobrosPendientes] = useState(0)

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
      setCobrosPendientes(snap.size)
    })
    return () => unsub()
  }, [])

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
          </nav>
        </div>
      </aside>

      <main className="min-w-0 flex-1 overflow-hidden">
        <div className="h-full overflow-auto p-4">{children}</div>
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
