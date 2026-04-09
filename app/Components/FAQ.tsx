'use client'
import React, { useState } from 'react'
import { ChevronDown } from 'lucide-react'

const faqs = [
  {
    pregunta: '¿Cuánto cuesta un envío?',
    respuesta:
      'El costo depende de la distancia entre el punto de retiro y el punto de entrega. Manejamos tarifas desde C$70 para distancias cortas. Podés cotizar directamente por WhatsApp o desde tu panel de comercio, que calcula el costo automáticamente según la ruta.',
  },
  {
    pregunta: '¿Cuánto tarda una entrega?',
    respuesta:
      'Todas las entregas se realizan a la inmediatez. El tiempo varía según la zona y la carga de trabajo del día. Siempre podés consultar el estado en tiempo real desde tu panel.',
  },
  {
    pregunta: '¿Qué pasa si el cliente no está en casa?',
    respuesta:
      'El motorizado intenta contactar al destinatario. Si no hay respuesta, se coordina con vos (el comercio) para decidir: reagendar la entrega, dejar el paquete con alguien de confianza, o retornar el producto. Todo queda registrado con evidencia.',
  },
  {
    pregunta: '¿Cómo funciona el cobro contra entrega?',
    respuesta:
      'El motorizado cobra el monto exacto al cliente final en el momento de la entrega. Ese dinero queda resguardado y se deposita al cierre del día.',
  },
  {
    pregunta: '¿Cómo puedo ver el estado de mis pedidos?',
    respuesta:
      'Tenés acceso a tu panel de comercio donde podés ver todas tus órdenes en tiempo real: pendiente, en camino o entregada. También podés consultar tu historial de envíos y pagos. Sin necesidad de llamar.',
  },
  {
    pregunta: '¿Necesito firmar un contrato?',
    respuesta:
      'No. No manejamos contratos mensuales ni compromisos de volumen mínimo. Podés usar el servicio cuando lo necesités y pagar únicamente por los envíos realizados.',
  },
]

export default function FAQ() {
  const [open, setOpen] = useState<number | null>(null)

  return (
    <section className="py-24 px-6 bg-white relative overflow-hidden">
      {/* Cigüeña decorativa */}
      <img
        src="/backgrounds/cigueña-blanca.png"
        alt=""
        className="absolute -bottom-4 right-8 w-40 md:w-52 opacity-10 pointer-events-none select-none"
      />

      <div className="max-w-3xl mx-auto relative z-10">
        <h2 className="text-3xl md:text-4xl font-extrabold text-center mb-4 text-[#004aad] tracking-tight">
          Preguntas frecuentes
        </h2>
        <p className="text-center text-gray-600 mb-12 text-base md:text-lg">
          Todo lo que necesitás saber antes de empezar.
        </p>

        <div className="flex flex-col divide-y divide-gray-100">
          {faqs.map((faq, i) => (
            <div key={i} className="py-1">
              <button
                onClick={() => setOpen(open === i ? null : i)}
                className="w-full flex items-center justify-between gap-4 py-5 text-left group"
              >
                <span className="font-semibold text-gray-900 text-base md:text-lg group-hover:text-[#004aad] transition-colors">
                  {faq.pregunta}
                </span>
                <ChevronDown
                  className={`w-5 h-5 text-[#004aad] flex-shrink-0 transition-transform duration-300 ${
                    open === i ? 'rotate-180' : ''
                  }`}
                />
              </button>

              <div
                className={`overflow-hidden transition-all duration-300 ease-in-out ${
                  open === i ? 'max-h-60 opacity-100 pb-5' : 'max-h-0 opacity-0'
                }`}
              >
                <p className="text-gray-600 text-sm md:text-base leading-relaxed">
                  {faq.respuesta}
                </p>
              </div>
            </div>
          ))}
        </div>
      </div>
    </section>
  )
}
