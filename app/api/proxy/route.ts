// app/api/proxy/route.ts
//
// Cálculo de distancia por carretera entre dos puntos. Pese al nombre heredado
// de la ruta, esto YA NO ES UN PROXY: el cliente no elige destino. Manda dos
// coordenadas y el servidor decide todo lo demás.
//
// ── De dónde viene esto (P1-PROXY) ─────────────────────────────────────────
// La versión original recibía la URL completa de Google en el query string y
// la validaba con:
//
//   if (!targetUrl || !targetUrl.startsWith('https://maps.googleapis.com'))
//
// startsWith() compara prefijos de CADENA, no hostnames. Pasaban destinos cuyo
// servidor real no era Google:
//   https://maps.googleapis.com.atacante.com/…  → host real: maps.googleapis.com.atacante.com
//   https://maps.googleapis.com@atacante.com/…  → lo previo a '@' es userinfo;
//                                                  host real: atacante.com
// Como el handler devolvía el cuerpo al llamante, y no exigía sesión ni tenía
// límite de tasa, servía de proxy anónimo con exfiltración.
//
// Una primera corrección endureció la validación de esa URL (parsing real,
// allowlist de host/path/parámetros). Cerró el SSRF, pero dejaba dos agujeros
// que solo se cierran cambiando la interfaz:
//   · la API key y las COORDENADAS de retiro y entrega viajaban en el query
//     string, así que quedaban escritas en los registros de acceso de la
//     plataforma — datos personales de clientes finales;
//   · el endpoint seguía siendo anónimo pese a que sus tres consumidores
//     legítimos están todos dentro de paneles autenticados.
//
// ── Modelo actual ──────────────────────────────────────────────────────────
// El cliente aporta EXCLUSIVAMENTE dos pares de coordenadas, en el cuerpo de
// un POST. No elige host, protocolo, puerto, path, parámetros, modo ni clave:
// todo eso es constante de servidor. Ya no hay ninguna "URL del cliente" que
// validar — por eso desapareció toda la maquinaria de allowlist de destino de
// la versión anterior: dejó de tener a qué aplicarse.
//
// La clave sale de GOOGLE_MAPS_SERVER_API_KEY, variable EXCLUSIVAMENTE de
// servidor. No se usa NEXT_PUBLIC_GOOGLE_MAPS_API_KEY (que sigue existiendo y
// es legítima, pero para el SDK de Maps en el navegador — ver lib/googleMaps.ts)
// y no hay fallback automático hacia ella: si falta la variable de servidor, la
// petición falla, nunca degrada a la clave pública.

import { NextRequest, NextResponse } from 'next/server'
import { adminAuth, adminDb } from '@/fb/admin'

// Admin SDK exige runtime Node; además Edge no expone las APIs de stream con
// las que se acota el tamaño de la respuesta.
export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

// ─── Política ───────────────────────────────────────────────────────────────

// Derivada de dónde se usa realmente el cálculo de distancia, no de la lista
// de roles del sistema:
//   · Comercio → /panel/comercio/calculadora y /panel/comercio/solicitar
//   · admin, gestor → /panel/gestor/calculadora y /panel/gestor/ingresar-orden
// 'motorizado' NO aparece: su panel no calcula distancias. 'cliente' tampoco:
// no tiene panel propio (rutaDeRol lo manda a /login). Agregar un rol acá es
// una decisión explícita, nunca un efecto colateral.
const ROLES_PERMITIDOS = new Set(['admin', 'gestor', 'Comercio'])

const UPSTREAM_ORIGIN = 'https://maps.googleapis.com'
const UPSTREAM_PATH = '/maps/api/distancematrix/json'
const MODO_FIJO = 'driving'

const TIMEOUT_MS = 8_000
// distancematrix de 1×1 devuelve unos pocos KB. 256 KB es holgado y a la vez
// muy lejos de lo que serviría para tunelizar contenido por acá.
const MAX_BYTES_RESPUESTA = 256 * 1024
const MAX_LARGO_COORDENADA = 64

// Lista CERRADA de campos del body. Cualquier otro (url, key, mode, hostname,
// path…) hace fallar la petición en vez de ignorarse en silencio.
const CAMPOS_PERMITIDOS = new Set(['origins', 'destinations'])

