'use client'
import React from 'react'
import {
  ClipboardList,
  UserCheck,
  Package,
  Truck,
  MonitorSmartphone,
  Banknote,
} from 'lucide-react'

const pasos = [
  {
    titulo: 'Ingresás tu orden',
    descripcion:
      'Creás tu pedido directamente desde nuestro panel de comercios o nos escribís por WhatsApp. Registrás el origen, destino, datos del cliente y si el cobro es contra entrega.',
    Icono: ClipboardList,
    badge: 'Panel de comercio',
  },
  {
    titulo: 'El gestor recibe y asigna',
    descripcion:
      'Nuestro equipo recibe la orden, la revisa y asigna al motorizado disponible más cercano. Todo queda registrado en el sistema con estado en tiempo real.',
    Icono: UserCheck,
    badge: 'Panel del gestor',
  },
  {
    titulo: 'Retiro en tu local',
    descripcion:
      'El motorizado se dirige al punto de origen acordado y retira el paquete. El estado de la orden se actualiza automáticamente a "En camino".',
    Icono: Package,
    badge: 'Motorizado',
  },
  {
    titulo: 'Entrega y cobro',
    descripcion:
      'El repartidor entrega el producto al cliente final. Si es contra entrega, cobra el monto exacto y lo resguarda hasta depositártelo. Quedan registro y evidencia fotográfica.',
    Icono: Truck,
    badge: 'Motorizado',
  },
  {
    titulo: 'Seguimiento en tu panel',
    descripcion:
      'Desde tu panel de comercio podés ver el estado de cada envío en tiempo real: pendiente, en camino o entregado. Sin necesidad de llamar a preguntar.',
    Icono: MonitorSmartphone,
    badge: 'Panel de comercio',
  },
  {
    titulo: 'Recibís tu depósito',
    descripcion:
      'Al cierre del día (o según tu ciclo acordado: diario o semanal), te depositamos todo lo recaudado. Control claro de pagos en tu historial.',
    Icono: Banknote,
    badge: 'Gestión de pagos',
  },
]


const ComoFunciona = ({ id }: { id: string }) => {
  return (
    <section
      id={id}
      className="relative py-24 px-6 bg-[#f7f7f8] text-gray-800 overflow-hidden"
    >
      {/* Cigüeña decorativa */}
      <img
        src="/backgrounds/cigueña-blanca.png"
        alt=""
        className="absolute top-16 right-4 w-28 md:w-40 opacity-20 animate-float-x pointer-events-none select-none hidden md:block"
      />
      <img
        src="/backgrounds/cigueña-blanca.png"
        alt=""
        className="absolute bottom-20 left-6 w-24 md:w-32 opacity-15 animate-float-x pointer-events-none select-none hidden lg:block"
        style={{ animationDelay: '2.5s' }}
      />

      <div className="max-w-5xl mx-auto">
        <h2 className="text-3xl md:text-4xl font-extrabold text-center mb-4 text-[#004aad] tracking-tight">
          ¿Cómo funciona?
        </h2>
        <p className="text-center max-w-2xl mx-auto mb-4 text-gray-600 text-base md:text-lg">
          Un sistema completo con paneles para comercios, gestores y motorizados. Vos gestionás tus órdenes, nosotros nos encargamos del resto.
        </p>

        {/* Pill plataforma */}
        <div className="flex justify-center mb-14">
          <span className="inline-flex items-center gap-2 bg-[#004aad]/10 text-[#004aad] text-sm font-semibold px-4 py-2 rounded-full">
            <MonitorSmartphone className="w-4 h-4" />
            Con plataforma web de seguimiento en tiempo real
          </span>
        </div>

        <div className="flex flex-col gap-10">
          {pasos.map((paso, index) => {
            const { Icono } = paso
            const esImpar = index % 2 !== 0
            return (
              <div
                key={index}
                className={`flex flex-col md:flex-row items-center gap-6 md:gap-12 ${
                  esImpar ? 'md:flex-row-reverse' : ''
                }`}
              >
                {/* Ícono + número */}
                <div className="flex-shrink-0 flex flex-col items-center gap-2">
                  <div className="w-20 h-20 rounded-2xl bg-[#004aad] flex items-center justify-center shadow-lg">
                    <Icono className="w-9 h-9 text-white" strokeWidth={1.75} />
                  </div>
                  <span className="text-xs font-bold text-[#004aad]/40 tracking-widest uppercase">
                    Paso {index + 1}
                  </span>
                </div>

                {/* Tarjeta */}
                <div className="bg-white rounded-2xl shadow-md hover:shadow-xl transition-shadow duration-300 p-6 md:p-8 w-full">
                  <h3 className="text-xl md:text-2xl font-bold text-[#004aad] mb-3">
                    {paso.titulo}
                  </h3>
                  <p className="text-gray-600 text-sm md:text-base leading-relaxed">
                    {paso.descripcion}
                  </p>
                </div>
              </div>
            )
          })}
        </div>
      </div>
    </section>
  )
}

export default ComoFunciona
