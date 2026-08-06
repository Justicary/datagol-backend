# TASK — Endpoints de onboarding de organización (self-service DFY)

**Proyecto:** `datagol-backend` (Fastify + Node + Supabase)
**Precondición:** `docs/tasks/backend-implementation.md` (Fases 1–6) completado — en particular Fase 1.6 (módulo de entitlements: `services/entitlements.ts`, `plugins/entitlements.ts`) y Fase 1.4 (`services/secret-service.ts`).
**Referencia obligatoria:** `AGENTS.md` de este repositorio. QA workflow, cobertura y mutation score son requisitos, no sugerencias.
**Contraparte:** `datagol-frontend`, Fase 4 de `docs/tasks/frontend-implementation.md` (wizard de onboarding de 6 pasos). El frontend se está construyendo contra el contrato exacto de este documento — no lo cambies sin avisar, o los dos lados divergen.

---

## Objetivo y por qué existe esta tarea

El wizard de onboarding del frontend (`OnboardingWizard.tsx`) hoy llama a `POST /api/organizations/onboard`, un endpoint legacy en `src/routes/organization.ts` (líneas ~504–656) que:

- Inserta en columnas que no existen (`contact_name`, `vapi_private_key`, `vapi_first_message`, etc. — el esquema real solo tiene columnas `deprecated_vapi_*`).
- Registra el agente contra `https://api.vapi.ai/assistant` — Vapi es proveedor descartado, todo lo demás en este backend está construido alrededor de ElevenLabs.
- No genera `webhook_token` ni los secretos de Vault, no toca `plan_key`, no escribe credenciales, no valida nada de readiness.

Nunca funcionó correctamente contra el esquema real. Esta tarea lo reemplaza por un conjunto de endpoints que sí escriben contra columnas y mecanismos reales (`organization_secrets`/Vault vía `setSecret`, `plans`/`plan_features` vía `setOrganizationPlan`), siguiendo el patrón de autenticación y validación que ya usa el resto del código nuevo del proyecto (`fastify.supabaseUser(jwt)`, Zod, `request.log`) — no el patrón del archivo legacy que reemplazan.

---

## Decisiones de diseño ya tomadas (no las re-abras sin avisar)

1. **Autenticación/pertenencia:** no existe en este repo un middleware de "¿este usuario pertenece a esta organización?". El patrón real es `fastify.supabaseUser(jwt)` (decorador ya registrado en `plugins/supabase.ts`, crea un cliente con el JWT del usuario final que respeta RLS). Todo endpoint nuevo que opera sobre una organización **ya existente** debe verificar pertenencia haciendo un `SELECT` con ese cliente (RLS deniega si no es miembro) antes de escribir con `supabaseAdmin`. No inventes un chequeo manual de `organization_members`.

2. **Creación de organización es la única excepción:** al crear la organización todavía no hay fila en `organization_members`, así que no hay RLS que la proteja. Solo se exige un JWT válido (usuario autenticado), y el endpoint mismo crea la membresía `owner` como parte de la misma operación.

3. **Credenciales de proveedor van solo a Vault, nunca a las columnas planas.** `organizations.elevenlabs_api_key`/`telnyx_api_key`/`cal_api_key`/`whatsapp_access_token` son el estado *pre-migración* que Fase 1.4 de `backend-implementation.md` ya dejó documentado como destinado a `scripts/migrate-secrets.ts`. No repitas el patrón viejo escribiendo ahí — usa `setSecret()`.

4. **`webhook_token` (columna plana) vs `webhook_signing_secret`/`tool_webhook_secret` (Vault) son mecanismos distintos** — el primero es un identificador de enrutamiento en la URL, los otros dos son secretos de firma. El endpoint de tokens genera y persiste los tres juntos, pero por dos vías distintas.

5. **Generador de valores aleatorios:** `crypto.randomBytes(32).toString('hex')` — es el único patrón usado en `scripts/provision-org-secrets.ts`, replícalo exactamente. No uses `crypto.randomUUID()` para esto.

6. **Los tokens no se regeneran por accidente.** Si `organizations.webhook_token` ya tiene valor, el endpoint de generación responde `409`, no sobreescribe. Sobreescribir rompe una integración ya configurada en el dashboard de ElevenLabs del cliente.

7. **`"whatsapp"` se añade a `FEATURE_KEYS` en `feature-taxonomy.ts`.** Existe como fila real en `features` y ya se usa como literal suelto en `__tests__/entitlements.test.ts` y en la Fase 3 del frontend — formalízalo en el catálogo TypeScript en vez de dejarlo como literal disperso.

