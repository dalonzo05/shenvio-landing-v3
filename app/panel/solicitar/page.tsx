'use client'

import { useState } from 'react'

const WHATSAPP = '50588888888' // <-- tu número aquí

export default function SolicitarEnvioPage() {
  const [origen, setOrigen] = useState('')
  const [destino, setDestino] = useState('')
  const [detalle, setDetalle] = useState('')
  const [pago, setPago] = useState<'efectivo' | 'contra-entrega' | 'transferencia' | ''>('')

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault()
    const texto = `Hola, quiero solicitar un envío:
- Origen: ${origen}
- Destino: ${destino}
- Método de pago: ${pago || '—'}
- Detalle: ${detalle || '—'}`

    const url = `https://wa.me/${WHATSAPP}?text=${encodeURIComponent(texto)}`
    window.open(url, '_blank')
  }

  return (
    <div className="max-w-2xl">
      <h1 className="text-2xl font-bold mb-4">Solicitar envío</h1>
      <form onSubmit={handleSubmit} className="bg-white rounded-2xl border shadow-sm p-6 space-y-4">
        <div>
          <label className="block text-sm font-medium mb-1">Punto de retiro (origen)</label>
          <input
            value={origen}
            onChange={(e) => setOrigen(e.target.value)}
            placeholder="Ej: Tienda X, Bolonia, Managua"
            className="w-full border rounded-lg px-3 py-2 outline-none focus:ring-2 focus:ring-[#004aad]"
            required
          />
        </div>
        <div>
          <label className="block text-sm font-medium mb-1">Punto de entrega (destino)</label>
          <input
            value={destino}
            onChange={(e) => setDestino(e.target.value)}
            placeholder="Ej: Cliente Y, Carretera a Masaya, km..."
            className="w-full border rounded-lg px-3 py-2 outline-none focus:ring-2 focus:ring-[#004aad]"
            required
          />
        </div>
        <div>
          <label className="block text-sm font-medium mb-1">Método de pago</label>
          <select
            value={pago}
            onChange={(e) => setPago(e.target.value as any)}
            className="w-full border rounded-lg px-3 py-2 outline-none focus:ring-2 focus:ring-[#004aad]"
            required
          >
            <option value="" disabled>Seleccioná…</option>
            <option value="efectivo">Efectivo</option>
            <option value="contra-entrega">Contra entrega</option>
            <option value="transferencia">Transferencia</option>
          </select>
        </div>
        <div>
          <label className="block text-sm font-medium mb-1">Detalle del paquete (opcional)</label>
          <textarea
            value={detalle}
            onChange={(e) => setDetalle(e.target.value)}
            placeholder="Ej: Caja pequeña, frágil. Entregar entre 2-4pm."
            className="w-full border rounded-lg px-3 py-2 outline-none focus:ring-2 focus:ring-[#004aad]"
            rows={4}
          />
        </div>

        <div className="pt-2">
          <button
            type="submit"
            className="rounded-full bg-[#004aad] text-white font-semibold px-5 py-2 hover:bg-[#003a92] transition"
          >
            Enviar por WhatsApp
          </button>
        </div>
      </form>

      <p className="text-sm text-gray-500 mt-3">
        Tip: podés primero usar la <a href="/panel/calculadora" className="underline">Calculadora</a> para cotizar el precio estimado.
      </p>
    </div>
  )
}
