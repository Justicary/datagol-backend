# Telegram como canal del arnés de IA — Plan de implementación revisado

> **Estado:** propuesta para revisión conjunta. Ninguna línea de código escrita todavía.
> **Documento origen:** `docs/tasks/telegram_system.md`
> **Fase 0 (investigación obligatoria):** ✅ completada. Sus hallazgos están en §1 y **cambian varias premisas del documento origen**.
> **Advertencia rectora (§0):** ✅ ratificada por Victor el 2026-08-30. Ver §0.1.

---

## 0. ⚠️ ADVERTENCIA RECTORA (reemplaza a la del documento origen)

**HERMES NO EXISTE EN ESTE REPOSITORIO.**

La búsqueda `grep -ril "hermes"` sobre todo el árbol (`.ts`, `.md`, `.sql`, `.json`, excluyendo `node_modules`) devuelve **un solo archivo: `docs/tasks/telegram_system.md`**. No hay arnés llamado Hermes, no hay `ChannelAdapter`, no hay registro de herramientas, no hay orquestador de agente, no hay memoria conversacional.

El documento origen anticipaba esta posibilidad y da la instrucción correcta: *"Si el repositorio no contiene una implementación claramente identificable de Hermes, indícalo explícitamente y diseña el adapter contra el arnés existente más cercano. NO inventes una implementación de Hermes."*

Por lo tanto, la advertencia en mayúsculas que rige esta tarea es esta otra:

> **EL ARNÉS EXISTENTE ES EL PIPELINE DE REPORTES EN LENGUAJE NATURAL (`src/services/reports/`). ES DE UNA SOLA VUELTA, DE SOLO LECTURA Y HOY SOLO TIENE UN CONSUMIDOR: EL DASHBOARD. TELEGRAM DEBE SER SU SEGUNDO CONSUMIDOR, NO UN ARNÉS PARALELO. SI PARA IMPLEMENTAR TELEGRAM ESTÁS ESCRIBIENDO UN SEGUNDO TRADUCTOR, UN SEGUNDO CATÁLOGO DE INTENCIONES O UN SEGUNDO CAMINO DE EJECUCIÓN, DETENTE Y REPLANTEA.**

Y una consecuencia honesta que hay que aceptar antes de empezar: **el arnés actual no cubre tres de las cosas que el documento origen da por hechas** (contexto conversacional, acciones de escritura, resolución de permisos sin JWT). No son "conectar Telegram"; son trabajo real de arnés. Están dimensionadas en §3.

### 0.1 Ratificación del responsable del proyecto

**Confirmado por Victor — 2026-08-30.** Ambos puntos quedan cerrados y no se vuelven a discutir en fases posteriores:

1. ✅ **Hermes no existe en este repositorio, y no se planea utilizarlo.** No hay que buscarlo, ni esperarlo, ni diseñar contra una futura versión suya. Toda referencia a "Hermes" en `docs/tasks/telegram_system.md` debe leerse como referencia al pipeline de reportes en lenguaje natural (`src/services/reports/`), que es el arnés real de este sistema. Cualquier fase de este plan que parezca requerir Hermes está mal planteada.

2. ✅ **TELEGRAM DEBE SER EL SEGUNDO CONSUMIDOR DEL PIPELINE DE REPORTES, NO UN ARNÉS PARALELO.** Esta es la restricción rectora de la tarea, al mismo nivel que "este backend no toca audio" de `AGENTS.md`. Un segundo traductor NL, un segundo catálogo de intenciones, un segundo camino de ejecución o un `TelegramAgent` independiente son motivo de rechazo del trabajo, no de revisión — sin importar que funcionen.

**Criterio de verificación mecánico de (2), aplicable en cada checkpoint:** debe existir **una sola** llamada a `translateQuestion()` y **una sola** a `executeIntent()` en todo `src/`, ambas dentro de `src/services/harness/`. Si `grep -rn "translateQuestion\|executeIntent" src/` devuelve una invocación fuera de esa carpeta, la restricción está rota. Ese `grep` es parte de la revisión de T2 y de todo checkpoint posterior.

> **Lo que esta ratificación NO cubre.** Las cinco decisiones abiertas de §9 siguen pendientes — en particular §6 (acciones dentro o fuera de la v1), que es la que más cambia el tamaño del trabajo. La implementación no arranca hasta resolverlas.

---

## 1. Fase 0 — Resultado de la investigación

### 1.1 Qué existe y es reutilizable tal cual

