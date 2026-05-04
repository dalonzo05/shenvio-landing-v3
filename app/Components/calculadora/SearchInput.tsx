'use client'
import React from 'react'

type Variant = 'blue' | 'green'

const variantClass: Record<Variant, string> = {
  blue: 'border-blue-200 focus:border-[#004aad] focus:ring-2 focus:ring-[#004aad]/10',
  green: 'border-green-200 focus:border-green-600 focus:ring-2 focus:ring-green-600/10',
}

export function SearchInput({
  inputRef,
  placeholder,
  onFocusEmpty,
  onInputChange,
  onKeyDown,
  icon,
  variant,
  onClear,
  onMyLocation,
  locating,
}: {
  inputRef: React.RefObject<HTMLInputElement | null>
  placeholder: string
  onFocusEmpty: () => void
  onInputChange: () => void
  onKeyDown: (e: React.KeyboardEvent<HTMLInputElement>) => void
  icon: string
  variant: Variant
  onClear: () => void
  onMyLocation?: () => void
  locating?: boolean
}) {
  const rightPadding = onMyLocation ? 'pr-24' : 'pr-16'
  return (
    <div className="relative flex items-center">
      <span className="absolute left-3 text-base pointer-events-none z-10">{icon}</span>
      <input
        ref={inputRef}
        type="text"
        placeholder={placeholder}
        onFocus={onFocusEmpty}
        onInput={onInputChange}
        onKeyDown={onKeyDown}
        className={`w-full rounded-xl border py-[11px] pl-10 ${rightPadding} text-sm text-gray-900 outline-none bg-white transition-all ${variantClass[variant]}`}
      />
      <div className="absolute right-2 flex gap-1">
        {onMyLocation && (
          <button
            type="button"
            onClick={onMyLocation}
            disabled={locating}
            title="Usar mi ubicación"
            className="px-2 py-1.5 rounded-lg border border-gray-200 bg-white cursor-pointer text-[13px] hover:bg-gray-50 disabled:opacity-60 transition-colors"
          >
            {locating ? '⏳' : '📍'}
          </button>
        )}
        <button
          type="button"
          onClick={onClear}
          title="Limpiar"
          className="px-2 py-1.5 rounded-lg border border-gray-200 bg-white cursor-pointer text-[13px] text-gray-400 hover:bg-gray-50 transition-colors"
        >
          ✕
        </button>
      </div>
    </div>
  )
}
