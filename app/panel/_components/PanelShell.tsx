'use client'

// DIGITADOR UX V1 — shell visual único del panel interno (sidebar + logout +
// contenedor), extraído de gestor/layout.tsx para que /panel/digitador pueda
// usar exactamente el mismo chrome sin duplicarlo. Única fuente de verdad
// para sidebar/logout/navegación/etiqueta de rol — gestor/layout.tsx y
// digitador/page.tsx solo le pasan sus propios datos (rol, perfil, guard de
// cierre de sesión) y, quien lo necesite, extras específicos (bottom bar de
// métricas, toasts) vía las props opcionales `footerExtra`/`overlayExtra`.
//
// RBAC: la navegación sigue derivándose exclusivamente de
// modulosVisiblesParaRol()/MODULOS_PANEL (lib/permissions.ts) — este
// componente no agrega ni una segunda matriz ni un caso especial de acceso,
// solo presenta lo que esa función ya autoriza.
import { useState } from 'react'
import Link from 'next/link'
import { usePathname } from 'next/navigation'
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
  Map,
  Calculator,
  FileText,
  BadgeDollarSign,
  ShieldCheck,
  LogOut,
} from 'lucide-react'
import { MODULOS_PANEL, modulosVisiblesParaRol, type ModuleId } from '@/lib/permissions'
import type { Rol } from '../_hooks/useRoleGuard'

// Íconos por módulo — mismo mapa que ya existía en gestor/layout.tsx, movido
// acá porque ahora es este componente el que renderiza el <nav>.
const ICONOS_MODULO: Partial<Record<ModuleId, React.ReactNode>> = {
  dashboard: <LayoutDashboard size={18} />,
  solicitudes: <ClipboardList size={18} />,
  motorizados: <Bike size={18} />,
  comercios: <Store size={18} />,
  clientes: <Users size={18} />,
  baseDatos: <Database size={18} />,
  reportes: <BarChart3 size={18} />,
  zonas: <Map size={18} />,
  calculadora: <Calculator size={18} />,
  cobros: <AlertCircle size={18} />,
  depositos: <Wallet size={18} />,
  liquidaciones: <Receipt size={18} />,
  gastos: <FileText size={18} />,
  saldos: <BadgeDollarSign size={18} />,
  financiero: <TrendingUp size={18} />,
  auditoria: <ShieldCheck size={18} />,
}

// DIGITADOR UX V1, sección 5: etiqueta según rol. Mínimo pedido — gestor
// conserva "Panel gestor" (comportamiento actual), digitador pasa a "Panel
// de digitación". Admin no tiene entrada propia a propósito: conserva el
// comportamiento actual (cae al mismo "Panel gestor" que ya tenía), no se
// amplía esto a un rediseño de etiqueta para Admin.
const ETIQUETAS_PANEL: Partial<Record<NonNullable<Rol>, string>> = {
  digitador: 'Panel de digitación',
}

function etiquetaPanel(rol: Rol): string {
  return (rol && ETIQUETAS_PANEL[rol]) || 'Panel gestor'
}

export interface BadgeModulo {
  count?: number
  variant?: 'default' | 'nueva' | 'seen'
}

