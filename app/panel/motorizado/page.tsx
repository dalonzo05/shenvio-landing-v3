'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { onAuthStateChanged, User } from 'firebase/auth';
import {
  collection, onSnapshot, query, where,
  doc, getDoc, setDoc, updateDoc, serverTimestamp, Timestamp, writeBatch,
  runTransaction, increment, arrayUnion, limit,
} from 'firebase/firestore';
import { auth, db } from '@/fb/config';
import { compressImage, uploadEvidencia, uploadDepositoBoucher, type TipoEvidencia } from '@/fb/storage';

// ─── Constants ───────────────────────────────────────────────────────────────

type BankAccount = { bank: string; number: string; holder: string; currency: string }

const STORKHUB_ACCOUNTS: BankAccount[] = [
  { bank: 'LAFISE', currency: 'C$', number: '130076402', holder: 'David Alonzo Orozco' },
  { bank: 'BAC',    currency: '$',  number: '366321743', holder: 'David Alonzo Orozco' },
]

// ─── Types ───────────────────────────────────────────────────────────────────

type EstadoSolicitud =
  | 'pendiente_confirmacion' | 'confirmada' | 'asignada'
  | 'en_camino_retiro' | 'retirado' | 'en_camino_entrega' | 'entregado';

type EstadoAceptacion = 'pendiente' | 'aceptada' | 'rechazada' | 'expirada';

type Solicitud = {
  id: string;
  userId?: string;
  estado?: EstadoSolicitud;
  createdAt?: Timestamp;
  updatedAt?: Timestamp;
  entregadoAt?: Timestamp;
  tipoCliente?: 'contado' | 'credito';
  cliente?: { nombre?: string; telefono?: string };
  comercio?: { nombre?: string; direccionTexto?: string };
  recoleccion?: { nombreApellido?: string; celular?: string; direccionEscrita?: string; nota?: string | null; notaMotorizado?: string | null; coord?: { lat: number; lng: number } | null; puntoGoogleLink?: string | null; puntoGoogleTexto?: string | null };
  entrega?: { nombreApellido?: string; celular?: string; direccionEscrita?: string; nota?: string | null; notaMotorizado?: string | null; coord?: { lat: number; lng: number } | null; puntoGoogleLink?: string | null; puntoGoogleTexto?: string | null };
  paquete?: { fragil?: boolean; grande?: boolean; notaPaquete?: string | null } | null;
  cotizacion?: { origenCoord?: { lat: number; lng: number } | null; destinoCoord?: { lat: number; lng: number } | null };
  confirmacion?: { precioFinalCordobas?: number };
  cobroContraEntrega?: { aplica?: boolean; monto?: number };
  pagoDelivery?: {
    tipo?: string;
    quienPaga?: string;
    montoSugerido?: number | null;
    deducirDelCobroContraEntrega?: boolean;
  };
  asignacion?: {
    motorizadoId?: string;
    motorizadoAuthUid?: string;
    motorizadoNombre?: string;
    asignadoAt?: Timestamp;
    aceptarAntesDe?: Timestamp;
    estadoAceptacion?: EstadoAceptacion;
    aceptadoAt?: Timestamp | null;
    rechazadoAt?: Timestamp | null;
  } | null;
  ownerSnapshot?: { companyName?: string; nombre?: string; phone?: string };
  cobrosMotorizado?: {
    delivery?: { monto: number; recibio: boolean; at?: any; justificacion?: string };
    producto?: { monto: number; recibio: boolean; at?: any; justificacion?: string };
  };
  registro?: {
    deposito?: {
      confirmadoMotorizado?: boolean;
      confirmadoAt?: Timestamp;
      confirmadoComercio?: boolean;
      confirmadoComercioAt?: Timestamp;
      confirmadoStorkhub?: boolean;
      confirmadoStorkhubAt?: Timestamp;
      storkhubDepositoId?: string;
      comercioDepositoId?: string;
    };
  };
  evidencias?: {
    retiro?: EvidenciaFoto;
    entrega?: EvidenciaFoto;
    deposito?: EvidenciaFoto;
  };
};

type EvidenciaFoto = { url: string; pathStorage: string; uploadedAt?: Timestamp; motorizadoUid?: string };

type PendingConfirm = {
  order: Solicitud;
  nuevo: EstadoSolicitud;
  esRetiro: boolean;
  showDelivery: boolean;
  showProducto: boolean;
  montoDelivery: number;
  montoProducto: number;
  recibioDelivery: boolean;
  recibioProducto: boolean;
  justDelivery: string;
  justProducto: string;
};

// ─── Helpers ─────────────────────────────────────────────────────────────────

function tsToDate(v: any): Date | null {
  if (!v) return null;
  if (typeof v?.toDate === 'function') return v.toDate();
  if (v instanceof Date) return v;
  return null;
}

function fmt(n?: number) {
  if (typeof n !== 'number') return '-';
  return `C$ ${n.toLocaleString('es-NI')}`;
}

function fmtTime(v: any) {
  const d = tsToDate(v);
  if (!d) return '-';
  return d.toLocaleString('es-NI', { hour: '2-digit', minute: '2-digit', day: '2-digit', month: 'short' });
}

function fmtDateInput(d: Date) {
  return d.toISOString().slice(0, 10);
}

function isToday(d: Date) {
  const t = new Date();
  return d.getDate() === t.getDate() && d.getMonth() === t.getMonth() && d.getFullYear() === t.getFullYear();
}

function isSameDay(d: Date, ref: Date) {
  return d.getDate() === ref.getDate() && d.getMonth() === ref.getMonth() && d.getFullYear() === ref.getFullYear();
}

function fmtRemaining(ms: number) {
  if (ms <= 0) return '00:00';
  const s = Math.floor(ms / 1000);
  return `${Math.floor(s / 60).toString().padStart(2, '0')}:${(s % 60).toString().padStart(2, '0')}`;
}

function semStyle(ms: number) {
  if (ms <= 0) return { bg: '#fff1f0', text: '#cf1322', border: '#ffa39e', accent: '#ef4444', label: 'VENCIDO' };
  if (ms <= 2 * 60000) return { bg: '#fff1f0', text: '#cf1322', border: '#ffa39e', accent: '#ef4444', label: 'URGENTE' };
  if (ms <= 5 * 60000) return { bg: '#fffbe6', text: '#d46b08', border: '#ffe58f', accent: '#f59e0b', label: 'ATENCIÓN' };
  return { bg: '#f6ffed', text: '#389e0d', border: '#b7eb8f', accent: '#16a34a', label: 'A TIEMPO' };
}

function estadoStyle(estado?: EstadoSolicitud) {
  switch (estado) {
    case 'en_camino_retiro': return { bg: '#fffbe6', text: '#d46b08', border: '#ffe58f', accent: '#f59e0b' };
    case 'retirado': return { bg: '#e6f4ff', text: '#0958d9', border: '#91caff', accent: '#2563eb' };
    case 'en_camino_entrega': return { bg: '#f9f0ff', text: '#531dab', border: '#d3adf7', accent: '#7c3aed' };
    case 'entregado': return { bg: '#f6ffed', text: '#389e0d', border: '#b7eb8f', accent: '#16a34a' };
    default: return { bg: '#f5f5f5', text: '#595959', border: '#d9d9d9', accent: '#9ca3af' };
  }
}

function estadoTexto(e?: EstadoSolicitud) {
  const m: Record<string, string> = {
    asignada: 'Nueva orden', en_camino_retiro: 'Yendo a retiro',
    retirado: 'Paquete retirado', en_camino_entrega: 'En camino a entrega', entregado: 'Entregado ✓',
  };
  return m[e || ''] || e || '-';
}

function nextActions(e?: EstadoSolicitud): EstadoSolicitud[] {
  if (e === 'asignada') return ['en_camino_retiro'];
  if (e === 'en_camino_retiro') return ['retirado'];
  if (e === 'retirado') return ['en_camino_entrega'];
  if (e === 'en_camino_entrega') return ['entregado'];
  return [];
}

function actionLabel(e: EstadoSolicitud) {
  const m: Record<string, string> = {
    en_camino_retiro: '🛵 Voy al retiro', retirado: '📦 Paquete recogido',
    en_camino_entrega: '🚀 Voy a entregar', entregado: '✅ Marcar como entregado',
  };
  return m[e] || e;
}

function sortDesc(arr: Solicitud[], field: keyof Solicitud = 'createdAt') {
  return [...arr].sort((a, b) => (tsToDate(b[field])?.getTime() || 0) - (tsToDate(a[field])?.getTime() || 0));
}

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

// ─── Deposit calculation ──────────────────────────────────────────────────────
// Returns what the motorizado collected and where it should go.
type DepositoInfo = {
  tieneProducto: boolean;
  montoProducto: number;       // → depositar al comercio
  tieneDelivery: boolean;
  montoDelivery: number;       // → depositar a Storkhub
  deliveryPorTransferencia: boolean; // → si true, delivery ya pagado, depositar todo al comercio
  totalAlComercio: number;
  totalAStorkhub: number;
  descripcion: string;
};

function calcDeposito(s: Solicitud): DepositoInfo {
  const ceAplica = !!s.cobroContraEntrega?.aplica;
  const montoProducto = ceAplica ? (s.cobroContraEntrega?.monto || 0) : 0;
  const precioDelivery = s.confirmacion?.precioFinalCordobas || 0;
  const quienPaga = s.pagoDelivery?.quienPaga || '';
  const deducir = !!s.pagoDelivery?.deducirDelCobroContraEntrega;
  const esPorTransferencia = quienPaga === 'transferencia';
  const esCredito = s.tipoCliente === 'credito' || quienPaga === 'credito_semanal';

  // Si el motorizado declaró no haber recibido (y no es un defer), excluir del depósito
  const deliveryNoRecibido =
    s.cobrosMotorizado?.delivery?.recibio === false &&
    s.cobrosMotorizado?.delivery?.justificacion !== 'Se acordó cobrar en la entrega';
  const productoNoRecibido = s.cobrosMotorizado?.producto?.recibio === false;

  // Delivery: el motorizado lo recauda en efectivo solo si quienPaga es recoleccion o entrega
  const motorizadoRecaudeDelivery = !esPorTransferencia && !esCredito && precioDelivery > 0 && !deliveryNoRecibido;
  const montoDelivery = motorizadoRecaudeDelivery ? precioDelivery : 0;

  // Si el delivery se deduce del cobro CE: el motorizado entrega al comercio (producto - delivery)
  const productoNeto = deducir ? Math.max(0, montoProducto - precioDelivery) : montoProducto;

  // Total al comercio = producto neto (cobro CE)
  // Si delivery fue por transferencia, el motorizado solo deposita el producto al comercio
  const totalAlComercio = productoNeto;
  // Total a Storkhub = delivery en efectivo (si aplica)
  const totalAStorkhub = esPorTransferencia ? 0 : (esCredito ? 0 : montoDelivery);

  // Descripción legible
  let partes: string[] = [];
  if (ceAplica) partes.push(`Cobró producto C$${montoProducto}`);
  if (motorizadoRecaudeDelivery) partes.push(`Cobró delivery C$${precioDelivery}`);
  if (deducir) partes.push(`Dedujo delivery del CE`);
  if (esPorTransferencia) partes.push(`Delivery ya pagado por transferencia`);
  if (esCredito) partes.push(`Delivery en crédito semanal`);
  if (!ceAplica && !motorizadoRecaudeDelivery) partes.push(`No recaudó efectivo`);

  return {
    tieneProducto: ceAplica && !productoNoRecibido,
    montoProducto,
    tieneDelivery: motorizadoRecaudeDelivery,
    montoDelivery,
    deliveryPorTransferencia: esPorTransferencia,
    totalAlComercio,
    totalAStorkhub,
    descripcion: partes.join(' · '),
  };
}

