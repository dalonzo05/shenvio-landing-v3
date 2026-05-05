'use client'

/**
 * StaleCalcWarning — tarjeta ámbar que se muestra cuando el usuario
 * modificó el punto de retiro o entrega después de haber cargado
 * una cotización previa (draft desde calculadora).
 *
 * Uso:
 *   <StaleCalcWarning
 *     retiroStale={draftRetiroStale}
 *     entregaStale={draftEntregaStale}
 *     precioAnterior={precioSugerido}
 *     distanciaAnteriorKm={draft?.distanciaKm}
 *   />
 */

type Props = {
  retiroStale: boolean
  entregaStale: boolean
  precioAnterior?: number | null
  distanciaAnteriorKm?: number | null
}

export default function StaleCalcWarning({ retiroStale, entregaStale, precioAnterior, distanciaAnteriorKm }: Props) {
  if (!retiroStale && !entregaStale) return null

  const puntoModificado =
    retiroStale && entregaStale
      ? 'Se modificaron ambos puntos.'
      : retiroStale
        ? 'Se modificó el punto de retiro.'
        : 'Se modificó el punto de entrega.'

  return (
    <div style={{
      background: '#fffbeb',
      border: '1px solid #fcd34d',
      borderRadius: 12,
      padding: '14px 16px',
    }}>
      <p style={{ fontSize: 11, fontWeight: 700, color: '#92400e', textTransform: 'uppercase', letterSpacing: 0.5, margin: '0 0 6px' }}>
        ⚠️ Cotización desactualizada
      </p>
      <p style={{ fontSize: 13, color: '#78350f', margin: '0 0 4px', fontWeight: 500 }}>
        {puntoModificado} Recalculá el viaje para obtener el precio correcto.
      </p>
      {precioAnterior != null && (
        <p style={{ fontSize: 12, color: '#9ca3af', margin: '2px 0 0', textDecoration: 'line-through' }}>
          Antes: C$ {precioAnterior}
          {distanciaAnteriorKm != null ? ` · ${distanciaAnteriorKm.toFixed(2)} km` : ''}
        </p>
      )}
    </div>
  )
}
