# MATRIZ DE VALIDACIÓN — BLOQUE 2A

Rama `fix/p1-boucher-comercio-provisional`, HEAD `4f54549`.
Ejecutar en DAPC con Emulator, proyecto `demo-storkhub`, importando
`.emulator-data/matriz-storage-actual` y exportando a un directorio **nuevo**.

**Regla de oro de esta matriz:** toda denegación debe verificarse **contra el
mensaje del motor**, para distinguir «denegado por la condición prevista» de
«denegado por error de evaluación». Un `Property ... is undefined on object` es
un FALLO aunque el resultado sea denegar.

Los casos de CREATE/primera escritura deben usar **IDs nuevos en cada corrida**:
si el documento ya existe, `setDoc` se evalúa como UPDATE y el caso deja de
probar lo que dice.

---

## 1. Casos PERMITIDOS — P1 a P8

Los ocho deben resultar PERMITIDOS. Si alguno deniega, el bloque no sirve.

| # | Caso | Estado previo | Esperado |
|---|---|---|---|
| **P1** | Comercio A, orden nueva, `cobroDelivery` **ausente** | sin el campo | PERMITIDO |
| **P2** | Comercio A, `cobroDelivery` como **mapa vacío** `{}` | `{}` | PERMITIDO |
| **P3** | Comercio A, `pendiente` **sin rastro de boucher** | `{estado:'pendiente'}` | PERMITIDO |
| **P4** | Comercio A, **orden histórica** con `comercioUid` correcto y **sin** `comercioId` | ausente o `pendiente` | PERMITIDO |
| **P5** | Comercio A **reemplaza su propio boucher** completo y válido | `en_revision_deposito` + `subidoPor:'comercio'` + url + path de ESTA orden + `boucherAt` timestamp | PERMITIDO |
| **P6** | **Admin** conserva su update | cualquiera | PERMITIDO |
| **P7** | **Gestor** conserva su update | cualquiera | PERMITIDO |
| **P8** | **Motorizado asignado** conserva su rama actual | cualquiera | PERMITIDO |

Payload de P1–P5 (el único que el comercio debe poder enviar):

```
cobroDelivery.estado      = 'en_revision_deposito'
cobroDelivery.boucherUrl  = <url de getDownloadURL>
cobroDelivery.boucherPath = 'evidencias/{ordenId}/delivery_boucher.jpg'
cobroDelivery.boucherAt   = serverTimestamp()
cobroDelivery.subidoPor   = 'comercio'
updatedAt                 = serverTimestamp()
```

**P4 es el caso que justifica usar `comercioUid` y no `comercioId`.** Si P4
deniega, la pertenencia elegida es incorrecta para el histórico y hay que
detenerse.

**P6, P7 y P8 son pruebas de NO REGRESIÓN**, no funcionalidad nueva. Detalle en
la sección 5.

---

## 2. Casos DENEGADOS — D1 a D58

### Grupo A · Actores y pertenencia (D1–D15)

| # | Caso | Motivo esperado |
|---|---|---|
| D1 | **Comercio B** sobre orden de A | `comercioUid != comercioIdDelUsuario()` |
| D2 | **Comercio inactivo** (`activo:false`) | `isComercioRole()` exige activo |
| D3 | **Comercio sin `comercioId`** en su perfil | `comercioIdDelUsuario() is string` falla (null) |
| D4 | **Cliente individual** | rol distinto de `Comercio` |
| D5 | **Rol desconocido** (`rol_inexistente`) | idem |
| D6 | **Usuario sin rol** | idem |
| D7 | **Auth sin doc** en `usuarios/` | `isActiveUser()` exige `exists()` |
| D8 | **No autenticado** | `signedIn()` |
| D9 | **Motorizado no asignado** | ni comercio dueño ni motorizado asignado |
| D10 | Comercio A sobre **orden personal** de un cliente (`comercioUid` = Auth UID de persona) | `comercioUid != comercioIdDelUsuario()` |
| D11 | Orden con `comercioUid` **ausente** | `.get('comercioUid','') != ''` falla |
| D12 | Orden con `comercioUid` **null** | `is string` falla |
| D13 | Orden con `comercioUid` **cadena vacía** | `!= ''` falla |
| D14 | Orden con `comercioUid` **numérico** | `is string` falla |
| D15 | Orden con `comercioUid` de **otro comercio** | desigualdad |

