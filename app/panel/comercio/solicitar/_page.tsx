'use client'

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
  addDoc,
  collection,
  doc,
  getDoc,
  getDocs,
  limit,
  onSnapshot,
  orderBy,
  query,
  serverTimestamp,
  setDoc,
  where,
} from 'firebase/firestore'
import { auth, db } from '@/fb/config'
import { useUser } from '@/app/Components/UserProvider'
import { getMapsLoader } from '@/lib/googleMaps'
import { getZonasActivas } from '@/fb/zonas'
import { clasificarOrdenCompleto } from '@/lib/zonas'
import { obtenerDistanciaMetros } from '@/lib/distancia'
import { calcularRecargoZona, RECARGO_TERMINAL_BUS, type TipoServicio, type MetodoFueraManagua } from '@/lib/recargoZona'
import { getPuntosActivos } from '@/fb/puntosLogisticos'
import { type PuntoLogistico, sugerirPuntosParaDestino, encontrarCargotransMasCercano } from '@/lib/puntosLogisticos'
import ClienteSearchModal, { ClienteModalItem } from '@/app/Components/ClienteSearchModal'
import StepIndicator from './_components/StepIndicator'
import StickyOrderHeader from './_components/StickyOrderHeader'
import StickyBottomNav from './_components/StickyBottomNav'
import ToastOrdenCreada from './_components/ToastOrdenCreada'

// ─── Types ────────────────────────────────────────────────────────────────────

type LatLng = { lat: number; lng: number }
type TipoUbicacion = 'referencial' | 'exacto'
type TipoCliente = 'contado' | 'credito'
type QuienPagaDelivery = 'recoleccion' | 'entrega' | 'transferencia' | ''
type DeducirDelivery = 'no_deducir' | 'deducir_del_cobro'

type ClienteGuardado = {
  id: string
  nombre: string
  celular: string
  direccion?: string
  puntoGoogleTexto?: string
  coord?: LatLng
  tipoUbicacion?: TipoUbicacion
  totalViajes?: number
  totalEntregados?: number
}

type PuntoFavorito = {
  key: string
  label: string
  nombre?: string
  celular?: string
  direccion?: string
  coord?: LatLng | null
  tipoUbicacion?: TipoUbicacion
}

type RetiroState = {
  favKey: string
  nombre: string
  celular: string
  direccion: string
  coord: LatLng | null
  tipoUbicacion: TipoUbicacion
}

type EntregaState = {
  nombre: string
  celular: string
  direccion: string
  coord: LatLng | null
  tipoUbicacion: TipoUbicacion
}

// ─── Constants ────────────────────────────────────────────────────────────────

const CACHE_PREFIX = 'sol:'
const CACHE_TTL = 10 * 60 * 1000

// ─── Tariff (same as calculadora) ────────────────────────────────────────────

function tarifa(km: number): number {
  if (km < 2) return 70; if (km < 4) return 80; if (km < 6) return 90
  if (km < 8) return 110; if (km < 10) return 120; if (km < 12) return 130
  if (km < 14) return 150; if (km < 16) return 160; if (km < 18) return 180
  if (km < 20) return 190; if (km < 22) return 210; if (km < 24) return 220
  if (km < 26) return 240; if (km < 28) return 250; if (km < 30) return 270
  if (km < 32) return 280; if (km < 34) return 300; if (km < 36) return 310
  if (km < 38) return 330; if (km < 40) return 340; if (km < 42) return 360
  if (km < 44) return 370; if (km < 46) return 390; if (km < 48) return 400
  if (km < 50) return 420; if (km < 52) return 430; if (km < 54) return 440
  return -1
}

async function calcularDistancia(o: LatLng, d: LatLng): Promise<{ km: number; precio: number } | null> {
  const key = `${CACHE_PREFIX}${o.lat.toFixed(5)},${o.lng.toFixed(5)}-${d.lat.toFixed(5)},${d.lng.toFixed(5)}`
  try {
    const raw = sessionStorage.getItem(key)
    if (raw) {
      const cached: { km: number; ts: number } = JSON.parse(raw)
      if (Date.now() - cached.ts < CACHE_TTL) return { km: cached.km, precio: tarifa(cached.km) }
      sessionStorage.removeItem(key)
    }
  } catch {}

  const metros = await obtenerDistanciaMetros(`${o.lat},${o.lng}`, `${d.lat},${d.lng}`)
  if (!metros) return null

  const km = metros / 1000
  try { sessionStorage.setItem(key, JSON.stringify({ km, ts: Date.now() })) } catch {}
  return { km, precio: tarifa(km) }
}

// ─── Hooks ────────────────────────────────────────────────────────────────────

// Los 4 helpers de abajo reciben el comercioId ESTABLE (Bloque A) — nunca el
// Auth UID — porque clientes_envio y comercios/{id} se identifican por el
// negocio permanente, no por quién está logueado en ese momento.
function useClientesEntrega(comercioId: string | null) {
  const [clientes, setClientes] = useState<ClienteGuardado[]>([])
  useEffect(() => {
    if (!comercioId) return
    const q = query(collection(db, 'clientes_envio'), where('comercioUid', '==', comercioId))
    const unsub = onSnapshot(q, (snap) => {
      setClientes(snap.docs.map(d => ({ id: d.id, ...(d.data() as any) })))
    })
    return () => unsub()
  }, [comercioId])
  return clientes
}

function usePuntosFavoritos(comercioId: string | null) {
  const [puntos, setPuntos] = useState<PuntoFavorito[]>([])
  useEffect(() => {
    if (!comercioId) return
    const unsub = onSnapshot(doc(db, 'comercios', comercioId), (snap) => {
      if (!snap.exists()) { setPuntos([]); return }
      const data = snap.data() as any
      const container = data?.puntosRetiro || {}
      const items: PuntoFavorito[] = Object.entries(container)
        .map(([key, raw]: [string, any]) => ({
          key,
          label: raw?.label || raw?.nombre || key,
          nombre: raw?.nombre,
          celular: raw?.celular,
          direccion: raw?.direccion,
          coord: raw?.coord || null,
          tipoUbicacion: raw?.tipoUbicacion || 'referencial',
        }))
        .filter(item => item.label || item.nombre || item.direccion)
      items.push({ key: '__otro__', label: 'Otro' })
      setPuntos(items)
    })
    return () => unsub()
  }, [comercioId])
  return puntos
}

async function guardarClienteEntrega(comercioId: string, data: Omit<ClienteGuardado, 'id'>) {
  if (!data.celular?.trim()) return
  const docId = `${comercioId}_${data.celular.replace(/\D/g, '')}`
  const payload: Record<string, any> = {
    nombre: data.nombre.trim(),
    celular: data.celular.trim(),
    comercioUid: comercioId,
    updatedAt: serverTimestamp(),
    // totalViajes se incrementa solo cuando la orden pasa a 'entregado' en SolicitudDrawer
  }
  if (data.direccion?.trim()) payload.direccion = data.direccion.trim()
  if (data.coord) payload.coord = data.coord
  if (data.tipoUbicacion) payload.tipoUbicacion = data.tipoUbicacion
  await setDoc(doc(db, 'clientes_envio', docId), payload, { merge: true })
}

async function guardarPuntoFavorito(comercioId: string, label: string, data: RetiroState, geocode: string) {
  const key = `punto_${Date.now()}`
  const payload: Record<string, any> = {
    label: label.trim(),
    nombre: data.nombre.trim() || label.trim(),
    celular: data.celular.trim(),
    direccion: data.direccion.trim(),
    tipoUbicacion: data.tipoUbicacion,
    updatedAt: serverTimestamp(),
  }
  if (data.coord) payload.coord = data.coord
  if (geocode.trim()) payload.geocodeGoogle = geocode.trim()
  await setDoc(doc(db, 'comercios', comercioId), { puntosRetiro: { [key]: payload }, updatedAt: serverTimestamp() }, { merge: true })
}

// ─── Phone helpers ────────────────────────────────────────────────────────────

function formatCelular(v: string): string {
  return v.replace(/\D/g, '').slice(0, 8)
}

function validarCelular(v: string): boolean {
  return /^\d{8}$/.test(v.trim())
}

// ─── Static Mini Map (read-only, for favorites) ───────────────────────────────

function StaticMiniMap({ coord, color = '#004aad', label = 'R' }: {
  coord: LatLng
  color?: string
  label?: string
}) {
  const containerRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    let mounted = true
    getMapsLoader().load().then((google) => {
      if (!mounted || !containerRef.current) return
      const map = new google.maps.Map(containerRef.current, {
        center: coord,
        zoom: 15,
        disableDefaultUI: true,
        gestureHandling: 'none',
        styles: [
          { featureType: 'poi', stylers: [{ visibility: 'off' }] },
          { featureType: 'transit', stylers: [{ visibility: 'off' }] },
        ],
      })
      new google.maps.Marker({
        map,
        position: coord,
        icon: { path: google.maps.SymbolPath.CIRCLE, fillColor: color, fillOpacity: 1, strokeColor: '#fff', strokeWeight: 2, scale: 10 },
        label: { text: label, color: '#fff', fontWeight: 'bold', fontSize: '11px' },
      })
    })
    return () => { mounted = false }
  }, [])

  return (
    <div ref={containerRef} style={{ width: '100%', height: 180, borderRadius: 12, overflow: 'hidden', border: '1px solid #e5e7eb' }} />
  )
}

// ─── Mini Map (interactive, with Places search) ───────────────────────────────

function MiniMap({
  coord,
  onSelect,
  onGeocode,
  color = '#004aad',
  label = 'R',
  locked = false,
}: {
  coord: LatLng | null
  onSelect: (c: LatLng) => void
  onGeocode?: (addr: string) => void
  color?: string
  label?: string
  locked?: boolean
}) {
  const containerRef = useRef<HTMLDivElement>(null)
  const searchRef = useRef<HTMLInputElement>(null)
  const mapRef = useRef<google.maps.Map | null>(null)
  const markerRef = useRef<google.maps.Marker | null>(null)
  const geocoderRef = useRef<google.maps.Geocoder | null>(null)
  const onSelectRef = useRef(onSelect)
  const onGeocodeRef = useRef(onGeocode)
  const coordRef = useRef(coord)
  const lockedRef = useRef(locked)
  useEffect(() => { onSelectRef.current = onSelect })
  useEffect(() => { onGeocodeRef.current = onGeocode })
  useEffect(() => { coordRef.current = coord })
  useEffect(() => { lockedRef.current = locked })

  const reverseGeocode = useCallback((c: LatLng) => {
    geocoderRef.current?.geocode({ location: c }, (results, status) => {
      if (status === 'OK' && results?.[0]) {
        onGeocodeRef.current?.(results[0].formatted_address)
      }
    })
  }, [])

  const placeMarker = useCallback((c: LatLng, goog: typeof google, geocodedAddr?: string) => {
    if (lockedRef.current) return
    markerRef.current?.setMap(null)
    markerRef.current = new goog.maps.Marker({
      map: mapRef.current!,
      position: c,
      draggable: true,
      icon: { path: goog.maps.SymbolPath.CIRCLE, fillColor: color, fillOpacity: 1, strokeColor: '#fff', strokeWeight: 2, scale: 10 },
      label: { text: label, color: '#fff', fontWeight: 'bold', fontSize: '11px' },
    })
    markerRef.current.addListener('dragend', () => {
      if (lockedRef.current) { markerRef.current?.setPosition(coordRef.current!); return }
      const pos = markerRef.current?.getPosition()
      if (!pos) return
      const dc = { lat: pos.lat(), lng: pos.lng() }
      onSelectRef.current(dc)
      reverseGeocode(dc)
    })
    onSelectRef.current(c)
    if (geocodedAddr) {
      onGeocodeRef.current?.(geocodedAddr)
    } else {
      reverseGeocode(c)
    }
  }, [color, label, reverseGeocode])

  useEffect(() => {
    let mounted = true
    getMapsLoader().load().then((google) => {
      if (!mounted || !containerRef.current) return
      const initCoord = coordRef.current
      const center = initCoord || { lat: 12.1364, lng: -86.2514 }
      mapRef.current = new google.maps.Map(containerRef.current, {
        center,
        zoom: initCoord ? 15 : 13,
        disableDefaultUI: true,
        zoomControl: true,
        styles: [
          { featureType: 'poi', stylers: [{ visibility: 'off' }] },
          { featureType: 'transit', stylers: [{ visibility: 'off' }] },
        ],
      })
      geocoderRef.current = new google.maps.Geocoder()

      if (searchRef.current) {
        const autocomplete = new google.maps.places.Autocomplete(searchRef.current, {
          componentRestrictions: { country: 'ni' },
          fields: ['geometry', 'formatted_address'],
        })
        autocomplete.addListener('place_changed', () => {
          const place = autocomplete.getPlace()
          if (place?.geometry?.location) {
            const c = { lat: place.geometry.location.lat(), lng: place.geometry.location.lng() }
            mapRef.current?.panTo(c)
            mapRef.current?.setZoom(16)
            placeMarker(c, google, place.formatted_address || '')
          }
        })
      }

      if (initCoord) {
        markerRef.current = new google.maps.Marker({
          map: mapRef.current,
          position: initCoord,
          draggable: true,
          icon: { path: google.maps.SymbolPath.CIRCLE, fillColor: color, fillOpacity: 1, strokeColor: '#fff', strokeWeight: 2, scale: 10 },
          label: { text: label, color: '#fff', fontWeight: 'bold', fontSize: '11px' },
        })
        markerRef.current.addListener('dragend', () => {
          if (lockedRef.current) { markerRef.current?.setPosition(coordRef.current!); return }
          const pos = markerRef.current?.getPosition()
          if (!pos) return
          const dc = { lat: pos.lat(), lng: pos.lng() }
          onSelectRef.current(dc)
          reverseGeocode(dc)
        })
      }

      mapRef.current.addListener('click', (e: google.maps.MapMouseEvent) => {
        if (lockedRef.current || !e.latLng) return
        const c = { lat: e.latLng.lat(), lng: e.latLng.lng() }
        placeMarker(c, google)
      })
    })
    return () => { mounted = false }
  }, [])

  useEffect(() => {
    if (!mapRef.current || !window.google) return
    const google = window.google
    if (coord) {
      if (!markerRef.current) {
        markerRef.current = new google.maps.Marker({
          map: mapRef.current,
          position: coord,
          draggable: true,
          icon: { path: google.maps.SymbolPath.CIRCLE, fillColor: color, fillOpacity: 1, strokeColor: '#fff', strokeWeight: 2, scale: 10 },
          label: { text: label, color: '#fff', fontWeight: 'bold', fontSize: '11px' },
        })
        markerRef.current.addListener('dragend', () => {
          const pos = markerRef.current?.getPosition()
          if (!pos) return
          const dc = { lat: pos.lat(), lng: pos.lng() }
          onSelectRef.current(dc)
          reverseGeocode(dc)
        })
      } else {
        markerRef.current.setPosition(coord)
      }
      mapRef.current.panTo(coord)
    }
  }, [coord])

  return (
    <div>
      {!locked && (
        <input
          ref={searchRef}
          type="text"
          placeholder="🔍 Buscar dirección en Google Maps..."
          style={{ ...S.input, marginBottom: 8 }}
        />
      )}
      <div style={{ position: 'relative' as const }}>
        <div ref={containerRef} style={{ width: '100%', height: 220, borderRadius: 12, overflow: 'hidden', border: '1px solid #e5e7eb' }} />
        {locked && (
          <div style={{ position: 'absolute' as const, inset: 0, borderRadius: 12, background: 'rgba(0,0,0,0.18)', display: 'flex', alignItems: 'center', justifyContent: 'center', pointerEvents: 'none' as const }}>
            <span style={{ background: 'rgba(0,0,0,0.55)', color: '#fff', fontSize: 11, fontWeight: 600, padding: '4px 10px', borderRadius: 20 }}>🔒 Punto de la cotización</span>
          </div>
        )}
      </div>
      {!locked && (
        <p style={{ fontSize: 11, color: '#9ca3af', margin: '5px 0 0' }}>
          Tocá el mapa para marcar el punto exacto. Podés arrastrar el pin para ajustar.
        </p>
      )}
    </div>
  )
}

