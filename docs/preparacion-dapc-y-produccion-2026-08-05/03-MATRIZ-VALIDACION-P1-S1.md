# MATRIZ DE VALIDACIÓN — P1-S1 (STORAGE)

Rama `fix/p1-storage-s1-delete-mime-size`, HEAD `308aa50`, parent `d1771f1`.
Un solo archivo modificado: `storage.rules`.

Ejecutar en DAPC con Storage Emulator (puerto 9199), proyecto `demo-storkhub`.

---

## Qué cambia S1

En los cinco `match` (`evidencias/`, `depositos/`, `motorizados/`, `saldos/`,
`liquidaciones/`):

- `allow write` → **`allow create, update`**, con la condición de actor
  **idéntica** (mismos roles, misma comprobación de `activo`).
- **`allow delete: if false;`** añadido en los cinco.
- Validación de metadata añadida a `create, update`.

**Límites exactos:**

| Ruta | contentType | Tamaño |
|---|---|---|
| `evidencias/{solicitudId}/{filename}` | `image/jpeg` | `> 0` y `<= 5 * 1024 * 1024` (**5 MiB**) |
| `depositos/{depositoId}/{filename}` | `image/jpeg` | `> 0` y `<= 5 MiB` |
| `motorizados/{motorizadoId}/{filename}` | `image/jpeg` | `> 0` y `<= 5 MiB` |
| `saldos/{saldoId}/{filename}` | `image/jpeg` | `> 0` y `<= 5 MiB` |
| `liquidaciones/{liquidacionId}/{filename}` | `application/pdf` | `> 0` y `<= 10 * 1024 * 1024` (**10 MiB**) |

**Esto valida METADATA declarada, no los bytes reales del archivo.** Un archivo
con `contentType: image/jpeg` y contenido arbitrario sigue pasando. La
validación de contenido corresponde a la fase server-side.

Sin cambios: `allow read` (cinco líneas, intactas), el deny final
`match /{allPaths=**} { allow read, write: if false; }`, los paths, los nombres
de archivo, las listas de roles y el número de `firestore.get` (10 antes, 10
después — no se introdujeron helpers ni se refactorizaron las lecturas
duplicadas del perfil).

---

## Grupo 1 · Delete — casos 1 a 8

**Los ocho deben quedar DENEGADOS tras S1.** Es el núcleo del bloque.

| # | Caso | Actual | Tras S1 |
|---|---|---|---|
| 1 | Comercio A borra evidencia **propia** | Permitido | **DENEGADO** |
| 2 | Comercio B borra evidencia **de A** | Permitido | **DENEGADO** |
| 3 | **Gestor** borra evidencia | Permitido | **DENEGADO** |
| 4 | **Admin** borra evidencia | Permitido | **DENEGADO** |
| 5 | **Motorizado asignado** borra evidencia | Permitido | **DENEGADO** |
| 6 | **Motorizado no asignado** borra evidencia | Permitido | **DENEGADO** |
| 7 | Motorizado borra **boucher de depósito** (`depositos/`) | Permitido | **DENEGADO** |
| 8 | Gestor borra **PDF de liquidación** (`liquidaciones/`) | Permitido | **DENEGADO** |

Los casos 3 y 4 son intencionados: admin y gestor pierden el borrado **por SDK
cliente**. No se pierde ninguna capacidad real — ver caso 35.

---

## Grupo 2 · Create / update válidos — casos 9 a 13

**Los cinco deben SEGUIR funcionando.** Si alguno deniega, S1 rompió la
operativa y hay que detenerse.

| # | Caso | Esperado |
|---|---|---|
| 9 | Comercio sube **JPEG ≤ 5 MiB** a `evidencias/` | PERMITIDO |
| 10 | Comercio **reemplaza** JPEG ≤ 5 MiB (es el reemplazo del Bloque 2A) | PERMITIDO |
| 11 | Motorizado sube JPEG ≤ 5 MiB | PERMITIDO |
| 12 | Gestor sube JPEG ≤ 5 MiB | PERMITIDO |
| 13 | Gestor sube **PDF ≤ 10 MiB** a `liquidaciones/` | PERMITIDO |

En los cinco debe conservarse **la autorización de actor actual**: los mismos
roles que antes, y ningún rol nuevo. Verificar además que un usuario
**inactivo** sigue denegado en los cinco.

`compressImage` produce JPEG de lado máximo 1200 px y calidad 0.75, muy por
debajo de 5 MiB, así que el caso 9 debería pasar con holgura. El caso 13 es el
que conviene medir de verdad: **el tamaño real del PDF de liquidación no se
midió nunca**. Si se acerca a 10 MiB, reportarlo antes de integrar.

---

## Grupo 3 · MIME denegado — casos 14 a 19

| # | Caso | Tras S1 |
|---|---|---|
| 14 | **PDF** en `evidencias/` | **DENEGADO** |
| 15 | **PNG** en `evidencias/` | **DENEGADO** |
| 16 | **HTML** (`text/html`) en `evidencias/` | **DENEGADO** |
| 17 | **JPEG** en `liquidaciones/` | **DENEGADO** |
| 18 | `contentType` **ausente** | **DENEGADO** |
| 19 | `contentType` **vacío** | **DENEGADO** |

