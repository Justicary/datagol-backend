# Integración de Correo Nativa (IMAP/SMTP)

Módulo de correo multitenant que permite a cada organización vincular sus
propios buzones IMAP/SMTP (sin proveedor intermedio de pago) para que el
agente de voz/chat busque, lea y despache correos durante o después de una
conversación. Implementa la tarea descrita en
[`docs/tasks/native-mail-integration.md`](tasks/native-mail-integration.md).

> `email_outbox` y el buzón IMAP también se consultan desde reportes en
> lenguaje natural (`POST /api/organizations/:id/reports/ask`, intenciones
> `conteo_correos_enviados`/`listado_correos_enviados`/`correos_con_error`/
> `resumen_correos_recibidos`) — ver
> [`docs/natural-language-reports.md` §2.1 y §7](natural-language-reports.md)
> para esa integración y sus particularidades (fuente de datos en vivo,
> presupuesto de latencia de `executeIntent`).

## 1. Resumen de arquitectura

| Pieza | Ubicación |
|---|---|
| Alta/baja/listado de buzones + resolución del buzón activo | `src/services/email/email-account.service.ts` |
| Credenciales por buzón (Vault) | `src/services/email/email-account-vault.ts` |
| Cliente IMAP (búsqueda/lectura) | `src/services/email/imap-client.ts` |
| Cliente SMTP (envío) | `src/services/email/smtp-client.ts` |
| Envío/borrador + idempotencia | `src/services/email/email-dispatch.service.ts` |
| Rutas admin (dashboard/staff) | `src/routes/admin/email-accounts.ts` |
| Rutas de tool calling (LLM) | `src/routes/tools/email.ts` |
| Migración de base de datos | `db/migrations/53_email_integration.sql` |

`getActiveEmailAccount(fastify, organizationId, emailAccountId?)`
(`email-account.service.ts`) es la única función que resuelve "qué buzón
usar" — sin `emailAccountId` explícito, resuelve el único buzón **activo**
de la organización; con 0 o más de 1, devuelve un mensaje en vez de
adivinar. Tiene dos consumidores: `routes/tools/email.ts` (las tres rutas
de tool calling) y la intención `resumen_correos_recibidos` de reportes en
lenguaje natural — antes vivía duplicada sin exportar dentro de
`routes/tools/email.ts` (`resolveEmailAccount`); se extrajo al agregar el
segundo consumidor para no repetir la lógica.

### Por qué las credenciales no viven en `organization_secrets`

`organization_secrets` tiene un `CHECK` constraint fijo (`SECRET_KEYS` en
`src/types/secret-keys.ts`) pensado para **un secreto por tipo por
organización** (`elevenlabs_api_key`, `cal_api_key`, etc.). Una organización
puede vincular **varios buzones**, así que ese modelo no aplica. En su
lugar, cada fila de `email_accounts` tiene su propio `vault_secret_id`,
apuntando directo a Supabase Vault con el mismo mecanismo interno que usa
`secret-service.ts` (`vault.create_secret` / `vault.update_secret` vía
`pg.Pool`, porque `vault.decrypted_secrets` no está expuesto por
PostgREST) — implementado en `email-account-vault.ts`. El secreto guardado
es un único JSON `{ imapPassword, smtpPassword }` por buzón, nombrado
`org:<organizationId>:email_account:<accountId>`.

### Por qué las rutas admin están protegidas por `isPlatformAdmin`

El proyecto opera bajo un modelo Done-For-You: cada PyME cliente no
configura su propia infraestructura, es el equipo de Datagol quien la
provisiona en su nombre. Por eso `routes/admin/email-accounts.ts` sigue el
mismo patrón que `organizations.ts`, `plans.ts` y `reports.ts` — protegido
por `isPlatformAdmin`, con `organizationId` resuelto siempre de `:orgId` en
la ruta, nunca del cuerpo de la petición (AGENTS.md §5).

### Por qué `email_outbox` cubre borradores y bitácora de envío a la vez

En vez de dos tablas separadas, una sola fila representa tanto "borrador
guardado" como "correo enviado/fallido" — el campo `status` distingue el
estado. Esto simplifica la idempotencia: la restricción
`UNIQUE (organization_id, idempotency_key)` es el mismo backstop tanto para
un reintento de "guardar borrador" como para un reintento de "enviar",
replicando el patrón `INSERT ... ON CONFLICT` que ya usa
`routes/tools/booking.ts` para citas (AGENTS.md §4).

