import { db } from '@/fb/config'
import {
  collection,
  addDoc,
  updateDoc,
  doc,
  getDocs,
  onSnapshot,
  query,
  where,
  orderBy,
  serverTimestamp,
} from 'firebase/firestore'
import type { ZonaGeografica } from '@/lib/zonas'

const COLECCION = 'zonas'

function docToZona(id: string, data: any): ZonaGeografica {
  return {
    id,
    nombre: data.nombre ?? '',
    color: data.color ?? '#6366f1',
    poligono: data.poligono ?? [],
    activa: data.activa ?? true,
    prioridad: data.prioridad ?? 99,
    descripcion: data.descripcion ?? undefined,
    createdAt: data.createdAt ?? null,
    updatedAt: data.updatedAt ?? null,
    creadoPorUid: data.creadoPorUid ?? undefined,
  }
}

/**
 * Fetch puntual de zonas activas ordenadas por prioridad ASC.
 * Usar en el flujo de creación de órdenes.
 * Retorna [] ante cualquier error, sin lanzar excepción.
 */
export async function getZonasActivas(): Promise<ZonaGeografica[]> {
  try {
    const q = query(
      collection(db, COLECCION),
      where('activa', '==', true),
      orderBy('prioridad', 'desc')
    )
    const snap = await getDocs(q)
    return snap.docs.map((d) => docToZona(d.id, d.data()))
  } catch (err) {
    console.error('[fb/zonas] getZonasActivas error:', err)
    return []
  }
}

/**
 * Listener real-time de TODAS las zonas (activas e inactivas).
 * Para la UI de administración del gestor.
 * Retorna la función de unsubscribe.
 */
export function onZonasSnapshot(cb: (zonas: ZonaGeografica[]) => void): () => void {
  const q = query(collection(db, COLECCION), orderBy('prioridad', 'desc'))
  return onSnapshot(q, (snap) => {
    const zonas = snap.docs.map((d) => docToZona(d.id, d.data()))
    cb(zonas)
  })
}

/**
 * Crea una zona nueva. Retorna el ID del documento creado.
 */
export async function crearZona(
  data: Omit<ZonaGeografica, 'id' | 'createdAt' | 'updatedAt'>,
  uid: string
): Promise<string> {
  const ref = await addDoc(collection(db, COLECCION), {
    nombre: data.nombre,
    color: data.color,
    poligono: data.poligono,
    activa: data.activa,
    prioridad: data.prioridad,
    descripcion: data.descripcion ?? null,
    creadoPorUid: uid,
    createdAt: serverTimestamp(),
    updatedAt: serverTimestamp(),
  })
  return ref.id
}

/**
 * Actualiza campos parciales de una zona.
 */
export async function actualizarZona(
  id: string,
  data: Partial<Omit<ZonaGeografica, 'id' | 'createdAt'>>
): Promise<void> {
  await updateDoc(doc(db, COLECCION, id), {
    ...data,
    updatedAt: serverTimestamp(),
  })
}

/**
 * Activa o desactiva una zona.
 * Las zonas nunca se borran físicamente; se desactivan para preservar referencias históricas.
 */
export async function toggleZonaActiva(id: string, activa: boolean): Promise<void> {
  await updateDoc(doc(db, COLECCION, id), {
    activa,
    updatedAt: serverTimestamp(),
  })
}
