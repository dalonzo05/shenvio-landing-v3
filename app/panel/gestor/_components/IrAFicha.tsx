'use client'
// B2.5 — acceso a la ficha autoritativa desde cualquier módulo interno.
//
// Varios listados abrían la orden solo en SolicitudDrawer, que es un resumen:
// para entender un cobro, un depósito o un movimiento había que buscar la
// orden a mano. Este enlace convive con el drawer en vez de reemplazarlo —
// chip = consulta rápida, flecha = ficha completa— para no cambiar el
// comportamiento que el gestor ya tiene aprendido.
//
// Solo navegación: sin estado, sin queries, sin router. La ruta la construye
// lib/ruta-orden.ts, que también decide cuándo NO hay ruta posible.

import Link from 'next/link'
import { rutaOrden, type AnchorOrden } from '@/lib/ruta-orden'

export function IrAFicha({
  id,
  anchor,
  className = '',
}: {
  id: string | null | undefined
  anchor?: AnchorOrden
  className?: string
}) {
  const href = rutaOrden(id, anchor)
  // Sin ID no se pinta nada: un link muerto es peor que ningún link.
  if (!href) return null
  return (
    <Link
      href={href}
      title={`Ver ficha completa · ${id}`}
      aria-label={`Ver ficha completa de la orden ${id}`}
      className={`rounded px-1 text-[11px] font-bold text-blue-600 hover:bg-blue-100 hover:text-blue-800 transition ${className}`}
    >
      ↗
    </Link>
  )
}
