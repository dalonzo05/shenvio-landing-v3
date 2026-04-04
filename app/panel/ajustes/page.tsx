'use client'

import React, { useCallback, useEffect, useRef, useState } from 'react'
import { useRouter } from 'next/navigation'
import { useUser } from '@/app/Components/UserProvider'
import {
  readUserProfileByUid,
  readCompanyByUid,
  upsertUserProfileByUid,
  upsertCompanyByUid,
  type CompanyPayload,
  type BankAccount,
} from '@/fb/data'
import {
  EmailAuthProvider,
  reauthenticateWithCredential,
  updatePassword,
} from 'firebase/auth'
import {
  doc,
  onSnapshot,
  serverTimestamp,
  setDoc,
  updateDoc,
} from 'firebase/firestore'
import { db } from '@/fb/config'
import { getMapsLoader } from '@/lib/googleMaps'

// ─── Types ────────────────────────────────────────────────────────────────────

type LatLng = { lat: number; lng: number }

type PuntoFavorito = {
  key: string          // UUID o slug libre
  label: string        // nombre que pone el comercio
  nombre?: string
  celular?: string
  direccion?: string
  nota?: string
  coord?: LatLng | null
  puntoGoogleLink?: string
  tipoUbicacion?: 'referencial' | 'exacto'
}

const BANKS_NI = ['BAC', 'LAFISE', 'Bampro']

// ─── Mini map picker ──────────────────────────────────────────────────────────

function MapPicker({
  coord,
  onSelect,
}: {
  coord: LatLng | null
  onSelect: (c: LatLng, address: string) => void
}) {
  const containerRef = useRef<HTMLDivElement>(null)
  const mapRef = useRef<google.maps.Map | null>(null)
  const markerRef = useRef<google.maps.Marker | null>(null)
  const geocoderRef = useRef<google.maps.Geocoder | null>(null)

  useEffect(() => {
    let mounted = true
    getMapsLoader().load().then((google) => {
      if (!mounted || !containerRef.current) return
      const center = coord || { lat: 12.1364, lng: -86.2514 }
      mapRef.current = new google.maps.Map(containerRef.current, {
        center,
        zoom: coord ? 15 : 13,
        disableDefaultUI: true,
        zoomControl: true,
        styles: [
          { featureType: 'poi', stylers: [{ visibility: 'off' }] },
          { featureType: 'transit', stylers: [{ visibility: 'off' }] },
        ],
      })
      geocoderRef.current = new google.maps.Geocoder()

      if (coord) {
        markerRef.current = new google.maps.Marker({ map: mapRef.current, position: coord, draggable: true })
        markerRef.current.addListener('dragend', () => {
          const pos = markerRef.current?.getPosition()
          if (!pos) return
          const c = { lat: pos.lat(), lng: pos.lng() }
          geocoderRef.current?.geocode({ location: c }, (results, status) => {
            onSelect(c, status === 'OK' && results?.[0] ? results[0].formatted_address : '')
          })
        })
      }

      mapRef.current.addListener('click', (e: google.maps.MapMouseEvent) => {
        if (!e.latLng) return
        const c = { lat: e.latLng.lat(), lng: e.latLng.lng() }
        markerRef.current?.setMap(null)
        markerRef.current = new google.maps.Marker({ map: mapRef.current!, position: c, draggable: true })
        markerRef.current.addListener('dragend', () => {
          const pos = markerRef.current?.getPosition()
          if (!pos) return
          const cc = { lat: pos.lat(), lng: pos.lng() }
          geocoderRef.current?.geocode({ location: cc }, (results, status) => {
            onSelect(cc, status === 'OK' && results?.[0] ? results[0].formatted_address : '')
          })
        })
        geocoderRef.current?.geocode({ location: c }, (results, status) => {
          onSelect(c, status === 'OK' && results?.[0] ? results[0].formatted_address : '')
        })
      })
    })
    return () => { mounted = false }
  }, [])

  return (
    <div>
      <div ref={containerRef} style={{ width: '100%', height: 220, borderRadius: 12, overflow: 'hidden', border: '1px solid #e5e7eb' }} />
      <p style={{ fontSize: 11, color: '#9ca3af', marginTop: 6 }}>
        Tocá el mapa para marcar la ubicación exacta del lugar. Podés arrastrar el pin.
      </p>
    </div>
  )
}

