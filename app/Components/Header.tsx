'use client'
import React, { useEffect, useRef, useState } from 'react'
import Link from 'next/link'
import { usePathname } from 'next/navigation'
import { Fredoka } from 'next/font/google'
import { Menu, X, LogIn } from 'lucide-react'

const fredoka = Fredoka({
  subsets: ['latin'],
  weight: ['400', '700'],
})

const sections = ['inicio', 'servicios', 'como-funciona', 'contacto'] as const
type SectionId = typeof sections[number]

export default function Header() {
  const [activeSection, setActiveSection] = useState<SectionId>('inicio')
  const [menuOpen, setMenuOpen] = useState(false)
  const pathname = usePathname()
  const isHome = pathname === '/'
  const ticking = useRef(false)

  // Ocultar en /panel y /login
  const hideOnPanelOrLogin =
    pathname?.startsWith('/panel') || pathname === '/login'
  if (hideOnPanelOrLogin) return null

  // Detección de sección activa en scroll
  useEffect(() => {
    if (!isHome) return
    const HEADER_OFFSET = 100

    const computeActive = () => {
      let current: SectionId = 'inicio'
      let best = Number.POSITIVE_INFINITY

      sections.forEach((id) => {
        const el = document.getElementById(id)
        if (!el) return
        const rect = el.getBoundingClientRect()
        const dist = Math.abs(rect.top - HEADER_OFFSET)
        const isVisibleArea = rect.bottom > HEADER_OFFSET
        if (isVisibleArea && dist < best) {
          best = dist
          current = id
        }
      })

      setActiveSection(current)
      ticking.current = false
    }

    const onScroll = () => {
      if (!ticking.current) {
        ticking.current = true
        requestAnimationFrame(computeActive)
      }
    }

    window.addEventListener('scroll', onScroll, { passive: true })
    window.addEventListener('resize', onScroll)
    computeActive()
    return () => {
      window.removeEventListener('scroll', onScroll)
      window.removeEventListener('resize', onScroll)
    }
  }, [isHome])

  // Scroll suave SOLO en home
  const goTo = (e: React.MouseEvent, sectionId: SectionId) => {
    if (!isHome) return
    e.preventDefault()
    const target = document.getElementById(sectionId)
    if (target) target.scrollIntoView({ behavior: 'smooth' })
  }

  const labelFor = (id: SectionId) =>
    id === 'inicio'
      ? 'Inicio'
      : id === 'servicios'
      ? 'Servicios'
      : id === 'como-funciona'
      ? '¿Cómo funciona?'
      : 'Contacto'

  const itemClass = (id: SectionId) =>
    `relative transition-colors duration-300 hover:text-white ${
      isHome && activeSection === id ? 'text-[#ffd700] font-semibold' : 'text-white/70'
    }`

  return (
    <header className="w-full fixed top-0 z-50 bg-[#004aad] shadow-md">
      <nav className="max-w-7xl mx-auto px-6 py-4 flex justify-between items-center">
        {/* Logo */}
        <Link
          href="/"
          className={`text-white text-2xl font-bold tracking-wide ${fredoka.className}`}
          aria-label="Ir al inicio"
        >
          STORKHUB
        </Link>

        {/* Menú desktop */}
        <ul className="hidden md:flex space-x-6 text-white font-medium text-sm md:text-base items-center">
          {sections.map((section) => (
            <li key={section}>
              {isHome ? (
                <a
                  href={`#${section}`}
                  onClick={(e) => goTo(e, section)}
                  className={itemClass(section)}
                >
                  {labelFor(section)}
                  {isHome && activeSection === section && (
                    <span className="absolute left-0 -bottom-1 h-[2px] w-full bg-white rounded" />
                  )}
                </a>
              ) : (
                <Link href={`/#${section}`} className={itemClass(section)}>
                  {labelFor(section)}
                </Link>
              )}
            </li>
          ))}

          {/* Botón moderno: Iniciar sesión */}
          <li>
            <Link
              href="/login"
              className="group ml-2 inline-flex items-center gap-2 rounded-full bg-white px-4 py-2 text-[#004aad] font-semibold
                         shadow-sm ring-1 ring-white/20 transition will-change-transform
                         hover:-translate-y-[1px] hover:shadow-md
                         focus:outline-none focus-visible:ring-2 focus-visible:ring-white/70 active:translate-y-0"
            >
              <LogIn className="h-4 w-4 opacity-80 transition-transform group-hover:translate-x-0.5" />
              <span className="translate-y-[0.5px]">Iniciar sesión</span>
            </Link>
          </li>
        </ul>

        {/* Botón menú móvil */}
        <button
          className="md:hidden text-white"
          onClick={() => setMenuOpen((v) => !v)}
          aria-label={menuOpen ? 'Cerrar menú' : 'Abrir menú'}
        >
          {menuOpen ? <X size={28} /> : <Menu size={28} />}
        </button>
      </nav>

      {/* Menú móvil */}
      {menuOpen && (
        <ul className="md:hidden bg-[#004aad] px-6 pb-4 space-y-4 text-white font-medium text-base">
          {sections.map((section) => (
            <li key={section}>
              {isHome ? (
                <a
                  href={`#${section}`}
                  onClick={(e) => {
                    goTo(e, section)
                    setMenuOpen(false)
                  }}
                  className={itemClass(section)}
                >
                  {labelFor(section)}
                </a>
              ) : (
                <Link
                  href={`/#${section}`}
                  onClick={() => setMenuOpen(false)}
                  className={itemClass(section)}
                >
                  {labelFor(section)}
                </Link>
              )}
            </li>
          ))}

          {/* Botón moderno en móvil */}
          <li>
            <Link
              href="/login"
              onClick={() => setMenuOpen(false)}
              className="block rounded-full border border-white/25 bg-white text-[#004aad] font-semibold text-center
                         px-4 py-2 shadow-sm transition hover:shadow-md focus:outline-none focus-visible:ring-2 focus-visible:ring-white/70"
            >
              Iniciar sesión
            </Link>
          </li>
        </ul>
      )}
    </header>
  )
}
