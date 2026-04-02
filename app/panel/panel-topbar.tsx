'use client'

import Link from 'next/link'
import { usePathname } from 'next/navigation'
import { useEffect, useState } from 'react'
import { Fredoka } from 'next/font/google'
import { useUser } from '@/app/Components/UserProvider'

const fredoka = Fredoka({ subsets: ['latin'], weight: ['400', '700'] })

function initials(name?: string) {
  const s = (name || 'Usuario')
    .trim()
    .split(/\s+/)
    .map((p) => p[0]?.toUpperCase() || '')
  return (s[0] || 'U') + (s[1] || '')
}

export default function PanelTopBar() {
  const pathname = usePathname()
  const [open, setOpen] = useState(false)

  // ✅ ahora viene de nuestro provider nuevo
  const { profile, authUser, signOut } = useUser()

  const items: { href?: string; label: string; disabled?: boolean }[] = [
    { href: '/panel', label: 'Inicio' },
    { href: '/panel/calculadora', label: 'Calculadora' },
    { href: '/panel/solicitar', label: 'Solicitar envío' },
    { href: '/panel/ajustes', label: 'Ajustes' },
  ]

  // lock scroll al abrir menú
  useEffect(() => {
    if (!open) return
    const prev = document.body.style.overflow
    document.body.style.overflow = 'hidden'
    return () => {
      document.body.style.overflow = prev
    }
  }, [open])

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setOpen(false)
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])

  const displayName = profile?.name || 'Usuario'
  const displayEmail = profile?.email ?? authUser?.email ?? 'Cuenta activa'

  return (
    <header className="sticky top-0 z-50 bg-[#0a49a4] text-white shadow-md">
      <div className="mx-auto max-w-6xl h-14 px-4 flex items-center justify-between">
        {/* Logo */}
        <Link href="/panel" className={`text-white text-2xl font-bold tracking-wide ${fredoka.className}`}>
          STORKHUB
        </Link>

        {/* Desktop */}
        <nav className="hidden md:flex items-center gap-2 min-w-0">
          {items.map((it, i) => {
            if (it.disabled) {
              return (
                <span
                  key={i}
                  aria-disabled
                  className="px-3 py-1.5 rounded-full text-sm font-semibold text-white/60 bg-white/10 cursor-not-allowed select-none"
                  title="Próximamente"
                >
                  {it.label}
                </span>
              )
            }
            const active = pathname === it.href
            return (
              <Link
                key={it.href}
                href={it.href!}
                className={`px-3 py-1.5 rounded-full text-sm font-semibold transition
                  ${active ? 'bg-white text-[#0a49a4] shadow' : 'text-white hover:bg-white/10'}`}
              >
                {it.label}
              </Link>
            )
          })}

          {/* Chip usuario truncable */}
          <div className="ml-2 flex items-center gap-2 min-w-0">
            <span className="inline-flex items-center gap-2 px-2 py-1 rounded-full bg-white/10">
              <span className="grid place-items-center w-7 h-7 rounded-full bg-white/20 text-xs font-bold">
                {initials(profile?.name)}
              </span>
              <span className="max-w-[140px] truncate" title={displayName}>
                {displayName}
              </span>
            </span>
            <button
              onClick={signOut}
              className="ml-1 inline-flex items-center rounded-full bg-red-600 px-3 py-1.5 text-sm font-semibold hover:bg-red-700"
            >
              Cerrar sesión
            </button>
          </div>
        </nav>

        {/* Hamburguesa */}
        <button
          className="md:hidden inline-flex items-center justify-center w-10 h-10 rounded-full hover:bg-white/10 focus:outline-none focus-visible:ring-2 focus-visible:ring-white/60"
          aria-label="Abrir menú"
          onClick={() => setOpen(true)}
        >
          <svg width="22" height="22" viewBox="0 0 24 24" fill="none">
            <path d="M4 7h16M4 12h16M4 17h16" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
          </svg>
        </button>
      </div>

      {/* Overlay */}
      <div
        className={`md:hidden fixed inset-0 z-50 bg-black/40 backdrop-blur-sm transition-opacity
          ${open ? 'opacity-100 pointer-events-auto' : 'opacity-0 pointer-events-none'}`}
        onClick={() => setOpen(false)}
      />

      {/* Sheet */}
      <div
        className={`md:hidden fixed inset-x-0 top-0 z-[60] mx-3 mt-3 rounded-2xl bg-[#0a49a4] text-white shadow-2xl
          transition-transform duration-300 will-change-transform
          ${open ? 'translate-y-0' : '-translate-y-[120%]'}`}
        role="dialog"
        aria-modal="true"
      >
        <div className="flex items-center justify-between px-4 py-3">
          <Link
            href="/panel"
            onClick={() => setOpen(false)}
            className={`text-white text-2xl font-bold tracking-wide ${fredoka.className}`}
          >
            STORKHUB
          </Link>
          <button
            aria-label="Cerrar"
            onClick={() => setOpen(false)}
            className="w-10 h-10 grid place-items-center rounded-full hover:bg-white/10 focus:outline-none focus-visible:ring-2 focus-visible:ring-white/60"
          >
            <svg width="22" height="22" viewBox="0 0 24 24" fill="none">
              <path d="M6 6l12 12M18 6L6 18" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
            </svg>
          </button>
        </div>

        {/* Opciones */}
        <nav className="px-3 pb-3">
          <ul className="overflow-y-auto max-h-[70vh] divide-y divide-white/10 rounded-xl bg-white/5">
            {items.map((it, i) => {
              const active = it.href && pathname === it.href
              if (it.disabled) {
                return (
                  <li key={`d-${i}`}>
                    <span className="block px-4 py-3 text-base font-medium text-white/60">{it.label}</span>
                  </li>
                )
              }
              return (
                <li key={it.href}>
                  <Link
                    href={it.href!}
                    onClick={() => setOpen(false)}
                    className={`block px-4 py-3 text-base font-medium rounded-[inherit]
                      ${active ? 'bg-white text-[#0a49a4]' : 'hover:bg-white/10'}`}
                  >
                    {it.label}
                  </Link>
                </li>
              )
            })}
          </ul>

          {/* Usuario en el sheet */}
          <div className="mt-4 flex items-center gap-3 px-1">
            <span className="inline-grid place-items-center w-9 h-9 rounded-full bg-white/20 text-sm font-bold">
              {initials(profile?.name)}
            </span>
            <div className="flex-1 min-w-0">
              <div className="text-sm font-semibold truncate" title={displayName}>
                {displayName}
              </div>
              <div className="text-xs text-white/70 truncate" title={displayEmail}>
                {displayEmail}
              </div>
            </div>
          </div>

          <button
            onClick={signOut}
            className="mt-4 w-full rounded-xl bg-red-600 py-3 text-center text-base font-semibold hover:bg-red-700"
          >
            Cerrar sesión
          </button>
        </nav>
      </div>
    </header>
  )
}
