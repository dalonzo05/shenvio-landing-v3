'use client'
// DRAWER-CONTEXTUAL-1 — segundo nivel del drawer: el depósito.
//
// No es una ficha de depósito nueva ni una tercera capa: reemplaza el cuerpo
// del mismo drawer y vuelve a la orden con un botón. Es de solo lectura —las
// acciones que escriben (confirmar, pedir corrección, anular) siguen en el
// panel de Depósitos, que ya valida rol y Rules—, así que desde acá solo se
// ofrece "Ver en Depósitos".
//
// Todo el contenido sale de contextoDeposito(): campos del propio documento,
// con los mismos helpers de presentación que la ficha.

import Link from 'next/link'
import { ArrowLeft } from 'lucide-react'
import { presentarActor } from '@/lib/actor-resolucion'
import { fechaHoraOperativa } from '@/lib/fecha-operativa'
import {
  TEXTO_VOLVER_ORDEN,
  TEXTO_VER_EN_DEPOSITOS,
  RUTA_DEPOSITOS,
  type ContextoDeposito,
} from '@/lib/drawer-contextual'

const COLOR_ESTADO: Record<string, string> = {
  confirmado: 'bg-green-50 text-green-700 border-green-200',
  en_revision: 'bg-blue-50 text-blue-700 border-blue-200',
  devuelto: 'bg-orange-50 text-orange-700 border-orange-200',
  pendiente_boucher: 'bg-amber-50 text-amber-700 border-amber-200',
  rechazado: 'bg-red-50 text-red-600 border-red-200',
  convertido_en_deuda: 'bg-red-50 text-red-600 border-red-200',
  anulado: 'bg-gray-100 text-gray-600 border-gray-200',
}

function Dato({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="min-w-0">
      <div className="text-[11px] text-gray-500">{label}</div>
      <div className="text-sm font-medium text-gray-900 break-words">{children}</div>
    </div>
  )
}

export function DepositoContexto({
  contexto,
  nombresActores = {},
  verEnDepositos = false,
  onVolver,
  onVerComprobante,
}: {
  contexto: ContextoDeposito
  nombresActores?: Record<string, string>
  /**
   * ¿Ofrecer el salto al panel de Depósitos? Solo dentro del panel del gestor:
   * desde /panel/comercio esa ruta no es navegable para quien mira, y el
   * contexto de solo lectura termina en "Volver a la orden". Por defecto NO.
   */
  verEnDepositos?: boolean
  onVolver: () => void
  onVerComprobante?: (url: string, label: string) => void
}) {
  const actor = presentarActor(contexto.confirmadoPorUid, nombresActores[contexto.confirmadoPorUid ?? ''])
  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <button
          type="button"
          onClick={onVolver}
          className="inline-flex items-center gap-1.5 rounded-lg px-2 py-1 text-xs font-semibold text-gray-600 hover:bg-gray-100 hover:text-gray-900 transition"
        >
          <ArrowLeft className="h-3.5 w-3.5" />
          {TEXTO_VOLVER_ORDEN}
        </button>
        {verEnDepositos && (
          <Link href={RUTA_DEPOSITOS} className="text-xs font-semibold text-teal-700 hover:underline">
            {TEXTO_VER_EN_DEPOSITOS} →
          </Link>
        )}
      </div>

      <div className="rounded-xl border border-gray-200 bg-white p-3.5">
        <div className="flex flex-wrap items-start justify-between gap-2 mb-3">
          <div className="min-w-0">
            <p className="font-mono text-sm font-bold text-gray-900">{contexto.codigo}</p>
            <p className="text-xs text-gray-600 break-words">{contexto.destino}</p>
          </div>
          <span className={`inline-flex shrink-0 rounded-full border px-2 py-0.5 text-[11px] font-bold ${
            COLOR_ESTADO[contexto.estadoClave ?? ''] ?? 'bg-gray-100 text-gray-600 border-gray-200'
          }`}>
            {contexto.estado}
          </span>
        </div>

        <div className="grid grid-cols-1 sm:grid-cols-2 gap-2.5">
          <Dato label="Monto del depósito">{contexto.monto}</Dato>
          <Dato label="Motorizado">{contexto.motorizado}</Dato>
          <Dato label="Órdenes incluidas">
            {contexto.ordenesIncluidas}
            {contexto.esAgrupado && <span className="ml-1 text-[11px] text-gray-500">(agrupado)</span>}
          </Dato>
          {contexto.momentos.map((m) => (
            <Dato key={m.etiqueta} label={m.etiqueta}>{fechaHoraOperativa(m.valor)}</Dato>
          ))}
          {actor && <Dato label="Confirmado por">{actor.nombre}</Dato>}
          {contexto.version != null && <Dato label="Comprobante vigente">Versión {contexto.version}</Dato>}
        </div>

        {contexto.motivo && (
          <p className="mt-3 text-xs text-gray-700 break-words">
            <span className="text-gray-500">Motivo: </span>{contexto.motivo}
          </p>
        )}

        {contexto.comprobante && (
          <button
            type="button"
            onClick={() => onVerComprobante?.(contexto.comprobante!, `Comprobante ${contexto.codigo}`)}
            disabled={!onVerComprobante}
            className="mt-3 flex items-center gap-2 rounded-lg border border-gray-200 bg-gray-50 p-1.5 pr-3 hover:bg-gray-100 hover:border-gray-300 transition disabled:opacity-60 disabled:cursor-default"
          >
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img src={contexto.comprobante} alt={`Comprobante ${contexto.codigo}`} className="h-10 w-10 rounded object-cover" loading="lazy" />
            <span className="text-xs font-medium text-gray-600">Ver comprobante</span>
          </button>
        )}
      </div>
    </div>
  )
}
