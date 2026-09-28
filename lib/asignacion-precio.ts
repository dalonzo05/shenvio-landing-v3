// Precio de formulario no equivale a intención de modificar una confirmación.
export interface SolicitudAsignable {
  id: string
  estado?: string
  updatedAt?: { toMillis?: () => number } | null
  confirmacion?: { precioFinalCordobas?: number | null } | null
}
export const precioConfirmadoValido = (v: unknown): v is number =>
  typeof v === 'number' && Number.isFinite(v) && v > 0

export function precioInicialAsignacion(s: SolicitudAsignable, sugerido: number | null | undefined): number | '' {
  const confirmado = s.confirmacion?.precioFinalCordobas
  if (s.estado !== 'pendiente_confirmacion' && precioConfirmadoValido(confirmado)) return confirmado
  return precioConfirmadoValido(sugerido) ? Math.round(sugerido / 10) * 10 : ''
}

export function precioParaConfirmar(s: SolicitudAsignable, precio: number | '', editado: boolean): { precioEditado: boolean; precioFinal?: number } {
  return {
    precioEditado: editado,
    ...(editado || s.estado === 'pendiente_confirmacion' || !precioConfirmadoValido(s.confirmacion?.precioFinalCordobas)
      ? { precioFinal: precio === '' ? undefined : precio } : {}),
  }
}
