'use client'

import { useEffect, useRef, useState, useCallback } from 'react'
import { auth } from '@/fb/config'
import { getMapsLoader } from '@/lib/googleMaps'
import { onZonasSnapshot, crearZona, actualizarZona, toggleZonaActiva, eliminarZona } from '@/fb/zonas'
import { clasificarPuntoEnZona } from '@/lib/zonas'
import type { ZonaGeografica, Coord } from '@/lib/zonas'
import {
  Map,
  Plus,
  Pencil,
  Eye,
  EyeOff,
  Loader2,
  AlertCircle,
  X,
  Pentagon,
  Check,
  Satellite,
  Crosshair,
  Copy,
  Focus,
  Trash2,
} from 'lucide-react'

// ── Constantes ────────────────────────────────────────────────────────────────

const MAP_CENTER = { lat: 12.1364, lng: -86.2514 }

const COLORES_PRESET = [
  '#ef4444', '#f97316', '#eab308', '#22c55e',
  '#14b8a6', '#3b82f6', '#6366f1', '#a855f7',
]

type Mode = 'idle' | 'nueva' | 'editando'

/** Centroide del polígono (promedio de vértices) */
function polygonCentroid(poligono: Coord[]): Coord {
  const lat = poligono.reduce((s, p) => s + p.lat, 0) / poligono.length
  const lng = poligono.reduce((s, p) => s + p.lng, 0) / poligono.length
  return { lat, lng }
}

// ── Componente ────────────────────────────────────────────────────────────────

