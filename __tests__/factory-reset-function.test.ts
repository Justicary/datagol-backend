import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import crypto from 'crypto';
import pg from 'pg';
import { parseDatabaseUrl } from '../src/lib/database-url.js';
import { validateEnv } from '../src/config/env.js';

/**
 * Prueba la función SQL `factory_reset_transactional_data()` (migración 74)
 * contra la base real, SIEMPRE dentro de `BEGIN … ROLLBACK`: la función
 * vacía tablas completas (no filtra por organización), así que nada de lo
 * que hace aquí se confirma jamás. Si el proceso muere a mitad, Postgres
 * revierte la transacción al cerrarse la conexión.
 *
 * Requiere la migración 74 aplicada.
 */

const RESET_TABLES = [
    'thank_you_sends',
    'whatsapp_messages',
    'email_outbox',
    'contact_pipeline_transitions',
    'appointment_waitlist',
    'appointments',
    'leads',
    'call_logs',
    'contact_notes',
    'contacts',
    'feature_audit_log',
    'permission_audit_log',
    'unanswered_questions',
    'weekly_reports',
    'competitor_site_snapshots',
    'outbound_call_attempts',
    'organization_usage_alerts',
    'concurrency_quota_alerts',
    'catalog_imports',
] as const;

// Configuración, infraestructura y facturación: el conteo no debe cambiar.
const PRESERVED_TABLES = [
    'organizations',
    'credential_groups',
    'organization_secrets',
    'plans',
    'features',
    'plan_features',
    'organization_features',
    'usage_events',
    'webhook_events',
    'organization_members',
    'organization_role_permissions',
    'email_accounts',
    'organization_attachments',
    'competitor_sites',
    'knowledge_base',
    'catalogs',
    'products',
    'provider_rates',
] as const;

