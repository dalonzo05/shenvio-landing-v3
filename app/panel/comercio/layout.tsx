'use client'

import { useEffect, useState } from 'react'
import { useRouter, usePathname } from 'next/navigation'
import Link from 'next/link'
import { auth, db } from '@/fb/config'
import { doc, getDoc } from 'firebase/firestore'
import { useUser } from '@/app/Components/UserProvider'
import {
  Home,
  Package,
  Send,
  Calculator,
  Settings,
  ChevronLeft,
  ChevronRight,
  LogOut,
} from 'lucide-react'

export default function ComercioLayout({ children }: { children: React.ReactNode }) {
  const router = useRouter()
  const pathname = usePathname()
  const [loading, setLoading] = useState(true)
  const [collapsed, setCollapsed] = useState(false)
  const { profile, signOut } = useUser()

  useEffect(() => {
    const run = async () => {
      const user = auth.currentUser
      if (!user) { router.replace('/login'); return }
      try {
        const snap = await getDoc(doc(db, 'usuarios', user.uid))
        const data = snap.exists() ? (snap.data() as any) : null
        const activo = data?.activo === true
        const rol = data?.rol ?? null
        if (!activo || rol !== 'Comercio') { router.replace('/panel'); return }
        setLoading(false)
      } catch {
        router.replace('/panel')
      }
    }
    run()
  }, [router])

  if (loading) return <div className="w-full px-6 py-6 text-sm text-gray-600">Cargando...</div>

  return (
    <div className="flex h-screen w-full bg-gray-50">
      <aside className={`relative border-r border-gray-200 bg-white transition-all duration-300 ease-in-out ${collapsed ? 'w-[84px]' : 'w-[250px]'}`}>
        <div className="flex h-full flex-col">
          {/* Header */}
          <div className={`border-b border-gray-200 px-4 py-4 ${collapsed ? 'flex justify-center' : ''}`}>
            {collapsed ? (
              <div className="text-2xl font-black text-[#004aad]">S</div>
            ) : (
              <>
                <h2 className="text-3xl font-black tracking-tight text-[#004aad]">STORKHUB</h2>
                <p className="mt-1 text-xs text-gray-500">Panel comercio</p>
              </>
            )}
          </div>

          {/* Toggle button */}
          <button
            onClick={() => setCollapsed((v) => !v)}
            className="absolute -right-3 top-5 z-20 flex h-7 w-7 items-center justify-center rounded-full border border-gray-200 bg-white shadow-sm hover:bg-gray-50"
            title={collapsed ? 'Expandir menú' : 'Colapsar menú'}
          >
            {collapsed ? <ChevronRight size={16} /> : <ChevronLeft size={16} />}
          </button>

          {/* Nav */}
          <nav className="flex-1 space-y-2 p-3">
            <NavItem href="/panel/comercio" icon={<Home size={18} />} label="Inicio"
              active={pathname === '/panel/comercio'} collapsed={collapsed} />
            <NavItem href="/panel/comercio/mis-ordenes" icon={<Package size={18} />} label="Mis órdenes"
              active={pathname.startsWith('/panel/comercio/mis-ordenes')} collapsed={collapsed} />
            <NavItem href="/panel/comercio/solicitar" icon={<Send size={18} />} label="Solicitar envío"
              active={pathname.startsWith('/panel/comercio/solicitar')} collapsed={collapsed} />
            <NavItem href="/panel/comercio/calculadora" icon={<Calculator size={18} />} label="Calculadora"
              active={pathname.startsWith('/panel/comercio/calculadora')} collapsed={collapsed} />
            <NavItem href="/panel/comercio/ajustes" icon={<Settings size={18} />} label="Ajustes"
              active={pathname.startsWith('/panel/comercio/ajustes')} collapsed={collapsed} />
          </nav>

          {/* Footer: user + signout */}
          <div className="border-t border-gray-200 p-3">
            {!collapsed && profile?.name && (
              <p className="mb-2 truncate px-3 text-xs font-semibold text-gray-500" title={profile.name}>
                {profile.name}
              </p>
            )}
            <button
              onClick={signOut}
              title="Cerrar sesión"
              className={`flex w-full items-center rounded-xl px-3 py-2.5 text-sm font-medium text-red-600 hover:bg-red-50 transition ${collapsed ? 'justify-center' : 'gap-3'}`}
            >
              <LogOut size={17} className="shrink-0" />
              {!collapsed && <span>Cerrar sesión</span>}
            </button>
          </div>
        </div>
      </aside>

      <main className="min-w-0 flex-1 overflow-hidden">
        <div className="h-full overflow-auto p-4">{children}</div>
      </main>
    </div>
  )
}

function NavItem({ href, icon, label, active, collapsed }: {
  href: string; icon: React.ReactNode; label: string; active: boolean; collapsed: boolean
}) {
  return (
    <Link
      href={href}
      title={collapsed ? label : undefined}
      className={`flex items-center rounded-xl px-3 py-3 text-sm font-medium transition ${
        active ? 'bg-[#004aad] text-white shadow-sm' : 'text-gray-700 hover:bg-gray-100'
      } ${collapsed ? 'justify-center' : 'gap-3'}`}
    >
      <span className="shrink-0">{icon}</span>
      {!collapsed && <span>{label}</span>}
    </Link>
  )
}
