# BACKLOG PRIORIZADO HACIA PRODUCCIÓN

Clasificación de cada tarea:

- **BP** — bloqueador de piloto
- **BPR** — bloqueador de producción
- **PP** — posterior al piloto

---

## Ruta principal

### 1. Validar el Bloque 2A · **BP**

**Depende de:** nada. Es el siguiente paso.
**Entrega:** matriz de `02-MATRIZ-VALIDACION-BLOQUE-2A.md` ejecutada en DAPC.
**Bloquea:** 3.
Sin esto el comercio no puede registrar su boucher: el flujo termina en
`permission-denied` y deja un objeto huérfano.

### 2. Validar P1-S1 · **BP**

**Depende de:** nada (rama hermana e independiente del 2A).
**Entrega:** los 35 casos de `03-MATRIZ-VALIDACION-P1-S1.md`.
**Bloquea:** 3.
Cierra el borrado desde clientes, que es la capacidad más destructiva abierta
hoy.

### 3. Integrar 2A + S1 · **BP**

**Depende de:** 1 y 2.
**Entrega:** rama de integración validada y fast-forward de la WIP.
**Bloquea:** 4, 9.
Procedimiento en `04-PLAN-INTEGRACION-2A-Y-S1.md`. Incluye probar el boucher
**con las reglas de S1 activas**.

### 4. Investigar históricos para P1-S2 · **BP**

**Depende de:** 3.
**Entrega:** respuesta documentada a dos preguntas que la auditoría no pudo
resolver estáticamente:

1. ¿Las órdenes **históricas** llevan `asignacion.motorizadoAuthUid` con la
   forma que espera `isAssignedMotorizado()`? Si no, S2 dejaría sin subir
   evidencia a motorizados en órdenes antiguas.
2. ¿Existen objetos en `evidencias/` **sin documento de orden** correspondiente?
   Un `firestore.get()` fallido en Storage Rules deniega, y hay que saber cuánto
   se rompería.

**Bloquea:** 5. **No construir S2 antes de tener esto.**

### 5. Construir y validar P1-S2 · **BPR**

**Depende de:** 4.
**Entrega:** pertenencia real en `evidencias/` — comercio por `comercioUid`,
motorizado por asignación — más allowlist de nombres de archivo.
Cierra: comercio sobre orden ajena, motorizado no asignado, overwrite ajeno,
nombres arbitrarios. **Es el bloqueador de producción más importante que queda.**

### 6. Construir y validar P1-S3 · **BPR**

**Depende de:** 5.
**Entrega:** `read` por pertenencia y `list` denegado explícitamente.
Requiere resolver antes el caso `list` marcado como REQUIERE EMULATOR.
**Nota realista:** no protege las URLs con token ya emitidas. Es higiene
necesaria, no remedio completo.

### 7. Limpiar configuraciones muertas · **PP**

**Depende de:** 3 (para no mezclar diffs).
**Entrega:** eliminación de `fb/config-DAPC.ts`, `fb/config-DAPC-2.ts` y
`fb_old/config.ts`; opcionalmente los 51 archivos `*-DAPC*` restantes.
Detalle y pruebas requeridas en `05-AUDITORIA-CONFIGURACIONES-MUERTAS.md`.
Reduce el baseline de TypeScript, así que hay que reajustar el número.

### 8. Rotar credenciales · **BPR**

**Depende de:** nada, pero conviene hacerlo cerca del despliegue.
**Entrega:** rotación de la clave de Google Maps con restricción por referrer,
revisión de credenciales de correo y de cualquier service account. Confirmar que
ningún secreto está versionado. *(Las claves web de Firebase son públicas por
diseño y no requieren rotación por este motivo.)*

### 9. Cerrar TypeScript y build · **BPR**

**Depende de:** 3.
**Entrega:** los **16 errores** de `tsc` en cero, o justificados uno por uno, y
`npm run build` limpio. Hoy los 16 están en `comercio/depositos`,
`gestor/base-datos`, `gestor/depositos`, `gestor/gastos`, `gestor/page.tsx` y los
dos `page-DAPC*.tsx` — estos últimos desaparecen con la tarea 7.
También las **51 incidencias** de lint, al menos las de los archivos activos.

### 10. Preparar staging · **BP**

**Depende de:** 3.
**Entrega:** apartado 1 de `06-CHECKLIST-STAGING-BACKUP-OBSERVABILIDAD.md`.
**Bloquea:** 11, 12, 15.
Sin staging, la única infraestructura real disponible es producción.