// ─── Component ───────────────────────────────────────────────────────────────

export default function PanelMotorizadoPage() {
  const [user, setUser] = useState<User | null>(null);
  const [ordenes, setOrdenes] = useState<Solicitud[]>([]);
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState<string | null>(null);
  const [actionId, setActionId] = useState<string | null>(null);
  const [tick, setTick] = useState(Date.now());
  const [tab, setTab] = useState<'pendientes' | 'en_curso' | 'historial' | 'depositos'>('pendientes');
  const [pendingConfirm, setPendingConfirm] = useState<PendingConfirm | null>(null);
  const [photoGate, setPhotoGate] = useState<{ solicitudId: string; tipo: TipoEvidencia; order: Solicitud; nextEstado: EstadoSolicitud | null } | null>(null);
  const [photoFile, setPhotoFile] = useState<File | null>(null);
  const [photoUploading, setPhotoUploading] = useState(false);
  const [photoSuccess, setPhotoSuccess] = useState(false);
  const [photoErr, setPhotoErr] = useState<string | null>(null);

  // Motorizado doc (estado propio)
  const [motorizadoDocId, setMotorizadoDocId] = useState<string | null>(null);
  const [motorizadoEstado, setMotorizadoEstado] = useState<'disponible' | 'ocupado' | 'inactivo' | null>(null);
  const [toggling, setToggling] = useState(false);

  // Historial filters
  const [histFecha, setHistFecha] = useState<'hoy' | 'ayer' | 'personalizado'>('hoy');
  const [histDesde, setHistDesde] = useState(fmtDateInput(new Date()));

  useEffect(() => { const id = setInterval(() => setTick(Date.now()), 1000); return () => clearInterval(id); }, []);
  useEffect(() => {
    return onAuthStateChanged(auth, (u) => { setUser(u); setLoading(false); });
  }, []);

  const cargar = useCallback(() => {
    const u = auth.currentUser;
    if (!u) { setOrdenes([]); return () => {}; }
    setErr(null);
    const q = query(collection(db, 'solicitudes_envio'), where('asignacion.motorizadoAuthUid', '==', u.uid));
    return onSnapshot(q,
      (s) => { setOrdenes(s.docs.map((d) => ({ id: d.id, ...(d.data() as any) }))); setErr(null); },
      (e) => { console.error(e); setErr('Error cargando órdenes.'); }
    );
  }, []);

  useEffect(() => {
    if (!user) {
      setMotorizadoDocId(null);
      setMotorizadoEstado(null);
      return;
    }
    const q = query(collection(db, 'motorizado'), where('authUid', '==', user.uid), limit(1));
    const unsub = onSnapshot(q, (s) => {
      if (!s.empty) {
        const d = s.docs[0];
        setMotorizadoDocId(d.id);
        setMotorizadoEstado((d.data() as any).estado ?? 'inactivo');
      }
    });
    return () => unsub();
  }, [user?.uid]);

  useEffect(() => {
    if (!user) { setOrdenes([]); return; }
    const unsub = cargar();
    return () => { if (typeof unsub === 'function') unsub(); };
  }, [user, cargar]);

  async function aceptar(o: Solicitud) {
    if (!o.id) return;
    setErr(null); setActionId(o.id);
    try {
      const b = writeBatch(db);
      b.update(doc(db, 'solicitudes_envio', o.id), { 'asignacion.estadoAceptacion': 'aceptada', 'asignacion.aceptadoAt': serverTimestamp(), updatedAt: serverTimestamp() });
      if (o.asignacion?.motorizadoId) b.update(doc(db, 'motorizado', o.asignacion.motorizadoId), { estado: 'ocupado', updatedAt: serverTimestamp() });
      await b.commit();
    } catch (e) { console.error(e); setErr('No se pudo aceptar.'); }
    finally { setActionId(null); }
  }

  async function rechazar(o: Solicitud) {
    if (!o.id) return;
    setErr(null); setActionId(o.id);
    try {
      const b = writeBatch(db);
      b.update(doc(db, 'solicitudes_envio', o.id), { estado: 'confirmada', asignacion: null, updatedAt: serverTimestamp() });
      if (o.asignacion?.motorizadoId) b.update(doc(db, 'motorizado', o.asignacion.motorizadoId), { estado: 'disponible', updatedAt: serverTimestamp() });
      await b.commit();
    } catch (e) { console.error(e); setErr('No se pudo rechazar.'); }
    finally { setActionId(null); }
  }

  async function toggleActivarse() {
    if (!motorizadoDocId || toggling) return;
    if (motorizadoEstado === 'ocupado') return;
    setToggling(true);
    try {
      const nuevoEstado = motorizadoEstado === 'disponible' ? 'inactivo' : 'disponible';
      await updateDoc(doc(db, 'motorizado', motorizadoDocId), { estado: nuevoEstado, updatedAt: serverTimestamp() });
    } catch (e) { console.error(e); }
    finally { setToggling(false); }
  }

  async function executeCambiar(
    o: Solicitud,
    nuevo: EstadoSolicitud,
    cobros?: { delivery?: { monto: number; recibio: boolean; justificacion?: string }; producto?: { monto: number; recibio: boolean; justificacion?: string } }
  ) {
    if (!o.id) return;
    setErr(null); setActionId(`${o.id}:${nuevo}`);
    try {
      const p: any = { estado: nuevo, updatedAt: serverTimestamp(), [`historial.${nuevo}At`]: serverTimestamp() };
      if (nuevo === 'entregado') p.entregadoAt = serverTimestamp();
      let hayPendiente = false;
      if (cobros) {
        if (cobros.delivery) {
          const rec = { monto: cobros.delivery.monto, recibio: cobros.delivery.recibio, at: serverTimestamp(), ...(cobros.delivery.justificacion ? { justificacion: cobros.delivery.justificacion } : {}) };
          p['cobrosMotorizado.delivery'] = rec;
          if (!cobros.delivery.recibio) hayPendiente = true;
        }
        if (cobros.producto) {
          const rec = { monto: cobros.producto.monto, recibio: cobros.producto.recibio, at: serverTimestamp(), ...(cobros.producto.justificacion ? { justificacion: cobros.producto.justificacion } : {}) };
          p['cobrosMotorizado.producto'] = rec;
          if (!cobros.producto.recibio) hayPendiente = true;
        }
      }
      if (hayPendiente) p.cobroPendiente = true;

      // ── Defer delivery a entrega ──────────────────────────────────────────
      if (cobros?.delivery?.justificacion === 'Se acordó cobrar en la entrega') {
        p['pagoDelivery.quienPaga'] = 'entrega';
      }

      // ── Al entregar: registrar cobroDelivery ──────────────────────────────
      if (nuevo === 'entregado') {
        const precioDelivery = o.confirmacion?.precioFinalCordobas ?? 0
        const quienPaga = o.pagoDelivery?.quienPaga ?? ''
        const esCredito = o.tipoCliente === 'credito' || quienPaga === 'credito_semanal'
        const semanaKey = esCredito ? getSemanaKey(new Date()) : undefined

        p['cobroDelivery'] = {
          monto: precioDelivery,
          tipoCliente: esCredito ? 'credito' : 'contado',
          quienPaga,
          estado: precioDelivery === 0 ? 'no_cobrar' : 'pendiente',
          registradoAt: serverTimestamp(),
          ...(semanaKey ? { semanaKey } : {}),
        }

        // Para crédito con monto > 0: upsert atómico en cobros_semanales
        if (esCredito && precioDelivery > 0) {
          const uid = (o.ownerSnapshot as any)?.uid || o.userId || ''
          const clienteNombre = o.ownerSnapshot?.nombre ?? ''
          const clienteCompany = o.ownerSnapshot?.companyName ?? ''
          const motorizadoId = o.asignacion?.motorizadoId
          const semanaRef = doc(db, 'cobros_semanales', `${uid}_${semanaKey}`)

          await runTransaction(db, async (tx) => {
            const semanaSnap = await tx.get(semanaRef)
            tx.update(doc(db, 'solicitudes_envio', o.id), p)
            if (motorizadoId) tx.update(doc(db, 'motorizado', motorizadoId), { estado: 'disponible', updatedAt: serverTimestamp() })
            if (!semanaSnap.exists()) {
              const { inicio, fin } = getSemanaRange(semanaKey!)
              tx.set(semanaRef, {
                clienteUid: uid,
                clienteNombre,
                clienteCompany,
                semanaKey: semanaKey!,
                semanaInicio: Timestamp.fromDate(inicio),
                semanaFin: Timestamp.fromDate(fin),
                totalMonto: precioDelivery,
                totalPagado: 0,
                estado: 'pendiente',
                pagos: [],
                ordenesIds: [o.id],
                creadoAt: serverTimestamp(),
                updatedAt: serverTimestamp(),
              })
            } else {
              tx.update(semanaRef, {
                totalMonto: increment(precioDelivery),
                ordenesIds: arrayUnion(o.id),
                updatedAt: serverTimestamp(),
              })
            }
          })
          return
        }
      }
      // ─────────────────────────────────────────────────────────────────────

      const b = writeBatch(db);
      b.update(doc(db, 'solicitudes_envio', o.id), p);
      if (o.asignacion?.motorizadoId) b.update(doc(db, 'motorizado', o.asignacion.motorizadoId), { estado: nuevo === 'entregado' ? 'disponible' : 'ocupado', updatedAt: serverTimestamp() });
      await b.commit();
    } catch (e) { console.error(e); setErr('No se pudo cambiar.'); }
    finally { setActionId(null); }
  }

  function cambiar(o: Solicitud, nuevo: EstadoSolicitud) {
    if (nuevo === 'retirado' && !o.evidencias?.retiro) {
      setPhotoFile(null); setPhotoErr(null);
      setPhotoGate({ solicitudId: o.id, tipo: 'retiro', order: o, nextEstado: nuevo });
      return;
    }
    if (nuevo === 'entregado' && !o.evidencias?.entrega) {
      setPhotoFile(null); setPhotoErr(null);
      setPhotoGate({ solicitudId: o.id, tipo: 'entrega', order: o, nextEstado: nuevo });
      return;
    }
    const dep = calcDeposito(o);
    const tipo = o.pagoDelivery?.tipo || '';
    const quienPaga = o.pagoDelivery?.quienPaga || '';
    const esRetiro = quienPaga === 'recoleccion';

    const showDelivery =
      dep.tieneDelivery &&
      ((nuevo === 'retirado' && esRetiro) || (nuevo === 'entregado' && !esRetiro));
    const showProducto = nuevo === 'entregado' && dep.tieneProducto;

    if (!showDelivery && !showProducto) {
      executeCambiar(o, nuevo);
      return;
    }

    setPendingConfirm({
      order: o,
      nuevo,
      esRetiro,
      showDelivery,
      showProducto,
      montoDelivery: dep.montoDelivery,
      montoProducto: dep.montoProducto,
      recibioDelivery: true,
      recibioProducto: true,
      justDelivery: '',
      justProducto: '',
    });
  }

  const todas = useMemo(() => (!user ? [] : sortDesc(ordenes)), [ordenes, user]);

  const pendientes = useMemo(() =>
    todas.filter((o) => o.estado === 'asignada' && o.asignacion?.estadoAceptacion === 'pendiente')
      .map((o) => {
        const dl = tsToDate(o.asignacion?.aceptarAntesDe);
        return { ...o, ms: dl ? dl.getTime() - tick : 0 };
      }), [todas, tick]);

  const enCurso = useMemo(() => {
    const urgencyRank = (e?: string) => {
      if (e === 'en_camino_entrega') return 1;
      if (e === 'retirado') return 2;
      if (e === 'en_camino_retiro') return 3;
      return 4;
    };
    return todas
      .filter((o) => o.asignacion?.estadoAceptacion === 'aceptada' && ['asignada', 'en_camino_retiro', 'retirado', 'en_camino_entrega'].includes(o.estado || ''))
      .sort((a, b) => urgencyRank(a.estado) - urgencyRank(b.estado));
  }, [todas]);

  const entregadas = useMemo(() => sortDesc(todas.filter((o) => o.estado === 'entregado'), 'entregadoAt'), [todas]);

  // Historial filtered by date
  const historialFiltrado = useMemo(() => {
    const refDate = histFecha === 'personalizado'
      ? new Date(histDesde + 'T00:00:00')
      : histFecha === 'ayer'
        ? (() => { const d = new Date(); d.setDate(d.getDate() - 1); return d; })()
        : new Date();
    return entregadas.filter((o) => {
      const d = tsToDate(o.entregadoAt) || tsToDate(o.updatedAt);
      return d && isSameDay(d, refDate);
    });
  }, [entregadas, histFecha, histDesde]);

  // Depósitos: all delivered orders with pending deposits (not yet confirmed by motorizado)
  const depositosPendientes = useMemo(() =>
    entregadas.filter((o) => {
      const dep = calcDeposito(o);
      if (dep.totalAlComercio === 0 && dep.totalAStorkhub === 0) return false;
      // Compatibilidad con flag viejo
      if (o.registro?.deposito?.confirmadoMotorizado) return false;
      // Nuevos flags separados
      const comercioOk = dep.totalAlComercio === 0 || !!o.registro?.deposito?.confirmadoComercio;
      const storkhubOk = dep.totalAStorkhub === 0 || !!o.registro?.deposito?.confirmadoStorkhub;
      return !comercioOk || !storkhubOk;
    }), [entregadas]);

  const resumenDepositos = useMemo(() => {
    let alComercio = 0, aStorkhub = 0;
    depositosPendientes.forEach((o) => {
      const d = calcDeposito(o);
      alComercio += d.totalAlComercio;
      aStorkhub += d.totalAStorkhub;
    });
    return { alComercio, aStorkhub, total: alComercio + aStorkhub };
  }, [depositosPendientes]);

  // Load comercio bank accounts and names for deposit orders
  const [comercioAccounts, setComercioAccounts] = useState<Record<string, BankAccount[]>>({});
  const [comercioNames, setComercioNames] = useState<Record<string, string>>({});
  // Group-level boucher state: key = '__storkhub' | comercio userId
  const [groupBoucher, setGroupBoucher] = useState<Record<string, File | null>>({});
  const [activeGroupKey, setActiveGroupKey] = useState<string | null>(null);
  const groupBoucherRef = useRef<HTMLInputElement>(null);
  const depositoUidsKey = depositosPendientes.map((o) => o.userId || '').join(',');

  // ── Grupos de depósito ────────────────────────────────────────────────────
  type GrupoComercio = { uid: string; nombre: string; orders: Solicitud[]; total: number; accounts: BankAccount[] }
  type GrupoStorkhub = { orders: Solicitud[]; total: number }

  const gruposDeposito = useMemo(() => {
    const storkhub: GrupoStorkhub = { orders: [], total: 0 }
    const comerciosMap: Record<string, GrupoComercio> = {}

    depositosPendientes.forEach((o) => {
      const dep = calcDeposito(o)
      if (dep.totalAStorkhub > 0 && !o.registro?.deposito?.confirmadoStorkhub) {
        storkhub.orders.push(o)
        storkhub.total += dep.totalAStorkhub
      }
      if (dep.totalAlComercio > 0 && !o.registro?.deposito?.confirmadoComercio) {
        const uid = o.userId || '__sin'
        if (!comerciosMap[uid]) {
          const nombre = o.ownerSnapshot?.companyName || o.ownerSnapshot?.nombre || comercioNames[uid] || uid.slice(0, 8)
          comerciosMap[uid] = { uid, nombre, orders: [], total: 0, accounts: comercioAccounts[uid] || [] }
        }
        comerciosMap[uid].orders.push(o)
        comerciosMap[uid].total += dep.totalAlComercio
        if (comercioAccounts[uid]) comerciosMap[uid].accounts = comercioAccounts[uid]
      }
    })
    return { storkhub, comercios: Object.values(comerciosMap) }
  }, [depositosPendientes, comercioAccounts, comercioNames]);

  const [expandidos, setExpandidos] = useState<Record<string, boolean>>({})
  const toggleExpandido = (key: string) => setExpandidos((p) => ({ ...p, [key]: !p[key] }))

  useEffect(() => { if (pendientes.length > 0) setTab('pendientes'); }, [pendientes.length]);
  useEffect(() => {
    const uids = [...new Set(depositosPendientes.map((o) => o.userId).filter(Boolean))] as string[];
    if (uids.length === 0) return;
    // Only fetch UIDs not yet loaded
    const missing = uids.filter((uid) => !(uid in comercioAccounts));
    if (missing.length === 0) return;
    Promise.all(missing.map((uid) => getDoc(doc(db, 'comercios', uid)))).then((snaps) => {
      const accountMap: Record<string, BankAccount[]> = {};
      const nameMap: Record<string, string> = {};
      snaps.forEach((snap, i) => {
        const data = snap.exists() ? (snap.data() as any) : null;
        accountMap[missing[i]] = Array.isArray(data?.accounts) ? (data.accounts as BankAccount[]) : [];
        nameMap[missing[i]] = data?.name || data?.nombre || '';
      });
      setComercioAccounts((prev) => ({ ...prev, ...accountMap }));
      setComercioNames((prev) => ({ ...prev, ...nameMap }));
    });
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [depositoUidsKey]);

  if (loading) return (
    <div style={{ minHeight: '100vh', background: '#f9fafb', display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', gap: 12 }}>
      <div style={{ width: 36, height: 36, border: '3px solid #e5e7eb', borderTop: '3px solid #004aad', borderRadius: '50%' }} />
      <p style={{ color: '#6b7280', fontSize: 14, margin: 0 }}>Cargando tu panel...</p>
    </div>
  );

  if (!user) return (
    <div style={{ minHeight: '100vh', background: '#f9fafb', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
      <p style={{ color: '#111827', fontSize: 16, fontWeight: 600 }}>Debes iniciar sesión</p>
    </div>
  );

  return (
    <div style={{ minHeight: '100vh', background: '#f9fafb', fontFamily: "'SF Pro Display', -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif", maxWidth: 520, margin: '0 auto', paddingBottom: 80 }}>

      {/* Header */}
      <div style={{ background: '#fff', borderBottom: '1px solid #e5e7eb', padding: '12px 16px 12px' }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 12 }}>
          <span style={{ fontSize: 15, fontWeight: 700, color: '#374151' }}>Motorizado</span>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            {/* Badge de estado */}
            {motorizadoEstado === 'disponible' && (
              <div style={{ display: 'flex', alignItems: 'center', gap: 6, background: '#f0fdf4', border: '1px solid #bbf7d0', borderRadius: 20, padding: '5px 10px' }}>
                <span style={{ width: 7, height: 7, borderRadius: '50%', background: '#16a34a', display: 'inline-block' }} />
                <span style={{ fontSize: 12, color: '#16a34a', fontWeight: 600 }}>En línea</span>
              </div>
            )}
            {motorizadoEstado === 'ocupado' && (
              <div style={{ display: 'flex', alignItems: 'center', gap: 6, background: '#fffbeb', border: '1px solid #fde68a', borderRadius: 20, padding: '5px 10px' }}>
                <span style={{ width: 7, height: 7, borderRadius: '50%', background: '#d97706', display: 'inline-block' }} />
                <span style={{ fontSize: 12, color: '#d97706', fontWeight: 600 }}>En turno</span>
              </div>
            )}
            {(motorizadoEstado === 'inactivo' || motorizadoEstado === null) && (
              <div style={{ display: 'flex', alignItems: 'center', gap: 6, background: '#f3f4f6', border: '1px solid #d1d5db', borderRadius: 20, padding: '5px 10px' }}>
                <span style={{ width: 7, height: 7, borderRadius: '50%', background: '#9ca3af', display: 'inline-block' }} />
                <span style={{ fontSize: 12, color: '#6b7280', fontWeight: 600 }}>Fuera de línea</span>
              </div>
            )}
            {/* Botón toggle */}
            {motorizadoEstado !== 'ocupado' && (
              <button
                onClick={toggleActivarse}
                disabled={toggling || !motorizadoDocId}
                style={{
                  fontSize: 12, fontWeight: 600, borderRadius: 20, padding: '5px 12px', border: 'none',
                  cursor: toggling || !motorizadoDocId ? 'not-allowed' : 'pointer',
                  opacity: toggling || !motorizadoDocId ? 0.6 : 1,
                  background: motorizadoEstado === 'disponible' ? '#e5e7eb' : '#004aad',
                  color: motorizadoEstado === 'disponible' ? '#374151' : '#fff',
                  transition: 'opacity 0.15s',
                }}
              >
                {motorizadoEstado === 'disponible' ? 'Desactivarme' : 'Activarme'}
              </button>
            )}
          </div>
        </div>
        <div style={{ display: 'flex', gap: 10 }}>
          <StatCard label="Nuevas" value={pendientes.length} color={pendientes.length > 0 ? '#d97706' : '#6b7280'} bg={pendientes.length > 0 ? '#fffbeb' : '#f9fafb'} border={pendientes.length > 0 ? '#fde68a' : '#e5e7eb'} />
          <StatCard label="En curso" value={enCurso.length} color={enCurso.length > 0 ? '#2563eb' : '#6b7280'} bg={enCurso.length > 0 ? '#eff6ff' : '#f9fafb'} border={enCurso.length > 0 ? '#bfdbfe' : '#e5e7eb'} />
          <StatCard label="Hoy" value={historialFiltrado.length} color="#16a34a" bg="#f0fdf4" border="#bbf7d0" />
          <StatCard label="Depósitos" value={depositosPendientes.length} color={depositosPendientes.length > 0 ? '#7c3aed' : '#6b7280'} bg={depositosPendientes.length > 0 ? '#f5f3ff' : '#f9fafb'} border={depositosPendientes.length > 0 ? '#ddd6fe' : '#e5e7eb'} />
        </div>
      </div>

      {err && <div style={{ margin: '12px 16px 0', background: '#fef2f2', border: '1px solid #fecaca', borderRadius: 12, padding: '10px 14px', color: '#dc2626', fontSize: 13 }}>⚠️ {err}</div>}

      <div style={{ padding: '16px 16px 0' }}>

        {/* ── PENDIENTES ── */}
        {tab === 'pendientes' && (
          <>
            {pendientes.length === 0
              ? <EmptyState icon="🔕" title="Sin órdenes nuevas" subtitle="Cuando el gestor te asigne una orden aparecerá aquí" />
              : (pendientes as any[]).map((o) => {
                const sem = semStyle(o.ms);
                const isLoading = actionId === o.id;
                const dep = calcDeposito(o);
                return (
                  <div key={o.id} style={card}>
                    <div style={{ height: 4, background: sem.accent }} />
                    <div style={{ padding: '14px 16px 0' }}>
                      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 12 }}>
                        <div style={{ display: 'flex', alignItems: 'center', gap: 8, background: sem.bg, border: `1px solid ${sem.border}`, borderRadius: 10, padding: '8px 14px' }}>
                          <span>⏱</span>
                          <span style={{ fontSize: 22, fontWeight: 900, color: sem.text, letterSpacing: -1 }}>{fmtRemaining(o.ms)}</span>
                          <span style={{ fontSize: 11, fontWeight: 800, color: sem.text }}>{sem.label}</span>
                        </div>
                        <span style={{ fontSize: 11, color: '#9ca3af', fontFamily: 'monospace' }}>#{o.id.slice(0, 8)}</span>
                      </div>

                      {/* Price + deposit preview */}
                      <CobroBox o={o} dep={dep} />

                      <PaqueteBadge paquete={o.paquete} />
                      <RoutePoint type="pickup" point={o.recoleccion} fallbackName={o.cliente?.nombre} retiroCoord={o.cotizacion?.origenCoord} />
                      <div style={{ width: 2, height: 18, background: '#e5e7eb', marginLeft: 13, marginTop: 3, marginBottom: 3 }} />
                      <RoutePoint type="dropoff" point={o.entrega} entregaCoord={o.cotizacion?.destinoCoord} />
                    </div>
                    <div style={{ display: 'flex', gap: 10, padding: 16 }}>
                      <button onClick={() => rechazar(o)} disabled={isLoading} style={btnSecondary}>✕ Rechazar</button>
                      <button onClick={() => aceptar(o)} disabled={isLoading} style={btnPrimary}>{isLoading ? 'Procesando...' : '✓ Aceptar orden'}</button>
                    </div>
                  </div>
                );
              })}
          </>
        )}

        {/* ── EN CURSO ── */}
        {tab === 'en_curso' && (
          <>
            {enCurso.length === 0
              ? <EmptyState icon="🛵" title="Sin órdenes en curso" subtitle="Acepta una nueva orden para verla aquí" />
              : <>
                {enCurso.length >= 2 && (
                  <div style={{ background: '#fffbeb', border: '1px solid #fde68a', borderRadius: 14, padding: '10px 14px', marginBottom: 12, display: 'flex', alignItems: 'center', gap: 8 }}>
                    <span style={{ fontSize: 16 }}>⚠️</span>
                    <span style={{ fontSize: 13, fontWeight: 700, color: '#92400e' }}>{enCurso.length} órdenes activas — atendé la primera primero</span>
                  </div>
                )}
                {enCurso.map((o, idx) => {
                const actions = nextActions(o.estado);
                const est = estadoStyle(o.estado);
                const dep = calcDeposito(o);
                const isPriority = idx === 0 && enCurso.length >= 2;
                return (
                  <div key={o.id} style={{ ...card, ...(isPriority ? { borderLeft: '4px solid #004aad', borderRadius: '0 20px 20px 0' } : {}) }}>
                    <div style={{ height: 4, background: est.accent }} />
                    <div style={{ padding: '14px 16px 0' }}>
                      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 12 }}>
                        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                          <div style={{ background: est.bg, border: `1px solid ${est.border}`, borderRadius: 10, padding: '8px 14px' }}>
                            <span style={{ color: est.text, fontWeight: 700, fontSize: 13 }}>{estadoTexto(o.estado)}</span>
                          </div>
                          {isPriority && (
                            <span style={{ fontSize: 10, fontWeight: 800, color: '#fff', background: '#004aad', borderRadius: 6, padding: '3px 7px', textTransform: 'uppercase', letterSpacing: 0.5 }}>Prioritaria</span>
                          )}
                        </div>
                        <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'flex-end', gap: 2 }}>
                          {enCurso.length >= 2 && (
                            <span style={{ fontSize: 10, fontWeight: 700, color: '#9ca3af', textTransform: 'uppercase', letterSpacing: 0.5 }}>Orden {idx + 1} de {enCurso.length}</span>
                          )}
                          <span style={{ fontSize: 11, color: '#9ca3af', fontFamily: 'monospace' }}>#{o.id.slice(0, 8)}</span>
                        </div>
                      </div>

                      <CobroBox o={o} dep={dep} />

                      <PaqueteBadge paquete={o.paquete} />
                      <RoutePoint type="pickup" point={o.recoleccion} fallbackName={o.cliente?.nombre} retiroCoord={o.cotizacion?.origenCoord} />
                      <div style={{ width: 2, height: 18, background: '#e5e7eb', marginLeft: 13, marginTop: 3, marginBottom: 3 }} />
                      <RoutePoint type="dropoff" point={o.entrega} entregaCoord={o.cotizacion?.destinoCoord} />

                      {pendingConfirm?.order.id === o.id ? (
                        /* ── Confirmación de cobro ── */
                        (() => {
                          const pc = pendingConfirm;
                          const RAZONES_DELIVERY_RETIRO = ['Se acordó cobrar en la entrega', 'Comercio ya pagó por transferencia', 'El comercio tiene crédito / cobrará luego', 'Error en el monto acordado', 'Otro'];
                          const RAZONES_DELIVERY_ENTREGA = ['El cliente no estaba / no atendió', 'El cliente no tenía efectivo', 'El cliente rechazó el producto', 'Error en el monto acordado', 'Otro'];
                          const RAZONES_PRODUCTO = ['El cliente no estaba / no atendió', 'El cliente no tenía efectivo', 'El cliente rechazó el producto', 'Error en el monto acordado', 'Otro'];
                          const razonesList = pc.esRetiro ? RAZONES_DELIVERY_RETIRO : RAZONES_DELIVERY_ENTREGA;
                          const bloqueadoDelivery = pc.showDelivery && !pc.recibioDelivery && !pc.justDelivery.trim();
                          const bloqueadoProducto = pc.showProducto && !pc.recibioProducto && !pc.justProducto.trim();
                          const bloqueado = !!actionId || bloqueadoDelivery || bloqueadoProducto;
                          return (
                            <div style={{ background: '#f0fdf4', border: '1px solid #bbf7d0', borderRadius: 14, padding: '14px 16px', margin: '14px 0 16px' }}>
                              <p style={{ fontSize: 13, fontWeight: 800, color: '#15803d', margin: '0 0 12px' }}>💰 Confirmar cobro</p>

                              {pc.showDelivery && (
                                <div style={{ marginBottom: 14 }}>
                                  <p style={{ fontSize: 13, color: '#374151', fontWeight: 600, margin: '0 0 8px' }}>
                                    ¿Recibiste {fmt(pc.montoDelivery)} de delivery?
                                  </p>
                                  <div style={{ display: 'flex', gap: 8, marginBottom: 8 }}>
                                    <button onClick={() => setPendingConfirm((p) => p ? { ...p, recibioDelivery: true, justDelivery: '' } : p)}
                                      style={{ flex: 1, padding: '9px 0', borderRadius: 10, border: `2px solid ${pc.recibioDelivery ? '#16a34a' : '#e5e7eb'}`, background: pc.recibioDelivery ? '#16a34a' : '#fff', color: pc.recibioDelivery ? '#fff' : '#6b7280', fontSize: 13, fontWeight: 700, cursor: 'pointer' }}>
                                      ✅ Sí, recibí
                                    </button>
                                    <button onClick={() => setPendingConfirm((p) => p ? { ...p, recibioDelivery: false } : p)}
                                      style={{ flex: 1, padding: '9px 0', borderRadius: 10, border: `2px solid ${!pc.recibioDelivery ? '#dc2626' : '#e5e7eb'}`, background: !pc.recibioDelivery ? '#fee2e2' : '#fff', color: !pc.recibioDelivery ? '#dc2626' : '#6b7280', fontSize: 13, fontWeight: 700, cursor: 'pointer' }}>
                                      ❌ No recibí
                                    </button>
                                  </div>
                                  {!pc.recibioDelivery && (
                                    <div style={{ background: '#fff7ed', border: '1px solid #fed7aa', borderRadius: 10, padding: '10px 12px' }}>
                                      <p style={{ fontSize: 12, fontWeight: 700, color: '#c2410c', margin: '0 0 6px' }}>⚠️ Razón obligatoria</p>
                                      <select value={pc.justDelivery} onChange={(e) => setPendingConfirm((p) => p ? { ...p, justDelivery: e.target.value } : p)}
                                        style={{ width: '100%', padding: '8px 10px', borderRadius: 8, border: '1px solid #fed7aa', fontSize: 13, background: '#fff', outline: 'none', marginBottom: pc.justDelivery === 'Otro' ? 8 : 0 }}>
                                        <option value="">— Seleccionar razón —</option>
                                        {razonesList.map((r) => <option key={r} value={r}>{r}</option>)}
                                      </select>
                                      {pc.justDelivery === 'Otro' && (
                                        <textarea placeholder="Describe la situación…" value={pc.justDelivery === 'Otro' ? '' : pc.justDelivery}
                                          onChange={(e) => setPendingConfirm((p) => p ? { ...p, justDelivery: e.target.value || 'Otro' } : p)}
                                          style={{ width: '100%', padding: '8px 10px', borderRadius: 8, border: '1px solid #fed7aa', fontSize: 13, resize: 'none' as const, height: 64, outline: 'none', boxSizing: 'border-box' as const }} />
                                      )}
                                    </div>
                                  )}
                                </div>
                              )}

                              {pc.showProducto && (
                                <div style={{ marginBottom: 14 }}>
                                  <p style={{ fontSize: 13, color: '#374151', fontWeight: 600, margin: '0 0 8px' }}>
                                    ¿Recibiste {fmt(pc.montoProducto)} del producto?
                                  </p>
                                  <div style={{ display: 'flex', gap: 8, marginBottom: 8 }}>
                                    <button onClick={() => setPendingConfirm((p) => p ? { ...p, recibioProducto: true, justProducto: '' } : p)}
                                      style={{ flex: 1, padding: '9px 0', borderRadius: 10, border: `2px solid ${pc.recibioProducto ? '#16a34a' : '#e5e7eb'}`, background: pc.recibioProducto ? '#16a34a' : '#fff', color: pc.recibioProducto ? '#fff' : '#6b7280', fontSize: 13, fontWeight: 700, cursor: 'pointer' }}>
                                      ✅ Sí, recibí
                                    </button>
                                    <button onClick={() => setPendingConfirm((p) => p ? { ...p, recibioProducto: false } : p)}
                                      style={{ flex: 1, padding: '9px 0', borderRadius: 10, border: `2px solid ${!pc.recibioProducto ? '#dc2626' : '#e5e7eb'}`, background: !pc.recibioProducto ? '#fee2e2' : '#fff', color: !pc.recibioProducto ? '#dc2626' : '#6b7280', fontSize: 13, fontWeight: 700, cursor: 'pointer' }}>
                                      ❌ No recibí
                                    </button>
                                  </div>
                                  {!pc.recibioProducto && (
                                    <div style={{ background: '#fff7ed', border: '1px solid #fed7aa', borderRadius: 10, padding: '10px 12px' }}>
                                      <p style={{ fontSize: 12, fontWeight: 700, color: '#c2410c', margin: '0 0 6px' }}>⚠️ Razón obligatoria</p>
                                      <select value={pc.justProducto} onChange={(e) => setPendingConfirm((p) => p ? { ...p, justProducto: e.target.value } : p)}
                                        style={{ width: '100%', padding: '8px 10px', borderRadius: 8, border: '1px solid #fed7aa', fontSize: 13, background: '#fff', outline: 'none', marginBottom: pc.justProducto === 'Otro' ? 8 : 0 }}>
                                        <option value="">— Seleccionar razón —</option>
                                        {RAZONES_PRODUCTO.map((r) => <option key={r} value={r}>{r}</option>)}
                                      </select>
                                      {pc.justProducto === 'Otro' && (
                                        <textarea placeholder="Describe la situación…"
                                          onChange={(e) => setPendingConfirm((p) => p ? { ...p, justProducto: e.target.value || 'Otro' } : p)}
                                          style={{ width: '100%', padding: '8px 10px', borderRadius: 8, border: '1px solid #fed7aa', fontSize: 13, resize: 'none' as const, height: 64, outline: 'none', boxSizing: 'border-box' as const }} />
                                      )}
                                    </div>
                                  )}
                                </div>
                              )}

                              <div style={{ display: 'flex', gap: 8, marginTop: 4 }}>
                                <button onClick={() => setPendingConfirm(null)}
                                  style={{ flexShrink: 0, background: '#fff', border: '1px solid #e5e7eb', borderRadius: 12, padding: '12px 16px', color: '#6b7280', fontSize: 13, fontWeight: 700, cursor: 'pointer' }}>
                                  Cancelar
                                </button>
                                <button
                                  disabled={bloqueado}
                                  onClick={() => {
                                    setPendingConfirm(null);
                                    executeCambiar(pc.order, pc.nuevo, {
                                      delivery: pc.showDelivery ? { monto: pc.montoDelivery, recibio: pc.recibioDelivery, justificacion: !pc.recibioDelivery ? pc.justDelivery : undefined } : undefined,
                                      producto: pc.showProducto ? { monto: pc.montoProducto, recibio: pc.recibioProducto, justificacion: !pc.recibioProducto ? pc.justProducto : undefined } : undefined,
                                    });
                                  }}
                                  style={{ flex: 1, background: bloqueado ? '#d1d5db' : '#16a34a', border: 'none', borderRadius: 12, padding: '12px 16px', color: '#fff', fontSize: 14, fontWeight: 800, cursor: bloqueado ? 'not-allowed' : 'pointer', transition: 'background 0.2s' }}>
                                  {actionId ? 'Guardando…' : bloqueadoDelivery || bloqueadoProducto ? 'Indica la razón para continuar' : 'Confirmar y avanzar →'}
                                </button>
                              </div>
                            </div>
                          );
                        })()
                      ) : (
                        <div style={{ display: 'flex', flexDirection: 'column' as const, gap: 8, padding: '14px 0 16px' }}>
                          {actions.map((a) => {
                            const lk = `${o.id}:${a}`;
                            return (
                              <button key={a} onClick={() => cambiar(o, a)} disabled={!!actionId} style={a === 'entregado' ? btnGreen : btnBlue}>
                                {actionId === lk ? 'Actualizando...' : actionLabel(a)}
                              </button>
                            );
                          })}
                        </div>
                      )}
                    </div>
                  </div>
                );
              })}
              </>
            }
          </>
        )}

        {/* ── HISTORIAL ── */}
        {tab === 'historial' && (
          <>
            {/* Date filter */}
            <div style={{ background: '#fff', border: '1px solid #e5e7eb', borderRadius: 14, padding: '14px 16px', marginBottom: 16, boxShadow: '0 1px 2px rgba(0,0,0,0.04)' }}>
              <p style={{ fontSize: 12, fontWeight: 700, color: '#374151', margin: '0 0 10px', textTransform: 'uppercase' as const, letterSpacing: 0.5 }}>Filtrar historial</p>
              <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' as const }}>
                {(['hoy', 'ayer', 'personalizado'] as const).map((f) => (
                  <button key={f} onClick={() => setHistFecha(f)} style={{ padding: '8px 14px', borderRadius: 10, border: `1px solid ${histFecha === f ? '#004aad' : '#e5e7eb'}`, background: histFecha === f ? '#004aad' : '#fff', color: histFecha === f ? '#fff' : '#374151', fontSize: 13, fontWeight: 600, cursor: 'pointer' }}>
                    {f === 'hoy' ? 'Hoy' : f === 'ayer' ? 'Ayer' : 'Fecha'}
                  </button>
                ))}
                {histFecha === 'personalizado' && (
                  <input type="date" value={histDesde} onChange={(e) => setHistDesde(e.target.value)} style={{ padding: '8px 12px', borderRadius: 10, border: '1px solid #e5e7eb', fontSize: 13, outline: 'none' }} />
                )}
              </div>
            </div>

            {historialFiltrado.length === 0
              ? <EmptyState icon="📋" title="Sin entregas en este período" subtitle="Cambia el filtro de fecha para ver otros días" />
              : (
                <>
                  {/* Day summary */}
                  <div style={{ background: '#f0fdf4', border: '1px solid #bbf7d0', borderRadius: 14, padding: '14px 16px', marginBottom: 16 }}>
                    <p style={{ fontSize: 12, fontWeight: 700, color: '#16a34a', margin: '0 0 6px', textTransform: 'uppercase' as const }}>Resumen del período</p>
                    <p style={{ fontSize: 24, fontWeight: 900, color: '#111827', margin: 0 }}>{historialFiltrado.length} entrega{historialFiltrado.length !== 1 ? 's' : ''}</p>
                    <p style={{ fontSize: 13, color: '#16a34a', margin: '4px 0 0' }}>
                      Total delivery: {fmt(historialFiltrado.reduce((s, o) => s + (o.confirmacion?.precioFinalCordobas || 0), 0))}
                    </p>
                  </div>

                  {historialFiltrado.map((o) => {
                    const dep = calcDeposito(o);
                    const comercioNombre = o.ownerSnapshot?.companyName || o.ownerSnapshot?.nombre || 'Comercio';
                    const rutaResumen = [o.recoleccion?.direccionEscrita, o.entrega?.direccionEscrita].filter(Boolean).join(' → ');
                    return (
                      <div key={o.id} style={{ background: '#fff', borderRadius: 16, marginBottom: 10, border: '1px solid #e5e7eb', overflow: 'hidden', boxShadow: '0 1px 2px rgba(0,0,0,0.04)' }}>
                        <div style={{ height: 3, background: '#16a34a' }} />
                        <div style={{ padding: '12px 14px' }}>
                          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start' }}>
                            <div style={{ flex: 1, minWidth: 0 }}>
                              {/* Comercio dueño de la orden */}
                              <p style={{ fontSize: 13, fontWeight: 800, color: '#111827', margin: '0 0 3px' }}>{comercioNombre}</p>
                              {/* Ruta resumida */}
                              {rutaResumen && (
                                <p style={{ fontSize: 11, color: '#6b7280', margin: '0 0 2px', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' as const }}>
                                  📍 {rutaResumen}
                                </p>
                              )}
                              {/* Destinatario */}
                              <p style={{ fontSize: 11, color: '#9ca3af', margin: '0 0 2px' }}>
                                Para: {o.entrega?.nombreApellido || '-'}
                              </p>
                              <p style={{ fontSize: 11, color: '#d1d5db', margin: 0 }}>{fmtTime(o.entregadoAt)}</p>
                            </div>
                            <div style={{ textAlign: 'right' as const, flexShrink: 0, marginLeft: 12 }}>
                              <p style={{ fontSize: 15, fontWeight: 800, color: '#16a34a', margin: '0 0 2px' }}>{fmt(o.confirmacion?.precioFinalCordobas)}</p>
                              {dep.tieneProducto && <p style={{ fontSize: 12, color: '#7c3aed', margin: 0, fontWeight: 700 }}>+{fmt(dep.montoProducto)}</p>}
                            </div>
                          </div>
                          {dep.descripcion && (
                            <p style={{ fontSize: 11, color: '#9ca3af', margin: '8px 0 0', padding: '6px 0 0', borderTop: '1px solid #f3f4f6' }}>{dep.descripcion}</p>
                          )}
                        </div>
                      </div>
                    );
                  })}
                </>
              )}
          </>
        )}

        {/* ── DEPÓSITOS ── */}
        {tab === 'depositos' && (
          <>
            {/* Summary banner */}
            <div style={{ background: '#fff', border: '1px solid #e5e7eb', borderRadius: 16, padding: '16px', marginBottom: 16, boxShadow: '0 1px 4px rgba(0,0,0,0.06)' }}>
              <p style={{ fontSize: 12, fontWeight: 700, color: '#374151', margin: '0 0 12px', textTransform: 'uppercase' as const, letterSpacing: 0.5 }}>Resumen de hoy</p>
              <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 10 }}>
                <div style={{ background: '#f5f3ff', border: '1px solid #ddd6fe', borderRadius: 12, padding: '12px 14px' }}>
                  <p style={{ fontSize: 11, color: '#7c3aed', fontWeight: 700, textTransform: 'uppercase' as const, margin: '0 0 4px', letterSpacing: 0.5 }}>Al comercio</p>
                  <p style={{ fontSize: 22, fontWeight: 900, color: '#7c3aed', margin: 0 }}>{fmt(resumenDepositos.alComercio)}</p>
                  <p style={{ fontSize: 11, color: '#a78bfa', margin: '4px 0 0' }}>Cobro producto</p>
                </div>
                <div style={{ background: '#eff6ff', border: '1px solid #bfdbfe', borderRadius: 12, padding: '12px 14px' }}>
                  <p style={{ fontSize: 11, color: '#2563eb', fontWeight: 700, textTransform: 'uppercase' as const, margin: '0 0 4px', letterSpacing: 0.5 }}>A Storkhub</p>
                  <p style={{ fontSize: 22, fontWeight: 900, color: '#2563eb', margin: 0 }}>{fmt(resumenDepositos.aStorkhub)}</p>
                  <p style={{ fontSize: 11, color: '#60a5fa', margin: '4px 0 0' }}>Delivery en efectivo</p>
                </div>
              </div>
              <div style={{ background: '#f8fafc', border: '1px solid #e2e8f0', borderRadius: 12, padding: '12px 14px', marginTop: 10 }}>
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                  <span style={{ fontSize: 13, color: '#374151', fontWeight: 600 }}>Total a depositar hoy</span>
                  <span style={{ fontSize: 22, fontWeight: 900, color: '#111827' }}>{fmt(resumenDepositos.total)}</span>
                </div>
              </div>
            </div>

            {depositosPendientes.length === 0
              ? <EmptyState icon="✅" title="Sin depósitos pendientes" subtitle="No hay efectivo por depositar" />
              : (
                <>
                  {/* ── Grupo Storkhub ── */}
                  {gruposDeposito.storkhub.orders.length > 0 && (() => {
                    const g = gruposDeposito.storkhub;
                    const key = '__storkhub';
                    const expanded = !!expandidos[key];
                    return (
                      <div style={{ background: '#fff', borderRadius: 16, marginBottom: 12, border: '1px solid #bfdbfe', overflow: 'hidden', boxShadow: '0 1px 4px rgba(0,0,0,0.06)' }}>
                        <div style={{ height: 4, background: '#2563eb' }} />
                        <div style={{ padding: '14px 16px' }}>
                          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', marginBottom: 10 }}>
                            <div>
                              <p style={{ fontSize: 12, fontWeight: 700, color: '#2563eb', textTransform: 'uppercase' as const, margin: '0 0 3px', letterSpacing: 0.5 }}>🏦 Storkhub — Delivery en efectivo</p>
                              <p style={{ fontSize: 11, color: '#60a5fa', margin: 0 }}>{g.orders.length} orden{g.orders.length !== 1 ? 'es' : ''}</p>
                            </div>
                            <p style={{ fontSize: 22, fontWeight: 900, color: '#2563eb', margin: 0 }}>{fmt(g.total)}</p>
                          </div>
                          <button onClick={() => toggleExpandido(key)}
                            style={{ background: 'none', border: 'none', padding: 0, cursor: 'pointer', fontSize: 12, color: '#60a5fa', fontWeight: 600, marginBottom: 10, display: 'flex', alignItems: 'center', gap: 4 }}>
                            {expanded ? '▲ Ocultar desglose' : '▼ Ver desglose'}
                          </button>
                          {expanded && (
                            <div style={{ background: '#f0f9ff', borderRadius: 10, padding: '8px 10px', marginBottom: 10 }}>
                              {g.orders.map((o) => {
                                const dep = calcDeposito(o);
                                return (
                                  <div key={o.id} style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '6px 0', borderBottom: '1px solid #e0f2fe', gap: 8 }}>
                                    <div style={{ flex: 1 }}>
                                      <p style={{ fontSize: 12, fontWeight: 600, color: '#1e40af', margin: 0 }}>{o.entrega?.nombreApellido || '—'}</p>
                                      <p style={{ fontSize: 10, color: '#93c5fd', margin: 0, fontFamily: 'monospace' }}>#{o.id.slice(0, 8)}</p>
                                    </div>
                                    <p style={{ fontSize: 13, fontWeight: 700, color: '#2563eb', margin: 0, flexShrink: 0 }}>{fmt(dep.totalAStorkhub)}</p>
                                  </div>
                                );
                              })}
                            </div>
                          )}
                          <div style={{ display: 'flex', flexDirection: 'column' as const, gap: 6, marginBottom: 12 }}>
                            <p style={{ fontSize: 10, fontWeight: 700, color: '#1e40af', textTransform: 'uppercase' as const, margin: 0, letterSpacing: 0.5 }}>Cuentas Storkhub:</p>
                            {STORKHUB_ACCOUNTS.map((acc, ai) => (
                              <div key={ai} style={{ background: '#dbeafe', border: '1px solid #bfdbfe', borderRadius: 8, padding: '7px 10px' }}>
                                <p style={{ fontSize: 12, fontWeight: 700, color: '#1e3a8a', margin: '0 0 2px' }}>{acc.bank} · {acc.currency}</p>
                                <p style={{ fontSize: 13, fontWeight: 800, color: '#1e40af', margin: '0 0 2px', fontFamily: 'monospace' }}>{acc.number}</p>
                                <p style={{ fontSize: 11, color: '#3b82f6', margin: 0 }}>{acc.holder}</p>
                              </div>
                            ))}
                          </div>
                          {/* Boucher de grupo — obligatorio */}
                          <button
                            onClick={() => { setActiveGroupKey(key); groupBoucherRef.current?.click(); }}
                            style={{ width: '100%', background: groupBoucher[key] ? '#f0fdf4' : '#eff6ff', border: `1px solid ${groupBoucher[key] ? '#bbf7d0' : '#bfdbfe'}`, borderRadius: 10, padding: '9px', color: groupBoucher[key] ? '#16a34a' : '#2563eb', fontSize: 13, fontWeight: 700, cursor: 'pointer', marginBottom: 4 }}>
                            {groupBoucher[key] ? `✅ Boucher adjunto · Cambiar` : '📸 Adjuntar boucher del depósito'}
                          </button>
                          {!groupBoucher[key] && (
                            <p style={{ fontSize: 11, color: '#dc2626', margin: '0 0 8px', textAlign: 'center' as const }}>
                              El boucher es obligatorio para confirmar
                            </p>
                          )}
                          <button
                            disabled={!groupBoucher[key]}
                            onClick={async () => {
                              if (!groupBoucher[key]) return;
                              if (!confirm(`¿Confirmás el depósito de ${fmt(g.total)} a Storkhub?`)) return;
                              try {
                                const depositoRef = doc(collection(db, 'ordenes_deposito'));
                                const depositoId = depositoRef.id;
                                let boucherData: { url: string; pathStorage: string; uploadedAt: ReturnType<typeof serverTimestamp>; motorizadoUid: string } | null = null;
                                const bFile = groupBoucher[key];
                                if (bFile) {
                                  const blob = await compressImage(bFile);
                                  const { url, pathStorage } = await uploadDepositoBoucher(depositoId, blob);
                                  boucherData = { url, pathStorage, uploadedAt: serverTimestamp(), motorizadoUid: auth.currentUser?.uid ?? '' };
                                }
                                await setDoc(depositoRef, {
                                  creadoAt: serverTimestamp(),
                                  destinatario: 'storkhub',
                                  destinatarioId: 'storkhub',
                                  destinatarioNombre: 'Storkhub',
                                  cuentasDestino: STORKHUB_ACCOUNTS.map((a) => ({ banco: a.bank, numero: a.number, titular: a.holder, moneda: a.currency })),
                                  motorizadoUid: auth.currentUser?.uid ?? '',
                                  motorizadoNombre: user?.displayName ?? user?.email ?? '',
                                  solicitudIds: g.orders.map((o) => o.id),
                                  montoTotal: g.total,
                                  boucher: boucherData,
                                  confirmadoMotorizado: true,
                                  confirmadoMotorizadoAt: serverTimestamp(),
                                });
                                const b = writeBatch(db);
                                g.orders.forEach((o) => b.update(doc(db, 'solicitudes_envio', o.id), {
                                  'registro.deposito.confirmadoStorkhub': true,
                                  'registro.deposito.confirmadoStorkhubAt': serverTimestamp(),
                                  'registro.deposito.storkhubDepositoId': depositoId,
                                }));
                                await b.commit();
                                setGroupBoucher((prev) => ({ ...prev, [key]: null }));
                              } catch (e) {
                                console.error(e);
                                alert('Error al confirmar el depósito. Intentá de nuevo.');
                              }
                            }}
                            style={{ width: '100%', background: groupBoucher[key] ? '#2563eb' : '#d1d5db', border: 'none', borderRadius: 12, padding: '12px', color: '#fff', fontSize: 14, fontWeight: 700, cursor: groupBoucher[key] ? 'pointer' : 'not-allowed' }}>
                            ✅ Confirmar depósito a Storkhub
                          </button>
                        </div>
                      </div>
                    );
                  })()}

                  {/* ── Grupos por Comercio ── */}
                  {gruposDeposito.comercios.map((g) => {
                    const key = g.uid;
                    const expanded = !!expandidos[key];
                    return (
                      <div key={key} style={{ background: '#fff', borderRadius: 16, marginBottom: 12, border: '1px solid #e9d5ff', overflow: 'hidden', boxShadow: '0 1px 4px rgba(0,0,0,0.06)' }}>
                        <div style={{ height: 4, background: '#7c3aed' }} />
                        <div style={{ padding: '14px 16px' }}>
                          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', marginBottom: 10 }}>
                            <div>
                              <p style={{ fontSize: 12, fontWeight: 700, color: '#7c3aed', textTransform: 'uppercase' as const, margin: '0 0 3px', letterSpacing: 0.5 }}>🏪 {g.nombre}</p>
                              <p style={{ fontSize: 11, color: '#a78bfa', margin: 0 }}>Cobro producto · {g.orders.length} orden{g.orders.length !== 1 ? 'es' : ''}</p>
                            </div>
                            <p style={{ fontSize: 22, fontWeight: 900, color: '#7c3aed', margin: 0 }}>{fmt(g.total)}</p>
                          </div>
                          <button onClick={() => toggleExpandido(key)}
                            style={{ background: 'none', border: 'none', padding: 0, cursor: 'pointer', fontSize: 12, color: '#a78bfa', fontWeight: 600, marginBottom: 10, display: 'flex', alignItems: 'center', gap: 4 }}>
                            {expanded ? '▲ Ocultar desglose' : '▼ Ver desglose'}
                          </button>
                          {expanded && (
                            <div style={{ background: '#faf5ff', borderRadius: 10, padding: '8px 10px', marginBottom: 10 }}>
                              {g.orders.map((o) => {
                                const dep = calcDeposito(o);
                                return (
                                  <div key={o.id} style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '6px 0', borderBottom: '1px solid #ede9fe', gap: 8 }}>
                                    <div style={{ flex: 1 }}>
                                      <p style={{ fontSize: 12, fontWeight: 600, color: '#5b21b6', margin: 0 }}>{o.entrega?.nombreApellido || '—'}</p>
                                      <p style={{ fontSize: 10, color: '#c4b5fd', margin: 0, fontFamily: 'monospace' }}>#{o.id.slice(0, 8)}</p>
                                    </div>
                                    <p style={{ fontSize: 13, fontWeight: 700, color: '#7c3aed', margin: 0, flexShrink: 0 }}>{fmt(dep.totalAlComercio)}</p>
                                  </div>
                                );
                              })}
                            </div>
                          )}
                          <div style={{ marginBottom: 12 }}>
                            {g.accounts.length > 0 ? (
                              <div style={{ display: 'flex', flexDirection: 'column' as const, gap: 6 }}>
                                <p style={{ fontSize: 10, fontWeight: 700, color: '#6d28d9', textTransform: 'uppercase' as const, margin: '0 0 4px', letterSpacing: 0.5 }}>Cuentas del comercio:</p>
                                {g.accounts.map((acc, ai) => (
                                  <div key={ai} style={{ background: '#ede9fe', border: '1px solid #ddd6fe', borderRadius: 8, padding: '7px 10px' }}>
                                    <p style={{ fontSize: 12, fontWeight: 700, color: '#5b21b6', margin: '0 0 2px' }}>{acc.bank} · {acc.currency}</p>
                                    <p style={{ fontSize: 13, fontWeight: 800, color: '#4c1d95', margin: '0 0 2px', fontFamily: 'monospace' }}>{acc.number}</p>
                                    <p style={{ fontSize: 11, color: '#7c3aed', margin: 0 }}>{acc.holder}</p>
                                  </div>
                                ))}
                              </div>
                            ) : (
                              <p style={{ fontSize: 11, color: '#a78bfa', margin: 0, fontStyle: 'italic' }}>El comercio no tiene cuentas registradas. Coordiná el depósito directamente.</p>
                            )}
                          </div>
                          {/* Boucher de grupo */}
                          {/* Boucher de grupo — obligatorio */}
                          <button
                            onClick={() => { setActiveGroupKey(key); groupBoucherRef.current?.click(); }}
                            style={{ width: '100%', background: groupBoucher[key] ? '#f0fdf4' : '#faf5ff', border: `1px solid ${groupBoucher[key] ? '#bbf7d0' : '#ddd6fe'}`, borderRadius: 10, padding: '9px', color: groupBoucher[key] ? '#16a34a' : '#7c3aed', fontSize: 13, fontWeight: 700, cursor: 'pointer', marginBottom: 4 }}>
                            {groupBoucher[key] ? `✅ Boucher adjunto · Cambiar` : '📸 Adjuntar boucher del depósito'}
                          </button>
                          {!groupBoucher[key] && (
                            <p style={{ fontSize: 11, color: '#dc2626', margin: '0 0 8px', textAlign: 'center' as const }}>
                              El boucher es obligatorio para confirmar
                            </p>
                          )}
                          <button
                            disabled={!groupBoucher[key]}
                            onClick={async () => {
                              if (!groupBoucher[key]) return;
                              if (!confirm(`¿Confirmás el depósito de ${fmt(g.total)} al comercio ${g.nombre}?`)) return;
                              try {
                                const depositoRef = doc(collection(db, 'ordenes_deposito'));
                                const depositoId = depositoRef.id;
                                let boucherData: { url: string; pathStorage: string; uploadedAt: ReturnType<typeof serverTimestamp>; motorizadoUid: string } | null = null;
                                const bFile = groupBoucher[key];
                                if (bFile) {
                                  const blob = await compressImage(bFile);
                                  const { url, pathStorage } = await uploadDepositoBoucher(depositoId, blob);
                                  boucherData = { url, pathStorage, uploadedAt: serverTimestamp(), motorizadoUid: auth.currentUser?.uid ?? '' };
                                }
                                await setDoc(depositoRef, {
                                  creadoAt: serverTimestamp(),
                                  destinatario: 'comercio',
                                  destinatarioId: g.uid,
                                  destinatarioNombre: g.nombre,
                                  cuentasDestino: g.accounts.map((a) => ({ banco: a.bank, numero: a.number, titular: a.holder, moneda: a.currency })),
                                  motorizadoUid: auth.currentUser?.uid ?? '',
                                  motorizadoNombre: user?.displayName ?? user?.email ?? '',
                                  solicitudIds: g.orders.map((o) => o.id),
                                  montoTotal: g.total,
                                  boucher: boucherData,
                                  confirmadoMotorizado: true,
                                  confirmadoMotorizadoAt: serverTimestamp(),
                                });
                                const b = writeBatch(db);
                                g.orders.forEach((o) => b.update(doc(db, 'solicitudes_envio', o.id), {
                                  'registro.deposito.confirmadoComercio': true,
                                  'registro.deposito.confirmadoComercioAt': serverTimestamp(),
                                  'registro.deposito.comercioDepositoId': depositoId,
                                }));
                                await b.commit();
                                setGroupBoucher((prev) => ({ ...prev, [key]: null }));
                              } catch (e) {
                                console.error(e);
                                alert('Error al confirmar el depósito. Intentá de nuevo.');
                              }
                            }}
                            style={{ width: '100%', background: groupBoucher[key] ? '#7c3aed' : '#d1d5db', border: 'none', borderRadius: 12, padding: '12px', color: '#fff', fontSize: 14, fontWeight: 700, cursor: groupBoucher[key] ? 'pointer' : 'not-allowed' }}>
                            ✅ Confirmar depósito al comercio
                          </button>
                        </div>
                      </div>
                    );
                  })}
                </>
              )}
          </>
        )}
      </div>

      {/* ── Hidden file input for group bouchers ── */}
      <input
        ref={groupBoucherRef}
        type="file"
        accept="image/*"
        capture="environment"
        style={{ display: 'none' }}
        onChange={(e) => {
          const f = e.target.files?.[0];
          if (f && activeGroupKey) setGroupBoucher((prev) => ({ ...prev, [activeGroupKey]: f }));
          if (groupBoucherRef.current) groupBoucherRef.current.value = '';
        }}
      />

      {/* ── Photo Upload Modal Overlay ── */}
      {photoGate && (
        <PhotoUploadModal
          tipo={photoGate.tipo}
          file={photoFile}
          uploading={photoUploading}
          success={photoSuccess}
          err={photoErr}
          onFile={(f) => setPhotoFile(f)}
          onSubmit={async () => {
            if (!photoFile) return;
            setPhotoUploading(true); setPhotoErr(null);
            try {
              const blob = await compressImage(photoFile);
              const { url, pathStorage } = await uploadEvidencia(photoGate.solicitudId, photoGate.tipo, blob);
              await updateDoc(doc(db, 'solicitudes_envio', photoGate.solicitudId), {
                [`evidencias.${photoGate.tipo}`]: {
                  url,
                  pathStorage,
                  uploadedAt: serverTimestamp(),
                  motorizadoUid: auth.currentUser?.uid || '',
                },
              });
              // Mostrar éxito 2s antes de cerrar y continuar
              setPhotoUploading(false);
              setPhotoSuccess(true);
              const gate = photoGate;
              // Build updated order so cambiar() bypasses the photo gate check
              const updatedOrder: Solicitud = {
                ...gate.order,
                evidencias: {
                  ...(gate.order.evidencias ?? {}),
                  [gate.tipo]: { url, pathStorage, uploadedAt: new Date() as unknown as import('firebase/firestore').Timestamp, motorizadoUid: auth.currentUser?.uid ?? '' },
                },
              };
              setTimeout(() => {
                setPhotoGate(null); setPhotoFile(null); setPhotoSuccess(false);
                if (gate.nextEstado) {
                  cambiar(updatedOrder, gate.nextEstado);
                }
              }, 2000);
            } catch (e) {
              console.error(e);
              setPhotoErr('No se pudo subir la foto. Intentá de nuevo.');
              setPhotoUploading(false);
            }
          }}
          onCancel={() => { setPhotoGate(null); setPhotoFile(null); setPhotoErr(null); setPhotoSuccess(false); }}
        />
      )}

      <BottomNav
        tab={tab}
        setTab={setTab}
        pendientesCount={pendientes.length}
        enCursoCount={enCurso.length}
        depositosCount={depositosPendientes.length}
      />
    </div>
  );
}

