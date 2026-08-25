'use client'
// B2-DRAWER-SLIM — cabecera conclusiva del drawer.
//
// POR QUÉ NO USA resumenOrden() (B2.6)
//
// El drawer NO carga `ordenes_deposito`: solo lee la orden, el comercio, los
// motorizados y las órdenes activas. Pasarle `{}` como depósitos a
// resumenOrden() haría que lineasDeposito() viera `deposito: null` en una
// orden ya depositada y anunciara "Motorizado debe depositar C$110" sobre un
// depósito confirmado. Una deuda inventada en la vista que el gestor usa para
// decidir rápido es peor que no decir nada.
//
// La alternativa —añadir dos getDoc por cada apertura de drawer, en cinco
// módulos— encarecería una vista cuyo objetivo es justamente ser barata.
//
// Así que acá solo se afirma lo que la ORDEN demuestra por sí sola:
//
//   estado operativo   solicitudes_envio.estado
//   cobro del delivery estadoDeliveryComercio()  — cobroDelivery vive en la orden
//   incidencia         hayIncidenciaSinClasificar() — cobrosMotorizado, ídem
//
// Los depósitos y la trazabilidad completa quedan explícitamente remitidos a
// la ficha. Nunca se dice "sin pendientes": el drawer no puede saberlo.

import Link from 'next/link'
import { AlertTriangle, Wallet, ArrowRight } from 'lucide-react'
import { estadoDeliveryComercio, type EntradaEstadoComercio } from '@/lib/estado-cobro-comercio'
import { hayIncidenciaSinClasificar, type EntradaIncidencia } from '@/lib/incidencia-cobro'
import { rutaOrden, type AnchorOrden } from '@/lib/ruta-orden'

type OrdenRapida = EntradaEstadoComercio & EntradaIncidencia

const money = (n: number) => `C$ ${n.toLocaleString('es-NI')}`

interface Aviso {
  id: string
  texto: string
  anchor: AnchorOrden
}

export function ResumenRapido({
  solicitudId,
  orden,
}: {
  solicitudId: string
  orden: OrdenRapida
}) {
  const avisos: Aviso[] = []

  const cliente = estadoDeliveryComercio(orden)
  if (cliente.clave === 'pendiente' && cliente.montoPendiente > 0) {
    avisos.push({ id: 'cobro', texto: `Comercio debe ${money(cliente.montoPendiente)} de delivery`, anchor: 'cobros' })
  } else if (cliente.clave === 'en_revision' && cliente.montoPendiente > 0) {
    avisos.push({ id: 'revision', texto: `Comprobante del delivery en revisión · ${money(cliente.montoPendiente)}`, anchor: 'cobros' })
  }

  if (hayIncidenciaSinClasificar(orden)) {
    avisos.push({ id: 'incidencia', texto: 'Incidencia de cobro por clasificar', anchor: 'incidencia' })
  }

  const hrefFicha = rutaOrden(solicitudId)

  return (
    <div className="rounded-xl border border-gray-200 bg-white px-4 py-3">
      {avisos.length > 0 ? (
        <>
          <p className="flex items-center gap-1.5 text-[11px] font-bold uppercase tracking-wide text-amber-600 mb-2">
            <AlertTriangle aria-hidden className="h-3.5 w-3.5" />
            Requiere atención
          </p>
          <ul className="space-y-1.5 mb-2">
            {avisos.map((a) => (
              <li key={a.id} className="flex items-start gap-2">
                <Wallet aria-hidden className="mt-0.5 h-3.5 w-3.5 shrink-0 text-amber-600" />
                <span className="text-sm font-semibold text-gray-900">{a.texto}</span>
              </li>
            ))}
          </ul>
        </>
      ) : (
        <p className="text-xs text-gray-500 mb-2">
          Sin cobros ni incidencias abiertas en esta orden.
        </p>
      )}

      {/* El drawer no ve los depósitos: lo dice en vez de afirmar que no hay
          nada pendiente. La ficha sí los tiene, con su trazabilidad. */}
      {hrefFicha && (
        <Link
          href={hrefFicha}
          className="inline-flex items-center gap-1 text-xs font-semibold text-blue-600 hover:underline"
        >
          Ver depósitos y trazabilidad en la ficha
          <ArrowRight aria-hidden className="h-3 w-3" />
        </Link>
      )}
    </div>
  )
}
