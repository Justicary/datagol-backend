import { FastifyInstance } from 'fastify';
import { getSecret } from './secret-service.js';
import { getRate } from './rate-service.js';
import { LlmProviderFactory } from './llm/LlmProviderFactory.js';
import { LlmProviderError, type LlmCompletionResult, type LlmProviderErrorKind } from './llm/llm-provider.interface.js';
import { SECRET_KEYS } from '../types/secret-keys.js';
import { USAGE_EVENT_PROVIDERS } from '../types/usage-event-provider.js';
import { isLlmProvider, LLM_PROVIDERS, type LlmProvider } from '../types/llm-providers.js';

export interface LlmConfig {
    provider: LlmProvider | null;
    model: string | null;
    baseUrl: string | null;
    validatedAt: string | null;
    lastError: string | null;
}

const EMPTY_LLM_CONFIG: LlmConfig = {
    provider: null,
    model: null,
    baseUrl: null,
    validatedAt: null,
    lastError: null,
};

function readLlmConfig(integrationSettings: Record<string, unknown> | null): LlmConfig {
    const raw = (integrationSettings?.llm ?? {}) as Partial<LlmConfig>;
    return {
        provider: typeof raw.provider === 'string' && isLlmProvider(raw.provider) ? raw.provider : null,
        model: raw.model ?? null,
        baseUrl: raw.baseUrl ?? null,
        validatedAt: raw.validatedAt ?? null,
        lastError: raw.lastError ?? null,
    };
}

async function readIntegrationSettings(
    fastify: FastifyInstance,
    organizationId: string
): Promise<Record<string, unknown>> {
    const { data } = await fastify.supabaseAdmin
        .from('organizations')
        .select('integration_settings')
        .eq('id', organizationId)
        .maybeSingle();
    return (data?.integration_settings as Record<string, unknown>) ?? {};
}

/**
 * Lee `integration_settings.llm` de la organización. Devuelve el objeto
 * vacío (todo `null`) si nunca se configuró — nunca lanza.
 */
export async function getLlmConfig(fastify: FastifyInstance, organizationId: string): Promise<LlmConfig> {
    const settings = await readIntegrationSettings(fastify, organizationId);
    if (!settings.llm) return { ...EMPTY_LLM_CONFIG };
    return readLlmConfig(settings);
}

/**
 * Guarda adicional de B.5 (docs/tasks/reportes-semanales.md): las features
 * `weekly_planning_report`/`weekly_executive_report` exigen `llm_api_key`
 * presente Y validada — no solo presente, como hace el guard genérico
 * `checkProviderCredentials()` (entitlements.ts) para `requires_provider`.
 *
 * `lastError === null` es suficiente para saber que la validación más
 * reciente fue exitosa, sin necesitar un timestamp aparte para `lastError`:
 * `validateLlmCredentials()` SIEMPRE limpia `lastError` en éxito y SIEMPRE
 * lo fija (sin tocar `validatedAt`) en fallo — así que "lastError no nulo"
 * ya significa "el último intento de validación falló", sin importar qué
 * tan viejo sea `validatedAt`.
 */
export async function isLlmConfigValidated(fastify: FastifyInstance, organizationId: string): Promise<boolean> {
    const config = await getLlmConfig(fastify, organizationId);
    return Boolean(config.provider) && Boolean(config.model) && config.validatedAt !== null && config.lastError === null;
}

export interface UpdateLlmConfigParams {
    provider: LlmProvider;
    model: string;
    baseUrl?: string;
}

/**
 * Guarda `provider`/`model`/`baseUrl`. Cambiar la configuración invalida
 * cualquier validación previa (`validatedAt`/`lastError` se resetean a
 * `null`) — una llave validada para un modelo ya no dice nada sobre otro.
 */
