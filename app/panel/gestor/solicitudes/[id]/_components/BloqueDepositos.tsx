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
import {
  identidadDeposito,
  origenDestinoDeposito,
  nombreMotorizadoDeposito,
  comprobanteDeposito,
} from '@/lib/presentacion-deposito'
import { fechaHoraOperativa } from '@/lib/fecha-operativa'
import {
  esPlanTransferencia,
  estadoPagoTransferencia,
  montoAsociadoDeposito,
  momentosDeposito,
} from '@/lib/pago-transferencia'
import { estadoDeliveryComercio } from '@/lib/estado-cobro-comercio'

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
  onVerBoucher,
}: {
  orden: EntradaDepositoOrden
  /** Documentos ya leídos por ID. Este componente no consulta nada. */
  depositos: Partial<Record<DestinoDeposito, DepositoRegistrado | null>>
  nombresActores?: Record<string, string>
  onVerBoucher: (url: string, label: string) => void
}) {
  const [detalleAbierto, setDetalleAbierto] = useState(false)
  const lineas = lineasDeposito(orden, depositos)
  const hayObligacion = tieneObligacionDeposito(orden)
  const registrados = lineas.filter((l) => l.deposito)
  const hayRegistro = registrados.length > 0
  // PAGO-TRANSFERENCIA-UX-1 — la misma orden, vista por su cobro.
  const ordenCobro = orden as unknown as {
    pagoDelivery?: { quienPaga?: string | null } | null
    cobroDelivery?: { estado?: string | null; monto?: number | null; boucherVigente?: string | null; boucherComercio?: { at?: unknown } | null; boucherGestor?: { at?: unknown } | null; boucherAt?: unknown } | null
    confirmacion?: { precioFinalCordobas?: number | null } | null
  }

  return (
    <div id="depositos" className="scroll-mt-24 rounded-2xl border border-teal-200 bg-white p-5 shadow-sm">
      <h2 className="font-semibold text-teal-700 mb-4">Depósitos</h2>

      {/* ── Obligación derivada de esta orden ── */}
      <p className="text-xs font-bold uppercase tracking-wide text-gray-400 mb-2">
        Obligación del motorizado
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

      {/* ── Obligación del comercio ── PAGO-TRANSFERENCIA-UX-1
          "No corresponde depósito del motorizado" es cierto pero incompleto:
          en una orden con plan de transferencia, quien debe el delivery es el
          comercio. Se muestra aparte, sin mezclarlo con el efectivo del
          motorizado. Sale de la propia orden: ninguna lectura. */}
      {esPlanTransferencia(ordenCobro) && (() => {
        const ep = estadoPagoTransferencia(ordenCobro.cobroDelivery)
        const monto = ordenCobro.cobroDelivery?.monto
          ?? ordenCobro.confirmacion?.precioFinalCordobas
          ?? estadoDeliveryComercio(orden as never).montoDelivery
        return (
          <div className="mb-4">
            <p className="text-xs font-bold uppercase tracking-wide text-gray-400 mb-2">Obligación del comercio</p>
            <div className="rounded-xl border border-gray-200 p-3 text-sm">
              <div className="text-gray-500">Pago del delivery por transferencia</div>
              <div className="text-base font-black text-gray-900">{money(monto)}</div>
              <div className={`text-xs mt-0.5 ${
                ep.clave === 'pagado' ? 'text-green-700' : ep.clave === 'en_revision' ? 'text-blue-700' : 'text-amber-600'
              }`}>
                {ep.titulo}
              </div>
            </div>
          </div>
        )
      })()}

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
                .map((l) => `${identidadDeposito(l.deposito!).texto} · ${l.etiqueta.toLowerCase()}: ${l.texto.toLowerCase()}`)
                .join(' · ')}
            </p>
          )}

          <div id="depositos-detalle" className="space-y-3" hidden={!detalleAbierto}>
            {registrados.map((l) => {
              const d = l.deposito!
              const actor = presentarActor(d.confirmadoPorUid, nombresActores[d.confirmadoPorUid ?? ''])
              // DEPOSITOS-UX-TRAZABILIDAD-1 — DEP-N al frente, el ID de Firestore
              // en el title; el origen lo decide `tipo`, y las fechas van en
              // hora de Managua, no del navegador.
              const ident = identidadDeposito(d)
              const momentos = momentosDeposito(d, ordenCobro)
              const aporte = montoAsociadoDeposito(d, ordenCobro, l.obligacion)
              const motorizado = nombreMotorizadoDeposito(d, nombresActores)
              const comprobante = comprobanteDeposito(d)
              return (
                <div key={l.destino} className="rounded-xl border border-gray-200 p-3.5">
                  <div className="flex flex-wrap items-center justify-between gap-2 mb-2.5">
                    <div className="min-w-0">
                      <div className="flex items-center gap-2">
                        <span className={`font-mono text-sm ${ident.esCodigo ? 'font-bold text-gray-900' : 'text-gray-500'}`} title={`ID técnico: ${ident.idTecnico}`}>
                          {ident.texto}
                        </span>
                        <span className="text-xs font-semibold text-gray-500">{l.etiqueta}</span>
                      </div>
                      <p className="text-xs text-gray-600 mt-0.5">{origenDestinoDeposito(d, motorizado).texto}</p>
                    </div>
                    <span className={`inline-flex text-[11px] font-bold px-2 py-0.5 rounded-full border ${
                      COLOR_ESTADO[d.estado ?? ''] ?? 'bg-gray-100 text-gray-600 border-gray-200'
                    }`}>
                      {l.texto}
                    </span>
                  </div>

                  <div className="grid grid-cols-2 gap-2.5 text-sm">
                    <Dato label={aporte.etiqueta}>{money(aporte.monto)}</Dato>
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
                    {/* El nombre resuelto por UID; nunca el correo que se llegó
                        a guardar como motorizadoNombre. */}
                    {motorizado && <Dato label="Enviado por">{motorizado}</Dato>}
                    {/* Solo timestamps que el documento realmente tiene. */}
                    {/* Por tipo: A/B "Enviado"/"Confirmado"; C "Comprobante enviado"/"Pago confirmado". */}
                    {momentos.map((m) => <Dato key={m.etiqueta} label={m.etiqueta}>{fechaHoraOperativa(m.valor)}</Dato>)}
                    {d.rechazadoAt != null && <Dato label="Rechazado">{fechaHoraOperativa(d.rechazadoAt)}</Dato>}
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
                  {comprobante && (
                    <button
                      type="button"
                      onClick={() => onVerBoucher(comprobante, `Comprobante ${ident.texto} · ${l.etiqueta}`)}
                      title="Ampliar comprobante"
                      className="mt-3 flex items-center gap-2 rounded-lg border border-gray-200 bg-gray-50 p-1.5 pr-3 hover:bg-gray-100 hover:border-gray-300 transition cursor-zoom-in"
                    >
                      {/* eslint-disable-next-line @next/next/no-img-element */}
                      <img
                        src={comprobante}
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