| Responsabilidad que el doc origen pide | Dónde vive hoy | ¿Reutilizable? |
|---|---|---|
| Traducción NL → intención estructurada | `src/services/reports/nl-translation-service.ts` (`translateQuestion`) | ✅ sí, con una extensión de prompt (§3.1) |
| Catálogo de intenciones | `src/services/reports/intents/` — **22** intenciones, `ALL_INTENTS` + `getIntentByKey()` | ✅ sí, íntegro |
| Ejecución determinista + timeout 5 s | `src/services/reports/nl-execution-service.ts` (`executeIntent`) | ✅ sí, íntegro |
| Verificación anti-alucinación de cifras | `src/services/reports/nl-narrative-service.ts` (`verifyNarrativeNumbers`) | ✅ sí, íntegro |
| Orquestación completa (entitlement→LLM→caché→rate limit→ejecución→narrativa) | `src/services/reports/nl-reports-service.ts` (`askReport`) | ⚠️ sí, tras extraerla de su acoplamiento al dashboard (§3.1) |
| Bitácora de preguntas no resueltas | `unanswered-questions-service.ts` → tabla `unanswered_questions` | ✅ sí, íntegro |
| Resolución de entitlements | `src/services/entitlements.ts` + `src/plugins/entitlements.ts` (`requireFeature`) | ✅ sí |
| Precedencia kill switch→override→plan→denegado | `getOrganizationFeatures()` vía RPC `organization_enabled_features` | ✅ sí, sin tocar |
| Secretos en Vault | `src/services/secret-service.ts` (`getSecret`/`setSecret`/`listSecretStatus`) | ✅ sí, con 2 claves nuevas (§4.3) |
| Idempotencia de webhooks | Tabla `webhook_events` + `UNIQUE(provider,event_id)`, patrón en `src/routes/webhooks/elevenlabs.ts` | ✅ sí |
| Token de enrutamiento en el path antes de tocar el cuerpo | `organizations.webhook_token` + `lib/tool-auth.ts` (`resolveToolOrganization`) | ✅ sí, patrón exacto |
| Comparación de secreto en tiempo constante | `lib/tool-auth.ts:64` (`timingSafeEqualStrings`) | ⚠️ sí, pero es **privada** del módulo: hay que extraerla a `src/lib/` para reusarla sin duplicar |
| Token de un solo uso hasheado | `src/lib/token-hash.ts` (`hashToken`) + patrón `organization_invitations.token_hash` y `appointment_waitlist.offer_token_hash` | ✅ sí, patrón exacto |
| Trabajos diferidos | `src/plugins/pg-boss.ts` + `src/jobs/index.ts` (20 workers) | ✅ sí |
| Re-verificación de feature dentro del job | `src/jobs/notify-hot-lead.ts` | ✅ sí, patrón exacto |
| Metering de tokens de LLM | `llm-config-service.ts` (`recordLlmUsage`) → `usage_events`, tarifas vía `getRate()`/`provider_rates` | ⚠️ sí, con atribución de canal (§3.4) |
| Rate limiting en memoria | `src/lib/rate-limiter.ts` (`checkAndRecordHit`) | ✅ sí |
| Escapado HTML seguro | `src/lib/html-escape.ts` | ✅ sí, para `parse_mode: HTML` |
| `fetch` con timeout duro y `AbortController` | `src/services/llm/http.ts` (`fetchWithTimeout`) | ✅ sí |
| Redacción de secretos en logs | `src/app.ts`, `redact.paths` del logger | ⚠️ sí, faltan 2 claves (§4.7) |

### 1.2 Respuestas a las preguntas que el doc origen exige contestar

- **¿Cómo recibe mensajes?** Hoy solo por `POST /api/organizations/:id/reports/ask` (`src/routes/organization-reports.ts:268`). No hay canal de mensajería conectado al arnés.
- **¿Cómo mantiene contexto conversacional?** **No lo mantiene.** `askReport()` es de una sola vuelta. Existe una caché de respuestas de 2 min por `organizationId:pregunta` — es caché, no memoria. **La Fase 10 del doc origen no tiene nada que reutilizar.**
- **¿Cómo identifica la organización?** Del parámetro de ruta `:id`, validado contra membresía real con el JWT del usuario. Nunca del cuerpo.
- **¿Cómo identifica al usuario?** `requireAuthenticatedUser()` → JWT de Supabase Auth. **Todo el camino de autorización de negocio depende de un JWT.**
- **¿Cómo determina qué "tools" puede usar?** No hay registro de herramientas. El LLM elige una de 22 intenciones de un catálogo estático; la única guarda es que la clave exista (`getIntentByKey`).
- **¿Cómo ejecuta?** `intentDef.execute(fastify, organizationId, validParams, period)` con `organization_id` inyectado desde el contexto y un `Promise.race` contra 5 s.
- **¿Cómo devuelve la respuesta?** JSON estructurado (`shape` + `data` + `narrative`), pensado para que el dashboard lo renderice. **No hay renderizador a texto plano.**
- **¿Cómo maneja errores?** `NaturalReportsError` con `statusCode`; estados `requiere_aclaracion` / `no_resuelta`; degradación a texto sin narrativa si la verificación anti-alucinación falla.
- **¿Cómo registra conversaciones?** No las registra. Solo persiste las preguntas **no resueltas** en `unanswered_questions`.

