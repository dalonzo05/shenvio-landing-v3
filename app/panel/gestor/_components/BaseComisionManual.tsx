'use client'

import { necesitaBaseManual } from '@/lib/base-comision-ui'

// PRECIO-CONFIRMADO-ANTES-DE-OPERAR-1 — campo de la base de comisión manual, compartido por las 4 pantallas que confirman el precio de una orden.
// Aparece SOLO cuando el servidor no puede derivar la base con la tarifa (viaje anterior sin distancia, distancia fuera del tarifario) y empieza VACÍO: el
// precio final puede incluir recargos que no pagan comisión, así que nunca se precarga con él.

interface Props {
  solicitud: object | null | undefined
  precioEditado: boolean
  precioFinal: number | ''
  valor: string
  onChange: (valor: string) => void
}

export function BaseComisionManual({ solicitud, precioEditado, precioFinal, valor, onChange }: Props) {
  if (!necesitaBaseManual(solicitud, precioEditado)) return null
  return (
    <div className="mt-3">
      <label className="block text-xs font-bold uppercase tracking-wide text-gray-400 mb-1.5">Base para comisión, sin recargos (C$)</label>
      <input
        type="number"
        min={0}
        step="any"
        value={valor}
        onChange={(e) => onChange(e.target.value)}
        className="w-full rounded-lg border border-amber-300 px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-amber-200"
        placeholder="Obligatoria"
        aria-required="true"
      />
      <div className="text-[10px] text-gray-500 mt-1">
        {precioFinal !== '' ? `Precio final: C$${precioFinal}. ` : ''}
        Esta orden no tiene una distancia que permita calcular la tarifa: indicá cuánto del precio paga comisión. No incluyas recargos (zona, terminal).
      </div>
    </div>
  )
}
