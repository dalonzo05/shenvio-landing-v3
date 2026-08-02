'use client'

import { useEffect, useMemo, useRef, useState } from 'react'
import {
  collection,
  onSnapshot,
  query,
  where,
  doc,
  getDoc,
  getDocs,
  updateDoc,
  serverTimestamp,
  Timestamp,
  writeBatch,
  runTransaction,
  deleteField,
} from 'firebase/firestore'
import { auth, db } from '@/fb/config'
import { registrarMovimiento } from '@/lib/financial-writes'
import {
  AlertCircle,
  ShieldCheck,
  CheckCircle2,
  X,
  CreditCard,
  Banknote,
  ArrowRightLeft,
  ChevronDown,
  ChevronUp,
  Upload,
} from 'lucide-react'
import { compressImage, uploadEvidenciaPath } from '@/fb/storage'

// ─── Types ────────────────────────────────────────────────────────────────────

type CobroItem = {
  monto: number
  recibio: boolean
  at?: Timestamp
  justificacion?: string
}

type Resolucion = {
  resueltoPor: string
  at: Timestamp
  nota?: string
  tipo?: 'cliente_pagara' | 'se_pierde'
}

type CobroDelivery = {
  monto: number
  tipoCliente: 'contado' | 'credito'
  quienPaga: string
  estado: 'pendiente' | 'pagado' | 'no_cobrar' | 'en_revision_deposito'
  registradoAt?: Timestamp
  pagadoAt?: Timestamp
  semanaKey?: string
  formaPago?: 'efectivo' | 'transferencia' | string
  notaPago?: string
  boucherUrl?: string
  boucherPath?: string
  boucherAt?: Timestamp
  // Referencia al movimiento pago_recibido creado atómicamente junto con el
  // pago (ver marcarGrupoPagado / revertirPagada). Ausente en registros
  // pagados antes de esta corrección — revertirPagada resuelve esos casos
  // por búsqueda legacy (solicitudId + tipo + estado activo).
  movimientoPagoId?: string
}

type Solicitud = {
  id: string
  createdAt?: Timestamp
  entregadoAt?: Timestamp
  cobroPendiente?: boolean
  cobroDelivery?: CobroDelivery
  ownerSnapshot?: { uid?: string; companyName?: string; nombre?: string }
  userId?: string
  tipoCliente?: 'contado' | 'credito'
  pagoDelivery?: { quienPaga?: string; tipo?: string }
  asignacion?: { motorizadoNombre?: string; motorizadoId?: string } | null
  cobrosMotorizado?: {
    delivery?: CobroItem
    producto?: CobroItem
    resolucion?: Resolucion
  }
}

type CobroSemanal = {
  id: string
  // clienteUid es el comercioId estable del comercio facturado por crédito
  // semanal (NUNCA un Auth UID ni un cliente final distinto) — ver nota de
  // identidad estable en lib/financial-types.ts. Nombre engañoso, candidato a
  // normalizar a comercioId en una limpieza futura (no renombrar todavía).
  clienteUid: string
  clienteNombre: string
  clienteCompany: string
  semanaKey: string
  semanaInicio?: Timestamp
  semanaFin?: Timestamp
  totalMonto: number
  totalPagado: number
  estado: 'pendiente' | 'parcial' | 'pagado'
  // pagoId/movimientoPagoId ausentes en pagos registrados antes de esta
  // corrección (F4) — se conservan intactos, nunca se les adivina un ID
  // retroactivo. formaPago/referencia quedan presentes pero sin selector en
  // esta UI todavía (no existe ese control hoy) — se documenta como límite,
  // no se rediseña el modal para agregarlo.
  pagos: Array<{
    pagoId?: string
    monto: number
    at: Timestamp
    nota?: string | null
    registradoPor: string
    formaPago?: string | null
    referencia?: string | null
    movimientoPagoId?: string
  }>
  ordenesIds: string[]
  pagadoAt?: Timestamp
}

type MainTab = 'contado' | 'credito' | 'incidencias' | 'conciliacion'
type ContadoSub = 'por_orden' | 'por_cliente' | 'pagados'
type IncidenciasTab = 'pendientes' | 'resueltos'

// ─── Helpers ─────────────────────────────────────────────────────────────────

function fmtFecha(ts?: { toDate?: () => Date }) {
  const d = ts?.toDate?.()
  return d ? d.toLocaleDateString('es-NI', { day: '2-digit', month: 'short', year: 'numeric' }) : '—'
}

function fmt(n?: number) {
  if (typeof n !== 'number') return '—'
  return `C$ ${n.toLocaleString('es-NI')}`
}

function fmtDate(v: any) {
  if (!v) return '—'
  const d = typeof v?.toDate === 'function' ? v.toDate() : v instanceof Date ? v : null
  if (!d) return '—'
  return d.toLocaleDateString('es-NI', { day: '2-digit', month: 'short', year: 'numeric' })
}

function fmtDateShort(v: any) {
  if (!v) return '—'
  const d = typeof v?.toDate === 'function' ? v.toDate() : v instanceof Date ? v : null
  if (!d) return '—'
  return d.toLocaleDateString('es-NI', { day: '2-digit', month: 'short' })
}

function getSemanaRange(semanaKey: string): { inicio: Date; fin: Date } {
  const [yearStr, weekStr] = semanaKey.split('-W')
  const year = parseInt(yearStr)
  const week = parseInt(weekStr)
  const jan4 = new Date(year, 0, 4)
  const jan4Day = jan4.getDay() || 7
  const monday = new Date(jan4)
  monday.setDate(jan4.getDate() - jan4Day + 1 + (week - 1) * 7)
  monday.setHours(0, 0, 0, 0)
  const sunday = new Date(monday)
  sunday.setDate(monday.getDate() + 6)
  sunday.setHours(23, 59, 59, 999)
  return { inicio: monday, fin: sunday }
}

function formatSemanaDisplay(semanaKey: string): string {
  try {
    const { inicio, fin } = getSemanaRange(semanaKey)
    const opts: Intl.DateTimeFormatOptions = { day: '2-digit', month: 'short' }
    return `${inicio.toLocaleDateString('es-NI', opts)} – ${fin.toLocaleDateString('es-NI', opts)}`
  } catch {
    return semanaKey
  }
}

function getClienteNombre(s: Solicitud, nombres: Record<string, string> = {}) {
  return (
    s.ownerSnapshot?.companyName ||
    s.ownerSnapshot?.nombre ||
    (s.userId ? nombres[s.userId] : undefined) ||
    s.userId?.slice(0, 8) ||
    '—'
  )
}

function getClienteUid(s: Solicitud) {
  return (s.ownerSnapshot as any)?.uid || s.userId || '__sin'
}

function getTipoCobro(s: Solicitud): string {
  const d = s.cobrosMotorizado?.delivery
  const p = s.cobrosMotorizado?.producto
  const parts: string[] = []
  if (d && !d.recibio) parts.push('Delivery')
  if (p && !p.recibio) parts.push('Producto')
  return parts.join(' + ') || '—'
}

function getMontoPendiente(s: Solicitud): number {
  let total = 0
  const d = s.cobrosMotorizado?.delivery
  const p = s.cobrosMotorizado?.producto
  if (d && !d.recibio) total += d.monto
  if (p && !p.recibio) total += p.monto
  return total
}

function getJustificaciones(s: Solicitud): string[] {
  const out: string[] = []
  const d = s.cobrosMotorizado?.delivery
  const p = s.cobrosMotorizado?.producto
  if (d && !d.recibio && d.justificacion) out.push(`Delivery: ${d.justificacion}`)
  if (p && !p.recibio && p.justificacion) out.push(`Producto: ${p.justificacion}`)
  return out
}

// ─── Estilos compartidos ──────────────────────────────────────────────────────

const thCls = 'px-4 py-3 text-left text-[11px] font-semibold uppercase tracking-wide text-gray-500'
const tdCls = 'px-4 py-3 text-sm text-gray-700'

function btnTab(active: boolean) {
  return `px-4 py-2 rounded-lg text-sm font-semibold border transition ${
    active ? 'bg-[#004aad] text-white border-[#004aad]' : 'bg-white text-gray-600 border-gray-200 hover:bg-gray-50'
  }`
}

// ─── Resolve Modal (Incidencias) ──────────────────────────────────────────────

function ResolveModal({
  solicitud,
  onClose,
}: {
  solicitud: Solicitud
  onClose: () => void
}) {
  const [tipo, setTipo] = useState<'cliente_pagara' | 'se_pierde' | null>(null)
  const [nota, setNota] = useState('')
  const [saving, setSaving] = useState(false)
  const [err, setErr] = useState<string | null>(null)

  async function handleResolver() {
    if (!tipo) return
    setSaving(true); setErr(null)
    try {
      const uid = auth.currentUser?.uid || 'desconocido'
      const updates: any = {
        cobroPendiente: false,
        'cobrosMotorizado.resolucion': {
          resueltoPor: uid,
          at: serverTimestamp(),
          nota: nota.trim() || null,
          tipo,
        },
      }
      if (tipo === 'cliente_pagara') {
        // Asegurar que cobroDelivery quede en estado pendiente
        if (!solicitud.cobroDelivery) {
          updates['cobroDelivery.estado'] = 'pendiente'
          updates['cobroDelivery.registradoAt'] = serverTimestamp()
        } else if (solicitud.cobroDelivery.estado === 'no_cobrar') {
          updates['cobroDelivery.estado'] = 'pendiente'
        }
      } else {
        updates['cobroDelivery.estado'] = 'no_cobrar'
      }
      await updateDoc(doc(db, 'solicitudes_envio', solicitud.id), updates)
      onClose()
    } catch (e: any) {
      setErr(e?.message || 'Error al guardar')
    } finally {
      setSaving(false)
    }
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 backdrop-blur-sm px-4">
      <div className="bg-white rounded-2xl shadow-2xl w-full max-w-sm p-5">
        <div className="flex items-center justify-between mb-4">
          <h3 className="text-base font-black text-gray-900">Resolver incidencia</h3>
          <button onClick={onClose} className="w-8 h-8 grid place-items-center rounded-full border border-gray-200 hover:bg-gray-50">
            <X className="h-4 w-4 text-gray-500" />
          </button>
        </div>
        <p className="text-sm text-gray-500 mb-4">¿Cómo se resuelve este cobro pendiente?</p>

        {/* Opción A */}
        <button
          onClick={() => setTipo('cliente_pagara')}
          className={`w-full text-left rounded-xl border-2 px-4 py-3 mb-3 transition ${
            tipo === 'cliente_pagara' ? 'border-[#004aad] bg-blue-50' : 'border-gray-200 hover:border-gray-300'
          }`}
        >
          <p className={`text-sm font-semibold ${tipo === 'cliente_pagara' ? 'text-[#004aad]' : 'text-gray-800'}`}>
            Cliente pagará después
          </p>
          <p className="text-xs text-gray-500 mt-0.5">Pasa al módulo de Cobros para seguimiento</p>
        </button>

        {/* Opción B */}
        <button
          onClick={() => setTipo('se_pierde')}
          className={`w-full text-left rounded-xl border-2 px-4 py-3 mb-4 transition ${
            tipo === 'se_pierde' ? 'border-red-400 bg-red-50' : 'border-gray-200 hover:border-gray-300'
          }`}
        >
          <p className={`text-sm font-semibold ${tipo === 'se_pierde' ? 'text-red-600' : 'text-gray-800'}`}>
            Se pierde
          </p>
          <p className="text-xs text-gray-500 mt-0.5">No se cobrará este monto</p>
        </button>

        <textarea
          value={nota}
          onChange={(e) => setNota(e.target.value)}
          placeholder="Nota opcional sobre la resolución…"
          className="w-full border border-gray-200 rounded-xl px-3 py-2.5 text-sm resize-none h-20 focus:outline-none focus:ring-2 focus:ring-[#004aad]/30 focus:border-[#004aad]"
        />
        {err && <p className="text-xs text-red-600 mt-1">{err}</p>}
        <div className="flex gap-2 mt-4">
          <button onClick={onClose} className="flex-1 border border-gray-200 text-gray-600 text-sm font-semibold py-2.5 rounded-xl hover:bg-gray-50 transition">
            Cancelar
          </button>
          <button
            onClick={handleResolver}
            disabled={saving || !tipo}
            className="flex-1 bg-[#004aad] text-white text-sm font-semibold py-2.5 rounded-xl hover:bg-[#0a49a4] transition disabled:opacity-40"
          >
            {saving ? 'Guardando…' : 'Confirmar'}
          </button>
        </div>
      </div>
    </div>
  )
}

