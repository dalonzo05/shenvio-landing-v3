'use client'
// B2.1 — Bloques Cobros e Incidencia de la ficha autoritativa de orden.
//
// Vive aparte porque la ficha ya ronda las 1.900 líneas; acá solo hay render.
// Toda la aritmética y la semántica salen de los módulos puros ya testeados:
//
//   lib/estado-cobro-comercio.ts  → estado del delivery
//   lib/incidencia-cobro.ts       → incidencias, resoluciones, reparto del CE
//
// No se consulta ninguna colección nueva: todo sale del documento de la orden
// que la ficha ya tiene cargado.

import {
  estadoDeliveryComercio,
  type EntradaEstadoComercio,
} from '@/lib/estado-cobro-comercio'
import {
  resumirIncidencia,
  detalleIncidencia,
  esDeliveryDeducido,
  type EntradaIncidencia,
} from '@/lib/incidencia-cobro'

type OrdenFicha = EntradaEstadoComercio & EntradaIncidencia

function money(n: number | null | undefined) {
  if (typeof n !== 'number' || !Number.isFinite(n)) return '—'
  return `C$ ${n.toLocaleString('es-NI')}`
}

function fecha(v: unknown): string {
  const t = v as { toDate?: () => Date } | string | null | undefined
  if (!t) return '—'
  const d = typeof t === 'string' ? new Date(t) : t.toDate?.()
  if (!d || Number.isNaN(d.getTime())) return '—'
  return d.toLocaleString('es-NI', { dateStyle: 'medium', timeStyle: 'short' })
}

const Dato = ({ label, children }: { label: string; children: React.ReactNode }) => (
  <div>
    <div className="text-gray-500">{label}</div>
    <div className="font-medium text-gray-900">{children}</div>
  </div>
)

// ─── Cobros ─────────────────────────────────────────────────────────────────

export function BloqueCobros({ orden }: { orden: OrdenFicha }) {
  const entrega = estadoDeliveryComercio(orden)
  const resumen = resumirIncidencia(orden)
  const deducido = esDeliveryDeducido(orden)

  const precio = orden.confirmacion?.precioFinalCordobas ?? null
  const quienPaga = orden.pagoDelivery?.quienPaga || '—'
  const ceAplica = !!orden.cobroContraEntrega?.aplica
  const ceMonto = ceAplica ? (orden.cobroContraEntrega?.monto ?? 0) : null
  const prod = orden.cobrosMotorizado?.producto
  const productoCobrado = prod ? prod.recibio !== false : null

  const etiquetaDelivery: Record<string, string> = {
    pagado: 'Pagado',
    pendiente: `Debe ${money(entrega.montoPendiente)}`,
    en_revision: `${money(entrega.montoPendiente)} en revisión`,
    no_cobrar: 'No se cobra',
    revertido: 'Revertido',
    na: 'Sin registrar',
  }
  const colorDelivery: Record<string, string> = {
    pagado: 'bg-green-50 text-green-700 border-green-200',
    pendiente: 'bg-red-50 text-red-600 border-red-200',
    en_revision: 'bg-blue-50 text-blue-700 border-blue-200',
    no_cobrar: 'bg-gray-100 text-gray-600 border-gray-200',
    revertido: 'bg-gray-100 text-gray-600 border-gray-200',
    na: 'bg-gray-100 text-gray-500 border-gray-200',
  }

  return (
    <section id="cobros" className="scroll-mt-24 rounded-2xl border border-gray-200 bg-white p-5 shadow-sm">
      <h2 className="font-semibold text-gray-900 mb-4">Cobros</h2>

      <div className="grid gap-4 sm:grid-cols-2">
        {/* ── Delivery ── */}
        <div className="rounded-xl border border-gray-200 p-4">
          <div className="flex items-center justify-between mb-3">
            <p className="text-xs font-bold uppercase tracking-wide text-gray-400">Delivery</p>
            <span className={`inline-flex text-[11px] font-bold px-2 py-0.5 rounded-full border ${colorDelivery[entrega.clave]}`}>
              {etiquetaDelivery[entrega.clave]}
            </span>
          </div>
          <div className="space-y-2 text-sm">
            <Dato label="Precio">{money(precio)}</Dato>
            <Dato label="Quién paga">{quienPaga}</Dato>
            <Dato label="Deducido del cobro contra entrega">{deducido ? 'Sí' : 'No'}</Dato>
            {entrega.esParcial && (
              <>
                <Dato label="Cubierto con el cobro contra entrega">{money(entrega.cubiertoPorDeposito)}</Dato>
                <Dato label="Pendiente">{money(entrega.montoPendiente)}</Dato>
              </>
            )}
          </div>
        </div>

        {/* ── Producto / CE ── */}
        <div className="rounded-xl border border-gray-200 p-4">
          <div className="flex items-center justify-between mb-3">
            <p className="text-xs font-bold uppercase tracking-wide text-gray-400">Producto · cobro contra entrega</p>
            {ceAplica && productoCobrado !== null && (
              <span className={`inline-flex text-[11px] font-bold px-2 py-0.5 rounded-full border ${
                productoCobrado ? 'bg-green-50 text-green-700 border-green-200' : 'bg-red-50 text-red-600 border-red-200'
              }`}>
                {/* No se dice "pendiente": este dinero no es cartera de ShEnvíos. */}
                {productoCobrado ? 'Cobrado' : 'No cobrado'}
              </span>
            )}
          </div>
          {!ceAplica ? (
            <p className="text-sm text-gray-400">Esta orden no lleva cobro contra entrega.</p>
          ) : (
            <div className="space-y-2 text-sm">
              <Dato label="Monto">{money(ceMonto)}</Dato>
              {productoCobrado === null
                ? <Dato label="Estado">Pendiente de entrega</Dato>
                : <Dato label="Cobrado al cliente">{productoCobrado ? 'Sí' : 'No'}</Dato>}
            </div>
          )}
        </div>
      </div>

      {/* Reparto interno del CE cuando el delivery sale de ahí. Nunca se suman:
          los C$150 del delivery están DENTRO de los C$500 del CE. */}
      {deducido && resumen.monto > 0 && (
        <div className="mt-4 rounded-xl bg-gray-50 border border-gray-200 px-4 py-3">
          <p className="text-xs font-bold uppercase tracking-wide text-gray-400 mb-2">
            Reparto del cobro contra entrega
          </p>
          <div className="grid grid-cols-3 gap-3 text-sm">
            <Dato label="Total">{money(resumen.monto)}</Dato>
            <Dato label="Delivery ShEnvíos">{money(resumen.componenteDelivery)}</Dato>
            <Dato label="Neto comercio">{money(resumen.componenteComercio)}</Dato>
          </div>
        </div>
      )}
    </section>
  )
}

