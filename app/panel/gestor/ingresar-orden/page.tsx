'use client'

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
  addDoc,
  collection,
  doc,
  getDoc,
  getDocs,
  onSnapshot,
  query,
  serverTimestamp,
  setDoc,
  where,
} from 'firebase/firestore'
import { auth, db } from '@/fb/config'
import { useModuleGuard } from '../../_hooks/useModuleGuard'
import { getMapsLoader } from '@/lib/googleMaps'
import { getZonasActivas } from '@/fb/zonas'
import { clasificarOrdenCompleto, type ZonaGeografica } from '@/lib/zonas'
import { useResolucionPunto, pareceEntradaDirecta, MSG_ENTRADA_NO_RESUELTA } from '@/lib/useResolucionPunto'
import { obtenerDistanciaMetros } from '@/lib/distancia'
import { calcularRecargoZona, RECARGO_TERMINAL_BUS, type TipoServicio, type MetodoFueraManagua } from '@/lib/recargoZona'
import { getPuntosActivos } from '@/fb/puntosLogisticos'
import { type PuntoLogistico, sugerirPuntosParaDestino, encontrarCargotransMasCercano } from '@/lib/puntosLogisticos'
import { useSearchParams } from 'next/navigation'
import ClienteSearchModal, { ClienteModalItem } from '@/app/Components/ClienteSearchModal'
import ComercioSearchModal, { ComercioModalItem } from '@/app/Components/ComercioSearchModal'
import StepIndicator from './_components/StepIndicator'
import StickyOrderHeader from './_components/StickyOrderHeader'
import StaleCalcWarning from '@/app/Components/calculadora/StaleCalcWarning'

type LatLng = { lat: number; lng: number }
type TipoUbicacion = 'referencial' | 'exacto'
type TipoCliente = 'contado' | 'credito'
type QuienPagaDelivery = 'recoleccion' | 'entrega' | 'transferencia' | ''
type DeducirDelivery = 'no_deducir' | 'deducir_del_cobro'

type ComercioOption = {
  uid: string
  // Origen real de la fila, fijado al construirla desde cada colección:
  // 'comercio' -> comercios/{comercioId}, 'cliente' -> usuarios/{authUid} con
  // rol 'cliente'. El selector mezcla ambas, y para un cliente individual el
  // uid es un Auth UID de persona, NO un comercioId. Sin este discriminador no
  // hay forma segura de distinguirlos: companyName vacío, el nombre o el
  // formato del uid son heurísticas, no el origen del dato.
  tipo: 'comercio' | 'cliente'
  nombre: string
  email: string
  phone?: string
  companyName?: string
  address?: string
}

type ComercioData = {
  name?: string
  phone?: string
  address?: string
  puntosRetiro?: Record<string, any>
  requiereBolso?: boolean
  tipoCliente?: 'contado' | 'credito'
}

type ClienteGuardado = {
  id: string
  nombre: string
  celular: string
  direccion?: string
  nota?: string
  puntoGoogleTexto?: string
  coord?: LatLng
  tipoUbicacion?: TipoUbicacion
  comercioUid?: string
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
  nota: string
  coord: LatLng | null
  tipoUbicacion: TipoUbicacion
}

type EntregaState = {
  nombre: string
  celular: string
  direccion: string
  nota: string
  coord: LatLng | null
  tipoUbicacion: TipoUbicacion
}

type DraftEnvio = {
  origen?: string
  destino?: string
  origenCoord?: LatLng | null
  destinoCoord?: LatLng | null
  distanciaKm?: number | null
  precioCordobas?: number | null
  origenTipo?: TipoUbicacion
  destinoTipo?: TipoUbicacion
  origenDireccion?: string
}

// ─── Cache & Tariff ──────────────────────────────────────────────────────────

const CACHE_PREFIX = 'sol:'
const CACHE_TTL = 10 * 60 * 1000

function coordsMatch(a: LatLng | null, b: LatLng | null) {
  if (!a || !b) return false
  return Math.abs(a.lat - b.lat) < 0.00005 && Math.abs(a.lng - b.lng) < 0.00005
}

function tarifa(km: number): number {
  if (km < 2) return 70
  if (km < 4) return 80
  if (km < 6) return 90
  if (km < 8) return 110
  if (km < 10) return 120
  if (km < 12) return 130
  if (km < 14) return 150
  if (km < 16) return 160
  if (km < 18) return 180
  if (km < 20) return 190
  if (km < 22) return 210
  if (km < 24) return 220
  if (km < 26) return 240
  if (km < 28) return 250
  if (km < 30) return 270
  if (km < 32) return 280
  if (km < 34) return 300
  if (km < 36) return 310
  if (km < 38) return 330
  if (km < 40) return 340
  if (km < 42) return 360
  if (km < 44) return 370
  if (km < 46) return 390
  if (km < 48) return 400
  if (km < 50) return 420
  if (km < 52) return 430
  if (km < 54) return 440
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

/**
 * Pool universal de puntos (retiro y entrega).
 * Gestor ve todos. Resultados ordenados por prioridad:
 * 1. Del comercio seleccionado, 2. Globales (null), 3. Otros comercios
 */
function usePoolPuntos(comercioUid: string | null) {
  const [puntos, setPuntos] = useState<ClienteGuardado[]>([])
  useEffect(() => {
    const unsub = onSnapshot(collection(db, 'clientes_envio'), (snap) => {
      const all = snap.docs.map((d) => ({ id: d.id, ...(d.data() as any) })) as ClienteGuardado[]
      all.sort((a, b) => {
        const score = (uid: string | null | undefined) => {
          if (uid === comercioUid && comercioUid) return 0
          if (!uid) return 1
          return 2
        }
        return score(a.comercioUid) - score(b.comercioUid)
      })
      setPuntos(all)
    })
    return () => unsub()
  }, [comercioUid])
  return puntos
}

async function guardarPuntoRetiroPool(data: {
  nombre: string
  celular: string
  direccion?: string
  nota?: string
  coord?: LatLng | null
  tipoUbicacion?: TipoUbicacion
}) {
  if (!data.nombre?.trim() || !data.celular?.trim()) return
  const cel = data.celular.replace(/\D/g, '')
  const docId = `global_${cel}`
  const payload: Record<string, any> = {
    nombre: data.nombre.trim(),
    celular: data.celular.trim(),
    comercioUid: null,
    updatedAt: serverTimestamp(),
  }
  if (data.direccion?.trim()) payload.direccion = data.direccion.trim()
  if (data.nota?.trim()) payload.nota = data.nota.trim()
  if (data.coord) payload.coord = data.coord
  if (data.tipoUbicacion) payload.tipoUbicacion = data.tipoUbicacion
  await setDoc(doc(db, 'clientes_envio', docId), payload, { merge: true })
}

const CAMPOS_RESERVADOS_COMERCIO = new Set([
  'updatedAt',
  'createdAt',
  'name',
  'email',
  'phone',
  'activo',
  'rol',
  'uid',
  'userId',
  'companyName',
  'descripcion',
  'logo',
  'direccion',
  'website',
  'instagram',
  'facebook',
  'redes',
])

function usePuntosFavoritos(uid: string | null) {
  const [puntos, setPuntos] = useState<PuntoFavorito[]>([])

  useEffect(() => {
    if (!uid) {
      setPuntos([])
      return
    }

    const unsub = onSnapshot(doc(db, 'comercios', uid), (snap) => {
      if (!snap.exists()) {
        setPuntos([{ key: '__otro__', label: 'Otro' }])
        return
      }

      const data = snap.data() as Record<string, any>

      // Campos que NO son puntos de ubicación en la raíz del doc
      const NON_LOCATION_KEYS = new Set([
        'name', 'phone', 'address', 'accounts', 'updatedAt', 'activo',
        'rol', 'email', 'puntosRetiro', 'createdAt',
      ])

      const isLocationObject = (val: unknown): val is Record<string, any> => {
        if (typeof val !== 'object' || val === null || Array.isArray(val)) return false
        const v = val as Record<string, any>
        return !!(v.nombre || v.direccion || v.label || v.coord)
      }

      // Nueva estructura: data.puntosRetiro
      const newFormat: Record<string, any> = data?.puntosRetiro || {}

      // Estructura vieja: campos raíz como casa, oficina, etc.
      const legacyFormat: Record<string, any> = Object.fromEntries(
        Object.entries(data).filter(
          ([key, val]) => !NON_LOCATION_KEYS.has(key) && isLocationObject(val)
        )
      )

      // Merge: nueva estructura tiene prioridad sobre la vieja
      const merged: Record<string, any> = { ...legacyFormat, ...newFormat }

      const items: PuntoFavorito[] = Object.entries(merged)
        .filter(([, val]) => isLocationObject(val))
        .map(([key, raw]) => ({
          key,
          label: raw.label || raw.nombre || key,
          nombre: raw.nombre || '',
          celular: raw.celular || '',
          direccion: raw.direccion || '',
          coord: raw.coord || null,
          tipoUbicacion: (raw.tipoUbicacion as TipoUbicacion) || 'referencial',
        }))
        .sort((a, b) => a.label.localeCompare(b.label))

      items.push({ key: '__otro__', label: 'Otro' })
      setPuntos(items)
    })

    return () => unsub()
  }, [uid])

  return puntos
}

async function guardarClienteEntrega(uid: string, data: Omit<ClienteGuardado, 'id'>) {
  if (!data.celular?.trim()) return
  const docId = `${uid}_${data.celular.replace(/\D/g, '')}`
  const payload: Record<string, any> = {
    nombre: data.nombre.trim(),
    celular: data.celular.trim(),
    comercioUid: uid,
    updatedAt: serverTimestamp(),
    // totalViajes se incrementa solo cuando la orden pasa a 'entregado' en SolicitudDrawer
  }
  if (data.direccion?.trim()) payload.direccion = data.direccion.trim()
  if (data.nota?.trim()) payload.nota = data.nota.trim()
  if (data.coord) payload.coord = data.coord
  if (data.tipoUbicacion) payload.tipoUbicacion = data.tipoUbicacion
  await setDoc(doc(db, 'clientes_envio', docId), payload, { merge: true })
}

// ─── Map Components ───────────────────────────────────────────────────────────

// ─── Phone helpers ────────────────────────────────────────────────────────────

function formatCelular(v: string): string {
  return v.replace(/\D/g, '').slice(0, 8)
}

function validarCelular(v: string): boolean {
  return /^\d{8}$/.test(v.trim())
}

// ─────────────────────────────────────────────────────────────────────────────

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
  return <div ref={containerRef} style={{ width: '100%', height: 180, borderRadius: 12, overflow: 'hidden', border: '1px solid #e5e7eb' }} />
}

function MiniMap({
  coord,
  onSelect,
  onGeocode,
  color = '#004aad',
  label = 'R',
  locked = false,
  onUnlock,
  etiquetarPuntoManual,
  resolverEntradaTexto,
  onEntradaNoResuelta,
}: {
  coord: LatLng | null
  onSelect: (c: LatLng) => void
  onGeocode?: (addr: string) => void
  color?: string
  label?: string
  locked?: boolean
  onUnlock?: () => void
  // MAP-UX-2: solo presentación. Nunca escriben direccionEscrita ni geocodeGoogle.
  etiquetarPuntoManual?: (c: LatLng) => string
  resolverEntradaTexto?: (texto: string) => { coord: LatLng; labelVisible: string } | null
  onEntradaNoResuelta?: (msg: string | null) => void
}) {
  const containerRef = useRef<HTMLDivElement>(null)
  const searchRef = useRef<HTMLInputElement>(null)
  // Los listeners del mapa se registran con useEffect([]) — estas callbacks se
  // leen por ref para no congelarse antes de que carguen las zonas.
  const etiquetarRef = useRef(etiquetarPuntoManual)
  etiquetarRef.current = etiquetarPuntoManual
  const resolverTextoRef = useRef(resolverEntradaTexto)
  resolverTextoRef.current = resolverEntradaTexto
  const entradaNoResueltaRef = useRef(onEntradaNoResuelta)
  entradaNoResueltaRef.current = onEntradaNoResuelta
  const mapRef = useRef<google.maps.Map | null>(null)
  const markerRef = useRef<google.maps.Marker | null>(null)
  const geocoderRef = useRef<google.maps.Geocoder | null>(null)
  const onSelectRef = useRef(onSelect)
  const onGeocodeRef = useRef(onGeocode)
  const lockedRef = useRef(locked)
  useEffect(() => { onSelectRef.current = onSelect })
  useEffect(() => { onGeocodeRef.current = onGeocode })
  useEffect(() => {
    lockedRef.current = locked
    if (markerRef.current) markerRef.current.setDraggable(!locked)
  }, [locked])

  const reverseGeocode = useCallback((c: LatLng) => {
    geocoderRef.current?.geocode({ location: c }, (results, status) => {
      if (status !== 'OK' || !results?.length) return
      const isPlusCode = (addr: string) => /^[0-9A-Z]{4,8}\+[0-9A-Z]{2,}/.test(addr)
      const best = results.find(r => !isPlusCode(r.formatted_address)) || results[0]
      onGeocodeRef.current?.(best.formatted_address)
    })
  }, [])

  const placeMarker = useCallback((c: LatLng, goog: typeof google, geocodedAddr?: string) => {
    markerRef.current?.setMap(null)
    markerRef.current = new goog.maps.Marker({
      map: mapRef.current!,
      position: c,
      draggable: !lockedRef.current,
      icon: { path: goog.maps.SymbolPath.CIRCLE, fillColor: color, fillOpacity: 1, strokeColor: '#fff', strokeWeight: 2, scale: 10 },
      label: { text: label, color: '#fff', fontWeight: 'bold', fontSize: '11px' },
    })
    markerRef.current.addListener('dragend', () => {
      if (lockedRef.current) return
      const pos = markerRef.current?.getPosition()
      if (!pos) return
      const dc = { lat: pos.lat(), lng: pos.lng() }
      onSelectRef.current(dc)
      reverseGeocode(dc)
    })
    onSelectRef.current(c)
    if (geocodedAddr) { onGeocodeRef.current?.(geocodedAddr) } else { reverseGeocode(c) }
  }, [color, label, reverseGeocode])

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

      if (searchRef.current) {
        const managua = new google.maps.LatLngBounds(
          new google.maps.LatLng(11.94, -86.56),
          new google.maps.LatLng(12.35, -86.05)
        )
        const autocomplete = new google.maps.places.Autocomplete(searchRef.current, {
          componentRestrictions: { country: 'ni' },
          bounds: managua,
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

      if (coord) {
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
      }

      mapRef.current.addListener('click', (e: google.maps.MapMouseEvent) => {
        if (!e.latLng || lockedRef.current) return
        const c = { lat: e.latLng.lat(), lng: e.latLng.lng() }
        placeMarker(c, google)
        // MAP-UX-2: contexto de zona propia sin depender del reverse geocoding.
        const etiquetar = etiquetarRef.current
        if (etiquetar && searchRef.current) searchRef.current.value = etiquetar(c)
        entradaNoResueltaRef.current?.(null)
      })
    })
    return () => { mounted = false }
  }, [])

  useEffect(() => {
    if (!mapRef.current || !window.google) return
    const google = window.google
    if (!coord) return
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
  }, [coord])

  return (
    <div>
      <input
        ref={searchRef}
        type="text"
        placeholder="🔍 Buscar lugar, Plus Code o lat,lng..."
        onKeyDown={(e) => {
          if (e.key !== 'Enter' || locked) return
          const texto = searchRef.current?.value?.trim() || ''
          if (!texto) return
          // Plus Code y coordenadas se resuelven localmente; si no es una
          // entrada directa, se deja pasar para que Places la resuelva.
          const punto = resolverTextoRef.current?.(texto)
          if (!punto) {
            // Solo avisamos si el texto pretendía ser Plus Code o lat,lng:
            // un nombre de lugar normal lo resuelve Places sin ruido.
            entradaNoResueltaRef.current?.(
              pareceEntradaDirecta(texto) ? MSG_ENTRADA_NO_RESUELTA : null,
            )
            return
          }
          e.preventDefault()
          const goog = window.google
          if (!goog || !mapRef.current) return
          mapRef.current.panTo(punto.coord)
          mapRef.current.setZoom(16)
          placeMarker(punto.coord, goog)
          if (searchRef.current) searchRef.current.value = punto.labelVisible
          entradaNoResueltaRef.current?.(null)
        }}
        style={{ ...S.input, marginBottom: 8 }}
        disabled={locked}
      />
      <div style={{ position: 'relative' }}>
        <div
          ref={containerRef}
          style={{ width: '100%', height: 220, borderRadius: 12, overflow: 'hidden', border: '1px solid #e5e7eb' }}
        />
        {locked && (
          <button
            type="button"
            onClick={onUnlock}
            style={{ position: 'absolute', top: 8, right: 8, background: '#fff', border: '1px solid #d1d5db', borderRadius: 8, padding: '6px 12px', fontSize: 12, fontWeight: 700, cursor: 'pointer', color: '#374151', display: 'flex', alignItems: 'center', gap: 5, boxShadow: '0 2px 8px rgba(0,0,0,0.15)', zIndex: 10 }}
          >
            ✏️ Mover punto
          </button>
        )}
      </div>
      <p style={{ fontSize: 11, color: locked ? '#9ca3af' : '#6b7280', margin: '5px 0 0' }}>
        {locked ? '🔒 Punto fijado. Hacé click en "Mover punto" para ajustarlo.' : 'Tocá el mapa para marcar el punto exacto. Podés arrastrar el pin para ajustar.'}
      </p>
    </div>
  )
}

