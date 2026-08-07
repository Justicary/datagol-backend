-- =============================================================================
-- DATAGOL 2026 — Migración de Base de Datos SQL
-- =============================================================================
-- Cierre del hueco de RLS descubierto durante la Fase 7 (suspensión de
-- organización, docs/tasks/organization-suspension.md). Dos hallazgos
-- distintos, cerrados juntos porque ambos giran en torno a `organizations`
-- y a las políticas que hoy dependen de `auth_organization_ids()`
-- (definición verificada contra la base real antes de escribir esto):
--
--   select organization_id from organization_members where user_id = auth.uid();
--
-- 1. `auth_organization_ids()` no filtra por `status`: un usuario de una
--    organización suspendida sigue leyendo (y en las tablas `tenant_isolation`
--    con cmd ALL, también escribiendo) `leads`, `call_logs`, `appointments`,
--    `knowledge_base`, `contacts`, `usage_events`, `webhook_events` y
--    `organization_features` vía Supabase directo desde el navegador, aunque
--    `dashboard/layout.tsx` ya bloquee la UI de Next.js. Ese bloqueo es solo
--    de interfaz — exactamente lo que AGENTS.md prohíbe como control de
--    acceso real.
--
--    No se modifica `auth_organization_ids()` en sí: la política
--    `org_self_access` de `organizations` la reutiliza (`id IN
--    (SELECT auth_organization_ids())`, cmd ALL — verificado vía
--    pg_policies), y si excluyera organizaciones suspendidas, la propia fila
--    de `organizations` desaparecería para sus miembros. La pantalla "Cuenta
--    suspendida: <motivo>" de `SuspendedOrganizationScreen` (frontend)
--    depende de poder leer esa fila — sin ella degrada en silencio a un
--    mensaje genérico de "sin organización" que no explica nada.
--
--    Se crea `auth_active_organization_ids()`, un espejo que además exige
--    `status = 'active'`, y se migran a ella TODAS las políticas de tablas
--    de datos de tenant EXCEPTO `organizations.org_self_access`, que sigue
--    resuelta por `auth_organization_ids()` sin filtrar a propósito.
--
-- 2. `organizations.org_self_access` es `cmd: ALL` sin restricción de
--    columnas: cualquier miembro puede hoy hacer `UPDATE` directo vía
--    supabase-js sobre CUALQUIER columna de su propia fila — incluida
--    `status`. Un cliente suspendido podría reactivarse a sí mismo con una
--    llamada desde devtools, sin pasar por el backend ni dejar auditoría en
--    `feature_audit_log`. Vuelve inútil la suspensión completa si no se
--    cierra. `src/app/dashboard/settings/page.tsx` (frontend, Fase 5.5) sí
--    necesita poder escribir `name`, `phone_number`,
--    `silence_timeout_seconds` y `max_call_duration_seconds` — verificado
--    que es el único código del frontend que escribe `organizations`
--    directo (sin INSERT ni DELETE en ningún lugar). El privilegio se
--    restringe a exactamente esas cuatro columnas vía GRANT a nivel de
--    columna; no se retira el UPDATE por completo.
-- =============================================================================

CREATE OR REPLACE FUNCTION public.auth_active_organization_ids()
RETURNS SETOF uuid
LANGUAGE sql
STABLE SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $function$
  select om.organization_id
  from organization_members om
  join organizations o on o.id = om.organization_id
  where om.user_id = auth.uid()
    and o.status = 'active';
$function$;

COMMENT ON FUNCTION public.auth_active_organization_ids() IS
    'Igual que auth_organization_ids() pero excluye organizaciones suspendidas (status <> ''active''). Usada por toda política de tenant EXCEPTO organizations.org_self_access — esa debe seguir viendo la fila de la propia organización aunque esté suspendida, para que el frontend pueda mostrar el motivo.';

-- appointments
DROP POLICY IF EXISTS tenant_isolation ON public.appointments;
CREATE POLICY tenant_isolation ON public.appointments
    FOR ALL
    USING (organization_id IN (SELECT auth_active_organization_ids()))
    WITH CHECK (organization_id IN (SELECT auth_active_organization_ids()));

-- call_logs
DROP POLICY IF EXISTS tenant_isolation ON public.call_logs;
CREATE POLICY tenant_isolation ON public.call_logs
    FOR ALL
    USING (organization_id IN (SELECT auth_active_organization_ids()))
    WITH CHECK (organization_id IN (SELECT auth_active_organization_ids()));

-- contacts
DROP POLICY IF EXISTS tenant_isolation ON public.contacts;
CREATE POLICY tenant_isolation ON public.contacts
    FOR ALL
    USING (organization_id IN (SELECT auth_active_organization_ids()))
    WITH CHECK (organization_id IN (SELECT auth_active_organization_ids()));

-- knowledge_base
DROP POLICY IF EXISTS tenant_isolation ON public.knowledge_base;
CREATE POLICY tenant_isolation ON public.knowledge_base
    FOR ALL
    USING (organization_id IN (SELECT auth_active_organization_ids()))
    WITH CHECK (organization_id IN (SELECT auth_active_organization_ids()));

-- leads
DROP POLICY IF EXISTS tenant_isolation ON public.leads;
CREATE POLICY tenant_isolation ON public.leads
    FOR ALL
    USING (organization_id IN (SELECT auth_active_organization_ids()))
    WITH CHECK (organization_id IN (SELECT auth_active_organization_ids()));

-- feature_audit_log (conserva el fallback OR is_platform_admin())
DROP POLICY IF EXISTS audit_read ON public.feature_audit_log;
CREATE POLICY audit_read ON public.feature_audit_log
    FOR SELECT
    USING ((organization_id IN (SELECT auth_active_organization_ids())) OR is_platform_admin());

-- organization_features (conserva el fallback OR is_platform_admin())
DROP POLICY IF EXISTS tenant_read_features ON public.organization_features;
CREATE POLICY tenant_read_features ON public.organization_features
    FOR SELECT
    USING ((organization_id IN (SELECT auth_active_organization_ids())) OR is_platform_admin());

-- organization_members
DROP POLICY IF EXISTS members_self_access ON public.organization_members;
CREATE POLICY members_self_access ON public.organization_members
    FOR SELECT
    USING (organization_id IN (SELECT auth_active_organization_ids()));

-- usage_events
DROP POLICY IF EXISTS tenant_read_usage ON public.usage_events;
CREATE POLICY tenant_read_usage ON public.usage_events
    FOR SELECT
    USING (organization_id IN (SELECT auth_active_organization_ids()));

-- webhook_events
DROP POLICY IF EXISTS tenant_read_webhooks ON public.webhook_events;
CREATE POLICY tenant_read_webhooks ON public.webhook_events
    FOR SELECT
    USING (organization_id IN (SELECT auth_active_organization_ids()));

-- organizations.org_self_access NO se toca: debe seguir resuelta por
-- auth_organization_ids() sin filtrar por status (hallazgo 1, ver arriba).

-- Hallazgo 2: restringir UPDATE de `organizations` a las columnas que el
-- propio tenant legítimamente autoadministra. Todo lo demás (status,
-- plan_key, max_concurrent_calls, webhook_token, credenciales en claro,
-- etc.) deja de ser escribible por el rol `authenticated` — solo
-- `service_role` (supabaseAdmin en el backend) puede tocarlas.
REVOKE INSERT, UPDATE, DELETE ON public.organizations FROM authenticated;
GRANT UPDATE (name, phone_number, silence_timeout_seconds, max_call_duration_seconds)
    ON public.organizations TO authenticated;
