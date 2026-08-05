# CHECKLIST — STAGING, BACKUPS Y OBSERVABILIDAD

Diseño para el futuro. **Nada de esto está implementado.** Ningún elemento de
este documento se ha ejecutado ni configurado.

Cada punto va clasificado:

- **[PILOTO]** imprescindible antes del piloto controlado
- **[PROD]** imprescindible antes de producción
- **[LUEGO]** mejora posterior

---

## 1. Staging

Hoy solo existen dos entornos: el proyecto real `storkhub-9f719` y el proyecto
de Emulator `demo-storkhub`. **No hay un entorno intermedio desplegado**, así
que cualquier prueba realista contra infraestructura de verdad se haría hoy
contra producción. Eso es lo que este apartado viene a evitar.

| # | Elemento | Detalle | Clasif. |
|---|---|---|---|
| 1.1 | **Proyecto Firebase separado** | `storkhub-staging` propio, nunca un «modo» del real | **[PILOTO]** |
| 1.2 | **Bucket separado** | Bucket propio del proyecto de staging. Ningún objeto compartido con producción | **[PILOTO]** |
| 1.3 | **Variables separadas** | `.env.staging` fuera de Git. Revisar que `fb/config.ts` resuelva el proyecto por variable y no por constante | **[PILOTO]** |
| 1.4 | **Dominio** | Subdominio propio (`staging.…`) con `noindex`, distinguible a simple vista para no confundir sesiones | **[PILOTO]** |
| 1.5 | **Usuarios ficticios** | Replicar la matriz de 12 cuentas del fixture `matriz-storage-actual`: admin, gestor, comercios A y B, cliente, dos motorizados, inactivo, sin rol, rol raro, Auth sin perfil. **Ningún dato personal real** | **[PILOTO]** |
| 1.6 | **Reglas** | Despliegue de `firestore.rules` y `storage.rules` a staging **antes** que a producción, siempre | **[PILOTO]** |
| 1.7 | **Functions** | `crearAccesoComercio`, `acumularCobroSemanalPorOrden` y `limpiarEvidencias` desplegadas en staging. Ojo con `limpiarEvidencias`: es un cron que **borra**; verificar su ventana de 45 días con datos de prueba | **[PILOTO]** |
| 1.8 | **Vercel** | Proyecto o entorno de preview separado, con sus propias variables. Que un preview no pueda apuntar a producción por descuido | **[PILOTO]** |
| 1.9 | **Google Maps** | Clave distinta, con restricción por referrer al dominio de staging y cuota propia. El proxy `app/api/proxy/route.ts` ya restringe el upstream a `maps.googleapis.com` | **[PROD]** |
| 1.10 | **Correo** | Remitente y plantillas de staging para `send-welcome` y `send-reset-password`. **Bloquear el envío a direcciones externas**: solo dominios de prueba | **[PILOTO]** |
| 1.11 | **Smoke tests** | Guion corto y repetible tras cada despliegue: login por rol, crear orden de comercio, crear orden de gestor, asignar, subir evidencia, subir boucher, confirmar pago | **[PILOTO]** |
| 1.12 | Datos sintéticos de volumen | Generador de órdenes para ver comportamiento con miles de documentos | **[LUEGO]** |
| 1.13 | Paridad de índices | Que `firestore.indexes.json` se aplique igual en ambos proyectos | **[PROD]** |

---

## 2. Backups

**Hoy no existe ninguna copia de seguridad automática de Firestore.** Los
`.emulator-data/` son exports de desarrollo, viven solo en DAPC y no viajan por
Git: no son backups.

| # | Elemento | Detalle | Clasif. |
|---|---|---|---|
| 2.1 | **Export programado de Firestore** | Export diario a un bucket de GCS dedicado, distinto del bucket de la app | **[PROD]** |
| 2.2 | **Retención** | Diarios 30 días, semanales 12 semanas, mensuales 12 meses. Fijarlo con reglas de ciclo de vida del bucket, no a mano | **[PROD]** |
| 2.3 | **Responsable** | Una persona nombrada que revisa que el export corrió. Un backup sin dueño no existe | **[PROD]** |
| 2.4 | **Cifrado** | En reposo y en tránsito. Acceso al bucket de backups restringido a una service account propia, nunca a las cuentas de la app | **[PROD]** |
| 2.5 | **Procedimiento de restauración** | Escrito, paso a paso, probado. Debe cubrir restauración total y de una sola colección | **[PROD]** |
| 2.6 | **Prueba de restauración** | Restaurar sobre **staging** al menos una vez antes de producción, y después trimestralmente. **Un backup no probado no cuenta** | **[PROD]** |
| 2.7 | **RPO** | Objetivo propuesto: **24 h** con export diario. Si se considera inaceptable para datos financieros (depósitos, liquidaciones, ledger), subir a export cada 6 h | **[PROD]** |
| 2.8 | **RTO** | Objetivo propuesto: **4 h** hasta servicio restaurado. Medirlo en la prueba de 2.6, no estimarlo | **[PROD]** |
| 2.9 | **Backup antes de migraciones** | Export manual **inmediatamente antes** de cualquier backfill —el de `comercioId` es el primero previsto— y no continuar sin confirmar que terminó | **[PROD]** |
| 2.10 | **Backup de Storage** | Los objetos de `evidencias/`, `depositos/`, `saldos/` y `liquidaciones/` son prueba documental. Definir si se replican y con qué retención | **[PROD]** |
| 2.11 | Backup de configuración | Reglas, índices y variables versionados o exportados; hoy reglas e índices ya están en Git | **[LUEGO]** |

