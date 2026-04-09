'use client'
import React from 'react'
import { Zap, HandCoins, MonitorSmartphone, Users } from 'lucide-react'

const props = [
  {
    Icono: Zap,
    titulo: 'Entregas el mismo día',
    desc: 'Retiramos y entregamos en horas, sin demoras.',
  },
  {
    Icono: HandCoins,
    titulo: 'Cobros contra entrega',
    desc: 'Cobramos por vos y te depositamos diario o semanal.',
  },
  {
    Icono: MonitorSmartphone,
    titulo: 'Plataforma de seguimiento',
    desc: 'Gestioná tus órdenes y seguí cada envío en tiempo real.',
  },
  {
    Icono: Users,
    titulo: 'Atención personalizada',
    desc: 'Un equipo real que te responde, no un bot automático.',
  },
]

export default function Estadisticas() {
  return (
    <section className="bg-[#004aad] py-12 px-6">
      <div className="max-w-6xl mx-auto grid grid-cols-2 md:grid-cols-4 gap-8">
        {props.map(({ Icono, titulo, desc }, i) => (
          <div
            key={titulo}
            className={`flex flex-col items-center text-center gap-3 ${
              i < props.length - 1 ? 'md:border-r md:border-white/15' : ''
            } px-4`}
          >
            <div className="w-12 h-12 rounded-xl bg-white/10 flex items-center justify-center flex-shrink-0">
              <Icono className="w-6 h-6 text-[#ffd700]" strokeWidth={1.75} />
            </div>
            <div>
              <p className="text-white font-bold text-sm md:text-base leading-snug">{titulo}</p>
              <p className="text-white/60 text-xs md:text-sm mt-1 leading-relaxed">{desc}</p>
            </div>
          </div>
        ))}
      </div>
    </section>
  )
}