// ─── Pago Modal (Crédito) ─────────────────────────────────────────────────────

// Sobrepago detectado dentro de la transacción — nunca se reduce el monto
// silenciosamente, se bloquea y se informa el saldo real.
class SaldoInsuficienteError extends Error {
  constructor(public saldoReal: number) {
    super('SALDO_INSUFICIENTE')
  }
}

function PagoModal({
  cobroSemanal,
  onClose,
}: {
  cobroSemanal: CobroSemanal
  onClose: () => void
}) {
  const [monto, setMonto] = useState('')
  const [nota, setNota] = useState('')
  const [saving, setSaving] = useState(false)
  const [err, setErr] = useState<string | null>(null)
  const [resultado, setResultado] = useState<'exito' | 'ya_registrado' | null>(null)
  // Ref además del state `saving`: bloquea sincrónicamente un doble clic
  // antes de que React re-renderice el `disabled` del botón.
  const savingRef = useRef(false)

  const pendiente = cobroSemanal.totalMonto - cobroSemanal.totalPagado
  const montoNum = parseFloat(monto) || 0

  // pagoId estable: generado UNA sola vez por intento de pago sobre este
  // cobro semanal (no en cada clic). Persistido en sessionStorage bajo una
  // clave por cobroSemanal.id para sobrevivir a doble clic, a un reintento
  // tras timeout, y a una recarga real de la página. Se borra únicamente
  // cuando la operación confirma (éxito o "ya registrado"), para que el
  // siguiente pago legítimo sobre este mismo cobro reciba un pagoId nuevo.
  // Límite: no sobrevive a cerrar la pestaña (alcance de sessionStorage) —
  // aceptable porque ahí el usuario reinicia conscientemente el intento.
  const storageKey = `storkhub:pagoId:cobroSemanal:${cobroSemanal.id}`
  const pagoIdRef = useRef<string | null>(null)
  if (!pagoIdRef.current) {
    try {
      const existente = sessionStorage.getItem(storageKey)
      pagoIdRef.current = existente || crypto.randomUUID()
      if (!existente) sessionStorage.setItem(storageKey, pagoIdRef.current)
    } catch {
      // sessionStorage no disponible (modo privado, etc.): degrada a un
      // pagoId solo en memoria — sigue protegiendo doble clic/reintentos
      // dentro de esta misma sesión de modal, no sobrevive a un reload.
      pagoIdRef.current = crypto.randomUUID()
    }
  }

  async function handlePago() {
    if (savingRef.current) return
    if (!montoNum || montoNum <= 0) { setErr('Ingresa un monto válido'); return }
    savingRef.current = true
    setSaving(true); setErr(null)

    const pagoId = pagoIdRef.current!
    const uid = auth.currentUser?.uid || 'desconocido'
    const cobroRef = doc(db, 'cobros_semanales', cobroSemanal.id)
    const movRef = doc(db, 'movimientos_financieros', `pago_semanal_${cobroSemanal.id}_${pagoId}`)
    const notaTrim = nota.trim() || null

    try {
      const resultadoTx = await runTransaction(db, async (tx) => {
        const snap = await tx.get(cobroRef)
        if (!snap.exists()) throw new Error('Este cobro semanal ya no existe.')
        const data = snap.data() as CobroSemanal

        if (typeof data.totalMonto !== 'number' || !(data.totalMonto > 0)) {
          throw new Error('El cobro semanal tiene un totalMonto inválido — no se puede registrar el pago.')
        }

        const totalPagadoReal = data.totalPagado || 0
        const pagosActuales = Array.isArray(data.pagos) ? data.pagos : []

        // Idempotencia — chequeo primario: ¿este pagoId ya está en pagos[]?
        const yaEnPagos = pagosActuales.some((p) => p.pagoId === pagoId)
        // Defensa adicional: ¿el movimiento determinístico ya existe? Cubre
        // el caso borde de una relectura que aún no reflejara pagos[] pero sí
        // el movimiento — no debería ocurrir dentro de la misma transacción
        // atómica, pero es la señal más fuerte disponible de "ya se aplicó".
        const movSnap = yaEnPagos ? null : await tx.get(movRef)
        if (yaEnPagos || movSnap?.exists()) {
          return { yaRegistrado: true as const }
        }

        // Consistencia histórica: se documenta, nunca se repara aquí.
        const sumaPagosHistorica = pagosActuales.reduce((s, p) => s + (p.monto || 0), 0)
        if (Math.abs(sumaPagosHistorica - totalPagadoReal) > 0.009) {
          console.warn(
            `[cobros_semanales] Inconsistencia histórica en ${cobroSemanal.id}: totalPagado=${totalPagadoReal} ` +
            `vs suma(pagos[])=${sumaPagosHistorica}. No se repara automáticamente — requiere conciliación manual. ` +
            'El nuevo pago se registra igual, usando totalPagado como fuente de verdad.'
          )
        }

        const saldoPendienteReal = data.totalMonto - totalPagadoReal
        if (montoNum > saldoPendienteReal) {
          throw new SaldoInsuficienteError(saldoPendienteReal)
        }

        const nuevoTotalPagado = totalPagadoReal + montoNum
        const nuevoEstado: CobroSemanal['estado'] =
          nuevoTotalPagado === data.totalMonto ? 'pagado' : nuevoTotalPagado > 0 ? 'parcial' : 'pendiente'

        const pagoEntry = {
          pagoId,
          monto: montoNum,
          at: Timestamp.now(), // serverTimestamp() no puede usarse dentro de un array literal
          nota: notaTrim,
          registradoPor: uid,
          formaPago: null,
          referencia: notaTrim,
          movimientoPagoId: movRef.id,
        }

        tx.update(cobroRef, {
          totalPagado: nuevoTotalPagado,
          estado: nuevoEstado,
          pagos: [...pagosActuales, pagoEntry],
          updatedAt: serverTimestamp(),
          ...(nuevoEstado === 'pagado' ? { pagadoAt: serverTimestamp() } : {}),
        })

        tx.set(movRef, {
          tipo: 'pago_recibido',
          monto: montoNum,
          at: serverTimestamp(),
          creadoPorUid: uid,
          creadoPorRol: 'gestor',
          descripcion: `Pago crédito semanal · ${cobroSemanal.clienteCompany || cobroSemanal.clienteNombre} · sem ${cobroSemanal.semanaKey}`,
          estado: 'activo',
          comercioId: cobroSemanal.clienteUid,
          semanaKey: cobroSemanal.semanaKey,
          metadata: { cobroSemanalId: cobroSemanal.id, pagoId },
        })

        return { yaRegistrado: false as const }
      })

      try { sessionStorage.removeItem(storageKey) } catch {}

      if (resultadoTx.yaRegistrado) {
        setResultado('ya_registrado')
      } else {
        setResultado('exito')
        setTimeout(onClose, 900)
      }
    } catch (e: any) {
      if (e instanceof SaldoInsuficienteError) {
        setErr(`El monto excede el saldo pendiente real (${fmt(e.saldoReal)}).`)
      } else {
        setErr(e?.message || 'Error al registrar el pago')
      }
      // monto y nota se conservan a propósito: el usuario no pierde lo ingresado.
    } finally {
      savingRef.current = false
      setSaving(false)
    }
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 backdrop-blur-sm px-4">
      <div className="bg-white rounded-2xl shadow-2xl w-full max-w-sm p-5">
        <div className="flex items-center justify-between mb-4">
          <div>
            <h3 className="text-base font-black text-gray-900">Registrar pago</h3>
            <p className="text-xs text-gray-500 mt-0.5">
              {cobroSemanal.clienteCompany || cobroSemanal.clienteNombre} · {formatSemanaDisplay(cobroSemanal.semanaKey)}
            </p>
          </div>
          <button onClick={onClose} className="w-8 h-8 grid place-items-center rounded-full border border-gray-200 hover:bg-gray-50">
            <X className="h-4 w-4 text-gray-500" />
          </button>
        </div>

        <div className="grid grid-cols-2 gap-2 mb-4">
          <div className="bg-gray-50 rounded-xl px-3 py-2">
            <p className="text-xs text-gray-500">Total</p>
            <p className="text-sm font-bold text-gray-900">{fmt(cobroSemanal.totalMonto)}</p>
          </div>
          <div className="bg-orange-50 rounded-xl px-3 py-2">
            <p className="text-xs text-orange-500">Pendiente</p>
            <p className="text-sm font-bold text-orange-700">{fmt(pendiente)}</p>
          </div>
        </div>

        <label className="block text-xs font-semibold text-gray-600 mb-1">Monto a registrar (C$)</label>
        <input
          type="number"
          min="0"
          step="0.01"
          value={monto}
          onChange={(e) => setMonto(e.target.value)}
          placeholder={`Máx. ${pendiente}`}
          disabled={saving || resultado !== null}
          className="w-full border border-gray-200 rounded-xl px-3 py-2.5 text-sm focus:outline-none focus:ring-2 focus:ring-[#004aad]/30 focus:border-[#004aad] mb-3 disabled:bg-gray-50 disabled:text-gray-400"
        />
        <textarea
          value={nota}
          onChange={(e) => setNota(e.target.value)}
          placeholder="Nota opcional (referencia, banco, etc.)"
          disabled={saving || resultado !== null}
          className="w-full border border-gray-200 rounded-xl px-3 py-2.5 text-sm resize-none h-16 focus:outline-none focus:ring-2 focus:ring-[#004aad]/30 focus:border-[#004aad] disabled:bg-gray-50 disabled:text-gray-400"
        />
        {err && <p className="text-xs text-red-600 mt-1">{err}</p>}
        {resultado === 'exito' && <p className="text-xs font-semibold text-green-600 mt-1">✅ Pago registrado</p>}
        {resultado === 'ya_registrado' && (
          <p className="text-xs font-semibold text-blue-600 mt-1">ℹ️ Este pago ya había sido registrado — no se creó otro.</p>
        )}
        <div className="flex gap-2 mt-4">
          <button onClick={onClose} className="flex-1 border border-gray-200 text-gray-600 text-sm font-semibold py-2.5 rounded-xl hover:bg-gray-50 transition">
            {resultado ? 'Cerrar' : 'Cancelar'}
          </button>
          <button
            onClick={handlePago}
            disabled={saving || !montoNum || resultado !== null}
            className="flex-1 bg-green-600 text-white text-sm font-semibold py-2.5 rounded-xl hover:bg-green-700 transition disabled:opacity-40"
          >
            {saving ? 'Guardando…' : '✓ Registrar pago'}
          </button>
        </div>
      </div>
    </div>
  )
}

