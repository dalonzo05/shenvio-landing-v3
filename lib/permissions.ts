import type { Rol } from '@/app/panel/_hooks/useRoleGuard'

/**
 * RBAC interno V1 — fuente central de verdad para accesos a MÓDULOS del
 * panel de gestión (todo lo que cuelga de app/panel/gestor/**).
 *
 * Gobierna EXCLUSIVAMENTE:
 *   1. Qué NavItem se renderiza en el sidebar (gestor/layout.tsx)
 *   2. Qué ruta puede abrirse por URL directa (useModuleGuard)
 *
 * Lo que esta matriz NUNCA gobierna: permisos reales sobre datos. Esa
 * autoridad es exclusiva de firestore.rules / Cloud Functions — que un rol
 * "vea" un módulo acá no amplía en absoluto lo que ese rol puede leer o
 * escribir contra Firestore/Storage. Si al implementar una pantalla se
 * detecta que necesita una capacidad de datos que esta matriz no refleja,
 * eso es una señal para DETENERSE y reportarlo, no para tocar Rules desde
 * este archivo.
 *
 * Matriz fija en código a propósito (decisión de negocio "RBAC INTERNO
 * V1"): los permisos de módulo son estructurales y de baja frecuencia de
 * cambio. Deliberadamente NO hay colección de Firestore, NO hay panel de
 * toggles para Admin, NO hay configuración en runtime — cambiar un acceso
 * requiere un cambio de código explícito, revisado y versionado con git.
 */

export type ModuleId =
  | 'dashboard'
  | 'solicitudes'
  | 'ingresarOrden'
  | 'motorizados'
  | 'comercios'
  | 'clientes'
  | 'baseDatos'
  | 'reportes'
  | 'zonas'
  | 'calculadora'
  | 'cobros'
  | 'depositos'
  | 'liquidaciones'
  | 'gastos'
  | 'saldos'
  | 'financiero'
  | 'auditoria'

interface ModuloDef {
  /** Etiqueta visible en sidebar. */
  label: string
  /** Ruta base del módulo (prefix-match para "activo"). */
  ruta: string
  /** Roles autorizados a ver/entrar a este módulo. Fail-closed: si un rol
   *  no está listado, queda denegado — no hay wildcard ni "resto permitido". */
  roles: readonly Rol[]
  /**
   * Documentación de intención, no el enforcement en sí: los módulos con
   * hardLocked=true además tienen (o deben tener) un guard explícito y
   * literal dentro de su propia página, como defensa en profundidad
   * independiente de esta matriz central. Ver base-datos/page.tsx.
   */
  hardLocked?: boolean
}

/**
 * Matriz V1 autorizada. Cambiar accesos = editar este objeto en una PR
 * revisada, nunca en runtime.
 *
 * ADMIN no se lista por rol en cada fila porque tiene acceso estructural
 * completo por definición (ver canAccessModule) — no es "configurable" ni
 * puede quedar afuera de un módulo por error de esta tabla.
 */
export const MODULOS_PANEL: Readonly<Record<ModuleId, ModuloDef>> = {
  dashboard:     { label: 'Dashboard',          ruta: '/panel/gestor',                      roles: ['admin', 'gestor'] },
  solicitudes:   { label: 'Solicitudes',        ruta: '/panel/gestor/solicitudes',           roles: ['admin', 'gestor'] },
  ingresarOrden: { label: 'Ingresar orden',     ruta: '/panel/gestor/ingresar-orden',        roles: ['admin', 'gestor'] },
  motorizados:   { label: 'Motorizados',        ruta: '/panel/gestor/motorizados',           roles: ['admin', 'gestor'] },
  comercios:     { label: 'Comercios',          ruta: '/panel/gestor/comercios',             roles: ['admin', 'gestor'] },
  clientes:      { label: 'Clientes',           ruta: '/panel/gestor/clientes',              roles: ['admin', 'gestor'] },
  baseDatos:     { label: 'Base de datos',      ruta: '/panel/gestor/base-datos',            roles: ['admin'], hardLocked: true },
  reportes:      { label: 'Reportes',           ruta: '/panel/gestor/reportes',              roles: ['admin', 'digitador'] },
  zonas:         { label: 'Zonas',              ruta: '/panel/gestor/zonas',                 roles: ['admin'] },
  calculadora:   { label: 'Calculadora',        ruta: '/panel/gestor/calculadora',            roles: ['admin', 'gestor'] },
  cobros:        { label: 'Cobros',             ruta: '/panel/gestor/cobros',                 roles: ['admin', 'gestor'] },
  depositos:     { label: 'Depósitos',          ruta: '/panel/gestor/depositos',              roles: ['admin', 'gestor', 'digitador'] },
  liquidaciones: { label: 'Liquidaciones',      ruta: '/panel/gestor/liquidaciones',          roles: ['admin', 'digitador'] },
  gastos:        { label: 'Gastos motorizados', ruta: '/panel/gestor/gastos',                 roles: ['admin', 'gestor'] },
  saldos:        { label: 'Saldos a cargo',     ruta: '/panel/gestor/saldos',                 roles: ['admin', 'digitador'] },
  financiero:    { label: 'Financiero',         ruta: '/panel/gestor/financiero',             roles: ['admin', 'digitador'] },
  auditoria:     { label: 'Auditoría',          ruta: '/panel/gestor/auditoria-financiera',   roles: ['admin'] },
}

/**
 * Único punto de decisión de acceso a módulos. Fail-closed explícito:
 * rol null/desconocido, o moduleId no registrado → false. Nunca "true por
 * defecto" ante un caso no contemplado.
 *
 * Admin siempre true: su acceso es estructural, no depende de que cada fila
 * de MODULOS_PANEL lo liste correctamente (evita que un typo en la matriz
 * pueda dejar a Admin afuera de un módulo propio).
 */
export function canAccessModule(rol: Rol, moduleId: ModuleId): boolean {
  if (!rol) return false
  const modulo = MODULOS_PANEL[moduleId]
  // Módulo desconocido: denegado para TODOS los roles, admin incluido — un
  // moduleId que no existe en la matriz normalmente significa un error de
  // código (typo) en quien llama, nunca una autorización implícita.
  if (!modulo) return false
  if (rol === 'admin') return true
  return modulo.roles.includes(rol)
}

/**
 * Lista de módulos visibles para un rol, en el orden declarado arriba.
 * Usar para construir el sidebar filtrado — nunca hardcodear la lista de
 * NavItem por rol en el layout.
 */
export function modulosVisiblesParaRol(rol: Rol): ModuleId[] {
  return (Object.keys(MODULOS_PANEL) as ModuleId[]).filter((id) => canAccessModule(rol, id))
}
