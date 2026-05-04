'use client'
import dynamic from 'next/dynamic'

const CalculadoraPrecio = dynamic(
  () => import('@/app/Components/CalculadoraPrecio').then(m => m.default),
  { ssr: false }
)

export default function CalculadoraGestorPage() {
  return (
    <div className="space-y-6">
      <div className="rounded-2xl bg-white border shadow-sm p-6">
        <h1 className="text-2xl font-bold">Calculadora</h1>
        <p className="text-gray-600 mt-1">
          Estimá el precio entre dos puntos. Podés buscar la dirección de un comercio para rellenar el punto de retiro.
        </p>
      </div>

      <section className="rounded-2xl bg-white border shadow-sm">
        <div className="w-full max-w-5xl mx-auto p-4 md:p-6">
          <CalculadoraPrecio showBuscadorComercio={true} />
        </div>
      </section>
    </div>
  )
}
