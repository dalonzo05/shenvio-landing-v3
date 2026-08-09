'use client'

import { useEffect, useMemo, useRef, useState } from 'react'
import {
  collection,
  doc,
  getDoc,
  onSnapshot,
  query,
  orderBy,
  where,
} from 'firebase/firestore'
import { httpsCallable } from 'firebase/functions'
import { auth, db, functions } from '@/fb/config'
import {
  registrarAbonoSaldo, anularSaldoCargo, revertirConversionEnDeuda, condonarDeudaMotorizado,
  crearPropuestaAbono, corregirPropuestaAbono,
} from '@/lib/financial-writes'
import {
  LABELS_TIPO_SALDO,
  type SaldoCargoMotorizado,
  type AbonoSaldo,
  type EstadoSaldo,
  type MetodoAbono,
  type PropuestaAbonoSaldo,
} from '@/lib/financial-types'
import { compressImage, uploadComprobante, uploadComprobantePropuesta } from '@/fb/storage'
import {
  AlertTriangle,
  CheckCircle2,
  ChevronDown,
  ChevronUp,
  Clock,
  Paperclip,
  Image as ImageIcon,
} from 'lucide-react'

// DIGITADOR V1 — doble control de abonos (D3). Los callables son las únicas
// vías para confirmar/rechazar una propuesta; ver functions/src/propuestas-abono.ts.
const confirmarPropuestaAbonoCallable = httpsCallable<
  { propuestaId: string },
  { ok: true; movimientoId: string }
>(functions, 'confirmarPropuestaAbono')
const rechazarPropuestaAbonoCallable = httpsCallable<
  { propuestaId: string; motivo?: string },
  { ok: true }
>(functions, 'rechazarPropuestaAbono')

// ─── Types ────────────────────────────────────────────────────────────────────

type Motorizado = { id: string; authUid: string; nombre?: string }
type Saldo = SaldoCargoMotorizado & { id: string }

// ─── Helpers ──────────────────────────────────────────────────────────────────

function fmt(n: number) {
  return `C$ ${n.toLocaleString('es-NI')}`
}

function tsToDate(v: any): Date | null {
  if (!v) return null
  if (typeof v?.toDate === 'function') return v.toDate()
  if (v instanceof Date) return v
  return null
}

function fmtDate(v: any): string {
  const d = tsToDate(v)
  if (!d) return '—'
  return d.toLocaleDateString('es-NI', { day: '2-digit', month: 'short', year: 'numeric' })
}

function fmtDateShort(v: any): string {
  const d = tsToDate(v)
  if (!d) return '—'
  return d.toLocaleDateString('es-NI', { day: '2-digit', month: 'short' })
}

const BADGE_ESTADO: Record<EstadoSaldo, string> = {
  pendiente: 'bg-red-100 text-red-700',
  abonado_parcial: 'bg-orange-100 text-orange-700',
  pagado: 'bg-green-100 text-green-700',
  anulado: 'bg-gray-100 text-gray-500',
  condonado: 'bg-purple-100 text-purple-700',
}

const LABEL_ESTADO: Record<EstadoSaldo, string> = {
  pendiente: 'Pendiente',
  abonado_parcial: 'Abonado parcial',
  pagado: 'Pagado',
  anulado: 'Anulado',
  condonado: 'Condonado',
}

const LABEL_ORIGEN_SALDO: Record<string, string> = {
  deposito: 'Depósito no realizado',
  liquidacion: 'Liquidación',
  manual: 'Ajuste manual',
}

// solo transferencia exige comprobante
const METODOS_REQUIEREN_COMPROBANTE: string[] = ['transferencia']
const METODOS_MUESTRAN_COMPROBANTE:  string[] = ['transferencia']

// ─── Main ─────────────────────────────────────────────────────────────────────

