'use client'

// MOTO-RANKING-DATOS-REALTIME-1 — roster de motorizados en tiempo real.
//
// Antes, cada superficie de asignación (Drawer, detalle, listado) leía la
// colección `motorizado` una sola vez con getDocs, al montar. Si un rider
// cambiaba de presencia, ubicación operativa o cualquier otro campo mientras
// la pantalla ya estaba abierta, esa lectura quedaba stale hasta refrescar la
// página — el ranking seguía usando el snapshot viejo aunque el candidato ya
// no fuera elegible (o uno nuevo ya lo fuera).
//
// Un único listener global por montaje de esta pantalla, reutilizable: no hay
// N+1 (nunca un listener por rider), y el guard server-side de
// asignarMotorizado (MOTO-ASIGNACION-ELEGIBILIDAD-GUARD-1) sigue siendo la
// autoridad final — esto solo evita que la UI muestre candidatos viejos.

import { useEffect, useState } from 'react'
import { collection, onSnapshot, query } from 'firebase/firestore'
import { db } from '@/fb/config'
import type { MotorizadoConRanking } from '@/lib/motorizado-ranking'

export interface EstadoMotorizadosRealtime {
  motorizados: MotorizadoConRanking[]
  /** true mientras no llegó el primer snapshot. */
  cargando: boolean
  /** true si el listener falló. No hay fallback: con error, no hay candidatos. */
  error: boolean
}

export function useMotorizadosCandidatos(): EstadoMotorizadosRealtime {
  const [motorizados, setMotorizados] = useState<MotorizadoConRanking[]>([])
  const [cargando, setCargando] = useState(true)
  const [error, setError] = useState(false)

  useEffect(() => {
    setCargando(true)
    setError(false)
    const unsub = onSnapshot(
      query(collection(db, 'motorizado')),
      (snap) => {
        setMotorizados(snap.docs.map((d) => ({ id: d.id, ...(d.data() as Record<string, unknown>) })) as MotorizadoConRanking[])
        setCargando(false)
      },
      () => {
        setError(true)
        setCargando(false)
      },
    )
    return () => unsub()
  }, [])

  return { motorizados, cargando, error }
}