export async function updateLlmConfig(
    fastify: FastifyInstance,
    organizationId: string,
    params: UpdateLlmConfigParams
): Promise<{ success: boolean; error?: string }> {
    const currentSettings = await readIntegrationSettings(fastify, organizationId);

    const newLlmConfig: LlmConfig = {
        provider: params.provider,
        model: params.model,
        baseUrl: params.provider === LLM_PROVIDERS.OPENROUTER ? (params.baseUrl ?? null) : null,
        validatedAt: null,
        lastError: null,
    };

    const { error } = await fastify.supabaseAdmin
        .from('organizations')
        .update({
            integration_settings: { ...currentSettings, llm: newLlmConfig },
            updated_at: new Date().toISOString(),
        })
        .eq('id', organizationId);

    if (error) {
        fastify.log.error({ err: error.message, organizationId }, '[LlmConfig] Error guardando configuración de LLM');
        return { success: false, error: 'No se pudo guardar la configuración de LLM.' };
    }

    return { success: true };
}

async function persistValidationResult(
    fastify: FastifyInstance,
    organizationId: string,
    patch: { validatedAt?: string | null; lastError: string | null }
): Promise<void> {
    const currentSettings = await readIntegrationSettings(fastify, organizationId);
    const currentLlm = readLlmConfig(currentSettings);

    const updatedLlm: LlmConfig = {
        ...currentLlm,
        validatedAt: patch.validatedAt !== undefined ? patch.validatedAt : currentLlm.validatedAt,
        lastError: patch.lastError,
    };

    const { error } = await fastify.supabaseAdmin
        .from('organizations')
        .update({
            integration_settings: { ...currentSettings, llm: updatedLlm },
            updated_at: new Date().toISOString(),
        })
        .eq('id', organizationId);

    if (error) {
        fastify.log.error(
            { err: error.message, organizationId },
            '[LlmConfig] Error persistiendo resultado de validación'
        );
    }
}

/**
 * Registra los tokens consumidos por la llamada de validación en
 * `usage_events`, `provider: 'llm'`, aunque la tarifa vigente sea 0 (BYOK: el
 * cliente paga directo al proveedor). A diferencia de otros servicios de
 * metering, aquí NO se aplica el guard `rate.unitRateUsd > 0` — el objetivo
 * no es facturar, es transparencia y diagnóstico de reportes caros (A.6 de
 * docs/tasks/reportes-semanales.md), así que un evento a costo cero sigue
 * siendo información útil. Nunca lanza: un fallo de metering no debe
 * invalidar una validación que sí funcionó.
 */
export async function recordLlmUsage(
    fastify: FastifyInstance,
    organizationId: string,
    config: LlmConfig,
    result: LlmCompletionResult
): Promise<void> {
    try {
        const now = new Date();
        const rows: Record<string, unknown>[] = [];

        if (result.inputTokens > 0) {
            const rate = await getRate(fastify, USAGE_EVENT_PROVIDERS.LLM, 'llm_input_token', now);
            const unitRateUsd = rate?.unitRateUsd ?? 0;
            rows.push({
                organization_id: organizationId,
                provider: USAGE_EVENT_PROVIDERS.LLM,
                unit_type: 'llm_input_token',
                quantity: result.inputTokens,
                unit_rate_usd: unitRateUsd,
                amount_usd: unitRateUsd * result.inputTokens,
                occurred_at: now.toISOString(),
                metadata: { model: config.model, provider: config.provider },
            });
        }

        if (result.outputTokens > 0) {
            const rate = await getRate(fastify, USAGE_EVENT_PROVIDERS.LLM, 'llm_output_token', now);
            const unitRateUsd = rate?.unitRateUsd ?? 0;
            rows.push({
                organization_id: organizationId,
                provider: USAGE_EVENT_PROVIDERS.LLM,
                unit_type: 'llm_output_token',
                quantity: result.outputTokens,
                unit_rate_usd: unitRateUsd,
                amount_usd: unitRateUsd * result.outputTokens,
                occurred_at: now.toISOString(),
                metadata: { model: config.model, provider: config.provider },
            });
        }

        if (rows.length > 0) {
            await fastify.supabaseAdmin.from('usage_events').insert(rows);
        }
    } catch (err) {
        fastify.log.warn({ err, organizationId }, '[LlmConfig] Falló el registro de consumo en usage_events');
    }
}

