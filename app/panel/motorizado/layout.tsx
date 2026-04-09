'use client'

import { useEffect, useState } from 'react'
import { useRouter, usePathname } from 'next/navigation'
import Link from 'next/link'
import { auth, db } from '@/fb/config'
import { doc, getDoc } from 'firebase/firestore'
import { useUser } from '@/app/Components/UserProvider'
import { setPersistence, browserLocalPersistence } from 'firebase/auth'
import {
  Home,
  ChevronLeft,
  ChevronRight,
  LogOut,
  User,
} from 'lucide-react'

export default function MotorizadoLayout({ children }: { children: React.ReactNode }) {
  const router = useRouter()
  const pathname = usePathname()
  const [loading, setLoading] = useState(true)
  const [collapsed, setCollapsed] = useState(false)
  const [menuOpen, setMenuOpen] = useState(false)
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
        if (!activo || rol !== 'motorizado') { router.replace('/panel'); return }
        try {
          await setPersistence(auth, browserLocalPersistence)
          localStorage.setItem('storkhub:remember', 'true')
        } catch {}
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
                <p className="mt-1 text-xs text-gray-500">Panel motorizado</p>
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
            <NavItem
              href="/panel/motorizado"
              icon={<Home size={18} />}
              label="Inicio"
              active={pathname === '/panel/motorizado'}
              collapsed={collapsed}
            />
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

      {/* Topbar compacto — solo móvil */}
      <div className="md:hidden fixed top-0 inset-x-0 z-50 flex items-center justify-between bg-white border-b border-gray-200 px-4 h-12">
        <span className="text-lg font-black tracking-tight text-[#004aad]">STORKHUB</span>
        <button
          onClick={() => setMenuOpen(true)}
          className="flex items-center justify-center rounded-full bg-gray-100 border border-gray-200"
          style={{ width: 36, height: 36, flexShrink: 0 }}
          aria-label="Abrir menú"
        >
          {profile?.name ? (
            <span style={{ fontSize: 15, fontWeight: 700, color: '#374151', lineHeight: 1 }}>
              {profile.name[0].toUpperCase()}
            </span>
          ) : (
            <User size={16} className="text-gray-500" />
          )}
        </button>
      </div>

      {/* Profile bottom sheet — solo móvil */}
      {menuOpen && (
        <div className="md:hidden">
          {/* Backdrop */}
          <div
            onClick={() => setMenuOpen(false)}
            style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.4)', zIndex: 200 }}
          />
          {/* Sheet */}
          <div style={{
            position: 'fixed', bottom: 0, left: 0, right: 0,
            background: '#fff', borderRadius: '24px 24px 0 0',
            padding: '16px 20px 40px', zIndex: 201,
          }}>
            {/* Drag handle */}
            <div style={{ width: 36, height: 4, borderRadius: 9999, background: '#e5e7eb', margin: '0 auto 20px' }} />
            {/* Profile info */}
            {profile?.name && (
              <div style={{ marginBottom: 16 }}>
                <p style={{ fontSize: 16, fontWeight: 700, color: '#111827', margin: 0 }}>{profile.name}</p>
              </div>
            )}
            <div style={{ height: 1, background: '#f3f4f6', marginBottom: 12 }} />
            {/* Cerrar sesión */}
            <button
              onClick={() => { setMenuOpen(false); signOut(); }}
              style={{
                display: 'flex', alignItems: 'center', gap: 12,
                width: '100%', padding: '14px 4px', border: 'none', background: 'transparent',
                cursor: 'pointer', borderRadius: 12, color: '#dc2626',
              }}
            >
              <LogOut size={18} style={{ flexShrink: 0 }} />
              <span style={{ fontSize: 15, fontWeight: 600 }}>Cerrar sesión</span>
            </button>
            {/* Cancelar */}
            <button
              onClick={() => setMenuOpen(false)}
              style={{
                width: '100%', marginTop: 8, padding: '12px 0', border: '1px solid #e5e7eb',
                borderRadius: 12, background: 'transparent', color: '#6b7280',
                fontSize: 14, fontWeight: 500, cursor: 'pointer',
              }}
            >
              Cancelar
            </button>
          </div>
        </div>
      )}

      <main className="min-w-0 flex-1 overflow-hidden">
        <div className="h-full overflow-auto p-4 md:pt-4 pt-16">{children}</div>
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
