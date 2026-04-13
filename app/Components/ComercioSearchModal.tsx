'use client'

import React, { useEffect, useMemo, useRef, useState } from 'react'
import { Search, X, Store } from 'lucide-react'

export type ComercioModalItem = {
  uid: string
  nombre: string
  companyName?: string
  email?: string
  phone?: string
  address?: string
}

export default function ComercioSearchModal({
  open,
  onClose,
  onSelect,
  comercios,
}: {
  open: boolean
  onClose: () => void
  onSelect: (c: ComercioModalItem) => void
  comercios: ComercioModalItem[]
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
    if (!q) return comercios.slice(0, 30)
    return comercios.filter((c) =>
      (c.companyName || c.nombre).toLowerCase().includes(q) ||
      (c.email || '').toLowerCase().includes(q) ||
      (c.phone || '').includes(q) ||
      (c.address || '').toLowerCase().includes(q)
    ).slice(0, 30)
  }, [query, comercios])

  if (!open) return null

  const displayName = (c: ComercioModalItem) => c.companyName || c.nombre || '—'

  return (
    <div
      style={{
        position: 'fixed', inset: 0, zIndex: 200,
        background: 'rgba(15,23,42,0.5)',
        display: 'flex', alignItems: 'flex-start', justifyContent: 'center',
        paddingTop: '8vh', paddingLeft: 16, paddingRight: 16,
      }}
      onClick={(e) => { if (e.target === e.currentTarget) onClose() }}
    >
      <div style={{
        width: '100%', maxWidth: 620, background: '#fff', borderRadius: 18,
        boxShadow: '0 24px 64px rgba(0,0,0,0.20)', display: 'flex', flexDirection: 'column',
        overflow: 'hidden', maxHeight: '80vh', border: '1px solid #e5e7eb',
      }}>

        {/* Buscador */}
        <div style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '12px 16px', borderBottom: '1px solid #e5e7eb' }}>
          <Search size={18} color="#9ca3af" style={{ flexShrink: 0 }} />
          <input
            ref={inputRef}
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder={`Buscar entre ${comercios.length} comercio${comercios.length !== 1 ? 's' : ''}…`}
            style={{
              flex: 1, border: 'none', outline: 'none', fontSize: 15,
              background: 'transparent', color: '#111827',
            }}
          />
          <button
            onClick={onClose}
            style={{ width: 30, height: 30, borderRadius: 8, border: '1px solid #e5e7eb', background: '#f9fafb', cursor: 'pointer', display: 'flex', alignItems: 'center', justifyContent: 'center' }}
          >
            <X size={14} color="#6b7280" />
          </button>
        </div>

        {/* Resultados */}
        <div style={{ flex: 1, overflowY: 'auto' }}>
          {filtered.length === 0 ? (
            <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', padding: '48px 16px', color: '#9ca3af' }}>
              <Store size={40} style={{ opacity: 0.3, marginBottom: 12 }} />
              <p style={{ fontSize: 14, fontWeight: 600, margin: 0 }}>
                {query ? `Sin resultados para "${query}"` : 'No hay comercios cargados'}
              </p>
            </div>
          ) : (
            filtered.map((c) => (
              <button
                key={c.uid}
                type="button"
                onClick={() => { onSelect(c); onClose() }}
                style={{
                  width: '100%', textAlign: 'left', padding: '10px 16px', display: 'flex',
                  alignItems: 'center', gap: 12, borderBottom: '1px solid #f3f4f6',
                  background: '#fff', border: 'none', cursor: 'pointer', transition: 'background 0.1s',
                }}
                onMouseEnter={(e) => (e.currentTarget.style.background = '#f9fafb')}
                onMouseLeave={(e) => (e.currentTarget.style.background = '#fff')}
              >
                {/* Avatar inicial */}
                <div style={{
                  width: 36, height: 36, borderRadius: 10, flexShrink: 0,
                  background: '#eff6ff', display: 'flex', alignItems: 'center', justifyContent: 'center',
                  fontWeight: 800, fontSize: 14, color: '#004aad',
                }}>
                  {(displayName(c))[0].toUpperCase()}
                </div>

                {/* Info */}
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
                    <span style={{ fontWeight: 700, color: '#111827', fontSize: 14 }}>{displayName(c)}</span>
                    {c.phone && (
                      <span style={{ color: '#6b7280', fontSize: 12 }}>📞 {c.phone}</span>
                    )}
                  </div>
                  <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap', marginTop: 2 }}>
                    {c.email && (
                      <span style={{ fontSize: 11, color: '#9ca3af', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                        ✉️ {c.email}
                      </span>
                    )}
                    {c.address && (
                      <span style={{ fontSize: 11, color: '#9ca3af', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                        📍 {c.address}
                      </span>
                    )}
                  </div>
                </div>

                {/* Flecha */}
                <span style={{ color: '#d1d5db', fontSize: 16, flexShrink: 0 }}>›</span>
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
