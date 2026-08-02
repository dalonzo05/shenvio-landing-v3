// ═══════════════════════════════════════════════════════════════════════════
// acumularCobroSemanalPorOrden — Callable (P1: cerrar la lectura transversal)
// ═══════════════════════════════════════════════════════════════════════════
//
// Antes, el propio motorizado abría cobros_semanales desde el cliente para
// acumular la entrega de una orden a crédito. Eso obligaba a concederle
// `read` sobre TODA la colección — no existe ningún campo que ligue un
// motorizado con el crédito de un comercio, así que la regla no podía
// acotarse. Resultado: cualquier motorizado activo podía enumerar la cartera
// completa (razón social, deuda, pagos y notas con referencias bancarias).
//
// Al mover la acumulación acá, el cliente deja de necesitar esa lectura y las
// reglas pueden cerrarse a gestor/admin. El motorizado solo envía `ordenId`;
// todo lo demás (comercio, precio, semana) se resuelve server-side desde
// fuentes que él no controla.
//
// El cliente conserva la transición operativa a 'entregado' (Opción B): mover
// todo el payload de entrega aquí implicaría duplicar ramas de negocio
// (fuera_managua, cargotrans, terminal, cobro contra entrega) ya probadas. A
// cambio, la orden lleva un marcador `acumulacionCobroSemanal` que hace
// detectable —y reintentable— la ventana entre "entregada" y "acumulada".

import { onCall, HttpsError } from 'firebase-functions/v2/https';
import * as admin from 'firebase-admin';
import { FieldValue, Timestamp } from 'firebase-admin/firestore';

type Payload = { ordenId?: unknown };

const MAX_ORDEN_ID = 200;

// Nicaragua no aplica horario de verano: el desfase es constante.
const MANAGUA_UTC_OFFSET_MIN = -6 * 60;

/**
 * semanaKey ISO-8601 calculado en horario de Managua.
 *
 * El cliente lo calculaba con la zona horaria DEL DISPOSITIVO. Al pasar el
 * cálculo al servidor (que corre en UTC) una entrega de domingo por la noche
 * en Nicaragua caería en la semana siguiente. Se fija America/Managua para
 * que la semana sea la misma que ve el operador, y además deja de depender
 * de cómo tenga configurado el teléfono cada motorizado.
 */
export function semanaKeyDeFecha(fecha: Date): string {
  const local = new Date(fecha.getTime() + MANAGUA_UTC_OFFSET_MIN * 60_000);
  const d = new Date(Date.UTC(local.getUTCFullYear(), local.getUTCMonth(), local.getUTCDate()));
  const day = d.getUTCDay() || 7;
  d.setUTCDate(d.getUTCDate() + 4 - day);
  const yearStart = new Date(Date.UTC(d.getUTCFullYear(), 0, 1));
  const week = Math.ceil(((d.getTime() - yearStart.getTime()) / 86400000 + 1) / 7);
  return `${d.getUTCFullYear()}-W${String(week).padStart(2, '0')}`;
}

/** Lunes 00:00 y domingo 23:59:59.999 de la semana, en horario de Managua. */
export function rangoDeSemana(semanaKey: string): { inicio: Date; fin: Date } {
  const [yearStr, weekStr] = semanaKey.split('-W');
  const year = parseInt(yearStr, 10);
  const week = parseInt(weekStr, 10);
  const jan4 = new Date(Date.UTC(year, 0, 4));
  const jan4Day = jan4.getUTCDay() || 7;
  const lunes = new Date(jan4);
  lunes.setUTCDate(jan4.getUTCDate() - jan4Day + 1 + (week - 1) * 7);
  lunes.setUTCHours(0, 0, 0, 0);
  const domingo = new Date(lunes);
  domingo.setUTCDate(lunes.getUTCDate() + 6);
  domingo.setUTCHours(23, 59, 59, 999);
  // De hora local de Managua a instante absoluto.
  const aUtc = (d: Date) => new Date(d.getTime() - MANAGUA_UTC_OFFSET_MIN * 60_000);
  return { inicio: aUtc(lunes), fin: aUtc(domingo) };
}

/** Fecha de entrega canónica: entregadoAt, con historial.entregadoAt de respaldo. */
function fechaDeEntrega(orden: FirebaseFirestore.DocumentData): Date | null {
  const candidatos = [orden.entregadoAt, orden.historial?.entregadoAt];
  for (const c of candidatos) {
    if (c instanceof Timestamp) return c.toDate();
    if (c?.toDate instanceof Function) return c.toDate();
  }
  return null;
}

function esCredito(orden: FirebaseFirestore.DocumentData): boolean {
  return orden.tipoCliente === 'credito' || orden.pagoDelivery?.quienPaga === 'credito_semanal';
}

/** El comercio se resuelve SOLO desde la orden, nunca desde el payload. */
function comercioDeOrden(orden: FirebaseFirestore.DocumentData): string {
  const uid = orden.ownerSnapshot?.uid || orden.userId || '';
  return typeof uid === 'string' ? uid.trim() : '';
}

