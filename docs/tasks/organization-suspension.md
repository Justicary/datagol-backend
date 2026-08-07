# TASK — Suspensión de organización completa y kill switch global (post-migración)

**Proyecto:** `datagol-backend` (Fastify + Node + Supabase)
**Precondición:** `db/migrations/09_organization_suspension.sql` **ya aplicada** contra la base real (columnas `organizations.status`/`suspended_reason`/`suspended_at`, CHECK de `feature_audit_log.action` ampliado con `'suspended'`/`'reactivated'`). No arrancar esta tarea si esa migración no corrió — cada endpoint de aquí depende de que esas columnas existan.
**Referencia obligatoria:** `AGENTS.md` de este repositorio. QA workflow, cobertura y mutation score son requisitos, no sugerencias.
**Contraparte:** `datagol-frontend`, Fase 7 de `docs/tasks/frontend-implementation.md` (consola de superadmin). El frontend se construye en paralelo contra el contrato exacto de este documento — no cambies formas de request/response sin avisar, o los dos lados divergen.

---

## Objetivo y por qué existe esta tarea

Hoy Datagol puede apagar una *feature* para un tenant (`organization_features`) o para todos los tenants a la vez (`features.globally_disabled`, solo lectura — nadie lo escribe todavía). No existe forma de apagar **todo lo que Datagol controla para un cliente específico**: por adeudo, disputa, o cualquier razón a discreción de Datagol.

"Todo lo que Datagol controla" tiene un límite real, no retórico: ElevenLabs y Telnyx corren con las credenciales propias del cliente (modelo DFY, restricción rectora del proyecto). Datagol no puede cortar la llamada de voz en sí. Lo que sí puede cortar — y es donde vive el valor del producto — es la lógica de negocio detrás: agendar citas, guardar leads, consultar disponibilidad, y el procesamiento del webhook de cierre de llamada (que es lo que alimenta el dashboard, `usage_events` y las notificaciones). Esta tarea apaga eso, en el mismo punto donde ya se resuelve el tenant.

---

## Decisiones de diseño ya tomadas (no las re-abras sin avisar)

1. **La suspensión se verifica DESPUÉS de la autenticación, nunca antes.** En `resolveToolOrganization()` y en el webhook de ElevenLabs, el estado `suspended` se comprueba solo una vez que el secreto (`x-tool-secret`) o la firma HMAC ya fueron validados. Comprobarlo antes filtraría a un llamador no autenticado si una organización existe y está suspendida — información que no le corresponde.

2. **No se toca `getOrganizationFeatures()` ni el RPC `organization_enabled_features`.** La resolución de entitlements por feature sigue exactamente igual que hoy. El bloqueo de una organización suspendida vive en dos capas separadas y ya delimitadas: esta tarea (tool-calls + webhook) y el layout del dashboard en el frontend (Fase 7). Mezclarlo con la resolución de features complicaría el caso ya complejo de kill-switch-global + override + plan sin necesidad.

3. **`webhook_token` nunca se devuelve en el listado administrativo.** Es un identificador de enrutamiento, no un secreto de Vault, pero no hay razón para exponerlo en una vista de listado — el patrón ya establecido en el proyecto (`organization_secrets`, `provider_rates`) es "muestra si existe, nunca el valor". `GET /api/admin/organizations` devuelve `webhook_token_present: boolean`.

4. **Bug preexistente a corregir en el mismo cambio:** `services/entitlements.ts` declara su propio `FEATURE_AUDIT_ACTIONS` local (con `OVERRIDDEN`, `KILL_SWITCH_ENGAGED`, `KILL_SWITCH_DISENGAGED`) que **nunca coincidió** con el CHECK real de la base — la fuente de verdad verificada es `types/feature-audit-actions.ts` (solo `ENABLED`/`DISABLED`/`PLAN_CHANGED`, ahora más `SUSPENDED`/`REACTIVATED`). Hoy no truena porque ningún insert usa esos valores inventados, pero es la misma clase de bug que ya costó producción una vez (valores de `action` inventados). Elimina la constante local duplicada de `entitlements.ts` e importa la de `types/feature-audit-actions.ts`.

5. **El kill switch global se audita con los valores de acción que ya existen** (`enabled`/`disabled`), no con uno nuevo — `feature_audit_log.organization_id` es nullable exactamente para este caso (una fila de auditoría que no pertenece a ningún tenant). No hace falta ampliar el CHECK otra vez.