export default function SaldosPage() {
  const [motorizados, setMotorizados] = useState<Motorizado[]>([])
  const [saldos, setSaldos] = useState<Saldo[]>([])
  const [loading, setLoading] = useState(true)

  // Filtros
  const [filtroMoto, setFiltroMoto] = useState('todos')
  const [filtroEstado, setFiltroEstado] = useState<EstadoSaldo | 'todos'>('pendiente')
  const [expandedId, setExpandedId] = useState<string | null>(null)

  // Acción en curso (revertir / condonar)
  const [procesandoId, setProcesandoId] = useState<string | null>(null)

  // Abono
  const [abonoId, setAbonoId] = useState<string | null>(null)
  const [montoAbono, setMontoAbono] = useState('')
  const [metodoAbono, setMetodoAbono] = useState<MetodoAbono>('transferencia')
  const [notaAbono, setNotaAbono] = useState('')
  const [comprobanteFile, setComprobanteFile] = useState<File | null>(null)
  const [comprobantePreview, setComprobantePreview] = useState<string | null>(null)
  const [savingAbono, setSavingAbono] = useState(false)
  const [errAbono, setErrAbono] = useState<string | null>(null)
  const fileInputRef = useRef<HTMLInputElement>(null)

  // ── DIGITADOR V1 — doble control de abonos (D3) ───────────────────────────
  const [userRol, setUserRol] = useState<string | null>(null)
  const esDigitador = userRol === 'digitador'
  const [propuestas, setPropuestas] = useState<(PropuestaAbonoSaldo & { id: string })[]>([])
  // Reutiliza el mismo form (montoAbono/metodoAbono/notaAbono/comprobanteFile)
  // que el abono directo del gestor — abonoId hace de "propuesta en edición"
  // cuando esDigitador. propuestaCorrigiendoId != null → PATCH en vez de create.
  const [propuestaCorrigiendoId, setPropuestaCorrigiendoId] = useState<string | null>(null)
  const [confirmandoPropuestaId, setConfirmandoPropuestaId] = useState<string | null>(null)
  const [rechazandoPropuestaId, setRechazandoPropuestaId] = useState<string | null>(null)
  const [motivoRechazoPropuesta, setMotivoRechazoPropuesta] = useState<Record<string, string>>({})

  // ── Queries ────────────────────────────────────────────────────────────────

  useEffect(() => {
    const uid = auth.currentUser?.uid
    if (!uid) return
    getDoc(doc(db, 'usuarios', uid)).then((snap) => {
      setUserRol(snap.exists() ? ((snap.data() as { rol?: string })?.rol ?? null) : null)
    })
  }, [])

  useEffect(() => {
    const q = query(collection(db, 'motorizado'))
    return onSnapshot(q, (snap) => {
      setMotorizados(
        snap.docs
          .map((d) => ({ id: d.id, ...(d.data() as any) } as Motorizado))
          .sort((a, b) => (a.nombre || '').localeCompare(b.nombre || ''))
      )
    })
  }, [])

  useEffect(() => {
    const q = query(collection(db, 'saldos_cargo_motorizado'), orderBy('createdAt', 'desc'))
    return onSnapshot(q, (snap) => {
      setSaldos(snap.docs.map((d) => ({ id: d.id, ...(d.data() as any) } as Saldo)))
      setLoading(false)
    })
  }, [])

  // Propuestas de abono. Digitador: Rules solo le permiten leer las SUYAS —
  // el where() acá es lo que permite a Firestore probar esa condición para un
  // list() (mismo motivo que en depositos/page.tsx). Gestor/admin leen todas
  // sin filtro (Rules se lo permite sin condición).
  useEffect(() => {
    if (userRol === null) return
    const uid = auth.currentUser?.uid
    const q = userRol === 'digitador' && uid
      ? query(collection(db, 'propuestas_abono_saldo'), where('digitadoPorUid', '==', uid))
      : query(collection(db, 'propuestas_abono_saldo'))
    return onSnapshot(q, (snap) => {
      setPropuestas(snap.docs.map((d) => ({ id: d.id, ...(d.data() as PropuestaAbonoSaldo) })))
    })
  }, [userRol])

  // ── Filtros ────────────────────────────────────────────────────────────────

  const saldosFiltrados = useMemo(() => {
    return saldos.filter((s) => {
      if (filtroMoto !== 'todos' && s.motorizadoId !== filtroMoto) return false
      if (filtroEstado !== 'todos' && s.estado !== filtroEstado) return false
      return true
    })
  }, [saldos, filtroMoto, filtroEstado])

  const kpis = useMemo(() => {
    const activos = saldos.filter((s) => s.estado === 'pendiente' || s.estado === 'abonado_parcial')
    return {
      totalPendiente: activos.reduce((s, x) => s + x.saldoPendiente, 0),
      count: activos.length,
      pagados: saldos.filter((s) => s.estado === 'pagado').length,
    }
  }, [saldos])

  // ── Comprobante preview ────────────────────────────────────────────────────

  function handleComprobanteChange(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0] ?? null
    setComprobanteFile(file)
    if (file) {
      const url = URL.createObjectURL(file)
      setComprobantePreview(url)
    } else {
      setComprobantePreview(null)
    }
  }

  function resetAbono() {
    setAbonoId(null)
    setPropuestaCorrigiendoId(null)
    setMontoAbono('')
    setNotaAbono('')
    setMetodoAbono('transferencia')
    setComprobanteFile(null)
    setComprobantePreview(null)
    setErrAbono(null)
    if (fileInputRef.current) fileInputRef.current.value = ''
  }

  // ── Abonar ─────────────────────────────────────────────────────────────────

  async function handleAbono(saldo: Saldo) {
    setErrAbono(null)
    const monto = parseFloat(montoAbono)
    if (isNaN(monto) || monto <= 0) {
      setErrAbono('Ingresa un monto válido')
      return
    }
    if (monto > saldo.saldoPendiente) {
      setErrAbono(`El monto no puede superar el saldo pendiente (${fmt(saldo.saldoPendiente)})`)
      return
    }
    if (METODOS_REQUIEREN_COMPROBANTE.includes(metodoAbono) && !comprobanteFile) {
      setErrAbono('Este método requiere subir un comprobante')
      return
    }

    setSavingAbono(true)
    try {
      let comprobanteUrl: string | undefined
      let comprobantePath: string | undefined

      if (comprobanteFile) {
        const abonoIndex = (saldo.abonos?.length ?? 0)
        const blob = await compressImage(comprobanteFile)
        const { url, pathStorage } = await uploadComprobante(saldo.id, abonoIndex, blob)
        comprobanteUrl = url
        comprobantePath = pathStorage
      }

      await registrarAbonoSaldo({
        saldoId: saldo.id,
        montoAbono: monto,
        metodoAbono,
        nota: notaAbono,
        operadorId: auth.currentUser?.uid ?? '',
        motorizadoId: saldo.motorizadoId,
        motorizadoNombre: saldo.motorizadoNombre,
        comprobanteUrl,
        comprobantePath,
      })
      resetAbono()
    } catch (e: any) {
      console.error('Error registrando abono:', e)
      setErrAbono(e?.message || 'Error al registrar abono')
    } finally {
      setSavingAbono(false)
    }
  }

  // ── Proponer / corregir abono (DIGITADOR V1) ──────────────────────────────
  // Nunca toca saldos_cargo_motorizado — crea o corrige un documento en
  // propuestas_abono_saldo, 'pendiente'. Solo confirmarPropuestaAbono (Cloud
  // Function) aplica el efecto real. Mismas validaciones de monto que
  // handleAbono, replicadas porque el flujo de datos es distinto (create vs
  // corregir) y no comparten la escritura final.
  async function handleProponerAbono(saldo: Saldo) {
    setErrAbono(null)
    const monto = parseFloat(montoAbono)
    if (isNaN(monto) || monto <= 0) {
      setErrAbono('Ingresa un monto válido')
      return
    }
    if (monto > saldo.saldoPendiente) {
      setErrAbono(`El monto no puede superar el saldo pendiente (${fmt(saldo.saldoPendiente)})`)
      return
    }
    if (METODOS_REQUIEREN_COMPROBANTE.includes(metodoAbono) && !comprobanteFile && !propuestaCorrigiendoId) {
      setErrAbono('Este método requiere subir un comprobante')
      return
    }

    setSavingAbono(true)
    try {
      const uid = auth.currentUser?.uid ?? ''

      if (propuestaCorrigiendoId) {
        // Corrección de una propuesta propia mientras sigue pendiente (D2).
        let comprobanteUrl: string | undefined
        let comprobantePath: string | undefined
        if (comprobanteFile) {
          const blob = await compressImage(comprobanteFile)
          const r = await uploadComprobantePropuesta(saldo.id, propuestaCorrigiendoId, blob)
          comprobanteUrl = r.url
          comprobantePath = r.pathStorage
        }
        await corregirPropuestaAbono(propuestaCorrigiendoId, {
          monto,
          metodoAbono,
          nota: notaAbono,
          ...(comprobanteUrl ? { comprobanteUrl, comprobantePath } : {}),
        })
      } else {
        // Propuesta nueva: el ID lo genera el cliente para poder subir el
        // comprobante ANTES de crear el documento — mismo patrón que
        // ordenes_deposito/pagos_comercio en el resto del proyecto.
        const propuestaRef = doc(collection(db, 'propuestas_abono_saldo'))
        const propuestaId = propuestaRef.id
        let comprobanteUrl: string | undefined
        let comprobantePath: string | undefined
        if (comprobanteFile) {
          const blob = await compressImage(comprobanteFile)
          const r = await uploadComprobantePropuesta(saldo.id, propuestaId, blob)
          comprobanteUrl = r.url
          comprobantePath = r.pathStorage
        }
        await crearPropuestaAbono({
          saldoId: saldo.id,
          motorizadoId: saldo.motorizadoId,
          motorizadoUid: saldo.motorizadoUid,
          motorizadoNombre: saldo.motorizadoNombre,
          monto,
          metodoAbono,
          nota: notaAbono,
          operadorId: uid,
          comprobanteUrl,
          comprobantePath,
        })
      }
      resetAbono()
      setPropuestaCorrigiendoId(null)
    } catch (e: unknown) {
      console.error('Error registrando propuesta de abono:', e)
      setErrAbono(e instanceof Error ? e.message : 'Error al registrar la propuesta')
    } finally {
      setSavingAbono(false)
    }
  }

  function iniciarCorreccionPropuesta(p: PropuestaAbonoSaldo & { id: string }) {
    setAbonoId(p.saldoId)
    setPropuestaCorrigiendoId(p.id)
    setMontoAbono(String(p.monto))
    setMetodoAbono(p.metodoAbono)
    setNotaAbono(p.nota ?? '')
    setComprobanteFile(null)
    setComprobantePreview(p.comprobanteUrl ?? null)
    setExpandedId(p.saldoId)
  }

  // ── Confirmar / rechazar propuesta (Gestor/Admin — Cloud Functions) ──────
  async function handleConfirmarPropuesta(p: PropuestaAbonoSaldo & { id: string }) {
    setConfirmandoPropuestaId(p.id)
    try {
      await confirmarPropuestaAbonoCallable({ propuestaId: p.id })
    } catch (e: unknown) {
      console.error('Error confirmando propuesta:', e)
      alert('Error al confirmar: ' + (e instanceof Error ? e.message : 'Error desconocido'))
    } finally {
      setConfirmandoPropuestaId(null)
    }
  }

  async function handleRechazarPropuesta(p: PropuestaAbonoSaldo & { id: string }) {
    const motivo = motivoRechazoPropuesta[p.id]?.trim()
    setRechazandoPropuestaId(p.id)
    try {
      await rechazarPropuestaAbonoCallable({ propuestaId: p.id, ...(motivo ? { motivo } : {}) })
      setMotivoRechazoPropuesta((prev) => ({ ...prev, [p.id]: '' }))
    } catch (e: unknown) {
      console.error('Error rechazando propuesta:', e)
      alert('Error al rechazar: ' + (e instanceof Error ? e.message : 'Error desconocido'))
    } finally {
      setRechazandoPropuestaId(null)
    }
  }

  async function handleRevertir(saldo: Saldo) {
    if (!saldo.depositoId) return
    const ok = window.confirm(
      `¿Revertir conversión en deuda?\n\nMotorizado: ${saldo.motorizadoNombre}\nMonto: ${fmt(saldo.saldoPendiente)}\n\n` +
      `Esto hará lo siguiente:\n` +
      `• El saldo a cargo quedará anulado.\n` +
      `• El depósito volverá a estado "En revisión".\n` +
      `• Las solicitudes asociadas volverán a aparecer como pendientes de depósito.\n` +
      `• Auditoría mostrará nuevamente el monto como pendiente.\n\n` +
      `Usar solo si la conversión fue un error. Esta acción no se puede deshacer.`
    )
    if (!ok) return
    setProcesandoId(saldo.id)
    try {
      await revertirConversionEnDeuda({
        saldoId: saldo.id,
        depositoId: saldo.depositoId,
        operadorId: auth.currentUser?.uid ?? '',
      })
    } catch (e: any) {
      console.error('Error revirtiendo conversión:', e)
      alert('Error al revertir: ' + (e?.message ?? 'Error desconocido'))
    } finally {
      setProcesandoId(null)
    }
  }

  async function handleCondonar(saldo: Saldo) {
    if (!saldo.depositoId) return
    const motivo = window.prompt(
      `Condonar deuda — ${saldo.motorizadoNombre} (${fmt(saldo.saldoPendiente)})\n\n` +
      `El monto NO se recuperará. Las solicitudes quedan cerradas.\n` +
      `El depósito queda como registro histórico.\n\n` +
      `Ingresa el motivo de la condonación (obligatorio):`
    )
    if (motivo === null) return // canceló
    if (!motivo.trim()) { alert('Debes ingresar un motivo para condonar.'); return }
    setProcesandoId(saldo.id)
    try {
      await condonarDeudaMotorizado({
        saldoId: saldo.id,
        depositoId: saldo.depositoId,
        monto: saldo.saldoPendiente,
        motorizadoId: saldo.motorizadoId,
        motorizadoNombre: saldo.motorizadoNombre,
        operadorId: auth.currentUser?.uid ?? '',
        nota: motivo.trim(),
      })
    } catch (e: any) {
      console.error('Error condonando deuda:', e)
      alert('Error al condonar: ' + (e?.message ?? 'Error desconocido'))
    } finally {
      setProcesandoId(null)
    }
  }

  async function handleAnular(saldo: Saldo) {
    const ok = window.confirm(
      `¿Anular este saldo?\n\nMotorizado: ${saldo.motorizadoNombre}\nMonto: ${fmt(saldo.saldoPendiente)}\nTipo: ${LABELS_TIPO_SALDO[saldo.tipo]}\n\nEsta acción no se puede deshacer.`
    )
    if (!ok) return
    await anularSaldoCargo(saldo.id, auth.currentUser?.uid ?? '')
  }

  // ── Render ─────────────────────────────────────────────────────────────────

  return (
    <div className="flex flex-col gap-4 max-w-4xl mx-auto">
      {/* Header */}
      <div>
        <h1 className="text-2xl font-black text-gray-900 tracking-tight flex items-center gap-2">
          <AlertTriangle className="h-6 w-6 text-red-500" />
          Saldos a cargo
        </h1>
        <p className="text-sm text-gray-500 mt-0.5">
          Deudas de motorizados — depósitos no realizados, adelantos, ajustes.
        </p>
      </div>

      {/* KPIs */}
      <div className="grid grid-cols-3 gap-3">
        <div className="border rounded-xl px-4 py-3 bg-red-50 border-red-200">
          <p className="text-2xl font-black text-red-700">{fmt(kpis.totalPendiente)}</p>
          <p className="text-xs font-semibold mt-0.5 text-red-400">Total pendiente</p>
        </div>
        <div className="border rounded-xl px-4 py-3 bg-orange-50 border-orange-200">
          <p className="text-2xl font-black text-orange-700">{kpis.count}</p>
          <p className="text-xs font-semibold mt-0.5 text-orange-400">Saldos activos</p>
        </div>
        <div className="border rounded-xl px-4 py-3 bg-green-50 border-green-200">
          <p className="text-2xl font-black text-green-700">{kpis.pagados}</p>
          <p className="text-xs font-semibold mt-0.5 text-green-400">Pagados</p>
        </div>
      </div>

      {/* Filtros */}
      <div className="flex flex-wrap gap-2 items-center">
        <select
          value={filtroMoto}
          onChange={(e) => setFiltroMoto(e.target.value)}
          className="border border-gray-200 rounded-lg px-2 py-1.5 text-xs focus:outline-none focus:ring-2 focus:ring-[#004aad]/30"
        >
          <option value="todos">Todos los motorizados</option>
          {motorizados.map((m) => (
            <option key={m.id} value={m.id}>{m.nombre || m.authUid}</option>
          ))}
        </select>

        {(['todos', 'pendiente', 'abonado_parcial', 'pagado', 'anulado', 'condonado'] as const).map((e) => (
          <button
            key={e}
            onClick={() => setFiltroEstado(e)}
            className={`px-3 py-1 rounded-full text-xs font-semibold border transition ${
              filtroEstado === e
                ? 'bg-gray-900 text-white border-gray-900'
                : 'bg-white text-gray-600 border-gray-200 hover:bg-gray-50'
            }`}
          >
            {e === 'todos' ? 'Todos' : LABEL_ESTADO[e]}
          </button>
        ))}

        <span className="ml-auto text-xs text-gray-400">{saldosFiltrados.length} saldos</span>
      </div>

      {/* Lista */}
      <div className="flex flex-col gap-3">
        {loading ? (
          <div className="bg-white rounded-xl border py-12 text-center text-sm text-gray-400">Cargando…</div>
        ) : saldosFiltrados.length === 0 ? (
          <div className="bg-white rounded-xl border flex flex-col items-center justify-center py-12 gap-2 text-gray-400">
            <CheckCircle2 className="h-10 w-10 opacity-20" />
            <p className="text-sm font-semibold">Sin saldos en esta vista</p>
          </div>
        ) : (
          saldosFiltrados.map((s) => {
            const isExp = expandedId === s.id
            const isAbono = abonoId === s.id
            const puedeAbono = s.estado === 'pendiente' || s.estado === 'abonado_parcial'
            // totalAbonado se deriva SIEMPRE de abonos[] (dinero realmente
            // abonado) — nunca de montoOriginal-saldoPendiente, que deja de
            // ser fiable en cuanto el saldo se condona (ver montoCondonado).
            const totalAbonado = (s.abonos ?? []).reduce((sum, a) => sum + (a.monto || 0), 0)
            const montoCondonadoMostrado = s.estado === 'condonado' ? (s.montoCondonado ?? 0) : 0
            const totalResuelto = totalAbonado + montoCondonadoMostrado
            // Compatibilidad legacy: si el documento quedó con saldoPendiente
            // > 0 pese a estar condonado (condonaciones anteriores a esta
            // corrección), se muestra en 0 sin reescribir el documento.
            const pendienteMostrado = s.estado === 'condonado' ? 0 : s.saldoPendiente
            const pctDescontado = s.montoOriginal > 0
              ? Math.min(100, Math.round((totalResuelto / s.montoOriginal) * 100))
              : 0

            return (
              <div key={s.id} className="bg-white rounded-xl border border-gray-200 overflow-hidden shadow-sm">

                {/* ── Card header ── */}
                <div className="px-4 pt-4 pb-3">
                  {/* Fila nombre + badges + expand */}
                  <div className="flex items-start gap-2">
                    <div className="flex-1 min-w-0">
                      <div className="flex items-center gap-2 flex-wrap">
                        <p className="text-sm font-bold text-gray-900">{s.motorizadoNombre}</p>
                        <span className={`text-[11px] font-semibold px-2 py-0.5 rounded-full ${BADGE_ESTADO[s.estado]}`}>
                          {LABEL_ESTADO[s.estado]}
                        </span>
                        <span className="text-[11px] text-gray-400 border border-gray-200 px-1.5 py-0.5 rounded bg-gray-50">
                          {LABELS_TIPO_SALDO[s.tipo]}
                        </span>
                        {s.origen && (
                          <span className="text-[11px] text-gray-400">
                            · {LABEL_ORIGEN_SALDO[s.origen] ?? s.origen}
                          </span>
                        )}
                      </div>
                      <p className="text-xs text-gray-400 mt-0.5">
                        {fmtDate(s.fecha || s.createdAt)}
                        {s.nota ? ` · ${s.nota}` : ''}
                      </p>
                    </div>
                    <button
                      onClick={() => setExpandedId(isExp ? null : s.id)}
                      className="text-gray-400 hover:text-gray-600 p-1 shrink-0"
                    >
                      {isExp ? <ChevronUp className="h-4 w-4" /> : <ChevronDown className="h-4 w-4" />}
                    </button>
                  </div>

                  {/* ── Desglose numérico ── */}
                  <div className="mt-3 grid grid-cols-3 gap-2 text-center">
                    <div className="bg-gray-50 rounded-lg px-2 py-2 border border-gray-100">
                      <p className="text-[10px] font-semibold text-gray-400 uppercase tracking-wide">Original</p>
                      <p className="text-sm font-black text-gray-700 mt-0.5">{fmt(s.montoOriginal)}</p>
                    </div>
                    <div className="bg-green-50 rounded-lg px-2 py-2 border border-green-100">
                      <p className="text-[10px] font-semibold text-green-500 uppercase tracking-wide">Abonado</p>
                      <p className="text-sm font-black text-green-700 mt-0.5">{fmt(totalAbonado)}</p>
                    </div>
                    <div className={`rounded-lg px-2 py-2 border ${
                      s.estado === 'pagado' || s.estado === 'condonado'
                        ? 'bg-green-50 border-green-100'
                        : 'bg-red-50 border-red-100'
                    }`}>
                      <p className={`text-[10px] font-semibold uppercase tracking-wide ${
                        s.estado === 'pagado' || s.estado === 'condonado' ? 'text-green-500' : 'text-red-400'
                      }`}>Pendiente</p>
                      <p className={`text-sm font-black mt-0.5 ${
                        s.estado === 'pagado' || s.estado === 'condonado' ? 'text-green-700' : 'text-red-700'
                      }`}>{fmt(pendienteMostrado)}</p>
                    </div>
                  </div>

                  {/* Monto condonado — solo visible si el saldo fue condonado.
                     No se afirma que fue "abonado": queda como su propia línea. */}
                  {montoCondonadoMostrado > 0 && (
                    <div className="mt-2 bg-amber-50 border border-amber-100 rounded-lg px-2 py-1.5 text-center">
                      <p className="text-[10px] font-semibold text-amber-600 uppercase tracking-wide">Condonado</p>
                      <p className="text-sm font-black text-amber-700 mt-0.5">{fmt(montoCondonadoMostrado)}</p>
                    </div>
                  )}

                  {/* ── Barra de progreso ── */}
                  {s.montoOriginal > 0 && (
                    <div className="mt-2.5">
                      <div className="h-2 bg-gray-100 rounded-full overflow-hidden">
                        <div
                          className="h-full bg-green-500 rounded-full transition-all"
                          style={{ width: `${Math.min(100, pctDescontado)}%` }}
                        />
                      </div>
                      <p className="text-[10px] text-gray-400 mt-0.5 text-right">
                        {pctDescontado}% resuelto
                      </p>
                    </div>
                  )}
                </div>

                {/* ── Timeline expandida ── */}
                {isExp && (
                  <div className="border-t border-gray-100 px-4 py-4 bg-gray-50">
                    <p className="text-xs font-bold text-gray-500 uppercase tracking-wide mb-3">
                      Historial de movimientos
                    </p>

                    <div className="relative pl-5">
                      {/* Línea vertical */}
                      <div className="absolute left-[7px] top-2 bottom-2 w-px bg-gray-200" />

                      {/* Evento: creación */}
                      <TimelineEvent
                        dot="●"
                        dotColor="text-blue-500"
                        fecha={fmtDateShort(s.fecha || s.createdAt)}
                        titulo="Saldo creado"
                        detalle={`${LABELS_TIPO_SALDO[s.tipo]} · ${fmt(s.montoOriginal)}${s.nota ? ` · "${s.nota}"` : ''}`}
                      />

                      {/* Eventos: abonos */}
                      {(s.abonos ?? []).map((a: AbonoSaldo, i: number) => (
                        <TimelineEvent
                          key={i}
                          dot="●"
                          dotColor="text-green-500"
                          fecha={fmtDateShort(a.fecha)}
                          titulo={`Abono ${fmt(a.monto)}`}
                          detalle={[
                            a.metodoAbono ?? 'transferencia',
                            a.nota || null,
                          ].filter(Boolean).join(' · ')}
                          comprobante={a.comprobanteUrl}
                        />
                      ))}

                      {/* Pendiente */}
                      {(s.estado === 'pendiente' || s.estado === 'abonado_parcial') && (
                        <TimelineEvent
                          dot="○"
                          dotColor="text-red-400"
                          fecha="Hoy"
                          titulo={`Pendiente ${fmt(s.saldoPendiente)}`}
                          detalle="Sin saldar"
                          pending
                        />
                      )}
                      {s.estado === 'pagado' && (
                        <TimelineEvent
                          dot="✓"
                          dotColor="text-green-600"
                          fecha={fmtDateShort(s.updatedAt)}
                          titulo="Saldo completamente saldado"
                          detalle=""
                        />
                      )}
                      {s.estado === 'condonado' && (
                        <TimelineEvent
                          dot="✓"
                          dotColor="text-amber-600"
                          fecha={fmtDateShort(s.condonadoAt)}
                          titulo={`Condonado ${fmt(montoCondonadoMostrado)}`}
                          detalle={s.motivoCondonacion || 'Sin nota'}
                        />
                      )}
                      {s.estado === 'anulado' && (
                        <TimelineEvent
                          dot="✕"
                          dotColor="text-gray-400"
                          fecha={fmtDateShort(s.updatedAt)}
                          titulo="Saldo anulado"
                          detalle=""
                        />
                      )}
                    </div>
                  </div>
                )}

                {/* ── Formulario de abono ── */}
                {puedeAbono && (
                  <div className="border-t border-gray-100 px-4 py-3">
                    {isAbono ? (
                      <div className="flex flex-col gap-3">
                        {/* Fila: monto + método */}
                        <div className="flex gap-2">
                          <input
                            type="number"
                            min="0.01"
                            max={s.saldoPendiente}
                            step="0.01"
                            value={montoAbono}
                            onChange={(e) => setMontoAbono(e.target.value)}
                            placeholder={`Monto (máx ${fmt(s.saldoPendiente)})`}
                            className="flex-1 border border-gray-200 rounded-lg px-2 py-1.5 text-xs focus:outline-none focus:ring-1 focus:ring-blue-300"
                            autoFocus
                          />
                          <select
                            value={metodoAbono}
                            onChange={(e) => { setMetodoAbono(e.target.value as MetodoAbono); setComprobanteFile(null); setComprobantePreview(null) }}
                            className="border border-gray-200 rounded-lg px-2 py-1.5 text-xs focus:outline-none"
                          >
                            <option value="transferencia">Transferencia</option>
                            <option value="descuento_liquidacion">Desc. liquidación</option>
                            <option value="ajuste_manual">Ajuste manual</option>
                          </select>
                        </div>

                        {/* Nota */}
                        <input
                          type="text"
                          value={notaAbono}
                          onChange={(e) => setNotaAbono(e.target.value)}
                          placeholder="Nota (opcional)"
                          className="border border-gray-200 rounded-lg px-2 py-1.5 text-xs focus:outline-none focus:ring-1 focus:ring-blue-300"
                        />

                        {/* Comprobante: solo visible para transferencia */}
                        {METODOS_MUESTRAN_COMPROBANTE.includes(metodoAbono) && (
                        <div className="flex flex-col gap-1.5">
                          <label className="flex items-center gap-2 cursor-pointer">
                            <div className={`flex items-center gap-1.5 px-3 py-1.5 rounded-lg border text-xs font-semibold transition ${
                              comprobanteFile
                                ? 'bg-blue-50 border-blue-300 text-blue-700'
                                : METODOS_REQUIEREN_COMPROBANTE.includes(metodoAbono)
                                ? 'bg-orange-50 border-orange-300 text-orange-700'
                                : 'bg-gray-50 border-gray-200 text-gray-500'
                            }`}>
                              <Paperclip className="h-3 w-3" />
                              {comprobanteFile
                                ? comprobanteFile.name
                                : METODOS_REQUIEREN_COMPROBANTE.includes(metodoAbono)
                                ? 'Subir comprobante (obligatorio)'
                                : 'Subir comprobante (opcional)'}
                            </div>
                            <input
                              ref={fileInputRef}
                              type="file"
                              accept="image/*"
                              className="hidden"
                              onChange={handleComprobanteChange}
                            />
                          </label>
                          {comprobantePreview && (
                            <div className="relative w-20 h-20">
                              <img
                                src={comprobantePreview}
                                alt="preview"
                                className="w-20 h-20 object-cover rounded-lg border border-gray-200"
                              />
                              <button
                                onClick={() => { setComprobanteFile(null); setComprobantePreview(null); if (fileInputRef.current) fileInputRef.current.value = '' }}
                                className="absolute -top-1 -right-1 bg-white border border-gray-200 rounded-full w-4 h-4 text-[9px] flex items-center justify-center text-gray-500 hover:text-red-500"
                              >
                                ✕
                              </button>
                            </div>
                          )}
                        </div>
                        )}

                        {errAbono && (
                          <p className="text-xs text-red-600 font-semibold">{errAbono}</p>
                        )}

                        <div className="flex gap-2">
                          <button
                            onClick={resetAbono}
                            className="flex-1 text-xs font-semibold px-3 py-2 rounded-lg border border-gray-200 text-gray-600 hover:bg-gray-50 transition"
                          >
                            Cancelar
                          </button>
                          <button
                            onClick={() => esDigitador ? handleProponerAbono(s) : handleAbono(s)}
                            disabled={savingAbono || !montoAbono}
                            className="flex-1 text-xs font-semibold px-3 py-2 rounded-lg bg-green-600 text-white hover:bg-green-700 transition disabled:opacity-40"
                          >
                            {savingAbono ? 'Guardando…' : propuestaCorrigiendoId ? '✓ Guardar corrección' : esDigitador ? '✓ Proponer abono' : '✓ Registrar abono'}
                          </button>
                        </div>
                      </div>
                    ) : esDigitador ? (
                      // Digitador (D3): solo propone. Nunca revertir/condonar/anular
                      // — eso sigue siendo exclusivo de Gestor/Admin más abajo.
                      <button
                        onClick={() => { setAbonoId(s.id); setExpandedId(s.id) }}
                        className="w-full text-xs font-semibold px-3 py-2 rounded-lg bg-green-600 text-white hover:bg-green-700 transition"
                      >
                        + Proponer abono
                      </button>
                    ) : (
                      <div className="flex gap-2">
                        <button
                          onClick={() => { setAbonoId(s.id); setExpandedId(s.id) }}
                          className="flex-1 text-xs font-semibold px-3 py-2 rounded-lg bg-green-600 text-white hover:bg-green-700 transition"
                        >
                          + Registrar abono
                        </button>
                        {s.tipo === 'deposito_no_realizado' && s.depositoId ? (
                          <>
                            <button
                              onClick={() => handleRevertir(s)}
                              disabled={procesandoId === s.id}
                              title="El depósito vuelve a revisión y las solicitudes quedan pendientes"
                              className="text-xs font-semibold px-3 py-2 rounded-lg border border-amber-300 text-amber-700 hover:bg-amber-50 transition disabled:opacity-40"
                            >
                              Revertir
                            </button>
                            <button
                              onClick={() => handleCondonar(s)}
                              disabled={procesandoId === s.id}
                              title="StorkHub absorbe la pérdida. Las solicitudes no vuelven a pendiente."
                              className="text-xs font-semibold px-3 py-2 rounded-lg border border-gray-200 text-gray-500 hover:bg-gray-50 transition disabled:opacity-40"
                            >
                              Condonar
                            </button>
                          </>
                        ) : (
                          <button
                            onClick={() => handleAnular(s)}
                            className="text-xs font-semibold px-3 py-2 rounded-lg border border-gray-200 text-gray-500 hover:bg-gray-50 transition"
                          >
                            Anular
                          </button>
                        )}
                      </div>
                    )}
                  </div>
                )}

                {/* ── Propuestas de abono (DIGITADOR V1, D3) ── */}
                {(() => {
                  const propuestasDelSaldo = propuestas.filter((p) => p.saldoId === s.id)
                  if (propuestasDelSaldo.length === 0) return null
                  return (
                    <div className="border-t border-gray-100 px-4 py-3 flex flex-col gap-2 bg-amber-50/40">
                      <p className="text-[11px] font-bold text-amber-700 uppercase tracking-wide">
                        Propuestas de abono
                      </p>
                      {propuestasDelSaldo.map((p) => (
                        <div key={p.id} className="rounded-lg border border-amber-200 bg-white px-3 py-2 flex flex-col gap-1.5">
                          <div className="flex items-center justify-between gap-2 flex-wrap">
                            <span className="text-xs font-semibold text-gray-800">{fmt(p.monto)} · {p.metodoAbono}</span>
                            <span className={`text-[10px] font-semibold px-2 py-0.5 rounded-full ${
                              p.estado === 'pendiente' ? 'bg-amber-100 text-amber-700'
                              : p.estado === 'confirmado' ? 'bg-green-100 text-green-700'
                              : 'bg-red-100 text-red-700'
                            }`}>
                              {p.estado === 'pendiente' ? 'Pendiente de revisión' : p.estado === 'confirmado' ? 'Confirmado' : 'Rechazado'}
                            </span>
                          </div>
                          {p.nota && <p className="text-[11px] text-gray-500">{p.nota}</p>}
                          {p.comprobanteUrl && (
                            <a href={p.comprobanteUrl} target="_blank" rel="noopener noreferrer" className="text-[11px] text-blue-600 hover:underline font-semibold">
                              Ver comprobante
                            </a>
                          )}
                          <p className="text-[10px] text-gray-400">
                            Digitado por <span className="font-mono">{p.digitadoPorUid.slice(0, 8)}</span>
                            {p.estado === 'rechazado' && p.motivoRechazo ? ` · Motivo: ${p.motivoRechazo}` : ''}
                          </p>

                          {/* Digitador: corregir mientras sigue pendiente (D2) */}
                          {esDigitador && p.estado === 'pendiente' && abonoId !== s.id && (
                            <button
                              onClick={() => iniciarCorreccionPropuesta(p)}
                              className="self-start text-[11px] font-semibold text-blue-600 hover:text-blue-800 hover:underline"
                            >
                              Corregir
                            </button>
                          )}

                          {/* Gestor/Admin: confirmar/rechazar (Cloud Functions) */}
                          {!esDigitador && p.estado === 'pendiente' && (
                            <div className="flex flex-col gap-1.5 mt-1">
                              <div className="flex gap-2">
                                <button
                                  onClick={() => handleConfirmarPropuesta(p)}
                                  disabled={confirmandoPropuestaId === p.id || rechazandoPropuestaId === p.id}
                                  className="flex-1 text-[11px] font-semibold px-2 py-1.5 rounded-lg bg-green-600 text-white hover:bg-green-700 transition disabled:opacity-40"
                                >
                                  {confirmandoPropuestaId === p.id ? 'Confirmando…' : '✓ Confirmar'}
                                </button>
                                <input
                                  value={motivoRechazoPropuesta[p.id] ?? ''}
                                  onChange={(e) => setMotivoRechazoPropuesta((prev) => ({ ...prev, [p.id]: e.target.value }))}
                                  placeholder="Motivo de rechazo (opcional)"
                                  className="flex-1 border border-gray-200 rounded-lg px-2 py-1 text-[11px] focus:outline-none focus:ring-1 focus:ring-red-300"
                                />
                                <button
                                  onClick={() => handleRechazarPropuesta(p)}
                                  disabled={confirmandoPropuestaId === p.id || rechazandoPropuestaId === p.id}
                                  className="text-[11px] font-semibold px-2 py-1.5 rounded-lg border border-red-200 text-red-600 hover:bg-red-50 transition disabled:opacity-40"
                                >
                                  {rechazandoPropuestaId === p.id ? '…' : 'Rechazar'}
                                </button>
                              </div>
                            </div>
                          )}
                        </div>
                      ))}
                    </div>
                  )
                })()}
              </div>
            )
          })
        )}
      </div>
    </div>
  )
}

