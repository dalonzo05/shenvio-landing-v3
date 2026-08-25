'use client'
// B2.6 — Resumen ejecutivo e índice de la ficha.
//
// La ficha creció hasta contener toda la verdad de una orden, y con eso dejó
// de responder rápido la única pregunta con la que un gestor la abre: qué
// falta para cerrarla. Este bloque la responde arriba, en una línea por
// pendiente, con un enlace al bloque donde se resuelve.
//
// Solo render: los pendientes los deriva lib/resumen-orden.ts a partir de los
// helpers que ya eran autoritativos. Acá no se calcula nada.

import { AlertTriangle, Clock3, CheckCircle2, Wallet, Bike } from 'lucide-react'
import { resumenOrden, type EntradaResumen, type CategoriaPendiente } from '@/lib/resumen-orden'
import type { DepositoRegistrado, DestinoDeposito } from '@/lib/deposito-orden'

const ICONO: Record<CategoriaPendiente, typeof AlertTriangle> = {
  operativo: Bike,
  cobro: Wallet,
  incidencia: AlertTriangle,
  deposito: Wallet,
}

const ANCLA_TEXTO: Record<string, string> = {
  cobros: 'Ver cobros',
  incidencia: 'Ver incidencia',
  depositos: 'Ver depósitos',
  historial: 'Ver historial',
}

export function ResumenOrden({
  orden,
  depositos = {},
}: {
  orden: EntradaResumen
  /** Depósitos que la ficha ya cargó en B2.3. No se consulta nada nuevo. */
  depositos?: Partial<Record<DestinoDeposito, DepositoRegistrado | null>>
}) {
  const { pendientes, hechos, sinPendientes, mensajeLimpio } = resumenOrden(orden, depositos)

  return (
    <div className="rounded-2xl border border-gray-200 bg-white p-5 shadow-sm">
      <h2 className="text-xs font-bold uppercase tracking-wide text-gray-400 mb-3">
        Qué falta en esta orden
      </h2>

      {sinPendientes ? (
        <p className="flex items-center gap-2 text-sm font-semibold text-green-700">
          <CheckCircle2 aria-hidden className="h-4 w-4 shrink-0" />
          {mensajeLimpio}
        </p>
      ) : (
        <ul className="space-y-2">
          {pendientes.map((p) => {
            const Icono = ICONO[p.categoria]
            const alta = p.severidad === 'alta'
            return (
              <li key={p.id} className="flex flex-wrap items-center gap-x-2 gap-y-1">
                <span className={`flex h-6 w-6 shrink-0 items-center justify-center rounded-full ${
                  alta ? 'bg-amber-50 text-amber-600' : 'bg-blue-50 text-blue-600'
                }`}>
                  {alta ? <Icono aria-hidden className="h-3.5 w-3.5" /> : <Clock3 aria-hidden className="h-3.5 w-3.5" />}
                </span>
                <span className="text-sm font-semibold text-gray-900">{p.texto}</span>
                {/* Enlace al bloque donde se resuelve. Un pendiente operativo
                    no lo tiene: no hay bloque que abrir. */}
                {p.anchor && (
                  <a href={`#${p.anchor}`} className="text-xs font-semibold text-blue-600 hover:underline">
                    {ANCLA_TEXTO[p.anchor]} →
                  </a>
                )}
              </li>
            )
          })}
        </ul>
      )}

      {/* Los hechos cerrados van en gris y al final: el bloque existe para
          mostrar lo que falta, no para felicitar. */}
      {hechos.length > 0 && (
        <p className="mt-3 flex flex-wrap gap-x-3 gap-y-1 text-xs text-gray-500">
          {hechos.map((h) => (
            <span key={h.id} className="inline-flex items-center gap-1">
              <CheckCircle2 aria-hidden className="h-3 w-3 text-green-600" />
              {h.texto}
            </span>
          ))}
        </p>
      )}
    </div>
  )
}

/** Índice de la ficha. Anchors HTML puros: sin router ni scroll manual. */
export function IndiceFicha({
  hayIncidencia,
  hayEvidencias,
}: {
  hayIncidencia: boolean
  hayEvidencias: boolean
}) {
  const items: Array<[string, string]> = [
    ['cobros', 'Cobros'],
    ...(hayIncidencia ? ([['incidencia', 'Incidencia']] as Array<[string, string]>) : []),
    ['depositos', 'Depósitos'],
    ...(hayEvidencias ? ([['evidencias', 'Evidencias']] as Array<[string, string]>) : []),
    ['historial', 'Historial'],
  ]
  return (
    <nav aria-label="Secciones de la orden" className="flex flex-wrap items-center gap-2">
      <span className="text-xs font-bold uppercase tracking-wide text-gray-400">Ir a</span>
      {items.map(([id, label]) => (
        <a
          key={id}
          href={`#${id}`}
          className="rounded-full border border-gray-200 bg-white px-3 py-1 text-xs font-medium text-gray-600 hover:border-gray-300 hover:bg-gray-50 hover:text-gray-900 transition"
        >
          {label}
        </a>
      ))}
    </nav>
  )
}