6. **Suspender/reactivar una organización que ya está en ese estado es un 409, no un 200 silencioso** — mismo patrón que `POST .../tokens` en `organization-onboarding.ts` cuando `webhook_token` ya existe.

7. **Fuera de alcance, explícitamente:** modificar `auth_organization_ids()` o cualquier policy de RLS. Esa función vive fuera de este repo (creada directo en Supabase, no está en `db/migrations/`) y su extensión para excluir organizaciones suspendidas se resuelve en otra tarea, una vez que se tenga su definición real. No la toques por iniciativa propia.

---

## 0. `src/types/organization-status.ts` (nuevo)

Falta en el diseño original de este documento: todo campo con `CHECK` en este proyecto tiene su módulo espejo en `src/types/` en ambos repos (`feature-audit-actions.ts`, `lead-enums.ts`, `usage-event-provider.ts`...). `organizations.status` no es la excepción, mirror exacto de `src/types/constraints/organization-status.ts` del frontend:

```ts
/**
 * Valores permitidos por el CHECK constraint `organizations_status_check`.
 * Única fuente de verdad: ningún literal de `status` de organización debe
 * escribirse en otro lugar del código.
 */
export const ORGANIZATION_STATUSES = {
    ACTIVE: 'active',
    SUSPENDED: 'suspended',
} as const;

export type OrganizationStatus = (typeof ORGANIZATION_STATUSES)[keyof typeof ORGANIZATION_STATUSES];

export const ALL_ORGANIZATION_STATUSES: readonly OrganizationStatus[] = Object.values(ORGANIZATION_STATUSES);

export function isOrganizationStatus(value: string): value is OrganizationStatus {
    return (ALL_ORGANIZATION_STATUSES as readonly string[]).includes(value);
}
```

Usar este tipo (no un union inline `'active' | 'suspended'`) en la firma de `setOrganizationStatus()` de §3 y en `AdminOrganizationSummary.status` — el resto del código nunca debe escribir el literal `'suspended'`/`'active'` fuera de este archivo.

## 1. `src/types/feature-audit-actions.ts`

Agregar a la fuente de verdad real:

```ts
export const FEATURE_AUDIT_ACTIONS = {
    ENABLED: 'enabled',
    DISABLED: 'disabled',
    PLAN_CHANGED: 'plan_changed',
    SUSPENDED: 'suspended',
    REACTIVATED: 'reactivated',
} as const;
```

## 2. `src/services/entitlements.ts`

Eliminar el bloque local:

```ts
export const FEATURE_AUDIT_ACTIONS = {
    ENABLED: 'enabled',
    DISABLED: 'disabled',
    OVERRIDDEN: 'overridden',
    KILL_SWITCH_ENGAGED: 'kill_switch_engaged',
    KILL_SWITCH_DISENGAGED: 'kill_switch_disengaged',
    PLAN_CHANGED: 'plan_changed',
} as const;
```

Reemplazar por `import { FEATURE_AUDIT_ACTIONS } from '../types/feature-audit-actions.js';`. Verificar que ningún otro módulo importaba `OVERRIDDEN`/`KILL_SWITCH_ENGAGED`/`KILL_SWITCH_DISENGAGED` desde aquí (`grep -rn "FEATURE_AUDIT_ACTIONS\." src`) antes de borrar — si algo los usa, es la prueba de que este bug ya estaba a punto de manifestarse.

## 3. `src/services/organization-lifecycle.ts` (nuevo)

```ts
import { OrganizationStatus } from '../types/organization-status.js';

export async function setOrganizationStatus(
    organizationId: string,
    status: OrganizationStatus,
    reason: string,
    _changedByUserId?: string
): Promise<{ success: boolean; error?: string }>
```

- `reason` vacío/whitespace → `{ success: false, error: '...' }`, igual que `setOrganizationPlan()`.
- Lee el `status` actual primero. Si ya coincide con el `status` pedido → `{ success: false, error: 'La organización ya está en estado "<status>".' }` (mapea a 409 en la ruta).
- `UPDATE organizations SET status = ..., suspended_reason = (status === 'suspended' ? reason.trim() : null), suspended_at = (status === 'suspended' ? now() : null), updated_at = now() WHERE id = organizationId`.
- Inserta en `feature_audit_log`: `organization_id: organizationId, feature_key: 'organization:status', action: status === 'suspended' ? FEATURE_AUDIT_ACTIONS.SUSPENDED : FEATURE_AUDIT_ACTIONS.REACTIVATED, reason: reason.trim(), previous_value: <status anterior === 'suspended'>, new_value: status === 'suspended'` — mismo truco de `feature_key` sintético que ya usa `setOrganizationPlan()` con `plan:${planKey}`.
- `clearEntitlementsCache(organizationId)` al final, mismo patrón que las otras dos funciones de este archivo (defensa en profundidad — aunque esta tarea no lee `status` desde `getOrganizationFeatures()`, no cuesta nada invalidar).
- Si el insert de auditoría falla, revertir el `UPDATE` (mismo patrón de rollback manual que `setFeatureOverride()`).

