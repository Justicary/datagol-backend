/**
 * Códigos de clasificación de error de un proveedor de LLM. El resto del
 * sistema (llm-config-service) traduce cada `kind` a un mensaje accionable
 * en español — nunca propaga el mensaje crudo del proveedor.
 */
export type LlmProviderErrorKind =
    | 'invalid_key'
    | 'no_credit'
    | 'model_not_found'
    | 'network_error'
    | 'unknown';

export class LlmProviderError extends Error {
    readonly kind: LlmProviderErrorKind;
    /** Mensaje crudo del proveedor, solo para logs internos — nunca se expone al cliente. */
    readonly providerMessage?: string;

    constructor(kind: LlmProviderErrorKind, providerMessage?: string) {
        super(`Error de proveedor LLM (${kind})${providerMessage ? `: ${providerMessage}` : ''}`);
        this.name = 'LlmProviderError';
        this.kind = kind;
        this.providerMessage = providerMessage;
    }
}

export interface LlmCompletionParams {
    apiKey: string;
    model: string;
    prompt: string;
    /** Solo aplica al adaptador de OpenRouter/OpenAI-compatible. */
    baseUrl?: string;
    /** Límite de tokens de salida — el llamador lo mantiene bajo para validaciones baratas. */
    maxOutputTokens?: number;
}

export interface LlmCompletionResult {
    text: string;
    inputTokens: number;
    outputTokens: number;
}

/**
 * Interfaz mínima de un proveedor de LLM: completar un prompt, devolver
 * texto y conteo de tokens. Nada del resto del sistema debe saber qué
 * proveedor está detrás de esta interfaz (mismo principio que
 * `IVoiceProvider` en services/providers/voice-provider.interface.ts).
 */
export interface ILlmProvider {
    complete(params: LlmCompletionParams): Promise<LlmCompletionResult>;
}
