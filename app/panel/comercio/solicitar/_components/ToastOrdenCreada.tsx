'use client'

import { useEffect, useState } from 'react'
import { CheckCircle2, X } from 'lucide-react'

const MENSAJES = [
  '🛵 Estamos buscando al mejor motorizado para tu entrega.',
  '📦 Tu envío ya entró a operaciones.',
  '⚡ Coordinando retiro y entrega.',
  '🚦 Tu delivery ya está en cola de asignación.',
  '🛰️ Señal enviada a la central Storkhub.',
  '📍 Calculando la mejor ruta para tu envío.',
  '👀 Nuestro equipo ya recibió tu orden.',
  '🧭 Preparando la logística de entrega.',
]

export default function ToastOrdenCreada({
  show,
  onDismiss,
}: {
  show: boolean
  onDismiss: () => void
}) {
  const [mensaje] = useState(() => MENSAJES[Math.floor(Math.random() * MENSAJES.length)])
  const [visible, setVisible] = useState(false)

  useEffect(() => {
    if (!show) { setVisible(false); return }
    // Pequeño delay para que la animación de entrada sea visible
    const t1 = setTimeout(() => setVisible(true), 10)
    const t2 = setTimeout(() => { setVisible(false); setTimeout(onDismiss, 300) }, 5000)
    return () => { clearTimeout(t1); clearTimeout(t2) }
  }, [show, onDismiss])

  if (!show) return null

  return (
    <div
      className={`fixed bottom-6 right-4 z-50 w-[calc(100vw-2rem)] max-w-sm transition-all duration-300 ${
        visible ? 'opacity-100 translate-y-0' : 'opacity-0 translate-y-3'
      }`}
    >
      <div className="rounded-2xl border border-green-200 bg-white shadow-xl shadow-green-100/50 overflow-hidden">
        {/* Barra de acento superior */}
        <div className="h-1 w-full bg-gradient-to-r from-green-400 to-emerald-500" />

        <div className="flex items-start gap-3 px-4 py-3.5">
          <div className="shrink-0 mt-0.5">
            <CheckCircle2 className="h-5 w-5 text-green-500" />
          </div>

          <div className="flex-1 min-w-0">
            <p className="text-sm font-bold text-gray-900">Orden creada con éxito</p>
            <p className="text-xs text-gray-500 mt-0.5 leading-relaxed">{mensaje}</p>
          </div>

          <button
            onClick={() => { setVisible(false); setTimeout(onDismiss, 300) }}
            className="shrink-0 rounded-lg p-1 text-gray-400 hover:bg-gray-100 hover:text-gray-600 transition"
          >
            <X className="h-4 w-4" />
          </button>
        </div>
      </div>
    </div>
  )
}