### 1.3 Correcciones concretas al documento origen

1. **No existe la categoría `channels`.** El CHECK `features_category_check` admite exactamente `voz | mensajeria | web | operacion | plataforma` (`src/types/feature-taxonomy.ts`, verificado por `__tests__/feature-taxonomy.test.ts`). → **`category: 'mensajeria'`**.
2. **`has_cost_impact` debe ser `false`,** determinado del modelo de costos real como pide el doc: la Bot API de Telegram es gratuita, y el LLM es **BYOK** — el cliente paga directo a su proveedor. Es el mismo razonamiento, con la misma conclusión, que `natural_language_reports` (`db/migrations/44`, línea 13: *"has_cost_impact false ya que la llave BYOK es del cliente"*). La transparencia se logra igual, registrando en `usage_events` a tarifa 0 (§3.4).
3. **El doc origen salta de la Fase 6 a la Fase 8.** No hay Fase 7. Asumo que no falta trabajo, solo un número.
4. **El catálogo tiene 22 intenciones, no 18.** `AGENTS.md §18` dice 18; el código y `docs/natural-language-reports.md` dicen 22. Aprovechar esta tarea para corregir `AGENTS.md`.
5. **`requires_provider: 'telegram'` no es gratis.** `checkProviderCredentials()` (`src/services/entitlements.ts:151`) resuelve el proveedor con un `switch` y **devuelve `{ ok: true }` para cualquier proveedor no listado**. Sin agregar la rama `telegram`, declarar `requires_provider: 'telegram'` produciría exactamente el fallo silencioso que `AGENTS.md §16` describe: feature habilitada sin credenciales, descubierta por el cliente cuando el bot no contesta.

---

## 2. Arquitectura propuesta

```
Telegram ──► POST /webhooks/telegram/:webhookToken
                │  ① path token   → resuelve telegram_connections → organización
                │  ② X-Telegram-Bot-Api-Secret-Token → autentica (timing-safe)
                │  ③ Zod sobre el update completo
                │  ④ webhook_events (provider='telegram', event_id='<tipo>:<update_id>') → idempotencia
                │  ⑤ pg-boss.send('telegram-process-update')
                └──► 200 OK  (< 100 ms, sin LLM, sin lógica de negocio)

pg-boss worker  telegram-process-update
                │  RE-verifica: feature telegram → org.status → identidad vinculada → permiso use_nl_reports
                ▼
        ┌────────────────────────────────────────────┐
        │  src/services/harness/                     │  ← capa NUEVA, delgada, canal-agnóstica
        │  askHarness({ channel, organizationId,     │
        │               memberUserId, question,      │
        │               conversationContext })       │
        └────────────────┬───────────────────────────┘
                         │  (delega, no reimplementa)
        ┌────────────────▼───────────────────────────┐
        │  services/reports/  — YA EXISTE, SIN CAMBIO│
        │  translateQuestion → 22 intents → Zod      │
        │  executeIntent(org_id del contexto)        │
        │  generateNarrative + anti-alucinación      │
        └────────────────┬───────────────────────────┘
                         ▼
                  Supabase (RLS / service_role con filtro explícito de organización)
                         │
        ┌────────────────▼───────────────────────────┐
        │  src/services/telegram/formatter.ts        │  ← adapter de SALIDA
        │  shape+data+narrative → HTML ≤4096, dividido│
        └────────────────┬───────────────────────────┘
                         ▼
                  sendMessage (Bot API)
```

**El dashboard se convierte en el segundo consumidor de `askHarness`**, no en un camino aparte. Si esta tarea deja dos caminos distintos hacia el catálogo de intenciones, está mal hecha.

---

## 3. Los tres huecos reales (esto es lo que hay que discutir)

### 3.1 Hueco A — El arnés está acoplado al dashboard

