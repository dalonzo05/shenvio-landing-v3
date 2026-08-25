'use client'
// B2.3 — Trazabilidad de depósitos de la orden.
//
// La sección anterior solo mostraba los flags de registro.deposito
// (confirmado sí/no + fecha). No decía cuánto correspondía depositar, ni de
// qué depósito se trataba, ni si ese depósito agrupaba más órdenes.
//
// Separa dos cosas que no son lo mismo:
//   · OBLIGACIÓN DE ESTA ORDEN — de calcularDeposito(), única fórmula
//   · DEPÓSITO REGISTRADO      — el documento real de ordenes_deposito
//
// Solo lectura: no hay ninguna acción sobre depósitos.

import { useState } from 'react'
import {
  lineasDeposito,
  tieneObligacionDeposito,
  type EntradaDepositoOrden,
  type DepositoRegistrado,
  type DestinoDeposito,
} from '@/lib/deposito-orden'
import { presentarActor } from '@/lib/actor-resolucion'

function money(n: number | null | undefined) {
  if (typeof n !== 'number' || !Number.isFinite(n)) return '—'
  return `C$ ${n.toLocaleString('es-NI')}`
}

const Dato = ({ label, children }: { label: string; children: React.ReactNode }) => (
  <div>
    <div className="text-gray-500">{label}</div>
    <div className="font-medium text-gray-900">{children}</div>
  </div>
)

const COLOR_ESTADO: Record<string, string> = {
  confirmado: 'bg-green-50 text-green-700 border-green-200',
  en_revision: 'bg-blue-50 text-blue-700 border-blue-200',
  pendiente_boucher: 'bg-amber-50 text-amber-700 border-amber-200',
  rechazado: 'bg-red-50 text-red-600 border-red-200',
  convertido_en_deuda: 'bg-red-50 text-red-600 border-red-200',
  anulado: 'bg-gray-100 text-gray-600 border-gray-200',
}

