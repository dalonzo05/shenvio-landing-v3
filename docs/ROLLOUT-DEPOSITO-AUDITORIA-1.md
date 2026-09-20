# ROLLOUT — DEPOSITO-AUDITORIA-1

Procedimiento exacto para poner esta feature en un ambiente con web ya
desplegada. **Este documento no ejecuta nada.** Describe qué hacer, en qué
orden, y qué hacer si cada paso falla.

## Por qué hace falta un puente

La feature cambia **web**, **firestore.rules** y **storage.rules** a la vez, y
ningún orden simple funciona. Está demostrado con tests, no razonado:

| Combinación | Resultado | Casos que lo prueban |
|---|---|---|
| web F2 + Rules F1 | **ROTO** | `DC1` (upload a `bouchers/*` sin match → deny), `DC2` (la subcolección `eventos` no existe en F1 → el batch de "Pedir corrección" muere) |
| Rules finales + web F1 | **ROTO** | `DC3`/`DC3b` ("Devolver"/"Eliminar" hacen `delete`, ahora DENY), `DC4` (confirmar sin evento, ahora DENY) |

```
npm run test:storage-rules    # Rules FINALES de este branch
npm run test:puente-rules     # Rules PUENTE (generadas)
npm run test:compat-rules     # Rules F1 (origin/staging)
```

## El artefacto puente

`scripts/reglas-puente.mjs` **deriva** el puente de las Rules finales. No hay
un archivo de puente versionado aparte: se desincronizaría en cuanto alguien
tocara una y no la otra.

```
node scripts/reglas-puente.mjs        # escribe .reglas-puente/{firestore,storage}.rules
```

Tres parches, todos explícitos en el script, cada uno con su motivo:

| Archivo | Qué devuelve | Flujo del web F1 que lo necesita |
|---|---|---|
| `firestore.rules` | `auditoriaF2Obligatoria()` → `false` | confirmar, rehacer y reemplazar el comprobante **sin evento**, incluida la corrección legacy del **digitador** |
| `firestore.rules` | `allow delete` de F1 | "Devolver al motorizado" y "Eliminar" |
| `storage.rules` | `versionadoF2Obligatorio()` → `false` | subir la corrección de **staff y digitador** al `boucher.jpg` legacy |

Cada parche exige que su ancla aparezca **exactamente una vez**. Si las Rules
finales cambian y un ancla desaparece, el script **falla** en vez de generar
un puente incorrecto en silencio.

### Lo que el puente NO relaja

Verificado en `P2g`, `P2h`, `P2i`:

- sellado de F1 (`confirmado` / `convertido_en_deuda` / `anulado`): el
  comprobante no se toca, ni con el interruptor en `false`;
- inmutabilidad de `bouchers/{versionId}`: update y delete siguen DENY;
- `eventos` append-only: update y delete siguen DENY;
- "Pedir corrección": sigue exigiendo motivo 3–300, actor, hora y evento;
- anulación de un A/B: sigue exigiendo admin, motivo y evento;
- tipo C pagado, create-first y permisos de cualquier otro usuario: intactos.

## Procedimiento

### 1. Generar y desplegar las Rules PUENTE

```
node scripts/reglas-puente.mjs
# revisar el diff contra las finales — deben ser 3 hunks, nada más:
diff firestore.rules .reglas-puente/firestore.rules
diff storage.rules  .reglas-puente/storage.rules
# deploy de los DOS rulesets juntos, desde .reglas-puente/
```

**Si falla:** nada cambió todavía. El ambiente sigue con Rules F1 y web F1,
que es un estado consistente. Corregir el ancla en el script y repetir.

### 2. Verificar que los dos rulesets activos son el puente

Firebase Console → Firestore → Reglas, y Storage → Reglas. Confirmar que
`auditoriaF2Obligatoria()` y `versionadoF2Obligatorio()` devuelven `false` en
lo desplegado. No seguir sin esto: es la comprobación que evita el escenario
"web F2 contra Rules F1".

**Si un ruleset quedó y el otro no:** desplegar el que falta antes de seguir.
Los dos por separado son estados válidos frente al web F1 (cada archivo es
compatible hacia atrás por sí solo), así que no hay urgencia de rollback.

### 3. Integrar y pushear la web F2

Merge del branch y push. En este punto conviven web F1 (sesiones abiertas,
caché) y web F2, y el puente acepta a las dos.

**Si falla la integración:** rollback = no desplegar la web. El puente puede
quedarse indefinidamente: es estrictamente más permisivo que las Rules finales
y estrictamente más restrictivo que F1 en todo lo que no está en la tabla de
parches.

### 4. Esperar Vercel READY

No seguir con un deploy a medias.

**Si el build falla:** el ambiente sigue sirviendo la web F1 contra el puente.
Estado consistente. Arreglar y repetir.

### 5. Smoke focal (manual, sobre el ambiente)

