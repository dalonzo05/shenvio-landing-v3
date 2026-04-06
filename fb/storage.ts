import { ref, uploadBytes, getDownloadURL } from 'firebase/storage'
import { storage } from './config'

export type TipoEvidencia = 'retiro' | 'entrega' | 'deposito'

/**
 * Compresses an image file to max 1200px (longest side), JPEG, quality 0.75.
 * Uses createImageBitmap + canvas — no external library needed.
 */
export async function compressImage(file: File): Promise<Blob> {
  const img = await createImageBitmap(file)
  const MAX = 1200
  const scale = Math.min(1, MAX / Math.max(img.width, img.height))
  const w = Math.round(img.width * scale)
  const h = Math.round(img.height * scale)
  const canvas = document.createElement('canvas')
  canvas.width = w
  canvas.height = h
  canvas.getContext('2d')!.drawImage(img, 0, 0, w, h)
  return new Promise<Blob>((resolve, reject) => {
    canvas.toBlob(
      (blob) => (blob ? resolve(blob) : reject(new Error('compressImage: toBlob failed'))),
      'image/jpeg',
      0.75,
    )
  })
}

/**
 * Uploads a compressed image blob to Firebase Storage under
 * evidencias/{solicitudId}/{tipo}.jpg and returns the public download URL
 * and the storage path (for later deletion).
 */
export async function uploadEvidencia(
  solicitudId: string,
  tipo: TipoEvidencia,
  blob: Blob,
): Promise<{ url: string; pathStorage: string }> {
  const pathStorage = `evidencias/${solicitudId}/${tipo}.jpg`
  const storageRef = ref(storage, pathStorage)
  await uploadBytes(storageRef, blob, { contentType: 'image/jpeg' })
  const url = await getDownloadURL(storageRef)
  return { url, pathStorage }
}
