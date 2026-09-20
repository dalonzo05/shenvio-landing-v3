// DEPOSITO-AUDITORIA-1 — "Pedir corrección" y "Anular": corregir sin borrar.
//
// Lo que había en F1, y por qué no servía:
//
//   Gestor → "Devolver al motorizado"   delete del DEP + punteros de las
//                                       órdenes a null
//   Admin  → "Eliminar"                 delete del DEP (+ liberar órdenes)
//
// Las dos acciones borraban el documento. Con eso se iba el DEP-N que el
// trigger repartió una sola vez, el comprobante que el motorizado ya había
// mandado, la lista de órdenes que agrupaba, el monto y —sobre todo— el
// motivo: nadie podía decir después por qué se había pedido otra foto, ni
// quién la pidió, ni cuándo. El motorizado veía desaparecer su depósito y sus
// órdenes volver a "Por depositar", sin una línea que explicara nada.
//
// F2 las reemplaza por dos transiciones de ESTADO, ambas con actor, hora y
// motivo, y ninguna con delete:
//
//   en_revision → devuelto    "Pedir corrección". El DEP sigue siendo el
//                             mismo: mismo id, mismo DEP-N, mismo monto,
//                             mismas órdenes, mismos punteros, y el boucher
//                             anterior sigue ahí. Solo falta una foto mejor.
//
//   cualquiera  → anulado     "Anular". El DEP está estructuralmente mal y
//                             hay que rehacerlo, pero queda como RASTRO. Las
//                             órdenes pueden liberarse (misma semántica que
//                             el viejo Eliminar); el documento, nunca.
//
// ─── devuelto NO es rechazo ───────────────────────────────────────────────
//
// 'devuelto' significa una cosa y solo una: StorkHub pidió una corrección del
// comprobante. No es deuda, no es anulación, no es cancelación, y no es el
// 'rechazado' que ya existía (terminal para el digitador). Todo lo que
// identifica al depósito se conserva; lo único que se agrega es por qué está
// esperando.
//
// ─── Cuándo cada una ──────────────────────────────────────────────────────
//
//   Pedir corrección   el DEP es correcto, la EVIDENCIA no. Monto, órdenes,
//                      destinatario y punteros se mantienen.
//   Anular             el DEP es incorrecto y hay que rehacerlo. Queda como
//                      rastro; las órdenes se liberan si no hay saldo vivo.
//
// PURO: sin Firestore, sin React. El sello de tiempo lo pasa quien llama.

import type { DepositoRegistrado } from './deposito-orden'
import { asegurarMotivoEvento, normalizarMotivoEvento } from './deposito-eventos'
import { presentarActor, type ActorPresentado } from './actor-resolucion'

// ─── Estado ───────────────────────────────────────────────────────────────────

export const ESTADO_DEVUELTO = 'devuelto'

/** Cómo se llama 'devuelto' en pantalla. Nunca "Rechazado", nunca "Devuelto". */
export const ETIQUETA_DEVUELTO = 'Corrección solicitada'

/**
 * Estados de los que "Pedir corrección" puede salir.
 *
 * Solo 'en_revision': es el único momento en el que hay algo que revisar y
 * todavía no se decidió nada. Desde 'pendiente_boucher' no hay comprobante que
 * corregir, y los sellados no se reabren por esta vía (para eso está Rehacer,
 * que es de admin).
 */
export const ESTADOS_PEDIR_CORRECCION: readonly string[] = ['en_revision']

type DepAccion = Pick<DepositoRegistrado, 'tipo' | 'estado'>

const esTipoAB = (dep: DepAccion | null | undefined): boolean =>
  dep?.tipo === 'recaudacion_motorizado_storkhub' || dep?.tipo === 'recaudacion_motorizado_comercio'

/**
 * ¿Se le puede pedir corrección a este depósito?
 *
 * Tipo C (pago_delivery_deposito) queda FUERA por diseño: ese documento es el
 * registro del pago de una orden ya pagada, no el comprobante de un
 * motorizado. Su corrección es Revertir, en Cobros, que anula el DEP y el
 * movimiento juntos. Meterlo acá inventaría un flujo paralelo sobre dinero ya
 * conciliado.
 */
