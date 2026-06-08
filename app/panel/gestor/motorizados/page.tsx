'use client'

import React, { useEffect, useRef, useState } from 'react'
import {
  collection,
  onSnapshot,
  doc,
  addDoc,
  updateDoc,
  setDoc,
  query,
  where,
  orderBy,
  limit,
  getCountFromServer,
  getDocs,
  serverTimestamp,
  Timestamp,
} from 'firebase/firestore'
import { db } from '@/fb/config'
import { compressImage, uploadFotoMotorizado } from '@/fb/storage'
import { getMapsLoader } from '@/lib/googleMaps'
import { getZonasActivas } from '@/fb/zonas'
import { clasificarPuntoEnZona } from '@/lib/zonas'
import type { ZonaGeografica } from '@/lib/zonas'
import { X, Bike, Plus, TrendingUp, AlertCircle, MapPin, KeyRound } from 'lucide-react'
import { createAuthUser } from '@/fb/createAuthUser'

// ─── Types ────────────────────────────────────────────────────────────────────

type EstadoMoto = 'disponible' | 'ocupado'

type Motorizado = {
  id: string
  nombre: string
  telefono?: string
  estado?: EstadoMoto
  activo?: boolean
  authUid?: string
  createdAt?: any
  tieneBolso?: boolean
  // Métricas de desempeño (persistidas por motorizado-stats.ts)
  totalAsignaciones?: number
  totalAceptadas?: number
  totalRechazos?: number
  tasaAceptacion?: number
  tiempoPromedioAceptacion?: number
  ultimaUbicacionOperativa?: { lat: number; lng: number; timestamp?: any }
  scoreDesempeño?: number
  ubicacionBase?: { lat: number; lng: number } | null
  direccionBase?: string | null
  zonaBaseId?: string | null
  zonaBaseNombre?: string | null
  macroZonaBaseId?: string | null
  macroZonaBaseNombre?: string | null
  fotoUrl?: string | null
}

