# HANDOFF SHEnvíos para Claude Code Cloud — 2026-10-09

Contexto base obligatorio. Autocontenido: no depende de conversaciones previas, de los `TRASPASO-*.md` locales, de memoria del modelo ni de acceso a staging o producción.

## 1. Propósito y protocolo

Toda sesión Cloud debe:

1. leer este documento primero;
2. verificar refs (`git fetch --all --prune`, comparar con la sección 14);
3. trabajar en una feature branch aislada propia;
4. no hacer deploy de nada;
5. no acceder a producción;
6. terminar devolviendo SHA + gates + clasificación (secciones 12 y 13).

## 2. Repo y stack

- Repo autorizado (máquina local del dueño): `C:\dev\shenvio-landing-v3`.
- Stack: Next.js App Router, React, TypeScript, Tailwind v4, Firebase Auth, Firestore, Storage, Cloud Functions (v2, Node 24), Vercel.
- Firebase staging: `shenvios-staging`.
- Firebase producción: `storkhub-9f719` — **NO ACCESS** sin autorización explícita (sección 10).

## 3. Política Git

```
feature/fix  →  wip/bloque-d-identidad-emulator  →  staging
```

- Integración solo con `git merge --ff-only`.
- Prohibido: force push, merge commits, rebase de ramas compartidas, amend (salvo instrucción explícita).
- Cloud trabaja solo en feature branches propias. **Cloud NO integra a WIP. Cloud NO integra a staging.**

## 4. Archivos locales untracked

Existen en la máquina local `TRASPASO-2026-08-14.md`, `TRASPASO-2026-08-25.md` y `TRASPASO-2026-09-25.md`. Son untracked a propósito; Cloud normalmente no los verá. Nunca borrarlos, moverlos, agregarlos ni stashearlos.

## 5. Baselines (cualquier empeoramiento = STOP)

| Gate | Baseline |
|---|---|
| Rules (emulador) | 379 / 379 |
| Functions | 641 / 641 |
| Root | 1240 / 1240 |
| Root TypeScript | 9 errores en 5 archivos (todos preexistentes, panel gestor: `base-datos/page.tsx`, `depositos/page.tsx`, `page-DAPC-2.tsx`, `page-DAPC.tsx`, `page.tsx`) |
| Functions TS / tests TS / Rules TS | 0 / 0 / 0 |
| Builds Functions y Root | PASS |
| Manifest Functions | 36 = 33 callables + 2 triggers + 1 scheduled; Node 24; `maxInstances` 20 |

Pérdida de tests o aumento inesperado de errores = STOP.

## 6. Invariantes financieras

- **El usuario elige la intención; el servidor demuestra y ejecuta el dinero.**
- Si un monto no puede demostrarse: `conciliacion_requerida`. Nunca inventar ni inferir dinero para hacer pasar un flujo.
- Comisión actual: 80 % de la **base comisionable**, no necesariamente 80 % del precio final.
- Los recargos no comisionables no deben entrar a la base por accidente.

## 7. Bloques cerrados (todos CLOSED IN STAGING)

- **FIN-2, FIN-3, FIN-4A/4B/4C:** cierres financieros previos; el dinero lo ejecuta el servidor.
- **FIN-1A:** ledger (saldos y movimientos) escrito solo por Functions con transacción e idempotencia.
- **FIN-1B:** cobro y liquidación de saldos a cargo con operaciones idempotentes.
- **FIN-1C-A / FIN-1C-B:** cobros y gastos del motorizado pasan por callables con validación server-side.
- **FIN-1D:** adelantos y descuentos de liquidación respaldados por el ledger.
- **FIN-1E:** ledger con blanket deny en Rules; campos de orden inmutables tras el create; punteros de depósito verificados con `getAfter`; guard de doble liquidación.
- **OPS-MAXINSTANCES-1:** `maxInstances` 20 en las 36 Functions.
- **PROD-RUNTIME-NODE-1:** runtime Node 24 en Functions.
- **A2 precio confirmado:** ver sección 8.
- **A2.5 CREATE-AUTHORITY-ORDEN-1:** ver sección 9.

