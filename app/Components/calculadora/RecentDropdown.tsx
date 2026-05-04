'use client'
import React from 'react'
import { PlaceLite } from './types'

export function RecentDropdown({
  items,
  onSelect,
  onClear,
}: {
  items: PlaceLite[]
  onSelect: (p: PlaceLite) => void
  onClear: () => void
}) {
  if (!items.length) return null
  return (
    <div className="absolute top-full left-0 right-0 z-50 bg-white border border-gray-200 rounded-xl shadow-lg mt-1 overflow-hidden">
      <div className="flex justify-between items-center px-3.5 py-2 border-b border-gray-100">
        <span className="text-[11px] font-bold text-gray-400 uppercase tracking-wide">Recientes</span>
        <button
          type="button"
          onClick={onClear}
          className="text-[11px] text-gray-400 underline bg-transparent border-none cursor-pointer hover:text-gray-600"
        >
          Borrar
        </button>
      </div>
      {items.map((p, i) => (
        <button
          key={i}
          type="button"
          onMouseDown={() => onSelect(p)}
          className="block w-full text-left px-3.5 py-2.5 border-none bg-transparent cursor-pointer text-[13px] text-gray-700 border-b border-gray-50 hover:bg-gray-50 transition-colors"
        >
          🕐 {p.label}
        </button>
      ))}
    </div>
  )
}
