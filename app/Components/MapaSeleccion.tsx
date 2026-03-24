'use client'
import React, { useEffect, useRef } from 'react'
import { getMapsLoader } from '@/lib/googleMaps'

interface MapaSeleccionProps {
  origen: google.maps.LatLngLiteral | null
  destino: google.maps.LatLngLiteral | null
  onSetOrigen: (coord: google.maps.LatLngLiteral | null) => void
  onSetDestino: (coord: google.maps.LatLngLiteral | null) => void
  onSetOrigenInput?: (direccion: string) => void
  onSetDestinoInput?: (direccion: string) => void
  /** altura del mapa */
  size?: 'compact' | 'normal' | 'tall'
}

const centerDefault: google.maps.LatLngLiteral = { lat: 12.1364, lng: -86.2514 } // Managua

export default function MapaSeleccion({
  origen,
  destino,
  onSetOrigen,
  onSetDestino,
  onSetOrigenInput,
  onSetDestinoInput,
  size = 'compact',
}: MapaSeleccionProps) {
  const containerRef = useRef<HTMLDivElement | null>(null)
  const mapRef = useRef<google.maps.Map | null>(null)
  const geocoderRef = useRef<google.maps.Geocoder | null>(null)
  const markerOrigenRef = useRef<google.maps.Marker | null>(null)
  const markerDestinoRef = useRef<google.maps.Marker | null>(null)
  const clickListenerRef = useRef<google.maps.MapsEventListener | null>(null)

  const heightClass =
    size === 'compact'
      ? 'h-[240px] md:h-[300px]'
      : size === 'tall'
      ? 'h-[420px] md:h-[520px]'
      : 'h-[340px] md:h-[420px]'

  useEffect(() => {
    let mounted = true

    getMapsLoader().load().then((google) => {
      if (!mounted || !containerRef.current) return

      mapRef.current = new google.maps.Map(containerRef.current, {
        center: origen || destino || centerDefault,
        zoom: 13,
        disableDefaultUI: true,
        fullscreenControl: false,
        streetViewControl: false,
        mapTypeControl: false,
      })

      geocoderRef.current = new google.maps.Geocoder()

      const onMapClick = (event: google.maps.MapMouseEvent) => {
        if (!event.latLng) return
        const coord = { lat: event.latLng.lat(), lng: event.latLng.lng() }

        if (!markerOrigenRef.current) {
          onSetOrigen(coord)
          if (geocoderRef.current && onSetOrigenInput) {
            geocoderRef.current.geocode({ location: coord }, (results, status) => {
              if (status === 'OK' && results && results[0]) onSetOrigenInput(results[0].formatted_address)
            })
          }
        } else if (!markerDestinoRef.current) {
          onSetDestino(coord)
          if (geocoderRef.current && onSetDestinoInput) {
            geocoderRef.current.geocode({ location: coord }, (results, status) => {
              if (status === 'OK' && results && results[0]) onSetDestinoInput(results[0].formatted_address)
            })
          }
        } else {
          onSetDestino(coord)
          if (geocoderRef.current && onSetDestinoInput) {
            geocoderRef.current.geocode({ location: coord }, (results, status) => {
              if (status === 'OK' && results && results[0]) onSetDestinoInput(results[0].formatted_address)
            })
          }
        }
      }

      clickListenerRef.current = mapRef.current.addListener('click', onMapClick)
    })

    return () => {
      mounted = false
      if (clickListenerRef.current) {
        clickListenerRef.current.remove()
        clickListenerRef.current = null
      }
      markerOrigenRef.current?.setMap(null)
      markerDestinoRef.current?.setMap(null)
      mapRef.current = null
      geocoderRef.current = null
    }
  }, [])

  useEffect(() => {
    if (!mapRef.current || !window.google) return
    const google = window.google
    if (origen) {
      if (!markerOrigenRef.current) {
        markerOrigenRef.current = new google.maps.Marker({
          map: mapRef.current,
          position: origen,
          label: 'R',
          icon: { url: 'http://maps.google.com/mapfiles/ms/icons/green-dot.png' },
        })
      } else {
        markerOrigenRef.current.setPosition(origen)
      }
    } else {
      markerOrigenRef.current?.setMap(null)
      markerOrigenRef.current = null
    }
  }, [origen])

  useEffect(() => {
    if (!mapRef.current || !window.google) return
    const google = window.google
    if (destino) {
      if (!markerDestinoRef.current) {
        markerDestinoRef.current = new google.maps.Marker({
          map: mapRef.current,
          position: destino,
          label: 'E',
          icon: { url: 'http://maps.google.com/mapfiles/ms/icons/red-dot.png' },
        })
      } else {
        markerDestinoRef.current.setPosition(destino)
      }
    } else {
      markerDestinoRef.current?.setMap(null)
      markerDestinoRef.current = null
    }
  }, [destino])

  useEffect(() => {
    const map = mapRef.current
    if (!map) return
    map.panTo(origen || destino || centerDefault)
  }, [origen, destino])

  return (
    <div className={`w-full ${heightClass} mt-2 rounded-xl overflow-hidden border`}>
      <div ref={containerRef} className="w-full h-full" />
    </div>
  )
}
