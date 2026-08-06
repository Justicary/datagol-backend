import { supabaseAdmin } from '../src/lib/supabase.js';
import { setSecret, getSecret } from '../src/services/secret-service.js';
import { SECRET_KEYS, type SecretKey } from '../src/types/secret-keys.js';

/**
 * Script de migración de credenciales en claro desde la tabla `organizations` hacia `organization_secrets`.
 * Se ejecuta una sola vez vía Node (`pnpm tsx scripts/migrate-secrets.ts`).
 */
async function migrateSecrets() {
    console.log('🔒 Iniciando migración de credenciales de organizacion a organization_secrets...');

    // 1. Obtener todas las organizaciones que tengan credenciales en claro
    const { data: orgs, error } = await supabaseAdmin
        .from('organizations')
        .select('*');

    if (error) {
        console.error('❌ Error al consultar organizaciones:', error.message);
        process.exit(1);
    }

    if (!orgs || orgs.length === 0) {
        console.log('ℹ️ No hay organizaciones para migrar.');
        process.exit(0);
    }

    console.log(`📋 Se encontraron ${orgs.length} organización(es) para evaluar migración.`);

    // Mapea columna en claro de `organizations` -> clave canónica de
    // `organization_secrets.secret_key` (src/types/secret-keys.ts). No incluye
    // `deprecated_vapi_private_key`: Vapi está deprecado y no tiene una clave
    // correspondiente en el CHECK constraint — no hay a dónde migrarlo.
    const SECRET_FIELDS: Record<string, SecretKey> = {
        elevenlabs_api_key: SECRET_KEYS.ELEVENLABS_API_KEY,
        telnyx_api_key: SECRET_KEYS.TELNYX_API_KEY,
        whatsapp_access_token: SECRET_KEYS.WHATSAPP_ACCESS_TOKEN,
        cal_api_key: SECRET_KEYS.CAL_API_KEY,
    };

    let migratedCount = 0;

    for (const org of orgs) {
        const orgId = org.id;
        console.log(`\n🏢 Procesando Organización ID: ${orgId} (${org.name || 'Sin nombre'})...`);

        const updatesToNull: Record<string, null> = {};

        for (const [colName, secretKeyName] of Object.entries(SECRET_FIELDS)) {
            const rawSecret = org[colName];

            if (rawSecret && typeof rawSecret === 'string' && rawSecret.trim() !== '') {
                console.log(`  🔑 Migrando '${colName}' -> secreto '${secretKeyName}'...`);

                // 2. Guardar en organization_secrets
                const saved = await setSecret(orgId, secretKeyName, rawSecret.trim());
                if (!saved) {
                    console.error(`  ❌ Fallo al migrar secreto '${secretKeyName}' para org '${orgId}'. Abortando para esta org.`);
                    continue;
                }

                // 3. Verificar lectura del secreto
                const readBack = await getSecret(orgId, secretKeyName);
                if (readBack !== rawSecret.trim()) {
                    console.error(`  ❌ Verificación de lectura falló para '${secretKeyName}'. El valor leído no coincide. Abortando.`);
                    continue;
                }

                console.log(`  ✅ Secreto '${secretKeyName}' migrado y verificado correctamente.`);
                updatesToNull[colName] = null;
                migratedCount++;
            }
        }

        // 4. Anular las columnas originales en clear text únicamente tras verificación exitosa
        if (Object.keys(updatesToNull).length > 0) {
            console.log(`  🧹 Anulando columnas originales en claro para org '${orgId}'...`);
            const { error: nullifyError } = await supabaseAdmin
                .from('organizations')
                .update(updatesToNull)
                .eq('id', orgId);

            if (nullifyError) {
                console.error(`  ⚠️ Error al anular columnas en claro para org '${orgId}':`, nullifyError.message);
            } else {
                console.log(`  ✨ Columnas en claro anuladas con éxito para org '${orgId}'.`);
            }
        }
    }

    console.log(`\n🎉 Migración de secretos completada. Total de secretos migrados: ${migratedCount}.`);
    process.exit(0);
}

migrateSecrets().catch((err) => {
    console.error('❌ Excepción no controlada durante la migración de secretos:', err);
    process.exit(1);
});
