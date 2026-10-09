// ═══════════════════════════════════════════════════════════════════════════
// CREDIT-ELIGIBILITY-1 — el crédito semanal lo autoriza el perfil del comercio, no la orden.
// ═══════════════════════════════════════════════════════════════════════════
//
// Fuente de verdad: `comercios/{comercioId}.tipoCliente` ('contado' | 'credito'). Solo el gestor/admin lo escriben (las Rules de `comercios` no lo dejan editar
// al comercio). Campo ausente = contado.
//
// Antes las Rules de CREATE aceptaban `tipoCliente: 'credito'` / `pagoDelivery.quienPaga: 'credito_semanal'` sin mirar ese perfil, y confirmarTransicionConCobro
// y acumularCobroSemanalPorOrden confiaban en la orden: el delivery quedaba sin cobro en la calle, fuera del depósito y acumulado como deuda del comercio.
// Las Rules de CREATE cierran la puerta de entrada; esto la cierra otra vez en el servidor, ANTES del primer efecto económico, para las órdenes que la
// puerta no vio (legacy, o creadas con Admin SDK).
//
// Este módulo es puro: no lee Firestore. Los llamadores leen el comercio dentro de su transacción y se lo pasan.
import { HttpsError } from 'firebase-functions/v2/https';

type Orden = FirebaseFirestore.DocumentData;

/**
 * ¿La orden sigue el flujo de crédito? Cualquiera de las señales basta (misma definición que las Rules de CREATE): si una dice contado y otra crédito, se exige
 * elegibilidad. `pagoDelivery.tipo` no lo lee el cálculo de dinero, pero las pantallas sí; exigirlo aquí solo puede rechazar de más, nunca de menos.
 */
export function ordenEsCredito(orden: Orden): boolean {
  const pago = orden.pagoDelivery;
  const quienPaga = pago && typeof pago === 'object' ? (pago as Record<string, unknown>).quienPaga : undefined;
  const tipo = pago && typeof pago === 'object' ? (pago as Record<string, unknown>).tipo : undefined;
  return orden.tipoCliente === 'credito' || quienPaga === 'credito_semanal' || tipo === 'credito_semanal';
}

/**
 * El comercio al que se le cobraría el crédito. Todas las identidades que la orden lleva (comercioId, userId, comercioUid, ownerSnapshot.uid) deben coincidir en
 * UN solo valor: acumularCobroSemanalPorOrden carga la deuda a `ownerSnapshot.uid || userId`, así que el comercio que se comprueba y el que se endeuda tienen que
 * ser el mismo. Si no hay ninguna, o divergen, no se puede demostrar ⇒ null (fail closed). Una orden de cliente individual no lleva comercioId: su userId no es un
 * comercio y la lectura de `comercios/{userId}` no existe ⇒ rechazo.
 */
export function comercioIdDeCredito(orden: Orden): string | null {
  const candidatos = [orden.comercioId, orden.userId, orden.comercioUid, orden.ownerSnapshot?.uid].filter((v) => v !== undefined && v !== null && v !== '');
  if (candidatos.length === 0 || !candidatos.every((v) => typeof v === 'string' && v.trim() !== '')) return null;
  const unicos = new Set((candidatos as string[]).map((v) => v.trim()));
  return unicos.size === 1 ? [...unicos][0] : null;
}

export type ResultadoCredito = { ok: true } | { ok: false; detalle: string };

/** Decide con el perfil del comercio ya leído (`null`/`undefined` = el documento no existe). Una orden de contado pasa sin mirar el perfil. */
export function evaluarCreditoAutorizado(orden: Orden, comercio: Orden | null | undefined): ResultadoCredito {
  if (!ordenEsCredito(orden)) return { ok: true };
  if (comercioIdDeCredito(orden) === null) return { ok: false, detalle: 'La orden no identifica a un único comercio dueño.' };
  if (!comercio) return { ok: false, detalle: 'La orden de crédito no pertenece a un comercio registrado.' };
  if (comercio.tipoCliente !== 'credito') return { ok: false, detalle: 'El comercio no está habilitado para crédito semanal.' };
  return { ok: true };
}

/** Rechazo cerrado y específico. No convierte la orden a contado ni escribe nada: el llamador lo lanza antes de su primer write. */
export function rechazoCreditoNoAutorizado(detalle: string, solicitudId: string): HttpsError {
  return new HttpsError(
    'failed-precondition',
    `Esta orden está marcada como crédito semanal pero el comercio no está autorizado para crédito. ${detalle} Pedí al gestor que revise el perfil del comercio.`,
    { motivo: 'credito_no_autorizado', solicitudId },
  );
}

/**
 * Lee el comercio (con el `get` del llamador, normalmente `tx.get`) y lanza `credito_no_autorizado` si la orden es de crédito y no está autorizada.
 * Para una orden de contado no lee nada.
 */
export async function exigirCreditoAutorizado(
  orden: Orden,
  solicitudId: string,
  leerComercio: (comercioId: string) => Promise<Orden | null | undefined>,
): Promise<void> {
  if (!ordenEsCredito(orden)) return;
  const comercioId = comercioIdDeCredito(orden);
  const comercio = comercioId ? await leerComercio(comercioId) : null;
  const r = evaluarCreditoAutorizado(orden, comercio);
  if (!r.ok) throw rechazoCreditoNoAutorizado(r.detalle, solicitudId);
}
