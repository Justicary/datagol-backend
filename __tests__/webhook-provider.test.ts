import { describe, it, expect } from 'vitest';
import { ALL_WEBHOOK_EVENT_PROVIDERS } from '../src/types/webhook-provider.js';
import { supabaseAdmin } from '../src/lib/supabase.js';

/**
 * src/types/webhook-provider.ts es la única fuente de verdad para
 * webhook_events.provider. organization_id es nullable en esta tabla, así
 * que la prueba no necesita una organización real. A diferencia de
 * usage_events y feature_audit_log, webhook_events sí permite DELETE (no es
 * append-only) — verificado: __tests__/webhooks-elevenlabs.test.ts ya limpia
 * filas de esta tabla en afterEach sin error.
 */
describe('src/types/webhook-provider.ts — sincronizado con el CHECK constraint real de webhook_events.provider', () => {
    it.each(ALL_WEBHOOK_EVENT_PROVIDERS)('el proveedor "%s" es aceptado por el CHECK constraint de webhook_events.provider', async (provider) => {
        const eventId = `diag-provider-${provider}-${Math.random().toString(36).slice(2)}`;
        const { error } = await supabaseAdmin
            .from('webhook_events')
            .insert({ provider, event_id: eventId, event_type: 'diag', raw_payload: {} })
            .select('id')
            .single();

        expect(error?.code).not.toBe('23514');

        await supabaseAdmin.from('webhook_events').delete().eq('event_id', eventId);
    });
});
