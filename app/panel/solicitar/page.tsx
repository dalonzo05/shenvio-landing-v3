'use client'

import { useEffect, useMemo, useState } from 'react'
import { addDoc, collection, serverTimestamp } from 'firebase/firestore'
import { auth, db } from '@/fb/config'

const WHATSAPP = '50588888888' // solo para pruebas por ahora

type TipoUbicacion = 'referencial' | 'exacto'
type TipoCliente = 'contado' | 'credito'
type QuienPagaDelivery = 'recoleccion' | 'entrega' | 'transferencia' | ''
type DeducirDelivery = 'no_deducir' | 'deducir_del_cobro' // solo si hay cobro CE y paga entrega

export default function SolicitarEnvioPage() {
  // --- Info del draft (cotización) ---
  const [draft, setDraft] = useState<any>(null)

  // --- Tipo de cliente (idealmente esto será un permiso interno) ---
  const [tipoCliente, setTipoCliente] = useState<TipoCliente>('contado')

  // -----------------------
  // RECOLECCIÓN (RETIRO)
  // -----------------------
  // Dirección escrita (manda esta)
  const [recoleccionDireccion, setRecoleccionDireccion] = useState('')
  // Punto Google (si viene de cotización)
  const [recoleccionPuntoGoogle, setRecoleccionPuntoGoogle] = useState('')
  // Link Google Maps (solo si NO hay cotización)
  const [recoleccionGoogleLink, setRecoleccionGoogleLink] = useState('')
  // Referencial / exacto aplicado al PUNTO GOOGLE (cotización/link)
  const [recoleccionTipoUbicacion, setRecoleccionTipoUbicacion] =
    useState<TipoUbicacion>('referencial')

  const [recoleccionNombreApellido, setRecoleccionNombreApellido] = useState('')
  const [recoleccionCelular, setRecoleccionCelular] = useState('')

  // -----------------------
  // ENTREGA
  // -----------------------
  const [entregaDireccion, setEntregaDireccion] = useState('')
  const [entregaPuntoGoogle, setEntregaPuntoGoogle] = useState('')
  const [entregaGoogleLink, setEntregaGoogleLink] = useState('')
  const [entregaTipoUbicacion, setEntregaTipoUbicacion] =
    useState<TipoUbicacion>('referencial')

  const [entregaNombreApellido, setEntregaNombreApellido] = useState('')
  const [entregaCelular, setEntregaCelular] = useState('')

  // -----------------------
  // PAGOS
  // -----------------------
  // Cobro contra entrega (normalmente asociado a ENTREGA)
  const [cobroCE, setCobroCE] = useState(false)
  const [montoCE, setMontoCE] = useState<number | ''>('')

  // Solo si tipoCliente = contado
  const [quienPagaDelivery, setQuienPagaDelivery] = useState<QuienPagaDelivery>('')

  // Deducir delivery del cobro CE (solo si: cobroCE && quienPagaDelivery === 'entrega')
  const [deducirDelivery, setDeducirDelivery] = useState<DeducirDelivery>('no_deducir')

  // -----------------------
  // EXTRA
  // -----------------------
  const [detalle, setDetalle] = useState('')

  // UI
  const [saving, setSaving] = useState(false)
  const [msg, setMsg] = useState<string | null>(null)

  // Cargar draftEnvio desde Calculadora (si existe)
  useEffect(() => {
    try {
      const raw = sessionStorage.getItem('draftEnvio')
      if (!raw) return
      const d = JSON.parse(raw)
      setDraft(d)

      // Punto Google (cotización) -> read only
      setRecoleccionPuntoGoogle(d.origen || '')
      setEntregaPuntoGoogle(d.destino || '')

      // Importante:
      // NO llenamos la dirección escrita con el texto de Google,
      // porque la dirección escrita la debe confirmar/escribir el cliente.
      // Si querés, podrías ponerlo SOLO como placeholder, no como value.

      // Tipo de ubicación aplicado al PUNTO GOOGLE (no a la dirección escrita)
      setRecoleccionTipoUbicacion(d.origenTipo || 'referencial')
      setEntregaTipoUbicacion(d.destinoTipo || 'referencial')
    } catch {}
  }, [])

  const tieneCotizacion = !!draft

  const precioSugerido = useMemo(() => {
    const p = draft?.precioCordobas
    return typeof p === 'number' ? p : null
  }, [draft])

  // Quitar cotización (para poder usar Solicitar directo)
  const handleQuitarCotizacion = () => {
    try {
      sessionStorage.removeItem('draftEnvio')
    } catch {}
    setDraft(null)

    // limpiamos puntos Google (cotización)
    setRecoleccionPuntoGoogle('')
    setEntregaPuntoGoogle('')

    // reseteo tipos (queda a elección del usuario)
    setRecoleccionTipoUbicacion('referencial')
    setEntregaTipoUbicacion('referencial')

    setMsg('Cotización quitada. Ahora estás creando una solicitud directa.')
  }

  // Invertir recolección <-> entrega (como “invertir direcciones”)
  const handleInvertir = () => {
    // swap direcciones escritas
    const tmpDir = recoleccionDireccion
    setRecoleccionDireccion(entregaDireccion)
    setEntregaDireccion(tmpDir)

    // swap puntos google
    const tmpPg = recoleccionPuntoGoogle
    setRecoleccionPuntoGoogle(entregaPuntoGoogle)
    setEntregaPuntoGoogle(tmpPg)

    // swap links (solo si es solicitud directa, pero igual lo swap-emos)
    const tmpLink = recoleccionGoogleLink
    setRecoleccionGoogleLink(entregaGoogleLink)
    setEntregaGoogleLink(tmpLink)

    // swap tipo ubicacion punto google
    const tmpTipo = recoleccionTipoUbicacion
    setRecoleccionTipoUbicacion(entregaTipoUbicacion)
    setEntregaTipoUbicacion(tmpTipo)

    // swap contactos
    const tmpNom = recoleccionNombreApellido
    setRecoleccionNombreApellido(entregaNombreApellido)
    setEntregaNombreApellido(tmpNom)

    const tmpCel = recoleccionCelular
    setRecoleccionCelular(entregaCelular)
    setEntregaCelular(tmpCel)

    // Cobro CE normalmente está asociado a entrega, pero si invertís, lo coherente es invertirlo también
    // (si no querés, lo quitamos aquí)
    // Lo dejamos tal cual para no “romper” la intención del usuario.
  }

  // WhatsApp (solo prueba / respaldo)
  const handleEnviarWhatsApp = (e: React.FormEvent) => {
    e.preventDefault()

    const texto = `Hola, quiero solicitar un envío:

RECOLECCIÓN:
- Dirección escrita: ${recoleccionDireccion || '—'}
- Punto Google: ${tieneCotizacion ? recoleccionPuntoGoogle : (recoleccionGoogleLink || '—')}
- Punto Google es: ${recoleccionTipoUbicacion}
- Nombre y apellido: ${recoleccionNombreApellido || '—'}
- Celular: ${recoleccionCelular || '—'}

ENTREGA:
- Dirección escrita: ${entregaDireccion || '—'}
- Punto Google: ${tieneCotizacion ? entregaPuntoGoogle : (entregaGoogleLink || '—')}
- Punto Google es: ${entregaTipoUbicacion}
- Nombre y apellido: ${entregaNombreApellido || '—'}
- Celular: ${entregaCelular || '—'}

PAGOS:
- Tipo cliente: ${tipoCliente}
- Cobro contra entrega: ${cobroCE ? `Sí (C$ ${montoCE || '—'})` : 'No'}
- Quién paga delivery: ${tipoCliente === 'credito' ? 'Crédito semanal' : (quienPagaDelivery || '—')}
- Deducir delivery del cobro: ${deducirDelivery}
- Precio sugerido: ${precioSugerido ? `C$ ${precioSugerido}` : '—'}

Detalle: ${detalle || '—'}`

    const url = `https://wa.me/${WHATSAPP}?text=${encodeURIComponent(texto)}`
    window.open(url, '_blank')
  }

  // Guardar solicitud (pendiente confirmación del gestor)
  const handleGuardarSolicitud = async () => {
    setMsg(null)

    // Validación mínima
    if (!recoleccionDireccion.trim() || !entregaDireccion.trim()) {
      setMsg('Falta completar Dirección escrita en recolección y/o entrega.')
      return
    }
    if (!recoleccionCelular.trim() || !entregaCelular.trim()) {
      setMsg('Falta el número de celular en recolección y/o entrega.')
      return
    }
    if (cobroCE && (montoCE === '' || Number(montoCE) <= 0)) {
      setMsg('Marcaste cobro contra entrega, pero falta el monto.')
      return
    }
    if (tipoCliente === 'contado' && !quienPagaDelivery) {
      setMsg('Seleccioná quién paga el delivery (solo para contado).')
      return
    }

    // Si NO hay cotización, el link de maps es opcional; pero si lo ponen, genial.
    // Si hay cotización, no pedimos link.

    try {
      setSaving(true)

      const user = auth.currentUser
      if (!user) {
        setMsg('No hay sesión iniciada. Volvé a iniciar sesión.')
        return
      }

      // Reglas para deducir
      const deducirAplica =
        tipoCliente === 'contado' &&
        cobroCE &&
        quienPagaDelivery === 'entrega' &&
        deducirDelivery === 'deducir_del_cobro'

      await addDoc(collection(db, 'solicitudes_envio'), {
        userId: user.uid,

        tipoCliente, // credito / contado
        tieneCotizacion,

        // Para el gestor: esto ayuda a decidir si confiar en precio/distancia o asignar manual
        cotizacion: tieneCotizacion
          ? {
              origenTextoGoogle: recoleccionPuntoGoogle || null,
              destinoTextoGoogle: entregaPuntoGoogle || null,
              origenCoord: draft?.origenCoord || null,
              destinoCoord: draft?.destinoCoord || null,
              distanciaKm: draft?.distanciaKm ?? null,
              precioSugerido: draft?.precioCordobas ?? null,
            }
          : {
              origenTextoGoogle: null,
              destinoTextoGoogle: null,
              origenCoord: null,
              destinoCoord: null,
              distanciaKm: null,
              precioSugerido: null,
            },

        // Recolección (manda dirección escrita)
        recoleccion: {
          direccionEscrita: recoleccionDireccion.trim(),
          puntoGoogleTexto: tieneCotizacion ? (recoleccionPuntoGoogle || null) : null,
          puntoGoogleLink: !tieneCotizacion ? (recoleccionGoogleLink.trim() || null) : null,
          puntoGoogleTipo: recoleccionTipoUbicacion, // referencial/exacto del punto google
          nombreApellido: recoleccionNombreApellido.trim(),
          celular: recoleccionCelular.trim(),
        },

        // Entrega
        entrega: {
          direccionEscrita: entregaDireccion.trim(),
          puntoGoogleTexto: tieneCotizacion ? (entregaPuntoGoogle || null) : null,
          puntoGoogleLink: !tieneCotizacion ? (entregaGoogleLink.trim() || null) : null,
          puntoGoogleTipo: entregaTipoUbicacion,
          nombreApellido: entregaNombreApellido.trim(),
          celular: entregaCelular.trim(),
        },

        // Pagos
        cobroContraEntrega: {
          aplica: cobroCE,
          monto: cobroCE ? Number(montoCE) : 0,
        },

        pagoDelivery:
          tipoCliente === 'credito'
            ? {
                tipo: 'credito_semanal',
                quienPaga: 'credito_semanal',
                // el monto se define/valida por gestor
                montoSugerido: draft?.precioCordobas ?? null,
              }
            : {
                tipo: 'contado',
                quienPaga: quienPagaDelivery, // recoleccion / entrega / transferencia
                montoSugerido: draft?.precioCordobas ?? null,
                deducirDelCobroContraEntrega: deducirAplica,
              },

        detalle: detalle.trim(),

        // Flujo
        estado: 'pendiente_confirmacion',
        createdAt: serverTimestamp(),
      })

      setMsg('✅ Solicitud guardada. Ya aparece en el panel del gestor para confirmación.')
    } catch (err) {
      console.error(err)
      setMsg('❌ No se pudo guardar la solicitud. Revisá consola.')
    } finally {
      setSaving(false)
    }
  }

  return (
    <div className="max-w-2xl">
      <h1 className="text-2xl font-bold mb-2">Solicitar envío</h1>
      <p className="text-sm text-gray-600 mb-4">
        Guardá la solicitud para que el gestor la confirme (Telegram queda solo como soporte).
      </p>

      {msg && (
        <div className="mb-4 rounded-lg border px-3 py-2 text-sm bg-gray-50">
          {msg}
        </div>
      )}

      <form onSubmit={handleEnviarWhatsApp} className="bg-white rounded-2xl border shadow-sm p-6 space-y-5">
        {/* CABECERA: Tipo cliente + Cotización detectada */}
        <div className="rounded-xl border p-4 bg-gray-50">
          <div className="flex items-center justify-between gap-3 flex-wrap">
            <div>
              <h3 className="font-semibold">Tipo de cliente</h3>
              <p className="text-xs text-gray-500">
                (Ideal: esto lo define Storkhub en Ajustes / Admin, no el cliente)
              </p>
            </div>

            <select
              value={tipoCliente}
              onChange={(e) => setTipoCliente(e.target.value as TipoCliente)}
              className="border rounded-lg px-3 py-2 outline-none focus:ring-2 focus:ring-[#004aad]"
            >
              <option value="contado">Al contado</option>
              <option value="credito">Crédito (pago semanal)</option>
            </select>
          </div>

          <div className="mt-3 flex items-center justify-between gap-3 flex-wrap">
            <div className="text-sm">
              {tieneCotizacion ? (
                <span>✅ Se detectó una cotización previa (Calculadora). El gestor podrá validar precio/distancia.</span>
              ) : (
                <span>ℹ️ Solicitud directa (sin cotización). El gestor asignará el precio al confirmar.</span>
              )}
            </div>

            {tieneCotizacion && (
              <button
                type="button"
                onClick={handleQuitarCotizacion}
                className="text-sm underline"
                title="Para solicitar sin arrastrar la cotización anterior"
              >
                Quitar cotización
              </button>
            )}
          </div>

          <div className="mt-3">
            <button
              type="button"
              onClick={handleInvertir}
              className="rounded-full border px-4 py-2 text-sm hover:bg-white transition"
            >
              Invertir recolección ↔ entrega
            </button>
          </div>
        </div>

        {/* RECOLECCIÓN */}
        <div className="rounded-xl border p-4 bg-gray-50">
          <h3 className="font-semibold mb-3">Datos de RECOLECCIÓN</h3>

          {tieneCotizacion && (
            <div className="mb-3">
              <label className="block text-sm font-medium mb-1">Punto en Google (cotización)</label>
              <input
                value={recoleccionPuntoGoogle}
                readOnly
                className="w-full border rounded-lg px-3 py-2 bg-gray-100 text-gray-700"
              />
              <p className="text-xs text-gray-500 mt-1">
                (Solo referencia: la <strong>dirección escrita</strong> es la que manda)
              </p>
            </div>
          )}

          <div>
            <label className="block text-sm font-medium mb-1">Dirección de recolección (escrita) *</label>
            <input
              value={recoleccionDireccion}
              onChange={(e) => setRecoleccionDireccion(e.target.value)}
              className="w-full border rounded-lg px-3 py-2 outline-none focus:ring-2 focus:ring-[#004aad]"
              placeholder="Ej: Reparto San Juan, de los semáforos..., 2c abajo..."
              required
            />
          </div>

          {/* Referencial/Exacto DEL PUNTO GOOGLE */}
          <div className="mt-3">
            <div className="flex gap-3 text-sm">
              <label className="flex items-center gap-2">
                <input
                  type="radio"
                  name="recoleccionTipoUbicacion"
                  checked={recoleccionTipoUbicacion === 'referencial'}
                  onChange={() => setRecoleccionTipoUbicacion('referencial')}
                />
                Referencial
              </label>
              <label className="flex items-center gap-2">
                <input
                  type="radio"
                  name="recoleccionTipoUbicacion"
                  checked={recoleccionTipoUbicacion === 'exacto'}
                  onChange={() => setRecoleccionTipoUbicacion('exacto')}
                />
                Exacto
              </label>
            </div>

            <p className="text-xs text-gray-500 mt-2">
              <strong>Referencial:</strong> el gestor valida el precio. <strong>Exacto:</strong> ayuda a llegar mejor.
            </p>
          </div>

          {/* Link Maps SOLO si NO hay cotización */}
          {!tieneCotizacion && (
            <div className="mt-3">
              <label className="block text-sm font-medium mb-1">Link / ubicación Google Maps (opcional)</label>
              <input
                value={recoleccionGoogleLink}
                onChange={(e) => setRecoleccionGoogleLink(e.target.value)}
                className="w-full border rounded-lg px-3 py-2 outline-none focus:ring-2 focus:ring-[#004aad]"
                placeholder="Pegá link de Google Maps si el cliente lo compartió"
              />
            </div>
          )}

          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3 mt-4">
            <div>
              <label className="block text-sm font-medium mb-1">Nombre y apellido</label>
              <input
                value={recoleccionNombreApellido}
                onChange={(e) => setRecoleccionNombreApellido(e.target.value)}
                className="w-full border rounded-lg px-3 py-2 outline-none focus:ring-2 focus:ring-[#004aad]"
                placeholder="Ej: Tienda X / Juan Pérez"
              />
            </div>
            <div>
              <label className="block text-sm font-medium mb-1">Número de celular *</label>
              <input
                value={recoleccionCelular}
                onChange={(e) => setRecoleccionCelular(e.target.value)}
                className="w-full border rounded-lg px-3 py-2 outline-none focus:ring-2 focus:ring-[#004aad]"
                placeholder="Ej: 8888-8888"
                required
              />
            </div>
          </div>
        </div>

        {/* ENTREGA */}
        <div className="rounded-xl border p-4 bg-gray-50">
          <h3 className="font-semibold mb-3">Datos de ENTREGA</h3>

          {tieneCotizacion && (
            <div className="mb-3">
              <label className="block text-sm font-medium mb-1">Punto en Google (cotización)</label>
              <input
                value={entregaPuntoGoogle}
                readOnly
                className="w-full border rounded-lg px-3 py-2 bg-gray-100 text-gray-700"
              />
              <p className="text-xs text-gray-500 mt-1">
                (Solo referencia: la <strong>dirección escrita</strong> es la que manda)
              </p>
            </div>
          )}

          <div>
            <label className="block text-sm font-medium mb-1">Dirección de entrega (escrita) *</label>
            <input
              value={entregaDireccion}
              onChange={(e) => setEntregaDireccion(e.target.value)}
              className="w-full border rounded-lg px-3 py-2 outline-none focus:ring-2 focus:ring-[#004aad]"
              placeholder="Ej: Frente a..., portón negro..., casa esquinera..."
              required
            />
          </div>

          <div className="mt-3">
            <div className="flex gap-3 text-sm">
              <label className="flex items-center gap-2">
                <input
                  type="radio"
                  name="entregaTipoUbicacion"
                  checked={entregaTipoUbicacion === 'referencial'}
                  onChange={() => setEntregaTipoUbicacion('referencial')}
                />
                Referencial
              </label>
              <label className="flex items-center gap-2">
                <input
                  type="radio"
                  name="entregaTipoUbicacion"
                  checked={entregaTipoUbicacion === 'exacto'}
                  onChange={() => setEntregaTipoUbicacion('exacto')}
                />
                Exacto
              </label>
            </div>
          </div>

          {!tieneCotizacion && (
            <div className="mt-3">
              <label className="block text-sm font-medium mb-1">Link / ubicación Google Maps (opcional)</label>
              <input
                value={entregaGoogleLink}
                onChange={(e) => setEntregaGoogleLink(e.target.value)}
                className="w-full border rounded-lg px-3 py-2 outline-none focus:ring-2 focus:ring-[#004aad]"
                placeholder="Pegá link de Google Maps si el cliente lo compartió"
              />
            </div>
          )}

          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3 mt-4">
            <div>
              <label className="block text-sm font-medium mb-1">Nombre y apellido</label>
              <input
                value={entregaNombreApellido}
                onChange={(e) => setEntregaNombreApellido(e.target.value)}
                className="w-full border rounded-lg px-3 py-2 outline-none focus:ring-2 focus:ring-[#004aad]"
                placeholder="Ej: María / Cliente final"
              />
            </div>
            <div>
              <label className="block text-sm font-medium mb-1">Número de celular *</label>
              <input
                value={entregaCelular}
                onChange={(e) => setEntregaCelular(e.target.value)}
                className="w-full border rounded-lg px-3 py-2 outline-none focus:ring-2 focus:ring-[#004aad]"
                placeholder="Ej: 7777-7777"
                required
              />
            </div>
          </div>

          {/* Cobro contra entrega (dentro de entrega) */}
          <div className="mt-4 border-t pt-4">
            <div className="flex items-center gap-2">
              <input
                type="checkbox"
                checked={cobroCE}
                onChange={(e) => setCobroCE(e.target.checked)}
              />
              <span className="text-sm">Hay cobro contra entrega</span>
            </div>

            {cobroCE && (
              <div className="mt-3">
                <label className="block text-sm font-medium mb-1">Monto contra entrega (C$)</label>
                <input
                  type="number"
                  value={montoCE}
                  onChange={(e) => setMontoCE(e.target.value === '' ? '' : Number(e.target.value))}
                  className="w-full border rounded-lg px-3 py-2 outline-none focus:ring-2 focus:ring-[#004aad]"
                  placeholder="Ej: 1000"
                />
              </div>
            )}
          </div>
        </div>

        {/* PAGOS DELIVERY */}
        <div className="rounded-xl border p-4">
          <h3 className="font-semibold mb-3">Pagos</h3>

          {tipoCliente === 'credito' ? (
            <div className="text-sm text-gray-700">
              Cliente con <strong>crédito</strong>: se asume <strong>pago semanal</strong>.
              {precioSugerido !== null && (
                <p className="text-xs text-gray-500 mt-2">
                  Precio sugerido por cotización: <strong>C$ {precioSugerido}</strong> (el gestor lo confirmará)
                </p>
              )}
            </div>
          ) : (
            <>
              <label className="block text-sm font-medium mb-1">¿Quién paga el delivery?</label>
              <select
                value={quienPagaDelivery}
                onChange={(e) => setQuienPagaDelivery(e.target.value as any)}
                className="w-full border rounded-lg px-3 py-2 outline-none focus:ring-2 focus:ring-[#004aad]"
                required
              >
                <option value="" disabled>Seleccioná…</option>
                <option value="recoleccion">Lo paga la RECOLECCIÓN</option>
                <option value="entrega">Lo paga la ENTREGA</option>
                <option value="transferencia">Transferencia</option>
              </select>

              {/* DEDUCIR */}
              {cobroCE && quienPagaDelivery === 'entrega' && (
                <div className="mt-4">
                  <label className="block text-sm font-medium mb-1">Deducir delivery del cobro contra entrega</label>
                  <select
                    value={deducirDelivery}
                    onChange={(e) => setDeducirDelivery(e.target.value as DeducirDelivery)}
                    className="w-full border rounded-lg px-3 py-2 outline-none focus:ring-2 focus:ring-[#004aad]"
                  >
                    <option value="no_deducir">No deducir</option>
                    <option value="deducir_del_cobro">Sí, deducir del cobro</option>
                  </select>

                  <p className="text-xs text-gray-500 mt-2">
                    Ej: Cobro C$1000 y delivery C$100 → se deposita C$900.
                  </p>
                </div>
              )}

              {precioSugerido !== null && (
                <p className="text-xs text-gray-500 mt-3">
                  Precio sugerido por cotización: <strong>C$ {precioSugerido}</strong> (el gestor lo confirmará)
                </p>
              )}
            </>
          )}
        </div>

        {/* Detalle */}
        <div>
          <label className="block text-sm font-medium mb-1">Detalle / instrucciones (opcional)</label>
          <textarea
            value={detalle}
            onChange={(e) => setDetalle(e.target.value)}
            placeholder="Ej: Entregar entre 2-4pm. Llamar antes. Portón negro."
            className="w-full border rounded-lg px-3 py-2 outline-none focus:ring-2 focus:ring-[#004aad]"
            rows={4}
          />
        </div>

        {/* Acciones */}
        <div className="pt-2 flex flex-col sm:flex-row gap-2">
          <button
            type="button"
            onClick={handleGuardarSolicitud}
            disabled={saving}
            className="rounded-full bg-[#004aad] text-white font-semibold px-5 py-2 hover:bg-[#003a92] transition disabled:opacity-60"
          >
            {saving ? 'Guardando...' : 'Guardar solicitud (pendiente de confirmación)'}
          </button>

          <button
            type="submit"
            className="rounded-full border font-semibold px-5 py-2 hover:bg-gray-50 transition"
            title="Solo para pruebas / respaldo"
          >
            Enviar por WhatsApp (prueba)
          </button>
        </div>
      </form>
    </div>
  )
}