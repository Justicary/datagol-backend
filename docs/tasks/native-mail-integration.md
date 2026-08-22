# TAREA: Implementación de Integración de Correo Nativa ($0 USD APIs Intermedias)

Implementa el módulo de gestión de correo electrónico multitenant en Fastify y Supabase para permitir a las organizaciones vincular buzones (según el plan contratado) y habilitar los 3 casos de uso: Búsqueda/Lectura bajo demanda, Resúmenes de hilos y Envío/Borradores de correos.

## 1. Reglas de Arquitectura y Cumplimiento (`AGENTS.md`)
- **Multi-Tenancy y Aislamiento**: Todas las operaciones resuelven el `organization_id` desde el plugin de contexto o sesión (`request.organizationId`). Prohibido leer `organization_id` del cuerpo en rutas administrativas.
- **Seguridad de Credenciales**: Las contraseñas IMAP/SMTP y credenciales se persisten de forma cifrada mediante el servicio existente de `organization_secrets` (o mediante vault/AES-256). Prohibido almacenar contraseñas en texto claro.
- **Entitlements**: Validar la cantidad máxima de cuentas permitidas consultando `organizations.plan_key` y la configuración de límites de buzones en `plans`. Rechazar con HTTP 403 y mensaje accionable si se excede el cupo.
- **Esquemas Zod Obligatorios**: Toda ruta debe declarar esquemas Zod estrictos para `body`, `params`, `querystring` y `response`. Tipado estricto (cero `any`).
- **Dependencias**: Instalar y utilizar `imapflow` (cliente IMAP moderno y ligero) y `nodemailer` (cliente SMTP) mediante `pnpm add imapflow nodemailer` y sus tipos `@types/nodemailer`.

## 2. Definición del Servicio (`src/services/email/email-account.service.ts`)
Implementa las siguientes funciones puras y desacopladas:
1. `validateAndSaveAccount(orgId: string, payload: EmailAccountConfig)`:
   - Valida la conexión contra el servidor IMAP y SMTP antes de persistir.
   - Verifica que el número de buzones actuales no exceda el límite del `plan_key` de la organización.
   - Guarda los metadatos públicos (email, host, provider) en `organizations.integration_settings->'email_accounts'`.
   - Guarda las credenciales cifradas (usuario, password de aplicación, puertos) en `organization_secrets` con clave única `email_creds_<account_id>`.
2. `searchInbox(orgId: string, accountId: string, filters: EmailSearchFilters)`:
   - Abre conexión efímera vía `imapflow` al buzón del tenant.
   - Realiza búsqueda por asunto, remitente o rango de fechas (resuelto en la zona horaria `organizations.timezone`).
   - Retorna lista estructurada de mensajes (UID, remitente, asunto, fecha, snippet).
3. `getMessageDetail(orgId: string, accountId: string, uid: string)`:
   - Descarga el cuerpo del correo (texto/HTML limpio) para que el servicio LLM pueda generar minutas o resúmenes sin saturar memoria.
4. `sendEmail(orgId: string, fromAccountId: string, emailData: SendEmailPayload)`:
   - Recupera credenciales SMTP de `organization_secrets`.
   - Si `is_draft` es verdadero, guarda el borrador como registro temporal o nota.
   - Si `is_draft` es falso, despacha el correo vía `nodemailer` y registra el evento en logs estructurados.

## 3. Controladores y Rutas (`src/routes/admin/email-accounts.ts` y `src/routes/tools/email.ts`)
- **Rutas Admin (Dashboard)**:
  * `GET /api/admin/email-accounts`: Lista buzones vinculados y cupo disponible por plan.
  * `POST /api/admin/email-accounts`: Registra y prueba un nuevo buzón IMAP/SMTP.
  * `DELETE /api/admin/email-accounts/:accountId`: Desvincula cuenta y elimina secretos asociados.
- **Rutas de Tools (LLM Tool Calling)**:
  * `POST /api/tools/email/search`: Endpoint para búsqueda de correos invocable por OpenRouter / Vercel AI SDK.
  * `POST /api/tools/email/read`: Endpoint para obtener contenido de un correo por UID.
  * `POST /api/tools/email/dispatch`: Endpoint para crear borrador o despachar el correo hacia un prospecto (`contacts.email` / `leads.email`).

## 4. Testing y Validación
- Crear pruebas unitarias e integración en `__tests__/services/email-account.test.ts` con Vitest utilizando mocks para IMAP y SMTP.
- Asegurar aislamiento multi-tenant: una organización A no puede leer buzones ni despachar correos con credenciales de la organización B.
- Ejecutar `pnpm type-check` y `pnpm test` garantizando 0 errores de compilación.

## 5.- Documentación
Debido a que esta es una 'mayor feature' es importante documentarla utilizando el skill 'doc-coauthoring' para asegurar una documentación completa y bien estructurada.
- Crea la documentación final en `docs/mail-integration.md` con las nuevas rutas y herramientas y si es crees necesario actualiza `AGENTS.md` con la nueva feature.