// ─── Timeline event sub-component ────────────────────────────────────────────

function TimelineEvent({
  dot,
  dotColor,
  fecha,
  titulo,
  detalle,
  comprobante,
  pending,
}: {
  dot: string
  dotColor: string
  fecha: string
  titulo: string
  detalle: string
  comprobante?: string
  pending?: boolean
}) {
  const [showImg, setShowImg] = useState(false)

  return (
    <div className={`relative mb-3 ${pending ? 'opacity-60' : ''}`}>
      {/* Dot */}
      <span className={`absolute -left-5 text-xs leading-none mt-0.5 ${dotColor}`}>{dot}</span>

      <div className="flex items-start gap-2">
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2 flex-wrap">
            <span className="text-[11px] font-semibold text-gray-700">{titulo}</span>
            <span className="text-[10px] text-gray-400">{fecha}</span>
          </div>
          {detalle && (
            <p className="text-[11px] text-gray-500 mt-0.5">{detalle}</p>
          )}
          {comprobante && (
            <button
              onClick={() => setShowImg((v) => !v)}
              className="mt-1 flex items-center gap-1 text-[11px] text-blue-600 hover:text-blue-800 font-semibold"
            >
              <ImageIcon className="h-3 w-3" />
              {showImg ? 'Ocultar comprobante' : 'Ver comprobante'}
            </button>
          )}
          {comprobante && showImg && (
            <a href={comprobante} target="_blank" rel="noopener noreferrer" className="block mt-1.5">
              <img
                src={comprobante}
                alt="comprobante"
                className="max-w-[200px] rounded-lg border border-gray-200 shadow-sm hover:opacity-90 transition"
              />
            </a>
          )}
        </div>
      </div>
    </div>
  )
}