`askReport()` (`nl-reports-service.ts:92`) mezcla, en una sola función:

- verificación de entitlement `natural_language_reports`,
- verificación de LLM validado,
- lectura de `timezone` y del límite diario desde `organizations`,
- rate limiting por `userId` de Supabase Auth,
- caché por pregunta,
- traducción, ejecución y narrativa,
- construcción de una respuesta con forma de payload HTTP.

**Propuesta:** extraer `src/services/harness/ask-harness.ts` con la orquestación pura (traducción→ejecución→narrativa→bitácora) y dejar en `askReport()` solo lo que es del canal dashboard. `askReport()` pasa a ser un envoltorio delgado sobre `askHarness()`.

- **Restricción no negociable:** refactor **sin cambio de comportamiento**. `__tests__/nl-reports-service.test.ts` y `__tests__/organization-reports-nl-routes.test.ts` deben pasar sin editarse. Si hay que editarlos, el refactor cambió el contrato y está mal.
- El rate limiting se parametriza por *identidad del canal* (`userId` de Supabase en dashboard, `telegram_identity_id` en Telegram) en vez de asumir `userId`.

### 3.2 Hueco B — Permisos sin JWT · **BLOQUEANTE**

`getPermissionsForUser()` (`src/services/permission-service.ts:33`) necesita el JWT del usuario, y su propio comentario explica por qué:

> *"`auth_permissions_in_org()` depende de `auth.uid()` dentro de Postgres... Llamarlo con `supabaseAdmin` (service_role) daría `auth.uid() IS NULL` y todo se denegaría."*

Un usuario de Telegram **no tiene JWT**. Sin resolver esto, el job no puede verificar `use_nl_reports` — y saltárselo sería un bypass de RBAC, explícitamente prohibido por el doc origen.

**Propuesta (mínima y auditable):** una función SQL nueva `member_permissions_in_org(p_org_id uuid, p_user_id uuid)`, `SECURITY DEFINER`, que replique **exactamente** la precedencia de `has_permission()` (invariante de owner → override de organización → default del rol → denegar) tomando el `user_id` como argumento en vez de `auth.uid()`.

- `REVOKE ALL ... FROM anon, authenticated;` y `GRANT EXECUTE ... TO service_role;` — sin esto, cualquier usuario autenticado podría enumerar los permisos de cualquier otro.
- Envoltorio `getPermissionsForMember(organizationId, userId)` en `permission-service.ts`, reutilizando su caché de 30 s e invalidación.
- Punto de revisión conjunta: **la duplicación de la lógica de precedencia en dos funciones SQL es deuda.** Alternativa: refactorizar `has_permission()` para que delegue en la nueva. Más limpio, pero toca RLS en producción de todas las tablas. **Mi recomendación: función nueva ahora, unificación en una tarea aparte.**

### 3.3 Hueco C — Contexto conversacional · **NO EXISTE**

La Fase 10 del doc origen ("determina cómo Hermes mantiene contexto y reutiliza exactamente ese mecanismo") **no tiene mecanismo que reutilizar**. Hay que construirlo.

**Propuesta:**

- `telegram_conversations.context jsonb` guarda los últimos **3 turnos**: `{ question, intent, parameters, period, resultDigest }`. `resultDigest` es un resumen acotado (≤ 500 caracteres), **nunca el dataset completo** — el contexto no es un caché de datos y no debe crecer sin límite.
- `buildTranslationPrompt()` recibe un bloque opcional `TURNOS PREVIOS` y una regla nueva: *resolver referencias anafóricas heredando `intent`/`parameters` del turno previo; si la herencia no produce una intención válida del catálogo, responder `no_resuelta` — nunca aproximar.*
- **El principio rector no se toca:** el LLM sigue devolviendo una intención estructurada del catálogo. El contexto le ayuda a elegir; no le da acceso a nada nuevo.
- **Aislamiento:** clave `(organization_id, telegram_chat_id)`, TTL 30 min, y toda lectura filtra por la organización ya resuelta server-side. Un cambio de organización en la identidad invalida el contexto.
- **Límite honesto del ejemplo del doc origen:** `"Dame sus nombres"` funciona porque `listado_prospectos` existe en el catálogo. Donde no exista una intención de listado equivalente, la respuesta correcta es `no_resuelta`. No se inventa una intención para que la demo se vea bien.

### 3.4 Metering — no hay hueco, hay atribución faltante

`translateQuestion()` y `generateNarrative()` **ya llaman a `recordLlmUsage()`**, que ya resuelve tarifa con `getRate()` contra `provider_rates` y ya escribe en `usage_events`. No hay que construir metering.

