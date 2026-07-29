'use client'

import { useEffect, useState } from 'react'
import { useRouter, usePathname } from 'next/navigation'
import Link from 'next/link'
import { auth, db } from '@/fb/config'
import { doc, getDoc, collection, onSnapshot, query, where } from 'firebase/firestore'
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
  Wallet,
  MoreHorizontal,
} from 'lucide-react'

export default function ComercioLayout({ children }: { children: React.ReactNode }) {
  const router = useRouter()
  const pathname = usePathname()
  const [loading, setLoading] = useState(true)
  const [collapsed, setCollapsed] = useState(false)
  const [menuOpen, setMenuOpen] = useState(false)
  const [activeCount, setActiveCount] = useState(0)
  const { profile, signOut } = useUser()

  const ESTADOS_ACTIVOS = ['pendiente_confirmacion', 'confirmada', 'asignada', 'en_camino_retiro', 'retirado', 'en_camino_entrega']

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

  useEffect(() => {
    // Identidad estable (Bloque A): las solicitudes se filtran por
    // comercioId, no por auth.uid — se resuelve vía usuarios/{uid}.comercioId
    // (expuesto en profile por UserProvider).
    if (!profile?.comercioId) return
    const q = query(
      collection(db, 'solicitudes_envio'),
      where('userId', '==', profile.comercioId),
      where('estado', 'in', ESTADOS_ACTIVOS)
    )
    return onSnapshot(q, (snap) => setActiveCount(snap.size))
  }, [profile?.comercioId])

  if (loading) return <div className="w-full px-6 py-6 text-sm text-gray-600">Cargando...</div>

  return (
    <div className="flex h-screen w-full bg-gray-50" style={{ '--sidebar-width': collapsed ? '84px' : '250px' } as React.CSSProperties}>
      {/* Sidebar — solo desktop */}
      <aside className={`hidden md:flex relative border-r border-gray-200 bg-white transition-all duration-300 ease-in-out flex-col ${collapsed ? 'w-[84px]' : 'w-[250px]'}`}>
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
            className="absolute -right-3 top-1/2 -translate-y-1/2 z-20 flex h-7 w-7 items-center justify-center rounded-full border border-gray-200 bg-white shadow-sm hover:bg-gray-50"
            title={collapsed ? 'Expandir menú' : 'Colapsar menú'}
          >
            {collapsed ? <ChevronRight size={16} /> : <ChevronLeft size={16} />}
          </button>

          {/* Nav */}
          <nav className="flex-1 space-y-2 p-3">
            <NavItem href="/panel/comercio" icon={<Home size={18} />} label="Inicio"
              active={pathname === '/panel/comercio'} collapsed={collapsed} />
            <NavItem href="/panel/comercio/mis-ordenes" icon={<Package size={18} />} label="Mis órdenes"
              active={pathname.startsWith('/panel/comercio/mis-ordenes')} collapsed={collapsed}
              badge={activeCount > 0 ? activeCount : undefined} />
            <NavItem href="/panel/comercio/depositos" icon={<Wallet size={18} />} label="Depósitos"
              active={pathname.startsWith('/panel/comercio/depositos')} collapsed={collapsed} />
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

      {/* Top bar — solo móvil */}
      <div className="md:hidden fixed top-0 inset-x-0 z-50 flex items-center justify-between bg-white border-b border-gray-200 px-4 h-12">
        <span className="text-lg font-black tracking-tight text-[#004aad]">STORKHUB</span>
        <span className="text-xs font-medium text-gray-400">Panel comercio</span>
      </div>

      {/* Bottom tab bar — solo móvil */}
      <div className="md:hidden fixed bottom-0 inset-x-0 z-50 bg-white border-t border-gray-200 flex items-stretch h-16">
        <BottomTab href="/panel/comercio" icon={<Home size={20} />} label="Inicio" active={pathname === '/panel/comercio'} />
        <BottomTab href="/panel/comercio/mis-ordenes" icon={<Package size={20} />} label="Órdenes" active={pathname.startsWith('/panel/comercio/mis-ordenes')} badge={activeCount > 0 ? activeCount : undefined} />
        <BottomTab href="/panel/comercio/solicitar" icon={<Send size={20} />} label="Solicitar" active={pathname.startsWith('/panel/comercio/solicitar')} />
        <BottomTab href="/panel/comercio/calculadora" icon={<Calculator size={20} />} label="Calcular" active={pathname.startsWith('/panel/comercio/calculadora')} />
        <button
          onClick={() => setMenuOpen(true)}
          className="flex flex-1 flex-col items-center justify-center gap-1 text-gray-500"
        >
          <MoreHorizontal size={20} />
          <span className="text-[10px] font-semibold">Más</span>
        </button>
      </div>

      {/* Bottom sheet "Más" — solo móvil */}
      {menuOpen && (
        <div className="md:hidden">
          <div
            onClick={() => setMenuOpen(false)}
            style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.4)', zIndex: 200 }}
          />
          <div style={{
            position: 'fixed', bottom: 0, left: 0, right: 0,
            background: '#fff', borderRadius: '24px 24px 0 0',
            padding: '16px 20px 40px', zIndex: 201,
          }}>
            <div style={{ width: 36, height: 4, borderRadius: 9999, background: '#e5e7eb', margin: '0 auto 20px' }} />
            {profile?.name && (
              <p style={{ fontSize: 13, fontWeight: 700, color: '#6b7280', margin: '0 0 16px', padding: '0 4px' }}>{profile.name}</p>
            )}
            <Link
              href="/panel/comercio/depositos"
              onClick={() => setMenuOpen(false)}
              style={{ display: 'flex', alignItems: 'center', gap: 14, padding: '14px 4px', color: '#111827', textDecoration: 'none', fontWeight: 600, fontSize: 15, borderBottom: '1px solid #f3f4f6' }}
            >
              <Wallet size={20} style={{ color: '#6b7280', flexShrink: 0 }} />
              Depósitos
            </Link>
            <Link
              href="/panel/comercio/ajustes"
              onClick={() => setMenuOpen(false)}
              style={{ display: 'flex', alignItems: 'center', gap: 14, padding: '14px 4px', color: '#111827', textDecoration: 'none', fontWeight: 600, fontSize: 15, borderBottom: '1px solid #f3f4f6' }}
            >
              <Settings size={20} style={{ color: '#6b7280', flexShrink: 0 }} />
              Ajustes
            </Link>
            <button
              onClick={() => { setMenuOpen(false); signOut() }}
              style={{ display: 'flex', alignItems: 'center', gap: 14, width: '100%', padding: '14px 4px', border: 'none', background: 'transparent', cursor: 'pointer', color: '#dc2626', fontWeight: 600, fontSize: 15, marginTop: 4 }}
            >
              <LogOut size={20} style={{ flexShrink: 0 }} />
              Cerrar sesión
            </button>
          </div>
        </div>
      )}

      <main className="min-w-0 flex-1 overflow-hidden">
        <div className="h-full overflow-auto p-4 md:pt-4 pt-12 md:pb-4 pb-20">{children}</div>
      </main>
    </div>
  )
}