Con una cuenta de gestor y una de motorizado, sobre un depósito de prueba —
**nunca sobre los fixtures**:

1. motorizado envía un depósito nuevo (create-first) → aparece en "Por revisar";
2. gestor → **Pedir corrección** con motivo → el DEP queda "Corrección
   solicitada", **conserva su DEP-N**, su comprobante y sus órdenes;
3. motorizado ve el motivo y sube el comprobante nuevo → vuelve a
   "En revisión" con el **mismo DEP-N** y `boucherVersion: 2`;
4. gestor expande el depósito → el **historial** muestra los eventos con
   actor, rol, hora y motivo;
5. con una cuenta de **digitador**: digita un depósito (primera carga) y
   después corrige SU digitación en revisión → versión nueva con motivo, y el
   objeto anterior sigue legible;
6. gestor **Confirmar** → queda confirmado;
7. admin **Rehacer** con motivo → vuelve a revisión, evento nuevo;
8. admin **Anular** con motivo → estado `anulado`, el documento **sigue
   existiendo** con su DEP-N y su comprobante.

**Si algo de esto falla:** rollback de la web (redeploy del build anterior).
**No revertir el puente todavía**: el web F1 funciona bajo el puente, así que
volver atrás la web es suficiente y no toca ninguna regla.

### 6. Desplegar las Rules FINALES

Solo cuando ya no queda ninguna sesión sirviendo web F1 (dejar pasar el tiempo
de caché/sesión del ambiente). Deploy de `firestore.rules` y `storage.rules`
del repo, tal cual.

**Si falla:** el puente sigue activo y todo funciona. Reintentar.

### 7. Verificar los rulesets finales

Confirmar en Console que los dos interruptores valen `true` y que
`allow delete: if false` está en `ordenes_deposito`.

### 8. Gates

```
npm test && npm run test:rules && npm run test:storage-rules
(cd functions && npm test)
npx tsc --noEmit -p tsconfig.json && npm run build
```

### 9. E2E sobre el ambiente

Repetir el smoke del paso 5 completo y, además, comprobar el cierre:

- "Devolver al motorizado" y "Eliminar" **ya no existen** en la UI;
- un `delete` manual de un depósito desde consola → **denegado**;
- reemplazar el comprobante de un depósito en revisión pide motivo y genera
  una **versión nueva**, sin pisar la anterior.

## Rollback

La regla que ordena todo: **ninguna evidencia sellada se reabre**. Ningún paso
de rollback toca `confirmado`, `convertido_en_deuda` ni `anulado`, ni borra
objetos de Storage (delete está DENY para todos, en las tres versiones de las
reglas).

| Momento | Rollback | Qué NO se toca |
|---|---|---|
| Después del paso 1–2 | redesplegar las Rules F1 (`node scripts/reglas-base.mjs` da el contenido exacto de `origin/staging`) | nada escrito todavía |
| Después del paso 3–5 | redeploy del build anterior de la web. **Dejar el puente puesto.** | los DEP en `devuelto` y las versiones ya subidas quedan; el web F1 no los muestra como tales, pero no los pierde |
| Después del paso 6–7 | redesplegar el puente (`node scripts/reglas-puente.mjs`) | ídem |

### El caso que hay que mirar: depósitos en `devuelto`

Si se hace rollback de la web **después** de que un gestor ya pidió alguna
corrección, esos depósitos quedan en un estado que el web F1 no conoce. No se
pierde nada —el documento, el DEP-N, el comprobante y las órdenes siguen ahí—
pero el gestor no los ve en su cola.

Salida sin reabrir evidencia: con el puente activo, un admin los lleva a
`en_revision` o los anula desde consola. **No** hace falta borrar nada, y
borrarlos sigue estando prohibido.

### Lo que el rollback NO puede deshacer

Las versiones de comprobante ya subidas a `depositos/{uid}/{depId}/bouchers/`
y los eventos ya escritos. Es intencional: son append-only e inmutables. Un
rollback que los borrara sería exactamente la pérdida de evidencia que este
bloque vino a cerrar.

## Deudas que este rollout NO cierra

- `REHACER-ANULA-ANTES-DEL-BATCH` — la anulación de los movimientos del ledger
  sigue siendo una escritura aparte del batch que rehace el depósito.
- `MOTO-DEP-BOUCHER-VERSION-HUERFANA` — un upload cuyo batch falla deja el
  objeto sin referencia, y no se borra automáticamente.
**CERRADA** en el hardening final: `DIGITADOR-BOUCHER-NO-VERSIONADO`. La
corrección del digitador va por `bouchers/{versionId}` con evento y motivo,
igual que la de motorizado, gestor y admin (`DG1`–`DG13`, `DG3s`–`DG14s`).
Conserva solo la PRIMERA carga sobre el legacy, que ocurre en
'pendiente_boucher' y no pisa ninguna evidencia vigente.
