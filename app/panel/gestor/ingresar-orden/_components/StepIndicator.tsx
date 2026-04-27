import React from 'react'

const PASOS = [
  { n: 1, label: 'Comercio', icon: '🏪' },
  { n: 2, label: 'Retiro', icon: '📦' },
  { n: 3, label: 'Entrega', icon: '🏠' },
  { n: 4, label: 'Pago', icon: '💰' },
  { n: 5, label: 'Confirmar', icon: '✅' },
]

export default function StepIndicator({
  paso,
  setPaso,
  puedeAvanzar,
}: {
  paso: number
  setPaso: (n: number) => void
  puedeAvanzar: (desde: number) => boolean
}) {
  const puedoIrA = (n: number): boolean => {
    if (n <= paso) return true
    for (let i = 1; i < n; i++) {
      if (!puedeAvanzar(i)) return false
    }
    return true
  }

  return (
    <div
      style={{
        display: 'flex',
        alignItems: 'center',
        gap: 0,
        padding: '14px 0 10px',
        overflowX: 'auto',
        scrollbarWidth: 'none',
      }}
    >
      {PASOS.map((p, idx) => {
        const activo = paso === p.n
        const completado = paso > p.n
        const accesible = puedoIrA(p.n)

        return (
          <React.Fragment key={p.n}>
            <button
              type="button"
              onClick={() => accesible && setPaso(p.n)}
              style={{
                display: 'flex',
                flexDirection: 'column',
                alignItems: 'center',
                gap: 5,
                cursor: accesible ? 'pointer' : 'default',
                background: 'none',
                border: 'none',
                padding: '0 8px',
                flexShrink: 0,
              }}
            >
              <div
                style={{
                  width: 34,
                  height: 34,
                  borderRadius: '50%',
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'center',
                  fontSize: completado ? 14 : 12,
                  fontWeight: 800,
                  background: activo ? '#004aad' : completado ? '#16a34a' : '#e5e7eb',
                  color: activo || completado ? '#fff' : '#9ca3af',
                  transition: 'all 0.2s',
                  boxShadow: activo ? '0 0 0 3px #bfdbfe' : 'none',
                }}
              >
                {completado ? '✓' : p.n}
              </div>
              <span
                style={{
                  fontSize: 11,
                  fontWeight: activo ? 700 : 500,
                  color: activo ? '#004aad' : completado ? '#16a34a' : '#9ca3af',
                  whiteSpace: 'nowrap',
                }}
              >
                {p.label}
              </span>
            </button>

            {idx < PASOS.length - 1 && (
              <div
                style={{
                  flex: 1,
                  height: 2,
                  background: paso > p.n ? '#16a34a' : '#e5e7eb',
                  minWidth: 16,
                  marginBottom: 18,
                  transition: 'background 0.2s',
                }}
              />
            )}
          </React.Fragment>
        )
      })}
    </div>
  )
}
