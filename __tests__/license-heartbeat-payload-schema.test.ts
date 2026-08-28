import { describe, it, expect } from 'vitest';
import { licenseHeartbeatPayloadSchema } from '../src/services/license-heartbeat-payload.js';

const validPayload = {
    health: {
        installedVersion: '1.0.0',
        databaseOk: true,
        queueOk: true,
        toolLatencyP95Ms: 120,
        errorCount5xx: 0,
    },
    periodCounts: {
        conversations: 12,
        appointments: 4,
        prospects: 12,
    },
    usageUsdByProvider: { elevenlabs: 3.5, telnyx: 1.2 },
    activeFeatures: ['whatsapp', 'reportes'],
    seatsUsed: 3,
    fingerprint: 'fp-abc',
};

describe('src/services/license-heartbeat-payload.ts — esquema cerrado (Fase B.2)', () => {
    it('contraparte de éxito: un payload agregado válido se acepta tal cual', () => {
        const result = licenseHeartbeatPayloadSchema.safeParse(validPayload);
        expect(result.success).toBe(true);
    });

    it.each([
        ['contacts', { contacts: [{ name: 'Juan Pérez', phone: '+525599990000' }] }],
        ['leads', { leads: [{ email: 'juan@example.com' }] }],
        ['appointments', { appointments: [{ customerName: 'Ana' }] }],
        ['transcript', { transcript: 'Hola, buenas tardes...' }],
        ['phone', { phone: '+525599990000' }],
        ['email', { email: 'cliente@example.com' }],
    ])('rechaza un payload con el campo de PII "%s" en el nivel superior', (_label, extra) => {
        const result = licenseHeartbeatPayloadSchema.safeParse({ ...validPayload, ...extra });
        expect(result.success).toBe(false);
    });

    it('rechaza PII colada dentro de un objeto anidado permitido (health)', () => {
        const tampered = { ...validPayload, health: { ...validPayload.health, phone: '+525599990000' } };
        const result = licenseHeartbeatPayloadSchema.safeParse(tampered);
        expect(result.success).toBe(false);
    });

    it('rechaza campos numéricos con nombres de PII disfrazados de conteo (ej. "contactsCount" no está en la lista permitida)', () => {
        const tampered = { ...validPayload, periodCounts: { ...validPayload.periodCounts, contactsCount: 5 } };
        const result = licenseHeartbeatPayloadSchema.safeParse(tampered);
        expect(result.success).toBe(false);
    });

    it('rechaza cuando falta un campo obligatorio', () => {
        const { seatsUsed: _omitted, ...withoutSeats } = validPayload;
        const result = licenseHeartbeatPayloadSchema.safeParse(withoutSeats);
        expect(result.success).toBe(false);
    });

    it('acepta fingerprint nulo (instalación sin huella asignada aún)', () => {
        const result = licenseHeartbeatPayloadSchema.safeParse({ ...validPayload, fingerprint: null });
        expect(result.success).toBe(true);
    });
});
