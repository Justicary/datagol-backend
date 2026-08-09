-- =============================================================================
-- DATAGOL 2026 — Migración de Base de Datos SQL
-- =============================================================================
-- Cierra el hueco del 14% de la factura: los tokens de LLM sí vienen en el
-- webhook de post-llamada (metadata.charging.llm_usage.irreversible_generation.
-- model_usage), pero nunca se registraban en usage_events por falta de
-- tarifa en provider_rates.
--
-- Tarifas derivadas de payloads reales de producción (webhook_events,
-- provider='elevenlabs'), NO inventadas: se tomó price/tokens de varios
-- eventos distintos por modelo y dirección (input/output) para confirmar que
-- el $/token es estable entre llamadas — lo es, y coincide exactamente con
-- las tarifas públicas de Google (Gemini 2.5 Flash) y OpenAI (GPT-4o)
-- vigentes al momento de escribir esto:
--
--   gemini-2.5-flash input:  0.00146025 / 9735  tokens = 0.00000015 ($0.15 / 1M)
--   gemini-2.5-flash output: 0.0000168  / 28    tokens = 0.0000006  ($0.60 / 1M)
--   gpt-4o input:            0.01538    / 6152  tokens = 0.0000025  ($2.50 / 1M)
--   gpt-4o output:           0.00044    / 44    tokens = 0.00001    ($10.00 / 1M)
--
-- `input_cache_read`/`input_cache_write` NUNCA se registran: en todos los
-- payloads reales inspeccionados traen `price: 0` sin importar los tokens
-- (ElevenLabs no los cobra hoy) — no hay margen que perder por omitirlos, y
-- registrarlos a $0 no aportaría nada a la reconciliación.
--
-- effective_from = misma fecha que la fila 'elevenlabs'/'agent_minute' ya
-- sembrada (2026-05-01, tier "Agents PAYG"): es cuando este plan de
-- facturación de ElevenLabs (del que llm_price/llm_charge son parte) entró
-- en vigor para esta cuenta — no se puede verificar con certeza absoluta
-- desde aquí, así que se deja nota para confirmar contra el tablero de
-- facturación de ElevenLabs, igual que las filas 'meta' existentes.
--
-- provider='elevenlabs' (no 'meta' ni un proveedor nuevo 'google'/'openai'):
-- Datagol no tiene cuenta directa con Google/OpenAI para estas llamadas —
-- paga a ElevenLabs, que a su vez usa esos modelos internamente. El costo
-- real a reconciliar es el de la factura de ElevenLabs, mismo criterio ya
-- aplicado a 'wa_message'.
--
-- unit_type dinámico por modelo (llmInputTokenUnitType/llmOutputTokenUnitType
-- en src/types/usage-event-unit-type.ts) — sin CHECK constraint en la
-- columna, así que un modelo nuevo que ElevenLabs empiece a usar mañana
-- simplemente no tendrá fila aquí hasta que se agregue una migración nueva;
-- el resolver de metering lo omite con un warn en vez de inventar un precio
-- (mismo principio que toda esta tarea).
-- =============================================================================

INSERT INTO public.provider_rates (provider, unit_type, unit_rate_usd, effective_from, notes)
VALUES
    ('elevenlabs', 'llm_input_token_gemini-2.5-flash', 0.00000015, '2026-05-01T00:00:00+00:00', 'Verificar contra tablero de facturación de ElevenLabs (llm_usage.irreversible_generation)'),
    ('elevenlabs', 'llm_output_token_gemini-2.5-flash', 0.0000006, '2026-05-01T00:00:00+00:00', 'Verificar contra tablero de facturación de ElevenLabs (llm_usage.irreversible_generation)'),
    ('elevenlabs', 'llm_input_token_gpt-4o', 0.0000025, '2026-05-01T00:00:00+00:00', 'Verificar contra tablero de facturación de ElevenLabs (llm_usage.irreversible_generation)'),
    ('elevenlabs', 'llm_output_token_gpt-4o', 0.00001, '2026-05-01T00:00:00+00:00', 'Verificar contra tablero de facturación de ElevenLabs (llm_usage.irreversible_generation)');
