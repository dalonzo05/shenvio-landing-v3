// IDENTIDAD-HUMANA-1 — asignación de códigos legibles: LADO ESCRITURA.
//
// SH-1058 y DEP-247 son identificadores operativos, globales y secuenciales.
// No reemplazan el ID de Firestore, no son FK y NO autorizan nada.
//
// ── Por qué un trigger y no el cliente ───────────────────────────────────────
//
// Las órdenes las crean DOS pantallas con `addDoc` desde el navegador
// (comercio/solicitar y gestor/ingresar-orden) y los depósitos, NUEVE writers
// distintos. Ninguno puede generar la secuencia:
//
//   · `FieldValue.increment()` es atómico pero write-only — el cliente nunca
//     se entera del número que salió, así que no puede componer el código;
//   · una transacción desde el cliente sí sería correcta bajo concurrencia,
//     pero exigiría darle lectura y escritura sobre un contador global, y las
//     Rules no pueden comprobar que el `codigo` escrito sea el que el contador
//     entregó. Sería forjable, y un cliente con un bug corrompería la
//     secuencia de todos;
//   · leer "el último documento + 1" se rompe con dos creaciones simultáneas.
//
// Con un trigger, los once writers siguen exactamente igual y el contador vive
// donde el cliente no llega.
//
// El precio: el código aparece ~1 s después de crear el documento. Como es
// interno y explícitamente no es autorización, la asignación diferida vale. La
// UI muestra el ID corto mientras tanto.
//
// ── Frontera ─────────────────────────────────────────────────────────────────
//
// PURO Y SIN IMPORTS hacia fuera de `src`: el tsconfig de Functions declara
// `include: ["src"]` con `outDir: "lib"`, así que importar `lib/codigo-humano`
// arrastraría el rootDir y cambiaría las rutas del artefacto de deploy.
//
// Por eso el FORMATO es un contrato enunciado en los dos lados. Acá se
// escribe; en `lib/codigo-humano.ts` se lee, valida y busca. No se duplica
// ninguna decisión —el servidor no parsea, el cliente no genera— y las dos
// suites lo atan contra los mismos literales del bloque: SH-1001, DEP-1001,
// SH-1000000.

import { onDocumentCreated } from 'firebase-functions/v2/firestore';
import * as admin from 'firebase-admin';

export const PREFIJO_ORDEN = 'SH';
export const PREFIJO_DEPOSITO = 'DEP';

export const PREFIJOS = [PREFIJO_ORDEN, PREFIJO_DEPOSITO] as const;
export type PrefijoCodigo = (typeof PREFIJOS)[number];

/** Documentos contador. Denegados al cliente en firestore.rules. */
export const CONTADOR_ORDENES = 'ordenes';
export const CONTADOR_DEPOSITOS = 'depositos';

/**
 * Compone el código canónico. Espejo exacto de `lib/codigo-humano.ts`.
 *
 * Sin padding por decisión de producto: un ancho fijo obligaría a convivir con
 * dos formatos al pasar de 999.999 a 1.000.000. El orden lo da `secuencia`.
 */
export function formatearCodigo(prefijo: string, secuencia: number): string {
  if (!(PREFIJOS as readonly string[]).includes(prefijo)) {
    throw new Error(`prefijo no permitido: ${JSON.stringify(prefijo)}`);
  }
  if (!Number.isSafeInteger(secuencia) || secuencia < 1) {
    throw new Error(`secuencia invalida: ${JSON.stringify(secuencia)}`);
  }
  return `${prefijo}-${secuencia}`;
}

export type Decision =
  | { accion: 'asignar'; codigo: string; secuencia: number; siguienteValor: number }
  | { accion: 'noop'; motivo: string }
  | { accion: 'bloquear'; motivo: string };

export interface EntradaDecision {
  prefijo: string;
  /** Lo que el documento tiene AHORA, releído dentro de la transacción. */
  codigoActual: unknown;
  secuenciaActual: unknown;
  /** `undefined` = el documento contador no existe. */
  valorContador: unknown;
}

const esEntero = (v: unknown): v is number => typeof v === 'number' && Number.isSafeInteger(v);

/**
 * Qué hacer con este documento. Toda la decisión, sin Firestore.
 *
 * ── Estados parciales ────────────────────────────────────────────────────────
 *
 * Un documento puede llegar con `codigo` y sin `secuencia`, o al revés. Eso NO
 * se repara por intuición: reconstruir la secuencia leyendo el código, o el
 * código leyendo la secuencia, sería adivinar cuál de los dos es el bueno, y
 * si el equivocado es el que se conserva se produce un duplicado silencioso —
 * exactamente lo que este mecanismo existe para impedir.
 *
 * Se bloquea, se registra con log estructurado y queda como incidencia
 * operativa: CODIGO-ESTADO-PARCIAL. Reparar un caso así es una decisión
 * manual e informada, no un efecto colateral del trigger.
 *
 * ── Contador ausente ─────────────────────────────────────────────────────────
 *
 * También bloquea. Sembrar el contador es un paso operativo deliberado (ver
 * IDENTIDAD-HUMANA-1 §10); arrancar en 1 por defecto en un entorno sin sembrar
 * produciría códigos que un backfill posterior volvería a repartir.
 */
