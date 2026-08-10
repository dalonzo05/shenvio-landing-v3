'use client'

// Botón "Compartir seguimiento con cliente" dentro de la vista temporal
// comercio (sección 8/18). Sin Firebase Auth — el token de la URL (recibido
// por prop, nunca leído de otro lado) es la única credencial que manda el
// endpoint POST/DELETE /api/access/[token]/recipient. No expone opciones
// avanzadas (expiración, scopes) — sección 17.

import { useState } from 'react'

async function copiar(texto: string) {
  try {
    await navigator.clipboard.writeText(texto)
  } catch {
    const ta = document.createElement('textarea')
    ta.value = texto
    document.body.appendChild(ta)
    ta.select()
    document.execCommand('copy')
    document.body.removeChild(ta)
  }
}

export function CompartirConClienteButton({ token }: { token: string }) {
  const [estado, setEstado] = useState<'idle' | 'loading' | 'listo' | 'error'>('idle')
  const [copiado, setCopiado] = useState(false)

  async function generar() {
    setEstado('loading')
    try {
      const res = await fetch(`/api/access/${token}/recipient`, { method: 'POST' })
      const data = await res.json()
      if (!res.ok || !data?.url) throw new Error(data?.error || 'No se pudo generar el enlace.')
      await copiar(data.url)
      setCopiado(true)
      setEstado('listo')
      setTimeout(() => setCopiado(false), 2000)
    } catch {
      setEstado('error')
    }
  }

  if (estado === 'listo') {
    return (
      <button
        onClick={generar}
        className="text-xs font-semibold text-green-700 bg-green-50 border border-green-200 rounded-full px-3 py-1.5 hover:bg-green-100 transition"
      >
        {copiado ? '✓ Copiado' : 'Generar de nuevo'}
      </button>
    )
  }

  return (
    <button
      onClick={generar}
      disabled={estado === 'loading'}
      className="text-xs font-semibold text-[#004aad] bg-blue-50 border border-blue-200 rounded-full px-3 py-1.5 hover:bg-blue-100 transition disabled:opacity-50"
    >
      {estado === 'loading' ? 'Generando…' : estado === 'error' ? 'Reintentar' : 'Compartir seguimiento con cliente'}
    </button>
  )
}
