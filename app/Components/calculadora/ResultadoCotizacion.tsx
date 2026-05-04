'use client'
import React from 'react'
import { ZonasResult } from './types'

export function ResultadoCotizacion({
  distancia,
  precio,
  zonasResult,
  onSolicitar,
}: {
  distancia: number
  precio: number | null
  zonasResult: ZonasResult
  onSolicitar: () => void
}) {
  const precioInvalido = precio === null || precio === -1
  return (
    <div className="bg-blue-50 border border-blue-200 rounded-2xl p-4">
      <div className="flex flex-wrap justify-between items-start gap-3">
        <div className="min-w-0">
          <p className="text-[11px] font-bold text-gray-400 uppercase tracking-wide mb-1">Precio estimado</p>
          {precioInvalido ? (
            <p className="text-xl font-black text-amber-600">Consultar por WhatsApp</p>
          ) : (
            <p className="text-[32px] font-black text-[#004aad] leading-none tracking-tight">C$ {precio}</p>
          )}
          <p className="text-[13px] text-gray-500 mt-1">
            Distancia: <strong>{distancia.toFixed(2)} km</strong> · Precio sujeto a confirmación
          </p>
          {zonasResult && (
            <div className="flex gap-1.5 flex-wrap mt-2">
              {(zonasResult.zonaRetiroNombre || zonasResult.macroZonaRetiroNombre) && (
                <span className="text-[12px] bg-white text-blue-700 rounded-md px-2 py-0.5 font-semibold border border-blue-200">
                  📦 {zonasResult.zonaRetiroNombre ?? zonasResult.macroZonaRetiroNombre}
                </span>
              )}
              {(zonasResult.zonaEntregaNombre || zonasResult.macroZonaEntregaNombre) && (
                <span className="text-[12px] bg-white text-green-700 rounded-md px-2 py-0.5 font-semibold border border-green-200">
                  🏠 {zonasResult.zonaEntregaNombre ?? zonasResult.macroZonaEntregaNombre}
                </span>
              )}
            </div>
          )}
        </div>
        {!precioInvalido && (
          <button
            type="button"
            onClick={onSolicitar}
            className="bg-[#004aad] text-white rounded-xl px-5 py-3 text-sm font-extrabold cursor-pointer hover:bg-[#003d91] transition-colors whitespace-nowrap shrink-0"
          >
            Solicitar este envío →
          </button>
        )}
      </div>
    </div>
  )
}
