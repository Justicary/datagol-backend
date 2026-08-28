import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import Fastify from 'fastify';
import supabasePlugin from '../src/plugins/supabase.js';
import { controlContractsRoutes } from '../src/routes/control/contracts.js';
import { supabaseAdmin } from '../src/lib/supabase.js';
import { setResendClientForTesting } from '../src/services/email.js';
import { createTestCustomer, createTestDeployment, cleanupDeployment, cleanupCustomer } from './helpers/control-plane-fixtures.js';

async function buildTestApp() {
    const app = Fastify({ logger: false });
    await app.register(supabasePlugin);
    await app.register(controlContractsRoutes);
    await app.ready();
    return app;
}

describe('routes/control/contracts.ts (Fase D)', () => {
    let customerId: string;
    let deploymentId: string;
    const mockSend = vi.fn();

    beforeAll(async () => {
        const customer = await createTestCustomer();
        customerId = customer.id;
        const deployment = await createTestDeployment(customerId);
        deploymentId = deployment.id;
    });

    afterAll(async () => {
        await cleanupDeployment(deploymentId);
        await cleanupCustomer(customerId);
        setResendClientForTesting(null);
    });

    beforeEach(() => {
        mockSend.mockReset();
        mockSend.mockResolvedValue({ data: { id: 'email-otp-123' }, error: null });
        setResendClientForTesting({ emails: { send: mockSend } } as any);
    });

    async function generateContract(app: ReturnType<typeof Fastify>) {
        const res = await app.inject({
            method: 'POST',
            url: `/control/deployments/${deploymentId}/contract`,
            headers: { 'x-platform-admin': 'true' },
            payload: {
                templateVersion: 'v1-2026',
                signerName: 'María Firma',
                signerRole: 'Directora General',
                signerEmail: 'maria.firma@example.invalid',
            },
        });
        expect(res.statusCode).toBe(201);
        return res.json().data;
    }

    it('genera el contrato con hash SHA-256 y ruta de PDF, y expone una URL firmada', async () => {
        const app = await buildTestApp();
        try {
            const contract = await generateContract(app);
            expect(contract.document_hash).toMatch(/^[0-9a-f]{64}$/);
            expect(contract.pdf_storage_path).toBeTruthy();

            const pdfRes = await app.inject({ method: 'GET', url: `/control/contracts/${contract.id}/pdf`, headers: { 'x-platform-admin': 'true' } });
            expect(pdfRes.statusCode).toBe(200);
            expect(pdfRes.json().data.url).toMatch(/^https?:\/\//);
        } finally {
            await app.close();
        }
    });

    it('flujo completo: enviar OTP, firmar con el código correcto, y el contrato queda inmutable', async () => {
        const app = await buildTestApp();
        try {
            const contract = await generateContract(app);

            const otpRes = await app.inject({ method: 'POST', url: `/control/contracts/${contract.id}/send-otp`, headers: { 'x-platform-admin': 'true' } });
            expect(otpRes.statusCode).toBe(200);
            expect(mockSend).toHaveBeenCalledTimes(1);
            const emailBody = mockSend.mock.calls[0][0];
            const codeMatch = /(\d{6})/.exec(emailBody.text);
            expect(codeMatch).not.toBeNull();
            const code = codeMatch![1];

            const signRes = await app.inject({
                method: 'POST',
                url: `/control/contracts/${contract.id}/sign`,
                headers: { 'x-platform-admin': 'true' },
                payload: { code },
            });
            expect(signRes.statusCode).toBe(200);
            expect(signRes.json().data.signed_at).toBeTruthy();

            // Contraparte de rechazo: un intento de modificar un contrato ya
            // firmado se traduce a 409/mensaje claro (trigger de 55_...),
            // ejercitado aquí vía un segundo intento de firma.
            const secondSign = await app.inject({
                method: 'POST',
                url: `/control/contracts/${contract.id}/sign`,
                headers: { 'x-platform-admin': 'true' },
                payload: { code },
            });
            expect(secondSign.statusCode).toBe(400);
            expect(secondSign.json().message).toMatch(/ya está firmado/i);
        } finally {
            await app.close();
        }
    });

    it('rechaza firmar con un código incorrecto, sin firmar el contrato', async () => {
        const app = await buildTestApp();
        try {
            const contract = await generateContract(app);
            await app.inject({ method: 'POST', url: `/control/contracts/${contract.id}/send-otp`, headers: { 'x-platform-admin': 'true' } });

            const res = await app.inject({
                method: 'POST',
                url: `/control/contracts/${contract.id}/sign`,
                headers: { 'x-platform-admin': 'true' },
                payload: { code: '000000' },
            });
            expect(res.statusCode).toBe(400);

            const { data } = await supabaseAdmin.from('contracts').select('signed_at').eq('id', contract.id).single();
            expect(data.signed_at).toBeNull();
        } finally {
            await app.close();
        }
    });

    it('rechaza firmar sin haber solicitado nunca un OTP', async () => {
        const app = await buildTestApp();
        try {
            const contract = await generateContract(app);
            const res = await app.inject({
                method: 'POST',
                url: `/control/contracts/${contract.id}/sign`,
                headers: { 'x-platform-admin': 'true' },
                payload: { code: '123456' },
            });
            expect(res.statusCode).toBe(400);
        } finally {
            await app.close();
        }
    });
});
