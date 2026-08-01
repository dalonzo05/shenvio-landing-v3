'use client'

import { useEffect, useRef, useState } from 'react'
import { useRouter } from 'next/navigation'
import { onAuthStateChanged, type User } from 'firebase/auth'
import { doc, getDoc } from 'firebase/firestore'
import { auth, db } from '@/fb/config'

export type Rol = 'admin' | 'gestor' | 'motorizado' | 'Comercio' | null

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
  return '/login'
}

/**
 * Resuelve sesión → perfil → activo → rol antes de dejar que un layout abra
 * nada. Los paneles lo usan como interruptor: mientras no devuelva
 * 'autorizado', ningún onSnapshot protegido debe montarse.
 *
 * Por qué existe (P0 de la auditoría): los layouts leían `auth.currentUser` una
 * sola vez y, en la rama de rol incorrecto, pedían el cambio de ruta pero nunca
 * bajaban su bandera de carga — la pantalla quedaba fija en "Validando
 * permisos...". Peor: los listeners arrancaban en paralelo sin esperar esa
 * validación, así que un comercio entrando a una ruta de gestor disparaba
 * permission-denied sin callback de error, y el SDK de Firestore terminaba en
 * INTERNAL ASSERTION FAILED, dejando la app inutilizable.
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

    // onAuthStateChanged en vez de leer auth.currentUser directo: en una carga
    // en frío la sesión persistida todavía no se restauró y currentUser es
    // null, lo que mandaba a /login a un usuario con sesión válida. También es
    // lo que permite reaccionar a un cambio de usuario sin remontar el layout.
    const unsub = onAuthStateChanged(auth, async (user: User | null) => {
      if (!vivo) return

      const irA = (destino: string) => {
        if (!vivo || redirigidoRef.current) return
        redirigidoRef.current = true
        setEstado('redirigiendo')
        router.replace(destino)
      }

      if (!user) {
        irA('/login')
        return
      }

      let rol: Rol = null
      let activo = false
      try {
        const snap = await getDoc(doc(db, 'usuarios', user.uid))
        const data = snap.exists() ? (snap.data() as { rol?: Rol; activo?: boolean }) : null
        rol = data?.rol ?? null
        activo = data?.activo === true
      } catch {
        // Si no se puede resolver el perfil no hay forma de autorizar: se sale
        // del panel en vez de quedarse esperando para siempre.
        irA('/login')
        return
      }
      if (!vivo) return

      if (activo && rol !== null && rolesPermitidos.includes(rol)) {
        setEstado('autorizado')
        return
      }

      // Rol que no corresponde a este panel: se manda al que sí le toca. Si por
      // lo que sea ese destino fuera este mismo panel, se corta a /login para
      // no rebotar contra la ruta actual.
      const destino = rutaDeRol(rol, activo)
      irA(destino === rutaPropia ? '/login' : destino)
    })

    return () => {
      vivo = false
      unsub()
    }
  }, [router, rutaPropia, rolesPermitidos])

  return estado
}
