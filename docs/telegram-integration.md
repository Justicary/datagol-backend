# Manual de Integración del Canal Conversacional de Telegram

Este documento especifica la arquitectura, el modelo de seguridad, las tablas de base de datos, los endpoints administrativos y el flujo operativo del canal conversacional de Telegram (`feature_key = 'telegram'`, disponible a partir del Plan `PRO`: `pro`, `elite`, `enterprise`).

---

## 1. Principio Rector: Segundo Consumidor del Arnés Central (Sin Agente Paralelo)

El canal de Telegram **no** introduce un agente paralelo ni un motor de consultas independiente. Comparte exactamente el mismo arnés agnóstico de canal (`src/services/harness/ask-harness.ts`) que el endpoint HTTP `POST /api/organizations/:id/reports/ask`:

1. **Traducción acotada al catálogo (`nl-translation-service.ts`):** El LLM (o Jev cuando no hay contexto previo) traduce la pregunta en español a una de las intenciones cerradas del catálogo oficial (`src/services/reports/intents/`) y valida sus parámetros con Zod.
2. **Resolución determinista de periodo (`period-resolver.ts`):** Los rangos temporales (`hoy`, `esta_semana`, `este_mes`, etc.) se resuelven en la zona horaria local de la organización (`organizations.timezone`).
3. **Ejecución parametrizada y conversión a hora local (`executeIntent`):** Consulta determinista sobre Supabase con `organization_id` inyectado desde el servidor. Toda intención con horarios específicos (`start_time` y `end_time` en agenda) formatea deterministamente las marcas de tiempo a la zona horaria de la organización (`period.timezone`) vía `formatToZonedTime`.
4. **Narrativa con verificación anti-alucinación (`nl-narrative-service.ts`):** Toda cifra de la narrativa se verifica contra los datos exactos (que ya incluyen los horarios locales calculados); si hay discrepancia, se descarta la narrativa y se entregan únicamente los datos verificados.
5. **Formateo HTML en zona horaria local (`formatter.ts`):** `formatHarnessResponseForTelegram` renderiza la respuesta y traduce cualquier marca de tiempo ISO al horario local de la organización (`response.period.timezone`), evitando exponer marcas de tiempo UTC crudas en el chat.
6. **Metering por organización (`recordLlmUsage`):** Cada llamada al LLM registra tokens y costo en `usage_events` atribuidos a `organization_id` con metadatos `{ channel: 'telegram', conversation_id }`.

---

## 2. Modelo Multi-Tenant BYOB y Doble Candado de Seguridad

### 2.1 Un Bot por Organización (BYOB en Supabase Vault)
Cada organización configura su propio Bot creado en `@BotFather`:
- `telegram_bot_token` y `telegram_webhook_secret` se almacenan **exclusivamente** en Supabase Vault (`organization_secrets`). Jamás se persisten en columnas en texto plano ni se devuelven en respuestas de la API.
- `telegram_connections` mantiene una relación `1:1` con `organizations` (`UNIQUE (organization_id)` y `UNIQUE (telegram_bot_id)`), junto con un `webhook_token` aleatorio de 256 bits para enrutar el webhook.

### 2.2 Doble Candado en `POST /webhooks/telegram/:webhookToken`
1. **Enrutamiento server-side (`:webhookToken`):** Resuelve `organization_id` en `telegram_connections` antes de inspeccionar cualquier campo del cuerpo JSON.
2. **Autenticación criptográfica en tiempo constante (`X-Telegram-Bot-Api-Secret-Token`):** Se compara mediante `timingSafeEqualStrings()` contra `telegram_webhook_secret` en Vault.
3. **Anti-enumeración de estado:** El estado `organizations.status = 'suspended'` se verifica **después** de autenticar el header secreto; una petición con secreto inválido siempre recibe `401 Unauthorized`.
4. **Idempotencia:** Cada `update_id` entrante se registra en `webhook_events` (`provider = 'telegram'`, `UNIQUE (provider, event_id)`). Los reintentos de Telegram devuelven `200 OK` sin duplicar trabajo.
5. **Sólo chats privados 1:1:** Cualquier update proveniente de `group`, `supergroup`, `channel` o de otro bot (`from.is_bot = true`) se ignora de forma segura con `200 OK`.

---

## 3. Vinculación de Identidades (`/start <token>`) y Los 6 Candados por Mensaje

### 3.1 Vinculación de Administradores (Opción 2 + Opción A)
- Todos los miembros activos de la organización con rol `owner` o `admin` y permiso `use_nl_reports` pueden vincular su cuenta personal de Telegram (`UNIQUE (organization_id, organization_member_id)` en `telegram_identities`).
- En v1 cada cuenta personal de Telegram (`telegram_user_id` numérico inmutable) se vincula a una sola organización activa (`UNIQUE (telegram_user_id)`).
- El endpoint `POST /api/organizations/:id/telegram/link-tokens` genera un token criptográfico de 256 bits con vigencia de **15 minutos** y un solo uso, almacenando **únicamente su hash SHA-256** (`token_hash`) en `telegram_link_tokens`.
- Cuando el administrador abre `https://t.me/<bot_username>?start=<token>`, el worker canjea el token de forma atómica (`UPDATE ... WHERE used_at IS NULL`) y crea la identidad activa en `telegram_identities`.