describe('db — factory_reset_transactional_data() (migración 74, dentro de ROLLBACK)', () => {
    let client: pg.Client;
    let result: Record<string, number>;
    const before: Record<string, number> = {};
    const after: Record<string, number> = {};
    let orgId: string;
    let orgAddressesAfter: number;
    let contactAddressesAfter: number;
    let invitationsAfter: { pending: number; other: number };
    let usageCallLogRefsAfter: number;

    async function count(table: string, where = 'true', params: unknown[] = []): Promise<number> {
        const { rows } = await client.query<{ n: string }>(`SELECT count(*)::text AS n FROM public.${table} WHERE ${where}`, params);
        return Number(rows[0].n);
    }

    beforeAll(async () => {
        const env = validateEnv();
        client = new pg.Client(parseDatabaseUrl(env.DATABASE_URL));
        await client.connect();
        await client.query('BEGIN');

        // Siembra mínima para que cada aserción sea no vacía.
        const suffix = crypto.randomUUID();
        const org = await client.query<{ id: string }>(
            `INSERT INTO public.organizations (name, email) VALUES ($1, $2) RETURNING id`,
            ['Org factory reset (ROLLBACK)', `factory-reset-${suffix}@example.invalid`]
        );
        orgId = org.rows[0].id;
        const contact = await client.query<{ id: string }>(
            `INSERT INTO public.contacts (organization_id, full_name, phone_e164) VALUES ($1, 'Contacto de prueba', $2) RETURNING id`,
            [orgId, `+52155${Math.floor(10000000 + Math.random() * 89999999)}`]
        );
        const contactId = contact.rows[0].id;
        await client.query(
            `INSERT INTO public.contact_addresses (organization_id, contact_id, street) VALUES ($1, $2, 'Calle del contacto 1')`,
            [orgId, contactId]
        );
        await client.query(
            `INSERT INTO public.contact_addresses (organization_id, contact_id, street, address_type) VALUES ($1, NULL, 'Sucursal de la organización 1', 'sucursal')`,
            [orgId]
        );
        await client.query(`INSERT INTO public.contact_notes (organization_id, contact_id, body) VALUES ($1, $2, 'nota')`, [orgId, contactId]);
        await client.query(
            `INSERT INTO public.organization_invitations (organization_id, email, role, token_hash, expires_at, accepted_at, revoked_at) VALUES
                ($1, $2, 'member', $3, now() + interval '7 days', NULL, NULL),
                ($1, $4, 'member', $5, now() - interval '1 day', NULL, NULL),
                ($1, $6, 'member', $7, now() + interval '7 days', now(), NULL),
                ($1, $8, 'member', $9, now() + interval '7 days', NULL, now())`,
            [
                orgId,
                `pendiente-${suffix}@example.invalid`, `hash-pendiente-${suffix}`,
                `vencida-${suffix}@example.invalid`, `hash-vencida-${suffix}`,
                `aceptada-${suffix}@example.invalid`, `hash-aceptada-${suffix}`,
                `revocada-${suffix}@example.invalid`, `hash-revocada-${suffix}`,
            ]
        );

        for (const table of PRESERVED_TABLES) before[table] = await count(table);
        expect(await count('contacts')).toBeGreaterThan(0);
        expect(await count('contact_addresses', 'contact_id IS NOT NULL')).toBeGreaterThan(0);

        const { rows } = await client.query<{ result: Record<string, number> }>(
            'SELECT public.factory_reset_transactional_data() AS result'
        );
        result = rows[0].result;

        for (const table of PRESERVED_TABLES) after[table] = await count(table);
        for (const table of RESET_TABLES) after[table] = await count(table);
        orgAddressesAfter = await count('contact_addresses', 'organization_id = $1 AND contact_id IS NULL', [orgId]);
        contactAddressesAfter = await count('contact_addresses', 'contact_id IS NOT NULL');
        invitationsAfter = {
            pending: await count('organization_invitations', 'organization_id = $1 AND accepted_at IS NULL AND revoked_at IS NULL AND expires_at > now()', [orgId]),
            other: await count('organization_invitations', 'accepted_at IS NOT NULL OR revoked_at IS NOT NULL OR expires_at <= now()'),
        };
        usageCallLogRefsAfter = await count('usage_events', 'call_log_id IS NOT NULL');
    });

    afterAll(async () => {
        if (client) {
            await client.query('ROLLBACK');
            await client.end();
        }
    });

    it.each(RESET_TABLES)('vacía por completo %s', (table) => {
        expect(after[table]).toBe(0);
    });

    it('borra solo las direcciones de contactos', () => {
        expect(contactAddressesAfter).toBe(0);
    });

    it('contraparte: conserva las direcciones de la propia organización (contact_id NULL)', () => {
        expect(orgAddressesAfter).toBe(1);
    });

    it('borra invitaciones vencidas, aceptadas y revocadas; conserva las pendientes', () => {
        expect(invitationsAfter.other).toBe(0);
        expect(invitationsAfter.pending).toBe(1);
    });

    it.each(PRESERVED_TABLES)('conserva intacta %s', (table) => {
        expect(after[table]).toBe(before[table]);
    });

    it('usage_events conserva sus filas y solo pierde la referencia a call_logs', () => {
        expect(usageCallLogRefsAfter).toBe(0);
    });

    it('devuelve el conteo de cada tabla, conservando las claves de la versión anterior', () => {
        const expectedKeys = [
            ...RESET_TABLES.map((t) => `${t}_deleted`),
            'contact_addresses_deleted',
            'organization_invitations_deleted',
        ].sort();
        expect(Object.keys(result).sort()).toEqual(expectedKeys);
        for (const key of ['appointments_deleted', 'leads_deleted', 'call_logs_deleted', 'contacts_deleted', 'feature_audit_log_deleted']) {
            expect(typeof result[key]).toBe('number');
        }
        expect(result.contacts_deleted).toBeGreaterThanOrEqual(1);
        expect(result.contact_notes_deleted).toBeGreaterThanOrEqual(1);
        expect(result.organization_invitations_deleted).toBeGreaterThanOrEqual(3);
    });
});
