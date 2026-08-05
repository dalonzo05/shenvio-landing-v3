# PROMPT PARA LA SIGUIENTE SESIÓN EN DAPC

Copiar el bloque completo de abajo como primer mensaje de la sesión en DAPC.
**No se ha ejecutado. No ejecutarlo desde la PC laboral.**

---

```text
# SHENVÍOS — DAPC
# VALIDACIÓN DEL BLOQUE 2A CON EMULATOR
# SIN MODIFICAR CÓDIGO Y SIN INTEGRAR

Lee íntegramente la carpeta docs/preparacion-dapc-y-produccion-2026-08-05/
y úsala como contexto autoritativo. En particular:

- 01-ESTADO-AUTORITATIVO.md
- 02-MATRIZ-VALIDACION-BLOQUE-2A.md

Equipo esperado:

Hostname:
DAPC

Usuario:
alonz

Repositorio:
C:\Users\alonz\OneDrive\Escritorio\shenvio-landing-v3-nuevo

En este encargo:

- no modifiques código;
- no crees ramas;
- no hagas commit;
- no hagas push;
- no integres nada;
- no toques master;
- no uses Firebase real;
- no hagas deploy;
- no modifiques storage.rules ni firestore.rules.

## 1. Reconocimiento

Confirma:

- hostname;
- usuario;
- sistema operativo;
- terminal;
- ruta exacta del repositorio;
- Git, Node, npm, Java y Firebase CLI con sus versiones;
- rama actual;
- HEAD;
- working tree;
- archivos sin seguimiento;
- stashes;
- worktrees;
- operaciones Git en curso;
- procesos Node, Next.js, Firebase y Java activos;
- los ocho puertos: 3000, 4000, 5001, 8080, 9099, 9199, 4400, 9150.

Confirma la existencia, sin abrir ni imprimir contenido, de:

- .env.local
- node_modules
- functions/lib

No muestres secretos, claves, tokens ni valores de variables de entorno.

## 2. Preflight de referencias

Ejecuta:

git fetch --all --prune

Confirma exactamente los CUATRO hashes autoritativos:

origin/master
=
44dd2a8f768af8f6654eecd5d22b02ce9683ce23

origin/wip/bloque-d-identidad-emulator
=
d1771f12780276fe01412be6c0c35c03cfee06db

origin/fix/p1-boucher-comercio-provisional
=
4f54549f54e600edb30f3407f8ec0007d20606b5

origin/fix/p1-storage-s1-delete-mime-size
=
308aa5089b27ca1e883c60a49aebe06cccfcd2b1

Confirma además:

- working tree limpio;
- cero archivos sin seguimiento;
- cero operaciones Git en curso;
- cero stashes;
- una sola worktree;
- master intacto.

Las ramas 2A y S1 pueden no existir localmente todavía: se crearon en la PC
laboral y se publicaron. Descárgalas correctamente desde origin en vez de
asumir que faltan. Si `git branch` no las muestra, eso es esperado: usa las
refs remotas o crea la rama local de seguimiento con:

git switch --track origin/fix/p1-boucher-comercio-provisional

No uses reset, clean, rebase, cherry-pick, amend, stash ni force.

Si cualquier hash difiere, detente y repórtalo.

## 3. Inventario de .emulator-data

Lista el contenido de .emulator-data y comprueba EXPRESAMENTE que existen:

.emulator-data/wip-post-integracion-p1
.emulator-data/matriz-storage-actual

Para cada uno reporta si existe, su tamaño aproximado y si contiene los
subdirectorios de Auth, Firestore y Storage.

matriz-storage-actual es el fixture base canónico con las 12 cuentas de la
matriz de roles. NUNCA lo modifiques: úsalo solo como --import y exporta
siempre a un directorio NUEVO.

Si alguno de los dos falta, detente y repórtalo antes de continuar: hay que
decidir cómo reconstruir el fixture.

## 4. Scripts de prueba

Los scripts de la sesión anterior vivían en el scratchpad temporal, que es
efímero y probablemente se borró. NO ASUMAS QUE FALTAN SIN COMPROBARLO, y
tampoco asumas que están.

Comprueba primero si existen. Si no, hay que reescribirlos. Los que hacen
falta para este encargo:

- fix-b1.cjs — fixtures del B1 y fijación de contraseñas del Emulator
- un script nuevo de matriz del Bloque 2A, según 02-MATRIZ-VALIDACION-BLOQUE-2A.md

Técnica ya aprendida: usan el SDK CLIENTE de Firebase desde Node contra el
Emulator, autenticando por custom token sin firma (el Auth Emulator no
verifica la firma). Dos trampas conocidas:

1. los casos de primera escritura deben apuntar a IDs NUEVOS en cada corrida,
   porque si el documento ya existe el caso deja de probar lo que dice;
2. en un archivo .cjs no uses import() dinámico: falla con
   ERR_MODULE_NOT_FOUND. Importa todo con require arriba.

Los scripts viven FUERA del repositorio.

## 5. Entorno de pruebas

Usa SIEMPRE el proyecto de demostración:

--project demo-storkhub

El prefijo demo- hace que el CLI lo trate como proyecto de demostración e
impide todo acceso a servicios reales. Verifícalo en cada arranque por el
mensaje "Detected demo project ID". Si no aparece, detente.

No uses Firebase real bajo ninguna circunstancia. No hagas deploy. No uses
deploy --dry-run: tocaría Firebase real. Para compilar reglas:

firebase emulators:exec --project demo-storkhub --only firestore 'node -e "process.exit(0)"'

Para levantar el Emulator:

firebase emulators:start --project demo-storkhub --only 'auth,firestore,storage' --import .emulator-data/matriz-storage-actual --export-on-exit .emulator-data/bloque-2a-validacion

Trampas del entorno, todas ya encontradas:

1. PowerShell y la coma: --only auth,firestore,storage SIN comillas se deforma
   y el CLI responde "Error: No emulators to start". Cita siempre la lista.
2. ui no es un target válido de --only; se gobierna por emulators.ui.enabled
   en firebase.json.
3. El export puede fallar con EPERM por OneDrive y dejar un directorio
   firebase-export-<id> en la raíz del repo, que NO está en .gitignore.
   Mitigación: forzar el export por el hub ANTES de detener nada:
   Invoke-RestMethod -Uri 'http://127.0.0.1:4400/_admin/export' -Method Post -ContentType 'application/json' -Body (@{path='<ruta absoluta destino>'; initiatedBy='x'} | ConvertTo-Json)
   Si aun así queda el temporal, inspecciónalo y MUÉVELO al destino previsto,
   nunca lo borres.
4. .next/ puede quedar con reparse points de OneDrive y Next.js aborta con
   EINVAL readlink. .next/ está en .gitignore; borrarla es seguro.
5. No borres IndexedDB en caliente: deja la persistencia de Auth bloqueada
   para todo el origen sin emitir error. Usa el botón de cerrar sesión.
6. Las pestañas arrastran mensajes permission-denied de sesiones anteriores
   con números de línea obsoletos. Verifica siempre la línea contra el archivo
   actual antes de creer un error de consola.
7. El panel del navegador no compone frames: activa los botones con
   element.click(), que dispara el manejador real de React.
8. git commit -m se rompe con comillas dobles en PowerShell: usa
   git commit -F <archivo>.

## 6. Encargo: validar el Bloque 2A

Sitúate en la rama del Bloque 2A, SIN modificarla:

fix/p1-boucher-comercio-provisional

HEAD esperado:

4f54549f54e600edb30f3407f8ec0007d20606b5

Confirma que su diff contra d1771f1 toca EXACTAMENTE dos archivos:

firestore.rules
app/panel/comercio/mis-ordenes/page.tsx

Después ejecuta la matriz completa de 02-MATRIZ-VALIDACION-BLOQUE-2A.md:

- P1 a P8 permitidos;
- D1 a D58 denegados;
- M1 a M5 malformados, denegados SIN error de evaluación;
- regresión de admin, gestor y motorizado, incluidas las matrices de 0C y B1;
- UI-1 a UI-13;
- S-1 a S-8 de Storage y URLs;
- integridad financiera por igualdad profunda, valor a valor.

Para CADA denegación, verifica el mensaje del motor y distingue "denegado por
la condición prevista" de "denegado por error de evaluación". Un
'Property ... is undefined on object' es un FALLO aunque el resultado sea
denegar.

Ejecuta también:

npx tsc --noEmit

comparando contra el baseline de 16 errores preexistentes, filtrando por
error TS\d+ para descartar el ruido de npm notice; y el lint focal contra el
baseline de 51 incidencias, NORMALIZANDO los números de línea.

NO valides P1-S1 en este encargo. NO integres nada.

## 7. Cierre

- Exporta el estado a .emulator-data/bloque-2a-validacion, forzando el export
  por el hub antes de detener nada.
- Deja los ocho puertos libres.
- Working tree limpio y cero archivos sin seguimiento.
- master intacto.
- No dejes ninguna rama nueva ni ningún commit.

## 8. Auditoría por permiso completo

Aunque tengas permisos completos, enumera toda acción que:

- cambió de rama;
- movió una referencia;
- hizo fetch o pull;
- creó o eliminó archivos;
- modificó cachés;
- inició procesos;
- actuó fuera del repositorio.

Declara expresamente:

- si modificaste algún archivo;
- si creaste rama o commit;
- si integraste algo;
- si tocaste master;
- si usaste Firebase real;
- si hiciste deploy;
- si eliminaste .next;
- si modificaste matriz-storage-actual;
- si quedó algún directorio firebase-export- suelto.

## 9. Reporte final

Entrega:

A. Equipo y repositorio
B. Preflight y los cuatro hashes
C. Inventario de .emulator-data
D. Estado de los scripts
E. Resultado de P1 a P8
F. Resultado de D1 a D58
G. Resultado de M1 a M5
H. Regresión de 0C, B1, admin, gestor y motorizado
I. Resultado de UI-1 a UI-13
J. Storage y URLs
K. Integridad financiera
L. TypeScript y lint contra baseline
M. Export creado
N. Auditoría de acciones
O. Clasificación

Clasificación, una sola:

BLOQUE 2A VALIDADO — LISTO PARA VALIDAR P1-S1

BLOQUE 2A RECHAZADO — CORRECCIONES REQUERIDAS

BLOQUEADO — ENTORNO O FIXTURE NO DISPONIBLE

No uses "APROBADO PARA PRODUCCIÓN": aunque el 2A pase entero, la deuda de
Storage sigue abierta y producción continúa bloqueada.

Detente después del reporte.
```

---

## Notas para quien lo pegue

- El prompt está **completo y sin truncar**. Si al pegarlo el final no dice
  «Detente después del reporte», falta texto: volver a copiarlo entero.
- Es para **validar solo el Bloque 2A**. La validación de P1-S1 y la integración
  son encargos posteriores, con sus propios prompts.
- Si el fixture `matriz-storage-actual` no existe en DAPC, el encargo se detiene
  en el paso 3 y hay que decidir cómo reconstruirlo antes de seguir.