Lo único que falta: `recordLlmUsage()` no acepta metadata de canal, así que hoy no se puede distinguir el consumo de Telegram del consumo del dashboard. **Propuesta:** parámetro opcional `metadata: { channel, conversationId }` que se fusiona con el actual `{ model, provider }`. Sin unit_types nuevos, sin proveedores nuevos, sin tarifas en el código.

---

## 4. Decisiones de diseño

### 4.1 Feature

```
key:               telegram
name:              Telegram AI Harness
description:       Interfaz conversacional de Telegram sobre el arnés de IA de Datagol.
category:          mensajeria          ← NO 'channels' (§1.3.1)
requires_provider: telegram            ← exige rama nueva en checkProviderCredentials (§1.3.5)
has_cost_impact:   false               ← BYOK, precedente migración 44 (§1.3.2)
planes:            pro / elite / enterprise = true;  starter = false explícito
```

Sin `telegram_enabled` en `integration_settings`. Sin condicionales sobre `plan_key`. Resolución siempre por `organization_enabled_features()`.

### 4.2 Autenticación del webhook — doble candado

Telegram **no firma HMAC**. Ofrece dos mecanismos, y se usan los dos:

1. **Enrutamiento:** `/webhooks/telegram/:webhookToken` — `webhookToken` (32 bytes aleatorios, propio de `telegram_connections`) resuelve la organización **antes de tocar el cuerpo**. Identificador de enrutamiento, no secreto; mismo principio que `elevenlabs.ts` y `tool-auth.ts`.
2. **Autenticación:** el `secret_token` que se pasa en `setWebhook` llega en el header `X-Telegram-Bot-Api-Secret-Token`. Se compara en **tiempo constante** contra el secreto guardado en Vault. Es el patrón exacto de `x-tool-secret` en `lib/tool-auth.ts`.

Orden no negociable: resolver conexión → autenticar header → validar Zod → verificar `organizations.status` → idempotencia → encolar → 200. **`status` se verifica después de autenticar**, nunca antes (misma razón documentada en `tool-auth.ts`: revelar "existe pero está suspendida" a un no autenticado ya es filtrar información).

### 4.3 Modelo de datos — migración `72_telegram_channel.sql`

Cinco tablas nuevas, todas con `organization_id`, RLS activa, política de lectura por `has_permission(...)` y política de escritura restringida, siguiendo el patrón literal de `db/migrations/64_appointment_waitlist.sql`.

| Tabla | Propósito | Puntos críticos |
|---|---|---|
| `telegram_connections` | El bot de una organización | `unique(organization_id)`, `unique(webhook_token)`, `unique(telegram_bot_id)`. **Sin columna de token**: vive en Vault. |
| `telegram_identities` | Telegram user ↔ `organization_members` | Identidad primaria = `telegram_user_id` (numérico, inmutable). `username` solo como metadata para mostrar, **jamás como autoridad**. |
| `telegram_link_tokens` | Vinculación de un solo uso | `token_hash` SHA-256 con `UNIQUE` (patrón `invitation-service.ts` / `offer_token_hash`), `expires_at`, `used_at`. El token crudo nunca se persiste ni se loguea. |
| `telegram_conversations` | Contexto por chat | `unique(organization_id, telegram_chat_id)`, `context jsonb`, `context_expires_at`. |
| `telegram_messages` | Bitácora inbound/outbound | `direction`, `telegram_message_id`, `harness_status`, `error`. Sin PII innecesaria. |

**Restricción de seguridad clave: `telegram_identities` lleva `UNIQUE (telegram_user_id)` global** — un usuario de Telegram pertenece a **una** organización. Sin ella, un chat privado tendría que desambiguar organización, y esa desambiguación la elegiría el usuario: exactamente lo que la Fase 5 del doc origen prohíbe. Multi-organización queda para v2 con un comando explícito de cambio de contexto, no en v1.

La misma migración extiende dos CHECK constraints (patrón `db/migrations/35_llm_byok.sql`, BLOQUE 2):

- `organization_secrets_secret_key_check` += `telegram_bot_token`, `telegram_webhook_secret` → y actualizar `src/types/secret-keys.ts`.
- El CHECK de `webhook_events.provider` += `telegram` → y actualizar `src/types/webhook-provider.ts`.