export default function ZonasPage() {

  // ── State ──────────────────────────────────────────────────────────────────
  const [zonas, setZonas] = useState<ZonaGeografica[]>([])
  const [mode, setMode] = useState<Mode>('idle')
  const [selectedId, setSelectedId] = useState<string | null>(null)   // zona en edición
  const [clickedId, setClickedId] = useState<string | null>(null)     // zona seleccionada en mapa
  const [modoTest, setModoTest] = useState(false)
  const [busqueda, setBusqueda] = useState('')
  const [filtroTipo, setFiltroTipo] = useState<'todas' | 'zona' | 'macrozona'>('todas')
  const [satelite, setSatelite] = useState(false)
  const [confirmDeleteId, setConfirmDeleteId] = useState<string | null>(null)

  // form
  const [draftNombre, setDraftNombre] = useState('')
  const [draftColor, setDraftColor] = useState('#3b82f6')
  const [draftPrioridad, setDraftPrioridad] = useState(1)
  const [draftTipo, setDraftTipo] = useState<'zona' | 'macrozona'>('zona')
  const [draftPoligono, setDraftPoligono] = useState<Coord[] | null>(null)
  const [dibujando, setDibujando] = useState(false)
  const [saving, setSaving] = useState(false)
  const [mapReady, setMapReady] = useState(false)
  const [msg, setMsg] = useState<{ type: 'success' | 'error'; text: string } | null>(null)

  // ── Google Maps refs ────────────────────────────────────────────────────────
  const containerRef = useRef<HTMLDivElement | null>(null)
  const mapRef = useRef<google.maps.Map | null>(null)
  const dmRef = useRef<any>(null)
  const overlaysRef = useRef<Record<string, google.maps.Polygon>>({})
  const labelsRef = useRef<Record<string, google.maps.Marker>>({})
  const infoWindowRef = useRef<google.maps.InfoWindow | null>(null)
  const editPolyRef = useRef<google.maps.Polygon | null>(null)
  const draftPolyRef = useRef<google.maps.Polygon | null>(null)
  const draftColorRef = useRef(draftColor)
  useEffect(() => { draftColorRef.current = draftColor }, [draftColor])

  // Refs sin stale closure en callbacks del mapa
  const zonasRef = useRef<ZonaGeografica[]>([])
  useEffect(() => { zonasRef.current = zonas }, [zonas])
  const modoTestRef = useRef(modoTest)
  useEffect(() => { modoTestRef.current = modoTest }, [modoTest])
  const modeRef = useRef(mode)
  useEffect(() => { modeRef.current = mode }, [mode])

  // Refs para scroll-to-card
  const cardRefs = useRef<Record<string, HTMLDivElement | null>>({})

  // ── Dibujo manual de polígono (WIP = work in progress) ────────────────────
  const wipRef = useRef<Coord[]>([])
  const wipPolyRef = useRef<google.maps.Polygon | null>(null)
  const wipMarkersRef = useRef<google.maps.Marker[]>([])
  const dibujandoRef = useRef(false)
  useEffect(() => { dibujandoRef.current = dibujando }, [dibujando])

  // ── Handlers forward-declared como refs (usados en InfoWindow domready) ──
  const handleEditarZonaRef = useRef<(zona: ZonaGeografica) => void>(() => {})
  const handleToggleRef = useRef<(zona: ZonaGeografica) => void>(() => {})

  // ── Inicializar mapa ────────────────────────────────────────────────────────
  useEffect(() => {
    getMapsLoader().load().then(() => {
      if (!containerRef.current || mapRef.current) return

      const map = new google.maps.Map(containerRef.current, {
        center: MAP_CENTER,
        zoom: 13,
        mapTypeControl: false,
        streetViewControl: false,
        fullscreenControl: false,
        zoomControlOptions: { position: google.maps.ControlPosition.RIGHT_CENTER },
      })
      mapRef.current = map

      // ── Helper: actualiza preview del polígono WIP ───────────────────────────
      function actualizarWip() {
        const pts = wipRef.current
        // Actualizar marcadores de vértices
        wipMarkersRef.current.forEach((m) => m.setMap(null))
        wipMarkersRef.current = pts.map((pt) =>
          new google.maps.Marker({
            position: pt, map,
            icon: { path: google.maps.SymbolPath.CIRCLE, scale: 5, fillColor: '#fff', fillOpacity: 1, strokeColor: draftColorRef.current, strokeWeight: 2 },
            clickable: false, zIndex: 20,
          })
        )
        // Actualizar polígono de preview
        if (pts.length >= 2) {
          const path = pts.map((p) => ({ lat: p.lat, lng: p.lng }))
          if (!wipPolyRef.current) {
            wipPolyRef.current = new google.maps.Polygon({
              paths: path, strokeColor: draftColorRef.current, strokeWeight: 2, strokeOpacity: 0.9,
              fillColor: draftColorRef.current, fillOpacity: 0.15, map, clickable: false, editable: false,
            })
          } else {
            wipPolyRef.current.setPath(path)
            wipPolyRef.current.setOptions({ strokeColor: draftColorRef.current, fillColor: draftColorRef.current })
          }
        } else {
          wipPolyRef.current?.setMap(null)
          wipPolyRef.current = null
        }
        // Sincronizar estado para mostrar contador en UI
        setDraftPoligono(pts.length > 0 ? [...pts] : null)
      }

      // ── CLIC DERECHO: deshacer último vértice mientras se dibuja ─────────────
      map.addListener('rightclick', () => {
        if (!dibujandoRef.current || wipRef.current.length === 0) return
        wipRef.current = wipRef.current.slice(0, -1)
        actualizarWip()
      })

      // ── CLIC EN EL MAPA: agregar vértice (dibujo) o seleccionar zona (idle) ──
      map.addListener('click', (e: google.maps.MapMouseEvent) => {
        if (!e.latLng) return

        // ── Modo dibujo: agregar vértice ──────────────────────────────────────
        if (dibujandoRef.current) {
          wipRef.current = [...wipRef.current, { lat: e.latLng.lat(), lng: e.latLng.lng() }]
          actualizarWip()
          return
        }

        // ── Modo edición: no seleccionar zonas ────────────────────────────────
        if (modeRef.current !== 'idle') return

        const coord: Coord = { lat: e.latLng.lat(), lng: e.latLng.lng() }
        const zonaGanadora = clasificarPuntoEnZona(coord, zonasRef.current)

        if (modoTestRef.current) {
          // Modo prueba: mostrar resultado sin seleccionar
          if (!infoWindowRef.current) infoWindowRef.current = new google.maps.InfoWindow()
          if (zonaGanadora) {
            infoWindowRef.current.setContent(`
              <div style="font-family:system-ui,sans-serif;padding:4px 0 2px">
                <div style="font-size:10px;font-weight:600;color:#6b7280;text-transform:uppercase;letter-spacing:.05em;margin-bottom:6px">Modo prueba</div>
                <div style="display:flex;align-items:center;gap:8px">
                  <span style="display:inline-block;width:10px;height:10px;border-radius:50%;background:${zonaGanadora.color};flex-shrink:0"></span>
                  <span style="font-size:13px;font-weight:700;color:#111827">${zonaGanadora.nombre}</span>
                </div>
                <div style="margin-top:4px;display:flex;align-items:center;gap:6px">
                  <span style="background:${zonaGanadora.tipo === 'macrozona' ? '#f5f3ff' : '#eff6ff'};color:${zonaGanadora.tipo === 'macrozona' ? '#7c3aed' : '#1d4ed8'};border:1px solid ${zonaGanadora.tipo === 'macrozona' ? '#ddd6fe' : '#bfdbfe'};border-radius:99px;padding:1px 7px;font-size:10px;font-weight:700">${zonaGanadora.tipo === 'macrozona' ? 'Macrozona' : 'Zona'}</span>
                  <span style="font-size:11px;color:#6b7280">Prioridad: ${'★'.repeat(zonaGanadora.prioridad)}${'☆'.repeat(5 - zonaGanadora.prioridad)}</span>
                </div>
              </div>
            `)
          } else {
            infoWindowRef.current.setContent(`
              <div style="font-family:system-ui,sans-serif;padding:4px 0 2px">
                <div style="font-size:10px;font-weight:600;color:#6b7280;text-transform:uppercase;letter-spacing:.05em;margin-bottom:6px">Modo prueba</div>
                <div style="font-size:12px;color:#6b7280">Este punto no pertenece<br>a ninguna zona activa.</div>
              </div>
            `)
          }
          infoWindowRef.current.setPosition(e.latLng)
          infoWindowRef.current.open(map)
          return
        }

        if (!zonaGanadora) {
          infoWindowRef.current?.close()
          setClickedId(null)
          return
        }

        setClickedId(zonaGanadora.id)

        // Scroll a la tarjeta de la lista
        const card = cardRefs.current[zonaGanadora.id]
        if (card) card.scrollIntoView({ behavior: 'smooth', block: 'nearest' })

        // Mostrar InfoWindow con acciones
        abrirInfoWindow(zonaGanadora, e.latLng, map)
      })

      // DrawingManager ya no se usa para polígonos (reemplazado por dibujo manual).
      // Se conserva inicializado por si se necesita en el futuro para otras formas.

      setMapReady(true)
    })
  }, [])

  // ── Función para abrir InfoWindow con botones ────────────────────────────────
  function abrirInfoWindow(zona: ZonaGeografica, pos: google.maps.LatLng, map: google.maps.Map) {
    if (!infoWindowRef.current) infoWindowRef.current = new google.maps.InfoWindow()

    const badge = zona.activa
      ? `<span style="background:#f0fdf4;color:#16a34a;border:1px solid #bbf7d0;border-radius:99px;padding:1px 8px;font-size:10px;font-weight:700">Activa</span>`
      : `<span style="background:#f3f4f6;color:#6b7280;border:1px solid #d1d5db;border-radius:99px;padding:1px 8px;font-size:10px;font-weight:700">Inactiva</span>`

    infoWindowRef.current.setContent(`
      <div style="font-family:system-ui,sans-serif;padding:2px 0 4px;min-width:180px">
        <div style="display:flex;align-items:center;gap:8px;margin-bottom:6px">
          <span style="display:inline-block;width:12px;height:12px;border-radius:50%;background:${zona.color};flex-shrink:0"></span>
          <strong style="font-size:13px;color:#111827;flex:1">${zona.nombre}</strong>
        </div>
        <div style="display:flex;align-items:center;gap:6px;margin-bottom:10px;flex-wrap:wrap">
          ${badge}
          <span style="background:${zona.tipo === 'macrozona' ? '#f5f3ff' : '#eff6ff'};color:${zona.tipo === 'macrozona' ? '#7c3aed' : '#1d4ed8'};border:1px solid ${zona.tipo === 'macrozona' ? '#ddd6fe' : '#bfdbfe'};border-radius:99px;padding:1px 8px;font-size:10px;font-weight:700">${zona.tipo === 'macrozona' ? 'Macrozona' : 'Zona'}</span>
          <span style="font-size:11px;color:#f59e0b;letter-spacing:1px" title="Prioridad ${zona.prioridad}/5">${'★'.repeat(zona.prioridad)}${'☆'.repeat(5 - zona.prioridad)}</span>
        </div>
        <div style="display:flex;gap:5px;flex-wrap:wrap">
          <button id="iw-btn-edit" style="cursor:pointer;background:#004aad;color:#fff;border:none;border-radius:8px;padding:5px 10px;font-size:11px;font-weight:600">✏ Editar</button>
          <button id="iw-btn-toggle" style="cursor:pointer;background:#f3f4f6;color:#374151;border:1px solid #d1d5db;border-radius:8px;padding:5px 10px;font-size:11px;font-weight:600">${zona.activa ? '⊘ Desactivar' : '✓ Activar'}</button>
          <button id="iw-btn-center" style="cursor:pointer;background:#f3f4f6;color:#374151;border:1px solid #d1d5db;border-radius:8px;padding:5px 10px;font-size:11px;font-weight:600">⊙ Centrar</button>
          <button id="iw-btn-dup" style="cursor:pointer;background:#f3f4f6;color:#374151;border:1px solid #d1d5db;border-radius:8px;padding:5px 10px;font-size:11px;font-weight:600">⎘ Duplicar</button>
          <button id="iw-btn-del" style="cursor:pointer;background:#fff1f2;color:#ef4444;border:1px solid #fecaca;border-radius:8px;padding:5px 10px;font-size:11px;font-weight:600">🗑 Eliminar</button>
        </div>
      </div>
    `)
    infoWindowRef.current.setPosition(pos)
    infoWindowRef.current.open(map)

    google.maps.event.addListenerOnce(infoWindowRef.current, 'domready', () => {
      document.getElementById('iw-btn-edit')?.addEventListener('click', () => {
        infoWindowRef.current?.close()
        handleEditarZonaRef.current(zona)
      })
      document.getElementById('iw-btn-toggle')?.addEventListener('click', () => {
        infoWindowRef.current?.close()
        handleToggleRef.current(zona)
      })
      document.getElementById('iw-btn-center')?.addEventListener('click', () => {
        if (!mapRef.current) return
        const bounds = new google.maps.LatLngBounds()
        zona.poligono.forEach((p) => bounds.extend({ lat: p.lat, lng: p.lng }))
        mapRef.current.fitBounds(bounds, 60)
      })
      document.getElementById('iw-btn-dup')?.addEventListener('click', () => {
        infoWindowRef.current?.close()
        handleDuplicarZona(zona)
      })
      document.getElementById('iw-btn-del')?.addEventListener('click', () => {
        infoWindowRef.current?.close()
        setConfirmDeleteId(zona.id)
        // Scroll a la tarjeta para que vea la confirmación
        cardRefs.current[zona.id]?.scrollIntoView({ behavior: 'smooth', block: 'nearest' })
      })
    })
  }

  // ── Satélite ─────────────────────────────────────────────────────────────────
  useEffect(() => {
    if (!mapRef.current) return
    mapRef.current.setMapTypeId(satelite ? google.maps.MapTypeId.HYBRID : google.maps.MapTypeId.ROADMAP)
  }, [satelite, mapReady])

  // ── Color del draft al cambiar selección de color ─────────────────────────────
  useEffect(() => {
    draftPolyRef.current?.setOptions({ strokeColor: draftColor, fillColor: draftColor })
    editPolyRef.current?.setOptions({ strokeColor: draftColor, fillColor: draftColor })
  }, [draftColor])

  // ── Suscribir a zonas ─────────────────────────────────────────────────────────
  useEffect(() => {
    const unsub = onZonasSnapshot((z) => setZonas(z))
    return () => unsub()
  }, [])

  // ── Actualizar overlays + etiquetas en el mapa ────────────────────────────────
  useEffect(() => {
    if (!mapReady || !mapRef.current) return
    const map = mapRef.current
    const currentIds = new Set(zonas.map((z) => z.id))

    // Eliminar overlays y etiquetas de zonas borradas
    Object.keys(overlaysRef.current).forEach((id) => {
      if (!currentIds.has(id)) {
        overlaysRef.current[id].setMap(null)
        delete overlaysRef.current[id]
      }
    })
    Object.keys(labelsRef.current).forEach((id) => {
      if (!currentIds.has(id)) {
        labelsRef.current[id].setMap(null)
        delete labelsRef.current[id]
      }
    })

    zonas.forEach((zona) => {
      if (zona.id === selectedId && mode === 'editando') return

      // Visibilidad según filtro de tipo activo en el panel lateral
      const visiblePorFiltro = filtroTipo === 'todas' || zona.tipo === filtroTipo
      const mapaTarget = visiblePorFiltro ? map : null

      const isHighlighted = zona.id === clickedId
      const hasSelection = clickedId !== null

      const strokeOpacity = zona.activa
        ? isHighlighted ? 1 : hasSelection ? 0.25 : 0.8
        : 0.2
      const fillOpacity = zona.activa
        ? isHighlighted ? 0.35 : hasSelection ? 0.04 : 0.15
        : 0.03
      const strokeWeight = isHighlighted ? 4 : 2

      const existing = overlaysRef.current[zona.id]
      if (existing) {
        existing.setOptions({
          paths: zona.poligono.map((p) => ({ lat: p.lat, lng: p.lng })),
          strokeColor: zona.color,
          fillColor: zona.color,
          strokeOpacity,
          fillOpacity,
          strokeWeight,
          map: mapaTarget,
        })
      } else {
        // Polígonos NO clickables — el clic se maneja a nivel de mapa
        const poly = new google.maps.Polygon({
          paths: zona.poligono.map((p) => ({ lat: p.lat, lng: p.lng })),
          strokeColor: zona.color,
          strokeWeight,
          strokeOpacity,
          fillColor: zona.color,
          fillOpacity,
          map: mapaTarget,
          editable: false,
          clickable: false, // ← intencional: toda la selección pasa por map.click
        })
        overlaysRef.current[zona.id] = poly
      }

      // Etiqueta de nombre en el centroide
      const centro = polygonCentroid(zona.poligono)
      const existingLabel = labelsRef.current[zona.id]
      if (existingLabel) {
        existingLabel.setOptions({
          position: centro,
          label: {
            text: zona.nombre,
            color: zona.activa ? zona.color : '#9ca3af',
            fontWeight: isHighlighted ? '800' : '600',
            fontSize: isHighlighted ? '12px' : '11px',
          },
          opacity: zona.activa ? (hasSelection && !isHighlighted ? 0.4 : 1) : 0.4,
        })
        existingLabel.setMap(mapaTarget)
      } else {
        const label = new google.maps.Marker({
          position: centro,
          map: mapaTarget,
          label: {
            text: zona.nombre,
            color: zona.activa ? zona.color : '#9ca3af',
            fontWeight: '600',
            fontSize: '11px',
          },
          icon: { path: google.maps.SymbolPath.CIRCLE, scale: 0 },
          clickable: false,
          zIndex: 10,
        })
        labelsRef.current[zona.id] = label
      }
    })
  }, [zonas, mapReady, mode, selectedId, clickedId, filtroTipo])

  // ── Handlers ─────────────────────────────────────────────────────────────────

  const limpiarDraft = useCallback(() => {
    if (draftPolyRef.current) { draftPolyRef.current.setMap(null); draftPolyRef.current = null }
    if (editPolyRef.current) { const _p = editPolyRef.current; editPolyRef.current = null; try { _p.setEditable(false); _p.getPath().clear(); } catch {} _p.setMap(null) }
    // Limpiar WIP de dibujo manual
    wipRef.current = []
    wipPolyRef.current?.setMap(null); wipPolyRef.current = null
    wipMarkersRef.current.forEach((m) => m.setMap(null)); wipMarkersRef.current = []
    setDibujando(false)
    setDraftPoligono(null)
    setDraftNombre('')
    setDraftColor('#3b82f6')
    setDraftPrioridad(1)
    setDraftTipo('zona')
    setSelectedId(null)
    setMsg(null)
  }, [])

  const handleNuevaZona = useCallback(() => {
    limpiarDraft()
    setClickedId(null)
    infoWindowRef.current?.close()
    setMode('nueva')
  }, [limpiarDraft])

  const handleEditarZona = useCallback((zona: ZonaGeografica) => {
    limpiarDraft()
    setClickedId(null)
    infoWindowRef.current?.close()
    setSelectedId(zona.id)
    setDraftNombre(zona.nombre)
    setDraftColor(zona.color)
    setDraftPrioridad(zona.prioridad)
    setDraftTipo(zona.tipo ?? 'zona')

    // Eliminar el overlay del ref para que al volver a idle se cree uno fresco (sin estado residual)
    if (overlaysRef.current[zona.id]) { overlaysRef.current[zona.id].setMap(null); delete overlaysRef.current[zona.id] }
    if (labelsRef.current[zona.id]) { labelsRef.current[zona.id].setMap(null); delete labelsRef.current[zona.id] }

    if (mapRef.current) {
      const poly = new google.maps.Polygon({
        paths: zona.poligono.map((p) => ({ lat: p.lat, lng: p.lng })),
        strokeColor: zona.color, strokeWeight: 3, fillColor: zona.color, fillOpacity: 0.3,
        map: mapRef.current, editable: true, clickable: true,
      })
      // Clic derecho sobre un vértice → lo elimina directamente (mínimo 3)
      poly.addListener('rightclick', (e: any) => {
        if (e.vertex === undefined) return
        const path = poly.getPath()
        if (path.getLength() <= 3) return // no se puede quedar con menos de 3
        path.removeAt(e.vertex)
      })
      editPolyRef.current = poly
      const bounds = new google.maps.LatLngBounds()
      zona.poligono.forEach((p) => bounds.extend({ lat: p.lat, lng: p.lng }))
      mapRef.current.fitBounds(bounds, 60)
    }
    setMode('editando')
  }, [limpiarDraft])

  // Mantener ref actualizado para el InfoWindow
  handleEditarZonaRef.current = handleEditarZona

  const handleCancelar = useCallback(() => {
    // El overlay fue eliminado del ref al entrar a editar; el efecto de overlays
    // lo recreará limpio (sin handles) cuando mode vuelva a 'idle'.
    limpiarDraft()
    setMode('idle')
  }, [limpiarDraft])

  const handleStartDraw = useCallback(() => {
    // Limpiar WIP anterior
    wipRef.current = []
    wipPolyRef.current?.setMap(null); wipPolyRef.current = null
    wipMarkersRef.current.forEach((m) => m.setMap(null)); wipMarkersRef.current = []
    if (draftPolyRef.current) { draftPolyRef.current.setMap(null); draftPolyRef.current = null }
    setDraftPoligono(null)
    setDibujando(true)
  }, [])

  const completarDibujo = useCallback(() => {
    const coords = wipRef.current
    if (coords.length < 3) return
    // Limpiar markers y preview WIP
    wipMarkersRef.current.forEach((m) => m.setMap(null)); wipMarkersRef.current = []
    wipPolyRef.current?.setMap(null); wipPolyRef.current = null
    wipRef.current = []
    // Dibujar polígono final
    if (draftPolyRef.current) draftPolyRef.current.setMap(null)
    if (mapRef.current) {
      draftPolyRef.current = new google.maps.Polygon({
        paths: coords.map((c) => ({ lat: c.lat, lng: c.lng })),
        strokeColor: draftColorRef.current, strokeWeight: 2,
        fillColor: draftColorRef.current, fillOpacity: 0.3,
        map: mapRef.current, editable: false, clickable: false,
      })
    }
    setDraftPoligono(coords)
    setDibujando(false)
  }, [])

  const handleGuardar = useCallback(async () => {
    if (!draftNombre.trim()) {
      setMsg({ type: 'error', text: 'El nombre de la zona es obligatorio.' })
      return
    }
    // Validar nombre duplicado
    const nombreDup = zonas.find(
      (z) => z.nombre.trim().toLowerCase() === draftNombre.trim().toLowerCase() && z.id !== selectedId
    )
    if (nombreDup) {
      setMsg({ type: 'error', text: `Ya existe una zona con el nombre "${draftNombre.trim()}".` })
      return
    }

    // Leer el polígono del editable ANTES de removerlo del mapa
    let finalPoligono: Coord[] | null = null
    if (mode === 'editando' && editPolyRef.current) {
      const path = editPolyRef.current.getPath()
      finalPoligono = []
      for (let i = 0; i < path.getLength(); i++) {
        const pt = path.getAt(i)
        finalPoligono.push({ lat: pt.lat(), lng: pt.lng() })
      }
    } else {
      finalPoligono = draftPoligono
    }

    if (!finalPoligono || finalPoligono.length < 3) {
      setMsg({ type: 'error', text: 'Dibujá el polígono antes de guardar (mínimo 3 vértices).' })
      return
    }

    // ── Limpiar el polígono editable del mapa ANTES del await ─────────────────
    // Firestore dispara el onSnapshot local al mismo tiempo que resuelve el await,
    // por lo que si limpiamos después, el efecto de overlays ya corrió con el
    // polígono editable (y sus vertex handles) todavía en el mapa.
    if (draftPolyRef.current) { draftPolyRef.current.setMap(null); draftPolyRef.current = null }
    if (editPolyRef.current) { const _p = editPolyRef.current; editPolyRef.current = null; try { _p.setEditable(false); _p.getPath().clear(); } catch {} _p.setMap(null) }

    try {
      setSaving(true); setMsg(null)
      const uid = auth.currentUser?.uid ?? ''
      if (mode === 'nueva') {
        await crearZona({ nombre: draftNombre.trim(), color: draftColor, poligono: finalPoligono, activa: true, prioridad: draftPrioridad, tipo: draftTipo }, uid)
        setMsg({ type: 'success', text: `${draftTipo === 'macrozona' ? 'Macrozona' : 'Zona'} "${draftNombre.trim()}" creada.` })
      } else if (mode === 'editando' && selectedId) {
        await actualizarZona(selectedId, { nombre: draftNombre.trim(), color: draftColor, poligono: finalPoligono, prioridad: draftPrioridad, tipo: draftTipo })
        setMsg({ type: 'success', text: `${draftTipo === 'macrozona' ? 'Macrozona' : 'Zona'} "${draftNombre.trim()}" actualizada.` })
      }
      setDibujando(false); setDraftPoligono(null); setDraftNombre(''); setDraftColor('#3b82f6')
      setDraftPrioridad(1); setDraftTipo('zona'); setSelectedId(null); setMode('idle')
    } catch (err) {
      console.error(err)
      setMsg({ type: 'error', text: 'No se pudo guardar la zona. Intentá de nuevo.' })
    } finally {
      setSaving(false)
    }
  }, [mode, draftNombre, draftColor, draftPrioridad, draftTipo, draftPoligono, selectedId, zonas])

  const handleToggle = useCallback(async (zona: ZonaGeografica) => {
    try { await toggleZonaActiva(zona.id, !zona.activa) } catch (err) { console.error(err) }
  }, [])
  handleToggleRef.current = handleToggle

  const handleDuplicarZona = useCallback(async (zona: ZonaGeografica) => {
    try {
      const uid = auth.currentUser?.uid ?? ''
      const nuevoNombre = `${zona.nombre} (copia)`
      await crearZona({
        nombre: nuevoNombre, color: zona.color,
        poligono: zona.poligono, activa: false, prioridad: zona.prioridad, tipo: zona.tipo,
      }, uid)
    } catch (err) { console.error(err) }
  }, [])

  const handleEliminar = useCallback(async (zona: ZonaGeografica) => {
    try {
      infoWindowRef.current?.close()
      // Limpiar overlay del mapa
      overlaysRef.current[zona.id]?.setMap(null)
      delete overlaysRef.current[zona.id]
      labelsRef.current[zona.id]?.setMap(null)
      delete labelsRef.current[zona.id]
      if (clickedId === zona.id) setClickedId(null)
      await eliminarZona(zona.id)
    } catch (err) { console.error(err) }
    finally { setConfirmDeleteId(null) }
  }, [clickedId])

  const centrarEnZona = useCallback((zona: ZonaGeografica) => {
    if (!mapRef.current) return
    const bounds = new google.maps.LatLngBounds()
    zona.poligono.forEach((p) => bounds.extend({ lat: p.lat, lng: p.lng }))
    mapRef.current.fitBounds(bounds, 60)
  }, [])

  const handleClickCard = useCallback((zona: ZonaGeografica) => {
    if (mode !== 'idle') return
    setClickedId(zona.id)
    centrarEnZona(zona)
    if (mapRef.current) {
      const centro = polygonCentroid(zona.poligono)
      const latLng = new google.maps.LatLng(centro.lat, centro.lng)
      abrirInfoWindow(zona, latLng, mapRef.current)
    }
  }, [mode, centrarEnZona])

  // ── UI helpers ────────────────────────────────────────────────────────────────

  const zonaSeleccionada = zonas.find((z) => z.id === selectedId)
  const puedeGuardar = draftNombre.trim().length > 0 &&
    (mode === 'editando' || (draftPoligono !== null && draftPoligono.length >= 3))
  const zonasFiltradas = zonas
    .filter((z) => z.nombre.toLowerCase().includes(busqueda.toLowerCase()))
    .filter((z) => filtroTipo === 'todas' || z.tipo === filtroTipo)

  // ── Render ─────────────────────────────────────────────────────────────────────

  return (
    <div className="flex h-full min-h-0 gap-4">

      {/* ── Panel izquierdo ─────────────────────────────────────────────────── */}
      <div className="flex w-64 shrink-0 flex-col gap-2.5">

        {/* Header */}
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-2">
            <Map size={18} className="text-[#004aad]" />
            <h1 className="text-base font-bold text-gray-900">Zonas</h1>
            <span className="inline-flex items-center rounded-full bg-gray-100 px-2 py-0.5 text-xs font-semibold text-gray-600">
              {zonas.length}
            </span>
          </div>
          <button
            onClick={handleNuevaZona}
            disabled={mode !== 'idle'}
            className="flex items-center gap-1 rounded-xl bg-[#004aad] px-2.5 py-1.5 text-xs font-semibold text-white shadow-sm transition hover:bg-[#003a8c] disabled:opacity-50 disabled:cursor-not-allowed"
          >
            <Plus size={13} />
            Nueva
          </button>
        </div>

        {/* Buscador */}
        <input
          type="text"
          value={busqueda}
          onChange={(e) => setBusqueda(e.target.value)}
          placeholder="Buscar zona…"
          className="w-full rounded-xl border border-gray-200 bg-white px-3 py-2 text-xs outline-none focus:border-[#004aad]"
        />

        {/* Filtro por tipo */}
        <div className="flex gap-1">
          {(['todas', 'zona', 'macrozona'] as const).map((t) => (
            <button
              key={t}
              onClick={() => setFiltroTipo(t)}
              className={`flex-1 rounded-lg border px-2 py-1 text-[11px] font-semibold transition ${
                filtroTipo === t
                  ? t === 'macrozona'
                    ? 'border-purple-500 bg-purple-500 text-white'
                    : t === 'zona'
                    ? 'border-blue-500 bg-blue-500 text-white'
                    : 'border-[#004aad] bg-[#004aad] text-white'
                  : 'border-gray-200 bg-white text-gray-500 hover:border-gray-300'
              }`}
            >
              {t === 'todas' ? 'Todas' : t === 'zona' ? 'Zonas' : 'Macro'}
            </button>
          ))}
        </div>

        {/* Lista */}
        <div className="flex flex-col gap-1.5 overflow-y-auto">
          {zonas.length === 0 && (
            <div className="rounded-2xl border border-dashed border-gray-200 bg-white p-6 text-center">
              <Pentagon size={24} className="mx-auto mb-2 text-gray-300" />
              <p className="text-xs text-gray-500">No hay zonas creadas.</p>
            </div>
          )}

          {zonasFiltradas.map((zona) => (
            <div
              key={zona.id}
              ref={(el) => { cardRefs.current[zona.id] = el }}
              onClick={() => handleClickCard(zona)}
              className={`cursor-pointer rounded-xl border bg-white px-3 py-2.5 shadow-sm transition ${
                clickedId === zona.id
                  ? 'border-[#004aad] ring-1 ring-[#004aad]/20 bg-blue-50/30'
                  : 'border-gray-200 hover:border-gray-300'
              } ${mode !== 'idle' ? 'pointer-events-none opacity-50' : ''}`}
            >
              <div className="flex items-center gap-2">
                <div className="h-3 w-3 shrink-0 rounded-full" style={{ backgroundColor: zona.color }} />
                <p className="min-w-0 flex-1 truncate text-xs font-semibold text-gray-900">{zona.nombre}</p>
                <span className={`shrink-0 rounded-full px-1.5 py-0.5 text-[9px] font-bold ring-1 ${
                  zona.tipo === 'macrozona'
                    ? 'bg-purple-50 text-purple-600 ring-purple-200'
                    : 'bg-blue-50 text-blue-600 ring-blue-200'
                }`}>
                  {zona.tipo === 'macrozona' ? 'Macro' : 'Zona'}
                </span>
                <span className="shrink-0 text-[10px] font-bold text-amber-500">{'★'.repeat(zona.prioridad)}</span>
                <span className={`shrink-0 h-1.5 w-1.5 rounded-full ${zona.activa ? 'bg-green-500' : 'bg-gray-300'}`} title={zona.activa ? 'Activa' : 'Inactiva'} />
              </div>

              <div className="mt-1.5 flex items-center gap-1">
                <button
                  onClick={(e) => { e.stopPropagation(); handleEditarZona(zona) }}
                  disabled={mode !== 'idle'}
                  className="flex items-center gap-1 rounded-lg border border-gray-200 px-2 py-1 text-[11px] font-medium text-gray-600 transition hover:bg-gray-50 disabled:opacity-40 disabled:cursor-not-allowed"
                >
                  <Pencil size={11} /> Editar
                </button>
                <button
                  onClick={(e) => { e.stopPropagation(); handleToggle(zona) }}
                  disabled={mode !== 'idle'}
                  className="flex items-center gap-1 rounded-lg border border-gray-200 px-2 py-1 text-[11px] font-medium text-gray-600 transition hover:bg-gray-50 disabled:opacity-40 disabled:cursor-not-allowed"
                >
                  {zona.activa ? <EyeOff size={11} /> : <Eye size={11} />}
                  {zona.activa ? 'Desact.' : 'Activar'}
                </button>
                <button
                  onClick={(e) => { e.stopPropagation(); handleDuplicarZona(zona) }}
                  disabled={mode !== 'idle'}
                  title="Duplicar zona"
                  className="flex items-center rounded-lg border border-gray-200 px-2 py-1 text-[11px] font-medium text-gray-600 transition hover:bg-gray-50 disabled:opacity-40 disabled:cursor-not-allowed"
                >
                  <Copy size={11} />
                </button>

                {/* Eliminar con confirmación inline */}
                {confirmDeleteId === zona.id ? (
                  <span className="flex items-center gap-1 ml-auto">
                    <button
                      onClick={(e) => { e.stopPropagation(); handleEliminar(zona) }}
                      className="rounded-lg bg-red-500 px-2 py-1 text-[11px] font-semibold text-white transition hover:bg-red-600"
                    >
                      Confirmar
                    </button>
                    <button
                      onClick={(e) => { e.stopPropagation(); setConfirmDeleteId(null) }}
                      className="rounded-lg border border-gray-200 px-2 py-1 text-[11px] font-medium text-gray-500 transition hover:bg-gray-50"
                    >
                      No
                    </button>
                  </span>
                ) : (
                  <button
                    onClick={(e) => { e.stopPropagation(); setConfirmDeleteId(zona.id) }}
                    disabled={mode !== 'idle'}
                    title="Eliminar zona"
                    className="ml-auto flex items-center rounded-lg border border-red-100 px-2 py-1 text-[11px] font-medium text-red-400 transition hover:bg-red-50 hover:text-red-600 disabled:opacity-40 disabled:cursor-not-allowed"
                  >
                    <Trash2 size={11} />
                  </button>
                )}
              </div>
            </div>
          ))}

          {busqueda && zonasFiltradas.length === 0 && (
            <p className="py-4 text-center text-xs text-gray-400">Sin resultados para "{busqueda}"</p>
          )}
        </div>
      </div>

      {/* ── Panel derecho: formulario + mapa ────────────────────────────────── */}
      <div className="relative flex min-h-0 flex-1 flex-col gap-3">

        {/* Formulario */}
        {mode !== 'idle' && (
          <div className="rounded-2xl border border-gray-200 bg-white p-4 shadow-sm">
            <div className="mb-3 flex items-center justify-between">
              <h2 className="text-sm font-bold text-gray-900">
                {mode === 'nueva' ? 'Nueva zona' : `Editando: ${zonaSeleccionada?.nombre ?? ''}`}
              </h2>
              <button onClick={handleCancelar} className="flex items-center gap-1 rounded-lg border border-gray-200 bg-white px-2 py-1.5 text-xs font-medium text-gray-600 transition hover:bg-gray-50">
                <X size={12} /> Cancelar
              </button>
            </div>

            <div className="flex flex-wrap items-end gap-4">
              {/* Nombre */}
              <div className="min-w-[160px] flex-1">
                <label className="mb-1 block text-xs font-medium text-gray-700">
                  Nombre <span className="text-red-500">*</span>
                </label>
                <input
                  type="text"
                  value={draftNombre}
                  onChange={(e) => setDraftNombre(e.target.value)}
                  placeholder="Ej: Zona Norte"
                  className="w-full rounded-lg border border-gray-200 bg-white px-3 py-2 text-sm outline-none focus:border-[#004aad]"
                />
              </div>

              {/* Prioridad */}
              <div>
                <label className="mb-1 block text-xs font-medium text-gray-700">
                  Prioridad <span className="font-normal text-gray-400">(5 = máxima)</span>
                </label>
                <div className="flex gap-1">
                  {[1, 2, 3, 4, 5].map((n) => (
                    <button
                      key={n}
                      type="button"
                      onClick={() => setDraftPrioridad(n)}
                      className={`h-8 w-8 rounded-lg border text-xs font-bold transition ${
                        draftPrioridad === n
                          ? 'border-[#004aad] bg-[#004aad] text-white'
                          : 'border-gray-200 bg-white text-gray-600 hover:border-gray-300 hover:bg-gray-50'
                      }`}
                    >
                      {n}
                    </button>
                  ))}
                </div>
              </div>

              {/* Tipo */}
              <div>
                <label className="mb-1 block text-xs font-medium text-gray-700">Tipo</label>
                <div className="flex gap-1">
                  <button
                    type="button"
                    onClick={() => setDraftTipo('zona')}
                    className={`rounded-lg border px-3 py-1.5 text-xs font-semibold transition ${
                      draftTipo === 'zona'
                        ? 'border-blue-500 bg-blue-500 text-white'
                        : 'border-gray-200 bg-white text-gray-600 hover:border-gray-300'
                    }`}
                  >
                    Zona
                  </button>
                  <button
                    type="button"
                    onClick={() => setDraftTipo('macrozona')}
                    className={`rounded-lg border px-3 py-1.5 text-xs font-semibold transition ${
                      draftTipo === 'macrozona'
                        ? 'border-purple-500 bg-purple-500 text-white'
                        : 'border-gray-200 bg-white text-gray-600 hover:border-gray-300'
                    }`}
                  >
                    Macrozona
                  </button>
                </div>
              </div>

              {/* Color */}
              <div>
                <label className="mb-1 block text-xs font-medium text-gray-700">Color</label>
                <div className="flex items-center gap-1.5">
                  {COLORES_PRESET.map((c) => (
                    <button
                      key={c}
                      onClick={() => setDraftColor(c)}
                      className={`h-6 w-6 rounded-full border-2 transition ${draftColor === c ? 'border-gray-800 scale-110' : 'border-transparent'}`}
                      style={{ backgroundColor: c }}
                    />
                  ))}
                  <input type="color" value={draftColor} onChange={(e) => setDraftColor(e.target.value)} className="h-6 w-6 cursor-pointer rounded border border-gray-200" />
                </div>
              </div>
            </div>

            {/* Polígono */}
            <div className="mt-3 flex flex-wrap items-center gap-2">
              {mode === 'nueva' && !dibujando && (
                <button
                  onClick={handleStartDraw}
                  className="flex items-center gap-1.5 rounded-xl bg-gray-900 px-3 py-2 text-xs font-semibold text-white transition hover:bg-gray-700"
                >
                  <Pentagon size={13} />
                  {draftPoligono ? 'Redibujar polígono' : 'Dibujar polígono'}
                </button>
              )}
              {mode === 'nueva' && dibujando && (
                <>
                  <span className="flex items-center gap-1.5 rounded-xl border border-blue-200 bg-blue-50 px-3 py-2 text-xs font-semibold text-blue-700">
                    <Pentagon size={13} />
                    {draftPoligono && draftPoligono.length > 0 ? `${draftPoligono.length} vértices` : 'Haz clic para dibujar'}
                  </span>
                  {draftPoligono && draftPoligono.length >= 3 && (
                    <button
                      onClick={completarDibujo}
                      className="flex items-center gap-1.5 rounded-xl bg-green-600 px-3 py-2 text-xs font-semibold text-white transition hover:bg-green-700"
                    >
                      <Check size={13} /> Completar
                    </button>
                  )}
                  <button
                    onClick={handleStartDraw}
                    className="flex items-center gap-1 rounded-xl border border-gray-200 px-2.5 py-2 text-xs font-medium text-gray-500 transition hover:bg-gray-50"
                    title="Borrar y empezar de nuevo"
                  >
                    <X size={12} /> Reiniciar
                  </button>
                </>
              )}
              {mode === 'editando' && <p className="text-xs text-gray-500">Arrastrá los vértices del polígono para editar la forma.</p>}
              {draftPoligono && !dibujando && mode === 'nueva' && (
                <span className="flex items-center gap-1 text-xs text-green-700">
                  <Check size={13} /> {draftPoligono.length} vértices
                </span>
              )}
            </div>

            {msg && (
              <div className={`mt-3 flex items-center gap-2 rounded-lg px-3 py-2 text-xs ${msg.type === 'error' ? 'border border-red-200 bg-red-50 text-red-700' : 'border border-green-200 bg-green-50 text-green-700'}`}>
                <AlertCircle size={13} /> {msg.text}
              </div>
            )}

            <div className="mt-4 flex justify-end">
              <button
                onClick={handleGuardar}
                disabled={saving || !puedeGuardar}
                className="flex items-center gap-2 rounded-xl bg-[#004aad] px-5 py-2.5 text-sm font-semibold text-white shadow-sm transition hover:bg-[#003a8c] disabled:opacity-50 disabled:cursor-not-allowed"
              >
                {saving && <Loader2 size={14} className="animate-spin" />}
                {saving ? 'Guardando…' : mode === 'nueva' ? 'Crear zona' : 'Guardar cambios'}
              </button>
            </div>
          </div>
        )}

        {/* Mapa */}
        <div className="relative min-h-0 flex-1 overflow-hidden rounded-2xl border border-gray-200 shadow-sm">
          {!mapReady && (
            <div className="absolute inset-0 z-10 flex items-center justify-center bg-gray-50">
              <div className="flex items-center gap-2 text-sm text-gray-500">
                <Loader2 size={16} className="animate-spin" /> Cargando mapa…
              </div>
            </div>
          )}
          <div ref={containerRef} className="h-full w-full" />

          {/* Controles flotantes */}
          <div className="absolute left-3 top-3 z-10 flex gap-2">
            {/* Toggle satélite */}
            <button
              onClick={() => setSatelite((v) => !v)}
              className={`flex items-center gap-1.5 rounded-xl border px-3 py-1.5 text-xs font-semibold shadow-sm backdrop-blur-sm transition ${satelite ? 'border-blue-300 bg-blue-600 text-white' : 'border-gray-200 bg-white/95 text-gray-700 hover:bg-gray-50'}`}
            >
              <Satellite size={13} />
              Satélite
            </button>

            {/* Modo prueba */}
            {mode === 'idle' && (
              <button
                onClick={() => { setModoTest((v) => !v); infoWindowRef.current?.close(); setClickedId(null) }}
                className={`flex items-center gap-1.5 rounded-xl border px-3 py-1.5 text-xs font-semibold shadow-sm backdrop-blur-sm transition ${modoTest ? 'border-orange-300 bg-orange-500 text-white' : 'border-gray-200 bg-white/95 text-gray-700 hover:bg-gray-50'}`}
                title="Haz clic en el mapa para ver a qué zona pertenece un punto"
              >
                <Crosshair size={13} />
                {modoTest ? 'Modo prueba ON' : 'Modo prueba'}
              </button>
            )}

            {/* Limpiar selección */}
            {clickedId && mode === 'idle' && (
              <button
                onClick={() => { setClickedId(null); infoWindowRef.current?.close() }}
                className="flex items-center gap-1.5 rounded-xl border border-gray-200 bg-white/95 px-3 py-1.5 text-xs font-semibold text-gray-600 shadow-sm backdrop-blur-sm transition hover:bg-gray-50"
              >
                <X size={13} /> Deseleccionar
              </button>
            )}
          </div>

          {/* Banner modo prueba */}
          {modoTest && (
            <div className="pointer-events-none absolute bottom-4 left-1/2 -translate-x-1/2 rounded-xl bg-orange-500/90 px-4 py-2 text-xs font-semibold text-white backdrop-blur-sm">
              Modo prueba activo — haz clic en cualquier punto del mapa
            </div>
          )}

          {/* Instrucción de dibujo */}
          {dibujando && (
            <div className="pointer-events-none absolute bottom-4 left-1/2 -translate-x-1/2 rounded-xl bg-gray-900/85 px-4 py-2 text-center text-xs text-white backdrop-blur-sm">
              Clic izquierdo para agregar punto · <span className="text-red-300">Clic derecho para deshacer</span> · Completar cuando tengas ≥ 3 vértices
            </div>
          )}

          {/* Leyenda */}
          {mode === 'idle' && zonas.filter((z) => z.activa).length > 0 && (
            <div className="absolute bottom-4 right-4 max-w-[180px] rounded-xl border border-gray-200 bg-white/95 p-2.5 shadow-sm backdrop-blur-sm">
              <p className="mb-1.5 text-[10px] font-semibold uppercase tracking-wide text-gray-500">Leyenda</p>
              {zonas.filter((z) => z.activa).map((z) => (
                <div
                  key={z.id}
                  onClick={() => handleClickCard(z)}
                  className={`flex cursor-pointer items-center gap-1.5 rounded-lg px-1.5 py-0.5 transition ${clickedId === z.id ? 'bg-blue-50' : 'hover:bg-gray-50'}`}
                >
                  <div className="h-2.5 w-2.5 shrink-0 rounded-sm" style={{ backgroundColor: z.color }} />
                  <span className="truncate text-[11px] text-gray-700">{z.nombre}</span>
                </div>
              ))}
            </div>
          )}
        </div>
      </div>
    </div>
  )
}