// ─── Sub-components ───────────────────────────────────────────────────────────

const card: React.CSSProperties = { background: '#fff', borderRadius: 20, marginBottom: 16, border: '1px solid #e5e7eb', overflow: 'hidden', boxShadow: '0 1px 4px rgba(0,0,0,0.06)' };
const btnPrimary: React.CSSProperties = { flex: 1, background: '#004aad', border: 'none', borderRadius: 14, padding: '14px 18px', color: '#fff', fontSize: 15, fontWeight: 800, cursor: 'pointer' };
const btnSecondary: React.CSSProperties = { flexShrink: 0, background: '#fff', border: '1px solid #fecaca', borderRadius: 14, padding: '14px 18px', color: '#dc2626', fontSize: 14, fontWeight: 700, cursor: 'pointer' };
const btnBlue: React.CSSProperties = { background: '#004aad', border: 'none', borderRadius: 14, padding: '16px 20px', color: '#fff', fontSize: 15, fontWeight: 800, cursor: 'pointer', width: '100%' };
const btnGreen: React.CSSProperties = { background: '#16a34a', border: 'none', borderRadius: 14, padding: '16px 20px', color: '#fff', fontSize: 15, fontWeight: 800, cursor: 'pointer', width: '100%' };

function StatCard({ label, value, color, bg, border }: { label: string; value: number; color: string; bg: string; border: string }) {
  return (
    <div style={{ flex: 1, background: bg, border: `1px solid ${border}`, borderRadius: 12, padding: '8px 10px' }}>
      <p style={{ fontSize: 20, fontWeight: 900, color, margin: '0 0 2px', letterSpacing: -1 }}>{value}</p>
      <p style={{ fontSize: 10, fontWeight: 600, color: '#9ca3af', margin: 0, textTransform: 'uppercase', letterSpacing: 0.3 }}>{label}</p>
    </div>
  );
}

