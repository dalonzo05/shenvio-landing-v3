# AUDITORÍA DE CONFIGURACIONES MUERTAS

Auditoría **de solo lectura** realizada el 2026-08-05 sobre la WIP `d1771f1`.
**No se eliminó ningún archivo. No se abrió `.env`. No se imprime ningún valor
de configuración.**

Método: `git ls-files` para versionado, `git grep` sobre archivos activos para
referencias, y extracción de **nombres de clave** (no valores) para comparar
estructura.

---

## Resumen

| Archivo | Versionado | Importado por | Clasificación |
|---|---|---|---|
| `fb/config-DAPC.ts` | Sí | **Nadie** | **MUERTO CONFIRMADO** |
| `fb/config-DAPC-2.ts` | Sí | **Nadie** | **MUERTO CONFIRMADO** |
| `fb_old/config.ts` | Sí | **Nadie** | **MUERTO CONFIRMADO** |

Comprobación de referencias:

```
git grep -n -E "fb_old|config-DAPC|page-DAPC" -- '*.ts' '*.tsx' ':!*-DAPC*' ':!fb_old/*'
  → sin resultados (exit 1)
```

Es decir: **ningún archivo activo importa ni menciona a ninguno de los tres.**

---

## 1. `fb/config-DAPC.ts`

| Campo | Contenido |
|---|---|
| Versionado en Git | **Sí** |
| Tamaño | 25 líneas, 1 062 bytes |
| Quién lo importa | **Nadie** |
| Referencias encontradas | Ninguna en código activo |
| Claves de configuración | `apiKey`, `authDomain`, `projectId`, `storageBucket`, `messagingSenderId`, `appId`, `measurementId` |
| Exports | `firebaseConfig`, `app`, `db`, `auth`, `storage` |
| Bucket | El **bucket REAL de producción** (`storkhub-9f719…`) |
| projectId | El proyecto **REAL** (`storkhub-9f719`) |
| authDomain | El dominio **REAL** del proyecto |
| Menciona Emulator | **NO** |

**Diferencias con `fb/config.ts` (109 líneas, 6 200 bytes):**

`fb/config.ts` es el archivo activo y contiene toda la lógica de aislamiento que
el Bloque D introdujo y que `config-DAPC.ts` **no tiene**:

- Detección de `usandoEmulator` y `EMULATOR_PROJECT_ID`.
- `emulatorConfig`, que reescribe `projectId`, `authDomain` **y `storageBucket`**
  al proyecto local. Antes esto no se hacía y Storage era el único servicio que
  en modo emulador seguía apuntando **al bucket real** — el hallazgo 15 de la
  auditoría de Storage.
- `activeConfig` como fuente única de verdad.
- `connectAuthEmulator`, `connectFirestoreEmulator`, `connectFunctionsEmulator` y
  `connectStorageEmulator`, bajo un guard de `typeof window !== 'undefined'` y
  `globalThis` para sobrevivir a Fast Refresh.
- Export de `functions`, que `config-DAPC.ts` no tiene.

**Riesgo si vuelve a importarse:** reintroduce el hallazgo 15 **de forma
silenciosa**. Un `import { db } from '@/fb/config-DAPC'` en cualquier archivo
haría que esa parte de la app hablara con **Firestore, Auth y Storage reales**
aunque el resto de la sesión estuviera en el Emulator, sin ningún aviso. Es
justo el modo de fallo que el Bloque D cerró.

**¿Contiene secretos reales?** No en el sentido de credenciales privilegiadas.
Son las claves de configuración web de Firebase (`apiKey`, `appId`, etc.), que
son **públicas por diseño** — viajan al navegador en cualquier app de Firebase y
no otorgan acceso por sí solas; quien protege es Auth + las reglas. Dicho eso,
**identifican inequívocamente el proyecto de producción**, y por eso conviene no
tenerlas duplicadas en archivos que nadie mantiene. **No hay `.env`, ni claves
privadas, ni service accounts en estos archivos.**

---

## 2. `fb/config-DAPC-2.ts`

**Byte a byte idéntico a `fb/config-DAPC.ts`** (mismo hash SHA-256, 25 líneas,
1 062 bytes). Todo lo anterior aplica sin cambios.

