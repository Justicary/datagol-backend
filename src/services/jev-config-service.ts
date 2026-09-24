import { FastifyInstance } from 'fastify';
import { getSecret } from './secret-service.js';
import { fetchOpenRouterKeyInfo } from './jev/openrouter-key-client.js';
import { LlmProviderError, type LlmProviderErrorKind } from './llm/llm-provider.interface.js';
import { SECRET_KEYS } from '../types/secret-keys.js';

/**
 * Configuración BYOK de Jev (TypeSafe AI) vía OpenRouter, guardada en
 * `integration_settings.jev`. Es deliberadamente independiente de
 * `integration_settings.llm` (llm-config-service.ts): Jev no redacta texto,
 * así que una organización que lo use sigue necesitando su LLM para reportes
 * y narrativas. El proveedor es siempre OpenRouter — por eso aquí no hay
 * `provider` ni `baseUrl`.
 */
export interface JevConfig {
    model: string | null;
    validatedAt: string | null;
    lastError: string | null;
}

function readJevConfig(integrationSettings: Record<string, unknown> | null): JevConfig {
    const raw = (integrationSettings?.jev ?? {}) as Partial<JevConfig>;
    return {
        model: typeof raw.model === 'string' ? raw.model : null,
        validatedAt: typeof raw.validatedAt === 'string' ? raw.validatedAt : null,
        lastError: typeof raw.lastError === 'string' ? raw.lastError : null,
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

async function writeJevConfig(
    fastify: FastifyInstance,
    organizationId: string,
    currentSettings: Record<string, unknown>,
    jevConfig: JevConfig
): Promise<boolean> {
    const { error } = await fastify.supabaseAdmin
        .from('organizations')
        .update({
            integration_settings: { ...currentSettings, jev: jevConfig },
            updated_at: new Date().toISOString(),
        })
        .eq('id', organizationId);

    if (error) {
        fastify.log.error({ err: error.message, organizationId }, '[JevConfig] Error guardando configuración de Jev');
        return false;
    }
    return true;
}

/**
 * Lee `integration_settings.jev`. Devuelve todo `null` si nunca se
 * configuró — nunca lanza.
 */
export async function getJevConfig(fastify: FastifyInstance, organizationId: string): Promise<JevConfig> {
    return readJevConfig(await readIntegrationSettings(fastify, organizationId));
}

/**
 * `true` solo si hay modelo configurado y la validación más reciente de la
 * llave fue exitosa. Mismo criterio que `isLlmConfigValidated()`:
 * `validateJevCredentials()` siempre limpia `lastError` en éxito y siempre lo
 * fija en fallo.
 */
export async function isJevConfigValidated(fastify: FastifyInstance, organizationId: string): Promise<boolean> {
    const config = await getJevConfig(fastify, organizationId);
    return Boolean(config.model) && config.validatedAt !== null && config.lastError === null;
}

/**
 * Guarda el modelo de Jev a usar. Cambiarlo invalida cualquier validación
 * previa (`validatedAt`/`lastError` a `null`), igual que en el LLM BYOK.
 */
export async function updateJevConfig(
    fastify: FastifyInstance,
    organizationId: string,
    params: { model: string }
): Promise<{ success: boolean; error?: string }> {
    const currentSettings = await readIntegrationSettings(fastify, organizationId);
    const saved = await writeJevConfig(fastify, organizationId, currentSettings, {
        model: params.model,
        validatedAt: null,
        lastError: null,
    });
    return saved ? { success: true } : { success: false, error: 'No se pudo guardar la configuración de Jev.' };
}

async function persistValidationResult(
    fastify: FastifyInstance,
    organizationId: string,
    patch: { validatedAt?: string; lastError: string | null }
): Promise<void> {
    const currentSettings = await readIntegrationSettings(fastify, organizationId);
    const current = readJevConfig(currentSettings);
    await writeJevConfig(fastify, organizationId, currentSettings, {
        ...current,
        validatedAt: patch.validatedAt ?? current.validatedAt,
        lastError: patch.lastError,
    });
}

const ERROR_MESSAGES: Record<LlmProviderErrorKind, string> = {
    invalid_key: 'La llave de OpenRouter no es válida. Verifica que la copiaste completa desde openrouter.ai/keys.',
    no_credit: 'La cuenta de OpenRouter no tiene saldo o la llave agotó su límite de gasto. Agrega crédito y vuelve a intentar.',
    model_not_found: 'El modelo configurado no está disponible en OpenRouter para esta llave. Revisa el nombre del modelo.',
    network_error: 'No se pudo contactar a OpenRouter en este momento. Puede ser una falla temporal — intenta de nuevo en unos minutos.',
    unknown: 'OpenRouter devolvió un error inesperado al validar la llave. Intenta de nuevo; si persiste, contacta a soporte.',
};

export type ValidateJevCredentialsErrorKind = LlmProviderErrorKind | 'not_configured';

export interface ValidateJevCredentialsResult {
    success: boolean;
    validatedAt?: string;
    error?: string;
    kind?: ValidateJevCredentialsErrorKind;
}

/**
 * Confirma que la llave de OpenRouter de la organización funciona, vía
 * `GET /api/v1/key` (no consume tokens). Una llave con tope de gasto agotado
 * (`limit_remaining <= 0`) se reporta como `no_credit` aunque OpenRouter
 * responda 200 — si no, la primera evaluación real fallaría con 402 dentro de
 * un job. Nunca propaga el error crudo del proveedor.
 */
export async function validateJevCredentials(
    fastify: FastifyInstance,
    organizationId: string
): Promise<ValidateJevCredentialsResult> {
    const config = await getJevConfig(fastify, organizationId);

    if (!config.model) {
        return {
            success: false,
            kind: 'not_configured',
            error: 'No hay un modelo de Jev configurado para esta organización.',
        };
    }

    const apiKey = await getSecret(organizationId, SECRET_KEYS.JEV_API_KEY);
    if (!apiKey) {
        const message = 'No hay una llave de OpenRouter para Jev guardada para esta organización.';
        await persistValidationResult(fastify, organizationId, { lastError: message });
        return { success: false, kind: 'not_configured', error: message };
    }

    try {
        const keyInfo = await fetchOpenRouterKeyInfo(apiKey);
        if (keyInfo.limitRemaining !== null && keyInfo.limitRemaining <= 0) {
            throw new LlmProviderError('no_credit', 'limit_remaining <= 0');
        }

        const validatedAt = new Date().toISOString();
        await persistValidationResult(fastify, organizationId, { validatedAt, lastError: null });

        fastify.log.info({ organizationId }, '[JevConfig] Validación de la llave de OpenRouter para Jev exitosa');
        return { success: true, validatedAt };
    } catch (err) {
        const kind: LlmProviderErrorKind = err instanceof LlmProviderError ? err.kind : 'unknown';
        const message = ERROR_MESSAGES[kind];

        fastify.log.warn(
            {
                organizationId,
                kind,
                providerMessage: err instanceof LlmProviderError ? err.providerMessage : (err as Error).message,
            },
            '[JevConfig] Validación de la llave de OpenRouter para Jev falló'
        );

        await persistValidationResult(fastify, organizationId, { lastError: message });
        return { success: false, kind, error: message };
    }
}