type TabKey = 'pendientes' | 'en_curso' | 'historial' | 'depositos';

function BottomNav({ tab, setTab, pendientesCount, enCursoCount, depositosCount }: {
  tab: TabKey; setTab: (t: TabKey) => void;
  pendientesCount: number; enCursoCount: number; depositosCount: number;
}) {
  const items: { key: TabKey; label: string; icon: React.ReactNode; count: number }[] = [
    {
      key: 'pendientes', label: 'Nuevas', count: pendientesCount,
      icon: (
        <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round">
          <path d="M18 8A6 6 0 0 0 6 8c0 7-3 9-3 9h18s-3-2-3-9" />
          <path d="M13.73 21a2 2 0 0 1-3.46 0" />
        </svg>
      ),
    },
    {
      key: 'en_curso', label: 'En curso', count: enCursoCount,
      icon: (
        <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round">
          <circle cx="5.5" cy="17.5" r="2.5" />
          <circle cx="18.5" cy="17.5" r="2.5" />
          <path d="M15 6h2l3 6.5v5h-3" />
          <path d="M3 17.5V9a2 2 0 0 1 2-2h8a2 2 0 0 1 2 2v8.5" />
          <path d="M3 12h12" />
        </svg>
      ),
    },
    {
      key: 'historial', label: 'Historial', count: 0,
      icon: (
        <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round">
          <circle cx="12" cy="12" r="10" />
          <polyline points="12 6 12 12 16 14" />
        </svg>
      ),
    },
    {
      key: 'depositos', label: 'Depósitos', count: depositosCount,
      icon: (
        <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round">
          <rect x="2" y="7" width="20" height="15" rx="2" />
          <path d="M16 7V5a2 2 0 0 0-2-2h-4a2 2 0 0 0-2 2v2" />
          <line x1="12" y1="12" x2="12" y2="16" />
          <line x1="10" y1="14" x2="14" y2="14" />
        </svg>
      ),
    },
  ];

  return (
    <div style={{
      position: 'fixed', bottom: 0, left: 0, right: 0, zIndex: 100,
      maxWidth: 520, margin: '0 auto',
      height: 60, display: 'flex',
      background: '#fff', borderTop: '1px solid #e5e7eb',
      boxShadow: '0 -2px 12px rgba(0,0,0,0.06)',
    }}>
      {items.map((item) => {
        const active = tab === item.key;
        return (
          <button
            key={item.key}
            onClick={() => setTab(item.key)}
            style={{
              flex: 1, display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center',
              gap: 3, border: 'none', background: 'transparent', cursor: 'pointer',
              color: active ? '#004aad' : '#9ca3af', position: 'relative',
            }}
          >
            {/* Badge */}
            {item.count > 0 && (
              <span style={{
                position: 'absolute', top: 6, left: '50%', transform: 'translateX(4px)',
                background: '#ef4444', color: '#fff', borderRadius: 9999,
                minWidth: 18, height: 18, fontSize: 10, fontWeight: 800,
                display: 'flex', alignItems: 'center', justifyContent: 'center',
                padding: '0 4px', lineHeight: 1,
              }}>
                {item.count}
              </span>
            )}
            {item.icon}
            <span style={{ fontSize: 10, fontWeight: active ? 700 : 500, letterSpacing: 0.3 }}>{item.label}</span>
          </button>
        );
      })}
    </div>
  );
}

