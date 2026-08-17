# TASK — Agradecimiento automático omnicanal

**Proyecto:** `datagol-backend`
**Referencia obligatoria:** `AGENTS.md` de este repositorio

## Objetivo

Cuando se capta un prospecto —por el formulario de la landing, por voz, o por mensajería— enviarle un agradecimiento por el canal adecuado, con la posibilidad de adjuntar un documento configurado por el admin de la organización.

**El riesgo principal de esta tarea es el spam.** Una persona que llama, escribe por WhatsApp y llena el formulario en la misma tarde debe recibir **un** agradecimiento, no tres.

---

## Reglas de decisión

### Cuándo NO se envía nada

- El contacto no dejó ni correo ni teléfono
- `contacts.opted_out = true`
- Ya se le envió un agradecimiento dentro de la ventana de deduplicación
- El entitlement de la feature está desactivado
- La organización no ha configurado el agradecimiento

### Elección de canal

| Situación | Canal |
|-----------|-------|
| Hay adjunto configurado **y** hay correo | **Correo.** Es la única vía que lleva archivo. |
| No hay adjunto, el prospecto llegó por WhatsApp | **WhatsApp.** No lo saques del canal donde ya está. |
| No hay adjunto, llegó por voz o web, y hay correo | **Correo** |
| Solo hay teléfono, sin correo | **WhatsApp** si el canal está habilitado; si no, no se envía |
| Hay ambos y ninguna condición anterior aplica | **Correo** |

Un solo canal por evento. Nunca los dos.

### Deduplicación

**No es "una vez por contacto".** Un prospecto que escribe hoy y llama en tres meses merece un agradecimiento nuevo.

La regla es una **ventana configurable por organización**, con default de 30 días. Se deduplica por contacto, no por conversación: tres conversaciones de la misma persona en un día producen un envío.

La verificación debe ser atómica —insertar el registro y enviar en la misma transacción lógica— o dos conversaciones simultáneas de la misma persona producen dos envíos.

## FASE A — Esquema

### Tabla de envíos (habilita la deduplicación)

```
thank_you_sends
  id, organization_id, contact_id, lead_id
  channel          -- email | whatsapp
  status           -- pendiente | enviado | fallido | omitido
  skip_reason      -- por qué no se envió, cuando aplica
  attachment_id    -- referencia al adjunto usado, si hubo
  sent_at, created_at
  unique (organization_id, contact_id, <ventana>)
```

Resuelve la ventana como te resulte más limpio en Postgres, pero el índice debe impedir el doble envío a nivel de base, no solo en la aplicación.

**Registrar también los omitidos**, con su razón. Sin eso no se puede diagnosticar por qué un prospecto no recibió nada.

### Tabla de adjuntos

```
organization_attachments
  id, organization_id
  file_name, mime_type, size_bytes
  storage_path      -- Supabase Storage
  is_active         -- solo uno activo por organización
  uploaded_by, created_at
```

Restricciones:
- Solo `application/pdf`, `.docx` y `.xlsx`. Valida el contenido real, no la extensión ni el `Content-Type` que manda el cliente.
- Tamaño máximo **10 MB**. Por encima de eso los servidores de correo rechazan.
- Bucket privado. La descarga va por URL firmada de vida corta, nunca pública.
- RLS por tenant.

### Configuración

En `integration_settings`, llave hermana de `email`:

```json
"thankYou": {
  "enabled": false,
  "dedupeWindowDays": 30,
  "emailSubject": null,
  "emailBody": null,
  "whatsappTemplateName": null,
  "attachmentId": null
}
```

Default `enabled: false`. **Que un cliente empiece a mandar correos automáticos sin haberlo configurado es peor que no tener la función.**

## FASE B — Disparador

El agradecimiento se encola cuando se crea un lead con algún medio de contacto. Punto único de entrada: el job que procesa el post-llamada y el endpoint del formulario de la landing deben converger en la misma función, no duplicar la lógica.

**Nunca síncrono.** Se encola en pg-boss y se responde de inmediato. Un envío de correo dentro del camino de una conversación es latencia regalada.

Job `send-thank-you`:

1. Resolver contacto, canal y elegibilidad
2. Si no procede, registrar el omitido con su razón y terminar
3. Insertar el registro de envío (aquí actúa la deduplicación)
4. Enviar
5. Actualizar estado; si falla, reintentar con retroceso exponencial y marcar `fallido` al agotar

Idempotente: reejecutar el job no produce un segundo envío.

## FASE C — Envío por correo

Usa el sistema de plantillas ya implementado. El agradecimiento es un **tipo de correo nuevo** que debe funcionar en las cinco plantillas.

- Asunto y cuerpo personalizables, con valores por defecto sensatos en español
- Adjunto descargado del bucket privado al momento del envío
- Verificar el peso total: HTML < 90 KB **más** el adjunto. Si el adjunto acerca el correo a los límites del proveedor, envía un enlace de descarga firmado en lugar del archivo
- Versión en texto plano, como todos los demás

## FASE D — Envío por WhatsApp

**Restricción del medio:** fuera de la ventana de servicio de 24 horas hace falta una plantilla aprobada por Meta.

- Si el prospecto escribió en las últimas 24 horas: mensaje libre, sin costo
- Fuera de la ventana: plantilla aprobada. Si la organización no tiene una configurada, **registrar omitido con razón explícita**, nunca fallar en silencio
- Advertir en la configuración que una plantilla categorizada como marketing cuesta ~5.5× más que una utility en México
- WhatsApp **no lleva adjuntos** en este flujo. Si hay adjunto configurado y el canal resuelto es WhatsApp, incluir un enlace de descarga firmado

Registrar el consumo en `usage_events` con su categoría de plantilla correcta. Es la diferencia entre $0.008 y $0.0436 por mensaje.

## FASE E — Endpoints

```
GET    /organizations/:id/thank-you            -- configuración
PATCH  /organizations/:id/thank-you
POST   /organizations/:id/attachments          -- subida
GET    /organizations/:id/attachments
DELETE /organizations/:id/attachments/:attId   -- archivar, no borrar
POST   /organizations/:id/thank-you/test       -- envío de prueba al admin
GET    /organizations/:id/thank-you/log        -- historial, incluidos omitidos
```

La subida valida tipo real, tamaño y pertenencia. Solo rol admin u owner.

## Pruebas

- **La central:** un contacto con tres leads en canales distintos el mismo día recibe **un** envío.
- Un contacto con lead hace 40 días recibe uno nuevo (fuera de la ventana).
- Contacto sin correo ni teléfono: omitido, con razón registrada.
- `opted_out`: omitido, con razón registrada.
- Con adjunto y correo disponible: gana correo aunque el lead venga de WhatsApp.
- Sin adjunto y lead de WhatsApp: gana WhatsApp.
- Fuera de la ventana de 24h sin plantilla configurada: omitido, no fallo.
- Adjunto de 11 MB rechazado. Adjunto con extensión falsificada rechazado.
- Dos jobs simultáneos del mismo contacto producen un solo envío.
- Cada rechazo con su contraparte de éxito.