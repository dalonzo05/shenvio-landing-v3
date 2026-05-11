'use client'

import { useEffect, useRef, useState, useCallback } from 'react'
import { auth } from '@/fb/config'
import { getMapsLoader } from '@/lib/googleMaps'
import {
  onPuntosSnapshot,
  crearPunto,
  actualizarPunto,
  togglePuntoActivo,
  eliminarPunto,
} from '@/fb/puntosLogisticos'
import type { PuntoLogistico, TipoPuntoLogistico } from '@/lib/puntosLogisticos'
import { TIPO_LABELS, TIPO_COLORS } from '@/lib/puntosLogisticos'
import {
  Plus,
  Pencil,
  Eye,
  EyeOff,
  Loader2,
  AlertCircle,
  X,
  Check,
  Satellite,
  Trash2,
  MapPin,
} from 'lucide-react'

const MAP_CENTER = { lat: 12.1364, lng: -86.2514 }

type Mode = 'idle' | 'nueva' | 'editando'

function markerIcon(tipo: TipoPuntoLogistico, activo: boolean): string {
  const color = activo ? TIPO_COLORS[tipo] : '#9ca3af'
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="28" height="36" viewBox="0 0 28 36">
    <path d="M14 0C6.27 0 0 6.27 0 14c0 9.45 12.6 21.25 13.13 21.75a1.25 1.25 0 001.74 0C15.4 35.25 28 23.45 28 14 28 6.27 21.73 0 14 0z" fill="${color}"/>
    <circle cx="14" cy="14" r="6" fill="white" fill-opacity="0.9"/>
  </svg>`
  return 'data:image/svg+xml;charset=UTF-8,' + encodeURIComponent(svg)
}

export default function PuntosLogisticosPanel({ visible }: { visible: boolean }) {
  const [puntos, setPuntos] = useState<PuntoLogistico[]>([])
  const [mode, setMode] = useState<Mode>('idle')
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [busqueda, setBusqueda] = useState('')
  const [filtroTipo, setFiltroTipo] = useState<'todos' | TipoPuntoLogistico>('todos')
  const [satelite, setSatelite] = useState(false)
  const [mapReady, setMapReady] = useState(false)
  const [saving, setSaving] = useState(false)
  const [msg, setMsg] = useState<{ type: 'success' | 'error'; text: string } | null>(null)
  const [confirmDeleteId, setConfirmDeleteId] = useState<string | null>(null)

  // form state
  const [draftNombre, setDraftNombre] = useState('')
  const [draftTipo, setDraftTipo] = useState<TipoPuntoLogistico>('terminal_bus')
  const [draftDireccion, setDraftDireccion] = useState('')
  const [draftHorarioApertura, setDraftHorarioApertura] = useState('')
  const [draftHorarioCierre, setDraftHorarioCierre] = useState('')
  const [draftNotas, setDraftNotas] = useState('')
  const [draftPrioridad, setDraftPrioridad] = useState(1)
  const [draftCoord, setDraftCoord] = useState<{ lat: number; lng: number } | null>(null)
  const [draftDestinos, setDraftDestinos] = useState('')  // comma-separated
  const [draftAliases, setDraftAliases] = useState('')

  // Map refs
  const containerRef = useRef<HTMLDivElement | null>(null)
  const mapRef = useRef<google.maps.Map | null>(null)
  const markersRef = useRef<Record<string, google.maps.Marker>>({})
  const infoWindowRef = useRef<google.maps.InfoWindow | null>(null)
  const draftMarkerRef = useRef<google.maps.Marker | null>(null)
  const inEditingModeRef = useRef(false)
  useEffect(() => { inEditingModeRef.current = mode !== 'idle' }, [mode])

  // Forward-declared refs for InfoWindow callbacks
  const handleEditarRef = useRef<(p: PuntoLogistico) => void>(() => {})
  const handleToggleRef = useRef<(p: PuntoLogistico) => void>(() => {})

  // ── Resize map when tab becomes visible ────────────────────────────────────
  useEffect(() => {
    if (visible && mapRef.current) {
      google.maps.event.trigger(mapRef.current, 'resize')
    }
  }, [visible])

  // ── Init map ───────────────────────────────────────────────────────────────
  useEffect(() => {
    getMapsLoader().load().then(() => {
      if (!containerRef.current || mapRef.current) return
      const map = new google.maps.Map(containerRef.current, {
        center: MAP_CENTER,
        zoom: 13,
        mapTypeControl: false,
        streetViewControl: false,
        fullscreenControl: false,
        clickableIcons: false,
        zoomControlOptions: { position: google.maps.ControlPosition.RIGHT_CENTER },
      })
      mapRef.current = map

      map.addListener('click', (e: google.maps.MapMouseEvent) => {
        if (!inEditingModeRef.current || !e.latLng) return
        const coord = { lat: e.latLng.lat(), lng: e.latLng.lng() }
        setDraftCoord(coord)
        placeDraftMarker(coord, map)
      })

      setMapReady(true)
    })
  }, [])

  function placeDraftMarker(coord: { lat: number; lng: number }, map: google.maps.Map) {
    if (draftMarkerRef.current) {
      draftMarkerRef.current.setPosition(coord)
    } else {
      draftMarkerRef.current = new google.maps.Marker({
        position: coord,
        map,
        draggable: true,
        zIndex: 30,
        icon: {
          url: markerIcon('terminal_bus', true),
          scaledSize: new google.maps.Size(28, 36),
          anchor: new google.maps.Point(14, 36),
        },
      })
      draftMarkerRef.current.addListener('dragend', (e: google.maps.MapMouseEvent) => {
        if (!e.latLng) return
        setDraftCoord({ lat: e.latLng.lat(), lng: e.latLng.lng() })
      })
    }
  }

  // ── Satellite toggle ───────────────────────────────────────────────────────
  useEffect(() => {
    if (!mapRef.current) return
    mapRef.current.setMapTypeId(satelite ? google.maps.MapTypeId.HYBRID : google.maps.MapTypeId.ROADMAP)
  }, [satelite, mapReady])

  // ── Subscribe puntos ───────────────────────────────────────────────────────
  useEffect(() => {
    return onPuntosSnapshot(
      (p) => setPuntos(p),
      (err) => {
        if (err.message?.includes('permission-denied') || (err as any).code === 'permission-denied') {
          setMsg({ type: 'error', text: 'Sin permisos para leer puntos logísticos. Verificá tu sesión.' })
        }
      },
    )
  }, [])

  // ── Sync markers on map ────────────────────────────────────────────────────
  useEffect(() => {
    if (!mapReady || !mapRef.current) return
    const map = mapRef.current
    const currentIds = new Set(puntos.map((p) => p.id))

    // Remove deleted
    Object.keys(markersRef.current).forEach((id) => {
      if (!currentIds.has(id)) {
        markersRef.current[id].setMap(null)
        delete markersRef.current[id]
      }
    })

    // Add / update
    puntos.forEach((punto) => {
      if (punto.id === selectedId && mode === 'editando') return

      const existing = markersRef.current[punto.id]
      const pos = { lat: punto.coord.lat, lng: punto.coord.lng }
      const icon: google.maps.Icon = {
        url: markerIcon(punto.tipo, punto.activo),
        scaledSize: new google.maps.Size(28, 36),
        anchor: new google.maps.Point(14, 36),
      }

      if (existing) {
        existing.setPosition(pos)
        existing.setIcon(icon)
        existing.setOpacity(punto.activo ? 1 : 0.5)
      } else {
        const marker = new google.maps.Marker({
          position: pos,
          map,
          icon,
          opacity: punto.activo ? 1 : 0.5,
          title: punto.nombre,
          zIndex: 10,
        })
        marker.addListener('click', () => {
          if (mode !== 'idle') return
          abrirInfoWindow(punto, marker.getPosition()!, map)
        })
        markersRef.current[punto.id] = marker
      }
    })
  }, [puntos, mapReady, mode, selectedId])

  function abrirInfoWindow(punto: PuntoLogistico, pos: google.maps.LatLng, map: google.maps.Map) {
    if (!infoWindowRef.current) infoWindowRef.current = new google.maps.InfoWindow()

    const badge = punto.activo
      ? `<span style="background:#f0fdf4;color:#16a34a;border:1px solid #bbf7d0;border-radius:99px;padding:1px 8px;font-size:10px;font-weight:700">Activo</span>`
      : `<span style="background:#f3f4f6;color:#6b7280;border:1px solid #d1d5db;border-radius:99px;padding:1px 8px;font-size:10px;font-weight:700">Inactivo</span>`

    const tipoBadge = `<span style="background:#eff6ff;color:#1d4ed8;border:1px solid #bfdbfe;border-radius:99px;padding:1px 8px;font-size:10px;font-weight:700">${TIPO_LABELS[punto.tipo]}</span>`

    infoWindowRef.current.setContent(`
      <div style="font-family:system-ui,sans-serif;padding:2px 0 4px;min-width:180px">
        <div style="font-size:13px;font-weight:700;color:#111827;margin-bottom:6px">${punto.nombre}</div>
        <div style="display:flex;gap:5px;flex-wrap:wrap;margin-bottom:8px">${badge}${tipoBadge}</div>
        ${punto.direccion ? `<div style="font-size:11px;color:#6b7280;margin-bottom:4px">📍 ${punto.direccion}</div>` : ''}
        ${punto.horarioApertura || punto.horarioCierre ? `<div style="font-size:11px;color:#6b7280;margin-bottom:8px">🕐 ${punto.horarioApertura || '?'}–${punto.horarioCierre || '?'}</div>` : ''}
        <div style="display:flex;gap:5px;flex-wrap:wrap">
          <button id="iw-btn-edit" style="cursor:pointer;background:#004aad;color:#fff;border:none;border-radius:8px;padding:5px 10px;font-size:11px;font-weight:600">✏ Editar</button>
          <button id="iw-btn-toggle" style="cursor:pointer;background:#f3f4f6;color:#374151;border:1px solid #d1d5db;border-radius:8px;padding:5px 10px;font-size:11px;font-weight:600">${punto.activo ? '⊘ Desactivar' : '✓ Activar'}</button>
          <button id="iw-btn-del" style="cursor:pointer;background:#fff1f2;color:#ef4444;border:1px solid #fecaca;border-radius:8px;padding:5px 10px;font-size:11px;font-weight:600">🗑 Eliminar</button>
        </div>
      </div>
    `)
    infoWindowRef.current.setPosition(pos)
    infoWindowRef.current.open(map)

    google.maps.event.addListenerOnce(infoWindowRef.current, 'domready', () => {
      document.getElementById('iw-btn-edit')?.addEventListener('click', () => {
        infoWindowRef.current?.close()
        handleEditarRef.current(punto)
      })
      document.getElementById('iw-btn-toggle')?.addEventListener('click', () => {
        infoWindowRef.current?.close()
        handleToggleRef.current(punto)
      })
      document.getElementById('iw-btn-del')?.addEventListener('click', () => {
        infoWindowRef.current?.close()
        setConfirmDeleteId(punto.id)
      })
    })
  }

  // ── Handlers ───────────────────────────────────────────────────────────────

  const limpiarDraft = useCallback(() => {
    draftMarkerRef.current?.setMap(null)
    draftMarkerRef.current = null
    setDraftNombre('')
    setDraftTipo('terminal_bus')
    setDraftDireccion('')
    setDraftHorarioApertura('')
    setDraftHorarioCierre('')
    setDraftNotas('')
    setDraftPrioridad(1)
    setDraftCoord(null)
    setDraftDestinos('')
    setDraftAliases('')
    setSelectedId(null)
    setMsg(null)
  }, [])

  const handleNuevo = useCallback(() => {
    limpiarDraft()
    infoWindowRef.current?.close()
    setMode('nueva')
  }, [limpiarDraft])

  const handleEditar = useCallback((p: PuntoLogistico) => {
    limpiarDraft()
    infoWindowRef.current?.close()
    setSelectedId(p.id)
    setDraftNombre(p.nombre)
    setDraftTipo(p.tipo)
    setDraftDireccion(p.direccion)
    setDraftHorarioApertura(p.horarioApertura)
    setDraftHorarioCierre(p.horarioCierre)
    setDraftNotas(p.notas)
    setDraftPrioridad(p.prioridad)
    setDraftCoord(p.coord)
    setDraftDestinos((p.destinos ?? []).join(', '))
    setDraftAliases((p.aliases ?? []).join(', '))

    // Hide editing marker from list effect — show draggable draft marker
    if (markersRef.current[p.id]) {
      markersRef.current[p.id].setMap(null)
      delete markersRef.current[p.id]
    }

    if (mapRef.current) {
      placeDraftMarker(p.coord, mapRef.current)
      mapRef.current.panTo(p.coord)
    }

    setMode('editando')
  }, [limpiarDraft])

  handleEditarRef.current = handleEditar

  const handleCancelar = useCallback(() => {
    limpiarDraft()
    setMode('idle')
  }, [limpiarDraft])

  const handleGuardar = useCallback(async () => {
    if (!draftNombre.trim()) {
      setMsg({ type: 'error', text: 'El nombre es obligatorio.' })
      return
    }
    if (!draftCoord) {
      setMsg({ type: 'error', text: 'Haz clic en el mapa para marcar la ubicación.' })
      return
    }

    const destinos = draftDestinos.split(',').map((s) => s.trim()).filter(Boolean)
    const aliases = draftAliases.split(',').map((s) => s.trim()).filter(Boolean)

    const payload: Omit<PuntoLogistico, 'id' | 'createdAt' | 'updatedAt'> = {
      nombre: draftNombre.trim(),
      tipo: draftTipo,
      coord: draftCoord,
      direccion: draftDireccion.trim(),
      horarioApertura: draftHorarioApertura.trim(),
      horarioCierre: draftHorarioCierre.trim(),
      notas: draftNotas.trim(),
      activo: true,
      prioridad: draftPrioridad,
      destinos,
      aliases,
    }

    // Remove draft marker before await (same pattern as zonas page)
    draftMarkerRef.current?.setMap(null)
    draftMarkerRef.current = null

    try {
      setSaving(true); setMsg(null)
      const uid = auth.currentUser?.uid ?? ''
      if (mode === 'nueva') {
        await crearPunto(payload, uid)
        setMsg({ type: 'success', text: `"${payload.nombre}" creado.` })
      } else if (mode === 'editando' && selectedId) {
        await actualizarPunto(selectedId, payload)
        setMsg({ type: 'success', text: `"${payload.nombre}" actualizado.` })
      }
      limpiarDraft()
      setMode('idle')
    } catch (err) {
      console.error(err)
      setMsg({ type: 'error', text: 'No se pudo guardar. Intentá de nuevo.' })
    } finally {
      setSaving(false)
    }
  }, [mode, selectedId, draftNombre, draftTipo, draftCoord, draftDireccion, draftHorarioApertura, draftHorarioCierre, draftNotas, draftPrioridad, draftDestinos, draftAliases, limpiarDraft])

  const handleToggle = useCallback(async (p: PuntoLogistico) => {
    try { await togglePuntoActivo(p.id, !p.activo) } catch (err) { console.error(err) }
  }, [])
  handleToggleRef.current = handleToggle

  const handleEliminar = useCallback(async (p: PuntoLogistico) => {
    try {
      infoWindowRef.current?.close()
      markersRef.current[p.id]?.setMap(null)
      delete markersRef.current[p.id]
      await eliminarPunto(p.id)
    } catch (err) { console.error(err) }
    finally { setConfirmDeleteId(null) }
  }, [])

  const puntosFiltrados = puntos
    .filter((p) => p.nombre.toLowerCase().includes(busqueda.toLowerCase()))
    .filter((p) => filtroTipo === 'todos' || p.tipo === filtroTipo)

  const puedeGuardar = draftNombre.trim().length > 0 && draftCoord !== null

  // ── Render ─────────────────────────────────────────────────────────────────
  return (
    <div className="flex h-full min-h-0 gap-4">

      {/* Left panel */}
      <div className="flex w-64 shrink-0 flex-col gap-2.5">

        {/* Header */}
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-2">
            <MapPin size={18} className="text-[#004aad]" />
            <h1 className="text-base font-bold text-gray-900">Puntos log.</h1>
            <span className="inline-flex items-center rounded-full bg-gray-100 px-2 py-0.5 text-xs font-semibold text-gray-600">
              {puntos.length}
            </span>
          </div>
          <button
            onClick={handleNuevo}
            disabled={mode !== 'idle'}
            className="flex items-center gap-1 rounded-xl bg-[#004aad] px-2.5 py-1.5 text-xs font-semibold text-white shadow-sm transition hover:bg-[#003a8c] disabled:opacity-50 disabled:cursor-not-allowed"
          >
            <Plus size={13} />
            Nuevo
          </button>
        </div>

        {/* Search */}
        <input
          type="text"
          value={busqueda}
          onChange={(e) => setBusqueda(e.target.value)}
          placeholder="Buscar punto…"
          className="w-full rounded-xl border border-gray-200 bg-white px-3 py-2 text-xs outline-none focus:border-[#004aad]"
        />

        {/* Filter by tipo */}
        <div className="flex gap-1 flex-wrap">
          {(['todos', 'terminal_bus', 'cargotrans', 'otro'] as const).map((t) => (
            <button
              key={t}
              onClick={() => setFiltroTipo(t)}
              className={`rounded-lg border px-2 py-1 text-[11px] font-semibold transition ${
                filtroTipo === t
                  ? 'border-[#004aad] bg-[#004aad] text-white'
                  : 'border-gray-200 bg-white text-gray-500 hover:border-gray-300'
              }`}
            >
              {t === 'todos' ? 'Todos' : TIPO_LABELS[t]}
            </button>
          ))}
        </div>

        {/* List */}
        <div className="flex flex-col gap-1.5 overflow-y-auto">
          {puntos.length === 0 && (
            <div className="rounded-2xl border border-dashed border-gray-200 bg-white p-6 text-center">
              <MapPin size={24} className="mx-auto mb-2 text-gray-300" />
              <p className="text-xs text-gray-500">No hay puntos creados.</p>
            </div>
          )}

          {puntosFiltrados.map((punto) => (
            <div
              key={punto.id}
              className={`rounded-xl border bg-white px-3 py-2.5 shadow-sm ${
                mode !== 'idle' ? 'pointer-events-none opacity-50' : ''
              }`}
            >
              <div className="flex items-start gap-2">
                <div
                  className="mt-0.5 h-2.5 w-2.5 shrink-0 rounded-full"
                  style={{ backgroundColor: punto.activo ? TIPO_COLORS[punto.tipo] : '#9ca3af' }}
                />
                <div className="min-w-0 flex-1">
                  <p className="truncate text-xs font-semibold text-gray-900">{punto.nombre}</p>
                  <p className="text-[11px] text-gray-500">{TIPO_LABELS[punto.tipo]}</p>
                  {punto.direccion && (
                    <p className="truncate text-[10px] text-gray-400">{punto.direccion}</p>
                  )}
                </div>
                <span className={`shrink-0 h-1.5 w-1.5 rounded-full mt-1 ${punto.activo ? 'bg-green-500' : 'bg-gray-300'}`} />
              </div>

              <div className="mt-1.5 flex items-center gap-1">
                <button
                  onClick={() => handleEditar(punto)}
                  className="flex items-center gap-1 rounded-lg border border-gray-200 px-2 py-1 text-[11px] font-medium text-gray-600 transition hover:bg-gray-50"
                >
                  <Pencil size={11} /> Editar
                </button>
                <button
                  onClick={() => handleToggle(punto)}
                  className="flex items-center gap-1 rounded-lg border border-gray-200 px-2 py-1 text-[11px] font-medium text-gray-600 transition hover:bg-gray-50"
                >
                  {punto.activo ? <EyeOff size={11} /> : <Eye size={11} />}
                  {punto.activo ? 'Desact.' : 'Activar'}
                </button>

                {confirmDeleteId === punto.id ? (
                  <span className="flex items-center gap-1 ml-auto">
                    <button
                      onClick={() => handleEliminar(punto)}
                      className="rounded-lg bg-red-500 px-2 py-1 text-[11px] font-semibold text-white transition hover:bg-red-600"
                    >
                      Confirmar
                    </button>
                    <button
                      onClick={() => setConfirmDeleteId(null)}
                      className="rounded-lg border border-gray-200 px-2 py-1 text-[11px] font-medium text-gray-500 transition hover:bg-gray-50"
                    >
                      No
                    </button>
                  </span>
                ) : (
                  <button
                    onClick={() => setConfirmDeleteId(punto.id)}
                    title="Eliminar"
                    className="ml-auto flex items-center rounded-lg border border-red-100 px-2 py-1 text-[11px] font-medium text-red-400 transition hover:bg-red-50 hover:text-red-600"
                  >
                    <Trash2 size={11} />
                  </button>
                )}
              </div>
            </div>
          ))}

          {busqueda && puntosFiltrados.length === 0 && (
            <p className="py-4 text-center text-xs text-gray-400">Sin resultados para "{busqueda}"</p>
          )}
        </div>
      </div>

      {/* Right panel: form + map */}
      <div className="relative flex min-h-0 flex-1 flex-col gap-3">

        {/* Form */}
        {mode !== 'idle' && (
          <div className="rounded-2xl border border-gray-200 bg-white p-4 shadow-sm">
            <div className="mb-3 flex items-center justify-between">
              <h2 className="text-sm font-bold text-gray-900">
                {mode === 'nueva' ? 'Nuevo punto logístico' : `Editando: ${draftNombre || '…'}`}
              </h2>
              <button
                onClick={handleCancelar}
                className="flex items-center gap-1 rounded-lg border border-gray-200 bg-white px-2 py-1.5 text-xs font-medium text-gray-600 transition hover:bg-gray-50"
              >
                <X size={12} /> Cancelar
              </button>
            </div>

            <div className="flex flex-wrap items-start gap-4">
              {/* Nombre */}
              <div className="min-w-[180px] flex-1">
                <label className="mb-1 block text-xs font-medium text-gray-700">
                  Nombre <span className="text-red-500">*</span>
                </label>
                <input
                  type="text"
                  value={draftNombre}
                  onChange={(e) => setDraftNombre(e.target.value)}
                  placeholder="Ej: Terminal Israel Lewites"
                  className="w-full rounded-lg border border-gray-200 bg-white px-3 py-2 text-sm outline-none focus:border-[#004aad]"
                />
              </div>

              {/* Tipo */}
              <div>
                <label className="mb-1 block text-xs font-medium text-gray-700">Tipo</label>
                <div className="flex gap-1 flex-wrap">
                  {(['terminal_bus', 'cargotrans', 'otro'] as TipoPuntoLogistico[]).map((t) => (
                    <button
                      key={t}
                      type="button"
                      onClick={() => setDraftTipo(t)}
                      className={`rounded-lg border px-2.5 py-1.5 text-xs font-semibold transition ${
                        draftTipo === t
                          ? 'border-[#004aad] bg-[#004aad] text-white'
                          : 'border-gray-200 bg-white text-gray-600 hover:border-gray-300'
                      }`}
                    >
                      {TIPO_LABELS[t]}
                    </button>
                  ))}
                </div>
              </div>

              {/* Prioridad */}
              <div>
                <label className="mb-1 block text-xs font-medium text-gray-700">Prioridad</label>
                <div className="flex gap-1">
                  {[1, 2, 3, 4, 5].map((n) => (
                    <button
                      key={n}
                      type="button"
                      onClick={() => setDraftPrioridad(n)}
                      className={`h-8 w-8 rounded-lg border text-xs font-bold transition ${
                        draftPrioridad === n
                          ? 'border-[#004aad] bg-[#004aad] text-white'
                          : 'border-gray-200 bg-white text-gray-600 hover:border-gray-300'
                      }`}
                    >
                      {n}
                    </button>
                  ))}
                </div>
              </div>
            </div>

            <div className="mt-3 flex flex-wrap gap-4">
              {/* Dirección */}
              <div className="min-w-[200px] flex-1">
                <label className="mb-1 block text-xs font-medium text-gray-700">Dirección</label>
                <input
                  type="text"
                  value={draftDireccion}
                  onChange={(e) => setDraftDireccion(e.target.value)}
                  placeholder="Ej: Frente al parque central"
                  className="w-full rounded-lg border border-gray-200 bg-white px-3 py-2 text-sm outline-none focus:border-[#004aad]"
                />
              </div>

              {/* Horario */}
              <div className="flex gap-2">
                <div>
                  <label className="mb-1 block text-xs font-medium text-gray-700">Apertura</label>
                  <input
                    type="time"
                    value={draftHorarioApertura}
                    onChange={(e) => setDraftHorarioApertura(e.target.value)}
                    className="rounded-lg border border-gray-200 bg-white px-3 py-2 text-sm outline-none focus:border-[#004aad]"
                  />
                </div>
                <div>
                  <label className="mb-1 block text-xs font-medium text-gray-700">Cierre</label>
                  <input
                    type="time"
                    value={draftHorarioCierre}
                    onChange={(e) => setDraftHorarioCierre(e.target.value)}
                    className="rounded-lg border border-gray-200 bg-white px-3 py-2 text-sm outline-none focus:border-[#004aad]"
                  />
                </div>
              </div>
            </div>

            {/* Destinos + Aliases (solo terminal_bus) */}
            {draftTipo === 'terminal_bus' && (
              <div className="mt-3 flex flex-wrap gap-4">
                <div className="min-w-[200px] flex-1">
                  <label className="mb-1 block text-xs font-medium text-gray-700">
                    Destinos <span className="text-gray-400 font-normal">(separados por coma)</span>
                  </label>
                  <input
                    type="text"
                    value={draftDestinos}
                    onChange={(e) => setDraftDestinos(e.target.value)}
                    placeholder="León, Chinandega, Corinto"
                    className="w-full rounded-lg border border-gray-200 bg-white px-3 py-2 text-sm outline-none focus:border-[#004aad]"
                  />
                </div>
                <div className="min-w-[180px] flex-1">
                  <label className="mb-1 block text-xs font-medium text-gray-700">
                    Aliases <span className="text-gray-400 font-normal">(nombres alternativos)</span>
                  </label>
                  <input
                    type="text"
                    value={draftAliases}
                    onChange={(e) => setDraftAliases(e.target.value)}
                    placeholder="Lewites, Terminal Occidente"
                    className="w-full rounded-lg border border-gray-200 bg-white px-3 py-2 text-sm outline-none focus:border-[#004aad]"
                  />
                </div>
              </div>
            )}

            {/* Notas */}
            <div className="mt-3">
              <label className="mb-1 block text-xs font-medium text-gray-700">Notas internas</label>
              <input
                type="text"
                value={draftNotas}
                onChange={(e) => setDraftNotas(e.target.value)}
                placeholder="Ej: Cobran C$5 por bulto en recepción"
                className="w-full rounded-lg border border-gray-200 bg-white px-3 py-2 text-sm outline-none focus:border-[#004aad]"
              />
            </div>

            {/* Coord indicator */}
            <div className="mt-3">
              {draftCoord ? (
                <span className="inline-flex items-center gap-1.5 rounded-lg border border-green-200 bg-green-50 px-3 py-1.5 text-xs font-medium text-green-700">
                  <Check size={13} /> Ubicación marcada ({draftCoord.lat.toFixed(5)}, {draftCoord.lng.toFixed(5)})
                </span>
              ) : (
                <span className="inline-flex items-center gap-1.5 rounded-lg border border-orange-200 bg-orange-50 px-3 py-1.5 text-xs font-medium text-orange-700">
                  <MapPin size={13} /> Haz clic en el mapa para marcar la ubicación
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
                {saving ? 'Guardando…' : mode === 'nueva' ? 'Crear punto' : 'Guardar cambios'}
              </button>
            </div>
          </div>
        )}

        {/* Map */}
        <div className="relative min-h-0 flex-1 overflow-hidden rounded-2xl border border-gray-200 shadow-sm">
          {!mapReady && (
            <div className="absolute inset-0 z-10 flex items-center justify-center bg-gray-50">
              <div className="flex items-center gap-2 text-sm text-gray-500">
                <Loader2 size={16} className="animate-spin" /> Cargando mapa…
              </div>
            </div>
          )}
          <div ref={containerRef} className="h-full w-full" />

          {/* Map controls */}
          <div className="absolute left-3 top-3 z-10 flex gap-2">
            <button
              onClick={() => setSatelite((v) => !v)}
              className={`flex items-center gap-1.5 rounded-xl border px-3 py-1.5 text-xs font-semibold shadow-sm backdrop-blur-sm transition ${satelite ? 'border-blue-300 bg-blue-600 text-white' : 'border-gray-200 bg-white/95 text-gray-700 hover:bg-gray-50'}`}
            >
              <Satellite size={13} />
              Satélite
            </button>
          </div>

          {/* Legend */}
          {mode === 'idle' && puntos.filter((p) => p.activo).length > 0 && (
            <div className="absolute bottom-4 right-4 rounded-xl border border-gray-200 bg-white/95 p-2.5 shadow-sm backdrop-blur-sm">
              <p className="mb-1.5 text-[10px] font-semibold uppercase tracking-wide text-gray-500">Leyenda</p>
              {(['terminal_bus', 'cargotrans', 'otro'] as TipoPuntoLogistico[]).map((t) => (
                <div key={t} className="flex items-center gap-1.5 py-0.5">
                  <div className="h-2.5 w-2.5 rounded-full" style={{ backgroundColor: TIPO_COLORS[t] }} />
                  <span className="text-[11px] text-gray-700">{TIPO_LABELS[t]}</span>
                </div>
              ))}
            </div>
          )}

          {/* Instruction when editing */}
          {mode !== 'idle' && (
            <div className="pointer-events-none absolute bottom-4 left-1/2 -translate-x-1/2 rounded-xl bg-gray-900/85 px-4 py-2 text-center text-xs text-white backdrop-blur-sm">
              Haz clic en el mapa para {draftCoord ? 'mover' : 'marcar'} la ubicación del punto
            </div>
          )}
        </div>
      </div>
    </div>
  )
}
