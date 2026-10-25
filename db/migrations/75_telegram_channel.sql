-- =============================================================================
-- DATAGOL 2026 — Migración de Base de Datos SQL: 75_telegram_channel.sql
-- =============================================================================
-- Canal de Telegram para Administración y Reportes en Lenguaje Natural.
--
-- Contenido:
--   BLOQUE 1: Ampliación de CHECK constraints (organization_secrets, webhook_events, features).
--   BLOQUE 2: Alineación de la feature 'telegram' y plan_features (PRO, ELITE, ENTERPRISE = true; STARTER = false).
--   BLOQUE 3: Función RPC `member_permissions_in_org(p_org_id, p_user_id)` (Opción A, exclusiva service_role).
--   BLOQUE 4: Tablas del canal Telegram (telegram_connections, telegram_identities,
--             telegram_link_tokens, telegram_conversations, telegram_messages) con índices y RLS.
--   BLOQUE 5: Actualización de `factory_reset_transactional_data()` para limpiar historial
--             transaccional de Telegram conservando la configuración e identidades activas.
-- =============================================================================

-- =============================================================================
-- BLOQUE 1 — Ampliación de CHECK constraints
-- =============================================================================

-- 1.1 organization_secrets.secret_key: conserva todas las claves hasta la migración 72 ('jev_api_key')
--     y agrega 'telegram_bot_token' y 'telegram_webhook_secret'.
ALTER TABLE public.organization_secrets
    DROP CONSTRAINT IF EXISTS organization_secrets_secret_key_check;

ALTER TABLE public.organization_secrets
    ADD CONSTRAINT organization_secrets_secret_key_check
    CHECK (secret_key = ANY (ARRAY[
        'elevenlabs_api_key'::text,
        'telnyx_api_key'::text,
        'whatsapp_access_token'::text,
        'cal_api_key'::text,
        'meta_app_secret'::text,
        'webhook_signing_secret'::text,
        'tool_webhook_secret'::text,
        'google_maps_key'::text,
        'llm_api_key'::text,
        'jev_api_key'::text,
        'telegram_bot_token'::text,
        'telegram_webhook_secret'::text
    ]));

-- 1.2 webhook_events.provider: agrega 'telegram'.
ALTER TABLE public.webhook_events
    DROP CONSTRAINT IF EXISTS webhook_events_provider_check;

ALTER TABLE public.webhook_events
    ADD CONSTRAINT webhook_events_provider_check
    CHECK (provider = ANY (ARRAY[
        'elevenlabs'::text,
        'telnyx'::text,
        'meta'::text,
        'cal'::text,
        'telegram'::text
    ]));

-- 1.3 features.requires_provider: agrega 'telegram'.
ALTER TABLE public.features
    DROP CONSTRAINT IF EXISTS features_requires_provider_check;

ALTER TABLE public.features
    ADD CONSTRAINT features_requires_provider_check
    CHECK (requires_provider = ANY (ARRAY[
        'elevenlabs'::text,
        'telnyx'::text,
        'meta'::text,
        'cal'::text,
        'telegram'::text
    ]));

-- =============================================================================
-- BLOQUE 2 — Feature 'telegram' y Plan Features (PRO+)
-- =============================================================================

INSERT INTO public.features (
    key,
    name,
    description,
    category,
    requires_provider,
    has_cost_impact,
    globally_disabled,
    sort_order
) VALUES (
    'telegram',
    'Bot de Telegram',
    'Interfaz conversacional segura en Telegram para consultar reportes e información de negocio en lenguaje natural.',
    'mensajeria',
    'telegram',
    false,
    false,
    60
) ON CONFLICT (key) DO UPDATE SET
    name = EXCLUDED.name,
    description = EXCLUDED.description,
    category = EXCLUDED.category,
    requires_provider = EXCLUDED.requires_provider,
    has_cost_impact = EXCLUDED.has_cost_impact;

