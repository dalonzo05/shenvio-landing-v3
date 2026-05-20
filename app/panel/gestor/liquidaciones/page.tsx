'use client'

import { useEffect, useMemo, useState } from 'react'
import {
  collection,
  onSnapshot,
  query,
  where,
  doc,
  addDoc,
  updateDoc,
  serverTimestamp,
  Timestamp,
  orderBy,
  limit,
  getDocs,
} from 'firebase/firestore'
import { auth, db } from '@/fb/config'
import { uploadLiquidacionPDF } from '@/fb/storage'
import { registrarMovimiento, registrarAbonoSaldo, crearSaldoCargo } from '@/lib/financial-writes'
import {
  Receipt,
  ChevronDown,
  ChevronUp,
  CheckCircle2,
  AlertTriangle,
  PlusCircle,
  CreditCard,
  FileDown,
} from 'lucide-react'
import type { SaldoCargoMotorizado } from '@/lib/financial-types'
import { LABELS_TIPO_SALDO } from '@/lib/financial-types'

// ─── Types ────────────────────────────────────────────────────────────────────

type Motorizado = {
  id: string
  authUid: string
  nombre?: string
  estado?: string
}

type Solicitud = {
  id: string
  estado?: string
  entregadoAt?: Timestamp
  asignacion?: {
    motorizadoId?: string
    motorizadoAuthUid?: string
    motorizadoNombre?: string
  } | null
  confirmacion?: { precioFinalCordobas?: number }
  precioDesglose?: {
    deliveryBase?: number
    recargoZona?: number
    recargoServicio?: number
    totalCobrado?: number
  } | null
  cobrosMotorizado?: {
    delivery?: { recibio: boolean; monto: number }
    producto?: { recibio: boolean; monto: number }
  }
  pagoDelivery?: { quienPaga?: string }
}

type DepositoOrderDoc = {
  id: string
  estado?: string
  confirmadoGestor?: boolean
  motorizadoUid: string
  montoTotal: number
  creadoAt?: Timestamp
  tipo?: string
}

type GastoSemana = { id: string; monto: number; tipo: string; fecha: any; estado: string }

type Liquidacion = {
  id: string
  motorizadoId: string
  motorizadoUid: string
  motorizadoNombre: string
  semanaKey: string
  semanaInicio: Timestamp
  semanaFin: Timestamp
  totalViajes: number
  totalGenerado: number
  comisionPct: number
  comision: number
  adelantos: number
  faltantesDeposito: number
  otrosDescuentos: number
  deudasAplicadas: number
  deudasAplicadasIds: string[]
  gastosAprobados?: number
  gastosAsumidosStorkhub?: number
  gastosIds?: string[]
  netoAPagar: number
  estado: 'pendiente' | 'pagado'
  creadoAt?: Timestamp
  pagadoAt?: Timestamp
  pagadoPor?: string
  saldoGeneradoId?: string
  pdfUrl?: string
  pdfPath?: string
}

type Saldo = SaldoCargoMotorizado & { id: string }

// ─── Semana helpers (ISO 8601) ────────────────────────────────────────────────

function getSemanaKey(date: Date): string {
  const d = new Date(Date.UTC(date.getFullYear(), date.getMonth(), date.getDate()))
  const day = d.getUTCDay() || 7
  d.setUTCDate(d.getUTCDate() + 4 - day)
  const yearStart = new Date(Date.UTC(d.getUTCFullYear(), 0, 1))
  const week = Math.ceil((((d.getTime() - yearStart.getTime()) / 86400000) + 1) / 7)
  return `${d.getUTCFullYear()}-W${String(week).padStart(2, '0')}`
}

function getSemanaRange(semanaKey: string): { inicio: Date; fin: Date } {
  const [yearStr, weekStr] = semanaKey.split('-W')
  const year = parseInt(yearStr)
  const week = parseInt(weekStr)
  const jan4 = new Date(year, 0, 4)
  const jan4Day = jan4.getDay() || 7
  const monday = new Date(jan4)
  monday.setDate(jan4.getDate() - jan4Day + 1 + (week - 1) * 7)
  monday.setHours(0, 0, 0, 0)
  const sunday = new Date(monday)
  sunday.setDate(monday.getDate() + 6)
  sunday.setHours(23, 59, 59, 999)
  return { inicio: monday, fin: sunday }
}

function formatSemana(semanaKey: string): string {
  try {
    const { inicio, fin } = getSemanaRange(semanaKey)
    const opts: Intl.DateTimeFormatOptions = { day: '2-digit', month: 'short' }
    return `${inicio.toLocaleDateString('es-NI', opts)} – ${fin.toLocaleDateString('es-NI', opts)}`
  } catch { return semanaKey }
}