## 2. Modelo de datos (migración 53)

- **`plans.max_mailboxes`** / **`organizations.max_mailboxes`** (`int4`,
  `NULL` = sin límite): mismo patrón que `max_concurrent_calls`. Se
  sincroniza de plan a organización en `setOrganizationPlan()`
  (`src/services/entitlements.ts`) cada vez que cambia el plan.
- **`email_accounts`**: metadatos de conexión (`imap_host`, `imap_port`,
  `imap_secure`, `imap_username`, `smtp_host`, `smtp_port`, `smtp_secure`,
  `smtp_username`, `email_address`, `provider_label`), estado
  (`active` / `error` / `disabled`) y `vault_secret_id`. **Nunca contiene
  contraseñas.** RLS habilitada sin policies — solo `service_role` (admin
  routes + tool routes) la toca, igual tratamiento que
  `organization_secrets`.
- **`email_outbox`**: borradores y bitácora de envío, con
  `idempotency_key` `UNIQUE` por organización, `to_addresses`/
  `cc_addresses` como `text[]`, `contact_id` opcional (referencia a
  `contacts`), y `provider_message_id`/`error_message` para trazabilidad.
- **Feature `email_integration`**: sembrada en `features` (categoría
  `operacion`, `requires_provider = NULL` porque las credenciales las
  aporta el cliente, no un proveedor que Datagol administre). **Deny by
  default**: no se asignó a ningún plan en la migración — hay que
  habilitarla explícitamente por organización (`POST
  /api/admin/features/organization/:orgId/overrides`) o agregarla a un
  plan (`POST /api/admin/features` con `plans: [...]`) antes de poder
  vincular un buzón para esa organización.

> **Estado de la migración**: `db/migrations/53_email_integration.sql` ya
> se aplicó contra el proyecto Supabase en vivo (`db/schema.md` refleja
> `email_accounts`, `email_outbox` y `max_mailboxes`). Este proyecto aplica
> migraciones manualmente — si estás viendo este documento antes de que se
> aplique en tu entorno, toda ruta de este módulo fallará con un error de
> tabla inexistente hasta que se aplique.

## 3. Rutas administrativas (`routes/admin/email-accounts.ts`)

Todas requieren `isPlatformAdmin` (header `Authorization: Bearer <jwt>` de
un usuario `platform_admin`, o `x-platform-admin: true` en desarrollo
local).

### `GET /api/admin/email-accounts/organization/:orgId`

Lista los buzones vinculados y el cupo del plan.

```json
{
  "accounts": [
    {
      "id": "uuid",
      "emailAddress": "reservas@clinica.mx",
      "providerLabel": "gmail",
      "imapHost": "imap.gmail.com",
      "smtpHost": "smtp.gmail.com",
      "status": "active",
      "lastValidatedAt": "2026-08-20T10:00:00Z",
      "lastError": null,
      "createdAt": "2026-08-01T00:00:00Z"
    }
  ],
  "maxMailboxes": 2
}
```

### `POST /api/admin/email-accounts/organization/:orgId`

Registra y prueba un buzón nuevo. Requiere la feature `email_integration`
habilitada para la organización (403 `FEATURE_DISABLED` si no lo está).

**Body** (`emailAddress`, `imapHost`, `imapPort`, `imapSecure`,
`imapUsername`, `imapPassword`, `smtpHost`, `smtpPort`, `smtpSecure`,
`smtpUsername`, `smtpPassword`, `providerLabel` opcional):

```json
{
  "emailAddress": "reservas@clinica.mx",
  "providerLabel": "gmail",
  "imapHost": "imap.gmail.com",
  "imapPort": 993,
  "imapSecure": true,
  "imapUsername": "reservas@clinica.mx",
  "imapPassword": "contraseña-de-aplicación",
  "smtpHost": "smtp.gmail.com",
  "smtpPort": 465,
  "smtpSecure": true,
  "smtpUsername": "reservas@clinica.mx",
  "smtpPassword": "contraseña-de-aplicación"
}
```

