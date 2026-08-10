// app/s/[token]/page.tsx
//
// Vista temporal pública de comercio. Server Component puro — sin Firebase
// Auth, sin Firestore/Storage client SDK. El token es la única credencial.
// Todo el trabajo de autorización y construcción de datos vive en
// lib/temporary-access.ts; esta página solo valida, arma el HTML y — en el
// único punto donde corresponde — llama a registrarAccesoVista (D5: una vez
// por apertura de vista, nunca desde el endpoint de evidencia).

import type { Metadata } from 'next'
import { headers } from 'next/headers'
import { adminDb } from '@/fb/admin'
import {
  validarAcceso,
  registrarAccesoVista,
  construirVistaComercio,
  crearLimitadorDeTasa,
  type VistaComercioTemporal,
} from '@/lib/temporary-access'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

// Sección 6 (auditoría final): rate limit de la vista principal, mismo
// helper y mismo patrón module-scope ya usado en
// app/api/access/[token]/evidence/[kind]/route.ts. Un Server Component no
// recibe un NextRequest, pero headers() de next/headers expone la misma
// cabecera x-forwarded-for de forma soportada — no hace falta arquitectura
// nueva. 30/min por IP es holgado para un usuario real (nadie recarga la
// vista 30 veces en un minuto) y limita el barrido de tokens al vuelo; la
// autorización real sigue siendo el token de 256 bits + expiración/revocación.
const superaRateLimit = crearLimitadorDeTasa(30, 60_000)

async function ipDelRequest(): Promise<string> {
  const hdrs = await headers()
  return hdrs.get('x-forwarded-for')?.split(',')[0]?.trim() || 'unknown'
}

// Sección 23: metadata genérica, sin datos de la orden — nunca el nombre del
// cliente, dirección, monto o comercio en <title>/OpenGraph.
export const metadata: Metadata = {
  title: 'Seguimiento de envío | ShEnvíos',
  description: 'Consultá el estado de tu envío.',
  robots: { index: false, follow: false, nocache: true },
}

function fmt(n: number | null | undefined) {
  if (typeof n !== 'number') return '—'
  return `C$ ${n.toLocaleString('es-NI')}`
}

function fmtDatetime(ms: number | null) {
  if (ms == null) return '—'
  return new Date(ms).toLocaleString('es-NI', {
    day: '2-digit', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit',
  })
}

const EVIDENCE_LABEL: Record<string, string> = {
  retiro: 'Foto de retiro',
  entrega: 'Foto de entrega',
  'terminal-paquete': 'Paquete en terminal',
  'terminal-ticket': 'Ticket de terminal',
  'terminal-bus': 'Bus / transporte',
  'cargotrans-factura': 'Factura Cargotrans',
  'delivery-boucher': 'Comprobante de transferencia',
}
function labelEvidencia(kind: string): string {
  if (EVIDENCE_LABEL[kind]) return EVIDENCE_LABEL[kind]
  if (kind.startsWith('cargotrans-paquete-')) return `Paquete ${kind.split('-').pop()}`
  return kind
}

function NoDisponible() {
  return (
    <div className="min-h-screen flex items-center justify-center bg-gray-50 px-4">
      <div className="max-w-sm text-center">
        <p className="text-lg font-bold text-gray-900 mb-2">Este enlace ya no está disponible</p>
        <p className="text-sm text-gray-500">
          Puede haber expirado o haber sido revocado. Contactá a quien te lo compartió para solicitar uno nuevo.
        </p>
      </div>
    </div>
  )
}

export default async function VistaTemporalComercioPage({
  params,
}: {
  params: Promise<{ token: string }>
}) {
  const { token } = await params

  if (!token || token.length > 128) return <NoDisponible />

  if (superaRateLimit(await ipDelRequest())) return <NoDisponible />

  const resultado = await validarAcceso(token)
  if (!resultado.ok) return <NoDisponible />
  const { acceso } = resultado

  const solicitudSnap = await adminDb.collection('solicitudes_envio').doc(acceso.solicitudId).get()
  if (!solicitudSnap.exists) return <NoDisponible />

  const vista = construirVistaComercio(acceso.solicitudId, solicitudSnap.data() ?? {})

  // Una sola vez por apertura de vista — nunca desde el endpoint de evidencia.
  await registrarAccesoVista(acceso.id)

  return <VistaComercio vista={vista} token={token} />
}