### 3.2 Re-verificación en Tiempo Real (6 Candados en `authorizeTelegramMessageSender`)
En cada mensaje entrante procesado por `src/jobs/process-telegram-update.ts`, se verifican en tiempo real:
1. Identidad existente y `status = 'active'` en `telegram_identities` para `(organization_id, telegram_user_id)`.
2. Organización activa (`organizations.status != 'suspended'`).
3. Feature `telegram` habilitada para la organización (`isFeatureEnabled(orgId, 'telegram')`).
4. Feature `natural_language_reports` habilitada (`isFeatureEnabled(orgId, 'natural_language_reports')`).
5. Membresía vigente en `organization_members` con rol `owner` o `admin` (si un `admin` es degradado a `member` o `viewer`, pierde acceso de inmediato).
6. Permiso RBAC `use_nl_reports` vigente vía `getPermissionsForMember(orgId, userId)` (`RPC public.member_permissions_in_org`, exclusiva para `service_role`).

---

## 4. Contexto Conversacional Multi-Turno y Comandos

- **Ventana deslizante acotada (`telegram_conversations`):** Aislada por `UNIQUE (organization_id, telegram_chat_id)`. Conserva como máximo los **últimos 3 turnos** con `resultDigest <= 500` caracteres (sin almacenar datasets crudos) y expira automáticamente tras **30 minutos** de inactividad (`context_expires_at`).
- **Comandos soportados:**
  - `/start <token>`: Canjea un enlace de vinculación de un solo uso.
  - `/start` / `/ayuda` / `/help`: Muestra la guía de categorías de reportes y comandos disponibles.
  - `/nuevo` / `/reset`: Limpia inmediatamente el contexto conversacional activo del chat.

---

## 5. Endpoints Administrativos (`src/routes/organization-telegram.ts`)

| Método y Ruta | Permiso Requerido | Descripción |
|---|---|---|
| `GET /api/organizations/:id/telegram` | `manage_credentials` | Estado de conexión del Bot e identidades vinculadas (sin secretos). |
| `POST /api/organizations/:id/telegram` | `manage_credentials` | Valida el `botToken` contra `getMe`, guarda secretos en Vault y registra la conexión. |
| `POST /api/organizations/:id/telegram/validate` | `manage_credentials` | Verifica el token guardado en Vault (o uno candidato) contra `getMe`. |
| `POST /api/organizations/:id/telegram/webhook` | `manage_credentials` | Registra el webhook HTTPS en Telegram (`BACKEND_WEBHOOK_URL/webhooks/telegram/:webhookToken`). |
| `DELETE /api/organizations/:id/telegram` | `manage_credentials` | Elimina el webhook en Telegram, desconecta el Bot y revoca las identidades activas. |
| `POST /api/organizations/:id/telegram/link-tokens` | `use_nl_reports` | Genera un deep link efímero (15 min, 1 uso) para el administrador (`owner`/`admin`) autenticado. |
| `DELETE /api/organizations/:id/telegram/identities/:identityId` | `manage_credentials` | Revoca una identidad de Telegram vinculada y limpia su contexto conversacional. |

---

## 6. Infraestructura en Cloud Run, Red IPv4 y Modos de Operación (Hallazgos Operativos)

Durante la puesta en marcha en Google Cloud Run (`datagol-api`) se identificaron y resolvieron tres factores críticos de infraestructura que todo despliegue u operación del canal de Telegram debe respetar:

### 6.1 Obligatoriedad del Connection Pooler IPv4 de Supabase (`DATABASE_URL`)
- **Causa raíz:** Los contenedores de Google Cloud Run (sin VPC conector con salida IPv6) solo cuentan con ruta de salida **IPv4**. El host directo de Supabase (`db.<project_ref>.supabase.co`) resuelve únicamente registros `AAAA` (IPv6). Si `DATABASE_URL` apunta al host directo, tanto `pg-boss` como `getSecret()` (`src/services/secret-service.ts`, que consulta `vault.decrypted_secrets` mediante `pg.Pool`) sufren timeouts de conexión (`ETIMEDOUT` / `ENETUNREACH`), impidiendo leer `telegram_bot_token` y `llm_api_key` desde el Vault.
- **Solución obligatoria:** Configurar `DATABASE_URL` utilizando el **Connection Pooler IPv4 (Supavisor)** en modo sesión (puerto `5432`, compatible con `pg.Pool` y *prepared statements* de `pg-boss`):
  ```env
  DATABASE_URL=postgresql://postgres.<project_ref>:<password>@aws-0-us-east-2.pooler.supabase.com:5432/postgres
  ```