export function puedePedirCorreccion(dep: DepAccion | null | undefined): boolean {
  return esTipoAB(dep) && ESTADOS_PEDIR_CORRECCION.includes(dep?.estado ?? '')
}

/** Un depósito devuelto no se confirma: primero tiene que llegar la foto. */
export function puedeConfirmarDeposito(dep: DepAccion | null | undefined): boolean {
  return dep?.estado !== ESTADO_DEVUELTO
}

// ─── Campos de "Pedir corrección" ─────────────────────────────────────────────

/**
 * Lo que escribe el gestor al pedir una corrección. Lista cerrada: es
 * exactamente la que firestore.rules acepta con hasOnly().
 *
 * Lo que NO está acá es tan importante como lo que está: boucher, montoTotal,
 * solicitudIds, motorizadoUid, tipo, destinatario, codigo y los punteros de
 * las órdenes no se tocan. El depósito no cambia de identidad porque le falte
 * una foto.
 */
export function camposPedirCorreccion<T>(
  uid: string | null | undefined,
  ahora: T,
  motivo: string,
  eventoId: string,
): Record<string, unknown> {
  const actor = typeof uid === 'string' ? uid.trim() : ''
  if (!actor) throw new Error('camposPedirCorreccion: falta el UID de quien pide la corrección')
  return {
    estado: ESTADO_DEVUELTO,
    devueltoAt: ahora,
    devueltoPorUid: actor,
    motivoDevolucion: asegurarMotivoEvento(motivo),
    updatedAt: ahora,
    ultimoEventoId: eventoId,
  }
}

// ─── Campos de "Anular" ───────────────────────────────────────────────────────

/**
 * Lo que escribe el admin al anular. Reemplaza al delete físico del viejo
 * "Eliminar": mismo efecto operativo, cero pérdida de rastro.
 *
 * Reutiliza los MISMOS nombres de campo que ya usaba la anulación de un DEP
 * tipo C al revertir un cobro (camposAnulacionDeposito en cobro-integridad),
 * para que Auditoría no tenga que conocer dos formas de lo mismo.
 */
export function camposAnularDeposito<T>(
  uid: string | null | undefined,
  ahora: T,
  motivo: string,
  eventoId: string,
): Record<string, unknown> {
  const actor = typeof uid === 'string' ? uid.trim() : ''
  if (!actor) throw new Error('camposAnularDeposito: falta el UID de quien anula')
  return {
    estado: 'anulado',
    anuladoAt: ahora,
    anuladoPorUid: actor,
    motivoAnulacion: asegurarMotivoEvento(motivo),
    updatedAt: ahora,
    ultimoEventoId: eventoId,
  }
}

/**
 * Campos de una confirmación AUDITADA.
 *
 * HARDENING — `ultimoEventoId` es lo que permite a firestore.rules exigir el
 * evento DEPOSITO_CONFIRMADO en el mismo batch. Sin él la regla no puede
 * nombrar el documento del evento y la auditoría volvería a depender de que
 * el writer quiera escribirla.
 *
 * No lleva motivo: confirmar no deshace nada, es el flujo normal. Lo que sí
 * tiene que quedar es quién y cuándo.
 */
export function camposConfirmarDeposito<T>(
  uid: string | null | undefined,
  ahora: T,
  eventoId: string,
): Record<string, unknown> {
  const actor = typeof uid === 'string' ? uid.trim() : ''
  if (!actor) throw new Error('camposConfirmarDeposito: falta el UID de quien confirma')
  if (typeof eventoId !== 'string' || eventoId.trim() === '') {
    throw new Error('camposConfirmarDeposito: falta el id del evento de auditoría')
  }
  return {
    estado: 'confirmado',
    confirmadoPorUid: actor,
    confirmadoAt: ahora,
    ultimoEventoId: eventoId,
  }
}