const VALIDATION_PROMPT = 'ping';
const VALIDATION_MAX_OUTPUT_TOKENS = 5;

const ERROR_MESSAGES: Record<LlmProviderErrorKind, string> = {
    invalid_key: 'La llave no es válida. Verifica que la copiaste completa desde el panel del proveedor.',
    no_credit: 'La cuenta del proveedor no tiene saldo o crédito disponible. Agrega saldo y vuelve a intentar.',
    model_not_found: 'El modelo configurado no existe o no está disponible para esta llave. Revisa el nombre del modelo.',
    network_error: 'No se pudo contactar al proveedor en este momento. Puede ser una falla temporal — intenta de nuevo en unos minutos.',
    unknown: 'El proveedor devolvió un error inesperado al validar la llave. Intenta de nuevo; si persiste, contacta a soporte.',
};

export type ValidateLlmCredentialsErrorKind = LlmProviderErrorKind | 'not_configured';

export interface ValidateLlmCredentialsResult {
    success: boolean;
    validatedAt?: string;
    error?: string;
    kind?: ValidateLlmCredentialsErrorKind;
}

/**
 * Hace una llamada real y barata al proveedor configurado para confirmar que
 * la llave BYOK funciona (A.5 de docs/tasks/reportes-semanales.md). Nunca
 * propaga el error crudo del proveedor — siempre un mensaje accionable en
 * español. Persiste `validatedAt`/`lastError` en `integration_settings.llm`
 * y, en éxito, registra el consumo de tokens en `usage_events`.
 */
export async function validateLlmCredentials(
    fastify: FastifyInstance,
    organizationId: string
): Promise<ValidateLlmCredentialsResult> {
    const config = await getLlmConfig(fastify, organizationId);

    if (!config.provider || !config.model) {
        return {
            success: false,
            kind: 'not_configured',
            error: 'No hay proveedor ni modelo de LLM configurado para esta organización.',
        };
    }

    const apiKey = await getSecret(organizationId, SECRET_KEYS.LLM_API_KEY);
    if (!apiKey) {
        const message = 'No hay una llave de LLM guardada para esta organización.';
        await persistValidationResult(fastify, organizationId, { lastError: message });
        return { success: false, kind: 'not_configured', error: message };
    }

    const provider = LlmProviderFactory.getProvider(config.provider);

    try {
        const result = await provider.complete({
            apiKey,
            model: config.model,
            prompt: VALIDATION_PROMPT,
            baseUrl: config.baseUrl ?? undefined,
            maxOutputTokens: VALIDATION_MAX_OUTPUT_TOKENS,
        });

        const validatedAt = new Date().toISOString();
        await persistValidationResult(fastify, organizationId, { validatedAt, lastError: null });
        await recordLlmUsage(fastify, organizationId, config, result);

        fastify.log.info({ organizationId, provider: config.provider }, '[LlmConfig] Validación de credenciales de LLM exitosa');
        return { success: true, validatedAt };
    } catch (err) {
        const kind: LlmProviderErrorKind = err instanceof LlmProviderError ? err.kind : 'unknown';
        const message = ERROR_MESSAGES[kind];

        fastify.log.warn(
            {
                organizationId,
                provider: config.provider,
                kind,
                providerMessage: err instanceof LlmProviderError ? err.providerMessage : (err as Error).message,
            },
            '[LlmConfig] Validación de credenciales de LLM falló'
        );

        await persistValidationResult(fastify, organizationId, { lastError: message });
        return { success: false, kind, error: message };
    }
}
