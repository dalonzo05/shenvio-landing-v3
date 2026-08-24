'use client'
// B2.4 — Historial autoritativo de la orden.
// B2.4B — presentado en dos secciones.
//
// B2.4 sustituyó una barra de progreso que marcaba etapas como cumplidas por
// pertenencia de estado —afirmaba que algo pasó sin poder decir cuándo— por
// una timeline derivada solo de timestamps persistidos. Correcta, pero el E2E
// mostró el costo: once eventos en una columna, mezclando el recorrido del
// envío con lo que le pasó a la orden después, empujando Cobros, Incidencias
// y Depósitos fuera de la pantalla.
//
// Acá se separan:
//   ESTADO DEL ENVÍO      resumen compacto + recorrido completo colapsado
//   HISTORIAL DE CAMBIOS  cobros, incidencias, depósitos, administrativos
//
// Solo render: recibe los eventos ya construidos y los nombres ya resueltos.
// No consulta Firestore, no deriva historia y no reordena nada.

import { useState } from 'react'
import {
  Package,
  CheckCircle2,
  CheckCheck,
  Truck,
  Bike,
  Wallet,
  AlertTriangle,
  XCircle,
  ChevronDown,
} from 'lucide-react'
import {
  separarTimeline,
  hitosRecorrido,
  type TimelineEvento,
  type TipoEvento,
} from '@/lib/timeline-orden'
import { presentarActor } from '@/lib/actor-resolucion'

const ICONO: Record<string, typeof Package> = {
  creada: Package,
  confirmada: CheckCircle2,
  asignada: Bike,
  aceptada: CheckCheck,
  en_camino_retiro: Truck,
  retirado: Package,
  en_camino_entrega: Truck,
  entregado: CheckCircle2,
  incidencia: AlertTriangle,
  incidencia_resuelta: CheckCheck,
  delivery_pagado: Wallet,
  deposito_registrado: Wallet,
  deposito_confirmado: Wallet,
  rechazada: XCircle,
}

/** Mismo vocabulario cromático que el resto de la ficha. */
const COLOR: Record<TipoEvento, string> = {
  operativo: 'bg-gray-100 text-gray-600 ring-gray-200',
  cobro: 'bg-amber-50 text-amber-600 ring-amber-200',
  deposito: 'bg-teal-50 text-teal-700 ring-teal-200',
  administrativo: 'bg-gray-100 text-gray-600 ring-gray-200',
}

function fechaHora(d: Date) {
  return `${d.toLocaleDateString('es-NI', { day: 'numeric', month: 'short', year: 'numeric' })} · ${d.toLocaleTimeString('es-NI', { hour: 'numeric', minute: '2-digit' })}`
}

/** Una fila de la lista vertical. Idéntica en ambas secciones. */
function Evento({
  evento,
  nombresActores,
  ultimo,
}: {
  evento: TimelineEvento
  nombresActores: Record<string, string>
  ultimo: boolean
}) {
  const Icono = ICONO[evento.id.split(':')[0]] ?? Package
  const actor = presentarActor(evento.actorUid, nombresActores[evento.actorUid ?? ''])
  return (
    <li className="relative flex gap-3 pb-4 last:pb-0">
      {/* Hilo vertical: no se dibuja después del último punto. */}
      {!ultimo && <span aria-hidden className="absolute left-[13px] top-7 bottom-0 w-px bg-gray-200" />}

      <span className={`relative z-10 mt-0.5 flex h-[27px] w-[27px] shrink-0 items-center justify-center rounded-full ring-1 ${COLOR[evento.tipo]}`}>
        <Icono className="h-3.5 w-3.5" />
      </span>

      <div className="min-w-0 flex-1 pt-0.5">
        <p className="text-sm font-semibold text-gray-900">{evento.titulo}</p>
        <p className="text-xs text-gray-500">{fechaHora(evento.at)}</p>
        {/* El actor solo aparece si el dato existe; presentarActor devuelve
            null sin UID y "Usuario interno" sin nombre. */}
        {actor && <p className="text-xs font-medium text-gray-700">{actor.nombre}</p>}
        {evento.detalle && <p className="text-xs text-gray-600 mt-0.5">{evento.detalle}</p>}
      </div>
    </li>
  )
}

