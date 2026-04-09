'use client'
import React, { useEffect, useRef, useState, useMemo, useCallback } from 'react'
import MapaSeleccion, { FavoritoMapa } from './MapaSeleccion'
import { getMapsLoader } from '@/lib/googleMaps'
import {
  addDoc,
  collection,
  doc,
  onSnapshot,
  orderBy,
  query,
  serverTimestamp,
  where,
} from 'firebase/firestore'
import { db, auth } from '@/fb/config'

// ─── Types ────────────────────────────────────────────────────────────────────

type LatLng = google.maps.LatLngLiteral
type PlaceLite = { label: string; lat: number; lng: number; ts: number }
type Cotizacion = {
  id: string
  origen: string
  destino: string
  distanciaKm: number
  precioCordobas: number
  origenCoord?: LatLng
  destinoCoord?: LatLng
  createdAt?: Date | null
  fuente?: string
}

type PuntoFavorito = {
  key: string
  label: string
  nombre?: string
  celular?: string
  direccion?: string
  coord?: LatLng
}

// ─── Constants ────────────────────────────────────────────────────────────────

const CACHE_PREFIX = 'dm:'
const TTL_MS = 10 * 60 * 1000
const RECENT_MAX = 6
const RECENT_TTL = 7 * 24 * 60 * 60 * 1000
const RKEY = { origen: 'recent:origen', destino: 'recent:destino' } as const
const CENTER_NI: LatLng = { lat: 12.1364, lng: -86.2514 }

// ─── Tariff ──────────────────────────────────────────────────────────────────

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

// ─── Recent places ───────────────────────────────────────────────────────────

function loadRecents(kind: keyof typeof RKEY): PlaceLite[] {
  try {
    const arr: PlaceLite[] = JSON.parse(localStorage.getItem(RKEY[kind]) || '[]')
    const now = Date.now()
    const filtered = arr
      .map((x: any) => ({ ...x, ts: x.ts ?? now }))
      .filter((x) => now - x.ts < RECENT_TTL)
    localStorage.setItem(RKEY[kind], JSON.stringify(filtered))
    return filtered
  } catch { return [] }
}

function saveRecent(kind: keyof typeof RKEY, p: { label: string; lat: number; lng: number }) {
  const list = loadRecents(kind).filter((x) => x.label !== p.label)
  list.unshift({ ...p, ts: Date.now() })
  localStorage.setItem(RKEY[kind], JSON.stringify(list.slice(0, RECENT_MAX)))
}

function clearRecents(kind: keyof typeof RKEY) {
  localStorage.removeItem(RKEY[kind])
}

// ─── Firestore ────────────────────────────────────────────────────────────────

async function guardarCotizacion(
  uid: string,
  data: { origen: string; destino: string; km: number; precio: number; origenCoord: LatLng; destinoCoord: LatLng; fuente: string }
) {
  await addDoc(collection(db, 'cotizaciones'), {
    userId: uid,
    origen: data.origen,
    destino: data.destino,
    distanciaKm: parseFloat(data.km.toFixed(3)),
    precioCordobas: data.precio,
    origenCoord: data.origenCoord,
    destinoCoord: data.destinoCoord,
    fuente: data.fuente,
    createdAt: serverTimestamp(),
  })
}

// ─── Format ───────────────────────────────────────────────────────────────────

function timeAgo(date: Date): string {
  const s = Math.floor((Date.now() - date.getTime()) / 1000)
  if (s < 60) return `hace ${s}s`
  const m = Math.floor(s / 60)
  if (m < 60) return `hace ${m} min`
  const h = Math.floor(m / 60)
  if (h < 24) return `hace ${h}h`
  const d = Math.floor(h / 24)
  if (d < 7) return `hace ${d} días`
  return date.toLocaleDateString('es-NI', { day: 'numeric', month: 'short' })
}

// ─── SearchInput ─────────────────────────────────────────────────────────────
// FIX: use React.RefObject<HTMLInputElement | null> to match useRef(null) type

