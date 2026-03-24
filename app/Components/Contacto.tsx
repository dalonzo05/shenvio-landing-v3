'use client'
import React, { useState } from 'react'

interface Props {
  id: string
}

const Contacto: React.FC<Props> = ({ id }) => {
  const [nombre, setNombre] = useState('')
  const [telefono, setTelefono] = useState('')
  const [mensaje, setMensaje] = useState('')
  const [confirmacion, setConfirmacion] = useState(false)

  const enviarPorWhatsapp = () => {
    const texto = `Hola, soy ${nombre}. Mi contacto es ${telefono}. Esto quiero consultarte: ${mensaje}`
    const url = `https://wa.me/50589530626?text=${encodeURIComponent(texto)}`
    window.open(url, '_blank')
    setConfirmacion(true)
    setTimeout(() => setConfirmacion(false), 3000)
  }

  return (
    <section id={id} className="bg-gray-50 py-24 px-6">
      <div className="max-w-6xl mx-auto flex flex-col md:flex-row items-center justify-center gap-12">
        
        {/* Formulario */}
        <div className="w-full md:w-1/2">
          <div className="text-center md:text-left mb-8">
            <h2 className="text-3xl md:text-4xl font-extrabold text-[#004aad] mb-4 tracking-tight">
              ¿Querés afiliarte o hacer una consulta?
            </h2>
            <p className="text-gray-700 text-base md:text-lg">
              Escribinos directamente por WhatsApp o llená este formulario y te contactamos.
            </p>
          </div>

          <form
            onSubmit={(e) => {
              e.preventDefault()
              enviarPorWhatsapp()
            }}
            className="bg-white shadow-lg rounded-2xl p-6 space-y-6"
          >
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1">Nombre</label>
              <input
                type="text"
                placeholder="Tu nombre"
                value={nombre}
                onChange={(e) => setNombre(e.target.value)}
                className="w-full border border-gray-300 rounded-lg px-4 py-2 focus:outline-none focus:ring-2 focus:ring-[#004aad] transition"
                required
              />
            </div>

            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1">Teléfono o Correo</label>
              <input
                type="text"
                placeholder="ej. 8953-0626 o correo@mail.com"
                value={telefono}
                onChange={(e) => setTelefono(e.target.value)}
                className="w-full border border-gray-300 rounded-lg px-4 py-2 focus:outline-none focus:ring-2 focus:ring-[#004aad] transition"
                required
              />
            </div>

            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1">Mensaje</label>
              <textarea
                rows={4}
                placeholder="Contanos qué necesitás..."
                value={mensaje}
                onChange={(e) => setMensaje(e.target.value)}
                className="w-full border border-gray-300 rounded-lg px-4 py-2 focus:outline-none focus:ring-2 focus:ring-[#004aad] transition"
                required
              />
            </div>

            <button
              type="submit"
              className="w-full bg-[#004aad] text-white py-2 rounded-lg hover:bg-blue-700 transition font-semibold"
            >
              Enviar por WhatsApp
            </button>

            {confirmacion && (
              <p className="text-center text-green-600 mt-4 animate-pulse">
                📲 Abriendo WhatsApp...
              </p>
            )}
          </form>
        </div>

        {/* Imagen a la derecha (solo en desktop) */}
        <div className="hidden md:flex justify-center w-full md:w-1/2">
          <img
            src="/backgrounds/cigueña-contacto.png"
            alt="Cigüeñas"
            className="w-64 md:w-80 object-contain"
          />
        </div>
      </div>
    </section>
  )
}

export default Contacto
