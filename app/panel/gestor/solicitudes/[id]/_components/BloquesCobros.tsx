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
import { presentarActor } from '@/lib/actor-resolucion'
import { trazabilidadPago, type EntradaTrazabilidad } from '@/lib/trazabilidad-pago'
import type { DepositoRegistrado, DestinoDeposito } from '@/lib/deposito-orden'

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

export function BloqueCobros({
  orden,
  depositos = {},
}: {
  orden: OrdenFicha
  /** Depósitos que la ficha ya cargó en B2.3. No se consulta nada nuevo. */
  depositos?: Partial<Record<DestinoDeposito, DepositoRegistrado | null>>
}) {
  const entrega = estadoDeliveryComercio(orden)
  const resumen = resumirIncidencia(orden)
  const deducido = esDeliveryDeducido(orden)
  // B2.3B — recorrido del dinero: quién paga → quién recibió → a dónde va.
  const traza = trazabilidadPago(orden as EntradaTrazabilidad, depositos)

  const precio = orden.confirmacion?.precioFinalCordobas ?? null
  const ceAplica = !!orden.cobroContraEntrega?.aplica
  const ceMonto = ceAplica ? (orden.cobroContraEntrega?.monto ?? 0) : null
  const prod = orden.cobrosMotorizado?.producto
  const productoCobrado = prod ? prod.recibio !== false : null

  const etiquetaDelivery: Record<string, string> = {
    // B2.3B: era "Pagado". El campo dice que el cobro se hizo en origen, no
    // que ShEnvíos haya recibido el dinero — llamarlo "Pagado" al lado de un
    // depósito pendiente es lo que hacía parecer incoherente la ficha.
    pagado: 'Cobrado',
    pendiente: `Por cobrar ${money(entrega.montoPendiente)}`,
    en_revision: `${money(entrega.montoPendiente)} en revisión`,
    no_cobrar: 'No se cobra',
    revertido: 'Cobro revertido',
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
            {traza.quienPaga && <Dato label="Quién paga">{traza.quienPaga}</Dato>}
            {/* Cada renglón siguiente aparece solo si hay un campo que lo
                respalde. Un dato ausente se omite; no se rellena con
                "Desconocido" ni se deduce del resto. */}
            {traza.receptor && <Dato label="Recibió el dinero">{traza.receptor.etiqueta}</Dato>}
            {traza.medioPago && <Dato label="Forma de pago">{traza.medioPago}</Dato>}
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

      {/* ── B2.3B · Destino del dinero recaudado ──────────────────────────
          Cierra el recorrido: el motorizado tiene efectivo en la mano y este
          renglón dice de quién es y si ya llegó. El detalle del depósito
          —ID, boucher, actor— sigue siendo autoridad de #depositos. */}
      {traza.destinos.length > 0 && (
        <div className="mt-4 rounded-xl border border-teal-200 bg-teal-50/40 px-4 py-3">
          <div className="flex flex-wrap items-center justify-between gap-2 mb-2.5">
            {/* B2.6 — era "Destino del dinero recaudado". El nombre largo
                describía el mecanismo; este dice de qué se está hablando. */}
            <p className="text-xs font-bold uppercase tracking-wide text-gray-400">
              Dinero recaudado
            </p>
            <a href="#depositos" className="text-[11px] font-semibold text-teal-700 hover:underline">
              Ver depósitos ↓
            </a>
          </div>
          {/* B2.6 — una tarjeta por destino en vez de la fila horizontal
              monto/estado, que apretaba tres datos en un renglón. El monto va
              al frente porque es lo que se lee primero. Contenido idéntico:
              destinos separados, nunca sumados. */}
          <div className="grid gap-2 sm:grid-cols-2">
            {traza.destinos.map((d) => (
              <div key={d.destino} className="rounded-lg border border-teal-200/70 bg-white px-3 py-2">
                <p className="text-base font-black leading-tight text-gray-900">{money(d.monto)}</p>
                <p className="text-xs text-gray-500">→ {d.etiqueta}</p>
                <p className={`text-[11px] font-bold mt-0.5 ${d.tieneDeposito ? 'text-teal-700' : 'text-amber-600'}`}>
                  {d.situacion}
                </p>
              </div>
            ))}
          </div>

          {/* La frase solo se imprime cuando los datos la sostienen: hay
              obligación viva hacia StorkHub, no hay depósito todavía y consta
              que el motorizado recibió el dinero. */}
          {traza.cobradoPeroNoDepositado && (
            <p className="text-[11px] text-gray-500 mt-2.5">
              El delivery ya fue cobrado, pero ese dinero todavía está en manos del motorizado
              y debe depositarse a StorkHub. Por eso «{traza.estadoCliente.etiqueta}» y
              «Pendiente de depósito» no se contradicen.
            </p>
          )}
        </div>
      )}
    </section>
  )
}

// ─── Incidencia ─────────────────────────────────────────────────────────────

export function BloqueIncidencia({
  orden,
  nombresActores = {},
}: {
  orden: OrdenFicha
  /** uid → nombre legible. Vacío mientras la lectura no resolvió. */
  nombresActores?: Record<string, string>
}) {
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
                {/* B2.2 — el actor con nombre legible al frente; el UID queda
                    debajo, en gris y monoespaciado, como rastro de auditoría. */}
                {(() => {
                  const actor = presentarActor(it.resolucion?.resueltoPor, nombresActores[it.resolucion?.resueltoPor ?? ''])
                  return (
                    <div className="flex flex-wrap items-end justify-between gap-x-4 gap-y-1 pt-1">
                      {actor && (
                        <div>
                          <p className="text-xs text-gray-500">Resuelto por</p>
                          <p className="text-sm font-medium text-gray-900">{actor.nombre}</p>
                          <p className="text-[10px] font-mono text-gray-400" title="UID del usuario">
                            ID: {actor.uid.slice(0, 10)}…
                          </p>
                        </div>
                      )}
                      <p className="text-[11px] text-gray-400">{fecha(it.resolucion.at)}</p>
                    </div>
                  )
                })()}
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
