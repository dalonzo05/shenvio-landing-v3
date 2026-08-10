// Import the functions you need from the SDKs you need
import { initializeApp, getApps, getApp } from "firebase/app";
import { getFirestore, connectFirestoreEmulator } from "./fs";
import { getAuth, connectAuthEmulator } from 'firebase/auth'
import { getStorage, connectStorageEmulator } from 'firebase/storage'
import { getFunctions, connectFunctionsEmulator } from 'firebase/functions'
import { getAppEnv, isEmulatorMode, assertFirebaseIdentity, LOCAL_EMULATOR_PROJECT_ID } from '@/lib/env'
// TODO: Add SDKs for Firebase products that you want to use
// https://firebase.google.com/docs/web/setup#available-libraries

// ─── Señal centralizada de Emulator (fuente única de verdad) ───────────────
// Cualquier otro módulo que necesite saber "¿estamos en Emulator?" importa
// `usandoEmulator` de acá — nunca debe releer NEXT_PUBLIC_USE_EMULATOR por
// su cuenta (evita que dos módulos se desincronicen sobre qué modo es).
// La lectura real vive en lib/env.ts (isEmulatorMode) — mismo criterio que
// `getAppEnv()` para APP_ENV: una sola función, un solo lugar que lee la
// variable de process.env.
export const usandoEmulator = isEmulatorMode()

// "demo-*" es un prefijo que Firebase reconoce especialmente: nunca lo
// resuelve contra infraestructura real (sin billing, sin datos reales).
// Debe coincidir con .firebaserc y con LOCAL_PROJECT_ID en fb/admin.ts.
export const EMULATOR_PROJECT_ID = LOCAL_EMULATOR_PROJECT_ID

// Endpoint del Auth Emulator — un solo lugar para no duplicar el literal
// entre la conexión de la app principal (más abajo) y cualquier app
// secundaria (fb/createAuthUser.ts).
export const AUTH_EMULATOR_URL = 'http://127.0.0.1:9099'

// Host y puerto del Storage Emulator. Debe coincidir con firebase.json
// (emulators.storage.port). 9199 es además el puerto por defecto del
// emulador, así que declararlo allí solo lo hace explícito.
export const STORAGE_EMULATOR_HOST = '127.0.0.1'
export const STORAGE_EMULATOR_PORT = 9199

// ─── Firebase Client config real — ENVIRONMENT ISOLATION V1 ────────────────
// Antes hardcodeada acá (apiKey/projectId/etc. del proyecto real
// storkhub-9f719 en texto plano). Ahora viene de variables de entorno
// NEXT_PUBLIC_FIREBASE_* — ver .env.example. Estas variables NO son
// secretas por definición (viajan al bundle del navegador de cualquier
// forma), pero deben pertenecer al ambiente correcto: staging usa sus
// propias NEXT_PUBLIC_FIREBASE_* apuntando a SU proyecto, production a
// las suyas. El guard de abajo (assertFirebaseIdentity) es lo que impide
// que una combinación incorrecta llegue a inicializarse.
//
// measurementId (Analytics) se retira: no hay ningún getAnalytics() en el
// código vivo, era config muerta.
const firebaseConfig = {
  apiKey: process.env.NEXT_PUBLIC_FIREBASE_API_KEY,
  authDomain: process.env.NEXT_PUBLIC_FIREBASE_AUTH_DOMAIN,
  projectId: process.env.NEXT_PUBLIC_FIREBASE_PROJECT_ID,
  storageBucket: process.env.NEXT_PUBLIC_FIREBASE_STORAGE_BUCKET,
  messagingSenderId: process.env.NEXT_PUBLIC_FIREBASE_MESSAGING_SENDER_ID,
  appId: process.env.NEXT_PUBLIC_FIREBASE_APP_ID,
}

