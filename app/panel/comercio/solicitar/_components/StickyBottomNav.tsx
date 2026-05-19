'use client'
import { useEffect, useState } from 'react'

export default function StickyBottomNav({
  paso, puedeAvanzar, formularioCompleto, saving, loading, onAtras, onSiguiente, onGuardar,
}: {
  paso: number
  puedeAvanzar: boolean
  formularioCompleto: boolean
  saving: boolean
  loading?: boolean
  onAtras: () => void
  onSiguiente: () => void
  onGuardar: () => void
}) {
  const [isMobile, setIsMobile] = useState(false)

  useEffect(() => {
    const mq = window.matchMedia('(max-width: 767px)')
    setIsMobile(mq.matches)
    const h = (e: MediaQueryListEvent) => setIsMobile(e.matches)
    mq.addEventListener('change', h)
    return () => mq.removeEventListener('change', h)
  }, [])

  const esPasoFinal = paso === 4
  const canNext = esPasoFinal ? (formularioCompleto && !saving) : (puedeAvanzar && !loading)

  return (
    <div style={{
      position: 'fixed',
      bottom: isMobile ? 64 : 0,
      left: isMobile ? 0 : 'var(--sidebar-width, 250px)' as any,
      right: 0,
      zIndex: 100,
      background: 'rgba(255,255,255,0.97)',
      backdropFilter: 'blur(8px)',
      borderTop: '1px solid #e5e7eb',
      boxShadow: '0 -2px 8px rgba(0,0,0,0.05)',
      transition: 'left 300ms ease-in-out',
    }}>
      <div style={{
        maxWidth: 760, margin: '0 auto', padding: '10px 16px',
        display: 'flex', gap: 10, alignItems: 'center',
      }}>
        {paso > 1 && (
          <button
            type="button"
            onClick={onAtras}
            style={{
              padding: '11px 20px', borderRadius: 12,
              border: '1px solid #e5e7eb', background: '#fff',
              color: '#374151', fontSize: 14, fontWeight: 700,
              cursor: 'pointer', flexShrink: 0,
            }}
          >
            ← Atrás
          </button>
        )}
        <button
          type="button"
          onClick={esPasoFinal ? onGuardar : onSiguiente}
          disabled={!canNext}
          style={{
            flex: 1, padding: '11px 20px', borderRadius: 12, border: 'none',
            background: canNext ? '#004aad' : '#e5e7eb',
            color: canNext ? '#fff' : '#9ca3af',
            fontSize: 15, fontWeight: 800,
            cursor: canNext ? 'pointer' : 'not-allowed',
          }}
        >
          {esPasoFinal
            ? (saving ? 'Guardando...' : formularioCompleto ? '✓ Crear orden' : '⚠️ Completar info')
            : loading ? '⏳ Calculando...' : (puedeAvanzar ? 'Siguiente →' : '⚠️ Completá los datos')}
        </button>
      </div>
    </div>
  )
}