> 🔎 **Discrepancia encontrada, ajena a esta tarea pero que la toca.** El CHECK de `webhook_events.provider` **existe en la base real** (así lo afirma `src/types/webhook-provider.ts` y lo verifica `__tests__/webhook-provider.test.ts` por inserción directa), pero **no lo crea ningún archivo de `db/migrations/`** — es anterior al versionado. Y `db/client-schema-bootstrap.sql:551` (archivo nuevo, aún sin commit, del trabajo de aprovisionamiento de clientes) **recrea la tabla sin ese CHECK**. Consecuencia: una instalación cliente nueva aceptaría cualquier valor de `provider` mientras la base principal no. Antes de T1 hay que decidir si la migración 72 lo declara con `ADD CONSTRAINT ... IF NOT EXISTS`-equivalente (idempotente en ambos entornos) o si el bootstrap se corrige aparte. **El mismo hueco existe, verificado, en `organization_secrets`: el bootstrap (línea 220) declara `secret_key text not null` sin CHECK alguno.**

Ambos tipos tienen pruebas que verifican la sincronía contra la base real (`__tests__/secret-keys.test.ts`, `__tests__/webhook-provider.test.ts`); esas pruebas fallarán hasta que la migración se aplique. Es la señal correcta, no un problema.

> ⚠️ Según lo que ya me indicaste, **las migraciones aquí se aplican a mano**. La migración se escribe y se revisa; no la ejecuto contra el proyecto Supabase sin tu visto bueno explícito.

### 4.4 Vinculación (Fase 6)

```
Dashboard → POST /api/organizations/:id/telegram/link-tokens   (permiso: manage_credentials)
          → devuelve  https://t.me/<bot>?start=<token crudo>   ← única vez que el token existe en claro
Usuario   → /start <token>  en Telegram
Webhook   → hashToken(token) → busca en telegram_link_tokens
            → valida: no expirado, no usado, pertenece a la conexión de ESTA organización
            → crea telegram_identities(telegram_user_id → organization_member_id)
            → marca used_at (invalidación) en la misma transacción
```

- Entropía: `crypto.randomBytes(32).toString('hex')`, igual que `createInvitation()`.
- El rol del miembro se verifica **en el momento de canjear** y **otra vez en cada mensaje** — un miembro degradado de admin a member después de vincularse deja de tener acceso, sin necesidad de desvincularlo.
- `/start` con token inválido, expirado o de otra organización responde **el mismo mensaje genérico** en los tres casos. Distinguirlos sería un oráculo de enumeración.
- Rate limit por `telegram_user_id` con `lib/rate-limiter.ts` sobre los intentos de `/start`.

### 4.5 Autorización en el momento del mensaje (Fase 5)

Cadena completa, re-evaluada en **cada** mensaje, dentro del job (nunca solo en el webhook):

```
telegram_user_id  →  telegram_identities (status='active')
                  →  organization_members (rol ∈ {owner, admin})
                  →  organizations (status ≠ 'suspended')
                  →  feature 'telegram' habilitada
                  →  permiso 'use_nl_reports'  ← vía getPermissionsForMember (§3.2)
                  →  askHarness()
```

Un `telegram_user_id` sin identidad activa recibe **el mismo mensaje** que uno con identidad revocada. No se confirma la existencia de la organización a un desconocido.

### 4.6 Adapter de salida (Fase 11)

- **`parse_mode: 'HTML'`, no MarkdownV2.** MarkdownV2 exige escapar 18 caracteres reservados y falla la petición entera si uno se escapa mal — un nombre de contacto con guion rompe el mensaje. HTML necesita escapar tres caracteres y ya tenemos `src/lib/html-escape.ts` probado.
- **División en 4096 caracteres** por frontera de párrafo → línea → palabra, en ese orden. Nunca a mitad de una etiqueta abierta. Numeración `(1/3)` cuando hay más de una parte.
- **Rate limits de Telegram** (~30 msg/s global, ~1 msg/s por chat): `lib/rate-limiter.ts` + reintento con backoff cuando la API devuelve 429 con `retry_after`.
- **Errores:** un catálogo cerrado de mensajes en español, verbalizables. Nunca stack traces, nunca errores de Postgres, nunca IDs internos. Mismo criterio que `ERROR_MESSAGES` en `llm-config-service.ts`.
- `fetchWithTimeout()` de `services/llm/http.ts` para toda llamada saliente a la Bot API.

### 4.7 Observabilidad

Añadir a `redact.paths` del logger en `src/app.ts`: **`telegram_bot_token`, `telegram_webhook_secret`, `link_token`**. El patrón `*.token` existente **no** cubre una clave llamada `telegram_bot_token` — cubre una clave llamada exactamente `token`. Sin esta línea, un log de error del servicio de conexión escribiría el bot token en claro.

