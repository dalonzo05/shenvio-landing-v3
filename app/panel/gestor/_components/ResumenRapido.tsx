'use client'
// B2-DRAWER-SLIM — cabecera conclusiva del drawer.
//
// TRAZABILIDAD-DINERO-UX-1 — ahora también habla del depósito.
//
// Antes callaba sobre depósitos por una razón válida: el drawer no carga
// ordenes_deposito, y resumenOrden() con `{}` anunciaba "Motorizado debe
// depositar C$110" sobre un depósito ya confirmado. Pero callar tenía un
// precio que no estaba a la vista: el mensaje de vacío, "Sin cobros ni
// incidencias abiertas en esta orden", se leía como un cierre, y SH-0001 lo
// mostraba mientras el motorizado seguía con C$110 de StorkHub en el bolsillo.
//
// depositoVisible() resuelve el dilema sin leer nada: el puntero de la propia
// orden dice si alguien registró el depósito. Sin puntero y con obligación, la
// deuda es demostrable. Con puntero y sin documento, se dice que existe y se
// remite a la ficha — nunca se afirma su estado.
//
// "Sin pendientes financieros" solo se dice cuando cobro, incidencia y
// depósito están los tres determinados. Si hay un depósito cuyo estado no se
// ve, el mensaje se acota a lo que sí se sabe.
//
// Base de datos, que sí tiene los documentos en cache, los pasa en `depositos`
// y entonces se muestra el estado real.

import Link from 'next/link'
import { AlertTriangle, Wallet, ArrowRight, CheckCircle2 } from 'lucide-react'
import { estadoDeliveryComercio, type EntradaEstadoComercio } from '@/lib/estado-cobro-comercio'
import { hayIncidenciaSinClasificar, type EntradaIncidencia } from '@/lib/incidencia-cobro'
import {
  depositoVisible,
  type DepositoRegistrado,
  type DestinoDeposito,
  type EntradaDepositoOrden,
} from '@/lib/deposito-orden'
import { rutaOrden, type AnchorOrden } from '@/lib/ruta-orden'

type OrdenRapida = EntradaEstadoComercio & EntradaIncidencia & EntradaDepositoOrden

const money = (n: number) => `C$ ${n.toLocaleString('es-NI')}`

interface Aviso {
  id: string
  texto: string
  anchor: AnchorOrden
}

export function ResumenRapido({
  solicitudId,
  orden,
  depositos = {},
}: {
  solicitudId: string
  orden: OrdenRapida
  /** Documentos de ordenes_deposito ya leídos por quien llama. Opcional. */
  depositos?: Partial<Record<DestinoDeposito, DepositoRegistrado | null>>
}) {
  const avisos: Aviso[] = []

  // ── Cobro al cliente ──────────────────────────────────────────────────────
  const cliente = estadoDeliveryComercio(orden)
  if (cliente.clave === 'pendiente' && cliente.montoPendiente > 0) {
    avisos.push({ id: 'cobro', texto: `Comercio debe ${money(cliente.montoPendiente)} de delivery`, anchor: 'cobros' })
  } else if (cliente.clave === 'en_revision' && cliente.montoPendiente > 0) {
    avisos.push({ id: 'revision', texto: `Comprobante del delivery en revisión · ${money(cliente.montoPendiente)}`, anchor: 'cobros' })
  }

  // ── Incidencia ────────────────────────────────────────────────────────────
  if (hayIncidenciaSinClasificar(orden)) {
    avisos.push({ id: 'incidencia', texto: 'Incidencia de cobro por clasificar', anchor: 'incidencia' })
  }

  // ── Depósito: qué pasó después con el dinero ─────────────────────────────
  // Otro tramo del mismo billete. Que el cliente haya pagado no dice que el
  // efectivo haya llegado a su destino. Mismo texto que la ficha completa.
  const dinero = depositoVisible(orden, depositos)
  for (const l of dinero.lineas) {
    const destino = l.destino === 'storkhub' ? 'a StorkHub' : 'al comercio'
    if (l.clave === 'pendiente') {
      avisos.push({
        id: `deposito:${l.destino}`,
        texto: `Motorizado debe depositar ${money(l.obligacion)} ${destino}`,
        anchor: 'depositos',
      })
    } else if (l.clave === 'registrado' && l.estado !== 'confirmado') {
      avisos.push({
        id: `deposito:${l.destino}`,
        texto: `Depósito ${destino}: ${l.texto.toLowerCase()} · ${money(l.obligacion)}`,
        anchor: 'depositos',
      })
    }
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
      ) : dinero.desconocido ? (
        // No se puede afirmar el cierre: hay un depósito que esta vista no leyó.
        <p className="text-xs text-gray-500 mb-2">
          Sin cobros al cliente ni incidencias pendientes.
        </p>
      ) : (
        <p className="flex items-center gap-1.5 text-xs font-semibold text-emerald-700 mb-2">
          <CheckCircle2 aria-hidden className="h-3.5 w-3.5" />
          Sin pendientes financieros en esta orden.
        </p>
      )}

      {dinero.desconocido && (
        <p className="text-xs text-gray-500 mb-2">
          Hay un depósito registrado; su estado se revisa en la ficha.
        </p>
      )}

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
