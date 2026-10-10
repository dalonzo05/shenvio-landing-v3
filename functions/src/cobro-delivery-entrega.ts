// COMERCIO-PAGOS-PRE-ENTREGA — el cobroDelivery que nace al entregar.
//
// confirmarTransicionConCobro REEMPLAZA el mapa `cobroDelivery` completo (patch.cobroDelivery = {...}): es lo que permite que el
// servidor sea dueño de monto, tipoCliente, quienPaga, estado y formaPago sin confiar en nada que el cliente haya dejado escrito. El
// costo: un comercio que subió su boucher ANTES de la entrega (estado 'en_revision_deposito' + boucherComercio + boucherVigente) lo
// perdía —el estado volvía a 'pendiente', el gestor dejaba de verlo y el archivo quedaba huérfano en Storage—.
//
// Se conserva el reemplazo del mapa (todo lo económico sigue saliendo del servidor) y, SOLO cuando se cumple la condición de abajo, se
// reinyectan las claves del comprobante. Nada económico del cliente se arrastra: ni monto, ni estado derivado, ni tipoCliente.

import { FieldValue } from 'firebase-admin/firestore';
import { semanaKeyDeFecha } from './cobro-semanal';
import { calcularMontoCobroDelivery } from './cobro-delivery-monto';
import { resolverFormaPago } from './medio-pago';

export interface RespuestaCobroEntrega {
  recibio: boolean;
  justificacion?: string;
}

/** Únicas claves del comprobante que sobreviven a la entrega. */
const CLAVES_BOUCHER = ['boucherComercio', 'boucherGestor', 'boucherVigente', 'boucherUrl', 'boucherPath', 'boucherAt', 'subidoPor'] as const;

const esMapa = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const refConUrl = (v: unknown): boolean => esMapa(v) && typeof v.url === 'string' && v.url.trim() !== '' && typeof v.path === 'string' && v.path !== '';

/**
 * Reinyecta el comprobante previo en el cobroDelivery recién calculado.
 *
 * Condición (todas): el anterior está 'en_revision_deposito' con un comprobante VIGENTE completo; el calculado sigue 'pendiente' (si la
 * entrega lo cerró como pagado/no_cobrar no hay nada que revisar); la orden es de flujo transferencia y NO crédito (un boucher de
 * cualquier otra orden es ruido, y el crédito semanal no se cobra por orden). En cualquier otro caso devuelve el calculado intacto, es
 * decir, el comportamiento de siempre.
 */
export function conservarBoucherPrevio(previo: unknown, calculado: Record<string, unknown>): Record<string, unknown> {
  if (!esMapa(previo) || previo.estado !== 'en_revision_deposito') return calculado;
  if (calculado.estado !== 'pendiente' || calculado.tipoCliente === 'credito' || calculado.quienPaga !== 'transferencia') return calculado;

  const vigenteCompleto =
    previo.boucherVigente === 'comercio' ? refConUrl(previo.boucherComercio)
      : previo.boucherVigente === 'gestor' ? refConUrl(previo.boucherGestor)
        : previo.boucherVigente === undefined && typeof previo.boucherUrl === 'string' && previo.boucherUrl.trim() !== '';
  if (!vigenteCompleto) return calculado;

  const conservado: Record<string, unknown> = {};
  for (const k of CLAVES_BOUCHER) if (k in previo) conservado[k] = previo[k];
  return { ...calculado, ...conservado, estado: 'en_revision_deposito' };
}

