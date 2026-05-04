'use client'
import React, { useEffect, useMemo, useRef, useState } from 'react'
import { Search, X, MapPin } from 'lucide-react'
import type { PuntoComercio } from './types'

// ─── Modal ────────────────────────────────────────────────────────────────────

function PuntosModal({
  open,
  onClose,
  puntos,
  onSelect,
}: {
  open: boolean
  onClose: () => void
  puntos: PuntoComercio[]
  onSelect: (p: PuntoComercio) => void
}) {
  const [query, setQuery] = useState('')
  const inputRef = useRef<HTMLInputElement>(null)

  useEffect(() => {
    if (open) {
      setQuery('')
      const t = setTimeout(() => inputRef.current?.focus(), 60)
      return () => clearTimeout(t)
    }
  }, [open])

  useEffect(() => {
    const h = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose() }
    document.addEventListener('keydown', h)
    return () => document.removeEventListener('keydown', h)
  }, [onClose])

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase()
    if (!q) return puntos.slice(0, 40)
    return puntos.filter(p =>
      p.comercioNombre.toLowerCase().includes(q) ||
      p.puntoNombre.toLowerCase().includes(q) ||
      p.direccion.toLowerCase().includes(q) ||
      (p.zonaRetiro || '').toLowerCase().includes(q)
    ).slice(0, 40)
  }, [query, puntos])

  if (!open) return null

  return (
    <div
      style={{
        position: 'fixed', inset: 0, zIndex: 300,
        background: 'rgba(15,23,42,0.5)',
        display: 'flex', alignItems: 'flex-start', justifyContent: 'center',
        paddingTop: '8vh', paddingLeft: 16, paddingRight: 16,
      }}
      onClick={e => { if (e.target === e.currentTarget) onClose() }}
    >
      <div style={{
        width: '100%', maxWidth: 640, background: '#fff', borderRadius: 18,
        boxShadow: '0 24px 64px rgba(0,0,0,0.20)', display: 'flex', flexDirection: 'column',
        overflow: 'hidden', maxHeight: '80vh', border: '1px solid #e5e7eb',
      }}>

        {/* Header buscador */}
        <div style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '12px 16px', borderBottom: '1px solid #e5e7eb' }}>
          <Search size={18} color="#9ca3af" style={{ flexShrink: 0 }} />
          <input
            ref={inputRef}
            value={query}
            onChange={e => setQuery(e.target.value)}
            placeholder={`Buscar entre ${puntos.length} punto${puntos.length !== 1 ? 's' : ''} de retiro…`}
            style={{ flex: 1, border: 'none', outline: 'none', fontSize: 15, background: 'transparent', color: '#111827' }}
          />
          <button
            onClick={onClose}
            style={{ width: 30, height: 30, borderRadius: 8, border: '1px solid #e5e7eb', background: '#f9fafb', cursor: 'pointer', display: 'flex', alignItems: 'center', justifyContent: 'center' }}
          >
            <X size={14} color="#6b7280" />
          </button>
        </div>

        {/* Lista */}
        <div style={{ flex: 1, overflowY: 'auto' }}>
          {filtered.length === 0 ? (
            <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', padding: '48px 16px', color: '#9ca3af' }}>
              <MapPin size={40} style={{ opacity: 0.3, marginBottom: 12 }} />
              <p style={{ fontSize: 14, fontWeight: 600, margin: 0 }}>
                {query ? `Sin resultados para "${query}"` : 'No hay puntos de retiro registrados'}
              </p>
            </div>
          ) : (
            filtered.map(p => (
              <button
                key={`${p.comercioUid}-${p.puntoKey}`}
                type="button"
                onClick={() => { onSelect(p); onClose() }}
                style={{
                  width: '100%', textAlign: 'left', padding: '10px 16px',
                  display: 'flex', alignItems: 'center', gap: 12,
                  borderBottom: '1px solid #f3f4f6', background: '#fff',
                  border: 'none', borderTop: 'none', cursor: 'pointer',
                }}
                onMouseEnter={e => (e.currentTarget.style.background = '#f0f7ff')}
                onMouseLeave={e => (e.currentTarget.style.background = '#fff')}
              >
                {/* Avatar inicial */}
                <div style={{
                  width: 36, height: 36, borderRadius: 10, flexShrink: 0,
                  background: '#eff6ff', display: 'flex', alignItems: 'center', justifyContent: 'center',
                  fontWeight: 800, fontSize: 14, color: '#004aad',
                }}>
                  {p.comercioNombre[0]?.toUpperCase() || '?'}
                </div>

                {/* Info */}
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
                    <span style={{ fontWeight: 700, color: '#111827', fontSize: 14 }}>{p.comercioNombre}</span>
                    {p.puntoNombre && p.puntoNombre !== p.comercioNombre && (
                      <span style={{ color: '#6b7280', fontSize: 12 }}>› {p.puntoNombre}</span>
                    )}
                    {p.zonaRetiro && (
                      <span style={{ fontSize: 11, fontWeight: 700, color: '#004aad', background: '#eff6ff', borderRadius: 6, padding: '1px 7px' }}>
                        {p.zonaRetiro}
                      </span>
                    )}
                  </div>
                  {p.direccion && (
                    <div style={{ fontSize: 12, color: '#6b7280', marginTop: 2, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                      📍 {p.direccion}
                    </div>
                  )}
                </div>

                <span style={{ color: '#d1d5db', fontSize: 18, flexShrink: 0 }}>›</span>
              </button>
            ))
          )}
        </div>

        {/* Footer */}
        <div style={{
          padding: '8px 16px', borderTop: '1px solid #f3f4f6',
          background: '#fafafa', fontSize: 11, color: '#9ca3af', textAlign: 'center',
        }}>
          {filtered.length} resultado{filtered.length !== 1 ? 's' : ''} · Esc para cerrar
        </div>
      </div>
    </div>
  )
}

