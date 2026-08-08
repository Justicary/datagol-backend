import { describe, it, expect } from 'vitest';
import { mapElevenLabsPayload } from '../src/services/call-payload-mapper.js';

function buildPayload(overrides: {
    type?: string;
    dataCollectionResults?: Record<string, unknown>;
    phoneCall?: { external_number?: string } | null;
    transcript?: Array<{ role: string; message: string }>;
} = {}) {
    return {
        type: overrides.type ?? 'post_call_transcription',
        event_timestamp: 1700000000,
        data: {
            agent_id: 'agent_123',
            conversation_id: 'conv_abc',
            transcript: overrides.transcript ?? [
                { role: 'agent', message: 'Hola, ¿en qué puedo ayudarte?' },
                { role: 'user', message: 'Quiero cotizar un servicio.' },
            ],
            analysis: {
                transcript_summary: 'El cliente pidió una cotización.',
                data_collection_results: overrides.dataCollectionResults,
            },
            metadata: {
                call_duration_secs: 185,
                phone_call: overrides.phoneCall,
            },
        },
    };
}

describe('2.2 — Mapeo del payload de post-llamada de ElevenLabs a leads', () => {
    it('mapea todas las claves de data_collection_results configuradas en el agente', () => {
        const payload = buildPayload({
            dataCollectionResults: {
                nombre_completo_prospecto: { value: 'Juana Pérez' },
                telefono_contacto_prospecto: { value: '2221234567' },
                correo_electronico_prospecto: { value: 'juana@example.com' },
                motivo_consulta: { value: 'Cotización de instalación' },
                cita_programada: { value: true },
                nombre_negocio: { value: 'Ferretería Pérez' },
                giro_negocio: { value: 'Ferretería' },
                temperatura: { value: 'caliente' },
                requiere_seguimiento: { value: true },
                notas_seguimiento: { value: 'Llamar mañana para confirmar horario' },
                volumen_llamadas: { value: '10-20 al día' },
            },
        });

        const mapped = mapElevenLabsPayload(payload);

        expect(mapped).not.toBeNull();
        expect(mapped!.fullName).toBe('Juana Pérez');
        expect(mapped!.email).toBe('juana@example.com');
        expect(mapped!.inquiryReason).toBe('Cotización de instalación');
        expect(mapped!.bookedAppointment).toBe(true);
        expect(mapped!.businessName).toBe('Ferretería Pérez');
        expect(mapped!.businessSector).toBe('Ferretería');
        expect(mapped!.temperature).toBe('caliente');
        expect(mapped!.needsFollowup).toBe(true);
        expect(mapped!.followupNotes).toBe('Llamar mañana para confirmar horario');
        expect(mapped!.callVolume).toBe('10-20 al día');
        // Sin número de telefonía SIP, usa el teléfono dictado y lo normaliza a E.164
        expect(mapped!.callerPhoneE164).toBe('+522221234567');
        expect(mapped!.conversationId).toBe('conv_abc');
        expect(mapped!.providerCallId).toBe('conv_abc');
        expect(mapped!.durationSeconds).toBe(185);
    });

    it('mapea el payload real de producción: solo los 5 campos que el agente captura hoy, el resto queda null/false sin lanzar (docs/tasks/elevenlabs-data-collection-key-mismatch.md)', () => {
        const payload = buildPayload({
            dataCollectionResults: {
                nombre_completo_prospecto: { value: 'Juana Pérez' },
                telefono_contacto_prospecto: { value: '2221234567' },
                correo_electronico_prospecto: { value: 'juana@example.com' },
                motivo_consulta: { value: 'Cotización de instalación' },
                cita_programada: { value: true },
                // nombre_negocio/giro_negocio/temperatura/requiere_seguimiento/
                // notas_seguimiento/volumen_llamadas: el agente aún no los
                // captura — ausentes, como en la captura real.
            },
        });

        const mapped = mapElevenLabsPayload(payload);

        expect(mapped).not.toBeNull();
        expect(mapped!.fullName).toBe('Juana Pérez');
        expect(mapped!.contactPhoneRaw).toBe('2221234567');
        expect(mapped!.callerPhoneE164).toBe('+522221234567');
        expect(mapped!.email).toBe('juana@example.com');
        expect(mapped!.inquiryReason).toBe('Cotización de instalación');
        expect(mapped!.bookedAppointment).toBe(true);

        expect(mapped!.businessName).toBeNull();
        expect(mapped!.businessSector).toBeNull();
        expect(mapped!.temperature).toBeNull();
        expect(mapped!.needsFollowup).toBe(false);
        expect(mapped!.followupNotes).toBeNull();
        expect(mapped!.callVolume).toBeNull();
    });

    it('regla de honestidad de datos: sin data_collection_results, todos los campos quedan vacíos, ninguno inventado', () => {
        const payload = buildPayload({ dataCollectionResults: undefined });
        const mapped = mapElevenLabsPayload(payload);

        expect(mapped).not.toBeNull();
        expect(mapped!.fullName).toBeNull();
        expect(mapped!.email).toBeNull();
        expect(mapped!.businessName).toBeNull();
        expect(mapped!.businessSector).toBeNull();
        expect(mapped!.inquiryReason).toBeNull();
        expect(mapped!.temperature).toBeNull();
        expect(mapped!.followupNotes).toBeNull();
        expect(mapped!.callVolume).toBeNull();
        expect(mapped!.callerPhoneE164).toBeNull();
        expect(mapped!.contactPhoneRaw).toBeNull();
        // Booleanos ausentes toman el valor neutro por defecto (false), no se infieren como true.
        expect(mapped!.bookedAppointment).toBe(false);
        expect(mapped!.needsFollowup).toBe(false);
    });

    it('no infiere email/teléfono/nombre a partir de la transcripción cuando data_collection_results no los trae', () => {
        const payload = buildPayload({
            dataCollectionResults: undefined,
            transcript: [
                { role: 'user', message: 'Soy Carlos Ramírez, mi correo es carlos@example.com y mi número es 5512345678' },
            ],
        });
        const mapped = mapElevenLabsPayload(payload);

        expect(mapped!.fullName).toBeNull();
        expect(mapped!.email).toBeNull();
        expect(mapped!.callerPhoneE164).toBeNull();
    });

    it('una temperatura fuera del CHECK constraint de leads.temperature se guarda como null, no se fuerza', () => {
        const payload = buildPayload({
            dataCollectionResults: {
                temperatura: { value: 'muy caliente' }, // no está en LEAD_TEMPERATURES
            },
        });
        const mapped = mapElevenLabsPayload(payload);
        expect(mapped!.temperature).toBeNull();
    });

    it('prioriza el número de telefonía (SIP) sobre el teléfono dictado por voz', () => {
        const payload = buildPayload({
            phoneCall: { external_number: '+522231234567' },
            dataCollectionResults: {
                telefono_contacto_prospecto: { value: '111' }, // número inválido/dictado erróneamente
            },
        });
        const mapped = mapElevenLabsPayload(payload);

        expect(mapped!.callerPhoneE164).toBe('+522231234567');
        expect(mapped!.contactPhoneRaw).toBe('111');
    });

    it('un número de teléfono inválido no aborta el mapeo del lead (queda sin contact_id)', () => {
        const payload = buildPayload({
            dataCollectionResults: {
                telefono_contacto_prospecto: { value: '123' },
                nombre_completo_prospecto: { value: 'Prospecto sin teléfono válido' },
            },
        });
        const mapped = mapElevenLabsPayload(payload);

        expect(mapped).not.toBeNull();
        expect(mapped!.callerPhoneE164).toBeNull();
        expect(mapped!.fullName).toBe('Prospecto sin teléfono válido');
    });

    it('devuelve null para tipos de evento fuera de alcance (p. ej. post_call_audio)', () => {
        const payload = buildPayload({ type: 'post_call_audio' });
        const mapped = mapElevenLabsPayload(payload);
        expect(mapped).toBeNull();
    });

    it('acepta valores escalares (no envueltos en { value }) en data_collection_results', () => {
        const payload = buildPayload({
            dataCollectionResults: {
                nombre_completo_prospecto: 'Ana Torres',
                cita_programada: false,
            },
        });
        const mapped = mapElevenLabsPayload(payload);
        expect(mapped!.fullName).toBe('Ana Torres');
        expect(mapped!.bookedAppointment).toBe(false);
    });

    describe('3.1/3.2 — occurredAt y hasPhoneCallLeg (soporte de metering)', () => {
        it('marca hasPhoneCallLeg=true cuando el payload trae metadata.phone_call (llamada real por SIP)', () => {
            const payload = buildPayload({ phoneCall: { external_number: '+522231234567' } });
            const mapped = mapElevenLabsPayload(payload);
            expect(mapped!.hasPhoneCallLeg).toBe(true);
        });

        it('marca hasPhoneCallLeg=false cuando no hay metadata.phone_call (conversación de widget web)', () => {
            const payload = buildPayload({ phoneCall: undefined });
            const mapped = mapElevenLabsPayload(payload);
            expect(mapped!.hasPhoneCallLeg).toBe(false);
        });

        it('no lanza (ni descarta el payload completo) cuando metadata.phone_call llega como null explícito, no ausente — el caso real del widget web que rompió en producción', () => {
            // ElevenLabs manda `phone_call: null` en vez de omitir la clave
            // para llamadas sin tramo telefónico. El resto del código ya
            // maneja null vía optional chaining; el bug real estaba en el
            // schema Zod (`.optional()` rechaza null, solo permite undefined),
            // que descartaba TODO el payload antes de mapear ningún campo.
            const payload = buildPayload({
                phoneCall: null,
                dataCollectionResults: {
                    nombre_completo_prospecto: { value: 'Juana Pérez' },
                    telefono_contacto_prospecto: { value: '2221234567' },
                    correo_electronico_prospecto: { value: 'juana@example.com' },
                    motivo_consulta: { value: 'Cotización de instalación' },
                    cita_programada: { value: true },
                },
            });

            const mapped = mapElevenLabsPayload(payload);

            expect(mapped).not.toBeNull();
            expect(mapped!.hasPhoneCallLeg).toBe(false);
            expect(mapped!.fullName).toBe('Juana Pérez');
            // Sin tramo telefónico SIP, cae al teléfono dictado por voz.
            expect(mapped!.callerPhoneE164).toBe('+522221234567');
        });

        it('usa metadata.start_time_unix_secs para occurredAt cuando está presente', () => {
            const payload: any = buildPayload({});
            payload.data.metadata.start_time_unix_secs = 1700000500;
            const mapped = mapElevenLabsPayload(payload);
            expect(mapped!.occurredAt.getTime()).toBe(1700000500 * 1000);
        });

        it('usa event_timestamp del webhook cuando falta metadata.start_time_unix_secs', () => {
            const payload = buildPayload({}); // event_timestamp: 1700000000 (ver buildPayload)
            const mapped = mapElevenLabsPayload(payload);
            expect(mapped!.occurredAt.getTime()).toBe(1700000000 * 1000);
        });

        it('recae en la hora de mapeo cuando ni start_time_unix_secs ni event_timestamp vienen en el payload', () => {
            const payload: any = buildPayload({});
            delete payload.event_timestamp;
            const before = Date.now();
            const mapped = mapElevenLabsPayload(payload);
            const after = Date.now();
            expect(mapped!.occurredAt.getTime()).toBeGreaterThanOrEqual(before);
            expect(mapped!.occurredAt.getTime()).toBeLessThanOrEqual(after);
        });
    });
});