// ─── Polyline map (shows both points + dashed line) ───────────────────────────

function RoutePreviewMap({
  origen,
  destino,
}: {
  origen: LatLng | null
  destino: LatLng | null
}) {
  const containerRef = useRef<HTMLDivElement>(null)
  const mapRef = useRef<google.maps.Map | null>(null)
  const markerORef = useRef<google.maps.Marker | null>(null)
  const markerDRef = useRef<google.maps.Marker | null>(null)
  const polyRef = useRef<google.maps.Polyline | null>(null)
  const origenRef = useRef(origen)
  const destinoRef = useRef(destino)

  useEffect(() => { origenRef.current = origen })
  useEffect(() => { destinoRef.current = destino })

  const drawMarkers = useCallback((goog: typeof google, o: LatLng | null, d: LatLng | null) => {
    if (o && !markerORef.current) {
      markerORef.current = new goog.maps.Marker({
        map: mapRef.current!,
        position: o,
        icon: { path: goog.maps.SymbolPath.CIRCLE, fillColor: '#004aad', fillOpacity: 1, strokeColor: '#fff', strokeWeight: 2, scale: 10 },
        label: { text: 'R', color: '#fff', fontWeight: 'bold', fontSize: '11px' },
      })
    }
    if (d && !markerDRef.current) {
      markerDRef.current = new goog.maps.Marker({
        map: mapRef.current!,
        position: d,
        icon: { path: goog.maps.SymbolPath.CIRCLE, fillColor: '#16a34a', fillOpacity: 1, strokeColor: '#fff', strokeWeight: 2, scale: 10 },
        label: { text: 'E', color: '#fff', fontWeight: 'bold', fontSize: '11px' },
      })
    }
    polyRef.current?.setMap(null)
    polyRef.current = null
    if (o && d) {
      polyRef.current = new goog.maps.Polyline({
        path: [o, d],
        geodesic: true,
        strokeOpacity: 0,
        icons: [{
          icon: { path: 'M 0,-1 0,1', strokeOpacity: 0.8, strokeColor: '#004aad', strokeWeight: 3, scale: 4 },
          offset: '0',
          repeat: '20px',
        }],
        map: mapRef.current!,
      })
      const bounds = new goog.maps.LatLngBounds()
      bounds.extend(o)
      bounds.extend(d)
      mapRef.current!.fitBounds(bounds, { top: 50, right: 30, bottom: 30, left: 30 })
    } else if (o) {
      mapRef.current!.panTo(o)
    } else if (d) {
      mapRef.current!.panTo(d)
    }
  }, [])

  useEffect(() => {
    let mounted = true
    getMapsLoader().load().then((google) => {
      if (!mounted || !containerRef.current) return
      const o = origenRef.current
      const d = destinoRef.current
      mapRef.current = new google.maps.Map(containerRef.current, {
        center: o || d || { lat: 12.1364, lng: -86.2514 },
        zoom: 13,
        disableDefaultUI: true,
        zoomControl: true,
        styles: [
          { featureType: 'poi', stylers: [{ visibility: 'off' }] },
          { featureType: 'transit', stylers: [{ visibility: 'off' }] },
        ],
      })
      drawMarkers(google, o, d)
    })
    return () => { mounted = false }
  }, [])

  useEffect(() => {
    if (!mapRef.current || !window.google) return
    const google = window.google

    if (origen) {
      if (!markerORef.current) {
        markerORef.current = new google.maps.Marker({
          map: mapRef.current,
          position: origen,
          icon: { path: google.maps.SymbolPath.CIRCLE, fillColor: '#004aad', fillOpacity: 1, strokeColor: '#fff', strokeWeight: 2, scale: 10 },
          label: { text: 'R', color: '#fff', fontWeight: 'bold', fontSize: '11px' },
        })
      } else {
        markerORef.current.setPosition(origen)
      }
    } else {
      markerORef.current?.setMap(null)
      markerORef.current = null
    }

    if (destino) {
      if (!markerDRef.current) {
        markerDRef.current = new google.maps.Marker({
          map: mapRef.current,
          position: destino,
          icon: { path: google.maps.SymbolPath.CIRCLE, fillColor: '#16a34a', fillOpacity: 1, strokeColor: '#fff', strokeWeight: 2, scale: 10 },
          label: { text: 'E', color: '#fff', fontWeight: 'bold', fontSize: '11px' },
        })
      } else {
        markerDRef.current.setPosition(destino)
      }
    } else {
      markerDRef.current?.setMap(null)
      markerDRef.current = null
    }

    polyRef.current?.setMap(null)
    polyRef.current = null
    if (origen && destino) {
      polyRef.current = new google.maps.Polyline({
        path: [origen, destino],
        geodesic: true,
        strokeOpacity: 0,
        icons: [{
          icon: { path: 'M 0,-1 0,1', strokeOpacity: 0.8, strokeColor: '#004aad', strokeWeight: 3, scale: 4 },
          offset: '0',
          repeat: '20px',
        }],
        map: mapRef.current,
      })
      const bounds = new google.maps.LatLngBounds()
      bounds.extend(origen)
      bounds.extend(destino)
      mapRef.current.fitBounds(bounds, { top: 50, right: 30, bottom: 30, left: 30 })
    } else if (origen) {
      mapRef.current.panTo(origen)
    } else if (destino) {
      mapRef.current.panTo(destino)
    }
  }, [origen, destino])

  return (
    <div style={{ width: '100%', height: 200, borderRadius: 14, overflow: 'hidden', border: '1px solid #e5e7eb' }}>
      <div ref={containerRef} style={{ width: '100%', height: '100%' }} />
    </div>
  )
}

// ─── AutocompleteInput ────────────────────────────────────────────────────────

function AutocompleteInput({
  label, value, onChange, onSelect, placeholder, clientes, required,
}: {
  label: string; value: string; onChange: (v: string) => void
  onSelect: (c: ClienteGuardado) => void
  placeholder?: string; clientes: ClienteGuardado[]; required?: boolean
}) {
  const [open, setOpen] = useState(false)
  const ref = useRef<HTMLDivElement>(null)

  const filtered = useMemo(() => {
    const q = value.trim().toLowerCase()
    if (!q || q.length < 2) return []
    return clientes.filter(c => c.celular.includes(q) || c.nombre.toLowerCase().includes(q)).slice(0, 5)
  }, [value, clientes])

  useEffect(() => {
    const h = (e: MouseEvent) => { if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false) }
    document.addEventListener('mousedown', h)
    return () => document.removeEventListener('mousedown', h)
  }, [])

  return (
    <div ref={ref} style={{ position: 'relative' }}>
      <label style={S.label}>{label}{required && <span style={{ color: '#dc2626' }}> *</span>}</label>
      <input value={value} onChange={e => { onChange(e.target.value); setOpen(true) }} onFocus={() => setOpen(true)} placeholder={placeholder} style={S.input} />
      {open && filtered.length > 0 && (
        <div style={S.dropdown}>
          {filtered.map(c => (
            <button key={c.id} type="button" onClick={() => { onSelect(c); setOpen(false) }} style={S.dropdownItem}>
              <span style={{ fontWeight: 700, color: '#111827' }}>{c.nombre || '—'}</span>
              <span style={{ color: '#6b7280', fontSize: 12 }}> · {c.celular}</span>
              {c.direccion && <span style={{ color: '#9ca3af', fontSize: 11, display: 'block', marginTop: 2 }}>{c.direccion}</span>}
            </button>
          ))}
        </div>
      )}
    </div>
  )
}

// ─── UbicacionTipo ────────────────────────────────────────────────────────────

function UbicacionTipo({ value, onChange }: { value: TipoUbicacion; onChange: (v: TipoUbicacion) => void }) {
  return (
    <div style={{ marginTop: 8 }}>
      <p style={{ fontSize: 12, color: '#6b7280', margin: '0 0 6px' }}>¿Qué tan exacta es esta ubicación?</p>
      <div style={{ display: 'flex', gap: 8 }}>
        {(['referencial', 'exacto'] as TipoUbicacion[]).map(t => (
          <button key={t} type="button" onClick={() => onChange(t)} style={{ padding: '6px 14px', borderRadius: 8, fontSize: 12, fontWeight: 600, cursor: 'pointer', border: `1px solid ${value === t ? '#004aad' : '#e5e7eb'}`, background: value === t ? '#004aad' : '#fff', color: value === t ? '#fff' : '#374151' }}>
            {t === 'referencial' ? '📍 Referencial' : '🎯 Exacto'}
          </button>
        ))}
      </div>
    </div>
  )
}

function SectionCard({ title, icon, children }: { title: string; icon: string; children: React.ReactNode }) {
  return (
    <div style={S.sectionCard}>
      <div style={S.sectionHeader}>
        <span style={{ fontSize: 20 }}>{icon}</span>
        <h3 style={{ fontSize: 15, fontWeight: 800, color: '#111827', margin: 0 }}>{title}</h3>
      </div>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>{children}</div>
    </div>
  )
}

function Field({ label, required, children, hint }: { label: string; required?: boolean; children: React.ReactNode; hint?: string }) {
  return (
    <div>
      <label style={S.label}>{label}{required && <span style={{ color: '#dc2626' }}> *</span>}</label>
      {children}
      {hint && <p style={S.hint}>{hint}</p>}
    </div>
  )
}

function NotaMotorizado({ show, onToggle, value, onChange, label }: {
  show: boolean
  onToggle: () => void
  value: string
  onChange: (v: string) => void
  label: string
}) {
  return (
    <div>
      <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
        <button
          type="button"
          onClick={onToggle}
          style={{ width: 20, height: 20, borderRadius: 4, border: `2px solid ${show ? '#004aad' : '#d1d5db'}`, background: show ? '#004aad' : '#fff', display: 'flex', alignItems: 'center', justifyContent: 'center', cursor: 'pointer', flexShrink: 0 }}
        >
          {show && <span style={{ color: '#fff', fontSize: 12, fontWeight: 900 }}>✓</span>}
        </button>
        <label
          style={{ fontSize: 13, fontWeight: 600, color: '#374151', cursor: 'pointer' }}
          onClick={onToggle}
        >
          {label}
        </label>
      </div>
      {show && (
        <textarea
          value={value}
          onChange={e => onChange(e.target.value)}
          placeholder="Ej: Tocar timbre, preguntar por el encargado, paquetes en la bodega..."
          style={{ ...S.input, resize: 'vertical' as const, minHeight: 70, marginTop: 8 }}
          rows={2}
        />
      )}
    </div>
  )
}

// ─── Styles ───────────────────────────────────────────────────────────────────

const S: Record<string, React.CSSProperties> = {
  sectionCard: { background: '#fff', border: '1px solid #e5e7eb', borderRadius: 16, padding: '18px', marginBottom: 16, boxShadow: '0 1px 3px rgba(0,0,0,0.05)' },
  sectionHeader: { display: 'flex', alignItems: 'center', gap: 10, marginBottom: 18, paddingBottom: 14, borderBottom: '1px solid #f3f4f6' },
  label: { display: 'block', fontSize: 13, fontWeight: 600, color: '#374151', marginBottom: 6 },
  input: { width: '100%', border: '1px solid #e5e7eb', borderRadius: 10, padding: '10px 12px', fontSize: 14, color: '#111827', outline: 'none', background: '#fff', boxSizing: 'border-box' as const, fontFamily: 'inherit' },
  hint: { fontSize: 11, color: '#9ca3af', margin: '5px 0 0' },
  dropdown: { position: 'absolute', top: '100%', left: 0, right: 0, background: '#fff', border: '1px solid #e5e7eb', borderRadius: 12, boxShadow: '0 8px 24px rgba(0,0,0,0.12)', zIndex: 50, marginTop: 4, overflow: 'hidden' },
  dropdownItem: { display: 'block', width: '100%', textAlign: 'left' as const, padding: '10px 14px', border: 'none', background: 'none', cursor: 'pointer', borderBottom: '1px solid #f3f4f6', fontSize: 13 },
  btnOutline: { padding: '7px 14px', borderRadius: 8, border: '1px solid #e5e7eb', background: '#fff', fontSize: 12, fontWeight: 600, color: '#374151', cursor: 'pointer' },
  btnPrimary: { background: '#004aad', border: 'none', borderRadius: 10, padding: '10px 20px', color: '#fff', fontSize: 14, fontWeight: 700, cursor: 'pointer' },
}

const blankRetiro = (): RetiroState => ({ favKey: '__otro__', nombre: '', celular: '', direccion: '', coord: null, tipoUbicacion: 'referencial' })
const blankEntrega = (): EntregaState => ({ nombre: '', celular: '', direccion: '', coord: null, tipoUbicacion: 'referencial' })

// ─── Main ─────────────────────────────────────────────────────────────────────

