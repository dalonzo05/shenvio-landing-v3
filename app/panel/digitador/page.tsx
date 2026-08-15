'use client'

// Entrada mínima del Digitador (DIGITADOR V1, sección 7 / DIGITADOR UX V1).
// No es un dashboard nuevo: es el punto de aterrizaje al que rutaDeRol() lo
// manda después de iniciar sesión. Desde DIGITADOR UX V1 usa el mismo shell
// (sidebar + logout) que gestor/layout.tsx vía PanelShell — única fuente de
// verdad, ver app/panel/_components/PanelShell.tsx — y sus tarjetas de
// acceso rápido reflejan exactamente los módulos que modulosVisiblesParaRol
// ya le autoriza (lib/permissions.ts), sin una segunda lista mantenida a
// mano.
import { useCallback, useState } from 'react'
import Link from 'next/link'
import { useRouter } from 'next/navigation'
import { Wallet, BadgeDollarSign, BarChart3, Receipt, TrendingUp } from 'lucide-react'
import { useRoleGuard, type Rol } from '../_hooks/useRoleGuard'
import { useUser } from '@/app/Components/UserProvider'
import { PanelShell } from '../_components/PanelShell'
import { MODULOS_PANEL, modulosVisiblesParaRol, type ModuleId } from '@/lib/permissions'

const ROLES_DIGITADOR: readonly Rol[] = ['digitador']

// Ícono + descripción por tarjeta. Solo cubre los módulos que hoy puede ver
// un Digitador (matriz vigente); si la matriz cambiara, un módulo nuevo
// simplemente no tendría tarjeta hasta agregarse acá — no rompe nada porque
// sigue estando en el sidebar igual (vía PanelShell).
const TARJETA_POR_MODULO: Partial<Record<ModuleId, { icon: React.ReactNode; descripcion: string; color: string }>> = {
  depositos: {
    icon: <Wallet className="h-5 w-5 text-blue-600" />,
    descripcion: 'Digitá comprobantes de depósito (Storkhub o comercio). Quedan pendientes de revisión.',
    color: 'bg-blue-50',
  },
  saldos: {
    icon: <BadgeDollarSign className="h-5 w-5 text-amber-600" />,
    descripcion: 'Proponé abonos a la deuda de un motorizado. No se aplican hasta que un gestor confirme.',
    color: 'bg-amber-50',
  },
  reportes: {
    icon: <BarChart3 className="h-5 w-5 text-purple-600" />,
    descripcion: 'Accedé a los reportes habilitados para tu rol.',
    color: 'bg-purple-50',
  },
  liquidaciones: {
    icon: <Receipt className="h-5 w-5 text-green-600" />,
    descripcion: 'Accedé a las liquidaciones habilitadas para tu rol.',
    color: 'bg-green-50',
  },
  financiero: {
    icon: <TrendingUp className="h-5 w-5 text-indigo-600" />,
    descripcion: 'Accedé a la información financiera habilitada para tu rol.',
    color: 'bg-indigo-50',
  },
}

export default function DigitadorHome() {
  const router = useRouter()
  const estadoGuard = useRoleGuard(ROLES_DIGITADOR, '/panel/digitador')
  const { profile, signOut } = useUser()
  const [cerrandoSesion, setCerrandoSesion] = useState(false)

  // Mismo patrón que gestor/layout.tsx (LOGOUT PANEL INTERNO V1): doble-clic
  // guard simple + respaldo explícito de router.push, useRoleGuard ya
  // redirige a /login en cuanto onAuthStateChanged emite null.
  const handleCerrarSesion = useCallback(async () => {
    if (cerrandoSesion) return
    setCerrandoSesion(true)
    try {
      await signOut()
      router.push('/login')
    } catch (err) {
      console.error('[digitador] error al cerrar sesión:', err)
      setCerrandoSesion(false)
    }
  }, [cerrandoSesion, signOut, router])

  if (estadoGuard !== 'autorizado') {
    return (
      <div className="w-full px-6 py-6 text-sm text-gray-600">
        {estadoGuard === 'redirigiendo' ? 'Redirigiendo a tu panel...' : 'Validando permisos...'}
      </div>
    )
  }

  return (
    <PanelShell rolPropio="digitador" profile={profile} onCerrarSesion={handleCerrarSesion} cerrandoSesion={cerrandoSesion}>
      <div className="max-w-3xl mx-auto px-4 py-10 space-y-8 w-full">
        <div>
          <h1 className="text-2xl font-black text-gray-900 tracking-tight">Panel de digitación</h1>
          <p className="text-sm text-gray-600 mt-1">
            Registrá comprobantes y propuestas de abono. Un gestor o admin confirma cada uno antes
            de que se aplique.
          </p>
        </div>

        <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
          {modulosVisiblesParaRol('digitador').map((moduleId) => {
            const tarjeta = TARJETA_POR_MODULO[moduleId]
            if (!tarjeta) return null
            const modulo = MODULOS_PANEL[moduleId]
            return (
              <Link
                key={moduleId}
                href={modulo.ruta}
                className="group rounded-2xl border border-gray-200 bg-white p-5 shadow-sm hover:shadow-md hover:-translate-y-0.5 transition"
              >
                <div className="flex items-center gap-3">
                  <div className={`rounded-lg ${tarjeta.color} p-2`}>{tarjeta.icon}</div>
                  <h2 className="text-base font-semibold text-gray-900">{modulo.label}</h2>
                </div>
                <p className="text-xs text-gray-500 mt-2">{tarjeta.descripcion}</p>
                <div className="mt-3 text-xs font-semibold text-[#004aad]">Abrir →</div>
              </Link>
            )
          })}
        </div>
      </div>
    </PanelShell>
  )
}
