// MOTO-ALTA-AUTH-ROL-1 — Cómo se ve el acceso de un motorizado en el panel.
//
// Antes la UI decía "Con acceso" en verde apenas `motorizado.authUid` traía algo,
// aunque el perfil no tuviera rol y el login respondiera "No tenés un rol
// asignado". El estado REAL lo calcula el servidor (diagnosticarAccesoMotorizado,
// una llamada al abrir el detalle, no una lectura a Auth por cada fila) y este
// módulo solo decide qué se muestra y qué acciones se ofrecen para cada estado y
// cada rol.
//
// Reglas que no se negocian:
//   · "Acceso activo" solo lo afirma el servidor. Con `authUid` y nada más, se
//     pregunta; nunca se supone.
//   · Crear acceso no pide contraseña: el motorizado la define con su enlace.
//   · El UID no se edita: a lo sumo se muestra, de solo lectura, para soporte.
//   · Reparar es solo del admin. El gestor ve el problema, no el botón.
//
// PURO: sin Firestore, sin React.

export type EstadoAcceso = 'sin_acceso' | 'pendiente_activacion' | 'activo' | 'incompleto'

export interface VistaAcceso {
  etiqueta: string
  /** Color del distintivo: no es una clase CSS, la pantalla la traduce. */
  tono: 'gris' | 'ambar' | 'azul' | 'verde' | 'rojo'
  explicacion: string
  puedeCrear: boolean
  puedeEnviarInvitacion: boolean
  puedeReparar: boolean
  /** Alta y reparación NUNCA piden contraseña. */
  pideContrasena: false
  /** El UID nunca es un campo editable. */
  uidEditable: false
  /** ¿Se muestra el UID (solo lectura)? Solo cuando ya hay vínculo. */
  mostrarUid: boolean
}

const ROLES_OPERADOR = ['admin', 'gestor']

/**
 * Estado que se conoce sin preguntarle nada al servidor: sin `authUid` no hay
 * cuenta que diagnosticar. Con `authUid`, null: hay que preguntar.
 */
export function estadoSinConsultar(authUid: unknown): EstadoAcceso | null {
  return typeof authUid === 'string' && authUid.trim() !== '' ? null : 'sin_acceso'
}

export function vistaAcceso(
  estado: EstadoAcceso | null | undefined,
  rolActor: string | null | undefined,
  opciones: { reparable?: boolean } = {},
): VistaAcceso {
  const esOperador = typeof rolActor === 'string' && ROLES_OPERADOR.includes(rolActor)
  const esAdmin = rolActor === 'admin'
  const base = {
    pideContrasena: false as const,
    uidEditable: false as const,
    puedeCrear: false,
    puedeEnviarInvitacion: false,
    puedeReparar: false,
  }

  switch (estado) {
    case 'sin_acceso':
      return {
        ...base,
        etiqueta: 'Sin acceso',
        tono: 'ambar',
        explicacion: 'Este motorizado no tiene cuenta. Creale el acceso con su correo: recibirá un enlace para elegir su propia contraseña.',
        puedeCrear: esOperador,
        mostrarUid: false,
      }
    case 'pendiente_activacion':
      return {
        ...base,
        etiqueta: 'Pendiente de activación',
        tono: 'azul',
        explicacion: 'La cuenta está creada. Falta que el motorizado abra su enlace y elija su contraseña.',
        puedeEnviarInvitacion: esOperador,
        mostrarUid: true,
      }
    case 'activo':
      return {
        ...base,
        etiqueta: 'Acceso activo',
        tono: 'verde',
        explicacion: 'La cuenta, el perfil y el rol están completos: puede iniciar sesión.',
        mostrarUid: true,
      }
    case 'incompleto':
      return {
        ...base,
        etiqueta: 'Acceso incompleto',
        tono: 'rojo',
        explicacion: esAdmin && opciones.reparable
          ? 'Hay una cuenta vinculada pero le falta algo para poder entrar. Podés repararla.'
          : 'Hay una cuenta vinculada pero le falta algo para poder entrar. Un admin debe revisarla.',
        puedeReparar: esAdmin && opciones.reparable === true,
        mostrarUid: true,
      }
    default:
      // Todavía no se sabe: no se afirma nada ni se ofrece ninguna acción.
      return {
        ...base,
        etiqueta: 'Verificando acceso…',
        tono: 'gris',
        explicacion: '',
        mostrarUid: false,
      }
  }
}
