import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import Fastify from 'fastify';
import supabasePlugin from '../src/plugins/supabase.js';
import { locationsToolRoute } from '../src/routes/tools/locations.js';
import { supabaseAdmin } from '../src/lib/supabase.js';
import { setSecret, getSecret, clearSecretCache } from '../src/services/secret-service.js';
import { SECRET_KEYS } from '../src/types/secret-keys.js';

const TEST_TOOL_SECRET = 'locations-route-test-secret';

async function buildTestApp() {
    const app = Fastify({ logger: false });
    await app.register(supabasePlugin);
    await app.register(locationsToolRoute);
    await app.ready();
    return app;
}

describe('POST /tools/:webhookToken/locations y /branches', () => {
    const TEST_WEBHOOK_TOKEN = `locations-test-token-${Date.now()}`;
    const createdAddressIds: string[] = [];
    let orgId: string;

    beforeAll(async () => {
        const { data: org, error: orgErr } = await supabaseAdmin
            .from('organizations')
            .insert({
                name: 'Org (tools-locations.test.ts)',
                email: `org-tools-locations-test-${Date.now()}@example.invalid`,
                webhook_token: TEST_WEBHOOK_TOKEN,
                status: 'active',
            })
            .select('id')
            .single();
        if (orgErr || !org) throw new Error(`No se pudo crear la organización de prueba: ${orgErr?.message}`);
        orgId = org.id;

        const saved = await setSecret(orgId, SECRET_KEYS.TOOL_WEBHOOK_SECRET, TEST_TOOL_SECRET);
        if (!saved) throw new Error('No se pudo guardar tool_webhook_secret de prueba');
        clearSecretCache(orgId);
    });

    afterAll(async () => {
        // Limpiar direcciones de prueba
        if (createdAddressIds.length > 0) {
            await supabaseAdmin.from('contact_addresses').delete().in('id', createdAddressIds);
        }

        await supabaseAdmin.from('organization_secrets').delete().eq('organization_id', orgId);
        clearSecretCache(orgId);
        await supabaseAdmin.from('organizations').delete().eq('id', orgId);
    });

    beforeEach(async () => {
        clearSecretCache(orgId);
    });

    it('rechaza con 401 si falta la cabecera x-tool-secret', async () => {
        const app = await buildTestApp();
        const response = await app.inject({
            method: 'POST',
            url: `/tools/${TEST_WEBHOOK_TOKEN}/locations`,
            payload: {},
        });

        expect(response.statusCode).toBe(401);
        const body = response.json();
        expect(body.error).toBe('Unauthorized');
        await app.close();
    });

    it('rechaza con 401 si el secreto en x-tool-secret es incorrecto', async () => {
        const app = await buildTestApp();
        const response = await app.inject({
            method: 'POST',
            url: `/tools/${TEST_WEBHOOK_TOKEN}/locations`,
            headers: { 'x-tool-secret': 'secreto-invalido' },
            payload: {},
        });

        expect(response.statusCode).toBe(401);
        const body = response.json();
        expect(body.error).toBe('Unauthorized');
        await app.close();
    });

    it('rechaza con 403 si la organización está suspendida', async () => {
        await supabaseAdmin.from('organizations').update({ status: 'suspended', suspended_reason: 'Prueba de suspensión' }).eq('id', orgId);
        clearSecretCache(orgId);

        const app = await buildTestApp();
        try {
            const response = await app.inject({
                method: 'POST',
                url: `/tools/${TEST_WEBHOOK_TOKEN}/locations`,
                headers: { 'x-tool-secret': TEST_TOOL_SECRET },
                payload: {},
            });

            expect(response.statusCode).toBe(403);
            const body = response.json();
            expect(body.error).toBe('Forbidden');
        } finally {
            await supabaseAdmin.from('organizations').update({ status: 'active', suspended_reason: null, suspended_at: null }).eq('id', orgId);
            clearSecretCache(orgId);
            await app.close();
        }
    });

    it('devuelve mensaje cuando no hay direcciones registradas', async () => {
        // Asegurar que no hay direcciones activas con un filtro que no coincida
        const app = await buildTestApp();
        const response = await app.inject({
            method: 'POST',
            url: `/tools/${TEST_WEBHOOK_TOKEN}/locations`,
            headers: { 'x-tool-secret': TEST_TOOL_SECRET },
            payload: { label: 'Sucursal Inexistente XYZ 123' },
        });

        expect(response.statusCode).toBe(200);
        const body = response.json();
        expect(body.locations).toEqual([]);
        expect(body.primaryLocation).toBeNull();
        expect(body.message).toContain('No encontré ninguna ubicación');
        await app.close();
    });

    it('devuelve la dirección principal de la organización y mensaje verbalizable', async () => {
        // Insertar dirección de matriz
        const { data: addr, error } = await supabaseAdmin
            .from('contact_addresses')
            .insert({
                organization_id: orgId,
                contact_id: null,
                label: 'Matriz Angelópolis',
                address_type: 'matriz',
                is_primary: true,
                street: 'Av. Atlixcáyotl 1499',
                interior: 'Piso 5',
                neighborhood: 'Reserva Territorial Atlixcáyotl',
                city: 'Puebla',
                state: 'Puebla',
                postal_code: '72810',
                country: 'MX',
            })
            .select('id')
            .single();

        expect(error).toBeNull();
        if (addr) createdAddressIds.push(addr.id);

        const app = await buildTestApp();
        const response = await app.inject({
            method: 'POST',
            url: `/tools/${TEST_WEBHOOK_TOKEN}/locations`,
            headers: { 'x-tool-secret': TEST_TOOL_SECRET },
            payload: {},
        });

        expect(response.statusCode).toBe(200);
        const body = response.json();
        expect(body.locations.length).toBeGreaterThanOrEqual(1);
        expect(body.primaryLocation).not.toBeNull();
        expect(body.primaryLocation.street).toBe('Av. Atlixcáyotl 1499');
        expect(body.primaryLocation.interior).toBe('Piso 5');
        expect(body.primaryLocation.fullAddress).toContain('Av. Atlixcáyotl 1499 Int. Piso 5');
        expect(body.message).toContain('Av. Atlixcáyotl 1499');
        await app.close();
    });

    it('soporta filtrado por addressType (ej. facturacion vs matriz)', async () => {
        // Insertar dirección de facturación
        const { data: factAddr, error } = await supabaseAdmin
            .from('contact_addresses')
            .insert({
                organization_id: orgId,
                contact_id: null,
                label: 'Domicilio Fiscal',
                address_type: 'facturacion',
                is_primary: false,
                street: 'Calle 16 de Septiembre 101',
                neighborhood: 'Centro',
                city: 'Puebla',
                state: 'Puebla',
                postal_code: '72000',
                country: 'MX',
            })
            .select('id')
            .single();

        expect(error).toBeNull();
        if (factAddr) createdAddressIds.push(factAddr.id);

        const app = await buildTestApp();
        const response = await app.inject({
            method: 'POST',
            url: `/tools/${TEST_WEBHOOK_TOKEN}/locations`,
            headers: { 'x-tool-secret': TEST_TOOL_SECRET },
            payload: { addressType: 'facturacion' },
        });

        expect(response.statusCode).toBe(200);
        const body = response.json();
        expect(body.locations.length).toBe(1);
        expect(body.locations[0].addressType).toBe('facturacion');
        expect(body.locations[0].street).toBe('Calle 16 de Septiembre 101');
        expect(body.message).toContain('facturación');
        await app.close();
    });

    it('funciona a través del alias /tools/:webhookToken/branches', async () => {
        const app = await buildTestApp();
        const response = await app.inject({
            method: 'POST',
            url: `/tools/${TEST_WEBHOOK_TOKEN}/branches`,
            headers: { 'x-tool-secret': TEST_TOOL_SECRET },
            payload: {},
        });

        expect(response.statusCode).toBe(200);
        const body = response.json();
        expect(Array.isArray(body.locations)).toBe(true);
        expect(typeof body.message).toBe('string');
        await app.close();
    });

    it('aísla y NUNCA retorna direcciones que pertenezcan a un contacto (contact_id IS NOT NULL)', async () => {
        // Crear un contacto temporal y su dirección
        const { data: contact, error: contactErr } = await supabaseAdmin
            .from('contacts')
            .insert({
                organization_id: orgId,
                full_name: 'Contacto Test Ubicaciones',
                phone_e164: `+52222${Date.now().toString().slice(-7)}`,
            })
            .select('id')
            .single();

        expect(contactErr).toBeNull();
        const contactId = contact!.id;

        const { data: contactAddr, error: addrErr } = await supabaseAdmin
            .from('contact_addresses')
            .insert({
                organization_id: orgId,
                contact_id: contactId,
                label: 'Casa del Contacto Privado',
                address_type: 'domicilio',
                is_primary: true,
                street: 'Calle Secreta de Contacto 999',
            })
            .select('id')
            .single();

        expect(addrErr).toBeNull();
        if (contactAddr) createdAddressIds.push(contactAddr.id);

        const app = await buildTestApp();
        const response = await app.inject({
            method: 'POST',
            url: `/tools/${TEST_WEBHOOK_TOKEN}/locations`,
            headers: { 'x-tool-secret': TEST_TOOL_SECRET },
            payload: {},
        });

        expect(response.statusCode).toBe(200);
        const body = response.json();
        const hasContactAddress = body.locations.some((l: any) => l.street === 'Calle Secreta de Contacto 999');
        expect(hasContactAddress).toBe(false);

        // Limpiar contacto
        await supabaseAdmin.from('contacts').delete().eq('id', contactId);
        await app.close();
    });
});
