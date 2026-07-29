// fb/data.ts
import { doc, getDoc, setDoc, serverTimestamp, runTransaction } from 'firebase/firestore'
import { db } from '@/fb/config'

/** (legacy solo si aún tienes docs por email) */
export const idFromEmail = (email: string) =>
  (email || '').toLowerCase().trim().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '')

/* ===== Tipos ===== */
export type BankAccount = { bank: string; number: string; holder: string; currency: string } // 'NIO' | 'USD'
export type CompanyPayload = { name?: string; phone?: string; address?: string; accounts?: BankAccount[]; tipoCliente?: 'contado' | 'credito' }

/* ===== Helper: quitar undefined (mantiene FieldValue) ===== */
function cleanUndefined(value: any): any {
  if (Array.isArray(value)) return value.map(cleanUndefined)
  if (value && typeof value === 'object') {
    if ((value as any)._methodName) return value // p.ej. serverTimestamp
    const out: any = {}
    for (const [k, v] of Object.entries(value)) if (v !== undefined) out[k] = cleanUndefined(v)
    return out
  }
  return value
}

/* ===== USUARIOS (por UID) =====
 *
 * upsertUserProfileByUid distingue creación de actualización DENTRO de una
 * transacción (no con dos pasos separados de leer-y-luego-escribir, que
 * dejaría una ventana de carrera entre llamadas concurrentes):
 *
 * - Si usuarios/{uid} NO existe: es la primera vez que este usuario se
 *   autentica. Se crea con createdAt Y updatedAt en serverTimestamp(). Debe
 *   cumplir firestore.rules → camposPermitidosAutoRegistroUsuario()
 *   (email/name/theme/createdAt/updatedAt) — nunca rol/activo/comercioId.
 * - Si YA existe: es una actualización. Se reescribe SOLO con los campos
 *   recibidos (nunca createdAt) + updatedAt en serverTimestamp() — el
 *   createdAt original queda intacto porque ni siquiera se envía. Debe
 *   cumplir camposEditablesAutoUsuario() (name/theme/updatedAt) — por eso
 *   ningún caller debe pasar `email` en una actualización (ver
 *   app/panel/ajustes/page.tsx).
 *
 * Se envuelve en runTransaction para que sea idempotente ante llamadas
 * concurrentes (ej. dos disparos de onAuthStateChanged casi simultáneos):
 * la transacción de Firestore reintenta automáticamente si otra escritura
 * ganó la carrera, así que createdAt nunca se pisa ni se duplica el efecto.
 */
export async function upsertUserProfileByUid(
  uid: string,
  profile: { email?: string; name?: string; theme?: string }
) {
  if (!uid) throw new Error('uid inválido')
  const data = cleanUndefined(profile)
  const ref = doc(db, 'usuarios', uid)

  await runTransaction(db, async (tx) => {
    const snap = await tx.get(ref)
    if (!snap.exists()) {
      tx.set(ref, { ...data, createdAt: serverTimestamp(), updatedAt: serverTimestamp() })
    } else {
      tx.set(ref, { ...data, updatedAt: serverTimestamp() }, { merge: true })
    }
  })
}

export async function readUserProfileByUid(uid: string) {
  if (!uid) return null
  const snap = await getDoc(doc(db, 'usuarios', uid))
  return snap.exists() ? (snap.data() as any) : null
}

/* ===== COMERCIOS (por UID) ===== */
export async function upsertCompanyByUid(uid: string, company: CompanyPayload) {
  if (!uid) throw new Error('uid inválido')
  const data = cleanUndefined(company)
  await setDoc(doc(db, 'comercios', uid), { ...data, updatedAt: serverTimestamp() }, { merge: true })
}

export async function readCompanyByUid(uid: string) {
  if (!uid) return null
  const snap = await getDoc(doc(db, 'comercios', uid))
  return snap.exists() ? (snap.data() as any) : null
}

/* ===== LEGACY por email (bloqueado a propósito) ===== */
export async function upsertUserProfile(email: string, name: string) {
  throw new Error('Deprecated: usa upsertUserProfileByUid(uid, { email, name })')
}
export async function readUserProfile(email: string) {
  throw new Error('Deprecated: usa readUserProfileByUid(uid)')
}
export async function upsertCompany(email: string, company: CompanyPayload) {
  throw new Error('Deprecated: usa upsertCompanyByUid(uid, company)')
}
export async function readCompany(email: string) {
  throw new Error('Deprecated: usa readCompanyByUid(uid)')
}

/* ===== OPCIONAL: default export para evitar tree-shake raro ===== */
const _exports = {
  upsertUserProfileByUid,
  readUserProfileByUid,
  upsertCompanyByUid,
  readCompanyByUid,
}
export default _exports
