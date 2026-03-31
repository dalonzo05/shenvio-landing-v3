'use client'
import React, { useEffect, useRef } from 'react'
import { getMapsLoader } from '@/lib/googleMaps'

export type FavoritoMapa = {
  key: string
  label: string
  coord: google.maps.LatLngLiteral
}

interface MapaSeleccionProps {
  origen: google.maps.LatLngLiteral | null
  destino: google.maps.LatLngLiteral | null
  onSetOrigen: (coord: google.maps.LatLngLiteral | null) => void
  onSetDestino: (coord: google.maps.LatLngLiteral | null) => void
  onSetOrigenInput?: (direccion: string) => void
  onSetDestinoInput?: (direccion: string) => void
  size?: 'compact' | 'normal' | 'tall'
  favoritos?: FavoritoMapa[]
  onSelectFavorito?: (fav: FavoritoMapa, tipo: 'origen' | 'destino') => void
}

const centerDefault: google.maps.LatLngLiteral = { lat: 12.1364, lng: -86.2514 }

// Custom SVG markers
function makeMarkerIcon(google: typeof window.google, color: string, letter: string): google.maps.Symbol {
  return {
    path: 'M12 2C8.13 2 5 5.13 5 9c0 5.25 7 13 7 13s7-7.75 7-13c0-3.87-3.13-7-7-7zm0 9.5c-1.38 0-2.5-1.12-2.5-2.5s1.12-2.5 2.5-2.5 2.5 1.12 2.5 2.5-1.12 2.5-2.5 2.5z',
    fillColor: color,
    fillOpacity: 1,
    strokeColor: '#fff',
    strokeWeight: 2,
    scale: 1.8,
    anchor: new google.maps.Point(12, 22),
    labelOrigin: new google.maps.Point(12, 9),
  }
}

