'use client'
import React from 'react'

interface Props {
  id: string
}

const WA_LINK =
  'https://wa.me/50589530626?text=Hola%2C%20me%20gustaría%20afiliarme%20a%20StorkHub'

const badges = [
  'Sin contrato mensual',
  'Pago al día',
  'Respuesta en minutos',
]

const Inicio: React.FC<Props> = ({ id }) => {
  const scrollToComoFunciona = () => {
    const el = document.getElementById('como-funciona')
    if (el) el.scrollIntoView({ behavior: 'smooth' })
  }

  return (
    <section id={id} className="relative w-full h-[90vh] overflow-hidden">
      {/* Video de fondo */}
      <video
        className="absolute top-0 left-0 w-full h-full object-cover z-0"
        src="/motorizado.mp4"
        autoPlay
        muted
        loop
        playsInline
      />

      {/* Overlay oscuro con gradiente */}
      <div className="absolute top-0 left-0 w-full h-full bg-gradient-to-b from-black/60 via-black/50 to-black/70 z-10" />

      {/* Contenido */}
      <div className="relative z-20 flex items-center justify-center h-full px-6">
        <div className="max-w-3xl text-center text-white">

          {/* Pill de categoría */}
          <div className="inline-flex items-center gap-2 bg-white/10 border border-white/20 rounded-full px-4 py-1.5 mb-6 text-sm font-medium tracking-wide backdrop-blur-sm">
            <span className="w-2 h-2 rounded-full bg-[#ffd700] animate-pulse" />
            Mensajería express en Managua y municipios
          </div>

          <h1 className="text-4xl md:text-6xl font-extrabold mb-5 leading-tight drop-shadow-lg">
            Entregas rápidas y seguras{' '}
            <span className="text-[#ffd700]">para tu negocio</span>
          </h1>

          <p className="text-lg md:text-xl mb-8 text-white/90 drop-shadow-md max-w-2xl mx-auto leading-relaxed">
            Retiramos, entregamos y cobramos por vos. Con seguimiento en tiempo real
            y depósito al finalizar el día.
          </p>

          {/* Botones CTA */}
          <div className="flex flex-col sm:flex-row gap-4 justify-center mb-8">
            <a
              href={WA_LINK}
              target="_blank"
              rel="noopener noreferrer"
              className="inline-flex items-center justify-center gap-2 bg-[#004aad] hover:bg-blue-700 text-white font-bold py-3.5 px-8 rounded-full shadow-lg transition-all duration-300 hover:-translate-y-0.5 hover:shadow-xl text-base"
            >
              <svg className="w-5 h-5" fill="currentColor" viewBox="0 0 24 24" aria-hidden="true">
                <path d="M17.472 14.382c-.297-.149-1.758-.867-2.03-.967-.273-.099-.471-.148-.67.15-.197.297-.767.966-.94 1.164-.173.199-.347.223-.644.075-.297-.15-1.255-.463-2.39-1.475-.883-.788-1.48-1.761-1.653-2.059-.173-.297-.018-.458.13-.606.134-.133.298-.347.446-.52.149-.174.198-.298.298-.497.099-.198.05-.371-.025-.52-.075-.149-.669-1.612-.916-2.207-.242-.579-.487-.5-.669-.51-.173-.008-.371-.01-.57-.01-.198 0-.52.074-.792.372-.272.297-1.04 1.016-1.04 2.479 0 1.462 1.065 2.875 1.213 3.074.149.198 2.096 3.2 5.077 4.487.709.306 1.262.489 1.694.625.712.227 1.36.195 1.871.118.571-.085 1.758-.719 2.006-1.413.248-.694.248-1.289.173-1.413-.074-.124-.272-.198-.57-.347z"/>
                <path d="M12 0C5.373 0 0 5.373 0 12c0 2.125.558 4.122 1.528 5.856L0 24l6.335-1.508A11.954 11.954 0 0012 24c6.627 0 12-5.373 12-12S18.627 0 12 0zm0 21.818a9.818 9.818 0 01-5.003-1.368l-.36-.213-3.722.886.934-3.613-.234-.371A9.818 9.818 0 1112 21.818z"/>
              </svg>
              Afiliarte por WhatsApp
            </a>

            <button
              onClick={scrollToComoFunciona}
              className="inline-flex items-center justify-center gap-2 border-2 border-white/70 text-white hover:bg-white hover:text-[#004aad] font-bold py-3.5 px-8 rounded-full transition-all duration-300 hover:-translate-y-0.5 text-base"
            >
              ¿Cómo funciona?
            </button>
          </div>

          {/* Trust badges */}
          <div className="flex flex-wrap justify-center gap-x-6 gap-y-2 text-sm text-white/80">
            {badges.map((badge) => (
              <span key={badge} className="flex items-center gap-1.5">
                <svg className="w-4 h-4 text-[#ffd700] flex-shrink-0" fill="none" stroke="currentColor" strokeWidth={2.5} viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" d="M5 13l4 4L19 7" />
                </svg>
                {badge}
              </span>
            ))}
          </div>

        </div>
      </div>

      {/* Flecha scroll hacia abajo */}
      <div className="absolute bottom-8 left-1/2 -translate-x-1/2 z-20 animate-bounce">
        <svg className="w-6 h-6 text-white/60" fill="none" stroke="currentColor" strokeWidth={2} viewBox="0 0 24 24">
          <path strokeLinecap="round" strokeLinejoin="round" d="M19 9l-7 7-7-7" />
        </svg>
      </div>
    </section>
  )
}

export default Inicio