## 8. A2 — precio confirmado server-side

- El precio final se confirma en el servidor. Snapshot en la orden: `confirmacion.precioFinalCordobas`, `confirmacion.comisionBaseCordobas`, `confirmacion.comisionBaseOrigen`.
- `comisionBaseOrigen` ∈ {`tarifa_distancia`, `manual_gestor`}.
- Invariante: `0 < base <= precio final`.
- Orden moderna sin base demostrable: fail closed. Base manual obligatoria cuando la tarifa no puede derivarse.
- La liquidación no usa `deliveryBase` del cliente como autoridad.
- Legacy no demostrable: `conciliacion_requerida`.

## 9. A2.5 — CREATE-AUTHORITY-ORDEN-1

- El `create` de `solicitudes_envio` usa allowlist top-level (`hasOnly`) y allowlists anidadas por mapa (`ownerSnapshot`, `cotizacion`, `recoleccion`, `entrega`, `cobroContraEntrega`, `pagoDelivery`, `paquete`, `programado`, `recargoZona`, `precioDesglose`, `fueraManagua`).
- Los campos server-owned no pueden plantarse en el create: `cobrosMotorizado`, `cobroDelivery`, `cobroPendiente`, `registro`, punteros de depósito, `evidencias*`, `acumulacionCobroSemanal`, `historial`, `confirmacion`, `asignacion`, `entregadoAt`, `codigo`, `secuencia`. Las claves desconocidas dan DENY.
- `creadoInternamente` / `creadoPorGestorUid`: solo admin o gestor activo, juntos, con `== true` y `== request.auth.uid`. `createdAt` debe ser `request.time`. Estado inicial: `pendiente_confirmacion` o `programada`.
- P1 `cobrosMotorizado` plantado al crear (dejaba el efectivo esperado en 0): **CLOSED**.
- Peor margen de presupuesto de expresiones del `allow create`: ≈ 327 de 1000. Un `allow create` más pesado puede agotarlo; medir antes de agregar condiciones.
- `lib/create-orden-contrato.test.ts` compara los payloads de los dos creadores reales con las allowlists. Si cambias un payload de creación, actualiza las Rules y ese test.

## 10. Producción, staging y emulador

- **Producción (`storkhub-9f719`): 0 acceso, 0 lectura, 0 writes, 0 deploy**, aunque haya credenciales disponibles.
- **Staging (`shenvios-staging`): lectura y escritura prohibidas** salvo autorización explícita en el prompt de la tarea. Por defecto, usar emulador y tests.
- Estado de staging al generar este documento: ruleset `61caeecb-4067-4289-9f11-0be44b18b458`; Functions 36 ACTIVE, GEN_2, nodejs24, `maxInstances` 20.

## 11. Qué puede y qué no puede hacer Cloud

**Permitido:** diagnóstico de código, implementación aislada, tests, tests de emulador, Rules, Storage Rules, scripts dry-run, refactors, UI, preintegración independiente. Commit y push en su feature branch.

**Prohibido por defecto** (se hace localmente con autorización específica):
deploy Firebase, deploy Vercel, FF a WIP, FF a staging, lecturas o escrituras en producción, escrituras de negocio en staging, backfill real, borrar datos, usar credenciales, cambiar secretos, force push.

**STOP inmediato si:**

- aparece un P1 fuera de scope;
- hay riesgo de pérdida de datos o un riesgo financiero nuevo;
- se necesita cambiar una regla económica;
- se necesita producción;
- se necesita una callable nueva sin estar autorizada;
- hay una migración o backfill irreversible;
- el baseline empeora, los tests fallan o el build falla;
- hay un cambio funcional ajeno al scope;
- se requiere un secreto o credencial;
- hay conflicto con un bloque CLOSED.

## 12. Reporte obligatorio al terminar una sesión Cloud