```ts
export interface AdminOrganizationSummary {
    id: string;
    name: string;
    email: string | null;
    plan_key: string | null;
    status: OrganizationStatus;
    suspended_reason: string | null;
    suspended_at: string | null;
    kyc_status: string | null;
    max_concurrent_calls: number | null;
    webhook_token_present: boolean;
    agent_reprovision_pending: boolean;
    created_at: string | null;
}

export async function listOrganizationsForAdmin(): Promise<AdminOrganizationSummary[]>
```

`SELECT id, name, email, plan_key, status, suspended_reason, suspended_at, kyc_status, max_concurrent_calls, webhook_token, agent_reprovision_pending, created_at FROM organizations ORDER BY created_at DESC NULLS LAST`, mapear `webhook_token` a `webhook_token_present: webhook_token !== null` y **no incluir `webhook_token` crudo en el objeto devuelto**.

## 4. `src/lib/tool-auth.ts`

Ampliar `ToolAuthResult`:

```ts
export type ToolAuthResult =
    | { ok: true; organizationId: string; calEventTypeId: number | null }
    | { ok: false; reason: 'invalid_token'; message: string }
    | { ok: false; reason: 'missing_secret'; message: string }
    | { ok: false; reason: 'suspended'; message: string };
```

En `resolveToolOrganization`: agregar `status` al `.select('id, cal_event_type_id, status')`. Tras la comparación de `x-tool-secret` (no antes, ver decisión 1), si `org.status === 'suspended'` devolver `{ ok: false, reason: 'suspended', message: 'Esta organización tiene su implementación suspendida.' }`.

## 5. `src/routes/tools/{booking,reschedule,availability}.ts`

Los tres tienen hoy:

```ts
if (!auth.ok) {
    request.log.warn({ reason: auth.reason, route: '...', msg: 'Tool call rechazado' });
    return reply.status(401).send({ error: 'Unauthorized', message: auth.message });
}
```

Cambiar a:

```ts
if (!auth.ok) {
    const statusCode = auth.reason === 'suspended' ? 403 : 401;
    request.log.warn({ reason: auth.reason, route: '...', msg: 'Tool call rechazado' });
    return reply.status(statusCode).send({
        error: statusCode === 403 ? 'Forbidden' : 'Unauthorized',
        message: auth.message,
    });
}
```

## 6. `src/routes/webhooks/elevenlabs.ts`

En la consulta de la línea ~63-67, ampliar a `.select('id, status')`. Después de que `verification.valid` sea `true` (no antes — mismo motivo que en tool-auth), si `org.status === 'suspended'`:

```ts
request.log.warn({ organizationId, msg: 'Webhook de ElevenLabs rechazado: organización suspendida' });
return reply.status(403).send({ error: 'Forbidden', message: 'Esta organización tiene su implementación suspendida.' });
```

Antes de insertar en `webhook_events` y de encolar el job — una organización suspendida no debe generar ni `call_logs` ni `usage_events` nuevos.

## 7. `src/routes/admin/organizations.ts` (nuevo)

Mismo patrón que `admin/features.ts`: `fastify.addHook('preHandler', isPlatformAdmin)`.

#### `GET /api/admin/organizations`

```ts
{ organizations: AdminOrganizationSummary[] }
```

#### `POST /api/admin/organizations/:orgId/suspend`

Body: `{ reason: string }`. `reason` faltante/vacío → 400. Ya suspendida → 409. Éxito → 200:

```ts
{ message: string, organization: { id: string, status: 'suspended', suspended_reason: string, suspended_at: string } }
```

#### `POST /api/admin/organizations/:orgId/reactivate`

Body: `{ reason: string }` (se audita igual que la suspensión — por qué se reactivó importa tanto como por qué se suspendió). Ya activa → 409. Éxito → 200, misma forma con `status: 'active'`, `suspended_reason: null`, `suspended_at: null`.

