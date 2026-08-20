import pg from 'pg';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { validateEnv } from '../src/config/env.js';
import { parseDatabaseUrl } from '../src/lib/database-url.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

async function main() {
    const env = validateEnv();
    const config = parseDatabaseUrl(env.DATABASE_URL);
    const client = new pg.Client({
        ...config,
        connectionTimeoutMillis: 10000,
    });

    await client.connect();
    console.log('✅ Conexión establecida a Supabase Postgres.');

    try {
        console.log('\n--- APLICANDO MIGRACIÓN 48 ---');
        const sql48 = fs.readFileSync(path.join(__dirname, '../db/migrations/48_contact_addresses_default_domicilio.sql'), 'utf8');
        await client.query(sql48);
        console.log('✅ Migración 48 aplicada exitosamente.');

        console.log('\n--- APLICANDO MIGRACIÓN 49 ---');
        const sql49 = fs.readFileSync(path.join(__dirname, '../db/migrations/49_process_call_completed_sentiment.sql'), 'utf8');
        await client.query(sql49);
        console.log('✅ Migración 49 aplicada exitosamente.');

        console.log('\n--- REGULARIZANDO DIRECCIÓN DE GLORIA MONTIEL FLORES ---');
        await client.query(`
            UPDATE public.contact_addresses
            SET latitude = 19.0387788,
                longitude = -98.2088269,
                postal_code = '72420',
                city = 'Heroica Puebla de Zaragoza',
                updated_at = now()
            WHERE contact_id = 'b7a1a76f-2e87-4343-b527-60bc108a8f33';

            UPDATE public.call_logs
            SET customer_lat = 19.0387788,
                customer_lng = -98.2088269,
                customer_zip = '72420',
                customer_city = 'Heroica Puebla de Zaragoza'
            WHERE provider_call_id = 'conv_2201m0e3zp09eyytdn59btvbr8cv';

            UPDATE public.call_logs
            SET customer_lat = 19.0379478,
                customer_lng = -98.2113613,
                customer_zip = '72420',
                customer_city = 'Heroica Puebla de Zaragoza'
            WHERE provider_call_id = 'conv_4301m0eh8tr0ey7vjv9p3yhsf100';
        `);
        console.log('✅ Registros históricos de Gloria y Arturo regularizados con sus coordenadas.');
    } catch (err) {
        console.error('❌ Error aplicando migraciones:', err);
    } finally {
        await client.end();
    }
}

main().catch(console.error);
