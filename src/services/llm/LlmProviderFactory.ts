import { ILlmProvider } from './llm-provider.interface.js';
import { OpenAiCompatibleAdapter } from './adapters/OpenAiCompatibleAdapter.js';
import { AnthropicAdapter } from './adapters/AnthropicAdapter.js';
import { GoogleAdapter } from './adapters/GoogleAdapter.js';
import { LLM_PROVIDERS, type LlmProvider } from '../../types/llm-providers.js';
import { logger } from '../../lib/logger.js';

/**
 * Resuelve el adaptador de LLM por proveedor. Nada del resto del sistema
 * debe saber qué proveedor está en uso — mismo patrón que
 * `services/providers/VoiceProviderFactory.ts`.
 */
export class LlmProviderFactory {
    private static openAiCompatibleInstance = new OpenAiCompatibleAdapter();
    private static anthropicInstance = new AnthropicAdapter();
    private static googleInstance = new GoogleAdapter();

    static getProvider(provider: LlmProvider): ILlmProvider {
        switch (provider) {
            case LLM_PROVIDERS.OPENAI:
            case LLM_PROVIDERS.OPENROUTER:
                return this.openAiCompatibleInstance;
            case LLM_PROVIDERS.ANTHROPIC:
                return this.anthropicInstance;
            case LLM_PROVIDERS.GOOGLE:
                return this.googleInstance;
            default:
                logger.warn({ provider }, '[LlmProviderFactory] Proveedor desconocido, usando OpenAI-compatible por defecto');
                return this.openAiCompatibleInstance;
        }
    }
}
