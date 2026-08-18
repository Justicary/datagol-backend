# TASK — Asistencia, valor de cierre y atribución (BACKEND)

**Proyecto:** `datagol-backend`
**Precondición:** la migración `39_resultado_negocio.sql` ya está aplicada.
**Referencia obligatoria:** `AGENTS.md` de este repositorio

---

## Por qué esto va antes del módulo de lenguaje natural

Hoy el sistema no puede responder **"¿cuánto vendí?"** ni **"¿los que agendaron sí fueron?"**. Son las dos preguntas que deciden si un cliente renueva. Construir un módulo de reportes brillante que no las contesta es construir sobre un hueco.

Tres campos los cierran: `appointments.status` con valores definidos, `contacts.deal_value` capturado a mano, y `leads.source` de atribución.

---

## FASE A — Módulos de constraint

Patrón de `secret-keys.ts`, con prueba de inserción contra la base real:

- **`appointments.status`**: `programada`, `confirmada`, `completada`, `no_asistio`, `cancelada`, `reprogramada`
- **`leads.source`**: `anuncio_pagado`, `busqueda_google`, `redes_sociales`, `referido`, `sitio_web`, `letrero_fisico`, `directorio`, `otro`, `desconocido`
- **`contacts.deal_currency`**: `MXN`, `USD`

Cero literales fuera de estos módulos. Es la octava vez que un valor divergente causaría un bug en este proyecto.

---

## FASE B — Ciclo de vida de la cita

### B.1 Endpoint de desenlace

```
PATCH /organizations/:id/appointments/:appointmentId/status
```

Reglas:
- Registrar `status_updated_at` y `status_updated_by` siempre
- `no_asistio` acepta `no_show_reason` opcional
- **No permitir marcar `completada` ni `no_asistio` en una cita futura.** Es un error de captura, no un caso de uso
- Transiciones válidas: de `programada` o `confirmada` a cualquiera; de un estado final, solo a `reprogramada`

### B.2 Sincronización con Cal.com

Si la cita tiene `cal_booking_id`, verificar si Cal.com refleja cancelaciones que el sistema no conoce. Un job que concilie periódicamente evita que el admin vea confirmadas citas que el cliente ya canceló por su lado.

Reportar si el API de Cal.com expone el dato de asistencia. Si no, la marca es 100% manual y hay que asumirlo.

### B.3 Recordatorio de desenlace

Job diario que detecte citas pasadas sin marcar (`v_citas_sin_desenlace`) y notifique al admin.

**Este job decide si la feature funciona.** Si nadie marca el desenlace, `completada` queda vacío y todas las métricas de cumplimiento y valor quedan inservibles. La notificación debe ser accionable: cuántas hay y un enlace directo a marcarlas.

Umbral: no notificar por una sola cita del día anterior; sí cuando se acumulen tres o más, o pasen más de tres días.

---

## FASE C — Valor de cierre

### C.1 Endpoint

Extender el cambio de etapa de pipeline (`PATCH .../contacts/:contactId/pipeline`) para que al mover a `ganado` acepte `deal_value`, `deal_currency` y `deal_notes`.

**El monto es opcional.** Un cierre sin monto sigue siendo un cierre; forzarlo haría que el admin invente cifras o evite marcar ganados. Pero la interfaz debe pedirlo (eso es trabajo del frontend).

La restricción de base ya impide capturar monto en un contacto que no es cliente.

### C.2 Métricas

Exponer `v_resultado_negocio` en el endpoint de métricas existente: clientes cerrados, cierres con monto, valor total, ticket promedio.

**Regla de honestidad:** toda cifra de valor debe reportar cuántos cierres tienen monto y cuántos no. Un ticket promedio calculado sobre 3 de 20 cierres no es un ticket promedio, y presentarlo sin ese contexto es engañar.

### C.3 Limitación conocida

Un contacto tiene un solo valor de cierre. Para negocios con compras recurrentes esto subestima el valor real. Documentarlo en `AGENTS.md`; la evolución sería una tabla `deals`, que no se construye ahora sobre una suposición.

---

## FASE D — Atribución de origen

### D.1 Captura por voz y mensajería

El origen **no se puede inferir**: hay que preguntarlo.

Reporta qué se necesita para agregar un campo 13 al Data Collection de ElevenLabs (`como_se_entero`) y mapearlo a `leads.source`. El mapeo de texto libre a los valores del constraint se hace en el backend, con `desconocido` como salida cuando no encaje — **nunca forzar a la categoría más cercana**.

`source_detail` guarda el texto original tal cual.

### D.2 Captura por formulario web

El endpoint del formulario debe aceptar parámetros UTM y derivar el origen:

- `utm_medium=cpc` o `gclid` presente → `anuncio_pagado`
- `utm_source=google` orgánico → `busqueda_google`
- `utm_source` de red social → `redes_sociales`
- Sin UTM y con referrer del propio sitio → `sitio_web`
- Sin nada → `desconocido`

`source_detail` guarda la cadena UTM completa.

### D.3 Métricas

Exponer `v_atribucion_origen`. Los registros sin dato se muestran como `sin_dato`, nunca se ocultan ni se reparten proporcionalmente entre los conocidos.

---

## FASE E — Actualizar el prompt del agente

Reporta el texto sugerido para que Yeli pregunte el origen de forma natural, sin volverlo un interrogatorio. Debe caber en el flujo existente y no añadir un turno extra si el prospecto ya lo mencionó espontáneamente.

Restricción: una sola pregunta por turno, según las reglas del prompt actual.

---

## Pruebas

- Marcar `completada` en cita futura se rechaza
- Transición desde estado final solo permite `reprogramada`
- Capturar `deal_value` en contacto que no es cliente se rechaza
- Marcar `ganado` sin monto funciona (el monto es opcional)
- Ticket promedio reporta cuántos cierres carecen de monto
- Texto de origen que no encaja produce `desconocido`, no la categoría más cercana
- UTM de campaña pagada deriva `anuncio_pagado`; sin UTM deriva `desconocido`
- El job de recordatorio no notifica por una sola cita reciente, sí por tres
- Cada rechazo con su contraparte de éxito