'use client'
import React from 'react'

const WA_LINK =
  'https://wa.me/50589530626?text=Hola%2C%20me%20gustaría%20afiliarme%20a%20StorkHub'

export default function CTABanner() {
  return (
    <section className="relative bg-[#ffd700] py-20 px-6 overflow-hidden">
      {/* Ciudad de fondo — sutil en la parte baja */}
      <img
        src="/backgrounds/ciudad.png"
        alt=""
        className="absolute bottom-0 left-0 w-full object-cover object-bottom opacity-15 pointer-events-none select-none"
      />
      {/* Nubes para dar ambiente */}
      <img
        src="/backgrounds/nube1.png"
        alt=""
        className="absolute top-4 left-6 w-32 opacity-25 animate-float pointer-events-none select-none hidden md:block"
      />
      <img
        src="/backgrounds/nube2.png"
        alt=""
        className="absolute top-6 right-8 w-36 opacity-25 animate-float-slow pointer-events-none select-none hidden md:block"
      />

      <div className="relative z-10 max-w-3xl mx-auto text-center">
        <h2 className="text-3xl md:text-4xl font-extrabold text-[#004aad] mb-4 leading-tight">
          ¿Listo para simplificar tus envíos?
        </h2>
        <p className="text-[#004aad]/80 text-base md:text-lg mb-8 max-w-xl mx-auto">
          Únete a los comercios de Managua que ya confían en StorkHub.
          Sin contratos, sin complicaciones — solo resultados.
        </p>
        <a
          href={WA_LINK}
          target="_blank"
          rel="noopener noreferrer"
          className="inline-flex items-center gap-3 bg-[#004aad] hover:bg-blue-800 text-white font-bold py-4 px-10 rounded-full shadow-xl transition-all duration-300 hover:-translate-y-0.5 hover:shadow-2xl text-base md:text-lg"
        >
          <svg className="w-6 h-6" fill="currentColor" viewBox="0 0 24 24" aria-hidden="true">
            <path d="M17.472 14.382c-.297-.149-1.758-.867-2.03-.967-.273-.099-.471-.148-.67.15-.197.297-.767.966-.94 1.164-.173.199-.347.223-.644.075-.297-.15-1.255-.463-2.39-1.475-.883-.788-1.48-1.761-1.653-2.059-.173-.297-.018-.458.13-.606.134-.133.298-.347.446-.52.149-.174.198-.298.298-.497.099-.198.05-.371-.025-.52-.075-.149-.669-1.612-.916-2.207-.242-.579-.487-.5-.669-.51-.173-.008-.371-.01-.57-.01-.198 0-.52.074-.792.372-.272.297-1.04 1.016-1.04 2.479 0 1.462 1.065 2.875 1.213 3.074.149.198 2.096 3.2 5.077 4.487.709.306 1.262.489 1.694.625.712.227 1.36.195 1.871.118.571-.085 1.758-.719 2.006-1.413.248-.694.248-1.289.173-1.413-.074-.124-.272-.198-.57-.347z"/>
            <path d="M12 0C5.373 0 0 5.373 0 12c0 2.125.558 4.122 1.528 5.856L0 24l6.335-1.508A11.954 11.954 0 0012 24c6.627 0 12-5.373 12-12S18.627 0 12 0zm0 21.818a9.818 9.818 0 01-5.003-1.368l-.36-.213-3.722.886.934-3.613-.234-.371A9.818 9.818 0 1112 21.818z"/>
          </svg>
          Empezá hoy por WhatsApp
        </a>
      </div>
    </section>
  )
}