// ─── Styles ───────────────────────────────────────────────────────────────────

const S: Record<string, React.CSSProperties> = {
  section: { background: '#fff', border: '1px solid #e5e7eb', borderRadius: 16, padding: '20px 20px', marginBottom: 16, boxShadow: '0 1px 3px rgba(0,0,0,0.05)' },
  label: { display: 'block', fontSize: 13, fontWeight: 600, color: '#374151', marginBottom: 6 },
  input: { width: '100%', border: '1px solid #e5e7eb', borderRadius: 10, padding: '10px 12px', fontSize: 14, color: '#111827', outline: 'none', background: '#fff', boxSizing: 'border-box', fontFamily: 'inherit' },
  btnPrimary: { background: '#004aad', border: 'none', borderRadius: 10, padding: '10px 20px', color: '#fff', fontSize: 14, fontWeight: 700, cursor: 'pointer' },
  btnOutline: { border: '1px solid #e5e7eb', borderRadius: 10, padding: '9px 16px', background: '#fff', fontSize: 13, fontWeight: 600, color: '#374151', cursor: 'pointer' },
  btnDanger: { border: '1px solid #fecaca', borderRadius: 10, padding: '7px 14px', background: '#fff', fontSize: 12, fontWeight: 600, color: '#dc2626', cursor: 'pointer' },
  modalBackdrop: { position: 'fixed', inset: 0, background: 'rgba(15,23,42,0.45)', display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 200, padding: 16, overflowY: 'auto' },
  modalCard: { width: '100%', maxWidth: 560, background: '#fff', borderRadius: 18, border: '1px solid #e5e7eb', boxShadow: '0 24px 64px rgba(0,0,0,0.18)', padding: 20, maxHeight: '90vh', overflowY: 'auto' },
}

// ─── Main ─────────────────────────────────────────────────────────────────────

