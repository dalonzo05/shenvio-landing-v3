import { httpsCallable } from 'firebase/functions'
import { functions } from '@/fb/config'
import type { IntencionAbono, RespuestaPreparar, ResultadoAbonoServidor } from './abono-directo-ux'
import type { MetodoAbono } from './financial-types'
import { payloadPreparar, payloadRegistrar } from './abono-directo-payload'

// FIN-4C — los ÚNICOS caminos del producto para registrar un abono directo.
//
// La identidad de la INTENCIÓN la crea y la guarda el SERVIDOR (prepararAbonoDirecto): el cliente
// no fabrica operacionId, actor, rol, saldo pendiente ni motorizado. Eso hace que una recarga, otra
// pestaña u otro dispositivo recuperen la misma operación en vez de inventar otra. Sin reintentos
// automáticos: todo reintento es manual y seguro porque las callables son idempotentes.

export interface PeticionPrepararCliente {
  saldoId: string
  monto: number
  metodoAbono: MetodoAbono
  nota?: string
  comprobanteUrl?: string
  comprobantePath?: string
  /** "Ya vi que esta operación quedó aplicada y quiero OTRO abono": la acción explícita de abono nuevo. */
  reconoceOperacionId?: string
}

export interface PeticionAbonoCliente {
  saldoId: string
  monto: number
  /** El que devolvió prepararAbonoDirecto. */
  operacionId: string
  metodoAbono: MetodoAbono
  nota?: string
  comprobanteUrl?: string
  comprobantePath?: string
}

export async function prepararAbonoDirectoServidor(p: PeticionPrepararCliente): Promise<RespuestaPreparar> {
  const r = await httpsCallable<Record<string, unknown>, RespuestaPreparar>(functions, 'prepararAbonoDirecto')(payloadPreparar(p))
  return r.data
}

export async function obtenerIntencionAbonoServidor(saldoId: string): Promise<{ ok: true; intencion: IntencionAbono | null }> {
  const r = await httpsCallable<{ saldoId: string }, { ok: true; intencion: IntencionAbono | null }>(functions, 'obtenerIntencionAbono')({ saldoId })
  return r.data
}

export async function descartarAbonoDirectoServidor(operacionId: string): Promise<{ ok: true; resultado: 'descartada' | 'ya_descartada'; intencion: IntencionAbono }> {
  const r = await httpsCallable<{ operacionId: string }, { ok: true; resultado: 'descartada' | 'ya_descartada'; intencion: IntencionAbono }>(functions, 'descartarIntencionAbono')({ operacionId })
  return r.data
}

export async function registrarAbonoDirectoServidor(p: PeticionAbonoCliente): Promise<ResultadoAbonoServidor> {
  const r = await httpsCallable<Record<string, unknown>, ResultadoAbonoServidor>(functions, 'registrarAbonoDirecto')(payloadRegistrar(p))
  return r.data
}
