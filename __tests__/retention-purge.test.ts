import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import crypto from 'crypto';
import { supabaseAdmin } from '../src/lib/supabase.js';

/**
 * Pendiente con exposición legal real: transcripciones completas de
 * personas reales sin plazo de purga. Cubre:
 *   - db/migrations/16_organizations_retention_days.sql (columna + CHECK)
 *   - db/migrations/18_call_content_retention_purge.sql (purge_expired_call_content)
 *
 * Organización dedicada y desechable (no REAL_ORG_ID) — este test inserta
 * call_logs/webhook_events con created_at/received_at manipulados al pasado
 * para simular contenido vencido; no se quiere tocar datos reales de
 * producción con eso.
 */
describe('Retención de contenido con datos personales', () => {
    let orgId: string;

    beforeAll(async () => {
        const { data, error } = await supabaseAdmin
            .from('organizations')
            .insert({ name: 'Retention Purge Test Org', email: `retention-purge-${crypto.randomUUID()}@example.invalid` })
            .select('id, retention_days')
            .single();
        if (error || !data) throw new Error(`No se pudo crear la organización dedicada: ${error?.message}`);
        orgId = data.id;
    });

    afterAll(async () => {
        if (orgId) await supabaseAdmin.from('organizations').delete().eq('id', orgId);
    });

    describe('organizations.retention_days', () => {
        it('default es 90 para una organización nueva sin valor explícito', async () => {
            const { data } = await supabaseAdmin.from('organizations').select('retention_days').eq('id', orgId).single();
            expect(data?.retention_days).toBe(90);
        });

        it('contraparte de éxito: un valor positivo explícito se acepta', async () => {
            const { error } = await supabaseAdmin.from('organizations').update({ retention_days: 30 }).eq('id', orgId);
            expect(error).toBeNull();
            const { data } = await supabaseAdmin.from('organizations').select('retention_days').eq('id', orgId).single();
            expect(data?.retention_days).toBe(30);

            await supabaseAdmin.from('organizations').update({ retention_days: 90 }).eq('id', orgId);
        });

        it('contraparte de rechazo: 0 viola el CHECK constraint (purgaría todo de inmediato)', async () => {
            const { error } = await supabaseAdmin.from('organizations').update({ retention_days: 0 }).eq('id', orgId);
            expect(error?.code).toBe('23514');
        });

        it('un valor negativo viola el CHECK constraint', async () => {
            const { error } = await supabaseAdmin.from('organizations').update({ retention_days: -5 }).eq('id', orgId);
            expect(error?.code).toBe('23514');
        });
    });

    describe('purge_expired_call_content()', () => {
        const oldConversationId = `retention-old-${Date.now()}`;
        const freshConversationId = `retention-fresh-${Date.now()}`;
        const oldDate = new Date(Date.now() - 100 * 24 * 60 * 60 * 1000).toISOString(); // 100 días atrás
        const freshDate = new Date(Date.now() - 5 * 24 * 60 * 60 * 1000).toISOString(); // 5 días atrás

        beforeAll(async () => {
            // retention_days=90 (default restaurado arriba) para ambos casos.
            await supabaseAdmin.from('call_logs').insert([
                {
                    organization_id: orgId,
                    provider_call_id: oldConversationId,
                    transcript: 'Transcripción vieja que debe purgarse.',
                    summary: 'Resumen viejo que debe purgarse.',
                    created_at: oldDate,
                },
                {
                    organization_id: orgId,
                    provider_call_id: freshConversationId,
                    transcript: 'Transcripción reciente que NO debe purgarse.',
                    summary: 'Resumen reciente que NO debe purgarse.',
                    created_at: freshDate,
                },
            ]);

            await supabaseAdmin.from('webhook_events').insert([
                {
                    organization_id: orgId,
                    provider: 'elevenlabs',
                    event_id: `post_call_transcription:${oldConversationId}`,
                    event_type: 'post_call_transcription',
                    raw_payload: { data: { conversation_id: oldConversationId, secret: 'dato personal viejo' } },
                    received_at: oldDate,
                },
                {
                    organization_id: orgId,
                    provider: 'elevenlabs',
                    event_id: `post_call_transcription:${freshConversationId}`,
                    event_type: 'post_call_transcription',
                    raw_payload: { data: { conversation_id: freshConversationId, secret: 'dato personal reciente' } },
                    received_at: freshDate,
                },
            ]);
        });

        afterAll(async () => {
            await supabaseAdmin.from('webhook_events').delete().in('event_id', [
                `post_call_transcription:${oldConversationId}`,
                `post_call_transcription:${freshConversationId}`,
            ]);
            await supabaseAdmin.from('call_logs').delete().in('provider_call_id', [oldConversationId, freshConversationId]);
        });

        it('purga transcript/summary de call_logs más viejos que retention_days, y redacta el webhook_events correspondiente', async () => {
            const { error } = await supabaseAdmin.rpc('purge_expired_call_content');
            expect(error).toBeNull();

            const { data: oldLog } = await supabaseAdmin
                .from('call_logs')
                .select('transcript, summary')
                .eq('provider_call_id', oldConversationId)
                .single();
            expect(oldLog?.transcript).toBeNull();
            expect(oldLog?.summary).toBeNull();

            const { data: oldEvent } = await supabaseAdmin
                .from('webhook_events')
                .select('raw_payload')
                .eq('event_id', `post_call_transcription:${oldConversationId}`)
                .single();
            expect((oldEvent?.raw_payload as any)?.purged).toBe(true);
            expect((oldEvent?.raw_payload as any)?.purged_reason).toBe('retention_expired');
            expect(JSON.stringify(oldEvent?.raw_payload)).not.toContain('dato personal viejo');
        });

        it('contraparte de éxito: NO toca call_logs/webhook_events dentro del plazo de retención', async () => {
            const { data: freshLog } = await supabaseAdmin
                .from('call_logs')
                .select('transcript, summary')
                .eq('provider_call_id', freshConversationId)
                .single();
            expect(freshLog?.transcript).toBe('Transcripción reciente que NO debe purgarse.');
            expect(freshLog?.summary).toBe('Resumen reciente que NO debe purgarse.');

            const { data: freshEvent } = await supabaseAdmin
                .from('webhook_events')
                .select('raw_payload')
                .eq('event_id', `post_call_transcription:${freshConversationId}`)
                .single();
            expect((freshEvent?.raw_payload as any)?.purged).toBeUndefined();
            expect(JSON.stringify(freshEvent?.raw_payload)).toContain('dato personal reciente');
        });

        it('es idempotente: correrlo una segunda vez no lanza y no vuelve a tocar lo ya purgado', async () => {
            const { data, error } = await supabaseAdmin.rpc('purge_expired_call_content');
            expect(error).toBeNull();
            expect(data.call_logs_purged).toBe(0);
            expect(data.webhook_events_purged).toBe(0);
        });
    });
});