type PointData = { nombreApellido?: string; celular?: string; direccionEscrita?: string; nota?: string | null; notaMotorizado?: string | null; coord?: { lat: number; lng: number } | null; puntoGoogleLink?: string | null; puntoGoogleTexto?: string | null } | undefined;

function getMapsLink(point: PointData, coordOverride?: { lat: number; lng: number } | null): string | null {
  const coord = coordOverride ?? point?.coord;
  if (coord) return `https://www.google.com/maps?q=${coord.lat},${coord.lng}`;
  if (point?.puntoGoogleLink?.trim()) return point.puntoGoogleLink.trim();
  if (point?.puntoGoogleTexto?.trim()) return `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(point.puntoGoogleTexto.trim())}`;
  if (point?.direccionEscrita?.trim()) return `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(point.direccionEscrita.trim())}`;
  return null;
}

function PaqueteBadge({ paquete }: { paquete?: Solicitud['paquete'] }) {
  if (!paquete || (!paquete.fragil && !paquete.grande)) return null;
  return (
    <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', marginBottom: 10 }}>
      {paquete.fragil && (
        <span style={{ fontSize: 11, fontWeight: 700, color: '#b45309', background: '#fef3c7', border: '1px solid #fde68a', borderRadius: 6, padding: '3px 8px' }}>
          ⚠️ Paquete frágil
        </span>
      )}
      {paquete.grande && (
        <span style={{ fontSize: 11, fontWeight: 700, color: '#1d4ed8', background: '#dbeafe', border: '1px solid #bfdbfe', borderRadius: 6, padding: '3px 8px' }}>
          📦 Paquete grande
        </span>
      )}
      {paquete.notaPaquete && (
        <p style={{ fontSize: 11, color: '#6b7280', margin: '4px 0 0', width: '100%' }}>{paquete.notaPaquete}</p>
      )}
    </div>
  );
}

