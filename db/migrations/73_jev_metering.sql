-- =============================================================================
-- DATAGOL 2026 — Migración de Base de Datos SQL: 73_jev_metering.sql
-- =============================================================================
-- Metering de Jev (TypeSafe AI) vía OpenRouter — complemento de
-- 72_jev_byok.sql (no la modifica).
--
-- 1. usage_events.provider: se agrega 'jev'. Separado de 'llm' para poder
--    atribuir costos por tipo de consumo: juicios tipados (Jev) contra
--    redacción de texto (LLM BYOK). Mismo aviso que 35_llm_byok.sql: ANTES DE
--    APLICAR, confirmar el nombre real del constraint con
--      SELECT conname, pg_get_constraintdef(oid)
--      FROM pg_constraint
--      WHERE conrelid = 'public.usage_events'::regclass AND contype = 'c';
--    Fuente de verdad en código: src/types/usage-event-provider.ts.
--
-- 2. provider_rates: tarifa 0 para 'jev'/'jev_input_token' y
--    'jev'/'jev_output_token'. BYOK: el cliente paga directo a OpenRouter;
--    Datagol no cobra estos tokens. La tarifa 0 existe para que getRate()
--    encuentre una fila vigente. El costo real que reporta OpenRouter
--    (usage.cost) se guarda en usage_events.metadata.provider_cost_usd para
--    conciliación, sin escribir tarifas literales en código.
-- =============================================================================

ALTER TABLE public.usage_events
    DROP CONSTRAINT IF EXISTS usage_events_provider_check;

ALTER TABLE public.usage_events
    ADD CONSTRAINT usage_events_provider_check
    CHECK (provider = ANY (ARRAY[
        'elevenlabs'::text,
        'telnyx'::text,
        'meta'::text,
        'llm'::text,
        'jev'::text
    ]));

INSERT INTO public.provider_rates (provider, unit_type, unit_rate_usd, effective_from, notes)
VALUES
    ('jev', 'jev_input_token', 0.0000, '2026-09-24T00:00:00+00:00', 'BYOK: el cliente paga directo a OpenRouter por Jev (TypeSafe AI). Tarifa 0 solo para transparencia/diagnóstico en usage_events; el costo real del proveedor va en metadata.provider_cost_usd.'),
    ('jev', 'jev_output_token', 0.0000, '2026-09-24T00:00:00+00:00', 'BYOK: el cliente paga directo a OpenRouter por Jev (TypeSafe AI). Tarifa 0 solo para transparencia/diagnóstico en usage_events; el costo real del proveedor va en metadata.provider_cost_usd.')
ON CONFLICT DO NOTHING;
