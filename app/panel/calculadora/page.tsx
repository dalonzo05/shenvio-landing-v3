'use client'
import dynamic from 'next/dynamic'

// ⚠️ IMPORT CORRECTO: CalculadoraPrecio, NO MapaSeleccion
const CalculadoraPrecio = dynamic(
  () => import('@/app/Components/CalculadoraPrecio').then(m => m.default),
  { ssr: false }
)

export default function CalculadoraPanel() {
  return (
    <div className="w-full max-w-5xl mx-auto space-y-4">
      {/* B1: cabecera compacta — sin caja propia, para no anidar marcos. */}
      <div className="px-1">
        <h1 className="text-xl font-bold text-gray-900">Calculadora</h1>
        <p className="text-[13px] text-gray-500">
          Estimá el precio entre dos puntos dentro de Managua y municipios aledaños.
        </p>
      </div>

      <CalculadoraPrecio solicitudBase="/panel/comercio/solicitar" />
    </div>
  )
}