function RoutePoint({ type, point, fallbackName, retiroCoord, entregaCoord }: {
  type: 'pickup' | 'dropoff';
  point: PointData;
  fallbackName?: string;
  retiroCoord?: { lat: number; lng: number } | null;
  entregaCoord?: { lat: number; lng: number } | null;
}) {
  const ip = type === 'pickup';
  const coordOverride = ip ? retiroCoord : entregaCoord;
  const mapsUrl = getMapsLink(point, coordOverride);
  const name = point?.nombreApellido || fallbackName || '-';
  const phone = point?.celular || '-';
  const address = point?.direccionEscrita || '-';
  const nota = (point?.notaMotorizado || point?.nota)?.trim();

  return (
    <div style={{ display: 'flex', gap: 12, alignItems: 'flex-start' }}>
      <div style={{ width: 26, height: 26, borderRadius: '50%', background: ip ? '#fef3c7' : '#dcfce7', border: `2px solid ${ip ? '#f59e0b' : '#16a34a'}`, display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0, marginTop: 2 }}>
        <span style={{ fontSize: 10, fontWeight: 900, color: ip ? '#d97706' : '#16a34a' }}>{ip ? 'A' : 'B'}</span>
      </div>
      <div style={{ flex: 1, paddingBottom: 6 }}>
        <p style={{ fontSize: 10, fontWeight: 800, color: '#9ca3af', letterSpacing: 1, textTransform: 'uppercase', margin: '0 0 2px' }}>{ip ? 'RETIRO' : 'ENTREGA'}</p>
        <p style={{ fontSize: 14, fontWeight: 700, color: '#111827', margin: '0 0 2px' }}>{name}</p>
        <a href={`tel:${phone}`} style={{ fontSize: 13, color: '#2563eb', textDecoration: 'none', fontWeight: 600, display: 'block', marginBottom: 3 }}>📞 {phone}</a>
        <p style={{ fontSize: 13, color: '#6b7280', margin: '0 0 4px', lineHeight: 1.4 }}>📍 {address}</p>
        {nota && (
          <p style={{ fontSize: 12, color: '#d97706', background: '#fffbeb', border: '1px solid #fde68a', borderRadius: 8, padding: '5px 9px', margin: '4px 0', lineHeight: 1.4 }}>
            📝 {nota}
          </p>
        )}
        {mapsUrl && (
          <a href={mapsUrl} target="_blank" rel="noreferrer" style={{ display: 'inline-flex', alignItems: 'center', gap: 5, marginTop: 4, fontSize: 12, color: '#2563eb', fontWeight: 700, textDecoration: 'none', background: '#eff6ff', border: '1px solid #bfdbfe', borderRadius: 8, padding: '5px 10px' }}>
            🗺 Abrir en Maps
          </a>
        )}
      </div>
    </div>
  );
}

