'use client'

import React, { useEffect, useState } from 'react'
import {
  collection,
  onSnapshot,
  query,
  where,
  doc,
  getDoc,
  setDoc,
  serverTimestamp,
  updateDoc,
} from 'firebase/firestore'
import { db } from '@/fb/config'
import { upsertCompanyByUid, type BankAccount, type CompanyPayload } from '@/fb/data'
import { Search, X, ChevronDown, ChevronUp, Building2, Phone, MapPin, CreditCard, Star } from 'lucide-react'

// ─── Types ────────────────────────────────────────────────────────────────────

type PuntoRetiro = {
  key: string
  label: string
  nombre?: string
  celular?: string
  direccion?: string
  nota?: string
}

type Comercio = {
  uid: string
  // from usuarios/{uid}
  email: string
  userName?: string
  activo?: boolean
  // from comercios/{uid}
  name?: string
  phone?: string
  address?: string
  accounts?: BankAccount[]
  puntosRetiro?: Record<string, any>
}

// ─── Styles ───────────────────────────────────────────────────────────────────

const S = {
  input: 'w-full border border-gray-200 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-[#004aad]/30 focus:border-[#004aad]',
  label: 'block text-xs font-semibold text-gray-500 mb-1 uppercase tracking-wide',
  btnPrimary: 'bg-[#004aad] text-white text-sm font-semibold px-4 py-2 rounded-lg hover:bg-[#003a8c] transition',
  btnOutline: 'border border-gray-200 text-gray-700 text-sm font-semibold px-3 py-2 rounded-lg hover:bg-gray-50 transition',
  btnDanger: 'border border-red-200 text-red-600 text-xs font-semibold px-3 py-1.5 rounded-lg hover:bg-red-50 transition',
}

const BANKS_NI = ['BAC', 'LAFISE', 'Bampro']

// ─── Main ─────────────────────────────────────────────────────────────────────