function getSemanasRecientes(): string[] {
  const semanas: string[] = []
  const now = new Date()
  for (let i = 0; i < 8; i++) {
    const d = new Date(now)
    d.setDate(d.getDate() - i * 7)
    const key = getSemanaKey(d)
    if (!semanas.includes(key)) semanas.push(key)
  }
  return semanas
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function fmt(n?: number) {
  if (typeof n !== 'number') return '—'
  return `C$ ${n.toLocaleString('es-NI')}`
}

function tsToDate(v: any): Date | null {
  if (!v) return null
  if (typeof v?.toDate === 'function') return v.toDate()
  if (v instanceof Date) return v
  return null
}

function fmtDate(v: any) {
  const d = tsToDate(v)
  if (!d) return '—'
  return d.toLocaleDateString('es-NI', { day: '2-digit', month: 'short', year: 'numeric' })
}

// ─── PDF Generator ────────────────────────────────────────────────────────────

async function generateLiquidacionPDF(params: {
  liq: Liquidacion
  ordenes: Solicitud[]
  gastos: GastoSemana[]
  calculo: {
    totalViajes: number
    totalGenerado: number
    comision: number
    comisionPct: number
    totalDepositado: number
    faltantesDeposito: number
    adelantos: number
    totalGastos: number
    gastosAsumidosStorkhub: number
    deudasAplicar: number
    netoAPagar: number
  }
}): Promise<Blob> {
  const { liq, ordenes, gastos, calculo } = params

  // Lazy import jsPDF — solo en browser (client component)
  const jsPDFModule = await import('jspdf')
  const jsPDF = jsPDFModule.default
  const autoTableModule = await import('jspdf-autotable')
  const autoTable = autoTableModule.default

  const doc = new jsPDF({ unit: 'mm', format: 'a4' })
  const pageW = doc.internal.pageSize.getWidth()
  const blue = [0, 74, 173] as [number, number, number]
  const gray = [100, 100, 100] as [number, number, number]
  const lightGray = [240, 240, 240] as [number, number, number]

  let y = 15

  // ── Header ──────────────────────────────────────────────────────────────────
  doc.setFillColor(...blue)
  doc.rect(0, 0, pageW, 28, 'F')
  doc.setTextColor(255, 255, 255)
  doc.setFontSize(16)
  doc.setFont('helvetica', 'bold')
  doc.text('STORKHUB', 14, 12)
  doc.setFontSize(9)
  doc.setFont('helvetica', 'normal')
  doc.text('Comprobante de Liquidación', 14, 19)
  doc.setFontSize(10)
  doc.setFont('helvetica', 'bold')
  doc.text(`Semana ${liq.semanaKey}`, pageW - 14, 12, { align: 'right' })
  doc.setFontSize(8)
  doc.setFont('helvetica', 'normal')
  doc.text(formatSemana(liq.semanaKey), pageW - 14, 19, { align: 'right' })
  y = 36

  // ── Info motorizado ──────────────────────────────────────────────────────────
  doc.setTextColor(30, 30, 30)
  doc.setFontSize(11)
  doc.setFont('helvetica', 'bold')
  doc.text(liq.motorizadoNombre, 14, y)
  y += 6

  doc.setFontSize(8)
  doc.setFont('helvetica', 'normal')
  doc.setTextColor(...gray)
  const pagadoDate = tsToDate(liq.pagadoAt)
  doc.text(`Liquidación: ${pagadoDate ? pagadoDate.toLocaleDateString('es-NI', { day: '2-digit', month: 'short', year: 'numeric' }) : '—'}`, 14, y)
  doc.text(`Generado: ${new Date().toLocaleDateString('es-NI', { day: '2-digit', month: 'short', year: 'numeric' })}`, pageW - 14, y, { align: 'right' })
  y += 8

  // Separador
  doc.setDrawColor(...lightGray)
  doc.line(14, y, pageW - 14, y)
  y += 6

  // ── Resumen financiero ───────────────────────────────────────────────────────
  doc.setTextColor(30, 30, 30)
  doc.setFontSize(9)
  doc.setFont('helvetica', 'bold')
  doc.text('RESUMEN FINANCIERO', 14, y)
  y += 5

  const resumenRows: [string, string][] = [
    ['Total delivery generado', `C$ ${calculo.totalGenerado.toLocaleString('es-NI')}`],
    [`Comisión motorizado (${Math.round(calculo.comisionPct * 100)}%)`, `C$ ${calculo.comision.toLocaleString('es-NI')}`],
    ['Total depositado', `C$ ${calculo.totalDepositado.toLocaleString('es-NI')}`],
    ...(calculo.faltantesDeposito > 0 ? [['− Faltante depósito', `C$ ${calculo.faltantesDeposito.toLocaleString('es-NI')}`] as [string, string]] : []),
    ...(calculo.totalGastos > 0 ? [['Gastos operativos', `C$ ${calculo.totalGastos.toLocaleString('es-NI')}`] as [string, string]] : []),
    ...(calculo.gastosAsumidosStorkhub > 0 ? [['+ Gastos asumidos por StorkHub', `C$ ${calculo.gastosAsumidosStorkhub.toLocaleString('es-NI')}`] as [string, string]] : []),
    ...(calculo.adelantos > 0 ? [['− Adelantos semana', `C$ ${calculo.adelantos.toLocaleString('es-NI')}`] as [string, string]] : []),
    ...(calculo.deudasAplicar > 0 ? [['− Deudas/saldos descontados', `C$ ${calculo.deudasAplicar.toLocaleString('es-NI')}`] as [string, string]] : []),
  ]

  autoTable(doc, {
    startY: y,
    head: [],
    body: resumenRows,
    theme: 'plain',
    styles: { fontSize: 8, cellPadding: 1.5, textColor: [50, 50, 50] },
    columnStyles: {
      0: { cellWidth: 100 },
      1: { halign: 'right', fontStyle: 'bold' },
    },
    margin: { left: 14, right: 14 },
  })

  y = (doc as any).lastAutoTable.finalY + 4

  // Neto a pagar — resaltado
  const netoColor: [number, number, number] = calculo.netoAPagar < 0 ? [200, 40, 40] : [0, 130, 60]
  doc.setFillColor(...netoColor)
  doc.roundedRect(14, y, pageW - 28, 12, 2, 2, 'F')
  doc.setTextColor(255, 255, 255)
  doc.setFontSize(9)
  doc.setFont('helvetica', 'bold')
  doc.text(calculo.netoAPagar < 0 ? 'SALDO A CARGO DEL MOTORIZADO' : 'NETO A PAGAR AL MOTORIZADO', 20, y + 7.5)
  doc.setFontSize(11)
  doc.text(`C$ ${Math.abs(calculo.netoAPagar).toLocaleString('es-NI')}`, pageW - 20, y + 7.5, { align: 'right' })
  y += 18

  // ── Detalle de viajes ────────────────────────────────────────────────────────
  doc.setTextColor(30, 30, 30)
  doc.setFontSize(9)
  doc.setFont('helvetica', 'bold')
  doc.text(`DETALLE DE VIAJES (${calculo.totalViajes})`, 14, y)
  y += 4

  if (ordenes.length > 0) {
    autoTable(doc, {
      startY: y,
      head: [['# Orden', 'Entregado', 'Delivery', `Ganancia (${Math.round(calculo.comisionPct * 100)}%)`]],
      body: ordenes.map((o, i) => {
        const delivery = o.confirmacion?.precioFinalCordobas ?? 0
        const base = o.precioDesglose?.deliveryBase ?? delivery
        const ganancia = base * calculo.comisionPct
        return [
          `${i + 1}. ${o.id.slice(0, 10)}…`,
          fmtDate(o.entregadoAt),
          `C$ ${delivery.toLocaleString('es-NI')}`,
          `C$ ${ganancia.toLocaleString('es-NI')}`,
        ]
      }),
      foot: [[
        '',
        `${ordenes.length} viajes`,
        `C$ ${calculo.totalGenerado.toLocaleString('es-NI')}`,
        `C$ ${calculo.comision.toLocaleString('es-NI')}`,
      ]],
      theme: 'striped',
      headStyles: { fillColor: blue, textColor: [255, 255, 255], fontSize: 7.5, fontStyle: 'bold' },
      footStyles: { fillColor: lightGray, textColor: [50, 50, 50], fontSize: 7.5, fontStyle: 'bold' },
      styles: { fontSize: 7.5, cellPadding: 1.5 },
      columnStyles: { 2: { halign: 'right' }, 3: { halign: 'right', textColor: [0, 120, 50] } },
      margin: { left: 14, right: 14 },
    })
    y = (doc as any).lastAutoTable.finalY + 6
  }

  // ── Gastos operativos ────────────────────────────────────────────────────────
  if (gastos.length > 0) {
    if (y > 240) { doc.addPage(); y = 15 }
    doc.setTextColor(30, 30, 30)
    doc.setFontSize(9)
    doc.setFont('helvetica', 'bold')
    doc.text('GASTOS OPERATIVOS', 14, y)
    y += 4

    const labelGasto: Record<string, string> = {
      peaje_terminal: 'Peaje terminal',
      pago_cargotrans: 'Pago Cargotrans',
      otro_gasto_operativo: 'Otro gasto',
    }

    autoTable(doc, {
      startY: y,
      head: [['Tipo', 'Fecha', 'Monto']],
      body: gastos.map((g) => [
        labelGasto[g.tipo] ?? g.tipo,
        fmtDate(g.fecha),
        `C$ ${g.monto.toLocaleString('es-NI')}`,
      ]),
      foot: [['', 'Total', `C$ ${calculo.totalGastos.toLocaleString('es-NI')}`]],
      theme: 'striped',
      headStyles: { fillColor: [180, 100, 0], textColor: [255, 255, 255], fontSize: 7.5 },
      footStyles: { fillColor: lightGray, textColor: [50, 50, 50], fontSize: 7.5, fontStyle: 'bold' },
      styles: { fontSize: 7.5, cellPadding: 1.5 },
      columnStyles: { 2: { halign: 'right' } },
      margin: { left: 14, right: 14 },
    })
    y = (doc as any).lastAutoTable.finalY + 6
  }

  // ── Observaciones / saldos aplicados ────────────────────────────────────────
  if (calculo.deudasAplicar > 0 || liq.netoAPagar < 0) {
    if (y > 250) { doc.addPage(); y = 15 }
    const boxH = liq.netoAPagar < 0 ? 22 : 16
    doc.setFillColor(255, 248, 235)
    doc.roundedRect(14, y, pageW - 28, boxH, 2, 2, 'F')
    doc.setDrawColor(230, 180, 60)
    doc.roundedRect(14, y, pageW - 28, boxH, 2, 2, 'S')
    doc.setTextColor(120, 80, 0)
    doc.setFontSize(8)
    doc.setFont('helvetica', 'bold')
    doc.text('Observaciones', 18, y + 6)
    doc.setFont('helvetica', 'normal')
    if (calculo.deudasAplicar > 0) {
      doc.text(`Deudas/saldos descontados en esta liquidación: C$ ${calculo.deudasAplicar.toLocaleString('es-NI')}`, 18, y + 12)
    }
    if (liq.netoAPagar < 0 || liq.saldoGeneradoId) {
      doc.text(`Saldo pendiente generado: C$ ${Math.abs(liq.netoAPagar).toLocaleString('es-NI')}`, 18, y + 18)
    }
  }

  // ── Footer ───────────────────────────────────────────────────────────────────
  const pageCount = doc.getNumberOfPages()
  for (let p = 1; p <= pageCount; p++) {
    doc.setPage(p)
    doc.setFillColor(...lightGray)
    const ph = doc.internal.pageSize.getHeight()
    doc.rect(0, ph - 10, pageW, 10, 'F')
    doc.setTextColor(...gray)
    doc.setFontSize(7)
    doc.setFont('helvetica', 'normal')
    doc.text('StorkHub · Comprobante de liquidación', 14, ph - 4)
    doc.text(`Pág ${p}/${pageCount}`, pageW - 14, ph - 4, { align: 'right' })
  }

  return doc.output('blob')
}

// ─── Main ─────────────────────────────────────────────────────────────────────

export default function LiquidacionesPage() {
  const [motorizados, setMotorizados] = useState<Motorizado[]>([])
  const [selectedMotoId, setSelectedMotoId] = useState<string>('')
  const [selectedSemana, setSelectedSemana] = useState<string>(getSemanaKey(new Date()))

  const [ordenes, setOrdenes] = useState<Solicitud[]>([])
  const [depositos, setDepositos] = useState<DepositoOrderDoc[]>([])
  const [adelantos, setAdelantos] = useState<number>(0)
  const [loading, setLoading] = useState(false)
  const [expanded, setExpanded] = useState(false)

  // Gastos operativos de la semana
  const [gastos, setGastos] = useState<GastoSemana[]>([])

  // Saldos pendientes del motorizado
  const [saldosPendientes, setSaldosPendientes] = useState<Saldo[]>([])
  const [saldosSeleccionados, setSaldosSeleccionados] = useState<Set<string>>(new Set())
  const [abonosParciales, setAbonosParciales] = useState<Record<string, string>>({})

  // Adelanto rápido desde liquidaciones
  const [showAdelanto, setShowAdelanto] = useState(false)
  const [montoAdelanto, setMontoAdelanto] = useState('')
  const [notaAdelanto, setNotaAdelanto] = useState('')
  const [savingAdelanto, setSavingAdelanto] = useState(false)

  // Liquidaciones existentes
  const [liquidaciones, setLiquidaciones] = useState<Liquidacion[]>([])
  const [loadingLiq, setLoadingLiq] = useState(true)
  const [saving, setSaving] = useState(false)
  const [err, setErr] = useState<string | null>(null)

  const semanasOpciones = useMemo(() => getSemanasRecientes(), [])

  // ── Load motorizados ─────────────────────────────────────────────────────

  useEffect(() => {
    const q = query(collection(db, 'motorizado'))
    return onSnapshot(q, (snap) => {
      const list = snap.docs.map((d) => ({ id: d.id, ...(d.data() as any) } as Motorizado))
        .sort((a, b) => (a.nombre || '').localeCompare(b.nombre || ''))
      setMotorizados(list)
    })
  }, [])

  // ── Load liquidaciones del motorizado seleccionado ────────────────────────

  useEffect(() => {
    if (!selectedMotoId) { setLiquidaciones([]); setLoadingLiq(false); return }
    const moto = motorizados.find((m) => m.id === selectedMotoId)
    if (!moto) return
    setLoadingLiq(true)
    const q = query(
      collection(db, 'liquidaciones_motorizado'),
      where('motorizadoUid', '==', moto.authUid),
      orderBy('semanaKey', 'desc'),
      limit(20)
    )
    return onSnapshot(q, (snap) => {
      setLiquidaciones(snap.docs.map((d) => ({ id: d.id, ...(d.data() as any) } as Liquidacion)))
      setLoadingLiq(false)
    })
  }, [selectedMotoId, motorizados])

  // ── Load saldos pendientes del motorizado ─────────────────────────────────

  useEffect(() => {
    if (!selectedMotoId) { setSaldosPendientes([]); return }
    const moto = motorizados.find((m) => m.id === selectedMotoId)
    if (!moto?.authUid) return

    const q = query(
      collection(db, 'saldos_cargo_motorizado'),
      where('motorizadoUid', '==', moto.authUid),
      where('estado', 'in', ['pendiente', 'abonado_parcial'])
    )
    return onSnapshot(q, (snap) => {
      setSaldosPendientes(snap.docs.map((d) => ({ id: d.id, ...(d.data() as any) } as Saldo)))
      setSaldosSeleccionados(new Set())
      setAbonosParciales({})
    })
  }, [selectedMotoId, motorizados])

  // ── Load órdenes del motorizado en la semana seleccionada ─────────────────

  useEffect(() => {
    if (!selectedMotoId) { setOrdenes([]); return }
    const { inicio, fin } = getSemanaRange(selectedSemana)
    setLoading(true)

    const q = query(
      collection(db, 'solicitudes_envio'),
      where('asignacion.motorizadoId', '==', selectedMotoId),
      where('estado', '==', 'entregado')
    )
    return onSnapshot(q, (snap) => {
      const all = snap.docs.map((d) => ({ id: d.id, ...(d.data() as any) } as Solicitud))
      const filtradas = all.filter((o) => {
        const d = tsToDate(o.entregadoAt)
        if (!d) return false
        return d >= inicio && d <= fin
      })
      setOrdenes(filtradas)
      setLoading(false)
    })
  }, [selectedMotoId, selectedSemana])

  // ── Load depósitos confirmados del motorizado en la semana ────────────────

  useEffect(() => {
    if (!selectedMotoId) { setDepositos([]); return }
    const moto = motorizados.find((m) => m.id === selectedMotoId)
    if (!moto?.authUid) return

    const q = query(
      collection(db, 'ordenes_deposito'),
      where('motorizadoUid', '==', moto.authUid),
      where('confirmadoGestor', '==', true)
    )
    return onSnapshot(q, (snap) => {
      const all = snap.docs.map((d) => ({ id: d.id, ...(d.data() as any) } as DepositoOrderDoc))
      const { inicio, fin } = getSemanaRange(selectedSemana)
      const filtrados = all.filter((dep) => {
        const d = tsToDate(dep.creadoAt)
        if (!d) return false
        return d >= inicio && d <= fin
      })
      setDepositos(filtrados)
    })
  }, [selectedMotoId, selectedSemana, motorizados])

  // ── Load adelantos del motorizado en la semana ────────────────────────────

  useEffect(() => {
    if (!selectedMotoId) { setAdelantos(0); return }

    const q = query(
      collection(db, 'movimientos_financieros'),
      where('tipo', '==', 'adelanto_motorizado'),
      where('motorizadoId', '==', selectedMotoId)
    )
    const { inicio, fin } = getSemanaRange(selectedSemana)
    return onSnapshot(q, (snap) => {
      const total = snap.docs.reduce((sum, d) => {
        const data = d.data() as any
        const at = tsToDate(data.at)
        if (at && at >= inicio && at <= fin) return sum + (data.monto || 0)
        return sum
      }, 0)
      setAdelantos(total)
    })
  }, [selectedMotoId, selectedSemana])

  // ── Load gastos operativos del motorizado en la semana ───────────────────

  useEffect(() => {
    if (!selectedMotoId) { setGastos([]); return }
    const q = query(
      collection(db, 'gastos_motorizado'),
      where('motorizadoId', '==', selectedMotoId),
      where('estado', '==', 'aprobado')
    )
    const { inicio, fin } = getSemanaRange(selectedSemana)
    return onSnapshot(q, (snap) => {
      const all = snap.docs.map((d) => ({ id: d.id, ...(d.data() as any) } as GastoSemana))
      setGastos(all.filter((g) => {
        const d = tsToDate(g.fecha)
        return d !== null && d >= inicio && d <= fin
      }))
    })
  }, [selectedMotoId, selectedSemana])

  // ── Cálculo de deudas a aplicar ────────────────────────────────────────────

  const deudasAplicar = useMemo(() => {
    let total = 0
    for (const sid of saldosSeleccionados) {
      const s = saldosPendientes.find((x) => x.id === sid)
      if (!s) continue
      const parcialStr = abonosParciales[sid]
      const parcial = parcialStr ? parseFloat(parcialStr) : NaN
      total += isNaN(parcial) ? s.saldoPendiente : Math.min(parcial, s.saldoPendiente)
    }
    return total
  }, [saldosSeleccionados, saldosPendientes, abonosParciales])

  // ── Cálculos ──────────────────────────────────────────────────────────────

  const calculo = useMemo(() => {
    const totalGenerado = ordenes.reduce((s, o) => s + (o.confirmacion?.precioFinalCordobas || 0), 0)
    // Efectivo recaudado: solo órdenes donde el motorizado cobró en mano (no transferencia)
    const totalEfectivo = ordenes
      .filter((o) => o.pagoDelivery?.quienPaga !== 'transferencia')
      .reduce((s, o) => s + (o.confirmacion?.precioFinalCordobas || 0), 0)
    const totalGastos = gastos.reduce((s, g) => s + g.monto, 0)
    // Gastos reducen el depósito; si superan el efectivo, Storkhub asume el excedente
    const gastosAsumidosStorkhub = Math.max(0, totalGastos - totalEfectivo)
    const totalADepositar = Math.max(0, totalEfectivo - totalGastos)
    const totalDepositado = depositos
      .filter((d) => !d.tipo || d.tipo === 'recaudacion_motorizado_storkhub')
      .reduce((s, d) => s + d.montoTotal, 0)
    const comision = ordenes.reduce((s, o) => {
      const base = o.precioDesglose?.deliveryBase
      if (base != null) return s + base * 0.8
      return s + (o.confirmacion?.precioFinalCordobas || 0) * 0.8
    }, 0)
    const comisionPct = 0.8
    const faltantesDeposito = Math.max(0, totalADepositar - totalDepositado)
    const netoAPagar = comision - adelantos - faltantesDeposito + gastosAsumidosStorkhub - deudasAplicar

    return {
      totalViajes: ordenes.length,
      totalGenerado,
      totalEfectivo,
      totalGastos,
      gastosAsumidosStorkhub,
      totalADepositar,
      totalDepositado,
      comisionPct,
      comision,
      adelantos,
      faltantesDeposito,
      otrosDescuentos: 0,
      deudasAplicar,
      netoAPagar,
    }
  }, [ordenes, depositos, adelantos, deudasAplicar, gastos])

  const liquidacionExistente = useMemo(
    () => liquidaciones.find((l) => l.semanaKey === selectedSemana),
    [liquidaciones, selectedSemana]
  )

  // ── Crear liquidación ─────────────────────────────────────────────────────

  async function crearLiquidacion() {
    if (!selectedMotoId || liquidacionExistente) return
    const moto = motorizados.find((m) => m.id === selectedMotoId)
    if (!moto) return

    setSaving(true); setErr(null)
    try {
      const uid = auth.currentUser?.uid ?? ''
      const { inicio, fin } = getSemanaRange(selectedSemana)

      // Calcular IDs de saldos seleccionados y sus montos reales
      const deudasAplicadasIds: string[] = []
      for (const sid of saldosSeleccionados) {
        const saldo = saldosPendientes.find((x) => x.id === sid)
        if (!saldo) continue
        const parcialStr = abonosParciales[sid]
        const parcial = parcialStr ? parseFloat(parcialStr) : NaN
        const montoAbono = isNaN(parcial) ? saldo.saldoPendiente : Math.min(parcial, saldo.saldoPendiente)

        // Registrar el abono en el saldo
        await registrarAbonoSaldo({
          saldoId: sid,
          montoAbono,
          saldoPendienteActual: saldo.saldoPendiente,
          metodo: 'descuento_liquidacion',
          nota: `Descontado en liquidación ${selectedSemana}`,
          operadorId: uid,
          motorizadoId: selectedMotoId,
          motorizadoNombre: moto.nombre || moto.authUid,
        })
        deudasAplicadasIds.push(sid)
      }

      const docRef = await addDoc(collection(db, 'liquidaciones_motorizado'), {
        motorizadoId: selectedMotoId,
        motorizadoUid: moto.authUid,
        motorizadoNombre: moto.nombre || moto.authUid,
        semanaKey: selectedSemana,
        semanaInicio: Timestamp.fromDate(inicio),
        semanaFin: Timestamp.fromDate(fin),
        totalViajes: calculo.totalViajes,
        totalGenerado: calculo.totalGenerado,
        comisionPct: calculo.comisionPct,
        comision: calculo.comision,
        adelantos: calculo.adelantos,
        faltantesDeposito: calculo.faltantesDeposito,
        otrosDescuentos: 0,
        deudasAplicadas: calculo.deudasAplicar,
        deudasAplicadasIds,
        gastosAprobados: calculo.totalGastos,
        gastosAsumidosStorkhub: calculo.gastosAsumidosStorkhub,
        gastosIds: gastos.map((g) => g.id),
        netoAPagar: calculo.netoAPagar,
        estado: 'pendiente',
        creadoAt: serverTimestamp(),
        creadoPor: uid,
        ordenesIds: ordenes.map((o) => o.id),
        depositosIds: depositos.map((d) => d.id),
      })
      await registrarMovimiento('liquidacion_pagada', calculo.netoAPagar, uid,
        `Liquidación creada sem ${selectedSemana} · ${moto.nombre || moto.authUid}`,
        { motorizadoId: selectedMotoId, depositoId: docRef.id })
    } catch (e: any) {
      setErr(e?.message || 'Error al crear liquidación')
    } finally {
      setSaving(false)
    }
  }

  async function marcarPagada(liq: Liquidacion) {
    setSaving(true); setErr(null)
    try {
      const uid = auth.currentUser?.uid ?? ''

      // Si ya tiene saldo generado no volver a crear uno
      let saldoGeneradoId = liq.saldoGeneradoId ?? undefined

      // Cuando el motorizado queda debiendo (netoAPagar < 0), crear deuda persistente
      if (liq.netoAPagar < 0 && !saldoGeneradoId) {
        const montoDeuda = Math.abs(liq.netoAPagar)
        saldoGeneradoId = await crearSaldoCargo({
          motorizadoId: liq.motorizadoId,
          motorizadoUid: liq.motorizadoUid,
          motorizadoNombre: liq.motorizadoNombre,
          tipo: 'deposito_no_realizado',
          monto: montoDeuda,
          origen: 'liquidacion',
          liquidacionId: liq.id,
          nota: `Saldo pendiente liquidación ${liq.semanaKey}`,
          operadorId: uid,
        })
      }

      // Marcar como pagado en Firestore
      await updateDoc(doc(db, 'liquidaciones_motorizado', liq.id), {
        estado: 'pagado',
        pagadoAt: serverTimestamp(),
        pagadoPor: uid,
        ...(saldoGeneradoId ? { saldoGeneradoId } : {}),
      })

      await registrarMovimiento('liquidacion_pagada', liq.netoAPagar, uid,
        `Liquidación pagada sem ${liq.semanaKey} · ${liq.motorizadoNombre}`,
        { motorizadoId: liq.motorizadoId })

      // ── Generar y subir PDF ────────────────────────────────────────────────
      try {
        const pdfBlob = await generateLiquidacionPDF({
          liq: { ...liq, estado: 'pagado' },
          ordenes,
          gastos,
          calculo,
        })
        const { url, pathStorage } = await uploadLiquidacionPDF(liq.id, pdfBlob)
        await updateDoc(doc(db, 'liquidaciones_motorizado', liq.id), {
          pdfUrl: url,
          pdfPath: pathStorage,
          pdfGeneradoAt: serverTimestamp(),
        })
      } catch (pdfErr) {
        // PDF falla silenciosamente — no bloquea el flujo principal
        console.error('[liquidaciones] Error generando PDF:', pdfErr)
      }
    } catch (e: any) {
      setErr(e?.message || 'Error')
    } finally {
      setSaving(false)
    }
  }

  // ── Registrar adelanto rápido ─────────────────────────────────────────────

  async function handleAdelanto() {
    const monto = parseFloat(montoAdelanto)
    if (isNaN(monto) || monto <= 0 || !selectedMotoId) return
    const moto = motorizados.find((m) => m.id === selectedMotoId)
    if (!moto) return
    setSavingAdelanto(true)
    try {
      const uid = auth.currentUser?.uid ?? ''
      // Movimiento financiero (para compatibilidad con el cálculo existente)
      await registrarMovimiento(
        'adelanto_motorizado',
        monto,
        uid,
        `Adelanto C$${monto} · ${moto.nombre || moto.authUid} · Sem ${selectedSemana}`,
        { motorizadoId: selectedMotoId }
      )
      setMontoAdelanto('')
      setNotaAdelanto('')
      setShowAdelanto(false)
    } catch (e: any) {
      console.error('Error registrando adelanto:', e)
    } finally {
      setSavingAdelanto(false)
    }
  }

  const selectedMoto = motorizados.find((m) => m.id === selectedMotoId)
  const totalSaldosPendientes = saldosPendientes.reduce((s, x) => s + x.saldoPendiente, 0)

  // ── Render ─────────────────────────────────────────────────────────────────

  return (
    <div className="flex flex-col gap-5 max-w-3xl mx-auto">
      {/* Header */}
      <div>
        <h1 className="text-2xl font-black text-gray-900 tracking-tight flex items-center gap-2">
          <Receipt className="h-6 w-6 text-[#004aad]" />
          Liquidaciones
        </h1>
        <p className="text-sm text-gray-500 mt-0.5">
          Cálculo y pago semanal de motorizados
        </p>
      </div>

      {/* Selector */}
      <div className="grid grid-cols-1 sm:grid-cols-2 gap-3 bg-white rounded-xl border border-gray-200 p-4">
        <div>
          <label className="block text-xs font-semibold text-gray-500 mb-1">Motorizado</label>
          <select
            value={selectedMotoId}
            onChange={(e) => setSelectedMotoId(e.target.value)}
            className="w-full border border-gray-200 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-[#004aad]/30"
          >
            <option value="">— Seleccionar —</option>
            {motorizados.map((m) => (
              <option key={m.id} value={m.id}>{m.nombre || m.authUid}</option>
            ))}
          </select>
        </div>
        <div>
          <label className="block text-xs font-semibold text-gray-500 mb-1">Semana</label>
          <select
            value={selectedSemana}
            onChange={(e) => setSelectedSemana(e.target.value)}
            className="w-full border border-gray-200 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-[#004aad]/30"
          >
            {semanasOpciones.map((s) => (
              <option key={s} value={s}>{s} · {formatSemana(s)}</option>
            ))}
          </select>
        </div>
      </div>

      {/* Cálculo */}
      {selectedMotoId && (
        <div className="bg-white rounded-xl border border-gray-200 shadow-sm overflow-hidden">
          <div className="px-4 py-3 border-b border-gray-100 flex items-center justify-between gap-2">
            <div>
              <p className="text-sm font-bold text-gray-900">{selectedMoto?.nombre}</p>
              <p className="text-xs text-gray-400">{selectedSemana} · {formatSemana(selectedSemana)}</p>
            </div>
            <div className="flex items-center gap-2">
              {liquidacionExistente && (
                <span className={`text-xs font-bold px-2 py-1 rounded-full ${
                  liquidacionExistente.estado === 'pagado'
                    ? 'bg-green-100 text-green-700'
                    : 'bg-orange-100 text-orange-700'
                }`}>
                  {liquidacionExistente.estado === 'pagado' ? '✓ Pagado' : '⏳ Pendiente'}
                </span>
              )}
              {!liquidacionExistente && (
                <button
                  onClick={() => setShowAdelanto((v) => !v)}
                  className="flex items-center gap-1 text-xs font-semibold text-[#004aad] border border-[#004aad]/30 rounded-lg px-2 py-1 hover:bg-blue-50 transition"
                >
                  <CreditCard className="h-3 w-3" />
                  Adelanto
                </button>
              )}
            </div>
          </div>

          {/* Formulario adelanto rápido */}
          {showAdelanto && !liquidacionExistente && (
            <div className="px-4 py-3 border-b border-gray-100 bg-amber-50 flex flex-col gap-2">
              <p className="text-xs font-semibold text-amber-800">Registrar adelanto para esta semana</p>
              <div className="flex gap-2">
                <input
                  type="number"
                  min="0"
                  step="0.01"
                  value={montoAdelanto}
                  onChange={(e) => setMontoAdelanto(e.target.value)}
                  placeholder="Monto C$"
                  className="flex-1 border border-amber-200 rounded-lg px-3 py-1.5 text-xs focus:outline-none focus:ring-1 focus:ring-amber-400"
                />
                <input
                  type="text"
                  value={notaAdelanto}
                  onChange={(e) => setNotaAdelanto(e.target.value)}
                  placeholder="Nota (opcional)"
                  className="flex-1 border border-amber-200 rounded-lg px-3 py-1.5 text-xs focus:outline-none focus:ring-1 focus:ring-amber-400"
                />
                <button
                  onClick={handleAdelanto}
                  disabled={savingAdelanto || !montoAdelanto}
                  className="bg-amber-600 text-white text-xs font-semibold px-3 py-1.5 rounded-lg hover:bg-amber-700 transition disabled:opacity-40"
                >
                  {savingAdelanto ? '…' : 'Registrar'}
                </button>
                <button
                  onClick={() => setShowAdelanto(false)}
                  className="text-xs text-gray-500 hover:text-gray-700 px-2"
                >
                  ✕
                </button>
              </div>
              <p className="text-[11px] text-amber-700">
                El adelanto reduce la ganancia del motorizado en esta semana. <strong>No reduce el depósito a Storkhub.</strong>
              </p>
            </div>
          )}

          {loading ? (
            <div className="py-10 text-center text-sm text-gray-400">Cargando datos…</div>
          ) : (
            <div className="p-4 flex flex-col gap-4">
              {/* KPIs grid */}
              <div className="grid grid-cols-2 sm:grid-cols-3 gap-3">
                <KpiCard label="Viajes" value={calculo.totalViajes.toString()} color="blue" />
                <KpiCard label="Total delivery" value={fmt(calculo.totalGenerado)} color="gray" />
                <KpiCard label="Ganancia motorizado (80%)" value={fmt(calculo.comision)} color="green" />
                <KpiCard label="Total depositado" value={fmt(calculo.totalDepositado)} color="gray" />
                <KpiCard label="Faltante depósito" value={fmt(calculo.faltantesDeposito)} color={calculo.faltantesDeposito > 0 ? 'red' : 'gray'} />
                <KpiCard label="Adelantos esta semana" value={fmt(calculo.adelantos)} color={calculo.adelantos > 0 ? 'orange' : 'gray'} />
                {calculo.totalGastos > 0 && (
                  <KpiCard label="Gastos semana" value={fmt(calculo.totalGastos)} color="orange" />
                )}
                {calculo.gastosAsumidosStorkhub > 0 && (
                  <KpiCard label="Asume Storkhub" value={fmt(calculo.gastosAsumidosStorkhub)} color="green" />
                )}
              </div>

              {/* Saldos pendientes del motorizado */}
              {saldosPendientes.length > 0 && !liquidacionExistente && (
                <div className="rounded-xl border-2 border-red-200 bg-red-50 overflow-hidden">
                  <div className="px-4 py-2.5 border-b border-red-100 flex items-center justify-between">
                    <div className="flex items-center gap-2">
                      <AlertTriangle className="h-4 w-4 text-red-500" />
                      <p className="text-sm font-bold text-red-800">
                        Saldos pendientes del motorizado
                      </p>
                    </div>
                    <span className="text-sm font-black text-red-700">{fmt(totalSaldosPendientes)}</span>
                  </div>
                  <div className="p-3 flex flex-col gap-2">
                    <p className="text-xs text-red-600">
                      Seleccioná los saldos que querés descontar en esta liquidación. Podés aplicar abono parcial.
                    </p>
                    {saldosPendientes.map((s) => {
                      const sel = saldosSeleccionados.has(s.id)
                      const parcialStr = abonosParciales[s.id] ?? ''
                      return (
                        <div key={s.id} className={`bg-white rounded-lg border p-3 flex flex-col gap-2 transition ${sel ? 'border-red-400' : 'border-red-100'}`}>
                          <div className="flex items-start gap-2">
                            <input
                              type="checkbox"
                              checked={sel}
                              onChange={(e) => {
                                setSaldosSeleccionados((prev) => {
                                  const next = new Set(prev)
                                  e.target.checked ? next.add(s.id) : next.delete(s.id)
                                  return next
                                })
                              }}
                              className="mt-0.5 accent-red-600"
                            />
                            <div className="flex-1">
                              <div className="flex items-center gap-2 flex-wrap">
                                <span className="text-xs font-semibold text-gray-800">
                                  {LABELS_TIPO_SALDO[s.tipo]}
                                </span>
                                <span className="text-[11px] text-gray-400">{fmtDate(s.fecha || s.createdAt)}</span>
                                {s.nota && (
                                  <span className="text-[11px] text-gray-500 italic">{s.nota}</span>
                                )}
                              </div>
                              <div className="flex items-center gap-3 mt-1">
                                <span className="text-xs text-gray-500">Saldo: <strong className="text-red-700">{fmt(s.saldoPendiente)}</strong></span>
                                {s.montoOriginal !== s.saldoPendiente && (
                                  <span className="text-[11px] text-gray-400">Original: {fmt(s.montoOriginal)}</span>
                                )}
                              </div>
                            </div>
                          </div>
                          {sel && (
                            <div className="flex items-center gap-2 pl-6">
                              <label className="text-[11px] text-gray-500 shrink-0">Abono:</label>
                              <input
                                type="number"
                                min="0"
                                max={s.saldoPendiente}
                                step="0.01"
                                value={parcialStr}
                                onChange={(e) => setAbonosParciales((prev) => ({ ...prev, [s.id]: e.target.value }))}
                                placeholder={`Máx C$${s.saldoPendiente} (vacío = total)`}
                                className="flex-1 border border-red-200 rounded-lg px-2 py-1 text-xs focus:outline-none focus:ring-1 focus:ring-red-400"
                              />
                            </div>
                          )}
                        </div>
                      )
                    })}
                    {saldosSeleccionados.size > 0 && (
                      <p className="text-xs font-semibold text-red-700 px-1">
                        Se descontarán <strong>{fmt(deudasAplicar)}</strong> de la ganancia del motorizado.
                      </p>
                    )}
                  </div>
                </div>
              )}

              {/* Neto a pagar */}
              <div className={`rounded-xl px-4 py-4 flex items-center justify-between ${calculo.netoAPagar < 0 ? 'bg-red-600' : 'bg-[#004aad]'} text-white`}>
                <div>
                  <p className="text-xs font-semibold opacity-70">
                    {calculo.netoAPagar < 0 ? 'SALDO A CARGO DEL MOTORIZADO' : 'NETO A PAGAR'}
                  </p>
                  <p className="text-2xl font-black mt-0.5">{fmt(Math.abs(calculo.netoAPagar))}</p>
                  {calculo.netoAPagar < 0 && (
                    <p className="text-xs opacity-80 mt-0.5">El motorizado debe depositar este monto adicional</p>
                  )}
                </div>
                <div className="text-right text-xs opacity-70 space-y-0.5">
                  <p>Ganancia {fmt(calculo.comision)}</p>
                  {calculo.adelantos > 0 && <p>− Adelantos {fmt(calculo.adelantos)}</p>}
                  {calculo.faltantesDeposito > 0 && <p>− Faltante depósito {fmt(calculo.faltantesDeposito)}</p>}
                  {calculo.deudasAplicar > 0 && <p>− Deudas aplicadas {fmt(calculo.deudasAplicar)}</p>}
                  {calculo.gastosAsumidosStorkhub > 0 && <p>+ Gastos asumidos Storkhub {fmt(calculo.gastosAsumidosStorkhub)}</p>}
                </div>
              </div>

              {/* Desglose de órdenes colapsable */}
              <button
                onClick={() => setExpanded((v) => !v)}
                className="flex items-center gap-1 text-xs text-[#004aad] font-semibold"
              >
                {expanded ? <ChevronUp className="h-3 w-3" /> : <ChevronDown className="h-3 w-3" />}
                {calculo.totalViajes} viaje{calculo.totalViajes !== 1 ? 's' : ''} en esta semana
              </button>

              {expanded && ordenes.length > 0 && (
                <div className="rounded-xl border border-gray-100 overflow-hidden">
                  <table className="w-full text-xs">
                    <thead>
                      <tr className="bg-gray-50 border-b">
                        <th className="px-3 py-2 text-left font-semibold text-gray-500">Orden</th>
                        <th className="px-3 py-2 text-left font-semibold text-gray-500">Entregado</th>
                        <th className="px-3 py-2 text-right font-semibold text-gray-500">Delivery</th>
                        <th className="px-3 py-2 text-right font-semibold text-green-600">Ganancia</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-gray-50">
                      {ordenes.map((o) => {
                        const ganancia = (o.precioDesglose?.deliveryBase != null
                          ? o.precioDesglose.deliveryBase
                          : (o.confirmacion?.precioFinalCordobas || 0)) * 0.8
                        return (
                          <tr key={o.id}>
                            <td className="px-3 py-2 font-mono text-gray-400">{o.id.slice(0, 10)}</td>
                            <td className="px-3 py-2 text-gray-600">{fmtDate(o.entregadoAt)}</td>
                            <td className="px-3 py-2 text-right font-semibold text-gray-800">
                              {fmt(o.confirmacion?.precioFinalCordobas)}
                            </td>
                            <td className="px-3 py-2 text-right font-semibold text-green-700">
                              {fmt(ganancia)}
                            </td>
                          </tr>
                        )
                      })}
                    </tbody>
                  </table>
                </div>
              )}

              {err && <p className="text-xs text-red-600">{err}</p>}

              {/* Acciones */}
              {liquidacionExistente ? (
                liquidacionExistente.estado === 'pendiente' ? (
                  <button
                    onClick={() => marcarPagada(liquidacionExistente)}
                    disabled={saving}
                    className="w-full bg-green-600 text-white text-sm font-semibold py-2.5 rounded-xl hover:bg-green-700 transition disabled:opacity-40"
                  >
                    {saving ? 'Guardando…' : '✓ Marcar como pagado'}
                  </button>
                ) : (
                  <div className="flex items-center justify-between gap-2 bg-green-50 rounded-xl px-4 py-3">
                    <div className="flex items-center gap-2 text-green-700">
                      <CheckCircle2 className="h-4 w-4" />
                      <span className="text-sm font-semibold">Liquidación pagada · {fmtDate(liquidacionExistente.pagadoAt)}</span>
                    </div>
                    {liquidacionExistente.pdfUrl && (
                      <a
                        href={liquidacionExistente.pdfUrl}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="flex items-center gap-1.5 text-xs font-bold text-[#004aad] bg-white border border-[#004aad]/30 px-3 py-1.5 rounded-lg hover:bg-blue-50 transition"
                      >
                        <FileDown className="h-3.5 w-3.5" />
                        Descargar PDF
                      </a>
                    )}
                  </div>
                )
              ) : (
                <button
                  onClick={crearLiquidacion}
                  disabled={saving || calculo.totalViajes === 0}
                  className="w-full bg-[#004aad] text-white text-sm font-semibold py-2.5 rounded-xl hover:bg-[#0a49a4] transition disabled:opacity-40"
                >
                  {saving ? 'Creando…' : calculo.totalViajes === 0 ? 'Sin viajes en esta semana' : '+ Crear liquidación'}
                </button>
              )}

              {/* Resumen deudas de la liquidación existente */}
              {liquidacionExistente && (liquidacionExistente.deudasAplicadas ?? 0) > 0 && (
                <div className="rounded-xl border border-orange-200 bg-orange-50 px-4 py-3 text-xs text-orange-700">
                  <p className="font-semibold mb-1">Deudas descontadas en esta liquidación</p>
                  <p>Monto aplicado: <strong>{fmt(liquidacionExistente.deudasAplicadas)}</strong></p>
                </div>
              )}
            </div>
          )}
        </div>
      )}

      {/* Saldos pendientes — vista siempre visible cuando hay motorizado seleccionado */}
      {selectedMotoId && saldosPendientes.length > 0 && liquidacionExistente && (
        <div className="bg-white rounded-xl border border-gray-200 shadow-sm overflow-hidden">
          <div className="px-4 py-3 border-b border-gray-100 flex items-center justify-between">
            <div className="flex items-center gap-2">
              <AlertTriangle className="h-4 w-4 text-red-500" />
              <p className="text-sm font-bold text-gray-900">Saldos pendientes</p>
            </div>
            <span className="text-sm font-black text-red-700">{fmt(totalSaldosPendientes)}</span>
          </div>
          <div className="divide-y divide-gray-100">
            {saldosPendientes.map((s) => (
              <div key={s.id} className="px-4 py-3 flex items-center justify-between gap-3">
                <div>
                  <p className="text-xs font-semibold text-gray-800">{LABELS_TIPO_SALDO[s.tipo]}</p>
                  <p className="text-[11px] text-gray-400 mt-0.5">{s.nota || '—'} · {fmtDate(s.fecha || s.createdAt)}</p>
                </div>
                <div className="text-right">
                  <p className="text-sm font-black text-red-700">{fmt(s.saldoPendiente)}</p>
                  <p className="text-[11px] text-gray-400">{s.estado === 'abonado_parcial' ? 'Abonado parcial' : 'Pendiente'}</p>
                </div>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Historial de liquidaciones */}
      {selectedMotoId && (
        <div className="bg-white rounded-xl border border-gray-200 shadow-sm overflow-hidden">
          <div className="px-4 py-3 border-b border-gray-100">
            <p className="text-sm font-bold text-gray-900">Historial de liquidaciones</p>
          </div>
          {loadingLiq ? (
            <div className="py-8 text-center text-sm text-gray-400">Cargando…</div>
          ) : liquidaciones.length === 0 ? (
            <div className="py-8 text-center text-sm text-gray-400">Sin liquidaciones registradas</div>
          ) : (
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b bg-gray-50">
                  <th className="px-4 py-2.5 text-left text-xs font-semibold uppercase tracking-wide text-gray-500">Semana</th>
                  <th className="px-4 py-2.5 text-left text-xs font-semibold uppercase tracking-wide text-gray-500">Viajes</th>
                  <th className="px-4 py-2.5 text-right text-xs font-semibold uppercase tracking-wide text-gray-500">Deudas desc.</th>
                  <th className="px-4 py-2.5 text-right text-xs font-semibold uppercase tracking-wide text-gray-500">Gastos Storkhub</th>
                  <th className="px-4 py-2.5 text-right text-xs font-semibold uppercase tracking-wide text-gray-500">Neto</th>
                  <th className="px-4 py-2.5 text-left text-xs font-semibold uppercase tracking-wide text-gray-500">Estado</th>
                  <th className="px-4 py-2.5 text-center text-xs font-semibold uppercase tracking-wide text-gray-500">PDF</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-gray-100">
                {liquidaciones.map((l) => (
                  <tr key={l.id} className="hover:bg-gray-50 transition-colors">
                    <td className="px-4 py-3">
                      <p className="text-xs font-bold text-gray-900">{l.semanaKey}</p>
                      <p className="text-xs text-gray-400">{formatSemana(l.semanaKey)}</p>
                    </td>
                    <td className="px-4 py-3 text-sm text-gray-700">{l.totalViajes}</td>
                    <td className="px-4 py-3 text-right text-xs font-semibold text-red-600">
                      {(l.deudasAplicadas ?? 0) > 0 ? fmt(l.deudasAplicadas) : '—'}
                    </td>
                    <td className="px-4 py-3 text-right text-xs font-semibold text-green-600">
                      {(l.gastosAsumidosStorkhub ?? 0) > 0 ? fmt(l.gastosAsumidosStorkhub) : '—'}
                    </td>
                    <td className="px-4 py-3 text-right font-semibold text-gray-900">{fmt(l.netoAPagar)}</td>
                    <td className="px-4 py-3">
                      <span className={`text-xs font-semibold px-2 py-1 rounded-full ${
                        l.estado === 'pagado'
                          ? 'bg-green-100 text-green-700'
                          : 'bg-orange-100 text-orange-700'
                      }`}>
                        {l.estado === 'pagado' ? 'Pagado' : 'Pendiente'}
                      </span>
                    </td>
                    <td className="px-4 py-3 text-center">
                      {l.pdfUrl ? (
                        <a
                          href={l.pdfUrl}
                          target="_blank"
                          rel="noopener noreferrer"
                          className="inline-flex items-center gap-1 text-xs font-semibold text-[#004aad] hover:text-blue-800 transition"
                          title="Descargar PDF"
                        >
                          <FileDown className="h-4 w-4" />
                          PDF
                        </a>
                      ) : l.estado === 'pagado' ? (
                        <span className="text-xs text-gray-300">—</span>
                      ) : null}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
      )}

      {!selectedMotoId && (
        <div className="flex flex-col items-center justify-center py-20 gap-3 text-gray-400">
          <Receipt className="h-12 w-12 opacity-25" />
          <p className="text-sm font-semibold">Selecciona un motorizado para ver sus liquidaciones</p>
        </div>
      )}
    </div>
  )
}

// ─── KpiCard helper ───────────────────────────────────────────────────────────

function KpiCard({ label, value, color }: { label: string; value: string; color: 'blue' | 'green' | 'gray' | 'red' | 'orange' }) {
  const styles = {
    blue: 'bg-blue-50 border-blue-200 text-[#004aad]',
    green: 'bg-green-50 border-green-200 text-green-700',
    gray: 'bg-gray-50 border-gray-200 text-gray-700',
    red: 'bg-red-50 border-red-200 text-red-700',
    orange: 'bg-orange-50 border-orange-200 text-orange-700',
  }
  return (
    <div className={`rounded-xl border px-3 py-2.5 ${styles[color]}`}>
      <p className="text-xs font-semibold opacity-60 mb-0.5">{label}</p>
      <p className="text-sm font-black">{value}</p>
    </div>
  )
}
