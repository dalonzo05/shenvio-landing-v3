'use client'

import React, { useEffect, useRef, useState } from 'react'
import {
  collection,
  onSnapshot,
  orderBy,
  query,
  updateDoc,
  doc,
  where,
  Timestamp,
} from 'firebase/firestore'
import { db } from '@/fb/config'

// ─── Types ────────────────────────────────────────────────────────────────────

type Registro = {
  semana?: number
  zona?: string
  pago?: {
    realizo?: boolean
    esCash?: boolean
  }
  deposito?: {
    fecha?: Timestamp | null
    monto?: number | null
    formaPago?: string | null
  }
  csRecaudado?: number
  usdRecaudado?: number
  numEntregas?: number
}

type Solicitud = {
  id: string
  createdAt?: Timestamp
  estado?: string
  tipoCliente?: 'contado' | 'credito'
  recoleccion?: {
    nombreApellido?: string
    celular?: string
    direccionEscrita?: string
  }
  entrega?: {
    nombreApellido?: string
    celular?: string
    direccionEscrita?: string
  }
  cobroContraEntrega?: {
    aplica?: boolean
    monto?: number
  }
  pagoDelivery?: {
    tipo?: string
    quienPaga?: string
    montoSugerido?: number | null
  }
  cotizacion?: {
    distanciaKm?: number | null
    precioSugerido?: number | null
  }
  confirmacion?: {
    precioFinalCordobas?: number
  }
  asignacion?: {
    motorizadoNombre?: string
    motorizadoId?: string
    motorizadoAuthUid?: string
  } | null
  ownerSnapshot?: {
    companyName?: string
    phone?: string
    nombre?: string
  }
  registro?: Registro
}

