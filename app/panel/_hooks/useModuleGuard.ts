'use client'

import { useEffect, useRef, useState } from 'react'
import { useRouter } from 'next/navigation'
import { onAuthStateChanged, signOut, type User } from 'firebase/auth'
import { doc, onSnapshot } from 'firebase/firestore'
import { auth, db } from '@/fb/config'
import { rutaDeRol, type Rol, type EstadoGuard } from './useRoleGuard'
import { canAccessModule, type ModuleId } from '@/lib/permissions'

// Mismos números que useRoleGuard: un error de red transitorio no debe
// expulsar a nadie, pero tampoco hay que reintentar para siempre.
const REINTENTOS_PERFIL = 3
const BACKOFF_PERFIL_MS = [1000, 3000, 8000]

/**
 * Guard de MÓDULO — segunda capa, más fina que useRoleGuard.
 *
 * useRoleGuard (en gestor/layout.tsx) ya decide si el rol puede estar
 * dentro del panel de gestión en general (admin/gestor/digitador). Este
 * hook decide, para la página concreta que lo llama, si ADEMÁS tiene
 * permiso sobre ESE módulo puntual según lib/permissions.ts — porque hoy
 * el guard del layout es uniforme para las 17 rutas de gestor/**, y eso es
 * exactamente el hallazgo sistémico que este bloque resuelve (ver RBAC
 * INTERNO V1): sin este segundo guard, cualquier rol admitido por el
 * layout puede abrir cualquier módulo tecleando la URL a mano.
 *
 * Se suscribe en vivo al perfil (igual que useRoleGuard) para que, si el
 * rol de la sesión cambia mientras la página sigue montada (p. ej. un
 * admin reclasifica a un gestor como digitador), la página se abandone de
 * inmediato en vez de quedar accesible hasta el siguiente refresh.
 *
 * Nunca reemplaza a Firestore Rules: si esta función deja pasar pero
 * Rules deniega, la página simplemente no obtiene datos — ese es y sigue
 * siendo el límite de seguridad real.
 *
 * @param moduleId módulo declarado en lib/permissions.ts que gobierna esta página.
 */
export function useModuleGuard(moduleId: ModuleId): EstadoGuard {
  const router = useRouter()
  const [estado, setEstado] = useState<EstadoGuard>('verificando')
  const redirigidoRef = useRef(false)

  useEffect(() => {
    let vivo = true
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

    const expulsar = async () => {
      if (!vivo) { cerrarListenerPerfil(); return }
      setEstado('redirigiendo')
      cerrarListenerPerfil()
      try {
        await signOut(auth)
      } catch {
        // La sesión igual queda sin permisos: Rules deniega de todos modos.
      }
      irA('/login')
    }

    const suscribirPerfil = (user: User) => {
      if (uidSuscrito === user.uid && cerrarPerfil) return
      cerrarListenerPerfil()
      uidSuscrito = user.uid

      cerrarPerfil = onSnapshot(
        doc(db, 'usuarios', user.uid),
        (snap) => {
          if (!vivo) return
          reintentos = 0

          if (!snap.exists()) { void expulsar(); return }

          const data = snap.data() as { rol?: Rol; activo?: boolean }
          const rol: Rol = data?.rol ?? null
          const activo = data?.activo === true

          if (!activo) { void expulsar(); return }

          if (canAccessModule(rol, moduleId)) {
            setEstado('autorizado')
            return
          }

          // Rol válido y sesión activa, pero SIN permiso sobre este módulo
          // puntual: no se cierra sesión (es un usuario legítimo), se lo
          // manda a su propio home permitido.
          setEstado('redirigiendo')
          cerrarListenerPerfil()
          irA(rutaDeRol(rol, activo))
        },
        (error) => {
          if (!vivo) return
          cerrarPerfil = null
          uidSuscrito = null

          if (error.code === 'permission-denied') { void expulsar(); return }

          if (reintentos < REINTENTOS_PERFIL) {
            const espera = BACKOFF_PERFIL_MS[reintentos]
            reintentos++
            temporizador = setTimeout(() => {
              temporizador = null
              if (vivo && auth.currentUser) suscribirPerfil(auth.currentUser)
            }, espera)
          }
        }
      )
    }

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
  }, [router, moduleId])

  return estado
}
