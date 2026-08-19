'use client'
import dynamic from 'next/dynamic'
import { useModuleGuard } from '../../_hooks/useModuleGuard'

const CalculadoraPrecio = dynamic(
  () => import('@/app/Components/CalculadoraPrecio').then(m => m.default),
  { ssr: false }
)

export default function CalculadoraGestorPage() {
  const estadoGuardModulo = useModuleGuard('calculadora')
  if (estadoGuardModulo !== 'autorizado') {
    return (
      <div className="w-full px-6 py-6 text-sm text-gray-600">
        {estadoGuardModulo === 'redirigiendo' ? 'Redirigiendo a tu panel...' : 'Validando permisos...'}
      </div>
    )
  }
  return <CalculadoraGestorPageContent />
}

function CalculadoraGestorPageContent() {
  return (
    <div className="w-full max-w-5xl mx-auto space-y-4">
      {/* B1: cabecera compacta — sin caja propia, para no anidar marcos. */}
      <div className="px-1">
        <h1 className="text-xl font-bold text-gray-900">Calculadora</h1>
        <p className="text-[13px] text-gray-500">
          Estimá el precio entre dos puntos. Podés buscar la dirección de un comercio para rellenar el punto de retiro.
        </p>
      </div>

      <CalculadoraPrecio showBuscadorComercio={true} />
    </div>
  )
}
