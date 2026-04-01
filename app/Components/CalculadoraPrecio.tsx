'use client'
import React, { useEffect, useRef, useState } from 'react'
import MapaSeleccion from './MapaSeleccion'
import { FaTrash, FaLocationArrow, FaExchangeAlt } from 'react-icons/fa'
import { getMapsLoader } from '@/lib/googleMaps'

type GAutocomplete = google.maps.places.Autocomplete
type LatLng = google.maps.LatLngLiteral

// ===== Cache (sessionStorage) =====
const CACHE_PREFIX = 'dm:' // distance-matrix
const TTL_MS = 10 * 60 * 1000 // 10 minutos

// ===== Recientes (localStorage) con vencimiento =====
type PlaceLite = { label: string; lat: number; lng: number; ts: number }
const RECENT_MAX = 6
const RECENT_TTL_MS = 7 * 24 * 60 * 60 * 1000 // 7 días
const RKEY = { origen: 'recent:origen', destino: 'recent:destino' } as const

function loadRecents(kind: keyof typeof RKEY): PlaceLite[] {
  try {
    const raw = localStorage.getItem(RKEY[kind]) || '[]'
    const arr: (PlaceLite | Omit<PlaceLite, 'ts'>)[] = JSON.parse(raw)
    const now = Date.now()
    const normalized: PlaceLite[] = arr.map((x: any) => ({
      label: x.label,
      lat: x.lat,
      lng: x.lng,
      ts: typeof x.ts === 'number' ? x.ts : now,
    }))
    const filtered = normalized.filter(x => now - x.ts < RECENT_TTL_MS)
    if (filtered.length !== normalized.length) {
      localStorage.setItem(RKEY[kind], JSON.stringify(filtered))
    }
    return filtered
  } catch {
    return []
  }
}
function saveRecent(kind: keyof typeof RKEY, p: { label: string; lat: number; lng: number }) {
  const list = loadRecents(kind).filter((x) => x.label !== p.label)
  list.unshift({ ...p, ts: Date.now() })
  localStorage.setItem(RKEY[kind], JSON.stringify(list.slice(0, RECENT_MAX)))
}
function clearRecents(kind: keyof typeof RKEY) {
  localStorage.removeItem(RKEY[kind])
}

