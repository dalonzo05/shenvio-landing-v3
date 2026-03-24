'use client'
import React from 'react'

const pasos = [
  {
    titulo: '1. Enviás tu orden',
    descripcion: 'Nos escribís por WhatsApp con los datos del envío. Confirmamos todo y te damos seguimiento.',
    icono: '/icons/confirma.svg',
  },
  {
    titulo: '2. Retiramos el paquete',
    descripcion: 'Asignamos a un motorizado y pasamos a retirar en tu local o punto acordado.',
    icono: '/icons/retira.svg',
  },
  {
    titulo: '3. Entregamos y cobramos',
    descripcion: 'Hacemos la entrega al cliente final. Si es contra entrega, cobramos y luego te depositamos.',
    icono: '/icons/entrega.svg',
  },
  {
    titulo: '4. Te confirmamos todo',
    descripcion: 'Recibís confirmación, evidencia y reporte del dinero cobrado. Todo claro y documentado.',
    icono: '/icons/whatsapp.svg',
  },
  {
    titulo: '5. Seguimiento en tiempo real',
    descripcion: 'Podés consultar el estado de tu envío cuando lo necesités, con atención personalizada.',
    icono: '/icons/seguimiento.svg',
  },
  {
    titulo: '6. Recibís tu pago',
    descripcion: 'Al finalizar el día, te depositamos todo lo recaudado de tus entregas. Fácil y seguro.',
    icono: '/icons/deposito.svg',
  },
]

const ComoFunciona = ({ id }: { id: string }) => {
  return (
    <section id={id} className="relative py-24 px-6 bg-[#f7f7f8] text-gray-800 rounded-t-3xl overflow-hidden">
      {/* Cigüeña flotante decorativa */}
      {/*<img
        src="/backgrounds/cigueña-blanca.png"
        alt="Cigüeña volando"
        className="absolute top-40 left-20 w-24 md:w-32 opacity-80 animate-float-x z-0"
      />*/}
            {/* Cigüeña flotante decorativa */}
      <img
        src="/backgrounds/cigueña-blanca.png"
        alt="Cigüeña volando"
        className="absolute top-100 left-30 w-45 md:w-32 opacity-50 animate-float-x z-0"
      />
            {/* Cigüeña flotante decorativa */}
      <img
        src="/backgrounds/cigueña-blanca.png"
        alt="Cigüeña volando"
        className="absolute top-240 right-40 w-75 md:w-32 opacity-50 animate-float-x z-0"
      />  
      
      <h2 className="text-3xl md:text-4xl font-extrabold text-center mb-6 text-[#004aad] tracking-tight relative z-10">
        ¿Cómo funciona?
      </h2>
        <p className="text-center max-w-3xl mx-auto mb-12 text-gray-700 text-base md:text-lg relative z-10">
        Tan simple como pedir, entregar y recibir. Así funciona Storkhub.
        </p>

      <div className="flex flex-col gap-16 max-w-5xl mx-auto relative z-10">
        {pasos.map((paso, index) => (
          <div
            key={index}
            className={`flex flex-col md:flex-row items-center gap-6 md:gap-12 transition-all duration-300 ${
              index % 2 !== 0 ? 'md:flex-row-reverse' : ''
            }`}
          >
            <div className="flex-shrink-0">
              <img
                src={paso.icono}
                alt={paso.titulo}
                className="w-20 h-20 md:w-24 md:h-24 object-contain"
              />
            </div>

            <div className="bg-white rounded-2xl shadow-lg p-6 md:p-8 w-full md:w-3/4 hover:shadow-xl transition-all duration-300">
              <h3 className="text-xl md:text-2xl font-semibold mb-2 text-[#004aad]">
                {paso.titulo}
              </h3>
              <p className="text-gray-700 text-sm md:text-base">{paso.descripcion}</p>
            </div>
          </div>
        ))}
      </div>
    </section>
  )
}

export default ComoFunciona