export function decidirAsignacion(entrada: EntradaDecision): Decision {
  if (!(PREFIJOS as readonly string[]).includes(entrada.prefijo)) {
    return { accion: 'bloquear', motivo: 'PREFIJO_NO_PERMITIDO' };
  }

  const tieneCodigo = entrada.codigoActual !== undefined && entrada.codigoActual !== null;
  const tieneSecuencia = entrada.secuenciaActual !== undefined && entrada.secuenciaActual !== null;

  // A · ya asignado y coherente.
  if (tieneCodigo && tieneSecuencia) {
    const esperado = esEntero(entrada.secuenciaActual) && entrada.secuenciaActual >= 1
      ? `${entrada.prefijo}-${entrada.secuenciaActual}`
      : null;
    if (esperado !== null && entrada.codigoActual === esperado) {
      return { accion: 'noop', motivo: 'YA_ASIGNADO' };
    }
    // Los dos campos están pero no dicen lo mismo. No se elige un ganador.
    return { accion: 'bloquear', motivo: 'CODIGO_INCOHERENTE' };
  }

  // C · solo uno de los dos.
  if (tieneCodigo !== tieneSecuencia) {
    return { accion: 'bloquear', motivo: 'CODIGO_ESTADO_PARCIAL' };
  }

  // Contador.
  if (entrada.valorContador === undefined || entrada.valorContador === null) {
    return { accion: 'bloquear', motivo: 'CONTADOR_AUSENTE' };
  }
  if (!esEntero(entrada.valorContador) || entrada.valorContador < 0) {
    return { accion: 'bloquear', motivo: 'CONTADOR_CORRUPTO' };
  }

  // B · asignar.
  const siguiente = entrada.valorContador + 1;
  if (!Number.isSafeInteger(siguiente)) {
    return { accion: 'bloquear', motivo: 'CONTADOR_DESBORDADO' };
  }
  return {
    accion: 'asignar',
    codigo: formatearCodigo(entrada.prefijo, siguiente),
    secuencia: siguiente,
    siguienteValor: siguiente,
  };
}

/**
 * Aplica la decisión dentro de UNA transacción.
 *
 * El guard vive DENTRO: los triggers son at-least-once, y releer el documento
 * fuera de la transacción dejaría una ventana en la que dos entregas del mismo
 * evento consumen dos números. Releído adentro, el segundo intento ve el
 * código ya escrito y sale por 'noop' sin gastar secuencia.
 */
async function asignarCodigo(
  coleccion: string,
  docId: string,
  prefijo: PrefijoCodigo,
  contadorId: string,
): Promise<void> {
  const db = admin.firestore();
  const docRef = db.collection(coleccion).doc(docId);
  const contadorRef = db.collection('contadores').doc(contadorId);

  const resultado = await db.runTransaction(async (tx) => {
    const [docSnap, contadorSnap] = await Promise.all([tx.get(docRef), tx.get(contadorRef)]);

    // El documento pudo borrarse entre la creación y el trigger.
    if (!docSnap.exists) return { accion: 'noop', motivo: 'DOC_INEXISTENTE' } as Decision;

    const data = docSnap.data() ?? {};
    const decision = decidirAsignacion({
      prefijo,
      codigoActual: data.codigo,
      secuenciaActual: data.secuencia,
      valorContador: contadorSnap.exists ? contadorSnap.data()?.valor : undefined,
    });

    if (decision.accion === 'asignar') {
      tx.update(contadorRef, { valor: decision.siguienteValor });
      tx.update(docRef, { codigo: decision.codigo, secuencia: decision.secuencia });
    }
    return decision;
  });

  // Log estructurado, mismo formato que el resto de Functions del repo.
  console.log(
    JSON.stringify({
      fn: 'asignarCodigo',
      coleccion,
      docId,
      prefijo,
      accion: resultado.accion,
      ...(resultado.accion === 'asignar'
        ? { codigo: resultado.codigo, secuencia: resultado.secuencia }
        : { motivo: resultado.motivo }),
    }),
  );

  // Nunca se lanza: un fallo acá no debe reintentar en bucle ni ensuciar la
  // creación de la orden, que ya ocurrió y es válida sin código. Los casos
  // bloqueados quedan en el log para revisión manual.
}

export const asignarCodigoOrden = onDocumentCreated('solicitudes_envio/{id}', async (event) => {
  await asignarCodigo('solicitudes_envio', event.params.id, PREFIJO_ORDEN, CONTADOR_ORDENES);
});

export const asignarCodigoDeposito = onDocumentCreated('ordenes_deposito/{id}', async (event) => {
  await asignarCodigo('ordenes_deposito', event.params.id, PREFIJO_DEPOSITO, CONTADOR_DEPOSITOS);
});