Antes de persistir, el servicio abre una conexión IMAP real
(`imapflow.connect()`) y verifica SMTP real
(`nodemailer.createTransport(...).verify()`). Cualquier fallo de conexión
devuelve **400** con un mensaje accionable en español (nunca el stack
crudo del proveedor). Otras respuestas:

- **403** — se alcanzó `max_mailboxes` del plan, o la feature está
  deshabilitada.
- **400** — dirección ya vinculada en esa organización, o body inválido.
- **201** — buzón creado; la respuesta nunca incluye las contraseñas.

### `DELETE /api/admin/email-accounts/organization/:orgId/:accountId`

Desvincula el buzón y elimina el secreto de Vault asociado. **404** si el
buzón no existe o no pertenece a esa organización (incluye intentar
borrarlo con el `orgId` de otra organización — aislamiento multi-tenant).

## 4. Rutas de tool calling (`routes/tools/email.ts`)

Invocadas por el agente de voz/chat (ElevenLabs / Vercel AI SDK), mismo
contrato que el resto de `routes/tools/**`:

- Tenant resuelto por `:webhookToken` en la URL + header `x-tool-secret`
  (`resolveToolOrganization`, `src/lib/tool-auth.ts`) — **nunca** por un
  campo del body que el LLM pueda alucinar.
- **Siempre HTTP 200**, incluso en fallo: la respuesta trae un mensaje
  verbalizable (`"No puedo consultar el correo en este momento, ¿deseas
  que te contacte por otro medio?"`) para que el agente lo diga en voz
  alta en vez de colgar sobre un 500 mudo.
- Timeout duro por operación vía `withToolTimeout()`
  (`TOOL_READ_TIMEOUT_MS` = 3.5 s para `search`/`read`,
  `TOOL_MUTATION_TIMEOUT_MS` = 7.5 s para `dispatch`). Al vencer, no hay
  reintento automático ni corte a mitad de la conexión IMAP/SMTP visible
  para el llamador: la promesa se cancela desde el lado del tool call y la
  ruta responde de inmediato con el mensaje degradado — la conexión
  subyacente puede seguir cerrándose en segundo plano vía el
  `socketTimeout` propio de `imapflow`/`nodemailer` (8 s), pero eso ya no
  bloquea la respuesta HTTP.

**Ejemplo de respuesta degradada** (timeout, credenciales no recuperables,
o cualquier error de conexión — misma forma para las tres rutas, solo
cambia el campo booleano):

```json
{ "found": false, "message": "No puedo consultar el correo en este momento, ¿deseas que te contacte por otro medio?", "messages": [] }
```

```json
{ "dispatched": false, "message": "No se pudo enviar el correo: <razón>", "status": null }
```

### Resolución automática de buzón

Los tres endpoints aceptan `emailAccountId` opcional. Si se omite, la ruta
resuelve el único buzón **activo** de la organización — la mayoría de
organizaciones tienen exactamente uno (los planes bajos limitan a 1-2), así
que el LLM no necesita conocer UUIDs de buzones para el caso común. Con
cero buzones activos o más de uno, degrada con un mensaje pidiendo
especificar cuál usar, en vez de adivinar.

### `POST /tools/:webhookToken/email/search`

```json
{ "subject": "cita", "from": "paciente@ejemplo.com", "since": "2026-08-01T00:00:00Z", "limit": 10 }
```

Devuelve `{ found, message, messages: [{ uid, from, subject, date, snippet }] }`.
Sin filtros, devuelve los correos más recientes del buzón.

### `POST /tools/:webhookToken/email/read`

```json
{ "uid": 4821 }
```

Devuelve `{ found, message, email: { uid, from, to, subject, date, bodyText, truncated } }`.
`bodyText` es texto plano limpio (HTML convertido a texto si el mensaje no
trae parte de texto), truncado a 20 000 caracteres para que el LLM pueda
resumirlo sin saturar memoria (`truncated: true` lo señala). El resumen de
hilos no es una función aparte del backend: el agente recibe el texto
limpio de cada mensaje vía esta ruta y hace la síntesis él mismo, siguiendo
el principio "el LLM traduce, no consulta" que ya rige los reportes en
lenguaje natural (AGENTS.md §18).

