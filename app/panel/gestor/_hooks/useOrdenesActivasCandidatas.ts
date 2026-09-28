'use client'

// MOTO-RANKING-DATOS-REALTIME-1 — órdenes activas en tiempo real, para el
// cálculo de carga y próximo punto operativo del ranking. El listado principal
// (app/panel/gestor/solicitudes/page.tsx) ya usaba onSnapshot para esto; este
// hook extrae exactamente esa misma consulta para reutilizarla también en el
// Drawer y en el detalle, que hasta ahora la leían una sola vez con getDocs.
//
// Una sola fuente global (no una query por rider): el ranking sigue
// filtrando/calculando localmente sobre este array, igual que antes.

import { useEffect, useState } from 'react'
import { collection, onSnapshot, query, where } from 'firebase/firestore'
import { db } from '@/fb/config'
import type { OrdenActivaRanking } from '@/lib/motorizado-ranking'

/** Mismos estados que ESTADOS_ACTIVOS en lib/motorizado-ranking.ts. */
export const ESTADOS_ORDEN_ACTIVA = ['asignada', 'en_camino_retiro', 'retirado', 'en_camino_entrega'] as const

export interface EstadoOrdenesActivasRealtime {
  ordenesActivas: OrdenActivaRanking[]
  cargando: boolean
  error: boolean
}

export function useOrdenesActivasCandidatas(): EstadoOrdenesActivasRealtime {
  const [ordenesActivas, setOrdenesActivas] = useState<OrdenActivaRanking[]>([])
  const [cargando, setCargando] = useState(true)
  const [error, setError] = useState(false)

  useEffect(() => {
    setCargando(true)
    setError(false)
    const unsub = onSnapshot(
      query(collection(db, 'solicitudes_envio'), where('estado', 'in', [...ESTADOS_ORDEN_ACTIVA])),
      (snap) => {
        setOrdenesActivas(snap.docs.map((d) => ({ id: d.id, ...(d.data() as Record<string, unknown>) })) as OrdenActivaRanking[])
        setCargando(false)
      },
      () => {
        setError(true)
        setCargando(false)
      },
    )
    return () => unsub()
  }, [])

  return { ordenesActivas, cargando, error }
}
