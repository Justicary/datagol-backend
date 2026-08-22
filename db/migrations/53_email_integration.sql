-- =============================================================================
-- DATAGOL 2026 — Migración de Base de Datos SQL: 53_email_integration.sql
-- =============================================================================
-- Integración de correo nativa (docs/tasks/native-mail-integration.md):
-- vinculación de buzones IMAP/SMTP por organización y despacho/borrador de
-- correos desde el agente de voz/chat.
--
-- 1. plans.max_mailboxes / organizations.max_mailboxes: mismo patrón que
--    max_concurrent_calls — límite numérico por plan, sincronizado a la
--    organización en setOrganizationPlan() (src/services/entitlements.ts).
--
-- 2. email_accounts: metadatos de conexión IMAP/SMTP por organización. Las
--    credenciales NO viven aquí ni en organization_secrets — esa tabla tiene
--    un CHECK fijo pensado para un secreto por tipo por organización, no
--    para N buzones. `vault_secret_id` apunta directo a Supabase Vault,
--    igual mecanismo que organization_secrets pero con nombre de secreto
--    por-recurso (org:<id>:email_account:<accountId>), gestionado por
--    src/services/email/email-account-vault.ts. RLS habilitada sin policies
--    (deny-all a anon/authenticated): se toca exclusivamente vía
--    service_role, igual tratamiento que organization_secrets.
--
-- 3. email_outbox: cubre borradores y bitácora de envío/idempotencia en una
--    sola tabla — AGENTS.md §4 exige clave de idempotencia UNIQUE en toda
--    operación de escritura originada en un tool call.
--
-- 4. features: siembra 'email_integration' (categoría 'operacion',
--    requires_provider NULL — las credenciales las aporta el cliente, no
--    Datagol) siguiendo el patrón de seed de 38_competitor_analysis.sql.
-- =============================================================================

-- =============================================================================
-- BLOQUE 1 — límite de buzones por plan
-- =============================================================================

ALTER TABLE public.plans ADD COLUMN IF NOT EXISTS max_mailboxes int4;
ALTER TABLE public.organizations ADD COLUMN IF NOT EXISTS max_mailboxes int4;

COMMENT ON COLUMN public.plans.max_mailboxes IS
    'Máximo de buzones IMAP/SMTP vinculados permitidos por el plan. NULL = sin límite.';
COMMENT ON COLUMN public.organizations.max_mailboxes IS
    'Copia de plans.max_mailboxes sincronizada por setOrganizationPlan() al cambiar de plan.';

UPDATE public.plans SET max_mailboxes = 1 WHERE key = 'starter' AND max_mailboxes IS NULL;
UPDATE public.plans SET max_mailboxes = 2 WHERE key = 'pro' AND max_mailboxes IS NULL;
UPDATE public.plans SET max_mailboxes = 5 WHERE key = 'elite' AND max_mailboxes IS NULL;
-- enterprise queda NULL a propósito (sin límite).

UPDATE public.organizations o
SET max_mailboxes = p.max_mailboxes
FROM public.plans p
WHERE o.plan_key = p.key AND o.max_mailboxes IS NULL;

-- =============================================================================
-- BLOQUE 2 — email_accounts
-- =============================================================================

CREATE TABLE IF NOT EXISTS public.email_accounts (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    organization_id uuid NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
    email_address text NOT NULL,
    provider_label text,
    imap_host text NOT NULL,
    imap_port int4 NOT NULL,
    imap_secure boolean NOT NULL DEFAULT true,
    imap_username text NOT NULL,
    smtp_host text NOT NULL,
    smtp_port int4 NOT NULL,
    smtp_secure boolean NOT NULL DEFAULT true,
    smtp_username text NOT NULL,
    vault_secret_id uuid NOT NULL,
    status text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'error', 'disabled')),
    last_validated_at timestamptz,
    last_error text,
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now(),
    UNIQUE (organization_id, email_address)
);

CREATE INDEX IF NOT EXISTS idx_email_accounts_organization_id
    ON public.email_accounts (organization_id);

ALTER TABLE public.email_accounts ENABLE ROW LEVEL SECURITY;
-- Sin policies deliberadamente: solo service_role (BYPASSRLS) toca esta
-- tabla, vía routes/admin/email-accounts.ts (isPlatformAdmin) y
-- routes/tools/email.ts (resolveToolOrganization). Mismo tratamiento que
-- organization_secrets — ningún rol anon/authenticated debe leer esto directo.

COMMENT ON TABLE public.email_accounts IS
    'Buzones IMAP/SMTP vinculados por organización (docs/tasks/native-mail-integration.md). Credenciales en Supabase Vault vía vault_secret_id, no en esta tabla ni en organization_secrets.';

-- =============================================================================
-- BLOQUE 3 — email_outbox (borradores + bitácora de envío + idempotencia)
-- =============================================================================

CREATE TABLE IF NOT EXISTS public.email_outbox (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    organization_id uuid NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
    email_account_id uuid NOT NULL REFERENCES public.email_accounts(id) ON DELETE CASCADE,
    idempotency_key text NOT NULL,
    to_addresses text[] NOT NULL,
    cc_addresses text[],
    subject text NOT NULL,
    body_text text NOT NULL,
    body_html text,
    contact_id uuid REFERENCES public.contacts(id) ON DELETE SET NULL,
    status text NOT NULL CHECK (status IN ('draft', 'sent', 'failed')),
    provider_message_id text,
    error_message text,
    created_at timestamptz NOT NULL DEFAULT now(),
    sent_at timestamptz,
    UNIQUE (organization_id, idempotency_key)
);

CREATE INDEX IF NOT EXISTS idx_email_outbox_organization_id
    ON public.email_outbox (organization_id);
CREATE INDEX IF NOT EXISTS idx_email_outbox_email_account_id
    ON public.email_outbox (email_account_id);

ALTER TABLE public.email_outbox ENABLE ROW LEVEL SECURITY;
-- Mismo criterio deny-all que email_accounts.

COMMENT ON TABLE public.email_outbox IS
    'Borradores y bitácora de envío de correo por organización, con clave de idempotencia UNIQUE (organization_id, idempotency_key) — AGENTS.md §4.';

-- =============================================================================
-- BLOQUE 4 — feature "email_integration"
-- =============================================================================

INSERT INTO public.features (key, name, description, category, requires_provider, has_cost_impact, globally_disabled, sort_order)
VALUES (
    'email_integration',
    'Integración de correo nativa',
    'Permite vincular buzones IMAP/SMTP propios y que el agente busque, lea y despache correos.',
    'operacion',
    NULL,
    false,
    false,
    (SELECT COALESCE(MAX(sort_order), 0) + 1 FROM public.features)
)
ON CONFLICT (key) DO UPDATE
SET name = EXCLUDED.name,
    description = EXCLUDED.description,
    category = EXCLUDED.category;