8. **Nueva columna `organizations.agent_reprovision_pending`.** No existe ningún campo hoy que represente "el agente en el proveedor de voz quedó desincronizado de los entitlements vigentes". Se agrega vía migración, se marca `true` al cambiar plan o features, y `reprovisionAgent()` la limpia al terminar. Es lo único que hace verificable el criterio de readiness "agente sin marca de reprovisión pendiente" — sin la columna, esa frase del documento del frontend no tiene ningún dato real detrás.

9. **Fuera de alcance, explícitamente:** sincronizar el contenido de la base de conocimiento hacia la KB nativa de ElevenLabs. Es una integración real contra la API de ElevenLabs que no existe hoy en ningún lugar del código. El paso 5 del wizard del frontend sigue usando el endpoint de `knowledge_base` de Supabase que ya existe (`POST /api/organizations/:id/knowledge`, que sí sobrevive de `organization.ts` — no lo toques). No fabriques una llamada a una API que no está integrada.

10. **`reprovisionAgent()` sigue siendo el stub que ya es** (actualiza `updated_at`, no llama a la API real de ElevenLabs todavía). No es parte de esta tarea completarlo — eso es un hueco conocido y preexistente del proyecto. Esta tarea solo le agrega la limpieza de la marca `agent_reprovision_pending` al final de su ejecución exitosa.

---

## Archivos a crear/modificar, en orden

### 1. Migración — nueva columna

`db/migrations/0X_agent_reprovision_pending.sql` (usa el siguiente número disponible en la carpeta):

```sql
ALTER TABLE organizations
  ADD COLUMN agent_reprovision_pending boolean NOT NULL DEFAULT false;
```

### 2. `src/types/feature-taxonomy.ts`

Agregar `WHATSAPP: 'whatsapp'` a `FEATURE_KEYS`, siguiendo el patrón existente de las otras dos entradas.

### 3. `src/services/secret-service.ts`

Nueva función — **sin tocar Vault**, solo existencia y fecha de rotación:

```ts
export async function listSecretStatus(
    organizationId: string
): Promise<Record<string, { present: boolean; rotatedAt: string | null }>>
```

Implementación: `SELECT secret_key, rotated_at FROM organization_secrets WHERE organization_id = $1`, mapeado a un objeto `{ [secret_key]: { present: true, rotatedAt } }`. Las claves ausentes en el resultado no aparecen en el objeto (el llamador decide qué claves espera y las trata como `present: false` si faltan).

### 4. `src/services/entitlements.ts`

En `setOrganizationPlan()` y en `setFeatureOverride()`: justo antes de la llamada existente a `reprovisionAgent()` (o en el mismo punto donde hoy se dispara), marcar `agent_reprovision_pending = true` en el `UPDATE` de `organizations` correspondiente (puede ir en el mismo `UPDATE` que ya hace `setOrganizationPlan` para `plan_key`/`max_concurrent_calls`; en `setFeatureOverride` habrá que agregar un `UPDATE` dedicado si hoy no actualiza `organizations`).

### 5. `src/services/agent-provisioning.ts`

En `reprovisionAgent()`, el `UPDATE organizations` que hoy solo toca `updated_at` debe además poner `agent_reprovision_pending: false`. Si el `UPDATE` falla (rama `if (error)` ya existente), la marca **no** se limpia — el `return { success: false, ... }` ya cubre ese caso correctamente, solo asegúrate de que el `false` de la marca esté dentro del mismo `UPDATE` que puede fallar, no en uno separado que pueda tener éxito aunque el primero falle.

### 6. `src/schemas/organization-onboarding.ts` (nuevo)

Un schema Zod de body/response por endpoint (ver contratos exactos abajo). Sigue el estilo de `src/schemas/tool-routes.ts`, no el de `organization.ts`.

### 7. `src/routes/organization-onboarding.ts` (nuevo)

Registrar en `src/app.ts` junto a los demás `await app.register(...)`, como `organizationOnboardingRoutes`.

#### `POST /api/organizations`

Auth: `Authorization: Bearer <jwt>` de un usuario autenticado (sin membresía previa).

Request:
```ts
{ name: string; email: string; phone_number?: string }
```

Respuesta 201:
```ts
{ success: true; data: { id: string; name: string; email: string } }
```

