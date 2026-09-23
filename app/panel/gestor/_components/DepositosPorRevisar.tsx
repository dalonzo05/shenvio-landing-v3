'use client'
// DEPOSITOS-ALERTA-REVISION-1 — una sola fuente para "depósitos por revisar".
//
// Dos superficies necesitan el mismo número: el badge del sidebar (que lo pinta
// el layout) y el banner del dashboard (que lo pinta la página). Sin esto cada
// una abriría su propia query sobre los mismos documentos, que es justo lo que
// no queremos. Así que el listener vive UNA vez en el layout —vía el hook— y el
// mismo número baja a la página por contexto.
//
// La query es chica y completa: `estado == 'en_revision'`, sin limit — un aviso
// operativo no puede depender del recorte de un historial. El filtro por tipo
// (A/B del motorizado, nunca el tipo C) lo aplica el helper puro, que además
// deduplica por id.
//
// Solo gestor/admin: las Rules dejan a un digitador listar únicamente lo que él
// digitó, así que para ese rol no se abre el listener —igual que hacen los
// badges de cobros y solicitudes—.

import { createContext, useContext, useEffect, useMemo, useState } from 'react'
import { collection, onSnapshot, query, where } from 'firebase/firestore'
import { db } from '@/fb/config'
import type { DepositoRegistrado } from '@/lib/deposito-orden'
import {
  cantidadDepositosPorRevisarGestor,
  ESTADO_POR_REVISAR_GESTOR,
} from '@/lib/revision-depositos-gestor'

/**
 * Abre el listener y devuelve cuántos depósitos esperan revisión.
 *
 * @param activo false mientras no haya rol autorizado, o para roles que no
 *               revisan depósitos: entonces no se abre ninguna query.
 */
export function useContarDepositosPorRevisar(activo: boolean): number {
  const [docs, setDocs] = useState<DepositoRegistrado[]>([])
  useEffect(() => {
    if (!activo) { setDocs([]); return }
    const q = query(collection(db, 'ordenes_deposito'), where('estado', '==', ESTADO_POR_REVISAR_GESTOR))
    return onSnapshot(q,
      (snap) => setDocs(snap.docs.map((d) => ({ id: d.id, ...(d.data() as object) } as DepositoRegistrado))),
      (e) => {
        // Callback explícito: sin él el SDK trata el fallo como no manejado. Se
        // deja el contador en 0 en vez de afirmar un número que no se pudo leer.
        console.warn('[gestor] listener de depósitos por revisar detenido:', (e as { code?: string }).code)
        setDocs([])
      },
    )
  }, [activo])
  return useMemo(() => cantidadDepositosPorRevisarGestor(docs), [docs])
}

const ContextoDepositosPorRevisar = createContext<number>(0)

/** Cuántos depósitos esperan revisión del gestor. 0 cuando no hay o no aplica. */
export function useDepositosPorRevisar(): number {
  return useContext(ContextoDepositosPorRevisar)
}

/** Baja el número que el layout ya calculó, sin abrir una segunda query. */
export function DepositosPorRevisarProvider({
  valor,
  children,
}: {
  valor: number
  children: React.ReactNode
}) {
  return (
    <ContextoDepositosPorRevisar.Provider value={valor}>
      {children}
    </ContextoDepositosPorRevisar.Provider>
  )
}