-- Habilitar a partir de PRO (pro, elite, enterprise = true; starter = false)
INSERT INTO public.plan_features (plan_key, feature_key, enabled)
VALUES
    ('starter', 'telegram', false),
    ('pro', 'telegram', true),
    ('elite', 'telegram', true),
    ('enterprise', 'telegram', true)
ON CONFLICT (plan_key, feature_key) DO UPDATE SET
    enabled = EXCLUDED.enabled;

-- =============================================================================
-- BLOQUE 3 — Resolución de permisos sin JWT (Opción A: member_permissions_in_org)
-- =============================================================================
-- Replica exactamente la precedencia de `has_permission(p_org_id, p_permission)`
-- (invariante de owner -> override vigente en organization_role_permissions ->
-- default en role_permissions -> denegar), pero recibiendo `p_user_id` explícito
-- en lugar de `auth.uid()` para los workers de pg-boss que operan vía service_role.
-- No modifica `has_permission(uuid, text)` para no tocar ninguna política RLS activa.

CREATE OR REPLACE FUNCTION public.member_permissions_in_org(
    p_org_id uuid,
    p_user_id uuid
)
RETURNS TABLE (permission_key text)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
    v_role text;
BEGIN
    IF p_org_id IS NULL OR p_user_id IS NULL THEN
        RETURN;
    END IF;

    SELECT om.role INTO v_role
    FROM public.organization_members om
    WHERE om.organization_id = p_org_id
      AND om.user_id = p_user_id
    LIMIT 1;

    IF v_role IS NULL THEN
        RETURN;
    END IF;

    RETURN QUERY
    SELECT p.key AS permission_key
    FROM public.permissions p
    LEFT JOIN LATERAL (
        SELECT orp.enabled
        FROM public.organization_role_permissions orp
        WHERE orp.organization_id = p_org_id
          AND orp.role = v_role
          AND orp.permission_key = p.key
          AND (orp.expires_at IS NULL OR orp.expires_at > now())
        LIMIT 1
    ) override_perm ON true
    LEFT JOIN public.role_permissions rp
        ON rp.role = v_role AND rp.permission_key = p.key
    WHERE
        CASE
            WHEN v_role = 'owner' AND p.key IN ('manage_users', 'change_plan') THEN true
            WHEN override_perm.enabled IS NOT NULL THEN override_perm.enabled
            ELSE COALESCE(rp.enabled, false)
        END = true;
END;
$$;

COMMENT ON FUNCTION public.member_permissions_in_org(uuid, uuid) IS
    'Resuelve el conjunto de permisos efectivos de un miembro (p_user_id) en una organización (p_org_id) sin requerir sesión JWT (auth.uid()). Exclusiva para service_role en workers asíncronos (Telegram).';

