// B2-BASE-PAGO-DETALLE — campos de la tabla de Base de datos.
//
// Dos columnas mostraban datos que no existían:
//
//   TELÉFONO  leía `ownerSnapshot.phone`. Ese campo NUNCA se escribió: el
//             snapshot solo guarda companyName, nombre y uid (0/6 en staging).
//             La columna es el teléfono del COMERCIO, y ese dato vive en
//             `comercios/{uid}` — traerlo costaría una lectura por comercio.
//             Así que sigue en "—" y se reporta como deuda, en vez de rellenarla
//             con el teléfono de retiro o de entrega, que son otra cosa.
//
//   ZONA      era un `EditableCell` sobre `registro.zona`, un campo de captura
//             manual vacío en las 6 órdenes. Lo que se veía escrito —"zona"— no
//             era un dato: era el placeholder del input. Mientras tanto la
//             clasificación territorial real sí está persistida en la orden.
//
// PURO: sin Firestore, sin React. Solo elige el campo correcto y su fallback.

export interface EntradaCamposBaseDatos {
  ownerSnapshot?: { phone?: string | null; telefono?: string | null; celular?: string | null } | null
  zonaRetiroNombre?: string | null
  macroZonaRetiroNombre?: string | null
  zonaEntregaNombre?: string | null
  macroZonaEntregaNombre?: string | null
  recoleccion?: { celular?: string | null } | null
  entrega?: { celular?: string | null } | null
}

const texto = (v: unknown): string | null => {
  if (typeof v !== 'string') return null
  const t = v.trim()
  return t ? t : null
}

/**
 * Teléfono del COMERCIO. Devuelve null cuando no está en el documento.
 *
 * Los tres nombres son el mismo concepto en distintas generaciones del
 * snapshot. No cae al teléfono de retiro ni al de entrega: son el remitente y
 * el destinatario, no el comercio, y mezclarlos para no mostrar "—" haría que
 * el gestor llamara al número equivocado.
 */
export function telefonoComercio(s: EntradaCamposBaseDatos): string | null {
  return texto(s.ownerSnapshot?.phone)
    ?? texto(s.ownerSnapshot?.telefono)
    ?? texto(s.ownerSnapshot?.celular)
}

/**
 * Zona de retiro tal como la clasificó el sistema.
 *
 * `zonaRetiroNombre` es la zona fina y `macroZonaRetiroNombre` la macrozona:
 * no todas las órdenes tienen la fina (3/6), pero la macro está en todas. Se
 * prefiere la más específica y se cae a la macro; nunca se recalcula nada.
 */
export function zonaRetiro(s: EntradaCamposBaseDatos): string | null {
  return texto(s.zonaRetiroNombre) ?? texto(s.macroZonaRetiroNombre)
}

/** Zona de entrega, con el mismo criterio. */
export function zonaEntrega(s: EntradaCamposBaseDatos): string | null {
  return texto(s.zonaEntregaNombre) ?? texto(s.macroZonaEntregaNombre)
}

/** Teléfono del punto de retiro. Va junto a su dirección, no en "Teléfono". */
export function telefonoRetiro(s: EntradaCamposBaseDatos): string | null {
  return texto(s.recoleccion?.celular)
}

/** Teléfono del punto de entrega. */
export function telefonoEntrega(s: EntradaCamposBaseDatos): string | null {
  return texto(s.entrega?.celular)
}
