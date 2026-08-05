# PLAN DE INTEGRACIÓN — BLOQUE 2A + P1-S1

**Este documento describe un procedimiento futuro. No se ha ejecutado nada de
lo que sigue.** No se hizo merge, ni cherry-pick, ni rebase, ni fast-forward.

---

## Punto de partida

```
* 308aa50 (fix/p1-storage-s1-delete-mime-size)
| * 4f54549 (fix/p1-boucher-comercio-provisional)
| * b1423d9
| * f2ce7fd
|/
*   d1771f1 (wip/bloque-d-identidad-emulator)
```

Ramas hermanas, sin dependencia entre ellas, ambas ancladas en `d1771f1`.

---

## Procedimiento

### 1. Validar el Bloque 2A aislado

Con la rama `fix/p1-boucher-comercio-provisional` sola, según
`02-MATRIZ-VALIDACION-BLOQUE-2A.md`. Export a
`.emulator-data/bloque-2a-validacion`.

**No continuar si algo falla.** Corregir en la propia rama, con un commit nuevo
(nunca `amend`), y repetir.

### 2. Auditar el resultado del 2A

Contrastar cada caso contra el criterio de aprobación. Verificar que **cada
denegación lo fue por su condición prevista** y no por error de evaluación.
Registrar los baselines de TypeScript y lint.

### 3. Validar P1-S1 aislado

Con la rama `fix/p1-storage-s1-delete-mime-size` sola, según
`03-MATRIZ-VALIDACION-P1-S1.md`. Export a `.emulator-data/p1-s1-validacion`.

### 4. Auditar el resultado de S1

Igual que en el paso 2. Confirmar en particular que los casos 24–34 quedaron
documentados **como abiertos** y no como corregidos.

### 5. Crear la rama de integración desde la WIP

```powershell
git switch wip/bloque-d-identidad-emulator
git rev-parse HEAD          # debe ser d1771f1...
git switch -c integration/2a-y-s1
```

Verificar `git merge-base` contra `origin/wip/bloque-d-identidad-emulator` =
`d1771f12780276fe01412be6c0c35c03cfee06db` **antes** de seguir.

### 6. Integrar ambas ramas sin tocar master

Dos merges `--no-ff`, uno por rama, en el orden que se prefiera (son
independientes):

```powershell
git merge --no-ff origin/fix/p1-boucher-comercio-provisional
git merge --no-ff origin/fix/p1-storage-s1-delete-mime-size
```

Es el mismo procedimiento que se usó con éxito para 0C + B1. **Nunca sobre
`master`.** Si aparece un conflicto, **detenerse y reportar**: no resolverlo a
mano sin autorización.

### 7. Comprobar el alcance del resultado

El diff de `integration/2a-y-s1` contra `d1771f1` debe tocar **exactamente tres
archivos**:

```
firestore.rules
storage.rules
app/panel/comercio/mis-ordenes/page.tsx
```

Ni uno más. Si aparece un cuarto archivo, algo se coló y hay que parar.

### 8. TypeScript

```powershell
npx tsc --noEmit
```

Comparar contra el baseline de **16 errores preexistentes**. Filtrar por
`error TS\d+` para descartar el ruido de `npm notice`. **Cero errores nuevos.**

### 9. Lint comparativo

```powershell
npx next lint --file app/panel/comercio/mis-ordenes/page.tsx
```

Comparar contra el baseline de **51 incidencias**, **normalizando los números de
línea**: los bloques insertan líneas y desplazan todas las incidencias
posteriores, así que una comparación en bruto da falsos positivos.

### 10. Compilar las reglas

```powershell
firebase emulators:exec --project demo-storkhub --only firestore 'node -e "process.exit(0)"'
```

Nunca `deploy --dry-run`: tocaría Firebase real. Compilar **ambos** archivos de
reglas, Firestore y Storage.

### 11. Repetir la matriz crítica del 2A

