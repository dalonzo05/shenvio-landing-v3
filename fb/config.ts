// Import the functions you need from the SDKs you need
import { initializeApp, getApps, getApp } from "firebase/app";
import { getFirestore, connectFirestoreEmulator } from "./fs";
import { getAuth, connectAuthEmulator } from 'firebase/auth'
import { getStorage } from 'firebase/storage'
import { getFunctions, connectFunctionsEmulator } from 'firebase/functions'
// TODO: Add SDKs for Firebase products that you want to use
// https://firebase.google.com/docs/web/setup#available-libraries

// Your web app's Firebase configuration
// For Firebase JS SDK v7.20.0 and later, measurementId is optional
export const firebaseConfig = {
  apiKey: "AIzaSyDamiCHolJ7VYX2mAYVINENEiOACBa-qT0",
  authDomain: "storkhub-9f719.firebaseapp.com",
  projectId: "storkhub-9f719",
  storageBucket: "storkhub-9f719.firebasestorage.app",
  messagingSenderId: "1092479828671",
  appId: "1:1092479828671:web:0d3cb4f653716a30ddfc0a",
  measurementId: "G-62YJLMLPSM"
};

// En modo Emulator, el SDK cliente se inicializa contra un projectId
// "demo-*" en vez del real. Firebase reconoce especialmente ese prefijo y
// nunca lo resuelve contra infraestructura real (sin billing, sin datos
// reales) — así que incluso si algún código rompiera la convención de
// "Firebase solo se usa dentro de useEffect/handlers" (ver guard más abajo)
// y se ejecutara durante SSR, no habría ningún proyecto real al que
// filtrar tráfico por error. Debe coincidir con .firebaserc y con
// LOCAL_PROJECT_ID en fb/admin.ts. firebaseConfig (el real) se deja
// exportado sin cambios — fb/createAuthUser.ts lo sigue usando tal cual
// para su app secundaria, fuera del alcance de este cambio.
const emulatorConfig = { ...firebaseConfig, projectId: 'demo-storkhub', authDomain: 'demo-storkhub.firebaseapp.com' }
const activeConfig = process.env.NEXT_PUBLIC_USE_EMULATOR === 'true' ? emulatorConfig : firebaseConfig

// Initialize Firebase
export const app = getApps().length ? getApp() : initializeApp(activeConfig);
export const db = getFirestore(app);
export const auth = getAuth(app)
export const storage = getStorage(app)
export const functions = getFunctions(app)

// ─── Firebase Emulator (solo desarrollo local, solo navegador) ────────────
// Activo ÚNICAMENTE cuando NEXT_PUBLIC_USE_EMULATOR === 'true' Y se ejecuta
// en el navegador (`typeof window !== 'undefined'`). Nunca se conecta
// durante SSR ni por defecto — sin ambas condiciones, `db`/`auth`/`functions`
// siguen apuntando a Firebase real exactamente como antes.
//
// Por qué solo navegador: en esta app, todo acceso a Firestore/Auth/
// Functions ocurre dentro de useEffect o handlers de evento de componentes
// 'use client' (UserProvider, paneles con onSnapshot, etc.) — React nunca
// ejecuta useEffect durante SSR, así que el paso de servidor de Next jamás
// llega a invocar estas APIs con esta instancia. Combinado con que `app` ya
// se inicializa arriba con projectId "demo-storkhub" en modo emulador,
// incluso si algún código futuro rompiera esa convención, no hay ningún
// proyecto real al que conectarse por error.
//
// El guard con globalThis evita el error "already connected to emulator"
// que dispara el SDK si Next Fast Refresh vuelve a ejecutar este módulo
// dentro de la misma sesión del navegador.
if (typeof window !== 'undefined' && process.env.NEXT_PUBLIC_USE_EMULATOR === 'true') {
  const g = globalThis as typeof globalThis & { __shenvioEmulatorsConnected?: boolean }
  if (!g.__shenvioEmulatorsConnected) {
    g.__shenvioEmulatorsConnected = true
    connectAuthEmulator(auth, 'http://127.0.0.1:9099', { disableWarnings: true })
    connectFirestoreEmulator(db, '127.0.0.1', 8080)
    connectFunctionsEmulator(functions, '127.0.0.1', 5001)
    // Aviso intencionalmente visible (no silencioso) para que sea imposible
    // no notar que una sesión quedó corriendo contra el emulador.
    console.warn('[shenvio] Firebase Emulator activo (Auth/Firestore/Functions) — NUNCA debe verse este mensaje en producción.')
  }
}