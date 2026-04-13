'use client'

import React, { useEffect, useMemo, useRef, useState } from 'react'
import { Search, X, Users } from 'lucide-react'

export type ClienteModalItem = {
  id: string
  nombre: string
  celular: string
  direccion?: string
  comercioUid?: string
  totalViajes?: number
  coord?: { lat: number; lng: number }
  tipoUbicacion?: string
  nota?: string
}

export type ComercioRef = {
  uid: string
  nombre?: string
  companyName?: string
}

export default function ClienteSearchModal({
  open,
  onClose,
  onSelect,
  clientes,
  comercioUidActual,
  comercios = [],
}: {
  open: boolean
  onClose: () => void
  onSelect: (c: ClienteModalItem) => void
  clientes: ClienteModalItem[]
  comercioUidActual?: string
  comercios?: ComercioRef[]
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

  const comercioName = useMemo(() => {
    const c = comercios.find(c => c.uid === comercioUidActual)
    return c?.companyName || c?.nombre || 'este comercio'
  }, [comercios, comercioUidActual])

  const getOtroComercioLabel = (uid?: string) => {
    if (!uid) return null
    const c = comercios.find(c => c.uid === uid)
    return c?.companyName || c?.nombre || null
  }

  const { propios, otros } = useMemo(() => {
    const q = query.trim().toLowerCase()
    const matches = (c: ClienteModalItem) =>
      !q ||
      c.nombre.toLowerCase().includes(q) ||
      c.celular.includes(q) ||
      (c.direccion || '').toLowerCase().includes(q)

    const all = clientes.filter(matches)
    const propios = all.filter(c => comercioUidActual && c.comercioUid === comercioUidActual).slice(0, 20)
    const otros = all.filter(c => !comercioUidActual || c.comercioUid !== comercioUidActual).slice(0, 15)
    return { propios, otros }
  }, [query, clientes, comercioUidActual])

  if (!open) return null

  const total = propios.length + otros.length

  const renderRow = (c: ClienteModalItem, showOrigen = false) => (
    <button
      key={c.id}
      type="button"
      onClick={() => { onSelect(c); onClose() }}
      style={{
        width: '100%', textAlign: 'left', padding: '10px 16px', display: 'flex',
        alignItems: 'center', gap: 12, borderBottom: '1px solid #f3f4f6',
        background: '#fff', border: 'none', cursor: 'pointer', transition: 'background 0.1s',
      }}
      onMouseEnter={e => (e.currentTarget.style.background = '#f9fafb')}
      onMouseLeave={e => (e.currentTarget.style.background = '#fff')}
    >
      {/* Avatar inicial */}
      <div style={{
        width: 36, height: 36, borderRadius: '50%', flexShrink: 0,
        background: '#eff6ff', display: 'flex', alignItems: 'center', justifyContent: 'center',
        fontWeight: 800, fontSize: 14, color: '#004aad',
      }}>
        {(c.nombre || '?')[0].toUpperCase()}
      </div>

      {/* Info principal */}
      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 6, flexWrap: 'wrap' }}>
          <span style={{ fontWeight: 700, color: '#111827', fontSize: 14 }}>{c.nombre || '—'}</span>
          <span style={{ color: '#6b7280', fontSize: 12 }}>{c.celular}</span>
          {showOrigen && c.comercioUid && (
            <span style={{
              fontSize: 10, fontWeight: 700, padding: '1px 6px', borderRadius: 4,
              background: '#f5f3ff', color: '#7c3aed', border: '1px solid #e9d5ff',
            }}>
              📦 {getOtroComercioLabel(c.comercioUid) || 'Otro comercio'}
            </span>
          )}
          {showOrigen && !c.comercioUid && (
            <span style={{
              fontSize: 10, fontWeight: 700, padding: '1px 6px', borderRadius: 4,
              background: '#f0fdf4', color: '#16a34a', border: '1px solid #bbf7d0',
            }}>🌐 global</span>
          )}
        </div>
        {c.direccion && (
          <p style={{ fontSize: 11, color: '#9ca3af', margin: '2px 0 0', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
            📍 {c.direccion}
          </p>
        )}
      </div>

      {/* Contador de viajes */}
      <div style={{ flexShrink: 0, textAlign: 'center', minWidth: 44 }}>
        {c.totalViajes != null && c.totalViajes > 0 ? (
          <>
            <div style={{ fontSize: 18, fontWeight: 900, color: '#004aad', lineHeight: 1 }}>{c.totalViajes}</div>
            <div style={{ fontSize: 9, color: '#9ca3af', fontWeight: 600, textTransform: 'uppercase', letterSpacing: '0.05em' }}>viajes</div>
          </>
        ) : (
          <div style={{ fontSize: 11, color: '#d1d5db' }}>—</div>
        )}
      </div>
    </button>
  )

  return (
    <div
      style={{
        position: 'fixed', inset: 0, zIndex: 200,
        background: 'rgba(15,23,42,0.5)',
        display: 'flex', alignItems: 'flex-start', justifyContent: 'center',
        paddingTop: '8vh', paddingLeft: 16, paddingRight: 16,
      }}
      onClick={e => { if (e.target === e.currentTarget) onClose() }}
    >
      <div style={{
        width: '100%', maxWidth: 680, background: '#fff', borderRadius: 18,
        boxShadow: '0 24px 64px rgba(0,0,0,0.20)', display: 'flex', flexDirection: 'column',
        overflow: 'hidden', maxHeight: '80vh', border: '1px solid #e5e7eb',
      }}>

        {/* Buscador */}
        <div style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '12px 16px', borderBottom: '1px solid #e5e7eb' }}>
          <Search size={18} color="#9ca3af" style={{ flexShrink: 0 }} />
          <input
            ref={inputRef}
            value={query}
            onChange={e => setQuery(e.target.value)}
            placeholder={`Buscar entre ${clientes.length} cliente${clientes.length !== 1 ? 's' : ''}…`}
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
          {total === 0 ? (
            <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', padding: '48px 16px', color: '#9ca3af' }}>
              <Users size={40} style={{ opacity: 0.3, marginBottom: 12 }} />
              <p style={{ fontSize: 14, fontWeight: 600, margin: 0 }}>
                {query ? `Sin resultados para "${query}"` : 'No hay clientes guardados'}
              </p>
            </div>
          ) : (
            <>
              {propios.length > 0 && (
                <div>
                  <div style={{
                    padding: '6px 16px', fontSize: 11, fontWeight: 700, color: '#004aad',
                    textTransform: 'uppercase', letterSpacing: '0.06em',
                    background: '#eff6ff', borderBottom: '1px solid #dbeafe',
                  }}>
                    🏪 Del comercio · {comercioName}
                  </div>
                  {propios.map(c => renderRow(c, false))}
                </div>
              )}

              {otros.length > 0 && (
                <div>
                  <div style={{
                    padding: '6px 16px', fontSize: 11, fontWeight: 700, color: '#6b7280',
                    textTransform: 'uppercase', letterSpacing: '0.06em',
                    background: '#f9fafb', borderBottom: '1px solid #f3f4f6',
                  }}>
                    👥 Otros clientes
                  </div>
                  {otros.map(c => renderRow(c, true))}
                </div>
              )}
            </>
          )}
        </div>

        {/* Footer */}
        <div style={{
          padding: '8px 16px', borderTop: '1px solid #f3f4f6',
          background: '#fafafa', fontSize: 11, color: '#9ca3af', textAlign: 'center',
        }}>
          {total} resultado{total !== 1 ? 's' : ''} · Esc para cerrar
        </div>
      </div>
    </div>
  )
}
