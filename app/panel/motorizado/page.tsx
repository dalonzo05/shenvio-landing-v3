'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import { onAuthStateChanged, User } from 'firebase/auth';
import {
  collection,
  onSnapshot,
  query,
  where,
  doc,
  serverTimestamp,
  Timestamp,
  writeBatch,
} from 'firebase/firestore';

import { auth, db } from '@/fb/config';

type EstadoSolicitud =
  | 'pendiente_confirmacion'
  | 'confirmada'
  | 'asignada'
  | 'en_camino_retiro'
  | 'retirado'
  | 'en_camino_entrega'
  | 'entregado';

type EstadoAceptacion = 'pendiente' | 'aceptada' | 'rechazada' | 'expirada';

type Solicitud = {
  id: string;
  estado?: EstadoSolicitud;
  createdAt?: Timestamp;
  updatedAt?: Timestamp;
  entregadoAt?: Timestamp;

  cliente?: {
    nombre?: string;
    telefono?: string;
    direccionTexto?: string;
  };

  comercio?: {
    nombre?: string;
    direccionTexto?: string;
  };

  recoleccion?: {
    nombreApellido?: string;
    celular?: string;
    direccionEscrita?: string;
  };

  entrega?: {
    nombreApellido?: string;
    celular?: string;
    direccionEscrita?: string;
  };

  confirmacion?: {
    precioFinalCordobas?: number;
  };

  asignacion?: {
    motorizadoId?: string;
    motorizadoAuthUid?: string;
    motorizadoNombre?: string;
    motorizadoTelefono?: string;
    asignadoAt?: Timestamp;
    aceptarAntesDe?: Timestamp;
    estadoAceptacion?: EstadoAceptacion;
    aceptadoAt?: Timestamp | null;
    rechazadoAt?: Timestamp | null;
    motivoRechazo?: string;
  } | null;
};

function tsToDate(v: any): Date | null {
  if (!v) return null;
  if (typeof v?.toDate === 'function') return v.toDate();
  if (v instanceof Date) return v;
  return null;
}

function formatMoney(n?: number) {
  if (typeof n !== 'number') return '-';
  return `C$ ${n}`;
}

function formatDateTime(v: any) {
  const d = tsToDate(v);
  if (!d) return '-';
  return d.toLocaleString();
}

function formatRemaining(ms: number) {
  if (ms <= 0) return '00:00';
  const totalSec = Math.floor(ms / 1000);
  const mm = Math.floor(totalSec / 60)
    .toString()
    .padStart(2, '0');
  const ss = (totalSec % 60).toString().padStart(2, '0');
  return `${mm}:${ss}`;
}

function getSemaforo(ms: number) {
  if (ms <= 0) return 'Vencido';
  if (ms <= 2 * 60 * 1000) return 'Urgente';
  if (ms <= 5 * 60 * 1000) return 'Atención';
  return 'A tiempo';
}

function sortByDateDesc(arr: Solicitud[], field: keyof Solicitud = 'createdAt') {
  return [...arr].sort((a, b) => {
    const da = tsToDate(a[field]);
    const db = tsToDate(b[field]);
    return (db?.getTime() || 0) - (da?.getTime() || 0);
  });
}

function estadoOrdenTexto(estado?: EstadoSolicitud) {
  switch (estado) {
    case 'asignada':
      return 'Asignada';
    case 'en_camino_retiro':
      return 'En camino a retiro';
    case 'retirado':
      return 'Retirado';
    case 'en_camino_entrega':
      return 'En camino a entrega';
    case 'entregado':
      return 'Entregado';
    case 'confirmada':
      return 'Confirmada';
    case 'pendiente_confirmacion':
      return 'Pendiente confirmación';
    default:
      return estado || '-';
  }
}

function estadoBadgeClass(estado?: EstadoSolicitud) {
  switch (estado) {
    case 'en_camino_retiro':
    case 'retirado':
    case 'en_camino_entrega':
      return 'bg-yellow-50 text-yellow-700 border-yellow-200';
    case 'entregado':
      return 'bg-green-50 text-green-700 border-green-200';
    case 'asignada':
      return 'bg-blue-50 text-blue-700 border-blue-200';
    default:
      return 'bg-gray-50 text-gray-700 border-gray-200';
  }
}

