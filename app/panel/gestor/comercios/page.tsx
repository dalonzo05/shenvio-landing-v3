'use client'

import React, { useEffect, useState } from 'react'
import {
  collection,
  onSnapshot,
  doc,
  getDoc,
  setDoc,
  serverTimestamp,
  updateDoc,
  deleteField,
} from 'firebase/firestore'
import { httpsCallable, type HttpsCallableResult } from 'firebase/functions'
import { db, functions, auth } from '@/fb/config'
import { upsertCompanyByUid, type BankAccount, type CompanyPayload } from '@/fb/data'
import { getMapsLoader } from '@/lib/googleMaps'
import { Search, X, ChevronDown, ChevronUp, Building2, Phone, MapPin, CreditCard, Star, Lock } from 'lucide-react'

// ─── Types ────────────────────────────────────────────────────────────────────

type LatLng = { lat: number; lng: number }

// ─── MapPicker ────────────────────────────────────────────────────────────────

function MapPicker({ coord, onSelect }: { coord: LatLng | null; onSelect: (c: LatLng, address: string) => void }) {
  const containerRef = React.useRef<HTMLDivElement>(null)
  const searchRef = React.useRef<HTMLInputElement>(null)
  const mapRef = React.useRef<google.maps.Map | null>(null)
  const markerRef = React.useRef<google.maps.Marker | null>(null)
  const geocoderRef = React.useRef<google.maps.Geocoder | null>(null)

  function placeMarker(g: typeof google, c: LatLng) {
    markerRef.current?.setMap(null)
    markerRef.current = new g.maps.Marker({ map: mapRef.current!, position: c, draggable: true })
    markerRef.current.addListener('dragend', () => {
      const pos = markerRef.current?.getPosition()
      if (!pos) return
      const cc = { lat: pos.lat(), lng: pos.lng() }
      geocoderRef.current?.geocode({ location: cc }, (results, status) => {
        onSelect(cc, status === 'OK' && results?.[0] ? results[0].formatted_address : '')
      })
    })
  }

  React.useEffect(() => {
    let mounted = true
    getMapsLoader().load().then((google) => {
      if (!mounted || !containerRef.current || !searchRef.current) return
      const center = coord || { lat: 12.1364, lng: -86.2514 }
      mapRef.current = new google.maps.Map(containerRef.current, {
        center, zoom: coord ? 15 : 13, disableDefaultUI: true, zoomControl: true,
        styles: [
          { featureType: 'poi', stylers: [{ visibility: 'off' }] },
          { featureType: 'transit', stylers: [{ visibility: 'off' }] },
        ],
      })
      geocoderRef.current = new google.maps.Geocoder()

      if (coord) placeMarker(google, coord)

      // Autocomplete search
      const managua = new google.maps.LatLngBounds(
        { lat: 12.05, lng: -86.35 },
        { lat: 12.20, lng: -86.20 }
      )
      const autocomplete = new google.maps.places.Autocomplete(searchRef.current!, {
        fields: ['geometry', 'formatted_address'],
        componentRestrictions: { country: 'ni' },
        bounds: managua,
        strictBounds: false,
      })
      autocomplete.addListener('place_changed', () => {
        const place = autocomplete.getPlace()
        if (!place.geometry?.location) return
        const c = { lat: place.geometry.location.lat(), lng: place.geometry.location.lng() }
        mapRef.current?.panTo(c)
        mapRef.current?.setZoom(16)
        placeMarker(google, c)
        onSelect(c, place.formatted_address || '')
      })

      mapRef.current.addListener('click', (e: google.maps.MapMouseEvent) => {
        if (!e.latLng) return
        const c = { lat: e.latLng.lat(), lng: e.latLng.lng() }
        placeMarker(google, c)
        geocoderRef.current?.geocode({ location: c }, (results, status) => {
          onSelect(c, status === 'OK' && results?.[0] ? results[0].formatted_address : '')
        })
      })
    })
    return () => { mounted = false }
  }, [])

  return (
    <div className="flex flex-col gap-2">
      <input
        ref={searchRef}
        type="text"
        placeholder="Buscar dirección…"
        className="w-full border border-gray-200 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-[#004aad]/30 focus:border-[#004aad]"
      />
      <div ref={containerRef} className="w-full rounded-xl overflow-hidden border border-gray-200" style={{ height: 220 }} />
      <p className="text-[11px] text-gray-400">Buscá una dirección o tocá el mapa para marcar. Podés arrastrar el pin.</p>
    </div>
  )
}