> **D3 + D12 combinados** son el caso crítico: perfil sin `comercioId` (→ null)
> contra documento con `comercioUid` null. Sin los guardias `is string`, `null
> == null` daría acceso. Probar explícitamente.

### Grupo B · Allowlist de raíz (D16–D23)

Todos: `affectedKeys().hasOnly(['cobroDelivery','updatedAt'])`.

| # | Campo raíz que el comercio intenta tocar |
|---|---|
| D16 | `estado` (el de la orden, no el de `cobroDelivery`) |
| D17 | `asignacion` |
| D18 | `confirmacion.precioFinalCordobas` |
| D19 | `cobroContraEntrega` |
| D20 | `registro` |
| D21 | `pagoDelivery` |
| D22 | `acumulacionCobroSemanal` |
| D23 | Campo raíz nuevo arbitrario |

### Grupo C · `updatedAt` (D24–D25)

| # | Caso | Motivo |
|---|---|---|
| D24 | `updatedAt` **ausente** del payload | `.get('updatedAt', null) == request.time` falla. **Debe denegar sin error de propiedad** |
| D25 | `updatedAt` con valor **elegido por el cliente** | distinto de `request.time` |

### Grupo D · Campos financieros anidados (D26–D29)

Los cuatro que el payload anterior enviaba y que causaban el riesgo económico.

| # | Campo |
|---|---|
| D26 | `cobroDelivery.monto` |
| D27 | `cobroDelivery.tipoCliente` |
| D28 | `cobroDelivery.quienPaga` |
| D29 | `cobroDelivery.registradoAt` |

### Grupo E · Otros campos anidados (D30–D34)

| # | Campo |
|---|---|
| D30 | `cobroDelivery.pagadoAt` |
| D31 | `cobroDelivery.confirmadoPor` |
| D32 | `cobroDelivery.formaPago` |
| D33 | `cobroDelivery.movimientoPagoId` |
| D34 | Clave anidada nueva arbitraria |

### Grupo F · Estado destino (D35–D39)

| # | Estado nuevo intentado |
|---|---|
| D35 | `pendiente` (retiro — **fuera del 2A**) |
| D36 | `pagado` |
| D37 | `no_cobrar` |
| D38 | `revertido` |
| D39 | Estado inventado |

### Grupo G · Estado origen (D40–D43)

| # | Estado previo desde el que se intenta operar |
|---|---|
| D40 | `pagado` — **el más grave: revertiría un cobro conciliado** |
| D41 | `no_cobrar` |
| D42 | `revertido` |
| D43 | Estado inventado |

### Grupo H · Primera carga con rastro previo (D44–D48)

Los cinco fallan por `sinRastroDeBoucher()`; el estado previo es `pendiente` o
ausente, así que **sin esa función habrían pasado**.

| # | Rastro presente |
|---|---|
| D44 | `boucherUrl` presente, `subidoPor` ausente |
| D45 | `boucherPath` presente, estado ausente |
| D46 | `boucherAt` presente |
| D47 | `subidoPor:'gestor'` con estado `pendiente` |
| D48 | `boucherUrl: null` (clave **presente** con valor null) |

> D48 verifica que se usa `in` (presencia de clave) y no comparación de valor.

### Grupo I · Reemplazo inválido (D49–D54)

Estado previo `en_revision_deposito` en los seis.

| # | Defecto del boucher previo |
|---|---|
| D49 | `subidoPor:'gestor'` — **no se pisa el boucher del gestor** |
| D50 | `subidoPor` ausente |
| D51 | `subidoPor:'comercio'` **sin `boucherUrl`** |
| D52 | `subidoPor:'comercio'` **sin `boucherPath`** |
| D53 | `subidoPor:'comercio'` con `boucherPath` **de otra orden** |
| D54 | `subidoPor:'comercio'` con `boucherAt` que **no es timestamp** |

### Grupo J · Payload nuevo inválido (D55–D58)

| # | Defecto del payload entrante |
|---|---|
| D55 | `boucherUrl` ausente, vacío, null o no string |
| D56 | `boucherPath` distinto de `evidencias/{ordenId}/delivery_boucher.jpg` (p. ej. el de otra orden) |
| D57 | `boucherAt` distinto de `request.time` |
| D58 | `subidoPor` distinto de `'comercio'` (p. ej. `'gestor'`, vacío, ausente) |

---

## 3. Cinco casos MALFORMADOS