type Stats = {
  total: number
  hoy: number
  semana: number
  tasaAceptacion: number | null  // 0-100, null si sin datos
  rechazos: number
  ultimosRechazos: { id: string; fecha?: Timestamp }[]
  depositosPendientes: number
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

const estadoConfig = {
  disponible: { label: 'Disponible', cls: 'bg-green-50 text-green-700 border-green-200' },
  ocupado:    { label: 'Ocupado',    cls: 'bg-yellow-50 text-yellow-700 border-yellow-200' },
}

async function fetchStats(motorizadoId: string): Promise<Stats> {
  const col = collection(db, 'solicitudes_envio')
  const hoyStart = new Date(); hoyStart.setHours(0, 0, 0, 0)
  const semanaStart = new Date(); semanaStart.setDate(semanaStart.getDate() - semanaStart.getDay() + (semanaStart.getDay() === 0 ? -6 : 1)); semanaStart.setHours(0, 0, 0, 0)

  const [totalSnap, hoySnap, semanaSnap, aceptadasSnap, rechazadasSnap, depositosSnap] = await Promise.all([
    getCountFromServer(query(col, where('asignacion.motorizadoId', '==', motorizadoId), where('estado', '==', 'entregado'))),
    getCountFromServer(query(col, where('asignacion.motorizadoId', '==', motorizadoId), where('estado', '==', 'entregado'), where('entregadoAt', '>=', hoyStart))),
    getCountFromServer(query(col, where('asignacion.motorizadoId', '==', motorizadoId), where('estado', '==', 'entregado'), where('entregadoAt', '>=', semanaStart))),
    getCountFromServer(query(col, where('asignacion.motorizadoId', '==', motorizadoId), where('asignacion.estadoAceptacion', '==', 'aceptada'))),
    getDocs(query(col, where('asignacion.motorizadoId', '==', motorizadoId), where('asignacion.estadoAceptacion', '==', 'rechazada'), orderBy('updatedAt', 'desc'), limit(3))),
    getDocs(query(col, where('asignacion.motorizadoId', '==', motorizadoId), where('estado', '==', 'entregado'))),
  ])

  const aceptadas = aceptadasSnap.data().count
  const rechazadas = rechazadasSnap.size
  const tasaAceptacion = (aceptadas + rechazadas) > 0
    ? Math.round((aceptadas / (aceptadas + rechazadas)) * 100)
    : null

  const ultimosRechazos = rechazadasSnap.docs.map((d) => ({
    id: d.id,
    fecha: (d.data() as any).updatedAt as Timestamp | undefined,
  }))

  // Depósitos pendientes: órdenes sin confirmar que requieren depósito
  let depositosPendientes = 0
  depositosSnap.docs.forEach((d) => {
    const data = d.data() as any
    const dep = data?.registro?.deposito
    if (dep?.storkhubDepositoId || dep?.comercioDepositoId) return
    const ceAplica = !!data?.cobroContraEntrega?.aplica
    const quienPaga = data?.pagoDelivery?.quienPaga || ''
    const esCredito = data?.tipoCliente === 'credito' || quienPaga === 'credito_semanal'
    const esTransferencia = quienPaga === 'transferencia'
    const precio = data?.confirmacion?.precioFinalCordobas || 0
    const needsStorkhub = !esTransferencia && !esCredito && precio > 0
    const needsComercio = ceAplica && (data?.cobroContraEntrega?.monto || 0) > 0
    if (!needsStorkhub && !needsComercio) return
    const storkhubOk = !needsStorkhub || !!dep?.confirmadoStorkhub
    const comercioOk = !needsComercio || !!dep?.confirmadoComercio
    if (!storkhubOk || !comercioOk) depositosPendientes++
  })

  return {
    total: totalSnap.data().count,
    hoy: hoySnap.data().count,
    semana: semanaSnap.data().count,
    tasaAceptacion,
    rechazos: rechazadas,
    ultimosRechazos,
    depositosPendientes,
  }
}

// ─── Main ─────────────────────────────────────────────────────────────────────

export default function MotorizadosPage() {
  const [motorizados, setMotorizados] = useState<Motorizado[]>([])
  const [loading, setLoading] = useState(true)

  // Drawer
  const [selected, setSelected] = useState<Motorizado | null>(null)
  const [drawerOpen, setDrawerOpen] = useState(false)
  const [isNew, setIsNew] = useState(false)

  // Edit fields
  const [eName, setEName] = useState('')
  const [ePhone, setEPhone] = useState('')
  const [eAuthUid, setEAuthUid] = useState('')
  const [eActivo, setEActivo] = useState(true)
  const [eEstado, setEEstado] = useState<EstadoMoto>('disponible')
  const [eTieneBolso, setETieneBolso] = useState(false)
  const [saving, setSaving] = useState(false)
  const [msg, setMsg] = useState<string | null>(null)

  // Foto de perfil
  const [ePhotoFile, setEPhotoFile] = useState<File | null>(null)
  const [ePhotoPreview, setEPhotoPreview] = useState<string | null>(null)
  const [ePhotoRemoved, setEPhotoRemoved] = useState(false)

  // Crear acceso Auth (en drawer, cualquier motorizado)
  const [caEmail, setCaEmail] = useState('')
  const [caPassword, setCaPassword] = useState('')
  const [caSaving, setCaSaving] = useState(false)
  const [caMsg, setCaMsg] = useState<string | null>(null)

  // Ubicación base
  const [eUbicacionBase,        setEUbicacionBase]        = useState<{ lat: number; lng: number } | null>(null)
  const [eDireccionBase,        setEDireccionBase]        = useState<string | null>(null)
  const [eZonaBaseId,           setEZonaBaseId]           = useState<string | null>(null)
  const [eZonaBaseNombre,       setEZonaBaseNombre]       = useState<string | null>(null)
  const [eMacroZonaBaseId,      setEMacroZonaBaseId]      = useState<string | null>(null)
  const [eMacroZonaBaseNombre,  setEMacroZonaBaseNombre]  = useState<string | null>(null)
  const [zonasActivas,          setZonasActivas]          = useState<ZonaGeografica[]>([])
  const [warningFueraDeMacrozona, setWarningFueraDeMacrozona] = useState(false)

  // Photo ref
  const photoInputRef = useRef<HTMLInputElement | null>(null)

  // Map refs
  const mapContainerRef      = useRef<HTMLDivElement | null>(null)
  const gMapRef              = useRef<google.maps.Map | null>(null)
  const markerRef            = useRef<google.maps.Marker | null>(null)
  const autocompleteInputRef = useRef<HTMLInputElement | null>(null)
  const zonasActivasRef      = useRef<ZonaGeografica[]>([])

  // Stats in drawer
  const [stats, setStats] = useState<Stats | null>(null)
  const [loadingStats, setLoadingStats] = useState(false)

  // Real-time listener
  useEffect(() => {
    const unsub = onSnapshot(collection(db, 'motorizado'), (snap) => {
      const list: Motorizado[] = snap.docs.map((d) => ({ id: d.id, ...(d.data() as any) }))
      list.sort((a, b) => (a.nombre || '').localeCompare(b.nombre || ''))
      setMotorizados(list)
      setLoading(false)
    })
    return () => unsub()
  }, [])

  // Mantener ref de zonas en sync para evitar stale closures en listeners de mapa
  useEffect(() => { zonasActivasRef.current = zonasActivas }, [zonasActivas])

  // Inicializar mapa de ubicación base al abrir el drawer
  useEffect(() => {
    if (!drawerOpen) return

    // Cargar zonas una vez por sesión
    if (zonasActivasRef.current.length === 0) {
      getZonasActivas().then((zs) => {
        setZonasActivas(zs)
        zonasActivasRef.current = zs
      })
    }

    // Si el mapa ya existe, solo reposicionar
    if (gMapRef.current) {
      const center = eUbicacionBase ?? { lat: 12.1364, lng: -86.2514 }
      gMapRef.current.setCenter(center)
      gMapRef.current.setZoom(eUbicacionBase ? 15 : 13)
      markerRef.current?.setPosition(center)
      markerRef.current?.setVisible(!!eUbicacionBase)
      if (autocompleteInputRef.current) {
        autocompleteInputRef.current.value = eDireccionBase ?? ''
      }
      return
    }

    // Primera apertura: crear el mapa
    getMapsLoader().load().then(() => {
      if (!mapContainerRef.current || gMapRef.current) return

      const center = eUbicacionBase ?? { lat: 12.1364, lng: -86.2514 }

      const map = new google.maps.Map(mapContainerRef.current, {
        center,
        zoom: eUbicacionBase ? 15 : 13,
        mapTypeControl: false,
        streetViewControl: false,
        fullscreenControl: false,
        clickableIcons: false,
      })
      gMapRef.current = map

      const marker = new google.maps.Marker({
        position: center,
        map,
        draggable: true,
        visible: !!eUbicacionBase,
      })
      markerRef.current = marker

      function geocodeYClasificar(coord: { lat: number; lng: number }) {
        const geocoder = new google.maps.Geocoder()
        geocoder.geocode({ location: coord }, (results, status) => {
          const address =
            status === 'OK' && results?.[0]
              ? results[0].formatted_address
              : `${coord.lat.toFixed(5)}, ${coord.lng.toFixed(5)}`
          if (autocompleteInputRef.current) autocompleteInputRef.current.value = address
          const zona      = clasificarPuntoEnZona(coord, zonasActivasRef.current, 'zona')
          const macroZona = clasificarPuntoEnZona(coord, zonasActivasRef.current, 'macrozona')
          setEUbicacionBase(coord)
          setEDireccionBase(address)
          setEZonaBaseId(zona?.id ?? null)
          setEZonaBaseNombre(zona?.nombre ?? null)
          setEMacroZonaBaseId(macroZona?.id ?? null)
          setEMacroZonaBaseNombre(macroZona?.nombre ?? null)
          setWarningFueraDeMacrozona(!macroZona)
        })
      }

      marker.addListener('dragend', () => {
        const pos = marker.getPosition()
        if (!pos) return
        geocodeYClasificar({ lat: pos.lat(), lng: pos.lng() })
      })

      map.addListener('click', (e: google.maps.MapMouseEvent) => {
        if (!e.latLng) return
        const coord = { lat: e.latLng.lat(), lng: e.latLng.lng() }
        marker.setPosition(coord)
        marker.setVisible(true)
        geocodeYClasificar(coord)
      })

      if (autocompleteInputRef.current) {
        const ac = new google.maps.places.Autocomplete(autocompleteInputRef.current, {
          fields: ['geometry', 'formatted_address'],
          componentRestrictions: { country: 'ni' },
        })
        ac.addListener('place_changed', () => {
          const place = ac.getPlace()
          if (!place.geometry?.location) return
          const coord = { lat: place.geometry.location.lat(), lng: place.geometry.location.lng() }
          map.setCenter(coord)
          map.setZoom(16)
          marker.setPosition(coord)
          marker.setVisible(true)
          const address = place.formatted_address ?? autocompleteInputRef.current?.value ?? ''
          const zona      = clasificarPuntoEnZona(coord, zonasActivasRef.current, 'zona')
          const macroZona = clasificarPuntoEnZona(coord, zonasActivasRef.current, 'macrozona')
          setEUbicacionBase(coord)
          setEDireccionBase(address)
          setEZonaBaseId(zona?.id ?? null)
          setEZonaBaseNombre(zona?.nombre ?? null)
          setEMacroZonaBaseId(macroZona?.id ?? null)
          setEMacroZonaBaseNombre(macroZona?.nombre ?? null)
          setWarningFueraDeMacrozona(!macroZona)
        })
      }
    })
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [drawerOpen])

  // Summary counts
  const totalCount = motorizados.length
  const disponibles = motorizados.filter((m) => m.activo !== false && m.estado === 'disponible').length
  const ocupados = motorizados.filter((m) => m.activo !== false && m.estado === 'ocupado').length
  const inactivos = motorizados.filter((m) => m.activo === false).length

  async function crearAccesoMotorizado() {
    if (!selected) return
    if (!caEmail.trim()) { setCaMsg('❌ El correo es obligatorio'); return }
    if (caPassword.length < 6) { setCaMsg('❌ Mínimo 6 caracteres'); return }
    setCaSaving(true); setCaMsg(null)
    try {
      const authUid = await createAuthUser(caEmail.trim(), caPassword)
      await setDoc(doc(db, 'usuarios', authUid), {
        name: selected.nombre,
        email: caEmail.trim(),
        rol: 'motorizado',
        activo: selected.activo !== false,
        creadoPorGestor: true,
        createdAt: serverTimestamp(),
        updatedAt: serverTimestamp(),
      })
      await updateDoc(doc(db, 'motorizado', selected.id), {
        authUid,
      })
      setSelected((prev) => prev ? { ...prev, authUid } : prev)
      setEAuthUid(authUid)
      setCaMsg('✅ Acceso creado')
      setCaEmail(''); setCaPassword('')
    } catch (e: any) {
      const code = e?.code
      if (code === 'auth/email-already-in-use') setCaMsg('❌ Ese correo ya está registrado')
      else setCaMsg('❌ Error al crear el acceso')
    } finally {
      setCaSaving(false)
    }
  }

  function handlePhotoChange(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0]
    if (!file) return
    if (!file.type.startsWith('image/')) { setMsg('❌ Solo se permiten imágenes.'); return }
    if (file.size > 10 * 1024 * 1024) { setMsg('❌ La imagen no debe superar 10 MB.'); return }
    setEPhotoFile(file)
    setEPhotoRemoved(false)
    const reader = new FileReader()
    reader.onloadend = () => setEPhotoPreview(reader.result as string)
    reader.readAsDataURL(file)
  }

  function openEdit(m: Motorizado) {
    setIsNew(false)
    setSelected(m)
    setEName(m.nombre || '')
    setEPhone(m.telefono || '')
    setEAuthUid(m.authUid || '')
    setEActivo(m.activo !== false)
    setEEstado(m.estado || 'disponible')
    setETieneBolso(m.tieneBolso ?? false)
    setEUbicacionBase(m.ubicacionBase ?? null)
    setEDireccionBase(m.direccionBase ?? null)
    setEZonaBaseId(m.zonaBaseId ?? null)
    setEZonaBaseNombre(m.zonaBaseNombre ?? null)
    setEMacroZonaBaseId(m.macroZonaBaseId ?? null)
    setEMacroZonaBaseNombre(m.macroZonaBaseNombre ?? null)
    setWarningFueraDeMacrozona(false)
    if (gMapRef.current && autocompleteInputRef.current) {
      autocompleteInputRef.current.value = m.direccionBase ?? ''
    }
    setEPhotoFile(null)
    setEPhotoPreview(m.fotoUrl ?? null)
    setEPhotoRemoved(false)
    setMsg(null)
    setStats(null)
    setCaEmail('')
    setCaPassword('')
    setCaMsg(null)
    setDrawerOpen(true)
    // Load stats
    setLoadingStats(true)
    fetchStats(m.id).then((s) => { setStats(s); setLoadingStats(false) }).catch(() => setLoadingStats(false))
  }

  function openNew() {
    setIsNew(true)
    setSelected(null)
    setEName('')
    setEPhone('')
    setEAuthUid('')
    setEActivo(true)
    setEEstado('disponible')
    setETieneBolso(false)
    setEUbicacionBase(null)
    setEDireccionBase(null)
    setEZonaBaseId(null)
    setEZonaBaseNombre(null)
    setEMacroZonaBaseId(null)
    setEMacroZonaBaseNombre(null)
    setWarningFueraDeMacrozona(false)
    if (autocompleteInputRef.current) autocompleteInputRef.current.value = ''
    setEPhotoFile(null)
    setEPhotoPreview(null)
    setEPhotoRemoved(false)
    setMsg(null)
    setStats(null)
    setCaEmail('')
    setCaPassword('')
    setCaMsg(null)
    setDrawerOpen(true)
  }

  function closeDrawer() {
    setDrawerOpen(false)
    setTimeout(() => { setSelected(null); setIsNew(false) }, 300)
  }

  async function save() {
    if (!eName.trim()) { setMsg('❌ El nombre es obligatorio.'); return }
    setSaving(true); setMsg(null)
    try {
      const ubicacionBasePayload = {
        ubicacionBase:        eUbicacionBase        ?? null,
        direccionBase:        eDireccionBase        ?? null,
        zonaBaseId:           eZonaBaseId           ?? null,
        zonaBaseNombre:       eZonaBaseNombre       ?? null,
        macroZonaBaseId:      eMacroZonaBaseId      ?? null,
        macroZonaBaseNombre:  eMacroZonaBaseNombre  ?? null,
      }
      if (isNew) {
        const docRef = await addDoc(collection(db, 'motorizado'), {
          nombre: eName.trim(),
          telefono: ePhone.trim(),
          estado: eEstado,
          activo: eActivo,
          authUid: eAuthUid.trim() || null,
          tieneBolso: eTieneBolso,
          fotoUrl: null,
          createdAt: serverTimestamp(),
          ...ubicacionBasePayload,
        })
        if (ePhotoFile) {
          const blob = await compressImage(ePhotoFile)
          const { url } = await uploadFotoMotorizado(docRef.id, blob)
          await updateDoc(docRef, { fotoUrl: url })
          setEPhotoPreview(url)
          setEPhotoFile(null)
        }
        setMsg('✅ Motorizado creado')
        setIsNew(false)
      } else if (selected) {
        let fotoUrl: string | null = selected.fotoUrl ?? null
        if (ePhotoFile) {
          const blob = await compressImage(ePhotoFile)
          const { url } = await uploadFotoMotorizado(selected.id, blob)
          fotoUrl = url
          setEPhotoPreview(url)
          setEPhotoFile(null)
        } else if (ePhotoRemoved) {
          fotoUrl = null
        }
        await updateDoc(doc(db, 'motorizado', selected.id), {
          nombre: eName.trim(),
          telefono: ePhone.trim(),
          estado: eEstado,
          activo: eActivo,
          authUid: eAuthUid.trim() || null,
          tieneBolso: eTieneBolso,
          fotoUrl,
          ...ubicacionBasePayload,
        })
        setMsg('✅ Guardado')
      }
    } catch (e: any) {
      setMsg(`❌ Error: ${e?.message || 'No se pudo guardar'}`)
    } finally {
      setSaving(false)
    }
  }

  const S = {
    input: 'w-full border border-gray-200 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-[#004aad]/30 focus:border-[#004aad]',
    label: 'block text-xs font-semibold text-gray-500 mb-1 uppercase tracking-wide',
    btnPrimary: 'bg-[#004aad] text-white text-sm font-semibold px-4 py-2 rounded-lg hover:bg-[#003a8c] transition',
  }

  return (
    <div className="flex flex-col gap-4">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-black text-gray-900 tracking-tight">Motorizados</h1>
          <p className="text-sm text-gray-500 mt-0.5">Gestioná el equipo de entrega en tiempo real.</p>
        </div>
        <button onClick={openNew} className="flex items-center gap-2 bg-[#004aad] text-white text-sm font-semibold px-4 py-2 rounded-xl hover:bg-[#003a8c] transition">
          <Plus className="h-4 w-4" />
          Nuevo motorizado
        </button>
      </div>

      {/* Stats */}
      <div className="grid grid-cols-4 gap-3">
        {[
          { label: 'Total', value: totalCount, color: 'text-gray-900', bg: 'bg-white' },
          { label: 'Disponibles', value: disponibles, color: 'text-green-700', bg: 'bg-green-50' },
          { label: 'Ocupados', value: ocupados, color: 'text-yellow-700', bg: 'bg-yellow-50' },
          { label: 'Inactivos', value: inactivos, color: 'text-red-600', bg: 'bg-red-50' },
        ].map((s) => (
          <div key={s.label} className={`${s.bg} rounded-xl border border-gray-200 px-4 py-3`}>
            <p className={`text-2xl font-black ${s.color}`}>{s.value}</p>
            <p className="text-xs font-semibold text-gray-500 mt-0.5">{s.label}</p>
          </div>
        ))}
      </div>

      {/* Table */}
      <div className="overflow-x-auto rounded-xl border border-gray-200 bg-white shadow-sm">
        {loading ? (
          <div className="py-20 text-center text-sm text-gray-400">Cargando motorizados…</div>
        ) : motorizados.length === 0 ? (
          <div className="flex flex-col items-center justify-center py-20 gap-2 text-gray-400">
            <Bike className="h-10 w-10 opacity-30" />
            <p className="text-sm font-medium">No hay motorizados registrados</p>
          </div>
        ) : (
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b bg-gray-50 text-left text-[11px] font-semibold uppercase tracking-wide text-gray-500">
                <th className="px-4 py-3">Motorizado</th>
                <th className="px-4 py-3">Teléfono</th>
                <th className="px-4 py-3">Estado</th>
                <th className="px-4 py-3">Activo</th>
                <th className="px-4 py-3">Zona base</th>
                <th className="px-4 py-3" />
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-100">
              {motorizados.map((m) => {
                const activo = m.activo !== false
                const cfg = estadoConfig[m.estado || 'disponible'] || estadoConfig.disponible
                return (
                  <tr key={m.id} className="hover:bg-gray-50 transition-colors">
                    <td className="px-4 py-3">
                      <div className="flex items-center gap-3">
                        <div className="w-9 h-9 rounded-full bg-[#004aad]/10 grid place-items-center flex-shrink-0 overflow-hidden border border-gray-200">
                          {m.fotoUrl ? (
                            // eslint-disable-next-line @next/next/no-img-element
                            <img src={m.fotoUrl} alt={m.nombre} className="w-full h-full object-cover" />
                          ) : (
                            <span className="text-sm font-black text-[#004aad]">
                              {(m.nombre || '?')[0].toUpperCase()}
                            </span>
                          )}
                        </div>
                        <span className="font-semibold text-gray-900">{m.nombre}</span>
                      </div>
                    </td>
                    <td className="px-4 py-3 text-gray-600">{m.telefono || '—'}</td>
                    <td className="px-4 py-3">
                      {activo ? (
                        <span className={`inline-flex items-center gap-1.5 text-xs font-semibold px-2.5 py-1 rounded-full border ${cfg.cls}`}>
                          <span className={`w-1.5 h-1.5 rounded-full ${m.estado === 'ocupado' ? 'bg-yellow-500' : 'bg-green-500'}`} />
                          {cfg.label}
                        </span>
                      ) : (
                        <span className="inline-flex items-center text-xs font-semibold px-2.5 py-1 rounded-full border bg-red-50 text-red-600 border-red-200">
                          Inactivo
                        </span>
                      )}
                    </td>
                    <td className="px-4 py-3">
                      <span className={`inline-flex text-xs font-semibold px-2 py-0.5 rounded-full border ${activo ? 'bg-green-50 text-green-700 border-green-200' : 'bg-gray-100 text-gray-500 border-gray-200'}`}>
                        {activo ? 'Activo' : 'Inactivo'}
                      </span>
                    </td>
                    <td className="px-4 py-3 text-xs text-gray-500">
                      {m.zonaBaseNombre ?? m.macroZonaBaseNombre ?? (
                        <span className="text-gray-300">Sin zona</span>
                      )}
                    </td>
                    <td className="px-4 py-3 text-right">
                      <button onClick={() => openEdit(m)} className="text-[#004aad] text-xs font-semibold hover:underline">
                        Editar
                      </button>
                    </td>
                  </tr>
                )
              })}
            </tbody>
          </table>
        )}
      </div>

      {/* Drawer overlay */}
      <div
        className={`fixed inset-0 z-40 bg-black/40 backdrop-blur-sm transition-opacity ${drawerOpen ? 'opacity-100 pointer-events-auto' : 'opacity-0 pointer-events-none'}`}
        onClick={closeDrawer}
      />

      {/* Drawer */}
      <div className={`fixed right-0 top-0 z-50 h-full w-full max-w-[460px] bg-white shadow-2xl flex flex-col transition-transform duration-300 ${drawerOpen ? 'translate-x-0' : 'translate-x-full'}`}>
        {/* Header */}
        <div className="flex items-center justify-between px-5 py-4 border-b border-gray-200">
          <div className="flex items-center gap-3 min-w-0">
            {!isNew && (
              <div className="w-10 h-10 rounded-full bg-[#004aad]/10 grid place-items-center flex-shrink-0 overflow-hidden border border-gray-200">
                {ePhotoPreview ? (
                  // eslint-disable-next-line @next/next/no-img-element
                  <img src={ePhotoPreview} alt="" className="w-full h-full object-cover" />
                ) : (
                  <span className="text-base font-black text-[#004aad]">
                    {(selected?.nombre || '?')[0].toUpperCase()}
                  </span>
                )}
              </div>
            )}
            <div className="min-w-0">
              <h2 className="text-lg font-black text-gray-900 truncate">
                {isNew ? 'Nuevo motorizado' : (selected?.nombre || 'Editar')}
              </h2>
              {!isNew && selected && (
                <p className="text-xs text-gray-400 mt-0.5">
                  {selected.activo !== false ? 'Motorizado activo' : 'Motorizado inactivo'}
                </p>
              )}
            </div>
          </div>
          <button onClick={closeDrawer} className="w-9 h-9 grid place-items-center rounded-full border border-gray-200 hover:bg-gray-50 transition flex-shrink-0">
            <X className="h-4 w-4 text-gray-500" />
          </button>
        </div>

        {/* Body */}
        <div className="flex-1 overflow-y-auto p-5 space-y-6">

          {/* Stats rápidas (solo en edición) */}
          {!isNew && (
            <section className="space-y-3">
              <div className="flex items-center gap-2">
                <TrendingUp className="h-4 w-4 text-[#004aad]" />
                <h3 className="text-xs font-bold text-gray-500 uppercase tracking-wide">Rendimiento</h3>
              </div>

              {/* Grid KPIs */}
              <div className="grid grid-cols-3 gap-2">
                {[
                  { label: 'Hoy', value: stats?.hoy, color: 'text-blue-700', bg: 'bg-blue-50 border-blue-200' },
                  { label: 'Esta semana', value: stats?.semana, color: 'text-indigo-700', bg: 'bg-indigo-50 border-indigo-200' },
                  { label: 'Total', value: stats?.total, color: 'text-gray-800', bg: 'bg-gray-50 border-gray-200' },
                ].map((k) => (
                  <div key={k.label} className={`${k.bg} border rounded-xl px-3 py-2.5 text-center`}>
                    <p className={`text-xl font-black ${k.color}`}>
                      {loadingStats ? '…' : (k.value ?? '—')}
                    </p>
                    <p className="text-[10px] font-semibold text-gray-500 mt-0.5">{k.label}</p>
                  </div>
                ))}
              </div>

              <div className="grid grid-cols-3 gap-2">
                <div className={`border rounded-xl px-3 py-2.5 text-center ${
                  !loadingStats && stats?.tasaAceptacion !== null && (stats?.tasaAceptacion ?? 0) < 70
                    ? 'bg-red-50 border-red-200'
                    : 'bg-green-50 border-green-200'
                }`}>
                  <p className={`text-xl font-black ${
                    !loadingStats && stats?.tasaAceptacion !== null && (stats?.tasaAceptacion ?? 0) < 70
                      ? 'text-red-600'
                      : 'text-green-700'
                  }`}>
                    {loadingStats ? '…' : stats?.tasaAceptacion !== null ? `${stats?.tasaAceptacion}%` : '—'}
                  </p>
                  <p className="text-[10px] font-semibold text-gray-500 mt-0.5">Tasa acept.</p>
                </div>
                <div className={`border rounded-xl px-3 py-2.5 text-center ${(stats?.rechazos ?? 0) > 0 ? 'bg-orange-50 border-orange-200' : 'bg-gray-50 border-gray-200'}`}>
                  <p className={`text-xl font-black ${(stats?.rechazos ?? 0) > 0 ? 'text-orange-600' : 'text-gray-700'}`}>
                    {loadingStats ? '…' : (stats?.rechazos ?? '—')}
                  </p>
                  <p className="text-[10px] font-semibold text-gray-500 mt-0.5">Rechazos</p>
                </div>
                <div className={`border rounded-xl px-3 py-2.5 text-center ${(stats?.depositosPendientes ?? 0) > 0 ? 'bg-yellow-50 border-yellow-200' : 'bg-gray-50 border-gray-200'}`}>
                  <p className={`text-xl font-black ${(stats?.depositosPendientes ?? 0) > 0 ? 'text-yellow-600' : 'text-gray-700'}`}>
                    {loadingStats ? '…' : (stats?.depositosPendientes ?? '—')}
                  </p>
                  <p className="text-[10px] font-semibold text-gray-500 mt-0.5">Dep. pend.</p>
                </div>
              </div>

              {/* Últimos rechazos */}
              {!loadingStats && (stats?.ultimosRechazos?.length ?? 0) > 0 && (
                <div className="bg-orange-50 border border-orange-200 rounded-xl p-3">
                  <div className="flex items-center gap-1.5 mb-2">
                    <AlertCircle className="h-3.5 w-3.5 text-orange-500" />
                    <p className="text-xs font-bold text-orange-700">Últimos rechazos</p>
                  </div>
                  <ul className="space-y-1">
                    {stats!.ultimosRechazos.map((r) => (
                      <li key={r.id} className="flex items-center justify-between text-xs">
                        <span className="font-mono text-gray-500">{r.id.slice(0, 8)}</span>
                        <span className="text-gray-400">
                          {r.fecha ? (typeof r.fecha.toDate === 'function' ? r.fecha.toDate() : new Date(r.fecha as any)).toLocaleDateString('es-NI', { day: '2-digit', month: 'short' }) : '—'}
                        </span>
                      </li>
                    ))}
                  </ul>
                </div>
              )}
            </section>
          )}

          {/* ── Acceso al sistema ── */}
          {!isNew && (
            <section className={`rounded-xl border p-4 space-y-3 ${selected?.authUid ? 'bg-green-50 border-green-200' : 'bg-amber-50 border-amber-200'}`}>
              <div className="flex items-center gap-2">
                <KeyRound className={`h-4 w-4 ${selected?.authUid ? 'text-green-600' : 'text-amber-600'}`} />
                <h3 className={`text-xs font-bold uppercase tracking-wide ${selected?.authUid ? 'text-green-700' : 'text-amber-700'}`}>
                  Acceso al sistema
                </h3>
                <span className={`ml-auto text-[10px] font-bold px-2 py-0.5 rounded-full border ${selected?.authUid ? 'bg-green-100 text-green-700 border-green-300' : 'bg-amber-100 text-amber-700 border-amber-300'}`}>
                  {selected?.authUid ? 'Con acceso' : 'Sin acceso'}
                </span>
              </div>

              {selected?.authUid ? (
                <p className="text-xs text-green-700 font-mono break-all">{selected.authUid}</p>
              ) : (
                <>
                  <p className="text-xs text-amber-700">Este motorizado no tiene cuenta. Podés crearle acceso a la app con un correo y contraseña.</p>
                  <div className="space-y-2">
                    <div>
                      <label className={S.label}>Correo <span className="text-red-500">*</span></label>
                      <input type="email" value={caEmail} onChange={(e) => setCaEmail(e.target.value)} placeholder="motorizado@ejemplo.com" className={S.input} />
                    </div>
                    <div>
                      <label className={S.label}>Contraseña <span className="text-red-500">*</span></label>
                      <input type="password" value={caPassword} onChange={(e) => setCaPassword(e.target.value)} placeholder="Mínimo 6 caracteres" className={S.input} />
                    </div>
                  </div>
                  <div className="flex items-center gap-3">
                    <button
                      onClick={crearAccesoMotorizado}
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
              )}
            </section>
          )}

          {/* Foto de perfil */}
          <section className="space-y-3">
            <h3 className="text-xs font-bold text-gray-500 uppercase tracking-wide">Foto de perfil</h3>
            <div className="flex items-center gap-4">
              <div className="w-16 h-16 rounded-full bg-[#004aad]/10 grid place-items-center flex-shrink-0 overflow-hidden border-2 border-gray-200">
                {ePhotoPreview ? (
                  // eslint-disable-next-line @next/next/no-img-element
                  <img src={ePhotoPreview} alt="Foto" className="w-full h-full object-cover" />
                ) : (
                  <span className="text-2xl font-black text-[#004aad]">
                    {(eName || selected?.nombre || '?')[0].toUpperCase()}
                  </span>
                )}
              </div>
              <div className="space-y-2">
                <input
                  ref={photoInputRef}
                  type="file"
                  accept="image/*"
                  className="hidden"
                  onChange={handlePhotoChange}
                />
                <button
                  type="button"
                  onClick={() => photoInputRef.current?.click()}
                  className="inline-flex items-center gap-2 text-xs font-semibold text-[#004aad] border border-[#004aad]/30 rounded-lg px-3 py-1.5 hover:bg-[#004aad]/5 transition"
                >
                  {ePhotoPreview ? 'Cambiar foto' : 'Subir foto'}
                </button>
                {ePhotoFile && (
                  <p className="text-xs text-gray-400">Se subirá al guardar.</p>
                )}
                {ePhotoPreview && (
                  <button
                    type="button"
                    onClick={() => { setEPhotoPreview(null); setEPhotoFile(null); setEPhotoRemoved(true) }}
                    className="block text-xs text-red-500 font-semibold hover:underline"
                  >
                    Quitar foto
                  </button>
                )}
              </div>
            </div>
            <p className="text-xs text-gray-400">Solo imágenes. Se comprimirá automáticamente antes de subir.</p>
          </section>

          {/* Datos */}
          <section className="space-y-3">
            <h3 className="text-xs font-bold text-gray-500 uppercase tracking-wide">Datos del motorizado</h3>
            <div>
              <label className={S.label}>Nombre <span className="text-red-500">*</span></label>
              <input value={eName} onChange={(e) => setEName(e.target.value)} placeholder="Nombre completo" className={S.input} />
            </div>
            <div>
              <label className={S.label}>Teléfono</label>
              <input value={ePhone} onChange={(e) => setEPhone(e.target.value)} placeholder="8888-8888" className={S.input} />
            </div>
            {!isNew && (
              <div>
                <label className={S.label}>UID de Firebase Auth <span className="text-gray-400 font-normal normal-case">(opcional)</span></label>
                <input value={eAuthUid} onChange={(e) => setEAuthUid(e.target.value)} placeholder="abc123xyz..." className={S.input} />
                <p className="text-xs text-gray-400 mt-1">Vincula la cuenta de Firebase Auth con este motorizado.</p>
              </div>
            )}
          </section>

          {/* Estado */}
          <section className="space-y-3">
            <h3 className="text-xs font-bold text-gray-500 uppercase tracking-wide">Estado operativo</h3>
            <div className="flex gap-2">
              {(['disponible', 'ocupado'] as EstadoMoto[]).map((e) => (
                <button
                  key={e}
                  onClick={() => setEEstado(e)}
                  className={`flex-1 py-2 rounded-xl text-sm font-semibold border transition ${eEstado === e
                    ? e === 'disponible' ? 'bg-green-50 text-green-700 border-green-300' : 'bg-yellow-50 text-yellow-700 border-yellow-300'
                    : 'bg-white text-gray-500 border-gray-200 hover:bg-gray-50'
                  }`}
                >
                  {e === 'disponible' ? '🟢 Disponible' : '🟡 Ocupado'}
                </button>
              ))}
            </div>
          </section>

          {/* Activo / Inactivo */}
          <section>
            <h3 className="text-xs font-bold text-gray-500 uppercase tracking-wide mb-3">Cuenta</h3>
            <button
              onClick={() => setEActivo(!eActivo)}
              className={`w-full flex items-center justify-between px-4 py-3 rounded-xl border transition ${eActivo ? 'bg-green-50 border-green-200' : 'bg-red-50 border-red-200'}`}
            >
              <div>
                <p className={`text-sm font-bold ${eActivo ? 'text-green-700' : 'text-red-600'}`}>
                  {eActivo ? 'Motorizado activo' : 'Motorizado inactivo'}
                </p>
                <p className="text-xs text-gray-500 mt-0.5">
                  {eActivo ? 'Puede recibir y operar órdenes.' : 'No aparece para asignación de órdenes.'}
                </p>
              </div>
              <div className={`w-11 h-6 rounded-full transition-colors ${eActivo ? 'bg-green-500' : 'bg-gray-300'} relative`}>
                <div className={`absolute top-0.5 w-5 h-5 bg-white rounded-full shadow transition-transform ${eActivo ? 'translate-x-5' : 'translate-x-0.5'}`} />
              </div>
            </button>
          </section>

          {/* Equipamiento */}
          <section className="space-y-2">
            <h3 className="text-xs font-bold text-gray-500 uppercase tracking-wide">Equipamiento</h3>
            <button
              onClick={() => setETieneBolso(!eTieneBolso)}
              className={`w-full flex items-center justify-between px-4 py-3 rounded-xl border transition ${
                eTieneBolso ? 'bg-blue-50 border-blue-200' : 'bg-gray-50 border-gray-200'
              }`}
            >
              <div className="text-left">
                <p className={`text-sm font-bold ${eTieneBolso ? 'text-blue-700' : 'text-gray-500'}`}>
                  {eTieneBolso ? 'Tiene bolso térmico' : 'Sin bolso térmico'}
                </p>
                <p className="text-xs text-gray-400 mt-0.5">
                  {eTieneBolso ? 'Puede recibir órdenes que requieren bolso.' : 'Recibe penalización en órdenes de bolso.'}
                </p>
              </div>
              <div className={`w-11 h-6 rounded-full transition-colors relative shrink-0 ${eTieneBolso ? 'bg-blue-500' : 'bg-gray-300'}`}>
                <div className={`absolute top-0.5 w-5 h-5 bg-white rounded-full shadow transition-transform ${eTieneBolso ? 'translate-x-5' : 'translate-x-0.5'}`} />
              </div>
            </button>
          </section>

          {/* Ubicación base */}
          <section className="space-y-3">
            <div className="flex items-center gap-2">
              <MapPin className="h-4 w-4 text-[#004aad]" />
              <h3 className="text-xs font-bold text-gray-500 uppercase tracking-wide">Ubicación base / inicio de jornada</h3>
            </div>

            <div>
              <label className={S.label}>Dirección</label>
              <input
                ref={autocompleteInputRef}
                type="text"
                placeholder="Buscar dirección…"
                className={S.input}
                defaultValue={eDireccionBase ?? ''}
              />
              <p className="text-xs text-gray-400 mt-1">También podés hacer clic en el mapa o arrastrar el marcador.</p>
            </div>

            <div
              ref={mapContainerRef}
              className="w-full rounded-xl overflow-hidden border border-gray-200"
              style={{ height: '250px' }}
            />

            {(eZonaBaseNombre || eMacroZonaBaseNombre) && (
              <div className="flex flex-wrap gap-2">
                {eZonaBaseNombre && (
                  <span className="inline-flex items-center gap-1 text-xs font-semibold px-2.5 py-1 rounded-full bg-blue-50 text-blue-700 border border-blue-200">
                    <MapPin className="h-3 w-3" />{eZonaBaseNombre}
                  </span>
                )}
                {eMacroZonaBaseNombre && (
                  <span className="inline-flex items-center gap-1 text-xs font-semibold px-2.5 py-1 rounded-full bg-indigo-50 text-indigo-700 border border-indigo-200">
                    {eMacroZonaBaseNombre}
                  </span>
                )}
              </div>
            )}

            {warningFueraDeMacrozona && eUbicacionBase && (
              <div className="flex items-start gap-2 bg-yellow-50 border border-yellow-200 rounded-xl px-3 py-2.5">
                <AlertCircle className="h-4 w-4 text-yellow-500 shrink-0 mt-0.5" />
                <p className="text-xs text-yellow-700 font-semibold">
                  La ubicación está fuera de todas las macrozonas activas. Podés guardar igual.
                </p>
              </div>
            )}

            {eUbicacionBase && (
              <button
                type="button"
                onClick={() => {
                  setEUbicacionBase(null)
                  setEDireccionBase(null)
                  setEZonaBaseId(null)
                  setEZonaBaseNombre(null)
                  setEMacroZonaBaseId(null)
                  setEMacroZonaBaseNombre(null)
                  setWarningFueraDeMacrozona(false)
                  if (autocompleteInputRef.current) autocompleteInputRef.current.value = ''
                  markerRef.current?.setVisible(false)
                }}
                className="text-xs text-red-500 font-semibold hover:underline"
              >
                Quitar ubicación base
              </button>
            )}
          </section>

        </div>

        {/* Footer */}
        <div className="px-5 py-4 border-t border-gray-200 flex items-center gap-3">
          <button onClick={save} disabled={saving} className={S.btnPrimary}>
            {saving ? 'Guardando…' : isNew ? 'Crear motorizado' : 'Guardar cambios'}
          </button>
          {msg && (
            <span className={`text-sm font-semibold ${msg.startsWith('✅') ? 'text-green-600' : 'text-red-600'}`}>
              {msg}
            </span>
          )}
        </div>
      </div>
    </div>
  )
}
