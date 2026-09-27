'use client'

// MOTO-PRESENCIA-UX-1 — control de presencia del motorizado, dentro del menú de
// perfil (bottom sheet móvil y pie del sidebar de escritorio). Es el ÚNICO lugar que
// cambia la presencia desde el panel; la página solo muestra el indicador. Toda la
// decisión (qué acción ofrecer, cuándo confirmar) vive en lib/motorizado-presencia.ts.
//
// MOTO-RANKING-UBICACION-FRESCA-1 — la escritura ya no es un updateDoc directo:
// pasa por la callable actualizarPresenciaMotorizado, que además sella
// `presenciaUpdatedAt` (server-side) para que el ranking sepa si la última
// ubicación operativa es de esta sesión de presencia o de una anterior.

import { useCallback, useEffect, useRef, useState } from 'react'
import { collection, limit, onSnapshot, query, where } from 'firebase/firestore'
import { httpsCallable } from 'firebase/functions'
import { db, functions } from '@/fb/config'
import { useUser } from '@/app/Components/UserProvider'
import {
  COPY_CONFIRMAR_FUERA_DE_LINEA,
  accionPresencia,
  aplicarPresencia,
  etiquetaPresencia,
  esMotorizadoEnLinea,
  pulsarPresencia,
  type PresenciaEscribible,
} from '@/lib/motorizado-presencia'

const actualizarPresenciaCallable = httpsCallable<
  { estado: PresenciaEscribible },
  { ok: true; estado: PresenciaEscribible }
>(functions, 'actualizarPresenciaMotorizado')

function usePresencia() {
  const { authUser } = useUser()
  const uid = authUser?.uid ?? null
  const [docId, setDocId] = useState<string | null>(null)
  const [estado, setEstado] = useState<unknown>(undefined)
  const [cambiando, setCambiando] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const enCurso = useRef(false)

  useEffect(() => {
    if (!uid) { setDocId(null); setEstado(undefined); return }
    const q = query(collection(db, 'motorizado'), where('authUid', '==', uid), limit(1))
    return onSnapshot(q, (s) => {
      if (s.empty) return
      setDocId(s.docs[0].id)
      setEstado((s.docs[0].data() as { estado?: unknown }).estado)
    })
  }, [uid])

  const escribir = useCallback(async (destino: PresenciaEscribible) => {
    // El servidor resuelve el documento por authUid: no depende de que `docId`
    // ya haya llegado del listener (aunque el botón sigue deshabilitado sin él).
    await actualizarPresenciaCallable({ estado: destino })
  }, [])

  const cambiar = useCallback(async (destino: PresenciaEscribible) => {
    if (enCurso.current) return false // sin doble envío
    enCurso.current = true
    setCambiando(true); setError(null)
    try {
      const r = await aplicarPresencia(escribir, destino)
      // La UI sigue mostrando el estado anterior hasta que Firestore lo confirme.
      if (!r.ok) setError('No se pudo cambiar tu estado. Probá de nuevo.')
      return r.ok
    } finally {
      enCurso.current = false
      setCambiando(false)
    }
  }, [escribir])

  return { docId, estado, cambiando, error, cambiar }
}

export default function ControlPresencia({ variante }: { variante: 'sheet' | 'sidebar' }) {
  const { docId, estado, cambiando, error, cambiar } = usePresencia()
  const [confirmando, setConfirmando] = useState<PresenciaEscribible | null>(null)
  const accion = accionPresencia(estado)
  const enLinea = esMotorizadoEnLinea(estado)

  useEffect(() => {
    if (!confirmando) return
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') setConfirmando(null) }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [confirmando])

  async function pulsar() {
    const paso = pulsarPresencia(estado)
    if (paso.tipo === 'confirmar') { setConfirmando(paso.destino); return }
    await cambiar(paso.destino)
  }

  async function confirmar() {
    if (!confirmando) return
    const ok = await cambiar(confirmando)
    if (ok) setConfirmando(null)
  }

  const punto = enLinea ? '#16a34a' : '#9ca3af'
  const sheet = variante === 'sheet'

  return (
    <div style={{ marginBottom: sheet ? 12 : 8 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, padding: sheet ? '0 4px' : '0 12px', marginBottom: 6 }}>
        <span style={{ width: 8, height: 8, borderRadius: '50%', background: punto, display: 'inline-block', flexShrink: 0 }} />
        <span style={{ fontSize: sheet ? 14 : 12, fontWeight: 600, color: '#374151' }}>
          Estado: {etiquetaPresencia(estado)}
        </span>
      </div>
      <button
        type="button"
        onClick={pulsar}
        disabled={cambiando || !docId}
        style={{
          display: 'block', width: '100%', textAlign: sheet ? 'left' : 'center',
          padding: sheet ? '12px 4px' : '8px 12px', border: sheet ? 'none' : '1px solid #e5e7eb',
          background: 'transparent', borderRadius: 12, fontSize: sheet ? 15 : 13, fontWeight: 600,
          color: '#004aad', cursor: cambiando || !docId ? 'not-allowed' : 'pointer',
          opacity: cambiando || !docId ? 0.6 : 1,
        }}
      >
        {accion.etiqueta}
      </button>
      {error && !confirmando && (
        <p role="alert" style={{ margin: '4px 4px 0', fontSize: 12, color: '#dc2626' }}>{error}</p>
      )}

      {confirmando && (
        <div style={{ position: 'fixed', inset: 0, zIndex: 300, display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 20 }}>
          <div
            onClick={() => { if (!cambiando) setConfirmando(null) }}
            style={{ position: 'absolute', inset: 0, background: 'rgba(0,0,0,0.5)' }}
          />
          <div
            role="dialog"
            aria-modal="true"
            aria-labelledby="presencia-confirmar-titulo"
            aria-describedby="presencia-confirmar-texto"
            style={{ position: 'relative', background: '#fff', borderRadius: 16, padding: 20, maxWidth: 360, width: '100%' }}
          >
            <h2 id="presencia-confirmar-titulo" style={{ margin: 0, fontSize: 17, fontWeight: 700, color: '#111827' }}>
              {COPY_CONFIRMAR_FUERA_DE_LINEA.titulo}
            </h2>
            <p id="presencia-confirmar-texto" style={{ margin: '10px 0 16px', fontSize: 14, color: '#4b5563', lineHeight: 1.5 }}>
              {COPY_CONFIRMAR_FUERA_DE_LINEA.texto}
            </p>
            {error && <p role="alert" style={{ margin: '0 0 12px', fontSize: 13, color: '#dc2626' }}>{error}</p>}
            <div style={{ display: 'flex', gap: 8 }}>
              <button
                type="button"
                autoFocus
                onClick={() => setConfirmando(null)}
                disabled={cambiando}
                style={{ flex: 1, padding: '11px 0', border: '1px solid #e5e7eb', borderRadius: 12, background: '#fff', color: '#374151', fontSize: 14, fontWeight: 600, cursor: 'pointer' }}
              >
                {COPY_CONFIRMAR_FUERA_DE_LINEA.cancelar}
              </button>
              <button
                type="button"
                onClick={confirmar}
                disabled={cambiando}
                style={{ flex: 1, padding: '11px 0', border: 'none', borderRadius: 12, background: '#dc2626', color: '#fff', fontSize: 14, fontWeight: 700, cursor: cambiando ? 'not-allowed' : 'pointer', opacity: cambiando ? 0.6 : 1 }}
              >
                {COPY_CONFIRMAR_FUERA_DE_LINEA.confirmar}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
