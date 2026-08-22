'use client'
// B2.2 — Visor de imágenes dentro de la aplicación.
//
// La ficha de orden abría las evidencias con window.open(): sacaba al operador
// del panel y perdía el contexto de la orden. Acá se ven sin salir.
//
// Vive en app/panel/_components/ porque el patrón ya está duplicado en
// SolicitudDrawer y en comercio/mis-ordenes/[id]. B2.2 lo consume solo desde
// la ficha; migrar esas dos implementaciones queda como B2-LIGHTBOX-SHARED,
// para no tocar en este bloque archivos cuyo comportamiento no se valida acá.

import { useEffect } from 'react'
import { X } from 'lucide-react'

export interface ImageLightboxProps {
  url: string
  /** Qué se está viendo: "Retiro", "Entrega"… Se usa como título y como alt. */
  label?: string
  onClose: () => void
}

export function ImageLightbox({ url, label, onClose }: ImageLightboxProps) {
  // Escape cierra. El listener se limpia al desmontar, así que no queda
  // colgado cuando el visor se cierra por cualquiera de las otras vías.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose() }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label={label ? `Evidencia: ${label}` : 'Vista ampliada'}
      className="fixed inset-0 z-50 flex flex-col items-center justify-center gap-3 bg-black/80 backdrop-blur-sm p-4"
      // Click en el overlay cierra; el click sobre la imagen no burbujea.
      onClick={onClose}
    >
      <button
        type="button"
        onClick={onClose}
        aria-label="Cerrar vista ampliada"
        className="absolute top-4 right-4 w-9 h-9 rounded-full bg-white/10 hover:bg-white/20 flex items-center justify-center transition text-white"
      >
        <X size={18} />
      </button>

      {label && (
        <p className="text-sm font-semibold text-white/90">{label}</p>
      )}

      {/* max-h/max-w del viewport + object-contain: entra completa en pantalla,
          en desktop y en móvil, sin deformarse. */}
      {/* eslint-disable-next-line @next/next/no-img-element */}
      <img
        src={url}
        alt={label ? `Evidencia de ${label.toLowerCase()}` : 'Vista ampliada'}
        className="max-w-full max-h-[85vh] object-contain rounded-2xl shadow-2xl"
        onClick={(e) => e.stopPropagation()}
      />
    </div>
  )
}
