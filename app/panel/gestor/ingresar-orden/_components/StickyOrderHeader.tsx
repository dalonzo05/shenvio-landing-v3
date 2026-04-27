'use client'

function Pill({ label, value, color }: { label: string; value: string | null | undefined; color?: string }) {
  const hasValue = !!value
  return (
    <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'flex-start', minWidth: 0 }}>
      <span style={{ fontSize: 10, color: '#9ca3af', fontWeight: 600, textTransform: 'uppercase' as const, letterSpacing: 0.4, whiteSpace: 'nowrap' as const }}>
        {label}
      </span>
      <span
        style={{
          fontSize: 13,
          fontWeight: 700,
          color: hasValue ? (color || '#111827') : '#cbd5e1',
          whiteSpace: 'nowrap' as const,
          maxWidth: 150,
          overflow: 'hidden',
          textOverflow: 'ellipsis',
        }}
        title={value || undefined}
      >
        {hasValue ? value : '—'}
      </span>
    </div>
  )
}

function Divider() {
  return <div style={{ width: 1, height: 32, background: '#e5e7eb', flexShrink: 0 }} />
}

export default function StickyOrderHeader({
  precio,
  distanciaKm,
  zonaRetiro,
  zonaEntrega,
  comercioNombre,
  camposFaltantes,
  formularioCompleto,
}: {
  precio: number | null | undefined
  distanciaKm: number | null | undefined
  zonaRetiro: string | null | undefined
  zonaEntrega: string | null | undefined
  comercioNombre: string | null | undefined
  camposFaltantes: number
  formularioCompleto: boolean
}) {
  const precioLabel = precio
    ? precio === -1 ? 'Consultar' : `C$ ${precio}`
    : null

  return (
    <div
      style={{
        position: 'fixed',
        top: 0,
        // Lee la variable CSS que el GestorLayout escribe según collapsed
        left: 'var(--sidebar-width, 250px)',
        right: 0,
        zIndex: 50,
        background: 'rgba(255,255,255,0.97)',
        backdropFilter: 'blur(8px)',
        borderBottom: '1px solid #e5e7eb',
        boxShadow: '0 2px 8px rgba(0,0,0,0.05)',
        // Transición sincronizada con la animación del sidebar (300ms)
        transition: 'left 300ms ease-in-out',
      }}
    >
      <div
        style={{
          maxWidth: 760,
          margin: '0 auto',
          padding: '8px 16px',
          display: 'flex',
          alignItems: 'center',
          gap: 12,
          overflowX: 'auto' as const,
          scrollbarWidth: 'none' as const,
        }}
      >
        <Pill label="Comercio" value={comercioNombre} color="#111827" />
        <Divider />
        <Pill label="Precio" value={precioLabel} color="#004aad" />
        <Pill label="Distancia" value={distanciaKm ? `${distanciaKm.toFixed(1)} km` : null} color="#374151" />
        <Divider />
        <Pill label="Ret. zona" value={zonaRetiro} color="#374151" />
        <Pill label="Ent. zona" value={zonaEntrega} color="#374151" />
        <div style={{ marginLeft: 'auto', flexShrink: 0 }}>
          <span
            style={{
              display: 'inline-flex',
              alignItems: 'center',
              gap: 5,
              fontSize: 11,
              fontWeight: 700,
              padding: '4px 10px',
              borderRadius: 20,
              background: formularioCompleto ? '#f0fdf4' : '#fffbe6',
              color: formularioCompleto ? '#16a34a' : '#d46b08',
              border: `1px solid ${formularioCompleto ? '#bbf7d0' : '#ffe58f'}`,
              whiteSpace: 'nowrap' as const,
            }}
          >
            <span style={{ width: 6, height: 6, borderRadius: '50%', background: formularioCompleto ? '#16a34a' : '#f59e0b', display: 'inline-block', flexShrink: 0 }} />
            {formularioCompleto ? 'Lista' : camposFaltantes === 1 ? '1 pendiente' : `${camposFaltantes} pendientes`}
          </span>
        </div>
      </div>
    </div>
  )
}