Es una segunda copia de respaldo de la misma época. Su existencia duplicada
refuerza la clasificación de muerto: no es una variante, es un duplicado exacto.

---

## 3. `fb_old/config.ts`

| Campo | Contenido |
|---|---|
| Versionado en Git | **Sí** |
| Tamaño | 21 líneas, 907 bytes |
| Quién lo importa | **Nadie** |
| Referencias encontradas | Ninguna |
| Claves de configuración | Las mismas siete |
| Exports | **Solo `app` y `db`** (sin `auth`, sin `storage`) |
| Bucket / projectId / authDomain | Los **REALES** |
| Menciona Emulator | **NO** |

Es la versión más antigua de las tres: exporta menos servicios y vive en una
carpeta `fb_old/` que contiene **únicamente** este archivo.

**Riesgo si vuelve a importarse:** el mismo que los anteriores, aunque acotado a
Firestore, porque no exporta `auth` ni `storage`.

---

## Estrategia de eliminación propuesta

**No ejecutar en este encargo.** Propuesta para un encargo posterior, después de
integrar 2A + S1:

1. Rama propia, p. ej. `chore/limpiar-configuraciones-muertas`, desde la WIP ya
   integrada.
2. Eliminar los tres archivos con `git rm`, y la carpeta `fb_old/` completa si
   queda vacía.
3. **Un solo commit**, con mensaje que explique la causa (reintroducción
   silenciosa del bucket real), no solo el cambio.
4. Considerar en el mismo encargo, o en otro, los **51 archivos `*-DAPC*`
   restantes** (páginas, componentes, `package-DAPC.json`, etc.), que están en la
   misma situación: versionados y sin referencias. Esta auditoría solo cubrió
   los tres de configuración porque son los que reintroducen el bucket real.

### Riesgos de borrarlos

- **Bajo, pero no nulo.** El riesgo real no es de ejecución sino de **pérdida de
  referencia histórica**: son copias que el usuario conservó a propósito para
  comparar contra el estado anterior.
- **Mitigación completa:** están versionados en Git, así que `git show
  <commit>:fb/config-DAPC.ts` los recupera siempre. Borrarlos del árbol **no**
  los borra de la historia.
- **No hay riesgo de romper el build**: TypeScript no compila lo que nadie
  importa, y `next build` no incluye módulos no alcanzables. Los 16 errores del
  baseline de `tsc` **sí** incluyen archivos `-DAPC` (`page-DAPC*.tsx`), así que
  **borrarlos reduciría el baseline** — lo cual es bueno, pero obliga a
  actualizar el número de referencia.

### Pruebas necesarias después de eliminarlos

1. `npx tsc --noEmit` — el conteo de errores **debe bajar** respecto de 16;
   registrar el nuevo baseline y verificar que ningún error nuevo aparece en
   archivos activos.
2. `npx next lint` — comparar contra el baseline de 51, normalizando líneas.
3. `npm run build` — debe completar. Es la prueba de que ningún import dinámico o
   ruta de Next dependía de un archivo eliminado.
4. Arranque de la app contra el Emulator y smoke test: login, panel de comercio,
   panel de gestor, panel de motorizado.
5. `git grep` de los nombres eliminados para confirmar cero referencias
   residuales, incluidos comentarios y documentación.

---

## Clasificación final

| Archivo | Clasificación |
|---|---|
| `fb/config-DAPC.ts` | **MUERTO CONFIRMADO** |
| `fb/config-DAPC-2.ts` | **MUERTO CONFIRMADO** |
| `fb_old/config.ts` | **MUERTO CONFIRMADO** |

Ninguno es «todavía usado». Ninguno «requiere investigación»: la comprobación de
referencias fue exhaustiva sobre `*.ts` y `*.tsx` activos y dio vacío.

**Los 51 archivos `*-DAPC*` restantes quedan como REQUIERE INVESTIGACIÓN**, no
porque se sospeche que estén vivos, sino porque esta auditoría no los cubrió uno
por uno.

---

## Declaración

- No se eliminó ningún archivo.
- No se abrió `.env` ni `.env.local` (este clon no tiene `.env.local`).
- No se imprimió ningún valor de `apiKey`, `appId`, `messagingSenderId` ni
  ninguna otra clave: solo **nombres** de campo y la constatación de que el
  `projectId` coincide con el proyecto real.