function NavItem({ href, icon, label, active, collapsed, badge }: {
  href: string; icon: React.ReactNode; label: string; active: boolean; collapsed: boolean; badge?: number
}) {
  return (
    <Link
      href={href}
      title={collapsed ? label : undefined}
      className={`relative flex items-center rounded-xl px-3 py-3 text-sm font-medium transition ${
        active ? 'bg-[#004aad] text-white shadow-sm' : 'text-gray-700 hover:bg-gray-100'
      } ${collapsed ? 'justify-center' : 'gap-3'}`}
    >
      <span className="relative shrink-0">
        {icon}
        {badge != null && collapsed && (
          <span className="absolute -top-1 -right-1 flex h-4 w-4 items-center justify-center">
            <span className="absolute inset-0 rounded-full bg-orange-500 opacity-70" style={{ animation: 'pulse-ring 1.5s ease-out infinite' }} />
            <span className="relative text-[9px] font-black text-white bg-orange-500 rounded-full h-4 w-4 flex items-center justify-center leading-none">{badge > 9 ? '9+' : badge}</span>
          </span>
        )}
      </span>
      {!collapsed && <span className="flex-1">{label}</span>}
      {!collapsed && badge != null && (
        <span className="relative flex h-5 min-w-[20px] items-center justify-center">
          <span className="absolute inset-0 rounded-full bg-orange-500 opacity-60" style={{ animation: 'pulse-ring 1.5s ease-out infinite' }} />
          <span className="relative text-[11px] font-black text-white bg-orange-500 rounded-full px-1.5 py-0.5 leading-none">{badge > 9 ? '9+' : badge}</span>
        </span>
      )}
    </Link>
  )
}

function BottomTab({ href, icon, label, active, badge }: {
  href: string; icon: React.ReactNode; label: string; active: boolean; badge?: number
}) {
  return (
    <Link
      href={href}
      className={`flex flex-1 flex-col items-center justify-center gap-1 transition-colors ${active ? 'text-[#004aad]' : 'text-gray-400'}`}
    >
      <span className="relative">
        {icon}
        {badge != null && (
          <span className="absolute -top-1.5 -right-2 flex h-4 min-w-[16px] items-center justify-center">
            <span className="absolute inset-0 rounded-full bg-orange-500 opacity-70" style={{ animation: 'pulse-ring 1.5s ease-out infinite' }} />
            <span className="relative text-[9px] font-black text-white bg-orange-500 rounded-full px-1 leading-none h-4 flex items-center">{badge > 9 ? '9+' : badge}</span>
          </span>
        )}
      </span>
      <span className={`text-[10px] font-semibold ${active ? 'text-[#004aad]' : 'text-gray-400'}`}>{label}</span>
    </Link>
  )
}