Se prueban aparte porque lo que se verifica **no es solo el resultado, sino el
modo de fallo**. Los cinco deben **denegar limpiamente** y **ninguno** debe
producir `Property cobroDelivery is undefined on object` ni ningún otro error de
evaluación.

| # | Forma de `cobroDelivery` | Esperado |
|---|---|---|
| M1 | Anterior = **null** | DENEGADO sin error |
| M2 | Anterior = **string** | DENEGADO sin error |
| M3 | Anterior = **número** | DENEGADO sin error |
| M4 | Anterior = **booleano o array** | DENEGADO sin error |
| M5 | **Nuevo** = null o string | DENEGADO sin error |

Recordatorio: `cobroDelivery` **ausente** NO es malformado — es P1, y debe
PERMITIR. Distinguir ausente de malformado es justamente lo que aporta el commit
`4f54549`.

**Comprobación adicional obligatoria:** con un documento malformado presente,
verificar que **admin, gestor y motorizado asignado siguen pudiendo actualizar
esa orden**. Un error de evaluación en la rama del comercio abortaría la
petición entera y se los llevaría por delante.

---

## 4. Regresión — admin, gestor, motorizado

No basta con P6–P8. Repetir las matrices ya validadas de los Bloques 0C y 1
**bajo las reglas del 2A**, y comparar contra los resultados registrados:

| Matriz | Resultado esperado |
|---|---|
| CREATE/UPDATE/DELETE de `usuarios` (0C) | 45/45 |
| Complementarios 0C §6A/§6B | 4/4 |
| Focal de roles editables (dos gestores) | 14/14 |
| Identidad B1–B25 + históricas H1–H8 | 36/36 |
| `ownerSnapshot` O1–O24 | 24/24 |
| Focal `comercioId` | 21/21 |
| Sondas de motivo | 6/6 |
| Cruzados 0C × B1 | 12/12 |

**Regresión específica del motorizado:** su rama de `allow update` incluye
`cobroDelivery` en la allowlist y `marcadorSoloPendiente()`. Verificar que sigue
pudiendo escribir `cobroDelivery` y que **no** puede saltarse
`marcadorSoloPendiente()`.

**Regresión específica del gestor:** debe seguir pudiendo subir boucher,
reemplazarlo, quitarlo y confirmar el pago (`estado:'pagado'` + `ordenes_deposito`
+ movimiento en el ledger).

---

## 5. Interfaz — UI-1 a UI-13

En navegador, sesión de comercio, pantalla `/panel/comercio/mis-ordenes`.
Precondición común: `pagoDelivery.quienPaga === 'transferencia'`.

| # | Escenario | Debe mostrarse |
|---|---|---|
| UI-1 | Sin `cobroDelivery` | Botón **«Subir boucher»** |
| UI-2 | `estado: 'pendiente'` sin rastro de boucher | Botón **«Subir boucher»** |
| UI-3 | `pendiente` con `boucherUrl` y **sin** `subidoPor` | **«Comprobante registrado»**, enlace «Ver boucher», **sin** botón de subida ni reemplazo |
| UI-4 | `cobroDelivery` malformado (string/número/null) | **«Requiere revisión»**, **sin** botón y **sin** enlace |
| UI-5 | `en_revision_deposito` + `subidoPor:'comercio'` + boucher completo | Botón **«↺ Reemplazar»** |
| UI-6 | `en_revision_deposito` + `subidoPor:'gestor'` | **«🔍 En revisión»** sin ningún botón |
| UI-7 | `en_revision_deposito` + `subidoPor` ausente | **«🔍 En revisión»** sin ningún botón |
| UI-8 | `estado: 'pagado'` | **«✓ Pagado»** + «Ver boucher». **Ningún control de escritura** |
| UI-9 | `estado: 'no_cobrar'` | **«No se cobra»**, sin acción |
| UI-10 | `estado: 'revertido'` | **«Revertido»**, sin acción |
| UI-11 | `quienPaga` distinto de `'transferencia'` | Columna sin controles de boucher (Debe/Pagado/—) |
| UI-12 | **Cualquier estado** | **No existe ningún control «Quitar»** en toda la pantalla |
| UI-13 | Subida correcta | Mensaje de éxito **solo después** de que `updateDoc` resuelve |

**UI-12 es un requisito del bloque**, no una preferencia: el retiro se difirió a
la fase server-side (2B) y `handleQuitarBoucher` fue eliminada del archivo.

Nota de entorno: el panel del navegador no compone frames, así que conviene
activar los botones con `element.click()` — dispara el manejador real de React,
con sesión y reglas reales; solo se omite la prueba de puntero.