function SearchInput({
  inputRef,
  placeholder,
  onFocusEmpty,
  onInputChange,
  onKeyDown,
  icon,
  color,
  onClear,
  onMyLocation,
  locating,
}: {
  inputRef: React.RefObject<HTMLInputElement | null>
  placeholder: string
  onFocusEmpty: () => void
  onInputChange: () => void
  onKeyDown: (e: React.KeyboardEvent<HTMLInputElement>) => void
  icon: string
  color: string
  onClear: () => void
  onMyLocation?: () => void
  locating?: boolean
}) {
  return (
    <div style={{ position: 'relative', display: 'flex', alignItems: 'center' }}>
      <div style={{ position: 'absolute', left: 12, fontSize: 16, pointerEvents: 'none', zIndex: 1 }}>{icon}</div>
      <input
        ref={inputRef}
        type="text"
        placeholder={placeholder}
        onFocus={onFocusEmpty}
        onInput={onInputChange}
        onKeyDown={onKeyDown}
        style={{
          width: '100%',
          border: `1px solid ${color}33`,
          borderRadius: 12,
          padding: '11px 88px 11px 38px',
          fontSize: 14,
          color: '#111827',
          outline: 'none',
          background: '#fff',
          boxSizing: 'border-box' as const,
          fontFamily: 'inherit',
          transition: 'box-shadow 0.15s, border-color 0.15s',
        }}
        onFocusCapture={(e) => {
          e.currentTarget.style.boxShadow = `0 0 0 3px ${color}22`
          e.currentTarget.style.borderColor = color
        }}
        onBlurCapture={(e) => {
          e.currentTarget.style.boxShadow = '0 0 0 0px transparent'
          e.currentTarget.style.borderColor = `${color}33`
        }}
      />
      <div style={{ position: 'absolute', right: 8, display: 'flex', gap: 4 }}>
        {onMyLocation && (
          <button
            type="button"
            onClick={onMyLocation}
            disabled={locating}
            title="Usar mi ubicación"
            style={{ padding: '6px 8px', borderRadius: 8, border: '1px solid #e5e7eb', background: '#fff', cursor: 'pointer', fontSize: 13 }}
          >
            {locating ? '⏳' : '📍'}
          </button>
        )}
        <button
          type="button"
          onClick={onClear}
          title="Limpiar"
          style={{ padding: '6px 8px', borderRadius: 8, border: '1px solid #e5e7eb', background: '#fff', cursor: 'pointer', fontSize: 13, color: '#9ca3af' }}
        >
          ✕
        </button>
      </div>
    </div>
  )
}

// ─── RecentDropdown ───────────────────────────────────────────────────────────

function RecentDropdown({ items, onSelect, onClear }: { items: PlaceLite[]; onSelect: (p: PlaceLite) => void; onClear: () => void }) {
  if (!items.length) return null
  return (
    <div style={{ position: 'absolute', top: '100%', left: 0, right: 0, zIndex: 50, background: '#fff', border: '1px solid #e5e7eb', borderRadius: 12, boxShadow: '0 8px 24px rgba(0,0,0,0.10)', marginTop: 4, overflow: 'hidden' }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '8px 14px', borderBottom: '1px solid #f3f4f6' }}>
        <span style={{ fontSize: 11, fontWeight: 700, color: '#9ca3af', textTransform: 'uppercase' as const, letterSpacing: 0.5 }}>Recientes</span>
        <button type="button" onClick={onClear} style={{ fontSize: 11, color: '#9ca3af', border: 'none', background: 'none', cursor: 'pointer', textDecoration: 'underline' }}>Borrar</button>
      </div>
      {items.map((p, i) => (
        <button key={i} type="button" onMouseDown={() => onSelect(p)} style={{ display: 'block', width: '100%', textAlign: 'left' as const, padding: '10px 14px', border: 'none', background: 'none', cursor: 'pointer', fontSize: 13, color: '#374151', borderBottom: '1px solid #f9fafb' }}>
          🕐 {p.label}
        </button>
      ))}
    </div>
  )
}

// ─── Main component ───────────────────────────────────────────────────────────