function CobroBox({ o, dep }: { o: Solicitud; dep: DepositoInfo }) {
  const delivery = o.confirmacion?.precioFinalCordobas ?? 0;
  const totalCliente = (dep.tieneDelivery ? delivery : 0) + (dep.tieneProducto ? dep.montoProducto : 0);

  return (
    <div style={{ background: '#f8fafc', border: '1px solid #e2e8f0', borderRadius: 12, padding: '12px 14px', marginBottom: 14 }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
        <span style={{ fontSize: 12, color: '#6b7280', fontWeight: 600, textTransform: 'uppercase' as const }}>Delivery</span>
        <span style={{ fontSize: 18, fontWeight: 900, color: '#111827' }}>{fmt(delivery)}</span>
      </div>
      {dep.tieneProducto && (
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginTop: 6 }}>
          <span style={{ fontSize: 12, color: '#6b7280', fontWeight: 600, textTransform: 'uppercase' as const }}>Cobro producto</span>
          <span style={{ fontSize: 18, fontWeight: 800, color: '#7c3aed' }}>{fmt(dep.montoProducto)}</span>
        </div>
      )}
      {totalCliente > 0 && (
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginTop: 10, paddingTop: 10, borderTop: '1px solid #e2e8f0' }}>
          <span style={{ fontSize: 13, color: '#111827', fontWeight: 700 }}>Total a cobrar al cliente</span>
          <span style={{ fontSize: 22, fontWeight: 900, color: '#004aad' }}>{fmt(totalCliente)}</span>
        </div>
      )}
      <p style={{ fontSize: 11, color: '#9ca3af', margin: '8px 0 0' }}>{dep.descripcion}</p>
    </div>
  );
}

