# LÉEME PRIMERO

**Fecha de corte:** 5 de agosto de 2026
**Preparado en:** PC laboral `COR-D_ALONZO`, usuario `d_alonzo`
**Repositorio:** `C:\Users\d_alonzo\dev\shenvio-bloque1`

Este paquete existe para que la próxima sesión en DAPC empiece sabiendo
exactamente qué hay hecho, qué falta y en qué orden hacerlo. No contiene
ningún cambio de código.

---

## Qué está TERMINADO y validado

- **Bloque 0C** — seguridad de usuarios y roles. Integrado en la WIP y validado
  con Emulator (45/45 + 4/4 + 14/14).
- **Bloque 1** — identidad canónica de órdenes (`comercioId`). Integrado en la
  WIP y validado con Emulator (36/36 + 24/24 + 21/21 + 6/6).
- **Compatibilidad conjunta 0C + 1** — validada, 12 casos cruzados.

Todo eso vive hoy en la WIP `wip/bloque-d-identidad-emulator`, en el commit
`d1771f1`. Es la única base aprobada.

## Qué está CONSTRUIDO pero NO validado

Dos ramas, ambas escritas y revisadas estáticamente, ninguna probada con
Emulator. **Ninguna de las dos está aprobada.**

- **Bloque 2A** (`fix/p1-boucher-comercio-provisional`, HEAD `4f54549`) — abre
  al comercio la subida y el reemplazo de su boucher en Firestore, con
  allowlist cerrada. Cierra el problema S-10.
- **P1-S1** (`fix/p1-storage-s1-delete-mime-size`, HEAD `308aa50`) — deniega el
  borrado desde clientes en Storage y valida tipo y tamaño de archivo.

«Revisado estáticamente» significa: se leyó el diff, se comprobó el balance de
llaves, que no hubiera accesos inseguros y que solo cambiaran los archivos
autorizados. **No significa que las reglas compilen, ni que TypeScript pase, ni
que la UI funcione.** Nada de eso se pudo ejecutar en la PC laboral.

## Qué está PENDIENTE

- Validar ambas ramas con Emulator en DAPC.
- Integrarlas y validar el resultado combinado.
- **P1-S2** — pertenencia real en Storage (que un comercio no pueda escribir
  sobre la carpeta de una orden ajena). Requiere investigación previa sobre
  órdenes históricas.
- **P1-S3** — acotar lectura y listado en Storage.
- La solución definitiva server-side del boucher (rollback, UUID, revocación).

## Por qué producción sigue BLOQUEADA

Aunque se validaran hoy mismo las dos ramas, seguirían abiertos:

1. **Un comercio puede escribir sobre la carpeta de Storage de una orden
   ajena.** Ninguna regla de Storage comprueba pertenencia. Lo cierra P1-S2.
2. **Un motorizado no asignado puede escribir** sobre cualquier orden. P1-S2.
3. **Cualquier usuario autenticado lee cualquier objeto**, incluidos PDFs de
   liquidaciones. P1-S3.
4. **Las URLs con token no caducan** y no se invalidan al cerrar sesión, al
   desactivar al usuario ni al borrar el campo en Firestore. Solo lo resuelve
   el servidor.
5. **No hay rollback**: si Storage termina y Firestore falla, queda un objeto
   huérfano.
6. **La limpieza automática cubre 3 de ~12 rutas** y además borra el puntero de
   Firestore aunque el borrado en Storage haya fallado.

Nada de esto lo arreglan 2A ni S1, y no debe presentarse como arreglado.

## Qué hacer PRIMERO en DAPC

Levantar el Emulator con el fixture canónico y **validar el Bloque 2A aislado**.
Es lo primero porque es lo que desbloquea al comercio y porque su matriz es la
más delicada. El prompt está listo en `08-PROMPT-DAPC-SIGUIENTE-SESION.md`.

## Orden acordado

1. Validar Bloque 2A.
2. Auditar el resultado.
3. Validar P1-S1.
4. Auditar el resultado.
5. Preparar la integración conjunta.
6. Validar el candidato combinado.
7. Integrar en la WIP.
8. Investigar los históricos para P1-S2.

No saltarse pasos. En particular, **no integrar antes de validar por separado**:
dos ramas correctas por su cuenta no son automáticamente correctas juntas.

## Qué NO debe ejecutarse desde la PC laboral

- Firebase Emulator (no disponible por permisos; no intentar instalarlo).
- Firebase real, en cualquier forma.
- `npm install`, `npm ci`, `npx`, `tsc`, lint, Next.js.
  Este clon **no tiene `node_modules` ni `.env.local`**.
- Deploy.
- Integración de ramas o cambios en `master`.
- Cualquier operación sobre la copia histórica en OneDrive
  (`OneDrive - INACAP\Escritorio\shenvio-landing-v3`), que es solo respaldo.

La PC laboral sirve para investigar, diseñar, construir estáticamente y
documentar. La validación es de DAPC.
