'use client'

import { useEffect, useRef, useState, useCallback } from 'react'
import { auth } from '@/fb/config'
import { getMapsLoader } from '@/lib/googleMaps'
import { onZonasSnapshot, crearZona, actualizarZona, toggleZonaActiva } from '@/fb/zonas'
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
} from 'lucide-react'

// ── Constantes ────────────────────────────────────────────────────────────────

const MAP_CENTER = { lat: 12.1364, lng: -86.2514 } // Managua, Nicaragua

const COLORES_PRESET = [
  '#ef4444', // rojo
  '#f97316', // naranja
  '#eab308', // amarillo
  '#22c55e', // verde
  '#14b8a6', // teal
  '#3b82f6', // azul
  '#6366f1', // índigo
  '#a855f7', // violeta
]

type Mode = 'idle' | 'nueva' | 'editando'

// ── Componente ────────────────────────────────────────────────────────────────

export default function ZonasPage() {
  // ── State ──
  const [zonas, setZonas] = useState<ZonaGeografica[]>([])
  const [mode, setMode] = useState<Mode>('idle')
  const [selectedId, setSelectedId] = useState<string | null>(null)

  const [draftNombre, setDraftNombre] = useState('')
  const [draftColor, setDraftColor] = useState('#3b82f6')
  const [draftPrioridad, setDraftPrioridad] = useState(50)
  const [draftPoligono, setDraftPoligono] = useState<Coord[] | null>(null)
  const [dibujando, setDibujando] = useState(false)

  const [saving, setSaving] = useState(false)
  const [mapReady, setMapReady] = useState(false)
  const [msg, setMsg] = useState<{ type: 'success' | 'error'; text: string } | null>(null)

  // ── Google Maps refs ──
  const containerRef = useRef<HTMLDivElement | null>(null)
  const mapRef = useRef<google.maps.Map | null>(null)
  const dmRef = useRef<any>(null) // DrawingManager
  const overlaysRef = useRef<Record<string, google.maps.Polygon>>({})
  const editPolyRef = useRef<google.maps.Polygon | null>(null)
  const draftPolyRef = useRef<google.maps.Polygon | null>(null)
  // Ref para leer draftColor sin stale closure en el callback del DrawingManager
  const draftColorRef = useRef(draftColor)
  useEffect(() => { draftColorRef.current = draftColor }, [draftColor])

  // ── Inicializar mapa ──
  useEffect(() => {
    const loader = getMapsLoader()
    loader.load().then(() => {
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

      const dm = new (google.maps as any).drawing.DrawingManager({
        drawingMode: null,
        drawingControl: false,
        polygonOptions: {
          strokeWeight: 2,
          fillOpacity: 0.25,
          editable: false,
          clickable: false,
        },
      })
      dm.setMap(map)
      dmRef.current = dm

      dm.addListener('polygoncomplete', (polygon: google.maps.Polygon) => {
        // Capturar vértices del polígono dibujado
        const path = polygon.getPath()
        const coords: Coord[] = []
        for (let i = 0; i < path.getLength(); i++) {
          const pt = path.getAt(i)
          coords.push({ lat: pt.lat(), lng: pt.lng() })
        }
        // Eliminar overlay temporal del DrawingManager
        polygon.setMap(null)

        // Desactivar modo dibujo
        dm.setDrawingMode(null)
        setDibujando(false)
        setDraftPoligono(coords)

        // Mostrar preview del polígono nuevo
        if (draftPolyRef.current) draftPolyRef.current.setMap(null)
        const color = draftColorRef.current
        const preview = new google.maps.Polygon({
          paths: coords.map((c) => ({ lat: c.lat, lng: c.lng })),
          strokeColor: color,
          strokeWeight: 2,
          fillColor: color,
          fillOpacity: 0.3,
          map,
          editable: false,
          clickable: false,
        })
        draftPolyRef.current = preview
      })

      setMapReady(true)
    })
  }, [])

  // ── Actualizar color del polígono draft al cambiar el color seleccionado ──
  useEffect(() => {
    if (draftPolyRef.current) {
      draftPolyRef.current.setOptions({ strokeColor: draftColor, fillColor: draftColor })
    }
    if (editPolyRef.current) {
      editPolyRef.current.setOptions({ strokeColor: draftColor, fillColor: draftColor })
    }
  }, [draftColor])

  // ── Suscribir a zonas en Firestore ──
  useEffect(() => {
    const unsub = onZonasSnapshot((z) => setZonas(z))
    return () => unsub()
  }, [])

  // ── Actualizar overlays del mapa cuando cambian las zonas ──
  useEffect(() => {
    if (!mapReady || !mapRef.current) return

    const map = mapRef.current
    const currentIds = new Set(zonas.map((z) => z.id))

    // Eliminar overlays de zonas que ya no existen
    Object.keys(overlaysRef.current).forEach((id) => {
      if (!currentIds.has(id)) {
        overlaysRef.current[id].setMap(null)
        delete overlaysRef.current[id]
      }
    })

    // Crear / actualizar overlay por cada zona
    zonas.forEach((zona) => {
      // Si la zona está en modo edición, su polígono lo maneja editPolyRef
      if (zona.id === selectedId && mode === 'editando') return

      const opacity = zona.activa ? 0.8 : 0.3
      const fill = zona.activa ? 0.15 : 0.04

      const existing = overlaysRef.current[zona.id]
      if (existing) {
        existing.setOptions({
          paths: zona.poligono.map((p) => ({ lat: p.lat, lng: p.lng })),
          strokeColor: zona.color,
          fillColor: zona.color,
          strokeOpacity: opacity,
          fillOpacity: fill,
        })
      } else {
        const poly = new google.maps.Polygon({
          paths: zona.poligono.map((p) => ({ lat: p.lat, lng: p.lng })),
          strokeColor: zona.color,
          strokeWeight: 2,
          strokeOpacity: opacity,
          fillColor: zona.color,
          fillOpacity: fill,
          map,
          editable: false,
          clickable: false,
        })
        overlaysRef.current[zona.id] = poly
      }
    })
  }, [zonas, mapReady, mode, selectedId])

  // ── Handlers ──

  const limpiarDraft = useCallback(() => {
    if (draftPolyRef.current) { draftPolyRef.current.setMap(null); draftPolyRef.current = null }
    if (editPolyRef.current) { editPolyRef.current.setMap(null); editPolyRef.current = null }
    if (dmRef.current) dmRef.current.setDrawingMode(null)
    setDibujando(false)
    setDraftPoligono(null)
    setDraftNombre('')
    setDraftColor('#3b82f6')
    setDraftPrioridad(50)
    setSelectedId(null)
    setMsg(null)
  }, [])

  const handleNuevaZona = useCallback(() => {
    limpiarDraft()
    setMode('nueva')
  }, [limpiarDraft])

  const handleEditarZona = useCallback((zona: ZonaGeografica) => {
    limpiarDraft()
    setSelectedId(zona.id)
    setDraftNombre(zona.nombre)
    setDraftColor(zona.color)
    setDraftPrioridad(zona.prioridad)

    // Ocultar overlay estático de esta zona
    if (overlaysRef.current[zona.id]) {
      overlaysRef.current[zona.id].setMap(null)
    }

    // Crear polígono editable para editar vértices
    if (mapRef.current) {
      const editPoly = new google.maps.Polygon({
        paths: zona.poligono.map((p) => ({ lat: p.lat, lng: p.lng })),
        strokeColor: zona.color,
        strokeWeight: 2,
        fillColor: zona.color,
        fillOpacity: 0.3,
        map: mapRef.current,
        editable: true,
        clickable: false,
      })
      editPolyRef.current = editPoly

      // Centrar mapa en la zona
      const bounds = new google.maps.LatLngBounds()
      zona.poligono.forEach((p) => bounds.extend({ lat: p.lat, lng: p.lng }))
      mapRef.current.fitBounds(bounds, 60)
    }

    setMode('editando')
  }, [limpiarDraft])

  const handleCancelar = useCallback(() => {
    // Restaurar overlay estático de la zona que se estaba editando
    if (selectedId && overlaysRef.current[selectedId]) {
      overlaysRef.current[selectedId].setMap(mapRef.current)
    }
    limpiarDraft()
    setMode('idle')
  }, [selectedId, limpiarDraft])

  const handleStartDraw = useCallback(() => {
    if (!dmRef.current) return
    // Limpiar polígono anterior si hay
    if (draftPolyRef.current) { draftPolyRef.current.setMap(null); draftPolyRef.current = null }
    setDraftPoligono(null)
    dmRef.current.setDrawingMode((google.maps as any).drawing.OverlayType.POLYGON)
    setDibujando(true)
  }, [])

  const handleGuardar = useCallback(async () => {
    if (!draftNombre.trim()) {
      setMsg({ type: 'error', text: 'El nombre de la zona es obligatorio.' })
      return
    }

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
      setMsg({ type: 'error', text: 'Dibuja el polígono de la zona antes de guardar (mínimo 3 vértices).' })
      return
    }

    try {
      setSaving(true)
      setMsg(null)
      const uid = auth.currentUser?.uid ?? ''

      if (mode === 'nueva') {
        await crearZona({
          nombre: draftNombre.trim(),
          color: draftColor,
          poligono: finalPoligono,
          activa: true,
          prioridad: draftPrioridad,
        }, uid)
        setMsg({ type: 'success', text: `Zona "${draftNombre.trim()}" creada correctamente.` })
      } else if (mode === 'editando' && selectedId) {
        await actualizarZona(selectedId, {
          nombre: draftNombre.trim(),
          color: draftColor,
          poligono: finalPoligono,
          prioridad: draftPrioridad,
        })
        setMsg({ type: 'success', text: `Zona "${draftNombre.trim()}" actualizada.` })
      }

      // Limpiar y volver a idle
      if (draftPolyRef.current) { draftPolyRef.current.setMap(null); draftPolyRef.current = null }
      if (editPolyRef.current) { editPolyRef.current.setMap(null); editPolyRef.current = null }
      if (dmRef.current) dmRef.current.setDrawingMode(null)
      setDibujando(false)
      setDraftPoligono(null)
      setDraftNombre('')
      setDraftColor('#3b82f6')
      setDraftPrioridad(50)
      setSelectedId(null)
      setMode('idle')
    } catch (err) {
      console.error(err)
      setMsg({ type: 'error', text: 'No se pudo guardar la zona. Intenta de nuevo.' })
    } finally {
      setSaving(false)
    }
  }, [mode, draftNombre, draftColor, draftPrioridad, draftPoligono, selectedId])

  const handleToggle = useCallback(async (zona: ZonaGeografica) => {
    try {
      await toggleZonaActiva(zona.id, !zona.activa)
    } catch (err) {
      console.error(err)
    }
  }, [])

  // ── UI ────────────────────────────────────────────────────────────────────

  const zonaSeleccionada = zonas.find((z) => z.id === selectedId)
  const puedeGuardar = draftNombre.trim().length > 0 &&
    (mode === 'editando' || (draftPoligono !== null && draftPoligono.length >= 3))

  return (
    <div className="flex h-full min-h-0 gap-4">

      {/* ── Panel izquierdo: lista de zonas ── */}
      <div className="flex w-72 shrink-0 flex-col gap-3">

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
            className="flex items-center gap-1.5 rounded-xl bg-[#004aad] px-3 py-2 text-xs font-semibold text-white shadow-sm transition hover:bg-[#003a8c] disabled:opacity-50 disabled:cursor-not-allowed"
          >
            <Plus size={14} />
            Nueva zona
          </button>
        </div>

        {/* Lista */}
        <div className="flex flex-col gap-2 overflow-y-auto">
          {zonas.length === 0 && (
            <div className="rounded-2xl border border-dashed border-gray-200 bg-white p-6 text-center">
              <Pentagon size={28} className="mx-auto mb-2 text-gray-300" />
              <p className="text-xs text-gray-500">No hay zonas creadas.</p>
              <p className="mt-0.5 text-xs text-gray-400">Haz clic en "Nueva zona" para comenzar.</p>
            </div>
          )}

          {zonas.map((zona) => (
            <div
              key={zona.id}
              className={`rounded-2xl border bg-white p-3.5 shadow-sm transition ${
                selectedId === zona.id
                  ? 'border-[#004aad] ring-1 ring-[#004aad]/20'
                  : 'border-gray-200'
              }`}
            >
              {/* Header de tarjeta */}
              <div className="flex items-start gap-2.5">
                {/* Swatch de color */}
                <div
                  className="mt-0.5 h-4 w-4 shrink-0 rounded-full border border-white shadow-sm"
                  style={{ backgroundColor: zona.color }}
                />
                <div className="min-w-0 flex-1">
                  <p className="truncate text-sm font-semibold text-gray-900">{zona.nombre}</p>
                  <p className="text-[10px] text-gray-400">Prioridad: {zona.prioridad}</p>
                </div>
                {/* Badge activa */}
                <span
                  className={`inline-flex shrink-0 items-center rounded-full border px-2 py-0.5 text-[10px] font-semibold ${
                    zona.activa
                      ? 'border-green-200 bg-green-50 text-green-700'
                      : 'border-gray-200 bg-gray-100 text-gray-500'
                  }`}
                >
                  {zona.activa ? 'Activa' : 'Inactiva'}
                </span>
              </div>

              {/* Polígono info */}
              <p className="mt-1.5 text-[10px] text-gray-400">
                {zona.poligono.length} vértices
              </p>

              {/* Acciones */}
              <div className="mt-2.5 flex items-center gap-1.5">
                <button
                  onClick={() => handleEditarZona(zona)}
                  disabled={mode !== 'idle'}
                  className="flex items-center gap-1 rounded-lg border border-gray-200 bg-white px-2.5 py-1.5 text-xs font-medium text-gray-700 transition hover:bg-gray-50 disabled:opacity-40 disabled:cursor-not-allowed"
                >
                  <Pencil size={12} />
                  Editar
                </button>
                <button
                  onClick={() => handleToggle(zona)}
                  disabled={mode !== 'idle'}
                  title={zona.activa ? 'Desactivar zona' : 'Activar zona'}
                  className="flex items-center gap-1 rounded-lg border border-gray-200 bg-white px-2.5 py-1.5 text-xs font-medium text-gray-700 transition hover:bg-gray-50 disabled:opacity-40 disabled:cursor-not-allowed"
                >
                  {zona.activa ? <EyeOff size={12} /> : <Eye size={12} />}
                  {zona.activa ? 'Desactivar' : 'Activar'}
                </button>
              </div>
            </div>
          ))}
        </div>
      </div>

      {/* ── Panel derecho: mapa + formulario ── */}
      <div className="relative flex min-h-0 flex-1 flex-col gap-3">

        {/* Formulario (visible en modo nueva/editando) */}
        {mode !== 'idle' && (
          <div className="rounded-2xl border border-gray-200 bg-white p-4 shadow-sm">
            <div className="mb-3 flex items-center justify-between">
              <h2 className="text-sm font-bold text-gray-900">
                {mode === 'nueva' ? 'Nueva zona' : `Editando: ${zonaSeleccionada?.nombre ?? ''}`}
              </h2>
              <button
                onClick={handleCancelar}
                className="flex items-center gap-1 rounded-lg border border-gray-200 bg-white px-2 py-1.5 text-xs font-medium text-gray-600 transition hover:bg-gray-50"
              >
                <X size={12} />
                Cancelar
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
              <div className="w-28">
                <label className="mb-1 block text-xs font-medium text-gray-700">
                  Prioridad
                </label>
                <input
                  type="number"
                  min={0}
                  max={999}
                  value={draftPrioridad}
                  onChange={(e) => setDraftPrioridad(Number(e.target.value))}
                  className="w-full rounded-lg border border-gray-200 bg-white px-3 py-2 text-sm outline-none focus:border-[#004aad]"
                />
                <p className="mt-0.5 text-[10px] text-gray-400">0 = mayor</p>
              </div>

              {/* Color */}
              <div>
                <label className="mb-1 block text-xs font-medium text-gray-700">Color</label>
                <div className="flex items-center gap-1.5">
                  {COLORES_PRESET.map((c) => (
                    <button
                      key={c}
                      onClick={() => setDraftColor(c)}
                      className={`h-6 w-6 rounded-full border-2 transition ${
                        draftColor === c ? 'border-gray-800 scale-110' : 'border-transparent'
                      }`}
                      style={{ backgroundColor: c }}
                      title={c}
                    />
                  ))}
                  <input
                    type="color"
                    value={draftColor}
                    onChange={(e) => setDraftColor(e.target.value)}
                    className="h-6 w-6 cursor-pointer rounded border border-gray-200"
                    title="Color personalizado"
                  />
                </div>
              </div>
            </div>

            {/* Polígono */}
            <div className="mt-3 flex items-center gap-3">
              {mode === 'nueva' && (
                <button
                  onClick={handleStartDraw}
                  disabled={dibujando}
                  className={`flex items-center gap-1.5 rounded-xl px-3 py-2 text-xs font-semibold transition ${
                    dibujando
                      ? 'border border-blue-200 bg-blue-50 text-blue-700'
                      : 'bg-gray-900 text-white hover:bg-gray-700'
                  }`}
                >
                  <Pentagon size={13} />
                  {dibujando ? 'Dibujando… haz clic en el mapa' : draftPoligono ? 'Redibujar polígono' : 'Dibujar polígono'}
                </button>
              )}

              {mode === 'editando' && (
                <p className="text-xs text-gray-500">
                  Arrastrá los vértices del polígono para editar la forma.
                </p>
              )}

              {draftPoligono && mode === 'nueva' && (
                <span className="flex items-center gap-1 text-xs text-green-700">
                  <Check size={13} />
                  {draftPoligono.length} vértices dibujados
                </span>
              )}
            </div>

            {/* Mensaje de error/éxito */}
            {msg && (
              <div
                className={`mt-3 flex items-center gap-2 rounded-lg px-3 py-2 text-xs ${
                  msg.type === 'error'
                    ? 'border border-red-200 bg-red-50 text-red-700'
                    : 'border border-green-200 bg-green-50 text-green-700'
                }`}
              >
                <AlertCircle size={13} />
                {msg.text}
              </div>
            )}

            {/* Botón guardar */}
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
                <Loader2 size={16} className="animate-spin" />
                Cargando mapa…
              </div>
            </div>
          )}
          <div ref={containerRef} className="h-full w-full" />

          {/* Instrucción de dibujo */}
          {dibujando && (
            <div className="pointer-events-none absolute bottom-4 left-1/2 -translate-x-1/2 rounded-xl bg-gray-900/85 px-4 py-2 text-xs text-white backdrop-blur-sm">
              Haz clic en el mapa para dibujar vértices · Cierra el polígono haciendo doble clic o clic en el primer punto
            </div>
          )}

          {/* Leyenda de zonas */}
          {mode === 'idle' && zonas.filter((z) => z.activa).length > 0 && (
            <div className="absolute bottom-4 right-4 max-w-[160px] rounded-xl border border-gray-200 bg-white/95 p-2.5 shadow-sm backdrop-blur-sm">
              <p className="mb-1.5 text-[10px] font-semibold uppercase tracking-wide text-gray-500">Leyenda</p>
              {zonas.filter((z) => z.activa).map((z) => (
                <div key={z.id} className="flex items-center gap-1.5 py-0.5">
                  <div
                    className="h-3 w-3 shrink-0 rounded-sm border border-white shadow-sm"
                    style={{ backgroundColor: z.color }}
                  />
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