Comportamiento:
1. Extraer y validar el JWT (`fastify.supabaseUser` o el decorador que ya exista para obtener el `user.id`).
2. `supabaseAdmin.from('organizations').insert(...)`.
3. `supabaseAdmin.from('organization_members').insert({ organization_id, user_id, role: 'owner' })`.
4. **Atomicidad obligatoria:** si el paso 3 falla, el registro de `organizations` creado en el paso 2 debe eliminarse antes de responder (no dejar una organización huérfana sin dueño). Si tienes tiempo, hazlo como función Postgres transaccional (`create_organization_with_owner(...)`) vía migración; si no, un `delete` compensatorio en el `catch` es aceptable pero debe quedar comentado como tal.

#### `PATCH /api/organizations/:id/business-info`

Auth: Bearer JWT, miembro de `:id` (verificar con `fastify.supabaseUser(jwt)` antes de escribir con `supabaseAdmin`).

Request (todos opcionales, solo se actualiza lo presente):
```ts
{
  name?: string;
  address?: string;
  city?: string;
  state?: string;
  postal_code?: string;
  latitude?: number;
  longitude?: number;
  business_hours?: Record<string, unknown>;
}
```

`business_hours` **no es columna propia** — se guarda dentro de `organizations.integration_settings.business_hours` (ese jsonb ya contiene `theme`, escrito por el frontend en Fases 2/3). Debe hacerse un merge (`integration_settings || jsonb_build_object('business_hours', ...)` en SQL, o leer-modificar-escribir desde el service) — un `update` que reemplace todo el objeto `integration_settings` borraría el tema guardado.

Respuesta 200: `{ success: true; data: { ...campos actualizados... } }`.

#### `PATCH /api/organizations/:id/plan`

Auth: igual que arriba.

Request: `{ plan_key: string; reason: string }` → delega en `setOrganizationPlan(id, plan_key, reason, userId)` ya existente. `userId` sale del JWT verificado, no del body.

Respuesta: el mismo `{ success: boolean; error?: string }` que ya devuelve la función. `400` si `success: false`.

#### `POST /api/organizations/:id/credentials`

Auth: igual que arriba. **Nunca loguear el valor** (regla ya vigente en `AGENTS.md` de este repo).

Request:
```ts
{ provider: 'elevenlabs' | 'telnyx' | 'meta' | 'cal'; value: string }
```

Mapeo `provider → SecretKey` — **igual al que ya usa `checkProviderCredentials()`**, no inventes uno nuevo:
```
elevenlabs → SECRET_KEYS.ELEVENLABS_API_KEY
telnyx     → SECRET_KEYS.TELNYX_API_KEY
meta       → SECRET_KEYS.WHATSAPP_ACCESS_TOKEN
cal        → SECRET_KEYS.CAL_API_KEY
```

→ `setSecret(id, secretKey, value)`.

Respuesta 200: `{ success: true }` — **nunca** devolver `value` de vuelta, ni en este endpoint ni en ningún log.

#### `GET /api/organizations/:id/credentials/status`

Auth: igual que arriba.

→ `listSecretStatus(id)` (nueva, punto 3).

Respuesta 200:
```ts
{
  success: true;
  data: Record<string, { present: boolean; rotatedAt: string | null }>;
}
```

#### `POST /api/organizations/:id/tokens`

Auth: igual que arriba. Sin body.

Comportamiento:
1. Leer `organizations.webhook_token` actual. Si ya tiene valor → **409**, `{ success: false, error: 'Los tokens ya fueron generados para esta organización.' }`.
2. Generar tres valores con `crypto.randomBytes(32).toString('hex')`.
3. `UPDATE organizations SET webhook_token = ...`.
4. `setSecret(id, SECRET_KEYS.WEBHOOK_SIGNING_SECRET, ...)`, `setSecret(id, SECRET_KEYS.TOOL_WEBHOOK_SECRET, ...)`.

Respuesta 201:
```ts
{
  success: true;
  data: {
    webhookToken: string;
    webhookSigningSecret: string;
    toolWebhookSecret: string;
  };
}
```

Estos tres valores **no vuelven a ser legibles** por ningún endpoint después de esta respuesta (`credentials/status` solo informa `present`, nunca el valor). El frontend debe advertir esto antes de que el usuario navegue fuera del paso.

#### `POST /api/organizations/:id/provision-agent`

Auth: igual que arriba. Sin body. → `reprovisionAgent(id)` (ya limpia la marca por el cambio del punto 5).

Respuesta: `{ success: boolean; toolsCount: number }` (igual a la firma ya existente).