export function BloqueTimeline({
  eventos,
  estadoActual,
  estadoClase,
  nombresActores = {},
}: {
  eventos: TimelineEvento[]
  /** Estado legible de la orden. Es la verdad del estado actual: 'cancelada'
   *  no tiene evento propio porque el sistema no guarda su timestamp. */
  estadoActual: string
  estadoClase?: string
  nombresActores?: Record<string, string>
}) {
  const [abierto, setAbierto] = useState(false)
  const { recorrido, cambios } = separarTimeline(eventos)
  const hitos = hitosRecorrido(eventos)

  return (
    <div id="historial" className="scroll-mt-24 rounded-2xl border border-gray-200 bg-white p-5 shadow-sm">
      {/* ── Estado del envío ─────────────────────────────────────────────── */}
      <div className="flex flex-wrap items-center gap-2 mb-4">
        <Package className="h-4 w-4 text-gray-500" />
        <h2 className="font-semibold text-gray-900">Estado del envío</h2>
        <span className={`inline-flex rounded-full border px-2.5 py-0.5 text-xs font-semibold ${estadoClase ?? 'bg-gray-100 text-gray-700 border-gray-200'}`}>
          {estadoActual}
        </span>
      </div>

      {/* Hitos compactos. En móvil envuelven en varias líneas en vez de
          desbordar horizontalmente. */}
      <ol className="flex flex-wrap items-center gap-x-1.5 gap-y-2">
        {hitos.map((hito, i) => (
          <li key={hito.clave} className="flex items-center gap-1.5">
            {i > 0 && <span aria-hidden className="text-gray-300 text-xs">→</span>}
            <span
              title={hito.at ? fechaHora(hito.at) : 'Sin registro'}
              className={`inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-xs font-medium ${
                hito.alcanzado
                  ? 'border-green-200 bg-green-50 text-green-700'
                  : 'border-gray-200 bg-white text-gray-400'
              }`}
            >
              {hito.alcanzado && <CheckCircle2 aria-hidden className="h-3 w-3" />}
              {hito.etiqueta}
            </span>
          </li>
        ))}
      </ol>

      {recorrido.length > 0 && (
        <>
          <button
            type="button"
            onClick={() => setAbierto((v) => !v)}
            aria-expanded={abierto}
            aria-controls="recorrido-completo"
            className="mt-3 inline-flex items-center gap-1.5 rounded-lg px-2 py-1 -ml-2 text-xs font-semibold text-gray-600 hover:bg-gray-50 hover:text-gray-900 transition"
          >
            <ChevronDown aria-hidden className={`h-3.5 w-3.5 transition-transform ${abierto ? 'rotate-180' : ''}`} />
            {abierto ? 'Ocultar recorrido' : `Ver recorrido completo (${recorrido.length})`}
          </button>

          {/* Colapsado por defecto: el detalle no se pierde, deja de ocupar
              la pantalla antes de Cobros, Incidencias y Depósitos. */}
          {abierto && (
            <ol id="recorrido-completo" className="relative mt-3 border-t border-gray-100 pt-4">
              {recorrido.map((e, i) => (
                <Evento key={e.id} evento={e} nombresActores={nombresActores} ultimo={i === recorrido.length - 1} />
              ))}
            </ol>
          )}
        </>
      )}

      {/* ── Historial de cambios ─────────────────────────────────────────── */}
      {/* Se omite del todo cuando no hay nada: una caja vacía solo agrega
          scroll. Incidencias, cobros y depósitos viven acá, nunca entre los
          estados del envío. */}
      {cambios.length > 0 && (
        <div className="mt-5 border-t border-gray-100 pt-4">
          <h3 className="text-xs font-bold uppercase tracking-wide text-gray-400 mb-3">
            Historial de cambios
          </h3>
          <ol className="relative">
            {cambios.map((e, i) => (
              <Evento key={e.id} evento={e} nombresActores={nombresActores} ultimo={i === cambios.length - 1} />
            ))}
          </ol>
        </div>
      )}

      {eventos.length === 0 && (
        // Sin timestamps confiables no se dibuja una historia vacía ni se
        // rellena con el estado actual.
        <p className="text-sm text-gray-500 mt-3">Todavía no hay eventos registrados con fecha para esta orden.</p>
      )}
    </div>
  )
}
