'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import { onAuthStateChanged, User } from 'firebase/auth';
import {
  collection, onSnapshot, query, where,
  doc, getDoc, serverTimestamp, Timestamp, writeBatch,
} from 'firebase/firestore';
import { auth, db } from '@/fb/config';

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
  recoleccion?: { nombreApellido?: string; celular?: string; direccionEscrita?: string; nota?: string | null; coord?: { lat: number; lng: number } | null; puntoGoogleLink?: string | null; puntoGoogleTexto?: string | null };
  entrega?: { nombreApellido?: string; celular?: string; direccionEscrita?: string; nota?: string | null; coord?: { lat: number; lng: number } | null; puntoGoogleLink?: string | null; puntoGoogleTexto?: string | null };
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
    delivery?: { monto: number; recibio: boolean; at?: any };
    producto?: { monto: number; recibio: boolean; at?: any };
  };
};

type PendingConfirm = {
  order: Solicitud;
  nuevo: EstadoSolicitud;
  showDelivery: boolean;
  showProducto: boolean;
  montoDelivery: number;
  montoProducto: number;
  recibioDelivery: boolean;
  recibioProducto: boolean;
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

  // Delivery: el motorizado lo recauda en efectivo solo si quienPaga es recoleccion o entrega
  const motorizadoRecaudeDelivery = !esPorTransferencia && !esCredito && precioDelivery > 0;
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
    tieneProducto: ceAplica,
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

  async function executeCambiar(
    o: Solicitud,
    nuevo: EstadoSolicitud,
    cobros?: { delivery?: { monto: number; recibio: boolean }; producto?: { monto: number; recibio: boolean } }
  ) {
    if (!o.id) return;
    setErr(null); setActionId(`${o.id}:${nuevo}`);
    try {
      const b = writeBatch(db);
      const p: any = { estado: nuevo, updatedAt: serverTimestamp(), [`historial.${nuevo}At`]: serverTimestamp() };
      if (nuevo === 'entregado') p.entregadoAt = serverTimestamp();
      if (cobros) {
        if (cobros.delivery) p['cobrosMotorizado.delivery'] = { ...cobros.delivery, at: serverTimestamp() };
        if (cobros.producto) p['cobrosMotorizado.producto'] = { ...cobros.producto, at: serverTimestamp() };
      }
      b.update(doc(db, 'solicitudes_envio', o.id), p);
      if (o.asignacion?.motorizadoId) b.update(doc(db, 'motorizado', o.asignacion.motorizadoId), { estado: nuevo === 'entregado' ? 'disponible' : 'ocupado', updatedAt: serverTimestamp() });
      await b.commit();
    } catch (e) { console.error(e); setErr('No se pudo cambiar.'); }
    finally { setActionId(null); }
  }

  function cambiar(o: Solicitud, nuevo: EstadoSolicitud) {
    const dep = calcDeposito(o);
    const tipo = o.pagoDelivery?.tipo || '';
    const quienPaga = o.pagoDelivery?.quienPaga || '';
    const esRetiro = tipo === 'Ef. retiro' || quienPaga === 'recoleccion';

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
      showDelivery,
      showProducto,
      montoDelivery: dep.montoDelivery,
      montoProducto: dep.montoProducto,
      recibioDelivery: true,
      recibioProducto: true,
    });
  }

  const todas = useMemo(() => (!user ? [] : sortDesc(ordenes)), [ordenes, user]);

  const pendientes = useMemo(() =>
    todas.filter((o) => o.estado === 'asignada' && o.asignacion?.estadoAceptacion === 'pendiente')
      .map((o) => {
        const dl = tsToDate(o.asignacion?.aceptarAntesDe);
        return { ...o, ms: dl ? dl.getTime() - tick : 0 };
      }), [todas, tick]);

  const enCurso = useMemo(() =>
    todas.filter((o) => o.asignacion?.estadoAceptacion === 'aceptada' && ['asignada', 'en_camino_retiro', 'retirado', 'en_camino_entrega'].includes(o.estado || '')),
    [todas]);

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

  // Depósitos: today's delivered orders that have something to deposit
  const depositosPendientes = useMemo(() =>
    entregadas.filter((o) => {
      const d = tsToDate(o.entregadoAt) || tsToDate(o.updatedAt);
      if (!d || !isToday(d)) return false;
      const dep = calcDeposito(o);
      return dep.totalAlComercio > 0 || dep.totalAStorkhub > 0;
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

  useEffect(() => { if (pendientes.length > 0) setTab('pendientes'); }, [pendientes.length]);

  // Load comercio bank accounts for deposit orders
  const [comercioAccounts, setComercioAccounts] = useState<Record<string, BankAccount[]>>({});
  useEffect(() => {
    const uids = [...new Set(depositosPendientes.map((o) => o.userId).filter(Boolean))] as string[];
    if (uids.length === 0) return;
    Promise.all(uids.map((uid) => getDoc(doc(db, 'comercios', uid)))).then((snaps) => {
      const map: Record<string, BankAccount[]> = {};
      snaps.forEach((snap, i) => {
        if (snap.exists()) map[uids[i]] = (snap.data()?.accounts as BankAccount[]) || [];
      });
      setComercioAccounts(map);
    });
  }, [depositosPendientes]);

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

  const tabs = [
    { key: 'pendientes' as const, label: '🔔 Nuevas', count: pendientes.length },
    { key: 'en_curso' as const, label: '🛵 En curso', count: enCurso.length },
    { key: 'historial' as const, label: '📋 Historial', count: historialFiltrado.length },
    { key: 'depositos' as const, label: '💰 Depósitos', count: depositosPendientes.length },
  ];

  return (
    <div style={{ minHeight: '100vh', background: '#f9fafb', fontFamily: "'SF Pro Display', -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif", maxWidth: 520, margin: '0 auto', paddingBottom: 48 }}>

      {/* Header */}
      <div style={{ background: '#fff', borderBottom: '1px solid #e5e7eb', padding: '20px 20px 16px' }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
          <div>
            <h1 style={{ fontSize: 22, fontWeight: 800, color: '#111827', margin: 0, letterSpacing: -0.5 }}>Panel Motorizado</h1>
            <p style={{ fontSize: 12, color: '#9ca3af', margin: '3px 0 0' }}>{user.email}</p>
          </div>
          <div style={{ display: 'flex', alignItems: 'center', gap: 6, background: '#f0fdf4', border: '1px solid #bbf7d0', borderRadius: 20, padding: '6px 12px' }}>
            <span style={{ width: 7, height: 7, borderRadius: '50%', background: '#16a34a', display: 'inline-block' }} />
            <span style={{ fontSize: 12, color: '#16a34a', fontWeight: 600 }}>En línea</span>
          </div>
        </div>
        <div style={{ display: 'flex', gap: 10, marginTop: 16 }}>
          <StatCard label="Nuevas" value={pendientes.length} color={pendientes.length > 0 ? '#d97706' : '#6b7280'} bg={pendientes.length > 0 ? '#fffbeb' : '#f9fafb'} border={pendientes.length > 0 ? '#fde68a' : '#e5e7eb'} />
          <StatCard label="En curso" value={enCurso.length} color={enCurso.length > 0 ? '#2563eb' : '#6b7280'} bg={enCurso.length > 0 ? '#eff6ff' : '#f9fafb'} border={enCurso.length > 0 ? '#bfdbfe' : '#e5e7eb'} />
          <StatCard label="Hoy" value={historialFiltrado.length} color="#16a34a" bg="#f0fdf4" border="#bbf7d0" />
          <StatCard label="Depósitos" value={depositosPendientes.length} color={depositosPendientes.length > 0 ? '#7c3aed' : '#6b7280'} bg={depositosPendientes.length > 0 ? '#f5f3ff' : '#f9fafb'} border={depositosPendientes.length > 0 ? '#ddd6fe' : '#e5e7eb'} />
        </div>
      </div>

      {err && <div style={{ margin: '12px 16px 0', background: '#fef2f2', border: '1px solid #fecaca', borderRadius: 12, padding: '10px 14px', color: '#dc2626', fontSize: 13 }}>⚠️ {err}</div>}

      {/* Tabs */}
      <div style={{ display: 'flex', margin: '16px 16px 0', background: '#fff', borderRadius: 14, padding: 4, gap: 3, border: '1px solid #e5e7eb', boxShadow: '0 1px 2px rgba(0,0,0,0.05)' }}>
        {tabs.map((t) => (
          <button key={t.key} onClick={() => setTab(t.key)} style={{ flex: 1, padding: '9px 2px', border: 'none', cursor: 'pointer', background: tab === t.key ? '#004aad' : 'transparent', color: tab === t.key ? '#fff' : '#6b7280', fontSize: 11, fontWeight: 700, borderRadius: 10, display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 4, transition: 'all 0.15s' }}>
            {t.label}
            {t.count > 0 && <span style={{ background: tab === t.key ? 'rgba(255,255,255,0.25)' : '#004aad', color: '#fff', borderRadius: 10, padding: '1px 5px', fontSize: 10, fontWeight: 800 }}>{t.count}</span>}
          </button>
        ))}
      </div>

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
              : enCurso.map((o) => {
                const actions = nextActions(o.estado);
                const est = estadoStyle(o.estado);
                const dep = calcDeposito(o);
                return (
                  <div key={o.id} style={card}>
                    <div style={{ height: 4, background: est.accent }} />
                    <div style={{ padding: '14px 16px 0' }}>
                      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 12 }}>
                        <div style={{ background: est.bg, border: `1px solid ${est.border}`, borderRadius: 10, padding: '8px 14px' }}>
                          <span style={{ color: est.text, fontWeight: 700, fontSize: 13 }}>{estadoTexto(o.estado)}</span>
                        </div>
                        <span style={{ fontSize: 11, color: '#9ca3af', fontFamily: 'monospace' }}>#{o.id.slice(0, 8)}</span>
                      </div>

                      <CobroBox o={o} dep={dep} />

                      <RoutePoint type="pickup" point={o.recoleccion} fallbackName={o.cliente?.nombre} retiroCoord={o.cotizacion?.origenCoord} />
                      <div style={{ width: 2, height: 18, background: '#e5e7eb', marginLeft: 13, marginTop: 3, marginBottom: 3 }} />
                      <RoutePoint type="dropoff" point={o.entrega} entregaCoord={o.cotizacion?.destinoCoord} />

                      {pendingConfirm?.order.id === o.id ? (
                        /* ── Confirmación de cobro ── */
                        <div style={{ background: '#f0fdf4', border: '1px solid #bbf7d0', borderRadius: 14, padding: '14px 16px', margin: '14px 0 16px' }}>
                          <p style={{ fontSize: 13, fontWeight: 800, color: '#15803d', margin: '0 0 12px' }}>💰 Confirmar cobro</p>
                          {pendingConfirm.showDelivery && (
                            <div style={{ marginBottom: 12 }}>
                              <p style={{ fontSize: 13, color: '#374151', fontWeight: 600, margin: '0 0 8px' }}>
                                ¿Recibiste {fmt(pendingConfirm.montoDelivery)} de delivery?
                              </p>
                              <div style={{ display: 'flex', gap: 8 }}>
                                <button
                                  onClick={() => setPendingConfirm((p) => p ? { ...p, recibioDelivery: true } : p)}
                                  style={{ flex: 1, padding: '9px 0', borderRadius: 10, border: `2px solid ${pendingConfirm.recibioDelivery ? '#16a34a' : '#e5e7eb'}`, background: pendingConfirm.recibioDelivery ? '#16a34a' : '#fff', color: pendingConfirm.recibioDelivery ? '#fff' : '#6b7280', fontSize: 13, fontWeight: 700, cursor: 'pointer' }}
                                >
                                  ✅ Sí, recibí
                                </button>
                                <button
                                  onClick={() => setPendingConfirm((p) => p ? { ...p, recibioDelivery: false } : p)}
                                  style={{ flex: 1, padding: '9px 0', borderRadius: 10, border: `2px solid ${!pendingConfirm.recibioDelivery ? '#dc2626' : '#e5e7eb'}`, background: !pendingConfirm.recibioDelivery ? '#fee2e2' : '#fff', color: !pendingConfirm.recibioDelivery ? '#dc2626' : '#6b7280', fontSize: 13, fontWeight: 700, cursor: 'pointer' }}
                                >
                                  ❌ No recibí
                                </button>
                              </div>
                            </div>
                          )}
                          {pendingConfirm.showProducto && (
                            <div style={{ marginBottom: 12 }}>
                              <p style={{ fontSize: 13, color: '#374151', fontWeight: 600, margin: '0 0 8px' }}>
                                ¿Recibiste {fmt(pendingConfirm.montoProducto)} del producto?
                              </p>
                              <div style={{ display: 'flex', gap: 8 }}>
                                <button
                                  onClick={() => setPendingConfirm((p) => p ? { ...p, recibioProducto: true } : p)}
                                  style={{ flex: 1, padding: '9px 0', borderRadius: 10, border: `2px solid ${pendingConfirm.recibioProducto ? '#16a34a' : '#e5e7eb'}`, background: pendingConfirm.recibioProducto ? '#16a34a' : '#fff', color: pendingConfirm.recibioProducto ? '#fff' : '#6b7280', fontSize: 13, fontWeight: 700, cursor: 'pointer' }}
                                >
                                  ✅ Sí, recibí
                                </button>
                                <button
                                  onClick={() => setPendingConfirm((p) => p ? { ...p, recibioProducto: false } : p)}
                                  style={{ flex: 1, padding: '9px 0', borderRadius: 10, border: `2px solid ${!pendingConfirm.recibioProducto ? '#dc2626' : '#e5e7eb'}`, background: !pendingConfirm.recibioProducto ? '#fee2e2' : '#fff', color: !pendingConfirm.recibioProducto ? '#dc2626' : '#6b7280', fontSize: 13, fontWeight: 700, cursor: 'pointer' }}
                                >
                                  ❌ No recibí
                                </button>
                              </div>
                            </div>
                          )}
                          <div style={{ display: 'flex', gap: 8, marginTop: 4 }}>
                            <button
                              onClick={() => setPendingConfirm(null)}
                              style={{ flexShrink: 0, background: '#fff', border: '1px solid #e5e7eb', borderRadius: 12, padding: '12px 16px', color: '#6b7280', fontSize: 13, fontWeight: 700, cursor: 'pointer' }}
                            >
                              Cancelar
                            </button>
                            <button
                              disabled={!!actionId}
                              onClick={() => {
                                const pc = pendingConfirm;
                                setPendingConfirm(null);
                                executeCambiar(pc.order, pc.nuevo, {
                                  delivery: pc.showDelivery ? { monto: pc.montoDelivery, recibio: pc.recibioDelivery } : undefined,
                                  producto: pc.showProducto ? { monto: pc.montoProducto, recibio: pc.recibioProducto } : undefined,
                                });
                              }}
                              style={{ flex: 1, background: '#16a34a', border: 'none', borderRadius: 12, padding: '12px 16px', color: '#fff', fontSize: 14, fontWeight: 800, cursor: 'pointer' }}
                            >
                              {actionId ? 'Guardando…' : 'Confirmar y avanzar →'}
                            </button>
                          </div>
                        </div>
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
              ? <EmptyState icon="✅" title="Sin depósitos pendientes" subtitle="Hoy no hay efectivo por depositar" />
              : (
                <>
                  <p style={{ fontSize: 12, color: '#9ca3af', marginBottom: 10, fontWeight: 600 }}>DETALLE POR ORDEN</p>
                  {depositosPendientes.map((o) => {
                    const dep = calcDeposito(o);
                    return (
                      <div key={o.id} style={{ background: '#fff', borderRadius: 16, marginBottom: 10, border: '1px solid #e5e7eb', overflow: 'hidden', boxShadow: '0 1px 2px rgba(0,0,0,0.04)' }}>
                        <div style={{ height: 3, background: '#7c3aed' }} />
                        <div style={{ padding: '12px 14px' }}>
                          <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 10 }}>
                            <div>
                              <p style={{ fontSize: 13, fontWeight: 700, color: '#111827', margin: '0 0 2px' }}>{o.entrega?.nombreApellido || '-'}</p>
                              <p style={{ fontSize: 11, color: '#9ca3af', margin: 0, fontFamily: 'monospace' }}>#{o.id.slice(0, 10)}</p>
                            </div>
                            <p style={{ fontSize: 11, color: '#9ca3af', margin: 0 }}>{fmtTime(o.entregadoAt)}</p>
                          </div>

                          <div style={{ display: 'flex', flexDirection: 'column' as const, gap: 8 }}>
                            {dep.totalAlComercio > 0 && (
                              <div style={{ background: '#faf5ff', border: '1px solid #e9d5ff', borderRadius: 10, padding: '10px 14px' }}>
                                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 8 }}>
                                  <div>
                                    <p style={{ fontSize: 11, fontWeight: 700, color: '#7c3aed', textTransform: 'uppercase' as const, margin: '0 0 2px', letterSpacing: 0.5 }}>🏪 Depositar al comercio</p>
                                    <p style={{ fontSize: 11, color: '#a78bfa', margin: 0 }}>Cobro del producto entregado</p>
                                  </div>
                                  <span style={{ fontSize: 18, fontWeight: 900, color: '#7c3aed' }}>{fmt(dep.totalAlComercio)}</span>
                                </div>
                                {(comercioAccounts[o.userId || ''] || []).length > 0 ? (
                                  <div style={{ display: 'flex', flexDirection: 'column' as const, gap: 6 }}>
                                    <p style={{ fontSize: 10, fontWeight: 700, color: '#6d28d9', textTransform: 'uppercase' as const, margin: 0, letterSpacing: 0.5 }}>Cuentas del comercio:</p>
                                    {(comercioAccounts[o.userId || ''] || []).map((acc, ai) => (
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
                            )}
                            {dep.totalAStorkhub > 0 && (
                              <div style={{ background: '#eff6ff', border: '1px solid #bfdbfe', borderRadius: 10, padding: '10px 14px' }}>
                                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 8 }}>
                                  <div>
                                    <p style={{ fontSize: 11, fontWeight: 700, color: '#2563eb', textTransform: 'uppercase' as const, margin: '0 0 2px', letterSpacing: 0.5 }}>🏦 Depositar a Storkhub</p>
                                    <p style={{ fontSize: 11, color: '#60a5fa', margin: 0 }}>Delivery en efectivo</p>
                                  </div>
                                  <span style={{ fontSize: 18, fontWeight: 900, color: '#2563eb' }}>{fmt(dep.totalAStorkhub)}</span>
                                </div>
                                <div style={{ display: 'flex', flexDirection: 'column' as const, gap: 6 }}>
                                  <p style={{ fontSize: 10, fontWeight: 700, color: '#1e40af', textTransform: 'uppercase' as const, margin: 0, letterSpacing: 0.5 }}>Cuentas Storkhub:</p>
                                  {STORKHUB_ACCOUNTS.map((acc, ai) => (
                                    <div key={ai} style={{ background: '#dbeafe', border: '1px solid #bfdbfe', borderRadius: 8, padding: '7px 10px' }}>
                                      <p style={{ fontSize: 12, fontWeight: 700, color: '#1e3a8a', margin: '0 0 2px' }}>{acc.bank} · {acc.currency}</p>
                                      <p style={{ fontSize: 13, fontWeight: 800, color: '#1e40af', margin: '0 0 2px', fontFamily: 'monospace' }}>{acc.number}</p>
                                      <p style={{ fontSize: 11, color: '#3b82f6', margin: 0 }}>{acc.holder}</p>
                                    </div>
                                  ))}
                                </div>
                              </div>
                            )}
                            {dep.deliveryPorTransferencia && (
                              <div style={{ background: '#f0fdf4', border: '1px solid #bbf7d0', borderRadius: 10, padding: '10px 14px' }}>
                                <p style={{ fontSize: 12, color: '#16a34a', fontWeight: 600, margin: 0 }}>✓ Delivery pagado por transferencia — no hay efectivo que depositar por delivery</p>
                              </div>
                            )}
                          </div>

                          <p style={{ fontSize: 11, color: '#9ca3af', margin: '10px 0 0', padding: '8px 0 0', borderTop: '1px solid #f3f4f6' }}>{dep.descripcion}</p>
                        </div>
                      </div>
                    );
                  })}
                </>
              )}
          </>
        )}
      </div>
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
    <div style={{ flex: 1, background: bg, border: `1px solid ${border}`, borderRadius: 12, padding: '10px 10px' }}>
      <p style={{ fontSize: 22, fontWeight: 900, color, margin: '0 0 2px', letterSpacing: -1 }}>{value}</p>
      <p style={{ fontSize: 10, fontWeight: 600, color: '#9ca3af', margin: 0, textTransform: 'uppercase', letterSpacing: 0.3 }}>{label}</p>
    </div>
  );
}

type PointData = { nombreApellido?: string; celular?: string; direccionEscrita?: string; nota?: string | null; coord?: { lat: number; lng: number } | null; puntoGoogleLink?: string | null; puntoGoogleTexto?: string | null } | undefined;

function getMapsLink(point: PointData, coordOverride?: { lat: number; lng: number } | null): string | null {
  const coord = coordOverride ?? point?.coord;
  if (coord) return `https://www.google.com/maps?q=${coord.lat},${coord.lng}`;
  if (point?.puntoGoogleLink?.trim()) return point.puntoGoogleLink.trim();
  if (point?.puntoGoogleTexto?.trim()) return `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(point.puntoGoogleTexto.trim())}`;
  if (point?.direccionEscrita?.trim()) return `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(point.direccionEscrita.trim())}`;
  return null;
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
  const nota = point?.nota?.trim();

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