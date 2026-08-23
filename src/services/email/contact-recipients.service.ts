import { supabaseAdmin } from '../../lib/supabase.js';

/**
 * Carga en lote los contactos destinatarios de `send-template-email`
 * (docs/tasks/send-template-email-backend.md). Filtro explícito de
 * `organization_id` (AGENTS.md §5) — nunca se confía en que los
 * `contactIds` recibidos pertenezcan a la organización del caller.
 */

export interface ContactRecipient {
    id: string;
    email: string | null;
    fullName: string | null;
    businessName: string | null;
    optedOut: boolean;
}

interface ContactRow {
    id: string;
    email: string | null;
    full_name: string | null;
    business_name: string | null;
    opted_out: boolean;
}

export async function loadContactsForSend(organizationId: string, contactIds: string[]): Promise<ContactRecipient[]> {
    if (contactIds.length === 0) {
        return [];
    }

    const { data, error } = await supabaseAdmin
        .from('contacts')
        .select('id, email, full_name, business_name, opted_out')
        .eq('organization_id', organizationId)
        .in('id', contactIds);

    if (error) {
        throw new Error(`Error cargando contactos: ${error.message}`);
    }

    return ((data as ContactRow[] | null) ?? []).map((row) => ({
        id: row.id,
        email: row.email,
        fullName: row.full_name,
        businessName: row.business_name,
        optedOut: row.opted_out,
    }));
}