export default function MapaSeleccion({
  origen,
  destino,
  onSetOrigen,
  onSetDestino,
  onSetOrigenInput,
  onSetDestinoInput,
  size = 'compact',
  favoritos = [],
  onSelectFavorito,
}: MapaSeleccionProps) {
  const containerRef = useRef<HTMLDivElement | null>(null)
  const mapRef = useRef<google.maps.Map | null>(null)
  const geocoderRef = useRef<google.maps.Geocoder | null>(null)
  const markerOrigenRef = useRef<google.maps.Marker | null>(null)
  const markerDestinoRef = useRef<google.maps.Marker | null>(null)
  const polylineRef = useRef<google.maps.Polyline | null>(null)
  const favMarkersRef = useRef<google.maps.Marker[]>([])
  const clickListenerRef = useRef<google.maps.MapsEventListener | null>(null)
  const infoWindowRef = useRef<google.maps.InfoWindow | null>(null)

  const heightClass =
    size === 'compact' ? 'h-[260px] md:h-[320px]' :
    size === 'tall' ? 'h-[440px] md:h-[540px]' :
    'h-[360px] md:h-[440px]'

  // Init map
  useEffect(() => {
    let mounted = true

    getMapsLoader().load().then((google) => {
      if (!mounted || !containerRef.current) return

      mapRef.current = new google.maps.Map(containerRef.current, {
        center: origen || destino || centerDefault,
        zoom: 13,
        disableDefaultUI: true,
        zoomControl: true,
        styles: [
          { featureType: 'poi', stylers: [{ visibility: 'off' }] },
          { featureType: 'transit', stylers: [{ visibility: 'off' }] },
          { elementType: 'labels.icon', stylers: [{ visibility: 'off' }] },
        ],
      })

      geocoderRef.current = new google.maps.Geocoder()
      infoWindowRef.current = new google.maps.InfoWindow()

      // Click to place markers
      clickListenerRef.current = mapRef.current.addListener('click', (event: google.maps.MapMouseEvent) => {
        if (!event.latLng) return
        const coord = { lat: event.latLng.lat(), lng: event.latLng.lng() }

        const setWithGeocode = (
          setter: (c: google.maps.LatLngLiteral) => void,
          inputSetter?: (s: string) => void
        ) => {
          setter(coord)
          if (geocoderRef.current && inputSetter) {
            geocoderRef.current.geocode({ location: coord }, (results, status) => {
              if (status === 'OK' && results?.[0]) inputSetter(results[0].formatted_address)
            })
          }
        }

        if (!markerOrigenRef.current) {
          setWithGeocode(onSetOrigen, onSetOrigenInput)
        } else {
          setWithGeocode(onSetDestino, onSetDestinoInput)
        }
      })
    })

    return () => {
      mounted = false
      clickListenerRef.current?.remove()
      clickListenerRef.current = null
      markerOrigenRef.current?.setMap(null)
      markerDestinoRef.current?.setMap(null)
      polylineRef.current?.setMap(null)
      favMarkersRef.current.forEach(m => m.setMap(null))
      mapRef.current = null
      geocoderRef.current = null
    }
  }, [])

  // Update origen marker
  useEffect(() => {
    if (!mapRef.current || !window.google) return
    const google = window.google

    if (origen) {
      if (!markerOrigenRef.current) {
        markerOrigenRef.current = new google.maps.Marker({
          map: mapRef.current,
          position: origen,
          icon: makeMarkerIcon(google, '#004aad', 'R'),
          label: { text: 'R', color: '#fff', fontWeight: 'bold', fontSize: '11px' },
          title: 'Punto de retiro',
          zIndex: 10,
        })

        markerOrigenRef.current.addListener('click', () => {
          infoWindowRef.current?.setContent('<div style="font-size:13px;font-weight:700;color:#004aad">📦 Punto de retiro</div>')
          infoWindowRef.current?.open(mapRef.current, markerOrigenRef.current)
        })
      } else {
        markerOrigenRef.current.setPosition(origen)
      }
    } else {
      markerOrigenRef.current?.setMap(null)
      markerOrigenRef.current = null
    }
  }, [origen])

  // Update destino marker
  useEffect(() => {
    if (!mapRef.current || !window.google) return
    const google = window.google

    if (destino) {
      if (!markerDestinoRef.current) {
        markerDestinoRef.current = new google.maps.Marker({
          map: mapRef.current,
          position: destino,
          icon: makeMarkerIcon(google, '#16a34a', 'E'),
          label: { text: 'E', color: '#fff', fontWeight: 'bold', fontSize: '11px' },
          title: 'Punto de entrega',
          zIndex: 10,
        })

        markerDestinoRef.current.addListener('click', () => {
          infoWindowRef.current?.setContent('<div style="font-size:13px;font-weight:700;color:#16a34a">🏠 Punto de entrega</div>')
          infoWindowRef.current?.open(mapRef.current, markerDestinoRef.current)
        })
      } else {
        markerDestinoRef.current.setPosition(destino)
      }
    } else {
      markerDestinoRef.current?.setMap(null)
      markerDestinoRef.current = null
    }
  }, [destino])

  // Draw polyline between points
  useEffect(() => {
    if (!mapRef.current || !window.google) return
    const google = window.google

    polylineRef.current?.setMap(null)
    polylineRef.current = null

    if (origen && destino) {
      polylineRef.current = new google.maps.Polyline({
        path: [origen, destino],
        geodesic: true,
        strokeColor: '#004aad',
        strokeOpacity: 0,
        strokeWeight: 0,
        icons: [{
          icon: {
            path: 'M 0,-1 0,1',
            strokeOpacity: 0.8,
            strokeColor: '#004aad',
            strokeWeight: 3,
            scale: 4,
          },
          offset: '0',
          repeat: '20px',
        }],
        map: mapRef.current,
      })

      // Fit bounds
      const bounds = new google.maps.LatLngBounds()
      bounds.extend(origen)
      bounds.extend(destino)
      mapRef.current.fitBounds(bounds, { top: 60, right: 40, bottom: 40, left: 40 })
    }
  }, [origen, destino])

  // Favorites markers
  useEffect(() => {
    if (!mapRef.current || !window.google) return
    const google = window.google

    favMarkersRef.current.forEach(m => m.setMap(null))
    favMarkersRef.current = []

    favoritos.forEach((fav) => {
      const marker = new google.maps.Marker({
        map: mapRef.current!,
        position: fav.coord,
        icon: {
          path: google.maps.SymbolPath.CIRCLE,
          fillColor: '#f59e0b',
          fillOpacity: 1,
          strokeColor: '#fff',
          strokeWeight: 2,
          scale: 9,
        },
        title: fav.label,
        zIndex: 5,
      })

      marker.addListener('click', () => {
        if (infoWindowRef.current) {
          infoWindowRef.current.setContent(`
            <div style="padding:4px 2px;min-width:160px">
              <p style="font-size:13px;font-weight:700;color:#111827;margin:0 0 8px">⭐ ${fav.label}</p>
              ${onSelectFavorito ? `
                <div style="display:flex;gap:6px;flex-wrap:wrap">
                  <button onclick="window._mapFavOrigen && window._mapFavOrigen('${fav.key}')" 
                    style="padding:5px 10px;border-radius:6px;border:1px solid #004aad;background:#eff6ff;color:#004aad;font-size:11px;font-weight:700;cursor:pointer">
                    Usar como retiro
                  </button>
                  <button onclick="window._mapFavDestino && window._mapFavDestino('${fav.key}')"
                    style="padding:5px 10px;border-radius:6px;border:1px solid #16a34a;background:#f0fdf4;color:#16a34a;font-size:11px;font-weight:700;cursor:pointer">
                    Usar como entrega
                  </button>
                </div>
              ` : ''}
            </div>
          `)
          infoWindowRef.current.open(mapRef.current, marker)
        }
      })

      favMarkersRef.current.push(marker)
    })

    // Expose handlers for InfoWindow buttons
    if (onSelectFavorito) {
      ;(window as any)._mapFavOrigen = (key: string) => {
        const fav = favoritos.find(f => f.key === key)
        if (fav) onSelectFavorito(fav, 'origen')
        infoWindowRef.current?.close()
      }
      ;(window as any)._mapFavDestino = (key: string) => {
        const fav = favoritos.find(f => f.key === key)
        if (fav) onSelectFavorito(fav, 'destino')
        infoWindowRef.current?.close()
      }
    }
  }, [favoritos, onSelectFavorito])

  // Pan to latest point
  useEffect(() => {
    const map = mapRef.current
    if (!map) return
    if (!origen && !destino) map.panTo(centerDefault)
  }, [origen, destino])

  return (
    <div className={`w-full ${heightClass} rounded-xl overflow-hidden border border-gray-200 shadow-sm relative`}>
      <div ref={containerRef} className="w-full h-full" />

      {/* Legend */}
      <div className="absolute bottom-3 left-3 flex gap-2 pointer-events-none">
        <div className="flex items-center gap-1.5 bg-white/90 backdrop-blur-sm rounded-full px-2.5 py-1 shadow-sm border border-gray-200">
          <div className="w-2.5 h-2.5 rounded-full bg-[#004aad]" />
          <span className="text-xs font-semibold text-gray-700">Retiro</span>
        </div>
        <div className="flex items-center gap-1.5 bg-white/90 backdrop-blur-sm rounded-full px-2.5 py-1 shadow-sm border border-gray-200">
          <div className="w-2.5 h-2.5 rounded-full bg-[#16a34a]" />
          <span className="text-xs font-semibold text-gray-700">Entrega</span>
        </div>
        {favoritos.length > 0 && (
          <div className="flex items-center gap-1.5 bg-white/90 backdrop-blur-sm rounded-full px-2.5 py-1 shadow-sm border border-gray-200">
            <div className="w-2.5 h-2.5 rounded-full bg-[#f59e0b]" />
            <span className="text-xs font-semibold text-gray-700">Favoritos</span>
          </div>
        )}
      </div>

      {/* Hint overlay when empty */}
      {!origen && !destino && (
        <div className="absolute inset-0 flex items-center justify-center pointer-events-none">
          <div className="bg-white/90 backdrop-blur-sm rounded-xl px-4 py-3 shadow-sm border border-gray-200 text-center">
            <p className="text-sm font-semibold text-gray-700">Tocá el mapa para marcar puntos</p>
            <p className="text-xs text-gray-500 mt-1">Primero retiro, luego entrega</p>
          </div>
        </div>
      )}
    </div>
  )
}