function RoutePreviewMap({ origen, destino }: { origen: LatLng | null; destino: LatLng | null }) {
  const containerRef = useRef<HTMLDivElement>(null)
  const mapRef = useRef<google.maps.Map | null>(null)
  const markerORef = useRef<google.maps.Marker | null>(null)
  const markerDRef = useRef<google.maps.Marker | null>(null)
  const polyRef = useRef<google.maps.Polyline | null>(null)
  const origenRef = useRef(origen)
  const destinoRef = useRef(destino)
  useEffect(() => { origenRef.current = origen })
  useEffect(() => { destinoRef.current = destino })

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
      if (o) {
        markerORef.current = new google.maps.Marker({ map: mapRef.current, position: o, icon: { path: google.maps.SymbolPath.CIRCLE, fillColor: '#004aad', fillOpacity: 1, strokeColor: '#fff', strokeWeight: 2, scale: 10 }, label: { text: 'R', color: '#fff', fontWeight: 'bold', fontSize: '11px' } })
      }
      if (d) {
        markerDRef.current = new google.maps.Marker({ map: mapRef.current, position: d, icon: { path: google.maps.SymbolPath.CIRCLE, fillColor: '#16a34a', fillOpacity: 1, strokeColor: '#fff', strokeWeight: 2, scale: 10 }, label: { text: 'E', color: '#fff', fontWeight: 'bold', fontSize: '11px' } })
      }
      if (o && d) {
        polyRef.current = new google.maps.Polyline({ path: [o, d], geodesic: true, strokeOpacity: 0, icons: [{ icon: { path: 'M 0,-1 0,1', strokeOpacity: 0.8, strokeColor: '#004aad', strokeWeight: 3, scale: 4 }, offset: '0', repeat: '20px' }], map: mapRef.current })
        const bounds = new google.maps.LatLngBounds(); bounds.extend(o); bounds.extend(d)
        mapRef.current.fitBounds(bounds, { top: 50, right: 30, bottom: 30, left: 30 })
      }
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
          icon: {
            path: google.maps.SymbolPath.CIRCLE,
            fillColor: '#004aad',
            fillOpacity: 1,
            strokeColor: '#fff',
            strokeWeight: 2,
            scale: 10,
          },
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
          icon: {
            path: google.maps.SymbolPath.CIRCLE,
            fillColor: '#16a34a',
            fillOpacity: 1,
            strokeColor: '#fff',
            strokeWeight: 2,
            scale: 10,
          },
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
        icons: [
          {
            icon: {
              path: 'M 0,-1 0,1',
              strokeOpacity: 0.8,
              strokeColor: '#004aad',
              strokeWeight: 3,
              scale: 4,
            },
            offset: '0',
            repeat: '20px',
          },
        ],
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

// ─── UI Components ────────────────────────────────────────────────────────────

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

function Field({
  label,
  required,
  children,
  hint,
}: {
  label: string
  required?: boolean
  children: React.ReactNode
  hint?: string
}) {
  return (
    <div>
      <label style={S.label}>
        {label}
        {required && <span style={{ color: '#dc2626' }}> *</span>}
      </label>
      {children}
      {hint && <p style={S.hint}>{hint}</p>}
    </div>
  )
}

function ComercioSearchInput({
  comercios,
  selectedUid,
  onSelect,
  loading,
  onNuevo,
}: {
  comercios: ComercioOption[]
  selectedUid: string
  onSelect: (uid: string) => void
  loading: boolean
  onNuevo: () => void
}) {
  const [query, setQuery] = useState('')
  const [open, setOpen] = useState(false)
  const ref = useRef<HTMLDivElement>(null)

  const selected = comercios.find((c) => c.uid === selectedUid) || null

  const MAX_RESULTS = 8

  const { filtered, totalMatches } = useMemo(() => {
    const q = query.trim().toLowerCase()
    if (!q) return { filtered: [], totalMatches: 0 }
    const all = comercios.filter((c) =>
      (c.companyName || c.nombre).toLowerCase().includes(q) ||
      c.email.toLowerCase().includes(q) ||
      (c.phone || '').includes(q)
    )
    return { filtered: all.slice(0, MAX_RESULTS), totalMatches: all.length }
  }, [query, comercios])

  useEffect(() => {
    const h = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false)
    }
    document.addEventListener('mousedown', h)
    return () => document.removeEventListener('mousedown', h)
  }, [])

  const handleSelect = (c: ComercioOption) => {
    onSelect(c.uid)
    setQuery('')
    setOpen(false)
  }

  const handleClear = () => {
    onSelect('')
    setQuery('')
    setOpen(false)
  }

  return (
    <div ref={ref} style={{ position: 'relative' }}>
      <div style={{ display: 'flex', gap: 8 }}>
        {selected && !open ? (
          <div
            style={{ ...S.input, flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'space-between', cursor: 'pointer', background: '#f9fafb' }}
            onClick={() => { setOpen(true); setQuery('') }}
          >
            <span style={{ fontWeight: 700, color: '#111827' }}>{selected.companyName || selected.nombre}</span>
            <button
              type="button"
              onClick={(e) => { e.stopPropagation(); handleClear() }}
              style={{ border: 'none', background: 'none', cursor: 'pointer', color: '#9ca3af', fontSize: 16, padding: '0 4px', lineHeight: 1 }}
            >
              ✕
            </button>
          </div>
        ) : (
          <input
            autoFocus={open}
            value={query}
            onChange={(e) => { setQuery(e.target.value); setOpen(true) }}
            onFocus={() => setOpen(true)}
            placeholder={loading ? 'Cargando...' : 'Buscar por nombre, teléfono...'}
            style={{ ...S.input, flex: 1 }}
            disabled={loading}
          />
        )}
        <button
          type="button"
          onClick={onNuevo}
          style={{ ...S.btnOutline, whiteSpace: 'nowrap' as const, fontSize: 13, padding: '9px 14px' }}
        >
          + Nuevo
        </button>
      </div>

      {open && (
        <div style={{ ...S.dropdown, zIndex: 100 }}>
          {!query.trim() ? (
            <div style={{ padding: '12px 14px', fontSize: 13, color: '#9ca3af', display: 'flex', alignItems: 'center', gap: 6 }}>
              <span>🔍</span>
              <span>Escribí nombre o teléfono para buscar entre {comercios.length} comercio{comercios.length !== 1 ? 's' : ''}…</span>
            </div>
          ) : filtered.length === 0 ? (
            <div style={{ padding: '12px 14px', fontSize: 13, color: '#9ca3af' }}>Sin resultados para "{query}"</div>
          ) : (
            <>
              {filtered.map((c) => (
                <button
                  key={c.uid}
                  type="button"
                  onClick={() => handleSelect(c)}
                  style={S.dropdownItem}
                >
                  <span style={{ fontWeight: 700, color: '#111827' }}>{c.companyName || c.nombre}</span>
                  {c.phone && <span style={{ color: '#6b7280', fontSize: 12, marginLeft: 8 }}>{c.phone}</span>}
                  {c.email && <span style={{ color: '#9ca3af', fontSize: 11, display: 'block', marginTop: 1 }}>{c.email}</span>}
                </button>
              ))}
              {totalMatches > MAX_RESULTS && (
                <div style={{ padding: '8px 14px', fontSize: 11, color: '#9ca3af', borderTop: '1px solid #f3f4f6', background: '#fafafa' }}>
                  Mostrando {MAX_RESULTS} de {totalMatches} resultados — afinás la búsqueda para ver más
                </div>
              )}
            </>
          )}
        </div>
      )}
    </div>
  )
}

function AutocompleteInput({
  label,
  value,
  onChange,
  onSelect,
  placeholder,
  clientes,
  required,
  comercioUidActual,
}: {
  label: string
  value: string
  onChange: (v: string) => void
  onSelect: (c: ClienteGuardado) => void
  placeholder?: string
  clientes: ClienteGuardado[]
  required?: boolean
  comercioUidActual?: string
}) {
  const [open, setOpen] = useState(false)
  const ref = useRef<HTMLDivElement>(null)

  const filtered = useMemo(() => {
    const q = value.trim().toLowerCase()
    if (!q || q.length < 2) return []
    return clientes
      .filter((c) => c.celular.includes(q) || c.nombre.toLowerCase().includes(q))
      .slice(0, 8)
  }, [value, clientes])

  useEffect(() => {
    const h = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false)
    }
    document.addEventListener('mousedown', h)
    return () => document.removeEventListener('mousedown', h)
  }, [])

  return (
    <div ref={ref} style={{ position: 'relative' }}>
      <label style={S.label}>
        {label}
        {required && <span style={{ color: '#dc2626' }}> *</span>}
      </label>
      <input
        value={value}
        onChange={(e) => { onChange(e.target.value); setOpen(true) }}
        onFocus={() => setOpen(true)}
        placeholder={placeholder}
        style={S.input}
      />
      {open && filtered.length > 0 && (
        <div style={S.dropdown}>
          {filtered.map((c) => (
            <button
              key={c.id}
              type="button"
              onClick={() => { onSelect(c); setOpen(false) }}
              style={S.dropdownItem}
            >
              <div style={{ display: 'flex', alignItems: 'center', gap: 6, flexWrap: 'wrap' }}>
                <span style={{ fontWeight: 700, color: '#111827' }}>{c.nombre || '—'}</span>
                <span style={{ color: '#6b7280', fontSize: 12 }}>{c.celular}</span>
                {comercioUidActual && c.comercioUid === comercioUidActual && (
                  <span style={{ fontSize: 10, fontWeight: 700, background: '#eff6ff', color: '#004aad', borderRadius: 4, padding: '1px 5px' }}>🏪 del comercio</span>
                )}
                {!c.comercioUid && (
                  <span style={{ fontSize: 10, fontWeight: 700, background: '#f0fdf4', color: '#16a34a', borderRadius: 4, padding: '1px 5px' }}>🌐 global</span>
                )}
              </div>
              {c.direccion && (
                <span style={{ color: '#9ca3af', fontSize: 11, display: 'block', marginTop: 2 }}>
                  {c.direccion}
                </span>
              )}
            </button>
          ))}
        </div>
      )}
    </div>
  )
}

function AddressSearchBox({ onSelect, placeholder, mapAddress }: { onSelect: (c: LatLng, address: string) => void; placeholder?: string; mapAddress?: string }) {
  const inputRef = useRef<HTMLInputElement>(null)
  const acRef = useRef<google.maps.places.Autocomplete | null>(null)
  const geocoderRef = useRef<google.maps.Geocoder | null>(null)
  const [inputVal, setInputVal] = useState('')
  const [searching, setSearching] = useState(false)

  useEffect(() => {
    if (mapAddress !== undefined) setInputVal(mapAddress)
  }, [mapAddress])

  useEffect(() => {
    let mounted = true
    getMapsLoader().load().then((google) => {
      if (!mounted || !inputRef.current || acRef.current) return
      geocoderRef.current = new google.maps.Geocoder()
      const managua = new google.maps.LatLngBounds(
        new google.maps.LatLng(11.94, -86.56),
        new google.maps.LatLng(12.35, -86.05)
      )
      acRef.current = new google.maps.places.Autocomplete(inputRef.current, {
        componentRestrictions: { country: 'ni' },
        bounds: managua,
        strictBounds: true,
        fields: ['geometry', 'formatted_address'],
      })
      acRef.current.addListener('place_changed', () => {
        const place = acRef.current?.getPlace()
        const loc = place?.geometry?.location
        const addr = place?.formatted_address || ''
        if (loc) {
          setInputVal(addr)
          onSelect({ lat: loc.lat(), lng: loc.lng() }, addr)
        }
      })
    })
    return () => { mounted = false }
  }, [onSelect])

  const buscarPorTexto = () => {
    const q = inputVal.trim()
    if (!q || !geocoderRef.current) return
    setSearching(true)
    geocoderRef.current.geocode(
      { address: `${q}, Managua, Nicaragua`, componentRestrictions: { country: 'ni' } },
      (results, status) => {
        setSearching(false)
        if (status !== 'OK' || !results?.length) return
        const isPlusCode = (addr: string) => /^[0-9A-Z]{4,8}\+[0-9A-Z]{2,}/.test(addr)
        const best = results.find(r => !isPlusCode(r.formatted_address)) || results[0]
        const loc = best.geometry.location
        setInputVal(best.formatted_address)
        onSelect({ lat: loc.lat(), lng: loc.lng() }, best.formatted_address)
      }
    )
  }

  return (
    <div style={{ position: 'relative', marginBottom: 8, display: 'flex', gap: 6 }}>
      <div style={{ position: 'relative', flex: 1 }}>
        <input
          ref={inputRef}
          value={inputVal}
          onChange={(e) => setInputVal(e.target.value)}
          onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); buscarPorTexto() } }}
          placeholder={placeholder || 'Buscar dirección en Managua...'}
          style={{ ...S.input, paddingLeft: 36 }}
        />
        <span style={{ position: 'absolute', left: 12, top: '50%', transform: 'translateY(-50%)', fontSize: 14, pointerEvents: 'none' }}>🔍</span>
      </div>
      <button
        type="button"
        onClick={buscarPorTexto}
        disabled={searching}
        style={{ ...S.btnOutline, padding: '9px 14px', fontSize: 13, whiteSpace: 'nowrap' as const }}
      >
        {searching ? '...' : 'Buscar'}
      </button>
    </div>
  )
}

function UbicacionTipo({ value, onChange }: { value: TipoUbicacion; onChange: (v: TipoUbicacion) => void }) {
  return (
    <div style={{ marginTop: 8 }}>
      <p style={{ fontSize: 12, color: '#6b7280', margin: '0 0 6px' }}>¿Qué tan exacta es esta ubicación?</p>
      <div style={{ display: 'flex', gap: 8 }}>
        {(['referencial', 'exacto'] as TipoUbicacion[]).map((t) => (
          <button
            key={t}
            type="button"
            onClick={() => onChange(t)}
            style={{
              padding: '6px 14px',
              borderRadius: 8,
              fontSize: 12,
              fontWeight: 600,
              cursor: 'pointer',
              border: `1px solid ${value === t ? '#004aad' : '#e5e7eb'}`,
              background: value === t ? '#004aad' : '#fff',
              color: value === t ? '#fff' : '#374151',
            }}
          >
            {t === 'referencial' ? '📍 Referencial' : '🎯 Exacto'}
          </button>
        ))}
      </div>
    </div>
  )
}

// ─── Styles ───────────────────────────────────────────────────────────────────

const S: Record<string, React.CSSProperties> = {
  sectionCard: {
    background: '#fff',
    border: '1px solid #e5e7eb',
    borderRadius: 16,
    padding: '18px',
    marginBottom: 16,
    boxShadow: '0 1px 3px rgba(0,0,0,0.05)',
  },
  sectionHeader: {
    display: 'flex',
    alignItems: 'center',
    gap: 10,
    marginBottom: 18,
    paddingBottom: 14,
    borderBottom: '1px solid #f3f4f6',
  },
  label: { display: 'block', fontSize: 13, fontWeight: 600, color: '#374151', marginBottom: 6 },
  input: {
    width: '100%',
    border: '1px solid #e5e7eb',
    borderRadius: 10,
    padding: '10px 12px',
    fontSize: 14,
    color: '#111827',
    outline: 'none',
    background: '#fff',
    boxSizing: 'border-box' as const,
    fontFamily: 'inherit',
  },
  hint: { fontSize: 11, color: '#9ca3af', margin: '5px 0 0' },
  dropdown: {
    position: 'absolute',
    top: '100%',
    left: 0,
    right: 0,
    background: '#fff',
    border: '1px solid #e5e7eb',
    borderRadius: 12,
    boxShadow: '0 8px 24px rgba(0,0,0,0.12)',
    zIndex: 50,
    marginTop: 4,
    overflow: 'hidden',
  },
  dropdownItem: {
    display: 'block',
    width: '100%',
    textAlign: 'left' as const,
    padding: '10px 14px',
    border: 'none',
    background: 'none',
    cursor: 'pointer',
    borderBottom: '1px solid #f3f4f6',
    fontSize: 13,
  },
  btnOutline: {
    padding: '7px 14px',
    borderRadius: 8,
    border: '1px solid #e5e7eb',
    background: '#fff',
    fontSize: 12,
    fontWeight: 600,
    color: '#374151',
    cursor: 'pointer',
  },
}

const blankRetiro = (): RetiroState => ({
  favKey: '__otro__',
  nombre: '',
  celular: '',
  direccion: '',
  nota: '',
  coord: null,
  tipoUbicacion: 'referencial',
})

