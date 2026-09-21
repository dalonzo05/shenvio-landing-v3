'use client'
// FIN-TRAZABILIDAD-UX-2 — "Depósitos asociados (N)".
//
// Registro documental de TODOS los depósitos cuyo solicitudIds incluye la
// orden: los dos de un cobro contra entrega (StorkHub + comercio), el pago
// del delivery por transferencia, o uno anulado y el que lo reemplazó. Cada
// uno es una obligación distinta y se muestra por separado; no hay total.
//
// No repite lo que ya está en la ficha: la obligación derivada de la orden es
// de BloqueDepositos y las fotos, de "Evidencias financieras". Acá no hay
// imágenes. No se inventa ninguna ruta por depósito: la única navegación es
// la lista de Depósitos, que existe.

import Link from 'next/link'
import { presentarActor } from '@/lib/actor-resolucion'
import { fechaHoraOperativa } from '@/lib/fecha-operativa'
import { tituloDepositosAsociados, type FilaDepositoAsociado } from '@/lib/depositos-asociados'

const COLOR_ESTADO: Record<string, string> = {
  confirmado: 'bg-green-50 text-green-700 border-green-200',
  en_revision: 'bg-blue-50 text-blue-700 border-blue-200',
  devuelto: 'bg-orange-50 text-orange-700 border-orange-200',
  pendiente_boucher: 'bg-amber-50 text-amber-700 border-amber-200',
  rechazado: 'bg-red-50 text-red-600 border-red-200',
  convertido_en_deuda: 'bg-red-50 text-red-600 border-red-200',
  anulado: 'bg-gray-100 text-gray-600 border-gray-200',
}

const money = (n: number | null) => (typeof n === 'number' ? `C$ ${n.toLocaleString('es-NI')}` : '—')

function Dato({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="min-w-0">
      <div className="text-xs text-gray-500">{label}</div>
      <div className="text-sm font-medium text-gray-900 break-words">{children}</div>
    </div>
  )
}

export function DepositosAsociados({
  filas,
  nombresActores,
  cargando = false,
}: {
  filas: FilaDepositoAsociado[]
  nombresActores: Record<string, string>
  cargando?: boolean
}) {
  return (
    <div id="depositos-asociados" className="scroll-mt-24 rounded-2xl border border-gray-200 bg-white p-5 shadow-sm">
      <div className="flex flex-wrap items-baseline justify-between gap-2 mb-1">
        <h2 className="font-semibold text-gray-900">{tituloDepositosAsociados(filas.length)}</h2>
        <Link href="/panel/gestor/depositos" className="text-xs font-semibold text-[#004aad] hover:underline">
          Ir a Depósitos
        </Link>
      </div>
      <p className="text-xs text-gray-500 mb-4">
        Cada depósito es una obligación separada: no se suman entre sí.
      </p>

      {cargando && filas.length === 0 ? (
        <p className="text-sm text-gray-400">Cargando depósitos…</p>
      ) : filas.length === 0 ? (
        <p className="text-sm text-gray-500">Esta orden no tiene depósitos asociados.</p>
      ) : (
        // Tarjetas apiladas: en móvil una por fila, sin tabla horizontal.
        <ul className="space-y-3">
          {filas.map((f) => {
            const actor = presentarActor(f.confirmadoPorUid, nombresActores[f.confirmadoPorUid ?? ''])
            return (
              <li key={f.id} className="rounded-xl border border-gray-200 p-3.5">
                <div className="flex flex-wrap items-start justify-between gap-2 mb-2.5">
                  <div className="min-w-0">
                    <span
                      className={`font-mono text-sm ${f.identidad.esCodigo ? 'font-bold text-gray-900' : 'text-gray-500'}`}
                      title={`ID técnico: ${f.identidad.idTecnico}`}
                    >
                      {f.identidad.texto}
                    </span>
                    <p className="text-xs text-gray-600 mt-0.5">{f.origenDestino}</p>
                  </div>
                  <span className={`inline-flex text-[11px] font-bold px-2 py-0.5 rounded-full border ${
                    COLOR_ESTADO[f.estadoClave ?? ''] ?? 'bg-gray-100 text-gray-600 border-gray-200'
                  }`}>
                    {f.estado}
                  </span>
                </div>
                <div className="grid grid-cols-1 sm:grid-cols-2 gap-2.5">
                  <Dato label="Total del depósito">{money(f.monto)}</Dato>
                  {/* Un depósito agrupado incluye órdenes ajenas: se dice, para
                      no atribuirle a esta orden un total que no es suyo. */}
                  {f.esAgrupado && <Dato label="Órdenes incluidas">{f.ordenesIncluidas}</Dato>}
                  {f.momentos.map((m) => (
                    <Dato key={m.etiqueta} label={m.etiqueta}>{fechaHoraOperativa(m.valor)}</Dato>
                  ))}
                  {actor && <Dato label="Confirmado por">{actor.nombre}</Dato>}
                  {f.versionComprobante != null && (
                    <Dato label="Comprobante vigente">Versión {f.versionComprobante}</Dato>
                  )}
                </div>
              </li>
            )
          })}
        </ul>
      )}
    </div>
  )
}