- **Caracteres especiales en contraseñas (`src/lib/database-url.ts`):** `parseDatabaseUrl()` soporta tanto contraseñas con caracteres especiales sin escapar (`?`, `/`, `!`) como contraseñas codificadas en formato URL (`%3F`, `%2F`, `%21`), decodificándolas antes de entregarlas a `pg.Pool` y `pg-boss`.

### 6.2 Ejecución en el Ciclo HTTP + Respaldo en `pg-boss` (Compatibilidad con `--cpu-throttling` Costo $0)
En Google Cloud Run, cuando el servicio opera en **Modo Desarrollo (`--min-instances=0` + `--cpu-throttling`)**, la CPU del contenedor se congela en el instante exacto en que finaliza la petición HTTP (`200 OK`). Para que el Bot de Telegram responda en **< 2 segundos** incluso en Modo Desarrollo (costo **$0 USD/mes**) y **sin duplicar respuestas (eco)**:
1. `POST /webhooks/telegram/:webhookToken` registra la idempotencia en `webhook_events` (`UNIQUE (provider, event_id)`) y **ejecuta primero `processTelegramUpdateJob` dentro de la petición HTTP activa** antes de llamar a `fastify.pgBoss.send`.
2. Al concluir `processTelegramUpdateJob`, `webhook_events.processed_at` queda persistido en Postgres **antes** de que el trabajo exista en `pg-boss`. De esta forma, se evita la condición de carrera en la que `pg-boss` tomaba el job en paralelo mientras el LLM seguía respondiendo (`processed_at IS NULL`) y enviaba la respuesta dos veces.
3. Cuando el worker de `pg-boss` (`registerProcessTelegramUpdateWorker`) inspecciona el job encolado, verifica `processed_at` y lo omite en 1ms; si la ejecución en línea falló antes de marcar `processed_at`, `pg-boss` actúa como respaldo automático.

| Modo de Operación | Comando | Parámetros de Cloud Run | Impacto en el Bot de Telegram y Costo |
|---|---|---|---|
| **Modo Desarrollo (Bajo Demanda — Costo $0)** | `pnpm reanudarAPI:dev` (`scripts/resume-service-dev.sh`) | `--min-instances=0` + `--cpu-throttling` | **Costo $0 USD/mes** (cubierto por el Free Tier). Gracias al procesamiento durante la petición HTTP activa, Cloud Run mantiene el 100% de la CPU asignada mientras el arnés consulta al LLM y responde en Telegram (~1.5–2.5s), escalando a 0 en reposo. |
| **Modo Producción (Cero Cold Starts)** | `pnpm reanudarAPI:prod` (`scripts/resume-service.sh`) | `--min-instances=1` + `--no-cpu-throttling` | **~$15 USD/mes** (CPU *Always Allocated* 24/7). Elimina cualquier *cold start* en llamadas de voz y webhooks tras periodos de inactividad. |
| **Modo Pausa Total** | `pnpm pausarAPI` (`scripts/pause-service-dev.sh`) | `--min-instances=0` + `--ingress=internal` | **Costo $0 absoluto.** Bloquea el tráfico externo cuando no se están realizando pruebas. |

### 6.3 Modelos de Razonamiento en OpenRouter (`openrouter/auto`) y Preguntas de Capacidades
- **Control de tokens de razonamiento (`OpenAiCompatibleAdapter.ts`):** Cuando una organización utiliza `openrouter` (por ejemplo, `openrouter/auto`, que enruta dinámicamente a modelos de razonamiento como `z-ai/glm-5.3-flash` o `deepseek/deepseek-v4.1-flash`), el adaptador incluye `reasoning: { effort: 'low' }` y un presupuesto de `TRANSLATION_MAX_OUTPUT_TOKENS = 1500` (`NARRATIVE_MAX_OUTPUT_TOKENS = 800`). Sin este ajuste, los modelos de razonamiento consumían el límite anterior (600 tokens) dentro de `message.reasoning` (`finish_reason: "length"`) y devolvían `message.content: null`, provocando el error *"No se pudo estructurar la consulta a partir de la respuesta del modelo"*.
- **Detección directa de preguntas de ayuda (`isTelegramHelpQuery`):** Además de los comandos `/start`, `/ayuda` y `/help`, el bot detecta preguntas en lenguaje natural sobre sus capacidades (ej. *"¿Qué tipo de preguntas te puedo hacer o puedes contestar?"*, *"¿En qué me puedes ayudar?"*) y responde de inmediato con la guía estructurada de las 6 familias del catálogo sin consumir tokens de LLM.
- **Dictado por voz desde el dispositivo móvil (Android Gboard / iOS Dictation):** Para consultar al Bot hablando sin enviar archivos de audio (`.ogg`), consulta la guía paso a paso en [docs/telegram-voice-dictation-guide.md](file:///home/justicary/proyectos/antigravity/datagol-backend/docs/telegram-voice-dictation-guide.md).