type PuntoRetiro = {
  key: string
  label: string
  nombre?: string
  celular?: string
  direccion?: string
  nota?: string
  coord?: LatLng | null
  tipoUbicacion?: 'referencial' | 'exacto'
}

type Comercio = {
  uid: string // = comercioId (Bloque A) — ID permanente del doc comercios/, nunca el Auth UID
  // from usuarios/{authUid}, solo si accesoEstado tiene un authUid vinculado
  email: string
  userName?: string
  activo?: boolean
  // identidad/acceso (Bloque A/B) — comercios/{comercioId}
  accesoEstado?: 'sin_acceso' | 'provisionando' | 'activo' | 'error_provision' | 'desactivado'
  authUid?: string | null
  // from comercios/{comercioId}
  name?: string
  phone?: string
  address?: string
  accounts?: BankAccount[]
  puntosRetiro?: Record<string, any>
  notaInterna?: string
  requiereBolso?: boolean
  tipoCliente?: 'contado' | 'credito'
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

  // Nota interna
  const [eNota, setENota] = useState('')
  const [savingNota, setSavingNota] = useState(false)
  const [notaMsg, setNotaMsg] = useState<string | null>(null)

  // Bolso
  const [eRequiereBolso, setERequiereBolso] = useState(false)
  const [savingBolso, setSavingBolso] = useState(false)
  const [bolsoMsg, setBolsoMsg] = useState<string | null>(null)

  // Tipo cliente
  const [eTipoCliente, setETipoCliente] = useState<'contado' | 'credito'>('contado')
  const [savingTipoCliente, setSavingTipoCliente] = useState(false)
  const [tipoClienteMsg, setTipoClienteMsg] = useState<string | null>(null)

  // Nuevo comercio modal
  const [showNew, setShowNew] = useState(false)
  const [ncNombre, setNcNombre] = useState('')
  const [ncTelefono, setNcTelefono] = useState('')
  const [ncEmail, setNcEmail] = useState('')
  const [ncDireccion, setNcDireccion] = useState('')
  const [ncError, setNcError] = useState('')
  const [ncLoading, setNcLoading] = useState(false)

  // Crear acceso (en drawer)
  const [caEmail, setCaEmail] = useState('')
  const [caPassword, setCaPassword] = useState('')
  const [caSaving, setCaSaving] = useState(false)
  const [caMsg, setCaMsg] = useState<string | null>(null)

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
  const [pCoord, setPCoord] = useState<LatLng | null>(null)
  const [pTipo, setPTipo] = useState<'referencial' | 'exacto'>('referencial')
  const [pShowMap, setPShowMap] = useState(false)

  // Identidad estable (Bloque A): comercios/ es la única fuente — un comercio
  // sin_acceso no tiene doc en usuarios/, así que ya no se puede depender de
  // ese join para listarlos. usuarios/{authUid} se cruza aparte, solo para
  // los que sí tienen acceso, únicamente para mostrar email/activo en vivo.
  useEffect(() => {
    const unsub = onSnapshot(collection(db, 'comercios'), async (snap) => {
      const comerciosDocs = snap.docs.map((d) => ({ uid: d.id, ...(d.data() as any) }))
      const authUids = [...new Set(comerciosDocs.filter((c) => c.authUid).map((c) => c.authUid as string))]
      const usuariosSnaps = await Promise.all(authUids.map((uid) => getDoc(doc(db, 'usuarios', uid))))
      const usuarioPorAuthUid = new Map(
        authUids.map((uid, i) => [uid, usuariosSnaps[i].exists() ? (usuariosSnaps[i].data() as any) : null])
      )
      const list: Comercio[] = comerciosDocs.map((c) => {
        const usuario = c.authUid ? usuarioPorAuthUid.get(c.authUid) : null
        return {
          uid: c.uid,
          email: usuario?.email || c.emailAcceso || c.emailContacto || '',
          userName: usuario?.name,
          activo: usuario?.activo,
          accesoEstado: c.accesoEstado ?? 'sin_acceso',
          authUid: c.authUid ?? null,
          name: c.name || usuario?.name || '',
          phone: c.phone || '',
          address: c.address || '',
          accounts: Array.isArray(c.accounts) ? c.accounts : [],
          puntosRetiro: c.puntosRetiro || {},
          notaInterna: c.notaInterna || '',
          requiereBolso: c.requiereBolso ?? false,
          tipoCliente: c.tipoCliente || 'contado',
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
      coord: raw?.coord || null,
      tipoUbicacion: raw?.tipoUbicacion,
    }))
    setEPuntos(puntos)
    setMsg(null)
    setENota(c.notaInterna || '')
    setNotaMsg(null)
    setERequiereBolso(c.requiereBolso ?? false)
    setBolsoMsg(null)
    setETipoCliente(c.tipoCliente || 'contado')
    setTipoClienteMsg(null)
    setCaEmail('')
    setCaPassword('')
    setCaMsg(null)
    setCaSaving(false)
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
      await Promise.all([
        upsertCompanyByUid(selected.uid, payload),
        updateDoc(doc(db, 'usuarios', selected.uid), {
          name: eName.trim(),
          phone: ePhone.trim(),
          updatedAt: serverTimestamp(),
        }),
      ])
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
    setPCoord(null); setPTipo('referencial'); setPShowMap(false)
    setPuntoError(''); setPuntoModal(true)
  }
  function openEditPunto(p: PuntoRetiro) {
    setEditingPuntoKey(p.key)
    setPLabel(p.label); setPNombre(p.nombre || ''); setPCelular(p.celular || '')
    setPDireccion(p.direccion || ''); setPNota(p.nota || '')
    setPCoord(p.coord || null); setPTipo(p.tipoUbicacion || 'referencial'); setPShowMap(!!p.coord)
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
        tipoUbicacion: pTipo,
        updatedAt: serverTimestamp(),
      }
      if (pCoord) payload.coord = pCoord
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
        coord: pCoord,
        tipoUbicacion: pTipo,
      }
      setEPuntos((prev) =>
        editingPuntoKey
          ? prev.map((p) => (p.key === editingPuntoKey ? updated : p))
          : [...prev, updated]
      )
      setComerciosList((prev) =>
        prev.map((c) => {
          if (c.uid !== selected!.uid) return c
          const puntosRetiro = {
            ...(c.puntosRetiro || {}),
            [key]: {
              label: pLabel.trim(),
              nombre: pNombre.trim() || pLabel.trim(),
              celular: pCelular.trim(),
              direccion: pDireccion.trim(),
              nota: pNota.trim() || null,
              tipoUbicacion: pTipo,
              ...(pCoord ? { coord: pCoord } : {}),
            },
          }
          return { ...c, puntosRetiro }
        })
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
        [`puntosRetiro.${key}`]: deleteField(),
        updatedAt: serverTimestamp(),
      })
      setEPuntos((prev) => prev.filter((p) => p.key !== key))
      setComerciosList((prev) =>
        prev.map((c) => {
          if (c.uid !== selected!.uid) return c
          const puntosRetiro = { ...(c.puntosRetiro || {}) }
          delete puntosRetiro[key]
          return { ...c, puntosRetiro }
        })
      )
    } catch (e) {
      console.error(e)
    }
  }

  async function saveRequiereBolso() {
    if (!selected) return
    setSavingBolso(true); setBolsoMsg(null)
    try {
      await setDoc(
        doc(db, 'comercios', selected.uid),
        { requiereBolso: eRequiereBolso, updatedAt: serverTimestamp() },
        { merge: true }
      )
      setComerciosList((prev) =>
        prev.map((c) => c.uid === selected.uid ? { ...c, requiereBolso: eRequiereBolso } : c)
      )
      setBolsoMsg('✅ Guardado')
    } catch {
      setBolsoMsg('❌ No se pudo guardar')
    } finally {
      setSavingBolso(false)
    }
  }

  async function saveTipoCliente() {
    if (!selected) return
    setSavingTipoCliente(true); setTipoClienteMsg(null)
    try {
      await setDoc(
        doc(db, 'comercios', selected.uid),
        { tipoCliente: eTipoCliente, updatedAt: serverTimestamp() },
        { merge: true }
      )
      setComerciosList((prev) =>
        prev.map((c) => c.uid === selected.uid ? { ...c, tipoCliente: eTipoCliente } : c)
      )
      setTipoClienteMsg('✅ Guardado')
    } catch {
      setTipoClienteMsg('❌ No se pudo guardar')
    } finally {
      setSavingTipoCliente(false)
    }
  }

  async function saveNota() {
    if (!selected) return
    setSavingNota(true); setNotaMsg(null)
    try {
      await setDoc(doc(db, 'comercios', selected.uid), { notaInterna: eNota.trim(), updatedAt: serverTimestamp() }, { merge: true })
      setComerciosList((prev) => prev.map((c) => c.uid === selected.uid ? { ...c, notaInterna: eNota.trim() } : c))
      setNotaMsg('✅ Nota guardada')
    } catch {
      setNotaMsg('❌ No se pudo guardar')
    } finally {
      setSavingNota(false)
    }
  }

  async function crearComercio() {
    if (!ncNombre.trim() || !ncTelefono.trim()) {
      setNcError('Nombre y teléfono son obligatorios')
      return
    }
    const telNorm = ncTelefono.replace(/\D/g, '')
    const nombreNorm = ncNombre.trim().toLowerCase()
    const dup = comercios.find((c) => {
      const cTel = (c.phone || '').replace(/\D/g, '')
      return (cTel && cTel === telNorm) || (c.name || '').toLowerCase() === nombreNorm
    })
    if (dup) { setNcError(`Ya existe: ${dup.name}`); return }

    setNcLoading(true)
    try {
      // comercioId permanente (Bloque A): un solo doc en comercios/, nunca en
      // usuarios/ — nadie puede loguearse todavía, así que no hace falta (ni
      // corresponde) crear un perfil de usuario en este momento. Ver
      // crearAccesoComercio (Cloud Function, Bloque B) para cuando se le dé
      // acceso real más adelante.
      const nuevoRef = doc(collection(db, 'comercios'))
      await setDoc(nuevoRef, {
        name: ncNombre.trim(),
        phone: ncTelefono.trim(),
        address: ncDireccion.trim() || null,
        // Contacto conocido al crear el comercio — distinto de emailAcceso
        // (que representa específicamente el correo de login, asignado
        // recién cuando se otorga acceso).
        emailContacto: ncEmail.trim() || null,
        accesoEstado: 'sin_acceso',
        authUid: null,
        creadoPorUid: auth.currentUser?.uid ?? '',
        creadoAt: serverTimestamp(),
        updatedAt: serverTimestamp(),
      })
      setShowNew(false)
      setNcNombre(''); setNcTelefono(''); setNcEmail(''); setNcDireccion(''); setNcError('')
    } catch {
      setNcError('Error al crear el comercio')
    } finally {
      setNcLoading(false)
    }
  }

  // comercioId es permanente (Bloque A) — otorgar acceso NUNCA crea un doc
  // nuevo ni migra nada. Toda la lógica sensible (validar rol, crear/
  // reutilizar el Auth user, escribir usuarios/comercios) vive server-side
  // en la Cloud Function crearAccesoComercio (functions/src/comercio-acceso.ts).
  // Este cliente solo la invoca y muestra el resultado.
  type ResultadoCrearAcceso = {
    ok: true
    comercioId: string
    authUid: string
    authUidAnterior: string | null
    esNuevoAuthUser: boolean
    esReemplazo: boolean
    esIdempotente: boolean
    recuperacionAdministrativa: boolean
    mensaje: string
    // Presente SOLO en el emulador (nunca en producción) — nunca se loguea.
    enlaceActivacionDev?: string
    // Presente fuera del emulador cuando la función no puede garantizar el
    // envío de correo — ver auditoría de app/api/send-welcome en el reporte.
    advertenciaEnvioCorreo?: string
  }

  async function crearAccesoComercio() {
    if (!selected) return
    if (!caEmail.trim()) { setCaMsg('❌ El correo es obligatorio'); return }
    setCaSaving(true); setCaMsg(null)
    try {
      // nombre NO se envía: la función toma exclusivamente comercios/{id}.name
      // como fuente autoritativa (ver functions/src/comercio-acceso.ts).
      const llamarCrearAcceso = httpsCallable<
        { comercioId: string; email: string; reemplazar?: boolean },
        ResultadoCrearAcceso
      >(functions, 'crearAccesoComercio')

      const resultado: HttpsCallableResult<ResultadoCrearAcceso> = await llamarCrearAcceso({
        comercioId: selected.uid,
        email: caEmail.trim(),
      })

      const { mensaje, enlaceActivacionDev, advertenciaEnvioCorreo, recuperacionAdministrativa } = resultado.data

      // TODO(Bloque C): esta lista todavía se carga vía usuarios (rol=Comercio)
      // cruzado con comercios — un comercio sin_acceso no aparece ahí, así que
      // quitarlo aquí de forma optimista sigue siendo el único remedio hasta
      // que Bloque C cambie la fuente de la lista a comercios directamente.
      setComerciosList((prev) => prev.filter((c) => c.uid !== selected.uid))

      // NOTA (auditoría Bloque B): /api/send-welcome genera su PROPIO enlace
      // internamente (adminAuth.generatePasswordResetLink) y no acepta uno
      // externo — pasarle enlaceActivacionDev no tendría ningún efecto, por
      // eso no se envía. Ese endpoint hoy no tiene autenticación propia
      // (hallazgo reportado por separado); seguimos llamándolo sin cambios
      // de comportamiento respecto a como ya funcionaba.
      fetch('/api/send-welcome', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          nombre: selected.name || selected.email,
          email: caEmail.trim(),
        }),
      }).catch(() => {})

      const notas = [
        recuperacionAdministrativa ? '(reanudado por otro gestor — recuperación administrativa registrada)' : '',
        advertenciaEnvioCorreo ? `⚠️ ${advertenciaEnvioCorreo}` : '',
      ].filter(Boolean).join(' ')

      if (enlaceActivacionDev) {
        // Solo emulador: se lo mostramos al gestor para poder probar el
        // flujo sin correo real. No cerramos el drawer para que pueda copiarlo.
        setCaMsg(`✅ ${mensaje} ${notas} — Enlace de prueba (solo emulador): ${enlaceActivacionDev}`)
      } else {
        setCaMsg(`✅ ${mensaje}${notas ? ' ' + notas : ''}`)
        closeDrawer()
      }
    } catch (e: any) {
      // httpsCallable rechaza con { code, message } (ej. 'already-exists',
      // 'permission-denied') — mostramos el mensaje que la función arma.
      setCaMsg(`❌ ${e?.message || 'Error al crear el acceso'}`)
    } finally {
      setCaSaving(false)
    }
  }

  const countPuntos = (c: Comercio) => Object.keys(c.puntosRetiro || {}).length

  return (
    <div className="flex flex-col gap-4">
      {/* Header */}
      <div>
        <h1 className="text-2xl font-black text-gray-900 tracking-tight">Comercios</h1>
        <p className="text-sm text-gray-500 mt-0.5">
          Gestioná los perfiles de todos los comercios registrados.
        </p>
      </div>

      {/* Search + New */}
      <div className="flex items-center gap-3 mb-4">
      <div className="relative flex-1 max-w-sm">
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
      <button onClick={() => setShowNew(true)} className={S.btnPrimary}>
        + Nuevo comercio
      </button>
      </div>

      {/* Table */}
      <div className="overflow-x-auto rounded-xl border border-gray-200 bg-white shadow-sm">
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
                <th className="text-left px-4 py-3 font-semibold text-gray-600 text-xs uppercase tracking-wide">UID</th>
                <th className="text-left px-4 py-3 font-semibold text-gray-600 text-xs uppercase tracking-wide">Email</th>
                <th className="text-left px-4 py-3 font-semibold text-gray-600 text-xs uppercase tracking-wide">Teléfono</th>
                <th className="text-left px-4 py-3 font-semibold text-gray-600 text-xs uppercase tracking-wide">Cuentas</th>
                <th className="text-left px-4 py-3 font-semibold text-gray-600 text-xs uppercase tracking-wide">Puntos</th>
                <th className="text-left px-4 py-3 font-semibold text-gray-600 text-xs uppercase tracking-wide">Pago</th>
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
                  <td className="px-4 py-3">
                    <span className="font-mono text-[11px] text-gray-500 select-all">{c.uid}</span>
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
                    <span className={`inline-flex items-center text-xs font-semibold px-2 py-0.5 rounded-full ${c.tipoCliente === 'credito' ? 'bg-purple-50 text-purple-700 border border-purple-200' : 'bg-gray-50 text-gray-600 border border-gray-200'}`}>
                      {c.tipoCliente === 'credito' ? '🗓 Crédito' : '💵 Contado'}
                    </span>
                  </td>
                  <td className="px-4 py-3">
                    {(() => {
                      const estado = c.accesoEstado ?? 'sin_acceso'
                      const activo = estado === 'activo'
                      const etiqueta: Record<string, string> = {
                        sin_acceso: 'Sin acceso',
                        provisionando: 'Otorgando…',
                        activo: 'Activo',
                        error_provision: 'Error acceso',
                        desactivado: 'Desactivado',
                      }
                      return (
                        <span className={`inline-flex items-center text-xs font-semibold px-2 py-0.5 rounded-full ${activo ? 'bg-green-50 text-green-700 border border-green-200' : 'bg-red-50 text-red-600 border border-red-200'}`}>
                          {etiqueta[estado] ?? estado}
                        </span>
                      )
                    })()}
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

              {/* ── Acceso al sistema (Bloque A: accesoEstado en comercios/{comercioId}) ── */}
              {(() => {
                const estado = selected.accesoEstado ?? 'sin_acceso'
                const activo = estado === 'activo'
                const etiquetaEstado: Record<string, string> = {
                  sin_acceso: 'Sin acceso',
                  provisionando: 'Otorgando acceso…',
                  activo: 'Con acceso',
                  error_provision: 'Error al otorgar acceso',
                  desactivado: 'Acceso desactivado',
                }
                return (
                  <section className={`rounded-xl border p-4 space-y-3 ${activo ? 'bg-green-50 border-green-200' : 'bg-amber-50 border-amber-200'}`}>
                    <div className="flex items-center gap-2">
                      <Lock className={`h-4 w-4 ${activo ? 'text-green-600' : 'text-amber-600'}`} />
                      <h3 className={`text-xs font-bold uppercase tracking-wide ${activo ? 'text-green-700' : 'text-amber-700'}`}>
                        Acceso al sistema
                      </h3>
                      <span className={`ml-auto text-[10px] font-bold px-2 py-0.5 rounded-full border ${activo ? 'bg-green-100 text-green-700 border-green-300' : 'bg-amber-100 text-amber-700 border-amber-300'}`}>
                        {etiquetaEstado[estado] ?? estado}
                      </span>
                    </div>

                    {!activo ? (
                      <>
                        <p className="text-xs text-amber-700">
                          {estado === 'error_provision'
                            ? 'El intento anterior de otorgar acceso no se completó. Podés reintentar con el mismo correo o uno distinto.'
                            : 'Este comercio no tiene cuenta activa. Ingresá su correo y le enviaremos un link para que cree su contraseña.'}
                        </p>
                        <div className="space-y-2">
                          <div>
                            <label className={S.label}>Correo <span className="text-red-500">*</span></label>
                            <input type="email" value={caEmail} onChange={(e) => setCaEmail(e.target.value)} placeholder="correo@ejemplo.com" className={S.input} />
                          </div>
                        </div>
                        <div className="flex items-center gap-3">
                          <button
                            onClick={crearAccesoComercio}
                            disabled={caSaving}
                            className="text-xs font-semibold px-3 py-1.5 rounded-lg bg-amber-500 text-white hover:bg-amber-600 transition disabled:opacity-40"
                          >
                            {caSaving ? 'Creando acceso…' : 'Crear acceso'}
                          </button>
                          {caMsg && (
                            <span className={`text-xs font-semibold ${caMsg.startsWith('✅') ? 'text-green-600' : 'text-red-600'}`}>{caMsg}</span>
                          )}
                        </div>
                      </>
                    ) : (
                      <p className="text-xs text-green-700">
                        Acceso activo · <span className="font-semibold">{selected.email}</span>
                      </p>
                    )}
                  </section>
                )
              })()}

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

              {/* ── Nota interna ── */}
              <section className="bg-yellow-50 border border-yellow-200 rounded-xl p-4">
                <div className="flex items-center gap-2 mb-3">
                  <Lock className="h-4 w-4 text-yellow-600" />
                  <h3 className="text-sm font-bold text-yellow-800 uppercase tracking-wide">Nota interna</h3>
                  <span className="text-[10px] font-semibold text-yellow-600 bg-yellow-100 border border-yellow-300 px-2 py-0.5 rounded-full ml-auto">Solo gestores</span>
                </div>
                <textarea
                  value={eNota}
                  onChange={(e) => setENota(e.target.value)}
                  placeholder="Ej: Cliente paga siempre tarde los viernes. Preferir efectivo. Contactar a María."
                  rows={3}
                  className="w-full border border-yellow-300 bg-white rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-yellow-400/40 resize-none"
                />
                <div className="flex items-center gap-3 mt-2">
                  <button
                    onClick={saveNota}
                    disabled={savingNota}
                    className="text-xs font-semibold px-3 py-1.5 rounded-lg bg-yellow-500 text-white hover:bg-yellow-600 transition disabled:opacity-40"
                  >
                    {savingNota ? 'Guardando…' : 'Guardar nota'}
                  </button>
                  {notaMsg && (
                    <span className={`text-xs font-semibold ${notaMsg.startsWith('✅') ? 'text-green-600' : 'text-red-600'}`}>
                      {notaMsg}
                    </span>
                  )}
                </div>
              </section>

              {/* ── Configuración de bolso ── */}
              <section className="bg-blue-50 border border-blue-200 rounded-xl p-4 space-y-3">
                <h3 className="text-xs font-bold text-blue-700 uppercase tracking-wide">Configuración de bolso</h3>
                <button
                  onClick={() => setERequiereBolso(!eRequiereBolso)}
                  className={`w-full flex items-center justify-between px-4 py-3 rounded-xl border transition ${
                    eRequiereBolso ? 'bg-blue-100 border-blue-300' : 'bg-white border-blue-200'
                  }`}
                >
                  <div className="text-left">
                    <p className={`text-sm font-bold ${eRequiereBolso ? 'text-blue-700' : 'text-gray-500'}`}>
                      {eRequiereBolso ? 'Requiere bolso térmico' : 'No requiere bolso térmico'}
                    </p>
                    <p className="text-xs text-gray-400 mt-0.5">
                      {eRequiereBolso
                        ? 'Se penalizan motorizados sin bolso en órdenes de este comercio.'
                        : 'Cualquier motorizado aplica sin penalización.'}
                    </p>
                  </div>
                  <div className={`w-11 h-6 rounded-full transition-colors relative shrink-0 ${eRequiereBolso ? 'bg-blue-500' : 'bg-gray-300'}`}>
                    <div className={`absolute top-0.5 w-5 h-5 bg-white rounded-full shadow transition-transform ${eRequiereBolso ? 'translate-x-5' : 'translate-x-0.5'}`} />
                  </div>
                </button>
                <div className="flex items-center gap-3">
                  <button
                    onClick={saveRequiereBolso}
                    disabled={savingBolso}
                    className="text-xs font-semibold px-3 py-1.5 rounded-lg bg-blue-500 text-white hover:bg-blue-600 transition disabled:opacity-40"
                  >
                    {savingBolso ? 'Guardando…' : 'Guardar configuración'}
                  </button>
                  {bolsoMsg && (
                    <span className={`text-xs font-semibold ${bolsoMsg.startsWith('✅') ? 'text-green-600' : 'text-red-600'}`}>
                      {bolsoMsg}
                    </span>
                  )}
                </div>
              </section>

              {/* ── Tipo de cliente ── */}
              <section className="bg-purple-50 border border-purple-200 rounded-xl p-4 space-y-3">
                <h3 className="text-xs font-bold text-purple-700 uppercase tracking-wide">Tipo de cliente</h3>
                <p className="text-xs text-purple-600">Define cómo se cobra el delivery en todas las órdenes de este comercio.</p>
                <div className="flex gap-2">
                  {(['contado', 'credito'] as const).map((t) => (
                    <button
                      key={t}
                      type="button"
                      onClick={() => setETipoCliente(t)}
                      className={`flex-1 py-2.5 rounded-xl text-sm font-bold border transition ${
                        eTipoCliente === t
                          ? t === 'credito'
                            ? 'bg-purple-600 border-purple-600 text-white'
                            : 'bg-gray-700 border-gray-700 text-white'
                          : 'bg-white border-gray-200 text-gray-500'
                      }`}
                    >
                      {t === 'contado' ? '💵 Contado' : '🗓 Crédito semanal'}
                    </button>
                  ))}
                </div>
                <div className="flex items-center gap-3">
                  <button
                    onClick={saveTipoCliente}
                    disabled={savingTipoCliente}
                    className="text-xs font-semibold px-3 py-1.5 rounded-lg bg-purple-600 text-white hover:bg-purple-700 transition disabled:opacity-40"
                  >
                    {savingTipoCliente ? 'Guardando…' : 'Guardar tipo'}
                  </button>
                  {tipoClienteMsg && (
                    <span className={`text-xs font-semibold ${tipoClienteMsg.startsWith('✅') ? 'text-green-600' : 'text-red-600'}`}>
                      {tipoClienteMsg}
                    </span>
                  )}
                </div>
              </section>

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
                          {p.coord && <p className="text-[11px] text-green-600 font-semibold mt-1">🎯 Ubicación guardada en mapa</p>}
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

      {/* Nuevo comercio modal */}
      {showNew && (
        <div
          className="fixed inset-0 z-[70] bg-black/50 flex items-center justify-center p-4"
          onClick={(e) => { if (e.target === e.currentTarget) { setShowNew(false); setNcError('') } }}
        >
          <div className="w-full max-w-md bg-white rounded-2xl border border-gray-200 shadow-2xl p-5">
            <div className="flex items-center justify-between mb-4">
              <h3 className="text-base font-black text-gray-900">Nuevo comercio</h3>
              <button onClick={() => { setShowNew(false); setNcError('') }} className="w-8 h-8 grid place-items-center rounded-full border border-gray-200 hover:bg-gray-50">
                <X className="h-4 w-4 text-gray-500" />
              </button>
            </div>
            <div className="space-y-3">
              <div>
                <label className={S.label}>Nombre / empresa <span className="text-red-500">*</span></label>
                <input value={ncNombre} onChange={(e) => setNcNombre(e.target.value)} placeholder="Ej: Box It Up" className={S.input} autoFocus />
              </div>
              <div>
                <label className={S.label}>Teléfono <span className="text-red-500">*</span></label>
                <input value={ncTelefono} onChange={(e) => setNcTelefono(e.target.value)} placeholder="8888-8888" className={S.input} />
              </div>
              <div>
                <label className={S.label}>Correo <span className="text-gray-400 normal-case font-normal">(opcional)</span></label>
                <input value={ncEmail} onChange={(e) => setNcEmail(e.target.value)} placeholder="correo@ejemplo.com" className={S.input} />
              </div>
              <div>
                <label className={S.label}>Dirección <span className="text-gray-400 normal-case font-normal">(opcional)</span></label>
                <input value={ncDireccion} onChange={(e) => setNcDireccion(e.target.value)} placeholder="Del semáforo 1c al norte…" className={S.input} />
              </div>
              {ncError && (
                <div className="bg-red-50 border border-red-200 rounded-lg px-3 py-2 text-sm text-red-600 font-semibold">
                  {ncError}
                </div>
              )}
              <div className="flex justify-end gap-2 pt-2">
                <button onClick={() => { setShowNew(false); setNcError('') }} className={S.btnOutline}>Cancelar</button>
                <button onClick={crearComercio} disabled={ncLoading} className={S.btnPrimary}>
                  {ncLoading ? 'Creando…' : 'Crear comercio'}
                </button>
              </div>
            </div>
          </div>
        </div>
      )}

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

              {/* Tipo de ubicación */}
              <div>
                <p className="text-xs text-gray-500 mb-2">¿Qué tan exacta es la ubicación?</p>
                <div className="flex gap-2">
                  {(['referencial', 'exacto'] as const).map(t => (
                    <button key={t} type="button" onClick={() => setPTipo(t)}
                      className={`px-3 py-1.5 rounded-lg text-xs font-semibold border transition ${pTipo === t ? 'bg-[#004aad] text-white border-[#004aad]' : 'bg-white text-gray-600 border-gray-200'}`}>
                      {t === 'referencial' ? '📍 Referencial' : '🎯 Exacto'}
                    </button>
                  ))}
                </div>
              </div>

              {/* Mapa */}
              <div>
                <div className="flex items-center justify-between mb-2">
                  <label className={S.label}>Ubicación en el mapa</label>
                  <button type="button" onClick={() => setPShowMap(!pShowMap)} className={`${S.btnOutline} text-xs py-1.5 px-3`}>
                    {pShowMap ? 'Ocultar mapa' : pCoord ? '✏️ Cambiar en mapa' : '+ Marcar en mapa'}
                  </button>
                </div>
                {pCoord && !pShowMap && (
                  <p className="text-xs text-green-600 font-semibold">🎯 Ubicación marcada: {pCoord.lat.toFixed(5)}, {pCoord.lng.toFixed(5)}</p>
                )}
                {pShowMap && (
                  <MapPicker coord={pCoord} onSelect={(c, addr) => { setPCoord(c); if (addr && !pDireccion) setPDireccion(addr) }} />
                )}
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