function getNextActions(estado?: EstadoSolicitud) {
  if (estado === 'asignada') {
    return ['en_camino_retiro', 'retirado', 'en_camino_entrega', 'entregado'] as EstadoSolicitud[];
  }

  if (estado === 'en_camino_retiro') {
    return ['retirado', 'en_camino_entrega', 'entregado'] as EstadoSolicitud[];
  }

  if (estado === 'retirado') {
    return ['en_camino_entrega', 'entregado'] as EstadoSolicitud[];
  }

  if (estado === 'en_camino_entrega') {
    return ['entregado'] as EstadoSolicitud[];
  }

  return [] as EstadoSolicitud[];
}

function actionLabel(estado: EstadoSolicitud) {
  switch (estado) {
    case 'en_camino_retiro':
      return 'Voy a retiro';
    case 'retirado':
      return 'Retirado';
    case 'en_camino_entrega':
      return 'En camino entrega';
    case 'entregado':
      return 'Entregado';
    default:
      return estado;
  }
}

export default function PanelMotorizadoPage() {
  const [user, setUser] = useState<User | null>(null);
  const [todasLasOrdenes, setTodasLasOrdenes] = useState<Solicitud[]>([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [actionLoadingId, setActionLoadingId] = useState<string | null>(null);
  const [nowTick, setNowTick] = useState(Date.now());

  useEffect(() => {
    const id = setInterval(() => setNowTick(Date.now()), 1000);
    return () => clearInterval(id);
  }, []);

  useEffect(() => {
    const unsub = onAuthStateChanged(auth, (u) => {
      setUser(u);
      setLoading(false);
    });
    return () => unsub();
  }, []);

  const cargarOrdenes = useCallback(() => {
    const currentUser = auth.currentUser;
    if (!currentUser) {
      setTodasLasOrdenes([]);
      setRefreshing(false);
      return () => {};
    }

    setRefreshing(true);
    setErr(null);

    const ref = collection(db, 'solicitudes_envio');
    const qByAuthUid = query(
      ref,
      where('asignacion.motorizadoAuthUid', '==', currentUser.uid)
    );

    const unsub = onSnapshot(
      qByAuthUid,
      (snap) => {
        const rows: Solicitud[] = snap.docs.map((d) => ({
          id: d.id,
          ...(d.data() as any),
        }));

        setTodasLasOrdenes(rows);
        setErr(null);
        setRefreshing(false);
      },
      (e) => {
        console.error(e);
        setErr('Error cargando órdenes del motorizado.');
        setRefreshing(false);
      }
    );

    return unsub;
  }, []);

  useEffect(() => {
    if (!user) {
      setTodasLasOrdenes([]);
      return;
    }

    const unsub = cargarOrdenes();

    return () => {
      if (typeof unsub === 'function') unsub();
    };
  }, [user, cargarOrdenes]);

  async function setMotorizadoEstado(motorizadoId: string | undefined, estado: string) {
    if (!motorizadoId) return;
    const motoRef = doc(db, 'motorizado', motorizadoId);
    return { ref: motoRef, estado };
  }

  async function aceptarOrden(orden: Solicitud) {
    if (!orden.id) return;

    setErr(null);
    setActionLoadingId(orden.id);

    try {
      const batch = writeBatch(db);
      const ordenRef = doc(db, 'solicitudes_envio', orden.id);

      batch.update(ordenRef, {
        'asignacion.estadoAceptacion': 'aceptada',
        'asignacion.aceptadoAt': serverTimestamp(),
        updatedAt: serverTimestamp(),
      });

      const motorizado = await setMotorizadoEstado(orden.asignacion?.motorizadoId, 'ocupado');
      if (motorizado) {
        batch.update(motorizado.ref, {
          estado: motorizado.estado,
          updatedAt: serverTimestamp(),
        });
      }

      await batch.commit();
    } catch (e) {
      console.error(e);
      setErr('No se pudo aceptar la orden.');
    } finally {
      setActionLoadingId(null);
    }
  }

  async function rechazarOrden(orden: Solicitud) {
    if (!orden.id) return;

    setErr(null);
    setActionLoadingId(orden.id);

    try {
      const batch = writeBatch(db);
      const ordenRef = doc(db, 'solicitudes_envio', orden.id);

      batch.update(ordenRef, {
        estado: 'confirmada',
        asignacion: null,
        updatedAt: serverTimestamp(),
      });

      const motorizado = await setMotorizadoEstado(orden.asignacion?.motorizadoId, 'disponible');
      if (motorizado) {
        batch.update(motorizado.ref, {
          estado: motorizado.estado,
          updatedAt: serverTimestamp(),
        });
      }

      await batch.commit();
    } catch (e) {
      console.error(e);
      setErr('No se pudo rechazar la orden.');
    } finally {
      setActionLoadingId(null);
    }
  }

  async function cambiarEstado(orden: Solicitud, nuevo: EstadoSolicitud) {
    if (!orden.id) return;

    setErr(null);
    setActionLoadingId(`${orden.id}:${nuevo}`);

    try {
      const batch = writeBatch(db);
      const ordenRef = doc(db, 'solicitudes_envio', orden.id);

      const payload: any = {
        estado: nuevo,
        updatedAt: serverTimestamp(),
      };

      if (nuevo === 'entregado') {
        payload.entregadoAt = serverTimestamp();
      }

      batch.update(ordenRef, payload);

      const nuevoEstadoMotorizado = nuevo === 'entregado' ? 'disponible' : 'ocupado';
      const motorizado = await setMotorizadoEstado(orden.asignacion?.motorizadoId, nuevoEstadoMotorizado);

      if (motorizado) {
        batch.update(motorizado.ref, {
          estado: motorizado.estado,
          updatedAt: serverTimestamp(),
        });
      }

      await batch.commit();
    } catch (e) {
      console.error(e);
      setErr('No se pudo cambiar el estado.');
    } finally {
      setActionLoadingId(null);
    }
  }

  const ordenesDelMotorizado = useMemo(() => {
    if (!user) return [];
    return sortByDateDesc(todasLasOrdenes);
  }, [todasLasOrdenes, user]);

  const pendientes = useMemo(() => {
    const rows = ordenesDelMotorizado.filter((o) => {
      return o.estado === 'asignada' && o.asignacion?.estadoAceptacion === 'pendiente';
    });

    return rows.map((o) => {
      const deadline = tsToDate(o.asignacion?.aceptarAntesDe);
      const ms = deadline ? deadline.getTime() - nowTick : 0;

      return {
        ...o,
        restanteMs: ms,
        restanteTexto: formatRemaining(ms),
        semaforo: getSemaforo(ms),
      };
    });
  }, [ordenesDelMotorizado, nowTick]);

  const enCurso = useMemo(() => {
    return ordenesDelMotorizado.filter((o) => {
      return (
        o.asignacion?.estadoAceptacion === 'aceptada' &&
        ['asignada', 'en_camino_retiro', 'retirado', 'en_camino_entrega'].includes(o.estado || '')
      );
    });
  }, [ordenesDelMotorizado]);

  const historial = useMemo(() => {
    return sortByDateDesc(
      ordenesDelMotorizado.filter((o) => o.estado === 'entregado'),
      'entregadoAt'
    );
  }, [ordenesDelMotorizado]);

  if (loading) {
    return <div className="max-w-5xl mx-auto p-6">Cargando panel motorizado...</div>;
  }

  if (!user) {
    return (
      <div className="max-w-5xl mx-auto p-6">
        <h1 className="text-2xl font-bold mb-2">Panel Motorizado</h1>
        <p className="text-gray-600">Debes iniciar sesión para ver tus órdenes.</p>
      </div>
    );
  }

  return (
    <div className="max-w-6xl mx-auto p-4 md:p-6 space-y-8">
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div>
          <h1 className="text-2xl font-bold">Panel Motorizado</h1>
          <p className="text-sm text-gray-600 mt-1">Usuario actual: {user.email || '-'}</p>
          <p className="text-sm text-gray-600">UID actual: {user.uid}</p>
          <p className="text-sm text-gray-600">
            Órdenes del motorizado: {ordenesDelMotorizado.length}
          </p>
          {err && <p className="text-sm text-red-600 mt-2">{err}</p>}
        </div>

        <button
          onClick={() => {
            const unsub = cargarOrdenes();
            if (typeof unsub === 'function') {
              setTimeout(() => unsub(), 200);
            }
          }}
          className="px-4 py-2 rounded-lg border"
          disabled={refreshing}
        >
          {refreshing ? 'Actualizando...' : 'Actualizar'}
        </button>
      </div>

      <section className="border rounded-xl p-4 bg-white shadow-sm">
        <h2 className="text-xl font-semibold mb-4">Pendientes de aceptar</h2>

        {pendientes.length === 0 ? (
          <p className="text-gray-500">No tienes órdenes pendientes por aceptar.</p>
        ) : (
          <div className="grid gap-4">
            {pendientes.map((o: any) => (
              <div key={o.id} className="border rounded-lg p-4">
                <div className="flex flex-wrap items-center justify-between gap-2 mb-3">
                  <div>
                    <p className="font-semibold">Orden #{o.id.slice(0, 6)}</p>
                    <p className="text-sm text-gray-600">Asignada por aceptar</p>
                  </div>

                  <div className="text-right">
                    <p className="text-sm font-medium">{o.semaforo}</p>
                    <p className="text-sm text-gray-600">{o.restanteTexto}</p>
                  </div>
                </div>

                <div className="grid md:grid-cols-2 gap-3 text-sm">
                  <div>
                    <p>
                      <span className="font-medium">Remitente:</span>{' '}
                      {o.recoleccion?.nombreApellido || o.cliente?.nombre || '-'}
                    </p>
                    <p>
                      <span className="font-medium">Teléfono:</span>{' '}
                      {o.recoleccion?.celular || o.cliente?.telefono || '-'}
                    </p>
                    <p>
                      <span className="font-medium">Retiro:</span>{' '}
                      {o.recoleccion?.direccionEscrita || o.comercio?.direccionTexto || '-'}
                    </p>
                  </div>

                  <div>
                    <p>
                      <span className="font-medium">Destinatario:</span>{' '}
                      {o.entrega?.nombreApellido || '-'}
                    </p>
                    <p>
                      <span className="font-medium">Teléfono:</span> {o.entrega?.celular || '-'}
                    </p>
                    <p>
                      <span className="font-medium">Entrega:</span>{' '}
                      {o.entrega?.direccionEscrita || '-'}
                    </p>
                    <p>
                      <span className="font-medium">Precio final:</span>{' '}
                      {formatMoney(o.confirmacion?.precioFinalCordobas)}
                    </p>
                  </div>
                </div>

                <div className="mt-4 grid grid-cols-2 gap-2 sm:flex sm:flex-wrap">
                  <button
                    onClick={() => aceptarOrden(o)}
                    disabled={actionLoadingId === o.id}
                    className="w-full sm:w-auto px-4 py-2 rounded-lg bg-black text-white disabled:opacity-60"
                  >
                    {actionLoadingId === o.id ? 'Procesando...' : 'Aceptar'}
                  </button>

                  <button
                    onClick={() => rechazarOrden(o)}
                    disabled={actionLoadingId === o.id}
                    className="w-full sm:w-auto px-4 py-2 rounded-lg border disabled:opacity-60"
                  >
                    {actionLoadingId === o.id ? 'Procesando...' : 'Rechazar'}
                  </button>
                </div>
              </div>
            ))}
          </div>
        )}
      </section>

      <section className="border rounded-xl p-4 bg-white shadow-sm">
        <h2 className="text-xl font-semibold mb-4">Órdenes en curso</h2>

        {enCurso.length === 0 ? (
          <p className="text-gray-500">No tienes órdenes en curso.</p>
        ) : (
          <div className="grid gap-4">
            {enCurso.map((o) => {
              const actions = getNextActions(o.estado);

              return (
                <div key={o.id} className="border rounded-lg p-4">
                  <div className="flex flex-wrap items-center justify-between gap-2 mb-3">
                    <div>
                      <p className="font-semibold">Orden #{o.id.slice(0, 6)}</p>
                      <div className="mt-1">
                        <span
                          className={`inline-flex rounded-full border px-2.5 py-1 text-xs font-medium ${estadoBadgeClass(
                            o.estado
                          )}`}
                        >
                          {estadoOrdenTexto(o.estado)}
                        </span>
                      </div>
                    </div>

                    <div className="text-right text-sm text-gray-600">
                      <p>Aceptada: {formatDateTime(o.asignacion?.aceptadoAt)}</p>
                    </div>
                  </div>

                  <div className="grid md:grid-cols-2 gap-3 text-sm">
                    <div>
                      <p>
                        <span className="font-medium">Remitente:</span>{' '}
                        {o.recoleccion?.nombreApellido || o.cliente?.nombre || '-'}
                      </p>
                      <p>
                        <span className="font-medium">Teléfono:</span>{' '}
                        {o.recoleccion?.celular || o.cliente?.telefono || '-'}
                      </p>
                      <p>
                        <span className="font-medium">Retiro:</span>{' '}
                        {o.recoleccion?.direccionEscrita || o.comercio?.direccionTexto || '-'}
                      </p>
                    </div>

                    <div>
                      <p>
                        <span className="font-medium">Destinatario:</span>{' '}
                        {o.entrega?.nombreApellido || '-'}
                      </p>
                      <p>
                        <span className="font-medium">Teléfono:</span> {o.entrega?.celular || '-'}
                      </p>
                      <p>
                        <span className="font-medium">Entrega:</span>{' '}
                        {o.entrega?.direccionEscrita || '-'}
                      </p>
                      <p>
                        <span className="font-medium">Precio final:</span>{' '}
                        {formatMoney(o.confirmacion?.precioFinalCordobas)}
                      </p>
                    </div>
                  </div>

                  <div className="mt-4 grid grid-cols-2 gap-2 sm:flex sm:flex-wrap">
                    {actions.map((accion) => {
                      const isPrimary = accion === 'entregado';
                      const loadingKey = `${o.id}:${accion}`;

                      return (
                        <button
                          key={accion}
                          onClick={() => cambiarEstado(o, accion)}
                          disabled={actionLoadingId === loadingKey}
                          className={`w-full sm:w-auto px-4 py-2 rounded-lg disabled:opacity-60 ${
                            isPrimary
                              ? 'bg-green-600 text-white'
                              : 'border'
                          }`}
                        >
                          {actionLoadingId === loadingKey
                            ? 'Procesando...'
                            : actionLabel(accion)}
                        </button>
                      );
                    })}
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </section>

      <section className="border rounded-xl p-4 bg-white shadow-sm">
        <h2 className="text-xl font-semibold mb-4">Historial</h2>

        {historial.length === 0 ? (
          <p className="text-gray-500">Aún no hay entregas en historial.</p>
        ) : (
          <div className="grid gap-4">
            {historial.map((o) => (
              <div key={o.id} className="border rounded-lg p-4">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <div>
                    <p className="font-semibold">Orden #{o.id.slice(0, 6)}</p>
                    <p className="text-sm text-gray-600">
                      Destinatario: {o.entrega?.nombreApellido || '-'}
                    </p>
                  </div>

                  <div className="text-right text-sm text-gray-600">
                    <p>Entregada: {formatDateTime(o.entregadoAt)}</p>
                    <p>Precio: {formatMoney(o.confirmacion?.precioFinalCordobas)}</p>
                  </div>
                </div>
              </div>
            ))}
          </div>
        )}
      </section>
    </div>
  );
}