// ─── Boucher Modal (transferencia comercio) ───────────────────────────────────

function BoucherModal({
  orden,
  nombres,
  onClose,
}: {
  orden: Solicitud
  nombres: Record<string, string>
  onClose: () => void
}) {
  const [saving, setSaving] = useState(false)
  const [removing, setRemoving] = useState(false)
  const [uploading, setUploading] = useState(false)
  const [localBoucherUrl, setLocalBoucherUrl] = useState(orden.cobroDelivery?.boucherUrl)
  const [err, setErr] = useState<string | null>(null)
  const replaceInputRef = useRef<HTMLInputElement>(null)
  const nombre = getClienteNombre(orden, nombres)
  const monto = orden.cobroDelivery?.monto ?? (orden as any).confirmacion?.precioFinalCordobas

  async function handleQuitar() {
    setRemoving(true); setErr(null)
    try {
      await updateDoc(doc(db, 'solicitudes_envio', orden.id), {
        'cobroDelivery.estado': 'pendiente',
        'cobroDelivery.boucherUrl': deleteField(),
        'cobroDelivery.boucherPath': deleteField(),
        'cobroDelivery.boucherAt': deleteField(),
        'cobroDelivery.subidoPor': deleteField(),
        updatedAt: serverTimestamp(),
      })
      onClose()
    } catch (e: any) {
      setErr(e?.message || 'Error al quitar')
    } finally {
      setRemoving(false)
    }
  }

  async function handleReemplazar(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0]
    if (!file) return
    e.target.value = ''
    setUploading(true); setErr(null)
    try {
      const blob = await compressImage(file)
      const path = `evidencias/${orden.id}/delivery_boucher.jpg`
      const { url, pathStorage } = await uploadEvidenciaPath(path, blob)
      setLocalBoucherUrl(url)
      await updateDoc(doc(db, 'solicitudes_envio', orden.id), {
        'cobroDelivery.boucherUrl': url,
        'cobroDelivery.boucherPath': pathStorage,
        'cobroDelivery.boucherAt': serverTimestamp(),
        'cobroDelivery.subidoPor': 'gestor',
        updatedAt: serverTimestamp(),
      })
    } catch (e: any) {
      setErr(e?.message || 'Error al subir')
    } finally {
      setUploading(false)
    }
  }

  async function handleConfirmar() {
    setSaving(true); setErr(null)
    try {
      const uid = auth.currentUser?.uid || 'desconocido'
      const montoFinal = monto ?? 0
      const depositoRef = doc(collection(db, 'ordenes_deposito'))
      const depositoId = depositoRef.id
      const b = writeBatch(db)
      b.set(depositoRef, {
        creadoAt: serverTimestamp(),
        tipo: 'pago_delivery_deposito',
        estado: 'confirmado',
        destinatario: 'storkhub',
        destinatarioId: 'storkhub',
        destinatarioNombre: 'Storkhub',
        cuentasDestino: [],
        motorizadoUid: orden.asignacion?.motorizadoId ?? '',
        motorizadoNombre: orden.asignacion?.motorizadoNombre ?? '',
        solicitudIds: [orden.id],
        montoTotal: montoFinal,
        boucherUrl: orden.cobroDelivery?.boucherUrl ?? null,
        metadata: { clienteNombre: nombre },
      })
      b.update(doc(db, 'solicitudes_envio', orden.id), {
        'cobroDelivery.estado': 'pagado',
        'cobroDelivery.pagadoAt': serverTimestamp(),
        'cobroDelivery.formaPago': 'transferencia',
        'cobroDelivery.confirmadoPor': uid,
        'cobroDelivery.confirmadoAt': serverTimestamp(),
        'registro.deposito.confirmadoStorkhub': true,
        'registro.deposito.confirmadoStorkhubAt': serverTimestamp(),
        'registro.deposito.storkhubDepositoId': depositoId,
      })
      await b.commit()
      await registrarMovimiento('pago_recibido', montoFinal, uid,
        `Pago delivery por transferencia confirmado · ${nombre}`,
        { solicitudId: orden.id, depositoId })
      onClose()
    } catch (e: any) {
      setErr(e?.message || 'Error al guardar')
    } finally {
      setSaving(false)
    }
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 backdrop-blur-sm px-4">
      <input ref={replaceInputRef} type="file" accept="image/*" className="hidden" onChange={handleReemplazar} />
      <div className="bg-white rounded-2xl shadow-2xl w-full max-w-sm p-5">
        <div className="flex items-center justify-between mb-3">
          <h3 className="text-base font-black text-gray-900">Revisar boucher</h3>
          <button onClick={onClose} className="w-8 h-8 grid place-items-center rounded-full border border-gray-200 hover:bg-gray-50">
            <X className="h-4 w-4 text-gray-500" />
          </button>
        </div>
        <p className="text-xs text-gray-500 mb-3">
          Orden <span className="font-mono">{orden.id.slice(0, 8)}</span> · {nombre} · <span className="font-semibold text-gray-700">{fmt(monto)}</span>
        </p>

        {localBoucherUrl ? (
          <>
            <a href={localBoucherUrl} target="_blank" rel="noreferrer" className="block mb-2">
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img
                src={localBoucherUrl}
                alt="Boucher de transferencia"
                className="w-full rounded-xl border border-gray-200 object-contain max-h-64"
              />
              <p className="text-xs text-center text-blue-600 mt-1 hover:underline">Ver imagen completa →</p>
            </a>
            <div className="flex gap-2 mb-3">
              <button
                onClick={() => replaceInputRef.current?.click()}
                disabled={uploading}
                className="flex-1 text-xs font-semibold px-3 py-1.5 rounded-lg border border-gray-200 text-gray-600 hover:bg-gray-50 transition disabled:opacity-40"
              >
                {uploading ? 'Subiendo…' : '↺ Reemplazar'}
              </button>
              <button
                onClick={handleQuitar}
                disabled={removing}
                className="flex-1 text-xs font-semibold px-3 py-1.5 rounded-lg border border-red-200 text-red-600 bg-red-50 hover:bg-red-100 transition disabled:opacity-40"
              >
                {removing ? '…' : '✕ Quitar boucher'}
              </button>
            </div>
          </>
        ) : (
          <div className="mb-3 rounded-xl border border-dashed border-gray-300 py-6 text-center">
            <p className="text-sm text-gray-400 mb-2">Sin boucher adjunto</p>
            <button
              onClick={() => replaceInputRef.current?.click()}
              disabled={uploading}
              className="text-xs font-semibold px-3 py-1.5 rounded-lg bg-amber-50 text-amber-700 border border-amber-200 hover:bg-amber-100 transition disabled:opacity-40"
            >
              {uploading ? 'Subiendo…' : <><Upload className="inline h-3 w-3 mr-1" />Subir boucher</>}
            </button>
          </div>
        )}

        {err && <p className="text-xs text-red-600 mb-2">{err}</p>}
        <div className="flex gap-2">
          <button onClick={onClose} className="flex-1 border border-gray-200 text-gray-600 text-sm font-semibold py-2.5 rounded-xl hover:bg-gray-50 transition">
            Cancelar
          </button>
          <button
            onClick={handleConfirmar}
            disabled={saving || !localBoucherUrl}
            className="flex-1 bg-green-600 text-white text-sm font-semibold py-2.5 rounded-xl hover:bg-green-700 transition disabled:opacity-40"
          >
            {saving ? 'Confirmando…' : '✓ Confirmar pago'}
          </button>
        </div>
      </div>
    </div>
  )
}

// ─── Pago Contado Modal ───────────────────────────────────────────────────────

