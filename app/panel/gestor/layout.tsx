'use client'

import { useEffect, useState, useRef, useCallback } from 'react'
import { usePathname, useRouter } from 'next/navigation'
import Link from 'next/link'
import { auth, db } from '@/fb/config'
import { collection, doc, getDoc, onSnapshot, query, where, orderBy } from 'firebase/firestore'
import { useUser } from '@/app/Components/UserProvider'
import { useRoleGuard, type Rol } from '../_hooks/useRoleGuard'
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
  Map,
  Calculator,
  FileText,
  BadgeDollarSign,
  ShieldCheck,
  LogOut,
} from 'lucide-react'
import { ToastNuevaOrden, type ToastData } from './_components/ToastNuevaOrden'
import { MODULOS_PANEL, modulosVisiblesParaRol, type ModuleId } from '@/lib/permissions'

// Íconos por módulo — RBAC INTERNO V1. Un solo mapa reemplaza los dos
// bloques de NavItem hardcodeados que existían antes (uno por rol): el
// sidebar ahora se construye filtrando MODULOS_PANEL contra el rol propio,
// nunca listando roles a mano acá. "ingresarOrden" no tiene ícono propio
// porque nunca fue (ni pasa a ser en este bloque) un NavItem de sidebar —
// se accede solo desde el acceso rápido del Dashboard, ver gestor/page.tsx.
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

const MAX_TOASTS = 3

// Constante de módulo a propósito: useRoleGuard la recibe como dependencia del
// efecto, así que un literal en línea lo reejecutaría en cada render.
//
// Digitador: reutiliza este mismo layout y estas mismas rutas — no tiene
// árbol de paneles propio (ver investigación DIGITADOR V1, sección "Panel
// recomendado"). El guard lo deja entrar para no duplicar componentes; lo
// que lo diferencia del gestor es (a) la navegación visible, resuelta por
// la matriz central (ver lib/permissions.ts, RBAC INTERNO V1), y (b)
// Firestore Rules, que niegan cualquier escritura/lectura fuera de lo que
// esté explícitamente autorizado. La UI oculta enlaces por claridad, NUNCA
// por seguridad — entrar a una URL oculta sin permiso real simplemente no
// devuelve datos ni permite escribir, y desde RBAC INTERNO V1 además cada
// página de gestor/** tiene su propio useModuleGuard que redirige antes de
// montar el contenido.
// Módulos permitidos para Digitador (matriz vigente, RBAC INTERNO V1 —
// ajuste final): Depósitos, Saldos, Reportes, Liquidaciones, Financiero.
// Todo lo demás (dashboard de gestor, solicitudes, ingresar orden,
// motorizados, comercios, clientes, base de datos, zonas, calculadora,
// cobros, gastos, auditoría) queda denegado — ver lib/permissions.ts como
// única fuente de verdad, este comentario es solo documentación.
const ROLES_GESTOR: readonly Rol[] = ['admin', 'gestor', 'digitador']

