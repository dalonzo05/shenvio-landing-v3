'use client'
import React, { useEffect, useRef, useState, useMemo, useCallback } from 'react'
import MapaSeleccion, { FavoritoMapa } from './MapaSeleccion'
import { getMapsLoader } from '@/lib/googleMaps'
import {
  addDoc,
  collection,
  doc,
  getDocs,
  onSnapshot,
  orderBy,
  query,
  serverTimestamp,
  where,
} from 'firebase/firestore'
import { onAuthStateChanged } from 'firebase/auth'
import { db, auth } from '@/fb/config'
import { getZonasActivas } from '@/fb/zonas'
import { clasificarOrdenCompleto, ZonaGeografica } from '@/lib/zonas'
import { obtenerDistanciaMetros } from '@/lib/distancia'
import { SearchInput } from './calculadora/SearchInput'
import { RecentDropdown } from './calculadora/RecentDropdown'
import { FavoritosRetiro } from './calculadora/FavoritosRetiro'
import { ResultadoCotizacion } from './calculadora/ResultadoCotizacion'
import { HistorialCotizaciones } from './calculadora/HistorialCotizaciones'
import { BuscadorComercio } from './calculadora/BuscadorComercio'
import type { PlaceLite, Cotizacion, PuntoFavorito, PuntoComercio } from './calculadora/types'
import { calcularRecargoZona, type RecargoZona } from '@/lib/recargoZona'
import { clasificarPuntoEnZona } from '@/lib/zonas'
import {
  interpretarEntrada,
  etiquetaPuntoManual,
  etiquetaMiUbicacion,
} from '@/lib/puntoUbicacion'

// ─── Constants ────────────────────────────────────────────────────────────────

const CACHE_PREFIX = 'dm:'
const TTL_MS = 10 * 60 * 1000
const RECENT_MAX = 6
const RECENT_TTL = 7 * 24 * 60 * 60 * 1000
const RKEY = { origen: 'recent:origen', destino: 'recent:destino' } as const
const DUPLICATE_WINDOW_MS = 60_000

// ─── Tariff ───────────────────────────────────────────────────────────────────

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

// ─── Recent places ────────────────────────────────────────────────────────────

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
  data: { origen: string; destino: string; km: number; precio: number; precioBase: number; origenCoord: google.maps.LatLngLiteral; destinoCoord: google.maps.LatLngLiteral; fuente: string; zonaOrigen?: string | null; zonaDestino?: string | null; recargoZona?: RecargoZona }
) {
  await addDoc(collection(db, 'cotizaciones'), {
    userId: uid,
    origen: data.origen,
    destino: data.destino,
    distanciaKm: parseFloat(data.km.toFixed(3)),
    precioCordobas: data.precio,
    precioBase: data.precioBase,
    origenCoord: data.origenCoord,
    destinoCoord: data.destinoCoord,
    fuente: data.fuente,
    ...(data.zonaOrigen != null && { zonaOrigen: data.zonaOrigen }),
    ...(data.zonaDestino != null && { zonaDestino: data.zonaDestino }),
    ...(data.recargoZona && { recargoZona: data.recargoZona }),
    createdAt: serverTimestamp(),
  })
}

// ─── Main component ───────────────────────────────────────────────────────────

