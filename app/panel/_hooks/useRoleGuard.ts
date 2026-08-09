'use client'

import { useEffect, useRef, useState } from 'react'
import { useRouter } from 'next/navigation'
import { onAuthStateChanged, signOut, type User } from 'firebase/auth'
import { doc, onSnapshot } from 'firebase/firestore'
import { auth, db } from '@/fb/config'

export type Rol = 'admin' | 'gestor' | 'motorizado' | 'Comercio' | 'digitador' | null

// 'verificando' → todavía no se sabe quién es; 'autorizado' → puede operar el
// panel; 'redirigiendo' → no le corresponde este panel y ya se pidió el cambio
// de ruta. Nunca hay un cuarto estado ni una espera indefinida: toda rama del
// efecto termina en uno de estos tres.
export type EstadoGuard = 'verificando' | 'autorizado' | 'redirigiendo'

/**
 * Destino canónico de cada rol. Mismo criterio que app/panel/page.tsx, que es
 * el router central por rol — si cambia allí, tiene que cambiar acá.
 */
export function rutaDeRol(rol: Rol, activo: boolean): string {
  if (!activo) return '/login'
  if (rol === 'admin' || rol === 'gestor') return '/panel/gestor'
  if (rol === 'motorizado') return '/panel/motorizado'
  if (rol === 'Comercio') return '/panel/comercio'
  // Digitador V1: no aterriza en el dashboard completo del gestor — tiene su
  // propia entrada mínima que solo enlaza a los módulos financieros que
  // reutiliza (depósitos, saldos). Ver app/panel/digitador/page.tsx.
  if (rol === 'digitador') return '/panel/digitador'
  return '/login'
}

// Reintentos de la suscripción al perfil ante un error NO de permisos (una
// caída de red que el SDK no logró absorber). onSnapshot da de baja el
// listener cuando invoca su callback de error, así que sin esto la detección
// en vivo se perdería en silencio hasta el próximo montaje. Cota fija: un
// error que persiste después de tres intentos no se arregla insistiendo.
const REINTENTOS_PERFIL = 3
const BACKOFF_PERFIL_MS = [1000, 3000, 8000]

/**
 * Resuelve sesión → perfil → activo → rol antes de dejar que un layout abra
 * nada, y MANTIENE esa resolución viva mientras el panel está montado. Los
 * paneles lo usan como interruptor: mientras no devuelva 'autorizado', ningún
 * onSnapshot protegido debe montarse.
 *
 * Por qué existe (P0 de la auditoría): los layouts leían `auth.currentUser` una
 * sola vez y, en la rama de rol incorrecto, pedían el cambio de ruta pero nunca
 * bajaban su bandera de carga — la pantalla quedaba fija en "Validando
 * permisos...". Peor: los listeners arrancaban en paralelo sin esperar esa
 * validación, así que un comercio entrando a una ruta de gestor disparaba
 * permission-denied sin callback de error, y el SDK de Firestore terminaba en
 * INTERNAL ASSERTION FAILED, dejando la app inutilizable.
 *
 * Por qué el perfil se ESCUCHA y ya no se lee una sola vez (P1 de usuarios
 * inactivos): con un getDoc único, desactivar una cuenta no tenía ningún
 * efecto sobre una sesión ya abierta — el panel seguía montado y sus listeners
 * vivos porque `autorizado` nunca cambiaba. Las reglas bloquean cada petición
 * NUEVA, pero una suscripción ya autorizada sobrevive del lado del SDK. La
 * única forma de cortarla es que el propio guard deje de autorizar y se cierre
 * la sesión.
 *
 * @param rolesPermitidos roles que pueden operar este panel. Debe ser una
 *   constante a nivel de módulo: si se pasa un literal en línea cambia de
 *   identidad en cada render y el efecto se reejecuta en bucle.
 * @param rutaPropia ruta base de este panel, para no redirigir sobre sí misma.
 */
