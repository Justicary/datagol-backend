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

    it('utiliza params.agentId como effectiveAgentId si viene especificado, en lugar del agent_id de la organización', async () => {
        let sentBody: any = null;
        vi.spyOn(global, 'fetch').mockImplementation(async (_input, init) => {
            sentBody = JSON.parse((init as any).body);
            return new Response(JSON.stringify({ conversation_id: 'conv_custom_agent_123' }), { status: 200 });
        });

        const adapter = new ElevenLabsAdapter();
        const result = await adapter.triggerOutboundCall(
            { ...baseParams, agentId: 'agent_override_789' },
            orgConfig
        );

        expect(result.callId).toBe('conv_custom_agent_123');
        expect(sentBody.agent_id).toBe('agent_override_789');
    });

    it('reenvía customVariables tanto en dynamic_variables de primer nivel como dentro de conversation_initiation_client_data', async () => {
        let sentBody: any = null;
        vi.spyOn(global, 'fetch').mockImplementation(async (_input, init) => {
            sentBody = JSON.parse((init as any).body);
            return new Response(JSON.stringify({ conversation_id: 'conv_custom_vars_123' }), { status: 200 });
        });

        const adapter = new ElevenLabsAdapter();
        await adapter.triggerOutboundCall(
            {
                ...baseParams,
                customVariables: {
                    lead_source: 'campaña_meta',
                    score: 95 as any,
                },
            },
            orgConfig
        );

        expect(sentBody.dynamic_variables.lead_source).toBe('campaña_meta');
        expect(sentBody.dynamic_variables.score).toBe(95);
        expect(sentBody.conversation_initiation_client_data.dynamic_variables.lead_source).toBe('campaña_meta');
        expect(sentBody.conversation_initiation_client_data.dynamic_variables.score).toBe(95);
        expect(sentBody.agent_id).toBe('agent-test-123');
    });

    it('incluye customer_email, business_sector, lead_source, source_detail y verbaliza sutilmente source_detail en custom_greeting', async () => {
        let sentBody: any = null;
        vi.spyOn(global, 'fetch').mockImplementation(async (_input, init) => {
            sentBody = JSON.parse((init as any).body);
            return new Response(JSON.stringify({ conversation_id: 'conv_detail_123' }), { status: 200 });
        });

        const adapter = new ElevenLabsAdapter();
        await adapter.triggerOutboundCall(
            {
                ...baseParams,
                customerEmail: 'prospecto@ejemplo.com',
                businessSector: 'Ferretería y Construcción',
                leadSource: 'redes_sociales',
                sourceDetail: 'Instagram Ads',
            },
            orgConfig
        );

        expect(sentBody.dynamic_variables.customer_email).toBe('prospecto@ejemplo.com');
        expect(sentBody.dynamic_variables.business_sector).toBe('Ferretería y Construcción');
        expect(sentBody.dynamic_variables.lead_source).toBe('redes_sociales');
        expect(sentBody.dynamic_variables.source_detail).toBe('Instagram Ads');
        expect(sentBody.dynamic_variables.custom_greeting).toContain('Veo que nos encontraste a través de Instagram Ads.');
        expect(sentBody.conversation_initiation_client_data.dynamic_variables.customer_email).toBe('prospecto@ejemplo.com');
    });

    it('verbaliza leadSource amigablemente cuando no se proporcionó sourceDetail específico', async () => {
        let sentBody: any = null;
        vi.spyOn(global, 'fetch').mockImplementation(async (_input, init) => {
            sentBody = JSON.parse((init as any).body);
            return new Response(JSON.stringify({ conversation_id: 'conv_lead_src_123' }), { status: 200 });
        });

        const adapter = new ElevenLabsAdapter();
        await adapter.triggerOutboundCall(
            {
                ...baseParams,
                leadSource: 'redes_sociales',
            },
            orgConfig
        );

        expect(sentBody.dynamic_variables.custom_greeting).toContain('Veo que nos encontraste por redes sociales.');
    });
});