## 8. `src/routes/admin/features.ts`

Agregar:

#### `POST /api/admin/features/:featureKey/kill-switch`

Body: `{ globally_disabled: boolean, reason: string }`. `reason` obligatorio (mismo criterio que el resto de este archivo). `UPDATE features SET globally_disabled = ..., disabled_reason = (globally_disabled ? reason : null) WHERE key = featureKey`. Si `featureKey` no existe → 404. Auditar en `feature_audit_log` con `organization_id: null, feature_key: featureKey, action: globally_disabled ? FEATURE_AUDIT_ACTIONS.DISABLED : FEATURE_AUDIT_ACTIONS.ENABLED, reason`. Invalidar `clearEntitlementsCache()` (sin argumento — afecta a todos los tenants, hay que limpiar todo el caché, no uno).

---

## Pruebas obligatorias

Patrón ya establecido en `__tests__/entitlements.test.ts` — contra organización real de pruebas, `vi.spyOn` solo para simular ausencia/presencia, no mockear Supabase completo.

- `resolveToolOrganization`: organización suspendida + secreto válido → `reason: 'suspended'`. Organización suspendida + secreto inválido → `reason: 'missing_secret'` (el secreto se evalúa primero, no se filtra el estado de suspensión a un llamador no autenticado — verificar explícitamente este orden). Organización activa + secreto válido → `ok: true` (contraparte de éxito).
- Los tres tool routes: organización suspendida → 403 con `error: 'Forbidden'`. Organización activa → comportamiento normal sin cambios (contraparte de éxito, ya cubierta por tests existentes — no reescribirlos, solo confirmar que siguen pasando).
- Webhook de ElevenLabs: organización suspendida + firma válida → 403, **sin** insert en `webhook_events` ni job encolado (verificar con spy que `supabaseAdmin.from('webhook_events').insert` no se llama). Organización activa + firma válida → sigue funcionando igual (contraparte de éxito).
- `setOrganizationStatus()`: `reason` vacío → falla, no escribe. Suspender organización activa → éxito, columnas correctas, fila en `feature_audit_log` con `action: 'suspended'`. Reactivar organización suspendida → éxito, columnas limpias, `action: 'reactivated'`. Suspender una ya suspendida → falla con mensaje claro, no lanza excepción no controlada. Fallo simulado en el insert de auditoría → el `UPDATE` se revierte (mismo test que ya existe para `setFeatureOverride()`, replicar el patrón).
- `POST .../suspend` y `.../reactivate`: sin `reason` → 400. Estado repetido → 409. Llamador que no es platform admin → 401/403 (el `preHandler` ya está probado en otro archivo, basta un test de humo por ruta nueva).
- `POST .../kill-switch`: togglear `globally_disabled: true` en una feature → dos organizaciones de prueba distintas (una con la feature por plan, otra por override) pierden la feature en `getOrganizationFeatures()`. Togglear a `false` → ambas la recuperan según su origen original (contraparte de éxito). `featureKey` inexistente → 404.
- Aislamiento: `GET /api/admin/organizations` nunca incluye `webhook_token` crudo en la respuesta — test explícito sobre la forma del JSON, no solo sobre el campo `webhook_token_present`.

Umbrales de `AGENTS.md` §10/§11: esto toca autenticación y control de acceso por tenant — categoría "seguridad y aislamiento", mutation score ≥90% medido contra el total, no contra código cubierto.

---

## Qué NO hacer

- No verificar `status` antes de validar el secreto (`x-tool-secret`) o la firma HMAC del webhook — se filtraría el estado de suspensión a un llamador no autenticado.
- No usar `OVERRIDDEN`/`KILL_SWITCH_ENGAGED`/`KILL_SWITCH_DISENGAGED` en ningún insert — nunca fueron valores válidos del CHECK real y no existen tras el arreglo del bug de §2.
- No modificar `getOrganizationFeatures()`, el RPC `organization_enabled_features`, ni ninguna policy de RLS en esta tarea — decisiones 2 y 7.
- No exponer `organizations.webhook_token` crudo en `GET /api/admin/organizations` — solo `webhook_token_present`.
- No permitir suspender/reactivar sin `reason`, ni tratar un estado repetido como éxito silencioso (409, no 200).
- No dejar código muerto de la constante `FEATURE_AUDIT_ACTIONS` duplicada en `entitlements.ts` — se elimina, no se comenta.