function EmptyState({ icon, title, subtitle }: { icon: string; title: string; subtitle: string }) {
  return (
    <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', padding: '60px 20px', gap: 8 }}>
      <span style={{ fontSize: 44 }}>{icon}</span>
      <p style={{ fontSize: 17, fontWeight: 700, color: '#111827', margin: '6px 0 0' }}>{title}</p>
      <p style={{ fontSize: 14, color: '#9ca3af', textAlign: 'center', margin: 0, lineHeight: 1.5 }}>{subtitle}</p>
    </div>
  );
}

function PhotoUploadModal({
  tipo, file, uploading, success, err, onFile, onSubmit, onCancel,
}: {
  tipo: TipoEvidencia;
  file: File | null;
  uploading: boolean;
  success: boolean;
  err: string | null;
  onFile: (f: File) => void;
  onSubmit: () => void;
  onCancel: () => void;
}) {
  const inputRef = useRef<HTMLInputElement>(null);
  const previewUrl = file ? URL.createObjectURL(file) : null;

  const tipoLabel: Record<TipoEvidencia, string> = {
    retiro: 'retiro del paquete',
    entrega: 'entrega al destinatario',
    deposito: 'boucher de depósito',
  };
  const tipoEmoji: Record<TipoEvidencia, string> = {
    retiro: '📦',
    entrega: '✅',
    deposito: '🏦',
  };

  // Pantalla de éxito
  if (success) {
    return (
      <div style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.6)', zIndex: 1000, display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 20 }}>
        <div style={{ background: '#fff', borderRadius: 24, padding: 36, maxWidth: 360, width: '100%', boxShadow: '0 20px 60px rgba(0,0,0,0.3)', display: 'flex', flexDirection: 'column' as const, alignItems: 'center', gap: 12 }}>
          <div style={{ width: 72, height: 72, borderRadius: '50%', background: '#f0fdf4', border: '3px solid #16a34a', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
            <span style={{ fontSize: 36 }}>✅</span>
          </div>
          <p style={{ fontSize: 20, fontWeight: 900, color: '#15803d', margin: 0, textAlign: 'center' as const }}>¡Foto cargada!</p>
          <p style={{ fontSize: 14, color: '#6b7280', margin: 0, textAlign: 'center' as const, lineHeight: 1.5 }}>
            La imagen se guardó correctamente.<br />Continuando con el siguiente paso…
          </p>
          <div style={{ width: '100%', height: 4, background: '#f3f4f6', borderRadius: 4, overflow: 'hidden', marginTop: 8 }}>
            <div style={{ height: '100%', background: '#16a34a', borderRadius: 4, animation: 'progress2s 2s linear forwards' }} />
          </div>
        </div>
      </div>
    );
  }

  return (
    <div style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.6)', zIndex: 1000, display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 20 }}>
      <div style={{ background: '#fff', borderRadius: 24, padding: 24, maxWidth: 360, width: '100%', boxShadow: '0 20px 60px rgba(0,0,0,0.3)' }}>
        <p style={{ fontSize: 18, fontWeight: 800, color: '#111827', margin: '0 0 4px' }}>
          {tipoEmoji[tipo]} Foto de {tipoLabel[tipo]}
        </p>
        <p style={{ fontSize: 13, color: '#6b7280', margin: '0 0 20px', lineHeight: 1.5 }}>
          {tipo !== 'deposito'
            ? 'Esta foto es obligatoria para continuar. Tomá una foto clara antes de avanzar.'
            : 'Subí la foto del boucher como comprobante del depósito realizado.'}
        </p>

        <input
          ref={inputRef}
          type="file"
          accept="image/*"
          capture="environment"
          style={{ display: 'none' }}
          onChange={(e) => { const f = e.target.files?.[0]; if (f) onFile(f); }}
        />

        {previewUrl ? (
          <div style={{ marginBottom: 16 }}>
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img
              src={previewUrl}
              alt="preview"
              style={{ width: '100%', maxHeight: 200, objectFit: 'cover', borderRadius: 14, border: '2px solid #e5e7eb' }}
            />
            <button
              onClick={() => inputRef.current?.click()}
              style={{ marginTop: 8, width: '100%', background: '#f3f4f6', border: '1px solid #e5e7eb', borderRadius: 10, padding: '9px', fontSize: 13, color: '#374151', fontWeight: 600, cursor: 'pointer' }}>
              🔄 Cambiar foto
            </button>
          </div>
        ) : (
          <button
            onClick={() => inputRef.current?.click()}
            style={{ width: '100%', background: '#eff6ff', border: '2px dashed #93c5fd', borderRadius: 14, padding: '24px 16px', fontSize: 15, color: '#2563eb', fontWeight: 700, cursor: 'pointer', marginBottom: 16, display: 'flex', flexDirection: 'column' as const, alignItems: 'center', gap: 6 }}>
            <span style={{ fontSize: 36 }}>📷</span>
            Tomar o seleccionar foto
          </button>
        )}

        {err && (
          <p style={{ fontSize: 12, color: '#dc2626', background: '#fef2f2', border: '1px solid #fecaca', borderRadius: 8, padding: '8px 12px', margin: '0 0 12px' }}>
            ⚠️ {err}
          </p>
        )}

        <div style={{ display: 'flex', gap: 10 }}>
          <button
            onClick={onCancel}
            disabled={uploading}
            style={{ flex: 1, background: '#fff', border: '1px solid #e5e7eb', borderRadius: 14, padding: '13px', color: '#6b7280', fontSize: 14, fontWeight: 700, cursor: uploading ? 'not-allowed' : 'pointer' }}>
            {tipo === 'deposito' ? 'Cerrar' : 'Cancelar'}
          </button>
          <button
            onClick={onSubmit}
            disabled={!file || uploading}
            style={{ flex: 2, background: !file || uploading ? '#d1d5db' : '#004aad', border: 'none', borderRadius: 14, padding: '13px', color: '#fff', fontSize: 14, fontWeight: 800, cursor: !file || uploading ? 'not-allowed' : 'pointer' }}>
            {uploading ? 'Subiendo…' : file ? 'Subir y continuar →' : 'Seleccioná una foto'}
          </button>
        </div>
      </div>
    </div>
  );
}