export default function AjustesPage() {
  const router = useRouter()
  const { authUser, profile, loading, resendVerification, refreshProfile } = useUser()

  // Perfil
  const [name, setName] = useState(profile?.name ?? '')
  const [emailVerified, setEmailVerified] = useState<boolean | null>(null)

  // Empresa
  const [companyName, setCompanyName] = useState('')
  const [phone, setPhone] = useState('')
  const [address, setAddress] = useState('')
  const [accounts, setAccounts] = useState<BankAccount[]>([{ bank: '', number: '', holder: '', currency: 'NIO' }])

  // Seguridad
  const [pwdCurrent, setPwdCurrent] = useState('')
  const [pwdNew, setPwdNew] = useState('')

  // Puntos favoritos
  const [puntosFavoritos, setPuntosFavoritos] = useState<PuntoFavorito[]>([])

  // Modal favorito
  const [modalOpen, setModalOpen] = useState(false)
  const [editingKey, setEditingKey] = useState<string | null>(null)
  const [favLabel, setFavLabel] = useState('')
  const [favNombre, setFavNombre] = useState('')
  const [favCelular, setFavCelular] = useState('')
  const [favDireccion, setFavDireccion] = useState('')
  const [favNota, setFavNota] = useState('')
  const [favCoord, setFavCoord] = useState<LatLng | null>(null)
  const [favLink, setFavLink] = useState('')
  const [favTipo, setFavTipo] = useState<'referencial' | 'exacto'>('referencial')
  const [favError, setFavError] = useState('')
  const [savingFav, setSavingFav] = useState(false)
  const [showMapPicker, setShowMapPicker] = useState(false)

  // Feedback
  const [savingProfile, setSavingProfile] = useState(false)
  const [savingCompany, setSavingCompany] = useState(false)
  const [msgProfile, setMsgProfile] = useState<string | null>(null)
  const [msgCompany, setMsgCompany] = useState<string | null>(null)
  const [msgPwd, setMsgPwd] = useState<string | null>(null)

  useEffect(() => {
    if (!loading && !authUser) router.replace('/login')
  }, [loading, authUser, router])

  useEffect(() => {
    if (!authUser) return
    ;(async () => {
      setEmailVerified(authUser.emailVerified)
      const p = await readUserProfileByUid(authUser.uid)
      setName(p?.name ?? profile?.name ?? '')
      const c = await readCompanyByUid(authUser.uid)
      if (c) {
        setCompanyName(c.name ?? '')
        setPhone(c.phone ?? '')
        setAddress(c.address ?? '')
        setAccounts(Array.isArray(c.accounts) && c.accounts.length ? (c.accounts as BankAccount[]) : [{ bank: '', number: '', holder: '', currency: 'NIO' }])
      }
    })()
  }, [authUser, profile?.name])

  // Real-time puntos favoritos
  useEffect(() => {
    if (!authUser) return
    const unsub = onSnapshot(doc(db, 'comercios', authUser.uid), (snap) => {
      if (!snap.exists()) { setPuntosFavoritos([]); return }
      const data = snap.data() as any
      const container = data?.puntosRetiro || {}
      const items: PuntoFavorito[] = Object.entries(container).map(([key, raw]: [string, any]) => ({
        key,
        label: raw?.label || raw?.nombre || key,
        nombre: raw?.nombre,
        celular: raw?.celular,
        direccion: raw?.direccion,
        nota: raw?.nota,
        coord: raw?.coord || null,
        puntoGoogleLink: raw?.puntoGoogleLink,
        tipoUbicacion: raw?.tipoUbicacion,
      })).filter(item => item.label || item.nombre || item.direccion)
      setPuntosFavoritos(items)
    })
    return () => unsub()
  }, [authUser])

  if (loading || !authUser) return null

  // ── Profile ──
  const saveProfile = async () => {
    setSavingProfile(true); setMsgProfile(null)
    try {
      await upsertUserProfileByUid(authUser.uid, { name: name.trim(), email: authUser.email ?? '' })
      await refreshProfile()
      setMsgProfile('✅ Perfil guardado')
    } catch { setMsgProfile('❌ No se pudo guardar') }
    finally { setSavingProfile(false) }
  }

  // ── Company ──
  const saveCompany = async () => {
    setSavingCompany(true); setMsgCompany(null)
    try {
      const accountsClean = accounts.filter(a => a.bank || a.number || a.holder).map(a => ({ bank: (a.bank || '').trim(), number: (a.number || '').trim(), holder: (a.holder || '').trim(), currency: a.currency || 'NIO' }))
      const payload: CompanyPayload = { name: companyName.trim(), phone: phone.trim(), address: address.trim(), accounts: accountsClean }
      await upsertCompanyByUid(authUser.uid, payload)
      setMsgCompany('✅ Empresa guardada')
    } catch (e: any) { setMsgCompany(`❌ No se pudo guardar: ${e?.message || ''}`) }
    finally { setSavingCompany(false) }
  }

  // ── Password ──
  const changePassword = async () => {
    setMsgPwd(null)
    if (!authUser?.email || !pwdCurrent || !pwdNew) { setMsgPwd('❌ Completá ambas contraseñas.'); return }
    try {
      const cred = EmailAuthProvider.credential(authUser.email, pwdCurrent)
      await reauthenticateWithCredential(authUser, cred)
      await updatePassword(authUser, pwdNew)
      setPwdCurrent(''); setPwdNew('')
      setMsgPwd('✅ Contraseña actualizada')
    } catch (e: any) { setMsgPwd(`❌ ${e?.message || 'Error al cambiar contraseña'}`) }
  }

  // ── Favoritos ──
  const abrirModalNuevo = () => {
    setEditingKey(null)
    setFavLabel(''); setFavNombre(''); setFavCelular(''); setFavDireccion(''); setFavNota(''); setFavCoord(null); setFavLink(''); setFavTipo('referencial')
    setFavError(''); setShowMapPicker(false); setModalOpen(true)
  }

  const abrirModalEditar = (fav: PuntoFavorito) => {
    setEditingKey(fav.key)
    setFavLabel(fav.label); setFavNombre(fav.nombre || ''); setFavCelular(fav.celular || '')
    setFavDireccion(fav.direccion || ''); setFavNota(fav.nota || ''); setFavCoord(fav.coord || null); setFavLink(fav.puntoGoogleLink || '')
    setFavTipo(fav.tipoUbicacion || 'referencial')
    setFavError(''); setShowMapPicker(!!fav.coord); setModalOpen(true)
  }

  const guardarFavorito = async () => {
    if (!favLabel.trim()) { setFavError('El nombre del lugar es obligatorio.'); return }
    const duplicateLabel = puntosFavoritos.some(
      f => f.key !== editingKey && f.label.trim().toLowerCase() === favLabel.trim().toLowerCase()
    )
    if (duplicateLabel) { setFavError('Ya existe un punto favorito con ese nombre. Usá un nombre distinto para identificarlo.'); return }
    setSavingFav(true); setFavError('')
    try {
      const key = editingKey || `punto_${Date.now()}`
      const payload: Record<string, any> = {
        label: favLabel.trim(),
        nombre: favNombre.trim() || favLabel.trim(),
        celular: favCelular.trim(),
        direccion: favDireccion.trim(),
        tipoUbicacion: favTipo,
        updatedAt: serverTimestamp(),
      }
      if (favNota.trim()) payload.nota = favNota.trim()
      if (favCoord) payload.coord = favCoord
      if (favLink.trim()) payload.puntoGoogleLink = favLink.trim()

      await setDoc(doc(db, 'comercios', authUser.uid), { puntosRetiro: { [key]: payload }, updatedAt: serverTimestamp() }, { merge: true })
      setModalOpen(false)
    } catch (e) { console.error(e); setFavError('No se pudo guardar el punto.') }
    finally { setSavingFav(false) }
  }

  const eliminarFavorito = async (key: string) => {
    if (!confirm('¿Eliminás este punto favorito?')) return
    try {
      await updateDoc(doc(db, 'comercios', authUser.uid), { [`puntosRetiro.${key}`]: null, updatedAt: serverTimestamp() })
    } catch (e) { console.error(e) }
  }

  const handleResend = async () => {
    try { await resendVerification(); alert('Si tu correo no estaba verificado, enviamos un email.') }
    catch (e: any) { alert(e?.message || 'No se pudo reenviar.') }
  }

  const addAccount = () => setAccounts(prev => [...prev, { bank: '', number: '', holder: '', currency: 'NIO' }])
  const updateAccount = (idx: number, patch: Partial<BankAccount>) => setAccounts(prev => prev.map((a, i) => i === idx ? { ...a, ...patch } : a))
  const removeAccount = (idx: number) => setAccounts(prev => prev.filter((_, i) => i !== idx))

  return (
    <div style={{ maxWidth: 680, margin: '0 auto', padding: '0 0 48px', fontFamily: "'SF Pro Display', -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif" }}>

      <div style={{ marginBottom: 24 }}>
        <h1 style={{ fontSize: 26, fontWeight: 800, color: '#111827', margin: '0 0 4px', letterSpacing: -0.5 }}>Ajustes</h1>
        <p style={{ fontSize: 14, color: '#6b7280', margin: 0 }}>Configurá tu perfil, empresa y puntos de envío.</p>
      </div>

      {!emailVerified && (
        <div style={{ background: '#fffbe6', border: '1px solid #ffe58f', borderRadius: 14, padding: '14px 16px', marginBottom: 16 }}>
          <p style={{ fontSize: 14, fontWeight: 700, color: '#d46b08', margin: '0 0 4px' }}>Tu correo no está verificado</p>
          <p style={{ fontSize: 13, color: '#92400e', margin: '0 0 10px' }}>Revisá tu bandeja o solicitá un nuevo correo.</p>
          <button onClick={handleResend} style={S.btnOutline}>Reenviar verificación</button>
        </div>
      )}

      {/* ── PERFIL ── */}
      <div style={S.section}>
        <h2 style={{ fontSize: 16, fontWeight: 800, color: '#111827', margin: '0 0 16px' }}>Perfil</h2>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
          <div>
            <label style={S.label}>Nombre</label>
            <input value={name} onChange={e => setName(e.target.value)} placeholder="Tu nombre" style={S.input} />
          </div>
          <div>
            <label style={S.label}>Correo (de tu sesión)</label>
            <input value={authUser.email ?? ''} readOnly style={{ ...S.input, background: '#f9fafb', color: '#9ca3af' }} />
          </div>
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginTop: 16 }}>
          <button onClick={saveProfile} disabled={savingProfile} style={S.btnPrimary}>{savingProfile ? 'Guardando...' : 'Guardar perfil'}</button>
          {msgProfile && <span style={{ fontSize: 13, color: msgProfile.startsWith('✅') ? '#16a34a' : '#dc2626', fontWeight: 600 }}>{msgProfile}</span>}
        </div>
      </div>

      {/* ── SEGURIDAD ── */}
      <div style={S.section}>
        <h2 style={{ fontSize: 16, fontWeight: 800, color: '#111827', margin: '0 0 16px' }}>Seguridad</h2>
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12 }}>
          <input type="password" placeholder="Contraseña actual" value={pwdCurrent} onChange={e => setPwdCurrent(e.target.value)} style={S.input} />
          <input type="password" placeholder="Nueva contraseña" value={pwdNew} onChange={e => setPwdNew(e.target.value)} style={S.input} />
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginTop: 12 }}>
          <button onClick={changePassword} style={S.btnOutline}>Cambiar contraseña</button>
          {msgPwd && <span style={{ fontSize: 13, color: msgPwd.startsWith('✅') ? '#16a34a' : '#dc2626', fontWeight: 600 }}>{msgPwd}</span>}
        </div>
      </div>

      {/* ── EMPRESA ── */}
      <div style={S.section}>
        <h2 style={{ fontSize: 16, fontWeight: 800, color: '#111827', margin: '0 0 16px' }}>Datos de la empresa</h2>
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12 }}>
          <div>
            <label style={S.label}>Nombre comercial</label>
            <input value={companyName} onChange={e => setCompanyName(e.target.value)} style={S.input} />
          </div>
          <div>
            <label style={S.label}>Teléfono</label>
            <input value={phone} onChange={e => setPhone(e.target.value)} placeholder="+505 8888-8888" style={S.input} />
          </div>
          <div style={{ gridColumn: '1 / -1' }}>
            <label style={S.label}>Dirección</label>
            <input value={address} onChange={e => setAddress(e.target.value)} style={S.input} />
          </div>
        </div>

        <div style={{ marginTop: 20 }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 12 }}>
            <h3 style={{ fontSize: 14, fontWeight: 700, color: '#374151', margin: 0 }}>Cuentas bancarias</h3>
            <button onClick={addAccount} style={S.btnOutline}>+ Agregar cuenta</button>
          </div>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
            {accounts.map((a, i) => (
              <div key={i} style={{ background: '#f9fafb', border: '1px solid #e5e7eb', borderRadius: 12, padding: '12px 14px' }}>
                <div style={{ display: 'grid', gridTemplateColumns: '1fr 1.5fr 1fr', gap: 8, marginBottom: 8 }}>
                  <select value={a.bank} onChange={e => updateAccount(i, { bank: e.target.value })} style={{ ...S.input, padding: '9px 12px' }}>
                    <option value="">Banco</option>
                    {BANKS_NI.map(b => <option key={b} value={b}>{b}</option>)}
                  </select>
                  <input placeholder="Número de cuenta" value={a.number} onChange={e => updateAccount(i, { number: e.target.value })} style={S.input} />
                  <input placeholder="Titular" value={a.holder} onChange={e => updateAccount(i, { holder: e.target.value })} style={S.input} />
                </div>
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                  <select value={a.currency} onChange={e => updateAccount(i, { currency: e.target.value })} style={{ ...S.input, width: 'auto', padding: '7px 12px' }}>
                    <option value="NIO">NIO — Córdoba</option>
                    <option value="USD">USD — Dólar</option>
                  </select>
                  <button onClick={() => removeAccount(i)} style={S.btnDanger}>Eliminar</button>
                </div>
              </div>
            ))}
          </div>
        </div>

        <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginTop: 20 }}>
          <button onClick={saveCompany} disabled={savingCompany} style={S.btnPrimary}>{savingCompany ? 'Guardando...' : 'Guardar empresa'}</button>
          {msgCompany && <span style={{ fontSize: 13, color: msgCompany.startsWith('✅') ? '#16a34a' : '#dc2626', fontWeight: 600 }}>{msgCompany}</span>}
        </div>
      </div>

      {/* ── PUNTOS FAVORITOS ── */}
      <div style={S.section}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', marginBottom: 16 }}>
          <div>
            <h2 style={{ fontSize: 16, fontWeight: 800, color: '#111827', margin: '0 0 4px' }}>Puntos de retiro favoritos</h2>
            <p style={{ fontSize: 13, color: '#6b7280', margin: 0 }}>Guardá tus lugares habituales para agilizar el llenado del formulario de envío y la calculadora.</p>
          </div>
          <button onClick={abrirModalNuevo} style={S.btnPrimary}>+ Nuevo punto</button>
        </div>

        {puntosFavoritos.length === 0 ? (
          <div style={{ background: '#f9fafb', border: '1px dashed #e5e7eb', borderRadius: 14, padding: '32px 16px', textAlign: 'center' as const }}>
            <p style={{ fontSize: 32, margin: '0 0 8px' }}>📍</p>
            <p style={{ fontSize: 14, fontWeight: 600, color: '#374151', margin: '0 0 4px' }}>Todavía no tenés puntos guardados</p>
            <p style={{ fontSize: 13, color: '#9ca3af', margin: '0 0 16px' }}>Agregá tus lugares de retiro más frecuentes para ahorrar tiempo.</p>
            <button onClick={abrirModalNuevo} style={S.btnOutline}>Agregar primer punto</button>
          </div>
        ) : (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
            {puntosFavoritos.map((fav) => (
              <div key={fav.key} style={{ background: '#f9fafb', border: '1px solid #e5e7eb', borderRadius: 14, padding: '14px 16px', display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', gap: 12 }}>
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 4 }}>
                    <span style={{ fontSize: 16 }}>⭐</span>
                    <p style={{ fontSize: 14, fontWeight: 800, color: '#111827', margin: 0 }}>{fav.label}</p>
                  </div>
                  {fav.nombre && fav.nombre !== fav.label && <p style={{ fontSize: 13, color: '#374151', margin: '0 0 2px' }}>{fav.nombre}</p>}
                  {fav.celular && <p style={{ fontSize: 12, color: '#6b7280', margin: '0 0 2px' }}>📞 {fav.celular}</p>}
                  {fav.direccion && <p style={{ fontSize: 12, color: '#6b7280', margin: '0 0 2px' }}>📍 {fav.direccion}</p>}
                  {fav.nota && <p style={{ fontSize: 12, color: '#7c3aed', margin: '0 0 2px' }}>📝 {fav.nota}</p>}
                  {fav.coord && <p style={{ fontSize: 11, color: '#16a34a', margin: '4px 0 0', fontWeight: 600 }}>🎯 Ubicación guardada en mapa</p>}
                </div>
                <div style={{ display: 'flex', gap: 8, flexShrink: 0 }}>
                  <button onClick={() => abrirModalEditar(fav)} style={S.btnOutline}>✏️ Editar</button>
                  <button onClick={() => eliminarFavorito(fav.key)} style={S.btnDanger}>🗑️ Eliminar</button>
                </div>
              </div>
            ))}
          </div>
        )}
      </div>

      {/* ── MODAL FAVORITO ── */}
      {modalOpen && (
        <div style={S.modalBackdrop} onClick={e => { if (e.target === e.currentTarget) setModalOpen(false) }}>
          <div style={S.modalCard}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', marginBottom: 20 }}>
              <div>
                <h3 style={{ fontSize: 18, fontWeight: 800, color: '#111827', margin: '0 0 4px' }}>{editingKey ? 'Editar punto' : 'Nuevo punto de retiro'}</h3>
                <p style={{ fontSize: 13, color: '#6b7280', margin: 0 }}>Este punto aparecerá en la calculadora y en el formulario de envío.</p>
              </div>
              <button onClick={() => setModalOpen(false)} style={{ border: '1px solid #e5e7eb', background: '#fff', borderRadius: 10, width: 34, height: 34, cursor: 'pointer', fontSize: 16, color: '#374151' }}>✕</button>
            </div>

            <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
              <div>
                <label style={S.label}>Nombre del lugar <span style={{ color: '#dc2626' }}>*</span></label>
                <input value={favLabel} onChange={e => setFavLabel(e.target.value)} placeholder='Ej: Tienda principal, Casa mamá, Bodega norte...' style={S.input} />
                <p style={{ fontSize: 11, color: '#9ca3af', margin: '5px 0 0' }}>Este nombre aparecerá como botón en calculadora y solicitar envío.</p>
              </div>

              <div>
                <label style={S.label}>Nombre de contacto</label>
                <input value={favNombre} onChange={e => setFavNombre(e.target.value)} placeholder='Ej: Juan Pérez / Tienda San Juan' style={S.input} />
              </div>

              <div>
                <label style={S.label}>Celular de contacto</label>
                <input value={favCelular} onChange={e => setFavCelular(e.target.value)} placeholder='Ej: 8888-8888' style={S.input} />
              </div>

              <div>
                <label style={S.label}>Dirección escrita</label>
                <input value={favDireccion} onChange={e => setFavDireccion(e.target.value)} placeholder='Ej: Del semáforo 1c al sur, portón azul' style={S.input} />
              </div>

              <div>
                <label style={S.label}>Nota del punto <span style={{ color: '#9ca3af', fontWeight: 400 }}>(opcional)</span></label>
                <input value={favNota} onChange={e => setFavNota(e.target.value)} placeholder='Ej: Bus 3:30pm Mayoreo, llamar al llegar...' style={S.input} />
                <p style={{ fontSize: 11, color: '#9ca3af', margin: '5px 0 0' }}>Info contextual para el motorizado sobre este punto.</p>
              </div>

              <div>
                <label style={S.label}>Link de Google Maps (opcional)</label>
                <input value={favLink} onChange={e => setFavLink(e.target.value)} placeholder='Pegá el link de Google Maps si tenés' style={S.input} />
              </div>

              <div>
                <p style={{ fontSize: 12, color: '#6b7280', margin: '0 0 8px' }}>¿Qué tan exacta es la ubicación?</p>
                <div style={{ display: 'flex', gap: 8 }}>
                  {(['referencial', 'exacto'] as const).map(t => (
                    <button key={t} type="button" onClick={() => setFavTipo(t)} style={{ padding: '7px 14px', borderRadius: 8, fontSize: 12, fontWeight: 600, cursor: 'pointer', border: `1px solid ${favTipo === t ? '#004aad' : '#e5e7eb'}`, background: favTipo === t ? '#004aad' : '#fff', color: favTipo === t ? '#fff' : '#374151' }}>
                      {t === 'referencial' ? '📍 Referencial' : '🎯 Exacto'}
                    </button>
                  ))}
                </div>
              </div>

              {/* Mapa para marcar ubicación */}
              <div>
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 8 }}>
                  <label style={S.label}>Ubicación en el mapa</label>
                  <button type="button" onClick={() => setShowMapPicker(!showMapPicker)} style={{ ...S.btnOutline, fontSize: 12, padding: '6px 12px' }}>
                    {showMapPicker ? 'Ocultar mapa' : favCoord ? '✏️ Cambiar en mapa' : '+ Marcar en mapa'}
                  </button>
                </div>
                {favCoord && !showMapPicker && (
                  <p style={{ fontSize: 12, color: '#16a34a', fontWeight: 600, margin: 0 }}>🎯 Ubicación marcada: {favCoord.lat.toFixed(5)}, {favCoord.lng.toFixed(5)}</p>
                )}
                {showMapPicker && (
                  <MapPicker
                    coord={favCoord}
                    onSelect={(c, addr) => {
                      setFavCoord(c)
                      if (addr && !favDireccion) setFavDireccion(addr)
                    }}
                  />
                )}
              </div>

              {favError && (
                <div style={{ background: '#fef2f2', border: '1px solid #fecaca', borderRadius: 10, padding: '10px 12px', color: '#dc2626', fontSize: 13, fontWeight: 600 }}>
                  {favError}
                </div>
              )}

              <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8, paddingTop: 4 }}>
                <button onClick={() => setModalOpen(false)} style={S.btnOutline}>Cancelar</button>
                <button onClick={guardarFavorito} disabled={savingFav} style={S.btnPrimary}>{savingFav ? 'Guardando...' : 'Guardar punto'}</button>
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}