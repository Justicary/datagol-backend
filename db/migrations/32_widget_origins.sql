-- =============================================================================
-- DATAGOL 2026 — Migración de Base de Datos SQL
-- =============================================================================
-- Widget de chat web embebido (chatbot en el sitio del cliente). Sin esta
-- migración el flujo completo queda inoperante: no hay dónde registrar qué
-- orígenes tiene autorizado un tenant, ni dónde contar los intentos de
-- sesión para el cortafuegos de costo.
--
-- widget_origins: análogo de organizations.webhook_token pero por ORIGEN (un
-- tenant puede tener varios sitios/subdominios, cada uno con su propia clave
-- pública revocable sin afectar a los demás). `public_key` es
-- deliberadamente NO secreta (vive en el HTML servido al navegador, visible
-- para cualquiera) — la autorización real es el par (public_key, Origin)
-- exacto registrado en esta tabla, verificado en cada POST
-- /api/widget/session (src/lib/widget-auth.ts). A diferencia de un log de
-- abuso (outbound_call_attempts, migración 12), esta SÍ lleva una política
-- RLS real: es configuración de negocio que el dashboard del tenant lee y
-- escribe (src/routes/organization-widget.ts).
--
-- widget_session_attempts: mismo patrón que outbound_call_attempts — log de
-- sesiones CONCEDIDAS (no de intentos rechazados por origen/entitlement,
-- que nunca llegan a insertarse) para aplicar el límite por IP/hora y por
-- organización/día. Solo service_role la toca.
--
-- organizations.widget_daily_session_limit: tope diario configurable por
-- organización, mismo criterio que max_concurrent_calls/
-- silence_timeout_seconds — un tunable de negocio vive en la fila de la
-- organización, no en una tabla de features ni en integration_settings
-- (AGENTS.md §16: prohibido un sistema de flags paralelo).
--
-- features: se agrega la fila 'web_widget' (categoría 'web', requiere
-- proveedor 'elevenlabs', con impacto de costo). El catálogo de features no
-- se crea vía migración (tabla gestionada manualmente hasta ahora), pero SÍ
-- se siembra aquí la fila de esta feature concreta para que el entitlement
-- exista de verdad antes de que el código lo consulte
-- (services/entitlements.ts) o que __tests__/feature-taxonomy.test.ts la
-- busque.
-- =============================================================================

CREATE TABLE IF NOT EXISTS public.widget_origins (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    organization_id uuid NOT NULL REFERENCES public.organizations(id),
    origin text NOT NULL,
    public_key text NOT NULL,
    enabled boolean NOT NULL DEFAULT true,
    created_at timestamptz NOT NULL DEFAULT now(),
    UNIQUE (organization_id, origin)
);

CREATE UNIQUE INDEX IF NOT EXISTS ux_widget_origins_public_key
    ON public.widget_origins (public_key);
CREATE INDEX IF NOT EXISTS widget_origins_organization_id_idx
    ON public.widget_origins (organization_id);

ALTER TABLE public.widget_origins ENABLE ROW LEVEL SECURITY;

CREATE POLICY tenant_isolation ON public.widget_origins
    FOR ALL
    USING (organization_id IN (SELECT auth_active_organization_ids()))
    WITH CHECK (organization_id IN (SELECT auth_active_organization_ids()));

COMMENT ON TABLE public.widget_origins IS
    'Orígenes (esquema+host) autorizados a usar el widget de chat web de una organización, cada uno con su propia public_key no secreta. POST /api/widget/session valida el par (public_key, header Origin) exacto contra esta tabla antes de emitir un token efímero de conversación de ElevenLabs.';

CREATE TABLE IF NOT EXISTS public.widget_session_attempts (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    organization_id uuid REFERENCES public.organizations(id),
    source_ip text,
    created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS widget_session_attempts_org_created_idx
    ON public.widget_session_attempts (organization_id, created_at);
CREATE INDEX IF NOT EXISTS widget_session_attempts_ip_created_idx
    ON public.widget_session_attempts (source_ip, created_at);

ALTER TABLE public.widget_session_attempts ENABLE ROW LEVEL SECURITY;

COMMENT ON TABLE public.widget_session_attempts IS
    'Log de sesiones de widget concedidas (no de intentos rechazados por origen/entitlement) usado únicamente para el cortafuegos de costo de POST /api/widget/session: límite por IP/hora y por organización/día. RLS habilitada sin políticas: solo service_role (backend) la lee/escribe.';

ALTER TABLE public.organizations
    ADD COLUMN IF NOT EXISTS widget_daily_session_limit integer NOT NULL DEFAULT 200;

COMMENT ON COLUMN public.organizations.widget_daily_session_limit IS
    'Tope configurable de sesiones de widget de chat concedidas por día (ventana móvil de 24h) antes de degradar a formulario de contacto. Editable vía PATCH /api/organizations/:id/widget-settings.';

INSERT INTO public.features (key, name, description, category, requires_provider, has_cost_impact, globally_disabled, sort_order)
VALUES (
    'web_widget',
    'Widget de chat web',
    'Permite incrustar el agente conversacional de ElevenLabs como widget de chat en el sitio web del cliente, vía POST /api/widget/session.',
    'web',
    'elevenlabs',
    true,
    false,
    (SELECT COALESCE(MAX(sort_order), 0) + 1 FROM public.features)
)
ON CONFLICT (key) DO NOTHING;
