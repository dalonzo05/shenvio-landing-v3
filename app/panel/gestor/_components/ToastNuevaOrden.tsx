'use client'

import { useEffect, useState, useCallback } from 'react'
import Link from 'next/link'
import { X, Package, MapPin, ArrowRight } from 'lucide-react'

// ─── Tipo compartido con layout.tsx ───────────────────────────────────────────
export type ToastData = {
  id: string          // ID único del toast (no del pedido)
  solicitudId: string // ID del documento en Firestore
  comercio: string    // ownerSnapshot.companyName || ownerSnapshot.nombre
  zona: string        // zonaEntregaNombre
  direccion: string   // entrega.direccionEscrita
  createdAt: number   // Date.now() al crear el toast
}

const DURATION_MS = 6000

// ─── Toast individual ─────────────────────────────────────────────────────────
function ToastItem({
  toast,
  onDismiss,
}: {
  toast: ToastData
  onDismiss: (id: string) => void
}) {
  const [exiting, setExiting] = useState(false)

  const dismiss = useCallback(() => {
    setExiting(true)
    setTimeout(() => onDismiss(toast.id), 280)
  }, [toast.id, onDismiss])

  // Auto-dismiss
  useEffect(() => {
    const exitTimer = setTimeout(() => setExiting(true), DURATION_MS - 300)
    const removeTimer = setTimeout(() => onDismiss(toast.id), DURATION_MS)
    return () => {
      clearTimeout(exitTimer)
      clearTimeout(removeTimer)
    }
  }, [toast.id, onDismiss])

  return (
    <div
      style={{
        animation: exiting
          ? 'toast-exit 280ms ease-in forwards'
          : 'toast-enter 280ms ease-out forwards',
        willChange: 'transform, opacity',
      }}
      className="relative w-[340px] overflow-hidden rounded-xl border border-gray-200 bg-white shadow-lg shadow-black/10"
    >
      {/* Barra de progreso */}
      <div className="absolute top-0 left-0 right-0 h-[3px] bg-gray-100">
        <div
          className="h-full bg-[#004aad] rounded-full origin-left"
          style={{
            animation: `toast-progress ${DURATION_MS}ms linear forwards`,
            willChange: 'width',
          }}
        />
      </div>

      <div className="px-4 pt-5 pb-4">
        {/* Encabezado */}
        <div className="flex items-start justify-between gap-2">
          <div className="flex items-center gap-2.5">
            <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-[#004aad]/10">
              <Package size={16} className="text-[#004aad]" />
            </div>
            <div>
              <p className="text-[11px] font-semibold uppercase tracking-wider text-[#004aad]">
                Nuevo envío recibido
              </p>
              <p className="text-sm font-bold text-gray-900 leading-tight">
                {toast.comercio}
              </p>
            </div>
          </div>
          <button
            onClick={dismiss}
            className="shrink-0 rounded-md p-1 text-gray-400 transition hover:bg-gray-100 hover:text-gray-600"
            aria-label="Cerrar notificación"
          >
            <X size={14} />
          </button>
        </div>

        {/* Zona + dirección */}
        {(toast.zona || toast.direccion) && (
          <div className="mt-3 flex items-start gap-2 text-xs text-gray-500">
            <MapPin size={12} className="mt-0.5 shrink-0 text-gray-400" />
            <span className="leading-snug">
              {toast.zona && (
                <span className="font-semibold text-gray-700">{toast.zona}</span>
              )}
              {toast.zona && toast.direccion && ' · '}
              {toast.direccion && (
                <span className="truncate">{toast.direccion}</span>
              )}
            </span>
          </div>
        )}

        {/* CTA */}
        <div className="mt-3.5 flex justify-end">
          <Link
            href="/panel/gestor/solicitudes"
            onClick={dismiss}
            className="inline-flex items-center gap-1.5 rounded-lg bg-[#004aad] px-3.5 py-1.5 text-xs font-semibold text-white transition hover:bg-[#003a8c] active:scale-95"
          >
            Ver solicitudes
            <ArrowRight size={12} />
          </Link>
        </div>
      </div>
    </div>
  )
}

// ─── Contenedor de toasts (fixed, esquina inferior derecha) ──────────────────
export function ToastNuevaOrden({
  toasts,
  onDismiss,
}: {
  toasts: ToastData[]
  onDismiss: (id: string) => void
}) {
  if (toasts.length === 0) return null

  return (
    <div
      className="fixed bottom-16 right-4 z-50 flex flex-col-reverse gap-2 pointer-events-none"
      aria-live="polite"
      aria-atomic="false"
      aria-label="Notificaciones de nuevos envíos"
    >
      {toasts.map((t) => (
        <div key={t.id} className="pointer-events-auto">
          <ToastItem toast={t} onDismiss={onDismiss} />
        </div>
      ))}
    </div>
  )
}