---

## 3. Observabilidad

**Hoy el manejo de errores es `console.error` y, en varios sitios, `catch`
silencioso.** Nadie se entera de un fallo salvo que un usuario lo reporte.

| # | Elemento | Detalle | Clasif. |
|---|---|---|---|
| 3.1 | **Errores de frontend** | Captura centralizada (Sentry o equivalente) con versión, ruta y rol. Hoy los `catch` de los flujos de subida solo hacen `console.error` | **[PILOTO]** |
| 3.2 | **Errores de API** | Rutas `app/api/*`: tasa de error, latencia, códigos. Vigilar especialmente el proxy de Maps | **[PILOTO]** |
| 3.3 | **Functions** | Errores, duración, reintentos y ejecuciones fallidas de `crearAccesoComercio`, `acumularCobroSemanalPorOrden` y `limpiarEvidencias` | **[PILOTO]** |
| 3.4 | **Storage** | Volumen de objetos, bytes por prefijo, subidas fallidas. Detectar crecimiento anómalo de `evidencias/` | **[PROD]** |
| 3.5 | **Reglas** | Tasa de `permission-denied` por colección y por rol. **Un pico es señal de regresión o de ataque**; hoy no hay forma de verlo. Fue exactamente el síntoma del S-10 | **[PILOTO]** |
| 3.6 | **Depósitos atrasados** | Alerta por `ordenes_deposito` en `pendiente_boucher` o `en_revision` más allá de un umbral | **[PROD]** |
| 3.7 | **Movimientos duplicados** | Detección de dobles escrituras en `movimientos_financieros`. Riesgo real: la confirmación de pago escribe un batch **y después** registra el movimiento fuera del batch — un fallo intermedio deja el depósito sin movimiento, o un doble clic podría duplicarlo | **[PROD]** |
| 3.8 | **Objetos huérfanos** | Job de conciliación Storage ↔ Firestore. Hoy se sabe que se generan (fallo de Firestore tras Storage, «Quitar» del gestor, `limpiarEvidencias` tragando errores) y **no hay forma de contarlos** | **[PROD]** |
| 3.9 | **Costos** | Presupuesto con alerta en Firebase y GCP. Vigilar lecturas de Firestore: las reglas de Storage hacen **dos `firestore.get` por escritura**, y P1-S2 añadiría una tercera | **[PROD]** |
| 3.10 | **Alertas** | Canal único (correo o Telegram) con destinatario nombrado, umbrales y política de silencio. Alertas sin dueño se ignoran | **[PILOTO]** |
| 3.11 | **Privacidad de logs** | **No registrar** direcciones, teléfonos de destinatarios, URLs con token ni contenido de documentos financieros. Los logs de errores del frontend arrastran fácilmente el payload completo: filtrar antes de enviar | **[PILOTO]** |
| 3.12 | Trazas de negocio | Embudo de la orden: creada → confirmada → asignada → entregada → cobrada | **[LUEGO]** |
| 3.13 | Uptime externo | Sonda desde fuera contra la home y el login | **[LUEGO]** |

---

## Resumen por clasificación

**[PILOTO] — 15 elementos.** Todo staging operativo (1.1–1.8, 1.10, 1.11) más
observabilidad básica (3.1, 3.2, 3.3, 3.5, 3.10, 3.11). Sin esto, un piloto con
usuarios reales no se puede diagnosticar ni acotar.

**[PROD] — 17 elementos.** Backups completos con restauración probada (2.1–2.10),
observabilidad financiera y de huérfanos (3.4, 3.6, 3.7, 3.8, 3.9), Maps e
índices (1.9, 1.13).

**[LUEGO] — 5 elementos.** 1.12, 2.11, 3.12, 3.13 y las mejoras que surjan del
piloto.

**El orden no es negociable en un punto:** el backup con restauración probada
(2.5 y 2.6) debe estar **antes** del primer backfill de datos, no después.