REVOKE ALL ON FUNCTION public.member_permissions_in_org(uuid, uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.member_permissions_in_org(uuid, uuid) TO service_role;

-- =============================================================================
-- BLOQUE 4 — Tablas del canal Telegram, Índices, Triggers y RLS
-- =============================================================================

-- 4.1 telegram_connections: 1 bot por organización. El bot_token y webhook_secret
--     viven exclusivamente en Supabase Vault (organization_secrets).
CREATE TABLE IF NOT EXISTS public.telegram_connections (
    id                      uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    organization_id         uuid NOT NULL UNIQUE REFERENCES public.organizations(id) ON DELETE CASCADE,
    telegram_bot_id         bigint NOT NULL UNIQUE,
    bot_username            text NOT NULL,
    bot_first_name          text,
    webhook_token           text NOT NULL UNIQUE DEFAULT encode(gen_random_bytes(32), 'hex'),
    webhook_registered_at   timestamptz,
    status                  text NOT NULL DEFAULT 'active'
                            CHECK (status IN ('active', 'disabled', 'error')),
    last_error              text,
    created_at              timestamptz NOT NULL DEFAULT now(),
    updated_at              timestamptz NOT NULL DEFAULT now()
);

COMMENT ON TABLE public.telegram_connections IS
    'Configuración del Bot de Telegram de cada organización (1:1). Los secretos (telegram_bot_token, telegram_webhook_secret) viven en Supabase Vault.';

DROP TRIGGER IF EXISTS trg_telegram_connections_updated ON public.telegram_connections;
CREATE TRIGGER trg_telegram_connections_updated
    BEFORE UPDATE ON public.telegram_connections
    FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

ALTER TABLE public.telegram_connections ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS telegram_connections_read ON public.telegram_connections;
CREATE POLICY telegram_connections_read ON public.telegram_connections
    FOR SELECT TO authenticated
    USING (public.has_permission(organization_id, 'manage_credentials'));

DROP POLICY IF EXISTS telegram_connections_write ON public.telegram_connections;
CREATE POLICY telegram_connections_write ON public.telegram_connections
    FOR ALL TO authenticated
    USING (public.has_permission(organization_id, 'manage_credentials'))
    WITH CHECK (public.has_permission(organization_id, 'manage_credentials'));

-- 4.2 telegram_identities: Vinculación entre cuenta de Telegram (telegram_user_id inmutable)
--     y miembro de la organización (organization_members).
--     Opción 2: varios admins de la misma organización pueden vincular su Telegram personal,
--     pero en v1 cada telegram_user_id pertenece a una sola organización activa (UNIQUE global).
CREATE TABLE IF NOT EXISTS public.telegram_identities (
    id                      uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    organization_id         uuid NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
    organization_member_id  uuid NOT NULL REFERENCES public.organization_members(id) ON DELETE CASCADE,
    user_id                 uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
    telegram_user_id        bigint NOT NULL UNIQUE,
    telegram_chat_id        bigint NOT NULL,
    telegram_username       text,
    telegram_first_name     text,
    status                  text NOT NULL DEFAULT 'active'
                            CHECK (status IN ('active', 'revoked')),
    linked_at               timestamptz NOT NULL DEFAULT now(),
    revoked_at              timestamptz,
    last_seen_at            timestamptz,
    created_at              timestamptz NOT NULL DEFAULT now(),
    updated_at              timestamptz NOT NULL DEFAULT now(),
    UNIQUE (organization_id, organization_member_id)
);

COMMENT ON TABLE public.telegram_identities IS
    'Identidades de Telegram vinculadas a miembros de la organización. Autorización basada exclusivamente en telegram_user_id numérico inmutable.';

CREATE INDEX IF NOT EXISTS idx_telegram_identities_org_status
    ON public.telegram_identities (organization_id, status);
CREATE INDEX IF NOT EXISTS idx_telegram_identities_user_id
    ON public.telegram_identities (user_id);

DROP TRIGGER IF EXISTS trg_telegram_identities_updated ON public.telegram_identities;
CREATE TRIGGER trg_telegram_identities_updated
    BEFORE UPDATE ON public.telegram_identities
    FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

ALTER TABLE public.telegram_identities ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS telegram_identities_read ON public.telegram_identities;
CREATE POLICY telegram_identities_read ON public.telegram_identities
    FOR SELECT TO authenticated
    USING (public.has_permission(organization_id, 'manage_credentials'));

DROP POLICY IF EXISTS telegram_identities_write ON public.telegram_identities;
CREATE POLICY telegram_identities_write ON public.telegram_identities
    FOR ALL TO authenticated
    USING (public.has_permission(organization_id, 'manage_credentials'))
    WITH CHECK (public.has_permission(organization_id, 'manage_credentials'));

-- 4.3 telegram_link_tokens: Tokens de vinculación de un solo uso (/start <token>).
--     Solo se almacena el hash SHA-256 (token_hash), jamás el token en claro.
CREATE TABLE IF NOT EXISTS public.telegram_link_tokens (
    id                          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    organization_id             uuid NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
    organization_member_id      uuid NOT NULL REFERENCES public.organization_members(id) ON DELETE CASCADE,
    created_by_user_id          uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
    token_hash                  text NOT NULL UNIQUE,
    expires_at                  timestamptz NOT NULL,
    used_at                     timestamptz,
    used_by_telegram_user_id    bigint,
    created_at                  timestamptz NOT NULL DEFAULT now()
);

COMMENT ON TABLE public.telegram_link_tokens IS
    'Tokens efímeros de un solo uso para vincular una cuenta de Telegram vía deep link (/start <token>). Persiste únicamente SHA-256 (token_hash).';

CREATE INDEX IF NOT EXISTS idx_telegram_link_tokens_org_member
    ON public.telegram_link_tokens (organization_id, organization_member_id);
CREATE INDEX IF NOT EXISTS idx_telegram_link_tokens_expires
    ON public.telegram_link_tokens (expires_at) WHERE used_at IS NULL;

ALTER TABLE public.telegram_link_tokens ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS telegram_link_tokens_read ON public.telegram_link_tokens;
CREATE POLICY telegram_link_tokens_read ON public.telegram_link_tokens
    FOR SELECT TO authenticated
    USING (public.has_permission(organization_id, 'manage_credentials'));

DROP POLICY IF EXISTS telegram_link_tokens_write ON public.telegram_link_tokens;
CREATE POLICY telegram_link_tokens_write ON public.telegram_link_tokens
    FOR ALL TO authenticated
    USING (public.has_permission(organization_id, 'manage_credentials'))
    WITH CHECK (public.has_permission(organization_id, 'manage_credentials'));

-- 4.4 telegram_conversations: Contexto conversacional acotado (últimos 3 turnos, TTL 30 min)
--     aislado por (organization_id, telegram_chat_id).
CREATE TABLE IF NOT EXISTS public.telegram_conversations (
    id                      uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    organization_id         uuid NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
    telegram_chat_id        bigint NOT NULL,
    telegram_identity_id    uuid REFERENCES public.telegram_identities(id) ON DELETE SET NULL,
    context                 jsonb NOT NULL DEFAULT '[]'::jsonb,
    context_expires_at      timestamptz,
    created_at              timestamptz NOT NULL DEFAULT now(),
    updated_at              timestamptz NOT NULL DEFAULT now(),
    UNIQUE (organization_id, telegram_chat_id)
);

COMMENT ON TABLE public.telegram_conversations IS
    'Contexto conversacional de corto plazo por chat privado de Telegram (máx. 3 turnos con resultDigest <= 500 chars, TTL 30 min).';

CREATE INDEX IF NOT EXISTS idx_telegram_conversations_identity
    ON public.telegram_conversations (telegram_identity_id);

DROP TRIGGER IF EXISTS trg_telegram_conversations_updated ON public.telegram_conversations;
CREATE TRIGGER trg_telegram_conversations_updated
    BEFORE UPDATE ON public.telegram_conversations
    FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

ALTER TABLE public.telegram_conversations ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS telegram_conversations_read ON public.telegram_conversations;
CREATE POLICY telegram_conversations_read ON public.telegram_conversations
    FOR SELECT TO authenticated
    USING (public.has_permission(organization_id, 'use_nl_reports'));

-- 4.5 telegram_messages: Bitácora operativa de mensajes entrantes/salientes sin PII innecesaria.
CREATE TABLE IF NOT EXISTS public.telegram_messages (
    id                      uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    organization_id         uuid NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
    conversation_id         uuid REFERENCES public.telegram_conversations(id) ON DELETE SET NULL,
    telegram_identity_id    uuid REFERENCES public.telegram_identities(id) ON DELETE SET NULL,
    direction               text NOT NULL CHECK (direction IN ('inbound', 'outbound')),
    telegram_update_id      bigint,
    telegram_message_id     bigint,
    intent                  text,
    harness_status          text CHECK (harness_status IN ('success', 'requiere_aclaracion', 'no_resuelta', 'error', 'system')),
    execution_time_ms       integer,
    error                   text,
    created_at              timestamptz NOT NULL DEFAULT now()
);

COMMENT ON TABLE public.telegram_messages IS
    'Bitácora de auditoría operativa del canal Telegram (metadatos de ejecución e intención sin almacenar el texto crudo ni datos sensibles).';

CREATE INDEX IF NOT EXISTS idx_telegram_messages_org_created
    ON public.telegram_messages (organization_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_telegram_messages_conversation
    ON public.telegram_messages (conversation_id);
CREATE INDEX IF NOT EXISTS idx_telegram_messages_identity
    ON public.telegram_messages (telegram_identity_id);

ALTER TABLE public.telegram_messages ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS telegram_messages_read ON public.telegram_messages;
CREATE POLICY telegram_messages_read ON public.telegram_messages
    FOR SELECT TO authenticated
    USING (public.has_permission(organization_id, 'use_nl_reports'));

-- =============================================================================
-- BLOQUE 5 — Actualización de factory_reset_transactional_data()
-- =============================================================================
-- Conserva íntegramente el comportamiento de 74_factory_reset_extended.sql y añade
-- la limpieza de telegram_messages, telegram_conversations y telegram_link_tokens
-- consumidos o expirados (conservando telegram_connections y telegram_identities).

CREATE OR REPLACE FUNCTION public.factory_reset_transactional_data()
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
    v_counts jsonb := '{}'::jsonb;
    v_rows integer;
BEGIN
    SET LOCAL session_replication_role = replica;

    -- Referencia colgante de facturación (sin tocar importes). Ver migración 23.
    UPDATE public.usage_events SET call_log_id = NULL WHERE call_log_id IS NOT NULL;

    -- Hijas de contacts/leads/call_logs/appointments.
    DELETE FROM public.thank_you_sends WHERE id IS NOT NULL;
    GET DIAGNOSTICS v_rows = ROW_COUNT; v_counts := v_counts || jsonb_build_object('thank_you_sends_deleted', v_rows);

    DELETE FROM public.whatsapp_messages WHERE id IS NOT NULL;
    GET DIAGNOSTICS v_rows = ROW_COUNT; v_counts := v_counts || jsonb_build_object('whatsapp_messages_deleted', v_rows);

    DELETE FROM public.email_outbox WHERE id IS NOT NULL;
    GET DIAGNOSTICS v_rows = ROW_COUNT; v_counts := v_counts || jsonb_build_object('email_outbox_deleted', v_rows);

    DELETE FROM public.contact_pipeline_transitions WHERE id IS NOT NULL;
    GET DIAGNOSTICS v_rows = ROW_COUNT; v_counts := v_counts || jsonb_build_object('contact_pipeline_transitions_deleted', v_rows);

    DELETE FROM public.appointment_waitlist WHERE id IS NOT NULL;
    GET DIAGNOSTICS v_rows = ROW_COUNT; v_counts := v_counts || jsonb_build_object('appointment_waitlist_deleted', v_rows);

    -- Historial conversacional de Telegram (conserva telegram_connections y telegram_identities).
    DELETE FROM public.telegram_messages WHERE id IS NOT NULL;
    GET DIAGNOSTICS v_rows = ROW_COUNT; v_counts := v_counts || jsonb_build_object('telegram_messages_deleted', v_rows);

    DELETE FROM public.telegram_conversations WHERE id IS NOT NULL;
    GET DIAGNOSTICS v_rows = ROW_COUNT; v_counts := v_counts || jsonb_build_object('telegram_conversations_deleted', v_rows);

    DELETE FROM public.telegram_link_tokens
    WHERE used_at IS NOT NULL OR expires_at <= now();
    GET DIAGNOSTICS v_rows = ROW_COUNT; v_counts := v_counts || jsonb_build_object('telegram_link_tokens_deleted', v_rows);

    -- Núcleo transaccional.
    DELETE FROM public.appointments WHERE id IS NOT NULL;
    GET DIAGNOSTICS v_rows = ROW_COUNT; v_counts := v_counts || jsonb_build_object('appointments_deleted', v_rows);

    DELETE FROM public.leads WHERE id IS NOT NULL;
    GET DIAGNOSTICS v_rows = ROW_COUNT; v_counts := v_counts || jsonb_build_object('leads_deleted', v_rows);

    DELETE FROM public.call_logs WHERE id IS NOT NULL;
    GET DIAGNOSTICS v_rows = ROW_COUNT; v_counts := v_counts || jsonb_build_object('call_logs_deleted', v_rows);

    DELETE FROM public.contact_notes WHERE id IS NOT NULL;
    GET DIAGNOSTICS v_rows = ROW_COUNT; v_counts := v_counts || jsonb_build_object('contact_notes_deleted', v_rows);

    -- Solo direcciones de contactos: las de la organización (contact_id NULL) son configuración.
    DELETE FROM public.contact_addresses WHERE contact_id IS NOT NULL;
    GET DIAGNOSTICS v_rows = ROW_COUNT; v_counts := v_counts || jsonb_build_object('contact_addresses_deleted', v_rows);

    DELETE FROM public.contacts WHERE id IS NOT NULL;
    GET DIAGNOSTICS v_rows = ROW_COUNT; v_counts := v_counts || jsonb_build_object('contacts_deleted', v_rows);

    -- Bitácoras de auditoría (ambas append-only; replica desactiva su trigger).
    DELETE FROM public.feature_audit_log WHERE id IS NOT NULL;
    GET DIAGNOSTICS v_rows = ROW_COUNT; v_counts := v_counts || jsonb_build_object('feature_audit_log_deleted', v_rows);

    DELETE FROM public.permission_audit_log WHERE id IS NOT NULL;
    GET DIAGNOSTICS v_rows = ROW_COUNT; v_counts := v_counts || jsonb_build_object('permission_audit_log_deleted', v_rows);

    -- Historial de pruebas sin valor de configuración.
    DELETE FROM public.unanswered_questions WHERE id IS NOT NULL;
    GET DIAGNOSTICS v_rows = ROW_COUNT; v_counts := v_counts || jsonb_build_object('unanswered_questions_deleted', v_rows);

    DELETE FROM public.weekly_reports WHERE id IS NOT NULL;
    GET DIAGNOSTICS v_rows = ROW_COUNT; v_counts := v_counts || jsonb_build_object('weekly_reports_deleted', v_rows);

    DELETE FROM public.competitor_site_snapshots WHERE id IS NOT NULL;
    GET DIAGNOSTICS v_rows = ROW_COUNT; v_counts := v_counts || jsonb_build_object('competitor_site_snapshots_deleted', v_rows);

    DELETE FROM public.outbound_call_attempts WHERE id IS NOT NULL;
    GET DIAGNOSTICS v_rows = ROW_COUNT; v_counts := v_counts || jsonb_build_object('outbound_call_attempts_deleted', v_rows);

    DELETE FROM public.organization_usage_alerts WHERE id IS NOT NULL;
    GET DIAGNOSTICS v_rows = ROW_COUNT; v_counts := v_counts || jsonb_build_object('organization_usage_alerts_deleted', v_rows);

    DELETE FROM public.concurrency_quota_alerts WHERE id IS NOT NULL;
    GET DIAGNOSTICS v_rows = ROW_COUNT; v_counts := v_counts || jsonb_build_object('concurrency_quota_alerts_deleted', v_rows);

    DELETE FROM public.catalog_imports WHERE id IS NOT NULL;
    GET DIAGNOSTICS v_rows = ROW_COUNT; v_counts := v_counts || jsonb_build_object('catalog_imports_deleted', v_rows);

    -- Invitaciones: se conservan las pendientes (no aceptadas, no revocadas, vigentes).
    DELETE FROM public.organization_invitations
    WHERE accepted_at IS NOT NULL OR revoked_at IS NOT NULL OR expires_at <= now();
    GET DIAGNOSTICS v_rows = ROW_COUNT; v_counts := v_counts || jsonb_build_object('organization_invitations_deleted', v_rows);

    SET LOCAL session_replication_role = DEFAULT;

    RETURN v_counts;
END;
$$;