---

## 6. Storage y URLs

| # | Caso | Esperado |
|---|---|---|
| S-1 | **Primera carga**: crea el objeto | `evidencias/{ordenId}/delivery_boucher.jpg` existe |
| S-2 | **Reemplazo**: vuelve a subir | El objeto se sustituye |
| S-3 | **Objeto único** | Tras varias subidas y reemplazos, **sigue habiendo exactamente un objeto** para esa orden. El nombre fijo lo garantiza; confirmarlo |
| S-4 | **URL anterior** tras reemplazar | Debe dejar de servir (el token se regenera). Confirmar el comportamiento real del Emulator |
| S-5 | **URL nueva** tras reemplazar | Sirve y muestra la imagen nueva |
| S-6 | **URL con token tras logout** | **Sigue sirviendo** — deuda conocida, no la corrige el 2A |
| S-7 | **URL con token con usuario inactivo** | **Sigue sirviendo** — deuda conocida |
| S-8 | **Fallo de Firestore después de Storage** | El objeto queda subido, la UI **no** muestra éxito, el mensaje **no** promete limpieza, y queda **un único** objeto que el reintento sobrescribe |

Para reproducir S-8: forzar la denegación de Firestore (p. ej. con un actor de
la sección D) manteniendo el permiso de Storage.

---

## 7. Integridad financiera

Tras cada caso PERMITIDO (P1–P5), comparar el documento antes y después y
confirmar que estos campos quedan **exactamente iguales**:

- `cobroDelivery.monto`
- `cobroDelivery.tipoCliente`
- `cobroDelivery.quienPaga`
- `cobroDelivery.registradoAt`
- `confirmacion.precioFinalCordobas`
- `cobroContraEntrega`
- `cobrosMotorizado`
- `registro`
- `asignacion`
- `pagoDelivery`
- `acumulacionCobroSemanal`

**Criterio de comparación: igualdad profunda, valor a valor**, sobre el objeto
deserializado. No comparar serializaciones ni «byte a byte»: el orden de claves
y la representación de los `Timestamp` pueden variar entre lecturas sin que haya
cambiado ningún valor, y eso produciría falsos positivos.

Los únicos campos que pueden haber cambiado son los seis del payload de la
sección 1.

---

## 8. Cierre de la validación

- **Export final** del estado del Emulator a un directorio **nuevo** dentro de
  `.emulator-data/` (nunca sobrescribir `matriz-storage-actual`). Sugerido:
  `.emulator-data/bloque-2a-validacion`.
  Forzar el export por el hub **antes** de detener nada, para evitar el
  `EPERM: operation not permitted, rename` de OneDrive:
  ```powershell
  Invoke-RestMethod -Uri 'http://127.0.0.1:4400/_admin/export' -Method Post `
    -ContentType 'application/json' `
    -Body (@{path='<ruta absoluta destino>'; initiatedBy='x'} | ConvertTo-Json)
  ```
- **Comprobaciones estáticas**: `npx tsc --noEmit` contra el baseline de **16
  errores** y `npx next lint` contra el de **51 incidencias**, normalizando
  números de línea. Compilar reglas con
  `firebase emulators:exec --project demo-storkhub --only firestore 'node -e "process.exit(0)"'`
  (nunca `deploy --dry-run`: tocaría Firebase real).
- **Auditoría completa**: comandos ejecutados, ramas visitadas, HEAD antes y
  después, exports creados, procesos, puertos liberados (3000, 4000, 5001, 8080,
  9099, 9199, 4400, 9150), working tree limpio y cero archivos sin seguimiento.

## 9. Criterio de aprobación

El Bloque 2A solo puede declararse validado si:

- P1–P8: **8/8 permitidos**
- D1–D58: **58/58 denegados**, cada uno por su condición prevista
- M1–M5: **5/5 denegados sin error de evaluación**
- Regresión 0C + B1: **idéntica a los resultados registrados**
- UI-1 a UI-13: **13/13**
- S-1 a S-8: conforme a lo esperado, con S-6 y S-7 documentados como **deuda
  abierta**, no como fallo
- Integridad financiera: **sin una sola diferencia**

Cualquier desviación se reporta **antes** de integrar. Y aunque todo pase, el
2A **no queda autorizado a producción**: la deuda de Storage descrita en
`00-LEEME-PRIMERO.md` sigue abierta.
