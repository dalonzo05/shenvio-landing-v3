'use client'
// SOLICITUD-RESUMEN-UX-1 — "Resumen de la orden": el nivel 1 de la ficha.
//
// Va arriba de "Qué falta en esta orden" y no lo reemplaza: acá solo se dice
// cuántos pendientes hay y los primeros; el detalle sigue abajo, igual que el
// resto de los bloques (Cobros, Depósitos, Evidencias, Historial), a los que
// se llega con las anclas que ya existen.
//
// Todo el contenido sale de resumenEjecutivoOrden(), que compone helpers ya
// existentes. Este archivo solo presenta.

import { fechaHoraOperativa } from '@/lib/fecha-operativa'
import { tituloDepositosAsociados } from '@/lib/depositos-asociados'
import type { ResumenEjecutivo } from '@/lib/resumen-ejecutivo-orden'

function Grupo({ titulo, ancla, children }: { titulo: string; ancla?: string; children: React.ReactNode }) {
  return (
    <section className="min-w-0 rounded-xl border border-gray-200 bg-gray-50/60 p-3.5">
      <div className="flex flex-wrap items-baseline justify-between gap-x-2 gap-y-1 mb-2">
        <h3 className="text-xs font-bold uppercase tracking-wide text-gray-500">{titulo}</h3>
        {ancla && (
          <a href={`#${ancla}`} className="text-[11px] font-semibold text-blue-600 hover:underline">Ver detalle →</a>
        )}
      </div>
      <dl className="space-y-1.5">{children}</dl>
    </section>
  )
}

function Dato({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex flex-wrap items-baseline gap-x-2 gap-y-0.5 min-w-0">
      <dt className="text-xs text-gray-500 shrink-0">{label}</dt>
      <dd className="text-sm font-medium text-gray-900 min-w-0 break-words">{children}</dd>
    </div>
  )
}

export function ResumenEjecutivo({ resumen }: { resumen: ResumenEjecutivo }) {
  const { envio, cliente, cobro, liquidaciones, evidencias, atencion } = resumen
  return (
    <div className="rounded-2xl border border-gray-200 bg-white p-5 shadow-sm">
      <div className="flex flex-wrap items-baseline justify-between gap-2 mb-3">
        <h2 className="text-xs font-bold uppercase tracking-wide text-gray-400">Resumen de la orden</h2>
        <span
          className={`inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-[11px] font-bold ${
            atencion.hayPendientes
              ? 'border-amber-200 bg-amber-50 text-amber-700'
              : 'border-green-200 bg-green-50 text-green-700'
          }`}
        >
          {atencion.hayPendientes ? `⚠ ${atencion.titulo}` : `✓ ${atencion.titulo}`}
          {atencion.total > 0 && ` (${atencion.total})`}
        </span>
      </div>

      {/* Una columna en móvil; hasta tres en pantallas grandes. */}
      <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-3">
        <Grupo titulo="Envío" ancla="historial">
          <Dato label="Estado">{envio.estado}</Dato>
          <Dato label="Ruta">{envio.ruta}</Dato>
          <Dato label="Motorizado">{envio.motorizado}</Dato>
          <Dato label="Creada">{fechaHoraOperativa(envio.creada)}</Dato>
          {envio.entregada != null && <Dato label="Entregada">{fechaHoraOperativa(envio.entregada)}</Dato>}
        </Grupo>

        <Grupo titulo="Cliente / comercio">
          <Dato label="Comercio">{cliente.nombre}</Dato>
          <Dato label="Tipo de cliente">{cliente.tipoCliente}</Dato>
        </Grupo>

        <Grupo titulo="Cobro" ancla="cobros">
          <Dato label="Delivery">{cobro.delivery}</Dato>
          <Dato label="Forma de pago">{cobro.formaPago}</Dato>
          <Dato label="Recibió el dinero">{cobro.recibio}</Dato>
          <Dato label="Cobro contra entrega">{cobro.cobroContraEntrega}</Dato>
          {cobro.descontadoDelCE && (
            <p className="text-xs text-gray-600 break-words">{cobro.descontadoDelCE}</p>
          )}
        </Grupo>

        <Grupo titulo="Liquidación" ancla="depositos">
          {liquidaciones.length === 0 ? (
            <p className="text-sm text-gray-500">Sin depósitos asociados.</p>
          ) : (
            <>
              {/* Una línea por destino. Nunca un total: son obligaciones distintas. */}
              {liquidaciones.map((l) => (
                <div key={l.id} className="flex flex-wrap items-baseline justify-between gap-x-2 min-w-0">
                  <span className="text-xs text-gray-500 min-w-0 break-words">
                    {l.destino}
                    <span className="ml-1 font-mono text-[11px] text-gray-400">{l.codigo}</span>
                  </span>
                  <span className="text-sm font-medium text-gray-900">
                    {l.monto} · {l.estado}
                    {l.esAgrupado && <span className="ml-1 text-[11px] text-gray-500">(agrupado)</span>}
                  </span>
                </div>
              ))}
              <p className="text-[11px] text-gray-500 pt-0.5">{tituloDepositosAsociados(liquidaciones.length)}</p>
            </>
          )}
        </Grupo>

        <Grupo titulo="Evidencias" ancla="evidencias">
          <Dato label="Retiro">{evidencias.retiro ? '✓ Disponible' : 'No disponible'}</Dato>
          <Dato label="Entrega">{evidencias.entrega ? '✓ Disponible' : 'No disponible'}</Dato>
          <Dato label="Comprobantes de depósito">
            {evidencias.comprobantes === 1 ? '1 comprobante' : `${evidencias.comprobantes} comprobantes`}
          </Dato>
        </Grupo>

        <Grupo titulo="Atención">
          {atencion.hayPendientes ? (
            <ul className="space-y-1">
              {atencion.mensajes.map((m, i) => (
                <li key={i} className="text-sm text-amber-800 break-words">⚠ {m}</li>
              ))}
              {atencion.total > atencion.mensajes.length && (
                <li className="text-xs text-gray-500">
                  y {atencion.total - atencion.mensajes.length} más en “Qué falta en esta orden”.
                </li>
              )}
            </ul>
          ) : (
            <p className="text-sm text-green-700">✓ {atencion.titulo}</p>
          )}
        </Grupo>
      </div>
    </div>
  )
}