function PagoContadoModal({
  orden,
  nombres,
  onClose,
}: {
  orden: Solicitud
  nombres: Record<string, string>
  onClose: () => void
}) {
  const [formaPago, setFormaPago] = useState<string>('')
  const [nota, setNota] = useState('')
  const [saving, setSaving] = useState(false)
  const [err, setErr] = useState<string | null>(null)

  const monto = orden.cobroDelivery?.monto ?? (orden as any).confirmacion?.precioFinalCordobas
  const nombre = getClienteNombre(orden, nombres)

  async function handleConfirmar() {
    if (!formaPago) { setErr('Selecciona la forma de cobro'); return }
    setSaving(true); setErr(null)
    try {
      const uid = auth.currentUser?.uid || 'desconocido'
      const montoFinal = monto ?? 0
      const updates: any = {
        'cobroDelivery.estado': 'pagado',
        'cobroDelivery.pagadoAt': serverTimestamp(),
        'cobroDelivery.formaPago': formaPago,
        'cobroDelivery.confirmadoPor': uid,
        'cobroDelivery.confirmadoAt': serverTimestamp(),
        'cobroDelivery.metodoPagoReal': formaPago === 'efectivo' ? 'efectivo' : 'transferencia_deposito',
      }
      if (nota.trim()) updates['cobroDelivery.notaPago'] = nota.trim()
      if (!orden.cobroDelivery) {
        updates['cobroDelivery.monto'] = (orden as any).confirmacion?.precioFinalCordobas ?? 0
        updates['cobroDelivery.tipoCliente'] = orden.tipoCliente || 'contado'
        updates['cobroDelivery.quienPaga'] = orden.pagoDelivery?.quienPaga || ''
        updates['cobroDelivery.registradoAt'] = serverTimestamp()
      }

      if (formaPago === 'transferencia') {
        // Crear registro de depósito por transferencia del cliente
        const depositoRef = doc(collection(db, 'ordenes_deposito'))
        const depositoId = depositoRef.id
        const b = writeBatch(db)
        b.set(depositoRef, {
          creadoAt: serverTimestamp(),
          tipo: 'pago_delivery_deposito',
          estado: 'confirmado',
          destinatario: 'storkhub',
          destinatarioId: 'storkhub',
          destinatarioNombre: 'Storkhub',
          cuentasDestino: [],
          motorizadoUid: orden.asignacion?.motorizadoId ?? '',
          motorizadoNombre: orden.asignacion?.motorizadoNombre ?? '',
          solicitudIds: [orden.id],
          montoTotal: montoFinal,
          metadata: { referencia: nota.trim() || null, clienteNombre: nombre },
        })
        b.update(doc(db, 'solicitudes_envio', orden.id), {
          ...updates,
          'registro.deposito.confirmadoStorkhub': true,
          'registro.deposito.confirmadoStorkhubAt': serverTimestamp(),
          'registro.deposito.storkhubDepositoId': depositoId,
        })
        await b.commit()
        const movId = await registrarMovimiento('pago_recibido', montoFinal, uid,
          `Pago delivery por transferencia confirmado · ${nombre}`,
          { solicitudId: orden.id, depositoId })
        // Enlace mínimo y aditivo para que revertirPagada (ver F5) pueda ubicar
        // este movimiento sin ambigüedad. No cambia la atomicidad ni la
        // idempotencia de este flujo individual — eso queda fuera de alcance
        // de esta corrección (solo F3/F5). Si registrarMovimiento falla
        // silenciosamente (retorna null), la solicitud queda sin
        // movimientoPagoId y una reversión futura usará el fallback legacy.
        if (movId) {
          await updateDoc(doc(db, 'solicitudes_envio', orden.id), { 'cobroDelivery.movimientoPagoId': movId })
        }
      } else {
        await updateDoc(doc(db, 'solicitudes_envio', orden.id), updates)
        const movId = await registrarMovimiento('pago_recibido', montoFinal, uid,
          `Pago contado confirmado · ${nombre} · ${formaPago}`,
          { solicitudId: orden.id })
        if (movId) {
          await updateDoc(doc(db, 'solicitudes_envio', orden.id), { 'cobroDelivery.movimientoPagoId': movId })
        }
      }
      onClose()
    } catch (e: any) {
      setErr(e?.message || 'Error al guardar')
    } finally {
      setSaving(false)
    }
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 backdrop-blur-sm px-4">
      <div className="bg-white rounded-2xl shadow-2xl w-full max-w-sm p-5">
        <div className="flex items-center justify-between mb-1">
          <h3 className="text-base font-black text-gray-900">Confirmar cobro</h3>
          <button onClick={onClose} className="w-8 h-8 grid place-items-center rounded-full border border-gray-200 hover:bg-gray-50">
            <X className="h-4 w-4 text-gray-500" />
          </button>
        </div>
        <p className="text-xs text-gray-500 mb-4">
          Orden <span className="font-mono">{orden.id.slice(0, 8)}</span> · {nombre} · <span className="font-semibold text-gray-700">{fmt(monto)}</span>
        </p>

        <p className="text-xs font-semibold text-gray-600 mb-2">Forma de cobro</p>
        <div className="grid grid-cols-2 gap-2 mb-3">
          {([
            { value: 'efectivo', label: 'Efectivo', Icon: Banknote },
            { value: 'transferencia', label: 'Transferencia', Icon: ArrowRightLeft },
          ] as const).map(({ value, label, Icon }) => (
            <button
              key={value}
              onClick={() => setFormaPago(value)}
              className={`flex items-center gap-2 rounded-xl border-2 px-3 py-2.5 transition ${
                formaPago === value ? 'border-[#004aad] bg-blue-50' : 'border-gray-200 hover:border-gray-300'
              }`}
            >
              <Icon className={`h-4 w-4 ${formaPago === value ? 'text-[#004aad]' : 'text-gray-400'}`} />
              <span className={`text-sm font-semibold ${formaPago === value ? 'text-[#004aad]' : 'text-gray-700'}`}>{label}</span>
            </button>
          ))}
        </div>

        <textarea
          value={nota}
          onChange={(e) => setNota(e.target.value)}
          placeholder="Nota opcional (ej. referencia de transferencia, fecha, etc.)"
          className="w-full border border-gray-200 rounded-xl px-3 py-2.5 text-sm resize-none h-16 focus:outline-none focus:ring-2 focus:ring-[#004aad]/30 focus:border-[#004aad]"
        />
        {err && <p className="text-xs text-red-600 mt-1">{err}</p>}
        <div className="flex gap-2 mt-4">
          <button onClick={onClose} className="flex-1 border border-gray-200 text-gray-600 text-sm font-semibold py-2.5 rounded-xl hover:bg-gray-50 transition">
            Cancelar
          </button>
          <button
            onClick={handleConfirmar}
            disabled={saving || !formaPago}
            className="flex-1 bg-green-600 text-white text-sm font-semibold py-2.5 rounded-xl hover:bg-green-700 transition disabled:opacity-40"
          >
            {saving ? 'Guardando…' : '✓ Confirmar pago'}
          </button>
        </div>
      </div>
    </div>
  )
}

// ─── Estado badge ─────────────────────────────────────────────────────────────

function EstadoBadge({ estado }: { estado: CobroSemanal['estado'] }) {
  const styles = {
    pendiente: 'bg-orange-50 text-orange-700 border-orange-200',
    parcial: 'bg-yellow-50 text-yellow-700 border-yellow-200',
    pagado: 'bg-green-50 text-green-700 border-green-200',
  }
  const labels = { pendiente: 'Pendiente', parcial: 'Parcial', pagado: 'Pagado' }
  return (
    <span className={`inline-flex text-xs font-semibold px-2 py-0.5 rounded-full border ${styles[estado]}`}>
      {labels[estado]}
    </span>
  )
}

// ─── Main ─────────────────────────────────────────────────────────────────────