export default function GestorLayout({ children }: { children: React.ReactNode }) {
  const pathname = usePathname()
  const router = useRouter()
  // Interruptor único del panel: hasta que no diga 'autorizado' no se abre
  // ningún listener. Sustituye al antiguo estado `loading`, que se quedaba
  // en true para siempre cuando el rol no correspondía.
  const estadoGuard = useRoleGuard(ROLES_GESTOR, '/panel/gestor')
  const autorizado = estadoGuard === 'autorizado'
  const [rolPropio, setRolPropio] = useState<Rol>(null)
  const esDigitador = rolPropio === 'digitador'
  // LOGOUT PANEL INTERNO V1: mismo helper que ya usan comercio/motorizado
  // (UserProvider.signOut → fbSignOut + limpieza de localStorage). No se
  // duplica lógica de Firebase Auth acá.
  const { profile, signOut } = useUser()
  const [cerrandoSesion, setCerrandoSesion] = useState(false)

  // Rol propio — solo para filtrar la navegación visible (UX). El guard de
  // arriba ya resolvió si puede estar acá; esto NO es una segunda capa de
  // seguridad, Firestore Rules es la única que importa para eso.
  useEffect(() => {
    if (!autorizado) return
    const uid = auth.currentUser?.uid
    if (!uid) return
    getDoc(doc(db, 'usuarios', uid)).then((snap) => {
      setRolPropio(snap.exists() ? ((snap.data() as { rol?: Rol })?.rol ?? null) : null)
    })
  }, [autorizado])
  const [collapsed, setCollapsed] = useState(false)
  const [cobrosPendientes, setCobrosPendientes] = useState(0)
  const [metricas, setMetricas] = useState({ activas: 0, entregadasHoy: 0, conProblema: 0, pendCobro: 0, prioritarias: 0 })

  // ── Estado de notificaciones ──────────────────────────────────────────────
  const [pendientesCount, setPendientesCount] = useState(0)
  const [nuevasNoVistas, setNuevasNoVistas] = useState(0)
  const [toasts, setToasts] = useState<ToastData[]>([])

  // Refs para detección de órdenes nuevas (persisten entre renders)
  const seenIdsRef = useRef<Set<string>>(new Set())
  const initializedRef = useRef(false)

  // Callbacks estables para gestionar toasts
  const addToast = useCallback((data: Omit<ToastData, 'id' | 'createdAt'>) => {
    const newToast: ToastData = {
      id: `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
      createdAt: Date.now(),
      ...data,
    }
    setToasts((prev) => {
      const next = [...prev, newToast]
      // FIFO: si supera el máximo, eliminar el más antiguo
      return next.length > MAX_TOASTS ? next.slice(next.length - MAX_TOASTS) : next
    })
  }, [])

  const dismissToast = useCallback((id: string) => {
    setToasts((prev) => prev.filter((t) => t.id !== id))
  }, [])

  // ── Cerrar sesión ──────────────────────────────────────────────────────────
  // Guard de doble clic simple (sin spinner: el resto del panel tampoco
  // muestra loading al hacer signOut, ver comercio/motorizado layout). Si
  // signOut() falla, se revierte el flag para no dejar el botón bloqueado
  // simulando una salida que no ocurrió.
  const handleCerrarSesion = useCallback(async () => {
    if (cerrandoSesion) return
    setCerrandoSesion(true)
    try {
      await signOut()
      // useRoleGuard ya redirige a /login en cuanto onAuthStateChanged
      // emite null (ver su handler `if (!user) irA('/login')`) — este push
      // es un respaldo explícito, no la única vía de salida.
      router.push('/login')
    } catch (err) {
      console.error('[gestor] error al cerrar sesión:', err)
      setCerrandoSesion(false)
    }
  }, [cerrandoSesion, signOut, router])

  // ── Badge: cobros pendientes en tiempo real ───────────────────────────────
  // Este era el listener que rompía la app: arrancaba sin esperar la
  // validación de rol, así que con sesión de comercio o motorizado pegaba
  // contra las reglas y el permission-denied sin manejar tumbaba al SDK.
  useEffect(() => {
    // Digitador V1 no opera cobros/solicitudes — el badge no le aplica.
    if (!autorizado || esDigitador) return
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
    }, (error) => {
      // Callback de error explícito: sin él, el SDK trata el fallo como no
      // manejado. Se libera el listener dejando el badge en su último valor.
      console.warn('[gestor] listener de cobros pendientes detenido:', error.code)
      setCobrosPendientes(0)
    })
    return () => unsub()
  }, [autorizado, esDigitador])

  // ── Métricas globales + detección de nuevas órdenes ──────────────────────
  useEffect(() => {
    // Digitador V1 no opera solicitudes — sin métricas ni toasts de "nueva orden".
    if (!autorizado || esDigitador) return
    const q = query(collection(db, 'solicitudes_envio'), orderBy('createdAt', 'desc'))
    const unsub = onSnapshot(q, (snap) => {
      const docs = snap.docs.map(d => ({ id: d.id, ...d.data() } as any))

      // ── Métricas existentes (sin cambios) ─────────────────────────────
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

      // ── Detección de nuevas órdenes pendiente_confirmacion ────────────
      const pendConf = docs.filter((s: any) => s.estado === 'pendiente_confirmacion')
      setPendientesCount(pendConf.length)

      if (!initializedRef.current) {
        // Primera carga: registrar IDs existentes sin mostrar toasts
        pendConf.forEach((s: any) => seenIdsRef.current.add(s.id))
        initializedRef.current = true
      } else {
        // Snapshots posteriores: detectar IDs genuinamente nuevos
        const nuevas = pendConf.filter((s: any) => !seenIdsRef.current.has(s.id))
        nuevas.forEach((s: any) => {
          seenIdsRef.current.add(s.id)
          addToast({
            solicitudId: s.id,
            comercio: s.ownerSnapshot?.companyName || s.ownerSnapshot?.nombre || 'Comercio',
            zona: s.zonaEntregaNombre || s.macroZonaEntregaNombre || '',
            direccion: s.entrega?.direccionEscrita || '',
          })
          setNuevasNoVistas((prev) => prev + 1)
        })
      }
    }, (error) => {
      console.warn('[gestor] listener de métricas detenido:', error.code)
    })
    return () => unsub()
  }, [autorizado, esDigitador, addToast])

  // ── Resetear "nuevas no vistas" al entrar a solicitudes ──────────────────
  useEffect(() => {
    if (pathname.startsWith('/panel/gestor/solicitudes')) {
      setNuevasNoVistas(0)
    }
  }, [pathname])

  // Dos textos distintos a propósito: "Validando permisos..." solo se ve
  // mientras la verificación está realmente en curso. Si el rol no
  // corresponde, el estado pasa a 'redirigiendo' y el mensaje cambia — así
  // una pantalla de validación detenida deja de ser un final posible.
  if (estadoGuard !== 'autorizado') {
    return (
      <div className="w-full px-6 py-6 text-sm text-gray-600">
        {estadoGuard === 'redirigiendo' ? 'Redirigiendo a tu panel...' : 'Validando permisos...'}
      </div>
    )
  }

  // Badge visual del sidebar según estado
  const solicitudesBadgeVariant: 'default' | 'nueva' | 'seen' =
    nuevasNoVistas > 0 ? 'nueva' : pendientesCount > 0 ? 'seen' : 'default'

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
                <p className="mt-1 text-xs text-gray-500">Panel gestor</p>
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

          {/* RBAC INTERNO V1: la lista de módulos visibles sale de
              modulosVisiblesParaRol(rolPropio) — la matriz central en
              lib/permissions.ts — no de una rama hardcodeada por rol.
              "ingresarOrden" se omite a propósito: nunca fue un NavItem de
              sidebar (solo acceso rápido desde el Dashboard). Digitador
              conserva su "Inicio" propio (fuera de la matriz, es su home,
              no un módulo de gestor) prefijado a lo que la matriz le
              habilite — hoy eso resuelve a Depósitos, Saldos, Reportes,
              Liquidaciones y Financiero, y es la matriz quien lo decide,
              no un array paralelo mantenido a mano. */}
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
                    badge={
                      moduleId === 'solicitudes' ? (pendientesCount > 0 ? pendientesCount : undefined)
                      : moduleId === 'cobros' ? (cobrosPendientes > 0 ? cobrosPendientes : undefined)
                      : undefined
                    }
                    badgeVariant={moduleId === 'solicitudes' ? solicitudesBadgeVariant : undefined}
                  />
                )
              })}
          </nav>
          {/* NOTA DE SEGURIDAD (sin cambios de fondo): esto sigue siendo
              filtrado de UI por claridad, NUNCA la barrera de seguridad
              real. Esa barrera hoy tiene dos capas: useRoleGuard (admite al
              panel) + useModuleGuard por página (admite al módulo) +,
              debajo de ambas, Firestore Rules — que es quien de verdad
              decide qué datos se leen o escriben. */}

          {/* LOGOUT PANEL INTERNO V1: visible para admin/gestor/digitador
              por igual — no depende de la matriz de módulos, cerrar sesión
              siempre está disponible para cualquier usuario autenticado.
              Mismo patrón visual que comercio/motorizado layout. */}
          <div className="border-t border-gray-200 p-3 shrink-0">
            {!collapsed && profile?.name && (
              <p className="mb-2 truncate px-3 text-xs font-semibold text-gray-500" title={profile.name}>
                {profile.name}
              </p>
            )}
            <button
              onClick={handleCerrarSesion}
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

        {/* ── BARRA INFERIOR GLOBAL ── oculta para Digitador: son métricas y
            accesos de solicitudes, fuera de su alcance (D3/D4). ────────────── */}
        {!esDigitador && (
        <div className="shrink-0 bg-white border-t border-gray-200 shadow-[0_-1px_4px_rgba(0,0,0,0.06)]">
          <div className="flex items-center gap-2 px-4 py-2 overflow-x-auto">

            {/* Pill especial: Nuevas (pendiente_confirmacion) */}
            <Link
              href="/panel/gestor/solicitudes"
              className={`inline-flex items-center gap-1.5 rounded-full border px-3 py-1 text-xs font-semibold whitespace-nowrap transition shrink-0 ${
                pendientesCount > 0
                  ? 'bg-orange-50 text-orange-700 border-orange-200 hover:bg-orange-100'
                  : 'bg-gray-50 text-gray-400 border-gray-200 pointer-events-none'
              }`}
            >
              {pendientesCount > 0 && (
                <span className="relative flex h-2 w-2 shrink-0">
                  <span
                    className="absolute inline-flex h-full w-full rounded-full bg-orange-400 opacity-75"
                    style={{ animation: 'pulse-ring 1.4s ease-out infinite' }}
                  />
                  <span className="relative inline-flex h-2 w-2 rounded-full bg-orange-500" />
                </span>
              )}
              <span className="font-bold">{pendientesCount}</span>
              Nuevas
            </Link>

            {/* Pills existentes */}
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
        )}
      </main>

      {/* Toasts de nuevas órdenes — mismo alcance que la barra inferior. */}
      {!esDigitador && <ToastNuevaOrden toasts={toasts} onDismiss={dismissToast} />}
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