// Config del Emulator: SIEMPRE valores demo fijos, nunca derivada de
// firebaseConfig. Antes se armaba con `{...firebaseConfig, projectId:
// EMULATOR_PROJECT_ID, ...}`, lo que significaba que apiKey/appId/
// messagingSenderId reales terminaban viajando igual en modo Emulator —
// funcionaba porque el Auth Emulator no valida esos campos, pero violaba
// el requisito "el modo local Emulator nunca debe necesitar credenciales
// reales" (un dev sin ninguna NEXT_PUBLIC_FIREBASE_* seteada debe poder
// levantar el Emulator igual).
const emulatorConfig = {
  apiKey: 'demo-emulator-api-key',
  authDomain: `${EMULATOR_PROJECT_ID}.firebaseapp.com`,
  projectId: EMULATOR_PROJECT_ID,
  storageBucket: `${EMULATOR_PROJECT_ID}.appspot.com`,
  messagingSenderId: 'demo-emulator-sender-id',
  appId: 'demo-emulator-app-id',
}
// Configuración activa: la que de hecho debe usar cualquier app de Firebase
// en este proceso (principal o secundaria) — fuente única de verdad, para
// que ningún módulo tenga que rearmar este ternario por su cuenta.
export const activeConfig = usandoEmulator ? emulatorConfig : firebaseConfig

// ─── Guard fail-closed ANTES de inicializar cualquier app ──────────────────
// Misma función que usa fb/admin.ts server-side — ver lib/env.ts. Si la
// combinación (APP_ENV, Emulator, projectId, storageBucket) no es válida
// para este ambiente, esto lanza y ninguna app de Firebase llega a
// inicializarse con una config equivocada.
assertFirebaseIdentity(getAppEnv(), usandoEmulator, {
  projectId: activeConfig.projectId ?? '',
  storageBucket: activeConfig.storageBucket ?? '',
})

// Initialize Firebase
export const app = getApps().length ? getApp() : initializeApp(activeConfig);
export const db = getFirestore(app);
export const auth = getAuth(app)
export const storage = getStorage(app)
export const functions = getFunctions(app)

// ─── Firebase Emulator (solo desarrollo local, solo navegador) ────────────
// Activo ÚNICAMENTE cuando usandoEmulator Y se ejecuta en el navegador
// (`typeof window !== 'undefined'`). Nunca se conecta durante SSR ni por
// defecto — sin ambas condiciones, `db`/`auth`/`functions` siguen apuntando
// a Firebase real exactamente como antes.
//
// Por qué solo navegador: en esta app, todo acceso a Firestore/Auth/
// Functions ocurre dentro de useEffect o handlers de evento de componentes
// 'use client' (UserProvider, paneles con onSnapshot, etc.) — React nunca
// ejecuta useEffect durante SSR, así que el paso de servidor de Next jamás
// llega a invocar estas APIs con esta instancia. Combinado con que `app` ya
// se inicializa arriba con projectId EMULATOR_PROJECT_ID en modo emulador,
// incluso si algún código futuro rompiera esa convención, no hay ningún
// proyecto real al que conectarse por error.
//
// El guard con globalThis evita el error "already connected to emulator"
// que dispara el SDK si Next Fast Refresh vuelve a ejecutar este módulo
// dentro de la misma sesión del navegador.
if (typeof window !== 'undefined' && usandoEmulator) {
  const g = globalThis as typeof globalThis & { __shenvioEmulatorsConnected?: boolean }
  if (!g.__shenvioEmulatorsConnected) {
    g.__shenvioEmulatorsConnected = true
    connectAuthEmulator(auth, AUTH_EMULATOR_URL, { disableWarnings: true })
    connectFirestoreEmulator(db, '127.0.0.1', 8080)
    connectFunctionsEmulator(functions, '127.0.0.1', 5001)
    // Storage entra por el MISMO guard que los otros tres: si se conectara
    // fuera de él, Fast Refresh volvería a ejecutarlo y el SDK lanzaría
    // "already connected". No hay fallback: si 9199 no responde, la subida
    // falla por conexión — nunca se degrada hacia el bucket real.
    connectStorageEmulator(storage, STORAGE_EMULATOR_HOST, STORAGE_EMULATOR_PORT)
    // Aviso intencionalmente visible (no silencioso) para que sea imposible
    // no notar que una sesión quedó corriendo contra el emulador.
    console.warn('[shenvio] Firebase Emulator activo (Auth/Firestore/Functions/Storage) — NUNCA debe verse este mensaje en producción.')
  }
}
