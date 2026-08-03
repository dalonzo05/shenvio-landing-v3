import { auth } from '@/fb/config'

/**
 * Pide al servidor la distancia por carretera entre dos puntos.
 *
 * Existe para no repetir el mismo bloque en los tres sitios que calculan
 * distancia (calculadora, alta de orden del comercio y del gestor): antes los
 * tres armaban a mano la URL de Google —clave incluida— y la mandaban a
 * /api/proxy en el query string. Eso dejaba la clave y las coordenadas de
 * retiro y entrega escritas en los registros de acceso de la plataforma.
 *
 * Ahora solo viajan las dos coordenadas, en el cuerpo de un POST. El host, el
 * path, el modo y la clave son constantes de servidor — ver app/api/proxy/route.ts.
 *
 * @param origen  "lat,lng" del punto de retiro
 * @param destino "lat,lng" del punto de entrega
 * @returns metros, o null si no se pudo calcular. Nunca lanza: los tres
 *          consumidores ya tratan `null` como "no se pudo", y hacerlo lanzar
 *          cambiaría su manejo de errores actual.
 */
export async function obtenerDistanciaMetros(
  origen: string,
  destino: string,
): Promise<number | null> {
  try {
    // El token se pide en cada llamada en vez de cachearse: el SDK devuelve el
    // vigente y lo refresca solo si hace falta, así que una sesión larga no
    // termina mandando un token vencido.
    const token = await auth.currentUser?.getIdToken()
    if (!token) return null

    const res = await fetch('/api/proxy', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify({ origins: origen, destinations: destino }),
    })
    if (!res.ok) return null

    const data = await res.json()
    return data?.rows?.[0]?.elements?.[0]?.distance?.value ?? null
  } catch {
    return null
  }
}