function tieneEvidenciaEntrega(orden: FirebaseFirestore.DocumentData): boolean {
  // Mismas rutas alternativas que exige el gate de foto del cliente: una
  // entrega fuera de Managua acredita con evidencia de terminal o cargotrans.
  if (orden.evidencias?.entrega) return true;
  if (orden.evidenciasTerminal?.fotoPaquete) return true;
  if (Array.isArray(orden.evidenciasCargotrans?.fotos) && orden.evidenciasCargotrans.fotos.length > 0) return true;
  return false;
}

export const acumularCobroSemanalPorOrden = onCall<Payload>(async (request) => {
  const db = admin.firestore();

  // ── 1. Autenticado ──────────────────────────────────────────────────────
  if (!request.auth) throw new HttpsError('unauthenticated', 'Debés iniciar sesión.');
  const motorizadoUid = request.auth.uid;

  // ── 2-4. Payload: exactamente { ordenId } y nada más ─────────────────────
  // Se rechaza cualquier campo extra en vez de ignorarlo: si el cliente
  // intenta mandar monto/semanaKey/comercioId, es un error del que hay que
  // enterarse, no algo que convenga silenciar.
  const data = request.data;
  if (typeof data !== 'object' || data === null || Array.isArray(data)) {
    throw new HttpsError('invalid-argument', 'Payload inválido.');
  }
  const claves = Object.keys(data);
  if (claves.length !== 1 || claves[0] !== 'ordenId') {
    throw new HttpsError('invalid-argument', 'Solo se acepta el campo ordenId.');
  }
  const ordenId = typeof data.ordenId === 'string' ? data.ordenId.trim() : '';
  if (!ordenId || ordenId.length > MAX_ORDEN_ID) {
    throw new HttpsError('invalid-argument', 'ordenId inválido.');
  }

  // ── 5-7. Usuario activo con rol motorizado ──────────────────────────────
  const usuarioSnap = await db.collection('usuarios').doc(motorizadoUid).get();
  const usuario = usuarioSnap.data();
  if (!usuarioSnap.exists || usuario?.activo !== true || usuario?.rol !== 'motorizado') {
    throw new HttpsError('permission-denied', 'Solo un motorizado activo puede acumular una entrega.');
  }

  const ordenRef = db.collection('solicitudes_envio').doc(ordenId);

  // Pre-lectura fuera de la transacción para validar y decidir el documento
  // semanal. Todo lo que decide dinero se vuelve a leer DENTRO de la
  // transacción — esta pasada solo sirve para fallar rápido y con un mensaje
  // útil, nunca como base de la escritura.
  const ordenPre = await ordenRef.get();
  if (!ordenPre.exists) throw new HttpsError('not-found', 'La orden no existe.');
  const orden = ordenPre.data()!;

  // ── 9. Asignada a quien llama ───────────────────────────────────────────
  if (orden.asignacion?.motorizadoAuthUid !== motorizadoUid) {
    throw new HttpsError('permission-denied', 'Esta orden no está asignada a vos.');
  }
  // ── 10-12. Crédito, entregada y con evidencia ───────────────────────────
  if (!esCredito(orden)) {
    throw new HttpsError('failed-precondition', 'La orden no es de crédito semanal.');
  }
  if (orden.estado !== 'entregado') {
    throw new HttpsError('failed-precondition', 'La orden todavía no está entregada.');
  }
  if (!tieneEvidenciaEntrega(orden)) {
    throw new HttpsError('failed-precondition', 'La entrega no tiene evidencia registrada.');
  }
  // ── 13. Comercio resoluble ──────────────────────────────────────────────
  const comercioUid = comercioDeOrden(orden);
  if (!comercioUid) {
    throw new HttpsError('failed-precondition', 'No se pudo determinar el comercio de la orden.');
  }
  // ── 14. Precio definitivo, numérico y positivo ──────────────────────────
  const precio = orden.confirmacion?.precioFinalCordobas;
  if (typeof precio !== 'number' || !Number.isFinite(precio) || precio <= 0) {
    throw new HttpsError('failed-precondition', 'La orden no tiene un precio final válido.');
  }
  // ── 15-16. Semana derivada de la FECHA DE ENTREGA, no de ahora ──────────
  // Un reintento días después tiene que caer en la semana en que se entregó.
  const entregadoEn = fechaDeEntrega(orden);
  if (!entregadoEn || Number.isNaN(entregadoEn.getTime())) {
    throw new HttpsError('failed-precondition', 'La orden no tiene fecha de entrega válida.');
  }
  const semanaKey = semanaKeyDeFecha(entregadoEn);

  // ── 17. Documento semanal determinístico ────────────────────────────────
  const cobroSemanalId = `${comercioUid}_${semanaKey}`;
  const cobroRef = db.collection('cobros_semanales').doc(cobroSemanalId);

  // ── 18. Todo lo que escribe dinero, en una sola transacción ─────────────
  const resultado = await db.runTransaction(async (tx) => {
    const [cobroSnap, ordenSnap] = await Promise.all([tx.get(cobroRef), tx.get(ordenRef)]);

    // Relectura defensiva: entre la pre-lectura y la transacción el estado
    // pudo cambiar (una reversión del gestor, por ejemplo).
    const ordenAhora = ordenSnap.data();
    if (!ordenSnap.exists || ordenAhora?.estado !== 'entregado') {
      throw new HttpsError('failed-precondition', 'La orden dejó de estar entregada.');
    }

    const marcadorAcumulado = {
      'acumulacionCobroSemanal.estado': 'acumulado',
      'acumulacionCobroSemanal.cobroSemanalId': cobroSemanalId,
      'acumulacionCobroSemanal.updatedAt': FieldValue.serverTimestamp(),
      'acumulacionCobroSemanal.motivo': FieldValue.delete(),
    };

    // ── Idempotencia: la orden ya está contabilizada ──────────────────────
    // La verdad la tiene ordenesIds, no el marcador: si una ejecución previa
    // acumuló pero se cortó antes de marcar la orden, hay que corregir el
    // marcador SIN volver a sumar.
    const ordenesIds: string[] = Array.isArray(cobroSnap.data()?.ordenesIds) ? cobroSnap.data()!.ordenesIds : [];
    if (cobroSnap.exists && ordenesIds.includes(ordenId)) {
      tx.update(ordenRef, marcadorAcumulado);
      return { yaAcumulada: true, totalMonto: cobroSnap.data()!.totalMonto as number };
    }

    if (!cobroSnap.exists) {
      // ── Alta de la semana: nace sin cobrar ─────────────────────────────
      const { inicio, fin } = rangoDeSemana(semanaKey);
      tx.set(cobroRef, {
        clienteUid: comercioUid,
        clienteNombre: ordenAhora?.ownerSnapshot?.nombre ?? '',
        clienteCompany: ordenAhora?.ownerSnapshot?.companyName ?? '',
        semanaKey,
        semanaInicio: Timestamp.fromDate(inicio),
        semanaFin: Timestamp.fromDate(fin),
        totalMonto: precio,
        totalPagado: 0,
        estado: 'pendiente',
        pagos: [],
        ordenesIds: [ordenId],
        creadoAt: FieldValue.serverTimestamp(),
        updatedAt: FieldValue.serverTimestamp(),
      });
      tx.update(ordenRef, marcadorAcumulado);
      return { yaAcumulada: false, totalMonto: precio };
    }

    // ── Acumulación sobre una semana existente ───────────────────────────
    const cobro = cobroSnap.data()!;
    const totalMontoAnterior = typeof cobro.totalMonto === 'number' ? cobro.totalMonto : 0;
    const totalPagado = typeof cobro.totalPagado === 'number' ? cobro.totalPagado : 0;
    const nuevoTotalMonto = totalMontoAnterior + precio;

    const patch: FirebaseFirestore.UpdateData<FirebaseFirestore.DocumentData> = {
      totalMonto: FieldValue.increment(precio),
      ordenesIds: FieldValue.arrayUnion(ordenId),
      updatedAt: FieldValue.serverTimestamp(),
    };

    // ── Semana ya saldada que recibe una entrega nueva ───────────────────
    // No se rechaza la entrega ni se abre un segundo documento: la deuda es
    // real y tiene que verse. Se reabre a 'parcial' dejando intactos
    // totalPagado y pagos[] — lo ya cobrado no se toca, solo reaparece el
    // saldo. reabiertoAt/reabiertoPorOrdenId dejan el rastro de por qué una
    // semana cerrada volvió a tener saldo.
    if (cobro.estado === 'pagado') {
      patch.estado = 'parcial';
      patch.reabiertoAt = FieldValue.serverTimestamp();
      patch.reabiertoPorOrdenId = ordenId;
    }

    tx.update(cobroRef, patch);
    tx.update(ordenRef, marcadorAcumulado);
    return { yaAcumulada: false, totalMonto: nuevoTotalMonto, totalPagado, reabierto: cobro.estado === 'pagado' };
  });

  // ── 20. Log sin datos personales ────────────────────────────────────────
  // Se registran identificadores y montos, nunca razón social, teléfono,
  // dirección ni las notas de pago (que contienen referencias bancarias).
  console.log(
    JSON.stringify({
      fn: 'acumularCobroSemanalPorOrden',
      ordenId,
      motorizadoUid,
      comercioUid,
      semanaKey,
      cobroSemanalId,
      montoAcumulado: resultado.yaAcumulada ? 0 : precio,
      yaAcumulada: resultado.yaAcumulada,
      reabierto: resultado.reabierto === true,
    })
  );

  return {
    ok: true as const,
    yaAcumulada: resultado.yaAcumulada,
    cobroSemanalId,
    totalMonto: resultado.totalMonto,
  };
});
