'use client'
import React from 'react'
import { Cotizacion } from './types'

function timeAgo(date: Date): string {
  const s = Math.floor((Date.now() - date.getTime()) / 1000)
  if (s < 60) return `hace ${s}s`
  const m = Math.floor(s / 60)
  if (m < 60) return `hace ${m} min`
  const h = Math.floor(m / 60)
  if (h < 24) return `hace ${h}h`
  const d = Math.floor(h / 24)
  if (d < 7) return `hace ${d} días`
  return date.toLocaleDateString('es-NI', { day: 'numeric', month: 'short' })
}

export function HistorialCotizaciones({
  cotizaciones,
  loading,
  onUsarDeNuevo,
  onSolicitar,
}: {
  cotizaciones: Cotizacion[]
  loading: boolean
  onUsarDeNuevo: (cot: Cotizacion) => void
  onSolicitar: (cot: Cotizacion) => void
}) {
  return (
    <div>
      <div className="flex justify-between items-center mb-3">
        <h3 className="text-[15px] font-extrabold text-gray-900">Últimas cotizaciones</h3>
        <div className="flex items-center gap-1.5">
          <div className="w-2 h-2 rounded-full bg-green-500 ring-2 ring-green-200" />
          <span className="text-[11px] text-green-600 font-semibold">En vivo</span>
        </div>
      </div>

      {loading ? (
        <div className="flex flex-col gap-2.5">
          {[1, 2, 3].map(i => (
            <div key={i} className="bg-gray-100 rounded-xl h-20 border border-gray-200 animate-pulse" />
          ))}
        </div>
      ) : cotizaciones.length === 0 ? (
        <div className="bg-gray-50 border border-gray-200 rounded-2xl p-6 text-center">
          <p className="text-2xl mb-2">🗺️</p>
          <p className="text-sm font-semibold text-gray-700 mb-1">Todavía no hay cotizaciones</p>
          <p className="text-[13px] text-gray-400">Calculá tu primera ruta arriba</p>
        </div>
      ) : (
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
          {cotizaciones.map((cot) => (
            <div
              key={cot.id}
              className="bg-white border border-gray-200 rounded-xl p-3.5 shadow-sm hover:shadow-md transition-shadow flex flex-col gap-2"
            >
              {/* Addresses / Zones */}
              <div className="flex flex-col gap-1 min-w-0">
                <div className="flex items-center gap-2 min-w-0">
                  <div className="w-2 h-2 rounded-full bg-[#004aad] shrink-0" />
                  <span
                    className="text-[12px] text-gray-700 truncate"
                    title={cot.zonaOrigen ? cot.origen : undefined}
                  >
                    {cot.zonaOrigen || cot.origen}
                  </span>
                </div>
                <div className="flex items-center gap-2 min-w-0">
                  <div className="w-2 h-2 rounded-full bg-green-600 shrink-0" />
                  <span
                    className="text-[12px] text-gray-700 truncate"
                    title={cot.zonaDestino ? cot.destino : undefined}
                  >
                    {cot.zonaDestino || cot.destino}
                  </span>
                </div>
              </div>

              {/* Stats */}
              <div className="flex items-center gap-3 py-1.5 border-t border-b border-gray-100">
                <span className="text-[18px] font-black text-[#004aad]">C$ {cot.precioCordobas}</span>
                <span className="text-[12px] text-gray-500">📏 {cot.distanciaKm?.toFixed(1)} km</span>
                {cot.createdAt && (
                  <span className="text-[11px] text-gray-400 ml-auto">{timeAgo(cot.createdAt)}</span>
                )}
              </div>

              {/* Actions */}
              <div className="flex gap-2">
                <button
                  type="button"
                  onClick={() => onUsarDeNuevo(cot)}
                  className="flex-1 py-1.5 rounded-lg border border-gray-200 bg-white text-gray-700 text-[12px] font-semibold cursor-pointer hover:bg-gray-50 transition-colors"
                >
                  Usar de nuevo
                </button>
                <button
                  type="button"
                  onClick={() => onSolicitar(cot)}
                  className="flex-1 py-1.5 rounded-lg border-none bg-[#004aad] text-white text-[12px] font-bold cursor-pointer hover:bg-[#003d91] transition-colors"
                >
                  Solicitar →
                </button>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  )
}
