# TASK — Implementación de captura de prospectos, metering y secretos

**Proyecto:** `datagol-backend` (Fastify + Node 24 + Supabase)
**Precondición:** El esquema tiene `contacts`, `leads`, `usage_events`, `provider_rates`, `webhook_events`, `organization_members`, `organization_secrets`, `organization_features`, `features`, `feature_audit_log`, `plans` y `plan_features` .
**Referencia obligatoria:** `AGENTS.md` de este repositorio. Las secciones §3 a §16 son requisitos, no sugerencias.

## Estado actual y objetivo

Las tablas existen y están vacías. **Nada las escribe todavía.** El objetivo de esta tarea es implementar el flujo completo: desde que ElevenLabs entrega el webhook posterior a la llamada hasta que el prospecto queda persistido, medido y notificado.

Regla que gobierna todo el diseño: **este backend no toca audio**. Solo expone tool calls HTTP y consume webhooks.

## FASE 1 — Fundaciones

### 1.1 Validación de entorno

Esquema Zod que valide todas las variables al arranque. **La aplicación debe fallar de inmediato y con mensaje claro si falta una**, nunca a mitad de una llamada.

### 1.2 Dos clientes de Supabase, con propósitos distintos

| Cliente | Rol | Uso |
|---|---|---|
| `supabaseAdmin` | `service_role` | Escrituras del backend, lectura de tarifas y secretos. Hace bypass de RLS. |
| `supabaseUser` | token del usuario | Rutas de `routes/admin/**`. Respeta RLS. |

Registrar ambos como decoradores de Fastify (`fastify.decorate`), nunca como imports globales — deben ser sustituibles en pruebas.

**Crítico:** `service_role` ignora RLS por completo. Toda consulta hecha con `supabaseAdmin` **debe filtrar por `organization_id` explícitamente**. Una consulta sin ese filtro es un bug de seguridad, no una omisión.

### 1.3 Normalización E.164

`contacts.phone_e164` tiene una restricción `CHECK` de formato. Cualquier inserción sin normalizar **falla en base de datos**.

Implementar un servicio de normalización con `libphonenumber-js`, país por defecto MX, usado en todo punto de entrada. Si un número no puede normalizarse, registrar el lead sin `contact_id` en lugar de abortar el procesamiento.

### 1.4 Servicio de secretos

Hoy las credenciales siguen en claro en `organizations` (`elevenlabs_api_key`, `telnyx_api_key`, `whatsapp_access_token`, `cal_api_key`). La tabla `organization_secrets` existe pero está vacía.

Implementar:

1. `getSecret(organizationId, secretKey)` — resuelve vía `organization_secrets` → Vault, con caché en memoria y TTL corto.
2. **Script de migración de datos** (`scripts/migrate-secrets.ts`), ejecutable una sola vez: lee las credenciales en claro, las guarda en Vault, inserta la referencia, verifica la lectura, y solo entonces anula las columnas originales.
3. Redacción en el logger de pino para todos los campos sensibles.

**Este script se ejecuta desde Node, jamás desde el editor SQL de Supabase** — ahí los valores quedarían en el historial de consultas.

### 1.5 pg-boss

Inicializar sobre el mismo Postgres, en su propio esquema. Registrar el cierre grácil: al recibir `SIGTERM`, dejar de aceptar peticiones, terminar las que están en vuelo y cerrar los workers antes de salir.

### 1.6 Módulo de entitlements

Implementar:

