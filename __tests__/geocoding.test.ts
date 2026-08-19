import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { supabaseAdmin } from '../src/lib/supabase.js';
import { setSecret } from '../src/services/secret-service.js';
import { SECRET_KEYS } from '../src/types/secret-keys.js';
import { geocodeAddress } from '../src/services/geocoding.js';

/**
 * Mismo criterio que __tests__/cal-com-tool-client.test.ts: Vault real para
 * el secreto (google_maps_key), pero la red saliente a
 * maps.googleapis.com se mockea — es un proveedor de pago de terceros. El
 * mock solo intercepta esa URL y deja pasar todo lo demás al fetch real
 * (supabase-js y secret-service.ts dependen de fetch para leer el secreto).
 */
const realFetch = global.fetch;

function mockGeocodingFetchOnce(response: Response) {
    return vi.spyOn(global, 'fetch').mockImplementation(async (input, init) => {
        const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
        if (url.startsWith('https://maps.googleapis.com/')) {
            return response;
        }
        return realFetch(input as any, init);
    });
}

function buildFakeFastify(): FastifyInstance {
    return { supabaseAdmin, log: { warn: vi.fn(), error: vi.fn(), info: vi.fn() } } as unknown as FastifyInstance;
}

describe('src/services/geocoding.ts', () => {
    let testOrgId: string;
    const GOOGLE_MAPS_KEY_VALUE = 'maps_test_fake_key_xyz789';

    beforeAll(async () => {
        const { data, error } = await supabaseAdmin
            .from('organizations')
            .insert({ name: 'Org Pruebas geocoding', email: `test-geocoding-${Date.now()}@example.invalid` })
            .select('id')
            .single();
        if (error || !data) throw new Error(`No se pudo crear la organización dedicada: ${error?.message}`);
        testOrgId = data.id;
    });

    afterAll(async () => {
        await supabaseAdmin.from('organization_secrets').delete().eq('organization_id', testOrgId);
        await supabaseAdmin.from('organizations').delete().eq('id', testOrgId);
        vi.restoreAllMocks();
    });

    it('contraparte de rechazo: sin ningún campo de dirección, devuelve null sin tocar Vault ni la red', async () => {
        const fetchSpy = vi.spyOn(global, 'fetch');
        const result = await geocodeAddress(buildFakeFastify(), testOrgId, {
            address: null,
            city: null,
            state: null,
            zip: null,
        });
        expect(result).toBeNull();
        expect(fetchSpy).not.toHaveBeenCalledWith(expect.stringContaining('maps.googleapis.com'), expect.anything());
        fetchSpy.mockRestore();
    });

    it('sin google_maps_key configurada en la organización, devuelve null (no es un error, la dirección en texto igual se persiste)', async () => {
        const result = await geocodeAddress(buildFakeFastify(), testOrgId, {
            address: 'Calle Reforma 123',
            city: 'Puebla',
            state: 'Puebla',
            zip: '72000',
        });
        expect(result).toBeNull();
    });

    it('con google_maps_key configurada y respuesta OK de Google, devuelve lat/lng y componentes estructurados', async () => {
        const saved = await setSecret(testOrgId, SECRET_KEYS.GOOGLE_MAPS_KEY, GOOGLE_MAPS_KEY_VALUE);
        expect(saved).toBe(true);

        const mock = mockGeocodingFetchOnce(
            new Response(
                JSON.stringify({
                    status: 'OK',
                    results: [
                        {
                            formatted_address: 'Calle Benito Juárez 123, Centro, 72000 Puebla, Pue., México',
                            geometry: { location: { lat: 19.0433, lng: -98.1982 } },
                            address_components: [
                                { long_name: '123', short_name: '123', types: ['street_number'] },
                                { long_name: 'Calle Benito Juárez', short_name: 'Calle Benito Juárez', types: ['route'] },
                                { long_name: 'Centro', short_name: 'Centro', types: ['neighborhood', 'political'] },
                                { long_name: 'Puebla', short_name: 'Puebla', types: ['locality', 'political'] },
                                { long_name: 'Puebla', short_name: 'Pue.', types: ['administrative_area_level_1', 'political'] },
                                { long_name: '72000', short_name: '72000', types: ['postal_code'] },
                                { long_name: 'México', short_name: 'MX', types: ['country', 'political'] },
                            ],
                        },
                    ],
                }),
                { status: 200 }
            )
        );

        const result = await geocodeAddress(buildFakeFastify(), testOrgId, {
            address: 'Calle Reforma 123',
            city: 'Puebla',
            state: 'Puebla',
            zip: '72000',
        });

        expect(result).toMatchObject({
            lat: 19.0433,
            lng: -98.1982,
            formattedAddress: 'Calle Benito Juárez 123, Centro, 72000 Puebla, Pue., México',
            street: 'Calle Benito Juárez 123',
            neighborhood: 'Centro',
            city: 'Puebla',
            state: 'Puebla',
            postalCode: '72000',
            country: 'MX',
        });
        mock.mockRestore();
    });

    it('reverseGeocode resuelve coordenadas a dirección estructurada', async () => {
        const { reverseGeocode } = await import('../src/services/geocoding.js');
        const mock = mockGeocodingFetchOnce(
            new Response(
                JSON.stringify({
                    status: 'OK',
                    results: [
                        {
                            formatted_address: 'Av. Juárez 100, Puebla, México',
                            geometry: { location: { lat: 19.0433, lng: -98.1982 } },
                            address_components: [
                                { long_name: '100', short_name: '100', types: ['street_number'] },
                                { long_name: 'Avenida Juárez', short_name: 'Av. Juárez', types: ['route'] },
                                { long_name: 'Puebla', short_name: 'Puebla', types: ['locality'] },
                            ],
                        },
                    ],
                }),
                { status: 200 }
            )
        );

        const result = await reverseGeocode(buildFakeFastify(), testOrgId, 19.0433, -98.1982);
        expect(result).toMatchObject({
            lat: 19.0433,
            lng: -98.1982,
            formattedAddress: 'Av. Juárez 100, Puebla, México',
            street: 'Avenida Juárez 100',
            city: 'Puebla',
        });
        mock.mockRestore();
    });

    it('contraparte de rechazo: Google responde ZERO_RESULTS, devuelve null sin lanzar', async () => {
        const mock = mockGeocodingFetchOnce(new Response(JSON.stringify({ status: 'ZERO_RESULTS', results: [] }), { status: 200 }));

        const result = await geocodeAddress(buildFakeFastify(), testOrgId, {
            address: 'Dirección inexistente 000',
            city: null,
            state: null,
            zip: null,
        });

        expect(result).toBeNull();
        mock.mockRestore();
    });

    it('un error HTTP del proveedor (p. ej. 403 por llave inválida) devuelve null sin lanzar', async () => {
        const mock = mockGeocodingFetchOnce(new Response('Forbidden', { status: 403 }));

        const result = await geocodeAddress(buildFakeFastify(), testOrgId, {
            address: 'Calle Reforma 123',
            city: null,
            state: null,
            zip: null,
        });

        expect(result).toBeNull();
        mock.mockRestore();
    });

    it('una excepción de red (timeout/abort) devuelve null sin propagar el error', async () => {
        const mock = vi.spyOn(global, 'fetch').mockImplementation(async (input, init) => {
            const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
            if (url.startsWith('https://maps.googleapis.com/')) {
                throw new Error('network error simulado');
            }
            return realFetch(input as any, init);
        });

        const result = await geocodeAddress(buildFakeFastify(), testOrgId, {
            address: 'Calle Reforma 123',
            city: null,
            state: null,
            zip: null,
        });

        expect(result).toBeNull();
        mock.mockRestore();
    });
});
