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

// ─── Señal centralizada de Emulator (fuente única de verdad) ───────────────
// Cualquier otro módulo que necesite saber "¿estamos en Emulator?" importa
// `usandoEmulator` de acá — nunca debe releer NEXT_PUBLIC_USE_EMULATOR por
// su cuenta (evita que dos módulos se desincronicen sobre qué modo es).
export const usandoEmulator = process.env.NEXT_PUBLIC_USE_EMULATOR === 'true'

// "demo-*" es un prefijo que Firebase reconoce especialmente: nunca lo
// resuelve contra infraestructura real (sin billing, sin datos reales).
// Debe coincidir con .firebaserc y con LOCAL_PROJECT_ID en fb/admin.ts.
export const EMULATOR_PROJECT_ID = 'demo-storkhub'

// Endpoint del Auth Emulator — un solo lugar para no duplicar el literal
// entre la conexión de la app principal (más abajo) y cualquier app
// secundaria (fb/createAuthUser.ts).
export const AUTH_EMULATOR_URL = 'http://127.0.0.1:9099'

// En modo Emulator, el SDK cliente se inicializa contra `EMULATOR_PROJECT_ID`
// en vez del proyecto real — así que incluso si algún código rompiera la
// convención de "Firebase solo se usa dentro de useEffect/handlers" (ver
// guard más abajo) y se ejecutara durante SSR, no habría ningún proyecto
// real al que filtrar tráfico por error. `firebaseConfig` (el real) se deja
// exportado sin cambios para quien necesite explícitamente el proyecto real.
const emulatorConfig = { ...firebaseConfig, projectId: EMULATOR_PROJECT_ID, authDomain: `${EMULATOR_PROJECT_ID}.firebaseapp.com` }
// Configuración activa: la que de hecho debe usar cualquier app de Firebase
// en este proceso (principal o secundaria) — fuente única de verdad, para
// que ningún módulo tenga que rearmar este ternario por su cuenta.
export const activeConfig = usandoEmulator ? emulatorConfig : firebaseConfig

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
    // Aviso intencionalmente visible (no silencioso) para que sea imposible
    // no notar que una sesión quedó corriendo contra el emulador.
    console.warn('[shenvio] Firebase Emulator activo (Auth/Firestore/Functions) — NUNCA debe verse este mensaje en producción.')
  }
}