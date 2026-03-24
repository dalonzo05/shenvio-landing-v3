
'use client'
import { FaFacebookF, FaInstagram } from 'react-icons/fa'
export default function Footer() {
  return (
    <footer className="bg-gray-900 text-gray-200 text-sm mt-20">
      <div className="max-w-7xl mx-auto px-6 py-12 grid grid-cols-1 md:grid-cols-3 gap-8">
        {/* Encontranos */}
        <div>
          <h3 className="text-lg font-semibold mb-3">Encontranos en</h3>
          <div className="flex gap-4 text-xl">
            <a
              href="https://www.facebook.com/storkhubenvios"
              target="_blank"
              rel="noopener noreferrer"
              className="hover:text-white"
              aria-label="Facebook"
            >
              <FaFacebookF />
            </a>
            <a
              href="https://www.instagram.com/storkhub_nic"
              target="_blank"
              rel="noopener noreferrer"
              className="hover:text-white"
              aria-label="Instagram"
            >
              <FaInstagram />
            </a>
          </div>
        </div>
        {/* Contacto */}
        <div>
          <h3 className="text-lg font-semibold mb-3">Contáctanos</h3>
          <p>Lunes a Viernes de 8:30 AM a 5:00 PM</p>
          <p>Sábado 8:30 AM a 1:00 PM</p>
          <p className="mt-2">
            <a
              href="https://wa.me/50589530626"
              target="_blank"
              rel="noopener noreferrer"
              className="hover:text-white"
            >
              +505 8953 0626
            </a>
          </p>
          <p>hola@storkhub.com</p>
        </div>
        {/* Ubicación */}
        <div>
          <h3 className="text-lg font-semibold mb-3">Ubicación</h3>
          <p>Managua, Nicaragua</p>
          <p>Cobertura en toda la ciudad</p>
        </div>
      </div>
      {/* Línea inferior */}
      <div className="border-t border-gray-700 text-center py-4 text-xs text-gray-400">
        © 2025 SH Envíos. Todos los derechos reservados.
      </div>
    </footer>
  )
}