export default function SolicitarEnvioPage() {
  const [uid, setUid] = useState<string | null>(null)
  useEffect(() => { const u = auth.currentUser; if (u) setUid(u.uid) }, [])
  // Identidad estable (Bloque A): comercioId (usuarios/{uid}.comercioId),
  // NUNCA auth.uid, para todo lo que sea del comercio como negocio
  // (comercios/{comercioId}, clientes_envio, solicitudes_envio.userId).
  // `uid` (Auth UID) se conserva solo para leer usuarios/{uid} y para
  // cotizaciones (historial de sesión, no de negocio — ver Bloque A).
  const { profile } = useUser()
  const comercioId = profile?.comercioId ?? null

  const [ownerCompanyName, setOwnerCompanyName] = useState('')
  const [comercioRequiereBolso, setComercioRequiereBolso] = useState(false)
  useEffect(() => {
    if (!uid || !comercioId) return
    Promise.all([
      getDoc(doc(db, 'comercios', comercioId)),
      getDoc(doc(db, 'usuarios', uid)),
    ]).then(([comercioSnap, usuarioSnap]) => {
      const c = comercioSnap.exists() ? (comercioSnap.data() as any) : null
      const u = usuarioSnap.exists() ? (usuarioSnap.data() as any) : null
      setOwnerCompanyName(c?.name || c?.companyName || u?.name || u?.nombre || '')
      setComercioRequiereBolso(c?.requiereBolso ?? false)
      if (c?.tipoCliente) setTipoCliente(c.tipoCliente)
    })
  }, [uid, comercioId])

  const clientesEntrega = useClientesEntrega(comercioId)
  const puntosFavoritos = usePuntosFavoritos(comercioId)

  // Draft from calculadora
  const [draft, setDraft] = useState<any>(null)
  useEffect(() => {
    try {
      const raw = sessionStorage.getItem('draftEnvio')
      if (!raw) return
      sessionStorage.removeItem('draftEnvio')
      const d = JSON.parse(raw)
      setDraft(d)
      if (d.origenCoord) {
        setRetiro(prev => ({
          ...prev,
          coord: d.origenCoord,
          tipoUbicacion: d.origenTipo || 'referencial',
          ...(d.origenFavKey ? { favKey: d.origenFavKey } : {}),
          ...(d.origenNombre ? { nombre: d.origenNombre } : {}),
          ...(d.origenCelular ? { celular: d.origenCelular } : {}),
          ...(d.origenDireccion ? { direccion: d.origenDireccion } : d.origen ? { direccion: d.origen } : {}),
        }))
      }
      if (d.destinoCoord) setEntrega(prev => ({ ...prev, coord: d.destinoCoord, tipoUbicacion: d.destinoTipo || 'referencial' }))
      if (d.origenCoord && d.destinoCoord) {
        const o = d.origenCoord, de = d.destinoCoord
        lastCalcKey.current = `${o.lat.toFixed(5)},${o.lng.toFixed(5)}-${de.lat.toFixed(5)},${de.lng.toFixed(5)}`
      }
    } catch {}
  }, [])

  const tieneCotizacion = !!draft
  const precioSugerido: number | null = useMemo(() => {
    const p = draft?.precioCordobas
    return typeof p === 'number' ? p : null
  }, [draft])

  // ── States ──
  const [paso, setPaso] = useState(1)
  const [retiro, setRetiro] = useState<RetiroState>(blankRetiro())
  const [entrega, setEntrega] = useState<EntregaState>(blankEntrega())
  const [tipoCliente, setTipoCliente] = useState<TipoCliente>('contado')
  const [cobroCE, setCobroCE] = useState(false)
  const [montoCE, setMontoCE] = useState<number | ''>('')
  const [quienPagaDelivery, setQuienPagaDelivery] = useState<QuienPagaDelivery>('')
  const [deducirDelivery, setDeducirDelivery] = useState<DeducirDelivery>('no_deducir')
  type PagoCargotrans = 'efectivo_motorizado' | 'transferencia_comercio' | ''
  const [pagoCargotrans, setPagoCargotrans] = useState<PagoCargotrans>('')
  const [detalle, setDetalle] = useState('')
  const [saving, setSaving] = useState(false)
  const [msg, setMsg] = useState<{ type: 'success' | 'error' | 'info'; text: string } | null>(null)
  const [showOrdenToast, setShowOrdenToast] = useState(false)

  const [showNotaRetiro, setShowNotaRetiro] = useState(false)
  const [notaRetiro, setNotaRetiro] = useState('')
  const [showNotaEntrega, setShowNotaEntrega] = useState(false)
  const [notaEntrega, setNotaEntrega] = useState('')

  const [numeroOrden, setNumeroOrden] = useState('')

  const [geocodeRetiro, setGeoRetiro] = useState('')
  const [geocodeEntrega, setGeoEntrega] = useState('')

  const [esProgramado, setEsProgramado] = useState(false)
  const [tipoProgramado, setTipoProgramado] = useState<'retiro' | 'entrega' | 'ambos'>('retiro')
  const [fechaRetiro, setFechaRetiro] = useState('')
  const [horaRetiro, setHoraRetiro] = useState('')
  const [fechaEntrega, setFechaEntrega] = useState('')
  const [horaEntrega, setHoraEntrega] = useState('')

  const [fragil, setFragil] = useState(false)
  const [grande, setGrande] = useState(false)
  const [notaPaquete, setNotaPaquete] = useState('')

  const [showClienteModal, setShowClienteModal] = useState(false)

  // ── Envío fuera de Managua ──
  const [esFueraManagua, setEsFueraManagua] = useState(false)
  const [metodoFueraManagua, setMetodoFueraManagua] = useState<MetodoFueraManagua>('bus_terminal')
  const [destinoFinal, setDestinoFinal] = useState('')
  const [showDetallesTransporte, setShowDetallesTransporte] = useState(false)
  const [transporteNombre, setTransporteNombre] = useState('')
  const [transporteCelular, setTransporteCelular] = useState('')
  const [transporteHoraSalida, setTransporteHoraSalida] = useState('')
  const [transporteNota, setTransporteNota] = useState('')
  const [cantidadPaquetes, setCantidadPaquetes] = useState('1')
  const [notaCargotrans, setNotaCargotrans] = useState('')
  const tipoServicio: TipoServicio = esFueraManagua ? 'fuera_managua' : 'normal'

  // ── Puntos logísticos ──
  const [puntosLogisticos, setPuntosLogisticos] = useState<PuntoLogistico[]>([])
  const [puntoLogisticoSeleccionado, setPuntoLogisticoSeleccionado] = useState<PuntoLogistico | null>(null)
  const [terminalesSugeridas, setTerminalesSugeridas] = useState<PuntoLogistico[]>([])

  useEffect(() => {
    getPuntosActivos().then(setPuntosLogisticos).catch(() => {})
  }, [])

  // Auto-sugerir terminal cuando cambia el destino (bus_terminal)
  useEffect(() => {
    if (!esFueraManagua || metodoFueraManagua !== 'bus_terminal') {
      setTerminalesSugeridas([])
      return
    }
    const sugeridos = sugerirPuntosParaDestino(destinoFinal, puntosLogisticos)
    setTerminalesSugeridas(sugeridos)
    if (sugeridos.length === 1) {
      setPuntoLogisticoSeleccionado((prev) => prev?.id === sugeridos[0].id ? prev : sugeridos[0])
    } else {
      setPuntoLogisticoSeleccionado(null)
    }
  }, [destinoFinal, esFueraManagua, metodoFueraManagua, puntosLogisticos])

  // Auto-sugerir Cargotrans más cercana cuando cambia el punto de retiro
  useEffect(() => {
    if (!esFueraManagua || metodoFueraManagua !== 'cargotrans') return
    if (!retiro.coord) { setPuntoLogisticoSeleccionado(null); return }
    const nearest = encontrarCargotransMasCercano(retiro.coord, puntosLogisticos)
    setPuntoLogisticoSeleccionado(nearest)
  }, [retiro.coord, esFueraManagua, metodoFueraManagua, puntosLogisticos])

  const [showGuardarFav, setShowGuardarFav] = useState(false)
  const [newFavLabel, setNewFavLabel] = useState('')
  const [savingNewFav, setSavingNewFav] = useState(false)

  // ── Trip history detection ──
  const [viajeAnterior, setViajeAnterior] = useState<{ precio: number; tipo: 'entregado' | 'cotizacion' } | null>(null)
  useEffect(() => {
    if (!uid || !comercioId || !retiro.coord || !entrega.coord) { setViajeAnterior(null); return }
    const o = retiro.coord
    const d = entrega.coord
    const TOL = 0.0005
    const matchCoord = (a: { lat: number; lng: number } | null | undefined, b: { lat: number; lng: number }) =>
      !!a && Math.abs(a.lat - b.lat) < TOL && Math.abs(a.lng - b.lng) < TOL
    let cancelled = false
    const search = async () => {
      const [cotSnap, solSnap] = await Promise.all([
        // cotizaciones: historial de sesión por Auth UID (no cambia).
        getDocs(query(collection(db, 'cotizaciones'), where('userId', '==', uid), orderBy('createdAt', 'desc'), limit(20))),
        // solicitudes_envio: identidad estable del comercio (Bloque A).
        getDocs(query(collection(db, 'solicitudes_envio'), where('userId', '==', comercioId), orderBy('createdAt', 'desc'), limit(20))),
      ])
      if (cancelled) return
      // Primero buscar en solicitudes realmente entregadas (viaje similar real)
      for (const d2 of solSnap.docs) {
        const r = d2.data() as any
        if (r.estado !== 'entregado') continue
        if (matchCoord(r.recoleccion?.coord, o) && matchCoord(r.entrega?.coord, d)) {
          const p = r.confirmacion?.precioFinalCordobas ?? r.cotizacion?.precioCordobas ?? r.pagoDelivery?.montoSugerido
          if (typeof p === 'number') { setViajeAnterior({ precio: p, tipo: 'entregado' }); return }
        }
      }
      // Fallback: cotización previa guardada (no es un viaje realizado)
      for (const d2 of cotSnap.docs) {
        const r = d2.data() as any
        if (matchCoord(r.origenCoord, o) && matchCoord(r.destinoCoord, d) && typeof r.precioCordobas === 'number') {
          setViajeAnterior({ precio: r.precioCordobas, tipo: 'cotizacion' }); return
        }
      }
      setViajeAnterior(null)
    }
    search().catch(() => {})
    return () => { cancelled = true }
  }, [uid, comercioId, retiro.coord, entrega.coord])

  // ── Manual price calculation ──
  const [calcResult, setCalcResult] = useState<{ km: number; precio: number } | null>(null)
  const [calcLoading, setCalcLoading] = useState(false)
  const [calcError, setCalcError] = useState<string | null>(null)
  const lastCalcKey = useRef<string | null>(null)

  useEffect(() => {
    if (!retiro.coord || !entrega.coord) {
      setCalcResult(null)
      return
    }
    const o = retiro.coord
    const d = entrega.coord
    const key = `${o.lat.toFixed(5)},${o.lng.toFixed(5)}-${d.lat.toFixed(5)},${d.lng.toFixed(5)}`
    if (lastCalcKey.current && key !== lastCalcKey.current) {
      setCalcResult(null)
      setCalcError(null)
      setDraft((prev: any) => prev ? { ...prev, precioCordobas: null } : prev)
    }
  }, [retiro.coord, entrega.coord])

  const coordsModificadasInfo = useMemo(() => {
    if (!draft) return { retiro: false, entrega: false }
    const TOL = 0.0002
    const retiroCambio = draft.origenCoord && retiro.coord
      ? Math.abs(retiro.coord.lat - draft.origenCoord.lat) > TOL || Math.abs(retiro.coord.lng - draft.origenCoord.lng) > TOL
      : false
    const entregaCambio = draft.destinoCoord && entrega.coord
      ? Math.abs(entrega.coord.lat - draft.destinoCoord.lat) > TOL || Math.abs(entrega.coord.lng - draft.destinoCoord.lng) > TOL
      : false
    return { retiro: retiroCambio, entrega: entregaCambio }
  }, [draft, retiro.coord, entrega.coord])

  const coordsModificadas = coordsModificadasInfo.retiro || coordsModificadasInfo.entrega

  // Reactive zone classification
  const [zonaInfo, setZonaInfo] = useState<{ retiroNombre: string | null; entregaNombre: string | null }>({ retiroNombre: null, entregaNombre: null })
  useEffect(() => {
    const entregaCoordForZona = esFueraManagua && puntoLogisticoSeleccionado
      ? puntoLogisticoSeleccionado.coord
      : entrega.coord || null
    if (!retiro.coord && !entregaCoordForZona) { setZonaInfo({ retiroNombre: null, entregaNombre: null }); return }
    let cancelled = false
    getZonasActivas().then(zonasActivas => {
      if (cancelled) return
      const r = clasificarOrdenCompleto(retiro.coord || null, entregaCoordForZona, zonasActivas)
      setZonaInfo({
        retiroNombre: r.zonaRetiroNombre || r.macroZonaRetiroNombre || null,
        entregaNombre: r.zonaEntregaNombre || r.macroZonaEntregaNombre || null,
      })
    }).catch(() => {})
    return () => { cancelled = true }
  }, [retiro.coord, entrega.coord, esFueraManagua, puntoLogisticoSeleccionado])

  const handleCalcular = async () => {
    const o = retiro.coord
    const d = esFueraManagua && puntoLogisticoSeleccionado
      ? puntoLogisticoSeleccionado.coord
      : entrega.coord
    if (!o || !d) return
    const key = `${o.lat.toFixed(5)},${o.lng.toFixed(5)}-${d.lat.toFixed(5)},${d.lng.toFixed(5)}`
    if (key === lastCalcKey.current && calcResult) return
    lastCalcKey.current = key
    setCalcLoading(true)
    setCalcError(null)
    calcularDistancia(o, d)
      .then(result => {
        if (result) setCalcResult(result)
        else setCalcError('No se pudo calcular la distancia entre estos puntos.')
      })
      .catch(() => setCalcError('Error al calcular distancia.'))
      .finally(() => setCalcLoading(false))
  }

  const recargoZona = useMemo(
    () => calcularRecargoZona(zonaInfo.retiroNombre, zonaInfo.entregaNombre),
    [zonaInfo]
  )
  const recargoMonto = recargoZona.aplica ? recargoZona.monto : 0
  const recargoServicioMonto = (esFueraManagua && metodoFueraManagua === 'bus_terminal') ? RECARGO_TERMINAL_BUS : 0

  const precioEfectivo = (() => {
    if (calcResult) return calcResult.precio === -1 ? -1 : calcResult.precio + recargoMonto + recargoServicioMonto
    const base = precioSugerido ?? (viajeAnterior?.tipo === 'entregado' ? viajeAnterior.precio : null)
    if (base === null) return null
    return base + recargoServicioMonto
  })()
  const distanciaEfectiva = calcResult?.km ?? draft?.distanciaKm ?? null

  // Coord efectiva de entrega: para fuera_managua usa el punto logístico
  const entregaCoordEfectiva: LatLng | null =
    esFueraManagua && puntoLogisticoSeleccionado
      ? puntoLogisticoSeleccionado.coord
      : entrega.coord


  useEffect(() => {
    if (!puntosFavoritos.length) return
    const first = puntosFavoritos.find(f => f.key !== '__otro__')
    if (first && retiro.favKey === '__otro__' && !retiro.nombre && !draft) {
      seleccionarFavorito(first)
    }
  }, [puntosFavoritos])

  const seleccionarFavorito = (fav: PuntoFavorito) => {
    if (fav.key === '__otro__') {
      setRetiro(prev => ({ ...blankRetiro(), favKey: '__otro__' }))
      return
    }
    setRetiro({
      favKey: fav.key,
      nombre: fav.nombre || fav.label || '',
      celular: fav.celular || '',
      direccion: fav.direccion || '',
      coord: fav.coord || null,
      tipoUbicacion: fav.tipoUbicacion || 'referencial',
    })
  }

  const handleGuardarComoFavorito = async () => {
    if (!newFavLabel.trim() || !comercioId) return
    setSavingNewFav(true)
    try {
      await guardarPuntoFavorito(comercioId, newFavLabel, retiro, geocodeRetiro)
      setShowGuardarFav(false)
      setNewFavLabel('')
      setMsg({ type: 'success', text: `⭐ "${newFavLabel}" guardado como favorito.` })
    } catch (e) {
      console.error(e)
    } finally {
      setSavingNewFav(false)
    }
  }

  const handleInvertir = () => {
    const r = { ...retiro }
    const e = { ...entrega }
    setRetiro({ favKey: '__otro__', nombre: e.nombre, celular: e.celular, direccion: e.direccion, coord: e.coord, tipoUbicacion: e.tipoUbicacion })
    setEntrega({ nombre: r.nombre, celular: r.celular, direccion: r.direccion, coord: r.coord, tipoUbicacion: r.tipoUbicacion })
  }

  const handleQuitarCotizacion = () => {
    try { sessionStorage.removeItem('draftEnvio') } catch {}
    setDraft(null)
    setCalcResult(null)
    lastCalcKey.current = null
    setMsg({ type: 'info', text: 'Cotización quitada. Calculá el precio con los puntos del mapa.' })
  }

  const handleSelectEntrega = (c: ClienteGuardado) => {
    setEntrega({
      nombre: c.nombre || '',
      celular: c.celular || '',
      direccion: c.direccion || '',
      coord: c.coord || null,
      tipoUbicacion: c.tipoUbicacion || 'referencial',
    })
    if (c.coord) { setCalcResult(null); lastCalcKey.current = null }
  }

  useEffect(() => {
    if (esFueraManagua) {
      setCobroCE(false)
      if (quienPagaDelivery === 'entrega') setQuienPagaDelivery('')
    }
    if (!esFueraManagua || metodoFueraManagua !== 'cargotrans') setPagoCargotrans('')
  }, [esFueraManagua, metodoFueraManagua])

  // ── Validation ──
  const camposFaltantes = useMemo(() => {
    const f: string[] = []
    if (!retiro.nombre.trim()) f.push('Nombre de retiro')
    if (!retiro.celular.trim()) f.push('Celular de retiro')
    else if (!validarCelular(retiro.celular)) f.push('Celular de retiro — 8 dígitos')
    if (!retiro.direccion.trim()) f.push('Dirección de retiro')
    if (!esFueraManagua) {
      if (!entrega.nombre.trim()) f.push('Nombre de entrega')
      if (!entrega.celular.trim()) f.push('Celular de entrega')
      else if (!validarCelular(entrega.celular)) f.push('Celular de entrega — 8 dígitos')
      if (!entrega.direccion.trim()) f.push('Dirección de entrega')
    }
    if (!esFueraManagua && cobroCE && (montoCE === '' || Number(montoCE) <= 0)) f.push('Monto del cobro contra entrega')
    if (esFueraManagua && metodoFueraManagua === 'cargotrans' && !pagoCargotrans) f.push('Forma de pago del flete de Cargotrans')
    if (tipoCliente === 'contado' && !quienPagaDelivery) f.push('Quién paga el delivery')
    if (esProgramado && (tipoProgramado === 'retiro' || tipoProgramado === 'ambos') && !fechaRetiro) f.push('Fecha de retiro programado')
    if (esProgramado && (tipoProgramado === 'entrega' || tipoProgramado === 'ambos') && !fechaEntrega) f.push('Fecha de entrega programada')
    if (esFueraManagua && metodoFueraManagua === 'bus_terminal') {
      if (!destinoFinal.trim()) f.push('Destino del paquete (fuera de Managua)')
      else if (!puntoLogisticoSeleccionado) f.push('Seleccioná la terminal de buses')
    }
    return f
  }, [retiro, entrega, cobroCE, montoCE, pagoCargotrans, tipoCliente, quienPagaDelivery, esProgramado, tipoProgramado, fechaRetiro, fechaEntrega, esFueraManagua, metodoFueraManagua, destinoFinal, puntoLogisticoSeleccionado])

  const formularioCompleto = camposFaltantes.length === 0

  // Per-step validation
  const puedeAvanzar = (desde: number): boolean => {
    if (desde === 1) {
      return retiro.nombre.trim() !== '' && validarCelular(retiro.celular) && retiro.direccion.trim() !== ''
    }
    if (desde === 2) {
      if (esFueraManagua) {
        if (metodoFueraManagua !== 'bus_terminal') return true
        if (!destinoFinal.trim() || !puntoLogisticoSeleccionado) return false
        // When multiple terminals match, the selection must belong to the current list (prevents stale state)
        if (terminalesSugeridas.length > 1) return terminalesSugeridas.some(t => t.id === puntoLogisticoSeleccionado!.id)
        return true
      }
      return entrega.nombre.trim() !== '' && validarCelular(entrega.celular) && entrega.direccion.trim() !== ''
    }
    if (desde === 3) {
      if (esFueraManagua && metodoFueraManagua === 'cargotrans' && !pagoCargotrans) return false
      if (tipoCliente === 'credito') return true
      return quienPagaDelivery !== ''
    }
    return true
  }

  const handleSiguiente = async () => {
    if (!puedeAvanzar(paso)) return
    if (paso === 2 && esFueraManagua && puntoLogisticoSeleccionado && retiro.coord) {
      const o = retiro.coord
      const d = puntoLogisticoSeleccionado.coord
      const key = `${o.lat.toFixed(5)},${o.lng.toFixed(5)}-${d.lat.toFixed(5)},${d.lng.toFixed(5)}`
      if (key !== lastCalcKey.current || !calcResult) {
        lastCalcKey.current = key
        setCalcLoading(true)
        setCalcError(null)
        try {
          const result = await calcularDistancia(o, d)
          if (result) setCalcResult(result)
        } catch {}
        setCalcLoading(false)
      }
    }
    setPaso(p => Math.min(p + 1, 4))
    window.scrollTo({ top: 0, behavior: 'smooth' })
  }

  const handleAtras = () => {
    setPaso(p => Math.max(p - 1, 1))
    window.scrollTo({ top: 0, behavior: 'smooth' })
  }

  // ── Price summary ──
  const montoProducto = cobroCE && montoCE !== '' ? Number(montoCE) : 0
  const montoDelivery = precioEfectivo ?? 0

  const destinatarioPagaTotal = useMemo(() => {
    if (!cobroCE) return montoDelivery
    if (tipoCliente !== 'contado') return montoProducto
    if (quienPagaDelivery === 'entrega') return deducirDelivery === 'deducir_del_cobro' ? montoProducto : montoProducto + montoDelivery
    return montoProducto
  }, [cobroCE, montoProducto, montoDelivery, tipoCliente, quienPagaDelivery, deducirDelivery])

  const montoADepositarComercio = useMemo(() => {
    if (!cobroCE) return 0
    if (tipoCliente !== 'contado') return montoProducto
    if (quienPagaDelivery === 'entrega') return deducirDelivery === 'deducir_del_cobro' ? Math.max(montoProducto - montoDelivery, 0) : montoProducto
    return montoProducto
  }, [cobroCE, montoProducto, montoDelivery, tipoCliente, quienPagaDelivery, deducirDelivery])

  // ── Save ──
  const handleGuardar = async () => {
    setMsg(null)
    if (!formularioCompleto) { setMsg({ type: 'error', text: `Completá: ${camposFaltantes.join(', ')}.` }); return }
    try {
      setSaving(true)
      const user = auth.currentUser
      if (!user) { setMsg({ type: 'error', text: 'No hay sesión iniciada.' }); return }
      if (!comercioId) { setMsg({ type: 'error', text: 'No se pudo resolver el comercio de tu cuenta. Recargá la página.' }); return }

      const zonasActivas = await getZonasActivas()
      const {
        zonaRetiroId, zonaRetiroNombre,
        zonaEntregaId, zonaEntregaNombre,
        macroZonaRetiroId, macroZonaRetiroNombre,
        macroZonaEntregaId, macroZonaEntregaNombre,
      } = clasificarOrdenCompleto(
        retiro.coord || null,
        esFueraManagua && puntoLogisticoSeleccionado ? puntoLogisticoSeleccionado.coord : entrega.coord || null,
        zonasActivas
      )

      const recargoFinal = calcularRecargoZona(
        zonaRetiroNombre ?? macroZonaRetiroNombre ?? null,
        zonaEntregaNombre ?? macroZonaEntregaNombre ?? null,
      )

      const deducirAplica = tipoCliente === 'contado' && cobroCE && quienPagaDelivery === 'entrega' && deducirDelivery === 'deducir_del_cobro'
      const tieneCalculo = !!calcResult || !!draft

      await addDoc(collection(db, 'solicitudes_envio'), {
        userId: comercioId,
        comercioUid: comercioId,
        ownerSnapshot: {
          uid: comercioId,
          companyName: ownerCompanyName || '',
        },
        tipoCliente,
        tieneCotizacion: tieneCalculo,
        cotizacion: tieneCalculo
          ? {
              origenCoord: retiro.coord || draft?.origenCoord || null,
              destinoCoord: (esFueraManagua && puntoLogisticoSeleccionado)
                ? puntoLogisticoSeleccionado.coord
                : entrega.coord || draft?.destinoCoord || null,
              distanciaKm: distanciaEfectiva ?? null,
              precioSugerido: precioEfectivo ?? null,
              origenTextoGoogle: null,
              destinoTextoGoogle: null,
            }
          : {
              origenTextoGoogle: null, destinoTextoGoogle: null, origenCoord: null, destinoCoord: null, distanciaKm: null, precioSugerido: null,
              ...(viajeAnterior?.tipo === 'entregado' ? { fuentePrecio: 'viaje_anterior' } : {}),
            },
        recoleccion: {
          favoritoKey: retiro.favKey,
          nombreApellido: retiro.nombre.trim(),
          celular: retiro.celular.trim(),
          direccionEscrita: retiro.direccion.trim(),
          coord: retiro.coord || null,
          geocodeGoogle: geocodeRetiro.trim() || null,
          puntoGoogleTipo: retiro.tipoUbicacion,
          notaMotorizado: notaRetiro.trim() || null,
        },
        entrega: {
          nombreApellido: entrega.nombre.trim(),
          celular: entrega.celular.trim(),
          direccionEscrita: entrega.direccion.trim(),
          coord: entrega.coord || null,
          geocodeGoogle: geocodeEntrega.trim() || null,
          puntoGoogleTipo: entrega.tipoUbicacion,
          notaMotorizado: notaEntrega.trim() || null,
        },
        cobroContraEntrega: { aplica: esFueraManagua ? false : cobroCE, monto: esFueraManagua ? 0 : (cobroCE ? Number(montoCE) : 0) },
        pagoDelivery: tipoCliente === 'credito'
          ? { tipo: 'credito_semanal', quienPaga: 'credito_semanal', montoSugerido: precioEfectivo }
          : { tipo: 'contado', quienPaga: quienPagaDelivery, montoSugerido: precioEfectivo, deducirDelCobroContraEntrega: deducirAplica },
        paquete: (fragil || grande) ? {
          fragil,
          grande,
          notaPaquete: notaPaquete.trim() || null,
        } : null,
        detalle: detalle.trim(),
        numeroOrden: numeroOrden.trim() || null,
        programado: esProgramado
          ? {
              tipo: tipoProgramado,
              retiro: (tipoProgramado === 'retiro' || tipoProgramado === 'ambos') && fechaRetiro
                ? { fecha: fechaRetiro, hora: horaRetiro || null, fechaHoraISO: horaRetiro ? `${fechaRetiro}T${horaRetiro}` : fechaRetiro }
                : null,
              entrega: (tipoProgramado === 'entrega' || tipoProgramado === 'ambos') && fechaEntrega
                ? { fecha: fechaEntrega, hora: horaEntrega || null, fechaHoraISO: horaEntrega ? `${fechaEntrega}T${horaEntrega}` : fechaEntrega }
                : null,
            }
          : null,
        estado: esProgramado ? 'programada' : 'pendiente_confirmacion',
        requiereBolso: comercioRequiereBolso,
        zonaRetiroId,
        zonaRetiroNombre,
        zonaEntregaId,
        zonaEntregaNombre,
        macroZonaRetiroId,
        macroZonaRetiroNombre,
        macroZonaEntregaId,
        macroZonaEntregaNombre,
        recargoZona: recargoFinal,
        tipoServicio,
        ...(esFueraManagua ? {
          fueraManagua: {
            metodoEnvio: metodoFueraManagua,
            destinoFinal: destinoFinal.trim() || null,
            puntoLogisticoId: puntoLogisticoSeleccionado?.id ?? null,
            puntoLogisticoNombre: puntoLogisticoSeleccionado?.nombre ?? null,
            puntoLogisticoTipo: puntoLogisticoSeleccionado?.tipo ?? null,
            coordsPuntoLogistico: puntoLogisticoSeleccionado?.coord ?? null,
            direccionPuntoLogistico: puntoLogisticoSeleccionado?.direccion ?? null,
            horarioApertura: puntoLogisticoSeleccionado?.horarioApertura ?? null,
            horarioCierre: puntoLogisticoSeleccionado?.horarioCierre ?? null,
            notaPuntoLogistico: puntoLogisticoSeleccionado?.notas ?? null,
            ...(metodoFueraManagua === 'bus_terminal' ? {
              terminalSugerida: puntoLogisticoSeleccionado?.nombre ?? null,
              transporteNombre: transporteNombre.trim() || null,
              transporteCelular: transporteCelular.trim() || null,
              transporteHoraSalida: transporteHoraSalida.trim() || null,
              transporteNota: transporteNota.trim() || null,
            } : {
              cantidadPaquetes: Number(cantidadPaquetes) || 1,
              notaCargotrans: notaCargotrans.trim() || null,
              pagoCargotrans: pagoCargotrans || null,
            }),
          },
        } : {}),
        precioDesglose: precioEfectivo && precioEfectivo !== -1 && calcResult ? {
          deliveryBase: calcResult.precio,
          recargoZona: recargoFinal.aplica ? recargoFinal.monto : 0,
          recargoServicio: recargoServicioMonto,
          totalCobrado: precioEfectivo,
        } : null,
        gastosEspeciales: [],
        createdAt: serverTimestamp(),
      })

      await guardarClienteEntrega(comercioId, {
        nombre: entrega.nombre.trim(),
        celular: entrega.celular.trim(),
        direccion: entrega.direccion.trim(),
        coord: entrega.coord || undefined,
        tipoUbicacion: entrega.tipoUbicacion,
      })

      setMsg({ type: 'success', text: '✅ Solicitud enviada. El gestor la confirmará pronto.' })
      setShowOrdenToast(true)
      setPaso(1)

      const firstFav = puntosFavoritos.find(f => f.key !== '__otro__')
      if (firstFav) seleccionarFavorito(firstFav)
      else setRetiro(blankRetiro())
      setEntrega(blankEntrega())
      setCobroCE(false); setMontoCE(''); setQuienPagaDelivery(''); setDeducirDelivery('no_deducir'); setDetalle('')
      setCalcResult(null); lastCalcKey.current = null
      setNotaRetiro(''); setNotaEntrega(''); setShowNotaRetiro(false); setShowNotaEntrega(false)
      setFragil(false); setGrande(false); setNotaPaquete('')
      setShowGuardarFav(false); setNewFavLabel('')
      setNumeroOrden('')
      setEsProgramado(false); setTipoProgramado('retiro'); setFechaRetiro(''); setHoraRetiro(''); setFechaEntrega(''); setHoraEntrega('')
      setGeoRetiro(''); setGeoEntrega('')
      setEsFueraManagua(false); setMetodoFueraManagua('bus_terminal'); setDestinoFinal(''); setShowDetallesTransporte(false)
      setTransporteNombre(''); setTransporteCelular(''); setTransporteHoraSalida(''); setTransporteNota(''); setCantidadPaquetes('1'); setNotaCargotrans('')
      try { sessionStorage.removeItem('draftEnvio') } catch {}
      setDraft(null)
    } catch (err) {
      console.error(err)
      setMsg({ type: 'error', text: '❌ No se pudo guardar. Intentá de nuevo.' })
    } finally {
      setSaving(false)
    }
  }

  const esOtro = retiro.favKey === '__otro__'
  const todayISO = new Date().toISOString().split('T')[0]

  // ── Step validation hints ──


  return (
    <div style={{ maxWidth: 640, margin: '0 auto', padding: '52px 0 80px', fontFamily: "'SF Pro Display', -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif" }}>

      {/* ── Sticky header fijo en la parte superior ── */}
      <StickyOrderHeader
        precio={precioEfectivo}
        distanciaKm={distanciaEfectiva}
        zonaRetiro={zonaInfo.retiroNombre}
        zonaEntrega={zonaInfo.entregaNombre}
        retiroNombre={retiro.nombre || null}
        camposFaltantes={camposFaltantes.length}
        formularioCompleto={formularioCompleto}
      />

      {/* ── Header ── */}
      <div style={{ marginBottom: 8 }}>
        <h1 style={{ fontSize: 24, fontWeight: 800, color: '#111827', margin: '0 0 2px', letterSpacing: -0.5 }}>Solicitar envío</h1>
        <p style={{ fontSize: 13, color: '#6b7280', margin: 0 }}>Completá los datos en 4 pasos.</p>
      </div>

      {/* ── Success message ── */}
      {msg?.type === 'success' && (
        <div style={{ marginBottom: 16, borderRadius: 14, padding: '14px 16px', fontSize: 13, fontWeight: 600, background: '#f0fdf4', border: '1px solid #bbf7d0', color: '#16a34a' }}>
          {msg.text}
        </div>
      )}

      {/* ── Step Indicator ── */}
      <StepIndicator paso={paso} setPaso={setPaso} puedeAvanzar={puedeAvanzar} />

      {/* ═══════════════════════════════════════════════════════════════ */}
      {/* PASO 1: RETIRO                                                  */}
      {/* ═══════════════════════════════════════════════════════════════ */}
      {paso === 1 && (
        <div>
          <SectionCard title="Punto de retiro" icon="📦">
            {puntosFavoritos.length > 1 && (
              <div>
                <label style={S.label}>Lugar favorito</label>
                <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' as const }}>
                  {puntosFavoritos.map(fav => (
                    <button key={fav.key} type="button" onClick={() => seleccionarFavorito(fav)} style={{ padding: '8px 14px', borderRadius: 10, fontSize: 12, fontWeight: 700, cursor: 'pointer', border: `1px solid ${retiro.favKey === fav.key ? '#004aad' : '#e5e7eb'}`, background: retiro.favKey === fav.key ? '#eff6ff' : '#fff', color: retiro.favKey === fav.key ? '#004aad' : '#374151' }}>
                      {fav.key === '__otro__' ? 'Otro' : fav.label}
                    </button>
                  ))}
                </div>
                <p style={S.hint}>Configurá tus puntos favoritos en <strong>Ajustes</strong>.</p>
              </div>
            )}

            {!esOtro && retiro.coord && (
              <div style={{ background: '#f0fdf4', border: '1px solid #bbf7d0', borderRadius: 10, padding: '10px 14px' }}>
                <p style={{ fontSize: 12, fontWeight: 600, color: '#16a34a', margin: 0 }}>🎯 Ubicación guardada — se usará para calcular el precio</p>
              </div>
            )}

            <Field label="Nombre / empresa" required>
              <input value={retiro.nombre} onChange={e => setRetiro(prev => ({ ...prev, nombre: e.target.value, favKey: '__otro__' }))} placeholder="Ej: Tienda San Juan" style={S.input} />
            </Field>

            <Field label="Celular" required>
              <input
                value={retiro.celular}
                onChange={e => setRetiro(prev => ({ ...prev, celular: formatCelular(e.target.value) }))}
                placeholder="Ej: 88888888"
                maxLength={8}
                style={{ ...S.input, borderColor: retiro.celular && !validarCelular(retiro.celular) ? '#dc2626' : '#e5e7eb' }}
              />
              {retiro.celular && !validarCelular(retiro.celular) && (
                <p style={{ fontSize: 11, color: '#dc2626', margin: '4px 0 0', fontWeight: 600 }}>⚠️ Debe ser 8 dígitos</p>
              )}
            </Field>

            <Field label="Dirección escrita" required hint="Descripción para que el motorizado llegue.">
              <input value={retiro.direccion} onChange={e => setRetiro(prev => ({ ...prev, direccion: e.target.value }))} placeholder="Ej: Del semáforo 1c al sur, portón azul" style={S.input} />
            </Field>

            {!esOtro && retiro.coord ? (
              <StaticMiniMap
                key={`${retiro.coord.lat}-${retiro.coord.lng}`}
                coord={retiro.coord}
                color="#004aad"
                label="R"
              />
            ) : (
              <div>
                <label style={{ ...S.label, marginBottom: 8 }}>
                  Ubicación en el mapa
                  {retiro.coord && <span style={{ color: '#16a34a', fontWeight: 700, marginLeft: 8 }}>✓ Marcada</span>}
                </label>
                {draft?.origenCoord && retiro.coord && (
                  <p style={{ fontSize: 11, color: '#2563eb', background: '#eff6ff', border: '1px solid #bfdbfe', borderRadius: 8, padding: '5px 10px', margin: '0 0 8px', lineHeight: 1.4 }}>
                    📍 Punto pre-marcado desde la calculadora. Ajustá si es necesario.
                  </p>
                )}
                <MiniMap
                  coord={retiro.coord}
                  color="#004aad"
                  label="R"
                  onSelect={(c) => setRetiro(prev => ({ ...prev, coord: c }))}
                  onGeocode={(addr) => setGeoRetiro(addr)}
                />
              </div>
            )}

            <UbicacionTipo value={retiro.tipoUbicacion} onChange={v => setRetiro(prev => ({ ...prev, tipoUbicacion: v }))} />

            <NotaMotorizado
              show={showNotaRetiro}
              onToggle={() => setShowNotaRetiro(v => !v)}
              value={notaRetiro}
              onChange={setNotaRetiro}
              label="¿Hay instrucciones adicionales para el motorizado en el retiro?"
            />

            {esOtro && retiro.nombre.trim() && (
              <div>
                {!showGuardarFav ? (
                  <button
                    type="button"
                    onClick={() => { setNewFavLabel(retiro.nombre); setShowGuardarFav(true) }}
                    style={{ ...S.btnOutline, color: '#d46b08', borderColor: '#fed7aa', fontSize: 12 }}
                  >
                    ⭐ Guardar como punto favorito
                  </button>
                ) : (
                  <div style={{ background: '#fffbe6', border: '1px solid #ffe58f', borderRadius: 12, padding: '14px 16px' }}>
                    <p style={{ fontSize: 13, fontWeight: 700, color: '#d46b08', margin: '0 0 10px' }}>⭐ Guardar como punto favorito</p>
                    <label style={S.label}>Nombre del lugar <span style={{ color: '#dc2626' }}>*</span></label>
                    <input
                      value={newFavLabel}
                      onChange={e => setNewFavLabel(e.target.value)}
                      placeholder='Ej: Tienda principal, Bodega norte...'
                      style={{ ...S.input, marginBottom: 8 }}
                    />
                    <p style={{ fontSize: 11, color: '#9ca3af', margin: '0 0 10px' }}>
                      Aparecerá en futuros envíos como punto rápido.
                    </p>
                    <div style={{ display: 'flex', gap: 8 }}>
                      <button
                        type="button"
                        onClick={handleGuardarComoFavorito}
                        disabled={savingNewFav || !newFavLabel.trim()}
                        style={{ padding: '8px 16px', borderRadius: 10, border: 'none', background: '#d46b08', color: '#fff', fontSize: 13, fontWeight: 700, cursor: 'pointer' }}
                      >
                        {savingNewFav ? 'Guardando...' : '⭐ Guardar'}
                      </button>
                      <button type="button" onClick={() => { setShowGuardarFav(false); setNewFavLabel('') }} style={S.btnOutline}>
                        Cancelar
                      </button>
                    </div>
                  </div>
                )}
              </div>
            )}
          </SectionCard>

        </div>
      )}

      {/* ═══════════════════════════════════════════════════════════════ */}
      {/* PASO 2: ENTREGA                                                 */}
      {/* ═══════════════════════════════════════════════════════════════ */}
      {paso === 2 && (
        <div>

          {/* Tipo de entrega */}
          <div style={{ ...S.sectionCard }}>
            <p style={{ fontSize: 11, fontWeight: 700, textTransform: 'uppercase' as const, letterSpacing: 0.5, color: '#9ca3af', margin: '0 0 10px' }}>Tipo de entrega</p>
            <div style={{ display: 'flex', gap: 8 }}>
              {([
                { val: false, label: '📍 Dentro de Managua', desc: 'Retiro y entrega en la ciudad' },
                { val: true,  label: '🌍 Fuera de Managua',  desc: 'Bus / terminal o Cargotrans' },
              ] as { val: boolean; label: string; desc: string }[]).map(opt => (
                <button
                  key={String(opt.val)}
                  type="button"
                  onClick={() => {
                    if (opt.val === esFueraManagua) return
                    if (opt.val) {
                      // → Fuera de Managua
                      if (entrega.coord || entrega.nombre || calcResult || draft) {
                        const ok = window.confirm('¿Cambiar a envío fuera de Managua?\n\nSe borrará el punto de entrega y la cotización. Tendrás que empezar de nuevo.')
                        if (!ok) return
                      }
                      setCalcResult(null); lastCalcKey.current = null
                      setDraft(null); try { sessionStorage.removeItem('draftEnvio') } catch {}
                      setEntrega(blankEntrega())
                    } else {
                      // → Dentro de Managua
                      if (destinoFinal || puntoLogisticoSeleccionado) {
                        const ok = window.confirm('¿Volver a envío dentro de Managua?\n\nSe borrará la información del envío fuera de Managua. Tendrás que empezar de nuevo.')
                        if (!ok) return
                      }
                      setDestinoFinal(''); setMetodoFueraManagua('bus_terminal'); setShowDetallesTransporte(false)
                      setTransporteNombre(''); setTransporteCelular(''); setTransporteHoraSalida(''); setTransporteNota('')
                      setCantidadPaquetes('1'); setNotaCargotrans(''); setPuntoLogisticoSeleccionado(null)
                      setTerminalesSugeridas([]); setPagoCargotrans('')
                    }
                    setEsFueraManagua(opt.val)
                  }}
                  style={{ flex: 1, textAlign: 'left' as const, padding: '12px 14px', borderRadius: 12, cursor: 'pointer', border: `2px solid ${esFueraManagua === opt.val ? (opt.val ? '#7c3aed' : '#004aad') : '#e5e7eb'}`, background: esFueraManagua === opt.val ? (opt.val ? '#f5f3ff' : '#eff6ff') : '#fff' }}
                >
                  <p style={{ fontSize: 13, fontWeight: 700, color: esFueraManagua === opt.val ? (opt.val ? '#7c3aed' : '#004aad') : '#111827', margin: '0 0 2px' }}>{opt.label}</p>
                  <p style={{ fontSize: 11, color: '#6b7280', margin: 0 }}>{opt.desc}</p>
                </button>
              ))}
            </div>
          </div>

          {/* Dentro de Managua: flujo normal */}
          {!esFueraManagua && (
          <SectionCard title="Punto de entrega" icon="🏠">
            <div>
              <div style={{ display: 'flex', alignItems: 'flex-end', gap: 8 }}>
                <div style={{ flex: 1 }}>
                  <AutocompleteInput
                    label="Nombre del destinatario"
                    value={entrega.nombre}
                    onChange={v => setEntrega(prev => ({ ...prev, nombre: v }))}
                    onSelect={handleSelectEntrega}
                    placeholder="Ej: María García"
                    clientes={clientesEntrega}
                    required
                  />
                </div>
                <button
                  type="button"
                  onClick={() => setShowClienteModal(true)}
                  style={{
                    ...S.btnOutline,
                    padding: '10px 14px',
                    fontSize: 13,
                    fontWeight: 700,
                    whiteSpace: 'nowrap' as const,
                    borderColor: '#004aad',
                    color: '#004aad',
                    background: '#eff6ff',
                    height: 42,
                  }}
                >
                  🔍 Buscar
                </button>
              </div>
            </div>

            <div>
              <AutocompleteInput
                label="Celular"
                value={entrega.celular}
                onChange={v => setEntrega(prev => ({ ...prev, celular: formatCelular(v) }))}
                onSelect={handleSelectEntrega}
                placeholder="Ej: 77777777"
                clientes={clientesEntrega}
                required
              />
              {entrega.celular && !validarCelular(entrega.celular) && (
                <p style={{ fontSize: 11, color: '#dc2626', margin: '4px 0 0', fontWeight: 600 }}>⚠️ Debe ser 8 dígitos</p>
              )}
            </div>

            <Field label="Dirección escrita" required hint="Descripción detallada para que el motorizado llegue.">
              <input value={entrega.direccion} onChange={e => setEntrega(prev => ({ ...prev, direccion: e.target.value }))} placeholder="Ej: Frente al parque, portón negro" style={S.input} />
            </Field>

            <div>
              <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 8 }}>
                <label style={{ ...S.label, marginBottom: 0 }}>
                  Ubicación en el mapa
                  {entrega.coord && <span style={{ color: '#16a34a', fontWeight: 700, marginLeft: 8 }}>✓ Marcada</span>}
                </label>
                {(calcResult || draft) && entrega.coord && (
                  <button
                    type="button"
                    onClick={() => {
                      const ok = window.confirm('¿Cambiar el punto de entrega?\n\nSe perderá el precio y la distancia de la cotización. Tendrás que calcular de nuevo.')
                      if (!ok) return
                      setCalcResult(null)
                      lastCalcKey.current = null
                      setDraft(null)
                      try { sessionStorage.removeItem('draftEnvio') } catch {}
                    }}
                    style={{ fontSize: 11, fontWeight: 600, color: '#d97706', background: '#fffbeb', border: '1px solid #fcd34d', borderRadius: 8, padding: '4px 10px', cursor: 'pointer' }}
                  >
                    ✏️ Cambiar punto
                  </button>
                )}
              </div>
              <MiniMap
                coord={entrega.coord}
                color="#16a34a"
                label="E"
                locked={!!(calcResult || draft)}
                onSelect={(c) => { setEntrega(prev => ({ ...prev, coord: c })); setCalcResult(null); lastCalcKey.current = null }}
                onGeocode={(addr) => setGeoEntrega(addr)}
              />
            </div>

            <UbicacionTipo value={entrega.tipoUbicacion} onChange={v => setEntrega(prev => ({ ...prev, tipoUbicacion: v }))} />

            <NotaMotorizado
              show={showNotaEntrega}
              onToggle={() => setShowNotaEntrega(v => !v)}
              value={notaEntrega}
              onChange={setNotaEntrega}
              label="¿Hay instrucciones adicionales para el motorizado en la entrega?"
            />
          </SectionCard>
          )}

          {/* Fuera de Managua: flujo especializado */}
          {esFueraManagua && (
          <div style={{ ...S.sectionCard }}>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>

              {/* Método de envío */}
              <div>
                <label style={S.label}>¿Cómo se enviará?</label>
                <div style={{ display: 'flex', gap: 8 }}>
                  {([
                    { value: 'bus_terminal' as MetodoFueraManagua, label: '🚌 Bus / terminal', desc: 'Terminal de buses' },
                    { value: 'cargotrans' as MetodoFueraManagua, label: '📦 Cargotrans', desc: 'Sucursal más cercana' },
                  ]).map(opt => (
                    <button
                      key={opt.value}
                      type="button"
                      onClick={() => { setMetodoFueraManagua(opt.value); setPuntoLogisticoSeleccionado(null); setTerminalesSugeridas([]); setCalcResult(null) }}
                      style={{ flex: 1, textAlign: 'left' as const, padding: '10px 12px', borderRadius: 10, cursor: 'pointer', border: `1.5px solid ${metodoFueraManagua === opt.value ? '#7c3aed' : '#e5e7eb'}`, background: metodoFueraManagua === opt.value ? '#f5f3ff' : '#fff' }}
                    >
                      <p style={{ fontSize: 13, fontWeight: 700, color: metodoFueraManagua === opt.value ? '#7c3aed' : '#111827', margin: '0 0 2px' }}>{opt.label}</p>
                      <p style={{ fontSize: 11, color: '#6b7280', margin: 0 }}>{opt.desc}</p>
                    </button>
                  ))}
                </div>
              </div>

              {/* Bus / terminal */}
              {metodoFueraManagua === 'bus_terminal' && (
                <>
                  <Field label="Destino del paquete" required hint="Ciudad o departamento al que va el paquete">
                    <input
                      value={destinoFinal}
                      onChange={e => setDestinoFinal(e.target.value)}
                      placeholder="Ej: Matagalpa, Estelí, León..."
                      style={S.input}
                    />

                    {/* 1 resultado → auto-seleccionado */}
                    {terminalesSugeridas.length === 1 && puntoLogisticoSeleccionado && (
                      <div style={{ marginTop: 6, background: '#f5f3ff', border: '1px solid #ddd6fe', borderRadius: 8, padding: '8px 12px' }}>
                        <p style={{ fontSize: 12, fontWeight: 700, color: '#7c3aed', margin: '0 0 2px' }}>📍 Terminal sugerida: <strong>{puntoLogisticoSeleccionado.nombre}</strong></p>
                        {puntoLogisticoSeleccionado.direccion && <p style={{ fontSize: 11, color: '#6b7280', margin: '0 0 1px' }}>📌 {puntoLogisticoSeleccionado.direccion}</p>}
                        {(puntoLogisticoSeleccionado.horarioApertura || puntoLogisticoSeleccionado.horarioCierre) && (
                          <p style={{ fontSize: 11, color: '#6b7280', margin: 0 }}>🕐 {puntoLogisticoSeleccionado.horarioApertura || '?'}–{puntoLogisticoSeleccionado.horarioCierre || '?'}</p>
                        )}
                      </div>
                    )}

                    {/* Múltiples resultados → elegir */}
                    {terminalesSugeridas.length > 1 && (
                      <div style={{ marginTop: 6, background: '#eff6ff', border: `1px solid ${!puntoLogisticoSeleccionado || !terminalesSugeridas.some(t => t.id === puntoLogisticoSeleccionado?.id) ? '#93c5fd' : '#bfdbfe'}`, borderRadius: 8, padding: '8px 12px' }}>
                        <p style={{ fontSize: 12, fontWeight: 700, color: '#1d4ed8', margin: '0 0 6px' }}>
                          🏢 Encontramos más de una terminal compatible. <span style={{ color: '#dc2626' }}>Seleccioná la preferida para continuar:</span>
                        </p>
                        <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
                          {terminalesSugeridas.map(p => (
                            <button key={p.id} type="button" onClick={() => setPuntoLogisticoSeleccionado(p)}
                              style={{ textAlign: 'left' as const, padding: '6px 10px', borderRadius: 8, cursor: 'pointer', border: `1.5px solid ${puntoLogisticoSeleccionado?.id === p.id ? '#7c3aed' : '#bfdbfe'}`, background: puntoLogisticoSeleccionado?.id === p.id ? '#f5f3ff' : '#fff', fontSize: 12, fontWeight: 600, color: '#374151' }}>
                              🏢 {p.nombre}
                              {p.direccion && <span style={{ fontSize: 11, color: '#6b7280', display: 'block', fontWeight: 400 }}>{p.direccion}</span>}
                            </button>
                          ))}
                        </div>
                      </div>
                    )}

                    {/* Sin resultado → selección manual */}
                    {destinoFinal.trim().length >= 2 && terminalesSugeridas.length === 0 && (
                      <div style={{ marginTop: 6, background: '#fef9c3', border: '1px solid #fde68a', borderRadius: 8, padding: '8px 12px' }}>
                        <p style={{ fontSize: 12, color: '#92400e', margin: '0 0 6px', fontWeight: 600 }}>⚠️ No encontramos terminal automáticamente para este destino. Seleccioná manualmente:</p>
                        <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
                          {puntosLogisticos.filter(p => p.activo && p.tipo === 'terminal_bus').map(p => (
                            <button key={p.id} type="button" onClick={() => setPuntoLogisticoSeleccionado(p)}
                              style={{ textAlign: 'left' as const, padding: '6px 10px', borderRadius: 8, cursor: 'pointer', border: `1.5px solid ${puntoLogisticoSeleccionado?.id === p.id ? '#7c3aed' : '#e5e7eb'}`, background: puntoLogisticoSeleccionado?.id === p.id ? '#f5f3ff' : '#fff', fontSize: 12, fontWeight: 600, color: '#374151' }}>
                              🏢 {p.nombre}
                            </button>
                          ))}
                        </div>
                      </div>
                    )}
                  </Field>

                  <button
                    type="button"
                    onClick={() => setShowDetallesTransporte(v => !v)}
                    style={{ textAlign: 'left' as const, padding: '8px 12px', borderRadius: 8, border: '1px solid #e5e7eb', background: '#f9fafb', cursor: 'pointer', fontSize: 12, color: '#6b7280', fontWeight: 600 }}
                  >
                    {showDetallesTransporte ? '▲' : '▼'} ¿Tenés información del transporte? (opcional)
                  </button>

                  {showDetallesTransporte && (
                    <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
                      <Field label="Nombre del transporte / bus" hint="Ej: Cotran Norte, El Exprés, Transnica...">
                        <input value={transporteNombre} onChange={e => setTransporteNombre(e.target.value)} placeholder="Ej: Cotran Norte..." style={S.input} />
                      </Field>
                      <Field label="Celular del transporte">
                        <input value={transporteCelular} onChange={e => setTransporteCelular(formatCelular(e.target.value))} placeholder="Ej: 88888888" maxLength={8} style={S.input} />
                      </Field>
                      <Field label="Hora de salida de Managua">
                        <input type="time" value={transporteHoraSalida} onChange={e => setTransporteHoraSalida(e.target.value)} style={S.input} />
                      </Field>
                      <Field label="Nota adicional">
                        <textarea value={transporteNota} onChange={e => setTransporteNota(e.target.value)} placeholder="Instrucciones adicionales..." style={{ ...S.input, resize: 'vertical' as const, minHeight: 60 }} rows={2} />
                      </Field>
                    </div>
                  )}
                </>
              )}

              {/* Cargotrans */}
              {metodoFueraManagua === 'cargotrans' && (
                <>
                  <Field label="Cantidad de paquetes">
                    <input type="number" min="1" value={cantidadPaquetes} onChange={e => setCantidadPaquetes(e.target.value)} placeholder="1" style={S.input} />
                  </Field>
                  <Field label="Nota">
                    <textarea value={notaCargotrans} onChange={e => setNotaCargotrans(e.target.value)} placeholder="Instrucciones o detalles del envío..." style={{ ...S.input, resize: 'vertical' as const, minHeight: 60 }} rows={2} />
                  </Field>
                  {puntoLogisticoSeleccionado ? (
                    <div style={{ background: '#f0fdf4', border: '1px solid #bbf7d0', borderRadius: 8, padding: '10px 12px' }}>
                      <p style={{ fontSize: 12, fontWeight: 700, color: '#16a34a', margin: '0 0 2px' }}>📍 Sucursal sugerida: <strong>{puntoLogisticoSeleccionado.nombre}</strong></p>
                      {puntoLogisticoSeleccionado.direccion && <p style={{ fontSize: 11, color: '#6b7280', margin: '0 0 1px' }}>📌 {puntoLogisticoSeleccionado.direccion}</p>}
                      {(puntoLogisticoSeleccionado.horarioApertura || puntoLogisticoSeleccionado.horarioCierre) && (
                        <p style={{ fontSize: 11, color: '#6b7280', margin: 0 }}>🕐 {puntoLogisticoSeleccionado.horarioApertura || '?'}–{puntoLogisticoSeleccionado.horarioCierre || '?'}</p>
                      )}
                    </div>
                  ) : (
                    <div style={{ background: '#fef3c7', border: '1px solid #fde68a', borderRadius: 8, padding: '10px 12px' }}>
                      <p style={{ fontSize: 12, color: '#92400e', margin: 0 }}>📦 Storkhub buscará la sucursal Cargotrans más cercana a tu punto de retiro.</p>
                    </div>
                  )}
                </>
              )}

            </div>
          </div>
          )}

          {/* Paquete */}
          <SectionCard title="Datos del paquete" icon="📦">
            <div style={{ display: 'flex', gap: 20, flexWrap: 'wrap' as const }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                <button type="button" onClick={() => setFragil(v => !v)} style={{ width: 20, height: 20, borderRadius: 4, border: `2px solid ${fragil ? '#dc2626' : '#d1d5db'}`, background: fragil ? '#dc2626' : '#fff', display: 'flex', alignItems: 'center', justifyContent: 'center', cursor: 'pointer', flexShrink: 0 }}>
                  {fragil && <span style={{ color: '#fff', fontSize: 12, fontWeight: 900 }}>✓</span>}
                </button>
                <label style={{ fontSize: 13, fontWeight: 600, color: '#374151', cursor: 'pointer' }} onClick={() => setFragil(v => !v)}>🥚 Paquete frágil</label>
              </div>
              <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                <button type="button" onClick={() => setGrande(v => !v)} style={{ width: 20, height: 20, borderRadius: 4, border: `2px solid ${grande ? '#d46b08' : '#d1d5db'}`, background: grande ? '#d46b08' : '#fff', display: 'flex', alignItems: 'center', justifyContent: 'center', cursor: 'pointer', flexShrink: 0 }}>
                  {grande && <span style={{ color: '#fff', fontSize: 12, fontWeight: 900 }}>✓</span>}
                </button>
                <label style={{ fontSize: 13, fontWeight: 600, color: '#374151', cursor: 'pointer' }} onClick={() => setGrande(v => !v)}>📦 Grande / voluminoso</label>
              </div>
            </div>
            {(fragil || grande) && (
              <Field
                label={grande ? 'Descripción / dimensiones' : 'Descripción del contenido (opcional)'}
                hint={grande ? 'Ayudá al motorizado a entender el tamaño.' : 'Ej: vidrio, cerámica, electrónico...'}
              >
                <input value={notaPaquete} onChange={e => setNotaPaquete(e.target.value)} placeholder={grande ? 'Ej: Caja 60×40cm, televisor 32"...' : 'Ej: botella de vidrio, pantalla...'} style={S.input} />
              </Field>
            )}
            {!fragil && !grande && (
              <p style={{ fontSize: 12, color: '#9ca3af', margin: 0 }}>Marcá si el paquete requiere cuidado especial o es de gran tamaño.</p>
            )}
          </SectionCard>

          {/* Programar envío */}
          <SectionCard title="Programar envío" icon="📅">
            <div>
              <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                <button type="button" onClick={() => setEsProgramado(v => !v)} style={{ width: 20, height: 20, borderRadius: 4, border: `2px solid ${esProgramado ? '#004aad' : '#d1d5db'}`, background: esProgramado ? '#004aad' : '#fff', display: 'flex', alignItems: 'center', justifyContent: 'center', cursor: 'pointer', flexShrink: 0 }}>
                  {esProgramado && <span style={{ color: '#fff', fontSize: 12, fontWeight: 900 }}>✓</span>}
                </button>
                <label style={{ fontSize: 14, fontWeight: 600, color: '#111827', cursor: 'pointer' }} onClick={() => setEsProgramado(v => !v)}>
                  ¿Es un envío programado?
                </label>
              </div>

              {esProgramado && (
                <div style={{ marginTop: 14, display: 'flex', flexDirection: 'column', gap: 14 }}>
                  <div>
                    <label style={S.label}>¿Qué programar?</label>
                    <div style={{ display: 'flex', gap: 8 }}>
                      {([
                        { value: 'retiro', label: '📦 Retiro' },
                        { value: 'entrega', label: '🏠 Entrega' },
                        { value: 'ambos', label: '↕ Ambos' },
                      ] as { value: 'retiro' | 'entrega' | 'ambos'; label: string }[]).map(opt => (
                        <button key={opt.value} type="button" onClick={() => setTipoProgramado(opt.value)} style={{ flex: 1, padding: '8px 10px', borderRadius: 10, fontSize: 12, fontWeight: 700, cursor: 'pointer', border: `1px solid ${tipoProgramado === opt.value ? '#004aad' : '#e5e7eb'}`, background: tipoProgramado === opt.value ? '#eff6ff' : '#fff', color: tipoProgramado === opt.value ? '#004aad' : '#374151' }}>
                          {opt.label}
                        </button>
                      ))}
                    </div>
                  </div>

                  {(tipoProgramado === 'retiro' || tipoProgramado === 'ambos') && (
                    <div>
                      {tipoProgramado === 'ambos' && <p style={{ fontSize: 12, fontWeight: 700, color: '#374151', margin: '0 0 8px' }}>📦 Fecha de retiro</p>}
                      <div style={{ display: 'flex', gap: 12, flexWrap: 'wrap' as const }}>
                        <div style={{ flex: 1, minWidth: 140 }}>
                          <label style={S.label}>Fecha <span style={{ color: '#dc2626' }}>*</span></label>
                          <input type="date" value={fechaRetiro} onChange={e => setFechaRetiro(e.target.value)} min={todayISO} style={S.input} />
                        </div>
                        <div style={{ flex: 1, minWidth: 140 }}>
                          <label style={S.label}>Hora (opcional)</label>
                          <input type="time" value={horaRetiro} onChange={e => setHoraRetiro(e.target.value)} style={S.input} />
                        </div>
                      </div>
                    </div>
                  )}

                  {(tipoProgramado === 'entrega' || tipoProgramado === 'ambos') && (
                    <div>
                      {tipoProgramado === 'ambos' && <p style={{ fontSize: 12, fontWeight: 700, color: '#374151', margin: '0 0 8px' }}>🏠 Fecha de entrega</p>}
                      <div style={{ display: 'flex', gap: 12, flexWrap: 'wrap' as const }}>
                        <div style={{ flex: 1, minWidth: 140 }}>
                          <label style={S.label}>Fecha <span style={{ color: '#dc2626' }}>*</span></label>
                          <input type="date" value={fechaEntrega} onChange={e => setFechaEntrega(e.target.value)} min={tipoProgramado === 'ambos' && fechaRetiro ? fechaRetiro : todayISO} style={S.input} />
                        </div>
                        <div style={{ flex: 1, minWidth: 140 }}>
                          <label style={S.label}>Hora (opcional)</label>
                          <input type="time" value={horaEntrega} onChange={e => setHoraEntrega(e.target.value)} style={S.input} />
                        </div>
                      </div>
                    </div>
                  )}
                </div>
              )}
            </div>
          </SectionCard>

        </div>
      )}

      {/* ═══════════════════════════════════════════════════════════════ */}
      {/* PASO 3: PAGO                                                    */}
      {/* ═══════════════════════════════════════════════════════════════ */}
      {paso === 3 && (
        <div>
          {/* Tipo cliente (definido en el perfil del comercio) */}
          <div style={{ ...S.sectionCard, marginBottom: 16, background: tipoCliente === 'credito' ? '#f5f3ff' : '#f9fafb', border: `1px solid ${tipoCliente === 'credito' ? '#ddd6fe' : '#e5e7eb'}` }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 10 }}>
              <div>
                <p style={{ fontSize: 14, fontWeight: 700, color: '#111827', margin: '0 0 2px' }}>Tipo de pago</p>
                <p style={{ fontSize: 12, color: '#6b7280', margin: 0 }}>Configurado en el perfil de tu comercio</p>
              </div>
              <span style={{ padding: '6px 14px', borderRadius: 10, fontSize: 13, fontWeight: 700, background: tipoCliente === 'credito' ? '#7c3aed' : '#374151', color: '#fff' }}>
                {tipoCliente === 'credito' ? '🗓 Crédito semanal' : '💵 Contado'}
              </span>
            </div>
          </div>

          <SectionCard title="Pagos" icon="💰">
            {!esFueraManagua && (
              <div>
                <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 8 }}>
                  <button type="button" onClick={() => setCobroCE(!cobroCE)} style={{ width: 20, height: 20, borderRadius: 4, border: `2px solid ${cobroCE ? '#004aad' : '#d1d5db'}`, background: cobroCE ? '#004aad' : '#fff', display: 'flex', alignItems: 'center', justifyContent: 'center', cursor: 'pointer', flexShrink: 0 }}>
                    {cobroCE && <span style={{ color: '#fff', fontSize: 12, fontWeight: 900 }}>✓</span>}
                  </button>
                  <label style={{ fontSize: 14, fontWeight: 600, color: '#111827', cursor: 'pointer' }} onClick={() => setCobroCE(!cobroCE)}>
                    Hay cobro contra entrega (el motorizado cobra el producto)
                  </label>
                </div>
                {cobroCE && (
                  <div style={{ marginLeft: 30 }}>
                    <label style={S.label}>Monto del producto (C$) <span style={{ color: '#dc2626' }}>*</span></label>
                    <input type="number" value={montoCE} onChange={e => setMontoCE(e.target.value === '' ? '' : Number(e.target.value))} placeholder="Ej: 1500" style={{ ...S.input, maxWidth: 200 }} />
                  </div>
                )}
              </div>
            )}

            {esFueraManagua && metodoFueraManagua === 'cargotrans' && (
              <div>
                <label style={S.label}>¿Cómo se paga el flete de Cargotrans? <span style={{ color: '#dc2626' }}>*</span></label>
                <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
                  {([
                    { value: 'efectivo_motorizado', label: '💵 El comercio entrega el efectivo al motorizado', desc: 'El motorizado recibirá el efectivo y pagará en Cargotrans al llegar.' },
                    { value: 'transferencia_comercio', label: '📲 El comercio transfiere directamente a Cargotrans', desc: 'Cuando estemos llegando al punto te avisaremos para que realices la transferencia a las cuentas de Cargotrans.' },
                  ] as { value: PagoCargotrans; label: string; desc: string }[]).map(opt => (
                    <button key={opt.value} type="button" onClick={() => setPagoCargotrans(opt.value)}
                      style={{ textAlign: 'left' as const, padding: '12px 14px', borderRadius: 10, cursor: 'pointer', border: `1px solid ${pagoCargotrans === opt.value ? '#004aad' : '#e5e7eb'}`, background: pagoCargotrans === opt.value ? '#eff6ff' : '#fff' }}>
                      <p style={{ fontSize: 13, fontWeight: 700, color: pagoCargotrans === opt.value ? '#004aad' : '#111827', margin: '0 0 2px' }}>{opt.label}</p>
                      <p style={{ fontSize: 11, color: '#6b7280', margin: 0 }}>{opt.desc}</p>
                    </button>
                  ))}
                </div>
                {pagoCargotrans === 'transferencia_comercio' && (
                  <div style={{ marginTop: 10, background: '#fffbe6', border: '1px solid #ffe58f', borderRadius: 10, padding: '12px 14px' }}>
                    <p style={{ fontSize: 13, fontWeight: 700, color: '#d46b08', margin: '0 0 4px' }}>⚠️ Importante</p>
                    <p style={{ fontSize: 12, color: '#92400e', margin: 0, lineHeight: 1.5 }}>
                      Cuando el motorizado esté llegando al punto de Cargotrans, te notificaremos para que realices la transferencia a las cuentas indicadas. Asegurate de estar pendiente del aviso.
                    </p>
                  </div>
                )}
              </div>
            )}

            {tipoCliente === 'credito' ? (
              <div style={{ background: '#eff6ff', border: '1px solid #bfdbfe', borderRadius: 10, padding: '12px 14px' }}>
                <p style={{ fontSize: 13, fontWeight: 700, color: '#2563eb', margin: '0 0 2px' }}>📅 Cliente con crédito semanal</p>
                <p style={{ fontSize: 12, color: '#3b82f6', margin: 0 }}>El delivery se cobra al comercio semanalmente.</p>
              </div>
            ) : (
              <div>
                <label style={S.label}>¿Quién paga el delivery? <span style={{ color: '#dc2626' }}>*</span></label>
                <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
                  {[
                    { value: 'recoleccion', label: '🏁 Se paga en la recolección', desc: 'El motorizado cobra el delivery al retirar' },
                    ...(!esFueraManagua ? [{ value: 'entrega', label: '🏠 Lo paga el destinatario (entrega)', desc: 'El motorizado cobra el delivery al entregar' }] : []),
                    { value: 'transferencia', label: '🏦 Ya se pagó por transferencia', desc: 'El delivery fue pagado previamente' },
                  ].map(opt => (
                    <button key={opt.value} type="button" onClick={() => setQuienPagaDelivery(opt.value as QuienPagaDelivery)} style={{ textAlign: 'left' as const, padding: '12px 14px', borderRadius: 10, cursor: 'pointer', border: `1px solid ${quienPagaDelivery === opt.value ? '#004aad' : '#e5e7eb'}`, background: quienPagaDelivery === opt.value ? '#eff6ff' : '#fff' }}>
                      <p style={{ fontSize: 13, fontWeight: 700, color: quienPagaDelivery === opt.value ? '#004aad' : '#111827', margin: '0 0 2px' }}>{opt.label}</p>
                      <p style={{ fontSize: 11, color: '#6b7280', margin: 0 }}>{opt.desc}</p>
                    </button>
                  ))}
                </div>
                {cobroCE && quienPagaDelivery === 'entrega' && (
                  <div style={{ marginTop: 12, background: '#fffbe6', border: '1px solid #ffe58f', borderRadius: 10, padding: '12px 14px' }}>
                    <label style={{ fontSize: 13, fontWeight: 700, color: '#d46b08', display: 'block', marginBottom: 10 }}>¿Deducir el delivery del cobro del producto?</label>
                    <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
                      {([
                        {
                          value: 'no_deducir',
                          label: 'No deducir',
                          desc: montoCE !== '' && montoDelivery > 0
                            ? `Destinatario paga C$ ${montoProducto} (producto) + C$ ${montoDelivery} (delivery) = C$ ${montoProducto + montoDelivery}. Se te deposita C$ ${montoProducto}.`
                            : montoCE !== ''
                              ? `Destinatario paga C$ ${montoProducto} (producto) + delivery por separado. Se te deposita C$ ${montoProducto}.`
                              : 'Destinatario paga producto + delivery por separado. Se te deposita el monto del producto.',
                        },
                        {
                          value: 'deducir_del_cobro',
                          label: 'Sí, deducir',
                          desc: montoCE !== '' && montoDelivery > 0
                            ? `Destinatario paga solo C$ ${montoProducto}. El delivery (C$ ${montoDelivery}) sale de ahí. Se te deposita C$ ${Math.max(montoProducto - montoDelivery, 0)}.`
                            : montoCE !== ''
                              ? `Destinatario paga solo C$ ${montoProducto}. El delivery sale de ahí. Se te deposita C$ ${montoProducto} − delivery.`
                              : 'El delivery se descuenta del cobro. El destinatario paga menos y vos recibís menos.',
                        },
                      ] as { value: string; label: string; desc: string }[]).map(opt => (
                        <button
                          key={opt.value}
                          type="button"
                          onClick={() => setDeducirDelivery(opt.value as DeducirDelivery)}
                          style={{ textAlign: 'left' as const, padding: '10px 12px', borderRadius: 8, cursor: 'pointer', border: `1.5px solid ${deducirDelivery === opt.value ? '#d46b08' : '#e5e7eb'}`, background: deducirDelivery === opt.value ? '#fff7ed' : '#fff' }}
                        >
                          <p style={{ fontSize: 13, fontWeight: 700, color: deducirDelivery === opt.value ? '#d46b08' : '#374151', margin: '0 0 3px' }}>
                            {deducirDelivery === opt.value ? '● ' : '○ '}{opt.label}
                          </p>
                          <p style={{ fontSize: 11, color: deducirDelivery === opt.value ? '#92400e' : '#6b7280', margin: 0, lineHeight: 1.4 }}>
                            {opt.desc}
                          </p>
                        </button>
                      ))}
                    </div>
                  </div>
                )}
              </div>
            )}

            <Field label="Número de orden / referencia" hint="Código interno para identificar el pedido (opcional).">
              <input value={numeroOrden} onChange={e => setNumeroOrden(e.target.value)} placeholder="Ej: #ORD-001 o número de pedido de WhatsApp" style={S.input} />
            </Field>

            <div>
              <label style={S.label}>Instrucciones adicionales <span style={{ color: '#9ca3af', fontWeight: 400 }}>(opcional)</span></label>
              <textarea value={detalle} onChange={e => setDetalle(e.target.value)} placeholder="Ej: Entregar entre 2-4pm. Llamar antes de llegar." style={{ ...S.input, resize: 'vertical' as const, minHeight: 80 }} rows={3} />
            </div>
          </SectionCard>

        </div>
      )}

      {/* ═══════════════════════════════════════════════════════════════ */}
      {/* PASO 4: CONFIRMAR                                               */}
      {/* ═══════════════════════════════════════════════════════════════ */}
      {paso === 4 && (
        <div>
          {/* Cotización banner */}
          {(tieneCotizacion || viajeAnterior) && (
            <div style={{
              ...S.sectionCard, marginBottom: 16,
              background: tieneCotizacion ? (coordsModificadas ? '#fffbe6' : '#f0fdf4') : '#fefce8',
              border: `1px solid ${tieneCotizacion ? (coordsModificadas ? '#ffe58f' : '#bbf7d0') : '#fef08a'}`,
            }}>
              {tieneCotizacion && (
                <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
                  <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', flexWrap: 'wrap' as const, gap: 8 }}>
                    <div>
                      {coordsModificadas ? (
                        <>
                          <p style={{ fontSize: 13, fontWeight: 700, color: '#d46b08', margin: '0 0 3px' }}>
                            ⚠️ Modificaste el punto de{' '}
                            {coordsModificadasInfo.retiro && coordsModificadasInfo.entrega
                              ? 'retiro y entrega'
                              : coordsModificadasInfo.retiro
                              ? 'retiro'
                              : 'entrega'}
                          </p>
                          <p style={{ fontSize: 12, color: '#92400e', margin: 0 }}>
                            El precio de la cotización original ya no aplica. Calculá de nuevo con los puntos actuales.
                          </p>
                        </>
                      ) : (
                        <>
                          <p style={{ fontSize: 13, fontWeight: 700, color: '#16a34a', margin: '0 0 2px' }}>✅ Cotización desde calculadora</p>
                          <p style={{ fontSize: 12, color: '#6b7280', margin: 0 }}>
                            {precioSugerido ? `Precio base: C$ ${precioSugerido}` : 'Sin precio base'}
                          </p>
                        </>
                      )}
                    </div>
                    <div style={{ display: 'flex', gap: 8, flexShrink: 0 }}>
                      <button type="button" onClick={handleQuitarCotizacion} style={S.btnOutline}>Quitar</button>
                      <button type="button" onClick={handleInvertir} style={S.btnOutline}>↕</button>
                    </div>
                  </div>
                  {coordsModificadas && retiro.coord && entregaCoordEfectiva && (
                    <button
                      type="button"
                      onClick={handleCalcular}
                      disabled={calcLoading}
                      style={{ padding: '10px 16px', borderRadius: 10, border: 'none', background: '#d46b08', color: '#fff', fontSize: 13, fontWeight: 700, cursor: 'pointer', width: '100%' }}
                    >
                      {calcLoading ? '⏳ Calculando...' : '🧮 Calcular precio con puntos actuales'}
                    </button>
                  )}
                </div>
              )}
              {!tieneCotizacion && viajeAnterior && !calcResult && (
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', flexWrap: 'wrap' as const, gap: 8 }}>
                  <div>
                    {viajeAnterior.tipo === 'entregado' ? (
                      <>
                        <p style={{ fontSize: 13, fontWeight: 700, color: '#15803d', margin: '0 0 2px' }}>🔍 Viaje similar encontrado</p>
                        <p style={{ fontSize: 12, color: '#166534', margin: 0 }}>Precio cargado automáticamente: <strong>C$ {viajeAnterior.precio}</strong> · Basado en un viaje anterior entregado. Sujeto a confirmación del gestor.</p>
                      </>
                    ) : (
                      <>
                        <p style={{ fontSize: 13, fontWeight: 700, color: '#854d0e', margin: '0 0 2px' }}>📋 Cotización previa encontrada</p>
                        <p style={{ fontSize: 12, color: '#713f12', margin: 0 }}>Costo de referencia: <strong>C$ {viajeAnterior.precio}</strong>. Calculá para confirmar el precio actual.</p>
                      </>
                    )}
                  </div>
                  {retiro.coord && entregaCoordEfectiva && (
                    <button type="button" onClick={handleCalcular} disabled={calcLoading} style={{ ...S.btnOutline, fontSize: 11, flexShrink: 0 }}>
                      {calcLoading ? '⏳' : '🧮 Recalcular'}
                    </button>
                  )}
                </div>
              )}
            </div>
          )}

          {/* Banner fuera de Managua */}
          {esFueraManagua && (
            <div style={{ background: '#f5f3ff', border: '1px solid #ddd6fe', borderRadius: 14, padding: '14px 16px', marginBottom: 16 }}>
              <p style={{ fontSize: 14, fontWeight: 800, color: '#7c3aed', margin: '0 0 8px' }}>
                {metodoFueraManagua === 'bus_terminal' ? '🚌 Envío fuera de Managua — Bus / terminal' : '📦 Envío fuera de Managua — Cargotrans'}
              </p>
              <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
                {destinoFinal && <p style={{ fontSize: 13, color: '#374151', margin: 0 }}>📍 Destino: <strong>{destinoFinal}</strong></p>}
                {puntoLogisticoSeleccionado && (
                  <p style={{ fontSize: 13, color: '#7c3aed', margin: 0 }}>
                    🏢 {metodoFueraManagua === 'bus_terminal' ? 'Terminal' : 'Sucursal'}: <strong>{puntoLogisticoSeleccionado.nombre}</strong>
                  </p>
                )}
                {metodoFueraManagua === 'bus_terminal' && transporteNombre && <p style={{ fontSize: 13, color: '#374151', margin: 0 }}>🚌 Transporte: <strong>{transporteNombre}</strong></p>}
                {metodoFueraManagua === 'bus_terminal' && transporteCelular && <p style={{ fontSize: 13, color: '#374151', margin: 0 }}>📱 Celular: {transporteCelular}</p>}
                {metodoFueraManagua === 'bus_terminal' && transporteHoraSalida && <p style={{ fontSize: 13, color: '#374151', margin: 0 }}>⏰ Salida: {transporteHoraSalida}</p>}
                {metodoFueraManagua === 'cargotrans' && cantidadPaquetes && <p style={{ fontSize: 13, color: '#374151', margin: 0 }}>📦 Paquetes: <strong>{cantidadPaquetes}</strong></p>}
              </div>
            </div>
          )}

          {/* Resumen de puntos */}
          <div style={{ ...S.sectionCard, marginBottom: 16 }}>
            <div style={S.sectionHeader}>
              <span style={{ fontSize: 20 }}>🗺️</span>
              <h3 style={{ fontSize: 15, fontWeight: 800, color: '#111827', margin: 0 }}>Resumen del envío</h3>
            </div>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
              <div style={{ background: '#eff6ff', border: '1px solid #bfdbfe', borderRadius: 10, padding: '12px 14px' }}>
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', marginBottom: 4 }}>
                  <p style={{ fontSize: 11, fontWeight: 700, color: '#6b7280', textTransform: 'uppercase' as const, letterSpacing: 0.5, margin: 0 }}>📦 Retiro</p>
                  {zonaInfo.retiroNombre && (
                    <span style={{ fontSize: 10, fontWeight: 700, color: '#004aad', background: '#dbeafe', borderRadius: 6, padding: '2px 7px' }}>{zonaInfo.retiroNombre}</span>
                  )}
                </div>
                <p style={{ fontSize: 14, fontWeight: 700, color: '#111827', margin: '0 0 2px' }}>{retiro.nombre}</p>
                <p style={{ fontSize: 12, color: '#6b7280', margin: '0 0 2px' }}>📱 {retiro.celular}</p>
                <p style={{ fontSize: 12, color: '#6b7280', margin: 0 }}>📍 {retiro.direccion}</p>
              </div>
              <div style={{ background: '#f0fdf4', border: '1px solid #bbf7d0', borderRadius: 10, padding: '12px 14px' }}>
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', marginBottom: 4 }}>
                  <p style={{ fontSize: 11, fontWeight: 700, color: '#6b7280', textTransform: 'uppercase' as const, letterSpacing: 0.5, margin: 0 }}>
                    {esFueraManagua && puntoLogisticoSeleccionado
                      ? (metodoFueraManagua === 'cargotrans' ? '📦 Sucursal Cargotrans' : '🏢 Terminal')
                      : '🏠 Entrega'}
                  </p>
                  {zonaInfo.entregaNombre && !esFueraManagua && (
                    <span style={{ fontSize: 10, fontWeight: 700, color: '#16a34a', background: '#dcfce7', borderRadius: 6, padding: '2px 7px' }}>{zonaInfo.entregaNombre}</span>
                  )}
                </div>
                {esFueraManagua && puntoLogisticoSeleccionado ? (
                  <>
                    <p style={{ fontSize: 14, fontWeight: 700, color: '#111827', margin: '0 0 2px' }}>{puntoLogisticoSeleccionado.nombre}</p>
                    {puntoLogisticoSeleccionado.direccion && <p style={{ fontSize: 12, color: '#6b7280', margin: '0 0 2px' }}>📌 {puntoLogisticoSeleccionado.direccion}</p>}
                    {(puntoLogisticoSeleccionado.horarioApertura || puntoLogisticoSeleccionado.horarioCierre) && (
                      <p style={{ fontSize: 12, color: '#6b7280', margin: 0 }}>🕐 {puntoLogisticoSeleccionado.horarioApertura || '?'}–{puntoLogisticoSeleccionado.horarioCierre || '?'}</p>
                    )}
                    {destinoFinal && <p style={{ fontSize: 12, color: '#7c3aed', margin: '4px 0 0', fontWeight: 600 }}>📍 Destino final: {destinoFinal}</p>}
                  </>
                ) : (
                  <>
                    <p style={{ fontSize: 14, fontWeight: 700, color: '#111827', margin: '0 0 2px' }}>{entrega.nombre}</p>
                    <p style={{ fontSize: 12, color: '#6b7280', margin: '0 0 2px' }}>📱 {entrega.celular}</p>
                    <p style={{ fontSize: 12, color: '#6b7280', margin: 0 }}>📍 {entrega.direccion}</p>
                  </>
                )}
              </div>
            </div>
          </div>

          {/* Route preview map */}
          {(retiro.coord || entregaCoordEfectiva) && (
            <div style={{ ...S.sectionCard, marginBottom: 16 }}>
              <div style={S.sectionHeader}>
                <span style={{ fontSize: 20 }}>📍</span>
                <h3 style={{ fontSize: 15, fontWeight: 800, color: '#111827', margin: 0 }}>Vista de ruta</h3>
              </div>
              <RoutePreviewMap origen={retiro.coord} destino={entregaCoordEfectiva} />
              <div style={{ display: 'flex', gap: 16, marginTop: 10 }}>
                <span style={{ fontSize: 12, color: '#004aad' }}>● Retiro</span>
                <span style={{ fontSize: 12, color: '#16a34a' }}>● Entrega</span>
              </div>
            </div>
          )}

          {/* Precio */}
          <div style={{ ...S.sectionCard, background: '#f8fafc', border: '1px solid #e2e8f0', marginBottom: 16 }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 12 }}>
              <h3 style={{ fontSize: 14, fontWeight: 700, color: '#374151', margin: 0, textTransform: 'uppercase' as const, letterSpacing: 0.5 }}>Precio estimado</h3>
              {calcLoading && <span style={{ fontSize: 12, color: '#6b7280' }}>⏳ Calculando...</span>}
            </div>

            {calcError && <p style={{ fontSize: 13, color: '#dc2626', margin: '0 0 10px' }}>⚠️ {calcError}</p>}

            {calcResult ? (
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', background: '#fff', border: '1px solid #bfdbfe', borderRadius: 12, padding: '14px 16px' }}>
                <div>
                  <p style={{ fontSize: 11, fontWeight: 700, color: '#9ca3af', textTransform: 'uppercase' as const, letterSpacing: 0.5, margin: '0 0 4px' }}>Calculado</p>
                  {calcResult.precio === -1 ? (
                    <p style={{ fontSize: 28, fontWeight: 900, color: '#d97706', margin: 0 }}>Consultar</p>
                  ) : (
                    <p style={{ fontSize: 28, fontWeight: 900, color: '#004aad', margin: 0, letterSpacing: -1 }}>C$ {calcResult.precio + recargoMonto + recargoServicioMonto}</p>
                  )}
                  <p style={{ fontSize: 12, color: '#6b7280', margin: '4px 0 0' }}>{calcResult.km.toFixed(2)} km · sujeto a confirmación</p>
                </div>
                <button type="button" onClick={handleCalcular} disabled={calcLoading} style={{ ...S.btnOutline, fontSize: 11 }}>
                  Recalcular
                </button>
              </div>
            ) : precioSugerido ? (
              <div>
                <div style={{ background: '#fff', border: '1px solid #bbf7d0', borderRadius: 12, padding: '14px 16px', marginBottom: 10 }}>
                  <p style={{ fontSize: 11, fontWeight: 700, color: '#9ca3af', textTransform: 'uppercase' as const, letterSpacing: 0.5, margin: '0 0 4px' }}>Desde cotización previa</p>
                  <p style={{ fontSize: 28, fontWeight: 900, color: '#004aad', margin: 0 }}>C$ {precioSugerido}</p>
                  {distanciaEfectiva && <p style={{ fontSize: 12, color: '#6b7280', margin: '4px 0 0' }}>{distanciaEfectiva.toFixed(2)} km</p>}
                </div>
                {retiro.coord && entregaCoordEfectiva && (
                  <button type="button" onClick={handleCalcular} disabled={calcLoading} style={{ width: '100%', padding: '10px', borderRadius: 10, border: '1px solid #bfdbfe', background: '#eff6ff', color: '#004aad', fontSize: 13, fontWeight: 700, cursor: 'pointer' }}>
                    🧮 Recalcular con los puntos del mapa
                  </button>
                )}
              </div>
            ) : viajeAnterior?.tipo === 'entregado' ? (
              <div>
                <div style={{ background: '#fff', border: '1px solid #bbf7d0', borderRadius: 12, padding: '14px 16px', marginBottom: 10 }}>
                  <p style={{ fontSize: 11, fontWeight: 700, color: '#9ca3af', textTransform: 'uppercase' as const, letterSpacing: 0.5, margin: '0 0 4px' }}>Desde viaje anterior entregado</p>
                  <p style={{ fontSize: 28, fontWeight: 900, color: '#004aad', margin: 0 }}>C$ {viajeAnterior.precio}</p>
                  <p style={{ fontSize: 12, color: '#6b7280', margin: '4px 0 0' }}>Sujeto a confirmación del gestor</p>
                </div>
                {retiro.coord && entregaCoordEfectiva && (
                  <button type="button" onClick={handleCalcular} disabled={calcLoading} style={{ width: '100%', padding: '10px', borderRadius: 10, border: '1px solid #bfdbfe', background: '#eff6ff', color: '#004aad', fontSize: 13, fontWeight: 700, cursor: 'pointer' }}>
                    🧮 Recalcular con los puntos del mapa
                  </button>
                )}
              </div>
            ) : retiro.coord && entregaCoordEfectiva ? (
              <div style={{ background: '#fffbe6', border: '1px solid #ffe58f', borderRadius: 12, padding: '14px 16px', textAlign: 'center' as const }}>
                <p style={{ fontSize: 13, color: '#d46b08', fontWeight: 600, margin: '0 0 12px' }}>
                  Calculá el precio estimado antes de enviar.
                </p>
                <button type="button" onClick={handleCalcular} disabled={calcLoading} style={{ padding: '10px 20px', borderRadius: 10, border: 'none', background: '#d46b08', color: '#fff', fontSize: 14, fontWeight: 700, cursor: 'pointer' }}>
                  🧮 Calcular precio estimado
                </button>
              </div>
            ) : (
              <p style={{ fontSize: 13, color: '#9ca3af', margin: 0 }}>Marcá los puntos en el mapa (pasos 1 y 2) para poder calcular.</p>
            )}
          </div>

          {/* Resumen de cobros */}
          <div style={{ ...S.sectionCard, background: '#f8fafc', border: '1px solid #e2e8f0', marginBottom: 16 }}>
            <p style={{ fontSize: 13, fontWeight: 700, color: '#374151', margin: '0 0 12px', textTransform: 'uppercase' as const, letterSpacing: 0.5 }}>Resumen de cobros</p>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
              {cobroCE && montoCE !== '' && (
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                  <span style={{ fontSize: 13, color: '#6b7280' }}>Producto</span>
                  <span style={{ fontSize: 15, fontWeight: 700, color: '#7c3aed' }}>C$ {montoProducto}</span>
                </div>
              )}
              {calcResult && precioEfectivo !== -1 ? (
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                  <span style={{ fontSize: 13, fontWeight: 700, color: '#004aad' }}>Total delivery</span>
                  <span style={{ fontSize: 15, fontWeight: 700, color: '#004aad' }}>C$ {precioEfectivo}</span>
                </div>
              ) : (
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                  <span style={{ fontSize: 13, color: '#6b7280' }}>
                    Delivery {precioEfectivo
                      ? calcResult
                        ? '(calculado)'
                        : precioSugerido
                        ? '(cotización)'
                        : '(viaje anterior)'
                      : '(a confirmar)'}
                  </span>
                  <span style={{ fontSize: 15, fontWeight: 700, color: '#004aad' }}>{precioEfectivo ? `C$ ${precioEfectivo}` : '—'}</span>
                </div>
              )}
              {cobroCE && tipoCliente === 'contado' && quienPagaDelivery === 'entrega' && montoDelivery > 0 && (
                <>
                  <div style={{ display: 'flex', justifyContent: 'space-between' }}>
                    <span style={{ fontSize: 12, color: '#374151' }}>{deducirDelivery === 'deducir_del_cobro' ? 'Total destinatario' : 'Total motorizado cobrará'}</span>
                    <span style={{ fontSize: 13, fontWeight: 700 }}>C$ {destinatarioPagaTotal}</span>
                  </div>
                  <div style={{ display: 'flex', justifyContent: 'space-between' }}>
                    <span style={{ fontSize: 12, color: '#16a34a' }}>Se te depositará</span>
                    <span style={{ fontSize: 13, fontWeight: 700, color: '#16a34a' }}>C$ {montoADepositarComercio}</span>
                  </div>
                </>
              )}
              <div style={{ borderTop: '1px solid #e2e8f0', paddingTop: 10, display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                <span style={{ fontSize: 14, fontWeight: 700, color: '#111827' }}>Total estimado</span>
                <span style={{ fontSize: 20, fontWeight: 900, color: '#111827' }}>
                  {cobroCE && tipoCliente === 'contado' && quienPagaDelivery === 'entrega' && montoDelivery > 0
                    ? `C$ ${destinatarioPagaTotal}`
                    : precioEfectivo ? `C$ ${precioEfectivo}` : '—'}
                </span>
              </div>
            </div>
          </div>

          {/* Condiciones de pago */}
          <div style={{ ...S.sectionCard, background: '#f8fafc', border: '1px solid #e2e8f0', marginBottom: 16 }}>
            <p style={{ fontSize: 13, fontWeight: 700, color: '#374151', margin: '0 0 12px', textTransform: 'uppercase' as const, letterSpacing: 0.5 }}>Condiciones de pago</p>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
              {/* Tipo de cliente */}
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                <span style={{ fontSize: 13, color: '#6b7280' }}>Tipo de cliente</span>
                <span style={{
                  fontSize: 12, fontWeight: 700, padding: '3px 10px', borderRadius: 8,
                  background: tipoCliente === 'credito' ? '#f5f3ff' : '#f1f5f9',
                  color: tipoCliente === 'credito' ? '#7c3aed' : '#374151',
                  border: `1px solid ${tipoCliente === 'credito' ? '#ddd6fe' : '#e2e8f0'}`,
                }}>
                  {tipoCliente === 'credito' ? '🗓 Crédito semanal' : '💵 Contado'}
                </span>
              </div>

              {/* Quien paga el delivery (contado) */}
              {tipoCliente === 'contado' && quienPagaDelivery && (
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                  <span style={{ fontSize: 13, color: '#6b7280' }}>Pago delivery</span>
                  <span style={{
                    fontSize: 12, fontWeight: 700, padding: '3px 10px', borderRadius: 8,
                    background: quienPagaDelivery === 'transferencia' ? '#eff6ff' : quienPagaDelivery === 'recoleccion' ? '#f0fdf4' : '#fff7ed',
                    color: quienPagaDelivery === 'transferencia' ? '#1d4ed8' : quienPagaDelivery === 'recoleccion' ? '#15803d' : '#c2410c',
                    border: `1px solid ${quienPagaDelivery === 'transferencia' ? '#bfdbfe' : quienPagaDelivery === 'recoleccion' ? '#bbf7d0' : '#fed7aa'}`,
                  }}>
                    {quienPagaDelivery === 'recoleccion' && '🟢 Al retiro'}
                    {quienPagaDelivery === 'entrega' && '🟠 En entrega'}
                    {quienPagaDelivery === 'transferencia' && '🔵 Transferencia bancaria'}
                  </span>
                </div>
              )}

              {/* Descripción del modo de pago */}
              {tipoCliente === 'contado' && quienPagaDelivery && (
                <p style={{ fontSize: 12, color: '#6b7280', margin: 0, paddingLeft: 0 }}>
                  {quienPagaDelivery === 'recoleccion' && 'El comercio le paga el delivery al motorizado al retirar el paquete.'}
                  {quienPagaDelivery === 'entrega' && (deducirDelivery === 'deducir_del_cobro' && cobroCE
                    ? 'El motorizado cobra al destinatario y descuenta el delivery del monto del producto.'
                    : 'El destinatario paga el delivery directamente al motorizado al recibir.')}
                  {quienPagaDelivery === 'transferencia' && 'El comercio realiza una transferencia bancaria a Storkhub por el monto del delivery.'}
                </p>
              )}

              {/* Cobro contra entrega */}
              {cobroCE && montoCE !== '' && (
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', borderTop: '1px solid #e2e8f0', paddingTop: 8, marginTop: 2 }}>
                  <span style={{ fontSize: 13, color: '#6b7280' }}>Cobro contra entrega</span>
                  <span style={{ fontSize: 13, fontWeight: 700, color: '#7c3aed' }}>C$ {montoProducto}</span>
                </div>
              )}
              {cobroCE && tipoCliente === 'contado' && quienPagaDelivery === 'entrega' && montoDelivery > 0 && (
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                  <span style={{ fontSize: 12, color: '#6b7280' }}>
                    {deducirDelivery === 'deducir_del_cobro' ? 'Delivery deducido del cobro' : 'Delivery se cobra aparte'}
                  </span>
                  <span style={{ fontSize: 12, fontWeight: 600, color: deducirDelivery === 'deducir_del_cobro' ? '#d97706' : '#6b7280' }}>
                    {deducirDelivery === 'deducir_del_cobro' ? `− C$ ${montoDelivery}` : `+ C$ ${montoDelivery}`}
                  </span>
                </div>
              )}

              {/* Pago flete Cargotrans */}
              {esFueraManagua && metodoFueraManagua === 'cargotrans' && pagoCargotrans && (
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', borderTop: '1px solid #e2e8f0', paddingTop: 8, marginTop: 2 }}>
                  <span style={{ fontSize: 13, color: '#6b7280' }}>Flete Cargotrans</span>
                  <span style={{
                    fontSize: 12, fontWeight: 700, padding: '3px 10px', borderRadius: 8,
                    background: pagoCargotrans === 'transferencia_comercio' ? '#eff6ff' : '#f0fdf4',
                    color: pagoCargotrans === 'transferencia_comercio' ? '#1d4ed8' : '#15803d',
                    border: `1px solid ${pagoCargotrans === 'transferencia_comercio' ? '#bfdbfe' : '#bbf7d0'}`,
                  }}>
                    {pagoCargotrans === 'efectivo_motorizado' ? '💵 Efectivo (comercio → motorizado)' : '🔵 Transferencia comercio'}
                  </span>
                </div>
              )}
            </div>
          </div>

          {/* Campos faltantes */}
          {!formularioCompleto && (
            <div style={{ background: '#fffbe6', border: '1px solid #ffe58f', borderRadius: 14, padding: '14px 16px', marginBottom: 16 }}>
              <p style={{ fontSize: 13, fontWeight: 700, color: '#d46b08', margin: '0 0 8px' }}>⚠️ Completar antes de enviar:</p>
              <ul style={{ margin: 0, padding: '0 0 0 18px' }}>
                {camposFaltantes.map(f => <li key={f} style={{ fontSize: 13, color: '#92400e', marginBottom: 2 }}>{f}</li>)}
              </ul>
            </div>
          )}

          {msg && msg.type !== 'success' && (
            <div style={{ marginBottom: 16, borderRadius: 14, padding: '14px 16px', fontSize: 13, fontWeight: 600, background: msg.type === 'error' ? '#fef2f2' : '#eff6ff', border: `1px solid ${msg.type === 'error' ? '#fecaca' : '#bfdbfe'}`, color: msg.type === 'error' ? '#dc2626' : '#2563eb' }}>
              {msg.text}
            </div>
          )}

        </div>
      )}

      {/* ── Sticky bottom nav ── */}
      <StickyBottomNav
        paso={paso}
        puedeAvanzar={puedeAvanzar(paso)}
        formularioCompleto={formularioCompleto}
        saving={saving}
        loading={calcLoading && paso === 2 && esFueraManagua}
        onAtras={handleAtras}
        onSiguiente={handleSiguiente}
        onGuardar={handleGuardar}
      />

      {/* ── MODAL BUSCADOR DE CLIENTES ── */}
      <ClienteSearchModal
        open={showClienteModal}
        onClose={() => setShowClienteModal(false)}
        onSelect={(c: ClienteModalItem) => {
          handleSelectEntrega({
            id: c.id,
            nombre: c.nombre,
            celular: c.celular,
            direccion: c.direccion,
            coord: c.coord,
            tipoUbicacion: c.tipoUbicacion as TipoUbicacion | undefined,
            totalViajes: c.totalViajes,
          })
        }}
        clientes={clientesEntrega.map((c) => ({
          id: c.id,
          nombre: c.nombre,
          celular: c.celular,
          direccion: c.direccion,
          coord: c.coord,
          tipoUbicacion: c.tipoUbicacion,
          totalViajes: c.totalViajes,
          totalEntregados: c.totalEntregados,
          comercioUid: uid || undefined,
        }))}
        comercioUidActual={uid || undefined}
        comercios={[]}
      />

      <ToastOrdenCreada
        show={showOrdenToast}
        onDismiss={() => setShowOrdenToast(false)}
      />
    </div>
  )
}