export default function ComerciosPage() {
  const [comercios, setComerciosList] = useState<Comercio[]>([])
  const [loading, setLoading] = useState(true)
  const [search, setSearch] = useState('')

  // Drawer state
  const [selected, setSelected] = useState<Comercio | null>(null)
  const [drawerOpen, setDrawerOpen] = useState(false)

  // Edit state in drawer
  const [eName, setEName] = useState('')
  const [ePhone, setEPhone] = useState('')
  const [eAddress, setEAddress] = useState('')
  const [eAccounts, setEAccounts] = useState<BankAccount[]>([])
  const [ePuntos, setEPuntos] = useState<PuntoRetiro[]>([])
  const [saving, setSaving] = useState(false)
  const [msg, setMsg] = useState<string | null>(null)

  // Punto modal
  const [puntoModal, setPuntoModal] = useState(false)
  const [editingPuntoKey, setEditingPuntoKey] = useState<string | null>(null)
  const [pLabel, setPLabel] = useState('')
  const [pNombre, setPNombre] = useState('')
  const [pCelular, setPCelular] = useState('')
  const [pDireccion, setPDireccion] = useState('')
  const [pNota, setPNota] = useState('')
  const [puntoBusy, setPuntoBusy] = useState(false)
  const [puntoError, setPuntoError] = useState('')

  // Load all comercios (usuarios with rol=cliente)
  useEffect(() => {
    const q = query(collection(db, 'usuarios'), where('rol', '==', 'Comercio'))
    const unsub = onSnapshot(q, async (snap) => {
      const usuarios = snap.docs.map((d) => ({ uid: d.id, ...(d.data() as any) }))
      // Fetch comercios docs in parallel
      const snapsCom = await Promise.all(
        usuarios.map((u) => getDoc(doc(db, 'comercios', u.uid)))
      )
      const list: Comercio[] = usuarios.map((u, i) => {
        const comData = snapsCom[i].exists() ? (snapsCom[i].data() as any) : {}
        return {
          uid: u.uid,
          email: u.email || '',
          userName: u.name,
          activo: u.activo,
          name: comData.name || u.name || '',
          phone: comData.phone || '',
          address: comData.address || '',
          accounts: Array.isArray(comData.accounts) ? comData.accounts : [],
          puntosRetiro: comData.puntosRetiro || {},
        }
      })
      list.sort((a, b) => (a.name || '').localeCompare(b.name || ''))
      setComerciosList(list)
      setLoading(false)
    })
    return () => unsub()
  }, [])

  const filtered = comercios.filter((c) => {
    const q = search.toLowerCase()
    return (
      !q ||
      (c.name || '').toLowerCase().includes(q) ||
      (c.email || '').toLowerCase().includes(q) ||
      (c.phone || '').includes(q)
    )
  })

  function openDrawer(c: Comercio) {
    setSelected(c)
    setEName(c.name || '')
    setEPhone(c.phone || '')
    setEAddress(c.address || '')
    setEAccounts(
      Array.isArray(c.accounts) && c.accounts.length
        ? c.accounts
        : [{ bank: '', number: '', holder: '', currency: 'NIO' }]
    )
    const puntos: PuntoRetiro[] = Object.entries(c.puntosRetiro || {}).map(([key, raw]: [string, any]) => ({
      key,
      label: raw?.label || raw?.nombre || key,
      nombre: raw?.nombre,
      celular: raw?.celular,
      direccion: raw?.direccion,
      nota: raw?.nota,
    }))
    setEPuntos(puntos)
    setMsg(null)
    setDrawerOpen(true)
  }

  function closeDrawer() {
    setDrawerOpen(false)
    setTimeout(() => setSelected(null), 300)
  }

  async function saveProfile() {
    if (!selected) return
    setSaving(true); setMsg(null)
    try {
      const accountsClean = eAccounts
        .filter((a) => a.bank || a.number || a.holder)
        .map((a) => ({
          bank: (a.bank || '').trim(),
          number: (a.number || '').trim(),
          holder: (a.holder || '').trim(),
          currency: a.currency || 'NIO',
        }))
      const payload: CompanyPayload = {
        name: eName.trim(),
        phone: ePhone.trim(),
        address: eAddress.trim(),
        accounts: accountsClean,
      }
      await upsertCompanyByUid(selected.uid, payload)
      setMsg('✅ Perfil guardado')
      // Update local list
      setComerciosList((prev) =>
        prev.map((c) =>
          c.uid === selected.uid ? { ...c, name: eName.trim(), phone: ePhone.trim(), address: eAddress.trim(), accounts: accountsClean } : c
        )
      )
    } catch (e: any) {
      setMsg(`❌ Error: ${e?.message || 'No se pudo guardar'}`)
    } finally {
      setSaving(false)
    }
  }

  function addAccount() {
    setEAccounts((prev) => [...prev, { bank: '', number: '', holder: '', currency: 'NIO' }])
  }
  function updateAccount(idx: number, patch: Partial<BankAccount>) {
    setEAccounts((prev) => prev.map((a, i) => (i === idx ? { ...a, ...patch } : a)))
  }
  function removeAccount(idx: number) {
    setEAccounts((prev) => prev.filter((_, i) => i !== idx))
  }

  // Puntos de retiro
  function openNewPunto() {
    setEditingPuntoKey(null)
    setPLabel(''); setPNombre(''); setPCelular(''); setPDireccion(''); setPNota('')
    setPuntoError(''); setPuntoModal(true)
  }
  function openEditPunto(p: PuntoRetiro) {
    setEditingPuntoKey(p.key)
    setPLabel(p.label); setPNombre(p.nombre || ''); setPCelular(p.celular || '')
    setPDireccion(p.direccion || ''); setPNota(p.nota || '')
    setPuntoError(''); setPuntoModal(true)
  }
  async function savePunto() {
    if (!selected) return
    if (!pLabel.trim()) { setPuntoError('El nombre del punto es obligatorio.'); return }
    setPuntoBusy(true); setPuntoError('')
    try {
      const key = editingPuntoKey || `punto_${Date.now()}`
      const payload: Record<string, any> = {
        label: pLabel.trim(),
        nombre: pNombre.trim() || pLabel.trim(),
        celular: pCelular.trim(),
        direccion: pDireccion.trim(),
        nota: pNota.trim() || null,
        updatedAt: serverTimestamp(),
      }
      await setDoc(
        doc(db, 'comercios', selected.uid),
        { puntosRetiro: { [key]: payload }, updatedAt: serverTimestamp() },
        { merge: true }
      )
      // Update local list
      const updated: PuntoRetiro = {
        key,
        label: pLabel.trim(),
        nombre: pNombre.trim() || pLabel.trim(),
        celular: pCelular.trim(),
        direccion: pDireccion.trim(),
        nota: pNota.trim() || undefined,
      }
      setEPuntos((prev) =>
        editingPuntoKey
          ? prev.map((p) => (p.key === editingPuntoKey ? updated : p))
          : [...prev, updated]
      )
      setPuntoModal(false)
    } catch (e) {
      console.error(e)
      setPuntoError('No se pudo guardar el punto.')
    } finally {
      setPuntoBusy(false)
    }
  }
  async function deletePunto(key: string) {
    if (!selected) return
    if (!confirm('¿Eliminar este punto de retiro?')) return
    try {
      await updateDoc(doc(db, 'comercios', selected.uid), {
        [`puntosRetiro.${key}`]: null,
        updatedAt: serverTimestamp(),
      })
      setEPuntos((prev) => prev.filter((p) => p.key !== key))
    } catch (e) {
      console.error(e)
    }
  }

  const countPuntos = (c: Comercio) => Object.keys(c.puntosRetiro || {}).length

  return (
    <div className="h-full flex flex-col">
      {/* Header */}
      <div className="mb-4">
        <h1 className="text-2xl font-black text-gray-900 tracking-tight">Comercios</h1>
        <p className="text-sm text-gray-500 mt-0.5">
          Gestioná los perfiles de todos los comercios registrados.
        </p>
      </div>

      {/* Search */}
      <div className="mb-4 relative max-w-sm">
        <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-gray-400" />
        <input
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          placeholder="Buscar por nombre, email o teléfono…"
          className="w-full border border-gray-200 rounded-xl pl-9 pr-4 py-2.5 text-sm focus:outline-none focus:ring-2 focus:ring-[#004aad]/30 focus:border-[#004aad]"
        />
        {search && (
          <button onClick={() => setSearch('')} className="absolute right-3 top-1/2 -translate-y-1/2">
            <X className="h-4 w-4 text-gray-400" />
          </button>
        )}
      </div>

      {/* Table */}
      <div className="flex-1 overflow-auto rounded-xl border border-gray-200 bg-white shadow-sm">
        {loading ? (
          <div className="flex items-center justify-center py-20 text-sm text-gray-500">Cargando comercios…</div>
        ) : filtered.length === 0 ? (
          <div className="flex flex-col items-center justify-center py-20 gap-2 text-gray-400">
            <Building2 className="h-10 w-10 opacity-30" />
            <p className="text-sm font-medium">No se encontraron comercios</p>
          </div>
        ) : (
          <table className="w-full text-sm min-w-[700px]">
            <thead>
              <tr className="bg-gray-50 border-b border-gray-200">
                <th className="text-left px-4 py-3 font-semibold text-gray-600 text-xs uppercase tracking-wide">Comercio</th>
                <th className="text-left px-4 py-3 font-semibold text-gray-600 text-xs uppercase tracking-wide">Email</th>
                <th className="text-left px-4 py-3 font-semibold text-gray-600 text-xs uppercase tracking-wide">Teléfono</th>
                <th className="text-left px-4 py-3 font-semibold text-gray-600 text-xs uppercase tracking-wide">Cuentas</th>
                <th className="text-left px-4 py-3 font-semibold text-gray-600 text-xs uppercase tracking-wide">Puntos</th>
                <th className="text-left px-4 py-3 font-semibold text-gray-600 text-xs uppercase tracking-wide">Estado</th>
                <th className="px-4 py-3" />
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-100">
              {filtered.map((c) => (
                <tr key={c.uid} className="hover:bg-gray-50 transition-colors">
                  <td className="px-4 py-3">
                    <div className="font-semibold text-gray-900">{c.name || '—'}</div>
                    {c.address && <div className="text-xs text-gray-400 truncate max-w-[180px]">{c.address}</div>}
                  </td>
                  <td className="px-4 py-3 text-gray-600">{c.email}</td>
                  <td className="px-4 py-3 text-gray-600">{c.phone || '—'}</td>
                  <td className="px-4 py-3">
                    {(c.accounts || []).length > 0 ? (
                      <div className="flex flex-wrap gap-1">
                        {(c.accounts || []).map((a, i) => (
                          <span key={i} className="inline-flex items-center gap-1 bg-blue-50 text-blue-700 text-xs font-semibold px-2 py-0.5 rounded-full border border-blue-200">
                            <CreditCard className="h-3 w-3" />
                            {a.bank} {a.currency}
                          </span>
                        ))}
                      </div>
                    ) : (
                      <span className="text-xs text-gray-400">Sin cuentas</span>
                    )}
                  </td>
                  <td className="px-4 py-3">
                    <span className={`inline-flex items-center gap-1 text-xs font-semibold px-2 py-0.5 rounded-full ${countPuntos(c) > 0 ? 'bg-yellow-50 text-yellow-700 border border-yellow-200' : 'text-gray-400'}`}>
                      {countPuntos(c) > 0 ? (
                        <><Star className="h-3 w-3" />{countPuntos(c)} punto{countPuntos(c) !== 1 ? 's' : ''}</>
                      ) : '—'}
                    </span>
                  </td>
                  <td className="px-4 py-3">
                    <span className={`inline-flex items-center text-xs font-semibold px-2 py-0.5 rounded-full ${c.activo ? 'bg-green-50 text-green-700 border border-green-200' : 'bg-red-50 text-red-600 border border-red-200'}`}>
                      {c.activo ? 'Activo' : 'Inactivo'}
                    </span>
                  </td>
                  <td className="px-4 py-3">
                    <button onClick={() => openDrawer(c)} className="text-[#004aad] text-xs font-semibold hover:underline">
                      Editar
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>

      {/* Summary */}
      {!loading && (
        <p className="mt-2 text-xs text-gray-400">{filtered.length} de {comercios.length} comercio{comercios.length !== 1 ? 's' : ''}</p>
      )}

      {/* Drawer overlay */}
      <div
        className={`fixed inset-0 z-40 bg-black/40 backdrop-blur-sm transition-opacity ${drawerOpen ? 'opacity-100 pointer-events-auto' : 'opacity-0 pointer-events-none'}`}
        onClick={closeDrawer}
      />

      {/* Drawer panel */}
      <div
        className={`fixed right-0 top-0 z-50 h-full w-full max-w-[520px] bg-white shadow-2xl flex flex-col transition-transform duration-300 ${drawerOpen ? 'translate-x-0' : 'translate-x-full'}`}
      >
        {selected && (
          <>
            {/* Drawer header */}
            <div className="flex items-center justify-between px-5 py-4 border-b border-gray-200">
              <div>
                <h2 className="text-lg font-black text-gray-900">{selected.name || selected.email}</h2>
                <p className="text-xs text-gray-400">{selected.email}</p>
              </div>
              <button onClick={closeDrawer} className="w-9 h-9 grid place-items-center rounded-full border border-gray-200 hover:bg-gray-50 transition">
                <X className="h-4 w-4 text-gray-500" />
              </button>
            </div>

            {/* Drawer body */}
            <div className="flex-1 overflow-y-auto p-5 space-y-6">

              {/* ── Perfil empresa ── */}
              <section>
                <div className="flex items-center gap-2 mb-3">
                  <Building2 className="h-4 w-4 text-[#004aad]" />
                  <h3 className="text-sm font-bold text-gray-800 uppercase tracking-wide">Perfil de empresa</h3>
                </div>
                <div className="space-y-3">
                  <div>
                    <label className={S.label}>Nombre comercial</label>
                    <input value={eName} onChange={(e) => setEName(e.target.value)} placeholder="Nombre del comercio" className={S.input} />
                  </div>
                  <div className="grid grid-cols-2 gap-3">
                    <div>
                      <label className={S.label}>Teléfono</label>
                      <input value={ePhone} onChange={(e) => setEPhone(e.target.value)} placeholder="+505 8888-8888" className={S.input} />
                    </div>
                    <div>
                      <label className={S.label}>Dirección</label>
                      <input value={eAddress} onChange={(e) => setEAddress(e.target.value)} placeholder="Dirección" className={S.input} />
                    </div>
                  </div>
                </div>
              </section>

              {/* ── Cuentas bancarias ── */}
              <section>
                <div className="flex items-center justify-between mb-3">
                  <div className="flex items-center gap-2">
                    <CreditCard className="h-4 w-4 text-[#004aad]" />
                    <h3 className="text-sm font-bold text-gray-800 uppercase tracking-wide">Cuentas bancarias</h3>
                  </div>
                  <button onClick={addAccount} className={S.btnOutline}>+ Agregar</button>
                </div>
                {eAccounts.length === 0 ? (
                  <p className="text-xs text-gray-400 italic">Sin cuentas registradas.</p>
                ) : (
                  <div className="space-y-3">
                    {eAccounts.map((a, i) => (
                      <div key={i} className="bg-gray-50 border border-gray-200 rounded-xl p-3 space-y-2">
                        <div className="grid grid-cols-3 gap-2">
                          <select
                            value={a.bank}
                            onChange={(e) => updateAccount(i, { bank: e.target.value })}
                            className={S.input}
                          >
                            <option value="">Banco</option>
                            {BANKS_NI.map((b) => <option key={b} value={b}>{b}</option>)}
                          </select>
                          <input
                            placeholder="Número de cuenta"
                            value={a.number}
                            onChange={(e) => updateAccount(i, { number: e.target.value })}
                            className={S.input}
                          />
                          <input
                            placeholder="Titular"
                            value={a.holder}
                            onChange={(e) => updateAccount(i, { holder: e.target.value })}
                            className={S.input}
                          />
                        </div>
                        <div className="flex items-center justify-between">
                          <select
                            value={a.currency}
                            onChange={(e) => updateAccount(i, { currency: e.target.value })}
                            className={`${S.input} w-auto`}
                          >
                            <option value="NIO">NIO — Córdoba</option>
                            <option value="USD">USD — Dólar</option>
                          </select>
                          <button onClick={() => removeAccount(i)} className={S.btnDanger}>Eliminar</button>
                        </div>
                      </div>
                    ))}
                  </div>
                )}
              </section>

              {/* Save button + feedback */}
              <div className="flex items-center gap-3">
                <button onClick={saveProfile} disabled={saving} className={S.btnPrimary}>
                  {saving ? 'Guardando…' : 'Guardar perfil y cuentas'}
                </button>
                {msg && (
                  <span className={`text-sm font-semibold ${msg.startsWith('✅') ? 'text-green-600' : 'text-red-600'}`}>{msg}</span>
                )}
              </div>

              {/* ── Puntos de retiro ── */}
              <section>
                <div className="flex items-center justify-between mb-3">
                  <div className="flex items-center gap-2">
                    <MapPin className="h-4 w-4 text-[#004aad]" />
                    <h3 className="text-sm font-bold text-gray-800 uppercase tracking-wide">Puntos de retiro</h3>
                  </div>
                  <button onClick={openNewPunto} className={S.btnPrimary}>+ Nuevo punto</button>
                </div>
                {ePuntos.length === 0 ? (
                  <div className="bg-gray-50 border border-dashed border-gray-300 rounded-xl p-6 text-center">
                    <p className="text-2xl mb-1">📍</p>
                    <p className="text-sm text-gray-500">Sin puntos de retiro registrados</p>
                  </div>
                ) : (
                  <div className="space-y-2">
                    {ePuntos.map((p) => (
                      <div key={p.key} className="bg-gray-50 border border-gray-200 rounded-xl p-3 flex items-start justify-between gap-3">
                        <div className="flex-1 min-w-0">
                          <div className="flex items-center gap-1.5 mb-1">
                            <span className="text-sm">⭐</span>
                            <span className="text-sm font-bold text-gray-900">{p.label}</span>
                          </div>
                          {p.nombre && p.nombre !== p.label && <p className="text-xs text-gray-600">{p.nombre}</p>}
                          {p.celular && <p className="text-xs text-gray-400">📞 {p.celular}</p>}
                          {p.direccion && <p className="text-xs text-gray-400 truncate">📍 {p.direccion}</p>}
                          {p.nota && <p className="text-xs text-purple-600">📝 {p.nota}</p>}
                        </div>
                        <div className="flex gap-2 flex-shrink-0">
                          <button onClick={() => openEditPunto(p)} className={S.btnOutline}>✏️</button>
                          <button onClick={() => deletePunto(p.key)} className={S.btnDanger}>🗑️</button>
                        </div>
                      </div>
                    ))}
                  </div>
                )}
              </section>

            </div>
          </>
        )}
      </div>

      {/* Punto modal */}
      {puntoModal && (
        <div
          className="fixed inset-0 z-[70] bg-black/50 flex items-center justify-center p-4"
          onClick={(e) => { if (e.target === e.currentTarget) setPuntoModal(false) }}
        >
          <div className="w-full max-w-md bg-white rounded-2xl border border-gray-200 shadow-2xl p-5 max-h-[90vh] overflow-y-auto">
            <div className="flex items-center justify-between mb-4">
              <h3 className="text-base font-black text-gray-900">
                {editingPuntoKey ? 'Editar punto' : 'Nuevo punto de retiro'}
              </h3>
              <button onClick={() => setPuntoModal(false)} className="w-8 h-8 grid place-items-center rounded-full border border-gray-200 hover:bg-gray-50">
                <X className="h-4 w-4 text-gray-500" />
              </button>
            </div>

            <div className="space-y-3">
              <div>
                <label className={S.label}>Nombre del lugar <span className="text-red-500">*</span></label>
                <input value={pLabel} onChange={(e) => setPLabel(e.target.value)} placeholder="Ej: Tienda principal, Bodega norte…" className={S.input} />
              </div>
              <div>
                <label className={S.label}>Nombre de contacto</label>
                <input value={pNombre} onChange={(e) => setPNombre(e.target.value)} placeholder="Ej: Juan Pérez" className={S.input} />
              </div>
              <div>
                <label className={S.label}>Celular de contacto</label>
                <input value={pCelular} onChange={(e) => setPCelular(e.target.value)} placeholder="8888-8888" className={S.input} />
              </div>
              <div>
                <label className={S.label}>Dirección escrita</label>
                <input value={pDireccion} onChange={(e) => setPDireccion(e.target.value)} placeholder="Del semáforo 1c al sur…" className={S.input} />
              </div>
              <div>
                <label className={S.label}>Nota <span className="text-gray-400 normal-case font-normal">(opcional)</span></label>
                <input value={pNota} onChange={(e) => setPNota(e.target.value)} placeholder="Info contextual para el motorizado…" className={S.input} />
              </div>

              {puntoError && (
                <div className="bg-red-50 border border-red-200 rounded-lg px-3 py-2 text-sm text-red-600 font-semibold">
                  {puntoError}
                </div>
              )}

              <div className="flex justify-end gap-2 pt-2">
                <button onClick={() => setPuntoModal(false)} className={S.btnOutline}>Cancelar</button>
                <button onClick={savePunto} disabled={puntoBusy} className={S.btnPrimary}>
                  {puntoBusy ? 'Guardando…' : 'Guardar punto'}
                </button>
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