// ─── Rate limit ─────────────────────────────────────────────────────────────
//
// ⚠️ LIMITACIÓN CONOCIDA Y ACEPTADA
// El contador vive en memoria del proceso. En Vercel eso significa que es POR
// INSTANCIA, se reinicia en cada cold start y NO es un límite distribuido. No
// sustituye las cuotas de Google Cloud ni una solución persistente futura.
// Es defensa en profundidad: encarece el abuso desde una sola cuenta. Lo que
// de verdad cierra el endpoint es la autenticación y que el destino sea
// constante de servidor, no este contador.
// Un límite distribuido real exigiría almacenamiento compartido (Redis, KV o
// Firestore), que este bloque tiene prohibido introducir.
const RL_MAX_PETICIONES = 60
const RL_VENTANA_MS = 60_000
const RL_MAX_CLAVES = 5_000
const rlPorUid = new Map<string, number[]>()

function superaRateLimit(uid: string): boolean {
  const ahora = Date.now()

  // Poda perezosa: sin esto el Map crece sin techo durante la vida del proceso.
  if (rlPorUid.size > RL_MAX_CLAVES) {
    for (const [k, marcas] of rlPorUid) {
      const vivas = marcas.filter((t) => ahora - t < RL_VENTANA_MS)
      if (vivas.length === 0) rlPorUid.delete(k)
      else rlPorUid.set(k, vivas)
    }
  }

  const previas = (rlPorUid.get(uid) ?? []).filter((t) => ahora - t < RL_VENTANA_MS)
  if (previas.length >= RL_MAX_PETICIONES) {
    rlPorUid.set(uid, previas)
    return true
  }
  previas.push(ahora)
  rlPorUid.set(uid, previas)
  return false
}

// ─── Respuestas ─────────────────────────────────────────────────────────────

// Cuerpos genéricos: distinguir "rol no permitido" de "usuario inactivo" le
// confirmaría a quien sondea qué parte de la política tocó.
const ERROR_AUTENTICACION = { error: 'No autorizado.' }
const ERROR_PERMISO = { error: 'Sin permiso para esta operación.' }
const ERROR_SOLICITUD = { error: 'Solicitud no permitida.' }
const ERROR_SERVICIO = { error: 'No se pudo calcular la distancia.' }

function cuerpoPara(status: number) {
  if (status === 401) return ERROR_AUTENTICACION
  if (status === 403) return ERROR_PERMISO
  if (status === 400) return ERROR_SOLICITUD
  return ERROR_SERVICIO
}

/**
 * Log deliberadamente pobre: código interno + rol + status. NUNCA el body, el
 * token, la Authorization, la clave, las coordenadas ni la URL construida.
 * Tampoco el UID completo — el rol basta para diagnosticar y no identifica a
 * una persona concreta en el registro.
 */
function rechazar(status: number, codigoInterno: string, rol = '-'): NextResponse {
  console.warn(`[distancia] rechazo=${codigoInterno} rol=${rol} status=${status}`)
  return NextResponse.json(cuerpoPara(status), { status })
}

// ─── Autenticación ──────────────────────────────────────────────────────────

type Autorizacion =
  | { ok: true; uid: string; rol: string }
  | { ok: false; status: 401 | 403; codigo: string }

/**
 * Mismo criterio que app/api/send-welcome/route.ts: ID token de Firebase
 * verificado server-side, y perfil releído de Firestore. Nunca se confía en
 * nada que venga del cliente — ni el rol, ni el uid del propio token bastan
 * sin comprobar usuarios/{uid} en el momento de la petición (una cuenta dada
 * de baja conserva su token hasta que expira).
 */
async function autorizar(req: NextRequest): Promise<Autorizacion> {
  const cabecera = req.headers.get('authorization') ?? ''
  const match = cabecera.match(/^Bearer (.+)$/)
  if (!match) return { ok: false, status: 401, codigo: 'sin_bearer' }

  let uid: string
  try {
    uid = (await adminAuth.verifyIdToken(match[1])).uid
  } catch {
    return { ok: false, status: 401, codigo: 'token_invalido' }
  }

  const snap = await adminDb.collection('usuarios').doc(uid).get()
  if (!snap.exists) return { ok: false, status: 403, codigo: 'sin_perfil' }

  const perfil = snap.data()
  if (perfil?.activo !== true) return { ok: false, status: 403, codigo: 'inactivo' }

  const rol = typeof perfil?.rol === 'string' ? perfil.rol : ''
  if (!ROLES_PERMITIDOS.has(rol)) return { ok: false, status: 403, codigo: 'rol_no_permitido' }

  return { ok: true, uid, rol }
}

// ─── Validación de coordenadas ──────────────────────────────────────────────

