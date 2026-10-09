// FIN-1D — a qué liquidación semanal pertenece un depósito y cuánto aporta a ella.
//
// Antes (y en la primera versión de FIN-1D) un depósito se asignaba a una semana por `creadoAt`. Pero el motorizado agrupa en UN depósito las órdenes
// entregadas que aún no depositó, de cualquier fecha: el depósito del lunes por el efectivo del domingo caía en la semana siguiente y la anterior
// parecía deber ese efectivo (un saldo que, además, no tiene corrección). `creadoAt` es solo metadata temporal del depósito.
//
// Ahora la semana económica de un depósito la dan SUS ÓRDENES:
//   · es relevante para la liquidación si contiene al menos una orden de la semana (intersección de `solicitudIds` con las órdenes elegibles);
//   · si no trae `solicitudIds` (depósito anterior a ese contrato) solo se vincula con una fuente persistida inequívoca: el puntero que su
//     depósito dejó en cada orden (`registro.deposito.storkhubDepositoId`). Sin vínculo demostrable → conciliacion_requerida (NUNCA por fecha);
//   · un depósito relevante NO terminal (pendiente_boucher, en_revision, devuelto, desconocido) bloquea la liquidación aunque se haya creado
//     fuera de la semana; anulado y rechazado se ignoran;
//   · su monto se DEMUESTRA con la misma función que usan la confirmación y la conversión (demostrarDeposito: órdenes, gastos y monto); si no
//     coincide → conciliacion_requerida;
//   · la contribución a la semana es exacta o no es: si todas sus órdenes son de la semana aporta su monto completo; si mezcla semanas aporta
//     solo el efectivo de las órdenes de ESTA semana (calcularDeposito) menos los gastos que el propio gasto liga a esas órdenes. Sin prorrata ni
//     reparto inventado: una mezcla cuya parte exacta no se pueda obtener es conciliacion_requerida;
//   · una orden de la semana en más de un depósito relevante vivo es una cobertura duplicada: conciliacion_requerida.

import { HttpsError } from 'firebase-functions/v2/https';
import { demostrarDeposito, idsUnicos, type LecturasDeposito } from './deposito-monto';
import { rechazoOp } from './finanzas-operativas-comun';
import { aCentavos, efectivoAStorkhubOrden, TIPO_DEPOSITO_STORKHUB_LIQ, type DocConId } from './liquidacion-calculo';

const ESTADOS_SUMAN = ['confirmado', 'convertido_en_deuda'];
const ESTADOS_IGNORADOS = ['anulado', 'rechazado'];

export interface LecturasAtribucion extends LecturasDeposito {
  /** Órdenes cuyo puntero `registro.deposito.storkhubDepositoId` apunta a ese depósito (vínculo de un depósito sin solicitudIds). */
  getOrdenesPorPunteroDeposito(depositoId: string): Promise<DocConId[]>;
}

export interface DepositoAtribuido {
  id: string;
  /** Lo que el depósito aporta a ESTA semana, en centavos (neto de los gastos que descontó para estas órdenes). */
  contribucion: number;
  /** Gastos que el depósito descontó para las órdenes de esta semana, en centavos. */
  gastos: number;
  /** true si TODAS las órdenes del depósito son de esta semana. */
  completo: boolean;
  /** Órdenes de esta semana que cubre. */
  ordenes: string[];
}

const conciliar = (mensaje: string, extra: Record<string, unknown> = {}): HttpsError =>
  rechazoOp('conciliacion_requerida', mensaje, extra);

