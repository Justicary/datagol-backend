/**
 * Proveedores de LLM soportados para BYOK (`integration_settings.llm.provider`).
 * Única fuente de verdad: ningún literal de proveedor debe escribirse en otro
 * lugar del código — ver `LlmProviderFactory` (src/services/llm/), que
 * despacha por estos mismos valores.
 */
export const LLM_PROVIDERS = {
    ANTHROPIC: 'anthropic',
    OPENAI: 'openai',
    GOOGLE: 'google',
    OPENROUTER: 'openrouter',
} as const;

export type LlmProvider = (typeof LLM_PROVIDERS)[keyof typeof LLM_PROVIDERS];

export const ALL_LLM_PROVIDERS: readonly LlmProvider[] = Object.values(LLM_PROVIDERS);

export function isLlmProvider(value: string): value is LlmProvider {
    return (ALL_LLM_PROVIDERS as readonly string[]).includes(value);
}