// Estricta a propósito: sin espacios internos, sin notación exponencial, sin
// signo '+', sin hexadecimal. Number() acepta cosas como '0x1F', ' 12 ' o
// '1e2', que Google interpretaría de formas no previstas.
//
// El tope de decimales es 20, no 10. REGRESIÓN CORREGIDA: con {1,10} se
// rechazaban las coordenadas REALES del SDK de Maps, que llegan con precisión
// completa de doble (p. ej. 15 decimales). Un lat/lng legítimo del navegador
// devolvía 400. 20 cubre con margen los ~17 dígitos significativos de un
// double, y el largo total ya está acotado por MAX_LARGO_COORDENADA — el
// cuantificador no es la defensa contra cargas largas, solo fija la FORMA.
const NUMERO_ESTRICTO = /^-?\d{1,3}(\.\d{1,20})?$/

/**
 * Serializa un número validado sin notación exponencial. String() la usa para
 * magnitudes < 1e-6 ('1e-7'), y Google no interpreta esa forma como
 * coordenada. Fuera de ese caso devuelve la representación más corta que
 * round-trip exacto — así la precisión del origen se conserva íntegra.
 */
function aTextoDecimal(n: number): string {
  if (n !== 0 && Math.abs(n) < 1e-6) return n.toFixed(20).replace(/0+$/, '')
  return String(n)
}

/**
 * Acepta "lat,lng" y devuelve la forma NORMALIZADA a partir de los números ya
 * parseados. La cadena original nunca se reenvía: lo que sale hacia Google se
 * reconstruye acá.
 *
 * Rechaza por construcción: múltiples orígenes ('|' o comas de más), texto,
 * URLs, HTML y cualquier cosa que no sean exactamente dos números en rango.
 */
function normalizarCoordenada(valor: unknown): string | null {
  if (typeof valor !== 'string') return null

  const limpio = valor.trim()
  if (limpio.length === 0 || limpio.length > MAX_LARGO_COORDENADA) return null

  const partes = limpio.split(',')
  if (partes.length !== 2) return null

  const [latCruda, lngCruda] = partes
  if (!NUMERO_ESTRICTO.test(latCruda) || !NUMERO_ESTRICTO.test(lngCruda)) return null

  const lat = Number(latCruda)
  const lng = Number(lngCruda)
  if (!Number.isFinite(lat) || !Number.isFinite(lng)) return null
  if (lat < -90 || lat > 90) return null
  if (lng < -180 || lng > 180) return null

  // Normalización sin pérdida: se reconstruye desde los números parseados, no
  // desde la cadena recibida, pero no se recorta la precisión — reducirla
  // desplazaría el punto consultado.
  return `${aTextoDecimal(lat)},${aTextoDecimal(lng)}`
}

// ─── Handler ────────────────────────────────────────────────────────────────
//
// Solo se exporta POST: el App Router responde 405 automáticamente a GET, PUT,
// DELETE y demás. El antiguo `GET /api/proxy?url=…` queda eliminado, no
// deprecado — no hay compatibilidad silenciosa con la interfaz insegura.