export default function CobrosPage() {
  const [mainTab, setMainTab] = useState<MainTab>('contado')
  const [contadoSub, setContadoSub] = useState<ContadoSub>('por_orden')
  const [incidenciasTab, setIncidenciasTab] = useState<IncidenciasTab>('pendientes')
  const [acumulacionesPendientes, setAcumulacionesPendientes] = useState<Solicitud[]>([])

  // Contado: todas las órdenes entregadas (filtramos client-side para capturar históricas)
  const [contadoRaw, setContadoRaw] = useState<Solicitud[]>([])
  const [loadingContado, setLoadingContado] = useState(true)

  // Crédito: cobros_semanales
  const [cobrosSemanales, setCobrosSemanales] = useState<CobroSemanal[]>([])
  const [loadingCredito, setLoadingCredito] = useState(true)

  // Incidencias
  const [incidencias, setIncidencias] = useState<Solicitud[]>([])
  const [loadingIncidencias, setLoadingIncidencias] = useState(true)

  // Nombres de comercios faltantes (fallback desde colección usuarios)
  const [comercioNames, setComercioNames] = useState<Record<string, string>>({})

  // Modales
  const [resolvingIncidencia, setResolvingIncidencia] = useState<Solicitud | null>(null)
  const [pagandoSemana, setPagandoSemana] = useState<CobroSemanal | null>(null)
  const [marcandoPago, setMarcandoPago] = useState<Solicitud | null>(null)
  const [viendoBoucher, setViendoBoucher] = useState<Solicitud | null>(null)
  const [expandedSemana, setExpandedSemana] = useState<string | null>(null)

  // Subida de boucher por el gestor
  const [uploadingBoucherId, setUploadingBoucherId] = useState<string | null>(null)
  const boucherInputRef = useRef<HTMLInputElement>(null)

  // Pago en lote (marcarGrupoPagado) y reversión (revertirPagada): estas
  // banderas solo evitan doble clic en la MISMA pestaña — la garantía real
  // de no duplicar contra doble pestaña/reintento vive en la runTransaction
  // de cada función, no en este estado de React.
  const [procesandoGrupoKey, setProcesandoGrupoKey] = useState<string | null>(null)
  const [errorGrupoPago, setErrorGrupoPago] = useState<string | null>(null)
  const [revirtiendoId, setRevirtiendoId] = useState<string | null>(null)
  const [errorReversion, setErrorReversion] = useState<string | null>(null)

  // ── Queries ────────────────────────────────────────────────────────────────

  useEffect(() => {
    // Traer todas las órdenes entregadas para cubrir históricas (sin cobroDelivery)
    // y las nuevas con cobroDelivery.estado=pendiente
    const q = query(
      collection(db, 'solicitudes_envio'),
      where('estado', '==', 'entregado')
    )
    return onSnapshot(q, (snap) => {
      const rows = snap.docs
        .map((d) => ({ id: d.id, ...(d.data() as any) } as Solicitud))
        .sort((a, b) => (b.entregadoAt?.toMillis?.() || 0) - (a.entregadoAt?.toMillis?.() || 0))
      setContadoRaw(rows)
      setLoadingContado(false)
    })
  }, [])

  useEffect(() => {
    const q = query(
      collection(db, 'cobros_semanales'),
      where('estado', 'in', ['pendiente', 'parcial'])
    )
    return onSnapshot(q, (snap) => {
      const rows = snap.docs
        .map((d) => ({ id: d.id, ...(d.data() as any) } as CobroSemanal))
        .sort((a, b) => b.semanaKey.localeCompare(a.semanaKey))
      setCobrosSemanales(rows)
      setLoadingCredito(false)
    })
  }, [])

  // ── Conciliación de acumulaciones (P1) ────────────────────────────────────
  // La entrega y la acumulación del cobro semanal ocurren en dos pasos: el
  // cliente entrega, la callable acumula. Si el segundo no llega a correr, la
  // orden queda con el marcador en 'pendiente'. Se consulta el marcador
  // explícito y no la ausencia del id dentro de ordenesIds: buscar "lo que
  // falta" exigiría leer todos los cobros y cruzarlos, y no distinguiría un
  // caso pendiente de uno que nunca debió acumularse.
  useEffect(() => {
    const q = query(
      collection(db, 'solicitudes_envio'),
      where('acumulacionCobroSemanal.estado', 'in', ['pendiente', 'requiere_revision'])
    )
    return onSnapshot(q, (snap) => {
      setAcumulacionesPendientes(
        snap.docs.map((d) => ({ id: d.id, ...(d.data() as any) } as Solicitud))
      )
    }, (error) => {
      console.warn('[cobros] listener de conciliación detenido:', error.code)
      setAcumulacionesPendientes([])
    })
  }, [])

  useEffect(() => {
    const qPending = query(collection(db, 'solicitudes_envio'), where('cobroPendiente', '==', true))
    const qResolved = query(collection(db, 'solicitudes_envio'), where('cobroPendiente', '==', false))
    const map = new Map<string, Solicitud>()

    const unsubP = onSnapshot(qPending, (snap) => {
      snap.docs.forEach((d) => map.set(d.id, { id: d.id, ...(d.data() as any) }))
      setIncidencias([...map.values()])
      setLoadingIncidencias(false)
    })
    const unsubR = onSnapshot(qResolved, (snap) => {
      snap.docs.forEach((d) => {
        const data = d.data() as any
        if (data?.cobrosMotorizado?.resolucion) map.set(d.id, { id: d.id, ...data })
      })
      setIncidencias([...map.values()])
      setLoadingIncidencias(false)
    })
    return () => { unsubP(); unsubR() }
  }, [])

  // ── Cargar nombres faltantes desde usuarios ────────────────────────────────

  useEffect(() => {
    const missing = [...new Set(
      contadoRaw
        .filter((s) => !s.ownerSnapshot?.companyName && !s.ownerSnapshot?.nombre && s.userId)
        .map((s) => s.userId!)
    )].filter((uid) => !comercioNames[uid])

    if (missing.length === 0) return

    Promise.all(missing.map((uid) => getDoc(doc(db, 'usuarios', uid)))).then((snaps) => {
      const updates: Record<string, string> = {}
      snaps.forEach((snap, i) => {
        const data = snap.exists() ? (snap.data() as any) : null
        updates[missing[i]] = data?.companyName || data?.name || data?.nombre || missing[i].slice(0, 8)
      })
      setComercioNames((prev) => ({ ...prev, ...updates }))
    })
  }, [contadoRaw])

  // ── Derived state ──────────────────────────────────────────────────────────

  // Filtrar contado pendientes — solo órdenes con razón explícita de cobro
  const contadoOrdenes = useMemo(() =>
    contadoRaw.filter((s) => {
      // Excluir crédito
      if (s.tipoCliente === 'credito' || s.pagoDelivery?.quienPaga === 'credito_semanal') return false

      // Excluir incidencias activas (van en tab Incidencias)
      if (s.cobroPendiente === true) return false

      const cd = s.cobroDelivery

      // Excluir ya pagadas o no cobrar
      if (cd?.estado === 'pagado' || cd?.estado === 'no_cobrar') return false

      // ✅ Mostrar: el sistema lo marcó explícitamente como pendiente
      // (nuevo sistema: se escribe al marcar entregado, o desde resolución de incidencia)
      if (cd?.estado === 'pendiente') return true

      // ✅ Mostrar: transferencia bancaria aún no confirmada
      // (el cliente debe depositar a Storkhub, no pasa por el motorizado)
      if (s.pagoDelivery?.quienPaga === 'transferencia') return true

      // Todo lo demás (legacy, efectivo ya cobrado por motorizado, etc.) → NO mostrar
      // Las órdenes históricas donde el motorizado cobró en efectivo
      // ya están manejadas por el flujo de depósito.
      return false
    }),
    [contadoRaw]
  )

  const incidenciasPendientes = useMemo(() =>
    incidencias
      .filter((s) => {
        if (s.cobroPendiente !== true) return false
        // Solo mostrar si realmente hay un cobro no recibido.
        // Si cobroPendiente quedó stale (motorizado eventualmente cobró todo), no mostrar.
        const d = s.cobrosMotorizado?.delivery
        const p = s.cobrosMotorizado?.producto
        const hayNoRecibido = (d != null && d.recibio === false) || (p != null && p.recibio === false)
        // Si no hay ningún cobro registrado todavía (motorizado aún no respondió), sí mostrar
        const hayCobroRegistrado = d != null || p != null
        return !hayCobroRegistrado || hayNoRecibido
      })
      .sort((a, b) => (b.createdAt?.toMillis?.() || 0) - (a.createdAt?.toMillis?.() || 0)),
    [incidencias]
  )

  const incidenciasResueltas = useMemo(() =>
    incidencias
      .filter((s) => s.cobroPendiente === false && s.cobrosMotorizado?.resolucion)
      .sort((a, b) => (b.cobrosMotorizado?.resolucion?.at?.toMillis?.() || 0) - (a.cobrosMotorizado?.resolucion?.at?.toMillis?.() || 0)),
    [incidencias]
  )

  // Agrupado por cliente + día (Contado)
  const contadoPorClienteDia = useMemo(() => {
    type Group = {
      key: string
      clienteUid: string
      clienteNombre: string
      fecha: string
      fechaRaw: any
      ordenes: Solicitud[]
      total: number
    }
    const map = new Map<string, Group>()
    contadoOrdenes.forEach((s) => {
      const uid = getClienteUid(s)
      const nombre = getClienteNombre(s, comercioNames)
      const fecha = fmtDate(s.entregadoAt)
      const key = `${uid}_${fecha}`
      if (!map.has(key)) map.set(key, { key, clienteUid: uid, clienteNombre: nombre, fecha, fechaRaw: s.entregadoAt, ordenes: [], total: 0 })
      const g = map.get(key)!
      g.ordenes.push(s)
      g.total += s.cobroDelivery?.monto || 0
    })
    return [...map.values()].sort((a, b) => (b.fechaRaw?.toMillis?.() || 0) - (a.fechaRaw?.toMillis?.() || 0))
  }, [contadoOrdenes, comercioNames])

  const totalContadoPendiente = useMemo(
    // Para históricas sin cobroDelivery, usar confirmacion.precioFinalCordobas
    () => contadoOrdenes.reduce((s, o) => s + (o.cobroDelivery?.monto ?? (o as any).confirmacion?.precioFinalCordobas ?? 0), 0),
    [contadoOrdenes]
  )

  // ── Acciones contado ───────────────────────────────────────────────────────

  // (marcarPagada es invocado desde PagoContadoModal — ver modal arriba)

  // Revierte un cobro contado ya pagado. La solicitud y el movimiento
  // pago_recibido asociado se leen y escriben dentro de una única
  // runTransaction: o se revierten los dos juntos, o ninguno cambia.
  //
  // - Si la solicitud ya tiene cobroDelivery.movimientoPagoId (pagos creados
  //   por el flujo corregido), lo usamos directo.
  // - Si no lo tiene (registros legacy, o pagados por el modal individual —
  //   que queda fuera de alcance de esta corrección), lo resolvemos ANTES de
  //   abrir la transacción con una query por solicitudId: Firestore no
  //   permite where() dentro de runTransaction, solo tx.get(docRef). Si la
  //   query no encuentra exactamente un movimiento activo, bloqueamos sin
  //   escribir nada y pedimos conciliación manual.
  async function revertirPagada(orden: Solicitud) {
    const uid = auth.currentUser?.uid || 'desconocido'
    const solRef = doc(db, 'solicitudes_envio', orden.id)

    let movimientoId = orden.cobroDelivery?.movimientoPagoId ?? null
    if (!movimientoId) {
      const legacySnap = await getDocs(
        query(
          collection(db, 'movimientos_financieros'),
          where('solicitudId', '==', orden.id),
          where('tipo', '==', 'pago_recibido'),
          where('estado', '==', 'activo'),
        )
      )
      if (legacySnap.size === 0) {
        throw new Error('No se encontró ningún movimiento pago_recibido activo para esta solicitud. No se revirtió nada — requiere conciliación manual.')
      }
      if (legacySnap.size > 1) {
        throw new Error(`Se encontraron ${legacySnap.size} movimientos pago_recibido activos para esta solicitud. No se revirtió nada — requiere conciliación manual.`)
      }
      movimientoId = legacySnap.docs[0].id
    }
    const movRef = doc(db, 'movimientos_financieros', movimientoId)

    await runTransaction(db, async (tx) => {
      const [solSnap, movSnap] = await Promise.all([tx.get(solRef), tx.get(movRef)])
      if (!solSnap.exists()) {
        throw new Error('La solicitud ya no existe.')
      }
      const data = solSnap.data() as any
      const cobro = data.cobroDelivery as CobroDelivery | undefined
      if (!cobro || cobro.estado !== 'pagado') {
        throw new Error('Esta solicitud ya no está en estado pagado (probablemente ya fue revertida).')
      }
      if (!movSnap.exists()) {
        throw new Error('El movimiento financiero asociado no existe. No se revirtió nada — requiere conciliación manual.')
      }
      const movData = movSnap.data() as any
      if (movData.solicitudId !== orden.id || movData.tipo !== 'pago_recibido') {
        throw new Error('El movimiento encontrado no corresponde a esta solicitud. No se revirtió nada — requiere conciliación manual.')
      }
      if (movData.estado === 'anulado') {
        throw new Error('El movimiento ya está anulado pero la solicitud seguía marcada como pagada. No se revirtió nada — requiere conciliación manual.')
      }

      tx.update(solRef, {
        'cobroDelivery.estado': 'pendiente',
        'cobroDelivery.pagadoAt': deleteField(),
        'cobroDelivery.formaPago': deleteField(),
        'cobroDelivery.notaPago': deleteField(),
        // movimientoPagoId se conserva a propósito: queda apuntando al
        // movimiento (ahora anulado) como rastro de auditoría de que este
        // cobro fue pagado y luego revertido.
        'cobroDelivery.movimientoPagoId': movimientoId,
      })
      tx.update(movRef, {
        estado: 'anulado',
        anuladoAt: serverTimestamp(),
        anuladoPorUid: uid,
        motivoAnulacion: 'Reversión de cobro contado por gestor',
      })
    })
  }

  // Contado pagados (historial)
  const contadoPagados = useMemo(() =>
    contadoRaw
      .filter((s) => {
        if (s.tipoCliente === 'credito' || s.pagoDelivery?.quienPaga === 'credito_semanal') return false
        return s.cobroDelivery?.estado === 'pagado'
      })
      .sort((a, b) => (b.cobroDelivery?.pagadoAt?.toMillis?.() || 0) - (a.cobroDelivery?.pagadoAt?.toMillis?.() || 0)),
    [contadoRaw]
  )

  // Marca pagado un grupo de cobros contado (mismo cliente + día) en una sola
  // runTransaction. Por cada solicitud:
  //  - se relee dentro de la transacción (nunca se confía en el prop `o`);
  //  - si ya está pagada se omite (protege contra doble clic, doble pestaña
  //    y reintentos: el segundo intento no encuentra nada pendiente que hacer);
  //  - se crea exactamente un movimiento pago_recibido con el mismo tipo,
  //    monto y referencia (solicitudId) que usa el flujo individual aprobado
  //    (PagoContadoModal.handleConfirmar) — ese flujo tampoco fija cuentaOrigen/
  //    cuentaDestino para 'pago_recibido' (tipo legacy sin doble entrada), así
  //    que aquí se replica ese mismo comportamiento, sin inventar campos nuevos;
  //  - se guarda cobroDelivery.movimientoPagoId con el ID del movimiento recién
  //    creado, para que revertirPagada pueda ubicarlo sin ambigüedad.
  // Todo ocurre dentro de la misma transacción: si falla la escritura de
  // cualquier movimiento, Firestore descarta también las actualizaciones de
  // las solicitudes — no puede quedar un pago parcialmente aplicado al grupo.
  async function marcarGrupoPagado(ordenes: Solicitud[], formaPago: string) {
    const uid = auth.currentUser?.uid || 'desconocido'
    const solicitudRefs = ordenes.map((o) => doc(db, 'solicitudes_envio', o.id))

    await runTransaction(db, async (tx) => {
      const snaps = await Promise.all(solicitudRefs.map((ref) => tx.get(ref)))

      snaps.forEach((snap, i) => {
        if (!snap.exists()) return
        const data = snap.data() as any
        const cobroActual = data.cobroDelivery as CobroDelivery | undefined
        // Ya pagada (por este mismo intento en otra pestaña, o un reintento
        // anterior que sí llegó a escribir): no se toca ni se duplica.
        if (cobroActual?.estado === 'pagado') return

        const o = ordenes[i]
        const monto = cobroActual?.monto ?? (data as any).confirmacion?.precioFinalCordobas ?? 0
        const nombre = getClienteNombre(o, comercioNames)
        const movRef = doc(collection(db, 'movimientos_financieros'))

        const updates: any = {
          'cobroDelivery.estado': 'pagado',
          'cobroDelivery.pagadoAt': serverTimestamp(),
          'cobroDelivery.formaPago': formaPago,
          'cobroDelivery.movimientoPagoId': movRef.id,
        }
        if (!cobroActual) {
          updates['cobroDelivery.monto'] = monto
          updates['cobroDelivery.tipoCliente'] = o.tipoCliente || 'contado'
          updates['cobroDelivery.quienPaga'] = o.pagoDelivery?.quienPaga || ''
          updates['cobroDelivery.registradoAt'] = serverTimestamp()
        }

        tx.update(solicitudRefs[i], updates)
        tx.set(movRef, {
          tipo: 'pago_recibido',
          monto,
          at: serverTimestamp(),
          creadoPorUid: uid,
          creadoPorRol: 'gestor',
          descripcion: `Pago contado confirmado (lote) · ${nombre} · ${formaPago}`,
          estado: 'activo',
          solicitudId: o.id,
        })
      })
    })
  }

  // ── Subida de boucher por gestor ───────────────────────────────────────────

  async function handleGestorBoucherUpload(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0]
    if (!file || !uploadingBoucherId) return
    const targetId = uploadingBoucherId
    setUploadingBoucherId(null)
    e.target.value = ''
    try {
      const blob = await compressImage(file)
      const path = `evidencias/${targetId}/delivery_boucher.jpg`
      const { url, pathStorage } = await uploadEvidenciaPath(path, blob)
      const orden = contadoRaw.find((s) => s.id === targetId)
      await updateDoc(doc(db, 'solicitudes_envio', targetId), {
        'cobroDelivery.estado': 'en_revision_deposito',
        'cobroDelivery.boucherUrl': url,
        'cobroDelivery.boucherPath': pathStorage,
        'cobroDelivery.boucherAt': serverTimestamp(),
        'cobroDelivery.monto': (orden as any)?.confirmacion?.precioFinalCordobas ?? 0,
        'cobroDelivery.tipoCliente': 'contado',
        'cobroDelivery.quienPaga': 'transferencia',
        'cobroDelivery.registradoAt': serverTimestamp(),
        'cobroDelivery.subidoPor': 'gestor',
        updatedAt: serverTimestamp(),
      })
    } catch (err) {
      console.error('[cobros] Error subiendo boucher del gestor:', err)
    }
  }

  // ── KPIs ───────────────────────────────────────────────────────────────────

  const kpis = [
    {
      label: 'Contado pendiente',
      value: loadingContado ? '…' : String(contadoOrdenes.length),
      sub: loadingContado ? '' : fmt(totalContadoPendiente),
      color: 'bg-blue-50 border-blue-200',
      valueColor: 'text-[#004aad]',
      subColor: 'text-blue-400',
    },
    {
      label: 'Crédito pendiente',
      value: loadingCredito ? '…' : String(cobrosSemanales.length),
      sub: loadingCredito ? '' : 'semanas activas',
      color: 'bg-purple-50 border-purple-200',
      valueColor: 'text-purple-700',
      subColor: 'text-purple-400',
    },
    {
      label: 'Incidencias activas',
      value: loadingIncidencias ? '…' : String(incidenciasPendientes.length),
      sub: '',
      color: incidenciasPendientes.length > 0 ? 'bg-red-50 border-red-200' : 'bg-gray-50 border-gray-200',
      valueColor: incidenciasPendientes.length > 0 ? 'text-red-600' : 'text-gray-500',
      subColor: 'text-gray-400',
    },
  ]

  // ── Render ─────────────────────────────────────────────────────────────────

  return (
    <div className="flex flex-col gap-4">
      {/* Input oculto para subida de boucher por el gestor */}
      <input
        ref={boucherInputRef}
        type="file"
        accept="image/*"
        className="hidden"
        onChange={handleGestorBoucherUpload}
      />

      {resolvingIncidencia && (
        <ResolveModal solicitud={resolvingIncidencia} onClose={() => setResolvingIncidencia(null)} />
      )}
      {pagandoSemana && (
        <PagoModal cobroSemanal={pagandoSemana} onClose={() => setPagandoSemana(null)} />
      )}
      {marcandoPago && (
        <PagoContadoModal orden={marcandoPago} nombres={comercioNames} onClose={() => setMarcandoPago(null)} />
      )}
      {viendoBoucher && (
        <BoucherModal orden={viendoBoucher} nombres={comercioNames} onClose={() => setViendoBoucher(null)} />
      )}

      {/* Header */}
      <div>
        <h1 className="text-2xl font-black text-gray-900 tracking-tight flex items-center gap-2">
          <CreditCard className="h-6 w-6 text-[#004aad]" />
          Cobros
        </h1>
        <p className="text-sm text-gray-500 mt-0.5">
          Seguimiento de cobros de delivery por cliente.
        </p>
      </div>

      {/* KPIs */}
      <div className="grid grid-cols-3 gap-3">
        {kpis.map((k) => (
          <div key={k.label} className={`border rounded-xl px-4 py-3 ${k.color}`}>
            <p className={`text-2xl font-black ${k.valueColor}`}>{k.value}</p>
            <p className={`text-xs font-semibold mt-0.5 ${k.subColor}`}>{k.label}</p>
            {k.sub && <p className={`text-xs mt-0.5 ${k.subColor}`}>{k.sub}</p>}
          </div>
        ))}
      </div>

      {/* Main tabs */}
      <div className="flex gap-2 flex-wrap">
        <button onClick={() => setMainTab('contado')} className={btnTab(mainTab === 'contado')}>
          <Banknote className="inline h-4 w-4 mr-1.5 opacity-70" />
          Contado
          {!loadingContado && contadoOrdenes.length > 0 && (
            <span className="ml-1.5 inline-flex items-center justify-center w-5 h-5 rounded-full bg-[#004aad] text-white text-[10px] font-black">
              {contadoOrdenes.length > 99 ? '99+' : contadoOrdenes.length}
            </span>
          )}
        </button>
        <button onClick={() => setMainTab('credito')} className={btnTab(mainTab === 'credito')}>
          <ArrowRightLeft className="inline h-4 w-4 mr-1.5 opacity-70" />
          Crédito
          {!loadingCredito && cobrosSemanales.length > 0 && (
            <span className="ml-1.5 inline-flex items-center justify-center w-5 h-5 rounded-full bg-purple-600 text-white text-[10px] font-black">
              {cobrosSemanales.length > 99 ? '99+' : cobrosSemanales.length}
            </span>
          )}
        </button>
        <button onClick={() => setMainTab('incidencias')} className={btnTab(mainTab === 'incidencias')}>
          <AlertCircle className="inline h-4 w-4 mr-1.5 opacity-70" />
          Incidencias
          {!loadingIncidencias && incidenciasPendientes.length > 0 && (
            <span className="ml-1.5 inline-flex items-center justify-center w-5 h-5 rounded-full bg-red-500 text-white text-[10px] font-black">
              {incidenciasPendientes.length > 9 ? '9+' : incidenciasPendientes.length}
            </span>
          )}
        </button>
        <button onClick={() => setMainTab('conciliacion')} className={btnTab(mainTab === 'conciliacion')}>
          <ShieldCheck className="inline h-4 w-4 mr-1.5 opacity-70" />
          Conciliación
          {acumulacionesPendientes.length > 0 && (
            <span className="ml-1.5 inline-flex items-center justify-center w-5 h-5 rounded-full bg-amber-500 text-white text-[10px] font-black">
              {acumulacionesPendientes.length > 9 ? '9+' : acumulacionesPendientes.length}
            </span>
          )}
        </button>
      </div>

      {/* ── TAB: CONCILIACIÓN ────────────────────────────────────────────── */}
      {/* Entregas de crédito cuyo cobro semanal no llegó a acumularse. Se
          muestra lo mínimo para decidir: qué orden, de qué comercio, cuándo y
          por cuánto. El monto real lo recalcula siempre la callable — acá solo
          se informa el precio de la orden como referencia. */}
      {mainTab === 'conciliacion' && (
        <div className="rounded-2xl border border-gray-200 bg-white overflow-hidden">
          {acumulacionesPendientes.length === 0 ? (
            <p className="px-4 py-8 text-center text-sm text-gray-400">
              Sin acumulaciones pendientes. Todas las entregas de crédito están registradas en su cobro semanal.
            </p>
          ) : (
            <table className="w-full text-sm">
              <thead className="bg-gray-50 text-left text-xs font-semibold text-gray-500">
                <tr>
                  <th className="px-4 py-2.5">ORDEN</th>
                  <th className="px-4 py-2.5">COMERCIO</th>
                  <th className="px-4 py-2.5">ENTREGADA</th>
                  <th className="px-4 py-2.5">PRECIO</th>
                  <th className="px-4 py-2.5">ESTADO</th>
                  <th className="px-4 py-2.5">MOTIVO</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-gray-50">
                {acumulacionesPendientes.map((s) => {
                  const acu = (s as any).acumulacionCobroSemanal ?? {}
                  const requiereRevision = acu.estado === 'requiere_revision'
                  return (
                    <tr key={s.id} className="hover:bg-gray-50/70">
                      <td className="px-4 py-3 font-mono text-xs">{s.id.slice(0, 10)}</td>
                      <td className="px-4 py-3">{getClienteNombre(s, comercioNames)}</td>
                      <td className="px-4 py-3 text-gray-500">{fmtFecha(s.entregadoAt)}</td>
                      <td className="px-4 py-3 font-semibold">{fmt((s as any).confirmacion?.precioFinalCordobas)}</td>
                      <td className="px-4 py-3">
                        <span className={`inline-flex text-xs font-semibold px-2 py-0.5 rounded-full border ${
                          requiereRevision
                            ? 'bg-red-50 text-red-700 border-red-200'
                            : 'bg-amber-50 text-amber-700 border-amber-200'
                        }`}>
                          {requiereRevision ? 'Requiere revisión' : 'Pendiente'}
                        </span>
                      </td>
                      <td className="px-4 py-3 text-xs text-gray-500">{acu.motivo || '—'}</td>
                    </tr>
                  )
                })}
              </tbody>
            </table>
          )}
        </div>
      )}

      {/* ── TAB: CONTADO ─────────────────────────────────────────────────── */}
      {mainTab === 'contado' && (
        <div className="flex flex-col gap-3">
          {/* Sub-toggle */}
          <div className="flex gap-2 flex-wrap">
            <button
              onClick={() => setContadoSub('por_orden')}
              className={`px-3 py-1.5 rounded-lg text-xs font-semibold border transition ${
                contadoSub === 'por_orden' ? 'bg-gray-900 text-white border-gray-900' : 'bg-white text-gray-600 border-gray-200 hover:bg-gray-50'
              }`}
            >
              Por orden
            </button>
            <button
              onClick={() => setContadoSub('por_cliente')}
              className={`px-3 py-1.5 rounded-lg text-xs font-semibold border transition ${
                contadoSub === 'por_cliente' ? 'bg-gray-900 text-white border-gray-900' : 'bg-white text-gray-600 border-gray-200 hover:bg-gray-50'
              }`}
            >
              Por cliente / día
            </button>
            <button
              onClick={() => setContadoSub('pagados')}
              className={`px-3 py-1.5 rounded-lg text-xs font-semibold border transition ${
                contadoSub === 'pagados' ? 'bg-green-700 text-white border-green-700' : 'bg-white text-gray-600 border-gray-200 hover:bg-gray-50'
              }`}
            >
              Historial cobrados
              {contadoPagados.length > 0 && (
                <span className="ml-1.5 inline-flex items-center justify-center w-4 h-4 rounded-full bg-green-100 text-green-800 text-[10px] font-black">
                  {contadoPagados.length > 99 ? '99+' : contadoPagados.length}
                </span>
              )}
            </button>
          </div>

          {/* Por orden */}
          {contadoSub === 'por_orden' && (
            <div className="overflow-x-auto rounded-xl border border-gray-200 bg-white shadow-sm">
              {loadingContado ? (
                <div className="py-16 text-center text-sm text-gray-400">Cargando…</div>
              ) : contadoOrdenes.length === 0 ? (
                <div className="flex flex-col items-center justify-center py-16 gap-2 text-gray-400">
                  <CheckCircle2 className="h-10 w-10 opacity-30" />
                  <p className="text-sm font-medium">Sin cobros contado pendientes</p>
                </div>
              ) : (
                <table className="w-full text-sm">
                  <thead>
                    <tr className="border-b bg-gray-50">
                      <th className={thCls}>Entregado</th>
                      <th className={thCls}>Orden</th>
                      <th className={thCls}>Cliente</th>
                      <th className={thCls}>Forma pago</th>
                      <th className={`${thCls} text-right`}>Monto</th>
                      <th className={thCls}>Acción</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-gray-100">
                    {contadoOrdenes.map((s) => {
                      const esTransferencia = s.cobroDelivery?.quienPaga === 'transferencia' || s.pagoDelivery?.quienPaga === 'transferencia'
                      const tieneBoucher = s.cobroDelivery?.estado === 'en_revision_deposito' || !!s.cobroDelivery?.boucherUrl
                      return (
                        <tr key={s.id} className={`hover:bg-gray-50 transition-colors ${tieneBoucher ? 'bg-blue-50/40' : ''}`}>
                          <td className={tdCls}>{fmtDate(s.entregadoAt)}</td>
                          <td className={`${tdCls} font-mono text-xs text-gray-400`}>{s.id.slice(0, 8)}</td>
                          <td className={`${tdCls} font-semibold text-gray-900`}>{getClienteNombre(s, comercioNames)}</td>
                          <td className={tdCls}>
                            {esTransferencia ? (
                              <div className="flex flex-col gap-1">
                                <span className="inline-flex items-center gap-1 text-xs font-semibold px-2 py-0.5 rounded-full bg-blue-50 text-blue-700 border border-blue-200">
                                  <ArrowRightLeft className="h-3 w-3" /> Transferencia
                                </span>
                                {tieneBoucher ? (
                                  <span className="text-[11px] font-semibold text-blue-600">📎 Boucher adjunto</span>
                                ) : (
                                  <span className="text-[11px] font-semibold text-amber-500">⏳ Esperando boucher</span>
                                )}
                              </div>
                            ) : (
                              <span className="inline-flex items-center gap-1 text-xs font-semibold px-2 py-0.5 rounded-full bg-gray-100 text-gray-700 border border-gray-200">
                                <Banknote className="h-3 w-3" /> Efectivo
                              </span>
                            )}
                          </td>
                          <td className={`${tdCls} text-right font-semibold text-gray-900`}>
                            {fmt(s.cobroDelivery?.monto ?? (s as any).confirmacion?.precioFinalCordobas)}
                          </td>
                          <td className="px-4 py-3">
                            {tieneBoucher ? (
                              <button
                                onClick={() => setViendoBoucher(s)}
                                className="text-xs font-semibold px-3 py-1.5 rounded-lg bg-blue-600 text-white hover:bg-blue-700 transition"
                              >
                                🔍 Ver boucher
                              </button>
                            ) : esTransferencia ? (
                              <button
                                onClick={() => {
                                  setUploadingBoucherId(s.id)
                                  setTimeout(() => boucherInputRef.current?.click(), 0)
                                }}
                                className="text-xs font-semibold px-3 py-1.5 rounded-lg bg-amber-50 text-amber-700 border border-amber-200 hover:bg-amber-100 transition flex items-center gap-1"
                              >
                                <Upload className="h-3 w-3" />
                                Subir boucher
                              </button>
                            ) : (
                              <button
                                onClick={() => setMarcandoPago(s)}
                                className="text-xs font-semibold px-3 py-1.5 rounded-lg bg-green-50 text-green-700 border border-green-200 hover:bg-green-100 transition"
                              >
                                Marcar pagada
                              </button>
                            )}
                          </td>
                        </tr>
                      )
                    })}
                  </tbody>
                </table>
              )}
            </div>
          )}

          {/* Por cliente / día */}
          {contadoSub === 'por_cliente' && (
            <div className="overflow-x-auto rounded-xl border border-gray-200 bg-white shadow-sm">
              {errorGrupoPago && (
                <div className="m-3 flex items-start justify-between gap-2 rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-xs text-red-700">
                  <span>{errorGrupoPago}</span>
                  <button onClick={() => setErrorGrupoPago(null)} className="font-semibold hover:underline shrink-0">Cerrar</button>
                </div>
              )}
              {loadingContado ? (
                <div className="py-16 text-center text-sm text-gray-400">Cargando…</div>
              ) : contadoPorClienteDia.length === 0 ? (
                <div className="flex flex-col items-center justify-center py-16 gap-2 text-gray-400">
                  <CheckCircle2 className="h-10 w-10 opacity-30" />
                  <p className="text-sm font-medium">Sin cobros contado pendientes</p>
                </div>
              ) : (
                <table className="w-full text-sm">
                  <thead>
                    <tr className="border-b bg-gray-50">
                      <th className={thCls}>Cliente</th>
                      <th className={thCls}>Fecha</th>
                      <th className={thCls}># Órdenes</th>
                      <th className={`${thCls} text-right`}>Total día</th>
                      <th className={thCls}>Acción</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-gray-100">
                    {contadoPorClienteDia.map((g) => (
                      <tr key={g.key} className="hover:bg-gray-50 transition-colors">
                        <td className={`${tdCls} font-semibold text-gray-900`}>{g.clienteNombre}</td>
                        <td className={tdCls}>{g.fecha}</td>
                        <td className={tdCls}>
                          <span className="inline-flex items-center justify-center w-6 h-6 rounded-full bg-gray-100 text-xs font-semibold text-gray-700">
                            {g.ordenes.length}
                          </span>
                        </td>
                        <td className={`${tdCls} text-right font-semibold text-gray-900`}>{fmt(g.total)}</td>
                        <td className="px-4 py-3">
                          <div className="flex gap-1.5">
                            <button
                              onClick={async () => {
                                setErrorGrupoPago(null)
                                setProcesandoGrupoKey(g.key)
                                try {
                                  await marcarGrupoPagado(g.ordenes, 'efectivo')
                                } catch (e: any) {
                                  setErrorGrupoPago(e?.message || 'Error al marcar el grupo como pagado. No se aplicó ningún cambio.')
                                } finally {
                                  setProcesandoGrupoKey(null)
                                }
                              }}
                              disabled={procesandoGrupoKey === g.key}
                              className="text-xs font-semibold px-2.5 py-1.5 rounded-lg bg-green-50 text-green-700 border border-green-200 hover:bg-green-100 transition whitespace-nowrap disabled:opacity-40 disabled:cursor-not-allowed"
                            >
                              <Banknote className="inline h-3 w-3 mr-1" />{procesandoGrupoKey === g.key ? 'Procesando…' : 'Efectivo'}
                            </button>
                            <button
                              onClick={async () => {
                                setErrorGrupoPago(null)
                                setProcesandoGrupoKey(g.key)
                                try {
                                  await marcarGrupoPagado(g.ordenes, 'transferencia')
                                } catch (e: any) {
                                  setErrorGrupoPago(e?.message || 'Error al marcar el grupo como pagado. No se aplicó ningún cambio.')
                                } finally {
                                  setProcesandoGrupoKey(null)
                                }
                              }}
                              disabled={procesandoGrupoKey === g.key}
                              className="text-xs font-semibold px-2.5 py-1.5 rounded-lg bg-blue-50 text-blue-700 border border-blue-200 hover:bg-blue-100 transition whitespace-nowrap disabled:opacity-40 disabled:cursor-not-allowed"
                            >
                              <ArrowRightLeft className="inline h-3 w-3 mr-1" />{procesandoGrupoKey === g.key ? 'Procesando…' : 'Trans.'}
                            </button>
                          </div>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}
            </div>
          )}

          {/* Historial cobrados */}
          {contadoSub === 'pagados' && (
            <div className="overflow-x-auto rounded-xl border border-gray-200 bg-white shadow-sm">
              {errorReversion && (
                <div className="m-3 flex items-start justify-between gap-2 rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-xs text-red-700">
                  <span>{errorReversion}</span>
                  <button onClick={() => setErrorReversion(null)} className="font-semibold hover:underline shrink-0">Cerrar</button>
                </div>
              )}
              {loadingContado ? (
                <div className="py-16 text-center text-sm text-gray-400">Cargando…</div>
              ) : contadoPagados.length === 0 ? (
                <div className="flex flex-col items-center justify-center py-16 gap-2 text-gray-400">
                  <CheckCircle2 className="h-10 w-10 opacity-30" />
                  <p className="text-sm font-medium">Sin cobros registrados aún</p>
                </div>
              ) : (
                <table className="w-full text-sm">
                  <thead>
                    <tr className="border-b bg-gray-50">
                      <th className={thCls}>Cobrado</th>
                      <th className={thCls}>Orden</th>
                      <th className={thCls}>Cliente</th>
                      <th className={thCls}>Forma</th>
                      <th className={thCls}>Nota</th>
                      <th className={`${thCls} text-right`}>Monto</th>
                      <th className={thCls}>Acción</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-gray-100">
                    {contadoPagados.map((s) => {
                      const fp = s.cobroDelivery?.formaPago
                      const esTrans = fp === 'transferencia' || s.pagoDelivery?.quienPaga === 'transferencia'
                      return (
                        <tr key={s.id} className="hover:bg-gray-50 transition-colors">
                          <td className={tdCls}>{fmtDate(s.cobroDelivery?.pagadoAt)}</td>
                          <td className={`${tdCls} font-mono text-xs text-gray-400`}>{s.id.slice(0, 8)}</td>
                          <td className={`${tdCls} font-semibold text-gray-900`}>{getClienteNombre(s, comercioNames)}</td>
                          <td className={tdCls}>
                            {esTrans ? (
                              <span className="inline-flex items-center gap-1 text-xs font-semibold px-2 py-0.5 rounded-full bg-blue-50 text-blue-700 border border-blue-200">
                                <ArrowRightLeft className="h-3 w-3" /> Trans.
                              </span>
                            ) : fp === 'efectivo' ? (
                              <span className="inline-flex items-center gap-1 text-xs font-semibold px-2 py-0.5 rounded-full bg-green-50 text-green-700 border border-green-200">
                                <Banknote className="h-3 w-3" /> Efectivo
                              </span>
                            ) : (
                              <span className="text-xs text-gray-400">—</span>
                            )}
                          </td>
                          <td className={`${tdCls} max-w-[160px]`}>
                            {s.cobroDelivery?.notaPago
                              ? <span className="text-xs text-gray-600 truncate block" title={s.cobroDelivery.notaPago}>{s.cobroDelivery.notaPago}</span>
                              : <span className="text-xs text-gray-300">—</span>
                            }
                          </td>
                          <td className={`${tdCls} text-right font-semibold text-green-700`}>
                            {fmt(s.cobroDelivery?.monto ?? (s as any).confirmacion?.precioFinalCordobas)}
                          </td>
                          <td className="px-4 py-3">
                            <div className="flex items-center gap-2">
                              {esTrans && s.cobroDelivery?.boucherUrl && (
                                <button
                                  onClick={() => setViendoBoucher(s)}
                                  className="text-xs font-semibold px-3 py-1.5 rounded-lg bg-blue-50 text-blue-600 border border-blue-200 hover:bg-blue-100 transition"
                                >
                                  Ver boucher
                                </button>
                              )}
                              <button
                                onClick={async () => {
                                  setErrorReversion(null)
                                  setRevirtiendoId(s.id)
                                  try {
                                    await revertirPagada(s)
                                  } catch (e: any) {
                                    setErrorReversion(e?.message || 'Error al revertir. No se aplicó ningún cambio.')
                                  } finally {
                                    setRevirtiendoId(null)
                                  }
                                }}
                                disabled={revirtiendoId === s.id}
                                className="text-xs font-semibold px-3 py-1.5 rounded-lg bg-red-50 text-red-600 border border-red-200 hover:bg-red-100 transition disabled:opacity-40 disabled:cursor-not-allowed"
                              >
                                {revirtiendoId === s.id ? 'Revirtiendo…' : 'Revertir'}
                              </button>
                            </div>
                          </td>
                        </tr>
                      )
                    })}
                  </tbody>
                </table>
              )}
            </div>
          )}
        </div>
      )}

      {/* ── TAB: CRÉDITO ─────────────────────────────────────────────────── */}
      {mainTab === 'credito' && (
        <div className="flex flex-col gap-3">
          {loadingCredito ? (
            <div className="bg-white rounded-xl border border-gray-200 py-16 text-center text-sm text-gray-400">Cargando…</div>
          ) : cobrosSemanales.length === 0 ? (
            <div className="bg-white rounded-xl border border-gray-200 flex flex-col items-center justify-center py-16 gap-2 text-gray-400">
              <CheckCircle2 className="h-10 w-10 opacity-30" />
              <p className="text-sm font-medium">Sin créditos semanales pendientes</p>
            </div>
          ) : (
            cobrosSemanales.map((cs) => {
              const pendiente = cs.totalMonto - cs.totalPagado
              const isExpanded = expandedSemana === cs.id
              return (
                <div key={cs.id} className="bg-white rounded-xl border border-gray-200 shadow-sm overflow-hidden">
                  <div className="px-4 py-3 flex items-center gap-3">
                    <div className="flex-1 min-w-0">
                      <p className="text-sm font-bold text-gray-900 truncate">
                        {cs.clienteCompany || cs.clienteNombre}
                      </p>
                      <p className="text-xs text-gray-500 mt-0.5">{formatSemanaDisplay(cs.semanaKey)}</p>
                    </div>
                    <div className="text-right hidden sm:block">
                      <p className="text-xs text-gray-400">Total</p>
                      <p className="text-sm font-semibold text-gray-800">{fmt(cs.totalMonto)}</p>
                    </div>
                    <div className="text-right hidden sm:block">
                      <p className="text-xs text-gray-400">Pagado</p>
                      <p className="text-sm font-semibold text-green-700">{fmt(cs.totalPagado)}</p>
                    </div>
                    <div className="text-right">
                      <p className="text-xs text-gray-400">Pendiente</p>
                      <p className="text-sm font-bold text-orange-700">{fmt(pendiente)}</p>
                    </div>
                    <EstadoBadge estado={cs.estado} />
                    <button
                      onClick={() => setPagandoSemana(cs)}
                      className="text-xs font-semibold px-3 py-1.5 rounded-lg bg-[#004aad] text-white hover:bg-[#0a49a4] transition whitespace-nowrap"
                    >
                      Registrar pago
                    </button>
                    <button
                      onClick={() => setExpandedSemana(isExpanded ? null : cs.id)}
                      className="text-gray-400 hover:text-gray-600 transition"
                      title="Ver órdenes"
                    >
                      {isExpanded ? <ChevronUp className="h-4 w-4" /> : <ChevronDown className="h-4 w-4" />}
                    </button>
                  </div>

                  {/* Detalle expandido */}
                  {isExpanded && (
                    <div className="border-t border-gray-100 px-4 py-3 bg-gray-50">
                      <p className="text-xs font-semibold text-gray-500 mb-2">
                        Órdenes incluidas ({cs.ordenesIds.length})
                      </p>
                      <div className="flex flex-wrap gap-1.5 mb-3">
                        {cs.ordenesIds.map((oid) => (
                          <span key={oid} className="font-mono text-xs bg-white border border-gray-200 rounded px-1.5 py-0.5 text-gray-600">
                            {oid.slice(0, 8)}
                          </span>
                        ))}
                      </div>
                      {cs.pagos.length > 0 && (
                        <>
                          <p className="text-xs font-semibold text-gray-500 mb-2">Pagos registrados</p>
                          <div className="space-y-1.5">
                            {cs.pagos.map((p, i) => (
                              <div key={i} className="flex items-center gap-3 text-xs text-gray-600">
                                <span className="font-semibold text-green-700">{fmt(p.monto)}</span>
                                <span className="text-gray-400">{fmtDateShort(p.at)}</span>
                                {p.nota && <span className="text-gray-500 truncate">{p.nota}</span>}
                              </div>
                            ))}
                          </div>
                        </>
                      )}
                    </div>
                  )}
                </div>
              )
            })
          )}
        </div>
      )}

      {/* ── TAB: INCIDENCIAS ─────────────────────────────────────────────── */}
      {mainTab === 'incidencias' && (
        <div className="flex flex-col gap-3">
          {/* Sub-tabs */}
          <div className="flex gap-2">
            <button onClick={() => setIncidenciasTab('pendientes')} className={btnTab(incidenciasTab === 'pendientes')}>
              Pendientes
              {!loadingIncidencias && incidenciasPendientes.length > 0 && (
                <span className="ml-1.5 inline-flex items-center justify-center w-5 h-5 rounded-full bg-red-500 text-white text-[10px] font-black">
                  {incidenciasPendientes.length > 9 ? '9+' : incidenciasPendientes.length}
                </span>
              )}
            </button>
            <button onClick={() => setIncidenciasTab('resueltos')} className={btnTab(incidenciasTab === 'resueltos')}>
              Resueltos
            </button>
          </div>

          {/* Tabla */}
          <div className="overflow-x-auto rounded-xl border border-gray-200 bg-white shadow-sm">
            {loadingIncidencias ? (
              <div className="py-16 text-center text-sm text-gray-400">Cargando…</div>
            ) : (incidenciasTab === 'pendientes' ? incidenciasPendientes : incidenciasResueltas).length === 0 ? (
              <div className="flex flex-col items-center justify-center py-16 gap-2 text-gray-400">
                <CheckCircle2 className="h-10 w-10 opacity-30" />
                <p className="text-sm font-medium">
                  {incidenciasTab === 'pendientes' ? 'Sin incidencias pendientes' : 'No hay casos resueltos aún'}
                </p>
              </div>
            ) : (
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b bg-gray-50">
                    <th className={thCls}>Fecha</th>
                    <th className={thCls}>Orden</th>
                    <th className={thCls}>Comercio</th>
                    <th className={thCls}>Motorizado</th>
                    <th className={thCls}>Tipo</th>
                    <th className={`${thCls} text-right`}>Monto</th>
                    <th className={thCls}>Justificación</th>
                    {incidenciasTab === 'pendientes' && <th className={thCls}>Acción</th>}
                    {incidenciasTab === 'resueltos' && <th className={thCls}>Resolución</th>}
                  </tr>
                </thead>
                <tbody className="divide-y divide-gray-100">
                  {(incidenciasTab === 'pendientes' ? incidenciasPendientes : incidenciasResueltas).map((s) => {
                    const comercio = s.ownerSnapshot?.companyName || s.ownerSnapshot?.nombre || s.userId?.slice(0, 8) || '—'
                    const motorizado = s.asignacion?.motorizadoNombre || s.asignacion?.motorizadoId?.slice(0, 8) || '—'
                    const tipo = getTipoCobro(s)
                    const monto = getMontoPendiente(s)
                    const justs = getJustificaciones(s)
                    const resolucion = s.cobrosMotorizado?.resolucion
                    return (
                      <tr key={s.id} className="hover:bg-gray-50 transition-colors">
                        <td className={tdCls}>
                          {incidenciasTab === 'resueltos'
                            ? fmtDate(s.cobrosMotorizado?.resolucion?.at)
                            : fmtDate(s.createdAt)}
                        </td>
                        <td className={`${tdCls} font-mono text-xs text-gray-400`}>{s.id.slice(0, 8)}</td>
                        <td className={`${tdCls} font-semibold text-gray-900`}>{comercio}</td>
                        <td className={tdCls}>
                          <div className="flex items-center gap-2">
                            <div className="w-6 h-6 rounded-full bg-[#004aad]/10 grid place-items-center flex-shrink-0">
                              <span className="text-[10px] font-black text-[#004aad]">
                                {(motorizado || '?')[0].toUpperCase()}
                              </span>
                            </div>
                            {motorizado}
                          </div>
                        </td>
                        <td className={tdCls}>
                          <span className="inline-flex text-xs font-semibold px-2 py-0.5 rounded-full bg-orange-50 text-orange-700 border border-orange-200">
                            {tipo}
                          </span>
                        </td>
                        <td className={`${tdCls} text-right font-semibold text-red-600`}>
                          {monto > 0 ? fmt(monto) : '—'}
                        </td>
                        <td className={`${tdCls} max-w-[200px]`}>
                          {justs.length === 0 ? (
                            <span className="text-gray-400 text-xs">Sin justificación</span>
                          ) : (
                            <ul className="space-y-0.5">
                              {justs.map((j, i) => (
                                <li key={i} className="text-xs text-gray-600 truncate" title={j}>{j}</li>
                              ))}
                            </ul>
                          )}
                        </td>
                        {incidenciasTab === 'pendientes' && (
                          <td className="px-4 py-3">
                            <button
                              onClick={() => setResolvingIncidencia(s)}
                              className="text-xs font-semibold px-3 py-1.5 rounded-lg bg-[#004aad] text-white hover:bg-[#0a49a4] transition"
                            >
                              Resolver
                            </button>
                          </td>
                        )}
                        {incidenciasTab === 'resueltos' && (
                          <td className={`${tdCls} max-w-[180px]`}>
                            {resolucion?.tipo === 'cliente_pagara' ? (
                              <p className="text-xs text-blue-700 font-semibold">→ Pasa a Cobros</p>
                            ) : resolucion?.tipo === 'se_pierde' ? (
                              <p className="text-xs text-red-600 font-semibold">✗ Se perdió</p>
                            ) : (
                              <p className="text-xs text-green-700 font-semibold">✓ Resuelto</p>
                            )}
                            <p className="text-xs text-gray-400 truncate">{fmtDate(resolucion?.at)}</p>
                            {resolucion?.nota && (
                              <p className="text-xs text-gray-500 truncate" title={resolucion.nota}>
                                {resolucion.nota}
                              </p>
                            )}
                          </td>
                        )}
                      </tr>
                    )
                  })}
                </tbody>
              </table>
            )}
          </div>
        </div>
      )}
    </div>
  )
}