// ─── Input + botón ────────────────────────────────────────────────────────────

export function BuscadorComercio({
  puntos,
  loading,
  onSelect,
}: {
  puntos: PuntoComercio[]
  loading: boolean
  onSelect: (p: PuntoComercio) => void
}) {
  const [query, setQuery] = useState('')
  const [open, setOpen] = useState(false)
  const [modalOpen, setModalOpen] = useState(false)
  const wrapRef = useRef<HTMLDivElement>(null)
  const inputRef = useRef<HTMLInputElement>(null)

  const q = query.trim().toLowerCase()
  const resultados = !q
    ? []
    : puntos
        .filter(p =>
          p.comercioNombre.toLowerCase().includes(q) ||
          p.puntoNombre.toLowerCase().includes(q) ||
          p.direccion.toLowerCase().includes(q)
        )
        .slice(0, 8)

  useEffect(() => {
    const h = (e: MouseEvent) => {
      if (wrapRef.current && !wrapRef.current.contains(e.target as Node)) {
        setOpen(false)
      }
    }
    document.addEventListener('mousedown', h)
    return () => document.removeEventListener('mousedown', h)
  }, [])

  const handleSelect = (p: PuntoComercio) => {
    onSelect(p)
    setQuery('')
    setOpen(false)
  }

  return (
    <>
      <div ref={wrapRef} className="relative mb-4">
        <label className="block text-[11px] font-bold text-gray-500 uppercase tracking-wide mb-1.5">
          Buscar dirección de comercio
        </label>

        <div className="flex gap-2">
          {/* Input autocomplete */}
          <div className="relative flex-1">
            <span className="absolute left-3 top-1/2 -translate-y-1/2 text-gray-400 pointer-events-none">
              <Search size={15} />
            </span>
            <input
              ref={inputRef}
              type="text"
              value={query}
              onChange={e => { setQuery(e.target.value); setOpen(true) }}
              onFocus={() => { if (query) setOpen(true) }}
              placeholder={loading ? 'Cargando comercios…' : 'Nombre del comercio o dirección…'}
              disabled={loading}
              className="w-full pl-9 pr-8 py-2.5 rounded-xl border border-gray-200 bg-white text-sm text-gray-800 placeholder-gray-400 outline-none focus:ring-2 focus:ring-blue-300 focus:border-blue-400 transition disabled:opacity-50"
            />
            {query && (
              <button
                type="button"
                onMouseDown={e => { e.preventDefault(); setQuery(''); setOpen(false); inputRef.current?.focus() }}
                className="absolute right-2.5 top-1/2 -translate-y-1/2 text-gray-400 hover:text-gray-600 text-lg leading-none"
              >
                ×
              </button>
            )}
          </div>

          {/* Botón abrir modal */}
          <button
            type="button"
            onClick={() => setModalOpen(true)}
            disabled={loading}
            className="flex items-center gap-1.5 px-3.5 py-2.5 rounded-xl border border-gray-200 bg-white text-sm font-semibold text-gray-600 hover:bg-gray-50 hover:border-gray-300 transition disabled:opacity-50 shrink-0 cursor-pointer"
            title="Ver todos los puntos de retiro"
          >
            <MapPin size={15} className="text-[#004aad]" />
            <span className="hidden sm:inline">Ver todos</span>
          </button>
        </div>

        {/* Dropdown del autocomplete */}
        {open && query && (
          <div className="absolute left-0 right-0 top-full mt-1 bg-white border border-gray-200 rounded-xl shadow-lg z-50 overflow-hidden">
            {resultados.length === 0 ? (
              <div className="px-4 py-3 text-[13px] text-gray-400">
                Sin resultados para "<span className="font-semibold text-gray-600">{query}</span>"
              </div>
            ) : (
              <ul className="max-h-64 overflow-y-auto divide-y divide-gray-50">
                {resultados.map(p => (
                  <li key={`${p.comercioUid}-${p.puntoKey}`}>
                    <button
                      type="button"
                      onMouseDown={e => { e.preventDefault(); handleSelect(p) }}
                      className="w-full text-left px-4 py-2.5 hover:bg-blue-50 transition-colors"
                    >
                      <div className="text-[13px] font-semibold text-gray-800 truncate">
                        {p.comercioNombre}
                        {p.puntoNombre && p.puntoNombre !== p.comercioNombre && (
                          <span className="text-gray-400 font-normal"> › {p.puntoNombre}</span>
                        )}
                      </div>
                      <div className="text-[11px] text-gray-500 truncate mt-0.5 flex items-center gap-1.5">
                        <span>{p.direccion || 'Sin dirección escrita'}</span>
                        {p.zonaRetiro && (
                          <span className="inline-flex items-center px-1.5 py-0.5 rounded bg-blue-50 text-blue-600 font-semibold text-[10px]">
                            {p.zonaRetiro}
                          </span>
                        )}
                      </div>
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </div>
        )}
      </div>

      {/* Modal con toda la lista */}
      <PuntosModal
        open={modalOpen}
        onClose={() => setModalOpen(false)}
        puntos={puntos}
        onSelect={p => { handleSelect(p); setModalOpen(false) }}
      />
    </>
  )
}
