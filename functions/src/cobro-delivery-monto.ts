// FIN-1C-A — la fórmula del monto pendiente de un cobro de delivery, en UN solo lugar.
//
// La usan (1) la transición a 'entregado' (construirCobroDelivery), que fija cobroDelivery.monto al entregar, y (2) las
// callables de cobro (registrarCobroDelivery), que RECALCULAN el monto desde la orden y lo comparan con el guardado: un
// monto que el cliente diga, o un cobroDelivery.monto alterado, nunca se paga. PURO: sin Firestore ni efectos.

import type { DocumentData } from 'firebase-admin/firestore';

export interface MontoCobroDelivery {
  precioDelivery: number;
  quienPaga: string;
  esCredito: boolean;
  aplicaFaltante: boolean;
  cubiertoPorDeposito: number;
  faltanteDelivery: number;
  /** El PENDIENTE real de cobro: faltante si el delivery se dedujo del CE; si no, el precio. */
  monto: number;
}

/**
 * @param productoNoRecibido el motorizado declaró no haber recibido el efectivo del CE. Si no se da, se lee de la orden
 *        (cobrosMotorizado.producto.recibio === false), que es lo que persiste la transición a 'entregado'.
 */
export function calcularMontoCobroDelivery(orden: DocumentData, productoNoRecibido?: boolean): MontoCobroDelivery {
  const precioDelivery = orden.confirmacion?.precioFinalCordobas ?? 0;
  const quienPaga = orden.pagoDelivery?.quienPaga ?? '';
  const esCredito = orden.tipoCliente === 'credito' || quienPaga === 'credito_semanal';

  // B1.2: faltante parcial del delivery cuando se deduce del cobro contra entrega.
  const deducir = orden.pagoDelivery?.deducirDelCobroContraEntrega === true;
  const ceAplica = orden.cobroContraEntrega?.aplica === true;
  const montoProducto = ceAplica ? (orden.cobroContraEntrega?.monto || 0) : 0;
  const noRecibido = productoNoRecibido ?? (orden.cobrosMotorizado?.producto?.recibio === false);
  const productoDisponible = noRecibido ? 0 : montoProducto;

  const aplicaFaltante = deducir && !esCredito && precioDelivery > 0;
  const cubiertoPorDeposito = aplicaFaltante ? Math.min(productoDisponible, precioDelivery) : 0;
  const faltanteDelivery = aplicaFaltante ? Math.max(0, precioDelivery - productoDisponible) : 0;
  return {
    precioDelivery,
    quienPaga,
    esCredito,
    aplicaFaltante,
    cubiertoPorDeposito,
    faltanteDelivery,
    monto: aplicaFaltante ? faltanteDelivery : precioDelivery,
  };
}
