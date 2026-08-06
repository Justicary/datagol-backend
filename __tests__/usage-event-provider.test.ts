import { describe, it, expect } from 'vitest';
import { ALL_USAGE_EVENT_PROVIDERS } from '../src/types/usage-event-provider.js';
import { supabaseAdmin } from '../src/lib/supabase.js';

// Organización real existente (ver __tests__/entitlements.test.ts). No se usa
// una organización desechable aquí a propósito: organizations tiene FK a
// usage_events con cascada, y el trigger append-only de usage_events también
// bloquea esa cascada — una vez insertada una fila, la organización que la
// referencia ya no se puede borrar. Usar la organización real y neutralizar
// con asientos compensatorios evita crear organizaciones huérfanas.
const REAL_ORG_ID = '56422ca1-ec44-45b4-9eac-7e068d9169be';

describe('src/types/usage-event-provider.ts — sincronizado con el CHECK constraint real de usage_events.provider', () => {
    it.each(ALL_USAGE_EVENT_PROVIDERS)('el proveedor "%s" es aceptado por el CHECK constraint de usage_events.provider', async (provider) => {
        // usage_events es append-only (trigger bloquea UPDATE/DELETE — ver
        // AGENTS.md §3.2). No se limpia con delete(): se neutraliza con un
        // asiento compensatorio de cantidad negativa, el mismo mecanismo que
        // usará el código real de corrección de la Fase 3.
        const baseRow = {
            organization_id: REAL_ORG_ID,
            provider,
            unit_type: 'diag_unit',
            unit_rate_usd: 0.01,
            metadata: { diagnostic: 'usage-event-provider.test.ts' },
        };

        const { error } = await supabaseAdmin
            .from('usage_events')
            .insert({ ...baseRow, quantity: 1 })
            .select('id')
            .single();

        expect(error?.code).not.toBe('23514');

        if (!error) {
            await supabaseAdmin.from('usage_events').insert({ ...baseRow, quantity: -1 });
        }
    });
});
