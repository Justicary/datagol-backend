import { describe, it, expect, vi, beforeEach } from 'vitest';
import { ElevenLabsAdapter } from '../src/services/providers/ElevenLabsAdapter.js';

/**
 * Mockea `global.fetch` solo para `api.elevenlabs.io`, mismo criterio que
 * __tests__/cal-com-tool-client.test.ts: la llamada real a ElevenLabs cuesta
 * dinero y depende de credenciales de producción, así que se mockea; nada
 * más en este test hace red saliente.
 */
const realFetch = global.fetch;

function mockElevenLabsFetchOnce(response: Response) {
    return vi.spyOn(global, 'fetch').mockImplementation(async (input, init) => {
        const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
        if (url.startsWith('https://api.elevenlabs.io/')) {
            return response;
        }
        return realFetch(input as any, init);
    });
}

describe('ElevenLabsAdapter.triggerOutboundCall', () => {
    const baseParams = {
        organizationId: 'org-test',
        customerPhone: '+522221234567',
        customerName: 'Juana Pérez',
        companyName: 'Ferretería Pérez',
        demoObjective: 'Probar agente de voz en vivo',
    };

    // elevenlabs_phone_number_id explícito evita el fetch adicional de
    // resolución dinámica de /convai/phone-numbers — no es lo que este test ejercita.
    const orgConfig = {
        elevenlabs_api_key: 'test-api-key',
        elevenlabs_agent_id: 'agent-test-123',
        elevenlabs_phone_number_id: 'phone-test-456',
    };

    beforeEach(() => {
        vi.restoreAllMocks();
    });

    it('devuelve el conversation_id real cuando ElevenLabs lo incluye en la respuesta', async () => {
        mockElevenLabsFetchOnce(new Response(JSON.stringify({ conversation_id: 'conv_real_123' }), { status: 200 }));

        const adapter = new ElevenLabsAdapter();
        const result = await adapter.triggerOutboundCall(baseParams, orgConfig);

        expect(result.callId).toBe('conv_real_123');
        expect(result.status).toBe('queued');
        expect(result.provider).toBe('elevenlabs');
    });

    it('acepta call_id como respaldo cuando la respuesta no trae conversation_id', async () => {
        mockElevenLabsFetchOnce(new Response(JSON.stringify({ call_id: 'call_real_456' }), { status: 200 }));

        const adapter = new ElevenLabsAdapter();
        const result = await adapter.triggerOutboundCall(baseParams, orgConfig);

        expect(result.callId).toBe('call_real_456');
    });

    it('nunca inventa un conversation_id sintético: lanza si la respuesta no trae ni conversation_id ni call_id — un ID inventado nunca coincidiría con el conversation_id real del webhook (docs/tasks/outbound-lead-persistence-and-rate-limit.md, 1.4)', async () => {
        mockElevenLabsFetchOnce(new Response(JSON.stringify({ success: true }), { status: 200 }));

        const adapter = new ElevenLabsAdapter();
        await expect(adapter.triggerOutboundCall(baseParams, orgConfig)).rejects.toThrow(
            /no devolvió conversation_id ni call_id/
        );
    });
});
