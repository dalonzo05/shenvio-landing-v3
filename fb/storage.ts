import { ref, uploadBytes, getDownloadURL } from 'firebase/storage'
import { storage } from './config'

export type TipoEvidencia =
  | 'retiro'
  | 'entrega'
  | 'deposito'
  | 'terminal_bus'      // foto del bus/transporte
  | 'terminal_paquete'  // foto del paquete en terminal
  | 'terminal_ticket'   // foto del ticket de terminal
  | 'peaje'             // comprobante de peaje reportado por motorizado

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

/**
 * Uploads a deposit boucher (group receipt) to Firebase Storage under
 * depositos/{motorizadoAuthUid}/{depositoId}/boucher.jpg
 *
 * El Auth UID del motorizado va en el PATH, no solo en el documento, porque
 * es la única fuente de pertenencia que Storage Rules puede verificar en la
 * PRIMERA subida. El flujo real genera el depositoId, sube el boucher y solo
 * después crea ordenes_deposito/{depositoId}: en el instante en que la regla
 * decide, el documento todavía no existe, así que no hay nada contra qué
 * comparar. Con el UID en el path, la regla contrasta ese segmento contra
 * request.auth.uid y la pertenencia queda establecida por Auth, no por datos
 * que el cliente escribe.
 *
 * El UID debe venir siempre de una fuente autenticada o ya resuelta por el
 * flujo (auth.currentUser.uid en el panel del motorizado;
 * asignacion.motorizadoAuthUid o el propio depósito en el panel del gestor).
 * Nunca del motorizadoId interno, del nombre ni del teléfono.
 */
export async function uploadDepositoBoucher(
  motorizadoAuthUid: string,
  depositoId: string,
  blob: Blob,
): Promise<{ url: string; pathStorage: string }> {
  // Un UID vacío produciría 'depositos//{id}/boucher.jpg', que ya no cae en el
  // match de 3 segmentos y sería denegado por la regla catch-all. Fallar acá
  // da un error entendible en vez de un permission-denied opaco.
  if (!motorizadoAuthUid) {
    throw new Error('uploadDepositoBoucher: falta el Auth UID del motorizado')
  }
  const pathStorage = `depositos/${motorizadoAuthUid}/${depositoId}/boucher.jpg`
  const storageRef = ref(storage, pathStorage)
  await uploadBytes(storageRef, blob, { contentType: 'image/jpeg' })
  const url = await getDownloadURL(storageRef)
  return { url, pathStorage }
}

/**
 * Uploads a blob to an arbitrary Storage path (useful for indexed items like cargotrans packages).
 */
export async function uploadEvidenciaPath(
  path: string,
  blob: Blob,
): Promise<{ url: string; pathStorage: string }> {
  const storageRef = ref(storage, path)
  await uploadBytes(storageRef, blob, { contentType: 'image/jpeg' })
  const url = await getDownloadURL(storageRef)
  return { url, pathStorage: path }
}

/**
 * Uploads a comprobante/boucher image for an abono a saldo.
 * Path: saldos/{saldoId}/abono_{index}.jpg
 */
export async function uploadComprobante(
  saldoId: string,
  index: number,
  blob: Blob,
): Promise<{ url: string; pathStorage: string }> {
  const pathStorage = `saldos/${saldoId}/abono_${index}.jpg`
  const storageRef = ref(storage, pathStorage)
  await uploadBytes(storageRef, blob, { contentType: 'image/jpeg' })
  const url = await getDownloadURL(storageRef)
  return { url, pathStorage }
}

/**
 * Uploads a liquidacion PDF to Firebase Storage.
 * Path: liquidaciones/{liquidacionId}/comprobante.pdf
 */
export async function uploadLiquidacionPDF(
  liquidacionId: string,
  blob: Blob,
): Promise<{ url: string; pathStorage: string }> {
  const pathStorage = `liquidaciones/${liquidacionId}/comprobante.pdf`
  const storageRef = ref(storage, pathStorage)
  await uploadBytes(storageRef, blob, { contentType: 'application/pdf' })
  const url = await getDownloadURL(storageRef)
  return { url, pathStorage }
}

/**
 * Uploads a motorizado profile photo to Firebase Storage under
 * motorizados/{motorizadoId}/foto.jpg
 */
export async function uploadFotoMotorizado(
  motorizadoId: string,
  blob: Blob,
): Promise<{ url: string; pathStorage: string }> {
  const pathStorage = `motorizados/${motorizadoId}/foto.jpg`
  const storageRef = ref(storage, pathStorage)
  await uploadBytes(storageRef, blob, { contentType: 'image/jpeg' })
  const url = await getDownloadURL(storageRef)
  return { url, pathStorage }
}