Todo log del canal lleva: `request_id`, `organization_id`, `telegram_update_id`, `telegram_chat_id`, `telegram_user_id`, `conversation_id`. Nunca el texto del mensaje en nivel `info` (es contenido del cliente).

---

## 5. Fases de implementación y checkpoints

Cada fase termina con `pnpm type-check && pnpm lint && pnpm test` en verde. **Los checkpoints marcados 🛑 requieren tu revisión antes de continuar.**

| # | Fase | Entregable | Checkpoint |
|---|---|---|---|
| **T0** | Diseño | Este documento | 🛑 **estamos aquí** |
| **T1** | Cimientos de datos | `db/migrations/72_telegram_channel.sql` (5 tablas + RLS + índices + 2 CHECK extendidos + feature + plan_features) y los tipos de `src/types/` correspondientes | 🛑 revisar SQL antes de aplicar a mano |
| **T2** | Extracción del arnés | `src/services/harness/ask-harness.ts`; `askReport()` pasa a envolverlo. **Cero cambios en los tests existentes** | 🛑 dos cortes: (a) si hay que editar un test existente, el refactor rompió el contrato; (b) el `grep` de §0.1 debe dar una sola invocación de `translateQuestion`/`executeIntent`, dentro de `harness/` |
| **T3** | Permisos sin JWT | `member_permissions_in_org()` (SECURITY DEFINER, grants restringidos) + `getPermissionsForMember()` + tests de aislamiento | 🛑 revisar los GRANT/REVOKE |
| **T4** | Configuración admin | `GET/POST/DELETE /api/organizations/:id/telegram`, `POST .../validate`, `POST .../webhook`. Valida contra `getMe`, guarda en Vault, registra el webhook. **Nunca devuelve el token** | |
| **T5** | Vinculación | `POST .../telegram/link-tokens`, `DELETE .../telegram/identities/:id`, manejo de `/start` | |
| **T6** | Webhook | `src/routes/webhooks/telegram.ts` — doble candado, Zod, `webhook_events`, encolado, 200 rápido | |
| **T7** | Job | `src/jobs/process-telegram-update.ts` — re-verificación completa + `askHarness()` | |
| **T8** | Contexto | `telegram_conversations` + bloque de turnos previos en el prompt + TTL + aislamiento | 🛑 revisar el prompt: es donde se rompe el principio rector si se rompe |
| **T9** | Salida | `src/services/telegram/formatter.ts` + `telegram-client.ts` | |
| **T10** | Cierre | Atribución de canal en `recordLlmUsage`, logs, `redact.paths`, `docs/telegram-integration.md` (vía `/doc-coauthoring`), `AGENTS.md §17` y §18 | |

**Fuera de v1:** las acciones de escritura (Fase 9 del doc origen). Ver §6.

---

## 6. Fase 9 (acciones) — recomendación: fuera de la v1

La Fase 9 pide *"no crear una ruta especial de escritura solamente para Telegram si el servicio existente puede reutilizarse"*. **Auditado el catálogo, el servicio existente no puede reutilizarse, porque no existe como servicio.**

Lo que encontré:

- La lógica de negocio de escritura vive **dentro de los handlers de ruta**: `PATCH .../contacts/:contactId/pipeline` (`src/routes/contacts-crm.ts:154`) contiene inline la coherencia `lifecycle_stage`/`pipeline_stage`, la guarda de `close_deals`, las reglas de `deal_value` y el UPDATE. No hay `contact-pipeline-service.ts`.
- `src/services/appointment-lifecycle.ts` **solo exporta dos funciones puras de validación** (`isValidStatusTransition`, `isFutureCompletionAttempt`). No orquesta escritura.
- Los handlers escriben con `fastify.supabaseUser(jwt)` **precisamente para que la RLS de la migración 45 aplique**. Un usuario de Telegram no tiene JWT, así que ese camino no existe para él.

Habilitar acciones exige, antes de escribir una línea de Telegram: extraer los servicios de escritura de los handlers, darles un camino `service_role` con filtro explícito de `organization_id` en la aplicación (`AGENTS.md §16`: *"No confiar exclusivamente en RLS para los webhooks, porque usan contexto server-side"*), y cubrirlos con las tres pruebas que el doc origen exige por operación (éxito, rechazo, idempotencia). Es una tarea propia, comparable en tamaño a todo el resto de este plan.

