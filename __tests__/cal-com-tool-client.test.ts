import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { supabaseAdmin } from '../src/lib/supabase.js';
import { setSecret, clearSecretCache } from '../src/services/secret-service.js';
import { SECRET_KEYS } from '../src/types/secret-keys.js';
import {
    getAvailableSlots,
    createBooking,
    rescheduleBooking,
    invalidateAvailabilityCache,
    CalCredentialsMissingError,
    CalProviderError,
} from '../src/services/cal-com-tool-client.js';

/**
 * Pruebas de integración reales contra Supabase Vault (para el secreto
 * cal_api_key) pero con las llamadas HTTP a `api.cal.com` mockeadas: Cal.com
 * es un proveedor de pago con efectos reales (crea eventos de calendario
 * auténticos). A diferencia de la convención del proyecto de probar contra
 * la base de datos real, la red saliente a un tercero de pago SÍ se mockea
 * aquí — el mismo criterio ya aplicado a Resend en
 * __tests__/notify-hot-lead.test.ts.
 *
 * El mock intercepta `global.fetch` SOLO para URLs de api.cal.com y deja
 * pasar todo lo demás a la implementación real: supabase-js usa `fetch`
 * internamente para sus llamadas REST (incluida la que hace
 * secret-service.ts al leer `organization_secrets`), así que interceptar
 * fetch sin distinguir por URL rompe la resolución del secreto mismo.
 */
const realFetch = global.fetch;

function mockCalFetchOnce(response: Response) {
    return vi.spyOn(global, 'fetch').mockImplementation(async (input, init) => {
        const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
        if (url.startsWith('https://api.cal.com/')) {
            return response;
        }
        return realFetch(input as any, init);
    });
}

