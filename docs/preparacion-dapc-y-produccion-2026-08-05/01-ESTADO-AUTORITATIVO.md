# ESTADO AUTORITATIVO — 2026-08-05

Hashes verificados con `git fetch --all --prune` desde la PC laboral el
2026-08-05. Si alguno difiere al empezar la sesión en DAPC, **detenerse y
reportar antes de tocar nada**.

---

## Master

```
44dd2a8f768af8f6654eecd5d22b02ce9683ce23
```

Rama: `master` · `origin/master`
Estado: **INTACTO**. No se ha tocado en ninguna de las sesiones de esta serie.
No hay deploy. No se ha usado Firebase real.

## WIP — base aprobada

```
d1771f12780276fe01412be6c0c35c03cfee06db
```

Rama: `wip/bloque-d-identidad-emulator`
También apuntan aquí: `origin/integration/p1-identidad-y-roles`

Contiene los Bloques 0C y 1 integrados y validados. Es la **única base
aprobada** y el punto de partida de todo lo que sigue.

Ramas fuente conservadas, no borrar todavía:

| Rama | Hash |
|---|---|
| `fix/p1-control-escalamiento-roles` | `7642c7ee0d5443989a29c2af12fb321a61b637f7` |
| `feat/p1-comercioid-canonico-ordenes` | `52fabd72c05f73b984cdfa16ebe7a591b1163818` |
| `integration/p1-identidad-y-roles` | `d1771f12780276fe01412be6c0c35c03cfee06db` |

---

## Bloque 2A — boucher del comercio

Rama:

```
fix/p1-boucher-comercio-provisional
```

HEAD:

```
4f54549f54e600edb30f3407f8ec0007d20606b5
```

Commits, en orden:

```
f2ce7fdfca29618ed174b2f8581b3b76f27af11b
b1423d9e91d9b1608ee7fbbf09c2434ce037f0f4
4f54549f54e600edb30f3407f8ec0007d20606b5
```

| Commit | Asunto | Qué aporta |
|---|---|---|
| `f2ce7fd` | `fix(comercio): restringir boucher provisional` | Rama de update propia del comercio, allowlist raíz y anidada, pertenencia por `comercioUid`, payload de la UI reducido, `handleQuitarBoucher` eliminado |
| `b1423d9` | `fix(comercio): distinguir primera carga de reemplazo` | `sinRastroDeBoucher()` sobre las cuatro claves; reemplazo exige boucher propio y completo |
| `4f54549` | `fix(comercio): denegar cobroDelivery anterior malformado` | `cobroDeliveryAnteriorTieneFormaValida()`: ausente es válido, no-mapa se deniega |

Archivos modificados respecto de la WIP: **exactamente dos**

```
firestore.rules
app/panel/comercio/mis-ordenes/page.tsx
```

El diff de `firestore.rules` es **puramente aditivo** en los tres commits: las
ramas de `allow update` de admin/gestor y de motorizado, y `read`, `create` y
`delete`, quedaron sin tocar.

Estado:

```
CONSTRUCCIÓN ESTÁTICA CORREGIDA — PENDIENTE DE VALIDACIÓN EN DAPC
```

---

## P1-S1 — Storage: denegar delete y validar archivos

Rama:

```
fix/p1-storage-s1-delete-mime-size
```

HEAD:

```
308aa5089b27ca1e883c60a49aebe06cccfcd2b1
```

Parent:

```
d1771f12780276fe01412be6c0c35c03cfee06db
```

Un solo commit, un solo archivo modificado: `storage.rules` (35 inserciones,
10 borrados). Los 10 borrados son las cinco líneas `allow write` y los cinco
cierres de lista de roles; **ninguna lista de roles cambió de contenido**.

Estado:

```
CONSTRUCCIÓN ESTÁTICA COMPLETA — PENDIENTE DE VALIDACIÓN EN DAPC
```

---

## Relación entre las ramas

**2A y S1 son ramas HERMANAS E INDEPENDIENTES**, ambas con parent directo o
indirecto en `d1771f1`:

```
* 308aa50 (fix/p1-storage-s1-delete-mime-size)
| * 4f54549 (fix/p1-boucher-comercio-provisional)
| * b1423d9
| * f2ce7fd
|/
*   d1771f1 (wip/bloque-d-identidad-emulator)
```

Consecuencias prácticas:

- **No hay dependencia entre ellas.** Se pueden validar en cualquier orden.
- **Tocan archivos disjuntos**: 2A toca `firestore.rules` y un `.tsx`; S1 toca
  `storage.rules`. Un merge no debería producir conflicto de texto.
- **Eso no las hace válidas juntas.** El flujo del boucher del 2A pasa por
  Storage, y S1 cambia las reglas de Storage: hay que probar el boucher **con
  las reglas de S1 activas**. Ver `04-PLAN-INTEGRACION-2A-Y-S1.md`.

## Baselines estáticos vigentes (no son cero)

| Chequeo | Baseline | Comando |
|---|---|---|
| TypeScript | **16 errores preexistentes** | `npx tsc --noEmit` |
| Lint focal | **51 incidencias preexistentes** | `npx next lint --file <a> --file <b>` |

Al comparar, **normalizar el número de línea** (los bloques insertan líneas y
desplazan las incidencias posteriores) y filtrar `tsc` por `error TS\d+` para
descartar el ruido de `npm notice`.

## Entorno

| | DAPC | PC laboral |
|---|---|---|
| Hostname | `DAPC` | `COR-D_ALONZO` |
| Usuario | `alonz` | `d_alonzo` |
| Repo | `C:\Users\alonz\OneDrive\Escritorio\shenvio-landing-v3-nuevo` | `C:\Users\d_alonzo\dev\shenvio-bloque1` |
| Emulator | **Sí** | No (restricción de permisos) |
| `node_modules` | Sí | **No** |
| `.env.local` | Sí | **No** |
| Git / Node | 2.53.0 / v20.20.2 | 2.53.0 / **v24.14.0** (portátiles) |

Proyecto Firebase de pruebas: **`demo-storkhub`**. El prefijo `demo-` impide
todo acceso a servicios reales; verificable en cada arranque por el mensaje
«Detected demo project ID».