/** Campos del Rehacer auditado: el estado ya lo escribía F1; el motivo no. */
export function camposRehacerDeposito<T>(
  uid: string | null | undefined,
  ahora: T,
  motivo: string,
  eventoId: string,
): Record<string, unknown> {
  const actor = typeof uid === 'string' ? uid.trim() : ''
  if (!actor) throw new Error('camposRehacerDeposito: falta el UID de quien rehace')
  return {
    estado: 'en_revision',
    rehechoAt: ahora,
    rehechoPorUid: actor,
    motivoRehacer: asegurarMotivoEvento(motivo),
    updatedAt: ahora,
    ultimoEventoId: eventoId,
  }
}

// ─── Presentación de la corrección solicitada ─────────────────────────────────

export interface CorreccionSolicitada {
  motivo: string
  /** `devueltoAt` crudo; la página lo formatea con sus propios helpers. */
  at: unknown
  /** Nombre resuelto, o "Usuario interno". Nunca un UID al frente. */
  actor: ActorPresentado | null
}

type DepDevuelto = Pick<DepositoRegistrado, 'estado' | 'motivoDevolucion' | 'devueltoAt' | 'devueltoPorUid'>

/**
 * Los datos de la corrección VIGENTE, o null.
 *
 * Solo mientras el depósito siga 'devuelto': una vez que el motorizado manda
 * la versión nueva, el documento conserva `motivoDevolucion` como historial
 * —y ahí sigue, en los eventos— pero la pantalla ya no está esperando nada.
 * Mismo criterio que confirmadorDeposito()/fechasDeposito() aplican al
 * confirmador de un depósito reabierto.
 */
export function correccionSolicitada(
  dep: DepDevuelto | null | undefined,
  nombres: Record<string, string> = {},
): CorreccionSolicitada | null {
  if (dep?.estado !== ESTADO_DEVUELTO) return null
  const motivo = normalizarMotivoEvento(dep?.motivoDevolucion)
  const uid = typeof dep?.devueltoPorUid === 'string' ? dep.devueltoPorUid.trim() : ''
  return {
    motivo,
    at: dep?.devueltoAt ?? null,
    actor: uid ? presentarActor(uid, nombres[uid]) : null,
  }
}

/** Lo que el motorizado lee cuando le piden una corrección. */
export const TEXTO_ESPERANDO_CORRECCION = 'Esperando nuevo comprobante.'
export const BOTON_SUBIR_CORRECCION = 'Subir nuevo comprobante'
export const BOTON_CORREGIR_COMPROBANTE = 'Corregir comprobante'
export const BOTON_PEDIR_CORRECCION = 'Pedir corrección'

// ─── Acciones del gestor / admin sobre un depósito ────────────────────────────

export interface AccionesDeposito {
  /** Gestor y admin, solo sobre un A/B en revisión. */
  pedirCorreccion: boolean
  /** Admin, y nunca sobre un tipo C ni sobre un convertido en deuda. */
  rehacer: boolean
  /** Admin. Reemplaza al viejo "Eliminar" — ya no hay delete físico. */
  anular: boolean
}

/**
 * Qué puede hacer este usuario con este depósito.
 *
 * Tipo C queda fuera de las tres: su corrección es Revertir, en Cobros.
 * Rehacer sigue sin aplicar a un convertido en deuda (el saldo vive en
 * saldos_cargo_motorizado y esto no lo anula — misma razón que
 * eliminarLiberaOrdenes()).
 */
export function accionesDeposito(
  dep: DepAccion | null | undefined,
  rol: string | null | undefined,
): AccionesDeposito {
  const ab = esTipoAB(dep)
  const admin = rol === 'admin'
  const staff = admin || rol === 'gestor'
  return {
    pedirCorreccion: ab && staff && puedePedirCorreccion(dep),
    rehacer: ab && admin && dep?.estado !== 'convertido_en_deuda' && dep?.estado !== 'anulado',
    anular: ab && admin && dep?.estado !== 'anulado',
  }
}