describe('src/services/cal-com-tool-client.ts', () => {
    let testOrgId: string;
    const CAL_API_KEY_VALUE = 'cal_test_fake_key_abc123';

    function buildFakeFastify(): FastifyInstance {
        return { supabaseAdmin, log: { warn: vi.fn(), error: vi.fn(), info: vi.fn() } } as unknown as FastifyInstance;
    }

    beforeAll(async () => {
        const { data, error } = await supabaseAdmin
            .from('organizations')
            .insert({ name: 'Org Pruebas cal-com-tool-client', email: `test-cal-client-${Date.now()}@example.invalid` })
            .select('id')
            .single();
        if (error || !data) throw new Error(`No se pudo crear la organización dedicada: ${error?.message}`);
        testOrgId = data.id;

        const saved = await setSecret(testOrgId, SECRET_KEYS.CAL_API_KEY, CAL_API_KEY_VALUE);
        if (!saved) throw new Error('No se pudo guardar cal_api_key de prueba en Vault');
        clearSecretCache(testOrgId);
    });

    afterAll(async () => {
        clearSecretCache();
        if (testOrgId) {
            await supabaseAdmin.from('organization_secrets').delete().eq('organization_id', testOrgId);
            await supabaseAdmin.from('organizations').delete().eq('id', testOrgId);
        }
    });

    beforeEach(() => {
        invalidateAvailabilityCache();
        vi.restoreAllMocks();
    });

    it('getAvailableSlots lanza CalCredentialsMissingError si la organización no tiene cal_api_key, sin llamar a Cal.com', async () => {
        const { data: orgSinCredencial } = await supabaseAdmin
            .from('organizations')
            .insert({ name: 'Org sin cal_api_key', email: `sin-cal-${Date.now()}@example.invalid` })
            .select('id')
            .single();

        try {
            const fetchSpy = mockCalFetchOnce(new Response('no debería llamarse', { status: 200 }));
            await expect(
                getAvailableSlots(
                    buildFakeFastify(),
                    orgSinCredencial!.id,
                    { eventTypeId: 1, startTime: '2026-09-01T00:00:00Z', endTime: '2026-09-02T00:00:00Z' },
                    new AbortController().signal
                )
            ).rejects.toThrow(CalCredentialsMissingError);

            const calCalls = fetchSpy.mock.calls.filter(([input]) => {
                const url = typeof input === 'string' ? input : input?.toString();
                return url?.startsWith('https://api.cal.com/');
            });
            expect(calCalls).toHaveLength(0);
        } finally {
            await supabaseAdmin.from('organizations').delete().eq('id', orgSinCredencial!.id);
        }
    });

    it('contraparte de éxito: getAvailableSlots devuelve los slots parseados y usa la cal-api-version correcta', async () => {
        const fetchSpy = mockCalFetchOnce(
            new Response(JSON.stringify({ data: { slots: { '2026-09-01': [{ time: '2026-09-01T10:00:00Z' }, { time: '2026-09-01T11:00:00Z' }] } } }), { status: 200 })
        );

        const slots = await getAvailableSlots(
            buildFakeFastify(),
            testOrgId,
            { eventTypeId: 99, startTime: '2026-09-01T00:00:00Z', endTime: '2026-09-02T00:00:00Z' },
            new AbortController().signal
        );

        expect(slots).toEqual([{ time: '2026-09-01T10:00:00Z' }, { time: '2026-09-01T11:00:00Z' }]);
        const calCall = fetchSpy.mock.calls.find(([input]) => (typeof input === 'string' ? input : input?.toString())?.startsWith('https://api.cal.com/'));
        const init = calCall?.[1];
        expect((init?.headers as Record<string, string>)['Authorization']).toBe(`Bearer ${CAL_API_KEY_VALUE}`);
        expect((init?.headers as Record<string, string>)['cal-api-version']).toBe('2024-08-13');
    });

    it('getAvailableSlots cachea el resultado por tenant+ventana: una segunda llamada idéntica no vuelve a golpear la red', async () => {
        const fetchSpy = mockCalFetchOnce(new Response(JSON.stringify({ data: { slots: {} } }), { status: 200 }));

        const params = { eventTypeId: 5, startTime: '2026-10-01T00:00:00Z', endTime: '2026-10-02T00:00:00Z' };
        await getAvailableSlots(buildFakeFastify(), testOrgId, params, new AbortController().signal);
        await getAvailableSlots(buildFakeFastify(), testOrgId, params, new AbortController().signal);

        const calCalls = fetchSpy.mock.calls.filter(([input]) => (typeof input === 'string' ? input : input?.toString())?.startsWith('https://api.cal.com/'));
        expect(calCalls).toHaveLength(1);
    });

    it('getAvailableSlots lanza CalProviderError cuando Cal.com responde no-2xx (contraparte de rechazo)', async () => {
        mockCalFetchOnce(new Response('Bad request', { status: 400 }));

        await expect(
            getAvailableSlots(
                buildFakeFastify(),
                testOrgId,
                { eventTypeId: 7, startTime: '2026-11-01T00:00:00Z', endTime: '2026-11-02T00:00:00Z' },
                new AbortController().signal
            )
        ).rejects.toThrow(CalProviderError);
    });

    it('createBooking envía el payload esperado a Cal.com y devuelve el resultado normalizado', async () => {
        const fetchSpy = mockCalFetchOnce(
            new Response(JSON.stringify({ data: { uid: 'cal_booking_123', start: '2026-09-01T10:00:00Z', end: '2026-09-01T10:30:00Z' } }), { status: 200 })
        );

        const result = await createBooking(
            buildFakeFastify(),
            testOrgId,
            { eventTypeId: 42, customerName: 'Prospecto de Prueba', customerEmail: 'prospecto@example.invalid', customerPhone: '+525599999999', startTime: '2026-09-01T10:00:00Z' },
            new AbortController().signal
        );

        expect(result).toEqual({ calBookingId: 'cal_booking_123', startTime: '2026-09-01T10:00:00Z', endTime: '2026-09-01T10:30:00Z' });

        const calCall = fetchSpy.mock.calls.find(([input]) => (typeof input === 'string' ? input : input?.toString())?.startsWith('https://api.cal.com/'));
        expect(calCall?.[0]).toBe('https://api.cal.com/v2/bookings');
        const sentBody = JSON.parse(calCall?.[1]?.body as string);
        expect(sentBody.eventTypeId).toBe(42);
        expect(sentBody.attendee.name).toBe('Prospecto de Prueba');
        expect(sentBody.bookingFieldsResponses.phone).toBe('+525599999999');
    });

    it('rescheduleBooking llama al endpoint de reschedule con el calBookingId correcto', async () => {
        const fetchSpy = mockCalFetchOnce(new Response(JSON.stringify({ data: { uid: 'cal_booking_123', start: '2026-09-05T10:00:00Z' } }), { status: 200 }));

        const result = await rescheduleBooking(
            buildFakeFastify(),
            testOrgId,
            { calBookingId: 'cal_booking_123', newStartTime: '2026-09-05T10:00:00Z' },
            new AbortController().signal
        );

        expect(result.calBookingId).toBe('cal_booking_123');
        expect(result.startTime).toBe('2026-09-05T10:00:00Z');
        const calCall = fetchSpy.mock.calls.find(([input]) => (typeof input === 'string' ? input : input?.toString())?.startsWith('https://api.cal.com/'));
        expect(calCall?.[0]).toBe('https://api.cal.com/v2/bookings/cal_booking_123/reschedule');
    });
});