### 11. Regresión financiera · **BPR**

**Depende de:** 10.
**Entrega:** verificación extremo a extremo de depósitos, liquidaciones, saldos,
ledger de `movimientos_financieros` y cobro semanal, con cifras cuadradas.
Atención especial a la confirmación de pago del gestor: escribe un batch y
**después** registra el movimiento fuera del batch — un fallo intermedio deja el
depósito sin movimiento.

### 12. Pruebas E2E · **BPR**

**Depende de:** 10.
**Entrega:** recorridos automatizados por rol: comercio crea orden y sube
boucher; gestor ingresa orden, asigna y confirma pago; motorizado retira,
entrega y sube evidencia; cliente consulta.

### 13. Backups y restauración · **BPR**

**Depende de:** 10.
**Entrega:** apartado 2 del checklist, **con la prueba de restauración
ejecutada**. Debe estar listo **antes** de cualquier backfill.

### 14. Observabilidad · **BP** (básica) / **BPR** (completa)

**Depende de:** 10.
**Entrega:** apartado 3 del checklist. La parte [PILOTO] es bloqueador de
piloto; la financiera y de huérfanos es bloqueador de producción.

### 15. Piloto controlado · **BP**

**Depende de:** 1, 2, 3, 10, 14.
**Entrega:** operación real con un número acotado de comercios y motorizados,
durante un periodo definido, con responsable y criterio de éxito escrito.

### 16. Corregir hallazgos del piloto · **BPR**

**Depende de:** 15.

### 17. Release candidate · **BPR**

**Depende de:** 5, 6, 8, 9, 11, 12, 13, 14, 16.
**Entrega:** rama congelada, validada entera, con notas de versión y plan de
reversión.

### 18. Producción · **BPR**

**Depende de:** 17.
**Entrega:** despliegue con `master` actualizado por primera vez en toda esta
serie. Hasta aquí `master` no se ha tocado ni una vez, y esa disciplina se
mantiene hasta este punto.

---

## Fuera de la ruta principal

| Tema | Descripción | Clasif. | Notas |
|---|---|---|---|
| **Rol digitador** | Rol nuevo con permisos acotados de captura de órdenes | **PP** | No existe en el esquema actual. `hasKnownActiveRole()` valida contra una lista **cerrada** de cinco roles: añadir uno toca ambos archivos de reglas y obliga a repetir las matrices de 0C y B1 |
| **Enlaces temporales** | URLs firmadas y caducables para comercio y destinatario | **BPR** | Es el remedio real a las URLs con token permanente. Requiere servidor |
| **Streaming server-side** | Servir imágenes por endpoint autorizado en vez de URL directa | **BPR** | Cierra de verdad la lectura ajena. Hace innecesaria la URL con token. Coste: latencia y ancho de banda |
| **UUID en nombres** | Sustituir los nombres fijos por identificadores únicos | **BPR** | Elimina la sobrescritura silenciosa y el path adivinable. **Requiere migración**: los objetos y punteros existentes usan nombre fijo |
| **Liquidaciones bajo demanda** | Generar el PDF al pedirlo, en vez de almacenarlo | **PP** | Elimina de raíz el riesgo del PDF sobreexpuesto en Storage |
| **Compresión móvil** | Revisar `compressImage` en gama baja | **PP** | Usa `createImageBitmap` + canvas; con las validaciones de S1, un fallo de compresión ahora puede traducirse en denegación por MIME o tamaño |

---

## Camino crítico

```
1 (2A) ─┐
        ├─► 3 (integrar) ─► 4 (investigar) ─► 5 (S2) ─► 6 (S3) ─┐
2 (S1) ─┘         │                                              │
                  └─► 10 (staging) ─► 14 (observabilidad) ─► 15 (piloto) ─► 16 ─► 17 ─► 18
                            ├─► 11 (financiera)                              ▲
                            ├─► 12 (E2E)                                     │
                            └─► 13 (backups) ────────────────────────────────┘
```

**Lo más corto hasta el piloto:** 1 → 2 → 3 → 10 → 14 → 15.
**Lo que no se puede saltar hacia producción:** 5 y 6 (pertenencia y lectura en
Storage), 13 (backups probados) y 11 (regresión financiera).

**Primer paso concreto, hoy:** ejecutar en DAPC el prompt de
`08-PROMPT-DAPC-SIGUIENTE-SESION.md`.
