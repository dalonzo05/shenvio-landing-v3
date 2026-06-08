'use client'

import { useEffect, useMemo, useRef, useState } from 'react'
import Link from 'next/link'
import {
  collection,
  deleteField,
  doc,
  onSnapshot,
  query,
  serverTimestamp,
  updateDoc,
  where,
  Timestamp,
} from 'firebase/firestore'
import { auth, db } from '@/fb/config'
import { compressImage, uploadEvidenciaPath } from '@/fb/storage'
import { Package, Upload, X } from 'lucide-react'

// ─── Types ────────────────────────────────────────────────────────────────────

type Solicitud = {
  id: string
  estado?: string
  createdAt?: Timestamp
  tipoServicio?: 'normal' | 'fuera_managua' | 'compra_gestion'
  recoleccion?: { direccionEscrita?: string; nombreApellido?: string }
  entrega?: { direccionEscrita?: string; nombreApellido?: string }
  fueraManagua?: {
    metodoEnvio?: 'bus_terminal' | 'cargotrans'
    destinoFinal?: string | null
    puntoLogisticoNombre?: string | null
    terminalSugerida?: string | null
  }
  confirmacion?: { precioFinalCordobas?: number }
  cobroContraEntrega?: { aplica?: boolean; monto?: number }
  pagoDelivery?: { tipo?: string; quienPaga?: string; montoSugerido?: number | null }
  tipoCliente?: string
  cobrosMotorizado?: {
    delivery?: { monto: number; recibio: boolean }
    producto?: { monto: number; recibio: boolean }
  }
  registro?: {
    deposito?: {
      confirmadoComercio?: boolean
      confirmadoStorkhub?: boolean
      comercioDepositoId?: string
      storkhubDepositoId?: string
    }
  }
  cobroDelivery?: {
    estado?: string
    boucherUrl?: string
    boucherPath?: string
    boucherAt?: any
    monto?: number
    subidoPor?: string
  }
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

const estadoLabel: Record<string, string> = {
  pendiente_confirmacion: 'Pendiente',
  confirmada: 'Confirmada',
  asignada: 'Asignada',
  en_camino_retiro: 'En camino al retiro',
  retirado: 'Retirado',
  en_camino_entrega: 'En camino a entrega',
  entregado: 'Entregada',
  cancelada: 'Cancelada',
}

const estadoCls: Record<string, string> = {
  pendiente_confirmacion: 'bg-gray-100 text-gray-600 border-gray-200',
  confirmada: 'bg-blue-50 text-blue-700 border-blue-200',
  asignada: 'bg-yellow-50 text-yellow-700 border-yellow-200',
  en_camino_retiro: 'bg-yellow-50 text-yellow-700 border-yellow-200',
  retirado: 'bg-purple-50 text-purple-700 border-purple-200',
  en_camino_entrega: 'bg-purple-50 text-purple-700 border-purple-200',
  entregado: 'bg-green-50 text-green-700 border-green-200',
  cancelada: 'bg-red-50 text-red-600 border-red-200',
}

function tsToDate(v: any): Date | null {
  if (!v) return null
  if (typeof v?.toDate === 'function') return v.toDate()
  if (v instanceof Date) return v
  return null
}

function fmt(n?: number) {
  if (typeof n !== 'number') return '—'
  return `C$ ${n.toLocaleString('es-NI')}`
}

function fmtDate(v: any) {
  const d = tsToDate(v)
  if (!d) return '—'
  return d.toLocaleDateString('es-NI', { day: '2-digit', month: 'short', year: 'numeric' })
}

type DepositoEstado = 'na' | 'pendiente' | 'en_revision' | 'depositado'

function estadoDeposito(s: Solicitud): DepositoEstado {
  if (!s.cobroContraEntrega?.aplica) return 'na'
  const dep = s.registro?.deposito
  if (dep?.confirmadoComercio) return 'depositado'
  if (dep?.comercioDepositoId) return 'en_revision'
  return 'pendiente'
}

function debeDelivery(s: Solicitud): boolean | null {
  const qp = s.pagoDelivery?.quienPaga || ''
  if (s.tipoCliente === 'credito' || qp === 'credito_semanal') return true
  // transferencia: handled separately in the column
  if (qp === 'transferencia') return null
  // efectivo — depende de si motorizado confirmó recibo
  if (s.cobrosMotorizado?.delivery !== undefined) return !s.cobrosMotorizado.delivery.recibio
  return null
}

// ─── Component ───────────────────────────────────────────────────────────────

type FiltroEstado = 'todas' | 'activas' | 'entregadas'

export default function MisOrdenesPage() {
  const [ordenes, setOrdenes] = useState<Solicitud[]>([])
  const [loading, setLoading] = useState(true)
  const [filtro, setFiltro] = useState<FiltroEstado>('todas')

  // Boucher upload
  const fileInputRef = useRef<HTMLInputElement>(null)
  const [uploadTargetId, setUploadTargetId] = useState<string | null>(null)
  const [uploadingId, setUploadingId] = useState<string | null>(null)
  const [uploadErr, setUploadErr] = useState<string | null>(null)

  // Boucher viewer modal
  const [viendoBoucherUrl, setViendoBoucherUrl] = useState<string | null>(null)

  useEffect(() => {
    const user = auth.currentUser
    if (!user) return
    const q = query(
      collection(db, 'solicitudes_envio'),
      where('userId', '==', user.uid)
    )
    const unsub = onSnapshot(q, (snap) => {
      const list = snap.docs
        .map((d) => ({ id: d.id, ...(d.data() as any) }))
        .sort((a, b) => (tsToDate(b.createdAt)?.getTime() || 0) - (tsToDate(a.createdAt)?.getTime() || 0))
      setOrdenes(list)
      setLoading(false)
    })
    return () => unsub()
  }, [])

  function triggerUpload(solicitudId: string) {
    setUploadTargetId(solicitudId)
    setUploadErr(null)
    fileInputRef.current?.click()
  }

  async function handleFileChange(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0]
    if (!file || !uploadTargetId) return
    e.target.value = ''
    const targetId = uploadTargetId
    setUploadingId(targetId)
    setUploadErr(null)
    try {
      const blob = await compressImage(file)
      const path = `evidencias/${targetId}/delivery_boucher.jpg`
      const { url, pathStorage } = await uploadEvidenciaPath(path, blob)
      const s = ordenes.find((o) => o.id === targetId)
      await updateDoc(doc(db, 'solicitudes_envio', targetId), {
        'cobroDelivery.estado': 'en_revision_deposito',
        'cobroDelivery.boucherUrl': url,
        'cobroDelivery.boucherPath': pathStorage,
        'cobroDelivery.boucherAt': serverTimestamp(),
        'cobroDelivery.monto': s?.confirmacion?.precioFinalCordobas ?? 0,
        'cobroDelivery.tipoCliente': 'contado',
        'cobroDelivery.quienPaga': 'transferencia',
        'cobroDelivery.registradoAt': serverTimestamp(),
        updatedAt: serverTimestamp(),
      })
    } catch (err) {
      console.error(err)
      setUploadErr('Error al subir el boucher. Intentá de nuevo.')
    } finally {
      setUploadingId(null)
      setUploadTargetId(null)
    }
  }

  async function handleQuitarBoucher(solicitudId: string) {
    try {
      await updateDoc(doc(db, 'solicitudes_envio', solicitudId), {
        'cobroDelivery.estado': 'pendiente',
        'cobroDelivery.boucherUrl': deleteField(),
        'cobroDelivery.boucherPath': deleteField(),
        'cobroDelivery.boucherAt': deleteField(),
        'cobroDelivery.subidoPor': deleteField(),
        updatedAt: serverTimestamp(),
      })
    } catch (err) {
      console.error(err)
    }
  }

  const activas = ['pendiente_confirmacion', 'confirmada', 'asignada', 'en_camino_retiro', 'retirado', 'en_camino_entrega']

  const filtered = useMemo(() => {
    if (filtro === 'activas') return ordenes.filter((o) => activas.includes(o.estado || ''))
    if (filtro === 'entregadas') return ordenes.filter((o) => o.estado === 'entregado')
    return ordenes
  }, [ordenes, filtro])

  const thCls = 'px-4 py-3 text-left text-[11px] font-semibold uppercase tracking-wide text-gray-500'
  const tdCls = 'px-4 py-3 text-sm text-gray-700'

  const btnFiltro = (f: FiltroEstado) =>
    `px-3 py-1.5 rounded-lg text-sm font-semibold border transition ${
      filtro === f ? 'bg-[#004aad] text-white border-[#004aad]' : 'bg-white text-gray-600 border-gray-200 hover:bg-gray-50'
    }`

  return (
    <div className="flex flex-col gap-4">
      {/* Hidden file input for boucher upload */}
      <input
        ref={fileInputRef}
        type="file"
        accept="image/*"
        className="hidden"
        onChange={handleFileChange}
      />

      {/* Boucher viewer modal */}
      {viendoBoucherUrl && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 backdrop-blur-sm px-4">
          <div className="bg-white rounded-2xl shadow-2xl w-full max-w-sm p-5">
            <div className="flex items-center justify-between mb-3">
              <h3 className="text-base font-black text-gray-900">Boucher de transferencia</h3>
              <button
                onClick={() => setViendoBoucherUrl(null)}
                className="w-8 h-8 grid place-items-center rounded-full border border-gray-200 hover:bg-gray-50"
              >
                <X className="h-4 w-4 text-gray-500" />
              </button>
            </div>
            <a href={viendoBoucherUrl} target="_blank" rel="noreferrer" className="block mb-3">
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img
                src={viendoBoucherUrl}
                alt="Boucher de transferencia"
                className="w-full rounded-xl border border-gray-200 object-contain max-h-64"
              />
              <p className="text-xs text-center text-blue-600 mt-1 hover:underline">Ver imagen completa →</p>
            </a>
            <button
              onClick={() => setViendoBoucherUrl(null)}
              className="w-full border border-gray-200 text-gray-600 text-sm font-semibold py-2.5 rounded-xl hover:bg-gray-50 transition"
            >
              Cerrar
            </button>
          </div>
        </div>
      )}

      {/* Header */}
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-black text-gray-900 tracking-tight">Mis órdenes</h1>
          <p className="text-sm text-gray-500 mt-0.5">Historial y estado de todos tus envíos.</p>
        </div>
        <Link
          href="/panel/comercio/solicitar"
          className="bg-[#004aad] text-white text-sm font-semibold px-4 py-2 rounded-xl hover:bg-[#003a8c] transition"
        >
          + Nueva orden
        </Link>
      </div>

      {/* Banner órdenes activas */}
      {!loading && ordenes.filter((o) => activas.includes(o.estado || '')).length > 0 && (
        <div className="flex items-center gap-3 rounded-xl bg-orange-50 border border-orange-200 px-4 py-3">
          <span className="relative flex h-3 w-3 shrink-0">
            <span className="absolute inline-flex h-full w-full rounded-full bg-orange-400 opacity-75" style={{ animation: 'pulse-ring 1.5s ease-out infinite' }} />
            <span className="relative inline-flex h-3 w-3 rounded-full bg-orange-500" />
          </span>
          <p className="text-sm font-semibold text-orange-800">
            Tenés <span className="font-black">{ordenes.filter((o) => activas.includes(o.estado || '')).length}</span> {ordenes.filter((o) => activas.includes(o.estado || '')).length === 1 ? 'orden activa' : 'órdenes activas'} en este momento
          </p>
          <button
            onClick={() => setFiltro('activas')}
            className="ml-auto text-xs font-bold text-orange-700 hover:text-orange-900 underline underline-offset-2"
          >
            Ver activas →
          </button>
        </div>
      )}

      {/* Filtros */}
      <div className="flex gap-2">
        <button onClick={() => setFiltro('todas')} className={btnFiltro('todas')}>Todas ({ordenes.length})</button>
        <button onClick={() => setFiltro('activas')} className={btnFiltro('activas')}>
          Activas ({ordenes.filter((o) => activas.includes(o.estado || '')).length})
        </button>
        <button onClick={() => setFiltro('entregadas')} className={btnFiltro('entregadas')}>
          Entregadas ({ordenes.filter((o) => o.estado === 'entregado').length})
        </button>
      </div>

      {uploadErr && (
        <div className="text-xs text-red-600 bg-red-50 border border-red-200 rounded-lg px-3 py-2">{uploadErr}</div>
      )}

      {/* Tabla */}
      <div className="overflow-x-auto rounded-xl border border-gray-200 bg-white shadow-sm">
        {loading ? (
          <div className="py-16 text-center text-sm text-gray-400">Cargando órdenes…</div>
        ) : filtered.length === 0 ? (
          <div className="flex flex-col items-center justify-center py-16 gap-2 text-gray-400">
            <Package className="h-10 w-10 opacity-30" />
            <p className="text-sm font-medium">No hay órdenes en esta categoría</p>
          </div>
        ) : (
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b bg-gray-50">
                <th className={thCls}>#</th>
                <th className={thCls}>Fecha</th>
                <th className={thCls}>Retiro</th>
                <th className={thCls}>Entrega</th>
                <th className={`${thCls} text-right`}>Delivery</th>
                <th className={thCls}>Estado</th>
                <th className={thCls}>Producto</th>
                <th className={thCls}>Depósito producto</th>
                <th className={thCls}>Delivery pago</th>
                <th className={thCls} />
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-100">
              {filtered.map((o, idx) => {
                const estadoCl = estadoCls[o.estado || ''] || 'bg-gray-100 text-gray-600 border-gray-200'
                const debe = debeDelivery(o)
                const cobrado = o.cobrosMotorizado?.producto
                const esTransferencia = o.pagoDelivery?.quienPaga === 'transferencia'
                const cdEstado = o.cobroDelivery?.estado
                const isUploading = uploadingId === o.id

                return (
                  <tr key={o.id} className="hover:bg-gray-50 transition-colors">
                    <td className={`${tdCls} text-gray-400 font-mono text-xs`}>{idx + 1}</td>
                    <td className={tdCls}>{fmtDate(o.createdAt)}</td>
                    <td className={`${tdCls} max-w-[140px]`}>
                      <p className="truncate text-gray-900 font-medium">{o.recoleccion?.nombreApellido || '—'}</p>
                      <p className="truncate text-gray-400 text-xs">{o.recoleccion?.direccionEscrita || ''}</p>
                    </td>
                    <td className={`${tdCls} max-w-[140px]`}>
                      {o.tipoServicio === 'fuera_managua' && o.fueraManagua ? (
                        <>
                          <p className="truncate text-violet-700 font-semibold text-xs">
                            {o.fueraManagua.metodoEnvio === 'cargotrans' ? '📦 Cargotrans' : '🚌 Bus/Terminal'}
                          </p>
                          <p className="truncate text-gray-900 font-medium">
                            {o.fueraManagua.puntoLogisticoNombre || o.fueraManagua.terminalSugerida || '—'}
                          </p>
                          {o.fueraManagua.destinoFinal && (
                            <p className="truncate text-gray-400 text-xs">Destino: {o.fueraManagua.destinoFinal}</p>
                          )}
                        </>
                      ) : (
                        <>
                          <p className="truncate text-gray-900 font-medium">{o.entrega?.nombreApellido || '—'}</p>
                          <p className="truncate text-gray-400 text-xs">{o.entrega?.direccionEscrita || ''}</p>
                        </>
                      )}
                    </td>
                    <td className={`${tdCls} text-right font-semibold`}>
                      {(() => {
                        const confirmado = o.confirmacion?.precioFinalCordobas
                        const sugerido = o.pagoDelivery?.montoSugerido
                        if (typeof confirmado === 'number') return <span className="text-[#004aad]">{fmt(confirmado)}</span>
                        if (typeof sugerido === 'number') return <span className="text-gray-400" title="Precio estimado, pendiente de confirmación">~{fmt(sugerido)}</span>
                        return <span className="text-gray-300">—</span>
                      })()}
                    </td>
                    <td className={tdCls}>
                      <span className={`inline-flex text-xs font-semibold px-2.5 py-1 rounded-full border ${estadoCl}`}>
                        {estadoLabel[o.estado || ''] || o.estado}
                      </span>
                    </td>
                    <td className={tdCls}>
                      {!o.cobroContraEntrega?.aplica ? (
                        <span className="text-gray-400 text-xs">N/A</span>
                      ) : cobrado ? (
                        <span className={`inline-flex text-xs font-semibold px-2 py-0.5 rounded-full ${cobrado.recibio ? 'bg-green-50 text-green-700' : 'bg-red-50 text-red-600'}`}>
                          {cobrado.recibio ? `✓ ${fmt(cobrado.monto)}` : '✗ No cobrado'}
                        </span>
                      ) : (
                        <span className="text-gray-400 text-xs">{fmt(o.cobroContraEntrega?.monto)}</span>
                      )}
                    </td>
                    <td className={tdCls}>
                      {(() => {
                        const dep = estadoDeposito(o)
                        if (dep === 'na') return <span className="text-gray-400 text-xs">N/A</span>
                        if (dep === 'depositado') return (
                          <Link href="/panel/comercio/depositos" className="inline-flex text-xs font-semibold px-2 py-0.5 rounded-full bg-green-50 text-green-700 border border-green-200 hover:bg-green-100 transition">✓ Depositado →</Link>
                        )
                        if (dep === 'en_revision') return (
                          <Link href="/panel/comercio/depositos" className="inline-flex text-xs font-semibold px-2 py-0.5 rounded-full bg-blue-50 text-blue-700 border border-blue-200 hover:bg-blue-100 transition">🔍 En revisión →</Link>
                        )
                        return <span className="inline-flex text-xs font-semibold px-2 py-0.5 rounded-full bg-yellow-50 text-yellow-700 border border-yellow-200">Pendiente</span>
                      })()}
                    </td>

                    {/* ── Delivery pago ─────────────────────────────────── */}
                    <td className={tdCls}>
                      {esTransferencia ? (
                        cdEstado === 'pagado' ? (
                          <div className="flex flex-col gap-1">
                            <span className="inline-flex text-xs font-semibold px-2 py-0.5 rounded-full bg-green-50 text-green-700 border border-green-200">
                              ✓ Pagado
                            </span>
                            {o.cobroDelivery?.boucherUrl && (
                              <button
                                onClick={() => setViendoBoucherUrl(o.cobroDelivery!.boucherUrl!)}
                                className="text-[11px] font-semibold text-blue-600 hover:underline text-left"
                              >
                                Ver boucher →
                              </button>
                            )}
                          </div>
                        ) : cdEstado === 'en_revision_deposito' ? (
                          <div className="flex flex-col gap-1.5">
                            <span className="inline-flex text-xs font-semibold px-2 py-0.5 rounded-full bg-blue-50 text-blue-700 border border-blue-200">
                              🔍 En revisión
                            </span>
                            {o.cobroDelivery?.subidoPor !== 'gestor' && (
                              <div className="flex gap-1">
                                <button
                                  onClick={() => triggerUpload(o.id)}
                                  disabled={isUploading}
                                  className="text-[11px] font-semibold px-2 py-1 rounded-lg border border-gray-200 text-gray-600 hover:bg-gray-100 transition disabled:opacity-50"
                                >
                                  {isUploading ? '…' : '↺ Reemplazar'}
                                </button>
                                <button
                                  onClick={() => handleQuitarBoucher(o.id)}
                                  className="text-[11px] font-semibold px-2 py-1 rounded-lg border border-red-200 text-red-600 bg-red-50 hover:bg-red-100 transition"
                                >
                                  ✕ Quitar
                                </button>
                              </div>
                            )}
                          </div>
                        ) : (
                          <div className="flex flex-col gap-1.5">
                            <span className="inline-flex text-xs font-semibold px-2 py-0.5 rounded-full bg-yellow-50 text-yellow-700 border border-yellow-200">
                              Pago x depósito
                            </span>
                            <button
                              onClick={() => triggerUpload(o.id)}
                              disabled={isUploading}
                              className="inline-flex items-center gap-1 text-[11px] font-semibold px-2 py-1 rounded-lg bg-[#004aad] text-white hover:bg-[#003a8c] transition disabled:opacity-50"
                            >
                              <Upload size={10} />
                              {isUploading ? 'Subiendo…' : 'Subir boucher'}
                            </button>
                          </div>
                        )
                      ) : debe === null ? (
                        <span className="text-gray-400 text-xs">—</span>
                      ) : debe ? (
                        <span className="inline-flex text-xs font-semibold px-2 py-0.5 rounded-full bg-red-50 text-red-600">Debe</span>
                      ) : (
                        <span className="inline-flex text-xs font-semibold px-2 py-0.5 rounded-full bg-green-50 text-green-700">Pagado</span>
                      )}
                    </td>

                    <td className="px-4 py-3 text-right">
                      <Link href={`/panel/comercio/mis-ordenes/${o.id}`}
                        className="text-[#004aad] text-xs font-semibold hover:underline">
                        Ver →
                      </Link>
                    </td>
                  </tr>
                )
              })}
            </tbody>
          </table>
        )}
      </div>
    </div>
  )
}