Servicio de resolución — envuelve organization_enabled_features(org_id) con caché en memoria (TTL 60s) e invalidación explícita al escribir. Devuelve un conjunto, no una consulta por feature.
Plugin de Fastify que decore request.features tras resolver el tenant, más un helper requireFeature(key) que rechace con 403 y un mensaje que el frontend pueda mostrar tal cual.
Rutas de superadmin bajo routes/admin/features/**, protegidas por is_platform_admin():
Listar features de una organización con su origen (plan u override)
Activar y desactivar overrides — reason obligatorio, expires_at opcional
Cambiar el plan de una organización, sincronizando max_concurrent_calls
Consultar la bitácora
Guarda de credenciales — antes de habilitar una feature con requires_provider, verificar organization_secrets. Si faltan, rechazar con un mensaje que indique qué credencial falta.
Escritura de bitácora en la misma transacción que el cambio.
Provisión del agente según features — el servicio que crea o actualiza el agente en el proveedor de voz debe registrar únicamente las herramientas correspondientes a las features vigentes. Cambiar un entitlement debe disparar la reprovisión.

Pruebas obligatorias:

Un tenant de plan Starter recibe 403 al invocar una ruta de WhatsApp.
Un override con expires_at vencido no concede acceso.
El kill switch global gana sobre un override activo.
Habilitar una feature sin las credenciales de su proveedor es rechazado.
Todo cambio deja registro en la bitácora; si la bitácora falla, el cambio se revierte.
El agente provisionado para un tenant sin call_transfer no expone esa herramienta.

## FASE 2 — Webhook de post-llamada

### 2.1 Endpoint `POST /webhooks/elevenlabs/:webhookToken`

Orden de operaciones, no negociable:

1. **Resolver la organización por `webhookToken` de la ruta**, antes de leer el cuerpo. `webhookToken` (`organizations.webhook_token`) es un identificador de enrutamiento, no el secreto — no depende de ningún campo del payload que un tercero pueda falsificar.
2. **Verificar la firma antes de procesar el cuerpo.** Requiere acceso al cuerpo crudo — configurar Fastify para preservarlo. Firma inválida o ausente → 401 y registro del intento.
3. **Insertar en `webhook_events`** con `(provider, event_id)`. Si viola la restricción única, es un reintento: responder 200 y terminar. No reprocesar.
4. **Encolar el trabajo** en pg-boss.
5. **Responder 2xx de inmediato.** Ningún trabajo pesado dentro del handler.

El secreto de firma sigue siendo por organización (`webhook_signing_secret` en `organization_secrets`/Vault), y se recupera y verifica **después** de resolver la organización por el token de la ruta.

**Onboarding obligatorio.** Ninguna organización recibe webhooks de ElevenLabs "de fábrica": hay que dar de alta explícitamente `organizations.webhook_token` y `organization_secrets.webhook_signing_secret` (`scripts/provision-org-secrets.ts`), y configurar la URL resultante (`.../webhooks/elevenlabs/<webhookToken>`) como webhook de post-llamada en el dashboard de ElevenLabs de esa organización. Sin ambos pasos, todo webhook a esa organización se rechaza con 401. Ver `db/migrations/04_organizations_webhook_token.sql`.

### 2.2 Job `process-call-completed`

Todo en una sola transacción:

1. **Upsert del contacto** en `contacts` por `(organization_id, phone_e164)`. Actualizar `last_seen_at` y rellenar solo los campos que estén vacíos — nunca sobrescribir un dato bueno con uno nuevo vacío.
2. **Insertar el lead** en `leads` con los campos extraídos. `conversation_id` da idempotencia a nivel de negocio.
3. **Actualizar `call_logs`** con `contact_id`, transcripción, duración y resumen.
4. **Registrar el consumo** (ver Fase 3).
5. **Encolar las notificaciones** (ver Fase 4).

**Mapeo de campos:** los nombres exactos del payload de ElevenLabs deben verificarse contra su documentación vigente. No asumir el esquema.

**Regla de honestidad de datos:** si un campo extraído viene vacío, se guarda vacío. Está prohibido inferir, completar o inventar valores. Un correo inventado es peor que un correo ausente, porque el negocio le escribe a nadie y cree que el sistema funciona.

## FASE 3 — Metering

### 3.1 Resolución de tarifa

`getRate(provider, unitType, occurredAt)` consulta `provider_rates` buscando el registro cuyo `effective_from` sea el más reciente anterior a `occurredAt`, y cuyo `effective_to` sea nulo o posterior.

**Nunca usar la tarifa actual para un consumo pasado.** Los proveedores cambian precios cada trimestre; recalcular con la tarifa vigente produce cifras falsas.

Cachear el tarifario en memoria con invalidación por TTL. Es una tabla pequeña y de lectura muy frecuente.

### 3.2 Registro de consumo

Por cada llamada procesada, insertar en `usage_events` los asientos que correspondan: minutos de agente, tokens de LLM, minutos de telefonía según dirección y tipo de destino (fijo o móvil), grabación.

`usage_events` tiene un trigger que **bloquea `UPDATE` y `DELETE`**. Las correcciones se hacen con asientos compensatorios de cantidad negativa. Si el código intenta actualizar, la base lo rechaza — está diseñado así.

### 3.3 Conciliación

Endpoint administrativo que compare el metering interno contra un periodo dado, para validar contra la factura real del proveedor. Sin esto no puedes defender un cargo ante un cliente que reclama.

## FASE 4 — Notificaciones

### 4.1 Job `notify-hot-lead`

Se dispara cuando `temperature = 'caliente'` y `booked_appointment = false`.

**Este job es el producto.** Un prospecto caliente que colgó sin agendar es exactamente donde el negocio debe intervenir en minutos, no al día siguiente. Objetivo: notificación entregada en menos de un minuto tras terminar la llamada.

### 4.2 Job `send-call-summary`

Correo de minuta al negocio. Cumple el entregable "minutas por correo" de los planes comerciales.

### 4.3 Job `send-prospect-summary`

Solo si el prospecto dejó correo y hubo compromiso explícito de enviarle algo. **Verificar `contacts.opted_out` antes de enviar.**

## FASE 5 — Tool calls (presupuesto p95 < 300 ms)

Estas rutas se ejecutan **mientras el interlocutor humano espera en silencio**.

### 5.1 Reglas transversales

- Resolver el tenant por el agente o el número que recibió la llamada. **Prohibido leer `organization_id` del cuerpo de la petición** — el LLM puede alucinarlo y un tercero puede falsificarlo.
- Timeout duro de 400 ms con respuesta degradada verbalizable. Nunca un 500 mudo.
- Registrar duración por invocación. Una regresión de p95 es un bug de severidad alta.
- **Ningún tool consulta contenido estático del negocio.** Eso vive en la knowledge base de ElevenLabs. Los tools son solo para agenda.

### 5.2 Endpoints

| Ruta | Notas |
|---|---|
| `POST /tools/availability` | Máximo dos opciones en la respuesta. Cachear el calendario por tenant con TTL corto. |
| `POST /tools/booking` | Idempotente por `conversation_id`. Escribe en `appointments` con `contact_id` resuelto. |
| `POST /tools/reschedule` | **Debe verificar que la cita exista y pertenezca a quien llama**, por nombre y correo. Si no coincide, devolver un error claro que el agente pueda verbalizar — no un fallo genérico. |

**Hueco conocido:** el system prompt del agente ofrece transferir con una persona, pero no existe herramienta de transferencia. Implementarla o reportar que debe eliminarse esa promesa del prompt.

## FASE 6 — Pruebas

Umbrales de `AGENTS.md`. Las siguientes son obligatorias:

- **Aislamiento multi-tenant:** una petición del tenant A no lee ni escribe datos del tenant B. Innegociable.
- **Idempotencia de webhook:** el mismo payload entregado dos veces produce exactamente una fila en `leads` y un solo conjunto de asientos en `usage_events`.
- **Firma inválida:** se rechaza con 401 y queda registrada.
- **Tarifa histórica:** un consumo con fecha pasada usa la tarifa vigente en esa fecha, no la actual.
- **Append-only:** un intento de `UPDATE` sobre `usage_events` falla.
- **Extracción vacía:** una llamada donde el prospecto no dio datos genera un lead con campos vacíos, sin valores inventados.
- **Normalización E.164:** números en formatos diversos se normalizan; un número inválido no aborta el procesamiento del lead.
- **Degradación:** con el proveedor de calendario caído, el tool responde dentro del presupuesto con un mensaje verbalizable.

## CONSIDERACIONES TÉCNICAS ADICIONALES

1. **`provider_rates` quedó con RLS activo y sin políticas.** Documentar que solo se lee desde el backend con `service_role`. Si el dashboard necesita mostrar costos y no se resuelve, aparecerá vacío sin arrojar error.

2. **Contactos sin teléfono.** `contacts.phone_e164` es `NOT NULL`. Un lead del widget web puede no tener teléfono. El widget queda fuera de `contacts`.

3. **Retención de datos.** 90 días para purga automática de transcripciones y grabaciones vía `pg_cron`. Conservarlas indefinidamente es riesgo regulatorio sin beneficio.

4. **Onboarding del webhook es un paso manual, no automático.** `organizations.webhook_token` no tiene valor por defecto y `organization_secrets.webhook_signing_secret` no existe hasta que se ejecuta `scripts/provision-org-secrets.ts` para esa organización. Una organización recién creada, o migrada desde el flujo anterior (`/api/elevenlabs/webhook`, retirado), no recibirá leads por voz hasta completar este paso — inclúyelo en el checklist de alta de cliente, no solo en la documentación técnica.

## Qué NO hacer

- No leer credenciales en claro desde el editor SQL. El script de migración corre en Node.
- No usar `supabaseAdmin` sin filtro explícito de `organization_id`.
- No agregar consultas a la base de datos dentro del camino crítico de un tool sin medir su impacto en p95.
- No reintroducir un tool de búsqueda en la base de conocimiento. Ese fue el origen del defecto de latencia.
- No cerrar la tarea sin las pruebas de aislamiento e idempotencia. Ambos defectos son invisibles hasta que causan daño.