const CalculadoraPrecio: React.FC = () => {
  // FIX: typed as HTMLInputElement | null to match useRef(null)
  const origenInputRef = useRef<HTMLInputElement | null>(null)
  const destinoInputRef = useRef<HTMLInputElement | null>(null)
  const origenWrapRef = useRef<HTMLDivElement>(null)
  const destinoWrapRef = useRef<HTMLDivElement>(null)
  const origenACRef = useRef<google.maps.places.Autocomplete | null>(null)
  const destinoACRef = useRef<google.maps.places.Autocomplete | null>(null)

  const [origenCoord, setOrigenCoord] = useState<LatLng | null>(null)
  const [destinoCoord, setDestinoCoord] = useState<LatLng | null>(null)
  const [distancia, setDistancia] = useState<number | null>(null)
  const [precio, setPrecio] = useState<number | null>(null)
  const [loading, setLoading] = useState(false)
  const [locating, setLocating] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [uid, setUid] = useState<string | null>(null)

  const [recOrigen, setRecOrigen] = useState<PlaceLite[]>([])
  const [recDestino, setRecDestino] = useState<PlaceLite[]>([])
  const [showSug, setShowSug] = useState<{ o: boolean; d: boolean }>({ o: false, d: false })

  const [cotizaciones, setCotizaciones] = useState<Cotizacion[]>([])
  const [loadingCot, setLoadingCot] = useState(true)

  // Favoritos del comercio (sincronizados con ajustes/solicitar)
  const [puntosFavoritos, setPuntosFavoritos] = useState<PuntoFavorito[]>([])
  const [origenFavData, setOrigenFavData] = useState<PuntoFavorito | null>(null)

  useEffect(() => {
    const u = auth.currentUser
    if (u) setUid(u.uid)
  }, [])

  useEffect(() => {
    setRecOrigen(loadRecents('origen'))
    setRecDestino(loadRecents('destino'))
  }, [])

  // Real-time cotizaciones
  useEffect(() => {
    if (!uid) return
    setLoadingCot(true)
    const q = query(collection(db, 'cotizaciones'), where('userId', '==', uid), orderBy('createdAt', 'desc'))
    const unsub = onSnapshot(q, (snap) => {
      setCotizaciones(snap.docs.slice(0, 5).map((d) => {
        const raw = d.data() as any
        return {
          id: d.id,
          origen: raw.origen,
          destino: raw.destino,
          distanciaKm: raw.distanciaKm,
          precioCordobas: raw.precioCordobas,
          origenCoord: raw.origenCoord,
          destinoCoord: raw.destinoCoord,
          createdAt: raw.createdAt?.toDate?.() ?? null,
          fuente: raw.fuente,
        }
      }))
      setLoadingCot(false)
    }, () => setLoadingCot(false))
    return () => unsub()
  }, [uid])

  // Favoritos del comercio — usa la misma estructura que ajustes y solicitar
  useEffect(() => {
    if (!uid) return
    const unsub = onSnapshot(doc(db, 'comercios', uid), (snap) => {
      if (!snap.exists()) return
      const data = snap.data() as any
      const container = data?.puntosRetiro || {}
      const items: PuntoFavorito[] = []

      // Puntos con nombre libre (nueva estructura desde ajustes)
      Object.entries(container).forEach(([key, raw]: [string, any]) => {
        if (raw && typeof raw === 'object' && (raw.nombre || raw.direccion)) {
          items.push({
            key,
            label: raw.label || raw.nombre || key,
            nombre: raw.nombre,
            celular: raw.celular,
            direccion: raw.direccion,
            coord: raw.coord || null,
          })
        }
      })

      setPuntosFavoritos(items)
    })
    return () => unsub()
  }, [uid])

  // Close dropdowns on outside click
  useEffect(() => {
    const onDown = (e: MouseEvent) => {
      const ow = origenWrapRef.current
      const dw = destinoWrapRef.current
      if (ow && !ow.contains(e.target as Node) && dw && !dw.contains(e.target as Node)) {
        setShowSug({ o: false, d: false })
      }
    }
    document.addEventListener('mousedown', onDown, { passive: true })
    return () => document.removeEventListener('mousedown', onDown)
  }, [])

  // Autocomplete
  useEffect(() => {
    let mounted = true
    getMapsLoader().load().then((google) => {
      if (!mounted) return
      const managua = new google.maps.LatLngBounds(
        new google.maps.LatLng(11.94, -86.56),
        new google.maps.LatLng(12.35, -86.05)
      )
      const opts = { componentRestrictions: { country: 'ni' }, bounds: managua, strictBounds: true, fields: ['geometry', 'formatted_address'] }

      if (origenInputRef.current && !origenACRef.current) {
        const ac = new google.maps.places.Autocomplete(origenInputRef.current, opts)
        ac.addListener('place_changed', () => {
          const loc = ac.getPlace()?.geometry?.location
          if (loc) {
            const coord = { lat: loc.lat(), lng: loc.lng() }
            setOrigenCoord(coord)
            setOrigenFavData(null)
            const label = origenInputRef.current?.value || 'Origen'
            saveRecent('origen', { label, ...coord })
            setRecOrigen(loadRecents('origen'))
            setShowSug(s => ({ ...s, o: false }))
          }
        })
        origenACRef.current = ac
      }

      if (destinoInputRef.current && !destinoACRef.current) {
        const ac = new google.maps.places.Autocomplete(destinoInputRef.current, opts)
        ac.addListener('place_changed', () => {
          const loc = ac.getPlace()?.geometry?.location
          if (loc) {
            const coord = { lat: loc.lat(), lng: loc.lng() }
            setDestinoCoord(coord)
            const label = destinoInputRef.current?.value || 'Destino'
            saveRecent('destino', { label, ...coord })
            setRecDestino(loadRecents('destino'))
            setShowSug(s => ({ ...s, d: false }))
          }
        })
        destinoACRef.current = ac
      }
    })
    return () => { mounted = false }
  }, [])

  useEffect(() => {
    setDistancia(null); setPrecio(null); setError(null)
  }, [origenCoord, destinoCoord])

  // My location
  const useMyLocation = useCallback(() => {
    if (!navigator.geolocation) { setError('Tu navegador no soporta geolocalización.'); return }
    setLocating(true)
    navigator.geolocation.getCurrentPosition(
      async (pos) => {
        const { latitude: lat, longitude: lng } = pos.coords
        setOrigenCoord({ lat, lng })
        const google = await getMapsLoader().load()
        new google.maps.Geocoder().geocode({ location: { lat, lng } }, (results, status) => {
          const label = status === 'OK' && results?.[0] ? results[0].formatted_address : 'Tu ubicación'
          if (origenInputRef.current) origenInputRef.current.value = label
          saveRecent('origen', { label, lat, lng })
          setRecOrigen(loadRecents('origen'))
        })
        setLocating(false)
      },
      (err) => { setLocating(false); setError(err.code === 1 ? 'Permiso de ubicación denegado.' : 'No se pudo obtener tu ubicación.') },
      { enableHighAccuracy: true, timeout: 10000, maximumAge: 0 }
    )
  }, [])

  const swap = () => {
    const [oc, dc] = [origenCoord, destinoCoord]
    const [ot, dt] = [origenInputRef.current?.value || '', destinoInputRef.current?.value || '']
    setOrigenCoord(dc); setDestinoCoord(oc)
    if (origenInputRef.current) origenInputRef.current.value = dt
    if (destinoInputRef.current) destinoInputRef.current.value = ot
    setDistancia(null); setPrecio(null)
  }

  const calcular = async () => {
    setError(null); setDistancia(null); setPrecio(null)
    if (!origenCoord) { setError('Indicá el punto de retiro.'); return }
    if (!destinoCoord) { setError('Indicá el punto de entrega.'); return }
    if (!uid) { setError('No hay sesión activa.'); return }

    const o = `${origenCoord.lat},${origenCoord.lng}`
    const d = `${destinoCoord.lat},${destinoCoord.lng}`
    const cacheKey = `${CACHE_PREFIX}${o}-${d}`

    try {
      const raw = sessionStorage.getItem(cacheKey)
      if (raw) {
        const cached: { km: number; ts: number } = JSON.parse(raw)
        if (Date.now() - cached.ts < TTL_MS) {
          const p = tarifa(cached.km)
          setDistancia(cached.km); setPrecio(p)
          await guardarCotizacion(uid, { origen: origenInputRef.current?.value || '', destino: destinoInputRef.current?.value || '', km: cached.km, precio: p, origenCoord, destinoCoord, fuente: 'cache' })
          return
        }
        sessionStorage.removeItem(cacheKey)
      }
    } catch {}

    setLoading(true)
    try {
      const apiKey = process.env.NEXT_PUBLIC_GOOGLE_MAPS_API_KEY
      const url = `https://maps.googleapis.com/maps/api/distancematrix/json?origins=${encodeURIComponent(o)}&destinations=${encodeURIComponent(d)}&mode=driving&key=${apiKey}`
      const res = await fetch(`/api/proxy?url=${encodeURIComponent(url)}`)
      const data = await res.json()
      const metros = data.rows?.[0]?.elements?.[0]?.distance?.value
      if (!metros) { setError('No se pudo calcular la distancia. Verificá los puntos.'); return }
      const km = metros / 1000
      const p = tarifa(km)
      setDistancia(km); setPrecio(p)
      sessionStorage.setItem(cacheKey, JSON.stringify({ km, ts: Date.now() }))
      await guardarCotizacion(uid, { origen: origenInputRef.current?.value || '', destino: destinoInputRef.current?.value || '', km, precio: p, origenCoord, destinoCoord, fuente: 'api' })
    } catch (e) {
      console.error(e)
      setError('Error al calcular. Intentá de nuevo.')
    } finally {
      setLoading(false)
    }
  }

  const limpiar = () => {
    setOrigenCoord(null); setDestinoCoord(null); setDistancia(null); setPrecio(null); setError(null)
    if (origenInputRef.current) origenInputRef.current.value = ''
    if (destinoInputRef.current) destinoInputRef.current.value = ''
    setShowSug({ o: false, d: false })
    try {
      const keys: string[] = []
      for (let i = 0; i < sessionStorage.length; i++) {
        const k = sessionStorage.key(i)
        if (k?.startsWith(CACHE_PREFIX)) keys.push(k)
      }
      keys.forEach(k => sessionStorage.removeItem(k))
    } catch {}
  }

  const usarCotizacion = (cot: Cotizacion) => {
    if (origenInputRef.current) origenInputRef.current.value = cot.origen
    if (destinoInputRef.current) destinoInputRef.current.value = cot.destino
    if (cot.origenCoord) setOrigenCoord(cot.origenCoord)
    if (cot.destinoCoord) setDestinoCoord(cot.destinoCoord)
    setDistancia(cot.distanciaKm); setPrecio(cot.precioCordobas)
    window.scrollTo({ top: 0, behavior: 'smooth' })
  }

  const solicitarEnvio = (cot: Cotizacion) => {
    try {
      sessionStorage.setItem('draftEnvio', JSON.stringify({
        origen: cot.origen, destino: cot.destino,
        origenCoord: cot.origenCoord, destinoCoord: cot.destinoCoord,
        distanciaKm: cot.distanciaKm, precioCordobas: cot.precioCordobas,
        origenTipo: 'referencial', destinoTipo: 'referencial',
      }))
    } catch {}
    window.location.href = '/panel/solicitar'
  }

  const solicitarActual = () => {
    if (!origenCoord || !destinoCoord || distancia === null || precio === null) return
    try {
      sessionStorage.setItem('draftEnvio', JSON.stringify({
        origen: origenInputRef.current?.value || '',
        destino: destinoInputRef.current?.value || '',
        origenCoord, destinoCoord, distanciaKm: distancia, precioCordobas: precio,
        origenTipo: 'referencial', destinoTipo: 'referencial',
        origenFavKey: origenFavData?.key || '',
        origenNombre: origenFavData?.nombre || '',
        origenCelular: origenFavData?.celular || '',
        origenDireccion: origenFavData?.direccion || '',
      }))
    } catch {}
    window.location.href = '/panel/solicitar'
  }

  // Favoritos for map
  const favoritosMapa: FavoritoMapa[] = useMemo(() =>
    puntosFavoritos.filter(f => f.coord).map(f => ({ key: f.key, label: f.label, coord: f.coord! })),
    [puntosFavoritos]
  )

  const handleSelectFavoritoMapa = useCallback((fav: FavoritoMapa, tipo: 'origen' | 'destino') => {
    if (tipo === 'origen') {
      setOrigenCoord(fav.coord)
      const fullFav = puntosFavoritos.find(f => f.key === fav.key) || null
      setOrigenFavData(fullFav)
      if (origenInputRef.current) origenInputRef.current.value = fav.label
      saveRecent('origen', { label: fav.label, ...fav.coord })
      setRecOrigen(loadRecents('origen'))
    } else {
      setDestinoCoord(fav.coord)
      if (destinoInputRef.current) destinoInputRef.current.value = fav.label
      saveRecent('destino', { label: fav.label, ...fav.coord })
      setRecDestino(loadRecents('destino'))
    }
  }, [])

  const handleFocus = (which: 'o' | 'd') => {
    const val = which === 'o' ? origenInputRef.current?.value : destinoInputRef.current?.value
    if ((val || '').trim() === '') setShowSug(which === 'o' ? { o: true, d: false } : { o: false, d: true })
  }

  const handleInput = (which: 'o' | 'd') => {
    const val = which === 'o' ? origenInputRef.current?.value : destinoInputRef.current?.value
    setShowSug((val || '').trim() === '' ? (which === 'o' ? { o: true, d: false } : { o: false, d: true }) : { o: false, d: false })
  }

  const handleKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Escape') setShowSug({ o: false, d: false })
  }

  const puedeCalcular = !!origenCoord && !!destinoCoord && !loading

  return (
    <div style={{ fontFamily: "'SF Pro Display', -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif" }}>

      {error && (
        <div style={{ background: '#fef2f2', border: '1px solid #fecaca', borderRadius: 12, padding: '12px 16px', marginBottom: 16, color: '#dc2626', fontSize: 13, fontWeight: 600 }}>
          ⚠️ {error}
        </div>
      )}

      {/* Search inputs */}
      <div style={{ background: '#fff', border: '1px solid #e5e7eb', borderRadius: 16, padding: 16, marginBottom: 16, boxShadow: '0 1px 3px rgba(0,0,0,0.05)' }}>
        <div style={{ display: 'flex', gap: 10, alignItems: 'stretch' }}>
          <div style={{ flex: 1, display: 'flex', flexDirection: 'column', gap: 8 }}>
            <div ref={origenWrapRef} style={{ position: 'relative' }}>
              <SearchInput
                inputRef={origenInputRef}
                placeholder="Punto de retiro..."
                onFocusEmpty={() => handleFocus('o')}
                onInputChange={() => handleInput('o')}
                onKeyDown={handleKeyDown}
                icon="📦"
                color="#004aad"
                onClear={() => { if (origenInputRef.current) origenInputRef.current.value = ''; setOrigenCoord(null); setShowSug({ o: true, d: false }) }}
                onMyLocation={useMyLocation}
                locating={locating}
              />
              {showSug.o && (
                <RecentDropdown
                  items={recOrigen}
                  onSelect={(p) => { setOrigenCoord({ lat: p.lat, lng: p.lng }); if (origenInputRef.current) origenInputRef.current.value = p.label; setShowSug({ o: false, d: false }) }}
                  onClear={() => { clearRecents('origen'); setRecOrigen([]); setShowSug(s => ({ ...s, o: false })) }}
                />
              )}
            </div>

            <div ref={destinoWrapRef} style={{ position: 'relative' }}>
              <SearchInput
                inputRef={destinoInputRef}
                placeholder="Punto de entrega..."
                onFocusEmpty={() => handleFocus('d')}
                onInputChange={() => handleInput('d')}
                onKeyDown={handleKeyDown}
                icon="🏠"
                color="#16a34a"
                onClear={() => { if (destinoInputRef.current) destinoInputRef.current.value = ''; setDestinoCoord(null); setShowSug({ o: false, d: true }) }}
              />
              {showSug.d && (
                <RecentDropdown
                  items={recDestino}
                  onSelect={(p) => { setDestinoCoord({ lat: p.lat, lng: p.lng }); if (destinoInputRef.current) destinoInputRef.current.value = p.label; setShowSug({ o: false, d: false }) }}
                  onClear={() => { clearRecents('destino'); setRecDestino([]); setShowSug(s => ({ ...s, d: false })) }}
                />
              )}
            </div>
          </div>

          <button type="button" onClick={swap} title="Intercambiar" style={{ padding: '0 12px', borderRadius: 12, border: '1px solid #e5e7eb', background: '#fff', cursor: 'pointer', fontSize: 18, color: '#6b7280', display: 'flex', alignItems: 'center' }}>
            ⇅
          </button>
        </div>

        {/* Puntos favoritos del comercio */}
        {puntosFavoritos.length > 0 && (
          <div style={{ marginTop: 12, paddingTop: 12, borderTop: '1px solid #f3f4f6' }}>
            <p style={{ fontSize: 11, fontWeight: 700, color: '#9ca3af', textTransform: 'uppercase' as const, letterSpacing: 0.5, margin: '0 0 8px' }}>Mis lugares</p>
            <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' as const }}>
              {puntosFavoritos.map((fav) => (
                <div key={fav.key} style={{ display: 'flex', gap: 4 }}>
                  <button
                    type="button"
                    onClick={() => {
                      setOrigenCoord(fav.coord || null)
                      setOrigenFavData(fav)
                      if (origenInputRef.current) origenInputRef.current.value = fav.nombre || fav.label
                      if (fav.coord) saveRecent('origen', { label: fav.nombre || fav.label, ...fav.coord })
                      setRecOrigen(loadRecents('origen'))
                    }}
                    title={`Usar como retiro: ${fav.direccion || ''}`}
                    style={{ padding: '6px 10px', borderRadius: 8, border: '1px solid #bfdbfe', background: '#eff6ff', color: '#2563eb', fontSize: 11, fontWeight: 700, cursor: 'pointer' }}
                  >
                    {fav.label} → R
                  </button>
                  <button
                    type="button"
                    onClick={() => {
                      setDestinoCoord(fav.coord || null)
                      if (destinoInputRef.current) destinoInputRef.current.value = fav.nombre || fav.label
                      if (fav.coord) saveRecent('destino', { label: fav.nombre || fav.label, ...fav.coord })
                      setRecDestino(loadRecents('destino'))
                    }}
                    title={`Usar como entrega: ${fav.direccion || ''}`}
                    style={{ padding: '6px 10px', borderRadius: 8, border: '1px solid #bbf7d0', background: '#f0fdf4', color: '#16a34a', fontSize: 11, fontWeight: 700, cursor: 'pointer' }}
                  >
                    E
                  </button>
                </div>
              ))}
            </div>
          </div>
        )}
      </div>

      {/* Map */}
      <div style={{ marginBottom: 16 }}>
        <MapaSeleccion
          origen={origenCoord}
          destino={destinoCoord}
          onSetOrigen={(c) => {
            setOrigenCoord(c)
            if (c && origenInputRef.current?.value) { saveRecent('origen', { label: origenInputRef.current.value, lat: c.lat, lng: c.lng }); setRecOrigen(loadRecents('origen')) }
          }}
          onSetDestino={(c) => {
            setDestinoCoord(c)
            if (c && destinoInputRef.current?.value) { saveRecent('destino', { label: destinoInputRef.current.value, lat: c.lat, lng: c.lng }); setRecDestino(loadRecents('destino')) }
          }}
          onSetOrigenInput={(d) => { if (origenInputRef.current) origenInputRef.current.value = d }}
          onSetDestinoInput={(d) => { if (destinoInputRef.current) destinoInputRef.current.value = d }}
          size="compact"
          favoritos={favoritosMapa}
          onSelectFavorito={handleSelectFavoritoMapa}
        />
      </div>

      {/* Result */}
      {distancia !== null && (
        <div style={{ background: '#fff', border: '1px solid #e5e7eb', borderRadius: 16, padding: '16px 20px', marginBottom: 16, boxShadow: '0 1px 4px rgba(0,0,0,0.06)' }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', flexWrap: 'wrap' as const, gap: 12 }}>
            <div>
              <p style={{ fontSize: 11, fontWeight: 700, color: '#9ca3af', textTransform: 'uppercase' as const, letterSpacing: 0.5, margin: '0 0 4px' }}>Precio estimado</p>
              {precio === -1
                ? <p style={{ fontSize: 22, fontWeight: 900, color: '#d97706', margin: 0 }}>Consultar por WhatsApp</p>
                : <p style={{ fontSize: 32, fontWeight: 900, color: '#004aad', margin: 0, letterSpacing: -1 }}>C$ {precio}</p>
              }
              <p style={{ fontSize: 13, color: '#6b7280', margin: '4px 0 0' }}>Distancia: <strong>{distancia.toFixed(2)} km</strong> · Precio sujeto a confirmación</p>
            </div>
            {precio !== -1 && (
              <button type="button" onClick={solicitarActual} style={{ background: '#004aad', border: 'none', borderRadius: 12, padding: '12px 20px', color: '#fff', fontSize: 14, fontWeight: 800, cursor: 'pointer', whiteSpace: 'nowrap' as const }}>
                Solicitar este envío →
              </button>
            )}
          </div>
        </div>
      )}

      {/* Hint */}
      {origenCoord && destinoCoord && distancia === null && !loading && !error && (
        <div style={{ background: '#fffbe6', border: '1px solid #ffe58f', borderRadius: 12, padding: '12px 16px', marginBottom: 16, fontSize: 13, color: '#d46b08', fontWeight: 600 }}>
          ✓ Tenés los dos puntos listos. Tocá <strong>Calcular precio</strong>.
        </div>
      )}

      {/* Actions */}
      <div style={{ display: 'flex', gap: 10, marginBottom: 24 }}>
        <button
          type="button"
          onClick={calcular}
          disabled={!puedeCalcular}
          style={{ flex: 1, background: puedeCalcular ? '#004aad' : '#e5e7eb', border: 'none', borderRadius: 12, padding: '14px 20px', color: puedeCalcular ? '#fff' : '#9ca3af', fontSize: 15, fontWeight: 800, cursor: puedeCalcular ? 'pointer' : 'not-allowed', transition: 'all 0.15s' }}
        >
          {loading ? 'Calculando...' : '📏 Calcular precio'}
        </button>
        <button type="button" onClick={limpiar} style={{ padding: '14px 16px', borderRadius: 12, border: '1px solid #e5e7eb', background: '#fff', color: '#6b7280', fontSize: 14, fontWeight: 600, cursor: 'pointer' }}>
          Limpiar
        </button>
      </div>

      {/* Últimas cotizaciones - real time */}
      <div>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 12 }}>
          <h3 style={{ fontSize: 15, fontWeight: 800, color: '#111827', margin: 0 }}>Últimas cotizaciones</h3>
          <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
            <div style={{ width: 7, height: 7, borderRadius: '50%', background: '#16a34a', boxShadow: '0 0 0 2px #bbf7d0' }} />
            <span style={{ fontSize: 11, color: '#16a34a', fontWeight: 600 }}>En vivo</span>
          </div>
        </div>

        {loadingCot ? (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
            {[1, 2, 3].map(i => <div key={i} style={{ background: '#f9fafb', borderRadius: 14, height: 80, border: '1px solid #e5e7eb' }} />)}
          </div>
        ) : cotizaciones.length === 0 ? (
          <div style={{ background: '#f9fafb', border: '1px solid #e5e7eb', borderRadius: 14, padding: '24px 16px', textAlign: 'center' as const }}>
            <p style={{ fontSize: 24, margin: '0 0 8px' }}>🗺️</p>
            <p style={{ fontSize: 14, fontWeight: 600, color: '#374151', margin: '0 0 4px' }}>Todavía no hay cotizaciones</p>
            <p style={{ fontSize: 13, color: '#9ca3af', margin: 0 }}>Calculá tu primera ruta arriba</p>
          </div>
        ) : (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
            {cotizaciones.map((cot) => (
              <div key={cot.id} style={{ background: '#fff', border: '1px solid #e5e7eb', borderRadius: 14, padding: '14px 16px', boxShadow: '0 1px 2px rgba(0,0,0,0.04)' }}>
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', gap: 12, marginBottom: 10 }}>
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 4 }}>
                      <div style={{ width: 8, height: 8, borderRadius: '50%', background: '#004aad', flexShrink: 0 }} />
                      <span style={{ fontSize: 12, color: '#374151', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' as const }}>{cot.origen}</span>
                    </div>
                    <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                      <div style={{ width: 8, height: 8, borderRadius: '50%', background: '#16a34a', flexShrink: 0 }} />
                      <span style={{ fontSize: 12, color: '#374151', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' as const }}>{cot.destino}</span>
                    </div>
                    {cot.createdAt && <p style={{ fontSize: 11, color: '#d1d5db', margin: '6px 0 0' }}>{timeAgo(cot.createdAt)}</p>}
                  </div>
                  <div style={{ textAlign: 'right' as const, flexShrink: 0 }}>
                    <p style={{ fontSize: 20, fontWeight: 900, color: '#004aad', margin: '0 0 2px', letterSpacing: -0.5 }}>C$ {cot.precioCordobas}</p>
                    <p style={{ fontSize: 11, color: '#9ca3af', margin: 0 }}>{cot.distanciaKm?.toFixed(1)} km</p>
                  </div>
                </div>
                <div style={{ display: 'flex', gap: 8 }}>
                  <button type="button" onClick={() => usarCotizacion(cot)} style={{ padding: '7px 14px', borderRadius: 8, border: '1px solid #e5e7eb', background: '#fff', color: '#374151', fontSize: 12, fontWeight: 600, cursor: 'pointer' }}>
                    Usar de nuevo
                  </button>
                  <button type="button" onClick={() => solicitarEnvio(cot)} style={{ padding: '7px 14px', borderRadius: 8, border: 'none', background: '#004aad', color: '#fff', fontSize: 12, fontWeight: 700, cursor: 'pointer' }}>
                    Solicitar envío →
                  </button>
                </div>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  )
}

export default CalculadoraPrecio