export async function POST(req: NextRequest) {
  const auth = await autorizar(req)
  if (!auth.ok) return rechazar(auth.status, auth.codigo)

  if (superaRateLimit(auth.uid)) return rechazar(429, 'rate_limit', auth.rol)

  // ── Body: lista cerrada de campos ─────────────────────────────────────────
  let body: unknown
  try {
    body = await req.json()
  } catch {
    return rechazar(400, 'json_invalido', auth.rol)
  }
  if (typeof body !== 'object' || body === null || Array.isArray(body)) {
    return rechazar(400, 'body_no_objeto', auth.rol)
  }

  const claves = Object.keys(body as Record<string, unknown>)
  // Se rechaza cualquier campo extra en vez de ignorarlo: si un cliente manda
  // `key`, `url` o `mode`, es señal de que está usando una interfaz que ya no
  // existe, y fallar ruidosamente es preferible a atenderlo a medias.
  for (const clave of claves) {
    if (!CAMPOS_PERMITIDOS.has(clave)) return rechazar(400, 'campo_no_permitido', auth.rol)
  }

  const datos = body as { origins?: unknown; destinations?: unknown }
  const origins = normalizarCoordenada(datos.origins)
  if (!origins) return rechazar(400, 'origins_invalido', auth.rol)
  const destinations = normalizarCoordenada(datos.destinations)
  if (!destinations) return rechazar(400, 'destinations_invalido', auth.rol)

  // ── Clave de servidor: sin fallback hacia la pública ──────────────────────
  const apiKey = process.env.GOOGLE_MAPS_SERVER_API_KEY
  if (!apiKey) {
    // El log no dice si la variable falta, está vacía o cuánto mide — solo que
    // la configuración del servidor impide atender. Al cliente le llega el
    // mismo error de servicio que a cualquier otro fallo upstream.
    console.error('[distancia] rechazo=config_servidor status=500')
    return NextResponse.json(ERROR_SERVICIO, { status: 500 })
  }

  // ── URL construida íntegramente por el servidor ───────────────────────────
  // Ni un solo carácter proviene del cliente: origins/destinations son las
  // cadenas normalizadas a partir de números ya validados.
  const destino = new URL(UPSTREAM_PATH, UPSTREAM_ORIGIN)
  destino.search = new URLSearchParams({
    origins,
    destinations,
    mode: MODO_FIJO,
    key: apiKey,
  }).toString()

  const abort = new AbortController()
  const temporizador = setTimeout(() => abort.abort(), TIMEOUT_MS)

  try {
    const upstream = await fetch(destino, {
      method: 'GET',
      signal: abort.signal,
      cache: 'no-store',
      // Sin seguimiento automático: un 30x hacia otro host convertiría en
      // decorativo el hecho de que la URL la construya el servidor.
      redirect: 'manual',
      // Cabeceras fijadas acá. NADA del request del usuario se reenvía: ni
      // cookies, ni Authorization, ni cabeceras arbitrarias.
      headers: { Accept: 'application/json' },
    })

    // redirect:'manual' entrega la respuesta 30x en vez de seguirla. No se lee
    // ni se refleja Location — es un valor que controla el upstream.
    if (upstream.status >= 300 && upstream.status < 400) {
      return rechazar(502, 'redireccion_rechazada', auth.rol)
    }
    if (!upstream.ok) return rechazar(502, `upstream_${upstream.status}`, auth.rol)

    // El consumidor hace res.json(): si el upstream devolviera HTML (portal
    // cautivo, página de error), el parseo fallaría con un error confuso.
    const contentType = upstream.headers.get('content-type') ?? ''
    if (!contentType.toLowerCase().includes('json')) {
      return rechazar(502, 'content_type_inesperado', auth.rol)
    }

    // Corte temprano por cabecera cuando el upstream la declara…
    const declarado = Number(upstream.headers.get('content-length') ?? '')
    if (Number.isFinite(declarado) && declarado > MAX_BYTES_RESPUESTA) {
      return rechazar(502, 'respuesta_demasiado_grande', auth.rol)
    }

    // …y corte real leyendo el cuerpo, porque content-length puede faltar o
    // mentir (respuestas chunked).
    if (!upstream.body) return rechazar(502, 'respuesta_sin_cuerpo', auth.rol)
    const lector = upstream.body.getReader()
    const trozos: Uint8Array[] = []
    let total = 0
    for (;;) {
      const { done, value } = await lector.read()
      if (done) break
      if (!value) continue
      total += value.byteLength
      if (total > MAX_BYTES_RESPUESTA) {
        // cancel() corta la descarga en curso: sin esto se seguirían
        // transfiriendo bytes que ya decidimos descartar.
        await lector.cancel().catch(() => {})
        return rechazar(502, 'respuesta_demasiado_grande', auth.rol)
      }
      trozos.push(value)
    }

    let datosUpstream: unknown
    try {
      datosUpstream = JSON.parse(Buffer.concat(trozos).toString('utf-8'))
    } catch {
      return rechazar(502, 'json_invalido_upstream', auth.rol)
    }

    // Respuesta construida por nosotros. No se reenvía NINGUNA cabecera del
    // origen (ni set-cookie, ni cache, ni las de rastreo de Google), y el
    // cuerpo de Google no contiene la URL ni la clave con las que se pidió.
    return NextResponse.json(datosUpstream, {
      status: 200,
      headers: {
        'Cache-Control': 'private, no-store',
        'X-Content-Type-Options': 'nosniff',
      },
    })
  } catch (err) {
    // Se distingue timeout de fallo de red solo para el log interno; al cliente
    // le llega el mismo cuerpo genérico en ambos casos.
    const esTimeout = err instanceof Error && err.name === 'AbortError'
    return rechazar(504, esTimeout ? 'timeout' : 'fallo_red', auth.rol)
  } finally {
    clearTimeout(temporizador)
  }
}