### `POST /tools/:webhookToken/email/dispatch`

```json
{
  "idempotencyKey": "conv-abc123-followup",
  "toAddresses": ["paciente@ejemplo.com"],
  "subject": "Confirmación de tu cita",
  "bodyText": "Hola, confirmamos tu cita para el...",
  "isDraft": false
}
```

`idempotencyKey` es **obligatorio** — un reintento del mismo LLM/webhook
con la misma clave nunca produce un segundo envío (`UNIQUE
(organization_id, idempotency_key)` en `email_outbox`). Con
`isDraft: true`, el correo se guarda como borrador (`status: "draft"`) sin
tocar SMTP; con `isDraft: false`, se despacha de inmediato vía
`nodemailer` y se registra `provider_message_id`. Devuelve
`{ dispatched, message, status: "draft" | "sent" | null }`.

## 5. Testing

- `__tests__/email-account-vault.test.ts` — integración real contra
  Supabase Vault (mismo criterio que `secret-service.test.ts`), sin mocks.
- `__tests__/email-account-service.test.ts` — alta/listado/baja contra la
  base real, con `imapflow`/`nodemailer` mockeados (SDKs de terceros
  genuinos, no hay servidor de correo real en el entorno de pruebas).
  Cubre límite de plan, dirección duplicada, fallo IMAP/SMTP y aislamiento
  multi-tenant.
- `__tests__/tools-email.test.ts` — las tres rutas de tool calling:
  autenticación, validación de body, resolución automática de buzón,
  degradación en fallo/timeout, e idempotencia de `dispatch`.
- `__tests__/admin-email-accounts-routes.test.ts` — CRUD administrativo:
  `isPlatformAdmin`, guarda de feature, y aislamiento multi-tenant en
  `DELETE`.

`src/services/email/email-account-vault.ts` y `email-account.service.ts`
están en el tier de **seguridad y aislamiento** de Stryker (≥90% del score
total, sin ramas sin ejercitar); `imap-client.ts`, `smtp-client.ts` y
`email-dispatch.service.ts` en el tier de **servicios de integración**
(≥80%) — ver `stryker.config.json`.

## 6. Limitaciones conocidas

- **Presupuesto de latencia**: AGENTS.md §3 exige p95 < 300 ms en
  `routes/tools/**`. Una conexión IMAP/SMTP efímera a un servidor de
  terceros (handshake TCP+TLS) probablemente lo exceda — es la excepción
  explícita que el propio AGENTS.md prevé ("salvo que sea el propósito
  mismo del tool"). Si el p95 real en producción lo exige, un pool de
  conexiones IMAP por cuenta con idle-timeout corto es el siguiente paso
  natural; no se construyó en esta primera versión.
- **Un buzón ambiguo bloquea la resolución automática**: si una
  organización llega a tener más de un buzón activo, el agente debe recibir
  `emailAccountId` explícito — hoy no hay una heurística de "buzón por
  defecto" más allá de "el único activo".
- **`email_integration` no está asignada a ningún plan por defecto**: hay
  que habilitarla explícitamente por organización o por plan antes de
  poder vincular un buzón (ver §2).
- **`email_accounts.status` no tiene revalidación automática**: se fija en
  `'active'` al crear el buzón (tras validar la conexión) y solo cambia si
  alguien lo actualiza a mano — no existe hoy un job periódico que vuelva a
  probar la conexión y marque `'error'` cuando un proveedor rota o revoca
  una contraseña de aplicación. Hasta que exista, un buzón que deja de
  funcionar seguirá reportándose `'active'` en `GET
  .../email-accounts/organization/:orgId` hasta que un tool call falle en
  producción o alguien lo pruebe manualmente.
- **`EmailSearchFilters.unseenOnly` no está expuesto en `POST
  /tools/:webhookToken/email/search`**: se agregó a `imap-client.ts` para
  que la intención `resumen_correos_recibidos` de reportes en lenguaje
  natural pueda pedir solo correos no leídos, pero `emailSearchBodySchema`
  (`schemas/tool-routes.ts`) no lo incluye todavía — el agente de voz/chat
  no puede pedir "solo no leídos" hoy, solo el reporte en lenguaje natural
  (que llama a `searchInbox` directo, sin pasar por la ruta HTTP).