Bajo las reglas combinadas: P1–P8, los grupos D más sensibles (A, D, F, G, H, I),
los cinco malformados y la regresión de admin/gestor/motorizado. No hace falta
repetir los 58 D uno por uno si el bloque ya se validó aislado, pero **sí** los
que dependen del estado del documento.

### 12. Repetir la matriz COMPLETA de S1

Aquí no se recorta: los 35 casos. S1 es el que cambia las reglas bajo las que
opera el 2A.

### 13. Probar el boucher con las reglas de S1 activas

**Es el punto de la integración que no se puede omitir.** El flujo del comercio
sube a Storage y después escribe en Firestore; S1 cambia las reglas de Storage y
2A cambia las de Firestore. Probar extremo a extremo:

- Primera carga completa (Storage + Firestore) con las dos reglas activas.
- Reemplazo completo.
- Que el JPEG que produce `compressImage` pasa la validación de MIME y tamaño de
  S1 (debería: `image/jpeg`, muy por debajo de 5 MiB — confirmarlo).
- Que la UI muestra éxito solo tras completar ambas operaciones.
- Que el gestor sigue pudiendo subir, reemplazar, quitar y confirmar el pago.

### 14. Auditar

Comandos, HEAD antes y después, exports, working tree limpio, cero archivos sin
seguimiento, puertos liberados, `master` intacto.

### 15. Fast-forward de la WIP — en un encargo posterior

Solo si todo lo anterior pasa, y **como encargo aparte**:

```powershell
git switch wip/bloque-d-identidad-emulator
git merge --ff-only integration/2a-y-s1
```

Debe ser fast-forward puro, sin commit de merge adicional. Después, push de la
WIP. **`master` sigue sin tocarse y no hay deploy.**

---

## Conflictos previsibles

**Funcionalmente no debería haber ninguno**, y conviene decir por qué con
precisión:

- 2A modifica `firestore.rules` (de forma **puramente aditiva**: un bloque nuevo
  insertado entre la rama del motorizado y `allow delete`) y
  `app/panel/comercio/mis-ordenes/page.tsx`.
- S1 modifica **solo** `storage.rules`, que 2A no toca en ninguno de sus tres
  commits — verificado: el blob de `storage.rules` es `59ac5ad` idéntico en
  `master`, la WIP y la rama 2A.
- **No hay ni un archivo en común.** Git no tiene motivo para reportar
  conflicto de texto.

**Y aun así la validación combinada es obligatoria.** Ausencia de conflicto de
texto no es lo mismo que ausencia de interacción funcional:

1. El flujo del boucher del 2A **pasa por Storage**, cuyas reglas cambia S1. Si
   la validación de MIME o tamaño de S1 rechazara lo que produce
   `compressImage`, el 2A dejaría de funcionar sin que ningún merge hubiera
   fallado.
2. S1 deniega `delete` en Storage. Ningún código cliente borra hoy, pero hay que
   confirmar que ninguna ruta del 2A dependía implícitamente de ello.
3. Los mensajes de error de la UI del 2A describen el comportamiento ante fallo;
   con S1 activo aparecen **motivos de fallo nuevos** (MIME, tamaño) que hay que
   ver reflejados razonablemente en pantalla.

**No se debe asumir que dos ramas válidas aisladamente son automáticamente
válidas juntas.** Es exactamente el criterio que se aplicó con 0C + B1, donde la
combinación se validó entera y con 12 casos cruzados añadidos, pese a que los
merges no dieron conflicto.

---

## Qué NO hacer en este procedimiento

- No integrar antes de validar cada rama por separado.
- No tocar `master` en ningún punto.
- No hacer deploy.
- No usar `reset`, `clean`, `rebase`, `cherry-pick`, `amend`, `stash` ni force
  push para resolver nada.
- No borrar las ramas fuente después de integrar: se conservan hasta nueva
  orden.
- No declarar aprobado nada que no se haya ejecutado en Emulator.