const CalculadoraPrecio: React.FC<{ showBuscadorComercio?: boolean; solicitudBase?: string }> = ({
  showBuscadorComercio = false,
  solicitudBase = '/panel/gestor/ingresar-orden',
}) => {
  const origenInputRef = useRef<HTMLInputElement | null>(null)
  const destinoInputRef = useRef<HTMLInputElement | null>(null)
  const origenWrapRef = useRef<HTMLDivElement>(null)
  const destinoWrapRef = useRef<HTMLDivElement>(null)
  const origenACRef = useRef<google.maps.places.Autocomplete | null>(null)
  const destinoACRef = useRef<google.maps.places.Autocomplete | null>(null)

  const [origenCoord, setOrigenCoord] = useState<google.maps.LatLngLiteral | null>(null)
  const [destinoCoord, setDestinoCoord] = useState<google.maps.LatLngLiteral | null>(null)
  const [distancia, setDistancia] = useState<number | null>(null)
  const [precio, setPrecio] = useState<number | null>(null)
  const [precioBase, setPrecioBase] = useState<number | null>(null)
  const [recargoZonaInfo, setRecargoZonaInfo] = useState<RecargoZona | null>(null)
  const [loading, setLoading] = useState(false)
  const [locating, setLocating] = useState(false)
  const [error, setError] = useState<string | null>(null)
  // CALC-ERR-1: aviso SECUNDARIO y discreto — el precio ya se calculó
  // correctamente, pero la cotización no pudo guardarse en el historial.
  // Nunca debe compartir mensaje ni severidad con `error` (fallo de cálculo).
  const [avisoPersistencia, setAvisoPersistencia] = useState<string | null>(null)
  // CALC-UX-1: aviso puntual cuando lo escrito no es una dirección, ni un
  // Plus Code, ni coordenadas. No es un error de cálculo ni bloquea nada.
  const [entradaInvalida, setEntradaInvalida] = useState<string | null>(null)
  const [uid, setUid] = useState<string | null>(null)

  const [recOrigen, setRecOrigen] = useState<PlaceLite[]>([])
  const [recDestino, setRecDestino] = useState<PlaceLite[]>([])
  const [showSug, setShowSug] = useState<{ o: boolean; d: boolean }>({ o: false, d: false })

  const [cotizaciones, setCotizaciones] = useState<Cotizacion[]>([])
  const [loadingCot, setLoadingCot] = useState(true)

  const [zonas, setZonas] = useState<ZonaGeografica[]>([])
  const [zonasResult, setZonasResult] = useState<{
    zonaRetiroNombre: string | null
    zonaEntregaNombre: string | null
    macroZonaRetiroNombre: string | null
    macroZonaEntregaNombre: string | null
  } | null>(null)

  // CALC-UX-1: nombre de zona SHView de un punto. Usa el clasificador único
  // de lib/zonas.ts (zona pequeña primero, macrozona como respaldo) — acá no
  // se reimplementa ninguna lógica territorial.
  const nombreZonaDe = useCallback((coord: google.maps.LatLngLiteral): string | null => {
    if (zonas.length === 0) return null
    const zona = clasificarPuntoEnZona(coord, zonas, 'zona')
    if (zona?.nombre) return zona.nombre
    const macro = clasificarPuntoEnZona(coord, zonas, 'macrozona')
    return macro?.nombre ?? null
  }, [zonas])

  // Etiqueta visible de un punto marcado a mano (mapa, Plus Code o
  // coordenadas). Las coordenadas exactas se conservan aparte, en
  // origenCoord/destinoCoord — esto es solo presentación.
  const etiquetarManual = useCallback(
    (coord: google.maps.LatLngLiteral) => etiquetaPuntoManual(coord, nombreZonaDe(coord)),
    [nombreZonaDe],
  )

  const [puntosFavoritos, setPuntosFavoritos] = useState<PuntoFavorito[]>([])
  const [origenFavData, setOrigenFavData] = useState<PuntoFavorito | null>(null)

  const [puntosComercio, setPuntosComercio] = useState<PuntoComercio[]>([])
  const [loadingPuntosComercio, setLoadingPuntosComercio] = useState(false)
  const [selectedBuscadorComercio, setSelectedBuscadorComercio] = useState<{ uid: string; direccion: string; zonaRetiro: string | null; puntoNombre: string } | null>(null)

  // CALC-ERR-1: `uid` sigue siendo state — lo consumen el historial en
  // tiempo real y los favoritos del comercio (efectos más abajo) — pero ya
  // no se captura una sola vez al montar. Se mantiene sincronizado con la
  // sesión real vía onAuthStateChanged, con cleanup del listener.
  //
  // Este `uid` de estado es SOLO para lectura/render. La propiedad
  // (`userId`) de una escritura nueva en `cotizaciones` nunca sale de este
  // state — se resuelve de `auth.currentUser` en el momento exacto del
  // guardado (ver intentarGuardarCotizacion más abajo), para que un uid de
  // React potencialmente desactualizado nunca pueda mandar un `userId` que
  // ya no coincide con `request.auth.uid` real y dispare
  // PERMISSION_DENIED.
  useEffect(() => {
    const unsub = onAuthStateChanged(auth, (u) => setUid(u?.uid ?? null))
    return () => unsub()
  }, [])

  useEffect(() => {
    getZonasActivas().then(setZonas)
  }, [])

  // Cargar puntos de comercios para el buscador del gestor
  useEffect(() => {
    if (!showBuscadorComercio || zonas.length === 0) return
    setLoadingPuntosComercio(true)
    getDocs(collection(db, 'comercios')).then((snap) => {
      const puntos: PuntoComercio[] = []
      snap.docs.forEach((d) => {
        const data = d.data() as any
        const comercioNombre: string = data.name || data.nombre || data.companyName || d.id
        const puntosRetiro: Record<string, any> = data.puntosRetiro || {}
        Object.entries(puntosRetiro).forEach(([key, raw]: [string, any]) => {
          if (!raw?.coord?.lat || !raw?.coord?.lng) return
          const zr = clasificarOrdenCompleto(raw.coord, null, zonas)
          puntos.push({
            comercioUid: d.id,
            comercioNombre,
            puntoKey: key,
            puntoNombre: raw.nombre || key,
            direccion: raw.direccion || '',
            coord: raw.coord,
            zonaRetiro: zr.zonaRetiroNombre ?? zr.macroZonaRetiroNombre ?? null,
          })
        })
      })
      setPuntosComercio(puntos)
      setLoadingPuntosComercio(false)
    }).catch(() => setLoadingPuntosComercio(false))
  }, [showBuscadorComercio, zonas])

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
          zonaOrigen: raw.zonaOrigen ?? null,
          zonaDestino: raw.zonaDestino ?? null,
        }
      }))
      setLoadingCot(false)
    }, () => setLoadingCot(false))
    return () => unsub()
  }, [uid])

  // Favoritos del comercio
  useEffect(() => {
    if (!uid) return
    const unsub = onSnapshot(doc(db, 'comercios', uid), (snap) => {
      if (!snap.exists()) return
      const data = snap.data() as any
      const container = data?.puntosRetiro || {}
      const items: PuntoFavorito[] = []
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
            setSelectedBuscadorComercio(null)
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
    setDistancia(null); setPrecio(null); setPrecioBase(null); setRecargoZonaInfo(null)
    setError(null); setAvisoPersistencia(null); setEntradaInvalida(null); setZonasResult(null)
  }, [origenCoord, destinoCoord])

  // My location
  const useMyLocation = useCallback(() => {
    if (!navigator.geolocation) { setError('Tu navegador no soporta geolocalización.'); return }
    setLocating(true)
    navigator.geolocation.getCurrentPosition(
      async (pos) => {
        const { latitude: lat, longitude: lng } = pos.coords
        setOrigenCoord({ lat, lng })
        setOrigenFavData(null)
        setSelectedBuscadorComercio(null)
        // CALC-UX-1: la zona SHView es más reconocible que una dirección de
        // Google, y no depende de la Geocoding API (hoy sin activar). Si el
        // punto no cae en ningún polígono, etiquetaMiUbicacion() cae a
        // coordenadas legibles — nunca a un texto vacío.
        const label = etiquetaMiUbicacion({ lat, lng }, nombreZonaDe({ lat, lng }))
        if (origenInputRef.current) origenInputRef.current.value = label
        saveRecent('origen', { label, lat, lng })
        setRecOrigen(loadRecents('origen'))
        setLocating(false)
      },
      (err) => { setLocating(false); setError(err.code === 1 ? 'Permiso de ubicación denegado.' : 'No se pudo obtener tu ubicación.') },
      { enableHighAccuracy: true, timeout: 10000, maximumAge: 0 }
    )
  }, [nombreZonaDe])

  const swap = () => {
    const [oc, dc] = [origenCoord, destinoCoord]
    const [ot, dt] = [origenInputRef.current?.value || '', destinoInputRef.current?.value || '']
    setOrigenCoord(dc); setDestinoCoord(oc)
    if (origenInputRef.current) origenInputRef.current.value = dt
    if (destinoInputRef.current) destinoInputRef.current.value = ot
    setDistancia(null); setPrecio(null); setZonasResult(null)
    // Limpiar favorito de origen porque ya no es válido tras el intercambio
    setOrigenFavData(null)
    setSelectedBuscadorComercio(null)
  }

  // Devuelve true si ya existe una cotización idéntica guardada recientemente
  // CALC-UX-1: la deduplicación pasa a comparar COORDENADAS, no el texto.
  // Con el etiquetado SHView, dos puntos distintos de un mismo barrio
  // comparten label ("Bolonia"), así que comparar por texto los trataría como
  // la misma cotización y perdería la segunda. Las coordenadas son la
  // identidad real del punto; el label es solo presentación.
  //
  // Tolerancia ~1e-5° (≈1 m): absorbe el redondeo de ida y vuelta por
  // Firestore sin llegar a fusionar dos ubicaciones distintas.
  const TOLERANCIA_COORD = 1e-5
  const mismaCoord = (
    a: google.maps.LatLngLiteral | null | undefined,
    b: google.maps.LatLngLiteral | null | undefined,
  ): boolean =>
    !!a && !!b &&
    Math.abs(a.lat - b.lat) < TOLERANCIA_COORD &&
    Math.abs(a.lng - b.lng) < TOLERANCIA_COORD

  const isDuplicate = (
    origenCoordActual: google.maps.LatLngLiteral,
    destinoCoordActual: google.maps.LatLngLiteral,
  ): boolean =>
    cotizaciones.some(cot =>
      mismaCoord(cot.origenCoord, origenCoordActual) &&
      mismaCoord(cot.destinoCoord, destinoCoordActual) &&
      cot.createdAt != null &&
      Date.now() - cot.createdAt.getTime() < DUPLICATE_WINDOW_MS
    )

  // CALC-ERR-1: persistencia SECUNDARIA, aislada del cálculo crítico.
  // El precio ya fue calculado y mostrado antes de que esto se ejecute — un
  // fallo acá NUNCA debe borrar distancia/precio ni disparar el error de
  // cálculo (ver `error` más arriba). Resuelve el UID de la escritura desde
  // `auth.currentUser` en el momento exacto del guardado — nunca del `uid`
  // de estado, que puede haber quedado desactualizado — para que el
  // `userId` del documento siempre coincida con `request.auth.uid` real y
  // no dispare PERMISSION_DENIED (ver CALC-ERR-1A).
  const intentarGuardarCotizacion = async (payload: {
    origen: string
    destino: string
    km: number
    precio: number
    precioBase: number
    origenCoord: google.maps.LatLngLiteral
    destinoCoord: google.maps.LatLngLiteral
    fuente: string
    zonaOrigen?: string | null
    zonaDestino?: string | null
    recargoZona?: RecargoZona
  }) => {
    // CALC-ERR-1A, defensa adicional: firestore.rules exige que origen y
    // destino tengan contenido (size() > 0), así que un texto vacío se
    // rechazaría con permission-denied. El camino normal ya no produce
    // vacíos —MapaSeleccion siempre escribe un fallback de coordenadas—,
    // pero el historial no debe volver a depender de que ningún origen de
    // texto falle: si igualmente llega vacío, no se intenta el addDoc y se
    // informa como fallo de persistencia, nunca como error de cálculo.
    if (!payload.origen.trim() || !payload.destino.trim()) {
      console.warn('[calculadora] cotización no persistida: origen/destino vacío')
      setAvisoPersistencia('El precio fue calculado, pero no pudimos guardar esta cotización en tu historial.')
      return
    }
    const currentUser = auth.currentUser
    if (!currentUser) {
      // Sesión no disponible en el instante del guardado: no se inventa un
      // UID ni se intenta el addDoc — se trata igual que cualquier otro
      // fallo de persistencia (el precio ya calculado sigue siendo válido).
      console.warn('[calculadora] no se pudo guardar la cotización: sin sesión activa al momento de guardar')
      setAvisoPersistencia('El precio fue calculado, pero no pudimos guardar esta cotización en tu historial.')
      return
    }
    try {
      await guardarCotizacion(currentUser.uid, payload)
      setAvisoPersistencia(null)
    } catch (e) {
      console.error('[calculadora] no se pudo guardar la cotización:', e)
      setAvisoPersistencia('El precio fue calculado, pero no pudimos guardar esta cotización en tu historial.')
    }
  }

  const calcular = async () => {
    setError(null); setAvisoPersistencia(null); setDistancia(null); setPrecio(null)
    if (!origenCoord) { setError('Indicá el punto de retiro.'); return }
    if (!destinoCoord) { setError('Indicá el punto de entrega.'); return }
    if (!uid) { setError('No hay sesión activa.'); return }

    const o = `${origenCoord.lat},${origenCoord.lng}`
    const d = `${destinoCoord.lat},${destinoCoord.lng}`
    const cacheKey = `${CACHE_PREFIX}${o}-${d}`
    const origenText = origenInputRef.current?.value || ''
    const destinoText = destinoInputRef.current?.value || ''

    const aplicarPrecio = (km: number, zr: ReturnType<typeof clasificarOrdenCompleto> | null) => {
      const p = tarifa(km)
      const zonaRetiro = zr?.zonaRetiroNombre ?? zr?.macroZonaRetiroNombre ?? null
      const zonaEntrega = zr?.zonaEntregaNombre ?? zr?.macroZonaEntregaNombre ?? null
      const recargo = calcularRecargoZona(zonaRetiro, zonaEntrega)
      const precioTotal = p === -1 ? -1 : p + (recargo.aplica ? recargo.monto : 0)
      setDistancia(km)
      setPrecioBase(p)
      setRecargoZonaInfo(recargo)
      setPrecio(precioTotal)
      return { p, zonaRetiro, zonaEntrega, recargo, precioTotal }
    }

    // ── Rama caché: bloque crítico (lectura/parseo de sessionStorage) ──────
    // Un fallo acá (JSON corrupto, etc.) es del CÁLCULO — cae al camino de
    // API de abajo, comportamiento sin cambios. La persistencia ya no vive
    // dentro de este try: intentarGuardarCotizacion nunca lanza, así que un
    // fallo de guardado no puede colarse en este catch ni forzar un
    // refetch por API silencioso.
    try {
      const raw = sessionStorage.getItem(cacheKey)
      if (raw) {
        const cached: { km: number; ts: number } = JSON.parse(raw)
        if (Date.now() - cached.ts < TTL_MS) {
          const zr = zonas.length > 0 ? clasificarOrdenCompleto(origenCoord, destinoCoord, zonas) : null
          setZonasResult(zr)
          const { p, zonaRetiro, zonaEntrega, recargo, precioTotal } = aplicarPrecio(cached.km, zr)
          if (p === -1) {
            setError('La distancia supera el rango tarifario. Consultá por WhatsApp.')
          } else if (!isDuplicate(origenCoord, destinoCoord)) {
            await intentarGuardarCotizacion({ origen: origenText, destino: destinoText, km: cached.km, precio: precioTotal, precioBase: p, origenCoord, destinoCoord, fuente: 'cache', zonaOrigen: zonaRetiro, zonaDestino: zonaEntrega, recargoZona: recargo })
          }
          return
        }
        sessionStorage.removeItem(cacheKey)
      }
    } catch (e) { console.warn('[calculadora] error leyendo cache:', e) }

    // ── Rama API: bloque crítico (distancia + clasificación + tarifa) ──────
    // Mismo criterio: la persistencia quedó afuera, así que este catch solo
    // puede dispararse por un fallo real del cálculo.
    setLoading(true)
    try {
      const metros = await obtenerDistanciaMetros(o, d)
      if (!metros) { setError('No se pudo calcular la distancia. Verificá los puntos.'); return }
      const km = metros / 1000
      const zr = zonas.length > 0 ? clasificarOrdenCompleto(origenCoord, destinoCoord, zonas) : null
      setZonasResult(zr)
      const { p, zonaRetiro, zonaEntrega, recargo, precioTotal } = aplicarPrecio(km, zr)
      sessionStorage.setItem(cacheKey, JSON.stringify({ km, ts: Date.now() }))
      if (p === -1) {
        setError('La distancia supera el rango tarifario. Consultá por WhatsApp.')
      } else if (!isDuplicate(origenCoord, destinoCoord)) {
        await intentarGuardarCotizacion({ origen: origenText, destino: destinoText, km, precio: precioTotal, precioBase: p, origenCoord, destinoCoord, fuente: 'api', zonaOrigen: zonaRetiro, zonaDestino: zonaEntrega, recargoZona: recargo })
      }
    } catch (e) {
      console.error('[calculadora] error al calcular:', e)
      setError('Error al calcular. Intentá de nuevo.')
    } finally {
      setLoading(false)
    }
  }

  const limpiar = () => {
    setOrigenCoord(null); setDestinoCoord(null); setDistancia(null); setPrecio(null)
    setPrecioBase(null); setRecargoZonaInfo(null)
    setError(null); setAvisoPersistencia(null); setEntradaInvalida(null); setZonasResult(null); setOrigenFavData(null); setSelectedBuscadorComercio(null)
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
    } catch (e) { console.warn('[calculadora] error limpiando cache:', e) }
  }

  const usarCotizacion = (cot: Cotizacion) => {
    if (origenInputRef.current) origenInputRef.current.value = cot.origen
    if (destinoInputRef.current) destinoInputRef.current.value = cot.destino
    if (cot.origenCoord) setOrigenCoord(cot.origenCoord)
    if (cot.destinoCoord) setDestinoCoord(cot.destinoCoord)
    setDistancia(cot.distanciaKm); setPrecio(cot.precioCordobas)
    setPrecioBase(null); setRecargoZonaInfo(null)
    setOrigenFavData(null)
    setSelectedBuscadorComercio(null)
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
    } catch (e) { console.warn('[calculadora] error guardando draftEnvio:', e) }
    window.location.href = solicitudBase
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
        origenDireccion: selectedBuscadorComercio?.direccion || origenFavData?.direccion || '',
      }))
    } catch (e) { console.warn('[calculadora] error guardando draftEnvio:', e) }
    const url = selectedBuscadorComercio?.uid
      ? `${solicitudBase}?comercioId=${encodeURIComponent(selectedBuscadorComercio.uid)}`
      : solicitudBase
    window.location.href = url
  }

  // Favoritos para el mapa
  const favoritosMapa: FavoritoMapa[] = useMemo(() =>
    puntosFavoritos.filter(f => f.coord).map(f => ({ key: f.key, label: f.label, coord: f.coord! })),
    [puntosFavoritos]
  )

  // BUG FIX: puntosFavoritos agregado a dependencias para que el closure sea fresco
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
  }, [puntosFavoritos])

  const handleFocus = (which: 'o' | 'd') => {
    const val = which === 'o' ? origenInputRef.current?.value : destinoInputRef.current?.value
    if ((val || '').trim() === '') setShowSug(which === 'o' ? { o: true, d: false } : { o: false, d: true })
  }

  const handleInput = (which: 'o' | 'd') => {
    const val = which === 'o' ? origenInputRef.current?.value : destinoInputRef.current?.value
    setShowSug((val || '').trim() === '' ? (which === 'o' ? { o: true, d: false } : { o: false, d: true }) : { o: false, d: false })
  }

  // CALC-UX-1: entradas directas. Google Places Autocomplete (con
  // strictBounds + country 'ni') no resuelve ni Plus Codes ni coordenadas
  // escritas a mano, y la Geocoding API no está activada — así que se
  // interpretan localmente. El punto exacto queda en origenCoord/destinoCoord;
  // el texto visible pasa a ser la zona SHView correspondiente.
  const resolverEntradaDirecta = (which: 'o' | 'd'): boolean => {
    const ref = which === 'o' ? origenInputRef : destinoInputRef
    const texto = ref.current?.value?.trim() || ''
    if (!texto) return false
    const entrada = interpretarEntrada(texto)
    if (entrada.tipo === 'texto') return false

    const coord = entrada.coord
    if (which === 'o') {
      setOrigenCoord(coord)
      setOrigenFavData(null)
      setSelectedBuscadorComercio(null)
    } else {
      setDestinoCoord(coord)
    }
    const label = etiquetarManual(coord)
    if (ref.current) ref.current.value = label
    saveRecent(which === 'o' ? 'origen' : 'destino', { label, ...coord })
    if (which === 'o') setRecOrigen(loadRecents('origen'))
    else setRecDestino(loadRecents('destino'))
    setShowSug({ o: false, d: false })
    setEntradaInvalida(null)
    return true
  }

  const handleKeyDown = (e: React.KeyboardEvent<HTMLInputElement>, which?: 'o' | 'd') => {
    if (e.key === 'Escape') { setShowSug({ o: false, d: false }); return }
    if (e.key !== 'Enter' || !which) return
    const texto = (which === 'o' ? origenInputRef : destinoInputRef).current?.value?.trim() || ''
    if (!texto) return
    if (resolverEntradaDirecta(which)) { e.preventDefault(); return }
    // Texto que parece una entrada directa pero no resuelve: se avisa sin
    // romper nada. Si es una búsqueda normal, Autocomplete sigue su curso.
    if (/^[0-9+-., ]+$/.test(texto) || texto.includes('+')) {
      setEntradaInvalida('No pudimos interpretar eso. Probá una dirección, un Plus Code (4QQV+QHM) o coordenadas (12.14009, -86.28753).')
    }
  }

  const puedeCalcular = !!origenCoord && !!destinoCoord && !loading

  return (
    <div className="space-y-4">

      {/* Buscador de comercios (solo gestor) */}
      {showBuscadorComercio && (
        <div>
          <BuscadorComercio
            puntos={puntosComercio}
            loading={loadingPuntosComercio}
            onSelect={(p) => {
              setOrigenCoord(p.coord)
              setOrigenFavData(null)
              setSelectedBuscadorComercio({ uid: p.comercioUid, direccion: p.direccion || p.puntoNombre, zonaRetiro: p.zonaRetiro, puntoNombre: p.puntoNombre })
              if (origenInputRef.current) {
                origenInputRef.current.value = p.puntoNombre || p.direccion
              }
              saveRecent('origen', { label: p.puntoNombre || p.direccion, ...p.coord })
              setRecOrigen(loadRecents('origen'))
              setShowSug({ o: false, d: false })
            }}
          />
          {selectedBuscadorComercio && (
            <div className="flex items-center gap-2 -mt-2 mb-2 px-1">
              <span className="text-[11px] text-gray-500">📦 Punto de retiro:</span>
              <span className="text-[11px] font-semibold text-gray-700">{selectedBuscadorComercio.puntoNombre}</span>
              {selectedBuscadorComercio.zonaRetiro && (
                <span className="inline-flex items-center px-2 py-0.5 rounded-full bg-blue-100 text-blue-700 text-[10px] font-bold">
                  {selectedBuscadorComercio.zonaRetiro}
                </span>
              )}
            </div>
          )}
        </div>
      )}

      {/* Error crítico — el cálculo en sí falló */}
      {error && (
        <div className="bg-red-50 border border-red-200 rounded-xl px-4 py-3 text-red-600 text-[13px] font-semibold">
          ⚠️ {error}
        </div>
      )}

      {/* CALC-ERR-1: aviso secundario y discreto — el precio ya es válido y
          sigue mostrándose; solo falló guardar esta cotización en el
          historial. Deliberadamente distinto (ámbar, no rojo) del error
          crítico de arriba, y nunca bloquea "Solicitar este envío". */}
      {avisoPersistencia && (
        <div className="bg-amber-50 border border-amber-200 rounded-xl px-4 py-3 text-amber-700 text-[13px] font-medium">
          ℹ️ {avisoPersistencia}
        </div>
      )}

      {/* CALC-UX-1: entrada escrita que no es dirección, Plus Code ni
          coordenadas. Informativo, no bloquea el resto de la Calculadora. */}
      {entradaInvalida && (
        <div className="bg-amber-50 border border-amber-200 rounded-xl px-4 py-3 text-amber-700 text-[13px] font-medium">
          ℹ️ {entradaInvalida}
        </div>
      )}

      {/* Inputs + Favoritos */}
      <div className="bg-white border border-gray-200 rounded-2xl p-4 shadow-sm">
        <div className="flex gap-2.5 items-stretch">
          <div className="flex-1 flex flex-col gap-2">
            <div ref={origenWrapRef} className="relative">
              <label className="block text-[11px] font-bold uppercase tracking-wide text-[#004aad] mb-1">
                Retiro
              </label>
              <SearchInput
                inputRef={origenInputRef}
                placeholder="Dirección, Plus Code o coordenadas..."
                onFocusEmpty={() => handleFocus('o')}
                onInputChange={() => handleInput('o')}
                onKeyDown={(e) => handleKeyDown(e, 'o')}
                icon="📦"
                variant="blue"
                onClear={() => {
                  if (origenInputRef.current) origenInputRef.current.value = ''
                  setOrigenCoord(null)
                  setOrigenFavData(null)
                  setShowSug({ o: true, d: false })
                }}
                onMyLocation={useMyLocation}
                locating={locating}
              />
              {showSug.o && (
                <RecentDropdown
                  items={recOrigen}
                  onSelect={(p) => {
                    setOrigenCoord({ lat: p.lat, lng: p.lng })
                    setOrigenFavData(null)
                    if (origenInputRef.current) origenInputRef.current.value = p.label
                    setShowSug({ o: false, d: false })
                  }}
                  onClear={() => { clearRecents('origen'); setRecOrigen([]); setShowSug(s => ({ ...s, o: false })) }}
                />
              )}
            </div>

            <div ref={destinoWrapRef} className="relative">
              <label className="block text-[11px] font-bold uppercase tracking-wide text-green-700 mb-1">
                Entrega
              </label>
              <SearchInput
                inputRef={destinoInputRef}
                placeholder="Dirección, Plus Code o coordenadas..."
                onFocusEmpty={() => handleFocus('d')}
                onInputChange={() => handleInput('d')}
                onKeyDown={(e) => handleKeyDown(e, 'd')}
                icon="🏠"
                variant="green"
                onClear={() => {
                  if (destinoInputRef.current) destinoInputRef.current.value = ''
                  setDestinoCoord(null)
                  setShowSug({ o: false, d: true })
                }}
              />
              {showSug.d && (
                <RecentDropdown
                  items={recDestino}
                  onSelect={(p) => {
                    setDestinoCoord({ lat: p.lat, lng: p.lng })
                    if (destinoInputRef.current) destinoInputRef.current.value = p.label
                    setShowSug({ o: false, d: false })
                  }}
                  onClear={() => { clearRecents('destino'); setRecDestino([]); setShowSug(s => ({ ...s, d: false })) }}
                />
              )}
            </div>
          </div>

          <button
            type="button"
            onClick={swap}
            title="Intercambiar"
            className="self-center shrink-0 h-9 w-9 rounded-lg border border-gray-200 bg-white cursor-pointer text-base text-gray-500 flex items-center justify-center hover:bg-gray-50 transition-colors"
          >
            ⇅
          </button>
        </div>

        <FavoritosRetiro
          favoritos={puntosFavoritos}
          onUsarRetiro={(fav) => {
            setOrigenCoord(fav.coord || null)
            setOrigenFavData(fav)
            if (origenInputRef.current) origenInputRef.current.value = fav.nombre || fav.label
            if (fav.coord) saveRecent('origen', { label: fav.nombre || fav.label, ...fav.coord })
            setRecOrigen(loadRecents('origen'))
          }}
          onUsarEntrega={(fav) => {
            setDestinoCoord(fav.coord || null)
            if (destinoInputRef.current) destinoInputRef.current.value = fav.nombre || fav.label
            if (fav.coord) saveRecent('destino', { label: fav.nombre || fav.label, ...fav.coord })
            setRecDestino(loadRecents('destino'))
          }}
        />
      </div>

      {/* Mapa */}
      <div className="rounded-2xl overflow-hidden border border-gray-200">
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
          etiquetarPuntoManual={etiquetarManual}
          onSetOrigenInput={(d) => { if (origenInputRef.current) origenInputRef.current.value = d }}
          onSetDestinoInput={(d) => { if (destinoInputRef.current) destinoInputRef.current.value = d }}
          size="compact"
          favoritos={favoritosMapa}
          onSelectFavorito={handleSelectFavoritoMapa}
        />
      </div>

      {/* Resultado */}
      {distancia !== null && (
        <ResultadoCotizacion
          distancia={distancia}
          precio={precio}
          zonasResult={zonasResult}
          onSolicitar={solicitarActual}
          precioBase={precioBase}
          recargoZona={recargoZonaInfo}
        />
      )}

      {/* B4: ayuda discreta mientras falte un punto — no es un error. */}
      {(!origenCoord || !destinoCoord) && !error && (
        <p className="text-[13px] text-gray-500 px-1">
          Seleccioná retiro y entrega para calcular.
        </p>
      )}

      {origenCoord && destinoCoord && distancia === null && !loading && !error && (
        <p className="text-[13px] text-gray-600 px-1">
          Listo: tocá <strong className="font-semibold text-gray-800">Calcular precio</strong>.
        </p>
      )}

      {/* B5: con precio ya calculado, la acción primaria es "Solicitar este
          envío" (dentro del resumen) y el cálculo pasa a secundario, para no
          tener dos botones azules compitiendo. Si los puntos cambian, el
          efecto de reset deja distancia=null y vuelve a ser primario. */}
      <div className="flex gap-2.5">
        <button
          type="button"
          onClick={calcular}
          disabled={!puedeCalcular}
          className={`flex-1 rounded-xl py-3.5 px-5 text-[15px] transition-all ${
            !puedeCalcular
              ? 'bg-gray-100 text-gray-400 cursor-not-allowed font-extrabold'
              : distancia !== null
                ? 'border border-gray-300 bg-white text-gray-700 font-semibold cursor-pointer hover:bg-gray-50'
                : 'bg-[#004aad] text-white font-extrabold cursor-pointer hover:bg-[#003d91]'
          }`}
        >
          {loading ? 'Calculando...' : distancia !== null ? 'Recalcular' : '📏 Calcular precio'}
        </button>
        <button
          type="button"
          onClick={limpiar}
          className="px-4 py-3.5 rounded-xl border border-gray-200 bg-white text-gray-600 text-sm font-semibold cursor-pointer hover:bg-gray-50 transition-colors"
        >
          Limpiar
        </button>
      </div>

      {/* Historial */}
      <HistorialCotizaciones
        cotizaciones={cotizaciones}
        loading={loadingCot}
        onUsarDeNuevo={usarCotizacion}
        onSolicitar={solicitarEnvio}
      />

    </div>
  )
}

export default CalculadoraPrecio
