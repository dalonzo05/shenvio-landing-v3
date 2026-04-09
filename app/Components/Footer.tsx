'use client'
import { FaFacebookF, FaInstagram } from 'react-icons/fa'
import { Fredoka } from 'next/font/google'

const fredoka = Fredoka({ subsets: ['latin'], weight: ['700'] })

const navLinks = [
  { label: 'Inicio', href: '#inicio' },
  { label: 'Servicios', href: '#servicios' },
  { label: '¿Cómo funciona?', href: '#como-funciona' },
  { label: 'Contacto', href: '#contacto' },
]

export default function Footer() {
  return (
    <footer className="bg-gray-900 text-gray-300 text-sm">
      <div className="max-w-7xl mx-auto px-6 py-14">

        {/* Logo + tagline */}
        <div className="mb-10 text-center md:text-left">
          <span className={`text-white text-2xl font-bold tracking-wide ${fredoka.className}`}>
            STORKHUB
          </span>
          <p className="text-gray-400 text-sm mt-1">Tu aliado logístico en Nicaragua</p>
        </div>

        <div className="grid grid-cols-1 md:grid-cols-4 gap-10">

          {/* Redes sociales */}
          <div>
            <h3 className="text-white font-semibold mb-4">Seguinos en</h3>
            <div className="flex flex-col gap-3">
              <a
                href="https://www.facebook.com/storkhubenvios"
                target="_blank"
                rel="noopener noreferrer"
                className="flex items-center gap-2.5 hover:text-white transition-colors"
                aria-label="Facebook"
              >
                <FaFacebookF className="text-base" />
                <span>storkhubenvios</span>
              </a>
              <a
                href="https://www.instagram.com/storkhub_nic"
                target="_blank"
                rel="noopener noreferrer"
                className="flex items-center gap-2.5 hover:text-white transition-colors"
                aria-label="Instagram"
              >
                <FaInstagram className="text-base" />
                <span>@storkhub_nic</span>
              </a>
            </div>
          </div>

          {/* Contacto */}
          <div>
            <h3 className="text-white font-semibold mb-4">Contáctanos</h3>
            <div className="space-y-2">
              <p>Lun–Vie: 8:30 AM – 5:00 PM</p>
              <p>Sábado: 8:30 AM – 1:00 PM</p>
              <a
                href="https://wa.me/50589530626"
                target="_blank"
                rel="noopener noreferrer"
                className="block mt-3 hover:text-white transition-colors"
              >
                +505 8953 0626
              </a>
              <a
                href="mailto:hola@storkhub.com"
                className="block hover:text-white transition-colors"
              >
                hola@storkhub.com
              </a>
            </div>
          </div>

          {/* Ubicación */}
          <div>
            <h3 className="text-white font-semibold mb-4">Cobertura</h3>
            <div className="space-y-1">
              <p>Managua, Nicaragua</p>
              <p>Tipitapa · Ticuantepe</p>
              <p>Ciudad Sandino y más</p>
            </div>
          </div>

          {/* Navegación rápida */}
          <div>
            <h3 className="text-white font-semibold mb-4">Navegación</h3>
            <ul className="space-y-2">
              {navLinks.map((link) => (
                <li key={link.label}>
                  <a
                    href={link.href}
                    className="hover:text-white transition-colors"
                  >
                    {link.label}
                  </a>
                </li>
              ))}
            </ul>
          </div>

        </div>
      </div>

      {/* Línea inferior */}
      <div className="border-t border-gray-800 text-center py-5 text-xs text-gray-500">
        © 2026 StorkHub. Todos los derechos reservados.
      </div>
    </footer>
  )
}
