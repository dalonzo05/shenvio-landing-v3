'use client'
// MAP-UX-2 — Resolución y etiquetado de puntos para los flujos de creación de
// orden (Comercio "Solicitar envío" y Gestor "Ingresar orden").
//
// Es una capa FINA sobre piezas ya validadas en CALC-UX-1: no reimplementa
// nada. El parser de lat,lng y el decodificador de Plus Codes viven en
// lib/puntoUbicacion.ts; la clasificación territorial, en
// clasificarPuntoEnZona() de lib/zonas.ts. Acá solo se combinan.
//
// LÍMITE DELIBERADO (ver MAP-UX-2, sección 7): esto produce presentación, no
// datos de negocio. El `labelVisible` NUNCA debe escribirse en
// `direccionEscrita` (texto humano, obligatorio y editable por el usuario) ni
// en `geocodeGoogle` (que conserva su semántica: resultado de Google, o null).
// La clasificación territorial ya se persiste aparte en
// zonaRetiro*/zonaEntrega*/macroZona*.

import { useCallback } from 'react'
import { clasificarPuntoEnZona, type ZonaGeografica } from '@/lib/zonas'
import {
  interpretarEntrada,
  pareceOpenLocationCode,
  etiquetaPuntoManual,
  etiquetaMiUbicacion,
  type Coord,
} from '@/lib/puntoUbicacion'

/** Forma `lat,lng`: dos números separados por coma y nada más. */
const FORMA_COORDENADAS = /^\s*-?\d{1,3}(?:\.\d+)?\s*,\s*-?\d{1,3}(?:\.\d+)?\s*$/

/**
 * ¿El texto PRETENDE ser una entrada directa (Plus Code o `lat,lng`)?
 * Distinto de resolverla: "Managua, Nicaragua" no la parece, pero
 * "12.999, -999" y un Plus Code con dígitos inválidos sí — y esos son los
 * únicos casos donde tiene sentido avisar, porque Google Places tampoco
 * los va a resolver.
 */
export function pareceEntradaDirecta(texto: string): boolean {
  return pareceOpenLocationCode(texto) || FORMA_COORDENADAS.test(texto)
}

export type TipoOrigenPunto = 'google' | 'pluscode' | 'coordenadas' | 'mapa' | 'ubicacion'

export interface PuntoResuelto {
  coord: Coord
  labelVisible: string
  zona: string | null
  macrozona: string | null
  tipoOrigen: TipoOrigenPunto
}

/** Mensaje único para una entrada que no es dirección, Plus Code ni coordenadas. */
export const MSG_ENTRADA_NO_RESUELTA =
  'No pudimos resolver esa ubicación. Probá buscar un lugar, pegar un Plus Code o ingresar latitud,longitud.'

export function useResolucionPunto(zonas: ZonaGeografica[]) {
  /** Zona pequeña y macrozona de un punto — clasificador único, sin duplicar. */
  const zonasDe = useCallback(
    (coord: Coord): { zona: string | null; macrozona: string | null } => {
      if (zonas.length === 0) return { zona: null, macrozona: null }
      return {
        zona: clasificarPuntoEnZona(coord, zonas, 'zona')?.nombre ?? null,
        macrozona: clasificarPuntoEnZona(coord, zonas, 'macrozona')?.nombre ?? null,
      }
    },
    [zonas],
  )

  /** Etiqueta de un punto marcado a mano. Cae a coordenadas legibles si no hay polígono. */
  const etiquetarManual = useCallback(
    (coord: Coord): string => {
      const { zona, macrozona } = zonasDe(coord)
      return etiquetaPuntoManual(coord, zona ?? macrozona)
    },
    [zonasDe],
  )

  /** Punto elegido con un clic/arrastre en el mapa. */
  const resolverPuntoMapa = useCallback(
    (coord: Coord): PuntoResuelto => {
      const { zona, macrozona } = zonasDe(coord)
      return {
        coord,
        labelVisible: etiquetaPuntoManual(coord, zona ?? macrozona),
        zona,
        macrozona,
        tipoOrigen: 'mapa',
      }
    },
    [zonasDe],
  )

  /**
   * Texto escrito a mano: Plus Code o `lat,lng`. Devuelve null cuando NO es
   * una entrada directa — ahí el flujo normal de Google Places sigue su curso.
   */
  const resolverTexto = useCallback(
    (texto: string): PuntoResuelto | null => {
      const entrada = interpretarEntrada(texto)
      if (entrada.tipo === 'texto') return null
      const { zona, macrozona } = zonasDe(entrada.coord)
      return {
        coord: entrada.coord,
        labelVisible: etiquetaPuntoManual(entrada.coord, zona ?? macrozona),
        zona,
        macrozona,
        tipoOrigen: entrada.tipo === 'pluscode' ? 'pluscode' : 'coordenadas',
      }
    },
    [zonasDe],
  )

  /**
   * Resultado elegido en Google Places. El nombre de Google se respeta como
   * etiqueta: fue una elección explícita del usuario, no una suposición.
   */
  const resolverGoogle = useCallback(
    (coord: Coord, textoGoogle: string): PuntoResuelto => {
      const { zona, macrozona } = zonasDe(coord)
      const limpio = textoGoogle.trim()
      return {
        coord,
        labelVisible: limpio || etiquetaPuntoManual(coord, zona ?? macrozona),
        zona,
        macrozona,
        tipoOrigen: 'google',
      }
    },
    [zonasDe],
  )

  /** Preparado para "Mi ubicación" — hoy ningún flujo de orden lo ofrece. */
  const resolverMiUbicacion = useCallback(
    (coord: Coord): PuntoResuelto => {
      const { zona, macrozona } = zonasDe(coord)
      return {
        coord,
        labelVisible: etiquetaMiUbicacion(coord, zona ?? macrozona),
        zona,
        macrozona,
        tipoOrigen: 'ubicacion',
      }
    },
    [zonasDe],
  )

  return {
    zonasDe,
    etiquetarManual,
    resolverPuntoMapa,
    resolverTexto,
    resolverGoogle,
    resolverMiUbicacion,
  }
}
