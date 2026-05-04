'use client'
import React from 'react'
import { PuntoFavorito } from './types'

export function FavoritosRetiro({
  favoritos,
  onUsarRetiro,
  onUsarEntrega,
}: {
  favoritos: PuntoFavorito[]
  onUsarRetiro: (fav: PuntoFavorito) => void
  onUsarEntrega: (fav: PuntoFavorito) => void
}) {
  if (!favoritos.length) return null
  return (
    <div className="mt-3 pt-3 border-t border-gray-100">
      <p className="text-[11px] font-bold text-gray-400 uppercase tracking-wide mb-2">Mis lugares</p>
      <div className="flex gap-2 flex-wrap">
        {favoritos.map((fav) => (
          <div key={fav.key} className="flex gap-1">
            <button
              type="button"
              onClick={() => onUsarRetiro(fav)}
              title={`Usar como retiro: ${fav.direccion || fav.label}`}
              className="px-2.5 py-1.5 rounded-lg border border-blue-200 bg-blue-50 text-blue-700 text-[11px] font-bold cursor-pointer hover:bg-blue-100 transition-colors"
            >
              {fav.label} → R
            </button>
            <button
              type="button"
              onClick={() => onUsarEntrega(fav)}
              title={`Usar como entrega: ${fav.direccion || fav.label}`}
              className="px-2.5 py-1.5 rounded-lg border border-green-200 bg-green-50 text-green-700 text-[11px] font-bold cursor-pointer hover:bg-green-100 transition-colors"
            >
              E
            </button>
          </div>
        ))}
      </div>
    </div>
  )
}
