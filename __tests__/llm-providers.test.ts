import { describe, it, expect } from 'vitest';
import { LLM_PROVIDERS, ALL_LLM_PROVIDERS, isLlmProvider } from '../src/types/llm-providers.js';

// La sincronía de 'llm_api_key' y 'llm' contra los CHECK constraints reales
// de organization_secrets.secret_key y usage_events.provider ya la cubren
// __tests__/secret-keys.test.ts y __tests__/usage-event-provider.test.ts —
// ambos iteran sus respectivos ALL_* dinámicamente, así que recogen los
// valores nuevos sin cambios. Este archivo solo prueba el módulo puro.
describe('src/types/llm-providers.ts', () => {
    it('incluye los 4 proveedores requeridos por A.3 de docs/tasks/reportes-semanales.md', () => {
        expect(ALL_LLM_PROVIDERS.sort()).toEqual(['anthropic', 'google', 'openai', 'openrouter'].sort());
    });

    it.each(ALL_LLM_PROVIDERS)('isLlmProvider("%s") es true', (provider) => {
        expect(isLlmProvider(provider)).toBe(true);
    });

    it('isLlmProvider rechaza valores desconocidos', () => {
        expect(isLlmProvider('cohere')).toBe(false);
        expect(isLlmProvider('')).toBe(false);
    });

    it('los valores del enum coinciden con las claves esperadas', () => {
        expect(LLM_PROVIDERS.ANTHROPIC).toBe('anthropic');
        expect(LLM_PROVIDERS.OPENAI).toBe('openai');
        expect(LLM_PROVIDERS.GOOGLE).toBe('google');
        expect(LLM_PROVIDERS.OPENROUTER).toBe('openrouter');
    });
});
