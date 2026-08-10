import { cert, getApps, initializeApp } from 'firebase-admin/app'
import { getAuth } from 'firebase-admin/auth'
import { getFirestore } from 'firebase-admin/firestore'
import { getStorage } from 'firebase-admin/storage'

// ─── Modo Emulator (server-side, fail-closed) ──────────────────────────────
// NEXT_PUBLIC_USE_EMULATOR es una variable pública (para que el SDK cliente
// en el navegador sepa a qué host conectarse — ver fb/config.ts), pero
// Next.js también la expone tal cual en el proceso de servidor, así que acá
// se lee igual para decidir el modo del Admin SDK.
//
// Dos caminos, sin punto intermedio:
//   - USE_EMULATOR=true  → NUNCA se toca FIREBASE_SERVICE_ACCOUNT_JSON. Se
//     setean las variables que el propio Admin SDK reconoce nativamente
//     (FIRESTORE_EMULATOR_HOST / FIREBASE_AUTH_EMULATOR_HOST) y se
//     inicializa sin credencial real — no hace falta para hablar con un
//     emulador. Con esas variables seteadas, el SDK es incapaz de alcanzar
//     Firebase real sin importar qué projectId se use.
//   - USE_EMULATOR ausente → comportamiento normal, exactamente igual que
//     antes: credencial real contra el proyecto real.
// El projectId es el mismo (storkhub-9f719) en ambos casos: en modo
// emulador esto es seguro y necesario (debe coincidir con el que usan el
// SDK cliente y el emulador de Functions, ver firebase.json
// singleProjectMode) — las variables *_EMULATOR_HOST son las que garantizan
// que el tráfico nunca sale a Google real, no el projectId.
const USE_EMULATOR = process.env.NEXT_PUBLIC_USE_EMULATOR === 'true'
// "demo-*" es un prefijo que Firebase reconoce especialmente: nunca lo
// resuelve contra infraestructura real (sin billing, sin datos reales),
// así que aunque algo intentara alcanzar Firebase real por error en modo
// emulador, no hay ningún proyecto real con este ID. Debe coincidir con
// .firebaserc y con el projectId que usa el SDK cliente en fb/config.ts.
const LOCAL_PROJECT_ID = 'demo-storkhub'

// Bucket real de este proyecto (ver fb/config.ts, mismo valor). En modo
// emulador se usa el bucket local — el emulador lo crea a demanda, no
// necesita existir en ningún lado, mismo criterio que fb/config.ts aplica
// para el SDK cliente.
const REAL_STORAGE_BUCKET = 'storkhub-9f719.firebasestorage.app'
const LOCAL_STORAGE_BUCKET = `${LOCAL_PROJECT_ID}.appspot.com`

if (USE_EMULATOR) {
  process.env.FIRESTORE_EMULATOR_HOST ??= '127.0.0.1:8080'
  process.env.FIREBASE_AUTH_EMULATOR_HOST ??= '127.0.0.1:9099'
  // Mismo criterio que los otros dos: sin esta variable, el Admin SDK de
  // Storage hablaría contra el bucket real aunque Auth/Firestore ya
  // estuvieran aislados — exactamente el mismo riesgo que motivó reescribir
  // storageBucket para el SDK cliente en fb/config.ts.
  process.env.FIREBASE_STORAGE_EMULATOR_HOST ??= '127.0.0.1:9199'
}

const adminApp =
  getApps().find((a) => a.name === 'admin') ??
  (USE_EMULATOR
    ? initializeApp({ projectId: LOCAL_PROJECT_ID, storageBucket: LOCAL_STORAGE_BUCKET }, 'admin')
    : initializeApp(
        {
          credential: cert(JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT_JSON!)),
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
