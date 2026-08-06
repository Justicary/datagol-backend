-- =============================================================================
-- DATAGOL 2026 — Migración de Base de Datos SQL
-- =============================================================================
-- docs/tasks/onboarding-endpoints.md — Endpoints de onboarding de organización.
--
-- 1. `organizations.agent_reprovision_pending`: no existía ningún campo que
--    representara "el agente en el proveedor de voz quedó desincronizado de
--    los entitlements vigentes". Se marca `true` al cambiar plan o features
--    (services/entitlements.ts) y se limpia en `reprovisionAgent()`
--    (services/agent-provisioning.ts) al terminar con éxito. Es lo único que
--    hace verificable el criterio de readiness "agente sin marca de
--    reprovisión pendiente".
--
-- 2. `create_organization_with_owner(...)`: la creación de una organización y
--    de su membresía `owner` deben ser atómicas — una organización sin dueño
--    es un registro huérfano imposible de administrar (nadie pasa las
--    políticas RLS de `organizations`/`organization_members` para ella). Al
--    ejecutarse como una única función Postgres, cualquier excepción dentro
--    (ej. el INSERT en `organization_members`) revierte también el INSERT en
--    `organizations` de la misma llamada — sin necesidad de una compensación
--    manual en JS que podría fallar por separado.
-- =============================================================================

ALTER TABLE public.organizations
    ADD COLUMN IF NOT EXISTS agent_reprovision_pending boolean NOT NULL DEFAULT false;

COMMENT ON COLUMN public.organizations.agent_reprovision_pending IS
    'true cuando el agente en el proveedor de voz quedó desincronizado de los entitlements vigentes (cambio de plan o de feature). Lo limpia reprovisionAgent() al terminar con éxito.';

CREATE OR REPLACE FUNCTION public.create_organization_with_owner(
    p_name text,
    p_email text,
    p_phone_number text,
    p_user_id uuid
) RETURNS public.organizations
LANGUAGE plpgsql
AS $$
DECLARE
    v_org public.organizations;
BEGIN
    INSERT INTO public.organizations (name, email, phone_number)
    VALUES (p_name, p_email, p_phone_number)
    RETURNING * INTO v_org;

    INSERT INTO public.organization_members (organization_id, user_id, role)
    VALUES (v_org.id, p_user_id, 'owner');

    RETURN v_org;
END;
$$;

COMMENT ON FUNCTION public.create_organization_with_owner(text, text, text, uuid) IS
    'Crea una organización y su membresía owner en una sola transacción implícita de función: si el INSERT en organization_members falla, el INSERT en organizations de la misma llamada se revierte. Usado por POST /api/organizations (routes/organization-onboarding.ts).';
