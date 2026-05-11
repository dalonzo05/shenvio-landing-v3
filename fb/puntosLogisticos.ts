import { db } from '@/fb/config'
import {
  collection,
  addDoc,
  updateDoc,
  doc,
  getDocs,
  onSnapshot,
  query,
  orderBy,
  serverTimestamp,
} from 'firebase/firestore'
import type { PuntoLogistico } from '@/lib/puntosLogisticos'

const COLECCION = 'puntosLogisticos'

function docToPunto(id: string, data: any): PuntoLogistico {
  return {
    id,
    nombre:          data.nombre          ?? '',
    tipo:            data.tipo            ?? 'otro',
    coord:           data.coord           ?? { lat: 12.1364, lng: -86.2514 },
    direccion:       data.direccion       ?? '',
    horarioApertura: data.horarioApertura ?? '',
    horarioCierre:   data.horarioCierre   ?? '',
    notas:           data.notas           ?? '',
    activo:          data.activo          ?? true,
    prioridad:       data.prioridad       ?? 1,
    destinos:        data.destinos        ?? [],
    aliases:         data.aliases         ?? [],
    createdAt:       data.createdAt       ?? null,
    updatedAt:       data.updatedAt       ?? null,
    creadoPorUid:    data.creadoPorUid    ?? undefined,
  }
}

/** Listener en tiempo real de TODOS los puntos (activos e inactivos). */
export function onPuntosSnapshot(
  cb: (puntos: PuntoLogistico[]) => void,
  onErr?: (err: Error) => void,
): () => void {
  const q = query(collection(db, COLECCION), orderBy('prioridad', 'desc'))
  return onSnapshot(
    q,
    (snap) => cb(snap.docs.map((d) => docToPunto(d.id, d.data()))),
    (err) => {
      console.warn('[puntosLogisticos] snapshot error:', err.code, err.message)
      onErr?.(err)
    },
  )
}

/** Fetch puntual de puntos activos. Para el flujo de creación de órdenes. */
export async function getPuntosActivos(): Promise<PuntoLogistico[]> {
  try {
    const q = query(collection(db, COLECCION), orderBy('prioridad', 'desc'))
    const snap = await getDocs(q)
    return snap.docs.map((d) => docToPunto(d.id, d.data())).filter((p) => p.activo)
  } catch (err) {
    console.error('[fb/puntosLogisticos] getPuntosActivos error:', err)
    return []
  }
}

export async function crearPunto(
  data: Omit<PuntoLogistico, 'id' | 'createdAt' | 'updatedAt'>,
  uid: string,
): Promise<string> {
  const ref = await addDoc(collection(db, COLECCION), {
    ...data,
    creadoPorUid: uid,
    createdAt: serverTimestamp(),
    updatedAt: serverTimestamp(),
  })
  return ref.id
}

export async function actualizarPunto(
  id: string,
  data: Partial<Omit<PuntoLogistico, 'id' | 'createdAt'>>,
): Promise<void> {
  await updateDoc(doc(db, COLECCION, id), { ...data, updatedAt: serverTimestamp() })
}

export async function togglePuntoActivo(id: string, activo: boolean): Promise<void> {
  await updateDoc(doc(db, COLECCION, id), { activo, updatedAt: serverTimestamp() })
}

export async function eliminarPunto(id: string): Promise<void> {
  const { deleteDoc } = await import('firebase/firestore')
  await deleteDoc(doc(db, COLECCION, id))
}