Los casos 18 y 19 son los que hay que mirar con más cuidado: se espera que
`request.resource.contentType` resuelva a null o cadena vacía y que la
comparación falle, **denegando limpiamente**. Confirmar que no produce error de
evaluación. Conviene probar también `application/octet-stream` y
`image/webp`/`image/gif`, que deben denegar por la misma vía.

---

## Grupo 4 · Tamaño denegado — casos 20 a 23

| # | Caso | Tras S1 |
|---|---|---|
| 20 | Imagen de **0 bytes** | **DENEGADO** |
| 21 | Imagen **> 5 MiB** | **DENEGADO** |
| 22 | PDF de **0 bytes** | **DENEGADO** |
| 23 | PDF **> 10 MiB** | **DENEGADO** |

Probar además los límites exactos: 5 MiB y 10 MiB clavados deben **PERMITIR**
(la condición es `<=`), y un byte más debe denegar.

---

## Grupo 5 · Riesgos que PERMANECEN ABIERTOS — casos 24 a 34

**Ninguno de estos se corrige con S1.** Se prueban para dejar constancia
documentada del estado real, no para verlos en verde.

| # | Caso | Estado tras S1 | Se cierra en |
|---|---|---|---|
| 24 | **Comercio A escribe sobre orden de B** | **Sigue permitido** | P1-S2 |
| 25 | **Motorizado no asignado escribe** sobre una orden | **Sigue permitido** | P1-S2 |
| 26 | **Comercio reemplaza el boucher del gestor directamente en Storage** | **Sigue permitido** | P1-S2 |
| 27 | **Nombre arbitrario** dentro de `evidencias/` | **Sigue permitido** | P1-S2 |
| 28 | **Lectura ajena** (cualquier autenticado lee cualquier objeto) | **Sin cambios** | P1-S3 |
| 29 | **Usuario inactivo leyendo** | **Sin cambios** | P1-S3 |
| 30 | **`list` sobre carpeta** | **REQUIERE EMULATOR** · sin cambios | P1-S3 |
| 31 | **`updateMetadata` ajeno** | **REQUIERE EMULATOR** | por definir |
| 32 | **URL con token tras logout** | **Sigue vigente** | server-side |
| 33 | **URL con token tras inactivar usuario** | **Sigue vigente** | server-side |
| 34 | **Fallo de Firestore tras Storage deja objeto sin rollback** | **Sigue abierto** | server-side |

Aclaraciones que deben constar en el informe de DAPC:

- **El comercio ajeno sigue escribiendo hasta P1-S2.** S1 no comprueba
  pertenencia; ninguna regla usa el `{solicitudId}` del path.
- **El motorizado no asignado sigue escribiendo hasta P1-S2.**
- **Los nombres arbitrarios siguen hasta P1-S2.** La allowlist de nombres
  corresponde a ese bloque.
- **`read` sigue exactamente igual hasta P1-S3.** S1 no toca ninguna línea de
  `allow read`.
- **`list` continúa clasificado como REQUIERE EMULATOR.** Su denegación
  explícita es de P1-S3. *(Corrección de una contradicción documental previa: en
  un informe anterior se dijo que `list` quedaría denegado tras S1. Es
  incorrecto.)*
- **Las URLs con token no se corrigen con S1** ni con S2 ni con S3. Solo el
  streaming server-side y la rotación de tokens las resuelven.
- **El rollback sigue pendiente.** Es de la fase server-side.

**Caso 30 y 31: marcar como REQUIERE EMULATOR, no como aprobado ni como fallo.**

---

## Grupo 6 · Admin SDK — caso 35

| # | Caso | Esperado |
|---|---|---|
| 35 | `limpiarEvidencias` conserva su capacidad de borrado | **PERMITIDO** |

`limpiarEvidencias` (`functions/src/index.ts:15-69`) usa **Admin SDK**, que
**no pasa por Storage Rules**. Por eso denegar delete a admin y gestor en el SDK
cliente no elimina ninguna capacidad real del sistema.

**No se evalúa como operación cliente.** Verificarlo ejecutando la función
contra el Emulator, o al menos dejando constancia de que el borrado por Admin
SDK sigue disponible.

Recordar que esa función tiene dos defectos conocidos, **fuera del alcance de
S1**: cubre solo 3 de ~12 rutas (no toca `cobroDelivery.boucherPath`,
`evidenciasTerminal`, `evidenciasCargotrans`, `depositos/`, `saldos/`,
`liquidaciones/` ni `motorizados/`), y borra el puntero de Firestore aunque el
borrado en Storage haya fallado, porque el error se traga con `.catch(warn)`.

---

## Criterio de aprobación de S1

- Casos 1–8: **8/8 denegados**
- Casos 9–13: **5/5 permitidos**, sin cambio en la autorización de actor
- Casos 14–19: **6/6 denegados**, sin error de evaluación
- Casos 20–23: **4/4 denegados**, y los límites exactos permitidos
- Casos 24–34: **documentados como abiertos**, con 30 y 31 en REQUIERE EMULATOR
- Caso 35: **borrado por Admin SDK operativo**

Además: las reglas deben **compilar** (no verificado aún) y el flujo del boucher
del Bloque 2A debe seguir funcionando **con las reglas de S1 activas** — eso se
prueba en la integración conjunta, no aquí.
