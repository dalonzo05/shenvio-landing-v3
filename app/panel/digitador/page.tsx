'use client'

// Entrada mínima del Digitador (DIGITADOR V1, sección 7). No es un dashboard
// nuevo: es solo el punto de aterrizaje al que rutaDeRol() lo manda después
// de iniciar sesión, desde donde entra a los dos módulos que reutiliza —
// Depósitos y Saldos, ambos bajo /panel/gestor/*, con el mismo layout que ya
// filtra su navegación (ver app/panel/gestor/layout.tsx, esDigitador).
import Link from 'next/link'
import { Wallet, BadgeDollarSign } from 'lucide-react'
import { useRoleGuard, type Rol } from '../_hooks/useRoleGuard'

const ROLES_DIGITADOR: readonly Rol[] = ['digitador']

export default function DigitadorHome() {
  const estadoGuard = useRoleGuard(ROLES_DIGITADOR, '/panel/digitador')

  if (estadoGuard !== 'autorizado') {
    return (
      <div className="w-full px-6 py-6 text-sm text-gray-600">
        {estadoGuard === 'redirigiendo' ? 'Redirigiendo a tu panel...' : 'Validando permisos...'}
      </div>
    )
  }

  return (
    <div className="max-w-3xl mx-auto px-4 py-10 space-y-8">
      <div>
        <h1 className="text-2xl font-black text-gray-900 tracking-tight">Panel de digitación</h1>
        <p className="text-sm text-gray-600 mt-1">
          Registrá comprobantes y propuestas de abono. Un gestor o admin confirma cada uno antes
          de que se aplique.
        </p>
      </div>

      <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
        <Link
          href="/panel/gestor/depositos"
          className="group rounded-2xl border border-gray-200 bg-white p-5 shadow-sm hover:shadow-md hover:-translate-y-0.5 transition"
        >
          <div className="flex items-center gap-3">
            <div className="rounded-lg bg-blue-50 p-2">
              <Wallet className="h-5 w-5 text-blue-600" />
            </div>
            <h2 className="text-base font-semibold text-gray-900">Depósitos</h2>
          </div>
          <p className="text-xs text-gray-500 mt-2">
            Digitá comprobantes de depósito (Storkhub o comercio). Quedan pendientes de revisión.
          </p>
          <div className="mt-3 text-xs font-semibold text-[#004aad]">Abrir →</div>
        </Link>

        <Link
          href="/panel/gestor/saldos"
          className="group rounded-2xl border border-gray-200 bg-white p-5 shadow-sm hover:shadow-md hover:-translate-y-0.5 transition"
        >
          <div className="flex items-center gap-3">
            <div className="rounded-lg bg-amber-50 p-2">
              <BadgeDollarSign className="h-5 w-5 text-amber-600" />
            </div>
            <h2 className="text-base font-semibold text-gray-900">Saldos a cargo</h2>
          </div>
          <p className="text-xs text-gray-500 mt-2">
            Proponé abonos a la deuda de un motorizado. No se aplican hasta que un gestor confirme.
          </p>
          <div className="mt-3 text-xs font-semibold text-[#004aad]">Abrir →</div>
        </Link>
      </div>
    </div>
  )
}