export function useRoleGuard(rolesPermitidos: readonly Rol[], rutaPropia: string): EstadoGuard {
  const router = useRouter()
  const [estado, setEstado] = useState<EstadoGuard>('verificando')
  // Una sola redirección por montaje: sin esto, un onAuthStateChanged que
  // vuelve a emitir (refresh de token, reload del perfil) dispararía otro
  // router.replace y se entraría en un ciclo de navegación.
  const redirigidoRef = useRef(false)

  useEffect(() => {
    let vivo = true
    // Un único listener de perfil por sesión. Se guarda acá para poder
    // cerrarlo desde cualquier rama (expulsión, cambio de usuario, desmontaje)
    // sin depender de dónde se creó.
    let cerrarPerfil: (() => void) | null = null
    let uidSuscrito: string | null = null
    let reintentos = 0
    let temporizador: ReturnType<typeof setTimeout> | null = null

    const cerrarListenerPerfil = () => {
      if (temporizador) { clearTimeout(temporizador); temporizador = null }
      if (cerrarPerfil) { cerrarPerfil(); cerrarPerfil = null }
      uidSuscrito = null
    }

    const irA = (destino: string) => {
      if (!vivo || redirigidoRef.current) return
      redirigidoRef.current = true
      setEstado('redirigiendo')
      router.replace(destino)
    }

    /**
     * Salida segura: se usa cuando la cuenta deja de ser válida (desactivada,
     * perfil borrado, permisos revocados). El ORDEN importa —
     *   1) marcar 'redirigiendo' hace que los layouts, que abren todos sus
     *      efectos con `if (!autorizado) return`, desmonten sus listeners;
     *   2) recién entonces se corta el listener del perfil y se cierra sesión.
     * Al revés, se revocaría la sesión con suscripciones del panel todavía
     * vivas — que es exactamente el escenario que producía el
     * INTERNAL ASSERTION FAILED del P0.
     */
    const expulsar = async () => {
      if (!vivo) { cerrarListenerPerfil(); return }
      setEstado('redirigiendo')
      cerrarListenerPerfil()
      try {
        await signOut(auth)
      } catch {
        // Si el signOut falla igual hay que sacarlo de la vista; la sesión
        // queda sin permisos de todos modos porque las reglas ya deniegan.
      }
      irA('/login')
    }

    const suscribirPerfil = (user: User) => {
      // Exactamente un listener por sesión: si ya hay uno para este mismo uid,
      // no se abre otro (onAuthStateChanged puede reemitir por refresh de token).
      if (uidSuscrito === user.uid && cerrarPerfil) return
      cerrarListenerPerfil()
      uidSuscrito = user.uid

      cerrarPerfil = onSnapshot(
        doc(db, 'usuarios', user.uid),
        (snap) => {
          if (!vivo) return
          reintentos = 0

          // Perfil eliminado con la sesión abierta: mismo cierre seguro.
          if (!snap.exists()) { void expulsar(); return }

          const data = snap.data() as { rol?: Rol; activo?: boolean }
          const rol: Rol = data?.rol ?? null
          const activo = data?.activo === true

          // Cuenta desactivada — el caso que este P1 viene a cerrar.
          if (!activo) { void expulsar(); return }

          if (rol !== null && rolesPermitidos.includes(rol)) {
            setEstado('autorizado')
            return
          }

          // Rol válido pero panel equivocado: NO se cierra la sesión, es un
          // usuario legítimo en la puerta que no le toca. Se marca primero el
          // estado (para que no arranque ningún listener de este panel) y se
          // lo manda al suyo. Si ese destino fuera este mismo panel, se corta
          // a /login para no rebotar contra la ruta actual.
          setEstado('redirigiendo')
          cerrarListenerPerfil()
          const destino = rutaDeRol(rol, activo)
          irA(destino === rutaPropia ? '/login' : destino)
        },
        (error) => {
          if (!vivo) return
          // onSnapshot da de baja el listener al invocar este callback, así
          // que a partir de acá no llegan más snapshots por sí solos.
          cerrarPerfil = null
          uidSuscrito = null

          // Permisos revocados: estado inseguro, se sale igual que si
          // estuviera desactivado. No se reintenta — insistir no los devuelve.
          if (error.code === 'permission-denied') { void expulsar(); return }

          // Error no de permisos (red). No es una desactivación y no debe
          // tratarse como tal: no se cierra sesión y no se autoriza por
          // defecto. Se reintenta la suscripción una cantidad acotada de
          // veces; si ya estaba autorizado, se conserva ese estado para no
          // tumbar el panel de alguien que solo perdió señal un momento.
          if (reintentos < REINTENTOS_PERFIL) {
            const espera = BACKOFF_PERFIL_MS[reintentos]
            reintentos++
            temporizador = setTimeout(() => {
              temporizador = null
              if (vivo && auth.currentUser) suscribirPerfil(auth.currentUser)
            }, espera)
          }
          // Si nunca llegó a autorizar, se queda en 'verificando': no hay
          // información suficiente para dejar entrar a nadie.
        }
      )
    }

    // onAuthStateChanged en vez de leer auth.currentUser directo: en una carga
    // en frío la sesión persistida todavía no se restauró y currentUser es
    // null, lo que mandaba a /login a un usuario con sesión válida. También es
    // lo que permite reaccionar a un cambio de usuario sin remontar el layout.
    const unsub = onAuthStateChanged(auth, (user: User | null) => {
      if (!vivo) return

      if (!user) {
        cerrarListenerPerfil()
        irA('/login')
        return
      }

      reintentos = 0
      suscribirPerfil(user)
    })

    return () => {
      vivo = false
      cerrarListenerPerfil()
      unsub()
    }
  }, [router, rutaPropia, rolesPermitidos])

  return estado
}