1. refs iniciales; 2. rama; 3. alcance; 4. archivos cambiados; 5. arquitectura/contrato; 6. tests; 7. runtime/emulador; 8. mutaciones si aplica; 9. TypeScript; 10. builds; 11. manifest si toca Functions; 12. Rules budget si toca Rules; 13. staging; 14. producción; 15. P1/P2/P3; 16. commit; 17. SHA; 18. push; 19. clasificación; 20. siguiente paso.

## 13. Clasificaciones

- `A. PASS — LISTO PARA PREINTEGRACIÓN`, o
- `STOP — <razón concreta>`.

Cloud **no** declara `CLOSED IN STAGING`: solo un rollout local puede cerrar en staging.

## 14. Flujo recomendado y paralelismo

```
Cloud implementación → feature SHA → Cloud preintegración independiente → PASS
→ local FF a WIP → local staging/deploy/E2E → CLOSED IN STAGING
```

- Paralelizar ramas con poca intersección (ej.: A3 backfill + Registro de Viajes lectura + responsive del Gestor).
- No paralelizar dos ramas que cambien a la vez `firestore.rules`, la autoridad de `solicitudes_envio`, `asignarMotorizado`, `crearLiquidacionMotorizado` o `calcularDeposito`, sin un plan explícito de reconciliación.

## 15. Carril A — deuda abierta antes de producción

- **CREDIT-ELIGIBILITY-1 (P2):** `tipoCliente=credito` aún puede elegirse sin demostrar elegibilidad del comercio. Revisar consumers y contrato real; el cobro a crédito se difiere a semanal.
- **FIN-GASTOS-CONSUMO-BACKFILL-1 (blocker pre-producción):** gastos históricos sin `consumidoEnDepositoId`. No volver a descontarlos; jamás adivinar el consumo.
- **STORAGE-EVIDENCIA-OPERATIVA-SELLADO-1:** pendiente. Revisar upload/read/replace/delete; sellar después del hito.
- **Legacy A2:** órdenes sin base demostrable; requieren regularización antes de liquidar.
- **Legacy CREATE-AUTHORITY** (buscar antes de producción, sin backfill ciego): `cobrosMotorizado` históricos incoherentes; `registro.deposito` imposible; punteros falsos; `cobroDelivery.formaPago` incoherente; `creadoInternamente` con actor incoherente; evidencias imposibles.
- Pendientes: preflight read-only de producción; PREPROD readiness/freeze; release a producción; smoke posproducción.

## 16. P2 / P3 conocidos

No convertirlos automáticamente en scope de otras tareas.

- **P2:** la distancia sigue siendo controlada por el cliente; CREDIT-ELIGIBILITY-1; legacy financiero; el margen de presupuesto de Rules en el create es menor que antes.
- **P3:** los `coord` internos no tienen allowlist anidada; el parser léxico del test de contrato no detecta spreads de variables; DAPC y helpers históricos; preview UI residual.

## 17. Carril B — extras, no blockers

Registro de Viajes (lectura), Comercio Pagos UX (si la integridad ya está cerrada), Eventos completos, Supervisión Operativa, Gestor responsive, auditoría/UI, performance/queries, Rules budget, deuda técnica. Pueden trabajarse en Cloud en ramas separadas, pero **no entran al Release Candidate** sin integración + staging + smoke.

## 18. Notas de entorno

- Windows con Git Bash: los argumentos con saltos de línea se truncan; el índice usa LF aunque el árbol de trabajo a veces esté en CRLF.
- Raíz en Node 20; `functions/` en Node 24.
- Tests: Rules con `npm run test:rules` (emulador Firestore); Root con `npm test`; Functions con `npm test` dentro de `functions/`.

---

Generated from WIP: `49008cc0b350debecda1606530bb250f71124c37`
Staging: `49008cc0b350debecda1606530bb250f71124c37`
Master: `44dd2a8f768af8f6654eecd5d22b02ce9683ce23`
Date: 2026-10-09
