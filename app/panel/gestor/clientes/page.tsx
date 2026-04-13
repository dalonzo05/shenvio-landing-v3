'use client'

import { useEffect, useMemo, useRef, useState } from 'react'
import {
  collection,
  doc,
  getDocs,
  onSnapshot,
  query,
  orderBy,
  limit,
  setDoc,
  serverTimestamp,
  where,
} from 'firebase/firestore'
import { db } from '@/fb/config'
import { Search, X, Users, Phone, MapPin, Package, ChevronRight, Edit3 } from 'lucide-react'

// ─── Types ────────────────────────────────────────────────────────────────────

type LatLng = { lat: number; lng: number }

type ClienteEnvio = {
  id: string
  nombre: string
  celular: string
  direccion?: string
  nota?: string
  coord?: LatLng
  tipoUbicacion?: string
  comercioUid?: string | null
  totalViajes?: number
  updatedAt?: any
}

type ComercioRef = {
  uid: string
  name?: string
  companyName?: string
}

type SolicitudResumen = {
  id: string
  createdAt?: any
  estado?: string
  entrega?: {
    nombreApellido?: string
    celular?: string
    direccionEscrita?: string
  }
  cotizacion?: { precioSugerido?: number }
  confirmacion?: { precioFinalCordobas?: number }
  pagoDelivery?: { montoSugerido?: number }
  ownerSnapshot?: { companyName?: string; nombre?: string }
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function formatDate(ts: any): string {
  if (!ts) return '—'
  try {
    const d = ts.toDate ? ts.toDate() : new Date(ts)
    return d.toLocaleDateString('es-NI', { day: '2-digit', month: 'short', year: 'numeric' })
  } catch { return '—' }
}

function estadoBadge(estado?: string) {
  const map: Record<string, { bg: string; color: string; label: string }> = {
    pendiente_confirmacion: { bg: '#fffbe6', color: '#d46b08', label: 'Pendiente' },
    confirmada: { bg: '#eff6ff', color: '#004aad', label: 'Confirmada' },
    en_camino: { bg: '#f0fdf4', color: '#16a34a', label: 'En camino' },
    entregada: { bg: '#f0fdf4', color: '#16a34a', label: 'Entregada' },
    cancelada: { bg: '#fef2f2', color: '#dc2626', label: 'Cancelada' },
    programada: { bg: '#f5f3ff', color: '#7c3aed', label: 'Programada' },
  }
  const s = map[estado || ''] || { bg: '#f9fafb', color: '#6b7280', label: estado || '—' }
  return (
    <span style={{
      fontSize: 10, fontWeight: 700, padding: '2px 7px', borderRadius: 6,
      background: s.bg, color: s.color,
    }}>
      {s.label}
    </span>
  )
}

// ─── Main Page ────────────────────────────────────────────────────────────────

export default function GestorClientesPage() {
  const [clientes, setClientes] = useState<ClienteEnvio[]>([])
  const [comercios, setComercios] = useState<ComercioRef[]>([])
  const [loading, setLoading] = useState(true)
  const [query2, setQuery2] = useState('')

  // Drawer state
  const [selected, setSelected] = useState<ClienteEnvio | null>(null)
  const [editNombre, setEditNombre] = useState('')
  const [editCelular, setEditCelular] = useState('')
  const [editDireccion, setEditDireccion] = useState('')
  const [editNota, setEditNota] = useState('')
  const [saving, setSaving] = useState(false)
  const [saveMsg, setSaveMsg] = useState<string | null>(null)

  // Viajes history
  const [viajes, setViajes] = useState<SolicitudResumen[]>([])
  const [loadingViajes, setLoadingViajes] = useState(false)

  // Load all clientes_envio
  useEffect(() => {
    const unsub = onSnapshot(collection(db, 'clientes_envio'), (snap) => {
      const all = snap.docs.map((d) => ({ id: d.id, ...(d.data() as any) })) as ClienteEnvio[]
      all.sort((a, b) => (a.nombre || '').localeCompare(b.nombre || ''))
      setClientes(all)
      setLoading(false)
    })
    return () => unsub()
  }, [])

  // Load comercios for name resolution
  useEffect(() => {
    getDocs(collection(db, 'comercios')).then((snap) => {
      const list = snap.docs.map((d) => ({ uid: d.id, ...(d.data() as any) })) as ComercioRef[]
      setComercios(list)
    }).catch(() => {})
  }, [])

  const getComercioName = (uid?: string | null) => {
    if (!uid) return null
    const c = comercios.find((c) => c.uid === uid)
    return c?.companyName || c?.name || uid.slice(0, 8)
  }

  // Filtered + deduplicated (group by celular, show best doc per celular)
  const filtered = useMemo(() => {
    const q = query2.trim().toLowerCase()
    const matching = q
      ? clientes.filter((c) =>
          (c.nombre || '').toLowerCase().includes(q) ||
          (c.celular || '').includes(q) ||
          (c.direccion || '').toLowerCase().includes(q)
        )
      : clientes

    // Group by celular — if same celular has multiple docs (per comercio), show the one with highest viajes
    const byPhone = new Map<string, ClienteEnvio>()
    for (const c of matching) {
      const key = c.celular.replace(/\D/g, '')
      if (!key) continue
      const existing = byPhone.get(key)
      if (!existing || (c.totalViajes ?? 0) > (existing.totalViajes ?? 0)) {
        byPhone.set(key, c)
      }
    }

    return Array.from(byPhone.values())
  }, [clientes, query2])

  // All docs for same celular (for drawer)
  const allDocsForSelected = useMemo(() => {
    if (!selected) return []
    const cel = selected.celular.replace(/\D/g, '')
    return clientes.filter((c) => c.celular.replace(/\D/g, '') === cel)
  }, [selected, clientes])

  // Load viajes when selected changes
  useEffect(() => {
    if (!selected) { setViajes([]); return }
    setLoadingViajes(true)
    const cel = selected.celular.trim()
    getDocs(
      query(
        collection(db, 'solicitudes_envio'),
        where('entrega.celular', '==', cel),
        orderBy('createdAt', 'desc'),
        limit(10)
      )
    ).then((snap) => {
      setViajes(snap.docs.map((d) => ({ id: d.id, ...(d.data() as any) })) as SolicitudResumen[])
    }).catch(() => setViajes([])).finally(() => setLoadingViajes(false))
  }, [selected?.celular])

  const openDrawer = (c: ClienteEnvio) => {
    setSelected(c)
    setEditNombre(c.nombre || '')
    setEditCelular(c.celular || '')
    setEditDireccion(c.direccion || '')
    setEditNota(c.nota || '')
    setSaveMsg(null)
  }

  const closeDrawer = () => {
    setSelected(null)
    setViajes([])
  }

  const handleSave = async () => {
    if (!selected) return
    setSaving(true)
    setSaveMsg(null)
    try {
      await setDoc(doc(db, 'clientes_envio', selected.id), {
        nombre: editNombre.trim(),
        celular: editCelular.trim(),
        direccion: editDireccion.trim() || null,
        nota: editNota.trim() || null,
        updatedAt: serverTimestamp(),
      }, { merge: true })
      setSaveMsg('✓ Guardado')
      setSelected((prev) => prev ? { ...prev, nombre: editNombre.trim(), celular: editCelular.trim(), direccion: editDireccion.trim(), nota: editNota.trim() } : prev)
    } catch {
      setSaveMsg('Error al guardar')
    } finally {
      setSaving(false)
    }
  }

  return (
    <div style={{ maxWidth: 1100, margin: '0 auto', padding: '0 0 48px', fontFamily: "'SF Pro Display', -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif" }}>
      {/* Header */}
      <div style={{ marginBottom: 24, display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', flexWrap: 'wrap', gap: 12 }}>
        <div>
          <h1 style={{ fontSize: 28, fontWeight: 800, color: '#111827', margin: '0 0 4px', letterSpacing: -0.5 }}>
            Clientes
          </h1>
          <p style={{ fontSize: 14, color: '#6b7280', margin: 0 }}>
            Base de destinatarios de todas las órdenes · {loading ? '...' : `${filtered.length} cliente${filtered.length !== 1 ? 's' : ''}`}
          </p>
        </div>
      </div>

      {/* Search */}
      <div style={{ display: 'flex', gap: 10, marginBottom: 20 }}>
        <div style={{ flex: 1, position: 'relative' }}>
          <Search size={16} style={{ position: 'absolute', left: 12, top: '50%', transform: 'translateY(-50%)', color: '#9ca3af', pointerEvents: 'none' }} />
          <input
            value={query2}
            onChange={(e) => setQuery2(e.target.value)}
            placeholder={`Buscar entre ${clientes.length} clientes…`}
            style={{ width: '100%', paddingLeft: 38, padding: '10px 12px 10px 38px', border: '1px solid #e5e7eb', borderRadius: 10, fontSize: 14, color: '#111827', outline: 'none', background: '#fff', boxSizing: 'border-box', fontFamily: 'inherit' }}
          />
        </div>
      </div>

      {/* Table */}
      <div style={{ background: '#fff', border: '1px solid #e5e7eb', borderRadius: 16, overflow: 'hidden', boxShadow: '0 1px 3px rgba(0,0,0,0.05)' }}>
        {loading ? (
          <div style={{ padding: 40, textAlign: 'center', color: '#9ca3af', fontSize: 14 }}>
            Cargando clientes...
          </div>
        ) : filtered.length === 0 ? (
          <div style={{ padding: '40px 20px', textAlign: 'center', color: '#9ca3af' }}>
            <Users size={40} style={{ opacity: 0.3, marginBottom: 12, display: 'block', margin: '0 auto 12px' }} />
            <p style={{ fontSize: 14, fontWeight: 600, margin: 0 }}>
              {query2 ? `Sin resultados para "${query2}"` : 'No hay clientes guardados'}
            </p>
          </div>
        ) : (
          <>
            {/* Table header */}
            <div style={{ display: 'grid', gridTemplateColumns: '2fr 1.2fr 2fr 1.4fr 60px 30px', gap: 0, padding: '10px 16px', background: '#f9fafb', borderBottom: '1px solid #e5e7eb' }}>
              {['Nombre', 'Teléfono', 'Dirección', 'Comercio(s)', 'Viajes', ''].map((h, i) => (
                <div key={i} style={{ fontSize: 11, fontWeight: 700, color: '#6b7280', textTransform: 'uppercase', letterSpacing: '0.05em' }}>{h}</div>
              ))}
            </div>

            {/* Table rows */}
            {filtered.map((c) => {
              const allDocs = clientes.filter((x) => x.celular.replace(/\D/g, '') === c.celular.replace(/\D/g, ''))
              const comercioUids = [...new Set(allDocs.map((x) => x.comercioUid).filter(Boolean))] as string[]
              return (
                <button
                  key={c.id}
                  type="button"
                  onClick={() => openDrawer(c)}
                  style={{
                    display: 'grid', gridTemplateColumns: '2fr 1.2fr 2fr 1.4fr 60px 30px',
                    gap: 0, padding: '12px 16px', width: '100%', textAlign: 'left',
                    border: 'none', borderBottom: '1px solid #f3f4f6', background: '#fff',
                    cursor: 'pointer', alignItems: 'center',
                  }}
                  onMouseEnter={(e) => { e.currentTarget.style.background = '#f9fafb' }}
                  onMouseLeave={(e) => { e.currentTarget.style.background = '#fff' }}
                >
                  {/* Nombre */}
                  <div style={{ display: 'flex', alignItems: 'center', gap: 10, minWidth: 0 }}>
                    <div style={{ width: 32, height: 32, borderRadius: '50%', flexShrink: 0, background: '#eff6ff', display: 'flex', alignItems: 'center', justifyContent: 'center', fontWeight: 800, fontSize: 13, color: '#004aad' }}>
                      {(c.nombre || '?')[0].toUpperCase()}
                    </div>
                    <span style={{ fontWeight: 700, color: '#111827', fontSize: 13, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                      {c.nombre || '—'}
                    </span>
                  </div>

                  {/* Teléfono */}
                  <span style={{ fontSize: 13, color: '#6b7280' }}>{c.celular || '—'}</span>

                  {/* Dirección */}
                  <span style={{ fontSize: 12, color: '#9ca3af', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                    {c.direccion || '—'}
                  </span>

                  {/* Comercio(s) */}
                  <div style={{ display: 'flex', flexWrap: 'wrap', gap: 4 }}>
                    {comercioUids.length === 0 && (
                      <span style={{ fontSize: 10, fontWeight: 700, padding: '2px 6px', borderRadius: 4, background: '#f0fdf4', color: '#16a34a' }}>🌐 global</span>
                    )}
                    {comercioUids.map((uid) => (
                      <span key={uid} style={{ fontSize: 10, fontWeight: 600, padding: '2px 6px', borderRadius: 4, background: '#eff6ff', color: '#004aad', maxWidth: 120, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                        {getComercioName(uid)}
                      </span>
                    ))}
                  </div>

                  {/* Viajes */}
                  <div style={{ textAlign: 'center' }}>
                    {(c.totalViajes ?? 0) > 0 ? (
                      <span style={{ fontSize: 16, fontWeight: 900, color: '#004aad' }}>{c.totalViajes}</span>
                    ) : (
                      <span style={{ fontSize: 12, color: '#d1d5db' }}>—</span>
                    )}
                  </div>

                  {/* Arrow */}
                  <ChevronRight size={16} color="#d1d5db" />
                </button>
              )
            })}
          </>
        )}
      </div>

      {/* ── DRAWER ── */}
      {selected && (
        <>
          {/* Backdrop */}
          <div
            style={{ position: 'fixed', inset: 0, background: 'rgba(15,23,42,0.3)', zIndex: 100 }}
            onClick={closeDrawer}
          />

          {/* Panel */}
          <div style={{
            position: 'fixed', top: 0, right: 0, bottom: 0, width: '100%', maxWidth: 480,
            background: '#fff', boxShadow: '-8px 0 40px rgba(0,0,0,0.12)', zIndex: 101,
            display: 'flex', flexDirection: 'column', overflow: 'hidden',
          }}>
            {/* Drawer header */}
            <div style={{ padding: '18px 20px', borderBottom: '1px solid #f3f4f6', display: 'flex', alignItems: 'center', justifyContent: 'space-between', flexShrink: 0 }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
                <div style={{ width: 42, height: 42, borderRadius: '50%', background: '#eff6ff', display: 'flex', alignItems: 'center', justifyContent: 'center', fontWeight: 800, fontSize: 18, color: '#004aad' }}>
                  {(selected.nombre || '?')[0].toUpperCase()}
                </div>
                <div>
                  <h3 style={{ fontSize: 16, fontWeight: 800, color: '#111827', margin: '0 0 2px' }}>{selected.nombre || '—'}</h3>
                  <p style={{ fontSize: 12, color: '#6b7280', margin: 0 }}>{selected.celular}</p>
                </div>
              </div>
              <button
                onClick={closeDrawer}
                style={{ width: 32, height: 32, borderRadius: 8, border: '1px solid #e5e7eb', background: '#f9fafb', cursor: 'pointer', display: 'flex', alignItems: 'center', justifyContent: 'center' }}
              >
                <X size={14} color="#6b7280" />
              </button>
            </div>

            {/* Drawer body */}
            <div style={{ flex: 1, overflowY: 'auto', padding: 20 }}>

              {/* Stat cards */}
              <div style={{ display: 'flex', gap: 10, marginBottom: 20 }}>
                <div style={{ flex: 1, background: '#eff6ff', borderRadius: 12, padding: '12px 14px', textAlign: 'center' }}>
                  <div style={{ fontSize: 22, fontWeight: 900, color: '#004aad' }}>{selected.totalViajes ?? 0}</div>
                  <div style={{ fontSize: 10, color: '#6b7280', fontWeight: 600, textTransform: 'uppercase', letterSpacing: '0.05em', marginTop: 2 }}>Viajes</div>
                </div>
                <div style={{ flex: 1, background: '#f0fdf4', borderRadius: 12, padding: '12px 14px', textAlign: 'center' }}>
                  <div style={{ fontSize: 22, fontWeight: 900, color: '#16a34a' }}>{allDocsForSelected.length}</div>
                  <div style={{ fontSize: 10, color: '#6b7280', fontWeight: 600, textTransform: 'uppercase', letterSpacing: '0.05em', marginTop: 2 }}>Comercios</div>
                </div>
                {selected.coord && (
                  <div style={{ flex: 1, background: '#fdf4ff', borderRadius: 12, padding: '12px 14px', textAlign: 'center' }}>
                    <div style={{ fontSize: 20, fontWeight: 900, color: '#7c3aed' }}>🎯</div>
                    <div style={{ fontSize: 10, color: '#6b7280', fontWeight: 600, textTransform: 'uppercase', letterSpacing: '0.05em', marginTop: 2 }}>Con coord</div>
                  </div>
                )}
              </div>

              {/* Comercios asociados */}
              {allDocsForSelected.length > 0 && (
                <div style={{ marginBottom: 20 }}>
                  <p style={{ fontSize: 11, fontWeight: 700, color: '#9ca3af', textTransform: 'uppercase', letterSpacing: '0.06em', marginBottom: 8 }}>Comercios asociados</p>
                  <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
                    {allDocsForSelected.map((doc2) => (
                      <span key={doc2.id} style={{ fontSize: 11, fontWeight: 600, padding: '3px 8px', borderRadius: 6, background: doc2.comercioUid ? '#eff6ff' : '#f0fdf4', color: doc2.comercioUid ? '#004aad' : '#16a34a' }}>
                        {doc2.comercioUid ? (getComercioName(doc2.comercioUid) || doc2.comercioUid.slice(0, 8)) : '🌐 global'}
                        {doc2.totalViajes ? ` · ${doc2.totalViajes}v` : ''}
                      </span>
                    ))}
                  </div>
                </div>
              )}

              {/* Edit form */}
              <div style={{ marginBottom: 24 }}>
                <p style={{ fontSize: 11, fontWeight: 700, color: '#9ca3af', textTransform: 'uppercase', letterSpacing: '0.06em', marginBottom: 12 }}>
                  <Edit3 size={11} style={{ display: 'inline', marginRight: 4 }} />
                  Editar perfil
                </p>
                <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
                  <div>
                    <label style={{ display: 'block', fontSize: 12, fontWeight: 600, color: '#374151', marginBottom: 5 }}>Nombre</label>
                    <input value={editNombre} onChange={(e) => setEditNombre(e.target.value)} style={{ width: '100%', border: '1px solid #e5e7eb', borderRadius: 8, padding: '9px 12px', fontSize: 13, color: '#111827', outline: 'none', boxSizing: 'border-box' as const, fontFamily: 'inherit' }} />
                  </div>
                  <div>
                    <label style={{ display: 'block', fontSize: 12, fontWeight: 600, color: '#374151', marginBottom: 5 }}>Teléfono</label>
                    <input value={editCelular} onChange={(e) => setEditCelular(e.target.value)} style={{ width: '100%', border: '1px solid #e5e7eb', borderRadius: 8, padding: '9px 12px', fontSize: 13, color: '#111827', outline: 'none', boxSizing: 'border-box' as const, fontFamily: 'inherit' }} />
                  </div>
                  <div>
                    <label style={{ display: 'block', fontSize: 12, fontWeight: 600, color: '#374151', marginBottom: 5 }}>Dirección</label>
                    <input value={editDireccion} onChange={(e) => setEditDireccion(e.target.value)} placeholder="Dirección de entrega habitual" style={{ width: '100%', border: '1px solid #e5e7eb', borderRadius: 8, padding: '9px 12px', fontSize: 13, color: '#111827', outline: 'none', boxSizing: 'border-box' as const, fontFamily: 'inherit' }} />
                  </div>
                  <div>
                    <label style={{ display: 'block', fontSize: 12, fontWeight: 600, color: '#374151', marginBottom: 5 }}>Nota interna</label>
                    <input value={editNota} onChange={(e) => setEditNota(e.target.value)} placeholder="Instrucciones especiales, zona, referencia..." style={{ width: '100%', border: '1px solid #e5e7eb', borderRadius: 8, padding: '9px 12px', fontSize: 13, color: '#111827', outline: 'none', boxSizing: 'border-box' as const, fontFamily: 'inherit' }} />
                  </div>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                    <button
                      type="button"
                      onClick={handleSave}
                      disabled={saving}
                      style={{ background: '#004aad', border: 'none', borderRadius: 8, padding: '9px 18px', color: '#fff', fontSize: 13, fontWeight: 700, cursor: saving ? 'not-allowed' : 'pointer', opacity: saving ? 0.7 : 1 }}
                    >
                      {saving ? 'Guardando...' : 'Guardar cambios'}
                    </button>
                    {saveMsg && (
                      <span style={{ fontSize: 12, color: saveMsg.startsWith('✓') ? '#16a34a' : '#dc2626', fontWeight: 600 }}>{saveMsg}</span>
                    )}
                  </div>
                </div>
              </div>

              {/* Historial de viajes */}
              <div>
                <p style={{ fontSize: 11, fontWeight: 700, color: '#9ca3af', textTransform: 'uppercase', letterSpacing: '0.06em', marginBottom: 10 }}>
                  <Package size={11} style={{ display: 'inline', marginRight: 4 }} />
                  Últimos 10 viajes
                </p>

                {loadingViajes ? (
                  <p style={{ fontSize: 13, color: '#9ca3af', textAlign: 'center', padding: '16px 0' }}>Cargando viajes...</p>
                ) : viajes.length === 0 ? (
                  <div style={{ background: '#f9fafb', border: '1px solid #f3f4f6', borderRadius: 10, padding: '16px', textAlign: 'center' }}>
                    <p style={{ fontSize: 13, color: '#9ca3af', margin: 0 }}>Sin viajes registrados</p>
                  </div>
                ) : (
                  <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
                    {viajes.map((v) => {
                      const precio = v.confirmacion?.precioFinalCordobas ?? v.cotizacion?.precioSugerido ?? v.pagoDelivery?.montoSugerido
                      const comercio = v.ownerSnapshot?.companyName || v.ownerSnapshot?.nombre || '—'
                      return (
                        <div key={v.id} style={{ background: '#f9fafb', border: '1px solid #f3f4f6', borderRadius: 10, padding: '10px 12px' }}>
                          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', gap: 8 }}>
                            <div style={{ flex: 1, minWidth: 0 }}>
                              <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 4, flexWrap: 'wrap' }}>
                                {estadoBadge(v.estado)}
                                <span style={{ fontSize: 11, color: '#9ca3af' }}>{formatDate(v.createdAt)}</span>
                              </div>
                              <p style={{ fontSize: 12, color: '#374151', margin: '0 0 2px', fontWeight: 600, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                                🏪 {comercio}
                              </p>
                              {v.entrega?.direccionEscrita && (
                                <p style={{ fontSize: 11, color: '#9ca3af', margin: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                                  📍 {v.entrega.direccionEscrita}
                                </p>
                              )}
                            </div>
                            {precio != null && (
                              <div style={{ flexShrink: 0, textAlign: 'right' }}>
                                <div style={{ fontSize: 15, fontWeight: 800, color: '#004aad' }}>C$ {precio}</div>
                              </div>
                            )}
                          </div>
                        </div>
                      )
                    })}
                  </div>
                )}
              </div>

            </div>
          </div>
        </>
      )}
    </div>
  )
}