export function PanelShell({
  rolPropio,
  profile,
  onCerrarSesion,
  cerrandoSesion,
  badges,
  footerExtra,
  overlayExtra,
  children,
}: {
  rolPropio: Rol
  profile?: { name?: string } | null
  onCerrarSesion: () => void
  cerrandoSesion: boolean
  /** Badges opcionales por módulo (hoy: solicitudes/cobros en gestor). Sin
   *  entrada para un módulo = sin badge, comportamiento por defecto. */
  badges?: Partial<Record<ModuleId, BadgeModulo>>
  /** Se renderiza dentro de <main>, debajo del área con scroll — hoy lo usa
   *  gestor/layout.tsx para su barra inferior de métricas. */
  footerExtra?: React.ReactNode
  /** Se renderiza como hermano de todo el shell — hoy lo usa gestor/layout.tsx
   *  para los toasts de nuevas órdenes. */
  overlayExtra?: React.ReactNode
  children: React.ReactNode
}) {
  const pathname = usePathname()
  const [collapsed, setCollapsed] = useState(false)
  const esDigitador = rolPropio === 'digitador'

  return (
    <div className="flex h-screen w-full bg-gray-50" style={{ '--sidebar-width': collapsed ? '84px' : '250px' } as React.CSSProperties}>
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
                <p className="mt-1 text-xs text-gray-500">{etiquetaPanel(rolPropio)}</p>
              </>
            )}
          </div>

          <button
            onClick={() => setCollapsed((v) => !v)}
            className="absolute -right-3 top-1/2 -translate-y-1/2 z-20 flex h-7 w-7 items-center justify-center rounded-full border border-gray-200 bg-white shadow-sm hover:bg-gray-50"
            title={collapsed ? 'Expandir menú' : 'Colapsar menú'}
          >
            {collapsed ? <ChevronRight size={16} /> : <ChevronLeft size={16} />}
          </button>

          {/* RBAC INTERNO V1 (sin cambios): la lista de módulos visibles sale
              de modulosVisiblesParaRol(rolPropio) — la matriz central en
              lib/permissions.ts. "ingresarOrden" se omite a propósito: nunca
              fue un NavItem de sidebar. Digitador conserva su "Inicio" propio
              (fuera de la matriz, es su home) delante de lo que la matriz le
              habilite. */}
          <nav className="flex-1 space-y-2 overflow-y-auto p-3">
            {esDigitador && (
              <NavItem
                href="/panel/digitador"
                icon={<LayoutDashboard size={18} />}
                label="Inicio"
                active={pathname === '/panel/digitador'}
                collapsed={collapsed}
              />
            )}
            {modulosVisiblesParaRol(rolPropio)
              .filter((moduleId): moduleId is Exclude<ModuleId, 'ingresarOrden'> => moduleId !== 'ingresarOrden')
              .map((moduleId) => {
                const modulo = MODULOS_PANEL[moduleId]
                const active = moduleId === 'dashboard'
                  ? pathname === modulo.ruta
                  : pathname.startsWith(modulo.ruta)
                return (
                  <NavItem
                    key={moduleId}
                    href={modulo.ruta}
                    icon={ICONOS_MODULO[moduleId]}
                    label={modulo.label}
                    active={active}
                    collapsed={collapsed}
                    badge={badges?.[moduleId]?.count}
                    badgeVariant={badges?.[moduleId]?.variant}
                  />
                )
              })}
          </nav>

          {/* LOGOUT PANEL INTERNO V1 (sin cambios de fondo): visible para
              admin/gestor/digitador por igual. */}
          <div className="border-t border-gray-200 p-3 shrink-0">
            {!collapsed && profile?.name && (
              <p className="mb-2 truncate px-3 text-xs font-semibold text-gray-500" title={profile.name}>
                {profile.name}
              </p>
            )}
            <button
              onClick={onCerrarSesion}
              disabled={cerrandoSesion}
              title="Cerrar sesión"
              className={`flex w-full items-center rounded-xl px-3 py-2.5 text-sm font-medium text-red-600 hover:bg-red-50 transition disabled:opacity-50 disabled:cursor-not-allowed ${collapsed ? 'justify-center' : 'gap-3'}`}
            >
              <LogOut size={17} className="shrink-0" />
              {!collapsed && <span>Cerrar sesión</span>}
            </button>
          </div>
        </div>
      </aside>

      <main className="min-w-0 flex-1 overflow-hidden flex flex-col">
        <div className="flex-1 overflow-auto flex flex-col p-4 min-h-0">{children}</div>
        {footerExtra}
      </main>

      {overlayExtra}
    </div>
  )
}

// ─── NavItem ──────────────────────────────────────────────────────────────────
function NavItem({
  href,
  icon,
  label,
  active,
  collapsed,
  badge,
  badgeVariant = 'default',
}: {
  href: string
  icon: React.ReactNode
  label: string
  active: boolean
  collapsed: boolean
  badge?: number
  badgeVariant?: 'default' | 'nueva' | 'seen'
}) {
  const badgeColor =
    badgeVariant === 'nueva' ? 'bg-orange-500'
    : badgeVariant === 'seen' ? 'bg-blue-500'
    : 'bg-red-500'

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
          <span className={`absolute -top-1 -right-1 flex h-4 w-4 items-center justify-center rounded-full ${badgeColor} text-[9px] font-black text-white`}>
            {badge > 9 ? '9+' : badge}
            {badgeVariant === 'nueva' && (
              <span
                className="absolute inset-0 rounded-full bg-orange-500 opacity-75"
                style={{ animation: 'pulse-ring 1.5s ease-out infinite' }}
              />
            )}
          </span>
        )}
      </span>
      {!collapsed && <span className="flex-1">{label}</span>}
      {!collapsed && badge !== undefined && (
        <span className={`relative ml-auto flex h-5 min-w-5 items-center justify-center rounded-full ${badgeColor} px-1 text-[10px] font-black text-white`}>
          {badge > 99 ? '99+' : badge}
          {badgeVariant === 'nueva' && (
            <span
              className="absolute inset-0 rounded-full bg-orange-500 opacity-75"
              style={{ animation: 'pulse-ring 1.5s ease-out infinite' }}
            />
          )}
        </span>
      )}
    </Link>
  )
}