// ─── Incidencia ─────────────────────────────────────────────────────────────

export function BloqueIncidencia({ orden }: { orden: OrdenFicha }) {
  const items = detalleIncidencia(orden)
  if (items.length === 0) return null

  return (
    <section id="incidencia" className="scroll-mt-24 rounded-2xl border border-amber-200 bg-amber-50/40 p-5 shadow-sm">
      <h2 className="font-semibold text-amber-900 mb-4">Incidencia de cobro</h2>

      <div className="space-y-4">
        {items.map((it) => (
          <div key={it.item} className="rounded-xl border border-amber-200 bg-white p-4">
            <div className="flex flex-wrap items-center justify-between gap-2 mb-3">
              <div className="flex items-center gap-2">
                <span className="inline-flex text-[11px] font-bold px-2 py-0.5 rounded-full bg-amber-100 text-amber-800 border border-amber-200">
                  {it.etiqueta}
                </span>
                <span className="text-base font-black text-gray-900">{money(it.monto)}</span>
              </div>
              <span className="inline-flex text-[11px] font-bold px-2 py-0.5 rounded-full bg-red-50 text-red-600 border border-red-200">
                {it.estado}
              </span>
            </div>

            {/* Justificación completa, sin truncar: es lo que declaró el
                motorizado y suele ser el único contexto del incidente. */}
            {it.justificacion && (
              <div className="mb-3">
                <p className="text-xs text-gray-500 mb-0.5">Justificación del motorizado</p>
                <p className="text-sm text-gray-900 whitespace-pre-wrap break-words">{it.justificacion}</p>
              </div>
            )}

            {it.resolucion ? (
              <div className="rounded-lg bg-gray-50 border border-gray-200 px-3 py-2.5 space-y-1.5">
                <div>
                  <p className="text-xs text-gray-500">Resolución</p>
                  <p className="text-sm font-semibold text-gray-900">{it.textoResolucion}</p>
                </div>
                {it.resolucion.nota && (
                  <div>
                    <p className="text-xs text-gray-500">Nota</p>
                    <p className="text-sm text-gray-900 whitespace-pre-wrap break-words">{it.resolucion.nota}</p>
                  </div>
                )}
                <div className="flex flex-wrap gap-x-4 gap-y-1 text-[11px] text-gray-400 pt-0.5">
                  <span>{fecha(it.resolucion.at)}</span>
                  {/* UID en secundario: resolverlo a nombre exigiría una query
                      nueva y B2.1 no agrega ninguna (ver B2-ACTOR-NOMBRE). */}
                  {it.resolucion.resueltoPor && (
                    <span className="font-mono" title="UID de quien resolvió">
                      {it.resolucion.resueltoPor.slice(0, 10)}…
                    </span>
                  )}
                </div>
              </div>
            ) : (
              <p className="text-xs font-semibold text-amber-700">Sin clasificar por el gestor</p>
            )}

            <p className="text-[11px] text-gray-400 mt-2.5">
              {it.esCuentaPorCobrarShenvios
                ? 'El delivery ya prestado es una cuenta por cobrar de ShEnvíos.'
                : 'Este dinero corresponde al comercio y su cliente; ShEnvíos solo lo deja registrado.'}
            </p>
          </div>
        ))}
      </div>
    </section>
  )
}