#### `GET /api/organizations/:id/readiness`

Auth: igual que arriba.

Comportamiento — construir sobre lo ya existente, no reimplementar:
- `plan_key` de `organizations`.
- Tokens: `webhook_token` (columna) + `listSecretStatus(id)` para `webhook_signing_secret`/`tool_webhook_secret`.
- Credenciales por feature: para cada feature en `getOrganizationFeatures(id)` (ya existente), correr `checkProviderCredentials(id, featureKey)`; acumular las que fallen.
- `agent_reprovision_pending` de `organizations`.

Respuesta 200:
```ts
{
  success: true;
  data: {
    ready: boolean;
    planKey: string | null;
    missingTokens: Array<'webhook_token' | 'webhook_signing_secret' | 'tool_webhook_secret'>;
    missingCredentials: Array<{ feature: string; provider: string; missingSecret: string }>;
    agentReprovisionPending: boolean;
  };
}
```

`ready = planKey !== null && missingTokens.length === 0 && missingCredentials.length === 0 && !agentReprovisionPending`.

### 8. `src/routes/organization.ts`

Eliminar el bloque completo del endpoint legacy `POST /api/organizations/onboard` (líneas ~504–656 a la fecha de este documento) y su registro. No lo dejes como código muerto ni detrás de un flag — ya no lo llama nadie una vez que el frontend migre a los endpoints nuevos. El resto del archivo (`knowledge`, `knowledge/search`, CRUD de organización) no se toca en esta tarea.

---

## Pruebas obligatorias

Sigue el patrón ya establecido en `__tests__/entitlements.test.ts` (Vitest, contra organización real de pruebas, `vi.spyOn` solo donde haga falta simular ausencia/presencia de credenciales — no mockees Supabase completo).

- `POST /api/organizations` sin JWT → 401. Con JWT válido → crea organización y la membresía `owner` en la misma operación (contraparte de éxito).
- Fallo simulado en la inserción de `organization_members` → no queda una fila huérfana en `organizations`.
- `PATCH .../business-info` de un usuario que no pertenece a la organización → RLS lo bloquea (0 filas afectadas o error), no un 200 silencioso.
- `PATCH .../business-info` con `business_hours` no debe borrar `integration_settings.theme` ya existente.
- `POST .../credentials` — el body nunca aparece en la respuesta ni en los logs de la prueba (verificar que el mock/spy de `request.log` no reciba el valor).
- `POST .../tokens` — primera llamada genera y persiste los tres valores; segunda llamada sobre la misma organización → 409, valores no cambian.
- `GET .../credentials/status` — nunca hace un `getSecret()` real (verificar con spy que solo se consulta `organization_secrets`, no Vault).
- `GET .../readiness` — organización recién creada (sin plan, sin tokens, sin credenciales) → `ready: false` con las tres listas de faltantes pobladas. Organización completamente configurada → `ready: true` (contraparte de éxito).
- `setOrganizationPlan()`/`setFeatureOverride()` dejan `agent_reprovision_pending = true`; `reprovisionAgent()` la limpia tras éxito, la deja intacta tras fallo.
- Aislamiento multi-tenant en los seis endpoints nuevos: una request autenticada como usuario del tenant A sobre `:id` del tenant B es rechazada — es la prueba obligatoria más importante de este documento, no la omitas en ninguno de los endpoints con `:id`.

Umbrales de `AGENTS.md` §10/§11: estos endpoints tocan autenticación, aislamiento multi-tenant y secretos — categoría "seguridad y aislamiento", mutation score ≥90% medido contra el total, no contra código cubierto.

---

## Qué NO hacer

- No escribir credenciales de proveedor en las columnas planas de `organizations` (`elevenlabs_api_key`, etc.) — solo Vault vía `setSecret()`.
- No devolver `webhook_signing_secret` ni `tool_webhook_secret` en ningún endpoint que no sea la respuesta inmediata de `POST .../tokens`.
- No sobreescribir tokens ya generados sin que el endpoint responda 409 primero.
- No replicar el patrón de `organization.ts` (sin Zod, sin verificación de pertenencia, `supabaseAdmin` directo con `:id` del path sin filtrar).
- No implementar la sincronización con la KB nativa de ElevenLabs — fuera de alcance, ver decisión 9.
- No completar la integración real de `reprovisionAgent()` con la API de ElevenLabs — fuera de alcance, ver decisión 10.
- No cerrar la tarea sin la prueba de aislamiento multi-tenant en cada endpoint nuevo.
