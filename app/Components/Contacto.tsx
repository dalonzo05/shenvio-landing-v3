'use client'
import React, { useState } from 'react'

interface Props {
  id: string
}

const WA_NUMBER = '50589530626'
const WA_LINK = `https://wa.me/${WA_NUMBER}`
const EMAIL = 'hola@storkhub.com'

const Contacto: React.FC<Props> = ({ id }) => {
  const [nombre, setNombre] = useState('')
  const [telefono, setTelefono] = useState('')
  const [mensaje, setMensaje] = useState('')
  const [confirmacion, setConfirmacion] = useState(false)

  const enviarPorWhatsapp = () => {
    const texto = `Hola, soy ${nombre}. Mi contacto es ${telefono}. Esto quiero consultarte: ${mensaje}`
    const url = `${WA_LINK}?text=${encodeURIComponent(texto)}`
    window.open(url, '_blank')
    setConfirmacion(true)
    setTimeout(() => setConfirmacion(false), 3000)
  }

  return (
    <section id={id} className="bg-gray-50 py-24 px-6">
      <div className="max-w-6xl mx-auto flex flex-col md:flex-row items-start justify-center gap-12">

        {/* Columna izquierda: título + info directa + formulario */}
        <div className="w-full md:w-1/2">
          <div className="mb-8">
            <h2 className="text-3xl md:text-4xl font-extrabold text-[#004aad] mb-3 tracking-tight">
              ¿Querés afiliarte o consultar algo?
            </h2>
            <p className="text-gray-600 text-base md:text-lg">
              Escribinos directamente o completá el formulario y te respondemos en minutos.
            </p>
          </div>

          {/* Contacto directo */}
          <div className="flex flex-col sm:flex-row gap-4 mb-8">
            <a
              href={`${WA_LINK}?text=Hola%2C%20me%20gustaría%20afiliarme%20a%20StorkHub`}
              target="_blank"
              rel="noopener noreferrer"
              className="flex-1 flex items-center gap-3 bg-[#25D366] hover:bg-green-500 text-white font-semibold px-5 py-3.5 rounded-xl transition-colors duration-200 shadow-md"
            >
              <svg className="w-6 h-6 flex-shrink-0" fill="currentColor" viewBox="0 0 24 24" aria-hidden="true">
                <path d="M17.472 14.382c-.297-.149-1.758-.867-2.03-.967-.273-.099-.471-.148-.67.15-.197.297-.767.966-.94 1.164-.173.199-.347.223-.644.075-.297-.15-1.255-.463-2.39-1.475-.883-.788-1.48-1.761-1.653-2.059-.173-.297-.018-.458.13-.606.134-.133.298-.347.446-.52.149-.174.198-.298.298-.497.099-.198.05-.371-.025-.52-.075-.149-.669-1.612-.916-2.207-.242-.579-.487-.5-.669-.51-.173-.008-.371-.01-.57-.01-.198 0-.52.074-.792.372-.272.297-1.04 1.016-1.04 2.479 0 1.462 1.065 2.875 1.213 3.074.149.198 2.096 3.2 5.077 4.487.709.306 1.262.489 1.694.625.712.227 1.36.195 1.871.118.571-.085 1.758-.719 2.006-1.413.248-.694.248-1.289.173-1.413-.074-.124-.272-.198-.57-.347z"/>
                <path d="M12 0C5.373 0 0 5.373 0 12c0 2.125.558 4.122 1.528 5.856L0 24l6.335-1.508A11.954 11.954 0 0012 24c6.627 0 12-5.373 12-12S18.627 0 12 0zm0 21.818a9.818 9.818 0 01-5.003-1.368l-.36-.213-3.722.886.934-3.613-.234-.371A9.818 9.818 0 1112 21.818z"/>
              </svg>
              <span>+505 8953 0626</span>
            </a>
            <a
              href={`mailto:${EMAIL}`}
              className="flex-1 flex items-center gap-3 bg-white border border-gray-200 hover:border-[#004aad] text-gray-700 hover:text-[#004aad] font-semibold px-5 py-3.5 rounded-xl transition-colors duration-200 shadow-sm"
            >
              <svg className="w-5 h-5 flex-shrink-0" fill="none" stroke="currentColor" strokeWidth={1.75} viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" d="M3 8l7.89 5.26a2 2 0 002.22 0L21 8M5 19h14a2 2 0 002-2V7a2 2 0 00-2-2H5a2 2 0 00-2 2v10a2 2 0 002 2z" />
              </svg>
              <span>{EMAIL}</span>
            </a>
          </div>

          {/* Formulario */}
          <form
            onSubmit={(e) => {
              e.preventDefault()
              enviarPorWhatsapp()
            }}
            className="bg-white shadow-lg rounded-2xl p-6 space-y-5"
          >
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1">
                Tu nombre
              </label>
              <input
                type="text"
                placeholder="Ej. María García"
                value={nombre}
                onChange={(e) => setNombre(e.target.value)}
                className="w-full border border-gray-200 rounded-xl px-4 py-2.5 focus:outline-none focus:ring-2 focus:ring-[#004aad] transition text-sm"
                required
              />
            </div>

            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1">
                Teléfono o correo
              </label>
              <input
                type="text"
                placeholder="Ej. 8953-0626 o correo@mail.com"
                value={telefono}
                onChange={(e) => setTelefono(e.target.value)}
                className="w-full border border-gray-200 rounded-xl px-4 py-2.5 focus:outline-none focus:ring-2 focus:ring-[#004aad] transition text-sm"
                required
              />
            </div>

            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1">
                ¿En qué te podemos ayudar?
              </label>
              <textarea
                rows={4}
                placeholder="Contanos sobre tu negocio y qué necesitás..."
                value={mensaje}
                onChange={(e) => setMensaje(e.target.value)}
                className="w-full border border-gray-200 rounded-xl px-4 py-2.5 focus:outline-none focus:ring-2 focus:ring-[#004aad] transition text-sm resize-none"
                required
              />
            </div>

            <button
              type="submit"
              className="w-full bg-[#004aad] text-white py-3 rounded-xl hover:bg-blue-700 transition font-bold text-sm shadow-md"
            >
              Enviar por WhatsApp
            </button>

            {confirmacion && (
              <p className="text-center text-green-600 text-sm font-medium animate-pulse">
                Abriendo WhatsApp... te respondemos en minutos.
              </p>
            )}
          </form>
        </div>

        {/* Imagen decorativa (solo desktop) */}
        <div className="hidden md:flex justify-center items-center w-full md:w-1/2">
          <img
            src="/backgrounds/cigueña-contacto.png"
            alt="StorkHub"
            className="w-72 md:w-96 object-contain"
          />
        </div>

      </div>
    </section>
  )
}

export default Contacto