/**
 * Retención/privacidad del agente — pendiente con exposición legal
 * (transcripciones completas de personas reales, deletion_settings en null).
 * `retention_days`/`record_voice` están documentados
 * (https://elevenlabs.io/docs/agents-platform/customization/privacy/retention
 * y /audio-saving); `delete_transcript_and_pii`/`delete_audio`/
 * `apply_to_existing_conversations` NO — se descubrieron leyendo de vuelta
 * el agente real tras un primer PATCH que solo mandaba los dos campos
 * documentados: `retention_days` por sí solo no activaba ningún borrado.
 */
describe('ElevenLabsAdapter.syncAgentPrivacySettings', () => {
    const fullSettings = {
        retentionDays: 30,
        recordVoice: true,
        deleteTranscriptAndPii: true,
        deleteAudio: true,
        applyToExistingConversations: true,
    };

    beforeEach(() => {
        vi.restoreAllMocks();
    });

    it('manda los 5 campos de platform_settings.privacy en el PATCH al agente', async () => {
        let capturedBody: any = null;
        const spy = vi.spyOn(global, 'fetch').mockImplementation(async (input, init) => {
            const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
            if (url.startsWith('https://api.elevenlabs.io/')) {
                capturedBody = JSON.parse(init?.body as string);
                return new Response(JSON.stringify({}), { status: 200 });
            }
            return realFetch(input as any, init);
        });

        const adapter = new ElevenLabsAdapter();
        const ok = await adapter.syncAgentPrivacySettings('test-api-key', 'agent-test-123', fullSettings);

        expect(ok).toBe(true);
        expect(capturedBody).toEqual({
            platform_settings: {
                privacy: {
                    retention_days: 30,
                    record_voice: true,
                    delete_transcript_and_pii: true,
                    delete_audio: true,
                    apply_to_existing_conversations: true,
                },
            },
        });
        expect(spy).toHaveBeenCalledWith(
            'https://api.elevenlabs.io/v1/convai/agents/agent-test-123',
            expect.objectContaining({ method: 'PATCH' })
        );
    });

    it('contraparte de éxito: respeta valores explícitos distintos (delete_transcript_and_pii=false, apply_to_existing_conversations=false)', async () => {
        let capturedBody: any = null;
        vi.spyOn(global, 'fetch').mockImplementation(async (input, init) => {
            const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
            if (url.startsWith('https://api.elevenlabs.io/')) {
                capturedBody = JSON.parse(init?.body as string);
                return new Response(JSON.stringify({}), { status: 200 });
            }
            return realFetch(input as any, init);
        });

        const adapter = new ElevenLabsAdapter();
        await adapter.syncAgentPrivacySettings('test-api-key', 'agent-test-123', {
            ...fullSettings,
            deleteTranscriptAndPii: false,
            applyToExistingConversations: false,
        });

        expect(capturedBody.platform_settings.privacy.delete_transcript_and_pii).toBe(false);
        expect(capturedBody.platform_settings.privacy.apply_to_existing_conversations).toBe(false);
    });

    it('contraparte de rechazo: sin apiKey ni agentId, lanza sin llegar a hacer la petición', async () => {
        const spy = vi.spyOn(global, 'fetch');
        const adapter = new ElevenLabsAdapter();

        await expect(adapter.syncAgentPrivacySettings('', '', fullSettings)).rejects.toThrow(/Se requiere API Key y Agent ID/);
        expect(spy).not.toHaveBeenCalled();
    });

    it('contraparte de rechazo: si ElevenLabs responde con error, devuelve false en vez de lanzar', async () => {
        mockElevenLabsFetchOnce(new Response(JSON.stringify({ detail: 'agent not found' }), { status: 404 }));

        const adapter = new ElevenLabsAdapter();
        const ok = await adapter.syncAgentPrivacySettings('test-api-key', 'agent-inexistente', fullSettings);

        expect(ok).toBe(false);
    });
});