const CalculadoraPrecio: React.FC = () => {
  const origenInputRef = useRef<HTMLInputElement>(null)
  const destinoInputRef = useRef<HTMLInputElement>(null)

  const origenWrapRef = useRef<HTMLDivElement>(null)
  const destinoWrapRef = useRef<HTMLDivElement>(null)

  const origenAutocompleteRef = useRef<GAutocomplete | null>(null)
  const destinoAutocompleteRef = useRef<GAutocomplete | null>(null)

  const [origenCoord, setOrigenCoord] = useState<LatLng | null>(null)
  const [destinoCoord, setDestinoCoord] = useState<LatLng | null>(null)
  const [distancia, setDistancia] = useState<number | null>(null)
  const [precio, setPrecio] = useState<number | null>(null)
  const [loading, setLoading] = useState(false)
  const [locating, setLocating] = useState(false)
  const [error, setError] = useState<string | null>(null)

  // Recientes
  const [recOrigen, setRecOrigen] = useState<PlaceLite[]>([])
  const [recDestino, setRecDestino] = useState<PlaceLite[]>([])
  const [showSug, setShowSug] = useState<{ o: boolean; d: boolean }>({ o: false, d: false })

  useEffect(() => {
    setRecOrigen(loadRecents('origen'))
    setRecDestino(loadRecents('destino'))
  }, [])

  // Cerrar recientes al hacer click fuera
  useEffect(() => {
    const onDown = (e: MouseEvent) => {
      const ow = origenWrapRef.current
      const dw = destinoWrapRef.current
      if ((ow && !ow.contains(e.target as Node)) && (dw && !dw.contains(e.target as Node))) {
        setShowSug({ o: false, d: false })
      }
    }
    document.addEventListener('mousedown', onDown, { passive: true })
    return () => document.removeEventListener('mousedown', onDown)
  }, [])

  // Autocomplete nativo
  useEffect(() => {
    let mounted = true
    getMapsLoader().load().then((google) => {
      if (!mounted) return

      if (origenInputRef.current && !origenAutocompleteRef.current) {
        const ac = new google.maps.places.Autocomplete(origenInputRef.current, {
          componentRestrictions: { country: 'ni' },
          fields: ['geometry'],
        })
        ac.addListener('place_changed', () => {
          const place = ac.getPlace()
          const loc = place.geometry?.location
          if (loc) {
            const lat = loc.lat(); const lng = loc.lng()
            setOrigenCoord({ lat, lng })
            const label = origenInputRef.current?.value || 'Origen'
            saveRecent('origen', { label, lat, lng })
            setRecOrigen(loadRecents('origen'))
            setShowSug((s) => ({ ...s, o: false }))
          } else {
            setError('No se pudo obtener la ubicación del punto de origen.')
          }
        })
        origenAutocompleteRef.current = ac
      }

      if (destinoInputRef.current && !destinoAutocompleteRef.current) {
        const ac = new google.maps.places.Autocomplete(destinoInputRef.current, {
          componentRestrictions: { country: 'ni' },
          fields: ['geometry'],
        })
        ac.addListener('place_changed', () => {
          const place = ac.getPlace()
          const loc = place.geometry?.location
          if (loc) {
            const lat = loc.lat(); const lng = loc.lng()
            setDestinoCoord({ lat, lng })
            const label = destinoInputRef.current?.value || 'Destino'
            saveRecent('destino', { label, lat, lng })
            setRecDestino(loadRecents('destino'))
            setShowSug((s) => ({ ...s, d: false }))
          } else {
            setError('No se pudo obtener la ubicación del punto de destino.')
          }
        })
        destinoAutocompleteRef.current = ac
      }
    })
    return () => { mounted = false }
  }, [])

  // limpiar resultado al cambiar puntos
  useEffect(() => {
    setDistancia(null)
    setPrecio(null)
    setError(null)
  }, [origenCoord, destinoCoord])

  // ===== helpers UI (recientes)
  function chooseRecent(kind: 'origen' | 'destino', p: PlaceLite) {
    if (kind === 'origen') {
      setOrigenCoord({ lat: p.lat, lng: p.lng })
      if (origenInputRef.current) origenInputRef.current.value = p.label
    } else {
      setDestinoCoord({ lat: p.lat, lng: p.lng })
      if (destinoInputRef.current) destinoInputRef.current.value = p.label
    }
    setShowSug({ o: false, d: false })
  }
  const handleFocus = (which: 'o' | 'd') => {
    if (which === 'o') {
      const v = origenInputRef.current?.value?.trim() || ''
      setShowSug({ o: v === '', d: false })
    } else {
      const v = destinoInputRef.current?.value?.trim() || ''
      setShowSug({ o: false, d: v === '' })
    }
  }
  const handleInput = (which: 'o' | 'd') => {
    const v = which === 'o'
      ? (origenInputRef.current?.value?.trim() || '')
      : (destinoInputRef.current?.value?.trim() || '')
    if (which === 'o') setShowSug({ o: v === '', d: false })
    else setShowSug({ o: false, d: v === '' })
  }
  const handleKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Escape') setShowSug({ o: false, d: false })
  }

  // ===== Mi ubicación (origen)
  async function geocodeLatLng(lat: number, lng: number): Promise<string> {
    const google = await getMapsLoader().load()
    return new Promise((resolve) => {
      const geocoder = new google.maps.Geocoder()
      geocoder.geocode({ location: { lat, lng } }, (results, status) => {
        if (status === 'OK' && results && results[0]) resolve(results[0].formatted_address)
        else resolve('Tu ubicación')
      })
    })
  }
  const useMyLocation = () => {
    if (!navigator.geolocation) {
      setError('Tu navegador no soporta geolocalización.')
      return
    }
    setLocating(true)
    navigator.geolocation.getCurrentPosition(
      async (pos) => {
        const { latitude: lat, longitude: lng } = pos.coords
        setOrigenCoord({ lat, lng })
        const label = await geocodeLatLng(lat, lng)
        if (origenInputRef.current) origenInputRef.current.value = label
        saveRecent('origen', { label, lat, lng })
        setRecOrigen(loadRecents('origen'))
        setShowSug({ o: false, d: false })
        setLocating(false)
      },
      (err) => {
        setLocating(false)
        setError(err.code === 1 ? 'Permiso de ubicación denegado.' : 'No se pudo obtener tu ubicación.')
      },
      { enableHighAccuracy: true, timeout: 10000, maximumAge: 0 }
    )
  }

  // ===== Intercambiar Origen ↔ Destino
  const swapPoints = () => {
    const o = origenCoord
    const d = destinoCoord
    const txtO = origenInputRef.current?.value || ''
    const txtD = destinoInputRef.current?.value || ''
    setOrigenCoord(d || null)
    setDestinoCoord(o || null)
    if (origenInputRef.current) origenInputRef.current.value = txtD
    if (destinoInputRef.current) destinoInputRef.current.value = txtO
    setShowSug({ o: false, d: false })
    setDistancia(null); setPrecio(null)
  }

  // ===== Tarifario
  const calcularTarifaPorDistancia = (km: number): number => {
    if (km < 2) return 60
    if (km < 4) return 70
    if (km < 6) return 80
    if (km < 8) return 100
    if (km < 10) return 110
    if (km < 12) return 120
    if (km < 14) return 140
    if (km < 16) return 150
    if (km < 18) return 170
    if (km < 20) return 180
    if (km < 22) return 200
    if (km < 24) return 210
    if (km < 26) return 230
    if (km < 28) return 240
    if (km < 30) return 260
    if (km < 32) return 270
    if (km < 34) return 290
    if (km < 36) return 300
    if (km < 38) return 320
    if (km < 40) return 330
    if (km < 42) return 350
    if (km < 44) return 360
    if (km < 46) return 380
    if (km < 48) return 390
    if (km < 50) return 410
    if (km < 52) return 420
    if (km < 54) return 430
    return 450
  }

  // ===== Calcular con cache =====
  const calcularPrecio = async () => {
    setError(null); setDistancia(null); setPrecio(null)
    if (!origenCoord) { setError('Indicá el punto de origen.'); return }
    if (!destinoCoord) { setError('Indicá el punto de destino.'); return }

    const o = `${origenCoord.lat},${origenCoord.lng}`
    const d = `${destinoCoord.lat},${destinoCoord.lng}`
    const cacheKey = `${CACHE_PREFIX}${o}-${d}`

    try {
      const raw = sessionStorage.getItem(cacheKey)
      if (raw) {
        const cached: { km: number; ts: number } = JSON.parse(raw)
        if (Date.now() - cached.ts < TTL_MS) {
          setDistancia(cached.km)
          setPrecio(calcularTarifaPorDistancia(cached.km))
          return
        } else {
          sessionStorage.removeItem(cacheKey)
        }
      }
    } catch {}

    setLoading(true)
    try {
      const apiKey = process.env.NEXT_PUBLIC_GOOGLE_MAPS_API_KEY
      const url = `https://maps.googleapis.com/maps/api/distancematrix/json?origins=${encodeURIComponent(o)}&destinations=${encodeURIComponent(d)}&mode=driving&key=${apiKey}`
      const res = await fetch(`/api/proxy?url=${encodeURIComponent(url)}`)
      const data = await res.json()
      const metros = data.rows?.[0]?.elements?.[0]?.distance?.value
      if (!metros) { setError('No se pudo calcular la distancia.'); return }

      const km = metros / 1000
      setDistancia(km)
      setPrecio(calcularTarifaPorDistancia(km))
      sessionStorage.setItem(cacheKey, JSON.stringify({ km, ts: Date.now() }))
    } catch (e) {
      console.error(e)
      setError('Error al calcular el precio. Intentá de nuevo.')
    } finally {
      setLoading(false)
    }
  }

  const limpiarTodo = () => {
    setOrigenCoord(null); setDestinoCoord(null); setDistancia(null); setPrecio(null); setError(null)
    if (origenInputRef.current) origenInputRef.current.value = ''
    if (destinoInputRef.current) destinoInputRef.current.value = ''

    try {
      const keys: string[] = []
      for (let i = 0; i < sessionStorage.length; i++) {
        const k = sessionStorage.key(i)
        if (k && k.startsWith(CACHE_PREFIX)) keys.push(k)
      }
      keys.forEach((k) => sessionStorage.removeItem(k))
    } catch {}
    setShowSug({ o: false, d: false })
  }

  return (
    <div className="w-full">
      <h2 className="text-xl font-semibold mb-3 text-center">
        Calculadora de Precio de Envío
      </h2>

      {error && (
        <div className="bg-red-100 text-red-700 border border-red-300 p-3 rounded mb-4 text-sm text-center">
          {error}
        </div>
      )}

      {/* Inputs apilados + botón swap a la derecha */}
      <div className="relative">
        {/* Swap flotante (a la derecha, centrado entre inputs) */}
        <button
          type="button"
          onClick={swapPoints}
          className="absolute right-0 top-1/2 -translate-y-1/2 rounded-full border px-3 py-2 text-sm bg-white hover:bg-gray-50 shadow-sm"
          title="Intercambiar Origen y Destino"
        >
          <FaExchangeAlt />
        </button>

        <div className="pr-14 flex flex-col gap-2"> {/* pr-14 deja espacio para el swap */}
          {/* Origen */}
          <div className="relative" ref={origenWrapRef}>
            <input
              ref={origenInputRef}
              type="text"
              placeholder="Dirección de retiro (o seleccioná en el mapa)"
              className="border border-gray-300 p-2 rounded w-full pr-16"
              onFocus={() => handleFocus('o')}
              onInput={() => handleInput('o')}
              onKeyDown={handleKeyDown}
            />
            {/* acciones dentro del input */}
            <div className="absolute right-2 top-1/2 -translate-y-1/2 flex items-center gap-1">
              <button
                type="button"
                onClick={useMyLocation}
                disabled={locating}
                className="p-2 rounded-full border hover:bg-gray-50 disabled:opacity-60"
                title="Usar mi ubicación"
                aria-label="Usar mi ubicación"
              >
                <FaLocationArrow className={locating ? 'animate-pulse' : ''} />
              </button>
              <button
                type="button"
                onClick={() => {
                  if (origenInputRef.current) origenInputRef.current.value = ''
                  setOrigenCoord(null)
                  setShowSug({ o: true, d: false })
                }}
                className="text-gray-500 hover:text-black p-2"
                aria-label="Limpiar origen"
                title="Limpiar"
              >
                <FaTrash />
              </button>
            </div>

            {/* Recientes: Origen */}
            {showSug.o && recOrigen.length > 0 && (
              <ul
                className="absolute z-20 left-0 right-0 mt-1 rounded-md border bg-white shadow text-sm max-h-36 overflow-auto"
                onMouseDown={(e) => e.preventDefault()}
              >
                <li className="px-3 py-1 text-gray-500 flex items-center justify-between">
                  <span>Recientes</span>
                  <button
                    className="text-xs underline hover:opacity-80"
                    onClick={() => {
                      clearRecents('origen')
                      setRecOrigen([])
                      setShowSug((s)=>({ ...s, o: false }))
                    }}
                  >
                    borrar
                  </button>
                </li>
                {recOrigen.map((p, i) => (
                  <li key={i}>
                    <button
                      type="button"
                      className="w-full text-left px-3 py-2 hover:bg-gray-50"
                      onClick={() => chooseRecent('origen', p)}
                    >
                      {p.label}
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </div>

          {/* Destino */}
          <div className="relative" ref={destinoWrapRef}>
            <input
              ref={destinoInputRef}
              type="text"
              placeholder="Dirección de entrega (o seleccioná en el mapa)"
              className="border border-gray-300 p-2 rounded w-full pr-10"
              onFocus={() => handleFocus('d')}
              onInput={() => handleInput('d')}
              onKeyDown={handleKeyDown}
            />
            <button
              type="button"
              onClick={() => {
                if (destinoInputRef.current) destinoInputRef.current.value = ''
                setDestinoCoord(null)
                setShowSug({ o: false, d: true })
              }}
              className="absolute right-2 top-1/2 -translate-y-1/2 text-gray-500 hover:text-black p-2"
              aria-label="Limpiar destino"
              title="Limpiar"
            >
              <FaTrash />
            </button>

            {/* Recientes: Destino */}
            {showSug.d && recDestino.length > 0 && (
              <ul
                className="absolute z-20 left-0 right-0 mt-1 rounded-md border bg-white shadow text-sm max-h-36 overflow-auto"
                onMouseDown={(e) => e.preventDefault()}
              >
                <li className="px-3 py-1 text-gray-500 flex items-center justify-between">
                  <span>Recientes</span>
                  <button
                    className="text-xs underline hover:opacity-80"
                    onClick={() => {
                      clearRecents('destino')
                      setRecDestino([])
                      setShowSug((s)=>({ ...s, d: false }))
                    }}
                  >
                    borrar
                  </button>
                </li>
                {recDestino.map((p, i) => (
                  <li key={i}>
                    <button
                      type="button"
                      className="w-full text-left px-3 py-2 hover:bg-gray-50"
                      onClick={() => chooseRecent('destino', p)}
                    >
                      {p.label}
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </div>
        </div>
      </div>

      {/* Mapa (compacto) */}
      <div className="mt-4">
        <MapaSeleccion
          origen={origenCoord}
          destino={destinoCoord}
          onSetOrigen={(c) => {
            setOrigenCoord(c)
            if (c && origenInputRef.current?.value) {
              saveRecent('origen', { label: origenInputRef.current.value, lat: c.lat, lng: c.lng })
              setRecOrigen(loadRecents('origen'))
            }
          }}
          onSetDestino={(c) => {
            setDestinoCoord(c)
            if (c && destinoInputRef.current?.value) {
              saveRecent('destino', { label: destinoInputRef.current.value, lat: c.lat, lng: c.lng })
              setRecDestino(loadRecents('destino'))
            }
          }}
          onSetOrigenInput={(d) => { if (origenInputRef.current) origenInputRef.current.value = d }}
          onSetDestinoInput={(d) => { if (destinoInputRef.current) destinoInputRef.current.value = d }}
          size="compact"
        />
      </div>

      {/* Hint */}
      {origenCoord && destinoCoord && distancia === null && !loading && !error && (
        <div className="mt-3 rounded-lg border border-amber-300 bg-amber-50 text-amber-800 px-3 py-2 text-sm">
          Tenés origen y destino listos. Tocá <strong>Calcular precio</strong> para ver el resultado.
        </div>
      )}

      {/* Acciones */}
      <div className="flex flex-col sm:flex-row gap-3 pt-3">
        <button
          className="flex-1 rounded-full bg-[#004aad] text-white py-3 font-semibold
                     shadow-sm ring-1 ring-[#004aad]/20 transition will-change-transform
                     hover:-translate-y-[1px] hover:shadow-md
                     focus:outline-none focus-visible:ring-2 focus-visible:ring-[#004aad]/40 active:translate-y-0"
          onClick={calcularPrecio}
          disabled={loading}
        >
          {loading ? 'Calculando...' : 'Calcular precio'}
        </button>

        <button
          className="flex-1 rounded-full bg-red-600 text-white py-3 font-semibold
                     shadow-sm ring-1 ring-red-300/60 transition
                     hover:bg-red-700 hover:shadow-md
                     focus:outline-none focus-visible:ring-2 focus-visible:ring-red-300"
          onClick={limpiarTodo}
        >
          Limpiar todo
        </button>
      </div>

      {/* Resultado */}
      {distancia !== null && (
        <div className="mt-4 rounded-xl bg-[#004aad]/5 border border-[#004aad]/30 p-4 flex flex-col sm:flex-row items-center justify-between gap-3">
          <div className="text-[#004aad] text-2xl font-extrabold">
            {distancia > 54 ? 'Consultar por WhatsApp' : `C$ ${precio}`}
          </div>
          <div className="text-sm text-gray-700">
            Distancia: <strong>{distancia.toFixed(2)} km</strong>
          </div>
        </div>
      )}
    </div>
  )
}

export default CalculadoraPrecio
