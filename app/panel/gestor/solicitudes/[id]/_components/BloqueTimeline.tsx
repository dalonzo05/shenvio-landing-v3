'use client'
// B2.4 — Historial autoritativo de la orden.
//
// Sustituye a la barra de progreso de 8 pasos, que marcaba etapas como
// cumplidas por pertenencia de estado y por tanto afirmaba que algo había
// pasado sin poder decir cuándo. Acá cada línea es un timestamp persistido.
//
// Solo render: recibe los eventos ya construidos y los nombres ya resueltos.
// No consulta Firestore ni deriva nada.

import {
  Package,
  CheckCircle2,
  CheckCheck,
  Truck,
  Bike,
  Wallet,
  AlertTriangle,
  XCircle,
} from 'lucide-react'
import type { TimelineEvento, TipoEvento } from '@/lib/timeline-orden'
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

export function BloqueTimeline({
  eventos,
  nombresActores = {},
}: {
  eventos: TimelineEvento[]
  nombresActores?: Record<string, string>
}) {
  return (
    <div id="historial" className="scroll-mt-24 rounded-2xl border border-gray-200 bg-white p-5 shadow-sm">
      <div className="flex items-center gap-2 mb-4">
        <Package className="h-4 w-4 text-gray-500" />
        <h2 className="font-semibold text-gray-900">Historial</h2>
      </div>

      {eventos.length === 0 ? (
        // Sin timestamps confiables no se dibuja una historia vacía ni se
        // rellena con el estado actual.
        <p className="text-sm text-gray-500">Todavía no hay eventos registrados con fecha para esta orden.</p>
      ) : (
        <ol className="relative">
          {eventos.map((e, i) => {
            const Icono = ICONO[e.id.split(':')[0]] ?? Package
            const actor = presentarActor(e.actorUid, nombresActores[e.actorUid ?? ''])
            const ultimo = i === eventos.length - 1
            return (
              <li key={e.id} className="relative flex gap-3 pb-4 last:pb-0">
                {/* Hilo vertical: no se dibuja después del último punto. */}
                {!ultimo && <span aria-hidden className="absolute left-[13px] top-7 bottom-0 w-px bg-gray-200" />}

                <span className={`relative z-10 mt-0.5 flex h-[27px] w-[27px] shrink-0 items-center justify-center rounded-full ring-1 ${COLOR[e.tipo]}`}>
                  <Icono className="h-3.5 w-3.5" />
                </span>

                <div className="min-w-0 flex-1 pt-0.5">
                  <p className="text-sm font-semibold text-gray-900">{e.titulo}</p>
                  <p className="text-xs text-gray-500">{fechaHora(e.at)}</p>
                  {/* El actor solo aparece si el dato existe; presentarActor
                      devuelve null sin UID y "Usuario interno" sin nombre. */}
                  {actor && <p className="text-xs font-medium text-gray-700">{actor.nombre}</p>}
                  {e.detalle && <p className="text-xs text-gray-600 mt-0.5">{e.detalle}</p>}
                </div>
              </li>
            )
          })}
        </ol>
      )}
    </div>
  )
}
