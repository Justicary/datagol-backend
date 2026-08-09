import { supabaseAdmin } from '../src/lib/supabase.js';
import { ElevenLabsAdapter } from '../src/services/providers/ElevenLabsAdapter.js';
import { getSecret } from '../src/services/secret-service.js';
import { SECRET_KEYS } from '../src/types/secret-keys.js';

/**
 * Configura `platform_settings.privacy` en el agente de ElevenLabs de una
 * organización: retención de audio/transcripción (el único plazo que expone
 * la API de ElevenLabs — rige audio Y transcript juntos en su lado) y si
 * realmente se borran al vencer. `retention_days` por sí solo NO borra nada
 * — `delete_transcript_and_pii`/`delete_audio` son los switches reales,
 * descubiertos leyendo de vuelta el agente tras el primer PATCH (no están en
 * la documentación pública). El transcript en NUESTRA base tiene su propio
 * plazo independiente (`organizations.retention_days`, purgado por
 * `public.purge_expired_call_content()`, migración 18) — no se toca aquí.
 *
 * ⚠️ Con --apply-to-existing=true (default), la política aplica también a
 * conversaciones YA EXISTENTES en ElevenLabs — las más viejas que
 * retention_days quedan agendadas para borrado real en su lado. Es la única
 * forma de que esto cubra la exposición actual (conversaciones de personas
 * reales ya guardadas), pero es una acción con efecto real e irreversible
 * sobre datos de producción — confirmar antes de correr contra un org real.
 *
 * Uso:
 *   pnpm tsx scripts/configure-agent-retention.ts --org <organization_id> \
 *     [--retention-days 30] [--record-voice true] \
 *     [--delete-transcript-and-pii true] [--delete-audio true] \
 *     [--apply-to-existing true]
 */

interface ParsedArgs {
    org?: string;
    retentionDays: number;
    recordVoice: boolean;
    deleteTranscriptAndPii: boolean;
    deleteAudio: boolean;
    applyToExisting: boolean;
}

function parseArgs(argv: string[]): ParsedArgs {
    const parsed: ParsedArgs = {
        retentionDays: 30,
        recordVoice: true,
        deleteTranscriptAndPii: true,
        deleteAudio: true,
        applyToExisting: true,
    };
    for (let i = 0; i < argv.length; i++) {
        if (argv[i] === '--org') parsed.org = argv[++i];
        else if (argv[i] === '--retention-days') parsed.retentionDays = Number(argv[++i]);
        else if (argv[i] === '--record-voice') parsed.recordVoice = argv[++i] !== 'false';
        else if (argv[i] === '--delete-transcript-and-pii') parsed.deleteTranscriptAndPii = argv[++i] !== 'false';
        else if (argv[i] === '--delete-audio') parsed.deleteAudio = argv[++i] !== 'false';
        else if (argv[i] === '--apply-to-existing') parsed.applyToExisting = argv[++i] !== 'false';
    }
    return parsed;
}

async function main(): Promise<void> {
    const args = parseArgs(process.argv.slice(2));

    if (!args.org) {
        console.error('❌ Falta --org <organization_id>.');
        process.exit(1);
    }
    if (!Number.isFinite(args.retentionDays) || args.retentionDays <= 0) {
        console.error('❌ --retention-days debe ser un número positivo.');
        process.exit(1);
    }

    const { data: org, error } = await supabaseAdmin
        .from('organizations')
        .select('id, name, elevenlabs_agent_id')
        .eq('id', args.org)
        .maybeSingle();

    if (error || !org) {
        console.error(`❌ No existe la organización '${args.org}'.`);
        process.exit(1);
    }
    if (!org.elevenlabs_agent_id) {
        console.error(`❌ La organización '${org.name}' no tiene elevenlabs_agent_id configurado.`);
        process.exit(1);
    }

    const apiKey = (await getSecret(org.id, SECRET_KEYS.ELEVENLABS_API_KEY)) || process.env.ELEVENLABS_API_KEY || '';
    if (!apiKey) {
        console.error(`❌ No se encontró elevenlabs_api_key en Vault para '${org.name}' ni ELEVENLABS_API_KEY en el entorno.`);
        process.exit(1);
    }

    if (args.applyToExisting) {
        console.log('⚠️  apply-to-existing=true: esto agenda borrado real de conversaciones existentes más viejas que el plazo, en ElevenLabs. Irreversible.');
    }

    const adapter = new ElevenLabsAdapter();
    const ok = await adapter.syncAgentPrivacySettings(apiKey, org.elevenlabs_agent_id, {
        retentionDays: args.retentionDays,
        recordVoice: args.recordVoice,
        deleteTranscriptAndPii: args.deleteTranscriptAndPii,
        deleteAudio: args.deleteAudio,
        applyToExistingConversations: args.applyToExisting,
    });

    if (!ok) {
        console.error(`❌ ElevenLabs rechazó la actualización de privacidad para el agente ${org.elevenlabs_agent_id}. Revisa el log de error de arriba.`);
        process.exit(1);
    }

    console.log(`✅ Retención configurada en ElevenLabs para '${org.name}' (agente ${org.elevenlabs_agent_id}):`);
    console.log(
        `   retention_days=${args.retentionDays}, record_voice=${args.recordVoice}, ` +
            `delete_transcript_and_pii=${args.deleteTranscriptAndPii}, delete_audio=${args.deleteAudio}, ` +
            `apply_to_existing_conversations=${args.applyToExisting}`
    );
    console.log('   Verifica en el próximo webhook real que metadata.deletion_settings.deletion_time_unix_secs ya no venga null.');
}

main().catch((err) => {
    console.error('❌ Error inesperado:', err);
    process.exit(1);
});