export async function atribuirDepositos(tx: LecturasAtribucion, depositos: DocConId[], ordenesSemana: DocConId[]): Promise<DepositoAtribuido[]> {
  const semanaIds = new Set(ordenesSemana.map((o) => o.id));
  const ordenPorId = new Map(ordenesSemana.map((o) => [o.id, o.data]));

  // 1 · ¿Qué depósitos de StorkHub tocan órdenes de esta semana?
  const relevantes: Array<{ dep: DocConId; ids: string[]; estado: string; viaPuntero: boolean }> = [];
  for (const dep of [...depositos].sort((a, b) => a.id.localeCompare(b.id))) {
    const tipo = dep.data.tipo;
    if (tipo !== undefined && tipo !== null && tipo !== '' && tipo !== TIPO_DEPOSITO_STORKHUB_LIQ) continue;
    const estado = String(dep.data.estado ?? '');
    if (ESTADOS_IGNORADOS.includes(estado)) continue;
    let ids = idsUnicos(dep.data.solicitudIds);
    let viaPuntero = false;
    if (ids.length === 0) {
      ids = (await tx.getOrdenesPorPunteroDeposito(dep.id)).map((o) => o.id);
      viaPuntero = true;
      if (ids.length === 0) {
        throw conciliar('Hay un depósito sin órdenes asociadas y sin punteros que lo vinculen: no se puede saber a qué semana pertenece. Hay que conciliarlo.', { depositoId: dep.id });
      }
    }
    if (!ids.some((id) => semanaIds.has(id))) continue;
    relevantes.push({ dep, ids, estado, viaPuntero });
  }

  // 2 · Un depósito relevante NO terminal bloquea (aunque se haya creado fuera de la semana).
  const pendientes = relevantes.filter((r) => !ESTADOS_SUMAN.includes(r.estado));
  if (pendientes.length > 0) {
    throw rechazoOp('deposito_pendiente_conciliacion', 'Hay un depósito con órdenes de esa semana todavía sin resolver (pendiente de boucher, en revisión o devuelto): resolvelo antes de liquidar.', {
      depositosIds: pendientes.map((r) => r.dep.id).slice(0, 10),
    });
  }

  // 3 · Cobertura duplicada: una orden de la semana en más de un depósito.
  const cobertura = new Map<string, string>();
  for (const r of relevantes) {
    for (const id of r.ids) {
      if (!semanaIds.has(id)) continue;
      const otro = cobertura.get(id);
      if (otro && otro !== r.dep.id) {
        throw conciliar('Una orden de esa semana figura en más de un depósito: la cobertura está duplicada. Hay que conciliarlo: no se cuenta dos veces.', { ordenId: id, depositosIds: [otro, r.dep.id] });
      }
      cobertura.set(id, r.dep.id);
    }
  }

  // 4 · Demostrar cada depósito y atribuir su contribución exacta.
  const resultado: DepositoAtribuido[] = [];
  for (const r of relevantes) {
    const enSemana = r.ids.filter((id) => semanaIds.has(id));
    const completo = enSemana.length === r.ids.length;
    // La misma demostración que la confirmación y la conversión (órdenes, gastos y monto). Para un depósito sin solicitudIds, las del puntero.
    let demo;
    try {
      demo = await demostrarDeposito(tx, { ...r.dep.data, solicitudIds: r.ids }, r.dep.id);
    } catch (e) {
      if (e instanceof HttpsError && e.code === 'failed-precondition') {
        const motivo = (e.details as { motivo?: string } | undefined)?.motivo ?? null;
        throw conciliar('Un depósito de esa semana no se puede demostrar contra sus órdenes y gastos: su monto o su contenido no cuadran. Hay que conciliarlo.', { depositoId: r.dep.id, motivoDeposito: motivo });
      }
      throw e;
    }
    const brutoSemana = enSemana.reduce((s, id) => s + efectivoAStorkhubOrden(ordenPorId.get(id) ?? {}), 0);
    const gastosDeposito = aCentavos(demo.gastosDescontados);

    if (completo) {
      resultado.push({ id: r.dep.id, contribucion: aCentavos(demo.montoTotal), gastos: gastosDeposito, completo: true, ordenes: enSemana });
      continue;
    }

    // Depósito que mezcla semanas: solo la parte exacta de ESTA semana.
    if (gastosDeposito === 0) {
      resultado.push({ id: r.dep.id, contribucion: brutoSemana, gastos: 0, completo: false, ordenes: enSemana });
      continue;
    }
    // Con gastos: cada gasto debe ligarse (ordenId) a una orden del depósito, y el depósito no puede haber recortado el monto a 0 (el recorte
    // pierde la parte de cada semana). Si no, no hay atribución exacta.
    if (gastosDeposito > aCentavos(demo.montoBruto)) {
      throw conciliar('Un depósito que mezcla semanas descontó más gastos que su efectivo: no se puede atribuir con exactitud a cada semana. Hay que conciliarlo.', { depositoId: r.dep.id });
    }
    let gastosSemana = 0;
    for (const gid of idsUnicos(r.dep.data.gastosIds)) {
      const g = await tx.getGasto(gid);
      const ordenId = g && typeof g.ordenId === 'string' ? g.ordenId : '';
      if (!g || !r.ids.includes(ordenId)) {
        throw conciliar('Un depósito que mezcla semanas descontó un gasto que no está ligado a una de sus órdenes: no se puede atribuir con exactitud a cada semana. Hay que conciliarlo.', { depositoId: r.dep.id, gastoId: gid });
      }
      if (semanaIds.has(ordenId)) gastosSemana += aCentavos(g.monto);
    }
    const contribucion = brutoSemana - gastosSemana;
    if (contribucion < 0) {
      throw conciliar('Un depósito que mezcla semanas descontó, para las órdenes de esta semana, más gastos que su efectivo: no hay atribución exacta. Hay que conciliarlo.', { depositoId: r.dep.id });
    }
    resultado.push({ id: r.dep.id, contribucion, gastos: gastosSemana, completo: false, ordenes: enSemana });
  }
  return resultado;
}
