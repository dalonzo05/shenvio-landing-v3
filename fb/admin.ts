import { cert, getApps, initializeApp } from 'firebase-admin/app'
import { getAuth } from 'firebase-admin/auth'
import { getFirestore } from 'firebase-admin/firestore'
import { getStorage } from 'firebase-admin/storage'
import { getAppEnv, isEmulatorMode, assertFirebaseIdentity, LOCAL_EMULATOR_PROJECT_ID } from '@/lib/env'

// ─── Modo Emulator (server-side, fail-closed) ──────────────────────────────
// NEXT_PUBLIC_USE_EMULATOR es una variable pública (para que el SDK cliente
// en el navegador sepa a qué host conectarse — ver fb/config.ts), pero
// Next.js también la expone tal cual en el proceso de servidor, así que acá
// se lee igual (vía isEmulatorMode(), misma función que usa el cliente —
// lib/env.ts) para decidir el modo del Admin SDK.
//
// Dos caminos, sin punto intermedio:
//   - USE_EMULATOR=true  → NUNCA se toca FIREBASE_SERVICE_ACCOUNT_JSON. Se
//     setean las variables que el propio Admin SDK reconoce nativamente
//     (FIRESTORE_EMULATOR_HOST / FIREBASE_AUTH_EMULATOR_HOST) y se
//     inicializa sin credencial real — no hace falta para hablar con un
//     emulador. Con esas variables seteadas, el SDK es incapaz de alcanzar
//     Firebase real sin importar qué projectId se use.
//   - USE_EMULATOR ausente → comportamiento normal: credencial real contra
//     el proyecto real, tomado de FIREBASE_SERVICE_ACCOUNT_JSON.
// El projectId real se deriva del propio service account (nunca
// hardcodeado acá) — ver ENVIRONMENT ISOLATION V1 más abajo.
const USE_EMULATOR = isEmulatorMode()
// "demo-*" es un prefijo que Firebase reconoce especialmente: nunca lo
// resuelve contra infraestructura real (sin billing, sin datos reales),
// así que aunque algo intentara alcanzar Firebase real por error en modo
// emulador, no hay ningún proyecto real con este ID. Debe coincidir con
// .firebaserc y con el projectId que usa el SDK cliente en fb/config.ts.
const LOCAL_PROJECT_ID = LOCAL_EMULATOR_PROJECT_ID
const LOCAL_STORAGE_BUCKET = `${LOCAL_PROJECT_ID}.appspot.com`

// ─── Bucket real — ENVIRONMENT ISOLATION V1 ────────────────────────────────
// Antes hardcodeado acá (`storkhub-9f719.firebasestorage.app` en texto
// plano). Ahora viene de una variable de entorno SERVER-ONLY (nunca
// NEXT_PUBLIC_*, el bucket real no necesita viajar al bundle del
// navegador) — ver .env.example. Ausente/no leída en modo Emulator por
// diseño, igual que FIREBASE_SERVICE_ACCOUNT_JSON.
const REAL_STORAGE_BUCKET = process.env.FIREBASE_STORAGE_BUCKET

if (USE_EMULATOR) {
  process.env.FIRESTORE_EMULATOR_HOST ??= '127.0.0.1:8080'
  process.env.FIREBASE_AUTH_EMULATOR_HOST ??= '127.0.0.1:9099'
  // Mismo criterio que los otros dos: sin esta variable, el Admin SDK de
  // Storage hablaría contra el bucket real aunque Auth/Firestore ya
  // estuvieran aislados — exactamente el mismo riesgo que motivó reescribir
  // storageBucket para el SDK cliente en fb/config.ts.
  process.env.FIREBASE_STORAGE_EMULATOR_HOST ??= '127.0.0.1:9199'
}

// Se parsea UNA sola vez y se reutiliza tanto para el guard fail-closed de
// abajo como para cert() — misma fuente, nunca dos parseos que podrían
// desincronizarse. null en modo Emulator: nunca se toca esta variable si
// USE_EMULATOR, igual que antes. Sin anotar el tipo a propósito (igual que
// el JSON.parse(...) inline que había antes): cert() acepta el objeto
// crudo en snake_case (project_id/client_email/private_key), que no
// coincide con el tipo ServiceAccount (camelCase) del SDK.
const serviceAccount = USE_EMULATOR ? null : JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT_JSON!)

// Guard fail-closed ANTES de inicializar cualquier app — misma función que
// usa el SDK cliente (fb/config.ts, ver lib/env.ts). Si la combinación
// (APP_ENV, Emulator, projectId, storageBucket) no es válida para este
// ambiente, esto lanza y ninguna app de Firebase Admin llega a
// inicializarse con una config equivocada (ej. staging con credencial de
// producción, o production apuntando a demo-storkhub).
assertFirebaseIdentity(getAppEnv(), USE_EMULATOR, {
  projectId: USE_EMULATOR ? LOCAL_PROJECT_ID : serviceAccount?.project_id ?? '',
  storageBucket: USE_EMULATOR ? LOCAL_STORAGE_BUCKET : REAL_STORAGE_BUCKET ?? '',
})

const adminApp =
  getApps().find((a) => a.name === 'admin') ??
  (USE_EMULATOR
    ? initializeApp({ projectId: LOCAL_PROJECT_ID, storageBucket: LOCAL_STORAGE_BUCKET }, 'admin')
    : initializeApp(
        {
          credential: cert(serviceAccount!),
          storageBucket: REAL_STORAGE_BUCKET,
        },
        'admin'
      ))

export const adminAuth = getAuth(adminApp)
export const adminDb = getFirestore(adminApp)
// .bucket() sin argumento resuelve al storageBucket declarado arriba en
// initializeApp — un solo lugar donde el nombre del bucket puede cambiar.
export const adminBucket = getStorage(adminApp).bucket()
export const emulatorActivo = USE_EMULATOR