const blankEntrega = (): EntregaState => ({
  nombre: '',
  celular: '',
  direccion: '',
  nota: '',
  coord: null,
  tipoUbicacion: 'referencial',
})

// ─── Main Page ────────────────────────────────────────────────────────────────

export default function GestorIngresarOrdenPage() {
  const estadoGuardModulo = useModuleGuard('ingresarOrden')
  if (estadoGuardModulo !== 'autorizado') {
    return (
      <div className="w-full px-6 py-6 text-sm text-gray-600">
        {estadoGuardModulo === 'redirigiendo' ? 'Redirigiendo a tu panel...' : 'Validando permisos...'}
      </div>
    )
  }
  return <GestorIngresarOrdenPageContent />
}

function GestorIngresarOrdenPageContent() {
  // ── MAP-UX-2: zonas para etiquetar puntos en vivo ──
  // La clasificación que se PERSISTE en la orden sigue con su propia llamada
  // (ver clasificarOrdenCompleto más abajo). Esto es solo para presentación.
  const [zonasSHView, setZonasSHView] = useState<ZonaGeografica[]>([])
  useEffect(() => { getZonasActivas().then(setZonasSHView).catch(() => setZonasSHView([])) }, [])
  const { etiquetarManual, resolverTexto } = useResolucionPunto(zonasSHView)
  const [entradaNoResuelta, setEntradaNoResuelta] = useState<string | null>(null)

  // ── Comercios ──
  const [comercios, setComercios] = useState<ComercioOption[]>([])
  const [loadingComercios, setLoadingComercios] = useState(true)
  const [selectedOwnerUid, setSelectedOwnerUid] = useState('')
  const [selectedOwner, setSelectedOwner] = useState<ComercioOption | null>(null)
  const [selectedOwnerData, setSelectedOwnerData] = useState<ComercioData | null>(null)

  // ── Modal nuevo comercio ──
  const [modalNuevoComercio, setModalNuevoComercio] = useState(false)
  const [ncNombre, setNcNombre] = useState('')
  const [ncTelefono, setNcTelefono] = useState('')
  const [ncEmail, setNcEmail] = useState('')
  const [ncDireccion, setNcDireccion] = useState('')
  const [ncGuardando, setNcGuardando] = useState(false)
  const [ncError, setNcError] = useState('')

  // Carga lista de comercios/clientes.
  // Identidad estable (Bloque A): los comercios (rol='Comercio') se leen
  // directamente de comercios/ — un comercio sin_acceso no tiene doc en
  // usuarios/, así que ya no se puede depender del join usuarios→comercios
  // para listarlos. Los clientes individuales (rol='cliente') sí siguen
  // siendo su propio Auth UID, así que esos se leen de usuarios/ como antes.
  useEffect(() => {
    const run = async () => {
      try {
        const [usuariosSnap, comerciosSnap] = await Promise.all([
          getDocs(query(collection(db, 'usuarios'), where('activo', '==', true))),
          getDocs(collection(db, 'comercios')),
        ])

        const filasCliente: ComercioOption[] = usuariosSnap.docs
          .map((d) => ({ uid: d.id, ...(d.data() as any) }))
          .filter((u: any) => String(u.rol || '').toLowerCase() === 'cliente')
          .map((u: any) => ({
            uid: u.uid, // Auth UID de la persona — NUNCA un comercioId
            tipo: 'cliente' as const,
            nombre: u.name || u.email || u.uid,
            email: u.email || '',
            phone: '',
            companyName: '',
            address: '',
          }))

        const comerciosDocs = comerciosSnap.docs.map((d) => ({ uid: d.id, ...(d.data() as any) }))
        const authUids = [...new Set(comerciosDocs.filter((c) => c.authUid).map((c) => c.authUid as string))]
        const usuariosComercioSnaps = await Promise.all(authUids.map((uid) => getDoc(doc(db, 'usuarios', uid))))
        const usuarioPorAuthUid = new Map(
          authUids.map((uid, i) => [uid, usuariosComercioSnaps[i].exists() ? (usuariosComercioSnaps[i].data() as any) : null])
        )

        const filasComercio: ComercioOption[] = comerciosDocs.map((c) => {
          const usuario = c.authUid ? usuarioPorAuthUid.get(c.authUid) : null
          return {
            uid: c.uid, // comercioId estable — nunca el Auth UID
            tipo: 'comercio' as const,
            nombre: c.name || usuario?.name || c.emailAcceso || c.uid,
            email: usuario?.email || c.emailAcceso || c.emailContacto || '',
            phone: c.phone || '',
            companyName: c.name || '',
            address: c.address || '',
          }
        })

        const rows = [...filasCliente, ...filasComercio]
          .sort((a, b) => (a.companyName || a.nombre).localeCompare(b.companyName || b.nombre))

        setComercios(rows)
      } catch (err) {
        console.error(err)
      } finally {
        setLoadingComercios(false)
      }
    }
    run()
  }, [])

  useEffect(() => {
    const found = comercios.find((c) => c.uid === selectedOwnerUid) || null
    setSelectedOwner(found)
  }, [selectedOwnerUid, comercios])

  useEffect(() => {
    if (!selectedOwnerUid) {
      setSelectedOwnerData(null)
      return
    }

    const unsub = onSnapshot(doc(db, 'comercios', selectedOwnerUid), (snap) => {
      if (!snap.exists()) {
        setSelectedOwnerData(null)
        return
      }

      setSelectedOwnerData(snap.data() as ComercioData)
    })

    return () => unsub()
  }, [selectedOwnerUid])

  // ── Data hooks ──
  const poolPuntos = usePoolPuntos(selectedOwnerUid || null)
  const puntosFavoritos = usePuntosFavoritos(selectedOwnerUid || null)

  // ── Draft desde calculadora ──
  const [draft, setDraft] = useState<DraftEnvio | null>(null)
  useEffect(() => {
    try {
      const raw = sessionStorage.getItem('draftEnvio')
      if (!raw) return
      // Consumir el draft y borrarlo de inmediato para que no persista
      // si el usuario navega fuera sin crear la orden.
      sessionStorage.removeItem('draftEnvio')
      const d = JSON.parse(raw) as DraftEnvio
      setDraft(d)
      if (d.origenCoord) {
        setRetiro((prev) => ({
          ...prev,
          coord: d.origenCoord || null,
          tipoUbicacion: d.origenTipo || 'referencial',
          ...(d.origenDireccion ? { direccion: d.origenDireccion } : {}),
        }))
        draftRetiroCoord.current = d.origenCoord
      }
      if (d.destinoCoord) {
        setEntrega((prev) => ({
          ...prev,
          coord: d.destinoCoord || null,
          tipoUbicacion: d.destinoTipo || 'referencial',
        }))
        draftEntregaCoord.current = d.destinoCoord
      }
    } catch {}
  }, [])

  // ── Form state ──
  const [retiro, setRetiro] = useState<RetiroState>(blankRetiro())
  const [entrega, setEntrega] = useState<EntregaState>(blankEntrega())
  const [tipoCliente, setTipoCliente] = useState<TipoCliente>('contado')
  const [cobroCE, setCobroCE] = useState(false)
  const [montoCE, setMontoCE] = useState<number | ''>('')
  const [quienPagaDelivery, setQuienPagaDelivery] = useState<QuienPagaDelivery>('')
  const [deducirDelivery, setDeducirDelivery] = useState<DeducirDelivery>('no_deducir')
  type PagoCargotrans = 'efectivo_motorizado' | 'transferencia_comercio' | 'transferencia_storkhub' | ''
  const [pagoCargotrans, setPagoCargotrans] = useState<PagoCargotrans>('')
  const [detalle, setDetalle] = useState('')
  const [saving, setSaving] = useState(false)
  const [msg, setMsg] = useState<{ type: 'success' | 'error' | 'info'; text: string } | null>(null)
  const [zonaPreview, setZonaPreview] = useState<{
    zonaRetiroNombre: string | null
    zonaEntregaNombre: string | null
    macroZonaRetiroNombre: string | null
    macroZonaEntregaNombre: string | null
  } | null>(null)

  // Instrucciones adicionales toggles
  const [showNotaRetiro, setShowNotaRetiro] = useState(false)
  const [showNotaEntrega, setShowNotaEntrega] = useState(false)

  // Geocode addresses from map
  const [geocodeRetiro, setGeoRetiro] = useState('')
  const [geocodeEntrega, setGeoEntrega] = useState('')

  // Número de orden
  const [numeroOrden, setNumeroOrden] = useState('')

  // Envío programado
  const [esProgramado, setEsProgramado] = useState(false)
  const [tipoProgramado, setTipoProgramado] = useState<'retiro' | 'entrega' | 'ambos'>('retiro')
  const [fechaRetiro, setFechaRetiro] = useState('')
  const [horaRetiro, setHoraRetiro] = useState('')
  const [fechaEntrega, setFechaEntrega] = useState('')
  const [horaEntrega, setHoraEntrega] = useState('')

  // Paquete
  const [fragil, setFragil] = useState(false)
  const [grande, setGrande] = useState(false)
  const [notaPaquete, setNotaPaquete] = useState('')

  // ── Modal buscador de comercios ──
  const [showComercioModal, setShowComercioModal] = useState(false)

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
  const [puntosLogisticos, setPuntosLogisticos] = useState<PuntoLogistico[]>([])
  const [puntoLogisticoSeleccionado, setPuntoLogisticoSeleccionado] = useState<PuntoLogistico | null>(null)
  const [terminalesSugeridas, setTerminalesSugeridas] = useState<PuntoLogistico[]>([])

  // ── Modal buscador de clientes ──
  const [showClienteModal, setShowClienteModal] = useState(false)

  // ── Cliente + Comercio preseleccionados desde URL params ──
  const searchParams = useSearchParams()
  const pendingClienteId = searchParams.get('clienteId')
  const pendingComercioId = searchParams.get('comercioId')
  const [clienteSeleccionadoId, setClienteSeleccionadoId] = useState<string | null>(null)
  const [clienteSeleccionadoNombre, setClienteSeleccionadoNombre] = useState<string | null>(null)
  const [clienteSeleccionadoViajes, setClienteSeleccionadoViajes] = useState<number>(0)
  const didAutoLoadCliente = useRef(false)
  const didAutoLoadComercio = useRef(false)
  const didAutoAdvanceFromCalc = useRef(false)

  // ── Auto-load comercio desde URL param ──
  useEffect(() => {
    if (!pendingComercioId) return
    if (didAutoLoadComercio.current) return
    if (comercios.length === 0) return
    const match = comercios.find((c) => c.uid === pendingComercioId)
    if (!match) return
    didAutoLoadComercio.current = true
    setSelectedOwnerUid(match.uid)
  }, [comercios, pendingComercioId])

  // ── Auto-load cliente desde URL param ──
  useEffect(() => {
    if (!pendingClienteId) return
    if (didAutoLoadCliente.current) return
    if (poolPuntos.length === 0) return
    const match = poolPuntos.find((p) => p.id === pendingClienteId)
    if (!match) return
    didAutoLoadCliente.current = true
    handleSelectEntrega(match)
    setClienteSeleccionadoId(match.id)
    setClienteSeleccionadoNombre(match.nombre || null)
    setClienteSeleccionadoViajes(match.totalViajes ?? 0)
  }, [poolPuntos, pendingClienteId])

  // ── Saltar al paso 2 cuando comercio + cliente están ambos pre-cargados ──
  useEffect(() => {
    if (!pendingClienteId || !pendingComercioId) return
    if (!clienteSeleccionadoId) return
    if (!selectedOwnerUid) return
    setPaso(2)
  }, [clienteSeleccionadoId, selectedOwnerUid, pendingClienteId, pendingComercioId])

  // ── Saltar al paso 2 cuando viene solo comercioId desde la calculadora ──
  useEffect(() => {
    if (!pendingComercioId || pendingClienteId) return
    if (!selectedOwnerUid) return
    if (didAutoAdvanceFromCalc.current) return
    try { if (!sessionStorage.getItem('draftEnvio')) return } catch {}
    didAutoAdvanceFromCalc.current = true
    setPaso(2)
  }, [selectedOwnerUid, pendingComercioId, pendingClienteId])

  // ── Map lock + saved coord states ──
  const [retiroLocked, setRetiroLocked] = useState(false)
  const [entregaLocked, setEntregaLocked] = useState(false)
  const [retiroSavedCoord, setRetiroSavedCoord] = useState<LatLng | null>(null)
  const [entregaSavedCoord, setEntregaSavedCoord] = useState<LatLng | null>(null)

  // ── Flujo por pasos ──
  const [paso, setPaso] = useState(1)

  // ── Manual price calculation ──
  const [calcResult, setCalcResult] = useState<{ km: number; precio: number } | null>(null)
  const [calcLoading, setCalcLoading] = useState(false)
  const [calcError, setCalcError] = useState<string | null>(null)
  const lastCalcKey = useRef<string | null>(null)

  const [draftRetiroStale, setDraftRetiroStale] = useState(false)
  const [draftEntregaStale, setDraftEntregaStale] = useState(false)
  // Guardados en el useEffect del draft (arriba) cuando se aplican los coords originales
  const draftRetiroCoord = useRef<{ lat: number; lng: number } | null>(null)
  const draftEntregaCoord = useRef<{ lat: number; lng: number } | null>(null)

  // Limpiar calcResult cuando cambia alguna coordenada
  const isFirstCoordRender = useRef(true)
  useEffect(() => {
    if (isFirstCoordRender.current) { isFirstCoordRender.current = false; return }
    if (calcResult || calcError) {
      setCalcResult(null)
      setCalcError(null)
      lastCalcKey.current = null
    }
  }, [retiro.coord, entrega.coord])

  // Detectar si el usuario movió algún punto respecto al draft original
  // Solo actúa cuando el ref del draft tiene valor (draft fue aplicado) y el coord es no-nulo
  useEffect(() => {
    if (!draftRetiroCoord.current || !retiro.coord) return
    if (!coordsMatch(retiro.coord, draftRetiroCoord.current)) setDraftRetiroStale(true)
  }, [retiro.coord])

  useEffect(() => {
    if (!draftEntregaCoord.current || !entrega.coord) return
    if (!coordsMatch(entrega.coord, draftEntregaCoord.current)) setDraftEntregaStale(true)
  }, [entrega.coord])

  const handleCalcularPrecio = () => {
    const o = retiro.coord
    const d = esFueraManagua && puntoLogisticoSeleccionado
      ? puntoLogisticoSeleccionado.coord
      : entrega.coord
    if (!o || !d) return

    const key = `${o.lat.toFixed(5)},${o.lng.toFixed(5)}-${d.lat.toFixed(5)},${d.lng.toFixed(5)}`
    if (key === lastCalcKey.current) return
    lastCalcKey.current = key

    setCalcLoading(true)
    setCalcError(null)
    calcularDistancia(o, d)
      .then((result) => {
        if (result) {
          setCalcResult(result)
          setDraftRetiroStale(false)
          setDraftEntregaStale(false)
          draftRetiroCoord.current = retiro.coord
          draftEntregaCoord.current = entrega.coord
        } else setCalcError('No se pudo calcular la distancia entre estos puntos.')
      })
      .catch(() => setCalcError('Error al calcular distancia.'))
      .finally(() => setCalcLoading(false))
  }

  const tieneCotizacion = !!draft
  const precioSugerido = useMemo(() => {
    const p = draft?.precioCordobas
    return typeof p === 'number' ? p : null
  }, [draft])

  const recargoZona = useMemo(() => {
    const zr = zonaPreview?.zonaRetiroNombre ?? zonaPreview?.macroZonaRetiroNombre ?? null
    const ze = zonaPreview?.zonaEntregaNombre ?? zonaPreview?.macroZonaEntregaNombre ?? null
    return calcularRecargoZona(zr, ze)
  }, [zonaPreview])
  const recargoMonto = recargoZona.aplica ? recargoZona.monto : 0
  const recargoServicioMonto = (esFueraManagua && metodoFueraManagua === 'bus_terminal') ? RECARGO_TERMINAL_BUS : 0

  const precioEfectivo = (() => {
    if (calcResult) return calcResult.precio === -1 ? -1 : calcResult.precio + recargoMonto + recargoServicioMonto
    // El precio del draft solo aplica si ya hay comercio seleccionado.
    // Sin comercio, el header muestra "—" para evitar datos huérfanos.
    if (!selectedOwnerUid) return null
    const base = precioSugerido ?? null
    if (base === null) return null
    return base + recargoServicioMonto
  })()
  const distanciaEfectiva = calcResult?.km ?? (selectedOwnerUid ? draft?.distanciaKm : null) ?? null

  const entregaCoordEfectiva: LatLng | null =
    esFueraManagua && puntoLogisticoSeleccionado
      ? puntoLogisticoSeleccionado.coord
      : entrega.coord

  // Cargar puntos logísticos al montar
  useEffect(() => {
    getPuntosActivos().then(setPuntosLogisticos).catch(() => {})
  }, [])

  // Auto-sugerir terminal cuando cambia destinoFinal (bus_terminal)
  useEffect(() => {
    if (!esFueraManagua || metodoFueraManagua !== 'bus_terminal') return
    const sugeridas = sugerirPuntosParaDestino(destinoFinal, puntosLogisticos)
    setTerminalesSugeridas(sugeridas)
    if (sugeridas.length === 1) setPuntoLogisticoSeleccionado(sugeridas[0])
    else setPuntoLogisticoSeleccionado(null)
  }, [destinoFinal, puntosLogisticos, esFueraManagua, metodoFueraManagua])

  // Auto-detectar Cargotrans más cercano cuando cambia retiro.coord
  useEffect(() => {
    if (!esFueraManagua || metodoFueraManagua !== 'cargotrans' || !retiro.coord) return
    const cercano = encontrarCargotransMasCercano(retiro.coord, puntosLogisticos)
    setPuntoLogisticoSeleccionado(cercano)
  }, [retiro.coord, puntosLogisticos, esFueraManagua, metodoFueraManagua])


  // ── Favoritos: auto-seleccionar el primero cuando cambia el comercio ──
  const didAutoSelect = useRef(false)
  useEffect(() => {
    // Reset cuando cambia el comercio (solo depende del uid para evitar
    // que el re-render de selectedOwnerData pise la auto-selección)
    didAutoSelect.current = false
    setRetiro(blankRetiro())
    setRetiroLocked(false)
    setRetiroSavedCoord(null)
    // El sistema reseteó el retiro — el ref de draft debe seguir ese cambio
    // para que el stale watcher no lo detecte como modificación del usuario
    draftRetiroCoord.current = null
  }, [selectedOwnerUid])

  useEffect(() => {
    if (selectedOwnerData?.tipoCliente) {
      setTipoCliente(selectedOwnerData.tipoCliente)
    } else if (!selectedOwnerUid) {
      setTipoCliente('contado')
    }
  }, [selectedOwnerData, selectedOwnerUid])

  useEffect(() => {
    if (didAutoSelect.current) return
    if (!puntosFavoritos.length) return
    const first = puntosFavoritos.find((f) => f.key !== '__otro__')
    if (first) {
      seleccionarFavorito(first)
      didAutoSelect.current = true
      // El sistema auto-seleccionó el primer favorito — actualizamos el baseline
      // para que solo cambios posteriores del usuario se detecten como stale
      draftRetiroCoord.current = first.coord || null
    }
  }, [puntosFavoritos])

  // ── Favorito helpers ──
  const seleccionarFavorito = (fav: PuntoFavorito) => {
    if (fav.key === '__otro__') {
      setRetiro(blankRetiro())
      setRetiroLocked(false)
      return
    }
    setRetiro({
      favKey: fav.key,
      nombre: fav.nombre || fav.label || selectedOwnerData?.name || selectedOwner?.companyName || selectedOwner?.nombre || '',
      celular: fav.celular || selectedOwnerData?.phone || selectedOwner?.phone || '',
      direccion: fav.direccion || selectedOwnerData?.address || selectedOwner?.address || '',
      nota: '',
      coord: fav.coord || null,
      tipoUbicacion: fav.tipoUbicacion || 'referencial',
    })
    setRetiroSavedCoord(fav.coord || null)
    if (fav.coord) setRetiroLocked(true)
  }

  // ── Retiro autocomplete ──
  const handleSelectRetiro = (c: ClienteGuardado) => {
    setRetiro((prev) => ({
      ...prev,
      favKey: '__otro__',
      nombre: c.nombre || '',
      celular: c.celular || '',
      direccion: c.direccion || '',
      nota: c.nota || '',
      coord: c.coord || null,
      tipoUbicacion: c.tipoUbicacion || 'referencial',
    }))
  }

  // ── Entrega autocomplete ──
  const handleSelectEntrega = (c: ClienteGuardado) => {
    setEntrega({
      nombre: c.nombre || '',
      celular: c.celular || '',
      direccion: c.direccion || '',
      nota: c.nota || '',
      coord: c.coord || null,
      tipoUbicacion: c.tipoUbicacion || 'referencial',
    })
    setEntregaSavedCoord(c.coord || null)
    if (c.coord) setEntregaLocked(true)
    else setEntregaLocked(false)
  }

  // ── Invert ──
  const handleInvertir = () => {
    const r = { ...retiro }
    const e = { ...entrega }
    setRetiro({
      favKey: '__otro__',
      nombre: e.nombre,
      celular: e.celular,
      direccion: e.direccion,
      nota: e.nota,
      coord: e.coord,
      tipoUbicacion: e.tipoUbicacion,
    })
    setEntrega({
      nombre: r.nombre,
      celular: r.celular,
      direccion: r.direccion,
      nota: r.nota,
      coord: r.coord,
      tipoUbicacion: r.tipoUbicacion,
    })
  }

  const handleQuitarCotizacion = () => {
    try { sessionStorage.removeItem('draftEnvio') } catch {}
    setDraft(null)
    setCalcResult(null)
    setDraftRetiroStale(false)
    setDraftEntregaStale(false)
    lastCalcKey.current = null
    setMsg({ type: 'info', text: 'Cotización quitada. El sistema calculará el precio con los puntos del mapa.' })
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
    if (!selectedOwnerUid) f.push('Seleccionar el comercio dueño')
    if (!retiro.nombre.trim()) f.push('Nombre de retiro')
    if (!retiro.celular.trim()) f.push('Celular de retiro')
    else if (!validarCelular(retiro.celular)) f.push('Celular de retiro — 8 dígitos')
    if (!retiro.direccion.trim()) f.push('Dirección de retiro')
    if (!esFueraManagua) {
      if (!entrega.nombre.trim()) f.push('Nombre de entrega')
      if (!entrega.celular.trim()) f.push('Celular de entrega')
      else if (!validarCelular(entrega.celular)) f.push('Celular de entrega — 8 dígitos')
      if (!entrega.direccion.trim()) f.push('Dirección de entrega')
    } else if (metodoFueraManagua === 'bus_terminal' && !destinoFinal.trim()) {
      f.push('Destino del paquete (fuera de Managua)')
    }
    if (!esFueraManagua && cobroCE && (montoCE === '' || Number(montoCE) <= 0)) f.push('Monto del cobro contra entrega')
    if (esFueraManagua && metodoFueraManagua === 'cargotrans' && !pagoCargotrans) f.push('Forma de pago del flete de Cargotrans')
    if (tipoCliente === 'contado' && !quienPagaDelivery) f.push('Quién paga el delivery')
    if (esProgramado && (tipoProgramado === 'retiro' || tipoProgramado === 'ambos') && !fechaRetiro) f.push('Fecha de retiro programado')
    if (esProgramado && (tipoProgramado === 'entrega' || tipoProgramado === 'ambos') && !fechaEntrega) f.push('Fecha de entrega programada')
    return f
  }, [selectedOwnerUid, retiro, entrega, cobroCE, montoCE, pagoCargotrans, tipoCliente, quienPagaDelivery, esProgramado, tipoProgramado, fechaRetiro, fechaEntrega, esFueraManagua, metodoFueraManagua, destinoFinal])

  const formularioCompleto = camposFaltantes.length === 0

  // ── Price calcs ──
  const montoProducto = cobroCE && montoCE !== '' ? Number(montoCE) : 0
  const montoDelivery = precioEfectivo ?? 0
  const esOtro = retiro.favKey === '__otro__'

  const destinatarioPagaTotal = useMemo(() => {
    if (!cobroCE) return montoDelivery
    if (tipoCliente !== 'contado') return montoProducto
    if (quienPagaDelivery === 'entrega') {
      return deducirDelivery === 'deducir_del_cobro' ? montoProducto : montoProducto + montoDelivery
    }
    return montoProducto
  }, [cobroCE, montoProducto, montoDelivery, tipoCliente, quienPagaDelivery, deducirDelivery])

  const montoADepositarComercio = useMemo(() => {
    if (!cobroCE) return 0
    if (tipoCliente !== 'contado') return montoProducto
    if (quienPagaDelivery === 'entrega') {
      return deducirDelivery === 'deducir_del_cobro'
        ? Math.max(montoProducto - montoDelivery, 0)
        : montoProducto
    }
    return montoProducto
  }, [cobroCE, montoProducto, montoDelivery, tipoCliente, quienPagaDelivery, deducirDelivery])

  // ── Preview de zona (se actualiza al cambiar coords de retiro o entrega) ──
  useEffect(() => {
    const retiroCoord = retiro.coord || null
    const entregaCoord = esFueraManagua && puntoLogisticoSeleccionado
      ? puntoLogisticoSeleccionado.coord
      : entrega.coord || null
    if (!retiroCoord && !entregaCoord) { setZonaPreview(null); return }
    let cancelled = false
    getZonasActivas().then((zonas) => {
      if (cancelled) return
      const { zonaRetiroNombre, zonaEntregaNombre, macroZonaRetiroNombre, macroZonaEntregaNombre } = clasificarOrdenCompleto(retiroCoord, entregaCoord, zonas)
      setZonaPreview({ zonaRetiroNombre, zonaEntregaNombre, macroZonaRetiroNombre, macroZonaEntregaNombre })
    }).catch(() => setZonaPreview(null))
    return () => { cancelled = true }
  }, [retiro.coord, entrega.coord, esFueraManagua, puntoLogisticoSeleccionado])

  // ── Save ──
  const handleGuardar = async () => {
    setMsg(null)
    if (!formularioCompleto || !selectedOwner) {
      setMsg({ type: 'error', text: `Completa lo pendiente: ${camposFaltantes.join(', ')}.` })
      return
    }

    try {
      setSaving(true)
      const gestorUid = auth.currentUser?.uid || null

      // Clasificar zonas antes de guardar la orden
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

      const deducirAplica =
        tipoCliente === 'contado' &&
        cobroCE &&
        quienPagaDelivery === 'entrega' &&
        deducirDelivery === 'deducir_del_cobro'
      const tieneCalculo = !!calcResult || !!draft

      await addDoc(collection(db, 'solicitudes_envio'), {
        // comercioId es la identidad canónica del comercio dueño de la orden.
        // userId y comercioUid quedan como alias en retirada: se siguen
        // escribiendo con el mismo valor mientras los consumidores y el
        // backfill de los documentos históricos no hayan migrado.
        //
        // Solo se escribe cuando el propietario es realmente un comercio. Para
        // un cliente individual, selectedOwner.uid es el Auth UID de una
        // persona y no existe en comercios/: meterlo en comercioId lo haría
        // pasar por un comercio y envenenaría las reglas de pertenencia que
        // vienen después. La orden personal conserva su forma heredada
        // (userId, comercioUid, ownerSnapshot) y se queda sin comercioId a
        // propósito, hasta que exista un modelo canónico propio para clientes.
        ...(selectedOwner.tipo === 'comercio' ? { comercioId: selectedOwner.uid } : {}),
        userId: selectedOwner.uid,
        comercioUid: selectedOwner.uid,
        ownerSnapshot: {
          uid: selectedOwner.uid,
          companyName: selectedOwner.companyName || selectedOwner.nombre || '',
          nombre: selectedOwner.nombre || '',
        },
        tipoCliente,
        tieneCotizacion: tieneCalculo,
        cotizacion: tieneCalculo
          ? {
              origenTextoGoogle: draft?.origen || null,
              destinoTextoGoogle: draft?.destino || null,
              origenCoord: retiro.coord || draft?.origenCoord || null,
              destinoCoord: entrega.coord || draft?.destinoCoord || null,
              distanciaKm: distanciaEfectiva ?? null,
              precioSugerido: precioEfectivo ?? null,
            }
          : {
              origenTextoGoogle: null,
              destinoTextoGoogle: null,
              origenCoord: null,
              destinoCoord: null,
              distanciaKm: null,
              precioSugerido: null,
            },
        recoleccion: {
          favoritoKey: retiro.favKey,
          nombreApellido: retiro.nombre.trim(),
          celular: retiro.celular.trim(),
          direccionEscrita: retiro.direccion.trim(),
          notaMotorizado: retiro.nota.trim() || null,
          coord: retiro.coord || null,
          geocodeGoogle: geocodeRetiro.trim() || null,
          puntoGoogleTipo: retiro.tipoUbicacion,
        },
        entrega: {
          nombreApellido: entrega.nombre.trim(),
          celular: entrega.celular.trim(),
          direccionEscrita: entrega.direccion.trim(),
          notaMotorizado: entrega.nota.trim() || null,
          coord: entrega.coord || null,
          geocodeGoogle: geocodeEntrega.trim() || null,
          puntoGoogleTipo: entrega.tipoUbicacion,
        },
        cobroContraEntrega: {
          aplica: esFueraManagua ? false : cobroCE,
          monto: esFueraManagua ? 0 : (cobroCE ? Number(montoCE) : 0),
        },
        pagoDelivery:
          tipoCliente === 'credito'
            ? { tipo: 'credito_semanal', quienPaga: 'credito_semanal', montoSugerido: precioEfectivo }
            : {
                tipo: 'contado',
                quienPaga: quienPagaDelivery,
                montoSugerido: precioEfectivo,
                deducirDelCobroContraEntrega: deducirAplica,
              },
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
        requiereBolso: selectedOwnerData?.requiereBolso ?? false,
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
        creadoInternamente: true,
        creadoPorGestorUid: gestorUid,
      })

      // Guardar cliente de entrega vinculado al comercio
      await guardarClienteEntrega(selectedOwner.uid, {
        nombre: entrega.nombre.trim(),
        celular: entrega.celular.trim(),
        direccion: entrega.direccion.trim(),
        nota: entrega.nota.trim() || undefined,
        coord: entrega.coord || undefined,
        tipoUbicacion: entrega.tipoUbicacion,
      })

      // Guardar punto de retiro al pool global (solo si fue ingresado manualmente)
      if (esOtro && retiro.nombre.trim() && retiro.celular.trim()) {
        await guardarPuntoRetiroPool({
          nombre: retiro.nombre.trim(),
          celular: retiro.celular.trim(),
          direccion: retiro.direccion.trim(),
          nota: retiro.nota.trim() || undefined,
          coord: retiro.coord,
          tipoUbicacion: retiro.tipoUbicacion,
        })
      }

      setMsg({ type: 'success', text: `Orden creada para ${selectedOwner.companyName || selectedOwner.nombre}.` })

      // Reset form pero mantén el comercio seleccionado
      const firstFav = puntosFavoritos.find((f) => f.key !== '__otro__')
      if (firstFav) seleccionarFavorito(firstFav)
      else setRetiro(blankRetiro())
      setEntrega(blankEntrega())
      setCobroCE(false)
      setMontoCE('')
      setQuienPagaDelivery('')
      setDeducirDelivery('no_deducir')
      setDetalle('')
      setCalcResult(null)
      setCalcError(null)
      lastCalcKey.current = null
      setShowNotaRetiro(false); setShowNotaEntrega(false)
      setFragil(false); setGrande(false); setNotaPaquete('')
      setGeoRetiro(''); setGeoEntrega('')
      setNumeroOrden('')
      setEsProgramado(false); setTipoProgramado('retiro'); setFechaRetiro(''); setHoraRetiro(''); setFechaEntrega(''); setHoraEntrega('')
      setEsFueraManagua(false); setMetodoFueraManagua('bus_terminal'); setDestinoFinal(''); setShowDetallesTransporte(false)
      setTransporteNombre(''); setTransporteCelular(''); setTransporteHoraSalida(''); setTransporteNota(''); setCantidadPaquetes('1'); setNotaCargotrans('')
      setPuntoLogisticoSeleccionado(null); setTerminalesSugeridas([])
      try { sessionStorage.removeItem('draftEnvio') } catch {}
      setDraft(null)
      setClienteSeleccionadoId(null)
      setClienteSeleccionadoNombre(null)
      setClienteSeleccionadoViajes(0)
      didAutoLoadCliente.current = false
      didAutoLoadComercio.current = false
      setPaso(2)
    } catch (err) {
      console.error(err)
      setMsg({ type: 'error', text: 'No se pudo guardar la orden. Intenta de nuevo.' })
    } finally {
      setSaving(false)
    }
  }

  // ── Crear nuevo comercio ──
  const crearNuevoComercio = async () => {
    if (!ncNombre.trim()) { setNcError('El nombre es obligatorio.'); return }
    if (!ncTelefono.trim()) { setNcError('El teléfono es obligatorio.'); return }

    // Verificar duplicado por teléfono o nombre
    const telNorm = ncTelefono.replace(/\D/g, '')
    const nombreNorm = ncNombre.trim().toLowerCase()
    const duplicado = comercios.find((c) => {
      const cTel = (c.phone || '').replace(/\D/g, '')
      const cNombre = (c.companyName || c.nombre || '').toLowerCase()
      return (cTel && cTel === telNorm) || cNombre === nombreNorm
    })
    if (duplicado) {
      setNcError(`Ya existe "${duplicado.companyName || duplicado.nombre}" con datos similares. ¿Es este el comercio?`)
      return
    }

    setNcGuardando(true); setNcError('')
    try {
      // comercioId permanente (Bloque A): un solo doc en comercios/, nunca en
      // usuarios/ — mismo criterio que crearComercio() en
      // app/panel/gestor/comercios/page.tsx.
      const nuevoRef = doc(collection(db, 'comercios'))
      const uid = nuevoRef.id
      await setDoc(nuevoRef, {
        name: ncNombre.trim(),
        phone: ncTelefono.trim(),
        address: ncDireccion.trim() || null,
        emailContacto: ncEmail.trim() || null,
        accesoEstado: 'sin_acceso',
        authUid: null,
        creadoPorUid: auth.currentUser?.uid ?? '',
        creadoAt: serverTimestamp(),
        updatedAt: serverTimestamp(),
      })

      // Agregar a la lista local y auto-seleccionar
      const nuevo: ComercioOption = {
        uid,
        tipo: 'comercio', // recién creado en comercios/ — ver setDoc de arriba
        nombre: ncNombre.trim(),
        email: ncEmail.trim(),
        phone: ncTelefono.trim(),
        companyName: ncNombre.trim(),
        address: ncDireccion.trim(),
      }
      setComercios((prev) =>
        [...prev, nuevo].sort((a, b) => (a.companyName || a.nombre).localeCompare(b.companyName || b.nombre))
      )
      setSelectedOwnerUid(uid)

      // Reset modal
      setModalNuevoComercio(false)
      setNcNombre(''); setNcTelefono(''); setNcEmail(''); setNcDireccion('')
    } catch (e: any) {
      setNcError('No se pudo crear el comercio. Intentá de nuevo.')
      console.error(e)
    } finally {
      setNcGuardando(false)
    }
  }

  // ── Validación por paso ──
  const puedeAvanzar = (desde: number): boolean => {
    if (desde === 1) return !!selectedOwnerUid
    if (desde === 2) {
      return !!(
        retiro.nombre.trim() &&
        retiro.celular.trim() &&
        validarCelular(retiro.celular) &&
        retiro.direccion.trim()
      )
    }
    if (desde === 3) {
      if (esFueraManagua) {
        if (metodoFueraManagua === 'bus_terminal') return destinoFinal.trim().length > 0 && puntoLogisticoSeleccionado !== null
        return true // cargotrans: sin requisitos mínimos para avanzar
      }
      return !!(
        entrega.nombre.trim() &&
        entrega.celular.trim() &&
        validarCelular(entrega.celular) &&
        entrega.direccion.trim()
      )
    }
    if (desde === 4) {
      if (esFueraManagua && metodoFueraManagua === 'cargotrans' && !pagoCargotrans) return false
      if (tipoCliente === 'contado' && !quienPagaDelivery) return false
      if (!esFueraManagua && cobroCE && (montoCE === '' || Number(montoCE) <= 0)) return false
      if (esProgramado && (tipoProgramado === 'retiro' || tipoProgramado === 'ambos') && !fechaRetiro) return false
      if (esProgramado && (tipoProgramado === 'entrega' || tipoProgramado === 'ambos') && !fechaEntrega) return false
      return true
    }
    return true
  }

  const handleSiguiente = async () => {
    if (!puedeAvanzar(paso)) return
    if (paso === 3 && esFueraManagua && puntoLogisticoSeleccionado && retiro.coord) {
      const o = retiro.coord
      const d = puntoLogisticoSeleccionado.coord
      const key = `${o.lat.toFixed(5)},${o.lng.toFixed(5)}-${d.lat.toFixed(5)},${d.lng.toFixed(5)}`
      if (key !== lastCalcKey.current || !calcResult) {
        lastCalcKey.current = key
        setCalcLoading(true); setCalcError(null)
        try {
          const result = await calcularDistancia(o, d)
          if (result) setCalcResult(result)
        } catch {}
        setCalcLoading(false)
      }
    }
    setPaso(p => p + 1)
  }

  // ─── Render ───────────────────────────────────────────────────────────────

  const todayISO = new Date().toISOString().split('T')[0]

  return (
    <div
      style={{
        fontFamily: "'SF Pro Display', -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif",
        background: '#f9fafb',
        minHeight: '100vh',
      }}
    >

      {/* ── Header sticky ── */}
      <StickyOrderHeader
        precio={precioEfectivo}
        distanciaKm={distanciaEfectiva}
        zonaRetiro={zonaPreview?.zonaRetiroNombre ?? zonaPreview?.macroZonaRetiroNombre}
        zonaEntrega={zonaPreview?.zonaEntregaNombre ?? zonaPreview?.macroZonaEntregaNombre}
        comercioNombre={selectedOwnerData?.name || selectedOwner?.companyName || selectedOwner?.nombre}
        camposFaltantes={camposFaltantes.length}
        formularioCompleto={formularioCompleto}
      />

      {/* Spacer para compensar el header fixed */}
      <div style={{ height: 54 }} />

      {/* ── Contenido del paso ── */}
      <div style={{ maxWidth: 760, margin: '0 auto', padding: '0 16px 140px' }}>
        {/* Step indicator */}
        <StepIndicator paso={paso} setPaso={setPaso} puedeAvanzar={puedeAvanzar} />

        {/* ════ PASO 1: COMERCIO ════ */}
        {paso === 1 && (
          <div>
            <div style={{ marginBottom: 20 }}>
              <h2 style={{ fontSize: 20, fontWeight: 800, color: '#111827', margin: '0 0 4px' }}>Dueño de la orden</h2>
              <p style={{ fontSize: 13, color: '#6b7280', margin: 0 }}>¿A qué comercio pertenece este pedido?</p>
            </div>

            <SectionCard title="Comercio / cliente" icon="🏪">
              <Field label="Comercio / cliente" required hint="La orden se guardará y cobrará a este comercio.">
          <div style={{ display: 'flex', gap: 8 }}>
            {selectedOwner ? (
              <div style={{ ...S.input, flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'space-between', background: '#f9fafb' }}>
                <span style={{ fontWeight: 700, color: '#111827' }}>
                  {selectedOwnerData?.name || selectedOwner.companyName || selectedOwner.nombre}
                </span>
                <button
                  type="button"
                  onClick={() => { setSelectedOwnerUid('') }}
                  style={{ border: 'none', background: 'none', cursor: 'pointer', color: '#9ca3af', fontSize: 16, padding: '0 4px', lineHeight: 1 }}
                >
                  ✕
                </button>
              </div>
            ) : (
              <button
                type="button"
                onClick={() => !loadingComercios && setShowComercioModal(true)}
                style={{
                  ...S.input, flex: 1, textAlign: 'left' as const, cursor: loadingComercios ? 'not-allowed' : 'pointer',
                  color: '#9ca3af', display: 'flex', alignItems: 'center', gap: 8,
                  background: loadingComercios ? '#f9fafb' : '#fff',
                }}
              >
                <span style={{ fontSize: 15 }}>🔍</span>
                <span style={{ fontSize: 14 }}>
                  {loadingComercios ? 'Cargando comercios...' : `Buscar entre ${comercios.length} comercios…`}
                </span>
              </button>
            )}
            <button
              type="button"
              onClick={() => setShowComercioModal(true)}
              disabled={loadingComercios}
              style={{
                ...S.btnOutline,
                padding: '10px 14px', fontSize: 13, fontWeight: 700,
                whiteSpace: 'nowrap' as const, borderColor: '#004aad',
                color: '#004aad', background: '#eff6ff', height: 42,
                opacity: loadingComercios ? 0.5 : 1,
                cursor: loadingComercios ? 'not-allowed' : 'pointer',
              }}
            >
              🔍 Buscar
            </button>
            <button
              type="button"
              onClick={() => { setModalNuevoComercio(true); setNcError('') }}
              style={{ ...S.btnOutline, whiteSpace: 'nowrap' as const, fontSize: 13, padding: '9px 14px' }}
            >
              + Nuevo
            </button>
          </div>
        </Field>

        {selectedOwner && (
          <div style={{ border: '1px solid #dbeafe', background: '#eff6ff', borderRadius: 12, padding: '12px 14px' }}>
            <p style={{ margin: '0 0 4px', fontSize: 13, fontWeight: 700, color: '#1d4ed8' }}>
              Orden para: {selectedOwnerData?.name || selectedOwner.companyName || selectedOwner.nombre}
            </p>
            <p style={{ margin: 0, fontSize: 12, color: '#3b82f6' }}>
              {selectedOwner.email || 'Sin correo'}
              {(selectedOwnerData?.phone || selectedOwner.phone) ? ` · ${selectedOwnerData?.phone || selectedOwner.phone}` : ''}
            </p>
            {(selectedOwnerData?.address || selectedOwner.address) && (
              <p style={{ margin: '4px 0 0', fontSize: 12, color: '#3b82f6' }}>
                {selectedOwnerData?.address || selectedOwner.address}
              </p>
            )}
          </div>
        )}
      </SectionCard>

          {/* ── Indicador: cliente preseleccionado para entrega ── */}
          {clienteSeleccionadoId && (
            <div style={{ marginTop: 12, background: '#f0fdf4', border: '1px solid #bbf7d0', borderRadius: 10, padding: '10px 14px', display: 'flex', alignItems: 'center', gap: 10 }}>
              <span style={{ fontSize: 18 }}>📬</span>
              <div>
                <p style={{ fontSize: 13, fontWeight: 700, color: '#16a34a', margin: 0 }}>
                  Entrega preseleccionada: {clienteSeleccionadoNombre}
                </p>
                <p style={{ fontSize: 11, color: '#16a34a', margin: '2px 0 0', opacity: 0.8 }}>
                  Los datos de entrega se cargarán automáticamente en el paso 3
                </p>
              </div>
            </div>
          )}
          </div>
        )}

        {/* ════ PASO 2: RETIRO ════ */}
        {paso === 2 && (
          <div>
            <div style={{ marginBottom: 20 }}>
              <h2 style={{ fontSize: 20, fontWeight: 800, color: '#111827', margin: '0 0 4px' }}>Punto de retiro</h2>
              <p style={{ fontSize: 13, color: '#6b7280', margin: 0 }}>¿Dónde se recoge el paquete?</p>
            </div>

      {/* ── RETIRO ── */}
      <SectionCard title="Punto de retiro" icon="📦">
        {/* Aviso si no hay comercio seleccionado */}
        {!selectedOwnerUid && (
          <div style={{ background: '#fffbe6', border: '1px solid #ffe58f', borderRadius: 10, padding: '10px 14px' }}>
            <p style={{ fontSize: 12, fontWeight: 600, color: '#d46b08', margin: 0 }}>
              ⚠️ Seleccioná un comercio arriba para cargar sus puntos de retiro habituales.
            </p>
          </div>
        )}

        {/* Favoritos del comercio seleccionado */}
        {selectedOwnerUid && puntosFavoritos.length > 1 && (
          <div>
            <label style={S.label}>Punto de retiro habitual</label>
            <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' as const }}>
              {puntosFavoritos.map((fav) => (
                <button
                  key={fav.key}
                  type="button"
                  onClick={() => seleccionarFavorito(fav)}
                  style={{
                    padding: '8px 14px',
                    borderRadius: 10,
                    fontSize: 12,
                    fontWeight: 700,
                    cursor: 'pointer',
                    border: `1px solid ${retiro.favKey === fav.key ? '#004aad' : '#e5e7eb'}`,
                    background: retiro.favKey === fav.key ? '#eff6ff' : '#fff',
                    color: retiro.favKey === fav.key ? '#004aad' : '#374151',
                  }}
                >
                  {fav.key === '__otro__' ? 'Otro' : fav.label}
                </button>
              ))}
            </div>
            <p style={S.hint}>Puntos habituales del comercio seleccionado.</p>
          </div>
        )}

        {/* Sin favoritos configurados */}
        {selectedOwnerUid && puntosFavoritos.length <= 1 && (
          <div style={{ background: '#f8fafc', border: '1px solid #e2e8f0', borderRadius: 10, padding: '10px 14px' }}>
            <p style={{ fontSize: 12, color: '#6b7280', margin: 0 }}>
              Este comercio no tiene puntos de retiro configurados. Completá los datos manualmente.
            </p>
          </div>
        )}

        {esOtro ? (
          <AutocompleteInput
            label="Nombre / empresa"
            value={retiro.nombre}
            onChange={(v) => setRetiro((prev) => ({ ...prev, nombre: v, favKey: '__otro__' }))}
            onSelect={handleSelectRetiro}
            placeholder="Ej: Compras Express, Tienda San Juan..."
            clientes={poolPuntos}
            required
            comercioUidActual={selectedOwnerUid || undefined}
          />
        ) : (
          <Field label="Nombre / empresa" required>
            <input value={retiro.nombre} readOnly style={{ ...S.input, background: '#f9fafb', color: '#374151' }} />
          </Field>
        )}

        <Field label="Celular" required>
          <input
            value={retiro.celular}
            onChange={(e) => setRetiro((prev) => ({ ...prev, celular: formatCelular(e.target.value) }))}
            placeholder="Ej: 88888888"
            maxLength={8}
            style={{ ...S.input, borderColor: retiro.celular && !validarCelular(retiro.celular) ? '#dc2626' : '#e5e7eb' }}
          />
          {retiro.celular && !validarCelular(retiro.celular) && (
            <p style={{ fontSize: 11, color: '#dc2626', margin: '4px 0 0', fontWeight: 600 }}>⚠️ Debe ser 8 dígitos</p>
          )}
        </Field>

        <Field label="Dirección escrita" required hint="Descripción para que el motorizado llegue.">
          <input
            value={retiro.direccion}
            onChange={(e) => setRetiro((prev) => ({ ...prev, direccion: e.target.value }))}
            placeholder="Ej: Del semáforo 1c al sur, portón azul"
            style={S.input}
          />
        </Field>

        {/* Mapa retiro — estático si favorito con coord, interactivo si "Otro" o sin coord */}
        {!esOtro && retiro.coord ? (
          <div>
            <div style={{ background: '#f0fdf4', border: '1px solid #bbf7d0', borderRadius: 10, padding: '10px 14px', marginBottom: 8 }}>
              <p style={{ fontSize: 12, fontWeight: 600, color: '#16a34a', margin: 0 }}>🎯 Ubicación guardada en ajustes del comercio</p>
            </div>
            <StaticMiniMap
              key={`${retiro.coord.lat}-${retiro.coord.lng}`}
              coord={retiro.coord}
              color="#004aad"
              label="R"
            />
          </div>
        ) : (
          <div>
            <label style={{ ...S.label, marginBottom: 8 }}>
              Ubicación en el mapa
              {retiro.coord && <span style={{ color: '#16a34a', fontWeight: 700, marginLeft: 8 }}>✓ Marcada</span>}
            </label>

            {/* Banner: el punto favorito tiene coord guardado y fue movido */}
            {retiroSavedCoord && !coordsMatch(retiro.coord, retiroSavedCoord) && (
              <div style={{ background: '#fffbe6', border: '1px solid #ffe58f', borderRadius: 8, padding: '8px 12px', display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8, marginBottom: 8 }}>
                <span style={{ fontSize: 12, color: '#92400e', fontWeight: 600 }}>
                  📍 Este punto tiene una ubicación guardada
                </span>
                <button
                  type="button"
                  onClick={() => {
                    setRetiro((prev) => ({ ...prev, coord: retiroSavedCoord }))
                    setRetiroLocked(true)
                  }}
                  style={{ background: '#d97706', border: 'none', borderRadius: 6, padding: '5px 12px', fontSize: 12, fontWeight: 700, color: '#fff', cursor: 'pointer', whiteSpace: 'nowrap' as const }}
                >
                  Usar punto guardado
                </button>
              </div>
            )}

            {entradaNoResuelta && (
              <p style={{ fontSize: 11, color: '#b45309', background: '#fffbeb', border: '1px solid #fde68a', borderRadius: 8, padding: '5px 10px', margin: '0 0 8px', lineHeight: 1.4 }}>
                ℹ️ {entradaNoResuelta}
              </p>
            )}
            <MiniMap
              etiquetarPuntoManual={etiquetarManual}
              resolverEntradaTexto={resolverTexto}
              onEntradaNoResuelta={setEntradaNoResuelta}
              coord={retiro.coord}
              color="#004aad"
              label="R"
              locked={retiroLocked}
              onUnlock={() => setRetiroLocked(false)}
              onSelect={(c) => { setRetiro((prev) => ({ ...prev, coord: c })); setRetiroLocked(true) }}
              onGeocode={(addr) => setGeoRetiro(addr)}
            />
          </div>
        )}

        <UbicacionTipo
          value={retiro.tipoUbicacion}
          onChange={(v) => setRetiro((prev) => ({ ...prev, tipoUbicacion: v }))}
        />

        {/* Instrucciones adicionales retiro */}
        <div>
          <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
            <button type="button" onClick={() => setShowNotaRetiro(v => !v)} style={{ width: 20, height: 20, borderRadius: 4, border: `2px solid ${showNotaRetiro ? '#004aad' : '#d1d5db'}`, background: showNotaRetiro ? '#004aad' : '#fff', display: 'flex', alignItems: 'center', justifyContent: 'center', cursor: 'pointer', flexShrink: 0 }}>
              {showNotaRetiro && <span style={{ color: '#fff', fontSize: 12, fontWeight: 900 }}>✓</span>}
            </button>
            <label style={{ fontSize: 13, fontWeight: 600, color: '#374151', cursor: 'pointer' }} onClick={() => setShowNotaRetiro(v => !v)}>
              ¿Hay instrucciones adicionales para el motorizado en el retiro?
            </label>
          </div>
          {showNotaRetiro && (
            <textarea value={retiro.nota} onChange={(e) => setRetiro((prev) => ({ ...prev, nota: e.target.value }))} placeholder="Ej: Llamar al llegar, preguntar por Juan, bus 3:30pm Mayoreo..." style={{ ...S.input, resize: 'vertical' as const, minHeight: 70, marginTop: 8 }} rows={2} />
          )}
        </div>
      </SectionCard>
          </div>
        )}

        {/* ════ PASO 3: ENTREGA ════ */}
        {paso === 3 && (
          <div>
            <div style={{ marginBottom: 20 }}>
              <h2 style={{ fontSize: 20, fontWeight: 800, color: '#111827', margin: '0 0 4px' }}>Punto de entrega</h2>
              <p style={{ fontSize: 13, color: '#6b7280', margin: 0 }}>¿A quién se entrega y dónde?</p>
            </div>

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
            <div>
            {/* ── Banner: cliente preseleccionado ── */}
            {clienteSeleccionadoId && (
              <div style={{ background: '#f0fdf4', border: '1px solid #bbf7d0', borderRadius: 12, padding: '10px 14px', marginBottom: 16, display: 'flex', alignItems: 'center', justifyContent: 'space-between', flexWrap: 'wrap', gap: 8 }}>
                <div>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
                    <span style={{ fontSize: 13, fontWeight: 800, color: '#16a34a' }}>
                      ✔ Cliente: {clienteSeleccionadoNombre}
                    </span>
                    {clienteSeleccionadoViajes >= 5 && (
                      <span style={{ fontSize: 10, fontWeight: 700, padding: '2px 7px', borderRadius: 6, background: '#fdf4ff', color: '#7c3aed', border: '1px solid #e9d5ff' }}>⭐ Frecuente</span>
                    )}
                  </div>
                  <p style={{ fontSize: 11, color: '#16a34a', margin: '3px 0 0', opacity: 0.8 }}>Datos cargados automáticamente</p>
                </div>
                <button
                  type="button"
                  onClick={() => {
                    setClienteSeleccionadoId(null)
                    setClienteSeleccionadoNombre(null)
                    setClienteSeleccionadoViajes(0)
                    setEntrega({ nombre: '', celular: '', direccion: '', nota: '', coord: null, tipoUbicacion: 'referencial' })
                    setEntregaSavedCoord(null)
                    setEntregaLocked(false)
                  }}
                  style={{ fontSize: 11, color: '#6b7280', background: 'none', border: '1px solid #d1d5db', borderRadius: 6, padding: '4px 10px', cursor: 'pointer', fontWeight: 600 }}
                >
                  Quitar
                </button>
              </div>
            )}

      <SectionCard title="Punto de entrega" icon="🏠">
        {/* Nombre del destinatario + botón para abrir modal buscador */}
        <div>
          <div style={{ display: 'flex', alignItems: 'flex-end', gap: 8 }}>
            <div style={{ flex: 1 }}>
              <AutocompleteInput
                label="Nombre del destinatario"
                value={entrega.nombre}
                onChange={(v) => setEntrega((prev) => ({ ...prev, nombre: v }))}
                onSelect={handleSelectEntrega}
                placeholder="Ej: María García"
                clientes={poolPuntos}
                comercioUidActual={selectedOwnerUid || undefined}
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
                marginBottom: 0,
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
            onChange={(v) => setEntrega((prev) => ({ ...prev, celular: formatCelular(v) }))}
            onSelect={handleSelectEntrega}
            placeholder="Ej: 77777777"
            clientes={poolPuntos}
            comercioUidActual={selectedOwnerUid || undefined}
            required
          />
          {entrega.celular && !validarCelular(entrega.celular) && (
            <p style={{ fontSize: 11, color: '#dc2626', margin: '4px 0 0', fontWeight: 600 }}>⚠️ Debe ser 8 dígitos</p>
          )}
        </div>

        <Field label="Dirección escrita" required hint="Descripción detallada para que el motorizado llegue.">
          <input
            value={entrega.direccion}
            onChange={(e) => setEntrega((prev) => ({ ...prev, direccion: e.target.value }))}
            placeholder="Ej: Frente al parque, portón negro, casa esquinera"
            style={S.input}
          />
        </Field>

        <div>
          <label style={{ ...S.label, marginBottom: 8 }}>
            Ubicación en el mapa
            {entrega.coord && <span style={{ color: '#16a34a', fontWeight: 700, marginLeft: 8 }}>✓ Marcada</span>}
          </label>

          {/* Banner: el cliente tiene coord guardado y el punto actual difiere */}
          {entregaSavedCoord && !coordsMatch(entrega.coord, entregaSavedCoord) && (
            <div style={{ background: '#fffbe6', border: '1px solid #ffe58f', borderRadius: 8, padding: '8px 12px', display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8, marginBottom: 8 }}>
              <span style={{ fontSize: 12, color: '#92400e', fontWeight: 600 }}>
                📍 Este cliente tiene una ubicación guardada
              </span>
              <button
                type="button"
                onClick={() => {
                  setEntrega((prev) => ({ ...prev, coord: entregaSavedCoord }))
                  setEntregaLocked(true)
                }}
                style={{ background: '#d97706', border: 'none', borderRadius: 6, padding: '5px 12px', fontSize: 12, fontWeight: 700, color: '#fff', cursor: 'pointer', whiteSpace: 'nowrap' as const }}
              >
                Usar punto guardado
              </button>
            </div>
          )}

          <MiniMap
            etiquetarPuntoManual={etiquetarManual}
            resolverEntradaTexto={resolverTexto}
            onEntradaNoResuelta={setEntradaNoResuelta}
            coord={entrega.coord}
            color="#16a34a"
            label="E"
            locked={entregaLocked}
            onUnlock={() => setEntregaLocked(false)}
            onSelect={(c) => { setEntrega((prev) => ({ ...prev, coord: c })); setEntregaLocked(true) }}
            onGeocode={(addr) => setGeoEntrega(addr)}
          />
        </div>

        <UbicacionTipo
          value={entrega.tipoUbicacion}
          onChange={(v) => setEntrega((prev) => ({ ...prev, tipoUbicacion: v }))}
        />

        {/* Instrucciones adicionales entrega */}
        <div>
          <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
            <button type="button" onClick={() => setShowNotaEntrega(v => !v)} style={{ width: 20, height: 20, borderRadius: 4, border: `2px solid ${showNotaEntrega ? '#004aad' : '#d1d5db'}`, background: showNotaEntrega ? '#004aad' : '#fff', display: 'flex', alignItems: 'center', justifyContent: 'center', cursor: 'pointer', flexShrink: 0 }}>
              {showNotaEntrega && <span style={{ color: '#fff', fontSize: 12, fontWeight: 900 }}>✓</span>}
            </button>
            <label style={{ fontSize: 13, fontWeight: 600, color: '#374151', cursor: 'pointer' }} onClick={() => setShowNotaEntrega(v => !v)}>
              ¿Hay instrucciones adicionales para el motorizado en la entrega?
            </label>
          </div>
          {showNotaEntrega && (
            <textarea value={entrega.nota} onChange={(e) => setEntrega((prev) => ({ ...prev, nota: e.target.value }))} placeholder="Ej: Solo disponible entre 2-4pm, preguntar por María, portón verde..." style={{ ...S.input, resize: 'vertical' as const, minHeight: 70, marginTop: 8 }} rows={2} />
          )}
        </div>

        {/* ── Actualizar datos del cliente ── */}
        {clienteSeleccionadoId && (
          <div style={{ borderTop: '1px solid #f3f4f6', paddingTop: 14, marginTop: 4 }}>
            <p style={{ fontSize: 12, color: '#9ca3af', margin: '0 0 8px' }}>¿Modificaste la dirección o ubicación?</p>
            <button
              type="button"
              onClick={async () => {
                if (!clienteSeleccionadoId || !entrega.celular.trim()) return
                try {
                  const payload: Record<string, any> = {
                    nombre: entrega.nombre.trim(),
                    celular: entrega.celular.trim(),
                    updatedAt: serverTimestamp(),
                  }
                  if (entrega.direccion.trim()) payload.direccion = entrega.direccion.trim()
                  if (entrega.nota.trim()) payload.nota = entrega.nota.trim()
                  if (entrega.coord) payload.coord = entrega.coord
                  if (entrega.tipoUbicacion) payload.tipoUbicacion = entrega.tipoUbicacion
                  await setDoc(doc(db, 'clientes_envio', clienteSeleccionadoId), payload, { merge: true })
                  setMsg({ type: 'success', text: 'Datos del cliente actualizados.' })
                } catch {
                  setMsg({ type: 'error', text: 'No se pudieron actualizar los datos del cliente.' })
                }
              }}
              style={{ fontSize: 12, fontWeight: 700, padding: '7px 14px', borderRadius: 8, background: '#fff', border: '1px solid #e5e7eb', color: '#374151', cursor: 'pointer' }}
            >
              💾 Actualizar datos del cliente
            </button>
          </div>
        )}
      </SectionCard>
            </div>
            )}

            {/* Fuera de Managua: flujo especializado */}
            {esFueraManagua && (
            <div style={{ ...S.sectionCard }}>
              <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
                {/* Selector de método */}
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
                        onClick={() => { setMetodoFueraManagua(opt.value); setPuntoLogisticoSeleccionado(null); setTerminalesSugeridas([]) }}
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
                    <div>
                      <label style={S.label}>Destino del paquete <span style={{ color: '#dc2626' }}>*</span></label>
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
                        <div style={{ marginTop: 6, background: '#eff6ff', border: '1px solid #bfdbfe', borderRadius: 8, padding: '8px 12px' }}>
                          <p style={{ fontSize: 12, fontWeight: 700, color: '#1d4ed8', margin: '0 0 6px' }}>🏢 Encontramos más de una terminal compatible. Seleccioná la preferida:</p>
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
                    </div>

                    <button type="button" onClick={() => setShowDetallesTransporte(v => !v)} style={{ textAlign: 'left' as const, padding: '8px 12px', borderRadius: 8, border: '1px solid #e5e7eb', background: '#f9fafb', cursor: 'pointer', fontSize: 12, color: '#6b7280', fontWeight: 600 }}>
                      {showDetallesTransporte ? '▲' : '▼'} ¿Tenés información del transporte? (opcional)
                    </button>
                    {showDetallesTransporte && (
                      <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
                        <div><label style={S.label}>Nombre del transporte / bus</label><input value={transporteNombre} onChange={e => setTransporteNombre(e.target.value)} placeholder="Ej: Cotran Norte, El Exprés..." style={S.input} /></div>
                        <div><label style={S.label}>Celular del transporte</label><input value={transporteCelular} onChange={e => setTransporteCelular(formatCelular(e.target.value))} placeholder="Ej: 88888888" maxLength={8} style={S.input} /></div>
                        <div><label style={S.label}>Hora de salida de Managua</label><input type="time" value={transporteHoraSalida} onChange={e => setTransporteHoraSalida(e.target.value)} style={S.input} /></div>
                        <div><label style={S.label}>Nota adicional</label><textarea value={transporteNota} onChange={e => setTransporteNota(e.target.value)} placeholder="Instrucciones adicionales..." style={{ ...S.input, resize: 'vertical' as const, minHeight: 60 }} rows={2} /></div>
                      </div>
                    )}
                  </>
                )}

                {/* Cargotrans */}
                {metodoFueraManagua === 'cargotrans' && (
                  <>
                    <div><label style={S.label}>Cantidad de paquetes</label><input type="number" min="1" value={cantidadPaquetes} onChange={e => setCantidadPaquetes(e.target.value)} placeholder="1" style={S.input} /></div>
                    <div><label style={S.label}>Nota</label><textarea value={notaCargotrans} onChange={e => setNotaCargotrans(e.target.value)} placeholder="Instrucciones o detalles del envío..." style={{ ...S.input, resize: 'vertical' as const, minHeight: 60 }} rows={2} /></div>
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
                        <p style={{ fontSize: 12, color: '#92400e', margin: 0 }}>📦 Shenvio buscará la sucursal Cargotrans más cercana a tu punto de retiro.</p>
                      </div>
                    )}
                  </>
                )}
              </div>
            </div>
            )}
          </div>
        )}

        {/* ════ PASO 4: PAGO & EXTRAS ════ */}
        {paso === 4 && (
          <div>
            <div style={{ marginBottom: 20 }}>
              <h2 style={{ fontSize: 20, fontWeight: 800, color: '#111827', margin: '0 0 4px' }}>Pago y detalles</h2>
              <p style={{ fontSize: 13, color: '#6b7280', margin: 0 }}>Tipo de cliente, cobros, paquete y programación.</p>
            </div>

            {/* Precio estimado */}
            {(retiro.coord || entregaCoordEfectiva) && (
        <div style={{ ...S.sectionCard, background: '#f8fafc', border: '1px solid #e2e8f0', marginBottom: 16 }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 12 }}>
            <h3 style={{ fontSize: 14, fontWeight: 700, color: '#374151', margin: 0, textTransform: 'uppercase' as const, letterSpacing: 0.5 }}>
              Precio estimado
            </h3>
            {retiro.coord && entregaCoordEfectiva && (
              <button
                type="button"
                onClick={handleCalcularPrecio}
                disabled={calcLoading}
                style={{ background: '#004aad', border: 'none', borderRadius: 10, padding: '8px 16px', color: '#fff', fontSize: 13, fontWeight: 700, cursor: calcLoading ? 'not-allowed' : 'pointer', opacity: calcLoading ? 0.7 : 1 }}
              >
                {calcLoading ? '⏳ Calculando...' : calcResult ? '🔄 Recalcular' : (draftRetiroStale || draftEntregaStale) ? '🔄 Recalcular viaje' : '🧮 Calcular precio'}
              </button>
            )}
          </div>

          {retiro.coord && entregaCoordEfectiva && (
            <div style={{ marginBottom: 14 }}>
              <RoutePreviewMap origen={retiro.coord} destino={entregaCoordEfectiva} />
            </div>
          )}

          {calcError && <p style={{ fontSize: 13, color: '#dc2626', margin: '0 0 10px' }}>⚠️ {calcError}</p>}

          {calcResult ? (
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', background: '#fff', border: '1px solid #bfdbfe', borderRadius: 12, padding: '14px 16px' }}>
              <div>
                <p style={{ fontSize: 11, fontWeight: 700, color: '#9ca3af', textTransform: 'uppercase' as const, letterSpacing: 0.5, margin: '0 0 4px' }}>
                  Calculado automáticamente
                </p>
                {calcResult.precio === -1 ? (
                  <p style={{ fontSize: 28, fontWeight: 900, color: '#d97706', margin: 0 }}>Consultar</p>
                ) : (recargoZona.aplica || recargoServicioMonto > 0) ? (
                  <>
                    <p style={{ fontSize: 12, color: '#6b7280', margin: '0 0 2px' }}>Delivery base: <strong>C$ {calcResult.precio}</strong></p>
                    {recargoZona.aplica && <p style={{ fontSize: 12, fontWeight: 700, color: '#ea580c', margin: '0 0 2px' }}>+ Zona {recargoZona.zona}: +C$ {recargoZona.monto}</p>}
                    {recargoServicioMonto > 0 && <p style={{ fontSize: 12, fontWeight: 700, color: '#7c3aed', margin: '0 0 2px' }}>+ Terminal / bus: +C$ {recargoServicioMonto}</p>}
                    <p style={{ fontSize: 28, fontWeight: 900, color: '#004aad', margin: 0, letterSpacing: -1 }}>C$ {calcResult.precio + recargoMonto + recargoServicioMonto}</p>
                  </>
                ) : (
                  <p style={{ fontSize: 28, fontWeight: 900, color: '#004aad', margin: 0, letterSpacing: -1 }}>C$ {calcResult.precio}</p>
                )}
                <p style={{ fontSize: 12, color: '#6b7280', margin: '4px 0 0' }}>
                  {calcResult.km.toFixed(2)} km · sujeto a confirmación del gestor
                </p>
              </div>
              <span style={{ fontSize: 32 }}>🧮</span>
            </div>
          ) : (draftRetiroStale || draftEntregaStale) && precioSugerido ? (
            <StaleCalcWarning
              retiroStale={draftRetiroStale}
              entregaStale={draftEntregaStale}
              precioAnterior={precioSugerido}
              distanciaAnteriorKm={draft?.distanciaKm}
            />
          ) : precioSugerido ? (
            <div style={{ background: '#fff', border: '1px solid #bbf7d0', borderRadius: 12, padding: '14px 16px' }}>
              <p style={{ fontSize: 11, fontWeight: 700, color: '#9ca3af', textTransform: 'uppercase' as const, letterSpacing: 0.5, margin: '0 0 4px' }}>
                Desde cotización previa
              </p>
              <p style={{ fontSize: 28, fontWeight: 900, color: '#004aad', margin: 0 }}>C$ {precioSugerido}</p>
              {distanciaEfectiva && (
                <p style={{ fontSize: 12, color: '#6b7280', margin: '4px 0 0' }}>{distanciaEfectiva.toFixed(2)} km</p>
              )}
            </div>
          ) : !retiro.coord || !entregaCoordEfectiva ? (
            <div style={{ background: '#fffbe6', border: '1px solid #ffe58f', borderRadius: 12, padding: '12px 14px', textAlign: 'center' as const }}>
              <p style={{ fontSize: 13, color: '#d46b08', fontWeight: 600, margin: 0 }}>
                {!retiro.coord && !entregaCoordEfectiva
                  ? esFueraManagua ? 'Marcá el punto de retiro y seleccioná un punto logístico' : 'Marcá ambos puntos en el mapa para calcular el precio'
                  : !retiro.coord
                    ? 'Falta marcar el punto de retiro'
                    : esFueraManagua ? 'Seleccioná el punto logístico de destino' : 'Falta marcar el punto de entrega'}
              </p>
            </div>
          ) : null}
        </div>
      )}

      {/* ── ENVÍO PROGRAMADO ── */}
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
                  <p style={{ fontSize: 11, color: '#9ca3af', margin: 0 }}>La solicitud quedará como <strong>programada</strong> hasta esa fecha.</p>
                </div>
              )}
            </div>
          </SectionCard>

            {/* Tipo de cliente (definido en el perfil del comercio) */}
            <div style={{ ...S.sectionCard, marginBottom: 16, background: tipoCliente === 'credito' ? '#f5f3ff' : '#f9fafb', border: `1px solid ${tipoCliente === 'credito' ? '#ddd6fe' : '#e5e7eb'}` }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 10 }}>
                <div>
                  <p style={{ fontSize: 14, fontWeight: 700, color: '#111827', margin: '0 0 2px' }}>Tipo de pago</p>
                  <p style={{ fontSize: 12, color: '#6b7280', margin: 0 }}>Configurado en el perfil del comercio</p>
                </div>
                <span style={{ padding: '6px 14px', borderRadius: 10, fontSize: 13, fontWeight: 700, background: tipoCliente === 'credito' ? '#7c3aed' : '#374151', color: '#fff' }}>
                  {tipoCliente === 'credito' ? '🗓 Crédito semanal' : '💵 Contado'}
                </span>
              </div>
            </div>

      {/* ── PAQUETE ── */}
      <SectionCard title="Datos del paquete" icon="📦">
        <div style={{ display: 'flex', gap: 20, flexWrap: 'wrap' as const }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
            <button
              type="button"
              onClick={() => setFragil(v => !v)}
              style={{ width: 20, height: 20, borderRadius: 4, border: `2px solid ${fragil ? '#dc2626' : '#d1d5db'}`, background: fragil ? '#dc2626' : '#fff', display: 'flex', alignItems: 'center', justifyContent: 'center', cursor: 'pointer', flexShrink: 0 }}
            >
              {fragil && <span style={{ color: '#fff', fontSize: 12, fontWeight: 900 }}>✓</span>}
            </button>
            <label style={{ fontSize: 13, fontWeight: 600, color: '#374151', cursor: 'pointer' }} onClick={() => setFragil(v => !v)}>
              🥚 Paquete frágil
            </label>
          </div>
          <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
            <button
              type="button"
              onClick={() => setGrande(v => !v)}
              style={{ width: 20, height: 20, borderRadius: 4, border: `2px solid ${grande ? '#d46b08' : '#d1d5db'}`, background: grande ? '#d46b08' : '#fff', display: 'flex', alignItems: 'center', justifyContent: 'center', cursor: 'pointer', flexShrink: 0 }}
            >
              {grande && <span style={{ color: '#fff', fontSize: 12, fontWeight: 900 }}>✓</span>}
            </button>
            <label style={{ fontSize: 13, fontWeight: 600, color: '#374151', cursor: 'pointer' }} onClick={() => setGrande(v => !v)}>
              📦 Paquete grande / voluminoso
            </label>
          </div>
        </div>

        {(fragil || grande) && (
          <p style={{ fontSize: 12, color: '#6b7280', margin: 0 }}>
            {fragil && grande
              ? '⚠️ Manejo con cuidado y espacio para paquete de gran tamaño.'
              : fragil
              ? '⚠️ El motorizado sabrá que debe manejar el paquete con especial cuidado.'
              : '📦 El motorizado sabrá que es un paquete de gran tamaño.'}
            {' '}Tener en cuenta al asignar motorizado y confirmar precio.
          </p>
        )}

        {(fragil || grande) && (
          <Field
            label={grande ? 'Descripción / dimensiones' : 'Descripción del contenido (opcional)'}
            hint={grande ? 'Ayudá al motorizado a entender el tamaño o tipo de paquete.' : 'Ej: vidrio, cerámica, electrónico, líquidos...'}
          >
            <input
              value={notaPaquete}
              onChange={e => setNotaPaquete(e.target.value)}
              placeholder={grande ? 'Ej: Caja 60×40cm, televisor 32", mueble desmontado...' : 'Ej: botella de vidrio, pantalla de celular, jarrón...'}
              style={S.input}
            />
          </Field>
        )}

        {!fragil && !grande && (
          <p style={{ fontSize: 12, color: '#9ca3af', margin: 0 }}>Marcá si el paquete requiere cuidado especial o es de gran tamaño.</p>
        )}
      </SectionCard>

      {/* ── PAGOS ── */}
      <SectionCard title="Pagos" icon="💰">
        {!esFueraManagua && (
          <div>
            <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 8 }}>
              <button
                type="button"
                onClick={() => setCobroCE(!cobroCE)}
                style={{
                  width: 20,
                  height: 20,
                  borderRadius: 4,
                  border: `2px solid ${cobroCE ? '#004aad' : '#d1d5db'}`,
                  background: cobroCE ? '#004aad' : '#fff',
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'center',
                  cursor: 'pointer',
                  flexShrink: 0,
                }}
              >
                {cobroCE && <span style={{ color: '#fff', fontSize: 12, fontWeight: 900 }}>✓</span>}
              </button>
              <label
                style={{ fontSize: 14, fontWeight: 600, color: '#111827', cursor: 'pointer' }}
                onClick={() => setCobroCE(!cobroCE)}
              >
                Hay cobro contra entrega (el motorizado cobra el producto)
              </label>
            </div>
            {cobroCE && (
              <div style={{ marginLeft: 30 }}>
                <label style={S.label}>
                  Monto del producto (C$) <span style={{ color: '#dc2626' }}>*</span>
                </label>
                <input
                  type="number"
                  value={montoCE}
                  onChange={(e) => setMontoCE(e.target.value === '' ? '' : Number(e.target.value))}
                  placeholder="Ej: 1500"
                  style={{ ...S.input, maxWidth: 200 }}
                />
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
                { value: 'transferencia_comercio', label: '📲 El comercio transfiere directamente a Cargotrans', desc: 'Cuando estemos llegando al punto te avisaremos para que el comercio realice la transferencia a las cuentas de Cargotrans.' },
                { value: 'transferencia_storkhub', label: '🏢 Storkhub realiza la transferencia', desc: 'Storkhub cubre el costo del flete de Cargotrans y lo gestiona internamente.' },
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
                <p style={{ fontSize: 13, fontWeight: 700, color: '#d46b08', margin: '0 0 4px' }}>⚠️ Importante para el comercio</p>
                <p style={{ fontSize: 12, color: '#92400e', margin: 0, lineHeight: 1.5 }}>
                  Cuando el motorizado esté llegando al punto de Cargotrans, notificaremos al comercio para que realice la transferencia a las cuentas indicadas. Asegurar que el comercio esté pendiente del aviso.
                </p>
              </div>
            )}
          </div>
        )}

        {tipoCliente === 'credito' ? (
          <div style={{ background: '#eff6ff', border: '1px solid #bfdbfe', borderRadius: 10, padding: '12px 14px' }}>
            <p style={{ fontSize: 13, fontWeight: 700, color: '#2563eb', margin: '0 0 2px' }}>🗓 Cliente con crédito semanal</p>
            <p style={{ fontSize: 12, color: '#3b82f6', margin: 0 }}>El delivery se cobra al comercio semanalmente.</p>
          </div>
        ) : (
          <div>
            <label style={S.label}>
              ¿Quién paga el delivery? <span style={{ color: '#dc2626' }}>*</span>
            </label>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
              {[
                { value: 'recoleccion', label: '🏁 Se paga en la recolección', desc: 'El motorizado cobra el delivery al retirar' },
                ...(!esFueraManagua ? [{ value: 'entrega', label: '🏠 Lo paga el destinatario (entrega)', desc: 'El motorizado cobra el delivery al entregar' }] : []),
                { value: 'transferencia', label: '🏦 Ya se pagó por transferencia', desc: 'El delivery fue pagado previamente' },
              ].map((opt) => (
                <button
                  key={opt.value}
                  type="button"
                  onClick={() => setQuienPagaDelivery(opt.value as QuienPagaDelivery)}
                  style={{
                    textAlign: 'left' as const,
                    padding: '12px 14px',
                    borderRadius: 10,
                    cursor: 'pointer',
                    border: `1px solid ${quienPagaDelivery === opt.value ? '#004aad' : '#e5e7eb'}`,
                    background: quienPagaDelivery === opt.value ? '#eff6ff' : '#fff',
                  }}
                >
                  <p style={{ fontSize: 13, fontWeight: 700, color: quienPagaDelivery === opt.value ? '#004aad' : '#111827', margin: '0 0 2px' }}>
                    {opt.label}
                  </p>
                  <p style={{ fontSize: 11, color: '#6b7280', margin: 0 }}>{opt.desc}</p>
                </button>
              ))}
            </div>

            {cobroCE && quienPagaDelivery === 'entrega' && (
              <div style={{ marginTop: 12, background: '#fffbe6', border: '1px solid #ffe58f', borderRadius: 10, padding: '12px 14px' }}>
                <label style={{ fontSize: 13, fontWeight: 700, color: '#d46b08', display: 'block', marginBottom: 8 }}>
                  ¿Deducir el delivery del cobro del producto?
                </label>
                <div style={{ display: 'flex', gap: 8 }}>
                  {[
                    { value: 'no_deducir', label: 'No deducir' },
                    { value: 'deducir_del_cobro', label: 'Sí, deducir' },
                  ].map((opt) => (
                    <button
                      key={opt.value}
                      type="button"
                      onClick={() => setDeducirDelivery(opt.value as DeducirDelivery)}
                      style={{
                        padding: '8px 14px',
                        borderRadius: 8,
                        fontSize: 12,
                        fontWeight: 600,
                        cursor: 'pointer',
                        border: `1px solid ${deducirDelivery === opt.value ? '#d46b08' : '#e5e7eb'}`,
                        background: deducirDelivery === opt.value ? '#d46b08' : '#fff',
                        color: deducirDelivery === opt.value ? '#fff' : '#374151',
                      }}
                    >
                      {opt.label}
                    </button>
                  ))}
                </div>
                <p style={{ fontSize: 11, color: '#d46b08', margin: '8px 0 0' }}>
                  {deducirDelivery === 'deducir_del_cobro'
                    ? montoCE !== '' && montoDelivery > 0
                      ? `El motorizado cobrará solo C$ ${montoProducto} al destinatario. Se depositará C$ ${montoADepositarComercio} al comercio (el delivery se descuenta de su cobro).`
                      : 'El motorizado cobrará solo el monto del producto al destinatario. El delivery se descuenta de lo que se deposita al comercio.'
                    : montoCE !== '' && montoDelivery > 0
                      ? `El motorizado cobrará C$ ${montoProducto + montoDelivery} al destinatario (producto + delivery). Se depositará C$ ${montoProducto} al comercio.`
                      : 'El motorizado cobrará el producto + delivery al destinatario. Al comercio se le deposita solo el monto del producto.'}
                </p>
              </div>
            )}
          </div>
        )}

        <Field label="Número de orden / referencia" hint="Código interno del comercio para identificar el pedido (opcional).">
          <input value={numeroOrden} onChange={(e) => setNumeroOrden(e.target.value)} placeholder="Ej: #ORD-001 o número de pedido de WhatsApp" style={S.input} />
        </Field>

        <div>
          <label style={S.label}>
            Instrucciones adicionales{' '}
            <span style={{ color: '#9ca3af', fontWeight: 400 }}>(opcional)</span>
          </label>
          <textarea
            value={detalle}
            onChange={(e) => setDetalle(e.target.value)}
            placeholder="Ej: Entregar entre 2-4pm. Llamar antes de llegar. Portón negro."
            style={{ ...S.input, resize: 'vertical' as const, minHeight: 80 }}
            rows={3}
          />
        </div>
      </SectionCard>

          </div>
        )}

        {/* ════ PASO 5: CONFIRMACIÓN ════ */}
        {paso === 5 && (
          <div>
            <div style={{ marginBottom: 20 }}>
              <h2 style={{ fontSize: 20, fontWeight: 800, color: '#111827', margin: '0 0 4px' }}>Confirmar orden</h2>
              <p style={{ fontSize: 13, color: '#6b7280', margin: 0 }}>Revisá el resumen antes de crear la orden.</p>
            </div>

            {/* Mapa de ruta */}
            {(retiro.coord || entregaCoordEfectiva) && (
              <div style={{ ...S.sectionCard, marginBottom: 16 }}>
                <h3 style={{ fontSize: 13, fontWeight: 700, color: '#374151', margin: '0 0 12px', textTransform: 'uppercase' as const, letterSpacing: 0.5 }}>Ruta</h3>
                <RoutePreviewMap origen={retiro.coord} destino={entregaCoordEfectiva} />
                {calcResult && (
                  <div style={{ marginTop: 10, display: 'flex', gap: 16, flexWrap: 'wrap' as const }}>
                    <span style={{ fontSize: 13, color: '#6b7280' }}>Distancia: <strong>{calcResult.km.toFixed(2)} km</strong></span>
                    <span style={{ fontSize: 13, color: '#004aad', fontWeight: 700 }}>
                      Precio: {calcResult.precio === -1 ? 'Consultar' : recargoZona.aplica ? `C$ ${calcResult.precio + recargoMonto} (base C$ ${calcResult.precio} + recargo C$ ${recargoMonto})` : `C$ ${calcResult.precio}`}
                    </span>
                  </div>
                )}
              </div>
            )}

            {/* Comercio */}
            <div style={{ ...S.sectionCard, marginBottom: 16 }}>
              <h3 style={{ fontSize: 12, fontWeight: 700, color: '#9ca3af', textTransform: 'uppercase' as const, letterSpacing: 0.5, margin: '0 0 10px' }}>Comercio</h3>
              <p style={{ fontSize: 14, fontWeight: 700, color: '#111827', margin: 0 }}>{selectedOwner?.companyName || selectedOwner?.nombre || '—'}</p>
              {selectedOwner?.email && <p style={{ fontSize: 12, color: '#6b7280', margin: '2px 0 0' }}>{selectedOwner.email}</p>}
            </div>

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

            {/* Retiro / Entrega lado a lado */}
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12, marginBottom: 16 }}>
              <div style={{ ...S.sectionCard, marginBottom: 0 }}>
                <h3 style={{ fontSize: 12, fontWeight: 700, color: '#9ca3af', textTransform: 'uppercase' as const, letterSpacing: 0.5, margin: '0 0 10px' }}>📦 Retiro</h3>
                <p style={{ fontSize: 14, fontWeight: 700, color: '#111827', margin: '0 0 2px' }}>{retiro.nombre || '—'}</p>
                <p style={{ fontSize: 12, color: '#6b7280', margin: '0 0 2px' }}>{retiro.celular || '—'}</p>
                <p style={{ fontSize: 12, color: '#374151', margin: 0 }}>{retiro.direccion || '—'}</p>
                {retiro.coord && <p style={{ fontSize: 11, color: '#16a34a', margin: '4px 0 0', fontWeight: 600 }}>✓ Ubicación marcada</p>}
              </div>
              <div style={{ ...S.sectionCard, marginBottom: 0 }}>
                <h3 style={{ fontSize: 12, fontWeight: 700, color: '#9ca3af', textTransform: 'uppercase' as const, letterSpacing: 0.5, margin: '0 0 10px' }}>
                  {esFueraManagua && puntoLogisticoSeleccionado
                    ? (metodoFueraManagua === 'cargotrans' ? '📦 Sucursal Cargotrans' : '🏢 Terminal')
                    : '🏠 Entrega'}
                </h3>
                {esFueraManagua && puntoLogisticoSeleccionado ? (
                  <>
                    <p style={{ fontSize: 14, fontWeight: 700, color: '#111827', margin: '0 0 2px' }}>{puntoLogisticoSeleccionado.nombre}</p>
                    {puntoLogisticoSeleccionado.direccion && <p style={{ fontSize: 12, color: '#6b7280', margin: '0 0 2px' }}>📌 {puntoLogisticoSeleccionado.direccion}</p>}
                    {(puntoLogisticoSeleccionado.horarioApertura || puntoLogisticoSeleccionado.horarioCierre) && (
                      <p style={{ fontSize: 11, color: '#6b7280', margin: '0 0 2px' }}>🕐 {puntoLogisticoSeleccionado.horarioApertura || '?'}–{puntoLogisticoSeleccionado.horarioCierre || '?'}</p>
                    )}
                    {destinoFinal && <p style={{ fontSize: 12, color: '#7c3aed', margin: '4px 0 0', fontWeight: 600 }}>📍 Destino: {destinoFinal}</p>}
                  </>
                ) : (
                  <>
                    <p style={{ fontSize: 14, fontWeight: 700, color: '#111827', margin: '0 0 2px' }}>{entrega.nombre || '—'}</p>
                    <p style={{ fontSize: 12, color: '#6b7280', margin: '0 0 2px' }}>{entrega.celular || '—'}</p>
                    <p style={{ fontSize: 12, color: '#374151', margin: 0 }}>{entrega.direccion || '—'}</p>
                    {entrega.coord && <p style={{ fontSize: 11, color: '#16a34a', margin: '4px 0 0', fontWeight: 600 }}>✓ Ubicación marcada</p>}
                  </>
                )}
              </div>
            </div>

            {/* Resumen de cobros */}
            <div style={{ ...S.sectionCard, background: '#f8fafc', border: '1px solid #e2e8f0', marginBottom: 16 }}>
              <h3 style={{ fontSize: 12, fontWeight: 700, color: '#9ca3af', textTransform: 'uppercase' as const, letterSpacing: 0.5, margin: '0 0 12px' }}>Cobros</h3>
              <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
                <div style={{ display: 'flex', justifyContent: 'space-between' }}>
                  <span style={{ fontSize: 13, color: '#6b7280' }}>Tipo cliente</span>
                  <span style={{ fontSize: 13, fontWeight: 700, color: '#111827' }}>{tipoCliente === 'contado' ? '💵 Contado' : '🗓 Crédito'}</span>
                </div>
                {cobroCE && montoCE !== '' && (
                  <div style={{ display: 'flex', justifyContent: 'space-between' }}>
                    <span style={{ fontSize: 13, color: '#6b7280' }}>Producto (cobro contra entrega)</span>
                    <span style={{ fontSize: 13, fontWeight: 700, color: '#7c3aed' }}>C$ {montoProducto}</span>
                  </div>
                )}
                {calcResult && precioEfectivo !== -1 ? (
                  <>
                    <div style={{ display: 'flex', justifyContent: 'space-between' }}>
                      <span style={{ fontSize: 13, color: '#6b7280' }}>Delivery base (calculado)</span>
                      <span style={{ fontSize: 13, fontWeight: 600, color: '#374151' }}>C$ {calcResult.precio}</span>
                    </div>
                    {recargoZona.aplica && (
                      <div style={{ display: 'flex', justifyContent: 'space-between' }}>
                        <span style={{ fontSize: 12, color: '#ea580c' }}>+ Zona {recargoZona.zona}</span>
                        <span style={{ fontSize: 12, fontWeight: 600, color: '#ea580c' }}>+C$ {recargoZona.monto}</span>
                      </div>
                    )}
                    {recargoServicioMonto > 0 && (
                      <div style={{ display: 'flex', justifyContent: 'space-between' }}>
                        <span style={{ fontSize: 12, color: '#7c3aed' }}>+ Terminal / bus</span>
                        <span style={{ fontSize: 12, fontWeight: 600, color: '#7c3aed' }}>+C$ {recargoServicioMonto}</span>
                      </div>
                    )}
                    <div style={{ display: 'flex', justifyContent: 'space-between', borderTop: '1px dashed #e5e7eb', paddingTop: 6 }}>
                      <span style={{ fontSize: 13, fontWeight: 700, color: '#004aad' }}>Total delivery</span>
                      <span style={{ fontSize: 14, fontWeight: 700, color: '#004aad' }}>C$ {precioEfectivo}</span>
                    </div>
                  </>
                ) : (
                  <div style={{ display: 'flex', justifyContent: 'space-between' }}>
                    <span style={{ fontSize: 13, color: '#6b7280' }}>
                      Delivery {precioEfectivo ? '(cotización)' : '(a confirmar)'}
                      {recargoServicioMonto > 0 ? ` + terminal C$${recargoServicioMonto}` : ''}
                    </span>
                    <span style={{ fontSize: 13, fontWeight: 700, color: '#004aad' }}>{precioEfectivo ? `C$ ${precioEfectivo}` : '—'}</span>
                  </div>
                )}
                {tipoCliente === 'contado' && quienPagaDelivery && (
                  <div style={{ display: 'flex', justifyContent: 'space-between' }}>
                    <span style={{ fontSize: 13, color: '#6b7280' }}>Quién paga delivery</span>
                    <span style={{ fontSize: 13, fontWeight: 600, color: '#374151' }}>
                      {quienPagaDelivery === 'recoleccion' ? 'En retiro' : quienPagaDelivery === 'entrega' ? 'Destinatario' : 'Transferencia'}
                    </span>
                  </div>
                )}
                <div style={{ borderTop: '1px solid #e2e8f0', paddingTop: 10, display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                  <span style={{ fontSize: 14, fontWeight: 700, color: '#111827' }}>Total estimado</span>
                  <span style={{ fontSize: 22, fontWeight: 900, color: '#111827' }}>
                    {cobroCE && tipoCliente === 'contado' && quienPagaDelivery === 'entrega' && montoDelivery > 0
                      ? `C$ ${destinatarioPagaTotal}`
                      : precioEfectivo ? `C$ ${precioEfectivo}` : '—'}
                  </span>
                </div>
              </div>
            </div>

            {/* Detalles extras */}
            {(fragil || grande || esProgramado || detalle || numeroOrden || zonaPreview) && (
              <div style={{ ...S.sectionCard, marginBottom: 16 }}>
                <h3 style={{ fontSize: 12, fontWeight: 700, color: '#9ca3af', textTransform: 'uppercase' as const, letterSpacing: 0.5, margin: '0 0 10px' }}>Detalles</h3>
                <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
                  {fragil && <p style={{ fontSize: 13, color: '#dc2626', margin: 0 }}>🥚 Paquete frágil</p>}
                  {grande && <p style={{ fontSize: 13, color: '#d46b08', margin: 0 }}>📦 Paquete grande/voluminoso</p>}
                  {notaPaquete && <p style={{ fontSize: 12, color: '#374151', margin: 0 }}>Paquete: {notaPaquete}</p>}
                  {esProgramado && fechaRetiro && <p style={{ fontSize: 13, color: '#374151', margin: 0 }}>📅 Retiro programado: {fechaRetiro} {horaRetiro && `a las ${horaRetiro}`}</p>}
                  {esProgramado && fechaEntrega && <p style={{ fontSize: 13, color: '#374151', margin: 0 }}>📅 Entrega programada: {fechaEntrega} {horaEntrega && `a las ${horaEntrega}`}</p>}
                  {numeroOrden && <p style={{ fontSize: 12, color: '#374151', margin: 0 }}>Ref: {numeroOrden}</p>}
                  {detalle && <p style={{ fontSize: 12, color: '#374151', margin: 0 }}>Nota: {detalle}</p>}
                  {zonaPreview?.zonaEntregaNombre && <p style={{ fontSize: 12, color: '#1d4ed8', margin: 0 }}>Zona de entrega: {zonaPreview.zonaEntregaNombre}</p>}
                </div>
              </div>
            )}

            {/* Campos faltantes */}
            {!formularioCompleto && (
              <div style={{ background: '#fffbe6', border: '1px solid #ffe58f', borderRadius: 14, padding: '14px 16px', marginBottom: 16 }}>
                <p style={{ fontSize: 13, fontWeight: 700, color: '#d46b08', margin: '0 0 8px' }}>⚠️ Campos pendientes:</p>
                <ul style={{ margin: 0, padding: '0 0 0 18px' }}>
                  {camposFaltantes.map((f) => (
                    <li key={f} style={{ fontSize: 13, color: '#92400e', marginBottom: 2 }}>{f}</li>
                  ))}
                </ul>
              </div>
            )}

            {msg && (
              <div style={{ marginBottom: 16, borderRadius: 14, padding: '14px 16px', fontSize: 13, fontWeight: 600, background: msg.type === 'success' ? '#f0fdf4' : msg.type === 'error' ? '#fef2f2' : '#eff6ff', border: `1px solid ${msg.type === 'success' ? '#bbf7d0' : msg.type === 'error' ? '#fecaca' : '#bfdbfe'}`, color: msg.type === 'success' ? '#16a34a' : msg.type === 'error' ? '#dc2626' : '#2563eb' }}>
                {msg.text}
              </div>
            )}
          </div>
        )}
      </div>

      {/* ── Nav buttons (fixed footer) ── */}
      <div
        style={{
          position: 'fixed',
          bottom: 0,
          left: 'var(--sidebar-width, 250px)',
          right: 0,
          zIndex: 40,
          background: 'rgba(255,255,255,0.97)',
          backdropFilter: 'blur(8px)',
          borderTop: '1px solid #e5e7eb',
          padding: '12px 16px',
          boxShadow: '0 -4px 16px rgba(0,0,0,0.06)',
          transition: 'left 300ms ease-in-out',
        }}
      >
        <div style={{ maxWidth: 760, margin: '0 auto', display: 'flex', gap: 10, alignItems: 'center' }}>
          {paso > 1 && (
            <button
              type="button"
              onClick={() => setPaso(p => p - 1)}
              style={{ ...S.btnOutline, padding: '12px 20px', fontSize: 14, fontWeight: 700, height: 48 }}
            >
              ← Atrás
            </button>
          )}
          {paso < 5 && (
            <button
              type="button"
              disabled={!puedeAvanzar(paso) || calcLoading}
              onClick={() => handleSiguiente()}
              style={{
                flex: 1,
                height: 48,
                background: puedeAvanzar(paso) && !calcLoading ? '#004aad' : '#d1d5db',
                border: 'none',
                borderRadius: 12,
                color: '#fff',
                fontSize: 15,
                fontWeight: 700,
                cursor: puedeAvanzar(paso) && !calcLoading ? 'pointer' : 'not-allowed',
                transition: 'background 0.15s',
              }}
            >
              {calcLoading && paso === 3 && esFueraManagua ? '⏳ Calculando...' : 'Siguiente →'}
            </button>
          )}
          {paso === 5 && (
            <button
              type="button"
              onClick={handleGuardar}
              disabled={saving || !formularioCompleto}
              style={{
                flex: 1,
                height: 48,
                background: formularioCompleto ? '#004aad' : '#9ca3af',
                border: 'none',
                borderRadius: 12,
                color: '#fff',
                fontSize: 15,
                fontWeight: 800,
                cursor: formularioCompleto ? 'pointer' : 'not-allowed',
              }}
            >
              {saving ? 'Guardando...' : formularioCompleto ? '✓ Crear orden' : '⚠️ Completar info'}
            </button>
          )}
        </div>
      </div>

      {/* ── MODAL BUSCADOR DE COMERCIOS ── */}
      <ComercioSearchModal
        open={showComercioModal}
        onClose={() => setShowComercioModal(false)}
        onSelect={(c: ComercioModalItem) => setSelectedOwnerUid(c.uid)}
        comercios={comercios.map((c) => ({
          uid: c.uid,
          nombre: c.nombre,
          companyName: c.companyName,
          email: c.email,
          phone: c.phone,
          address: c.address,
        }))}
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
            nota: c.nota,
            coord: c.coord,
            tipoUbicacion: c.tipoUbicacion as TipoUbicacion | undefined,
            comercioUid: c.comercioUid,
          })
        }}
        clientes={poolPuntos.map((p) => ({
          id: p.id,
          nombre: p.nombre,
          celular: p.celular,
          direccion: p.direccion,
          nota: p.nota,
          coord: p.coord,
          tipoUbicacion: p.tipoUbicacion,
          comercioUid: p.comercioUid,
          totalViajes: p.totalViajes,
          totalEntregados: p.totalEntregados,
        }))}
        comercioUidActual={selectedOwnerUid || undefined}
        comercios={comercios.map((c) => ({
          uid: c.uid,
          nombre: c.nombre,
          companyName: c.companyName,
        }))}
      />

      {/* ── MODAL NUEVO COMERCIO ── */}
      {modalNuevoComercio && (
        <div
          style={{ position: 'fixed', inset: 0, background: 'rgba(15,23,42,0.45)', display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 200, padding: 16 }}
          onClick={(e) => { if (e.target === e.currentTarget) setModalNuevoComercio(false) }}
        >
          <div style={{ width: '100%', maxWidth: 480, background: '#fff', borderRadius: 18, border: '1px solid #e5e7eb', boxShadow: '0 24px 64px rgba(0,0,0,0.18)', padding: 24 }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', marginBottom: 20 }}>
              <div>
                <h3 style={{ fontSize: 18, fontWeight: 800, color: '#111827', margin: '0 0 4px' }}>Nuevo comercio</h3>
                <p style={{ fontSize: 13, color: '#6b7280', margin: 0 }}>Creá un perfil rápido para tomar la orden. Después puede completar sus datos desde Ajustes.</p>
              </div>
              <button onClick={() => setModalNuevoComercio(false)} style={{ border: '1px solid #e5e7eb', background: '#fff', borderRadius: 10, width: 34, height: 34, cursor: 'pointer', fontSize: 16, color: '#374151', flexShrink: 0 }}>✕</button>
            </div>

            <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
              <div>
                <label style={S.label}>Nombre / empresa <span style={{ color: '#dc2626' }}>*</span></label>
                <input value={ncNombre} onChange={(e) => setNcNombre(e.target.value)} placeholder="Ej: Tienda San Juan, María López..." style={S.input} />
              </div>
              <div>
                <label style={S.label}>Teléfono <span style={{ color: '#dc2626' }}>*</span></label>
                <input value={ncTelefono} onChange={(e) => setNcTelefono(e.target.value)} placeholder="Ej: 8888-8888" style={S.input} />
              </div>
              <div>
                <label style={S.label}>Correo <span style={{ color: '#9ca3af', fontWeight: 400 }}>(opcional)</span></label>
                <input value={ncEmail} onChange={(e) => setNcEmail(e.target.value)} placeholder="Ej: tienda@gmail.com" style={S.input} />
              </div>
              <div>
                <label style={S.label}>Dirección <span style={{ color: '#9ca3af', fontWeight: 400 }}>(opcional)</span></label>
                <input value={ncDireccion} onChange={(e) => setNcDireccion(e.target.value)} placeholder="Ej: Del semáforo 1c al sur" style={S.input} />
              </div>

              {ncError && (
                <div style={{ background: '#fef2f2', border: '1px solid #fecaca', borderRadius: 10, padding: '10px 12px' }}>
                  <p style={{ color: '#dc2626', fontSize: 13, fontWeight: 600, margin: '0 0 6px' }}>{ncError}</p>
                  {(() => {
                    const telNorm = ncTelefono.replace(/\D/g, '')
                    const nombreNorm = ncNombre.trim().toLowerCase()
                    const dup = comercios.find((c) => {
                      const cTel = (c.phone || '').replace(/\D/g, '')
                      const cNombre = (c.companyName || c.nombre || '').toLowerCase()
                      return (cTel && cTel === telNorm) || cNombre === nombreNorm
                    })
                    if (!dup) return null
                    return (
                      <button
                        type="button"
                        onClick={() => { setSelectedOwnerUid(dup.uid); setModalNuevoComercio(false); setNcNombre(''); setNcTelefono(''); setNcEmail(''); setNcDireccion('') }}
                        style={{ fontSize: 12, fontWeight: 700, color: '#dc2626', background: 'none', border: '1px solid #fecaca', borderRadius: 8, padding: '5px 10px', cursor: 'pointer' }}
                      >
                        Seleccionar "{dup.companyName || dup.nombre}" en su lugar
                      </button>
                    )
                  })()}
                </div>
              )}

              <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8, paddingTop: 4 }}>
                <button onClick={() => setModalNuevoComercio(false)} style={S.btnOutline}>Cancelar</button>
                <button
                  onClick={crearNuevoComercio}
                  disabled={ncGuardando}
                  style={{ background: '#004aad', border: 'none', borderRadius: 10, padding: '10px 20px', color: '#fff', fontSize: 14, fontWeight: 700, cursor: 'pointer' }}
                >
                  {ncGuardando ? 'Creando...' : 'Crear comercio'}
                </button>
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
