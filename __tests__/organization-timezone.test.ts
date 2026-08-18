import { describe, it, expect } from 'vitest';
import { extractTimezoneFromElevenLabsPayload } from '../src/services/elevenlabs-timezone.js';

describe('services/elevenlabs-timezone.ts', () => {
    it('devuelve null ante un payload vacío o no-objeto', () => {
        expect(extractTimezoneFromElevenLabsPayload(null)).toBeNull();
        expect(extractTimezoneFromElevenLabsPayload(undefined)).toBeNull();
        expect(extractTimezoneFromElevenLabsPayload('string')).toBeNull();
        expect(extractTimezoneFromElevenLabsPayload({})).toBeNull();
    });

    it('devuelve null cuando data.metadata no trae timezone (esquema real verificado hoy)', () => {
        const payload = {
            type: 'post_call_transcription',
            data: {
                agent_id: 'agent_1',
                conversation_id: 'conv_1',
                metadata: { call_duration_secs: 120, start_time_unix_secs: 1700000000 },
            },
        };
        expect(extractTimezoneFromElevenLabsPayload(payload)).toBeNull();
    });

    it('extrae data.metadata.timezone si viene y es un IANA válido', () => {
        const payload = { data: { metadata: { timezone: 'America/Mexico_City' } } };
        expect(extractTimezoneFromElevenLabsPayload(payload)).toBe('America/Mexico_City');
    });

    it('extrae data.metadata.time_zone (variante de nombre de campo) si es válido', () => {
        const payload = { data: { metadata: { time_zone: 'America/Monterrey' } } };
        expect(extractTimezoneFromElevenLabsPayload(payload)).toBe('America/Monterrey');
    });

    it('extrae la variable dinámica de sistema system__time_zone', () => {
        const payload = {
            data: {
                conversation_initiation_client_data: {
                    dynamic_variables: { system__time_zone: 'America/Tijuana' },
                },
            },
        };
        expect(extractTimezoneFromElevenLabsPayload(payload)).toBe('America/Tijuana');
    });

    it('ignora un valor que no es un identificador IANA válido', () => {
        const payload = { data: { metadata: { timezone: 'Not/A_Real_Zone' } } };
        expect(extractTimezoneFromElevenLabsPayload(payload)).toBeNull();
    });

    it('funciona también si se le pasa directamente el objeto "data" sin envoltura raíz', () => {
        const payload = { metadata: { timezone: 'America/Mexico_City' } };
        expect(extractTimezoneFromElevenLabsPayload(payload)).toBe('America/Mexico_City');
    });
});