/** cobroDelivery — misma fórmula que executeCambiar() en la transición a 'entregado'. */
export function construirCobroDelivery(
  orden: FirebaseFirestore.DocumentData,
  deliveryAnswer: RespuestaCobroEntrega | null,
  productoAnswer: RespuestaCobroEntrega | null,
): Record<string, unknown> {
  // FIN-1C-A: la matemática del monto vive en cobro-delivery-monto.ts (la reutilizan las callables de cobro).
  const productoNoRecibido = productoAnswer
    ? productoAnswer.recibio === false
    : orden.cobrosMotorizado?.producto?.recibio === false;
  const { precioDelivery, quienPaga, esCredito, aplicaFaltante, cubiertoPorDeposito, faltanteDelivery, monto } =
    calcularMontoCobroDelivery(orden, productoNoRecibido);
  const esRecoleccion = quienPaga === 'recoleccion';
  const motorizadoYaCobro =
    deliveryAnswer?.recibio === true ||
    (esRecoleccion && orden.cobrosMotorizado?.delivery?.recibio === true);

  // ── B1.2: faltante parcial del delivery ──────────────────────────────────
  //
  // Cuando el delivery se deduce del cobro contra entrega, el motorizado no
  // recauda el delivery aparte: sale del mismo efectivo del producto. Si ese
  // efectivo no alcanza —o si declaró no haberlo recibido— el delivery queda
  // cubierto solo en parte, y la diferencia NO puede exigírsele: no la tiene.
  //
  // Este es el único momento en que el faltante es factualmente cierto y hay
  // una transacción abierta que ya escribe cobroDelivery. Se calcula acá para
  // que nazca atómico con la confirmación del dinero recibido, sin agregar un
  // segundo write ni un documento aparte (ver B1.2B, secciones 7-10).
  const patch: Record<string, unknown> = {
    // `monto` es el PENDIENTE real de cobro, no el precio de lista: es lo que
    // leen Cobros y la vista del comercio. Sin deducción no cambia nada.
    monto,
    tipoCliente: esCredito ? 'credito' : 'contado',
    quienPaga,
    estado: precioDelivery === 0 ? 'no_cobrar' : esCredito ? 'pendiente' : motorizadoYaCobro ? 'pagado' : 'pendiente',
    registradoAt: FieldValue.serverTimestamp(),
  };

  if (aplicaFaltante) {
    // Trazabilidad: sin estos dos campos no habría forma de distinguir un
    // delivery de 30 de uno de 130 con 100 ya cubiertos.
    // Invariante: monto + cubiertoPorDeposito === montoDelivery.
    patch.montoDelivery = precioDelivery;
    patch.cubiertoPorDeposito = cubiertoPorDeposito;
    // Con deducción el motorizado nunca recauda el delivery aparte, así que
    // 'pagado' no aplica: o quedó cubierto por el CE (nada que cobrar) o
    // falta una parte. No se inventa una deuda de 0.
    patch.estado = faltanteDelivery > 0 ? 'pendiente' : 'pagado';
  }
  // semanaKey: se usa la fecha/hora del servidor en el momento de esta
  // llamada, igual que el cliente usaba `new Date()` — pero anclado a
  // America/Managua (semanaKeyDeFecha, ya usado por
  // acumularCobroSemanalPorOrden) en vez de la zona horaria del navegador.
  // Es un campo informativo del documento, no la clave de agrupación real
  // de cobros_semanales (esa la calcula acumularCobroSemanalPorOrden por su
  // cuenta a partir de entregadoAt) — anclarlo a Managua acá es una mejora
  // estricta, no un cambio de contrato.
  if (esCredito) {
    patch.semanaKey = semanaKeyDeFecha(new Date());
  }

  // ── B2-PAGO-MEDIO: con qué se pagó ───────────────────────────────────────
  //
  // El motorizado no declara la forma de pago; se deriva del flujo, que ya
  // está calculado arriba. `motorizadoYaCobro` solo puede ser true en un
  // cobro FÍSICO: con crédito o con quienPaga 'transferencia',
  // calcularDeposito() pone tieneDelivery = false y el modal del cobro ni
  // siquiera se abre. Confirmar que recibió en ese contexto es la misma
  // evidencia que ya obliga a depositar, así que afirma efectivo sin inferir.
  //
  // La transferencia NO se escribe acá: nace del comprobante que confirma el
  // gestor en Cobros. Un motivo del tipo "indicó que pagará por transferencia"
  // explica por qué no hubo efectivo — no confirma un pago.
  const formaPago = resolverFormaPago({
    formaPagoExistente: orden.cobroDelivery?.formaPago,
    motorizadoYaCobro,
    esCredito,
    esPorTransferencia: quienPaga === 'transferencia',
  });
  if (formaPago) patch.formaPago = formaPago;

  return conservarBoucherPrevio(orden.cobroDelivery, patch);
}
