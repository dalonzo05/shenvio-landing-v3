// app/Components/ServiciosYNosotros.tsx
'use client'
import React, { useState } from 'react'

interface Servicio {
  titulo: string
  descripcion: string
  icono: string
}

const servicios: Servicio[] = [
  {
    titulo: 'Entregas para comercios',
    descripcion:
      'Coordinamos retiros en tu tienda y entregas el mismo día. Sin demoras ni complicaciones.',
    icono: '/icons/store.svg',
  },
  {
    titulo: 'Cobros contra entrega',
    descripcion:
      'Cobramos por vos y depositamos según lo acordado: diario, semanal o quincenal.',
    icono: '/icons/cobros.svg',
  },
  {
    titulo: 'Entregas personales (express)',
    descripcion:
      '¿Querés mandar algo puntual? Lo retiramos y entregamos directo, rápido y seguro.',
    icono: '/icons/personales.svg',
  },
  {
    titulo: 'Atención personalizada',
    descripcion:
      'No somos una app automatizada. Te respondemos personas reales, con soluciones reales.',
    icono: '/icons/a_personalizada.svg',
  },
  {
    titulo: 'Cobertura Managua y más',
    descripcion:
      'Llegamos a toda Managua y zonas cercanas como Tipitapa, Ticuantepe, Ciudad Sandino y más.',
    icono: '/icons/cobertura.svg',
  },
  {
    titulo: 'Seguimiento en línea',
    descripcion:
      'Podés preguntar por tu envío en cualquier momento. Siempre sabrás dónde está tu paquete.',
    icono: '/icons/seguimiento.svg',
  },
]

const ServiciosYNosotros = ({ id }: { id: string }) => {
  const [hovered, setHovered] = useState<number | null>(null)

  return (
    <section
      id={id}
      className="relative py-24 px-6 bg-[#e5e5e5] text-gray-800 overflow-hidden"
    >
      {/* Decorado: nubes (sin ciudad.png) */}
      <div className="absolute inset-0 z-0 pointer-events-none">
        <img
          src="/backgrounds/nube1.png"
          alt="Nube"
          className="absolute top-8 left-6 w-20 opacity-80 animate-float hidden sm:block"
        />
        <img
          src="/backgrounds/nube2.png"
          alt="Nube"
          className="absolute top-12 right-8 w-24 opacity-80 animate-float hidden sm:block"
        />
        <img
          src="/backgrounds/nube1.png"
          alt="Nube"
          className="absolute top-32 left-1/3 w-20 opacity-80 animate-float hidden sm:block"
        />
        <img
          src="/backgrounds/nube2.png"
          alt="Nube"
          className="absolute top-40 right-1/4 w-20 opacity-80 animate-float hidden sm:block"
        />
      </div>

      {/* Contenido */}
      <div className="relative z-10">
        <h2 className="text-3xl md:text-4xl font-extrabold text-center mb-6 text-[#004aad] tracking-tight">
          Somos tu partner logístico
        </h2>

        <p className="text-center max-w-3xl mx-auto mb-12 text-gray-700 text-base md:text-lg">
          En <strong>Storkhub</strong> conectamos negocios y personas a través de un servicio de
          entregas ágil, transparente y humano. Nos adaptamos a tu estilo, con comunicación clara
          y atención real.
        </p>

        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-8 max-w-6xl mx-auto">
          {servicios.map((servicio, index) => (
            <div
              key={index}
              onMouseEnter={() => setHovered(index)}
              onMouseLeave={() => setHovered(null)}
              className={`p-6 rounded-2xl shadow-sm border border-gray-100 transition-all duration-300 ease-in-out cursor-default text-center ${
                hovered === index
                  ? 'bg-[#004aad] text-white scale-[1.03] shadow-lg'
                  : 'bg-white text-gray-800'
              }`}
            >
              <img
                src={servicio.icono}
                alt={servicio.titulo}
                className="mx-auto mb-4 w-12 h-12 object-contain"
              />
              <h3 className="text-lg font-bold mb-2">{servicio.titulo}</h3>
              <p className="text-sm leading-relaxed">{servicio.descripcion}</p>
            </div>
          ))}
        </div>
      </div>
    </section>
  )
}

export default ServiciosYNosotros