export function BloqueDepositos({
  orden,
  depositos,
  nombresActores = {},
  formatearFecha,
  onVerBoucher,
}: {
  orden: EntradaDepositoOrden
  /** Documentos ya leídos por ID. Este componente no consulta nada. */
  depositos: Partial<Record<DestinoDeposito, DepositoRegistrado | null>>
  nombresActores?: Record<string, string>
  formatearFecha: (v: unknown) => string
  onVerBoucher: (url: string, label: string) => void
}) {
  const [detalleAbierto, setDetalleAbierto] = useState(false)
  const lineas = lineasDeposito(orden, depositos)
  const hayObligacion = tieneObligacionDeposito(orden)
  const registrados = lineas.filter((l) => l.deposito)
  const hayRegistro = registrados.length > 0

  return (
    <div id="depositos" className="scroll-mt-24 rounded-2xl border border-teal-200 bg-white p-5 shadow-sm">
      <h2 className="font-semibold text-teal-700 mb-4">Depósitos</h2>

      {/* ── Obligación derivada de esta orden ── */}
      <p className="text-xs font-bold uppercase tracking-wide text-gray-400 mb-2">
        Obligación de esta orden
      </p>

      {!hayObligacion ? (
        // Con obligación cero no se dice "pendiente": no hay nada que esperar.
        // Es el caso del producto no cobrado o del CE deducido sin cobrar.
        <p className="text-sm text-gray-500 mb-4">
          No corresponde depósito del motorizado para esta orden.
        </p>
      ) : (
        <div className="grid grid-cols-2 gap-3 text-sm mb-4">
          {lineas.map((l) => (
            <div key={l.destino} className="rounded-xl border border-gray-200 p-3">
              <div className="text-gray-500">{l.etiqueta}</div>
              <div className="text-base font-black text-gray-900">{money(l.obligacion)}</div>
              <div className={`text-xs mt-0.5 ${
                l.clave === 'registrado' ? 'text-green-700'
                : l.clave === 'sin_deposito' ? 'text-amber-600'
                : 'text-gray-400'
              }`}>
                {l.texto}
              </div>
            </div>
          ))}
        </div>
      )}

      {/* ── Depósitos reales registrados ──
          B2.6: colapsados por defecto. La obligación de arriba es lo
          decisional; el ID, el boucher y el actor son auditoría, y ocupaban
          media pantalla antes de llegar a Evidencias e Historial. */}
      {hayRegistro && (
        <>
          <div className="flex flex-wrap items-center justify-between gap-2 pt-1 mb-2">
            <p className="text-xs font-bold uppercase tracking-wide text-gray-400">
              Depósitos registrados ({registrados.length})
            </p>
            <button
              type="button"
              onClick={() => setDetalleAbierto((v) => !v)}
              aria-expanded={detalleAbierto}
              aria-controls="depositos-detalle"
              className="rounded-lg px-2 py-1 -mr-2 text-xs font-semibold text-gray-600 hover:bg-gray-50 hover:text-gray-900 transition"
            >
              {detalleAbierto ? 'Ocultar detalle de depósitos' : 'Ver detalle de depósitos'}
            </button>
          </div>

          {/* Resumen: cuántos y en qué estado, por destino. Nunca un total
              sumado — son destinos distintos y pueden ser agrupados. */}
          {!detalleAbierto && (
            <p className="text-sm text-gray-600">
              {registrados
                .map((l) => `${l.etiqueta.toLowerCase()}: ${l.texto.toLowerCase()}`)
                .join(' · ')}
            </p>
          )}

          <div id="depositos-detalle" className="space-y-3" hidden={!detalleAbierto}>
            {registrados.map((l) => {
              const d = l.deposito!
              const actor = presentarActor(d.confirmadoPorUid, nombresActores[d.confirmadoPorUid ?? ''])
              return (
                <div key={l.destino} className="rounded-xl border border-gray-200 p-3.5">
                  <div className="flex flex-wrap items-center justify-between gap-2 mb-2.5">
                    <div className="flex items-center gap-2">
                      <span className="text-xs font-semibold text-gray-500">{l.etiqueta}</span>
                      <span className="font-mono text-[11px] text-gray-400" title={d.id}>
                        {d.id.slice(0, 10)}…
                      </span>
                    </div>
                    <span className={`inline-flex text-[11px] font-bold px-2 py-0.5 rounded-full border ${
                      COLOR_ESTADO[d.estado ?? ''] ?? 'bg-gray-100 text-gray-600 border-gray-200'
                    }`}>
                      {l.texto}
                    </span>
                  </div>

                  <div className="grid grid-cols-2 gap-2.5 text-sm">
                    <Dato label="Esta orden aporta">{money(l.obligacion)}</Dato>
                    {/* Con un depósito agrupado, el total incluye órdenes
                        ajenas: mostrarlo como si fuera de esta orden sería
                        atribuirle al motorizado un monto que no le toca. */}
                    {l.esAgrupado && (
                      <>
                        <Dato label="Total del depósito">{money(d.montoTotal)}</Dato>
                        <Dato label="Órdenes incluidas">{l.ordenesEnDeposito}</Dato>
                      </>
                    )}
                    {!l.esAgrupado && typeof d.montoTotal === 'number' && (
                      <Dato label="Total del depósito">{money(d.montoTotal)}</Dato>
                    )}
                    {typeof d.gastosDescontados === 'number' && d.gastosDescontados > 0 && (
                      <Dato label="Gastos descontados">{money(d.gastosDescontados)}</Dato>
                    )}
                    {d.motorizadoNombre && <Dato label="Motorizado">{d.motorizadoNombre}</Dato>}
                    {/* Solo timestamps que el documento realmente tiene. */}
                    {d.creadoAt != null && <Dato label="Creado">{formatearFecha(d.creadoAt)}</Dato>}
                    {d.confirmadoAt != null && <Dato label="Confirmado">{formatearFecha(d.confirmadoAt)}</Dato>}
                    {d.rechazadoAt != null && <Dato label="Rechazado">{formatearFecha(d.rechazadoAt)}</Dato>}
                    {actor && (
                      <div>
                        <div className="text-gray-500">Confirmado por</div>
                        <div className="font-medium text-gray-900">{actor.nombre}</div>
                        <div className="text-[10px] font-mono text-gray-400">ID: {actor.uid.slice(0, 10)}…</div>
                      </div>
                    )}
                  </div>

                  {d.motivoRechazo && (
                    <p className="text-xs text-red-600 mt-2">Motivo: {d.motivoRechazo}</p>
                  )}
                  {d.notaConversion && (
                    <p className="text-xs text-red-600 mt-2">Nota: {d.notaConversion}</p>
                  )}

                  {/* Boucher vigente. No hay historial de reemplazos en el
                      schema, así que no se simula uno. */}
                  {d.boucher?.url && (
                    <button
                      type="button"
                      onClick={() => onVerBoucher(d.boucher!.url!, `Boucher · ${l.etiqueta}`)}
                      title="Ampliar comprobante"
                      className="mt-3 flex items-center gap-2 rounded-lg border border-gray-200 bg-gray-50 p-1.5 pr-3 hover:bg-gray-100 hover:border-gray-300 transition cursor-zoom-in"
                    >
                      {/* eslint-disable-next-line @next/next/no-img-element */}
                      <img
                        src={d.boucher.url}
                        alt={`Comprobante del depósito ${l.etiqueta.toLowerCase()}`}
                        className="w-10 h-10 object-cover rounded"
                        loading="lazy"
                      />
                      <span className="text-xs font-medium text-gray-600">Ver comprobante</span>
                    </button>
                  )}
                </div>
              )
            })}
          </div>
        </>
      )}

      {/* Obligación viva sin ningún depósito todavía. */}
      {hayObligacion && !hayRegistro && (
        <p className="text-xs text-amber-600">
          Esta orden todavía no está asociada a un depósito registrado.
        </p>
      )}
    </div>
  )
}