type Motorizado = {
  id: string
  nombre: string
  authUid?: string
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function getWeekNumber(date: Date): number {
  const d = new Date(Date.UTC(date.getFullYear(), date.getMonth(), date.getDate()))
  d.setUTCDate(d.getUTCDate() + 4 - (d.getUTCDay() || 7))
  const yearStart = new Date(Date.UTC(d.getUTCFullYear(), 0, 1))
  return Math.ceil(((d.getTime() - yearStart.getTime()) / 86400000 + 1) / 7)
}

function formatDate(ts?: Timestamp | null): string {
  if (!ts) return '—'
  const d = ts.toDate()
  return d.toLocaleDateString('es-NI', { day: '2-digit', month: '2-digit', year: 'numeric' })
}

function getPrecio(s: Solicitud): number | null {
  return s.confirmacion?.precioFinalCordobas ?? s.pagoDelivery?.montoSugerido ?? s.cotizacion?.precioSugerido ?? null
}

// ─── Inline editable cell ─────────────────────────────────────────────────────

function EditableCell({
  value,
  onSave,
  type = 'text',
  placeholder = '—',
  prefix = '',
}: {
  value: string | number | null | undefined
  onSave: (val: string) => void
  type?: 'text' | 'number' | 'date'
  placeholder?: string
  prefix?: string
}) {
  const [editing, setEditing] = useState(false)
  const [draft, setDraft] = useState('')
  const inputRef = useRef<HTMLInputElement>(null)

  const startEdit = () => {
    const current = value != null ? String(value) : ''
    setDraft(current)
    setEditing(true)
    setTimeout(() => inputRef.current?.focus(), 0)
  }

  const commit = () => {
    setEditing(false)
    if (draft !== String(value ?? '')) onSave(draft)
  }

  if (editing) {
    return (
      <input
        ref={inputRef}
        type={type}
        value={draft}
        onChange={(e) => setDraft(e.target.value)}
        onBlur={commit}
        onKeyDown={(e) => { if (e.key === 'Enter') commit(); if (e.key === 'Escape') setEditing(false) }}
        className="w-full min-w-[80px] rounded border border-blue-400 px-1 py-0.5 text-xs focus:outline-none"
      />
    )
  }

  return (
    <span
      onClick={startEdit}
      className="cursor-pointer rounded px-1 py-0.5 text-xs hover:bg-blue-50 hover:text-blue-700"
      title="Click para editar"
    >
      {value != null && value !== '' ? `${prefix}${value}` : <span className="text-gray-300">{placeholder}</span>}
    </span>
  )
}

function BoolCell({
  value,
  onToggle,
  labelTrue = 'Sí',
  labelFalse = 'No',
}: {
  value: boolean | null | undefined
  onToggle: (val: boolean) => void
  labelTrue?: string
  labelFalse?: string
}) {
  return (
    <button
      onClick={() => onToggle(!value)}
      className={`rounded px-2 py-0.5 text-xs font-medium ${
        value
          ? 'bg-green-100 text-green-700'
          : 'bg-gray-100 text-gray-500'
      }`}
    >
      {value ? labelTrue : labelFalse}
    </button>
  )
}

// ─── Main page ────────────────────────────────────────────────────────────────

export default function BaseDatosPage() {
  const [solicitudes, setSolicitudes] = useState<Solicitud[]>([])
  const [motorizados, setMotorizados] = useState<Motorizado[]>([])
  const [tabMotorizado, setTabMotorizado] = useState<string>('todos')
  const [search, setSearch] = useState('')
  const [loading, setLoading] = useState(true)

  // Rango de fechas: por defecto últimos 30 días
  const [desde, setDesde] = useState<string>(() => {
    const d = new Date()
    d.setDate(d.getDate() - 30)
    return d.toISOString().split('T')[0]
  })
  const [hasta, setHasta] = useState<string>(() => new Date().toISOString().split('T')[0])

  // Cargar motorizados
  useEffect(() => {
    const unsub = onSnapshot(collection(db, 'motorizado'), (snap) => {
      setMotorizados(
        snap.docs.map((d) => ({
          id: d.id,
          nombre: (d.data() as any).nombre || d.id,
          authUid: (d.data() as any).authUid,
        }))
      )
    })
    return () => unsub()
  }, [])

  // Cargar solicitudes por rango de fecha
  useEffect(() => {
    const desdeTs = Timestamp.fromDate(new Date(desde + 'T00:00:00'))
    const hastaTs = Timestamp.fromDate(new Date(hasta + 'T23:59:59'))

    const q = query(
      collection(db, 'solicitudes_envio'),
      where('createdAt', '>=', desdeTs),
      where('createdAt', '<=', hastaTs),
      orderBy('createdAt', 'desc')
    )

    const unsub = onSnapshot(q, (snap) => {
      setSolicitudes(snap.docs.map((d) => ({ id: d.id, ...(d.data() as Omit<Solicitud, 'id'>) })))
      setLoading(false)
    })

    return () => unsub()
  }, [desde, hasta])

  // Actualizar campo registro en Firestore
  const updateRegistro = async (id: string, patch: Partial<Registro>) => {
    const ref = doc(db, 'solicitudes_envio', id)
    const updates: Record<string, unknown> = {}
    for (const [k, v] of Object.entries(patch)) {
      updates[`registro.${k}`] = v
    }
    await updateDoc(ref, updates)
  }

  const updateRegistroNested = async (id: string, path: string, value: unknown) => {
    const ref = doc(db, 'solicitudes_envio', id)
    await updateDoc(ref, { [`registro.${path}`]: value })
  }

  // Filtros
  const filtered = solicitudes.filter((s) => {
    if (tabMotorizado !== 'todos') {
      const asignadoId = s.asignacion?.motorizadoId || s.asignacion?.motorizadoAuthUid
      if (asignadoId !== tabMotorizado && s.asignacion?.motorizadoNombre !== tabMotorizado) return false
    }
    if (search.trim()) {
      const q = search.toLowerCase()
      const cliente = (s.ownerSnapshot?.companyName || s.ownerSnapshot?.nombre || '').toLowerCase()
      const entrega = (s.entrega?.nombreApellido || '').toLowerCase()
      const zona = (s.registro?.zona || '').toLowerCase()
      if (!cliente.includes(q) && !entrega.includes(q) && !zona.includes(q)) return false
    }
    return true
  })

  // Totales
  const totales = filtered.reduce(
    (acc, s) => {
      acc.precio += getPrecio(s) || 0
      acc.totalDelivery += s.cobroContraEntrega?.monto || 0
      acc.depositado += s.registro?.deposito?.monto || 0
      acc.cs += s.registro?.csRecaudado || 0
      acc.usd += s.registro?.usdRecaudado || 0
      acc.entregas += s.registro?.numEntregas || 1
      return acc
    },
    { precio: 0, totalDelivery: 0, depositado: 0, cs: 0, usd: 0, entregas: 0 }
  )

  return (
    <div className="flex flex-col gap-4">
      {/* Header */}
      <div>
        <h1 className="text-xl font-bold text-gray-900">Base de datos</h1>
        <p className="text-sm text-gray-500">Registro operativo de viajes y pagos</p>
      </div>

      {/* Filtros */}
      <div className="flex flex-wrap items-center gap-3">
        <div className="flex items-center gap-2 rounded-lg border bg-white px-3 py-2">
          <span className="text-xs text-gray-500">Desde</span>
          <input
            type="date"
            value={desde}
            onChange={(e) => setDesde(e.target.value)}
            className="text-xs focus:outline-none"
          />
        </div>
        <div className="flex items-center gap-2 rounded-lg border bg-white px-3 py-2">
          <span className="text-xs text-gray-500">Hasta</span>
          <input
            type="date"
            value={hasta}
            onChange={(e) => setHasta(e.target.value)}
            className="text-xs focus:outline-none"
          />
        </div>
        <input
          type="text"
          placeholder="Buscar comercio, cliente, zona..."
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          className="rounded-lg border bg-white px-3 py-2 text-xs focus:outline-none focus:ring-2 focus:ring-blue-200"
        />
        <span className="text-xs text-gray-400">{filtered.length} registros</span>
      </div>

      {/* Tabs motorizados */}
      <div className="flex gap-1 overflow-x-auto">
        <TabBtn active={tabMotorizado === 'todos'} onClick={() => setTabMotorizado('todos')}>
          Todos
        </TabBtn>
        {motorizados.map((m) => (
          <TabBtn
            key={m.id}
            active={tabMotorizado === m.id || tabMotorizado === m.authUid}
            onClick={() => setTabMotorizado(m.id)}
          >
            {m.nombre}
          </TabBtn>
        ))}
      </div>

      {/* Tabla */}
      <div className="overflow-x-auto rounded-xl border bg-white shadow-sm">
        {loading ? (
          <div className="px-6 py-10 text-center text-sm text-gray-400">Cargando registros...</div>
        ) : filtered.length === 0 ? (
          <div className="px-6 py-10 text-center text-sm text-gray-400">No hay registros en este rango</div>
        ) : (
          <table className="min-w-max w-full text-xs">
            <thead>
              <tr className="border-b bg-gray-50 text-left text-[11px] font-semibold uppercase tracking-wide text-gray-500">
                <Th>#</Th>
                <Th>Semana</Th>
                <Th>Motorizado</Th>
                <Th>Fecha</Th>
                <Th>Pagó</Th>
                <Th>Cash</Th>
                <Th>Cliente</Th>
                <Th>Teléfono</Th>
                <Th>Info Acot.</Th>
                <Th>Zona</Th>
                <Th>Precio D.</Th>
                <Th>Total Delivery</Th>
                <Th>F. Depósito</Th>
                <Th>Depositado</Th>
                <Th>Forma Pago</Th>
                <Th>C$</Th>
                <Th>$</Th>
                <Th>Entregas</Th>
                <Th>Dist.</Th>
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-100">
              {filtered.map((s) => {
                const semana = s.registro?.semana ?? (s.createdAt ? getWeekNumber(s.createdAt.toDate()) : null)
                const precio = getPrecio(s)
                const info = [s.recoleccion?.direccionEscrita, s.entrega?.direccionEscrita]
                  .filter(Boolean)
                  .join(' → ')

                return (
                  <tr key={s.id} className="hover:bg-gray-50 transition-colors">
                    {/* # orden */}
                    <Td>
                      <span className="font-mono text-gray-400">{s.id.slice(0, 6)}</span>
                    </Td>

                    {/* Semana */}
                    <Td>
                      <EditableCell
                        value={semana}
                        type="number"
                        placeholder="sem"
                        onSave={(v) => updateRegistro(s.id, { semana: v ? Number(v) : undefined })}
                      />
                    </Td>

                    {/* Motorizado */}
                    <Td>
                      <span className="text-gray-700">{s.asignacion?.motorizadoNombre || <span className="text-gray-300">—</span>}</span>
                    </Td>

                    {/* Fecha */}
                    <Td>{formatDate(s.createdAt)}</Td>

                    {/* Pagó */}
                    <Td>
                      <BoolCell
                        value={s.registro?.pago?.realizo}
                        onToggle={(v) => updateRegistroNested(s.id, 'pago.realizo', v)}
                        labelTrue="Sí"
                        labelFalse="No"
                      />
                    </Td>

                    {/* Cash */}
                    <Td>
                      <BoolCell
                        value={s.registro?.pago?.esCash}
                        onToggle={(v) => updateRegistroNested(s.id, 'pago.esCash', v)}
                        labelTrue="Cash"
                        labelFalse=">>>"
                      />
                    </Td>

                    {/* Cliente (comercio) */}
                    <Td>
                      <span className="font-medium text-gray-800">
                        {s.ownerSnapshot?.companyName || s.ownerSnapshot?.nombre || '—'}
                      </span>
                    </Td>

                    {/* Teléfono */}
                    <Td>
                      <span className="text-gray-600">{s.ownerSnapshot?.phone || '—'}</span>
                    </Td>

                    {/* Info Acot. */}
                    <Td>
                      <span className="max-w-[200px] truncate block text-gray-600" title={info}>{info || '—'}</span>
                    </Td>

                    {/* Zona */}
                    <Td>
                      <EditableCell
                        value={s.registro?.zona}
                        placeholder="zona"
                        onSave={(v) => updateRegistro(s.id, { zona: v || undefined })}
                      />
                    </Td>

                    {/* Precio delivery */}
                    <Td>
                      {precio != null
                        ? <span className="font-medium text-[#004aad]">C${precio}</span>
                        : <span className="text-gray-300">—</span>
                      }
                    </Td>

                    {/* Total delivery (cobro contra entrega) */}
                    <Td>
                      {s.cobroContraEntrega?.aplica && s.cobroContraEntrega.monto
                        ? <span className="font-medium text-green-700">C${s.cobroContraEntrega.monto}</span>
                        : <span className="text-gray-300">C$0</span>
                      }
                    </Td>

                    {/* Fecha depósito */}
                    <Td>
                      <EditableCell
                        value={
                          s.registro?.deposito?.fecha
                            ? s.registro.deposito.fecha.toDate().toISOString().split('T')[0]
                            : ''
                        }
                        type="date"
                        placeholder="fecha"
                        onSave={(v) =>
                          updateRegistroNested(
                            s.id,
                            'deposito.fecha',
                            v ? Timestamp.fromDate(new Date(v)) : null
                          )
                        }
                      />
                    </Td>

                    {/* Depositado */}
                    <Td>
                      <EditableCell
                        value={s.registro?.deposito?.monto ?? ''}
                        type="number"
                        prefix="C$"
                        placeholder="monto"
                        onSave={(v) => updateRegistroNested(s.id, 'deposito.monto', v ? Number(v) : null)}
                      />
                    </Td>

                    {/* Forma de pago */}
                    <Td>
                      <select
                        value={s.registro?.deposito?.formaPago || ''}
                        onChange={(e) =>
                          updateRegistroNested(s.id, 'deposito.formaPago', e.target.value || null)
                        }
                        className="rounded border border-gray-200 bg-transparent px-1 py-0.5 text-xs focus:outline-none"
                      >
                        <option value="">—</option>
                        <option value="transferencia">Transferencia</option>
                        <option value="efectivo">Efectivo</option>
                        <option value="otro">Otro</option>
                      </select>
                    </Td>

                    {/* C$ recaudado */}
                    <Td>
                      <EditableCell
                        value={s.registro?.csRecaudado ?? ''}
                        type="number"
                        prefix="C$"
                        placeholder="—"
                        onSave={(v) => updateRegistro(s.id, { csRecaudado: v ? Number(v) : undefined })}
                      />
                    </Td>

                    {/* $ recaudado */}
                    <Td>
                      <EditableCell
                        value={s.registro?.usdRecaudado ?? ''}
                        type="number"
                        prefix="$"
                        placeholder="—"
                        onSave={(v) => updateRegistro(s.id, { usdRecaudado: v ? Number(v) : undefined })}
                      />
                    </Td>

                    {/* # entregas */}
                    <Td>
                      <EditableCell
                        value={s.registro?.numEntregas ?? 1}
                        type="number"
                        onSave={(v) => updateRegistro(s.id, { numEntregas: v ? Number(v) : 1 })}
                      />
                    </Td>

                    {/* Distancia */}
                    <Td>
                      {s.cotizacion?.distanciaKm != null
                        ? `${s.cotizacion.distanciaKm} km`
                        : <span className="text-gray-300">—</span>
                      }
                    </Td>
                  </tr>
                )
              })}
            </tbody>

            {/* Fila de totales */}
            <tfoot>
              <tr className="border-t-2 border-gray-200 bg-gray-50 font-semibold text-gray-700">
                <Td colSpan={10}>
                  <span className="text-[11px] uppercase tracking-wide text-gray-500">Totales</span>
                </Td>
                <Td><span className="text-[#004aad]">C${totales.precio.toFixed(0)}</span></Td>
                <Td><span className="text-green-700">C${totales.totalDelivery.toFixed(0)}</span></Td>
                <Td />
                <Td><span>C${totales.depositado.toFixed(0)}</span></Td>
                <Td />
                <Td><span>C${totales.cs.toFixed(0)}</span></Td>
                <Td><span>${totales.usd.toFixed(2)}</span></Td>
                <Td><span>{totales.entregas}</span></Td>
                <Td />
              </tr>
            </tfoot>
          </table>
        )}
      </div>
    </div>
  )
}

// ─── Small components ─────────────────────────────────────────────────────────

function Th({ children }: { children: React.ReactNode }) {
  return <th className="whitespace-nowrap px-3 py-2">{children}</th>
}

function Td({ children, colSpan }: { children: React.ReactNode; colSpan?: number }) {
  return (
    <td className="whitespace-nowrap px-3 py-2" colSpan={colSpan}>
      {children}
    </td>
  )
}

function TabBtn({
  children,
  active,
  onClick,
}: {
  children: React.ReactNode
  active: boolean
  onClick: () => void
}) {
  return (
    <button
      onClick={onClick}
      className={`shrink-0 rounded-lg px-3 py-1.5 text-xs font-medium transition ${
        active ? 'bg-[#004aad] text-white' : 'bg-white border border-gray-200 text-gray-600 hover:bg-gray-50'
      }`}
    >
      {children}
    </button>
  )
}
