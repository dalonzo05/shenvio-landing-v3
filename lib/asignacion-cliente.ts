import { httpsCallable } from 'firebase/functions'
import { functions } from '@/fb/config'
import { precioParaConfirmar, type SolicitudAsignable } from './asignacion-precio'

export async function guardarAsignacion(
  solicitud: SolicitudAsignable,
  motorizadoId: string | null,
  operacion: 'sugerido' | 'confirmar' | 'reasignar',
  superficie: 'solicitudes' | 'drawer' | 'detalle' | 'baseDatos',
  precio: number | '' = '',
  precioEditado = false,
) {
  const precioPayload = operacion === 'confirmar' ? precioParaConfirmar(solicitud, precio, precioEditado) : { precioEditado: false }
  const payload = {
    solicitudId: solicitud.id, motorizadoId, operacion, superficie,
    estadoEsperado: solicitud.estado ?? '',
    updatedAtEsperado: solicitud.updatedAt?.toMillis?.() ?? null,
    ...precioPayload,
  }
  return httpsCallable(functions, 'asignarMotorizado')(payload)
}

export function errorAsignacion(e: unknown): { mensaje: string; limpiarSeleccion: boolean } {
  const error = e as { code?: string; message?: string; details?: { motivo?: string } }
  const limpiarSeleccion = error?.details?.motivo === 'motorizado_no_elegible'
  return {
    limpiarSeleccion,
    mensaje: limpiarSeleccion
      ? 'El motorizado ya no está disponible para nuevas asignaciones. Selecciona otro motorizado.'
      : error?.code?.startsWith('functions/') && error.message ? error.message : 'No se pudo guardar la asignación.',
  }
}