function VistaComercio({ vista, token }: { vista: VistaComercioTemporal; token: string }) {
  return (
    <div className="min-h-screen bg-gray-50 px-4 py-8">
      <div className="max-w-2xl mx-auto flex flex-col gap-4">

        <div className="text-center mb-2">
          <p className="text-xl font-black text-[#004aad]">StorkHub</p>
          <p className="text-xs text-gray-400">Seguimiento temporal de envío</p>
        </div>

        <div className="rounded-2xl border border-gray-200 bg-white shadow-sm p-5">
          <p className="text-xs font-semibold text-gray-400 uppercase tracking-wide mb-1">Orden</p>
          <h1 className="text-lg font-black text-gray-900 font-mono">#{vista.id.slice(0, 10)}</h1>
          {vista.createdAt && <p className="text-xs text-gray-400 mt-1">{fmtDatetime(vista.createdAt)}</p>}
          <span className="inline-flex mt-2 text-xs font-bold px-3 py-1.5 rounded-full bg-blue-50 text-blue-700">
            {vista.estadoLabel}
          </span>
        </div>

        {vista.rechazo && (
          <div className="rounded-2xl border border-red-200 bg-red-50 p-4">
            <p className="text-sm font-bold text-red-700 mb-1">Solicitud rechazada</p>
            {vista.rechazo.motivoTexto && <p className="text-sm text-red-600">{vista.rechazo.motivoTexto}</p>}
            {vista.rechazo.detalle && <p className="text-xs text-red-500 mt-1">{vista.rechazo.detalle}</p>}
          </div>
        )}

        <div className="rounded-2xl border border-gray-200 bg-white shadow-sm overflow-hidden">
          <div className="px-4 py-3 bg-blue-50 border-b border-blue-100">
            <h2 className="text-xs font-bold uppercase tracking-wide text-[#004aad]">Ruta</h2>
          </div>
          <div className="p-4 space-y-4">
            <div>
              <p className="text-[10px] font-bold text-amber-600 uppercase tracking-wide mb-1">Retiro</p>
              <p className="text-sm font-bold text-gray-900">{vista.ruta.recoleccion.nombreApellido || '—'}</p>
              <p className="text-sm text-gray-600">{vista.ruta.recoleccion.direccionEscrita || '—'}</p>
            </div>
            {vista.ruta.fueraManagua ? (
              <div>
                <p className="text-[10px] font-bold text-violet-600 uppercase tracking-wide mb-1">
                  {vista.ruta.fueraManagua.metodoEnvio === 'cargotrans' ? 'Sucursal Cargotrans' : 'Terminal / Bus'}
                </p>
                <p className="text-sm font-bold text-gray-900">{vista.ruta.fueraManagua.puntoLogisticoNombre || vista.ruta.fueraManagua.terminalSugerida || '—'}</p>
                {vista.ruta.fueraManagua.destinoFinal && <p className="text-sm text-violet-700 font-semibold">Destino: {vista.ruta.fueraManagua.destinoFinal}</p>}
                {vista.ruta.fueraManagua.direccionPuntoLogistico && <p className="text-xs text-gray-500 mt-1">{vista.ruta.fueraManagua.direccionPuntoLogistico}</p>}
              </div>
            ) : (
              <div>
                <p className="text-[10px] font-bold text-green-600 uppercase tracking-wide mb-1">Entrega</p>
                <p className="text-sm font-bold text-gray-900">{vista.ruta.entrega.nombreApellido || '—'}</p>
                <p className="text-sm text-gray-600">{vista.ruta.entrega.direccionEscrita || '—'}</p>
              </div>
            )}
            {vista.ruta.detalle && (
              <div className="pt-2 border-t border-gray-100">
                <p className="text-[10px] font-bold text-gray-400 uppercase tracking-wide mb-1">Instrucciones</p>
                <p className="text-sm text-gray-600">{vista.ruta.detalle}</p>
              </div>
            )}
          </div>
        </div>

        <div className="rounded-2xl border border-gray-200 bg-white shadow-sm overflow-hidden">
          <div className="px-4 py-3 bg-blue-50 border-b border-blue-100">
            <h2 className="text-xs font-bold uppercase tracking-wide text-[#004aad]">Resumen de cobros</h2>
          </div>
          <div className="p-4 space-y-3">
            <div className="flex items-center justify-between">
              <div>
                <p className="text-sm font-semibold text-gray-900">Delivery</p>
                <p className="text-xs text-gray-400">{vista.financiero.delivery.label}</p>
              </div>
              <p className="text-base font-black text-[#004aad]">{fmt(vista.financiero.delivery.monto)}</p>
            </div>
            {vista.financiero.cobroContraEntrega && (
              <div className="flex items-center justify-between pt-3 border-t border-gray-100">
                <div>
                  <p className="text-sm font-semibold text-gray-900">Cobro del producto</p>
                  <p className="text-xs text-gray-400">
                    {vista.financiero.cobroContraEntrega.recibido === true ? '✓ Cobrado'
                      : vista.financiero.cobroContraEntrega.recibido === false ? 'No cobrado aún'
                      : 'Pendiente de entrega'}
                  </p>
                </div>
                <p className="text-base font-black text-purple-700">{fmt(vista.financiero.cobroContraEntrega.monto)}</p>
              </div>
            )}
          </div>
        </div>

        {vista.motorizado && (
          <div className="rounded-2xl border border-gray-200 bg-white shadow-sm p-4 flex items-center gap-4">
            <div className="w-12 h-12 rounded-2xl bg-[#004aad]/10 grid place-items-center overflow-hidden border border-gray-200 flex-shrink-0">
              {vista.motorizado.tieneFoto ? (
                // eslint-disable-next-line @next/next/no-img-element
                <img src={`/api/access/${token}/evidence/motorizado-foto`} alt={vista.motorizado.nombre} className="w-full h-full object-cover" />
              ) : (
                <span className="text-lg font-black text-[#004aad]">{vista.motorizado.nombre[0]?.toUpperCase()}</span>
              )}
            </div>
            <div>
              <p className="text-xs text-gray-400">Motorizado asignado</p>
              <p className="text-sm font-bold text-gray-900">{vista.motorizado.nombre}</p>
            </div>
          </div>
        )}

        {vista.evidenciasDisponibles.length > 0 && (
          <div className="rounded-2xl border border-gray-200 bg-white shadow-sm overflow-hidden">
            <div className="px-4 py-3 bg-green-50 border-b border-green-100">
              <h2 className="text-xs font-bold uppercase tracking-wide text-green-700">Evidencias</h2>
            </div>
            <div className="p-4 grid grid-cols-2 gap-3">
              {vista.evidenciasDisponibles.map((kind) => {
                const src = `/api/access/${token}/evidence/${kind}`
                return (
                  <a key={kind} href={src} target="_blank" rel="noopener noreferrer" className="flex flex-col items-center gap-2 group">
                    {/* eslint-disable-next-line @next/next/no-img-element */}
                    <img
                      src={src}
                      alt={labelEvidencia(kind)}
                      className="w-full aspect-square object-cover rounded-xl border border-green-200 group-hover:opacity-90 transition"
                      loading="lazy"
                    />
                    <span className="text-xs text-green-700 font-semibold text-center">{labelEvidencia(kind)}</span>
                  </a>
                )
              })}
            </div>
          </div>
        )}

        {vista.timeline.length > 0 && (
          <div className="rounded-2xl border border-gray-200 bg-white shadow-sm overflow-hidden">
            <div className="px-4 py-3 bg-gray-50 border-b border-gray-100">
              <h2 className="text-xs font-bold uppercase tracking-wide text-gray-600">Historial</h2>
            </div>
            <div className="p-4">
              <ol className="space-y-0">
                {vista.timeline.map((t, i) => {
                  const isLast = i === vista.timeline.length - 1
                  return (
                    <li key={t.key} className="flex items-start gap-3">
                      <div className="flex flex-col items-center flex-shrink-0">
                        <div className={`w-3 h-3 rounded-full mt-1 ${isLast ? 'bg-[#004aad] ring-2 ring-blue-200' : 'bg-gray-300'}`} />
                        {!isLast && <div className="w-px bg-gray-200 flex-1 min-h-[24px]" />}
                      </div>
                      <div className="pb-4">
                        <p className={`text-sm font-semibold ${isLast ? 'text-[#004aad]' : 'text-gray-700'}`}>{t.label}</p>
                        <p className="text-xs text-gray-400 mt-0.5">{fmtDatetime(t.at)}</p>
                      </div>
                    </li>
                  )
                })}
              </ol>
            </div>
          </div>
        )}

        <p className="text-center text-[11px] text-gray-300 mt-2">
          Enlace temporal — dejará de funcionar automáticamente.
        </p>
      </div>
    </div>
  )
}