**Recomiendo v1 de solo lectura** (Fases 8 + 10 del doc origen), con `askHarness()` diseñado desde ahora para que las acciones entren en v2 como un tipo de intención más, sin rediseño. Es una recomendación, no una negativa: **si prefieres acciones en la v1, la extracción de servicios entra como fase T-1 obligatoria y el plan crece en consecuencia.** Dímelo y lo redimensiono.

---

## 7. Definition of Done ajustada a la v1

Se conserva íntegra la lista del doc origen, con estas modificaciones justificadas:

| Ítem del doc origen | Estado |
|---|---|
| `Telegram utiliza Hermes/AI Harness existente` | ✏️ **Reemplazado por §0.1 (ratificado).** Telegram usa el pipeline de `services/reports/` vía `askHarness()`. No hay Hermes. |
| `No existe un segundo agente paralelo` | ✅ Sin cambios, y **elevado a criterio de rechazo** por §0.1, verificable con el `grep` allí definido. |
| `Las acciones respetan permissions` | ⏸️ **Diferido a v2** (§6). No hay acciones en v1. |
| `Metering implementado si aplica` | ✅ Ya implementado; solo se agrega atribución de canal (§3.4). |
| `Mutation testing cumple los thresholds` | ✅ Con la precisión de `AGENTS.md §10`: `telegram-auth`, `telegram-identity` y el webhook son **seguridad y aislamiento → ≥90% contra el score TOTAL**, no contra el de código cubierto. Rutas y job: ≥75%. |
| Todo lo demás | ✅ Sin cambios. |

**Pruebas innegociables** (además de las del doc origen), cada una con su contraparte de éxito, por `AGENTS.md §9`:

1. Telegram user de la organización A no obtiene datos de B **aunque escriba el UUID de B en el mensaje**.
2. La organización se resuelve solo desde `telegram_connections`; ningún campo del update la influye.
3. Header `X-Telegram-Bot-Api-Secret-Token` ausente / incorrecto / correcto.
4. Mismo `update_id` dos veces → un solo efecto.
5. Token de vinculación: válido / expirado / usado / inexistente / de otra organización → los últimos cuatro con **mensaje idéntico**.
6. `member` y `viewer` vinculados → rechazados; `owner` y `admin` → aceptados.
7. Feature `telegram` deshabilitada por plan, por override, y por kill switch global → rechazo en los tres, **verificado en el job**, no solo en la ruta.
8. Miembro degradado **después** de vincularse → rechazado en el siguiente mensaje.
9. El contexto conversacional nunca cruza organizaciones ni chats.
10. Respuesta > 4096 caracteres → dividida sin romper etiquetas ni significado.
11. `member_permissions_in_org()` **no** es ejecutable por `authenticated`.

---

## 8. Riesgos abiertos

| Riesgo | Mitigación propuesta |
|---|---|
| El refactor T2 rompe reportes en producción | Regla dura: los tests existentes no se editan. Si hay que editarlos, se revierte y se replantea. |
| Duplicar la precedencia de permisos en dos funciones SQL (§3.2) | Aceptada como deuda consciente y documentada; unificación en tarea aparte. **Punto explícito de revisión.** |
| El contexto conversacional degrada la precisión del traductor | Métrica antes/después sobre las 22 intenciones. Si empeora, el bloque de contexto se apaga con una bandera y se replantea. |
| `BACKEND_WEBHOOK_URL` es opcional en `config/env.ts` | `POST .../telegram/webhook` falla con mensaje accionable si falta, en vez de registrar una URL rota en Telegram. |
| Suite completa con inestabilidad ya conocida | Las pruebas nuevas se validan también en aislamiento; usar clave de plan ficticia, nunca escribir filas reales de `plan_features`/`features` desde un test. |
| Telegram reintenta agresivamente ante un 5xx | El webhook responde 200 en todo lo que no sea fallo de infraestructura; el trabajo real vive en pg-boss con sus propios reintentos. |

---

## 9. Qué necesito de ti para arrancar

1. **§6 — ¿acciones dentro o fuera de la v1?** Es la decisión que más cambia el tamaño de la tarea.
2. **§3.2 — ¿función SQL nueva, o refactorizar `has_permission()`?** Recomiendo la primera; la segunda toca RLS en producción.
3. **§4.3 — ¿confirmas `UNIQUE (telegram_user_id)` global?** Un usuario de Telegram = una organización en la v1.
4. **§4.1 — ¿planes pro/elite/enterprise, o solo elite/enterprise?**
5. **Confirmación de que la migración 72 la aplicas tú a mano**, como el resto.
