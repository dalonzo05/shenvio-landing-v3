'use client'

// MOTO-RANKING-DATOS-REALTIME-1 — cruzar el día operativo de Managua, sin que
// cambie ningún documento de Firestore, debe invalidar una `ultimaUbicacionOperativa`
// del día anterior (MOTO-RANKING-UBICACION-FRESCA-1: la frescura exige "hoy").
// Un onSnapshot no dispara solo porque pasó la medianoche de Nicaragua — hace
// falta una referencia de tiempo que se actualice sola, de muy baja frecuencia
// (no es polling de datos: no lee Firestore, solo refresca `Date.now()`).
//
// Se usa como argumento `ahoraMs` de rankearMotorizados/calcularScore, que ya lo
// admiten (MOTO-RANKING-UBICACION-FRESCA-1); y como dependencia de los useMemo
// del ranking, para forzar la recomputación cuando cambia.

import { useEffect, useState } from 'react'

/** 5 minutos: suficiente para no perder el cruce de día, sin recalcular por nada. */
export const INTERVALO_TICK_OPERATIVO_MS = 5 * 60 * 1000

export function useTickOperativo(intervaloMs: number = INTERVALO_TICK_OPERATIVO_MS): number {
  const [ahoraMs, setAhoraMs] = useState<number>(() => Date.now())

  useEffect(() => {
    const id = setInterval(() => setAhoraMs(Date.now()), intervaloMs)
    return () => clearInterval(id)
  }, [intervaloMs])

  return ahoraMs
}
